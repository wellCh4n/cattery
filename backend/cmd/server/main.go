package main

import (
	"context"
	"log"

	"github.com/wellch4n/cattery/internal/api"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	k8sclient "github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/sandbox"
)

func main() {
	cfg := config.Load()

	database, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	signer, err := auth.NewSigner(cfg.JWTSecret)
	if err != nil {
		log.Fatalf("auth signer: %v", err)
	}

	userStore := db.NewUserStore(database)
	if err := auth.BootstrapAdminIfEmpty(context.Background(), userStore); err != nil {
		log.Fatalf("bootstrap admin: %v", err)
	}

	k8s, err := k8sclient.NewClient(cfg.K8sNamespace)
	if err != nil {
		log.Fatalf("k8s client: %v", err)
	}

	harnessStore := db.NewHarnessStore(database)
	projectStore := db.NewProjectStore(database)
	memberStore := db.NewMemberStore(database)
	sessionStore := db.NewSessionStore(database)
	harnessClient := harness.NewClient()
	sandboxMgr := sandbox.NewManager(harnessStore, k8s, harnessClient, cfg)

	projectH := api.NewProjectHandler(projectStore, harnessStore, memberStore, userStore, sandboxMgr, k8s)
	harnessH := api.NewHarnessHandler(harnessStore, projectStore, sandboxMgr)
	sessionH := api.NewSessionHandler(sessionStore, harnessStore, harnessClient, sandboxMgr)
	filesH := api.NewFilesHandler(projectStore, k8s)
	authH := api.NewAuthHandler(userStore, signer)
	adminH := api.NewAdminHandler(userStore, harnessStore, projectStore, sandboxMgr)
	usersH := api.NewUsersHandler(userStore)

	router := api.NewRouter(database, harnessH, projectH, sessionH, filesH, authH, adminH, usersH, signer)
	log.Printf("starting server on :%s", cfg.Port)
	log.Fatal(router.Start(":" + cfg.Port))
}
