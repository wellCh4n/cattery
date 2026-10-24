import type { SandboxApp } from "@/lib/api"

// A port that was gone for less than this is a restart (a dev server reloading
// its config), not a new app.
const RESTART_MS = 30_000

// Tracks which ports a project's polls have seen and reports the ones that
// appear. The first list is the baseline: apps already running when the
// project opens don't count as new.
export class NewPortDetector {
  private lastSeen = new Map<number, number>()
  private previous: Set<number> | null = null

  next(apps: SandboxApp[], now: number): SandboxApp[] {
    const fresh = this.previous === null ? [] : apps.filter(app => {
      if (this.previous!.has(app.port)) return false
      const seen = this.lastSeen.get(app.port)
      return seen === undefined || now - seen > RESTART_MS
    })
    this.previous = new Set(apps.map(app => app.port))
    for (const app of apps) this.lastSeen.set(app.port, now)
    return fresh
  }
}
