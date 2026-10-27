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
make build-harness                # build the pi agent image (cattery-pi:dev; also serves files + previews)

make docker-db                    # local Postgres via docker compose (also: docker-up | docker-down | docker-reset-db)

cd backend && go test ./...       # backend tests (the Go module lives in backend/)
cd backend && go test ./internal/api -run TestName   # a single test
cd web && bun lint                # frontend lint (eslint)
cd web && bun test lib/           # frontend unit tests (node:test files in web/lib; no package.json script)
cd harnesses/pi && npm test       # pi harness tests (harnesses/pi/test)
cd harnesses/pi && npm run typecheck     # pi harness typecheck
```

There is no `make test`/`make lint` target — run the toolchain directly as above. `go` and `bun` are on `PATH` (Homebrew, `/opt/homebrew/bin`) and the Makefile resolves both with `which`, so prefer `make` targets; if you call the toolchain directly and it isn't found, use `$(which go)` / `$(which bun)` rather than a hardcoded path.

Backend env vars (see `backend/.env`, gitignored): `DATABASE_URL`, `PORT`, `K8S_NAMESPACE` (default `default`; must be `cattery` to match the RBAC `deploy/cluster/` creates), `MODELS_CONFIG` (path of the model catalog; default `models.toml`), `JWT_SECRET` (required — signing key for login tokens; rotating it invalidates every issued session), `K8S_STORAGE_CLASS` (PVC `storageClassName`; empty = cluster default), `K8S_PVC_ACCESS_MODE` (PVC access mode; defaults to `ReadWriteMany`, set to `ReadWriteOnce` on block-backed storage classes that only support single-node mounts), `PREVIEW_URL` (preview host template; defaults to `http://*.localhost:<PORT>`; see Port previews), `PI_IMAGE` (the project Pod image; defaults to the local `cattery-pi:dev` `make build-harness` builds), `SKILLS_DIR` (the global skill library; default `data/skills`, i.e. `backend/data/skills` under `make dev`).

