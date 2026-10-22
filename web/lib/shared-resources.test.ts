import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { fileActions, fileKey, refreshFiles, toolChangedDirectories, useFilesStore } from "./files-store"
import { memberActions, useMembersStore } from "./members-store"
import { refreshSkills, skillActions, useSkillContentsStore, useSkillDirectoriesStore, useSkillsStore } from "./skills-store"

import { useChatStreamStore } from "./chat-stream-store"
import { useWorkspaceStore } from "./workspace-store"

const file = (name: string) => ({ name, type: "file", size: 1, mtime: 1 })
const dir = (name: string) => ({ ...file(name), type: "dir" })

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; fileActions.reset(); useMembersStore.getState().reset(); skillActions.reset() })
test("tool paths resolve safely within the workspace", () => {
    assert.deepEqual(toolChangedDirectories('{"path":"/work/src/a.ts"}'), ["/src"])
    assert.deepEqual(toolChangedDirectories('{"path":"new/nested/a.ts"}'), ["/new/nested"])
    assert.deepEqual(toolChangedDirectories('{"path":"src/../a.ts"}'), ["/"])
    assert.deepEqual(toolChangedDirectories('{"path":"../../etc/passwd"}'), [])
    assert.deepEqual(toolChangedDirectories('{"path":"/etc/passwd"}'), [])
    assert.deepEqual(toolChangedDirectories("bad"), [])
  })
test("file changes refresh hidden caches, traverse new parents, and remove deleted subtree caches", async () => {
    fileActions.reset()
    let removed = false
    const calls: string[] = []
    globalThis.fetch = (async input => {
      const url = new URL(String(input)); const path = url.searchParams.get("path")!
      calls.push(path)
      return Response.json(path === "/" ? (removed ? [] : [dir("src")]) : path === "/src" ? [dir("new")] : [file("added.ts")])
    }) as typeof fetch
    await refreshFiles("a", ["/src/new"])
    assert.deepEqual(calls, ["/", "/src", "/src/new"])
    assert.equal(useFilesStore.getState().entries[fileKey("a", "/src/new")].data?.[0].name, "added.ts")
    removed = true
    await refreshFiles("a")
    assert.equal(useFilesStore.getState().entries[fileKey("a", "/src")], undefined)
    assert.equal(useFilesStore.getState().entries[fileKey("a", "/src/new")], undefined)
  })
test("a change arriving during a file refresh triggers a second pass", async () => {
    fileActions.reset()
    let resolve!: (response: Response) => void
    let calls = 0
    globalThis.fetch = (() => ++calls === 1 ? new Promise<Response>(r => { resolve = r }) : Promise.resolve(Response.json([file("fresh.txt")]))) as typeof fetch
    const first = refreshFiles("a")
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const second = refreshFiles("a")
    resolve(Response.json([]))
    await Promise.all([first, second])
    assert.equal(calls, 2)
    assert.equal(useFilesStore.getState().entries[fileKey("a", "/")].data?.[0].name, "fresh.txt")
  })
test("member actions update the project cache, including when revalidation fails", async () => {
    useMembersStore.getState().reset()
    const member = { user_id: "u", username: "alice", role: "member" }
    globalThis.fetch = (async (_input, init) => init?.method === "POST" ? Response.json(member) : new Response("offline", { status: 503 })) as typeof fetch
    await memberActions.add("a", "alice")
    assert.equal(useMembersStore.getState().entries.a.data?.[0].username, "alice")
    assert.equal(useMembersStore.getState().entries.b, undefined)
  })
test("skill refresh updates the catalog, directory and open skill content together", async () => {
    skillActions.reset()
    let version = 1
    globalThis.fetch = (async input => {
      const path = new URL(String(input)).pathname
      return Response.json(path.endsWith("/catalog") ? [{ slug: "demo", name: `Demo ${version}` }] : path.endsWith("/list") ? [file(`v${version}.md`)] : { path: "/demo/SKILL.md", content: `version ${version}`, size: 1, binary: false, truncated: false })
    }) as typeof fetch
    await Promise.all([useSkillsStore.getState().load("catalog"), useSkillDirectoriesStore.getState().load("/demo"), useSkillContentsStore.getState().load("/demo/SKILL.md")])
    version = 2
    await refreshSkills()
    assert.equal(useSkillsStore.getState().entries.catalog.data?.[0].name, "Demo 2")
    assert.equal(useSkillDirectoriesStore.getState().entries["/demo"].data?.[0].name, "v2.md")
    assert.equal(useSkillContentsStore.getState().entries["/demo/SKILL.md"].data?.content, "version 2")
  })

test("live write completion refreshes its owning project while read tools do not", async () => {
  useWorkspaceStore.setState({ projects: [{
    project_id: "tool-project", owner_user_id: "u", project_name: "Test", access_role: "owner",
    owner_username: "admin", sandbox_status: "ready", created_at: "",
    sessions: [{ session_id: "s", project_id: "tool-project", model: "test", effort: "high",
      created_by_user_id: null, created_by_username: null,
      status: "ready", phase: null, title: null, created_at: "", last_seen_at: null }],
  }] })
  const paths: string[] = []
  globalThis.fetch = (async input => {
    const url = new URL(String(input))
    assert(url.pathname.includes("/projects/tool-project/"))
    const path = url.searchParams.get("path")!
    paths.push(path)
    return Response.json(path === "/" ? [dir("src")] : [file("new.ts")])
  }) as typeof fetch
  const chat = useChatStreamStore.getState()
  chat.handleEvent("s", { type: "tool.start", data: { toolId: "r", tool: "read", input: "{}" } })
  chat.handleEvent("s", { type: "tool.done", data: { toolId: "r", tool: "read" } })
  assert.equal(paths.length, 0)
  chat.handleEvent("s", { type: "tool.start", data: { toolId: "w", tool: "write", input: '{"path":"/work/src/new.ts"}' } })
  chat.handleEvent("s", { type: "tool.done", data: { toolId: "w", tool: "write" } })
  // Join the scheduled refresh; no model call or real network request occurs.
  await refreshFiles("tool-project")
  assert(paths.includes("/src"))
  assert.equal(useFilesStore.getState().entries[fileKey("tool-project", "/src")].data?.[0].name, "new.ts")
  useWorkspaceStore.setState({ projects: [] })
  chat.resetSession("s")
})
