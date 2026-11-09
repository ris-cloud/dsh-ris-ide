/**
 * Tests for the downloaded ProxyBridge bundle (`lib/proxybridge-bundle.js`).
 *
 * The fixtures are built in-process: a tiny ustar writer + gzip gives a real
 * `.tgz`, so the parser is exercised end-to-end without network or binaries.
 * `fetchImpl` is always a stub — these tests never touch the network.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  BUNDLE_SHA256,
  BUNDLE_URLS,
  DEFAULT_BUNDLE_URL,
  __test,
  bundleLayout,
  downloadAndInstall,
  ensureBundle,
  installDir,
  installFromTgz,
  isInstalled,
  manifestPath,
  readManifest,
  resolveBundleSha256,
  resolveBundleSha256Safe,
  resolveBundleUrl,
  resolveBundleUrls,
  resolveBundleUrlsSafe,
  verifyInstalled,
} from '../lib/proxybridge-bundle.js'

const LAYOUT = [
  'LICENSE-ProxyBridge.txt',
  'NOTICE.md',
  'linux/ProxyBridge',
  'linux/libproxybridge.so',
  'windows/ProxyBridgeCore.dll',
  'windows/ProxyBridge_CLI.exe',
  'windows/WinDivert.dll',
  'windows/WinDivert64.sys',
]

const fileContent = (rel) => `fixture bytes for ${rel}\n`
const shaOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Octal field: width-1 digits + NUL, as ustar spells numbers. */
const octalField = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

function tarHeader(name, size, { mode = 0o644, type = '0', linkname = '' } = {}) {
  const header = Buffer.alloc(512, 0)
  const encoded = Buffer.from(name, 'utf8')
  assert.ok(encoded.length <= 100, `fixture name too long: ${name}`)
  encoded.copy(header, 0)
  header.write(octalField(mode, 8), 100, 'ascii')
  header.write(octalField(0, 8), 108, 'ascii') // uid
  header.write(octalField(0, 8), 116, 'ascii') // gid
  header.write(octalField(size, 12), 124, 'ascii')
  header.write(octalField(0, 12), 136, 'ascii') // mtime
  header.write('        ', 148, 'ascii') // checksum placeholder
  header.write(type, 156, 'ascii')
  header.write(linkname < 101 ? linkname : linkname.slice(0, 100), 157, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

/** Build a real `.tgz` from `{name, content?, mode?, type?, linkname?}` entries. */
function makeTgz(entries, { prefix = '' } = {}) {
  const chunks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? fileContent(entry.name))
    chunks.push(tarHeader(`${prefix}${entry.name}`, content.length, entry))
    chunks.push(content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive: two zero blocks
  return gzipSync(Buffer.concat(chunks))
}

const bundleTgz = (extra = []) => makeTgz([
  ...LAYOUT.map((rel) => ({
    name: rel,
    content: fileContent(rel),
    mode: /\.(exe|dll|sys|so)$|ProxyBridge$/.test(rel) === true ? 0o755 : 0o644,
  })),
  ...extra,
])

/**
 * `fetch` stand-in serving one body; `calls` counts invocations.
 * `url` mimics `Response.url` after redirects; `headers` mimics the header bag.
 */
function fetchServing(body, options = {}) {
  const calls = { count: 0 }
  const impl = async (requested) => {
    calls.count += 1
    return {
      ok: true,
      status: 200,
      url: options.url ?? requested,
      headers: options.headers ?? { get: () => null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    }
  }
  return { impl, calls }
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'ris-ide-bundle-home-'))
}

test('bundleLayout lists the eight files the tgz must carry', () => {
  assert.deepEqual(bundleLayout(), LAYOUT)
  // A copy, not the module-level array: callers cannot mutate the contract.
  bundleLayout().push('nope')
  assert.equal(bundleLayout().length, 8)
})

test('resolveBundleUrl prefers the env override, then settings, then the default', () => {
  const env = { DSH_RIS_IDE_PROXYBRIDGE_URL: 'https://example.com/env.tgz' }
  assert.equal(resolveBundleUrl({ env, settings: { proxybridgeUrl: 'https://example.com/settings.tgz' } }), 'https://example.com/env.tgz')
  assert.equal(resolveBundleUrl({ env: {}, settings: { proxybridgeUrl: 'https://example.com/settings.tgz' } }), 'https://example.com/settings.tgz')
  assert.equal(resolveBundleUrl({ env: {}, settings: {} }), DEFAULT_BUNDLE_URL)
  assert.equal(resolveBundleUrl({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: '   ' }, settings: null }), DEFAULT_BUNDLE_URL)
  // Loopback http is what a local test server uses.
  assert.equal(resolveBundleUrl({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'http://127.0.0.1:8123/ris-proxy.tgz' } }), 'http://127.0.0.1:8123/ris-proxy.tgz')
  assert.equal(resolveBundleUrl({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'http://localhost:8123/x.tgz' } }), 'http://localhost:8123/x.tgz')
})

