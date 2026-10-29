"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, RotateCw } from "lucide-react"
import { EffortPicker, ModelPicker } from "@/components/model-picker"
import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  type BotChannelType,
  type Channel,
  createBotChannel,
  pollWeixinLogin,
  startWeixinLogin,
  updateChannel,
  verifyWeixinLogin,
  type WeixinLogin,
} from "@/lib/api"
import { applyChannel, platformName } from "@/lib/channels-store"
import { catalogHas, effortFor, readLastEffort, readLastModel, useModelsStore } from "@/lib/models"
import { cn } from "@/lib/utils"

const errorText = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback

// The model and effort a new channel starts on; they can be switched later in
// its chat view, like a session's.
interface ChannelModel {
  model: string
  effort: string
}

// Offers the last model picked (like a new session), or the catalog default,
// until the user picks another.
function useChannelModel() {
  const catalog = useModelsStore(state => state.catalog)
  const [picked, setPicked] = useState<Partial<ChannelModel>>({})
  useEffect(() => {
    void useModelsStore.getState().load().catch(() => {})
  }, [])
  const [last] = useState(() => ({ model: readLastModel(), effort: readLastEffort() }))
  let model = picked.model ?? ""
  if (!model && catalog) model = catalogHas(catalog, last.model) ? last.model : catalog.default
  const effort = catalog && model ? effortFor(catalog, model, picked.effort ?? last.effort) : ""
  const pick = async (change: Partial<ChannelModel>) => setPicked(p => ({ ...p, ...change }))
  return { model, effort, pick }
}

const PLATFORMS: { type: Channel["type"]; title: string }[] = [
  { type: "feishu", title: "Feishu" },
  { type: "lark", title: "Lark" },
  { type: "weixin", title: "Weixin" },
]

