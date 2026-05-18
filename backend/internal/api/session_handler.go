package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	_ "github.com/wellch4n/cattery/internal/harness/claudecode" // register claude-code translators
	_ "github.com/wellch4n/cattery/internal/harness/opencode"   // register opencode translators
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
)

var harnessImages = map[string]string{
	"opencode":    "opencode-sandbox:dev",
	"claude-code": "claude-code-sandbox:dev",
}

type SessionHandler struct {
	sessionStore  *db.SessionStore
	agentStore    *db.AgentStore
	k8sClient     *k8s.Client
	harnessClient *harness.Client
	cfg           *config.Config
}

func NewSessionHandler(
	sessionStore *db.SessionStore,
	agentStore *db.AgentStore,
	k8sClient *k8s.Client,
	harnessClient *harness.Client,
	cfg *config.Config,
) *SessionHandler {
	return &SessionHandler{sessionStore, agentStore, k8sClient, harnessClient, cfg}
}

func (h *SessionHandler) Create(c echo.Context) error {
	agentID, err := uuid.Parse(c.Param("agent_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), agentID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "agent not found")
	}

	sess := &model.Session{
		SessionID: uuid.New(),
		AgentID:   agentID,
		Status:    "creating",
	}
	if err := h.sessionStore.Create(c.Request().Context(), sess); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	go h.bringUp(sess.SessionID, agent)

	return c.JSON(http.StatusCreated, sess)
}

// bringUp 确保 agent 的 sandbox 在线，然后在里面创建 harness session。
func (h *SessionHandler) bringUp(sessionID uuid.UUID, agent *model.Agent) {
	ctx := context.Background()

	sandboxURL, err := h.ensureSandbox(ctx, agent)
	if err != nil {
		_ = h.sessionStore.UpdateStatus(ctx, sessionID, "failed", "sandbox_error")
		return
	}

	_ = h.sessionStore.UpdateStatus(ctx, sessionID, "creating", "handshake")
	harnessSessionID, err := h.harnessClient.CreateSession(ctx, sandboxURL)
	if err != nil {
		_ = h.sessionStore.UpdateStatus(ctx, sessionID, "failed", "handshake_error")
		return
	}

	_ = h.sessionStore.UpdateReady(ctx, sessionID, harnessSessionID)
}

// ensureSandbox 若 sandbox 已 ready 直接返回 URL；否则启动并等待。
func (h *SessionHandler) ensureSandbox(ctx context.Context, agent *model.Agent) (string, error) {
	// 已经 ready，直接用
	if agent.SandboxStatus == "ready" && agent.SandboxURL != nil {
		return *agent.SandboxURL, nil
	}

	sandboxName := sandboxNameFor(agent)

	// 若已在 starting，等它就绪
	if agent.SandboxStatus == "starting" {
		return h.waitSandboxURL(ctx, sandboxName, agent.AgentID)
	}

	// idle / failed / 空：重新启动
	image, ok := harnessImages[agent.HarnessID]
	if !ok {
		image = harnessImages["opencode"]
	}

	env := make(map[string]string)
	for k, v := range agent.EnvVars {
		env[k] = v
	}
	env["MODEL"] = agent.Model
	if agent.Prompt != nil {
		env["AGENT_PROMPT"] = *agent.Prompt
	}
	env["PORT"] = fmt.Sprintf("%d", agent.ContainerPort)
	env["AGENT_ID"] = agent.AgentID.String()

	base := strings.TrimRight(h.cfg.ModelAPIBase, "/")
	if h.cfg.ModelAPIStyle == "anthropic" {
		env["ANTHROPIC_BASE_URL"] = base
		env["ANTHROPIC_API_KEY"] = h.cfg.ModelAPIKey
	} else {
		env["OPENAI_BASE_URL"] = base
		env["OPENAI_API_KEY"] = h.cfg.ModelAPIKey
	}
	// claude-code SDK always requires ANTHROPIC_* regardless of proxy style
	if agent.HarnessID == "claude-code" {
		env["ANTHROPIC_BASE_URL"] = base
		env["ANTHROPIC_API_KEY"] = h.cfg.ModelAPIKey
	}

	spec := k8s.SandboxSpec{
		Name:          sandboxName,
		SessionID:     agent.AgentID.String(),
		AgentID:       agent.AgentID.String(),
		HarnessImage:  image,
		ContainerPort: agent.ContainerPort,
		Env:           env,
	}

	_ = h.agentStore.UpdateSandboxStarting(ctx, agent.AgentID, sandboxName)
	if err := h.k8sClient.RunTask(ctx, spec); err != nil {
		_ = h.agentStore.UpdateSandboxStatus(ctx, agent.AgentID, "failed")
		return "", fmt.Errorf("run sandbox: %w", err)
	}

	return h.waitSandboxURL(ctx, sandboxName, agent.AgentID)
}

func (h *SessionHandler) waitSandboxURL(ctx context.Context, sandboxName string, agentID uuid.UUID) (string, error) {
	sandboxURL, err := h.k8sClient.WaitReady(ctx, sandboxName, 3*time.Minute)
	if err != nil {
		_ = h.agentStore.UpdateSandboxStatus(ctx, agentID, "failed")
		return "", err
	}
	if err := h.harnessClient.WaitHTTPReady(ctx, sandboxURL, 2*time.Minute); err != nil {
		_ = h.agentStore.UpdateSandboxStatus(ctx, agentID, "failed")
		return "", err
	}
	_ = h.agentStore.UpdateSandboxReady(ctx, agentID, sandboxURL)
	return sandboxURL, nil
}

func (h *SessionHandler) ListByAgent(c echo.Context) error {
	agentID, err := uuid.Parse(c.Param("agent_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sessions, err := h.sessionStore.ListByAgent(c.Request().Context(), agentID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if sessions == nil {
		sessions = []*model.Session{}
	}
	return c.JSON(http.StatusOK, sessions)
}

func (h *SessionHandler) Get(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sess, err := h.sessionStore.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return c.JSON(http.StatusOK, sess)
}

func (h *SessionHandler) SendMessage(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sess, err := h.sessionStore.GetByID(c.Request().Context(), id)
	if err != nil || sess.Status != "ready" {
		return echo.NewHTTPError(http.StatusBadRequest, "session not ready")
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), sess.AgentID)
	if err != nil || agent.SandboxURL == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "sandbox not ready")
	}

	var req struct {
		Text string `json:"text"`
	}
	if err := c.Bind(&req); err != nil || req.Text == "" {
		return echo.ErrBadRequest
	}

	if err := h.harnessClient.PromptAsync(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID, req.Text); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}

	go h.sessionStore.MarkSeen(context.Background(), id)

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
			if err := h.sessionStore.UpdateTitle(ctx, id, title); err != nil {
				log.Printf("warn: save title for %s: %v", id, err)
			}
		}(d.Title)
	}

	translate := harness.TranslatorFor(agent.HarnessID)
	return h.harnessClient.StreamEventsUntilIdle(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID, c.Response(), translate, onEvent)
}

