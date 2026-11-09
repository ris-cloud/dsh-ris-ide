// The plugin's half of the daemon page's IDE tab: it records the browser's origin
// plus the current dsh sessionId into `dsh-window.json`, per workspace, so one
// daemon page can embed the IDE of every workspace someone has open.
//
// Only loopback Hosts are recorded (the daemon page itself is loopback-only too).
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { handleRequest } from '../lib/index.js'

let home
let workspace
let server
let port

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-origin-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'dsh-origin-ws-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.DSH_RIS_IDE_WINDOW_NOTE = '1'
  server = createServer((req, res) => {
    handleRequest({ sessions: { get: () => ({ header: { cwd: workspace } }) } }, req, res, { maxBytes: 1024, restrictToCwd: false })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  delete process.env.DSH_RIS_IDE_PROXY_HOME
  delete process.env.DSH_RIS_IDE_WINDOW_NOTE
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function get(path, host) {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    call.on('error', () => resolve(0))
    call.end()
  })
}

function readWindows() {
  const file = join(home, 'dsh-window.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')).windows
}

test('a loopback request records the dsh origin and session per workspace', async () => {
  const status = await get(`/dsh-ris-ide/windows?sessionId=sess-1&cwd=${encodeURIComponent(workspace)}`)
  assert.equal(status, 200)
  const windows = readWindows()
  assert.ok(Array.isArray(windows), 'dsh-window.json must hold a windows array')
  assert.equal(windows.length, 1)
  assert.equal(windows[0].url, `http://127.0.0.1:${port}`)
  assert.equal(windows[0].sessionId, 'sess-1')
  assert.equal(windows[0].cwd, workspace)
})

test('a probe without a dsh session is not recorded as a workspace', async () => {
  // `/windows?cwd=` probes come from the standalone/maintenance page and carry no
  // session. Inheriting the previous window's id opened the IDE with the wrong
  // session and made the liveness check prune the wrong entry (C2-P1-2).
  const before = readWindows().length
  const status = await get(`/dsh-ris-ide/windows?cwd=${encodeURIComponent(workspace)}`)
  assert.equal(status, 200)
  const after = readWindows()
  assert.equal(after.length, before, 'nothing may be recorded without a sessionId')
  assert.ok(after.every((row) => row.sessionId !== ''), 'every stored row names a real session')
})

test('a non-loopback Host is not recorded', async () => {
  const before = readWindows().length
  const status = await get(`/dsh-ris-ide/windows?sessionId=sess-evil&cwd=${encodeURIComponent(workspace)}`, 'evil.example:80')
  assert.equal(status, 403)
  assert.equal(readWindows().length, before, 'a foreign origin cannot seed the IDE list')
})

test('a second workspace upserts instead of replacing the list', async () => {
  const other = mkdtempSync(join(tmpdir(), 'dsh-origin-ws2-'))
  try {
    const status = await get(`/dsh-ris-ide/windows?sessionId=sess-2&cwd=${encodeURIComponent(other)}`)
    assert.equal(status, 200)
    const windows = readWindows()
    assert.equal(windows.length, 2, 'both workspaces are listed')
    assert.deepEqual(windows.map((row) => row.sessionId).sort(), ['sess-1', 'sess-2'])
    // A brand-new workspace is written immediately. Re-recording one that is already
    // there is throttled to one write per 3 s (review C3-P2-6), so the order of the
    // second call below is not promised — only that nothing duplicates.
    const statusAgain = await get(`/dsh-ris-ide/windows?sessionId=sess-1&cwd=${encodeURIComponent(workspace)}`)
    assert.equal(statusAgain, 200)
    const after = readWindows()
    assert.equal(after.length, 2, 'the same workspace must not duplicate')
    assert.deepEqual(after.map((row) => row.cwd).sort(), [workspace, other].sort())
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('alternating known workspaces does not write on every request', async () => {
  // Two dsh windows take turns hitting the plugin; each request used to rewrite the
  // machine-level file (~one synchronous read+write per request). Now an already
  // recorded workspace inside the 3 s window only moves the in-memory key.
  const rows = readWindows()
  // One request first: either it writes (the window had expired) or it is already
  // inside the window — both leave the throttle armed for the loop below.
  await get(`/dsh-ris-ide/windows?sessionId=${rows[0].sessionId}&cwd=${encodeURIComponent(rows[0].cwd)}`)
  const before = readFileSync(join(home, 'dsh-window.json'), 'utf8')
  for (const row of rows) {
    await get(`/dsh-ris-ide/windows?sessionId=${row.sessionId}&cwd=${encodeURIComponent(row.cwd)}`)
  }
  const after = readFileSync(join(home, 'dsh-window.json'), 'utf8')
  assert.equal(after, before, 'nothing was rewritten inside the throttle window')
})

test('a non-loopback Host header records nothing', async () => {
  const before = readWindows()
  // The route itself may refuse a non-loopback Host (403); recording must not happen either way.
  const status = await get('/dsh-ris-ide/windows?sessionId=sess-evil', 'evil.example.com')
  assert.ok(status === 200 || status === 403, `unexpected status ${status}`)
  const after = readWindows()
  assert.equal(JSON.stringify(after), JSON.stringify(before))
})

test('a request without a workspace does not replace another workspace entry', async () => {
  // Review C-P1-5: the empty-cwd entry used `existing[0].cwd` as its key, so a
  // bare /dsh-ris-ide/proxy call overwrote somebody else's window entry.
  const before = readWindows()
  const status = await get('/dsh-ris-ide/proxy?sessionId=sess-3')
  assert.equal(status, 200)
  const after = readWindows()
  assert.deepEqual(after.map((row) => row.cwd), before.map((row) => row.cwd), 'the list is unchanged')
})
