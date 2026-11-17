/**
 * /v1/engine: the daemon starts and stops the proxy engine (Phase 1b P1).
 *
 * Phase 1a only read the pidfile; this pins the ownership hand-off: the daemon
 * performs the real start/stop, serializes concurrent presses, and reports the
 * same pid the pidfile/`/v1/health` see.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { risdStatePath } from '../lib/risd/state.js'
import { makeHome, pickPort, removeHome, risdHeaders, startRisdProcess, waitFor, writeEngineFixture } from './risd-helpers.mjs'

test('the daemon starts/stops the engine and reports one pid everywhere', async (t) => {
  const home = makeHome('risd-engine-')
  const cwd = mkdtempSync(join(tmpdir(), 'risd-engine-ws-'))
  writeEngineFixture(home, pickPort())
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(async () => {
    await fetch(`${daemon.state.url}/v1/engine`, { method: 'POST', headers: risdHeaders(daemon.state), body: JSON.stringify({ action: 'stop', cwd }) }).catch(() => {})
    await daemon.stop()
    removeHome(home)
    rmSync(cwd, { recursive: true, force: true })
  })

  const started = await fetch(`${daemon.state.url}/v1/engine`, {
    method: 'POST',
    headers: risdHeaders(daemon.state),
    body: JSON.stringify({ action: 'start', cwd }),
  })
  const startBody = await started.json()
  assert.equal(started.status, 200)
  assert.equal(startBody.ok, true, JSON.stringify(startBody))
  assert.equal(startBody.result.ok, true, JSON.stringify(startBody.result))
  const pid = startBody.result.pid
  assert.equal(Number.isInteger(pid) && pid > 0, true)
  assert.equal(existsSync(join(home, 'proxy.pid')), true, 'the daemon must own the pidfile')

  const read = await (await fetch(`${daemon.state.url}/v1/engine?cwd=${encodeURIComponent(cwd)}`, { headers: risdHeaders(daemon.state) })).json()
  assert.equal(read.engine.owned, true)
  assert.equal(read.engine.running, true)
  assert.equal(read.engine.pid, pid)

  const health = await (await fetch(`${daemon.state.url}/v1/health`)).json()
  assert.equal(health.engine.pid, pid, '/v1/health and /v1/engine must agree')
  assert.equal(health.engine.owned, true)

  const stopped = await (await fetch(`${daemon.state.url}/v1/engine`, {
    method: 'POST',
    headers: risdHeaders(daemon.state),
    body: JSON.stringify({ action: 'stop', cwd }),
  })).json()
  assert.equal(stopped.ok, true)
  assert.equal(stopped.result.stopped, true)
  assert.equal(await waitFor(() => !existsSync(join(home, 'proxy.pid'))), true)

  const after = await (await fetch(`${daemon.state.url}/v1/engine?cwd=${encodeURIComponent(cwd)}`, { headers: risdHeaders(daemon.state) })).json()
  assert.equal(after.engine.running, false)
  assert.equal(after.engine.owned, false)
})

test('engine requests are validated and serialized', async (t) => {
  const home = makeHome('risd-engine-')
  const cwd = mkdtempSync(join(tmpdir(), 'risd-engine-ws-'))
  writeEngineFixture(home, pickPort())
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(async () => {
    await fetch(`${daemon.state.url}/v1/engine`, { method: 'POST', headers: risdHeaders(daemon.state), body: JSON.stringify({ action: 'stop', cwd }) }).catch(() => {})
    await daemon.stop()
    removeHome(home)
    rmSync(cwd, { recursive: true, force: true })
  })

  const bad = await fetch(`${daemon.state.url}/v1/engine`, { method: 'POST', headers: risdHeaders(daemon.state), body: JSON.stringify({ action: 'restart', cwd }) })
  assert.equal(bad.status, 400)
  const relative = await fetch(`${daemon.state.url}/v1/engine`, { method: 'POST', headers: risdHeaders(daemon.state), body: JSON.stringify({ action: 'start', cwd: 'relative/path' }) })
  assert.equal(relative.status, 400)
  const noAuth = await fetch(`${daemon.state.url}/v1/engine?cwd=/tmp/ws`)
  assert.equal(noAuth.status, 401)

  // Two concurrent presses: both answer, one engine, no duplicate listeners.
  const [a, b] = await Promise.all(['start', 'start'].map((action) => fetch(`${daemon.state.url}/v1/engine`, {
    method: 'POST',
    headers: risdHeaders(daemon.state),
    body: JSON.stringify({ action, cwd }),
  }).then((res) => res.json())))
  assert.equal(a.ok && b.ok, true)
  const first = a.result.pid || b.result.pid
  assert.equal(Number.isInteger(first) && first > 0, true)
  const status = await (await fetch(`${daemon.state.url}/v1/status?cwd=${encodeURIComponent(cwd)}`, { headers: risdHeaders(daemon.state) })).json()
  assert.equal(status.running, true)
  assert.equal(status.pid, first)
})
