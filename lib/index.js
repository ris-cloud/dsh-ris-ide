/**
 * dsh-ris-ide — Host half.
 *
 * Two routes, used by this plugin's browser half:
 *
 *   GET  /dsh-ris-ide/tail?sessionId=<id>&path=<path>[&cwd=<abs>][&bytes=<n>]
 *     -> 200 { ok: true, content, size, elided, mtimeMs, mode: "tail",
 *              service?: { pid, wrapperPid, startedAt, alive } }
 *     -> 4xx/5xx { ok: false, code, message }
 *
 *   POST /dsh-ris-ide/stop   body { sessionId, path, cwd? }
 *     -> 200 { ok: true, stopped, alreadyStopped, forced, waitedMs, pid, wrapperPid }
 *     -> 4xx/5xx { ok: false, code, message }
 *
 * WHY THE TAIL ROUTE EXISTS. The sidebar plugin's own `/sidebar/api/fs.read`
 * reads the file HEAD: `readText(path, readLimit)` allocates
 * `min(size, readLimit)` bytes and reads from position 0, with
 * `truncated = size > readLimit` and a 512 KiB default limit. That is the wrong
 * end of a log file once the file grows past the limit — the newest lines (the
 * whole point of a tail) are exactly what it drops. This route reads the LAST
 * `bytes` bytes instead, drops the partial first line when it elided content,
 * and repairs a UTF-8 sequence split by the cut. The same read reports whether
 * a service is still running (see the stop route) so the viewer can offer a
 * stop button only when there is something to stop.
 *
 * Deliberately narrow, because it serves file bytes to a browser fetch:
 * - loopback only: the Host authority must be `localhost` / `127.0.0.0/8` /
 *   `[::1]`, and an attached Origin, when present, must name that same
 *   authority (no CORS headers are sent, so cross-origin pages get nothing);
 * - GET only, no request body, no write path anywhere in this file;
 * - at most ~512 KiB per request, hard-capped in code and overridable only
 *   downwards by config.
 *
 * Path rule: the SAME rule the sidebar's own read applies. Its
 * `ensureWorkspacePath` is `resolveTarget` — relative paths join the session
 * cwd, absolute paths stay absolute, and there is no containment fence (the
 * historical `_fence` argument is ignored). Matching that here matters: a
 * stricter rule would silently degrade the viewer to head mode for any log
 * that lives outside the session cwd even though the editor can preview it.
 * `config.restrictToCwd: true` opts into the stricter rule for deployments
 * that want it.
 *
 * The browser half falls back to `/sidebar/api/fs.read` (head mode) when this
 * route answers anything but 200, so a deployment that refuses it degrades to
 * a 512 KiB head view instead of breaking.
 *
 * The browser half falls back to `/sidebar/api/fs.read` (head mode) when this
 * route answers anything but 200, so a deployment that refuses it degrades to
 * a 512 KiB head view instead of breaking.
 *
 * @module dsh-ris-ide
 */
import { appendFile, copyFile, cp, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import {
  createDebugSessions, DebugError, debugErrorStatus, jdwpAgentArg, allocateDebugPort, waitForTcp,
  waitForJdwpListening, toJsonSafe,
} from './debug/engine.js'

export const name = 'dsh-ris-ide'
/**
 * Windows runs the PowerShell wrapper (`bin/run-with-log.ps1`) instead of the
 * bash one: no bash required, process verification goes through CIM and a stop
 * is `taskkill /T` (kill the tree) because Windows has no POSIX signals/groups.
 */
export const IS_WINDOWS = process.platform === 'win32'

/** Where a Git Bash install may live (System32\bash.exe is the WSL launcher, skipped). */
function gitBashCandidates() {
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => resolve(dir, 'bash.exe'))
  return [
    process.env.DSH_RIS_DEV_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ...fromPath,
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
}

/**
 * Pick the first real Git Bash from a candidate list.
 *
 * WSL's `bash.exe` (in System32) is deliberately skipped: it runs inside the WSL
 * pid/path namespace, so the pidfile records a pid the Windows host cannot verify
 * or kill. WSL services can still be started through a custom `startCommand`.
 * @param candidates - absolute paths to test.
 * @returns the bash path, or `undefined`.
 */
export function pickGitBash(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const lower = candidate.toLowerCase()
    if (lower.includes('system32')) continue
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Detect a usable Git Bash on this Windows machine (see {@link pickGitBash}). */
export function detectGitBash() {
  if (!IS_WINDOWS) return undefined
  return pickGitBash(gitBashCandidates())
}

/**
 * Choose how a Windows start is wrapped: `auto` prefers Git Bash when it is
 * installed (the Linux-identical wrapper, graceful stop), otherwise the native
 * PowerShell wrapper.
 * @param runtime - configured `'auto' | 'bash' | 'powershell'`.
 * @param bashPath - optional explicit bash path.
 * @returns `{ runtime: 'bash', bashPath }` or `{ runtime: 'powershell' }`.
 * @throws {TailError} when `bash` is requested but Git Bash is not installed.
 */
export function resolveWindowsRuntime(runtime, bashPath) {
  const requested = runtime === 'bash' || runtime === 'powershell' ? runtime : 'auto'
  if (requested === 'powershell') return { runtime: 'powershell' }
  const found = bashPath !== undefined ? pickGitBash([bashPath]) : detectGitBash()
  if (requested === 'bash') {
    if (found === undefined) {
      throw new TailError('no-bash', '没有找到 Git Bash（WSL 的 bash.exe 不支持）；装 Git Bash 或把 runtime 设成 "powershell"', 400)
    }
    return { runtime: 'bash', bashPath: found }
  }
  return found === undefined ? { runtime: 'powershell' } : { runtime: 'bash', bashPath: found }
}
/** The Host services this plugin needs: the HTTP route registry and session cwd lookup. */
export const inject = ['webServer', 'sessions', 'tools']

/** Route prefix; the browser resolves `<prefix>/tail` (and POST `<prefix>/stop`) against the page base. */
const ROUTE_PREFIX = '/dsh-ris-ide'
const TAIL_PATH = `${ROUTE_PREFIX}/tail`
const STOP_PATH = `${ROUTE_PREFIX}/stop`
const INSTANCES_PATH = `${ROUTE_PREFIX}/instances`
const PROGRAMS_PATH = `${ROUTE_PREFIX}/programs`
/**
 * Server-sent events for what the panel otherwise polls: `programs` (the console
 * rows) and `tail` (one log file, pushed as it grows). One long-lived response per
 * panel instead of a JSON request every 1–3 s.
 */
const STREAM_PATH = `${ROUTE_PREFIX}/stream`
/**
 * Our OWN workspace file API. The IDE used to read/write through
 * `dsh-better-sidebar`'s `/sidebar/api` + `/sidebar/write` + `/sidebar/file`;
 * these three routes replace that so the plugin no longer needs that plugin.
 */
const BUNDLE_PATH = `${ROUTE_PREFIX}/bundle`
/** File-tree mutations (the tree's context menu, keyboard shortcuts, drag&drop). */
const FS_MKDIR_PATH = `${ROUTE_PREFIX}/fs/mkdir`
const FS_CREATE_PATH = `${ROUTE_PREFIX}/fs/create`
const FS_COPY_PATH = `${ROUTE_PREFIX}/fs/copy`
const FS_MOVE_PATH = `${ROUTE_PREFIX}/fs/move`
const FS_REMOVE_PATH = `${ROUTE_PREFIX}/fs/remove`
/** Import from OUTSIDE the workspace (a file copied in the OS file manager). */
const FS_IMPORT_PATH = `${ROUTE_PREFIX}/fs/import`
/** Raw-bytes upload (a pasted/dropped File has no JSON-safe encoding). */
const FS_UPLOAD_PATH = `${ROUTE_PREFIX}/fs/upload`
/** Upload cap: generous for screenshots/zips, small enough to stream, not buffer. */
const FS_UPLOAD_MAX_BYTES = 128 * 1024 * 1024
/**
 * Lazily-built client chunks (see `tsdown.config.mjs`). Only these names are
 * served; the file is read from beside this module on every request so a rebuilt
 * chunk is picked up by a page refresh alone.
 */
const CLIENT_CHUNKS = { codemirror: 'client-codemirror.js' }
/**
 * The standalone IDE window: one self-contained page that deliberately does NOT
 * boot the DSH frontend — no session, no conversation, no other plugin bundle —
 * so a window left open all day does not grow with the session history. It loads
 * this plugin's OWN browser half (`client.js`) plus a vendored React, and talks
 * to the very same `/dsh-ris-ide/*` routes (same origin, same cookie, one SSE).
 */
const WINDOW_PAGE_PATH = `${ROUTE_PREFIX}/window`
const WINDOW_APP_PATH = `${ROUTE_PREFIX}/window/app.js`
const WINDOW_VENDOR_PREFIX = `${ROUTE_PREFIX}/window/vendor/`
/** Only these two files are served under the vendor prefix (nothing else on disk). */
const WINDOW_VENDOR_FILES = {
  'react.js': 'standalone/vendor/react.js',
  'react-dom.js': 'standalone/vendor/react-dom.js',
}
const FS_READ_PATH = `${ROUTE_PREFIX}/fs/read`
const FS_WRITE_PATH = `${ROUTE_PREFIX}/fs/write`
const FS_FILE_PATH = `${ROUTE_PREFIX}/fs/file`
/** Windowed read of a large text file (read-only preview, one page at a time). */
const FS_WINDOW_PATH = `${ROUTE_PREFIX}/fs/window`
/** Bytes returned by one window (the client asks again with `offset=next`). */
export const FS_WINDOW_BYTES = 256 * 1024
/** Hard cap for a single window request. */
export const FS_WINDOW_MAX_BYTES = 1024 * 1024
const START_PATH = `${ROUTE_PREFIX}/start`
const CONFIG_PATH = `${ROUTE_PREFIX}/config`
/** Pending "open this log in the sidebar" requests for the browser half. */
const OPENS_PATH = `${ROUTE_PREFIX}/opens`
/** Workspace filename search that honours every git repo's .gitignore. */
const SEARCH_PATH = `${ROUTE_PREFIX}/search`
/**
 * Workspace CONTENT search: `git grep` inside every repo root under the cwd, with
 * a plain filesystem walk when there is no git (or git is not installed).
 */
const CONTENT_SEARCH_PATH = `${ROUTE_PREFIX}/search-content`
/**
 * Run ONE Maven test (`-Dtest=<name>`) in one module and keep its console in
 * memory, so the IDE can start it and poll without a fake terminal.
 */
const RUN_TEST_PATH = `${ROUTE_PREFIX}/run-test`
/** One directory level for the IDE tree: gitignore-filtered + compact chains folded. */
const TREE_PATH = `${ROUTE_PREFIX}/tree`
/** Deleted entries park here so the tree's Ctrl+Z can bring them back. */
export const TREE_TRASH_DIR = '.dsh-ris-ide-trash'
/** Path segments whose churn is never interesting to the file tree. */
const TREE_WATCH_IGNORED = new Set([
  'node_modules', 'target', 'build', 'dist', 'out', 'coverage', '.git',
  'logs', '.dsh', '.dsh-ris-ide-trash', '.gradle', '.idea', '.mvn', '.dsh-ris-ide-cache',
])

/**
 * Whether a watched relative path belongs to a churn-only directory
 * (`node_modules/…`, `target/…`, `logs/…`). Such events are dropped before the
 * frame is sent: a running service writing its log must not re-render the tree.
 * @param {string} relativePath - the watcher's filename, `/`-separated.
 * @returns {boolean} true when the path should be ignored.
 */
export function shouldIgnoreTreePath(relativePath) {
  const parts = String(relativePath === undefined || relativePath === null ? '' : relativePath).split('/')
  return parts.some((part) => TREE_WATCH_IGNORED.has(part))
}
/** Debug routes: `/debug/<action>` (start/stop/status/poll/breakpoints/threads/stack/variables/step/resume/pause). */
const DEBUG_PATH = `${ROUTE_PREFIX}/debug`
/** Every live JDWP session (the IDE auto-switches to whichever one suspends). */
const DEBUGS_PATH = `${ROUTE_PREFIX}/debugs`
/** Pulls a dependency class's source out of its jar (sources → decompiler → javap). */
const DEBUG_SOURCE_PATH = `${ROUTE_PREFIX}/debug/source`
/** Read/write the IDE-specific settings kept next to `.dsh-ris-ide.json`. */
const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`
/** Workspace cache holding extracted sources / decompiled files. */
export const IDE_CACHE_DIR = '.dsh-ris-ide-cache'
/** Where the visual settings dialog persists the decompiler jar. */
const IDE_SETTINGS_FILENAME = '.dsh-ris-ide.settings.json'
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const SOURCE_ENTRY_MAX_BYTES = 4 * 1024 * 1024
/** One JDWP session per program, shared by the routes, the tool and the workbench UI. */
const debugSessions = createDebugSessions()
/** The user-editable program config, in the session workspace root. */
const CONFIG_FILENAME = '.dsh-ris-ide.json'
/** Header written into a generated config file (JSONC: `parseJsonc` tolerates it). */
const CONFIG_HEADER = `// dsh-ris-ide 程序配置（JSONC：允许注释与尾逗号）
//
// 这份文件由「本地实例」面板的「生成配置」写出，之后由你自己维护：
//   - 改已有条目：覆盖扫描结果（id 用于匹配；改掉 id 会按 dir / name 兜底匹配）。
//   - 加新程序：复制一条，至少给 name + dir，二选一：
//       startCommand: "你在该目录下想执行的完整 shell 命令"   或
//       kind: "spring" + mainClass / kind: "frontend" + script
//   - args（应用参数，主类之后）/ jvmArgs（JVM 参数，如 ["-Xmx2g"]）/ env / logName /
//     stopGraceMs 都会作用到启动与停止；
//   - 顶层 "defaults": { "jvmArgs": [...] } 给所有程序一个默认 JVM 参数，单条 jvmArgs 覆盖它；
//   - disabled: true 隐藏这一条；删掉整条则回到扫描默认值。
// 保存后面板下一次轮询（约 3 秒）即可见。
`
/** Cap on one `instances` listing (a runaway logs dir must not become an endless list). */
const MAX_INSTANCES = 50
/** Cap on one `programs` listing (a pathological tree must not become an endless list). */
const MAX_PROGRAMS = 300
/** Directory names the program scan never descends into (build output, deps, VCS, logs). */
const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'target', 'build', 'dist', 'out', 'coverage',
  '.idea', '.vscode', '.gradle', '.mvn', 'logs', 'vendor', '.next', '.nuxt', '.turbo',
  '.worktrees', '.worktree', '.cache', '__pycache__', 'bin', 'obj',
])
/**
 * Shallow discovery depth. What this pass looks for — a Maven module dir
 * (`pom.xml`) and a frontend manifest (`package.json`) — lives at
 * `project/module` (depth 2–3), so there is no reason to walk the whole tree
 * deep: the deep part is only the Java PACKAGE path under one module, which
 * {@link scanModuleEntries} scans separately.
 */
const SHALLOW_MAX_DEPTH = 5
/** Depth cap inside one module's `src/main/java` (package nesting lives here). */
const MODULE_JAVA_MAX_DEPTH = 12
/**
 * Entry-class name heuristic, applied BEFORE reading a `.java` file: reading
 * every source file in a large reactor cost ~5 s, while Spring Boot entry points
 * are named `*Application` / `*App` / `*Main` / `*Bootstrap` in practice. The
 * annotation check still decides — this only avoids reading ~10k files.
 */
const ENTRY_JAVA_RE = /(application|app|main|bootstrap)/i
/** Files larger than this are skipped while looking for annotations / manifests. */
const SCAN_MAX_FILE_BYTES = 512 * 1024
/** How long a discovery result is reused; running state is read fresh every poll. */
const DISCOVERY_TTL_MS = 15000
/** How long a start request waits for the wrapper's pidfile before answering. */
const START_WAIT_MS = 6000
/** Default tail window when the caller does not ask for one. */
const DEFAULT_BYTES = 64 * 1024
/** Hard ceiling for one response body (also the config ceiling). */
const HARD_MAX_BYTES = 512 * 1024
/** Floor, so a malformed `bytes=0` cannot turn every poll into an empty read. */
const MIN_BYTES = 1024
/** Sibling file `run-with-log.sh` writes for the service it is running. */
const PID_SUFFIX = '.pid'
/** Default and maximum TERM→KILL grace for one stop request. */
const DEFAULT_STOP_GRACE_MS = 5000
const MAX_STOP_GRACE_MS = 60000
/** Cap on one JSON request body (the stop request carries two short strings). */
const MAX_BODY_BYTES = 64 * 1024

/** One routable failure with a machine code and an HTTP status. */
export class TailError extends Error {
  /**
   * @param code - machine-routable code (`forbidden`, `outside-workspace`, …).
   * @param message - human sentence, returned to the client verbatim.
   * @param status - HTTP status for this failure.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'TailError'
    this.code = code
    this.status = status
  }
}

/**
 * Register this plugin's two routes for its lifetime.
 *
 * `GET/prefix/tail`  — read the file tail (the viewer's poll).
 * `POST/prefix/stop` — terminate the service that `run-with-log.sh` started,
 *                      identified by the pidfile the script leaves next to the
 *                      log (`<log>.pid`, one line: `<servicePid> <wrapperPid>
 *                      <epochMs>`). One signal goes to the WRAPPER, which owns
 *                      its child: the script traps TERM, terminates the
 *                      service, escalates to KILL after a grace period, and
 *                      removes the pidfile. The route never accepts a PID from
 *                      the browser and refuses to signal a process whose
 *                      `/proc/<pid>/cmdline` is not that wrapper script.
 *
 * @param ctx - Host context carrying `webServer` (and `sessions`).
 * @param config - optional `{ maxBytes, restrictToCwd, stopGraceMs }`;
 *  `maxBytes` is clamped down to the hard ceiling, `restrictToCwd` opts into
 *  strict containment, `stopGraceMs` is the TERM→KILL grace for one stop.
 */
export function apply(ctx, config) {
  const options = {
    maxBytes: clampBytes(config?.maxBytes, HARD_MAX_BYTES, HARD_MAX_BYTES),
    restrictToCwd: config?.restrictToCwd === true,
    stopGraceMs: clampBytes(config?.stopGraceMs, DEFAULT_STOP_GRACE_MS, MAX_STOP_GRACE_MS),
    runtime: config?.runtime === 'bash' || config?.runtime === 'powershell' ? config.runtime : 'auto',
    bashPath: typeof config?.bashPath === 'string' && config.bashPath !== '' ? config.bashPath : undefined,
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      handleRequest(ctx, req, res, options)
    },
  }), 'dsh-ris-ide: tail + stop routes')
  // Model-facing commands over the same scan/start/stop core (地道的 `ris_dev_*`).
  ctx.effect(() => registerAgentTools(ctx, options), 'dsh-ris-ide: agent tools')
  // Long-running services would otherwise grow one unbounded log file forever
  // (90 MB files were already on disk): rotate the ones WE started every minute.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void rotateActiveLogs().catch(() => [])
    }, LOG_ROTATE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'dsh-ris-ide: log rotation')
}

/**
 * The one dispatcher both routes go through: method/path routing with the
 * ordinary HTTP answers (405 for the wrong method on a known path, 404 for
 * anything else) before either handler's own fence runs.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ maxBytes, restrictToCwd, stopGraceMs }` (see {@link apply}).
 */
export function handleRequest(ctx, req, res, options) {
  try {
    dispatchRequest(ctx, req, res, options)
  } catch (error) {
    // Last fence: routing/JSON writing must never let an exception reach the
    // HTTP server (an uncaught throw here is reported as a fatal load failure).
    try {
      writeTailError(res, error)
    } catch {
      if (typeof res.destroy === 'function') res.destroy()
    }
  }
}

/** The actual router behind {@link handleRequest}'s exception fence. */
function dispatchRequest(ctx, req, res, options) {
  const method = req.method ?? 'GET'
  const pathname = requestPathname(req)
  if (pathname === WINDOW_PAGE_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveWindowPage(req, res))
    return
  }
  if (pathname === WINDOW_APP_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveWindowAsset(req, res, 'client.js', 'text/javascript; charset=utf-8'))
    return
  }
  if (pathname.startsWith(WINDOW_VENDOR_PREFIX)) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveWindowVendor(req, res))
    return
  }
  if (pathname === STOP_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveStop(ctx, req, res, options))
    return
  }
  if (pathname === TAIL_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveTail(ctx, req, res, options))
    return
  }
  if (pathname === INSTANCES_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveInstances(ctx, req, res, options))
    return
  }
  if (pathname === FS_MKDIR_PATH || pathname === FS_CREATE_PATH || pathname === FS_COPY_PATH
    || pathname === FS_MOVE_PATH || pathname === FS_REMOVE_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveFsOp(ctx, req, res, options))
    return
  }
  if (pathname === FS_IMPORT_PATH || pathname === FS_UPLOAD_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveFsImport(ctx, req, res, options))
    return
  }
  if (pathname === FS_READ_PATH || pathname === FS_WRITE_PATH || pathname === FS_FILE_PATH || pathname === FS_WINDOW_PATH) {
    if (pathname !== FS_WRITE_PATH) {
      if (method !== 'GET') {
        writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
        return
      }
    } else if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveFs(ctx, req, res, options))
    return
  }
  if (pathname === BUNDLE_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveBundle(req, res))
    return
  }
  if (pathname === STREAM_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveStream(ctx, req, res, options))
    return
  }
  if (pathname === PROGRAMS_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => servePrograms(ctx, req, res, options))
    return
  }
  if (pathname === START_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveStart(ctx, req, res, options))
    return
  }
  if (pathname === RUN_TEST_PATH) {
    if (method !== 'GET' && method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET or POST only' })
      return
    }
    serveSafely(res, () => (method === 'POST' ? serveRunTestStart(ctx, req, res, options) : serveRunTestStatus(ctx, req, res, options)))
    return
  }
  if (pathname === DEBUGS_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    try {
      writeJson(res, 200, { ok: true, sessions: toJsonSafe(debugSessions.listSessions()) })
    } catch (error) {
      writeTailError(res, error)
    }
    return
  }
  if (pathname === DEBUG_SOURCE_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveDebugSource(ctx, req, res, options))
    return
  }
  if (pathname === SETTINGS_PATH) {
    serveSafely(res, () => serveSettings(ctx, req, res, options))
    return
  }
  if (pathname === DEBUG_PATH || pathname.startsWith(`${DEBUG_PATH}/`)) {
    serveSafely(res, () => serveDebug(ctx, req, res, options))
    return
  }
  if (pathname === TREE_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveTree(ctx, req, res, options))
    return
  }
  if (pathname === SEARCH_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveSearch(ctx, req, res, options))
    return
  }
  if (pathname === CONTENT_SEARCH_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveContentSearch(ctx, req, res, options))
    return
  }
  if (pathname === OPENS_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    writeJson(res, 200, { ok: true, opens: takePendingOpens() })
    return
  }
  if (pathname === CONFIG_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveConfig(ctx, req, res, options))
    return
  }
  writeJson(res, 404, { ok: false, code: 'not-found', message: `unknown route ${pathname}` })
}

/**
 * True once a `git` spawn failed with ENOENT: a bare machine may not have git,
 * and the plugin must still list/search files instead of showing an empty tree.
 */
let gitMissing = false

/** Whether a spawn/exec error means the executable itself is absent. */
function isMissingExecutable(error) {
  return error !== undefined && error !== null && (error.code === 'ENOENT' || error.errno === -2)
}

/** Run one git command and return its stdout (rejects on a non-zero exit). */
function runGit(args, cwd, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (isMissingExecutable(error)) gitMissing = true
      if (!settled) { settled = true; rejectPromise(error) }
    })
    if (input !== undefined) {
      child.stdin?.end(input)
    }
    child.on('close', (code) => {
      if (settled) return
      settled = true
      // `git check-ignore` exits 1 when nothing matched, and `git grep` exits 1
      // when the pattern has no match; both are valid answers, not failures.
      if (code === 0 || (code === 1 && (args[0] === 'check-ignore' || args[0] === 'grep'))) resolvePromise(stdout)
      else rejectPromise(new Error(stderr || `git exited with ${code}`))
    })
  })
}

/**
 * The gittish roots under a workspace: the workspace itself plus every DIRECT
 * child that carries its own `.git`. Each root's `.gitignore` (and its nested
 * ones) is authoritative for that subtree — which is what makes ris/ and
 * ris-ui-3/ searchable while the workspace root's whitelist `.gitignore` would
 * otherwise hide them entirely.
 * @param {string} cwd - workspace root.
 * @returns {Promise<string[]>} absolute roots.
 */
async function searchRoots(cwd) {
  const roots = []
  const rootIsRepo = await stat(join(cwd, '.git')).then(() => true).catch(() => false)
  if (rootIsRepo) roots.push(cwd)
  const names = await readdir(cwd).catch(() => [])
  for (const name of names) {
    if (name.startsWith('.') && name !== '.') continue
    const dir = join(cwd, name)
    const isDir = await stat(dir).then((info) => info.isDirectory()).catch(() => false)
    if (!isDir) continue
    const isRepo = await stat(join(dir, '.git')).then(() => true).catch(() => false)
    if (isRepo) roots.push(dir)
  }
  if (roots.length > 0) return roots
  // Neither the cwd nor a direct child is a git repo (the user opened a program
  // SUBdirectory, or a workspace that is not versioned at all). Climb to the
  // nearest ancestor repo — a filename search that silently returns nothing is
  // worse than one that searches the enclosing project.
  const ancestor = await findGitRoot(cwd, parse(resolve(cwd)).root)
  return ancestor === undefined ? [] : [ancestor]
}

/**
 * Last-resort listing for a directory tree with no git repo anywhere: walk it,
 * skipping the usual noise, and return repo-relative-ish absolute paths.
 * Bounded (depth 8, 20k entries) so a search can never hang the host.
 * @param cwd - the directory to walk.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function listRawFiles(cwd) {
  const found = []
  const skip = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.idea', '.gradle', 'logs'])
  async function walk(dir, depth) {
    if (depth > 8 || found.length >= 20000) return
    const names = await readdir(dir).catch(() => [])
    for (const name of names) {
      if (found.length >= 20000) return
      if (skip.has(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) continue
      if (info.isDirectory()) await walk(path, depth + 1)
      else if (info.isFile()) found.push(path)
    }
  }
  await walk(cwd, 0)
  return found
}

/**
 * Filename search across a workspace, HONOURING .gitignore.
 *
 * Files come from `git ls-files --cached --others --exclude-standard` per repo
 * root: that lists tracked files plus untracked-but-not-ignored ones, applying
 * the repo's .gitignore and every nested .gitignore for free (git is the only
 * correct implementation of those semantics). 26 subprojects / ~14k files cost
 * ~0.2 s here; node_modules/target never appear because they are ignored.
 * @param {string} cwd - workspace root.
 * @param {string} query - case-insensitive substring of the path or basename.
 * @param {number} limit - max matches returned.
 * @returns {Promise<{roots: string[], matches: string[], truncated: boolean, files: number}>}
 */
async function searchWorkspaceFiles(cwd, query, limit) {
  const roots = await searchRoots(cwd)
  const needle = String(query ?? '').toLowerCase()
  const matches = []
  let files = 0
  if (roots.length === 0) {
    // No git anywhere up the tree: walk the directory instead of answering empty.
    const all = await listRawFiles(cwd)
    for (const path of all) {
      files += 1
      if (needle !== '' && path.toLowerCase().indexOf(needle) === -1) continue
      matches.push(path)
      if (matches.length >= limit) return { roots, matches, truncated: true, files }
    }
    return { roots, matches, truncated: false, files }
  }
  for (const root of roots) {
    let listing
    try {
      listing = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
    } catch {
      // git is absent/broken here: walk this root so filename search still answers.
      const all = await listRawFiles(root)
      for (const path of all) {
        files += 1
        if (needle !== '' && path.toLowerCase().indexOf(needle) === -1) continue
        matches.push(path)
        if (matches.length >= limit) return { roots, matches, truncated: true, files }
      }
      continue
    }
    for (const relativePath of listing.split('\0')) {
      if (relativePath === '') continue
      files += 1
      const lower = relativePath.toLowerCase()
      if (needle !== '' && lower.indexOf(needle) === -1) continue
      matches.push(join(root, relativePath))
      if (matches.length >= limit) return { roots, matches, truncated: true, files }
    }
  }
  return { roots, matches, truncated: false, files }
}

/**
 * One filename search request. Query parameters: `sessionId` (required),
 * `cwd`/`q`/`limit`. Only file paths are returned — the IDE opens form files.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveSearch(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const query = url.searchParams.get('q') ?? ''
    const rawLimit = Number(url.searchParams.get('limit') ?? '300')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 2000) : 300
    const result = await searchWorkspaceFiles(cwd, query, limit)
    writeJson(res, 200, { ok: true, root: cwd, ...result })
  } catch (error) {
    writeTailError(res, error)
  }
}

/** Content-search clamp: hits returned by one request (`limit`, default 300). */
const CONTENT_SEARCH_MAX_HITS = 1000
/** Content-search clamp: matches taken from one file (`perFile`, default 8). */
const CONTENT_SEARCH_MAX_PER_FILE = 50
/** Files the no-git fallback walks at most (bounded so a search can never hang). */
const CONTENT_SEARCH_FALLBACK_MAX_FILES = 2000
/** Files at least this large are skipped by the no-git fallback. */
const CONTENT_SEARCH_FALLBACK_MAX_BYTES = 1024 * 1024
/** Bytes inspected for a NUL byte when deciding whether a fallback file is binary. */
const CONTENT_SEARCH_BINARY_PROBE_BYTES = 8 * 1024

/**
 * Whether `candidate` is `root` itself or lexically inside it. Used on the
 * `path:line:text` records `git grep` prints, whose "path" is repo-relative:
 * a `..` segment (or a quoted/odd name) must never produce a hit outside the
 * repo root the search was scoped to.
 * @param root - absolute repo root.
 * @param candidate - absolute path to test.
 * @returns `true` when the candidate stays inside the root.
 */
