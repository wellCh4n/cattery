import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki"

let highlighterPromise: Promise<Highlighter> | null = null
const loadingLangs = new Map<string, Promise<void>>()

export const SHIKI_THEME_LIGHT = "github-light"
export const SHIKI_THEME_DARK = "github-dark"

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME_LIGHT, SHIKI_THEME_DARK],
      langs: [],
    })
  }
  return highlighterPromise
}

export async function ensureLanguage(lang: string): Promise<boolean> {
  const h = await getHighlighter()
  if (h.getLoadedLanguages().includes(lang)) return true

  let p = loadingLangs.get(lang)
  if (!p) {
    p = h.loadLanguage(lang as BundledLanguage).then(() => undefined).catch(() => undefined)
    loadingLangs.set(lang, p)
  }
  await p
  return h.getLoadedLanguages().includes(lang)
}
