/**
 * ProxyBridge redirector adapter.
 *
 * Why this exists: our own proxy engine can only help a program we launch (env /
 * JVM flags) or a client that accepts a `127.0.0.1:port` address (JDBC, Navicat).
 * A program started elsewhere — an IDE's F5, a terminal, a GUI database tool —
 * cannot be injected at all. ProxyBridge does exactly that missing job: it hooks
 * the socket layer by process name (WinDivert on Windows, eBPF on Linux) and
 * sends matching connections to a SOCKS5/HTTP proxy.
 *
 * It is driven entirely by a `.pbprofile` JSON file, so we do not reimplement its
 * engine: we map our rule table onto that file and hand it over. The CLI itself is
 * **downloaded on first use** (an uploaded `.tgz` works as well) and cached under
 * `~/.dsh-ris-ide/proxybridge/bundle/{linux,windows}` by `lib/proxybridge-bundle.js`
 * — the plugin no longer ships any binaries:
 *   - Linux: `ProxyBridge --profile ./x.pbprofile` runs from that folder
 *     ("Nothing is installed"); it needs root, but no systemd unit.
 *   - Windows: `ProxyBridge_CLI.exe` next to `ProxyBridgeCore.dll`, `WinDivert.dll`
 *     and `WinDivert64.sys` is the stand-alone form; it needs an elevated start.
 *     Where Windows can see the filesystem, the windows folder is materialised under
 *     %LOCALAPPDATA% first, because a Windows process cannot launch a binary that
 *     only exists in Linux.
 *
 * Nothing here downloads by itself: the HTTP layer (maintenance page → 代理 → 组件)
 * calls `ensureBundleReady`, and the lookup only *reports* `missingBundle` so a
 * caller can show "未安装，请下载/上传" instead of failing silently.
 *
 * Elevation is the one thing we cannot do silently: on Windows it is a UAC prompt,
 * on WSL/Linux a sudo password. So `start` reports the exact command and only
 * spawns when the caller already has the rights.
 */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { IS_WINDOWS, engineSide, pidAlive, proxyConfigPath, proxyHomeDir, proxyLogPath, readProxyConfig, readTail, ruleEffectiveness } from './proxy.js'
import { DEFAULT_BUNDLE_URL, ensureBundle, installDir as bundleInstallDir, isInstalled as bundleIsInstalled, readManifest } from './proxybridge-bundle.js'

/** Directory (under the shared proxy home) holding our profile, pid and log. */
export const REDIRECTOR_DIRNAME = 'proxybridge'
/** The profile file name; the ProxyBridge GUI shows it as one more profile. */
export const REDIRECTOR_PROFILE_FILENAME = 'dsh-ris-ide.pbprofile'
/** The single pid file older versions wrote; migrated to the per-side files below. */
export const REDIRECTOR_PID_FILENAME = 'proxybridge.pid'
/**
 * Per-side pid files: a Windows CLI and the local engine hook different network
 * stacks, so they can run at the same time. One shared record made one start
 * erase the other side's pid (the local engine then became an orphan).
 */
export const REDIRECTOR_PID_FILENAMES = Object.freeze({
  local: 'proxybridge.local.pid',
  windows: 'proxybridge.windows.pid',
})
export const REDIRECTOR_LOG_FILENAME = 'proxybridge.log'
/** Substring of the redirector's command line, used to verify a pid is ours. */
export const REDIRECTOR_MARKER = 'ProxyBridge'

/**
 * Test seam for `windowsPathOf` (not a product feature).
 *
 * A host that is not WSL has no `wslpath` and no Windows side, so the Windows
 * spelling of a Linux path cannot be computed there at all — and the tests that
 * assert the shape of that spelling could only ever run on a WSL machine. The
 * seam lets them inject the mapping instead, so CI (plain Linux) keeps the
 * coverage; production leaves it `null` and always asks `wslpath`.
 */
let windowsPathTranslator = null
/** Profile rules are per-connection decisions, so TCP+UDP is the useful default. */
const PROFILE_VERSION = '1.0'

/**
 * Test-only probe overrides.
 *
 * Every call that would spawn PowerShell, run the CLI for `--version`, kill a
 * Windows process or start the elevated helper goes through one of these seats.
 * Production leaves the object empty; tests fill it so a lifecycle test can run
 * deterministically without touching the real Windows side (no UAC, no driver,
 * no process killing).
 *
 * `bundleTarget({platform})` overrides where the Windows bundle is materialised, so
 * a test can prove the copy happens without writing into a real `%LOCALAPPDATA%`.
 */
const probeHooks = {}

/** @param {object} hooks - overrides keyed as documented in __test.setProbeHooks. */
function setProbeHooks(hooks) {
  for (const key of Object.keys(hooks ?? {})) {
    if (typeof hooks[key] === 'function') probeHooks[key] = hooks[key]
  }
}

/** Drop every probe override (tests call this in `finally`). */
function resetProbeHooks() {
  for (const key of Object.keys(probeHooks)) delete probeHooks[key]
}

/** TTL of the process-table probes: the UI polls status, PowerShell takes seconds. */
const PROBE_TTL_MS = 5000
/** The CLI's version does not change while a process is alive. */
const VERSION_TTL_MS = 60000
/** TTL of the cached status snapshot served to the HTTP route. */
const STATUS_TTL_MS = 5000
/** One suspended-promise dedupe slot for the async probes. */
const execFileAsync = promisify(execFile)

let windowsPidsCache = { at: 0, pids: null }
const windowsAliveCache = new Map()
const versionCache = new Map()
let statusCache = { at: 0, value: null }
let statusInflight = null

/** Clear every TTL cache (tests need a deterministic start and per-call counts). */
function clearProbeCaches() {
  windowsPidsCache = { at: 0, pids: null }
  windowsAliveCache.clear()
  versionCache.clear()
  statusCache = { at: 0, value: null }
  statusInflight = null
  // The bundle caches are process-wide too: a test that pins a temp target must not
  // inherit a previous run's materialised folder (or a remembered failure).
  localAppDataCache = null
  windowsBundlePrepared = null
  windowsBundleFailure = null
  windowsBundleFailureCache = null
}

/**
 * Run a command asynchronously and return its combined output (never throws).
 *
 * `spawnSync` PowerShell calls block the host's event loop for 3–4 s, which froze
 * the whole web/terminal/agent process on every `GET /proxy`. `execFile` keeps the
 * loop free; the timeout still kills a hung child.
 */
