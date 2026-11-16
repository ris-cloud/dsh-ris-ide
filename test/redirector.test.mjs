/**
 * Redirector (ProxyBridge) adapter tests.
 *
 * The interesting half is the mapping: our rule table is program + hosts + ports,
 * and it has to come out as a `.pbprofile` ProxyBridge accepts — a wrong process
 * pattern silently routes nothing, so each shape is pinned here.
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { engineSide } from '../lib/proxy.js'
import { HAS_WSLPATH, skipWithout } from './helpers/cmd.mjs'

const home = mkdtempSync(join(tmpdir(), 'ris-redirector-home-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

// `spawnDetachedText` unrefs its timeout and its child on purpose (a launcher that
// outlives its caller must not hold the daemon open). Those handles can be the ONLY
// thing a waiting test has, and on node 20/22 the test runner keeps no handle of its
// own: the loop runs dry, the pending `await` never settles and every later test in
// the file is cancelled with "Promise resolution is still pending but the event loop
// has already resolved". node 24 happens to keep the runner referenced, which is why
// this only failed in CI. Hold ONE referenced timer for the file; the after hook
// releases it so the runner can still exit.
const keepLoopAlive = setInterval(() => { /* keep the loop referenced (see above) */ }, 1000)
after(() => clearInterval(keepLoopAlive))

const { __test } = await import('../lib/redirector.js')

/**
 * CI runs this suite on a plain Linux host (a k8s pod): no WSL, no `wslpath`, no
 * Windows side — so `windowsPathOf` cannot answer there and the two watchdog
 * tests could only ever run on a developer's WSL machine. On such a host we
 * inject the mapping the WSL box would have produced; production still asks
 * `wslpath` (`test/redirector.test.mjs` is the only caller of this seam).
 */
const WSL_DISTRO = 'Ubuntu'
if (engineSide() !== 'wsl') {
  __test.setWindowsPathTranslator((path) => {
    const text = String(path)
    if (text.startsWith('/') !== true) return ''
    return `\\\\wsl.localhost\\${WSL_DISTRO}${text.replace(/\//g, '\\')}`
  })
}

/**
 * Every probe that could reach the real Windows side is stubbed for the whole
 * file. A test run must never enumerate, kill or elevate the user's actual
 * ProxyBridge_CLI — it is running next to us, and "clean up" would take it down.
 */
const BASE_HOOKS = {
  windowsPids: () => [],
  localProc: () => 0,
  windowsPidsAsync: async () => [],
  windowsAlive: () => false,
  windowsAliveAsync: async () => false,
  taskkill: () => 'ERROR: Access is denied.',
}
__test.setProbeHooks(BASE_HOOKS)
process.on('exit', () => { __test.resetProbeHooks(); __test.setWindowsPathTranslator(null) })
/** Use one extra stub for a single test, then fall back to the safe defaults. */
const useHooks = (hooks) => {
  __test.resetProbeHooks()
  __test.setProbeHooks({ ...BASE_HOOKS, ...hooks })
  __test.clearProbeCaches()
}


const config = (rules, extra = {}) => ({
  socks: { host: '10.3.91.121', port: 1080 },
  listenPort: 11081,
  rules,
  ...extra,
})

test('a Windows command line never carries a WSL-only /mnt path', async () => {
  const { windowsPathOf, redirectorCommand } = await import('../lib/redirector.js')
  // Fabricated drive so the assertion does not depend on this machine's layout:
  // wslpath cannot resolve it, which also exercises the drive-letter fallback.
  const exe = windowsPathOf('/mnt/x/Program Files/ProxyBridge/ProxyBridge_CLI.exe')
  assert.match(exe, /^X:\\Program Files\\ProxyBridge\\ProxyBridge_CLI\.exe$/,
    'Start-Process cannot resolve /mnt paths: they are WSL-only')
  const already = 'D:\\apps\\ProxyBridge_CLI.exe'
  assert.equal(windowsPathOf(already), already, 'an already-Windows path is left alone')
  // Only arguments that are existing files are treated as paths (a `/d` or
  // `/p:key=value` switch is not), so the profile has to exist here — exactly the
  // situation at runtime, where writeRedirectorProfile just wrote it.
  const profileDir = mkdtempSync(join(tmpdir(), 'ris-ide-plan-'))
  const profile = join(profileDir, 'dsh-ris-ide.pbprofile')
  writeFileSync(profile, '{}')
  const plan = redirectorCommand({
    cliPath: '/mnt/x/Program Files/ProxyBridge/ProxyBridge_CLI.exe',
    profilePath: profile,
    platform: 'win32',
    // The translation rule is what is under test here, not whether THIS machine
    // has a Windows side: on a plain-Linux CI host `engineSide()` is 'linux' and
    // the default gate would keep `/mnt` in the command line.
    translate: true,
  })
  assert.equal(plan.display.includes('/mnt/'), false, 'no mnt path may survive in the Windows command')
  assert.ok(plan.display.includes('X:\\Program Files'), 'the executable must be spelled the Windows way')
  const linux = redirectorCommand({ cliPath: '/mnt/x/vendor/ProxyBridge', profilePath: '/mnt/x/p.pbprofile', platform: 'linux' })
  assert.equal(linux.command, 'sudo', 'the Linux side stays a sudo command')
  assert.ok(linux.display.includes('/mnt/x/p.pbprofile'), 'Linux keeps its own paths')
})

