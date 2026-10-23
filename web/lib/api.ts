import { authedFetch } from "./api-fetch"
import { getStoredToken } from "./auth-token"

// readErrorMessage pulls a human-readable message out of a non-2xx response.
// Echo error responses look like `{"message":"old password is incorrect"}`;
// returning the raw body to the UI gives users the JSON literal, which is
// confusing. We try JSON first, fall back to the raw text, then a generic
// status-coded message.
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.text()
    if (!body) return fallback
    try {
      const obj = JSON.parse(body) as { message?: unknown }
      if (typeof obj.message === "string" && obj.message) return obj.message
    } catch { /* not JSON — fall through */ }
    return body
  } catch {
    return fallback
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

export interface Project {
  project_id: string
  owner_user_id: string
  project_name: string | null
  access_role: "owner" | "member"
  owner_username: string
  // The project's agent sandbox, shared by all its sessions:
  // idle | starting | ready | failed. Started on demand.
  sandbox_status: string
  created_at: string
}

export interface Session {
  session_id: string
  project_id: string
  created_by_user_id: string | null
  // Username at creation time, retained even if the account is deleted.
  created_by_username: string | null
  model: string
  // Thinking effort (a pi thinking level); empty means the provider default.
  effort: string
  status: string
  phase: string | null
  title: string | null
  title_manual?: boolean
  created_at: string
  last_seen_at: string | null
}

export async function listProjects(): Promise<Project[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list projects")
  return res.json()
}

export type CreateProjectRequest = Pick<Project, "project_name">

export async function createProject(data: CreateProjectRequest): Promise<Project> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to create project")
  return res.json()
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get project")
  return res.json()
}

export async function updateProject(projectId: string, data: { project_name: string }): Promise<Project> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to update project")
  return res.json()
}

export async function deleteProject(projectId: string): Promise<void> {
  await authedFetch(`${API_BASE}/api/v1/projects/${projectId}`, { method: "DELETE" })
}

export interface ProjectMember {
  project_id: string
  user_id: string
  username: string
  role: "member"
  created_at: string
}

export interface UserSummary {
  user_id: string
  username: string
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/members`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list members")
  return res.json()
}

export async function searchUsers(query: string, limit?: number): Promise<UserSummary[]> {
  let url = `${API_BASE}/api/v1/users/search?q=${encodeURIComponent(query)}`
  if (limit) url += `&limit=${limit}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to search users")
  return res.json()
}

export async function createProjectMember(
  projectId: string,
  data: { username: string },
): Promise<ProjectMember> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, `add member failed (${res.status})`))
  return res.json()
}

export async function deleteProjectMember(projectId: string, userId: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/members/${userId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `remove member failed (${res.status})`))
  }
}

export async function listSessions(projectId: string): Promise<Session[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/sessions`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list sessions")
  return res.json()
}

export interface ModelProvider {
  name: string
  models: string[]
  // Thinking efforts offered for this provider's models, lowest to highest.
  efforts: string[]
  default_effort: string
}

export interface ModelCatalog {
  default: string
  providers: ModelProvider[]
}

export async function listModels(): Promise<ModelCatalog> {
  const res = await authedFetch(`${API_BASE}/api/v1/models`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list models")
  return res.json()
}

// An empty model starts the session on the catalog default; an effort the
// model's provider doesn't offer falls back to the provider default.
export async function createSession(projectId: string, model: string, effort: string): Promise<Session> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, effort }),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, "failed to create session"))
  return res.json()
}

export async function getSession(sessionId: string): Promise<Session> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get session")
  return res.json()
}

export async function updateSession(sessionId: string, data: { title?: string; model?: string; effort?: string }): Promise<Session> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to update session")
  return res.json()
}

export async function deleteSession(sessionId: string): Promise<void> {
  await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { method: "DELETE" })
}

export async function abortSession(sessionId: string): Promise<void> {
  await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/abort`, { method: "POST" })
}

