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

export interface Harness {
  harness_id: string
  owner_user_id: string
  harness_name: string | null
  model: string
  type: string
  transport_kind: TransportKind
  access_role: "owner" | "viewer" | "editor"
  owner_username: string
  env_vars: Record<string, string>
  sandbox_status: string
  created_at: string
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

export async function listHarnesses(): Promise<Harness[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list harnesses")
  return res.json()
}

export type CreateHarnessRequest = Pick<Harness, "harness_name" | "model" | "type" | "env_vars">

export async function createHarness(data: CreateHarnessRequest): Promise<Harness> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses`, {
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

export interface HarnessShare {
  harness_id: string
  user_id: string
  username: string
  role: "viewer" | "editor"
  created_at: string
}

export interface ShareCandidate {
  user_id: string
  username: string
}

export async function listHarnessShares(harnessId: string): Promise<HarnessShare[]> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/shares`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list shares")
  return res.json()
}

export async function searchShareCandidates(harnessId: string, query: string): Promise<ShareCandidate[]> {
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/share-candidates?q=${encodeURIComponent(query)}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to search users")
  return res.json()
}

export async function createHarnessShare(
  harnessId: string,
  data: { username: string; role: "viewer" | "editor" },
): Promise<HarnessShare> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, `create share failed (${res.status})`))
  return res.json()
}

export async function updateHarnessShare(
  harnessId: string,
  userId: string,
  data: { role: "viewer" | "editor" },
): Promise<HarnessShare> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/shares/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, `update share failed (${res.status})`))
  return res.json()
}

export async function deleteHarnessShare(harnessId: string, userId: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/api/v1/harnesses/${harnessId}/shares/${userId}`, { method: "DELETE" })
  if (!res.ok && res.status !== 204) {
    throw new Error(await readErrorMessage(res, `delete share failed (${res.status})`))
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

// ---- filemgr (sidecar in each harness Pod, proxied through backend) ----

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

export async function listFiles(harnessId: string, path: string): Promise<FileEntry[]> {
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/files/list?path=${encodeURIComponent(path)}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`list files failed: ${res.status}`)
  return res.json()
}

export async function readFile(harnessId: string, path: string): Promise<FileReadResponse> {
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/files/read?path=${encodeURIComponent(path)}`
  const res = await authedFetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`read file failed: ${res.status}`)
  return res.json()
}

// downloadFileURL/rawFileURL/rawFilePathURL are consumed as bare URLs by the
// browser (download attribute, <img src>, <iframe src>) which can't set
// Authorization headers — so we append the token as a query param. The
// backend middleware reads either Authorization or ?token=.
export function downloadFileURL(harnessId: string, path: string): string {
  return appendToken(`${API_BASE}/api/v1/harnesses/${harnessId}/files/download?path=${encodeURIComponent(path)}`)
}

export function rawFileURL(harnessId: string, path: string): string {
  return appendToken(`${API_BASE}/api/v1/harnesses/${harnessId}/files/raw?path=${encodeURIComponent(path)}`)
}

export function rawFilePathURL(harnessId: string, path: string): string {
  const encodedPath = path.split("/").map(segment => encodeURIComponent(segment)).join("/")
  return appendToken(`${API_BASE}/api/v1/harnesses/${harnessId}/files/raw-path${encodedPath}`)
}

export async function uploadFile(harnessId: string, dir: string, file: File): Promise<void> {
  const fd = new FormData()
  fd.append("file", file)
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/files/upload?path=${encodeURIComponent(dir)}`
  const res = await authedFetch(url, { method: "POST", body: fd })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
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
