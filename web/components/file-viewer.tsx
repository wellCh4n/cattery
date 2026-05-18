"use client"

import { useEffect, useState } from "react"
import type { BundledLanguage, ThemedToken } from "shiki"
import { ensureLanguage, getHighlighter, SHIKI_THEME } from "@/lib/highlighter"

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

export function FileViewer({ path, lines }: Props) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const code = lines.map(l => l.text).join("\n")
  const lang = detectLanguage(path)

  useEffect(() => {
    let cancelled = false
    if (lang === "text") {
      setTokens(null)
      return
    }
    ;(async () => {
      const ok = await ensureLanguage(lang)
      if (cancelled || !ok) return
      const h = await getHighlighter()
      if (cancelled) return
      const result = h.codeToTokens(code, { lang: lang as BundledLanguage, theme: SHIKI_THEME })
      if (!cancelled) setTokens(result.tokens)
    })().catch(() => {
      if (!cancelled) setTokens(null)
    })
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
                      <span key={j} style={{ color: t.color }}>{t.content}</span>
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
