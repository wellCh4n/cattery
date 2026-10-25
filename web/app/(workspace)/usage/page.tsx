"use client"

import { UsageDashboard } from "@/components/usage-dashboard"

// The signed-in user's own usage. Admins see everyone's under /admin/usage.
export default function UsagePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <UsageDashboard scope="mine" />
      </div>
    </div>
  )
}
