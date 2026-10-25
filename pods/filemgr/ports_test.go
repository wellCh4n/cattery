package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRewriteLocation(t *testing.T) {
	for loc, want := range map[string]string{
		"/about":                      "/about",
		"http://localhost:5173/x?a=1": "/x?a=1",
		"http://127.0.0.1:5173/#top":  "/#top",
		"https://example.com/x":       "https://example.com/x",
		"http://localhost:3000/x":     "http://localhost:3000/x",
		"relative/path":               "relative/path",
		"//cdn.example.com/a.js":      "//cdn.example.com/a.js",
	} {
		if got := rewriteLocation(loc, 5173); got != want {
			t.Errorf("rewriteLocation(%q) = %q, want %q", loc, got, want)
		}
	}
}

// proxyGet requests path through handleProxy for the server at srv.
func proxyGet(t *testing.T, srv *httptest.Server, path string) (*http.Response, string) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+u.Port()+path, nil)
	rec := httptest.NewRecorder()
	handleProxy(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestProxy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/new", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "path "+r.URL.Path)
	}))
	defer srv.Close()
	if res, body := proxyGet(t, srv, "/style.css"); res.StatusCode != 200 || body != "path /style.css" {
		t.Fatalf("got %d %q", res.StatusCode, body)
	}
	if res, _ := proxyGet(t, srv, "/old"); res.Header.Get("Location") != "/new" {
		t.Fatalf("redirect = %q", res.Header.Get("Location"))
	}
}

func TestProxyNothingListening(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	u, _ := url.Parse(srv.URL)
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+u.Port()+"/", nil)
	rec := httptest.NewRecorder()
	handleProxy(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}
