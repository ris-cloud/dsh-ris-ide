/**
 * /v1/shutdown {handoff:true} + daemon restart (Phase 1b P6).
 *
 * The point of a handoff: the successor daemon must ADOPT the engine the predecessor
 * started — same pid, same port, no restart — instead of reporting owned:false and
 * leaving the network to the previous owner's teardown. It also must not drop the
 * state note before the successor could read it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RISD_API_VERSION, readRisdState } from '../lib/risd/state.js'
import { makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'

function pickPort() {
  return 20000 + Math.floor(Math.random() * 20000)
}

function writeEngineFixture(home, port) {
  writeFileSync(join(home, 'proxy.json'), JSON.stringify({
    socks: { host: '127.0.0.1', port: 1, dbPort: 0, redisPort: 0 },
    listenPort: port,
    rules: [{
      id: 'rule-1',
      program: 'java',
      hosts: ['127.0.0.1'],
      ports: ['443'],
      enabled: true,
      shadow: false,
      source: 'user',
      workspace: home,
    }],
  }, null, 2))
}

function headers(state) {
  return { authorization: `Bearer ${state.token}`, 'x-risd-api-version': String(RISD_API_VERSION), 'content-type': 'application/json' }
}

async function post(state, path, body) {
  const response = await fetch(`${state.url}${path}`, { method: 'POST', headers: headers(state), body: JSON.stringify(body) })
  return { status: response.status, payload: await response.json().catch(() => ({})) }
}

async function get(state, path) {
  const response = await fetch(`${state.url}${path}`, { headers: headers(state) })
  return { status: response.status, payload: await response.json().catch(() => ({})) }
}

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a handoff shutdown keeps the engine for the next daemon (same pid)', async (t) => {
  const home = makeHome('risd-handoff-')
  const cwd = mkdtempSync(join(tmpdir(), 'risd-handoff-ws-'))
  t.after(() => removeHome(home))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeEngineFixture(home, pickPort())

  const first = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  const enginePid = await (async () => {
    const started = await post(first.state, '/v1/engine', { action: 'start', cwd })
    assert.equal(started.status, 200, JSON.stringify(started.payload))
    assert.equal(started.payload.ok, true)
    const health = await get(first.state, '/v1/engine?cwd=' + encodeURIComponent(cwd))
    assert.equal(health.payload.engine.owned, true)
    return health.payload.engine.pid
  })()
  assert.equal(pidAlive(enginePid), true, 'the engine is a live child process')

  // Hand over instead of shutting down: the daemon exits, the network stays.
  const draining = await post(first.state, '/v1/shutdown', { handoff: true })
  assert.equal(draining.status, 200)
  assert.equal(draining.payload.handoff, true)
  assert.equal(await first.stop(), 0, 'the predecessor exits cleanly')
  assert.equal(existsSync(join(home, 'risd.json')), true, 'the state note survives a handoff')
  const noted = JSON.parse((await import('node:fs')).readFileSync(join(home, 'risd.json'), 'utf8'))
  assert.equal(noted.handoff?.enginePid, enginePid, 'the note names the engine to adopt')
  assert.equal(noted.handoff?.cwd, cwd)
  assert.equal(pidAlive(enginePid), true, 'nothing tore the engine down')

  // The successor takes the same port and adopts instead of restarting.
  const second = await startRisdProcess({ home, port: noted.port, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  try {
    const health = await get(second.state, '/v1/health')
    assert.equal(health.payload.engine.owned, true, 'the successor owns the engine')
    assert.equal(health.payload.engine.inherited, true, 'and says it adopted a handed-off engine (review C-P2-10)')
    assert.equal(health.payload.engine.pid, enginePid, 'same pid: nothing was restarted')
    const status = await get(second.state, '/v1/status?cwd=' + encodeURIComponent(cwd))
    assert.equal(status.status, 200)
  } finally {
    await post(second.state, '/v1/engine', { action: 'stop', cwd }).catch(() => {})
    await second.stop()
    await waitFor(() => pidAlive(enginePid) !== true, 12000)
  }
  assert.equal(pidAlive(enginePid), false, 'the successor still owns the teardown')
  assert.equal(readRisdState(home), null, 'a normal shutdown removes the state note')
})
