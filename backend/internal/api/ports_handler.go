// Web servers running in a project sandbox. GET /projects/:id/apps lists the
// listening apps (from the agent harness) and DELETE /projects/:id/apps/:port
// stops one; /projects/:id/ports/:port/* previews one, proxied through
// filemgr, which shares the Pod network and so also reaches servers bound to
// localhost. Preview pages load their own assets and can't send the bearer
// header, so the first request exchanges ?cattery_token= for a cookie
// (not ?token=, which Vite's HMR socket uses).
//
// Previewed apps run unmodified, so their root-relative URLs (/src/main.js,
// /@vite/client, an HMR socket on /) leave the preview path. The backend's own
// routes all live under /api/v1, so Fallback takes every other path on this
// origin to a preview: the one in the Referer, else the last preview page this
// browser opened.
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/sandbox"
)

const (
	// Cookies are Path=/ so they reach root-relative requests too. Every
	// cookie with this prefix is Cattery's and never reaches the sandbox.
	previewCookiePrefix = "cattery_preview"
	// The sign-in for one project's previews: cattery_preview_<project id>.
	previewAuthCookie = previewCookiePrefix + "_"
	// "<project id>:<port>" of the last preview page opened, for Fallback.
	previewTargetCookie = previewCookiePrefix + "-target"
	previewTokenParam   = "cattery_token"
)

var previewPathRE = regexp.MustCompile(`^/api/v1/projects/([0-9a-fA-F-]{36})/ports/(\d+)(?:/|$)`)

type PortsHandler struct {
	projects *db.ProjectStore
	sandbox  *sandbox.Manager
	signer   *auth.Signer
}

func NewPortsHandler(projects *db.ProjectStore, sandboxMgr *sandbox.Manager, signer *auth.Signer) *PortsHandler {
	return &PortsHandler{projects: projects, sandbox: sandboxMgr, signer: signer}
}

// The agent and filemgr APIs are internal: a preview of them would let any
// member drive other members' sessions.
func reservedPort(port int) bool {
	return port == sandbox.Port || port == sandbox.FileMgrPort
}

// listeningApp is one entry of GET /projects/:id/apps.
type listeningApp struct {
	Port int `json:"port"`
	// The process holding the socket, when the agent container can see it.
	PID       int    `json:"pid,omitempty"`
	Command   string `json:"command,omitempty"`
	StartedAt string `json:"started_at,omitempty"`
}