async function runTextAsync(command, args, timeoutMs) {
  try {
    const result = await execFileAsync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  } catch (error) {
    return `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  }
}

/** Sleep without spawning a node process per tick (the old "sleep" blocked too). */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    spawnSyncText(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], 2000)
  }
}

/** Sleep without blocking the event loop (the UAC wait can take tens of seconds). */
function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run a program and wait for it to exit without blocking the event loop.
 *
 * The elevated start is launched through a UAC consent dialog: `spawnSync` returned
 * only after the user answered, which froze the whole daemon (3 s heartbeat, HTTP
 * routes, log follow) for up to 45 s. A hung dialog is killed at `timeoutMs`.
 * @param {string} command - executable.
 * @param {string[]} args - argv.
 * @param {number} timeoutMs - kill the launcher after this long.
 * @returns {Promise<{code: number|null, timedOut: boolean}>} exit status.
 */
function spawnDetachedText(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child = null
    let timedOut = false
    let settled = false
    const finish = (code) => {
      if (settled === true) return
      settled = true
      clearTimeout(timer)
      resolve({ code, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child?.kill() } catch { /* the dialog outlives the launcher */ }
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      finish(null)
      return
    }
    child.on('error', () => finish(null))
    child.on('exit', (code) => finish(code))
    child.unref?.()
  })
}

/** Quote one argv entry for bash: `'` becomes `'\''`, so a path can't break out. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** Where our profile/pid/log live: one folder beside the shared proxy config. */
export function redirectorHome() {
  return join(proxyHomeDir(), REDIRECTOR_DIRNAME)
}

export function redirectorProfilePath() {
  return join(redirectorHome(), REDIRECTOR_PROFILE_FILENAME)
}

/** The legacy single pid file: every version before the split wrote this one path. */
export function redirectorPidPath() {
  return join(redirectorHome(), REDIRECTOR_PID_FILENAME)
}

/**
 * Pid file of one side.
 *
 * Both sides can run at once (Windows hooks the host's processes, the local
 * engine hooks ours), so each side records its own pid. A shared file made the
 * second start overwrite the first side's record, which is how the local engine
 * became an orphan nobody could stop.
 * @param {'local'|'windows'} side - which side.
 * @returns {string} absolute path.
 */
export function redirectorSidePidPath(side) {
  const name = side === 'windows' ? REDIRECTOR_PID_FILENAMES.windows : REDIRECTOR_PID_FILENAMES.local
  return join(redirectorHome(), name)
}

/** Read one pid record file without any compatibility fallback. */
function readPidFileAt(path) {
  try {
    const text = readFileSync(path, 'utf8').trim()
    const match = /^(\d+)\s*(\S*)$/.exec(text)
    if (match === null) return null
    const pid = Number.parseInt(match[1], 10)
    if (!Number.isInteger(pid) || pid <= 0) return null
    const side = match[2] === 'windows' ? 'windows' : 'local'
    return { pid, side }
  } catch {
    return null
  }
}

/**
 * Move the pre-split single pid file to its per-side home.
 *
 * The old file names the side inside its content (`<pid> <side>`), so the record
 * survives the upgrade instead of turning into an orphan we can no longer stop.
 * @returns {{migrated: boolean, pid: number, side: string}} what was found.
 */
export function migrateLegacyPidFile() {
  const legacy = redirectorPidPath()
  if (existsSync(legacy) !== true) return { migrated: false, pid: 0, side: 'local' }
  const record = readPidFileAt(legacy)
  if (record === null) {
    // Unreadable garbage: keeping it would make every status call look busy.
    try {
      unlinkSync(legacy)
    } catch {
      // best-effort: a read-only home keeps the file, callers still ignore it
    }
    return { migrated: false, pid: 0, side: 'local' }
  }
  const target = redirectorSidePidPath(record.side)
  if (existsSync(target) !== true) {
    try {
      mkdirSync(redirectorHome(), { recursive: true, mode: 0o700 })
      writeFileSync(target, `${record.pid} ${record.side}\n`, { mode: 0o600 })
    } catch {
      // best-effort: the legacy file stays readable until the next attempt
    }
  }
  if (existsSync(target) === true) {
    try {
      unlinkSync(legacy)
    } catch {
      // best-effort: duplicate is harmless, reads prefer the per-side file
    }
  }
  return { migrated: existsSync(target) === true, pid: record.pid, side: record.side }
}

export function redirectorLogPath() {
  return join(redirectorHome(), REDIRECTOR_LOG_FILENAME)
}

/**
 * The downloaded-and-cached ProxyBridge distribution (machine-wide proxy home).
 *
 * Nothing is shipped inside the plugin any more (2.9 MB of binaries made every
 * install heavy and pinned the upstream version): `lib/proxybridge-bundle.js`
 * downloads/accepts an uploaded `.tgz` here on first use.
 * @returns {string} absolute path to `<proxyHome>/proxybridge/bundle`.
 */
export function bundledBundleDir() {
  return bundleInstallDir(proxyHomeDir())
}

/**
 * The cached distribution for one platform.
 *
 * The old name is kept for compat (this module and its tests import it), but it no
 * longer points inside the plugin: the folder only exists after a download/upload.
 * @param {{platform?: string, dir?: string}} [options] - platform / install-dir overrides for tests.
 * @returns {string} absolute path to `<bundle>/<windows|linux>`.
 */
export function bundledRedirectorDir(options = {}) {
  const platform = options.platform ?? process.platform
  return join(options.dir ?? bundledBundleDir(), platform === 'win32' ? 'windows' : 'linux')
}

/** True when the cached distribution is complete (manifest plus every file). */
export function bundleCacheInstalled() {
  return bundleIsInstalled(bundledBundleDir())
}

/**
 * Identity of the currently installed bundle. The Windows-side copy (below) is
 * materialised from it, so a changed fingerprint means the DLLs/CLI on the Windows
 * side are stale and must be copied again (review B-P1-2).
 * @param {string} [dir] - install directory; defaults to {@link bundledBundleDir}.
 * @returns {string} `sha256:installedAt`, or '' when nothing is installed.
 */
export function bundleFingerprint(dir = bundledBundleDir()) {
  const manifest = readManifest(dir)
  if (manifest === null) return ''
  return `${manifest.sha256 ?? ''}:${manifest.installedAt ?? ''}`
}

/** Machine-level settings file (`~/.dsh-ris-ide/settings.json`); unreadable counts as empty. */
function readMachineSettings() {
  try {
    const parsed = JSON.parse(readFileSync(join(proxyHomeDir(), 'settings.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Make the ProxyBridge distribution available: reuse the cache, else download it.
 *
 * URL and digest priority now live in exactly one place — `resolveBundleUrls` /
 * `resolveBundleSha256` inside `lib/proxybridge-bundle.js` (env → settings →
 * mirrors), shared with the daemon. This function only forwards the explicit
 * route-level `url` and the machine settings; it must not re-order them
 * (review A3-P2-1/-2). Never throws — the route layer turns `{ok:false}` into a
 * readable failure.
 * @param {{url?: string, fetchImpl?: typeof fetch, force?: boolean}} [options] - overrides for the route/tests.
 * @returns {Promise<{ok: boolean, dir: string, fromCache: boolean, error: string, url: string, hint: string, warning?: string}>} outcome.
 */
export async function ensureBundleReady(options = {}) {
  const fallbackUrl = DEFAULT_BUNDLE_URL
  try {
    const settings = readMachineSettings()
    const explicit = typeof options.url === 'string' && options.url.trim() !== '' ? options.url.trim() : ''
    const result = await ensureBundle({
      home: proxyHomeDir(),
      settings,
      force: options.force === true,
      ...(explicit === '' ? {} : { url: explicit }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
    const url = typeof result.url === 'string' && result.url !== '' ? result.url : explicit || fallbackUrl
    if (result.ok === true) {
      return {
        ok: true,
        dir: result.dir,
        fromCache: result.fromCache === true,
        error: '',
        url,
        hint: '',
        ...(typeof result.warning === 'string' ? { warning: result.warning } : {}),
      }
    }
    return {
      ok: false,
      dir: result.dir ?? '',
      fromCache: false,
      error: result.error ?? '下载失败',
      url,
      hint: result.hint ?? '',
    }
  } catch (error) {
    return {
      ok: false,
      dir: '',
      fromCache: false,
      error: error?.message ?? String(error),
      url: fallbackUrl,
      hint: '检查下载地址后重试，或在维护页「代理 → 组件」上传 ris-proxy.4.0.tgz。',
    }
  }
}


/** How long a failed `%LOCALAPPDATA%` probe is remembered before it is asked again. */
const LOCAL_APP_DATA_RETRY_MS = 60000
let localAppDataCache = null // { value: string, at: number }
let warnedNoWindowsSide = false
/** `%LOCALAPPDATA%` as a Windows path; '' when it cannot be asked (native Linux/macOS). */
function windowsLocalAppData() {
  const now = Date.now()
  // A resolved value never changes; an empty one may (WSL interop is enabled after
  // the fact, or `cmd.exe` was briefly unavailable), so only cache it for a minute.
  if (localAppDataCache !== null && (localAppDataCache.value !== '' || now - localAppDataCache.at < LOCAL_APP_DATA_RETRY_MS)) {
    return localAppDataCache.value
  }
  if (process.platform === 'win32') {
    localAppDataCache = { value: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), at: now }
    return localAppDataCache.value
  }
  if (existsSync('/mnt/c') !== true) {
    if (warnedNoWindowsSide !== true) {
      warnedNoWindowsSide = true
      // One readable line instead of a silent '' — this is the "not WSL" case.
      console.error('[dsh-ris-ide] 没有 /mnt/c：当前环境不是 WSL，跳过 Windows 版 ProxyBridge 的复制（本机不会运行 Windows 侧）。')
    }
    localAppDataCache = { value: '', at: now }
    return ''
  }
  try {
    const out = spawnSync('cmd.exe', ['/d', '/s', '/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8', timeout: 5000 })
    const value = String(out.stdout ?? '').trim()
    const resolved = /^[A-Za-z]:[\\/]/.test(value) === true ? value : ''
    localAppDataCache = { value: resolved, at: now }
    return resolved
  } catch {
    localAppDataCache = { value: '', at: now }
    return ''
  }
}

/** Test seam: where the Windows bundle should land (production: `%LOCALAPPDATA%`). */
function bundleTargetDir(platform) {
  if (typeof probeHooks.bundleTarget === 'function') return String(probeHooks.bundleTarget({ platform }) ?? '')
  return windowsBundleDir({ platform })
}

/**
 * Where the Windows side runs the materialised CLI from.
 *
 * The Windows redirector must run on the Windows side of the boundary, so the
 * binary cannot stay inside the Linux filesystem (`\\wsl$` executables are not
 * reliable): it is materialized under `%LOCALAPPDATA%\dsh-ris-ide\proxybridge` and,
 * on WSL, addressed through `/mnt/<drive>`.
 * @param {{platform?: string}} [options] - overrides for tests.
 * @returns {string} posix path on WSL, native path on Windows, '' when unknown.
 */
export function windowsBundleDir(options = {}) {
  const platform = options.platform ?? process.platform
  const local = platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : windowsToPosixPath(windowsLocalAppData())
  if (local === '') return ''
  return join(local, 'dsh-ris-ide', 'proxybridge', 'windows')
}

let windowsBundlePrepared = null // { dir, fingerprint } of a complete copy; failures are never cached
/** How different a copied file's mtime may be from its source before we re-copy. */
const BUNDLE_MTIME_TOLERANCE_MS = 2000
/**
 * Where the "which bundle is materialised where" record lives. It sits in the proxy
 * home, not next to the copies: `%LOCALAPPDATA%` only ever holds the bundle files
 * (users and antivirus look at that folder), while this record must survive a
 * daemon restart so a bundle installed in the meantime still refreshes the Windows
 * side on the next start (review B-P1-2).
 */
const MATERIALISED_STATE_FILENAME = 'windows-materialised.json'

function materialisedStatePath() {
  return join(proxyHomeDir(), REDIRECTOR_DIRNAME, MATERIALISED_STATE_FILENAME)
}

/** @returns {string} fingerprint recorded for `target`, or '' when absent/unreadable. */
function materialisedFingerprint(target) {
  try {
    const state = JSON.parse(readFileSync(materialisedStatePath(), 'utf8'))
    return state !== null && typeof state === 'object' && state.dir === target && typeof state.fingerprint === 'string' ? state.fingerprint : ''
  } catch {
    return ''
  }
}

/** Record which bundle a materialised copy was made from (best effort). */
function rememberMaterialised(target, fingerprint) {
  try {
    const file = materialisedStatePath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify({ dir: target, fingerprint, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // The marker only saves a re-copy; failing to write it must not fail the launch.
  }
}

/**
 * Copy one bundle file unless the target already matches (size + mtime).
 * `force` copies even when the metadata looks identical: a new bundle can have the
 * same byte count and an mtime within the tolerance window, and then the Windows
 * side would keep running the previous DLLs (review B-P1-2).
 */
function copyBundleFile(from, to, options = {}) {
  if (existsSync(from) !== true) return false
  const source = statSync(from)
  if (options.force !== true && existsSync(to) === true) {
    const existing = statSync(to)
    // Size AND mtime: a plugin update can ship the same byte count with new bits.
    if (existing.size === source.size && Math.abs(existing.mtimeMs - source.mtimeMs) <= BUNDLE_MTIME_TOLERANCE_MS) return true
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  // `copyFileSync` stamps "now"; carry the source mtime so the next call can tell a
  // fresh copy from a stale one instead of re-copying the megabytes every time.
  utimesSync(to, source.atime, source.mtime)
  return true
}

/**
 * Materialise the cached Windows files next to each other (idempotent). Run before
 * any Windows-side launch: a Windows process cannot execute a binary that only
 * lives in the Linux filesystem, and the copy must follow the *current* bundle —
 * the cache is keyed by {@link bundleFingerprint}, so a newly downloaded/uploaded
 * bundle always refreshes the Windows copy (review B-P1-2).
 *
 * A failed run is deliberately NOT cached: the next call retries (a missing
 * `%LOCALAPPDATA%` probe or a locked file can heal on its own). Only a complete
 * copy is remembered.
 * @param {{force?: boolean, platform?: string, targetDir?: string}} [options] - overrides for tests.
 * @returns {string|undefined} the folder holding a complete CLI bundle; `''` when no
 *   Windows-addressable target exists; `undefined` when the distribution itself is
 *   not installed yet (caller must show "未安装，请下载/上传").
 */
export function prepareWindowsBundle(options = {}) {
  // Every attempt starts with a clean diagnosis: a previous failure (locked DLL, no
  // %LOCALAPPDATA%, missing bundle) must not be reported for this one (review B-P2-14).
  windowsBundleFailure = null
  const fingerprint = bundleFingerprint()
  if (options.force !== true && windowsBundlePrepared !== null && windowsBundlePrepared.fingerprint === fingerprint) {
    // The folder can disappear between calls (user cleanup); redo it rather than
    // hand out a path that no longer holds the CLI.
    if (existsSync(join(windowsBundlePrepared.dir, 'ProxyBridge_CLI.exe')) === true) return windowsBundlePrepared.dir
    windowsBundlePrepared = null
  }
  // No distribution cached yet: there is nothing to copy, and silently pointing at
  // a path that will never appear is exactly the failure this round removes.
  if (bundleIsInstalled(bundledBundleDir()) !== true) return undefined
  const platform = options.platform ?? process.platform
  const target = options.targetDir ?? bundleTargetDir(platform)
  if (target === '') return ''
  // A copy that belongs to a different bundle fingerprint must be replaced, even
  // when the files look identical by size+mtime. Compare against the on-disk marker
  // too: the in-memory cache is empty after a daemon restart.
  const refresh = options.force === true
    || (windowsBundlePrepared !== null && windowsBundlePrepared.fingerprint !== fingerprint)
    || materialisedFingerprint(target) !== fingerprint
  // A copy that fails (locked DLL, antivirus, permissions) stays broken for a while;
  // retrying four multi-MB copies through /mnt/c on every status poll is pointless
  // (review B-P2-13). Cache the failure for a TTL; `force` retries immediately.
  const failureKey = `${target}|${fingerprint}`
  if (options.force !== true && windowsBundleFailureCache !== null
    && windowsBundleFailureCache.key === failureKey
    && Date.now() - windowsBundleFailureCache.at < MATERIALISE_RETRY_MS) {
    windowsBundleFailure = { ...windowsBundleFailureCache.failure }
    return ''
  }
  const source = bundledRedirectorDir({ platform: 'win32' })
  const names = ['ProxyBridge_CLI.exe', 'ProxyBridgeCore.dll', 'WinDivert.dll', 'WinDivert64.sys']
  let complete = true
  /** @type {{code: string, message: string, file: string}|null} */
  let firstError = null
  for (const name of names) {
    try {
      if (copyBundleFile(join(source, name), join(target, name), { force: refresh }) !== true) complete = false
    } catch (error) {
      complete = false
      firstError ??= { code: String(error?.code ?? 'copy-failed'), message: String(error?.message ?? error), file: name }
    }
  }
  // The licence texts live at the root of the cached distribution (they cover both
  // platforms). They are not needed to run the CLI, so a failure here must not make
  // the bundle unusable — but an LGPL/MIT redistribution should carry them.
  const licenceDir = bundledBundleDir()
  for (const name of ['NOTICE.md', 'LICENSE-ProxyBridge.txt']) {
    try {
      copyBundleFile(join(licenceDir, name), join(target, name), { force: refresh })
    } catch {
      // best-effort: the CLI still runs
    }
  }
  // Only the machine-wide materialisation is worth caching; a caller passing
  // targetDir is testing (or preparing an explicit folder) and must not poison it.
  if (complete === true) {
    rememberMaterialised(target, fingerprint)
    windowsBundleFailure = null
    windowsBundleFailureCache = null
  } else {
    windowsBundleFailure = firstError === null
      ? { code: 'copy-failed', message: '文件没有完整复制', file: '' }
      : { ...firstError, target }
    windowsBundleFailureCache = { key: failureKey, at: Date.now(), failure: { ...windowsBundleFailure } }
  }
  if (options.targetDir === undefined) windowsBundlePrepared = complete ? { dir: target, fingerprint } : null
  return complete ? target : ''
}

// Why the last materialise attempt failed (`''` target vs a real copy error). The
// old code printed「无法确定 %LOCALAPPDATA%」for both, which sent people looking at
// environment variables when the truth was a locked DLL (review m11624).
let windowsBundleFailure = null
/** Minimum time between retries of a failed materialisation (review B-P2-13). */
const MATERIALISE_RETRY_MS = 60 * 1000
/** Last failure, keyed by target+fingerprint so a new bundle retries at once. */
let windowsBundleFailureCache = null

/** Diagnosis of the last failed {@link prepareWindowsBundle} (`null` after a success). */
export function windowsBundleDiagnosis() {
  return windowsBundleFailure === null ? null : { ...windowsBundleFailure }
}

/** Actionable text for "the distribution was never downloaded/uploaded". */
export const MISSING_BUNDLE_HINT = `ProxyBridge 组件未安装：打开 risd 维护页「代理 → 组件」点「下载」（或上传 ris-proxy.tgz）；也可设 DSH_RIS_IDE_PROXYBRIDGE_URL 指向 tgz。默认地址：${DEFAULT_BUNDLE_URL}`

/**
 * Candidate locations of the redirector CLI, per side of the OS boundary.
 *
 * There are two different jobs, so the two sides are reported separately:
 *   - `local` runs where this process runs (Linux in WSL) and proxies OUR
 *     processes — the backend, git, npm.
 *   - `windows` runs on the Windows host and proxies ITS processes — Navicat,
 *     the IDE's java.
 * Inside WSL both exist and neither replaces the other. An explicit
 * `DSH_RIS_IDE_PROXYBRIDGE` pins one path (tests, unusual installs) and is
 * reported on both sides.
 *
 * The distribution is not shipped any more, so the first "built-in" candidate is
 * the downloaded cache (`~/.dsh-ris-ide/proxybridge/bundle`). When it is absent the
 * list still carries the expected paths (so diagnostics can show them) and the
 * non-enumerable `missingBundle` flag is set for the caller.
 * @param {{platform?: string, side?: 'local'|'windows', installDir?: string, bundleDir?: string}} [options] - overrides for tests.
 * @returns {string[]} absolute candidate paths, most specific first, plus
 *   non-enumerable `bundleDir` / `bundleInstalled` / `missingBundle` fields.
 */
export function redirectorCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const side = options.side ?? 'local'
  const override = process.env.DSH_RIS_IDE_PROXYBRIDGE
  const installRoot = options.installDir ?? bundledBundleDir()
  const installed = bundleIsInstalled(installRoot)
  const list = []
  if (typeof override === 'string' && override !== '') list.push(override)
  // The downloaded cache is the primary source; the materialised windows folder is
  // only known to the caller that prepared it (findRedirector), never guessed here.
  const materialised = typeof options.bundleDir === 'string' ? options.bundleDir : ''
  if (platform === 'win32') {
    if (materialised !== '') list.push(join(materialised, 'ProxyBridge_CLI.exe'))
    list.push(join(installRoot, 'windows', 'ProxyBridge_CLI.exe'))
    // Manual extraction (old installs) and a machine-wide install as fallbacks.
    list.push(join(redirectorVendorDir({ platform: 'win32' }), 'ProxyBridge_CLI.exe'))
    for (const drive of ['c', 'd', 'e', 'f']) {
      list.push(`${drive.toUpperCase()}:\\Program Files\\ProxyBridge\\ProxyBridge_CLI.exe`)
    }
    return decorateCandidates(list, installRoot, installed)
  }
  if (side === 'windows') {
    if (materialised !== '') list.push(join(materialised, 'ProxyBridge_CLI.exe'))
    list.push(join(installRoot, 'windows', 'ProxyBridge_CLI.exe'))
    list.push(join(redirectorVendorDir({ platform: 'win32' }), 'ProxyBridge_CLI.exe'))
    // A pre-existing install, reached through /mnt. Offsets are the common ones.
    for (const drive of ['d', 'c', 'e']) list.push(`/mnt/${drive}/Program Files/ProxyBridge/ProxyBridge_CLI.exe`)
    return decorateCandidates(list, installRoot, installed)
  }
  // Local side: the downloaded cache first, then a manual extraction, then whatever
  // a package manager put on PATH.
  list.push(join(installRoot, 'linux', 'ProxyBridge'))
  list.push(join(redirectorVendorDir({ platform }), 'ProxyBridge'))
  list.push('/usr/local/bin/ProxyBridge')
  list.push('/usr/bin/ProxyBridge')
  return decorateCandidates(list, installRoot, installed)
}

/**
 * Attach the bundle diagnosis to a candidate list without changing its array shape
 * (callers iterate it; `deepEqual` against a plain array must keep working).
 */
function decorateCandidates(list, installRoot, installed) {
  Object.defineProperty(list, 'bundleDir', { value: installRoot, enumerable: false })
  Object.defineProperty(list, 'bundleInstalled', { value: installed === true, enumerable: false })
  Object.defineProperty(list, 'missingBundle', { value: installed !== true, enumerable: false })
  return list
}
/**
 * Start the system-level interception for one side of the OS boundary.
 *
 * Elevation is expected, not an error: Windows raises a UAC prompt (through one
 * elevated helper that also stops the GUI's service and clears a stale CLI), Linux
 * needs root for eBPF and can only proceed when sudo is passwordless.
 * @param {{side?: 'local'|'windows', verbose?: number, profilePath?: string}} [options] - side to start.
 * @returns {Promise<{started: boolean, side: string, pid?: number, command: string, reason?: string}>} outcome.
 */

/** Liveness signal the unelevated host keeps touching while dsh is alive. */
export const HEARTBEAT_FILENAME = 'janitor-heartbeat'
/** Written by a normal stop: the watchdog stands down instead of cleaning up. */
export const STOP_REQUEST_FILENAME = 'proxybridge-stop.request'
/** Written by the watchdog once it has torn the bridge down. */
export const STOPPED_MARKER_FILENAME = 'proxybridge-stop.done'
/** The generated elevated watchdog script. */
export const WATCHDOG_SCRIPT_FILENAME = 'proxybridge-watchdog.ps1'
/** Where the watchdog's pid is recorded. */
export const WATCHDOG_STATE_FILENAME = 'proxybridge-watchdog.json'
/** "reload the rules" request: the watchdog restarts the CLI with the same profile. */
export const RELOAD_REQUEST_FILENAME = 'proxybridge-reload.request'
/** Written by the watchdog once the CLI came back with the new profile. */
export const RELOAD_DONE_FILENAME = 'proxybridge-reload.done'
/** Written instead of the done file when the restart failed (structured reason). */
export const RELOAD_FAILED_FILENAME = 'proxybridge-reload.failed'
/** The CLI invocation kept around so the elevated watchdog can restart it. */
export const CLI_SPEC_FILENAME = 'proxybridge-cli.json'

/** Heartbeat file inside the machine-level proxy home. */
export function heartbeatPath() {
  return join(proxyHomeDir(), HEARTBEAT_FILENAME)
}

/** Touch the heartbeat (cheap: the file's mtime is the whole protocol). */
export function writeHeartbeat() {
  try {
    mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
    const now = new Date()
    writeFileSync(heartbeatPath(), `${now.toISOString()}\n`, { mode: 0o600 })
    utimesSync(heartbeatPath(), now, now)
    return true
  } catch {
    return false
  }
}

/** @returns {number} age of the heartbeat in ms, or Infinity when missing. */
export function heartbeatAgeMs() {
  try {
    return Date.now() - statSync(heartbeatPath()).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Path of the "please stop" request file. */
export function stopRequestPath() {
  return join(proxyHomeDir(), STOP_REQUEST_FILENAME)
}

/** Path of the "the watchdog stopped it" marker. */
export function stoppedMarkerPath() {
  return join(proxyHomeDir(), STOPPED_MARKER_FILENAME)
}

/** Clear both signals; called when a bridge starts. */
export function clearStopSignals() {
  for (const path of [stopRequestPath(), stoppedMarkerPath()]) {
    try { unlinkSync(path) } catch { /* absent */ }
  }
}

/** Ask the watchdog to tear the bridge down (no elevation needed: it has it). */
export function requestRedirectorStop() {
  try {
    mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
    // A done file left by an earlier stop (or written by a concurrent watchdog
    // answer) would make the wait below return immediately and report a teardown
    // that never happened, so the request removes it first — same rule the reload
    // handshake already follows (review B-P2-7).
    try { unlinkSync(stoppedMarkerPath()) } catch { /* absent */ }
    writeFileSync(stopRequestPath(), `${new Date().toISOString()}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** @returns {boolean} true when the watchdog reported the teardown finished. */
export function stopCompleted() {
  try {
    return statSync(stoppedMarkerPath()).isFile()
  } catch {
    return false
  }
}

/** Path of the reload request file. */
export function reloadRequestPath() {
  return join(proxyHomeDir(), RELOAD_REQUEST_FILENAME)
}

/** Path of the reload-completed marker (structured JSON since the B4 fix). */
export function reloadDonePath() {
  return join(proxyHomeDir(), RELOAD_DONE_FILENAME)
}

/** Path of the reload failure marker (written when the watchdog could not restart). */
export function reloadFailedPath() {
  return join(proxyHomeDir(), RELOAD_FAILED_FILENAME)
}

/**
 * Ask the watchdog to restart the bridge with the profile on disk.
 *
 * The CLI reads its profile once at start, so edited rules mean a restart. Doing
 * that from here would need another UAC; the watchdog is already elevated, so it
 * does it instead (kill + start with the recorded spec).
 *
 * Every request carries an id so a late answer from an older request (or a
 * leftover done file) is never mistaken for this one.
 * @param {{id?: string}} [options] - request id; generated when omitted.
 * @returns {boolean} true when the request was written.
 */
export function requestRedirectorReload(options = {}) {
  try {
    mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
    for (const path of [reloadDonePath(), reloadFailedPath()]) {
      try { unlinkSync(path) } catch { /* absent */ }
    }
    const id = typeof options.id === 'string' && options.id !== '' ? options.id : `reload-${randomUUID()}`
    writeFileSync(reloadRequestPath(), `${JSON.stringify({ id, at: Date.now() })}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse a watchdog reload report.
 *
 * The report is structured (`{ok, id, pid, count, error}`) so "the file exists"
 * no longer means "the restart worked": the old watchdog wrote the done file even
 * when the spec was missing or Start-Process threw, and the host then told the
 * user the new rules were live while the CLI kept the old profile.
 * A legacy bare-timestamp file is accepted as "restarted" but carries no pid.
 * @param {string} path - done or failed marker.
 * @returns {{ok: boolean, id: string, pid: number, count: number, error: string, legacy: boolean}|null} report, or null when absent.
 */
export function readReloadResult(path) {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
  if (raw === '') return { ok: true, id: '', pid: 0, count: 0, error: '', legacy: true }
  try {
    const parsed = JSON.parse(raw)
    return {
      ok: parsed?.ok === true,
      id: typeof parsed?.id === 'string' ? parsed.id : '',
      pid: Number.isInteger(parsed?.pid) ? parsed.pid : 0,
      count: Number.isInteger(parsed?.count) ? parsed.count : 0,
      error: typeof parsed?.error === 'string' ? parsed.error : '',
      legacy: false,
    }
  } catch {
    // Older watchdogs wrote the request timestamp here; "restarted" is all it says.
    return { ok: true, id: '', pid: 0, count: 0, error: '', legacy: true }
  }
}

/** @returns {object|null} the watchdog's success report. */
export function readReloadDone() {
  return readReloadResult(reloadDonePath())
}

/** @returns {object|null} the watchdog's failure report. */
export function readReloadFailure() {
  return readReloadResult(reloadFailedPath())
}

/**
 * @param {{id?: string}} [options] - only accept the answer to this request id.
 * @returns {boolean} true when the watchdog reports a successful restart.
 */
export function reloadCompleted(options = {}) {
  const done = readReloadDone()
  if (done === null || done.ok !== true) return false
  if (typeof options.id === 'string' && options.id !== '' && done.legacy !== true && done.id !== '' && done.id !== options.id) return false
  return true
}

/** Clear the reload signals (start, stop, or after the caller saw them). */
export function clearReloadSignals() {
  for (const path of [reloadRequestPath(), reloadDonePath(), reloadFailedPath()]) {
    try { unlinkSync(path) } catch { /* absent */ }
  }
}

/** Remember how the CLI was launched, so a reload can repeat it verbatim. */
export function writeCliSpec(spec) {
  try {
    mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
    writeFileSync(join(proxyHomeDir(), CLI_SPEC_FILENAME), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** @returns {{exe: string, args: string[], log: string}|null} recorded CLI invocation. */
export function readCliSpec() {
  try {
    const parsed = JSON.parse(readFileSync(join(proxyHomeDir(), CLI_SPEC_FILENAME), 'utf8'))
    if (typeof parsed?.exe !== 'string' || Array.isArray(parsed?.args) !== true) return null
    return { exe: parsed.exe, args: parsed.args.map(String), log: typeof parsed.log === 'string' ? parsed.log : '' }
  } catch {
    return null
  }
}

/** Path of the generated watchdog script. */
export function watchdogScriptPath() {
  return join(proxyHomeDir(), WATCHDOG_SCRIPT_FILENAME)
}

/** Record the running watchdog so a stop can find it. */
export function writeWatchdogPid(pid) {
  try {
    writeFileSync(join(proxyHomeDir(), WATCHDOG_STATE_FILENAME), `${JSON.stringify({ pid }, null, 2)}\n`, { mode: 0o600 })
  } catch { /* best effort */ }
}

/** @returns {number} recorded watchdog pid (0 when unknown). */
export function watchdogPid() {
  try {
    const parsed = JSON.parse(readFileSync(join(proxyHomeDir(), WATCHDOG_STATE_FILENAME), 'utf8'))
    return Number.isInteger(parsed?.pid) ? parsed.pid : 0
  } catch {
    return 0
  }
}

/**
 * The elevated watchdog: tears down what we cannot.
 *
 * Killing an elevated ProxyBridge_CLI and restoring ProxyBridgeSvc need admin
 * rights, which the host process does not have and must not ask for twice. So the
 * one elevation we do at start also spawns this loop. Two triggers end it: a stop
 * request (normal shutdown) or a stale heartbeat (dsh was killed, closed, or
 * crashed). Either way it kills the CLI, puts the service back, and drops a marker.
 * @param {{heartbeat: string, stateFile: string, logFile: string, stopRequest: string, stoppedMarker: string, cliSpec?: string, reloadRequest?: string, reloadDone?: string, reloadFailed?: string}} paths - Windows paths.
 * @returns {string} the script text.
 */
export function windowsWatchdogScript(paths) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  return `$ErrorActionPreference = 'SilentlyContinue'
$hb = ${quote(paths.heartbeat)}
$stateFile = ${quote(paths.stateFile)}
$logFile = ${quote(paths.logFile)}
$stopFile = ${quote(paths.stopRequest)}
$doneFile = ${quote(paths.stoppedMarker)}

function Write-Log($message) {
  Add-Content -Path $logFile -Value ("{0} [watchdog] {1}" -f (Get-Date -Format o), $message)
}

Write-Log "started pid=$PID"
# Single instance (m11702): every bridge start spawns a watchdog and nothing killed
# the previous one while the heartbeat stayed fresh, so restarts piled them up. Two
# watchdogs then restart the CLI at the same time — one wins the WinDivert handle,
# the other loads the rules and captures nothing. A named mutex makes the second
# copy exit instead of accumulating.
$mutexName = ${quote(paths.mutexName ?? 'Global\\dsh-ris-ide-proxybridge-watchdog')}
$watchdogMutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $watchdogMutex.WaitOne(0)) { Write-Log 'another watchdog owns the mutex; exiting'; exit 0 }
$specFile = ${quote(paths.cliSpec ?? '')}
$ownProfile = ${quote(paths.profile ?? '')}
# Only CLIs that carry THIS home's profile are ours: the machine may run another
# dsh-ris-ide home's bridge, and a teardown must not take it down (review A4-P2-1).
function Get-OwnCli {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='ProxyBridge_CLI.exe'" -ErrorAction SilentlyContinue)
  if ($ownProfile -eq '') { return @($all) }
  return @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ownProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
$reloadFile = ${quote(paths.reloadRequest ?? '')}
$reloadDone = ${quote(paths.reloadDone ?? '')}
$reloadFailed = ${quote(paths.reloadFailed ?? '')}

$reason = ''
while ($true) {
  Start-Sleep -Seconds 2
  if (Test-Path $stopFile) { $reason = 'stop-request'; break }
  if (Test-Path $reloadFile) {
    # Rules changed: the CLI reads its profile only at start, so restart it here
    # (no second UAC — this process is already elevated). The report is structured
    # and truthful: a done file may only claim success when the new process is up.
    $requestId = ''
    try { $requestId = [string](Get-Content -Path $reloadFile -Raw | ConvertFrom-Json).id } catch { $requestId = '' }
    $pidText = ''
    $count = 0
    $errorText = ''
    Write-Log 'reloading'
    try {
      if (-not (Test-Path $specFile)) { throw 'no cli spec' }
      $spec = Get-Content -Path $specFile -Raw | ConvertFrom-Json
      (Get-OwnCli) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
      Start-Sleep -Milliseconds 400
      Start-Process -FilePath $spec.exe -ArgumentList @($spec.args) -WindowStyle Hidden -RedirectStandardOutput $spec.log -RedirectStandardError ($spec.log + '.err') | Out-Null
      Start-Sleep -Milliseconds 1500
      # Liveness alone is not enough: the host's old CLI may still be dying, and
      # ProxyBridge.exe is a different process. Match the profile on the command line.
      $profileArg = [string]$spec.args[1]
      $cim = @(Get-OwnCli | Where-Object { $_.ProcessId -ne $PID })
      $running = @($cim | Where-Object { $profileArg -ne '' -and $_.CommandLine -like ('*' + $profileArg + '*') })
      $count = $running.Count
      if ($count -gt 0) { $pidText = [string]$running[0].ProcessId } else { $errorText = 'the new CLI is not running with the recorded profile' }
    } catch {
      $errorText = $_.Exception.Message
    }
    # A failed restart leaves the machine WITHOUT interception: record the failure
    # and let the host tell the user, instead of faking "reloaded".
    if ($errorText -eq '') {
      Remove-Item $reloadFailed -Force -ErrorAction SilentlyContinue
      (@{ ok = $true; id = $requestId; pid = [int]$pidText; count = $count } | ConvertTo-Json -Compress) | Set-Content -Path $reloadDone -Encoding utf8
      Write-Log ("reloaded pid=" + $pidText + " count=" + $count)
    } else {
      Remove-Item $reloadDone -Force -ErrorAction SilentlyContinue
      (@{ ok = $false; id = $requestId; pid = 0; count = $count; error = $errorText } | ConvertTo-Json -Compress) | Set-Content -Path $reloadFailed -Encoding utf8
      Write-Log ("reload failed: " + $errorText)
    }
    Remove-Item $reloadFile -Force -ErrorAction SilentlyContinue
    continue
  }
  $fresh = $false
  if (Test-Path $hb) {
    $age = ((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds
    if ($age -lt 20) { $fresh = $true }
  }
  if (-not $fresh) { $reason = 'heartbeat-stale'; break }
}

Write-Log "cleaning up ($reason)"
Remove-Item $reloadFile -Force -ErrorAction SilentlyContinue
# Own-profile CLIs only; another home's bridge keeps running (review A4-P2-1).
(Get-OwnCli) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if (Test-Path $stateFile) {
  # Give the GUI service its hook back: undo the park we did at start.
  $state = Get-Content -Path $stateFile -Raw | ConvertFrom-Json
  if ($state.originalStartType) { Set-Service -Name ProxyBridgeSvc -StartupType $state.originalStartType -ErrorAction SilentlyContinue }
  $svc = Get-Service -Name ProxyBridgeSvc -ErrorAction SilentlyContinue
  if ($svc -ne $null -and $svc.Status -ne 'Running') { Start-Service -Name ProxyBridgeSvc -ErrorAction SilentlyContinue }
}
New-Item -ItemType File -Path $doneFile -Force | Out-Null
Write-Log 'cleaned up'
`
}

/**
 * Translate a Windows path into the /mnt form Linux can read.
 *
 * The picker browses Windows folders from inside WSL, so both spellings are needed:
 * the UI edits `D:\Program Files\…`, the filesystem needs `/mnt/d/Program Files/…`.
 * @param {string} value - Windows path (`D:\x`, `D:/x`).
 * @returns {string} posix path, or '' when it is not a Windows drive path.
 */
export function windowsToPosixPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(value ?? '').trim())
  if (match === null) return ''
  const rest = match[2].replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}/${rest}`.replace(/\/+$/, '') || `/mnt/${match[1].toLowerCase()}`
}

/**
 * The reverse: `/mnt/d/x` → `D:\x`. Anything else is returned unchanged.
 * @param {string} value - posix path.
 * @returns {string} Windows path.
 */
export function posixToWindowsPath(value) {
  const match = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(String(value ?? '').trim())
  if (match === null) return String(value ?? '')
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${rest === '' ? '\\' : rest}`
}

/** Write the watchdog script and return its WINDOWS path (it runs over there). */
export function writeWatchdogScript() {
  // The mutex must be shared by all watchdogs of ONE home (two different homes may
  // legitimately each run their own bridge): derive it from the heartbeat path.
  // Global\\ so two RDP sessions of the same user still see the same mutex (the
  // watchdog guards a machine-wide WinDivert handle, review B-P2-6). Single-user
  // machines keep the old semantics: one watchdog per home, second one exits.
  const mutexName = `Global\\dsh-ris-ide-proxybridge-watchdog-${createHash('sha1').update(heartbeatPath()).digest('hex').slice(0, 12)}`
  let script
  try {
    script = windowsWatchdogScript({
      mutexName,
      heartbeat: windowsPathOf(heartbeatPath(), { mustConvert: true }),
      // The canonical writer path: the watchdog's teardown reads exactly this file.
      stateFile: windowsPathOf(serviceStatePath(), { mustConvert: true }),
      logFile: windowsPathOf(windowsLogLocalPath(), { mustConvert: true }),
      stopRequest: windowsPathOf(stopRequestPath(), { mustConvert: true }),
      stoppedMarker: windowsPathOf(stoppedMarkerPath(), { mustConvert: true }),
      cliSpec: windowsPathOf(join(proxyHomeDir(), CLI_SPEC_FILENAME), { mustConvert: true }),
      profile: windowsPathOf(redirectorProfilePath(), { mustConvert: true }),
      reloadRequest: windowsPathOf(reloadRequestPath(), { mustConvert: true }),
      reloadDone: windowsPathOf(reloadDonePath(), { mustConvert: true }),
      reloadFailed: windowsPathOf(reloadFailedPath(), { mustConvert: true }),
    })
  } catch (error) {
    // A Linux spelling passed to powershell -File fails silently; surfacing it here
    // lets startRedirector answer with a real reason instead of "started" (B-P2-12).
    throw new Error(`无法把看门狗脚本的路径转换为 Windows 形式：${error?.message ?? error}`)
  }
  mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
  writeFileSync(watchdogScriptPath(), script, { mode: 0o600 })
  return windowsPathOf(watchdogScriptPath(), { mustConvert: true })
}

export async function startRedirector(options = {}) {
  const side = options.side === 'windows' ? 'windows' : 'local'
  // Resolve the binary BEFORE writing the profile: without a CLI the profile is
  // useless, and "no ProxyBridge" is a much better answer than "no rules".
  const found = findRedirector({ side })
  if (found.found !== true) {
    // A missing download is not "no rules": say what to install and where.
    return { started: false, side, command: '', reason: found.reason ?? (side === 'windows' ? '未找到 Windows 版 ProxyBridge_CLI.exe' : '未找到本侧 ProxyBridge'), missingBundle: found.missingBundle === true }
  }
  const profile = writeRedirectorProfile(readProxyConfig(''), { path: options.profilePath })
  const plan = redirectorCommand({ cliPath: found.path, profilePath: profile.path, verbose: options.verbose, platform: side === 'windows' ? 'win32' : 'linux' })
  // Serialise detect-then-spawn across processes (daemon vs plugin fallback): two
  // concurrent starters used to create two engines / two elevated helpers (m11773).
  const lock = await acquireStartLock(side, { timeoutMs: options.lockTimeoutMs })
  if (lock.ok !== true) return { started: false, side, command: plan.display, reason: lock.reason ?? '另一个进程正在启动桥接' }
  try {
  const running = detectRunningRedirector()
  // Per side: the other side's process must not make this start look redundant.
  const sameSide = IS_WINDOWS === true ? running.windows : side === 'windows' ? running.windows : running.local
  if (sameSide.pid > 0) {
    if (side !== 'windows' || IS_WINDOWS === true) {
      // Local side: a lost pid file used to hide duplicates forever. Reap every
      // extra engine so "already running" also means "exactly one is running".
      let reaped = 0
      if (side === 'local') {
        for (const pid of localRedirectorOwnPids()) {
          if (pid === sameSide.pid) continue
          try { process.kill(pid, 'SIGTERM'); reaped += 1 } catch { /* already gone */ }
        }
      }
      return { started: false, side, pid: sameSide.pid, command: plan.display, reason: '已在运行（先停止）', reaped }
    }
    // Windows: the engine may be a hand-started CLI, or one whose pid file we lost.
    // It still holds the hook, so take it over instead of refusing to start.
    const killed = await killWindowsCliProcesses()
    if (killed.ok !== true) {
      return { started: false, side, pid: sameSide.pid, command: plan.display, reason: killed.reason ?? '已有 ProxyBridge_CLI 在运行，且无法结束它' }
    }
    clearRedirectorPid('windows')
  }
  if (side === 'windows') {
    // PowerShell resolves paths as WINDOWS does: /mnt/d/… is invisible there, and the
    // profile we just wrote lives in the Linux home. Both have to be translated —
    // and a failure must be reported, not papered over with a Linux path that
    // PowerShell cannot open (review B-P2-12).
    let exePath = ''
    let winArgs = []
    let winLog = ''
    let ownProfile = ''
    let watchdogScript = ''
    let startTypeHint = ''
    try {
      exePath = windowsPathOf(found.path, { mustConvert: true })
      winArgs = windowsArgsOf(plan.args, { mustConvert: true })
      winLog = windowsPathOf(windowsLogPath())
      ownProfile = windowsPathOf(profile.path, { mustConvert: true })
      startTypeHint = windowsPathOf(startTypeHintPath(), { mustConvert: true })
      // Fresh start: no stale stop request may remain, and the heartbeat has to exist
      // BEFORE the watchdog looks at it (a missing file counts as stale).
      clearStopSignals()
      clearReloadSignals()
      writeHeartbeat()
      watchdogScript = writeWatchdogScript()
    } catch (error) {
      return { started: false, side, command: plan.display, reason: error?.message ?? '无法把启动路径转换为 Windows 形式' }
    }
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
    // Global\: the mutexes guard machine-wide resources (the WinDivert handle and the
    // one watchdog), so two RDP sessions of the same user must not each take "the"
    // mutex — the per-home sha suffix keeps separate proxy homes independent.
    // Global\\ for the same reason as the watchdog mutex: a start in another RDP
    // session races for the same machine-wide WinDivert handle (single-user boxes
    // are unaffected).
    const startMutexName = `Global\\dsh-ris-ide-proxybridge-start-${createHash('sha1').update(join(proxyHomeDir(), 'locks')).digest('hex').slice(0, 12)}`
    // One elevated helper does the whole dance: the GUI's service and the CLI both
    // want the WinDivert handle (mutually exclusive), a stale CLI has to go, and only
    // an already-elevated process may redirect the CLI's output (-Verb RunAs cannot
    // redirect). So: stop service → kill stale CLI → start CLI with logs → report.
    const script = [
      // One start at a time across processes (m11773): two elevated helpers racing
      // each stop the "other" CLI and start their own, ending with two CLIs alive.
      `$startMutex = New-Object System.Threading.Mutex($false, ${quote(startMutexName)})`,
      "if (-not $startMutex.WaitOne(30000)) { 'start-busy=True;done=1'; return }",
      '$svcWas = $false',
      `$startTypeHint = ${quote(startTypeHint)}`,
      // Leave the original service start type behind for the JS side: if the CLI dies
      // before the report is parsed, the caller still has to put the service back
      // instead of leaving the machine "stopped + Manual" (review B-P1-3).
      '$svc = Get-Service ProxyBridgeSvc -ErrorAction SilentlyContinue',
      '$startType = $null',
      "if ($svc -ne $null) { $startType = $svc.StartType.ToString() }",
      'if ($startType -ne $null) { Set-Content -Path $startTypeHint -Value $startType -Encoding ascii -ErrorAction SilentlyContinue }',
      "if ($svc -ne $null -and $svc.Status -eq 'Running') { Stop-Service ProxyBridgeSvc -Force -ErrorAction SilentlyContinue; $svcWas = $true; Start-Sleep -Milliseconds 900 }",
      // Only one process may own the WinDivert handle: if the service survived the
      // stop it will keep intercepting while our CLI silently captures nothing.
      "if ($svc -ne $null -and (Get-Service ProxyBridgeSvc -ErrorAction SilentlyContinue).Status -eq 'Running') { 'svcRunning=True;done=1'; return }",
      // An Automatic service comes back minutes later and silently steals the
      // WinDivert handle: our CLI then runs without capturing anything (rules load,
      // no [CONN] lines) while every connection fails. Park it on Manual instead.
      "if ($svc -ne $null -and $startType -eq 'Automatic') { Set-Service ProxyBridgeSvc -StartupType Manual -ErrorAction SilentlyContinue; $parked = $true }",
      // Only CLIs of THIS home are in our way: another dsh-ris-ide home (or a user's
      // own ProxyBridge) may run its own bridge with its own profile, and killing it
      // would take down that bridge instead of ours (review A4-P2-1/B-P1-4).
      `$ownProfile = ${quote(ownProfile)}`,
      '$ownCim = @(Get-CimInstance Win32_Process -Filter "Name=\'ProxyBridge_CLI.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ownProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })',
      'if ($ownCim.Count -gt 0) { $ownCim | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }',
      `$log = ${quote(winLog)}`,
      'if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }',
      `$argList = @(${winArgs.map(quote).join(',')})`,
      `$p = Start-Process -FilePath ${quote(exePath)} -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')`,
      'Start-Sleep -Milliseconds 2000',
      '$alive = [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue)',
      // Two CLIs would both try to bind WinDivert: keep ours, drop anything else that
      // carries THIS home's profile (a leftover from an earlier session, or one the
      // IDE started meanwhile). Other homes' CLIs are out of scope.
      '$all = @(Get-CimInstance Win32_Process -Filter "Name=\'ProxyBridge_CLI.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ownProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })',
      '$dups = $all.Count - 1',
      'if ($dups -gt 0) { $all | Where-Object { $_.ProcessId -ne $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }',
      '$final = @(Get-CimInstance Win32_Process -Filter "Name=\'ProxyBridge_CLI.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ownProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count',
      // Killing an elevated CLI and restarting the service need admin, which we only
      // have inside this script: spawn the watchdog here so teardown never asks for
      // a second UAC (it ends on a stop request or when the heartbeat goes stale).
      // One watchdog per machine (m11702): a previous start left one behind, and on
      // the next reload/stale heartbeat it starts a SECOND CLI. Kill the leftovers
      // in the same elevated context that creates the new one — but only those that
      // run THIS home's watchdog script (another home has its own, per-home mutex;
      // review B-P2-4).
      `$wdScript = ${quote(watchdogScript)}`,
      '$oldWatchdogs = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($wdScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })',
      'if ($oldWatchdogs.Count -gt 0) { $oldWatchdogs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }',
      `$wd = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', ${quote(watchdogScript)}) -PassThru -WindowStyle Hidden`,
      'Start-Sleep -Milliseconds 400',
      // Only a fully successful start removes the hint; a failed one leaves it for
      // the caller to restore the service (review B-P1-3).
      'if ($alive -eq $true) { Remove-Item $startTypeHint -Force -ErrorAction SilentlyContinue }',
      '"pid=$($p.Id);svc=$svcWas;startType=$startType;parked=$([bool]$parked);alive=$alive;dups=$dups;count=$final;own=$($all.Count);watchdog=$($wd.Id);oldWatchdogs=$($oldWatchdogs.Count);done=1"',
    ].join('; ')
    // Waiting for the UAC prompt is exactly the window in which the old watchdog
    // judges our heartbeat stale and tears the bridge down. Keep beating while the
    // launcher blocks (it may take seconds), so a slow UAC is not a bridge outage
    // (review B-P0-1).
    const beat = setInterval(() => { try { writeHeartbeat() } catch {} }, 3000)
    beat.unref?.()
    let elevated
    try {
      elevated = await psElevated(script, 45000)
    } finally {
      clearInterval(beat)
    }
    // B1: no report for THIS run means the start did not happen — never parse the
    // previous run's leftover output (it looked like success with a dead pid).
    if (elevated.ok !== true) {
      // The helper may still have stopped the service before it failed; the hint
      // file (if any) tells recoverWindowsService() what to restore.
      recoverWindowsService()
      return { started: false, side, command: plan.display, reason: elevated.reason }
    }
    const output = elevated.output
    // A concurrent start (another window, or the daemon while the plugin fell back)
    // means the elevated helper could not take the start mutex: report it instead of
    // pretending a second CLI is fine (m11773). Must be checked BEFORE the pid parse:
    // this report carries no pid, so the old order always answered with the generic
    // "未能启动（…）" (review B-P2-1).
    if (/start-busy=True/.test(output)) {
      return { started: false, side, command: plan.display, reason: '另一个进程正在启动 Windows 侧拦截，请稍后再试' }
    }
    if (/svcRunning=True/.test(output)) {
      // The service was already stopped (and maybe parked) by the script; restore it
      // instead of leaving the machine with a dead service (review B-P1-3).
      recoverWindowsService()
      return {
        started: false,
        side,
        command: plan.display,
        reason: 'ProxyBridgeSvc 服务停不下来，它会和 CLI 抢 WinDivert 句柄（表现为拦截器在跑但一条 [CONN] 都没有）——用管理员结束该服务后重试',
      }
    }
    const pid = Number.parseInt((output.match(/pid=(\d+)/) ?? [])[1] ?? '', 10)
    if (Number.isInteger(pid) === false || pid <= 0) {
      recoverWindowsService()
      return {
        started: false,
        side,
        command: plan.display,
        reason: /cancel|取消|拒绝|denied|1223/i.test(output) ? 'UAC 被取消' : `未能启动（${output.trim().slice(0, 200) || '没有输出'}）`,
      }
    }
    writeRedirectorPid(pid, 'windows')
    // Keep the exact invocation: a later reload restarts the CLI from this, so the
    // profile path and verbose level cannot drift between starts.
    writeCliSpec({ exe: exePath, args: winArgs, log: winLog })
    const watchdog = Number.parseInt((output.match(/watchdog=(\d+)/) ?? [])[1] ?? '', 10)
    if (Number.isInteger(watchdog) && watchdog > 0) writeWatchdogPid(watchdog)
    // `dups` > 0 means a second CLI was still holding (or fighting for) the hook when
    // ours came up; the elevated script killed it, but say so — silent handle sharing
    // is exactly the failure that looks like "interception works, nothing captured".
    const duplicates = Number.parseInt((output.match(/dups=(-?\d+)/) ?? [])[1] ?? '0', 10)
    // Remember how the service was configured: we park an Automatic service on
    // Manual (otherwise Windows restarts it and steals the handle back), so the
    // original start type has to be written down to restore it on stop.
    const startType = (output.match(/startType=(\w+)/) ?? [])[1] ?? ''
    if (/svc=True/i.test(output)) {
      writeWindowsServiceState({
        stoppedByUs: true,
        originalStartType: startType === '' ? undefined : startType,
        parkedOnManual: /parked=True/i.test(output),
      })
    }
    // A CLI that exits immediately (bad profile, handle already taken) used to look
    // like success: the pid was written and never checked again.
    const alive = /alive=True/i.test(output)
    if (alive !== true) {
      clearRedirectorPid('windows')
      recoverWindowsService()
      const log = `${readTail(windowsLogLocalPath(), 4096)}\n${readTail(`${windowsLogLocalPath()}.err`, 2048)}`.trim()
      return {
        started: false,
        side,
        pid,
        command: plan.display,
        reason: `启动后退出（${log.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ').slice(0, 240) || '日志为空'}）`,
      }
    }
    clearStartTypeHint()
    return {
      started: true,
      pid,
      side,
      command: plan.display,
      duplicatesKilled: duplicates > 0 ? duplicates : 0,
      watchdog: Number.parseInt((output.match(/watchdog=(\d+)/) ?? [])[1] ?? '0', 10) || 0,
    }
  }

  if (hasElevation() === true) {
    const child = spawn(found.path, plan.args, { detached: true, stdio: 'ignore' })
    child.unref()
    writeRedirectorPid(child.pid, 'local')
    return { started: true, pid: child.pid, side, command: plan.display }
  }
  // Passwordless sudo only: asking for a password from a web route would hang.
  const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
  if (probe.status === 0) {
    const child = spawn('sudo', ['-n', found.path, ...plan.args], { detached: true, stdio: 'ignore' })
    child.unref()
    // `sudo` is a supervisor, not the CLI: recording its pid made a later stop kill
    // the supervisor and report success while the root CLI kept the eBPF hook — the
    // same trap as pkexec (review B-P1-2). Adopt the real CLI once it appears.
    const cliPid = await waitForOwnLocalPid({ timeoutMs: options.sudoWaitMs ?? SUDO_CLI_WAIT_MS })
    const pid = cliPid > 0 ? cliPid : child.pid
    writeRedirectorPid(pid, 'local')
    return { started: true, pid, side, command: plan.display, method: 'sudo', askerPid: child.pid }
  }
  // Only a user-initiated start may raise an interactive prompt (review B-P0-2): the
  // reconciler runs every minute, so pkexec/terminal here would pop a polkit dialog
  // or a whole terminal window per minute on a box where sudo -n is unavailable.
  // Background starts stop at the `manual` answer below.
  if (options.interactive !== true) {
    return { started: false, side, command: plan.display, method: 'manual', reason: '需要 root：请执行上面的命令（或给 sudo 配置免密）' }
  }
  // 「提权启动」: when sudo is not passwordless, pkexec can still ask through the
  // desktop's polkit agent (WSLg only — a plain WSL has no agent and exits at once).
  // It must run detached: the dialog belongs to the agent, and the daemon must not
  // hold a pipe that would keep the (root) child waiting.
  if (pkexecAvailable() === true) {
    const child = spawn('pkexec', [found.path, ...plan.args], { detached: true, stdio: 'ignore' })
    child.unref()
    // `pkexec` is only the asker: it forks the elevated CLI and waits for it. Writing
    // the asker's pid made a later "stop" kill pkexec and report success while the
    // root CLI kept the hook (review B-P1-2). The CLI is identified by THIS home's
    // profile path, so a password delay does not turn into a false "already dead".
    const cliPid = await waitForOwnLocalPid({ timeoutMs: options.pkexecWaitMs })
    if (cliPid > 0) {
      writeRedirectorPid(cliPid, 'local')
      return { started: true, pid: cliPid, side, command: plan.display, method: 'pkexec', askerPid: child.pid }
    }
    if (await pidAliveAfter(child.pid, PKEXEC_GRACE_MS) === true) {
      // The dialog is waiting for a password; the CLI does not exist yet. Do not
      // write a pid we cannot verify, and do not claim a successful start.
      return {
        started: false,
        side,
        command: plan.display,
        method: 'pkexec',
        deferred: true,
        reason: '已请求提权：在密码对话框里完成授权后系统层拦截就会启动（如果对话框还开着）',
      }
    }
    return {
      started: false,
      side,
      command: plan.display,
      method: 'pkexec',
      reason: '提权窗口没有完成（这台机器可能没有图形认证代理）：请在终端里执行上面的命令，或给 sudo 配置免密',
    }
  }
  // A desktop terminal can take the password for us: open one in which the CLI
  // starts as root, then report that we are waiting. That beats a dead pkexec on a
  // WSL box without a polkit agent, and the window is the user's to watch (m12782).
  const opened = await openElevatedTerminal(plan.display, side, { argv: [found.path, ...plan.args] })
  if (opened === true) {
    return {
      started: false,
      side,
      command: plan.display,
      method: 'terminal',
      deferred: true,
      reason: '已打开终端窗口：输入 sudo 密码后系统层拦截就会启动（这个窗口可以关闭）',
    }
  }
  return { started: false, side, command: plan.display, method: 'manual', reason: '需要 root：请执行上面的命令（或给 sudo 配置免密）' }
  } finally {
    lock.release()
  }
}

/** How long a detached pkexec ask may take before we call it failed (ms). */
const PKEXEC_GRACE_MS = 2500

/**
 * How long to wait for the real CLI after spawning pkexec (ms).
 *
 * The password is typed by a human, so the CLI appears well after `spawn` returns;
 * recording the asker instead was the bug (review B-P1-2). If the CLI does not show
 * up in this window we report "deferred", never a fake success.
 */
const PKEXEC_CLI_WAIT_MS = 8000
/** Same adoption budget for `sudo -n`, where no password dialog is involved. */
const SUDO_CLI_WAIT_MS = 3000

/**
 * Wait for our own local CLI to appear (matched by this home's profile path).
 * @param {{timeoutMs?: number}} [options] - override for tests.
 * @returns {Promise<number>} the CLI pid, or 0 when it never showed up.
 */
async function waitForOwnLocalPid(options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : PKEXEC_CLI_WAIT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = localRedirectorOwnPids()
    if (pids.length > 0) return pids[0]
    if (Date.now() >= deadline) return 0
    await sleepAsync(200)
  }
}

/** Terminal emulators we know how to open a privileged command in (m12782). */
const TERMINAL_CANDIDATES = [
  // Windows Terminal treats its first non-option token as the command line; a
  // leading `-e` is a WT option and shows its own usage error (m12840).
  // `--size` keeps the window small; `-f` (focus mode) maximizes it, so it is not
  // used anymore (m13083: the window is raised by focusWindowsTerminal instead).
  // Old WT builds reject unknown options the way they rejected `-e`, so the flags
  // only go in when the installed version is known to support them.
  // `--title` gives the window a stable name so the centering helper can find
  // exactly this window (WT hosts every window in one process, m13221).
  { bin: 'wt.exe', args: ['--size', '64,16', 'wsl.exe', '-e', 'bash', '-lc'], guardedFlags: 2 },
  { bin: 'x-terminal-emulator', args: ['-e', 'bash', '-lc'] },
  { bin: 'gnome-terminal', args: ['--', 'bash', '-lc'] },
  { bin: 'konsole', args: ['-e', 'bash', '-lc'] },
  { bin: 'xfce4-terminal', args: ['-x', 'bash', '-lc'] },
  { bin: 'mate-terminal', args: ['-e', 'bash', '-lc'] },
  { bin: 'xterm', args: ['-e', 'bash', '-lc'] },
]

/**
 * Whether a desktop session can show a terminal window. A headless box may still
 * have `xterm` on PATH, but spawning it only blocks/ fails — better to skip and
 * report the command than to claim a window was opened (m12884).
 * @returns {boolean} true with DISPLAY/WAYLAND_DISPLAY or an X11/Wayland session.
 */
function hasGraphicalSession() {
  const type = String(process.env.XDG_SESSION_TYPE ?? '').toLowerCase()
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || type === 'x11' || type === 'wayland')
}

/** Cached answer to "can this Windows Terminal take --focus?" (m12923). */
let wtFocusCache = null
/**
 * Read the installed Windows Terminal version once. `--focus` exists since 1.15,
 * and an unknown option makes WT show its own error window, so we only pass it
 * when we are sure (m12840 is the same failure mode with `-e`).
 * @returns {boolean} whether the host Windows Terminal understands --focus.
 */
function wtSupportsFocus() {
  if (wtFocusCache !== null) return wtFocusCache
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage Microsoft.WindowsTerminal).Version'], { encoding: 'utf8', timeout: 8000 })
    const match = /^(\d+)\.(\d+)/.exec(String(probe.stdout || '').trim())
    // `-f` (focus) and `--size` are safe from 1.15 on; older builds only get the
    // bare command line.
    wtFocusCache = match === null ? false : (Number(match[1]) > 1 || Number(match[2]) >= 15)
  } catch {
    wtFocusCache = false
  }
  return wtFocusCache
}

