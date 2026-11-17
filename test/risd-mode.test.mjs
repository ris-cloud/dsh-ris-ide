/**
 * daemonMode: the plugin can borrow risd for the READ-ONLY proxy view.
 *
 * The engine still belongs to the plugin in Phase 1a — the daemon only serves the
 * table, and a missing/unreachable daemon must fall back to the in-process view
 * without breaking the dialog. These tests pin both halves.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

// Set the isolation env BEFORE the plugin module is imported (it reads the proxy
// home and the daemon port at call time, but the same home must be used by both).
const home = mkdtempSync(join(tmpdir(), 'ris-risd-mode-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home
process.env.DSH_RISD_PORT = '0'

const { apply, __test } = await import('../lib/index.js')
const { janitorStatus, disarmJanitor } = await import('../lib/janitor.js')
const { readRisdState, risdStatePath } = await import('../lib/risd/state.js')
const { shutdownRisd } = await import('../lib/risd-client.js')
const { removeHome, sleep } = await import('./risd-helpers.mjs')

function fakeRes() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

function fakeReq(method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  return req
}

function fakeCtx(cwd) {
  const disposers = []
  return {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: { register: () => () => {} },
    tools: { register: () => {} },
    logger: { warn: () => {} },
    sessions: { get: () => ({ header: { cwd } }) },
    dispose() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(100)
  }
  return false
}

after(async () => {
  const state = readRisdState(home)
  if (state !== null) await shutdownRisd(state)
  disarmJanitor()
  rmSync(home, { recursive: true, force: true })
})

test('daemonMode=off never spawns risd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-risd-off-'))
  try {
    const ctx = fakeCtx(dir)
    apply(ctx, { daemonMode: 'off' })
    await sleep(400)
    assert.equal(existsSync(risdStatePath(home)), false, 'no daemon state without daemonMode=auto')

    const res = fakeRes()
    await __test.serveProxy(ctx, fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.daemon, undefined, 'the local view carries no daemon section')
    assert.equal(body.workspace, dir)
    assert.equal(body.rules.length >= 2, true)
    ctx.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daemonMode auto serves the view from risd, then falls back when it dies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-risd-auto-'))
  try {
    const ctx = fakeCtx(dir)
    apply(ctx, { daemonMode: 'auto' })

    const up = await waitFor(() => readRisdState(home) !== null)
    assert.equal(up, true, 'daemonMode=auto must spawn risd')
    const state = readRisdState(home)

    // The view is served by the daemon (it adds the `daemon` section) and the
    // plugin still decorates rules + inherited fields locally.
    let body = null
    const forwarded = await waitFor(async () => {
      const res = fakeRes()
      await __test.serveProxy(ctx, fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
      const parsed = res.json()
      if (parsed.daemon === undefined) return false
      body = parsed
      return true
    })
    assert.equal(forwarded, true, 'GET must be served by the daemon once it is up')
    assert.equal(body.daemon.pid, state.pid)
    assert.equal(body.workspace, dir)
    assert.equal(Array.isArray(body.rules), true)
    assert.equal(body.rules.length >= 2, true)
    assert.equal(typeof body.inherited, 'boolean')

    // The lease belongs to this plugin process and survives until dispose.
    const status = await (await fetch(`${state.url}/v1/status?cwd=${encodeURIComponent(dir)}`, {
      headers: { authorization: `Bearer ${state.token}`, 'x-risd-api-version': '1' },
    })).json()
    assert.equal(status.daemon.leases >= 1, true)

    ctx.dispose()
    assert.equal(await waitFor(async () => {
      const view = await (await fetch(`${state.url}/v1/status?cwd=${encodeURIComponent(dir)}`, {
        headers: { authorization: `Bearer ${state.token}`, 'x-risd-api-version': '1' },
      })).json()
      return view.daemon.leases === 0
    }), true, 'dispose releases the lease (the daemon itself keeps running)')
    assert.equal(readRisdState(home)?.pid, state.pid, 'dispose must NOT stop the daemon')

    // Kill the daemon: the next GET falls back to the in-process view.
    const kill = await fetch(`${state.url}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'x-risd-api-version': '1' },
    })
    assert.equal(kill.status, 200)
    await waitFor(() => readRisdState(home) === null)

    const res = fakeRes()
    await __test.serveProxy(ctx, fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const fallback = res.json()
    assert.equal(res.status, 200)
    assert.equal(fallback.daemon, undefined)
    assert.equal(fallback.workspace, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
