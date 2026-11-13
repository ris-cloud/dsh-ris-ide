/**
 * ProxyBridge bundle — download the redirector binaries on first use and cache
 * them under `<home>/proxybridge/bundle`.
 *
 * The binaries used to ship inside the plugin (2.9 MB in `lib/vendor`). They are
 * now published as `ris-proxy.4.0.tgz` and fetched the first time the Windows side
 * is needed, so an install/lookup costs one HTTPS request instead of a bigger
 * tarball. This module is deliberately self-contained and dependency-free:
 * `redirector.js` (or a server route) passes `home` explicitly, and tests inject
 * `fetchImpl`/bytes so nothing ever reaches the network.
 *
 * Layout of the tgz (relative to its root) is fixed by `bundleLayout()`; unknown
 * entries are ignored, symlinks/absolute paths/traversal are rejected. An install
 * lands in `<dir>.tmp-<pid>` first and is renamed into place, so a failed or
 * concurrent download never leaves half a bundle behind.
 *
 * @module dsh-ris-ide/proxybridge-bundle
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Bump when the manifest gains a meaning-changing field; old manifests are ignored. */
export const MANIFEST_VERSION = 1
/** Give up on a download after this long (a release asset is ~1 MB). */
export const DOWNLOAD_TIMEOUT_MS = 60_000
/** Refuse absurd downloads / decompression bombs (the real asset is ~1 MB). */
export const MAX_TGZ_BYTES = 16 * 1024 * 1024
export const MAX_TAR_BYTES = 64 * 1024 * 1024
/** Relative directory (under the proxy home) that holds the unpacked bundle. */
export const BUNDLE_DIRNAME = join('proxybridge', 'bundle')
/** Manifest file name inside that directory. */
export const MANIFEST_FILENAME = 'manifest.json'

/**
 * Where the release asset lives. `ris-proxy.4.0.tgz` (ProxyBridge 4.0 bundle) is
 * attached to the 1.8.1
 * release on BOTH mirrors, so a blocked network on one side still installs:
 * Gitee is the primary repository (the GitHub repo is a mirror), and it is tried
 * first. Both URLs point at the same uploaded bytes.
 */
export const BUNDLE_URLS = Object.freeze([
  'https://gitee.com/riscloud/dsh-ris-ide/releases/download/1.8.0/ris-proxy.4.0.tgz',
  'https://github.com/ris-cloud/dsh-ris-ide/releases/download/1.8.0/ris-proxy.4.0.tgz',
])

/** Primary download location (kept for callers that display one address). */
export const DEFAULT_BUNDLE_URL = BUNDLE_URLS[0]

/**
 * Pinned sha256 of the release asset `ris-proxy.4.0.tgz` (the 8 files below).
 *
 * The tgz contains native binaries — including the WinDivert kernel driver — and
 * the Windows side starts them elevated. TLS alone is not a strong enough claim
 * for that: a replaced release asset on either mirror would otherwise become
 * elevated code execution (review B-P0-1). The release process sets this constant
 * to the sha256 of the uploaded archive.
 *
 * An explicit empty value overrides the pin for local/lab mirrors:
 * `DSH_RIS_IDE_PROXYBRIDGE_SHA256=''` or `settings.proxybridgeSha256: ''` means
 * "trust on first use" — the first install records its sha256 in the manifest and
 * every later cache hit/install is checked against that recorded value.
 */
export const BUNDLE_SHA256 = '104456cb674206c2a1419e41825f698bd007351c7be524c23987509b35b31a53'

/** Env override for {@link BUNDLE_SHA256} (see its docs for the empty-string case). */
export const BUNDLE_SHA256_ENV = 'DSH_RIS_IDE_PROXYBRIDGE_SHA256'

/**
 * Extra hosts a release-asset request may be redirected to. GitHub serves release
 * downloads through a separate asset host; Gitee does the same for large uploads.
 * A redirect to anything outside this set plus the configured mirror hosts is
 * refused, so a mirror cannot silently hand the download to an unrelated host.
 */
const BUNDLE_REDIRECT_HOSTS = Object.freeze([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'foruda.gitee.com',
])

