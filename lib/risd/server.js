/**
 * risd — the daemon itself (Phase 1a: single instance, token, leases, read-only view).
 *
 * Why a separate process at all: the proxy is a machine-level resource, but the
 * dsh process that used to own it is a per-session, restartable thing. Moving
 * ownership into a daemon decouples the two; the plugin then holds a lease
 * instead of a process handle. Phase 1a deliberately stops at the read-only
 * half: the engine is still started/stopped by the plugin, so nothing about
 * today's behaviour changes until `daemonMode=auto` opts in.
 *
 * The only listener is 127.0.0.1. Every endpoint except `/v1/health` needs the
 * token from `risd.json` AND the API version header — a stale plugin talking to
 * a newer daemon gets a 409 it can explain, not a 404 or a silent mismatch.
 *
 * @module dsh-risd/server
 */
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RISD_PORT, RISD_API_VERSION, newRisdToken, readRisdState, removeRisdState, writeRisdState } from './state.js'
import { createLeaseRegistry } from './leases.js'
import { injectionFor, mergeConfigs, pidAlive, proxyHomeDir, proxyLogPath, proxyPid, proxyStatus, readProxyConfig, readTail, startProxy, stopProxy, writeProxyConfig } from '../proxy.js'
import { BUNDLE_URLS, MAX_TGZ_BYTES, ensureBundle, installDir, installFromTgz, isInstalled, readManifest, resolveBundleUrls } from '../proxybridge-bundle.js'
// The digest helpers are part of the bundle module's contract for this release but
// arrive with the download/upload work; access them through the namespace so this
// module keeps loading (and verification stays disabled) if they are absent.
import * as bundleApi from '../proxybridge-bundle.js'
import { armJanitor, disarmJanitor, janitorStatus, markJanitorHandoff } from '../janitor.js'
import { reloadRedirectorsWithProfile, redirectorStatusCached, startRedirectors, stopRedirector, writeHeartbeat } from '../redirector.js'
import { risdConfigRevision, risdProxyView } from './view.js'
import { clearGitProxy, reconcileGitProxy, syncGitProxy } from './git.js'
import { findProgram, listPrograms, readProgramLog, restartProgramByKey, startLogFollow, startProgramByKey, stopProgramByKey } from './programs.js'
import { reconcileStartupLeftovers } from '../startup.js'
import { createDebugEngine } from './debug.js'
import { mergeLifecycle, readLifecycle, writeLifecycle } from './lifecycle.js'
import { risdUiHtml } from './ui.js'
import { pingSocks } from './ping.js'
import { buildStamp } from './build.js'
import { DebugError, debugErrorStatus } from '../debug/engine.js'

/** Request bodies are tiny JSON objects; anything bigger is a bug or an attack. */
export const RISD_MAX_BODY_BYTES = 64 * 1024
/**
 * A streamed body (only the bundle upload does this) may not hold the request open
 * forever: a stalled upload used to keep a handler alive until the socket died.
 */
export const RISD_BODY_TIMEOUT_MS = 15_000
/** How long a would-be second instance waits for the incumbent's health answer. */
export const START_PROBE_TIMEOUT_MS = 500
/** Header the plugin sends on every authenticated call. */
export const API_VERSION_HEADER = 'x-risd-api-version'

/** Where the plugin reports its own origin + current sessionId (see /v1/dsh). */
export const DSH_WINDOW_FILENAME = 'dsh-window.json'
/** A window with an entry younger than this is marked live in the page. */
const DSH_WINDOW_LIVE_MS = 5 * 60_000
/** Remembered windows older than this are pruned; between the two they show as
 * "未活跃" but stay selectable (m08268: clicking one may still open the IDE). */
const DSH_WINDOW_RETAIN_MS = 7 * 24 * 60 * 60_000

/** The daemon's own page is only for the local browser (no DNS rebinding). */
export function isLoopbackHost(req) {
  const raw = String(req.headers.host ?? '')
  const host = raw.replace(/^\[/, '').replace(/\](?::\d+)?$/, '')
  if (host === '::1') return true
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/** True for an `Origin` header that points at this machine (the page's own origin). */
export function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    const name = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
    return name === '127.0.0.1' || name === 'localhost' || name === '::1'
  } catch {
    return false
  }
}

function json(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, code, message })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > RISD_MAX_BODY_BYTES) {
        // Keep draining instead of destroying the socket here: destroying it made
        // the client see "socket hang up" rather than the 413 the handler writes
        // (review A-P2-6).
        chunks.length = 0
        settle(reject, Object.assign(new Error('body too large'), { code: 'too-large' }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => settle(reject, error))
  })
}

/**
 * Raw bodies are only used by the bundle upload, which is a .tgz and therefore
 * exceeds the JSON limit. The cap comes from the bundle module, so a body that
 * could not possibly be a valid bundle is rejected before it is buffered whole.
 */
function readBodyBytes(req, limit, timeoutMs = RISD_BODY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const timer = setTimeout(() => {
      chunks.length = 0
      settle(reject, Object.assign(new Error('body read timed out'), { code: 'timeout' }))
      req.resume()
    }, timeoutMs)
    timer.unref?.()
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        settle(reject, Object.assign(new Error('body too large'), { code: 'too-large' }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(resolve, Buffer.concat(chunks)))
    req.on('error', (error) => settle(reject, error))
  })
}

/** One download at a time; the page polls GET /v1/proxybridge for the outcome. */
let bundleDownload = null
let bundleDownloadResult = null

/**
 * The digest this machine expects the bundle to have. `''` means "do not verify,
 * just record" (the module's own convention); the value can come from the env or
 * the machine settings so an internal mirror can pin its own archive.
 */
function bundleExpectedSha256(settings = readBundleSettings()) {
  try {
    if (typeof bundleApi.resolveBundleSha256 === 'function') {
      return String(bundleApi.resolveBundleSha256({ env: process.env, settings }) ?? '')
    }
  } catch { /* fall through to the compiled-in digest */ }
  return typeof bundleApi.BUNDLE_SHA256 === 'string' ? bundleApi.BUNDLE_SHA256 : ''
}

function proxyBridgeStatus() {
  const dir = installDir(proxyHomeDir())
  const installed = isInstalled(dir)
  const manifest = installed ? readManifest(dir) : null
  const settings = readBundleSettings()
  // A bad override (typo'd settings.proxybridgeUrl) must not take the status route
  // down with it: the safe resolver reports the error and falls back to the mirrors.
  const resolved = typeof bundleApi.resolveBundleUrlsSafe === 'function'
    ? bundleApi.resolveBundleUrlsSafe({ env: process.env, settings })
    : { urls: resolveBundleUrls({ env: process.env, settings }), error: '' }
  const urls = resolved.urls
  const urlError = resolved.error === '' ? null : resolved.error
  const sha256 = bundleExpectedSha256(settings)
  const actual = manifest === null ? null : manifest.sha256 ?? null
  return {
    ok: true,
    installed,
    dir,
    // Gitee first, GitHub second: both carry the release asset.
    urls,
    url: urls[0] ?? BUNDLE_URLS[0],
    urlError,
    // What an upload/download MUST hash to, and whether the installed copy does.
    sha256,
    actualSha256: actual,
    verified: installed === true && (sha256 === '' || actual === sha256),
    downloading: bundleDownload !== null,
    result: bundleDownloadResult,
    files: manifest === null ? [] : Object.keys(manifest.files),
    installedAt: manifest === null ? null : manifest.installedAt,
  }
}

