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
 * engine: we map our rule table onto that file and hand it over. Two facts make
 * this usable without installing anything:
 *   - Linux: `ProxyBridge --profile ./x.pbprofile` runs from an extracted folder
 *     ("Nothing is installed"); it needs root, but no systemd unit.
 *   - Windows: `ProxyBridge_CLI.exe` next to `ProxyBridgeCore.dll`, `WinDivert.dll`
 *     and `WinDivert64.sys` is the stand-alone form; it needs an elevated start.
 *
 * Elevation is the one thing we cannot do silently: on Windows it is a UAC prompt,
 * on WSL/Linux a sudo password. So `start` reports the exact command and only
 * spawns when the caller already has the rights.
 */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { IS_WINDOWS, engineSide, pidAlive, proxyConfigPath, proxyHomeDir, readProxyConfig, readTail, ruleEffectiveness } from './proxy.js'

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
 * @param {{platform?: string, wsl?: boolean, side?: 'local'|'windows'}} [options] - overrides for tests.
 * @returns absolute candidate paths, most specific first.
 */
export function redirectorCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const side = options.side ?? 'local'
  const wsl = options.wsl ?? (platform === 'linux' && engineSide() === 'wsl')
  const override = process.env.DSH_RIS_IDE_PROXYBRIDGE
  const list = []
  if (typeof override === 'string' && override !== '') list.push(override)
  if (platform === 'win32') {
    list.push('C:\\Program Files\\ProxyBridge\\ProxyBridge_CLI.exe')
    return list
  }
  if (side === 'windows') {
    // The Windows host's install, reached through /mnt. Offsets are the common ones.
    for (const drive of ['d', 'c']) list.push(`/mnt/${drive}/Program Files/ProxyBridge/ProxyBridge_CLI.exe`)
    return list
  }
  // Local side: the vendored copy first (works on any distro without a system
  // install), then whatever a package manager put on PATH.
  list.push(join(redirectorVendorDir({ platform }), 'ProxyBridge'))
  list.push('/usr/local/bin/ProxyBridge')
  list.push('/usr/bin/ProxyBridge')
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
$specFile = ${quote(paths.cliSpec ?? '')}
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
      Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Milliseconds 400
      Start-Process -FilePath $spec.exe -ArgumentList @($spec.args) -WindowStyle Hidden -RedirectStandardOutput $spec.log -RedirectStandardError ($spec.log + '.err') | Out-Null
      Start-Sleep -Milliseconds 1500
      # Liveness alone is not enough: the host's old CLI may still be dying, and
      # ProxyBridge.exe is a different process. Match the profile on the command line.
      $profileArg = [string]$spec.args[1]
      $cim = @(Get-CimInstance Win32_Process -Filter "Name='ProxyBridge_CLI.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID })
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
Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue | Stop-Process -Force
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
  const script = windowsWatchdogScript({
    heartbeat: windowsPathOf(heartbeatPath()),
    // The canonical writer path: the watchdog's teardown reads exactly this file.
    stateFile: windowsPathOf(serviceStatePath()),
    logFile: windowsPathOf(windowsLogLocalPath()),
    stopRequest: windowsPathOf(stopRequestPath()),
    stoppedMarker: windowsPathOf(stoppedMarkerPath()),
    cliSpec: windowsPathOf(join(proxyHomeDir(), CLI_SPEC_FILENAME)),
    reloadRequest: windowsPathOf(reloadRequestPath()),
    reloadDone: windowsPathOf(reloadDonePath()),
    reloadFailed: windowsPathOf(reloadFailedPath()),
  })
  mkdirSync(proxyHomeDir(), { recursive: true, mode: 0o700 })
  writeFileSync(watchdogScriptPath(), script, { mode: 0o600 })
  return windowsPathOf(watchdogScriptPath())
}

