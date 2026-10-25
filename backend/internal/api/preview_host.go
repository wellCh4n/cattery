package api

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/labstack/echo/v4"
)

// PreviewHosts serves each preview on its own host, <port>-<project id>.<domain>,
// so the previewed app owns every path there: its router, reloads and dev
// server sockets need no guessing about which preview a request belongs to.
// The domain comes from PREVIEW_URL, a URL whose host is a wildcard:
// http://*.localhost:8080 by default (browsers resolve *.localhost to the
// machine), https://*.preview.example.com behind a wildcard DNS record and
// certificate in production.
type PreviewHosts struct {
	scheme string
	// suffix is the wildcard's domain, lowercased: ".localhost".
	suffix string
	// port is the template's port, "" for the scheme's default.
	port string
}

// NewPreviewHosts parses PREVIEW_URL.
func NewPreviewHosts(template string) (*PreviewHosts, error) {
	u, err := url.Parse(template)
	if err != nil {
		return nil, err
	}
	host := strings.ToLower(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || !strings.HasPrefix(host, "*.") || len(host) < 3 || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("PREVIEW_URL must look like http://*.localhost:8080 or https://*.preview.example.com")
	}
	return &PreviewHosts{scheme: u.Scheme, suffix: host[1:], port: u.Port()}, nil
}

// Template is PREVIEW_URL normalized, for the web app to build preview URLs.
func (p *PreviewHosts) Template() string {
	host := "*" + p.suffix
	if p.port != "" {
		host = net.JoinHostPort(host, p.port)
	}
	return p.scheme + "://" + host
}

// The host label: <port>-<project id>, which fits DNS's 63-character limit.
var previewLabelRE = regexp.MustCompile(`^(\d{1,5})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)

// Target names the preview a request's Host belongs to.
func (p *PreviewHosts) Target(hostport string) (projectID, port string, ok bool) {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.ToLower(host)
	label, found := strings.CutSuffix(host, p.suffix)
	if !found || label == "" || strings.Contains(label, ".") {
		return "", "", false
	}
	m := previewLabelRE.FindStringSubmatch(label)
	if m == nil {
		return "", "", false
	}
	return m[2], m[1], true
}

// ServeHost runs ahead of routing for the whole server: a request to a
// preview host is that preview's, whatever its path, so none of the backend's
// own routes (or its CORS handling) apply there. Other hosts pass through.
func (h *PortsHandler) ServeHost(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		projectID, port, ok := h.hosts.Target(c.Request().Host)
		if !ok {
			return next(c)
		}
		c.SetParamNames("project_id", "port")
		c.SetParamValues(projectID, port)
		return h.previewAuth(h.forward)(c)
	}
}

// IsPreviewHost reports a request to a preview host, for the access log.
func (h *PortsHandler) IsPreviewHost(host string) bool {
	_, _, ok := h.hosts.Target(host)
	return ok
}

// Config handles GET /config: what the web app needs to open previews.
// preview_url is the host template.
func (h *PortsHandler) Config(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{"preview_url": h.hosts.Template()})
}
