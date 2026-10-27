// Package live fans project events out to the browsers that have the project
// open, over the user's /api/v1/live WebSocket, and tracks who is online in
// each project (presence).
//
// The hub lives in memory: the backend runs one replica. Everything it sends
// is current state or an invalidation, so a client that reconnects resubscribes
// and refetches instead of replaying what it missed.
package live

import (
	"encoding/json"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Event is one frame sent to clients.
type Event struct {
	Type      string     `json:"type"`
	ProjectID *uuid.UUID `json:"project_id,omitempty"`
	Data      any        `json:"data,omitempty"`
}

// User is a connected user as presence shows them.
type User struct {
	UserID        uuid.UUID `json:"user_id"`
	Username      string    `json:"username"`
	Name          string    `json:"name"`
	AvatarVersion string    `json:"avatar_version"`
}

// sendBuffer bounds the frames queued for a slow client; one that falls this
// far behind is disconnected and recovers by reconnecting.
const sendBuffer = 64

// Client is one WebSocket connection.
type Client struct {
	User User
	// Send carries encoded frames to the connection's writer. The hub closes it
	// when the client is removed or falls behind.
	Send chan []byte

	projects map[uuid.UUID]struct{}
	closed   bool
}

type Hub struct {
	mu      sync.Mutex
	clients map[*Client]struct{}
	subs    map[uuid.UUID]map[*Client]struct{}
	// arrived orders presence: when each user's first connection still in
	// the project subscribed.
	arrived map[uuid.UUID]map[uuid.UUID]time.Time
}

func NewHub() *Hub {
	return &Hub{
		clients: map[*Client]struct{}{},
		subs:    map[uuid.UUID]map[*Client]struct{}{},
		arrived: map[uuid.UUID]map[uuid.UUID]time.Time{},
	}
}

// Add registers a connection for user.
func (h *Hub) Add(user User) *Client {
	c := &Client{User: user, Send: make(chan []byte, sendBuffer), projects: map[uuid.UUID]struct{}{}}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	return c
}

// Remove drops a connection and its subscriptions.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(c)
}

func (h *Hub) removeLocked(c *Client) {
	if _, ok := h.clients[c]; !ok {
		return
	}
	delete(h.clients, c)
	for projectID := range c.projects {
		h.unsubscribeLocked(c, projectID)
	}
	if !c.closed {
		c.closed = true
		close(c.Send)
	}
}

// Subscribe starts sending projectID's events to c and announces c's user in
// the project. The caller checks that the user may read the project.
func (h *Hub) Subscribe(c *Client, projectID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; !ok {
		return
	}
	if _, ok := c.projects[projectID]; ok {
		// Already subscribed: resend presence so the client has it either way.
		h.sendLocked(c, h.presenceLocked(projectID))
		return
	}
	c.projects[projectID] = struct{}{}
	if h.subs[projectID] == nil {
		h.subs[projectID] = map[*Client]struct{}{}
		h.arrived[projectID] = map[uuid.UUID]time.Time{}
	}
	h.subs[projectID][c] = struct{}{}
	if _, ok := h.arrived[projectID][c.User.UserID]; !ok {
		h.arrived[projectID][c.User.UserID] = time.Now()
	}
	h.publishLocked(projectID, h.presenceLocked(projectID))
}

// Unsubscribe stops projectID's events to c.
func (h *Hub) Unsubscribe(c *Client, projectID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.unsubscribeLocked(c, projectID)
}

func (h *Hub) unsubscribeLocked(c *Client, projectID uuid.UUID) {
	if _, ok := c.projects[projectID]; !ok {
		return
	}
	delete(c.projects, projectID)
	delete(h.subs[projectID], c)
	if len(h.subs[projectID]) == 0 {
		delete(h.subs, projectID)
		delete(h.arrived, projectID)
		return
	}
	if !h.hasUserLocked(projectID, c.User.UserID) {
		delete(h.arrived[projectID], c.User.UserID)
	}
	h.publishLocked(projectID, h.presenceLocked(projectID))
}

// Publish sends ev to every client subscribed to projectID.
func (h *Hub) Publish(projectID uuid.UUID, ev Event) {
	ev.ProjectID = &projectID
	h.mu.Lock()
	defer h.mu.Unlock()
	h.publishLocked(projectID, ev)
}

func (h *Hub) publishLocked(projectID uuid.UUID, ev Event) {
	for c := range h.subs[projectID] {
		h.sendLocked(c, ev)
	}
}

func (h *Hub) sendLocked(c *Client, ev Event) {
	frame, err := json.Marshal(ev)
	if err != nil {
		return
	}
	select {
	case c.Send <- frame:
	default:
		h.removeLocked(c)
	}
}

func (h *Hub) hasUserLocked(projectID, userID uuid.UUID) bool {
	for c := range h.subs[projectID] {
		if c.User.UserID == userID {
			return true
		}
	}
	return false
}

// presenceLocked lists the project's online users, each once however many
// connections they hold, in the order they arrived.
func (h *Hub) presenceLocked(projectID uuid.UUID) Event {
	since := h.arrived[projectID]
	users := map[uuid.UUID]User{}
	for c := range h.subs[projectID] {
		users[c.User.UserID] = c.User
	}
	list := make([]User, 0, len(users))
	for _, u := range users {
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := since[list[i].UserID], since[list[j].UserID]
		if !a.Equal(b) {
			return a.Before(b)
		}
		return list[i].UserID.String() < list[j].UserID.String()
	})
	return Event{Type: "presence", ProjectID: &projectID, Data: map[string]any{"users": list}}
}