// Returns the reply stream, or null when the session was busy and the text was
// steered into its running turn (whose stream carries the reply).
export async function sendSessionMessageStream(
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  })
  if (res.status === 202) return null
  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res, "failed to send message"))
  }
  return res.body.getReader()
}

// Follows a session's live events across runs. The response arrives once the
// agent subscription is in place, so a history snapshot loaded afterwards plus
// the events after its seq form a gapless view.
export async function openSessionEvents(sessionId: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/events`, { cache: "no-store", signal })
  if (!res.ok || !res.body) throw new Error(await readErrorMessage(res, "failed to follow session"))
  return res.body.getReader()
}

// Takes back a steered message before it reaches the model. Returns the
// remaining queue, or null when the message was already delivered.
export async function withdrawQueuedMessage(sessionId: string, index: number, text: string): Promise<string[] | null> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/queue/${index}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (res.status === 409) return null
  if (!res.ok) throw new Error(await readErrorMessage(res, "failed to withdraw message"))
  return ((await res.json()) as { messages: string[] }).messages
}

export interface PlatformHistoryItem {
  messageId: string
  role: "user" | "assistant"
  events: Array<{ type: string; data: Record<string, unknown> }>
}

// exportSessionURL — bare URL with ?token=, suitable for <a download> so the
// browser does the file save dance natively (preserves Content-Disposition).
export function exportSessionURL(sessionId: string, format: "md" | "json"): string {
  return appendToken(`${API_BASE}/api/v1/sessions/${sessionId}/export?format=${format}`)
}

export async function getHistory(sessionId: string): Promise<PlatformHistoryItem[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/history`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get history")
  return res.json()
}

// ---- filemgr (standalone per-project Pod, proxied through backend) ----

export interface FileEntry {
  name: string
  type: "file" | "dir" | "link"
  size: number
  mtime: number
}

export interface FileReadResponse {
  path: string
  size: number
  truncated: boolean
  binary: boolean
  content?: string
}

export async function listFiles(projectId: string, path: string): Promise<FileEntry[]> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/list?path=${encodeURIComponent(path)}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`list files failed: ${res.status}`)
  return res.json()
}

export async function readFile(projectId: string, path: string): Promise<FileReadResponse> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/read?path=${encodeURIComponent(path)}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`read file failed: ${res.status}`)
  return res.json()
}

// downloadFileURL/rawFileURL/rawFilePathURL are consumed as bare URLs by the
// browser (download attribute, <img src>, <iframe src>) which can't set
// Authorization headers — so we append the token as a query param. The
// backend middleware reads either Authorization or ?token=.
export function downloadFileURL(projectId: string, path: string): string {
  return appendToken(`${API_BASE}/api/v1/projects/${projectId}/files/download?path=${encodeURIComponent(path)}`)
}

export function rawFileURL(projectId: string, path: string): string {
  return appendToken(`${API_BASE}/api/v1/projects/${projectId}/files/raw?path=${encodeURIComponent(path)}`)
}

export function rawFilePathURL(projectId: string, path: string): string {
  const encodedPath = path.split("/").map(segment => encodeURIComponent(segment)).join("/")
  return appendToken(`${API_BASE}/api/v1/projects/${projectId}/files/raw-path${encodedPath}`)
}

export async function uploadFile(projectId: string, dir: string, file: File): Promise<void> {
  const fd = new FormData()
  fd.append("file", file)
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/upload?path=${encodeURIComponent(dir)}`
  const res = await authedFetch(url, { method: "POST", body: fd })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
}

export async function deleteFile(projectId: string, path: string): Promise<void> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/delete?path=${encodeURIComponent(path)}`
  const res = await authedFetch(url, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `delete failed (${res.status})`))
  }
}

