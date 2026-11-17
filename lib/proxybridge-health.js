/**
 * Health check for the downloaded ProxyBridge component (m11828).
 *
 * The maintenance page can say "已安装 · 文件 8 个", but that only proves the files
 * were written once. A component that matters is one that can still RUN: the binary
 * may be missing a sibling DLL, an anti-virus may quarantine it, or the cached
 * `.exe` may be an architecture mismatch. So this module asks both side's CLI for
 * its version — the cheapest proof that the executable loads — and reports file
 * completeness next to it.
 *
 * Deliberately separated from `lib/redirector.js`: that module owns the running
 * bridge; this one answers "is the component itself healthy" without starting,
 * elevating or killing anything. It never blocks the HTTP loop (`execFile`).
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { bundleLayout, installDir } from './proxybridge-bundle.js'

const execFileAsync = promisify(execFile)

/** Health results are cheap to compute but spawn processes: cache them. */
export const HEALTH_TTL_MS = 30000

/** Files each side's CLI needs before it can start (the licences are not required). */
export const SIDE_FILES = Object.freeze({
  linux: Object.freeze(['linux/ProxyBridge', 'linux/libproxybridge.so']),
  windows: Object.freeze([
    'windows/ProxyBridge_CLI.exe',
    'windows/ProxyBridgeCore.dll',
    'windows/WinDivert.dll',
    'windows/WinDivert64.sys',
  ]),
})

/** Run a command and return its output; never throws (a broken CLI is a diagnosis). */
async function runCommand(command, args, timeoutMs) {
  try {
    const result = await execFileAsync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  } catch (error) {
    return `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`
  }
}

function fileState(bundleDir, relative) {
  const path = join(bundleDir, relative)
  try {
    const stat = statSync(path)
    return { path: `bundle/${relative}`, ok: stat.isFile() && stat.size > 0, size: stat.size }
  } catch {
    return { path: `bundle/${relative}`, ok: false, size: 0 }
  }
}

function parseVersion(output) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(output ?? ''))
  return match === null ? '' : match[1]
}

/**
 * Check one side of the component.
 *
 * @param {{bundleDir: string, side: 'linux'|'windows', run?: Function}} options - which side.
 * @returns {Promise<{side: string, ok: boolean, files: object, version: string, error?: string, checks: object[]}>}
 */
async function checkSide({ bundleDir, side, run, windowsExe = '', applicable = true, skippedNote = '' }) {
  const files = SIDE_FILES[side].map((relative) => fileState(bundleDir, relative))
  const missing = files.filter((file) => file.ok !== true).map((file) => file.path)
  if (applicable !== true) {
    // Single-sided hosts are normal, not broken: a native Linux box has no Windows
    // bridge, a native Windows box has no Linux bridge. Skipping keeps the card green
    // (m12019).
    return {
      side,
      applicable: false,
      skipped: true,
      ok: true,
      files: { ok: missing.length === 0, expected: files.length, missing, entries: files },
      version: '',
      note: skippedNote === '' ? '本机无此侧' : skippedNote,
      checks: [],
    }
  }
  const bundleExe = join(bundleDir, side === 'windows' ? 'windows/ProxyBridge_CLI.exe' : 'linux/ProxyBridge')
  // Windows cannot launch an executable from the Linux filesystem: probe the copy
  // materialised under %LOCALAPPDATA% (the one the bridge actually runs). Without it
  // the check honestly says "not prepared yet" instead of "broken".
  const exe = side === 'windows' ? windowsExe : bundleExe
  let version = ''
  let error = ''
  if (skippedNote !== '') {
    // Files are installed but the Windows copy has not been materialised yet: that
    // happens before the first bridge start, so it is "not prepared", not "broken".
    return {
      side,
      applicable: true,
      skipped: true,
      ok: true,
      files: { ok: missing.length === 0, expected: files.length, missing, entries: files },
      version: '',
      note: skippedNote,
      checks: [{ id: 'files', label: '文件完整', ok: missing.length === 0, detail: `${files.length - missing.length}/${files.length}` }],
    }
  }
  if (side === 'windows' && exe === '') {
    error = '尚未复制到 Windows 侧（首次启动拦截时准备）'
  } else if (existsSync(side === 'windows' ? bundleExe : exe) === true || side === 'windows') {
    const output = side === 'windows'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${exe}' --version`], 8000)
      : await run(exe, ['--version'], 6000)
    version = parseVersion(output)
    if (version === '') error = String(output).trim().split(/\r?\n/).filter((line) => line !== '').slice(-1)[0]?.slice(0, 160) ?? ''
  } else {
    error = '可执行文件不存在'
  }
  const checks = [
    { id: 'files', label: '文件完整', ok: missing.length === 0, detail: missing.length === 0 ? `${files.length}/${files.length}` : `缺 ${missing.join('、')}` },
    { id: 'runs', label: '可启动', ok: version !== '', detail: version === '' ? (error === '' ? '版本探测无输出' : error) : `v${version}` },
  ]
  return {
    side,
    applicable: true,
    skipped: false,
    ok: checks.every((check) => check.ok === true),
    files: { ok: missing.length === 0, expected: files.length, missing, entries: files },
    version,
    ...(error === '' ? {} : { error }),
    checks,
  }
}

