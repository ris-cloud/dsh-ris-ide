// Proxy engine tests: rule parsing/matching (pure) + loopback integration tests
// that run the real engine against a scripted fake SOCKS5 server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The proxy config/pid/log live in ONE machine-level directory now (that is the
// whole point of the shared engine), so every test run gets its own throwaway
// home instead of writing into the developer's ~/.dsh-ris-ide.
process.env.DSH_RIS_IDE_PROXY_HOME = mkdtempSync(join(tmpdir(), 'ris-proxy-home-'))

import {
  allowAdmits,
  allowList,
  autoRules,
  connectSocks,
  DEFAULT_LISTEN_PORT,
  DEFAULT_NO_PROXY,
  engineSide,
  hostMatches,
  injectionFor,
  isSocksCapableProgram,
  MAX_RULES,
  MAX_SHADOW_TARGETS,
  mergeConfigs,
  normalizeConfig,
  parseHostSpec,
  parseJsonc,
  parsePortSpec,
  pidAlive,
  pidIsProxy,
  programKey,
  PROXY_MARKER,
  proxyConfigPath,
  proxyHomeDir,
  proxyPid,
  proxyPidPath,
  proxyStatus,
  readProxyConfig,
  ruleEffectiveness,
  shadowTargets,
  startProxy,
  stopProxy,
  writeProxyConfig,
} from '../lib/proxy.js'

