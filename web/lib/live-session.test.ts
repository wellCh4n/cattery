import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { watchProject } from "./live"
import { useWorkspaceStore } from "./workspace-store"
import type { ProjectWithSessions } from "./workspace-store"
import type { Session } from "./api"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Longer than the 500 ms coalescing window, so a debounce has fired.
const SETTLE = 650

const session = (id: string, extra: Partial<Session> = {}) => ({
  session_id: id, project_id: "p", model: "m", effort: "high",
  created_by_user_id: null, created_by_username: null,
  status: "ready", phase: null, title: id, created_at: "2026-01-01T00:00:00Z", last_seen_at: null,
  ...extra,
}) as Session

class FakeSocket {
  static OPEN = 1
  static last: FakeSocket | null = null
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { FakeSocket.last = this }
  send() {}
  close() { this.readyState = 3 }
}

const originals = new Map<string, PropertyDescriptor | undefined>()
function stub(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const unwatchers: (() => void)[] = []
afterEach(() => {
  for (const unwatch of unwatchers.splice(0)) unwatch()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originals.clear()
  useWorkspaceStore.setState({ projects: [] })
})

// watch opens the live channel for project p over a fake socket, lets the
// subscribe-time refetch settle, and returns the requests made after that.
async function watch(sessions: Session[], latest: Record<string, Session> = {}) {
  const requests: string[] = []
  stub("window", { location: { href: "http://localhost:3000/", pathname: "/" } })
  stub("localStorage", { getItem: () => null, setItem() {}, removeItem() {} })
  stub("WebSocket", FakeSocket)
  stub("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    const parts = path.split("/")
    if (parts[3] === "sessions") return Response.json(latest[parts[4]])
    if (parts[5] === "sessions") return Response.json(sessions)
    return Response.json({ project_id: "p", sandbox_status: "ready" })
  })
  useWorkspaceStore.setState({ projects: [{
    project_id: "p", owner_user_id: "u", project_name: "Test", access_role: "owner",
    owner_username: "admin", sandbox_status: "ready", created_at: "", sessions,
  }] as ProjectWithSessions[] })
  unwatchers.push(watchProject("p"))
  const ws = FakeSocket.last!
  ws.onopen?.()
  await sleep(50)
  requests.length = 0
  const frame = (data: object) => ws.onmessage?.({ data: JSON.stringify({ type: "session", project_id: "p", data }) })
  return { requests, frame }
}

const stored = () => useWorkspaceStore.getState().projects[0].sessions

test("a title change refetches only that session, not the list", async () => {
  const w = await watch([session("a"), session("b")], { a: session("a", { title: "Renamed" }) })
  w.frame({ session_id: "a", change: "title" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, ["/api/v1/sessions/a"])
  assert.deepEqual(stored().map(s => s.title), ["Renamed", "b"])
})

test("a new or forked session is fetched alone and inserted into the list", async () => {
  const w = await watch([session("a")], { c: session("c", { last_seen_at: "2026-02-01T00:00:00Z" }) })
  w.frame({ session_id: "c", change: "forked" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, ["/api/v1/sessions/c"])
  assert.deepEqual(stored().map(s => s.session_id), ["c", "a"])
})

test("a deletion is dropped locally without any request, even with a refresh pending", async () => {
  const w = await watch([session("a"), session("b")], { a: session("a") })
  w.frame({ session_id: "a", change: "status", status: "ready" })
  w.frame({ session_id: "a", change: "deleted" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, [])
  assert.deepEqual(stored().map(s => s.session_id), ["b"])
})

test("a burst of events for one session costs a single request", async () => {
  const w = await watch([], { c: session("c", { status: "ready" }) })
  w.frame({ session_id: "c", change: "created" })
  w.frame({ session_id: "c", change: "status", status: "creating", phase: "handshake" })
  w.frame({ session_id: "c", change: "status", status: "ready" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, ["/api/v1/sessions/c"])
  assert.deepEqual(stored().map(s => s.status), ["ready"])
})

test("a ready that lands after the first window still costs one request, not creating and ready", async () => {
  const w = await watch([], { c: session("c", { status: "ready" }) })
  w.frame({ session_id: "c", change: "created" })
  await sleep(50)
  w.frame({ session_id: "c", change: "status", status: "creating", phase: "handshake" })
  await sleep(350)
  w.frame({ session_id: "c", change: "status", status: "ready" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, ["/api/v1/sessions/c"])
  assert.deepEqual(stored().map(s => s.status), ["ready"])
})

test("changes spaced past the window each refetch, so none is dropped", async () => {
  const w = await watch([session("a")], { a: session("a", { title: "Renamed" }) })
  w.frame({ session_id: "a", change: "activity" })
  await sleep(SETTLE)
  w.frame({ session_id: "a", change: "title" })
  await sleep(SETTLE)
  assert.deepEqual(w.requests, ["/api/v1/sessions/a", "/api/v1/sessions/a"])
  assert.equal(stored()[0].title, "Renamed")
})
