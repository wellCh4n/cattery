package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
)

type sharedTerminalSandbox struct {
	commands chan []string
	killErr  error
	killed   []string
}

func (s *sharedTerminalSandbox) TerminalPod(context.Context, uuid.UUID) (string, error) {
	return "test-pod", nil
}
func (s *sharedTerminalSandbox) Exec(ctx context.Context, req k8s.ExecTTY) error {
	s.commands <- req.Command
	if _, err := req.Stdout.Write([]byte("shared terminal")); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}
func (s *sharedTerminalSandbox) RunInAgent(_ context.Context, _ uuid.UUID, command []string) (string, bool, error) {
	s.killed = command
	return "", true, s.killErr
}

func TestSharedTerminals(t *testing.T) {
	conn, migrations := creatorTestDB(t)
	ctx := context.Background()
	if _, err := migrations.Up(ctx); err != nil {
		t.Fatal(err)
	}
	users := db.NewUserStore(conn)
	owner := &model.User{Username: "owner", PasswordHash: "test"}
	member := &model.User{Username: "member", PasswordHash: "test"}
	outsider := &model.User{Username: "outsider", PasswordHash: "test"}
	for _, user := range []*model.User{owner, member, outsider} {
		if err := users.Create(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	projects := db.NewProjectStore(conn)
	project := &model.Project{ProjectID: uuid.New(), OwnerUserID: owner.UserID}
	other := &model.Project{ProjectID: uuid.New(), OwnerUserID: owner.UserID}
	for _, p := range []*model.Project{project, other} {
		if err := projects.Create(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	members := db.NewMemberStore(conn)
	if _, err := members.Upsert(ctx, project.ProjectID, member.UserID, model.AccessMember); err != nil {
		t.Fatal(err)
	}
	sandbox := &sharedTerminalSandbox{commands: make(chan []string, 2)}
	h := &TerminalHandler{projects: projects, terminals: db.NewTerminalStore(conn), sandbox: sandbox}
	signer, _ := auth.NewSigner("shared-terminal-test")
	e := echo.New()
	e.Use(AuthMiddleware(signer))
	e.GET("/projects/:project_id/terminals", h.List)
	e.POST("/projects/:project_id/terminals", h.Create)
	e.POST("/projects/:project_id/terminals/import", h.Import)
	e.PATCH("/projects/:project_id/terminals/:terminal_id", h.Rename)
	e.DELETE("/projects/:project_id/terminals/:terminal_id", h.Delete)
	e.GET("/projects/:project_id/terminal", h.Connect)
	server := httptest.NewServer(e)
	defer server.Close()
	request := func(user *model.User, method, path, body string, want int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		if user != nil {
			token, _ := signer.Issue(user.UserID, false)
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res := httptest.NewRecorder()
		e.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s %s: got %d, want %d: %s", method, path, res.Code, want, res.Body.String())
		}
		return res.Body.Bytes()
	}
	decode := func(body []byte) model.Terminal {
		t.Helper()
		var terminal model.Terminal
		if err := json.Unmarshal(body, &terminal); err != nil {
			t.Fatal(err)
		}
		return terminal
	}
	path := "/projects/" + project.ProjectID.String() + "/terminals"
	request(nil, "GET", path, "", 401)
	request(outsider, "GET", path, "", 404)
	request(outsider, "POST", path, "{}", 404)
	terminal := decode(request(member, "POST", path, `{"created_by_user_id":"`+owner.UserID.String()+`","created_by_username":"owner"}`, 201))
	if terminal.CreatedByUserID == nil || *terminal.CreatedByUserID != member.UserID || terminal.CreatedByUsername == nil || *terminal.CreatedByUsername != "member" {
		t.Fatal("creator must come from authentication")
	}
	itemPath := path + "/" + terminal.TerminalID.String()
	connectPath := "/projects/" + project.ProjectID.String() + "/terminal?terminal=" + terminal.TerminalID.String()
	request(outsider, "GET", connectPath, "", 404)
	request(owner, "GET", "/projects/"+other.ProjectID.String()+"/terminal?terminal="+terminal.TerminalID.String(), "", 404)
	request(owner, "PATCH", "/projects/"+other.ProjectID.String()+"/terminals/"+terminal.TerminalID.String(), `{"title":"wrong project"}`, 404)
	request(outsider, "DELETE", itemPath, "", 404)
	request(owner, "PATCH", itemPath, `{"title":" "}`, 400)
	updated := decode(request(owner, "PATCH", itemPath, `{"title":"Shared shell","created_by_username":"owner"}`, 200))
	if updated.Title != "Shared shell" || *updated.CreatedByUsername != "member" {
		t.Fatal("rename changed attribution")
	}
	// A new store instance reads the same record, independent of any browser.
	persisted, err := db.NewTerminalStore(conn).Get(ctx, project.ProjectID, terminal.TerminalID)
	if err != nil || persisted.Title != updated.Title {
		t.Fatal("metadata did not persist", err)
	}
	var listed []model.Terminal
	if err := json.Unmarshal(request(owner, "GET", path, "", 200), &listed); err != nil || len(listed) != 1 || listed[0].TerminalID != terminal.TerminalID {
		t.Fatal("owner cannot see member's terminal", err)
	}
	// Two authenticated members connect with the same database ID and tmux command.
	for _, user := range []*model.User{owner, member} {
		token, _ := signer.Issue(user.UserID, false)
		socket, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+connectPath+"&token="+token, nil)
		if err != nil {
			t.Fatalf("connect: %v, response %v", err, response)
		}
		defer socket.Close()
		_ = socket.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, data, err := socket.ReadMessage(); err != nil || string(data) != "shared terminal" {
			t.Fatal("terminal output", err)
		}
	}
	for range 2 {
		command := <-sandbox.commands
		if len(command) != 3 || command[2] != terminalCommand(terminal.TerminalID.String()) {
			t.Fatal("members attached to different shells", command)
		}
	}
	legacyID := uuid.New()
	legacy := `{"terminals":[{"id":"` + legacyID.String() + `","title":"Old shell","createdAt":"2026-10-20T01:00:00Z"}]}`
	request(member, "POST", path+"/import", legacy, 204)
	request(owner, "POST", path+"/import", legacy, 204)
	old, err := h.terminals.Get(ctx, project.ProjectID, legacyID)
	if err != nil || old.CreatedByUserID != nil || old.CreatedByUsername != nil {
		t.Fatal("legacy creator must stay unknown", err)
	}
	request(owner, "POST", path+"/import", `{"terminals":[{"id":"`+terminal.TerminalID.String()+`","title":"Stale browser"}]}`, 204)
	persisted, _ = h.terminals.Get(ctx, project.ProjectID, terminal.TerminalID)
	if persisted.Title != "Shared shell" || *persisted.CreatedByUsername != "member" {
		t.Fatal("import overwrote shared metadata")
	}
	if err := members.Delete(ctx, project.ProjectID, member.UserID); err != nil {
		t.Fatal(err)
	}
	request(member, "GET", connectPath, "", 404)
	if err := users.Delete(ctx, member.UserID); err != nil {
		t.Fatal(err)
	}
	persisted, _ = h.terminals.Get(ctx, project.ProjectID, terminal.TerminalID)
	if persisted.CreatedByUserID != nil || *persisted.CreatedByUsername != "member" {
		t.Fatal("account deletion lost creator snapshot")
	}
	sandbox.killErr = errors.New("agent offline")
	request(owner, "DELETE", itemPath, "", 502)
	if _, err := h.terminals.Get(ctx, project.ProjectID, terminal.TerminalID); err != nil {
		t.Fatal("failed deletion removed metadata")
	}
	sandbox.killErr = nil
	request(owner, "DELETE", itemPath, "", 204)
	if len(sandbox.killed) != 4 || sandbox.killed[3] != "="+terminal.TerminalID.String() {
		t.Fatal("wrong shell killed", sandbox.killed)
	}
	request(owner, "GET", connectPath, "", 404)
	request(owner, "DELETE", itemPath, "", 204)
	request(owner, "POST", path+"/import", `{"terminals":[{"id":"`+terminal.TerminalID.String()+`","title":"Stale browser"}]}`, 204)
	request(owner, "GET", connectPath, "", 404)
	if err := projects.DeleteForOwner(ctx, project.ProjectID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	remaining, err := h.terminals.ListByProject(ctx, project.ProjectID)
	if err != nil || len(remaining) != 0 {
		t.Fatal("project deletion must remove terminals", err)
	}
}
