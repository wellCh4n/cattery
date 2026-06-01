# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cattery is a self-hosted, team-oriented AI coding agent platform. Work is organized into **Projects** — shared workspaces with files and members. Each Project holds one or more **Harnesses** (agent templates); each Harness runs inside an isolated Kubernetes Sandbox Pod that users drive through **Sessions**. The platform is harness-agnostic — `opencode`, `claude-code`, `codex`, etc. all sit behind a common contract and a translation layer that normalizes their event streams.

Target deployment: self-hosted Kubernetes, internal-only (no SSO/audit yet). Models are reached via an external OpenAI- or Anthropic-compatible gateway (e.g. NewAPI), NOT LiteLLM.

## Common commands

All run from the repo root.

```bash
make dev                          # backend (:8080) + frontend (:3000) together
make dev-back                     # backend only, sources backend/.env
make dev-front                    # Next.js dev on :3000 (bun)
make build                        # compile Go server to backend/bin/server
make stop                         # kill :8080 and :3000
make build-harness                # build all four harness images
make build-harness HARNESS=codex  # build a single harness (opencode | claude-code | codex | hermes)
make build-pod                    # build all standalone Pod images (filemgr, skillmgr)
make build-pod POD=filemgr        # build a single Pod image (filemgr | skillmgr)

make docker-db                    # local Postgres via docker compose (also: docker-up | docker-down | docker-reset-db)

go test ./...                     # backend tests (only internal/model has tests today)
go test ./internal/model -run TestName   # a single test
cd web && bun lint                # frontend lint (eslint); no frontend test suite
```

There is no `make test`/`make lint` target — run the toolchain directly as above. `go` and `bun` are on `PATH` (Homebrew, `/opt/homebrew/bin`) and the Makefile resolves both with `which`, so prefer `make` targets; if you call the toolchain directly and it isn't found, use `$(which go)` / `$(which bun)` rather than a hardcoded path.

Backend env vars (see `backend/.env`, gitignored): `DATABASE_URL`, `PORT`, `K8S_NAMESPACE`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET` (required — signing key for login tokens; rotating it invalidates every issued session), `K8S_STORAGE_CLASS` (PVC `storageClassName`; empty = cluster default), `K8S_PVC_ACCESS_MODE` (PVC access mode; defaults to `ReadWriteMany`, set to `ReadWriteOnce` on block-backed storage classes that only support single-node mounts).

DB migrations live in `backend/internal/db/migrations/` and are applied automatically by the backend on startup via `goose`. Add a new numbered SQL file there rather than running migrations manually.

On first start with an empty `users` table, the server auto-creates an `admin` account with a random password and prints it once to stdout — there is no self-signup, so capture that line if you bring up a fresh DB.

## Architecture

Three pieces talk to each other:

```
web (Next.js + shadcn, bun)   →   backend (Go + Echo)   →   K8s Sandbox Pod
                                                            └─ harness container (e.g. opencode)
                                                            └─ external model API (anthropic/openai-compatible)
