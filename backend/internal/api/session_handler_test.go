package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/labstack/echo/v4"
	"github.com/pressly/goose/v3"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
)

// Use a dedicated PostgreSQL server; each test creates and drops its own database.
func creatorTestDB(t *testing.T) (*sqlx.DB, *goose.Provider) {
	t.Helper()
	dsn := os.Getenv("CATTERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CATTERY_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	admin, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	name := "cattery_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(`CREATE DATABASE "` + name + `"`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(`DROP DATABASE "` + name + `" WITH (FORCE)`); err != nil {
			t.Error(err)
		}
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	conn, err := sqlx.Connect("postgres", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	migrations, err := goose.NewProvider(goose.DialectPostgres, conn.DB, os.DirFS("../db/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	return conn, migrations
}

// Session creation must persist attribution even when sandbox startup fails.
type unavailableSessionSandbox struct{}

func (unavailableSessionSandbox) EnsureReady(context.Context, uuid.UUID) (string, error) {
	return "", errors.New("sandbox unavailable in test")
}
func (s unavailableSessionSandbox) Await(ctx context.Context, id uuid.UUID) (string, error) {
	return s.EnsureReady(ctx, id)
}
func (unavailableSessionSandbox) URL(context.Context, uuid.UUID) (string, bool) {
	return "", false
}

func TestSessionCreator(t *testing.T) {
	conn, migrations := creatorTestDB(t)
	ctx := context.Background()
	if _, err := migrations.UpTo(ctx, 6); err != nil {
		t.Fatal(err)
	}
	users := db.NewUserStore(conn)
	owner := &model.User{Username: "owner", PasswordHash: "test"}
	member := &model.User{Username: "member", PasswordHash: "test"}
	outsider := &model.User{Username: "outsider", PasswordHash: "test"}
	for _, u := range []*model.User{owner, member, outsider} {
		if err := users.Create(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	projects := db.NewProjectStore(conn)
	project := &model.Project{ProjectID: uuid.New(), OwnerUserID: owner.UserID}
	if err := projects.Create(ctx, project); err != nil {
		t.Fatal(err)
	}
	members := db.NewMemberStore(conn)
	if _, err := members.Upsert(ctx, project.ProjectID, member.UserID, model.AccessMember); err != nil {
		t.Fatal(err)
	}
	legacyID := uuid.New()
	if _, err := conn.Exec(`INSERT INTO sessions (session_id, project_id, model) VALUES ($1, $2, 'test')`, legacyID, project.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := migrations.Up(ctx); err != nil {
		t.Fatal(err)
	}

	sessions := db.NewSessionStore(conn)
	h := &SessionHandler{
		sessionStore: sessions, projectStore: projects, sandbox: unavailableSessionSandbox{},
		models: &config.Models{Default: "test", Providers: []config.Provider{{Models: []string{"test"}, Efforts: []string{"high"}}}},
	}
	signer, err := auth.NewSigner("session-creator-test")
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	e.Use(AuthMiddleware(signer))
	e.POST("/projects/:project_id/sessions", h.Create)
	e.GET("/projects/:project_id/sessions", h.ListByProject)
	e.GET("/sessions/:session_id", h.Get)
	e.PATCH("/sessions/:session_id", h.Update)
	request := func(user *model.User, method, path, body string, want int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		if user != nil {
			token, err := signer.Issue(user.UserID, false)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(echo.HeaderAuthorization, "Bearer "+token)
		}
		res := httptest.NewRecorder()
		e.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, res.Code, want, res.Body.String())
		}
		return res.Body.Bytes()
	}
	decode := func(body []byte) model.Session {
		t.Helper()
		var sess model.Session
		if err := json.Unmarshal(body, &sess); err != nil {
			t.Fatal(err)
		}
		return sess
	}
	assertCreator := func(sess model.Session, user *model.User) {
		t.Helper()
		if sess.CreatedByUserID == nil || *sess.CreatedByUserID != user.UserID || sess.CreatedByUsername == nil || *sess.CreatedByUsername != user.Username {
			t.Fatalf("session %s: creator = %v / %v, want %s / %s", sess.SessionID, sess.CreatedByUserID, sess.CreatedByUsername, user.UserID, user.Username)
		}
	}
	listPath := "/projects/" + project.ProjectID.String() + "/sessions"
	request(nil, http.MethodPost, listPath, `{}`, http.StatusUnauthorized)
	request(outsider, http.MethodPost, listPath, `{}`, http.StatusNotFound)
	spoofed := `{"created_by_user_id":"` + owner.UserID.String() + `","created_by_username":"owner"}`
	memberSession := decode(request(member, http.MethodPost, listPath, spoofed, http.StatusCreated))
	ownerSession := decode(request(owner, http.MethodPost, listPath, `{}`, http.StatusCreated))
	assertCreator(memberSession, member)
	assertCreator(ownerSession, owner)
	// Wait for the asynchronous startup attempts before closing the database.
	for _, id := range []uuid.UUID{memberSession.SessionID, ownerSession.SessionID} {
		deadline := time.Now().Add(5 * time.Second)
		for {
			sess, err := sessions.GetByID(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if sess.Status == "failed" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("sandbox startup did not finish")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	memberPath := "/sessions/" + memberSession.SessionID.String()
	assertCreator(decode(request(owner, http.MethodGet, memberPath, "", http.StatusOK)), member)
	// Sessions are private to their creator: other members, the project owner
	// included, can read but not change them.
	request(owner, http.MethodPatch, memberPath, `{"effort":"high"}`, http.StatusForbidden)
	assertCreator(decode(request(member, http.MethodPatch, memberPath, `{"effort":"high","created_by_username":"owner","created_by_user_id":"`+owner.UserID.String()+`"}`, http.StatusOK)), member)
	request(member, http.MethodPatch, "/sessions/"+ownerSession.SessionID.String(), `{"effort":"high"}`, http.StatusForbidden)
	// A session without a creator falls to the project owner.
	legacyPath := "/sessions/" + legacyID.String()
	request(member, http.MethodPatch, legacyPath, `{"effort":"high"}`, http.StatusForbidden)
	request(owner, http.MethodPatch, legacyPath, `{"effort":"high"}`, http.StatusOK)
	var listed []model.Session
	if err := json.Unmarshal(request(member, http.MethodGet, listPath, "", http.StatusOK), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 3 {
		t.Fatalf("got %d sessions, want 3", len(listed))
	}
	for _, sess := range listed {
		switch sess.SessionID {
		case memberSession.SessionID:
			assertCreator(sess, member)
		case ownerSession.SessionID:
			assertCreator(sess, owner)
		case legacyID:
			if sess.CreatedByUserID != nil || sess.CreatedByUsername != nil {
				t.Fatal("historical session must keep its creator unknown")
			}
		}
	}
	if err := members.Delete(ctx, project.ProjectID, member.UserID); err != nil {
		t.Fatal(err)
	}
	assertCreator(decode(request(owner, http.MethodGet, memberPath, "", http.StatusOK)), member)
	request(member, http.MethodGet, memberPath, "", http.StatusNotFound)
	if err := users.Delete(ctx, member.UserID); err != nil {
		t.Fatal(err)
	}
	afterDelete := decode(request(owner, http.MethodGet, memberPath, "", http.StatusOK))
	if afterDelete.CreatedByUserID != nil || afterDelete.CreatedByUsername == nil || *afterDelete.CreatedByUsername != member.Username {
		t.Fatal("deleting a member must preserve the session and creator username")
	}
	if _, err := migrations.DownTo(ctx, 6); err != nil {
		t.Fatal(err)
	}
	if _, err := migrations.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
