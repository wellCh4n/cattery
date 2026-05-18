"use client"

import { useEffect, useRef } from "react"
import { Loader2, AlertTriangle } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { termURL, type Session, type Agent } from "@/lib/api"

interface Props {
  session: Session
  agent: Agent
}

// TerminalView 把 sandbox tmux PTY 字节流直接渲染到 xterm.js。
// 不解析任何内容、不维护消息列表 —— 这是给 codex/hermes 这种 TUI harness 用的视图。
export function TerminalView({ session }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<{ disposed: boolean }>({ disposed: false })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const localState = stateRef.current
    localState.disposed = false

    if (session.status !== "ready" || !session.harness_session_id) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeFor(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const ws = new WebSocket(termURL(session.session_id))
    ws.binaryType = "arraybuffer"

    let cleanupResize = () => {}

    ws.addEventListener("open", () => {
      if (localState.disposed) {
        ws.close()
        return
      }
      // Tell the bridge our current viewport so tmux can size the PTY.
      const sendResize = () => {
        if (ws.readyState !== ws.OPEN) return
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
      }
      sendResize()

      const ro = new ResizeObserver(() => {
        try { fit.fit() } catch { /* terminal disposed */ }
        sendResize()
      })
      ro.observe(host)
      cleanupResize = () => ro.disconnect()

      // Forward keystrokes as binary bytes.
      term.onData((data) => {
        if (ws.readyState === ws.OPEN) ws.send(new TextEncoder().encode(data))
      })
    })

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        term.write(ev.data)
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer))
      }
    })

    ws.addEventListener("close", () => {
      if (!localState.disposed) {
        term.write("\r\n\x1b[31m[disconnected]\x1b[0m\r\n")
      }
    })

    ws.addEventListener("error", () => {
      if (!localState.disposed) {
        term.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n")
      }
    })

    return () => {
      localState.disposed = true
      cleanupResize()
      try { ws.close() } catch { /* already closed */ }
      term.dispose()
    }
  }, [session.session_id, session.status, session.harness_session_id])

  if (session.status === "failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-destructive/10 p-4 mb-4">
          <AlertTriangle className="size-7 text-destructive" />
        </div>
        <p className="text-sm font-medium">Session failed to start</p>
        <p className="text-xs text-muted-foreground mt-1">{session.phase ?? "unknown error"}</p>
      </div>
    )
  }

  if (session.status !== "ready") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p className="text-xs">{session.phase ?? "starting sandbox…"}</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full bg-[#0b0d12] p-2">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}

// xterm uses inline colors; we hand it a minimal palette that reads well on
// both light and dark page chromes (the panel itself is always dark to make
// ANSI colors look right).
function themeFor() {
  return {
    background: "#0b0d12",
    foreground: "#e5e7eb",
    cursor:     "#e5e7eb",
    selectionBackground: "#3b82f680",
    black:   "#1f2937",
    red:     "#f87171",
    green:   "#34d399",
    yellow:  "#fbbf24",
    blue:    "#60a5fa",
    magenta: "#c084fc",
    cyan:    "#22d3ee",
    white:   "#e5e7eb",
  }
}
