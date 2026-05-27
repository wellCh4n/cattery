// Package api — files_handler proxies file operations to the per-project
// filemgr Pod, which mounts the project's workspace PVC at /work and exposes
// /list /read /download /upload over FileMgrPort. The Pod is created when the
// project is created; this handler also lazy-creates it as a fallback so
// existing projects (or recovered ones) get a filemgr the first time a file
// API is hit. Frontend reaches the sidecar through this proxy so it never
// needs the in-cluster Pod IP.
package api

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type FilesHandler struct {
	projects *db.ProjectStore
	k8s      *k8s.Client
}

func NewFilesHandler(projects *db.ProjectStore, k8sClient *k8s.Client) *FilesHandler {
	return &FilesHandler{projects: projects, k8s: k8sClient}
}

// fileMgrReadyTimeout caps how long a /files request can block waiting for
// the project's filemgr Pod to come up. New projects usually hit this on the
// very first request after Create — the Pod was scheduled but image pull /
// PVC binding can take a few seconds.
const fileMgrReadyTimeout = 30 * time.Second

// requireFileMgrURL verifies the caller has the requested access to
// :project_id, then returns the URL of that project's filemgr Pod. Ensures
// PVC + Pod exist (idempotent) and waits for Pod readiness.
func (h *FilesHandler) requireFileMgrURL(c echo.Context, write bool) (string, error) {
	var (
		access *model.ProjectAccess
		err    error
	)
	if write {
		access, err = requireWritableProject(c, h.projects)
	} else {
		access, err = requireReadableProject(c, h.projects)
	}
	if err != nil {
		return "", err
	}
	ctx := c.Request().Context()
	projectID := access.Project.ProjectID
	pvcName := sandbox.PVCNameForProjectID(projectID)
	if err := h.k8s.EnsurePVC(ctx, pvcName, map[string]string{
		k8s.LabelProjectID: projectID.String(),
	}); err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("ensure pvc: %v", err))
	}
	podName := sandbox.FileMgrPodNameForProject(projectID)
	if err := h.k8s.EnsureFileMgrPod(ctx, k8s.FileMgrPodSpec{
		Name:      podName,
		ProjectID: projectID.String(),
		PVCName:   pvcName,
		Image:     sandbox.FileMgrImage,
		Port:      sandbox.FileMgrPort,
	}); err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("ensure filemgr: %v", err))
	}
	ip, err := h.k8s.WaitPodReady(ctx, podName, fileMgrReadyTimeout)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusServiceUnavailable, fmt.Sprintf("filemgr not ready: %v", err))
	}
	return (&url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("%s:%d", ip, sandbox.FileMgrPort),
	}).String(), nil
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
// (images, etc.). Same as Download except the sidecar sets a sniffed
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
// multipart body. We forward Content-Type so the sidecar can parse the
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

func (h *FilesHandler) proxyGET(c echo.Context, sidecarPath string) error {
	return h.proxyGETRawQuery(c, sidecarPath, c.Request().URL.RawQuery)
}

func (h *FilesHandler) proxyGETRawQuery(c echo.Context, sidecarPath string, rawQuery string) error {
	base, err := h.requireFileMgrURL(c, false)
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
