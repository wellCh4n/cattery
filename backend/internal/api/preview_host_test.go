package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
)

func TestNewPreviewHosts(t *testing.T) {
	for template, want := range map[string]string{
		"http://*.localhost:8080":           "http://*.localhost:8080",
		"https://*.Preview.Example.com/":    "https://*.preview.example.com",
		"https://*.preview.example.com:443": "https://*.preview.example.com:443",
	} {
		hosts, err := NewPreviewHosts(template)
		if err != nil {
			t.Errorf("NewPreviewHosts(%q): %v", template, err)
		} else if hosts.Template() != want {
			t.Errorf("NewPreviewHosts(%q) = %q, want %q", template, hosts.Template(), want)
		}
	}
	for _, bad := range []string{"", "localhost:8080", "http://localhost:8080", "ftp://*.x", "http://*.x/path", "http://*."} {
		if _, err := NewPreviewHosts(bad); err == nil {
			t.Errorf("NewPreviewHosts(%q) accepted", bad)
		}
	}
}

func TestPreviewHostTarget(t *testing.T) {
	const pid = "77d27c51-c988-4dae-a7e3-0722b7c7ec9c"
	hosts, _ := NewPreviewHosts("http://*.localhost:8080")
	for host, want := range map[string]string{
		"5173-" + pid + ".localhost:8080": pid + ":5173",
		"5173-" + pid + ".LOCALHOST":      pid + ":5173",
		"localhost:8080":                  "",
		"5173-" + pid + ".a.localhost":    "",
		"x5173-" + pid + ".localhost":     "",
		"5173-not-a-uuid.localhost":       "",
		"5173-" + pid + ".localhost.evil": "",
		"5173-" + pid + ".example.com":    "",
	} {
		projectID, port, ok := hosts.Target(host)
		got := ""
		if ok {
			got = projectID + ":" + port
		}
		if got != want {
			t.Errorf("Target(%q) = %q, want %q", host, got, want)
		}
	}
}

// A preview host belongs to the previewed app: the backend's own routes are
// unreachable there, and a request without the preview sign-in is refused.
func TestServeHostOwnsPreviewHosts(t *testing.T) {
	const pid = "77d27c51-c988-4dae-a7e3-0722b7c7ec9c"
	hosts, _ := NewPreviewHosts("http://*.localhost:8080")
	signer, _ := auth.NewSigner("test-secret")
	h := &PortsHandler{signer: signer, hosts: hosts}
	e := echo.New()
	e.Use(h.ServeHost)
	e.GET("/api/v1/projects", func(c echo.Context) error { return c.String(http.StatusOK, "api") })

	serve := func(host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	if rec := serve("localhost:8080"); rec.Code != http.StatusOK || rec.Body.String() != "api" {
		t.Fatalf("backend host: %d %s", rec.Code, rec.Body)
	}
	if rec := serve("5173-" + pid + ".localhost:8080"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("preview host reached %d %s", rec.Code, rec.Body)
	}
}
