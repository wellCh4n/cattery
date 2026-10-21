// File operations proxy to the filemgr container in the shared project Pod.
package api

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type FilesHandler struct {
	projects *db.ProjectStore
	sandbox  *sandbox.Manager
}

func NewFilesHandler(projects *db.ProjectStore, sandboxMgr *sandbox.Manager) *FilesHandler {
	return &FilesHandler{projects: projects, sandbox: sandboxMgr}
}

// File requests wait only for the filemgr container in the shared project Pod.
func (h *FilesHandler) requireFileMgrURL(c echo.Context, write bool) (string, error) {
	var access *model.ProjectAccess
	var err error
	if write {
		access, err = requireWritableProject(c, h.projects)
	} else {
		access, err = requireReadableProject(c, h.projects)
	}
	if err != nil {
		return "", err
	}
	url, err := h.sandbox.FileURL(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}
	return url, nil
}

// List proxies GET /projects/:id/files/list?path=...
func (h *FilesHandler) List(c echo.Context) error {
	return h.proxyGET(c, "/list")
}

// Read proxies GET /projects/:id/files/read?path=...
func (h *FilesHandler) Read(c echo.Context) error {
	return h.proxyGET(c, "/read")
}

// Download proxies GET /projects/:id/files/download?path=...
// Streams the response back as-is, including Content-Disposition.
func (h *FilesHandler) Download(c echo.Context) error {
	return h.proxyGET(c, "/download")
}

// Raw proxies GET /projects/:id/files/raw?path=... for inline media preview
// (images, etc.). Same as Download except filemgr sets a sniffed
// Content-Type and omits Content-Disposition.
func (h *FilesHandler) Raw(c echo.Context) error {
	return h.proxyGET(c, "/raw")
}

// RawPath proxies GET /projects/:id/files/raw-path/<path> as /raw?path=<path>.
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

// Upload proxies POST /projects/:id/files/upload?path=... with the original
// multipart body. We forward Content-Type so filemgr can parse the
// multipart boundary the client picked.
func (h *FilesHandler) Upload(c echo.Context) error {
	base, err := h.requireFileMgrURL(c, true)
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

// Delete proxies DELETE /projects/:id/files/delete?path=... — hard delete,
// no trash. Recursive for directories. Writers only.
func (h *FilesHandler) Delete(c echo.Context) error {
	base, err := h.requireFileMgrURL(c, true)
	if err != nil {
		return err
	}
	target := base + "/delete?" + c.Request().URL.RawQuery
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodDelete, target, nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return forward(c, req)
}

// Rename proxies POST /projects/:id/files/rename?from=...&to=... where `to`
// is a base name in the same parent directory. Writers only.
func (h *FilesHandler) Rename(c echo.Context) error {
	base, err := h.requireFileMgrURL(c, true)
	if err != nil {
		return err
	}
	target := base + "/rename?" + c.Request().URL.RawQuery
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, target, nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return forward(c, req)
}

// Move proxies POST /projects/:id/files/move?from=...&to=... where `to` is a
// destination *directory* under root. The source keeps its base name in the
// new parent. Writers only.
func (h *FilesHandler) Move(c echo.Context) error {
	base, err := h.requireFileMgrURL(c, true)
	if err != nil {
		return err
	}
	target := base + "/move?" + c.Request().URL.RawQuery
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, target, nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return forward(c, req)
}

// Mkdir proxies POST /projects/:id/files/mkdir?path=...&name=... where `name`
// is a base name created inside the parent dir `path`. Writers only.
func (h *FilesHandler) Mkdir(c echo.Context) error {
	base, err := h.requireFileMgrURL(c, true)
	if err != nil {
		return err
	}
	target := base + "/mkdir?" + c.Request().URL.RawQuery
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, target, nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return forward(c, req)
}

func (h *FilesHandler) proxyGET(c echo.Context, mgrPath string) error {
	return h.proxyGETRawQuery(c, mgrPath, c.Request().URL.RawQuery)
}

func (h *FilesHandler) proxyGETRawQuery(c echo.Context, mgrPath string, rawQuery string) error {
	base, err := h.requireFileMgrURL(c, false)
	if err != nil {
		return err
	}
	target := base + mgrPath
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

// Latex reads cached preview status or explicitly compiles a document.
func (h *FilesHandler) Latex(c echo.Context) error {
	if c.Request().Method == http.MethodGet {
		return h.proxyGET(c, "/latex")
	}
	base, err := h.requireFileMgrURL(c, true)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, base+"/latex?"+c.Request().URL.RawQuery, nil)
	if err != nil {
		return err
	}
	return forward(c, req)
}
