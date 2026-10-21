import { test } from "node:test"
import assert from "node:assert/strict"
import { validateSkillManifest } from "./skill-manifest"

test("a spec-conforming manifest has no issues", () => {
  assert.deepEqual(validateSkillManifest({
    name: "pdf-processing",
    description: "Extract PDF text. Use when handling PDFs.",
    license: "Apache-2.0",
    compatibility: "Requires Python 3.14+ and uv",
    "allowed-tools": "Bash(git:*) Read",
    "disable-model-invocation": true,
    metadata: { author: "example-org", version: "1.0" },
  }, "pdf-processing"), [])
})

test("spec constraints are reported", () => {
  const issues = validateSkillManifest({
    name: "-PDF--tools",
    compatibility: "x".repeat(501),
    "disable-model-invocation": "yes",
    metadata: { version: 1 },
  }, "pdf-tools")
  assert.deepEqual(issues, [
    "name may only contain lowercase a-z, 0-9 and hyphens",
    "name must not start or end with a hyphen",
    "name must not contain consecutive hyphens",
    'name should match the skill folder "pdf-tools"',
    "description is required",
    "compatibility exceeds 500 characters (501)",
    "disable-model-invocation must be true or false",
    "metadata values should be strings (version)",
  ])
})