/** The files a usable bundle must contain, relative to the tgz root. */
const BUNDLE_FILES = Object.freeze([
  'LICENSE-ProxyBridge.txt',
  'NOTICE.md',
  'linux/ProxyBridge',
  'linux/libproxybridge.so',
  'windows/ProxyBridgeCore.dll',
  'windows/ProxyBridge_CLI.exe',
  'windows/WinDivert.dll',
  'windows/WinDivert64.sys',
])

/** Reasonable hint for callers that want to show something actionable. */
const FAILURE_HINT = '已依次尝试 Gitee 与 GitHub 两个地址（见上方错误）。可检查网络/代理后重试；也可把 DSH_RIS_IDE_PROXYBRIDGE_URL 指向可访问的 ris-proxy.tgz（http 仅允许回环地址），或把该 tgz 手动上传。'

export function bundleLayout() {
  return [...BUNDLE_FILES]
}

/** `<home>/proxybridge/bundle`, where `home` is the caller's `~/.dsh-ris-ide`. */
export function installDir(home) {
  if (typeof home !== 'string' || home.trim() === '') throw new Error('home 必须是目录路径（例如 ~/.dsh-ris-ide）')
  return join(home, BUNDLE_DIRNAME)
}

export function manifestPath(dir) {
  return join(dir, MANIFEST_FILENAME)
}

/** Loopback hosts may use plain http in tests/local mirrors; everything else must be https. */
function isLoopbackHostname(hostname) {
  const text = String(hostname ?? '').toLowerCase()
  return text === '127.0.0.1' || text === 'localhost' || text === '[::1]' || text === '::1'
}

