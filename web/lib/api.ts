const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"

export type TransportKind = "http" | "terminal"

export interface Harness {
  harness_id: string
  harness_name: string | null
  model: string
  type: string
  transport_kind: TransportKind
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
  const res = await fetch(`${API_BASE}/api/v1/harnesses`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list harnesses")
  return res.json()
}

export async function createHarness(data: Omit<Harness, "harness_id" | "created_at" | "transport_kind" | "sandbox_status">): Promise<Harness> {
  const res = await fetch(`${API_BASE}/api/v1/harnesses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to create harness")
  return res.json()
}

export async function getHarness(harnessId: string): Promise<Harness> {
  const res = await fetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get harness")
  return res.json()
}

export async function updateHarness(harnessId: string, data: { harness_name: string }): Promise<Harness> {
  const res = await fetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to update harness")
  return res.json()
}

export async function deleteHarness(harnessId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/harnesses/${harnessId}`, { method: "DELETE" })
}

export async function listSessions(harnessId: string): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/api/v1/harnesses/${harnessId}/sessions`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to list sessions")
  return res.json()
}

export async function createSession(harnessId: string, theme: "light" | "dark"): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/v1/harnesses/${harnessId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  })
  if (!res.ok) throw new Error("failed to create session")
  return res.json()
}

export async function getSession(sessionId: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get session")
  return res.json()
}

export async function updateSessionTitle(sessionId: string, data: { title: string }): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error("failed to update session")
  return res.json()
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/sessions/${sessionId}`, { method: "DELETE" })
}

export async function abortSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/abort`, { method: "POST" })
}

export async function sendSessionMessageStream(
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/message`, {
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
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/answer`, {
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
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/history`, { cache: "no-store" })
  if (!res.ok) throw new Error("failed to get history")
  return res.json()
}

// termURL 生成终端 WS endpoint。把 API_BASE 的 http(s) 换成 ws(s)。
export function termURL(sessionId: string): string {
  const base = API_BASE.replace(/^http(s?):/, "ws$1:")
  return `${base}/api/v1/sessions/${sessionId}/term`
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
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`list files failed: ${res.status}`)
  return res.json()
}

export async function readFile(harnessId: string, path: string): Promise<FileReadResponse> {
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/files/read?path=${encodeURIComponent(path)}`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`read file failed: ${res.status}`)
  return res.json()
}

// downloadFileURL 让浏览器走原生下载（带 Content-Disposition），不走 fetch。
export function downloadFileURL(harnessId: string, path: string): string {
  return `${API_BASE}/api/v1/harnesses/${harnessId}/files/download?path=${encodeURIComponent(path)}`
}

// rawFileURL 用于内联展示（<img>、<video>、<iframe> 之类）。
// 跟 download 区别：服务端会按扩展名设 Content-Type，不带 Content-Disposition。
export function rawFileURL(harnessId: string, path: string): string {
  return `${API_BASE}/api/v1/harnesses/${harnessId}/files/raw?path=${encodeURIComponent(path)}`
}

export function rawFilePathURL(harnessId: string, path: string): string {
  const encodedPath = path.split("/").map(segment => encodeURIComponent(segment)).join("/")
  return `${API_BASE}/api/v1/harnesses/${harnessId}/files/raw-path${encodedPath}`
}

export async function uploadFile(harnessId: string, dir: string, file: File): Promise<void> {
  const fd = new FormData()
  fd.append("file", file)
  const url = `${API_BASE}/api/v1/harnesses/${harnessId}/files/upload?path=${encodeURIComponent(dir)}`
  const res = await fetch(url, { method: "POST", body: fd })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
}
