// Package api — files_handler proxies file operations to the filemgr sidecar
// running inside each harness Pod. The sidecar exposes /list /read /download
// /upload on FileMgrPort and shares /work with the harness container; the
// frontend reaches them through this handler so it never needs the in-cluster
// pod IP.
package api

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type FilesHandler struct {
	store *db.HarnessStore
}

func NewFilesHandler(store *db.HarnessStore) *FilesHandler {
	return &FilesHandler{store: store}
}

// resolveFileMgrURL looks up the harness, makes sure its sandbox is ready, and
// derives the filemgr base URL by swapping the harness port for FileMgrPort.
// Both containers share the same pod IP so we only need a port substitution.
func (h *FilesHandler) resolveFileMgrURL(c echo.Context) (string, error) {
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return "", echo.NewHTTPError(http.StatusBadRequest, "invalid harness_id")
	}
	inst, err := h.store.GetByID(c.Request().Context(), id)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	if inst.SandboxURL == nil || inst.SandboxStatus != "ready" {
		return "", echo.NewHTTPError(http.StatusServiceUnavailable, "sandbox not ready")
	}
	u, err := url.Parse(*inst.SandboxURL)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, "invalid sandbox url")
	}
	host := u.Hostname()
	u.Host = fmt.Sprintf("%s:%d", host, sandbox.FileMgrPort)
	return u.String(), nil
}

// List proxies GET /harnesses/:id/files/list?path=...
func (h *FilesHandler) List(c echo.Context) error {
	return h.proxyGET(c, "/list")
}

// Read proxies GET /harnesses/:id/files/read?path=...
func (h *FilesHandler) Read(c echo.Context) error {
	return h.proxyGET(c, "/read")
}

// Download proxies GET /harnesses/:id/files/download?path=...
// Streams the response back as-is, including Content-Disposition.
func (h *FilesHandler) Download(c echo.Context) error {
	return h.proxyGET(c, "/download")
}

// Raw proxies GET /harnesses/:id/files/raw?path=... for inline media preview
// (images, etc.). Same as Download except the sidecar sets a sniffed
// Content-Type and omits Content-Disposition.
func (h *FilesHandler) Raw(c echo.Context) error {
	return h.proxyGET(c, "/raw")
}

// RawPath proxies GET /harnesses/:id/files/raw-path/<path> as /raw?path=<path>.
// It exists so HTML previews have a path-like base URL and relative assets
// such as ./style.css resolve to neighboring files in the same sandbox dir.
func (h *FilesHandler) RawPath(c echo.Context) error {
	path := "/" + strings.TrimPrefix(c.Param("*"), "/")
	if path == "/" {
		return echo.NewHTTPError(http.StatusBadRequest, "missing path")
	}
	query := url.Values{}
	query.Set("path", path)
	if raw := c.Request().URL.RawQuery; raw != "" {
		if existing, err := url.ParseQuery(raw); err == nil {
			for key, values := range existing {
				if key == "path" {
					continue
				}
				for _, value := range values {
					query.Add(key, value)
				}
			}
		}
	}
	return h.proxyGETRawQuery(c, "/raw", query.Encode())
}

// Upload proxies POST /harnesses/:id/files/upload?path=... with the original
// multipart body. We forward Content-Type so the sidecar can parse the
// multipart boundary the client picked.
func (h *FilesHandler) Upload(c echo.Context) error {
	base, err := h.resolveFileMgrURL(c)
	if err != nil {
		return err
	}
	target := base + "/upload?" + c.Request().URL.RawQuery
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, target, c.Request().Body)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if ct := c.Request().Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if cl := c.Request().Header.Get("Content-Length"); cl != "" {
		req.Header.Set("Content-Length", cl)
	}
	req.ContentLength = c.Request().ContentLength
	return forward(c, req)
}

func (h *FilesHandler) proxyGET(c echo.Context, sidecarPath string) error {
	return h.proxyGETRawQuery(c, sidecarPath, c.Request().URL.RawQuery)
}

func (h *FilesHandler) proxyGETRawQuery(c echo.Context, sidecarPath string, rawQuery string) error {
	base, err := h.resolveFileMgrURL(c)
	if err != nil {
		return err
	}
	target := base + sidecarPath
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, target, nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return forward(c, req)
}

// forward sends req upstream and streams the response back to c. Copies
// content-related headers so binary downloads, JSON, and errors all pass
// through correctly.
func forward(c echo.Context, req *http.Request) error {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Disposition"} {
		if v := resp.Header.Get(h); v != "" {
			c.Response().Header().Set(h, v)
		}
	}
	c.Response().WriteHeader(resp.StatusCode)
	_, _ = io.Copy(c.Response().Writer, resp.Body)
	return nil
}
