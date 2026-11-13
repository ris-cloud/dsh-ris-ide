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
import { appendFile, copyFile, cp, link, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import {
  createDebugSessions, DebugError, debugErrorStatus, jdwpAgentArg, allocateDebugPort, waitForTcp,
  waitForJdwpListening, toJsonSafe,
} from './debug/engine.js'
import { allowList, autoRules, engineSide, gitProxyPlan, injectionFor, isSocksCapableProgram, mergeConfigs, parseHostSpec, parsePortSpec, programKey, proxyConfigPath, proxyHomeDir, proxyPid, proxyStatus, readProxyConfig, ruleEffectiveness, runWindowsGitConfig, startProxy, stopProxy, stopProxySync, writeProxyConfig } from './proxy.js'
import {
  buildProfile,
  redirectorCommand,
  localRedirectorRunning,
  redirectorStatus,
  redirectorStatusCached,
  reloadRedirectorsWithProfile,
  startRedirectors,
  stopRedirector,
  posixToWindowsPath,
  syncRedirector,
  windowsToPosixPath,
  writeHeartbeat,
} from './redirector.js'
import { armJanitor, disarmJanitor, janitorStatus, writeStateAtomic } from './janitor.js'
import {
  acquireLease,
  debugAction as daemonDebugAction,
  ensureRisd,
  getProxyView,
  probeRisd,
  risdHealth,
  listPrograms as daemonListPrograms,
  programAction as daemonProgramAction,
  proxyAction,
  readProgramLog as daemonReadProgramLog,
  releaseLease,
  saveProxy,
} from './risd-client.js'
import { scheduleStartupReconcile } from './startup.js'

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

/** Shell constructs that only a bash/msys shell understands (not cmd.exe). */
const BASH_DIALECT_RE = /(^|[\s;&|(])(exec|export|unset|source)\s|\$\(|`|\$\{[^}]*\}|\$[A-Z][A-Z0-9_]*\b/
/**
 * Constructs that mean the command belongs to PowerShell, not bash. `$env:NAME`
 * (the way PowerShell spells an environment variable), `$PSScriptRoot` &
 * friends, `$x = 1` assignments, `-Command`, `.ps1` and an explicit `pwsh`.
 */
const POWERSHELL_DIALECT_RE = /\$env:|\$(?:global|script|local|private|using|function|input|args|PSItem|PSScriptRoot|PSEdition|PSVersionTable|LASTEXITCODE|Error|Host|PID)\b|\$[A-Za-z_][A-Za-z0-9_]*\s*=|\b(?:powershell|pwsh)\b|-Command\b|\.ps1\b/i
/**
 * Whether a custom `startCommand` is written in bash dialect.
 *
 * `runtime=auto` now selects the native PowerShell wrapper on Windows, which runs a
 * custom command through `cmd.exe`. A command with `$(cat ...)`, `exec java` or
 * `$HOME` then dies instantly with no explanation (review A2-P1-2), so the caller
 * uses this to prefer Git Bash when the command needs it.
 *
 * Only *unambiguous* bash signals count: `$(`, backticks, `${...}`, `exec`/`export`
 * and ALL-CAPS `$VAR` (how POSIX spells `$HOME`). Lowercase `$x` and `$env:NAME`
 * are how PowerShell writes its own variables, and `$x = 1` is a PowerShell
 * assignment — treating those as bash sent `pwsh`/`powershell` commands through Git
 * Bash (or failed with `no-bash` when it was missing) (review C3-P1-1).
 * @param {string} command - custom start command (JDWP placeholder already expanded).
 * @returns {boolean} true when a POSIX shell is required.
 */
export function isBashDialectCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  if (POWERSHELL_DIALECT_RE.test(command) === true) return false
  return BASH_DIALECT_RE.test(command)
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
export function resolveWindowsRuntime(runtime, bashPath, { bashDialect = false } = {}) {
  const requested = runtime === 'bash' || runtime === 'powershell' ? runtime : 'auto'
  if (requested === 'powershell') return { runtime: 'powershell' }
  if (requested === 'auto' && bashDialect === true) {
    // The command cannot run under cmd.exe: keep the pre-review behaviour for this
    // one program instead of failing at launch (review A2-P1-2).
    const found = bashPath !== undefined ? pickGitBash([bashPath]) : detectGitBash()
    if (found === undefined) {
      throw new TailError('no-bash', '这段 startCommand 是 bash 方言（$(…)/exec/$VAR），但没找到 Git Bash：装 Git Bash 或把 runtime 设为 "powershell" 并改写命令', 400)
    }
    return { runtime: 'bash', bashPath: found }
  }
  // 2026-11-09 Windows review: the Git Bash wrapper receives Windows paths
  // verbatim, and MSYS rewrites/mangles them (`mkdir -p 'C:\x'` creates a file
  // named `C:\x`, `cd 'C:\x'` fails). `auto` used to prefer Git Bash whenever
  // it was installed — i.e. the most common Windows dev box — so the default is
  // now the native PowerShell wrapper (no path translation). `bash` stays
  // available, but only when asked for explicitly.
  if (requested === 'auto') return { runtime: 'powershell' }
  const found = bashPath !== undefined ? pickGitBash([bashPath]) : detectGitBash()
  if (found === undefined) {
    throw new TailError('no-bash', '没有找到 Git Bash（WSL 的 bash.exe 不支持）；装 Git Bash 或把 runtime 设成 "powershell"', 400)
  }
  return { runtime: 'bash', bashPath: found }
}
/** The Host services this plugin needs: the HTTP route registry and session cwd lookup. */
export const inject = ['webServer', 'sessions', 'tools']

/** Route prefix; the browser resolves `<prefix>/tail` (and POST `<prefix>/stop`) against the page base. */
const ROUTE_PREFIX = '/dsh-ris-ide'
const TAIL_PATH = `${ROUTE_PREFIX}/tail`
const STOP_PATH = `${ROUTE_PREFIX}/stop`
const INSTANCES_PATH = `${ROUTE_PREFIX}/instances`
const PROGRAMS_PATH = `${ROUTE_PREFIX}/programs`
/** Where a program's browser URL is resolved (dev server first, yds' injecting proxy second). */
const OPEN_TARGET_PATH = `${ROUTE_PREFIX}/open-target`
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
/** Mirror a tree copy onto the SYSTEM clipboard, so the OS file manager can paste it. */
const CLIPBOARD_FILES_PATH = `${ROUTE_PREFIX}/clipboard/files`
/** One copy gesture; a folder of 1000 files is a mistake, not a clipboard write. */
const CLIPBOARD_MAX_ENTRIES = 200
/** Upper bound on the "one path per line" stdin payload the backends accept. */
const CLIPBOARD_MAX_PAYLOAD = 256 * 1024
/**
 * `GET /dsh-ris-ide/windows` — which standalone IDE windows are alive.
 *
 * A page cannot enumerate other windows, so the host keeps the list: every IDE
 * window's stream declares `window=1`, the connection IS the liveness (a closed
 * window drops its stream, and a `dsh web` restart reconnects it a moment later).
 * That is what lets the ⧉ button focus the window the user already has instead
 * of stacking a second one, and what makes it find that window again after a
 * restart without anyone announcing anything.
 */
const WINDOWS_PATH = `${ROUTE_PREFIX}/windows`
/**
 * `GET /dsh-ris-ide/workspaces` — this host's live sidebar snapshot (m00186).
 *
 * The daemon normally reads `dsh-window.json`, but that document is shared by every
 * dsh on the machine and is only its last written answer. This route answers from
 * the running host itself, so the page can stay usable while the document is
 * missing, stale, or written by another instance.
 */
const WORKSPACES_PATH = `${ROUTE_PREFIX}/workspaces`
/** A window whose stream has been gone this long counts as closed. */
const IDE_WINDOW_GRACE_MS = 90 * 1000
/** Live IDE windows, keyed by workspace cwd (one IDE window per workspace). */
const IDE_WINDOWS = new Map()

/**
 * ONE hidden folder for everything the IDE keeps inside a workspace
 * (`<workspace>/.dsh-ris-ide/`): `trash/` for deletes the tree can undo,
 * `cache/` for extracted sources, `stage/` for clipboard publish mirrors.
 * Older builds wrote those as three sibling dot-folders; `ensureIdeStateDir()`
 * folds such leftovers in the first time this workspace is touched.
 */
export const IDE_STATE_DIR = '.dsh-ris-ide'
/**
 * Hidden staging area for a COPY publish (`<workspace>/.dsh-ris-ide/stage`).
 *
 * Explorer is free to interpret a cross-`\\wsl.localhost` paste as a MOVE: the
 * files then leave the workspace even though the page published DROPEFFECT_COPY.
 * Publishing a STAGED copy instead keeps the originals out of Explorer's hands —
 * a plain file is hard-linked (O(1), same inode), a directory is copied under a
 * size budget. `cut` still publishes the real paths: a cut IS a move.
 */
const CLIPBOARD_STAGE_DIR = `${IDE_STATE_DIR}/stage`
/** Directories are copied for real; this is the budget one copy gesture may spend. */
const CLIPBOARD_STAGE_MAX_BYTES = 64 * 1024 * 1024
/** How many recent staging batches survive (older ones are pruned on publish). */
const CLIPBOARD_STAGE_KEEP_BATCHES = 3
/** A batch older than this is pruned even when it is one of the recent few. */
const CLIPBOARD_STAGE_TTL_MS = 24 * 60 * 60 * 1000
/** Batch record: staged path -> original path, so a read can translate back. */
const CLIPBOARD_STAGE_MANIFEST = 'manifest.json'
/**
 * Read the SYSTEM clipboard back (`GET /dsh-ris-ide/clipboard/read`).
 *
 * A page cannot do this either: in WSL a copy made in Explorer never reaches
 * Chromium (WSLg does not bridge the Windows `CF_HDROP` flavour), so the paste
 * event arrives with an EMPTY payload while the clipboard really holds files.
 * Only the Host can look; the route is read-only and writes nothing.
 */
const CLIPBOARD_READ_PATH = `${ROUTE_PREFIX}/clipboard/read`
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
 * Streaming twins of the two searches: ONE NDJSON response, one frame per page,
 * so the dropdown paints the first matches while the other repo roots are still
 * being listed. The non-streaming routes stay (compatibility + fallback when a
 * browser lacks readable streams).
 */
const SEARCH_STREAM_PATH = `${ROUTE_PREFIX}/search/stream`
const CONTENT_SEARCH_STREAM_PATH = `${ROUTE_PREFIX}/search-content/stream`
/** Rows per streamed page when the client does not ask for a size. */
export const SEARCH_STREAM_PAGE_DEFAULT = 40
/** Largest page a client may ask for. */
export const SEARCH_STREAM_PAGE_MAX = 500
/**
 * How many repo roots may run `git` at the same time. The roots are independent
 * processes and this workspace has 32 of them: sequential `ls-files` measured
 * 1.0 s, the same calls with all roots in flight 0.09 s — the wall clock is
 * spawn latency, not file count, so running them together is the whole fix.
 */
export const SEARCH_STREAM_CONCURRENCY = 6
/**
 * Run ONE Maven test (`-Dtest=<name>`) in one module and keep its console in
 * memory, so the IDE can start it and poll without a fake terminal.
 */
const RUN_TEST_PATH = `${ROUTE_PREFIX}/run-test`
/** One directory level for the IDE tree: gitignore-filtered + compact chains folded. */
const TREE_PATH = `${ROUTE_PREFIX}/tree`
/** Deleted entries park here so the tree's Ctrl+Z can bring them back. */
export const TREE_TRASH_DIR = `${IDE_STATE_DIR}/trash`
/** Path segments whose churn is never interesting to the file tree. */
const TREE_WATCH_IGNORED = new Set([
  'node_modules', 'target', 'build', 'dist', 'out', 'coverage', '.git',
  'logs', '.dsh', '.dsh-ris-ide', '.gradle', '.idea', '.mvn',
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
/** Read/write the IDE-specific settings kept in `.dsh-ris-ide/settings.json`. */
const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`
/**
 * Proxy rules + engine control.
 * `GET` reports the stored rules (with per-row parse diagnostics) and whether the
 * tunnel engine is up; `POST` saves the form; `/action` starts/stops the engine
 * and writes the scoped git config.
 */
const PROXY_PATH = `${ROUTE_PREFIX}/proxy`
const PROXY_ACTION_PATH = `${ROUTE_PREFIX}/proxy/action`
/** Program picker for the rules table: this OS, plus Windows when reachable. */
const PROXY_PROGRAMS_PATH = `${ROUTE_PREFIX}/proxy/programs`
/**
 * File browser for the rules table's 「固定程序」 source: a rule can name an
 * executable that is not running yet, so it is proxied the moment it starts.
 */
const PROXY_BROWSE_PATH = `${ROUTE_PREFIX}/proxy/browse`
/**
 * On-demand daemon start for the IDE button: clicking ⧉ must work even after
 * `risd stop` (or a crash), so the client asks the host to spawn it rather than
 * falling back to the old standalone window.
 */
const RISD_ENSURE_PATH = `${ROUTE_PREFIX}/risd/ensure`
/** Where the page asks which client bundle the host is serving (m09693). */
const BUILD_PATH = `${ROUTE_PREFIX}/build`
/** Workspace cache holding extracted sources / decompiled files. */
export const IDE_CACHE_DIR = `${IDE_STATE_DIR}/cache`
/** Where the visual settings dialog persists the decompiler jar. */
export const IDE_SETTINGS_FILENAME = `${IDE_STATE_DIR}/settings.json`
/** Older builds kept the settings beside the workspace root: read, never write. */
const LEGACY_SETTINGS_FILENAME = '.dsh-ris-ide.settings.json'
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const SOURCE_ENTRY_MAX_BYTES = 4 * 1024 * 1024
/** One JDWP session per program, shared by the routes, the tool and the workbench UI. */
const debugSessions = createDebugSessions()
/** The user-editable program config, inside the workspace state folder. */
export const CONFIG_FILENAME = `${IDE_STATE_DIR}/config.json`
/** Older builds kept the config as a hidden file beside the root: read, never write. */
const LEGACY_CONFIG_FILENAME = '.dsh-ris-ide.json'
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
/**
 * Cap on one `POST /fs/write` body: an editor save carries the WHOLE file, so the
 * generic 64 KB JSON cap rejected every save of a file above ~64 KB ("request body
 * too large"). Text edits are opened whole below `FS_MAX_TEXT_BYTES` (512 KB) and
 * chunked above it, so 8 MB covers every editable document with room to spare.
 */
const FS_WRITE_MAX_BODY_BYTES = 8 * 1024 * 1024

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
 * Process-wide lifecycle for the detached child services (proxy engine, redirector,
 * git proxy, janitor).
 *
 * The child services outlive any one plugin effect: dsh disposes the fiber tree and
 * only then calls `process.exit()`, so the synchronous `exit` listener is the last
 * chance to stop them. That listener — and the detached janitor that covers
 * SIGKILL/crash/closed-terminal — must NOT be removed by the effect teardown.
 * Removing them was the Ctrl+C leak: the hook was already gone when `process.exit()`
 * ran, so the engine kept routing with no UI left to stop it. Living here also makes
 * a profile hot reload harmless: the listener is installed once per process and a
 * heartbeat stopped by the teardown is simply restarted.
 */
let lifecycle = null
/** Engine left behind by a previous dsh process: `{ pid, owner, detectedAt } | null`. */
let inheritedEngine = null

/**
 * Write the watchdog heartbeat now and keep writing it every 3 s.
 *
 * A failed write is NOT harmless: the elevated watchdog tears the bridge down
 * after 20 s without a fresh heartbeat, so the user would see "代理桥接自己没了"
 * with no explanation in the log. Warn once per failure streak (reset on the
 * first successful beat) instead of swallowing it.
 *
 * @param logger - optional `{ warn(message) }` (the host context logger).
 */
function startHeartbeat(logger = null) {
  let warned = false
  const beat = () => {
    let ok = false
    try {
      ok = writeHeartbeat() !== false
    } catch {
      ok = false
    }
    if (ok === true) {
      warned = false
      return
    }
    if (warned === true) return
    warned = true
    try {
      logger?.warn?.('[dsh-ris-ide] 心跳写入失败：提权看门狗 20s 后会拆除代理桥接；请检查 ~/.dsh-ris-ide 是否可写（DSH_RIS_IDE_PROXY_HOME）')
    } catch { /* logging must never break the heartbeat */ }
  }
  beat()
  return setInterval(beat, 3000)
}

/**
 * Adopt an engine whose dsh is gone (`proxy.pid` alive, no watcher of ours).
 *
 * The pidfile is machine-wide, so an engine with a RUNNING janitor already has an
 * owner on this machine: either another dsh (multi-instance case — leave it alone)
 * or the watcher that is about to clean up after a crash. An engine with no watcher
 * can only have survived the pre-fix teardown — take it over and report it, instead
 * of letting it run invisibly or spawning a second one.
 * @returns {{pid: number, owner: number, detectedAt: string} | null} the adopted engine.
 */
function adoptLeftoverEngine() {
  try {
    const pid = proxyPid()
    if (pid === null || pid <= 0) {
      inheritedEngine = null
      return null
    }
    if (inheritedEngine !== null && inheritedEngine.pid === pid) return inheritedEngine
    const watcher = janitorStatus()
    if (watcher.owner === process.pid) {
      // Ours already (e.g. a hot reload): not "left behind".
      inheritedEngine = null
      return null
    }
    if (watcher.running === true) return inheritedEngine
    inheritedEngine = { pid, owner: watcher.owner, detectedAt: new Date().toISOString() }
    return inheritedEngine
  } catch {
    return inheritedEngine
  }
}

/**
 * Install (once per process) the exit hook, heartbeat and janitor, and adopt an
 * engine left behind by a previous dsh process.
 * @returns {{beat: NodeJS.Timeout | null, onExit: Function, owner: number}} the state.
 */
function ensureLifecycle(ctx = null) {
  if (lifecycle !== null && lifecycle.owner === process.pid) {
    if (lifecycle.beat === null) lifecycle.beat = startHeartbeat(ctx?.logger ?? null)
    return lifecycle
  }
  adoptLeftoverEngine()
  const onExit = () => {
    try { stopProxySync() } catch { /* best effort while exiting */ }
    try { stopRedirectorSync() } catch { /* best effort while exiting */ }
    try { clearGitProxySync() } catch { /* best effort while exiting */ }
    // Deliberately NO disarmJanitor(): the watcher must see our pid disappear and
    // clean up itself — it is the only path that survives SIGKILL, a crash or a
    // closed terminal, where no 'exit' listener runs at all.
  }
  process.once('exit', onExit)
  lifecycle = { beat: startHeartbeat(ctx?.logger ?? null), onExit, owner: process.pid }
  // Idempotent for the same owner; replaces a watcher left watching a dead dsh.
  try { armJanitor({ ownerPid: process.pid }) } catch { /* the watcher is optional */ }
  return lifecycle
}

/**
 * Hand the machine-level lifecycle over to the daemon (daemonMode off → auto).
 *
 * A profile hot reload re-runs this plugin without restarting the process, so the
 * exit hook/heartbeat/janitor installed by an earlier `ensureLifecycle` would keep
 * running and compete with the daemon's own. This is the ONLY place they are
 * removed again — a normal dispose must keep them armed (review P0-2).
 */
function releaseLegacyLifecycle() {
  if (lifecycle === null || lifecycle.owner !== process.pid) return
  try { process.removeListener('exit', lifecycle.onExit) } catch { /* ignore */ }
  if (lifecycle.beat !== null) clearInterval(lifecycle.beat)
  try { disarmJanitor() } catch { /* the watcher may not exist */ }
  lifecycle = null
}

/**
 * Exit hook for an engine THIS plugin had to start in `daemonMode=auto` because the
 * daemon was down (port stolen, spawn failed, version mismatch). The daemon isn't
 * running to own the teardown, and auto mode deliberately installs no lifecycle, so
 * without this the engine, the bridge and the scoped git entry outlive dsh — git
 * then points at a dead tunnel (review C2-P1-3).
 *
 * It never writes a heartbeat or arms a janitor: those stay the daemon's job, and
 * writing them here would re-create the two-owner problem.
 */
let localProxyCleanup = null
function armLocalProxyCleanup() {
  if (localProxyCleanup !== null) return
  // A legacy lifecycle (daemonMode=off) already installs an exit hook that stops the
  // same three layers; a second hook would just run the same sync cleanups twice.
  if (lifecycle !== null) return
  localProxyCleanup = () => {
    try { stopProxySync() } catch { /* best effort while exiting */ }
    try { stopRedirectorSync() } catch { /* best effort while exiting */ }
    try { clearGitProxySync() } catch { /* best effort while exiting */ }
  }
  process.once('exit', localProxyCleanup)
}
/** Forget the local fallback cleanup once its engine is gone or the daemon took over. */
function disarmLocalProxyCleanup() {
  if (localProxyCleanup === null) return
  try { process.removeListener('exit', localProxyCleanup) } catch { /* ignore */ }
  localProxyCleanup = null
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
    daemonMode: daemonModeEnabled(config) ? 'auto' : 'off',
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
  // Child services belong to the PROCESS, not to this effect (see ensureLifecycle):
  // dsh disposes the fiber tree first and calls process.exit() afterwards, so a
  // teardown that removed the exit hook or disarmed the janitor left the detached
  // engine alive with no UI to stop it.
  ctx.effect(() => {
    // The page's workspace list must survive idle windows: only the plugin can ask
    // the host whether a session still exists, so refresh it in both modes (m08228).
    const dshWindowTimer = setInterval(() => { refreshDshWindows(ctx) }, DSH_WINDOW_REFRESH_MS)
    dshWindowTimer.unref?.()
    const stopDshWindows = () => clearInterval(dshWindowTimer)
    // daemonMode=auto: the daemon owns the engine, the heartbeat and the janitor,
    // so the plugin must install none of them. Doing half of it (exit hook without
    // engine ownership, or the reverse) is how Ctrl+C started leaking in the first
    // place; the two halves ship together in Phase 1b P3/P4.
    if (options.daemonMode === 'auto') {
      // Switching off→auto in a hot reload: the daemon now owns the engine, the
      // heartbeat and the janitor, so drop the legacy trio to avoid two owners
      // (review C-P1-6).
      releaseLegacyLifecycle()
      return stopDshWindows
    }
    const adopted = adoptLeftoverEngine()
    if (adopted !== null) {
      try {
        ctx.logger?.warn?.(`[dsh-ris-ide] 接管上一个会话留下的代理引擎（引擎 pid ${adopted.pid}，原所有者 pid ${adopted.owner > 0 ? adopted.owner : '未知'}）`)
      } catch { /* logging is best effort */ }
    }
    // Previous runs (and reboots) leave machine-level side effects behind — a git
    // entry pointing at a dead tunnel, a parked ProxyBridgeSvc, a stale pidfile.
    // Reconcile against today's rules/state before the panel can show them.
    scheduleStartupReconcile({ log: (message) => ctx.logger?.warn?.(message) })
    const state = ensureLifecycle(ctx)
    return () => {
      stopDshWindows()
      // Only the heartbeat stops here: its stop is exactly what the elevated bridge
      // watchdog waits for (20 s freshness), and the next apply (a profile hot
      // reload) restarts it in the same second. The exit hook and the janitor stay
      // armed — they are the guards for process.exit(), SIGKILL, a crash and a
      // closed terminal.
      if (state.beat !== null) {
        clearInterval(state.beat)
        state.beat = null
      }
    }
  }, 'dsh-ris-ide: stop child services on exit')
  // Optional risd bridge (Phase 1a): discovery + lease only. The engine is still
  // ours, so this effect must not stop it — `stopRisdBridge` just releases the
  // lease and lets the daemon's liveness poll do the rest.
  ctx.effect(() => {
    if (options.daemonMode !== 'auto') return () => {}
    startRisdBridge(ctx, undefined)
    return () => stopRisdBridge()
  }, 'dsh-ris-ide: risd lease (optional daemon)')
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
/** Where the daemon's maintenance page learns our URL(s) + sessionIds (GET /v1/dsh). */
const DSH_WINDOW_FILENAME = 'dsh-window.json'
/** Rewrite at most this often; a changed sessionId forces an immediate write. */
const DSH_WINDOW_THROTTLE_MS = 3000
/** Keep the list short: the page only needs the workspaces someone is working in. */
const DSH_WINDOW_MAX_ENTRIES = 8
/** Upper bound for the registry snapshot: a machine with hundreds of workspaces must not bloat the file. */
const DSH_WINDOW_MAX_WORKSPACES = 50
let dshWindowNote = { at: 0, host: '', sessionId: '', cwd: '' }
/**
 * The last loopback origin a browser used to reach this host (m00186).
 *
 * dsh-window.json must name an origin the daemon page can embed, and for a while
 * the only writer was a window request, so a dsh started without ever opening the
 * IDE panel left no origin behind at all. Whatever address the bound server reports
 * may also be a LAN IP while the page was opened on 127.0.0.1; the request's Host is
 * the address that actually worked, so it wins.
 */
let dshWindowOrigin = ''

/**
 * Remember the origin of a loopback request. Called on every plugin route: a dsh
 * page that only loads the sidebar is enough to teach the refresh tick where the
 * IDE can be embedded (see {@link dshWindowOriginFor}).
 * @param req - the incoming HTTP request.
 */
function rememberDshOrigin(req) {
  try {
    // The same admission rule as every route: a cross-site request must not be able
    // to point the daemon page's iframe at another host (review A-P2-10).
    if (!isLoopbackRequest(req)) return
    const host = String(req?.headers?.host ?? '')
    if (host !== '') dshWindowOrigin = `http://${host}`
  } catch { /* a malformed request keeps the previous origin */ }
}

/**
 * The host's workspace registry, when this dsh version provides one.
 *
 * Read through `ctx.get` instead of the `inject` list: the plugin is installable on
 * older hosts that have no workspace service, and a missing registry only costs the
 * title (the daemon page falls back to the folder name).
 * @param ctx - Host context.
 * @returns the registry service, or null.
 */
function workspaceRegistryOf(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry', false)
    return registry !== null && typeof registry === 'object' && typeof registry.list === 'function' ? registry : null
  } catch {
    return null
  }
}

/**
 * One path spelling that can be compared across `dsh-window.json` rows, session
 * headers and registry records: the real path when it still exists, else a lexical
 * spelling without a trailing slash.
 *
 * The registry stores `fs.realpath` output, so a symlinked workspace path (or one
 * with a trailing slash) must not cost the title.
 * @param value - Candidate absolute path.
 * @returns the canonical spelling, or `''`.
 */
function canonicalWorkspacePath(value) {
  const raw = typeof value === 'string' ? value : ''
  if (raw === '') return ''
  try {
    return realpathSync.native(raw)
  } catch { /* gone, or not a directory: compare lexically */ }
  const trimmed = raw.replace(/[\\/]+$/, '')
  return trimmed === '' ? raw : trimmed
}

/** Path → title index per host context; short TTL so a burst of IDE requests does
 * not run `realpath` over every workspace on each one (a rename still lands within
 * this window — a label two seconds late is invisible). */
const workspaceTitleIndexes = new WeakMap()
/** How long a resolved path → title index is reused. */
const WORKSPACE_TITLE_TTL_MS = 2000

/**
 * Canonical path → sidebar title for one host context, cached briefly.
 * @param ctx - Host context.
 * @returns {Map<string, string>} the index (empty when there is no registry).
 */
function workspaceTitleIndex(ctx) {
  const now = Date.now()
  const cached = typeof ctx === 'object' && ctx !== null ? workspaceTitleIndexes.get(ctx) : undefined
  if (cached !== undefined && now - cached.at <= WORKSPACE_TITLE_TTL_MS) return cached.byPath
  const byPath = new Map()
  const registry = workspaceRegistryOf(ctx)
  if (registry !== null) {
    let listed
    try {
      listed = registry.list()
    } catch {
      listed = []
    }
    for (const workspace of Array.isArray(listed) ? listed : []) {
      if (workspace === null || typeof workspace !== 'object') continue
      const path = typeof workspace.path === 'string' ? workspace.path : ''
      const key = canonicalWorkspacePath(path)
      if (key === '') continue
      byPath.set(key, typeof workspace.title === 'string' ? workspace.title : '')
    }
  }
  if (typeof ctx === 'object' && ctx !== null) workspaceTitleIndexes.set(ctx, { at: now, byPath })
  return byPath
}

/**
 * Title sync has ONE key: the workspace path. Renaming a workspace only changes its
 * `title` (dsh-workspace `setTitle` never touches `path`), so a path → title lookup
 * keeps the daemon page's labels equal to the sidebar's after a rename (m13800).
 * @param ctx - Host context.
 * @param cwd - Workspace path as recorded in a window row.
 * @returns the title, or `''` when unknown (older dsh, no registry, unknown path).
 */
export function workspaceTitleFor(ctx, cwd) {
  const wanted = canonicalWorkspacePath(cwd)
  if (wanted === '') return ''
  return workspaceTitleIndex(ctx).get(wanted) ?? ''
}

/**
 * A session id the IDE can boot on for one workspace: dsh's live session for that
 * cwd when there is one (`liveSessionFor`), else the last recorded session id, else
 * `''` (the panel then opens the workspace without a session — the host routes fall
 * back to the cwd).
 * @param ctx - Host context.
 * @param path - Workspace path.
 * @param workspace - Registry entity.
 * @returns a session id, possibly `''`.
 */
function workspaceSessionFor(ctx, path, workspace) {
  const live = liveSessionFor(ctx, path)
  if (live !== null && typeof live.id === 'string' && live.id !== '') return live.id
  try {
    const ids = workspace?.sessionIds
    if (Array.isArray(ids) && ids.length > 0 && typeof ids[ids.length - 1] === 'string') return ids[ids.length - 1]
  } catch { /* a broken entity only costs the session */ }
  return ''
}

/**
 * Every workspace the dsh sidebar shows, in the user's own order, with its title.
 *
 * Written next to the window rows so the daemon page can mirror the sidebar even for
 * a workspace nobody opened the IDE for yet, and so a rename reaches the page without
 * anyone clicking in that workspace (m13800).
 * @param ctx - Host context.
 * @returns {Array<{cwd: string, title: string, sessionId: string, active: boolean}>}
 */
export function dshWorkspaceRows(ctx) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === null) return []
  let listed
  try {
    listed = registry.list()
  } catch {
    return []
  }
  if (!Array.isArray(listed)) return []
  const rows = []
  for (const workspace of listed) {
    if (rows.length >= DSH_WINDOW_MAX_WORKSPACES) break
    if (workspace === null || typeof workspace !== 'object') continue
    const path = typeof workspace.path === 'string' ? workspace.path : ''
    if (path === '') continue
    const sessionId = workspaceSessionFor(ctx, path, workspace)
    rows.push({
      cwd: path,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      sessionId,
      // Whether this workspace currently holds a live session. A workspace without
      // one is still openable (the host routes fall back to the cwd), so this only
      // feeds the page's per-row hint instead of gating the list (m00186).
      active: sessionId !== '' && isLiveSession(ctx, sessionId),
    })
  }
  return rows
}

/**
 * The whole document `dsh-window.json` carries: remembered windows (where to embed
 * the IDE), the sidebar's workspace list (what to call the entries) and the last
 * answer this host gave. `at` proves the writer is still alive, so the daemon can
 * drop the title snapshot when dsh has been gone for long enough.
 * @param ctx - Host context.
 * @param windows - The window rows about to be written.
 * @param now - Epoch ms of the answer.
 * @param url - The origin this host answered on (preferred over the newest row).
 * @returns the document to persist.
 */
function dshWindowDocument(ctx, windows, now, url) {
  const origin = typeof url === 'string' && url !== ''
    ? url
    : (Array.isArray(windows) ? windows.reduce((found, row) => found !== '' ? found : (row !== null && typeof row === 'object' && typeof row.url === 'string' ? row.url : ''), '') : '')
  return {
    windows: Array.isArray(windows) ? windows : [],
    workspaces: dshWorkspaceRows(ctx),
    url: origin,
    at: new Date(now).toISOString(),
  }
}

/**
 * The origin the daemon page should embed the IDE at: the address a browser really
 * used when one has ever reached this host, else the address the server is bound to.
 * @param ctx - Host context.
 * @returns `http://host:port`, or `''` when neither is known (an old host whose
 *  server is not bound yet, and no page has been served).
 */
function dshWindowOriginFor(ctx) {
  if (dshWindowOrigin !== '') return dshWindowOrigin
  try {
    // getOrigin() throws before the server is bound; the timer can fire that early,
    // and a missing method on an older host must only cost the origin.
    const origin = ctx?.webServer?.getOrigin?.()
    if (typeof origin === 'string' && origin !== '') return origin
  } catch { /* not bound yet */ }
  return ''
}

/**
 * Upsert one dsh window record (origin + sessionId per workspace). A daemon page
 * can then offer every workspace's IDE in one window instead of one page per cwd.
 * Loopback Hosts only, best effort, never throws.
 * @param ctx - Host context (workspace titles for the daemon page's labels).
 * @param req - the incoming HTTP request.
 */
function noteDshWindow(ctx, req) {
  // `node --test` runs against the developer's real home unless a test isolates
  // DSH_RIS_IDE_PROXY_HOME. Fake contexts with /tmp workspaces used to collect
  // entries in dsh-window.json and the daemon page listed them as workspaces
  // (m08500), so tests must opt in explicitly.
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.DSH_RIS_IDE_WINDOW_NOTE !== '1') return
  // Every other route on this prefix goes through isLoopbackRequest, which also
  // rejects a cross-site Origin. This write feeds the daemon's workspace list, so a
  // random page must not be able to seed it (review C2-P2-4).
  if (!isLoopbackRequest(req)) return
  const host = String(req?.headers?.host ?? '')
  const now = Date.now()
  let sessionId = ''
  let cwd = ''
  try {
    const url = new URL(String(req.url ?? '/'), `http://${host}`)
    sessionId = url.searchParams.get('sessionId') ?? ''
    cwd = url.searchParams.get('cwd') ?? ''
  } catch { /* malformed URL: keep the blanks */ }
  // A request without a workspace cannot be attributed to one; recording it under
  // `existing[0].cwd` replaced some OTHER workspace's window (review C-P1-5).
  if (cwd === '' || !isAbsolute(cwd)) return
  // Only a real dsh window may claim a workspace: its requests always carry
  // ?sessionId=. The `/windows?cwd=` probes from the standalone/maintenance page do
  // not, and inheriting the previous window's id made `/ws-a` open with `/ws-b`'s
  // session and made the liveness check prune the wrong entry (review C2-P1-2).
  if (sessionId === '') return
  // A workspace nobody recorded yet is written immediately (the page needs it, and
  // there are at most DSH_WINDOW_MAX_ENTRIES). Everything already recorded is at
  // most one write per window: two windows alternating requests used to defeat the
  // throttle and write the machine-level file on EVERY request (review C3-P2-6) —
  // inside the window only the in-memory key moves.
  const home = (() => { try { return proxyHomeDir() } catch { return '' } })()
  if (home === '') return
  const path = join(home, DSH_WINDOW_FILENAME)
  let existing = []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed?.windows)) existing = parsed.windows
  } catch { /* first write */ }
  const known = existing.some((row) => row !== null && typeof row === 'object'
    && (row.cwd ?? '') === cwd && (row.sessionId ?? '') === sessionId)
  if (known && now - dshWindowNote.at < DSH_WINDOW_THROTTLE_MS) {
    dshWindowNote = { at: dshWindowNote.at, host, sessionId, cwd }
    return
  }
  dshWindowNote = { at: now, host, sessionId, cwd }
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const entry = {
      url: `http://${host}`,
      sessionId,
      cwd,
      // The sidebar's title for this path (m13800). Renaming only changes the title,
      // so the daemon page can label a workspace the way dsh does and follow a rename
      // without losing the workspace; '' means "no registry on this host" and the page
      // falls back to the folder name.
      title: workspaceTitleFor(ctx, cwd),
      // Which plugin process wrote this row: another dsh (same home) refreshes and
      // prunes only its own rows (review C2-P2-2).
      ownerPid: process.pid,
      at: new Date(now).toISOString(),
    }
    const windows = existing.filter((row) => row !== null && typeof row === 'object' && (row.cwd ?? '') !== cwd)
    windows.unshift(entry)
    const trimmed = windows.slice(0, DSH_WINDOW_MAX_ENTRIES)
    // Atomic replace: a half-written file reads as "no windows" in the daemon
    // (review C2-P2-1 / A2-P2-17). The document also carries the sidebar's workspace
    // list (title per path) and the origin that answered (m13800).
    writeStateAtomic(path, dshWindowDocument(ctx, trimmed, now, `http://${host}`))
  } catch { /* the daemon page simply greys the IDE tab out */ }
}
/** How often the plugin refreshes the liveness of remembered dsh windows. */
const DSH_WINDOW_REFRESH_MS = 10_000

