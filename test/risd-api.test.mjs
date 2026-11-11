/**
 * risd API: authentication, apiVersion, read-only view, leases, shutdown.
 *
 * The daemon under test runs with `DSH_RIS_IDE_PROXY_HOME` pointed at its own
 * temp home, so the machine's real `proxy.json` / janitor state is never read.
 * That is also why the fixture writes a `proxy.json` by hand: the view must be
 * derived from the machine table, and a test that consulted `~/.dsh-ris-ide`
 * would not be a test at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { RISD_API_VERSION, risdStatePath } from '../lib/risd/state.js'
import { bundleLayout } from '../lib/proxybridge-bundle.js'
import { readProxyConfig } from '../lib/proxy.js'
import { risdConfigRevision } from '../lib/risd/view.js'
import { configRevision } from '../lib/index.js'
import { makeHome, removeHome, startRisdProcess } from './risd-helpers.mjs'

const API_HEADER = 'x-risd-api-version'

const FIXTURE = {
  socks: { host: 'proxy.example.com', port: 10080 },
  listenPort: 11081,
  rules: [
    { id: 'r1', program: 'git', hosts: 'git.example.com', ports: '*', enabled: true, shadow: false, source: 'user', workspace: '/tmp/ws' },
  ],
  shadows: [],
}

function call(state, path, { method = 'GET', body = undefined, token = state.token, apiVersion = RISD_API_VERSION } = {}) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (apiVersion !== null) headers[API_HEADER] = String(apiVersion)
  if (body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${state.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

/** A ustar entry for the in-test bundle fixture. */
function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'ascii')
  header.write('0000000 \0', 108, 8, 'ascii')
  header.write('0000000 \0', 116, 8, 'ascii')
  header.write(`${data.length.toString(8).padStart(11, '0')} \0`, 124, 12, 'ascii')
  header.write('00000000000 \0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar \0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')} \0 `, 148, 8, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** A valid .tgz carrying exactly the eight files the installer requires. */
function bundleTgz() {
  const parts = bundleLayout().map((name) => tarEntry(name, Buffer.from(`${name}\n`)))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** POST raw bytes to the upload route (the JSON body helper cannot carry a tgz). */
async function upload(state, bytes) {
  return fetch(`${state.url}/v1/proxybridge/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      [API_HEADER]: String(RISD_API_VERSION),
      'content-type': 'application/gzip',
    },
    body: bytes,
  })
}