function isContainedIn(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Parse one `git grep -n` stdout line (`<path>:<line>:<text>`) into a hit.
 * Malformed lines and paths escaping the root are dropped, never thrown.
 * @param root - absolute repo root the grep ran in.
 * @param raw - one stdout line.
 * @returns `{ path, line, text }`, or `undefined` when the line is not a hit.
 */
function parseGitGrepLine(root, raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  // Non-greedy: the first `:<digits>:` pair separates path from line number, so
  // a path that itself contains a colon still parses as long as it has no `:1:`.
  const match = /^(.*?):(\d+):(.*)$/.exec(raw)
  if (match === null) return undefined
  const relativePath = match[1]
  if (relativePath === '') return undefined
  const absolutePath = resolve(root, relativePath)
  if (!isContainedIn(root, absolutePath)) return undefined
  const line = Number(match[2])
  if (!Number.isSafeInteger(line) || line <= 0) return undefined
  return { path: absolutePath, line, text: match[3].replace(/\r$/, '').trimEnd() }
}

/**
 * Filesystem fallback for content search: no git repo, or no `git` binary. Walk
 * the workspace ({@link listRawFiles}), read small files, and substring-match
 * case-insensitively (`git grep` itself is case-sensitive unless `-i` is passed;
 * this fallback deliberately leans the other way so it still finds things).
 * @param cwd - workspace root.
 * @param query - the search text (non-empty).
 * @param limit - max hits returned.
 * @param perFile - max hits taken from one file.
 * @returns `{ hits, truncated, files }`.
 */
async function searchContentRaw(cwd, query, limit, perFile) {
  const needle = String(query).toLowerCase()
  const hits = []
  let files = 0
  const all = await listRawFiles(cwd)
  for (const path of all) {
    if (files >= CONTENT_SEARCH_FALLBACK_MAX_FILES) return { hits, truncated: true, files }
    files += 1
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    if (info.size >= CONTENT_SEARCH_FALLBACK_MAX_BYTES) continue
    let bytes
    try {
      bytes = await readFile(path)
    } catch {
      continue // unreadable (permissions, a race with a delete): skip, never fail the search
    }
    if (bytes.subarray(0, CONTENT_SEARCH_BINARY_PROBE_BYTES).includes(0)) continue
    const text = bytes.toString('utf8')
    let lineNumber = 0
    let perFileCount = 0
    for (const line of text.split('\n')) {
      lineNumber += 1
      if (perFileCount >= perFile) break
      const plain = line.replace(/\r$/, '')
      if (plain.toLowerCase().indexOf(needle) === -1) continue
      hits.push({ path, line: lineNumber, text: plain.trimEnd() })
      perFileCount += 1
      if (hits.length >= limit) return { hits, truncated: true, files }
    }
  }
  return { hits, truncated: false, files }
}

/**
 * Workspace CONTENT search (the IDE's "在文件中查找").
 *
 * One `git grep` per repo root under `cwd` — the only implementation that gets
 * .gitignore, submodule and binary handling right, and it is fast (a repo-wide
 * literal search is a few hundred ms). `-m <perFile>` caps matches per file and
 * `-I` skips binaries; `-F` makes the pattern a fixed string (no regex
 * compilation of user input, no `.`/`*` surprises).
 * Without git (no repo anywhere, or no git binary) it falls back to walking
 * files, which keeps the panel useful on a bare directory.
 * @param cwd - workspace root.
 * @param query - the literal text to look for (non-empty; validated by the route).
 * @param limit - max hits returned (already clamped by the route).
 * @param perFile - max hits per file (already clamped by the route).
 * @returns `{ hits: [{path, line, text}], truncated, roots, files }`.
 */
async function searchWorkspaceContent(cwd, query, limit, perFile) {
  const needle = String(query ?? '')
  const roots = await searchRoots(cwd)
  if (needle === '') return { hits: [], truncated: false, roots, files: 0 }
  if (roots.length === 0 || gitMissing) {
    return { ...await searchContentRaw(cwd, needle, limit, perFile), roots }
  }
  const hits = []
  const paths = new Set()
  let truncated = false
  for (const root of roots) {
    let stdout
    try {
      stdout = await runGit(['grep', '-n', '-I', '--no-color', '-F', '-m', String(perFile), '-e', needle], root)
    } catch {
      // A root whose git call failed is not fatal (and git may have disappeared
      // mid-search): fall back to the filesystem walk for the whole request.
      if (gitMissing) return { ...await searchContentRaw(cwd, needle, limit, perFile), roots }
      continue
    }
    for (const raw of stdout.split('\n')) {
      if (hits.length >= limit) {
        truncated = true
        break
      }
      const hit = parseGitGrepLine(root, raw)
      if (hit === undefined) continue
      hits.push(hit)
      paths.add(hit.path)
    }
    if (hits.length >= limit) {
      truncated = true
      break
    }
  }
  return { hits, truncated, roots, files: paths.size }
}

/**
 * One content-search request. Query parameters: `sessionId` (required),
 * `cwd`, `q` (required, non-empty), `limit` (default 300, clamped 1..1000) and
 * `perFile` (default 8, clamped 1..50).
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveContentSearch(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const query = url.searchParams.get('q') ?? ''
    if (query.trim() === '') throw new TailError('bad-request', 'q (the text to search for) is required', 400)
    const rawLimit = Number(url.searchParams.get('limit') ?? '300')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), CONTENT_SEARCH_MAX_HITS) : 300
    const rawPerFile = Number(url.searchParams.get('perFile') ?? '8')
    const perFile = Number.isFinite(rawPerFile) ? Math.min(Math.max(1, Math.floor(rawPerFile)), CONTENT_SEARCH_MAX_PER_FILE) : 8
    const result = await searchWorkspaceContent(cwd, query, limit, perFile)
    writeJson(res, 200, { ok: true, root: cwd, ...result })
  } catch (error) {
    writeTailError(res, error)
  }
}

/** Cache of one repo root's allowed file paths (gitignore-aware), 5s TTL. */
const TREE_ALLOWED_CACHE = new Map()
/** Repo listing caches invalidated in the last second (coalesces save storms). */
const ALLOWED_INVALIDATED_AT = new Map()
const TREE_ALLOWED_TTL_MS = 30000

/** Nearest ancestor of `from` that carries `.git` (stops at `stopAt`). */
/** `findGitRoot` results for the watcher (the same directory is asked repeatedly). */
const GIT_ROOT_CACHE = new Map()
const GIT_ROOT_TTL_MS = 5000

/**
 * Cached {@link findGitRoot}: the watcher resolves the repo of every changed path
 * and a directory's repo does not move while the panel is open.
 * @param {string} from - a file or directory path.
 * @param {string} stopAt - the workspace root (never walks above it).
 * @returns {Promise<string|undefined>} the repo root, or undefined outside git.
 */
async function findGitRootCached(from, stopAt) {
  const key = `${from}\u0000${stopAt}`
  const cached = GIT_ROOT_CACHE.get(key)
  if (cached !== undefined && Date.now() - cached.at < GIT_ROOT_TTL_MS) return cached.root
  const root = await findGitRoot(from, stopAt)
  // Bounded: a build touching thousands of directories must not grow this map.
  if (GIT_ROOT_CACHE.size > 2000) GIT_ROOT_CACHE.clear()
  GIT_ROOT_CACHE.set(key, { at: Date.now(), root })
  return root
}

/**
 * Tree watchers: ONE non-recursive `fs.watch` per directory the user has OPENED.
 *
 * A recursive watch of the workspace root is not an option here: this workspace
 * has ~36 000 directories and registering them costs ~5 s of BLOCKED event loop
 * on every panel open/reconnect (measured) — which is exactly what made the IDE
 * feel slower the longer it ran. Watching only what the tree actually lists is
 * cheap (a folder with 30 children costs ~1 ms) and bounded by an LRU cap.
 */
const TREE_WATCH_MAX_DIRS = 128
/** `cwd` → `{dirs: Map<string, FSWatcher>, listeners: Set<Function>}`. */
const TREE_WATCH_HUB = new Map()

/** Get (or create) the watch hub of one workspace. */
function treeWatchHub(cwd) {
  const key = cwd
  let hub = TREE_WATCH_HUB.get(key)
  if (hub === undefined) {
    hub = { dirs: new Map(), listeners: new Set() }
    TREE_WATCH_HUB.set(key, hub)
  }
  return hub
}

/** Drop one directory's watcher (LRU eviction / hub teardown). */
function closeTreeWatchDir(hub, dir) {
  const watcher = hub.dirs.get(dir)
  if (watcher === undefined) return
  hub.dirs.delete(dir)
  try { watcher.close() } catch { /* already closed */ }
}

/**
 * Record that the client listed `dir`: that is the signal it is OPEN on screen,
 * so it is the only place worth watching. Evicts the oldest watcher past the cap.
 * @param {string} cwd - workspace root.
 * @param {string} dir - an absolute directory path resolved by the tree route.
 */
function noteTreeDirOpen(cwd, dir) {
  const hub = treeWatchHub(cwd)
  if (hub.dirs.has(dir)) {
    // Refresh LRU position.
    const existing = hub.dirs.get(dir)
    hub.dirs.delete(dir)
    hub.dirs.set(dir, existing)
    return
  }
  if (hub.dirs.size >= TREE_WATCH_MAX_DIRS) {
    const oldest = hub.dirs.keys().next().value
    if (oldest !== undefined) closeTreeWatchDir(hub, oldest)
  }
  try {
    const watcher = watch(dir, { persistent: false }, (event, filename) => {
      const relative = typeof filename === 'string' && filename !== ''
        ? relativePathOf(cwd, join(dir, filename))
        : relativePathOf(cwd, dir)
      if (relative === '') return
      for (const listener of hub.listeners) {
        try {
          listener(relative)
        } catch {
          // A subscriber's own bug must not escape through fs.watch's callback
          // (that path becomes an uncaught exception and takes the host down).
        }
      }
    })
    watcher.on('error', () => closeTreeWatchDir(hub, dir))
    hub.dirs.set(dir, watcher)
  } catch {
    // A vanished/permission-denied directory simply gets no watcher.
  }
}

/**
 * Relative `/`-separated path of `absolute` under `cwd` ('' when outside).
 * @param {string} cwd - workspace root.
 * @param {string} absolute - a path inside it.
 * @returns {string} the relative path, or '' when not under the root.
 */
function relativePathOf(cwd, absolute) {
  const value = resolve(absolute)
  const root = resolve(cwd)
  if (value === root) return ''
  if (!value.startsWith(root.endsWith(sep) ? root : root + sep)) return ''
  return value.slice(root.length + 1).replaceAll(sep, '/')
}

/** Path segments the watcher always drops (git never reports these as changes). */
const TREE_WATCH_ALWAYS_IGNORED = new Set(['.git', TREE_TRASH_DIR])

/**
 * Whether a rel path is one the tree never shows for structural reasons.
 * @param {string} relativePath - watcher filename.
 * @returns {boolean} true when it must be dropped before any git query.
 */
function isStructurallyIgnoredTreePath(relativePath) {
  return String(relativePath === undefined || relativePath === null ? '' : relativePath)
    .split('/')
    .some((part) => TREE_WATCH_ALWAYS_IGNORED.has(part))
}

/**
 * Filter watched paths through the SAME ignore rules the tree uses: the repo's
 * `.gitignore` (via `git check-ignore`, which covers tracked and untracked-
 * but-visible files alike). Outside any repo the segment list of the raw-walk
 * fallback applies instead.
 * @param {string} cwd - watched workspace root.
 * @param {string[]} relatives - changed `/`-separated paths.
 * @returns {Promise<string[]>} the paths the tree could actually show.
 */

/**
 * Drop one repo's listing cache, at most once per second: a burst of writes must
 * not spawn `git ls-files` per event batch.
 * @param {string} repo - the repo root.
 */
function invalidateAllowedCache(repo) {
  const now = Date.now()
  const last = ALLOWED_INVALIDATED_AT.get(repo) || 0
  if (now - last < 1000) return
  ALLOWED_INVALIDATED_AT.set(repo, now)
  TREE_ALLOWED_CACHE.delete(repo)
}

/**
 * Drop one repo's listing cache immediately, ignoring the coalescing throttle.
 * Used when the CLIENT knows the filesystem just changed (copy/rename/create):
 * a stale set would hide the new entry for up to {@link TREE_ALLOWED_TTL_MS} ms
 * even though the directory itself was just re-read.
 * @param {string} repo - the repo root.
 */
async function treeWatchAccepts(cwd, relatives) {
  const accepted = []
  for (const relative of relatives) {
    const normalized = String(relative === undefined || relative === null ? '' : relative)
    if (normalized === '' || isStructurallyIgnoredTreePath(normalized)) continue
    // Churn directories (node_modules/target/logs/…) are dropped before any git
    // work: resolving them per event is what made the host crawl during builds.
    if (shouldIgnoreTreePath(normalized)) continue
    const absolute = resolve(cwd, normalized)
    const dir = dirname(absolute)
    const repo = await findGitRootCached(dir, cwd).catch(() => undefined)
    if (repo === undefined) {
      accepted.push(normalized)
      continue
    }
    // The tree lists exactly `repoAllowedPaths`: tracked + untracked-but-not-
    // ignored files. Reusing that set is the SAME rule without a git process per
    // event (it is cached for a few seconds).
    const allowed = await repoAllowedPaths(repo).catch(() => undefined)
    if (allowed === undefined) {
      accepted.push(normalized)
      continue
    }
    if (allowed.files.has(absolute) || allowed.dirs.has(dir)) {
      invalidateAllowedCache(repo)
      accepted.push(normalized)
    }
  }
  return accepted
}

function invalidateAllowedCacheNow(repo) {
  if (typeof repo !== 'string' || repo === '') return
  ALLOWED_INVALIDATED_AT.set(repo, Date.now())
  TREE_ALLOWED_CACHE.delete(repo)
}

async function findGitRoot(from, stopAt) {
  let current = resolve(from)
  const limit = resolve(stopAt)
  for (let depth = 0; depth < 40; depth += 1) {
    const found = await stat(join(current, '.git')).then(() => true).catch(() => false)
    if (found) return current
    if (current === limit) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * The visible file paths of one repo: `git ls-files --cached --others
 * --exclude-standard`. Returns absolute file paths plus every ancestor
 * directory (so a directory is listable only when it holds visible files).
 * Cached for a few seconds — a tree walk re-asks the same root per level.
 * @param {string} root - the repo root.
 * @returns {Promise<{files: Set<string>, dirs: Set<string>}>}
 */
async function repoAllowedPaths(root) {
  // No git installed (or a broken repo): return undefined so callers fall back to
  // "the filesystem is the whitelist" instead of hiding every file.
  if (gitMissing) return undefined
  const cached = TREE_ALLOWED_CACHE.get(root)
  if (cached !== undefined && Date.now() - cached.at < TREE_ALLOWED_TTL_MS) return cached.value
  const files = new Set()
  const dirs = new Set([root])
  let listing
  try {
    listing = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
  } catch {
    // Any failure (most often "git is not installed") degrades to no filtering.
    TREE_ALLOWED_CACHE.set(root, { at: Date.now(), value: undefined })
    return undefined
  }
  for (const relativePath of listing.split('\0')) {
    if (relativePath === '') continue
    const full = join(root, relativePath)
    files.add(full)
    let parent = dirname(full)
    while (parent.length >= root.length && parent !== root) {
      if (dirs.has(parent)) break
      dirs.add(parent)
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  const value = { files, dirs }
  TREE_ALLOWED_CACHE.set(root, { at: Date.now(), value })
  return value
}

/** One Java package segment (identifier): only these join into a dotted package name. */
const PACKAGE_SEGMENT = /^[A-Za-z_$][\w$]*$/

/**
 * Whether `full` sits STRICTLY BELOW a directory named `java`. Package folding is
 * only meaningful inside Java source, so nothing else in the tree is compacted.
 * @param {string} full - absolute directory path.
 */
function isInsideJavaDirectory(full) {
  return String(full).split(/[\\/]+/).slice(0, -1).includes('java')
}

/** Display label of a compact chain: identifiers join with '.', the rest with '/'. */
function compactLabel(segments) {
  return segments.every((part) => PACKAGE_SEGMENT.test(part)) ? segments.join('.') : segments.join('/')
}

/**
 * Fold a chain of single-child PACKAGE directories into ONE row (IntelliJ style):
 * `cn/com/ris/cloud/model` becomes one entry labelled `cn.com.ris.cloud.model`.
 *
 * Only called for a directory below a `java` folder (see {@link isInsideJavaDirectory}),
 * so `src/main/java` itself is never compacted. A chain stops at a repo root (never
 * fold INTO a subproject), when a directory holds anything other than exactly one
 * visible directory, when a child is not a package segment, or at depth 12.
 * @param {string} full - the first directory (a package segment).
 * @param {Set<string>|undefined} allowed - the repo's visible-path sets (`undefined` = unfiltered).
 * @returns {Promise<{path: string, segments: string[]}>} the folded tail.
 */
async function compactChain(full, allowed, repo) {
  const segments = [basename(full)]
  let current = full
  for (let depth = 0; depth < 12; depth += 1) {
    const children = await readdir(current, { withFileTypes: true }).catch(() => [])
    const visible = []
    // A freshly created folder is invisible to `git ls-files`; it must still
    // STOP the fold, otherwise `…/ris/cloud/…` would swallow an empty `…/ris/test`
    // sibling and the tree would show one long chain instead of both packages.
    const unknownDirs = []
    for (const child of children) {
      const childPath = join(current, child.name)
      if (child.isDirectory()) {
        const isRepo = await stat(join(childPath, '.git')).then(() => true).catch(() => false)
        if (isRepo) return { path: current, segments }
        if (allowed !== undefined && !allowed.dirs.has(childPath)) {
          if (repo !== undefined) unknownDirs.push(childPath)
          continue
        }
        visible.push({ path: childPath, dir: true })
        continue
      }
      if (allowed !== undefined && !allowed.files.has(childPath)) continue
      visible.push({ path: childPath, dir: false })
    }
    if (unknownDirs.length > 0) {
      const relatives = unknownDirs.map((item) => relative(repo, item).split(sep).join('/') + '/')
      const ignored = await ignoredTreeDirs(repo, relatives)
      for (let index = 0; index < unknownDirs.length; index += 1) {
        if (!ignored.has(relatives[index])) visible.push({ path: unknownDirs[index], dir: true })
      }
    }
    if (visible.length !== 1 || visible[0].dir !== true) return { path: current, segments }
    if (!PACKAGE_SEGMENT.test(basename(visible[0].path))) return { path: current, segments }
    current = visible[0].path
    segments.push(basename(current))
  }
  return { path: current, segments }
}

/**
 * Empty directories are invisible to `git ls-files` (`--cached --others` only
 * lists FILES), so a freshly created package folder never made it into
 * `repoAllowedPaths` and the tree hid it. This asks git's own ignore rules for
 * the directories that git cannot see, so "empty but not ignored" shows up while
 * `target/`, `node_modules/` … stay hidden. One batched `git check-ignore` per
 * listing; a repo-less tree needs no check at all.
 * @param {string} repo - the git root.
 * @param {string[]} relatives - repo-relative directory paths (with a trailing `/`).
 * @returns {Promise<Set<string>>} the subset gitignore hides.
 */
async function ignoredTreeDirs(repo, relatives) {
  if (relatives.length === 0) return new Set()
  // `-v -z` answers in quads: source, line number, pattern, pathname. The pattern
  // is needed: a `.gitignore` written with CRLF and a trailing blank line makes git
  // report an EMPTY pattern that matches every directory — trusting the bare
  // pathname there hides folders that are not ignored at all (a real repo with
  // such a file lost `java/cn/com/ris/test`). An empty pattern is never a rule.
  const output = await runGit(['check-ignore', '-v', '-z', '--stdin'], repo, relatives.join('\0') + '\0').catch(() => '')
  const fields = output.split('\0')
  const ignored = new Set()
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const pattern = fields[index + 2]
    const pathname = fields[index + 3]
    if (pattern === '' || pathname === '') continue
    ignored.add(pathname)
  }
  return ignored
}

/**
 * One directory level for the IDE tree.
 * @param {string} target - absolute directory.
 * @param {string} cwd - workspace root (git-root search limit).
 * @returns {Promise<{entries: object[], truncated: boolean}>}
 */
async function listIdeTree(target, cwd, options) {
  const repo = await findGitRoot(target, cwd)
  // `filter: 'all'` is the tree's "show everything" mode: the gitignore filter is
  // deliberately bypassed, but the plugin's own bookkeeping folders stay hidden.
  const filterAll = options !== undefined && options !== null && options.filter === 'all'
  const allowed = repo === undefined || filterAll ? undefined : await repoAllowedPaths(repo)
  const dirents = await readdir(target, { withFileTypes: true }).catch(() => [])
  // Directories git cannot see (empty, or holding only ignored files): only the
  // ones gitignore does NOT hide are shown, so a new empty package folder appears.
  const unknownDirs = []
  if (repo !== undefined && allowed !== undefined) {
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name === TREE_TRASH_DIR) continue
      const full = join(target, dirent.name)
      if (allowed.dirs.has(full)) continue
      const isRepo = await stat(join(full, '.git')).then(() => true).catch(() => false)
      if (isRepo) continue
      unknownDirs.push(relative(repo, full).split(sep).join('/') + '/')
    }
  }
  const ignoredDirs = await ignoredTreeDirs(repo ?? '', unknownDirs)
  const entries = []
  for (const dirent of dirents) {
    // The undo trash and the dependency-source cache are implementation
    // details, never tree rows.
    if (dirent.name === TREE_TRASH_DIR || dirent.name === IDE_CACHE_DIR) continue
    const full = join(target, dirent.name)
    if (dirent.isDirectory()) {
      const isRepo = await stat(join(full, '.git')).then(() => true).catch(() => false)
      if (!isRepo && allowed !== undefined && !allowed.dirs.has(full)) {
        const relativeDir = relative(repo, full).split(sep).join('/') + '/'
        if (ignoredDirs.has(relativeDir)) continue
      }
      // Java packages fold into one dotted row; every other folder keeps its own row.
      const foldable = !isRepo && isInsideJavaDirectory(full) && PACKAGE_SEGMENT.test(dirent.name)
      const folded = foldable ? await compactChain(full, allowed, repo) : { path: full, segments: [dirent.name] }
      entries.push({
        name: basename(folded.path),
        label: folded.segments.length > 1 ? compactLabel(folded.segments) : basename(full),
        path: folded.path,
        isDir: true,
        compact: folded.segments.length > 1,
      })
      continue
    }
    if (allowed !== undefined && !allowed.files.has(full)) continue
    entries.push({ name: dirent.name, label: dirent.name, path: full, isDir: false })
  }
  entries.sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
    return String(left.label).localeCompare(String(right.label))
  })
  return {
    entries,
    truncated: false,
    // `git`: a repo (and a working git) is behind this path; `filtered`: the
    // listing currently applies .gitignore. The client's title-bar toggle reads
    // both (no git → nothing to toggle; git → default ON).
    git: repo !== undefined && gitMissing !== true,
    filtered: allowed !== undefined,
  }
}

/**
 * One tree-level request. Query parameters: `sessionId`, `cwd`, `path`.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveTree(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const raw = url.searchParams.get('path')
    const target = raw === null || raw === '' ? cwd : resolvePath(cwd, raw, options?.restrictToCwd === true)
    // `fresh=1`: the caller changed the filesystem and needs the git-visible set
    // re-read, otherwise the cached `ls-files` result hides the new entry.
    if (url.searchParams.get('fresh') === '1') {
      const repo = await findGitRoot(target, cwd).catch(() => undefined)
      if (repo !== undefined) invalidateAllowedCacheNow(repo)
    }
    const listing = await listIdeTree(target, cwd, { filter: url.searchParams.get('filter') === 'all' ? 'all' : 'git' })
    // The client asks for a level exactly when it opens that folder, so this is
    // where a directory earns a watcher (see noteTreeDirOpen).
    noteTreeDirOpen(cwd, target)
    writeJson(res, 200, { ok: true, path: target, ...listing })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * One request: list the services `run-with-log.sh` started under a logs directory.
 *
 * The client paints one row per entry (name, alive, path) with an "open log"
 * button that opens the existing `.log` viewer, so a human can reach the live
 * tail without a model turn. Liveness comes from the pidfile + the same
 * `/proc/<pid>/cmdline` proof the stop route uses, never from the caller.
 *
 * The directory is fenced like `resolvePath(..., restrict)`: it must be the
 * session cwd or a descendant, so this cannot be turned into a generic
 * directory lister.
 *
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face; reads `sessionId` and optional `dir`.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveInstances(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const raw = url.searchParams.get('dir')
    const dir = resolvePath(cwd, typeof raw === 'string' && raw !== '' ? raw : 'logs', true)
    const entries = await listInstances(dir, options)
    writeJson(res, 200, { ok: true, dir, entries })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * The running/known instances under one directory: every `<name>.log` that has a
 * sibling `<name>.log.pid`. Sorted with the live ones first.
 * @param dir - absolute logs directory (already fenced).
 * @param options - `{ restrictToCwd }` is unused here; kept for symmetry.
 * @returns `[{ name, logPath, pid, wrapperPid, startedAt, alive, verified, size, mtimeMs }]`.
 */
/** Start only when at least this much memory is free (1 GiB). */
export const MIN_FREE_MEMORY_BYTES = 1024 * 1024 * 1024
/** Rotate one service log once it passes this size (32 MiB), keeping one backup. */
export const LOG_ROTATE_BYTES = 32 * 1024 * 1024

/**
 * Memory the OS says is still available (`/proc/meminfo` `MemAvailable`).
 * @returns {Promise<number>} bytes, 0 when unknown (non-Linux, or unreadable).
 */
export async function availableMemoryBytes() {
  try {
    const text = await readFile('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s*(\d+)\s*kB/m.exec(text)
    return match === null ? 0 : Number(match[1]) * 1024
  } catch {
    return 0
  }
}

/** Human label for a byte count (for the refusal message). */
function memoryLabel(bytes) {
  const value = Number(bytes) || 0
  // GiB values keep one decimal so "1.0 GB" does not read as "1024 MB".
  return value >= 1024 * 1024 * 1024 ? `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${Math.round(value / (1024 * 1024))} MB`
}

/**
 * Refuse to start a service when the box is nearly out of memory.
 *
 * Starting one more Spring service on a machine that is already swapping is how
 * a dev box dies: the JVMs each grow toward `-Xmx` ≈ RAM/4 and everything stalls.
 * Unknown platforms (no `/proc`) skip the check rather than guess.
 * @param {number} [minFreeBytes] - the floor, defaults to {@link MIN_FREE_MEMORY_BYTES}.
 * @returns {Promise<void>} throws a `low-memory` error when below the floor.
 */
export async function assertEnoughMemory(minFreeBytes) {
  const floor = Number.isFinite(minFreeBytes) ? Number(minFreeBytes) : MIN_FREE_MEMORY_BYTES
  const free = await availableMemoryBytes()
  if (free === 0 || free >= floor) return
  throw new TailError(
    'low-memory',
    `可用内存仅 ${memoryLabel(free)}（低于 ${memoryLabel(floor)}），为避免 swap 抖动已拒绝启动；请先停止不用的服务，或在 .dsh-ris-ide.json 里给程序配小一点的 jvmArgs（如 -Xmx768m）`,
    507,
  )
}

/**
 * Rotate one log: when it exceeds {@link LOG_ROTATE_BYTES}, keep the last copy as
 * `<log>.1` and TRUNCATE the live file in place (rename would leave the running
 * JVM writing to an unlinked inode, so `/tail` would go silent).
 * @param {string} logPath - the live log file.
 * @param {number} [maxBytes] - rotation threshold.
 * @returns {Promise<boolean>} whether it rotated.
 */
export async function rotateLogIfLarge(logPath, maxBytes) {
  const limit = Number.isFinite(maxBytes) ? Number(maxBytes) : LOG_ROTATE_BYTES
  const info = await stat(logPath).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size <= limit) return false
  try {
    await copyFile(logPath, `${logPath}.1`)
  } catch {
    // A backup is nice-to-have; truncating is the part that matters.
  }
  try {
    await truncate(logPath, 0)
  } catch {
    // Windows can refuse while the JVM holds the file without FILE_SHARE_WRITE.
    // Rotation is housekeeping: never let it break a start.
    return false
  }
  return true
}

/** Logs of the services WE started — the periodic rotation watches these. */
const ACTIVE_LOG_PATHS = new Set()
/** How often the periodic log rotation looks at the live logs. */
const LOG_ROTATE_INTERVAL_MS = 60 * 1000

/**
 * Remember one live log for the periodic rotation (dedupes by path).
 * @param {string} logPath - the log being appended by a service we spawned.
 */
function trackActiveLog(logPath) {
  if (typeof logPath === 'string' && logPath !== '') ACTIVE_LOG_PATHS.add(logPath)
}

/**
 * Rotate every tracked log that grew past the threshold. Missing paths drop out
 * so the timer does not accumulate stale entries.
 * @param {number} [maxBytes] - rotation threshold (defaults to {@link LOG_ROTATE_BYTES}).
 * @returns {Promise<string[]>} the paths that were rotated.
 */
export async function rotateActiveLogs(maxBytes) {
  const rotated = []
  for (const logPath of Array.from(ACTIVE_LOG_PATHS)) {
    const info = await stat(logPath).catch(() => undefined)
    if (info === undefined) {
      ACTIVE_LOG_PATHS.delete(logPath)
      continue
    }
    if (await rotateLogIfLarge(logPath, maxBytes).catch(() => false)) rotated.push(logPath)
  }
  return rotated
}

/**
 * Resident memory of one process, best effort: Linux reads
 * `/proc/<pid>/status` (`VmRSS`), everything else returns 0. Used to show how
 * much each running service really costs — several Spring services on an 8 GB box
 * is the difference between "fine" and "swapping".
 * @param {number} pid - process id.
 * @returns {Promise<number>} resident bytes (0 when unknown).
 */
export async function processRssBytes(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return 0
  // Windows has no /proc: the console simply omits the memory column there
  // (spawning `Get-Process` per row per scan would cost more than it shows).
  if (IS_WINDOWS) return 0
  try {
    const text = await readFile(`/proc/${id}/status`, 'utf8')
    const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(text)
    return match === null ? 0 : Number(match[1]) * 1024
  } catch {
    return 0
  }
}

export async function listInstances(dir) {
  const names = await readdir(dir).catch(() => undefined)
  if (!Array.isArray(names)) return []
  const pidFiles = names.filter((n) => n.endsWith(`${PID_SUFFIX}`))
  const out = []
  for (const pidName of pidFiles) {
    if (out.length >= MAX_INSTANCES) break
    const logFile = pidName.slice(0, -PID_SUFFIX.length)
    const logPath = resolve(dir, logFile)
    const record = await readPidFile(logPath)
    if (record === undefined) continue
    // Same proof the stop route requires: the wrapper PID must really be our script.
    const verified = await isRunWithLogWrapper(record.wrapperPid)
    let size
    let mtimeMs
    try {
      const info = await stat(logPath)
      size = info.size
      mtimeMs = info.mtimeMs
    } catch {
      // No log file next to the pidfile: still report it (the viewer shows "missing").
    }
    const aliveNow = verified && (isAlive(record.pid) || isAlive(record.wrapperPid))
    out.push({
      // `<name>.log.pid` → `<name>`；带时间戳的 `<name>-<ts>.log.pid` → `<name>-<ts>`
      name: logFile.endsWith('.log') ? logFile.slice(0, -'.log'.length) : logFile,
      logPath,
      pid: record.pid,
      wrapperPid: record.wrapperPid,
      startedAt: record.startedAt,
      alive: aliveNow,
      verified,
      rssBytes: aliveNow ? await processRssBytes(record.pid) : 0,
      size,
      mtimeMs,
    })
  }
  out.sort((a, b) => Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name))
  return out
}

/**
 * Answer one failed request as JSON (the browser half never parses HTML).
 * @param res - Node response face.
 * @param error - whatever the handler threw; a {@link TailError} carries its status.
 */
export function writeTailError(res, error) {
  const code = error instanceof TailError ? error.code : 'error'
  const status = error instanceof TailError ? error.status : 500
  writeJson(res, status, {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
  })
}

