package api

import (
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func NewRouter(harnessH *HarnessHandler, sessionH *SessionHandler) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Logger())
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
