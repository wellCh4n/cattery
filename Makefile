.PHONY: dev dev-front dev-back build stop docker-up docker-db docker-down docker-reset-db build-harness build-pod

GO = $(shell which go)
BUN = $(shell which bun)
COMPOSE = docker compose -f docker/docker-compose.yml

PORT ?= $(shell cd backend && if [ -f .env ]; then . ./.env; fi; printf '%s' "$${PORT:-8080}")
K8S_NS = default

# 同时启动前后端
dev:
	@echo "→ starting backend on :$(PORT)"
	@cd backend && set -a && [ -f .env ] && . ./.env; set +a && \
		PORT="$(PORT)" $(GO) run ./cmd/server/ &
	@echo "→ starting frontend on :3000"
	@cd web && $(BUN) dev

dev-back:
	@echo "→ starting backend on :$(PORT)"
	@cd backend && set -a && [ -f .env ] && . ./.env; set +a && \
		PORT="$(PORT)" $(GO) run ./cmd/server/

dev-front:
	@echo "→ starting frontend on :3000"
	@cd web && $(BUN) dev

build:
	@echo "→ building backend"
	@cd backend && $(GO) build -o bin/server ./cmd/server/

stop:
	@lsof -tiTCP:$(PORT) -sTCP:LISTEN | xargs kill -TERM 2>/dev/null && echo "stopped :$(PORT)" || echo "nothing on :$(PORT)"
	@lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill -TERM 2>/dev/null && echo "stopped :3000" || echo "nothing on :3000"

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

# make build-harness — build the project sandbox image: the pi agent, which
# also serves the workspace files, LaTeX previews and app previews
build-harness:
	@echo "→ building cattery-pi:dev"
	@docker build -t cattery-pi:dev harnesses/pi/

# make build-pod — build the global skill library image (skillmgr)
build-pod:
	@echo "→ building cattery-skillmgr:dev"
	@docker build -t cattery-skillmgr:dev pods/skillmgr/
