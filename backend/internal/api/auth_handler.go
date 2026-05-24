package api

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
)

type AuthHandler struct {
	users  *db.UserStore
	signer *auth.Signer
}

func NewAuthHandler(users *db.UserStore, signer *auth.Signer) *AuthHandler {
	return &AuthHandler{users: users, signer: signer}
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token string  `json:"token"`
	User  userDTO `json:"user"`
}

type userDTO struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	IsAdmin  bool   `json:"is_admin"`
}

// Login validates credentials and issues a JWT. We deliberately collapse
// "no such user" and "wrong password" into the same error so attackers
// can't enumerate accounts.
func (h *AuthHandler) Login(c echo.Context) error {
	var req loginRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if req.Username == "" || req.Password == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "username and password are required")
	}

	u, err := h.users.GetByUsername(c.Request().Context(), req.Username)
	if err != nil {
		// Run bcrypt against a known-invalid hash anyway so that "unknown
		// username" and "wrong password" cost the same wall-clock time.
		// Without this, an attacker can enumerate accounts by latency.
		auth.VerifyPassword(auth.DummyHash(), req.Password)
		if errors.Is(err, db.ErrUserNotFound) {
			return echo.NewHTTPError(http.StatusUnauthorized, "invalid credentials")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if !auth.VerifyPassword(u.PasswordHash, req.Password) {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid credentials")
	}

	token, err := h.signer.Issue(u.UserID, u.IsAdmin)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if err := h.users.MarkLogin(c.Request().Context(), u.UserID); err != nil {
		log.Printf("warn: mark login for %s: %v", u.UserID, err)
	}

	return c.JSON(http.StatusOK, loginResponse{
		Token: token,
		User: userDTO{
			UserID:   u.UserID.String(),
			Username: u.Username,
			IsAdmin:  u.IsAdmin,
		},
	})
}

// Me returns the authenticated user's profile. Reads user_id off the echo
// context (injected by AuthMiddleware); re-fetches from DB so is_admin
// reflects the current DB state, not just what the token claimed.
func (h *AuthHandler) Me(c echo.Context) error {
	uid, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	u, err := h.users.GetByID(c.Request().Context(), uid)
	if err != nil {
		return echo.ErrUnauthorized
	}
	return c.JSON(http.StatusOK, userDTO{
		UserID:   u.UserID.String(),
		Username: u.Username,
		IsAdmin:  u.IsAdmin,
	})
}

type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

func (h *AuthHandler) ChangePassword(c echo.Context) error {
	uid, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	var req changePasswordRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	u, err := h.users.GetByID(c.Request().Context(), uid)
	if err != nil {
		return echo.ErrUnauthorized
	}
	if !auth.VerifyPassword(u.PasswordHash, req.OldPassword) {
		return echo.NewHTTPError(http.StatusUnauthorized, "old password is incorrect")
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if err := h.users.UpdatePassword(c.Request().Context(), uid, hash); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}
