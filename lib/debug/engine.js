/**
 * Debug engine for the local-instance panel: one JDWP session per program.
 *
 * The wire protocol lives in the vendored `jvm-debug-mcp` engine
 * (`./vendor/jdwp/client.js`, MIT, see `./vendor/README.md`); this module owns
 * the *lifecycle*: JDWP launch argument, free-port allocation, attach/retry,
 * the bounded event ring, and JSON-safe projections for the routes and the
 * `ris_dev_debug` tool.
 *
 * Deliberately no third-party runtime dependency: the engine only needs
 * `node:net`/`node:events`, and everything here is plain JS.
 */
import net from 'node:net'
import { open, stat } from 'node:fs/promises'
import { JDWPClient } from './vendor/jdwp/client.js'

/** JDWP agent argument for a loopback-only debugging listener. */
export function jdwpAgentArg(port, suspend = false) {
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid debug port: ${port}`)
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend === true ? 'y' : 'n'},address=127.0.0.1:${port}`
}

/**
 * JSON-safe projection: JDWP ids are BigInt and `JSON.stringify` refuses them.
 * @param value - anything the engine returned.
 * @returns a value with BigInt → decimal string.
 */
export function toJsonSafe(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined) return null
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value instanceof Map) {
    const out = {}
    for (const [key, item] of value) out[String(key)] = toJsonSafe(item)
    return out
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = toJsonSafe(item)
    return out
  }
  return String(value)
}

/** A TCP port free on 127.0.0.1 right now (the JVM binds it a moment later). */
export function allocateDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : undefined
      server.close(() => {
        if (port === undefined) reject(new Error('could not allocate a debug port'))
        else resolve(port)
      })
    })
  })
}

/** Wait until something accepts a TCP connection on 127.0.0.1:port. */
export function waitForTcp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const retry = () => {
        socket.destroy()
        if (Date.now() >= deadline) reject(new Error(`debug port ${port} did not open within ${timeoutMs}ms`))
        else setTimeout(attempt, 200)
      }
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', retry)
      socket.once('error', retry)
    }
    attempt()
  })
}

/**
 * Read the last `bytes` of a text file (a log may be large by the time this runs).
 * @param path - absolute log path.
 * @param bytes - tail window.
 * @returns the tail text, or `''` when the file is missing.
 */
