# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cattery is a self-hosted, team-oriented AI coding agent platform. Work is organized into **Projects** — shared workspaces with files and members. Users drive the agent through **Sessions**; each Project runs one isolated Kubernetes Sandbox Pod shared by all its sessions. There is a single agent: **pi** (`harnesses/pi`, built on `@earendil-works/pi-coding-agent` SDK). There is no Harness entity and no harness-type selection — "harness" only names the agent process/image and the Go package that speaks its HTTP contract.

Target deployment: self-hosted Kubernetes, internal-only (no SSO/audit yet). Models come from a platform-level catalog, `backend/models.toml` (gitignored; template `models.example.toml`): one `[[providers]]` entry per provider with its endpoint, key and models. Users can only pick catalog models — there are no custom model ids.

## Common commands

All run from the repo root.

```bash
make dev                          # backend (:8080) + frontend (:3000) together
make dev-back                     # backend only, sources backend/.env
make dev-front                    # Next.js dev on :3000 (bun)
make build                        # compile Go server to backend/bin/server
make stop                         # kill :8080 and :3000
make build-harness                # build the pi agent image (cattery-pi:dev)
make build-pod                    # build filemgr and skillmgr images (filemgr, skillmgr)
make build-pod POD=filemgr        # build a single Pod image (filemgr | skillmgr)

make docker-db                    # local Postgres via docker compose (also: docker-up | docker-down | docker-reset-db)

go test ./...                     # backend tests (only internal/model has tests today)
go test ./internal/model -run TestName   # a single test
cd web && bun lint                # frontend lint (eslint); no frontend test suite
cd harnesses/pi && npm run typecheck     # pi harness typecheck
```

There is no `make test`/`make lint` target — run the toolchain directly as above. `go` and `bun` are on `PATH` (Homebrew, `/opt/homebrew/bin`) and the Makefile resolves both with `which`, so prefer `make` targets; if you call the toolchain directly and it isn't found, use `$(which go)` / `$(which bun)` rather than a hardcoded path.

Backend env vars (see `backend/.env`, gitignored): `DATABASE_URL`, `PORT`, `K8S_NAMESPACE`, `MODELS_CONFIG` (path of the model catalog; default `models.toml`), `JWT_SECRET` (required — signing key for login tokens; rotating it invalidates every issued session), `K8S_STORAGE_CLASS` (PVC `storageClassName`; empty = cluster default), `K8S_PVC_ACCESS_MODE` (PVC access mode; defaults to `ReadWriteMany`, set to `ReadWriteOnce` on block-backed storage classes that only support single-node mounts).

DB migrations live in `backend/internal/db/migrations/` and are applied automatically by the backend on startup via `goose`. Add a new numbered SQL file there rather than running migrations manually.

On first start with an empty `users` table, the server auto-creates an `admin` account with a random password and prints it once to stdout — there is no self-signup, so capture that line if you bring up a fresh DB.

## Architecture

Three pieces talk to each other:

```
web (Next.js + shadcn, bun)   →   backend (Go + Echo)   →   K8s Sandbox Pod (one per project)
                                                            └─ pi agent (harnesses/pi)
                                                            └─ model providers (endpoint + key from models.toml)
```

### Resource model: Project → Session

