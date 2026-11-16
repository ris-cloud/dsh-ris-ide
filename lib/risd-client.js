/**
 * risd-client — the plugin side of the daemon (Phase 1a: discover, spawn, lease, read).
 *
 * Rules this module keeps:
 * - **Never throws at the caller.** A missing daemon is a normal state, not an
 *   error: `ensureRisd` reports `{ ok: false, reason }` and the plugin falls
 *   back to its own proxy path.
 * - **Never kills by pid.** Stopping goes through `POST /v1/shutdown`; a stale
 *   `risd.json` is only ever overwritten by a daemon that won the port, so the
 *   plugin cannot shoot a daemon that replaced the one it remembered.
 * - **One spawn per machine.** A spawn lock (`risd.spawn.lock`, O_EXCL) makes
 *   concurrent dsh instances agree on who forks; the loser waits for
 *   `risd.json` instead of forking a doomed second daemon.
 *
 * API-shape note: `request()` returns `{ ok, status, body }` where `body` is the
 * parsed JSON payload. `ok` is true only for a 2xx whose payload says `ok:true`,
 * so callers never have to special-case "HTTP 200 that reported a failure".
 *
 * @module dsh-risd/client
 */
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { API_VERSION_HEADER } from './risd/server.js'
import { RISD_API_VERSION, acquireSpawnLock, dropStaleSpawnLock, readRisdState, releaseSpawnLock } from './risd/state.js'

/** How long we wait for a freshly spawned daemon to answer health. */
export const RISD_START_TIMEOUT_MS = 5000
/** How long a losing spawner waits for the winner's `risd.json`. */
export const RISD_WAIT_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 2000

export const RISD_ENTRY = fileURLToPath(new URL('../bin/risd.mjs', import.meta.url))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Low-level authenticated call.
 * @param state - the `risd.json` contents (needs `url` and `token`).
 * @param path - absolute path under `/v1`.
 * @param options - `{ method, body, timeoutMs }`.
 * @returns `{ ok, status, body, error? }`.
 */
export async function risdRequest(state, path, { method = 'GET', body = undefined, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (state === null || typeof state !== 'object' || typeof state.token !== 'string') {
    return { ok: false, status: 0, body: null, error: 'no state' }
  }
  try {
    const response = await fetch(`${state.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${state.token}`,
        [API_VERSION_HEADER]: String(RISD_API_VERSION),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return { ok: response.ok === true && parsed?.ok === true, status: response.status, body: parsed, error: parsed?.message }
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message ?? error) }
  }
}

/** Health is unauthenticated, but still needs the state for its base URL. */
export async function risdHealth(state, { timeoutMs = 1000 } = {}) {
  if (state === null || typeof state !== 'object') return null
  const call = await risdRequest(Object.assign({}, state, { token: '' }), '/v1/health', { timeoutMs })
  return call.body
}

/**
 * Is the state file describing a daemon we can actually talk to, at a version
 * we understand?
 * @returns `{ usable: boolean, reason?, health?, state? }` (`reason` is one of
 *   `absent`, `unreachable`, `api-mismatch`).
 */
export async function probeRisd({ home } = {}) {
  const state = readRisdState(home)
  if (state === null) return { usable: false, reason: 'absent', state: null }
  const health = await risdHealth(state)
  if (health === null || health.ok !== true) return { usable: false, reason: 'unreachable', state, health }
  if (Number(health.apiVersion) !== RISD_API_VERSION) return { usable: false, reason: 'api-mismatch', state, health }
  return { usable: true, state, health }
}

/**
 * Make sure a daemon is running and return its state.
 *
 * @param options - `{ home, timeoutMs, spawnPath, version }`.
 * @returns `{ ok, state?, reason?, spawned? }`.
 */