```

### Resource model: Project → Harness → Sandbox → Session

- **Project** — shared workspace owned by a user, with its own PVC-backed file workspace (served by a per-project filemgr Pod). Access is two roles only — `owner` and `member` (`model.AccessOwner` / `model.AccessMember`); there is no viewer/editor tier, and added members are always written as `member`. Role currently grants all-or-nothing access: `requireWritableSession` is just an alias for `requireReadableSession`, so read/write are not yet differentiated. Harnesses live inside a Project; deleting a Project tears down its harness sandboxes, filemgr Pod, and workspace PVC.
- **Harness** — configuration template (model, prompt, `type` = harness_id, repo, env_vars) scoped to a Project. Owns a single long-lived sandbox; `sandbox_status` (+ `task_name`) lives on the Harness row. The pod URL is **not** persisted — it's the ephemeral pod IP, resolved live from K8s on each connection (`Manager.URL` → `k8sClient.ResolveURL`). Handlers/store use `harness_id`, never `agent_id` — there is no "Agent" entity in the code.
- **Sandbox** — one K8s `agents.x-k8s.io/v1alpha1` Sandbox CR per Harness, named `cattery-<harnessID>` (HTTP kinds) or `cattery-<type>-<harnessID>` (terminal kinds), per `sandbox/manager.go`. Note the `agents.x-k8s.io` API group is the upstream Agent Sandbox controller — unrelated to Cattery's own resource naming.
- **Session** — a conversation inside a Harness's sandbox. Multiple sessions share one sandbox. Each Session has a `harness_session_id` returned by the harness's `POST /session`.

Creating a Session kicks off `bringUp` (`backend/internal/api/session_handler.go`), which calls `sandbox.Manager.EnsureReady` (`backend/internal/sandbox/manager.go`): if the Harness's sandbox is `ready`, resolve its current URL live from K8s; otherwise start the Sandbox CR, wait for `status.conditions[Ready]=True`, pick the first IPv4 from `status.podIPs`, then handshake `POST /session` on the harness. Because the URL is always resolved fresh (never cached in the DB), a rescheduled pod's new IP is picked up automatically — there's no stale-URL footgun.

### Two harness kinds: HTTP vs Terminal

Harnesses register themselves through `backend/internal/harness/registry.go` as one of two kinds. `KindFor(harness_id)` decides which transport the session uses end-to-end.

- **`KindHTTP`** (e.g. `opencode`, `claude-code`) — harness exposes the HTTP contract below; events are translated to platform format and streamed as SSE.
- **`KindTerminal`** (e.g. `codex`, `hermes`) — harness wraps a TUI; the backend opens a WebSocket against the sandbox and proxies raw PTY bytes both directions. **No translator is used** for these.

The frontend picks `chat-panel.tsx` vs `terminal-view.tsx` based on the kind.

### Harness HTTP contract (KindHTTP only)

Every HTTP harness container must implement these endpoints on the harness container port (default 4096; `sandbox.Port`):

```
POST /session                          → { id }
POST /session/:id/prompt_async         → 204 (fire-and-forget)
GET  /session/:id/message              → history
POST /session/:id/abort
GET  /event                            → SSE stream of all events
```

The backend calls these from `backend/internal/harness/client.go`.

### Platform event protocol (KindHTTP only)

**This is the core abstraction for HTTP harnesses.** They emit their own event formats; per-harness translators normalize them to a uniform shape before sending to the frontend. Frontend only knows the platform shape.

Defined in `backend/internal/harness/event.go`:

```
{ type: "message.delta",      data: { partId, text } }     // streaming text chunk
{ type: "message.thinking",   data: { partId, text } }     // streaming thinking chunk (optional)
{ type: "tool.start",         data: { toolId, tool, input } }
{ type: "tool.done",          data: { toolId, tool, output, parsed? } }
{ type: "question.asked",     data: { ... } }              // model asks the user a question
{ type: "question.answered",  data: { ... } }              // user answered (UI state replay)
{ type: "session.title",      data: { title } }            // session title generated/updated
{ type: "session.idle",       data: {} }                   // closes the stream
{ type: "session.error",      data: { message } }
```

`partId` / `toolId` are stable IDs: the frontend appends `message.delta` text to the bubble keyed by `partId`, and updates the bubble keyed by `toolId` when `tool.done` arrives.

### Adding a harness

Each harness lives in its own subpackage under `backend/internal/harness/<name>/` and self-registers via `init()`. The packages are pulled in by blank import from `session_handler.go`. Note: Go package names can't contain `-`, so the harness ID `claude-code` lives in package `claudecode/` — registered with the hyphenated ID via `harness.Register("claude-code", …)`.

- **HTTP harness**: write `<name>/translator.go` (stream events from `GET /event`) and `<name>/history.go` (replay from `GET /session/:id/message`), then call `harness.Register(id, stream, history)` in `init()`. See `harness/opencode/`.
- **Terminal harness**: just call `harness.RegisterTerminal(id)` in `init()`. The session is served via WebSocket at `GET /api/v1/sessions/:id/term` (`session_handler.Term`, backed by `term_handler.go`); no translator code is needed. See `harness/codex/register.go` and `harness/hermes/register.go`.

### Request flow for sending a message (KindHTTP)

`POST /api/v1/sessions/:id/message`:

1. Look up Session → Harness, then resolve the sandbox URL live from K8s (`Manager.URL`).
2. Forward to harness: `POST /session/:harness_session_id/prompt_async` (returns 204 immediately).
3. Open SSE: `GET <sandboxURL>/event` on the harness.
4. For each event, run it through the harness's translator → write platform-format SSE frame to the response.
5. Stop when the **primary** session's `session.idle` arrives. Child sessions spawned by the `task` tool are tracked in `childSessions` so their events are also forwarded.

The response is itself an SSE stream; the frontend reads it directly from the `fetch` body, not via `EventSource`.

### Frontend event handling

`web/components/chat-panel.tsx` is the single point that consumes platform events. It maintains a `Bubble[]` list keyed by `partId` / `toolId`. **Do not** branch on harness-specific event types here — if you need new behavior, extend the platform protocol and update the translators.

### Auth

Stateless HS256 JWT (`backend/internal/auth/jwt.go`), 7-day TTL, no server-side revocation — the token is the source of truth until expiry (demoting an admin only takes effect on the next token). Every route except `POST /auth/login` sits behind `AuthMiddleware` (`auth_middleware.go`), which accepts the bearer token from **three** transports, in order: `Authorization: Bearer` header, `?token=` query param (for `<img>`/`<iframe>`/download URLs that can't set headers), or the `Sec-WebSocket-Protocol` header paired with the `cattery.bearer` marker (terminal WS upgrade — keeps the token out of access logs). Admin-only routes layer `AdminOnly` on top.

### The filemgr Pod (per-project file manager)

`filemgr` is the file browser/upload backend that powers `web/components/file-browser-panel.tsx`. It is **not** a sidecar in the Sandbox CR — it runs as its own standalone Pod, one per project, named `cattery-filemgr-<projectID>` (`EnsureFileMgrPod` in `backend/internal/k8s/client.go`). Its image lives under `pods/filemgr/` and is built with `make build-pod`.

- **Lifecycle is tied to the project, not the sandbox.** The Pod (and the workspace PVC) is created when the project is created (`project_handler.go`), so file browse/upload works even when no harness sandbox is running. `files_handler.go` also lazy-creates it as a fallback on the first `/files` request, for recovered or pre-existing projects.
- It mounts the project's workspace PVC at `/work` — the same PVC the harness sandbox reuses, but a separate Pod.
- The backend proxies `/projects/:id/files/*` to the Pod IP on `FileMgrPort`, so the frontend never needs the in-cluster IP (`files_handler.go`).
- When changing it, update the Pod spec in `backend/internal/k8s/client.go` (and `backend/internal/sandbox/manager.go` for names/ports/image) plus the image build under `pods/filemgr/`.

### The skillmgr Pod (global skill library)

`skillmgr` is the storage backend for the global skill library that powers `web/components/skill-browser-panel.tsx` and the per-skill view. It runs as a **single cluster-wide Pod** (`cattery-skillmgr`), not per-project, serving a `<slug>/SKILL.md (+assets)` tree that any harness sandbox can mount. The image lives under `pods/skillmgr/`; specs and constants in `backend/internal/sandbox/manager.go` and `backend/internal/k8s/client.go` (`EnsureSkillMgrPod`). Skills are uploaded as `.zip` archives via the catalog endpoints; the frontend treats one top-level `<slug>/` directory as one skill. Sandboxes mount the same skills PVC so harnesses auto-discover the library.

### Notes for the frontend

This Next.js version has breaking changes from training-data knowledge. When touching frontend code, consult `node_modules/next/dist/docs/` first; do not assume App Router APIs match older Next.js conventions. shadcn `Dialog` uses `@base-ui/react` here, so `DialogTrigger` takes `render={<Button/>}` rather than `asChild`.

# Collaboration
List Claude as a co-author when committing.