/**
 * Whether two sidebar snapshots say the same thing, in the same order.
 *
 * Order is the dsh sidebar's own order, so it is part of the equality: a reordered
 * sidebar is a new truth for the daemon page, not a cosmetic difference.
 * @param left - Rows about to be written.
 * @param right - Rows already on disk.
 * @returns whether a write would change nothing.
 */
function sameWorkspaceRows(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return false
    const aCwd = typeof a.cwd === 'string' ? a.cwd : ''
    const bCwd = typeof b.cwd === 'string' ? b.cwd : ''
    const aTitle = typeof a.title === 'string' ? a.title : ''
    const bTitle = typeof b.title === 'string' ? b.title : ''
    const aSession = typeof a.sessionId === 'string' ? a.sessionId : ''
    const bSession = typeof b.sessionId === 'string' ? b.sessionId : ''
    if (aCwd !== bCwd || aTitle !== bTitle || aSession !== bSession) return false
  }
  return true
}

/**
 * Keep the remembered windows' `at` fresh while dsh still knows their session, so
 * the daemon page lists every workspace that is currently open instead of only the
 * one that happened to hit an endpoint within the freshness window (m08228).
 * The plugin is the only writer of dsh-window.json; a daemon-side timer cannot
 * answer "does this session still exist" because it has no host context.
 *
 * Since m00186 this tick also publishes the sidebar's workspace list and this host's
 * origin on its own, even before any window row exists: a dsh started as a service
 * (or simply never asked for the IDE panel) used to leave the daemon page stuck at
 * 「dsh 未运行（没有记住的工作区窗口）」 although dsh was running. The mirror of the
 * registry is enough for that page to offer every workspace and switch between them.
 * @param ctx - Host context (`ctx.sessions.get(id)`, workspace registry).
 * @returns {{changed:number, windows:number, dropped:number}} how many entries were refreshed.
 */
export function refreshDshWindows(ctx) {
  const result = { changed: 0, windows: 0, dropped: 0 }
  try {
    const path = join(proxyHomeDir(), DSH_WINDOW_FILENAME)
    let document = null
    let windows = []
    let sidebar = []
    let documentOrigin = ''
    let documentAt = Number.NaN
    try {
      document = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(document?.windows)) windows = document.windows
      if (Array.isArray(document?.workspaces)) sidebar = document.workspaces
      if (typeof document?.url === 'string') documentOrigin = document.url
      documentAt = Date.parse(String(document?.at ?? ''))
    } catch { /* absent or unreadable: this tick may write the first version */ }
    const now = Date.now()
    // The sidebar mirror is news even when no window row exists, and it can only be
    // produced while this process still holds the registry — which is exactly the
    // liveness the document's `at` promises to the daemon.
    const mirror = dshWorkspaceRows(ctx)
    const origin = dshWindowOriginFor(ctx)
    const canVerify = typeof ctx?.sessions?.get === 'function'
    let dirty = false
    /**
     * Re-resolve one row's sidebar title (m13800). A rename never touches the path,
     * so the path keeps the row and only the label moves — and it moves even while
     * nobody is working in that workspace, because this timer keeps running.
     * @param row - A window row that belongs to this process.
     * @returns the row, with a fresh/removed `title` when it changed.
     */
    const retitle = (row) => {
      const title = workspaceTitleFor(ctx, typeof row.cwd === 'string' ? row.cwd : '')
      const current = typeof row.title === 'string' ? row.title : ''
      if (title === current) return row
      dirty = true
      const next = Object.assign({}, row)
      if (title === '') delete next.title
      else next.title = title
      return next
    }
    const next = windows.reduce((out, row) => {
      if (row === null || typeof row !== 'object') return out
      // Another dsh process owns this row (same machine-level home): its own plugin
      // refreshes/prunes it. Deleting it here made two instances erase each other's
      // workspaces (review C2-P2-2). Legacy rows (no ownerPid) are treated as ours;
      // a garbage value must not be read as "someone else's row" (Number('abc') is
      // NaN and used to fall through to the pruning branch, review C3-P2-5).
      const rawOwner = Number(row.ownerPid)
      const ownerPid = Number.isInteger(rawOwner) && rawOwner > 0 ? rawOwner : process.pid
      if (ownerPid !== process.pid) { out.push(row); return out }
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
      // An empty session id cannot be verified (legacy rows); keep it and let the
      // daemon's retain TTL retire it.
      if (sessionId === '' || !canVerify) { out.push(retitle(row)); return out }
      const session = ctx.sessions.get(sessionId)
      const sessionCwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
      // "Session exists" is not enough: a session may have been reopened on another
      // workspace, and refreshing the old cwd would keep a wrong row alive.
      if (!session || (sessionCwd !== '' && sessionCwd !== row.cwd)) {
        dirty = true
        result.dropped += 1
        return out
      }
      dirty = true
      result.changed += 1
      out.push(Object.assign({}, retitle(row), { at: new Date(now).toISOString() }))
      return out
    }, [])
    // Report the surviving size: the pre-prune number misled callers/tests (review E P2-2).
    result.windows = next.length
    // Write when a window row changed, when the sidebar snapshot (title/order/session)
    // changed, or when there is something to keep alive and this tick is the first to
    // publish it / learned the origin / has to re-stamp `at`. When BOTH halves are
    // empty there is nothing to offer: this process must not create the document, or
    // an older host sharing the home would erase a newer instance's snapshot.
    const keepAlive = mirror.length > 0 || next.length > 0
    // An empty mirror means "this host cannot list workspaces", not "the sidebar is
    // empty": an older dsh sharing the home has no registry and must not publish an
    // empty list over another instance's snapshot. A real shrink (some workspaces
    // left, none right) is still news, because the mirror itself is non-empty.
    const mirrorChanged = mirror.length > 0 && !sameWorkspaceRows(mirror, sidebar)
    const originChanged = origin !== '' && origin !== documentOrigin
    const documentAgeMs = Number.isFinite(documentAt) ? now - documentAt : Number.POSITIVE_INFINITY
    if (dirty || mirrorChanged || (keepAlive && (document === null || originChanged || documentAgeMs >= DSH_WINDOW_REFRESH_MS))) {
      // The document also carries the sidebar's workspace list + the origin (m13800);
      // an empty origin falls back to the newest window row inside the helper.
      writeStateAtomic(path, dshWindowDocument(ctx, next, now, origin))
    }
    // Advertise this live host on its own origin file (m00186): the shared document
    // is a single last-writer snapshot, so a daemon that cannot use it must still be
    // able to ask a running dsh directly instead of declaring it gone.
    if (origin !== '') publishDshInstance(now, origin)
  } catch { /* best effort: the page keeps showing what it last knew */ }
  return result
}

/**
 * Where a running plugin advertises its origin: `instances/dsh-<pid>.json`
 * (m00186). The shared `dsh-window.json` is one last-writer snapshot and cannot
 * name two live hosts; one file per pid lets the daemon probe each of them.
 */
const DSH_INSTANCE_DIRNAME = 'instances'
/** An instance file this old belongs to a process that is gone (or a reused pid). */
const DSH_INSTANCE_RETAIN_MS = 24 * 60 * 60 * 1000

/**
 * Publish (or refresh) this process's origin file. Best effort: a read-only home
 * only costs the daemon's direct-probe path — the shared document still carries an
 * origin whenever a browser reaches this host.
 * @param now - Epoch ms of this refresh tick.
 * @param origin - Loopback origin this host answers on.
 */
function publishDshInstance(now, origin) {
  try {
    const dir = join(proxyHomeDir(), DSH_INSTANCE_DIRNAME)
    writeStateAtomic(join(dir, `dsh-${process.pid}.json`), {
      pid: process.pid,
      url: origin,
      at: new Date(now).toISOString(),
    })
    // A crashed dsh never deletes its own file, so drop the ones nothing can own now:
    // a short candidate list keeps the daemon's probes cheap.
    for (const name of readdirSync(dir)) {
      if (!/^dsh-\d+\.json$/.test(name) || name === `dsh-${process.pid}.json`) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        const at = Date.parse(String(parsed?.at ?? ''))
        if (Number.isFinite(at) && now - at <= DSH_INSTANCE_RETAIN_MS) continue
      } catch { /* half-written: nobody can use it */ }
      try { rmSync(join(dir, name), { force: true }) } catch { /* best effort */ }
    }
  } catch { /* best effort: see the doc comment */ }
}

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
  // Any request from the dsh page is proof of the origin to advertise — not just a
  // window request (`noteDshWindow` needs ?sessionId=&?cwd= and may never come).
  rememberDshOrigin(req)
  noteDshWindow(ctx, req)
  const method = req.method ?? 'GET'
  const pathname = requestPathname(req)
  if (pathname === WINDOWS_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveWindows(ctx, req, res))
    return
  }
  if (pathname === WORKSPACES_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveWorkspaces(ctx, req, res))
    return
  }
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
  if (pathname === CLIPBOARD_FILES_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveClipboardFiles(ctx, req, res, options))
    return
  }
  if (pathname === CLIPBOARD_READ_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveClipboardRead(ctx, req, res))
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
  if (pathname === OPEN_TARGET_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveOpenTarget(ctx, req, res, options))
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
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'this route answers loopback requests only' })
      return
    }
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
  if (pathname === PROXY_PATH) {
    serveSafely(res, () => serveProxy(ctx, req, res, options))
    return
  }
  if (pathname === BUILD_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    // No auth beyond loopback: it names a build, not a secret, and the page that
    // needs it may be the one asking before it has any other state.
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'this route answers loopback requests only' })
      return
    }
    writeJson(res, 200, { ok: true, version: PKG_VERSION, build: clientBundleStamp() })
    return
  }
  if (pathname === RISD_ENSURE_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveRisdEnsure(ctx, req, res, options))
    return
  }
  if (pathname === PROXY_ACTION_PATH) {
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
      return
    }
    serveSafely(res, () => serveProxyAction(ctx, req, res, options))
    return
  }
  if (pathname === PROXY_PROGRAMS_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveProxyPrograms(ctx, req, res, options))
    return
  }
  if (pathname === PROXY_BROWSE_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    serveSafely(res, () => serveProxyBrowse(ctx, req, res, options))
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
  if (pathname === SEARCH_STREAM_PATH || pathname === CONTENT_SEARCH_STREAM_PATH) {
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' })
      return
    }
    // Not serveSafely: the handler streams and owns its own error frames.
    void serveSearchStream(ctx, req, res, options, pathname === CONTENT_SEARCH_STREAM_PATH)
    return
  }
  if (pathname === OPENS_PATH) {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'this route answers loopback requests only' })
      return
    }
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
 * When the plugin stops trusting `git` (epoch ms; 0 = git is fine).
 *
 * A spawn error with ENOENT does NOT prove git is missing: node reports a
 * missing executable and a DELETED cwd identically (`error.path === 'git'`,
 * `errno === -2`). The plugin runs git inside tree folders, so one folder
 * deleted mid-command used to latch a module-level boolean forever — from then
 * on every tree answered `git:false`, the .gitignore filter was off and its
 * toggle greyed out, with no way back short of restarting dsh.
 * A failed spawn now only starts a short quarantine and a probe run from a
 * directory that always exists has to confirm the binary really is gone; any
 * later successful git command clears the verdict immediately.
 */
let gitMissingUntil = 0

/** How long one confirmed "git is absent" verdict is trusted before re-trying. */
const GIT_MISSING_TTL_MS = 60_000

/** Whether git is currently assumed to be absent (the .gitignore filter is off). */
function gitUnavailable() {
  return Date.now() < gitMissingUntil
}

/** Whether a spawn/exec error means the executable itself is absent. */
function isMissingExecutable(error) {
  return error !== undefined && error !== null && (error.code === 'ENOENT' || error.errno === -2)
}

/**
 * A git spawn failed with ENOENT: decide whether git itself is gone.
 *
 * The probe runs from `tmpdir()` — a cwd that exists even when the tree folder
 * that triggered the failure does not. If git answers there, the failure was
 * the caller's cwd and git stays trusted.
 */
function noteGitSpawnFailure() {
  const probe = spawnSync('git', ['--version'], { cwd: tmpdir(), windowsHide: true, timeout: 4000, stdio: 'ignore' })
  const missing = probe.error !== undefined ? isMissingExecutable(probe.error) : probe.status !== 0
  if (missing) gitMissingUntil = Date.now() + GIT_MISSING_TTL_MS
}

/** A git command answered: git is usable wherever the last failure came from. */
function noteGitSuccess() {
  gitMissingUntil = 0
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
      if (isMissingExecutable(error)) noteGitSpawnFailure()
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
      if (code === 0 || (code === 1 && (args[0] === 'check-ignore' || args[0] === 'grep'))) {
        noteGitSuccess()
        resolvePromise(stdout)
      } else rejectPromise(new Error(stderr || `git exited with ${code}`))
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
      listing = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], root)
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
  if (roots.length === 0 || gitUnavailable()) {
    return { ...await searchContentRaw(cwd, needle, limit, perFile), roots }
  }
  const hits = []
  const paths = new Set()
  let truncated = false
  for (const root of roots) {
    let stdout
    try {
      stdout = await runGit(['grep', '-n', '-I', '--no-color', '-F', '-m', String(perFile), '-e', needle, '--'], root)
    } catch {
      // A root whose git call failed is not fatal (and git may have disappeared
      // mid-search): fall back to the filesystem walk for the whole request.
      if (gitUnavailable()) return { ...await searchContentRaw(cwd, needle, limit, perFile), roots }
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

/**
 * Spawn one git command and hand its stdout to `onText` as it arrives — the
 * streaming twin of {@link runGit}. `git grep`/`git ls-files` exit 1 for "no
 * match", which is an answer, not a failure. A client that navigated away leaves
 * `stream.aborted` set: the child is killed and no more text is delivered.
 * @param args - git arguments.
 * @param cwd - working directory (one repo root).
 * @param onText - called with each stdout chunk.
 * @param stream - `{ aborted, children }` control object (see serveSearchStream).
 * @returns {Promise<void>} resolves when the child is gone.
 */
function streamGitStdout(args, cwd, onText, stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (stream !== undefined) stream.children.add(child)
    let stderr = ''
    let settled = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stream !== undefined && stream.aborted === true) return
      onText(chunk)
    })
    child.stderr?.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8') })
    const settle = (error) => {
      if (settled) return
      settled = true
      if (stream !== undefined) stream.children.delete(child)
      if (error === undefined) resolvePromise()
      else rejectPromise(error)
    }
    child.on('error', (error) => {
      if (isMissingExecutable(error)) noteGitSpawnFailure()
      settle(error)
    })
    child.on('close', (code) => {
      // Killed on purpose (row budget spent / client gone) is an ANSWER, not an
      // error: treating it as one made every fallback walk the whole root again.
      if (child.killed === true) settle(undefined)
      else if (stream !== undefined && stream.aborted === true) settle(undefined)
      else if (code === 0 || code === 1) { noteGitSuccess(); settle(undefined) }
      else settle(new Error(stderr || `git exited with ${code}`))
    })
  })
}

/**
 * SIGTERM every git child of one streamed search. Called when the row budget is
 * spent (nobody waits for the rest) and when the client disconnects.
 * @param stream - `{ children: Set<ChildProcess> }`, or undefined in unit tests.
 */
