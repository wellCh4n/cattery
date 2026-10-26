package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/wellch4n/cattery/internal/auth"
)

// A preview cookie must not work as a login token anywhere else.
func TestPreviewTokenIsNotALoginToken(t *testing.T) {
	signer, err := auth.NewSigner("test-secret")
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.IssuePreview(uuid.New(), uuid.New(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	e := echo.New()
	handler := AuthMiddleware(signer)(func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	err = handler(e.NewContext(req, httptest.NewRecorder()))
	if he, ok := err.(*echo.HTTPError); !ok || he.Code != http.StatusUnauthorized {
		t.Fatalf("scoped token accepted: %v", err)
	}
}

func TestPreviewTokenExpiry(t *testing.T) {
	signer, _ := auth.NewSigner("test-secret")
	login := time.Now().Add(time.Hour)
	token, _ := signer.IssuePreview(uuid.New(), uuid.New(), login)
	claims, err := signer.Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.ExpiresAt.After(login) {
		t.Fatalf("preview token outlives its login token: %v > %v", claims.ExpiresAt, login)
	}
	if claims.Scope != auth.ScopePreview {
		t.Fatalf("scope = %q", claims.Scope)
	}
}

func TestReservedPorts(t *testing.T) {
	for _, p := range []int{1114} {
		if !reservedPort(p) {
			t.Errorf("port %d should be reserved", p)
		}
	}
	if reservedPort(5173) {
		t.Error("5173 should be previewable")
	}
}