Cluster prerequisites (the Agent Sandbox controller, the `cattery` namespace, the backend's RBAC) are a separate kustomize bundle, `kubectl apply -k deploy/cluster/`, needed by local development too. Running Cattery itself on Kubernetes: `deploy/` is a kustomize bundle (`kubectl apply -k deploy/`) — one single-replica StatefulSet whose Pod holds the backend and web containers (the backend mounts PVC `cattery-skills-work` as `SKILLS_DIR`), behind a Traefik Ingress routing `/api` and the preview hosts to the backend and the rest to the web. Postgres is external. Production web builds call `/api` on their own origin (`NEXT_PUBLIC_API_URL` unset), so the web image needs no build args.

DB migrations live in `backend/internal/db/migrations/` and are applied automatically by the backend on startup via `goose`. Add a new numbered SQL file there rather than running migrations manually.

On first start with an empty `users` table, the server auto-creates an `admin` account with a random password and logs it once (Go `log`, i.e. stderr) — there is no self-signup, so capture that line if you bring up a fresh DB.

## Architecture

Three pieces talk to each other:

```
web (Next.js + shadcn, bun)   →   backend (Go + Echo)   →   K8s Sandbox Pod (one per project)
                                                            └─ pi agent (harnesses/pi)
                                                            └─ model providers (endpoint + key from models.toml)
```

### Resource model: Project → Session

- **Project** — shared workspace owned by a user, with its own PVC-backed file workspace (mounted by the project Pod's single pi container) and one agent sandbox (`projects.sandbox_status`: idle | starting | ready | failed). Access is two roles only — `owner` and `member` (`model.AccessOwner` / `model.AccessMember`); there is no viewer/editor tier, and added members are always written as `member`. Sessions are private to their creator: `requireWritableSession` (send, abort, withdraw, questionnaire answers, model/effort, rename, delete) requires `created_by_user_id` to be the caller, or the project owner for sessions without a creator; other members only read and follow them live. The web mirrors this with `canWriteSession` (`lib/workspace-store.ts`), replacing the composer with a read-only notice. Any member who can read a session may fork it (`POST /sessions/:id/fork {before?}`): the copy belongs to whoever forked it, keeps the source's model and effort, and holds the whole conversation or, with `before` (a user message's history `messageId`), only what precedes that message. The chat offers this on each finished reply, in the sidebar, and in the read-only notice. Deleting a Project tears down its shared Sandbox Pod and workspace PVC.
- **Sandbox** — one K8s `agents.x-k8s.io/v1beta1` Sandbox CR per Project, named `cattery-sandbox-<projectID>`. Its Pod runs one container, `agent` (pi, `PI_IMAGE`, port 1114), which also serves the workspace files and previews, with `restartPolicy: Always` and the workspace PVC at `/home/cattery`. `EnsureProject` provisions it at project creation or lazily on access. `EnsureReady` ensures the Pod, waits for the `agent` container and for `GET /session` to answer, and updates `sandbox_status`; it activates no sessions (pi opens them lazily). `Stop` calls pi's `/stop` to abort and release sessions without deleting the Pod; `Destroy` deletes project resources. File URLs resolve from the agent container's readiness through `ResolveContainerURL` (`GET /session` answers as soon as pi listens), without activating sessions; files are unavailable while pi restarts. Failed agent startup keeps the Pod alive. Sandboxes with a separate filemgr container are rejected as legacy; see README for the migration.
- **Session** — a conversation with the agent, carrying its own `model`. The platform `session_id` maps to an SDK JSONL transcript at `/home/cattery/.cattery/sessions/<id>.jsonl` and a small version-2 metadata file at `<id>.json` (model selection and title-attempt state). The SDK owns its internal session id, message persistence, compaction, and retry. Old JSON transcripts are not migrated; delete obsolete sessions and create new ones. Frontend history is rebuilt from the full SDK branch, not the compacted model context.

Creating a Session kicks off `bringUp` (`backend/internal/api/session_handler.go`): `EnsureReady` the project sandbox, then `POST /session` on the agent (see Agent HTTP contract). The session's `status` goes `creating → ready | failed`; `phase` says where it failed. `SendMessage` re-registers the session (idempotent) before every prompt, so a lost transcript degrades to an empty session instead of a 404.

The workspace is the agent user's home (`~`): the pi process, SDK tools, terminal
and file browser share `/home/cattery`. The image entrypoint seeds only missing
shell configuration from `/etc/skel`. The global skill library is not mounted:
skills are installed (copied) into the project's writable `~/.agents/skills`,
the only skill path pi adds. Existing `/work` Sandbox layouts need recreation with their
PVCs retained, as described in README. Old conversation paths are not rewritten.

### Models and providers

The catalog is loaded at startup by `config.LoadModels` (`backend/internal/config/models.go`); model ids must be unique across providers, and the session row stores only the id. Each provider's `type` is a pi-ai provider id (`deepseek` | `anthropic` | `openai`, or `custom` for any other OpenAI-compatible endpoint). The agent keeps pi's built-in catalog entry for the model (context window, thinking map, DeepSeek compat flags like `reasoning_content` replay) and only swaps `baseUrl` to the provider's endpoint. A model pi's catalog lacks (and every `custom` one) gets generic defaults instead: reasoning on, 128k context, 32k max tokens. Reusing the built-in provider id matters — pi auto-detects DeepSeek quirks from the provider id or a `deepseek.com` URL, and a gateway URL never matches. A provider's optional `api` (`openai-completions` | `openai-responses` | `anthropic-messages`) overrides only the model's wire protocol, keeping the rest of its catalog entry; the example catalog sets `openai-responses` for DeepSeek, since over chat completions pi-ai closes thinking blocks only once the whole response ends.

Endpoints and keys are not in the sandbox env: `ensureAgentSession` sends the session's model and the `small_model`, each with its provider's endpoint and key, plus the session's effort as `thinkingLevel`, on every `POST /session`, and the agent holds them in memory only (never in the transcript). The frontend reads the catalog from `GET /api/v1/models` (`{default, providers: [{name, models, efforts, default_effort}]}`, no keys). Each provider's optional `efforts` lists the pi thinking levels its models offer (`off` … `max`, default `low, medium, high`); a new session starts on the last-picked effort when its provider offers it, else the provider's default (`high` if offered, else the highest), and the composer switches it via `PATCH /sessions/:id {effort}`. New sessions start on the last-picked model (or the catalog `default`); the chat composer's `ModelPicker` switches it via `PATCH /sessions/:id {model}`, and the switch reaches the agent on the next prompt's re-register. Add a model or provider by editing `models.toml` and restarting the backend. Top-level `small_model` references a catalog model for lightweight tasks (defaults to `default`, independent of the session model). Like Codex, the harness uses it once per session to name it from the first request alone, in parallel with the reply: an imperative title for a task or a noun phrase otherwise (a greeting, a question), at most 36 characters, returned as JSON `{title}` (a `json_schema` response format on `openai-responses`). The run holds `session.idle` until the title settles, since only the starting stream persists titles; failure preserves the fallback title (the request's first line), and an aborted run retries on its next prompt. Automatic titles are accepted only when `title_manual` is false. Accepted titles and manual renames call `AgentSession.setSessionName()` through `PATCH /session/:id/name`, then store the normalized name in the database for the UI. `SessionStore.SyncTitle` holds a row lock across synchronization to serialize name changes. Registration repairs the native name from the current database title; manual renames await the sandbox and report synchronization failures.

### Agent HTTP contract

The pi harness implements, on `sandbox.Port` (1114):

```
GET    /session                        → [id]   (readiness probe)
POST   /session {id, model, provider, api?, baseUrl, apiKey, thinkingLevel, smallModel}
                                       → { id }  (idempotent: reopens an existing transcript;
                                                  a different model/api/endpoint switches it;
                                                  smallModel is a full {model, provider, api?, baseUrl, apiKey})
GET    /session/:id                    → { id, name }
DELETE /session/:id                    → 204    (abort + delete transcript)
PATCH  /session/:id/name {name}       → { name } (native pi session name)
POST   /session/:id/fork {id, before?} → { id }  (copy the branch, or the part before user message `before`, into session id)
GET    /session/:id/message            → PlatformHistoryItem[]  (session.state carries the snapshot's seq)
POST   /session/:id/prompt_async       → 204 (run started) | 202 (session busy: steered into the run)
DELETE /session/:id/queue/:index {text} → { messages }  (withdraw a steered message; 409 once delivered)
POST   /session/:id/abort              → 204
POST   /session/:id/questionnaire/:toolId → 204  (answer a pending questionnaire; 409 once it no longer waits)
POST   /stop                           → 204    (abort and release every session; Pod stays)
GET    /event                          → SSE: {"sessionId", "seq", "type", "data"} platform events
GET    /ports                          → [{port, pid?, command?, startedAt?}]  (listening apps, see Port previews)
DELETE /ports/:port                    → { forced }  (stop the app: SIGTERM, then SIGKILL after 3s)
GET    /usage?offset=<bytes>           → { records, offset, more }  (token usage ledger, see Token usage)
/list /read /save /raw /download /upload /touch /delete /rename /move /mkdir /extract /latex
                                       → the workspace files (see Project files)
*      /proxy/<port>/<path>            → the server on localhost:<port>, HTTP and WebSocket (see Port previews)
```

The backend calls these from `backend/internal/harness/client.go`. The harness embeds `createAgentSession` with an isolated, memory-only `ModelRuntime` per platform session. `DefaultResourceLoader` loads skills, prompt templates, and project instructions; `SessionManager` persists messages and manages context compaction. SDK automatic retries and compaction remain enabled. File-based extensions and themes are disabled in this headless host. Skills come from the project's `~/.agents/skills` (where library skills are installed), alongside SDK default discovery. Resources refresh when a session is loaded.

The SDK's built-in tools are enabled directly: read, write, edit, bash, grep, find, ls. There are no Cattery wrappers, aliases, output parsers, or timeout overrides for these built-in tools. A custom `questionnaire` tool matches pi's questionnaire example shapes and waits for web responses through `POST /session/:id/questionnaire/:toolId`; the platform route uses `requireWritableSession`, so only the session's creator answers. The chat renders single or multiple questions, custom answers, review, cancellation, and persisted answers. History includes `session.state` with `busy` and `seq`, and includes the run's not-yet-persisted output (streaming text/thinking, finished tools), so a snapshot matches the event stream up to `seq`. Tool execution, schemas, defaults, and truncation follow pi. Cattery forwards official text output and details through its HTTP/SSE protocol; the web UI displays text output directly. Grep uses ripgrep and find uses fd, both installed in the container.

### Platform event protocol

**This is the core abstraction.** The agent emits these directly (no translator); the backend only filters by `sessionId` and forwards them to the frontend. Defined in `backend/internal/harness/event.go`:

```
{ type: "message.delta",      data: { partId, text } }     // streaming text chunk
{ type: "message.user",       data: { partId, text } }     // a user message reached the model (prompt or steer)
{ type: "message.thinking",   data: { partId, text } }     // streaming thinking chunk (optional)
{ type: "message.thinking.done", data: { partId, durationMs } } // thinking block ended (agent-timed)
{ type: "message.usage",      data: { messageId, input?, output, cacheRead?, cacheWrite?, durationMs } } // one model request's tokens and time
{ type: "tool.start",         data: { toolId, tool, input } } // repeats: previews while the model writes the call, full input before it runs
{ type: "tool.done",          data: { toolId, tool, output, parsed? } }
{ type: "session.title",      data: { title } }            // session title generated/updated
{ type: "session.usage",      data: { contextTokens, contextWindow, reserveTokens, tokens, userMessages, toolCalls } } // after each turn/compaction and in history
{ type: "session.queue",      data: { messages } }         // steered messages not yet delivered; also in history
{ type: "session.idle",       data: {} }                   // closes the stream
{ type: "session.error",      data: { message } }
{ type: "session.state",      data: { busy, seq } }        // history snapshot only, never live
```

`tool.start` is sent as soon as the model begins a tool call and repeated (throttled, long strings cut) while it streams the arguments, so a long `write` shows at once; the last one, at execution, carries the full input. `partId` / `toolId` are stable IDs: the frontend appends `message.delta` text to the bubble keyed by `partId`, and updates the bubble keyed by `toolId` when `tool.done` arrives. The agent derives partIds from the assistant message timestamp + content index, so live stream and history replay agree. pi has no per-block thinking time, so the agent times each block from `thinking_start` to `thinking_end`, or to the first `text_start` / `toolcall_start` if that comes sooner (openai-completions providers send `thinking_end` only when the whole response ends), and stores it as a `cattery.thinking` custom transcript entry (never sent to the model); history replays it as `message.thinking.done`.

`message.usage` gives each model request's tokens and its time, from the assistant message's `timestamp` (request start) to its end; history takes the end from the transcript entry's `timestamp`, so nothing extra is stored. Providers report tokens only when a request ends, so while it streams the agent sends an estimated `output` (about one token per CJK character or four other characters, every 250 ms) with no `input`, then the real counts at `message_end`. Each reply's footer sums its requests: ↓ output and tok/s (output over request time) climb while it streams; ↑ input (without cached tokens, as pi counts it) shows once it is done.

### Request flow for sending a message

`POST /api/v1/sessions/:id/message`:

1. Look up Session → Project; `sandbox.Await` the project sandbox (restarts it if stopped; the start runs detached so a client disconnect doesn't cancel it).
2. `POST /session` (idempotent re-register), then subscribe to `GET <sandboxURL>/event` before sending `POST /session/:id/prompt_async` (returns 204 immediately).
3. Forward this session's events as platform-format SSE frames; persist accepted `session.title` events to the DB before forwarding, rejecting automatic names when the user has manually renamed the session.
4. Stop at the session's `session.idle`.

**Following.** `GET /api/v1/sessions/:id/events` (readable by any project member) forwards the session's events across runs until the client disconnects, minus `session.title` (only the starting stream persists titles; followers refresh the session on idle). Every live event carries a rising `seq`. The client subscribes first, then loads the history snapshot and applies only events with a larger `seq` (`claimSeq` in `chat-stream-store.ts`), so joining mid-run neither loses nor repeats output. Read-only viewers always follow; the creator follows only a run already going when the session loaded (started from another tab), since runs this tab starts arrive on their own send stream, and follow ignores events while that stream is active. The empty main pane (no tab open) has its own composer: Enter creates a session and parks the text (`setFirstPrompt` in `chat-stream-store.ts`); the chat sends it once the session is `ready`, or restores it into the composer if creation failed.

The response is itself an SSE stream; the frontend reads it directly from the `fetch` body, not via `EventSource`.

**Steering.** A message sent while the session runs is not rejected: the agent `steer()`s it into the running turn and `prompt_async` returns 202, so the backend answers 202 with no stream and the reply keeps flowing on the stream that started the turn. pi delivers steered messages (all at once, `steeringMode: "all"`) after the current tool calls finish, before the next model request; it never cuts off a model response or a tool. Until then they show above the composer from `session.queue`, and can be withdrawn back into it (`DELETE /sessions/:id/queue/:index`). On delivery the agent emits `message.user` and the chat starts a new turn below it. A run that ends with messages still queued continues with them, so `session.idle` only comes once every message is answered. Abort drops the queue and the web client restores it into the composer. The stream belongs to whoever started the turn; other viewers follow it through the session's events stream.

### Frontend event handling

`web/components/chat-panel.tsx` + `web/lib/chat-stream-store.ts` are the single point that consumes platform events. They maintain a `Bubble[]` list keyed by `partId` / `toolId`. If you need new behavior, extend the platform protocol and emit it from the agent.

### Auth

Stateless HS256 JWT (`backend/internal/auth/jwt.go`), 7-day TTL, no server-side revocation — the token is the source of truth until expiry (demoting an admin only takes effect on the next token). Every route except `POST /auth/login` sits behind `AuthMiddleware` (`auth_middleware.go`), which accepts the bearer token from the `Authorization: Bearer` header or, failing that, a `?token=` query param (for `<img>`/`<iframe>`/download URLs that can't set headers; redacted from access logs). Admin-only routes layer `AdminOnly` on top.

### Token usage

Each model request is recorded at the source: pi appends one JSON line per request to `~/.cattery/usage.jsonl` on the workspace PVC (`harnesses/pi/src/usage.ts`) — a reply (assistant `message_end`), the small-model title call, or a compaction summary — with its session id, model and `input` / `output` / `cacheRead` / `cacheWrite` tokens (pi counts input without the cached part). The backend pulls it; nothing depends on a browser holding the stream. `usage.Collector` (`backend/internal/usage`) reads new lines with `GET /usage?offset=<bytes>`, stores them in `usage_records` under their record id (`ON CONFLICT DO NOTHING`, so rereads are harmless; pi restarts from 0 when an offset doesn't fit its ledger) and advances `projects.usage_offset` in the same transaction. It syncs every 30 s for `ready` sandboxes, when a send stream ends, before a session is deleted, and through `sandbox.Manager.OnRelease` after Stop and before Destroy. A record is charged to its session's creator (the project owner for sessions without one), with a username snapshot; rows have no foreign key to sessions or projects, so usage outlives them. Forks copy transcripts but not the ledger, so nothing is counted twice. Agents on an image without `/usage` (404) are skipped quietly. Recording never delays a request: pi appends in the background, the after-stream sync runs in a goroutine, and the syncs that deleting a session or stopping/destroying a sandbox wait on are capped at 3 s (missed lines stay for the next sync).

`GET /usage?from&to&bucket=day|week|month&tz` returns the caller's own usage; `GET /admin/usage` (admin only) everyone's (`usage_handler.go`). Both sum rows per period, user and model in the viewer's time zone (`to` inclusive, weeks start Monday). The web's Usage tab (`/usage`, the rail button above Settings, for every user) shows the caller's own usage; admins also get Team usage (`/admin/usage`, in the Settings menu), everyone's. Both render `components/usage-dashboard.tsx` (with `components/usage-chart.tsx`, `lib/usage.ts`, and shadcn's `ui/calendar` for the range picker), sized to one screen and opening on the last 7 days: a range picker (presets beside a two-month range calendar) and model filter (plus a user filter for admins); total tokens, requests and cache hit rate (plus active users), each with its change against the same-length range just before (a second fetch of the same endpoint); tokens per period stacked by model, bucketed by day, week or month from the range's length; and a breakdown table (models, plus users for admins) whose rows set the filters. Seven models are charted by name and the rest fold into "Other".

### Project files

pi serves the file browser, LaTeX previews, skill installs and app previews
itself: `harnesses/pi/src/files.ts` is an Express router mounted ahead of pi's
JSON body parser (file routes read raw bodies), with workspace-relative paths
that cannot leave `/home/cattery`. Errors are plain text. `FilesHandler` reaches
it through `sandbox.Manager.FileURL`, which waits for the agent container but
not for sessions, so Stop agent keeps file access. Uploads arrive as multipart
at the backend, which streams the `file` part as the raw body of pi's
`/upload?path=&name=`. `/save` takes the `mtime` (ns, a string) `/read` reported
and answers 409 if the file changed. `/extract` unpacks a tar beside the target
and swaps it in when complete. `/latex` runs `xelatex` (two passes, no shell
escape, one compile at a time, 60 s, killed with its process group when the
client leaves) with `HOME` outside the workspace; TeX and its fonts are in the pi
image (`harnesses/pi/latex/`, checked by `check-latex.py` at build). There is no
filemgr container or image; the old `cattery-filemgr-<projectID>` Pod name is
retained only for migration cleanup. The Pod spec lives in
`backend/internal/k8s/client.go`.

### The web terminal

`GET /projects/:id/terminal?terminal=<uuid>` is a WebSocket (`backend/internal/api/terminal_handler.go`) that execs `tmux new-session -A -s <uuid>` in `/home/cattery` inside the project Pod's `agent` container via the K8s exec API (`k8s.Client.Exec`, WebSocket protocol with SPDY fallback; RBAC grants `pods/exec`). The tmux session outlives the WebSocket, so reconnecting (or reloading the page) reattaches the same shell and its running commands; `DELETE /projects/:id/terminals/:uuid` kills it. tmux and its config (`harnesses/pi/tmux.conf`: no status bar, mouse scrolling, OSC 52 clipboard) ship in the pi image; the Pod's `hostname` is `sandbox`, so prompts read `cattery@sandbox:~$`. It only needs the container running (`sandbox.Manager.TerminalPod`), not a ready agent. Binary frames carry terminal bytes both ways; the client sends `{"type":"resize","cols","rows"}` text frames; the server closes 1000 on shell exit, 1011 with a reason on failure. Auth is `?token=` like file URLs. In the UI, terminals are sidebar items (the Terminals view, `terminal-list-panel.tsx`) that open as main-pane tabs at `/terminals/<projectId>/<id>`. The route page renders nothing; `TerminalHost` in the workspace layout draws every started shell (`terminal-view.tsx`, xterm.js) over the main pane, so shells survive tab switches. Closing a tab keeps the shell; deleting the terminal ends it. The list (id, title, creator) lives in the `terminals` table, shared by every project member, through `GET|POST /projects/:id/terminals` and `PATCH|DELETE /projects/:id/terminals/:terminal_id`; deleted rows keep their id (`deleted_at`). `lib/terminal-store.ts` holds only this browser tab's connection state, and reads the old localStorage list (`cattery:terminals`) once to import it via `POST /projects/:id/terminals/import`, ids preserved. Shell output is never stored: it lives only in tmux, so after a reload opening a terminal reattaches its tmux session (gone only if the container restarted). Ctrl+\` opens the project's newest terminal.

### Port previews

Web servers running in the sandbox open in the browser through the backend, without changing the app, each on its own host. `GET /projects/:id/apps` lists listening apps minus 1114, read by pi's `GET /ports` (`harnesses/pi/src/ports.ts`): sockets from `/proc/net/tcp{,6}`, matched to the process holding each through `/proc/<pid>/fd`, with its command line and start time. pi shares the agent container's PID namespace and uid with everything the agent or a terminal starts. Forked workers share a socket, so the earliest-started holder is shown; a sandbox whose agent isn't up lists nothing. `DELETE /projects/:id/apps/:port` (any member) asks pi's `DELETE /ports/:port` to stop it: pi looks the holder up again (never trusting a client PID), sends SIGTERM, and SIGKILL if the port still listens after 3 s.

**Preview hosts** (`preview_host.go`). Each preview is served at `<port>-<project id>.<domain>`, from `PREVIEW_URL`, a URL with a wildcard host: by default `http://*.localhost:<PORT>` (browsers resolve every `*.localhost` name to the machine, no DNS needed), in production e.g. `https://*.preview.example.com` behind a wildcard DNS record and TLS certificate pointing at the backend. The `Host` header names the preview, so the app owns every path there: client-side routers, reloads and Vite's HMR socket stay on its own host, and several previews coexist. `PortsHandler.ServeHost` runs as server-wide middleware ahead of CORS and routing, so none of the backend's routes are reachable on a preview host; other hosts pass through. It reverse-proxies, HTTP and WebSocket, with the path unchanged, to pi's `/proxy/<port>/…` (WebSocket upgrades through the server's `upgrade` listener), which dials `localhost:<port>` over IPv4, then IPv6, so servers bound to localhost work, and turns `Location: http://localhost:<port>/x` redirects root-relative. Previews of 1114 are refused: they would expose the agent API to every member. The access log prefixes preview-host requests with their host. The web reads the template from `GET /config` (`{preview_url}`, `lib/server-config.ts`); `previewBase` / `previewURL` (`lib/api.ts`) fill in the host. Browser code that calls `http://localhost:<other port>` directly can't work; same-origin calls proxied by the dev server do.

Auth: the web opens `<preview host>/?cattery_token=<login token>` (not `?token=`, which Vite's HMR socket uses). `previewAuth` swaps it for an HttpOnly `cattery_preview_<project id>` cookie holding a `ScopePreview` JWT (`auth.Signer.IssuePreview`) and redirects without the token. The cookie is `SameSite=None; Secure; Partitioned`: the web app frames the preview from another site (`localhost` and `x.localhost` are different sites), and browsers accept Secure cookies from `http://*.localhost`. `AuthMiddleware` rejects scoped tokens, and the proxy strips every `cattery_preview*` cookie (and the app's attempts to set one); the app's own `Authorization` header passes through. The pi prompt tells the agent to run servers in the background and hand the user `http://localhost:<port>` links. In the UI, the Apps sidebar view (`app-list-panel.tsx`, reading the list `AppWatcher` polls every 3 s while a project is open; each row shows the port and running time, then the command and PID, with open-in-browser and stop buttons on hover) opens `port` tabs at `/ports/<projectId>/<port>` that frame the preview, with its real address in the tab's address bar; the agent's localhost links in chat open the same tab (`lib/sandbox-link.ts`).

### The global skill library

The backend serves the global skill library that powers `web/components/skill-browser-panel.tsx`, the admin Skill management page (`app/(workspace)/admin/skills`) and the per-skill view, from a `<slug>/SKILL.md (+assets)` tree in `SKILLS_DIR` (`backend/internal/skills`: `Library` for the routes, `zip.go` for the archive rules shared with project uploads). It is platform-wide, not per-project. There is no skillmgr Pod or image any more; the backend deletes a leftover `cattery-skillmgr` Pod on startup, and `deploy/` mounts its old PVC. Skills are uploaded as `.zip` archives via the catalog endpoints; the frontend treats one top-level `<slug>/` directory as one skill. Every signed-in user can read the library (`catalog`, `list`, `read`); changing it (`upload-zip`, `delete`, `rename`, `mkdir`) is `AdminOnly`, done from Skill management in the Settings menu.

Not every skill belongs in every project, so sandboxes do not mount the library and agents never load it directly. `POST /projects/:id/skills/:slug` (any member, `SkillsHandler.Install`) installs one: it streams the library folder as a tar (`skills.WriteArchive`, regular files only) into pi's `POST /extract?path=/.agents/skills/<slug>`, which unpacks beside the target and swaps it in once complete, replacing an installed copy. Members can also upload a skill `.zip` straight into the project, never the library: `POST /projects/:id/skills` (`SkillsHandler.UploadToProject`) names it after the archive, requires a top-level `SKILL.md`, converts it to a tar in memory (`skills.ZipToTar`, 32 MB cap) and sends it to the same `/extract`. Uninstalling is a plain file delete. The library is the platform-wide catalog everyone browses; skills are bound to projects by installing. The Skills panel, like the other sidebar views, needs an open project (otherwise it shows the create-project placeholder). Like VS Code's extensions view, it shows an Installed section (the project's `~/.agents/skills`; folders missing from the library show as "Project only" and open their `SKILL.md` as a file) above a Library section (valid library skills, installed ones badged), split by a draggable divider (ratio in localStorage `cattery.skills.split`), each collapsible; a search by name, slug or description replaces both with library matches, with install/uninstall on hover (`useInstalledSkillsStore` in `lib/skills-store.ts`). pi loads skills when it opens a session, so a session already in memory picks up an install only after it is reopened (Stop agent, or a sandbox restart). Sandboxes created with the retired `/cattery/global-skills` mount stay compatible; a layout with a mount inside the workspace (the library over `~/.agents/skills`) is rejected as legacy.

### Notes for the frontend

This Next.js version has breaking changes from training-data knowledge. When touching frontend code, consult `node_modules/next/dist/docs/` first; do not assume App Router APIs match older Next.js conventions. shadcn components here use the Base UI style (`base-nova` in `components.json`, built on `@base-ui/react`), not Radix: compose triggers with the `render` prop (`<TooltipTrigger render={<Button />}>`), not `asChild`. `cn` comes from shadcn's `cn` package (re-exported by `lib/utils.ts`). The chat (`chat-panel.tsx`) follows the shadcn AI Elements patterns (Message Scroller, Message, Bubble, Trace, Code Block, Input Group); `ui/code-block` is the frame only (no highlighting); `lib/highlighter.ts` highlights code for the file viewer and markdown (via `components/code-block.tsx`). TypeScript stays on 6.x until typescript-eslint supports 7. Zustand selectors must return stored references (or primitives) — a selector that builds a fresh object each call re-renders forever.

# Collaboration
List Claude as a co-author when committing.
