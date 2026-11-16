// Route-level tests for the proxy dialog: read, save, action, program picker.
// These call the host handlers directly (the same shape the HTTP server uses).
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

// The proxy config/pid/log live in ONE machine-level directory now (that is the
// whole point of the shared engine), so every test run gets its own throwaway
// home instead of writing into the developer's ~/.dsh-ris-ide.
process.env.DSH_RIS_IDE_PROXY_HOME = mkdtempSync(join(tmpdir(), 'ris-proxy-home-'))

import { __test } from '../lib/index.js'
import { readProxyConfig, writeProxyConfig } from '../lib/proxy.js'
import { __test as redirectorTest } from '../lib/redirector.js'

// Stub every probe that could reach the real Windows side for the whole file.
// Two reasons, and both are not theoretical: (1) saving the table in these tests
// runs the production reload path, which finds a bridge by probing and then
// restarts/stops it — with the user's ProxyBridge_CLI running that would kill it;
// (2) `Get-Process ProxyBridge_CLI` through powershell.exe takes seconds and times
// out, which made this file take 17-26 s and pass or fail depending on load.
const PROBE_HOOKS = {
  windowsPids: () => [],
  localProc: () => 0,
  windowsPidsAsync: async () => [],
  windowsAlive: () => false,
  windowsAliveAsync: async () => false,
  taskkill: () => 'ERROR: Access is denied.',
}
redirectorTest.setProbeHooks(PROBE_HOOKS)
process.on('exit', () => redirectorTest.resetProbeHooks())
// The Windows process listing spawns powershell.exe (3-4.5 s on WSL, and it reads
// the developer's real desktop). A fixed list is all this file needs: the picker
// assertions are about which names are *offered* (SOCKS-capable filtering), not
// about what happens to be running.
__test.setWindowsProgramProbe(() => ['java', 'git', 'node', 'curl', 'navicat', 'mysql', 'redis-cli'])
process.on('exit', () => __test.setWindowsProgramProbe(null))

/** A response face that collects the JSON body. */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

/**
 * A request face with a loopback host header and a JSON body. The body arrives
 * as a real Readable so `readJsonBody` (which iterates the stream) works exactly
 * as it does under the HTTP server.
 */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  return req
}

const ctx = (cwd) => ({ sessions: { get: () => ({ header: { cwd } }) } })

test('the proxy routes are advertised under the plugin prefix', () => {
  assert.equal(__test.PROXY_PATH, '/dsh-ris-ide/proxy')
  assert.equal(__test.PROXY_ACTION_PATH, '/dsh-ris-ide/proxy/action')
  assert.equal(__test.PROXY_PROGRAMS_PATH, '/dsh-ris-ide/proxy/programs')
})

