"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Sidebar } from "@/components/sidebar"
import { useAuthStore } from "@/lib/auth-store"

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const status = useAuthStore(s => s.status)
  const hydrate = useAuthStore(s => s.hydrate)

  // Single hydrate on first mount. authedFetch handles in-flight 401s by
  // bouncing to /login; this useEffect handles the "no token at all" case.
  useEffect(() => { void hydrate() }, [hydrate])
  useEffect(() => {
    if (status === "anon") {
      const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : ""
      router.replace(`/login${next}`)
    }
  }, [status, pathname, router])

  // Periodically re-validate the token / user. Catches three cases the
  // initial hydrate misses: token expired mid-session, admin deleted the
  // user, admin demoted them. /me responds 401 for the first two; the
  // authedFetch 401 handler then bounces to /login. The third case just
  // refreshes is_admin so the admin UI stops showing.
  useEffect(() => {
    if (status !== "authed") return
    const t = setInterval(() => { void hydrate() }, 60_000)
    return () => clearInterval(t)
  }, [status, hydrate])

  if (status !== "authed") {
    // Keep the screen blank-ish during loading and during the brief moment
    // before the /login redirect lands — don't flash the sidebar.
    return (
      <div className="flex h-screen w-screen items-center justify-center text-muted-foreground">
        {status === "loading" ? <Loader2 className="size-5 animate-spin" /> : null}
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  )
}
