/**
 * A teardown that times out must leave the janitor ARMED.
 *
 * Review A-P0-2: stop() waited at most 5s for the network teardown and then
 * disarmed the watcher unconditionally. On WSL the bridge probe can hang for
 * seconds, so the timeout path was the normal one — and it left the engine, its
 * pidfile and the port behind with nothing left to finish the job.
 *
 * The test drives an in-process daemon with a teardown that never resolves (the
 * slow-mount shape) and a short timeout: the watcher must still be armed after
 * stop() returned.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'risd-janitor-guard-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { startRisd } = await import('../lib/risd/server.js')
const { armJanitor, disarmJanitor, janitorStatus } = await import('../lib/janitor.js')

test.after(() => {
  disarmJanitor()
  rmSync(home, { recursive: true, force: true })
})

test('a timed-out teardown keeps the janitor armed', async (t) => {
  const started = await startRisd({
    home,
    port: 0,
    version: 'test',
    teardownTimeoutMs: 120,
    // A mounted `/mnt/c` makes the bridge probe hang; a never-resolving teardown
    // reproduces that shape without touching the real machine.
    teardown: () => new Promise(() => {}),
  })
  assert.equal(started.ok, true)
  assert.equal(janitorStatus().running, true, 'the daemon arms the watcher on start')
  // Let the armed watcher be real, then stop the daemon; the network teardown will
  // block on the bridge probe long past the 120ms budget.
  await started.stop({})
  assert.equal(janitorStatus().running, true, 'a timed-out teardown must leave the watcher to finish the job')
})
