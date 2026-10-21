import { test } from "node:test"
import assert from "node:assert/strict"
import { splitFrontmatter } from "./frontmatter"

test("frontmatter is parsed out of the markdown body", () => {
  const { frontmatter, body } = splitFrontmatter([
    "---",
    "name: pdf-tools",
    "description: >-",
    "  Extract text from PDFs.",
    "  Use when the user mentions a .pdf.",
    "allowed-tools: Read Bash",
    "metadata:",
    "  author: team",
    "---",
    "# PDF tools",
  ].join("\n"))
  assert.equal(body, "# PDF tools")
  assert.ok(frontmatter?.ok)
  assert.equal(frontmatter.data.name, "pdf-tools")
  assert.equal(frontmatter.data.description, "Extract text from PDFs. Use when the user mentions a .pdf.")
  assert.deepEqual(frontmatter.data.metadata, { author: "team" })
})

test("documents without frontmatter pass through", () => {
  assert.deepEqual(splitFrontmatter("# Title\n---\nx"), { frontmatter: null, body: "# Title\n---\nx" })
  assert.deepEqual(splitFrontmatter("---\nunterminated"), { frontmatter: null, body: "---\nunterminated" })
})

test("invalid frontmatter is reported and the body kept", () => {
  const { frontmatter, body } = splitFrontmatter("---\nname: [oops\n---\nbody")
  assert.equal(body, "body")
  assert.equal(frontmatter?.ok, false)
})
