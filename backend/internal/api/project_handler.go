package api

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/live"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type ProjectHandler struct {
	projects *db.ProjectStore
	members  *db.MemberStore
	users    *db.UserStore
	sandbox  *sandbox.Manager
	k8s      *k8s.Client
	live     *live.Hub
}

func NewProjectHandler(projects *db.ProjectStore, members *db.MemberStore, users *db.UserStore, sandboxMgr *sandbox.Manager, k8sClient *k8s.Client, hub *live.Hub) *ProjectHandler {
	return &ProjectHandler{projects: projects, members: members, users: users, sandbox: sandboxMgr, k8s: k8sClient, live: hub}
}

type projectDTO struct {
	*model.Project
	AccessRole         string `json:"access_role"`
	OwnerUsername      string `json:"owner_username"`
	OwnerName          string `json:"owner_name"`
	OwnerAvatarVersion string `json:"owner_avatar_version"`
}

func toProjectDTO(access *model.ProjectAccess) *projectDTO {
	return &projectDTO{
		Project:            access.Project,
		AccessRole:         access.AccessRole,
		OwnerUsername:      access.OwnerUsername,
		OwnerName:          access.OwnerName,
		OwnerAvatarVersion: access.OwnerAvatarVersion,
	}
}

type createProjectRequest struct {
	ProjectName *string `json:"project_name"`
}

func (h *ProjectHandler) Create(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	var req createProjectRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	project := &model.Project{
		ProjectID:   uuid.New(),
		OwnerUserID: userID,
		ProjectName: req.ProjectName,
	}
	if err := h.projects.Create(c.Request().Context(), project); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	// Provision both containers at project creation; file requests retry on failure.
	if err := h.sandbox.EnsureProject(c.Request().Context(), project.ProjectID); err != nil {
		log.Printf("warn: ensure project pod %s: %v", project.ProjectID, err)
	}
	owner, _ := h.users.GetByID(c.Request().Context(), userID)
	ownerUsername, ownerName, avatarVersion := "", "", ""
	if owner != nil {
		ownerUsername, ownerName, avatarVersion = owner.Username, owner.Name, owner.AvatarVersion
	}
	return c.JSON(http.StatusCreated, &projectDTO{Project: project, AccessRole: model.AccessOwner, OwnerUsername: ownerUsername, OwnerName: ownerName, OwnerAvatarVersion: avatarVersion})
}

func (h *ProjectHandler) List(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	projects, err := h.projects.ListAccessible(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]*projectDTO, 0, len(projects))
	for _, access := range projects {
		out = append(out, toProjectDTO(access))
	}
	return c.JSON(http.StatusOK, out)
}

func (h *ProjectHandler) Get(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, toProjectDTO(access))
}

type updateProjectRequest struct {
	ProjectName *string `json:"project_name"`
}

func (h *ProjectHandler) Update(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	var req updateProjectRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if req.ProjectName == nil {
		return echo.ErrBadRequest
	}
	if err := h.projects.UpdateNameForOwner(c.Request().Context(), access.Project.ProjectID, access.Project.OwnerUserID, *req.ProjectName); err != nil {
		if errors.Is(err, db.ErrProjectNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "project not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	updated, err := h.projects.GetAccessible(c.Request().Context(), access.Project.ProjectID, access.Project.OwnerUserID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "project not found")
	}
	return c.JSON(http.StatusOK, toProjectDTO(updated))
}

func (h *ProjectHandler) Delete(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	if err := h.sandbox.Destroy(c.Request().Context(), access.Project.ProjectID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if err := h.projects.DeleteForOwner(c.Request().Context(), access.Project.ProjectID, access.Project.OwnerUserID); err != nil {
		if errors.Is(err, db.ErrProjectNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "project not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// StopSandbox releases agent sessions but keeps the project Pod and files available.
// StartSandbox brings the project's sandbox up ahead of the first message. The
// start runs detached (a pod can take a while) and the caller polls the
// project's sandbox_status. Any member may start it — sending a message would
// anyway; stopping stays owner-only.
func (h *ProjectHandler) StartSandbox(c echo.Context) error {
	access, err := requireWritableProject(c, h.projects)
	if err != nil {
		return err
	}
	projectID := access.Project.ProjectID
	go func() {
		if _, err := h.sandbox.EnsureReady(context.Background(), projectID); err != nil {
			log.Printf("warn: start sandbox for project %s: %v", projectID, err)
		}
	}()
	return c.NoContent(http.StatusAccepted)
}

func (h *ProjectHandler) StopSandbox(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	if err := h.sandbox.Stop(c.Request().Context(), access.Project.ProjectID); err != nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *ProjectHandler) ListMembers(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	members, err := h.members.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if members == nil {
		members = []*model.ProjectMember{}
	}
	return c.JSON(http.StatusOK, members)
}

type memberRequest struct {
	Username string `json:"username"`
}

func (h *ProjectHandler) CreateMember(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	var req memberRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	user, err := h.users.GetByUsername(c.Request().Context(), req.Username)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if user.UserID == access.Project.OwnerUserID {
		return echo.NewHTTPError(http.StatusBadRequest, "owner already has access")
	}
	member, err := h.members.Upsert(c.Request().Context(), access.Project.ProjectID, user.UserID, model.AccessMember)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	h.live.Publish(access.Project.ProjectID, live.Event{Type: "members"})
	return c.JSON(http.StatusCreated, member)
}

func (h *ProjectHandler) DeleteMember(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "member not found")
	}
	if err := h.members.Delete(c.Request().Context(), access.Project.ProjectID, userID); err != nil {
		if errors.Is(err, db.ErrMemberNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "member not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	// The removed member stops receiving the project's events at once.
	h.live.Evict(access.Project.ProjectID, userID)
	h.live.Publish(access.Project.ProjectID, live.Event{Type: "members"})
	return c.NoContent(http.StatusNoContent)
}
