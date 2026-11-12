// The plugin is the only writer of dsh-window.json, so it must also keep the
// entries fresh while dsh still knows their session (m08228). Without this the
// daemon page would list only the workspace that happened to call an endpoint
// inside the freshness window.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { __test, handleRequest } from '../lib/index.js'

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

test('a rename re-labels the row and refreshes the sidebar snapshot (m13800)', () => {
  // Renaming a workspace only changes its title; the path stays. The refresh tick is
  // the only thing that runs while nobody is clicking, so it must carry the new label
  // to the daemon page, along with the whole sidebar list.
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-a', sessionId: 's-live', title: 'before', at: old }])
  const ctx = {
    sessions: { get: (id) => (id === 's-live' ? { header: { cwd: '/tmp/ws-a' } } : null) },
    get: (name) => (name === 'workspaceRegistry'
      ? {
        list: () => [
          { path: '/tmp/ws-a', title: 'after', sessionIds: ['s-live'] },
          { path: '/tmp/ws-b', title: 'other', sessionIds: [] },
        ],
      }
      : undefined),
  }
  assert.deepEqual(__test.refreshDshWindows(ctx), { changed: 1, windows: 1, dropped: 0 })
  const doc = JSON.parse(readFileSync(join(home, 'dsh-window.json'), 'utf8'))
  assert.equal(doc.windows[0].title, 'after', 'the row keeps its path and takes the new label')
  assert.equal(doc.windows[0].cwd, '/tmp/ws-a')
  assert.deepEqual(doc.workspaces.map((row) => [row.cwd, row.title]), [
    ['/tmp/ws-a', 'after'],
    ['/tmp/ws-b', 'other'],
  ], 'the snapshot mirrors the sidebar, in its order')
  assert.equal(doc.url, 'http://127.0.0.1:3080', 'the origin that answered is remembered')
  assert.ok(Number.isFinite(Date.parse(doc.at)), 'the document says when it was written')
})

