import type { ProfileFields } from "@/lib/api"

export interface UserIdentity extends ProfileFields {
  user_id?: string | null
  username?: string | null
}

export function profileName(user?: UserIdentity | null): string {
  return user?.name?.trim() || user?.username?.trim() || "Unknown"
}