/** Wait a while without blocking the event loop. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('host specs: commas, wildcards, invalid fragments', () => {
  assert.deepEqual(parseHostSpec('1.1.1.*, 10.0.0.5').patterns, ['1.1.1.*', '10.0.0.5'])
  assert.deepEqual(parseHostSpec('bad host!').invalid, ['bad host!'])
  assert.deepEqual(parseHostSpec('').patterns, [])
  assert.deepEqual(parseHostSpec(undefined).patterns, [])
})

test('host matching: wildcard segments, DNS case-insensitivity, exact', () => {
  assert.equal(hostMatches('1.1.1.*', '1.1.1.9'), true)
  assert.equal(hostMatches('1.1.1.*', '1.1.2.9'), false)
  assert.equal(hostMatches('*.example.com', 'a.EXAMPLE.com'), true)
  assert.equal(hostMatches('10.0.0.5', '10.0.0.5'), true)
  assert.equal(hostMatches('10.0.0.5', '10.0.0.6'), false)
  // DNS is case-insensitive on BOTH sides — the pattern is not more literal than
  // the host it is compared with (a stored `GitLab.Example.com` must still match).
  assert.equal(hostMatches('GitLab.Example.com', 'gitlab.example.COM'), true)
  assert.equal(hostMatches('*.Example.COM', 'a.example.com'), true)
  assert.equal(hostMatches('*', 'anything'), true)
})

test('port specs: lists and ranges, invalid fragments', () => {
  assert.deepEqual(parsePortSpec('5432, 1000-1003').ports, [1000, 1001, 1002, 1003, 5432])
  assert.deepEqual(parsePortSpec('70000, 5-3').invalid, ['70000', '5-3'])
  assert.deepEqual(parsePortSpec('').ports, [])
})

test('the generated rows are templates: four programs, disabled, never persisted', () => {
  const config = normalizeConfig(undefined)
  // Stored rows only — the shared file must not accumulate a template row per
  // workspace, so the dialog asks for them separately.
  assert.deepEqual(config.rules, [])
  assert.equal(config.listenPort, DEFAULT_LISTEN_PORT)
  assert.equal(config.socks.host, '')
  // Only the two rows a yds project always needs; node/curl are not auto-generated
  // (they would just be two more empty rows nobody asked for).
  assert.deepEqual(autoRules('w1').map((rule) => rule.program), ['java', 'git'])
  assert.equal(autoRules('w1').every((rule) => rule.enabled === false && rule.workspace === 'w1'), true)
})

test('one switch per program for the whole machine, workspace is only a label', () => {
  // ProxyBridge hooks the kernel and matches process names, so a rule cannot be
  // scoped to a workspace: two workspaces asking for `java` are the same switch,
  // and the first row keeps its provenance label.
  const config = normalizeConfig({
    rules: [
      { id: 'mine', program: 'Java', enabled: true, workspace: '/w1' },
      { id: 'mine-again', program: 'java', enabled: false, workspace: '/w1' },
      { id: 'other', program: 'java', enabled: true, workspace: '/w2' },
      { id: 'pinned', program: 'C:/Program Files/Navicat/navicat.exe', enabled: true, workspace: '/w2' },
    ],
  })
  assert.deepEqual(config.rules.map((rule) => `${rule.workspace}:${rule.program}`),
    ['/w1:Java', '/w2:C:/Program Files/Navicat/navicat.exe'])
})

test('driven endpoints keep their ids even when they share a program', () => {
  // The yds bridge writes one row per JDBC endpoint, all labelled `jdbc`: they are
  // destinations, not aliases of one program switch.
  const config = normalizeConfig({
    rules: [
      { id: 'yds-1', program: 'jdbc', hosts: '172.20.235.80', ports: '1521', enabled: true, source: 'yds' },
      { id: 'yds-2', program: 'jdbc', hosts: '172.20.235.81', ports: '6890', enabled: true, source: 'yds' },
    ],
  })
  assert.deepEqual(config.rules.map((rule) => rule.id), ['yds-1', 'yds-2'])
})

test('allow-list: every axis is required, and `*` is how you say "everything"', () => {
  const config = normalizeConfig({
    socks: { host: 'h', port: 1080 },
    rules: [
      { id: 'a', program: 'java', hosts: '172.20.235.*', ports: '1521', enabled: true },
      { id: 'b', program: 'off', hosts: '', ports: '', enabled: false },
    ],
  })
  const allow = allowList(config)
  assert.equal(allowAdmits(allow, '172.20.235.80', 1521), true)
  assert.equal(allowAdmits(allow, '172.20.235.80', 6890), false)
  assert.equal(allowAdmits(allow, '10.0.0.1', 1521), false)
  // A blank axis is a half-written row, not an unrestricted one: it contributes
  // nothing at all (that is what stops a typo from proxying the internet).
  const blank = allowList(normalizeConfig({ rules: [{ id: 'x', program: 'p', hosts: '', ports: '', enabled: true }] }))
  assert.equal(allowAdmits(blank, '1.2.3.4', 9999), false)
  // The explicit spelling does open it up.
  const open = allowList(normalizeConfig({ rules: [{ id: 'x', program: 'p', hosts: '*', ports: '*', enabled: true }] }))
  assert.equal(allowAdmits(open, '1.2.3.4', 9999), true)
  assert.equal(allowAdmits(allowList(normalizeConfig(undefined)), '1.2.3.4', 80), false)
})

test('shadow targets: opt-in, literal IPv4 only, same port, deduplicated', () => {
  const literal = normalizeConfig({ rules: [{ id: 'r', program: 'navicat', hosts: '172.20.235.80,172.20.235.80', ports: '1521,3306', enabled: true, shadow: true }] })
  assert.deepEqual(shadowTargets(literal), [
    { host: '172.20.235.80', port: 1521, localPort: 1521 },
    { host: '172.20.235.80', port: 3306, localPort: 3306 },
  ])
  const wildcard = normalizeConfig({ rules: [{ id: 'w', program: 'java', hosts: '10.0.0.*', ports: '1521', enabled: true, shadow: true }] })
  assert.deepEqual(shadowTargets(wildcard), [])
  // A program that speaks SOCKS needs no listener even when enabled + bindable.
  const capable = normalizeConfig({ rules: [{ id: 'c', program: 'java', hosts: '1.2.3.4', ports: '1521', enabled: true }] })
  assert.deepEqual(shadowTargets(capable), [])
  // A program that cannot (jdbc/navicat/…) is mapped automatically — that is the
  // only way it reaches the tunnel — unless the row says otherwise.
  const needsMap = normalizeConfig({ rules: [{ id: 'n', program: 'navicat', hosts: '1.2.3.4', ports: '1521', enabled: true }] })
  assert.deepEqual(shadowTargets(needsMap), [{ host: '1.2.3.4', port: 1521, localPort: 1521 }])
  const optedOut = normalizeConfig({ rules: [{ id: 'o', program: 'navicat', hosts: '1.2.3.4', ports: '1521', enabled: true, shadow: false }] })
  assert.deepEqual(shadowTargets(optedOut), [])
})

test('rule effectiveness: a rule only applies when EVERY axis is explicit and valid', () => {
  const base = { program: 'java', hosts: '1.2.3.4', ports: '1521', enabled: true }
  assert.deepEqual(ruleEffectiveness(base), { effective: true, reason: '' })
  assert.deepEqual(ruleEffectiveness({ ...base, hosts: '*', ports: '*' }), { effective: true, reason: '' })
  assert.deepEqual(ruleEffectiveness({ ...base, enabled: false }), { effective: false, reason: '未启用' })
  assert.deepEqual(ruleEffectiveness({ ...base, enabled: 'true' }), { effective: false, reason: '未启用' })
  assert.deepEqual(ruleEffectiveness({ ...base, program: '   ' }), { effective: false, reason: '缺程序' })
  assert.deepEqual(ruleEffectiveness({ ...base, hosts: '  ' }), { effective: false, reason: '缺 IP（全匹配写 *）' })
  assert.deepEqual(ruleEffectiveness({ ...base, ports: '  ' }), { effective: false, reason: '缺端口（全匹配写 *）' })
  // A bad fragment NEXT TO a good one must reject the row, not be dropped: a typo
  // would otherwise silently narrow the rule (or, worse, widen it) behind the
  // user's back. Only-invalid specs would hit the "missing" branch first, so the
  // valid fragment is what makes this the real invalid-fragment test.
  assert.deepEqual(ruleEffectiveness({ ...base, hosts: '1.2.3.4, bad host!' }), { effective: false, reason: 'IP 有无效片段' })
  assert.deepEqual(ruleEffectiveness({ ...base, ports: '1521, 70000' }), { effective: false, reason: '端口有无效片段' })
  assert.deepEqual(ruleEffectiveness(undefined), { effective: false, reason: '未启用' })
})

test('config caps: rules and shadow listeners are bounded', () => {
  const rules = Array.from({ length: MAX_RULES + 10 }, (_, index) => ({
    id: `r${index}`, program: `prog${index}`, hosts: '1.2.3.4', ports: '1521', enabled: true,
  }))
  assert.equal(normalizeConfig({ rules }).rules.length, MAX_RULES, 'a thousand rules is a typo, not a setup')
  const shadows = Array.from({ length: MAX_SHADOW_TARGETS + 5 }, (_, index) => ({
    host: '10.0.0.1', port: 3000 + index,
  }))
  assert.equal(normalizeConfig({ shadows }).shadows.length, MAX_SHADOW_TARGETS)
  // Derived targets are capped too, not only the explicitly stored fallback list.
  const hosts = Array.from({ length: 10 }, (_, index) => `10.0.${index}.1`).join(',')
  const ports = Array.from({ length: 10 }, (_, index) => 2000 + index).join(',')
  const derived = normalizeConfig({ rules: [{ id: 'many', program: 'navicat', hosts, ports, enabled: true, shadow: true }] })
  assert.equal(shadowTargets(derived).length, MAX_SHADOW_TARGETS)
})

test('injection: the default is the LOCAL CONNECT proxy, so rules stay enforced', () => {
  const config = normalizeConfig({
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [{ id: 'j', program: 'java', hosts: '172.20.235.*', ports: '1521', enabled: true }],
  })
  const injected = injectionFor('C:\\Program Files\\Java\\java.exe', config)
  // The program must NOT be handed the upstream SOCKS address directly: that
  // would let it reach anything the SOCKS server can and silently ignore the
  // rule's hosts/ports. It gets the engine's loopback CONNECT proxy instead, so
  // every connection passes the allow-list.
  assert.equal(injected.side, 'local')
  assert.equal(injected.direct, false)
  const local = `http://127.0.0.1:${DEFAULT_LISTEN_PORT}`
  assert.equal(injected.env.ALL_PROXY, local)
  assert.equal(injected.env.HTTP_PROXY, local)
  assert.equal(injected.env.HTTPS_PROXY, local)
  assert.equal(injected.env.http_proxy, local)
  assert.equal(injected.env.https_proxy, local)
  assert.equal(injected.env.NO_PROXY, DEFAULT_NO_PROXY)
  assert.equal(injected.env.no_proxy, DEFAULT_NO_PROXY)
  assert.equal(injected.httpProxyUrl, local)
  assert.equal(injected.socksUrl, 'socks5h://10.3.91.121:1080')
  assert.equal(Object.values(injected.env).includes('socks5h://10.3.91.121:1080'), false,
    'no injected variable may point at the upstream SOCKS server')
  // JVM: -DsocksProxyHost cannot point at an HTTP proxy, so the local path uses
  // the HTTP flags only (java ignores proxy env vars by default).
  assert.deepEqual(injected.jvmArgs, [
    '-Dhttp.proxyHost=127.0.0.1',
    `-Dhttp.proxyPort=${DEFAULT_LISTEN_PORT}`,
    '-Dhttps.proxyHost=127.0.0.1',
    `-Dhttps.proxyPort=${DEFAULT_LISTEN_PORT}`,
    '-Dhttp.nonProxyHosts=localhost|127.*|[::1]',
  ])
  assert.equal(injected.jvmArgs.some((arg) => arg.startsWith('-DsocksProxyHost')), false)
  // lib/index.js calls us with `side: engineSide()`; that is "local", so a
  // program started from the panel takes the same enforced path.
  assert.deepEqual(injectionFor('java', config, { side: engineSide() }).env, injected.env)
  assert.equal(programKey('C:\\x\\Navicat.exe'), 'navicat')
  assert.equal(programKey('/usr/bin/node'), 'node')
})

test('injection: `direct` is the ONLY way the upstream SOCKS reaches a program', () => {
  const config = normalizeConfig({
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [
      { id: 'plain', program: 'java', hosts: '*', ports: '*', enabled: true },
      { id: 'direct', program: 'git', hosts: '*', ports: '*', enabled: true, direct: true },
    ],
  })
  // Missing field ⇒ false, so every config file written before `direct` existed
  // — and every caller that does not restate it — keeps the safe path.
  assert.equal(config.rules[0].direct, false)
  assert.equal(injectionFor('java', config).direct, false)
  assert.equal(injectionFor('java', config).env.ALL_PROXY, `http://127.0.0.1:${DEFAULT_LISTEN_PORT}`)
  // An explicit true hands over the upstream address (the pre-M1 behaviour).
  const direct = injectionFor('git', config)
  assert.equal(direct.direct, true)
  assert.equal(direct.httpProxyUrl, null)
  assert.equal(direct.env.ALL_PROXY, 'socks5h://10.3.91.121:1080')
  assert.equal(direct.env.HTTPS_PROXY, 'socks5h://10.3.91.121:1080')
  assert.deepEqual(direct.jvmArgs, ['-DsocksProxyHost=10.3.91.121', '-DsocksProxyPort=1080'])
  // `direct` must survive the config round-trip, or a reload would silently flip
  // the enforcement path; a non-boolean must never be treated as true.
  assert.equal(normalizeConfig({ rules: [{ program: 'git', hosts: '*', ports: '*', direct: true }] }).rules[0].direct, true)
  assert.equal(normalizeConfig({ rules: [{ program: 'git', hosts: '*', ports: '*', direct: 'yes' }] }).rules[0].direct, false)
  // ...including an edit that does not restate it.
  const stored = normalizeConfig({ rules: [{ id: 'd', program: 'git', hosts: '*', ports: '*', enabled: true, direct: true }] })
  const merged = mergeConfigs(stored, { rules: [{ id: 'd', program: 'git', hosts: '*', ports: '*', enabled: true }] })
  assert.equal(merged.rules[0].direct, true, 'an edit that omits direct keeps the stored decision')
})

test('injection: the OS boundary and programs that cannot take a proxy address', () => {
  const config = normalizeConfig({
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [
      { id: 'j', program: 'java', hosts: '*', ports: '*', enabled: true },
      { id: 'g', program: 'git', hosts: '*', ports: '*', enabled: true, direct: true },
      { id: 'n', program: 'navicat', hosts: '1.2.3.4', ports: '1521', enabled: true },
    ],
  })
  // A program on the other side of WSL/Windows cannot reach this machine's
  // 127.0.0.1, so a non-direct row injects nothing there (the reason says so).
  const remote = injectionFor('java', config, { side: 'remote' })
  assert.equal(remote.side, 'remote')
  assert.deepEqual(remote.env, {})
  assert.match(remote.reason, /另一侧/)
  const otherSide = engineSide() === 'windows' ? 'wsl' : 'windows'
  assert.equal(injectionFor('java', config, { side: otherSide }).env.ALL_PROXY, undefined)
  // ...unless the row is direct, which needs no local listener.
  assert.equal(injectionFor('git', config, { side: 'remote' }).env.ALL_PROXY, 'socks5h://10.3.91.121:1080')
  // A client that cannot be told a proxy address reaches the tunnel only through
  // a same-port 127.0.0.1 listener; injection must not pretend otherwise.
  assert.equal(isSocksCapableProgram('navicat'), false)
  assert.equal(injectionFor('navicat', config), null)
  assert.equal(injectionFor('python', config), null)
  assert.equal(injectionFor('', config), null)
  // No upstream configured ⇒ nothing to inject.
  const noSocks = normalizeConfig({ rules: [{ program: 'java', hosts: '*', ports: '*', enabled: true }] })
  assert.equal(injectionFor('java', noSocks), null)
})

test('injection: a rule that names the program but leaves an axis blank injects nothing', () => {
  const config = normalizeConfig({
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [
      { id: 'half', program: 'java', hosts: '', ports: '', enabled: true },
      { id: 'off', program: 'git', hosts: '*', ports: '*', enabled: false },
    ],
  })
  const injected = injectionFor('java', config)
  assert.notEqual(injected, null, 'the rule matched, so the caller must be told WHY nothing was injected')
  assert.deepEqual(injected.env, {})
  assert.deepEqual(injected.jvmArgs, [])
  assert.equal(injected.direct, false)
  assert.match(injected.reason, /规则不完整/)
  assert.match(injected.reason, /缺 IP/)
  // An explicit `*` is effective and injects the loopback proxy.
  const open = normalizeConfig({
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [{ id: 'open', program: 'java', hosts: '*', ports: '*', enabled: true }],
  })
  assert.equal(injectionFor('java', open).env.HTTPS_PROXY, `http://127.0.0.1:${DEFAULT_LISTEN_PORT}`)
  // No enabled rule at all ⇒ no settings (not even a reason object).
  assert.equal(injectionFor('git', config), null)
})

test('JSONC config files round-trip through the ONE shared file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-proxy-'))
  try {
    const written = writeProxyConfig(dir, {
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [{ id: 'db', program: '', hosts: '172.20.235.80', ports: '1521', enabled: true }],
    })
    assert.equal(written.rules.find((rule) => rule.id === 'db').enabled, true)
    assert.equal(readProxyConfig(dir).socks.port, 1080)
    assert.equal(readProxyConfig(dir).rules.find((rule) => rule.id === 'db').enabled, true)
    // The file is machine-level: no workspace directory involved.
    assert.equal(proxyConfigPath(), join(process.env.DSH_RIS_IDE_PROXY_HOME, 'proxy.json'))
    assert.equal(proxyConfigPath().includes('.dsh-ris-ide/proxy.json'), false)
    // A hand-edited file keeps its comments and still parses.
    const text = `// mine\n${readFileSync(proxyConfigPath(), 'utf8')}`
    writeFileSync(proxyConfigPath(), text)
    assert.equal(readProxyConfig(dir).socks.host, '10.3.91.121')
    assert.equal(parseJsonc('{ "a": [1,2,], /* x */ "b": "c://d", }').b, 'c://d')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merge: replaceAllRules makes the payload the whole table (m10585)', () => {
  const stored = normalizeConfig({
    socks: { host: 'h', port: 1080 },
    rules: [
      { id: 'user-1', program: 'java', hosts: '1.1.1.*', ports: '443', enabled: true },
      { id: 'yds-old', program: 'git', hosts: '1.1.1.1', ports: '1521', enabled: true, source: 'yds' },
    ],
  })
  const merged = mergeConfigs(stored, {
    replaceAllRules: true,
    rules: [{ id: 'yds-new', program: 'java', hosts: '2.2.2.*', ports: '*', enabled: true, source: 'yds' }],
  })
  assert.deepEqual(merged.rules.map((rule) => rule.id), ['yds-new'])
})

