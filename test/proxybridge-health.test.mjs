import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SIDE_FILES, collectProxyBridgeHealth, createHealthCache } from '../lib/proxybridge-health.js'

function seedBundle() {
  const home = mkdtempSync(join(tmpdir(), 'pb-health-'))
  const dir = join(home, 'proxybridge', 'bundle')
  for (const files of Object.values(SIDE_FILES)) {
    for (const relative of files) {
      const path = join(dir, relative)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'x')
    }
  }
  return home
}

test('both sides are healthy when every file exists and each CLI answers --version (m11828)', async () => {
  const home = seedBundle()
  const calls = []
  try {
    const health = await collectProxyBridgeHealth({
      home,
      engineRunning: true,
      // Windows cannot launch an exe from the Linux filesystem: the probe targets the
      // copy under %LOCALAPPDATA% (here a fake Windows path).
      windowsExe: 'C:\\Users\\demo\\AppData\\Local\\dsh-ris-ide\\proxybridge\\windows\\ProxyBridge_CLI.exe',
      run: async (command, args) => {
        calls.push([command, args.at(-1) ?? ''])
        return 'ProxyBridge 4.3.0\n'
      },
    })
    assert.equal(health.ok, true)
    assert.equal(health.installed, true)
    assert.equal(health.sides.linux.version, '4.3.0')
    assert.equal(health.sides.windows.version, '4.3.0')
    assert.equal(health.engineRunning, true)
    // Windows binaries cannot be launched straight from the Linux filesystem.
    assert.ok(calls.some(([command]) => command === 'powershell.exe'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing file or an unrunnable CLI is reported per side, not as a dead card', async () => {
  const home = seedBundle()
  try {
    rmSync(join(home, 'proxybridge', 'bundle', 'windows', 'WinDivert.dll'))
    const health = await collectProxyBridgeHealth({
      home,
      engineRunning: true,
      windowsExe: 'C:\\fake\\ProxyBridge_CLI.exe',
      run: async (command) => (command === 'powershell.exe' ? 'boom: missing DLL' : 'ProxyBridge 4.0.0'),
    })
    assert.equal(health.ok, false)
    assert.equal(health.sides.linux.ok, true)
    assert.equal(health.sides.windows.ok, false)
    assert.ok(health.sides.windows.files.missing.includes('bundle/windows/WinDivert.dll'))
    assert.match(health.sides.windows.checks.find((check) => check.id === 'runs').detail, /boom/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a single-sided host is healthy, not broken (m12019)', async () => {
  const home = seedBundle()
  const run = async () => 'ProxyBridge 4.0.0'
  try {
    const linuxOnly = await collectProxyBridgeHealth({ home, engineRunning: true, linuxApplicable: true, windowsApplicable: false, run })
    assert.equal(linuxOnly.ok, true, 'one side is enough')
    assert.equal(linuxOnly.sides.windows.applicable, false)
    assert.equal(linuxOnly.sides.windows.ok, true, 'a skipped side is neutral')
    assert.match(linuxOnly.sides.windows.note, /没有 Windows 侧/)

    const windowsOnly = await collectProxyBridgeHealth({ home, engineRunning: true, linuxApplicable: false, windowsApplicable: true, windowsExe: 'C:\\fake\\ProxyBridge_CLI.exe', run })
    assert.equal(windowsOnly.ok, true)
    assert.equal(windowsOnly.sides.linux.applicable, false)

    // Installed, but the Windows copy has not been materialised yet (first start of
    // the bridge prepares it): that is "not prepared", not "broken".
    const notPrepared = await collectProxyBridgeHealth({ home, engineRunning: true, linuxApplicable: true, windowsApplicable: true, windowsPrepared: false, run })
    assert.equal(notPrepared.ok, true)
    assert.equal(notPrepared.sides.windows.skipped, true)
    assert.match(notPrepared.sides.windows.note, /尚未复制/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the health cache answers from memory unless forced', async () => {
  const home = seedBundle()
  let probes = 0
  try {
    const cache = createHealthCache()
    const run = async () => { probes += 1; return 'ProxyBridge 4.0.0' }
    const windowsExe = 'C:\\fake\\ProxyBridge_CLI.exe'
    const first = await cache.get({ home, engineRunning: true, run, windowsExe })
    assert.equal(first.cached, false)
    const second = await cache.get({ home, engineRunning: true, run, windowsExe })
    assert.equal(second.cached, true)
    assert.equal(probes, 2, 'two sides probed once, then served from the cache')
    // Applicability decides WHAT is probed, so a host shape with one side must not
    // reuse the other shape's snapshot (review A4-P1-1).
    const linuxOnly = await cache.get({ home, engineRunning: true, run })
    assert.equal(linuxOnly.cached, false, 'a different applicability set is a cache miss')
    assert.equal(probes, 3, 'with no Windows exe only the Linux side runs')
    await cache.get({ home, engineRunning: true, force: true, run, windowsExe })
    assert.equal(probes, 5, 'force re-probes both sides')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