/** The helper's state file lives this long at most; an old one is not "still open". */
const ELEVATION_STATE_TTL_MS = 10 * 60 * 1000

/**
 * Canonical side name for the elevation helper: it only knows `local`/`windows`.
 * `linux` is the name the maintenance page uses for this side, so callers that pass
 * it must still find the file the helper wrote.
 * @param {string} side - any caller spelling.
 * @returns {'local'|'windows'|null} canonical side, or null for unknown input.
 */
function normalizeElevationSide(side) {
  const text = String(side ?? '').toLowerCase()
  if (text === 'windows') return 'windows'
  if (text === '' || text === 'local' || text === 'linux') return 'local'
  return null
}

/**
 * Whether the elevated-terminal window for a side is still open. The helper script
 * writes `<proxy home>/proxybridge/elevate-<side>.json` on start and removes it on
 * exit, which is exactly the lifetime of the window (m12923).
 *
 * A caller that has the proxy home (the daemon does) passes it as `home`; the state
 * file lives one level down, in `proxybridge/` (review B-P1-1 — reading
 * `<proxy home>/elevate-*.json` never found what the writer wrote).
 *
 * CONTRACT: `options.home` is the PROXY HOME (e.g. `proxyHomeDir()`), and this
 * function appends `proxybridge/` itself; the daemon does exactly that. Passing
 * `redirectorHome()` here would double the directory and the window would read as
 * closed — test/redirector.test.mjs pins this down.
 * @param {string} side 'linux' | 'windows' | 'local'.
 * @param {{home?: string}} [options] Proxy home override (tests).
 * @returns {{active: boolean, at?: string, pid?: number}} state.
 */
