package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type SessionHandler struct {
	sessionStore  *db.SessionStore
	projectStore  *db.ProjectStore
	harnessClient *harness.Client
	sandbox       *sandbox.Manager
	models        *config.Models
}

func NewSessionHandler(
	sessionStore *db.SessionStore,
	projectStore *db.ProjectStore,
	harnessClient *harness.Client,
	sandboxMgr *sandbox.Manager,
	models *config.Models,
) *SessionHandler {
	return &SessionHandler{sessionStore, projectStore, harnessClient, sandboxMgr, models}
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
	if err := h.sessionStore.Create(c.Request().Context(), sess); err != nil {
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
	return h.harnessClient.CreateSession(ctx, sandboxURL, sess.SessionID.String(), harness.AgentModel{
		ID: m.ID, Provider: m.Provider.Type, BaseURL: m.Provider.Endpoint, APIKey: m.Provider.Key,
		ThinkingLevel: h.effortFor(m.ID, sess.Effort),
	}, harness.AgentModel{
		ID: small.ID, Provider: small.Provider.Type, BaseURL: small.Provider.Endpoint, APIKey: small.Provider.Key,
	})
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
		updated, err := h.sessionStore.UpdateAutoTitle(titleCtx, sessionID, d.Title)
		if err != nil {
			log.Printf("warn: save title for %s: %v", sessionID, err)
		}
		return err == nil && updated
	}
	return h.harnessClient.StreamEventsUntilIdle(ctx, sandboxURL, sessionID.String(), c.Response(), onEvent, func() error {
		if err := h.harnessClient.PromptAsync(ctx, sandboxURL, sessionID.String(), req.Text); err != nil {
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
		if err := h.sessionStore.UpdateTitle(ctx, sess.SessionID, *req.Title); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
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
