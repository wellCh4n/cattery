import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCsv } from "./csv"

test("CSV handles BOM, quoted commas, escaped quotes and multiline cells", () => {
  assert.deepEqual(parseCsv('\uFEFFname,note\r\nAlice,"a,b"\r\nBob,"say ""hi""\nnext line"\r\n'), {
    rows: [["name", "note"], ["Alice", "a,b"], ["Bob", 'say "hi"\nnext line']], limited: false,
  })
})

test("CSV preserves empty cells, blank records, whitespace and uneven row lengths", () => {
  assert.deepEqual(parseCsv('a,b,\n\n x ,y\rz'), {
    rows: [["a", "b", ""], [""], [" x ", "y"], ["z"]], limited: false,
  })
  assert.deepEqual(parseCsv(""), { rows: [], limited: false })
  assert.deepEqual(parseCsv('""'), { rows: [[""]], limited: false })
})

test("CSV rejects broken quoting instead of displaying misleading cells", () => {
  for (const input of ['a,"unfinished', 'a,"closed"junk', 'a,b"c']) assert.ok(parseCsv(input).error)
})

test("CSV bounds large previews at complete records and rejects excessive columns", () => {
  assert.deepEqual(parseCsv('h\n"a\nb"\nlast', 2), { rows: [["h"], ["a\nb"]], limited: true })
  assert.deepEqual(parseCsv('h\na\n', 2), { rows: [["h"], ["a"]], limited: false })
  assert.ok(parseCsv("a,b,c", 10, 2).error)
  assert.ok(parseCsv("a,b,c\n", 10, 2).error)
})