export function readElevationState(side, options = {}) {
  const normalized = normalizeElevationSide(side)
  if (normalized === null) return { active: false }
  const base = options.home === undefined ? redirectorHome() : join(options.home, REDIRECTOR_DIRNAME)
  const path = join(base, 'elevate-' + normalized + '.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    // A leftover file whose timestamp is old is not a window the user is looking at
    // (the helper normally removes it; a SIGKILL leaves it behind).
    const at = Date.parse(String(parsed.at ?? ''))
    if (Number.isFinite(at) === true && Date.now() - at > ELEVATION_STATE_TTL_MS) return { active: false }
    const pid = Number(parsed.pid)
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0) } catch (error) {
        if (error?.code !== 'EPERM') return { active: false }
      }
    }
    return { active: true, at: String(parsed.at ?? ''), pid: Number.isFinite(pid) ? pid : 0 }
  } catch {
    return { active: false }
  }
}

/** @param {string} bin @returns {boolean} whether `bin` resolves on PATH. */
function hasBinary(bin) {
  try {
    return spawnSync('sh', ['-lc', 'command -v ' + JSON.stringify(bin)], { encoding: 'utf8', timeout: 4000 }).status === 0
  } catch {
    return false
  }
}

/**
 * The helper script a terminal window runs: it takes the sudo ticket in the
 * foreground (the window is the TTY), then detaches the CLI so closing the window
 * does not kill the interception (m12896). Split out so tests can check the text.
 * @param {string} command Display/executable command (`sudo /path/ProxyBridge …`).
 * @param {string} side Which side is being started (only names the script/log).
 * @param {{dir?: string, argv?: string[]}} [options] Directory override (tests use a
 *   temp dir) and the exact argv when known.
 * @returns {{dir: string, scriptPath: string, logPath: string, body: string}} plan.
 */
export function elevationScript(command, side, options = {}) {
  const normalizedSide = normalizeElevationSide(side) ?? 'local'
  const dir = options.dir ?? redirectorHome()
  const name = 'elevate-' + normalizedSide
  const scriptPath = join(dir, name + '.sh')
  const logPath = join(dir, name + '.log')
  const bare = String(command).replace(/^sudo\s+/, '')
  // An argv lets us quote every entry for bash; the display string came from a
  // path that a user (or DSH_RIS_IDE_PROXYBRIDGE) can choose, and pasting it raw
  // let a `"`/`$(…)` in a directory name break or inject into the detached line
  // (review B-P2-10).
  const detached = Array.isArray(options.argv) === true && options.argv.length > 0
    ? 'nohup sudo -n ' + options.argv.map(shellQuote).join(' ') + ' > "$LOG" 2>&1 &'
    : 'nohup sudo -n ' + bare + ' > "$LOG" 2>&1 &'
  // The CLI is the interceptor itself, so it must outlive the terminal: ask sudo
  // for a ticket in the foreground (that is where the password prompt belongs),
  // then start the CLI detached with `sudo -n` and close the window (m12896).
  const body = [
    '#!/bin/bash',
    '# generated by risd for 「提权启动」(m12782/m12896)',
    'LOG=' + JSON.stringify(logPath),
    'STATE=' + JSON.stringify(join(dir, name + '.json')),
    'printf \'{"side":"%s","pid":%s,"at":"%s"}\\n\' ' + JSON.stringify(normalizedSide) + ' "$$" "$(date -Is)" > "$STATE"',
    'trap \'rm -f "$STATE"\' EXIT',
    'sudo -v || { echo; echo "没有拿到 sudo 授权，已取消。"; exit 1; }',
    detached,
    'echo',
    'echo "已在后台启动系统层拦截；日志：$LOG"',
    'echo "这个窗口会自动关闭。"',
    'sleep 1',
    '',
  ].join('\n')
  return { dir, scriptPath, logPath, body }
}

/**
 * @param {string} command Display/executable command (`sudo /path/ProxyBridge …`).
 * @param {string} side Which side is being started (only names the script).
 * @param {{argv?: string[], verifyMs?: number}} [options] - exact argv for safe
 *   quoting, and how long to wait for the helper's state file.
 * @returns {Promise<boolean>} true when a window actually started the helper.
 */
async function openElevatedTerminal(command, side, options = {}) {
  // A test run must never pop a real terminal window (m13621): under `node --test`
  // the runner sets NODE_TEST_CONTEXT, and spawning here would leave a password
  // prompt on the developer's desktop for every suite run. Callers fall back to the
  // printed `manual` command, which is all a test can assert anyway.
  // DSH_RIS_IDE_ALLOW_TERMINAL=1 is the explicit opt-in for a manual check.
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.DSH_RIS_IDE_ALLOW_TERMINAL !== '1') return false
  let script
  try {
    const plan = elevationScript(command, side, { argv: options.argv })
    mkdirSync(plan.dir, { recursive: true })
    writeFileSync(plan.scriptPath, plan.body, { mode: 0o755 })
    script = plan.scriptPath
  } catch {
    return false
  }
  let launched = false
  for (const candidate of TERMINAL_CANDIDATES) {
    // wt.exe is the WSL interop path (the Windows Terminal window belongs to the
    // host); the rest are X11/Wayland clients that need a session to attach to.
    if (candidate.bin !== 'wt.exe' && hasGraphicalSession() === false) continue
    if (hasBinary(candidate.bin) === false) continue
    const args = candidate.guardedFlags !== undefined && wtSupportsFocus() === false
      ? [...candidate.args.slice(candidate.guardedFlags), script]
      : [...candidate.args, script]
    try {
      if (candidate.bin === 'wt.exe') {
        // WT is launched by the helper itself, which then centers the new window.
        if (launchCenteredTerminal(args) === true) { launched = true; break }
        continue
      }
      const child = spawn(candidate.bin, args, { detached: true, stdio: 'ignore' })
      child.unref()
      launched = true
      break
    } catch { /* try the next one */ }
  }
  if (launched !== true) return false
  // A successful `spawn` is not a started window: ENOENT arrives as an async error,
  // and a broken wt.exe shim exits silently. The helper writes `<dir>/elevate-*.json`
  // as its first action, so that file is the proof (review B-P2-11).
  const stateSide = side === 'windows' ? 'windows' : 'local'
  const verifyMs = Number.isInteger(options.verifyMs) && options.verifyMs > 0 ? options.verifyMs : 4000
  for (let waited = 0; waited < verifyMs; waited += 100) {
    if (readElevationState(stateSide).active === true) return true
    await sleepAsync(100)
  }
  return false
}

/**
 * Open Windows Terminal and center the window it creates (m13147/m13221/m13257).
 *
 * `wt.exe` has no "center me" flag, and Windows Terminal hosts every window in one
 * process, so neither `Get-Process WindowsTerminal` nor a window title can identify
 * *this* window reliably. The helper therefore launches `wt.exe` itself: it records
 * the CASCADIA windows that already exist, starts the terminal, then moves the one
 * new window to the middle of the work area.
 */
const CENTER_TERMINAL_PS1 = [
  'param([string]$ArgJson)',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public class WinPos {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);',
  '  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref RECT r, uint f);',
  '  static List<IntPtr> Windows() {',
  '    var list = new List<IntPtr>();',
  '    EnumWindows((h, l) => {',
  '      if (!IsWindowVisible(h)) return true;',
  '      var c = new StringBuilder(256); GetClassName(h, c, 256);',
  '      if (c.ToString().IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return list;',
  '  }',
  '  public static string Handles() {',
  '    var parts = new List<string>();',
  '    foreach (var h in Windows()) parts.Add(h.ToString());',
  '    return string.Join(",", parts);',
  '  }',
  '  public static string CenterNew(string known) {',
  "    var old = new HashSet<string>((known ?? \"\").Split(new[]{','}, StringSplitOptions.RemoveEmptyEntries));",
  '    foreach (var h in Windows()) {',
  '      if (old.Contains(h.ToString())) continue;',
  '      var r = new RECT(); if (!GetWindowRect(h, out r)) continue;',
  '      int w = r.Right - r.Left, ht = r.Bottom - r.Top;',
  '      if (w <= 0 || ht <= 0) continue;',
  '      var wa = new RECT(); SystemParametersInfo(0x0030, 0, ref wa, 0);',
  '      int x = wa.Left + (wa.Right - wa.Left - w) / 2;',
  '      int y = wa.Top + (wa.Bottom - wa.Top - ht) / 2;',
  '      MoveWindow(h, x, y, w, ht, true);',
  '      return "moved " + h;',
  '    }',
  '    return "none";',
  '  }',
  '}',
  '"@',
  '$before = [WinPos]::Handles()',
  '$argv = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgJson)) | ConvertFrom-Json',
  "$cmd = ($argv | ForEach-Object { if ($_ -match '\\s') { '\"' + $_ + '\"' } else { $_ } }) -join ' '",
  "Start-Process -FilePath 'wt.exe' -ArgumentList $cmd | Out-Null",
  "$result = 'none'",
  "for ($i = 0; $i -lt 25 -and $result -eq 'none'; $i++) {",
  '  Start-Sleep -Milliseconds 200',
  '  $result = [WinPos]::CenterNew($before)',
  '}',
].join('\n')