/** Empty string means "not configured"; an invalid URL throws with its source. */
function normalizeBundleUrl(value, source) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${source} 不是合法 URL：${text}`)
  }
  if (parsed.protocol === 'https:') return parsed.toString()
  if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) return parsed.toString()
  throw new Error(`${source} 必须使用 https（http 只允许回环测试地址）：${text}`)
}

/**
 * Candidate tgz URLs in the order they are tried: explicit env/settings override
 * (exactly one address, the caller asked for it) otherwise the mirror pair.
 * @param {{env?: Record<string, string|undefined>, settings?: {proxybridgeUrl?: string}|null}} [options]
 * @returns {string[]} absolute URLs.
 */
export function resolveBundleUrls(options = {}) {
  const env = options.env ?? process.env
  const settings = options.settings ?? {}
  const fromEnv = normalizeBundleUrl(env?.DSH_RIS_IDE_PROXYBRIDGE_URL, 'DSH_RIS_IDE_PROXYBRIDGE_URL')
  if (fromEnv !== '') return [fromEnv]
  const fromSettings = typeof settings === 'object' && settings !== null
    ? normalizeBundleUrl(settings.proxybridgeUrl, 'settings.proxybridgeUrl')
    : ''
  if (fromSettings !== '') return [fromSettings]
  return [...BUNDLE_URLS]
}

/** First candidate; the single-address view of {@link resolveBundleUrls}. */
export function resolveBundleUrl(options = {}) {
  return resolveBundleUrls(options)[0]
}

/** Validate a sha256 digest; `''` means "not pinned" and is passed through. */
function normalizeSha256(value, source) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === '') return ''
  if (/^[0-9a-f]{64}$/.test(text) !== true) {
    throw new Error(`${source} 不是合法的 sha256（需要 64 位十六进制字符）：${text}`)
  }
  return text
}

/**
 * The sha256 the next install must match.
 *
 * Resolution order (the single place that decides it, review B-P0-1):
 * 1. `DSH_RIS_IDE_PROXYBRIDGE_SHA256` (an explicit empty string = not pinned),
 * 2. `settings.proxybridgeSha256` (same empty-string meaning),
 * 3. the release constant {@link BUNDLE_SHA256}.
 *
 * @param {{env?: Record<string, string|undefined>, settings?: {proxybridgeSha256?: string}|null}} [options]
 * @returns {string} lowercase digest, or `''` for "trust on first use".
 */
export function resolveBundleSha256(options = {}) {
  const env = options.env ?? process.env
  if (env !== null && typeof env === 'object' && Object.prototype.hasOwnProperty.call(env, BUNDLE_SHA256_ENV) === true) {
    return normalizeSha256(env[BUNDLE_SHA256_ENV], BUNDLE_SHA256_ENV)
  }
  const settings = options.settings ?? {}
  if (settings !== null && typeof settings === 'object' && Object.prototype.hasOwnProperty.call(settings, 'proxybridgeSha256') === true) {
    return normalizeSha256(settings.proxybridgeSha256, 'settings.proxybridgeSha256')
  }
  return BUNDLE_SHA256
}

/**
 * Non-throwing variants for status/UI readers: a typo in `settings.json` or the
 * env override must degrade to the built-in mirrors plus an error string, not
 * fail the request (review B-P2: `GET /v1/proxybridge` returned 500 and hid the
 * very diagnosis the maintenance card exists for).
 * @returns `{urls, error}` / `{expectedSha256, error}`.
 */
export function resolveBundleUrlsSafe(options = {}) {
  try {
    return { urls: resolveBundleUrls(options), error: '' }
  } catch (error) {
    return { urls: [...BUNDLE_URLS], error: error?.message ?? String(error) }
  }
}

export function resolveBundleSha256Safe(options = {}) {
  try {
    return { expectedSha256: resolveBundleSha256(options), error: '' }
  } catch (error) {
    return { expectedSha256: BUNDLE_SHA256, error: error?.message ?? String(error) }
  }
}

/**
 * Hosts a download (after following redirects) is allowed to come from: the
 * built-in mirrors, the URL(s) being tried, the known release-asset hosts and
 * anything listed in `DSH_RIS_IDE_PROXYBRIDGE_ALLOWED_HOSTS` (comma separated).
 * @param {string[]} urls - the candidate URLs for this install.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Set<string>}
 */
function allowedDownloadHosts(urls, env = process.env) {
  const hosts = new Set()
  const add = (value) => {
    try {
      hosts.add(new URL(value).hostname.toLowerCase())
    } catch {
      // An invalid candidate was already rejected by normalizeBundleUrl; ignore it here.
    }
  }
  for (const value of BUNDLE_URLS) add(value)
  for (const value of urls) add(value)
  for (const host of BUNDLE_REDIRECT_HOSTS) hosts.add(host)
  const extra = typeof env?.DSH_RIS_IDE_PROXYBRIDGE_ALLOWED_HOSTS === 'string' ? env.DSH_RIS_IDE_PROXYBRIDGE_ALLOWED_HOSTS : ''
  for (const part of extra.split(',')) {
    const host = part.trim().toLowerCase()
    if (host !== '') hosts.add(host)
  }
  return hosts
}

/** Read the manifest, or null when it is missing/unreadable/from another schema. */
export function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(dir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.version !== MANIFEST_VERSION) return null
    if (parsed.files === null || typeof parsed.files !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Cheap install check: every expected file exists with the size recorded at
 * install time, and — when `expectedSha256` is non-empty — the whole-archive
 * digest in the manifest matches it. Content is *not* re-hashed here; use
 * {@link verifyInstalled} before trusting a cache (review B-P0-1).
 * @param {string} dir - the bundle install directory.
 * @param {{expectedSha256?: string}} [options]
 * @returns {boolean}
 */
export function isInstalled(dir, options = {}) {
  const expected = normalizeSha256(options.expectedSha256 ?? '', 'expectedSha256')
  const manifest = readManifest(dir)
  if (manifest === null) return false
  if (expected !== '' && String(manifest.sha256 ?? '').toLowerCase() !== expected) return false
  for (const rel of BUNDLE_FILES) {
    const expectedSize = manifest.files[rel]
    if (!Number.isInteger(expectedSize)) return false
    try {
      const stat = statSync(join(dir, ...rel.split('/')))
      if (stat.isFile() !== true || stat.size !== expectedSize) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Full content verification of an installed bundle (review B-P0-1).
 *
 * Hashing all 8 files is cheap (the bundle is ~1 MB), so download/upload finish
 * with this check and `ensureBundle` runs it before trusting a cache hit. It
 * catches same-size corruption that {@link isInstalled} cannot see. Installs
 * written by an older version have no per-file hashes and are therefore reported
 * as unverified (callers reinstall).
 *
 * @param {{home?: string, dir?: string, expectedSha256?: string}} options
 * @returns {{ok: boolean, dir: string, reason: string, expected: string, actual: string, files: string[]}}
 */
export function verifyInstalled(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== ''
    ? options.dir
    : (typeof options.home === 'string' && options.home !== '' ? installDir(options.home) : '')
  const expected = normalizeSha256(options.expectedSha256 ?? '', 'expectedSha256')
  const fail = (reason) => ({ ok: false, dir, reason, expected, actual: typeof options.expectedSha256 === 'string' ? options.expectedSha256 : '', files: [] })
  if (dir === '') return fail('没有指定 bundle 安装目录')
  const manifest = readManifest(dir)
  if (manifest === null) return fail('没有可用的安装记录（manifest.json 缺失或损坏）')
  const actual = String(manifest.sha256 ?? '').toLowerCase()
  if (expected !== '' && actual !== expected) {
    return { ok: false, dir, reason: `安装记录的 sha256 与固定值不一致（期望 ${expected}，实际 ${actual || '空'}）`, expected, actual, files: [] }
  }
  const hashes = manifest.fileHashes !== null && typeof manifest.fileHashes === 'object' ? manifest.fileHashes : null
  const files = []
  for (const rel of BUNDLE_FILES) {
    const size = manifest.files[rel]
    if (!Number.isInteger(size)) return fail(`安装记录缺少 ${rel} 的大小`)
    const full = join(dir, ...rel.split('/'))
    let buffer
    try {
      const stat = statSync(full)
      if (stat.isFile() !== true) return fail(`${rel} 不是普通文件`)
      if (stat.size !== size) return fail(`${rel} 的大小与安装记录不一致（${stat.size} ≠ ${size}）`)
      buffer = readFileSync(full)
    } catch {
      return fail(`缺少文件：${rel}`)
    }
    const recorded = typeof hashes?.[rel] === 'string' ? hashes[rel].toLowerCase() : ''
    if (recorded === '') return fail(`旧版安装缺少 ${rel} 的逐文件哈希，请重新安装`)
    const computed = sha256Of(buffer)
    if (computed !== recorded) return fail(`${rel} 的内容与安装记录不一致（可能被篡改或损坏）`)
    files.push(rel)
  }
  return { ok: true, dir, reason: '', expected, actual, files }
}

const TAR_BLOCK = 512

/** Parse an octal numeric field (NUL/space padded); reject GNU base-256 values. */
function readOctal(field, label) {
  if (field.length > 0 && (field[0] & 0x80) !== 0) throw new Error(`tgz 头部的 ${label} 使用了不支持的 base-256 编码`)
  const text = field.toString('ascii').replace(/[\0 ]+$/g, '').replace(/^ +/g, '')
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (Number.isFinite(value) !== true) throw new Error(`tgz 头部的 ${label} 不是合法的八进制数`)
  return value
}

/** Join ustar `prefix` + `name`, strip a leading `./`, then validate the path. */
function tarEntryName(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '')
  let full = prefix === '' ? name : `${prefix}/${name}`
  while (full.startsWith('./')) full = full.slice(2)
  full = full.replace(/\/+$/, '')
  if (full === '') return ''
  if (full.startsWith('/') || /^[A-Za-z]:[\\/]/.test(full) === true) throw new Error(`tgz 含绝对路径，拒绝安装：${full}`)
  const segments = full.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error(`tgz 含不安全的路径，拒绝安装：${full}`)
  }
  return full
}

/**
 * Minimal ustar reader: regular files only (directories skipped), checksums
 * verified. Returns a Map of `relativePath → Buffer` for the requested layout.
 */
function parseTar(buffer, wanted) {
  const entries = new Map()
  let offset = 0
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    if (header.every((byte) => byte === 0)) break
    const storedChecksum = readOctal(header.subarray(148, 156), 'checksum')
    let actualChecksum = 0
    for (let index = 0; index < TAR_BLOCK; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]
    }
    if (actualChecksum !== storedChecksum) throw new Error('tgz 头部校验和错误（文件已损坏）')
    const size = readOctal(header.subarray(124, 136), 'size')
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const name = tarEntryName(header)
    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new Error(`tgz 已截断：${name}`)
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (name === '') continue
    if (typeflag === '5') continue // directory
    if (typeflag === '2' || typeflag === '1') throw new Error(`tgz 含符号链接/硬链接，拒绝安装：${name}`)
    // pax/global headers (`x`, `g`) and any other extension are deliberately not
    // supported: the entry they describe is reapplied by the tar writer with a
    // truncated ustar name, so a bundle packed with long paths fails closed with
    // `tgz 缺少文件` instead of being installed under a wrong name. The shipped
    // bundle's file names are all well below the 100-byte ustar limit.
    if (typeflag !== '0') continue
    if (wanted.has(name) !== true) continue // unknown entries are ignored
    entries.set(name, Buffer.from(buffer.subarray(dataStart, dataEnd)))
  }
  const missing = [...wanted].filter((name) => entries.has(name) !== true)
  if (missing.length > 0) throw new Error(`tgz 缺少文件：${missing.join('、')}`)
  return entries
}

/** gunzip + parse + require the full layout. */
function extractBundle(bytes) {
  if (Buffer.isBuffer(bytes) !== true || bytes.length === 0) throw new Error('tgz 内容为空')
  if (bytes.length > MAX_TGZ_BYTES) throw new Error(`tgz 内容过大（${bytes.length} 字节，上限 ${MAX_TGZ_BYTES}）`)
  let tar
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES })
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error?.code === 'ERR_OUT_OF_RANGE') {
      throw new Error(`tgz 解压后过大（上限 ${MAX_TAR_BYTES} 字节）`)
    }
    throw new Error('不是合法的 .tgz（gzip 解压失败）')
  }
  return parseTar(tar, new Set(BUNDLE_FILES))
}

/** Binaries need +x; text files do not. */
function fileMode(rel) {
  return /(?:^|\/)(?:ProxyBridge|libproxybridge\.so)$|\.(?:exe|dll|sys)$/i.test(rel) === true ? 0o755 : 0o644
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** How old a leftover `<dir>.tmp-*` / `<dir>.old-*` must be before it is removed. */
const STALE_INSTALL_MS = 60 * 60 * 1000

/**
 * Remove abandoned staging/backup directories of earlier (crashed) installs.
 * Only directories older than `maxAgeMs` are touched, so a concurrent install in
 * another process is not disturbed (review B-P2 安装残留).
 * @param {string} dir - the bundle install directory.
 * @param {{maxAgeMs?: number}} [options]
 * @returns {string[]} names removed.
 */
export function cleanupStaleInstalls(dir, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : STALE_INSTALL_MS
  const parent = dirname(dir)
  const base = basename(dir)
  const removed = []
  let names
  try {
    names = readdirSync(parent)
  } catch {
    return removed
  }
  const now = Date.now()
  for (const name of names) {
    const isStaging = name.startsWith(`${base}.tmp-`) === true || name.startsWith(`${base}.old-`) === true
    if (isStaging !== true) continue
    const full = join(parent, name)
    try {
      const stat = statSync(full)
      if (now - stat.mtimeMs < maxAgeMs) continue
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Another process may be removing it right now; nothing to do.
    }
  }
  return removed
}

/** Write a complete tree into `<dir>.tmp-<pid>`, then swap it in atomically. */
function writeInstall({ dir, url, sha256, files, source = 'download' }) {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  cleanupStaleInstalls(dir)
  // A daemon can install two bundles at once (an upload while a download is in
  // flight). Staging paths are therefore unique per attempt, not per process —
  // a shared name would let the second attempt `rm -rf` the first one's work.
  const attempt = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${dir}.tmp-${attempt}`
  rmSync(tmp, { recursive: true, force: true })
  const backup = `${dir}.old-${attempt}`
  try {
    for (const [rel, content] of files) {
      const to = join(tmp, ...rel.split('/'))
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      writeFileSync(to, content, { mode: fileMode(rel) })
    }
    const manifest = {
      version: MANIFEST_VERSION,
      url,
      sha256,
      source,
      installedAt: new Date().toISOString(),
      files: Object.fromEntries([...files].map(([rel, content]) => [rel, content.length])),
      // Per-file digests let a later cache hit detect same-size tampering/corruption.
      fileHashes: Object.fromEntries([...files].map(([rel, content]) => [rel, sha256Of(content)])),
    }
    writeFileSync(manifestPath(tmp), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    rmSync(backup, { recursive: true, force: true })
    let hadPrevious = false
    if (existsSync(dir) === true) {
      renameSync(dir, backup)
      hadPrevious = true
    }
    try {
      renameSync(tmp, dir)
    } catch (error) {
      if (hadPrevious === true) {
        try {
          renameSync(backup, dir)
        } catch {
          throw new Error(`切换 bundle 安装目录失败（${error?.message ?? String(error)}）；旧安装保留在 ${backup}，请手动恢复`)
        }
      }
      throw error
    }
    if (hadPrevious === true) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

/**
 * Download and buffer an archive, refusing oversized bodies and untrusted hosts
 * (review B-P0-1 / B-P1-1).
 *
 * - The host of the *final* URL (after redirects) must be in `allowedHosts`.
 * - `content-length` over the cap is refused before any body is read.
 * - A streaming body is accumulated with a hard cap; cancel it as soon as the
 *   cap is crossed so a runaway response cannot be buffered into memory.
 */
async function downloadBytes(url, fetchImpl, options = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前 Node 没有 fetch，无法下载内置 ProxyBridge（需要 Node 18+）')
  let response
  try {
    response = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`下载超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s）：${url}`)
    }
    throw new Error(`下载失败：${error?.message ?? String(error)}（${url}）`)
  }
  if (response?.ok !== true) throw new Error(`下载失败：HTTP ${response?.status ?? '?'}（${url}）`)
  const finalUrl = typeof response.url === 'string' && response.url !== '' ? response.url : url
  let finalHost = ''
  try {
    finalHost = new URL(finalUrl).hostname.toLowerCase()
  } catch {
    finalHost = ''
  }
  const allowed = options.allowedHosts instanceof Set ? options.allowedHosts : null
  if (allowed !== null && allowed.has(finalHost) !== true) {
    throw Object.assign(
      new Error(`下载被重定向到不受信任的主机 ${finalHost || finalUrl}（${finalUrl}）；已取消安装。请把该主机加入 DSH_RIS_IDE_PROXYBRIDGE_ALLOWED_HOSTS，或改用官方镜像`),
      { code: 'untrusted-host', host: finalHost, url: finalUrl },
    )
  }
  const declared = Number.parseInt(String(response.headers?.get?.('content-length') ?? ''), 10)
  if (Number.isFinite(declared) === true && declared > MAX_TGZ_BYTES) {
    throw Object.assign(
      new Error(`下载内容过大：服务端声明 ${declared} 字节，上限 ${MAX_TGZ_BYTES} 字节`),
      { code: 'too-large', declared, limit: MAX_TGZ_BYTES },
    )
  }
  const chunks = []
  let total = 0
  const stream = response.body
  if (stream !== null && typeof stream === 'object' && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) === true ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_TGZ_BYTES) {
        try {
          await stream.cancel?.()
        } catch {
          // The response is being discarded anyway.
        }
        throw Object.assign(
          new Error(`下载内容过大（超过 ${MAX_TGZ_BYTES} 字节上限），已中止`),
          { code: 'too-large', limit: MAX_TGZ_BYTES },
        )
      }
      chunks.push(buffer)
    }
  } else {
    const body = await response.arrayBuffer()
    const buffer = Buffer.from(body ?? [])
    total = buffer.length
    if (total > MAX_TGZ_BYTES) {
      throw Object.assign(
        new Error(`下载内容过大（${total} 字节，上限 ${MAX_TGZ_BYTES} 字节）`),
        { code: 'too-large', declared: total, limit: MAX_TGZ_BYTES },
      )
    }
    chunks.push(buffer)
  }
  const bytes = Buffer.concat(chunks, total)
  if (bytes.length === 0) throw new Error(`下载内容为空：${url}`)
  return bytes
}

