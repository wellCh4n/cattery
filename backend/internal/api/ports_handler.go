// Web servers running in a project sandbox. GET /projects/:id/apps lists the
// listening apps (from the agent harness) and DELETE /projects/:id/apps/:port
// stops one. Each app is previewed on its own host, <port>-<project id>.<domain>
// (preview_host.go), proxied through filemgr, which shares the Pod network and
// so also reaches servers bound to localhost. There the app owns every path,
// so its router, reloads and dev-server sockets need no rewriting. Preview
// pages load their own assets and can't send the bearer header, so the first
// request exchanges ?cattery_token= for a cookie (not ?token=, which Vite's
// HMR socket uses).
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/sandbox"
)

const (
	// Every cookie with this prefix is Cattery's and never reaches the sandbox.
	previewCookiePrefix = "cattery_preview"
	// The sign-in for one project's previews: cattery_preview_<project id>.
	previewAuthCookie = previewCookiePrefix + "_"
	previewTokenParam = "cattery_token"
)

type PortsHandler struct {
	projects *db.ProjectStore
	sandbox  *sandbox.Manager
	signer   *auth.Signer
	// hosts names each preview's own host (PREVIEW_URL).
	hosts *PreviewHosts
}

func NewPortsHandler(projects *db.ProjectStore, sandboxMgr *sandbox.Manager, signer *auth.Signer, hosts *PreviewHosts) *PortsHandler {
	return &PortsHandler{projects: projects, sandbox: sandboxMgr, signer: signer, hosts: hosts}
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

// previewAuth authenticates a request to a preview host: ?cattery_token=
// with a login token, or the project's preview cookie. A query token on a
// page load is swapped for the cookie and removed from the URL, so the
// previewed app never sees it; the app's own Authorization header is its
// business. The web app frames the preview from another site (localhost and
// <x>.localhost are different sites), so the cookie is SameSite=None and
// partitioned by the framing site; browsers accept Secure cookies from
// http://*.localhost too.
func (h *PortsHandler) previewAuth(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		projectID, err := uuid.Parse(c.Param("project_id"))
		if err != nil {
			return echo.NewHTTPError(http.StatusNotFound, "project not found")
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
				Name:        previewAuthCookie + projectID.String(),
				Value:       preview,
				Path:        "/",
				Expires:     claims.ExpiresAt.Time,
				HttpOnly:    true,
				Secure:      true,
				SameSite:    http.SameSiteNoneMode,
				Partitioned: true,
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

// forward proxies the request, path unchanged, to the preview's port.
func (h *PortsHandler) forward(c echo.Context) error {
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
	path := req.URL.EscapedPath()
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
			// Cattery's cookies stay out of the sandbox.
			pr.Out.Header.Del("Cookie")
			for _, ck := range pr.In.Cookies() {
				if !strings.HasPrefix(ck.Name, previewCookiePrefix) {
					pr.Out.AddCookie(ck)
				}
			}
			pr.SetXForwarded()
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
