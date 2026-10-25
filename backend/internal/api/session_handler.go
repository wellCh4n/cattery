package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
	"github.com/wellch4n/cattery/internal/usage"
)

type sessionSandbox interface {
	EnsureReady(context.Context, uuid.UUID) (string, error)
	Await(context.Context, uuid.UUID) (string, error)
	URL(context.Context, uuid.UUID) (string, bool)
}

type usageSyncer interface {
	Sync(context.Context, uuid.UUID)
}

type SessionHandler struct {
	sessionStore  *db.SessionStore
	projectStore  *db.ProjectStore
	harnessClient *harness.Client
	sandbox       sessionSandbox
	models        *config.Models
	usage         usageSyncer
}

func NewSessionHandler(
	sessionStore *db.SessionStore,
	projectStore *db.ProjectStore,
	harnessClient *harness.Client,
	sandboxMgr *sandbox.Manager,
	models *config.Models,
	usage usageSyncer,
) *SessionHandler {
	return &SessionHandler{sessionStore, projectStore, harnessClient, sandboxMgr, models, usage}
}

// syncUsage collects the project's token usage in the background.
func (h *SessionHandler) syncUsage(projectID uuid.UUID) {
	if h.usage != nil {
		go h.usage.Sync(context.Background(), projectID)
	}
}

