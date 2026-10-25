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
	"github.com/wellch4n/cattery/internal/usage"
)

func main() {
	cfg := config.Load()

	database, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	models, err := config.LoadModels(cfg.ModelsConfig)
	if err != nil {
		log.Fatalf("%v (copy backend/models.example.toml to get started)", err)
	}

	signer, err := auth.NewSigner(cfg.JWTSecret)
	if err != nil {
		log.Fatalf("auth signer: %v", err)
	}

	userStore := db.NewUserStore(database)
	if err := auth.BootstrapAdminIfEmpty(context.Background(), userStore); err != nil {
		log.Fatalf("bootstrap admin: %v", err)
	}

	k8s, err := k8sclient.NewClient(cfg.K8sNamespace, cfg.K8sStorageClass, cfg.K8sPVCAccessMode)
	if err != nil {
		log.Fatalf("k8s client: %v", err)
	}

	projectStore := db.NewProjectStore(database)
	memberStore := db.NewMemberStore(database)
	sessionStore := db.NewSessionStore(database)
	terminalStore := db.NewTerminalStore(database)
	usageStore := db.NewUsageStore(database)
	harnessClient := harness.NewClient()
	sandboxMgr := sandbox.NewManager(projectStore, k8s, harnessClient, cfg)
	usageCollector := usage.NewCollector(usageStore, harnessClient, sandboxMgr)
	sandboxMgr.OnRelease(usageCollector.Sync)
	go usageCollector.Run(context.Background())

	projectH := api.NewProjectHandler(projectStore, memberStore, userStore, sandboxMgr, k8s)
	sessionH := api.NewSessionHandler(sessionStore, projectStore, harnessClient, sandboxMgr, models, usageCollector)
	filesH := api.NewFilesHandler(projectStore, sandboxMgr)
	terminalH := api.NewTerminalHandler(projectStore, terminalStore, sandboxMgr)
	skillsH := api.NewSkillsHandler(k8s)
	authH := api.NewAuthHandler(userStore, signer)
	adminH := api.NewAdminHandler(userStore, projectStore, sandboxMgr)
	usersH := api.NewUsersHandler(userStore)
	portsH := api.NewPortsHandler(projectStore, sandboxMgr, signer)
	usageH := api.NewUsageHandler(usageStore)

	router := api.NewRouter(database, projectH, sessionH, filesH, terminalH, skillsH, authH, adminH, usersH, portsH, usageH, signer)
	log.Printf("starting server on :%s", cfg.Port)
	log.Fatal(router.Start(":" + cfg.Port))
}