async function readTailText(path, bytes = 16 * 1024) {
  let handle
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    const length = Math.min(bytes, info.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, info.size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Wait for the JVM to announce its JDWP listener in its own log.
 *
 * **Do not** probe a JDWP port with a plain TCP connect before attaching: JDWP
 * serves a single debugger session, so a throwaway connect consumes it and the
 * real attach then gets ECONNRESET. The JVM prints
 * `Listening for transport dt_socket at address: <port>` once the listener is up.
 * @param logPath - the program log the wrapper writes.
 * @param port - the JDWP port we chose.
 * @param timeoutMs - how long to wait (the wrapper runs `mvn compile` first).
 * @returns `true` when the line was seen.
 * @throws {Error} with the log tail when it never appears.
 */
export async function waitForJdwpListening(logPath, port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  const needle = new RegExp(`Listening for transport dt_socket at address: (?:127\\.0\\.0\\.1:)?${port}\\b`)
  let tail = ''
  while (Date.now() < deadline) {
    tail = await readTailText(logPath)
    if (needle.test(tail)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const lines = tail.split('\n').filter((line) => line.trim() !== '')
  const preview = lines.slice(Math.max(0, lines.length - 8)).join('\n')
  throw new Error(`JDWP 端口 ${port} 没有在 ${timeoutMs}ms 内就绪${preview === '' ? '' : `；日志尾部：\n${preview}`}`)
}

/** One machine-readable failure (mapped to an HTTP status by the route). */
export class DebugError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DebugError'
    this.code = code
  }
}

const DEBUG_ERROR_STATUS = {
  'not-attached': 409,
  'bad-argument': 400,
  'unknown-program': 404,
  'debug-failed': 502,
  'no-jdwp': 409,
}

/** HTTP status for one {@link DebugError} code. */
export function debugErrorStatus(code) {
  return DEBUG_ERROR_STATUS[code] ?? 500
}

/** The event names the engine emits, mapped to what the UI/tool reports. */
const EVENT_TYPES = [
  'breakpoint', 'step', 'classprepare', 'vmstart', 'vmdeath', 'threadstart', 'threaddeath',
]

/** The breakpoint suspend policies the engine accepts. */
export const SUSPEND_POLICIES = new Set(['thread', 'all'])

/**
 * Create the per-plugin debug session registry.
 * @param options - `{ clientFactory?, eventLimit?, connectRetry? }` (tests inject a fake client).
 * @returns the session API (all methods resolve JSON-safe values).
 */
export function createDebugSessions(options = {}) {
  const clientFactory = options.clientFactory ?? (() => new JDWPClient())
  const eventLimit = Number.isInteger(options.eventLimit) ? options.eventLimit : 200
  const connectRetry = Number.isInteger(options.connectRetry) ? options.connectRetry : 50
  const connectTimeoutMs = Number.isInteger(options.connectTimeoutMs) ? options.connectTimeoutMs : 30000
  /** logPath → session */
  const sessions = new Map()
  /**
   * Breakpoints set BEFORE a debug session exists, keyed by program log path.
   * `startProgramDebug`/`attach` installs them as soon as the JVM connects, so a
   * gutter click on a stopped program is not lost ("提前打断点").
   * @type {Map<string, Array<{className: string, line: number, suspendPolicy: string}>>}
   */
  const pendingBreakpoints = new Map()

  /** The pre-set breakpoints of one program (empty when none). */
  const pendingOf = (logPath) => pendingBreakpoints.get(logPath) ?? []
  /** How many pre-set breakpoints wait for one program (0 when none). */
  const pendingCount = (logPath) => pendingOf(logPath).length
  /** Store one pre-set breakpoint (dedupes className+line). */
  const addPending = (logPath, className, line, suspendPolicy) => {
    const policy = SUSPEND_POLICIES.has(suspendPolicy) ? suspendPolicy : 'thread'
    const list = pendingOf(logPath).filter((entry) => !(entry.className === className && entry.line === line))
    list.push({ className, line, suspendPolicy: policy })
    pendingBreakpoints.set(logPath, list)
  }

  /**
   * Install every pre-set breakpoint of one program into a fresh session.
   * Failures are recorded on the session (the UI shows them) and the rest go on.
   */
  const installPending = async (session) => {
    const list = pendingOf(session.logPath)
    if (list.length === 0) return 0
    pendingBreakpoints.delete(session.logPath)
    let installed = 0
    for (const entry of list) {
      try {
        await session.client.setBreakpoint(entry.className, entry.line, entry.suspendPolicy)
        installed += 1
      } catch (error) {
        session.lastError = `预置断点 ${entry.className}:${entry.line} 未能生效：${error.message ?? error}`
      }
    }
    return installed
  }

  const sessionOf = (logPath) => {
    const session = sessions.get(logPath)
    if (session === undefined) {
      throw new DebugError('not-attached', `no debug session for ${logPath}; start it with action "start"`)
    }
    return session
  }
  const bigintId = (value, label) => {
    const text = String(value ?? '')
    if (!/^\d+$/.test(text)) throw new DebugError('bad-argument', `${label} must be a numeric id (got ${JSON.stringify(value)})`)
    try {
      return BigInt(text)
    } catch {
      throw new DebugError('bad-argument', `${label} is not a valid id`)
    }
  }
  const recordEvent = (session, type, payload) => {
    session.seq += 1
    session.events.push({ seq: session.seq, at: Date.now(), type, payload: toJsonSafe(payload) })
    while (session.events.length > eventLimit) session.events.shift()
  }
  const snapshot = (session) => ({
    attached: session.client.isConnected === true,
    port: session.port,
    attachedAt: session.attachedAt,
    vmSuspended: session.client.vmSuspended === true,
    suspendedThreads: toJsonSafe(session.client.allSuspendedThreadIds ?? []),
    // The thread a breakpoint/step stopped (EventThread policies suspend only that
    // one); the IDE reads frames/variables from it instead of guessing threads[0].
    currentThreadId: toJsonSafe(session.client.currentThreadId ?? null),
    breakpoints: toJsonSafe(session.client.getBreakpoints() ?? []),
  })

  /** Connect to a JVM that was started with {@link jdwpAgentArg}. */
  const attach = async (program, port) => {
    if (sessions.has(program.logPath)) await detach(program.logPath)
    // A failed connect leaves the JDWP client's socket in an unusable state, so
    // each attempt gets a fresh client.
    let client
    let lastError
    const deadline = Date.now() + connectTimeoutMs
    for (let attempt = 1; attempt <= connectRetry; attempt += 1) {
      client = clientFactory()
      try {
        await client.connect('127.0.0.1', port)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        client = undefined
        if (Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 2000)))
      }
    }
    if (client === undefined) client = clientFactory()
    if (lastError !== undefined) {
      throw new DebugError('debug-failed', `cannot attach to 127.0.0.1:${port}: ${lastError.message ?? lastError}`)
    }
    const session = {
      logPath: program.logPath,
      programId: program.id,
      programName: program.name,
      port,
      client,
      attachedAt: Date.now(),
      seq: 0,
      events: [],
    }
    for (const type of EVENT_TYPES) client.on(type, (payload) => recordEvent(session, type, payload))
    client.on('error', (error) => {
      session.lastError = String(error && error.message ? error.message : error)
      recordEvent(session, 'error', { message: session.lastError })
    })
    client.on('close', () => {
      sessions.delete(program.logPath)
    })
    sessions.set(program.logPath, session)
    recordEvent(session, 'attach', { port })
    // Anything the user clicked before the session existed now becomes real.
    // (With `suspend=y` the JVM is still waiting at startup here, so a breakpoint
    // in `main` — e.g. on `SpringApplication.run(...)` — is installed BEFORE that
    // line runs; with `suspend=n` it would be too late.)
    const installedPending = await installPending(session)
    return Object.assign(
      { logPath: program.logPath, programId: program.id, name: program.name, installedPending },
      snapshot(session),
    )
  }

  /** Disconnect (the JVM resumes if it was suspended by a breakpoint). */
  const detach = async (logPath) => {
    const session = sessions.get(logPath)
    if (session === undefined) return { detached: false }
    // Keep the user's breakpoints for the NEXT attach: JDWP event requests die with
    // the connection, and a debug RESTART is detach+attach — without this the dots
    // vanished on every restart. `clearBreakpoints` empties this list on purpose.
    try {
      for (const breakpoint of session.client.getBreakpoints() ?? []) {
        if (typeof breakpoint.className !== 'string' || !Number.isFinite(Number(breakpoint.line))) continue
        addPending(logPath, breakpoint.className, Number(breakpoint.line), breakpoint.suspendPolicy)
      }
    } catch {
      // a dead connection cannot be asked: the restart then starts empty
    }
    sessions.delete(logPath)
    try {
      await session.client.disconnect()
    } catch {
      // the VM may already be gone: detaching is best-effort
    }
    return { detached: true }
  }

  /** Detach every session (plugin teardown). */
  const detachAll = async () => {
    const paths = [...sessions.keys()]
    for (const logPath of paths) await detach(logPath)
    return { detached: paths.length }
  }

  /** One session's status, or a detached stub (no throw — the panel polls it). */
  const status = (logPath) => {
    const session = sessions.get(logPath)
    if (session === undefined) {
      return { attached: false, logPath, breakpoints: pendingOf(logPath).map((entry) => Object.assign({ requestId: 'pending', pending: true }, entry)) }
    }
    return Object.assign({ logPath }, snapshot(session), { lastError: session.lastError ?? null })
  }

  /** Session state + events newer than `since` (one poll request for the UI). */
  const poll = (logPath, since = 0) => {
    const session = sessions.get(logPath)
    if (session === undefined) {
      return {
        attached: false,
        logPath,
        events: [],
        seq: 0,
        vmSuspended: false,
        breakpoints: pendingOf(logPath).map((entry) => Object.assign({ requestId: 'pending', pending: true }, entry)),
      }
    }
    // Tag breakpoint events with the breakpoint they belong to. Several consumers
    // (the IDE, an agent session) share ONE JDWP connection, so "a breakpoint was
    // hit" is not enough: each side must be able to tell WHICH one hit, otherwise
    // one party's breakpoint can be mistaken for its own.
    const hitByRequest = new Map((session.client.getBreakpoints() ?? []).map((entry) => [String(entry.requestId), entry]))
    const events = session.events
      .filter((event) => event.seq > Number(since || 0))
      .map((event) => {
        if (event.type !== 'breakpoint' && event.type !== 'step') return event
        const requestId = event.payload === null || event.payload === undefined ? undefined : event.payload.requestId
        const breakpoint = requestId === undefined ? undefined : hitByRequest.get(String(requestId))
        if (breakpoint === undefined) return event
        return Object.assign({}, event, {
          payload: Object.assign({}, event.payload, { className: breakpoint.className, line: breakpoint.line }),
        })
      })
    return Object.assign({ logPath }, snapshot(session), {
      lastError: session.lastError ?? null,
      seq: session.seq,
      events,
    })
  }

  /**
   * Every live session, so a client that shows ONE program can still notice a
   * breakpoint in another (the IDE auto-switches to the hit project).
   * @returns {object[]} `[{logPath, attached, vmSuspended, suspendedThreads, seq, port}]`
   */
  const listSessions = () => toJsonSafe([...sessions.entries()].map(([logPath, session]) => Object.assign(
    { logPath },
    snapshot(session),
    { seq: session.seq, lastError: session.lastError ?? null },
  )))

  const listBreakpoints = (logPath) => {
    const session = sessions.get(logPath)
    if (session === undefined) {
      return toJsonSafe(pendingOf(logPath).map((entry) => Object.assign({ requestId: 'pending', pending: true }, entry)))
    }
    return toJsonSafe(session.client.getBreakpoints() ?? [])
  }

  const addBreakpoint = async (logPath, className, line, suspendPolicy = 'thread') => {
    if (typeof className !== 'string' || className.trim() === '') throw new DebugError('bad-argument', 'className is required')
    const lineNumber = Number(line)
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) throw new DebugError('bad-argument', 'line must be a positive integer')
    const policy = SUSPEND_POLICIES.has(suspendPolicy) ? suspendPolicy : 'thread'
    const session = sessions.get(logPath)
    if (session === undefined) {
      // No session yet: remember it and install on attach ("提前打断点").
      addPending(logPath, className.trim(), lineNumber, policy)
      return { requestId: 'pending', className: className.trim(), line: lineNumber, suspendPolicy: policy, pending: true }
    }
    try {
      const breakpoint = await session.client.setBreakpoint(className.trim(), lineNumber, policy)
      return toJsonSafe(breakpoint)
    } catch (error) {
      throw new DebugError('debug-failed', `cannot set breakpoint ${className}:${lineNumber}: ${error.message ?? error}`)
    }
  }

  const removeBreakpoint = async (logPath, requestId, className, line) => {
    const session = sessions.get(logPath)
    if (session === undefined) {
      // A pre-set breakpoint: match it by className+line (requestId is a marker).
      const targetLine = Number(line)
      const next = pendingOf(logPath).filter((entry) => !(entry.className === className && entry.line === targetLine))
      if (next.length === 0) pendingBreakpoints.delete(logPath)
      else pendingBreakpoints.set(logPath, next)
      return { removed: true, requestId: 'pending' }
    }
    // Live session: a request id is the fast path, but callers (agents!) often only
    // know the class+line they set — resolve the request id for them.
    let id = Number(requestId)
    if (!Number.isInteger(id)) {
      const match = (session.client.getBreakpoints() ?? []).find(
        (entry) => entry.className === className && Number(entry.line) === Number(line),
      )
      if (match === undefined) throw new DebugError('bad-argument', 'requestId (or className + line) is required')
      id = Number(match.requestId)
    }
    if (!Number.isInteger(id)) throw new DebugError('bad-argument', 'requestId must be an integer')
    await session.client.removeBreakpoint(id)
    return { removed: true, requestId: id }
  }

  const clearBreakpoints = async (logPath) => {
    pendingBreakpoints.delete(logPath)
    const session = sessions.get(logPath)
    if (session !== undefined) await session.client.clearAllBreakpoints()
    return { cleared: true }
  }

  const threads = async (logPath) => toJsonSafe(await sessionOf(logPath).client.getAllThreads())

  const stack = async (logPath, threadId, start = 0, max = 50) => {
    const session = sessionOf(logPath)
    const id = bigintId(threadId, 'threadId')
    const frames = await session.client.getFrames(id, Number(start) || 0, Number(max) || 50)
    return toJsonSafe(frames)
  }

  const variables = async (logPath, threadId, frameIndex = 0) => {
    const session = sessionOf(logPath)
    const id = bigintId(threadId, 'threadId')
    const frames = await session.client.getFrames(id, 0, Number(frameIndex) + 1)
    const frame = frames[Number(frameIndex)]
    if (frame === undefined) throw new DebugError('bad-argument', `frameIndex ${frameIndex} is out of range (${frames.length} frame(s))`)
    return toJsonSafe(await session.client.getFrameVariables(id, frame.frameId, frame.location))
  }

  /**
   * Expand one object/array value (one click in the IDE's variable tree).
   *
   * The JDWP layer resolves the object's runtime class, then returns either its
   * fields or its first 100 array entries; nested objects keep `objectId` so the
   * client can expand them in turn.
   * @param {string} logPath - the program's log path (session key).
   * @param {string} objectId - a decimal JDWP object id from a variable entry.
   */
  const expand = async (logPath, objectId) => {
    const session = sessionOf(logPath)
    if (typeof objectId !== 'string' || !/^\d+$/.test(objectId)) {
      throw new DebugError('bad-argument', 'objectId must be a decimal JDWP object id')
    }
    return toJsonSafe(await session.client.getObjectDetails(BigInt(objectId)))
  }

  const step = async (logPath, kind, threadId) => {
    const session = sessionOf(logPath)
    const candidates = typeof threadId === 'string' && threadId !== ''
      ? [bigintId(threadId, 'threadId')]
      : (session.client.allSuspendedThreadIds ?? []).map((id) => BigInt(id))
    const target = candidates[0]
    if (target === undefined) throw new DebugError('not-attached', 'no suspended thread to step; set a breakpoint first or pass threadId')
    if (kind === 'into') await session.client.stepInto(target)
    else if (kind === 'out') await session.client.stepOut(target)
    else if (kind === 'over') await session.client.stepOver(target)
    else throw new DebugError('bad-argument', 'kind must be over | into | out')
    return { stepped: kind, threadId: target.toString() }
  }

  const resume = async (logPath, threadId) => {
    const session = sessionOf(logPath)
    if (typeof threadId === 'string' && threadId !== '') {
      await session.client.resumeThread(bigintId(threadId, 'threadId'))
      return { resumed: 'thread', threadId }
    }
    await session.client.resumeVM()
    return { resumed: 'all' }
  }

  const pause = async (logPath) => {
    await sessionOf(logPath).client.suspendVM()
    return { paused: true }
  }

  return {
    attach,
    detach,
    detachAll,
    status,
    poll,
    pendingCount,
    listSessions,
    listBreakpoints,
    addBreakpoint,
    removeBreakpoint,
    clearBreakpoints,
    threads,
    stack,
    variables,
    expand,
    step,
    resume,
    pause,
    get size() { return sessions.size },
  }
}