test('rule table becomes ProxyBridge rules', () => {
  const { profile, rules } = __test.buildProfile(config([
    { id: 'java', program: 'java', hosts: '172.20.235.*', ports: '1521, 6890', enabled: true, workspace: '/ws' },
  ]))
  assert.equal(profile.Version, '1.0')
  assert.equal(profile.ProxyConfigs.length, 1)
  assert.equal(profile.ProxyConfigs[0].Type, 'SOCKS5')
  assert.equal(profile.ProxyConfigs[0].Host, '10.3.91.121')
  assert.equal(profile.ProxyConfigs[0].SendDomainToProxy, true, 'let the proxy resolve names')
  assert.equal(rules.length, 1)
  // Bare names must match the image name on both sides: java.exe on Windows, java on Linux.
  assert.equal(rules[0].ProcessName, '*java*')
  assert.equal(rules[0].TargetHosts, '172.20.235.*')
  assert.equal(rules[0].TargetPorts, '1521,6890', 'whitespace is removed: the CLI parses a bare list')
  assert.equal(rules[0].Action, 'PROXY')
  // The GUI's own export omits the key and ProxyBridge defaults it to false, so we
  // do not invent it; what matters is that nothing here routes loopback traffic.
  assert.equal('LocalhostViaProxy' in rules[0], false)
  assert.equal('TargetDomains' in rules[0], false, 'a "*" domain would drop bare-IP targets')
  assert.equal(rules[0].ProxyConfigId, profile.ProxyConfigs[0].Id)
})

test('a blank axis is NOT "anything": the rule is skipped until it is filled', () => {
  // A blank host/port used to be coerced to `*`, which silently proxied the whole
  // internet for a half-written row. "Everything" must be typed as `*`; a blank
  // axis means the rule does not apply at all.
  const blank = __test.buildProfile(config([
    { id: 'git', program: 'git', hosts: '', ports: '', enabled: true },
  ]))
  assert.deepEqual(blank.rules, [])
  assert.match(blank.skipped.join(' '), /缺 IP/)

  const explicit = __test.buildProfile(config([
    { id: 'git', program: 'git', hosts: '*', ports: '*', enabled: true },
  ]))
  assert.equal(explicit.rules[0].TargetHosts, '*')
  assert.equal(explicit.rules[0].TargetPorts, '*')
})

test('a path-shaped program is pinned to its directory', () => {
  assert.equal(__test.processPattern('navicat.exe'), 'navicat.exe')
  assert.equal(__test.processPattern('D:\\Program Files\\YonCode\\devkit\\jdk21\\bin\\java.exe'),
    'D:\\Program Files\\YonCode\\devkit\\jdk21\\bin\\*.exe')
  assert.equal(__test.processPattern('/opt/jdk/bin/java'), '/opt/jdk/bin/*')
  assert.equal(__test.processPattern(''), '')
})

test('disabled and program-less rules are skipped, not silently emptied', () => {
  const { rules, skipped } = __test.buildProfile(config([
    { id: 'off', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: false },
    { id: 'empty', program: '', hosts: '1.2.3.4', ports: '443', enabled: true },
    { id: 'on', program: 'curl', hosts: '1.2.3.4', ports: '443', enabled: true },
  ]))
  assert.deepEqual(rules.map((rule) => rule.Name), ['on'])
  assert.equal(skipped.length, 2)
})

test('the engine can be the upstream instead of the SOCKS server', () => {
  const { profile } = __test.buildProfile(config([
    { id: 'java', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: true },
  ]), { upstream: 'engine' })
  assert.equal(profile.ProxyConfigs[0].Type, 'HTTP')
  assert.equal(profile.ProxyConfigs[0].Host, '127.0.0.1')
  assert.equal(profile.ProxyConfigs[0].Port, '11081')
  assert.equal(profile.ProxyConfigs[0].SendDomainToProxy, false)
})

test('the profile is written private, and an empty one is refused', () => {
  const path = join(home, 'proxybridge', 'custom.pbprofile')
  const written = __test.writeRedirectorProfile(config([
    { id: 'java', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: true },
  ]), { path })
  assert.equal(written.rules, 1)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'may hold a proxy password')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).ProxyRules.length, 1)
  assert.throws(() => __test.writeRedirectorProfile(config([
    { id: 'off', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: false },
  ]), { path: join(home, 'proxybridge', 'empty.pbprofile') }), /至少一条/)
})

test('the start command carries the elevation requirement of each platform', () => {
  const linux = __test.redirectorCommand({ cliPath: '/x/ProxyBridge', profilePath: '/y/p.pbprofile', platform: 'linux' })
  assert.equal(linux.command, 'sudo')
  assert.deepEqual(linux.args.slice(0, 2), ['/x/ProxyBridge', '--profile'])
  assert.equal(linux.needsElevation, true)
  const windows = __test.redirectorCommand({ cliPath: 'C:\\pb\\ProxyBridge_CLI.exe', profilePath: 'C:\\p\\p.pbprofile', platform: 'win32' })
  assert.equal(windows.command, 'C:\\pb\\ProxyBridge_CLI.exe', 'Windows elevates the launch, not the command')
  assert.equal(windows.needsElevation, true)
})

test('detection reports the two sides independently', () => {
  // The distribution is downloaded into ~/.dsh-ris-ide/proxybridge/bundle; when it
  // is not installed yet a machine-wide (manually extracted / packaged) copy is
  // still honoured, which is what this test pins.
  const vendor = __test.redirectorVendorDir({ platform: 'linux' })
  mkdirSync(vendor, { recursive: true })
  const fake = join(vendor, 'ProxyBridge')
  writeFileSync(fake, '#!/bin/sh\necho "ProxyBridge CLI V9.9.9"\n', { encoding: 'utf8' })
  chmodSync(fake, 0o755)
  try {
    __test.clearProbeCaches()
    const status = __test.redirectorStatus()
    assert.equal(status.local.available, true)
    assert.equal(status.local.kind, 'linux-cli')
    assert.equal(status.local.path, fake, 'the machine-wide fallback is used when no download exists')
    assert.match(String(status.local.version), /^\d+\.\d+\.\d+$/)
    // Windows side depends on the machine, so only its shape is checked.
    assert.equal(typeof status.windows.available, 'boolean')
    assert.equal(typeof status.windows.path, 'string')
  } finally {
    rmSync(fake, { force: true })
  }
})

