package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
)

// UsersHandler exposes user-directory lookups that any authenticated user is
// allowed to perform (e.g. the share dialog needs to autocomplete usernames).
// Admin-only mutations live on AdminHandler.
type UsersHandler struct {
	users *db.UserStore
}

func NewUsersHandler(users *db.UserStore) *UsersHandler {
	return &UsersHandler{users: users}
}

type userSearchDTO struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
}

// Search returns up to 20 users whose username contains the query substring.
// Empty query matches all. Available to any authenticated caller — usernames
// are not considered secret in this internal tool.
func (h *UsersHandler) Search(c echo.Context) error {
	if _, ok := UserIDFromContext(c); !ok {
		return echo.ErrUnauthorized
	}
	users, err := h.users.Search(c.Request().Context(), c.QueryParam("q"), 20)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	out := make([]userSearchDTO, 0, len(users))
	for _, u := range users {
		out = append(out, userSearchDTO{UserID: u.UserID, Username: u.Username})
	}
	return c.JSON(http.StatusOK, out)
}