async function startFixture(t) {
  const home = makeHome('risd-api-')
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
    removeHome(home)
  })
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify(FIXTURE, null, 2)}\n`, { mode: 0o600 })
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(() => daemon.stop())
  return { home, daemon, state: daemon.state }
}

test('health is unauthenticated and reports the api version', async (t) => {
  const { state } = await startFixture(t)
  const response = await call(state, '/v1/health', { token: null, apiVersion: null })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.apiVersion, RISD_API_VERSION)
  assert.equal(body.pid, state.pid)
  assert.equal(body.port, state.port)
  assert.equal(body.leases.count, 0)
})

test('health names the daemon code this process runs and the code on disk (m09693)', async (t) => {
  const { state } = await startFixture(t)
  const body = await (await call(state, '/v1/health', { token: null, apiVersion: null })).json()
  assert.equal(typeof body.uiBuild, 'object')
  assert.match(body.uiBuild.loaded, /^[0-9a-f]{12}$/)
  assert.match(body.uiBuild.disk, /^[0-9a-f]{12}$/)
  // Nothing was edited between spawn and this request: the page must not think a
  // restart is pending, or it would nag on every fresh daemon.
  assert.equal(body.uiBuild.loaded, body.uiBuild.disk)
})

test('every other endpoint needs the token and the api header', async (t) => {
  const { state } = await startFixture(t)

  const noToken = await call(state, '/v1/status?cwd=/tmp/ws', { token: null })
  assert.equal(noToken.status, 401)
  assert.equal((await noToken.json()).code, 'unauthorized')

  const wrongToken = await call(state, '/v1/status?cwd=/tmp/ws', { token: 'nope' })
  assert.equal(wrongToken.status, 401)

  const noVersion = await call(state, '/v1/status?cwd=/tmp/ws', { apiVersion: null })
  assert.equal(noVersion.status, 409)
  assert.equal((await noVersion.json()).code, 'api-mismatch')

  const oldVersion = await call(state, '/v1/status?cwd=/tmp/ws', { apiVersion: 0 })
  assert.equal(oldVersion.status, 409)

  const ok = await call(state, '/v1/status?cwd=/tmp/ws')
  assert.equal(ok.status, 200)
})

test('the read-only view matches the plugin revision and needs an absolute cwd', async (t) => {
  const { home, state } = await startFixture(t)

  const missing = await call(state, '/v1/status')
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).code, 'bad-request')

  const relative = await call(state, '/v1/proxy?cwd=relative/path')
  assert.equal(relative.status, 400)

  const response = await call(state, '/v1/proxy?cwd=/tmp/ws')
  assert.equal(response.status, 200)
  const view = await response.json()
  assert.equal(view.ok, true)
  assert.equal(view.shared, true)
  assert.equal(view.workspace, '/tmp/ws')
  assert.equal(view.configPath, join(home, 'proxy.json'))
  assert.equal(view.socks.host, 'proxy.example.com')
  assert.equal(view.listenPort, 11081)
  assert.equal(typeof view.revision, 'string')
  assert.ok(Array.isArray(view.rules), 'the daemon ships raw rules for the maintenance page editor')
  assert.deepEqual(view.rules.map((rule) => rule.id), readProxyConfig().rules.map((rule) => rule.id))
  assert.equal(typeof view.redirector, 'object')
  assert.equal(typeof view.janitor, 'object')
  assert.equal(view.daemon.pid, state.pid)

  const config = readProxyConfig()
  assert.equal(risdConfigRevision(config), configRevision(config), 'daemon revision must equal the plugin revision')
  assert.equal(view.revision, configRevision(config))
})

test('the payload is the whole table: rows it leaves out are retired (m10585)', async (t) => {
  // The rule table is machine-wide and no longer partitioned by workspace or source:
  // what the caller sends IS the table. A row nobody sent disappears, which is what
  // lets `yds stop` clear its rows by omission and the panel overwrite an edit.
  const { home, state } = await startFixture(t)
  const ws = mkdtempSync(join(tmpdir(), 'risd-replace-ws-'))
  const other = mkdtempSync(join(tmpdir(), 'risd-replace-other-'))
  t.after(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  })
  const stored = readProxyConfig()
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify(Object.assign({}, stored, {
    rules: [
      { id: 'r1', program: 'git', hosts: 'git.example.com', ports: '*', enabled: true, source: 'user', workspace: ws },
      { id: 'yds-java', program: 'java', hosts: '10.0.0.*', ports: '*', enabled: true, source: 'yds', workspace: ws },
      { id: 'yds-other', program: 'java', hosts: '10.1.0.*', ports: '*', enabled: true, source: 'yds', workspace: other },
    ],
  }), null, 2)}\n`, { mode: 0o600 })
  const view = await (await call(state, `/v1/proxy?cwd=${encodeURIComponent(ws)}`)).json()
  const userRule = view.rules.find((rule) => rule.id === 'r1')
  // A row the stored table never had proves the upsert direction too (it used to
  // live in a separate test, risd-api:'a sent row is upserted…').
  const newRow = { id: 'kept-1', program: 'java', hosts: '10.0.0.*', ports: '*', enabled: true, source: 'yds' }
  const saved = await call(state, '/v1/proxy', {
    method: 'POST',
    body: {
      cwd: ws,
      config: { socks: view.socks, listenPort: view.listenPort, rules: [userRule, newRow] },
      revision: view.revision,
    },
  })
  assert.equal(saved.status, 200)
  const after = await (await call(state, `/v1/proxy?cwd=${encodeURIComponent(ws)}`)).json()
  assert.deepEqual(after.rules.map((rule) => rule.id).sort(), ['kept-1', 'r1'],
    'the sent row is inserted, and only the rows in the payload survive')
})

