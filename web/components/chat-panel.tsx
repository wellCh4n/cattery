"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  LoaderCircleIcon,
  MessageCircleDashedIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import { Bubble as BubbleUI, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { Markdown } from "@/components/markdown"
import { FileViewer } from "@/components/file-viewer"
import { EffortPicker, ModelPicker } from "@/components/model-picker"
import { type Session } from "@/lib/api"
import {
  useChatStreamStore,
  type Bubble,
  type ParsedFileRead,
  type ParsedGlob,
} from "@/lib/chat-stream-store"

interface Props {
  session: Session
}

const EMPTY_BUBBLES: Bubble[] = []

// A turn is one person's message, or everything the agent did in reply to it
// (thinking, tool calls and text, in stream order).
interface Turn {
  id: string
  role: "user" | "assistant"
  bubbles: Bubble[]
}

// Within an agent turn, consecutive thinking/tool bubbles form one Trace; text
// and errors render on their own.
type Segment =
  | { kind: "steps"; id: string; bubbles: Bubble[] }
  | { kind: "text" | "error"; id: string; bubble: Bubble }

function toTurns(bubbles: Bubble[]): Turn[] {
  const turns: Turn[] = []
  for (const b of bubbles) {
    const last = turns.at(-1)
    if (b.role === "user" || !last || last.role === "user") {
      turns.push({ id: b.id, role: b.role, bubbles: [b] })
    } else {
      last.bubbles.push(b)
    }
  }
  return turns
}

function toSegments(bubbles: Bubble[]): Segment[] {
  const segments: Segment[] = []
  for (const b of bubbles) {
    if (b.kind === "thinking" || b.kind === "tool") {
      const last = segments.at(-1)
      if (last?.kind === "steps") last.bubbles.push(b)
      else segments.push({ kind: "steps", id: b.id, bubbles: [b] })
    } else if (b.kind === "error") {
      segments.push({ kind: "error", id: b.id, bubble: b })
    } else if (b.content) {
      segments.push({ kind: "text", id: b.id, bubble: b })
    }
  }
  return segments
}

export function ChatPanel({ session }: Props) {
  const [input, setInput] = useState("")
  const formRef = useRef<HTMLFormElement>(null)
  const chat = useChatStreamStore(state => state.sessions[session.session_id])
  const bubbles = chat?.bubbles ?? EMPTY_BUBBLES
  const sending = chat?.sending ?? false
  const ensureSession = useChatStreamStore(state => state.ensureSession)
  const loadHistory = useChatStreamStore(state => state.loadHistory)
  const sendMessage = useChatStreamStore(state => state.sendMessage)
  const stopSession = useChatStreamStore(state => state.stopSession)
  const turns = useMemo(() => toTurns(bubbles), [bubbles])
  const ready = session.status === "ready"
  const canSend = ready && !sending && input.trim().length > 0

  useEffect(() => {
    if (!ready) return
    ensureSession(session.session_id)
    loadHistory(session.session_id).catch(() => { /* ignore */ })
  }, [ensureSession, loadHistory, ready, session.session_id])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSend) return
    const text = input.trim()
    setInput("")
    void sendMessage(session.session_id, text)
  }

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          {session.status === "creating" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LoaderCircleIcon className="animate-spin" />
                </EmptyMedia>
                <EmptyTitle>Starting sandbox</EmptyTitle>
                <EmptyDescription>{phaseLabel(session.phase)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : session.status === "failed" ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="text-destructive">
                  <TriangleAlertIcon />
                </EmptyMedia>
                <EmptyTitle>Session failed to start</EmptyTitle>
                <EmptyDescription>{phaseLabel(session.phase)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : turns.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashedIcon />
                </EmptyMedia>
                <EmptyTitle>What should we build?</EmptyTitle>
                <EmptyDescription>
                  The agent can read the project&apos;s files, run commands and make changes.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={sending} className="mx-auto max-w-3xl px-4 py-6 md:px-8">
                  {turns.map((turn, i) =>
                    turn.role === "user" ? (
                      <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            <BubbleUI align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">{turn.bubbles[0].content}</BubbleContent>
                            </BubbleUI>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={turn.id} messageId={turn.id}>
                        <AgentTurn
                          bubbles={turn.bubbles}
                          streaming={sending && i === turns.length - 1}
                        />
                      </MessageScrollerItem>
                    ),
                  )}
                  {sending && turns.at(-1)?.role === "user" && (
                    // Between submit and the first event of the reply.
                    <MessageScrollerItem messageId="pending">
                      <Trace>
                        <TraceLine status="running">
                          <TraceIcon><LoaderCircleIcon className="animate-spin" /></TraceIcon>
                          <TraceTitle>Working</TraceTitle>
                        </TraceLine>
                      </Trace>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          )}
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4 md:px-8">
          {/* The AI Elements Model Selector input: field, model and effort pills, send. */}
          <form ref={formRef} onSubmit={handleSubmit}>
            {/* InputGroup fades as a whole when anything inside is disabled — here
                that's the empty-field send button or the field while the agent
                replies, which would grey out the pickers and Stop too. Disabled
                controls already dim themselves, so keep the box as is. */}
            <InputGroup className="rounded-3xl bg-background has-disabled:bg-background has-disabled:opacity-100 dark:has-disabled:bg-input/30">
              <InputGroupTextarea
                value={input}
                disabled={!ready || sending}
                onChange={e => setInput(e.target.value)}
                placeholder={ready ? "Ask the agent to change your code…" : "Waiting for the sandbox…"}
                aria-label="Message"
                className="max-h-48 min-h-16 px-4 pt-4 text-base md:text-sm [field-sizing:content]"
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    formRef.current?.requestSubmit()
                  }
                }}
              />
              <InputGroupAddon align="block-end" className="gap-2 px-3 pb-3">
                <ModelPicker
                  sessionId={session.session_id}
                  model={session.model}
                  disabled={sending}
                  className="ml-auto"
                />
                <EffortPicker
                  sessionId={session.session_id}
                  model={session.model}
                  effort={session.effort}
                  disabled={sending}
                />
                {sending ? (
                  <InputGroupButton
                    variant="destructive"
                    size="icon-sm"
                    aria-label="Stop"
                    className="rounded-full"
                    onClick={() => void stopSession(session.session_id)}
                  >
                    <SquareIcon />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="icon-sm"
                    aria-label="Send"
                    className="rounded-full"
                    disabled={!canSend}
                  >
                    <ArrowUpIcon />
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </MessageScrollerProvider>
  )
}

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case "handshake":       return "Connecting to agent"
    case "handshake_error": return "Failed to connect to agent"
    case "sandbox_error":   return "Sandbox failed to start"
    default:                return phase ?? ""
  }
}