export async function startRedirector(options = {}) {
  const side = options.side === 'windows' ? 'windows' : 'local'
  // Resolve the binary BEFORE writing the profile: without a CLI the profile is
  // useless, and "no ProxyBridge" is a much better answer than "no rules".
  const found = findRedirector({ side })
  if (found.found !== true) {
    return { started: false, side, command: '', reason: side === 'windows' ? '未找到 Windows 版 ProxyBridge_CLI.exe' : '未找到本侧 ProxyBridge' }
  }
  const profile = writeRedirectorProfile(readProxyConfig(''), { path: options.profilePath })
  const plan = redirectorCommand({ cliPath: found.path, profilePath: profile.path, verbose: options.verbose, platform: side === 'windows' ? 'win32' : 'linux' })
  const running = detectRunningRedirector()
  // Per side: the other side's process must not make this start look redundant.
  const sameSide = IS_WINDOWS === true ? running.windows : side === 'windows' ? running.windows : running.local
  if (sameSide.pid > 0) {
    if (side !== 'windows' || IS_WINDOWS === true) return { started: false, side, pid: sameSide.pid, command: plan.display, reason: '已在运行（先停止）' }
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
    // profile we just wrote lives in the Linux home. Both have to be translated.
    const exePath = windowsPathOf(found.path)
    const winArgs = windowsArgsOf(plan.args)
    const winLog = windowsPathOf(windowsLogPath())
    // Fresh start: no stale stop request may remain, and the heartbeat has to exist
    // BEFORE the watchdog looks at it (a missing file counts as stale).
    clearStopSignals()
    clearReloadSignals()
    writeHeartbeat()
    const watchdogScript = writeWatchdogScript()
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
    // One elevated helper does the whole dance: the GUI's service and the CLI both
    // want the WinDivert handle (mutually exclusive), a stale CLI has to go, and only
    // an already-elevated process may redirect the CLI's output (-Verb RunAs cannot
    // redirect). So: stop service → kill stale CLI → start CLI with logs → report.
    const script = [
      '$svcWas = $false',
      '$svc = Get-Service ProxyBridgeSvc -ErrorAction SilentlyContinue',
      '$startType = $null',
      "if ($svc -ne $null) { $startType = $svc.StartType.ToString() }",
      "if ($svc -ne $null -and $svc.Status -eq 'Running') { Stop-Service ProxyBridgeSvc -Force -ErrorAction SilentlyContinue; $svcWas = $true; Start-Sleep -Milliseconds 900 }",
      // Only one process may own the WinDivert handle: if the service survived the
      // stop it will keep intercepting while our CLI silently captures nothing.
      "if ($svc -ne $null -and (Get-Service ProxyBridgeSvc -ErrorAction SilentlyContinue).Status -eq 'Running') { 'svcRunning=True;done=1'; return }",
      // An Automatic service comes back minutes later and silently steals the
      // WinDivert handle: our CLI then runs without capturing anything (rules load,
      // no [CONN] lines) while every connection fails. Park it on Manual instead.
      "if ($svc -ne $null -and $startType -eq 'Automatic') { Set-Service ProxyBridgeSvc -StartupType Manual -ErrorAction SilentlyContinue; $parked = $true }",
      'Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
      'Start-Sleep -Milliseconds 500',
      `$log = ${quote(winLog)}`,
      'if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }',
      `$argList = @(${winArgs.map(quote).join(',')})`,
      `$p = Start-Process -FilePath ${quote(exePath)} -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')`,
      'Start-Sleep -Milliseconds 2000',
      '$alive = [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue)',
      // Two CLIs would both try to bind WinDivert: keep ours, drop anything else
      // (a leftover from an earlier session, or one the IDE started meanwhile).
      '$all = @(Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue)',
      '$dups = $all.Count - 1',
      'if ($dups -gt 0) { $all | Where-Object { $_.Id -ne $p.Id } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }',
      '$final = @(Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue).Count',
      // Killing an elevated CLI and restarting the service need admin, which we only
      // have inside this script: spawn the watchdog here so teardown never asks for
      // a second UAC (it ends on a stop request or when the heartbeat goes stale).
      `$wd = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', ${quote(watchdogScript)}) -PassThru -WindowStyle Hidden`,
      'Start-Sleep -Milliseconds 400',
      '"pid=$($p.Id);svc=$svcWas;startType=$startType;parked=$([bool]$parked);alive=$alive;dups=$dups;count=$final;watchdog=$($wd.Id);done=1"',
    ].join('; ')
    const elevated = await psElevated(script, 45000)
    // B1: no report for THIS run means the start did not happen — never parse the
    // previous run's leftover output (it looked like success with a dead pid).
    if (elevated.ok !== true) {
      return { started: false, side, command: plan.display, reason: elevated.reason }
    }
    const output = elevated.output
    if (/svcRunning=True/.test(output)) {
      return {
        started: false,
        side,
        command: plan.display,
        reason: 'ProxyBridgeSvc 服务停不下来，它会和 CLI 抢 WinDivert 句柄（表现为拦截器在跑但一条 [CONN] 都没有）——用管理员结束该服务后重试',
      }
    }
    const pid = Number.parseInt((output.match(/pid=(\d+)/) ?? [])[1] ?? '', 10)
    if (Number.isInteger(pid) === false || pid <= 0) {
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
      const log = `${readTail(windowsLogLocalPath(), 4096)}\n${readTail(`${windowsLogLocalPath()}.err`, 2048)}`.trim()
      return {
        started: false,
        side,
        pid,
        command: plan.display,
        reason: `启动后退出（${log.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ').slice(0, 240) || '日志为空'}）`,
      }
    }
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
    writeRedirectorPid(child.pid, 'local')
    return { started: true, pid: child.pid, side, command: plan.display }
  }
  return { started: false, side, command: plan.display, reason: '需要 root：请执行上面的命令（或给 sudo 配置免密）' }
}

