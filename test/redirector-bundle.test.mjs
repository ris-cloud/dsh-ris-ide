/**
 * Tests for the *downloaded* ProxyBridge distribution used by the redirector.
 *
 * The plugin no longer ships binaries (2.9 MB in `lib/vendor/…` made every install
 * heavy and pinned the upstream version): `lib/proxybridge-bundle.js` downloads or
 * accepts an uploaded `.tgz` into `~/.dsh-ris-ide/proxybridge/bundle`, and this file
 * pins how the lookup uses that cache.
 *
 * Fixtures are built in-process (a tiny ustar writer + gzip), so no test touches
 * the network or the real `~/.dsh-ris-ide`.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fileContent, fetchServing, makeTgz } from './helpers/tgz.mjs'
import { DEFAULT_BUNDLE_URL, bundleLayout, installDir, installFromTgz, isInstalled } from '../lib/proxybridge-bundle.js'

const home = mkdtempSync(join(tmpdir(), 'ris-redirector-home-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home
// These tests serve fixture archives, so the release pin (which guards real
// downloads) is switched off; the pin itself is covered in the bundle module tests.
process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256 = ''

const {
  __test,
  bundledBundleDir,
  bundledRedirectorDir,
  ensureBundleReady,
  prepareWindowsBundle,
  redirectorCandidates,
} = await import('../lib/redirector.js')

const BUNDLE = bundleLayout()
const WINDOWS_FILES = ['ProxyBridge_CLI.exe', 'ProxyBridgeCore.dll', 'WinDivert.dll', 'WinDivert64.sys']
const LICENCES = ['NOTICE.md', 'LICENSE-ProxyBridge.txt']

const bundleTgz = () => makeTgz(BUNDLE.map((rel) => ({
  name: rel,
  content: fileContent(rel),
  mode: /\.(exe|dll|sys|so)$|ProxyBridge$/.test(rel) === true ? 0o755 : 0o644,
})))

const installFixture = () => {
  // A fresh machine starts with no cache; every test proves its own precondition.
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  __test.clearProbeCaches()
  return installFromTgz({ home, bytes: bundleTgz() })
}

test('the plugin no longer ships ProxyBridge binaries', () => {
  assert.deepEqual(bundleLayout(), [
    'LICENSE-ProxyBridge.txt',
    'NOTICE.md',
    'linux/ProxyBridge',
    'linux/libproxybridge.so',
    'windows/ProxyBridgeCore.dll',
    'windows/ProxyBridge_CLI.exe',
    'windows/WinDivert.dll',
    'windows/WinDivert64.sys',
  ])
  // The lookup points at the download cache in the proxy home, never into `lib/`.
  assert.equal(bundledBundleDir(), installDir(home))
  assert.equal(bundledRedirectorDir({ platform: 'linux' }), join(home, 'proxybridge', 'bundle', 'linux'))
  assert.equal(bundledRedirectorDir({ platform: 'win32' }), join(home, 'proxybridge', 'bundle', 'windows'))
})

test('an uninstalled distribution is reported instead of silently skipped', () => {
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  delete process.env.DSH_RIS_IDE_PROXYBRIDGE
  __test.clearProbeCaches()
  const candidates = redirectorCandidates({ side: 'local' })
  assert.equal(candidates.missingBundle, true, 'the candidates know the cache is empty')
  assert.equal(candidates.bundleInstalled, false)
  assert.equal(candidates.bundleDir, installDir(home))
  assert.ok(candidates.includes(join(installDir(home), 'linux', 'ProxyBridge')), 'the expected path is still shown')

  const found = __test.findRedirector({ side: 'local' })
  assert.equal(found.found, false)
  assert.equal(found.missingBundle, true, 'callers must be able to show "download/upload"')
  assert.match(found.reason, /组件未安装/)
  assert.match(found.reason, /维护页/)
  assert.ok(found.reason.includes(DEFAULT_BUNDLE_URL), 'the reason carries the download address')
})

test('an installed cache is the first candidate on both sides', () => {
  installFixture()
  delete process.env.DSH_RIS_IDE_PROXYBRIDGE
  assert.equal(isInstalled(installDir(home)), true)

  const local = redirectorCandidates({ side: 'local' })
  assert.equal(local[0], join(installDir(home), 'linux', 'ProxyBridge'))
  assert.equal(local.missingBundle, false)
  assert.equal(local.bundleInstalled, true)

  const windows = redirectorCandidates({ side: 'windows', platform: 'linux' })
  assert.equal(windows[0], join(installDir(home), 'windows', 'ProxyBridge_CLI.exe'))
  assert.equal(windows.missingBundle, false)
})

test('findRedirector finds the cached CLI without any machine-wide install', () => {
  installFixture()
  delete process.env.DSH_RIS_IDE_PROXYBRIDGE
  const found = __test.findRedirector({ side: 'local' })
  assert.equal(found.found, true)
  assert.equal(found.path, join(installDir(home), 'linux', 'ProxyBridge'))
  assert.equal(found.kind, 'linux-cli')
  assert.equal(found.missingBundle, false)
  assert.equal(found.bundleDir, installDir(home))
})

test('prepareWindowsBundle refuses to point at a path that will never appear', () => {
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  __test.clearProbeCaches()
  assert.equal(prepareWindowsBundle({ platform: 'win32' }), undefined, '未安装 ⇒ undefined（不是空字符串路径）')
})

test('prepareWindowsBundle materialises the cached Windows form plus licences', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-'))
  try {
    assert.equal(prepareWindowsBundle({ platform: 'win32', targetDir: target, force: true }), target)
    for (const name of [...WINDOWS_FILES, ...LICENCES]) {
      assert.ok(existsSync(join(target, name)), `${name} was materialised`)
      assert.equal(statSync(join(target, name)).size, statSync(join(installDir(home), name === 'NOTICE.md' || name === 'LICENSE-ProxyBridge.txt' ? name : `windows/${name}`)).size)
    }
    assert.deepEqual(readdirSync(target).sort(), [...WINDOWS_FILES, ...LICENCES].sort())
    // Second run is a no-op (same size and mtime) and still reports the folder.
    assert.equal(prepareWindowsBundle({ platform: 'win32', targetDir: target, force: true }), target)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a copy with an old timestamp is refreshed even when the size matches', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-stale-'))
  try {
    assert.equal(prepareWindowsBundle({ platform: 'win32', targetDir: target, force: true }), target)
    const copied = join(target, 'ProxyBridge_CLI.exe')
    const source = join(installDir(home), 'windows', 'ProxyBridge_CLI.exe')
    utimesSync(copied, new Date(0), new Date(0))
    assert.equal(prepareWindowsBundle({ platform: 'win32', targetDir: target, force: true }), target)
    const delta = Math.abs(statSync(copied).mtimeMs - statSync(source).mtimeMs)
    assert.ok(delta <= 2000, `the refresh carries the source mtime (delta ${delta}ms)`)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('findRedirector materialises the cached Windows CLI when no platform is pinned', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-auto-'))
  try {
    delete process.env.DSH_RIS_IDE_PROXYBRIDGE
    __test.clearProbeCaches()
    __test.setProbeHooks({ bundleTarget: () => target })
    const found = __test.findRedirector({ side: 'windows' })
    assert.equal(found.found, true, 'a Windows-addressable target must yield a usable CLI')
    assert.equal(found.path, join(target, 'ProxyBridge_CLI.exe'))
    assert.ok(existsSync(found.path), 'the executable really exists')
    assert.equal(found.candidates[0], join(target, 'ProxyBridge_CLI.exe'))
    assert.ok(existsSync(join(target, 'NOTICE.md')), 'the copy carries the licence text')
    assert.equal(found.missingBundle, false)
  } finally {
    __test.resetProbeHooks()
    __test.clearProbeCaches()
    rmSync(target, { recursive: true, force: true })
  }
})

test('a bundle installed while the daemon was down refreshes the Windows copy on the next start', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-restart-'))
  try {
    __test.clearProbeCaches()
    __test.setProbeHooks({ bundleTarget: () => target })
    assert.equal(prepareWindowsBundle(), target)
    const copied = join(target, 'ProxyBridge_CLI.exe')
    assert.equal(readFileSync(copied, 'utf8'), fileContent('windows/ProxyBridge_CLI.exe'))

    // The daemon "restarts": the in-memory materialisation cache is gone, but the
    // marker file next to the copy (and the new bundle on disk) remain.
    __test.clearProbeCaches()
    __test.setProbeHooks({ bundleTarget: () => target })
    const replacement = makeTgz(BUNDLE.map((rel) => ({
      name: rel,
      content: rel === 'windows/ProxyBridge_CLI.exe'
        ? fileContent(rel).replace('fixture', 'FIXTURE')
        : fileContent(rel),
      mode: /\.(exe|dll|sys|so)$|ProxyBridge$/.test(rel) === true ? 0o755 : 0o644,
    })))
    installFromTgz({ home, bytes: replacement })

    assert.equal(prepareWindowsBundle(), target)
    assert.equal(
      readFileSync(copied, 'utf8'),
      fileContent('windows/ProxyBridge_CLI.exe').replace('fixture', 'FIXTURE'),
      'the disk marker must trigger a refresh even with an empty in-memory cache',
    )
  } finally {
    __test.resetProbeHooks()
    __test.clearProbeCaches()
    rmSync(target, { recursive: true, force: true })
  }
})

test('a failed materialisation is not cached: the next call retries', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-retry-'))
  let calls = 0
  try {
    __test.clearProbeCaches()
    __test.setProbeHooks({ bundleTarget: () => (++calls === 1 ? '' : target) })
    assert.equal(prepareWindowsBundle(), '', 'the first run has no Windows-addressable target')
    assert.equal(prepareWindowsBundle(), target, 'the second run retries and succeeds')
    assert.equal(calls, 2)
    // A complete bundle IS cached: the third call must not need the hook again.
    assert.equal(prepareWindowsBundle(), target)
    assert.equal(calls, 2)
  } finally {
    __test.resetProbeHooks()
    __test.clearProbeCaches()
    rmSync(target, { recursive: true, force: true })
  }
})

test('ensureBundleReady is a thin wrapper over the bundle install', async () => {
  // The download/cache/failure semantics themselves are covered by the bundle
  // module tests; here we pin only what this wrapper owns: it downloads into the
  // machine-level proxy home, forwards the machine settings, maps the outcome for
  // the dialog (fromCache/url/error/hint) and never throws.
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  __test.clearProbeCaches()
  delete process.env.DSH_RIS_IDE_PROXYBRIDGE_URL
  const { impl, calls } = fetchServing(bundleTgz())
  const first = await ensureBundleReady({ fetchImpl: impl })
  assert.equal(first.ok, true)
  assert.equal(first.fromCache, false)
  assert.equal(first.dir, installDir(home), 'the download lands in proxyHomeDir(), not a caller path')
  assert.equal(first.url, DEFAULT_BUNDLE_URL)
  assert.equal(isInstalled(installDir(home)), true)
  const second = await ensureBundleReady({ fetchImpl: impl })
  assert.equal(second.ok, true)
  assert.equal(second.fromCache, true, 'the cache must be reused without another request')
  assert.equal(second.dir, first.dir)
  assert.equal(calls.urls.length, 1)

  // A failed download is a value, not a throw, and the wrapper passes the bundle
  // error/hint through to the dialog.
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  __test.clearProbeCaches()
  const failing = async () => ({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) })
  const failed = await ensureBundleReady({ fetchImpl: failing })
  assert.equal(failed.ok, false)
  assert.match(String(failed.error), /HTTP 502/)
  assert.match(String(failed.hint), /检查网络/)

  // The wrapper reads settings.json and forwards it, but URL resolution lives only
  // in `resolveBundleUrls` (env → settings → mirrors), so redirector-side and
  // daemon-side installs agree (review A3-P2-1).
  rmSync(join(home, 'proxybridge'), { recursive: true, force: true })
  __test.clearProbeCaches()
  const settingsPath = join(home, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ proxybridgeUrl: 'https://mirror.example/ris-proxy.tgz' }))
  process.env.DSH_RIS_IDE_PROXYBRIDGE_URL = 'https://env.example/ris-proxy.tgz'
  const envFetch = fetchServing(bundleTgz())
  try {
    const result = await ensureBundleReady({ fetchImpl: envFetch.impl })
    assert.equal(result.ok, true)
    assert.deepEqual(envFetch.calls.urls, ['https://env.example/ris-proxy.tgz'])
  } finally {
    delete process.env.DSH_RIS_IDE_PROXYBRIDGE_URL
    rmSync(settingsPath, { force: true })
  }
})

test('a new bundle refreshes the materialised Windows copy even at the same size', () => {
  installFixture()
  const target = mkdtempSync(join(tmpdir(), 'ris-ide-bundle-refresh-'))
  try {
    __test.clearProbeCaches()
    __test.setProbeHooks({ bundleTarget: () => target })
    assert.equal(prepareWindowsBundle(), target, 'the first bundle is materialised')
    const copied = join(target, 'ProxyBridge_CLI.exe')
    assert.equal(readFileSync(copied, 'utf8'), fileContent('windows/ProxyBridge_CLI.exe'))

    // Same byte count, different content, freshly written source: the size+mtime
    // shortcut alone would keep the old copy (review B-P1-2). Only the bundle
    // fingerprint tells them apart.
    const replacement = makeTgz(BUNDLE.map((rel) => ({
      name: rel,
      content: rel === 'windows/ProxyBridge_CLI.exe'
        ? fileContent(rel).replace('fixture', 'FIXTURE')
        : fileContent(rel),
      mode: /\.(exe|dll|sys|so)$|ProxyBridge$/.test(rel) === true ? 0o755 : 0o644,
    })))
    installFromTgz({ home, bytes: replacement })

    assert.equal(prepareWindowsBundle(), target)
    assert.equal(
      readFileSync(copied, 'utf8'),
      fileContent('windows/ProxyBridge_CLI.exe').replace('fixture', 'FIXTURE'),
      'the Windows copy follows the newly installed bundle',
    )
  } finally {
    __test.resetProbeHooks()
    __test.clearProbeCaches()
    rmSync(target, { recursive: true, force: true })
  }
})

test('windowsArgsOf only translates slash arguments that are existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-args-'))
  const profile = join(dir, 'dsh-ris-ide.pbprofile')
  writeFileSync(profile, '{}')
  try {
    const { windowsArgsOf, windowsPathOf } = __test
    const args = windowsArgsOf([
      '--profile',
      profile,
      '--verbose',
      '2',
      '/d',
      '/p:key=value',
      '/mnt/definitely-missing/x',
      '\\\\wsl.localhost\\Ubuntu\\home\\wangjun\\x',
    ])
    assert.equal(args[1], windowsPathOf(profile), 'an existing file is translated')
    assert.equal(args[4], '/d')
    assert.equal(args[5], '/p:key=value')
    assert.equal(args[6], '/mnt/definitely-missing/x')
    assert.equal(args[7], '\\\\wsl.localhost\\Ubuntu\\home\\wangjun\\x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

process.on('exit', () => {
  delete process.env.DSH_RIS_IDE_PROXY_HOME
  delete process.env.DSH_RIS_IDE_PROXYBRIDGE_SHA256
  rmSync(home, { recursive: true, force: true })
})
