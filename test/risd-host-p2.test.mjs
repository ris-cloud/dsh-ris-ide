/**
 * Plugin-side (lib/index.js) regressions for the P2 findings of the C report:
 * how the host forwards proxy writes/actions when the daemon answers with an API
 * version mismatch, a stale table, or not at all.
 *
 * Why a separate file: these are HTTP-shape tests against `serveProxy` /
 * `serveProxyAction` with a fake daemon, so they need lib/index.js loaded with a
 * temporary proxy home instead of the page strings risd-ui.test.mjs asserts on.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'risd-host-p2-'))
const workspace = mkdtempSync(join(tmpdir(), 'risd-host-p2-ws-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { __test } = await import('../lib/index.js')
const { RISD_API_VERSION } = await import('../lib/risd/state.js')

function fakeRes() {
  return {
    status: 0,
    chunks: [],
    writeHead(status) { this.status = status },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  return req
}

/** A fake daemon that answers /v1/health and hands every other request to `reply`. */
async function fakeDaemon(reply) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, apiVersion: RISD_API_VERSION, pid: 4242, port: server.address().port, version: '1.8.0' }))
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw)
      const answer = reply(req, body)
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function stopServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

function setBridge(url, port) {
  __test.setRisdBridge({
    mode: 'auto',
    state: { url, token: 'token-x', apiVersion: RISD_API_VERSION, port },
    leaseId: 'lease-x',
    pending: null,
    warnedAt: 0,
    degraded: false,
    lastProbeAt: Date.now(),
  })
}

const ctx = { sessions: { get: () => ({ header: { cwd: workspace } }) } }
const writeBody = {
  sessionId: 's1',
  revision: '',
  config: { socks: { host: 'proxy.example.com', port: 10080 }, listenPort: 11081, rules: [] },
}

test.after(() => {
  __test.setRisdBridge(null)
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

test('a daemon API mismatch is not reported as "someone else changed the rules" (C-P2-1)', async () => {
  // Before: every 409 was passed through as a table conflict, so the dialog told the
  // user to reload and retried a write the daemon can never accept until dsh is
  // restarted; design §7.1 wants a 503 risd-upgrade-required here.
  const server = await fakeDaemon(() => ({
    status: 409,
    body: { ok: false, code: 'api-mismatch', message: 'plugin apiVersion 1 ≠ daemon apiVersion 2' },
  }))
  const port = server.address().port
  setBridge(`http://127.0.0.1:${port}`, port)
  const res = fakeRes()
  await __test.serveProxy(ctx, fakeReq('POST', '/dsh-ris-ide/proxy', writeBody), res)
  assert.equal(res.status, 503)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'risd-upgrade-required')
  assert.match(String(body.message), /重启 dsh/)
  await stopServer(server)
})

test('a genuinely stale table still answers 409 with conflict and the current view (C-P2-1)', async () => {
  const server = await fakeDaemon(() => ({
    status: 409,
    body: { ok: false, conflict: true, code: 'conflict', message: '规则表已在别处被修改，本次改动未写入', revision: 'deadbeef' },
  }))
  const port = server.address().port
  setBridge(`http://127.0.0.1:${port}`, port)
  const res = fakeRes()
  await __test.serveProxy(ctx, fakeReq('POST', '/dsh-ris-ide/proxy', writeBody), res)
  assert.equal(res.status, 409)
  const body = res.json()
  assert.equal(body.conflict, true)
  assert.equal(body.code, 'conflict')
  assert.equal(body.revision, 'deadbeef')
  assert.equal(body.message, '规则表已在别处被修改，本次改动未写入', 'the daemon message must pass through verbatim')
  assert.equal(body.view.ok, true, 'the dialog needs the current view to reload')
  await stopServer(server)
})

test('an unreachable daemon refuses a proxy action with a retry hint instead of a bare 502 (C-P2-8)', async () => {
  // The panel lost its proxy buttons, so "stop engine" only exists on this page:
  // a timeout there must not read as "the action failed inside the daemon".
  setBridge('http://127.0.0.1:9', 9)
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify({ socks: { host: 'proxy.example.com', port: 10080 }, listenPort: 11081, rules: [], shadows: [] }, null, 2)}\n`, { mode: 0o600 })
  const res = fakeRes()
  await __test.serveProxyAction(ctx, fakeReq('POST', '/dsh-ris-ide/proxy/action', { sessionId: 's1', cwd: workspace, action: 'stop' }), res)
  assert.equal(res.status, 503)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'risd-unavailable')
  assert.match(String(body.message), /未执行/)
})
