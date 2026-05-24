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

// requireReadableHarness loads :harness_id and verifies the caller can read
// it. Bad ID, missing row, and access mismatch all surface as 404 — we don't
// want to confirm the existence of someone else's harness via a 403.
func requireReadableHarness(c echo.Context, store *db.HarnessStore) (*model.HarnessAccess, error) {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return nil, echo.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	access, err := store.GetAccessible(c.Request().Context(), id, userID)
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	return access, nil
}

func requireWritableHarness(c echo.Context, store *db.HarnessStore) (*model.HarnessAccess, error) {
	access, err := requireReadableHarness(c, store)
	if err != nil {
		return nil, err
	}
	if access.AccessRole != model.AccessOwner && access.AccessRole != model.AccessEditor {
		return nil, echo.NewHTTPError(http.StatusForbidden, "editor access required")
	}
	return access, nil
}

func requireManageableHarness(c echo.Context, store *db.HarnessStore) (*model.HarnessAccess, error) {
	access, err := requireReadableHarness(c, store)
	if err != nil {
		return nil, err
	}
	if access.AccessRole != model.AccessOwner {
		return nil, echo.NewHTTPError(http.StatusForbidden, "owner access required")
	}
	return access, nil
}

// requireReadableSession loads :session_id and verifies the caller can read
// the parent harness. Returns the session and harness access, or 404 on any
// lookup/access failure.
func requireReadableSession(
	c echo.Context,
	sessions *db.SessionStore,
	harnesses *db.HarnessStore,
) (*model.Session, *model.HarnessAccess, error) {
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
	access, err := harnesses.GetAccessible(c.Request().Context(), sess.HarnessID, userID)
	if err != nil {
		return nil, nil, echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return sess, access, nil
}

func requireWritableSession(
	c echo.Context,
	sessions *db.SessionStore,
	harnesses *db.HarnessStore,
) (*model.Session, *model.HarnessAccess, error) {
	sess, access, err := requireReadableSession(c, sessions, harnesses)
	if err != nil {
		return nil, nil, err
	}
	if access.AccessRole != model.AccessOwner && access.AccessRole != model.AccessEditor {
		return nil, nil, echo.NewHTTPError(http.StatusForbidden, "editor access required")
	}
	return sess, access, nil
}
