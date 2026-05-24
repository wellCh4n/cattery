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
- **PostgreSQL** 14+ — run it yourself, or let the bundled `docker-compose.yml` start one for you
- **Go** ≥ 1.22 (only if you run the backend on the host instead of in compose)
- **Bun** ≥ 1.0 (only if you run the frontend on the host)
- **Docker** — required for harness images, plus the optional compose stack
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

# 2. backend env
cat > backend/.env <<EOF
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable
PORT=8080
K8S_NAMESPACE=default
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
EOF

# 3. build harness images so the cluster can pull them
make build-harness                       # builds opencode, claude-code, codex, hermes
# tag and push to your registry as needed:
# docker tag opencode-sandbox:dev your-registry/opencode-sandbox:dev
# docker push  your-registry/opencode-sandbox:dev

# 4. run — pick one of the modes below
```

Pick the mode that fits your setup:

```bash
# A) Everything in Docker (db + backend + web)
docker compose -f docker/docker-compose.yml up -d

# B) Backend + web in Docker, point at an existing external database
DATABASE_URL='postgres://user:pw@host.docker.internal:5432/cattery?sslmode=disable' \
  docker compose -f docker/docker-compose.yml up -d --no-deps backend web
```

Open <http://localhost:3000> and click `+` in the sidebar to create your first agent.

Database schema changes are versioned under
[`backend/internal/db/migrations`](backend/internal/db/migrations) and applied
automatically by the backend on startup using `goose`.

## Make targets

| Target              | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `make dev`          | Start backend (`:8080`) and frontend (`:3000`) together            |
| `make dev-back`     | Backend only, sources `backend/.env`                               |
| `make dev-front`    | Frontend dev server (`bun dev`)                                    |
| `make build`        | Compile the Go server to `backend/bin/server`                      |
| `make stop`         | Kill processes on `:8080` and `:3000`                              |
| `make build-harness`| Build all harness Docker images; pass `HARNESS=<name>` to build one |

## Configuration

Backend env vars (file: `backend/.env`, gitignored):

| Variable           | Default                                                            | Purpose                                                         |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `DATABASE_URL`     | `postgres://postgres@localhost:5432/cattery?sslmode=disable`       | Postgres DSN                                                    |
| `PORT`             | `8080`                                                             | HTTP listen port                                                |
| `K8S_NAMESPACE`    | `default`                                                          | Namespace where Sandbox CRs are created                         |
| `ANTHROPIC_BASE_URL` | —                                                                | Anthropic-compatible API base URL                               |
| `ANTHROPIC_API_KEY`  | —                                                                | Auth token for Anthropic models                                 |
| `OPENAI_BASE_URL`    | —                                                                | OpenAI-compatible API base URL, including `/v1`                 |
| `OPENAI_API_KEY`     | —                                                                | Auth token for OpenAI models                                    |
| `JWT_SECRET`         | —                                                                | **Required.** Signing key for login tokens. Use `openssl rand -hex 32`. Rotating it invalidates every issued token. |

The backend uses `clientcmd.RecommendedHomeFile` (`~/.kube/config`) when not running in-cluster.

## Authentication

Cattery has username-password login with a JWT session token. Users are admin-managed — there is **no self-signup**.

**First-time setup**: on the very first start (when the `users` table is empty), the server auto-creates an admin account `admin` with a random password and logs it once:

```
================================================================
[auth] First-time admin account created:
[auth]   username: admin
[auth]   password: WEUUW-WCZXM-M4WNS-6RWAQ
[auth] Sign in and change the password from the user menu.
[auth] This message will NOT appear again.
================================================================
```

Capture the password from the logs, sign in, and change it. **Lost the password?** Reset it in Postgres (`UPDATE users SET password_hash = '<bcrypt>' WHERE username = 'admin'`) or wipe the `users` table to trigger a fresh bootstrap.

**Adding more users**: log in as admin → user menu → "User management" → "Add user". Users can change their own password from the user menu.

**Token lifetime is 7 days, with no server-side revocation** (no session table). Two practical implications:
- Logging out only clears the token from the browser. The token itself stays valid until expiry — keep `JWT_SECRET` confidential.
- Admin role changes propagate immediately for the affected user's *next* HTTP request that depends on `/auth/me`, but `/admin/*` endpoints accept the token's claim until it expires. **Plan up to a 7-day window for full role-change propagation.** To shorten this, lower the TTL in `internal/auth/jwt.go` or rotate `JWT_SECRET` (kicks everyone out).

Deleting a user cascades to their harnesses and sessions, and stops their K8s sandboxes; their existing token also becomes unusable on the next `/auth/me` probe (the frontend re-validates every 60 s).

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
