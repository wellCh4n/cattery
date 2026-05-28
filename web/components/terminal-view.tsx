"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, AlertTriangle } from "lucide-react"
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

interface Props {
  session: Session
  harness: Harness
}

// TerminalView 把 sandbox tmux PTY 字节流直接渲染到 xterm.js。
// 不解析任何内容、不维护消息列表 —— 这是给 codex/hermes 这种 TUI harness 用的视图。
export function TerminalView({ session }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<{ disposed: boolean; term: Terminal | null }>({ disposed: false, term: null })
  const isDarkRef = useRef(false)
  const [isDark, setIsDark] = useState(false)

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

    if (session.status !== "ready" || !session.harness_session_id) return

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
      // 0, deliberately: this is a tmux PTY bridge with tmux mouse mode on, so
      // wheel scrolling is forwarded to tmux and history lives in tmux copy-mode.
      // xterm's own scrollback would be redundant — and any non-zero value makes
      // FitAddon reserve a 14px scrollbar gutter on the right, leaving a blank
      // margin the terminal never fills. Keeping it 0 lets the grid span the
      // full width.
      scrollback: 0,
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

    // Fit xterm to the host, then report the size so tmux (and the TUI inside)
    // grow to fill the panel instead of staying at the 120x32 the session was
    // created at. A single mount-time fit can land before the flex layout
    // settles or before web fonts swap in, leaving the grid narrower/shorter
    // than its container — the leftover shows as blank margin on the right and
    // bottom. Re-fit on host resize, on the next frame, and once fonts are
    // ready so the terminal always covers the full panel.
    let lastSentSize: { cols: number; rows: number } | null = null
    const sendResize = () => {
      if (ws.readyState !== ws.OPEN) return
      if (lastSentSize?.cols === term.cols && lastSentSize.rows === term.rows) return
      lastSentSize = { cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
    }
    // Fit to the full host, then center the sub-cell leftover. FitAddon floors
    // cols/rows, so the grid is almost never an exact pixel multiple of the host
    // — the remainder (< 1 cell on each axis) would otherwise pile up on the
    // right and bottom edges and look misaligned. Reset host padding to 0 so the
    // fit measures the full area, read the actual grid size off `.xterm-screen`,
    // then pad the host by half the leftover per side so the grid sits centered
    // and the panel reads as "evenly filled" instead of "flush top-left".
    const refit = () => {
      host.style.padding = "0px"
      try { fit.fit() } catch { /* terminal disposed */ }
      const screen = host.querySelector<HTMLElement>(".xterm-screen")
      if (screen) {
        const padX = Math.max(0, (host.clientWidth - screen.offsetWidth) / 2)
        const padY = Math.max(0, (host.clientHeight - screen.offsetHeight) / 2)
        host.style.padding = `${padY}px ${padX}px`
      }
      sendResize()
    }

    refit()
    const rafId = requestAnimationFrame(refit)
    void document.fonts?.ready.then(() => { if (!localState.disposed) refit() })

    // Observe the wrapper (host's parent), not the host itself: refit() writes
    // padding onto the host, and a host-targeted observer would see its own
    // content-box change and loop. The wrapper's size only moves on real layout
    // changes.
    const ro = new ResizeObserver(refit)
    ro.observe(host.parentElement ?? host)

    ws.addEventListener("open", () => {
      if (localState.disposed) {
        ws.close()
        return
      }
      ws.send(JSON.stringify({ type: "theme", theme: isDarkRef.current ? "dark" : "light" }))
      sendResize()

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
      cancelAnimationFrame(rafId)
      ro.disconnect()
      host.removeEventListener("mousedown", interceptRightClick, true)
      try { ws.close() } catch { /* already closed */ }
      term.dispose()
    }
  }, [session.session_id, session.status, session.harness_session_id, isDark])

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
  } else {
    body = (
      <div className="h-full w-full bg-background p-2">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
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
