// Package auth holds password hashing and JWT helpers. Used by the auth
// handler/middleware and by admin bootstrap.
package auth

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

// bcrypt cost — 12 is a reasonable trade-off (~250ms on modern CPUs).
const bcryptCost = 12

// MinPasswordLength is enforced everywhere a password is set: login bootstrap,
// admin create/reset, self change-password. Internal tool, so 8 chars is
// enough — we just want to keep "a" out.
const MinPasswordLength = 8

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

func ValidatePassword(p string) error {
	if len(p) < MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	return nil
}

// DummyHash returns a valid bcrypt hash that will never match any real
// password. /auth/login runs VerifyPassword against this when the email
// doesn't exist so the response time matches the "wrong password" path —
// otherwise an attacker can enumerate accounts by measuring latency. Lazy
// init pays the ~250ms bcrypt cost once on the first invalid-email login,
// not at startup.
var DummyHash = sync.OnceValue(func() string {
	h, err := bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcryptCost)
	if err != nil {
		// bcrypt with valid cost never fails; if it does, security defense
		// is degraded but login still works. Better than panicking startup.
		return ""
	}
	return string(h)
})

// GeneratePassword returns a 20-char base32-encoded random password formatted
// as XXXXX-XXXXX-XXXXX-XXXXX. ~60 bits of entropy from 12 random bytes; more
// than enough for a one-shot admin bootstrap password that will be changed
// at first login. The dashes are cosmetic — they make the value easier to
// read off a server log and type by hand.
func GeneratePassword() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand only fails when the OS RNG is broken; nothing useful
		// we can do at that point.
		panic("auth: crypto/rand failed: " + err.Error())
	}
	raw := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return raw[:5] + "-" + raw[5:10] + "-" + raw[10:15] + "-" + raw[15:20]
}