/** The pathname of one request, never throwing on a malformed URL. */
function requestPathname(req) {
  try {
    return new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh.internal').pathname
  } catch {
    return ''
  }
}

/**
 * One request: fence, resolve, read the tail, answer JSON.
 * Every failure answers JSON too, so the browser half never has to parse HTML.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ maxBytes, restrictToCwd }` (see {@link apply}).
 */
async function serveTail(ctx, req, res, options) {
  const maxBytes = options?.maxBytes ?? HARD_MAX_BYTES
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    if (req.method !== 'GET') throw new TailError('method-not-allowed', 'GET only', 405)
    const url = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh.internal')
    if (url.pathname !== TAIL_PATH) throw new TailError('not-found', `unknown route ${url.pathname}`, 404)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const raw = url.searchParams.get('path') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    if (raw === '') throw new TailError('bad-request', 'path is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const target = resolvePath(cwd, raw, options?.restrictToCwd === true)
    const bytes = clampBytes(url.searchParams.get('bytes'), DEFAULT_BYTES, maxBytes)
    const rawBefore = url.searchParams.get('before')
    const before = rawBefore === null || rawBefore === '' ? undefined : Number(rawBefore)
    const tail = await readTailWindow(target, bytes, Number.isFinite(before) ? before : undefined)
    // "Service still running" is what puts the stop button in the viewer: it is
    // true exactly when the script's pidfile exists and its PID is alive.
    const service = await readService(target)
    writeJson(res, 200, { ok: true, ...tail, ...(service === undefined ? {} : { service }) })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * One stop request: fence, resolve, validate the pidfile, signal the wrapper,
 * wait for it to go, and answer what happened. The body is JSON
 * `{ sessionId, path, cwd? }` (the same scope the viewer reads with).
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face (POST).
 * @param res - Node response face.
 * @param options - `{ restrictToCwd, stopGraceMs }` (see {@link apply}).
 */
async function serveStop(ctx, req, res, options) {
  const graceMs = options?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh.internal')
    if (url.pathname !== STOP_PATH) throw new TailError('not-found', `unknown route ${url.pathname}`, 404)
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const raw = typeof body.path === 'string' ? body.path : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    if (raw === '') throw new TailError('bad-request', 'path is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const target = resolvePath(cwd, raw, options?.restrictToCwd === true)
    writeJson(res, 200, { ok: true, ...await stopLogPath(target, graceMs) })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * The service a log file belongs to, from its pidfile.
 * @param logPath - absolute path of the previewed log.
 * @returns `{ pid, wrapperPid, startedAt, alive }`, or `undefined` with no
 *  pidfile or an unparsable one.
 */
export async function readService(logPath) {
  const record = await readPidFile(logPath)
  if (record === undefined) return undefined
  return {
    pid: record.pid,
    wrapperPid: record.wrapperPid,
    startedAt: record.startedAt,
    alive: isAlive(record.pid) || isAlive(record.wrapperPid),
  }
}

/**
 * Parse `<log>.pid` — one line of `<servicePid> <wrapperPid> <epochMs>`, all
 * decimal. Anything else (missing, junk, a non-positive PID) reads as "no
 * service", so a hand-made file can never aim a signal somewhere.
 * @param logPath - absolute path of the previewed log.
 * @returns the parsed record, or `undefined`.
 */
export async function readPidFile(logPath) {
  const text = await readFile(`${logPath}${PID_SUFFIX}`, 'utf8').catch(() => undefined)
  if (typeof text !== 'string') return undefined
  const parts = text.trim().split(/\s+/)
  if (parts.length < 3) return undefined
  const pid = Number(parts[0])
  const wrapperPid = Number(parts[1])
  const startedAt = Number(parts[2])
  const graceMs = Number(parts[3])
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  if (!Number.isSafeInteger(wrapperPid) || wrapperPid <= 1) return undefined
  return {
    pid,
    wrapperPid,
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    graceMs: parts[3] !== undefined && Number.isFinite(graceMs) ? graceMs : undefined,
  }
}

/**
 * Wait until the wrapper either publishes its pidfile or dies.
 *
 * `waitForPidfile` alone misses the interesting failure: when the command exits
 * at once (port already bound, bad classpath, …) the pidfile may be created and
 * removed between two polls, and the caller would report a start that never
 * happened. This watches the child's exit too.
 * @param logPath - program log path (the pidfile sits next to it).
 * @param child - the spawned wrapper.
 * @param timeoutMs - overall deadline.
 * @returns `{ kind: 'running', record } | { kind: 'exited', code } | { kind: 'timeout' }`.
 */
function waitForStartup(logPath, child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let exitCode
    const finish = (value) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      clearTimeout(deadline)
      resolve(value)
    }
    child.once('exit', (code, signal) => { exitCode = code ?? signal ?? 'unknown' })
    const timer = setInterval(async () => {
      const record = await readPidFile(logPath)
      if (record !== undefined) {
        // A pidfile can be published and removed by a process that dies at once;
        // confirm the service is still alive a beat later.
        await new Promise((done) => setTimeout(done, 200))
        const again = await readPidFile(logPath)
        if (again !== undefined && isAlive(again.pid)) {
          finish({ kind: 'running', record: again })
          return
        }
        if (exitCode !== undefined) finish({ kind: 'exited', code: exitCode })
        return
      }
      if (exitCode !== undefined) finish({ kind: 'exited', code: exitCode })
    }, 100)
    const deadline = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
  })
}

/** One actionable start-failure sentence, including the log tail. */
async function startFailureMessage(program, startup) {
  const lines = []
  if (startup.kind === 'exited') lines.push(`启动命令在写出 pidfile 前就退出了（status ${startup.code}）`)
  else lines.push(`启动命令已发出，但 ${program.logName}.log.pid 未出现`)
  lines.push(`命令：${program.startCommand !== undefined ? program.startCommand : '(扫描/配置拼装)'}`)
  lines.push(`cwd：${program.dir}`)
  lines.push(`日志：${program.logPath}`)
  if (existsSync(program.logPath)) {
    const tail = await readTail(program.logPath, 8192).catch(() => undefined)
    if (tail !== undefined && typeof tail.content === 'string' && tail.content.trim() !== '') {
      const body = tail.content.split('\n').filter((line) => line !== '')
      lines.push('日志尾部：')
      lines.push(body.slice(Math.max(0, body.length - 12)).join('\n'))
    }
  }
  return lines.join('\n')
}

/** Remove the pidfile after a successful stop; a failure here is not a failure of the stop. */
async function removePidFile(logPath) {
  await rm(`${logPath}${PID_SUFFIX}`, { force: true }).catch(() => {})
}

/** Whether one PID is currently signalable. */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

/**
 * Whether one PID is the `run-with-log.sh` wrapper, by reading its command
 * line. This is the guard that keeps the stop route from being a generic
 * "kill any PID" endpoint: the browser never supplies a PID, and the PID the
 * pidfile names must prove it is our script.
 * @param pid - wrapper PID from the pidfile.
 * @returns whether the command line names the wrapper script.
 */
export async function isRunWithLogWrapper(pid) {
  if (!isAlive(pid)) return false
  if (IS_WINDOWS) {
    const commandLine = await windowsCommandLine(pid)
    return typeof commandLine === 'string'
      && (commandLine.includes('run-with-log.ps1') || commandLine.includes('run-with-log.sh'))
  }
  const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => undefined)
  if (typeof raw !== 'string') return false
  return raw.split('\0').join(' ').includes('run-with-log.sh')
}

/**
 * One process's command line on Windows (the `/proc/<pid>/cmdline` equivalent),
 * read through CIM. Used only to verify a pid is really our wrapper before
 * killing it — never to decide what to run.
 * @param pid - absolute process id.
 * @returns the command line, or `undefined` when it cannot be read.
 */
export function windowsCommandLine(pid) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolvePromise(undefined)
      return
    }
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolvePromise(undefined))
    child.on('close', () => resolvePromise(out.trim() === '' ? undefined : out.trim()))
  })
}

/**
 * Kill a process and its whole tree on Windows (`taskkill /T`), the equivalent of
 * the POSIX process-group TERM/KILL the Linux path uses.
 * @param pid - the wrapper pid whose tree should die.
 * @returns `true` when taskkill reported success.
 */
export function taskkillTree(pid) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('taskkill.exe', ['/PID', String(Number(pid)), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      })
    } catch {
      resolvePromise(false)
      return
    }
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => resolvePromise(code === 0))
  })
}

/**
 * TERM the wrapper, wait for it, then KILL if it is still there. The wrapper
 * owns the service child and the pidfile, so this is the only signal we send.
 * @param record - the parsed pidfile.
 * @param graceMs - how long to wait between TERM and KILL.
 * @returns `{ stopped, alreadyStopped, forced, waitedMs, pid, wrapperPid }`.
 */
/**
 * The process group a PID leads, when it really is its own group leader.
 * `/proc/<pid>/stat` fields after `(comm)` are: state, ppid, pgrp, session, …
 * The plugin spawns the wrapper detached, so its pgrp equals its pid — which is
 * what lets a stop reach `bash → pnpm → sh → node` in one signal.
 * @param pid - absolute process id.
 * @returns the pgid when `pid` leads it, `undefined` otherwise.
 */
export async function processGroupLeader(pid) {
  if (IS_WINDOWS) return undefined // Windows has no POSIX process groups
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined)
  if (typeof stat !== 'string') return undefined
  const close = stat.lastIndexOf(')')
  if (close === -1) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  const pgrp = Number(fields[2])
  return Number.isSafeInteger(pgrp) && pgrp === pid ? pgrp : undefined
}

/**
 * Every live PID in one process group (excluding the leader itself).
 * Used after a stop to sweep grandchildren that outlived their runner — a dev
 * server that keeps its port would otherwise block the next start.
 * @param pgid - process group id.
 * @returns absolute PIDs.
 */
export async function groupMembers(pgid) {
  if (IS_WINDOWS) return [] // no /proc, and `taskkill /T` already took the tree
  const names = await readdir('/proc').catch(() => [])
  const members = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === pgid || pid === process.pid) continue
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined)
    if (typeof stat !== 'string') continue
    const close = stat.lastIndexOf(')')
    if (close === -1) continue
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    if (Number(fields[2]) === pgid) members.push(pid)
  }
  return members
}

async function stopWrapper(record, graceMs) {
  const startedWaiting = Date.now()
  if (!isAlive(record.wrapperPid)) {
    return { stopped: true, alreadyStopped: true, forced: false, waitedMs: 0, pid: record.pid, wrapperPid: record.wrapperPid }
  }
  if (IS_WINDOWS) {
    // No signals and no process groups: verify the pid is our wrapper, then
    // `taskkill /T /F` the tree (wrapper + service + grandchildren) at once.
    if (!(await isRunWithLogWrapper(record.wrapperPid))) {
      throw new TailError('unverifiable', `pid ${record.wrapperPid} is not run-with-log.ps1; refusing to kill it`, 409)
    }
    await taskkillTree(record.wrapperPid)
    const stopped = await waitForExit(record.wrapperPid, 3000)
    return {
      stopped,
      alreadyStopped: false,
      forced: true,
      waitedMs: Date.now() - startedWaiting,
      pid: record.pid,
      wrapperPid: record.wrapperPid,
    }
  }
  // Signal the GROUP when the wrapper leads one: TERM then reaches the real
  // dev-server process (pnpm does not forward signals), not just the runner.
  const pgid = await processGroupLeader(record.wrapperPid)
  const signal = (sig) => {
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, sig)
        return
      } catch (error) {
        if (error?.code !== 'ESRCH') throw new TailError('signal-failed', `cannot ${sig} process group ${pgid}: ${describe(error)}`, 500)
      }
    }
    try {
      process.kill(record.wrapperPid, sig)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw new TailError('signal-failed', `cannot ${sig} pid ${record.wrapperPid}: ${describe(error)}`, 500)
    }
  }
  signal('SIGTERM')
  const exited = await waitForExit(record.wrapperPid, graceMs)
  const forced = !exited
  if (!exited) signal('SIGKILL')
  const stopped = exited || await waitForExit(record.wrapperPid, 1000)
  // Sweep the group even when the wrapper is gone: a grandchild that survived
  // (the reported bug — port still bound after a stop) is TERMed, then KILLed.
  if (pgid !== undefined) {
    const leftovers = await groupMembers(pgid)
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    if (leftovers.length > 0) {
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        const still = await groupMembers(pgid)
        if (still.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      for (const pid of await groupMembers(pgid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }
  return { stopped, alreadyStopped: false, forced, waitedMs: Date.now() - startedWaiting, pid: record.pid, wrapperPid: record.wrapperPid }
}

/** Poll until one PID stops being signalable or the deadline passes. */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await delay(120)
  }
  return !isAlive(pid)
}

/** One timer promise. */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Read one JSON request body with a hard cap. Malformed or oversized bodies
 * are routable failures, never a crash.
 * @param req - Node request face (async iterable).
 * @returns the parsed object (empty object for an empty body).
 */
async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (size > MAX_BODY_BYTES) throw new TailError('bad-request', 'request body too large', 413)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TailError('bad-request', 'body must be a JSON object', 400)
    }
    return parsed
  } catch (error) {
    if (error instanceof TailError) throw error
    throw new TailError('bad-request', 'body must be valid JSON', 400)
  }
}

/** Answer one JSON body; JSON.stringify output is length-stable, so content-length is exact. */
function writeJson(res, status, body) {
  // A file/image stream the browser cancelled ends the response first; writing
  // headers now throws ERR_HTTP_HEADERS_SENT (which used to kill the whole host).
  if (res.headersSent === true || res.writableEnded === true) {
    if (typeof res.destroy === 'function') res.destroy()
    return
  }
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    text = JSON.stringify({ ok: false, code: 'error', message: 'response is not serializable' })
    status = 500
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(text)
  } catch {
    // The socket vanished between our check and the write: answer nothing, and
    // make sure the dead response cannot surface as an uncaught exception.
    if (typeof res.destroy === 'function') res.destroy()
  }
}

/**
 * Run one route body without ever letting its promise escape. A response that
 * already started (an image/file stream the browser aborted) is destroyed, not
 * answered again — see {@link writeJson} for why the second write was fatal.
 * @param res - Node response face.
 * @param run - the route's async body.
 */
function serveSafely(res, run) {
  return Promise.resolve().then(run).catch(function (error) {
    if (res.headersSent === true || res.writableEnded === true) {
      if (typeof res.destroy === 'function') res.destroy()
      return
    }
    try {
      writeTailError(res, error)
    } catch {
      if (typeof res.destroy === 'function') res.destroy()
    }
  })
}

/**
 * The session's working directory, from the live session header first and the
 * caller-supplied absolute cwd second — the same order the sidebar's own
 * `sessionCwdOf` uses (the header is authoritative once the session hydrates;
 * `cwd` covers a request that arrives while it is still hydrating).
 * @param ctx - Host context carrying `sessions`.
 * @param sessionId - owning Session identity.
 * @param clientCwd - optional absolute cwd from the browser.
 * @returns the absolute working directory.
 */
function resolveCwd(ctx, sessionId, clientCwd) {
  const session = ctx.sessions?.get?.(sessionId)
  const headerCwd = session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (typeof clientCwd === 'string' && clientCwd !== '' && isAbsolute(clientCwd)) return clientCwd
  throw new TailError('bad-request', `no working directory for session "${sessionId}"`, 400)
}

/**
 * Resolve a requested path exactly like the sidebar's own `resolveTarget`:
 * relative paths join the session cwd, absolute paths stay absolute, `~`
 * expands against the home, and the result is lexically `resolve`d. With
 * `restrict` (config `restrictToCwd: true`) the result must additionally be
 * the cwd itself or a descendant of it.
 * @param cwd - absolute session working directory.
 * @param raw - requested path.
 * @param restrict - enforce containment inside `cwd`.
 * @returns the absolute path to read.
 */
export function resolvePath(cwd, raw, restrict = false) {
  const root = resolve(cwd)
  const target = resolve(root, expandHome(raw))
  if (restrict && target !== root && !target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new TailError('outside-workspace', `"${raw}" is outside the session working directory`, 403)
  }
  return target
}

/** Expand a leading `~` the way the sidebar's own resolver does (POSIX home). */
function expandHome(raw) {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return raw
}

/**
 * Read the last `bytes` bytes of one regular file as UTF-8.
 * @param path - absolute path (already containment-checked).
 * @param bytes - maximum bytes to read from the end.
 * @returns `{ content, size, elided, mtimeMs, mode }`; `elided` is how many
 *  bytes before the window were dropped.
 */
/**
 * Read a window of a log that ENDS at `before` (a byte offset), trimmed to whole
 * lines on both ends. This is what "加载更多" pages with: pass the previous
 * window's `from` and the two chunks abut exactly, with no duplicated or split line.
 * @param {string} path - the log file.
 * @param {number} bytes - window size in bytes.
 * @param {number} [before] - exclusive end offset (defaults to the file size).
 * @returns {Promise<{content: string, size: number, from: number, to: number, more: boolean, elided: number, mtimeMs: number, mode: 'tail'}>}
 */
/**
 * The line `run-with-log.sh` appends at every start:
 * `--- ris-ris-model-biz started 2026-10-20T20:47:40+08:00 ---`.
 * Kept in sync with `bin/run-with-log.sh` / `run-with-log.ps1`.
 */
export const START_MARKER_RE = /^--- .*? started .*? ---\r?$/gm

/**
 * Byte offset of the LAST start marker in a raw window (0 when the window starts
 * at it, -1 when there is none). Scanning bytes as latin1 is 1:1 with byte
 * offsets, so the result can slice the Buffer directly.
 * @param {Buffer} buffer - raw window bytes.
 * @returns {number} offset of the marker line, or -1.
 */
export function lastStartMarkerOffset(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return -1
  const text = buffer.toString('latin1')
  START_MARKER_RE.lastIndex = 0
  let match
  let offset = -1
  while ((match = START_MARKER_RE.exec(text)) !== null) {
    offset = match.index
    // `exec` with a zero-length match would loop; the pattern is never empty.
    if (match.index === START_MARKER_RE.lastIndex) START_MARKER_RE.lastIndex += 1
  }
  return offset
}

/**
 * Keep only the current run of a wrapper log: everything from the last
 * `--- ... started ... ---` line on. Logs without that marker are returned
 * unchanged (application-owned logs).
 * @param {string} content - decoded log text.
 * @returns {string} the text after the last start marker (marker included).
 */
export function trimToCurrentRun(content) {
  if (typeof content !== 'string' || content === '') return content
  START_MARKER_RE.lastIndex = 0
  let match
  let offset = -1
  while ((match = START_MARKER_RE.exec(content)) !== null) {
    offset = match.index
    if (match.index === START_MARKER_RE.lastIndex) START_MARKER_RE.lastIndex += 1
  }
  return offset > 0 ? content.slice(offset) : content
}

export async function readTailWindow(path, bytes, before) {
  const info = await stat(path).catch((error) => {
    throw new TailError('not-found', `cannot read "${path}": ${describe(error)}`, 404)
  })
  if (!info.isFile()) throw new TailError('not-a-file', `"${path}" is not a regular file`, 400)
  const size = info.size
  const paging = Number.isFinite(before) && before > 0
  const limit = paging ? Math.min(size, Math.floor(before)) : size
  const start = Math.max(0, limit - bytes)
  const handle = await open(path, 'r').catch((error) => {
    throw new TailError('not-found', `cannot read "${path}": ${describe(error)}`, 404)
  })
  try {
    const buffer = Buffer.alloc(Math.max(0, limit - start))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let slice = buffer.subarray(0, bytesRead)
    let from = start
    let to = start + bytesRead
    if (!paging) {
      // Show only THIS run: a reused log name appends a start marker per start,
      // and the older run would otherwise be mixed into the live view.
      const markerOffset = lastStartMarkerOffset(slice)
      if (markerOffset > 0) {
        slice = slice.subarray(markerOffset)
        from += markerOffset
      }
    }
    if (from > 0) {
      // Drop UTF-8 continuation bytes so the first character decodes whole.
      let skip = 0
      while (skip < 3 && skip < slice.length && (slice[skip] & 0xc0) === 0x80) skip += 1
      slice = slice.subarray(skip)
      from += skip
    }
    let decoded = slice.toString('utf8')
    if (from > 0) {
      // …then drop the partial first line, if there is one to drop.
      const newline = decoded.indexOf('\n')
      if (newline !== -1) {
        const dropped = decoded.slice(0, newline + 1)
        decoded = decoded.slice(newline + 1)
        from += Buffer.byteLength(dropped, 'utf8')
      }
    }
    if (to < size) {
      // The window ends mid-file: cut at the last complete line so the newer
      // chunk (which follows) starts exactly at a line start.
      const cut = decoded.lastIndexOf('\n')
      if (cut !== -1) {
        decoded = decoded.slice(0, cut + 1)
        to = from + Buffer.byteLength(decoded, 'utf8')
      }
    }
    return { content: decoded, size, from, to, more: from > 0, elided: from, mtimeMs: info.mtimeMs, mode: 'tail' }
  } finally {
    await handle.close()
  }
}

/** The newest window of a log (kept as the original entry point). */
export async function readTail(path, bytes) {
  return readTailWindow(path, bytes)
}

/**
 * Loopback-only admission: the Host authority must be a loopback name, and an
 * Origin, when present, must be that same authority. Loopback is the whole
 * rule — this route is for the GUI served on this machine, not for LAN access.
 * @param req - Node request face.
 * @returns whether the request may be served.
 */
export function isLoopbackRequest(req) {
  const headers = req?.headers ?? {}
  const host = header(headers, 'host')
  if (typeof host !== 'string' || host === '') return false
  if (!isLoopbackAuthority(host)) return false
  const origin = header(headers, 'origin')
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Header values arrive as string | string[] | undefined. */
function header(headers, key) {
  const value = headers[key]
  return Array.isArray(value) ? value[0] : value
}

/** Whether one `host[:port]` authority names a loopback interface. */
function isLoopbackAuthority(authority) {
  return isLoopbackHostname(hostnameOf(authority))
}

/** Strip the port (and IPv6 brackets) from an authority. */
function hostnameOf(authority) {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? '' : authority.slice(1, end).toLowerCase()
  }
  const colon = authority.lastIndexOf(':')
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase()
}

/** `localhost`, `::1`, or any `127.x.x.x`. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  return match !== null && [1, 2, 3].every(index => Number(match[index]) <= 255)
}

/**
 * Parse one byte-count parameter (string from a URL, number from config).
 * @param raw - the raw value; anything unusable takes the fallback.
 * @param fallback - value for a missing or non-numeric input.
 * @param ceiling - upper clamp.
 * @returns an integer between {@link MIN_BYTES} and `ceiling`.
 */
export function clampBytes(raw, fallback, ceiling = HARD_MAX_BYTES) {
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return Math.min(Math.max(fallback, MIN_BYTES), ceiling)
  return Math.min(Math.max(Math.floor(value), MIN_BYTES), ceiling)
}

/** One short message from an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

// ── Program discovery + start ───────────────────────────────────────────────
//
// The "本地实例" panel is a launcher, not just a log list: it scans the session
// workspace for runnable programs and starts/stops them without a model turn.
//
// What counts as a program:
// - Spring Boot: a `*.java` under `src/main/java/` containing
//   `@SpringBootApplication`; the main class comes from its package + class, and
//   the module dir is the nearest ancestor with a `pom.xml`. Run arguments come
//   from `.vscode/launch.json` when a configuration's `cwd` resolves to that
//   module, otherwise from the recipe AGENTS.md documents (plus
//   `--spring.profiles.active=dev` and `local.yml` when it exists).
// - Frontend: a `package.json` (outside node_modules) with a `dev`/`start`/
//   `serve` script; the package manager is inferred from the nearest lockfile.
//
// Start is the only path that spawns anything, and the browser never sends a
// command: it sends a PROGRAM ID that must still be found by a fresh scan, so
// the composed command always comes from repository content. What is spawned is
// `run-with-log.sh`, which is exactly what makes 停止 and the `.log` viewer work
// (pidfile + tee).

/**
 * One request: scan the workspace for runnable programs and report their
 * running state. `dir` is the logs directory (default `<cwd>/logs`), fenced
 * with the strict path rule so this cannot become a generic directory lister.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face (GET).
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function servePrograms(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const rawDir = url.searchParams.get('dir')
    const logsDir = resolvePath(cwd, typeof rawDir === 'string' && rawDir !== '' ? rawDir : 'logs', true)
    const force = url.searchParams.get('refresh') === '1'
    writeJson(res, 200, await programsPayload(cwd, logsDir, force))
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * The console's program list. Extracted so `/programs` (one-shot) and `/stream`
 * (pushed) answer from the very same code.
 * @param cwd - session working directory.
 * @param logsDir - absolute logs directory.
 * @param force - bypass the config fast path and rescan.
 * @returns the JSON payload served by `GET /programs`.
 */
async function programsPayload(cwd, logsDir, force) {
  {
    let config = await readProgramConfig(cwd)
    // Panel-open policy: no config ⇒ scan + write one; config exists ⇒ verify it
    // against the filesystem (no tree walk) and scan+update only when it drifted;
    // config matches ⇒ serve the programs FROM the config, no scan at all.
    let status = 'matched'
    if (!config.exists) {
      await writeProgramConfig(cwd, logsDir, undefined, true)
      config = await readProgramConfig(cwd)
      status = 'generated'
    } else if (!force && !configMatchesWorkspace(cwd, config.entries)) {
      await writeProgramConfig(cwd, logsDir, 'update', true)
      config = await readProgramConfig(cwd)
      status = 'updated'
    }
    let programs
    if (status === 'matched' && !force) {
      // The config IS the program list: no tree walk at all.
      programs = await decoratePrograms(cwd, logsDir, programsFromConfigEntries(cwd, config.entries, config.defaults))
    } else {
      programs = await scanPrograms(cwd, logsDir, true)
    }
    // A forced rescan also reconciles: report drift, and update the file when the
    // scan found programs the config does not know about (or entries gone stale).
    let drift
    if (status !== 'matched' || force) {
      const discovered = await discoverPrograms(cwd)
      drift = detectConfigDrift(discovered, config.entries, cwd)
      if (drift.stale) {
        await writeProgramConfig(cwd, logsDir, 'update')
        config = await readProgramConfig(cwd)
        status = 'updated'
        // Keep the report so the caller can say WHAT was reconciled.
        drift = Object.assign({}, drift, { reconciled: true })
      }
    }
    if (force && status === 'matched') status = 'scanned'
    return {
      ok: true,
      root: cwd,
      dir: logsDir,
      scannedAt: Date.now(),
      programs,
      config: {
        path: config.path,
        exists: config.exists,
        error: config.error,
        count: config.entries.length,
        status,
        drift,
      },
    }
  }
}

/**
 * The standalone window's HTML (`GET /window`).
 *
 * A page of its own, NOT a DSH route: it boots nothing but this plugin's browser
 * half (see {@link serveWindowAsset}) so a window can stay open all day without
 * carrying the session, the conversation or any other plugin's bundle. It reads
 * `sessionId` / `cwd` / `programId` from its own query string and passes them to
 * `mountStandalone`; the host routes only need the cwd, so the window keeps
 * working after the session that opened it is gone.
 */
async function serveWindowPage(req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    await serveOwnFile(res, 'standalone/window.html', 'text/html; charset=utf-8')
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * One file shipped beside this module (`GET /window/app.js` → `client.js`).
 * The standalone page loads the SAME hand-written browser half the DSH page
 * loads, so the window never drifts from the sidebar panel.
 */
async function serveWindowAsset(req, res, relative, contentType) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    await serveOwnFile(res, relative, contentType)
  } catch (error) {
    writeTailError(res, error)
  }
}

/** The two vendored React UMD files the standalone page boots with. */
async function serveWindowVendor(req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const pathname = requestPathname(req)
    const name = pathname.startsWith(WINDOW_VENDOR_PREFIX) ? pathname.slice(WINDOW_VENDOR_PREFIX.length) : ''
    const relative = WINDOW_VENDOR_FILES[name]
    if (relative === undefined) throw new TailError('not-found', `unknown vendor asset "${name}"`, 404)
    await serveOwnFile(res, relative, 'text/javascript; charset=utf-8')
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Read one shipped file (relative to this module) and answer it as a static
 * response. `no-cache` on purpose: a rebuilt snapshot must be picked up by a
 * window refresh alone, exactly like the lazily-built editor chunk.
 */
async function serveOwnFile(res, relative, contentType) {
  const path = fileURLToPath(new URL(`./${relative}`, import.meta.url))
  const body = await readFile(path).catch((error) => {
    throw new TailError('not-found', `"${relative}" is not shipped: ${describe(error)}`, 404)
  })
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Serve one lazily-built client chunk (`GET /bundle?name=codemirror`).
 *
 * The core client is a hand-written single file; heavy editor code lives in its
 * own bundle and is fetched on first use, which keeps the panel light for users
 * who never open a file.
 */
async function serveBundle(req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const name = url.searchParams.get('name') ?? ''
    const file = CLIENT_CHUNKS[name]
    if (file === undefined) throw new TailError('not-found', `unknown chunk "${name}"`, 404)
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url))
    const body = await readFile(path).catch((error) => {
      throw new TailError('not-found', `chunk "${name}" is not built: ${describe(error)}`, 404)
    })
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-cache',
    })
    res.end(body)
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * File-tree mutations: mkdir / create / copy / move / remove.
 *
 * Every route takes the same session scope as the read routes, resolves the path
 * with the same rule, and refuses to touch the session's workspace ROOT. Copy and
 * move take an existing destination DIRECTORY and keep the basename; a name
 * collision is a 409 rather than an implicit overwrite (a tree action must never
 * destroy a file the user did not name).
 */
