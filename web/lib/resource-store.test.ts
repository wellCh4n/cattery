import { test } from "node:test"
import assert from "node:assert/strict"
import { createResourceStore } from "./resource-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("readers share a request and invalidation during fetch discards stale results", async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let calls = 0
  const store = createResourceStore(() => ++calls === 1 ? first.promise : second.promise)
  const a = store.getState().load("project-a")
  const b = store.getState().load("project-a")
  assert.equal(a, b)
  await Promise.resolve()
  const invalidated = store.getState().invalidate("project-a")
  first.resolve("stale")
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.getState().entries["project-a"].data, undefined)
  second.resolve("fresh")
  assert.equal(await invalidated, "fresh")
  assert.equal(calls, 2)
  assert.equal(await store.getState().load("project-a"), "fresh")
  assert.equal(calls, 2)
})

test("failure retains successful data and different resource keys stay isolated", async () => {
  let fail = false
  const store = createResourceStore(async key => {
    if (fail) throw new Error("offline")
    return key
  })
  await Promise.all([store.getState().load("a"), store.getState().load("b")])
  fail = true
  await store.getState().invalidate("a")
  assert.equal(store.getState().entries.a.data, "a")
  assert.equal(store.getState().entries.a.error, "offline")
  assert.equal(store.getState().entries.b.error, null)
})

test("logout reset and removed resources cannot be resurrected by pending responses", async () => {
  const pending = deferred<string>()
  const store = createResourceStore(() => pending.promise)
  const request = store.getState().load("a")
  await Promise.resolve()
  store.getState().reset()
  pending.resolve("private")
  await request
  assert.deepEqual(store.getState().entries, {})
  const another = store.getState().load("a")
  store.getState().drop("a")
  await another
  assert.deepEqual(store.getState().entries, {})
})
