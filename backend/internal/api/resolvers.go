// Package api — resolvers.go centralizes the "load resource and verify
// ownership" step. Handlers should never call store.GetByID directly on
// user-scoped resources; go through these helpers so cross-tenant lookups
// always 404 instead of 200 + wrong data.
package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
)

func requireReadableProject(c echo.Context, store *db.ProjectStore) (*model.ProjectAccess, error) {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return nil, echo.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Param("project_id"))
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "project not found")
	}
	access, err := store.GetAccessible(c.Request().Context(), id, userID)
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "project not found")
	}
	return access, nil
}

// requireWritableProject — any member can write; only project deletion and
// membership changes are owner-gated (see requireManageableProject).
func requireWritableProject(c echo.Context, store *db.ProjectStore) (*model.ProjectAccess, error) {
	return requireReadableProject(c, store)
}

func requireManageableProject(c echo.Context, store *db.ProjectStore) (*model.ProjectAccess, error) {
	access, err := requireReadableProject(c, store)
	if err != nil {
		return nil, err
	}
	if access.AccessRole != model.AccessOwner {
		return nil, echo.NewHTTPError(http.StatusForbidden, "owner access required")
	}
	return access, nil
}

// requireReadableSession loads :session_id and verifies the caller can read
// its project. Returns the session and project access, or 404 on any
// lookup/access failure — we don't confirm the existence of someone else's
// session via a 403.
func requireReadableSession(
	c echo.Context,
	sessions *db.SessionStore,
	projects *db.ProjectStore,
) (*model.Session, *model.ProjectAccess, error) {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return nil, nil, echo.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Param("session_id"))
	if err != nil {
		return nil, nil, echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	sess, err := sessions.GetByID(c.Request().Context(), id)
	if err != nil {
		return nil, nil, echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	access, err := projects.GetAccessible(c.Request().Context(), sess.ProjectID, userID)
	if err != nil {
		return nil, nil, echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return sess, access, nil
}

// requireWritableSession additionally requires the caller to own the session:
// sessions are private to their creator and read-only to other members. A
// session without a creator (legacy, or the account was deleted) falls to the
// project owner.
func requireWritableSession(
	c echo.Context,
	sessions *db.SessionStore,
	projects *db.ProjectStore,
) (*model.Session, *model.ProjectAccess, error) {
	sess, access, err := requireReadableSession(c, sessions, projects)
	if err != nil {
		return nil, nil, err
	}
	userID, _ := UserIDFromContext(c)
	if !canWriteSession(sess, access, userID) {
		return nil, nil, echo.NewHTTPError(http.StatusForbidden, "only the session's creator can change it")
	}
	return sess, access, nil
}

func canWriteSession(sess *model.Session, access *model.ProjectAccess, userID uuid.UUID) bool {
	if sess.CreatedByUserID != nil {
		return *sess.CreatedByUserID == userID
	}
	return access.AccessRole == model.AccessOwner
}