async function serveFsOp(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const root = resolve(cwd)
    const restrict = options?.restrictToCwd === true
    /** Resolve one body path, requiring it to be present. */
    const one = (raw, label) => {
      if (typeof raw !== 'string' || raw === '') throw new TailError('bad-request', `${label} is required`, 400)
      return resolvePath(cwd, raw, restrict)
    }
    /** The workspace root itself is never a legal target for a mutation. */
    const notRoot = (target, action) => {
      if (target === root) throw new TailError('bad-request', `不能对工作区根目录执行${action}`, 409)
    }
    const exists = async (target) => stat(target).then(() => true).catch(() => false)

    if (url.pathname === FS_MKDIR_PATH) {
      const target = one(body.path, 'path')
      notRoot(target, '新建文件夹')
      await mkdir(target, { recursive: true })
      writeJson(res, 200, { ok: true, path: target, created: true })
      return
    }
    if (url.pathname === FS_CREATE_PATH) {
      const target = one(body.path, 'path')
      notRoot(target, '新建文件')
      if (await exists(target)) throw new TailError('exists', `「${basename(target)}」已存在`, 409)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, typeof body.content === 'string' ? body.content : '', { flag: 'wx' })
      writeJson(res, 200, { ok: true, path: target, created: true })
      return
    }
    if (url.pathname === FS_COPY_PATH || url.pathname === FS_MOVE_PATH) {
      const from = one(body.from, 'from')
      notRoot(from, '复制或移动')
      const toDir = one(body.toDir !== undefined ? body.toDir : body.to, 'toDir')
      const requested = typeof body.name === 'string' ? body.name.trim() : ''
      if (requested.includes('/') || requested.includes('\\') || requested === '.' || requested === '..') {
        throw new TailError('bad-request', '非法的目标文件名', 400)
      }
      const target = join(toDir, requested === '' ? basename(from) : requested)
      if (target === from) throw new TailError('bad-request', '目标与源相同', 409)
      if (target.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)) {
        throw new TailError('bad-request', '不能把目录复制/移动到它自己内部', 409)
      }
      const overwrite = body.overwrite === true
      if (await exists(target)) {
        if (!overwrite) throw new TailError('exists', `目标位置已有「${basename(target)}」`, 409)
        // The user explicitly chose 覆盖 in the conflict dialog: the old entry is
        // gone afterwards (the dialog says so), so remove it before the operation
        // rather than letting `cp`/`rename` fail on it.
        await rm(target, { recursive: true, force: false })
      }
      await mkdir(dirname(target), { recursive: true })
      if (url.pathname === FS_COPY_PATH) {
        // Node's cp keeps the tree shape and refuses to merge into anything.
        await cp(from, target, { recursive: true, errorOnExist: true, force: false })
      } else {
        await rename(from, target)
      }
      writeJson(res, 200, { ok: true, path: target, from, [url.pathname === FS_COPY_PATH ? 'copied' : 'moved']: true })
      return
    }
    if (url.pathname === FS_REMOVE_PATH) {
      const target = one(body.path, 'path')
      notRoot(target, '删除')
      const info = await stat(target).catch(() => undefined)
      if (info === undefined) throw new TailError('not-found', `「${basename(target)}」不存在`, 404)
      const recursive = body.recursive === true
      if (info.isDirectory() && !recursive) {
        const children = await readdir(target).catch(() => [])
        if (children.length > 0) throw new TailError('not-empty', '目录不为空：请确认递归删除', 409)
      }
      await rm(target, { recursive, force: false })
      writeJson(res, 200, { ok: true, path: target, removed: true })
      return
    }
    throw new TailError('not-found', `unknown route ${url.pathname}`, 404)
  } catch (error) {
    writeTailError(res, error)
  }
}

/** Text files bigger than this are refused by the read route (matches the old sidebar). */
const FS_MAX_TEXT_BYTES = 512 * 1024

/** One sanitized leaf name for an import target (never a path). */
function importEntryName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TailError('bad-request', '非法的文件名', 400)
  }
  return name
}

/** Whether `target` exists (any type). */
async function pathExists(target) {
  return stat(target).then(() => true).catch(() => false)
}

/**
 * Pasting something the tree did not copy itself (`/fs/import`, `/fs/upload`).
 *
 * A file copied in the OS file manager is NOT a workspace-relative path the
 * ordinary `/fs/copy` route could take: the page only knows a `file://` URL (or
 * a text path), and at most a `File` blob. These two routes close that gap:
 *
 * - `POST /fs/import` `{sessionId, cwd?, from, dir, name?, overwrite?}` — copy
 *   an absolute local path (file or directory) INTO a tree directory.
 * - `POST /fs/upload?sessionId&cwd&dir&name&overwrite=1` — the raw bytes of a
 *   pasted/dropped `File`; streamed to disk with a hard size cap.
 *
 * Both are loopback-fenced, take a leaf-only `name`, and refuse to overwrite
 * unless the caller explicitly chose 覆盖 in the conflict dialog.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` from the plugin config.
 */
async function serveFsImport(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname === FS_UPLOAD_PATH) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
      const name = importEntryName(url.searchParams.get('name') ?? '')
      const dir = resolvePath(cwd, url.searchParams.get('dir') ?? '', options?.restrictToCwd === true)
      const info = await stat(dir).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) throw new TailError('bad-request', '粘贴目标不是目录', 400)
      const target = join(dir, name)
      const overwrite = url.searchParams.get('overwrite') === '1'
      if (!overwrite && await pathExists(target)) throw new TailError('exists', `「${name}」已存在`, 409)
      let written = 0
      const gate = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length
          if (written > FS_UPLOAD_MAX_BYTES) {
            callback(new TailError('too-large', `文件超过 ${Math.floor(FS_UPLOAD_MAX_BYTES / (1024 * 1024))}MB 上限`, 413))
            return
          }
          callback(null, chunk)
        },
      })
      try {
        // Stream: a 100 MB upload must not be buffered in memory just to be written.
        await pipeline(req, gate, createWriteStream(target, { flags: overwrite ? 'w' : 'wx' }))
      } catch (error) {
        await rm(target, { force: true }).catch(() => {})
        throw error
      }
      writeJson(res, 200, { ok: true, path: target, name, bytes: written })
      return
    }
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const restrict = options?.restrictToCwd === true
    const rawFrom = typeof body.from === 'string' ? body.from.trim() : ''
    if (rawFrom === '') throw new TailError('bad-request', 'from is required', 400)
    // `from` is deliberately allowed OUTSIDE the workspace (that is the whole
    // point: a file the user copied from their file manager); `restrictToCwd`
    // still governs the DESTINATION directory.
    const source = isAbsolute(rawFrom) ? resolve(rawFrom) : resolvePath(cwd, rawFrom, restrict)
    const sourceInfo = await stat(source).catch(() => undefined)
    if (sourceInfo === undefined) throw new TailError('not-found', `找不到「${rawFrom}」`, 404)
    const dir = resolvePath(cwd, typeof body.dir === 'string' ? body.dir : '', restrict)
    const dirInfo = await stat(dir).catch(() => undefined)
    if (dirInfo === undefined || !dirInfo.isDirectory()) throw new TailError('bad-request', '粘贴目标不是目录', 400)
    const name = importEntryName(typeof body.name === 'string' && body.name.trim() !== '' ? body.name : basename(source))
    const target = join(dir, name)
    if (target === source || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) {
      throw new TailError('bad-request', '不能把目录导入到它自己内部', 409)
    }
    const overwrite = body.overwrite === true
    if (await pathExists(target)) {
      if (!overwrite) throw new TailError('exists', `「${name}」已存在`, 409)
      await rm(target, { recursive: true, force: false })
    }
    if (sourceInfo.isDirectory()) await cp(source, target, { recursive: true })
    else await copyFile(source, target)
    writeJson(res, 200, { ok: true, path: target, name })
  } catch (error) {
    writeTailError(res, error)
  }
}

/** Content types the media route can serve inline (`<img>`, `<iframe>`). */
const FS_MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  svg: 'image/svg+xml', pdf: 'application/pdf',
}

/** Whether a buffer looks binary: a NUL byte in the sample is decisive enough. */
function looksBinary(buffer) {
  const end = Math.min(buffer.length, 8192)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * Length of `buffer` up to its last COMPLETE UTF-8 character.
 *
 * A window read can land in the middle of a multi-byte character. Decoding such
 * a tail would produce U+FFFD, and the byte for byte continuation would then
 * duplicate the replacement char; trimming the tail instead lets the next window
 * start exactly at that character's first byte.
 * @param {Buffer} buffer - raw window bytes.
 * @returns {number} bytes that form complete characters (0 when the window is
 *   shorter than one character).
 */
export function utf8CompleteLength(buffer) {
  let cut = buffer.length
  if (cut === 0) return 0
  let need = 0
  let index = cut - 1
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
    need += 1
    index -= 1
  }
  if (index < 0) return cut
  const lead = buffer[index]
  let total = 1
  if ((lead & 0x80) === 0x00) total = 1
  else if ((lead & 0xe0) === 0xc0) total = 2
  else if ((lead & 0xf0) === 0xe0) total = 3
  else if ((lead & 0xf8) === 0xf0) total = 4
  const present = need + 1
  if (present >= total) return cut
  return index
}

/**
 * Answer one page of a large text file for the read-only preview.
 * `next` is the offset the caller should ask for next; `eof` says the file ended
 * inside this window. The first window also sniffs for NUL bytes so a binary
 * file is rejected instead of previewed as mojibake.
 * @param {import('node:http').ServerResponse} res - response to write JSON to.
 * @param {string} target - absolute file path (already validated).
 * @param {{size:number, mtimeMs:number}} info - its stat.
 * @param {URL} url - request URL (reads `offset` and `length`).
 */
async function serveTextWindow(res, target, info, url) {
  const requestedOffset = Number(url.searchParams.get('offset'))
  const requestedLength = Number(url.searchParams.get('length'))
  const from = Math.max(0, Math.min(Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0, info.size))
  const want = Math.max(1, Math.min(Number.isFinite(requestedLength) && requestedLength > 0 ? Math.floor(requestedLength) : FS_WINDOW_BYTES, FS_WINDOW_MAX_BYTES))
  if (from >= info.size) {
    writeJson(res, 200, { ok: true, kind: 'text-window', offset: from, next: info.size, eof: true, size: info.size, mtimeMs: info.mtimeMs, text: '' })
    return
  }
  const handle = await open(target, 'r')
  let chunk
  try {
    const buffer = Buffer.allocUnsafe(Math.min(want, info.size - from))
    const result = await handle.read(buffer, 0, buffer.length, from)
    chunk = buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close().catch(() => {})
  }
  if (from === 0 && looksBinary(chunk)) {
    writeJson(res, 200, { ok: true, kind: 'binary', size: info.size, mtimeMs: info.mtimeMs, message: '这是二进制文件，不支持预览' })
    return
  }
  let complete = utf8CompleteLength(chunk)
  // A window smaller than a single character (or a malformed lead) must still
  // make progress, or the caller would ask for the same offset forever.
  if (complete === 0) complete = Math.min(chunk.length, 4)
  const text = chunk.subarray(0, complete).toString('utf8')
  const next = from + complete
  writeJson(res, 200, { ok: true, kind: 'text-window', offset: from, next, eof: next >= info.size, size: info.size, mtimeMs: info.mtimeMs, text })
}

/**
 * The IDE's own workspace file API — no `dsh-better-sidebar` involved.
 *
 * - `GET  /fs/read?sessionId&path`  → `{ok, kind:'text', content, size, mtimeMs}`,
 *   or `{ok:true, kind:'binary'|'too-large', size, message}` (the caller decides
 *   how to render those).
 * - `POST /fs/write` `{sessionId, path, cwd?, content}` → `{ok, mtimeMs}`.
 * - `GET  /fs/file?sessionId&path`  → raw bytes with the media content-type.
 *
 * All three are loopback-fenced and resolve the path exactly like `/tail` does.
 */
async function serveFs(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname
    if (pathname === FS_WRITE_PATH) {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const raw = typeof body.path === 'string' ? body.path : ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      if (raw === '') throw new TailError('bad-request', 'path is required', 400)
      if (typeof body.content !== 'string') throw new TailError('bad-request', 'content must be a string', 400)
      const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
      const target = resolvePath(cwd, raw, options?.restrictToCwd === true)
      const info = await stat(target).catch(() => undefined)
      if (info !== undefined && !info.isFile()) throw new TailError('not-a-file', `"${target}" is not a regular file`, 400)
      await writeFile(target, body.content, 'utf8')
      const after = await stat(target).catch(() => undefined)
      writeJson(res, 200, { ok: true, path: target, mtimeMs: after === undefined ? undefined : after.mtimeMs })
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const raw = url.searchParams.get('path') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    if (raw === '') throw new TailError('bad-request', 'path is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const target = resolvePath(cwd, raw, options?.restrictToCwd === true)
    const info = await stat(target).catch((error) => {
      throw new TailError('not-found', `cannot read "${target}": ${describe(error)}`, 404)
    })
    if (!info.isFile()) throw new TailError('not-a-file', `"${target}" is not a regular file`, 400)
    if (pathname === FS_WINDOW_PATH) {
      await serveTextWindow(res, target, info, url)
      return
    }
    if (pathname === FS_FILE_PATH) {
      const extension = extname(target).replace(/^\./, '').toLowerCase()
      const type = FS_MEDIA_TYPES[extension] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(info.size),
        'cache-control': 'no-store',
        'content-disposition': 'inline',
        // An SVG can carry script: keep it in a sandboxed, script-less frame.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      })
      await pipeline(createReadStream(target), res)
      return
    }
    if (info.size > FS_MAX_TEXT_BYTES) {
      writeJson(res, 200, { ok: true, kind: 'too-large', size: info.size, mtimeMs: info.mtimeMs, message: '文件过大，不支持预览' })
      return
    }
    const buffer = await readFile(target)
    if (looksBinary(buffer)) {
      writeJson(res, 200, { ok: true, kind: 'binary', size: info.size, mtimeMs: info.mtimeMs, message: '这是二进制文件，不支持预览' })
      return
    }
    writeJson(res, 200, {
      ok: true,
      kind: 'text',
      content: buffer.toString('utf8'),
      size: info.size,
      mtimeMs: info.mtimeMs,
    })
  } catch (error) {
    if (res.headersSent === true || res.writableEnded === true) {
      if (typeof res.destroy === 'function') res.destroy()
      return
    }
    writeTailError(res, error)
  }
}

/** Streaming cadence: a log push every 400 ms, the console rows every 2.5 s. */
const TAIL_STREAM_MS = 400
/** Un-drained response bytes above which an SSE frame is dropped (1 MiB). */
export const SSE_MAX_BUFFER_BYTES = 1024 * 1024

/**
 * Whether a stream frame should be dropped because the socket is backed up.
 * @param {number|undefined} writableLength - `res.writableLength`.
 * @returns {boolean} true when the client cannot keep up right now.
 */
export function shouldDropSseFrame(writableLength) {
  return Number.isFinite(writableLength) && writableLength > SSE_MAX_BUFFER_BYTES
}

/** Coalesce bursts of filesystem events into one tree frame (resource guard). */
const TREE_DEBOUNCE_MS = 800

const PROGRAMS_STREAM_MS = 2500
/** Debug events (in-process reads, so this can be quick), sessions, open requests. */
const DEBUG_STREAM_MS = 600
const DEBUGS_STREAM_MS = 1200
const OPENS_STREAM_MS = 1500

/** Read `[start, end)` of a file as UTF-8 text, clamped to 512 KiB. */
async function readFileRange(path, start, end) {
  const length = Math.max(0, Math.min(end - start, HARD_MAX_BYTES))
  if (length === 0) return ''
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Server-sent events for what the panel otherwise polls.
 *
 * `GET /stream?sessionId&cwd&topics=programs,tail&tail=<path>&bytes=N&dir=logs`
 * One response that stays open: `event: programs` carries the console payload,
 * `event: tail` / `event: append` / `event: service` carry one log file as it
 * grows, `: ping` comments keep proxies quiet. EventSource reconnects by itself,
 * so a restart of `dsh web` self-heals; the JSON routes remain as fallbacks.
 */
async function serveStream(ctx, req, res, options) {
  let url
  try {
    url = new URL(req.url ?? '/', 'http://dsh.internal')
  } catch {
    writeJson(res, 400, { ok: false, code: 'bad-request', message: 'bad url' })
    return
  }
  const topics = String(url.searchParams.get('topics') ?? 'programs,tail')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean)
  const rawTail = url.searchParams.get('tail') ?? ''
  const rawDebugPath = url.searchParams.get('path') ?? ''
  const bytes = clampBytes(url.searchParams.get('bytes'), DEFAULT_BYTES, HARD_MAX_BYTES)
  // Only the workspace topics need a cwd; `debugs` and `opens` are global.
  const needsCwd = topics.includes('programs') || topics.includes('tail') || topics.includes('debug') || topics.includes('tree')
  let cwd
  let logsDir
  if (needsCwd) {
    try {
      if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
      const rawDir = url.searchParams.get('dir')
      logsDir = resolvePath(cwd, typeof rawDir === 'string' && rawDir !== '' ? rawDir : 'logs', true)
    } catch (error) {
      writeTailError(res, error)
      return
    }
  } else if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, code: 'forbidden', message: 'this route answers loopback requests only' })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  let closed = false
  const cleanups = []
  const send = (event, payload) => {
    if (closed) return false
    // Backpressure: a browser tab that is throttled (background/minimized) must
    // not make the host buffer log frames without bound. A dropped frame is NOT
    // recovered by the next tick — the tail tick only reads from `previousSize`
    // onwards — so the caller below re-snapshots instead of leaving a gap.
    if (shouldDropSseFrame(res.writableLength)) return false
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      closed = true
      return false
    }
  }
  send('hello', { ok: true, version: PKG_VERSION, root: cwd, topics })

  const heartbeat = setInterval(() => {
    if (closed) return
    try {
      res.write(': ping\n\n')
    } catch {
      closed = true
    }
  }, 15000)
  heartbeat.unref?.()

  res.on('error', () => {
    // An aborted SSE connection emits 'error'; without a listener Node would
    // treat it as an uncaught exception.
    closed = true
  })
  res.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // teardown must never throw from an event handler
      }
    }
    try {
      res.end()
    } catch {
      // already gone
    }
  })

  if (topics.includes('programs')) {
    let busy = false
    const push = async (force) => {
      if (closed || busy) return
      busy = true
      try {
        send('programs', await programsPayload(cwd, logsDir, force === true))
      } catch (error) {
        send('stream-error', { ok: false, error: describe(error) })
      } finally {
        busy = false
      }
    }
    void push(false)
    const timer = setInterval(() => { void push(false) }, PROGRAMS_STREAM_MS)
    timer.unref?.()
    cleanups.push(() => clearInterval(timer))
  }

  if (topics.includes('debugs')) {
    const pushDebugs = () => {
      try {
        send('debugs', { ok: true, sessions: toJsonSafe(debugSessions.listSessions()) })
      } catch (error) {
        send('stream-error', { ok: false, error: describe(error) })
      }
    }
    pushDebugs()
    const timer = setInterval(pushDebugs, DEBUGS_STREAM_MS)
    timer.unref?.()
    cleanups.push(() => clearInterval(timer))
  }

  if (topics.includes('opens')) {
    const pushOpens = () => {
      try {
        send('opens', { ok: true, opens: takePendingOpens() })
      } catch (error) {
        send('stream-error', { ok: false, error: describe(error) })
      }
    }
    pushOpens()
    const timer = setInterval(pushOpens, OPENS_STREAM_MS)
    timer.unref?.()
    cleanups.push(() => clearInterval(timer))
  }

  if (topics.includes('tree')) {
    // Subscribe to the per-open-directory watchers (never a recursive root watch:
    // that costs seconds of blocked event loop on this sized workspace). Frames are
    // debounced, then filtered through the tree's own visibility rules.
    const hub = treeWatchHub(cwd)
    let pending = new Set()
    let flushTimer = null
    const flush = () => {
      flushTimer = null
      if (closed || pending.size === 0) return
      const batch = Array.from(pending).slice(0, 200)
      pending = new Set()
      void treeWatchAccepts(cwd, batch).then((changed) => {
        if (closed || changed.length === 0) return
        send('tree', { ok: true, watched: hub.dirs.size > 0, changed })
      }).catch(() => {
        // Never hide a change because git hiccuped.
        send('tree', { ok: true, watched: hub.dirs.size > 0, changed: batch })
      })
    }
    const listener = (relative) => {
      if (typeof relative !== 'string' || relative === '') return
      if (isStructurallyIgnoredTreePath(relative)) return
      pending.add(relative)
      if (flushTimer !== null) return
      flushTimer = setTimeout(flush, TREE_DEBOUNCE_MS)
      flushTimer.unref?.()
    }
    hub.listeners.add(listener)
    // The workspace root is always open (it is the tree's first level).
    noteTreeDirOpen(cwd, cwd)
    // Warm the root repo's visible-path set in the background: the first expansion
    // then does not pay for `git ls-files` while the user waits.
    void repoAllowedPaths(cwd).catch(() => {})
    cleanups.push(() => {
      if (flushTimer !== null) clearTimeout(flushTimer)
      hub.listeners.delete(listener)
      if (hub.listeners.size === 0) {
        for (const dir of Array.from(hub.dirs.keys())) closeTreeWatchDir(hub, dir)
        TREE_WATCH_HUB.delete(cwd)
      }
    })
  }

  if (topics.includes('debug') && rawDebugPath !== '') {
    // The debug pane used to poll `/debug/poll` every 700 ms (5 s while detached).
    // The host keeps the `since` cursor here, so the wire only carries new events.
    let since = 0
    const tickDebug = () => {
      try {
        const payload = debugSessions.poll(debugPath, since)
        if (typeof payload.seq === 'number') since = payload.seq
        // `ok: true` matters: the client applies a frame through the same
        // `applyPollResult` as the JSON fallback and ignores anything that is not
        // a success. Without it the pane silently never updated (a reload showed
        // no breakpoint dots until some other action polled the route).
        send('debug', Object.assign({ ok: true }, payload))
      } catch (error) {
        send('debug-error', { ok: false, error: describe(error) })
      }
    }
    let debugPath
    try {
      debugPath = resolvePath(cwd, rawDebugPath, options?.restrictToCwd === true)
      tickDebug()
      const timer = setInterval(tickDebug, DEBUG_STREAM_MS)
      timer.unref?.()
      cleanups.push(() => clearInterval(timer))
    } catch (error) {
      send('debug-error', { ok: false, error: describe(error) })
    }
  }

  if (topics.includes('tail') && rawTail !== '') {
    let target
    try {
      target = resolvePath(cwd, rawTail, options?.restrictToCwd === true)
    } catch (error) {
      send('tail-error', { ok: false, error: describe(error) })
    }
    if (target !== undefined) {
      let previousSize = -1
      let busy = false
      const snapshot = async () => {
        const tail = await readTail(target, bytes)
        const service = await readService(target)
        previousSize = tail.size
        send('tail', Object.assign({ ok: true, path: target }, tail, service === undefined ? {} : { service }))
      }
      const tick = async () => {
        if (closed || busy) return
        busy = true
        try {
          const info = await stat(target)
          if (!info.isFile()) throw new TailError('not-a-file', `"${target}" is not a regular file`, 400)
          if (previousSize < 0 || info.size < previousSize) {
            // First read, or the file was rotated/truncated: resend the window.
            await snapshot()
            return
          }
          if (info.size === previousSize) return
          if (info.size - previousSize > HARD_MAX_BYTES) {
            await snapshot()
            return
          }
          const text = await readFileRange(target, previousSize, info.size)
          previousSize = info.size
          // A new `--- started ---` marker means the service was restarted: the
          // panel must show this run only, so resend the (trimmed) window.
          if (/--- .*? started .*? ---/.test(text)) {
            await snapshot()
            return
          }
          if (text !== '' && send('append', { ok: true, text }) === false) {
            // The delta was dropped: resend the whole window so the pane cannot
            // stay frozen behind a permanent gap.
            await snapshot()
            return
          }
          const service = await readService(target)
          send('service', service === undefined ? { serviceKnown: true } : { service, serviceKnown: true })
        } catch (error) {
          send('tail-error', { ok: false, error: describe(error) })
        } finally {
          busy = false
        }
      }
      void snapshot().catch((error) => send('tail-error', { ok: false, error: describe(error) }))
      const timer = setInterval(() => { void tick() }, TAIL_STREAM_MS)
      timer.unref?.()
      cleanups.push(() => clearInterval(timer))
    }
  }
}

/**
 * The debug routes: `/debug/<action>`, sharing one JDWP session registry.
 *
 * `POST`: start / stop / breakpoints / step / resume / pause.
 * `GET`:  status / poll / breakpoints / threads / stack / variables.
 *
 * All of them keep the same fences as the rest of the plugin (loopback only,
 * session-scoped cwd) and never accept a host/port from the caller: a session
 * can only be addressed through its program's log path, and the JDWP listener
 * is always 127.0.0.1.
 */
/** Cached zip central directories keyed by jar path + mtime. */
const ZIP_DIRECTORY_CACHE = new Map()

/**
 * Read one jar's central directory (name, compression method, sizes, offsets).
 * Reading ONLY the central directory keeps classpath probing cheap: the actual
 * entry bytes are pulled lazily by {@link readZipEntry}.
 * @param {string} file - absolute jar path.
 * @returns {Promise<object[]>} zip entries, empty when the file is not a zip.
 */
export async function readZipEntries(file) {
  let info
  try {
    info = await stat(file)
  } catch {
    return []
  }
  const key = `${file}\u0000${info.size}\u0000${info.mtimeMs}`
  const cached = ZIP_DIRECTORY_CACHE.get(key)
  if (cached !== undefined) return cached
  const handle = await open(file, 'r')
  const entries = []
  try {
    const tailSize = Math.min(Number(info.size), 65557)
    if (tailSize < 22) return []
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, Number(info.size) - tailSize)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) {
        eocd = index
        break
      }
    }
    if (eocd === -1) return []
    const count = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (directorySize === 0 || directorySize > 32 * 1024 * 1024) return []
    const directory = Buffer.alloc(directorySize)
    await handle.read(directory, 0, directorySize, directoryOffset)
    let offset = 0
    for (let index = 0; index < count && offset + 46 <= directory.length; index += 1) {
      if (directory.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) break
      const method = directory.readUInt16LE(offset + 10)
      const crc = directory.readUInt32LE(offset + 16)
      const compressedSize = directory.readUInt32LE(offset + 20)
      const size = directory.readUInt32LE(offset + 24)
      const nameLength = directory.readUInt16LE(offset + 28)
      const extraLength = directory.readUInt16LE(offset + 30)
      const commentLength = directory.readUInt16LE(offset + 32)
      const localOffset = directory.readUInt32LE(offset + 42)
      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength)
      entries.push({ name, method, crc, compressedSize, size, localOffset })
      offset += 46 + nameLength + extraLength + commentLength
    }
  } finally {
    await handle.close()
  }
  ZIP_DIRECTORY_CACHE.set(key, entries)
  return entries
}

/**
 * Extract one zip entry's bytes (deflate or stored; the two methods jars use).
 * @param {string} file - absolute jar path.
 * @param {object} entry - one row from {@link readZipEntries}.
 * @returns {Promise<Buffer>} the entry bytes.
 */
export async function readZipEntry(file, entry) {
  if (entry.compressedSize > SOURCE_ENTRY_MAX_BYTES) throw new TailError('too-large', 'zip entry is too large', 413)
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(30)
    await handle.read(header, 0, 30, entry.localOffset)
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw new TailError('bad-jar', 'zip entry header is corrupt', 500)
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    const raw = Buffer.alloc(entry.compressedSize)
    await handle.read(raw, 0, entry.compressedSize, dataOffset)
    if (entry.method === 0) return raw
    if (entry.method === 8) return inflateRawSync(raw)
    throw new TailError('bad-jar', `unsupported zip compression method ${entry.method}`, 500)
  } finally {
    await handle.close()
  }
}

/** Classpath jars declared by one program (`target/cp.txt`), absolute + de-duplicated. */
async function programClassPathJars(programDir) {
  const file = join(programDir, 'target', 'cp.txt')
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return { file, jars: [] }
  const jars = []
  const seen = new Set()
  for (const entry of text.split(/[\r\n]+/).join(delimiter).split(delimiter)) {
    const trimmed = entry.trim()
    if (!trimmed.endsWith('.jar') || seen.has(trimmed)) continue
    seen.add(trimmed)
    jars.push(isAbsolute(trimmed) ? trimmed : resolve(programDir, trimmed))
  }
  return { file, jars }
}

/** First classpath jar that owns `className`, plus the requested entry. */
async function findClassJar(programDir, className) {
  const wanted = `${className.split('.').join('/')}.class`
  const { file, jars } = await programClassPathJars(programDir)
  for (const jar of jars) {
    const entries = await readZipEntries(jar)
    const entry = entries.find((item) => item.name === wanted)
    if (entry !== undefined) return { jar, entry, classPathFile: file }
  }
  return undefined
}

/** The sibling `-sources.jar` of a binary jar, when it exists. */
function sourcesJarOf(jar) {
  if (!jar.endsWith('.jar')) return undefined
  const candidate = jar.slice(0, -4) + '-sources.jar'
  return existsSync(candidate) ? candidate : undefined
}

/**
 * The dependency-source cache (`<cwd>/.dsh-ris-ide-cache/`) is keyed by a
 * FINGERPRINT of its inputs (jar path+size+mtime and the entry's name/size/crc,
 * plus the decompiler jar+args), not by file age: a rebuilt jar invalidates its
 * derived files immediately. `manifest.json` remembers those fingerprints, and a
 * bounded GC keeps the cache from growing without limit.
 */
const CACHE_MANIFEST_FILENAME = 'manifest.json'
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const CACHE_MAX_FILES = 2000
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const CACHE_PRUNE_INTERVAL_MS = 60 * 1000
const cachePrunedAt = new Map()

async function statOrUndefined(file) {
  try {
    return await stat(file)
  } catch {
    return undefined
  }
}

/** `path|size|mtime` — enough to notice a jar rebuilt in place. */
async function fileFingerprint(file) {
  const info = await statOrUndefined(file)
  return info === undefined ? `${file}|-` : `${file}|${info.size}|${Math.floor(info.mtimeMs)}`
}

async function readCacheManifest(root) {
  const text = await readTextIfSmall(join(root, CACHE_MANIFEST_FILENAME))
  if (text === undefined) return { version: 1, entries: {} }
  const parsed = parseJsonc(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.entries === null || typeof parsed.entries !== 'object') {
    return { version: 1, entries: {} }
  }
  return { version: 1, entries: parsed.entries }
}

/** Write the manifest atomically (temp + rename), so a crash never corrupts it. */
async function writeCacheManifest(root, manifest) {
  const target = join(root, CACHE_MANIFEST_FILENAME)
  const temp = `${target}.${process.pid}.tmp`
  await mkdir(root, { recursive: true })
  await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  await rename(temp, target)
}

async function cacheFiles(root) {
  const out = []
  async function walk(dir, depth) {
    if (depth > 4) return
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name === CACHE_MANIFEST_FILENAME) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const info = await statOrUndefined(full)
      if (info !== undefined) out.push({ path: full, rel: relative(root, full).split(sep).join('/'), size: info.size, at: info.mtimeMs })
    }
  }
  await walk(root, 0)
  return out
}

/**
 * Drop aged files first, then the least-recently-written ones until the cache
 * fits its size/file budget. Rate-limited so a burst of resolves prunes once.
 * @param {string} root - the `.dsh-ris-ide-cache` directory.
 * @param {{maxBytes?: number, maxFiles?: number, maxAgeMs?: number, force?: boolean}} [options]
 */
export async function pruneIdeCache(root, options) {
  const maxBytes = (options || {}).maxBytes === undefined ? CACHE_MAX_BYTES : options.maxBytes
  const maxFiles = (options || {}).maxFiles === undefined ? CACHE_MAX_FILES : options.maxFiles
  const maxAgeMs = (options || {}).maxAgeMs === undefined ? CACHE_MAX_AGE_MS : options.maxAgeMs
  const force = (options || {}).force === true
  const last = cachePrunedAt.get(root)
  if (!force && last !== undefined && Date.now() - last < CACHE_PRUNE_INTERVAL_MS) return
  cachePrunedAt.set(root, Date.now())
  const files = await cacheFiles(root)
  if (files.length === 0) return
  const manifest = await readCacheManifest(root)
  const now = Date.now()
  let total = files.reduce(function (sum, file) { return sum + file.size }, 0)
  const remaining = files.slice().sort(function (left, right) { return left.at - right.at })
  const removed = new Set()
  let kept = remaining.length
  for (const file of remaining) {
    const entry = manifest.entries[file.rel]
    const at = entry !== undefined && typeof entry.at === 'number' ? entry.at : file.at
    const tooOld = maxAgeMs > 0 && now - at > maxAgeMs
    const tooMany = kept > maxFiles || total > maxBytes
    if (!tooOld && !tooMany) break
    await rm(file.path, { force: true }).catch(function () {})
    total -= file.size
    kept -= 1
    removed.add(file.rel)
  }
  const present = new Set()
  for (const file of files) {
    if (!removed.has(file.rel)) present.add(file.rel)
  }
  let dirty = false
  for (const rel of Object.keys(manifest.entries)) {
    if (!present.has(rel)) {
      delete manifest.entries[rel]
      dirty = true
    }
  }
  if (dirty) await writeCacheManifest(root, manifest).catch(function () {})
}