test('the ping route probes the configured SOCKS upstream and honours overrides', async (t) => {
  // The proxy tab polls this every 10 s; it must answer with the SOCKS5 handshake
  // outcome (not just "port open") and accept an edited-but-unsaved host/port.
  const { createServer } = await import('node:net')
  const socks = createServer((socket) => socket.once('data', () => socket.write(Buffer.from([0x05, 0x00]))))
  await new Promise((resolve) => socks.listen(0, '127.0.0.1', resolve))
  t.after(() => socks.close())
  const { state } = await startFixture(t)

  const port = socks.address().port
  const response = await call(state, `/v1/proxy/ping?host=127.0.0.1&port=${port}`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.socks, true)
  assert.equal(body.port, port)

  // Without overrides it probes the fixture's (unreachable) host and reports why.
  const stored = await call(state, '/v1/proxy/ping')
  assert.equal(stored.status, 200)
  const storedBody = await stored.json()
  assert.equal(storedBody.ok, false)
  assert.equal(typeof storedBody.error, 'string')
})

test('the ProxyBridge bundle card reports status and rejects a bad upload', async (t) => {
  const { state } = await startFixture(t)

  const status = await call(state, '/v1/proxybridge')
  assert.equal(status.status, 200)
  const body = await status.json()
  assert.equal(body.ok, true)
  assert.equal(body.installed, false)
  assert.equal(typeof body.dir, 'string')
  assert.equal(typeof body.url, 'string')
  assert.ok(Array.isArray(body.urls) && body.urls.length >= 2, 'both mirrors are offered')
  assert.ok(body.urls[0].includes('gitee.com'), 'gitee is tried first')
  assert.ok(body.urls[1].includes('github.com'), 'github is the fallback')
  // The digest the next install must match, and whether what is on disk does
  // (review B-P0-1). Nothing is installed here, so there is no "actual" yet.
  assert.match(body.sha256, /^[0-9a-f]{64}$/, 'the pinned release digest is advertised')
  assert.equal(body.actualSha256, null)
  assert.equal(body.verified, false)

  // Health (m11828/m11838): with the engine stopped the route answers the state
  // without probing binaries — a red "component broken" would be noise.
  const health = await call(state, '/v1/proxybridge/health')
  assert.equal(health.status, 200)
  const healthBody = await health.json()
  assert.equal(healthBody.engineRunning, false)
  assert.equal(healthBody.checked, false)
  assert.equal(healthBody.ok, null)
  assert.deepEqual(healthBody.stray, { linux: false, windows: false })
  assert.deepEqual(healthBody.interception, { linux: false, windows: false })
  // m12359: the card must be able to show the exact sudo command for the Linux side
  // even when no start was attempted in this process.
  assert.equal(typeof healthBody.commands, 'object')
  assert.match(healthBody.commands.linux, /^sudo .*ProxyBridge --profile .*--verbose 2$/)
  // m12486/m12567: the degraded plan covers JVM args, env vars and git.
  assert.ok(Array.isArray(healthBody.degrade.jvmArgs))
  assert.match(healthBody.degrade.jvmArgs.join(' '), /-Dhttps\.proxyHost=127\.0\.0\.1/)
  assert.equal(healthBody.degrade.httpProxyUrl, `http://127.0.0.1:${healthBody.degrade.jvmArgs.find((a) => a.startsWith('-Dhttp.proxyPort=')).split('=')[1]}`)
  assert.equal(typeof healthBody.degrade.note, 'string')
  // A forced probe while stopped still must not spawn anything (nothing to judge).
  const forced = await (await call(state, '/v1/proxybridge/health?force=1')).json()
  assert.equal(forced.checked, false)
  // A non-tar body is answered with a reason, not a crash or a half-installed dir.
  const bad = await fetch(`${state.url}/v1/proxybridge/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.token}`, [API_HEADER]: String(RISD_API_VERSION), 'content-type': 'application/gzip' },
    body: Buffer.from('definitely not a gzipped tar'),
  })
  assert.equal(bad.status, 400)
  const badBody = await bad.json()
  assert.equal(badBody.ok, false)
  assert.equal(typeof badBody.message, 'string')
})

