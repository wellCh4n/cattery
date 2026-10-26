// Token usage dashboard helpers. Dates are calendar days ("YYYY-MM-DD") in the
// viewer's time zone; the backend buckets by the same zone, so period keys
// here match the ones it returns. Day arithmetic runs in UTC so it never
// shifts across a DST change.

import type { UsageRow } from "./api"

export type Bucket = "day" | "week" | "month"

export const TOKEN_KINDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cache_read", label: "Cache read" },
  { key: "cache_write", label: "Cache write" },
] as const

export type TokenKind = (typeof TOKEN_KINDS)[number]["key"]

export interface Totals {
  requests: number
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export const emptyTotals = (): Totals => ({ requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 })

export function addTotals(into: Totals, r: Totals): Totals {
  into.requests += r.requests
  into.input += r.input
  into.output += r.output
  into.cache_read += r.cache_read
  into.cache_write += r.cache_write
  return into
}

// Every token the provider counted: pi reports input without the cached part.
export const totalTokens = (t: Totals) => t.input + t.output + t.cache_read + t.cache_write

// The share of prompt tokens read from the cache, or null without prompts.
export function cacheHitRate(t: Totals): number | null {
  const prompt = t.input + t.cache_read + t.cache_write
  return prompt ? t.cache_read / prompt : null
}

// Relative change from prev to cur, or null when prev is zero.
export const change = (cur: number, prev: number): number | null => (prev ? (cur - prev) / prev : null)

const parse = (day: string) => new Date(`${day}T00:00:00Z`)
const format = (d: Date) => d.toISOString().slice(0, 10)

export function addDays(day: string, n: number): string {
  const d = parse(day)
  d.setUTCDate(d.getUTCDate() + n)
  return format(d)
}

// Days from..to, both included.
export const daysIn = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000) + 1

// The range of the same length that ends the day before from.
export function previousRange(from: string, to: string): [string, string] {
  return [addDays(from, -daysIn(from, to)), addDays(from, -1)]
}

// Days for a month or so, weeks up to half a year, months beyond.
export function autoBucket(from: string, to: string): Bucket {
  const days = daysIn(from, to)
  return days <= 45 ? "day" : days <= 190 ? "week" : "month"
}

// Today in the viewer's time zone.
export function today(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// The first day of the bucket holding day; weeks start Monday, like Postgres.
export function periodStart(day: string, bucket: Bucket): string {
  if (bucket === "day") return day
  if (bucket === "month") return `${day.slice(0, 7)}-01`
  const d = parse(day)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return format(d)
}

// Every period from the one holding from to the one holding to.
export function periods(from: string, to: string, bucket: Bucket): string[] {
  const out: string[] = []
  const last = periodStart(to, bucket)
  for (let p = periodStart(from, bucket); p <= last; ) {
    out.push(p)
    if (bucket === "day") p = addDays(p, 1)
    else if (bucket === "week") p = addDays(p, 7)
    else {
      const d = parse(p)
      d.setUTCMonth(d.getUTCMonth() + 1)
      p = format(d)
    }
  }
  return out
}

export interface RangePreset {
  id: string
  label: string
  range: (today: string) => [string, string]
}

export const RANGE_PRESETS: RangePreset[] = [
  { id: "today", label: "Today", range: t => [t, t] },
  { id: "7d", label: "Last 7 days", range: t => [addDays(t, -6), t] },
  { id: "30d", label: "Last 30 days", range: t => [addDays(t, -29), t] },
  { id: "90d", label: "Last 90 days", range: t => [addDays(t, -89), t] },
  { id: "mtd", label: "This month", range: t => [periodStart(t, "month"), t] },
  {
    id: "last-month",
    label: "Last month",
    range: t => {
      const start = periodStart(addDays(periodStart(t, "month"), -1), "month")
      return [start, addDays(periodStart(t, "month"), -1)]
    },
  },
  { id: "ytd", label: "This year", range: t => [`${t.slice(0, 4)}-01-01`, t] },
]

const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
const monthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" })

export function periodLabel(period: string, bucket: Bucket): string {
  const d = parse(period)
  if (bucket === "month") return monthYear.format(d)
  return monthDay.format(d)
}

const longDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

// "Oct 1 – Oct 30" within this year, "Dec 1, 2025 – Jan 31, 2026" otherwise:
// both ends always alike.
export function rangeLabel(from: string, to: string): string {
  const thisYear = today().slice(0, 4)
  const fmt = from.slice(0, 4) === thisYear && to.slice(0, 4) === thisYear ? monthDay : longDay
  if (from === to) return fmt.format(parse(from))
  return `${fmt.format(parse(from))} – ${fmt.format(parse(to))}`
}

export function periodTitle(period: string, bucket: Bucket): string {
  if (bucket === "week") return `Week of ${periodLabel(period, bucket)}`
  if (bucket === "day") {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parse(period))
  }
  return periodLabel(period, bucket)
}

// 950, 12.9K, 4.2M, 1.1B.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const units = ["K", "M", "B", "T"]
  let v = n
  let i = -1
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  const digits = v < 10 ? 1 : 0
  return `${v.toFixed(digits).replace(/\.0$/, "")}${units[i]}`
}

// 0.123 → "12%", 0.004 → "0.4%".
export function formatPercent(f: number): string {
  const p = f * 100
  return `${p < 10 && p > 0 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`
}

// Users deleted since keep their username snapshot; sessions deleted before
// their usage was collected keep no user at all.
export function userKey(r: Pick<UsageRow, "user_id" | "username">): string {
  return r.user_id ?? (r.username ? `name:${r.username}` : "unknown")
}

export function userName(r: Pick<UsageRow, "user_id" | "username" | "name">): string {
  return r.name?.trim() || r.username || "Unknown"
}

export interface Group extends Totals {
  key: string
  label: string
}

// Sums rows per key, largest total first.
export function groupBy(rows: UsageRow[], key: (r: UsageRow) => string, label: (r: UsageRow) => string): Group[] {
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const k = key(r)
    let g = groups.get(k)
    if (!g) groups.set(k, g = { key: k, label: label(r), ...emptyTotals() })
    addTotals(g, r)
  }
  return [...groups.values()].sort((a, b) => totalTokens(b) - totalTokens(a) || a.label.localeCompare(b.label))
}

// A y-axis top and step with clean numbers: 1, 2, 2.5 or 5 times a power of 10.
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 }
  const raw = max / ticks
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw)!
  return { top: step * Math.ceil(max / step), step }
}
