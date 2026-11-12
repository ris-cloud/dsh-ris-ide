/**
 * risd leases: liveness is "is the owner pid still there", not "did we see an
 * exit signal".
 *
 * Unit half: the registry with an injected `alive` predicate, so the exact
 * sweep semantics (idempotent acquire, callback once, release removes the key)
 * can be tested without waiting on the clock.
 *
 * Integration half: a lease taken for a child process disappears within one
 * poll interval (3s) after that child is killed — the behaviour Ctrl+C and
 * SIGKILL both rely on.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { RISD_API_VERSION } from '../lib/risd/state.js'
import { createLeaseRegistry, LEASE_POLL_MS } from '../lib/risd/leases.js'
import { makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'

test('acquire is idempotent per owner/session/workspace and release is exact', () => {
  const gone = []
  const registry = createLeaseRegistry({ alive: () => true, onGone: (lease) => gone.push(lease.id) })
  const first = registry.acquire({ ownerPid: 11, sessionId: 's', cwd: '/w' })
  const again = registry.acquire({ ownerPid: 11, sessionId: 's', cwd: '/w' })
  assert.equal(again.id, first.id)
  assert.equal(registry.count(), 1)

  const other = registry.acquire({ ownerPid: 11, sessionId: 's2', cwd: '/w' })
  assert.notEqual(other.id, first.id)
  assert.equal(registry.count(), 2)

  assert.equal(registry.release(first.id), true)
  assert.equal(registry.release(first.id), false)
  assert.equal(registry.count(), 1)
  assert.deepEqual(gone, [], 'release is not death: no onGone callback')
})

test('a dead owner is swept after one poll and onGone fires once', async () => {
  const alive = new Set([21, 22])
  const gone = []
  const registry = createLeaseRegistry({ pollMs: 20, alive: (pid) => alive.has(pid), onGone: (lease) => gone.push(lease.ownerPid) })
  registry.start()
  registry.acquire({ ownerPid: 21, cwd: '/w' })
  registry.acquire({ ownerPid: 22, cwd: '/w' })
  alive.delete(21)
  await sleep(80)
  registry.stop()
  assert.deepEqual(registry.list().map((lease) => lease.ownerPid), [22])
  assert.deepEqual(gone, [21])
})

test('the daemon forgets a lease whose owner process is killed', async (t) => {
  const home = makeHome('risd-lease-')
  t.after(() => removeHome(home))
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(() => daemon.stop())

  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => victim.kill('SIGKILL'))
  const headers = { authorization: `Bearer ${daemon.state.token}`, 'x-risd-api-version': String(RISD_API_VERSION), 'content-type': 'application/json' }
  const created = await fetch(`${daemon.state.url}/v1/leases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ownerPid: victim.pid, sessionId: 's', cwd: '/tmp/ws' }),
  })
  assert.equal(created.status, 200)
  const lease = (await created.json()).lease
  assert.equal(lease.ownerPid, victim.pid)

  const before = await (await fetch(`${daemon.state.url}/v1/status?cwd=/tmp/ws`, { headers })).json()
  assert.equal(before.daemon.leases, 1)

  victim.kill('SIGKILL')
  const deadline = Date.now() + LEASE_POLL_MS + 3000
  let count = 1
  while (Date.now() < deadline) {
    const body = await (await fetch(`${daemon.state.url}/v1/status?cwd=/tmp/ws`, { headers })).json()
    count = body.daemon.leases
    if (count === 0) break
    await sleep(200)
  }
  assert.equal(count, 0, 'the lease must be swept within one poll interval')
})
