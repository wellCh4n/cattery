package api

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
)

type AgentHandler struct {
	store     *db.AgentStore
	k8sClient *k8s.Client
}

func NewAgentHandler(store *db.AgentStore, k8sClient *k8s.Client) *AgentHandler {
	return &AgentHandler{store, k8sClient}
}

// agentDTO 在 model.Agent 上叠加 harness_kind 派生字段，让前端能直接判断
// 走聊天 UI 还是终端 UI，避免再单独请求一次 kind。
type agentDTO struct {
	*model.Agent
	HarnessKind harness.Kind `json:"harness_kind"`
}

func toDTO(a *model.Agent) *agentDTO {
	return &agentDTO{Agent: a, HarnessKind: harness.KindFor(a.HarnessID)}
}

// sandboxNameFor 生成 K8s Sandbox 资源名，形如 `cattery-<harness>-<agent_id>`。
// harness 为空时回落到旧格式 `cattery-<agent_id>`，避免删除老 sandbox 时漏掉资源。
func sandboxNameFor(a *model.Agent) string {
	if a.HarnessID == "" {
		return fmt.Sprintf("cattery-%s", a.AgentID.String())
	}
	return fmt.Sprintf("cattery-%s-%s", a.HarnessID, a.AgentID.String())
}

type createAgentRequest struct {
	AgentName     *string           `json:"agent_name"`
	Model         string            `json:"model"          validate:"required"`
	Prompt        *string           `json:"prompt"`
	HarnessID     string            `json:"harness_id"`
	EnvVars       map[string]string `json:"env_vars"`
	ContainerPort int               `json:"container_port"`
}

func (h *AgentHandler) Create(c echo.Context) error {
	var req createAgentRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if req.Model == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "model is required")
	}
	if req.HarnessID == "" {
		req.HarnessID = "opencode"
	}
	if req.ContainerPort == 0 {
		req.ContainerPort = 4096
	}
	if req.EnvVars == nil {
		req.EnvVars = map[string]string{}
	}

	a := &model.Agent{
		AgentID:       uuid.New(),
		AgentName:     req.AgentName,
		Model:         req.Model,
		Prompt:        req.Prompt,
		HarnessID:     req.HarnessID,
		EnvVars:       req.EnvVars,
		ContainerPort: req.ContainerPort,
	}
	if err := h.store.Create(c.Request().Context(), a); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusCreated, toDTO(a))
}

func (h *AgentHandler) List(c echo.Context) error {
	agents, err := h.store.List(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]*agentDTO, 0, len(agents))
	for _, a := range agents {
		out = append(out, toDTO(a))
	}
	return c.JSON(http.StatusOK, out)
}

func (h *AgentHandler) Get(c echo.Context) error {
	id, err := uuid.Parse(c.Param("agent_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	a, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "agent not found")
	}
	return c.JSON(http.StatusOK, toDTO(a))
}

func (h *AgentHandler) Delete(c echo.Context) error {
	id, err := uuid.Parse(c.Param("agent_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	a, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "agent not found")
	}
	sandboxName := sandboxNameFor(a)
	go func() {
		if err := h.k8sClient.StopTask(context.Background(), sandboxName); err != nil {
			log.Printf("warn: stop sandbox %s: %v", sandboxName, err)
		}
	}()
	if err := h.store.Delete(c.Request().Context(), id); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}
