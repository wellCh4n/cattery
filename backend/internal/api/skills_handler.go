// Package api — skills_handler serves the global skill library, a directory
// on the backend's own volume (SKILLS_DIR, see package skills). Unlike
// files_handler this is NOT per-project: skills are a global resource managed
// independently of any project selection, so there is no :project_id in the
// path.
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
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/sandbox"
	"github.com/wellch4n/cattery/internal/skills"
)

type SkillsHandler struct {
	library  *skills.Library
	projects *db.ProjectStore
	sandbox  *sandbox.Manager
}

func NewSkillsHandler(library *skills.Library, projects *db.ProjectStore, sandboxMgr *sandbox.Manager) *SkillsHandler {
	return &SkillsHandler{library: library, projects: projects, sandbox: sandboxMgr}
}

// ProjectSkillsDir is where installed skills live, relative to the project
// workspace (the agent's home). pi loads skills from it.
const ProjectSkillsDir = "/.agents/skills"

// Catalog: GET /skills/catalog — the skill-centric library view: one entry per
// top-level skill folder, with name/description parsed from each SKILL.md
// frontmatter. Distinct from /list, which is the raw file tree.
func (h *SkillsHandler) Catalog(c echo.Context) error {
	h.library.Catalog(c.Response(), c.Request())
	return nil
}

// List: GET /skills/list?path=...
func (h *SkillsHandler) List(c echo.Context) error {
	h.library.List(c.Response(), c.Request())
	return nil
}

// Read: GET /skills/read?path=...
func (h *SkillsHandler) Read(c echo.Context) error {
	h.library.Read(c.Response(), c.Request())
	return nil
}

// UploadZip: POST /skills/upload-zip?path=... — the body is a multipart form
// with a "file" field carrying a `<slug>.zip`, extracted under the destination
// directory. Used to drop a whole skill folder (`<slug>/SKILL.md (+assets)`)
// at once instead of per-file uploads.
func (h *SkillsHandler) UploadZip(c echo.Context) error {
	h.library.UploadZip(c.Response(), c.Request())
	return nil
}

// Delete: DELETE /skills/delete?path=... — recursive for directories.
func (h *SkillsHandler) Delete(c echo.Context) error {
	h.library.Delete(c.Response(), c.Request())
	return nil
}

// Rename: POST /skills/rename?from=...&to=... (base name in same dir).
func (h *SkillsHandler) Rename(c echo.Context) error {
	h.library.Rename(c.Response(), c.Request())
	return nil
}

// Mkdir: POST /skills/mkdir?path=...&name=...
func (h *SkillsHandler) Mkdir(c echo.Context) error {
	h.library.Mkdir(c.Response(), c.Request())
	return nil
}

// Install handles POST /projects/:project_id/skills/:slug: it copies the
// library's <slug>/ folder into the project's ~/.agents/skills/<slug>,
// replacing an installed copy. The folder is streamed as a tar straight into
// the project's agent, which swaps it in only once the archive is complete; a
// failed read breaks the request body, so a partial copy is never installed.
func (h *SkillsHandler) Install(c echo.Context) error {
	slug := c.Param("slug")
	if slug == "" || strings.HasPrefix(slug, ".") || strings.ContainsAny(slug, `/\`) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid skill")
	}
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	dir, err := h.library.SkillDir(slug)
	if errors.Is(err, skills.ErrNoSkill) {
		return echo.NewHTTPError(http.StatusNotFound, err.Error())
	} else if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	ctx := c.Request().Context()
	files, err := h.sandbox.FileURL(ctx, access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}

	archive, w := io.Pipe()
	defer archive.Close()
	go func() { w.CloseWithError(skills.WriteArchive(dir, w)) }()
	extractReq, err := http.NewRequestWithContext(ctx, http.MethodPost, files+"/extract?path="+url.QueryEscape(ProjectSkillsDir+"/"+slug), archive)
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
	slug, err := skills.SlugFromZip(header.Filename)
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
	if err := skills.ZipToTar(zr, slug, &archive); err != nil {
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
