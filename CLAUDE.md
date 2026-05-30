# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cattery is a self-hosted, team-oriented AI coding agent platform. Each Agent template runs inside an isolated Kubernetes Sandbox Pod; users interact with the running agent through Sessions. The platform is harness-agnostic — `opencode`, `claude-code`, `codex`, etc. all sit behind a common HTTP contract and a translation layer that normalizes their event streams.

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
```

Go binary lives at `/usr/local/go/bin/go`; PATH typically does not include it, so prefer `make` targets or call the absolute path directly. Same for bun at `~/.bun/bin/bun`.

Backend env vars (see `backend/.env`, gitignored): `DATABASE_URL`, `PORT`, `K8S_NAMESPACE`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET` (required — signing key for login tokens; rotating it invalidates every issued session).

DB migrations live in `backend/internal/db/migrations/` and are applied automatically by the backend on startup via `goose`. Add a new numbered SQL file there rather than running migrations manually.

On first start with an empty `users` table, the server auto-creates an `admin` account with a random password and prints it once to stdout — there is no self-signup, so capture that line if you bring up a fresh DB.

## Architecture

Three pieces talk to each other:

```
web (Next.js + shadcn, bun)   →   backend (Go + Echo)   →   K8s Sandbox Pod
                                                            └─ harness container (e.g. opencode)
                                                            └─ external model API (anthropic/openai-compatible)
```

### Resource model: Agent vs Session vs Sandbox

- **Agent** — configuration template (model, prompt, harness_id, repo, env_vars). Owns a single long-lived sandbox.
- **Sandbox** — one K8s `agents.x-k8s.io/v1alpha1` Sandbox CR per Agent, named `cattery-<agent_id>`. Status lives on the Agent row (`sandbox_status`, `task_name`, `sandbox_url`).
- **Session** — a conversation inside an Agent's sandbox. Multiple sessions share one sandbox. Each Session has a `harness_session_id` returned by the harness's `POST /session`.

Creating a Session triggers `ensureSandbox` (`backend/internal/api/session_handler.go`): if the Agent's sandbox is `ready`, reuse; otherwise start the Sandbox CR, wait for `status.conditions[Ready]=True`, pick first IPv4 from `status.podIPs`, then handshake `POST /session` on the harness.

### Two harness kinds: HTTP vs Terminal

Harnesses register themselves through `backend/internal/harness/registry.go` as one of two kinds. `KindFor(harness_id)` decides which transport the session uses end-to-end.

- **`KindHTTP`** (e.g. `opencode`, `claude-code`) — harness exposes the HTTP contract below; events are translated to platform format and streamed as SSE.
- **`KindTerminal`** (e.g. `codex`, `hermes`) — harness wraps a TUI; the backend opens a WebSocket against the sandbox and proxies raw PTY bytes both directions. **No translator is used** for these.

The frontend picks `chat-panel.tsx` vs `terminal-view.tsx` based on the kind.

### Harness HTTP contract (KindHTTP only)

Every HTTP harness container must implement these endpoints on `agent.container_port` (default 4096):

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

1. Look up Session → Agent → `sandbox_url`.
2. Forward to harness: `POST /session/:harness_session_id/prompt_async` (returns 204 immediately).
3. Open SSE: `GET <sandbox_url>/event` on the harness.
4. For each event, run it through the harness's translator → write platform-format SSE frame to the response.
5. Stop when the **primary** session's `session.idle` arrives. Child sessions spawned by the `task` tool are tracked in `childSessions` so their events are also forwarded.

The response is itself an SSE stream; the frontend reads it directly from the `fetch` body, not via `EventSource`.

### Frontend event handling

`web/components/chat-panel.tsx` is the single point that consumes platform events. It maintains a `Bubble[]` list keyed by `partId` / `toolId`. **Do not** branch on harness-specific event types here — if you need new behavior, extend the platform protocol and update the translators.

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