// Adds a channel in one dialog: its platform (choice cards), name and model,
// then the platform's own setup — the Feishu or Lark app's credentials, or a WeChat
// scan, which creates the channel as soon as it is confirmed.
export function AddChannelDialog({ projectId, onClose, onCreated }: {
  projectId: string
  onClose: () => void
  onCreated: (channel: Channel) => void
}) {
  const [type, setType] = useState<Channel["type"]>("feishu")
  const [name, setName] = useState("")
  const { model, effort, pick } = useChannelModel()
  const [appId, setAppId] = useState("")
  const [secret, setSecret] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canAdd = !saving && !!model && !!appId.trim() && !!secret.trim()
  // A WeChat login starts with what is picked then; later changes are applied
  // once the scan creates the channel.
  const wanted = useRef({ name, model, effort })
  useEffect(() => { wanted.current = { name: name.trim(), model, effort } })

  async function addBot(botType: BotChannelType) {
    if (!canAdd) return
    setSaving(true)
    setError(null)
    try {
      const channel = await createBotChannel(projectId, { type: botType, name, app_id: appId.trim(), app_secret: secret.trim(), model, effort })
      applyChannel(channel)
      onCreated(channel)
    } catch (err) { setError(errorText(err, "Failed to add the bot")) }
    finally { setSaving(false) }
  }

  async function weixinDone(channel: Channel) {
    const { name: want, model: m, effort: e } = wanted.current
    const change = {
      ...(want && want !== channel.name ? { name: want } : {}),
      ...(m && m !== channel.model ? { model: m } : {}),
      ...(e && e !== channel.effort ? { effort: e } : {}),
    }
    if (Object.keys(change).length) channel = await updateChannel(channel.channel_id, change).catch(() => channel)
    applyChannel(channel)
    onCreated(channel)
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>Talk to this project&apos;s agent from a chat app.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <RadioGroup value={type} onValueChange={value => { setType(value as Channel["type"]); setError(null) }} disabled={saving} className="grid-cols-3">
            {PLATFORMS.map(platform => (
              <FieldLabel key={platform.type} htmlFor={`channel-type-${platform.type}`} className="cursor-pointer">
                <Field orientation="horizontal">
                  <PlatformIcon type={platform.type} className="size-4 shrink-0 text-muted-foreground" />
                  <FieldContent>
                    <FieldTitle>{platform.title}</FieldTitle>
                  </FieldContent>
                  <RadioGroupItem value={platform.type} id={`channel-type-${platform.type}`} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" value={name} disabled={saving} onChange={e => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <div className="flex flex-wrap items-center gap-2">
              <ModelPicker sessionId="" model={model} disabled={!model || saving} onChange={pick} />
              <EffortPicker sessionId="" model={model} effort={effort} disabled={!model || saving} onChange={pick} />
            </div>
          </div>
          {type !== "weixin" ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Use a self-built {platformName(type)} app with its bot enabled, receiving events over the
                long connection (subscribe to im.message.receive_v1) and allowed to send messages. Its
                direct messages from you reach this project&apos;s agent.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feishu-app-id">App ID</Label>
                <Input id="feishu-app-id" value={appId} disabled={saving} onChange={e => setAppId(e.target.value)} placeholder="cli_…" autoComplete="off" spellCheck={false} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feishu-app-secret">App Secret</Label>
                <Input id="feishu-app-secret" type="password" value={secret} disabled={saving} onChange={e => setSecret(e.target.value)} autoComplete="off" />
              </div>
            </div>
          ) : model ? (
            <WeixinQR projectId={projectId} start={{ name: name.trim(), model, effort }} onDone={channel => void weixinDone(channel)} />
          ) : (
            <div className="flex h-24 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {type !== "weixin" && (
            <Button onClick={() => void addBot(type)} disabled={!canAdd}>
              {saving && <Loader2 className="animate-spin" />}
              Add bot
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const LOGIN_TEXT: Record<WeixinLogin["status"], string> = {
  wait: "Scan the code with the WeChat you will message from. WeChat lets a bot reply but never message first.",
  scaned: "Scanned. Confirm on your phone.",
  need_verifycode: "Enter the code WeChat shows on your phone.",
  verify_code_blocked: "Too many wrong codes. Get a new QR code and try again.",
  expired: "This code expired.",
  confirmed: "Connected.",
}

// A WeChat QR login: for a new channel (starting on start), or with
// channelId to renew that channel's login.
function WeixinQR({ projectId, channelId, start, onDone }: {
  projectId: string
  channelId?: string
  start?: ChannelModel & { name: string }
  onDone: (channel: Channel) => void
}) {
  const [login, setLogin] = useState<WeixinLogin | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [attempt, setAttempt] = useState(0)
  const done = useRef(onDone)
  // Read when a login starts; changing them does not restart one.
  const startRef = useRef(start)
  useEffect(() => {
    done.current = onDone
    startRef.current = start
  })

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLogin(null)
      setQr(null)
      setError(null)
      try {
        const begun = await startWeixinLogin(projectId, channelId ? { channel_id: channelId } : { ...startRef.current })
        if (ctrl.signal.aborted) return
        setLogin(begun)
        setQr(begun.qr ?? null)
        for (;;) {
          const next = await pollWeixinLogin(projectId, begun.login_id, ctrl.signal)
          if (ctrl.signal.aborted) return
          setLogin(next)
          if (next.error) { setError(next.error); return }
          if (next.status === "confirmed" && next.channel) {
            done.current(next.channel)
            return
          }
          if (next.status === "expired" || next.status === "verify_code_blocked") return
          await new Promise(r => setTimeout(r, 300))
        }
      } catch (err) {
        if (!ctrl.signal.aborted) setError(errorText(err, "WeChat login failed"))
      }
    }
    void run()
    return () => ctrl.abort()
  }, [projectId, channelId, attempt])

  async function verify() {
    if (!login || !code.trim()) return
    try {
      await verifyWeixinLogin(projectId, login.login_id, code.trim())
      setCode("")
    } catch (err) { setError(errorText(err, "Failed to send the code")) }
  }

  const status = login?.status ?? "wait"
  const stale = status === "expired" || status === "verify_code_blocked" || !!error
  return (
    <div className="flex flex-col items-center gap-3">
      <div className={cn("flex size-52 items-center justify-center rounded-lg border bg-white p-2", stale && "opacity-30")}>
        {qr ? (
          // A data URL drawn by the backend; next/image has nothing to optimize.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="WeChat login QR code" className="size-full" />
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        )}
      </div>
      <p className={cn("max-w-sm text-center text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? LOGIN_TEXT[status]}
      </p>
      {status === "need_verifycode" && !error && (
        <div className="flex w-full max-w-56 gap-2">
          <Input value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void verify() }}
            inputMode="numeric" autoComplete="one-time-code" placeholder="Code" autoFocus />
          <Button onClick={() => void verify()} disabled={!code.trim()}>Send</Button>
        </div>
      )}
      {stale && (
        <Button variant="outline" size="sm" onClick={() => setAttempt(n => n + 1)}>
          <RotateCw />
          New QR code
        </Button>
      )}
    </div>
  )
}

// Renews a WeChat channel's login (after it expired, or to switch accounts).
export function RescanWeixinDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scan again for {channel.name}</DialogTitle>
          <DialogDescription>The agent answers the account that scans; its conversation stays as it is.</DialogDescription>
        </DialogHeader>
        <WeixinQR projectId={channel.project_id} channelId={channel.channel_id} onDone={updated => { applyChannel(updated); onClose() }} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The channel's settings, for its creator.
export function EditChannelDialog({ channel, onClose, onRescan }: {
  channel: Channel
  onClose: () => void
  onRescan: () => void
}) {
  const [name, setName] = useState(channel.name)
  const [secret, setSecret] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = saving

  async function save(change: Parameters<typeof updateChannel>[1], close = true) {
    setSaving(true)
    setError(null)
    try {
      applyChannel(await updateChannel(channel.channel_id, change))
      if (close) onClose()
    } catch (err) { setError(errorText(err, "Failed to save")) }
    finally { setSaving(false) }
  }

  const nextName = name.trim()
  const changed = (nextName && nextName !== channel.name) || secret.trim() !== ""
  const platform = platformName(channel.type)
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {channel.name}</DialogTitle>
          <DialogDescription>
            {platform} · {channel.account}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" value={name} disabled={busy} onChange={e => setName(e.target.value)} autoComplete="off" />
          </div>
          {channel.type !== "weixin" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-secret">App Secret</Label>
              <Input id="channel-secret" type="password" value={secret} disabled={busy} onChange={e => setSecret(e.target.value)}
                placeholder="Unchanged" autoComplete="off" />
            </div>
          )}
          {channel.type !== "weixin" && !channel.bound && channel.bind_code && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">
              To connect your {platform} account, send <code className="font-mono">/bind {channel.bind_code}</code> to the bot.
            </p>
          )}
          <div className="flex flex-col gap-2 rounded-md border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {channel.enabled ? statusText(channel) : `Disconnected from ${platform}`}
              </span>
              <div className="flex gap-2">
                {channel.type === "weixin" && (
                  <Button size="xs" variant="outline" disabled={busy} onClick={onRescan}>Scan again</Button>
                )}
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void save({ enabled: !channel.enabled }, false)}>
                  {channel.enabled ? "Disconnect" : "Connect"}
                </Button>
              </div>
            </div>
            {channel.last_error && channel.status !== "connected" && <p className="text-destructive">{channel.last_error}</p>}
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button
            disabled={busy || !changed}
            onClick={() => void save({
              ...(nextName && nextName !== channel.name ? { name: nextName } : {}),
              ...(secret.trim() ? { app_secret: secret.trim() } : {}),
            })}
          >
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function statusText(channel: Channel): string {
  switch (channel.status) {
    case "connected":  return channel.bound ? "Connected" : "Connected, waiting for /bind"
    case "connecting": return "Connecting…"
    case "expired":    return "Login expired"
    case "error":      return "Can't connect"
    case "disabled":   return "Disconnected"
  }
}
