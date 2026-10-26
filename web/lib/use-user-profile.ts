"use client"

import { useAuthStore } from "@/lib/auth-store"
import type { UserIdentity } from "@/lib/profile"

export function useUserProfile(profile: UserIdentity): UserIdentity {
  const current = useAuthStore(s => s.user)
  return current && current.user_id === profile.user_id ? current : profile
}
