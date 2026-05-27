package api

import (
	"errors"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
	"github.com/wellch4n/cattery/internal/sandbox"
)

type ProjectHandler struct {
	projects *db.ProjectStore
	harness  *db.HarnessStore
	members  *db.MemberStore
	users    *db.UserStore
	sandbox  *sandbox.Manager
	k8s      *k8s.Client
}

func NewProjectHandler(projects *db.ProjectStore, harnessStore *db.HarnessStore, members *db.MemberStore, users *db.UserStore, sandboxMgr *sandbox.Manager, k8sClient *k8s.Client) *ProjectHandler {
	return &ProjectHandler{projects: projects, harness: harnessStore, members: members, users: users, sandbox: sandboxMgr, k8s: k8sClient}
}

type projectDTO struct {
	*model.Project
	AccessRole    string `json:"access_role"`
	OwnerUsername string `json:"owner_username"`
}

func toProjectDTO(access *model.ProjectAccess) *projectDTO {
	return &projectDTO{
		Project:       access.Project,
		AccessRole:    access.AccessRole,
		OwnerUsername: access.OwnerUsername,
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
	// Project 一经创建立刻把工作区 PVC 和 filemgr Pod 备好。harness 起
	// sandbox 时复用同一块 PVC；filemgr Pod 让文件浏览/上传在没有 harness
	// 运行的时候也可用。失败时记日志不阻塞 API：files_handler 在第一次访问
	// 时还会重新 EnsurePVC + EnsureFileMgrPod 兜底。
	pvcName := sandbox.PVCNameForProjectID(project.ProjectID)
	if err := h.k8s.EnsurePVC(c.Request().Context(), pvcName, map[string]string{
		k8s.LabelProjectID: project.ProjectID.String(),
	}); err != nil {
		log.Printf("warn: ensure workspace pvc for project %s: %v", project.ProjectID, err)
	}
	if err := h.k8s.EnsureFileMgrPod(c.Request().Context(), k8s.FileMgrPodSpec{
		Name:      sandbox.FileMgrPodNameForProject(project.ProjectID),
		ProjectID: project.ProjectID.String(),
		PVCName:   pvcName,
		Image:     sandbox.FileMgrImage,
		Port:      sandbox.FileMgrPort,
	}); err != nil {
		log.Printf("warn: ensure filemgr pod for project %s: %v", project.ProjectID, err)
	}
	owner, _ := h.users.GetByID(c.Request().Context(), userID)
	ownerUsername := ""
	if owner != nil {
		ownerUsername = owner.Username
	}
	return c.JSON(http.StatusCreated, &projectDTO{Project: project, AccessRole: model.AccessOwner, OwnerUsername: ownerUsername})
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
	harnesses, err := h.harness.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	for _, inst := range harnesses {
		h.sandbox.Stop(c.Request().Context(), inst)
	}
	if err := h.k8s.DeletePod(c.Request().Context(), sandbox.FileMgrPodNameForProject(access.Project.ProjectID)); err != nil {
		log.Printf("warn: delete filemgr pod for project %s: %v", access.Project.ProjectID, err)
	}
	// Drop the workspace PVC last — filemgr Pod (which mounts it) must be
	// terminating first, otherwise the PVC delete blocks on the in-use
	// finalizer until the Pod releases the volume.
	if err := h.k8s.DeletePVC(c.Request().Context(), sandbox.PVCNameForProjectID(access.Project.ProjectID)); err != nil {
		log.Printf("warn: delete workspace pvc for project %s: %v", access.Project.ProjectID, err)
	}
	if err := h.projects.DeleteForOwner(c.Request().Context(), access.Project.ProjectID, access.Project.OwnerUserID); err != nil {
		if errors.Is(err, db.ErrProjectNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "project not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *ProjectHandler) ListHarnesses(c echo.Context) error {
	access, err := requireReadableProject(c, h.projects)
	if err != nil {
		return err
	}
	harnesses, err := h.harness.ListByProject(c.Request().Context(), access.Project.ProjectID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]*harnessDTO, 0, len(harnesses))
	for _, inst := range harnesses {
		out = append(out, toDTO(inst, access.AccessRole, access.OwnerUsername, access.Project))
	}
	return c.JSON(http.StatusOK, out)
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
	Role     string `json:"role"`
}

type updateMemberRequest struct {
	Role string `json:"role"`
}

func validMemberRole(role string) bool {
	return role == model.AccessViewer || role == model.AccessEditor
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
	if !validMemberRole(req.Role) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid member role")
	}
	user, err := h.users.GetByUsername(c.Request().Context(), req.Username)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "user not found")
	}
	if user.UserID == access.Project.OwnerUserID {
		return echo.NewHTTPError(http.StatusBadRequest, "owner already has access")
	}
	member, err := h.members.Upsert(c.Request().Context(), access.Project.ProjectID, user.UserID, req.Role)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusCreated, member)
}

func (h *ProjectHandler) UpdateMember(c echo.Context) error {
	access, err := requireManageableProject(c, h.projects)
	if err != nil {
		return err
	}
	userID, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "member not found")
	}
	var req updateMemberRequest
	if err := c.Bind(&req); err != nil {
		return echo.ErrBadRequest
	}
	if !validMemberRole(req.Role) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid member role")
	}
	member, err := h.members.UpdateRole(c.Request().Context(), access.Project.ProjectID, userID, req.Role)
	if err != nil {
		if errors.Is(err, db.ErrMemberNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "member not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, member)
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
	return c.NoContent(http.StatusNoContent)
}