/**
 * One fingerprint-checked cache file: reused while `key` matches and the file
 * still exists, otherwise produced and written (then the cache GC may run).
 */
async function cachedSource(cwd, kind, className, suffix, key, produce) {
  const root = join(cwd, IDE_CACHE_DIR)
  const rel = kind + '/' + className + suffix
  const target = join(root, rel)
  const manifest = await readCacheManifest(root)
  const entry = manifest.entries[rel]
  if (entry !== undefined && entry.key === key && existsSync(target)) return target
  const data = await produce()
  if (data === undefined || data === null) return undefined
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
  manifest.entries[rel] = { key: key, kind: kind, at: Date.now() }
  await writeCacheManifest(root, manifest)
  await pruneIdeCache(root).catch(function () {})
  return target
}

function entryFingerprint(entry) {
  return entry.name + '|' + entry.size + '|' + entry.crc
}

/** Spawn one command, capture stdout/stderr and its exit code (never throws on spawn failure). */
function runCapture(command, args, cwd) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    const child = spawn(command, args, { cwd: cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish({ ok: false, error: error.message, stdout, stderr }))
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))
  })
}

/** The user's decompiler choice: `.dsh-ris-ide.settings.json` first, then `.dsh-ris-ide.json`. */
async function readDecompilerConfig(cwd) {
  const settingsPath = resolve(cwd, IDE_SETTINGS_FILENAME)
  const settingsText = await readTextIfSmall(settingsPath)
  if (settingsText !== undefined) {
    const parsed = parseJsonc(settingsText)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed.decompiler
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.jar === 'string' && value.jar.trim() !== '') {
        return { jar: isAbsolute(value.jar.trim()) ? value.jar.trim() : resolve(cwd, value.jar.trim()), args: normalizeStringArray(value.args) }
      }
    }
  }
  const configText = await readTextIfSmall(resolve(cwd, CONFIG_FILENAME))
  if (configText === undefined) return undefined
  const parsed = parseJsonc(configText)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const value = parsed.decompiler
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.jar === 'string' && value.jar.trim() !== '') {
    return { jar: isAbsolute(value.jar.trim()) ? value.jar.trim() : resolve(cwd, value.jar.trim()), args: normalizeStringArray(value.args) }
  }
  if (typeof parsed.decompilerJar === 'string' && parsed.decompilerJar.trim() !== '') {
    return { jar: isAbsolute(parsed.decompilerJar.trim()) ? parsed.decompilerJar.trim() : resolve(cwd, parsed.decompilerJar.trim()), args: undefined }
  }
  return undefined
}

/** Decompile one class with the configured jar (`{classfile}` / `{class}` placeholders). */
async function decompileClass(cwd, found, className, config) {
  const jarFingerprint = await fileFingerprint(found.jar)
  const decompilerFingerprint = await fileFingerprint(config.jar)
  const args = (config.args === undefined ? ['{classfile}'] : config.args).join('\u0000')
  const key = ['decompiled', jarFingerprint, entryFingerprint(found.entry), decompilerFingerprint, args].join('|')
  return cachedSource(cwd, 'decompiled', className, '.java', key, async function () {
    const classKey = ['class', jarFingerprint, entryFingerprint(found.entry)].join('|')
    const classFile = await cachedSource(cwd, 'classes', className, '.class', classKey, function () {
      return readZipEntry(found.jar, found.entry)
    })
    if (classFile === undefined) return undefined
    const template = config.args === undefined ? ['{classfile}'] : config.args
    const expanded = template.map(function (item) {
      return String(item).split('{classfile}').join(classFile).split('{class}').join(className)
    })
    const run = await runCapture('java', ['-jar', config.jar, ...expanded], cwd)
    if (!run.ok || run.stdout.trim() === '') return undefined
    return run.stdout
  })
}

/** Last resort: `javap -p -c -l`, so a frame without sources still shows its bytecode. */
async function javapClass(cwd, found, className) {
  const key = ['javap', await fileFingerprint(found.jar), entryFingerprint(found.entry)].join('|')
  return cachedSource(cwd, 'javap', className, '.javap.txt', key, async function () {
    const run = await runCapture('javap', ['-p', '-c', '-l', '-classpath', found.jar, className], cwd)
    if (!run.ok || run.stdout.trim() === '') return undefined
    return run.stdout
  })
}

/**
 * Resolve one dependency class to a readable file: sources.jar → decompiler jar
 * → javap disassembly, all cached under the workspace.
 * @param {string} cwd - workspace root (cache location).
 * @param {string} programDir - program directory holding `target/cp.txt`.
 * @param {string} className - binary-ish class name (`cn.com.ris.Foo`, inner classes stripped by the caller).
 * @returns {Promise<{path: string, kind: string, jar: string}|undefined>} the cached file.
 */
export async function resolveDependencySource(cwd, programDir, className) {
  const found = await findClassJar(programDir, className)
  if (found === undefined) return undefined
  const sourcesJar = sourcesJarOf(found.jar)
  if (sourcesJar !== undefined) {
    const sourceName = `${className.split('.').join('/')}.java`
    const entries = await readZipEntries(sourcesJar)
    const entry = entries.find((item) => item.name === sourceName)
    if (entry !== undefined) {
      const key = ['sources', await fileFingerprint(sourcesJar), entryFingerprint(entry)].join('|')
      const path = await cachedSource(cwd, 'sources', className, '.java', key, function () {
        return readZipEntry(sourcesJar, entry)
      })
      if (path !== undefined) return { path: path, kind: 'sources', jar: sourcesJar }
    }
  }
  const config = await readDecompilerConfig(cwd)
  if (config !== undefined && existsSync(config.jar)) {
    const decompiled = await decompileClass(cwd, found, className, config).catch(() => undefined)
    if (decompiled !== undefined) return { path: decompiled, kind: 'decompiled', jar: found.jar }
  }
  const disassembly = await javapClass(cwd, found, className).catch(() => undefined)
  if (disassembly !== undefined) return { path: disassembly, kind: 'javap', jar: found.jar }
  return undefined
}

/**
 * GET `/dsh-ris-ide/debug/source?className=…&path=<program log>&sessionId=…`:
 * resolve a dependency class to a cached source file, so stepping into a jar
 * class still opens something readable.
 */