/**
 * Launch Windows Terminal through the centering helper. Every argument crosses the
 * WSL boundary base64-encoded so quoting can never split the script path.
 * @param {string[]} argv Arguments for `wt.exe` (flags included).
 * @returns {boolean} true when the helper was spawned.
 */
function launchCenteredTerminal(argv) {
  try {
    const scriptPath = join(redirectorHome(), 'center-terminal.ps1')
    writeFileSync(scriptPath, `${CENTER_TERMINAL_PS1}\n`, { mode: 0o600 })
    const argJson = Buffer.from(JSON.stringify(argv), 'utf8').toString('base64')
    // `windowsPathOf` (unlike posixToWindowsPath) turns a WSL home into the
    // \\wsl.localhost share that Windows PowerShell can actually open; passing a
    // bare /home/... path made `-File` fail silently and no window appeared (m13375).
    // It must be a real Windows path: falling back to the Linux spelling only hides
    // that failure (review B-P2-12).
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', windowsPathOf(scriptPath, { mustConvert: true }), '-ArgJson', argJson], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Whether a polkit agent can be asked at all (m12606: 提权启动 button). *//** Whether a polkit agent can be asked at all (m12606: 提权启动 button). *//** Whether a polkit agent can be asked at all (m12606: 提权启动 button). */
let pkexecCache = null
/**
 * @returns {boolean} true when `pkexec` exists on PATH.
 */
function pkexecAvailable() {
  if (pkexecCache !== null) return pkexecCache
  try {
    const probe = spawnSync('pkexec', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    pkexecCache = probe.error === undefined && probe.status === 0
  } catch {
    pkexecCache = false
  }
  return pkexecCache
}

/**
 * Wait briefly and report whether a detached child is still there, which is how we
 * tell "pkexec is showing its dialog / started the CLI" from "it bailed out".
 * @param {number} pid Child pid.
 * @param {number} ms How long to watch.
 * @returns {Promise<boolean>} true when the process is still alive at the end.
 */
async function pidAliveAfter(pid, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try { process.kill(pid, 0); return true } catch (error) {
      if (error?.code === 'EPERM') return true
      return false
    }
  }
  return true
}

/** Where the vendored distribution for a platform lives (machine-wide, shared). */
export function redirectorVendorDir(options = {}) {
  const platform = options.platform ?? process.platform
  return join(redirectorHome(), 'vendor', platform === 'win32' ? 'windows' : 'linux')
}

let warnedBundleUnavailable = false
/**
 * Find a usable CLI for one side.
 *
 * `side` names the network stack that gets hooked, not the platform this process
 * runs on: inside WSL both sides exist and neither replaces the other.
 *
 * Before a Windows-side lookup, the cached distribution is materialised under
 * `%LOCALAPPDATA%` (unless the caller pinned `platform`, the test-only override).
 * Nothing is downloaded here — the maintenance page owns that — so a missing
 * distribution is reported through `missingBundle`/`reason`, never as silence.
 * @param {{side?: 'local'|'windows', platform?: string, targetDir?: string, bundleDir?: string}} [options] - overrides for tests.
 * @returns {{found: boolean, path: string, kind: string, candidates: string[], bundleDir: string, missingBundle: boolean, reason?: string}} the first hit plus the bundle diagnosis.
 */
export function findRedirector(options = {}) {
  const platform = options.platform ?? process.platform
  const side = options.side === 'windows' ? 'windows' : 'local'
  let bundleDir = options.bundleDir
  const needsWindowsBundle = platform === 'win32' || side === 'windows'
  const installed = bundleIsInstalled(bundledBundleDir())
  const missingBundle = installed !== true
  if (bundleDir === undefined && options.platform === undefined && needsWindowsBundle) {
    try {
      const prepared = options.targetDir === undefined ? prepareWindowsBundle() : prepareWindowsBundle({ targetDir: options.targetDir })
      if (typeof prepared === 'string' && prepared !== '') bundleDir = prepared
      else if (prepared === '' && missingBundle !== true && warnedBundleUnavailable !== true) {
        // Downloaded, but the Windows copy could not be made. Two very different
        // causes used to share one misleading line (m11624): %LOCALAPPDATA% unknown
        // (no cmd.exe interop) vs a copy that failed (usually EACCES because the
        // running ProxyBridgeSvc holds the DLLs).
        warnedBundleUnavailable = true
        const diagnosis = windowsBundleDiagnosis()
        if (diagnosis === null) {
          console.error('[dsh-ris-ide] 无法确定 %LOCALAPPDATA%：Windows 侧代理桥将直接使用下载缓存里的路径。')
        } else {
          // Only "the target is in use/busy" deserves the "stop the interception"
          // advice; ENOENT/EISDIR mean the copy itself is impossible (a bad bundle
          // or an unwritable %LOCALAPPDATA%), and telling people to stop a service
          // that is not running wastes their time.
          const busy = ['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(diagnosis.code)
          console.error(`[dsh-ris-ide] 复制 Windows 版 ProxyBridge 失败（${diagnosis.code}${diagnosis.file === '' ? '' : '：' + diagnosis.file}）：${busy ? '目标文件可能正被运行中的系统层拦截占用，请先停掉系统层拦截再重启 dsh。' : '请检查下载缓存与 %LOCALAPPDATA% 的可写性。'}Windows 侧将直接使用下载缓存里的路径；要更新副本请先修复上述问题。`)
        }
      }
    } catch (error) {
      if (warnedBundleUnavailable !== true) {
        warnedBundleUnavailable = true
        console.error(`[dsh-ris-ide] 准备 Windows 版 ProxyBridge 失败：${error?.message ?? String(error)}`)
      }
    }
  }
  const candidates = redirectorCandidates({ platform, side, ...(bundleDir === undefined ? {} : { bundleDir }) })
  for (const path of candidates) {
    if (existsSync(path) !== true) continue
    const kind = /\.exe$/i.test(path) === true ? 'windows-cli' : 'linux-cli'
    // A CLI we can actually run means the component is NOT missing, even when it
    // came from DSH_RIS_IDE_PROXYBRIDGE, a vendor/Program Files install, or an
    // explicit bundleDir instead of our download cache (review B-P2 missingBundle).
    return { found: true, path, kind, candidates, bundleDir: candidates.bundleDir, bundleCached: installed === true, missingBundle: false }
  }
  const result = { found: false, path: candidates[0] ?? '', kind: '', candidates, bundleDir: candidates.bundleDir, bundleCached: installed === true, missingBundle: candidates.missingBundle === true }
  if (result.missingBundle === true) result.reason = MISSING_BUNDLE_HINT
  else result.reason = side === 'windows' ? '未找到 Windows 版 ProxyBridge_CLI.exe' : '未找到本侧 ProxyBridge'
  return result
}

/** Ask the CLI for its version; '' when it cannot answer (cached: it never changes). */
export function redirectorVersion(cliPath) {
  if (typeof cliPath !== 'string' || cliPath === '' || existsSync(cliPath) !== true) return ''
  const now = Date.now()
  const cached = versionCache.get(cliPath)
  if (cached !== undefined && now - cached.at < VERSION_TTL_MS) return cached.version
  const run = () => probeVersionNow(cliPath)
  const version = typeof probeHooks.version === 'function' ? String(probeHooks.version(cliPath, run) ?? '') : run()
  versionCache.set(cliPath, { at: now, version })
  return version
}

function probeVersionNow(cliPath) {
  try {
    const output = spawnSyncText(cliPath, ['--version'], 6000)
    const match = /(\d+\.\d+\.\d+)/.exec(output)
    return match === null ? '' : match[1]
  } catch {
    return ''
  }
}

/**
 * A rule's `program` as ProxyBridge's ProcessName.
 *
 * A bare name has to match the image on both sides, so it is wrapped in stars
 * (`*java*` sees java.exe on Windows and java on Linux). A path is pinned to its
 * directory — YonCode keeps several JDKs around and only one of them is ours.
 * @param {string} value - program name or path.
 * @returns {string} ProcessName pattern.
 */
export function processPattern(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  if (cut === -1) return extname(text) === '' ? `*${text}*` : text
  const dir = text.slice(0, cut)
  const name = text.slice(cut + 1)
  const ext = extname(name)
  return ext === '' ? `${dir}${text[cut]}*` : `${dir}${text[cut]}*${ext}`
}

/**
 * Turn the rule table into a `.pbprofile`.
 *
 * Shape follows an export from the GUI: no `TargetDomains` (a "*" there reads as
 * "requests that have a domain", which would drop bare-IP targets), no
 * `LocalhostViaProxy` (the GUI omits it and false is the default — loopback must
 * stay local).
 * @param {object} config - engine config (`rules`, `socks`, `listenPort`).
 * @param {{upstream?: 'socks'|'engine', name?: string}} [options] - who terminates the tunnel.
 * @returns {{profile: object, rules: object[], skipped: string[]}} profile plus what was dropped and why.
 */
export function buildProfile(config, options = {}) {
  const upstream = options.upstream === 'engine' ? 'engine' : 'socks'
  const socks = config?.socks ?? { host: '', port: 0 }
  const proxyConfig = upstream === 'engine'
    ? { Id: 1, Name: 'dsh-ris-ide engine', Type: 'HTTP', Host: '127.0.0.1', Port: String(config?.listenPort ?? 0), Username: '', Password: '', SendDomainToProxy: false }
    : { Id: 1, Name: 'socks', Type: 'SOCKS5', Host: String(socks.host ?? ''), Port: String(socks.port ?? ''), Username: '', Password: '', SendDomainToProxy: true }
  const rules = []
  const skipped = []
  for (const rule of config?.rules ?? []) {
    if (rule.enabled !== true) {
      skipped.push(`${rule.id}: disabled`)
      continue
    }
    const processName = processPattern(rule.program)
    if (processName === '') {
      skipped.push(`${rule.id}: no program`)
      continue
    }
    const hosts = String(rule.hosts ?? '').trim()
    const ports = String(rule.ports ?? '').trim()
    // Every axis must be explicit and "everything" must be spelled `*`: a blank
    // host/port used to be coerced to `*`, which silently proxied the whole
    // internet for a half-written row.
    const verdict = ruleEffectiveness(rule)
    if (verdict.effective !== true) {
      skipped.push(`${rule.id}: ${verdict.reason}`)
      continue
    }
    rules.push({
      // ProxyBridge's GUI/CLI log shows this name, so a row that came from a
      // provider ("YonCode java") stays recognisable there too.
      Name: typeof rule.label === 'string' && rule.label !== '' ? rule.label : rule.id,
      ProcessName: processName,
      TargetHosts: hosts.replace(/\s+/g, ''),
      TargetPorts: ports.replace(/\s+/g, ''),
      // UDP as well: DNS and QUIC go over UDP, and a matching process should not
      // leak them around the tunnel.
      Protocol: 'BOTH',
      Action: 'PROXY',
      IsEnabled: true,
      ProxyConfigId: 1,
    })
  }
  const profile = {
    Version: PROFILE_VERSION,
    Name: options.name ?? 'dsh-ris-ide',
    // Connection logging on: without it a working interception and a dead one look
    // identical in the log (both show rules, neither shows traffic), which is exactly
    // the wrong thing to leave ambiguous in a developer tool.
    IsTrafficLoggingEnabled: true,
    AutoClearConnectionLogs: true,
    LogEveryConnection: true,
    Language: 'zh',
    CloseToTray: true,
    FontZoom: 100,
    NextProxyConfigId: 2,
    ProxyConfigs: [proxyConfig],
    ProxyRules: rules,
    LogFilters: [],
  }
  return { profile, rules, skipped }
}

/**
 * Write the profile, private: it carries the proxy address and possibly a password.
 * @throws when no rule survives — ProxyBridge rejects an empty rule set and a silent
 *         empty profile would look like a working setup that proxies nothing.
 */
export function writeRedirectorProfile(config, options = {}) {
  const { profile, rules, skipped } = buildProfile(config, options)
  if (rules.length === 0) throw new Error('没有可导出的规则：ProxyBridge 要求至少一条启用且带程序的规则')
  const path = options.path ?? redirectorProfilePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // Write-then-rename: the CLI reads this file while a rule edit may be writing it,
  // and a half-written profile made it start with no rules (review B-P2-3).
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // Filesystems without POSIX modes (a Windows share) simply keep their default.
    }
    renameSync(tmp, path)
    return { path, rules: rules.length, skipped }
  } finally {
    try { unlinkSync(tmp) } catch { /* renamed or never created */ }
  }
}

/** Quote one value for a single-quoted PowerShell literal (`'` becomes `''`). */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * End every Windows CLI, tracked or not.
 *
 * A hand-started CLI (or one whose pid file we lost) still owns the hook, and
 * ProxyBridge refuses to run twice — so "already running" means "get it out of the
 * way", not "give up".
 *
 * Only processes whose command line carries THIS home's profile path are ours: the
 * old machine-wide `Get-Process ProxyBridge_CLI | Stop-Process` killed another
 * dsh-ris-ide home's bridge (or a user's own instance) and then claimed success
 * (review A4-P2-1/B-P1-4). No match means "not ours", not "kill everything".
 * @param {{profilePath?: string}} [options] - profile override (tests).
 * @returns {Promise<{ok: boolean, killed?: number, reason?: string}>} outcome.
 */
export async function killWindowsCliProcesses(options = {}) {
  let profile = ''
  try {
    profile = windowsPathOf(String(options.profilePath ?? redirectorProfilePath()), { mustConvert: true })
  } catch (error) {
    return { ok: false, reason: error?.message ?? '无法确定本 home 的 profile 的 Windows 路径，未结束任何进程' }
  }
  const script = [
    "$ErrorActionPreference = 'Continue'",
    `$profile = ${psQuote(profile)}`,
    "$all = @(Get-CimInstance Win32_Process -Filter \"Name='ProxyBridge_CLI.exe'\" -ErrorAction SilentlyContinue)",
    "$found = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })",
    'if ($found.Count -eq 0) { "none"; return }',
    '$found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Milliseconds 800',
    '"killed=" + $found.Count',
  ].join('; ')
  const elevated = await psElevated(script, 20000)
  if (elevated.ok !== true) return { ok: false, reason: elevated.reason }
  const output = elevated.output
  const killed = /killed=(\d+)/.exec(output)
  if (killed !== null) return { ok: true, killed: Number.parseInt(killed[1], 10) }
  if (/none/.test(output)) {
    return { ok: false, reason: '正在运行的 ProxyBridge_CLI 不属于当前 profile，未结束它（避免误杀别的实例）' }
  }
  return {
    ok: false,
    reason: /cancel|取消|拒绝|denied|1223/i.test(output)
      ? 'UAC 被取消'
      : `无法结束已有的 ProxyBridge_CLI（${output.trim().slice(0, 160) || '没有输出'}）`,
  }
}

/**
 * The command that starts the CLI, spelled for the platform that will run it.
 *
 * On Windows the launch itself elevates (UAC), so the command is the exe; on Linux
 * the whole thing is a `sudo`. In WSL the Windows command must be translated: a
 * `/mnt/...` path does not exist in the Windows namespace.
 * @param {{cliPath: string, profilePath: string, verbose?: number, platform?: string, translate?: boolean}} options - inputs. `translate` overrides "may this machine spell paths the Windows way" (defaults to `platform === 'win32' && engineSide() === 'wsl'`); tests on a plain-Linux host pass `true`.
 * @returns {{command: string, args: string[], display: string, needsElevation: boolean}} runnable plan.
 */
export function redirectorCommand(options = {}) {
  const platform = options.platform ?? process.platform
  // 2 = per-connection lines (`[CONN] java.exe (PID) -> host:port via Proxy …`).
  // Level 1 only prints the rules, which makes a working interception and a dead
  // one look the same — the exact ambiguity that cost us an hour of guessing.
  const verbose = Number.isInteger(options.verbose) ? options.verbose : 2
  const args = ['--profile', String(options.profilePath ?? ''), '--verbose', String(verbose)]
  const translate = typeof options.translate === 'boolean'
    ? options.translate
    : platform === 'win32' && engineSide() === 'wsl'
  const exe = translate ? windowsPathOf(String(options.cliPath ?? '')) : String(options.cliPath ?? '')
  const shownArgs = translate ? windowsArgsOf(args) : args
  const quote = (value) => (/[ \t]/.test(value) === true ? `"${value}"` : value)
  const display = [quote(exe), ...shownArgs.map(quote)].join(' ')
  if (platform === 'win32') return { command: exe, args: shownArgs, display, needsElevation: true }
  return {
    command: 'sudo',
    args: [String(options.cliPath ?? ''), ...args],
    display: `sudo ${quote(String(options.cliPath ?? ''))} ${args.map(quote).join(' ')}`,
    needsElevation: true,
  }
}

/**
 * Stop the redirector(s).
 *
 * Synchronous by design: it is also called from the dsh exit hook, where async
 * cleanup does not run.
 *
 * Detection comes first (B5): a dead pid file used to make taskkill fail, the
 * liveness probe report "gone", and the caller show a clean stop while the real
 * elevated CLI kept intercepting. The three states are: nothing running, our
 * recorded process running, and a visible process we did not record (started by
 * hand, or after a lost pid file) — that one is stopped by image and reported.
 * @param {{graceMs?: number, side?: 'local'|'windows'}} [options] - wait budget / one side only.
 * @returns {{stopped: boolean, pid?: number, side?: string, service?: object, byWatchdog?: boolean, reason?: string, results?: object[]}} outcome.
 */
export function stopRedirectorSync(options = {}) {
  const sides = options.side === 'local' || options.side === 'windows' ? [options.side] : ['windows', 'local']
  const results = sides.map((side) => Object.assign({ side }, stopRedirectorSideSync(side, options)))
  // The async path reaps engine duplicates whose pid file was lost; the exit hook
  // has to keep the same single-instance promise (review B-P2-7). Signals only,
  // never wait: this runs while dsh is exiting.
  if (sides.includes('local')) {
    for (const pid of localRedirectorOwnPids()) {
      if (results.some((result) => result.pid === pid && result.stopped === true)) continue
      try { process.kill(pid, 'SIGTERM') } catch { /* either gone, or root — reported elsewhere */ }
    }
  }
  const stopped = results.filter((result) => result.stopped === true)
  if (stopped.length > 0) {
    const first = stopped[0]
    return { stopped: true, pid: first.pid, side: first.side, service: first.service, byWatchdog: first.byWatchdog, foreign: first.foreign === true, results }
  }
  // Nothing was even detected: keep the historical terse answer (the UI shows it).
  if (results.every((result) => result.pid === undefined)) return { stopped: false, reason: '未在运行' }
  // A root-owned engine cannot be signalled by us: never answer `stopped:true` for
  // it, and hand the caller the exact command that would finish the job (B-P1-2).
  const privileged = results.find((result) => result.stopped !== true && result.command !== undefined)
  if (privileged !== undefined) {
    return {
      stopped: false,
      pid: privileged.pid,
      side: privileged.side,
      command: privileged.command,
      hint: privileged.hint,
      reason: privileged.reason ?? '该系统层拦截由 root 启动，请用 sudo 停止',
      results,
    }
  }
  return { stopped: false, reason: results.map((result) => result.reason).filter(Boolean)[0] ?? '未发现运行中的桥接', results }
}

/**
 * Record that a stop hit a bridge we never wrote a pid file for.
 *
 * `stopRedirector()` also stops a hand-started CLI (the user pasted the sudo
 * command), which is deliberate — leaving root interception behind is worse.
 * But the daemon's own exit therefore ends another program some human started,
 * so the engine log must say so: a silent kill is indistinguishable from a crash
 * (review B-P2-10).
 * @param {{pid: number, source?: string}} target - detection result being stopped.
 * @returns {boolean} true when the entry was written.
 */
function noteForeignStop(target) {
  if (target.source === 'pidfile' || target.source === undefined) return false
  try {
    appendFileSync(proxyLogPath(), `${new Date().toISOString()} [dsh-ris-ide] 停止了一个非本工具记录的桥接 pid=${target.pid} (source=${target.source})\n`)
    return true
  } catch {
    return false
  }
}

