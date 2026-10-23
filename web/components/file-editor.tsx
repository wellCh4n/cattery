"use client"

// Editable source view: a transparent textarea laid over the same text
// highlighted by shiki, beside a line gutter. Both layers share one grid cell
// and font metrics, and size to the content so the pane does the scrolling.

import { useDeferredValue } from "react"
import { tokenStyle, useCodeTokens } from "@/components/file-viewer"

interface Props {
  path: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
}

export function FileEditor({ path, value, onChange, onSave }: Props) {
  // Highlighting trails typing; lines whose tokens are stale show plain text.
  const tokens = useCodeTokens(path, useDeferredValue(value))
  const lines = value.split("\n")

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault()
      onSave()
      return
    }
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      // insertText keeps the browser's undo history, unlike setting value.
      document.execCommand("insertText", false, "\t")
    }
  }

  return (
    <div className="flex min-h-full min-w-full w-max font-mono text-xs leading-4.5 [font-variant-ligatures:none] [tab-size:4]">
      <div
        aria-hidden
        className="sticky left-0 z-10 w-10 shrink-0 select-none border-r border-border/40 bg-background px-2 py-1 text-right text-muted-foreground/50"
      >
        {lines.map((_, i) => (
          <div key={i} className="h-4.5">{i + 1}</div>
        ))}
      </div>
      <div className="grid min-w-0 flex-1">
        <div aria-hidden className="shiki-dual pointer-events-none whitespace-pre px-3 py-1 [grid-area:1/1]">
          {lines.map((text, i) => {
            const lineTokens = tokens?.[i]
            const fresh = lineTokens?.map(t => t.content).join("") === text
            return (
              <div key={i} className="h-4.5">
                {fresh && lineTokens
                  ? lineTokens.map((t, j) => <span key={j} style={tokenStyle(t)}>{t.content}</span>)
                  : text}
              </div>
            )
          })}
        </div>
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={`Edit ${path}`}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="resize-none overflow-hidden whitespace-pre bg-transparent px-3 py-1 text-transparent caret-foreground outline-none selection:bg-primary/25 [grid-area:1/1]"
        />
      </div>
    </div>
  )
}