test('an explicit override wins over every search path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-redirector-cli-'))
  const cli = join(dir, 'ProxyBridge')
  writeFileSync(cli, '#!/bin/sh\necho "x V1.2.3"\n', { encoding: 'utf8' })
  chmodSync(cli, 0o755)
  process.env.DSH_RIS_IDE_PROXYBRIDGE = cli
  try {
    const found = __test.findRedirector({ side: 'local' })
    assert.equal(found.found, true)
    assert.equal(found.path, cli)
  } finally {
    delete process.env.DSH_RIS_IDE_PROXYBRIDGE
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the pid file records which side owns the process', () => {
  // A Windows redirector cannot be signalled from WSL: stop goes through
  // taskkill, so the record has to say 'windows' or the wrong killer is used.
  __test.writeRedirectorPid(4321, 'windows')
  assert.deepEqual(__test.redirectorPidRecord(), { pid: 4321, side: 'windows' })
  __test.writeRedirectorPid(4321)
  assert.deepEqual(__test.redirectorPidRecord(), { pid: 4321, side: 'local' })
  __test.clearRedirectorPid()
  assert.deepEqual(__test.redirectorPidRecord(), { pid: 0, side: 'local' })
})

test('stopping a redirector that is not running is a no-op, not a throw', () => {
  __test.clearRedirectorPid()
  assert.deepEqual(__test.stopRedirectorSync(), { stopped: false, reason: '未在运行' })
})

test('a missing override falls back to the machine-wide copy', () => {
  // The explicit override is only a preference: a stale path must not hide a real
  // installation (the downloaded cache replaces the old in-repo vendor folder).
  const vendor = __test.redirectorVendorDir({ platform: 'linux' })
  mkdirSync(vendor, { recursive: true })
  const fake = join(vendor, 'ProxyBridge')
  writeFileSync(fake, '#!/bin/sh\necho "x V1.0.0"\n', { encoding: 'utf8' })
  chmodSync(fake, 0o755)
  const real = process.env.DSH_RIS_IDE_PROXYBRIDGE
  process.env.DSH_RIS_IDE_PROXYBRIDGE = join(home, 'proxybridge', 'vendor', 'linux', 'missing-ProxyBridge')
  try {
    __test.clearProbeCaches()
    const found = __test.findRedirector({ side: 'local' })
    assert.equal(found.found, true)
    assert.equal(found.path, fake)
  } finally {
    if (real === undefined) delete process.env.DSH_RIS_IDE_PROXYBRIDGE
    else process.env.DSH_RIS_IDE_PROXYBRIDGE = real
    rmSync(fake, { force: true })
  }
})

test('discovery separates the pid file from a hand-started process', () => {
  // The user pastes the sudo command, so nothing writes our pid file; the /proc
  // scan is what stops the dialog from claiming "not running".
  __test.clearRedirectorPid()
  useHooks({})
  const found = __test.detectRunningRedirector()
  // per side + the aggregate: one pid cannot describe two machines (M1)
  assert.deepEqual(Object.keys(found).sort(), ['local', 'pid', 'side', 'source', 'windows'])
  assert.ok(['', 'pidfile', 'proc', 'process'].includes(found.source), `unexpected source: ${found.source}`)
  assert.equal(typeof found.local.pid, 'number')
  assert.equal(typeof found.windows.pid, 'number')
  const status = __test.redirectorStatus()
  assert.equal(typeof status.runningSource, 'string', 'the view says HOW it was found')
  assert.equal(status.running, found.pid > 0)
  assert.equal(typeof status.runningWindows, 'boolean', 'the view separates the two sides')
})

test('a pid file that names a dead process is not "running"', () => {
  const dir = join(home, 'proxybridge')
  mkdirSync(dir, { recursive: true })
  __test.writeRedirectorPid(999999)
  assert.equal(__test.redirectorPid(), 0)
  __test.clearRedirectorPid()
  assert.equal(existsSync(join(dir, 'proxybridge.local.pid')), false)
})

test('each side keeps its own pid record (M1)', () => {
  useHooks({})
  __test.clearRedirectorPid()
  __test.writeRedirectorPid(100, 'local')
  __test.writeRedirectorPid(200, 'windows')
  // One shared file made the second start erase the first side's pid: the engine
  // then ran on with nothing pointing at it.
  assert.deepEqual(__test.redirectorPidRecord('local'), { pid: 100, side: 'local' })
  assert.deepEqual(__test.redirectorPidRecord('windows'), { pid: 200, side: 'windows' })
  assert.equal(existsSync(__test.redirectorSidePidPath('local')), true)
  assert.equal(existsSync(__test.redirectorSidePidPath('windows')), true)
  __test.clearRedirectorPid('windows')
  assert.deepEqual(__test.redirectorPidRecord('windows'), { pid: 0, side: 'windows' })
  assert.deepEqual(__test.redirectorPidRecord('local'), { pid: 100, side: 'local' })
  __test.clearRedirectorPid()
})

test('the old single pid file is migrated to the side it names (M1)', () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const dir = join(home, 'proxybridge')
  mkdirSync(dir, { recursive: true })
  __test.clearRedirectorPid()
  writeFileSync(join(dir, 'proxybridge.pid'), '777 windows\n')
  useHooks({})
  __test.detectRunningRedirector()
  assert.equal(existsSync(join(dir, 'proxybridge.windows.pid')), true, 'the side is kept, not defaulted to local')
  assert.equal(existsSync(join(dir, 'proxybridge.pid')), false, 'one record, not two that can disagree')
  __test.clearRedirectorPid()
})

// 纯 Linux（Jenkins 裸镜像）用上面的接缝；WSL 上必须真有 wslpath 才能算 Windows 路径。
const WINDOWS_SIDE = engineSide() !== 'wsl' || HAS_WSLPATH

