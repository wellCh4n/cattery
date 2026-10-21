import { parse } from "yaml"

export type Frontmatter =
  | { ok: true; raw: string; data: Record<string, unknown> }
  | { ok: false; raw: string; error: string }

// splitFrontmatter separates a leading YAML frontmatter block (`---` … `---`)
// from a markdown document. `frontmatter` is null when the document has none;
// a block that fails to parse (or isn't a mapping) is reported, not dropped.
export function splitFrontmatter(text: string): { frontmatter: Frontmatter | null; body: string } {
  const lines = text.split("\n")
  if (lines[0]?.trimEnd() !== "---") return { frontmatter: null, body: text }
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end < 0) return { frontmatter: null, body: text }
  const raw = lines.slice(1, end).join("\n")
  const body = lines.slice(end + 1).join("\n")
  try {
    const data: unknown = parse(raw)
    if (data == null) return { frontmatter: { ok: true, raw, data: {} }, body }
    if (typeof data !== "object" || Array.isArray(data)) {
      return { frontmatter: { ok: false, raw, error: "frontmatter is not a key/value mapping" }, body }
    }
    return { frontmatter: { ok: true, raw, data: data as Record<string, unknown> }, body }
  } catch (e) {
    return { frontmatter: { ok: false, raw, error: e instanceof Error ? e.message : String(e) }, body }
  }
}