- **Project** — shared workspace owned by a user, with its own PVC-backed file workspace (shared by pi and filemgr containers in one Pod) and one agent sandbox (`projects.sandbox_status`: idle | starting | ready | failed). Access is two roles only — `owner` and `member` (`model.AccessOwner` / `model.AccessMember`); there is no viewer/editor tier, and added members are always written as `member`. Role currently grants all-or-nothing access: `requireWritableSession` is just an alias for `requireReadableSession`, so read/write are not yet differentiated. Deleting a Project tears down its shared Sandbox Pod and workspace PVC.
- **Sandbox** — one K8s `agents.x-k8s.io/v1beta1` Sandbox CR per Project, named `cattery-sandbox-<projectID>`. Its Pod runs pi (`cattery-pi:dev`, port 1114) and filemgr (`cattery-filemgr:dev`, port 1115), with `restartPolicy: Always` and a shared workspace PVC at `/home/cattery`. `EnsureProject` provisions it at project creation or lazily on access. `EnsureReady` activates the agent and updates status. `Stop` calls pi's `/stop` to abort and release sessions without deleting the Pod; `Destroy` deletes project resources. URLs resolve from each container's readiness through `ResolveContainerURL`, so a restarting agent does not block file browsing. Failed agent startup keeps the Pod alive. See README for migration of existing single-container Sandboxes.
- **Session** — a conversation with the agent, carrying its own `model`. The platform `session_id` maps to an SDK JSONL transcript at `/home/cattery/.cattery/sessions/<id>.jsonl` and a small version-2 metadata file at `<id>.json` (model selection and title-attempt state). The SDK owns its internal session id, message persistence, compaction, and retry. Old JSON transcripts are not migrated; delete obsolete sessions and create new ones. Frontend history is rebuilt from the full SDK branch, not the compacted model context.

Creating a Session kicks off `bringUp` (`backend/internal/api/session_handler.go`): `EnsureReady` the project sandbox, then `POST /session {id, model, provider, baseUrl, apiKey}` on the agent. The session's `status` goes `creating → ready | failed`; `phase` says where it failed. `SendMessage` re-registers the session (idempotent) before every prompt, so a lost transcript degrades to an empty session instead of a 404.

The workspace is the agent user's home (`~`): the pi process, SDK tools, terminal
and file browser share `/home/cattery`. The image entrypoint seeds only missing
shell configuration from `/etc/skel`. Global skills are mounted read-only outside
home at `/cattery/global-skills`; project skills remain writable in
`~/.agents/skills`. Existing `/work` Sandbox layouts need recreation with their
PVCs retained, as described in README. Old conversation paths are not rewritten.

### Models and providers

The catalog is loaded at startup by `config.LoadModels` (`backend/internal/config/models.go`); model ids must be unique across providers, and the session row stores only the id. Each provider's `type` is a pi-ai provider id (`deepseek` | `anthropic` | `openai`, or `custom` for any other OpenAI-compatible endpoint). The agent keeps pi's built-in catalog entry for the model (context window, thinking map, DeepSeek compat flags like `reasoning_content` replay) and only swaps `baseUrl` to the provider's endpoint. Reusing the built-in provider id matters — pi auto-detects DeepSeek quirks from the provider id or a `deepseek.com` URL, and a gateway URL never matches.

Endpoints and keys are not in the sandbox env: `ensureAgentSession` sends the session's model with its provider's endpoint and key on every `POST /session`, and the agent holds them in memory only (never in the transcript). The frontend reads the catalog from `GET /api/v1/models` (provider names + model ids, no keys). New sessions start on the last-picked model (or the catalog `default`); the chat composer's `ModelPicker` switches it via `PATCH /sessions/:id {model}`, and the switch reaches the agent on the next prompt's re-register. Add a model or provider by editing `models.toml` and restarting the backend. Top-level `small_model` references a catalog model for lightweight tasks (defaults to `default`, independent of the session model). The harness uses it once after the first successful response to generate a session title; failure preserves the fallback title. Automatic titles are accepted only when `title_manual` is false. Accepted titles and manual renames call `AgentSession.setSessionName()` through `PATCH /session/:id/name`, then store the normalized name in the database for the UI. `SessionStore.SyncTitle` holds a row lock across synchronization to serialize name changes. Registration repairs the native name from the current database title; manual renames await the sandbox and report synchronization failures.

### Agent HTTP contract

The pi harness implements, on `sandbox.Port` (1114):

```
GET    /session                        → [id]   (readiness probe)
POST   /session {id, model, provider, baseUrl, apiKey}
                                       → { id }  (idempotent: reopens an existing transcript;
                                                  a different model/endpoint switches it)
DELETE /session/:id                    → 204    (abort + delete transcript)
PATCH  /session/:id/name {name}       → { name } (native pi session name)
GET    /session/:id/message            → PlatformHistoryItem[]
POST   /session/:id/prompt_async       → 204    (fire-and-forget; 409 if the session is busy)
POST   /session/:id/abort              → 204
GET    /event                          → SSE: {"sessionId", "type", "data"} platform events
```

