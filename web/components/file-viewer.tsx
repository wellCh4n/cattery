"use client"

import { useEffect, useState } from "react"
import type { BundledLanguage, ThemedToken } from "shiki"
import { ensureLanguage, getHighlighter, SHIKI_THEME_LIGHT, SHIKI_THEME_DARK } from "@/lib/highlighter"

interface FileLine {
  n: number
  text: string
}

interface Props {
  path: string
  lines: FileLine[]
}

const extLang: Record<string, string> = {
  ts: "typescript", tsx: "tsx",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  xml: "xml", svg: "xml",
  css: "css", scss: "scss", sass: "sass",
  sql: "sql",
  conf: "nginx", nginx: "nginx",
  dockerfile: "docker",
  graphql: "graphql", gql: "graphql",
  proto: "proto",
  lua: "lua",
  vue: "vue",
  scala: "scala",
}

function detectLanguage(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? ""
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "docker"
  if (base === "makefile" || base.endsWith(".mk")) return "makefile"
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base
  return extLang[ext] ?? "text"
}

// Shiki dual-theme: token has htmlStyle CSS vars (--shiki-light / --shiki-dark)
function tokenStyle(t: ThemedToken): React.CSSProperties {
  if (t.htmlStyle) {
    if (typeof t.htmlStyle === "string") {
      return { cssText: t.htmlStyle } as React.CSSProperties
    }
    return t.htmlStyle as React.CSSProperties
  }
  return { color: t.color }
}

export function FileViewer({ path, lines }: Props) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const code = lines.map(l => l.text).join("\n")
  const lang = detectLanguage(path)

  useEffect(() => {
    if (lang === "text") return
    let cancelled = false
    ;(async () => {
      const ok = await ensureLanguage(lang)
      if (cancelled || !ok) return
      const h = await getHighlighter()
      if (cancelled) return
      const result = h.codeToTokens(code, {
        lang: lang as BundledLanguage,
        themes: { light: SHIKI_THEME_LIGHT, dark: SHIKI_THEME_DARK },
      })
      if (!cancelled) setTokens(result.tokens)
    })().catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [code, lang])

  return (
    <table className="w-full border-collapse text-xs font-mono [font-variant-ligatures:none]">
      <tbody>
        {lines.map((line, i) => {
          const lineTokens = tokens?.[i]
          return (
            <tr key={line.n} className="hover:bg-muted/30">
              <td className="select-none w-10 px-2 py-px text-right text-muted-foreground/50 border-r border-border/40 align-top">
                {line.n}
              </td>
              <td className="px-3 py-px whitespace-pre">
                {lineTokens
                  ? lineTokens.map((t, j) => (
                      <span key={j} style={tokenStyle(t)}>{t.content}</span>
                    ))
                  : line.text}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