// List returns the servers listening in the sandbox, without the platform's
// own ports. The agent harness reads them: it shares the PID namespace of
// everything started in the agent container, so it can name each process.
// A sandbox whose agent isn't up runs no apps.
func (h *PortsHandler) List(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	out := []listeningApp{}
	base, ok := h.sandbox.URL(c.Request().Context(), access.Project.ProjectID)
	if !ok {
		return c.JSON(http.StatusOK, out)
	}
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, base+"/ports", nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("agent ports status %d", resp.StatusCode))
	}
	var apps []struct {
		Port      int    `json:"port"`
		PID       int    `json:"pid"`
		Command   string `json:"command"`
		StartedAt string `json:"startedAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apps); err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	for _, a := range apps {
		if !reservedPort(a.Port) {
			out = append(out, listeningApp{Port: a.Port, PID: a.PID, Command: a.Command, StartedAt: a.StartedAt})
		}
	}
	return c.JSON(http.StatusOK, out)
}

// Stop ends the process serving :port in the sandbox. The agent looks the
// process up itself and sends SIGTERM, then SIGKILL after a grace period.
func (h *PortsHandler) Stop(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	port, err := strconv.Atoi(c.Param("port"))
	if err != nil || port < 1 || port > 65535 || reservedPort(port) {
		return echo.NewHTTPError(http.StatusNotFound, "no app on this port")
	}
	base, ok := h.sandbox.URL(c.Request().Context(), access.Project.ProjectID)
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "the sandbox isn't running")
	}
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodDelete, fmt.Sprintf("%s/ports/%d", base, port), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	defer resp.Body.Close()
	var body struct {
		Forced bool   `json:"forced"`
		Error  string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	switch {
	case resp.StatusCode == http.StatusOK:
		return c.JSON(http.StatusOK, echo.Map{"forced": body.Forced})
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden:
		return echo.NewHTTPError(resp.StatusCode, body.Error)
	default:
		return echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("agent stop status %d: %s", resp.StatusCode, body.Error))
	}
}

func previewPrefix(projectID, port string) string {
	return "/api/v1/projects/" + projectID + "/ports/" + port
}

// PreviewAuth authenticates preview requests: a login token in the
// Authorization header or ?cattery_token=, or the project's preview cookie. A
// query token on a page load is swapped for the cookie and removed from the
// URL, so the previewed app never sees it.
func (h *PortsHandler) PreviewAuth(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		projectID, err := uuid.Parse(c.Param("project_id"))
		if err != nil {
			return echo.NewHTTPError(http.StatusNotFound, "project not found")
		}
		if token := extractBearer(c.Request().Header.Get("Authorization")); token != "" {
			claims, err := h.signer.Verify(token)
			if err != nil || claims.Scope != "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			c.Set(ctxUserID, claims.UserID)
			return next(c)
		}
		if token := c.QueryParam(previewTokenParam); token != "" {
			claims, err := h.signer.Verify(token)
			if err != nil || claims.Scope != "" {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid token")
			}
			c.Set(ctxUserID, claims.UserID)
			if _, err := requireReadableProject(c, h.projects); err != nil {
				return err
			}
			preview, err := h.signer.IssuePreview(claims.UserID, projectID, claims.ExpiresAt.Time)
			if err != nil {
				return err
			}
			c.SetCookie(&http.Cookie{
				Name:     previewAuthCookie + projectID.String(),
				Value:    preview,
				Path:     "/",
				Expires:  claims.ExpiresAt.Time,
				HttpOnly: true,
				Secure:   c.Scheme() == "https",
				SameSite: http.SameSiteLaxMode,
			})
			req := c.Request()
			if req.Method != http.MethodGet && req.Method != http.MethodHead {
				return next(c)
			}
			u := *req.URL
			q := u.Query()
			q.Del(previewTokenParam)
			u.RawQuery = q.Encode()
			return c.Redirect(http.StatusFound, u.RequestURI())
		}
		cookie, err := c.Cookie(previewAuthCookie + projectID.String())
		if err != nil {
			return echo.NewHTTPError(http.StatusUnauthorized, "open this preview from Cattery to sign in")
		}
		claims, err := h.signer.Verify(cookie.Value)
		if err != nil || claims.Scope != auth.ScopePreview || claims.ProjectID != projectID.String() {
			return echo.NewHTTPError(http.StatusUnauthorized, "preview sign-in expired; open it from Cattery again")
		}
		c.Set(ctxUserID, claims.UserID)
		return next(c)
	}
}

// Proxy forwards /projects/:id/ports/:port/* to the server on that port.
func (h *PortsHandler) Proxy(c echo.Context) error {
	req := c.Request()
	prefix := previewPrefix(c.Param("project_id"), c.Param("port"))
	if !strings.HasPrefix(req.URL.EscapedPath(), prefix+"/") {
		// Pages resolve relative URLs against the directory, so the preview
		// root needs its trailing slash.
		u := *req.URL
		u.Path, u.RawPath = prefix+"/", ""
		return c.Redirect(http.StatusFound, u.RequestURI())
	}
	if isPageLoad(req) {
		c.SetCookie(&http.Cookie{
			Name:     previewTargetCookie,
			Value:    c.Param("project_id") + ":" + c.Param("port"),
			Path:     "/",
			HttpOnly: true,
			Secure:   c.Scheme() == "https",
			SameSite: http.SameSiteLaxMode,
		})
	}
	return h.forward(c, strings.TrimPrefix(req.URL.EscapedPath(), prefix))
}

// Fallback serves a request outside the backend's routes as part of a
// preview, with its path unchanged.
func (h *PortsHandler) Fallback(c echo.Context) error {
	projectID, port, ok := previewTarget(c)
	if !ok {
		return echo.ErrNotFound
	}
	c.SetParamNames("project_id", "port")
	c.SetParamValues(projectID, port)
	return h.PreviewAuth(func(c echo.Context) error {
		return h.forward(c, c.Request().URL.EscapedPath())
	})(c)
}

// previewTarget picks the preview a root-relative request belongs to.
func previewTarget(c echo.Context) (projectID, port string, ok bool) {
	if ref, err := url.Parse(c.Request().Referer()); err == nil && ref.Host == c.Request().Host {
		if m := previewPathRE.FindStringSubmatch(ref.EscapedPath()); m != nil {
			return m[1], m[2], true
		}
	}
	if cookie, err := c.Cookie(previewTargetCookie); err == nil {
		projectID, port, ok = strings.Cut(cookie.Value, ":")
		if _, err := uuid.Parse(projectID); ok && err == nil {
			return projectID, port, true
		}
	}
	return "", "", false
}

// isPageLoad reports a document or frame navigation, as opposed to the page's
// own requests.
func isPageLoad(req *http.Request) bool {
	if dest := req.Header.Get("Sec-Fetch-Dest"); dest != "" {
		return dest == "document" || dest == "iframe"
	}
	return req.Method == http.MethodGet && strings.Contains(req.Header.Get("Accept"), "text/html")
}

// forward proxies the request to path on the preview's port.
func (h *PortsHandler) forward(c echo.Context, path string) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	port, err := strconv.Atoi(c.Param("port"))
	if err != nil || port < 1 || port > 65535 || reservedPort(port) {
		return echo.NewHTTPError(http.StatusNotFound, "no preview for this port")
	}
	req := c.Request()
	base, err := h.sandbox.FileURL(req.Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}
	target, err := url.Parse(base)
	if err != nil {
		return err
	}
	prefix := previewPrefix(access.Project.ProjectID.String(), strconv.Itoa(port))
	rp := &httputil.ReverseProxy{
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			escaped := fmt.Sprintf("/proxy/%d%s", port, path)
			pr.Out.URL.Path, _ = url.PathUnescape(escaped)
			pr.Out.URL.RawPath = escaped
			q := pr.Out.URL.Query()
			if q.Has(previewTokenParam) {
				q.Del(previewTokenParam)
				pr.Out.URL.RawQuery = q.Encode()
			}
			// Cattery's credentials stay out of the sandbox.
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Cookie")
			for _, ck := range pr.In.Cookies() {
				if !strings.HasPrefix(ck.Name, previewCookiePrefix) {
					pr.Out.AddCookie(ck)
				}
			}
			pr.SetXForwarded()
			// filemgr keeps the app's redirects under the preview path.
			pr.Out.Header.Set("X-Forwarded-Prefix", prefix)
		},
		ModifyResponse: func(res *http.Response) error {
			// The app can't replace Cattery's cookies.
			cookies := res.Header.Values("Set-Cookie")
			res.Header.Del("Set-Cookie")
			for _, v := range cookies {
				if !strings.HasPrefix(strings.TrimSpace(v), previewCookiePrefix) {
					res.Header.Add("Set-Cookie", v)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, err.Error(), http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(c.Response(), req)
	return nil
}