/** Stop one side; detection first, so a dead record can never fake success. */
function stopRedirectorSideSync(side, options) {
  const record = redirectorPidRecord(side)
  let target = null
  if (record.pid > 0 && pidAliveOn(record.pid, side)) target = { pid: record.pid, source: 'pidfile' }
  if (target === null) {
    const detection = detectRunningRedirector()
    const found = side === 'windows' ? detection.windows : detection.local
    if (found.pid > 0) target = { pid: found.pid, source: found.source }
  }
  if (target === null) {
    // Drop a dead record: otherwise the next status keeps advertising a pid that
    // does not exist and the user cannot tell "stopped" from "lost track".
    if (record.pid > 0) clearRedirectorPid(side)
    return { stopped: false, reason: '未发现运行中的桥接' }
  }
  if (side === 'windows') return stopWindowsSideSync(target, options)
  return stopLocalSideSync(target, options)
}

/**
 * Windows side: the CLI runs elevated, so a plain taskkill from here cannot touch
 * it. Ask the watchdog (the elevated helper we spawned at start) first: it kills
 * the CLI and puts ProxyBridgeSvc back, with no second UAC.
 */
function stopWindowsSideSync(target, options) {
  const foreign = target.source !== undefined && target.source !== 'pidfile'
  const foreignLogged = foreign ? noteForeignStop(target) : false
  requestRedirectorStop()
  const graceMs = Number.isInteger(options.graceMs) && options.graceMs > 0 ? options.graceMs : 4000
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && stopCompleted() !== true) sleepSync(100)
  const byWatchdog = stopCompleted() === true
  const output = byWatchdog === true ? 'SUCCESS' : runTaskkillSync(target.pid)
  // The liveness answer must not come from a 5 s cache filled before the kill.
  const gone = byWatchdog !== true && pidAliveOn(target.pid, 'windows', { force: true }) === false
  if (byWatchdog === true || /SUCCESS|成功/i.test(output) || gone) {
    clearRedirectorPid('windows')
    // Give the GUI service its hook back if we were the ones who stopped it (the
    // watchdog normally already did it; a hand-started CLI still needs this).
    const service = restoreWindowsService()
    clearStopSignals()
    return { stopped: true, pid: target.pid, source: target.source, service, byWatchdog, foreign, foreignLogged }
  }
  const hint = target.source === 'pidfile' ? '' : '（检测到进程但不在记录中，可能需要管理员权限）'
  return { stopped: false, pid: target.pid, source: target.source, foreign, foreignLogged, reason: `无法停止 Windows 进程 ${target.pid}${hint}（${output.trim().slice(0, 120) || '没有输出'}）` }
}

/**
 * The answer for a local engine that belongs to root.
 *
 * A root process answers SIGTERM with EPERM and `kill(pid, 0)` still succeeds, so
 * `stopped:true` would be a lie while the interception keeps running (review
 * B-P1-2). The caller cannot elevate from a web route, so it gets the exact command.
 * @param {number} pid - the privileged engine.
 * @param {object} [extra] - per-side fields to keep.
 * @returns {object} stop result.
 */
function privilegedStopResult(pid, extra = {}) {
  const command = `sudo kill ${Number(pid)}`
  return {
    stopped: false,
    pid,
    ...extra,
    command,
    reason: '该系统层拦截由 root 启动，请用 sudo 停止',
    hint: `在终端执行：${command}`,
  }
}

function stopLocalSideSync(target, options) {
  const foreign = target.source !== undefined && target.source !== 'pidfile'
  const foreignLogged = foreign ? noteForeignStop(target) : false
  try { process.kill(target.pid, 'SIGTERM') } catch (error) {
    if (error?.code === 'EPERM') return privilegedStopResult(target.pid, { side: 'local', foreign, foreignLogged })
  }
  // Block the exit hook briefly: SIGTERM on the engine is quick, and leaving a
  // root process behind after dsh quits is worse than a short delay.
  const limit = Date.now() + (Number.isInteger(options.graceMs) && options.graceMs > 0 ? options.graceMs : 3000)
  while (Date.now() < limit && pidAlive(target.pid)) sleepSync(120)
  if (pidAlive(target.pid)) {
    // Alive after TERM and KILL: either root, or a zombie the kernel will reap.
    return privilegedStopResult(target.pid, { side: 'local', foreign, foreignLogged })
  }
  clearRedirectorPid('local')
  return { stopped: true, pid: target.pid, source: target.source, side: 'local', foreign, foreignLogged }
}

/** taskkill one pid (checked from the pid file) — test seam `taskkill` overrides it. */
function runTaskkillSync(pid) {
  if (typeof probeHooks.taskkill === 'function') return String(probeHooks.taskkill(pid) ?? '')
  return spawnSyncText('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 8000)
}

/** Whether this process already has the rights the redirector needs. */
export function hasElevation() {
  if (IS_WINDOWS) return false
  return typeof process.getuid === 'function' && process.getuid() === 0
}

/**
 * Live Windows CLI pids, cached for a few seconds.
 *
 * This used to be a blocking PowerShell call (15 s timeout, 3–4 s real) on every
 * status render; it froze the whole dsh process while it ran. The answer is cached
 * for PROBE_TTL_MS and an async variant exists so HTTP routes never block (M3).
 * @param {{force?: boolean}} [options] - bypass the cache.
 * @returns {number[]} live pids; empty when this host has no Windows side.
 */
export function windowsRedirectorPids(options = {}) {
  if (typeof probeHooks.windowsPids !== 'function' && IS_WINDOWS !== true && existsSync('/mnt/c') !== true) return []
  const now = Date.now()
  if (options.force !== true && windowsPidsCache.pids !== null && now - windowsPidsCache.at < PROBE_TTL_MS) return windowsPidsCache.pids.slice()
  const probed = typeof probeHooks.windowsPids === 'function' ? probeHooks.windowsPids() : readWindowsPidsSync()
  const pids = Array.isArray(probed) ? probed.filter((pid) => Number.isInteger(pid) && pid > 0) : []
  windowsPidsCache = { at: now, pids }
  return pids.slice()
}

/** Async variant of {@link windowsRedirectorPids}: never blocks the event loop. */
export async function windowsRedirectorPidsAsync(options = {}) {
  if (typeof probeHooks.windowsPidsAsync !== 'function' && typeof probeHooks.windowsPids !== 'function' && IS_WINDOWS !== true && existsSync('/mnt/c') !== true) return []
  const now = Date.now()
  if (options.force !== true && windowsPidsCache.pids !== null && now - windowsPidsCache.at < PROBE_TTL_MS) return windowsPidsCache.pids.slice()
  let probed = null
  if (typeof probeHooks.windowsPidsAsync === 'function') probed = await probeHooks.windowsPidsAsync()
  else if (typeof probeHooks.windowsPids === 'function') probed = probeHooks.windowsPids()
  else probed = await readWindowsPidsAsync()
  const pids = Array.isArray(probed) ? probed.filter((pid) => Number.isInteger(pid) && pid > 0) : []
  windowsPidsCache = { at: Date.now(), pids }
  return pids.slice()
}

function readWindowsPidsSync() {
  try {
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        '@(Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    )
    if (out.status !== 0) return []
    return String(out.stdout ?? '')
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

async function readWindowsPidsAsync() {
  const output = await runTextAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '@(Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }'],
    15000,
  )
  return output
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

/**
 * @param {'local'|'windows'} [side] - omit for the first side that has a record.
 * @returns {number} live pid, or 0.
 */
export function redirectorPid(side) {
  const record = redirectorPidRecord(side)
  return record.pid > 0 && pidAliveOn(record.pid, record.side) ? record.pid : 0
}

/**
 * The raw pid record of one side (or of whichever side has one).
 *
 * The legacy single file is migrated on read, so an upgrade does not turn a running
 * bridge into an orphan. Liveness is NOT checked here — see redirectorPid().
 * @param {'local'|'windows'} [side] - which side; omit for local-then-windows.
 * @returns {{pid: number, side: 'local'|'windows'}} record (pid 0 when absent).
 */
export function redirectorPidRecord(side) {
  migrateLegacyPidFile()
  if (side === 'local' || side === 'windows') {
    return readPidFileAt(redirectorSidePidPath(side)) ?? { pid: 0, side }
  }
  const local = readPidFileAt(redirectorSidePidPath('local'))
  if (local !== null) return local
  const windows = readPidFileAt(redirectorSidePidPath('windows'))
  if (windows !== null) return windows
  return { pid: 0, side: 'local' }
}

/**
 * Whether the THIS-SIDE engine is running.
 *
 * The two sides are not interchangeable: a Windows ProxyBridge hooks the Windows
 * network stack, so a Java process we start in WSL is invisible to it. Deciding
 * "interception covers us" therefore has to ask about the local side only.
 * @returns {boolean} true when a Linux/macOS ProxyBridge of ours is alive.
 */
export function localRedirectorRunning() {
  const record = redirectorPidRecord('local')
  if (record.pid > 0 && pidAlive(record.pid)) return true
  // dsh on Windows: there is only one machine, so the 'windows' record IS the local
  // one — otherwise a running interceptor would not count and the config would be
  // adapted to the fallback path while the kernel hook is actually live.
  if (IS_WINDOWS) {
    const onWindows = redirectorPidRecord('windows')
    return onWindows.pid > 0 && pidAliveOn(onWindows.pid, 'windows')
  }
  // A hand-started `sudo ProxyBridge …` has no pidfile entry of ours.
  return scanLocalProcForRedirector() > 0
}

/**
 * Scan /proc for a hand-started engine (`/path/ProxyBridge … --profile …`).
 *
 * The argv[0] check matters: "some process whose command line mentions
 * ProxyBridge" also matches a shell that merely greps for it, and acting on that
 * pid would signal the wrong process. The redirector's own binary name is the only
 * safe identity we have without elevation.
 * @returns {number} pid or 0.
 */
function scanLocalProcForRedirector() {
  const pids = localRedirectorPids()
  return pids.length > 0 ? pids[0] : 0
}

/**
 * Local ProxyBridge processes that belong to THIS proxy home (review B-P1-4).
 *
 * `localRedirectorPids()` finds every ProxyBridge on the machine, which is right for
 * diagnostics but wrong for `kill`: two dsh profiles (or a hand-started CLI for a
 * different profile) must not be reaped by one session's stop/restart. Only a
 * process whose `--profile` is our own profile file is ours.
 * @returns {number[]} pids of our own local bridge processes.
 */
export function localRedirectorOwnPids() {
  if (IS_WINDOWS) return []
  if (typeof probeHooks.localProc === 'function') {
    const raw = probeHooks.localProc()
    return Array.isArray(raw) ? raw.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) : []
  }
  const own = redirectorProfilePath()
  const pids = []
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
        if (!argv.some((token) => /(^|[\\/])ProxyBridge(\.exe)?$/i.test(token))) continue
        let profile = ''
        for (let index = 0; index < argv.length; index += 1) {
          if (argv[index] === '--profile') { profile = String(argv[index + 1] ?? ''); break }
          if (argv[index].startsWith('--profile=')) { profile = argv[index].slice('--profile='.length); break }
        }
        if (profile === own) pids.push(Number.parseInt(entry, 10))
      } catch { /* vanished */ }
    }
  } catch { /* no /proc */ }
  return pids
}

/**
 * Every local ProxyBridge process, not just the first (m11773).
 *
 * A lost pid file used to make the next start spawn a second engine: the scan found
 * *a* process and reported "already running", but nothing ever reaped the extra one.
 * Single-instance on this side means knowing all of them, so a start/stop can drop
 * duplicates and leave exactly the process we mean to keep.
 * @returns {number[]} live pids running our redirector marker.
 */
export function localRedirectorPids() {
  if (IS_WINDOWS) return []
  if (typeof probeHooks.localProc === 'function') {
    const raw = probeHooks.localProc()
    return Array.isArray(raw) ? raw.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) : []
  }
  const pids = []
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
        const isRedirector = argv.some((token) => /(^|[\\/])ProxyBridge(\.exe)?$/i.test(token))
        if (isRedirector && argv.some((token) => token === '--profile' || token.startsWith('--profile='))) {
          pids.push(Number.parseInt(entry, 10))
        }
      } catch { /* vanished */ }
    }
  } catch { /* no /proc */ }
  return pids
}

/**
 * Age at which an owner-less start lock is considered abandoned.
 *
 * A crashed starter can die between `mkdir` and the owner write; the next start
 * then sees an owner-less directory. Waiting 30 s for it (the old value, longer
 * than the 15 s default wait) made every start fail until the mtime aged out.
 */
const STALE_LOCK_MS = 5000

/** Where startRedirector() keeps its per-side "a start is in progress" lock. */
function startLockDir(side) {
  return join(proxyHomeDir(), 'locks', `proxybridge-${side === 'windows' ? 'windows' : 'local'}.lock`)
}

/**
 * Is somebody holding the start lock for this side right now?
 *
 * Used by stopRedirector() when nothing is detected yet: during the UAC wait the
 * pid files are already gone, so the lock is the only proof that a start is still
 * in flight. A lock left behind by a crashed starter also answers true; it is
 * ignored/reaped by the next real starter (STALE_LOCK_MS), and "pendingStart" is a
 * truthful answer for it (a start is what would happen next, not a stop).
 * @param {'local'|'windows'} side - which side to probe.
 * @returns {boolean} true when the lock directory exists.
 */
export function startLockHeld(side) {
  try { return existsSync(startLockDir(side)) } catch { return false }
}

/**
 * Cross-process start lock for one side (m11773).
 *
 * The daemon and the plugin (its local fallback) can both decide to start the same
 * bridge at the same second; the Windows side then gets two elevated helpers and the
 * local side two engines. A lock directory under the shared proxy home serialises
 * the detect-then-spawn sequence across processes. It is deliberately tiny: create
 * with `mkdir` (atomic), write the owner pid, remove in `release()`; a lock whose
 * owner is gone (or which is older than the timeout) is treated as stale.
 * @param {'local'|'windows'} side - which side to lock.
 * @param {{timeoutMs?: number}} [options] - how long to wait for a concurrent start.
 * @returns {Promise<{ok: boolean, stale?: boolean, release?: () => void, reason?: string}>} outcome.
 */
export async function acquireStartLock(side, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000
  const dir = startLockDir(side)
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 })
      try {
        writeFileSync(join(dir, 'owner'), `${process.pid}\n`, { mode: 0o600 })
      } catch { /* the dir alone is enough */ }
      let released = false
      return {
        ok: true,
        release() {
          if (released === true) return
          released = true
          // Only remove OUR lock: if the directory was already reaped as stale and
          // re-created by a successor, deleting it would hand the next starter a
          // lock-free window (review B-P2-9).
          try {
            const owner = Number.parseInt(readFileSync(join(dir, 'owner'), 'utf8').trim(), 10)
            const legacy = Number.isInteger(owner) !== true
            if (legacy === false && owner !== process.pid) return
          } catch {
            // No owner file: the starter died before writing it, so this is ours.
          }
          try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: `无法获取启动锁：${error?.message ?? error}` }
    }
    // Stale? A killed starter leaves the directory behind; its owner pid is the proof.
    let stale = false
    try {
      const owner = Number.parseInt(readFileSync(join(dir, 'owner'), 'utf8').trim(), 10)
      stale = Number.isInteger(owner) && owner > 0 && pidAlive(owner) !== true
      if (Number.isInteger(owner) !== true) stale = true
    } catch {
      // No owner file: only age can tell (the starter may die between mkdir and write).
      // The threshold must stay well below the default wait (15 s), or a crashed
      // starter makes the next few starts fail for half a minute (review B-P2-9).
      try {
        stale = Date.now() - statSync(dir).mtimeMs > STALE_LOCK_MS
      } catch { stale = true }
    }
    if (stale === true) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* retry loop */ }
      continue
    }
    if (Date.now() >= deadline) return { ok: false, reason: '另一个进程正在启动桥接，请稍后再试' }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Is a pid alive on a given side?
 *
 * Windows pids are invisible to `process.kill` on Linux, so they are asked about
 * through PowerShell's CIM provider. The answer is cached for PROBE_TTL_MS because
 * status renders ask on every request; pass `{force:true}` when the answer decides
 * what to do next (e.g. after a taskkill).
 * @param {number} pid - the process to check.
 * @param {'local'|'windows'} side - which machine owns that pid.
 * @param {{force?: boolean}} [options] - bypass the cache.
 * @returns {boolean} liveness.
 */
export function pidAliveOn(pid, side, options = {}) {
  if (side !== 'windows') return pidAlive(pid)
  if (IS_WINDOWS) return pidAlive(pid)
  const now = Date.now()
  const cached = windowsAliveCache.get(pid)
  if (options.force !== true && cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.alive
  const alive = typeof probeHooks.windowsAlive === 'function' ? probeHooks.windowsAlive(pid) === true : readWindowsAliveSync(pid)
  windowsAliveCache.set(pid, { at: now, alive })
  return alive
}

/** Async variant of {@link pidAliveOn}; never blocks the event loop. */
export async function pidAliveOnAsync(pid, side, options = {}) {
  if (side !== 'windows') return pidAlive(pid)
  if (IS_WINDOWS) return pidAlive(pid)
  const now = Date.now()
  const cached = windowsAliveCache.get(pid)
  if (options.force !== true && cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.alive
  const alive = typeof probeHooks.windowsAliveAsync === 'function'
    ? await probeHooks.windowsAliveAsync(pid) === true
    : await readWindowsAliveAsync(pid)
  windowsAliveCache.set(pid, { at: Date.now(), alive })
  return alive
}

function readWindowsAliveSync(pid) {
  // Get-Process, not Win32_Process: the CLI runs elevated and a non-elevated CIM
  // query for another account's process comes back empty, which would report a
  // running engine as dead (and make `stop` skip the taskkill).
  const output = spawnSyncText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], 6000)
  return /alive/.test(output)
}

async function readWindowsAliveAsync(pid) {
  const output = await runTextAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], 6000)
  return /alive/.test(output)
}

/**
 * Write one side's pid file (only after the process is confirmed alive).
 * @param {number} pid - process id.
 * @param {'local'|'windows'} [side] - which machine it runs on.
 */
export function writeRedirectorPid(pid, side = 'local') {
  const which = side === 'windows' ? 'windows' : 'local'
  mkdirSync(redirectorHome(), { recursive: true, mode: 0o700 })
  writeFileSync(redirectorSidePidPath(which), `${pid} ${which}\n`, { encoding: 'utf8', mode: 0o600 })
  // The per-side file supersedes the legacy one; keeping both invites confusion.
  try { unlinkSync(redirectorPidPath()) } catch { /* absent */ }
}

/**
 * Remove a pid file.
 * @param {'local'|'windows'} [side] - one side; omit for both (plus the legacy file).
 */
export function clearRedirectorPid(side) {
  const paths = side === 'local' || side === 'windows'
    ? [redirectorSidePidPath(side)]
    : [redirectorSidePidPath('local'), redirectorSidePidPath('windows'), redirectorPidPath()]
  for (const path of paths) {
    try { unlinkSync(path) } catch { /* already gone */ }
  }
}

/**
 * Find running redirectors, per side, including ones started by hand.
 *
 * The pidfile only exists when WE spawned it; a user who pasted the sudo command
 * starts a process we never saw, and reporting "not running" then is a lie the
 * dialog shows. So the per-side pidfile is the fast path, a `/proc` scan is the
 * local fallback (root cmdlines stay readable unless hidepid is on) and the
 * Windows process table covers the other side.
 *
 * Three discovery sources, named for what they looked at: `pidfile` (we spawned
 * it), `proc` (`/proc` command lines, POSIX) and `process` (Windows process
 * table). `''` means nothing was found.
 * @returns {{pid: number, source: string, side: string, local: {pid: number, source: string}, windows: {pid: number, source: string}}} discovery result; `pid` is the first live hit.
 */
export function detectRunningRedirector() {
  if (probesStubbed()) return emptyDetection()
  migrateLegacyPidFile()
  const local = detectSide('local')
  const windows = detectSide('windows')
  const primary = local ?? windows
  return {
    pid: primary?.pid ?? 0,
    source: primary?.source ?? '',
    side: primary?.side ?? '',
    local: local === null ? { pid: 0, source: '' } : { pid: local.pid, source: local.source },
    windows: windows === null ? { pid: 0, source: '' } : { pid: windows.pid, source: windows.source },
  }
}

