// The user's live channel: one WebSocket per browser tab carrying project
// events (presence, sandbox status) for the projects the tab subscribes to.
//
// Client → server text frames: {"type":"subscribe"|"unsubscribe","project_id"}.
// Server → client text frames: live.Event, {"type","project_id"?,"data"?}.
// Events are current state or invalidations; after a reconnect the client
// resubscribes and refetches, so nothing is replayed.
package api

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/live"
)

const (
	livePingEvery = 30 * time.Second
	livePongWait  = 75 * time.Second
	liveWriteWait = 10 * time.Second
)

type LiveHandler struct {
	hub      *live.Hub
	users    *db.UserStore
	projects *db.ProjectStore
}

func NewLiveHandler(hub *live.Hub, users *db.UserStore, projects *db.ProjectStore) *LiveHandler {
	return &LiveHandler{hub: hub, users: users, projects: projects}
}

// Connect upgrades GET /live. Like the terminal it authenticates by ?token=.
func (h *LiveHandler) Connect(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	user, err := h.users.GetByID(c.Request().Context(), userID)
	if err != nil {
		return echo.ErrUnauthorized
	}
	conn, err := terminalUpgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return nil // Upgrade already replied with an HTTP error.
	}
	defer conn.Close()

	client := h.hub.Add(live.User{UserID: user.UserID, Username: user.Username, Name: user.Name, AvatarVersion: user.AvatarVersion})
	defer h.hub.Remove(client)

	ctx, cancel := context.WithCancel(c.Request().Context())
	defer cancel()
	go func() {
		defer cancel()
		h.read(ctx, conn, client, userID)
	}()

	ticker := time.NewTicker(livePingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case frame, ok := <-client.Send:
			if !ok {
				// Fell behind; the client reconnects and refetches.
				closeTerminal(conn, websocket.CloseTryAgainLater, "too slow")
				return nil
			}
			_ = conn.SetWriteDeadline(time.Now().Add(liveWriteWait))
			if conn.WriteMessage(websocket.TextMessage, frame) != nil {
				return nil
			}
		case <-ticker.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(liveWriteWait)) != nil {
				return nil
			}
		}
	}
}

func (h *LiveHandler) read(ctx context.Context, conn *websocket.Conn, client *live.Client, userID uuid.UUID) {
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(livePongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(livePongWait))
	})
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if kind != websocket.TextMessage {
			continue
		}
		var msg struct {
			Type      string    `json:"type"`
			ProjectID uuid.UUID `json:"project_id"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "subscribe":
			// Only members see a project's events; others are silently ignored.
			if _, err := h.projects.GetAccessible(ctx, msg.ProjectID, userID); err != nil {
				continue
			}
			h.hub.Subscribe(client, msg.ProjectID)
		case "unsubscribe":
			h.hub.Unsubscribe(client, msg.ProjectID)
		}
	}
}