test('the parked-service state has ONE path shared by writer and watchdog (B2)', { skip: skipWithout(WINDOWS_SIDE, 'wslpath') }, async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  const canonical = __test.serviceStatePath()
  assert.equal(canonical, join(__test.redirectorHome(), 'proxybridge-service.json'))
  const legacy = join(home, 'proxybridge-service.json')
  mkdirSync(__test.redirectorHome(), { recursive: true })
  rmSync(canonical, { force: true })
  writeFileSync(legacy, JSON.stringify({ stoppedByUs: true, originalStartType: 'Automatic' }))
  __test.migrateLegacyServiceState()
  assert.equal(existsSync(canonical), true, 'the watchdog reads the canonical path')
  assert.equal(existsSync(legacy), false, 'leaving the old copy behind makes two readers disagree')
  // The teardown must read exactly the file we write, or Set-Service/Start-Service
  // never runs and ProxyBridgeSvc stays parked on Manual forever.
  mod.writeWatchdogScript()
  const script = readFileSync(join(home, 'proxybridge-watchdog.ps1'), 'utf8')
  assert.ok(script.includes(mod.windowsPathOf(canonical)), 'watchdog state file != writer state file')
  rmSync(canonical, { force: true })
})

test('a reload reports success only when the new process is proven (B4)', async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  __test.writeWatchdogPid(process.pid)
  try {
    // The watchdog says ok but the pid it names is not alive: that is a failure.
    useHooks({
      requestReload: ({ id }) => {
        writeFileSync(__test.reloadDonePath(), JSON.stringify({ ok: true, id, pid: 424242, count: 1 }))
        return true
      },
    })
    const dead = await __test.reloadRedirector({ side: 'windows', timeoutMs: 1500 })
    assert.equal(dead.reloaded, false)
    assert.match(dead.reason, /已不在运行/)

    // A structured done naming a live new process: success, and the NEW pid is
    // recorded (M2) — keeping the old one made stop aim at a dead process.
    const mod = await import('../lib/redirector.js')
    mod.writeCliSpec({ exe: 'C:\\pb\\ProxyBridge_CLI.exe', args: ['--profile', 'C:\\p.pbprofile'], log: 'C:\\log.txt' })
    useHooks({
      windowsAlive: (pid) => pid === 3001,
      windowsAliveAsync: async (pid) => pid === 3001,
      requestReload: ({ id }) => {
        writeFileSync(__test.reloadDonePath(), JSON.stringify({ ok: true, id, pid: 3001, count: 1 }))
        return true
      },
    })
    const ok = await __test.reloadRedirector({ side: 'windows', timeoutMs: 1500 })
    assert.equal(ok.reloaded, true)
    assert.equal(ok.pid, 3001)
    assert.deepEqual(__test.redirectorPidRecord('windows'), { pid: 3001, side: 'windows' })

    // A failed watchdog report is surfaced instead of the old unconditional "done".
    useHooks({
      requestReload: ({ id }) => {
        writeFileSync(__test.reloadFailedPath(), JSON.stringify({ ok: false, id, pid: 0, error: 'no cli spec' }))
        return true
      },
    })
    const failed = await __test.reloadRedirector({ side: 'windows', timeoutMs: 1500 })
    assert.equal(failed.reloaded, false)
    assert.match(failed.reason, /重载失败.*no cli spec/)

    // Silence is not success either.
    useHooks({ requestReload: () => true })
    const timeout = await __test.reloadRedirector({ side: 'windows', timeoutMs: 400 })
    assert.equal(timeout.reloaded, false)
    assert.match(timeout.reason, /未在 \d+s 内完成重载/)
  } finally {
    useHooks({})
  }
})

test('stopping something we did not record reports it instead of "未在运行" (B5)', () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  __test.clearRedirectorPid()
  // A hand-started CLI is visible on the Windows side but has no pid file; the old
  // stop killed nothing and still answered stopped:true, so the user believed the
  // interception was gone.
  useHooks({ windowsPids: () => [5555], windowsAlive: (pid) => pid === 5555 })
  try {
    const result = __test.stopRedirectorSync({ graceMs: 100 })
    assert.equal(result.stopped, false, 'taskkill failed: the process is still there')
    assert.match(String(result.reason), /检测到进程但不在记录中|管理员权限/)
  } finally {
    useHooks({})
    __test.clearRedirectorPid()
  }
})

test('the elevated helper rejects output from a previous run (B1)', async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const localPath = join(home, 'dsh-ris-elevated.out')
  writeFileSync(localPath, '@RUN pid=6432;alive=True\n')
  let presentBeforeLaunch = null
  // The stale file belongs to a previous run; it must be gone before the launch,
  // and if a late writer brings it back the nonce must reject it.
  const stale = await __test.psElevated('Write-Output hi', 700, {
    localPath,
    windowsPath: 'C:\\stale.out',
    nonce: 'fresh',
    pollMs: 50,
    launch: () => {
      presentBeforeLaunch = existsSync(localPath)
      writeFileSync(localPath, '@RUN pid=6432;alive=True\npid=6432;alive=True\n')
      return ''
    },
  })
  assert.equal(presentBeforeLaunch, false, 'a leftover answer must never be read as this run')
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /上一轮/)

  const fresh = await __test.psElevated('Write-Output hi', 700, {
    localPath,
    windowsPath: 'C:\\fresh.out',
    nonce: 'good',
    pollMs: 50,
    launch: () => {
      writeFileSync(localPath, '@RUN good\npid=12;alive=True\n')
      return ''
    },
  })
  assert.equal(fresh.ok, true)
  assert.match(fresh.output, /pid=12/)
})