test('resolveBundleUrl rejects plain http outside loopback and malformed URLs', () => {
  assert.throws(() => resolveBundleUrl({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'http://example.com/x.tgz' } }), /https/)
  assert.throws(() => resolveBundleUrl({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'not a url' } }), /不是合法 URL/)
  assert.throws(() => resolveBundleUrl({ env: {}, settings: { proxybridgeUrl: 'ftp://example.com/x.tgz' } }), /https/)
})

test('resolveBundleSha256 pins the release by default and lets env/settings override it', () => {
  assert.equal(resolveBundleSha256({ env: {}, settings: {} }), BUNDLE_SHA256)
  assert.match(BUNDLE_SHA256, /^[0-9a-f]{64}$/)
  const pinned = 'b'.repeat(64)
  assert.equal(resolveBundleSha256({ env: { DSH_RIS_IDE_PROXYBRIDGE_SHA256: pinned }, settings: { proxybridgeSha256: 'c'.repeat(64) } }), pinned)
  assert.equal(resolveBundleSha256({ env: {}, settings: { proxybridgeSha256: 'c'.repeat(64) } }), 'c'.repeat(64))
  // An explicit empty value means "trust on first use", not "fall back to the pin".
  assert.equal(resolveBundleSha256({ env: { DSH_RIS_IDE_PROXYBRIDGE_SHA256: '' }, settings: { proxybridgeSha256: 'c'.repeat(64) } }), '')
  assert.equal(resolveBundleSha256({ env: {}, settings: { proxybridgeSha256: '' } }), '')
  assert.throws(() => resolveBundleSha256({ env: { DSH_RIS_IDE_PROXYBRIDGE_SHA256: 'nope' } }), /sha256/)
  assert.throws(() => resolveBundleSha256({ env: {}, settings: { proxybridgeSha256: 'zz' } }), /sha256/)
})

test('a misconfigured URL or digest degrades to the built-in mirrors for status readers', () => {
  const badUrl = resolveBundleUrlsSafe({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'ftp://example.com/x.tgz' }, settings: {} })
  assert.deepEqual(badUrl.urls, BUNDLE_URLS)
  assert.match(badUrl.error, /https/)

  const goodUrl = resolveBundleUrlsSafe({ env: { DSH_RIS_IDE_PROXYBRIDGE_URL: 'https://example.com/x.tgz' }, settings: {} })
  assert.deepEqual(goodUrl.urls, ['https://example.com/x.tgz'])
  assert.equal(goodUrl.error, '')

  assert.deepEqual(resolveBundleUrls({ env: {}, settings: {} }), BUNDLE_URLS)

  const badSha = resolveBundleSha256Safe({ env: { DSH_RIS_IDE_PROXYBRIDGE_SHA256: 'nope' }, settings: {} })
  assert.equal(badSha.expectedSha256, BUNDLE_SHA256, 'a broken pin falls back to the release pin')
  assert.match(badSha.error, /sha256/)
  assert.equal(resolveBundleSha256Safe({ env: {}, settings: {} }).expectedSha256, BUNDLE_SHA256)
})

