import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { useProjectTerminalsStore, useTerminalStore, type Terminal } from "./terminal-store"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; useTerminalStore.getState().reset() })
const terminal: Terminal = {
  terminal_id: "terminal-a", project_id: "project-a", title: "Shared shell",
  created_at: "2026-10-22T01:00:00Z", created_by_user_id: "member", created_by_username: "alice",
}

test("shared metadata survives local reset and remote deletion closes the local view", async () => {
  let data = [terminal]
  globalThis.fetch = (async () => Response.json(data)) as typeof fetch
  await useProjectTerminalsStore.getState().load("project-a")
  assert.deepEqual(useTerminalStore.getState().terminals, [terminal])
  useTerminalStore.getState().reset()
  await useProjectTerminalsStore.getState().load("project-a")
  assert.equal(useTerminalStore.getState().terminals[0].created_by_username, "alice")
  useTerminalStore.getState().start(terminal.terminal_id)
  useTerminalStore.getState().setStatus(terminal.terminal_id, "open")
  data = []
  await useProjectTerminalsStore.getState().invalidate("project-a")
  assert.deepEqual(useTerminalStore.getState().terminals, [])
  assert.deepEqual(useTerminalStore.getState().started, {})
  assert.deepEqual(useTerminalStore.getState().status, {})
})

test("failed shared deletion keeps terminal metadata and connection state", async () => {
  globalThis.fetch = (async (_input, init) => init?.method === "DELETE"
    ? Response.json({ message: "agent offline" }, { status: 502 }) : Response.json([terminal])) as typeof fetch
  await useProjectTerminalsStore.getState().load("project-a")
  useTerminalStore.getState().start(terminal.terminal_id)
  await assert.rejects(useTerminalStore.getState().removeTerminal(terminal.terminal_id), /agent offline/)
  assert.equal(useTerminalStore.getState().terminals.length, 1)
  assert.equal(useTerminalStore.getState().started[terminal.terminal_id], true)
})

test("account reset discards an in-flight creation response", async () => {
  let resolve!: (value: Response) => void
  globalThis.fetch = (() => new Promise<Response>(r => { resolve = r })) as typeof fetch
  const pending = useTerminalStore.getState().createTerminal("project-a")
  useTerminalStore.getState().reset()
  resolve(Response.json(terminal))
  await assert.rejects(pending, /Account changed/)
  assert.deepEqual(useTerminalStore.getState().terminals, [])
})

test("legacy terminals migrate once and keep IDs without supplying a creator", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const legacy = { id: "terminal-a", projectId: "project-a", title: "Old shell", createdAt: terminal.created_at }
  const values = new Map([["cattery:terminals", JSON.stringify({ terminals: [legacy] })]])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  let imports = 0
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      imports++
      assert.deepEqual(JSON.parse(String(init.body)), { terminals: [legacy] })
      return new Response(null, { status: 204 })
    }
    return Response.json([{ ...terminal, created_by_user_id: null, created_by_username: null }])
  }) as typeof fetch
  try {
    await useProjectTerminalsStore.getState().load("project-a")
    await useProjectTerminalsStore.getState().invalidate("project-a")
    assert.equal(imports, 1)
    assert.equal(values.has("cattery:terminals"), false)
    assert.equal(useTerminalStore.getState().terminals[0].terminal_id, legacy.id)
    assert.equal(useTerminalStore.getState().terminals[0].created_by_username, null)
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window")
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
