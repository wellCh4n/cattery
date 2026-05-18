package api

import (
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func NewRouter(agentH *AgentHandler, sessionH *SessionHandler) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Content-Type", "Authorization"},
	}))

	v1 := e.Group("/api/v1")

	agents := v1.Group("/agents")
	agents.POST("", agentH.Create)
	agents.GET("", agentH.List)
	agents.GET("/:agent_id", agentH.Get)
	agents.DELETE("/:agent_id", agentH.Delete)
	agents.POST("/:agent_id/sessions", sessionH.Create)
	agents.GET("/:agent_id/sessions", sessionH.ListByAgent)
	agents.DELETE("/:agent_id/sandbox", sessionH.StopSandbox)

	sessions := v1.Group("/sessions")
	sessions.GET("/:session_id", sessionH.Get)
	sessions.POST("/:session_id/message", sessionH.SendMessage)
	sessions.POST("/:session_id/abort", sessionH.Abort)
	sessions.POST("/:session_id/answer", sessionH.Answer)
	sessions.GET("/:session_id/history", sessionH.History)
	sessions.GET("/:session_id/term", sessionH.Term)
	sessions.DELETE("/:session_id", sessionH.Delete)

	return e
}