function killStreamChildren(stream) {
  if (stream === undefined || stream === null) return
  for (const child of stream.children) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

/**
 * Emit streamed matches in ROOT ORDER while the roots are searched concurrently.
 *
 * The sequential search visits the workspace root first and then the child repos
 * alphabetically; buffering per root and only flushing the head root keeps that
 * ranking exactly, so pages never reshuffle the dropdown. A page leaves as soon
 * as `pageSize` rows of the emitting root are buffered — the first page therefore
 * arrives after the fastest root instead of after the slowest.
 *
 * `maxItems` (the caller's `limit`) is counted on the EMITTED order, not on the
 * arrival order: roots answer concurrently, so a root late in the ranking must
 * not steal the budget from an earlier one. Hitting it closes the emitter and
 * fires `onFull` (the caller kills the git children there).
 * @param rootCount - number of roots (one buffer each).
 * @param pageSize - rows per emitted page.
 * @param emit - receives one page (non-empty array).
 * @param [options] - `{ maxItems, onFull }`.
 * @returns `{ push, finish, close, isClosed, isFull, total }`.
 */
function createOrderedPages(rootCount, pageSize, emit, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems > 0 ? options.maxItems : Infinity
  const onFull = typeof options.onFull === 'function' ? options.onFull : () => {}
  const buffers = []
  const finished = []
  for (let index = 0; index < rootCount; index += 1) { buffers.push([]); finished.push(false) }
  let head = 0
  let total = 0
  let full = false
  let closed = false
  /** Deliver `items` as pages, never more than the remaining budget. */
  function deliver(items) {
    let offset = 0
    while (offset < items.length && full !== true) {
      const take = Math.min(pageSize, items.length - offset, maxItems - total)
      if (take <= 0) break
      const page = items.slice(offset, offset + take)
      offset += take
      total += take
      emit(page)
      if (total >= maxItems) full = true
    }
    if (full === true && closed !== true) {
      closed = true
      onFull()
    }
  }
  function flush() {
    while (!closed && head < rootCount) {
      const buffer = buffers[head]
      while (buffer.length >= pageSize) deliver(buffer.splice(0, pageSize))
      if (finished[head] !== true) return
      if (buffer.length > 0) deliver(buffer.splice(0, buffer.length))
      head += 1
    }
  }
  return {
    push(index, items) {
      if (closed) return
      const buffer = buffers[index]
      for (const item of items) buffer.push(item)
      flush()
    },
    finish(index) {
      if (closed) return
      finished[index] = true
      flush()
    },
    close() {
      if (closed) return
      // Abort path: flush what was already accepted (in root order) so a caller
      // that closed early still sees the rows it asked for, then stop.
      for (let index = head; index < rootCount; index += 1) {
        const buffer = buffers[index]
        while (buffer.length > 0 && full !== true) deliver(buffer.splice(0, Math.min(pageSize, buffer.length)))
      }
      closed = true
    },
    isClosed() { return closed },
    isFull() { return full },
    total() { return total },
  }
}

/**
 * Identify the client bundle this host is serving right now.
 *
 * Why a page needs it: plugin bundles are served with `immutable` caching and a
 * revision-baked path, so an HTTP reload picks up a new build — but a page that
 * is ALREADY OPEN keeps running the bundle it booted with, which is why a
 * stylesheet tweak looks like it "needs a hard refresh". The stamp rides the
 * The stamp rides the stream's `hello` and `/dsh-ris-ide/build`; the page compares
 * it with the one it booted with and offers a refresh (it never reloads itself: a
 * reload would throw the conversation view or the IDE window's unsaved buffers
 * away, review C3-P1-2/P1-3).
 *
 * `standalone/window.html` is part of the stamp because the standalone window page
 * is served from it: its changes must reach the already-open window too. A DSH page
 * never loads it, so a window-only change makes the DSH hint say "refresh" where a
 * reload does not actually change the DSH bundle — harmless, and the window page
 * does pick it up.
 *
 * Metadata only (size + mtime): three `statSync` calls per hello is free, while
 * hashing a multi-megabyte bundle would not be.
 * @returns {string} 12 hex chars, stable until one of the bundle files changes.
 */
function clientBundleStamp() {
  const hash = createHash('sha1')
  const dir = fileURLToPath(new URL('.', import.meta.url))
  for (const name of ['client.js', 'client-codemirror.js', 'standalone/window.html']) {
    hash.update(name)
    hash.update('\0')
    try {
      const info = statSync(join(dir, name))
      hash.update(`${info.size}:${info.mtimeMs}`)
    } catch {
      // A trimmed install still gets a stable stamp; adding the file later
      // changes it, which is what the page needs to notice.
      hash.update('absent')
    }
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * Run `worker(root, index)` for every root with at most `concurrency` in flight.
 * A worker must handle its own errors — one broken repo must not cancel the rest.
 * @param roots - repo roots.
 * @param concurrency - maximum simultaneous workers.
 * @param worker - async `(root, index)`.
 * @returns {Promise<void>} resolves when every root was visited.
 */
async function forEachRootInParallel(roots, concurrency, worker) {
  let next = 0
  async function lane() {
    while (next < roots.length) {
      const index = next
      next += 1
      await worker(roots[index], index)
    }
  }
  const lanes = []
  const width = Math.max(1, Math.min(concurrency, roots.length))
  for (let index = 0; index < width; index += 1) lanes.push(lane())
  await Promise.all(lanes)
}

/**
 * Streaming filename search: the same matches, ignore rules and ordering as
 * {@link searchWorkspaceFiles}, delivered page by page while the roots are
 * listed in parallel.
 * @param cwd - workspace root (only for the no-git fallback).
 * @param roots - repo roots from {@link searchRoots}.
 * @param query - case-insensitive substring of the path or basename.
 * @param options - `{ limit, pageSize, onPage, stream }`.
 * @returns `{ files, count, truncated }` when the walk is complete.
 */
async function searchWorkspaceFilesStream(cwd, roots, query, options) {
  const { limit, pageSize, onPage, stream } = options
  const needle = String(query ?? '').toLowerCase()
  let files = 0
  let truncated = false
  // The `limit` is counted on the EMITTED (root-ordered) rows: see createOrderedPages.
  const emitter = createOrderedPages(roots.length, pageSize, onPage, {
    maxItems: limit,
    onFull: () => { truncated = true; killStreamChildren(stream) },
  })
  const take = (index, path) => {
    files += 1
    if (needle !== '' && path.toLowerCase().indexOf(needle) === -1) return
    emitter.push(index, [path])
  }
  if (roots.length === 0 || gitUnavailable()) {
    // No repo anywhere (or no git binary): walk and page the fallback listing.
    const all = await listRawFiles(cwd)
    const matches = []
    for (const path of all) {
      files += 1
      if (needle !== '' && path.toLowerCase().indexOf(needle) === -1) continue
      matches.push(path)
      if (matches.length >= limit) { truncated = true; break }
    }
    for (let offset = 0; offset < matches.length; offset += pageSize) onPage(matches.slice(offset, offset + pageSize))
    return { files, count: matches.length, truncated }
  }
  await forEachRootInParallel(roots, SEARCH_STREAM_CONCURRENCY, async (root, index) => {
    if (emitter.isClosed()) { emitter.finish(index); return }
    let rest = ''
    const consume = (relativePath) => {
      if (relativePath === '' || emitter.isClosed()) return
      take(index, join(root, relativePath))
    }
    try {
      await streamGitStdout(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], root, (chunk) => {
        const parts = `${rest}${chunk}`.split('\0')
        rest = parts.pop() ?? ''
        for (const relativePath of parts) consume(relativePath)
      }, stream)
    } catch {
      // git disappeared mid-search: walking this root keeps the answer usable.
      const all = await listRawFiles(root)
      for (const path of all) {
        if (emitter.isClosed()) break
        take(index, path)
      }
    }
    consume(rest)
    emitter.finish(index)
  })
  return { files, count: emitter.total(), truncated }
}

/**
 * Streaming content search: one `git grep` per repo root, run in parallel, with
 * the same literal matching / per-file cap / ordering as
 * {@link searchWorkspaceContent}.
 * @param cwd - workspace root (fallback walk).
 * @param roots - repo roots.
 * @param query - literal text.
 * @param options - `{ limit, perFile, pageSize, onPage, stream }`.
 * @returns `{ files, count, truncated }` when every root answered.
 */
async function searchWorkspaceContentStream(cwd, roots, query, options) {
  const { limit, perFile, pageSize, onPage, stream } = options
  const needle = String(query ?? '')
  const paths = new Set()
  let truncated = false
  // Same rule as the filename search: the limit applies to the emitted root order.
  const emitter = createOrderedPages(roots.length, pageSize, onPage, {
    maxItems: limit,
    onFull: () => { truncated = true; killStreamChildren(stream) },
  })
  const take = (index, hit) => {
    paths.add(hit.path)
    emitter.push(index, [hit])
  }
  if (roots.length === 0 || gitUnavailable()) {
    const fallback = await searchContentRaw(cwd, needle, limit, perFile)
    const hits = fallback.hits
    for (let offset = 0; offset < hits.length; offset += pageSize) onPage(hits.slice(offset, offset + pageSize))
    return { files: fallback.files, count: hits.length, truncated: fallback.truncated }
  }
  await forEachRootInParallel(roots, SEARCH_STREAM_CONCURRENCY, async (root, index) => {
    if (emitter.isClosed()) { emitter.finish(index); return }
    let rest = ''
    const consume = (raw) => {
      if (raw === '' || emitter.isClosed()) return
      const hit = parseGitGrepLine(root, raw)
      if (hit !== undefined) take(index, hit)
    }
    try {
      await streamGitStdout(['grep', '-n', '-I', '--no-color', '-F', '-m', String(perFile), '-e', needle, '--'], root, (chunk) => {
        const lines = `${rest}${chunk}`.split('\n')
        rest = lines.pop() ?? ''
        for (const raw of lines) consume(raw)
      }, stream)
    } catch {
      // A failing root is skipped, never fatal (same rule as the batch search).
    }
    consume(rest)
    emitter.finish(index)
  })
  return { files: paths.size, count: emitter.total(), truncated }
}

/**
 * One STREAMED search: NDJSON frames over a chunked response.
 *
 * Frames: `{type:'start',root,roots}` then `{type:'page',items:[...]}` (one per
 * page, in root order) and finally `{type:'done',files,matches,truncated}` —
 * or `{type:'error',code,message}` when the search failed after the headers.
 * A client disconnect aborts the git children of this request.
 * @param ctx - Host context (session cwd lookup).
 * @param req - Node request face.
 * @param res - Node response face.
 * @param options - `{ restrictToCwd }` (see {@link apply}).
 * @param content - `true` for content hits, `false` for filenames.
 */
async function serveSearchStream(ctx, req, res, options, content) {
  let finished = false
  const stream = { aborted: false, children: new Set() }
  const write = (payload) => {
    if (finished === true || res.writableEnded === true) return
    res.write(`${JSON.stringify(payload)}\n`)
  }
  const finish = (payload) => {
    if (finished === true) return
    finished = true
    if (res.writableEnded === true) return
    res.end(`${JSON.stringify(payload)}\n`)
  }
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const query = url.searchParams.get('q') ?? ''
    if (content && query.trim() === '') throw new TailError('bad-request', 'q (the text to search for) is required', 400)
    const rawLimit = Number(url.searchParams.get('limit') ?? '300')
    const limit = content
      ? (Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), CONTENT_SEARCH_MAX_HITS) : 300)
      : (Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 2000) : 300)
    const rawPerFile = Number(url.searchParams.get('perFile') ?? '8')
    const perFile = Number.isFinite(rawPerFile) ? Math.min(Math.max(1, Math.floor(rawPerFile)), CONTENT_SEARCH_MAX_PER_FILE) : 8
    const rawPageSize = Number(url.searchParams.get('pageSize') ?? String(SEARCH_STREAM_PAGE_DEFAULT))
    const pageSize = Number.isFinite(rawPageSize) ? Math.min(Math.max(1, Math.floor(rawPageSize)), SEARCH_STREAM_PAGE_MAX) : SEARCH_STREAM_PAGE_DEFAULT
    const roots = await searchRoots(cwd)
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    res.on('close', () => {
      if (finished === true) return
      stream.aborted = true
      for (const child of stream.children) {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }
    })
    write({ type: 'start', root: cwd, repoCount: roots.length })
    const onPage = (items) => write({ type: 'page', items })
    const result = content
      ? await searchWorkspaceContentStream(cwd, roots, query, { limit, perFile, pageSize, onPage, stream })
      : await searchWorkspaceFilesStream(cwd, roots, query, { limit, pageSize, onPage, stream })
    finish({ type: 'done', files: result.files, matches: result.count, truncated: result.truncated })
  } catch (error) {
    if (finished === true) return
    if (res.writableEnded !== true && res.headersSent !== true) { writeTailError(res, error); return }
    finish({ type: 'error', code: error?.code ?? 'error', message: error?.message ?? 'search failed' })
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
const TREE_WATCH_ALWAYS_IGNORED = new Set(['.git', IDE_STATE_DIR])

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
  if (gitUnavailable()) return undefined
  const cached = TREE_ALLOWED_CACHE.get(root)
  if (cached !== undefined && Date.now() - cached.at < TREE_ALLOWED_TTL_MS) return cached.value
  const files = new Set()
  const dirs = new Set([root])
  let listing
  try {
    listing = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], root)
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
        // A filtered tree hides `.git` too (see listIdeTree): it is metadata, and
        // it would otherwise count as a visible sibling and block package folding.
        if (allowed !== undefined && TREE_WATCH_ALWAYS_IGNORED.has(child.name)) continue
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

/** Workspaces whose `.dsh-ris-ide/` folder was already prepared in this process. */
const IDE_STATE_READY = new Set()

/** Legacy config files an older build wrote beside the workspace root. */
const LEGACY_STATE_FILES = [
  ['.dsh-ris-ide.json', 'config.json'],
  ['.dsh-ris-ide.settings.json', 'settings.json'],
]

/** Legacy sibling folders an older build wrote straight into the workspace root. */
const LEGACY_STATE_DIRS = [
  ['.dsh-ris-ide-trash', 'trash'],
  ['.dsh-ris-ide-cache', 'cache'],
  ['.dsh-ris-ide-stage', 'stage'],
]

/**
 * Create `<root>/.dsh-ris-ide/` and fold any legacy dot-folders into it, once per
 * workspace per process. Earlier builds scattered three sibling folders across the
 * workspace root (`-trash`, `-cache`, `-stage`), each of which the tree had to hide
 * by name; one folder is easier to explain and to gitignore. Contents are moved,
 * not dropped: a parked delete must stay restorable and a cache entry reusable.
 * @param {string} root - the workspace root.
 * @returns {Promise<string|undefined>} the state folder, or undefined without a root.
 */
async function ensureIdeStateDir(root) {
  if (root === undefined || root === null || root === '') return undefined
  const stateDir = join(root, IDE_STATE_DIR)
  const key = resolve(stateDir)
  if (IDE_STATE_READY.has(key)) return stateDir
  IDE_STATE_READY.add(key)
  try {
    await mkdir(stateDir, { recursive: true }).catch(() => undefined)
    for (const [legacyName, childName] of LEGACY_STATE_DIRS) {
      const from = join(root, legacyName)
      const info = await stat(from).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) continue
      const target = join(stateDir, childName)
      await mkdir(target, { recursive: true }).catch(() => undefined)
      // Parked deletes live in the legacy trash: a folder that could not be
      // emptied completely must stay where it is, or the failed move becomes a
      // silent delete of somebody's files.
      let moved = true
      for (const name of await readdir(from).catch(() => [])) {
        const to = join(target, name)
        const taken = await stat(to).then(() => true).catch(() => false)
        // Never overwrite same-named leftovers: keep both, the newcomer wins the
        // plain name and the legacy entry is parked with a suffix.
        const destination = taken ? join(target, `${name}-legacy-${Date.now()}`) : to
        await rename(join(from, name), destination).catch(() => { moved = false })
      }
      if (moved === true) await rm(from, { recursive: true, force: true }).catch(() => undefined)
    }
    for (const [legacyName, childName] of LEGACY_STATE_FILES) {
      const from = join(root, legacyName)
      const info = await stat(from).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      const to = join(stateDir, childName)
      // A file already at the new place wins: never overwrite the newer config.
      const taken = await stat(to).then(() => true).catch(() => false)
      if (!taken) await rename(from, to).catch(() => undefined)
    }
    return stateDir
  } catch (error) {
    // Let a later call retry the migration instead of remembering a failed one.
    IDE_STATE_READY.delete(key)
    throw error
  }
}

/**
 * One directory level for the IDE tree.
 * @param {string} target - absolute directory.
 * @param {string} cwd - workspace root (git-root search limit).
 * @returns {Promise<{entries: object[], truncated: boolean}>}
 */
async function listIdeTree(target, cwd, options) {
  await ensureIdeStateDir(cwd)
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
      if (!dirent.isDirectory() || TREE_WATCH_ALWAYS_IGNORED.has(dirent.name)) continue
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
    // A chunked save stages the document in `<file>.dsh-ris-ide-saving` next to
    // its target (same directory ⇒ the rename is atomic). It exists for a few
    // milliseconds, and after a crash it may linger: never show it as a tree row.
    if (dirent.name.endsWith(FS_WRITE_TEMP_SUFFIX)) continue
    // `.dsh-ris-ide/` holds the undo trash, the dependency-source cache and the
    // clipboard staging batches: implementation details, never tree rows — and
    // hidden in BOTH filter modes, like the trash row it replaced.
    if (dirent.name === IDE_STATE_DIR) continue
    // `.git` is repository metadata, not project content: a filtered tree hides it
    // exactly like TREE_WATCH_ALWAYS_IGNORED hides its watch events. `git ls-files`
    // never lists it and `check-ignore` never reports it, so without this line it
    // would be the one ignored-looking folder the .gitignore filter still showed
    // (every repo root has one, and a nested repo's `.git` file is the same noise).
    // "显示所有文件" keeps it visible, like every other hidden entry.
    if (allowed !== undefined && TREE_WATCH_ALWAYS_IGNORED.has(dirent.name)) continue
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
    git: repo !== undefined && gitUnavailable() !== true,
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
    `可用内存仅 ${memoryLabel(free)}（低于 ${memoryLabel(floor)}），为避免 swap 抖动已拒绝启动；请先停止不用的服务，或在 .dsh-ris-ide/config.json 里给程序配小一点的 jvmArgs（如 -Xmx768m）`,
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
async function readJsonBody(req, limitBytes = MAX_BODY_BYTES, tooLargeMessage = 'request body too large') {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (size > limitBytes) throw new TailError('bad-request', tooLargeMessage, 413)
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

/** How long the known-workspace path list is reused before it is rebuilt. */
const KNOWN_WORKSPACES_TTL_MS = 2000
/** `ctx` → `{ at, paths }`: the last {@link knownWorkspacePaths} answer per host. */
const KNOWN_WORKSPACES_CACHE = new WeakMap()

/**
 * Paths of every workspace this host knows: the dsh workspace registry plus the
 * window/workspace rows the plugin itself stamped into `dsh-window.json`. Cached
 * because {@link resolveCwd} runs on nearly every `/fs` and `/tail` request.
 *
 * Both sources are "this machine's workspaces as dsh shows them", never an
 * arbitrary absolute path: a page may only widen its fence to a workspace dsh
 * itself has registered (see {@link insideKnownWorkspace}).
 * @param ctx - Host context carrying the workspace registry.
 * @returns canonical absolute workspace paths.
 */
function knownWorkspacePaths(ctx) {
  const cached = KNOWN_WORKSPACES_CACHE.get(ctx)
  if (cached !== undefined && Date.now() - cached.at < KNOWN_WORKSPACES_TTL_MS) return cached.paths
  const paths = new Set()
  const add = (value) => {
    if (typeof value !== 'string' || value === '' || !isAbsolute(value)) return
    paths.add(canonicalWorkspacePath(value))
  }
  try {
    const registry = workspaceRegistryOf(ctx)
    const rows = registry === undefined ? [] : registry.list()
    for (const row of Array.isArray(rows) ? rows : []) add(row !== null && typeof row === 'object' ? row.path : row)
  } catch {
    // No workspace registry on this host: the dsh-window rows below still count.
  }
  try {
    const document = JSON.parse(readFileSync(join(proxyHomeDir(), DSH_WINDOW_FILENAME), 'utf8'))
    for (const key of ['windows', 'workspaces']) {
      const rows = Array.isArray(document?.[key]) ? document[key] : []
      for (const row of rows) add(row !== null && typeof row === 'object' ? row.cwd : row)
    }
  } catch {
    // No remembered windows yet (first run / another user's home).
  }
  const list = Array.from(paths)
  KNOWN_WORKSPACES_CACHE.set(ctx, { at: Date.now(), paths: list })
  return list
}

/**
 * Whether `target` is one of this host's workspaces or lives inside one.
 *
 * The realpath form is checked too: a registered path is canonical while the page
 * may still spell a symlinked ancestor, and a copy source that exists resolves to
 * the same inode either way.
 * @param ctx - Host context carrying the workspace registry.
 * @param target - absolute, already normalized path.
 * @returns whether the path belongs to a known workspace.
 */
function insideKnownWorkspace(ctx, target) {
  const roots = knownWorkspacePaths(ctx)
  if (roots.length === 0) return false
  const lexical = (root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  if (roots.some(lexical)) return true
  let real = ''
  try {
    real = realpathSync.native(target)
  } catch {
    return false
  }
  return roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

/**
 * The working directory a request runs against, from the live session header or
 * the caller-supplied absolute cwd — the page acts on the workspace it SHOWS.
 *
 * The header used to win unconditionally. A window opened while dsh was switching
 * workspaces can show workspace A while carrying a session whose header names B
 * (the header button fell back to the last workspace, or the window kept a session
 * from another workspace), and every mutation in A's tree then died with
 * 「不能对工作区之外的路径执行新建文件夹」. When the declared cwd is a workspace this
 * host knows, the page is inside its own rights and the declared cwd wins; any
 * other declared cwd keeps the header fence (it is never a licence for an
 * arbitrary absolute path).
 * @param ctx - Host context carrying `sessions` and the workspace registry.
 * @param sessionId - owning Session identity.
 * @param clientCwd - optional absolute cwd from the browser.
 * @returns the absolute working directory.
 */
function resolveCwd(ctx, sessionId, clientCwd) {
  const session = ctx.sessions?.get?.(sessionId)
  const headerCwd = session?.header?.cwd
  const header = typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : ''
  const declared = typeof clientCwd === 'string' && clientCwd !== '' && isAbsolute(clientCwd) ? clientCwd : ''
  // Same answer as the header costs nothing: leave the registry/file read to the
  // requests that actually disagree (the workspace-switch case).
  if (declared !== '' && declared === header) return header
  if (declared !== '' && insideKnownWorkspace(ctx, declared)) return declared
  if (header !== '') return header
  if (declared !== '') return declared
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
/**
 * Resolve the URL "open in browser" should use for one program.
 *
 * The dev-server URL the program printed into its own log (webpack/vite always do)
 * is the answer. dsh-ris-yds may then wrap it — but ONLY when the program is one of
 * the yds front-ends the workspace declares, and it is told which one (m00555);
 * otherwise the page opens directly (m00462). A missing/failing yds plugin never
 * blocks the button: ris-ide keeps working without it.
 */
async function serveOpenTarget(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd'))
    const rawDir = url.searchParams.get('dir')
    const logsDir = resolvePath(cwd, typeof rawDir === 'string' && rawDir !== '' ? rawDir : 'logs', true)
    const wanted = { id: url.searchParams.get('id') ?? '', name: url.searchParams.get('name') ?? '' }
    let program = await findProgramById(cwd, logsDir, wanted)
    if (program === null) throw new TailError('not-found', `没有找到程序「${wanted.id || wanted.name}」，刷新程序列表后再试`, 404)
    const devUrl = await logUrl(program.logPath)
    if (devUrl === undefined) {
      writeJson(res, 200, {
        ok: false,
        code: 'no-url',
        message: '这个程序还没打印出访问地址：先启动它，日志里出现 Local: http://localhost:<端口> 后再点',
      })
      return
    }
    // The 🌐 button opens the dev-server page the program printed. That page is
    // enough on its own; dsh-ris-yds is asked ONLY for a program that IS a yds
    // frontend, and it is told WHICH frontend: `yds.webConfig` declares one entry
    // per front-end project with its own port, and injecting another entry's rules
    // opens a page that talks to the wrong dev server (m00555). A plain npm app, a
    // spring program, or an unlisted frontend opens directly — no proxy, no
    // private browser (m00462), and a yds refusal is not an error.
    const frontend = program.kind === 'frontend' ? await ydsFrontendOf(req, cwd, program) : null
    if (frontend !== null) {
      const wrapped = await askYdsToWrap(req, cwd, devUrl, frontend)
      if (wrapped !== null && wrapped.ok === true && typeof wrapped.url === 'string') {
        writeJson(res, 200, { ...wrapped, source: 'yds' })
        return
      }
    }
    writeJson(res, 200, { ok: true, url: devUrl, source: 'dev-server' })
  } catch (error) {
    writeTailError(res, error)
  }
}

/** One program by id (config first, then a scan): the browser URL lives on its log. */
async function findProgramById(cwd, logsDir, ref) {
  const config = await readProgramConfig(cwd)
  if (config.exists === true && config.entries.length > 0) {
    const fromConfig = programsFromConfigEntries(cwd, config.entries, config.defaults)
    const hit = resolveProgramRef(await decoratePrograms(cwd, logsDir, fromConfig), ref)
    if (hit !== undefined) return hit
  }
  const scanned = await scanPrograms(cwd, logsDir, false).catch(() => [])
  return resolveProgramRef(scanned, ref) ?? null
}

/**
 * The yds front-end project identity of one program, or null when it is not one.
 *
 * `yds.webConfig` is keyed by the front-end project's directory name, and the
 * program's own directory basename is that project. Asking the probe first keeps
 * the rule honest: a plain npm app, the backend module, or a frontend the
 * workspace never declared as a yds frontend must NOT be proxied at all.
 * @returns {Promise<{code: string, name: string, relDir: string}|null>}
 */
async function ydsFrontendOf(req, cwd, program) {
  const dir = typeof program.dir === 'string' ? program.dir : ''
  if (dir === '') return null
  const code = basename(dir)
  if (code === '') return null
  const probe = await askYdsProbe(req, cwd)
  if (probe === null || probe.yds !== true) return null
  const frontends = Array.isArray(probe.frontends) ? probe.frontends : []
  if (frontends.indexOf(code) === -1) return null
  return {
    code,
    name: typeof program.name === 'string' && program.name !== '' ? program.name : code,
    relDir: typeof program.relDir === 'string' ? program.relDir : '',
  }
}

/** One short JSON answer from a sibling plugin route, or null when it is not there. */
async function askPluginJson(req, path, timeoutMs) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host === '') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${host}${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 404) return null
    const parsed = await response.json().catch(() => null)
    return parsed === null || typeof parsed !== 'object' ? null : parsed
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Ask dsh-ris-yds which front-ends this workspace declares (`null` = plugin absent). */
async function askYdsProbe(req, cwd) {
  return askPluginJson(req, `/dsh-ris-yds/probe?workspace=${encodeURIComponent(cwd)}`, 5000)
}

/**
 * Ask dsh-ris-yds to serve this URL through its injecting proxy for ONE frontend.
 * @param {object} frontend - `{code, name, relDir}` of the yds front-end program.
 * @returns {Promise<object|null>} the yds answer, or null when the plugin is absent.
 */
async function askYdsToWrap(req, cwd, devUrl, frontend) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host === '') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`http://${host}/dsh-ris-yds/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: cwd, devUrl, frontend }),
      signal: controller.signal,
    })
    if (response.status === 404) return null
    const parsed = await response.json().catch(() => null)
    return parsed === null ? null : parsed
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

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
    /**
     * Every mutation stays INSIDE the tree root.
     *
     * A path is only a string from the page: `/fs/remove` with `"../../../home"`
     * would otherwise recurse out of the tree and delete what it never listed.
     * The lexical check is enough because {@link resolvePath} already normalized
     * `.`/`..`, and `fs.rm` never follows a symlink to a directory.
     */
    const insideRoot = (target, action) => {
      notRoot(target, action)
      const base = root.endsWith(sep) ? root : `${root}${sep}`
      if (!target.startsWith(base)) throw new TailError('outside-workspace', `不能对工作区之外的路径执行${action}`, 403)
    }
    /**
     * A COPY may read from another workspace: the tree keeps absolute source paths
     * after the user switches workspace, and 「跨工作区复制粘贴」 is the same gesture as
     * copying a file to the desktop (user口径 m00220). Only READ side widens, only to
     * a workspace this host knows; writes below stay inside THIS tree, and a move
     * never crosses a workspace (it would relocate a tree out of its git boundary).
     */
    const insideCopySource = (target, action) => {
      notRoot(target, action)
      const base = root.endsWith(sep) ? root : `${root}${sep}`
      if (target.startsWith(base) || insideKnownWorkspace(ctx, target)) return
      throw new TailError('outside-workspace', `不能对工作区之外的路径执行${action}`, 403)
    }
    const exists = async (target) => stat(target).then(() => true).catch(() => false)
    /** A destination given as a FILE means its directory, same rule as a paste. */
    const asFolder = async (target) => {
      const info = await stat(target).catch(() => undefined)
      return info !== undefined && !info.isDirectory() ? dirname(target) : target
    }

    if (url.pathname === FS_MKDIR_PATH) {
      const target = one(body.path, 'path')
      insideRoot(target, '新建文件夹')
      checkLeafName(basename(target))
      await mkdir(target, { recursive: true })
      writeJson(res, 200, { ok: true, path: target, created: true })
      return
    }
    if (url.pathname === FS_CREATE_PATH) {
      const target = one(body.path, 'path')
      insideRoot(target, '新建文件')
      checkLeafName(basename(target))
      if (await exists(target)) throw new TailError('exists', `「${basename(target)}」已存在`, 409)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, typeof body.content === 'string' ? body.content : '', { flag: 'wx' })
      writeJson(res, 200, { ok: true, path: target, created: true })
      return
    }
    if (url.pathname === FS_COPY_PATH || url.pathname === FS_MOVE_PATH) {
      const copying = url.pathname === FS_COPY_PATH
      const from = one(body.from, 'from')
      if (copying) insideCopySource(from, '复制或移动')
      else insideRoot(from, '复制或移动')
      const toDir = await asFolder(one(body.toDir !== undefined ? body.toDir : body.to, 'toDir'))
      const requested = leafName(typeof body.name === 'string' ? body.name : '')
      const target = join(toDir, requested === '' ? basename(from) : requested)
      insideRoot(target, '复制或移动')
      if (target === from) throw new TailError('bad-request', '目标与源相同', 409)
      if (target.startsWith(from.endsWith(sep) ? from : `${from}${sep}`)) {
        throw new TailError('bad-request', '不能把目录复制/移动到它自己内部', 409)
      }
      const overwrite = body.overwrite === true
      // Deleting the old target first is how a "copy" could destroy its own source:
      // `assertReplacementIsSafe` refuses the aliasing cases (same inode, same real
      // path, target containing the source) and `replaceEntry` builds the new entry
      // beside the target and swaps it in with an atomic rename instead.
      await assertReplacementIsSafe(from, target, url.pathname === FS_COPY_PATH ? '复制' : '移动')
      await replaceEntry(from, target, { move: url.pathname === FS_MOVE_PATH, overwrite })
      writeJson(res, 200, { ok: true, path: target, from, [url.pathname === FS_COPY_PATH ? 'copied' : 'moved']: true })
      return
    }
    if (url.pathname === FS_REMOVE_PATH) {
      const target = one(body.path, 'path')
      insideRoot(target, '删除')
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

/** Longest leaf name the tree accepts (most Linux filesystems stop at 255 bytes). */
const FS_MAX_NAME_LENGTH = 255

/**
 * Refuse a leaf name no sane filesystem/UX round-trips: control characters would
 * break logs and every line-oriented protocol downstream, and 255 is the usual
 * filesystem cap.
 * @param name - one path component.
 */
function checkLeafName(name) {
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new TailError('bad-request', '文件名里不能有控制字符', 400)
  if (name.length > FS_MAX_NAME_LENGTH) throw new TailError('bad-request', '文件名太长', 400)
}

/**
 * One sanitized leaf name — never a path, never a control character.
 *
 * Names are only ever path components: every external command gets its paths as
 * argv/stdin and no shell is involved, so `'; rm -rf /'` is a file name and
 * nothing else. A newline or NUL would still corrupt logs, clipboard flavours and
 * any line-oriented protocol downstream, so those are refused at the door.
 * @param raw - requested name ('' means "keep the source name").
 * @returns the trimmed name, possibly ''.
 */
function leafName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (name === '') return ''
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TailError('bad-request', '非法的文件名', 400)
  }
  checkLeafName(name)
  return name
}

/** One sanitized leaf name for an import target (never a path, never empty). */
function importEntryName(raw) {
  const name = leafName(raw)
  if (name === '') throw new TailError('bad-request', '非法的文件名', 400)
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
/**
 * The folder a paste lands in.
 *
 * Callers may hand over a FILE as the destination: the tree selection can be a
 * file row, and 「粘贴」/Ctrl+V on it means "put it NEXT TO this file". Rather
 * than failing with 「粘贴目标不是目录」, a file target resolves to its own
 * directory. A target that does not exist at all is still an error.
 * @param {string} cwd - session working directory.
 * @param {string} raw - requested destination (absolute or cwd-relative).
 * @param {boolean} restrict - keep the destination inside `cwd`.
 * @returns {Promise<string>} an existing directory.
 */
async function resolvePasteDirectory(cwd, raw, restrict) {
  const root = resolve(cwd)
  const target = resolvePath(cwd, raw, restrict)
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new TailError('bad-request', `粘贴目标「${raw}」不存在`, 400)
  if (info.isDirectory()) {
    insideRootDirectory(root, target, raw)
    return target
  }
  const folder = dirname(target)
  const folderInfo = await stat(folder).catch(() => undefined)
  if (folderInfo === undefined || !folderInfo.isDirectory()) {
    throw new TailError('bad-request', '粘贴目标不是目录', 400)
  }
  insideRootDirectory(root, folder, raw)
  return folder
}

/**
 * A paste only ever lands INSIDE the tree root.
 *
 * `dir` arrives as a string from the page; without this check an overwrite paste
 * (`rm -rf` of the colliding entry) could be aimed at any absolute directory on
 * the machine. The tree only ever lists its own root, so nothing legitimate is
 * lost by refusing the rest.
 * @param root - absolute tree root (the session cwd).
 * @param dir - resolved destination directory.
 * @param raw - the requested value, for the error message.
 */
function insideRootDirectory(root, dir, raw) {
  const base = root.endsWith(sep) ? root : `${root}${sep}`
  if (dir !== root && !dir.startsWith(base)) {
    throw new TailError('outside-workspace', `粘贴目标「${raw}」不在工作区里`, 403)
  }
}

async function serveFsImport(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname === FS_UPLOAD_PATH) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
      const name = importEntryName(url.searchParams.get('name') ?? '')
      const dir = await resolvePasteDirectory(cwd, url.searchParams.get('dir') ?? '', options?.restrictToCwd === true)
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
      const temp = replacementTempPath(target, 'new')
      try {
        // Stream: a 100 MB upload must not be buffered in memory just to be written.
        // Never into the target itself: a failed or oversized upload used to truncate
        // the old file and then delete it. The bytes land in a same-directory temp
        // file, and only a COMPLETED upload is renamed over the target.
        await pipeline(req, gate, createWriteStream(temp, { flags: 'wx' }))
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await installReplacement(temp, target, { overwrite })
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
    const dir = await resolvePasteDirectory(cwd, typeof body.dir === 'string' ? body.dir : '', restrict)
    const name = importEntryName(typeof body.name === 'string' && body.name.trim() !== '' ? body.name : basename(source))
    const target = join(dir, name)
    if (target === source || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) {
      throw new TailError('bad-request', '不能把目录导入到它自己内部', 409)
    }
    const overwrite = body.overwrite === true
    // An import can name a destination that aliases the source (symlinked folder,
    // case-insensitive mount, same inode) or that CONTAINS it: deleting the old
    // target first would delete the thing being imported.
    await assertReplacementIsSafe(source, target, '导入')
    await replaceEntry(source, target, { overwrite, followLinks: true })
    writeJson(res, 200, { ok: true, path: target, name })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Is this Linux really WSL? Then the Windows clipboard is reachable through
 * interop, which is the ONLY way a web page can hand files to Explorer/desktop:
 * Chromium refuses `text/uri-list` (and `x-special/gnome-copied-files`) on
 * `Clipboard.write`, so the browser cannot publish a file list itself.
 * @returns whether the platform is WSL.
 */
export function isWsl() {
  if (IS_WINDOWS) return false
  try {
    return existsSync('/proc/version') && readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

/**
 * PowerShell that puts a FILE LIST on the Windows clipboard (CF_HDROP), with the
 * copy/move intent Explorer reads from `Preferred DropEffect`. Clipboard.SetDataObject
 * needs an STA thread, so callers pass `-STA`.
 *
 * The paths are NOT part of this text: they arrive on STDIN, one per line, so a
 * filename can never become PowerShell code (`'; rm -rf /; '` is just a name).
 * The only interpolated value is the DropEffect integer, chosen from a boolean.
 * @param cut - `true` for a MOVE intent (Explorer deletes the source on paste).
 * @returns the script text.
 */
export function windowsClipboardScript(cut) {
  const effect = cut ? 2 : 1
  return [
    // Node writes UTF-8 bytes; decode them here so Windows PowerShell's console
    // input encoding cannot mangle non-ASCII file names.
    '$stdin = [Console]::OpenStandardInput()',
    '$buffer = New-Object System.IO.MemoryStream',
    '$stdin.CopyTo($buffer)',
    '$raw = [Text.Encoding]::UTF8.GetString($buffer.ToArray())',
    // One path per line (CRLF tolerated); a path never contains a line break — the
    // route rejects those before this script runs.
    "$lines = @($raw -split \"`n\" | ForEach-Object { $_.TrimEnd(\"`r\") } | Where-Object { $_ -ne '' })",
    'if ($lines.Count -eq 0) { exit 2 }',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$data = New-Object System.Windows.Forms.DataObject',
    "$data.SetData('FileDrop', [string[]]$lines)",
    `$data.SetData('Preferred DropEffect', [byte[]]@(${effect},0,0,0))`,
    '[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)',
  ].join('\n')
}

