package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// tokenTTL — default lifetime of issued tokens. No refresh, no rotation:
// when it expires the user logs in again.
const tokenTTL = 7 * 24 * time.Hour

type Claims struct {
	UserID  uuid.UUID `json:"uid"`
	IsAdmin bool      `json:"adm"`
	// Scope narrows a token to one use; empty is a full login token. A
	// ScopePreview token only opens ProjectID's sandbox port previews.
	Scope     string `json:"scp,omitempty"`
	ProjectID string `json:"pid,omitempty"`
	jwt.RegisteredClaims
}

const ScopePreview = "preview"

type Signer struct {
	secret []byte
}

func NewSigner(secret string) (*Signer, error) {
	if secret == "" {
		return nil, errors.New("auth: JWT_SECRET is required")
	}
	return &Signer{secret: []byte(secret)}, nil
}

func (s *Signer) Issue(userID uuid.UUID, isAdmin bool) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:  userID,
		IsAdmin: isAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(tokenTTL)),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(s.secret)
}

// IssuePreview issues a token that opens only projectID's port previews, for
// the cookie set on preview pages. It never outlives expires, the login
// token it was exchanged for.
func (s *Signer) IssuePreview(userID, projectID uuid.UUID, expires time.Time) (string, error) {
	now := time.Now()
	if limit := now.Add(previewTTL); expires.After(limit) {
		expires = limit
	}
	claims := Claims{
		UserID:    userID,
		Scope:     ScopePreview,
		ProjectID: projectID.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expires),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

const previewTTL = 24 * time.Hour

// Verify returns the claims if the token is valid and not expired.
// Note: we don't re-check is_admin against the DB — token is the source of
// truth until it expires. If you demote an admin, the token keeps its admin
// bit until expiry. This is the trade-off you signed up for going JWT.
func (s *Signer) Verify(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Method.Alg())
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}
