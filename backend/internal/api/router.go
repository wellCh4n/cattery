package api

import (
	"log"
	"regexp"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/wellch4n/cattery/internal/auth"
	"golang.org/x/time/rate"
)

// tokenQueryRedactor strips secret tokens that leak into request URIs via
// `?token=` (used by <img>/<iframe>/WS upgrades that can't set headers).
// Anyone with read access to the access log would otherwise have working
// session tokens.
var tokenQueryRedactor = regexp.MustCompile(`([?&]token=)[^&]*`)

func redactURI(uri string) string {
	return tokenQueryRedactor.ReplaceAllString(uri, "${1}REDACTED")
}

func NewRouter(
	harnessH *HarnessHandler,
	sessionH *SessionHandler,
	filesH *FilesHandler,
	authH *AuthHandler,
	adminH *AdminHandler,
	signer *auth.Signer,
) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	// middleware.Logger() was deprecated in favor of RequestLogger; same
	// fields, just opt-in instead of the legacy fixed format.
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogMethod:   true,
		LogURI:      true,
		LogStatus:   true,
		LogLatency:  true,
		LogError:    true,
		HandleError: true,
		LogValuesFunc: func(_ echo.Context, v middleware.RequestLoggerValues) error {
			uri := redactURI(v.URI)
			if v.Error != nil {
				log.Printf("%s %s %d %s err=%v", v.Method, uri, v.Status, v.Latency, v.Error)
			} else {
				log.Printf("%s %s %d %s", v.Method, uri, v.Status, v.Latency)
			}
			return nil
		},
	}))
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Content-Type", "Authorization"},
	}))

	v1 := e.Group("/api/v1")

	// Login is the only unauthenticated endpoint and the obvious brute-force
	// target. 5 requests/min per IP with burst 5 — generous enough that a
	// human typo'ing their password won't hit it, tight enough that scripted
	// dictionary attacks are crawl. Memory store ages entries out after 5
	// min so the map doesn't grow unbounded.
	loginLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Limit(5.0 / 60.0),
			Burst:     5,
			ExpiresIn: 5 * time.Minute,
		}),
		IdentifierExtractor: func(c echo.Context) (string, error) {
			return c.RealIP(), nil
		},
	})

	// Public endpoint — issues a token.
	v1.POST("/auth/login", authH.Login, loginLimiter)

	// Everything else requires a valid Bearer token (header) or ?token= query
	// (used by <img>/<iframe> file URLs and the terminal WebSocket upgrade,
	// which can't set custom headers).
	protected := v1.Group("", AuthMiddleware(signer))

	protected.GET("/auth/me", authH.Me)
	protected.POST("/auth/change-password", authH.ChangePassword)

	harnesses := protected.Group("/harnesses")
	harnesses.POST("", harnessH.Create)
	harnesses.GET("", harnessH.List)
	harnesses.GET("/:harness_id", harnessH.Get)
	harnesses.PATCH("/:harness_id", harnessH.Update)
	harnesses.DELETE("/:harness_id", harnessH.Delete)
	harnesses.GET("/:harness_id/shares", harnessH.ListShares)
	harnesses.GET("/:harness_id/share-candidates", harnessH.SearchShareCandidates)
	harnesses.POST("/:harness_id/shares", harnessH.CreateShare)
	harnesses.PATCH("/:harness_id/shares/:user_id", harnessH.UpdateShare)
	harnesses.DELETE("/:harness_id/shares/:user_id", harnessH.DeleteShare)
	harnesses.POST("/:harness_id/sessions", sessionH.Create)
	harnesses.GET("/:harness_id/sessions", sessionH.ListByHarness)
	harnesses.DELETE("/:harness_id/sandbox", sessionH.StopSandbox)
	harnesses.GET("/:harness_id/files/list", filesH.List)
	harnesses.GET("/:harness_id/files/read", filesH.Read)
	harnesses.GET("/:harness_id/files/raw", filesH.Raw)
	harnesses.GET("/:harness_id/files/raw-path/*", filesH.RawPath)
	harnesses.GET("/:harness_id/files/download", filesH.Download)
	harnesses.POST("/:harness_id/files/upload", filesH.Upload)

	sessions := protected.Group("/sessions")
	sessions.GET("/:session_id", sessionH.Get)
	sessions.POST("/:session_id/message", sessionH.SendMessage)
	sessions.POST("/:session_id/abort", sessionH.Abort)
	sessions.POST("/:session_id/answer", sessionH.Answer)
	sessions.GET("/:session_id/history", sessionH.History)
	sessions.GET("/:session_id/term", sessionH.Term)
	sessions.PATCH("/:session_id", sessionH.UpdateTitle)
	sessions.DELETE("/:session_id", sessionH.Delete)

	// Admin-only user management. AdminOnly layers on top of the existing
	// AuthMiddleware (already attached to `protected`), so we get both
	// "valid token" and "is_admin" checks.
	admin := protected.Group("/admin", AdminOnly())
	admin.GET("/users", adminH.ListUsers)
	admin.POST("/users", adminH.CreateUser)
	admin.PATCH("/users/:user_id", adminH.UpdateUser)
	admin.DELETE("/users/:user_id", adminH.DeleteUser)

	return e
}
