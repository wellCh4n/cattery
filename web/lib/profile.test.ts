import { test } from "node:test"
import assert from "node:assert/strict"
import { profileName } from "./profile"
import { groupBy, userKey, userName } from "./usage"
import { tabForPath, tabHref } from "./tabs-store"

test("names fall back without changing login identity", () => {
  assert.equal(profileName({ name: " 小陈 ", username: "chen" }), "小陈")
  assert.equal(profileName({ name: "  ", username: "chen" }), "chen")
  assert.equal(profileName({ username: "deleted-user" }), "deleted-user")
  assert.equal(profileName(null), "Unknown")
})

test("users with the same name keep separate usage totals", () => {
  const rows = ["alice", "bob"].map(user_id => ({
    period: "2026-10-26", user_id, username: user_id, name: "同名用户", model: "m",
    requests: 1, input: 10, output: 2, cache_read: 0, cache_write: 0,
  }))
  const groups = groupBy(rows, userKey, userName)
  assert.equal(groups.length, 2)
  assert.ok(groups.every(g => g.label === "同名用户" && g.input === 10))
})

test("personal settings can be reopened from a workspace tab", () => {
  const tab = tabForPath("/settings")
  assert.deepEqual(tab, { kind: "settings", id: "profile" })
  assert.equal(tabHref(tab!), "/settings")
})
