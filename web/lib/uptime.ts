// How long a process has been running, in its two largest units: 42s, 5m,
// 3h 4m, 2d 3h.
export function formatUptime(startedAt: string | undefined, now: number): string | null {
  const start = startedAt ? Date.parse(startedAt) : NaN
  if (Number.isNaN(start)) return null
  const s = Math.max(0, Math.floor((now - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
