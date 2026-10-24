package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRewriteLocation(t *testing.T) {
	const prefix = "/api/v1/projects/p/ports/5173"
	for loc, want := range map[string]string{
		"/about":                      prefix + "/about",
		prefix + "/":                  prefix + "/",
		"http://localhost:5173/x?a=1": prefix + "/x?a=1",
		"http://127.0.0.1:5173/":      prefix + "/",
		"https://example.com/x":       "https://example.com/x",
		"http://localhost:3000/x":     "http://localhost:3000/x",
		"relative/path":               "relative/path",
		"//cdn.example.com/a.js":      "//cdn.example.com/a.js",
	} {
		if got := rewriteLocation(loc, 5173, prefix); got != want {
			t.Errorf("rewriteLocation(%q) = %q, want %q", loc, got, want)
		}
	}
}

// proxyGet requests path through handleProxy for the server at srv.
func proxyGet(t *testing.T, srv *httptest.Server, prefixFor func(port string) string, path string) (*http.Response, string) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+u.Port()+path, nil)
	req.Header.Set("X-Forwarded-Prefix", prefixFor(u.Port()))
	rec := httptest.NewRecorder()
	handleProxy(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestProxyStripsPrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/new", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "path "+r.URL.Path)
	}))
	defer srv.Close()
	prefixFor := func(port string) string { return "/api/v1/projects/p/ports/" + port }
	if res, body := proxyGet(t, srv, prefixFor, "/style.css"); res.StatusCode != 200 || body != "path /style.css" {
		t.Fatalf("got %d %q", res.StatusCode, body)
	}
	u, _ := url.Parse(srv.URL)
	if res, _ := proxyGet(t, srv, prefixFor, "/old"); res.Header.Get("Location") != prefixFor(u.Port())+"/new" {
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