test('GET reports the generated rules, disabled, with parse diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.side, 'string')
    assert.deepEqual(body.rules.filter((rule) => rule.source === 'auto').map((rule) => rule.program), ['java', 'git'])
    assert.equal(body.rules.every((rule) => rule.enabled === false), true)
    assert.equal(body.running, false)
    assert.equal(body.configPath, join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), 'ONE shared file, not a per-workspace one')
    assert.equal(body.shared, true)
    assert.equal(body.workspace, dir)
    assert.deepEqual(body.rules[0].hostsParsed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST saves the form and echoes the rejected fragments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy', {
      sessionId: 's1',
      config: {
        socks: { host: '10.3.91.121', port: 1080 },
        listenPort: 11081,
        rules: [
          { id: 'db', program: 'navicat', hosts: '172.20.235.*, bad host!', ports: '1521, 70000', enabled: true, shadow: false },
        ],
      },
    }), res)
    assert.equal(res.status, 200)
    const body = res.json()
    const db = body.rules.find((rule) => rule.id === 'db')
    assert.deepEqual(db.hostsParsed, ['172.20.235.*'])
    assert.deepEqual(db.hostsInvalid, ['bad host!'])
    assert.deepEqual(db.portsParsed, [1521])
    assert.deepEqual(db.portsInvalid, ['70000'])
    assert.equal(db.shadowable, false)
    assert.equal(body.socks.host, '10.3.91.121')
    // …and it really landed on disk (that is what the engine reads).
    assert.equal(readProxyConfig(dir).rules.find((rule) => rule.id === 'db').enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starter rows are marked, and a save does not freeze them into the table', async () => {
  // The dialog shows 4 starter rows off an empty table. If the first save wrote them,
  // today's suggestion would become a stored rule forever (and the host could never
  // change its mind about which programs get one).
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-template-'))
  try {
    const readRes = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), readRes)
    const view = readRes.json()
    const templates = view.rules.filter((rule) => rule.template === true)
    assert.ok(templates.length >= 2, 'the starter rows are marked as such')
    assert.ok(templates.every((rule) => rule.id.startsWith('auto-')))
    // A save that carries only real rows leaves the table without any auto row.
    const saveRes = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy', {
      sessionId: 's1',
      revision: view.revision,
      config: {
        socks: view.socks,
        listenPort: view.listenPort,
        rules: [{ id: 'real', program: 'java', hosts: '172.20.235.*', ports: '*', enabled: true }],
      },
    }), saveRes)
    assert.equal(saveRes.status, 200)
    const stored = readProxyConfig(dir).rules.map((rule) => rule.id)
    assert.deepEqual(stored, ['real'], 'no starter row was written to disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reload rewrites the profile BEFORE restarting the interceptor', () => {
  // ProxyBridge reads its profile only at start. Reloading without rewriting it
  // relaunches the OLD rules and still reports "已按新规则自动重启" — the exact
  // failure B3 described.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function serveProxy(')
  const body = source.slice(start, start + 20000)
  // Rewriting the profile and restarting are ONE step now (a bare restart relaunched
  // the old profile and lied about it — the helper writes first, then reloads).
  assert.ok(body.includes('await reloadRedirectorsWithProfile(cwd'), 'the save reloads through the profile-writing helper')
  assert.equal(body.includes('startRedirectors({ reload: true'), false, 'no bare restart path is left')
  // B-M3: a GET must not block the event loop on the 3.5s PowerShell probe.
  assert.ok(body.includes('redirectorStatusCached()'), 'status comes from the cached probe')
  assert.ok(source.includes('redirector: Object.assign(redirectorStatusCached()'), 'the view uses it too')
})

test('the bridge restart action is wired on the card, in the daemon and in the plugin', () => {
  // The bridge parses its profile when it starts, so a rule-table save can leave old
  // rules intercepting; the card offers ONE enforcement button whose label follows
  // the state, and a click restarts = stop, settle, start from the new profile.
  // Source pins: stopRedirector/startRedirectors shell out to the real side with no
  // injection point, so the ordering can only be asserted on the source here.
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

  // The card: one button (no separate restart / elevate controls), the stale-reload
  // label, and it asks the plugin for the restart instead of auto-starting a proxy.
  const ui = read('lib/risd/ui.js')
  assert.match(ui, /redirector-restart/)
  assert.doesNotMatch(ui, /id="bridge-health-elevate"/)
  assert.doesNotMatch(ui, /maybeStartProxy/)

  // The daemon must understand the action, and a page-triggered restart may prompt
  // (it is the user asking); background reconcilers must not.
  const server = read('lib/risd/server.js')
  const daemonAt = server.indexOf("action === 'redirector-restart'")
  assert.ok(daemonAt > 0, 'daemon must handle redirector-restart')
  const daemonBlock = server.slice(daemonAt, daemonAt + 600)
  assert.match(daemonBlock, /await stopRedirector\(\)/)
  assert.match(daemonBlock, /setTimeout\(resolve, 300\)/)
  assert.match(daemonBlock, /await startRedirectors\(\{ interactive \}\)/)
  assert.match(server, /const interactive = parsed\.interactive === true/)

  // The plugin forwards the action to the daemon and can run it itself.
  const index = read('lib/index.js')
  assert.match(index, /'redirector-restart'/)
  const pluginAt = index.indexOf("action === 'redirector-restart'")
  assert.ok(pluginAt > 0, 'plugin must handle redirector-restart locally')
  const pluginBlock = index.slice(pluginAt, pluginAt + 400)
  assert.match(pluginBlock, /await stopRedirector\(\)/)
  assert.match(pluginBlock, /setTimeout\(resolve, 300\)/)
  assert.match(pluginBlock, /await startRedirectors\(\)/)
})

