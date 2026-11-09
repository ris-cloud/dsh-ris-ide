/**
 * Phase 1b P4: the daemon is the only writer of the machine-wide rule table.
 *
 * The acceptance that matters here is the one the old plugin-side CAS only
 * approximated: two windows posting the same base revision must not both win, and
 * the loser must be told the revision that IS current (so it can reload instead of
 * guessing). The daemon also serves the same injection the engine would produce —
 * one implementation, two callers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { RISD_API_VERSION } from '../lib/risd/state.js'
import { readProxyConfig } from '../lib/proxy.js'
import { risdConfigRevision } from '../lib/risd/view.js'
import { makeHome, removeHome, startRisdProcess } from './risd-helpers.mjs'

const FIXTURE = {
  socks: { host: 'proxy.example.com', port: 10080 },
  listenPort: 11081,
  rules: [
    { id: 'keep', program: 'git', hosts: 'git.example.com', ports: '*', enabled: true, shadow: false, source: 'user', workspace: '/tmp/ws' },
    { id: 'direct-java', program: 'java', hosts: '172.20.235.*', ports: '*', enabled: true, shadow: false, source: 'user', workspace: '/tmp/ws', direct: true },
  ],
  shadows: [],
}

function call(state, path, { method = 'GET', body = undefined } = {}) {
  const headers = {
    authorization: `Bearer ${state.token}`,
    'x-risd-api-version': String(RISD_API_VERSION),
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${state.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

async function startFixture(t) {
  const home = makeHome('risd-write-')
  const saved = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = saved
    removeHome(home)
  })
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify(FIXTURE, null, 2)}\n`, { mode: 0o600 })
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home } })
  t.after(() => daemon.stop())
  // The daemon refuses a cwd that does not exist (a write for a deleted workspace
  // would create rules nobody asked for), so the fixture owns a real one.
  const cwd = mkdtempSync(join(tmpdir(), 'risd-write-ws-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  return { home, state: daemon.state, cwd }
}

function rowsFor(id, program) {
  return [{ id, program, hosts: 'example.test', ports: '*', enabled: true, shadow: false, source: 'user' }]
}

test('two concurrent writes: exactly one wins, the loser gets 409 with the live revision', async (t) => {
  const { home, state, cwd } = await startFixture(t)
  const base = risdConfigRevision(readProxyConfig(cwd))
  assert.equal(base, risdConfigRevision(FIXTURE), 'fixture revision is the one clients see')

  const [a, b] = await Promise.all([
    call(state, '/v1/proxy', { method: 'POST', body: { cwd, revision: base, config: { socks: FIXTURE.socks, listenPort: 11081, rules: rowsFor('write-a', 'node') } } }),
    call(state, '/v1/proxy', { method: 'POST', body: { cwd, revision: base, config: { socks: FIXTURE.socks, listenPort: 11081, rules: rowsFor('write-b', 'curl') } } }),
  ])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [200, 409], 'one write, one conflict')

  const loser = a.status === 409 ? a : b
  const conflict = await loser.json()
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.code, 'conflict')
  assert.equal(conflict.message, '规则表已在别处被修改，本次改动未写入')
  assert.equal(conflict.revision, risdConfigRevision(readProxyConfig(cwd)), 'the conflict names the current revision')

  const onDisk = JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8'))
  const ids = onDisk.rules.map((rule) => rule.id)
  assert.equal(ids.filter((id) => id === 'write-a' || id === 'write-b').length, 1, 'exactly one new row landed')
  // The incoming table is authoritative for non-yds rows (that is how the panel's
  // full-table save works), so fixture rows absent from it are retired on purpose.
  assert.equal(ids.includes('keep'), false, 'the losing table did not leak its rows')
})

test('a stale revision never lands, and an empty one is the deliberate force path', async (t) => {
  const { cwd, state } = await startFixture(t)
  const stale = await call(state, '/v1/proxy', {
    method: 'POST',
    body: { cwd, revision: '000000000000', config: { socks: FIXTURE.socks, listenPort: 11081, rules: rowsFor('stale', 'node') } },
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).revision, risdConfigRevision(readProxyConfig(cwd)))

  const forced = await call(state, '/v1/proxy', {
    method: 'POST',
    body: { cwd, revision: '', config: { socks: FIXTURE.socks, listenPort: 11081, rules: rowsFor('forced', 'node') } },
  })
  assert.equal(forced.status, 200)
  assert.ok(readProxyConfig(cwd).rules.some((rule) => rule.id === 'forced'))
})

test('injection is the same object the engine would inject (direct vs allow-list)', async (t) => {
  const { cwd, state } = await startFixture(t)

  const allowed = await call(state, `/v1/injection?cwd=${encodeURIComponent(cwd)}&program=git`)
  assert.equal(allowed.status, 200)
  const allow = await allowed.json()
  assert.equal(allow.ok, true)
  assert.equal(allow.injection.direct, false)
  assert.equal(allow.injection.httpProxyUrl, 'http://127.0.0.1:11081')
  assert.equal(allow.injection.env.HTTP_PROXY, 'http://127.0.0.1:11081')
  assert.equal(allow.injection.env.NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.ok(allow.injection.jvmArgs.includes('-Dhttp.proxyPort=11081'))
  assert.equal(allow.injection.jvmArgs.some((arg) => arg.startsWith('-DsocksProxyHost=')), false)

  const direct = await call(state, `/v1/injection?cwd=${encodeURIComponent(cwd)}&program=java`)
  const bypass = await direct.json()
  assert.equal(bypass.injection.direct, true)
  assert.equal(bypass.injection.jvmArgs[0], '-DsocksProxyHost=proxy.example.com')
  assert.equal(bypass.injection.env.ALL_PROXY, 'socks5h://proxy.example.com:10080')

  const missing = await call(state, `/v1/injection?cwd=${encodeURIComponent(cwd)}&program=node`)
  assert.equal(missing.status, 200)
  assert.equal((await missing.json()).injection, null, 'no enabled rule for node → nothing injected')
})

test('a save re-points the scoped git entry instead of hiding the old host', async (t) => {
  const home = makeHome('risd-git-save-')
  const gitconfig = join(home, 'gitconfig')
  writeFileSync(gitconfig, '')
  const savedHome = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const rules = (host) => [{ id: 'yds-git', program: 'git', hosts: host, ports: '*', enabled: true, shadow: false, source: 'user' }]
  const table = (host) => ({ socks: { host: '127.0.0.1', port: 1080 }, listenPort: 11081, rules: rules(host), shadows: [] })
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify(table('git-old.example'), null, 2)}\n`, { mode: 0o600 })
  const daemon = await startRisdProcess({ home, env: { DSH_RIS_IDE_PROXY_HOME: home, GIT_CONFIG_GLOBAL: gitconfig } })
  const cwd = mkdtempSync(join(tmpdir(), 'risd-git-save-ws-'))
  t.after(() => {
    daemon.stop()
    rmSync(cwd, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = savedHome
    removeHome(home)
  })
  const value = (key) => {
    const out = spawnSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf8',
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: gitconfig }),
    })
    return String(out.stdout ?? '').trim()
  }

  const first = await call(daemon.state, '/v1/proxy', { method: 'POST', body: { cwd, revision: '', config: table('git-old.example') } })
  assert.equal(first.status, 200)
  assert.equal(value('http.https://git-old.example/.proxy'), 'socks5h://127.0.0.1:1080')

  const second = await call(daemon.state, '/v1/proxy', { method: 'POST', body: { cwd, revision: '', config: table('git-new.example') } })
  assert.equal(second.status, 200)
  const body = await second.json()
  assert.equal(body.git?.host, 'git-new.example', 'the save reports the host it applied')
  assert.equal(value('http.https://git-old.example/.proxy'), '', 'the old host entry must be removed, not left behind')
  assert.equal(value('http.https://git-new.example/.proxy'), 'socks5h://127.0.0.1:1080')
})