/**
 * Download `url` and install it into `<home>/proxybridge/bundle`.
 * Throws on any failure (network, host, archive, layout, digest) and never writes
 * a mismatching archive: the digest is checked *before* extraction (review B-P0-1).
 * @param {{home: string, url: string, fetchImpl?: typeof fetch, expectedSha256?: string, env?: Record<string,string|undefined>}} options
 * @returns {Promise<{ok: true, dir: string, files: string[], fileCount: number, bytes: number, fromCache: false, sha256: string, url: string}>}
 */
export async function downloadAndInstall(options = {}) {
  const { home, fetchImpl } = options
  const url = normalizeBundleUrl(options.url, 'url')
  if (url === '') throw new Error('url 不能为空')
  const expected = normalizeSha256(options.expectedSha256 ?? '', 'expectedSha256')
  const dir = installDir(home)
  const allowedHosts = allowedDownloadHosts([url], options.env ?? process.env)
  const bytes = await downloadBytes(url, fetchImpl, { allowedHosts })
  const sha256 = sha256Of(bytes)
  if (expected !== '' && sha256 !== expected) {
    throw Object.assign(
      new Error(`下载内容与固定 sha256 不一致（期望 ${expected}，实际 ${sha256}）；已拒绝安装。请确认镜像/代理没有替换发布物，或更新固定值`),
      { code: 'hash-mismatch', expected, actual: sha256 },
    )
  }
  const files = extractBundle(bytes)
  writeInstall({ dir, url, sha256, files, source: 'download' })
  return { ok: true, dir, files: [...files.keys()], fileCount: files.size, bytes: bytes.length, fromCache: false, sha256, url }
}