export async function renameFile(projectId: string, from: string, toName: string): Promise<{ path: string; name: string }> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toName)}`
  const res = await authedFetch(url, { method: "POST" })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `rename failed (${res.status})`))
  }
  return res.json()
}

// moveFile moves an entry from `from` into the directory `toDir`, keeping its
// base name. Backend rejects moves that would overwrite or create a cycle.
export async function moveFile(projectId: string, from: string, toDir: string): Promise<{ path: string; name: string }> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/move?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toDir)}`
  const res = await authedFetch(url, { method: "POST" })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `move failed (${res.status})`))
  }
  return res.json()
}

export async function createFolder(projectId: string, dir: string, name: string): Promise<{ path: string; name: string }> {
  const url = `${API_BASE}/api/v1/projects/${projectId}/files/mkdir?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`
  const res = await authedFetch(url, { method: "POST" })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `create folder failed (${res.status})`))
  }
  return res.json()
}

// ---- skillmgr (single global Pod, proxied through backend) ----
//
// Narrow API for the global skill library. Skills are managed as folders under
// /skills, with ZIP upload as the only upload path.

const SKILLS_BASE = `${API_BASE}/api/v1/skills`

// SkillCatalogItem is one skill in the library: a top-level `<slug>/` folder,
// described by its SKILL.md frontmatter. `valid` is false for stray top-level
// files or folders missing a SKILL.md, with `reason` explaining why.
export interface SkillCatalogItem {
  slug: string
  name: string
  description: string
  valid: boolean
  reason?: string
  mtime: number
}

export async function listSkillCatalog(): Promise<SkillCatalogItem[]> {
  const res = await authedFetch(`${SKILLS_BASE}/catalog`, { cache: "no-store" })
  if (!res.ok) throw new Error(`list skill catalog failed: ${res.status}`)
  return res.json()
}

export async function listSkills(path: string): Promise<FileEntry[]> {
  const res = await authedFetch(`${SKILLS_BASE}/list?path=${encodeURIComponent(path)}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`list skills failed: ${res.status}`)
  return res.json()
}

export async function readSkillFile(path: string): Promise<FileReadResponse> {
  const res = await authedFetch(`${SKILLS_BASE}/read?path=${encodeURIComponent(path)}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`read skill file failed: ${res.status}`)
  return res.json()
}

// uploadSkillZip uploads a ZIP archive and asks skillmgr to extract it under
// `dir`. Used by the SKILLS panel as the only upload affordance — the user
// zips a `<slug>/SKILL.md (+assets)` folder locally and drops the zip,
// landing the entire tree in one shot.
export async function uploadSkillZip(dir: string, file: File): Promise<{ path: string; dirs: number; files: number }> {
  const fd = new FormData()
  fd.append("file", file)
  const res = await authedFetch(`${SKILLS_BASE}/upload-zip?path=${encodeURIComponent(dir)}`, { method: "POST", body: fd })
  if (!res.ok) throw new Error(await readErrorMessage(res, `upload skill zip failed (${res.status})`))
  return res.json()
}

export async function deleteSkillFile(path: string): Promise<void> {
  const res = await authedFetch(`${SKILLS_BASE}/delete?path=${encodeURIComponent(path)}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `delete skill failed (${res.status})`))
  }
}

export async function renameSkillFile(from: string, toName: string): Promise<{ path: string; name: string }> {
  const res = await authedFetch(
    `${SKILLS_BASE}/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toName)}`,
    { method: "POST" },
  )
  if (!res.ok) throw new Error(await readErrorMessage(res, `rename skill failed (${res.status})`))
  return res.json()
}

export async function createSkillFolder(dir: string, name: string): Promise<{ path: string; name: string }> {
  const res = await authedFetch(
    `${SKILLS_BASE}/mkdir?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`,
    { method: "POST" },
  )
  if (!res.ok) throw new Error(await readErrorMessage(res, `create skill folder failed (${res.status})`))
  return res.json()
}

// ---- Auth ----

export interface CurrentUser {
  user_id: string
  username: string
  is_admin: boolean
}

export interface LoginResponse {
  token: string
  user: CurrentUser
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  // No authedFetch here — login is the one endpoint that runs without a
  // token, and we don't want a stale token to short-circuit the 401 flow.
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const msg = res.status === 401 ? "Invalid username or password" : `Login failed (${res.status})`
    throw new Error(msg)
  }
  return res.json()
}

export async function fetchMe(): Promise<CurrentUser> {
  const res = await authedFetch(`${API_BASE}/api/v1/auth/me`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to load user")
  return res.json()
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `change-password failed (${res.status})`))
  }
}

// ---- Admin ----

export interface AdminUser {
  user_id: string
  username: string
  is_admin: boolean
  created_at: string
  last_login_at: string | null
}

export async function adminListUsers(): Promise<AdminUser[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/admin/users`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list users")
  return res.json()
}