/**
 * Is the machine-probing test stub switched on?
 *
 * `__test.setProbeHooks` only reaches this process, but the risd tests run the
 * daemon as a CHILD process, and its save path calls `redirectorStatusCached()`
 * after every write. Two cold PowerShell probes cost ~8 s on WSL, so each save in
 * those files waited for an answer that the test must not depend on (whether the
 * developer's own ProxyBridge happens to be running) — and adoption could even
 * stomp the real pidfiles. The child inherits `DSH_RIS_IDE_STUB_PROBES=1` from
 * `test/risd-helpers.mjs`; production never sets it.
 */
function probesStubbed() {
  return process.env.DSH_RIS_IDE_STUB_PROBES === '1'
}

/** The "nothing is running" shape both stubbed detectors return. */
function emptyDetection() {
  return { pid: 0, source: '', side: '', local: { pid: 0, source: '' }, windows: { pid: 0, source: '' } }
}

/** @returns {object|null} discovery hit for one side. */
function detectSide(side) {
  const record = redirectorPidRecord(side)
  if (record.pid > 0 && pidAliveOn(record.pid, side)) return { pid: record.pid, side, source: 'pidfile' }
  if (side === 'windows') {
    const live = windowsRedirectorPids()
    if (live.length > 0) {
      writeRedirectorPid(live[0], 'windows')
      return { pid: live[0], side, source: 'process' }
    }
    return null
  }
  const own = localRedirectorOwnPids()
  if (own.length > 0) {
    // A bridge started by hand (the card's sudo command) has no pid file; without
    // adopting it, teardown/空闲退出/崩溃重启 could never stop it (review A4-P1-2).
    writeRedirectorPid(own[0], 'local')
    return { pid: own[0], side, source: 'proc' }
  }
  return null
}

/** Async variant of {@link detectRunningRedirector}: safe to call from HTTP routes. */
export async function detectRunningRedirectorAsync() {
  if (probesStubbed()) return emptyDetection()
  migrateLegacyPidFile()
  const record = redirectorPidRecord('local')
  const local = record.pid > 0 && await pidAliveOnAsync(record.pid, 'local')
    ? { pid: record.pid, side: 'local', source: 'pidfile' }
    : null
  let windows = null
  const windowsRecord = redirectorPidRecord('windows')
  if (windowsRecord.pid > 0 && await pidAliveOnAsync(windowsRecord.pid, 'windows')) {
    windows = { pid: windowsRecord.pid, side: 'windows', source: 'pidfile' }
  } else {
    const live = await windowsRedirectorPidsAsync()
    if (live.length > 0) {
      writeRedirectorPid(live[0], 'windows')
      windows = { pid: live[0], side: 'windows', source: 'process' }
    }
  }
  let localHit = local
  if (localHit === null) {
    const own = localRedirectorOwnPids()
    if (own.length > 0) {
      writeRedirectorPid(own[0], 'local')
      localHit = { pid: own[0], side: 'local', source: 'proc' }
    }
  }
  const primary = localHit ?? windows
  return {
    pid: primary?.pid ?? 0,
    source: primary?.source ?? '',
    side: primary?.side ?? '',
    local: localHit === null ? { pid: 0, source: '' } : { pid: localHit.pid, source: localHit.source },
    windows: windows === null ? { pid: 0, source: '' } : { pid: windows.pid, source: windows.source },
  }
}

/**
 * Current redirector state, for the dialog and the CLI.
 *
 * `local` and `windows` are independent: uninstalling the Windows app leaves the
 * Windows side unavailable while the WSL side keeps working, and vice versa.
 * @returns {{local: object, windows: object, profilePath: string, profileExists: boolean, running: boolean, pid: number, logPath: string, elevated: boolean}} state.
 */
/**
 * Where the Windows CLI's stdout goes (it has no log-file option of its own).
 *
 * It cannot be a path inside our home: the elevated process that writes it cannot
 * reach the WSL share, so the file has to live on the Windows side and be read back
 * through /mnt. Two spellings, one file.
 */
export function windowsLogPath() {
  return `${windowsTempDir()}\\dsh-ris-proxybridge.log`
}

let windowsTempDirCache = ''

/**
 * `%TEMP%` as Windows spells it.
 *
 * The WSL login name is not the Windows account name often enough to matter (here
 * they differ), so ask cmd.exe once instead of guessing a profile directory.
 */
export function windowsTempDir() {
  if (windowsTempDirCache !== '') return windowsTempDirCache
  const output = spawnSyncText('cmd.exe', ['/c', 'echo %TEMP%'], 6000)
  const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[A-Za-z]:\\/.test(line) === true)
  windowsTempDirCache = first ?? 'C:\\Windows\\Temp'
  return windowsTempDirCache
}

/** The same file, as a path this process can read. */
export function windowsLogLocalPath() {
  const match = /^([A-Za-z]):\\(.*)$/.exec(windowsLogPath())
  if (match === null) return windowsLogPath()
  return join(`/mnt/${match[1].toLowerCase()}`, match[2].replace(/\\/g, '/'))
}

export const SERVICE_STATE_FILENAME = 'proxybridge-service.json'

/**
 * Where we remember the parked Windows service.
 *
 * The writer, the watchdog and the janitor must agree on this ONE path: the
 * watchdog used to receive `proxyHomeDir()/…` while the writer stored
 * `proxyHomeDir()/proxybridge/…`, so the teardown's Set-Service/Start-Service never
 * ran and the user's service stayed stopped.
 * @returns {string} absolute path.
 */
export function serviceStatePath() {
  return join(redirectorHome(), SERVICE_STATE_FILENAME)
}

/** The pre-fix location (one directory too high); only read to migrate it away. */
export function legacyServiceStatePath() {
  return join(proxyHomeDir(), SERVICE_STATE_FILENAME)
}

/**
 * Move a parked-service state file from the old wrong location into `proxybridge/`.
 * @returns {boolean} true when a usable state file is now at the canonical path.
 */
export function migrateLegacyServiceState() {
  const legacy = legacyServiceStatePath()
  const target = serviceStatePath()
  if (existsSync(legacy) !== true) return existsSync(target)
  try {
    if (existsSync(target) !== true) {
      mkdirSync(redirectorHome(), { recursive: true, mode: 0o700 })
      writeFileSync(target, readFileSync(legacy), { mode: 0o600 })
    }
    unlinkSync(legacy)
    return true
  } catch {
    // Best effort: reading the legacy path still works below until the next try.
    return existsSync(target)
  }
}

/**
 * Remember that we stopped the GUI's Windows service on the way in.
 *
 * ProxyBridge's service and its CLI are mutually exclusive (both want the WinDivert
 * handle), so starting the CLI means the service must yield — but silently leaving
 * a service the user installed stopped after our session is not acceptable either.
 */
export function writeWindowsServiceState(state) {
  try {
    mkdirSync(redirectorHome(), { recursive: true, mode: 0o700 })
    writeFileSync(serviceStatePath(), JSON.stringify(Object.assign({ at: Date.now() }, state), null, 2), { mode: 0o600 })
  } catch {
    // Best effort: losing this only means the service is not restarted for us.
  }
}

export function readWindowsServiceState() {
  migrateLegacyServiceState()
  try {
    return JSON.parse(readFileSync(serviceStatePath(), 'utf8'))
  } catch {
    return null
  }
}

export function clearWindowsServiceState() {
  for (const path of [serviceStatePath(), legacyServiceStatePath()]) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
}

/**
 * Windows path of the file the elevated helper writes its report into.
 *
 * Start-Process can either elevate or redirect, never both, so the snippet writes
 * this file and the host reads it through the /mnt view.
 */
export function elevatedOutputWindowsPath() {
  return windowsLogPath().replace(/dsh-ris-proxybridge\.log$/, 'dsh-ris-elevated.out')
}

/** The same file as a path this process can read. */
export function elevatedOutputLocalPath() {
  return windowsLogLocalPath().replace(/dsh-ris-proxybridge\.log$/, 'dsh-ris-elevated.out')
}

/** First-line marker of this run's report; a leftover file carries an older one. */
const ELEVATED_NONCE_PREFIX = '@RUN '

/**
 * Read the elevated helper's report, accepting only THIS run's.
 * @param {string} localPath - file as seen here.
 * @param {string} nonce - this run's id.
 * @returns {{state: 'pending'|'stale'|'match', output: string}} what was found.
 */
function readElevatedReport(localPath, nonce) {
  // The nonce is the FIRST line, so read from the start; a tail read would cut it
  // off as soon as the snippet prints more than the tail budget.
  let text = ''
  try {
    text = readFileSync(localPath, 'utf8').slice(0, 1024 * 1024)
  } catch {
    return { state: 'pending', output: '' }
  }
  if (text.trim() === '') return { state: 'pending', output: '' }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0].trim() === `${ELEVATED_NONCE_PREFIX}${nonce}`) {
    return { state: 'match', output: lines.slice(1).join('\n').trim() }
  }
  return { state: 'stale', output: '' }
}

/**
 * Run a PowerShell snippet elevated and bring its output back.
 *
 * Start-Process can either elevate or redirect, never both, so the snippet writes to
 * a file we then read. That file survives across calls, so the previous run's output
 * is a trap: it was read as this run's success and produced a "started" answer with
 * a dead pid (B1). We delete it first and only accept a report stamped with this
 * run's nonce; a stale-only observation is a failure with a readable reason.
 * @param {string} script - PowerShell body.
 * @param {number} timeoutMs - one overall deadline for launch + report.
 * @param {{localPath?: string, windowsPath?: string, nonce?: string, pollMs?: number, launch?: Function}} [options] - test seams.
 * @returns {Promise<{ok: boolean, output: string, nonce: string, timedOut: boolean, reason?: string}>} result.
 */
async function psElevated(script, timeoutMs = 20000, options = {}) {
  const localPath = options.localPath ?? elevatedOutputLocalPath()
  const windowsPath = options.windowsPath ?? elevatedOutputWindowsPath()
  const nonce = typeof options.nonce === 'string' && options.nonce !== '' ? options.nonce : `run-${randomUUID()}`
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 300
  const deadline = Date.now() + timeoutMs
  // The file is shared with earlier runs: a leftover must never answer for this one.
  try {
    unlinkSync(localPath)
  } catch {
    try {
      writeFileSync(localPath, '', { mode: 0o600 })
    } catch {
      // Read-only: the nonce check still rejects a stale report.
    }
  }
  const body = [
    "$ErrorActionPreference = 'Continue'",
    `$out = '${windowsPath.replace(/'/g, "''")}'`,
    `$nonce = '${nonce.replace(/'/g, "''")}'`,
    "$text = ''",
    `try { $text = (& { ${script} } 2>&1 | Out-String) } catch { $text = ('ERR: ' + $_.Exception.Message) }`,
    "(@('@RUN ' + $nonce) + @($text)) | Set-Content -Path $out -Encoding utf8",
  ].join('; ')
  const encoded = Buffer.from(body, 'utf16le').toString('base64')
  const launch = `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs -PassThru -WindowStyle Hidden | Out-Null`
  const launchEncoded = Buffer.from(launch, 'utf16le').toString('base64')
  const launchTimeout = Math.max(1000, deadline - Date.now())
  if (typeof options.launch === 'function') {
    await options.launch({ localPath, windowsPath, nonce, body, timeoutMs: launchTimeout })
  } else if (typeof probeHooks.elevatedLaunch === 'function') {
    await probeHooks.elevatedLaunch({ localPath, windowsPath, nonce, body, timeoutMs: launchTimeout })
  } else {
    // Async on purpose (review B-P0-1): this launcher blocks until the UAC dialog is
    // answered, which used to freeze the daemon's event loop for up to 45 s. The
    // caller keeps awaiting the overall deadline, so the visible semantics (and the
    // 45 s/20 s budgets) are unchanged.
    await spawnDetachedText('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', launchEncoded], launchTimeout)
  }
  let sawStale = false
  while (Date.now() < deadline) {
    const report = readElevatedReport(localPath, nonce)
    if (report.state === 'match') return { ok: true, output: report.output, nonce, timedOut: false }
    if (report.state === 'stale') sawStale = true
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  const report = readElevatedReport(localPath, nonce)
  if (report.state === 'match') return { ok: true, output: report.output, nonce, timedOut: false }
  return {
    ok: false,
    output: '',
    nonce,
    timedOut: true,
    reason: sawStale === true
      ? '只读到上一轮的提权输出，本轮没有写出结果（UAC 未响应或脚本失败）'
      : '等待提权结果超时（UAC 未响应或脚本没有写出结果）',
  }
}

/** Wait until a pid started through cmd.exe/UAC is actually up. */
export async function waitForWindowsAlive(pid, timeoutMs = 3000) {
  if (Number.isInteger(pid) !== true || pid <= 0) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const output = spawnSyncText('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`,
    ], 6000)
    if (/alive/.test(output)) return true
  }
  return false
}

/** Restart the GUI service we stopped, if it is still installed. */
export function restoreWindowsService() {
  const state = readWindowsServiceState()
  if (state === null || state.stoppedByUs !== true) return { restored: false, reason: '未停止过服务' }
  // Put the start type back first: we parked it on Manual so Windows would stop
  // resurrecting the service mid-session, and leaving it that way would change the
  // machine's boot behaviour behind the user's back.
  if (typeof state.originalStartType === 'string' && state.originalStartType !== '') {
    spawnSyncText('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Set-Service ProxyBridgeSvc -StartupType ${state.originalStartType} -ErrorAction SilentlyContinue`,
    ], 10000)
  }
  const output = spawnSyncText('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Start-Service ProxyBridgeSvc -ErrorAction SilentlyContinue; (Get-Service ProxyBridgeSvc -ErrorAction SilentlyContinue).Status",
  ], 20000)
  clearWindowsServiceState()
  if (/Running/i.test(output)) return { restored: true }
  return { restored: false, reason: `服务未能恢复（${output.trim().slice(0, 120) || '需要管理员'}）` }
}

/** Where the elevated start leaves the service's original start type. */
function startTypeHintPath() {
  return join(redirectorHome(), 'windows-start-type.txt')
}

/** Read the hint left by the elevated start script (`''` when absent/invalid). */
export function readStartTypeHint() {
  try {
    const hint = readFileSync(startTypeHintPath(), 'utf8').trim()
    return /^(Automatic|AutomaticDelayedStart|Manual|Disabled)$/i.test(hint) ? hint : ''
  } catch {
    return ''
  }
}

/** Drop the start-type hint (after a successful start or a restored service). */
export function clearStartTypeHint() {
  try {
    unlinkSync(startTypeHintPath())
  } catch {
    // Nothing to clear.
  }
}

/**
 * Put ProxyBridgeSvc back after a Windows start failed.
 *
 * The elevated helper stops the service and may park it on Manual before the CLI is
 * even spawned, so every failure path after that point has to undo it — otherwise
 * the machine stays "service stopped + StartupType Manual" until the next stop or
 * dsh exit (review B-P1-3). The original start type reaches us through the script's
 * hint file because the process may die before it reports anything.
 * @returns {{restored: boolean, reason?: string}} restoreWindowsService() result.
 */
export function recoverWindowsService() {
  const state = readWindowsServiceState()
  const hint = readStartTypeHint()
  if (state === null && hint !== '') {
    writeWindowsServiceState({ stoppedByUs: true, originalStartType: hint, parkedOnManual: true })
  }
  const restored = restoreWindowsService()
  clearStartTypeHint()
  return restored
}

/**
 * Assemble the status object from one detection snapshot.
 * @param {object} detection - detectRunningRedirector() result.
 * @param {'sync'|'async'} mode - async mode must never spawn (version comes from cache).
 * @returns {object} status.
 */
function buildStatus(detection, mode) {
  const describe = (side) => {
    const found = findRedirector({ side })
    let version = ''
    if (found.found === true) {
      // The async route must not block 6 s on `--version`: take it from the cache.
      version = mode === 'async' ? (versionCache.get(found.path)?.version ?? '') : redirectorVersion(found.path)
    }
    // `missingBundle` + `reason` let the maintenance page say "download/upload the
    // component" instead of showing an unexplained empty path.
    return {
      available: found.found,
      path: found.path,
      kind: found.kind,
      version,
      missingBundle: found.missingBundle === true,
      ...(found.reason === undefined ? {} : { reason: found.reason }),
    }
  }
  const profilePath = redirectorProfilePath()
  return {
    local: describe('local'),
    windows: describe('windows'),
    profilePath,
    profileExists: existsSync(profilePath),
    running: detection.pid > 0,
    // 'proc' = started outside the plugin (the user pasted our command), so
    // `stop` will need their sudo as well.
    runningSource: detection.source,
    // Which machine owns the pid: a Windows redirector is stopped with taskkill,
    // never with a signal from this side.
    runningSide: detection.side || redirectorPidRecord().side,
    // Per side: the rules only apply where the bridge actually runs.
    runningLocal: detection.local.pid > 0,
    runningWindows: detection.windows.pid > 0,
    localPid: detection.local.pid,
    windowsPid: detection.windows.pid,
    pid: detection.pid,
    logPath: redirectorLogPath(),
    elevated: hasElevation(),
  }
}

/**
 * Current redirector state, synchronously (the CLI, the exit hook, editors).
 *
 * Every probe is cached (pid table 5 s, alive 5 s, version 60 s), so repeated calls
 * stop costing 3–4 s of blocked event loop per status render.
 * @returns {object} state.
 */
export function redirectorStatus() {
  return buildStatus(detectRunningRedirector(), 'sync')
}

/**
 * Status for HTTP routes: cached for STATUS_TTL_MS, so a burst of requests costs
 * one detection instead of one each.
 * @param {{ttlMs?: number}} [options] - override the TTL (tests).
 * @returns {object} status plus `{cached, ageMs}`.
 */