/**
 * Install a bundle the caller already has (upload / offline copy). The manifest
 * records the *real* archive digest, not a placeholder (review B-P0-1).
 * @param {{home: string, bytes: Buffer|Uint8Array, expectedSha256?: string}} options
 * @returns {{ok: true, dir: string, files: string[], fileCount: number, bytes: number, fromCache: false, sha256: string, url: 'upload'}}
 */
export function installFromTgz(options = {}) {
  const { home, bytes } = options
  const dir = installDir(home)
  const buffer = Buffer.isBuffer(bytes) === true ? bytes : Buffer.from(bytes ?? [])
  const sha256 = sha256Of(buffer)
  const expected = normalizeSha256(options.expectedSha256 ?? '', 'expectedSha256')
  if (expected !== '' && sha256 !== expected) {
    throw Object.assign(
      new Error(`上传的压缩包与固定 sha256 不一致（期望 ${expected}，实际 ${sha256}）；已拒绝安装`),
      { code: 'hash-mismatch', expected, actual: sha256 },
    )
  }
  const files = extractBundle(buffer)
  writeInstall({ dir, url: 'upload', sha256, files, source: 'upload' })
  const verdict = verifyInstalled({ dir, expectedSha256: sha256 })
  if (verdict.ok !== true) throw new Error(`安装后自检失败：${verdict.reason}`)
  return { ok: true, dir, files: [...files.keys()], fileCount: files.size, bytes: buffer.length, fromCache: false, sha256, url: 'upload' }
}

