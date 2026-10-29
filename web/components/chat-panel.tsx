"use client"

import { profileName } from "@/lib/profile"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CornerDownRightIcon,
  CircleCheckIcon,
  CopyIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  GaugeIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MessageCircleDashedIcon,
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
import { Markdown, SandboxLinkProject } from "@/components/markdown"
import { EffortBadge, EffortPicker, ModelBadge, ModelPicker } from "@/components/model-picker"
import { ContextMeter } from "@/components/context-meter"
import { type Channel, type Session, updateChannel } from "@/lib/api"
import { applyChannel, platformName } from "@/lib/channels-store"
import { writeLastEffort, writeLastModel } from "@/lib/models"
import {
  takeFirstPrompt,
  useChatStreamStore,
  type Bubble,
} from "@/lib/chat-stream-store"
import { canWriteSession, useWorkspaceStore } from "@/lib/workspace-store"
import { useForkSession } from "@/lib/use-fork-session"
import { formatTokens } from "@/lib/usage"
import { cn } from "@/lib/utils"

interface Props {
  session: Session
  // Set when this is a chat channel's conversation (session then stands in
  // for it: its id is the channel id, its creator the channel's).
  channel?: Channel
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
    if (b.kind === "usage") continue
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

export function ChatPanel({ session, channel }: Props) {
  return (
    <MessageScrollerProvider key={session.session_id} autoScroll>
      {/* The agent's localhost links open its sandbox's port previews. */}
      <SandboxLinkProject value={session.project_id}>
        <ChatPanelContent session={session} channel={channel} />
      </SandboxLinkProject>
    </MessageScrollerProvider>
  )
}

function ChatPanelContent({ session, channel }: Props) {
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
  const { fork, forking } = useForkSession()
  // The agent is blocked on an unanswered questionnaire, so a steer could not
  // land; the composer waits until it is answered in the transcript.
  const question = useMemo(() => bubbles.find(isOpenQuestionnaire), [bubbles])
  const ready = session.status === "ready"
  // While the agent runs, a message is steered into its turn.
  const canSend = writable && ready && !question && input.trim().length > 0

  // Shell-style recall of this session's sent messages. ArrowUp on the first
  // line of an empty or recalled field steps back, ArrowDown on its last line
  // steps forward and past the newest clears it. Editing keeps the text.
  const sent = useMemo(() => bubbles.filter(b => b.role === "user" && b.kind === "text").map(b => b.content), [bubbles])
  // Index into sent of the message shown in the field, while recalling.
  const [recall, setRecall] = useState<number | null>(null)

  function recallKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return false
    const el = e.currentTarget
    if (el.selectionStart !== el.selectionEnd) return false
    const at = recall !== null && recall < sent.length ? recall : null
    if (at === null && input !== "") return false
    let next: number
    if (e.key === "ArrowUp") {
      if (input.slice(0, el.selectionStart).includes("\n")) return false
      next = (at ?? sent.length) - 1
      if (next < 0) return false
    } else if (e.key === "ArrowDown") {
      if (at === null || input.slice(el.selectionEnd).includes("\n")) return false
      next = at + 1
    } else {
      return false
    }
    setRecall(next < sent.length ? next : null)
    setInput(next < sent.length ? sent[next] : "")
    return true
  }

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

  // A message typed on the empty main pane goes out once the session is up.
  const started = session.status !== "creating"
  useEffect(() => {
    if (!started || !writable) return
    const text = takeFirstPrompt(session.session_id)
    if (!text) return
    const restore = () => setInput(current => [text, current].filter(t => t.trim()).join("\n\n"))
    if (ready) sendMessage(session.session_id, text).catch(restore)
    else restore()
  }, [started, ready, writable, sendMessage, session.session_id])

  // Live view of runs this tab did not start. Viewers always follow, since any
  // run is the creator's. The creator follows only a run already going when the
  // session loaded (from another tab); runs this tab starts arrive on their own
  // stream, and holding a follow connection meanwhile would only cost one.
  // A channel's runs mostly start in its chat, so its tab always follows.
  const following = ready && (!writable || !!channel || (!!chat?.recovering && !chat.sending))
  useEffect(() => {
    if (!following) return
    return follow(session.session_id)
  }, [following, follow, session.session_id])