test('a save rendered from a stale table is refused, not applied', async () => {
  // Two windows hold the same table; the second save must not silently drop the
  // first one's row. The payload names the table it was rendered from.
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-conflict-'))
  try {
    writeProxyConfig(dir, {
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [{ id: 'first', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true }],
    })
    const readRes = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), readRes)
    const rendered = readRes.json()
    assert.equal(typeof rendered.revision, 'string')
    assert.ok(rendered.revision !== '')

    // Window A saves (the table now differs from what window B rendered).
    const aRes = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy', {
      sessionId: 's1',
      revision: rendered.revision,
      config: {
        socks: { host: '10.3.91.121', port: 1080 },
        rules: [
          { id: 'first', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true },
          { id: 'from-a', program: 'psql', hosts: '172.20.235.80', ports: '*', enabled: true },
        ],
      },
    }), aRes)
    assert.equal(aRes.status, 200)

    // Window B saves with the SAME (now stale) revision: refused, table untouched.
    const bRes = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy', {
      sessionId: 's1',
      revision: rendered.revision,
      config: {
        socks: { host: '10.3.91.121', port: 1080 },
        rules: [{ id: 'from-b', program: 'mysql', hosts: '172.20.235.80', ports: '3306', enabled: true }],
      },
    }), bRes)
    assert.equal(bRes.status, 409)
    const conflict = bRes.json()
    assert.equal(conflict.conflict, true)
    assert.equal(typeof conflict.message, 'string')
    // The view comes back so the dialog can reload instead of guessing.
    assert.equal(conflict.view.rules.some((rule) => rule.id === 'from-a'), true)
    const onDisk = readProxyConfig(dir).rules.map((rule) => rule.id)
    assert.equal(onDisk.includes('from-b'), false, 'the stale save changed nothing')
    assert.equal(onDisk.includes('from-a'), true)
    // The revision it reports is the CURRENT one, so the reload can save again.
    assert.notEqual(conflict.revision, rendered.revision)
  } finally {
    writeProxyConfig(dir, { socks: { host: '', port: 0 }, rules: [] })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shadow flag is what makes a literal rule bindable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    writeProxyConfig(dir, { rules: [{ id: 'lit', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true, shadow: true }] })
    const res = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const rule = res.json().rules.find((item) => item.id === 'lit')
    assert.equal(rule.shadowable, true, 'a literal IPv4 rule can be mapped onto 127.0.0.1')
    assert.equal(rule.shadow, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shadow column follows what can be bound, not what parses', async () => {
  // `*` parses to port 0 = "any port": a loopback listener cannot bind it, so that row
  // must not claim to be shadowable (the flag is exactly what the engine binds).
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-bindable-'))
  try {
    writeProxyConfig(dir, {
      socks: { host: '10.0.0.1', port: 1080 },
      rules: [
        { id: 'any-port', program: 'java', hosts: '172.20.235.80', ports: '*', enabled: true },
        { id: 'real-port', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true },
        { id: 'spaced-range', program: 'psql', hosts: '172.20.235.80', ports: '1000 - 1003', enabled: true },
      ],
    })
    const res = fakeRes()
    await __test.serveProxy(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const rules = res.json().rules
    const byId = (id) => rules.find((rule) => rule.id === id)
    assert.equal(byId('any-port').shadowable, false)
    assert.equal(byId('real-port').shadowable, true)
    // One grammar for host and dialog: `1000 - 1003` is a range on both sides.
    assert.deepEqual(byId('spaced-range').portsParsed, [1000, 1001, 1002, 1003])
    assert.deepEqual(byId('spaced-range').portsInvalid, [])
  } finally {
    // The table is machine-wide: leaving a SOCKS address behind would make the next
    // test see an upstream it never configured.
    writeProxyConfig(dir, { socks: { host: '', port: 0 }, rules: [] })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('action=status answers without touching anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    await __test.serveProxyAction(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy/action', { sessionId: 's1', action: 'status' }), res)
    assert.equal(res.status, 200)
    assert.equal(res.json().running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start refuses without an upstream SOCKS address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    await __test.serveProxyAction(ctx(dir), fakeReq('POST', '/dsh-ris-ide/proxy/action', { sessionId: 's1', action: 'start' }), res)
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.result.ok, false)
    assert.match(body.result.error, /SOCKS/)
    assert.equal(body.running, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the program picker lists suggestions and marks the engine side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    await __test.serveProxyPrograms(ctx(dir), fakeReq('GET', '/dsh-ris-ide/proxy/programs?sessionId=s1'), res)
    assert.equal(res.status, 200)
    const body = res.json()
    assert.ok(['windows', 'wsl', 'linux', 'macos'].includes(body.side))
    const names = body.programs.map((item) => item.name.toLowerCase())
    // Only SOCKS-aware programs are offered: injecting a tunnel means handing the
    // program a SOCKS address, which a non-SOCKS client cannot use — those are
    // mapped on 127.0.0.1 instead and need no picker entry.
    for (const expected of ['java', 'git', 'node', 'curl']) {
      assert.equal(names.includes(expected), true, `picker should offer ${expected}`)
    }
    for (const hidden of ['navicat', 'navicat.exe', 'mysql', 'redis-cli', 'psql']) {
      assert.equal(names.includes(hidden), false, `picker must not offer ${hidden} (no SOCKS support)`)
    }
    assert.ok(body.programs.every((item) => typeof item.side === 'string'))
    assert.match(String(body.note || ''), /127\.0\.0\.1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a request from a non-loopback peer is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-route-'))
  try {
    const res = fakeRes()
    const req = fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1')
    req.headers = { host: '10.0.0.9:3080' }
    await __test.serveProxy(ctx(dir), req, res)
    assert.equal(res.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the file browser lists programs it can offer, and refuses a missing directory', async () => {
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'ris-browse-'))
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n')
  chmodSync(join(root, 'run.sh'), 0o755)
  writeFileSync(join(root, 'notes.txt'), 'x')
  try {
    const list = fakeRes()
    await __test.serveProxyBrowse(ctx(root), fakeReq('GET', '/dsh-ris-ide/proxy/browse?sessionId=s1'), list)
    assert.equal(list.status, 200)
    const body = list.json()
    assert.equal(body.ok, true)
    assert.equal(body.path, root, 'no ?path lists the workspace itself')
    assert.deepEqual(body.dirs.map((dir) => dir.name), ['bin'], 'node_modules is skipped')
    assert.deepEqual(body.files.map((file) => file.name), ['run.sh'], 'only executable-looking files')
    assert.ok(Array.isArray(body.roots) && body.roots.length >= 1, 'entry points are offered')
    // The tree starts at `/` and the Windows disks and nothing else: a program that
    // lives outside workspace/home/temp must be reachable without typing its path.
    const names = body.roots.map((entry) => entry.path)
    assert.equal(names.includes('/'), true, '/ is an entry point')
    assert.equal(names.every((path) => path === '/' || path.startsWith('/mnt/')), true,
      'no workspace/home/temp shortcuts in front of the real start')

    const atRoot = fakeRes()
    await __test.serveProxyBrowse(ctx(root), fakeReq('GET', '/dsh-ris-ide/proxy/browse?sessionId=s1&path=%2F'), atRoot)
    assert.equal(atRoot.json().path, '/')
    assert.equal(Array.isArray(atRoot.json().dirs), true)

    const deeper = fakeRes()
    await __test.serveProxyBrowse(ctx(root), fakeReq('GET', `/dsh-ris-ide/proxy/browse?sessionId=s1&path=${encodeURIComponent(join(root, 'bin'))}`), deeper)
    assert.equal(deeper.json().path, join(root, 'bin'))
    assert.equal(deeper.json().parent, root)

    const missing = fakeRes()
    await __test.serveProxyBrowse(ctx(root), fakeReq('GET', `/dsh-ris-ide/proxy/browse?sessionId=s1&path=${encodeURIComponent(join(root, 'nope'))}`), missing)
    assert.equal(missing.status, 400)
    assert.match(String(missing.json().message), /无法读取目录/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a started program only gets proxy env when an enabled rule names it', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'ris-env-'))
  try {
    mkdirSync(process.env.DSH_RIS_IDE_PROXY_HOME, { recursive: true })
    const rules = [
      { id: 'java', program: 'java', hosts: '172.20.*', ports: '*', enabled: true, shadow: false, source: 'user', workspace: root },
      { id: 'git', program: 'git', hosts: '172.20.*', ports: '*', enabled: false, shadow: false, source: 'user', workspace: root },
    ]
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ listenPort: 11081, socks: { host: '10.3.91.121', port: 1080 }, rules }))
    const javaEnv = __test.proxyEnvFor({ name: 'java', kind: 'spring' }, root)
    // A-M1: the injected address is the LOCAL listener, so every connection still
    // passes the allow-list; handing out the upstream address would bypass it.
    assert.equal(javaEnv.ALL_PROXY, 'http://127.0.0.1:11081')
    assert.match(String(javaEnv.JAVA_TOOL_OPTIONS), /-Dhttp\.proxyHost=127\.0\.0\.1/)
    // …unless the row explicitly asks to bind straight to the upstream SOCKS server.
    rules[0].direct = true
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ listenPort: 11081, socks: { host: '10.3.91.121', port: 1080 }, rules }))
    const directEnv = __test.proxyEnvFor({ name: 'java', kind: 'spring' }, root)
    assert.equal(directEnv.ALL_PROXY, 'socks5h://10.3.91.121:1080')
    assert.match(String(directEnv.JAVA_TOOL_OPTIONS), /-DsocksProxyHost=10\.3\.91\.121/)
    delete rules[0].direct
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ listenPort: 11081, socks: { host: '10.3.91.121', port: 1080 }, rules }))
    assert.deepEqual(__test.proxyEnvFor({ name: 'postgres', kind: 'other' }, root), {}, 'no rule → the program starts untouched')
    assert.deepEqual(__test.proxyEnvFor({ name: 'git', kind: 'other' }, root), {}, 'a disabled rule injects nothing')
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ listenPort: 11081, socks: { host: '', port: 0 }, rules }))
    assert.deepEqual(__test.proxyEnvFor({ name: 'java', kind: 'spring' }, root), {}, 'no upstream → no injection')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the dialog saves the machine-wide table it was shown', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'ris-ws-a-'))
  const wsB = mkdtempSync(join(tmpdir(), 'ris-ws-b-'))
  try {
    // The file is machine-wide, so earlier tests in this file left rows behind.
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ socks: { host: '', port: 0 }, listenPort: 11081, rules: [] }))
    const save = async (ws, ruleOrRules) => {
      const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules]
      const res = fakeRes()
      await __test.serveProxy(ctx(ws), fakeReq('POST', '/dsh-ris-ide/proxy', {
        sessionId: 's1',
        config: { socks: { host: '10.3.91.121', port: 1080 }, listenPort: 11081, rules },
      }), res)
      assert.equal(res.status, 200, JSON.stringify(res.json()))
      return res.json()
    }
    await save(wsA, { id: 'a', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true })
    // The dialog always posts back the WHOLE table, so rows from both workspaces
    // survive a save made from either one, each keeping its provenance.
    const after = await save(wsB, [
      { id: 'a', program: 'navicat', hosts: '172.20.235.80', ports: '1521', enabled: true, workspace: wsA },
      { id: 'b', program: 'java', hosts: '172.20.235.*', ports: '1521,3306', enabled: true },
    ])
    assert.equal(after.shared, true)
    const rules = readProxyConfig(wsB).rules
    assert.deepEqual(rules.map((rule) => `${rule.workspace === wsA ? 'A' : rule.workspace === wsB ? 'B' : '?'}:${rule.id}`).sort(), ['A:a', 'B:b'])
    assert.equal(rules.find((rule) => rule.id === 'a').enabled, true)
    // A row missing from the payload was deleted by the human: the table shrinks.
    const shrunk = await save(wsB, [{ id: 'b', program: 'java', hosts: '172.20.235.*', ports: '1521,3306', enabled: true }])
    assert.deepEqual(shrunk.rules.filter((rule) => rule.source !== 'auto').map((rule) => rule.id), ['b'])
  } finally {
    rmSync(wsA, { recursive: true, force: true })
    rmSync(wsB, { recursive: true, force: true })
  }
})

