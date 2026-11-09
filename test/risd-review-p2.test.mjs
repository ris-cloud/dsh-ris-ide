/**
 * Regressions for the P2 findings of the 2026-11-09 expert review that live on
 * the daemon's HTTP surface (A report) plus the client/log helpers.
 *
 * Each case names the finding it pins (A-P2-x) so a future reader can trace it
 * back to work/reviews/20261109-risd/A-daemon-core.md.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { looksAbsolutePath, startRisd } from '../lib/risd/server.js'
import { createRisdLogger, risdLogPath } from '../lib/risd/log.js'
import { reconcileStartupLeftovers } from '../lib/startup.js'
import { ensureRisd } from '../lib/risd-client.js'
import { RISD_API_VERSION, risdStatePath, writeRisdState } from '../lib/risd/state.js'
import { makeHome, removeHome, runRisdCli, sleep, startRisdProcess } from './risd-helpers.mjs'
import { pidAlive } from '../lib/proxy.js'

const homes = []
function home() {
  const dir = makeHome('risd-p2-')
  homes.push(dir)
  return dir
}
after(() => {
  for (const dir of homes) removeHome(dir)
})

function httpJson(port, path, { method = 'GET', body = null, raw = null, token = null } = {}) {
  return new Promise((resolve) => {
    const payload = raw !== null ? raw : body === null ? null : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(token === null ? {} : { authorization: `Bearer ${token}`, 'x-risd-api-version': String(RISD_API_VERSION) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed, text })
      })
    })
    req.on('error', (error) => resolve({ status: 0, body: null, text: '', error: String(error.message) }))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

test('absolute paths are recognised on both platforms (A-P1-3)', () => {
  assert.equal(looksAbsolutePath('/tmp/demo'), true)
  assert.equal(looksAbsolutePath('C:\\work\\demo'), true)
  assert.equal(looksAbsolutePath('\\\\server\\share\\demo'), true)
  assert.equal(looksAbsolutePath('relative/demo'), false)
  assert.equal(looksAbsolutePath(''), false)
  assert.equal(looksAbsolutePath(null), false)
})

test('an oversized body gets a 413 answer instead of a broken socket (A-P2-6)', async () => {
  const started = await startRisdProcess({ home: home() })
  try {
    const huge = JSON.stringify({ action: 'start', cwd: '/tmp', pad: 'x'.repeat(70 * 1024) })
    const response = await httpJson(started.state.port, '/v1/leases', {
      method: 'POST',
      raw: huge,
      token: started.state.token,
    })
    assert.equal(response.status, 413)
    assert.equal(response.body?.code, 'too-large')
  } finally {
    await started.stop()
  }
})

test('/v1/config reports real values only (A-P2-3)', async () => {
  const started = await startRisdProcess({ home: home() })
  try {
    const response = await httpJson(started.state.port, '/v1/config', { token: started.state.token })
    assert.equal(response.status, 200)
    assert.equal(response.body.idleExitMs, 10 * 60 * 1000)
    assert.equal(response.body.engineRestart, undefined)
    assert.ok(response.body.lifecycle)
  } finally {
    await started.stop()
  }
})

test('/v1/dsh ignores windows whose url is not a loopback http(s) origin (A-P2-10)', async () => {
  const dir = home()
  const started = await startRisdProcess({ home: dir })
  try {
    writeFileSync(join(dir, 'dsh-window.json'), JSON.stringify({
      windows: [
        { url: 'https://evil.example.com', sessionId: 's-evil', cwd: '/tmp/evil', at: new Date().toISOString() },
        { url: `http://127.0.0.1:${started.state.port}`, sessionId: 's-ok', cwd: '/tmp/demo-workspace', at: new Date().toISOString() },
      ],
    }), { mode: 0o600 })
    const response = await httpJson(started.state.port, '/v1/dsh', { token: started.state.token })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.windows.map((row) => row.sessionId), ['s-ok'])
  } finally {
    await started.stop()
  }
})

test('a conflicting write reports the current view (A-P2-1)', async () => {
  const dir = home()
  const started = await startRisdProcess({ home: dir })
  try {
    const auth = { token: started.state.token }
    const current = await httpJson(started.state.port, '/v1/proxy', auth)
    assert.equal(current.status, 200)
    const stale = await httpJson(started.state.port, '/v1/proxy', {
      ...auth,
      method: 'POST',
      body: {
        cwd: '/tmp',
        revision: 'definitely-stale',
        config: { socks: { host: '127.0.0.1', port: 1 }, listenPort: 11081, rules: [] },
      },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body?.conflict, true)
    assert.ok(stale.body?.view, 'the 409 must carry a fresh view')
    assert.equal(typeof stale.body.view.revision, 'string')
  } finally {
    await started.stop()
  }
})

test('the log creates its home directory (A-P2-12)', () => {
  const base = home()
  const missing = join(base, 'nested', 'home')
  const logger = createRisdLogger(missing)
  logger.info('hello')
  assert.equal(existsSync(risdLogPath(missing)), true)
  assert.match(readFileSync(risdLogPath(missing), 'utf8'), /hello/)
})

test('startup reconcile keeps the state file of the daemon asking (A-P1-5)', async () => {
  const dir = home()
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = dir
  try {
    const port = 55999
    writeRisdState({ pid: process.pid, port, token: 'x'.repeat(64), apiVersion: RISD_API_VERSION, version: 'test', startedAt: new Date().toISOString() }, dir)
    await reconcileStartupLeftovers({ ownPid: process.pid })
    assert.equal(existsSync(risdStatePath(dir)), true, 'own risd.json must survive')
    await reconcileStartupLeftovers({ ownPid: 1 })
    assert.equal(existsSync(risdStatePath(dir)), false, 'a stale risd.json from another pid is removed')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
  }
})

test('a daemon that exits early reports why (A-P2-13)', async () => {
  const dir = home()
  const fake = join(mkdtempSync(join(tmpdir(), 'risd-fake-')), 'risd.mjs')
  writeFileSync(fake, "process.stderr.write('port busy\\n'); process.exit(4)\n")
  const ensured = await ensureRisd({ home: dir, spawnPath: fake, timeoutMs: 2000 })
  assert.equal(ensured.ok, false)
  assert.equal(ensured.reason, 'port-busy')
  assert.equal(ensured.exitCode, 4)
  assert.match(String(ensured.error), /port busy/)
  rmSync(join(fake, '..'), { recursive: true, force: true })
})

test('a second home on the same port is refused, not silently shadowed (A-P2-9)', async () => {
  const started = await startRisdProcess({ home: home() })
  try {
    const other = home()
    const second = await startRisd({ home: other, port: started.state.port, version: 'test' })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'home-mismatch')
    assert.equal(second.found, started.home)
    assert.equal(second.home, other)
  } finally {
    await started.stop()
  }
})

test('risd stop waits for the pid, not for the state file (A-P2-7)', async () => {
  const dir = home()
  const started = await startRisdProcess({ home: dir })
  const pid = started.state.pid
  const result = await runRisdCli(['stop', '--home', dir])
  assert.equal(result.code, 0, result.out + result.err)
  assert.match(result.out, /risd: stopped/)
  await sleep(50)
  assert.equal(pidAlive(pid), false)
})

test('/ui is served with frame, sniff and CSP protection (C-P2-5)', async () => {
  const started = await startRisdProcess({ home: home() })
  try {
    const response = await fetch(`http://127.0.0.1:${started.state.port}/ui`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const csp = response.headers.get('content-security-policy') ?? ''
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:\*/)
  } finally {
    await started.stop()
  }
})