test('a session that reopened on another workspace drops the stale row', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  writeWindows([{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-moved', sessionId: 's-moved', at: old }])
  const result = __test.refreshDshWindows({ sessions: { get: () => ({ header: { cwd: '/tmp/ws-new' } }) } })
  assert.deepEqual(result, { changed: 0, windows: 0, dropped: 1 })
  assert.deepEqual(readWindows(), [])
})

test('a dsh that never opened the IDE panel still publishes its sidebar (m00186)', () => {
  // The reported bug: dsh was running with workspaces, but nobody had opened the IDE
  // panel in that process, so no window row existed — and the tick returned before
  // writing anything. The daemon page then said 「dsh 未运行（没有记住的工作区窗口）」.
  // The registry mirror alone must be enough for the page to offer every workspace.
  rmSync(join(home, 'dsh-window.json'), { force: true })
  const ctx = {
    // liveSessionFor needs list(); the sidebar row keeps that session id, the other
    // row has none (nothing to boot on, the page falls back to the cwd). get() is what
    // marks a row `active` for the page's per-row hint.
    sessions: {
      list: () => [{ id: 's-a', header: { cwd: '/tmp/ws-a' } }],
      get: (id) => (id === 's-a' ? { header: { cwd: '/tmp/ws-a' } } : undefined),
    },
    get: (name) => (name === 'workspaceRegistry'
      ? {
        list: () => [
          { path: '/tmp/ws-a', title: 'alpha', sessionIds: ['s-a'] },
          { path: '/tmp/ws-b', title: 'beta', sessionIds: [] },
        ],
      }
      : undefined),
    // No page has been served yet: the bound address is the only origin available.
    webServer: { getOrigin: () => 'http://127.0.0.1:3080' },
  }
  assert.deepEqual(__test.refreshDshWindows(ctx), { changed: 0, windows: 0, dropped: 0 })
  const doc = JSON.parse(readFileSync(join(home, 'dsh-window.json'), 'utf8'))
  assert.deepEqual(doc.windows, [], 'no window row exists yet')
  assert.deepEqual(doc.workspaces.map((row) => [row.cwd, row.title, row.sessionId]), [
    ['/tmp/ws-a', 'alpha', 's-a'],
    ['/tmp/ws-b', 'beta', ''],
  ], 'the sidebar list, in its order, with the session each workspace is on')
  assert.equal(doc.url, 'http://127.0.0.1:3080', 'the daemon needs an origin to embed the IDE at')
  assert.ok(Number.isFinite(Date.parse(doc.at)), '`at` is the liveness proof the sidebar branch reads')
  assert.deepEqual(doc.workspaces.map((row) => row.active), [true, false],
    'a workspace without a live session is still listed, only not painted as active')
  // The daemon can also probe this process directly when it cannot use the document:
  // one per-pid file says where a LIVE host answers (m00186).
  const instance = JSON.parse(readFileSync(join(home, 'instances', `dsh-${process.pid}.json`), 'utf8'))
  assert.equal(instance.url, 'http://127.0.0.1:3080')
  assert.equal(instance.pid, process.pid)
  assert.ok(Number.isFinite(Date.parse(instance.at)))
})

test('a process with nothing to publish leaves another instance\'s snapshot alone', () => {
  // Same machine-level home, two dsh processes. An older host without a workspace
  // registry must not erase the newer instance's sidebar snapshot: it has nothing to
  // say, so it says nothing (the write only happens when there is something to keep).
  const now = new Date().toISOString()
  writeFileSync(join(home, 'dsh-window.json'), `${JSON.stringify({
    windows: [],
    workspaces: [{ cwd: '/tmp/ws-other', title: 'other', sessionId: 's-other' }],
    url: 'http://127.0.0.1:3080',
    at: now,
  })}\n`)
  assert.deepEqual(__test.refreshDshWindows({ sessions: { get: () => undefined } }), { changed: 0, windows: 0, dropped: 0 })
  const doc = JSON.parse(readFileSync(join(home, 'dsh-window.json'), 'utf8'))
  assert.deepEqual(doc.workspaces.map((row) => row.cwd), ['/tmp/ws-other'], 'the other instance\'s snapshot survives')
  assert.equal(doc.at, now, 'nothing was rewritten')
})

test('the origin a loopback request really used wins over the bound address (m00186)', () => {
  // getOrigin() can report a LAN address while the page was opened on 127.0.0.1; the
  // request's Host is the address that actually worked, so it must be the one written.
  // A cross-site request must not be able to move it (review A-P2-10).
  __test.rememberDshOrigin({ headers: { host: '127.0.0.1:3999' } })
  __test.rememberDshOrigin({ headers: { host: '203.0.113.9:3999' } })
  rmSync(join(home, 'dsh-window.json'), { force: true })
  const ctx = {
    sessions: { list: () => [] },
    get: (name) => (name === 'workspaceRegistry'
      ? { list: () => [{ path: '/tmp/ws-a', title: 'alpha', sessionIds: [] }] }
      : undefined),
    webServer: { getOrigin: () => 'http://192.168.1.20:3080' },
  }
  __test.refreshDshWindows(ctx)
  const doc = JSON.parse(readFileSync(join(home, 'dsh-window.json'), 'utf8'))
  assert.equal(doc.url, 'http://127.0.0.1:3999', 'the loopback origin a browser used wins')
  assert.equal(doc.workspaces.length, 1)
})

/** One loopback GET against a test server; JSON body parsed when it is JSON. */
function getJson(port, path, host) {
  return new Promise((resolveGet) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { parsed = null }
        resolveGet({ status: res.statusCode, body: parsed })
      })
    })
    call.on('error', () => resolveGet({ status: 0, body: null }))
    call.end()
  })
}

test('GET /dsh-ris-ide/workspaces answers from the live host, loopback only (m00186)', async () => {
  // `/v1/dsh` falls back to asking a live dsh directly when dsh-window.json is missing
  // or stale, so the route must answer from the running context (no file involved) and
  // must stay loopback-only like every other plugin route.
  const ctx = {
    sessions: {
      list: () => [{ id: 's-live', header: { cwd: '/tmp/ws-a' } }],
      get: (id) => (id === 's-live' ? { header: { cwd: '/tmp/ws-a' } } : undefined),
    },
    get: (name) => (name === 'workspaceRegistry'
      ? {
        list: () => [
          { path: '/tmp/ws-a', title: 'alpha', sessionIds: ['s-live'] },
          { path: '/tmp/ws-b', title: 'beta', sessionIds: [] },
        ],
      }
      : undefined),
  }
  const server = createServer((incoming, response) => handleRequest(ctx, incoming, response, { maxBytes: 1024, restrictToCwd: false }))
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  try {
    const answer = await getJson(port, '/dsh-ris-ide/workspaces')
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body.workspaces.map((row) => [row.cwd, row.title, row.sessionId, row.active]), [
      ['/tmp/ws-a', 'alpha', 's-live', true],
      ['/tmp/ws-b', 'beta', '', false],
    ])
    assert.equal(answer.body.url, `http://127.0.0.1:${port}`, 'the Host a page used is the origin it can embed')
    const foreign = await getJson(port, '/dsh-ris-ide/workspaces', 'evil.example:80')
    assert.equal(foreign.status, 403, 'a non-loopback Host cannot read the workspace list')
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
})