test('status probes are cached and the async variant never blocks (M3)', async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  let syncCalls = 0
  useHooks({ windowsPids: () => { syncCalls += 1; return [] } })
  try {
    __test.redirectorStatus()
    __test.redirectorStatus()
    assert.equal(syncCalls, 1, 'two renders inside the TTL must not probe twice')
    __test.clearProbeCaches()
    __test.redirectorStatus()
    assert.equal(syncCalls, 2, 'a cleared cache probes again')
    // The async route must never touch the blocking probe.
    useHooks({
      windowsPids: () => { throw new Error('sync probe used by the async path') },
      windowsPidsAsync: async () => [],
    })
    const first = await __test.redirectorStatusAsync()
    assert.equal(first.cached, false)
    const second = await __test.redirectorStatusAsync()
    assert.equal(second.cached, true, 'the second call inside the TTL is a cache hit')
  } finally {
    useHooks({})
  }
})

test('reloadRedirectorsWithProfile writes the profile before reloading (B3 helper)', async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  useHooks({})
  try {
    const refused = await __test.reloadRedirectorsWithProfile(home, {
      sides: ['windows', 'local'],
    })
    assert.equal(refused.ok, false)
    assert.match(String(refused.reason), /规则未能写入/)
    assert.equal(refused.written, null)

    writeFileSync(join(home, 'proxy.json'), JSON.stringify(config([
      { id: 'java', program: 'java', hosts: '10.0.0.1', ports: '443', enabled: true },
    ])))
    const idle = await __test.reloadRedirectorsWithProfile(home, { sides: ['windows', 'local'] })
    assert.equal(idle.written.rules, 1)
    // Nothing is running here: the helper says why instead of claiming a restart.
    assert.equal(idle.ok, false)
    assert.deepEqual(idle.skipped.map((item) => item.side).sort(), ['local', 'windows'])
  } finally {
    rmSync(join(home, 'proxy.json'), { force: true })
    useHooks({})
  }
})

test('the profile names a rule by its label so the ProxyBridge console stays readable', () => {
  const labelled = __test.buildProfile(config([
    { id: 'yds-yoncode-java', label: 'YonCode java', program: 'java', hosts: '172.20.235.*', ports: '*', enabled: true },
  ]))
  assert.equal(labelled.profile.ProxyRules[0].Name, 'YonCode java')
  const plain = __test.buildProfile(config([
    { id: 'yds-java', program: 'java', hosts: '10.0.0.*', ports: '*', enabled: true },
  ]))
  assert.equal(plain.profile.ProxyRules[0].Name, 'yds-java')
})

test('a stale stop marker never answers the next stop request (B-P2-7)', async () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  // The watchdog wrote "done" for an earlier stop; nothing has been asked for the
  // new one yet, so a plain "does the file exist" read would report success while
  // the CLI is still intercepting.
  writeFileSync(mod.stoppedMarkerPath(), 'done\n')
  assert.equal(mod.stopCompleted(), true)
  assert.equal(mod.requestRedirectorStop(), true)
  assert.equal(mod.stopCompleted(), false, 'the request cleared the previous answer')
  assert.equal(existsSync(mod.stopRequestPath()), true)
  mod.clearStopSignals()
})

test('stopping a hand-started bridge is recorded instead of silently killed (B-P2-10)', () => {
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  __test.clearRedirectorPid()
  useHooks({ windowsPids: () => [5555], windowsAlive: () => false, taskkill: () => 'SUCCESS' })
  try {
    const result = __test.stopRedirectorSync({ graceMs: 100 })
    assert.equal(result.stopped, true)
    assert.equal(result.foreign, true, 'the pid came from detection, not from our pid file')
    const log = readFileSync(join(home, 'proxy-forward.log'), 'utf8')
    assert.match(log, /非本工具记录的桥接 pid=5555/)
  } finally {
    useHooks({})
    __test.clearRedirectorPid()
    rmSync(join(home, 'proxy-forward.log'), { force: true })
  }
})

