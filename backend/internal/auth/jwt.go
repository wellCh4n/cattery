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
	jwt.RegisteredClaims
}

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
