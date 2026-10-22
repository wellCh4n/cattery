export type JsonlEntry =
  | { line: number; value: unknown; error?: never; source?: never }
  | { line: number; error: string; source: string; value?: never }

export interface JsonlResult {
  entries: JsonlEntry[]
  limited: boolean
}

// Parse each line independently so one malformed record doesn't hide the rest.
export function parseJsonl(content: string, { truncated = false, maxRecords = 1000 } = {}): JsonlResult {
  const source = content.replace(/^\uFEFF/, "")
  const entries: JsonlEntry[] = []
  let offset = 0
  let line = 0

  while (offset < source.length) {
    const newline = source.indexOf("\n", offset)
    // Even valid JSON at the cutoff might be a prefix, for example 12 of 123.
    if (newline === -1 && truncated) break
    const text = source.slice(offset, newline === -1 ? source.length : newline)
    offset = newline === -1 ? source.length : newline + 1
    line++
    if (!text.trim()) continue
    if (entries.length === maxRecords) return { entries, limited: true }
    try {
      entries.push({ line, value: JSON.parse(text) as unknown })
    } catch {
      entries.push({ line, error: "Invalid JSON.", source: text })
    }
  }

  return { entries, limited: false }
}
