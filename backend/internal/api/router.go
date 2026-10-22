package api

import (
	"context"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/wellch4n/cattery/internal/auth"
	"golang.org/x/time/rate"
)

// tokenQueryRedactor strips secret tokens that leak into request URIs via
// `?token=` (used by <img>/<iframe> file URLs that can't set headers).
// Anyone with read access to the access log would otherwise have working
// session tokens.
var tokenQueryRedactor = regexp.MustCompile(`([?&]token=)[^&]*`)

func redactURI(uri string) string {
	return tokenQueryRedactor.ReplaceAllString(uri, "${1}REDACTED")
}

func NewRouter(
	database *sqlx.DB,
	projectH *ProjectHandler,
	sessionH *SessionHandler,
	filesH *FilesHandler,
	terminalH *TerminalHandler,
	skillsH *SkillsHandler,
	authH *AuthHandler,
	adminH *AdminHandler,
	usersH *UsersHandler,
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
		// K8s probes hit /healthz and /readyz every couple seconds — drop them
		// from the access log so real traffic stays readable.
		Skipper: func(c echo.Context) bool {
			p := c.Path()
			return p == "/healthz" || p == "/readyz"
		},
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

	// Liveness — process is up. Deliberately does NOT touch the DB so a
	// transient DB blip doesn't restart the pod.
	e.GET("/healthz", func(c echo.Context) error {
		return c.NoContent(http.StatusOK)
	})
	// Readiness — can we actually serve requests? Used by K8s to gate traffic.
	e.GET("/readyz", func(c echo.Context) error {
		ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
		defer cancel()
		if err := database.PingContext(ctx); err != nil {
			return c.JSON(http.StatusServiceUnavailable, echo.Map{"db": err.Error()})
		}
		return c.NoContent(http.StatusOK)
	})

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

	// Everything else requires a valid Bearer token: the Authorization header
	// normally, or a ?token= query for <img>/<iframe> file URLs — see
	// AuthMiddleware.
	protected := v1.Group("", AuthMiddleware(signer))

	protected.GET("/auth/me", authH.Me)
	protected.POST("/auth/change-password", authH.ChangePassword)

	protected.GET("/users/search", usersH.Search)

	projects := protected.Group("/projects")
	projects.POST("", projectH.Create)
	projects.GET("", projectH.List)
	projects.GET("/:project_id", projectH.Get)
	projects.PATCH("/:project_id", projectH.Update)
	projects.DELETE("/:project_id", projectH.Delete)
	projects.GET("/:project_id/sessions", sessionH.ListByProject)
	projects.POST("/:project_id/sessions", sessionH.Create)
	projects.POST("/:project_id/sandbox", projectH.StartSandbox)
	projects.DELETE("/:project_id/sandbox", projectH.StopSandbox)
	projects.GET("/:project_id/members", projectH.ListMembers)
	projects.POST("/:project_id/members", projectH.CreateMember)
	projects.DELETE("/:project_id/members/:user_id", projectH.DeleteMember)
	projects.GET("/:project_id/files/list", filesH.List)
	projects.GET("/:project_id/files/read", filesH.Read)
	projects.GET("/:project_id/files/latex", filesH.Latex)
	projects.POST("/:project_id/files/latex", filesH.Latex)
	projects.GET("/:project_id/files/raw", filesH.Raw)
	projects.GET("/:project_id/files/raw-path/*", filesH.RawPath)
	projects.GET("/:project_id/files/download", filesH.Download)
	projects.POST("/:project_id/files/upload", filesH.Upload)
	projects.DELETE("/:project_id/files/delete", filesH.Delete)
	projects.POST("/:project_id/files/rename", filesH.Rename)
	projects.POST("/:project_id/files/move", filesH.Move)
	projects.POST("/:project_id/files/mkdir", filesH.Mkdir)
	// WebSocket; browsers can't set headers on it, so it authenticates via ?token=.
	projects.GET("/:project_id/terminal", terminalH.Connect)
	projects.GET("/:project_id/terminals", terminalH.List)
	projects.POST("/:project_id/terminals", terminalH.Create)
	projects.POST("/:project_id/terminals/import", terminalH.Import)
	projects.PATCH("/:project_id/terminals/:terminal_id", terminalH.Rename)
	projects.DELETE("/:project_id/terminals/:terminal_id", terminalH.Delete)

	protected.GET("/models", sessionH.Models)

	sessions := protected.Group("/sessions")
	sessions.GET("/:session_id", sessionH.Get)
	sessions.POST("/:session_id/message", sessionH.SendMessage)
	sessions.POST("/:session_id/abort", sessionH.Abort)
	sessions.POST("/:session_id/questionnaire/:tool_id", sessionH.AnswerQuestionnaire)
	sessions.GET("/:session_id/history", sessionH.History)
	sessions.GET("/:session_id/export", sessionH.Export)
	sessions.PATCH("/:session_id", sessionH.Update)
	sessions.DELETE("/:session_id", sessionH.Delete)

	// Global skill library, proxied to the single cluster-wide skillmgr Pod.
	// Not project-scoped and (for now) not admin-gated — permissions are
	// deferred. Kept intentionally narrower than /files: skills are managed as
	// top-level folders uploaded from ZIP archives.
	skills := protected.Group("/skills")
	skills.GET("/catalog", skillsH.Catalog)
	skills.GET("/list", skillsH.List)
	skills.GET("/read", skillsH.Read)
	skills.POST("/upload-zip", skillsH.UploadZip)
	skills.DELETE("/delete", skillsH.Delete)
	skills.POST("/rename", skillsH.Rename)
	skills.POST("/mkdir", skillsH.Mkdir)

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
