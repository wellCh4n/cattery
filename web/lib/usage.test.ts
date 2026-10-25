import { test } from "node:test"
import assert from "node:assert/strict"
import { RANGE_PRESETS, formatTokens, groupBy, niceScale, periodStart, periods, userKey } from "./usage"

test("weeks start on Monday and months on the 1st", () => {
  assert.equal(periodStart("2026-10-04", "week"), "2026-09-28") // a Sunday
  assert.equal(periodStart("2026-10-05", "week"), "2026-10-05")
  assert.equal(periodStart("2026-10-25", "month"), "2026-10-01")
})

test("periods cover the range in whole buckets", () => {
  assert.deepEqual(periods("2026-10-30", "2026-11-02", "day"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
  assert.deepEqual(periods("2026-10-01", "2026-10-14", "week"), ["2026-09-28", "2026-10-05", "2026-10-12"])
  assert.deepEqual(periods("2026-11-15", "2027-01-02", "month"), ["2026-11-01", "2026-12-01", "2027-01-01"])
})

test("range presets end today", () => {
  const range = (id: string) => RANGE_PRESETS.find(p => p.id === id)!.range("2026-03-10")
  assert.deepEqual(range("7d"), ["2026-03-04", "2026-03-10"])
  assert.deepEqual(range("last-month"), ["2026-02-01", "2026-02-28"])
  assert.deepEqual(range("ytd"), ["2026-01-01", "2026-03-10"])
})

test("token counts compact from a thousand", () => {
  assert.deepEqual([950, 1000, 12_940, 4_200_000, 1_050_000_000].map(formatTokens), ["950", "1K", "13K", "4.2M", "1.1B"])
})

test("groups sum per key, largest first", () => {
  const row = (user_id: string | null, username: string | null, input: number) =>
    ({ period: "2026-10-01", user_id, username, model: "m", requests: 1, input, output: 0, cache_read: 0, cache_write: 0 })
  const rows = [row("a", "alice", 5), row("b", "bob", 20), row("a", "alice", 10), row(null, "gone", 1), row(null, null, 2)]
  const groups = groupBy(rows, userKey, r => r.username ?? "Unknown")
  assert.deepEqual(groups.map(g => [g.key, g.input, g.requests]), [["b", 20, 1], ["a", 15, 2], ["unknown", 2, 1], ["name:gone", 1, 1]])
})

test("the y-axis rounds up to a clean step", () => {
  assert.deepEqual(niceScale(0), { top: 4, step: 1 })
  assert.deepEqual(niceScale(930), { top: 1000, step: 250 })
  assert.deepEqual(niceScale(4_100_000), { top: 6_000_000, step: 2_000_000 })
})