/**
 * Run one child process, collecting its output as text.
 *
 * `command` and `args` are always fixed program names and flags — request data
 * travels on stdin, never through a shell, so nothing a user names can be read
 * as code or as another flag. A hard timeout kills a stuck helper (a clipboard
 * tool that waits for a display can hang forever).
 * @param command - executable name or path.
 * @param args - argument vector.
 * @param input - optional stdin payload.
 * @param timeoutMs - give up (and kill) after this long.
 * @returns `{ ok, stdout, stderr }`; `ok` is `code === 0`.
 */
function runTool(command, args, input, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    let child
    try {
      child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      settle({ ok: false, stdout: '', stderr: messageOf(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, stdout, stderr: `${stderr}${stderr === '' ? '' : '\n'}${command} 超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => settle({ ok: false, stdout, stderr: messageOf(error) }))
    child.on('close', (code) => settle({ ok: code === 0, stdout, stderr }))
    if (input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

/**
 * Translate one WSL path into the Windows path the clipboard must carry
 * (`\\wsl.localhost\<distro>\…`). `wslpath` knows better than any guess.
 * @param path - absolute Linux path.
 * @returns the Windows path, or `undefined` when `wslpath` refused.
 */
async function wslWindowsPath(path) {
  const result = await runTool('wslpath', ['-w', path])
  const converted = result.ok ? result.stdout.trim() : ''
  return converted === '' ? undefined : converted
}

/**
 * Put `paths` on the SYSTEM clipboard as a file list, per platform.
 * @param paths - absolute native paths (files and/or directories).
 * @param cut - `true` for a MOVE intent.
 * @returns `{ method }` naming the backend that took it.
 * @throws TailError `unsupported` when the platform has no way to do it.
 */
export async function writeSystemFileClipboard(paths, cut = false) {
  if (process.platform === 'win32' || isWsl()) {
    let windowsPaths = paths
    if (!IS_WINDOWS) {
      const converted = await Promise.all(paths.map((path) => wslWindowsPath(path)))
      if (converted.some((path) => path === undefined)) {
        throw new TailError('clipboard-failed', '无法把 WSL 路径转换成 Windows 路径（wslpath 不可用）', 500)
      }
      windowsPaths = converted
    }
    const encoded = Buffer.from(windowsClipboardScript(cut === true), 'utf16le').toString('base64')
    // The list rides on STDIN — see windowsClipboardScript(): no path is ever
    // spliced into a command line or a script.
    const result = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], `${windowsPaths.join('\n')}\n`)
    if (!result.ok) {
      throw new TailError('clipboard-failed', `PowerShell 写剪贴板失败：${(result.stderr || result.stdout).trim().split('\n')[0] || '未知错误'}`, 500)
    }
    return { method: IS_WINDOWS ? 'windows-powershell' : 'wsl-powershell' }
  }
  if (process.platform === 'darwin') {
    // Paths are argv here too: no path text is parsed as JXA source.
    const script = [
      'function run(argv) {',
      '  ObjC.import("AppKit")',
      '  var pb = $.NSPasteboard.generalPasteboard',
      '  pb.clearContents',
      '  pb.writeObjects($(argv.map(function (path) { return $.NSURL.fileURLWithPath(path) })))',
      '  return ""',
      '}',
    ].join('\n')
    const result = await runTool('osascript', ['-l', 'JavaScript', '-e', script, ...paths])
    if (!result.ok) {
      throw new TailError('clipboard-failed', `osascript 写剪贴板失败：${result.stderr.trim() || '未知错误'}`, 500)
    }
    return { method: 'macos-appkit' }
  }
  // Linux desktop: GNOME wants x-special/gnome-copied-files (it carries copy|cut),
  // wl-clipboard only offers text/uri-list — both are understood by file managers.
  // The payload is data on stdin: it is never an argument and never shell-parsed.
  const urls = paths.map((path) => `file://${encodeURI(path)}`)
  const gnomePayload = `${cut === true ? 'cut' : 'copy'}\n${urls.join('\n')}\n`
  const xclip = await runTool('xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files', '-i'], gnomePayload)
  if (xclip.ok) return { method: 'linux-xclip' }
  const uriList = `${urls.join('\r\n')}\r\n`
  const wlCopy = await runTool('wl-copy', ['--type', 'text/uri-list'], uriList)
  if (wlCopy.ok) return { method: 'linux-wl-copy' }
  throw new TailError('unsupported', '这台机器没有 xclip / wl-copy，浏览器也无法直接写文件剪贴板', 501)
}

/**
 * Create `target` as a mirror of `source` using HARD LINKS wherever one is
 * possible: a staged directory costs inodes, not bytes, and Explorer moving a
 * staged link out of the stage never touches the original path.
 *
 * Links only fail across filesystems (`EXDEV`); then — and only then — the entry
 * is copied for real, which is still safe (a copy of the original) and is charged
 * against the byte budget of one copy gesture.
 * @param {string} source - entry to mirror (file, directory or symlink).
 * @param {string} target - staged path to create.
 * @param {{budget: number}} meter - remaining bytes for real copies.
 */
async function mirrorStagedEntry(source, target, meter) {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      await mirrorStagedEntry(join(source, entry.name), join(target, entry.name), meter)
    }
    return
  }
  try {
    await link(source, target)
  } catch (error) {
    if (error === null || error === undefined || error.code !== 'EXDEV') throw error
    meter.budget -= info.size
    if (meter.budget < 0) throw clipboardStageTooLarge()
    await copyFile(source, target)
  }
}

/** Delete staging batches that are old or beyond the keep window. */
async function pruneClipboardStage(root) {
  await ensureIdeStateDir(root)
  const base = join(root, CLIPBOARD_STAGE_DIR)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const batches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(base, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined) batches.push({ path, at: info.mtimeMs })
  }
  batches.sort((left, right) => right.at - left.at)
  const now = Date.now()
  for (let index = 0; index < batches.length; index += 1) {
    if (index < CLIPBOARD_STAGE_KEEP_BATCHES && now - batches[index].at < CLIPBOARD_STAGE_TTL_MS) continue
    await rm(batches[index].path, { recursive: true, force: true }).catch(() => {})
  }
}

/** The staged copy cannot be expressed within the budget. Never fall back to the originals. */
function clipboardStageTooLarge() {
  const megabytes = Math.round(CLIPBOARD_STAGE_MAX_BYTES / (1024 * 1024))
  // Short on purpose: this string ends up in a toast.
  return new TailError('too-large', `超过 ${megabytes} MB，已取消复制到系统剪贴板`, 413)
}

/**
 * Stage a COPY publish: every entry gets its own numbered folder inside a fresh
 * batch, so two same-named files from different folders do not collide and the
 * names Explorer pastes are the original ones. Entries are hard-link mirrors — a
 * staged path is a different NAME for the same inode, so the originals stay put
 * whatever Explorer does with the pasted files.
 *
 * A failure is an ERROR, never a quiet "publish the originals instead": silently
 * handing the real paths to Explorer is exactly how files disappear.
 * @returns {Promise<{staged: string[], originals: string[], batchDir: string}>} the staged paths.
 */
async function stageClipboardCopy(root, paths) {
  await ensureIdeStateDir(root)
  const base = join(root, CLIPBOARD_STAGE_DIR)
  const batch = `${Date.now()}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const batchDir = join(base, batch)
  const staged = []
  const originals = []
  // Identity of every original AT PUBLISH TIME. The manifest is what makes a later
  // loss provable: dev/ino says whether the same file is still under that name,
  // size/mtime whether it was rewritten. See verifyClipboardStageOriginals.
  const snapshot = []
  const meter = { budget: CLIPBOARD_STAGE_MAX_BYTES }
  try {
    await mkdir(batchDir, { recursive: true })
    for (let index = 0; index < paths.length; index += 1) {
      const source = paths[index]
      const entryDir = join(batchDir, String(index))
      await mkdir(entryDir, { recursive: true })
      const target = join(entryDir, basename(source))
      const info = await lstat(source)
      await mirrorStagedEntry(source, target, meter)
      staged.push(target)
      originals.push(resolve(source))
      snapshot.push({
        path: resolve(source),
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        kind: info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'symlink' : 'file',
      })
    }
    await writeFile(join(batchDir, CLIPBOARD_STAGE_MANIFEST), JSON.stringify({ at: Date.now(), originals, staged, snapshot }), 'utf8')
    return { staged, originals, batchDir }
  } catch (error) {
    await rm(batchDir, { recursive: true, force: true }).catch(() => {})
    if (error instanceof TailError) throw error
    throw new TailError('clipboard-failed', `暂存这批内容失败：${messageOf(error)}`, 500)
  }
}

/** Findings already surfaced in this process, so a paste loop does not repeat them. */
const clipboardIntegrityNoted = new Set()

/** Where staging-integrity findings are appended (inside the plugin state dir). */
const CLIPBOARD_STAGE_INTEGRITY_LOG = 'integrity.log'

/**
 * Compare every staged batch's ORIGINALS with the snapshot taken when the copy was
 * published, and turn a vanished original into evidence.
 *
 * This is the trail for 「复制之后源文件不见了」. At publish time the plugin knows
 * each original's dev/ino/size/mtime; a later paste (or the next copy) re-checks
 * them. A `missing`/`replaced` finding is appended to
 * `.dsh-ris-ide/stage/integrity.log` with a timestamp, reported to the page once,
 * and carries the STAGED path — a hard link to the same inode, so the bytes are
 * still on disk and can be copied back by hand. The plugin's own deletions always
 * land in `.dsh-ris-ide/trash`, so a `missing` original here was moved or removed
 * by something outside the tree.
 * @param root - workspace root.
 * @returns {Promise<object[]>} findings for this call, each with a ready message.
 */
async function verifyClipboardStageOriginals(root) {
  await ensureIdeStateDir(root)
  const base = join(root, CLIPBOARD_STAGE_DIR)
  const findings = []
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(join(base, entry.name, CLIPBOARD_STAGE_MANIFEST), 'utf8').catch(() => undefined)
    if (manifest === undefined) continue
    let parsed
    try {
      parsed = JSON.parse(manifest)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const snapshot = Array.isArray(parsed.snapshot) ? parsed.snapshot : []
    const staged = Array.isArray(parsed.staged) ? parsed.staged : []
    for (let index = 0; index < snapshot.length; index += 1) {
      const record = snapshot[index]
      if (record === null || typeof record !== 'object' || typeof record.path !== 'string') continue
      const info = await lstat(record.path).catch(() => undefined)
      let status = 'ok'
      if (info === undefined) status = 'missing'
      else if (info.dev !== record.dev || info.ino !== record.ino) status = 'replaced'
      else if (info.size !== record.size || Math.abs(info.mtimeMs - record.mtimeMs) > 1) status = 'changed'
      if (status === 'ok' || status === 'changed') continue
      const stagedPath = typeof staged[index] === 'string' ? staged[index] : undefined
      const key = `${entry.name}\u0000${record.path}\u0000${status}`
      if (clipboardIntegrityNoted.has(key)) continue
      clipboardIntegrityNoted.add(key)
      const name = basename(record.path)
      const message = status === 'missing'
        ? `复制到系统剪贴板后，源文件「${name}」不见了。插件删除一律进 .dsh-ris-ide/trash，所以不是插件删的；暂存副本还在（${stagedPath ?? '已清理'}），可直接复制回来。`
        : `源文件「${name}」在复制后被换成了另一个文件（inode 从 ${record.ino} 变成 ${info.ino}），请确认这是什么操作做的。`
      findings.push({ batch: entry.name, path: record.path, status, staged: stagedPath, at: Date.now(), message })
    }
  }
  if (findings.length > 0) {
    const lines = findings.map((finding) => JSON.stringify(finding)).join('\n') + '\n'
    await appendFile(join(base, CLIPBOARD_STAGE_INTEGRITY_LOG), lines, 'utf8').catch(() => {})
  }
  return findings
}

/** staged path → original path for every batch still on disk. */
async function clipboardStageMapping(root) {
  await ensureIdeStateDir(root)
  const base = join(root, CLIPBOARD_STAGE_DIR)
  const mapping = new Map()
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(join(base, entry.name, CLIPBOARD_STAGE_MANIFEST), 'utf8').catch(() => undefined)
    if (manifest === undefined) continue
    let parsed
    try {
      parsed = JSON.parse(manifest)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const staged = Array.isArray(parsed.staged) ? parsed.staged : []
    const originals = Array.isArray(parsed.originals) ? parsed.originals : []
    for (let index = 0; index < staged.length; index += 1) {
      if (typeof staged[index] === 'string' && typeof originals[index] === 'string') {
        mapping.set(resolve(staged[index]), originals[index])
      }
    }
  }
  return mapping
}

/** Workspace root for one clipboard call, or undefined when the scope is unknown. */
function clipboardRoot(ctx, sessionId, cwd) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return resolveCwd(ctx, sessionId, typeof cwd === 'string' && cwd !== '' ? cwd : undefined)
  } catch {
    return undefined
  }
}

/**
 * Read the workspace scope of a clipboard request.
 *
 * The page sends it as a QUERY string (`?sessionId=…&cwd=…`), same as every other
 * tree route; the POST body may carry the same two fields for old clients. Reading
 * only one of them is what made copy answer "复制到系统剪贴板需要 sessionId".
 * @param {object} body - the parsed JSON body (may be empty).
 * @param {URL} url - the request URL.
 * @returns {{sessionId: string, cwd: string}} whatever the request actually carried.
 */
export function clipboardScope(body, url) {
  const pick = (key) => {
    const fromBody = body !== null && typeof body === 'object' && typeof body[key] === 'string' ? body[key] : ''
    if (fromBody !== '') return fromBody
    return url.searchParams.get(key) ?? ''
  }
  return { sessionId: pick('sessionId'), cwd: pick('cwd') }
}

/**
 * `POST /dsh-ris-ide/clipboard/files` — the tree's copy/cut mirrors the selection
 * onto the SYSTEM clipboard so it can be pasted into an OS file manager. The page
 * cannot do this itself (see {@link isWsl}); the Host owns the platform call.
 */
async function serveClipboardFiles(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const body = await readJsonBody(req)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const scope = clipboardScope(body, url)
    const raw = Array.isArray(body.paths) ? body.paths : []
    const requested = raw.filter((path) => typeof path === 'string' && path.trim() !== '')
    if (requested.length === 0) throw new TailError('bad-request', 'paths is required', 400)
    // The OS clipboard can only describe REAL locations: a relative path has no
    // meaning outside the tree, so refuse it instead of stat-ing the plugin's cwd.
    const paths = requested.map((path) => (isAbsolute(path) ? resolve(path) : ''))
    if (paths.some((path) => path === '')) throw new TailError('bad-request', '复制到系统剪贴板需要绝对路径', 400)
    if (paths.length > CLIPBOARD_MAX_ENTRIES) throw new TailError('bad-request', `一次最多复制 ${CLIPBOARD_MAX_ENTRIES} 项`, 400)
    // The backends carry the list as "one path per line" data (never as code or as
    // flags). A name containing a line break or a NUL cannot be expressed that way,
    // and silently splitting it into two entries would put a wrong path on the
    // clipboard — refuse it instead.
    if (paths.some((path) => /[\u0000\r\n]/.test(path))) {
      throw new TailError('bad-request', '复制到系统剪贴板不支持路径里的换行或控制字符', 400)
    }
    if (Buffer.byteLength(`${paths.join('\n')}\n`, 'utf8') > CLIPBOARD_MAX_PAYLOAD) {
      throw new TailError('bad-request', '一次复制的路径总长度超出上限', 400)
    }
    for (const path of paths) {
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) throw new TailError('not-found', `找不到「${path}」`, 404)
    }
    // A COPY goes out as a staged HARD-LINK mirror (see CLIPBOARD_STAGE_DIR): the
    // clipboard hands Explorer a different name for the same inode, so whatever it
    // does with the pasted files, the originals stay where they are. A CUT keeps
    // the real paths — cut means move, not "move a link".
    //
    // When the copy cannot be staged the route FAILS. Publishing the originals
    // instead would be a silent downgrade to exactly the behavior that lost files.
    const root = clipboardRoot(ctx, scope.sessionId, scope.cwd)
    let published = paths
    let staged = false
    if (body.cut !== true) {
      if (root === undefined) {
        throw new TailError('bad-request', '复制到系统剪贴板需要 sessionId', 400)
      }
      const rootInfo = await stat(root).catch(() => undefined)
      if (rootInfo === undefined || !rootInfo.isDirectory()) {
        throw new TailError('bad-request', `工作区不是目录：「${root}」`, 400)
      }
      const stage = await stageClipboardCopy(root, paths)
      published = stage.staged
      staged = true
      await pruneClipboardStage(root)
    }
    const result = await writeSystemFileClipboard(published, body.cut === true)
    writeJson(res, 200, { ok: true, count: published.length, method: result.method, staged, paths: published })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * PowerShell that PRINTS the clipboard's file list and text flavour — the reverse
 * of {@link windowsClipboardScript}. The output is line based (`F:<path>` per
 * file, one `T:<base64 utf8>` line), so nothing has to be re-escaped as code.
 */
export function windowsClipboardReadScript() {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$data = [System.Windows.Forms.Clipboard]::GetDataObject()',
    '$files = @()',
    '$text = ""',
    'if ($data -ne $null -and $data.GetDataPresent("FileDrop")) { $files = @($data.GetData("FileDrop")) }',
    'if ($data -ne $null -and $data.GetDataPresent("UnicodeText")) { $text = [string]$data.GetData("UnicodeText") }',
    'foreach ($file in $files) { [Console]::Out.WriteLine("F:" + [string]$file) }',
    '[Console]::Out.WriteLine("T:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$text)))',
  ].join('\n')
}

/**
 * Split {@link windowsClipboardReadScript}'s stdout into paths and text.
 * @param stdout - the script output.
 * @returns `{ files, text }` (paths are the raw Windows strings).
 */
export function parseClipboardRead(stdout) {
  const files = []
  let text = ''
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('F:')) files.push(line.slice(2))
    else if (line.startsWith('T:')) text = Buffer.from(line.slice(2), 'base64').toString('utf8')
  }
  return { files, text }
}

/**
 * Map Windows clipboard paths onto this WSL filesystem — `/fs/import` needs a
 * real Linux path. Entries that cannot be mapped are dropped, never guessed.
 * @param rawPaths - paths as Windows wrote them (`\\wsl.localhost\…`, `C:\…`).
 * @param options - `distro` overrides `$WSL_DISTRO_NAME` (tests).
 * @returns absolute Linux paths, de-duplicated and capped.
 */
export function clipboardPathsToLinux(rawPaths, options = {}) {
  if (!Array.isArray(rawPaths)) return []
  const distro = String(options.distro ?? process.env.WSL_DISTRO_NAME ?? '').toLowerCase()
  const mapped = []
  const seen = new Set()
  for (const raw of rawPaths) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (value === '') continue
    let path
    if (value.startsWith('/')) path = value
    else {
      const wsl = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i.exec(value)
      const drive = /^([A-Za-z]):\\(.*)$/.exec(value)
      if (wsl !== null) {
        // A different distro's filesystem is not visible from here.
        if (distro !== '' && wsl[1].toLowerCase() !== distro) continue
        path = '/' + wsl[2].replace(/\\/g, '/')
      } else if (drive !== null) {
        path = '/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/g, '/')
      } else continue
    }
    if (seen.has(path)) continue
    seen.add(path)
    mapped.push(path)
    if (mapped.length >= CLIPBOARD_MAX_ENTRIES) break
  }
  return mapped
}

/** Extract `file://` URIs from a gnome-copied-files / text/uri-list payload. */
function fileUrlsToPaths(text) {
  const files = []
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line === 'copy' || line === 'cut') continue
    if (!line.startsWith('file://')) continue
    try {
      const url = new URL(line)
      if (url.protocol !== 'file:') continue
      files.push(decodeURIComponent(url.pathname))
    } catch {
      // An unparsable line is not a file; the next line still is.
    }
    if (files.length >= CLIPBOARD_MAX_ENTRIES) break
  }
  return files
}

