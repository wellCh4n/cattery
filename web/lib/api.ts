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

export type TransportKind = "http" | "terminal"

export interface Project {
  project_id: string
  owner_user_id: string
  project_name: string | null
  access_role: "owner" | "member"
  owner_username: string
  created_at: string
}

export interface Harness {
  harness_id: string
  project_id: string
  harness_name: string | null
  model: string
  type: string
  transport_kind: TransportKind
  access_role: "owner" | "member"
  owner_username: string
  env_vars: Record<string, string>
  sandbox_status: string
  created_at: string
  project?: Project
}

export interface Session {
  session_id: string
  harness_id: string
  status: string
  phase: string | null
  title: string | null
  sandbox_url: string | null
  harness_session_id: string | null
  created_at: string
  last_seen_at: string | null
  stopped_at: string | null
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

export async function listHarnesses(projectId: string): Promise<Harness[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/harnesses`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list harnesses")
  return res.json()
}

export type CreateHarnessRequest = Pick<Harness, "harness_name" | "model" | "type" | "env_vars">

export async function createHarness(projectId: string, data: CreateHarnessRequest): Promise<Harness> {
  const res = await authedFetch(`${API_BASE}/api/v1/projects/${projectId}/harnesses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to create harness")
  return res.json()
}

export async function getHarness(harnessId: string): Promise<Harness> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get harness")
  return res.json()
}

export async function updateHarness(harnessId: string, data: { harness_name: string }): Promise<Harness> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to update harness")
  return res.json()
}

export async function deleteHarness(harnessId: string): Promise<void> {
  await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, { method: "DELETE" })
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

export async function listSessions(harnessId: string): Promise<Session[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/sessions`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list sessions")
  return res.json()
}

export async function createSession(harnessId: string, theme: "light" | "dark"): Promise<Session> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  })
  if (!res.ok) throw new Error("failed to create session")
  return res.json()
}

export async function getSession(sessionId: string): Promise<Session> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get session")
  return res.json()
}

export async function updateSessionTitle(sessionId: string, data: { title: string }): Promise<Session> {
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

export async function sendSessionMessageStream(
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error("failed to send message")
  }
  return res.body.getReader()
}

export interface QuestionAnswer {
  question: string
  selectedLabels: string[]
  notes?: string
}

export async function answerSession(
  sessionId: string,
  questionId: string,
  answers: QuestionAnswer[],
): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/sessions/${sessionId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionId, answers }),
  })
  if (!res.ok) throw new Error("failed to submit answer")
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

// termURL generates the terminal WS endpoint. WebSocket upgrades can't carry
// Authorization headers from the browser, so we pass the token as a query
// param instead — the backend middleware accepts either form.
export function termURL(sessionId: string): string {
  const base = API_BASE.replace(/^http(s?):/, "ws$1:")
  const url = `${base}/api/v1/sessions/${sessionId}/term`
  return appendToken(url)
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

function appendToken(url: string): string {
  const token = getStoredToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
