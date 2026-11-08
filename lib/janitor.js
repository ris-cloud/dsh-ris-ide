/**
 * Janitor: make sure the proxy layers die with dsh, even when dsh does not.
 *
 * The engine is a detached child and the ProxyBridge bridge runs outside our
 * process tree (its Windows side is a separate elevated process), so nothing
 * stops them when dsh is killed with SIGKILL, crashes, or the terminal is closed.
 * A plain `process.on('exit')` hook covers the graceful cases only.
 *
 * So we arm a tiny detached watcher that polls the owning dsh pid and, once it
 * is gone, performs the same cleanup the exit hook does: stop the engine, stop
 * the bridge, put the Windows service back, drop the git proxy entries, remove
 * the pid files. It is spawned detached (own session) so it outlives dsh, and it
 * only touches state that actually exists, so an idle session leaves nothing
 * behind to clean.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROXY_MARKER,
  proxyHomeDir,
  proxyPidPath,
  proxyLogPath,
  readTail,
  runWindowsGitConfig,
  stopProxySync,
  windowsGitPath,
} from './proxy.js'
import {
  detectRunningRedirector,
  legacyServiceStatePath,
  restoreWindowsService,
  serviceStatePath,
  stopRedirectorSync,
} from './redirector.js'

/** File holding the janitor's own pid + the dsh pid it watches. */
export const JANITOR_STATE_FILENAME = 'proxy-janitor.json'

/** How often the watcher asks whether its owner is still alive. */
export const JANITOR_POLL_MS = 3000

/** State files that mean "something of ours is running". */
const ENGINE_PID = () => proxyPidPath()
const GIT_STATE = () => join(proxyHomeDir(), 'git-proxy.json')

/** True when a parked-service state file exists at either the canonical or old path. */
function hasServiceState() {
  return existsSync(serviceStatePath()) || existsSync(legacyServiceStatePath())
}

/**
 * Is a bridge running (any side, tracked or hand-started)?
 *
 * A test run must never touch the real machine — a Windows CI box may well have a
 * real ProxyBridge_CLI running, and "clean up" would kill it. `detect` lets a test
 * state the answer, and without the seam a test context answers "nothing running"
 * (the machine is not this test's property).
 * @param {Function} [detect] - override.
 * @returns {boolean} whether bridge cleanup is due.
 */
function bridgeRunning(detect) {
  if (typeof detect === 'function') return detect() === true
  if (process.env.NODE_TEST_CONTEXT !== undefined) return false
  try {
    return detectRunningRedirector().pid > 0
  } catch {
    return false
  }
}

/** @returns {string} absolute path of the janitor state file. */
export function janitorStatePath() {
  return join(proxyHomeDir(), JANITOR_STATE_FILENAME)
}

/** The script this module spawns (kept next to bin/, so installs and links agree). */
function janitorScript() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'proxy-janitor.mjs')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * What the janitor would clean right now (also used to decide whether it is worth
 * starting one at all).
 * @param {{detect?: Function}} [options] - test seam for the bridge probe.
 * @returns {{engine: boolean, bridge: boolean, service: boolean, git: boolean}} per-layer state.
 */
export function pendingSideEffects(options = {}) {
  return {
    engine: existsSync(ENGINE_PID()),
    // Detection, not just our pid file: a hand-started bridge keeps intercepting
    // after its record is gone, so it must still be cleaned up (B5).
    bridge: bridgeRunning(options.detect),
    service: hasServiceState(),
    git: existsSync(GIT_STATE()),
  }
}

/**
 * Stop everything we may have started, the same way the exit hook does.
 *
 * Safe to call when nothing runs: every step is guarded by its own state file.
 * @param {{log?: Function, detect?: Function, stopBridge?: Function, restore?: Function}} [options] - logger and test seams.
 * @returns {{engine: boolean, bridge: boolean, service: boolean, git: boolean, log: string[]}}
 */
