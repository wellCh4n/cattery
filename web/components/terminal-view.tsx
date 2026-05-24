"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, AlertTriangle, Bot } from "lucide-react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
// Hermes (and other TUIs) draw their banner with "Symbols for Legacy Computing"
// (U+1FB00–U+1FBFF) — Noto Sans Symbols 2's `symbols` subset has 212/256 of
// these glyphs and is loaded here as a CSS-level fallback.
//
// Braille (U+2800–U+28FF, hermes' caduceus) and Nerd Font icons (U+E000–U+F8FF,
// prompt/status line) are NOT loaded via @fontsource — they're declared as
// @font-face in app/globals.css with explicit `unicode-range`. macOS's
// `ui-monospace` does OS-level font fallback for unknown glyphs and bypasses
// CSS @font-faces that don't pin a range; explicit `unicode-range` is what
// actually forces the browser to use our self-hosted woff2s for those blocks.
import "@fontsource/noto-sans-symbols-2/symbols-400.css"
import { termURL, type Session, type Harness } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

interface Props {
  session: Session
  harness: Harness
}

// TerminalView 把 sandbox tmux PTY 字节流直接渲染到 xterm.js。
// 不解析任何内容、不维护消息列表 —— 这是给 codex/hermes 这种 TUI harness 用的视图。
export function TerminalView({ session, harness }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<{ disposed: boolean; term: Terminal | null }>({ disposed: false, term: null })
  const isDarkRef = useRef(false)
  const [isDark, setIsDark] = useState(false)
  const canWrite = harness.access_role !== "viewer"

  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      const nextIsDark = root.classList.contains("dark")
      isDarkRef.current = nextIsDark
      setIsDark(nextIsDark)
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    if (stateRef.current.term) {
      stateRef.current.term.options.theme = themeFor(isDark)
    }
  }, [isDark])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const localState = stateRef.current
    localState.disposed = false

    if (!canWrite || session.status !== "ready" || !session.harness_session_id) return

    const term = new Terminal({
      // The unicode-range-pinned families ("Cattery Braille Mono",
      // "Symbols Nerd Font Mono") come first so the browser can't dodge them
      // via OS-level fallback for their target ranges. Normal text still uses
      // the OS monospace because those families have nothing in the latin
      // range. Noto Sans Symbols 2 sits at the end as a general fallback for
      // legacy-computing (U+1FB00–U+1FBFF) since no monospace npm font ships
      // that block.
      fontFamily: '"Cattery Braille Mono", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", "Noto Sans Symbols 2", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: true,
      scrollback: 10000,
      allowProposedApi: true,
      // codex 用 truecolor 画输入框背景，主题里改 ANSI black 管不到它；
      // 这里让 xterm 在前景与背景对比度不足时自动调整前景，保证文字可读。
      minimumContrastRatio: 7,
      theme: themeFor(isDarkRef.current),
    })
    localState.term = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    // Without this, right-clicking on a Shift-selected region clears the
    // selection: xterm.js sees the button=2 mousedown and (because tmux mouse
    // mode is on) starts a fresh forwarded mouse event, wiping the highlight
    // before the native context menu's Copy item runs. Stop the mousedown in
    // capture phase only when there's an active selection — left-click and
    // no-selection right-click still pass through to tmux normally.
    const interceptRightClick = (e: MouseEvent) => {
      if (e.button === 2 && term.hasSelection()) e.stopPropagation()
    }
    host.addEventListener("mousedown", interceptRightClick, true)

    const ws = new WebSocket(termURL(session.session_id))
    ws.binaryType = "arraybuffer"

    let cleanupResize = () => {}
    let lastSentSize: { cols: number; rows: number } | null = null

    ws.addEventListener("open", () => {
      if (localState.disposed) {
        ws.close()
        return
      }
      ws.send(JSON.stringify({ type: "theme", theme: isDarkRef.current ? "dark" : "light" }))
      // Tell the bridge our current viewport so tmux can size the PTY.
      const sendResize = () => {
        if (ws.readyState !== ws.OPEN) return
        if (lastSentSize?.cols === term.cols && lastSentSize.rows === term.rows) return
        lastSentSize = { cols: term.cols, rows: term.rows }
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
      localState.term = null
      cleanupResize()
      host.removeEventListener("mousedown", interceptRightClick, true)
      try { ws.close() } catch { /* already closed */ }
      term.dispose()
    }
  }, [canWrite, session.session_id, session.status, session.harness_session_id, isDark])

  const title = session.title ?? "New Session"
  const harnessName = harness.harness_name ?? "Untitled"

  function statusVariant(s: string): "default" | "secondary" | "destructive" {
    if (s === "ready") return "default"
    if (s === "failed") return "destructive"
    return "secondary"
  }

  let body: React.ReactNode
  if (session.status === "failed") {
    body = (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-destructive/10 p-4 mb-4">
          <AlertTriangle className="size-7 text-destructive" />
        </div>
        <p className="text-sm font-medium">Session failed to start</p>
        <p className="text-xs text-muted-foreground mt-1">{session.phase ?? "unknown error"}</p>
      </div>
    )
  } else if (session.status !== "ready") {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p className="text-xs">{session.phase ?? "starting sandbox…"}</p>
      </div>
    )
  } else if (!canWrite) {
    body = (
      <div className="flex h-full flex-col items-center justify-center text-center px-6">
        <div className="rounded-full bg-muted p-4 mb-4">
          <Bot className="size-7 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">Viewer access</p>
        <p className="text-xs text-muted-foreground mt-1">Terminal sessions require editor access.</p>
      </div>
    )
  } else {
    body = (
      <div className="h-full w-full bg-background p-2">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="border-b px-4 h-12 flex items-center gap-3 shrink-0">
        <Bot className="size-4 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium truncate">{title}</span>
          <span className="text-muted-foreground/50 shrink-0">/</span>
          <span className="text-xs text-muted-foreground truncate min-w-0">
            {harnessName}
          </span>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 select-none shrink-0">
          Hold
          <kbd className="font-mono px-1 py-px rounded border border-border bg-muted/50 text-[10px] leading-none">⇧ Shift</kbd>
          to select
        </span>
        <Badge variant={statusVariant(session.status)} className="text-[10px] h-5">
          {session.status}
        </Badge>
      </header>
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  )
}

// xterm 用内联颜色绘制，无法直接消费 CSS 变量；这里根据当前 .dark class 切换调色板，
// background/foreground 与页面主题保持一致，ANSI 颜色仍选用在两种背景下都可读的中性色。
function themeFor(isDark: boolean) {
  if (isDark) {
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
      brightBlack: "#262626",
      brightWhite: "#e5e7eb",
    }
  }
  return {
    background: "#ffffff",
    foreground: "#1f2937",
    cursor:     "#1f2937",
    selectionBackground: "#3b82f640",
    black:   "#1f2937",
    red:     "#dc2626",
    green:   "#16a34a",
    yellow:  "#ca8a04",
    blue:    "#2563eb",
    magenta: "#9333ea",
    cyan:    "#0891b2",
    white:   "#f3f4f6",
    brightBlack: "#eeeeee",
    brightWhite: "#ffffff",
  }
}
