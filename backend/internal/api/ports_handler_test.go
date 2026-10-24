package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
)

// A preview cookie must not work as a login token anywhere else.
func TestPreviewTokenIsNotALoginToken(t *testing.T) {
	signer, err := auth.NewSigner("test-secret")
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.IssuePreview(uuid.New(), uuid.New(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	handler := AuthMiddleware(signer)(func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	err = handler(e.NewContext(req, httptest.NewRecorder()))
	if he, ok := err.(*echo.HTTPError); !ok || he.Code != http.StatusUnauthorized {
		t.Fatalf("scoped token accepted: %v", err)
	}
}

func TestPreviewTokenExpiry(t *testing.T) {
	signer, _ := auth.NewSigner("test-secret")
	login := time.Now().Add(time.Hour)
	token, _ := signer.IssuePreview(uuid.New(), uuid.New(), login)
	claims, err := signer.Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.ExpiresAt.After(login) {
		t.Fatalf("preview token outlives its login token: %v > %v", claims.ExpiresAt, login)
	}
	if claims.Scope != auth.ScopePreview {
		t.Fatalf("scope = %q", claims.Scope)
	}
}

func TestReservedPorts(t *testing.T) {
	for _, p := range []int{1114, 1115} {
		if !reservedPort(p) {
			t.Errorf("port %d should be reserved", p)
		}
	}
	if reservedPort(5173) {
		t.Error("5173 should be previewable")
	}
}

func TestPreviewTarget(t *testing.T) {
	const pid = "f210c5c5-643d-44c7-b590-e6694a0bdbe4"
	e := echo.New()
	target := func(referer, cookie string) string {
		req := httptest.NewRequest(http.MethodGet, "http://cattery:8080/src/main.js", nil)
		if referer != "" {
			req.Header.Set("Referer", referer)
		}
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: previewTargetCookie, Value: cookie})
		}
		projectID, port, ok := previewTarget(e.NewContext(req, httptest.NewRecorder()))
		if !ok {
			return ""
		}
		return projectID + ":" + port
	}
	// The page's Referer wins over the last opened preview.
	if got := target("http://cattery:8080/api/v1/projects/"+pid+"/ports/5173/", pid+":3000"); got != pid+":5173" {
		t.Errorf("referer target = %q", got)
	}
	// Module and stylesheet requests refer to root-relative URLs.
	if got := target("http://cattery:8080/src/App.vue", pid+":3000"); got != pid+":3000" {
		t.Errorf("cookie target = %q", got)
	}
	// Another site's Referer names nothing.
	if got := target("http://elsewhere/api/v1/projects/"+pid+"/ports/5173/", ""); got != "" {
		t.Errorf("foreign referer target = %q", got)
	}
	if got := target("", "not-a-project:1"); got != "" {
		t.Errorf("bad cookie target = %q", got)
	}
}

func TestIsPageLoad(t *testing.T) {
	for dest, want := range map[string]bool{"document": true, "iframe": true, "script": false, "style": false, "empty": false} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		if isPageLoad(req) != want {
			t.Errorf("Sec-Fetch-Dest %s: want %v", dest, want)
		}
	}
}
