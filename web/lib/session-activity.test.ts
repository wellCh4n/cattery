import { test } from "node:test"
import assert from "node:assert/strict"
import { compareSessionActivity, sessionActivityTime } from "./session-activity"
import type { Session } from "./api"

const session = (id: string, created: string, seen: string | null = null): Session => ({
  session_id: id, project_id: "p", model: "test", effort: "high", status: "ready",
  created_by_user_id: null, created_by_username: null,
  phase: null, title: null, created_at: created, last_seen_at: seen,
})

test("last activity controls both the displayed timestamp and session ordering", () => {
  const older = session("old", "2026-10-20T01:00:00Z", "2026-10-21T09:00:00Z")
  const newer = session("new", "2026-10-21T08:00:00Z")
  assert.equal(sessionActivityTime(older), "2026-10-21T09:00:00Z")
  assert.equal(sessionActivityTime(newer), newer.created_at)
  assert.deepEqual([newer, older].sort(compareSessionActivity).map(s => s.session_id), ["old", "new"])
})

test("new sessions use creation time and equal activity timestamps have stable ordering", () => {
  const a = session("a", "2026-10-21T08:00:00Z")
  const b = session("b", "2026-10-21T08:00:00Z")
  const previous = session("previous", "2026-10-20T08:00:00Z")
  assert.deepEqual([b, previous, a].sort(compareSessionActivity).map(s => s.session_id), ["a", "b", "previous"])
})
