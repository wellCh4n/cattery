package main

import (
	"log"

	"github.com/wellch4n/cattery/internal/api"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	k8sclient "github.com/wellch4n/cattery/internal/k8s"
)

func main() {
	cfg := config.Load()

	database, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	k8s, err := k8sclient.NewClient(cfg.K8sNamespace)
	if err != nil {
		log.Fatalf("k8s client: %v", err)
	}

	agentStore := db.NewAgentStore(database)
	sessionStore := db.NewSessionStore(database)
	harnessClient := harness.NewClient()

	agentH := api.NewAgentHandler(agentStore, k8s)
	sessionH := api.NewSessionHandler(sessionStore, agentStore, k8s, harnessClient, cfg)

	router := api.NewRouter(agentH, sessionH)
	log.Printf("starting server on :%s", cfg.Port)
	log.Fatal(router.Start(":" + cfg.Port))
}
