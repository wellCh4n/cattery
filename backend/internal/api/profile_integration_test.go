package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
)

// Each run owns a fresh database. TEST_DATABASE_URL needs CREATEDB privileges;
// its application tables are never touched.
func TestProfileIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	root, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	testDB := "profile_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := root.Exec("CREATE DATABASE " + testDB); err != nil {
		t.Fatal(err)
	}
	defer root.Exec("DROP DATABASE " + testDB + " WITH (FORCE)")
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + testDB
	database, err := db.Connect(u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx := context.Background()
	users := db.NewUserStore(database)
	owner := &model.User{Username: "owner", PasswordHash: "test"}
	member := &model.User{Username: "member", PasswordHash: "test"}
	for _, user := range []*model.User{owner, member} {
		if err := users.Create(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	signer, _ := auth.NewSigner("test-only-signing-key-for-profile-tests")
	token, _ := signer.Issue(member.UserID, false)
	authH := NewAuthHandler(users, signer)
	hosts, _ := NewPreviewHosts("http://*.localhost:8081")
	router := NewRouter(database, nil, nil, nil, nil, nil, authH, nil, NewUsersHandler(users), NewPortsHandler(nil, nil, signer, hosts), nil, signer)
	request := func(method, path string, body []byte, contentType, bearer string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		if contentType != "" {
			r.Header.Set("Content-Type", contentType)
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, code int) {
		t.Helper()
		if w.Code != code {
			t.Fatalf("HTTP %d, want %d: %s", w.Code, code, w.Body.String())
		}
	}
	patch := func(body string) *httptest.ResponseRecorder {
		return request("PATCH", "/api/v1/auth/me", []byte(body), "application/json", token)
	}
	check(request("PATCH", "/api/v1/auth/me", []byte(`{"name":"changed"}`), "application/json", ""), 401)
	check(patch(`{"name":"  小陈  "}`), 200)
	got, _ := users.GetByID(ctx, member.UserID)
	if got.Name != "小陈" || got.Username != "member" {
		t.Fatalf("incorrect profile: %+v", got)
	}
	check(patch(`{"name":"x","is_admin":true}`), 400)
	check(patch(`{"name":"x","user_id":"`+owner.UserID.String()+`"}`), 400)
	check(patch(`{"name":null}`), 400)
	check(patch(`{"name":"x"} {}`), 400)
	check(patch(`{"name":"`+strings.Repeat("陈", 65)+`"}`), 400)
	other, _ := users.GetByID(ctx, owner.UserID)
	if other.Name != "" {
		t.Fatal("modified another user's profile")
	}
	check(request("GET", "/api/v1/users/search?q="+url.QueryEscape("小陈"), nil, "", token), 200)
	found, err := users.Search(ctx, "小陈", 20)
	if err != nil || len(found) != 1 || found[0].UserID != member.UserID {
		t.Fatalf("name search: %v, %v", found, err)
	}

	var imageData bytes.Buffer
	_ = png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 320, 160)))
	upload := func(data []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, _ := writer.CreateFormFile("avatar", "photo.png")
		_, _ = part.Write(data)
		_ = writer.Close()
		return request("PUT", "/api/v1/auth/me/avatar", body.Bytes(), writer.FormDataContentType(), token)
	}
	check(upload([]byte("not an image")), 400)
	check(upload(make([]byte, maxAvatarBytes+1)), 413)
	check(upload(imageData.Bytes()), 200)
	got, _ = users.GetByID(ctx, member.UserID)
	if got.AvatarVersion == "" {
		t.Fatal("missing avatar version")
	}
	avatarPath := "/api/v1/users/" + member.UserID.String() + "/avatar"
	check(request("GET", avatarPath, nil, "", ""), 401)
	w := request("GET", avatarPath, nil, "", token)
	check(w, 200)
	img, err := png.Decode(bytes.NewReader(w.Body.Bytes()))
	if err != nil || img.Bounds().Dx() != 256 || img.Bounds().Dy() != 256 {
		t.Fatalf("invalid stored avatar: %v", err)
	}
	r := httptest.NewRequest("GET", avatarPath, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("If-None-Match", w.Header().Get("ETag"))
	cached := httptest.NewRecorder()
	router.ServeHTTP(cached, r)
	check(cached, 304)

	projects := db.NewProjectStore(database)
	project := &model.Project{ProjectID: uuid.New(), OwnerUserID: owner.UserID}
	if err := projects.Create(ctx, project); err != nil {
		t.Fatal(err)
	}
	members := db.NewMemberStore(database)
	if _, err := members.Upsert(ctx, project.ProjectID, member.UserID, "member"); err != nil {
		t.Fatal(err)
	}
	sessions := db.NewSessionStore(database)
	session := &model.Session{SessionID: uuid.New(), ProjectID: project.ProjectID, Model: "test", Status: "ready"}
	if err := sessions.Create(ctx, session, member.UserID); err != nil {
		t.Fatal(err)
	}
	terminals := db.NewTerminalStore(database)
	terminal := &model.Terminal{TerminalID: uuid.New(), ProjectID: project.ProjectID}
	if err := terminals.Create(ctx, terminal, member.UserID); err != nil {
		t.Fatal(err)
	}
	usage := db.NewUsageStore(database)
	now := time.Now().UTC()
	if err := usage.Ingest(ctx, project.ProjectID, []model.UsageRecord{{ID: uuid.NewString(), SessionID: session.SessionID, At: now.UnixMilli(), Model: "test", Input: 12}}, 1); err != nil {
		t.Fatal(err)
	}
	check(patch(`{"name":"New name"}`), 200)
	session, err = sessions.GetByID(ctx, session.SessionID)
	if err != nil || session.CreatedByName != "New name" || session.CreatedByAvatarVersion != got.AvatarVersion {
		t.Fatalf("session profile: %+v %v", session, err)
	}
	terminal, err = terminals.Rename(ctx, project.ProjectID, terminal.TerminalID, "terminal")
	if err != nil || terminal.CreatedByName != "New name" {
		t.Fatalf("terminal profile: %+v %v", terminal, err)
	}
	memberList, err := members.ListByProject(ctx, project.ProjectID)
	if err != nil || len(memberList) != 1 || memberList[0].Name != "New name" {
		t.Fatalf("member profile: %+v %v", memberList, err)
	}
	if err := users.UpdateName(ctx, owner.UserID, "Owner name"); err != nil {
		t.Fatal(err)
	}
	access, err := projects.GetAccessible(ctx, project.ProjectID, member.UserID)
	if err != nil || access.OwnerName != "Owner name" {
		t.Fatalf("owner profile: %+v %v", access, err)
	}
	stats, err := usage.Stats(ctx, now.AddDate(0, 0, -1), now.AddDate(0, 0, 1), "day", "UTC", nil)
	if err != nil || len(stats) != 1 || stats[0].Name != "New name" || stats[0].Input != 12 {
		t.Fatalf("usage profile: %+v %v", stats, err)
	}

	check(request("DELETE", "/api/v1/auth/me/avatar", nil, "", token), 200)
	check(request("GET", avatarPath, nil, "", token), 404)
	check(patch(`{"name":"   "}`), 200)
	w = request("GET", "/api/v1/auth/me", nil, "", token)
	check(w, 200)
	var profile userDTO
	_ = json.Unmarshal(w.Body.Bytes(), &profile)
	if profile.Name != "" || profile.AvatarVersion != "" || profile.Username != "member" {
		t.Fatalf("cleared profile: %+v", profile)
	}
	check(upload(imageData.Bytes()), 200)
	if err := users.Delete(ctx, member.UserID); err != nil {
		t.Fatal(err)
	}
	check(request("GET", avatarPath, nil, "", token), 404)
	session, err = sessions.GetByID(ctx, session.SessionID)
	if err != nil || session.CreatedByUserID != nil || session.CreatedByName != "" || session.CreatedByUsername == nil || *session.CreatedByUsername != "member" {
		t.Fatalf("deleted creator snapshot: %+v %v", session, err)
	}
	stats, err = usage.Stats(ctx, now.AddDate(0, 0, -1), now.AddDate(0, 0, 1), "day", "UTC", nil)
	if err != nil || len(stats) != 1 || stats[0].UserID != nil || stats[0].Name != "" || stats[0].Username == nil || *stats[0].Username != "member" {
		t.Fatalf("deleted usage snapshot: %+v %v", stats, err)
	}
}
