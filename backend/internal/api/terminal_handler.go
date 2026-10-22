// Interactive shells in a project's agent container, bridged over WebSocket.
//
// Each terminal is a tmux session named after its database id, so the
// shell and its commands outlive the WebSocket: reconnecting reattaches, and
// DELETE kills the session.
//
// Wire protocol: binary frames carry raw terminal bytes in both directions;
// the client also sends text frames {"type":"resize","cols","rows"}. The server
// closes with 1000 when the shell exits and 1011 with a reason on failure.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/utils/exec"
)

// terminalCommand attaches (or creates, in the workspace) the terminal's tmux
// session. Images without tmux get a plain login shell that dies with the
// connection. id must be a validated UUID: it is spliced into the script.
func terminalCommand(id string) string {
	return `cd "${WORK_DIR:-${HOME:-/home/cattery}}" || exit 1; export TERM=xterm-256color; ` +
		`if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ` + id + `; fi; ` +
		`if command -v bash >/dev/null 2>&1; then exec bash -l; fi; exec sh -l`
}

const (
	terminalPingEvery = 30 * time.Second
	terminalPongWait  = 75 * time.Second
)

var terminalUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Auth is the ?token= bearer, never a cookie, so another origin can't ride
	// the user's session; this matches the API's CORS "*".
	CheckOrigin: func(*http.Request) bool { return true },
}

type terminalSandbox interface {
	TerminalPod(context.Context, uuid.UUID) (string, error)
	Exec(context.Context, k8s.ExecTTY) error
	RunInAgent(context.Context, uuid.UUID, []string) (string, bool, error)
}

type TerminalHandler struct {
	projects  *db.ProjectStore
	terminals *db.TerminalStore
	sandbox   terminalSandbox
}

func NewTerminalHandler(projects *db.ProjectStore, terminals *db.TerminalStore, sandboxMgr *sandbox.Manager) *TerminalHandler {
	return &TerminalHandler{projects: projects, terminals: terminals, sandbox: sandboxMgr}
}

func (h *TerminalHandler) List(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	terminals, err := h.terminals.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, terminals)
}

func (h *TerminalHandler) Create(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	userID, _ := UserIDFromContext(c)
	terminal := &model.Terminal{TerminalID: uuid.New(), ProjectID: access.Project.ProjectID}
	if err := h.terminals.Create(c.Request().Context(), terminal, userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return echo.ErrUnauthorized
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusCreated, terminal)
}

func (h *TerminalHandler) Rename(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(c.Param("terminal_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "terminal not found")
	}
	var req struct {
		Title string `json:"title"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || len(req.Title) > 200 {
		return echo.NewHTTPError(http.StatusBadRequest, "title must be between 1 and 200 bytes")
	}
	terminal, err := h.terminals.Rename(c.Request().Context(), access.Project.ProjectID, id, req.Title)
	if errors.Is(err, sql.ErrNoRows) {
		return echo.NewHTTPError(http.StatusNotFound, "terminal not found")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, terminal)
}

func (h *TerminalHandler) Import(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	var req struct {
		Terminals []struct {
			ID        uuid.UUID `json:"id"`
			Title     string    `json:"title"`
			CreatedAt time.Time `json:"createdAt"`
		} `json:"terminals"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 1024*1024)).Decode(&req); err != nil {
		return echo.ErrBadRequest
	}
	terminals := make([]model.Terminal, 0, len(req.Terminals))
	for _, old := range req.Terminals {
		if old.ID == uuid.Nil {
			return echo.NewHTTPError(http.StatusBadRequest, "terminal must be a UUID")
		}
		title := strings.TrimSpace(old.Title)
		if title == "" {
			title = "New Terminal"
		}
		if old.CreatedAt.IsZero() {
			old.CreatedAt = time.Now()
		}
		terminals = append(terminals, model.Terminal{TerminalID: old.ID, Title: title, CreatedAt: old.CreatedAt})
	}
	if err := h.terminals.Import(c.Request().Context(), access.Project.ProjectID, terminals); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// Connect upgrades GET /projects/:id/terminal?terminal=<uuid> and attaches the
// terminal's shell in the agent container. The shell has exactly the agent's
// privileges, so any member who can prompt the agent may open one.
func (h *TerminalHandler) Connect(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	terminalID, err := uuid.Parse(c.QueryParam("terminal"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "terminal must be a UUID")
	}
	if _, err := h.terminals.Get(c.Request().Context(), access.Project.ProjectID, terminalID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return echo.NewHTTPError(http.StatusNotFound, "terminal not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	userID, _ := UserIDFromContext(c)
	projectID := access.Project.ProjectID

	conn, err := terminalUpgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return nil // Upgrade already replied with an HTTP error.
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(c.Request().Context())
	defer cancel()

	stdin := &stdinQueue{ch: make(chan []byte, 1024), done: ctx.Done()}
	sizes := &sizeQueue{ch: make(chan remotecommand.TerminalSize, 1), done: ctx.Done()}

	// Read before the Pod is up so a client that leaves mid-start cancels the
	// wait, and keepalive pongs are seen.
	go func() {
		defer cancel()
		defer close(stdin.ch)
		_ = conn.SetReadDeadline(time.Now().Add(terminalPongWait))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(terminalPongWait))
		})
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			switch kind {
			case websocket.BinaryMessage:
				select {
				case stdin.ch <- data:
				case <-ctx.Done():
					return
				}
			case websocket.TextMessage:
				var msg struct {
					Type string `json:"type"`
					Cols uint16 `json:"cols"`
					Rows uint16 `json:"rows"`
				}
				if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0 {
					sizes.push(remotecommand.TerminalSize{Width: msg.Cols, Height: msg.Rows})
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(terminalPingEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
					cancel()
					return
				}
			}
		}
	}()

	pod, err := h.sandbox.TerminalPod(ctx, projectID)
	if err != nil {
		closeTerminal(conn, websocket.CloseInternalServerErr, "sandbox unavailable: "+err.Error())
		return nil
	}
	// Provisioning can take minutes; do not recreate a shell deleted meanwhile.
	if _, err := h.terminals.Get(ctx, projectID, terminalID); err != nil {
		closeTerminal(conn, websocket.ClosePolicyViolation, "terminal no longer available")
		return nil
	}

	log.Printf("terminal open project=%s user=%s pod=%s", projectID, userID, pod)
	started := time.Now()
	err = h.sandbox.Exec(ctx, k8s.ExecTTY{
		Pod:     pod,
		Command: []string{"/bin/sh", "-c", terminalCommand(terminalID.String())},
		Stdin:   stdin,
		Stdout:  &wsWriter{conn: conn},
		Sizes:   sizes,
	})
	log.Printf("terminal close project=%s user=%s duration=%s err=%v", projectID, userID, time.Since(started).Round(time.Second), err)

	var exitErr utilexec.ExitError
	switch {
	case ctx.Err() != nil:
		// The client went away; nobody is left to tell.
	case err == nil || errors.As(err, &exitErr):
		closeTerminal(conn, websocket.CloseNormalClosure, "exited")
	default:
		closeTerminal(conn, websocket.CloseInternalServerErr, err.Error())
	}
	return nil
}