The backend calls these from `backend/internal/harness/client.go`. The harness embeds `createAgentSession` with an isolated, memory-only `ModelRuntime` per platform session. `DefaultResourceLoader` loads skills, prompt templates, and project instructions; `SessionManager` persists messages and manages context compaction. SDK automatic retries and compaction remain enabled. File-based extensions and themes are disabled in this headless host. Skills include the read-only `/cattery/global-skills` mount (or `SKILLS_DIR`) and project `.agents/skills`, alongside SDK default discovery. Resources refresh when a session is loaded.

The SDK's built-in tools are enabled directly: read, write, edit, bash, grep, find, ls. There are no Cattery wrappers, aliases, output parsers, or timeout overrides for these built-in tools. A custom `questionnaire` tool matches pi's questionnaire example shapes and waits for web responses through `POST /session/:id/questionnaire/:toolId`; the platform route checks project membership. The chat renders single or multiple questions, custom answers, review, cancellation, and persisted answers. History includes `session.state` with `busy` so disconnected clients can poll until the run completes. Tool execution, schemas, defaults, and truncation follow pi. Cattery forwards official text output and details through its HTTP/SSE protocol; the web UI displays text output directly. Grep uses ripgrep and find uses fd, both installed in the container.

### Platform event protocol

**This is the core abstraction.** The agent emits these directly (no translator); the backend only filters by `sessionId` and forwards them to the frontend. Defined in `backend/internal/harness/event.go`:

```
{ type: "message.delta",      data: { partId, text } }     // streaming text chunk
{ type: "message.thinking",   data: { partId, text } }     // streaming thinking chunk (optional)
{ type: "message.thinking.done", data: { partId, durationMs } } // thinking block ended (agent-timed)
{ type: "tool.start",         data: { toolId, tool, input } }
{ type: "tool.done",          data: { toolId, tool, output, parsed? } }
{ type: "session.title",      data: { title } }            // session title generated/updated
{ type: "session.usage",      data: { contextTokens, contextWindow, reserveTokens, tokens, userMessages, toolCalls } } // after each turn/compaction and in history
{ type: "session.idle",       data: {} }                   // closes the stream
{ type: "session.error",      data: { message } }
```

`partId` / `toolId` are stable IDs: the frontend appends `message.delta` text to the bubble keyed by `partId`, and updates the bubble keyed by `toolId` when `tool.done` arrives. The agent derives partIds from the assistant message timestamp + content index, so live stream and history replay agree. pi has no per-block thinking time, so the agent times each block between `thinking_start` and `thinking_end` and stores it as a `cattery.thinking` custom transcript entry (never sent to the model); history replays it as `message.thinking.done`.

### Request flow for sending a message

`POST /api/v1/sessions/:id/message`:

