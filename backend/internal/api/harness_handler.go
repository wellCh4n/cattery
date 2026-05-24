package api

import (
	"errors"
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
	shares  *db.ShareStore
	users   *db.UserStore
	sandbox *sandbox.Manager
}

func NewHarnessHandler(store *db.HarnessStore, shares *db.ShareStore, users *db.UserStore, sandboxMgr *sandbox.Manager) *HarnessHandler {
	return &HarnessHandler{store: store, shares: shares, users: users, sandbox: sandboxMgr}
}

// harnessDTO 在 model.Harness 上叠加 transport_kind 派生字段，让前端能直接判断
// 走聊天 UI 还是终端 UI，避免再单独请求一次 kind。
type harnessDTO struct {
	*model.Harness
	TransportKind harness.Kind `json:"transport_kind"`
	AccessRole    string       `json:"access_role"`
	OwnerUsername string       `json:"owner_username"`
}

func toDTO(h *model.Harness, accessRole, ownerUsername string) *harnessDTO {
	return &harnessDTO{
		Harness:       h,
		TransportKind: harness.KindFor(h.Type),
		AccessRole:    accessRole,
		OwnerUsername: ownerUsername,
	}
}

func toAccessDTO(access *model.HarnessAccess) *harnessDTO {
	return toDTO(access.Harness, access.AccessRole, access.OwnerUsername)
}

type createHarnessRequest struct {
	HarnessName *string           `json:"harness_name"`
	Model       string            `json:"model"          validate:"required"`
	Type        string            `json:"type"`
	EnvVars     map[string]string `json:"env_vars"`
}

func (h *HarnessHandler) Create(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
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
		OwnerUserID: userID,
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

	owner, _ := h.users.GetByID(c.Request().Context(), userID)
	ownerUsername := ""
	if owner != nil {
		ownerUsername = owner.Username
	}
	return c.JSON(http.StatusCreated, toDTO(inst, model.AccessOwner, ownerUsername))
}

func (h *HarnessHandler) List(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	harnesses, err := h.store.ListAccessible(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]*harnessDTO, 0, len(harnesses))
	for _, access := range harnesses {
		out = append(out, toAccessDTO(access))
	}
	return c.JSON(http.StatusOK, out)
}

func (h *HarnessHandler) Get(c echo.Context) error {
	access, err := requireReadableHarness(c, h.store)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, toAccessDTO(access))
}

type updateHarnessRequest struct {
	HarnessName *string `json:"harness_name"`
}

func (h *HarnessHandler) Update(c echo.Context) error {
	access, err := requireManageableHarness(c, h.store)
	if err != nil {
		return err
	}
	var req updateHarnessRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if req.HarnessName == nil {
		return echo.ErrBadRequest
	}
	if err := h.store.UpdateNameForOwner(c.Request().Context(), access.Harness.HarnessID, access.Harness.OwnerUserID, *req.HarnessName); err != nil {
		if errors.Is(err, db.ErrHarnessNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "harness not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	updated, err := h.store.GetAccessible(c.Request().Context(), access.Harness.HarnessID, access.Harness.OwnerUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	return c.JSON(http.StatusOK, toAccessDTO(updated))
}

func (h *HarnessHandler) Delete(c echo.Context) error {
	access, err := requireManageableHarness(c, h.store)
	if err != nil {
		return err
	}
	h.sandbox.Stop(c.Request().Context(), access.Harness)
	if err := h.store.DeleteForOwner(c.Request().Context(), access.Harness.HarnessID, access.Harness.OwnerUserID); err != nil {
		if errors.Is(err, db.ErrHarnessNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "harness not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

type shareRequest struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type updateShareRequest struct {
	Role string `json:"role"`
}

func validShareRole(role string) bool {
	return role == model.AccessViewer || role == model.AccessEditor
}

func (h *HarnessHandler) ListShares(c echo.Context) error {
	access, err := requireReadableHarness(c, h.store)
	if err != nil {
		return err
	}
	shares, err := h.shares.ListByHarness(c.Request().Context(), access.Harness.HarnessID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if shares == nil {
		shares = []*model.HarnessShare{}
	}
	return c.JSON(http.StatusOK, shares)
}

func (h *HarnessHandler) CreateShare(c echo.Context) error {
	access, err := requireManageableHarness(c, h.store)
	if err != nil {
		return err
	}
	var req shareRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if !validShareRole(req.Role) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid share role")
	}
	user, err := h.users.GetByUsername(c.Request().Context(), req.Username)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if user.UserID == access.Harness.OwnerUserID {
		return echo.NewHTTPError(http.StatusBadRequest, "owner already has access")
	}
	share, err := h.shares.Upsert(c.Request().Context(), access.Harness.HarnessID, user.UserID, req.Role)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusCreated, share)
}

func (h *HarnessHandler) UpdateShare(c echo.Context) error {
	access, err := requireManageableHarness(c, h.store)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "share not found")
	}
	var req updateShareRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if !validShareRole(req.Role) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid share role")
	}
	share, err := h.shares.UpdateRole(c.Request().Context(), access.Harness.HarnessID, userID, req.Role)
	if err != nil {
		if errors.Is(err, db.ErrShareNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "share not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, share)
}

func (h *HarnessHandler) DeleteShare(c echo.Context) error {
	access, err := requireManageableHarness(c, h.store)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "share not found")
	}
	if err := h.shares.Delete(c.Request().Context(), access.Harness.HarnessID, userID); err != nil {
		if errors.Is(err, db.ErrShareNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "share not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}
