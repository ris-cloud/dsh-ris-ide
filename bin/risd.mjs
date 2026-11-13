#!/usr/bin/env node
/**
 * risd — command line.
 *
 *   risd serve   [--home <dir>] [--port <n>]   run the daemon (the only mode that listens)
 *   risd status  [--home <dir>]                print the stored state + a health probe
 *   risd health  [--home <dir>]                print the health JSON (for scripts)
 *   risd stop    [--home <dir>] [--handoff]    ask a running daemon to exit
 *                                              (--handoff keeps the engine for a successor)
 *   risd version                                print daemon + api version
 *
 * Exit codes for `serve` (what the plugin's spawn path distinguishes):
 *   0  started, or another daemon already owns the port
 *   3  another process speaks a different `/v1` version -> upgrade required
 *   4  the port is occupied by something that is not risd
 *   1  anything else (bad args, state could not be written)
 *
 * Kept deliberately thin: all behaviour lives in `lib/risd/*` so it is testable
 * without spawning a process (the tests do both).
 *
 * @module dsh-risd/cli
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_RISD_PORT, RISD_API_VERSION, risdHomeDir, risdStatePath, readRisdState, dropStaleSpawnLock } from '../lib/risd/state.js'
import { pidAlive } from '../lib/proxy.js'
import { createRisdLogger, risdLogPath } from '../lib/risd/log.js'
import { probeRisdHealth, startRisd, waitForPidExit } from '../lib/risd/server.js'

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

function parseArgs(argv) {
  const options = { command: 'status', home: undefined, port: undefined }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--home' || arg === '-C') options.home = argv[++index]
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else if (arg === '--handoff') options.handoff = true
    // m11421: successor started by POST /v1/restart — wait for the predecessor to
    // exit so the port is free and the handoff stamp is on disk.
    else if (arg === '--wait-pid') options.waitPid = Number(argv[++index])
    // m13598: identity of that pid (Linux start time), so a reused pid is not waited
    // on for the full 20 s (review A4-P2-5). Internal parameter: only the successor
    // spawned by `POST /v1/restart` passes it, not the user-facing CLI.
    else if (arg === '--wait-start') options.waitStart = String(argv[++index] ?? '')
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++index])
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else rest.push(arg)
  }
  if (rest.length > 0) options.command = rest[0]
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error(`invalid --port: ${options.port}`)
  }
  if (options.waitPid !== undefined && (!Number.isInteger(options.waitPid) || options.waitPid <= 0)) {
    throw new Error(`invalid --wait-pid: ${options.waitPid}`)
  }
  if (options.waitStart !== undefined && !/^\d+$/.test(options.waitStart)) {
    throw new Error(`invalid --wait-start: ${options.waitStart}`)
  }
  return options
}

function line(text) {
  process.stdout.write(`${text}\n`)
}

async function request(state, path, { method = 'GET', body = undefined, timeoutMs = 2000 } = {}) {
  const response = await fetch(`${state.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-risd-api-version': String(RISD_API_VERSION),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, code: 'bad-response', message: text.slice(0, 200) }
  }
  return { status: response.status, payload }
}

async function serve(options) {
  // Never assign `undefined` to process.env: it becomes the string "undefined",
  // which then resolves every machine-level file (state, token, heartbeat) under
  // `<cwd>/undefined/`. `risdHomeDir()` falls back to the real proxy home.
  const home = risdHomeDir(options.home)
  // A successor spawned by POST /v1/restart must not treat the dying predecessor as
  // "already running": wait until its pid is gone, then serve (m11421).
  if (options.waitPid !== undefined) {
    const wait = await waitForPidExit(options.waitPid, 20000, options.waitStart ?? '')
    // Not fatal: the predecessor may be stuck in teardown; bind anyway and let the
    // already-running election decide (review A4-P2-5 / lead decision E).
    if (wait.timedOut === true) process.stderr.write(`risd: predecessor ${options.waitPid} did not exit within 20s; continuing\n`)
  }
  // Heartbeat, janitor state and the git-proxy entry all resolve through the
  // machine-level home; a daemon started for a test home must not touch the real
  // one, and the plugin always points at the same home it reads `risd.json` from.
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const logger = createRisdLogger(home)
  logger.info(`starting: pid=${process.pid} version=${PACKAGE_VERSION}`)
  dropStaleSpawnLock(home)
  let stopping = false
  let current = null
  const stop = async (code, handoff = false) => {
    if (stopping) return
    stopping = true
    logger.info(handoff ? 'stopping: handoff requested' : 'stopping: shutdown requested')
    try {
      await current?.stop({ handoff })
    } finally {
      process.exit(code)
    }
  }
  const envPort = Number(process.env.DSH_RISD_PORT)
  const port = options.port ?? (Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_RISD_PORT)
  const started = await startRisd({
    home,
    port,
    version: PACKAGE_VERSION,
    onShutdown: (handoff) => stop(0, handoff === true),
  })
  if (!started.ok) {
    if (started.code === 'already-running') {
      logger.info(`already running: pid=${started.pid} port=${started.port}`)
      process.stderr.write(`risd: already running (pid ${started.pid}) on 127.0.0.1:${started.port}\n`)
      process.exit(0)
    }
    if (started.code === 'api-mismatch') {
      logger.warn(`api mismatch: found ${started.found} on port ${started.port}`)
      process.stderr.write(`risd: a daemon with apiVersion ${started.found} is running on 127.0.0.1:${started.port}; this build speaks ${RISD_API_VERSION} (upgrade required)\n`)
      process.exit(3)
    }
    if (started.code === 'home-mismatch') {
      // Two homes on one port cannot both own the state file; the healthy daemon
      // wins and this one explains how to run alongside it (review A-P2-9).
      logger.warn(`home mismatch: ${started.found} already owns port ${started.port}`)
      process.stderr.write(
        `risd: 127.0.0.1:${started.port} is already served by the daemon whose home is ${started.found};\n` +
          `  this process wants home ${started.home}. Stop that daemon or run with --port <n>.\n`,
      )
      process.exit(4)
    }
    if (started.code === 'port-busy') {
      logger.warn(`port busy: ${started.port} is not risd`)
      process.stderr.write(
        `risd: 127.0.0.1:${started.port} is occupied by a process that is not risd.\n` +
          `  stop it, or pick another port (risd serve --port <n>, DSH_RISD_PORT, or daemonMode stays off)\n`,
      )
      process.exit(4)
    }
    logger.error(`start failed: ${started.code} ${started.error?.message ?? ''}`)
    process.stderr.write(`risd: could not start (${started.code}): ${started.error?.message ?? ''}\n`)
    process.exit(1)
  }
  current = started
  logger.info(`ready: port=${started.port} state=${risdStatePath(home)}`)
  process.stderr.write(`risd: listening on http://127.0.0.1:${started.port} (pid ${process.pid})\n`)
  process.stderr.write(`risd: maintenance page http://127.0.0.1:${started.port}/ui  (engine/programs/logs/debug, no dsh needed)\n`)
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => void stop(0))
  }
}

async function status(options) {
  const state = readRisdState(options.home)
  if (state === null) {
    line('risd: not running (no risd.json)')
    line('hint: run `risd serve` to start it (clicking ⧉ in dsh also starts it)')
    return 1
  }
  const probe = await probeRisdHealth(state.port, 1000)
  line(`risd: ${probe?.ok === true ? 'running' : 'unreachable'}`)
  if (probe?.ok !== true) line('hint: the state file is stale; run `risd serve` to restart (clicking ⧉ in dsh also starts it)')
  line(`  pid       ${state.pid}`)
  line(`  port      ${state.port}`)
  line(`  api       ${state.apiVersion} (this CLI speaks ${RISD_API_VERSION})`)
  line(`  version   ${state.version}`)
  line(`  startedAt ${state.startedAt}`)
  line(`  home      ${state.home}`)
  line(`  log       ${risdLogPath(options.home)}`)
  line(`  page      http://127.0.0.1:${state.port}/ui`)
  return probe?.ok === true ? 0 : 1
}

async function health(options) {
  const state = readRisdState(options.home)
  if (state === null) {
    process.stderr.write('risd: not running (no risd.json)\n')
    process.stderr.write('hint: run `risd serve` to start it (clicking ⧉ in dsh also starts it)\n')
    return 1
  }
  const { status: code, payload } = await request(state, '/v1/health', { timeoutMs: 1000 }).catch((error) => ({
    status: 0,
    payload: { ok: false, code: 'unreachable', message: String(error?.message ?? error) },
  }))
  line(JSON.stringify(payload, null, 2))
  return code === 200 ? 0 : 1
}

async function stop(options) {
  const state = readRisdState(options.home)
  if (state === null) {
    line('risd: not running (no risd.json)')
    return 0
  }
  const handoff = options.handoff === true
  const { status: code, payload } = await request(state, '/v1/shutdown', { method: 'POST', body: { reason: 'cli', handoff } }).catch((error) => ({
    status: 0,
    payload: { ok: false, code: 'unreachable', message: String(error?.message ?? error) },
  }))
  if (code !== 200) {
    line(`risd: shutdown failed (${code}): ${payload?.message ?? payload?.code ?? 'unknown'}`)
    return 1
  }
  if (handoff) {
    // A handoff keeps risd.json on purpose (the successor reads it). Wait for the
    // pid to change instead of for the file to disappear, so "handed off" only
    // means success once somebody actually took over (review A-P2-7).
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const next = readRisdState(options.home)
      if (next !== null && Number(next.pid) !== Number(state.pid) && pidAlive(next.pid)) {
        line(`risd: handed off to pid ${next.pid}`)
        return 0
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    line('risd: handed off, but no successor picked it up yet (the janitor keeps the engine)')
    return 1
  }
  // 10 s: shutdown stops supervised programs first and then the network layers, so
  // a busy machine can legitimately need more than the old 5 s (and the generic
  // "still running" answer made `risd stop` look broken).
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // `state` may be rewritten by a successor; the pid, not the file, says whether
    // OUR daemon is gone (review A-P2-7).
    if (!pidAlive(state.pid)) {
      line('risd: stopped')
      return 0
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  line('risd: shutdown accepted but the daemon is still running')
  return 1
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`risd: ${error.message}\n`)
    process.exit(1)
  }
  if (options.command === 'version' || options.command === '--version') {
    line(`risd ${PACKAGE_VERSION} (apiVersion ${RISD_API_VERSION})`)
    return 0
  }
  if (options.command === 'serve') {
    await serve(options)
    return 0
  }
  if (options.command === 'status') return status(options)
  if (options.command === 'health') return health(options)
  if (options.command === 'stop') return stop(options)
  process.stderr.write(`risd: unknown command "${options.command}" (serve|status|health|stop|version)\n`)
  return 1
}

main().then((code) => {
  process.exitCode = typeof code === 'number' ? code : 0
})
