import { test } from "node:test"
import assert from "node:assert/strict"
import { NewPortDetector } from "./new-ports"

const apps = (...ports: number[]) => ports.map(port => ({ port }))
const ports = (list: { port: number }[]) => list.map(app => app.port)

test("ports running when the project opens are not new", () => {
  const d = new NewPortDetector()
  assert.deepEqual(ports(d.next(apps(3000, 5173), 0)), [])
  assert.deepEqual(ports(d.next(apps(3000, 5173), 3_000)), [])
})

test("a port that appears is reported once", () => {
  const d = new NewPortDetector()
  d.next(apps(3000), 0)
  assert.deepEqual(ports(d.next(apps(3000, 8000), 3_000)), [8000])
  assert.deepEqual(ports(d.next(apps(3000, 8000), 6_000)), [])
})

test("a quick restart is not new, a later start is", () => {
  const d = new NewPortDetector()
  d.next(apps(), 0)
  d.next(apps(5173), 3_000)
  d.next(apps(), 6_000)
  assert.deepEqual(ports(d.next(apps(5173), 9_000)), [])
  d.next(apps(), 12_000)
  assert.deepEqual(ports(d.next(apps(5173), 60_000)), [5173])
})

test("lists sent only on change still tell a restart from a new start", () => {
  const d = new NewPortDetector()
  d.next(apps(), 0)
  assert.deepEqual(ports(d.next(apps(5173), 1_000)), [5173])
  // Nothing changes for a long while, then the dev server restarts.
  d.next(apps(), 100_000)
  assert.deepEqual(ports(d.next(apps(5173), 103_000)), [])
})