function AgentTurn({ bubbles, streaming }: { bubbles: Bubble[]; streaming: boolean }) {
  const segments = toSegments(bubbles)
  const reply = segments
    .filter(s => s.kind === "text")
    .map(s => (s.kind === "text" ? s.bubble.content : ""))
    .join("\n\n")

  return (
    <Message>
      <MessageContent className="gap-3">
        {segments.map(segment => {
          if (segment.kind === "steps") {
            return (
              <Trace key={segment.id}>
                {segment.bubbles.map(b =>
                  b.kind === "thinking"
                    ? <ReasoningRow key={b.id} bubble={b} />
                    : <ToolRow key={b.id} bubble={b} />,
                )}
              </Trace>
            )
          }
          if (segment.kind === "error") {
            return (
              <CodeBlock key={segment.id} variant="destructive" size="sm">
                <CodeBlockContent wrap>{segment.bubble.content}</CodeBlockContent>
              </CodeBlock>
            )
          }
          return <Markdown key={segment.id}>{segment.bubble.content}</Markdown>
        })}
        {!streaming && reply && (
          <MessageFooter className="px-0">
            <CopyAction text={reply} />
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}

// AI Elements Reasoning: open while the thought streams, collapsed after.
function ReasoningRow({ bubble }: { bubble: Bubble }) {
  const running = !bubble.done
  const [open, setOpen] = useState<boolean>()

  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            {running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}
          </TraceIcon>
          <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown className="text-xs italic text-muted-foreground [&_*]:text-inherit">
          {bubble.content}
        </Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

const TOOL_VERBS: Record<string, [running: string, done: string]> = {
  bash:  ["Running", "Ran"],
  read:  ["Reading", "Read"],
  write: ["Writing", "Wrote"],
  edit:  ["Editing", "Edited"],
  grep:  ["Searching", "Searched"],
  glob:  ["Finding", "Found"],
  ls:    ["Listing", "Listed"],
}

function toolIcon(tool: string | undefined) {
  switch (tool) {
    case "bash":  return <TerminalIcon />
    case "read":  return <FileTextIcon />
    case "write":
    case "edit":  return <FilePenIcon />
    case "grep":
    case "glob":  return <SearchIcon />
    case "ls":    return <FolderIcon />
    default:      return <WrenchIcon />
  }
}

// AI Elements Tool / Terminal: one line per call, expandable to its output.
function ToolRow({ bubble }: { bubble: Bubble }) {
  const tool = bubble.toolName?.toLowerCase()
  const running = bubble.toolStatus !== "completed"
  const header = formatToolInput(tool, bubble.content)
  const read = tool === "read" ? (bubble.toolParsed as ParsedFileRead | undefined) : undefined
  const glob = tool === "glob" ? (bubble.toolParsed as ParsedGlob | undefined) : undefined
  const [runningVerb, doneVerb] = (tool && TOOL_VERBS[tool]) ?? [bubble.toolName ?? "tool", bubble.toolName ?? "tool"]
  const target = read?.path ?? header.primary
  const meta =
    read ? `${read.totalLines} lines` :
    glob ? `${glob.paths.length} matches` :
    header.path ? `in ${header.path}` :
    null

  const line = (
    <TraceLine status={running ? "running" : undefined} className="min-w-0">
      <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : toolIcon(tool)}</TraceIcon>
      <TraceTitle className="min-w-0 truncate">
        {running ? runningVerb : doneVerb}{" "}
        <code className="font-mono text-xs [font-variant-ligatures:none]" title={target}>{target}</code>
        {meta && <span className="ml-1.5 text-xs text-muted-foreground/60">{meta}</span>}
      </TraceTitle>
    </TraceLine>
  )

  const hasBody = !running && (read || glob || bubble.toolOutput)
  if (!hasBody) return line

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="max-w-full">{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        {read ? (
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            <FileViewer path={read.path} lines={read.lines} />
          </div>
        ) : glob ? (
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            <GlobMatches paths={glob.paths} />
          </div>
        ) : (
          <CodeBlock size="sm">
            <CodeBlockContent wrap={tool !== "bash"} className="max-h-64 [font-variant-ligatures:none]">
              {bubble.toolOutput}
            </CodeBlockContent>
          </CodeBlock>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? "Copied" : "Copy"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setCopied(true)
              } catch {
                // ignore — clipboard may be blocked (e.g. http on a non-localhost host)
              }
            }}
          />
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>
        <p>{copied ? "Copied" : "Copy"}</p>
      </TooltipContent>
    </Tooltip>
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
        const p = str("path")
        if (p) return { primary: p }
        break
      }
      case "ls":
        return { primary: str("path") ?? "." }
      case "bash": {
        const cmd = str("command")
        if (cmd) return { primary: cmd }
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

