"use client"

// The main pane with no tab open. A project offers both of its starting
// points: a session with the agent (typing a message starts one with it), or
// a terminal in the sandbox.

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpIcon, FolderOpen, Loader2, MessagesSquare, SquareTerminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { setFirstPrompt } from "@/lib/chat-stream-store"
import { useTerminalStore } from "@/lib/terminal-store"
import { useWorkspaceStore } from "@/lib/workspace-store"

export default function EmptyPage() {
  const router = useRouter()
  const projectId = useWorkspaceStore(state =>
    state.projects.some(p => p.project_id === state.currentProjectId) ? state.currentProjectId : null)
  const [creating, setCreating] = useState<"session" | "terminal" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const formRef = useRef<HTMLFormElement>(null)

  // A typed message starts a session; the chat sends it once the session is up.
  async function create(kind: "session" | "terminal", prompt = "") {
    if (!projectId || creating) return
    setCreating(kind)
    setError(null)
    try {
      if (kind === "session") {
        const session = await useWorkspaceStore.getState().createSession(projectId)
        if (prompt) setFirstPrompt(session.session_id, prompt)
        router.push(`/sessions/${session.session_id}`)
      } else {
        const terminal = await useTerminalStore.getState().createTerminal(projectId)
        router.push(`/terminals/${projectId}/${terminal.terminal_id}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to create ${kind}`)
    } finally {
      setCreating(null)
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-muted p-4 mb-4">
          <FolderOpen className="size-7 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No project selected</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Create or pick a project from the top of the sidebar to start working.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6">
      <div className="rounded-full bg-muted p-4 mb-4">
        <MessagesSquare className="size-7 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">Nothing open</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-sm">
        Ask the agent below to start a session, or open a terminal in the project&apos;s sandbox.
        You can also pick one from the sidebar.
      </p>
      <form
        ref={formRef}
        className="mt-5 w-full max-w-xl text-left"
        onSubmit={e => {
          e.preventDefault()
          const text = input.trim()
          if (text) void create("session", text)
        }}
      >
        <InputGroup className="rounded-xl bg-background has-disabled:bg-background has-disabled:opacity-100 dark:has-disabled:bg-input/30">
          <InputGroupTextarea
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={!!creating}
            placeholder="Ask the agent to change your code…"
            aria-label="Message for a new session"
            rows={1}
            autoFocus
            className="max-h-48 min-h-0 px-4 pt-4 text-base md:text-sm [field-sizing:content]"
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-2 px-3 pb-3">
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="ml-auto rounded-full"
              aria-label="Start session"
              disabled={!input.trim() || !!creating}
            >
              {creating === "session" ? <Loader2 className="animate-spin" /> : <ArrowUpIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void create("session")} disabled={!!creating}>
          {creating === "session" ? <Loader2 className="animate-spin" /> : <MessagesSquare />}
          New session
        </Button>
        <Button size="sm" variant="outline" onClick={() => void create("terminal")} disabled={!!creating}>
          {creating === "terminal" ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
          New terminal
        </Button>
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </div>
  )
}