  // A channel keeps its model and effort on the channel; like a session's
  // switch, the pick is what the next new conversation starts on.
  async function setChannel(change: { model?: string; effort?: string }) {
    if (!channel) return
    const updated = await updateChannel(channel.channel_id, change)
    if (change.model) writeLastModel(updated.model)
    if (change.effort) writeLastEffort(updated.effort)
    applyChannel(updated)
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSend) return
    const text = input.trim()
    setInput("")
    setRecall(null)
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
              <EmptyTitle>{channel ? "No messages yet" : "What should we build?"}</EmptyTitle>
              <EmptyDescription>
                {channel
                  ? `Messages sent to this ${platformName(channel.type)} channel, and the agent's replies, show up here.`
                  : "The agent can read the project's files, run commands and make changes."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={sending} className="mx-auto max-w-3xl px-4 py-6 md:px-8">
                {/* Keyed by position: the history reload after a reply renames
                    the turns to their saved ids, and remounted items lay out at
                    their content-visibility placeholder size for a frame. In a
                    short transcript that clamps the scroll to the top, which the
                    scroller takes for a user scroll and stops following. */}
                {turns.map((turn, i) =>
                  turn.role === "user" ? (
                    <MessageScrollerItem
                      key={i}
                      messageId={turn.id}
                    >
                      <Message align="end">
                        <MessageContent>
                          <BubbleUI align="end" variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">{turn.bubbles[0].content}</BubbleContent>
                          </BubbleUI>
                          {/* Like a reply's actions, on hover and keeping their space. */}
                          <MessageFooter className="px-0 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
                            {turn.bubbles[0].at && <MessageTime at={turn.bubbles[0].at} className="mr-1.5" />}
                            <CopyAction text={turn.bubbles[0].content} />
                          </MessageFooter>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={i} messageId={turn.id}>
                      <AgentTurn
                        sessionId={session.session_id}
                        readOnly={!writable}
                        bubbles={turn.bubbles}
                        streaming={sending && i === turns.length - 1}
                        latest={i === turns.length - 1}
                        // The fork keeps this reply and drops the messages after it.
                        // Not while running (later turns may not be saved yet), nor
                        // before a sent message still under its local id.
                        onFork={sending || forking || turns[i + 1]?.id.startsWith("user-")
                          ? undefined
                          : () => void fork(session.session_id, turns[i + 1]?.id)}
                      />
                    </MessageScrollerItem>
                  ),
                )}
                {sending && turns.at(-1)?.role === "user" && (
                  // Between submit and the first event of the reply.
                  <MessageScrollerItem messageId="pending">
                    <WorkingRow />
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4 md:px-8">
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
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <EyeIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 basis-48 truncate">
              Read-only, {session.created_by_username ? `${profileName({ name: session.created_by_name, username: session.created_by_username })}'s ${channel ? "channel" : "session"}` : "only the project owner can send messages"}
            </span>
            {usage && <ContextMeter usage={usage} />}
            {/* The creator's settings, shown but not changeable. */}
            <ModelBadge model={session.model} />
            <EffortBadge model={session.model} effort={session.effort} />
            {ready && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={sending || forking}
                      onClick={() => void fork(session.session_id)}
                    />
                  }
                >
                  <GitForkIcon />
                  Fork
                </TooltipTrigger>
                <TooltipContent>Continue in your own copy of this {channel ? "conversation" : "session"}</TooltipContent>
              </Tooltip>
            )}
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
              onChange={e => { setInput(e.target.value); setRecall(null) }}
              placeholder={question ? "Answer the questions above first" : sending ? "Steer the agent…" : channel ? "Message the agent here; replies to it stay in Cattery…" : "Ask the agent to change your code…"}
              aria-label="Message"
              rows={1}
              className="max-h-48 min-h-0 px-4 pt-4 text-base md:text-sm [field-sizing:content]"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  formRef.current?.requestSubmit()
                } else if (recallKey(e)) {
                  e.preventDefault()
                }
              }}
            />
            <InputGroupAddon align="block-end" className="items-end gap-2 px-3 pb-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                <div className="flex min-w-0 max-w-full items-center gap-2">
                  {usage && <ContextMeter usage={usage} />}
                  <ModelPicker
                    sessionId={session.session_id}
                    model={session.model}
                    disabled={sending}
                    onChange={channel && setChannel}
                  />
                </div>
                <EffortPicker
                  sessionId={session.session_id}
                  model={session.model}
                  effort={session.effort}
                  disabled={sending}
                  onChange={channel && setChannel}
                />
              </div>
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

// The empty reply a send adds until the first event arrives, or a bubble never drawn.
const isPlaceholder = (b: Bubble) => (b.kind === "text" && b.content === "") || b.kind === "usage"

