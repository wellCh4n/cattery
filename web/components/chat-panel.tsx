"use client"

import { useCallback, useState, useEffect, useRef } from "react"
import {
  Bot,
  ArrowUp,
  ArrowDown,
  Square,
  Loader2,
  CheckCircle2,
  CircleAlert,
  Wrench,
  Sparkles,
  AlertTriangle,
  CornerDownLeft,
  Brain,
  ChevronDown,
  Copy,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/markdown"
import { FileViewer } from "@/components/file-viewer"
import { cn } from "@/lib/utils"
import { answerSession, type Session, type Harness, type QuestionAnswer } from "@/lib/api"
import {
  useChatStreamStore,
  type Bubble,
  type ParsedFileRead,
  type ParsedGlob,
} from "@/lib/chat-stream-store"

interface Props {
  session: Session
  harness: Harness
}

const EMPTY_BUBBLES: Bubble[] = []

export function ChatPanel({ session, harness }: Props) {
  const [input, setInput] = useState("")
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const chat = useChatStreamStore(state => state.sessions[session.session_id])
  const bubbles = chat?.bubbles ?? EMPTY_BUBBLES
  const sending = chat?.sending ?? false
  const ensureSession = useChatStreamStore(state => state.ensureSession)
  const loadHistory = useChatStreamStore(state => state.loadHistory)
  const sendMessage = useChatStreamStore(state => state.sendMessage)
  const stopSession = useChatStreamStore(state => state.stopSession)
  const title = session.title
  const harnessName = harness.harness_name ?? "Untitled"

  const isNearBottom = useCallback((): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96
  }, [])

  const updateJumpVisibility = useCallback(() => {
    setShowJumpToBottom(!isNearBottom())
  }, [isNearBottom])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => {
      if (isNearBottom()) {
        scrollToBottom("smooth")
      } else {
        setShowJumpToBottom(true)
      }
    })
  }, [bubbles, isNearBottom, scrollToBottom, sending])

  useEffect(() => {
    if (session.status !== "ready") return
    ensureSession(session.session_id)
    let cancelled = false
    loadHistory(session.session_id).then(() => {
      if (cancelled) return
      requestAnimationFrame(() => {
        scrollToBottom("auto")
        updateJumpVisibility()
      })
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [ensureSession, loadHistory, scrollToBottom, session.session_id, session.status, updateJumpVisibility])

  async function handleStop() {
    await stopSession(session.session_id)
  }

  async function handleSend() {
    if (!input.trim() || sending) return
    const text = input.trim()
    setInput("")
    void sendMessage(session.session_id, text)
  }

  function statusVariant(s: string): "default" | "secondary" | "destructive" {
    if (s === "ready") return "default"
    if (s === "failed") return "destructive"
    return "secondary"
  }

  function phaseLabel(phase: string | null): string {
    switch (phase) {
      case "handshake":       return "Connecting to agent"
      case "handshake_error": return "Failed to connect to agent"
      case "sandbox_error":   return "Sandbox failed to start"
      default:                return phase ?? ""
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="border-b px-4 h-12 flex items-center gap-3 shrink-0">
        <Bot className="size-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium truncate">{title ?? "New Session"}</span>
          <span className="text-muted-foreground/50 shrink-0">/</span>
          <span className="text-xs text-muted-foreground truncate min-w-0">
            {harnessName}
          </span>
        </div>
        <Badge variant={statusVariant(session.status)} className="text-[10px] h-5">
          {session.status}
        </Badge>
      </header>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={updateJumpVisibility}
          className="h-full overflow-y-auto px-4 md:px-8 py-6"
        >
          <div className="max-w-3xl mx-auto space-y-4">
            {session.status === "creating" && (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>Starting sandbox… {phaseLabel(session.phase)}</span>
              </div>
            )}
            {session.status === "failed" && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>{phaseLabel(session.phase)}</span>
              </div>
            )}
            {session.status === "ready" && bubbles.length === 0 && (
              <div className="flex flex-col items-center justify-center text-center py-16">
                <div className="rounded-full bg-muted p-3 mb-3">
                  <Sparkles className="size-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">Session ready</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Send a message to start working with {harness.harness_name ?? "the harness"}.
                </p>
              </div>
            )}
            {bubbles.map((b) => <BubbleRow key={b.id} bubble={b} sessionId={session.session_id} />)}
            {sending && (
              // Persistent loader anchored below the last message — stays until
              // session.idle (or error) flips `sending` back to false.
              <div className="flex justify-start pl-1">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
        {showJumpToBottom && (
          <div className="pointer-events-none absolute inset-x-4 bottom-3 md:inset-x-8">
            <div className="mx-auto flex max-w-3xl justify-end">
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                title="Jump to bottom"
                aria-label="Jump to bottom"
                onClick={() => {
                  scrollToBottom("smooth")
                  setShowJumpToBottom(false)
                }}
                className="pointer-events-auto rounded-full shadow-md"
              >
                <ArrowDown />
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="bg-background px-4 md:px-8 pb-4 pt-2 shrink-0">
        <div className="max-w-3xl mx-auto">
          <div
            className={cn(
              "group/composer rounded-2xl border bg-background shadow-sm transition-colors",
              "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
              session.status !== "ready" && "opacity-70",
              sending && "bg-muted/60"
            )}
          >
            <Textarea
              className="w-full resize-none border-0 bg-transparent dark:bg-transparent disabled:bg-transparent dark:disabled:bg-transparent min-h-[52px] max-h-48 px-4 pt-3 pb-1 text-sm shadow-none focus-visible:ring-0 focus-visible:border-0 outline-none [field-sizing:content]"
              rows={1}
              value={input}
              disabled={session.status !== "ready" || sending}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <span className="pl-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70 select-none">
                <CornerDownLeft className="size-3" />
                <span>Send</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">⇧</span>
                <CornerDownLeft className="size-3" />
                <span>Newline</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono font-medium text-[10px]">{harness.model}</span>
              </span>
              {sending ? (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  onClick={handleStop}
                  title="Stop"
                  className="rounded-full"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  disabled={session.status !== "ready" || !input.trim()}
                  onClick={handleSend}
                  title="Send"
                  className="rounded-full"
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ThinkingBubble({ bubble }: { bubble: Bubble }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] min-w-[50%] rounded-lg border border-dashed bg-muted/20">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <Brain className="size-3" />
          <span className="font-mono">thinking</span>
          {!bubble.done && <Loader2 className="size-3 animate-spin ml-1" />}
          <ChevronDown className={cn("size-3 ml-auto transition-transform", !open && "-rotate-90")} />
        </button>
        {open && (
          <Markdown className="px-3 pb-2.5 text-xs text-muted-foreground italic [&_*]:text-inherit">
            {bubble.content}
          </Markdown>
        )}
      </div>
    </div>
  )
}

function BubbleRow({ bubble, sessionId }: { bubble: Bubble; sessionId: string }) {
  if (bubble.kind === "question") {
    return <QuestionBubble bubble={bubble} sessionId={sessionId} />
  }

  if (bubble.kind === "thinking") {
    return <ThinkingBubble bubble={bubble} />
  }

  if (bubble.kind === "error") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
        <CircleAlert className="size-4 shrink-0 mt-0.5" />
        <pre className="whitespace-pre-wrap font-mono leading-relaxed flex-1 min-w-0">
          {bubble.content}
        </pre>
      </div>
    )
  }

  if (bubble.kind === "tool") {
    const read = bubble.toolName === "read" ? (bubble.toolParsed as ParsedFileRead | undefined) : undefined
    const glob = bubble.toolName === "glob" ? (bubble.toolParsed as ParsedGlob | undefined) : undefined
    const header = formatToolInput(bubble.toolName, bubble.content)
    const primary = read?.path ?? header.primary
    const secondaryPath = header.path
    const primaryIsPath = !!read || bubble.toolName === "read" || bubble.toolName === "write" ||
                          bubble.toolName === "edit" || bubble.toolName === "list"
    const headerMeta =
      read ? `${read.totalLines} lines` :
      glob ? `${glob.paths.length} matches` :
      null

    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] min-w-[50%] rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40">
            <ToolStatusIcon status={bubble.toolStatus} />
            <Wrench className="size-3 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs font-semibold shrink-0">{bubble.toolName}</span>
            {primaryIsPath ? (
              <span
                dir="rtl"
                className="font-mono text-xs text-muted-foreground truncate min-w-0"
                title={primary}
              >
                <bdi>{primary}</bdi>
              </span>
            ) : (
              <span
                className="font-mono text-xs text-muted-foreground shrink-0"
                title={primary}
              >
                {primary}
              </span>
            )}
            {secondaryPath && (
              <span
                dir="rtl"
                className="font-mono text-xs text-muted-foreground/60 truncate min-w-0"
                title={secondaryPath}
              >
                <bdi>{secondaryPath}</bdi>
              </span>
            )}
            {headerMeta && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/60 shrink-0">
                {headerMeta}
              </span>
            )}
          </div>
          {read ? (
            <div className="max-h-64 overflow-y-auto border-t">
              <FileViewer path={read.path} lines={read.lines} />
            </div>
          ) : glob ? (
            <div className="max-h-64 overflow-y-auto border-t">
              <GlobMatches paths={glob.paths} />
            </div>
          ) : bubble.toolOutput ? (
            <pre className="max-h-40 overflow-y-auto px-3 py-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap border-t">
              {bubble.toolOutput}
            </pre>
          ) : null}
        </div>
      </div>
    )
  }

  if (bubble.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-secondary text-secondary-foreground px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {bubble.content}
        </div>
      </div>
    )
  }

  // An empty in-flight bubble renders nothing (no placeholder); the global
  // spinner below the message list is the only loading indicator between
  // submit and session.idle.
  return (
    <div className="flex justify-start">
      <div className="group/msg max-w-[90%] min-w-[50%]">
        <div>
          <Markdown>{bubble.content}</Markdown>
        </div>
        {bubble.done && bubble.content && (
          <div className="mt-1">
            <CopyButton text={bubble.content} />
          </div>
        )}
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore — clipboard may be blocked (e.g. http on a non-localhost host)
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy message"}
      className="inline-flex cursor-pointer items-center justify-center size-6 rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

interface ToolHeader {
  primary: string  // 主参数，显示在 tool 名之后
  path?: string    // 路径类参数，第二行显示
}

function formatToolInput(tool: string | undefined, raw: string): ToolHeader {
  if (!raw) return { primary: "" }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const str = (k: string) => typeof obj[k] === "string" ? (obj[k] as string) : undefined
    switch (tool) {
      case "glob":
      case "grep": {
        const pattern = str("pattern")
        if (pattern) return { primary: pattern, path: str("path") }
        break
      }
      case "read":
      case "write":
      case "edit": {
        const fp = str("filePath") ?? str("path")
        if (fp) return { primary: fp }
        break
      }
      case "list": {
        const p = str("path")
        if (p) return { primary: p }
        break
      }
      case "bash": {
        const cmd = str("command")
        if (cmd) return { primary: cmd }
        break
      }
      case "task": {
        const d = str("description") ?? str("prompt")
        if (d) return { primary: d }
        break
      }
    }
  } catch { /* fall through */ }
  return { primary: raw }
}

function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return ""
  if (paths.length === 1) {
    const i = paths[0].lastIndexOf("/")
    return i >= 0 ? paths[0].slice(0, i + 1) : ""
  }
  let prefix = paths[0]
  for (let i = 1; i < paths.length; i++) {
    while (prefix && !paths[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
    if (!prefix) return ""
  }
  const i = prefix.lastIndexOf("/")
  return i >= 0 ? prefix.slice(0, i + 1) : ""
}

function GlobMatches({ paths }: { paths: string[] }) {
  const prefix = commonDirPrefix(paths)
  return (
    <ul className="font-mono text-xs divide-y divide-border/40">
      {paths.map(p => {
        const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
        const idx = rel.lastIndexOf("/")
        const dir = idx >= 0 ? rel.slice(0, idx + 1) : ""
        const name = idx >= 0 ? rel.slice(idx + 1) : rel
        return (
          <li key={p} className="flex px-3 py-1 hover:bg-muted/30" title={p}>
            {dir && <span className="text-muted-foreground truncate min-w-0">{dir}</span>}
            <span className="text-foreground shrink-0 font-medium">{name}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ToolStatusIcon({ status }: { status?: "pending" | "running" | "completed" }) {
  if (status === "completed") {
    return <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
  }
  if (status === "running") {
    return <Loader2 className="size-3.5 text-amber-500 animate-spin shrink-0" />
  }
  return <Loader2 className="size-3.5 text-muted-foreground shrink-0" />
}

function QuestionBubble({ bubble, sessionId }: { bubble: Bubble; sessionId: string }) {
  const questions = bubble.questions ?? []
  const answered = !!bubble.questionAnswers
  const appendQuestionAnswer = useChatStreamStore(state => state.appendQuestionAnswer)
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []))
  const [submitting, setSubmitting] = useState(false)

  function toggle(qIdx: number, label: string, multi: boolean): void {
    setSelected(prev => {
      const next = prev.map(row => [...row])
      if (multi) {
        const row = next[qIdx]
        const at = row.indexOf(label)
        if (at >= 0) row.splice(at, 1)
        else row.push(label)
      } else {
        next[qIdx] = [label]
      }
      return next
    })
  }

  async function submit(): Promise<void> {
    if (submitting || answered) return
    const ready = questions.every((q, i) => selected[i].length >= (q.multiSelect ? 1 : 1))
    if (!ready) return
    setSubmitting(true)
    try {
      const answers: QuestionAnswer[] = questions.map((q, i) => ({
        question: q.question,
        selectedLabels: selected[i],
      }))
      await answerSession(sessionId, bubble.id, answers)
      appendQuestionAnswer(sessionId, bubble.id, answers)
    } catch (err) {
      console.error("answer submit failed:", err)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] min-w-[50%] rounded-lg border border-primary/40 bg-primary/5 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-primary/5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <CornerDownLeft className="size-3" />
          <span className="font-mono">{answered ? "answered" : "question"}</span>
        </div>
        <div className="px-3 py-2.5 space-y-3">
          {questions.map((q, qIdx) => {
            const userAnswer = bubble.questionAnswers?.[qIdx]
            return (
              <div key={qIdx} className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  {q.header && (
                    <Badge variant="secondary" className="text-[10px] uppercase">{q.header}</Badge>
                  )}
                  <div className="text-sm font-medium">{q.question}</div>
                </div>
                <div className="grid gap-1.5">
                  {q.options.map((opt, oIdx) => {
                    const isPicked = answered
                      ? userAnswer?.selectedLabels.includes(opt.label) ?? false
                      : selected[qIdx]?.includes(opt.label) ?? false
                    return (
                      <button
                        key={oIdx}
                        type="button"
                        disabled={answered || submitting}
                        onClick={() => toggle(qIdx, opt.label, !!q.multiSelect)}
                        className={cn(
                          "text-left rounded border px-2.5 py-1.5 text-xs transition-colors cursor-pointer",
                          isPicked
                            ? "border-primary bg-primary/10"
                            : "border-border hover:bg-muted/40",
                          (answered || submitting) && "cursor-not-allowed opacity-80",
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          {isPicked && <CheckCircle2 className="size-3 text-primary" />}
                          <span className="font-medium">{opt.label}</span>
                        </div>
                        {opt.description && (
                          <div className="mt-0.5 text-[11px] text-muted-foreground">{opt.description}</div>
                        )}
                        {opt.preview && (
                          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[10px] whitespace-pre-wrap">
                            {opt.preview}
                          </pre>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {!answered && (
            <Button
              size="sm"
              onClick={submit}
              disabled={submitting || selected.some(row => row.length === 0)}
              className="w-full"
            >
              {submitting ? <Loader2 className="size-3 animate-spin" /> : "Submit"}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