export function cleanupSideEffects({ log, detect, stopBridge, restore } = {}) {
  const done = { engine: false, bridge: false, service: false, git: false, log: [] }
  const say = (line) => {
    done.log.push(line)
    log?.(line)
  }
  const restoreService = typeof restore === 'function' ? restore : restoreWindowsService
  const stopBridgeNow = typeof stopBridge === 'function' ? stopBridge : stopRedirectorSync

  // Engine: pid file + identity check happen inside stopProxySync.
  if (existsSync(ENGINE_PID())) {
    done.engine = stopProxySync() === true
    say(`engine: ${done.engine ? '已停止' : '未运行/未停止'}`)
  }

  // Bridge (ProxyBridge CLI on either side) + the Windows service we parked.
  const bridgeDue = bridgeRunning(detect)
  const serviceDue = hasServiceState()
  if (bridgeDue) {
    try {
      const stopped = stopBridgeNow()
      done.bridge = stopped?.stopped === true
      say(`bridge: ${done.bridge ? `已停止 pid=${stopped.pid}` : `未停止（${stopped?.reason ?? '未知原因'}）`}`)
    } catch (error) {
      say(`bridge: 停止失败（${error?.message ?? error}）`)
    }
  }
  if (serviceDue) {
    const restored = restoreService()
    // restoreWindowsService answers `{restored:true}` — the old check read `.ok`,
    // which never exists, so a recovered service was reported as failed (or worse,
    // a failed one as fine when both were undefined).
    done.service = restored?.restored === true
    say(`service: ${done.service ? '已恢复启动方式' : (restored?.reason ?? '未恢复')}`)
  }

  // git: undo exactly the entries we wrote, on both sides.
  const gitState = readJson(GIT_STATE())
  if (gitState !== null) {
    const key = typeof gitState.key === 'string' ? gitState.key : ''
    if (key !== '') {
      for (const args of [['--global', '--unset', key]]) {
        try {
          spawnSyncGit(args)
        } catch (error) {
          say(`git: 清理失败（${error?.message ?? error}）`)
        }
      }
      const winGit = windowsGitPath()
      if (winGit !== '') {
        try {
          runWindowsGitConfig(['--global', '--unset', key])
        } catch {
          /* Windows side is best effort: no git / no rights */
        }
      }
      done.git = true
      say(`git: 已清除 ${key}`)
    }
    removeQuietly(GIT_STATE())
  }
  return done
}

function spawnSyncGit(args) {
  const result = spawnSync('git', ['config', ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (result?.status !== 0 && result?.status !== undefined) {
    throw new Error((result.stderr ?? '').trim().slice(0, 160) || `git config ${args.join(' ')} 失败`)
  }
}

/**
 * Arm (or re-arm) the watcher for this dsh process.
 *
 * Idempotent per owner: an existing watcher whose owner is the same process is
 * left alone, one watching a dead process is replaced.
 * @param {{ownerPid?: number}} [options] - defaults to the current process.
 * @returns {{armed: boolean, pid: number, owner: number, reason?: string}} state.
 */
export function armJanitor(options = {}) {
  const owner = Number.isInteger(options.ownerPid) ? options.ownerPid : process.pid
  const existing = janitorStatus()
  if (existing.running === true && existing.owner === owner) {
    return { armed: true, pid: existing.pid, owner, reason: '已在运行' }
  }
  if (existing.running === true) disarmJanitor()

  const script = janitorScript()
  if (!existsSync(script)) return { armed: false, pid: 0, owner, reason: `找不到 ${script}` }
  try {
    mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, [script, '--owner', String(owner), '--home', proxyHomeDir()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const state = { pid: child.pid, owner, log: join(proxyHomeDir(), 'janitor.log') }
    writeFileSync(janitorStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    return { armed: true, pid: child.pid, owner }
  } catch (error) {
    return { armed: false, pid: 0, owner, reason: error?.message ?? String(error) }
  }
}

/**
 * Stop the watcher (graceful shutdown: the host cleans up itself).
 * @returns {{stopped: boolean, pid: number}} outcome.
 */
export function disarmJanitor() {
  const state = readJson(janitorStatePath())
  const pid = Number.isInteger(state?.pid) ? state.pid : 0
  let stopped = false
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
      stopped = true
    } catch {
      stopped = false
    }
  }
  removeQuietly(janitorStatePath())
  return { stopped, pid }
}

/**
 * @returns {{running: boolean, pid: number, owner: number, log: string}} watcher state.
 */
export function janitorStatus() {
  const state = readJson(janitorStatePath())
  const pid = Number.isInteger(state?.pid) ? state.pid : 0
  const owner = Number.isInteger(state?.owner) ? state.owner : 0
  const running = pid > 0 && pidAlive(pid)
  return { running, pid, owner, log: typeof state?.log === 'string' ? state.log : '' }
}

/** One line for the dialog / `yds proxy status`. */
export function describeJanitor() {
  const status = janitorStatus()
  if (status.running !== true) return '守护进程: 未运行'
  return `守护进程: 运行中（pid ${status.pid}，监视 dsh ${status.owner}）`
}

/** Exported for the watching script: tail of the last engine log, for diagnostics. */
export function janitorDiagnostics() {
  return {
    marker: PROXY_MARKER,
    engineLog: readTail(proxyLogPath(), 2048),
    state: janitorStatus(),
  }
}
