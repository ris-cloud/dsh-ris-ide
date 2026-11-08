#!/usr/bin/env node
/**
 * Detached proxy janitor.
 *
 * Started by `armJanitor()` with the pid of the dsh process that owns the proxy
 * layers. Polls that pid; when it disappears (graceful exit, crash, `kill -9`,
 * closed terminal) it performs the same cleanup the exit hook does, then exits.
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
import { appendFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { JANITOR_POLL_MS, cleanupSideEffects, janitorStatePath, pendingSideEffects } from '../lib/janitor.js'

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
const logPath = join(args.home ?? process.env.DSH_RIS_IDE_PROXY_HOME ?? '.', 'janitor.log')

function log(line) {
  try {
    mkdirSync(join(args.home ?? process.env.DSH_RIS_IDE_PROXY_HOME ?? '.'), { recursive: true })
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

log(`监视 dsh ${owner}（轮询 ${poll}ms，状态 ${janitorStatePath()}）`)

const timer = setInterval(() => {
  if (alive(owner)) return
  clearInterval(timer)
  const pending = pendingSideEffects()
  log(`dsh ${owner} 已退出，开始清理: ${JSON.stringify(pending)}`)
  try {
    const done = cleanupSideEffects({ log })
    log(`清理完成: ${JSON.stringify({ engine: done.engine, bridge: done.bridge, service: done.service, git: done.git })}`)
  } catch (error) {
    log(`清理异常: ${error?.message ?? error}`)
  }
  try {
    // Our own state file is the last thing to go: while it exists, `yds proxy
    // status` reports a watcher, and a fresh start re-arms instead of doubling.
    unlinkSync(janitorStatePath())
  } catch {
    /* already gone */
  }
  process.exit(0)
  // The interval must stay referenced: an unreferenced timer lets node exit
  // immediately, which is the opposite of a watchdog.
})
