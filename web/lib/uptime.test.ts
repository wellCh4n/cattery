import { test } from "node:test"
import assert from "node:assert/strict"
import { formatUptime } from "./uptime"

test("uptime shows its two largest units", () => {
  const now = Date.parse("2026-10-24T12:00:00Z")
  const ago = (s: number) => new Date(now - s * 1000).toISOString()
  assert.equal(formatUptime(ago(42), now), "42s")
  assert.equal(formatUptime(ago(5 * 60 + 30), now), "5m")
  assert.equal(formatUptime(ago(3 * 3600 + 4 * 60), now), "3h 4m")
  assert.equal(formatUptime(ago(2 * 86400 + 3 * 3600 + 59), now), "2d 3h")
  // A pod clock slightly ahead of the browser's.
  assert.equal(formatUptime(ago(-2), now), "0s")
  assert.equal(formatUptime(undefined, now), null)
  assert.equal(formatUptime("not a date", now), null)
})
