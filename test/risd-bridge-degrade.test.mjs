/**
 * One failed daemon request must not demote the plugin to a local writer.
 *
 * Review C-P0-2: the bridge used to null its state AND its lease on the first
 * failure. The daemon then kept owning the table while the plugin wrote it too
 * (split brain), and the lost lease made `followDsh` tear down tunnels other
 * windows were still using. Now the pointer is "degraded", the lease survives,
 * and a write refuses to fall back while the daemon is provably alive.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'risd-degrade-'))
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

const workspace = mkdtempSync(join(tmpdir(), 'risd-degrade-ws-'))
const ctx = { sessions: { get: () => ({ header: { cwd: workspace } }) } }

test.after(() => {
  __test.setRisdBridge(null)
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

test('a failed read keeps the lease, marks the bridge degraded and answers locally', async () => {
  const bridge = {
    mode: 'auto',
    state: { url: 'http://127.0.0.1:9', token: 'x', apiVersion: RISD_API_VERSION, port: 9 },
    leaseId: 'lease-x',
    pending: null,
    warnedAt: 0,
    degraded: false,
    lastProbeAt: Date.now(),
  }
  __test.setRisdBridge(bridge)
  const res = fakeRes()
  await __test.serveProxy(ctx, fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
  assert.equal(res.status, 200, 'the dialog still works when the daemon is unreachable')
  assert.equal(bridge.state, null)
  assert.equal(bridge.degraded, true)
  assert.equal(bridge.leaseId, 'lease-x', 'the lease must survive a single failure')
})

test('a write refuses to go local while the daemon still answers health', async () => {
  const table = { socks: { host: 'proxy.example.com', port: 10080 }, listenPort: 11081, rules: [], shadows: [] }
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 })
  const server = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, apiVersion: RISD_API_VERSION, pid: 123, port: server.address().port, version: '1.8.0' }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({
    ok: true, apiVersion: RISD_API_VERSION, pid: 123, port, token: 'token-x',
    version: '1.8.0', startedAt: new Date().toISOString(), home,
    url: `http://127.0.0.1:${port}`,
  }, null, 2)}\n`, { mode: 0o600 })
  const bridge = { mode: 'auto', state: null, leaseId: 'lease-x', pending: null, warnedAt: 0, degraded: true, lastProbeAt: Date.now() }
  __test.setRisdBridge(bridge)
  const before = readFileSync(join(home, 'proxy.json'), 'utf8')
  const res = fakeRes()
  await __test.serveProxy(ctx, fakeReq('POST', '/dsh-ris-ide/proxy', {
    sessionId: 's1',
    revision: '',
    config: { socks: table.socks, listenPort: table.listenPort, rules: [] },
  }), res)
  assert.equal(res.status, 503, 'writing behind a live daemon is refused, not silently local')
  assert.equal(readFileSync(join(home, 'proxy.json'), 'utf8'), before, 'the machine table is untouched')
  await new Promise((resolve) => server.close(resolve))
})
