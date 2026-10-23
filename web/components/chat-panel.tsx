"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  CornerDownRightIcon,
  CircleCheckIcon,
  CopyIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  LoaderCircleIcon,
  MessageCircleDashedIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  Undo2Icon,
  EyeIcon,
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
import { useAuthStore } from "@/lib/auth-store"
import { Markdown } from "@/components/markdown"
import { EffortBadge, EffortPicker, ModelBadge, ModelPicker } from "@/components/model-picker"
import { ContextMeter } from "@/components/context-meter"
import { type Session } from "@/lib/api"
import {
  useChatStreamStore,
  type Bubble,
} from "@/lib/chat-stream-store"
import { canWriteSession, useWorkspaceStore } from "@/lib/workspace-store"

interface Props {
  session: Session
}

const EMPTY_BUBBLES: Bubble[] = []
const EMPTY_QUEUE: string[] = []

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

const isOpenQuestionnaire = (b: Bubble) => b.kind === "tool" && b.toolName === "questionnaire" && !b.done

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
  const chat = useChatStreamStore(state => state.sessions[session.session_id])
  const bubbles = chat?.bubbles ?? EMPTY_BUBBLES
  const usage = chat?.usage ?? null
  const sending = (chat?.sending || chat?.recovering) ?? false
  const ensureSession = useChatStreamStore(state => state.ensureSession)
  const loadHistory = useChatStreamStore(state => state.loadHistory)
  const queue = chat?.queue ?? EMPTY_QUEUE
  const sendMessage = useChatStreamStore(state => state.sendMessage)
  const withdrawQueued = useChatStreamStore(state => state.withdrawQueued)
  const stopSession = useChatStreamStore(state => state.stopSession)
  const follow = useChatStreamStore(state => state.follow)
  const userId = useAuthStore(state => state.user?.user_id)
  const project = useWorkspaceStore(state => state.projects.find(p => p.project_id === session.project_id))
  // Other members follow the session read-only.
  const writable = !!project && canWriteSession(session, project, userId)
  const turns = useMemo(() => toTurns(bubbles), [bubbles])
  // An unanswered questionnaire docks above the composer; it joins the message
  // list once answered. The agent is blocked on it, so a steer could not land.
  const question = useMemo(() => bubbles.find(isOpenQuestionnaire), [bubbles])
  const ready = session.status === "ready"
  // While the agent runs, a message is steered into its turn.
  const canSend = writable && ready && !question && input.trim().length > 0

  const answering = !!question
  useEffect(() => {
    // The composer stays usable while the sandbox starts (only sending waits for
    // it) and while the agent runs (steering); it is only disabled while a
    // questionnaire waits, so refocus once that is answered.
    if (!writable || answering) return
    inputRef.current?.focus({ preventScroll: true })
  }, [writable, sending, answering, session.session_id])

  // Put text back into the composer ahead of whatever is being typed.
  function restoreInput(texts: string[]) {
    if (!texts.length) return
    setInput(current => [...texts, current].filter(t => t.trim()).join("\n\n"))
    inputRef.current?.focus({ preventScroll: true })
  }

  async function withdraw(index: number) {
    const text = await withdrawQueued(session.session_id, index).catch(() => null)
    if (text !== null) restoreInput([text])
  }

  async function stop() {
    restoreInput(await stopSession(session.session_id))
  }

  useEffect(() => {
    if (!ready) return
    ensureSession(session.session_id)
    loadHistory(session.session_id).catch(() => { /* ignore */ })
  }, [ensureSession, loadHistory, ready, session.session_id])

  // Live view of runs this tab did not start. Viewers always follow, since any
  // run is the creator's. The creator follows only a run already going when the
  // session loaded (from another tab); runs this tab starts arrive on their own
  // stream, and holding a follow connection meanwhile would only cost one.
  const following = ready && (!writable || (!!chat?.recovering && !chat.sending))
  useEffect(() => {
    if (!following) return
    return follow(session.session_id)
  }, [following, follow, session.session_id])

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSend) return
    const text = input.trim()
    setInput("")
    setSubmission(value => value + 1)
    sendMessage(session.session_id, text).catch(() => restoreInput([text]))
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
              <MessageScrollerContent aria-busy={sending} className="mx-auto max-w-4xl px-4 py-6 md:px-8">
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
                        readOnly={!writable}
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

      <div className="mx-auto w-full max-w-4xl px-4 pb-4 md:px-8">
        {question && (
          <div className="mb-2 max-h-[50vh] overflow-y-auto rounded-xl">
            <QuestionnaireCard key={question.id} bubble={question} sessionId={session.session_id} readOnly={!writable} />
          </div>
        )}
        {queue.length > 0 && (
          // Steered messages wait here until the model receives them, after the
          // current tool calls finish.
          <div className="mx-3 rounded-t-lg border border-b-0 bg-muted/50 px-3 py-2 text-sm">
            <div className="mb-1 text-xs text-muted-foreground">Sends after the current step</div>
            <ul className="flex flex-col gap-1">
              {queue.map((text, i) => (
                <li key={`${i}-${text}`} className="flex items-start gap-2">
                  <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
                  {writable && <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Edit message"
                          onClick={() => void withdraw(i)}
                        />
                      }
                    >
                      <Undo2Icon />
                    </TooltipTrigger>
                    <TooltipContent>Move back to the input</TooltipContent>
                  </Tooltip>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!writable ? (
          <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <EyeIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Read-only · {session.created_by_username ? `${session.created_by_username}'s session` : "only the project owner can send messages"}
            </span>
            {usage && <ContextMeter usage={usage} />}
            {/* The creator's settings, shown but not changeable. */}
            <ModelBadge model={session.model} />
            <EffortBadge model={session.model} effort={session.effort} />
          </div>
        ) : (
        /* The AI Elements Model Selector input: field, context, model and effort pills, send. */
        <form ref={formRef} onSubmit={handleSubmit}>
          {/* InputGroup fades as a whole when anything inside is disabled — here
              that's the empty-field send button or the field while the agent
              replies, which would grey out the pickers and Stop too. Disabled
              controls already dim themselves, so keep the box as is. */}
          <InputGroup className="rounded-xl bg-background has-disabled:bg-background has-disabled:opacity-100 dark:has-disabled:bg-input/30">
            <InputGroupTextarea
              ref={inputRef}
              value={input}
              disabled={!!question}
              onChange={e => setInput(e.target.value)}
              placeholder={question ? "Answer the questions above first" : sending ? "Steer the agent…" : "Ask the agent to change your code…"}
              aria-label="Message"
              rows={1}
              className="max-h-48 min-h-0 px-4 pt-4 text-base md:text-sm [field-sizing:content]"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  formRef.current?.requestSubmit()
                }
              }}
            />
            <InputGroupAddon align="block-end" className="gap-2 px-3 pb-3">
              {usage && <ContextMeter usage={usage} className="ml-auto" />}
              <ModelPicker
                sessionId={session.session_id}
                model={session.model}
                disabled={sending}
                className={usage ? undefined : "ml-auto"}
              />
              <EffortPicker
                sessionId={session.session_id}
                model={session.model}
                effort={session.effort}
                disabled={sending}
              />
              {sending && !canSend ? (
                <InputGroupButton
                  variant="destructive"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Stop"
                  onClick={() => void stop()}
                >
                  <SquareIcon />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  className="rounded-full"
                  aria-label="Send"
                  disabled={!canSend}
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
        )}
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

function AgentTurn({ bubbles, streaming, sessionId, readOnly }: { bubbles: Bubble[]; streaming: boolean; sessionId: string; readOnly: boolean }) {
  const segments = toSegments(bubbles)
  const reply = segments
    .filter(s => s.kind === "text")
    .map(s => (s.kind === "text" ? s.bubble.content : ""))
    .join("\n\n")

  return (
    <Message>
      <MessageContent className="gap-3">
        {segments.map(segment => {
          if (segment.kind === "questionnaire") {
            // The open card is docked above the composer; mark where the agent asked.
            if (isOpenQuestionnaire(segment.bubble)) {
              return (
                <Trace key={segment.id}>
                  <TraceLine status="running">
                    <TraceIcon><MessageCircleQuestionIcon /></TraceIcon>
                    <TraceTitle>{readOnly ? "Waiting for an answer" : "Waiting for your answer"}</TraceTitle>
                  </TraceLine>
                </Trace>
              )
            }
            return <QuestionnaireCard key={segment.id} bubble={segment.bubble} sessionId={sessionId} readOnly={readOnly} />
          }
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

// Whole seconds since `startedAt`, ticking while `active`.
function useElapsedSeconds(startedAt: number | undefined, active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, startedAt])
  return startedAt === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1000))
}

// AI Elements Reasoning, collapsed by default; the header carries the time spent thinking.
function ReasoningRow({ bubble }: { bubble: Bubble }) {
  const running = !bubble.done
  const elapsed = useElapsedSeconds(bubble.startedAt, running)
  const seconds = running ? elapsed : bubble.durationMs === undefined ? undefined : Math.round(bubble.durationMs / 1000)

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            {running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}
          </TraceIcon>
          <TraceTitle className="tabular-nums">
            {running ? "Thinking" : "Thought"}{seconds !== undefined && ` ${seconds}s`}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown className="text-xs text-muted-foreground [&_*]:text-inherit">
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