/** `proxybridgeUrl` from the machine settings file, if a user set one. */
function readBundleSettings() {
  try {
    const path = join(proxyHomeDir(), 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function startBundleDownload(force = false) {
  if (bundleDownload !== null) return
  const settings = readBundleSettings()
  const expectedSha256 = bundleExpectedSha256(settings)
  // `force` re-fetches even when a verified copy is cached; the maintenance page's
  // 「重新下载」 button sends it (review C3-P2-6).
  bundleDownload = ensureBundle({ home: proxyHomeDir(), settings, expectedSha256, force: force === true })
    .then((result) => {
      bundleDownloadResult = {
        ok: result.ok,
        code: result.ok === true ? null : result.code ?? 'install-failed',
        fromCache: result.fromCache === true,
        error: result.error ?? null,
        expected: result.expected ?? expectedSha256,
        actual: result.actual ?? null,
        sha256: result.sha256 ?? null,
        at: new Date().toISOString(),
      }
      return result
    })
    .catch((error) => {
      bundleDownloadResult = {
        ok: false,
        code: error?.code ?? 'download-failed',
        error: error instanceof Error ? error.message : String(error),
        expected: error?.expected ?? expectedSha256,
        actual: error?.actual ?? null,
        at: new Date().toISOString(),
      }
      return null
    })
    .finally(() => { bundleDownload = null })
}

function parseJson(text) {
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function tokenMatches(expected, header) {
  const prefix = 'bearer '
  if (typeof header !== 'string' || !header.toLowerCase().startsWith(prefix)) return false
  const given = header.slice(prefix.length).trim()
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Absolute on this platform or on Windows. `path.isAbsolute` is platform-specific,
 * so a POSIX daemon still has to recognise `C:\work` in a shared table; callers
 * additionally require the directory to exist (review A-P1-3).
 */
export function looksAbsolutePath(value) {
  return typeof value === 'string' && value !== '' && (isAbsolute(value) || win32.isAbsolute(value))
}

function absoluteCwd(value) {
  return looksAbsolutePath(value) ? value : null
}

/**
 * Ask an existing daemon at `port` how it is doing. Used by the election path:
 * EADDRINUSE alone cannot tell "same daemon" from "something else on 11082".
 * @returns `{ ok, body }` or null.
 */
export function probeRisdHealth(port, timeoutMs = START_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const call = request({ host: '127.0.0.1', port, path: '/v1/health', method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          finish({ ok: res.statusCode === 200 && body?.ok === true, body })
        } catch {
          finish(null)
        }
      })
    })
    call.on('error', () => finish(null))
    call.on('timeout', () => {
      call.destroy()
      finish(null)
    })
    const timer = setTimeout(() => {
      call.destroy()
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    call.end()
  })
}

// A restart is requested at most once per process (m11421): a second POST while
// the first successor is being spawned must not start another daemon.
let restarting = false

/** The CLI entry of this package: `bin/risd.mjs` (server.js lives in lib/risd/). */
const RISD_CLI_PATH = fileURLToPath(new URL('../../bin/risd.mjs', import.meta.url))

/**
 * Spawn the successor that takes over after this process exits. Detached+unref'd
 * so it outlives the HTTP server, and `--wait-pid` keeps it from racing us for the
 * port. A failure here is deliberately silent: the page's health poll times out
 * and tells the user to restart by hand.
 */
function spawnRestartSuccessor() {
  try {
    const child = spawn(process.execPath, [RISD_CLI_PATH, 'serve', '--wait-pid', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      cwd: process.cwd(),
    })
    child.unref()
  } catch { /* the page reports the timeout */ }
}

/**
 * Start the daemon.
 *
 * Never throws for the three expected outcomes of a race — the caller maps them
 * to exit codes: `already-running` (0), `api-mismatch` (3), `port-busy` (4).
 *
 * @param options - `{ home, port, version, onShutdown }`.
 * @returns `{ ok, code?, server?, port?, state?, stop? }`.
 */
export async function startRisd({ home, port = DEFAULT_RISD_PORT, version = '0.0.0', onShutdown = null, teardownTimeoutMs = 5000, teardown = null } = {}) {
  // A predecessor may have shut down handing the network over (Phase 1b P6). Read
  // its note before this daemon writes its own state file on top of it.
  const previousState = readRisdState(home)
  // Session policy: when the last lease disappears the network has no consumer, so
  // the owner (this daemon) tears it down — in the documented order git → bridge →
  // engine. Phase 1b P2 only owns the engine; git/bridge teardown lands with their
  // ownership (P5), and until then those steps are the plugin's.
  const TEARDOWN_DELAY_MS = 300
  let teardownTimer = null
  /**
   * Take the network down in the documented order: git entry → system-level
   * bridge → engine. Each step is best-effort and idempotent; the point is that a
   * half step never leaves a client pointing at a listener that is already gone.
   */
  async function teardownNetwork(cwd) {
    try { await clearGitProxy() } catch { /* best effort */ }
    try { await serializeBridge(() => stopRedirector()) } catch { /* best effort */ }
    if (cwd !== null) {
      try { await stopProxy(cwd) } catch { /* best effort */ }
    }
  }
  function scheduleTeardown() {
    if (leases.count() > 0) return
    if (engineCwd === null && heartbeat === null) return
    if (teardownTimer !== null) return
    teardownTimer = setTimeout(() => {
      teardownTimer = null
      void (async () => {
        if (leases.count() > 0) return  // someone came back
        // Per-resource policy: "follow dsh" stops it with the last window; the
        // daemon-owned ones stay until the daemon itself stops (or forever).
        if (lifecycle.debug.followDsh === true) await debug.stopAll().catch(() => {})
        if (lifecycle.programs.followDsh === true) await stopAllPrograms()
        const cwd = engineCwd
        if (lifecycle.proxy.followDsh === true) {
          await teardownNetwork(cwd)
          if (engineCwd === cwd) engineCwd = null
        }
        // Idle exit (not an immediate one): a window may release its lease and
        // re-take it a moment later; the daemon only retires after the configured
        // idle window with nothing left to serve.
        if (leases.count() === 0 && engineCwd === null) scheduleIdleExit()
      })()
    }, TEARDOWN_DELAY_MS)
    teardownTimer.unref?.()
  }
  const leases = createLeaseRegistry({ onGone: () => scheduleTeardown() })
  // JDWP sessions live here too (Phase 2-lite P3): a single socket to one JVM, so a
  // dsh restart must not drop it and a second window must not attach over it.
  const debug = createDebugEngine({ home })
  // Workspaces the daemon has served at least one request for. The own page has no
  // dsh session to ask, so it offers these as shortcuts (in memory: a restart
  // simply starts the list over).
  const workspaces = new Set()
  /** Remember one workspace for the maintenance page (cap keeps the page honest). */
  function rememberWorkspace(cwd) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) return
    if (workspaces.has(cwd)) return
    workspaces.add(cwd)
    while (workspaces.size > 8) workspaces.delete(workspaces.values().next().value)
  }
  // One debug action at a time: attach/detach and stepping share the JDWP socket.
  let debugOp = Promise.resolve()
  /** Queue a debug action behind the previous one (order matters for stepping). */
  function serializeDebug(task) {
    const run = debugOp.then(task, task)
    debugOp = run.then(() => undefined, () => undefined)
    return run
  }
  const IDLE_EXIT_MS = 10 * 60 * 1000
  // Which resources follow a dsh session, and which follow this daemon. Read at
  // start, updated by POST /v1/config; the rules below are the only readers.
  const lifecycleRead = readLifecycle(home)
  let lifecycle = lifecycleRead.value
  // A lifecycle file the daemon could not parse is not fatal: defaults run, and
  // GET /v1/config reports the parse errors (read fresh on every GET so a hand
  // edit shows up without a restart).
  let idleTimer = null
  function cancelIdleExit() {
    if (idleTimer === null) return
    clearTimeout(idleTimer)
    idleTimer = null
  }
  function scheduleIdleExit() {
    // "daemon follows dsh = false" means: stay up until someone stops me.
    if (lifecycle.daemon.followDsh !== true) return
    if (idleTimer !== null) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      // A daemon opened from the maintenance page has no lease at all, yet may be
      // supervising programs or a debug session: idling out would kill them.
      void hasActiveWork().then((active) => {
        // An owned engine means the network is a service (proxy.followDsh=false) or
        // somebody is using it without a lease: retiring would tear it down, which
        // is exactly what "follow daemon" promised not to do (review A2-P2-3).
        if (!active && engineCwd === null) return stop()
        scheduleIdleExit()
        return undefined
      })
    }, IDLE_EXIT_MS)
    idleTimer.unref?.()
  }

  /** Anything a "stop the daemon" would have to kill: running programs or JDWP. */
  async function hasActiveWork() {
    if (debug.size > 0) return true
    for (const cwd of workspaces) {
      if (!existsSync(cwd)) continue
      try {
        const listed = await listPrograms(cwd, {})
        if (listed.programs.some((row) => row.running !== null && row.running !== undefined && row.running.alive === true)) return true
      } catch { /* an unreadable workspace cannot be running anything we know */ }
    }
    return false
  }

  /**
   * Stop every program this daemon supervises (the ones with a live `<log>.pid`).
   * Called only for a real shutdown, never for a handoff: a successor keeps them.
   */
  async function stopAllPrograms() {
    const cwds = new Set(workspaces)
    if (typeof engineCwd === 'string' && engineCwd !== '') cwds.add(engineCwd)
    for (const cwd of cwds) {
      if (!existsSync(cwd)) continue
      try {
        const listed = await listPrograms(cwd, {})
        for (const row of listed.programs) {
          if (row.running === null || row.running === undefined || row.running.alive !== true) continue
          try { await stopProgramByKey(cwd, row.id, { dir: listed.dir }) } catch { /* keep going: one stuck program must not block the rest */ }
        }
      } catch { /* the workspace may have vanished */ }
    }
  }
  const startedAt = new Date().toISOString()
  // The daemon code the page will render: captured NOW, because Node caches the
  // module graph for the life of the process (see build.js).
  const uiBuildLoaded = buildStamp()
  const token = newRisdToken()
  // The workspace the engine was last started for. Kept in memory on purpose: it
  // is ownership evidence for this daemon instance, not durable configuration
  // (a restart re-discovers the engine by pidfile and reports owned:false until
  // someone starts/stops it again).
  let engineCwd = null
