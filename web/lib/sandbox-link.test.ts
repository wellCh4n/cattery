import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSandboxLink, previewHref } from "./sandbox-link"

test("sandbox links are local URLs outside the platform's ports", () => {
  assert.deepEqual(parseSandboxLink("http://localhost:5173/"), { port: 5173, path: "/" })
  assert.deepEqual(parseSandboxLink("http://127.0.0.1:8000/docs?q=1#top"), { port: 8000, path: "/docs?q=1#top" })
  assert.deepEqual(parseSandboxLink("http://localhost/"), { port: 80, path: "/" })
  assert.equal(parseSandboxLink("https://example.com:5173/"), null)
  assert.equal(parseSandboxLink("http://localhost:1114/session"), null)
  assert.equal(parseSandboxLink("mailto:a@b.c"), null)
  assert.equal(parseSandboxLink(undefined), null)
})

test("preview hrefs carry the path as a query", () => {
  assert.equal(previewHref("p1", { port: 5173, path: "/" }), "/ports/p1/5173")
  assert.equal(previewHref("p1", { port: 5173, path: "/a?b=1" }), "/ports/p1/5173?path=%2Fa%3Fb%3D1")
})