// Shown between sending and the reply's first output.
function WorkingRow() {
  return (
    <Trace>
      <TraceLine status="running">
        <TraceIcon><LoaderCircleIcon className="animate-spin" /></TraceIcon>
        <TraceTitle>Working</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

function AgentTurn({ bubbles, streaming, latest, sessionId, readOnly, onFork }: {
  bubbles: Bubble[]
  streaming: boolean
  latest: boolean
  sessionId: string
  readOnly: boolean
  onFork?: () => void
}) {
  const segments = toSegments(bubbles)
  const reply = segments
    .filter(s => s.kind === "text")
    .map(s => (s.kind === "text" ? s.bubble.content : ""))
    .join("\n\n")
  const at = bubbles.reduce<number | undefined>((t, b) => b.at && (!t || b.at > t) ? b.at : t, undefined)
  const usage = usageStats(bubbles)

  return (
    <Message>
      <MessageContent className="gap-3">
        {segments.map(segment => {
          if (segment.kind === "questionnaire") {
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
        {streaming && bubbles.every(isPlaceholder) && <WorkingRow />}
        {(streaming ? usage.output > 0 : reply || onFork || at || usage.output > 0) && (
          // Only the latest reply shows its actions; earlier ones on hover. They
          // keep their space, so revealing them doesn't shift the transcript.
          // While streaming, only the output and speed climb.
          <MessageFooter className={cn("min-h-7 px-0", !latest && "opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100")}>
            {!streaming && reply && <CopyAction text={reply} />}
            {!streaming && onFork && <ForkAction onFork={onFork} />}
            {!streaming && at && <MessageTime at={at} className="ml-1.5" />}
            {usage.output > 0 && <UsageStats {...usage} streaming={streaming} className={cn(!streaming && at && "ml-3")} />}
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

  // At the end of the transcript the scroller follows the bottom as content
  // grows, so opening a thought there would push its title up. A wheel event
  // stops the follow, as a user scroll does, and the thought opens downward.
  // Repeat it while the panel grows: the scroller resumes following whenever
  // it still sits at the end, as it does in the first frames of the animation.
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = contentRef.current
    if (!open || !el) return
    const releaseFollow = () => el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
    releaseFollow()
    const observer = new ResizeObserver(releaseFollow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open])

  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
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
      <TraceCollapsibleContent ref={contentRef}>
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
        {meta && <span className="ml-1.5 text-xs text-muted-foreground">{meta}</span>}
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

// A reply's tokens summed over its model requests. Speed is output over the
// time the requests took, start to end, so tool runs don't slow it down.
function usageStats(bubbles: Bubble[]) {
  let input = 0, cacheRead = 0, output = 0, ms = 0
  for (const b of bubbles) {
    if (b.kind !== "usage" || !b.usage) continue
    input += b.usage.input ?? 0
    cacheRead += b.usage.cacheRead ?? 0
    output += b.usage.output
    ms += b.usage.durationMs
  }
  // Too short a request (one chunk) gives no meaningful rate.
  const perSecond = ms >= 500 ? output / (ms / 1000) : undefined
  return { input, cacheRead, output, ms, perSecond }
}

// ↑ input (without cached tokens, as pi counts it) once the reply is done,
// ↓ output and its speed climbing while it streams.
function UsageStats({ input, cacheRead, output, ms, perSecond, streaming, className }: ReturnType<typeof usageStats> & {
  streaming: boolean
  className?: string
}) {
  const speed = perSecond === undefined ? undefined : `${perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond)} tok/s`
  const showInput = !streaming && input > 0
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex items-center gap-3 font-normal tabular-nums", className)} />}
      >
        {showInput && <Stat icon={<ArrowUpIcon />}>{formatTokens(input)}</Stat>}
        <Stat icon={<ArrowDownIcon />}>{formatTokens(output)}</Stat>
        {speed && <Stat icon={<GaugeIcon />}>{speed}</Stat>}
      </TooltipTrigger>
      <TooltipContent>
        {/* Output is estimated until each model request ends and reports its counts. */}
        <p>
          {showInput && `${input.toLocaleString()} input${cacheRead ? ` + ${cacheRead.toLocaleString()} cached` : ""}, `}
          {streaming ? "about " : ""}{output.toLocaleString()} output tokens in {(ms / 1000).toFixed(1)}s
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

function Stat({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 [&_svg]:size-3 [&_svg]:opacity-70">
      {icon}
      {children}
    </span>
  )
}

// Today's replies show the time alone; older ones add the date.
function MessageTime({ at, className }: { at: number; className?: string }) {
  return (
    <time className={cn("font-normal tabular-nums", className)} dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {formatMessageTime(at)}
    </time>
  )
}

function formatMessageTime(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
}

function ForkAction({ onFork }: { onFork: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Fork from here" onClick={onFork} />}>
        <GitForkIcon />
      </TooltipTrigger>
      <TooltipContent>
        <p>Fork from here</p>
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