/** Where the vendored distribution for a platform lives (machine-wide, shared). */
export function redirectorVendorDir(options = {}) {
  const platform = options.platform ?? process.platform
  return join(redirectorHome(), 'vendor', platform === 'win32' ? 'windows' : 'linux')
}

/**
 * Find a usable CLI for one side.
 *
 * `side` names the network stack that gets hooked, not the platform this process
 * runs on: inside WSL both sides exist and neither replaces the other.
 * @param {{side?: 'local'|'windows', platform?: string, wsl?: boolean}} [options] - overrides for tests.
 * @returns {{found: boolean, path: string, kind: string, candidates: string[]}} the first hit.
 */
export function findRedirector(options = {}) {
  const platform = options.platform ?? process.platform
  const side = options.side === 'windows' ? 'windows' : 'local'
  const candidates = redirectorCandidates({ platform, side, wsl: options.wsl })
  for (const path of candidates) {
    if (existsSync(path) !== true) continue
    const kind = /\.exe$/i.test(path) === true ? 'windows-cli' : 'linux-cli'
    return { found: true, path, kind, candidates }
  }
  return { found: false, path: candidates[0] ?? '', kind: '', candidates }
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
  writeFileSync(path, JSON.stringify(profile, null, 2), { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Filesystems without POSIX modes (a Windows share) simply keep their default.
  }
  return { path, rules: rules.length, skipped }
}

/**
 * End every Windows CLI, tracked or not.
 *
 * A hand-started CLI (or one whose pid file we lost) still owns the hook, and
 * ProxyBridge refuses to run twice — so "already running" means "get it out of the
 * way", not "give up".
 * @returns {Promise<{ok: boolean, killed?: number, reason?: string}>} outcome.
 */
export async function killWindowsCliProcesses() {
  const script = [
    "$ErrorActionPreference = 'Continue'",
    '$found = @(Get-Process ProxyBridge_CLI -ErrorAction SilentlyContinue)',
    'if ($found.Count -eq 0) { "none"; return }',
    '$found | Stop-Process -Force -ErrorAction SilentlyContinue',
    'Start-Sleep -Milliseconds 800',
    '"killed=" + $found.Count',
  ].join('; ')
  const elevated = await psElevated(script, 20000)
  if (elevated.ok !== true) return { ok: false, reason: elevated.reason }
  const output = elevated.output
  const killed = /killed=(\d+)/.exec(output)
  if (killed !== null) return { ok: true, killed: Number.parseInt(killed[1], 10) }
  if (/none/.test(output)) return { ok: true, killed: 0 }
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
 * @param {{cliPath: string, profilePath: string, verbose?: number, platform?: string}} options - inputs.
 * @returns {{command: string, args: string[], display: string, needsElevation: boolean}} runnable plan.
 */
export function redirectorCommand(options = {}) {
  const platform = options.platform ?? process.platform
  // 2 = per-connection lines (`[CONN] java.exe (PID) -> host:port via Proxy …`).
  // Level 1 only prints the rules, which makes a working interception and a dead
  // one look the same — the exact ambiguity that cost us an hour of guessing.
  const verbose = Number.isInteger(options.verbose) ? options.verbose : 2
  const args = ['--profile', String(options.profilePath ?? ''), '--verbose', String(verbose)]
  const translate = platform === 'win32' && engineSide() === 'wsl'
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
  const stopped = results.filter((result) => result.stopped === true)
  if (stopped.length > 0) {
    const first = stopped[0]
    return { stopped: true, pid: first.pid, side: first.side, service: first.service, byWatchdog: first.byWatchdog, results }
  }
  // Nothing was even detected: keep the historical terse answer (the UI shows it).
  if (results.every((result) => result.pid === undefined)) return { stopped: false, reason: '未在运行' }
  return { stopped: false, reason: results.map((result) => result.reason).filter(Boolean)[0] ?? '未发现运行中的桥接', results }
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
    return { stopped: true, pid: target.pid, source: target.source, service, byWatchdog }
  }
  const hint = target.source === 'pidfile' ? '' : '（检测到进程但不在记录中，可能需要管理员权限）'
  return { stopped: false, pid: target.pid, source: target.source, reason: `无法停止 Windows 进程 ${target.pid}${hint}（${output.trim().slice(0, 120) || '没有输出'}）` }
}

function stopLocalSideSync(target, options) {
  try { process.kill(target.pid, 'SIGTERM') } catch (error) {
    if (error?.code === 'EPERM') return { stopped: false, pid: target.pid, side: 'local', reason: `需要 sudo kill ${target.pid}` }
  }
  // Block the exit hook briefly: SIGTERM on the engine is quick, and leaving a
  // root process behind after dsh quits is worse than a short delay.
  const limit = Date.now() + (Number.isInteger(options.graceMs) && options.graceMs > 0 ? options.graceMs : 3000)
  while (Date.now() < limit && pidAlive(target.pid)) sleepSync(120)
  if (pidAlive(target.pid)) return { stopped: false, pid: target.pid, side: 'local', reason: `进程 ${target.pid} 仍在运行（需要 sudo kill ${target.pid}）` }
  clearRedirectorPid('local')
  return { stopped: true, pid: target.pid, source: target.source, side: 'local' }
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
  if (IS_WINDOWS) return 0
  if (typeof probeHooks.localProc === 'function') return Number.parseInt(probeHooks.localProc() ?? 0, 10) || 0
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
        const isRedirector = argv.some((token) => /(^|[\\/])ProxyBridge(\.exe)?$/i.test(token))
        if (isRedirector && argv.some((token) => token === '--profile' || token.startsWith('--profile='))) {
          return Number.parseInt(entry, 10)
        }
      } catch { /* vanished */ }
    }
  } catch { /* no /proc */ }
  return 0
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
  const scanned = scanLocalProcForRedirector()
  if (scanned > 0) return { pid: scanned, side, source: 'proc' }
  return null
}

