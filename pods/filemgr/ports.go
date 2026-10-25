package main

// Web servers started in the sandbox, for the preview the backend serves under
// /api/v1/projects/<id>/ports/<port>/. filemgr shares the Pod's network
// namespace with the agent container, so it reaches servers bound to
// localhost only.

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// localTransport dials localhost over IPv4, then IPv6: Node resolves
// "localhost" to ::1 first, so a dev server may listen on either.
var localTransport = &http.Transport{
	DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
		_, port, _ := net.SplitHostPort(addr)
		d := net.Dialer{Timeout: 5 * time.Second}
		conn, err := d.DialContext(ctx, "tcp4", "127.0.0.1:"+port)
		if err != nil {
			if conn6, err6 := d.DialContext(ctx, "tcp6", "[::1]:"+port); err6 == nil {
				return conn6, nil
			}
		}
		return conn, err
	},
	MaxIdleConnsPerHost: 16,
	IdleConnTimeout:     90 * time.Second,
}

// handleProxy forwards /proxy/<port>/<path> to localhost:<port>/<path>. The
// browser reaches it on the preview's own host, where the app owns every path.
func handleProxy(w http.ResponseWriter, r *http.Request) {
	portStr, tail, _ := strings.Cut(strings.TrimPrefix(r.URL.EscapedPath(), "/proxy/"), "/")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "invalid port", http.StatusBadRequest)
		return
	}
	escaped := "/" + tail
	rp := &httputil.ReverseProxy{
		Transport:     localTransport,
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&url.URL{Scheme: "http", Host: "localhost:" + strconv.Itoa(port)})
			pr.Out.URL.Path, _ = url.PathUnescape(escaped)
			pr.Out.URL.RawPath = escaped
			// Rewrite drops X-Forwarded-*; keep the backend's, which describe
			// the browser's request rather than this hop.
			for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
				if v := pr.In.Header.Values(h); len(v) > 0 {
					pr.Out.Header[h] = v
				}
			}
		},
		ModifyResponse: func(res *http.Response) error {
			if loc := res.Header.Get("Location"); loc != "" {
				res.Header.Set("Location", rewriteLocation(loc, port))
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, fmt.Sprintf("nothing is serving HTTP on port %d in the sandbox: %v", port, err), http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}

// rewriteLocation keeps redirects inside the preview: absolute URLs to the
// server itself (http://localhost:<port>/x) become root-relative.
func rewriteLocation(loc string, port int) string {
	u, err := url.Parse(loc)
	if err != nil || !u.IsAbs() {
		return loc
	}
	host := u.Hostname()
	if u.Port() != strconv.Itoa(port) || (host != "localhost" && host != "127.0.0.1" && host != "0.0.0.0" && host != "::1") {
		return loc
	}
	loc = u.RequestURI()
	if u.Fragment != "" {
		loc += "#" + u.Fragment
	}
	return loc
}
