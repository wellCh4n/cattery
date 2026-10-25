"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { UsageDashboard } from "@/components/usage-dashboard"
import { useAuthStore } from "@/lib/auth-store"

// Everyone's usage, for admins.
export default function AdminUsagePage() {
  const router = useRouter()
  const me = useAuthStore(s => s.user)

  // Same quiet bounce as the Users page; the server 403s anyway.
  useEffect(() => {
    if (me && !me.is_admin) router.replace("/usage")
  }, [me, router])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex h-full min-h-[36rem] max-w-5xl flex-col px-6 py-6">
        <UsageDashboard scope="all" />
      </div>
    </div>
  )
}