/**
 * Full component health for both sides.
 *
 * `engineRunning` is reported, not judged: the component can be perfectly healthy
 * while interception is off (the card shows「拦截：未启动」). The maintenance page
 * only *asks* for this check while the proxy engine is running (m11838), because a
 * stopped engine means the component is not in use at all.
 *
 * @param {{home: string, engineRunning?: boolean, run?: Function, timeoutMs?: number}} options - home + dependency seam.
 * @returns {Promise<{at: string, engineRunning: boolean, ok: boolean, sides: object}>} health snapshot.
 */
export async function collectProxyBridgeHealth(options = {}) {
  const home = String(options.home ?? '')
  const bundleDir = installDir(home)
  const run = typeof options.run === 'function' ? options.run : runCommand
  const expected = bundleLayout().length
  const installed = existsSync(join(bundleDir, 'linux/ProxyBridge')) === true || existsSync(join(bundleDir, 'windows/ProxyBridge_CLI.exe')) === true
  const windowsExe = typeof options.windowsExe === 'string' ? options.windowsExe : ''
  // Applicability (m12019): a single-sided host must not report a red card. Linux is
  // always a candidate; Windows only when the bridge can be materialised there
  // (WSL with %LOCALAPPDATA% / native Windows).
  const linuxApplicable = options.linuxApplicable !== undefined ? options.linuxApplicable === true : process.platform !== 'win32'
  const windowsApplicable = options.windowsApplicable !== undefined ? options.windowsApplicable === true : windowsExe !== ''
  const windowsPrepared = options.windowsPrepared !== false
  const [linux, windows] = await Promise.all([
    checkSide({ bundleDir, side: 'linux', run, applicable: linuxApplicable, skippedNote: linuxApplicable ? '' : '本机是 Windows，没有 Linux 侧' }),
    checkSide({
      bundleDir,
      side: 'windows',
      run,
      windowsExe,
      applicable: windowsApplicable,
      skippedNote: windowsApplicable === true && windowsPrepared !== true ? '尚未复制到 Windows 侧（首次启动拦截时准备）' : (windowsApplicable === true ? '' : '本机不是 WSL，没有 Windows 侧'),
    }),
  ])
  const applicable = [linux, windows].filter((side) => side.applicable === true)
  return {
    at: new Date().toISOString(),
    engineRunning: options.engineRunning === true,
    installed,
    expectedFiles: expected,
    // ok is judged only on sides this host can run; a skipped side is neutral.
    ok: applicable.every((side) => side.ok === true),
    sides: { linux, windows },
  }
}

/**
 * Cached wrapper: version probes cost a process spawn per side.
 *
 * `force:true` (the card's「重新检查」) must always re-probe; everything else can
 * reuse a result younger than {@link HEALTH_TTL_MS}.
 */
export function createHealthCache() {
  let cached = { at: 0, key: '', value: null }
  return {
    async get({ home, engineRunning, force = false, run, windowsExe, windowsApplicable, windowsPrepared, linuxApplicable } = {}) {
      const now = Date.now()
      // The applicability inputs decide WHAT is probed (native Windows vs WSL vs
      // Linux), so they belong in the key: a cached "both skipped" result must not
      // be served to a host that now has a side to check (review A4-P1-1).
      const key = [engineRunning === true, windowsApplicable, windowsPrepared, linuxApplicable, windowsExe].join('|')
      if (force !== true && cached.value !== null && now - cached.at < HEALTH_TTL_MS && cached.key === key) {
        return { ...cached.value, cached: true }
      }
      const value = await collectProxyBridgeHealth({ home, engineRunning, run, windowsExe, windowsApplicable, windowsPrepared, linuxApplicable })
      cached = { at: now, key, value }
      return { ...value, cached: false }
    },
  }
}