async function serveDebugSource(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const className = (url.searchParams.get('className') ?? '').trim()
    if (className === '' || !CLASS_NAME_PATTERN.test(className)) throw new TailError('bad-request', 'className is required', 400)
    const rawPath = url.searchParams.get('path') ?? ''
    if (rawPath === '') throw new TailError('bad-request', 'path (the program log path) is required', 400)
    const rawDir = url.searchParams.get('dir') ?? ''
    const logsDir = resolvePath(cwd, rawDir !== '' ? rawDir : 'logs', true)
    const logPath = resolvePath(cwd, rawPath, options?.restrictToCwd === true)
    const programs = await scanPrograms(cwd, logsDir, false).catch(() => [])
    const program = programs.find((item) => item.logPath === logPath)
    if (program === undefined) throw new TailError('unknown-program', `no program matched log ${rawPath}`, 404)
    const resolved = await resolveDependencySource(cwd, program.dir, className)
    if (resolved === undefined) throw new TailError('no-source', `no source, decompiler or javap output for ${className}`, 404)
    writeJson(res, 200, { ok: true, path: resolved.path, kind: resolved.kind, jar: resolved.jar, cacheDir: join(cwd, IDE_CACHE_DIR) })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * `/dsh-ris-ide/settings`: GET returns the visual debug settings, POST saves the
 * decompiler jar into `.dsh-ris-ide.settings.json` (the program config stays
 * untouched — rewriting JSONC would drop the user's comments).
 */
async function serveSettings(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = req.method ?? 'GET'
    const settingsPathOf = (cwd) => resolve(cwd, IDE_SETTINGS_FILENAME)
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
      const path = settingsPathOf(cwd)
      const existingText = await readTextIfSmall(path)
      const existing = existingText === undefined ? {} : parseJsonc(existingText)
      const next = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? Object.assign({}, existing) : {}
      const jar = typeof body.decompilerJar === 'string' ? body.decompilerJar.trim() : ''
      const args = normalizeStringArray(body.decompilerArgs)
      if (jar === '') delete next.decompiler
      else next.decompiler = args === undefined ? { jar } : { jar, args }
      await writeFile(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
      writeJson(res, 200, { ok: true, settingsPath: path, decompiler: next.decompiler ?? null })
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const config = await readDecompilerConfig(cwd)
    writeJson(res, 200, {
      ok: true,
      settingsPath: settingsPathOf(cwd),
      cacheDir: join(cwd, IDE_CACHE_DIR),
      decompiler: config === undefined ? null : { jar: config.jar, args: config.args ?? [] },
    })
  } catch (error) {
    writeTailError(res, error)
  }
}

async function serveDebug(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const action = url.pathname.slice(DEBUG_PATH.length).replace(/^\/+/, '')
    const method = req.method ?? 'GET'
    const postActions = new Set(['start', 'stop', 'breakpoints', 'step', 'resume', 'pause'])
    const getActions = new Set(['status', 'poll', 'breakpoints', 'threads', 'stack', 'variables', 'expand'])
    if ((method === 'POST' ? !postActions.has(action) : !getActions.has(action))) {
      if (postActions.has(action) || getActions.has(action)) throw new TailError('method-not-allowed', `${action} is ${postActions.has(action) ? 'POST' : 'GET'} only`, 405)
      throw new TailError('not-found', `unknown debug action "${action}"`, 404)
    }
    const write = (value) => writeJson(res, 200, jsonSafe(value))
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
      const rawDir = typeof body.dir === 'string' && body.dir !== '' ? body.dir : 'logs'
      const logsDir = resolvePath(cwd, rawDir, true)
      const rawPath = typeof body.path === 'string' ? body.path : ''
      const logPathOf = () => {
        if (rawPath === '') throw new TailError('bad-request', 'path (the program log path) is required', 400)
        return resolvePath(cwd, rawPath, options?.restrictToCwd === true)
      }
      if (action === 'start') {
        const programs = await scanPrograms(cwd, logsDir, false)
        const program = resolveProgramRef(programs, { id: body.id, name: body.name })
        if (program === undefined) {
          throw new TailError('unknown-program', `no program matched id=${body.id ?? ''} name=${body.name ?? ''}`, 404)
        }
        const started = await startProgramDebug(cwd, logsDir, program, Object.assign({}, options, {
          // `undefined` = let the host decide (pre-set breakpoints ⇒ boot suspended);
          // an explicit `false`/`true` from the caller always wins.
          debugSuspend: body.suspend === undefined || body.suspend === null ? undefined : body.suspend === true,
        }))
        write({ ok: true, ...started })
        return
      }
      if (action === 'stop') {
        const logPath = logPathOf()
        const detached = await debugSessions.detach(logPath)
        let stopped
        if (body.stopService === true) stopped = await stopLogPath(logPath, options?.stopGraceMs)
        write({ ok: true, ...detached, stopped })
        return
      }
      if (action === 'breakpoints') {
        const logPath = logPathOf()
        if (body.add !== undefined && body.add !== null) {
          const added = await debugSessions.addBreakpoint(logPath, body.add.className, body.add.line, body.add.suspendPolicy)
          write({ ok: true, breakpoint: added })
          return
        }
        if (body.remove !== undefined && body.remove !== null) {
          write({ ok: true, ...await debugSessions.removeBreakpoint(
            logPath,
            body.remove.requestId,
            typeof body.remove.className === 'string' ? body.remove.className : undefined,
            body.remove.line,
          ) })
          return
        }
        if (body.clear === true) {
          write({ ok: true, ...await debugSessions.clearBreakpoints(logPath) })
          return
        }
        throw new TailError('bad-request', 'breakpoints needs add | remove | clear', 400)
      }
      if (action === 'step') {
        write({ ok: true, ...await debugSessions.step(logPathOf(), body.kind ?? 'over', body.threadId) })
        return
      }
      if (action === 'resume') {
        write({ ok: true, ...await debugSessions.resume(logPathOf(), body.threadId) })
        return
      }
      write({ ok: true, ...await debugSessions.pause(logPathOf()) })
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const rawPath = url.searchParams.get('path') ?? ''
    if (rawPath === '') throw new TailError('bad-request', 'path (the program log path) is required', 400)
    const logPath = resolvePath(cwd, rawPath, options?.restrictToCwd === true)
  if (action === 'status') {
      write({ ok: true, ...debugSessions.status(logPath) })
      return
    }
    if (action === 'poll') {
      write({ ok: true, ...debugSessions.poll(logPath, Number(url.searchParams.get('since') ?? 0) || 0) })
      return
    }
    if (action === 'breakpoints') {
      write({ ok: true, breakpoints: debugSessions.listBreakpoints(logPath) })
      return
    }
    if (action === 'expand') {
      const objectId = url.searchParams.get('objectId') ?? ''
      write({ ok: true, ...await debugSessions.expand(logPath, objectId) })
      return
    }
    if (action === 'threads') {
      write({ ok: true, threads: await debugSessions.threads(logPath) })
      return
    }
    if (action === 'stack') {
      const threadId = url.searchParams.get('threadId') ?? ''
      const max = Number(url.searchParams.get('max') ?? 50) || 50
      write({ ok: true, frames: await debugSessions.stack(logPath, threadId, 0, max) })
      return
    }
    const threadId = url.searchParams.get('threadId') ?? ''
    const frameIndex = Number(url.searchParams.get('frameIndex') ?? 0) || 0
    write({ ok: true, variables: await debugSessions.variables(logPath, threadId, frameIndex) })
  } catch (error) {
    if (error instanceof DebugError) {
      writeJson(res, debugErrorStatus(error.code), { ok: false, code: error.code, message: error.message })
      return
    }
    writeTailError(res, error)
  }
}

/**
 * One request: start (or restart) one discovered program. The body is
 * `{ sessionId, id, cwd?, dir?, restart? }` — only the program id identifies
 * what to run, and the host re-scans before composing the command.
 *
 * `restart: true` is the panel's "重启" button: stop whatever owns this program's
 * log first (with the SAME stop grace as `/stop`), then start it again and report
 * `restarted` so the caller knows a stop really happened. A program that is not
 * running is simply started (there is no pidfile to honour, and treating that as
 * a failed restart would make the button useless on a stopped row).
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face (POST).
 * @param res - Node response face.
 * @param options - `{ restrictToCwd, stopGraceMs }` (see {@link apply}).
 */
async function serveStart(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const id = typeof body.id === 'string' ? body.id : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    if (id === '') throw new TailError('bad-request', 'id is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const rawDir = typeof body.dir === 'string' && body.dir !== '' ? body.dir : 'logs'
    const logsDir = resolvePath(cwd, rawDir, true)
    const programs = await scanPrograms(cwd, logsDir)
    const program = programs.find((entry) => entry.id === id)
    if (program === undefined) {
      throw new TailError('unknown-program', `no runnable program "${id}" was found under ${cwd}`, 404)
    }
    if (body.restart === true) {
      const wasRunning = program.running !== null && program.running !== undefined && program.running.alive === true
      if (wasRunning) await stopLogPath(program.logPath, options?.stopGraceMs)
      // A stale `running` row must not make startProgram answer `alreadyRunning`
      // for a process we just stopped (or never found).
      const started = await startProgram(cwd, logsDir, Object.assign({}, program, { running: null }), options)
      writeJson(res, 200, { ok: true, restarted: wasRunning, ...started })
      return
    }
    writeJson(res, 200, { ok: true, ...await startProgram(cwd, logsDir, program, options) })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Start one merged program (shared by the POST /start route and the
 * `ris_dev_start` tool): compose the command, spawn it through
 * `run-with-log.sh`, and wait for the pidfile.
 * @param cwd - absolute session workspace root (used for `local.yml` defaults).
 * @param logsDir - absolute logs directory.
 * @param program - one row from {@link scanPrograms}.
 * @param options - `{ stopGraceMs }`.
 * @returns `{ alreadyRunning, program }`.
 */
export async function startProgram(cwd, logsDir, program, options) {
  if (options?.debug === undefined) await debugSessions.detach(program.logPath)
  if (program.kind === 'instance') {
    throw new TailError('not-startable', 'this row is a log of an instance started outside the panel', 400)
  }
  if (program.running !== null && program.running !== undefined && program.running.alive) {
    return { alreadyRunning: true, program }
  }
  // Two guard rails before spawning a JVM: enough free memory, and a log that
  // does not start the run at tens of megabytes already.
  await assertEnoughMemory(options?.minFreeMemoryBytes)
  await rotateLogIfLarge(program.logPath).catch(() => false)
  trackActiveLog(program.logPath)
  await mkdir(logsDir, { recursive: true })
  const graceMs = Number.isFinite(program.stopGraceMs) ? program.stopGraceMs : options?.stopGraceMs
  const childEnv = Object.assign({}, process.env, { DSH_LOG_DIR: logsDir }, {
    DSH_STOP_GRACE_MS: String(clampBytes(graceMs, DEFAULT_STOP_GRACE_MS, MAX_STOP_GRACE_MS)),
  })
  let child
  if (IS_WINDOWS) {
    const selected = resolveWindowsRuntime(options?.runtime, options?.bashPath)
    if (selected.runtime === 'bash') {
      // Git Bash: same wrapper as Linux, Windows-flavored classpath.
      const spec = buildStartSpec(program, { workspace: cwd, logsDir, variant: 'windows-bash', debug: options?.debug })
      child = spawn(selected.bashPath, [spec.wrapperPath, program.logName, 'bash', '-lc', spec.command], {
        cwd: spec.cwd,
        env: Object.assign(childEnv, spec.env ?? {}),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      const plan = windowsStartSpec(program, { workspace: cwd, logsDir, debug: options?.debug })
      const specBase64 = Buffer.from(JSON.stringify(plan.spec), 'utf8').toString('base64')
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', plan.scriptPath, '-SpecBase64', specBase64,
      ], {
        cwd: plan.cwd,
        env: Object.assign(childEnv, plan.env ?? {}),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    }
  } else {
    const spec = buildStartSpec(program, { workspace: cwd, logsDir, debug: options?.debug })
    child = spawn(spec.wrapperPath, [program.logName, 'bash', '-lc', spec.command], {
      cwd: spec.cwd,
      env: Object.assign(childEnv, spec.env ?? {}),
      detached: true,
      stdio: 'ignore',
    })
  }
  child.on('error', () => {})
  child.unref()
  // The wrapper echoes the command, then Maven compiles quietly for 10-30 s: say
  // so in the log right away, otherwise "connected but silent" reads as broken.
  await appendFile(program.logPath, `--- 启动中：正在编译/拉起 ${program.name}，首次输出前可能静默 10–30 秒 ---\n`, 'utf8').catch(() => {})
  const startup = await waitForStartup(program.logPath, child, START_WAIT_MS)
  if (startup.kind !== 'running') {
    throw new TailError('start-failed', await startFailureMessage(program, startup), 502)
  }
  // `readPidFile` returns the raw pidfile record; the panel/tool rows expect the
  // `readService` shape, where a freshly published pidfile means "alive".
  const running = Object.assign({}, startup.record, { alive: true })
  return {
    alreadyRunning: false,
    program: Object.assign({}, program, { running, hasLog: existsSync(program.logPath) }),
  }
}

/**
 * Start one program in debug mode: stop it if needed, restart it with the JDWP
 * agent on a free loopback port, wait for the port, then attach.
 *
 * The service keeps running if attach fails (the reason is returned so the
 * panel/agent can show it); the JDWP listener is loopback-only and dies with
 * the process.
 * @param cwd - absolute session workspace root.
 * @param logsDir - absolute logs directory.
 * @param program - one row from {@link scanPrograms}.
 * @param options - `{ stopGraceMs, debugSuspend, debugAttachTimeoutMs }`.
 * @returns `{ port, program, debug }`.
 */
export async function startProgramDebug(cwd, logsDir, program, options) {
  if (program.kind === 'instance') {
    throw new TailError('not-startable', 'this row is a log of an instance started outside the panel', 400)
  }
  if (program.kind !== 'spring') {
    throw new TailError('not-startable', '只有 Spring(Java) 程序支持调试（前端程序没有 JVM）', 400)
  }
  const custom = typeof program.startCommand === 'string' ? program.startCommand : ''
  if (custom.trim() !== '' && !custom.includes('${JDWP_ARGS}')) {
    throw new TailError(
      'not-startable',
      '该程序配置了自定义 startCommand，调试需要 JDWP 参数：请在 java 后面加 ${JDWP_ARGS}（插件启动调试时会替换成 -agentlib:jdwp=…address=127.0.0.1:<端口>，普通启动时替换为空）',
      400,
    )
  }
  await assertEnoughMemory(options?.minFreeMemoryBytes)
  await rotateLogIfLarge(program.logPath).catch(() => false)
  trackActiveLog(program.logPath)
  const port = await allocateDebugPort()
  if (program.running !== null && program.running !== undefined && program.running.alive === true) {
    await stopLogPath(program.logPath, options?.stopGraceMs)
  }
  await debugSessions.detach(program.logPath).catch(() => {})
  const fresh = Object.assign({}, program, { running: null })
  // `suspend=y` keeps the JVM waiting before `main`, which is the ONLY way a
  // breakpoint on the entry line (`SpringApplication.run(...)`) can ever hit: with
  // `suspend=n` the line has already run by the time we attach. So a program with
  // pre-set breakpoints boots suspended; an explicit `suspend:false` still wins.
  const pendingForProgram = debugSessions.pendingCount(program.logPath)
  const suspendAtStartup = options?.debugSuspend === true
    || (options?.debugSuspend !== false && pendingForProgram > 0)
  const started = await startProgram(cwd, logsDir, fresh, Object.assign({}, options, {
    debug: { port, suspend: suspendAtStartup },
  }))
  const timeoutMs = Number.isFinite(options?.debugAttachTimeoutMs) ? options.debugAttachTimeoutMs : 90000
  try {
    // The wrapper runs `mvn compile` before the JVM exists, so wait for the JVM's
    // own "Listening for transport dt_socket" line — never probe the port with a
    // throwaway TCP connect (JDWP serves a single debugger session).
    await waitForJdwpListening(program.logPath, port, timeoutMs)
    const debug = await debugSessions.attach(started.program, port)
    // Suspended at startup with NOTHING to wait for would just hang the service:
    // resume once (a breakpoint that did install will suspend again on its own).
    if (suspendAtStartup && Number(debug.installedPending || 0) === 0) {
      try {
        await debugSessions.resume(program.logPath)
      } catch {
        // best effort: the VM may already be running
      }
    }
    return { port, program: started.program, suspendAtStartup, debug }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TailError('debug-failed', `服务已以调试模式启动（JDWP 127.0.0.1:${port}），但 attach 失败：${reason}`, 502)
  }
}

/**
 * Stop the service that owns one log path (shared by the POST /stop route and
 * the `ris_dev_stop` tool). Refuses a pidfile that is not `run-with-log.sh`.
 * @param logPath - absolute path of the program log.
 * @param fallbackGraceMs - grace when the pidfile records none.
 * @returns the stop outcome (`stopped`, `alreadyStopped`, `forced`, `waitedMs`).
 */
export async function stopLogPath(logPath, fallbackGraceMs) {
  // Detach first: a VM suspended on a breakpoint must resume before it can exit.
  await debugSessions.detach(logPath).catch(() => {})
  const record = await readPidFile(logPath)
  if (record === undefined) {
    throw new TailError('no-service', `no ${PID_SUFFIX} record next to "${logPath}" — the service was not started by run-with-log.sh`, 404)
  }
  if (!(await isRunWithLogWrapper(record.wrapperPid))) {
    throw new TailError('unverifiable', `pid ${record.wrapperPid} is not run-with-log.sh; refusing to signal it`, 409)
  }
  // The pidfile records the grace in force when the program started.
  const effectiveGrace = clampBytes(record.graceMs, fallbackGraceMs ?? DEFAULT_STOP_GRACE_MS, MAX_STOP_GRACE_MS)
  const outcome = await stopWrapper(record, effectiveGrace)
  if (outcome.stopped) await removePidFile(logPath)
  return outcome
}

/** One captured run's console: keep the first 4 KiB (mvn's real error often comes
 *  first) plus the LAST 400k characters (the failing test's stack trace). */
const RUN_TEST_HEAD_CHARS = 4096
const RUN_TEST_TAIL_CHARS = 400000
/** A single-test run is killed (TERM, then KILL) after this long. */
const RUN_TEST_TIMEOUT_MS = 900000
/** Grace between SIGTERM and SIGKILL when a run times out. */
const RUN_TEST_KILL_GRACE_MS = 2000
/** In-memory run records kept; the oldest is dropped past this (see {@link rememberRunTest}). */
const RUN_TEST_MAX_RECORDS = 10
/** Characters allowed in a Maven profile id / `-Dtest` selector / one module segment. */
const RUN_TEST_NAME_RE = /^[A-Za-z0-9_.\-$#]+$/
/** id → run record (bounded, oldest dropped). */
const RUN_TEST_RECORDS = new Map()
/** Monotonic suffix so two runs in the same millisecond still get distinct ids. */
let runTestSequence = 0

/** Allocate a short, unique, human-scannable run id. */
function nextRunTestId() {
  runTestSequence += 1
  return `rt-${Date.now().toString(36)}-${runTestSequence.toString(36)}`
}

/**
 * Validate one Maven module path: relative, `/`-separated segments of the same
 * safe charset. `..` is refused outright (containment is enforced again by
 * {@link resolvePath}), and `.` means "the cwd itself".
 * @param value - the request's `module`.
 * @returns the normalized relative module path.
 * @throws {TailError} `bad-request` when it is missing, absolute, or unsafe.
 */
function validateRunTestModule(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TailError('bad-request', 'module is required (a path relative to cwd)', 400)
  }
  const raw = value.trim()
  if (isAbsolute(raw)) {
    throw new TailError('bad-request', 'module must be a path relative to cwd, not an absolute path', 400)
  }
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return '.'
  for (const segment of segments) {
    if (segment === '..' || !RUN_TEST_NAME_RE.test(segment)) {
      throw new TailError('bad-request', `module segment "${segment}" is not a safe Maven module name`, 400)
    }
  }
  return segments.join('/')
}

/**
 * Validate one `-Dtest` selector. `shell: false` already makes injection
 * impossible, but a stray `;`, space or `(` is a caller bug worth a clear 400.
 * @param value - the request's `test`.
 * @returns the selector.
 * @throws {TailError} `bad-request` when it is missing or unsafe.
 */
function validateRunTestSelector(value) {
  if (typeof value !== 'string' || value === '' || !RUN_TEST_NAME_RE.test(value)) {
    throw new TailError('bad-request', 'test must match /^[A-Za-z0-9_.\\-$#]+$/ (a Maven -Dtest selector)', 400)
  }
  return value
}

/**
 * The Maven profile for one run: `-Pdev` unless the caller named one.
 * @param body - the parsed request body.
 * @returns the validated profile id.
 * @throws {TailError} `bad-request` for a profile that is not a plain id.
 */
function runTestProfile(body) {
  const raw = typeof body.profile === 'string' ? body.profile.trim() : ''
  if (raw === '') return 'dev'
  if (!RUN_TEST_NAME_RE.test(raw)) {
    throw new TailError('bad-request', 'profile must be a Maven profile id (letters, digits, _ . - $ #)', 400)
  }
  return raw
}

/** `mvn` is a `.cmd` shim on Windows; `spawn` with `shell: false` needs that name. */
function mavenExecutable() {
  return IS_WINDOWS ? 'mvn.cmd' : 'mvn'
}

/**
 * Append one console chunk while BOTH ends stay bounded: the head is kept as
 * the first {@link RUN_TEST_HEAD_CHARS} characters, the tail as the last
 * {@link RUN_TEST_TAIL_CHARS}. `total` remembers how much was dropped.
 * @param record - the run record being filled.
 * @param chunk - a stdout/stderr chunk (Buffer or string).
 */
function appendRunTestOutput(record, chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  record.total += text.length
  if (record.head.length < RUN_TEST_HEAD_CHARS) {
    record.head += text.slice(0, RUN_TEST_HEAD_CHARS - record.head.length)
  }
  record.tail += text
  if (record.tail.length > RUN_TEST_TAIL_CHARS) {
    record.tail = record.tail.slice(record.tail.length - RUN_TEST_TAIL_CHARS)
  }
}

/**
 * The console text handed back to the panel: whole output when it fits, and
 * `head + "…(省略 N 字符)…" + tail` when the caps had to bite.
 * @param record - the run record.
 * @returns the (possibly elided) console text.
 */
function runTestOutput(record) {
  if (record.total <= RUN_TEST_HEAD_CHARS) return record.head
  if (record.total <= RUN_TEST_TAIL_CHARS) return record.tail
  const tailStart = record.total - record.tail.length
  if (tailStart <= RUN_TEST_HEAD_CHARS) return record.head.slice(0, tailStart) + record.tail
  const dropped = tailStart - record.head.length
  return `${record.head}…(省略 ${dropped} 字符)…${record.tail}`
}

/**
 * Remember one run, dropping the oldest past {@link RUN_TEST_MAX_RECORDS}.
 * @param record - the record to store (its `id` is the key).
 */
function rememberRunTest(record) {
  RUN_TEST_RECORDS.set(record.id, record)
  while (RUN_TEST_RECORDS.size > RUN_TEST_MAX_RECORDS) {
    const oldest = RUN_TEST_RECORDS.keys().next().value
    if (oldest === undefined) break
    RUN_TEST_RECORDS.delete(oldest)
  }
}

/**
 * Finalize one run exactly once (the close handler and the timeout race for it).
 * @param record - the run record.
 * @param code - the child's exit code, when it exited normally.
 * @param status - `done` | `failed` | `timeout`.
 * @param extra - optional console text appended first (a spawn failure note).
 */
function finishRunTest(record, code, status, extra) {
  if (record.status !== 'running') return
  if (record.timer !== null) {
    clearTimeout(record.timer)
    record.timer = null
  }
  if (typeof extra === 'string' && extra !== '') appendRunTestOutput(record, extra)
  record.status = status
  record.exitCode = Number.isInteger(code) ? code : null
  record.durationMs = Date.now() - record.startedAt
}

/**
 * Kill a timed-out `mvn` and its children: on POSIX the group TERM→KILL (the
 * spawn was detached, so `mvn → java → surefire` share one pgid), on Windows
 * `taskkill /T`. Same escalation the service stop path uses.
 * @param record - the run record holding the child.
 */
function killRunTestTree(record) {
  const child = record.child
  if (child === null || child === undefined) return
  if (IS_WINDOWS) {
    if (Number.isInteger(child.pid)) void taskkillTree(child.pid)
    return
  }
  const pgid = Number.isInteger(child.pid) ? child.pid : undefined
  const signal = (name) => {
    try {
      if (pgid !== undefined) process.kill(-pgid, name)
      else child.kill(name)
    } catch {
      // already gone
    }
  }
  signal('SIGTERM')
  record.killTimer = setTimeout(() => signal('SIGKILL'), RUN_TEST_KILL_GRACE_MS)
  record.killTimer.unref?.()
}

/**
 * One POST: start `mvn -P<profile> -q -pl <module> test -Dtest=<test>` and answer
 * at once; the console is polled through {@link serveRunTestStatus}.
 *
 * `cwd` is the Maven reactor root (the directory holding the top `pom.xml`):
 * Maven resolves `-pl` relative to it, so a nested module such as
 * `ris-model/ris-model-biz` is addressed from the reactor root, not from itself.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face (POST).
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveRunTestStart(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const module = validateRunTestModule(body.module)
    const test = validateRunTestSelector(body.test)
    const profile = runTestProfile(body)
    // The module has to be a real Maven module INSIDE the session cwd: strict
    // containment even when the plugin runs unrestricted, because this value
    // ends up in a spawn argument.
    const moduleDir = resolvePath(cwd, module, true)
    const pom = await stat(join(moduleDir, 'pom.xml')).catch(() => undefined)
    if (pom === undefined || !pom.isFile()) {
      throw new TailError('unknown-module', `no pom.xml under "${module}" (not a Maven module of ${cwd})`, 404)
    }
    const args = [`-P${profile}`, '-q', '-pl', module, 'test', `-Dtest=${test}`, '-DfailIfNoTests=false', '-DskipITs']
    const command = `mvn ${args.map((arg) => quoteShell(arg)).join(' ')}`
    const record = {
      id: nextRunTestId(),
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      durationMs: 0,
      command,
      module,
      test,
      profile,
      child: null,
      timer: null,
      killTimer: null,
      head: '',
      tail: '',
      total: 0,
    }
    rememberRunTest(record)
    let child
    try {
      child = spawn(mavenExecutable(), args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: its own process group, so a timeout can stop the whole tree.
        detached: !IS_WINDOWS,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      finishRunTest(record, null, 'failed', `\n[spawn failed] ${reason}\n`)
      writeJson(res, 200, { ok: true, id: record.id, command, startedAt: record.startedAt })
      return
    }
    record.child = child
    child.stdout?.on('data', (chunk) => appendRunTestOutput(record, chunk))
    // Interleaved on purpose: Maven writes errors and the test log to two
    // streams, and the user reads them as one console.
    child.stderr?.on('data', (chunk) => appendRunTestOutput(record, chunk))
    child.on('error', (error) => {
      const reason = isMissingExecutable(error)
        ? 'mvn not found on PATH (install Maven, or put mvn/mvn.cmd on the PATH the host was started with)'
        : (error instanceof Error ? error.message : String(error))
      finishRunTest(record, null, 'failed', `\n[spawn failed] ${reason}\n`)
    })
    child.on('close', (code) => {
      // The timeout path finalizes first; a late close must not rewrite it.
      if (record.status !== 'running') return
      finishRunTest(record, code, code === 0 ? 'done' : 'failed')
    })
    record.timer = setTimeout(() => {
      if (record.status !== 'running') return
      killRunTestTree(record)
      finishRunTest(record, child.exitCode, 'timeout')
    }, RUN_TEST_TIMEOUT_MS)
    record.timer.unref?.()
    writeJson(res, 200, { ok: true, id: record.id, command, startedAt: record.startedAt })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * One GET: the state and (capped) console of one run. Query parameters
 * `sessionId`, `cwd`, `id`.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face (GET).
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 */
async function serveRunTestStatus(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    // Resolved only to validate the session (records are host-wide, keyed by id).
    resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const id = url.searchParams.get('id') ?? ''
    if (id === '') throw new TailError('bad-request', 'id is required', 400)
    const record = RUN_TEST_RECORDS.get(id)
    if (record === undefined) {
      throw new TailError('not-found', `no run-test record "${id}" (a host restart clears them, and only the last ${RUN_TEST_MAX_RECORDS} are kept)`, 404)
    }
    const running = record.status === 'running'
    writeJson(res, 200, {
      ok: true,
      id: record.id,
      status: record.status,
      exitCode: record.exitCode,
      output: runTestOutput(record),
      startedAt: record.startedAt,
      durationMs: running ? Date.now() - record.startedAt : record.durationMs,
      running,
    })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Scan one workspace root for runnable programs.
 *
 * Discovery (the tree walk) is cached for {@link DISCOVERY_TTL_MS}: the panel
 * polls every few seconds and only the RUNNING state has to be fresh, so each
 * poll is a handful of pidfile reads instead of a full tree walk.
 * `forceRefresh` re-walks now (the panel's "重新扫描" button).
 *
 * @param root - absolute session workspace root.
 * @param logsDir - absolute logs directory the pidfiles live in.
 * @param forceRefresh - ignore the discovery cache for this call.
 * @returns program rows, each with `running` (`null` when nothing owns its log)
 *  and `hasLog`.
 */
export async function scanPrograms(root, logsDir, forceRefresh = false) {
  const workspace = resolve(root)
  if (forceRefresh) discoveryCache.delete(workspace)
  const discovered = await discoverPrograms(workspace)
  const config = await readProgramConfig(workspace)
  const merged = mergeProgramConfig(discovered, config.entries, workspace, config.defaults)
  return decoratePrograms(workspace, logsDir, merged)
}

/**
 * Turn rows (scanned or config-derived) into what the panel/tools render: resolve
 * the log path, read the pidfile for liveness, add ad-hoc instance rows, sort.
 * Shared by the scanner and the "config matches, do not rescan" fast path.
 * @param workspace - absolute workspace root.
 * @param logsDir - absolute logs directory.
 * @param rows - program rows (no `logPath`/`running` yet).
 * @returns the decorated list.
 */
export async function decoratePrograms(workspace, logsDir, rows) {
  const list = rows.map((entry) => Object.assign({}, entry, {
    logPath: resolve(logsDir, `${entry.logName}.log`),
    running: null,
    hasLog: false,
  }))
  for (const program of list) {
    program.running = await readService(program.logPath)
    program.hasLog = existsSync(program.logPath)
  }
  // Ad-hoc instances the scan did not account for (started by hand, or a
  // `DSH_LOG_STAMP=1` run) stay visible as log-only rows.
  for (const instance of await listInstances(logsDir)) {
    if (list.some((program) => resolve(program.logPath) === resolve(instance.logPath))) continue
    if (list.length >= MAX_PROGRAMS) break
    list.push({
      id: `instance:${instance.logPath}`,
      kind: 'instance',
      name: instance.name,
      project: '',
      dir: dirname(instance.logPath),
      relDir: relative(workspace, dirname(instance.logPath)) || '.',
      logName: instance.name,
      logPath: instance.logPath,
      running: instance.alive
        ? { pid: instance.pid, wrapperPid: instance.wrapperPid, startedAt: instance.startedAt, alive: true }
        : { pid: instance.pid, wrapperPid: instance.wrapperPid, startedAt: instance.startedAt, alive: false },
      hasLog: true,
    })
  }
  list.sort((a, b) => String(a.project).localeCompare(String(b.project))
    || String(a.kind).localeCompare(String(b.kind))
    || String(a.name).localeCompare(String(b.name)))
  return list
}

/**
 * Program rows built from the user config alone — the "config matches the
 * workspace, so do not scan" fast path. Liveness still comes from the pidfiles
 * (via {@link decoratePrograms}).
 * @param workspace - absolute workspace root.
 * @param entries - config rows from {@link readProgramConfig}.
 * @returns program rows (undecorated).
 */
export function programsFromConfigEntries(workspace, entries, defaults) {
  const defaultJvmArgs = normalizeStringArray(defaults?.jvmArgs)
  const rows = []
  for (const entry of entries) {
    if (entry.disabled === true) continue
    if (rows.length >= MAX_PROGRAMS) break
    const kind = entry.kind === 'spring' || entry.kind === 'frontend' ? entry.kind : 'manual'
    const dir = typeof entry.dir === 'string' && entry.dir.trim() !== '' ? resolve(workspace, entry.dir) : workspace
    const logName = typeof entry.logName === 'string' && entry.logName.trim() !== ''
      ? sanitizeLogName(entry.logName)
      : sanitizeLogName(entry.name)
    const startCommand = typeof entry.startCommand === 'string' && entry.startCommand.trim() !== ''
      ? entry.startCommand
      : undefined
    rows.push({
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `config:${logName}`,
      kind,
      name: entry.name.trim(),
      project: 'config',
      dir,
      relDir: relative(workspace, dir) || '.',
      mainClass: typeof entry.mainClass === 'string' && entry.mainClass !== '' ? entry.mainClass : undefined,
      script: typeof entry.script === 'string' && entry.script !== '' ? entry.script : undefined,
      packageManager: typeof entry.packageManager === 'string' && entry.packageManager !== ''
        ? entry.packageManager
        : detectPackageManager(dir, workspace),
      logName,
      args: Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === 'string') : undefined,
      env: normalizeEnv(entry.env),
      startCommand,
      stopGraceMs: Number.isFinite(entry.stopGraceMs) ? entry.stopGraceMs : undefined,
      jvmArgs: normalizeStringArray(entry.jvmArgs) ?? defaultJvmArgs,
      launch: null,
      fromConfig: true,
      overridden: true,
    })
  }
  return rows
}

/** Whether a Spring main class still exists at the module's standard source path. */
function springSourceExists(dir, mainClass) {
  if (typeof mainClass !== 'string' || mainClass === '') return false
  const parts = mainClass.split('.')
  const simple = parts.pop()
  const file = resolve(dir, 'src', 'main', 'java', ...parts, `${simple}.java`)
  return existsSync(file)
}

/** Does an `additional-location` arg point at an existing file? */
function fileArgExists(arg) {
  const raw = String(arg).slice('--spring.config.additional-location=file:'.length)
  return raw !== '' && existsSync(raw)
}

/**
 * Does the config still describe the workspace? A cheap filesystem check — no
 * tree walk — so the panel can skip scanning when nothing moved: every directory
 * exists, every Spring main class is where it was, every frontend directory still
 * has its `package.json`, and every `additional-location` points at the program's
 * own project-root `local.yml` (a stale launch.json / old generated config
 * pointing at the workspace root counts as a mismatch and gets updated).
 * @param workspace - absolute workspace root.
 * @param entries - config rows.
 * @returns `true` when the config can be trusted as the program list.
 */
export function configMatchesWorkspace(workspace, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false
  for (const entry of entries) {
    if (entry.disabled === true) continue
    if (typeof entry.dir !== 'string' || entry.dir.trim() === '') return false
    const dir = resolve(workspace, entry.dir)
    if (!existsSync(dir)) return false
    const kind = entry.kind === 'spring' || entry.kind === 'frontend' ? entry.kind : 'manual'
    const startCommand = typeof entry.startCommand === 'string' && entry.startCommand.trim() !== ''
    if (kind === 'spring' && !startCommand) {
      if (!springSourceExists(dir, entry.mainClass)) return false
      const args = Array.isArray(entry.args) ? entry.args : []
      const profileArg = args.find((arg) => typeof arg === 'string' && arg.startsWith('--spring.profiles.active='))
      if (profileArg !== undefined && profileArg !== `--spring.profiles.active=${readProjectProfile(workspace, dir)}`) return false
      const location = args.find((arg) => typeof arg === 'string' && arg.startsWith('--spring.config.additional-location='))
      if (location !== undefined) {
        const expected = localYmlFor(workspace, dir)
        if (expected !== undefined) {
          if (location !== `--spring.config.additional-location=file:${expected}`) return false
        } else if (!fileArgExists(location)) {
          return false
        }
      }
    } else if (kind === 'frontend' && !startCommand) {
      if (!existsSync(resolve(dir, 'package.json'))) return false
    } else if (!startCommand) {
      return false
    }
  }
  return true
}

/** Tree-walk cache: one discovery result per workspace root. */
const discoveryCache = new Map()

/**
 * The cached discovery: a SHALLOW tree walk for module/manifest locations, then
 * one targeted scan of each Maven module's `src/main/java`.
 *
 * The split matters for speed and for correctness: entry programs and frontend
 * manifests sit near the top (`project/module`, `project/ui`), while the only
 * deep part is the Java package nesting under a module — so the walk stops at
 * {@link SHALLOW_MAX_DEPTH} and only module dirs get the deep Java scan.
 *
 * @param workspace - absolute workspace root.
 * @returns discovered entries (no log path, no running state yet).
 */
async function discoverPrograms(workspace) {
  const cached = discoveryCache.get(workspace)
  if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.programs
  const programs = new Map()
  const launch = await readLaunchConfigs(workspace)
  /** Module dirs (a `pom.xml` lives there) and frontend manifest files. */
  const moduleDirs = new Set()
  const manifestFiles = []
  const walk = async (dir, depth) => {
    if (depth > SHALLOW_MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        // `src` is where the deep Java tree starts: phase two handles it per module.
        if (entry.name === 'src' || SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === 'pom.xml') moduleDirs.add(dir)
      else if (entry.name === 'package.json') manifestFiles.push(full)
    }
  }
  await walk(workspace, 0)
  for (const file of manifestFiles) await considerFrontend(workspace, file, programs)
  for (const moduleDir of moduleDirs) await scanModuleEntries(workspace, moduleDir, programs, launch)
  const list = [...programs.values()]
  assignLogNames(list)
  discoveryCache.set(workspace, { at: Date.now(), programs: list })
  return list
}

/**
 * Scan one Maven module's `src/main/java` for a Spring Boot entry point.
 * Only files whose class name matches {@link ENTRY_JAVA_RE} are read, and the
 * annotation check still decides.
 * @param workspace - absolute workspace root.
 * @param moduleDir - the module directory (holds `pom.xml`).
 * @param programs - discovery map to fill.
 * @param launch - parsed `.vscode/launch.json` configurations.
 */
async function scanModuleEntries(workspace, moduleDir, programs, launch) {
  const javaRoot = resolve(moduleDir, 'src', 'main', 'java')
  const walk = async (dir, depth) => {
    if (depth > MODULE_JAVA_MAX_DEPTH || programs.size >= MAX_PROGRAMS) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (programs.size >= MAX_PROGRAMS) return
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.java')) continue
      if (!ENTRY_JAVA_RE.test(entry.name)) continue
      await considerSpring(workspace, full, programs, launch)
    }
  }
  await walk(javaRoot, 0)
}

/** Record one Spring Boot program when the file really is an entry point. */
async function considerSpring(workspace, file, programs, launch) {
  const text = await readTextIfSmall(file)
  if (text === undefined || !text.includes('@SpringBootApplication')) return
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)
  const cls = /(?:\bpublic\s+)?(?:final\s+)?class\s+(\w+)/.exec(text)
  if (cls === null) return
  const mainClass = pkg === null ? cls[1] : `${pkg[1]}.${cls[1]}`
  const moduleDir = nearestMavenModule(file, workspace)
  const relDir = relative(workspace, moduleDir) || '.'
  const id = `spring:${relDir}#${mainClass}`
  if (programs.has(id)) return
  const launched = launchFor(launch, moduleDir, workspace)
  programs.set(id, {
    id,
    kind: 'spring',
    name: basename(moduleDir),
    project: projectOf(relDir, workspace),
    dir: moduleDir,
    relDir,
    mainClass,
    javaFile: relative(workspace, file),
    launch: launched === undefined ? null : { name: launched.name, mainClass: launched.mainClass, args: launched.args },
    logName: '',
    logPath: '',
    hasLog: false,
    running: null,
  })
}

/** Record one frontend program when its manifest has a dev-ish script. */
async function considerFrontend(workspace, file, programs) {
  const dir = dirname(file)
  const text = await readTextIfSmall(file)
  if (text === undefined) return
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    return
  }
  const scripts = manifest !== null && typeof manifest === 'object' && typeof manifest.scripts === 'object' && manifest.scripts !== null
    ? manifest.scripts
    : undefined
  if (scripts === undefined) return
  const script = ['dev', 'start', 'serve'].find((key) => typeof scripts[key] === 'string' && scripts[key].trim() !== '')
  if (script === undefined) return
  const relDir = relative(workspace, dir) || '.'
  const id = `frontend:${relDir}#${script}`
  if (programs.has(id)) return
  programs.set(id, {
    id,
    kind: 'frontend',
    name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : basename(dir),
    project: projectOf(relDir, workspace),
    dir,
    relDir,
    script,
    packageManager: detectPackageManager(dir, workspace),
    logName: '',
    logPath: '',
    hasLog: false,
    running: null,
  })
}

/** Assign a unique, filesystem-safe log name per program (the pidfile key). */
function assignLogNames(programs) {
  const used = new Map()
  for (const program of programs) {
    const base = sanitizeLogName(`${program.project ? `${program.project}-` : ''}${program.name}`)
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    program.logName = count === 0 ? base : `${base}-${count + 1}`
  }
}

/** One log-name segment: safe characters, bounded length. */
export function sanitizeLogName(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return cleaned === '' ? 'program' : cleaned
}

/** The first path segment under the workspace, as a grouping label. */
export function projectOf(relDir, workspace) {
  const first = String(relDir).split(/[\\/]/)[0]
  if (first === undefined || first === '' || first === '.') return basename(resolve(workspace))
  return first
}

/**
 * The Maven module a Java file belongs to: the nearest ancestor with a
 * `pom.xml`, else the directory implied by `src/main/java`.
 */
export function nearestMavenModule(file, workspace) {
  let dir = dirname(file)
  const stop = resolve(workspace)
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(resolve(dir, 'pom.xml'))) return dir
    if (resolve(dir) === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const marker = `${sep}src${sep}main${sep}java`
  const index = file.indexOf(marker)
  return index === -1 ? dirname(file) : file.slice(0, index)
}

/** The package manager a directory tree uses, by nearest lockfile. */
export function detectPackageManager(dir, workspace) {
  let current = dir
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-lock.yaml')) || existsSync(resolve(current, 'pnpm-workspace.yaml'))) return 'pnpm'
    if (existsSync(resolve(current, 'yarn.lock'))) return 'yarn'
    if (existsSync(resolve(current, 'package-lock.json'))) return 'npm'
    if (resolve(current) === resolve(workspace)) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return 'npm'
}

/** The command one discovered program starts with. */
export function buildStartSpec(program, context) {
  const workspace = context.workspace
  const logsDir = context.logsDir
  const wrapperPath = fileURLToPath(new URL('../bin/run-with-log.sh', import.meta.url))
  // A user-configured `startCommand` wins over everything (it is their file and
  // their intent); we only prefix `cd` when they did not do it themselves.
  if (typeof program.startCommand === 'string' && program.startCommand.trim() !== '') {
    const custom = program.startCommand.trim()
    // A custom command cannot be rewritten safely, so it opts into debugging by
    // carrying the `${JDWP_ARGS}` placeholder the host replaces on start.
    const debugArg = context.debug !== undefined && Number.isInteger(context.debug.port)
      ? ` ${jdwpAgentArg(context.debug.port, context.debug.suspend === true)} `
      : ' '
    const withDebug = custom.replace(/\s*\$\{JDWP_ARGS\}\s*/g, debugArg)
    return {
      command: /^cd\s/.test(withDebug) ? withDebug : `cd ${quoteShell(program.dir)} && ${withDebug}`,
      cwd: program.dir,
      wrapperPath,
      env: program.env,
    }
  }
  if (program.kind === 'frontend') {
    return {
      command: `cd ${quoteShell(program.dir)} && exec ${quoteShell(program.packageManager ?? 'npm')} run ${quoteShell(program.script ?? 'dev')}`,
      cwd: program.dir,
      wrapperPath,
      env: program.env,
    }
  }
  const launchMainClass = program.launch !== null && program.launch !== undefined ? program.launch.mainClass : undefined
  // Precedence: a config override, then launch.json (authoritative per AGENTS.md),
  // then the class the annotation scan found.
  const mainClass = program.mainClassFromConfig === true
    ? program.mainClass
    : (launchMainClass ?? program.mainClass)
  const args = resolveSpringArgs(program, workspace)
  // User JVM flags (memory, GC, agents) come from `.dsh-ris-ide.json`; they sit
  // after the plugin's required -D flags so a deliberate override still wins.
  const jvmArgs = normalizeStringArray(program.jvmArgs) ?? []
  // Debug mode adds the JDWP agent before the user's own JVM flags.
  const debugArg = context.debug !== undefined && Number.isInteger(context.debug.port)
    ? [jdwpAgentArg(context.debug.port, context.debug.suspend === true)]
    : []
  const cspDir = resolve(logsDir, 'csp')
  // Git Bash on Windows runs a Windows JVM: `;` separates classpath entries and the
  // compiled classes live under `target\classes` (the rest of the command is
  // POSIX-identical, which is the point of reusing the .sh wrapper).
  const windowsBash = context.variant === 'windows-bash'
  const classesDir = windowsBash ? 'target\\classes' : 'target/classes'
  const classPathSep = windowsBash ? ';' : ':'
  const command = [
    `mkdir -p ${quoteShell(cspDir)}`,
    `cd ${quoteShell(program.dir)}`,
    'mvn -Pdev compile',
    'mvn -Pdev dependency:build-classpath -Dmdep.includeScope=runtime -Dmdep.outputFile=target/cp.txt',
    // `exec` is what makes the wrapper's child BE the JVM, so a stop TERMs the
    // service itself instead of an intermediate shell.
    `exec java -DJM.LOG.PATH=${quoteShell(logsDir)} -Dcsp.sentinel.log.dir=${quoteShell(cspDir)}`
      + `${[...debugArg, ...jvmArgs].length > 0 ? ` ${[...debugArg, ...jvmArgs].map(quoteShell).join(' ')}` : ''}`
      + ` -cp "${classesDir}${classPathSep}$(cat target/cp.txt)" ${quoteShell(mainClass)} ${args.map(quoteShell).join(' ')}`,
  ].join(' && ')
  return { command, cwd: program.dir, wrapperPath, env: program.env }
}

/**
 * The Windows equivalent of {@link buildStartSpec}: instead of one bash command
 * line it describes the job in a JSON spec that `bin/run-with-log.ps1` executes
 * (PowerShell does the classpath expansion and the output pump).
 * @param program - one program row.
 * @param context - `{ workspace, logsDir }`.
 * @returns `{ platform: 'win32', scriptPath, spec, cwd, env }`.
 */
export function windowsStartSpec(program, context) {
  const workspace = context.workspace
  const logsDir = context.logsDir
  const scriptPath = fileURLToPath(new URL('../bin/run-with-log.ps1', import.meta.url))
  const spec = { logName: program.logName, logDir: logsDir, kind: 'command', dir: program.dir }
  const custom = typeof program.startCommand === 'string' ? program.startCommand.trim() : ''
  if (custom !== '') {
    spec.kind = 'command'
    const debugArg = context.debug !== undefined && Number.isInteger(context.debug.port)
      ? ` ${jdwpAgentArg(context.debug.port, context.debug.suspend === true)} `
      : ' '
    spec.command = custom.replace(/\s*\$\{JDWP_ARGS\}\s*/g, debugArg)
  } else if (program.kind === 'frontend') {
    spec.kind = 'frontend'
    spec.packageManager = program.packageManager ?? 'npm'
    spec.script = program.script ?? 'dev'
  } else {
    spec.kind = 'spring'
    const launchMainClass = program.launch !== null && program.launch !== undefined ? program.launch.mainClass : undefined
    spec.mainClass = program.mainClassFromConfig === true ? program.mainClass : (launchMainClass ?? program.mainClass)
    spec.args = resolveSpringArgs(program, workspace)
    spec.jvmArgs = normalizeStringArray(program.jvmArgs) ?? []
    if (context.debug !== undefined && Number.isInteger(context.debug.port)) {
      spec.jvmArgs = [jdwpAgentArg(context.debug.port, context.debug.suspend === true), ...spec.jvmArgs]
    }
  }
  return { platform: 'win32', scriptPath, spec, cwd: program.dir, env: program.env }
}

/** The documented default Spring Boot arguments. */
/**
 * Profiles a project entry pom declares: the activeByDefault profile id first,
 * then a literal `<profiles.active>` property.
 *
 * RISCloud projects configure the profile in the PROJECT entry pom
 * (`ris/pom.xml`: `<profile><id>dev</id><activeByDefault>true</activeByDefault>
 * … <profiles.active>dev</profiles.active>`), and the child modules inherit it.
 * @param text - pom XML.
 * @returns the profile id, or `undefined` when the pom says nothing.
 */
export function profileFromPomText(text) {
  const profilesBlock = /<profiles>([\s\S]*?)<\/profiles>/.exec(text)
  if (profilesBlock !== null) {
    for (const match of profilesBlock[1].matchAll(/<profile>([\s\S]*?)<\/profile>/g)) {
      const body = match[1]
      if (!/<activeByDefault>\s*true\s*<\/activeByDefault>/i.test(body)) continue
      const id = /<id>\s*([^<\s]+)\s*<\/id>/.exec(body)
      if (id !== null) return id[1]
    }
  }
  const property = /<([\w.\-]*(?:profiles?)\.active[\w.\-]*)>\s*([^<$][^<]*)\s*<\/\1>/.exec(text)
  return property !== null ? property[2].trim() : undefined
}

/** Small pom-profile cache keyed by the pom path (invalidated on mtime change). */
const profileCache = new Map()

/**
 * The Spring profile a project runs with, read from its entry pom (and, when that
 * pom only declares `<parent>`, from the parent chain: relativePath, a sibling
 * project of the same artifactId in the workspace, then `~/.m2`).
 * Falls back to `dev`, which is what RISCloud projects configure.
 * @param workspace - absolute workspace root.
 * @param dir - absolute program/module directory.
 * @returns the profile id (e.g. `dev`).
 */
export function readProjectProfile(workspace, dir) {
  const root = projectRootOf(workspace, dir)
  const pom = resolve(root, 'pom.xml')
  const mtime = (() => {
    try {
      return statSync(pom).mtimeMs
    } catch {
      return 0
    }
  })()
  const cached = profileCache.get(root)
  if (cached !== undefined && cached.mtime === mtime) return cached.profile
  const profile = profileOfPomChain(workspace, pom) ?? 'dev'
  profileCache.set(root, { mtime, profile })
  return profile
}

/** Walk one pom's parent chain looking for a profile declaration. */
function profileOfPomChain(workspace, pom, depth = 0) {
  if (depth > 4) return undefined
  const text = readTextSync(pom)
  if (text === undefined) return undefined
  const own = profileFromPomText(text)
  if (own !== undefined) return own
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)
  if (parent === null) return undefined
  const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(parent[1])
  const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(parent[1])
  const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(parent[1])
  const relative = /<relativePath>\s*([^<]*?)\s*<\/relativePath>/.exec(parent[1])
  const candidates = []
  if (relative !== null && relative[1] !== '') candidates.push(resolve(dirname(pom), relative[1]))
  else candidates.push(resolve(dirname(pom), '..', 'pom.xml'))
  if (artifact !== null) {
    const artifactId = artifact[1]
    // A sibling project with the parent's artifactId inside this workspace.
    try {
      for (const entry of readdirSync(workspace, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === artifactId) candidates.push(resolve(workspace, artifactId, 'pom.xml'))
      }
    } catch {
      // unreadable workspace: keep the relativePath candidates
    }
    if (group !== null && version !== null) {
      candidates.push(resolve(homedir(), '.m2', 'repository', ...group[1].split('.'), artifactId, version[1], `${artifactId}-${version[1]}.pom`))
    }
  }
  const next = candidates.find((candidate) => existsSync(candidate) && resolve(candidate) !== resolve(pom))
  return next === undefined ? undefined : profileOfPomChain(workspace, next, depth + 1)
}

/** Read a small UTF-8 file synchronously (poms are tiny; this keeps arg building sync). */
function readTextSync(path, limit = 512 * 1024) {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > limit) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The project root of a discovered program: the first path segment under the
 * workspace (`ris/ris-model/ris-model-biz` → `ris`). Each RIS project keeps its
 * own `local.yml` there, so this — not the workspace root — is where a program's
 * additional config location must point.
 * @param workspace - absolute workspace root.
 * @param dir - absolute program/module directory.
 * @returns the absolute project root (the workspace itself for top-level dirs).
 */
export function projectRootOf(workspace, dir) {
  const root = resolve(workspace)
  const rel = relative(root, resolve(dir))
  if (rel === '' || rel.startsWith('..')) return root
  const first = rel.split(sep)[0]
  if (first === undefined || first === '') return root
  // A program directly under the workspace (`ris-codegen`) is itself the project
  // root, so it keeps its own local.yml; only the workspace itself means "root".
  return resolve(root, first)
}

/**
 * The `local.yml` a Spring program should load: the PROJECT root's copy first,
 * then the workspace root as a fallback.
 * @param workspace - absolute workspace root.
 * @param dir - absolute program/module directory.
 * @returns absolute path, or `undefined` when neither exists.
 */
export function localYmlFor(workspace, dir) {
  const projectLocal = resolve(projectRootOf(workspace, dir), 'local.yml')
  if (existsSync(projectLocal)) return projectLocal
  const workspaceLocal = resolve(workspace, 'local.yml')
  return existsSync(workspaceLocal) ? workspaceLocal : undefined
}

export function defaultSpringArgs(workspace, dir) {
  const target = dir ?? workspace
  const args = [`--spring.profiles.active=${readProjectProfile(workspace, target)}`]
  const local = localYmlFor(workspace, target)
  if (local !== undefined) args.push(`--spring.config.additional-location=file:${local}`)
  return args
}

/**
 * Normalize the two args every `cn.com.ris.cloud` Spring program runs with:
 * `--spring.profiles.active=<project pom profile>` and
 * `--spring.config.additional-location=file:<project root>/local.yml`.
 *
 * An `--spring.config.additional-location` that points somewhere else (a stale
 * `.vscode/launch.json` pointing at the workspace root, or an old generated
 * config) is rewritten to the project's own file; other args keep their order.
 * @param args - args from launch.json / config / defaults.
 * @param workspace - absolute workspace root.
 * @param dir - absolute program/module directory.
 * @returns the normalized args.
 */
export function normalizeSpringArgs(args, workspace, dir) {
  const local = localYmlFor(workspace, dir)
  const profile = readProjectProfile(workspace, dir)
  const out = []
  let hasProfile = false
  for (const arg of args) {
    if (typeof arg !== 'string') continue
    if (arg.startsWith('--spring.profiles.active=')) {
      hasProfile = true
      // The pom owns the profile; a stale launch.json/config value is corrected.
      out.push(`--spring.profiles.active=${profile}`)
      continue
    }
    if (arg.startsWith('--spring.config.additional-location=')) {
      if (local !== undefined) out.push(`--spring.config.additional-location=file:${local}`)
      else if (fileArgExists(arg)) out.push(arg)
      // neither a local.yml in the project/workspace nor a real file: drop it,
      // otherwise the generated config would claim a location that does not exist
      continue
    }
    out.push(arg)
  }
  const result = hasProfile ? out : [`--spring.profiles.active=${profile}`, ...out]
  if (local !== undefined && !result.some((arg) => arg.startsWith('--spring.config.additional-location='))) {
    result.push(`--spring.config.additional-location=file:${local}`)
  }
  return result
}

/**
 * The args a Spring program is started with: explicit config `args` win untouched,
 * otherwise launch.json's are normalized, otherwise the project-root defaults.
 * @param program - one program row.
 * @param workspace - absolute workspace root.
 * @returns the arg list for the JVM.
 */
export function resolveSpringArgs(program, workspace) {
  if (Array.isArray(program.args) && program.args.length > 0) return program.args
  const launchArgs = program.launch !== null && program.launch !== undefined
    && Array.isArray(program.launch.args) && program.launch.args.length > 0
    ? program.launch.args
    : defaultSpringArgs(workspace, program.dir)
  return normalizeSpringArgs(launchArgs, workspace, program.dir)
}

/** One shell word, quoted only when it needs to be. */
export function quoteShell(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Wait for the wrapper to publish its pidfile (it writes it right after
 * spawning the child, so this settles in milliseconds for a startable program).
 */
async function waitForPidfile(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const service = await readService(logPath)
    if (service !== undefined) return service
    await new Promise((done) => setTimeout(done, 100))
  }
  return null
}

/** Read a file only when it is small enough to be a source/manifest. */
async function readTextIfSmall(file) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > SCAN_MAX_FILE_BYTES) return undefined
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The `.vscode/launch.json` configurations, tolerant of comments and trailing
 * commas (the file is JSONC in practice).
 * @param workspace - absolute workspace root.
 * @returns `[{ name, mainClass, cwd, args }]`, cwd resolved and `${workspaceFolder}` expanded.
 */
export async function readLaunchConfigs(workspace) {
  const text = await readTextIfSmall(resolve(workspace, '.vscode', 'launch.json'))
  if (text === undefined) return []
  const parsed = parseJsonc(text)
  const configurations = parsed !== null && Array.isArray(parsed.configurations) ? parsed.configurations : []
  return configurations
    .filter((config) => config !== null && typeof config === 'object' && typeof config.mainClass === 'string')
    .map((config) => ({
      name: typeof config.name === 'string' ? config.name : undefined,
      mainClass: config.mainClass,
      cwd: typeof config.cwd === 'string' ? config.cwd.replace(/\$\{workspaceFolder\}/g, workspace) : undefined,
      args: Array.isArray(config.args)
        ? config.args.filter((arg) => typeof arg === 'string')
          .map((arg) => arg.replace(/\$\{workspaceFolder\}/g, workspace))
        : [],
    }))
}

/** The launch configuration whose `cwd` is exactly `dir`, if any. */
export function launchFor(configs, dir, workspace) {
  const target = resolve(dir)
  for (const config of configs) {
    if (config.cwd === undefined) continue
    if (resolve(workspace, config.cwd) === target) return config
  }
  return undefined
}

/**
 * Parse JSON with comments and trailing commas (enough for `launch.json`).
 * @param text - raw file text.
 * @returns the parsed value, or `null` when it cannot be parsed.
 */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return null
  }
}

