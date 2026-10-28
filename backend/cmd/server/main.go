package main

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/api"
	"github.com/wellch4n/cattery/internal/auth"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	k8sclient "github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/live"
	"github.com/wellch4n/cattery/internal/sandbox"
	"github.com/wellch4n/cattery/internal/skills"
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

	library, err := skills.Open(cfg.SkillsDir)
	if err != nil {
		log.Fatalf("skill library: %v", err)
	}
	log.Printf("skill library at %s", library.Root())
	// The library used to live in its own Pod; drop it so its PVC is left to
	// this backend.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := k8s.DeletePod(ctx, sandbox.LegacySkillMgrPodName); err != nil {
			log.Printf("delete legacy %s pod: %v", sandbox.LegacySkillMgrPodName, err)
		}
	}()

	projectStore := db.NewProjectStore(database)
	memberStore := db.NewMemberStore(database)
	sessionStore := db.NewSessionStore(database)
	terminalStore := db.NewTerminalStore(database)
	usageStore := db.NewUsageStore(database)
	harnessClient := harness.NewClient()
	sandboxMgr := sandbox.NewManager(projectStore, k8s, harnessClient, cfg)
	usageCollector := usage.NewCollector(usageStore, harnessClient, sandboxMgr)
	sandboxMgr.OnRelease(usageCollector.Sync)
	hub := live.NewHub()

	projectH := api.NewProjectHandler(projectStore, memberStore, userStore, sandboxMgr, k8s, hub)
	sessionH := api.NewSessionHandler(sessionStore, projectStore, harnessClient, sandboxMgr, models, usageCollector, hub)
	filesH := api.NewFilesHandler(projectStore, sandboxMgr, hub)
	terminalH := api.NewTerminalHandler(projectStore, terminalStore, sandboxMgr, hub)
	skillsH := api.NewSkillsHandler(library, projectStore, sandboxMgr, hub)
	authH := api.NewAuthHandler(userStore, signer)
	adminH := api.NewAdminHandler(userStore, projectStore, sandboxMgr)
	usersH := api.NewUsersHandler(userStore)
	previewHosts, err := api.NewPreviewHosts(cfg.PreviewURL)
	if err != nil {
		log.Fatalf("PREVIEW_URL: %v", err)
	}
	portsH := api.NewPortsHandler(projectStore, sandboxMgr, signer, previewHosts, hub)
	hub.OnWatch(portsH.WatchApps)
	sandboxMgr.OnStatus(func(projectID uuid.UUID, status string) {
		hub.Publish(projectID, live.Event{Type: "sandbox", Data: map[string]string{"sandbox_status": status}})
		// A sandbox that started or stopped has different apps.
		portsH.PokeApps(projectID)
	})
	go usageCollector.Run(context.Background())
	usageH := api.NewUsageHandler(usageStore)
	liveH := api.NewLiveHandler(hub, userStore, projectStore)

	router := api.NewRouter(database, projectH, sessionH, filesH, terminalH, skillsH, authH, adminH, usersH, portsH, usageH, liveH, signer)
	log.Printf("starting server on :%s", cfg.Port)
	log.Fatal(router.Start(":" + cfg.Port))
}
