.PHONY: dev dev-front dev-back build stop docker-up docker-db docker-down docker-reset-db build-harness build-pod

GO = $(shell which go)
BUN = $(shell which bun)
COMPOSE = docker compose -f docker/docker-compose.yml

PORT = 8080
K8S_NS = default

# 同时启动前后端
dev:
	@echo "→ starting backend on :$(PORT)"
	@cd backend && set -a && [ -f .env ] && . ./.env; set +a && \
		$(GO) run ./cmd/server/ &
	@echo "→ starting frontend on :3000"
	@cd web && $(BUN) dev

dev-back:
	@echo "→ starting backend on :$(PORT)"
	@cd backend && set -a && [ -f .env ] && . ./.env; set +a && \
		$(GO) run ./cmd/server/

dev-front:
	@echo "→ starting frontend on :3000"
	@cd web && $(BUN) dev

build:
	@echo "→ building backend"
	@cd backend && $(GO) build -o bin/server ./cmd/server/

stop:
	@lsof -ti :$(PORT) | xargs kill -9 2>/dev/null && echo "killed :$(PORT)" || echo "nothing on :$(PORT)"
	@lsof -ti :3000  | xargs kill -9 2>/dev/null && echo "killed :3000"  || echo "nothing on :3000"

# Docker compose helpers
docker-up:
	@echo "→ starting docker compose stack"
	@$(COMPOSE) up -d

docker-db:
	@echo "→ starting postgres"
	@$(COMPOSE) up -d postgres

docker-down:
	@echo "→ stopping docker compose stack"
	@$(COMPOSE) down

docker-reset-db:
	@echo "→ resetting postgres volume"
	@$(COMPOSE) down -v
	@$(COMPOSE) up -d postgres

# make build-harness — build the pi agent sandbox image
build-harness:
	@echo "→ building cattery-pi:dev"
	@docker build -t cattery-pi:dev harnesses/pi/

# Standalone Pod images (run as their own Pod, not as sandbox sidecars).
# make build-pod              — build all pod images
# make build-pod POD=filemgr  — build one
# make build-pod POD=skillmgr — build one
POD ?=
build-pod:
	$(if $(POD), \
		$(MAKE) _build-pod-$(POD), \
		$(MAKE) _build-pod-filemgr _build-pod-skillmgr)

_build-pod-filemgr:
	@echo "→ building cattery-filemgr:dev"
	@docker build -t cattery-filemgr:dev pods/filemgr/

_build-pod-skillmgr:
	@echo "→ building cattery-skillmgr:dev"
	@docker build -t cattery-skillmgr:dev pods/skillmgr/