func (h *SessionHandler) Delete(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	if sess, err := h.sessionStore.GetByID(c.Request().Context(), id); err == nil {
		if agent, err := h.agentStore.GetByID(c.Request().Context(), sess.AgentID); err == nil &&
			agent.SandboxURL != nil && sess.HarnessSessionID != nil {
			_ = h.harnessClient.Abort(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID)
		}
	}
	_ = h.sessionStore.MarkStopped(c.Request().Context(), id)
	return c.NoContent(http.StatusNoContent)
}

// Abort 中止当前 session 的进行中对话
func (h *SessionHandler) Abort(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sess, err := h.sessionStore.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), sess.AgentID)
	if err != nil || agent.SandboxURL == nil || sess.HarnessSessionID == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "session not active")
	}
	if err := h.harnessClient.Abort(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// Answer 把用户对 AskUserQuestion 的回答透传到 harness。
// 请求体由前端构造，后端不做 schema 检查 —— 不同 harness 的应答结构未必一致。
func (h *SessionHandler) Answer(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sess, err := h.sessionStore.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), sess.AgentID)
	if err != nil || agent.SandboxURL == nil || sess.HarnessSessionID == nil {
		return echo.NewHTTPError(http.StatusBadRequest, "session not active")
	}
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return echo.ErrBadRequest
	}
	if err := h.harnessClient.Answer(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID, body); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// History 拉取 session 的历史消息（统一平台格式）
func (h *SessionHandler) History(c echo.Context) error {
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	sess, err := h.sessionStore.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), sess.AgentID)
	if err != nil || agent.SandboxURL == nil || sess.HarnessSessionID == nil {
		return c.JSON(http.StatusOK, []harness.PlatformHistoryItem{})
	}
	raw, err := h.harnessClient.History(c.Request().Context(), *agent.SandboxURL, *sess.HarnessSessionID)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	items, err := harness.HistoryTranslatorFor(agent.HarnessID)(raw)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if items == nil {
		items = []harness.PlatformHistoryItem{}
	}
	return c.JSON(http.StatusOK, items)
}

// StopSandbox 停止 agent 的 sandbox（agent 级操作）
func (h *SessionHandler) StopSandbox(c echo.Context) error {
	agentID, err := uuid.Parse(c.Param("agent_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	agent, err := h.agentStore.GetByID(c.Request().Context(), agentID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "agent not found")
	}
	sandboxName := sandboxNameFor(agent)
	go func() {
		if err := h.k8sClient.StopTask(context.Background(), sandboxName); err != nil {
			log.Printf("warn: stop sandbox %s: %v", sandboxName, err)
		}
	}()
	_ = h.agentStore.UpdateSandboxStatus(c.Request().Context(), agentID, "idle")
	return c.NoContent(http.StatusNoContent)
}