test('downloadAndInstall unpacks the layout and records a manifest', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const { impl, calls } = fetchServing(tgz)
    const url = 'https://example.com/ris-proxy.tgz'
    const result = await downloadAndInstall({ home, url, fetchImpl: impl, expectedSha256: shaOf(tgz) })
    assert.equal(result.ok, true)
    assert.equal(result.dir, installDir(home))
    assert.deepEqual(result.files, LAYOUT)
    assert.equal(result.fileCount, 8)
    assert.equal(result.bytes, tgz.length)
    assert.equal(result.fromCache, false)
    assert.equal(calls.count, 1)
    assert.equal(result.sha256, shaOf(tgz))
    assert.equal(isInstalled(result.dir), true)
    assert.equal(verifyInstalled({ dir: result.dir }).ok, true, 'the freshly installed files match their recorded hashes')
    for (const rel of LAYOUT) {
      assert.equal(readFileSync(join(result.dir, ...rel.split('/')), 'utf8'), fileContent(rel), `${rel} bytes`)
    }
    const manifest = readManifest(result.dir)
    assert.equal(manifest.version, 1)
    assert.equal(manifest.url, url)
    assert.equal(manifest.source, 'download')
    assert.equal(manifest.sha256, result.sha256)
    assert.ok(Number.isNaN(Date.parse(manifest.installedAt)) === false)
    assert.deepEqual(Object.keys(manifest.files).sort(), [...LAYOUT].sort())
    assert.deepEqual(Object.keys(manifest.fileHashes).sort(), [...LAYOUT].sort())
    // Binaries are executable, licence text is not.
    assert.notEqual(statSync(join(result.dir, 'linux', 'ProxyBridge')).mode & 0o111, 0)
    assert.equal(statSync(join(result.dir, 'NOTICE.md')).mode & 0o111, 0)
    assert.equal(existsSync(manifestPath(result.dir)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a ./-prefixed archive installs and unknown files/directories are ignored', async () => {
  const home = tempHome()
  try {
    const tgz = makeTgz([
      { name: 'linux/', type: '5', content: '' },
      ...LAYOUT.map((rel) => ({ name: rel })),
      { name: 'README-extra.md' },
    ], { prefix: './' })
    const result = await downloadAndInstall({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: '' })
    assert.equal(result.ok, true)
    assert.equal(isInstalled(result.dir), true)
    assert.equal(existsSync(join(result.dir, 'README-extra.md')), false, 'unknown entries are not extracted')
    assert.equal(existsSync(join(result.dir, 'windows', 'README-extra.md')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pax/global long-name headers are skipped rather than guessed', async () => {
  // GNU pax records a long path in an 'x' entry that precedes the real file; we do
  // not interpret those, so a bundle repacked that way fails closed (missing file)
  // instead of installing a truncated name. Documented behaviour, see review B-P2.
  const home = tempHome()
  try {
    const tgz = makeTgz([
      ...LAYOUT.map((rel) => ({ name: rel })),
      { name: 'PaxHeaders/x', type: 'x', content: '30 path=linux/a-very-long-pax-name\n' },
    ])
    const result = await downloadAndInstall({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: '' })
    assert.equal(result.ok, true, 'the extra pax entry is ignored and the 8 known files still install')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureBundle reuses a valid cache without fetching', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const { impl, calls } = fetchServing(tgz)
    const first = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: shaOf(tgz) })
    assert.equal(first.ok, true)
    assert.equal(first.fromCache, false)
    assert.equal(calls.count, 1)
    const second = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: shaOf(tgz) })
    assert.equal(second.ok, true)
    assert.equal(second.fromCache, true)
    assert.equal(second.dir, first.dir)
    assert.deepEqual(second.files, LAYOUT)
    assert.equal(second.fileCount, 8)
    assert.equal(second.sha256, shaOf(tgz))
    assert.equal(calls.count, 1, 'the cache must short-circuit the download')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the mirror pair is tried in order and the second one can save the install', async () => {
  const home = tempHome()
  try {
    assert.deepEqual(resolveBundleUrls({ env: {}, settings: {} }), [...BUNDLE_URLS])
    assert.ok(BUNDLE_URLS[0].includes('gitee.com'), 'gitee is the primary mirror')
    assert.ok(BUNDLE_URLS[1].includes('github.com'), 'github is the fallback')
    for (const url of BUNDLE_URLS) {
      assert.match(url, /\/releases\/download\/1\.8\.0\/ris-proxy\.4\.0\.tgz$/, 'both mirrors carry the same versioned asset')
    }

    // Gitee 502 → the same bytes are fetched from GitHub and installed.
    const bytes = bundleTgz()
    const calls = []
    const impl = async (url) => {
      calls.push(url)
      if (url === BUNDLE_URLS[0]) return { ok: false, status: 502, url, arrayBuffer: async () => new ArrayBuffer(0) }
      return { ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
    const result = await ensureBundle({ home, fetchImpl: impl, expectedSha256: shaOf(bytes) })
    assert.equal(result.ok, true)
    assert.equal(result.url, BUNDLE_URLS[1])
    assert.equal(result.tried.length, 1)
    assert.match(result.tried[0].error, /502/)
    assert.equal(isInstalled(installDir(home)), true)
    assert.equal(calls.length, 2, 'both mirrors were attempted once')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a bundle that does not match the pinned sha256 is never installed', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const wrong = 'd'.repeat(64)
    const error = await downloadAndInstall({
      home,
      url: 'https://example.com/x.tgz',
      fetchImpl: fetchServing(tgz).impl,
      expectedSha256: wrong,
    }).then(() => null, (thrown) => thrown)
    assert.notEqual(error, null)
    assert.equal(error.code, 'hash-mismatch')
    assert.equal(error.expected, wrong)
    assert.equal(error.actual, shaOf(tgz))
    // Rejected before extraction/write: nothing half-installed on disk.
    assert.equal(existsSync(installDir(home)), false)

    const viaEnsure = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: wrong })
    assert.equal(viaEnsure.ok, false)
    assert.match(viaEnsure.error, /固定 sha256 不一致/)
    // The route layer needs the machine-readable kind and both digests, not just text.
    assert.equal(viaEnsure.code, 'hash-mismatch')
    assert.equal(viaEnsure.expected, wrong)
    assert.equal(viaEnsure.actual, shaOf(tgz))
    assert.equal(viaEnsure.tried[0].code, 'hash-mismatch')
    assert.equal(existsSync(installDir(home)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureBundle reports failures instead of throwing', async () => {
  const home = tempHome()
  try {
    const boom = await ensureBundle({
      home,
      url: 'https://example.com/x.tgz',
      expectedSha256: '',
      fetchImpl: async () => {
        throw new Error('boom')
      },
    })
    assert.equal(boom.ok, false)
    assert.match(boom.error, /boom/)
    assert.equal(boom.url, 'https://example.com/x.tgz')
    assert.equal(typeof boom.hint, 'string')
    assert.equal(boom.dir, installDir(home))
    const http500 = await ensureBundle({
      home,
      url: 'https://example.com/x.tgz',
      expectedSha256: '',
      fetchImpl: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
    })
    assert.equal(http500.ok, false)
    assert.match(http500.error, /HTTP 500/)
    // Nothing half-installed.
    assert.equal(existsSync(installDir(home)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('downloads redirected to an untrusted host are refused', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const error = await downloadAndInstall({
      home,
      url: 'https://example.com/x.tgz',
      fetchImpl: fetchServing(tgz, { url: 'https://evil.example/payload.tgz' }).impl,
      expectedSha256: '',
    }).then(() => null, (thrown) => thrown)
    assert.notEqual(error, null)
    assert.equal(error.code, 'untrusted-host')
    assert.equal(error.host, 'evil.example')
    assert.equal(existsSync(installDir(home)), false)

    // The release-asset host GitHub redirects to is allowed.
    const allowed = await downloadAndInstall({
      home,
      url: 'https://example.com/x.tgz',
      fetchImpl: fetchServing(tgz, { url: 'https://release-assets.githubusercontent.com/github-production-release-asset/x.tgz' }).impl,
      expectedSha256: shaOf(tgz),
    })
    assert.equal(allowed.ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a declared or streamed body over the cap is refused before it is buffered', async () => {
  const home = tempHome()
  try {
    const declared = await downloadAndInstall({
      home,
      url: 'https://example.com/x.tgz',
      fetchImpl: fetchServing(Buffer.alloc(0), {
        headers: { get: (name) => (name === 'content-length' ? String(__test.MAX_TGZ_BYTES + 1) : null) },
      }).impl,
      expectedSha256: '',
    }).then(() => null, (thrown) => thrown)
    assert.notEqual(declared, null)
    assert.equal(declared.code, 'too-large')

    // A streaming body that crosses the cap aborts mid-flight (no arrayBuffer()).
    let pulled = 0
    const streaming = async () => ({
      ok: true,
      status: 200,
      url: 'https://example.com/x.tgz',
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 2; index += 1) {
            pulled += 1
            yield Buffer.alloc(__test.MAX_TGZ_BYTES)
          }
        },
        async cancel() {},
      },
    })
    const streamed = await downloadAndInstall({ home, url: 'https://example.com/x.tgz', fetchImpl: streaming, expectedSha256: '' })
      .then(() => null, (thrown) => thrown)
    assert.notEqual(streamed, null)
    assert.equal(streamed.code, 'too-large')
    assert.equal(pulled, 2, 'the response is cancelled as soon as the cap is crossed')
    assert.equal(existsSync(installDir(home)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a tgz missing a file is rejected and the previous install survives', async () => {
  const home = tempHome()
  try {
    const goodTgz = bundleTgz()
    const good = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(goodTgz).impl, expectedSha256: shaOf(goodTgz) })
    assert.equal(good.ok, true)
    const before = readFileSync(join(good.dir, 'windows', 'ProxyBridge_CLI.exe'), 'utf8')
    const incomplete = makeTgz(LAYOUT.filter((rel) => rel !== 'windows/WinDivert64.sys').map((rel) => ({ name: rel })))
    const failed = await ensureBundle({
      home,
      url: 'https://example.com/x.tgz',
      force: true,
      expectedSha256: '',
      fetchImpl: fetchServing(incomplete).impl,
    })
    // There is still a complete, verified install on disk: a failed forced refresh
    // must keep it usable and say so, instead of reporting the component as missing.
    assert.equal(failed.ok, true)
    assert.equal(failed.fromCache, true)
    assert.match(failed.warning, /缺少文件.*WinDivert64\.sys/)
    assert.equal(isInstalled(installDir(home)), true, 'the previous complete bundle is untouched')
    assert.equal(readFileSync(join(good.dir, 'windows', 'ProxyBridge_CLI.exe'), 'utf8'), before)
    assert.deepEqual(readdirSync(installDir(home)).filter((name) => name.includes('.tmp-')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('path traversal, absolute paths and links are rejected', async () => {
  const home = tempHome()
  try {
    const traversal = makeTgz([...LAYOUT.map((rel) => ({ name: rel })), { name: '../evil', content: 'pwned' }])
    const failed = await ensureBundle({ home, url: 'https://example.com/x.tgz', expectedSha256: '', fetchImpl: fetchServing(traversal).impl })
    assert.equal(failed.ok, false)
    assert.match(failed.error, /不安全|绝对路径/)
    assert.equal(existsSync(installDir(home)), false)

    const absolute = makeTgz([...LAYOUT.map((rel) => ({ name: rel })), { name: '/etc/passwd', content: 'pwned' }])
    const absoluteFailed = await ensureBundle({ home, url: 'https://example.com/x.tgz', expectedSha256: '', fetchImpl: fetchServing(absolute).impl })
    assert.equal(absoluteFailed.ok, false)

    const link = makeTgz([...LAYOUT.map((rel) => ({ name: rel })), { name: 'windows/link', type: '2', content: '', linkname: '../../etc/passwd' }])
    const linkFailed = await ensureBundle({ home, url: 'https://example.com/x.tgz', expectedSha256: '', fetchImpl: fetchServing(link).impl })
    assert.equal(linkFailed.ok, false)
    assert.match(linkFailed.error, /符号链接/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installFromTgz installs an uploaded bundle and records its real digest', () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const result = installFromTgz({ home, bytes: tgz })
    assert.equal(result.ok, true)
    assert.deepEqual(result.files, LAYOUT)
    assert.equal(result.fileCount, 8)
    assert.equal(result.bytes, tgz.length)
    assert.equal(result.sha256, shaOf(tgz))
    assert.equal(result.url, 'upload')
    assert.equal(isInstalled(result.dir), true)
    const manifest = readManifest(result.dir)
    assert.equal(manifest.sha256, shaOf(tgz))
    assert.equal(manifest.source, 'upload')
    assert.equal(verifyInstalled({ dir: result.dir, expectedSha256: shaOf(tgz) }).ok, true)
    assert.equal(readFileSync(join(result.dir, 'windows', 'WinDivert.dll'), 'utf8'), fileContent('windows/WinDivert.dll'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('same-size tampering is caught by verifyInstalled and repaired by ensureBundle', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const { impl, calls } = fetchServing(tgz)
    const result = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: shaOf(tgz) })
    assert.equal(result.ok, true)
    const target = join(result.dir, 'linux', 'ProxyBridge')
    const original = readFileSync(target)
    const tampered = Buffer.from(original)
    tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 0xff
    assert.equal(tampered.length, original.length, 'the fixture stays the same size')
    writeFileSync(target, tampered)

    // Cheap check cannot see it (size unchanged) …
    assert.equal(isInstalled(result.dir), true)
    // … the content check can.
    const verdict = verifyInstalled({ dir: result.dir })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /内容与安装记录不一致/)

    const repaired = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: shaOf(tgz) })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.fromCache, false, 'a corrupt cache must be downloaded again')
    assert.equal(calls.count, 2)
    assert.equal(readFileSync(target).equals(original), true)
    assert.equal(verifyInstalled({ dir: result.dir }).ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('isInstalled notices a changed size or a missing file', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const result = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: shaOf(tgz) })
    assert.equal(isInstalled(result.dir), true)
    appendFileSync(join(result.dir, 'windows', 'WinDivert.dll'), 'x')
    assert.equal(isInstalled(result.dir), false, 'a size change invalidates the cache')
    rmSync(join(result.dir, 'LICENSE-ProxyBridge.txt'))
    assert.equal(isInstalled(result.dir), false, 'a missing file invalidates the cache')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a legacy install without per-file hashes is reported as unverified', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const result = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: shaOf(tgz) })
    assert.equal(result.ok, true)
    const manifest = readManifest(result.dir)
    delete manifest.fileHashes
    writeFileSync(manifestPath(result.dir), JSON.stringify(manifest))
    assert.equal(isInstalled(result.dir), true, 'the cheap check still passes')
    const verdict = verifyInstalled({ dir: result.dir })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /重新安装/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a failed refresh falls back to a still-usable cache', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const first = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: shaOf(tgz) })
    assert.equal(first.ok, true)
    const fallback = await ensureBundle({
      home,
      url: 'https://example.com/x.tgz',
      force: true,
      expectedSha256: shaOf(tgz),
      fetchImpl: async () => {
        throw new Error('offline again')
      },
    })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.fromCache, true)
    assert.match(fallback.warning, /继续使用已安装的组件/)
    assert.equal(isInstalled(fallback.dir), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trust-on-first-use records the digest and reuses it', async () => {
  const home = tempHome()
  try {
    const tgz = bundleTgz()
    const { impl, calls } = fetchServing(tgz)
    const first = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: '' })
    assert.equal(first.ok, true)
    assert.equal(first.sha256, shaOf(tgz))
    const second = await ensureBundle({ home, url: 'https://example.com/x.tgz', fetchImpl: impl, expectedSha256: '' })
    assert.equal(second.ok, true)
    assert.equal(second.fromCache, true)
    assert.equal(calls.count, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('abandoned staging directories are collected, recent ones are left alone', async () => {
  const home = tempHome()
  try {
    const dir = installDir(home)
    const parent = dirname(dir)
    mkdirSync(parent, { recursive: true })
    const stale = `${dir}.tmp-999999`
    const fresh = `${dir}.old-999998`
    mkdirSync(stale, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(stale, 'leftover'), 'x')
    writeFileSync(join(fresh, 'leftover'), 'x')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(fresh, old, old)
    // Fresh (within the hour) staging is NOT removed: another process may still be
    // writing it. Touching it with "now" simulates that.
    const now = new Date()
    utimesSync(fresh, now, now)

    const tgz = bundleTgz()
    const result = await downloadAndInstall({ home, url: 'https://example.com/x.tgz', fetchImpl: fetchServing(tgz).impl, expectedSha256: shaOf(tgz) })
    assert.equal(result.ok, true)
    assert.equal(existsSync(stale), false, 'an hour-old staging directory is collected')
    assert.equal(existsSync(fresh), true, 'a recent staging directory is left for its owner')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('__test exposes the tar parsing helpers without touching the disk', () => {
  assert.equal(typeof __test.parseTar, 'function')
  assert.equal(typeof __test.extractBundle, 'function')
  assert.equal(typeof __test.sha256Of, 'function')
  assert.equal(typeof __test.verifyInstalled, 'function')
  assert.equal(typeof __test.resolveBundleSha256, 'function')
  assert.equal(typeof __test.cleanupStaleInstalls, 'function')
  assert.throws(() => __test.extractBundle(Buffer.from('not gzip')), /gzip/)
  assert.throws(() => __test.extractBundle(Buffer.alloc(__test.MAX_TGZ_BYTES + 1)), /过大/)
})

test('ensureBundle resolves the URL from settings when none is passed', async () => {
  const home = tempHome()
  try {
    const failed = await ensureBundle({
      home,
      settings: { proxybridgeUrl: 'https://example.com/from-settings.tgz' },
      expectedSha256: '',
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.url, 'https://example.com/from-settings.tgz')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('downloadAndInstall rejects an https-less URL before fetching', async () => {
  let fetched = 0
  await assert.rejects(
    () => downloadAndInstall({ home: tempHome(), url: 'http://example.com/x.tgz', fetchImpl: async () => { fetched += 1 } }),
    /https/,
  )
  assert.equal(fetched, 0, 'the URL is validated before any request')
})
