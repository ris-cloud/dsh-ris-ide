// Program supervisor owned by the daemon.
//
// The panel's program rows are the same rows here: discovery + log naming + pidfile
// liveness all come from `lib/index.js`, so a program started in one dsh is shown
// (and stoppable) from another dsh, and keeps running after dsh exits.
//
// Only the "session-external" half lives here: list / start / stop / restart / log.
// File tree, editor, search and the panel UI stay in the plugin.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  configMatchesWorkspace,
  decoratePrograms,
  programsFromConfigEntries,
  readProgramConfig,
  scanPrograms,
  readPidFile,
  startProgram,
  stopLogPath,
} from '../index.js'
import { pidAlive } from '../proxy.js'

/** Panel default (same as `resolvePath(cwd, 'logs')` in the plugin). */
export const DEFAULT_LOGS_DIRNAME = 'logs'
/** Bytes returned by one log read when the client does not ask for more. */
export const DEFAULT_LOG_BYTES = 64 * 1024
/** Ceiling for one log read; a follower pages by offset instead. */
export const MAX_LOG_BYTES = 512 * 1024

/** Absolute logs directory for a workspace. */
export function logsDirFor(cwd, rawDir = '') {
  const dir = typeof rawDir === 'string' && rawDir !== '' ? rawDir : DEFAULT_LOGS_DIRNAME
  return isAbsolute(dir) ? dir : resolve(cwd, dir)
}

/**
 * The panel's program list, served by the daemon.
 *
 * Fast path mirrors the panel: a config file that still matches the filesystem IS
 * the list (no tree walk). Otherwise scan and let the scanner name/dedupe rows.
 */
export async function listPrograms(cwd, { dir = '', refresh = false } = {}) {
  const logsDir = logsDirFor(cwd, dir)
  const config = await readProgramConfig(cwd)
  const fast = config.exists === true
    && refresh !== true
    && configMatchesWorkspace(cwd, config.entries)
  const programs = fast
    ? await decoratePrograms(cwd, logsDir, programsFromConfigEntries(cwd, config.entries, config.defaults))
    : await scanPrograms(cwd, logsDir, refresh === true)
  return { cwd, dir: logsDir, programs }
}

/**
 * Resolve a program key (id → log name → exact name → unique name prefix).
 *
 * An exact name that matches more than one row is ambiguous, not "the first one":
 * the same module can be configured in two directories under one name, and the
 * caller must use the id instead of silently starting/stopping the wrong row
 * (review B-P2-12).
 * @param {Array<object>} programs - rows from `listPrograms()`.
 * @param {string} wanted - id, log name, name or unambiguous name prefix.
 * @returns {{program: object|null, ambiguous: Array<object>}} match result.
 */
export function findProgramMatch(programs, wanted) {
  if (typeof wanted !== 'string' || wanted === '') return { program: null, ambiguous: [] }
  const exact = programs.find((row) => row.id === wanted)
  if (exact !== undefined) return { program: exact, ambiguous: [] }
  const byLog = programs.find((row) => row.logName === wanted)
  if (byLog !== undefined) return { program: byLog, ambiguous: [] }
  const byName = programs.filter((row) => row.name === wanted)
  if (byName.length === 1) return { program: byName[0], ambiguous: [] }
  if (byName.length > 1) return { program: null, ambiguous: byName }
  const prefixed = programs.filter((row) => String(row.name).startsWith(wanted))
  if (prefixed.length === 1) return { program: prefixed[0], ambiguous: [] }
  return { program: null, ambiguous: prefixed.length > 1 ? prefixed : [] }
}

/** Resolve a program by id, log name, exact name or a unique name prefix. */
export function findProgram(programs, wanted) {
  return findProgramMatch(programs, wanted).program
}

/** `findProgram()` plus the error the HTTP layer should answer with. */
function findProgramOrError(programs, wanted) {
  const match = findProgramMatch(programs, wanted)
  if (match.program !== null) return { program: match.program, error: null }
  if (match.ambiguous.length > 0) {
    const ids = match.ambiguous.map((row) => row.id).join('、')
    return {
      program: null,
      error: { ok: false, code: 'ambiguous', message: `「${wanted}」匹配到 ${match.ambiguous.length} 个程序（${ids}）；请改用 id 或 logName`, status: 409 },
    }
  }
  return { program: null, error: { ok: false, code: 'no-program', message: `未找到程序「${wanted}」`, status: 404 } }
}

/** Start one program. Already-running rows are a successful no-op (the panel's rule). */
export async function startProgramByKey(cwd, wanted, { dir = '', options = {} } = {}) {
  const listed = await listPrograms(cwd, { dir })
  const { program, error } = findProgramOrError(listed.programs, wanted)
  if (program === null) return error
  const started = await startProgram(cwd, listed.dir, program, options)
  const pid = started?.pid ?? started?.program?.running?.pid ?? null
  return { ok: true, cwd, dir: listed.dir, program: { id: program.id, logName: program.logName, logPath: program.logPath }, alreadyRunning: started?.alreadyRunning === true, pid }
}

