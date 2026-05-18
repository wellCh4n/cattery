.PHONY: dev dev-front dev-back build stop build-harness

GO = $(shell which go)
BUN = $(shell which bun)

DB_URL = postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable
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

migrate:
	@/Applications/Postgres.app/Contents/Versions/latest/bin/psql -h localhost -p 5432 -U postgres -d cattery \
		-f backend/internal/db/migrations/init.sql

# make build-harness HARNESS=opencode   — build one harness
# make build-harness HARNESS=claude-code — build one harness
# make build-harness                     — build all harnesses
HARNESS ?=
build-harness:
	$(if $(HARNESS), \
		$(MAKE) _build-harness-$(HARNESS), \
		$(MAKE) _build-harness-opencode _build-harness-claude-code)

_build-harness-opencode:
	@echo "→ building opencode-sandbox:dev"
	@docker build -t opencode-sandbox:dev harnesses/opencode/

_build-harness-claude-code:
	@echo "→ building claude-code-sandbox:dev"
	@docker build -t claude-code-sandbox:dev harnesses/claude-code/