// ── User program config (generated from a scan, then user-maintained) ────────
//
// The panel can write `<workspace>/.dsh-ris-ide.json` from what it discovered.
// After that the file belongs to the user: entries override discovered programs
// by id (then dir, then name), entries that match nothing become user-added
// programs, `disabled: true` hides a row, and `startCommand` replaces the
// composed command. It is JSONC — header comments and trailing commas are
// tolerated by `parseJsonc`.

/**
 * Read and validate the workspace config file. A missing file is not an error.
 * @param cwd - absolute session workspace root.
 * @returns `{ path, exists, entries, error }`; `entries` only holds valid rows.
 */
export async function readProgramConfig(cwd) {
  const path = resolve(cwd, CONFIG_FILENAME)
  const text = await readTextIfSmall(path)
  if (text === undefined) return { path, exists: false, entries: [], error: undefined }
  const parsed = parseJsonc(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path, exists: true, entries: [], error: '配置文件不是合法的 JSON 对象' }
  }
  const raw = Array.isArray(parsed.programs) ? parsed.programs : []
  const entries = raw.slice(0, MAX_PROGRAMS).filter((entry) => entry !== null && typeof entry === 'object'
    && !Array.isArray(entry) && typeof entry.name === 'string' && entry.name.trim() !== '')
  // Root-level defaults: JVM flags shared by every program (memory, GC, agents).
  const rawDefaults = parsed.defaults !== null && typeof parsed.defaults === 'object' && !Array.isArray(parsed.defaults)
    ? parsed.defaults
    : undefined
  const defaults = rawDefaults === undefined
    ? undefined
    : { jvmArgs: normalizeStringArray(rawDefaults.jvmArgs) }
  return { path, exists: true, entries, defaults, error: undefined }
}

/**
 * Normalize a user string list (`jvmArgs`) — strings only, trimmed, empties dropped.
 * @param value - anything the config carried.
 * @returns the cleaned list, or `undefined` when empty/invalid.
 */
export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return out.length === 0 ? undefined : out
}

/** Normalize a user `env` map to string→string, or `undefined` when empty. */
export function normalizeEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key !== '' && typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Compare one config `dir` with a program's workspace-relative dir. */
function sameDir(entryDir, relDir) {
  if (typeof entryDir !== 'string' || entryDir.trim() === '') return false
  const norm = (value) => String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return norm(entryDir) === norm(relDir)
}

/** Normalize a config/program dir to a workspace-relative form (or `undefined`). */
export function normalizeRelDir(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const norm = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return norm === '' ? '.' : norm
}

/**
 * The config entry matching one candidate (a discovered program or a generated
 * doc entry), by precedence: exact `id`, then `dir` (+ kind), then `name`.
 * @param entries - config rows.
 * @param candidate - `{ id, kind, name, relDir }`.
 * @param used - indexes already taken by another program.
 * @returns the index in `entries`, or `-1`.
 */
export function findConfigEntryIndex(entries, candidate, used) {
  const free = (at) => !used.has(at)
  const byId = entries.findIndex((entry, at) => free(at) && typeof entry.id === 'string' && entry.id !== '' && entry.id === candidate.id)
  if (byId !== -1) return byId
  const relDir = normalizeRelDir(candidate.relDir)
  if (relDir !== undefined) {
    const byDir = entries.findIndex((entry, at) => free(at) && normalizeRelDir(entry.dir) === relDir
      && (entry.kind === undefined || entry.kind === candidate.kind))
    if (byDir !== -1) return byDir
  }
  return entries.findIndex((entry, at) => free(at) && entry.name === candidate.name)
}

/**
 * How far the config drifted from the current workspace scan.
 *
 * `new` = runnable programs with no config entry (they would run from scan
 * defaults); `missing` = auto-generated entries whose program is gone (user
 * entries that carry a `startCommand` are never "missing" — they are additions);
 * `changed` = matched entries whose scanned identity fields moved.
 *
 * @param discovered - raw discovery results.
 * @param entries - config rows.
 * @param workspace - absolute workspace root.
 * @returns `{ stale, added, missing, changed, manual }` (names for display).
 */
export function detectConfigDrift(discovered, entries, workspace) {
  const used = new Set()
  const added = []
  const changed = []
  for (const program of discovered) {
    const index = findConfigEntryIndex(entries, { id: program.id, kind: program.kind, name: program.name, relDir: program.relDir }, used)
    if (index === -1) {
      added.push(program.name)
      continue
    }
    used.add(index)
    const entry = entries[index]
    if (typeof entry.mainClass === 'string' && program.mainClass !== undefined && entry.mainClass !== program.mainClass) changed.push(program.name)
    else if (typeof entry.script === 'string' && program.script !== undefined && entry.script !== program.script) changed.push(program.name)
    else if (typeof entry.packageManager === 'string' && program.packageManager !== undefined && entry.packageManager !== program.packageManager) changed.push(program.name)
    else if (typeof entry.mainClass === 'string' && program.mainClass === undefined) changed.push(program.name)
    else if (typeof entry.script === 'string' && program.script === undefined) changed.push(program.name)
  }
  const missing = []
  const manual = []
  entries.forEach((entry, index) => {
    if (used.has(index)) return
    const isManual = typeof entry.startCommand === 'string' && entry.startCommand.trim() !== ''
    if (isManual) manual.push(entry.name)
    else missing.push(entry.name)
  })
  return {
    stale: added.length > 0 || missing.length > 0 || changed.length > 0,
    added,
    missing,
    changed,
    manual,
  }
}

/**
 * Refresh a generated document from a fresh scan while preserving the user's
 * edits: matched entries keep `name`/`logName`/`args`/`env`/`startCommand`/
 * `stopGraceMs`/`disabled`; user-added entries (`startCommand`) are carried over
 * verbatim; auto entries whose program disappeared are dropped.
 * @param nextDoc - `buildConfigDocument(scanPrograms(...))` of the current scan.
 * @param oldEntries - the existing config rows.
 * @param workspace - absolute workspace root.
 * @returns the updated document.
 */
export function mergeConfigDocuments(nextDoc, oldEntries, workspace) {
  const used = new Set()
  for (const entry of nextDoc.programs) {
    const index = findConfigEntryIndex(oldEntries, {
      id: entry.id, kind: entry.kind, name: entry.name, relDir: normalizeRelDir(entry.dir),
    }, used)
    if (index === -1) continue
    used.add(index)
    const old = oldEntries[index]
    for (const key of ['name', 'logName', 'args', 'env', 'startCommand', 'stopGraceMs', 'disabled', 'jvmArgs']) {
      if (old[key] !== undefined) entry[key] = old[key]
    }
    // Keep the user's JVM flags (memory, GC) exactly, but cleaned.
    entry.jvmArgs = normalizeStringArray(entry.jvmArgs) ?? []
    // An old generated config may point additional-location at the workspace
    // root; an update rewrites it to the program's project-root local.yml.
    if (Array.isArray(entry.args) && entry.kind === 'spring') {
      entry.args = normalizeSpringArgs(entry.args, workspace, resolve(workspace, entry.dir))
    }
  }
  oldEntries.forEach((entry, index) => {
    if (used.has(index)) return
    if (typeof entry.startCommand === 'string' && entry.startCommand.trim() !== '') {
      nextDoc.programs.push(entry)
    }
  })
  return nextDoc
}

/**
 * Merge the user config over the discovered programs.
 *
 * Matching order per discovered program: exact `id`, then `dir` (+ kind), then
 * `name`. Leftover entries become user-added programs (`kind: manual` unless they
 * name a kind). A `manual` entry needs `startCommand`; a `spring`/`frontend`
 * entry needs `dir` (plus `mainClass`/`script`).
 *
 * @param discovered - discovery results (already carrying `logName`).
 * @param entries - config rows from {@link readProgramConfig}.
 * @param workspace - absolute workspace root.
 * @returns merged program list.
 */
export function mergeProgramConfig(discovered, entries, workspace, defaults) {
  const defaultJvmArgs = normalizeStringArray(defaults?.jvmArgs)
  const used = new Set()
  const out = []
  for (const program of discovered) {
    const index = findConfigEntryIndex(entries, {
      id: program.id, kind: program.kind, name: program.name, relDir: program.relDir,
    }, used)
    if (index === -1) {
      out.push(program)
      continue
    }
    used.add(index)
    const entry = entries[index]
    if (entry.disabled === true) continue
    const merged = Object.assign({}, program, { overridden: true })
    if (typeof entry.name === 'string' && entry.name.trim() !== '') merged.name = entry.name.trim()
    if (typeof entry.logName === 'string' && entry.logName.trim() !== '') merged.logName = entry.logName.trim()
    if (typeof entry.mainClass === 'string' && entry.mainClass.trim() !== '') {
      merged.mainClass = entry.mainClass.trim()
      merged.mainClassFromConfig = true
    }
    if (typeof entry.script === 'string' && entry.script.trim() !== '') merged.script = entry.script.trim()
    if (typeof entry.packageManager === 'string' && entry.packageManager.trim() !== '') merged.packageManager = entry.packageManager.trim()
    if (typeof entry.dir === 'string' && entry.dir.trim() !== '') merged.dir = resolve(workspace, entry.dir)
    if (Array.isArray(entry.args)) merged.args = entry.args.filter((arg) => typeof arg === 'string')
    const env = normalizeEnv(entry.env)
    if (env !== undefined) merged.env = env
    if (typeof entry.startCommand === 'string' && entry.startCommand.trim() !== '') merged.startCommand = entry.startCommand
    if (Number.isFinite(entry.stopGraceMs)) merged.stopGraceMs = entry.stopGraceMs
    const jvmArgs = normalizeStringArray(entry.jvmArgs) ?? defaultJvmArgs
    if (jvmArgs !== undefined) merged.jvmArgs = jvmArgs
    out.push(merged)
  }
  entries.forEach((entry, index) => {
    if (used.has(index) || entry.disabled === true) return
    const kind = entry.kind === 'spring' || entry.kind === 'frontend' ? entry.kind : 'manual'
    const startCommand = typeof entry.startCommand === 'string' && entry.startCommand.trim() !== '' ? entry.startCommand : undefined
    if (kind === 'manual' && startCommand === undefined) return
    if ((kind === 'spring' || kind === 'frontend') && (typeof entry.dir !== 'string' || entry.dir.trim() === '')) return
    const dir = typeof entry.dir === 'string' && entry.dir.trim() !== '' ? resolve(workspace, entry.dir) : workspace
    const logName = typeof entry.logName === 'string' && entry.logName.trim() !== ''
      ? sanitizeLogName(entry.logName)
      : sanitizeLogName(entry.name)
    out.push({
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `config:${logName}`,
      kind,
      name: entry.name.trim(),
      project: 'config',
      dir,
      relDir: relative(workspace, dir) || '.',
      mainClass: typeof entry.mainClass === 'string' && entry.mainClass !== '' ? entry.mainClass : undefined,
      mainClassFromConfig: typeof entry.mainClass === 'string' && entry.mainClass !== '' ? true : undefined,
      script: typeof entry.script === 'string' && entry.script !== '' ? entry.script : undefined,
      packageManager: typeof entry.packageManager === 'string' && entry.packageManager !== ''
        ? entry.packageManager
        : detectPackageManager(dir, workspace),
      logName,
      args: Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === 'string') : undefined,
      env: normalizeEnv(entry.env),
      startCommand,
      stopGraceMs: Number.isFinite(entry.stopGraceMs) ? entry.stopGraceMs : undefined,
      jvmArgs: normalizeStringArray(entry.jvmArgs) ?? defaultJvmArgs,
      launch: null,
      fromConfig: true,
    })
  })
  return out
}

/**
 * The config document a scan writes: one editable entry per discovered program,
 * carrying the effective start/stop parameters.
 * @param programs - merged program list from {@link scanPrograms}.
 * @returns `{ version, programs: [...] }` ready for JSON serialization.
 */
export function buildConfigDocument(programs, workspace) {
  const entries = programs.filter((program) => program.kind !== 'instance').map((program) => {
    const entry = { id: program.id, name: program.name, kind: program.kind, dir: program.relDir }
    if (program.kind === 'spring') entry.mainClass = program.mainClass
    if (program.kind === 'frontend') {
      entry.script = program.script
      entry.packageManager = program.packageManager
    }
    if (program.logName !== sanitizeLogName(program.name)) entry.logName = program.logName
    // The generated args are what a start would actually use: the project-root
    // `local.yml`, not whatever a stale launch.json said.
    const args = program.kind === 'spring'
      ? resolveSpringArgs(program, workspace ?? program.dir)
      : (Array.isArray(program.args) && program.args.length > 0 ? program.args : undefined)
    if (args !== undefined) entry.args = args
    entry.env = program.env ?? {}
    entry.startCommand = program.startCommand ?? null
    entry.jvmArgs = normalizeStringArray(program.jvmArgs) ?? []
    entry.stopGraceMs = Number.isFinite(program.stopGraceMs) ? program.stopGraceMs : DEFAULT_STOP_GRACE_MS
    entry.disabled = false
    return entry
  })
  return { version: 1, defaults: { jvmArgs: [] }, programs: entries }
}

/** Write the generated config (refuses to clobber an existing file unless asked). */
async function writeProgramConfig(cwd, logsDir, mode, fresh = false) {
  if (fresh) discoveryCache.delete(resolve(cwd))
  const path = resolve(cwd, CONFIG_FILENAME)
  const exists = existsSync(path)
  if (exists && mode !== 'update' && mode !== 'overwrite') {
    throw new TailError('config-exists', `${path} 已存在；更新请用 mode: "update"，覆盖请用 mode: "overwrite"`, 409)
  }
  // Always start from the RAW scan: `generate`/`overwrite` must not re-merge the
  // very config file they are replacing, and `update` overlays the old entries
  // itself (which is also what keeps user additions once, not twice).
  const discovered = await discoverPrograms(cwd)
  let doc = buildConfigDocument(discovered, cwd)
  if (exists && mode === 'update') {
    const old = await readProgramConfig(cwd)
    doc = mergeConfigDocuments(doc, old.entries, cwd)
    // Keep the user's root-level defaults (global JVM flags) across an update.
    if (old.defaults !== undefined) doc.defaults = old.defaults
  }
  await writeFile(path, `${CONFIG_HEADER}${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  return { path, count: doc.programs.length, mode: exists ? mode : 'generate' }
}

/**
 * One request: write the user-editable config from a fresh scan.
 * Body `{ sessionId, dir?, cwd?, overwrite? }`; refuses an existing file unless
 * `overwrite: true`.
 */
async function serveConfig(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const rawDir = typeof body.dir === 'string' && body.dir !== '' ? body.dir : 'logs'
    const logsDir = resolvePath(cwd, rawDir, true)
    const mode = body.mode === 'update' || body.mode === 'overwrite'
      ? body.mode
      : (body.overwrite === true ? 'overwrite' : undefined)
    const written = await writeProgramConfig(cwd, logsDir, mode, true)
    writeJson(res, 200, { ok: true, path: written.path, count: written.count, mode: written.mode })
  } catch (error) {
    writeTailError(res, error)
  }
}

// ── Pending "open log in the sidebar" requests ──────────────────────────────
//
// The browser half cannot be commanded directly: `ris_dev_logs` (a model tool)
// queues the request here and the client plugin drains `GET /opens` on a short
// interval, then opens the log through the sidebar service. Consume-on-read.
const OPEN_QUEUE_LIMIT = 32
const openQueue = []

/** Queue one sidebar-open request for the browser half. */
export function enqueueOpen(request) {
  if (openQueue.length >= OPEN_QUEUE_LIMIT) openQueue.shift()
  openQueue.push(request)
}

/** Take every pending open request (the browser half drains this). */
export function takePendingOpens() {
  return openQueue.splice(0, openQueue.length)
}

/**
 * The model-facing tool surface: list / start / stop / open-log, built on the
 * same core as the panel routes. Registered only when `ctx.tools` exists; the
 * program is always resolved by a fresh scan on the host, so the model cannot
 * run anything the workspace does not already describe.
 * @param ctx - Host context carrying `tools` and `sessions`.
 * @param options - `{ agentTools, stopGraceMs }` (see {@link apply}).
 * @returns a disposer that unregisters every tool.
 */
/** This package's version (the skill reports it, so drift is attributable). */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/** Directory name AND frontmatter `name` of the bundled skill. */
const SKILL_NAME = 'dsh-ris-ide-debug'

/** The SKILL.md shipped inside this package (`<pkg>/skills/<name>/SKILL.md`). */
function bundledSkillPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME, 'SKILL.md')
}

/** Whether `child` is `parent` or under it (both resolved). */
function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * The project root DSH's skill-filesystem provider would use: the nearest
 * ancestor carrying `.git` / `.dsh` / `.agents`, else the cwd itself.
 * @param {string} start - the session workspace.
 * @returns {Promise<string>} the root directory.
 */
async function findProjectRoot(start) {
  let current = resolve(start)
  for (let depth = 0; depth < 40; depth += 1) {
    for (const marker of ['.git', '.dsh', '.agents']) {
      const found = await stat(join(current, marker)).then(() => true).catch(() => false)
      if (found) return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(start)
}

/**
 * The skill ROOT (the directory that holds `<name>/SKILL.md`) for one target.
 * `project` = `<projectRoot>/.dsh/skills`, `agents` = `<projectRoot>/.agents/skills`,
 * `user` = `~/.dsh/skills`, `user-agents` = `~/.agents/skills`; an explicit `dir`
 * wins and must stay inside the workspace or the home directory.
 * @param {string} cwd - the session workspace.
 * @param {string|undefined} target - one of the four names (default `project`).
 * @param {string|undefined} dir - explicit skill root (absolute, or cwd-relative).
 * @returns {Promise<{root: string, target: string}>} the resolved root.
 */
async function skillRootFor(cwd, target, dir) {
  if (typeof dir === 'string' && dir !== '') {
    const root = isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir)
    if (!isWithin(cwd, root) && !isWithin(homedir(), root)) {
      throw new TailError('bad-path', `refusing to install outside the workspace or home: ${root}`, 400)
    }
    return { root, target: 'custom' }
  }
  if (target === 'user' || target === 'user-dsh') return { root: resolve(homedir(), '.dsh', 'skills'), target: 'user' }
  if (target === 'user-agents') return { root: resolve(homedir(), '.agents', 'skills'), target: 'user-agents' }
  const projectRoot = await findProjectRoot(cwd)
  if (target === 'agents' || target === 'project-agents') {
    return { root: resolve(projectRoot, '.agents', 'skills'), target: 'agents' }
  }
  return { root: resolve(projectRoot, '.dsh', 'skills'), target: 'project' }
}

/** Root descriptors the skill can live in, resolved for one workspace. */
async function skillRootsFor(cwd) {
  const projectRoot = await findProjectRoot(cwd)
  return [
    { root: resolve(projectRoot, '.dsh', 'skills'), target: 'project' },
    { root: resolve(projectRoot, '.agents', 'skills'), target: 'agents' },
    { root: resolve(homedir(), '.dsh', 'skills'), target: 'user' },
    { root: resolve(homedir(), '.agents', 'skills'), target: 'user-agents' },
  ]
}

/**
 * AUTO-UPDATE: bring every EXISTING installed copy up to the bundled content.
 *
 * This is what makes the skill track plugin releases: a copy the user installed
 * once is refreshed whenever the plugin changes, without asking and without ever
 * creating a copy nobody asked for (`install` remains the explicit create path).
 * Failures are reported per root, never thrown — a read-only home must not break
 * the tools.
 * @param {string} cwd - the session workspace (locates the project roots).
 * @returns {Promise<Array<{root: string, target: string, path: string, existed: boolean, changed: boolean, upToDate: boolean, error?: string}>>}
 */
async function syncInstalledSkills(cwd) {
  const bundled = await readFile(bundledSkillPath(), 'utf8').catch(() => undefined)
  if (bundled === undefined) return []
  const roots = await skillRootsFor(cwd)
  const out = []
  for (const entry of roots) {
    const path = join(entry.root, SKILL_NAME, 'SKILL.md')
    const installed = await readFile(path, 'utf8').catch(() => undefined)
    if (installed === undefined) {
      out.push({ root: entry.root, target: entry.target, path, existed: false, changed: false, upToDate: false })
      continue
    }
    if (installed === bundled) {
      out.push({ root: entry.root, target: entry.target, path, existed: true, changed: false, upToDate: true })
      continue
    }
    try {
      await writeFile(path, bundled, 'utf8')
      out.push({ root: entry.root, target: entry.target, path, existed: true, changed: true, upToDate: true })
    } catch (error) {
      // Present but unwritable (read-only home / another user's file) is NOT
      // "not installed": say so, or a stale copy would look absent.
      out.push({
        root: entry.root, target: entry.target, path, existed: true, changed: false, upToDate: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return out
}

/** One auto-sync per workspace per process (the tools call this fire-and-forget). */
const syncedWorkspaces = new Set()
function kickAutoSync(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return
  if (syncedWorkspaces.has(cwd)) return
  syncedWorkspaces.add(cwd)
  void syncInstalledSkills(cwd).catch(() => { /* auto-update is best effort */ })
}

/** Whether the installed copy exists and equals the bundled one. */
async function skillFileState(root) {
  const path = join(root, SKILL_NAME, 'SKILL.md')
  const [installed, bundled] = await Promise.all([
    readFile(path, 'utf8').then((text) => ({ text })).catch(() => undefined),
    readFile(bundledSkillPath(), 'utf8').then((text) => ({ text })).catch(() => undefined),
  ])
  return {
    path,
    exists: installed !== undefined,
    upToDate: installed !== undefined && bundled !== undefined && installed.text === bundled.text,
    bytes: installed === undefined ? 0 : Buffer.byteLength(installed.text),
    source: bundled === undefined ? undefined : bundledSkillPath(),
    content: installed === undefined ? undefined : installed.text,
  }
}

/**
 * Write the bundled SKILL.md into one skill root (idempotent).
 * @param {string} cwd - the session workspace.
 * @param {string|undefined} target - see {@link skillRootFor}.
 * @param {string|undefined} dir - explicit skill root.
 * @returns {Promise<object>} `{ path, root, target, changed, bytes }`.
 */
async function installSkill(cwd, target, dir) {
  const content = await readFile(bundledSkillPath(), 'utf8')
  const { root, target: resolved } = await skillRootFor(cwd, target, dir)
  const path = join(root, SKILL_NAME, 'SKILL.md')
  const previous = await readFile(path, 'utf8').catch(() => undefined)
  if (previous === content) return { ok: true, path, root, target: resolved, changed: false, bytes: Buffer.byteLength(content) }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return { ok: true, path, root, target: resolved, changed: true, bytes: Buffer.byteLength(content) }
}

export function registerAgentTools(ctx, options) {
  if (options?.agentTools === false) return () => {}
  if (typeof ctx.tools?.register !== 'function') {
    ctx.logger?.warn?.('dsh-ris-ide: ctx.tools is missing; agent tools stay unregistered')
    return () => {}
  }
  const disposers = []
  const register = (definition) => {
    try {
      disposers.push(ctx.tools.register(definition))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ris-ide: tool ${definition.name} not registered: ${describe(error)}`)
    }
  }
  const scopeOf = (exec) => {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TailError('no-session', 'this tool needs a live agent session', 400)
    }
    return { sessionId, cwd: resolveCwd(ctx, sessionId) }
  }
  const text = (value) => [{ type: 'text', text: value }]
  const LOOSE_OUTPUT = {
    type: 'object',
    additionalProperties: true,
    properties: { ok: { type: 'boolean' } },
  }

  register({
    name: 'ris_dev_programs',
    description: 'List the runnable programs discovered in the session workspace: Spring Boot @SpringBootApplication entry points and frontend package.json scripts. '
      + 'Shows each program id, name, kind, directory, running state and log path. '
      + 'Follow up with ris_dev_start / ris_dev_stop / ris_dev_logs using the returned id (or name).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: 'Re-scan the workspace instead of reusing the 15s discovery cache.' },
        runningOnly: { type: 'boolean', description: 'Only list programs that are currently running.' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderProgramList(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      // Plugin upgrade => refresh any skill copy this workspace installed.
      kickAutoSync(cwd)
      const logsDir = resolvePath(cwd, 'logs', true)
      let programs = await scanPrograms(cwd, logsDir, args?.refresh === true)
      if (args?.runningOnly === true) programs = programs.filter((program) => program.running?.alive === true)
      return jsonSafe({ ok: true, root: cwd, dir: logsDir, programs: programRows(programs) })
    },
  })

  register({
    name: 'ris_dev_start',
    description: 'Start one discovered program (Spring Boot: mvn -Pdev compile then exec java; frontend: exec <pm> run <script>), wrapped by run-with-log.sh so it gets a log file, a pidfile and the sidebar stop button. '
      + 'Resolve the program with ris_dev_programs and check ris_dev_status first; give its id, or a unique name fragment. '
      + 'Starting an already-running program is NOT an error: it returns alreadyRunning=true without touching it; use ris_dev_restart to restart it. '
      + 'JVM options (memory, GC) come from the workspace config `.dsh-ris-ide.json` (`defaults.jvmArgs` / per-program `jvmArgs`), not from this call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderStart(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      const program = resolveProgramRef(await scanPrograms(cwd, logsDir, false), args)
      if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
      const result = await startProgram(cwd, logsDir, program, options)
      return jsonSafe({
        ok: true,
        alreadyRunning: result.alreadyRunning === true,
        program: programRow(result.program),
      })
    },
  })

  register({
    name: 'ris_dev_stop',
    description: 'Stop the service behind one discovered program (or one log path): TERM its run-with-log.sh wrapper, wait the grace period recorded in the pidfile, then KILL. '
      + 'Only a process whose /proc cmdline is run-with-log.sh is ever signalled.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
        path: { type: 'string', description: 'A log path instead of a program (absolute or relative to the session cwd).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderStop(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      let logPath
      if (typeof args?.path === 'string' && args.path !== '') {
        logPath = resolvePath(cwd, args.path, options?.restrictToCwd === true)
      } else {
        const program = resolveProgramRef(await scanPrograms(cwd, logsDir, false), args)
        if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
        logPath = program.logPath
      }
      const outcome = await stopLogPath(logPath, options?.stopGraceMs)
      return jsonSafe(Object.assign({ ok: true, path: logPath }, outcome))
    },
  })

  register({
    name: 'ris_dev_logs',
    description: 'Read the tail of one program log (default last 80 lines) and, unless open=false, ask the sidebar to open that log in its live viewer. '
      + 'Works for a program id/name or a log path; reports whether the program is currently running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
        path: { type: 'string', description: 'A log path instead of a program.' },
        lines: { type: 'number', description: 'How many lines to return (default 80, max 500).' },
        open: { type: 'boolean', description: 'Queue the sidebar open (default true); pass false to read a log without popping any UI.' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderLogs(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { sessionId, cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      let logPath
      let title
      if (typeof args?.path === 'string' && args.path !== '') {
        logPath = resolvePath(cwd, args.path, options?.restrictToCwd === true)
        title = basename(logPath)
      } else {
        const program = resolveProgramRef(await scanPrograms(cwd, logsDir, false), args)
        if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
        logPath = program.logPath
        title = `${program.name} 日志`
      }
      const service = await readService(logPath)
      const running = service !== undefined && service.alive === true
      let content = ''
      if (existsSync(logPath)) {
        const tail = await readTail(logPath, 256 * 1024)
        const lines = tail.content.split('\n')
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const count = Math.min(Math.max(Number(args?.lines) || 80, 1), 500)
        content = lines.slice(Math.max(0, lines.length - count)).join('\n')
      }
      const opened = args?.open !== false
      if (opened) enqueueOpen({ sessionId, cwd, logPath, title })
      return jsonSafe({
        ok: true,
        path: logPath,
        exists: existsSync(logPath),
        running,
        opened,
        pid: service !== undefined ? service.pid : null,
        content,
      })
    },
  })

  register({
    name: 'ris_dev_status',
    description: 'Report whether a program is running (pid, uptime, log path, and the localhost URL the dev server logged) — or list every program with its state. '
      + 'Call this before ris_dev_start to avoid a duplicate start, and before ris_dev_restart to know whether anything is up.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
        path: { type: 'string', description: 'A log path instead of a program.' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderStatus(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      if (typeof args?.path === 'string' && args.path !== '') {
        const logPath = resolvePath(cwd, args.path, options?.restrictToCwd === true)
        return jsonSafe(await logStatus(logPath))
      }
      const programs = await scanPrograms(cwd, logsDir, false)
      if (hasRef(args)) {
        const program = resolveProgramRef(programs, args)
        if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
        return jsonSafe(await programStatus(program))
      }
      const running = []
      const stopped = []
      for (const program of programs) {
        const row = await programStatus(program)
        if (row.running) running.push(row)
        else stopped.push({ id: row.id, name: row.name, kind: row.kind, dir: row.relDir, logPath: row.logPath })
      }
      return jsonSafe({ ok: true, root: cwd, dir: logsDir, total: programs.length, running, stopped })
    },
  })

  register({
    name: 'ris_dev_restart',
    description: 'Restart one discovered program: stop it if it is running (pidfile protocol, whole process group), wait for it to go, then start it again through run-with-log.sh. '
      + 'When it is not running this simply starts it, so the command is safe to call either way. Check ris_dev_status first if you need the current state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderRestart(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      const program = resolveProgramRef(await scanPrograms(cwd, logsDir, false), args)
      if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
      if (program.kind === 'instance') throw new TailError('not-startable', 'this row is a log of an instance started outside the panel', 400)
      const wasRunning = program.running !== null && program.running !== undefined && program.running.alive === true
      const stopped = wasRunning ? await stopLogPath(program.logPath, options?.stopGraceMs) : null
      // Re-scan: the row above still says "running"; start needs the live state.
      const fresh = (await scanPrograms(cwd, logsDir, false)).find((entry) => entry.id === program.id) ?? program
      const started = await startProgram(cwd, logsDir, fresh, options)
      return jsonSafe({
        ok: true,
        restarted: wasRunning,
        stopped,
        alreadyRunning: started.alreadyRunning === true,
        program: programRow(started.program),
      })
    },
  })

  register({
    name: 'ris_dev_debug',
    description: 'Debug one discovered Java (Spring Boot) program over JDWP: start it in debug mode, set line breakpoints, '
      + 'pause/resume/step, and inspect threads, stack frames and variables. '
      + 'START HERE: action "state" {id|name|path} returns the program row (running/pid/rss), the JDWP session state '
      + '(attached/port/suspended) AND every breakpoint (live and pre-set) in one call — check it before debugging. '
      + 'actions: state | start {id|name, suspend?} | stop {path|id|name} | status | poll {since?} | breakpoints | open {id|name} (open the workbench tab) | '
      + 'breakpoint_add {className, line, suspendPolicy?} | breakpoint_remove {requestId, or className+line} | breakpoint_clear | '
      + 'threads | stack {threadId, max?} | variables {threadId, frameIndex?} | step {kind: over|into|out, threadId?} | '
      + 'resume {threadId?} | pause. The program must have been started with action "start" (debug mode restarts it on a '
      + 'free loopback JDWP port). Line breakpoints use the Java class name (e.g. cn.com.ris.cloud.model.ModelHelper), not a file path. '
      + 'None of these actions open or pop the IDE: the workbench tab is opened ONLY by action "open" — debug silently and call '
      + '"open" just when the user asks to watch the process (an already-open workbench follows along by itself). '
      + 'A program whose config carries a custom startCommand must include the ${JDWP_ARGS} placeholder after `java` to be debuggable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['state', 'start', 'stop', 'status', 'poll', 'breakpoints', 'breakpoint_add', 'breakpoint_remove', 'breakpoint_clear', 'threads', 'stack', 'variables', 'step', 'resume', 'pause', 'open'],
          description: 'What to do; see the tool description for each action.',
        },
        id: { type: 'string', description: 'Program id from ris_dev_programs.' },
        name: { type: 'string', description: 'Program name (exact, or a unique fragment).' },
        path: { type: 'string', description: 'Program log path (alternative to id/name).' },
        className: { type: 'string', description: 'Fully-qualified Java class for breakpoint_add (or to identify one for breakpoint_remove).' },
        line: { type: 'number', description: 'Source line for breakpoint_add (or to identify one for breakpoint_remove).' },
        suspendPolicy: { type: 'string', enum: ['thread', 'all'], description: 'Breakpoint suspend policy (default thread).' },
        requestId: { type: 'number', description: 'Breakpoint request id for breakpoint_remove; omit it and pass className+line instead to remove a pre-set/live breakpoint by its source location.' },
        threadId: { type: 'string', description: 'Thread id (from threads/stack) for stack/variables/step/resume.' },
        frameIndex: { type: 'number', description: 'Stack frame index for variables (default 0).' },
        max: { type: 'number', description: 'Max stack frames to return (default 50).' },
        suspend: { type: 'boolean', description: 'start: suspend the JVM until resumed (default false).' },
        since: { type: 'number', description: 'poll: only events with seq greater than this.' },
        kind: { type: 'string', enum: ['over', 'into', 'out'], description: 'step kind (default over).' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderDebug(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { sessionId, cwd } = scopeOf(exec)
      const logsDir = resolvePath(cwd, 'logs', true)
      const action = String(args?.action ?? '')
      const findProgram = async () => {
        const program = resolveProgramRef(await scanPrograms(cwd, logsDir, false), args)
        if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
        return program
      }
      const logPathOf = async () => {
        if (typeof args?.path === 'string' && args.path !== '') {
          return resolvePath(cwd, args.path, options?.restrictToCwd === true)
        }
        return (await findProgram()).logPath
      }
      try {
        if (action === 'state') {
          // One call that answers "can I debug this, and from what?" before anything
          // is started: the program row (running/pid/rss), the JDWP session state and
          // every breakpoint (live ones plus pre-set ones that wait for the next attach).
          const program = await findProgram()
          const session = debugSessions.status(program.logPath)
          return jsonSafe({
            ok: true,
            program: programRow(program),
            running: program.running ?? null,
            debuggable: program.kind === 'spring',
            debug: session,
            breakpoints: debugSessions.listBreakpoints(program.logPath),
            pendingBreakpoints: debugSessions.pendingCount(program.logPath),
          })
        }
        if (action === 'start') {
          const program = await findProgram()
          return jsonSafe({ ok: true, ...await startProgramDebug(cwd, logsDir, program, Object.assign({}, options, {
            debugSuspend: args?.suspend === undefined || args?.suspend === null ? undefined : args.suspend === true,
          })) })
        }
        if (action === 'stop') return jsonSafe({ ok: true, ...await debugSessions.detach(await logPathOf()) })
        if (action === 'status') return jsonSafe({ ok: true, ...debugSessions.status(await logPathOf()) })
        if (action === 'poll') return jsonSafe({ ok: true, ...debugSessions.poll(await logPathOf(), Number(args?.since) || 0) })
        if (action === 'breakpoints') return jsonSafe({ ok: true, breakpoints: debugSessions.listBreakpoints(await logPathOf()) })
        if (action === 'breakpoint_add') {
          const breakpoint = await debugSessions.addBreakpoint(await logPathOf(), args?.className, args?.line, args?.suspendPolicy)
          return jsonSafe({ ok: true, breakpoint })
        }
        if (action === 'breakpoint_remove') {
          return jsonSafe({
            ok: true,
            ...await debugSessions.removeBreakpoint(await logPathOf(), args?.requestId, args?.className, args?.line),
          })
        }
        if (action === 'breakpoint_clear') return jsonSafe({ ok: true, ...await debugSessions.clearBreakpoints(await logPathOf()) })
        if (action === 'threads') return jsonSafe({ ok: true, threads: await debugSessions.threads(await logPathOf()) })
        if (action === 'stack') return jsonSafe({ ok: true, frames: await debugSessions.stack(await logPathOf(), args?.threadId, 0, args?.max) })
        if (action === 'variables') return jsonSafe({ ok: true, variables: await debugSessions.variables(await logPathOf(), args?.threadId, Number(args?.frameIndex) || 0) })
        if (action === 'step') return jsonSafe({ ok: true, ...await debugSessions.step(await logPathOf(), args?.kind ?? 'over', args?.threadId) })
        if (action === 'resume') return jsonSafe({ ok: true, ...await debugSessions.resume(await logPathOf(), args?.threadId) })
        if (action === 'pause') return jsonSafe({ ok: true, ...await debugSessions.pause(await logPathOf()) })
        if (action === 'open') {
          const program = await findProgram()
          enqueueOpen({
            kind: 'program',
            sessionId,
            cwd,
            programId: program.id,
            programKind: program.kind,
            logPath: program.logPath,
            title: program.name,
          })
          return jsonSafe({ ok: true, opened: true, program: programRow(program) })
        }
        throw new TailError('bad-argument', `unknown action "${action}"`, 400)
      } catch (error) {
        if (error instanceof DebugError) throw new TailError(error.code, error.message, debugErrorStatus(error.code))
        throw error
      }
    },
  })

  register({
    name: 'ris_dev_skill',
    description: 'The `dsh-ris-ide-debug` skill — how to operate this IDE (list/start/stop programs, read live logs, debug Java over JDWP: breakpoints, threads, stack, variables, stepping) — ships INSIDE this plugin. '
      + '`sync` (the DEFAULT) auto-updates every EXISTING installed copy to the bundled content, so the skill tracks plugin releases; `install` creates/refreshes one at a chosen target (idempotent); '
      + '`status` reports every candidate root (installed? up to date?); `show` returns the bundled SKILL.md text without writing anything; `uninstall` removes one. '
      + 'Explicit installs are also refreshed automatically: the host syncs existing copies on the first ris_dev_* call of each workspace, so upgrading the plugin upgrades the skill. '
      + 'targets: "project" (default) = <projectRoot>/.dsh/skills, "agents" = <projectRoot>/.agents/skills, "user" = ~/.dsh/skills, "user-agents" = ~/.agents/skills; '
      + '`dir` installs into an explicit skill root inside the workspace or home. The caller (agent or human) chooses the target — DSH watches those roots, so an installed skill shows up without a restart.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['sync', 'install', 'status', 'show', 'uninstall'],
          description: 'sync (default, auto-update existing copies) | install | status | show | uninstall.',
        },
        target: {
          type: 'string',
          enum: ['project', 'agents', 'user', 'user-agents'],
          description: 'Which skill root to use (default project = <projectRoot>/.dsh/skills).',
        },
        dir: { type: 'string', description: 'An explicit skill root directory (inside the workspace or home); overrides target.' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_args, value) => text(renderSkill(value)) },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const { cwd } = scopeOf(exec)
      const action = String(args?.action ?? 'sync')
      const target = typeof args?.target === 'string' ? args.target : undefined
      const dir = typeof args?.dir === 'string' ? args.dir : undefined
      if (action === 'sync') {
        const roots = await syncInstalledSkills(cwd)
        return jsonSafe({ ok: true, action: 'sync', source: bundledSkillPath(), roots, changed: roots.filter((root) => root.changed === true).length })
      }
      if (action === 'show') {
        const content = await readFile(bundledSkillPath(), 'utf8')
        return jsonSafe({ ok: true, action: 'show', source: bundledSkillPath(), bytes: Buffer.byteLength(content), content })
      }
        if (action === 'status') {
        const roots = []
        for (const name of ['project', 'agents', 'user', 'user-agents']) {
          const resolvedRoot = await skillRootFor(cwd, name, undefined)
          const state = await skillFileState(resolvedRoot.root)
          roots.push({
            target: name,
            root: resolvedRoot.root,
            path: state.path,
            exists: state.exists,
            upToDate: state.upToDate,
            bytes: state.bytes,
          })
        }
        if (dir !== undefined) {
          const custom = await skillRootFor(cwd, undefined, dir)
          const state = await skillFileState(custom.root)
          roots.push({ target: 'custom', root: custom.root, path: state.path, exists: state.exists, upToDate: state.upToDate, bytes: state.bytes })
        }
        return jsonSafe({ ok: true, action: 'status', source: bundledSkillPath(), pluginVersion: PKG_VERSION, roots })
      }
      if (action === 'install') {
        const result = await installSkill(cwd, target, dir)
        return jsonSafe(Object.assign({ action: 'install' }, result))
      }
      if (action === 'uninstall') {
        const { root, target: resolved } = await skillRootFor(cwd, target, dir)
        const path = join(root, SKILL_NAME, 'SKILL.md')
        const existed = await stat(path).then(() => true).catch(() => false)
        await rm(path, { force: true })
        await rm(dirname(path), { recursive: false, force: true }).catch(() => {})
        return jsonSafe({ ok: true, action: 'uninstall', root, target: resolved, path, removed: existed })
      }
      throw new TailError('bad-argument', `unknown action "${action}"`, 400)
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // a tool disposer failing on unload must not break the plugin teardown
      }
    }
  }
}