/**
 * Read the SYSTEM clipboard: the file list it carries plus its text flavour.
 * @returns `{ files, text, method }` — `files` are native (Linux) absolute paths.
 */
export async function readSystemFileClipboard() {
  if (process.platform === 'win32' || isWsl()) {
    const encoded = Buffer.from(windowsClipboardReadScript(), 'utf16le').toString('base64')
    const result = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded])
    if (!result.ok) {
      throw new TailError('clipboard-failed', `PowerShell 读剪贴板失败：${(result.stderr || result.stdout).trim().split('\n')[0] || '未知错误'}`, 500)
    }
    const parsed = parseClipboardRead(result.stdout)
    return {
      files: IS_WINDOWS ? parsed.files : clipboardPathsToLinux(parsed.files),
      text: parsed.text,
      method: IS_WINDOWS ? 'windows-powershell' : 'wsl-powershell',
    }
  }
  if (process.platform === 'darwin') {
    // JXA: the file list is whatever NSURL objects the pasteboard exposes.
    const script = [
      'function run() {',
      '  ObjC.import("AppKit")',
      '  var pasteboard = $.NSPasteboard.generalPasteboard',
      '  var files = []',
      '  var urls = pasteboard.readObjectsForClassesOptions($([$.NSURL]), $({}))',
      '  var count = urls ? Number(urls.count) : 0',
      '  for (var index = 0; index < count; index += 1) { files.push(ObjC.unwrap(urls.objectAtIndex(index).path)) }',
      '  var text = ObjC.unwrap(pasteboard.stringForType("public.utf8-plain-text"))',
      '  return JSON.stringify({ files: files, text: text || "" })',
      '}',
    ].join('\n')
    const result = await runTool('osascript', ['-l', 'JavaScript', '-e', script], undefined, 8000)
    if (!result.ok) {
      throw new TailError('clipboard-failed', `osascript 读剪贴板失败：${result.stderr.trim() || '未知错误'}`, 500)
    }
    let parsed = { files: [], text: '' }
    try {
      parsed = JSON.parse(result.stdout.trim() || '{}')
    } catch {
      parsed = { files: [], text: '' }
    }
    return {
      files: Array.isArray(parsed.files) ? parsed.files.filter((path) => typeof path === 'string' && path !== '') : [],
      text: typeof parsed.text === 'string' ? parsed.text : '',
      method: 'macos-appkit',
    }
  }
  // Linux desktop: xclip / wl-paste expose the SAME flavours the writer sets.
  const xclip = await runTool('xclip', ['-selection', 'clipboard', '-o', '-t', 'x-special/gnome-copied-files'], undefined, 8000)
  if (xclip.ok) return { files: fileUrlsToPaths(xclip.stdout), text: '', method: 'linux-xclip' }
  const wlPaste = await runTool('wl-paste', ['--type', 'text/uri-list'], undefined, 8000)
  if (wlPaste.ok) return { files: fileUrlsToPaths(wlPaste.stdout), text: '', method: 'linux-wl-paste' }
  return { files: [], text: '', method: 'unsupported' }
}

/**
 * `GET /dsh-ris-ide/clipboard/read` — what the SYSTEM clipboard holds right now.
 * Read-only: it never writes the clipboard and never touches the filesystem.
 */