export async function ensureRisd({ home, timeoutMs = RISD_START_TIMEOUT_MS, spawnPath = RISD_ENTRY } = {}) {
  const first = await probeRisd({ home })
  if (first.usable) return { ok: true, state: first.state, spawned: false }
  if (first.reason === 'api-mismatch') return { ok: false, reason: 'api-mismatch', state: first.state }

  dropStaleSpawnLock(home)
  let owned = false
  try {
    owned = acquireSpawnLock(home)
  } catch (error) {
    // The lock is an optimisation, not a precondition: an unwritable home already
    // fails later with a readable 'spawn-timeout'. Never throw out of ensureRisd.
    return { ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) }
  }
  if (!owned) {
    // Another dsh is spawning: wait for its state instead of forking a peer.
    const deadline = Date.now() + Math.min(timeoutMs, RISD_WAIT_TIMEOUT_MS)
    while (Date.now() < deadline) {
      await sleep(100)
      const probe = await probeRisd({ home })
      if (probe.usable) return { ok: true, state: probe.state, spawned: false }
    }
    return { ok: false, reason: 'spawn-timeout' }
  }

  try {
    const child = spawn(process.execPath, [spawnPath, 'serve', ...(home === undefined ? [] : ['--home', String(home)])], {
      detached: true,
      // Keep stderr so a daemon that exits immediately (port busy, version
      // mismatch, lock held) explains itself instead of surfacing as 'timeout'
      // (review A-P2-13).
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let spawnError = ''
    let exitCode = null
    child.on('error', (error) => { spawnError = String(error?.message ?? error) })
    child.stderr?.on('data', (chunk) => { if (spawnError.length < 400) spawnError += String(chunk) })
    child.on('exit', (code) => { exitCode = code })
    child.unref()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(120)
      const probe = await probeRisd({ home })
      if (probe.usable) return { ok: true, state: probe.state, spawned: true }
      if (probe.reason === 'api-mismatch') return { ok: false, reason: 'api-mismatch', state: probe.state }
      if (exitCode !== null) {
        const hint = spawnError.trim().split('\n').filter(Boolean).slice(-3).join(' | ')
        return {
          ok: false,
          reason: exitCode === 3 ? 'api-mismatch' : exitCode === 4 ? 'port-busy' : 'spawn-exited',
          exitCode,
          error: hint || `daemon exited with code ${exitCode}`,
        }
      }
    }
    return { ok: false, reason: 'spawn-timeout', error: spawnError.trim().slice(-400) || undefined }
  } finally {
    releaseSpawnLock(home)
  }
}

/** Create (or refresh) this process's lease. */
export function acquireLease(state, { ownerPid = process.pid, sessionId = null, cwd = null } = {}) {
  const body = { ownerPid }
  if (typeof sessionId === 'string' && sessionId !== '') body.sessionId = sessionId
  if (typeof cwd === 'string' && cwd !== '') body.cwd = cwd
  return risdRequest(state, '/v1/leases', { method: 'POST', body })
}

/** Release a lease; safe to call from an exit path (no throw, no wait). */
export function releaseLease(state, id) {
  if (id === undefined || id === null) return Promise.resolve({ ok: true, status: 0, body: null })
  return risdRequest(state, `/v1/leases/${encodeURIComponent(String(id))}`, { method: 'DELETE', timeoutMs: 500 })
}

/** Read the daemon's read-only proxy view for a workspace. */
export async function getProxyView(state, cwd) {
  const call = await risdRequest(state, `/v1/proxy?cwd=${encodeURIComponent(cwd)}`)
  return call.ok ? call.body : null
}

/** Daemon config (read-only in 1a). */
export async function getRisdConfig(state) {
  const call = await risdRequest(state, '/v1/config')
  return call.ok ? call.body : null
}

/** Ask the daemon to exit. */
export function shutdownRisd(state) {
  return risdRequest(state, '/v1/shutdown', { method: 'POST', body: { reason: 'plugin' }, timeoutMs: 1000 })
}

/**
 * Write the machine-wide table through the daemon (Phase 1b P4).
 * @returns the raw `{ ok, status, body }` call so the caller can relay a 409
 *   conflict verbatim instead of flattening it into "failed".
 */