export function redirectorStatusCached(options = {}) {
  const now = Date.now()
  const ttl = Number.isInteger(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : STATUS_TTL_MS
  if (statusCache.value !== null && now - statusCache.at < ttl) {
    return Object.assign({}, statusCache.value, { cached: true, ageMs: now - statusCache.at })
  }
  const value = redirectorStatus()
  statusCache = { at: Date.now(), value }
  return Object.assign({}, value, { cached: false, ageMs: 0 })
}

/**
 * Status for HTTP routes, fully asynchronous: no spawnSync, no blocked event loop.
 * Concurrent callers share one in-flight probe instead of stacking PowerShell runs.
 * @param {{ttlMs?: number}} [options] - override the TTL (tests).
 * @returns {Promise<object>} status plus `{cached, ageMs}`.
 */
export async function redirectorStatusAsync(options = {}) {
  const now = Date.now()
  const ttl = Number.isInteger(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : STATUS_TTL_MS
  if (statusCache.value !== null && now - statusCache.at < ttl) {
    return Object.assign({}, statusCache.value, { cached: true, ageMs: now - statusCache.at })
  }
  if (statusInflight !== null) return statusInflight
  statusInflight = (async () => {
    try {
      const detection = await detectRunningRedirectorAsync()
      const value = buildStatus(detection, 'async')
      statusCache = { at: Date.now(), value }
      return Object.assign({}, value, { cached: false, ageMs: 0 })
    } finally {
      statusInflight = null
    }
  })()
  return statusInflight
}

/**
 * Export the profile and (only when we already have the rights) start it.
 *
 * When we cannot elevate we still write the profile and return the command, so the
 * user can paste it — better than a failure that leaves nothing behind.
 * @param {string} cwd - workspace whose rules are exported.
 * @param {{upstream?: 'socks'|'engine', start?: boolean, verbose?: number}} [options] - behaviour.
 * @returns {Promise<object>} summary with `written`, `command`, `started`/`pid`, or `reason`.
 */
export async function syncRedirector(cwd, options = {}) {
  const config = readProxyConfig(cwd)
  const written = writeRedirectorProfile(config, { upstream: options.upstream })
  const found = findRedirector({ side: options.side })
  if (found.found === false) {
    return { written, command: '', started: false, reason: found.reason ?? '未找到 ProxyBridge CLI（可用 DSH_RIS_IDE_PROXYBRIDGE 指定，或在维护页「代理 → 组件」上传/下载组件）', missingBundle: found.missingBundle === true }
  }
  const command = redirectorCommand({ cliPath: found.path, profilePath: written.path, verbose: options.verbose })
  if (options.start === false) return { written, command, started: false, reason: '' }
  const running = redirectorPid()
  if (running > 0) return { written, command, started: false, pid: running, reason: '已在运行（先 stop）' }
  if (hasElevation() === false) return { written, command, started: false, reason: '需要管理员/sudo：请执行上面的命令' }
  const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore' })
  child.unref()
  writeRedirectorPid(child.pid)
  return { written, command, started: true, pid: child.pid }
}

/**
 * Start the system-level interception that pairs with the proxy engine.
 *
 * The engine alone cannot cover a program it did not spawn, so the two are
 * started together: every side that has a ProxyBridge CLI and is not running yet
 * is launched, and an elevation prompt (UAC on Windows) is the expected outcome
 * rather than an error. A side that needs a password we cannot type is reported
 * with the command instead of failing the whole start.
 * @param {{sides?: string[], verbose?: number, interactive?: boolean}} [options] - sides to consider, in order;
 *   `interactive:true` is the only path allowed to raise a pkexec/terminal prompt (review B-P0-2).
 * @returns {Promise<{started: object[], skipped: object[], running: boolean}>} per-side outcome.
 */
export async function startRedirectors(options = {}) {
  // Never pop an elevation prompt from a test run: node --test marks its children
  // with NODE_TEST_CONTEXT, and a UAC dialog would block the suite on a desktop
  // nobody is watching.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    return { started: [], skipped: [{ side: '', reason: '测试环境不启动系统层拦截' }], running: false }
  }
  // A Windows host has only one machine: 'local' would resolve to the same
  // ProxyBridge_CLI.exe and the second start would fight for the WinDivert handle.
  // The plugin now ships that CLI, so the default there is the windows side alone.
  const sides = Array.isArray(options.sides) && options.sides.length > 0
    ? options.sides
    : (process.platform === 'win32' ? ['windows'] : ['windows', 'local'])
  // `reload` applies edited rules to a bridge that is already running.
  const reload = options.reload === true
  const started = []
  const skipped = []
  const detection = detectRunningRedirector()
  // On a Windows host there is no second machine: 'local' and 'windows' resolve to
  // the same ProxyBridge_CLI.exe, and starting it twice means two engines fighting
  // for the WinDivert handle. Keep the first side that claims a given binary.
  const claimed = new Set()
  for (const side of sides) {
    const found = findRedirector({ side })
    if (found.found !== true) {
      skipped.push({ side, reason: found.reason ?? `未找到 ${side === 'windows' ? 'Windows' : '本侧'} ProxyBridge`, missingBundle: found.missingBundle === true })
      continue
    }
    if (claimed.has(found.path)) {
      skipped.push({ side, reason: '与另一侧是同一个可执行文件（单机 Windows），已由该侧启动' })
      continue
    }
    claimed.add(found.path)
    // One redirector per side: an already running engine there owns the hook.
    const runningHere = side === 'windows' ? detection.windows : detection.local
    if (runningHere.pid > 0) {
      // Editing rules must not require another UAC: the elevated watchdog restarts
      // the CLI with the profile we just wrote (it reads the profile only at start).
      if (reload === true) {
        const reloaded = await reloadRedirector({ side, pid: runningHere.pid })
        if (reloaded.reloaded === true) started.push({ side, pid: reloaded.pid ?? runningHere.pid, reloaded: true })
        else skipped.push({ side, reason: reloaded.reason, pid: runningHere.pid })
        continue
      }
      skipped.push({ side, reason: `已在运行（pid ${runningHere.pid}）`, pid: runningHere.pid })
      continue
    }
    const result = await startRedirector({ side, verbose: options.verbose, interactive: options.interactive === true })
    if (result.started === true) started.push(result)
    else skipped.push(Object.assign({ side }, result))
  }
  return { started, skipped, running: started.length > 0 || detection.pid > 0 }
}

/**
 * Rewrite the profile for a workspace and reload whichever bridges are running.
 *
 * This is the helper a save-rules route should call (B3): the old route asked the
 * redirectors to "reload" without writing the new profile first, so the watchdog
 * restarted the CLI on the OLD rules and the UI said "已重启".
 * @param {string} cwd - workspace whose proxy rules were just saved.
 * @param {{sides?: string[], upstream?: 'socks'|'engine', timeoutMs?: number, profilePath?: string}} [options] - behaviour.
 * @returns {Promise<{ok: boolean, written: {path: string, rules: number, skipped: object[]}, reloaded: object[], skipped: object[], reason?: string}>} outcome.
 */
export async function reloadRedirectorsWithProfile(cwd, options = {}) {
  // A Windows host has only one machine: 'local' would resolve to the same
  // ProxyBridge_CLI.exe and the second start would fight for the WinDivert handle.
  // The plugin now ships that CLI, so the default there is the windows side alone.
  const sides = Array.isArray(options.sides) && options.sides.length > 0
    ? options.sides
    : (process.platform === 'win32' ? ['windows'] : ['windows', 'local'])
  let written = null
  try {
    written = writeRedirectorProfile(readProxyConfig(cwd), { upstream: options.upstream, path: options.profilePath })
  } catch (error) {
    // A profile with no usable rule is a real failure: a reload would restart the
    // bridge with rules that proxy nothing.
    return { ok: false, written: null, reloaded: [], skipped: [], reason: `规则未能写入：${error?.message ?? error}` }
  }
  const detection = detectRunningRedirector()
  const reloaded = []
  const skipped = []
  for (const side of sides) {
    const runningHere = side === 'windows' ? detection.windows : detection.local
    if (runningHere.pid <= 0) {
      skipped.push({ side, reason: '未运行' })
      continue
    }
    if (side !== 'windows') {
      skipped.push({ side, pid: runningHere.pid, reason: '本侧由 root 启动，编辑规则请重启（sudo）' })
      continue
    }
    const result = await reloadRedirector({ side, pid: runningHere.pid, timeoutMs: options.timeoutMs })
    if (result.reloaded === true) reloaded.push({ side, pid: result.pid ?? runningHere.pid })
    else skipped.push({ side, pid: runningHere.pid, reason: result.reason })
  }
  return { ok: reloaded.length > 0, written, reloaded, skipped }
}

/**
 * Restart a running bridge so it picks up the profile on disk.
 *
 * The CLI parses `--profile` once at start, so edited rules otherwise only apply
 * after a manual stop/start (which costs a UAC prompt). The watchdog is already
 * elevated: it kills the CLI and starts it again from the recorded spec.
 *
 * The watchdog's report is structured and must prove the new process is alive with
 * the recorded profile (B4): "the done file exists" used to be the whole check, so a
 * failed restart still reported success. On success the NEW pid is recorded (M2).
 * @param {{side?: string, pid?: number, timeoutMs?: number}} options - which side and how long to wait.
 * @returns {Promise<{reloaded: boolean, pid?: number, reason: string}>} outcome.
 */
export async function reloadRedirector(options = {}) {
  const side = options.side === 'windows' ? 'windows' : 'local'
  if (side !== 'windows') return { reloaded: false, reason: '本侧由 root 启动，编辑规则请重启（sudo）' }
  if (watchdogPid() <= 0) return { reloaded: false, reason: '没有提权看门狗（旧版本启动的），请停止后重新启动一次' }
  const id = `reload-${randomUUID()}`
  clearReloadSignals()
  // The seam lets a test answer the request itself (no real watchdog needed).
  const requested = typeof probeHooks.requestReload === 'function'
    ? probeHooks.requestReload({ id }) === true
    : requestRedirectorReload({ id }) === true
  if (requested !== true) return { reloaded: false, reason: '无法写入重载请求' }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const done = readReloadDone()
    if (done !== null && done.ok === true && (done.legacy === true || done.id === '' || done.id === id)) {
      // A done file that cannot name a live new process is not evidence of success.
      if (done.legacy === true || done.pid <= 0) {
        return { reloaded: false, reason: '看门狗报告成功但没有新进程 pid（旧版看门狗），请停止后重新启动一次' }
      }
      if (pidAliveOn(done.pid, 'windows', { force: true }) !== true) {
        return { reloaded: false, reason: `看门狗报告新进程 ${done.pid} 但已不在运行（规则可能有问题）` }
      }
      const specs = readCliSpec()
      if (specs !== null) writeRedirectorPid(done.pid, 'windows')
      return { reloaded: true, pid: done.pid, reason: '已按新规则重启桥接' }
    }
    const failed = readReloadFailure()
    if (failed !== null && failed.ok !== true) {
      return { reloaded: false, reason: `看门狗重载失败：${failed.error || '未知原因'}` }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  return { reloaded: false, reason: `看门狗未在 ${Math.round(timeoutMs / 1000)}s 内完成重载` }
}

/**
 * Stop the redirector started by startRedirector(), both sides if needed.
 *
 * It runs as root (Linux) or elevated (Windows), so a normal user cannot signal
 * it: the failure is reported as "run this as root" rather than thrown, because
 * the caller (a web route) has no way to elevate.
 *
 * Detection comes first (B5): "the recorded pid is dead" is not "nothing runs" —
 * a CLI started by hand, or after a lost pid file, still intercepts.
 * @param {{graceMs?: number, side?: 'local'|'windows'}} [options] - how long to wait / one side.
 * @returns {Promise<{stopped: boolean, pid?: number, side?: string, reason?: string, results?: object[]}>} outcome.
 */
export async function stopRedirector(options = {}) {
  // Serialise with startRedirector (review B-P1-5): the elevated start holds that
  // side's lock for up to 45 s while UAC waits. A stop that ran meanwhile saw
  // nothing, answered "未在运行", and the start then finished on an already-stopped
  // engine. Only the side(s) we are about to touch are locked (review follow-up):
  // taking both up front made a plain "stop" wait 2x15 s behind a Windows UAC start.
  const requestedSide = options.side === 'local' || options.side === 'windows' ? options.side : null
  const preliminary = detectRunningRedirector()
  const sidesToLock = requestedSide !== null ? [requestedSide]
    : ['windows', 'local'].filter((side) => preliminary[side]?.pid > 0)
  const clearDeadRecords = () => {
    for (const side of ['windows', 'local']) {
      if (redirectorPidRecord(side).pid > 0) clearRedirectorPid(side)
    }
  }
  if (sidesToLock.length === 0) {
    // Nothing is running *now* — but a start may be mid-flight and its pid files
    // already cleared (the UAC wait is the long part). The start lock is the only
    // signal left, so probe it without blocking instead of answering "未在运行".
    const starting = (requestedSide !== null ? [requestedSide] : ['windows', 'local']).find((side) => startLockHeld(side))
    if (starting !== undefined) {
      return { stopped: false, pendingStart: true, side: starting, reason: '另一个进程正在启动桥接，请稍后再试' }
    }
    clearDeadRecords()
    return { stopped: false, reason: '未在运行' }
  }
  const locks = []
  for (const side of sidesToLock) {
    const lock = await acquireStartLock(side, { timeoutMs: options.lockTimeoutMs })
    if (lock.ok !== true) {
      for (const held of locks) held.release()
      return { stopped: false, pendingStart: true, side, reason: lock.reason ?? '另一个进程正在启动桥接，请稍后再试' }
    }
    locks.push(lock)
  }
  try {
    // Re-detect under the lock: the start we waited for may have failed, and the
    // side we detected a moment ago may be gone (or a different one may be up).
    const detection = detectRunningRedirector()
    if (detection.pid === 0) {
      // Drop dead records so status stops advertising a pid that does not exist.
      clearDeadRecords()
      return { stopped: false, reason: '未在运行' }
    }
    const results = []
    if (detection.windows.pid > 0) {
      results.push(Object.assign({ side: 'windows' }, stopRedirectorSync(Object.assign({}, options, { side: 'windows' }))))
    }
    if (detection.local.pid > 0) {
      results.push(Object.assign({ side: 'local' }, await stopLocalRedirectorAsync(detection.local.pid, options)))
    }
    // Local duplicates: an engine whose pid file we lost still holds the eBPF hook.
    // Stopping "the recorded one" is not enough for a single-instance invariant.
    // A root engine answers SIGTERM with EPERM: that is not "stopped" (review B-P1-2).
    const blocked = []
    for (const pid of localRedirectorOwnPids()) {
      if (results.some((result) => result.pid === pid && result.stopped === true)) continue
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if (error?.code === 'EPERM') blocked.push(pid)
      }
    }
    if (blocked.length > 0) {
      const command = 'sudo kill ' + blocked.join(' ')
      return {
        stopped: false,
        pid: blocked[0],
        pids: blocked,
        command,
        reason: '该系统层拦截由 root 启动，请用 sudo 停止',
        hint: `在终端执行：${command}`,
        results,
      }
    }
    const stopped = results.filter((result) => result.stopped === true)
    // A side stopped while the other reported "root, use sudo" is still an
    // unfinished stop: saying `stopped:true` hides the interception that is running.
    const needsSudo = results.find((result) => result.stopped !== true && result.command !== undefined)
    if (needsSudo !== undefined) {
      return {
        stopped: false,
        pid: needsSudo.pid,
        side: needsSudo.side,
        command: needsSudo.command,
        reason: needsSudo.reason ?? '该系统层拦截由 root 启动，请用 sudo 停止',
        results,
      }
    }
    if (stopped.length === 0) {
      return {
        stopped: false,
        pid: detection.pid,
        reason: results.map((result) => result.reason).filter(Boolean)[0] ?? '未能停止桥接',
        results,
      }
    }
    return { stopped: true, pid: stopped[0].pid, side: stopped[0].side, results }
  } finally {
    for (const held of locks) held.release()
  }
}

/** Graceful local stop with SIGKILL fallback (the exit hook used to do this inline). */
async function stopLocalRedirectorAsync(pid, options = {}) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'EPERM') return privilegedStopResult(pid)
    return {
      stopped: false,
      pid,
      reason: `无法停止进程 ${pid}（${code || error?.message}）`,
    }
  }
  const limit = Date.now() + (Number.isInteger(options.graceMs) && options.graceMs > 0 ? options.graceMs : 5000)
  while (Date.now() < limit) {
    if (pidAlive(pid) === false) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* still privileged: report below */ }
  }
  if (pidAlive(pid)) return privilegedStopResult(pid)
  clearRedirectorPid('local')
  return { stopped: true, pid }
}

/** Run a command and return its combined output as text (no throw). */
/**
 * The Windows spelling of a path this side of the OS boundary can see.
 *
 * `Start-Process -FilePath '/mnt/d/…'` fails with "系统找不到指定的文件": mnt paths are
 * WSL-only. `wslpath -w` is authoritative when present (it also handles the
 * `\\wsl.localhost\<distro>` form for our home directory); the drive-letter
 * rewrite is the fallback for a distro without it.
 *
 * A caller that NEEDS the Windows form (launch a program, read a file from
 * PowerShell) must pass `{mustConvert:true}`: silently returning the Linux spelling
 * made the launch fail with no diagnostic at all (review B-P2-12).
 * @param {string} path - an absolute Linux path, possibly under /mnt/<drive>.
 * @param {{mustConvert?: boolean}} [options] - throw when no Windows form is found.
 * @returns {string} the same location as Windows sees it.
 */
export function windowsPathOf(path, options = {}) {
  const text = String(path ?? '')
  if (text === '') return text
  if (/^[A-Za-z]:[\\/]/.test(text)) return text
  // /mnt/<letter>/ IS drive <letter> by definition, and doing it first keeps the
  // answer right even for a path that does not exist yet (`wslpath` would then
  // answer with a \\wsl.localhost\… share that Windows cannot open).
  const mounted = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(text)
  if (mounted !== null) return `${mounted[1].toUpperCase()}:\\${mounted[2].replace(/\//g, '\\')}`
  if (windowsPathTranslator !== null) {
    const injected = windowsPathTranslator(text)
    if (typeof injected === 'string' && injected !== '') return injected
  }
  const converted = spawnSyncText('wslpath', ['-w', text], 4000).trim()
  if (converted !== '' && /^[A-Za-z]:[\\/]|^\\\\/.test(converted)) return converted
  if (options.mustConvert === true) {
    throw new Error(`无法把路径转换为 Windows 形式（wslpath 不可用或失败）：${text}`)
  }
  return text
}

/**
 * Translate only the argv entries that really are existing files.
 *
 * ProxyBridge's own flags look like paths (`/d`, `/p:key=value`), so "starts with
 * `/`" is not enough: translating those into `\d` / `\p:key=value` corrupts the
 * command line. Windows-spelled values (`C:\…`, `\\wsl.localhost\…`) are already
 * correct for the other side and must be left untouched.
 * @param {object[]} args - argv as this side spells it.
 * @returns {object[]} Windows-spelled argv.
 */
function windowsArgsOf(args, options = {}) {
  return args.map((arg) => {
    if (typeof arg !== 'string' || arg.startsWith('/') !== true) return arg
    try {
      if (existsSync(arg) !== true || statSync(arg).isFile() !== true) return arg
    } catch {
      return arg
    }
    return windowsPathOf(arg, options)
  })
}

function spawnSyncText(command, args, timeoutMs) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export const __test = {
  PROFILE_VERSION,
  setWindowsPathTranslator: (fn) => { windowsPathTranslator = typeof fn === 'function' ? fn : null },
  bundledBundleDir,
  bundleCacheInstalled,
  ensureBundleReady,
  MISSING_BUNDLE_HINT,
  startRedirector,
  stopRedirectorSync,
  pidAliveOn,
  pidAliveOnAsync,
  redirectorPidRecord,
  detectRunningRedirector,
  detectRunningRedirectorAsync,
  stopRedirector,
  redirectorVendorDir,
  redirectorHome,
  redirectorProfilePath,
  buildProfile,
  processPattern,
  redirectorCommand,
  findRedirector,
  redirectorCandidates,
  writeRedirectorProfile,
  redirectorStatus,
  redirectorStatusCached,
  redirectorStatusAsync,
  reloadRedirector,
  reloadRedirectorsWithProfile,
  redirectorPid,
  writeRedirectorPid,
  clearRedirectorPid,
  redirectorSidePidPath,
  serviceStatePath,
  migrateLegacyPidFile,
  migrateLegacyServiceState,
  windowsRedirectorPids,
  windowsRedirectorPidsAsync,
  readReloadDone,
  readReloadFailure,
  setProbeHooks,
  resetProbeHooks,
  clearProbeCaches,
  sleepSync,
  psElevated,
  watchdogPid,
  acquireStartLock,
  localRedirectorPids,
  localRedirectorOwnPids,
  writeWatchdogPid,
  reloadDonePath,
  reloadFailedPath,
  windowsPathOf,
  windowsArgsOf,
  spawnDetachedText,
  privilegedStopResult,
  readStartTypeHint,
  clearStartTypeHint,
  startTypeHintPath,
  recoverWindowsService,
}

const SELF = basename(process.argv[1] ?? '')
if (/^redirector\.mjs$|^redirector\.js$/.test(SELF)) {
  const command = process.argv[2] ?? 'status'
  const cwd = process.argv[3] ?? process.cwd()
  const run = async () => {
    if (command === 'status') {
      console.log(JSON.stringify(redirectorStatus(), null, 2))
      return
    }
    if (command === 'sync' || command === 'start' || command === 'profile') {
      const result = await syncRedirector(cwd, { start: command === 'start' })
      console.log(JSON.stringify(result, null, 2))
      if (result.written) console.log(`profile: ${result.written.path} (${result.written.rules} 条规则)`)
      if (result.command) console.log(`命令: ${result.command.display}`)
      return
    }
    console.error(`unknown command "${command}" (status|profile|sync|start)`)
    process.exitCode = 1
  }
  await run()
}