test('the redirector actions export the machine table and never claim to have started what needs root', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-ws-red-'))
  // A stand-in CLI: the real one lives in the user's home and may not exist on a
  // fresh machine, but the route's contract must not depend on that.
  const cliDir = mkdtempSync(join(tmpdir(), 'ris-cli-'))
  const cli = join(cliDir, 'ProxyBridge')
  writeFileSync(cli, '#!/bin/sh\necho "ProxyBridge CLI V9.9.9"\n', { encoding: 'utf8' })
  chmodSync(cli, 0o755)
  process.env.DSH_RIS_IDE_PROXYBRIDGE = cli
  try {
    writeFileSync(join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'), JSON.stringify({ socks: { host: '10.3.91.121', port: 1080 }, listenPort: 11081, rules: [] }))
    const saved = fakeRes()
    await __test.serveProxy(ctx(ws), fakeReq('POST', '/dsh-ris-ide/proxy', {
      sessionId: 's1',
      config: {
        socks: { host: '10.3.91.121', port: 1080 },
        listenPort: 11081,
        rules: [{ id: 'java-235', program: 'java', hosts: '172.20.235.*', ports: '1521', enabled: true }],
      },
    }), saved)
    assert.equal(saved.status, 200, JSON.stringify(saved.json()))
    assert.equal(typeof saved.json().redirector, 'object', 'the view carries ProxyBridge state for both sides')
    assert.equal(saved.json().redirector.profilePath.endsWith('dsh-ris-ide.pbprofile'), true)

    const res = fakeRes()
    await __test.serveProxyAction(ctx(ws), fakeReq('POST', '/dsh-ris-ide/proxy/action', {
      sessionId: 's1', action: 'redirector-sync',
    }), res)
    assert.equal(res.status, 200, JSON.stringify(res.json()))
    const result = res.json().result
    assert.equal(result.written.rules, 1, 'the enabled rule reached the profile')
    // Starting it needs root/UAC; the route reports the command instead of lying.
    assert.equal(result.started, false)
    assert.match(result.command.display, /ProxyBridge/)
    assert.match(result.command.display, /--profile/)
  } finally {
    delete process.env.DSH_RIS_IDE_PROXYBRIDGE
    rmSync(ws, { recursive: true, force: true })
    rmSync(cliDir, { recursive: true, force: true })
  }
})

