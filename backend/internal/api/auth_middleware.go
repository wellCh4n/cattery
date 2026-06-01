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

// wsBearerProtocol is the Sec-WebSocket-Protocol marker the terminal WS client
// pairs with the bearer token (it sends ["cattery.bearer", "<jwt>"]). Browsers
// can't set an Authorization header on a WS upgrade, so the token rides in the
// handshake header next to this marker instead of in the URL — keeping it out
// of proxy/ingress access logs. The Term handler must echo this value back to
// complete the browser's subprotocol negotiation (see term_handler.go).
const wsBearerProtocol = "cattery.bearer"

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
				// <img>/<iframe> file URLs and the export download link can't set
				// custom headers, so we also accept the token as a `?token=` query
				// param. (The terminal WS uses the subprotocol header instead —
				// see below — to keep the token out of access logs.)
				token = c.QueryParam("token")
			}
			if token == "" {
				// Terminal WS upgrades smuggle the token through the
				// Sec-WebSocket-Protocol header, paired with wsBearerProtocol.
				token = extractWSProtocolToken(c.Request().Header.Get("Sec-WebSocket-Protocol"))
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

// extractWSProtocolToken pulls the bearer token out of a Sec-WebSocket-Protocol
// header of the form "cattery.bearer, <jwt>". The browser serializes the
// client's requested subprotocols comma-separated; we return the first entry
// that isn't the wsBearerProtocol marker. JWTs only use base64url chars plus
// '.', '-', '_', none of which collide with the comma/space delimiters, so the
// token survives the round trip intact.
func extractWSProtocolToken(h string) string {
	if h == "" {
		return ""
	}
	for _, p := range strings.Split(h, ",") {
		if p = strings.TrimSpace(p); p != "" && p != wsBearerProtocol {
			return p
		}
	}
	return ""
}