test('leases are created, reused and released', async (t) => {
  const { state } = await startFixture(t)

  const first = await call(state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, sessionId: 's1', cwd: '/tmp/ws' } })
  assert.equal(first.status, 200)
  const lease = (await first.json()).lease
  assert.match(lease.id, /^[0-9a-f-]{36}$/)
  assert.equal(lease.ownerPid, process.pid)
  assert.equal(lease.sessionId, 's1')

  const again = await call(state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, sessionId: 's1', cwd: '/tmp/ws' } })
  assert.equal((await again.json()).lease.id, lease.id, 'same owner/session/workspace reuses the lease')

  const other = await call(state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, sessionId: 's2', cwd: '/tmp/ws' } })
  assert.notEqual((await other.json()).lease.id, lease.id)

  const released = await call(state, `/v1/leases/${lease.id}`, { method: 'DELETE' })
  assert.deepEqual(await released.json(), { ok: true, released: true })
  const againReleased = await call(state, `/v1/leases/${lease.id}`, { method: 'DELETE' })
  assert.deepEqual(await againReleased.json(), { ok: true, released: false })

  const badPid = await call(state, '/v1/leases', { method: 'POST', body: { ownerPid: 'x' } })
  assert.equal(badPid.status, 400)
  const badCwd = await call(state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, cwd: 'relative' } })
  assert.equal(badCwd.status, 400)
  const badJson = await call(state, '/v1/leases', { method: 'POST', body: 'not-an-object' })
  assert.equal(badJson.status, 400)
})

test('config reports the decided policy and only accepts a lifecycle body', async (t) => {
  const { state } = await startFixture(t)
  const response = await call(state, '/v1/config')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.keepPolicy, 'session')
  assert.equal(body.idleExitMs, 600000)
  // The daemon has no restart supervisor; advertising one was a lie (review A-P2-3).
  assert.equal(body.engineRestart, undefined)
  assert.equal(body.lifecycle.daemon.followDsh, true)

  // POST exists for the lifecycle settings only: no body = bad request, and the
  // response says what is missing instead of pretending to be read-only.
  const write = await call(state, '/v1/config', { method: 'POST', body: {} })
  assert.equal(write.status, 400)
  assert.match((await write.json()).message, /lifecycle is required/)
})

test('unknown paths are 404, wrong methods are 405', async (t) => {
  const { state } = await startFixture(t)
  const missing = await call(state, '/v1/nope')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'not-found')

  const wrongMethod = await call(state, '/v1/status?cwd=/tmp/ws', { method: 'POST', body: {} })
  assert.equal(wrongMethod.status, 405)

  const healthPost = await call(state, '/v1/health', { method: 'POST', token: null, apiVersion: null })
  assert.equal(healthPost.status, 405)
})

test('shutdown answers, then removes the state file', async (t) => {
  const { home, state } = await startFixture(t)
  const response = await call(state, '/v1/shutdown', { method: 'POST', body: { reason: 'test' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).draining, true)
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    try {
      const { readRisdState } = await import('../lib/risd/state.js')
      if (readRisdState(home) === null) return
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(risdStatePath(home).length > 0, true)
  assert.fail('state file was not removed')
})

test('health names this daemon instance so a stale page notices a restart (review A3-P1-1)', async (t) => {
  // The page embeds the instance at /ui load time. A restart always changes it
  // (new process, new token), which is what lets the page reload itself instead of
  // answering 401 forever; the field must never be the token.
  const home = makeHome('risd-instance-')
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
    removeHome(home)
  })
  const env = { DSH_RIS_IDE_PROXY_HOME: home }
  const first = await startRisdProcess({ home, env })
  const firstBody = await (await call(first.state, '/v1/health', { token: null, apiVersion: null })).json()
  assert.equal(typeof firstBody.instance, 'string')
  assert.equal(firstBody.instance, firstBody.startedAt, 'the instance is the moment this process started')
  assert.equal('token' in firstBody, false, 'health never leaks the token')
  await first.stop()
  const second = await startRisdProcess({ home, env })
  t.after(() => second.stop())
  const secondBody = await (await call(second.state, '/v1/health', { token: null, apiVersion: null })).json()
  assert.notEqual(secondBody.instance, firstBody.instance, 'a restart must invalidate pages embedding the old value')
})

