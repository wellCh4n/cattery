package api

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	_ "github.com/wellch4n/cattery/internal/harness/claudecode" // register claude-code translators
	_ "github.com/wellch4n/cattery/internal/harness/codex"      // register codex (terminal kind)
	_ "github.com/wellch4n/cattery/internal/harness/hermes"     // register hermes (terminal kind)
	_ "github.com/wellch4n/cattery/internal/harness/opencode"   // register opencode translators
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type SessionHandler struct {
	sessionStore  *db.SessionStore
	harnessStore  *db.HarnessStore
	harnessClient *harness.Client
	sandbox       *sandbox.Manager
}

func NewSessionHandler(
	sessionStore *db.SessionStore,
	harnessStore *db.HarnessStore,
	harnessClient *harness.Client,
	sandboxMgr *sandbox.Manager,
) *SessionHandler {
	return &SessionHandler{sessionStore, harnessStore, harnessClient, sandboxMgr}
}

func (h *SessionHandler) Create(c echo.Context) error {
	access, err := requireWritableHarness(c, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if inst.SandboxStatus != "ready" {
		return echo.NewHTTPError(http.StatusConflict, "sandbox is not ready")
	}

	// theme 仅 terminal harness（codex）使用 —— 用来生成正确的 OSC 10/11 应答色，
	// 让 codex 启动时按当前页面主题挑亮色/暗色调色板。前端如果未传则默认 dark。
	var req struct {
		Theme string `json:"theme"`
	}
	_ = c.Bind(&req)
	theme := req.Theme
	if theme != "light" {
		theme = "dark"
	}

	sess := &model.Session{
		SessionID: uuid.New(),
		HarnessID: inst.HarnessID,
		Status:    "creating",
	}
	if err := h.sessionStore.Create(c.Request().Context(), sess); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	go h.bringUp(sess.SessionID, inst, theme)

	return c.JSON(http.StatusCreated, sess)
}

// bringUp 确保 harness 的 sandbox 在线，然后在里面创建 harness session。
// Harness 创建时已经异步起过 sandbox，这里通常只是等它 ready；万一是
// idle / failed 状态（被 stop 或上次拉起失败），manager 会负责重新拉起。
func (h *SessionHandler) bringUp(sessionID uuid.UUID, inst *model.Harness, theme string) {
	ctx := context.Background()

	sandboxURL, err := h.sandbox.EnsureReady(ctx, inst)
	if err != nil {
		_ = h.sessionStore.UpdateStatus(ctx, sessionID, "failed", "sandbox_error")
		return
	}

	_ = h.sessionStore.UpdateStatus(ctx, sessionID, "creating", "handshake")
	harnessSessionID, err := h.harnessClient.CreateSession(ctx, sandboxURL, theme)
	if err != nil {
		_ = h.sessionStore.UpdateStatus(ctx, sessionID, "failed", "handshake_error")
		return
	}

	_ = h.sessionStore.UpdateReady(ctx, sessionID, harnessSessionID)
}

func (h *SessionHandler) ListByHarness(c echo.Context) error {
	access, err := requireReadableHarness(c, h.harnessStore)
	if err != nil {
		return err
	}
	sessions, err := h.sessionStore.ListByHarness(c.Request().Context(), access.Harness.HarnessID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if sessions == nil {
		sessions = []*model.Session{}
	}
	return c.JSON(http.StatusOK, sessions)
}

func (h *SessionHandler) Get(c echo.Context) error {
	sess, _, err := requireReadableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, sess)
}

func (h *SessionHandler) SendMessage(c echo.Context) error {
	sess, access, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if sess.Status != "ready" {
		return echo.NewHTTPError(http.StatusBadRequest, "session not ready")
	}
	if inst.SandboxURL == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "sandbox not ready")
	}

	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil || req.Text == "" {
		return echo.ErrBadRequest
	}

	if err := h.harnessClient.PromptAsync(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID, req.Text); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}

	sessionID := sess.SessionID
	go h.sessionStore.MarkSeen(context.Background(), sessionID)

	c.Response().Header().Set("Content-Type", "text/event-stream")
	c.Response().Header().Set("Cache-Control", "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)

	// 流式事件中如果出现 session.title，把 title 落库（opencode 第一条消息后会发）
	onEvent := func(ev *harness.PlatformEvent) {
		if ev.Type != harness.EventSessionTitle {
			return
		}
		var d harness.SessionTitleData
		if err := json.Unmarshal(ev.Data, &d); err != nil || d.Title == "" {
			return
		}
		go func(title string) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.sessionStore.UpdateTitle(ctx, sessionID, title); err != nil {
				log.Printf("warn: save title for %s: %v", sessionID, err)
			}
		}(d.Title)
	}

	translate := harness.TranslatorFor(inst.Type)
	return h.harnessClient.StreamEventsUntilIdle(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID, c.Response(), translate, onEvent)
}

