import { test } from "node:test"
import assert from "node:assert/strict"
import { parseJsonl } from "./jsonl"

test("JSONL handles BOM, CRLF, nested data, blank lines and original line numbers", () => {
  assert.deepEqual(parseJsonl('\uFEFF{"id":1,"nested":{"items":[true,null]}}\r\n\r\n  \r\n{"text":"one\\ntwo"}'), {
    entries: [
      { line: 1, value: { id: 1, nested: { items: [true, null] } } },
      { line: 4, value: { text: "one\ntwo" } },
    ], limited: false,
  })
})

test("JSONL accepts all JSON value types, including falsy values and a final line without newline", () => {
  const values = [null, false, 0, "", "text", [1, 2], {}]
  assert.deepEqual(parseJsonl(values.map(value => JSON.stringify(value)).join("\n")), {
    entries: values.map((value, index) => ({ line: index + 1, value })), limited: false,
  })
  assert.deepEqual(parseJsonl("\uFEFF\n \t\r\n"), { entries: [], limited: false })
  assert.deepEqual(parseJsonl(""), { entries: [], limited: false })
})

test("JSONL keeps valid records around malformed lines and preserves their source", () => {
  const result = parseJsonl('{"id":1}\n{broken}\n{"a":1}{"b":2}\n{"id":2}\n')
  assert.deepEqual(result.entries[0], { line: 1, value: { id: 1 } })
  assert.deepEqual(result.entries[1], { line: 2, error: "Invalid JSON.", source: "{broken}" })
  assert.equal(result.entries[2].line, 3)
  assert.ok(result.entries[2].error)
  assert.deepEqual(result.entries[3], { line: 4, value: { id: 2 } })
})

test("JSONL truncation omits incomplete final lines even when they look like valid JSON", () => {
  for (const tail of ['{"id":', '123', 'false', '"text"', '{}']) {
    assert.deepEqual(parseJsonl(`{"id":1}\n${tail}`, { truncated: true }), {
      entries: [{ line: 1, value: { id: 1 } }], limited: false,
    })
  }
  assert.deepEqual(parseJsonl('123', { truncated: true }), { entries: [], limited: false })
  assert.deepEqual(parseJsonl('123\n', { truncated: true }), { entries: [{ line: 1, value: 123 }], limited: false })
})

test("JSONL bounds records including errors without counting blank lines as extra records", () => {
  assert.deepEqual(parseJsonl('1\n\ninvalid\n2', { maxRecords: 2 }), {
    entries: [{ line: 1, value: 1 }, { line: 3, error: "Invalid JSON.", source: "invalid" }], limited: true,
  })
  assert.equal(parseJsonl('1\n2\n \n', { maxRecords: 2 }).limited, false)
  const large = parseJsonl(Array.from({ length: 1005 }, (_, index) => String(index)).join("\n"))
  assert.equal(large.entries.length, 1000)
  assert.equal(large.limited, true)
})
