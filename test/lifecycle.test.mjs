/**
 * Child services (the detached proxy engine, the janitor, the git proxy) belong to
 * the PROCESS, not to one plugin effect.
 *
 * dsh disposes the fiber tree and only then calls `process.exit()`, so the teardown
 * must not remove the exit listener or disarm the janitor: doing either was the
 * Ctrl+C leak — the process exited with nobody left to stop the engine, and the
 * detached engine kept routing traffic with no UI to turn it off. These tests pin
 * the contract: a disposed plugin leaves both guards armed, and a profile hot reload
 * neither stacks exit listeners nor leaves the heartbeat dead.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'ris-lifecycle-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { apply, __test } = await import('../lib/index.js')
const { janitorStatePath, janitorStatus, disarmJanitor } = await import('../lib/janitor.js')
const { heartbeatPath } = await import('../lib/redirector.js')

/**
 * The smallest host context `apply()` touches: an effect registry that can run the
 * disposers in reverse (what dsh's fiber dispose does), plus no-op route/tool tables.
 * @returns {object} the fake ctx.
 */
function fakeCtx() {
  const disposers = []
  return {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: { register: () => () => {} },
    tools: { register: () => {} },
    logger: { warn: () => {} },
    dispose() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

after(() => {
  // The plugin deliberately does NOT disarm on teardown, so the test must.
  disarmJanitor()
  rmSync(home, { recursive: true, force: true })
})

test('a disposed plugin keeps the exit hook and the watcher armed', () => {
  const before = process.listenerCount('exit')
  const ctx = fakeCtx()
  apply(ctx, { daemonMode: 'off' })
  assert.ok(process.listenerCount('exit') > before, 'apply must install the exit hook')
  const armed = janitorStatus()
  assert.equal(armed.running, true, 'apply must arm the janitor')
  assert.equal(armed.owner, process.pid)
  assert.equal(existsSync(heartbeatPath()), true, 'apply must write the watchdog heartbeat')

  ctx.dispose()
  // The bug: the teardown removed both guards, so process.exit() had no listener to
  // run and the detached engine survived.
  assert.ok(process.listenerCount('exit') > before, 'cleanup must NOT remove the exit hook')
  assert.equal(existsSync(janitorStatePath()), true, 'cleanup must NOT disarm the watcher')
  assert.equal(janitorStatus().running, true, 'the watcher itself keeps running')

  const installed = process.listenerCount('exit')
  // Re-applying (a profile hot reload runs every effect again) reuses the hook.
  const reload = fakeCtx()
  apply(reload, { daemonMode: 'off' })
  assert.equal(process.listenerCount('exit'), installed, 'a hot reload must not stack exit hooks')
  assert.equal(existsSync(heartbeatPath()), true, 'the heartbeat is rebuilt after the teardown stopped it')
  reload.dispose()
  assert.equal(process.listenerCount('exit'), installed, 'a reload teardown still leaves the hook')
  assert.equal(existsSync(janitorStatePath()), true)
})

test('three apply/dispose cycles add no exit listeners at all', () => {
  const before = process.listenerCount('exit')
  for (let index = 0; index < 3; index += 1) {
    const ctx = fakeCtx()
    apply(ctx, { daemonMode: 'off' })
    ctx.dispose()
  }
  assert.equal(process.listenerCount('exit'), before)
})

test('a failed heartbeat write warns once instead of failing silently', () => {
  const warns = []
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  // A regular file where a directory is expected makes mkdir() fail fast (ENOTDIR),
  // so writeHeartbeat() reports false — the same code path as a read-only home.
  const blocker = join(home, 'heartbeat-blocker')
  writeFileSync(blocker, 'not a directory\n')
  process.env.DSH_RIS_IDE_PROXY_HOME = join(blocker, 'home')
  let beat = null
  try {
    beat = __test.startHeartbeat({ warn: (message) => warns.push(message) })
  } finally {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
  }
  if (beat !== null) clearInterval(beat)
  assert.equal(warns.length, 1, 'the first failed write warns exactly once')
  assert.match(warns[0], /心跳写入失败/)
  assert.match(warns[0], /20s/)
})
