package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/db"
)

type UsageHandler struct{ usage *db.UsageStore }

func NewUsageHandler(usageStore *db.UsageStore) *UsageHandler { return &UsageHandler{usageStore} }

// maxUsageDays bounds a usage query, about three years of days.
const maxUsageDays = 1100

// Mine is the caller's own token usage.
func (h *UsageHandler) Mine(c echo.Context) error {
	userID, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	return h.stats(c, &userID)
}

// All is everyone's token usage, for admins.
func (h *UsageHandler) All(c echo.Context) error {
	return h.stats(c, nil)
}

// stats sums token usage per period, user and model over the days from..to
// (inclusive, YYYY-MM-DD) in the caller's time zone tz, by bucket day | week |
// month.
func (h *UsageHandler) stats(c echo.Context, userID *uuid.UUID) error {
	from, err1 := time.Parse(time.DateOnly, c.QueryParam("from"))
	to, err2 := time.Parse(time.DateOnly, c.QueryParam("to"))
	if err1 != nil || err2 != nil || to.Before(from) || to.Sub(from) > maxUsageDays*24*time.Hour {
		return echo.NewHTTPError(http.StatusBadRequest, "from and to must be dates (YYYY-MM-DD), from ≤ to")
	}
	bucket := c.QueryParam("bucket")
	if bucket != "day" && bucket != "week" && bucket != "month" {
		return echo.NewHTTPError(http.StatusBadRequest, "bucket must be day, week or month")
	}
	tz := c.QueryParam("tz")
	if tz == "" {
		tz = "UTC"
	}
	rows, err := h.usage.Stats(c.Request().Context(), from, to.AddDate(0, 0, 1), bucket, tz, userID)
	if errors.Is(err, db.ErrUnknownTimeZone) {
		return echo.NewHTTPError(http.StatusBadRequest, "unknown time zone")
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, rows)
}