async function serveClipboardRead(ctx, req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const root = clipboardRoot(ctx, url.searchParams.get('sessionId') ?? '', url.searchParams.get('cwd') ?? '')
    const state = await readSystemFileClipboard()
    // A copy the tree published sits on the clipboard as a STAGED path. Translate
    // it back: the page compares against what the tree copied, so a round-trip must
    // look like the original selection (otherwise Ctrl+C → Ctrl+V would import a
    // second copy of files the tree already has).
    let files = state.files
    let warnings = []
    if (root !== undefined) {
      const mapping = await clipboardStageMapping(root)
      if (mapping.size > 0) files = files.map((path) => mapping.get(resolve(path)) ?? path)
      // A staged original that vanished between Ctrl+C and Ctrl+V is the exact
      // symptom this route exists to explain: say so once, with the staged path
      // that still holds the bytes, and leave a line in stage/integrity.log.
      warnings = (await verifyClipboardStageOriginals(root)).map((finding) => finding.message)
    }
    writeJson(res, 200, { ok: true, files, text: state.text, method: state.method, warnings })
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

/** Suffix of the sibling file a chunked save is staged in before the rename. */
const FS_WRITE_TEMP_SUFFIX = '.dsh-ris-ide-saving'

/**
 * Write ONE chunk of a chunked `POST /fs/write`.
 *
 * The chunks land in `<target>.dsh-ris-ide-saving` at their byte offset (so a
 * retried chunk overwrites itself instead of appending twice) and only the chunk
 * with `final !== false` truncates to `offset + bytes` and renames the temp file
 * over the target. A reader therefore sees the old file or the new one, never a
 * half-written mixed document, and a failed save leaves the target untouched.
 *
 * @param target - absolute path the editor is saving.
 * @param body - `{content, offset, final}` from the request.
 */
async function writeChunk(target, body) {
  const offset = body.offset
  if (!Number.isInteger(offset) || offset < 0) throw new TailError('bad-request', 'offset must be a non-negative integer', 400)
  const buffer = Buffer.from(body.content, 'utf8')
  const staging = `${target}${FS_WRITE_TEMP_SUFFIX}`
  if (offset === 0) await writeFile(staging, '')
  // Chunks must be contiguous: a lost chunk would otherwise leave zero bytes in
  // the middle of the document, which is worse than refusing the save.
  const present = offset === 0 ? { size: 0 } : await stat(staging).catch(() => undefined)
  if (present === undefined) throw new TailError('chunk-out-of-order', 'the previous chunk never arrived; save again', 409)
  if (present.size !== offset) throw new TailError('chunk-out-of-order', 'a chunk is missing; save again', 409)
  const handle = await open(staging, 'r+')
  try {
    await handle.write(buffer, 0, buffer.length, offset)
    if (body.final !== false) await handle.truncate(offset + buffer.length)
  } finally {
    await handle.close()
  }
  if (body.final !== false) await rename(staging, target)
}

/** Infix of the throwaway sibling every REPLACE builds in before it takes the target's name. */
const FS_REPLACE_TEMP_SUFFIX = '.dsh-ris-ide-replace'

/**
 * One throwaway path in `target`'s OWN directory.
 *
 * Same directory means same filesystem, so the final `rename` is atomic. The name
 * ends with the save-temp suffix, which the tree listing already skips, so a
 * replacement never shows up as a row. The leaf is cut to 60 chars: a long target
 * name must not push the temp name past the usual 255-byte component cap.
 * @param target - the entry being replaced.
 * @param kind - `'new'` (content being built) or `'old'` (previous entry, kept until the swap).
 */
function replacementTempPath(target, kind) {
  const leaf = basename(target).slice(0, 60)
  const random = Math.random().toString(36).slice(2, 8)
  return join(dirname(target), `.${leaf}${FS_REPLACE_TEMP_SUFFIX}-${kind}-${process.pid.toString(36)}${random}${FS_WRITE_TEMP_SUFFIX}`)
}

/** dev/ino of an existing path, or undefined when nothing is there. */
async function entryIdentity(path) {
  const info = await stat(path).catch(() => undefined)
  return info === undefined ? undefined : { dev: info.dev, ino: info.ino }
}

/** Real path of `path`, or its lexical form when it does not exist (yet). */
function resolvedRealPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Refuse a replacement that would destroy the thing being copied or moved.
 *
 * Overwrite used to delete `target` FIRST and only then copy/rename onto the empty
 * name, so a target that is the source under another name destroyed the source:
 * - the SAME inode under two names (hard link; a staged clipboard copy is exactly that);
 * - the same REAL path (a destination directory that is a symlink into the source's
 *   own directory, or a case-insensitive mount such as `/mnt/c`);
 * - a directory that CONTAINS the source — `rm(target)` takes the source with it,
 *   and the copy then fails on a source that no longer exists.
 * The routes compare paths as strings, which cannot see any of those.
 * @param source - entry being copied/moved/imported.
 * @param target - entry it would replace.
 * @param action - verb for the message (`复制`/`移动`/`导入`).
 */
async function assertReplacementIsSafe(source, target, action) {
  const from = await entryIdentity(source)
  const to = await entryIdentity(target)
  if (from !== undefined && to !== undefined && from.dev === to.dev && from.ino === to.ino) {
    throw new TailError('same-entry', `「${basename(source)}」和「${basename(target)}」是同一个条目，拒绝覆盖以免丢数据`, 409)
  }
  const realSource = resolvedRealPath(source)
  const realTarget = resolvedRealPath(target)
  if (realSource === realTarget) {
    throw new TailError('same-entry', `目标「${basename(target)}」就是源本身，已拒绝${action}`, 409)
  }
  if (realTarget.startsWith(`${realSource}${sep}`)) {
    throw new TailError('bad-request', `不能把「${basename(source)}」${action}到它自己内部`, 409)
  }
  if (realSource.startsWith(`${realTarget}${sep}`)) {
    throw new TailError('bad-request', `「${basename(target)}」是包含源的目录：覆盖它会连源一起删掉，已拒绝`, 409)
  }
}

/**
 * Put a completed temporary entry at `target`.
 *
 * The previous entry is renamed to a sibling backup name first (a same-directory
 * rename, never a delete), the new entry takes the name with one atomic rename,
 * and only then is the backup dropped. A failure at any step restores the backup
 * and leaves the temporary file for the caller to remove.
 * @param temp - fully written sibling of `target`.
 * @param target - name the new content should end up under.
 * @param options - `{overwrite}`: without it, an existing target is a 409.
 */
async function installReplacement(temp, target, { overwrite = false } = {}) {
  const existing = await pathExists(target)
  if (existing && !overwrite) {
    // The caller may already have built the new content (a full copy of the source):
    // it must never linger next to the target as debris.
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    throw new TailError('exists', `「${basename(target)}」已存在`, 409)
  }
  const backup = existing ? replacementTempPath(target, 'old') : undefined
  if (backup !== undefined) {
    try {
      await rename(target, backup)
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  try {
    await rename(temp, target)
  } catch (error) {
    if (backup !== undefined) await rename(backup, target).catch(() => {})
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  if (backup !== undefined) await rm(backup, { recursive: true, force: true }).catch(() => {})
}

/**
 * Copy or move `source` onto `target`, replacing an existing target only on
 * explicit `overwrite`.
 *
 * The old target is never deleted before the new content exists, so a failed copy
 * leaves both entries intact, and a reader never sees the target half-written.
 * @param source - entry to copy (`move: false`) or move (`move: true`).
 * @param target - destination name.
 * @param options - `{move, overwrite, followLinks}`; `followLinks` keeps the
 *   import route's historical "copy what the symlink points at" behaviour.
 */
async function replaceEntry(source, target, { move = false, overwrite = false, followLinks = false } = {}) {
  await mkdir(dirname(target), { recursive: true })
  if (move) {
    const existing = await pathExists(target)
    if (existing && !overwrite) throw new TailError('exists', `目标位置已有「${basename(target)}」`, 409)
    const backup = existing ? replacementTempPath(target, 'old') : undefined
    if (backup !== undefined) await rename(target, backup)
    try {
      await rename(source, target)
    } catch (error) {
      // The old entry is still under the backup name: put it back, nothing lost.
      if (backup !== undefined) await rename(backup, target).catch(() => {})
      throw error
    }
    if (backup !== undefined) await rm(backup, { recursive: true, force: true }).catch(() => {})
    return
  }
  const temp = replacementTempPath(target, 'new')
  try {
    const info = await (followLinks ? stat(source) : lstat(source))
    if (info.isDirectory()) {
      // Node's cp keeps the tree shape and refuses to merge into anything.
      await cp(source, temp, { recursive: true, errorOnExist: true, force: false, dereference: followLinks })
    } else if (info.isSymbolicLink()) {
      await symlink(await readlink(source), temp)
    } else {
      await copyFile(source, temp)
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  await installReplacement(temp, target, { overwrite })
}

/**
 * The IDE's own workspace file API — no `dsh-better-sidebar` involved.
 *
 * - `GET  /fs/read?sessionId&path`  → `{ok, kind:'text', content, size, mtimeMs}`,
 *   or `{ok:true, kind:'binary'|'too-large', size, message}` (the caller decides
 *   how to render those).
 * - `POST /fs/write` `{sessionId, path, cwd?, content}` → `{ok, mtimeMs}`.
 *   With `{offset, final}` it is ONE CHUNK of a chunked save: the bytes are written
 *   at `offset` into a sibling temp file and the LAST chunk renames it over the
 *   target, so a save is never seen half-written and has no practical size cap.
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
      // A save carries the entire document: give this one route its own (much
      // larger) cap and say so in Chinese when even that is exceeded.
      const writeCap = typeof options?.maxWriteBytes === 'number' && options.maxWriteBytes > 0
        ? options.maxWriteBytes
        : FS_WRITE_MAX_BODY_BYTES
      const body = await readJsonBody(req, writeCap, `文件太大（超过 ${Math.floor(writeCap / (1024 * 1024))} MB），不能在这里保存；请改用其他编辑器`)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const raw = typeof body.path === 'string' ? body.path : ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      if (raw === '') throw new TailError('bad-request', 'path is required', 400)
      if (typeof body.content !== 'string') throw new TailError('bad-request', 'content must be a string', 400)
      const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
      const target = resolvePath(cwd, raw, options?.restrictToCwd === true)
      const info = await stat(target).catch(() => undefined)
      if (info !== undefined && !info.isFile()) throw new TailError('not-a-file', `"${target}" is not a regular file`, 400)
      // Chunked saves are marked by `offset`; every other request keeps the old
      // one-shot behaviour. Both paths end with a rename-free / rename-based
      // write of exactly the bytes the editor held.
      if (typeof body.offset === 'number' && Number.isFinite(body.offset)) {
        await writeChunk(target, body)
        const afterChunk = await stat(target).catch(() => undefined)
        writeJson(res, 200, {
          ok: true,
          path: target,
          chunked: true,
          final: body.final !== false,
          mtimeMs: afterChunk === undefined ? undefined : afterChunk.mtimeMs,
        })
        return
      }
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
/**
 * Drop window entries whose stream has been gone for a while. A plain reload
 * closes and reopens the stream within a second, so the grace period keeps the
 * entry alive across it instead of flickering "no window".
 * @param now - current epoch ms (tests pass a fixed clock).
 */
function sweepIdeWindows(now = Date.now()) {
  for (const [key, entry] of IDE_WINDOWS) {
    if (entry.streams <= 0 && now - entry.at > IDE_WINDOW_GRACE_MS) IDE_WINDOWS.delete(key)
  }
}

/** The registry key of one IDE window: its name when the page knows it, else its cwd. */
function ideWindowKey(name, cwd) {
  if (typeof name === 'string' && name !== '') return `name:${name}`
  if (typeof cwd === 'string' && cwd !== '') return `cwd:${resolve(cwd)}`
  return undefined
}

/** One IDE window's stream opened: remember it (the stream IS the liveness). */
function ideWindowOpened(key, info) {
  if (typeof key !== 'string' || key === '') return
  const previous = IDE_WINDOWS.get(key)
  IDE_WINDOWS.set(key, {
    key,
    name: typeof info?.name === 'string' ? info.name : previous !== undefined ? previous.name : '',
    cwd: typeof info?.cwd === 'string' ? info.cwd : previous !== undefined ? previous.cwd : undefined,
    sessionId: typeof info?.sessionId === 'string' && info.sessionId !== ''
      ? info.sessionId
      : previous !== undefined ? previous.sessionId : '',
    at: Date.now(),
    streams: (previous !== undefined ? previous.streams : 0) + 1,
  })
}

/** One IDE window's stream closed (the entry survives until the grace expires). */
function ideWindowClosed(key) {
  if (typeof key !== 'string' || key === '') return
  const entry = IDE_WINDOWS.get(key)
  if (entry === undefined) return
  entry.streams = Math.max(0, entry.streams - 1)
  entry.at = Date.now()
}

/**
 * List live IDE windows, optionally only one window name or one workspace.
 * @param {{name?: string, cwd?: string}} [filter] - narrow by window name and/or cwd.
 * @returns `[{ name, cwd, sessionId, alive, idleMs }]`, most recently seen first.
 */
export function listIdeWindows(filter) {
  sweepIdeWindows()
  const wantedName = typeof filter?.name === 'string' && filter.name !== '' ? filter.name : undefined
  const wantedCwd = typeof filter?.cwd === 'string' && filter.cwd !== '' ? resolve(filter.cwd) : undefined
  const now = Date.now()
  const out = []
  for (const entry of IDE_WINDOWS.values()) {
    if (wantedName !== undefined && entry.name !== wantedName) continue
    if (wantedCwd !== undefined && entry.cwd !== wantedCwd) continue
    out.push({
      name: entry.name,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      alive: entry.streams > 0,
      idleMs: now - entry.at,
    })
  }
  out.sort((a, b) => a.idleMs - b.idleMs)
  return out
}

/**
 * The DSH session a workspace currently belongs to: the newest LIVE session whose
 * header cwd is that workspace. A window that outlived its session (or the host
 * restart) uses this to hop onto the current one instead of staying on a dead id.
 * @param ctx - the Host context (`ctx.sessions` is the session store).
 * @param cwd - the workspace.
 * @returns `{ id }`, or `null` when no live session sits in that workspace.
 */
export function liveSessionFor(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  let live
  try {
    live = ctx?.sessions?.list?.()
  } catch {
    return null
  }
  if (!Array.isArray(live)) return null
  const root = resolve(cwd)
  // The IDE is workspace-level: a window opened inside a program folder still
  // belongs to the workspace's session, so an ancestor cwd matches too — but an
  // exact match always wins over an ancestor one.
  let ancestor
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const session = live[index]
    const sessionCwd = session?.header?.cwd
    if (typeof sessionCwd !== 'string' || sessionCwd === '') continue
    const base = resolve(sessionCwd)
    if (base === root) return { id: session.id }
    if (ancestor === undefined && root.startsWith(base.endsWith('/') ? base : `${base}/`)) ancestor = { id: session.id }
  }
  return ancestor ?? null
}

/** Whether `id` is still a live session here (a stale window id stops being one). */
function isLiveSession(ctx, id) {
  if (typeof id !== 'string' || id === '') return false
  try {
    return ctx?.sessions?.get?.(id) !== undefined
  } catch {
    // A detached id throws instead of answering: treat it as gone.
    return false
  }
}

/**
 * `GET /dsh-ris-ide/workspaces` — the sidebar rows and this host's origin, straight
 * from the live context (m00186).
 *
 * Loopback only like every other route, and read-only: a dsh page (or the daemon
 * probing a per-instance origin file) gets the authoritative list without any file
 * on disk being involved.
 * @param ctx - Host context.
 * @param req - Node request face.
 * @param res - Node response face.
 */
function serveWorkspaces(ctx, req, res) {
  if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
  const now = Date.now()
  // Answering proves this host is alive, so republish the shared document on the way
  // out: a reader that only knows the file then sees the same answer.
  refreshDshWindows(ctx)
  writeJson(res, 200, {
    ok: true,
    url: dshWindowOriginFor(ctx),
    at: new Date(now).toISOString(),
    workspaces: dshWorkspaceRows(ctx),
  })
}

/** `GET /dsh-ris-ide/windows` — the live windows, and the session of one workspace. */
async function serveWindows(ctx, req, res) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const rawCwd = url.searchParams.get('cwd') ?? ''
    if (rawCwd !== '' && !isAbsolute(expandHome(rawCwd))) {
      throw new TailError('bad-request', 'cwd must be an absolute workspace path', 400)
    }
    const cwd = rawCwd === '' ? undefined : resolve(expandHome(rawCwd))
    const name = (url.searchParams.get('name') ?? '').trim()
    writeJson(res, 200, {
      ok: true,
      windows: listIdeWindows({ name: name === '' ? undefined : name, cwd }),
      session: cwd === undefined ? null : liveSessionFor(ctx, cwd),
    })
  } catch (error) {
    writeTailError(res, error)
  }
}

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

  // A standalone IDE window keeps ONE stream for its whole lifetime, so that
  // connection IS its liveness: `dsh web` restarts, the page reconnects, the
  // window re-registers by itself — no heartbeat, no stored state to go stale.
  const isIdeWindow = url.searchParams.get('window') === '1'
  // The window's workspace does NOT depend on the requested topics: a window whose
  // first connection only asks for `hello` never needs a resolved cwd, yet it must
  // still register (otherwise the ⧉ button sees no window and opens a second one).
  const rawWindowCwd = isIdeWindow ? (url.searchParams.get('cwd') ?? '').trim() : ''
  const windowCwd = isIdeWindow
    ? (typeof cwd === 'string' ? cwd : (rawWindowCwd !== '' && isAbsolute(rawWindowCwd) ? resolve(rawWindowCwd) : undefined))
    : undefined
  const helloCwd = typeof cwd === 'string' ? cwd : windowCwd
  const streamWindowName = (url.searchParams.get('wname') ?? '').trim()
  const windowKey = windowCwd !== undefined ? ideWindowKey(streamWindowName, windowCwd) : undefined
  if (windowKey !== undefined) {
    ideWindowOpened(windowKey, {
      name: streamWindowName,
      cwd: windowCwd,
      sessionId: (url.searchParams.get('sessionId') ?? '').trim(),
    })
  }

  let closed = false
  // The window entry must be released exactly once: an aborted SSE connection may
  // report 'error' and then 'close' (and a clean reload only reports 'close'), and
  // double-decrementing would hide a real second stream.
  let windowSettled = false
  const settleWindow = () => {
    if (windowSettled === true) return
    windowSettled = true
    if (windowKey !== undefined) ideWindowClosed(windowKey)
  }
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
  const streamSession = (url.searchParams.get('sessionId') ?? '').trim()
  send('hello', {
    ok: true,
    version: PKG_VERSION,
    // Which client bundle this host serves NOW (see clientBundleStamp): a page
    // that booted an older one reloads itself instead of needing Ctrl+Shift+R.
    build: clientBundleStamp(),
    root: cwd,
    topics,
    window: windowCwd !== undefined,
    // The session this workspace is on RIGHT NOW. A window left open across a
    // `dsh web` restart reads this and follows the new session instead of
    // keeping the dead id it was opened with.
    session: helloCwd === undefined ? null : liveSessionFor(ctx, helloCwd),
    // Whether the id this stream asked for is still a live session here: false
    // means "the page may switch to `session`", null means it never had one.
    windowSession: streamSession === '' ? null
      : { id: streamSession, live: isLiveSession(ctx, streamSession) },
  })

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
    // treat it as an uncaught exception. The stream is gone either way, so free
    // the window registration here too (a window stuck "alive" would make the next
    // ⧉ wait out its close handshake against a window that is not there).
    closed = true
    settleWindow()
  })
  res.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    settleWindow()
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
 * The dependency-source cache (`<cwd>/.dsh-ris-ide/cache/`) is keyed by a
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
 * @param {string} root - the `.dsh-ris-ide/cache` directory.
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
  await ensureIdeStateDir(cwd)
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

/** The user's decompiler choice: `.dsh-ris-ide/settings.json` first, then `.dsh-ris-ide/config.json`. */
async function readDecompilerConfig(cwd) {
  let settingsText = await readTextIfSmall(resolve(cwd, IDE_SETTINGS_FILENAME))
  if (settingsText === undefined) settingsText = await readTextIfSmall(resolve(cwd, LEGACY_SETTINGS_FILENAME))
  if (settingsText !== undefined) {
    const parsed = parseJsonc(settingsText)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed.decompiler
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.jar === 'string' && value.jar.trim() !== '') {
        return { jar: isAbsolute(value.jar.trim()) ? value.jar.trim() : resolve(cwd, value.jar.trim()), args: normalizeStringArray(value.args) }
      }
    }
  }
  let configText = await readTextIfSmall(resolve(cwd, CONFIG_FILENAME))
  if (configText === undefined) configText = await readTextIfSmall(resolve(cwd, LEGACY_CONFIG_FILENAME))
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
 * decompiler jar into `.dsh-ris-ide/settings.json` (the program config stays
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
      await ensureIdeStateDir(cwd)
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
    await ensureIdeStateDir(cwd)
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


/**
 * Short, stable fingerprint of the machine-wide table.
 *
 * The dialog posts the WHOLE table, so two windows (or two people) editing at once
 * would silently overwrite each other: whoever saves last wins and the other row is
 * gone with no error. The fingerprint travels with the write, so a stale payload is
 * refused (409) instead of applied.
 * @param config - a normalised proxy config.
 * @returns a 12-char hex fingerprint of everything the dialog can change.
 */
export function configRevision(config) {
  const view = {
    socks: [String(config?.socks?.host ?? ''), Number(config?.socks?.port ?? 0)],
    listenPort: Number(config?.listenPort ?? 0),
    rules: (Array.isArray(config?.rules) ? config.rules : []).map((rule) => [
      String(rule.id ?? ''),
      String(rule.program ?? ''),
      String(rule.hosts ?? ''),
      String(rule.ports ?? ''),
      rule.enabled === true,
      rule.shadow === true,
      String(rule.source ?? ''),
    ]),
  }
  return createHash('sha1').update(JSON.stringify(view)).digest('hex').slice(0, 12)
}

/**
 * One stored rule, decorated with what the engine will actually make of it: the
 * parsed host patterns / ports plus the fragments it rejected, so the dialog can
 * flag a typo instead of silently dropping a destination.
 * @param rule - a rule from the normalised config.
 * @returns the rule plus `hostsParsed|hostsInvalid|portsParsed|portsInvalid`.
 */
function decorateProxyRule(rule) {
  const hosts = parseHostSpec(rule.hosts)
  const ports = parsePortSpec(rule.ports)
  // A shadow is a loopback LISTENER, so it needs ports it can actually bind: `*`
  // parses to port 0 ("any port"), which must not make a rule sweepable here.
  const bindable = ports.ports.filter((port) => port > 0)
  const shadowable = hosts.patterns.length > 0 && hosts.patterns.every((pattern) => /^\d{1,3}(\.\d{1,3}){3}$/.test(pattern)) && bindable.length > 0
  const socksCapable = isSocksCapableProgram(rule.program)
  const verdict = ruleEffectiveness(rule)
  return Object.assign({}, rule, {
    hostsParsed: hosts.patterns,
    hostsInvalid: hosts.invalid,
    portsParsed: ports.ports,
    portsInvalid: ports.invalid,
    // What the rule can do is NOT the same for both mechanisms: only a literal
    // IPv4 destination can be pre-bound on a loopback port, and a wildcard can
    // only be matched per connection (the CONNECT proxy).
    shadowable,
    // Which mechanism this program actually needs — the dialog shows it and the
    // engine defaults the mapping flag from it (SOCKS-aware programs need none,
    // everything else can only reach the tunnel through a mapped port).
    socksCapable,
    autoShadow: shadowable && !socksCapable,
    // A rule applies only when enabled AND program/IP/port are all explicit
    // (`*` spells "everything"); the dialog marks the others instead of letting a
    // half-written row look active.
    effective: verdict.effective,
    ineffectiveReason: verdict.reason,
    // The rule table is machine-wide (ProxyBridge hooks the kernel and matches
    // processes), so a row's workspace is provenance only: the dialog shows it
    // as「来源」 and never treats it as a boundary.
    origin: rule.workspace === '' ? '' : basename(rule.workspace),
  })
}

/** Companion-plugin hints: `dsh-ris-yds` assists YonBIP/YMS development (local
 *  runtime, intranet access, development config). Only the capabilities are
 *  named here — never its internals, and never the tools it happens to patch.
 *  We only RECOMMEND it when the workspace really looks like a YMS project: the
 *  two plugins stay usable standalone, so this must never turn into a
 *  requirement (and it must never guess on a plain Java/Vue repo). */
function detectCompanionPlugin(cwd) {
  const evidence = []
  try {
    if (existsSync(join(cwd, 'yms-home'))) evidence.push('yms-home/')
    if (existsSync(join(cwd, '.dsh-ris-yds'))) evidence.push('.dsh-ris-yds/')
    if (evidence.length === 0) {
      const settings = join(cwd, '.vscode', 'settings.json')
      if (existsSync(settings) && readFileSync(settings, 'utf8').includes('"yds.')) {
        evidence.push('.vscode/settings.json (yds.*)')
      }
    }
  } catch {
    // Detection is best effort: an unreadable workspace simply gets no hint.
  }
  if (evidence.length === 0) return null
  return {
    plugin: 'dsh-ris-yds',
    detected: evidence.join(', '),
    hint: '检测到 YonBIP/YMS 工程：dsh-ris-yds 提供本地运行 YMS、访问内网资源、准备开发配置等辅助开发能力（可选，不装不影响本插件）。',
  }
}

/**
 * The whole proxy state the dialog needs, in ONE round trip: rules (decorated),
 * upstream address, engine state, and the scoped git entry it would write.
 * @param cwd - workspace directory.
 * @param gitHost - optional host to narrow the git entry to.
 * @returns a JSON-safe view.
 */
async function proxyView(cwd, gitHost) {
  const status = await proxyStatus(cwd)
  const allow = allowList(status.config)
  const git = gitProxyPlan(status.config, { host: gitHost })
  const watcher = janitorStatus()
  // An engine adopted from a PREVIOUS dsh process (see adoptLeftoverEngine): the
  // dialog shows a takeover banner with a one-click stop instead of pretending this
  // session started it. The flag is dropped as soon as that engine is gone.
  const inherited = inheritedEngine !== null && inheritedEngine.pid === status.pid ? inheritedEngine : null
  return {
    ok: true,
    side: engineSide(),
    // The dialog sends this back with its save, so a table edited in another window
    // is refused instead of silently overwritten.
    revision: configRevision(status.config),
    // ONE engine and ONE config per machine: the path is not workspace-derived.
    configPath: proxyConfigPath(),
    home: proxyHomeDir(),
    shared: true,
    workspace: cwd,
    socks: status.config.socks,
    listenPort: status.config.listenPort,
    rules: await proxyRulesView(cwd, status.config),
    running: status.running,
    pid: status.pid,
    listen: status.listen,
    logPath: status.logPath,
    socksUrl: status.socksUrl,
    allow,
    git,
    // ProxyBridge is the PRIMARY path (kernel hook, matches by process name, so
    // it covers programs we never launched); the engine's loopback mappings and
    // the spawn-time injection remain as the fallback when it is not running.
    redirector: Object.assign(redirectorStatusCached(), {
      // What the CLI would be told to do, so the dialog can show the exact
      // command instead of asking the user to assemble one.
      rules: buildProfile(status.config).rules.length,
    }),
    // Where the daemon maintenance page lives (null when daemonMode is off). The
    // header and console "IDE" buttons open that page instead of the window: it
    // embeds the IDE and can switch workspace, so one tab covers them all.
    risd: risdBridge !== null && risdBridge.state !== null
      ? { available: true, url: risdBridge.state.url, port: risdBridge.state.port, apiVersion: risdBridge.state.apiVersion }
      : { available: false },
    // Watchdog state: it is what removes the layers if dsh itself is killed.
    janitor: watcher,
    // Who owns the child services right now (0 = no watcher state at all).
    owner: watcher.owner,
    // Takeover of a leftover engine (pid + the dsh that started it, 0 = unknown).
    inherited: inherited !== null,
    inheritedPid: inherited === null ? 0 : inherited.pid,
    inheritedFrom: inherited === null ? 0 : inherited.owner,
    inheritedSince: inherited === null ? '' : inherited.detectedAt,
  }
}

/**
 * The rule rows the dialog renders: every stored rule (whoever wrote it), minus
 * the loopback mapping rows dsh-ris-yds keeps as a fallback — those are an
 * implementation detail of "no system-level interception", not something the
 * user configures, so they never reach the dialog (they stay in the file, which
 * is what the engine and the redirector profile are built from).
 *
 * Templates are appended only where the machine has no row for that program
 * yet, so a fresh workspace still shows the starter rows. `template: true` marks
 * a starter row the user has not saved: the dialog shows it, but must NOT write
 * it back (that would turn a suggestion into a stored rule living forever in the
 * shared table).
 * @param cwd - workspace the rows are rendered for.
 * @param config - the normalised machine table.
 * @returns decorated rows, stored first then templates.
 */
async function proxyRulesView(cwd, config) {
  const own = config.rules.filter((rule) => !(rule.source === 'yds' && rule.shadow === true))
  const covered = new Set(own.map((rule) => programKey(rule.program)))
  const templates = autoRules(cwd).filter((rule) => !covered.has(programKey(rule.program)))
  const stored = await Promise.all(own.map(async (rule) => {
    const decorated = decorateProxyRule(rule)
    // A rule can start its program itself (that is the only way to inject the
    // tunnel into something we did not launch), so the row shows whether it is
    // up and where its log is.
    const service = await readService(proxyRunLogPath(cwd, rule.id)).catch(() => undefined)
    return Object.assign(decorated, {
      runnable: decorated.socksCapable && String(rule.program ?? '').trim() !== '',
      runLogPath: proxyRunLogPath(cwd, rule.id),
      run: service === undefined ? null : { pid: service.pid, alive: service.alive },
    })
  }))
  return stored.concat(templates.map((rule) => Object.assign(decorateProxyRule(rule), { template: true })))
}

/**
 * Phase 1a bridge to risd: the daemon owns the read-only view, the plugin keeps
 * the parts that need a live process (per-rule run state, the inherited-engine
 * banner, the bridge status it still starts itself).
 *
 * `daemonMode` defaults to `auto` since 1.8.0: the ⧉ button and the tool layer
 * both want the daemon (it owns the engine, the programs and the page), and the
 * daemon was opt-in only while it was being built. `daemonMode=off` (config or
 * `DSH_RISD_MODE=off`) is still the one-word rollback to the pre-1.8 wiring.
 * @type {{mode: 'off'|'auto', state: object|null, leaseId: string|null, pending: Promise<void>|null, warnedAt: number}|null}
 */
let risdBridge = null

function daemonModeEnabled(config) {
  // 1.8.0 defaults to auto (m07355: the IDE entry always lands on risd-ui). Test
  // processes keep the historical off default so plugin suites do not spawn real
  // daemons; an explicit daemonMode/DSH_RISD_MODE still wins over both.
  //
  // Only the documented values switch it on. A typo ('of'), a stringified boolean
  // ('false') or 0 used to enable the daemon silently because the old test was
  // `value !== 'off'` (review E P2-1); unknown values now mean "off".
  const fallback = process.env.NODE_TEST_CONTEXT !== undefined && process.env.DSH_RISD_MODE === undefined ? 'off' : 'auto'
  const value = config?.daemonMode ?? process.env.DSH_RISD_MODE ?? fallback
  if (value === true || value === 'auto' || value === 'on') return true
  if (value === '') return true
  return false
}

/**
 * Circuit breaker for automatic daemon starts.
 *
 * Every auto-start path (the ⧉ button, tool healing) must give up after a few
 * failures: a daemon that cannot boot (bad home permissions, port stolen by
 * something that never answers, broken Node install) would otherwise be spawned
 * again on every click/tool call, each costing the full 5 s health window. After
 * three failures inside two minutes we stop for five minutes and tell the user
 * what to run by hand.
 */
const RISD_HEAL_WINDOW_MS = 2 * 60_000
const RISD_HEAL_MAX_ATTEMPTS = 3
const RISD_HEAL_COOLDOWN_MS = 5 * 60_000
let risdHeal = { attempts: 0, since: 0, blockedUntil: 0, lastError: '' }

/** @returns true while automatic starts are paused. */
export function risdHealBlocked(now = Date.now()) {
  return now < risdHeal.blockedUntil
}

/** @returns the message shown instead of starting the daemon, or ''. */
export function risdHealReason(now = Date.now()) {
  if (!risdHealBlocked(now)) return ''
  const seconds = Math.max(1, Math.ceil((risdHeal.blockedUntil - now) / 1000))
  return `连续 ${RISD_HEAL_MAX_ATTEMPTS} 次自动启动 risd 失败（${risdHeal.lastError || 'unknown'}），${seconds}s 内不再自动唤起；请运行 risd serve 查看原因`
}

/** Count one failed start; the third inside the window trips the breaker. */
export function noteRisdHealFailure(error, now = Date.now()) {
  if (now - risdHeal.since > RISD_HEAL_WINDOW_MS) { risdHeal.attempts = 0; risdHeal.since = now }
  if (risdHeal.attempts === 0) risdHeal.since = now
  risdHeal.attempts += 1
  risdHeal.lastError = String(error ?? '').slice(0, 200)
  if (risdHeal.attempts >= RISD_HEAL_MAX_ATTEMPTS) {
    risdHeal.blockedUntil = now + RISD_HEAL_COOLDOWN_MS
    risdHeal.attempts = 0
    risdHeal.since = 0
  }
}

/** A successful start clears the breaker. */
export function noteRisdHealSuccess() {
  risdHeal = { attempts: 0, since: 0, blockedUntil: 0, lastError: '' }
}

function startRisdBridge(ctx, cwd) {
  risdBridge = { mode: 'auto', state: null, leaseId: null, pending: null, warnedAt: 0 }
  const bridge = risdBridge
  bridge.pending = (async () => {
    const ensured = await ensureRisd({ home: proxyHomeDir() })
    if (ensured.ok !== true) {
      try {
        ctx.logger?.warn?.(`[dsh-ris-ide] risd 不可用（${ensured.reason ?? 'unknown'}），代理视图回退到插件本地`)
      } catch { /* logging is best effort */ }
      return
    }
    await attachBridgeState(ensured.state, cwd)
    // No extra call for 「代理引擎跟随 dsh」: the lease acquired above IS the start
    // signal (the daemon starts the engine when the first lease arrives and tears it
    // down when the last one leaves — one signal, one policy, m13950).
  })().finally(() => {
    if (bridge === risdBridge) bridge.pending = null
  })
}

/**
 * Point the bridge at a live daemon and make sure this window holds a lease.
 *
 * Keeping the same function for start / heal / ensure matters: a lease acquired
 * once survives a single failed request, and a window that keeps its lease is what
 * `followDsh` uses to decide that dsh is still open (review C-P1-1).
 * @param state - daemon state from `ensureRisd()`.
 * @param cwd - workspace for the lease (null before the first session is known).
 * @returns the same state, for chaining.
 */
function attachBridgeState(state, cwd = null) {
  const bridge = risdBridge
  if (bridge === null || bridge.mode !== 'auto') return state
  bridge.state = state
  bridge.degraded = false
  bridge.lastProbeAt = Date.now()
  // The daemon owns the engine now: the local fallback hook (armed when the engine
  // was started behind the daemon's back) must not stop it on dsh exit (review
  // C3-P2-7).
  disarmLocalProxyCleanup()
  if (bridge.leaseId === null) {
    void acquireLease(state, { ownerPid: process.pid, sessionId: null, cwd: cwd ?? null })
      .then((lease) => {
        if (lease.ok === true && lease.body?.lease !== undefined) bridge.leaseId = lease.body.lease.id
      })
      .catch(() => { /* the next attach retries */ })
  }
  return state
}

/**
 * The daemon state a writer should use, or null when this process should write
 * locally.
 *
 * A single failed request used to null the pointer permanently and let the plugin
 * write the machine-wide table behind the daemon's back (review C-P0-2). Now a
 * missing pointer is a *degraded* state: retry the handshake (throttled), and let
 * the caller refuse to write locally while the daemon may still be alive.
 * @param cwd - workspace for the lease.
 * @returns live daemon state, or null.
 */
async function risdBridgeState(cwd = null) {
  const bridge = risdBridge
  if (bridge === null || bridge.mode !== 'auto') return null
  if (bridge.pending !== null) {
    await Promise.race([bridge.pending, new Promise((resolve) => { const timer = setTimeout(resolve, 3000); timer.unref?.() })])
  }
  if (bridge.state !== null) return bridge.state
  if (Date.now() - (bridge.lastProbeAt ?? 0) < 5000) return null
  bridge.lastProbeAt = Date.now()
  const ensured = await ensureRisd({ home: proxyHomeDir() }).catch(() => ({ ok: false, reason: 'spawn failed' }))
  if (ensured.ok !== true) {
    bridge.degraded = true
    return null
  }
  return attachBridgeState(ensured.state, cwd)
}

function stopRisdBridge() {
  const bridge = risdBridge
  if (bridge === null) return
  // Releasing the lease is all this process owns: the daemon decides what to do
  // with the engine, and in phase 1a the engine is still ours, so nothing else
  // may be stopped from here.
  if (bridge.state !== null && bridge.leaseId !== null) void releaseLease(bridge.state, bridge.leaseId)
  bridge.state = null
  bridge.leaseId = null
  bridge.pending = null
  risdBridge = null
}

/**
 * Ask the daemon for the read-only view and dress it up as the plugin's own.
 * @returns the decorated view, or null when the daemon is off/unreachable (the
 *   caller then falls back to the local `proxyView`).
 */
async function risdForwardedView(cwd, gitHost) {
  if (risdBridge === null || risdBridge.mode !== 'auto') return null
  const bridge = risdBridge
  if (bridge.state === null) {
    if (bridge.pending !== null) {
      await Promise.race([bridge.pending, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    if (bridge.state === null) return null
  }
  const base = await getProxyView(bridge.state, cwd)
  if (base === null || base.ok !== true) {
    // One failed read does not prove the daemon is gone: mark the bridge degraded,
    // KEEP the lease (a lost lease makes followDsh tear down tunnels that other
    // windows still use) and let the next call re-handshake (review C-P0-2).
    bridge.state = null
    bridge.degraded = true
    return null
  }
  return mergeRisdView(base, cwd, gitHost)
}

async function mergeRisdView(base, cwd, gitHost) {
  const config = readProxyConfig(cwd)
  const watcher = janitorStatus()
  const inherited = inheritedEngine !== null && inheritedEngine.pid === base.pid ? inheritedEngine : null
  const redirectorRules = Number.isInteger(base.redirector?.rules) ? base.redirector.rules : buildProfile(config).rules.length
  return Object.assign({}, base, {
    risd: risdBridge !== null && risdBridge.state !== null
      ? { available: true, url: risdBridge.state.url, port: risdBridge.state.port, apiVersion: risdBridge.state.apiVersion }
      : { available: true, url: base.url ?? '', port: base.port ?? 0, apiVersion: base.apiVersion ?? 0 },
    rules: await proxyRulesView(cwd, config),
    git: gitProxyPlan(config, { host: gitHost }),
    redirector: Object.assign(redirectorStatusCached(), { rules: redirectorRules }),
    janitor: base.janitor ?? watcher,
    owner: base.owner ?? watcher.owner,
    inherited: inherited !== null,
    inheritedPid: inherited === null ? 0 : inherited.pid,
    inheritedFrom: inherited === null ? 0 : inherited.owner,
    inheritedSince: inherited === null ? '' : inherited.detectedAt,
  })
}

/**
 * Where a rule's 启动/停止 button keeps its log.
 *
 * A separate directory, not `.dsh-ris-ide/logs`: those logs are scanned as panel
 * rows, and a program we started only to proxy it should not appear as a third
 * copy of itself in the program list.
 * @param cwd - workspace the rule belongs to.
 * @param ruleId - the rule's id (already validated as a plain string).
 * @returns absolute log path.
 */
function proxyRunLogPath(cwd, ruleId) {
  const slug = String(ruleId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  return join(cwd, '.dsh-ris-ide', 'proxy-run', `${slug}.log`)
}

/**
 * Build the program row `startProgram` needs, out of one rule.
 *
 * The row is synthesised rather than scanned: the dialog's rule is the source of
 * truth (it names an absolute executable or a bare program on PATH), and the
 * start path only has to know how to run it under the wrapper.
 * @param cwd - workspace (log location + default working directory).
 * @param rule - one decorated proxy rule.
 * @returns the program row.
 */
function proxyRunProgram(cwd, rule) {
  const logPath = proxyRunLogPath(cwd, rule.id)
  const command = String(rule.program ?? '').trim()
  return {
    id: `proxy-run:${rule.id}`,
    name: programKey(command) || 'program',
    dir: cwd,
    // Absolute paths and bare names both work; quote so a path with spaces stays
    // one argument for the shell wrapper.
    startCommand: quoteShell(command),
    logName: basename(logPath, '.log'),
    logPath,
    stopGraceMs: 5000,
    running: null,
    kind: 'custom',
  }
}

/** `GET` reads the proxy state, `POST` validates + saves the form. */
/**
 * Start the daemon if it is not running and report where its page lives.
 *
 * Loopback-only, like every other proxy route: the page it returns is a LAN-less
 * 127.0.0.1 URL, and spawning a machine-level process is not something a remote
 * request may trigger.
 */
async function serveRisdEnsure(ctx, req, res, options) {
  if (!isLoopbackRequest(req)) {
    throw new TailError('forbidden', 'this route answers loopback requests only', 403)
  }
  // daemonMode=off means the plugin keeps ownership of the engine, the heartbeat
  // and the janitor. A spawned daemon unconditionally writes its heartbeat and arms
  // its own janitor, and the janitor REPLACES a watcher owned by a different pid —
  // so starting one here silently removed the plugin's crash cleanup (dsh crash left
  // the engine/bridge/git behind) and a daemon crash tore down the engine the plugin
  // was still using (review C2-P0-1). Off mode therefore keeps the pre-1.8
  // behaviour: answer "unavailable" and let the caller fall back to the standalone
  // window. Users who want the maintenance page opt into daemonMode=auto.
  if (options.daemonMode !== 'auto') {
    writeJson(res, 200, {
      ok: false,
      risd: { available: false, reason: 'daemonMode=off：IDE 请用独立窗口（把 daemonMode 设为 auto 可启用维护页）' },
    })
    return
  }
  const paused = risdHealReason()
  if (paused !== '') {
    writeJson(res, 200, { ok: false, risd: { available: false, reason: paused } })
    return
  }
  const ensured = await ensureRisd({ home: proxyHomeDir() })
  if (ensured.ok !== true) {
    // A version mismatch is not a crash: re-spawning the same old daemon cannot
    // fix it, so it must not spend breaker budget (review C-P2-1).
    const mismatch = ensured.reason === 'api-mismatch'
    if (!mismatch) noteRisdHealFailure(ensured.reason ?? 'unavailable')
    writeJson(res, 200, {
      ok: false,
      risd: { available: false, reason: mismatch ? 'risd 版本与插件不一致：请重启 dsh 以启动匹配版本' : (ensured.reason ?? 'unavailable') },
    })
    return
  }
  noteRisdHealSuccess()
  const state = ensured.state
  attachBridgeState(state, null)
  writeJson(res, 200, {
    ok: true,
    spawned: ensured.spawned === true,
    risd: {
      available: true,
      url: `http://127.0.0.1:${state.port}`,
      port: state.port,
      apiVersion: state.apiVersion,
    },
  })
}

async function serveProxy(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = req.method ?? 'GET'
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
      const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
      const gitHostBody = typeof body.gitHost === 'string' ? body.gitHost : undefined
      // Phase 1b P4: when risd owns the proxy, it is also the only writer of the
      // machine-wide table. Forward the write and let the daemon's CAS reject a
      // stale form; the view returned to the dialog is still built locally (row
      // decoration needs this process's program list).
      const writeState = await risdBridgeState(cwd)
      if (writeState === null && risdBridge !== null && risdBridge.mode === 'auto') {
        // The daemon may still be alive: writing the machine-wide table here would
        // race it (split-brain rules/git). Only a confirmed-absent daemon falls back.
        const probe = await probeRisd({ home: proxyHomeDir() }).catch(() => ({ usable: false, reason: 'unreachable' }))
        if (probe.usable === true) {
          throw new TailError('bad-gateway', 'risd 正在运行但连接未就绪，本次保存未写入：请稍后重试，或在概览停掉 daemon 后重试', 503)
        }
      }
      if (writeState !== null) {
        const call = await saveProxy(writeState, { cwd, config: body.config, revision: body.revision, gitHost: gitHostBody })
        if (call.status === 409) {
          // Two different 409s reach this branch: a stale table (conflict, with
          // `conflict:true` and a revision) and a version mismatch between plugin
          // and daemon (`code:'api-mismatch'`, no conflict flag). Only the first is
          // something the dialog can recover from by reloading; the second needs a
          // dsh restart, so it keeps design §7.1's 503 instead of being reported as
          // "someone else changed the rules" (review C-P2-1).
          if (call.body !== null && call.body.code === 'api-mismatch') {
            throw new TailError('risd-upgrade-required', `${call.body.message ?? '插件与 risd 版本不一致'}：请重启 dsh，让插件启动匹配版本的 risd`, 503)
          }
          const view = await proxyView(cwd, gitHostBody)
          writeJson(res, 409, Object.assign({}, call.body, { view }))
          return
        }
        if (call.ok !== true) {
          throw new TailError('bad-gateway', `risd 写入失败：${call.body?.message ?? call.error ?? `HTTP ${call.status}`}`, 502)
        }
        const view = await proxyView(cwd, gitHostBody)
        writeJson(res, 200, Object.assign({}, view, { reloadNote: call.body?.reloadNote ?? '' }))
        return
      }
      // The dialog shows the WHOLE machine-wide table, so its payload is
      // authoritative for the rows a human owns (source user/auto): a row the
      // payload no longer carries was deleted. Driven rows (source yds) are owned
      // by the bridge, which upserts them by id and retires them itself.
      const incoming = body.config !== null && typeof body.config === 'object' ? body.config : {}
      const stored = readProxyConfig(cwd)
      // Optimistic concurrency: the payload names the table it was rendered from.
      // An empty/absent revision is accepted (the CLI writes without one), but a
      // MISMATCH means someone else changed the table in between — refuse and hand
      // the current view back, so the dialog reloads instead of dropping their rows.
      const baseRevision = typeof body.revision === 'string' ? body.revision.trim() : ''
      const currentRevision = configRevision(stored)
      if (baseRevision !== '' && baseRevision !== currentRevision) {
        const view = await proxyView(cwd)
        writeJson(res, 409, {
          ok: false,
          conflict: true,
          code: 'conflict',
          message: '规则表已在别处被修改，本次改动未写入',
          revision: currentRevision,
          view,
        })
        return
      }
      const rows = Array.isArray(incoming.rules)
        ? incoming.rules
          .filter((rule) => rule !== null && typeof rule === 'object')
          .map((rule) => Object.assign({}, rule, { workspace: rule.workspace ?? cwd }))
        : []
      const keptIds = new Set(rows.map((rule) => String(rule.id ?? '')))
      const retired = stored.rules
        .filter((rule) => rule.source !== 'yds' && !keptIds.has(rule.id))
        .map((rule) => rule.id)
      const written = mergeConfigs(
        Object.assign({}, stored, { rules: stored.rules.filter((rule) => !retired.includes(rule.id)) }),
        { socks: incoming.socks, listenPort: incoming.listenPort, rules: rows, workspace: cwd },
      )
      writeProxyConfig(cwd, written)
      // Clean up what the PREVIOUS table applied before the new one takes effect:
      // the bridge reload below restarts ProxyBridge, but the scoped git entry is
      // not part of that profile and would otherwise stay on the old host.
      const git = await reconcileGitProxy(cwd)
      // Apply without a manual restart: our own engine watches proxy.json and
      // swaps its allow-list/listeners in place; ProxyBridge reads its profile only
      // at start, so the elevated watchdog restarts just that process (no UAC, the
      // dialog never has to ask the user to stop/start).
      const bridge = redirectorStatusCached()
      let reloadNote = ''
      // Revoking is part of switching: ProxyBridge parses its profile only at start,
      // so a failed reload would leave the OLD rules intercepting while the dialog
      // reports a successful save. Stop the bridge instead of leaving stale rules.
      const revoke = async (reason) => {
        const stopped = await stopRedirector()
        return `${reason}；${stopped.stopped === true
          ? '已停止系统层拦截，避免继续按旧规则代理'
          : `未能停止系统层拦截（${stopped.reason ?? '未知原因'}），旧规则可能仍在生效`}`
      }
      if (bridge.running === true) {
        // ONE call does the whole job: ProxyBridge reads its profile only at start,
        // so a reload that does not rewrite the profile would relaunch the OLD rules
        // and still report success (that was B3). The helper writes first, then
        // restarts, and only claims a side was reloaded when it saw the new pid.
        try {
          // Which sides exist per platform is `reloadRedirectorsWithProfile`'s own
          // default; spelling it out here duplicated that knowledge and would drift
          // when the default changes (review C3-P2-8).
          const reload = await reloadRedirectorsWithProfile(cwd)
          const done = Array.isArray(reload.reloaded) ? reload.reloaded : []
          const skipped = Array.isArray(reload.skipped) ? reload.skipped : []
          reloadNote = done.length > 0
            ? '系统层拦截已按新规则自动重启'
            : await revoke(`系统层拦截未重载：${skipped.map((item) => `${item.side}:${item.reason}`).join('；') || reload.reason || '未知原因'}`)
        } catch (error) {
          reloadNote = await revoke(`系统层拦截未重载：${error?.message ?? error}`)
        }
      }
      const view = await proxyView(cwd, typeof body.gitHost === 'string' ? body.gitHost : undefined)
      writeJson(res, 200, Object.assign({}, view, { reloadNote, git }))
      return
    }
    if (method !== 'GET') throw new TailError('method-not-allowed', 'GET or POST', 405)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const gitHost = url.searchParams.get('gitHost') ?? undefined
    // Phase 1a: when risd is opted in and reachable the VIEW comes from the
    // daemon (single source for config/revision/engine status); the plugin only
    // decorates it. Any daemon problem falls back to the local view, so the
    // dialog never breaks because an optional process is down.
    writeJson(res, 200, (await risdForwardedView(cwd, gitHost)) ?? await proxyView(cwd, gitHost))
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Where the git proxy we wrote is remembered.
 *
 * `stop` (and the exit hook) must undo EXACTLY what `start` wrote: the key is
 * host-scoped when the repo has an origin, global otherwise, and clearing the
 * wrong one would either leave a dangling proxy or stomp the user's own setting.
 * @returns {string} absolute path of the state file.
 */
function gitProxyStatePath() {
  return join(proxyHomeDir(), 'git-proxy.json')
}

/** @returns {{key: string, host: string}} the entry start wrote, or empty strings. */
function readGitProxyState() {
  try {
    const raw = JSON.parse(readFileSync(gitProxyStatePath(), 'utf8'))
    return {
      key: typeof raw?.key === 'string' ? raw.key : '',
      host: typeof raw?.host === 'string' ? raw.host : '',
    }
  } catch {
    return { key: '', host: '' }
  }
}

/**
 * Remember (or forget) the git proxy entry.
 * @param {{key: string, host: string}|null} state - null clears the file.
 */
function writeGitProxyState(state) {
  const path = gitProxyStatePath()
  if (state === null) {
    try { rmSync(path, { force: true }) } catch { /* nothing to clear */ }
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Host of the workspace's `origin` remote, so the proxy entry is scoped to one
 * server instead of being a machine-wide `http.proxy`.
 * @param {string} cwd - workspace root.
 * @returns {string} hostname, or '' when there is no readable remote.
 */
function gitOriginHost(cwd) {
  const out = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8', windowsHide: true, timeout: 4000,
  })
  if (out.status !== 0 || typeof out.stdout !== 'string') return ''
  try { return new URL(out.stdout.trim()).host } catch { return '' }
}

/**
 * Host of the enabled `git` rule, if the table declares one.
 *
 * This is the user's own statement of "git goes to this server" (yds writes it
 * from `git.url`), so it outranks the workspace's `origin` — a mirror or a
 * proxy-fronted clone must not decide where git may tunnel to.
 * @param {string} cwd - workspace root (only used to find the shared config).
 * @returns {string} the first host pattern, or ''.
 */
function gitRuleHost(cwd) {
  const rules = readProxyConfig(cwd).rules
  for (const rule of rules) {
    if (rule.enabled !== true) continue
    if (programKey(rule.program) !== 'git') continue
    const first = String(rule.hosts ?? '').split(',')[0].trim()
    if (first !== '') return first
  }
  return ''
}

/**
 * Write or clear the git proxy that belongs to the running tunnel.
 *
 * git reads this from its own config, so a plain `git` command in any terminal —
 * and the dsh-git plugin — goes through the tunnel without a per-command flag.
 * @param {{cwd: string, host?: string, enabled: boolean}} options - target and direction.
 * @returns {Promise<{ok: boolean, key?: string, error?: string}>} outcome.
 */
async function syncGitProxy({ cwd, host, enabled }) {
  const previous = readGitProxyState()
  if (enabled !== true) {
    const key = previous.key
    if (key === '') return { ok: true, key: '' }
    const cleared = await runGitConfig(['--unset', key])
    const windowsCleared = runWindowsGitConfig(['--unset', key])
    writeGitProxyState(null)
    return { ok: true, key, cleared: cleared.ok === true, windowsCleared: windowsCleared.ok === true }
  }
  // Precedence: an explicit host, then the table's own git rule, then whatever we
  // wrote last time, and only then the repo's origin (a mirror is not a target).
  const target = (typeof host === 'string' && host !== '')
    ? host
    : (gitRuleHost(cwd) || (previous.host !== '' ? previous.host : gitOriginHost(cwd)))
  if (target === '') return { ok: false, error: '没有 git 规则也没有 origin，无法确定代理作用域', key: '' }
  // A stale entry for another host would keep a dead proxy alive for that remote.
  if (previous.key !== '' && previous.host !== '' && previous.host !== target) {
    await runGitConfig(['--unset', previous.key])
    writeGitProxyState(null)
  }
  const plan = gitProxyPlan(readProxyConfig(cwd), { host: target, enabled: true })
  if (plan.value === '') return { ok: false, error: '没有可用的 SOCKS 地址', key: plan.key }
  const written = await runGitConfig([plan.key, plan.value])
  if (written.ok !== true) return { ok: false, error: written.error, key: plan.key }
  // The Windows-side git reads its own config file AND cannot resolve the internal
  // host (its DNS knows nothing about gitlab.hanslaser.com), so socks5h has to be in
  // that file too — otherwise YonCode's git fails before any interception can happen.
  const windows = runWindowsGitConfig([plan.key, plan.value])
  writeGitProxyState({ key: plan.key, host: target, windows: windows.ok === true })
  return { ok: true, key: plan.key, host: target, windows }
}

/**
 * Re-align the scoped git entry with the table that was just saved.
 *
 * Saving rules used to write `proxy.json` and reload the bridge only; the
 * `git config --global` entry of the PREVIOUS host survived, so removing or
 * repointing the git rule left every terminal pointed at a dead tunnel. A
 * surviving git rule wins (syncGitProxy unsets the old key first, and only when
 * the recorded value is still ours); with no git rule left, ours is cleared.
 * @param {string} cwd - workspace root.
 * @returns {Promise<object>} outcome of the sync/clear.
 */
async function reconcileGitProxy(cwd) {
  const host = gitRuleHost(cwd)
  if (host === '') return syncGitProxy({ cwd, enabled: false })
  return syncGitProxy({ cwd, host, enabled: true })
}

/** Synchronous git-proxy undo for the exit hook, which cannot await anything. */
function clearGitProxySync() {
  const { key } = readGitProxyState()
  if (key === '') return
  try { spawnSync('git', ['config', '--global', '--unset', key], { windowsHide: true, timeout: 4000 }) } catch { /* best effort */ }
  // Same undo on the Windows side: leaving a dead socks address there breaks git for
  // every Windows tool until someone notices.
  try { runWindowsGitConfig(['--unset', key]) } catch { /* best effort */ }
  writeGitProxyState(null)
}

/** Run one `git config --global` mutation; a missing git is a reported no-op. */
function runGitConfig(args) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['config', '--global', ...args], { windowsHide: true })
    let stderr = ''
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolvePromise(result) } }
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
    child.on('error', (error) => done({ ok: false, error: isMissingExecutable(error) ? '本机没有安装 git' : String(error?.message ?? error) }))
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git exited with ${code}` }))
  })
}

/** Start/stop the engine and write/clear the scoped git proxy entry. */
async function serveProxyAction(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw new TailError('bad-request', 'sessionId is required', 400)
    const cwd = resolveCwd(ctx, sessionId, typeof body.cwd === 'string' ? body.cwd : undefined)
    const action = typeof body.action === 'string' ? body.action : 'status'
    const gitHost = typeof body.gitHost === 'string' ? body.gitHost : undefined
    // The maintenance page is the only elevation entry point; an auto-start (save
    // rules / dsh start) calls the same route without this flag (m13910).
    const interactive = body.interactive === true
    // Engine + bridge + git are the daemon's once it owns the proxy; the per-rule
    // 启动/停止 buttons stay here because they launch a child of THIS process (the
    // injection only works on a child we spawn ourselves).
    const daemonActions = new Set(['start', 'stop', 'git-on', 'git-off', 'redirector-sync', 'redirector-start', 'redirector-stop', 'redirector-restart', 'status'])
    const actionState = await risdBridgeState(cwd)
    if (actionState === null && risdBridge !== null && risdBridge.mode === 'auto' && daemonActions.has(action)) {
      const probe = await probeRisd({ home: proxyHomeDir() }).catch(() => ({ usable: false, reason: 'unreachable' }))
      if (probe.usable === true) {
        throw new TailError('bad-gateway', `risd 正在运行但连接未就绪，${action} 未执行：请稍后重试`, 503)
      }
    }
    if (actionState !== null && daemonActions.has(action)) {
      const call = await proxyAction(actionState, { cwd, action, gitHost, interactive })
      if (call.ok !== true) {
        // No answer at all (network error / timeout) is not a business failure: the
        // action did not run, and the panel has no second entry point for the engine
        // any more. Answer 503 + "retry", and re-arm the handshake so the retry can
        // succeed instead of hitting the same dead socket (review C-P2-8).
        if (call.status === 0 || call.body === null) {
          void risdBridgeState(cwd).catch(() => {})
          throw new TailError('risd-unavailable', `risd 不可用（${call.error ?? 'no answer'}），${action} 未执行：请稍后重试，页面会在下一次重新唤起 daemon`, 503)
        }
        throw new TailError('bad-gateway', `risd 操作失败：${call.body?.message ?? call.error ?? `HTTP ${call.status}`}`, 502)
      }
      if (action === 'start' || action === 'stop') inheritedEngine = null
      writeJson(res, 200, Object.assign({ ok: true, action, result: call.body?.result }, await proxyView(cwd, gitHost)))
      return
    }
    let result
    if (action === 'start') {
      // One button, three layers: engine (spawned children) + system-level
      // interception (everything else, UAC/root is the expected prompt) + the git
      // config entry (so a plain `git` and dsh-git inherit the tunnel). Stopping
      // undoes all three, and so does the host exit hook.
      //
      // Reached only when the daemon is unavailable (otherwise the branch above
      // answers): this engine is ours, so install the exit hook that auto mode would
      // otherwise rely on the daemon to provide (review C2-P1-3).
      armLocalProxyCleanup()
      const engine = await startProxy(cwd)
      const redirector = await startRedirectors({ interactive })
      const git = await syncGitProxy({ cwd, host: gitHost, enabled: true })
      if (engine.ok === true) inheritedEngine = null
      result = Object.assign({}, engine, { redirector, git })
    } else if (action === 'stop') {
      const git = await syncGitProxy({ cwd, host: gitHost, enabled: false })
      const redirector = await stopRedirector()
      const stopped = await stopProxy(cwd)
      disarmLocalProxyCleanup()
      // The banner must not come back once the adopted engine is really gone.
      if (proxyPid() === null) inheritedEngine = null
      result = Object.assign({}, stopped, { redirector, git })
    } else if (action === 'git-on' || action === 'git-off') {
      const plan = gitProxyPlan(readProxyConfig(cwd), { host: gitHost, enabled: action === 'git-on' })
      result = action === 'git-on'
        ? Object.assign({ key: plan.key, value: plan.value }, await runGitConfig([plan.key, plan.value]))
        : Object.assign({ key: plan.key }, await runGitConfig(['--unset', plan.key]))
    } else if (action === 'run' || action === 'run-stop') {
      // Start/stop the rule's program OURSELVES: injection only works on a child
      // process, so "配置好规则 → 点启动" is the only way to proxy a program that
      // the user would otherwise launch by hand.
      const ruleId = typeof body.ruleId === 'string' ? body.ruleId : ''
      if (ruleId === '') throw new TailError('bad-request', 'ruleId is required', 400)
      const rule = readProxyConfig(cwd).rules.find((item) => item.id === ruleId)
      if (rule === undefined) throw new TailError('bad-request', `没有规则 ${ruleId}`, 404)
      const program = proxyRunProgram(cwd, rule)
      if (action === 'run-stop') {
        result = await stopLogPath(program.logPath, options?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)
      } else {
        if (rule.enabled !== true) throw new TailError('bad-request', '规则未启用，启动后不会走代理', 400)
        if (String(rule.program ?? '').trim() === '') throw new TailError('bad-request', '规则还没选程序', 400)
        if (!isSocksCapableProgram(rule.program)) throw new TailError('bad-request', `${programKey(rule.program)} 不支持 SOCKS，只能走 127.0.0.1 映射`, 400)
        const started = await startProgram(cwd, dirname(program.logPath), program, options)
        result = { started: started.alreadyRunning !== true, program: started.program?.logPath ?? program.logPath }
      }
    } else if (action === 'redirector-sync') {
      // Export the machine-wide table as a ProxyBridge profile and report the
      // exact command. Starting it needs root/UAC, which a web route cannot ask
      // for, so the command is returned for the user (or an agent with rights).
      result = await syncRedirector(cwd, { start: false })
    } else if (action === 'redirector-start') {
      result = await syncRedirector(cwd, { start: true })
    } else if (action === 'redirector-stop') {
      result = await stopRedirector()
    } else if (action === 'redirector-restart') {
      // Same contract as the daemon: stop, let the profile write settle, start.
      const stopped = await stopRedirector()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const started = await startRedirectors()
      result = {
        stopped,
        started: started.started ?? [],
        skipped: started.skipped ?? [],
        running: started.running === true,
      }
    } else if (action !== 'status') {
      throw new TailError('bad-request', `unknown proxy action "${action}"`, 400)
    }
    writeJson(res, 200, Object.assign({ ok: true, action, result }, await proxyView(cwd, gitHost)))
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Programs the rule table offers in its picker.
 *
 * Deliberately SOCKS-aware programs only: a rule other than these cannot be
 * proxied by injection (its only route is a 127.0.0.1 listener, which needs no
 * picker entry), so offering them would promise something we cannot deliver.
 */
const PROXY_PROGRAM_SUGGESTIONS = ['java', 'javaw', 'mvn', 'git', 'node', 'npm', 'curl', 'python', 'python3']

/** Distinct program names of the processes on THIS side of the OS boundary. */
function localProgramNames() {
  const names = new Set()
  if (IS_WINDOWS) return names
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
        const first = commandLine.split('\0')[0]
        if (first !== '') names.add(basename(first))
      } catch { /* the process exited between readdir and read */ }
    }
  } catch { /* no /proc: the suggestions still make the picker usable */ }
  return names
}

/** Program names of the WINDOWS side, via PowerShell (interop may be off). */
function windowsProgramNames() {
  // A cold PowerShell start is 3s here and worse under load: the old 4s budget made
  // the picker silently drop every Windows entry. Cache it and give it room.
  const cached = windowsProgramCache
  if (cached !== null && Date.now() - cached.at < WINDOWS_PROGRAM_TTL_MS) return Promise.resolve(new Set(cached.names))
  if (windowsProgramProbe !== null) return Promise.resolve(new Set(windowsProgramProbe()))
  return new Promise((resolvePromise) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-Process | Select-Object -ExpandProperty ProcessName -Unique'], { windowsHide: true })
    let stdout = ''
    let settled = false
    const done = (names) => { if (!settled) { settled = true; resolvePromise(names) } }
    child.stdout?.on('data', (chunk) => { if (stdout.length < 200000) stdout += chunk.toString('utf8') })
    child.on('error', () => done(new Set()))
    child.on('timeout', () => done(new Set()))
    child.on('close', () => {
      const names = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))
      if (names.size > 0) windowsProgramCache = { at: Date.now(), names: [...names] }
      done(names)
    })
    setTimeout(() => done(new Set()), TIMEOUT_WINDOWS_PROGRAMS_MS).unref?.()
  })
}

/** Last successful Windows process list (the probe is too slow to repeat per open). */
let windowsProgramCache = null

/**
 * Test seam for the Windows process listing.
 *
 * The real probe spawns `powershell.exe` (3-4.5 s on WSL, and it enumerates the
 * developer's actual desktop). Tests that only need *some* names set this instead,
 * so a test run neither waits for PowerShell nor depends on what is running.
 * @type {null | (() => Iterable<string>)}
 */
let windowsProgramProbe = null

/** Install (or clear, with `null`) the Windows program-listing probe used by tests. */
export function setWindowsProgramProbe(probe) {
  windowsProgramProbe = typeof probe === 'function' ? probe : null
  windowsProgramCache = null
}

/** Drop the cached Windows process list (tests, or after a program was installed). */
export function resetWindowsProgramCache() {
  windowsProgramCache = null
}
/** How long a successful Windows process list stays usable. */
const WINDOWS_PROGRAM_TTL_MS = 20000
/** Budget for one PowerShell process listing (cold start alone is ~3s). */
const TIMEOUT_WINDOWS_PROGRAMS_MS = 12000

/** `GET` the program picker's candidates (this side + Windows when reachable). */
/**
 * List one directory for the rules table's 「固定程序」 browser.
 *
 * A rule can point at an executable that is not running yet, so the panel needs
 * a way to pick an absolute path — by hand typing it is error-prone, and the
 * workspace tree only covers one root. Directories come first; files are limited
 * to things that can plausibly be programs (executable bit, or a known suffix),
 * so a build output directory does not bury the java.exe the user came for.
 * @param ctx - host context.
 * @param req - `?path=<dir>`; missing means the platform temp/home root.
 * @param res - JSON response.
 * @param options - host options.
 */
async function serveProxyBrowse(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const clientCwd = url.searchParams.get('cwd') ?? ''
    // Two file systems can hold the same rule's program: the host's own (posix) and,
    // from WSL, the Windows one under /mnt. `side` says which spelling the UI uses.
    const side = url.searchParams.get('side') === 'windows' || (IS_WINDOWS && url.searchParams.get('side') !== 'local')
      ? 'windows'
      : 'local'
    const requested = url.searchParams.get('path') ?? ''
    const windowsRoots = side === 'windows' ? windowsBrowseRoots() : []
    // Translate the UI's spelling into something readdir understands. Keeping the
    // original in `display` is what lets a click write back `D:\…` instead of `/mnt/d/…`.
    let target
    let display
    if (side === 'windows') {
      const asWindows = requested !== '' && /^[A-Za-z]:[\\/]/.test(requested)
      const asPosix = requested.startsWith('/mnt/')
      if (asWindows === true) {
        target = windowsToPosixPath(requested)
        display = requested.replace(/\//g, '\\').replace(/\\+$/, '') || requested
      } else if (asPosix === true) {
        target = requested
        display = posixToWindowsPath(requested)
      } else if (requested === '') {
        const first = windowsRoots[0]
        if (first === undefined) throw new TailError('bad-request', '这台机器上没有可浏览的 Windows 盘（/mnt/<盘> 不存在）', 400)
        target = windowsToPosixPath(first.path)
        display = first.path
      } else {
        throw new TailError('bad-request', `Windows 侧需要盘符路径（如 D:\\Program Files）：${requested}`, 400)
      }
    } else {
      // Only the host side needs a session cwd; the Windows side is absolute by nature
      // and must keep working when the caller has no session (CLI, tests).
      const root = resolveCwd(ctx, sessionId, clientCwd)
      target = requested === '' ? root : resolve(root, expandHome(requested))
      display = target
    }
    if (target === '') throw new TailError('bad-request', `无法解析路径：${requested}`, 400)

    let entries
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (error) {
      throw new TailError('bad-request', `无法读取目录 ${display}：${error?.code ?? error}`, 400)
    }
    const dirs = []
    const files = []
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('$')) continue
      const full = join(target, entry.name)
      const shown = side === 'windows' ? posixToWindowsPath(full) : full
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: shown })
        continue
      }
      if (!entry.isFile()) continue
      // On /mnt every Windows file carries the exec bit (drvfs), so the mode fallback
      // would list DLLs and logs; there only the suffix list is meaningful.
      const looksProgram = side === 'windows'
        ? PROGRAM_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))
        : isProgramFile(full, entry.name)
      if (looksProgram) files.push({ name: entry.name, path: shown })
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    const parentTarget = dirname(target) === target ? null : dirname(target)
    writeJson(res, 200, {
      ok: true,
      side,
      path: display,
      parent: parentTarget === null ? null : (side === 'windows' ? posixToWindowsPath(parentTarget) : parentTarget),
      roots: side === 'windows' ? windowsRoots : browseRoots(),
      dirs: dirs.slice(0, 300),
      files: files.slice(0, 300),
    })
  } catch (error) {
    writeTailError(res, error)
  }
}

/**
 * Quick-jump roots for the Windows side of the picker (opened from WSL via /mnt).
 * @returns {Array<{name: string, path: string}>} roots with WINDOWS paths.
 */
function windowsBrowseRoots() {
  const roots = []
  const seen = new Set()
  const push = (name, posix) => {
    if (existsSync(posix) !== true || seen.has(posix)) return
    seen.add(posix)
    roots.push({ name, path: posixToWindowsPath(posix) })
  }
  for (const letter of ['c', 'd', 'e', 'f']) push(`Windows ${letter.toUpperCase()}:`, `/mnt/${letter}`)
  for (const letter of ['c', 'd']) {
    push(`${letter.toUpperCase()}:\\Program Files`, `/mnt/${letter}/Program Files`)
    push(`${letter.toUpperCase()}:\\YonCode`, `/mnt/${letter}/Program Files/YonCode`)
    push(`${letter.toUpperCase()}:\\Git`, `/mnt/${letter}/Program Files/Git`)
  }
  return roots
}

/** Names that look like a launchable program, for the browse listing. */
function isProgramFile(fullPath, name) {
  const lower = name.toLowerCase()
  if (PROGRAM_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  try {
    // POSIX marks executables with a mode bit; Windows has no such bit and is
    // covered by the suffix list above.
    return (statSync(fullPath).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Suffixes the file browser always shows (plus anything with an exec bit). */
const PROGRAM_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1', '.jar', '.sh', '.bin', '.mjs', '.cjs']

/** Quick-jump roots offered by the file browser. */
function browseRoots() {
  // The tree starts at the two things a program path can live under, and nothing
  // else: the filesystem root (every path is reachable from it) and, on WSL, the
  // Windows disks. Workspace/home/temp shortcuts only pushed the real start down.
  const roots = []
  if (IS_WINDOWS) {
    for (const letter of ['C', 'D', 'E']) {
      if (existsSync(`${letter}:\\`) === true) roots.push({ name: `磁盘 ${letter}:`, path: `${letter}:\\` })
    }
    return roots
  }
  roots.push({ name: '根路径 /', path: '/' })
  for (const letter of ['c', 'd']) {
    if (existsSync(`/mnt/${letter}`) === true) roots.push({ name: `Windows ${letter.toUpperCase()}:`, path: `/mnt/${letter}` })
  }
  return roots
}

async function serveProxyPrograms(ctx, req, res, options) {
  try {
    if (!isLoopbackRequest(req)) throw new TailError('forbidden', 'this route answers loopback requests only', 403)
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const side = engineSide()
    // On Windows the local side IS the Windows side; inside WSL both sides are
    // reachable (the picker must offer navicat.exe even though the engine runs in
    // the Linux side), so the Windows probe runs on either branch.
    // Only programs we can actually proxy are listed: injecting the tunnel means
    // setting a SOCKS address (env or JVM flag), and a program that has no SOCKS
    // client cannot be helped that way.
    const capable = (names) => names
      .filter((name) => isSocksCapableProgram(name))
      .map((name) => ({ name, side: engineSide() }))
    const local = IS_WINDOWS
      ? capable([...await windowsProgramNames()].map((name) => (name.endsWith('.exe') ? name : `${name}.exe`)))
        .map((item) => ({ ...item, side: 'windows' }))
      : capable([...localProgramNames()])
    let remote = []
    if (!IS_WINDOWS) {
      const names = await windowsProgramNames()
      if (names.size > 0) {
        remote = capable([...names].map((name) => (name.endsWith('.exe') ? name : `${name}.exe`)))
          .map((item) => ({ ...item, side: 'windows' }))
      }
    }
    const suggested = PROXY_PROGRAM_SUGGESTIONS.map((name) => ({ name, side, suggested: true }))
    const seen = new Set()
    const programs = []
    for (const item of [...local, ...remote, ...suggested]) {
      const key = `${item.side}:${item.name.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      programs.push(item)
    }
    programs.sort((a, b) => Number(b.suggested === true) - Number(a.suggested === true) || a.name.localeCompare(b.name))
    writeJson(res, 200, {
      ok: true,
      side,
      // Why the list is short: a program without a SOCKS client can only use a
      // 127.0.0.1 listener, and those need no entry here.
      note: '只列出支持 SOCKS 的程序（java/git/node/curl 等）；其它程序只能靠 127.0.0.1 同端口映射，无需在此选择。',
      programs: programs.slice(0, 400),
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
/**
 * Decide whether a program needs its dependencies installed before it can run.
 *
 * A freshly cloned frontend has no `node_modules`, and the failure it produces
 * (`cross-env: not found`, `vite: not found`) looks like a broken command rather
 * than a missing install. Installing up front — with the output going into the same
 * log the panel already tails — turns that into a visible, self-healing step.
 * @param {string} cwd - program working directory.
 * @returns {{pm: string, args: string[], dir: string}|null} plan, or null when the
 *   directory has no package.json or already has dependencies.
 */
export function installPlanFor(cwd) {
  try {
    if (!existsSync(join(cwd, 'package.json'))) return null
    const modules = join(cwd, 'node_modules')
    if (existsSync(modules)) {
      const entries = readdirSync(modules)
      // An empty node_modules is what a killed install leaves behind.
      if (entries.length > 0) return null
    }
    const has = (name) => existsSync(join(cwd, name))
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : (has('yarn.lock') ? 'yarn' : 'npm')
    const args = pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install']
    return { pm, args, dir: cwd }
  } catch {
    return null
  }
}

/**
 * Run the install phase with its output appended to the program log.
 *
 * The proxy environment is stripped on purpose: npm's own traffic goes to a
 * registry (often a loopback mirror), and an injected ALL_PROXY would send that
 * through the tunnel where the allow list refuses it.
 * @param {object} plan - from {@link installPlanFor}.
 * @param {object} env - base environment.
 * @param {string} logPath - log the panel tails.
 * @param {number} timeoutMs - cap for a cold install.
 * @returns {Promise<{ok: boolean, ms: number, pm: string, error?: string}>} outcome.
 */
export function runInstallPhase(plan, env, logPath, timeoutMs = 1200000) {
  const clean = Object.assign({}, env)
  for (const key of Object.keys(clean)) {
    if (/^(ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|all_proxy|http_proxy|https_proxy|no_proxy)$/.test(key)) delete clean[key]
  }
  const fd = openSync(logPath, 'a')
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(plan.pm, plan.args, {
      cwd: plan.dir, env: clean, stdio: ['ignore', fd, fd], shell: IS_WINDOWS, windowsHide: true,
    })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try { closeSync(fd) } catch { /* already closed */ }
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone already */ }
      done({ ok: false, ms: Date.now() - started, pm: plan.pm, error: `安装超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ ok: false, ms: Date.now() - started, pm: plan.pm, error: isMissingExecutable(error) ? `本机没有安装 ${plan.pm}` : String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? { ok: true, ms: Date.now() - started, pm: plan.pm } : { ok: false, ms: Date.now() - started, pm: plan.pm, error: `${plan.pm} install exited with ${code}` })
    })
  })
}

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
  // A rule can name this program: inject the proxy at launch, so "配好规则再启动"
  // actually proxies it (Java reads JAVA_TOOL_OPTIONS, node/curl read ALL_PROXY).
  // Programs started outside this panel cannot be intercepted — they rely on the
  // 127.0.0.1 shadow listeners instead.
  Object.assign(childEnv, proxyEnvFor(program, cwd))
  // Dependencies first: a missing node_modules would otherwise surface as
  // "cross-env: not found" and look like the entry itself is broken.
  const installPlan = options?.skipInstall === true ? null : installPlanFor(cwd)
  if (installPlan !== null) {
    const header = `--- 初始化：${installPlan.pm} ${installPlan.args.join(' ')}（node_modules 缺失）---\n`
    await appendFile(program.logPath, header, 'utf8').catch(() => {})
    const init = await runInstallPhase(installPlan, childEnv, program.logPath, options?.installTimeoutMs)
    const summary = init.ok === true
      ? `--- 初始化完成：${init.pm} install（${Math.round(init.ms / 1000)}s）---\n`
      : `--- 初始化失败：${init.pm} install（${init.error ?? '未知原因'}），见上方输出 ---\n`
    await appendFile(program.logPath, summary, 'utf8').catch(() => {})
    if (init.ok !== true) throw new TailError('init-failed', `依赖安装失败：${init.error ?? '未知原因'}（日志：${program.logPath}）`, 502)
  }
  let child
  if (IS_WINDOWS) {
    const customCommand = typeof program.startCommand === 'string' ? program.startCommand.replace(/\s*\$\{JDWP_ARGS\}\s*/g, ' ') : ''
    const selected = resolveWindowsRuntime(options?.runtime, options?.bashPath, { bashDialect: isBashDialectCommand(customCommand) })
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
 * Environment a started program needs to use the workspace proxy.
 *
 * Matches the program against the enabled rules: a rule that names a bare
 * program (`java`, `git`) matches any process with that basename, whatever its
 * path; a rule that names a path only matches that executable. The path is
 * therefore optional — it buys precision, not reach.
 * injection that fits that program. Returns `{}` when no rule matches or the
 * workspace has no upstream — a silent no-op rather than an error, because most
 * programs have no rule and must start exactly as before.
 * @param program - one row from {@link scanPrograms}.
 * @param cwd - workspace the program is launched from (the shared proxy config
 *   only uses it to identify which rules belong to this workspace).
 * @returns environment overlay for the child process.
 */
function proxyEnvFor(program, cwd) {
  // A Windows-side redirector cannot see a process this side spawns, so only the
  // local hook may disable injection ("covered twice" was the old, wrong test).
  try {
    const config = readProxyConfig(cwd)
    if (config.socks.host === '' || config.socks.port === 0) return {}
    // ProxyBridge is the primary path when the LOCAL hook is up: it already
    // redirects this side's connections at the socket layer, so adding env/JVM
    // options on top would only stack two proxies. A Windows-side redirector does
    // NOT count — it hooks the Windows stack and cannot see a process this side
    // spawns, which is exactly the WSL + YonCode split.
    if (localRedirectorRunning()) return {}
    const names = new Set()
    const paths = new Set()
    for (const candidate of [program?.name, program?.command, program?.exe, program?.id]) {
      if (typeof candidate !== 'string' || candidate === '') continue
      names.add(programKey(candidate))
      if (candidate.includes('/') || candidate.includes('\\')) paths.add(candidate.replace(/\\/g, '/').toLowerCase())
    }
    const matchRule = (spec) => {
      if (typeof spec !== 'string' || spec === '') return false
      const isPath = spec.includes('/') || spec.includes('\\')
      if (!isPath) return names.has(programKey(spec))
      // A path rule is precise: it matches that executable only. When we do not
      // know the launched path, fall back to the basename so the rule is not
      // silently dead (the panel often launches by name, e.g. `java`).
      if (paths.size === 0) return names.has(programKey(spec))
      return paths.has(spec.replace(/\\/g, '/').toLowerCase())
    }
    const rule = config.rules.find((item) => item.enabled && matchRule(item.program))
    if (rule === undefined) return {}
    const injection = injectionFor(programKey(rule.program), config, { side: engineSide() })
    const env = Object.assign({}, injection?.env ?? {})
    const jvmArgs = Array.isArray(injection?.jvmArgs) ? injection.jvmArgs : []
    // Careful: an existing JAVA_TOOL_OPTIONS must be kept (it may carry the
    // user's own -Xmx); the proxy options are appended.
    if (jvmArgs.length > 0) {
      const previous = typeof process.env.JAVA_TOOL_OPTIONS === 'string' ? process.env.JAVA_TOOL_OPTIONS.trim() : ''
      env.JAVA_TOOL_OPTIONS = [previous, jvmArgs.join(' ')].filter((part) => part !== '').join(' ')
    }
    return env
  } catch {
    return {}
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
/**
 * YonBIP module manifest of a frontend directory (`module.xml` beside package.json).
 *
 * This is a yds/MDF convention: the deployed module name lives in `module.xml`, while
 * `package.json`'s `name` is often the *backend* domainKey — so a row named after the
 * package would read exactly like the java program's row. Only projects that ship a
 * module.xml are affected; a plain npm project keeps its package name.
 * @param dir - frontend project directory.
 * @returns `{ present, name }`; `name` is `''` when the manifest names nothing.
 */
async function moduleXmlManifest(dir) {
  const text = await readTextIfSmall(join(dir, 'module.xml'))
  if (text === undefined) return { present: false, name: '' }
  const match = /<module\b[^>]*\sname\s*=\s*"([^"]*)"/.exec(text)
  return { present: true, name: match === null ? '' : match[1].trim() }
}

/** Row name for a frontend: module.xml → folder (yds), else package.json → folder. */
function nameOfFrontend(manifest, manifestXml, dir) {
  if (manifestXml.present === true) return manifestXml.name !== '' ? manifestXml.name : basename(dir)
  return typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : basename(dir)
}

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
  const manifestXml = await moduleXmlManifest(dir)
  const relDir = relative(workspace, dir) || '.'
  const id = `frontend:${relDir}#${script}`
  if (programs.has(id)) return
  programs.set(id, {
    id,
    kind: 'frontend',
    // yds project (it has module.xml): name after the manifest, else the folder —
    // `package.json`'s name there is the domainKey and collides with the java row.
    // A plain npm project has no module.xml and keeps its package name.
    name: nameOfFrontend(manifest, manifestXml, dir),
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
    // Frontend rows are already named after their own manifest (module.xml / folder),
    // so prefixing the project only produced names that collided with the backend row
    // of the same yds module ("yonasset-c-ass-kk-hans" vs. the launcher's row).
    const base = sanitizeLogName(program.kind === 'frontend'
      ? program.name
      : `${program.project ? `${program.project}-` : ''}${program.name}`)
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
    const customDir = context.variant === 'windows-bash' ? toMsysPath(program.dir) : program.dir
    return {
      command: /^cd\s/.test(withDebug) ? withDebug : `cd ${quoteShell(customDir)} && ${withDebug}`,
      cwd: program.dir,
      wrapperPath,
      env: program.env,
    }
  }
  if (program.kind === 'frontend') {
    const frontDir = context.variant === 'windows-bash' ? toMsysPath(program.dir) : program.dir
    return {
      command: `cd ${quoteShell(frontDir)} && exec ${quoteShell(program.packageManager ?? 'npm')} run ${quoteShell(program.script ?? 'dev')}`,
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
  // User JVM flags (memory, GC, agents) come from `.dsh-ris-ide/config.json`; they sit
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
  // Git Bash runs on Windows but its builtins are POSIX: mkdir/cd need /c/... .
  // The JVM is a Windows binary, so -D paths stay in Windows spelling.
  const shellCspDir = windowsBash ? toMsysPath(cspDir) : cspDir
  const shellDir = windowsBash ? toMsysPath(program.dir) : program.dir
  const command = [
    `mkdir -p ${quoteShell(shellCspDir)}`,
    `cd ${quoteShell(shellDir)}`,
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
/**
 * Translate `C:\x\y` into the MSYS spelling `/c/x/y`.
 *
 * Only the Git Bash wrapper needs this: the Windows JVM still receives the
 * original `C:\...` paths for `-D` flags (it cannot read `/c/...`), but the
 * shell's own `mkdir`/`cd` must see POSIX paths or MSYS treats the drive colon
 * and backslashes as literal characters.
 * @param {string} value - a Windows or already-POSIX path.
 * @returns {string} MSYS path when the input looks like `X:\...`, else the input.
 */
export function toMsysPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(value ?? ''))
  if (match === null) return String(value ?? '')
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

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
// The panel can write `<workspace>/.dsh-ris-ide/config.json` from what it discovered.
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
  let path = resolve(cwd, CONFIG_FILENAME)
  let text = await readTextIfSmall(path)
  if (text === undefined) {
    const legacy = resolve(cwd, LEGACY_CONFIG_FILENAME)
    const legacyText = await readTextIfSmall(legacy)
    if (legacyText !== undefined) {
      path = legacy
      text = legacyText
    }
  }
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
  // Name is the last resort, and only within the same kind: two different kinds can
  // legitimately share a name (a yds project's package.json name equals its java
  // module), and matching across kinds made an update copy a launcher's startCommand
  // onto an unrelated frontend row — and then drop the launcher itself.
  return entries.findIndex((entry, at) => free(at) && entry.name === candidate.name
    && (entry.kind === undefined || candidate.kind === undefined || entry.kind === candidate.kind))
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
  await ensureIdeStateDir(cwd)
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
  // ── P4: daemon-first tools ────────────────────────────────────────────────
  // In daemonMode=auto the engine, the programs and the JDWP sessions belong to
  // risd, so a tool asks the daemon first. Anything it cannot answer — a stopped
  // daemon, a stale bridge, an older risd — falls back to the local plugin
  // implementation, which is exactly what ran before this phase.
  // A tool call is also a "bring it back" gesture for the daemon: if it crashed
  // (or the user ran `risd stop`) while dsh is still open, re-spawn it once and
  // keep using it instead of silently degrading to the plugin-local path. The
  // hint is what an agent needs when even that fails.
  const healDaemon = async () => {
    const bridge = risdBridge
    if (bridge === null) return null
    const now = Date.now()
    if (risdHealBlocked(now)) return null
    if (now - (fallbackWarnedAt.get('__heal') ?? 0) < 5000) return bridge.state
    fallbackWarnedAt.set('__heal', now)
    const ensured = await ensureRisd({ home: proxyHomeDir() }).catch(() => ({ ok: false, reason: 'spawn failed' }))
    if (ensured.ok !== true) {
      // A version mismatch is not a failed start: the same mismatched daemon is
      // still running, and spending breaker budget on it would stop every tool
      // for five minutes (review C-P2-1).
      if (ensured.reason === 'api-mismatch') {
        warnDaemonMismatch()
        return null
      }
      noteRisdHealFailure(ensured.reason ?? 'unknown')
      return null
    }
    noteRisdHealSuccess()
    return attachBridgeState(ensured.state, null)
  }
  const daemonStateForTools = async () => {
    const bridge = risdBridge
    if (bridge === null) return null
    if (bridge.state !== null) {
      // A daemon can die between two calls while the pointer still looks live.
      // Probe at most once per 5 s (health is cheap and unauthenticated) so a
      // half-dead daemon costs one timeout per window instead of one per tool call
      // (review C-P2-2); a dead one drops the pointer and falls into the heal path.
      if (Date.now() - (bridge.lastProbeAt ?? 0) < 5000) return bridge.state
      bridge.lastProbeAt = Date.now()
      const health = await risdHealth(bridge.state).catch(() => null)
      if (health !== null && health.ok === true) return bridge.state
      bridge.state = null
      bridge.degraded = true
    }
    if (bridge.pending !== null) {
      await Promise.race([
        bridge.pending,
        new Promise((resolve) => { const timer = setTimeout(resolve, 3000); timer.unref?.() }),
      ])
    }
    if (bridge.state !== null) return bridge.state
    const healed = await healDaemon()
    // Silence here was the bug: the tools ran locally while the agent (and the
    // user) believed the daemon owned the programs/JDWP sessions (review C-P2-2).
    if (healed === null) warnDaemonFallback()
    return healed
  }
  const warnDaemonFallback = () => {
    const now = Date.now()
    if (now - (fallbackWarnedAt.get('__daemon') ?? 0) < 60_000) return
    fallbackWarnedAt.set('__daemon', now)
    try {
      ctx.logger?.warn?.('[dsh-ris-ide] risd 不可用，agent 工具改走插件本地实现：这样启动的程序不在 daemon 的托管范围内（停 daemon 不会停它）')
    } catch { /* logging is best effort */ }
  }
  const warnDaemonMismatch = () => {
    const now = Date.now()
    if (now - (fallbackWarnedAt.get('__mismatch') ?? 0) < 60_000) return
    fallbackWarnedAt.set('__mismatch', now)
    try {
      ctx.logger?.warn?.('[dsh-ris-ide] risd 版本与插件不一致（apiVersion 不匹配），工具改走插件本地实现；重启 dsh 会启动匹配版本的 risd')
    } catch { /* logging is best effort */ }
  }
  const fallbackWarnedAt = new Map()
  const warnFallback = (what, error) => {
    const now = Date.now()
    if (now - (fallbackWarnedAt.get(what) ?? 0) < 60_000) return
    fallbackWarnedAt.set(what, now)
    try {
      ctx.logger?.warn?.(`[dsh-ris-ide] ${what} 回退到插件本地实现：${describe(error)}`)
    } catch { /* logging is best effort */ }
  }
  // Resolve *which* program a tool meant, through the daemon's own list: in auto
  // mode the daemon owns the program registry, so its ids are the reference.
  const daemonProgramFor = async (daemon, cwd, args) => {
    const res = await daemonListPrograms(daemon, cwd, {})
    if (res.ok !== true) throw new Error(`risd /v1/programs ${res.status ?? ''} ${res.error ?? ''}`.trim())
    const rows = Array.isArray(res.body?.programs) ? res.body.programs : []
    const wantedId = typeof args?.id === 'string' && args.id !== '' ? args.id : null
    const wantedName = typeof args?.name === 'string' && args.name !== '' ? args.name : null
    if (wantedId !== null) return rows.find((row) => row.id === wantedId)
    if (wantedName === null) return undefined
    const exact = rows.find((row) => row.logName === wantedName || row.name === wantedName)
    if (exact !== undefined) return exact
    const matches = rows.filter((row) => String(row.name ?? '').includes(wantedName) || String(row.logName ?? '').includes(wantedName))
    return matches.length === 1 ? matches[0] : undefined
  }
  const tailFromText = (textValue, lines) => {
    const all = String(textValue ?? '').split('\n')
    if (all.length > 0 && all[all.length - 1] === '') all.pop()
    const count = Math.min(Math.max(Number(lines) || 80, 1), 500)
    return all.slice(Math.max(0, all.length - count)).join('\n')
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
      const daemon = await daemonStateForTools()
      if (daemon !== null) {
        try {
          const res = await daemonListPrograms(daemon, cwd, { refresh: args?.refresh === true })
          if (res.ok !== true) throw new Error(`risd /v1/programs ${res.status ?? ''} ${res.error ?? ''}`.trim())
          const listed = res.body ?? {}
          let rows = Array.isArray(listed.programs) ? listed.programs : []
          if (args?.runningOnly === true) rows = rows.filter((program) => program.running?.alive === true)
          return jsonSafe({
            ok: true,
            root: listed.cwd ?? cwd,
            dir: listed.dir ?? logsDir,
            programs: programRows(rows),
            companion: detectCompanionPlugin(cwd),
          })
        } catch (error) { warnFallback('ris_dev_programs', error) }
      }
      let programs = await scanPrograms(cwd, logsDir, args?.refresh === true)
      if (args?.runningOnly === true) programs = programs.filter((program) => program.running?.alive === true)
      return jsonSafe({
        ok: true,
        root: cwd,
        dir: logsDir,
        programs: programRows(programs),
        // Only a real YMS workspace gets a hint; null keeps the payload clean.
        companion: detectCompanionPlugin(cwd),
      })
    },
  })

  register({
    name: 'ris_dev_start',
    description: 'Start one discovered program (Spring Boot: mvn -Pdev compile then exec java; frontend: exec <pm> run <script>), wrapped by run-with-log.sh so it gets a log file, a pidfile and the sidebar stop button. '
      + 'Resolve the program with ris_dev_programs and check ris_dev_status first; give its id, or a unique name fragment. '
      + 'Starting an already-running program is NOT an error: it returns alreadyRunning=true without touching it; use ris_dev_restart to restart it. '
      + 'JVM options (memory, GC) come from the workspace config `.dsh-ris-ide/config.json` (`defaults.jvmArgs` / per-program `jvmArgs`), not from this call.',
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
      const daemon = await daemonStateForTools()
      if (daemon !== null) {
        try {
          const remote = await daemonProgramFor(daemon, cwd, args)
          if (remote === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
          const res = await daemonProgramAction(daemon, { cwd, action: 'start', id: remote.id })
          if (res.ok !== true) throw new Error(`risd start ${res.status ?? ''} ${res.error ?? ''}`.trim())
          const body = res.body ?? {}
          return jsonSafe({
            ok: true,
            alreadyRunning: body.alreadyRunning === true,
            program: programRow(body.program ?? remote),
          })
        } catch (error) { warnFallback('ris_dev_start', error) }
      }
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
      const pathAddressed = typeof args?.path === 'string' && args.path !== ''
      const daemon = await daemonStateForTools()
      if (daemon !== null && !pathAddressed) {
        try {
          const remote = await daemonProgramFor(daemon, cwd, args)
          if (remote === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
          const res = await daemonProgramAction(daemon, { cwd, action: 'stop', id: remote.id })
          if (res.ok !== true) throw new Error(`risd stop ${res.status ?? ''} ${res.error ?? ''}`.trim())
          return jsonSafe(Object.assign({ ok: true, path: res.body?.path ?? remote.logPath }, res.body ?? {}))
        } catch (error) { warnFallback('ris_dev_stop', error) }
      }
      let logPath
      if (pathAddressed) {
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
      const pathAddressed = typeof args?.path === 'string' && args.path !== ''
      const daemon = await daemonStateForTools()
      if (daemon !== null && !pathAddressed) {
        try {
          const remote = await daemonProgramFor(daemon, cwd, args)
          if (remote === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
          const res = await daemonReadProgramLog(daemon, { cwd, id: remote.id, bytes: 256 * 1024 })
          if (res.ok !== true) throw new Error(`risd log ${res.status ?? ''} ${res.error ?? ''}`.trim())
          const body = res.body ?? {}
          const logPath = body.path ?? remote.logPath
          const opened = args?.open !== false
          if (opened) enqueueOpen({ sessionId, cwd, logPath, title: `${remote.name} 日志` })
          return jsonSafe({
            ok: true,
            path: logPath,
            exists: body.exists !== false,
            running: body.running === true,
            opened,
            pid: body.pid ?? null,
            content: tailFromText(body.text, args?.lines),
          })
        } catch (error) { warnFallback('ris_dev_logs', error) }
      }
      let logPath
      let title
      if (pathAddressed) {
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
      const daemon = await daemonStateForTools()
      if (daemon !== null) {
        try {
          const remote = await daemonProgramFor(daemon, cwd, args)
          if (remote === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
          const res = await daemonProgramAction(daemon, { cwd, action: 'restart', id: remote.id })
          if (res.ok !== true) throw new Error(`risd restart ${res.status ?? ''} ${res.error ?? ''}`.trim())
          const body = res.body ?? {}
          return jsonSafe({
            ok: true,
            restarted: body.restarted === true,
            stopped: body.stopped ?? null,
            alreadyRunning: body.alreadyRunning === true,
            program: programRow(body.program ?? remote),
          })
        } catch (error) { warnFallback('ris_dev_restart', error) }
      }
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
      // P4: in auto mode the JDWP session lives in risd. Forward everything the
      // daemon owns — "open" is UI-only and stays here, and a path-addressed call
      // keeps the local session (the daemon resolves programs by id).
      const daemon = await daemonStateForTools()
      const pathAddressed = typeof args?.path === 'string' && args.path !== ''
      if (daemon !== null && action !== 'open' && !pathAddressed) {
        if (action === 'state') {
          try {
            const program = await daemonProgramFor(daemon, cwd, args)
            if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
            const statusRes = await daemonDebugAction(daemon, { action: 'status', cwd, id: program.id, sessionId })
            if (statusRes.ok !== true) throw new Error(`risd debug ${statusRes.status ?? ''} ${statusRes.error ?? ''}`.trim())
            const statusBody = statusRes.body ?? {}
            const breakpointsRes = await daemonDebugAction(daemon, { action: 'breakpoints', cwd, id: program.id, sessionId })
            const breakpointsBody = breakpointsRes.ok === true ? (breakpointsRes.body ?? {}) : {}
            const pending = statusBody?.pendingBreakpoints ?? statusBody?.pending ?? 0
            return jsonSafe({
              ok: true,
              program: programRow(program),
              running: program.running ?? null,
              debuggable: program.kind === 'spring',
              debug: statusBody,
              breakpoints: breakpointsBody?.breakpoints ?? [],
              pendingBreakpoints: typeof pending === 'number' ? pending : 0,
            })
          } catch (error) { warnFallback('ris_dev_debug', error) }
        }
        const mapped = {
          start: 'start', stop: 'detach', status: 'status', poll: 'events',
          breakpoints: 'breakpoints', breakpoint_add: 'breakpoint-add',
          breakpoint_remove: 'breakpoint-remove', breakpoint_clear: 'breakpoint-clear',
          threads: 'threads', stack: 'stack', variables: 'variables',
          step: 'step', resume: 'resume', pause: 'pause',
        }[action]
        if (mapped !== undefined) {
          try {
            const program = await daemonProgramFor(daemon, cwd, args)
            if (program === undefined) throw new TailError('unknown-program', `no program matched ${describeRef(args)}`, 404)
            const res = await daemonDebugAction(daemon, Object.assign({
              action: mapped, cwd, id: program.id, sessionId,
            }, {
              className: args?.className,
              line: args?.line,
              suspendPolicy: args?.suspendPolicy,
              requestId: args?.requestId,
              threadId: args?.threadId,
              frameIndex: args?.frameIndex,
              max: args?.max,
              kind: args?.kind,
              since: args?.since,
              suspend: args?.suspend,
            }))
            if (res.ok !== true) throw new Error(`risd debug ${res.status ?? ''} ${res.error ?? ''}`.trim())
            return jsonSafe(Object.assign({ ok: true }, res.body ?? {}))
          } catch (error) { warnFallback('ris_dev_debug', error) }
        }
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
/**
 * The dev server address a program printed in its log.
 *
 * Only LOCAL addresses count: the point is to open the page this program serves,
 * and picking up a gateway URL from the same line (MDF prints the Java address
 * next to the node one) would open the wrong site. Hosts like 0.0.0.0 and the
 * `<HOST地址>` placeholder some scaffolds print are rewritten to 127.0.0.1,
 * because the browser must dial a concrete loopback address (m03945).
 */
async function logUrl(logPath) {
  if (!existsSync(logPath)) return undefined
  const tail = await readTail(logPath, 16 * 1024).catch(() => undefined)
  if (tail === undefined || typeof tail.content !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const text = tail.content.replace(/\u001b\[[0-9;]*m/g, '')
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]|<[^>\s]{1,40}>):\d+[^\s)"'，。；]*/gi
  const matches = text.match(pattern)
  if (matches === null || matches.length === 0) return undefined
  const last = matches[matches.length - 1]
  // A wildcard/placeholder host is a listening address, not a dialable one.
  return last.replace(/^(https?):\/\/(?:0\.0\.0\.0|\[::\]|<[^>]+>|\[::1\]):/i, '$1://127.0.0.1:')
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
  const companion = value?.companion
  // The hint is additive: the list itself (and the tool result) stays usable
  // when the companion plugin is not installed.
  const hint = companion !== undefined && companion !== null
    ? `\nOptional companion plugin: ${companion.plugin} (detected ${companion.detected}) — ${companion.hint}`
    : ''
  if (programs.length === 0) return `No runnable programs under ${value?.root ?? '?'}.${hint}`
  const lines = [`${programs.length} program(s) under ${value.root} (logs: ${value.dir}):`]
  for (const program of programs) {
    lines.push(`- ${program.running ? '[running]' : '[stopped]'} ${program.name} (${program.kind}) id=${program.id}`)
    lines.push(`  dir=${program.dir}${program.mainClass ? ` main=${program.mainClass}` : ''}${program.script ? ` script=${program.script}` : ''} log=${program.logPath}`)
  }
  return lines.join('\n') + hint
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
  // P4 tests: pretend the plugin is attached to a daemon without booting one.
  setRisdBridge: (bridge) => { risdBridge = bridge },
  resolvePath,
  refreshDshWindows,
  rememberDshOrigin,
  detectCompanionPlugin,
  renderProgramList,
  windowsProgramNames,
  resetWindowsProgramCache,
  setWindowsProgramProbe,
  // Proxy rules + engine (the dialog's three routes).
  PROXY_PATH,
  RISD_ENSURE_PATH,
  risdHealBlocked,
  risdHealReason,
  noteRisdHealFailure,
  noteRisdHealSuccess,
  PROXY_ACTION_PATH,
  buildProfile,
  PROXY_PROGRAMS_PATH,
  PROXY_BROWSE_PATH,
  serveProxy,
  serveProxyAction,
  serveProxyPrograms,
  serveProxyBrowse,
  proxyEnvFor,
  proxyView,
  // Process-wide child-service lifecycle (exit hook + heartbeat + janitor), and the
  // adoption of an engine left behind by a previous dsh process.
  ensureLifecycle,
  armLocalProxyCleanup,
  disarmLocalProxyCleanup,
  isBashDialectCommand,
  startHeartbeat,
  adoptLeftoverEngine,
  decorateProxyRule,
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
  // streamed (paged) variants: NDJSON frames while the repo roots are searched in parallel
  SEARCH_STREAM_PATH,
  CONTENT_SEARCH_STREAM_PATH,
  SEARCH_STREAM_PAGE_DEFAULT,
  SEARCH_STREAM_PAGE_MAX,
  SEARCH_STREAM_CONCURRENCY,
  searchWorkspaceFilesStream,
  searchWorkspaceContentStream,
  serveSearchStream,
  createOrderedPages,
  streamGitStdout,
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
  // git availability is a quarantine, not a latch (m03193)
  gitUnavailable,
  noteGitSpawnFailure,
  noteGitSuccess,
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
  toMsysPath,
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
  WINDOWS_PATH,
  WORKSPACES_PATH,
  serveWindows,
  listIdeWindows,
  liveSessionFor,
  ideWindowOpened,
  ideWindowClosed,
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
  // the tree's copy mirrored onto the OS clipboard (paste in Explorer/Finder/…)
  CLIPBOARD_FILES_PATH,
  CLIPBOARD_MAX_ENTRIES,
  CLIPBOARD_MAX_PAYLOAD,
  CLIPBOARD_STAGE_DIR,
  CLIPBOARD_STAGE_MAX_BYTES,
  stageClipboardCopy,
  pruneClipboardStage,
  clipboardStageMapping,
  verifyClipboardStageOriginals,
  CLIPBOARD_STAGE_INTEGRITY_LOG,
  serveClipboardFiles,
  writeSystemFileClipboard,
  windowsClipboardScript,
  isWsl,
  // …and reading it back (Desktop → tree pastes: WSLg hides CF_HDROP from the page)
  CLIPBOARD_READ_PATH,
  clipboardScope,
  serveClipboardRead,
  readSystemFileClipboard,
  windowsClipboardReadScript,
  parseClipboardRead,
  clipboardPathsToLinux,
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
  OPEN_TARGET_PATH,
  DEFAULT_BYTES,
  HARD_MAX_BYTES,
  FS_WRITE_MAX_BODY_BYTES,
  FS_WRITE_TEMP_SUFFIX,
  writeChunk,
  MIN_BYTES,
  PID_SUFFIX,
  DEFAULT_STOP_GRACE_MS,
}
