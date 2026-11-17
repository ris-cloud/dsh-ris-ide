/**
 * risd-client: discovery, spawn, wait, lease and view — the plugin side.
 *
 * The daemon these tests spawn is real (same `bin/risd.mjs` the plugin forks),
 * because the interesting failures are process-level: a spawn race, a stale
 * state file, a daemon that answers a different apiVersion.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { RISD_API_VERSION, risdStatePath } from '../lib/risd/state.js'
import { acquireLease, ensureRisd, getProxyView, probeRisd, releaseLease, shutdownRisd } from '../lib/risd-client.js'
import { makeHome, removeHome, sleep } from './risd-helpers.mjs'

function isolate(t, home) {
  const savedPort = process.env.DSH_RISD_PORT
  const savedHome = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RISD_PORT = '0'
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (savedPort === undefined) delete process.env.DSH_RISD_PORT
    else process.env.DSH_RISD_PORT = savedPort
    if (savedHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = savedHome
  })
}

async function waitForExit(home, timeoutMs = 5000) {
  const { readRisdState } = await import('../lib/risd/state.js')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readRisdState(home) === null) return true
    await sleep(50)
  }
  return false
}

test('ensureRisd spawns once, then reuses the running daemon', async (t) => {
  const home = makeHome('risd-client-')
  isolate(t, home)
  const first = await ensureRisd({ home })
  t.after(async () => {
    const state = await import('../lib/risd/state.js')
    const current = state.readRisdState(home)
    if (current !== null) await shutdownRisd(current)
    removeHome(home)
  })
  assert.equal(first.ok, true, first.reason)
  assert.equal(first.spawned, true)
  assert.equal(first.state.apiVersion, RISD_API_VERSION)

  const second = await ensureRisd({ home })
  assert.equal(second.ok, true)
  assert.equal(second.spawned, false)
  assert.equal(second.state.pid, first.state.pid)

  const view = await getProxyView(first.state, '/tmp/ws')
  assert.equal(view.ok, true)
  assert.equal(view.workspace, '/tmp/ws')

  const lease = await acquireLease(first.state, { ownerPid: process.pid, sessionId: 's', cwd: '/tmp/ws' })
  assert.equal(lease.ok, true)
  assert.equal(lease.body.lease.ownerPid, process.pid)
  const released = await releaseLease(first.state, lease.body.lease.id)
  assert.equal(released.ok, true)
  assert.equal(released.body.released, true)

  const shutdown = await shutdownRisd(first.state)
  assert.equal(shutdown.ok, true)
  assert.equal(await waitForExit(home), true, 'the daemon must remove risd.json on shutdown')
})

test('concurrent ensureRisd calls agree on one daemon', async (t) => {
  const home = makeHome('risd-client-race-')
  isolate(t, home)
  // ONE hook: stop the daemon BEFORE deleting its home, otherwise the state file
  // is gone by the time we look and the detached daemon survives the test run.
  t.after(async () => {
    const { readRisdState } = await import('../lib/risd/state.js')
    const current = readRisdState(home)
    if (current !== null) await shutdownRisd(current)
    removeHome(home)
  })

  const [a, b] = await Promise.all([ensureRisd({ home }), ensureRisd({ home })])
  assert.equal(a.ok, true, a.reason)
  assert.equal(b.ok, true, b.reason)
  assert.equal(a.state.pid, b.state.pid, 'both callers must see the same daemon')
  assert.equal([a.spawned, b.spawned].filter(Boolean).length <= 1, true)
})

test('a stale state file is reported as unreachable, not trusted', async (t) => {
  const home = makeHome('risd-client-stale-')
  t.after(() => removeHome(home))
  writeFileSync(
    risdStatePath(home),
    JSON.stringify({ apiVersion: 1, version: '0.0.0', pid: 999999, port: 9, token: 'x', home, startedAt: new Date().toISOString(), url: 'http://127.0.0.1:9' }),
  )
  const probe = await probeRisd({ home })
  assert.equal(probe.usable, false)
  assert.equal(probe.reason, 'unreachable')
})

test('a daemon speaking another apiVersion is reported as api-mismatch', async (t) => {
  const home = makeHome('risd-client-mismatch-')
  t.after(() => removeHome(home))
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, apiVersion: 2, pid: process.pid }))
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  t.after(() => foreign.close())
  writeFileSync(
    risdStatePath(home),
    JSON.stringify({ apiVersion: 2, version: '9.0.0', pid: process.pid, port: foreign.address().port, token: 'x', home, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${foreign.address().port}` }),
  )
  const probe = await probeRisd({ home })
  assert.equal(probe.usable, false)
  assert.equal(probe.reason, 'api-mismatch')

  const ensured = await ensureRisd({ home })
  assert.equal(ensured.ok, false)
  assert.equal(ensured.reason, 'api-mismatch')
})

test('releaseLease tolerates a missing id (exit path safety)', async () => {
  const result = await releaseLease({ url: 'http://127.0.0.1:9', token: 'x' }, undefined)
  assert.equal(result.ok, true)
})