/** Async variant of {@link detectRunningRedirector}: safe to call from HTTP routes. */
export async function detectRunningRedirectorAsync() {
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
  const localHit = local ?? (scanLocalProcForRedirector() > 0 ? { pid: scanLocalProcForRedirector(), side: 'local', source: 'proc' } : null)
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
    spawnSyncText('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', launchEncoded], launchTimeout)
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
    return { available: found.found, path: found.path, kind: found.kind, version }
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
    return { written, command: '', started: false, reason: '未找到 ProxyBridge CLI（可用 DSH_RIS_IDE_PROXYBRIDGE 指定，或把发行版解压到 vendor 目录）' }
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
 * @param {{sides?: string[], verbose?: number}} [options] - sides to consider, in order.
 * @returns {Promise<{started: object[], skipped: object[], running: boolean}>} per-side outcome.
 */
export async function startRedirectors(options = {}) {
  // Never pop an elevation prompt from a test run: node --test marks its children
  // with NODE_TEST_CONTEXT, and a UAC dialog would block the suite on a desktop
  // nobody is watching.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    return { started: [], skipped: [{ side: '', reason: '测试环境不启动系统层拦截' }], running: false }
  }
  const sides = Array.isArray(options.sides) && options.sides.length > 0 ? options.sides : ['windows', 'local']
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
      skipped.push({ side, reason: `未找到 ${side === 'windows' ? 'Windows' : '本侧'} ProxyBridge` })
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
    const result = await startRedirector({ side, verbose: options.verbose })
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
  const sides = Array.isArray(options.sides) && options.sides.length > 0 ? options.sides : ['windows', 'local']
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
  const detection = detectRunningRedirector()
  if (detection.pid === 0) {
    // Drop dead records so status stops advertising a pid that does not exist.
    for (const side of ['windows', 'local']) {
      if (redirectorPidRecord(side).pid > 0) clearRedirectorPid(side)
    }
    return { stopped: false, reason: '未在运行' }
  }
  const results = []
  if (detection.windows.pid > 0) {
    results.push(Object.assign({ side: 'windows' }, stopRedirectorSync(Object.assign({}, options, { side: 'windows' }))))
  }
  if (detection.local.pid > 0) {
    results.push(Object.assign({ side: 'local' }, await stopLocalRedirectorAsync(detection.local.pid, options)))
  }
  const stopped = results.filter((result) => result.stopped === true)
  if (stopped.length === 0) {
    return {
      stopped: false,
      pid: detection.pid,
      reason: results.map((result) => result.reason).filter(Boolean)[0] ?? '未能停止桥接',
      results,
    }
  }
  return { stopped: true, pid: stopped[0].pid, side: stopped[0].side, results }
}

