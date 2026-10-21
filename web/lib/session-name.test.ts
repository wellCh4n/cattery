import { test } from "node:test"
import assert from "node:assert/strict"
import { useWorkspaceStore } from "./workspace-store"
import type { ProjectWithSessions } from "./workspace-store"

test("late automatic title events cannot overwrite manual names", () => {
  const projects = [{ project_id: "p", sessions: [
    { session_id: "manual", title: "Chosen name", title_manual: true },
    { session_id: "auto", title: "Fallback", title_manual: false },
  ] }] as ProjectWithSessions[]
  useWorkspaceStore.setState({ projects })
  useWorkspaceStore.getState().updateSessionTitle("manual", "Late generated title")
  useWorkspaceStore.getState().updateSessionTitle("auto", "Generated title")
  assert.deepEqual(useWorkspaceStore.getState().projects[0].sessions.map(s => s.title), ["Chosen name", "Generated title"])
})
