import { test } from "node:test"
import assert from "node:assert/strict"
import { projectTabToRestore, rememberProjectTab, useTabsStore, type Tab } from "./tabs-store"

test("bulk closing tabs preserves other projects, including the same skill", () => {
  const a: Tab = { kind: "skill", id: "review", projectId: "a" }
  const b: Tab = { kind: "skill", id: "review", projectId: "b" }
  const file: Tab = { kind: "file", id: "/README.md", projectId: "a" }
  useTabsStore.setState({ tabs: [a, b, file] })
  useTabsStore.getState().closeOthers(a, [a, file])
  assert.deepEqual(useTabsStore.getState().tabs, [a, b])
  useTabsStore.getState().closeAll([a])
  assert.deepEqual(useTabsStore.getState().tabs, [b])
  useTabsStore.getState().openTab(file)
  useTabsStore.getState().openTab(file)
  assert.deepEqual(useTabsStore.getState().tabs, [b, file])
})

test("project focus is restored independently and closed tabs are not restored", () => {
  const values = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  } })
  try {
    const a: Tab = { kind: "session", id: "a" }
    const other: Tab = { kind: "session", id: "other" }
    const b: Tab = { kind: "file", id: "/README.md", projectId: "b" }
    rememberProjectTab("a", a)
    rememberProjectTab("b", b)
    assert.deepEqual(projectTabToRestore("a", [a, other]), a)
    assert.deepEqual(projectTabToRestore("b", [b]), b)
    assert.deepEqual(projectTabToRestore("a", [other]), other)
    assert.equal(projectTabToRestore("a", []), null)
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