1. Look up Session → Project; `sandbox.Await` the project sandbox (restarts it if stopped; the start runs detached so a client disconnect doesn't cancel it).
2. `POST /session` (idempotent re-register), then subscribe to `GET <sandboxURL>/event` before sending `POST /session/:id/prompt_async` (returns 204 immediately).
3. Forward this session's events as platform-format SSE frames; persist accepted `session.title` events to the DB before forwarding, rejecting automatic names when the user has manually renamed the session.
4. Stop at the session's `session.idle`.

The response is itself an SSE stream; the frontend reads it directly from the `fetch` body, not via `EventSource`.

### Frontend event handling

`web/components/chat-panel.tsx` + `web/lib/chat-stream-store.ts` are the single point that consumes platform events. They maintain a `Bubble[]` list keyed by `partId` / `toolId`. If you need new behavior, extend the platform protocol and emit it from the agent.

### Auth

Stateless HS256 JWT (`backend/internal/auth/jwt.go`), 7-day TTL, no server-side revocation — the token is the source of truth until expiry (demoting an admin only takes effect on the next token). Every route except `POST /auth/login` sits behind `AuthMiddleware` (`auth_middleware.go`), which accepts the bearer token from the `Authorization: Bearer` header or, failing that, a `?token=` query param (for `<img>`/`<iframe>`/download URLs that can't set headers; redacted from access logs). Admin-only routes layer `AdminOnly` on top.

### The filemgr container (per-project file manager)

`filemgr` powers the file browser and LaTeX previews. It is the second container
in the project's Sandbox Pod, sharing `/home/cattery` with pi and exposing port 1115.
Its image remains in `pods/filemgr/`, built with `make build-pod POD=filemgr`.
`FilesHandler` uses `sandbox.Manager.FileURL`, which waits only for filemgr's
readiness. Stopping agent sessions keeps file access available. The old
`cattery-filemgr-<projectID>` Pod name is retained only for migration cleanup.
The shared Pod spec lives in `backend/internal/k8s/client.go`.

### The web terminal

`GET /projects/:id/terminal?terminal=<uuid>` is a WebSocket (`backend/internal/api/terminal_handler.go`) that execs `tmux new-session -A -s <uuid>` in `/home/cattery` inside the project Pod's `agent` container via the K8s exec API (`k8s.Client.Exec`, WebSocket protocol with SPDY fallback; RBAC grants `pods/exec`). The tmux session outlives the WebSocket, so reconnecting (or reloading the page) reattaches the same shell and its running commands; `DELETE /projects/:id/terminals/:uuid` kills it. tmux and its config (`harnesses/pi/tmux.conf`: no status bar, mouse scrolling, OSC 52 clipboard) ship in the pi image; the Pod's `hostname` is `sandbox`, so prompts read `cattery@sandbox:~$`. It only needs the container running (`sandbox.Manager.TerminalPod`), not a ready agent. Binary frames carry terminal bytes both ways; the client sends `{"type":"resize","cols","rows"}` text frames; the server closes 1000 on shell exit, 1011 with a reason on failure. Auth is `?token=` like file URLs. In the UI, terminals are sidebar items (the Terminals view, `terminal-list-panel.tsx`) that open as main-pane tabs at `/terminals/<projectId>/<id>`. The route page renders nothing; `TerminalHost` in the workspace layout draws every started shell (`terminal-view.tsx`, xterm.js) over the main pane, so shells survive tab switches. Closing a tab keeps the shell; deleting the terminal ends it. The list is persisted in `lib/terminal-store.ts`; after a reload, opening a terminal reattaches its tmux session (gone only if the container restarted). Ctrl+\` opens the project's newest terminal.

### The skillmgr Pod (global skill library)

`skillmgr` is the storage backend for the global skill library that powers `web/components/skill-browser-panel.tsx` and the per-skill view. It runs as a **single cluster-wide Pod** (`cattery-skillmgr`), not per-project, serving a `<slug>/SKILL.md (+assets)` tree that every agent sandbox mounts read-only. The image lives under `pods/skillmgr/`; specs and constants in `backend/internal/sandbox/manager.go` and `backend/internal/k8s/client.go` (`EnsureSkillMgrPod`). Skills are uploaded as `.zip` archives via the catalog endpoints; the frontend treats one top-level `<slug>/` directory as one skill. Sandboxes mount the same skills PVC at `/cattery/global-skills` (`sandbox.SkillsMountPath`).

### Notes for the frontend

This Next.js version has breaking changes from training-data knowledge. When touching frontend code, consult `node_modules/next/dist/docs/` first; do not assume App Router APIs match older Next.js conventions. shadcn components here use the Base UI style (`base-nova` in `components.json`, built on `@base-ui/react`), not Radix: compose triggers with the `render` prop (`<TooltipTrigger render={<Button />}>`), not `asChild`. `cn` comes from shadcn's `cn` package (re-exported by `lib/utils.ts`). The chat (`chat-panel.tsx`) follows the shadcn AI Elements patterns (Message Scroller, Message, Bubble, Trace, Code Block, Input Group); `lib/code-highlighter.tsx` backs `ui/code-block`, separate from `lib/highlighter.ts` used by the file viewer and markdown. TypeScript stays on 6.x until typescript-eslint supports 7. Zustand selectors must return stored references (or primitives) — a selector that builds a fresh object each call re-renders forever.

# Collaboration
List Claude as a co-author when committing.