/**
 * Make sure a bundle is installed: reuse a verified cache, otherwise download it.
 * Never throws — a caller (plugin proxy route, CLI) gets `{ok:false}` with the
 * attempted URL and an actionable hint instead.
 * @param {{home: string, url?: string, settings?: {proxybridgeUrl?: string, proxybridgeSha256?: string}, env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, force?: boolean, expectedSha256?: string}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function ensureBundle(options = {}) {
  const { home, fetchImpl, force = false } = options
  const env = options.env ?? process.env
  const settings = options.settings ?? {}
  let dir = ''
  let urls = []
  try {
    const explicit = typeof options.url === 'string' ? normalizeBundleUrl(options.url, 'url') : ''
    urls = explicit === '' ? resolveBundleUrls({ env, settings }) : [explicit]
    const expected = options.expectedSha256 !== undefined
      ? normalizeSha256(options.expectedSha256, 'expectedSha256')
      : resolveBundleSha256({ env, settings })
    dir = installDir(home)
    const manifest = readManifest(dir)
    // `upload` installs are local trust decisions; the pin only guards the network.
    const expectedForCache = manifest?.source === 'upload' ? '' : expected
    const cacheUsable = isInstalled(dir, { expectedSha256: expectedForCache }) === true
      && verifyInstalled({ dir, expectedSha256: '' }).ok === true
    const cacheResult = () => {
      const fresh = readManifest(dir) ?? manifest
      return {
        ok: true,
        dir,
        files: fresh === null ? [] : Object.keys(fresh.files),
        fileCount: fresh === null ? 0 : Object.keys(fresh.files).length,
        bytes: 0,
        fromCache: true,
        sha256: fresh?.sha256 ?? '',
        url: fresh?.url ?? urls[0],
        urls,
        tried: [],
        expectedSha256: expected,
        ...(manifest?.source === 'upload' && expected !== '' && String(manifest?.sha256 ?? '') !== expected
          ? { warning: `已安装的组件来自本机上传，其 sha256 与固定值不一致（${manifest?.sha256 ?? '空'} ≠ ${expected}）；按本机信任继续使用` }
          : {}),
      }
    }
    if (force !== true && cacheUsable === true) return cacheResult()
    const tried = []
    for (const url of urls) {
      try {
        return Object.assign(await downloadAndInstall({ home, url, fetchImpl, expectedSha256: expected, env }), { urls, tried, expectedSha256: expected })
      } catch (error) {
        // Keep the machine-readable fields: the route layer maps `hash-mismatch`
        // to its own repair instruction, and needs the expected/actual digests.
        tried.push({
          url,
          error: error?.message ?? String(error),
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          ...(error?.expected !== undefined ? { expected: error.expected } : {}),
          ...(error?.actual !== undefined ? { actual: error.actual } : {}),
        })
      }
    }
    // A failed refresh must not hide a still-usable cache (review B-P2 force 回退).
    if (isInstalled(dir) === true && verifyInstalled({ dir, expectedSha256: '' }).ok === true) {
      const fresh = readManifest(dir)
      return {
        ok: true,
        dir,
        files: fresh === null ? [] : Object.keys(fresh.files),
        fileCount: fresh === null ? 0 : Object.keys(fresh.files).length,
        bytes: 0,
        fromCache: true,
        sha256: fresh?.sha256 ?? '',
        url: fresh?.url ?? urls[0],
        urls,
        tried,
        expectedSha256: expected,
        warning: `刷新失败，继续使用已安装的组件：${tried.map((row) => row.error).join('；')}`,
      }
    }
    // Mirror the last attempt's failure kind at the top level: a digest mismatch is
    // a different repair instruction than "network down" (review A3-P2-7).
    const last = tried[tried.length - 1]
    return {
      ok: false,
      error: tried.map((row) => `${row.url} → ${row.error}`).join('\n'),
      url: urls[0] ?? '',
      urls,
      tried,
      hint: FAILURE_HINT,
      dir,
      expectedSha256: expected,
      ...(typeof last?.code === 'string' ? { code: last.code } : {}),
      ...(last?.expected !== undefined ? { expected: last.expected } : {}),
      ...(last?.actual !== undefined ? { actual: last.actual } : {}),
    }
  } catch (error) {
    let attemptedDir = dir
    if (attemptedDir === '') {
      try {
        attemptedDir = installDir(home)
      } catch {
        attemptedDir = ''
      }
    }
    return {
      ok: false,
      error: error?.message ?? String(error),
      url: urls[0] ?? '',
      urls,
      tried: [],
      hint: FAILURE_HINT,
      dir: attemptedDir,
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(error?.expected !== undefined ? { expected: error.expected } : {}),
      ...(error?.actual !== undefined ? { actual: error.actual } : {}),
    }
  }
}

/** Internals for tests and the server layer (parsing/extraction without I/O). */
export const __test = {
  BUNDLE_FILES,
  BUNDLE_URLS,
  BUNDLE_SHA256,
  BUNDLE_SHA256_ENV,
  BUNDLE_REDIRECT_HOSTS,
  MAX_TGZ_BYTES,
  MAX_TAR_BYTES,
  extractBundle,
  parseTar,
  readOctal,
  tarEntryName,
  isLoopbackHostname,
  normalizeBundleUrl,
  normalizeSha256,
  resolveBundleUrls,
  resolveBundleUrlsSafe,
  resolveBundleSha256,
  resolveBundleSha256Safe,
  allowedDownloadHosts,
  cleanupStaleInstalls,
  verifyInstalled,
  sha256Of,
}