type modelProviderOption struct {
	Name          string   `json:"name"`
	Models        []string `json:"models"`
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"default_effort"`
}

// Models lists the models sessions can use, grouped by provider — never the
// providers' endpoints or keys.
func (h *SessionHandler) Models(c echo.Context) error {
	providers := make([]modelProviderOption, len(h.models.Providers))
	for i, p := range h.models.Providers {
		providers[i] = modelProviderOption{p.Name, p.Models, p.Efforts, p.DefaultEffort()}
	}
	return c.JSON(http.StatusOK, map[string]any{"default": h.models.Default, "providers": providers})
}

// resolveModel picks the requested model, or the default when empty. Only
// configured models are accepted.
func (h *SessionHandler) resolveModel(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return h.models.Default, nil
	}
	if _, ok := h.models.Get(id); !ok {
		return "", echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("unknown model %q", id))
	}
	return id, nil
}

// effortFor is the effort a session on modelID runs at: want when the model's
// provider offers it, else the provider's default. modelID must be configured.
func (h *SessionHandler) effortFor(modelID, want string) string {
	m, _ := h.models.Get(modelID)
	if m.Provider.HasEffort(want) {
		return want
	}
	return m.Provider.DefaultEffort()
}

type createSessionRequest struct {
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

func (h *SessionHandler) Create(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	access, err := requireWritableProject(c, h.projectStore)
	if err != nil {
		return err
	}
	var req createSessionRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	modelID, err := h.resolveModel(req.Model)
	if err != nil {
		return err
	}

	sess := &model.Session{
		SessionID: uuid.New(),
		ProjectID: access.Project.ProjectID,
		Model:     modelID,
		Effort:    h.effortFor(modelID, req.Effort),
		Status:    "creating",
	}
	if err := h.sessionStore.Create(c.Request().Context(), sess, userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return echo.ErrUnauthorized
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	go h.bringUp(sess)

	return c.JSON(http.StatusCreated, sess)
}

// bringUp 确保 project 的 sandbox 在线（必要时拉起），然后在 agent 里登记 session。
// 前端轮询 session.status：creating → ready / failed。
func (h *SessionHandler) bringUp(sess *model.Session) {
	ctx := context.Background()

	sandboxURL, err := h.sandbox.EnsureReady(ctx, sess.ProjectID)
	if err != nil {
		log.Printf("warn: bring up sandbox for project %s: %v", sess.ProjectID, err)
		_ = h.sessionStore.UpdateStatus(ctx, sess.SessionID, "failed", "sandbox_error")
		return
	}

	_ = h.sessionStore.UpdateStatus(ctx, sess.SessionID, "creating", "handshake")
	if err := h.ensureAgentSession(ctx, sandboxURL, sess); err != nil {
		log.Printf("warn: handshake session %s: %v", sess.SessionID, err)
		_ = h.sessionStore.UpdateStatus(ctx, sess.SessionID, "failed", "handshake_error")
		return
	}

	_ = h.sessionStore.UpdateStatus(ctx, sess.SessionID, "ready", "")
}

// ensureAgentSession registers the session with the agent, along with its
// model's endpoint and key. Idempotent on the agent side (an existing
// transcript is reopened, switching model if it changed), so it's called
// before every prompt — which is also how a model switch reaches the agent.
func (h *SessionHandler) ensureAgentSession(ctx context.Context, sandboxURL string, sess *model.Session) error {
	m, ok := h.models.Get(sess.Model)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("model %q is no longer configured; switch to another model", sess.Model))
	}
	small, _ := h.models.Get(h.models.SmallModel)
	err := h.harnessClient.CreateSession(ctx, sandboxURL, sess.SessionID.String(), harness.AgentModel{
		ID: m.ID, Provider: m.Provider.Type, API: m.Provider.API, BaseURL: m.Provider.Endpoint, APIKey: m.Provider.Key,
		ThinkingLevel: h.effortFor(m.ID, sess.Effort),
	}, harness.AgentModel{
		ID: small.ID, Provider: small.Provider.Type, API: small.Provider.API, BaseURL: small.Provider.Endpoint, APIKey: small.Provider.Key,
	})
	if err != nil {
		return err
	}
	_, _, err = h.sessionStore.SyncTitle(ctx, sess.SessionID, nil, false, func(name string) (string, error) {
		return h.harnessClient.SetSessionName(ctx, sandboxURL, sess.SessionID.String(), name)
	})
	return err
}

type forkSessionRequest struct {
	// Before is the history messageId of a user message; the fork keeps only
	// what precedes it. Empty forks the whole session.
	Before string `json:"before"`
}

// Fork copies a session's conversation into a new session owned by the caller.
// Any member who can read the session may fork it, so a read-only viewer can
// carry on from someone else's conversation.
func (h *SessionHandler) Fork(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	src, _, err := requireReadableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	if src.Status != "ready" {
		return echo.NewHTTPError(http.StatusConflict, "session not ready")
	}
	var req forkSessionRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sandbox.Await(ctx, src.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}

	sess := &model.Session{
		SessionID: uuid.New(),
		ProjectID: src.ProjectID,
		Model:     src.Model,
		Effort:    src.Effort,
		Status:    "ready",
		Title:     forkTitle(src.Title),
	}
	if err := h.harnessClient.ForkSession(ctx, sandboxURL, src.SessionID.String(), sess.SessionID.String(), req.Before); err != nil {
		switch {
		case errors.Is(err, harness.ErrForkPoint):
			return echo.NewHTTPError(http.StatusNotFound, err.Error())
		case errors.Is(err, harness.ErrForkBusy):
			return echo.NewHTTPError(http.StatusConflict, err.Error())
		}
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if err := h.sessionStore.Create(ctx, sess, userID); err != nil {
		if err := h.harnessClient.DeleteSession(context.Background(), sandboxURL, sess.SessionID.String()); err != nil {
			log.Printf("warn: delete orphaned fork %s: %v", sess.SessionID, err)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return echo.ErrUnauthorized
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	// Names the fork natively; a failure only delays that to the first prompt,
	// which registers the session again (and reports a model that is gone).
	if err := h.ensureAgentSession(ctx, sandboxURL, sess); err != nil {
		log.Printf("warn: register fork %s: %v", sess.SessionID, err)
	}
	return c.JSON(http.StatusCreated, sess)
}

// forkTitle names a fork after its source; forks of forks keep one suffix.
func forkTitle(title *string) *string {
	if title == nil || strings.TrimSpace(*title) == "" {
		return nil
	}
	t := strings.TrimSpace(*title)
	if !strings.HasSuffix(t, " (fork)") {
		t += " (fork)"
	}
	return &t
}

func (h *SessionHandler) ListByProject(c echo.Context) error {
	access, err := requireReadableProject(c, h.projectStore)
	if err != nil {
		return err
	}
	sessions, err := h.sessionStore.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if sessions == nil {
		sessions = []*model.Session{}
	}
	return c.JSON(http.StatusOK, sessions)
}

func (h *SessionHandler) Get(c echo.Context) error {
	sess, _, err := requireReadableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, sess)
}

func (h *SessionHandler) SendMessage(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	if sess.Status != "ready" {
		return echo.NewHTTPError(http.StatusBadRequest, "session not ready")
	}

	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil || req.Text == "" {
		return echo.ErrBadRequest
	}

	ctx := c.Request().Context()
	// The project's sandbox may have been stopped since the session was
	// created; transcripts live on the workspace PVC, so restart and resume.
	sandboxURL, err := h.sandbox.Await(ctx, sess.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	if err := h.ensureAgentSession(ctx, sandboxURL, sess); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) {
			return he
		}
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}

	sessionID := sess.SessionID

	// Persist before forwarding. Suppress rejected automatic names in the UI too.
	onEvent := func(ev *harness.PlatformEvent) bool {
		if ev.Type != harness.EventSessionTitle {
			return true
		}
		var d harness.SessionTitleData
		if err := json.Unmarshal(ev.Data, &d); err != nil || d.Title == "" {
			return false
		}
		titleCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		name, updated, err := h.sessionStore.SyncTitle(titleCtx, sessionID, &d.Title, false, func(name string) (string, error) {
			return h.harnessClient.SetSessionName(titleCtx, sandboxURL, sessionID.String(), name)
		})
		if err == nil && updated {
			ev.Data, _ = json.Marshal(harness.SessionTitleData{Title: name})
		}
		if err != nil {
			log.Printf("warn: save title for %s: %v", sessionID, err)
		}
		return err == nil && updated
	}
	// A message sent while the session runs is steered into that run, whose
	// output keeps flowing on the stream that started it; only acknowledge it.
	err = h.harnessClient.StreamEventsUntilIdle(ctx, sandboxURL, sessionID.String(), c.Response(), onEvent, func() error {
		if err := h.harnessClient.PromptAsync(ctx, sandboxURL, sessionID.String(), req.Text); err != nil {
			if errors.Is(err, harness.ErrSteered) {
				return err
			}
			return echo.NewHTTPError(http.StatusBadGateway, err.Error())
		}

		// Persist activity before acknowledging the send so a concurrent list/get
		// cannot replace the client's new activity timestamp with the old value.
		activityCtx, cancelActivity := context.WithTimeout(context.Background(), 5*time.Second)
		if err := h.sessionStore.MarkSeen(activityCtx, sessionID); err != nil {
			log.Printf("warn: save activity for %s: %v", sessionID, err)
		}
		cancelActivity()

		c.Response().Header().Set("Content-Type", "text/event-stream")
		c.Response().Header().Set("Cache-Control", "no-cache")
		c.Response().Header().Set("Connection", "keep-alive")
		c.Response().Header().Set("X-Accel-Buffering", "no")
		c.Response().WriteHeader(http.StatusOK)
		c.Response().Flush()

		return nil
	})
	if errors.Is(err, harness.ErrSteered) {
		return c.NoContent(http.StatusAccepted)
	}
	// The run may go on after a client disconnects; the periodic sweep
	// collects the rest.
	h.syncUsage(sess.ProjectID)
	return err
}

// Events streams the session's live events to any project member, across runs,
// until the client disconnects. Clients subscribe first, then load a history
// snapshot and apply only events after its seq. Titles are left out: only the
// stream that started a run persists them, so viewers refresh the session.
func (h *SessionHandler) Events(c echo.Context) error {
	sess, _, err := requireReadableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	if sess.Status != "ready" {
		return echo.NewHTTPError(http.StatusConflict, "session not ready")
	}
	ctx := c.Request().Context()
	sandboxURL, err := h.sandbox.Await(ctx, sess.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	onEvent := func(ev *harness.PlatformEvent) bool { return ev.Type != harness.EventSessionTitle }
	err = h.harnessClient.StreamEvents(ctx, sandboxURL, sess.SessionID.String(), c.Response(), onEvent, func() error {
		c.Response().Header().Set("Content-Type", "text/event-stream")
		c.Response().Header().Set("Cache-Control", "no-cache")
		c.Response().Header().Set("Connection", "keep-alive")
		c.Response().Header().Set("X-Accel-Buffering", "no")
		c.Response().WriteHeader(http.StatusOK)
		c.Response().Flush()
		return nil
	})
	if c.Response().Committed {
		// The stream already started; the client reconnects and resyncs.
		return nil
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return nil
}

// WithdrawQueued takes back a steered message before it reaches the model.
func (h *SessionHandler) WithdrawQueued(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	index, err := strconv.Atoi(c.Param("index"))
	if err != nil || index < 0 {
		return echo.ErrBadRequest
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	gone := echo.NewHTTPError(http.StatusConflict, "This message has already been sent")
	base, ok := h.sandbox.URL(c.Request().Context(), sess.ProjectID)
	if !ok {
		return gone
	}
	messages, ok, err := h.harnessClient.WithdrawQueued(c.Request().Context(), base, sess.SessionID.String(), index, req.Text)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if !ok {
		return gone
	}
	if messages == nil {
		messages = []string{}
	}
	return c.JSON(http.StatusOK, map[string]any{"messages": messages})
}

type updateSessionRequest struct {
	Title *string `json:"title"`
	// Model and Effort switch the session's model / thinking effort. They take
	// effect on the next prompt, which re-registers the session with the agent
	// (see ensureAgentSession).
	Model  *string `json:"model"`
	Effort *string `json:"effort"`
}

func (h *SessionHandler) Update(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	var req updateSessionRequest
	if err := c.Bind(&req); err != nil || (req.Title == nil && req.Model == nil && req.Effort == nil) {
		return echo.ErrBadRequest
	}
	ctx := c.Request().Context()
	if req.Title != nil {
		sandboxURL, err := h.sandbox.Await(ctx, sess.ProjectID)
		if err != nil {
			return echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
		}
		if err := h.ensureAgentSession(ctx, sandboxURL, sess); err != nil {
			return echo.NewHTTPError(http.StatusBadGateway, err.Error())
		}
		_, _, err = h.sessionStore.SyncTitle(ctx, sess.SessionID, req.Title, true, func(name string) (string, error) {
			return h.harnessClient.SetSessionName(ctx, sandboxURL, sess.SessionID.String(), name)
		})
		if err != nil {
			return echo.NewHTTPError(http.StatusBadGateway, err.Error())
		}
	}
	if req.Model != nil || req.Effort != nil {
		modelID := sess.Model
		if req.Model != nil {
			if strings.TrimSpace(*req.Model) == "" {
				return echo.NewHTTPError(http.StatusBadRequest, "model must not be empty")
			}
			if modelID, err = h.resolveModel(*req.Model); err != nil {
				return err
			}
		} else if _, ok := h.models.Get(modelID); !ok {
			return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("model %q is no longer configured; switch to another model", modelID))
		}
		// An explicit effort must be offered by the model's provider; on a
		// model switch alone, keep the current effort if the new provider
		// offers it, else fall back to its default.
		effort := h.effortFor(modelID, sess.Effort)
		if req.Effort != nil {
			m, _ := h.models.Get(modelID)
			if !m.Provider.HasEffort(*req.Effort) {
				return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("effort %q is not offered for model %q", *req.Effort, modelID))
			}
			effort = *req.Effort
		}
		if err := h.sessionStore.UpdateModel(ctx, sess.SessionID, modelID, effort); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}
	sess, err = h.sessionStore.GetByID(ctx, sess.SessionID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return c.JSON(http.StatusOK, sess)
}

func (h *SessionHandler) Delete(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	// Only touch the agent if its sandbox is already up — no point starting a
	// sandbox just to delete a transcript.
	if sandboxURL, ok := h.sandbox.URL(c.Request().Context(), sess.ProjectID); ok {
		// While the session row still names who its usage belongs to.
		if h.usage != nil {
			syncCtx, cancel := context.WithTimeout(c.Request().Context(), usage.Inline)
			h.usage.Sync(syncCtx, sess.ProjectID)
			cancel()
		}
		if err := h.harnessClient.DeleteSession(c.Request().Context(), sandboxURL, sess.SessionID.String()); err != nil {
			log.Printf("warn: delete agent session %s: %v", sess.SessionID, err)
		}
	}
	if err := h.sessionStore.HardDelete(c.Request().Context(), sess.SessionID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// Abort 中止当前 session 的进行中对话
func (h *SessionHandler) Abort(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	sandboxURL, ok := h.sandbox.URL(c.Request().Context(), sess.ProjectID)
	if !ok {
		// Nothing can be running without a sandbox.
		return c.NoContent(http.StatusNoContent)
	}
	if err := h.harnessClient.Abort(c.Request().Context(), sandboxURL, sess.SessionID.String()); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// history loads a session's platform history, starting the sandbox if needed.
func (h *SessionHandler) history(ctx context.Context, sess *model.Session) ([]harness.PlatformHistoryItem, error) {
	if sess.Status != "ready" {
		return []harness.PlatformHistoryItem{}, nil
	}
	sandboxURL, err := h.sandbox.Await(ctx, sess.ProjectID)
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox unavailable: "+err.Error())
	}
	items, err := h.harnessClient.History(ctx, sandboxURL, sess.SessionID.String())
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if items == nil {
		items = []harness.PlatformHistoryItem{}
	}
	return items, nil
}

// History 拉取 session 的历史消息（统一平台格式）
func (h *SessionHandler) History(c echo.Context) error {
	sess, _, err := requireReadableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	items, err := h.history(c.Request().Context(), sess)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, items)
}

// Export 把 session 的完整历史导出为 markdown 或 json 文件。
// 默认 markdown；?format=json 返回原始 PlatformHistoryItem 数组。
func (h *SessionHandler) Export(c echo.Context) error {
	sess, _, err := requireReadableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	format := strings.ToLower(c.QueryParam("format"))
	if format == "" {
		format = "md"
	}
	if format != "md" && format != "json" {
		return echo.NewHTTPError(http.StatusBadRequest, "format must be md or json")
	}

	items, err := h.history(c.Request().Context(), sess)
	if err != nil {
		return err
	}

	filename := exportFilename(sess, format)
	c.Response().Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	if format == "json" {
		return c.JSON(http.StatusOK, items)
	}
	body := renderTranscriptMarkdown(sess, items)
	return c.Blob(http.StatusOK, "text/markdown; charset=utf-8", []byte(body))
}

func (h *SessionHandler) AnswerQuestionnaire(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.projectStore)
	if err != nil {
		return err
	}
	var body json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 1024*1024)).Decode(&body); err != nil {
		return echo.ErrBadRequest
	}
	base, ok := h.sandbox.URL(c.Request().Context(), sess.ProjectID)
	if !ok {
		return echo.NewHTTPError(http.StatusConflict, "This session is no longer waiting for answers")
	}
	status, message, err := h.harnessClient.AnswerQuestionnaire(c.Request().Context(), base, sess.SessionID.String(), c.Param("tool_id"), body)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	if status != http.StatusNoContent {
		if status != http.StatusBadRequest && status != http.StatusConflict {
			status = http.StatusBadGateway
		}
		if message == "" {
			message = "Unable to submit questionnaire"
		}
		return echo.NewHTTPError(status, message)
	}
	return c.NoContent(http.StatusNoContent)
}