test('/v1/dsh drops unusable `at` values and counts them (review A3-P2-6)', async (t) => {
  const { home, state } = await startFixture(t)
  const now = Date.now()
  const row = (cwd, at) => ({ url: 'http://127.0.0.1:3080', sessionId: `s-${cwd}`, cwd, at })
  writeFileSync(join(home, 'dsh-window.json'), `${JSON.stringify({
    windows: [
      row('/tmp/live', new Date(now).toISOString()),
      row('/tmp/epoch', now), // epoch ms is not what the writer stores
      row('/tmp/future', new Date(now + 60 * 60_000).toISOString()),
      row('/tmp/junk', 'yesterday'),
    ],
  })}\n`)
  const body = await (await call(state, '/v1/dsh')).json()
  assert.equal(body.available, true)
  assert.deepEqual(body.windows.map((entry) => entry.cwd), ['/tmp/live'])
  assert.equal(body.dropped, 3, 'every unusable timestamp is reported, not silently pruned')
})

test('/v1/dsh probes a live host when no usable snapshot exists (m00186)', async (t) => {
  // The daemon cannot read dsh's own API (its launch token lives in dsh's memory), so
  // the plugin advertises one `instances/dsh-<pid>.json` per running host. When the
  // shared document is missing or unusable, the daemon must ask that host directly
  // instead of concluding "dsh is not running".
  const home = makeHome('risd-dsh-probe-')
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
    removeHome(home)
  })
  const plugin = createServer((req, res) => {
    if (req.url !== '/dsh-ris-ide/workspaces') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:${plugin.address().port}`,
      at: new Date().toISOString(),
      workspaces: [{ cwd: '/tmp/ws-probe', title: 'probed', sessionId: 's-probe', active: true }],
    }))
  })
  await new Promise((resolve) => plugin.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => plugin.close(resolve)))
  const origin = `http://127.0.0.1:${plugin.address().port}`
  mkdirSync(join(home, 'instances'), { recursive: true })
  writeFileSync(join(home, 'instances', 'dsh-424242.json'), `${JSON.stringify({
    pid: 424242,
    url: origin,
    at: new Date().toISOString(),
  })}\n`)
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(() => daemon.stop())
  const body = await (await call(daemon.state, '/v1/dsh')).json()
  assert.equal(body.available, true, 'a live instance file is enough to find the host')
  assert.equal(body.url, origin)
  assert.deepEqual(body.windows.map((row) => [row.cwd, row.title, row.sessionId, row.source, row.active]), [
    ['/tmp/ws-probe', 'probed', 's-probe', 'workspace', true],
  ])
  assert.equal(body.knownWorkspaces, 1)
})

test('/v1/dsh names how many workspaces it found when no origin is usable (m00186)', async (t) => {
  // "dsh is not running" and "dsh reported workspaces but no origin to embed" are
  // different answers: the page can only show the count in the second case.
  const home = makeHome('risd-dsh-known-')
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
    removeHome(home)
  })
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(() => daemon.stop())
  writeFileSync(join(home, 'dsh-window.json'), `${JSON.stringify({
    windows: [],
    workspaces: [{ cwd: '/tmp/ws-a', title: 'alpha' }, { cwd: '/tmp/ws-b', title: 'beta' }],
    at: new Date().toISOString(),
  })}\n`)
  const body = await (await call(daemon.state, '/v1/dsh')).json()
  assert.equal(body.available, false)
  assert.deepEqual(body.windows, [])
  assert.equal(body.knownWorkspaces, 2)
  assert.match(String(body.reason), /已发现 2 个 dsh 工作区/)
})

