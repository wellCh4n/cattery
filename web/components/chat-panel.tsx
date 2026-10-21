"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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
  useMessageScroller,
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
import { QuestionnaireCard } from "@/components/questionnaire-card"
import { Markdown } from "@/components/markdown"
import { EffortPicker, ModelPicker } from "@/components/model-picker"
import { type Session } from "@/lib/api"
import {
  useChatStreamStore,
  type Bubble,
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
  | { kind: "text" | "error" | "questionnaire"; id: string; bubble: Bubble }

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
    if (b.kind === "tool" && b.toolName === "questionnaire") {
      segments.push({ kind: "questionnaire", id: b.id, bubble: b })
    } else if (b.kind === "thinking" || b.kind === "tool") {
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
  return (
    <MessageScrollerProvider key={session.session_id} autoScroll>
      <ChatPanelContent session={session} />
    </MessageScrollerProvider>
  )
}

function ChatPanelContent({ session }: Props) {
  const { scrollToEnd } = useMessageScroller()
  const [submission, setSubmission] = useState(0)

  // Resume following after the submitted message has committed, even if the
  // first reply arrives in the same render and replaces the pending row.
  useLayoutEffect(() => {
    if (submission > 0) scrollToEnd({ behavior: "auto" })
  }, [submission, scrollToEnd])

  const [input, setInput] = useState("")
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusedSessionRef = useRef<string | null>(null)
  const chat = useChatStreamStore(state => state.sessions[session.session_id])
  const bubbles = chat?.bubbles ?? EMPTY_BUBBLES
  const sending = (chat?.sending || chat?.recovering) ?? false
  const ensureSession = useChatStreamStore(state => state.ensureSession)
  const loadHistory = useChatStreamStore(state => state.loadHistory)
  const sendMessage = useChatStreamStore(state => state.sendMessage)
  const stopSession = useChatStreamStore(state => state.stopSession)
  const turns = useMemo(() => toTurns(bubbles), [bubbles])
  const ready = session.status === "ready"
  const canSend = ready && !sending && input.trim().length > 0

  useEffect(() => {
    if (!ready || sending || focusedSessionRef.current === session.session_id) return
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    focusedSessionRef.current = session.session_id
  }, [ready, sending, session.session_id])

  useEffect(() => {
    if (!ready) return
    ensureSession(session.session_id)
    loadHistory(session.session_id).catch(() => { /* ignore */ })
  }, [ensureSession, loadHistory, ready, session.session_id])

  useEffect(() => {
    if (!ready || chat?.sending || !chat?.recovering) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { await loadHistory(session.session_id, true) } catch { /* retry transient failures */ }
      if (!disposed) timer = setTimeout(refresh, 1500)
    }
    timer = setTimeout(refresh, 1500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [ready, chat?.sending, chat?.recovering, loadHistory, session.session_id])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSend) return
    const text = input.trim()
    setInput("")
    setSubmission(value => value + 1)
    void sendMessage(session.session_id, text)
  }

  return (
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
                    <MessageScrollerItem
                      key={turn.id}
                      messageId={turn.id}
                    >
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
                        sessionId={session.session_id}
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
          <InputGroup className="rounded-xl bg-background has-disabled:bg-background has-disabled:opacity-100 dark:has-disabled:bg-input/30">
            <InputGroupTextarea
              ref={inputRef}
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

function AgentTurn({ bubbles, streaming, sessionId }: { bubbles: Bubble[]; streaming: boolean; sessionId: string }) {
  const segments = toSegments(bubbles)
  const reply = segments
    .filter(s => s.kind === "text")
    .map(s => (s.kind === "text" ? s.bubble.content : ""))
    .join("\n\n")

  return (
    <Message>
      <MessageContent className="gap-3">
        {segments.map(segment => {
          if (segment.kind === "questionnaire") return <QuestionnaireCard key={segment.id} bubble={segment.bubble} sessionId={sessionId} />
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
  find:  ["Finding", "Found"],
  ls:    ["Listing", "Listed"],
}

function toolIcon(tool: string | undefined) {
  switch (tool) {
    case "bash":  return <TerminalIcon />
    case "read":  return <FileTextIcon />
    case "write":
    case "edit":  return <FilePenIcon />
    case "grep":
    case "find":  return <SearchIcon />
    case "ls":    return <FolderIcon />
    default:      return <WrenchIcon />
  }
}

// AI Elements Tool / Terminal: one line per call, expandable to its output.
function ToolRow({ bubble }: { bubble: Bubble }) {
  const tool = bubble.toolName?.toLowerCase()
  const running = !bubble.done && bubble.toolStatus !== "completed"
  const header = formatToolInput(tool, bubble.content)
  const [runningVerb, doneVerb] = (tool && TOOL_VERBS[tool]) ?? [bubble.toolName ?? "tool", bubble.toolName ?? "tool"]
  const target = header.primary
  const meta = header.path ? `in ${header.path}` : null

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

  const hasBody = !running && bubble.toolOutput
  if (!hasBody) return line

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="max-w-full">{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap={tool !== "bash"} className="max-h-64 [font-variant-ligatures:none]">
            {bubble.toolOutput}
          </CodeBlockContent>
        </CodeBlock>
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
      case "find":
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
