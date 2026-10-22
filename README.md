# Cattery

Self-hosted, team-oriented AI coding agent platform. Work is organised into **Projects**: shared workspaces with their own files and members. Users talk to the agent through **Sessions**. Each project runs one isolated Kubernetes Sandbox Pod that all of its sessions share.

The agent is [pi](https://github.com/earendil-works/pi): the harness in [`harnesses/pi`](harnesses/pi) embeds the `@earendil-works/pi-coding-agent` SDK for sessions, persistence, resource discovery, automatic compaction/retry, and coding tools. The SDK built-in tools are used without wrappers; Cattery forwards their output through its HTTP/SSE protocol. The model is chosen per session.

```mermaid
graph TD
    Browser["Browser\nNext.js + shadcn (port 3000)"]

    subgraph Backend["Go Backend (Echo, port 8080)"]
        Auth["AuthMiddleware\n(JWT)"]
        Router["Router /api/v1"]
        SandboxMgr["sandbox.Manager\nEnsureReady / Stop"]
        K8sClient["k8s.Client\nRunTask, EnsurePVC, ResolveContainerURL"]
        DB["PostgreSQL\nusers, projects, sessions"]
    end

    subgraph K8s["Kubernetes Cluster"]
        SandboxCR["Sandbox CR\nagents.x-k8s.io/v1beta1\n(one per Project)"]
        subgraph ProjectPod["Project Pod (one per Project)"]
            Pi["pi container\nsessions + transcripts"]
            FileMgr["filemgr container\nfiles + LaTeX previews"]
        end
        SkillMgr["skillmgr Pod\n(cluster-wide)"]

        WorkPVC["workspace PVC\ncattery-project-&lt;id&gt;-work"]
        SkillPVC["skills PVC\ncattery-skills-work"]
    end

    ModelAPI["Model providers\n(models.toml: endpoint + key per provider)"]

    Browser -->|"REST / SSE"| Auth
    Auth --> Router
    Router -->|"session/message"| SandboxMgr
    Router -->|"handlers → stores"| DB
    Router -->|"proxy /files/*"| FileMgr
    Router -->|"proxy /skills/*"| SkillMgr
    SandboxMgr --> K8sClient
    K8sClient -->|"create/delete Sandbox CR"| SandboxCR
    K8sClient -->|"create Pod"| SkillMgr
    SandboxCR --> ProjectPod
    Pi -->|"platform events (SSE)"| Router
    Pi --> ModelAPI
    Pi -->|"mount rw"| WorkPVC
    Pi -->|"mount ro"| SkillPVC
    FileMgr -->|"mount rw"| WorkPVC
    SkillMgr -->|"mount rw"| SkillPVC
```

## Prerequisites

- **Kubernetes cluster** (any flavor — kind, minikube, EKS, GKE, etc.) with kubeconfig reachable from the backend
- **[Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller** installed in the cluster — provides the `agents.x-k8s.io/v1beta1` `Sandbox` CRD that Cattery uses to launch isolated agent pods
- **PostgreSQL** 14+ — run it yourself, or let the bundled `docker-compose.yml` start one for you
- **Go** ≥ 1.22 (only if you run the backend on the host instead of in compose)
- **Bun** ≥ 1.0 (only if you run the frontend on the host)
- **Docker** — required for the agent image, plus the optional compose stack
- **At least one model provider** — an Anthropic-, OpenAI- or DeepSeek-compatible endpoint and key (the upstream provider directly, or a gateway such as NewAPI)

### Install the cluster prerequisites

The `k8s/` directory bundles everything the cluster needs behind one Kustomize
entrypoint — the upstream Agent Sandbox controller (version-pinned), the
`cattery` namespace, and the backend's ServiceAccount + RBAC:

```bash
kubectl apply -k k8s/
```

This fetches the Agent Sandbox controller manifest over the network; to pin a
different release, edit the URL in [`k8s/kustomization.yaml`](k8s/kustomization.yaml)
(see the [agent-sandbox releases page](https://github.com/kubernetes-sigs/agent-sandbox/releases)).
Preview the fully-rendered manifests first with `kubectl kustomize k8s/`.

Verify the CRD is registered and the controller is running:

```bash
kubectl get crd sandboxes.agents.x-k8s.io
kubectl get pods -n agent-sandbox-system
```

See the [Agent Sandbox Getting Started guide](https://agent-sandbox.sigs.k8s.io/docs/getting_started/) for the controller's own RBAC, namespacing, and extension components.

## Quick start

```bash
# 1. clone
git clone https://github.com/wellCh4n/cattery.git && cd cattery

# 2. backend env
cat > backend/.env <<EOF
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cattery?sslmode=disable
PORT=8080
K8S_NAMESPACE=default
JWT_SECRET=$(openssl rand -hex 32)
EOF

# 2b. model providers: set each provider's endpoint, key and models
cp backend/models.example.toml backend/models.toml

# 3. build the agent image so the cluster can pull it
make build-harness                       # builds cattery-pi:dev
# tag and push to your registry as needed:
# docker tag cattery-pi:dev your-registry/cattery-pi:dev
# docker push  your-registry/cattery-pi:dev

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

Open <http://localhost:3000>, sign in with the bootstrap admin credentials (see [Authentication](#authentication)), then create your first **Project** from the sidebar and start a **Session** in it.

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
| `make build-harness`| Build the pi agent image (`cattery-pi:dev`)                         |
| `make build-pod`    | Build filemgr and skillmgr images (`filemgr`, `skillmgr`); pass `POD=<name>` to build one |

## Configuration

Backend env vars (file: `backend/.env`, gitignored):

| Variable           | Default                                                            | Purpose                                                         |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `DATABASE_URL`     | `postgres://postgres@localhost:5432/cattery?sslmode=disable`       | Postgres DSN                                                    |
| `PORT`             | `8080`                                                             | HTTP listen port                                                |
| `K8S_NAMESPACE`    | `default`                                                          | Namespace where Sandbox CRs are created                         |
| `MODELS_CONFIG`      | `models.toml`                                                    | Path of the model catalog: one `[[providers]]` entry per provider with its `endpoint`, `key` and `models` (see `backend/models.example.toml`). Read at startup; users can only pick these models. |
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

Deleting a user cascades to their projects and sessions, and stops their K8s sandboxes; their existing token also becomes unusable on the next `/auth/me` probe (the frontend re-validates every 60 s).

## Resource model

- **Project** — a shared workspace owned by one user with optional members at `owner` / `member` roles. Each project has its own PVC-backed file workspace, mounted by the pi and filemgr containers in one project Pod.
- **Sandbox** — one Kubernetes `agents.x-k8s.io/v1beta1` Sandbox CR per Project, named `cattery-sandbox-<project_id>`, running pi and filemgr containers with `restartPolicy: Always`. It is provisioned on project creation, with lazy recovery on file/session access. `projects.sandbox_status` tracks agent activation; stopping the agent releases sessions while the Pod and file browser remain available.
- **Session** — a conversation with the agent, with its own model. All sessions of a project share the sandbox and the workspace. Transcripts are stored on the workspace PVC (`/work/.cattery/sessions/`), so they survive sandbox restarts.
- **Skill** — a `<slug>/SKILL.md (+assets)` directory in the global skills library. Skills are cluster-wide, independent of Projects, served by a single `skillmgr` Pod and mounted read-only into every sandbox at `~/.agents/skills`; the agent lists them in its system prompt.

Project members see all of the project's files and sessions; their access role gates which mutations they can perform. Deleting a project tears down its shared Sandbox Pod and the workspace PVC.

New sessions record the authenticated creator in `created_by_user_id` and a
`created_by_username` snapshot, displayed in the session list. Historical
sessions keep both fields null because their creator cannot be recovered.
Removing a member preserves attribution. Deleting a creator's account clears
the user reference but retains the username on sessions in other users' projects.

Terminals are shared project resources stored in PostgreSQL, including their
names, creation times and authenticated creator snapshots. Project members can
list, rename, delete and attach to the same tmux shell across browsers. The list
refreshes every 15 seconds for the active project and open terminals, on window
focus, or via the refresh button. Deleting a terminal stops its shell for everyone.
Existing browser terminal lists are imported on first load, preserving their IDs,
names and timestamps while leaving their unknown creators unset. Browser storage
then only retains personal tab preferences; terminal metadata comes from the API.

## Operational endpoints

- `GET /healthz` — liveness; always 200 once the process is up.
- `GET /readyz` — readiness; reports DB and Kubernetes client wiring.

Both probes are excluded from the request log to keep K8s polling traffic out of stdout.

## The agent harness

The backend talks to the agent through a small HTTP contract on port `1114` (see `backend/internal/harness/client.go`):

```
POST   /session {id, model, provider, baseUrl, apiKey}  → { id }   (idempotent; switches model if it differs)
DELETE /session/:id                    → 204
GET    /session/:id/message            → PlatformHistoryItem[]
POST   /session/:id/prompt_async       → 204
POST   /session/:id/abort              → 204
GET    /event                          → SSE stream of platform events, tagged with sessionId
```

The pi harness emits platform events directly, so the backend only routes them by session id. See [`CLAUDE.md`](./CLAUDE.md) for the event protocol.

## License

Internal project — not yet licensed for public use.

### Lightweight model

Set `small_model` at the top level of `backend/models.toml`, before any
`[[providers]]` tables:

```toml
default = "deepseek-v4-pro"
small_model = "deepseek-flash"
```

Both IDs must appear in the catalog. `small_model` reuses its provider's endpoint
and key and defaults to `default` when omitted; changing a session's model does
not change it. This setting is shared by lightweight tasks, currently session
title generation. Restart the backend after configuration changes.

After the first successful response, the harness uses `pi-ai` to generate a title
from that exchange, with a 15-second timeout. The original first-message title
remains if generation fails or returns no usable title. Generation is attempted
once per session, including across restarts. Manual names always take precedence;
existing nonempty titles are preserved when migration 00006 is applied. Title
requests do not enter the conversation transcript, and credentials stay in memory in isolated per-session model runtimes.

Conversation history uses SDK JSONL files at `/work/.cattery/sessions/<id>.jsonl`; `<id>.json` holds only platform metadata. Legacy JSON conversations are unsupported after this migration; delete those sessions and start new ones. Project files are unaffected.
The response text streams normally; the run becomes idle after the title attempt.

### LaTeX file previews

Opening a `.tex` file checks for a cached PDF (or a sibling PDF with the same
name); it never starts a compiler. Use **Compile preview** or **Update preview**
to run XeLaTeX. The Preview / Source switch remains available. A failed build
shows diagnostics and preserves the previous successful PDF. Source and recorded
workspace dependency changes mark the preview as needing an update; status is
checked on focus and every 30 seconds while the preview is visible. An imported
sibling PDF is marked as needing an update because its dependencies are unknown.

The filemgr image includes XeLaTeX, Chinese packages, common scientific and
algorithm packages, BibLaTeX, the recommended TeX fonts, and a curated subset
of the extra font collection. The full extra-font archive is downloaded only
in a separate build stage; `pods/filemgr/select-fonts.py` copies complete common
families (font binaries, metrics, encodings, LaTeX support, and maps) into the
runtime image and retains the package copyright information. This preserves
NewTX/NewPX, Libertinus/Libertine, XCharter, Font Awesome, New Computer Modern,
CM Unicode, STIX, KP Fonts, and Inconsolata without shipping the entire
`texlive-fonts-extra` package. Build caches still contain the full archive;
these are not part of the deployed image.
System fonts include Noto CJK, Noto, DejaVu, Liberation, Fira Code, TeX Gyre
(including math fonts), Linux Libertine, and FreeFont. `latexmk`, BibTeX, Biber,
and Pygments are installed for explicit tool use. Each image build runs
`pods/filemgr/check-latex.py` as the runtime user, checking package/font presence
and compiling scientific Chinese text, NewTX/NewPX, XCharter, Libertinus,
STIX, KP Fonts, Inconsolata, Unicode math, slides, algorithms, and a Biber bibliography. A failing check prevents image publication.
Custom document classes or host-specific fonts still need to be supplied by the
project or added to the image. The preview compiler does not automatically run
Biber/latexmk or enable shell escape for packages such as minted.

Compilation runs two passes with shell execution disabled, one build at a time per project, and a
60-second timeout. The filemgr container has a 1 CPU / 1 GiB memory limit. Successful
PDFs and dependency fingerprints are stored in `.cattery/latex/` on the workspace
volume; temporary build files are removed after each request. Open the document's
main `.tex` file to compile it. Bibliography tools, shell-escape packages, and
custom build scripts are not run automatically.

### Deploying shared project Pods

Build and deploy the backend, frontend, pi image (`make build-harness`) and
filemgr image (`make build-pod POD=filemgr`) together. The pi image must expose
`POST /stop` before enabling the new backend's Stop agent action.

Existing Sandbox Pod templates cannot gain a container in place. During a
maintenance window, finish or abort running turns, stop backend traffic, delete
the old `cattery-sandbox-<project_id>` Sandbox resources and
`cattery-filemgr-<project_id>` standalone Pods, and wait for their Pods to finish
terminating. **Keep all workspace and skills PVCs.** Deploy the new images and
restart the backend. Opening files or starting a session recreates each project
as one Pod with both containers. Legacy single-container Sandbox resources are
rejected with an explicit migration error rather than silently reused or deleted
by a file read. Old standalone filemgr Pods are also cleaned up when the shared
Sandbox is successfully provisioned.

Stop agent aborts active turns, persists transcripts and clears loaded sessions
and credentials. The lightweight pi HTTP process remains available; a new message
registers and restores the session. File operations and LaTeX previews continue
through the filemgr container. Deleting a project or its owning account tears down
the shared Sandbox and workspace PVC. Container-specific readiness allows file
access while pi is restarting, provided the Pod itself is running.

Session titles are synchronized through pi's native `AgentSession.setSessionName()`
and stored as `session_info` entries in its JSONL transcript. The database keeps
an index for the session list. Both accepted automatic titles and manual renames
write the native name before updating that index and returning it to the UI.
Manual renames start the sandbox when needed; a failed synchronization returns
an error instead of reporting success. Registration resynchronizes existing
platform titles, including sessions created before native naming was enabled.
A database row lock orders name writes and prevents automatic titles from
replacing manual names. The two stores do not share a transaction; registration
repairs the native name from the database if a database commit fails after the
native write. Pi defers writing an empty conversation's JSONL until its first
message; the database retains its name for restoration in the meantime.

### Agent questionnaires

The harness registers `questionnaire`, matching pi's questionnaire example parameter
and result shapes. It accepts one or more questions with `id`, optional `label`,
`prompt`, `options` (`value`, `label`, optional `description`), and optional
`allowOther` (default true). If a model omits an option value, the harness fills
it from the label before SDK validation (adding a suffix for collisions), while
preserving explicit values. Live events and history use the same normalized input.
The web chat displays single questions directly and
multiple questions with navigation and a review step. Submitting answers or
cancelling resolves the tool and lets the agent continue; stopping the run also
releases the wait. Answers are stored in the normal SDK tool result transcript.

`POST /api/v1/sessions/:session_id/questionnaire/:tool_id` forwards a response to
`POST /session/:id/questionnaire/:toolId` after checking project membership.
Responses contain `answers: [{id, value, wasCustom}]` and `cancelled`; the harness
validates the answers and derives option labels and one-based indices. Stale or
duplicate submissions return 409. History includes a `session.state` snapshot
with `busy`; after a reload or disconnected stream, the web client polls history
while the agent is running, including while a questionnaire awaits a response.
Unsubmitted form drafts are local to the mounted card. Agent process restarts
end pending waits; old questionnaires are displayed as ended.
