"use client"

import { useEffect, useState } from "react"
import type { BundledLanguage, ThemedToken } from "shiki"
import { Check, Copy } from "lucide-react"
import { ensureLanguage, getHighlighter, SHIKI_THEME_LIGHT, SHIKI_THEME_DARK } from "@/lib/highlighter"
import { cn } from "@/lib/utils"

interface Props {
  code: string
  lang?: string
  className?: string
}

function tokenStyle(t: ThemedToken): React.CSSProperties {
  if (t.htmlStyle) {
    if (typeof t.htmlStyle === "string") {
      return { cssText: t.htmlStyle } as React.CSSProperties
    }
    return t.htmlStyle as React.CSSProperties
  }
  return { color: t.color }
}

export function CodeBlock({ code, lang, className }: Props) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const [copied, setCopied] = useState(false)
  const displayLang = lang && lang !== "text" && lang !== "plain" ? lang : ""
  // Markdown fenced blocks always carry a trailing newline; without trimming
  // it shiki/`split("\n")` emit an empty final line that looks like a stray cursor row.
  const normalized = code.endsWith("\n") ? code.slice(0, -1) : code

  useEffect(() => {
    if (!displayLang) return
    let cancelled = false
    ;(async () => {
      const ok = await ensureLanguage(displayLang)
      if (cancelled || !ok) return
      const h = await getHighlighter()
      if (cancelled) return
      const result = h.codeToTokens(normalized, {
        lang: displayLang as BundledLanguage,
        themes: { light: SHIKI_THEME_LIGHT, dark: SHIKI_THEME_DARK },
      })
      if (!cancelled) setTokens(result.tokens)
    })().catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [normalized, displayLang])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(normalized)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  const lines = tokens ?? normalized.split("\n").map(text => [{ content: text, color: "" } as ThemedToken])

  return (
    <div className={cn("my-3 overflow-hidden rounded-md border bg-muted/30", className)}>
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {displayLang || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
          title="Copy"
        >
          {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="shiki-dual max-h-96 overflow-auto px-3 py-2.5 text-[12px] leading-relaxed font-mono [font-variant-ligatures:none]">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre">
              {line.length === 0 ? "​" : line.map((t, j) => (
                <span key={j} style={tokenStyle(t)}>{t.content}</span>
              ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}