/** Stop one program by its log pidfile (the wrapper is verified before signaling). */
export async function stopProgramByKey(cwd, wanted, { dir = '' } = {}) {
  const listed = await listPrograms(cwd, { dir })
  const { program, error } = findProgramOrError(listed.programs, wanted)
  if (program === null) return error
  try {
    const outcome = await stopLogPath(program.logPath)
    return { ok: true, cwd, dir: listed.dir, stopped: outcome.stopped === true, pid: outcome.pid ?? null, program: { id: program.id, logName: program.logName, logPath: program.logPath } }
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    return { ok: false, code: error?.code ?? 'stop-failed', message: error?.message ?? String(error), status }
  }
}

/** Restart = stop (if running) then start, returning both halves. */
export async function restartProgramByKey(cwd, wanted, { dir = '', options = {} } = {}) {
  const listed = await listPrograms(cwd, { dir })
  const { program, error } = findProgramOrError(listed.programs, wanted)
  if (program === null) return error
  let stopped = null
  if (program.running?.alive === true) {
    try {
      stopped = await stopLogPath(program.logPath)
    } catch (error) {
      return { ok: false, code: error?.code ?? 'stop-failed', message: error?.message ?? String(error), status: typeof error?.status === 'number' ? error.status : 500 }
    }
  }
  const started = await startProgramByKey(cwd, wanted, { dir, options })
  return Object.assign({}, started, { stopped })
}

/**
 * Read a log window.
 *
 * `offset` is a byte position from a previous read. Without it the tail is
 * returned (so the panel's first paint is useful on a large file); with it only
 * the new bytes come back, which is what a follower needs after a reconnect.
 * `nextOffset` is always the file size the caller should use next.
 */
export async function readProgramLog(cwd, wanted, { dir = '', offset = null, bytes = DEFAULT_LOG_BYTES } = {}) {
  const listed = await listPrograms(cwd, { dir })
  const { program, error } = findProgramOrError(listed.programs, wanted)
  if (program === null) return error
  const path = program.logPath
  if (existsSync(path) !== true) {
    const reset = Number.isFinite(offset) && Math.floor(offset) > 0
    return { ok: true, path, size: 0, offset: 0, nextOffset: 0, text: '', reset, running: program.running ?? null }
  }
  const size = statSync(path).size
  const limit = Math.max(1024, Math.min(MAX_LOG_BYTES, Number.isFinite(bytes) ? Math.floor(bytes) : DEFAULT_LOG_BYTES))
  let start
  if (Number.isFinite(offset) && offset >= 0 && offset <= size) start = Math.floor(offset)
  else start = Math.max(0, size - limit)
  if (size - start > limit) start = size - limit
  const length = size - start
  // `offset > size` means the caller's byte position is gone (truncated file):
  // the tail is returned, but the caller must replace rather than append it.
  const truncated = Number.isFinite(offset) && Math.floor(offset) > size
  if (length === 0) {
    return { ok: true, path, size, offset: start, nextOffset: size, text: '', reset: truncated, running: program.running ?? null }
  }
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, start)
    return { ok: true, path, size, offset: start, nextOffset: size, text: buffer.toString('utf8'), reset: truncated, running: program.running ?? null }
  } finally {
    closeSync(fd)
  }
}


/** How often the follower stats the log file. */
export const LOG_FOLLOW_INTERVAL_MS = 400
/** How long a stopped program's stream keeps draining before it ends. */
export const LOG_FOLLOW_STOPPED_GRACE_MS = 2500
/** Heartbeat comment so proxies/browsers keep the stream open. */
export const LOG_FOLLOW_PING_MS = 15_000

/** Whether a program row is alive right now (pidfile + kill(0); never a tree walk). */
async function programAlive(row) {
  const record = await readPidFile(row.logPath)
  if (record === undefined) return false
  // The wrapper is the pid that owns the log writes, so a stopping service keeps
  // counting as alive while it drains its shutdown output (the panel's
  // readService() uses the same pid || wrapperPid rule — review B-P2-4).
  return pidAlive(record.pid) === true || pidAlive(record.wrapperPid) === true
}

/**
 * Follow one program's log for an SSE relay.
 *
 * Frames (the `event:` name equals `type`):
 *   - `log`   `{path,size,offset,nextOffset,text,running}` — new bytes only
 *   - `reset` same shape but `offset` restarted at 0 (truncation/rotation)
 *   - `state` `{running}` — the service started/stopped
 *   - `end`   `{reason:'stopped'|'gone'}` then the stream closes
 *
 * The caller owns the response; `stop()` unsubscribes immediately.
 */
