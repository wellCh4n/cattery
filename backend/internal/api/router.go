package api

import (
	"log"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func NewRouter(harnessH *HarnessHandler, sessionH *SessionHandler, filesH *FilesHandler) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	// middleware.Logger() was deprecated in favor of RequestLogger; same
	// fields, just opt-in instead of the legacy fixed format.
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogMethod:  true,
		LogURI:     true,
		LogStatus:  true,
		LogLatency: true,
		LogError:   true,
		HandleError: true,
		LogValuesFunc: func(_ echo.Context, v middleware.RequestLoggerValues) error {
			if v.Error != nil {
				log.Printf("%s %s %d %s err=%v", v.Method, v.URI, v.Status, v.Latency, v.Error)
			} else {
				log.Printf("%s %s %d %s", v.Method, v.URI, v.Status, v.Latency)
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

	harnesses := v1.Group("/harnesses")
	harnesses.POST("", harnessH.Create)
	harnesses.GET("", harnessH.List)
	harnesses.GET("/:harness_id", harnessH.Get)
	harnesses.PATCH("/:harness_id", harnessH.Update)
	harnesses.DELETE("/:harness_id", harnessH.Delete)
	harnesses.POST("/:harness_id/sessions", sessionH.Create)
	harnesses.GET("/:harness_id/sessions", sessionH.ListByHarness)
	harnesses.DELETE("/:harness_id/sandbox", sessionH.StopSandbox)
	harnesses.GET("/:harness_id/files/list", filesH.List)
	harnesses.GET("/:harness_id/files/read", filesH.Read)
	harnesses.GET("/:harness_id/files/raw", filesH.Raw)
	harnesses.GET("/:harness_id/files/download", filesH.Download)
	harnesses.POST("/:harness_id/files/upload", filesH.Upload)

	sessions := v1.Group("/sessions")
	sessions.GET("/:session_id", sessionH.Get)
	sessions.POST("/:session_id/message", sessionH.SendMessage)
	sessions.POST("/:session_id/abort", sessionH.Abort)
	sessions.POST("/:session_id/answer", sessionH.Answer)
	sessions.GET("/:session_id/history", sessionH.History)
	sessions.GET("/:session_id/term", sessionH.Term)
	sessions.PATCH("/:session_id", sessionH.UpdateTitle)
	sessions.DELETE("/:session_id", sessionH.Delete)

	return e
}
