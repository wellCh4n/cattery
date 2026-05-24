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

// resolveOwnedHarness reads :harness_id from the URL and returns the
// harness only if the authenticated user owns it. Bad ID, missing row,
// and ownership mismatch all surface as 404 — we don't want to confirm
// the existence of someone else's harness via a 403.
func resolveOwnedHarness(c echo.Context, store *db.HarnessStore) (*model.Harness, error) {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return nil, echo.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Param("harness_id"))
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	inst, err := store.GetForOwner(c.Request().Context(), id, userID)
	if err != nil {
		return nil, echo.NewHTTPError(http.StatusNotFound, "harness not found")
	}
	return inst, nil
}

// resolveOwnedSession reads :session_id and walks session → harness →
// owner. Returns the session, its harness, or 404 on any failure. Same
// "don't leak existence" rule as resolveOwnedHarness.
func resolveOwnedSession(
	c echo.Context,
	sessions *db.SessionStore,
	harnesses *db.HarnessStore,
) (*model.Session, *model.Harness, error) {
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
	inst, err := harnesses.GetForOwner(c.Request().Context(), sess.HarnessID, userID)
	if err != nil {
		return nil, nil, echo.NewHTTPError(http.StatusNotFound, "session not found")
	}
	return sess, inst, nil
}
