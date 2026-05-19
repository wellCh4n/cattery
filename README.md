# Cattery

Self-hosted, team-oriented AI coding agent platform. Each Agent template runs inside an isolated Kubernetes Sandbox Pod; users interact with the running agent through Sessions.

The platform is harness-agnostic. Two transports are supported:

- **HTTP harnesses** (e.g. `opencode`, `claude-code`) — implement a common HTTP contract; the backend translates their event streams into a uniform protocol the frontend can render.
- **Terminal harnesses** (e.g. `codex`, `hermes`) — wrap a TUI; the backend proxies raw PTY bytes over WebSocket to a terminal view.

```
web (Next.js + shadcn)   →   backend (Go + Echo)   →   K8s Sandbox Pod
                                                       └─ harness container (e.g. opencode)
                                                       └─ external model API (anthropic/openai-compatible)
```

## Prerequisites

- **Kubernetes cluster** (any flavor — kind, minikube, EKS, GKE, etc.) with kubeconfig reachable from the backend
- **[Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller** installed in the cluster — provides the `agents.x-k8s.io/v1alpha1` `Sandbox` CRD that Cattery uses to launch isolated agent pods
- **PostgreSQL** (any 14+)
- **Go** ≥ 1.22
- **Bun** ≥ 1.0 (for the Next.js frontend)
- **Docker** (only needed to build harness images)
- **An OpenAI- or Anthropic-compatible model gateway** (e.g. NewAPI, LiteLLM, the upstream provider directly)

### Install the Agent Sandbox controller

Pick a release tag from the [agent-sandbox releases page](https://github.com/kubernetes-sigs/agent-sandbox/releases) and apply the manifest:

```bash
VERSION=v0.1.0   # replace with the latest release
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml
```

Verify the CRD is registered and the controller is running:

```bash
kubectl get crd sandboxes.agents.x-k8s.io
kubectl get pods -n agent-sandbox-system   # or wherever the manifest installs it
```

See the [Agent Sandbox Getting Started guide](https://agent-sandbox.sigs.k8s.io/docs/getting_started/) for cluster-wide RBAC, namespacing, and extension components.

## Quick start

```bash
# 1. clone
git clone https://github.com/wellCh4n/cattery.git && cd cattery

# 2. create the database and apply schema
createdb cattery
make migrate

# 3. backend env
cat > backend/.env <<EOF
DATABASE_URL=postgres://postgres@localhost:5432/cattery?sslmode=disable
PORT=8080
K8S_NAMESPACE=default
MODEL_API_BASE=https://your-gateway.example.com/v1
MODEL_API_KEY=sk-...
MODEL_API_STYLE=anthropic    # or "openai"
EOF

# 4. build & push harness images so the cluster can pull them
make build-harness                       # builds opencode, claude-code, codex, hermes
# or build a single one:
# make build-harness HARNESS=opencode
# tag and push to your registry, e.g.:
# docker tag opencode-sandbox:dev your-registry/opencode-sandbox:dev
# docker push your-registry/opencode-sandbox:dev

# 5. run
make dev           # starts backend on :8080 and frontend on :3000
```

Open <http://localhost:3000> and click `+` in the sidebar to create your first agent.

## Make targets

| Target              | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `make dev`          | Start backend (`:8080`) and frontend (`:3000`) together            |
| `make dev-back`     | Backend only, sources `backend/.env`                               |
| `make dev-front`    | Frontend dev server (`bun dev`)                                    |
| `make build`        | Compile the Go server to `backend/bin/server`                      |
| `make stop`         | Kill processes on `:8080` and `:3000`                              |
| `make migrate`      | Apply `backend/internal/db/migrations/init.sql`                    |
| `make build-harness`| Build all harness Docker images; pass `HARNESS=<name>` to build one |

## Configuration

Backend env vars (file: `backend/.env`, gitignored):

| Variable           | Default                                                            | Purpose                                                         |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `DATABASE_URL`     | `postgres://postgres@localhost:5432/cattery?sslmode=disable`       | Postgres DSN                                                    |
| `PORT`             | `8080`                                                             | HTTP listen port                                                |
| `K8S_NAMESPACE`    | `default`                                                          | Namespace where Sandbox CRs are created                         |
| `MODEL_API_BASE`   | —                                                                  | URL of the model gateway (OpenAI- or Anthropic-compatible)      |
| `MODEL_API_KEY`    | —                                                                  | Auth token forwarded to the harness                             |
| `MODEL_API_STYLE`  | `openai`                                                           | `openai` or `anthropic` — determines the harness env wiring     |

The backend uses `clientcmd.RecommendedHomeFile` (`~/.kube/config`) when not running in-cluster.

## Resource model

- **Agent** — configuration template (model, prompt, harness_id, repo, env_vars). Owns a single long-lived sandbox.
- **Sandbox** — one Kubernetes `agents.x-k8s.io/v1alpha1` Sandbox CR per Agent, named `cattery-<agent_id>`. Status is mirrored to the Agent row.
- **Session** — a conversation inside an Agent's sandbox. Multiple sessions share one sandbox.

## Adding a new harness

Pick a transport kind in `backend/internal/harness/registry.go`:

### HTTP harness (translated SSE)

Implement this contract on `agent.container_port` (default `4096`):

```
POST /session                       → { id }
POST /session/:id/prompt_async      → 204
GET  /session/:id/message           → history
POST /session/:id/abort
GET  /event                         → SSE stream of harness-native events
```

Add a subpackage at `backend/internal/harness/<name>/` with `translator.go` (stream) and `history.go` (replay) that emit `PlatformEvent`s, then call `harness.Register(id, stream, history)` from `init()`. See `harness/opencode/` for a reference.

### Terminal harness (raw PTY over WebSocket)

For TUI-style agents, just call `harness.RegisterTerminal(id)` from `init()` — the session is served at `GET /api/v1/sessions/:id/term` and bytes are proxied both directions. See `harness/codex/register.go` and `harness/hermes/register.go`.

See [`CLAUDE.md`](./CLAUDE.md) for the full protocol spec.

## License

Internal project — not yet licensed for public use.