test('merge: yds-owned rows are replaced wholesale, user rows survive', () => {
  const stored = normalizeConfig({
    socks: { host: 'h', port: 1080 },
    rules: [
      { id: 'user-1', program: 'java', hosts: '1.1.1.*', ports: '443', enabled: true },
      { id: 'yds-old', program: '', hosts: '1.1.1.1', ports: '1521', enabled: true, source: 'yds' },
    ],
  })
  const merged = mergeConfigs(stored, {
    replaceRulesFrom: 'yds',
    rules: [{ id: 'yds-new', hosts: '2.2.2.2', ports: '1521', enabled: true, source: 'yds' }],
  })
  assert.equal(merged.rules.some((rule) => rule.id === 'yds-old'), false)
  assert.equal(merged.rules.some((rule) => rule.id === 'yds-new'), true)
  assert.equal(merged.rules.some((rule) => rule.id === 'user-1'), true)
})

/**
 * A minimal SOCKS5 server that dials whatever CONNECT asks for — enough to run
 * the engine's real socket paths without an external tunnel.
 * @param onTarget - receives `host:port` of every CONNECT.
 * @returns `{ port, close }`.
 */
async function fakeSocks(onTarget) {
  const server = createServer((client) => {
    client.once('data', (greeting) => {
      if (greeting[0] !== 0x05) {
        client.destroy()
        return
      }
      client.write(Buffer.from([0x05, 0x00]))
      client.once('data', (request) => {
        const atyp = request[3]
        let host = ''
        let offset = 4
        if (atyp === 0x01) {
          host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const length = request[4]
          host = request.subarray(5, 5 + length).toString('utf8')
          offset = 5 + length
        } else {
          client.destroy()
          return
        }
        const port = (request[offset] << 8) | request[offset + 1]
        onTarget(`${host}:${port}`)
        const upstream = connect({ host, port }, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** An unused loopback port (a fixed one collides with a straggler from a rebuild). */
async function freePort(host = '127.0.0.1') {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, host, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A one-line HTTP target that answers the request body with its own port. */
async function targetServer(port) {
  const server = createServer((socket) => {
    socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.2', resolve))
  return { close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Speak HTTP CONNECT to the engine and report the status line. */
function connectThrough(port, host, targetPort) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`)
    })
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (text.includes('\r\n')) {
        socket.destroy()
        resolve(text.split('\r\n')[0])
      }
    })
    socket.on('error', () => resolve('socket-error'))
    socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout') })
  })
}

/**
 * A SOCKS5 server whose behaviour per connection is scripted by the caller — the
 * only way to exercise handshake edge cases (split replies, bad ATYP, refused
 * CONNECT) that a well-behaved server never produces.
 * @param script - receives the client socket right after accept.
 * @returns `{ port, close }`; `close` destroys any still-open socket first.
 */
async function scriptedSocks(script) {
  const sockets = new Set()
  const server = createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    script(client)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Answer the SOCKS5 greeting, then run `onRequest` for the CONNECT request.
 * @param client - accepted socket.
 * @param onRequest - called after the CONNECT request arrives.
 */
function socksHandshake(client, onRequest) {
  client.once('data', (greeting) => {
    if (greeting[0] !== 0x05) {
      client.destroy()
      return
    }
    client.write(Buffer.from([0x05, 0x00]))
    client.once('data', (request) => onRequest(request, client))
  })
}

/** Resolve with the next chunk read from `socket`, or reject after `timeoutMs`. */
function firstData(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tunnel data arrived')), timeoutMs)
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      resolve(chunk)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    // connectSocks leaves the socket paused so bytes coalesced with the reply are
    // not emitted before the caller attaches; reading directly must resume it.
    socket.resume()
  })
}

/**
 * An HTTP origin on a loopback alias that records the request head it receives,
 * so a test can prove what the engine actually forwarded.
 * @param host - loopback address to bind.
 * @param port - port to bind.
 * @returns `{ requests, close }`.
 */
async function recordingTarget(host, port) {
  const requests = []
  const server = createServer((socket) => {
    let text = ''
    let recorded = false
    socket.on('data', (chunk) => {
      if (recorded) return
      text += chunk.toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      recorded = true
      requests.push(text)
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
  })
  await new Promise((resolve) => server.listen(port, host, resolve))
  return { requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Send an HTTP exchange to the engine's CONNECT proxy and return the reply text. */
function httpThrough(port, request, options = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, async () => {
      if (Array.isArray(options.chunks)) {
        for (const chunk of options.chunks) {
          socket.write(chunk)
          if (options.gapMs > 0) await sleep(options.gapMs)
        }
        return
      }
      socket.write(request)
    })
    let text = ''
    socket.on('data', (chunk) => { text += chunk.toString('latin1') })
    socket.on('close', () => resolve(text))
    socket.on('error', () => resolve('socket-error'))
    socket.setTimeout(4000, () => { socket.destroy(); resolve('timeout') })
  })
}

test('engine: shadow listener + CONNECT allow-list, real sockets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-engine-'))
  const targets = []
  const socks = await fakeSocks((target) => targets.push(target))
  const shadowPort = await freePort('127.0.0.2')
  const listenPort = await freePort('127.0.0.1')
  const connectPort = await freePort('127.0.0.2')
  const target = await targetServer(shadowPort)
  // The CONNECT destination must be a real listener, or the engine rightly 502s.
  const connectTarget = await targetServer(connectPort)
  try {
    writeProxyConfig(dir, {
      socks: { host: '127.0.0.1', port: socks.port },
      listenPort,
      rules: [
        { id: 'shadow', program: 'probe-shadow', hosts: '127.0.0.2', ports: String(shadowPort), enabled: true, shadow: true },
        // Explicit false: a blank program row would otherwise auto-map (the
        // client behind it is unknown, and unmapped-by-default would strand it).
        { id: 'connect', program: 'probe-connect', hosts: '127.0.0.2', ports: String(connectPort), enabled: true, shadow: false },
      ],
    })
    const started = await startProxy(dir, { waitMs: 60 })
    assert.equal(started.ok, true, started.error)
    const status = await proxyStatus(dir)
    assert.equal(status.running, true)
    assert.deepEqual(status.listen.map((item) => item.port).sort(), [shadowPort, listenPort].sort())
    assert.equal(status.listen.every((item) => item.open), true)
    // Same-port shadow listener: a client that only knows 127.0.0.1 gets through.
    const viaShadow = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: shadowPort }, () => socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
      let text = ''
      socket.on('data', (chunk) => { text += chunk.toString('latin1') })
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve('err'))
    })
    assert.match(viaShadow, /200 OK/)
    assert.deepEqual(targets.slice(-1), [`127.0.0.2:${shadowPort}`])
    // CONNECT to an allowed destination succeeds…
    assert.match(await connectThrough(listenPort, '127.0.0.2', connectPort), /200 Connection Established/)
    // …and a destination outside the rules is refused by the allow-list.
    assert.match(await connectThrough(listenPort, '127.0.0.2', connectPort + 1), /403 Forbidden/)
    // A second start is idempotent; stop really stops.
    assert.equal((await startProxy(dir)).alreadyRunning, true)
    assert.equal((await stopProxy(dir)).stopped, true)
    assert.equal((await proxyStatus(dir)).running, false)
  } finally {
    await stopProxy(dir).catch(() => undefined)
    await socks.close()
    await target.close()
    await connectTarget.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SOCKS5: a split domain reply is never accepted before it is complete', async () => {
  // 05 00 00 03 0b "example.com" 00 50 — an 18-byte reply for ATYP=domain.
  const reply = Buffer.concat([
    Buffer.from([0x05, 0x00, 0x00, 0x03, 11]),
    Buffer.from('example.com'),
    Buffer.from([0x00, 80]),
  ])
  let fragmentSent = false
  const socks = await scriptedSocks((client) => {
    socksHandshake(client, () => {
      client.write(reply.subarray(0, 4))
      fragmentSent = true
      setTimeout(() => client.write(reply.subarray(4)), 80)
    })
  })
  let upstream = null
  try {
    let settledWith = 'pending'
    const pending = connectSocks({ host: '127.0.0.1', port: socks.port }, 'example.com', 80)
    pending.then((socket) => { upstream = socket; settledWith = 'resolved' }, () => { settledWith = 'rejected' })
    for (let attempt = 0; attempt < 100 && fragmentSent !== true; attempt += 1) await sleep(5)
    await sleep(25)
    // Four bytes are a header fragment, not a reply. The old `length < 4` guard
    // (and the NaN successor that replaced it) resolved right here and leaked
    // the remaining handshake bytes into the tunnel as garbage.
    assert.equal(settledWith, 'pending')
    await pending
    assert.equal(settledWith, 'resolved')
  } finally {
    upstream?.destroy()
    await socks.close()
  }
})

test('SOCKS5: bytes coalesced with the reply tail stay in the tunnel stream', async () => {
  const socks = await scriptedSocks((client) => {
    socksHandshake(client, () => {
      // One write: the reply and the first tunnel bytes share a TCP segment.
      client.write(Buffer.concat([
        Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
        Buffer.from('HELLO'),
      ]))
    })
  })
  let upstream = null
  try {
    upstream = await connectSocks({ host: '127.0.0.1', port: socks.port }, '127.0.0.1', 25)
    // Dropping the tail would leave the caller with a silent tunnel: a protocol
    // that answers immediately loses its first bytes.
    assert.equal((await firstData(upstream)).toString(), 'HELLO')
  } finally {
    upstream?.destroy()
    await socks.close()
  }
})

test('SOCKS5: IPv6 replies are accepted, unknown ATYP / refused CONNECT are not', async () => {
  // 22-byte IPv6 reply (ATYP=4: 4-byte header + 16-byte address + 2-byte port),
  // deliberately split mid-header.
  const ipv6Reply = Buffer.from([0x05, 0x00, 0x00, 0x04, ...Array(16).fill(0), 0x00, 0x50])
  assert.equal(ipv6Reply.length, 22)
  const okSocks = await scriptedSocks((client) => {
    socksHandshake(client, () => {
      client.write(ipv6Reply.subarray(0, 5))
      setTimeout(() => client.write(ipv6Reply.subarray(5)), 30)
    })
  })
  let upstream = null
  try {
    upstream = await connectSocks({ host: '127.0.0.1', port: okSocks.port }, '::1', 80)
    assert.equal(upstream !== null, true)
  } finally {
    upstream?.destroy()
    await okSocks.close()
  }
  const badAtyp = await scriptedSocks((client) => {
    socksHandshake(client, () => client.write(Buffer.from([0x05, 0x00, 0x00, 0x09, 0, 0, 0, 0, 0, 0])))
  })
  try {
    await assert.rejects(connectSocks({ host: '127.0.0.1', port: badAtyp.port }, '1.2.3.4', 80), /ATYP=9/)
  } finally {
    await badAtyp.close()
  }
  const refused = await scriptedSocks((client) => {
    socksHandshake(client, () => client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])))
  })
  try {
    await assert.rejects(connectSocks({ host: '127.0.0.1', port: refused.port }, '1.2.3.4', 80), /connection refused/)
  } finally {
    await refused.close()
  }
})

test('SOCKS5: greeting failures and a missing upstream reject, never hang', async () => {
  const notSocks = await scriptedSocks((client) => {
    client.once('data', () => client.write(Buffer.from([0x04, 0x00])))
  })
  try {
    await assert.rejects(connectSocks({ host: '127.0.0.1', port: notSocks.port }, '1.2.3.4', 80), /not a SOCKS5 server/)
  } finally {
    await notSocks.close()
  }
  const needsAuth = await scriptedSocks((client) => {
    client.once('data', () => client.write(Buffer.from([0x05, 0x02])))
  })
  try {
    await assert.rejects(connectSocks({ host: '127.0.0.1', port: needsAuth.port }, '1.2.3.4', 80), /auth rejected/)
  } finally {
    await needsAuth.close()
  }
  const badVersion = await scriptedSocks((client) => {
    socksHandshake(client, () => client.write(Buffer.from([0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])))
  })
  try {
    await assert.rejects(connectSocks({ host: '127.0.0.1', port: badVersion.port }, '1.2.3.4', 80), /回包版本不是 5/)
  } finally {
    await badVersion.close()
  }
  await assert.rejects(connectSocks({}, '1.2.3.4', 80), /not configured/)
})

test('engine: absolute-form HTTP is rewritten to origin-form, per connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-http-'))
  const socks = await fakeSocks(() => undefined)
  const listenPort = await freePort('127.0.0.1')
  const httpPort = await freePort('127.0.0.2')
  const deniedPort = await freePort('127.0.0.2')
  const target = await recordingTarget('127.0.0.2', httpPort)
  try {
    writeProxyConfig(dir, {
      socks: { host: '127.0.0.1', port: socks.port },
      listenPort,
      rules: [{ id: 'http', program: 'probe-http', hosts: '127.0.0.2', ports: String(httpPort), enabled: true, shadow: false }],
    })
    const started = await startProxy(dir, { waitMs: 60 })
    assert.equal(started.ok, true, started.error)
    // 1) absolute-form is accepted, and the origin server sees origin-form.
    const ok = await httpThrough(listenPort, `GET http://127.0.0.2:${httpPort}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.2:${httpPort}\r\nConnection: close\r\n\r\n`)
    assert.match(ok, /200 OK/)
    assert.match(target.requests[0], /^GET \/path\?q=1 HTTP\/1\.1/)
    assert.equal(target.requests[0].includes('http://127.0.0.2'), false, 'the absolute URL must not reach the origin')
    assert.equal(target.requests[0].includes(`Host: 127.0.0.2:${httpPort}`), true, 'other headers are preserved')
    // 2) a request head split across packets is buffered, not 400'd.
    const fragmented = await httpThrough(listenPort, null, {
      chunks: [`GET http://127.0.0.2:${httpPort}/frag HTTP/1.1\r\nHost: x\r\n`, '\r\n'],
      gapMs: 40,
    })
    assert.match(fragmented, /200 OK/)
    assert.match(target.requests[1], /^GET \/frag HTTP\/1\.1/)
    // 3) https:// in absolute form is a protocol error, not something to guess:
    // forwarding plaintext to a TLS port merely resets the connection, so answer
    // 400 with a reason the caller can act on. The host IS allowed by the rules,
    // which proves the scheme check runs before the dial.
    const tls = await httpThrough(listenPort, `GET https://127.0.0.2:${httpPort}/tls HTTP/1.1\r\nHost: 127.0.0.2:${httpPort}\r\n\r\n`)
    assert.match(tls, /400 Bad Request/)
    assert.match(tls, /X-Proxy-Error: https requires CONNECT/)
    assert.match(tls, /HTTPS_PROXY/)
    assert.equal(target.requests.length, 2, 'nothing is dialled for an https absolute-form request')
    // 4) a destination outside the rules is denied before any dial, and the
    // reason is visible in the response header.
    const denied = await httpThrough(listenPort, `GET http://127.0.0.2:${deniedPort}/nope HTTP/1.1\r\nHost: x\r\n\r\n`)
    assert.match(denied, /403 Forbidden/)
    assert.equal(denied.includes('X-Proxy-Denied'), true)
    // 5) an origin-form request line is not a proxy request: reject, never guess.
    const relative = await httpThrough(listenPort, `GET /relative HTTP/1.1\r\nHost: x\r\n\r\n`)
    assert.match(relative, /400 Bad Request/)
  } finally {
    await stopProxy(dir).catch(() => undefined)
    await socks.close()
    await target.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('engine pid: a pidfile naming a stranger is discarded, never trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-pid-'))
  mkdirSync(proxyHomeDir(), { recursive: true })
  try {
    // Our own pid is alive but carries no engine marker.
    writeFileSync(proxyPidPath(), String(process.pid))
    assert.equal(pidIsProxy(process.pid), false)
    assert.equal(proxyPid(dir), null)
    assert.equal(existsSync(proxyPidPath()), false, 'the foreign pidfile is removed')
    // startProxy must not report "already running" for it: the next check (no
    // upstream configured) is what fails, which proves identity came first.
    writeFileSync(proxyPidPath(), String(process.pid))
    const started = await startProxy(dir, { config: normalizeConfig({}) })
    assert.equal(started.ok, false)
    assert.notEqual(started.alreadyRunning, true)
    assert.match(started.error, /上游 SOCKS/)
    // stopProxy must never signal a stranger either.
    writeFileSync(proxyPidPath(), String(process.pid))
    assert.deepEqual(await stopProxy(dir), { ok: true, stopped: false })
    assert.equal(pidAlive(process.pid), true)
  } finally {
    rmSync(proxyPidPath(), { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('engine pid: a dead pidfile is cleared', () => {
  mkdirSync(proxyHomeDir(), { recursive: true })
  try {
    writeFileSync(proxyPidPath(), '999999999')
    assert.equal(proxyPid(), null)
    assert.equal(existsSync(proxyPidPath()), false)
  } finally {
    rmSync(proxyPidPath(), { force: true })
  }
})

test('engine pid: a marker-carrying process is reused and stoppable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ris-ide-pid-'))
  mkdirSync(proxyHomeDir(), { recursive: true })
  // `node -e CODE --marker=X` is read as a NODE OPTION, not as a script argument:
  // node prints "bad option: --marker=…" and exits immediately, so the child was
  // only sometimes seen alive in /proc (this test failed ~half the time on CI while
  // passing locally). `--` ends option parsing, so the marker reaches the child's
  // argv — and the child stays alive for the 60 s of its setTimeout.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', `--marker=${PROXY_MARKER}`], { stdio: 'ignore' })
  let exited = false
  child.once('exit', () => { exited = true })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100 && ready !== true; attempt += 1) {
      ready = pidIsProxy(child.pid) === true
      if (ready !== true) await sleep(20)
    }
    assert.equal(ready, true, 'the test child must look like the engine (marker in argv)')
    writeFileSync(proxyPidPath(), String(child.pid))
    assert.equal(proxyPid(dir), child.pid)
    // Re-check right before the reuse call: if the child died in between, `startProxy`
    // would see a stale/absent pidfile and try to spawn a REAL engine — leaving it
    // running and binding the loopback ports after the test (that is what hung CI).
    assert.equal(pidIsProxy(child.pid), true, 'the test child must still be alive before the reuse check')
    const started = await startProxy(dir, { config: normalizeConfig({}) })
    assert.equal(started.alreadyRunning, true)
    assert.equal(started.pid, child.pid)
    assert.equal((await stopProxy(dir, { graceMs: 3000 })).stopped, true)
    for (let attempt = 0; attempt < 100 && exited !== true; attempt += 1) await sleep(20)
    assert.equal(exited, true)
  } finally {
    // If the reuse path was missed, `startProxy` may have spawned a real engine and
    // left it owning 127.0.0.1:11081 — kill whatever the pidfile names, then the child.
    try { await stopProxy(dir, { graceMs: 3000 }) } catch { /* nothing to stop */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    rmSync(proxyPidPath(), { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reading a workspace that still has the old per-workspace file migrates it', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ris-legacy-ws-'))
  const machine = process.env.DSH_RIS_IDE_PROXY_HOME
  const saved = join(machine, 'proxy.json')
  try {
    // Start from "no shared config", with the legacy file inside the workspace.
    rmSync(saved, { force: true })
    mkdirSync(join(ws, '.dsh-ris-ide'), { recursive: true })
    writeFileSync(join(ws, '.dsh-ris-ide', 'proxy.json'), JSON.stringify({
      socks: { host: '10.3.91.121', port: 1080 },
      rules: [{ id: 'old', program: 'navicat', hosts: '1.2.3.4', ports: '1521', enabled: true, shadow: true }],
    }))
    const config = readProxyConfig(ws)
    assert.equal(config.socks.host, '10.3.91.121', 'the legacy rules are still honoured')
    assert.equal(config.rules[0].workspace, ws, 'and labelled with the workspace they came from')
    // Nothing is written until a save: reading must not move files around.
    assert.equal(existsSync(saved), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('a rule keeps its provider label for the dialog and the profile', () => {
  const config = normalizeConfig({
    socks: { host: '10.0.0.1', port: 1080 },
    rules: [
      { id: 'yds-yoncode-java', label: '  YonCode java  ', program: 'D:\\YonCode\\devkit\\*\\bin\\java.exe', hosts: '172.20.235.*', ports: '', enabled: true, source: 'yds' },
      { id: 'plain', program: 'git', hosts: 'example.com', ports: '', enabled: true },
    ],
  })
  assert.equal(config.rules[0].label, 'YonCode java')
  assert.equal(config.rules[1].label, '', 'an unlabelled row stays empty, not undefined')
})


test('a driven rule keeps its per-workspace owners across a config round trip', () => {
  // yds writes one merged row per program with an `owners` map. Rebuilding rules
  // from a fixed field list dropped it, after which `yds stop` could no longer
  // withdraw only its own endpoints (review D-P0-1).
  const owners = {
    '/ws/a': { program: 'java', hosts: '10.0.0.1', ports: '*', enabled: true, shadow: false, direct: false },
    '/ws/b': { program: 'java.exe', hosts: '10.0.0.2,10.0.0.3', ports: '*', enabled: true, shadow: true, direct: false },
  }
  const config = normalizeConfig({
    socks: { host: '127.0.0.1', port: 1080 },
    rules: [{
      id: 'yds-java', label: 'yds java', program: 'java', hosts: '10.0.0.1,10.0.0.2,10.0.0.3', ports: '*',
      enabled: true, shadow: false, direct: false, source: 'yds', workspace: '/ws/b', owners,
    }],
  })
  const rule = config.rules.find((row) => row.id === 'yds-java')
  assert.ok(rule, 'the driven row survives')
  assert.deepEqual(Object.keys(rule.owners), ['/ws/a', '/ws/b'])
  assert.equal(rule.owners['/ws/b'].hosts, '10.0.0.2,10.0.0.3')
  assert.equal(rule.owners['/ws/b'].shadow, true)
  // A row without owners must not gain an empty one.
  const plain = normalizeConfig({ rules: [{ id: 'p', program: 'git', hosts: '*', ports: '*' }] })
  assert.equal(plain.rules[0].owners, undefined)
})
