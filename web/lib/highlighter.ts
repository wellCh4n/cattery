import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki"

let highlighterPromise: Promise<Highlighter> | null = null
const loadingLangs = new Map<string, Promise<void>>()

const THEME = "github-light"

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
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

export { THEME as SHIKI_THEME }
