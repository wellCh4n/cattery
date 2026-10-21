export type CsvResult = { rows: string[][]; limited: boolean; error?: never } | { error: string; rows?: never; limited?: never }

// Bound the preview's memory and DOM size; Source still shows the original text.
export function parseCsv(content: string, maxRows = 1001, maxColumns = 100): CsvResult {
  const source = content.replace(/^\uFEFF/, "")
  if (!source) return { rows: [], limited: false }
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let closedQuote = false
  let endedRow = false

  function pushField() {
    row.push(field)
    field = ""
    closedQuote = false
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    endedRow = false
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++ }
        else { quoted = false; closedQuote = true }
      } else field += char
      continue
    }
    if (char === "," || char === "\n" || char === "\r") {
      pushField()
      if (row.length > maxColumns) return { error: `CSV preview supports up to ${maxColumns} columns. Showing source below.` }
      if (char !== ",") {
        rows.push(row)
        row = []
        if (char === "\r" && source[i + 1] === "\n") i++
        endedRow = true
        if (rows.length >= maxRows) return { rows, limited: i + 1 < source.length }
      }
    } else if (char === '"' && !field && !closedQuote) {
      quoted = true
    } else if (closedQuote || char === '"') {
      return { error: `Invalid CSV near record ${rows.length + 1}. Showing source below.` }
    } else field += char
  }
  if (quoted) return { error: "CSV contains an unclosed quoted field. Showing source below." }
  if (!endedRow) {
    pushField()
    if (row.length > maxColumns) return { error: `CSV preview supports up to ${maxColumns} columns. Showing source below.` }
    rows.push(row)
  }
  return { rows, limited: false }
}
