package db

import (
	"embed"
	"fmt"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

func Connect(dsn string) (*sqlx.DB, error) {
	db, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	if err := runMigrations(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func runMigrations(db *sqlx.DB) error {
	goose.SetBaseFS(migrationFS)
	goose.SetTableName("schema_migrations")
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	if err := goose.Up(db.DB, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}
