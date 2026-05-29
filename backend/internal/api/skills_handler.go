// Package api — skills_handler proxies the global skill library to the single,
// cluster-wide skillmgr Pod, which mounts the global skills PVC at /skills.
// Unlike files_handler this is NOT per-project:
// skills are a global resource managed independently of any project selection,
// so there is one skillmgr for the whole cluster and no :project_id in the
// path. The Pod is lazy-created on the first /skills request (mirroring
// filemgr's fallback) and the frontend reaches it only through this proxy.
//
// Auth: routes sit under the authenticated group but are intentionally NOT
// admin-gated for now — permissions are deferred.
package api

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type SkillsHandler struct {
	k8s *k8s.Client
}

func NewSkillsHandler(k8sClient *k8s.Client) *SkillsHandler {
	return &SkillsHandler{k8s: k8sClient}
}

// skillMgrReadyTimeout caps how long a /skills request blocks waiting for the
// global skillmgr Pod to come up. The first request after a cold start hits
// this while the image pulls and the PVC binds.
const skillMgrReadyTimeout = 30 * time.Second

// requireSkillMgrURL ensures the global skills PVC + skillmgr Pod exist
// (idempotent), waits for readiness, and returns the Pod's base URL. No
// project access check — the library is global.
func (h *SkillsHandler) requireSkillMgrURL(c echo.Context) (string, error) {
	if _, ok := UserIDFromContext(c); !ok {
		return "", echo.ErrUnauthorized
	}
	ctx := c.Request().Context()
	if err := h.k8s.EnsurePVC(ctx, sandbox.SkillsPVCName, map[string]string{
		k8s.LabelComponent: "skillmgr",
	}); err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("ensure skills pvc: %v", err))
	}
	if err := h.k8s.EnsureSkillMgrPod(ctx, k8s.SkillMgrPodSpec{
		Name:    sandbox.SkillMgrPodName,
		PVCName: sandbox.SkillsPVCName,
		Image:   sandbox.SkillMgrImage,
		Port:    sandbox.SkillMgrPort,
	}); err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("ensure skillmgr: %v", err))
	}
	ip, err := h.k8s.WaitPodReady(ctx, sandbox.SkillMgrPodName, skillMgrReadyTimeout)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusServiceUnavailable, fmt.Sprintf("skillmgr not ready: %v", err))
	}
	return (&url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("%s:%d", ip, sandbox.SkillMgrPort),
	}).String(), nil
}

// List proxies GET /skills/list?path=...
func (h *SkillsHandler) List(c echo.Context) error {
	return h.proxyGET(c, "/list")
}

// Read proxies GET /skills/read?path=...
func (h *SkillsHandler) Read(c echo.Context) error {
	return h.proxyGET(c, "/read")
}

// UploadZip proxies POST /skills/upload-zip?path=... — the body is a multipart
// form with a "file" field carrying a ZIP archive; skillmgr extracts it under
// the destination directory. Used by the SKILLS panel to drop a whole skill
// folder (`<slug>/SKILL.md (+assets)`) at once instead of per-file uploads.
func (h *SkillsHandler) UploadZip(c echo.Context) error {
	base, err := h.requireSkillMgrURL(c)
	if err != nil {
		return err
	}
	target := base + "/upload-zip?" + c.Request().URL.RawQuery
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

// Delete proxies DELETE /skills/delete?path=... — recursive for directories.
func (h *SkillsHandler) Delete(c echo.Context) error {
	base, err := h.requireSkillMgrURL(c)
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

// Rename proxies POST /skills/rename?from=...&to=... (base name in same dir).
func (h *SkillsHandler) Rename(c echo.Context) error {
	base, err := h.requireSkillMgrURL(c)
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

// Mkdir proxies POST /skills/mkdir?path=...&name=...
func (h *SkillsHandler) Mkdir(c echo.Context) error {
	base, err := h.requireSkillMgrURL(c)
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

func (h *SkillsHandler) proxyGET(c echo.Context, mgrPath string) error {
	return h.proxyGETRawQuery(c, mgrPath, c.Request().URL.RawQuery)
}

func (h *SkillsHandler) proxyGETRawQuery(c echo.Context, mgrPath string, rawQuery string) error {
	base, err := h.requireSkillMgrURL(c)
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