// Last background enforcement reload (POST /v1/proxy hands the slow part off, so a
// save returns in milliseconds instead of waiting ~8s for two PowerShell probes).
let bridgeReloadState = { at: 0, ok: true, note: '' }
  // The daemon is the heartbeat writer once it owns the bridge: the elevated
  // watchdog tears the bridge down when the file is older than 20 s, and a plugin
  // that is closing (Ctrl+C) must no longer be the one keeping it alive.
  let heartbeat = null
  // Engine operations are serialized: two windows pressing 启动 must not race the
  // pidfile (startProxy is idempotent, but stop-after-start must stay ordered).
  let engineOp = Promise.resolve()
  /**
   * Queue one engine operation behind the previous one. A rejected task must not
   * poison the chain: without `then(task, task)` one start failure turned every
   * later engine control into an immediate 500 (review A-P1-1).
   * @param {Function} task - async work.
   * @returns {Promise<any>} the task's own result.
   */
  function serializeEngine(task) {
    const run = engineOp.then(task, task)
    engineOp = run.then(() => undefined, () => undefined)
    return run
  }
  // Program start/stop share one queue so two clicks cannot spawn the same row twice.
  let programOp = Promise.resolve()
  // Bridge (ProxyBridge) operations are serialized too (E8): a rule reload and a
  // stop are two single-file handshakes with the elevated watchdog, and running
  // them concurrently can reload a profile the other side is already tearing down.
  let bridgeOp = Promise.resolve()
  /**
   * Queue one bridge operation behind the previous one.
   * @param {Function} task - async work; may throw, the queue keeps going.
   * @returns {Promise<any>} the task's own result.
   */
  function serializeBridge(task) {
    const run = bridgeOp.then(task, task)
    bridgeOp = run.then(() => undefined, () => undefined)
    return run
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'

      // Machine-local API: no CORS support at all. Refuse a request addressed to
      // another host name (DNS rebinding) and one carrying a foreign Origin (a web
      // page probing localhost). Without this, a rebound page could read the token
      // from /ui and drive the daemon (review A-P1-4).
      if (!isLoopbackHost(req)) return fail(res, 403, 'forbidden', 'this API answers loopback requests only')
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        return fail(res, 403, 'forbidden', 'cross-origin requests are not allowed')
      }

      if (path === '/v1/health') {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', 'GET only')
        return json(res, 200, {
          ok: true,
          apiVersion: RISD_API_VERSION,
          version,
          pid: process.pid,
          startedAt,
          // Identifies THIS daemon process to a page that embedded the value at
          // /ui load time. A restart (new process, new token) always changes it, so
          // the page can reload itself instead of answering 401 forever (review A3-P1-1).
          instance: startedAt,
          uptimeMs: Date.now() - Date.parse(startedAt),
          state: 'ready',
          side: process.platform,
          port: server.address()?.port ?? port,
          home,
          leases: { count: leases.count() },
          engine: engineSummary(),
          ui: '/ui',
          // `loaded` names the code this process runs, `disk` the code a restart
          // would load; the page reloads itself when they diverge in the first way
          // and nudges for a restart in the second (review m09693).
          uiBuild: { loaded: uiBuildLoaded, disk: buildStamp() },
          heartbeat: heartbeat !== null,
          janitor: { armed: janitorStatus().running === true, ownerPid: process.pid },
        })
      }

      if ((path === '/ui' || path === '/ui/') && method === 'GET') {
        // The only unauthenticated page: served to a local browser only, with the
        // token inlined. Anything able to load it can read risd.json anyway.
        if (!isLoopbackHost(req)) return fail(res, 403, 'forbidden', 'this page answers loopback requests only')
        const html = risdUiHtml({ token, version, home, apiVersion: RISD_API_VERSION, uiBuild: { loaded: uiBuildLoaded }, uiInstance: startedAt })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
          // Loopback page holding the daemon token: never frame it, never let it
          // load anything but loopback (the IDE tab embeds dsh) (review C-P2-5).
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          // The IDE tab embeds the dsh host in a frame; without this the frame's
          // navigator.clipboard.writeText is rejected by permissions policy and a
          // 「复制文件路径」 would surface as a background-task error (m09396 ③).
          'permissions-policy': 'clipboard-write=*, clipboard-read=*',
          'referrer-policy': 'no-referrer',
          'content-security-policy': [
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            'img-src data:',
            'connect-src http://127.0.0.1:* http://localhost:*',
            'frame-src http://127.0.0.1:* http://localhost:*',
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
        })
        res.end(html)
        return undefined
      }

      if (!tokenMatches(token, req.headers.authorization)) {
        return fail(res, 401, 'unauthorized', 'missing or invalid bearer token (read risd.json)')
      }
      if (String(req.headers[API_VERSION_HEADER] ?? '') !== String(RISD_API_VERSION)) {
        return fail(res, 409, 'api-mismatch', `client speaks apiVersion ${req.headers[API_VERSION_HEADER] ?? 'none'}, daemon speaks ${RISD_API_VERSION}`)
      }

      if (path === '/v1/workspaces' && method === 'GET') {
        return json(res, 200, { ok: true, workspaces: [...workspaces] })
      }

      if (path === '/v1/dsh' && method === 'GET') {
        // Which workspaces have a live dsh window? The plugin keeps dsh-window.json
        // as an upserted list (origin + sessionId per workspace), so one daemon page
        // can switch between workspaces' IDE instead of opening one page per cwd.
        let windows = []
        try {
          const parsed = JSON.parse(readFileSync(join(home, DSH_WINDOW_FILENAME), 'utf8'))
          if (Array.isArray(parsed?.windows)) windows = parsed.windows
        } catch { /* absent or rotated away: no dsh */ }
        const now = Date.now()
        let droppedAt = 0
        const live = windows
          .filter((row) => row !== null && typeof row === 'object' && typeof row.url === 'string' && row.url !== '')
          // The page hands this URL to window.open(); anything but a loopback
          // http(s) origin would let a crafted dsh-window.json point the IDE tab
          // somewhere else (review A-P2-10).
          .filter((row) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(row.url))
          .map((row) => {
            const at = Date.parse(String(row.at ?? ''))
            // A timestamp far in the future made `now - at` clamp to 0, so the row
            // stayed "live" for as long as the clock skew lasted (review A2-P2-15);
            // non-finite rows were pruned before anyone could see them (A2-P2-16).
            // Both are treated as junk rather than as fresh.
            const future = Number.isFinite(at) && at > now + 5 * 60_000
            // A numeric `at` (epoch ms is not what the writer stores) and a missing
            // or unparsable one are all junk for the same reason: they cannot be
            // ordered against now. Count them so a caller can tell "no dsh" from
            // "dsh wrote something unusable" (review A3-P2-6).
            if (!Number.isFinite(at) || future) droppedAt += 1
            return {
              cwd: typeof row.cwd === 'string' ? row.cwd : '',
              sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
              url: row.url,
              ageMs: Number.isFinite(at) && !future ? Math.max(0, now - at) : DSH_WINDOW_RETAIN_MS + 1,
            }
          })
          .map((row) => Object.assign(row, { live: row.ageMs <= DSH_WINDOW_LIVE_MS }))
          .filter((row) => row.ageMs <= DSH_WINDOW_RETAIN_MS)
          // Live entries first, then most-recently-seen: the first row is the one an
          // iframe deep link opens by default.
          .sort((a, b) => (a.live === b.live ? a.ageMs - b.ageMs : a.live ? -1 : 1))
        if (live.length === 0) {
          return json(res, 200, { ok: true, available: false, windows: [], dropped: droppedAt, reason: 'dsh 未运行（没有记住的工作区窗口）' })
        }
        const newest = live[0]
        return json(res, 200, {
          ok: true,
          available: true,
          url: newest.url,
          sessionId: newest.sessionId,
          cwd: newest.cwd,
          windows: live,
          dropped: droppedAt,
        })
      }

      if (path === '/v1/proxy/ping' && method === 'GET') {
        // Reachability of the configured SOCKS upstream, for the status chip on the
        // proxy tab. Query overrides let the page test an edited-but-unsaved value.
        const stored = readProxyConfig(url.searchParams.get('cwd') ?? home).socks
        const host = url.searchParams.get('host') ?? stored.host
        const rawPort = url.searchParams.get('port')
        const port = rawPort === null ? stored.port : Number(rawPort)
        const result = await pingSocks({ host, port })
        return json(res, 200, result)
      }

      if (path === '/v1/proxybridge' && method === 'GET') {
        return json(res, 200, proxyBridgeStatus())
      }

      if (path === '/v1/proxybridge/download' && method === 'POST') {
        // Fetching/installing the component is user-visible work: keep the daemon
        // from idling out from under the page while it runs (review A3-P2-3).
        cancelIdleExit()
        // The archive is ~1 MB and installs atomically; answering immediately and
        // letting the page poll keeps a slow mirror from holding the request open.
        // A body is optional here: `{force:true}` re-fetches even when the cached
        // copy still verifies, which is what 「重新下载」 needs.
        const forceBody = await readBody(req).catch(() => '')
        let force = false
        if (typeof forceBody === 'string' && forceBody.trim() !== '') {
          try {
            const parsed = JSON.parse(forceBody)
            force = parsed !== null && typeof parsed === 'object' && parsed.force === true
          } catch { force = false }
        }
        startBundleDownload(force)
        return json(res, 200, proxyBridgeStatus())
      }

      if (path === '/v1/proxybridge/upload' && method === 'POST') {
        cancelIdleExit()
        let bytes
        try {
          bytes = await readBodyBytes(req, MAX_TGZ_BYTES)
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'too-large') {
            return fail(res, 413, 'too-large', `压缩包超过 ${MAX_TGZ_BYTES} 字节上限`)
          }
          if (error !== null && typeof error === 'object' && error.code === 'timeout') {
            return fail(res, 408, 'timeout', '上传超时：15 秒内没有收完压缩包')
          }
          return fail(res, 400, 'bad-request', error instanceof Error ? error.message : String(error))
        }
        const settings = readBundleSettings()
        const expectedSha256 = bundleExpectedSha256(settings)
        let result
        try {
          result = installFromTgz({ home: proxyHomeDir(), bytes, expectedSha256 })
        } catch (error) {
          // A digest mismatch is a different repair instruction than a malformed
          // archive: the caller must see which digest was expected (review A3-P2-7).
          if (error !== null && typeof error === 'object' && error.code === 'hash-mismatch') {
            return json(res, 400, {
              ok: false,
              code: 'hash-mismatch',
              message: error instanceof Error ? error.message : String(error),
              expected: error.expected ?? expectedSha256,
              actual: error.actual ?? null,
            })
          }
          return json(res, 400, { ok: false, code: 'bad-bundle', message: error instanceof Error ? error.message : String(error), hint: '需要一个包含 8 个 ProxyBridge 文件的 .tgz' })
        }
        if (result.ok !== true) {
          return json(res, 400, {
            ok: false,
            code: result.code ?? 'bad-bundle',
            message: result.error,
            hint: result.hint,
            expected: result.expected ?? expectedSha256,
            actual: result.actual ?? null,
          })
        }
        const uploadedFiles = Array.isArray(result.files) ? result.files : []
        return json(res, 200, {
          ok: true,
          installed: true,
          dir: result.dir,
          files: uploadedFiles,
          fileCount: uploadedFiles.length,
          sha256: result.sha256 ?? null,
          expectedSha256,
          verified: expectedSha256 === '' || result.sha256 === expectedSha256,
        })
      }

      if (path === '/v1/proxy/log' && method === 'GET') {
        const bytes = Math.min(Math.max(Number(url.searchParams.get('bytes') ?? 40960) || 40960, 1024), 256 * 1024)
        const logPath = proxyLogPath()
        return json(res, 200, { ok: true, path: logPath, text: readTail(logPath, bytes) })
      }

      if (path === '/v1/debug' && method === 'POST') {
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        const action = String(parsed.action ?? '')
        const needsCwd = action !== 'sessions' && action !== 'detach' && action !== 'events'
        if (needsCwd) {
          const cwd = absoluteCwd(parsed.cwd)
          if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
          if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
          rememberWorkspace(cwd)
          parsed.cwd = cwd
        }
        if (action === 'start') cancelIdleExit()
        const result = await serializeDebug(() => debug.run(parsed))
        return json(res, 200, Object.assign({ ok: true }, result))
      }

      if (path === '/v1/proxy' && method === 'POST') {
        // The write half moved here in Phase 1b P4: the daemon is the only writer
        // of the machine-wide table, so two windows (or a window and the CLI) can no
        // longer interleave a read-modify-write and silently drop rows.
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        const cwd = parsed.cwd === undefined || parsed.cwd === null ? home : absoluteCwd(parsed.cwd)
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
        const incoming = parsed.config !== null && typeof parsed.config === 'object' ? parsed.config : {}
        const stored = readProxyConfig(cwd)
        const currentRevision = risdConfigRevision(stored)
        const baseRevision = typeof parsed.revision === 'string' ? parsed.revision.trim() : ''
        if (baseRevision !== '' && baseRevision !== currentRevision) {
          return json(res, 409, {
            ok: false,
            conflict: true,
            code: 'conflict',
            message: '规则表已在别处被修改，本次改动未写入',
            revision: currentRevision,
            // The design promises the losing writer a fresh view so a direct API
            // client can merge without a second round trip (review A-P2-1).
            view: await risdProxyView(cwd),
          })
        }
        const rows = Array.isArray(incoming.rules)
          ? incoming.rules
            .filter((rule) => rule !== null && typeof rule === 'object')
            .map((rule) => Object.assign({}, rule, { workspace: rule.workspace ?? cwd }))
          : []
        const keptIds = new Set(rows.map((rule) => String(rule.id ?? '')))
        // One machine-wide table, and this payload IS the table: a row the caller did
        // not send is gone (m10585). The old protocol let a client declare which
        // sources it spoke for, which kept rows alive that no UI could show — the
        // 「别的工作区还配着」 state the user asked us to drop. Callers that only own
        // a slice of the table (yds) therefore read first and PUT the complete set.
        //
        // `replaceRulesFrom` is kept as a one-release compatibility shim: an older
        // dsh-ris-yds sends only its own rows, and treating that as a complete table
        // would delete the user's rows. New callers omit it; the panel never sends it.
        let legacySource = null
        if (parsed.replaceRulesFrom !== undefined) {
          const sources = Array.isArray(parsed.replaceRulesFrom) ? parsed.replaceRulesFrom : []
          if (sources.length > 0 && sources.every((source) => source === 'yds')) legacySource = 'yds'
        }
        const retired = new Set(
          stored.rules
            .filter((rule) => {
              if (keptIds.has(String(rule.id ?? ''))) return false
              return legacySource === null ? true : rule.source === legacySource
            })
            .map((rule) => rule.id),
        )
        const written = mergeConfigs(
          Object.assign({}, stored, { rules: stored.rules.filter((rule) => !retired.has(rule.id)) }),
          { socks: incoming.socks, listenPort: incoming.listenPort, rules: rows, workspace: cwd },
        )
        writeProxyConfig(cwd, written)
        // Clean up what the OLD table applied before the new one takes effect. The
        // git entry is host-scoped and nothing else rewrites it on save, so a changed
        // or deleted git rule used to leave terminals pointed at a dead tunnel.
        const git = await serializeBridge(() => reconcileGitProxy({ cwd, host: typeof parsed.gitHost === 'string' ? parsed.gitHost : '' }))
        // Revoke the previous enforcement as part of the switch: ProxyBridge parses
        // its profile only at start, so a reload that fails would otherwise keep the
        // OLD rules intercepting while the dialog claims the save worked. The wait is
        // real (two synchronous PowerShell probes on WSL ≈ 8s), so the save returns
        // first and the switch runs right after it; the page reads the outcome from
        // `bridge` on its next load (m10585). Saves are serialized by serializeBridge,
        // and each reload re-reads the file, so a burst of edits still lands on the
        // last table.
        const revoke = async (reason) => {
          const stopped = await serializeBridge(() => stopRedirector())
          return `${reason}；${stopped.stopped === true
            ? '已停止系统层拦截，避免继续按旧规则代理'
            : `未能停止系统层拦截（${stopped.reason ?? '未知原因'}），旧规则可能仍在生效`}`
        }
        const switchEnforcement = async () => {
          try {
            if (redirectorStatusCached().running !== true) {
              bridgeReloadState = { at: Date.now(), ok: true, note: '' }
              return
            }
            // On Windows only the `windows` side exists; asking for `local` produced a
            // permanent "skipped" note and a misleading sudo hint (review A2-P2-14).
            const reloadSides = process.platform === 'win32' ? ['windows'] : ['windows', 'local']
            const reload = await serializeBridge(() => reloadRedirectorsWithProfile(cwd, { sides: reloadSides }))
            const done = Array.isArray(reload.reloaded) ? reload.reloaded : []
            const skipped = Array.isArray(reload.skipped) ? reload.skipped : []
            if (done.length > 0) {
              bridgeReloadState = { at: Date.now(), ok: true, note: '系统层拦截已按新规则自动重启' }
              return
            }
            const note = await revoke(`系统层拦截未重载：${skipped.map((item) => `${item.side}:${item.reason}`).join('；') || reload.reason || '未知原因'}`)
            bridgeReloadState = { at: Date.now(), ok: false, note }
          } catch (error) {
            const note = await revoke(`系统层拦截未重载：${error?.message ?? error}`)
            bridgeReloadState = { at: Date.now(), ok: false, note }
          }
        }
        setImmediate(() => { switchEnforcement().catch(() => {}) })
        return json(res, 200, {
          ok: true,
          revision: risdConfigRevision(written),
          reloadNote: '规则已保存；系统层拦截正在后台按新规则重启',
          git,
        })
      }

      if (path === '/v1/action' && method === 'POST') {
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        const cwd = absoluteCwd(parsed.cwd)
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
        const action = typeof parsed.action === 'string' ? parsed.action : 'status'
        const gitHost = typeof parsed.gitHost === 'string' ? parsed.gitHost : undefined
        let result
        if (action === 'start') {
          result = await serializeEngine(async () => {
            const engine = await startProxy(cwd)
            const redirector = await serializeBridge(() => startRedirectors())
            const git = await syncGitProxy({ cwd, host: gitHost, enabled: true })
            if (engine.ok === true) {
              engineCwd = cwd
              cancelIdleExit()
            }
            return Object.assign({}, engine, { redirector, git })
          })
        } else if (action === 'stop') {
          result = await serializeEngine(async () => {
            const git = await syncGitProxy({ cwd, host: gitHost, enabled: false })
            const redirector = await serializeBridge(() => stopRedirector())
            const stopped = await stopProxy(cwd)
            if (stopped.ok === true) {
              engineCwd = null
              // Nothing holds the daemon open after an explicit 停止; without this
              // it stayed resident until the next lease event even though the page
              // was the only owner (review A3-P2-4).
              if (leases.count() === 0) scheduleIdleExit()
            }
            return Object.assign({}, stopped, { redirector, git })
          })
        } else if (action === 'status') {
          result = { engine: engineSummary(), redirector: redirectorStatusCached() }
        } else if (action === 'git-on' || action === 'git-off') {
          // The git table changes the machine config through exactly one helper,
          // syncGitProxy, which records key+value so cleanup only removes our own
          // entry. Direct runGitConfig calls here left no bookkeeping and could
          // unset a key the current table no longer calculates (review B-P2-5).
          result = await syncGitProxy({ cwd, host: gitHost, enabled: action === 'git-on' })
        } else if (action === 'redirector-sync' || action === 'redirector-start') {
          const { syncRedirector } = await import('../redirector.js')
          result = await serializeBridge(() => syncRedirector(cwd, { start: action === 'redirector-start' }))
        } else if (action === 'redirector-stop') {
          result = await serializeBridge(() => stopRedirector())
        } else if (action === 'redirector-restart') {
          // Stop first so nothing keeps intercepting with the parsed-at-start profile,
          // then start again from the profile written by the save that requested this.
          result = await serializeBridge(async () => {
            const stopped = await stopRedirector()
            await new Promise((resolve) => setTimeout(resolve, 300))
            const started = await startRedirectors()
            return {
              stopped,
              started: started.started ?? [],
              skipped: started.skipped ?? [],
              running: started.running === true,
            }
          })
        } else {
          return fail(res, 400, 'bad-request', `unknown proxy action "${action}"`)
        }
        return json(res, 200, { ok: true, action, result })
      }

      if (path === '/v1/injection' && method === 'GET') {
        const cwd = absoluteCwd(url.searchParams.get('cwd'))
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        const program = String(url.searchParams.get('program') ?? '')
        if (program === '') return fail(res, 400, 'bad-request', 'program is required')
        return json(res, 200, { ok: true, cwd, program, injection: injectionFor(program, readProxyConfig(cwd)) })
      }

      if (path === '/v1/programs') {
        if (method === 'GET') {
          const cwd = absoluteCwd(url.searchParams.get('cwd'))
          if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
          if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
          rememberWorkspace(cwd)
          const dir = String(url.searchParams.get('dir') ?? '')
          const refreshRaw = url.searchParams.get('refresh')
          const refresh = refreshRaw === '1' || refreshRaw === 'true'
          const listed = await listPrograms(cwd, { dir, refresh })
          return json(res, 200, { ok: true, cwd, dir: listed.dir, programs: listed.programs })
        }
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', 'GET or POST')
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        const cwd = absoluteCwd(parsed.cwd)
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
        // Every cwd a program is started in becomes a workspace this daemon
        // supervises: "stop the daemon" walks that set and stops those programs.
        rememberWorkspace(cwd)
        const action = parsed.action
        if (action !== 'start' && action !== 'stop' && action !== 'restart') {
          return fail(res, 400, 'bad-request', 'action must be start, stop or restart')
        }
        const key = String(parsed.id ?? parsed.program ?? '')
        if (key === '') return fail(res, 400, 'bad-request', 'id is required')
        if (action !== 'stop') cancelIdleExit()
        const dir = typeof parsed.dir === 'string' ? parsed.dir : ''
        let result
        try {
          result = await (programOp = programOp.then(
            async () => (action === 'start'
              ? startProgramByKey(cwd, key, { dir })
              : action === 'stop'
                ? stopProgramByKey(cwd, key, { dir })
                : restartProgramByKey(cwd, key, { dir })),
            () => ({ ok: false, code: 'program-failed', message: 'previous program operation failed', status: 500 }),
          ))
        } catch (error) {
          return fail(res, error?.status ?? 500, error?.code ?? 'program-failed', error?.message ?? String(error))
        }
        if (result.ok !== true) return fail(res, result.status ?? 500, result.code ?? 'program-failed', result.message ?? 'program operation failed')
        return json(res, 200, Object.assign({ ok: true, action }, result))
      }

      if (path === '/v1/programs/log') {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', 'GET only')
        const cwd = absoluteCwd(url.searchParams.get('cwd'))
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        const key = String(url.searchParams.get('id') ?? '')
        if (key === '') return fail(res, 400, 'bad-request', 'id is required')
        const dir = String(url.searchParams.get('dir') ?? '')
        const offsetRaw = url.searchParams.get('offset')
        const offset = offsetRaw === null || offsetRaw === '' ? null : Number(offsetRaw)
        const bytesRaw = Number(url.searchParams.get('bytes') ?? '')
        const result = await readProgramLog(cwd, key, {
          dir,
          offset: Number.isFinite(offset) ? offset : null,
          bytes: Number.isFinite(bytesRaw) && bytesRaw > 0 ? bytesRaw : undefined,
        })
        if (result.ok !== true) return fail(res, result.status ?? 500, result.code ?? 'log-failed', result.message ?? 'log read failed')
        return json(res, 200, result)
      }

      if (path === '/v1/programs/log/stream') {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', 'GET only')
        const cwd = absoluteCwd(url.searchParams.get('cwd'))
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
        const key = String(url.searchParams.get('id') ?? '')
        if (key === '') return fail(res, 400, 'bad-request', 'id is required')
        const dir = String(url.searchParams.get('dir') ?? '')
        const listed = await listPrograms(cwd, { dir })
        const program = findProgram(listed.programs, key)
        if (program === null) return fail(res, 404, 'no-program', `未找到程序「${key}」`)
        const offsetRaw = url.searchParams.get('offset')
        const offset = offsetRaw === null || offsetRaw === '' ? null : Number(offsetRaw)
        const bytesRaw = Number(url.searchParams.get('bytes') ?? '')
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        let follow = null
        follow = startLogFollow(program, {
          offset: Number.isFinite(offset) ? offset : null,
          bytes: Number.isFinite(bytesRaw) && bytesRaw > 0 ? bytesRaw : undefined,
        }, (frame) => {
          if (frame.type === 'ping') { res.write(': ping\n\n'); return }
          res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
          if (frame.type === 'end') {
            follow?.stop()
            res.end()
          }
        })
        req.on('close', () => follow.stop())
        return
      }

      if (path === '/v1/status' || path === '/v1/proxy') {
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', 'GET or POST')
        // The rule table is machine-wide, so the page may omit cwd; a workspace is
        // only a label kept on rows, and the daemon's home is a valid stand-in.
        const rawCwd = url.searchParams.get('cwd')
        const asked = rawCwd === null ? null : absoluteCwd(rawCwd)
        if (rawCwd !== null && asked === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        // /v1/proxy is machine-wide (the page's rule editor omits cwd); /v1/status
        // still needs to know whose programs to report, so it stays strict.
        if (path === '/v1/status' && asked === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        const cwd = asked ?? home
        if (asked !== null) rememberWorkspace(asked)
        const view = await risdProxyView(cwd)
        // `bridge` is the outcome of the background reload a save kicked off, so the
        // page can report a failed switch without the save having to wait for it.
        return json(res, 200, Object.assign({}, view, { daemon: daemonSummary(), bridge: bridgeReloadState }))
      }

      if (path === '/v1/engine') {
        if (method === 'GET') {
          const cwd = absoluteCwd(url.searchParams.get('cwd')) ?? engineCwd
          if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
          const status = await proxyStatus(cwd)
          return json(res, 200, {
            ok: true,
            cwd,
            engine: {
              owned: engineCwd !== null,
              running: status.running,
              pid: status.pid,
              listen: status.listen,
              logPath: status.logPath,
              socksUrl: status.socksUrl,
            },
          })
        }
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', 'GET or POST')
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        // The maintenance page has no dsh session, so it may start/stop without a
        // workspace: the engine is machine-scoped and only needs an existing cwd
        // for the pidfile, so the daemon home is a fine stand-in.
        const cwd = parsed.cwd === undefined || parsed.cwd === null ? home : absoluteCwd(parsed.cwd)
        if (cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        const action = parsed.action
        if (action !== 'start' && action !== 'stop') return fail(res, 400, 'bad-request', 'action must be start or stop')
        if (!existsSync(cwd)) return fail(res, 400, 'bad-request', `cwd does not exist: ${cwd}`)
        const result = await serializeEngine(async () => {
          if (action === 'start') {
            const started = await startProxy(cwd)
            if (started.ok === true) engineCwd = cwd
            return started
          }
          const stopped = await stopProxy(cwd)
          if (stopped.ok === true) engineCwd = null
          return stopped
        })
        return json(res, 200, { ok: true, cwd, action, result })
      }

      if (path === '/v1/leases') {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', 'POST only')
        const parsed = parseJson(await readBody(req))
        if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
        const ownerPid = Number(parsed.ownerPid)
        if (!Number.isInteger(ownerPid) || ownerPid <= 0) return fail(res, 400, 'bad-request', 'ownerPid must be a positive integer')
        // null is the client's way of saying "no workspace" (a plugin that did not
        // have a cwd at mount time); only a wrong TYPE is a bad request.
        const cwd = parsed.cwd === undefined || parsed.cwd === null ? null : absoluteCwd(parsed.cwd)
        if (parsed.cwd !== undefined && parsed.cwd !== null && cwd === null) return fail(res, 400, 'bad-request', 'cwd must be an absolute path')
        const sessionId = parsed.sessionId === undefined ? null : String(parsed.sessionId)
        cancelIdleExit()
        const lease = leases.acquire({ ownerPid, sessionId, cwd })
        return json(res, 200, { ok: true, lease })
      }

      const leaseMatch = /^\/v1\/leases\/([^/]+)$/.exec(path)
      if (leaseMatch !== null) {
        if (method !== 'DELETE') return fail(res, 405, 'method-not-allowed', 'DELETE only')
        const released = leases.release(decodeURIComponent(leaseMatch[1]))
        if (released) {
          // The window that owned debug sessions is gone. Drop its ownership so the
          // next window is not locked out of every mutating debug action
          // (review B-P1-1).
          if (leases.count() === 0) { try { debug.releaseOwners() } catch { /* ignore */ } }
          scheduleTeardown()
        }
        return json(res, 200, { ok: true, released })
      }

      if (path === '/v1/config') {
        if (method === 'POST') {
          const parsed = parseJson(await readBody(req))
          if (parsed === undefined) return fail(res, 400, 'bad-request', 'body must be a JSON object')
          if (parsed.lifecycle === undefined) return fail(res, 400, 'bad-request', 'lifecycle is required')
          // `null`/`[]` used to be written back as the defaults, i.e. a request with
          // no usable value silently reset the policy (review A2-P2-2).
          if (parsed.lifecycle === null || Array.isArray(parsed.lifecycle) || typeof parsed.lifecycle !== 'object') {
            return fail(res, 400, 'bad-request', 'lifecycle 必须是对象')
          }
          // Merge over what is on DISK, not over the copy this process loaded:
          // otherwise a hand edit made while the daemon runs is overwritten by the
          // in-memory copy on the next checkbox save (review A3-P2-6). The strict
          // merge copies unknown resources/keys through so normalizeLifecycle is
          // the one place that rejects them (review A3-P1-2).
          const disk = readLifecycle(home)
          const written = writeLifecycle(home, mergeLifecycle(disk.value, parsed.lifecycle))
          if (written.errors.length > 0) return fail(res, 400, 'bad-request', written.errors.join('; '))
          lifecycle = written.value
          // Re-arm the idle timer with the new policy: turning "follow dsh" off
          // must not leave a timer armed from before the change.
          if (lifecycle.daemon.followDsh !== true) cancelIdleExit()
          else if (leases.count() === 0 && engineCwd === null) scheduleIdleExit()
          return json(res, 200, { ok: true, lifecycle, configPath: join(home, 'risd-lifecycle.json') })
        }
        if (method !== 'GET') return fail(res, 405, 'method-not-allowed', 'GET or POST')
        return json(res, 200, {
          ok: true,
          apiVersion: RISD_API_VERSION,
          keepPolicy: 'session',
          // Report the constant the timers actually use; the old literal was a
          // second source of truth and `engineRestart` described nothing that
          // exists in the daemon (review A-P2-3).
          idleExitMs: IDLE_EXIT_MS,
          lifecycle,
          lifecycleErrors: readLifecycle(home).errors ?? [],
        })
      }

      // m11421: 维护页源码比进程新时，页面上的按钮是「重启并刷新」——光刷新救不了
      // 旧代码（模块图在进程内存里）。这里让 daemon 自己交接：先起一个带 --wait-pid
      // 的后继（等本进程退出后才 bind 端口，避免 already-running），再走 handoff 的
      // stop 路径（保留代理引擎/桥接，由后继收养）。
      if (path === '/v1/restart') {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', 'POST only')
        const already = restarting
        restarting = true
        json(res, 200, { ok: true, restarting: true, pid: process.pid })
        if (!already) {
          setImmediate(() => {
            spawnRestartSuccessor()
            if (onShutdown !== null) onShutdown(true)
          })
        }
        return undefined
      }

      if (path === '/v1/shutdown') {
        if (method !== 'POST') return fail(res, 405, 'method-not-allowed', 'POST only')
        const parsed = parseJson(await readBody(req)) ?? {}
        const handoff = parsed.handoff === true
        json(res, 200, { ok: true, draining: true, handoff })
        if (onShutdown !== null) setImmediate(() => onShutdown(handoff === true))
        return undefined
      }

      return fail(res, 404, 'not-found', `no such endpoint: ${method} ${path}`)
    } catch (error) {
      if (error instanceof DebugError) {
        const code = String(error.code ?? 'debug-failed')
        // `debug-owned` / `not-startable` are the daemon's own codes; the rest map
        // through the engine so the plugin sees the same status as before P3.
        const status = code === 'debug-owned' ? 409
          : code === 'not-startable' ? 400
          : debugErrorStatus(code)
        return fail(res, status, code, String(error.message ?? error))
      }
      const code = String(error?.code ?? '')
      const status = code === 'too-large' ? 413 : code === 'timeout' ? 408 : 500
      const reason = status === 413 ? 'too-large' : status === 408 ? 'timeout' : 'internal'
      return fail(res, status, reason, String(error?.message ?? error))
    }
  }

  const server = createServer(handler)
  // Keep-alive sockets from a dead plugin must not delay shutdown: idle them out
  // after 1s instead of Node's 5s default.
  server.keepAliveTimeout = 1000

  let engineInherited = false

  function engineSummary() {
    // `owned` means "this daemon has started the engine during its lifetime"; a
    // pidfile found at startup is reported as owned:false so the plugin can still
    // show the inherited banner and offer to stop it (Phase 1a behaviour).
    try {
      const pid = proxyPid()
      return { owned: engineCwd !== null, inherited: engineInherited, pid: pid ?? 0, state: pid === null ? 'stopped' : 'running', cwd: engineCwd }
    } catch {
      return { owned: false, inherited: engineInherited, pid: 0, state: 'unknown', cwd: engineCwd }
    }
  }

  function daemonSummary() {
    return { pid: process.pid, version, apiVersion: RISD_API_VERSION, leases: leases.count() }
  }

  const listenResult = await new Promise((resolve) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      resolve({ ok: false, error })
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve({ ok: true })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  if (!listenResult.ok) {
    const error = listenResult.error
    if (error?.code === 'EADDRINUSE') {
      const probe = await probeRisdHealth(port)
      if (probe?.ok === true && Number(probe.body?.apiVersion) === RISD_API_VERSION) {
        // Same port, different home: the other daemon is healthy but its state file
        // lives elsewhere, so two daemons would overwrite each other's token/port
        // and the plugin would talk to whichever wrote last (review A-P2-9).
        if (typeof probe.body?.home === 'string' && probe.body.home !== '' && probe.body.home !== home) {
          return { ok: false, code: 'home-mismatch', found: String(probe.body.home), home, port }
        }
        return { ok: false, code: 'already-running', pid: Number(probe.body?.pid) || 0, port }
      }
      if (probe?.ok === true) {
        return { ok: false, code: 'api-mismatch', found: Number(probe.body?.apiVersion) || 0, port }
      }
      return { ok: false, code: 'port-busy', port }
    }
    return { ok: false, code: 'listen-failed', error }
  }

  const actualPort = server.address()?.port ?? port
  const state = {
    apiVersion: RISD_API_VERSION,
    version,
    pid: process.pid,
    port: actualPort,
    token,
    home,
    startedAt,
    url: `http://127.0.0.1:${actualPort}`,
  }

  try {
    writeRisdState(state, home)
  } catch (error) {
    server.close()
    return { ok: false, code: 'state-write-failed', error }
  }

  // Phase 1b P6 (handoff): the predecessor wrote down what it owned. If that engine
  // is still the one in the pidfile, adopt it instead of reporting owned:false —
  // that is the whole point of handing over: no teardown, no restart, no dropped
  // connection while the plugin restarts the daemon.
  try {
    const handoff = previousState?.handoff
    if (handoff !== null && handoff !== undefined && typeof handoff.cwd === 'string' && handoff.cwd !== '') {
      const pid = proxyPid()
      if (pid !== null && Number(handoff.enginePid) === pid) {
        engineCwd = handoff.cwd
        engineInherited = true
      }
    }
  } catch { /* adoption is best effort: the pidfile decides ownership anyway */ }

  leases.start()

  // Phase 1b P3: the daemon owns the bridge heartbeat and the janitor from the
  // moment it is ready. The plugin no longer writes either while it forwards.
  try {
    writeHeartbeat()
    heartbeat = setInterval(() => {
      try { writeHeartbeat() } catch { /* the watchdog decides; log is best effort */ }
    }, 3000)
    heartbeat.unref?.()
  } catch {
    heartbeat = null
  }
  try {
    armJanitor({ ownerPid: process.pid })
  } catch { /* a janitor failure must not keep the daemon from serving */ }

  // A daemon opened from the maintenance page (or by ⧉ before the plugin has taken a
  // lease) owns nothing yet. Without arming here it never armed the idle timer at
  // all — `scheduleIdleExit` is only reached from lease teardown and POST /v1/config
  // — so every click left one more resident node process (review C2-P1-1). A lease
  // arriving right after cancels this timer again.
  if (engineCwd === null && leases.count() === 0) scheduleIdleExit()

  // We are the machine-level owner now, so reconcile what the previous run left:
  // git entries for a dead engine, a bridge parked by us, stale pid/state files.
  // Run the startup reconcile through the engine queue: it touches the engine
  // pidfile and a user's /v1/action may already be in flight. Own pid is passed so
  // the reconcile can never delete the state file of this very daemon.
  void serializeEngine(() => reconcileStartupLeftovers({
    ownPid: process.pid,
    log: (message) => { try { process.stdout.write(`${message}\n`) } catch { /* ignore */ } },
  })).catch(() => {})

  let stopping = false
  /**
   * Stop serving.
   * @param {{handoff?: boolean}} [options] - `handoff` = a successor will take over:
   *   leave the engine, bridge, heartbeat file, janitor and state note in place.
   */
  async function stop(options = {}) {
    if (stopping) return
    stopping = true
    const handoff = options?.handoff === true
    cancelIdleExit()
    if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    leases.stop()
    // JDWP sockets are process-local: detach before closing so a VM paused on a
    // breakpoint is resumed instead of being left frozen for the next daemon.
    // Following the daemon is not configurable (m07741): stop everything we supervise.
    await debug.stopAll().catch(() => {})
    if (handoff) {
      // Hand the network over: the successor adopts the engine pid, the bridge
      // watchdog keeps its heartbeat (20 s window), and the state note is what it
      // reads to know the engine is its own. Deliberately no teardown/disarm.
      try {
        writeRisdState(Object.assign({}, state, {
          handoff: { cwd: engineCwd, enginePid: proxyPid() ?? 0, at: new Date().toISOString() },
        }), home)
      } catch { /* best effort: the successor can still adopt by pidfile */ }
      // Keep the armed watcher from tearing the network down in the gap between
      // our exit and the successor's registration (it reads this stamp).
      try { markJanitorHandoff() } catch { /* no armed watcher: nothing to tell */ }
      server.closeIdleConnections?.()
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections?.()
          resolve(undefined)
        }, 1500)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      return
    }
    // "Stop the daemon" means stop what it supervises: JVMs first (JDWP sockets
    // were detached above), then the network layers below. A handoff skips all of
    // this — the successor adopts them.
    await stopAllPrograms()
    // Drain in-flight operations first: a start that was already running would
    // otherwise spawn an engine after teardown and leave an orphan (review A-P1-2).
    await engineOp.catch(() => {})
    await bridgeOp.catch(() => {})
    // Only remove the state file if it is still ours: a newer daemon that
    // replaced us must keep its own file.
    const current = readRisdState(home)
    if (current !== null && current.pid === process.pid) removeRisdState(home)
    // Graceful exit takes the network with it (only what THIS daemon owns: an
    // engine found in the pidfile at startup belongs to someone else and is left
    // alone). Bounded: a slow bridge probe on a WSL `/mnt/c` mount must not keep
    // `risd stop` — or the next spawn — waiting. If the bound hits, the armed
    // janitor finishes the job after this process is gone — which is why the
    // watcher is only disarmed when the teardown actually completed. Unconditional
    // disarm after a timed-out race would leave the engine/pidfile/port behind with
    // nothing left to clean them up (review A-P0-2).
    let tornDown = false
    // Following the daemon is not configurable (m07741): the proxy always goes with
    // it. Keeping a resource alive past its supervisor used to require a detached
    // heartbeat writer (D3) and would have left the machine with no page to stop it.
    await Promise.race([
      (typeof teardown === 'function' ? teardown(engineCwd) : teardownNetwork(engineCwd)).then(() => { tornDown = true }),
      new Promise((resolve) => { const timer = setTimeout(resolve, teardownTimeoutMs); timer.unref?.() }),
    ])
    engineCwd = null
    server.closeIdleConnections?.()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.()
        resolve(undefined)
      }, 1500)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
    if (tornDown) {
      try { disarmJanitor() } catch { /* janitor may not be armed */ }
    } else {
      // The armed watcher outlives us on purpose: it retries the cleanup once the
      // process is gone (same effect the exit hook used to provide).
      try { process.stderr.write('risd: teardown did not finish within 5s; leaving the janitor armed\n') } catch { /* detached stdio */ }
    }
  }

  return { ok: true, server, port: actualPort, state, leases, stop }
}