// Delete handles DELETE /projects/:id/terminals/:terminal_id: it kills the
// terminal's tmux session, ending its shell and anything it runs. A stopped
// container has no sessions, so there is nothing to kill.
func (h *TerminalHandler) Delete(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	terminalID, err := uuid.Parse(c.Param("terminal_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "terminal not found")
	}
	if _, err := h.terminals.Get(c.Request().Context(), access.Project.ProjectID, terminalID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return c.NoContent(http.StatusNoContent)
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()
	// "=" makes tmux match the name exactly rather than as a prefix.
	out, ran, err := h.sandbox.RunInAgent(ctx, access.Project.ProjectID, []string{"tmux", "kill-session", "-t", "=" + terminalID.String()})
	var exitErr utilexec.ExitError
	switch {
	case !ran:
	case errors.As(err, &exitErr):
		// The session already ended (or tmux isn't installed).
		log.Printf("terminal kill project=%s terminal=%s: %s", access.Project.ProjectID, terminalID, strings.TrimSpace(out))
	case err != nil:
		return echo.NewHTTPError(http.StatusBadGateway, "kill terminal: "+err.Error())
	}
	if err := h.terminals.Delete(ctx, access.Project.ProjectID, terminalID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// closeTerminal sends a close frame; reasons are capped at 123 bytes by RFC 6455.
func closeTerminal(conn *websocket.Conn, code int, reason string) {
	if len(reason) > 123 {
		reason = reason[:123]
		for !utf8.ValidString(reason) {
			reason = reason[:len(reason)-1]
		}
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
}

// wsWriter sends each stdout chunk as one binary frame.
type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// stdinQueue buffers keystrokes so the WebSocket reader never blocks on a
// shell that hasn't started yet.
type stdinQueue struct {
	ch   chan []byte
	buf  []byte
	done <-chan struct{}
}

func (q *stdinQueue) Read(p []byte) (int, error) {
	if len(q.buf) == 0 {
		select {
		case b, ok := <-q.ch:
			if !ok {
				return 0, io.EOF
			}
			q.buf = b
		case <-q.done:
			return 0, io.EOF
		}
	}
	n := copy(p, q.buf)
	q.buf = q.buf[n:]
	return n, nil
}

// sizeQueue is a latest-wins remotecommand.TerminalSizeQueue.
type sizeQueue struct {
	ch   chan remotecommand.TerminalSize
	done <-chan struct{}
}

func (q *sizeQueue) push(size remotecommand.TerminalSize) {
	for {
		select {
		case q.ch <- size:
			return
		default:
			select {
			case <-q.ch:
			default:
			}
		}
	}
}

func (q *sizeQueue) Next() *remotecommand.TerminalSize {
	select {
	case size := <-q.ch:
		return &size
	case <-q.done:
		return nil
	}
}
