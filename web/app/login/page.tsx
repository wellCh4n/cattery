"use client"

import { FormEvent, Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Cat, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuthStore } from "@/lib/auth-store"

// Next.js requires anything reading useSearchParams to sit inside a Suspense
// boundary so the page can still be prerendered. The wrapper page below is
// the suspense-friendly shell; LoginForm holds the actual hook.
export default function LoginPage() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background px-6">
      <Suspense fallback={<Loader2 className="size-5 animate-spin text-muted-foreground" />}>
        <LoginForm />
      </Suspense>
    </div>
  )
}

// safeNext rejects any value that isn't a same-origin path. Without this,
// a crafted `?next=//evil.com` (or `?next=https://evil.com`) would send the
// user off-site after login — classic open redirect. Single leading `/`
// followed by a non-`/` is the only shape we accept; root `/` is the default.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/"
  }
  return raw
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = safeNext(params.get("next"))
  const login = useAuthStore(s => s.login)
  const status = useAuthStore(s => s.status)
  const hydrate = useAuthStore(s => s.hydrate)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { void hydrate() }, [hydrate])
  useEffect(() => {
    if (status === "authed") router.replace(next)
  }, [status, next, router])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username.trim(), password)
      router.replace(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
      <div className="flex flex-col items-center gap-2 mb-2">
        <Cat className="size-7 text-foreground" />
        <span className="font-heading font-semibold tracking-tight">Cattery</span>
      </div>

      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          type="text"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
        Sign in
      </Button>
    </form>
  )
}