/** Does a tool argument object carry a program reference? */
function hasRef(ref) {
  return (typeof ref?.id === 'string' && ref.id !== '') || (typeof ref?.name === 'string' && ref.name !== '')
}

/** The localhost URL a dev server wrote into its log, when it did. */
async function logUrl(logPath) {
  if (!existsSync(logPath)) return undefined
  const tail = await readTail(logPath, 16 * 1024).catch(() => undefined)
  if (tail === undefined || typeof tail.content !== 'string') return undefined
  const matches = tail.content.match(/https?:\/\/localhost:\d+[^\s)"']*/g)
  return matches === null || matches.length === 0 ? undefined : matches[matches.length - 1]
}

/** Status of one log path (a program's fixed log, or an ad-hoc instance log). */
async function logStatus(logPath) {
  const service = await readService(logPath)
  return {
    ok: true,
    found: existsSync(logPath) || service !== undefined,
    path: logPath,
    running: service !== undefined && service.alive === true,
    pid: service !== undefined ? service.pid : null,
    wrapperPid: service !== undefined ? service.wrapperPid : null,
    startedAt: service !== undefined ? service.startedAt ?? null : null,
    uptimeMs: service !== undefined && Number.isFinite(service.startedAt) ? Date.now() - service.startedAt : null,
    url: await logUrl(logPath) ?? null,
  }
}

/** Status of one discovered program. */
async function programStatus(program) {
  const status = await logStatus(program.logPath)
  return {
    ok: true,
    found: true,
    id: program.id,
    name: program.name,
    kind: program.kind,
    project: program.project,
    dir: program.relDir,
    running: status.running,
    pid: status.pid,
    wrapperPid: status.wrapperPid,
    startedAt: status.startedAt,
    uptimeMs: status.uptimeMs,
    logPath: program.logPath,
    hasLog: status.found,
    url: status.url,
    restartable: program.kind !== 'instance',
  }
}

/**
 * Make a tool result losslessly JSON-serializable: `undefined` becomes `null`
 * (the dsh tool registry rejects a value that cannot round-trip, which is how
 * `ris_dev_programs` failed before).
 * @param value - any JSON-ish value.
 * @returns the same shape with no `undefined` in it.
 */
export function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item)
    return out
  }
  return String(value)
}

/** The compact row shape the model sees. */
export function programRows(programs) {
  return programs.map(programRow)
}

/** One compact program row. */
export function programRow(program) {
  return {
    id: program.id,
    name: program.name,
    kind: program.kind,
    project: program.project,
    dir: program.relDir,
    mainClass: program.mainClass,
    script: program.script,
    running: program.running !== null && program.running !== undefined && program.running.alive === true,
    pid: program.running !== null && program.running !== undefined ? program.running.pid : undefined,
    logPath: program.logPath,
    hasLog: program.hasLog === true,
    overridden: program.overridden === true,
    fromConfig: program.fromConfig === true,
  }
}

/**
 * Resolve a program by `id` (exact) or `name` (exact, then a unique fragment).
 * @throws {TailError} `ambiguous` when a fragment matches several programs.
 */
export function resolveProgramRef(programs, ref) {
  const id = typeof ref?.id === 'string' && ref.id !== '' ? ref.id : undefined
  if (id !== undefined) return programs.find((program) => program.id === id)
  const name = typeof ref?.name === 'string' && ref.name !== '' ? ref.name : undefined
  if (name === undefined) return undefined
  const exact = programs.filter((program) => program.name === name)
  if (exact.length === 1) return exact[0]
  const partial = programs.filter((program) => program.name.includes(name) || program.id.includes(name))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new TailError('ambiguous', `"${name}" matches: ${partial.map((program) => program.name).join(', ')}`, 409)
  }
  return undefined
}

/** Human sentence for one resolver failure. */
function describeRef(ref) {
  if (typeof ref?.id === 'string' && ref.id !== '') return `id "${ref.id}"`
  if (typeof ref?.name === 'string' && ref.name !== '') return `name "${ref.name}"`
  return '(no id or name)'
}

/** Render one program list for the model. */
function renderProgramList(value) {
  const programs = Array.isArray(value?.programs) ? value.programs : []
  if (programs.length === 0) return `No runnable programs under ${value?.root ?? '?'}.`
  const lines = [`${programs.length} program(s) under ${value.root} (logs: ${value.dir}):`]
  for (const program of programs) {
    lines.push(`- ${program.running ? '[running]' : '[stopped]'} ${program.name} (${program.kind}) id=${program.id}`)
    lines.push(`  dir=${program.dir}${program.mainClass ? ` main=${program.mainClass}` : ''}${program.script ? ` script=${program.script}` : ''} log=${program.logPath}`)
  }
  return lines.join('\n')
}

/** Render one start result for the model. */
function renderStart(value) {
  const program = value?.program
  if (program === undefined) return 'start returned no program'
  return `${value.alreadyRunning ? 'Already running' : 'Started'}: ${program.name} (pid ${program.pid ?? '?'}), log ${program.logPath}`
}

/** Render one stop result for the model. */
function renderStop(value) {
  if (value?.alreadyStopped === true) return `Already stopped: ${value.path}`
  return `Stopped${value?.forced ? ' (escalated to SIGKILL)' : ''}: ${value?.path} after ${value?.waitedMs ?? 0}ms`
}

/** Render one status result (single program, or the whole workspace). */
function renderStatus(value) {
  if (value === null || value === undefined) return 'no status'
  if (typeof value.total === 'number') {
    const running = Array.isArray(value.running) ? value.running : []
    const stopped = Array.isArray(value.stopped) ? value.stopped : []
    const lines = [`${running.length} running / ${value.total} program(s) under ${value.root}:`]
    for (const row of running) lines.push(`- RUNNING ${row.name} (${row.kind}) pid=${row.pid} up=${formatUptime(row.uptimeMs)}${row.url ? ` ${row.url}` : ''}`)
    for (const row of stopped) lines.push(`- stopped ${row.name} (${row.kind})`)
    return lines.join('\n')
  }
  if (value.found === false) return `no such program or log: ${value.path ?? '?'}`
  const head = `${value.running ? 'RUNNING' : 'stopped'} ${value.name ?? value.path}`
  const bits = []
  if (value.running) {
    bits.push(`pid ${value.pid}`)
    if (Number.isFinite(value.uptimeMs)) bits.push(`up ${formatUptime(value.uptimeMs)}`)
  }
  if (value.url) bits.push(value.url)
  bits.push(`log ${value.logPath ?? value.path}`)
  const tail = value.running
    ? 'Use ris_dev_restart to restart it, ris_dev_stop to stop it.'
    : 'Use ris_dev_start (or ris_dev_restart) to start it.'
  return [head, `  ${bits.join(' · ')}`, `  ${tail}`].join('\n')
}

/** Render one restart result for the model. */
function renderRestart(value) {
  const program = value?.program
  if (program === undefined) return 'restart returned no program'
  const stopped = value?.stopped
  const stopText = value?.restarted === true
    ? (stopped?.forced === true ? 'stopped (SIGKILL)' : 'stopped')
    : 'was not running'
  return `${value?.restarted === true ? 'Restarted' : 'Started'}: ${program.name} (${stopText}; pid ${program.pid ?? '?'}), log ${program.logPath}`
}

/** Compact uptime. */
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** Render one skill-tool result for the model. */
function renderSkill(value) {
  if (value === null || value === undefined) return 'no skill result'
  const action = value.action ?? 'sync'
  if (action === 'show') {
    return `dsh-ris-ide-debug skill (${value.bytes ?? 0} bytes, from ${value.source ?? '?'})\n\n${value.content ?? ''}`
  }
  if (action === 'sync') {
    const roots = Array.isArray(value.roots) ? value.roots : []
    if (roots.length === 0) return 'skill sync: nothing to do'
    const changed = roots.filter((root) => root.changed === true).length
    const lines = roots.map((root) => {
      const state = root.error !== undefined
        ? `failed (${root.error})`
        : root.existed !== true ? 'not installed' : root.changed === true ? 'updated' : 'up to date'
      return `  ${root.target} → ${root.path}: ${state}`
    })
    return `skill sync: ${changed} updated, ${roots.length} root(s) checked\n${lines.join('\n')}`
  }
  if (action === 'status') {
    const roots = Array.isArray(value.roots) ? value.roots : []
    if (roots.length === 0) return 'no skill roots resolved'
    return roots.map((root) => `${root.exists === true ? (root.upToDate === true ? '[up-to-date]' : '[outdated]  ') : '[not installed]'} ${root.target} → ${root.path}`).join('\n')
  }
  if (action === 'uninstall') {
    return value.removed === true ? `skill removed: ${value.path}` : `skill was not installed at ${value.path}`
  }
  return `${value.changed === true ? 'skill installed' : 'skill already up to date'}: ${value.path} (${value.bytes ?? 0} bytes, target: ${value.target ?? 'project'})`
}

/** Render one debug-tool result for the model. */
function renderDebug(value) {
  if (value === null || value === undefined) return 'no debug result'
  if (value.error !== undefined) return `debug error: ${value.error}`
  const parts = []
  // `state`: one line that answers "can I debug this program right now?".
  if (value.program !== undefined && value.program !== null && value.debug !== undefined && value.running !== undefined) {
    const program = value.program
    const running = value.running !== null && value.running !== undefined && value.running.alive === true
    parts.push(`${program.name} (${program.kind}${value.debuggable === false ? ', not debuggable' : ''}) · `
      + `${running ? `running pid ${value.running.pid ?? '?'}` : 'stopped'} · `
      + `${value.debug.attached === true ? `attached port ${value.debug.port ?? '?'}${value.debug.vmSuspended === true ? ' SUSPENDED' : ''}` : 'no debug session'}`
      + ` · breakpoints: ${Array.isArray(value.breakpoints) && value.breakpoints.length > 0
        ? value.breakpoints.map((bp) => `${bp.className}:${bp.line}${bp.pending === true ? '(预置)' : ''}`).join(', ')
        : 'none'}`)
  }
  if (value.debug !== undefined || value.port !== undefined) {
    parts.push(`debug started: port ${value.port ?? '?'} · attached ${value.debug?.attached === true}`)
  }
  if (value.attached !== undefined) {
    parts.push(`attached=${value.attached} suspended=${value.vmSuspended === true} port=${value.port ?? '?'}`)
  }
  if (Array.isArray(value.breakpoints)) {
    parts.push(value.breakpoints.length === 0
      ? 'no breakpoints'
      : `breakpoints: ${value.breakpoints.map((bp) => `${bp.className}:${bp.line} (#${bp.requestId})`).join(', ')}`)
  }
  if (value.breakpoint !== undefined && value.breakpoint !== null) {
    parts.push(`breakpoint set: ${value.breakpoint.className}:${value.breakpoint.line} (#${value.breakpoint.requestId})`)
  }
  if (Array.isArray(value.threads)) {
    parts.push(`threads: ${value.threads.map((thread) => `${thread.name ?? '?'} [${thread.threadId ?? thread.id}]`).join(', ')}`)
  }
  if (Array.isArray(value.frames)) {
    parts.push(`frames: ${value.frames.map((frame) => `${frame.methodName ?? '?'}@${frame.lineNumber ?? '?'}`).join(' <- ')}`)
  }
  if (Array.isArray(value.variables)) {
    parts.push(value.variables.length === 0
      ? 'no variables at this location'
      : `variables: ${value.variables.map((item) => `${item.name}=${item.stringValue ?? item.value}`).join(', ')}`)
  }
  if (Array.isArray(value.events)) {
    parts.push(value.events.length === 0
      ? 'no new events'
      : `events: ${value.events.map((event) => `${event.type}@${event.seq}`).join(', ')}`)
  }
  if (value.stepped !== undefined) parts.push(`stepped ${value.stepped} (thread ${value.threadId})`)
  if (value.resumed !== undefined) parts.push(`resumed ${value.resumed}`)
  if (value.paused === true) parts.push('paused')
  if (value.detached !== undefined) parts.push(`detached=${value.detached}`)
  if (value.threadId !== undefined && parts.length === 0) parts.push(`thread ${value.threadId}`)
  return parts.length === 0 ? JSON.stringify(value) : parts.join('\n')
}

/** Render one log tail for the model. */
function renderLogs(value) {
  if (value === null || value === undefined) return 'no log'
  const head = `${value.exists ? '' : '(no log file yet) '}${value.running ? 'running' : 'not running'} · ${value.path}`
  if (typeof value.content !== 'string' || value.content === '') return `${head}\n(empty)`
  return `${head}\n${value.content}`
}

/** Test-only surface: the pure pieces, exercised without a live profile. */
export const __test = {
  resolvePath,
  // The bundled skill + its installer (idempotent, target-aware).
  SKILL_NAME,
  PKG_VERSION,
  // .gitignore-honouring filename search (one git ls-files per repo root).
  SEARCH_PATH,
  TREE_PATH,
  TREE_TRASH_DIR,
  SSE_MAX_BUFFER_BYTES,
  noteTreeDirOpen,
  TREE_WATCH_HUB,
  TREE_WATCH_MAX_DIRS,
  relativePathOf,
  shouldDropSseFrame,
  shouldIgnoreTreePath,
  isStructurallyIgnoredTreePath,
  treeWatchAccepts,
  processRssBytes,
  availableMemoryBytes,
  assertEnoughMemory,
  rotateLogIfLarge,
  rotateActiveLogs,
  trackActiveLog,
  MIN_FREE_MEMORY_BYTES,
  LOG_ROTATE_BYTES,
  searchRoots,
  searchWorkspaceFiles,
  // git-grep CONTENT search (workspace fallback is a plain substring scan)
  CONTENT_SEARCH_PATH,
  searchWorkspaceContent,
  serveContentSearch,
  // one-module `mvn test` runner (poll the console through GET ?id=)
  RUN_TEST_PATH,
  serveRunTestStart,
  serveRunTestStatus,
  RUN_TEST_MAX_RECORDS,
  RUN_TEST_TIMEOUT_MS,
  RUN_TEST_HEAD_CHARS,
  RUN_TEST_TAIL_CHARS,
  runTestOutput,
  // gitignore-aware, compact-chain-folding tree level
  findGitRoot,
  repoAllowedPaths,
  listIdeTree,
  serveTree,
  bundledSkillPath,
  findProjectRoot,
  skillRootFor,
  skillFileState,
  installSkill,
  skillRootsFor,
  syncInstalledSkills,
  isLoopbackRequest,
  readTail,
  readTailWindow,
  trimToCurrentRun,
  lastStartMarkerOffset,
  START_MARKER_RE,
  clampBytes,
  serveTail,
  serveStop,
  handleRequest,
  readPidFile,
  readService,
  isAlive,
  isRunWithLogWrapper,
  stopWrapper,
  serveInstances,
  listInstances,
  servePrograms,
  serveStart,
  scanPrograms,
  buildStartSpec,
  defaultSpringArgs,
  quoteShell,
  sanitizeLogName,
  projectOf,
  nearestMavenModule,
  detectPackageManager,
  readLaunchConfigs,
  launchFor,
  parseJsonc,
  readProgramConfig,
  mergeProgramConfig,
  buildConfigDocument,
  normalizeEnv,
  findConfigEntryIndex,
  detectConfigDrift,
  mergeConfigDocuments,
  normalizeRelDir,
  discoverPrograms,
  serveConfig,
  CONFIG_PATH,
  CONFIG_FILENAME,
  OPENS_PATH,
  enqueueOpen,
  takePendingOpens,
  registerAgentTools,
  startProgram,
  stopLogPath,
  processGroupLeader,
  groupMembers,
  jsonSafe,
  projectRootOf,
  localYmlFor,
  profileFromPomText,
  readProjectProfile,
  normalizeSpringArgs,
  resolveSpringArgs,
  decoratePrograms,
  programsFromConfigEntries,
  configMatchesWorkspace,
  springSourceExists,
  hasRef,
  normalizeStringArray,
  DEBUG_PATH,
  DEBUG_SOURCE_PATH,
  SETTINGS_PATH,
  IDE_CACHE_DIR,
  CACHE_MAX_BYTES,
  CACHE_MAX_FILES,
  CACHE_MAX_AGE_MS,
  pruneIdeCache,
  readCacheManifest,
  IDE_SETTINGS_FILENAME,
  readZipEntries,
  readZipEntry,
  resolveDependencySource,
  readDecompilerConfig,
  serveSettings,
  DEBUGS_PATH,
  debugSessions,
  startProgramDebug,
  jdwpAgentArg,
  allocateDebugPort,
  waitForTcp,
  waitForJdwpListening,
  toJsonSafe,
  createDebugSessions,
  DebugError,
  IS_WINDOWS,
  pickGitBash,
  detectGitBash,
  resolveWindowsRuntime,
  gitBashCandidates,
  windowsCommandLine,
  taskkillTree,
  windowsStartSpec,
  logUrl,
  logStatus,
  programStatus,
  formatUptime,
  resolveProgramRef,
  programRow,
  programRows,
  renderDebug,
  TAIL_PATH,
  STOP_PATH,
  INSTANCES_PATH,
  PROGRAMS_PATH,
  STREAM_PATH,
  BUNDLE_PATH,
  WINDOW_PAGE_PATH,
  WINDOW_APP_PATH,
  WINDOW_VENDOR_PREFIX,
  WINDOW_VENDOR_FILES,
  serveWindowPage,
  serveWindowVendor,
  FS_MKDIR_PATH,
  FS_CREATE_PATH,
  FS_COPY_PATH,
  FS_MOVE_PATH,
  FS_REMOVE_PATH,
  FS_IMPORT_PATH,
  FS_UPLOAD_PATH,
  FS_UPLOAD_MAX_BYTES,
  serveFsOp,
  serveFsImport,
  CLIENT_CHUNKS,
  serveBundle,
  FS_READ_PATH,
  FS_WINDOW_PATH,
  FS_WINDOW_BYTES,
  FS_WINDOW_MAX_BYTES,
  utf8CompleteLength,
  FS_WRITE_PATH,
  FS_FILE_PATH,
  serveFs,
  serveSafely,
  writeTailError,
  readFileRange,
  serveStream,
  START_PATH,
  MAX_PROGRAMS,
  MAX_INSTANCES,
  ROUTE_PREFIX,
  DEFAULT_BYTES,
  HARD_MAX_BYTES,
  MIN_BYTES,
  PID_SUFFIX,
  DEFAULT_STOP_GRACE_MS,
}