test('an upload whose digest is not the pinned one is rejected (review B-P0-1)', async (t) => {
  const home = makeHome('risd-digest-')
  const savedHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const savedSha = process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
  const env = { DSH_RIS_IDE_PROXY_HOME: home, DSH_RIS_IDE_PROXYBRIDGE_SHA256: '0'.repeat(64) }
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256 = env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
  t.after(() => {
    if (savedHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = savedHome
    if (savedSha === undefined) delete process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
    else process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256 = savedSha
    removeHome(home)
  })
  const daemon = await startRisdProcess({ home, env })
  t.after(() => daemon.stop())
  const response = await upload(daemon.state, bundleTgz())
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'hash-mismatch')
  assert.equal(body.expected, '0'.repeat(64))
  assert.match(body.actual, /^[0-9a-f]{64}$/)
  // A rejected upload must not leave a half-installed component behind.
  const status = await (await call(daemon.state, '/v1/proxybridge')).json()
  assert.equal(status.installed, false)
  assert.equal(status.verified, false)
})

test('an upload matching the pinned digest installs and verifies (review B-P0-1)', async (t) => {
  const home = makeHome('risd-digest-')
  const tgz = bundleTgz()
  const digest = createHash('sha256').update(tgz).digest('hex')
  const savedHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const savedSha = process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
  const env = { DSH_RIS_IDE_PROXY_HOME: home, DSH_RIS_IDE_PROXYBRIDGE_SHA256: digest }
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256 = digest
  t.after(() => {
    if (savedHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = savedHome
    if (savedSha === undefined) delete process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
    else process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256 = savedSha
    removeHome(home)
  })
  const daemon = await startRisdProcess({ home, env })
  t.after(() => daemon.stop())
  const response = await upload(daemon.state, tgz)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.installed, true)
  assert.equal(body.sha256, digest)
  const status = await (await call(daemon.state, '/v1/proxybridge')).json()
  assert.equal(status.installed, true)
  assert.equal(status.sha256, digest)
  assert.equal(status.actualSha256, digest)
  assert.equal(status.verified, true)
})

// m11421: the page's 「重启并刷新」 relies on the daemon spawning its own successor.
// The successor must wait for the predecessor to exit (port + handoff stamp) and the
// old process must take the handoff path so the engine/bridge survive the restart.
test('a restart request hands over to a successor that waits for this pid (m11421)', () => {
  const server = readFileSync(new URL('../lib/risd/server.js', import.meta.url), 'utf8')
  assert.match(server, /path === '\/v1\/restart'/, 'the daemon exposes a restart endpoint')
  assert.match(server, /spawnRestartSuccessor\(actualPort\)\n\s*if \(onShutdown !== null\) onShutdown\(true\)/, 'the restart path spawns the successor with the live port then hands off')
  // A4-P2-6: the successor keeps the port this daemon actually bound; A4-P2-5: it
  // also carries the predecessor identity so a reused pid is not waited on.
  const cli = readFileSync(new URL('../bin/risd.mjs', import.meta.url), 'utf8')
  assert.match(cli, /arg === '--wait-pid'/, 'the CLI understands --wait-pid')
  assert.match(cli, /arg === '--wait-start'/, 'the CLI understands the pid identity hint')
  assert.match(cli, /await waitForPidExit\(options\.waitPid, 20000, options\.waitStart \?\? ''\)/, 'serve waits before binding the port')
})

test('the daemon only prompts on a user-initiated start and files elevation state per side (review B-P0-2/B-P1-1)', async () => {
  const source = readFileSync(new URL('../lib/risd/server.js', import.meta.url), 'utf8')
  assert.match(source, /const interactive = parsed\.interactive === true/, 'the flag is opt-in: saving rules and dsh starting never ask for a password')
  assert.match(source, /const redirector = await serializeBridge\(\(\) => startRedirectors\(\{ interactive \}\)\)/)
  const plugin = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(plugin, /const interactive = body\.interactive === true/, 'the plugin forwards the explicit-click flag')
  const reconcile = source.indexOf('startRedirectors({ sides: missing, interactive: false })')
  assert.ok(reconcile > 0, 'the reconciler starts without an interactive prompt')
  assert.match(source, /linux: readElevationState\('local', \{ home \}\)/, 'the elevation file is named after the side that writes it')
})
