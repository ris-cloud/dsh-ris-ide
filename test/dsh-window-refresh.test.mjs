// The plugin is the only writer of dsh-window.json, so it must also keep the
// entries fresh while dsh still knows their session (m08228). Without this the
// daemon page would list only the workspace that happened to call an endpoint
// inside the freshness window.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { __test } from '../lib/index.js'

let home

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-window-refresh-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
})

after(() => {
  delete process.env.DSH_RIS_IDE_PROXY_HOME
  rmSync(home, { recursive: true, force: true })
})

function writeWindows(windows) {
  writeFileSync(join(home, 'dsh-window.json'), `${JSON.stringify({ windows })}\n`, { mode: 0o600 })
}

function readWindows() {
  return JSON.parse(readFileSync(join(home, 'dsh-window.json'), 'utf8')).windows
}

test('a session dsh still knows is refreshed, a gone one is dropped', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-a', sessionId: 's-live', at: old },
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-b', sessionId: 's-gone', at: old },
  ])
  const result = __test.refreshDshWindows({
    sessions: { get: (id) => (id === 's-live' ? { header: { cwd: '/tmp/ws-a' } } : null) },
  })
  // `windows` counts what SURVIVES: the pre-prune number misled callers (E P2-2).
  assert.deepEqual(result, { changed: 1, windows: 1, dropped: 1 })
  const rewritten = readWindows()
  assert.equal(rewritten.length, 1)
  assert.equal(rewritten[0].sessionId, 's-live')
  assert.notEqual(rewritten[0].at, old, 'the live session is refreshed')
})

test('entries whose session dsh dropped are pruned', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-b', sessionId: 's-gone', at: old }])
  const result = __test.refreshDshWindows({ sessions: { get: () => null } })
  assert.deepEqual(result, { changed: 0, windows: 0, dropped: 1 })
  assert.deepEqual(readWindows(), [])
})

test('an entry without a session id is kept (nothing to verify)', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-c', at: old }])
  assert.deepEqual(__test.refreshDshWindows({ sessions: { get: () => null } }), { changed: 0, windows: 1, dropped: 0 })
  assert.equal(readWindows().length, 1)
})

test('a missing window list is a no-op', () => {
  rmSync(join(home, 'dsh-window.json'), { force: true })
  assert.deepEqual(__test.refreshDshWindows({ sessions: { get: () => ({}) } }), { changed: 0, windows: 0, dropped: 0 })
})

test("another dsh instance's rows are left alone", () => {
  // The home is machine-wide: two dsh processes share dsh-window.json, and each may
  // only vouch for sessions IT knows. A row stamped with a foreign ownerPid must
  // survive even though this process cannot resolve its sessionId (review C2-P2-2).
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-other', sessionId: 's-foreign', ownerPid: 999999, at: old },
  ])
  assert.deepEqual(__test.refreshDshWindows({ sessions: { get: () => null } }), { changed: 0, windows: 1, dropped: 0 })
  assert.equal(readWindows()[0].sessionId, 's-foreign')
})

test('a garbage ownerPid makes the row ours, not somebody else\'s', () => {
  // Number('abc') is NaN: the old test treated that as "non-finite, not a foreign
  // owner" and pruned the row as if it were ours-but-unknown. It must at least go
  // through the same ownership check as a legacy row (no ownerPid) — review C3-P2-5.
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-garbage', sessionId: 's-garbage', ownerPid: 'abc', at: old }])
  const result = __test.refreshDshWindows({
    sessions: { get: (id) => (id === 's-garbage' ? { header: { cwd: '/tmp/ws-garbage' } } : null) },
  })
  assert.deepEqual(result, { changed: 1, windows: 1, dropped: 0 }, 'the known session is refreshed')
  assert.notEqual(readWindows()[0].at, old)
})

test('a session that reopened on another workspace drops the stale row', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-moved', sessionId: 's-moved', at: old }])
  const result = __test.refreshDshWindows({ sessions: { get: () => ({ header: { cwd: '/tmp/ws-new' } }) } })
  assert.deepEqual(result, { changed: 0, windows: 0, dropped: 1 })
  assert.deepEqual(readWindows(), [])
})