/** Graceful local stop with SIGKILL fallback (the exit hook used to do this inline). */
async function stopLocalRedirectorAsync(pid, options = {}) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    const code = error?.code ?? ''
    return {
      stopped: false,
      pid,
      reason: code === 'EPERM' ? `需要管理员/sudo：sudo kill ${pid}` : `无法停止进程 ${pid}（${code || error?.message}）`,
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
  if (pidAlive(pid)) return { stopped: false, pid, reason: `进程 ${pid} 仍在运行（需要 sudo kill ${pid}）` }
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
 * @param {string} path - an absolute Linux path, possibly under /mnt/<drive>.
 * @returns {string} the same location as Windows sees it.
 */
export function windowsPathOf(path) {
  const text = String(path ?? '')
  if (text === '') return text
  if (/^[A-Za-z]:[\\/]/.test(text)) return text
  // /mnt/<letter>/ IS drive <letter> by definition, and doing it first keeps the
  // answer right even for a path that does not exist yet (`wslpath` would then
  // answer with a \\wsl.localhost\… share that Windows cannot open).
  const mounted = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(text)
  if (mounted !== null) return `${mounted[1].toUpperCase()}:\\${mounted[2].replace(/\//g, '\\')}`
  const converted = spawnSyncText('wslpath', ['-w', text], 4000).trim()
  if (converted !== '' && /^[A-Za-z]:[\\/]|^\\\\/.test(converted)) return converted
  return text
}

/** @param {object[]} args - argv as this side spells it. @returns {object[]} Windows-spelled argv. */
function windowsArgsOf(args) {
  return args.map((arg) => (typeof arg === 'string' && arg.startsWith('/') ? windowsPathOf(arg) : arg))
}

function spawnSyncText(command, args, timeoutMs) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export const __test = {
  PROFILE_VERSION,
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
  writeWatchdogPid,
  reloadDonePath,
  reloadFailedPath,
  windowsPathOf,
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
