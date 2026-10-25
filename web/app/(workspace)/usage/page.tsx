"use client"

import { UsageDashboard } from "@/components/usage-dashboard"

// The signed-in user's own usage. Admins see everyone's under /admin/usage.
export default function UsagePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex h-full min-h-[36rem] max-w-5xl flex-col px-6 py-6">
        <UsageDashboard scope="mine" />
      </div>
    </div>
  )
}
