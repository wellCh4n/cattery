package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type AdminHandler struct {
	users    *db.UserStore
	harness  *db.HarnessStore
	projects *db.ProjectStore
	sandbox  *sandbox.Manager
}

func NewAdminHandler(users *db.UserStore, harnessStore *db.HarnessStore, projectStore *db.ProjectStore, sandboxMgr *sandbox.Manager) *AdminHandler {
	return &AdminHandler{users: users, harness: harnessStore, projects: projectStore, sandbox: sandboxMgr}
}

// adminUserDTO is the richer user view shown only on admin endpoints —
// includes timestamps so the admin UI can show "created at" / "last login".
type adminUserDTO struct {
	UserID      string     `json:"user_id"`
	Username    string     `json:"username"`
	IsAdmin     bool       `json:"is_admin"`
	CreatedAt   time.Time  `json:"created_at"`
	LastLoginAt *time.Time `json:"last_login_at"`
}

func toAdminDTO(u *model.User) adminUserDTO {
	return adminUserDTO{
		UserID:      u.UserID.String(),
		Username:    u.Username,
		IsAdmin:     u.IsAdmin,
		CreatedAt:   u.CreatedAt,
		LastLoginAt: u.LastLoginAt,
	}
}

func (h *AdminHandler) ListUsers(c echo.Context) error {
	users, err := h.users.List(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]adminUserDTO, 0, len(users))
	for _, u := range users {
		out = append(out, toAdminDTO(u))
	}
	return c.JSON(http.StatusOK, out)
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	IsAdmin  bool   `json:"is_admin"`
}

func (h *AdminHandler) CreateUser(c echo.Context) error {
	var req createUserRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if req.Username == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "username is required")
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	// Pre-check existence — a small race vs the UNIQUE constraint, but on
	// the failure path we'd surface a generic 500 to the admin which is
	// confusing. This gives a clean 409.
	if existing, err := h.users.GetByUsername(c.Request().Context(), req.Username); err == nil && existing != nil {
		return echo.NewHTTPError(http.StatusConflict, "username already exists")
	} else if err != nil && !errors.Is(err, db.ErrUserNotFound) {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	u := &model.User{Username: req.Username, PasswordHash: hash, IsAdmin: req.IsAdmin}
	if err := h.users.Create(c.Request().Context(), u); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusCreated, toAdminDTO(u))
}

type updateUserRequest struct {
	Password *string `json:"password,omitempty"`
	IsAdmin  *bool   `json:"is_admin,omitempty"`
}

// UpdateUser handles admin-driven password reset and admin role changes.
// Guardrails:
//   - cannot demote yourself (locks you out of /admin in your next session)
//   - cannot drop below one admin total
//
// Password + role are applied in a single SQL UPDATE so a partial failure
// can't leave the row half-changed.
func (h *AdminHandler) UpdateUser(c echo.Context) error {
	callerID, _ := UserIDFromContext(c)
	targetID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	target, err := h.users.GetByID(c.Request().Context(), targetID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	var req updateUserRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}

	var passwordHash *string
	if req.Password != nil {
		if err := auth.ValidatePassword(*req.Password); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		passwordHash = &hash
	}

	if req.IsAdmin != nil && *req.IsAdmin != target.IsAdmin && !*req.IsAdmin {
		// Demotion path — both guardrails apply.
		if targetID == callerID {
			return echo.NewHTTPError(http.StatusBadRequest, "cannot demote yourself")
		}
		n, err := h.users.CountAdmins(c.Request().Context())
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		if target.IsAdmin && n <= 1 {
			return echo.NewHTTPError(http.StatusConflict, "cannot remove the last admin")
		}
	}

	if passwordHash != nil || req.IsAdmin != nil {
		if err := h.users.UpdatePasswordAndAdmin(c.Request().Context(), targetID, passwordHash, req.IsAdmin); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}

	updated, err := h.users.GetByID(c.Request().Context(), targetID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, toAdminDTO(updated))
}

// DeleteUser drops the user and (because of ON DELETE CASCADE) their
// projects, harnesses, and sessions. The DB cascade does NOT touch K8s — we
// must stop each Sandbox CR explicitly first or it'll keep running forever as
// an orphan. We do this synchronously before the DB delete; sandbox.Stop is
// itself fire-and-forget so it just kicks off the deletion.
func (h *AdminHandler) DeleteUser(c echo.Context) error {
	callerID, _ := UserIDFromContext(c)
	targetID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if targetID == callerID {
		return echo.NewHTTPError(http.StatusBadRequest, "cannot delete yourself")
	}

	ctx := c.Request().Context()
	if _, err := h.users.GetByID(ctx, targetID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}

	// Stop sandboxes before cutting the harness rows out from under them.
	// Use a detached background context so a request cancel doesn't leave
	// half-stopped sandboxes — Stop is fast (just queues a K8s delete).
	harnesses, err := h.harness.ListForOwner(ctx, targetID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	bg := context.Background()
	for _, inst := range harnesses {
		h.sandbox.Stop(bg, inst)
	}

	if err := h.users.Delete(ctx, targetID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}
