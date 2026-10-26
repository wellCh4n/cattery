"use client"

import { useRef, useState, type FormEvent } from "react"
import { Camera, KeyRound, Loader2 } from "lucide-react"
import { AvatarCropDialog } from "@/components/avatar-crop-dialog"
import { ChangePasswordDialog } from "@/components/change-password-dialog"
import { UserAvatar } from "@/components/user-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateMyAvatar, updateMyName, type CurrentUser } from "@/lib/api"
import { useAuthStore } from "@/lib/auth-store"
import { useDocumentTitle } from "@/lib/use-document-title"

export default function SettingsPage() {
  const user = useAuthStore(s => s.user)
  useDocumentTitle("Personal settings")
  return user ? <ProfileSettings key={user.user_id} user={user} /> : null
}

function ProfileSettings({ user }: { user: CurrentUser }) {
  const updateUser = useAuthStore(s => s.updateUser)
  // A null draft follows server refreshes; an edited draft is never overwritten.
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? user.name ?? ""
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  function saved(updated: CurrentUser, message: string) {
    updateUser(updated)
    setNotice(message)
    setError(null)
  }

  async function saveName(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    try { saved(await updateMyName(name), "Profile saved"); setDraft(null) }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save profile") }
    finally { setSaving(false) }
  }

  async function removeAvatar() {
    setRemoving(true)
    setNotice(null)
    setError(null)
    try { saved(await updateMyAvatar(null), "Avatar removed") }
    catch (err) { setError(err instanceof Error ? err.message : "Could not remove avatar") }
    finally { setRemoving(false) }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 sm:px-10">
        <header className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Personal settings</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Manage how you appear to your team.</p>
        </header>

        <section className="flex flex-wrap items-center gap-5 border-b pb-7" aria-label="Profile photo">
          <UserAvatar {...user} className="size-20 text-2xl" />
          <div className="space-y-2.5">
            <h2 className="text-sm font-medium">Avatar</h2>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={removing || saving} onClick={() => input.current?.click()}><Camera />{user.avatar_version ? "Change avatar" : "Upload avatar"}</Button>
              {user.avatar_version && <Button variant="ghost" size="sm" disabled={removing || saving} onClick={() => void removeAvatar()}>{removing && <Loader2 className="animate-spin" />}Remove</Button>}
            </div>
            <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 2 MB. Crop before saving.</p>
          </div>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose avatar image" className="hidden" onChange={event => {
            const selected = event.target.files?.[0]
            event.target.value = ""
            if (!selected) return
            setNotice(null)
            if (selected.size > 2 * 1024 * 1024) { setError("Choose an image smaller than 2 MB."); return }
            if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) { setError("Choose a JPEG, PNG or WebP image."); return }
            setError(null)
            setFile(selected)
          }} />
        </section>

        <form className="space-y-5 border-b py-7" onSubmit={saveName}>
          <div className="space-y-2">
            <Label htmlFor="profile-username">Username</Label>
            <Input id="profile-username" value={user.username} readOnly className="bg-muted/40 text-muted-foreground" aria-describedby="username-help" />
            <p id="username-help" className="text-xs text-muted-foreground">Your sign-in username cannot be changed here.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" value={name} placeholder={user.username} autoComplete="nickname" disabled={saving} aria-describedby="name-help" onChange={e => { setDraft(e.target.value); setNotice(null) }} />
            <p id="name-help" className="text-xs text-muted-foreground">Shown across Cattery. Leave blank to use your username. Up to 64 characters.</p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving || removing || name.trim() === (user.name ?? "") || Array.from(name.trim()).length > 64}>{saving && <Loader2 className="animate-spin" />}Save changes</Button>
          </div>
        </form>

        <section className="flex flex-wrap items-center justify-between gap-4 py-7" aria-label="Security">
          <div><h2 className="text-sm font-medium">Password</h2><p className="mt-1 text-xs text-muted-foreground">Use your current password to choose a new one.</p></div>
          <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}><KeyRound />Change password</Button>
        </section>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
      </div>
      {file && <AvatarCropDialog file={file} onClose={() => setFile(null)} onSave={async image => {
        saved(await updateMyAvatar(image), "Avatar updated")
        setFile(null)
      }} />}
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  )
}
