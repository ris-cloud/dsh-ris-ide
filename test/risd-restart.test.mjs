/**
 * Daemon restart helpers (review A4-P2-5/P2-6/P2-7).
 *
 * `POST /v1/restart` cannot be exercised end-to-end from a unit test without
 * replacing the real daemon, so the two pieces that carry the behaviour are tested
 * directly: the successor argv (port + pid identity) and the wait that keeps a
 * successor from stealing the port or waiting on a reused pid.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { __test, readStartTime, successorArgs, waitForPidExit } from '../lib/risd/server.js'

/** Spawn a detached-ish node child that lives for `ms`; returns {child, done}. */
function liveChild(ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' })
  const done = new Promise((resolve) => child.once('exit', resolve))
  return { child, done }
}

test('the successor keeps the port the daemon actually bound and the pid identity (A4-P2-6/A4-P2-5)', () => {
  const argv = successorArgs({ pid: 4321, port: 11082, startTime: '987654' })
  assert.equal(argv[1], 'serve', 'the CLI is asked to serve')
  assert.deepEqual(argv.slice(2, 4), ['--wait-pid', '4321'], 'it waits for this daemon pid')
  assert.deepEqual(argv.slice(argv.indexOf('--port'), argv.indexOf('--port') + 2), ['--port', '11082'], 'it binds the same port, not the default')
  assert.deepEqual(argv.slice(argv.indexOf('--wait-start'), argv.indexOf('--wait-start') + 2), ['--wait-start', '987654'], 'it carries the start time that proves the pid identity')

  const defaulted = successorArgs({ pid: 7, port: 0, startTime: '' })
  assert.equal(defaulted.includes('--port'), false, 'port 0 means "let the OS choose", never --port 0')
  assert.equal(defaulted.includes('--wait-start'), false, 'no start time on platforms without /proc')
  assert.deepEqual(defaulted.slice(2, 4), ['--wait-pid', '7'])
})

test('waitForPidExit resolves as soon as the predecessor exits', async (t) => {
  const { child, done } = liveChild(400)
  t.after(() => child.kill('SIGKILL'))
  const startedAt = Date.now()
  const result = await waitForPidExit(child.pid, 5000)
  const elapsed = Date.now() - startedAt
  assert.deepEqual(result, { ok: true, timedOut: false })
  assert.ok(elapsed >= 50, `waited at least one poll tick (${elapsed}ms)`)
  await done
})

test('a reused pid is treated as exited instead of waited on (A4-P2-5)', async (t) => {
  if (process.platform !== 'linux') return t.skip('start times come from /proc')
  const { child } = liveChild(10_000)
  t.after(() => child.kill('SIGKILL'))
  const startedAt = Date.now()
  // '1' is a valid-looking start time but cannot match this fresh child.
  const result = await waitForPidExit(child.pid, 5000, '1')
  const elapsed = Date.now() - startedAt
  assert.deepEqual(result, { ok: true, timedOut: false }, 'a different start time proves the old process is gone')
  assert.ok(elapsed < 1500, `did not wait for the unrelated process to exit (${elapsed}ms)`)
})

test('a live pid with the matching start time makes waitForPidExit time out (A4-P2-5)', async (t) => {
  if (process.platform !== 'linux') return t.skip('start times come from /proc')
  const startTime = readStartTime(process.pid)
  assert.match(startTime, /^\d+$/, '/proc/<pid>/stat exposes a numeric start time')
  const startedAt = Date.now()
  const result = await waitForPidExit(process.pid, 150, startTime)
  const elapsed = Date.now() - startedAt
  assert.deepEqual(result, { ok: false, timedOut: true })
  assert.ok(elapsed >= 150, `honoured the deadline (${elapsed}ms)`)
})

test('without a start time the wait falls back to kill(0) and still times out', async (t) => {
  const { child } = liveChild(10_000)
  t.after(() => child.kill('SIGKILL'))
  const result = await waitForPidExit(child.pid, 200, '')
  assert.deepEqual(result, { ok: false, timedOut: true })
})

test('a failed successor spawn clears restarting so a retry can work (A4-P2-7)', (t) => {
  const original = __test.restartHooks.spawn
  t.after(() => { __test.restartHooks.spawn = original; __test.setRestarting(false) })
  __test.restartHooks.spawn = () => { throw new Error('spawn EACCES') }
  __test.setRestarting(true)
  const child = __test.spawnRestartSuccessor(11082)
  assert.equal(child, null)
  assert.equal(__test.isRestarting(), false, 'the next POST must be able to try again')
})

test('the spawned successor carries the live port and a dying child clears restarting (A4-P2-6/A4-P2-7)', (t) => {
  const original = __test.restartHooks.spawn
  const handlers = {}
  const fake = { unref() {}, once(event, fn) { handlers[event] = fn; return this } }
  const calls = []
  t.after(() => { __test.restartHooks.spawn = original; __test.setRestarting(false) })
  __test.restartHooks.spawn = (...args) => { calls.push(args); return fake }
  __test.setRestarting(true)
  assert.equal(__test.spawnRestartSuccessor(11082), fake)
  assert.equal(__test.isRestarting(), true, 'a pending successor keeps the restart flag set')
  const argv = calls[0][1]
  assert.equal(argv[1], 'serve')
  assert.ok(argv.includes('--wait-pid'), 'the successor waits for this pid')
  assert.deepEqual(argv.slice(argv.indexOf('--port'), argv.indexOf('--port') + 2), ['--port', '11082'], 'the successor binds the port this daemon actually bound')
  handlers.error(new Error('ENOENT'))
  assert.equal(__test.isRestarting(), false, 'a spawn error must not leave the daemon marked as restarting')
  __test.setRestarting(true)
  handlers.exit(3, null)
  assert.equal(__test.isRestarting(), false, 'a successor exiting non-zero must not leave the daemon marked as restarting')
})
