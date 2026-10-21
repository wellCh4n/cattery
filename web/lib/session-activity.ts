import type { Session } from "@/lib/api"

export function sessionActivityTime(session: Session): string {
  return session.last_seen_at ?? session.created_at
}

export function compareSessionActivity(a: Session, b: Session): number {
  return Date.parse(sessionActivityTime(b)) - Date.parse(sessionActivityTime(a))
    || Date.parse(b.created_at) - Date.parse(a.created_at)
    || a.session_id.localeCompare(b.session_id)
}
