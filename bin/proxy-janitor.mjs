#!/usr/bin/env node
/**
 * Detached proxy janitor.
 *
 * Started by `armJanitor()` with the pid of the dsh process that owns the proxy
 * layers. Polls that pid; when it disappears (graceful exit, crash, `kill -9`,
 * closed terminal) it performs the same cleanup the exit hook does, then exits.
 *
 * Phase 1b P6 adds a handoff window: when the owner exits on purpose to let a
 * successor daemon adopt the engine, its stop writes `handoffAt` into our state
 * file first. In that window "owner died" must not be read as "the machine is
 * free" — we wait for the successor to register itself and keep watching it
 * instead of tearing the network down.
 *
 * Nothing here needs dsh: it runs in its own session, with only the state files
 * (`proxy.pid`, `proxybridge.local.pid` / `proxybridge.windows.pid`,
 * `proxybridge-service.json`, `git-proxy.json`) as input.
 *
 * A test run must never clean the real machine: janitor.js answers "no bridge" for
 * the bridge probe when NODE_TEST_CONTEXT is set, and the layer seams keep the
 * cleanup unit-testable without PowerShell.
 *
 * Usage: proxy-janitor.mjs --owner <pid> [--home <proxy home>] [--poll <ms>]
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  JANITOR_HANDOFF_GRACE_MS,
  JANITOR_POLL_MS,
  cleanupSideEffects,
  janitorStatePath,
  pendingSideEffects,
  removeOwnJanitorState,
} from '../lib/janitor.js'

/** Parse `--flag value` pairs without pulling in a dependency. */
function parse(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      out[token.slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return out
}

const args = parse(process.argv.slice(2))
const owner = Number.parseInt(args.owner ?? '', 10)
const poll = Number.parseInt(args.poll ?? '', 10) || JANITOR_POLL_MS
const home = args.home ?? process.env.DSH_RIS_IDE_PROXY_HOME ?? '.'
const logPath = join(home, 'janitor.log')

function log(line) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  } catch {
    /* logging must never take the janitor down */
  }
}

if (!Number.isInteger(owner) || owner <= 0) {
  log('缺少 --owner <pid>，退出')
  process.exit(2)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Is the owner's exit an intentional handoff? The predecessor writes `handoffAt`
 * before exiting; only a fresh stamp counts, so a stale one cannot keep the
 * machine from being cleaned up forever.
 * @returns {number|null} absolute deadline, null when this is not a handoff.
 */
function handoffDeadline() {
  try {
    const raw = JSON.parse(readFileSync(janitorStatePath(), 'utf8'))
    const at = typeof raw.handoffAt === 'string' ? Date.parse(raw.handoffAt) : Number.NaN
    if (!Number.isFinite(at)) return null
    const age = Date.now() - at
    if (age < 0 || age >= JANITOR_HANDOFF_GRACE_MS) return null
    return at + JANITOR_HANDOFF_GRACE_MS
  } catch {
    return null
  }
}

/**
 * Wait for the successor's own registration, then report both pids: `owner` is the
 * dsh/risd process to watch next, `watcher` is the successor's own janitor.
 *
 * The field is `owner` — `armJanitor()` writes `{pid, owner, log}`. Reading
 * `ownerPid` (review B-P1-5) always produced NaN, so the handoff window expired
 * and this watcher tore down the engine the successor had just adopted.
 * @returns {Promise<{owner:number, watcher:number}|null>} pids, or null on timeout.
 */
function adoptSuccessor(previousOwner, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) {
        resolve(null)
        return
      }
      try {
        const raw = JSON.parse(readFileSync(janitorStatePath(), 'utf8'))
        const candidate = Number.isInteger(raw.owner) ? raw.owner : Number(raw.ownerPid)
        const watcher = Number.isInteger(raw.pid) ? raw.pid : 0
        if (Number.isInteger(candidate) && candidate > 0 && candidate !== previousOwner && alive(candidate)) {
          resolve({ owner: candidate, watcher })
          return
        }
      } catch {
        /* the state file may be mid-rewrite; keep waiting */
      }
      setTimeout(tick, 250)
    }
    tick()
  })
}

let watched = owner

function cleanup() {
  const pending = pendingSideEffects()
  log(`dsh ${watched} 已退出，开始清理: ${JSON.stringify(pending)}`)
  try {
    const done = cleanupSideEffects({ log })
    log(`清理完成: ${JSON.stringify({ engine: done.engine, bridge: done.bridge, service: done.service, git: done.git })}`)
  } catch (error) {
    log(`清理异常: ${error?.message ?? error}`)
  }
  try {
    // Our own state file is the last thing to go: while it exists, `yds proxy
    // status` reports a watcher, and a fresh start re-arms instead of doubling.
    // Only ours, though: a successor may already have armed a newer watcher and
    // written its own state file by now (review B-P2-9).
    removeOwnJanitorState(process.pid)
  } catch {
    /* already gone */
  }
  process.exit(0)
}

function startWatch() {
  log(`监视 dsh ${watched}（轮询 ${poll}ms，状态 ${janitorStatePath()}）`)
  // The interval must stay referenced: an unreferenced timer lets node exit
  // immediately, which is the opposite of a watchdog.
  const timer = setInterval(async () => {
    if (alive(watched)) return
    clearInterval(timer)
    const deadline = handoffDeadline()
    if (deadline !== null) {
      log(`dsh ${watched} 已退出，处于交接窗口（剩余 ${Math.max(0, deadline - Date.now())}ms），等待继任者`)
      const successor = await adoptSuccessor(watched, deadline)
      if (successor !== null) {
        // The successor armed its own watcher (it wrote the state file we just
        // read): hand over and exit, so repeated handoffs do not accumulate
        // watchers. If it failed to arm, keep watching on its behalf.
        if (successor.watcher > 0 && successor.watcher !== process.pid && alive(successor.watcher)) {
          log(`继任者 ${successor.owner} 已接管（其 janitor pid ${successor.watcher}），本守护退出`)
          process.exit(0)
        }
        watched = successor.owner
        startWatch()
        return
      }
      log('交接窗口内没有继任者，按原逻辑清理')
    }
    cleanup()
  })
}

startWatch()
