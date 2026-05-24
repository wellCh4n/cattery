package auth

import (
	"context"
	"log"

	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/model"
)

// DefaultAdminUsername is the username assigned to the auto-created bootstrap
// admin on first start. Hardcoded because the install is single-tenant and
// operators can always rename the row via SQL if they really care.
const DefaultAdminUsername = "admin"

// BootstrapAdminIfEmpty creates a default admin account when the users table
// is empty. The password is generated fresh on each install and logged once
// with a banner — the operator is expected to capture it from the startup
// logs and change it after first login. Subsequent starts are no-ops.
//
// Lost the password? Reset it directly in Postgres:
//
//	UPDATE users SET password_hash = '<bcrypt hash>' WHERE username = 'admin';
//
// (Or drop the users row and let the next restart bootstrap a fresh admin.)
func BootstrapAdminIfEmpty(ctx context.Context, store *db.UserStore) error {
	n, err := store.Count(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}

	password := GeneratePassword()
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	u := &model.User{Username: DefaultAdminUsername, PasswordHash: hash, IsAdmin: true}
	if err := store.Create(ctx, u); err != nil {
		return err
	}

	// One-shot banner. Loud on purpose — operators who miss this on a fresh
	// install have to recover via DB. The "================" lines make it
	// noticeable in a wall of structured request logs.
	log.Println("================================================================")
	log.Println("[auth] First-time admin account created:")
	log.Printf("[auth]   username: %s", DefaultAdminUsername)
	log.Printf("[auth]   password: %s", password)
	log.Println("[auth] Sign in and change the password from the user menu.")
	log.Println("[auth] This message will NOT appear again.")
	log.Println("================================================================")
	return nil
}
