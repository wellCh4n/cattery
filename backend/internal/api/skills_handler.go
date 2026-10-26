// Package api — skills_handler proxies the global skill library to the single,
// cluster-wide skillmgr Pod, which mounts the global skills PVC at /skills.
// Unlike files_handler this is NOT per-project:
// skills are a global resource managed independently of any project selection,
// so there is one skillmgr for the whole cluster and no :project_id in the
// path. The Pod is lazy-created on the first /skills request and the frontend reaches it only through this proxy.
//
// Skills are not loaded into sandboxes from the library: a project member
// installs one, which copies it into the project's ~/.agents/skills (Install),
// or uploads a zip straight there (UploadToProject).
//
// Auth: every signed-in user can browse the library; changing it (upload,
// delete, rename, mkdir) is admin-only, enforced in the router.
package api

import (
	"archive/zip"
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type SkillsHandler struct {
	k8s           *k8s.Client
	projects      *db.ProjectStore
	sandbox       *sandbox.Manager
	skillMgrImage string
}

func NewSkillsHandler(k8sClient *k8s.Client, projects *db.ProjectStore, sandboxMgr *sandbox.Manager, skillMgrImage string) *SkillsHandler {
	return &SkillsHandler{k8s: k8sClient, projects: projects, sandbox: sandboxMgr, skillMgrImage: skillMgrImage}
}

// ProjectSkillsDir is where installed skills live, relative to the project
// workspace (the agent's home). pi loads skills from it.
const ProjectSkillsDir = "/.agents/skills"

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
	if err := h.k8s.EnsurePVC(ctx, sandbox.SkillsPVCName, k8s.ComponentSkills, nil); err != nil {
		return "", echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("ensure skills pvc: %v", err))
	}
	if err := h.k8s.EnsureSkillMgrPod(ctx, k8s.SkillMgrPodSpec{
		Name:    sandbox.SkillMgrPodName,
		PVCName: sandbox.SkillsPVCName,
		Image:   h.skillMgrImage,
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

// Catalog proxies GET /skills/catalog — the skill-centric library view: one
// entry per top-level skill folder, with name/description parsed from each
// SKILL.md frontmatter. Distinct from /list, which is the raw file tree.
func (h *SkillsHandler) Catalog(c echo.Context) error {
	return h.proxyGET(c, "/catalog")
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

// Install handles POST /projects/:project_id/skills/:slug: it copies the
// library's <slug>/ folder into the project's ~/.agents/skills/<slug>,
// replacing an installed copy. skillmgr's tar stream is piped straight into
// the project's agent, which swaps the folder in only once the archive is
// complete.
func (h *SkillsHandler) Install(c echo.Context) error {
	slug := c.Param("slug")
	if slug == "" || strings.HasPrefix(slug, ".") || strings.ContainsAny(slug, `/\`) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid skill")
	}
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	mgr, err := h.requireSkillMgrURL(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	files, err := h.sandbox.FileURL(ctx, access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}

	archiveReq, err := http.NewRequestWithContext(ctx, http.MethodGet, mgr+"/archive?path="+url.QueryEscape("/"+slug), nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	archive, err := http.DefaultClient.Do(archiveReq)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, err.Error())
	}
	defer archive.Body.Close()
	if archive.StatusCode != http.StatusOK {
		return forwardResponse(c, archive)
	}

	extractReq, err := http.NewRequestWithContext(ctx, http.MethodPost, files+"/extract?path="+url.QueryEscape(ProjectSkillsDir+"/"+slug), archive.Body)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	extractReq.Header.Set("Content-Type", "application/x-tar")
	return forward(c, extractReq)
}

// maxProjectSkillZip caps a project skill upload. The archive is converted
// in memory, and skills are small.
const maxProjectSkillZip = 32 << 20

// UploadToProject handles POST /projects/:project_id/skills: a multipart form
// whose "file" field is a `<slug>.zip` skill archive. The skill goes straight
// into the project's ~/.agents/skills/<slug>, replacing a folder of that name,
// and never into the global library, which only admins change.
func (h *SkillsHandler) UploadToProject(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	c.Request().Body = http.MaxBytesReader(c.Response(), c.Request().Body, maxProjectSkillZip+1<<20)
	header, err := c.FormFile("file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "missing zip file")
	}
	if header.Size > maxProjectSkillZip {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "skill archive is too large")
	}
	slug, err := skillSlugFromZip(header.Filename)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	f, err := header.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	defer f.Close()
	zr, err := zip.NewReader(f, header.Size)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid zip: "+err.Error())
	}
	var archive bytes.Buffer
	if err := skillZipToTar(zr, slug, &archive); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	ctx := c.Request().Context()
	files, err := h.sandbox.FileURL(ctx, access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, files+"/extract?path="+url.QueryEscape(ProjectSkillsDir+"/"+slug), &archive)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	req.Header.Set("Content-Type", "application/x-tar")
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
