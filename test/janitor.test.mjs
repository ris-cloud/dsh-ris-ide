/**
 * The janitor is the only thing that stops the proxy layers when dsh itself is
 * killed (no `exit` listener runs on SIGKILL). These tests drive it against a
 * temp proxy home and a throwaway "owner" process, so nothing real is touched.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { serviceStatePath, writeWindowsServiceState } from '../lib/redirector.js'

const home = mkdtempSync(join(tmpdir(), 'janitor-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const {
  armJanitor,
  cleanupSideEffects,
  disarmJanitor,
  janitorStatePath,
  janitorStatus,
  pendingSideEffects,
  removeOwnJanitorState,
} = await import('../lib/janitor.js')

/** A process that stays alive until we kill it (stands in for dsh). */
function fakeOwner() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  return child
}

function waitFor(predicate, { attempts = 80, interval = 100 } = {}) {
  return new Promise((resolve) => {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (predicate() || tries >= attempts) {
        clearInterval(timer)
        resolve(predicate())
      }
    }, interval)
  })
}

test('nothing is armed until a watcher is started', () => {
  assert.equal(janitorStatus().running, false)
  assert.equal(existsSync(janitorStatePath()), false)
  // With no pid files there is nothing to clean: cleanup must be a cheap no-op.
  assert.deepEqual(pendingSideEffects(), { bridge: false, engine: false, service: false, git: false })
  const done = cleanupSideEffects()
  assert.equal(done.engine, false)
  assert.equal(done.bridge, false)
  assert.equal(done.service, false)
  assert.equal(done.git, false)
})

test('the bridge probe is detection-based, not "our pid file exists" (B5)', () => {
  // A bridge the user started by hand has no pid file of ours; the old pending
  // list said "nothing to do" and left it intercepting after dsh died.
  assert.equal(pendingSideEffects({ detect: () => true }).bridge, true)
  assert.equal(pendingSideEffects({ detect: () => false }).bridge, false)
  const done = cleanupSideEffects({
    detect: () => true,
    stopBridge: () => ({ stopped: true, pid: 111 }),
    restore: () => ({ restored: false, reason: '未停止过服务' }),
  })
  assert.equal(done.bridge, true)
  assert.match(done.log.join('\n'), /bridge: 已停止 pid=111/)
})

test('a failed bridge stop says why instead of looking clean (B5)', () => {
  const done = cleanupSideEffects({
    detect: () => true,
    stopBridge: () => ({ stopped: false, reason: '需要 sudo kill 42' }),
    restore: () => ({ restored: false, reason: '未停止过服务' }),
  })
  assert.equal(done.bridge, false)
  assert.match(done.log.join('\n'), /未停止（需要 sudo kill 42）/)
})

test('the parked service is recognised at the canonical path and restored (B2)', () => {
  // The writer used <proxy home>/proxybridge/, janitor read <proxy home>/: the two
  // never met, so ProxyBridgeSvc stayed parked on Manual after every crash.
  writeWindowsServiceState({ stoppedByUs: true, originalStartType: 'Automatic', parkedOnManual: true })
  try {
    assert.equal(existsSync(serviceStatePath()), true)
    assert.equal(pendingSideEffects().service, true, 'janitor must see the same file the writer wrote')
    const done = cleanupSideEffects({
      detect: () => false,
      stopBridge: () => ({ stopped: false, reason: '未运行' }),
      // restoreWindowsService answers {restored:true}; reading `.ok` made a real
      // recovery look like a failure (and undefined look like success).
      restore: () => ({ restored: true }),
    })
    assert.equal(done.service, true)
    assert.match(done.log.join('\n'), /service: 已恢复启动方式/)
  } finally {
    rmSync(serviceStatePath(), { force: true })
    rmSync(join(home, 'proxybridge-service.json'), { force: true })
  }
})

test('arming spawns a detached watcher that records its owner, and disarming stops it', async () => {
  const owner = fakeOwner()
  try {
    const armed = armJanitor({ ownerPid: owner.pid })
    assert.equal(armed.armed, true, armed.reason)
    assert.notEqual(armed.pid, owner.pid, 'the watcher must be its own process')

    const status = janitorStatus()
    assert.equal(status.running, true)
    assert.equal(status.owner, owner.pid)

    // Arming twice for the same owner is idempotent (a reload must not stack them).
    const again = armJanitor({ ownerPid: owner.pid })
    assert.equal(again.pid, armed.pid)

    const stopped = disarmJanitor()
    assert.equal(stopped.stopped, true)
    assert.equal(janitorStatus().running, false)
    assert.equal(existsSync(janitorStatePath()), false)
  } finally {
    owner.kill('SIGKILL')
    disarmJanitor()
  }
})

test('the watcher cleans up and exits once its owner is gone', async () => {
  const owner = fakeOwner()
  const armed = armJanitor({ ownerPid: owner.pid })
  assert.equal(armed.armed, true, armed.reason)

  owner.kill('SIGKILL')
  const cleaned = await waitFor(() => existsSync(janitorStatePath()) === false, { attempts: 120, interval: 100 })
  assert.equal(cleaned, true, 'the state file must be removed by the exiting watcher')

  const logPath = join(home, 'janitor.log')
  assert.equal(existsSync(logPath), true)
  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /监视 dsh \d+/)
  assert.match(log, /已退出，开始清理/)
  assert.match(log, /清理完成/)
})

test('disarming never signals a stranger that inherited the watcher pid (B-P2-9)', async () => {
  const stranger = fakeOwner()
  try {
    writeFileSync(janitorStatePath(), `${JSON.stringify({ pid: stranger.pid, owner: 12345, log: '' })}\n`, { mode: 0o600 })
    const result = disarmJanitor()
    assert.equal(result.stopped, false, 'a pid that is not a proxy-janitor is left alone')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(stranger.exitCode, null, 'the unrelated process is still running')
    assert.equal(existsSync(janitorStatePath()), false, 'the stale state file is still removed')
  } finally {
    stranger.kill('SIGKILL')
    rmSync(janitorStatePath(), { force: true })
  }
})

test('the watcher only removes a state file it wrote itself (B-P2-9)', () => {
  writeFileSync(janitorStatePath(), `${JSON.stringify({ pid: 424242, owner: 1, log: '' })}\n`, { mode: 0o600 })
  try {
    assert.equal(removeOwnJanitorState(999), false)
    assert.equal(existsSync(janitorStatePath()), true, 'a successor watcher file is not deleted')
    assert.equal(removeOwnJanitorState(424242), true)
    assert.equal(existsSync(janitorStatePath()), false)
  } finally {
    rmSync(janitorStatePath(), { force: true })
  }
})
