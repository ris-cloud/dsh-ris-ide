// JDWP debug sessions owned by the daemon (Phase 2-lite P3).
//
// Why the daemon and not the plugin: a JDWP session is a single socket to one JVM —
// two dsh windows cannot both attach, and a plugin restart (page reload, dsh restart)
// must not drop a paused service. So the session lives next to the supervisor:
// start-with-JDWP, breakpoints, threads/frames/variables, stepping are daemon state.
//
// What is deliberately NOT here: the panel UI (stepping buttons, gutter dots) stays
// in the plugin, which reads this state. Breakpoints survive a daemon restart by
// being written to `risd-debug.json` and restored as *pending* breakpoints (they are
// installed once the JVM connects again, exactly like a gutter click on a stopped
// program). An attached socket cannot survive, and is not pretended to.
//
// Ownership: the daemon may host sessions for several dsh windows, so the first
// window to `start` a program owns it. Reads are shared; mutating actions from any
// other window get `debug-owned` (409) instead of silently stepping someone else's
// paused thread.
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  SUSPEND_POLICIES,
  allocateDebugPort,
  createDebugSessions,
  DebugError,
  waitForJdwpListening,
} from '../debug/engine.js'
import { findProgram, listPrograms, logsDirFor } from './programs.js'
import { startProgram, stopLogPath } from '../index.js'
import { pidAlive } from '../proxy.js'

/** File holding breakpoints across daemon restarts. */
export const DEBUG_STATE_FILENAME = 'risd-debug.json'
/** How long a JDWP attach may wait for the JVM's "Listening for transport" line. */
export const DEBUG_ATTACH_TIMEOUT_MS = 90_000

const DEFAULT_OWNER = ''

/**
 * Keep only the fields we wrote ourselves: a hand-edited or half-written file must
 * never inject a bogus port/pid into the page.
 * @param value - candidate `session` value from risd-debug.json.
 * @returns `{ logPath, port, pid, startedAt }` or null.
 */
function normalizeSession(value) {
  if (value === null || typeof value !== 'object') return null
  const logPath = typeof value.logPath === 'string' ? value.logPath : ''
  const port = Number(value.port)
  const pid = Number(value.pid)
  const startedAt = typeof value.startedAt === 'string' ? value.startedAt : ''
  if (logPath === '' || !Number.isInteger(port) || port <= 0) return null
  return { logPath, port, pid: Number.isInteger(pid) && pid > 0 ? pid : 0, startedAt }
}

/**
 * Read the persisted breakpoint sets and known JDWP addresses.
 * @param home - risd home directory.
 * @returns `{ version, breakpoints, sessions }` (empty on a missing/corrupt file).
 */
export function readDebugState(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, DEBUG_STATE_FILENAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
      return { version: 1, breakpoints: {}, sessions: [] }
    }
    const breakpoints = parsed.breakpoints !== null && typeof parsed.breakpoints === 'object' ? parsed.breakpoints : {}
    // `session` (single) is the first release of this field; accept it so an
    // upgraded daemon does not forget an address written by an older one.
    const raw = Array.isArray(parsed.sessions) ? parsed.sessions : (parsed.session !== undefined ? [parsed.session] : [])
    const sessions = raw.map(normalizeSession).filter((entry) => entry !== null)
    return { version: 1, breakpoints, sessions }
  } catch {
    return { version: 1, breakpoints: {}, sessions: [] }
  }
}

/** Atomically write the persisted breakpoint sets (0600 in a 0700 home). */
export function writeDebugState(home, state) {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const target = join(home, DEBUG_STATE_FILENAME)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, target)
  } catch {
    // Debugging must keep working even when the home is read-only.
  }
}

/** Forget every persisted breakpoint (used by `clear` when no session exists). */
export function removeDebugState(home) {
  try {
    rmSync(join(home, DEBUG_STATE_FILENAME), { force: true })
  } catch {
    // best effort
  }
}

function policyOf(value) {
  return SUSPEND_POLICIES.has(value) ? value : 'thread'
}

