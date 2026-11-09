/**
 * Session policy: the daemon owns the engine, so it also decides when the
 * network has no consumer left. Last lease gone ⇒ stop the engine (P2 scope:
 * engine only — git and the bridge move in P5).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RISD_API_VERSION } from '../lib/risd/state.js'
import { makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'

function headers(state) {
  return { authorization: `Bearer ${state.token}`, 'x-risd-api-version': String(RISD_API_VERSION), 'content-type': 'application/json' }
}

// Teardown is 300ms debounce + engine stop (5s grace) + bridge/git attempts; on a
// loaded machine (full suite, four files in parallel) that can exceed 8s even when
// the behaviour is correct, so the waits are generous on purpose.
async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(120)
  }
  return false
}

async function startFixture(t) {
  const home = makeHome('risd-teardown-')
  const cwd = mkdtempSync(join(tmpdir(), 'risd-teardown-ws-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(join(home, 'proxy.json'), JSON.stringify({
    socks: { host: '127.0.0.1', port: 1, dbPort: 0, redisPort: 0 },
    listenPort: port,
    rules: [{ id: 'rule-1', program: 'java', hosts: ['127.0.0.1'], ports: ['443'], enabled: true, shadow: false, source: 'user', workspace: cwd }],
  }))
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(async () => {
    await daemon.stop()
    removeHome(home)
    rmSync(cwd, { recursive: true, force: true })
  })
  const h = headers(daemon.state)
  const startEngine = async () => {
    const res = await fetch(`${daemon.state.url}/v1/engine`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'start', cwd }) })
    return res.json()
  }
  const lease = async (sessionId) => (await (await fetch(`${daemon.state.url}/v1/leases`, { method: 'POST', headers: h, body: JSON.stringify({ ownerPid: process.pid, sessionId, cwd }) })).json()).lease
  const release = async (id) => (await (await fetch(`${daemon.state.url}/v1/leases/${encodeURIComponent(id)}`, { method: 'DELETE', headers: h })).json()).released
  const engine = async () => (await (await fetch(`${daemon.state.url}/v1/engine?cwd=${encodeURIComponent(cwd)}`, { headers: h })).json()).engine
  return { daemon, home, cwd, startEngine, lease, release, engine }
}

test('the last release stops the engine, the first one does not', async (t) => {
  const fx = await startFixture(t)
  const started = await fx.startEngine()
  assert.equal(started.result.ok, true, JSON.stringify(started.result))
  const pid = started.result.pid

  const a = await fx.lease('A')
  const b = await fx.lease('B')
  assert.equal(await fx.release(a.id), true)
  await sleep(600)
  assert.equal((await fx.engine()).running, true, 'one lease left: the engine must stay up')

  assert.equal(await fx.release(b.id), true)
  assert.equal(await waitFor(async () => (await fx.engine()).running === false), true, 'last lease gone: the engine stops')
  assert.equal(await waitFor(() => !existsSync(join(fx.home, 'proxy.pid'))), true)
  assert.equal((await fx.engine()).pid, null)
  assert.equal(pid > 0, true)
})

test('a dead owner is swept and then the engine is torn down', async (t) => {
  const fx = await startFixture(t)
  const started = await fx.startEngine()
  assert.equal(started.result.ok, true)

  const orphan = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => orphan.kill('SIGKILL'))
  const h = headers(fx.daemon.state)
  await fetch(`${fx.daemon.state.url}/v1/leases`, { method: 'POST', headers: h, body: JSON.stringify({ ownerPid: orphan.pid, sessionId: 'gone', cwd: fx.cwd }) })
  orphan.kill('SIGKILL')

  assert.equal(await waitFor(async () => (await fx.engine()).running === false, 15000), true, 'swept lease must trigger teardown')
})