type updateSessionRequest struct {
	Title *string `json:"title"`
}

func (h *SessionHandler) UpdateTitle(c echo.Context) error {
	sess, _, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	var req updateSessionRequest
	if err := c.Bind(&req); err != nil || req.Title == nil {
		return echo.ErrBadRequest
	}
	if err := h.sessionStore.UpdateTitle(c.Request().Context(), sess.SessionID, *req.Title); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	sess, err = h.sessionStore.GetByID(c.Request().Context(), sess.SessionID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return c.JSON(http.StatusOK, sess)
}

func (h *SessionHandler) Delete(c echo.Context) error {
	sess, access, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if inst.SandboxURL != nil && sess.HarnessSessionID != nil {
		_ = h.harnessClient.Abort(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID)
	}
	if err := h.sessionStore.HardDelete(c.Request().Context(), sess.SessionID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// PurgeDeadByHarness 删除单个 harness 下所有 status='dead' 的 session 行。
// 仅 owner 可调用 — share 用户没必要替 owner 清理。
func (h *SessionHandler) PurgeDeadByHarness(c echo.Context) error {
	access, err := requireManageableHarness(c, h.harnessStore)
	if err != nil {
		return err
	}
	n, err := h.sessionStore.PurgeDeadByHarness(c.Request().Context(), access.Harness.HarnessID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, echo.Map{"deleted": n})
}

// PurgeDeadAll 删除当前用户所拥有的所有 harness 下的 dead session。
// 共享 harness 内的 dead session 不归这里管 — 让 harness owner 自己决定。
func (h *SessionHandler) PurgeDeadAll(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	n, err := h.sessionStore.PurgeDeadByOwner(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, echo.Map{"deleted": n})
}

// Abort 中止当前 session 的进行中对话
func (h *SessionHandler) Abort(c echo.Context) error {
	sess, access, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if inst.SandboxURL == nil || sess.HarnessSessionID == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "session not active")
	}
	if err := h.harnessClient.Abort(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// Answer 把用户对 AskUserQuestion 的回答透传到 harness。
// 请求体由前端构造，后端不做 schema 检查 —— 不同 harness 的应答结构未必一致。
func (h *SessionHandler) Answer(c echo.Context) error {
	sess, access, err := requireWritableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if inst.SandboxURL == nil || sess.HarnessSessionID == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "session not active")
	}
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return echo.ErrBadRequest
	}
	if err := h.harnessClient.Answer(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID, body); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// History 拉取 session 的历史消息（统一平台格式）
func (h *SessionHandler) History(c echo.Context) error {
	sess, access, err := requireReadableSession(c, h.sessionStore, h.harnessStore)
	if err != nil {
		return err
	}
	inst := access.Harness
	if inst.SandboxURL == nil || sess.HarnessSessionID == nil {
		return c.JSON(http.StatusOK, []harness.PlatformHistoryItem{})
	}
	raw, err := h.harnessClient.History(c.Request().Context(), *inst.SandboxURL, *sess.HarnessSessionID)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	items, err := harness.HistoryTranslatorFor(inst.Type)(raw)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if items == nil {
		items = []harness.PlatformHistoryItem{}
	}
	return c.JSON(http.StatusOK, items)
}

// StopSandbox 停止 harness 的 sandbox（harness 级操作）
func (h *SessionHandler) StopSandbox(c echo.Context) error {
	access, err := requireManageableHarness(c, h.harnessStore)
	if err != nil {
		return err
	}
	h.sandbox.Stop(c.Request().Context(), access.Harness)
	return c.NoContent(http.StatusNoContent)
}
