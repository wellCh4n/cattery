package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type HarnessHandler struct {
	store   *db.HarnessStore
	sandbox *sandbox.Manager
}

func NewHarnessHandler(store *db.HarnessStore, sandboxMgr *sandbox.Manager) *HarnessHandler {
	return &HarnessHandler{store, sandboxMgr}
}

// harnessDTO 在 model.Harness 上叠加 transport_kind 派生字段，让前端能直接判断
// 走聊天 UI 还是终端 UI，避免再单独请求一次 kind。
type harnessDTO struct {
	*model.Harness
	TransportKind harness.Kind `json:"transport_kind"`
}

func toDTO(h *model.Harness) *harnessDTO {
	return &harnessDTO{Harness: h, TransportKind: harness.KindFor(h.Type)}
}

type createHarnessRequest struct {
	HarnessName *string           `json:"harness_name"`
	Model       string            `json:"model"          validate:"required"`
	Type        string            `json:"type"`
	EnvVars     map[string]string `json:"env_vars"`
}

func (h *HarnessHandler) Create(c echo.Context) error {
	var req createHarnessRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if req.Model == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "model is required")
	}
	if req.Type == "" {
		req.Type = "opencode"
	}
	if req.EnvVars == nil {
		req.EnvVars = map[string]string{}
	}

	inst := &model.Harness{
		HarnessID:   uuid.New(),
		HarnessName: req.HarnessName,
		Model:       req.Model,
		Type:        req.Type,
		EnvVars:     req.EnvVars,
	}
	if err := h.store.Create(c.Request().Context(), inst); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// 异步拉起 sandbox：harness.sandbox_status 由 manager 写回 starting → ready / failed，
	// 前端通过轮询 GET /harnesses/:id 拿状态。响应里这条 inst 的 SandboxStatus 仍是
	// INSERT 默认值 "idle" —— 不在这里修，否则会和 goroutine 里 EnsureReady 读取
	// inst.SandboxStatus 的判断发生 race（看到 starting 会跳过 RunTask）。前端对
	// 非终态（!= ready / failed）都会轮询。
	h.sandbox.EnsureReadyAsync(inst)

	return c.JSON(http.StatusCreated, toDTO(inst))
}

func (h *HarnessHandler) List(c echo.Context) error {
	harnesses, err := h.store.List(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]*harnessDTO, 0, len(harnesses))
	for _, inst := range harnesses {
		out = append(out, toDTO(inst))
	}
	return c.JSON(http.StatusOK, out)
}

func (h *HarnessHandler) Get(c echo.Context) error {
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	inst, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	return c.JSON(http.StatusOK, toDTO(inst))
}

type updateHarnessRequest struct {
	HarnessName *string `json:"harness_name"`
}

func (h *HarnessHandler) Update(c echo.Context) error {
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	var req updateHarnessRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if err := h.store.UpdateName(c.Request().Context(), id, *req.HarnessName); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	inst, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	return c.JSON(http.StatusOK, toDTO(inst))
}

func (h *HarnessHandler) Delete(c echo.Context) error {
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return echo.ErrBadRequest
	}
	inst, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	h.sandbox.Stop(c.Request().Context(), inst)
	if err := h.store.Delete(c.Request().Context(), id); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}