test('the dialog marks which programs need a loopback mapping', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-ws-cap-'))
  try {
    writeProxyConfig(ws, {
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [
        { id: 'jdbc', program: 'jdbc', hosts: '172.20.235.80', ports: '1521', enabled: true, workspace: ws },
        { id: 'java', program: 'java', hosts: '172.20.235.80', ports: '443', enabled: true, workspace: ws },
      ],
    })
    const res = fakeRes()
    await __test.serveProxy(ctx(ws), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const byId = Object.fromEntries(res.json().rules.map((rule) => [rule.id, rule]))
    assert.equal(byId.jdbc.socksCapable, false)
    assert.equal(byId.jdbc.autoShadow, true, 'a JDBC client can only reach the tunnel through 127.0.0.1')
    assert.equal(byId.jdbc.shadow, true, 'so the mapping is on by default')
    assert.equal(byId.java.socksCapable, true)
    assert.equal(byId.java.autoShadow, false, 'java is told the SOCKS address instead')
    assert.equal(byId.java.shadow, false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('a rule may name a program bare (any path) or a specific executable path', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-ws-name-'))
  try {
    writeProxyConfig(ws, { socks: { host: '10.3.91.121', port: 1080 }, rules: [{ id: 'bare', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: true, workspace: ws }] })
    const bare = __test.proxyEnvFor({ name: 'java', exe: '/usr/lib/jvm/java-21/bin/java', command: '/usr/lib/jvm/java-21/bin/java -jar x.jar' }, ws)
    assert.equal(bare.ALL_PROXY, 'http://127.0.0.1:11081', 'a bare program name matches whatever path it runs from')
    assert.equal(__test.proxyEnvFor({ name: 'git' }, ws).ALL_PROXY, undefined, 'other programs stay untouched')

    writeProxyConfig(ws, { socks: { host: '10.3.91.121', port: 1080 }, rules: [{ id: 'path', program: '/opt/tools/java', hosts: '1.2.3.4', ports: '443', enabled: true, workspace: ws }] })
    assert.equal(__test.proxyEnvFor({ name: 'java', exe: '/usr/lib/jvm/java-21/bin/java' }, ws).ALL_PROXY, undefined, 'a path rule does not match a different executable')
    assert.equal(__test.proxyEnvFor({ name: 'java', exe: '/opt/tools/java' }, ws).ALL_PROXY, 'http://127.0.0.1:11081', 'it matches the executable it names')
    const windowsStyle = __test.proxyEnvFor({ name: 'java', exe: 'C:\\opt\\tools\\java.exe' }, ws)
    assert.equal(windowsStyle.ALL_PROXY, undefined, 'separators are normalised, not string-compared')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('the run button only exists for rules we can actually inject', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-ws-run-'))
  try {
    writeProxyConfig(ws, {
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [
        { id: 'java', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: true, workspace: ws },
        { id: 'navicat', program: 'navicat', hosts: '1.2.3.4', ports: '3306', enabled: true, workspace: ws },
      ],
    })
    const res = fakeRes()
    await __test.serveProxy(ctx(ws), fakeReq('GET', '/dsh-ris-ide/proxy?sessionId=s1'), res)
    const byId = Object.fromEntries(res.json().rules.map((rule) => [rule.id, rule]))
    assert.equal(byId.java.runnable, true, 'java can be started with the tunnel already in its environment')
    assert.equal(byId.navicat.runnable, false, 'navicat gets no button: starting it would proxy nothing')
    assert.equal(typeof byId.java.runLogPath, 'string')
    assert.equal(byId.java.run, null, 'nothing of ours is running yet')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('starting a rule refuses what cannot be proxied, and unknown rules', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-ws-run2-'))
  try {
    writeProxyConfig(ws, {
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [
        { id: 'off', program: 'java', hosts: '1.2.3.4', ports: '443', enabled: false, workspace: ws },
        { id: 'jdbc', program: 'jdbc', hosts: '1.2.3.4', ports: '3306', enabled: true, workspace: ws },
      ],
    })
    const act = async (body) => {
      const res = fakeRes()
      await __test.serveProxyAction(ctx(ws), fakeReq('POST', '/dsh-ris-ide/proxy/action', { sessionId: 's1', ...body }), res)
      return res
    }
    assert.equal((await act({ action: 'run', ruleId: 'off' })).json().message.includes('未启用'), true)
    assert.equal((await act({ action: 'run', ruleId: 'jdbc' })).json().message.includes('不支持 SOCKS'), true)
    assert.equal((await act({ action: 'run', ruleId: 'nope' })).status, 404)
    assert.equal((await act({ action: 'run' })).status, 400)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('the file browser can walk the Windows side and hands back Windows paths', async () => {
  const { serveProxyBrowse, PROXY_BROWSE_PATH } = __test
  const call = async (query) => {
    const req = {
      url: `${PROXY_BROWSE_PATH}${query}`,
      method: 'GET',
      headers: { host: '127.0.0.1:1' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    let payload = null
    const res = { setHeader() {}, writeHead(status) { this.status = status }, end(body) { payload = JSON.parse(body) } }
    await serveProxyBrowse({}, req, res, {})
    return { status: res.status, payload }
  }

  const roots = await call('?side=windows')
  // No session cwd is needed on that side: the tree starts at a drive root.
  if (roots.status === 400) {
    assert.match(roots.payload.message, /没有可浏览的 Windows 盘/)
    return
  }
  assert.equal(roots.payload.side, 'windows')
  assert.match(roots.payload.path, /^[A-Z]:\\/)
  assert.ok(roots.payload.roots.length > 0)
  assert.match(roots.payload.roots[0].path, /^[A-Z]:\\/)
  // A click must write a Windows path into the rule, not /mnt/d/…
  for (const entry of roots.payload.dirs) assert.match(entry.path, /^[A-Z]:\\/)

  const bad = await call(`?side=windows&path=${encodeURIComponent('relative/dir')}`)
  assert.equal(bad.status, 400)
  assert.match(bad.payload.message, /需要盘符路径/)
})

test('the Windows program probe is cached and gets more than a cold-start budget', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 4s was shorter than a cold PowerShell start, so the picker silently lost every
  // Windows entry; the list is now cached so the probe is not repeated per open.
  assert.match(source, /TIMEOUT_WINDOWS_PROGRAMS_MS = 12000/)
  assert.match(source, /WINDOWS_PROGRAM_TTL_MS = 20000/)
  assert.match(source, /windowsProgramCache = \{ at: Date.now\(\), names: \[\.\.\.names\] \}/)
})