export function startLogFollow(row, { offset = null, bytes = DEFAULT_LOG_BYTES, intervalMs = LOG_FOLLOW_INTERVAL_MS, stoppedGraceMs = LOG_FOLLOW_STOPPED_GRACE_MS, alive = programAlive } = {}, onFrame) {
  const path = row.logPath
  const limit = Math.max(1024, Math.min(MAX_LOG_BYTES, Number.isFinite(bytes) ? Math.floor(bytes) : DEFAULT_LOG_BYTES))
  const hasOffset = Number.isFinite(offset) && offset >= 0
  let cursor = hasOffset ? Math.floor(offset) : 0
  let lastSize = 0
  let lastIno = 0
  let lastCtimeMs = 0
  let running = row.running?.alive === true
  let stoppedSince = running ? null : Date.now()
  let timer = null
  let ping = null
  let closed = false
  let ticking = false

  /** One stat so `size`, inode and ctime all describe the same file version. */
  const statLog = () => {
    try {
      const st = statSync(path)
      return { size: st.size, ino: Number(st.ino) || 0, ctimeMs: Number(st.ctimeMs) || 0 }
    } catch {
      return { size: 0, ino: 0, ctimeMs: 0 }
    }
  }

  const readWindow = (from, st = statLog()) => {
    const { size, ino, ctimeMs } = st
    if (size <= 0) return { size, ino, ctimeMs, start: 0, next: 0, text: '' }
    let start = from
    if (!Number.isFinite(start) || start < 0 || start > size) start = Math.max(0, size - limit)
    const length = Math.min(limit, size - start)
    if (length <= 0) return { size, ino, ctimeMs, start, next: start, text: '' }
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      readSync(fd, buffer, 0, length, start)
      return { size, ino, ctimeMs, start, next: start + length, text: buffer.toString('utf8') }
    } finally {
      closeSync(fd)
    }
  }

  const emit = (frame) => {
    if (closed) return
    try { onFrame(frame) } catch { /* the socket owns its own errors */ }
    if (frame.type === 'end') stop()
  }

  const tick = async () => {
    if (closed || ticking) return
    ticking = true
    try {
      const present = (await alive(row)) === true
      if (present !== running) {
        running = present
        stoppedSince = present ? null : Date.now()
        emit({ type: 'state', running })
      }
      const st = statLog()
      // Rotation is not only "the file got shorter": logrotate-style truncate +
      // copy can leave the same length, and replacing the file changes the inode
      // (review B-P2-3).
      const replaced = lastIno !== 0 && st.ino !== 0 && st.ino !== lastIno
      const sameSizeRewrite = st.size === lastSize && st.size > 0 && lastCtimeMs !== 0 && st.ctimeMs !== lastCtimeMs
      if (st.size < lastSize || st.size < cursor || replaced || sameSizeRewrite) {
        // Rotated, truncated or replaced: the byte we were waiting for is gone.
        const window = readWindow(0, st)
        cursor = window.next
        lastSize = window.size
        lastIno = window.ino
        lastCtimeMs = window.ctimeMs
        emit({ type: 'reset', path, size: window.size, offset: window.start, nextOffset: window.next, text: window.text, running })
        return
      }
      if (st.size > cursor) {
        const window = readWindow(cursor, st)
        cursor = window.next
        lastSize = window.size
        lastIno = window.ino
        lastCtimeMs = window.ctimeMs
        emit({ type: 'log', path, size: window.size, offset: window.start, nextOffset: window.next, text: window.text, running })
        if (present === false) stoppedSince = Date.now()
        return
      }
      lastSize = st.size
      if (st.ino !== 0) lastIno = st.ino
      lastCtimeMs = st.ctimeMs
      if (present === false && stoppedSince !== null && Date.now() - stoppedSince >= stoppedGraceMs) {
        emit({ type: 'end', reason: 'stopped' })
      }
    } finally {
      ticking = false
    }
  }

  // A chained timer instead of setInterval: a slow `alive`/stat call (WSL /mnt/c)
  // must never overlap the next tick and reorder `state`/`stoppedSince`
  // (review B-P2-2).
  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      tick().catch(() => {}).finally(() => { if (!closed) schedule() })
    }, intervalMs)
    timer.unref?.()
  }

  const initialStat = statLog()
  // An offset past EOF is a truncated/replaced file: start over from the tail and
  // say `reset`, otherwise an appending client duplicates the tail (B-P2-1).
  const truncated = hasOffset && cursor > initialStat.size
  if (truncated) cursor = Math.max(0, initialStat.size - limit)
  let first
  try {
    first = readWindow(hasOffset ? cursor : Math.max(0, initialStat.size - limit), initialStat)
  } catch {
    first = { size: 0, ino: 0, ctimeMs: 0, start: 0, next: 0, text: '' }
  }
  cursor = first.next
  lastSize = first.size
  lastIno = first.ino
  lastCtimeMs = first.ctimeMs
  if (truncated) {
    emit({ type: 'reset', path, size: first.size, offset: first.start, nextOffset: first.next, text: first.text, running })
  } else if (first.text !== '') {
    emit({ type: 'log', path, size: first.size, offset: first.start, nextOffset: first.next, text: first.text, running })
  }
  schedule()
  ping = setInterval(() => { if (!closed) try { onFrame({ type: 'ping' }) } catch { /* ignore */ } }, LOG_FOLLOW_PING_MS)
  ping.unref?.()

  function stop() {
    if (closed) return
    closed = true
    if (timer !== null) clearTimeout(timer)
    if (ping !== null) clearInterval(ping)
    timer = null
    ping = null
  }

  return { stop, get offset() { return cursor } }
}