export async function adminCreateUser(data: { username: string; password: string; is_admin?: boolean }): Promise<AdminUser> {
  const res = await authedFetch(`${API_BASE}/api/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    if (res.status === 409) throw new Error("Username already exists")
    throw new Error(await readErrorMessage(res, `create user failed (${res.status})`))
  }
  return res.json()
}

export async function adminUpdateUser(
  userId: string,
  data: { password?: string; is_admin?: boolean },
): Promise<AdminUser> {
  const res = await authedFetch(`${API_BASE}/api/v1/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `update user failed (${res.status})`))
  }
  return res.json()
}

export async function adminDeleteUser(userId: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/admin/users/${userId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `delete user failed (${res.status})`))
  }
}

// terminalURL — WebSocket URL attaching a terminal's tmux session in the
// project's agent container. WebSockets can't carry an Authorization header,
// so the token rides in the query like the file URLs above.
export function terminalURL(projectId: string, terminalId: string): string {
  const http = `${API_BASE}/api/v1/projects/${projectId}/terminal?terminal=${terminalId}`
  return appendToken(http.replace(/^http/, "ws"))
}

export interface Terminal {
  terminal_id: string
  project_id: string
  title: string
  created_by_user_id: string | null
  created_by_username: string | null
  created_at: string
}

export async function listTerminals(projectId: string): Promise<Terminal[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/terminals`, { cache: "no-store" })
  if (!res.ok) throw new Error(await readErrorMessage(res, "Failed to load terminals"))
  return res.json()
}

export async function createTerminal(projectId: string): Promise<Terminal> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/terminals`, { method: "POST" })
  if (!res.ok) throw new Error(await readErrorMessage(res, "Failed to create terminal"))
  return res.json()
}

export async function renameTerminal(projectId: string, terminalId: string, title: string): Promise<Terminal> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/terminals/${terminalId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, "Failed to rename terminal"))
  return res.json()
}

export interface LegacyTerminal {
  id: string
  projectId: string
  title: string
  createdAt: string
}

export async function importTerminals(projectId: string, terminals: LegacyTerminal[]): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/terminals/import`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminals }),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, "Failed to migrate terminals"))
}

// Deletion removes the shared record and stops its tmux shell for everyone.
export async function deleteTerminal(projectId: string, terminalId: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/terminals/${terminalId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `delete terminal failed (${res.status})`))
  }
}

function appendToken(url: string): string {
  const token = getStoredToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

export interface LatexPreviewState {
  pdf?: string
  version?: string
  stale: boolean
}

export async function latexPreview(projectId: string, path: string, compile = false): Promise<LatexPreviewState> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/files/latex?path=${encodeURIComponent(path)}`, {
    method: compile ? "POST" : "GET", cache: "no-store",
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, `LaTeX preview failed (${res.status})`))
  return res.json()
}

export async function answerQuestionnaire(sessionId: string, toolId: string, response: {
  answers: Array<{ id: string; value: string; wasCustom: boolean }>
  cancelled: boolean
}): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/questionnaire/${encodeURIComponent(toolId)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(response),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, "Unable to submit answers"))
}
