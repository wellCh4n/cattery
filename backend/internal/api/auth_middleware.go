package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
)

// echo.Context keys for the authenticated user. Kept in a separate file so
// handlers can call UserIDFromContext / IsAdminFromContext without depending
// on the middleware constructor.
const (
	ctxUserID  = "auth.user_id"
	ctxIsAdmin = "auth.is_admin"
)

// AuthMiddleware validates the Authorization: Bearer <jwt> header and
// injects user_id + is_admin into the echo.Context. Missing or invalid
// token → 401. Routes that don't need auth (the login endpoint itself,
// websocket upgrade for terminal sessions, etc.) must be mounted outside
// the group this middleware is attached to.
func AuthMiddleware(signer *auth.Signer) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			token := extractBearer(c.Request().Header.Get("Authorization"))
			if token == "" {
				// Terminal sessions are upgraded from HTTP to WS — browsers can't
				// set custom headers on the WS handshake, so we also accept the
				// token as a `?token=` query param on the upgrade URL.
				token = c.QueryParam("token")
			}
			if token == "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "missing bearer token")
			}
			claims, err := signer.Verify(token)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			c.Set(ctxUserID, claims.UserID)
			c.Set(ctxIsAdmin, claims.IsAdmin)
			return next(c)
		}
	}
}

// AdminOnly is layered on top of AuthMiddleware; rejects non-admins with 403.
func AdminOnly() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if !IsAdminFromContext(c) {
				return echo.NewHTTPError(http.StatusForbidden, "admin required")
			}
			return next(c)
		}
	}
}

func UserIDFromContext(c echo.Context) (uuid.UUID, bool) {
	v := c.Get(ctxUserID)
	if v == nil {
		return uuid.Nil, false
	}
	id, ok := v.(uuid.UUID)
	return id, ok
}

func IsAdminFromContext(c echo.Context) bool {
	v := c.Get(ctxIsAdmin)
	if v == nil {
		return false
	}
	b, _ := v.(bool)
	return b
}

func extractBearer(h string) string {
	// RFC 7235 says auth-scheme is case-insensitive — "bearer", "BEARER" and
	// "Bearer" all count. Most clients send the canonical form, but be
	// liberal in what we accept.
	const prefix = "Bearer "
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}