/**
 * Create the daemon-side debug owner.
 * @param options - `{ home, clientFactory?, startProgram?, stopProgram?, waitListening?, attachTimeoutMs? }`
 *   (tests inject a fake JDWP client and fake start/stop so no JVM is needed).
 * @returns the state used by the HTTP layer and the plugin.
 */
export function createDebugEngine(options = {}) {
  const home = options.home
  const sessions = createDebugSessions({ clientFactory: options.clientFactory })
  const startProgramImpl = options.startProgram ?? startProgram
  const stopProgramImpl = options.stopProgram ?? stopLogPath
  const waitListening = options.waitListening ?? waitForJdwpListening
  const attachTimeoutMs = Number.isFinite(options.attachTimeoutMs) ? options.attachTimeoutMs : DEBUG_ATTACH_TIMEOUT_MS
  /** logPath → sessionId of the window that started the session. */
  const owners = new Map()
  /** logPaths whose breakpoint set must be persisted. */
  const known = new Set()
  /** logPath → {cwd,id,name,kind} of the program behind a session (for the page). */
  const programIndex = new Map()

  // Restore: everything we knew becomes a *pending* breakpoint, which is installed
  // by the next `start` (same path as a gutter click on a stopped program).
  const restored = readDebugState(home)
  for (const [logPath, list] of Object.entries(restored.breakpoints)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const line = Number(entry.line)
      if (typeof entry.className !== 'string' || !Number.isInteger(line) || line <= 0) continue
      sessions.addBreakpoint(logPath, entry.className, line, policyOf(entry.suspendPolicy)).catch(() => {})
      known.add(logPath)
    }
  }

  // A JDWP socket dies with the daemon but the JVM it attached to does not, so a
  // SIGKILLed daemon leaves a JVM listening on a random port that nothing knows
  // about. Record the session's address/pid and let a new daemon report it as
  // stale instead of forgetting it (review B-P2-13).
  const sessionRecords = new Map()
  for (const record of restored.sessions) {
    if (record.pid > 0 && pidAlive(record.pid) !== true) continue
    sessionRecords.set(record.logPath, record)
  }

  /** Persist every known program's breakpoints (pending ones included). */
  function persist() {
    const breakpoints = {}
    for (const logPath of known) {
      const list = sessions.listBreakpoints(logPath) ?? []
      if (list.length === 0) continue
      breakpoints[logPath] = list.map((entry) => ({
        className: entry.className,
        line: entry.line,
        suspendPolicy: policyOf(entry.suspendPolicy),
      }))
    }
    const state = { version: 1, breakpoints }
    if (sessionRecords.size > 0) state.sessions = [...sessionRecords.values()]
    writeDebugState(home, state)
  }

  /** One program row from the daemon's own list (404 when unknown). */
  async function programOf(cwd, id, dir) {
    const listed = await listPrograms(cwd, { dir })
    const program = findProgram(listed.programs, String(id ?? ''))
    if (program === null || program === undefined) throw new DebugError('unknown-program', `未知程序：${id}`)
    return Object.assign({}, program, { _logsDir: listed.dir })
  }

  /** A program necessarily has a log path (that is the pidfile/session key). */
  function logPathOf(program) {
    if (typeof program.logPath !== 'string' || program.logPath === '') {
      throw new DebugError('no-jdwp', `程序 ${program.id} 没有日志路径，无法作为调试会话的键`)
    }
    return program.logPath
  }

  /** Read actions allowed from any window; mutating actions only from the owner. */
  function assertOwner(logPath, sessionId) {
    const owner = owners.get(logPath)
    if (owner === undefined || owner === DEFAULT_OWNER) return
    if (String(sessionId ?? '') !== owner) {
      throw new DebugError('debug-owned', `这个程序的调试会话由另一个窗口占用（${owner}）；请在那里操作或先停止调试`)
    }
  }

  function statusOf(program) {
    const logPath = logPathOf(program)
    const status = sessions.status(logPath)
    return Object.assign({ ok: true, program: { id: program.id, name: program.name, kind: program.kind, logPath }, owner: owners.get(logPath) ?? null }, status)
  }

  async function start(cwd, id, dir, body) {
    const program = await programOf(cwd, id, dir)
    if (program.kind !== 'spring') {
      throw new DebugError('not-startable', '只有 Spring(Java) 程序支持调试（前端程序没有 JVM）')
    }
    const custom = typeof program.startCommand === 'string' ? program.startCommand : ''
    if (custom.trim() !== '' && !custom.includes('${JDWP_ARGS}')) {
      throw new DebugError(
        'not-startable',
        '该程序配置了自定义 startCommand，调试需要 JDWP 参数：请在 java 后面加 ${JDWP_ARGS}（调试时替换成 -agentlib:jdwp=…，普通启动时替换为空）',
      )
    }
    const logPath = logPathOf(program)
    assertOwner(logPath, body.sessionId)
    const port = await allocateDebugPort()
    if (program.running !== null && program.running !== undefined && program.running.alive === true) {
      await stopProgramImpl(logPath, program.stopGraceMs)
    }
    await sessions.detach(logPath).catch(() => {})
    const suspendAtStartup = body.suspend === true || (body.suspend !== false && sessions.pendingCount(logPath) > 0)
    const started = await startProgramImpl(cwd, program._logsDir ?? logsDirFor(cwd, dir), Object.assign({}, program, { running: null }), {
      debug: { port, suspend: suspendAtStartup },
    })
    try {
      await waitListening(logPath, port, attachTimeoutMs)
      const snapshot = await sessions.attach(started.program ?? program, port)
      if (suspendAtStartup && Number(snapshot.installedPending || 0) === 0) {
        await sessions.resume(logPath).catch(() => {})
      }
      owners.set(logPath, String(body.sessionId ?? ''))
      programIndex.set(logPath, { cwd, id: program.id, name: program.name, kind: program.kind })
      known.add(logPath)
      sessionRecords.set(logPath, {
        logPath,
        port,
        pid: Number(started?.program?.running?.pid ?? started?.pid ?? 0) || 0,
        startedAt: new Date().toISOString(),
      })
      persist()
      return Object.assign({ ok: true, port, suspendAtStartup }, snapshot)
    } catch (error) {
      // A failed attach used to leave a JVM frozen on the JDWP port: nobody was
      // attached to resume it and no session knew about it (review B-P1-2).
      await sessions.detach(logPath).catch(() => {})
      await stopProgramImpl(logPath, program.stopGraceMs).catch(() => {})
      owners.delete(logPath)
      programIndex.delete(logPath)
      sessionRecords.delete(logPath)
      persist()
      throw new DebugError('debug-failed', `服务已以调试模式启动（JDWP 127.0.0.1:${port}），但 attach 失败：${error?.message ?? error}`)
    }
  }

  async function stop(cwd, id, dir) {
    const program = await programOf(cwd, id, dir)
    const logPath = logPathOf(program)
    await sessions.detach(logPath).catch(() => {})
    const stopped = await stopProgramImpl(logPath, program.stopGraceMs)
    owners.delete(logPath)
    programIndex.delete(logPath)
    sessionRecords.delete(logPath)
    persist()
    return { ok: true, detached: true, stopped }
  }

  /**
   * One mutating/reading action from the plugin.
   * @param body - `{ cwd, id, dir, action, sessionId, ...actionArgs }`
   * @returns JSON-safe outcome.
   */
  async function run(body) {
    const cwd = body.cwd
    const dir = typeof body.dir === 'string' ? body.dir : ''
    const action = String(body.action ?? '')
    // Session-wide actions do not name a program (the maintenance page lists them).
    if (action === 'sessions') {
      // A JVM left behind by a dead daemon has no session, but it still owns its
      // port: report it so the page can offer to stop it (review B-P2-13).
      let pruned = false
      for (const [logPath, record] of sessionRecords) {
        if (record.pid > 0 && pidAlive(record.pid) !== true) {
          sessionRecords.delete(logPath)
          pruned = true
        }
      }
      if (pruned) persist()
      // The page lists every session and needs to stop the JVM behind it, so carry
      // the program identity (cwd/id) that only the start call knows.
      const list = sessions.listSessions().map((row) => Object.assign({}, row, programIndex.get(row.logPath) ?? {}))
      const attached = new Set(list.map((row) => row.logPath))
      const stale = [...sessionRecords.values()].filter((record) => !attached.has(record.logPath))
      return { ok: true, sessions: list, stale }
    }
    if (action === 'forget') {
      // Drop the persisted breakpoint set of a session that no longer exists
      // (a JVM left by a dead daemon). Review D3: the page must be able to clear it.
      const logPath = String(body.logPath ?? '')
      if (logPath === '') throw new DebugError('bad-argument', 'logPath is required')
      owners.delete(logPath)
      // Drop both halves of a stale record: the dead-JVM address AND the breakpoint
      // set it kept alive, otherwise "clear" left the row's purpose on disk.
      const hadRecord = sessionRecords.delete(logPath)
      known.delete(logPath)
      await sessions.clearBreakpoints(logPath).catch(() => {})
      persist()
      return { ok: true, forgotten: true, logPath, hadRecord }
    }
    if (action === 'detach') {
      const logPath = String(body.logPath ?? '')
      if (logPath === '') throw new DebugError('bad-argument', 'logPath is required')
      await sessions.detach(logPath).catch(() => {})
      owners.delete(logPath)
      return { ok: true, detached: true, logPath }
    }
    if (action === 'start') return start(cwd, body.id, dir, body)
    const program = await programOf(cwd, body.id, dir)
    const logPath = logPathOf(program)
    const mutating = new Set([
      'stop', 'breakpoint-add', 'breakpoint-remove', 'breakpoint-clear',
      'step', 'resume', 'pause',
    ])
    if (mutating.has(action)) assertOwner(logPath, body.sessionId)
    switch (action) {
      case 'stop': return stop(cwd, body.id, dir)
      case 'status': return statusOf(program)
      case 'events': return Object.assign({ ok: true }, sessions.poll(logPath, Number(body.since ?? 0) || 0))
      case 'breakpoints': return { ok: true, breakpoints: sessions.listBreakpoints(logPath) }
      case 'breakpoint-add': {
        const added = await sessions.addBreakpoint(logPath, String(body.className ?? ''), Number(body.line), policyOf(body.suspendPolicy))
        known.add(logPath)
        persist()
        return Object.assign({ ok: true }, added)
      }
      case 'breakpoint-remove': {
        const removed = await sessions.removeBreakpoint(logPath, body.requestId, body.className, Number(body.line))
        known.add(logPath)
        persist()
        return Object.assign({ ok: true }, removed)
      }
      case 'breakpoint-clear': {
        const cleared = await sessions.clearBreakpoints(logPath)
        known.add(logPath)
        persist()
        return Object.assign({ ok: true }, cleared)
      }
      case 'threads': return { ok: true, threads: await sessions.threads(logPath) }
      case 'stack': return { ok: true, frames: await sessions.stack(logPath, body.threadId, Number(body.start ?? 0), Number(body.max ?? 50)) }
      case 'variables': return { ok: true, variables: await sessions.variables(logPath, body.threadId, Number(body.frameIndex ?? 0)) }
      case 'expand': return { ok: true, object: await sessions.expand(logPath, body.objectId) }
      case 'step': return Object.assign({ ok: true }, await sessions.step(logPath, String(body.kind ?? 'over'), body.threadId))
      case 'resume': return Object.assign({ ok: true }, await sessions.resume(logPath, body.threadId))
      case 'pause': return Object.assign({ ok: true }, await sessions.pause(logPath))
      default:
        throw new DebugError('bad-argument', `unknown debug action "${action}"`)
    }
  }

  /** Detach everything (daemon shutdown); breakpoints stay persisted. */
  async function stopAll() {
    await sessions.detachAll().catch(() => {})
    // Owner ids belong to dsh windows that are gone; keeping them made every new
    // window fail mutating actions with 409 debug-owned forever (review B-P1-1).
    owners.clear()
    programIndex.clear()
  }

  /** Forget which dsh window owns a session; used when the last daemon lease ends. */
  function releaseOwners() {
    owners.clear()
  }

  return {
    run,
    statusOf,
    programOf,
    stopAll,
    releaseOwners,
    get size() { return sessions.size },
    get persistedPath() { return join(home, DEBUG_STATE_FILENAME) },
  }
}
