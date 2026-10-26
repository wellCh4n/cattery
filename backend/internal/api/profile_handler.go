package api

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const maxAvatarBytes = 2 << 20

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > 64 {
		return "", errors.New("name must be at most 64 characters")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errors.New("name cannot contain control characters")
		}
	}
	return name, nil
}

func (h *AuthHandler) UpdateProfile(c echo.Context) error {
	id, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	if _, err := h.users.GetByID(c.Request().Context(), id); err != nil {
		return echo.ErrUnauthorized
	}
	var req struct {
		Name *string `json:"name"`
	}
	c.Request().Body = http.MaxBytesReader(c.Response(), c.Request().Body, 8192)
	decoder := json.NewDecoder(c.Request().Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || req.Name == nil {
		return echo.ErrBadRequest
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return echo.ErrBadRequest
	}
	name, err := normalizeName(*req.Name)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	if err := h.users.UpdateName(c.Request().Context(), id, name); err != nil {
		return err
	}
	return h.Me(c)
}

// Decode the actual bytes and re-encode a bounded static image. Neither the
// filename nor the uploaded content type is trusted; metadata is discarded.
func normalizeAvatar(data []byte) ([]byte, error) {
	if len(data) > maxAvatarBytes {
		return nil, errors.New("avatar must be at most 2 MB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return nil, errors.New("choose a JPEG, PNG or WebP image")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 16_000_000 {
		return nil, errors.New("image must be at most 16 megapixels")
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("could not decode image")
	}
	bounds := src.Bounds()
	size := min(bounds.Dx(), bounds.Dy())
	x, y := bounds.Min.X+(bounds.Dx()-size)/2, bounds.Min.Y+(bounds.Dy()-size)/2
	dst := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, image.Rect(x, y, x+size, y+size), draw.Src, nil)
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (h *AuthHandler) UploadAvatar(c echo.Context) error {
	id, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	if _, err := h.users.GetByID(c.Request().Context(), id); err != nil {
		return echo.ErrUnauthorized
	}
	r := c.Request()
	r.Body = http.MaxBytesReader(c.Response(), r.Body, maxAvatarBytes+(64<<10))
	if err := r.ParseMultipartForm(maxAvatarBytes + (64 << 10)); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "avatar must be at most 2 MB")
		}
		return echo.NewHTTPError(http.StatusBadRequest, "invalid avatar upload")
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("avatar")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "avatar is required")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil {
		return echo.ErrBadRequest
	}
	if len(data) > maxAvatarBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "avatar must be at most 2 MB")
	}
	normalized, err := normalizeAvatar(data)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	hash := sha256.Sum256(normalized)
	if err := h.users.PutAvatar(r.Context(), id, normalized, hex.EncodeToString(hash[:])); err != nil {
		return err
	}
	return h.Me(c)
}

func (h *AuthHandler) DeleteAvatar(c echo.Context) error {
	id, ok := UserIDFromContext(c)
	if !ok {
		return echo.ErrUnauthorized
	}
	if _, err := h.users.GetByID(c.Request().Context(), id); err != nil {
		return echo.ErrUnauthorized
	}
	if err := h.users.DeleteAvatar(c.Request().Context(), id); err != nil {
		return err
	}
	return h.Me(c)
}

func (h *UsersHandler) Avatar(c echo.Context) error {
	if _, ok := UserIDFromContext(c); !ok {
		return echo.ErrUnauthorized
	}
	id, err := uuid.Parse(c.Param("user_id"))
	if err != nil {
		return echo.ErrNotFound
	}
	data, version, err := h.users.Avatar(c.Request().Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		return echo.ErrNotFound
	}
	if err != nil {
		return err
	}
	etag := `"` + version + `"`
	c.Response().Header().Set("ETag", etag)
	c.Response().Header().Set("Cache-Control", "private, no-cache")
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	if c.Request().Header.Get("If-None-Match") == etag {
		return c.NoContent(http.StatusNotModified)
	}
	return c.Blob(http.StatusOK, "image/png", data)
}