export function saveProxy(state, { cwd, config, revision, gitHost } = {}) {
  const body = { cwd, config }
  if (typeof revision === 'string' && revision !== '') body.revision = revision
  if (typeof gitHost === 'string' && gitHost !== '') body.gitHost = gitHost
  return risdRequest(state, '/v1/proxy', { method: 'POST', body })
}

/** Run one of the three-layer actions (engine + bridge + git) in the daemon. */
export function proxyAction(state, { cwd, action, gitHost, ruleId, interactive } = {}) {
  const body = { cwd, action }
  if (typeof gitHost === 'string' && gitHost !== '') body.gitHost = gitHost
  if (typeof ruleId === 'string' && ruleId !== '') body.ruleId = ruleId
  // Only an explicit click sets this: a password dialog must never be a side
  // effect of saving rules or of dsh starting (m13910).
  if (interactive === true) body.interactive = true
  return risdRequest(state, '/v1/action', { method: 'POST', body })
}

/** Env/args a launched program needs to use the tunnel (parity with the plugin). */
/** The daemon's program rows (same pipeline as the panel, so ids/logNames match). */
export async function listPrograms(state, cwd, { dir = '', refresh = false } = {}) {
  const params = new URLSearchParams({ cwd })
  if (dir !== '') params.set('dir', dir)
  if (refresh === true) params.set('refresh', '1')
  return risdRequest(state, `/v1/programs?${params.toString()}`)
}

/** start | stop | restart one program; returns the raw `{ok,status,body}` to relay. */
export async function programAction(state, { cwd, action, id, dir = '' }) {
  return risdRequest(state, '/v1/programs', {
    method: 'POST',
    body: { cwd, action, id, dir },
    timeoutMs: action === 'start' || action === 'restart' ? 120000 : 15000,
  })
}

/** One log window; pass the previous `nextOffset` to follow. */
export async function readProgramLog(state, { cwd, id, dir = '', offset = null, bytes = null }) {
  const params = new URLSearchParams({ cwd, id })
  if (dir !== '') params.set('dir', dir)
  if (Number.isFinite(offset)) params.set('offset', String(offset))
  if (Number.isFinite(bytes)) params.set('bytes', String(bytes))
  return risdRequest(state, `/v1/programs/log?${params.toString()}`, { timeoutMs: 10000 })
}

/**
 * Open the SSE log-follow stream and hand the raw response to the caller.
 * The plugin relays the bytes unchanged (SSE headers must survive), so this
 * deliberately returns the `IncomingMessage` instead of parsing frames.
 */
export function openProgramLogStream(state, { cwd, id, dir = '', offset = null, bytes = null } = {}) {
  const params = new URLSearchParams({ cwd, id })
  if (dir !== '') params.set('dir', dir)
  if (Number.isFinite(offset)) params.set('offset', String(offset))
  if (Number.isFinite(bytes)) params.set('bytes', String(bytes))
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port: state.port,
      path: `/v1/programs/log/stream?${params.toString()}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${state.token}`,
        'x-risd-api-version': String(RISD_API_VERSION),
        accept: 'text/event-stream',
      },
    }, (res) => resolve({ ok: res.statusCode === 200, status: res.statusCode, res, req }))
    req.on('error', (error) => resolve({ ok: false, status: 0, res: null, req: null, error: String(error?.message ?? error) }))
    req.end()
  })
}

/**
 * P4: one JDWP action, verbatim. The daemon owns the sessions and the single
 * owner it tracks; the tool layer only maps its action names onto this one.
 * @param {object} state
 * @param {object} body - {action, cwd, id, ...action arguments, sessionId}
 */
export function debugAction(state, body) {
  return risdRequest(state, '/v1/debug', { method: 'POST', body, timeoutMs: 120_000 })
}

export async function getInjection(state, cwd, program) {
  const call = await risdRequest(state, `/v1/injection?cwd=${encodeURIComponent(cwd)}&program=${encodeURIComponent(program)}`)
  return call.ok ? call.body : null
}
