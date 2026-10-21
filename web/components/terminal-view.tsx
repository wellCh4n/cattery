"use client"

// TerminalView — one xterm.js view attached over a WebSocket to the terminal's
// tmux session in the project's agent container
// (GET /projects/:id/terminal?terminal=<id>). Binary frames carry terminal
// bytes both ways; resizes go up as {"type":"resize"} text frames. When the
// connection drops, Enter reattaches the same session; after the shell exits,
// Enter starts a new one.

import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef, useState } from "react"
import type { ITheme } from "@xterm/xterm"
import { Loader2 } from "lucide-react"
import { terminalURL } from "@/lib/api"
import { type TerminalStatus, useTerminalStore } from "@/lib/terminal-store"

const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  cursor: "#0a0a0a",
  cursorAccent: "#ffffff",
  selectionBackground: "#0969da33",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
}

const DARK: ITheme = {
  background: "#0a0a0a",
  foreground: "#fafafa",
  cursor: "#fafafa",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#ffffff33",
  brightBlack: "#737373",
}

function currentTheme(): ITheme {
  return document.documentElement.classList.contains("dark") ? DARK : LIGHT
}

export function TerminalView({ terminalId, projectId, visible }: { terminalId: string; projectId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(visible)
  const fitRef = useRef<(() => void) | null>(null)
  const focusRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<TerminalStatus>("connecting")

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const cleanups: (() => void)[] = []
    const report = (status: TerminalStatus) => {
      setState(status)
      useTerminalStore.getState().setStatus(terminalId, status)
    }

    // xterm touches the DOM at import time, so it loads client-side only.
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/addon-clipboard"),
    ]).then(([{ Terminal }, { FitAddon }, { WebLinksAddon }, { ClipboardAddon }]) => {
      if (disposed) return
      const mono = getComputedStyle(document.body).getPropertyValue("--font-geist-mono").trim()
      const term = new Terminal({
        fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, monospace`,
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        // tmux captures the mouse; Option/Alt-drag still selects natively.
        macOptionClickForcesSelection: true,
        theme: currentTheme(),
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      // tmux copies selections out via OSC 52.
      term.loadAddon(new ClipboardAddon())
      term.open(host)

      // A hidden panel measures 0×0; fitting then would collapse the shell.
      const safeFit = () => {
        if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit()
      }
      fitRef.current = safeFit
      focusRef.current = () => term.focus()
      safeFit()
      if (visibleRef.current) term.focus()

      const encoder = new TextEncoder()
      let ws: WebSocket | null = null
      let ended = false

      const sendResize = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
        }
      }
      const send = (data: Uint8Array<ArrayBuffer>) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      }

      const connect = () => {
        ended = false
        report("connecting")
        let opened = false
        const sock = new WebSocket(terminalURL(projectId, terminalId))
        sock.binaryType = "arraybuffer"
        sock.onopen = () => {
          opened = true
          sendResize()
        }
        sock.onmessage = ev => {
          if (!(ev.data instanceof ArrayBuffer)) return
          term.write(new Uint8Array(ev.data))
          report("open")
        }
        sock.onclose = ev => {
          if (disposed || ws !== sock) return
          ended = true
          report("closed")
          const reason = ev.code === 1000
            ? "Shell exited"
            : ev.reason || (opened ? "Connection lost" : "Could not connect")
          term.write(`\r\n\x1b[2m[${reason}. Press Enter to reconnect.]\x1b[0m\r\n`)
        }
        ws = sock
      }

      term.onData(data => {
        if (ended) {
          if (data === "\r") connect()
          return
        }
        send(encoder.encode(data))
      })
      term.onBinary(data => send(Uint8Array.from(data, c => c.charCodeAt(0))))
      term.onResize(sendResize)

      const resizeObserver = new ResizeObserver(safeFit)
      resizeObserver.observe(host)
      const themeObserver = new MutationObserver(() => { term.options.theme = currentTheme() })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

      connect()
      cleanups.push(() => {
        resizeObserver.disconnect()
        themeObserver.disconnect()
        const sock = ws
        ws = null
        sock?.close()
        term.dispose()
        fitRef.current = null
        focusRef.current = null
      })
    })

    return () => {
      disposed = true
      cleanups.forEach(fn => fn())
    }
  }, [terminalId, projectId])

  useEffect(() => {
    visibleRef.current = visible
    if (!visible) return
    fitRef.current?.()
    focusRef.current?.()
  }, [visible])

  return (
    <div className="relative size-full">
      <div ref={hostRef} className="size-full" />
      {state === "connecting" && (
        <div className="pointer-events-none absolute top-0 left-0 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Connecting to sandbox…
        </div>
      )}
    </div>
  )
}
