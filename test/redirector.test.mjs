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
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'ris-redirector-home-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { __test } = await import('../lib/redirector.js')

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
process.on('exit', () => __test.resetProbeHooks())
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
  const plan = redirectorCommand({
    cliPath: '/mnt/x/Program Files/ProxyBridge/ProxyBridge_CLI.exe',
    profilePath: '/mnt/x/pb/dsh-ris-ide.pbprofile',
    platform: 'win32',
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
  const vendor = __test.redirectorVendorDir({ platform: 'linux' })
  mkdirSync(vendor, { recursive: true })
  const fake = join(vendor, 'ProxyBridge')
  writeFileSync(fake, '#!/bin/sh\necho "ProxyBridge CLI V9.9.9"\n', { encoding: 'utf8' })
  chmodSync(fake, 0o755)
  try {
    const status = __test.redirectorStatus()
    assert.equal(status.local.available, true, 'the vendored copy is what WSL uses')
    assert.equal(status.local.kind, 'linux-cli')
    assert.equal(status.local.version, '9.9.9')
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

test('starting without a CLI reports why instead of throwing', async () => {
  const real = process.env.DSH_RIS_IDE_PROXYBRIDGE
  process.env.DSH_RIS_IDE_PROXYBRIDGE = join(home, 'proxybridge', 'vendor', 'linux', 'ProxyBridge')
  rmSync(join(home, 'proxybridge', 'vendor'), { recursive: true, force: true })
  try {
    const result = await __test.startRedirector({ side: 'local' })
    assert.equal(result.started, false)
    assert.match(String(result.reason), /未找到/)
  } finally {
    if (real === undefined) delete process.env.DSH_RIS_IDE_PROXYBRIDGE
    else process.env.DSH_RIS_IDE_PROXYBRIDGE = real
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

test('the parked-service state has ONE path shared by writer and watchdog (B2)', async () => {
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

test('the elevated watchdog script carries the rules it needs to tear down', async () => {
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
    assert.match(script, /Get-Process ProxyBridge_CLI .*Stop-Process -Force/)
    assert.match(script, /Set-Service -Name ProxyBridgeSvc -StartupType \$state\.originalStartType/)
    assert.match(script, /New-Item -ItemType File -Path \$doneFile/)
    assert.match(script, /\$age -lt 20/)

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