test('the heartbeat ages out and the stop signals round-trip', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'hb-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = tmpHome
  const mod = await import('../lib/redirector.js')
  try {
    assert.equal(mod.heartbeatAgeMs(), Number.POSITIVE_INFINITY, 'a missing heartbeat counts as stale')
    assert.equal(mod.writeHeartbeat(), true)
    assert.ok(mod.heartbeatAgeMs() < 2000, 'a fresh heartbeat must look fresh')

    assert.equal(mod.stopCompleted(), false)
    mod.clearStopSignals()
    assert.equal(mod.requestRedirectorStop(), true)
    assert.equal(existsSync(mod.stopRequestPath()), true)
    // The marker is written by the watchdog, not by us: simulate its report.
    writeFileSync(mod.stoppedMarkerPath(), 'done\n')
    assert.equal(mod.stopCompleted(), true)
    mod.clearStopSignals()
    assert.equal(mod.stopCompleted(), false)
    assert.equal(existsSync(mod.stopRequestPath()), false)
  } finally {
    process.env.DSH_RIS_IDE_PROXY_HOME = home
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('the elevated watchdog script carries the rules it needs to tear down', { skip: skipWithout(WINDOWS_SIDE, 'wslpath') }, async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'wd-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = tmpHome
  const mod = await import('../lib/redirector.js')
  try {
    const script = mod.windowsWatchdogScript({
      heartbeat: 'C:\\hb', stateFile: 'C:\\state.json', logFile: 'C:\\log.txt',
      stopRequest: 'C:\\stop', stoppedMarker: 'C:\\done',
    })
    // A watchdog that stops on the wrong signal either kills a healthy bridge or
    // leaves an elevated CLI behind — both are silent, so assert the pieces.
    assert.match(script, /Test-Path \$stopFile/)
    assert.match(script, /heartbeat-stale/)
    assert.match(script, /\(Get-OwnCli\) \| ForEach-Object \{ Stop-Process -Id \$_\.ProcessId -Force \}/)
    // Only CLIs carrying THIS home's profile may be torn down (review A4-P2-1).
    assert.match(script, /IndexOf\(\$ownProfile/)
    assert.match(script, /Set-Service -Name ProxyBridgeSvc -StartupType \$state\.originalStartType/)
    assert.match(script, /New-Item -ItemType File -Path \$doneFile/)
    assert.match(script, /\$age -lt 20/)
    // Two watchdogs fighting over the same reload request restart the CLI twice
    // (m11702): one copy owns a named mutex, the second exits immediately.
    assert.match(script, /System\.Threading\.Mutex/)
    assert.match(script, /WaitOne\(0\)/)
    assert.match(script, /another watchdog owns the mutex; exiting/)

    const written = mod.writeWatchdogScript()
    // It returns the WINDOWS path (that is where it runs); the file itself is ours.
    assert.match(written, /proxybridge-watchdog\.ps1$/)
    assert.equal(existsSync(join(tmpHome, 'proxybridge-watchdog.ps1')), true)
    assert.match(readFileSync(join(tmpHome, 'proxybridge-watchdog.ps1'), 'utf8'), /ProxyBridgeSvc/)
  } finally {
    process.env.DSH_RIS_IDE_PROXY_HOME = home
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test('a bridge start retires the previous elevated watchdog (m11702)', async () => {
  // Every start used to spawn a watchdog and leave the old one running (it only
  // exits on a stop request or a stale heartbeat, and dsh keeps the heartbeat
  // fresh). Two watchdogs then restart the CLI concurrently — one wins the
  // WinDivert handle, the other silently captures nothing. The start script must
  // kill the leftovers in the same elevated context that creates the new one.
  const source = readFileSync(new URL('../lib/redirector.js', import.meta.url), 'utf8')
  assert.ok(source.includes('IndexOf($wdScript'), 'the start script must recognise leftover watchdogs by THIS home\'s script path')
  assert.ok(source.includes('Stop-Process -Id $_.ProcessId -Force'), 'the start script must kill them, not just look')
  assert.ok(source.includes('oldWatchdogs='), 'the elevated report should say how many were retired')
})

test('both sides are single-instance: a start lock and duplicate discovery (m11773)', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'single-'))
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = tmpHome
  const mod = await import('../lib/redirector.js')
  try {
    // 1. A second concurrent start must not get the lock while the first holds it.
    const first = await mod.acquireStartLock('local', { timeoutMs: 200 })
    assert.equal(first.ok, true)
    const second = await mod.acquireStartLock('local', { timeoutMs: 150 })
    assert.equal(second.ok, false)
    assert.match(second.reason ?? '', /另一个进程正在启动/)
    first.release()
    const third = await mod.acquireStartLock('local', { timeoutMs: 150 })
    assert.equal(third.ok, true, 'releasing the lock must let the next start in')
    third.release()
    // 2. A starter that died leaves a stale lock: the owner pid is gone.
    const staleDir = join(tmpHome, 'locks', 'proxybridge-local.lock')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'owner'), '999999\n')
    const fourth = await mod.acquireStartLock('local', { timeoutMs: 300 })
    assert.equal(fourth.ok, true, 'a dead owner must not block every later start')
    fourth.release()
    // 3. Every local engine is discoverable, not just the first (the old scan
    //    returned one pid, so a duplicate could never be reaped).
    mod.__test.setProbeHooks({ localProc: () => [111, 222] })
    assert.deepEqual(mod.localRedirectorPids(), [111, 222])
    mod.__test.resetProbeHooks()
    // 4. The Windows elevated start is serialised too: a second helper reports
    //    start-busy instead of racing the first one's CLI.
    const source = readFileSync(new URL('../lib/redirector.js', import.meta.url), 'utf8')
    assert.ok(source.includes('start-busy=True'), 'a concurrent Windows start must be reported, not faked')
    assert.ok(source.includes('proxybridge-start-'), 'the start mutex is per proxy home')
    assert.ok(source.includes('旧 watchdog') || source.includes('oldWatchdogs='), 'old watchdogs are still retired at start')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
})
test('the local side falls back to pkexec when sudo is not passwordless (m12606)', async () => {
  // Elevation here is a decision tree, not a UI detail: sudo -n, then pkexec, then
  // the manual command. Keep the strings in the source so a refactor cannot quietly
  // drop the dialog path.
  const source = readFileSync(new URL('../lib/redirector.js', import.meta.url), 'utf8')
  assert.match(source, /pkexecAvailable\(\)/)
  assert.match(source, /spawn\('pkexec', \[found\.path, \.\.\.plan\.args\]/)
  assert.match(source, /method: 'pkexec'/)
  assert.match(source, /method: 'manual'/)
  // Clicking 提权启动 must be able to hand the password to a real terminal (m12782).
  assert.match(source, /function openElevatedTerminal\(/)
  assert.match(source, /method: 'terminal'/)
  assert.match(source, /TERMINAL_CANDIDATES/)
  // Headless Linux has no window to open: skip X11 clients without a session (m12884).
  assert.match(source, /function hasGraphicalSession\(/)
  assert.match(source, /candidate\.bin !== 'wt\.exe' && hasGraphicalSession\(\) === false/)
  // The password is typed in the window, then the CLI must survive the window: sudo
  // ticket first, detached `sudo -n` afterwards (m12896).
  assert.match(source, /sudo -v \|\|/)
  assert.match(source, /nohup sudo -n /)
  assert.match(source, /--size/)
  // m13083: -f maximized the window, so it is gone; the size keeps it small.
  assert.match(source, /--size', '64,16'/)
  // m13147/m13257: the helper launches WT itself and centers the one new window,
  // because WT hosts every window in one process (a title or pid cannot identify it).
  assert.match(source, /launchCenteredTerminal/)
  assert.match(source, /MoveWindow/)
  assert.match(source, /center-terminal\.ps1/)
  assert.match(source, /Start-Process -FilePath 'wt\.exe'/)
})
test('the elevation script detaches the CLI so the window can close (m12896)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { elevationScript } = await import('../lib/redirector.js')
  const dir = mkdtempSync(join(tmpdir(), 'risd-elevate-'))
  try {
    // 'linux' is the page's spelling; the helper/state files are always `local`
    // (review B-P1-1), so this must not produce elevate-linux.*.
    const plan = elevationScript('sudo /opt/ProxyBridge --profile p --verbose 2', 'linux', {
      dir,
      argv: ['/opt/ProxyBridge', '--profile', 'a b', '--verbose', '2'],
    })
    assert.equal(plan.scriptPath, join(dir, 'elevate-local.sh'))
    assert.match(plan.body, /^#!\/bin\/bash/m)
    assert.match(plan.body, /sudo -v \|\|/)
    // argv entries are single-quoted for bash (review B-P2-10): a profile path the
    // user can choose must not be able to inject a command into the sudo line.
    assert.match(plan.body, /nohup sudo -n '\/opt\/ProxyBridge' '--profile' 'a b' '--verbose' '2' > "\$LOG" 2>&1 &/)
    assert.match(plan.body, /sleep 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('the elevation note clears when the helper script exits (m12923)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readElevationState } = await import('../lib/redirector.js')
  const home = mkdtempSync(join(tmpdir(), 'risd-elev-state-'))
  try {
    // The writer puts it in <proxy home>/proxybridge/ (elevationScript's default
    // dir) — reading <proxy home>/elevate-*.json never found it (review B-P1-1).
    const file = join(home, 'proxybridge', 'elevate-local.json')
    mkdirSync(join(home, 'proxybridge'), { recursive: true })
    writeFileSync(file, JSON.stringify({ side: 'local', pid: process.pid, at: new Date().toISOString() }))
    assert.equal(readElevationState('local', { home }).active, true)
    // The page still calls this side 'linux'; both spellings must find the file.
    assert.equal(readElevationState('linux', { home }).active, true)
    rmSync(file)
    assert.equal(readElevationState('local', { home }).active, false)
    // A stale file from a dead pid must not keep the note on screen either.
    writeFileSync(file, JSON.stringify({ side: 'local', pid: 999999, at: new Date().toISOString() }))
    assert.equal(readElevationState('local', { home }).active, false)
    // A SIGKILL leaves the file behind; its TTL stops the note from sticking forever.
    writeFileSync(file, JSON.stringify({ side: 'local', pid: process.pid, at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }))
    assert.equal(readElevationState('local', { home }).active, false)
    // Unknown side names must not be interpolated into a path.
    assert.equal(readElevationState('../evil', { home }).active, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('only a user-initiated start may raise an interactive prompt (review B-P0-2)', async () => {
  const source = readFileSync(new URL('../lib/redirector.js', import.meta.url), 'utf8')
  // The gate must sit BEFORE the pkexec branch: the reconciler calls this every
  // minute, and a prompt there is a polkit dialog / terminal window per minute.
  const gate = source.indexOf("if (options.interactive !== true) {")
  const pkexec = source.indexOf('if (pkexecAvailable() === true) {')
  assert.ok(gate > 0, 'the interactive gate exists')
  assert.ok(pkexec > 0 && gate < pkexec, 'the gate precedes pkexec')
  assert.match(source, /startRedirector\(\{ side, verbose: options\.verbose, interactive: options\.interactive === true \}\)/)
  assert.match(source, /export function localRedirectorOwnPids\(\)/)
  assert.match(source, /const own = localRedirectorOwnPids\(\)/, 'detection adopts our own hand-started bridge')
})

test('the elevated launcher no longer blocks the daemon (review B-P0-1)', async () => {
  const { __test } = await import('../lib/redirector.js')
  // spawnSync waited for the UAC dialog (up to 45 s) with the daemon's 3 s
  // heartbeat and every HTTP route behind it. While the launcher runs, timers must
  // still fire.
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 20)
  try {
    const started = Date.now()
    const result = await __test.spawnDetachedText(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], 2000)
    const elapsed = Date.now() - started
    assert.equal(result.timedOut, false)
    assert.ok(ticks > 0, 'the event loop kept running while the launcher waited')
    assert.ok(elapsed < 1500, `launcher returned after ${elapsed} ms`)
  } finally {
    clearInterval(timer)
  }
})

test('a hung launcher is killed at the timeout (review B-P0-1)', async () => {
  const { __test } = await import('../lib/redirector.js')
  const started = Date.now()
  const result = await __test.spawnDetachedText(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], 150)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 1500, 'the timeout must not wait for the child')
})

test('a stale lock release cannot delete the next owner\'s lock (review B-P2-9)', async () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const home = mkdtempSync(join(tmpdir(), 'lock-own-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  try {
    const lock = await mod.acquireStartLock('local', { timeoutMs: 200 })
    assert.equal(lock.ok, true)
    const dir = join(home, 'locks', 'proxybridge-local.lock')
    // Another starter took the lock over after we were considered stale; our late
    // release must not remove ITS lock.
    writeFileSync(join(dir, 'owner'), `${process.pid + 1}\n`)
    lock.release()
    assert.equal(existsSync(dir), true, 'release only removes our own lock')
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a failed materialisation is cached briefly, and force retries (review B-P2-13)', async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const home = mkdtempSync(join(tmpdir(), 'mat-fail-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  const { buildProfile } = mod.__test
  try {
    // prepareWindowsBundle refuses to run without a complete bundle (all 8 files).
    const files = {
      'LICENSE-ProxyBridge.txt': 'license',
      'NOTICE.md': 'notice',
      'linux/ProxyBridge': 'linux-cli',
      'linux/libproxybridge.so': 'linux-so',
      'windows/ProxyBridgeCore.dll': 'core',
      'windows/ProxyBridge_CLI.exe': 'cli',
      'windows/WinDivert.dll': 'divert',
      'windows/WinDivert64.sys': 'driver',
    }
    for (const [rel, content] of Object.entries(files)) {
      const path = join(home, 'proxybridge', 'bundle', rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
    writeFileSync(join(home, 'proxybridge', 'bundle', 'manifest.json'), JSON.stringify({
      version: 1, url: 'x', sha256: 'x', installedAt: 'now',
      files: Object.fromEntries(Object.entries(files).map(([rel, content]) => [rel, content.length])),
      fileHashes: {},
    }))
    // A file where the target directory should be makes the copy fail.
    const blocked = join(home, 'blocked-target')
    writeFileSync(blocked, 'not a directory')
    const { prepareWindowsBundle } = await import('../lib/redirector.js')
    const result1 = prepareWindowsBundle({ targetDir: blocked })
    assert.equal(result1, '')
    const second = prepareWindowsBundle({ targetDir: blocked })
    assert.equal(second, '')
    // force ignores the negative cache and tries again (same failure, but attempted).
    const forced = prepareWindowsBundle({ targetDir: blocked, force: true })
    assert.equal(forced, '')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the start-type hint records what the service was before the start (review B-P1-3)', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const home = mkdtempSync(join(tmpdir(), 'start-type-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  try {
    assert.equal(existsSync(mod.__test.startTypeHintPath()), false)
    assert.equal(mod.__test.readStartTypeHint(), '')
    // Only real service start types are accepted.
    const path = mod.__test.startTypeHintPath()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(home, 'proxybridge'), { recursive: true })
    writeFileSync(path, 'Automatic\n')
    assert.equal(mod.__test.readStartTypeHint(), 'Automatic')
    writeFileSync(path, 'made-up\n')
    assert.equal(mod.__test.readStartTypeHint(), '')
    mod.__test.clearStartTypeHint()
    assert.equal(existsSync(path), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a root-owned bridge is reported with the command that would stop it (review B-P1-2)', async () => {
  const { __test } = await import('../lib/redirector.js')
  const result = __test.privilegedStopResult(4242, { side: 'local' })
  assert.equal(result.stopped, false)
  assert.equal(result.pid, 4242)
  assert.match(result.reason, /root/)
  assert.equal(result.command, 'sudo kill 4242')
  assert.match(result.hint, /sudo kill 4242/)
})

test('stop answers pendingStart (not "not running") while a start is in flight (review B-P1-5, follow-up b)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const home = mkdtempSync(join(tmpdir(), 'stop-lock-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  try {
    mod.__test.setProbeHooks({ localProc: () => [], windowsPids: () => [] })
    mod.__test.clearProbeCaches()
    const lock = await mod.acquireStartLock('windows', { timeoutMs: 200 })
    assert.equal(lock.ok, true)
    // Nothing is detected (pid files are already cleared during the UAC wait), but
    // the start lock is the truth: stop must say pendingStart and must NOT block for
    // the full 15 s lock timeout on the side it is not touching.
    const started = Date.now()
    const stopped = await mod.__test.stopRedirector({ lockTimeoutMs: 15000 })
    const elapsed = Date.now() - started
    assert.equal(stopped.stopped, false)
    assert.equal(stopped.pendingStart, true)
    assert.equal(stopped.side, 'windows')
    assert.match(stopped.reason ?? '', /另一个进程正在启动/)
    assert.ok(elapsed < 2000, 'stop must probe the lock instead of waiting 15 s per side')
    lock.release()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('readElevationState treats options.home as the PROXY home (server.js contract, review d)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  const home = mkdtempSync(join(tmpdir(), 'elev-home-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const mod = await import('../lib/redirector.js')
  try {
    mkdirSync(join(home, 'proxybridge'), { recursive: true })
    writeFileSync(join(home, 'proxybridge', 'elevate-local.json'), JSON.stringify({ side: 'local', pid: process.pid, at: new Date().toISOString() }))
    // The daemon passes proxyHomeDir() as `home`; the helper appends proxybridge/.
    assert.equal(mod.readElevationState('local', { home }).active, true)
    assert.equal(mod.readElevationState('linux', { home }).active, true, "'linux' is an alias of 'local'")
    // A direct <home>/elevate-local.json must NOT be picked up: that spelling is
    // what a future redirectorHome() caller would produce (double join).
    writeFileSync(join(home, 'elevate-local.json'), JSON.stringify({ side: 'local', pid: process.pid, at: new Date().toISOString() }))
    rmSync(join(home, 'proxybridge', 'elevate-local.json'))
    assert.equal(mod.readElevationState('local', { home }).active, false, 'home is the proxy home, not the redirector home')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the sudo probe is cached between background attempts (m03761)', { skip: process.platform === 'win32' ? 'no sudo on Windows' : false }, () => {
  // A real `sudo -n true` writes a journal line on every call — including the
  // failures. The reconciler retries a background start every minute, so on a box
  // without passwordless sudo that used to be one audit line per minute. Pinned
  // here with a fake `sudo` on PATH that records each invocation.
  const bin = mkdtempSync(join(tmpdir(), 'ris-sudo-'))
  const calls = join(bin, 'calls.log')
  // `printf`, not `echo "$@"`: the args start with `-n`, which echo takes as
  // "no trailing newline" — the invocations would then concatenate into one line
  // and the counter would never move.
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\nprintf '[%s]\\n' "$*" >> "${calls}"\nexit 1\n`, { mode: 0o755 })
  chmodSync(join(bin, 'sudo'), 0o755)
  const previousPath = process.env.PATH
  const count = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter((line) => line !== '').length : 0)
  process.env.PATH = bin
  try {
    __test.resetSudoProbe()
    assert.equal(__test.sudoPasswordless(), false, 'the fake sudo never succeeds')
    assert.equal(count(), 1)
    assert.equal(__test.sudoPasswordless(), false, 'the cached answer is reused')
    assert.equal(count(), 1, 'a background retry must not spawn sudo again')
    __test.sudoPasswordless({ interactive: true })
    assert.equal(count(), 2, 'a user-initiated start asks fresh (NOPASSWD may be new)')
  } finally {
    process.env.PATH = previousPath
    __test.resetSudoProbe()
    rmSync(bin, { recursive: true, force: true })
  }
})
