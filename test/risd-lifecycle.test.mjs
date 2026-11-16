// Lifecycle settings: each resource has a start half and a stop half for "follows
// dsh" (m03397). Defaults must preserve the behaviour that existed before the
// setting (proxy follows dsh, everything else stops with the daemon), a legacy
// `followDsh` file must migrate to both halves, and a broken policy file must never
// take the daemon down.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LIFECYCLE_DEFAULTS,
  lifecyclePath,
  mergeLifecycle,
  normalizeLifecycle,
  readLifecycle,
  writeLifecycle,
} from '../lib/risd/lifecycle.js'
import { api, makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'
import { HAS_BASH, skipWithout } from './helpers/cmd.mjs'

test('defaults match the behaviour from before the setting existed', () => {
  const { value, errors } = normalizeLifecycle({})
  assert.deepEqual(errors, [])
  assert.deepEqual(value, LIFECYCLE_DEFAULTS)
  assert.equal(value.daemon.startWithDsh, true, 'the daemon start half is forced on')
  assert.equal(value.daemon.stopWithDsh, true, 'an idle daemon retires by default')
  assert.equal(value.proxy.startWithDsh, true, 'the proxy follows dsh out of the box')
  assert.equal(value.proxy.stopWithDsh, true)
  assert.equal(value.programs.startWithDsh, false, 'opening dsh must not restore JVMs by default')
  assert.equal(value.programs.stopWithDsh, false, 'closing the last dsh must not stop JVMs by default')
  assert.equal(value.debug.stopWithDsh, false)
  assert.equal('startWithDsh' in value.debug, false, 'a debug session has nothing to auto-start')
})

test('a legacy followDsh file migrates to both halves, and typos are rejected', () => {
  // Files written before m03397 carry one knob per resource. Both halves took it, so
  // reading the old file must keep the old behaviour exactly.
  const legacy = normalizeLifecycle({ daemon: { followDsh: false }, proxy: { followDsh: false }, programs: { followDsh: true }, debug: { followDsh: true } })
  assert.deepEqual(legacy.errors, [])
  assert.equal(legacy.value.daemon.startWithDsh, true, 'the daemon start half is forced on')
  assert.equal(legacy.value.daemon.stopWithDsh, false)
  assert.equal(legacy.value.proxy.startWithDsh, false)
  assert.equal(legacy.value.proxy.stopWithDsh, false)
  assert.equal(legacy.value.programs.startWithDsh, true)
  assert.equal(legacy.value.programs.stopWithDsh, true)
  assert.equal(legacy.value.debug.stopWithDsh, true, 'debug only has a stop half')
  assert.equal('startWithDsh' in legacy.value.debug, false)

  // An explicit half in the same payload wins over the legacy knob (a caller can
  // move one half without rewriting the file).
  const mixed = normalizeLifecycle({ proxy: { followDsh: false, startWithDsh: true } })
  assert.deepEqual(mixed.errors, [])
  assert.equal(mixed.value.proxy.startWithDsh, true)
  assert.equal(mixed.value.proxy.stopWithDsh, false, 'the legacy value still fills the other half')

  const bad = normalizeLifecycle({ proxy: { stopWithDsh: 'yes' } })
  assert.equal(bad.changed, false)
  assert.match(bad.errors.join(';'), /proxy\.stopWithDsh 必须是 true\/false/)

  // A partial save over what is in force keeps the value.
  const current = normalizeLifecycle({ proxy: { followDsh: false } }).value
  const merged = normalizeLifecycle(mergeLifecycle(current, { programs: { stopWithDsh: true } })).value
  assert.equal(merged.proxy.stopWithDsh, false)
  assert.equal(merged.programs.stopWithDsh, true)
  assert.equal(merged.programs.startWithDsh, false)
})

test('the halves a resource cannot have are rejected, not silently dropped', () => {
  // The daemon's start half is forced (a plugin must be able to ask for a daemon).
  const forcedStart = normalizeLifecycle({ daemon: { startWithDsh: false } })
  assert.equal(forcedStart.changed, false)
  assert.match(forcedStart.errors.join(';'), /daemon\.startWithDsh 不可配置/)

  // A debug session belongs to a page: there is no auto-start to switch.
  const debugStart = normalizeLifecycle({ debug: { startWithDsh: true } })
  assert.equal(debugStart.changed, false)
  assert.match(debugStart.errors.join(';'), /debug\.startWithDsh 不是可配置项（只能配置 stopWithDsh）/)

  // Following the daemon stays forced (m07741).
  const forced = normalizeLifecycle({ proxy: { startWithDsh: true, followDaemon: false }, programs: { followDaemon: false } })
  assert.equal(forced.changed, false)
  assert.equal(forced.errors.length, 2)
  assert.match(forced.errors.join(';'), /proxy\.followDaemon 不再支持：所有资源强制跟随 daemon/)
  assert.equal('followDaemon' in forced.value.proxy, false)
  assert.equal('followDaemon' in forced.value.programs, false)

  const bad = normalizeLifecycle({ proxy: { startWithDsh: 'yes' }, debug: 'nope' })
  assert.equal(bad.changed, false)
  assert.equal(bad.errors.length, 2)
  assert.match(bad.errors.join(';'), /proxy\.startWithDsh 必须是 true\/false/)
  assert.match(bad.errors.join(';'), /debug 必须是对象/)
})

test('partial input keeps the untouched defaults and rejects non-booleans', () => {
  const partial = normalizeLifecycle({ programs: { stopWithDsh: true } })
  assert.deepEqual(partial.errors, [])
  assert.equal(partial.value.programs.stopWithDsh, true)
  assert.equal(partial.value.programs.startWithDsh, false, 'the other half keeps its default')
  assert.equal(partial.value.proxy.stopWithDsh, true)

  // Following the daemon is forced (m07741): the old key is rejected, not stored.
  const forced = normalizeLifecycle({ proxy: { followDsh: true, followDaemon: false }, programs: { followDaemon: false } })
  assert.equal(forced.changed, false)
  assert.equal(forced.errors.length, 2)
  assert.match(forced.errors.join(';'), /proxy\.followDaemon 不再支持：所有资源强制跟随 daemon/)
  assert.equal('followDaemon' in forced.value.proxy, false)
  assert.equal('followDaemon' in forced.value.programs, false)

  const bad = normalizeLifecycle({ proxy: { followDsh: 'yes' }, debug: 'nope' })
  assert.equal(bad.changed, false)
  assert.equal(bad.errors.length, 2)
  assert.match(bad.errors.join(';'), /proxy\.followDsh 必须是 true\/false/)
  assert.match(bad.errors.join(';'), /debug 必须是对象/)
})

test('a partial save merges over the policy in force', () => {
  // POST /v1/config used to normalize the body alone, so saving one checkbox reset
  // the other three resources to their defaults (review A2-P2-1).
  const current = normalizeLifecycle({ proxy: { stopWithDsh: false }, debug: { stopWithDsh: true } }).value
  const merged = normalizeLifecycle(mergeLifecycle(current, { programs: { startWithDsh: true } })).value
  assert.equal(merged.programs.startWithDsh, true, 'the submitted half changed')
  assert.equal(merged.programs.stopWithDsh, false, 'the sibling half kept its default')
  assert.equal(merged.proxy.stopWithDsh, false, 'the untouched resource kept its value')
  assert.equal(merged.debug.stopWithDsh, true, 'the untouched resource kept its value')
  assert.equal(merged.daemon.stopWithDsh, true)
})

test('unknown resources and keys are rejected instead of silently saved', () => {
  const unknownResource = normalizeLifecycle({ engine: { startWithDsh: true } })
  assert.equal(unknownResource.changed, false)
  assert.match(unknownResource.errors.join(';'), /engine 不是生命周期资源/)
  assert.equal('engine' in unknownResource.value, false)

  const unknownKey = normalizeLifecycle({ proxy: { startWithDsh: true, keepAlive: true } })
  assert.equal(unknownKey.changed, false)
  assert.match(unknownKey.errors.join(';'), /proxy\.keepAlive 不是可配置项/)
})

test('a missing file reads as defaults; a broken file still yields defaults', () => {
  const home = makeHome('risd-life-')
  try {
    const missing = readLifecycle(home)
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.value, LIFECYCLE_DEFAULTS)

    writeFileSync(lifecyclePath(home), '{ not json')
    const broken = readLifecycle(home)
    assert.equal(broken.exists, true)
    assert.deepEqual(broken.value, LIFECYCLE_DEFAULTS, 'a bad file must not stop the daemon')
    assert.match(broken.errors.join(';'), /无法解析/)
  } finally { removeHome(home) }
})

test('write persists atomically with 0600 and reads back', () => {
  const home = makeHome('risd-life-')
  try {
    const written = writeLifecycle(home, { programs: { startWithDsh: true } })
    assert.deepEqual(written.errors, [])
    assert.equal(written.value.programs.startWithDsh, true)
    assert.equal(written.value.programs.stopWithDsh, false)
    const path = lifecyclePath(home)
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.programs.startWithDsh, true)
    const again = readLifecycle(home)
    assert.equal(again.value.proxy.startWithDsh, true)
    assert.equal(again.value.proxy.stopWithDsh, true)
  } finally { removeHome(home) }
})

test('POST /v1/config stores the policy and GET /v1/config returns it', async () => {
  const home = makeHome('risd-life-')
  const daemon = await startRisdProcess({ home })
  try {
    const { port, token } = daemon.state
    const headers = { authorization: `Bearer ${token}`, 'x-risd-api-version': '1', 'content-type': 'application/json' }
    const before = await (await fetch(`http://127.0.0.1:${port}/v1/config`, { headers })).json()
    assert.equal(before.ok, true)
    assert.deepEqual(before.lifecycle, LIFECYCLE_DEFAULTS)

    const saved = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { daemon: { stopWithDsh: false }, programs: { stopWithDsh: true, startWithDsh: true } } }),
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody.ok, true)
    assert.equal(savedBody.lifecycle.daemon.stopWithDsh, false)
    assert.equal(savedBody.lifecycle.daemon.startWithDsh, true, 'the forced half stays on')
    assert.equal(savedBody.lifecycle.programs.stopWithDsh, true)
    assert.equal(savedBody.lifecycle.programs.startWithDsh, true)
    assert.equal(existsSync(join(home, 'risd-lifecycle.json')), true)

    const after = await (await fetch(`http://127.0.0.1:${port}/v1/config`, { headers })).json()
    assert.equal(after.lifecycle.daemon.stopWithDsh, false)
    assert.equal(after.lifecycle.programs.stopWithDsh, true)
    assert.equal(after.lifecycle.programs.startWithDsh, true)

    const bad = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { proxy: { stopWithDsh: 'true' } } }),
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).message, /proxy\.stopWithDsh 必须是 true\/false/)

    const forced = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { proxy: { followDaemon: false } } }),
    })
    assert.equal(forced.status, 400)
    assert.match((await forced.json()).message, /followDaemon 不再支持/)

    // The daemon's start half cannot be switched off, and the debug start half does
    // not exist: both are refused with their own message.
    const forcedStart = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { daemon: { startWithDsh: false } } }),
    })
    assert.equal(forcedStart.status, 400)
    assert.match((await forcedStart.json()).message, /daemon\.startWithDsh 不可配置/)
    const debugStart = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { debug: { startWithDsh: true } } }),
    })
    assert.equal(debugStart.status, 400)
    assert.match((await debugStart.json()).message, /debug\.startWithDsh 不是可配置项/)
  } finally {
    await daemon.stop()
    await sleep(100)
    removeHome(home)
  }
})

test('POST /v1/config rejects unknown resources, keys and non-object resources (review A3-P1-2)', async () => {
  // The HTTP path used to whitelist-copy the patch before validating it, so a typo
  // or a wrong shape answered 200 and was silently dropped. normalizeLifecycle's
  // messages must reach the caller.
  const home = makeHome('risd-life-')
  const daemon = await startRisdProcess({ home })
  try {
    const { port, token } = daemon.state
    const headers = { authorization: `Bearer ${token}`, 'x-risd-api-version': '1', 'content-type': 'application/json' }
    const post = (lifecycle) => fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle }),
    })
    const cases = [
      [{ engine: { followDsh: true } }, /engine 不是生命周期资源/],
      [{ proxy: { startWithDsh: true, keepAlive: true } }, /proxy\.keepAlive 不是可配置项/],
      [{ daemon: { followDaemon: false } }, /daemon\.followDaemon 不再支持/],
      [{ proxy: true }, /proxy 必须是对象/],
      [null, /lifecycle 必须是对象/],
      [[], /lifecycle 必须是对象/],
    ]
    for (const [lifecycle, expected] of cases) {
      const response = await post(lifecycle)
      assert.equal(response.status, 400, `lifecycle=${JSON.stringify(lifecycle)}`)
      assert.match((await response.json()).message, expected)
    }
    // Nothing invalid was written: the file still holds the defaults.
    const after = await (await fetch(`http://127.0.0.1:${port}/v1/config`, { headers })).json()
    assert.deepEqual(after.lifecycle, LIFECYCLE_DEFAULTS)
    assert.deepEqual(after.lifecycleErrors, [])
  } finally {
    await daemon.stop()
    await sleep(100)
    removeHome(home)
  }
})

test('a broken lifecycle file is reported by GET /v1/config (review A3-P2-8)', async () => {
  // A hand-edited file that cannot be parsed runs on defaults; the page must be able
  // to say why instead of showing defaults as if they were saved policy.
  const home = makeHome('risd-life-')
  const daemon = await startRisdProcess({ home })
  try {
    writeFileSync(join(home, 'risd-lifecycle.json'), '{ this is not json', { mode: 0o600 })
    const { port, token } = daemon.state
    const headers = { authorization: `Bearer ${token}`, 'x-risd-api-version': '1' }
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/config`, { headers })).json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.lifecycle, LIFECYCLE_DEFAULTS)
    assert.ok(Array.isArray(body.lifecycleErrors) && body.lifecycleErrors.length >= 1)
    assert.match(body.lifecycleErrors.join('; '), /无法解析/)
  } finally {
    await daemon.stop()
    await sleep(100)
    removeHome(home)
  }
})


/** A workspace with one custom program row (the shape the panel writes). */
function makeProgramWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), 'risd-life-restore-'))
  mkdirSync(join(workspace, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    defaults: {},
    programs: [{
      id: 'demo',
      name: 'demo',
      kind: 'custom',
      dir: workspace,
      relDir: '.',
      project: '',
      logName: 'demo',
      startCommand: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 60000)"`,
      stopGraceMs: 3000,
    }],
  }, null, 2)}\n`, 'utf8')
  return workspace
}

test('the programs start half restores what the last daemon left running (m03397)', { skip: skipWithout(HAS_BASH, 'bash') }, async () => {
  const home = makeHome('risd-life-')
  const workspace = makeProgramWorkspace()
  let daemon
  try {
    writeLifecycle(home, { programs: { startWithDsh: true } })
    // A previous daemon recorded this program as live and then went away (crash,
    // reboot, kill -9): the snapshot is the only memory of it.
    writeFileSync(join(home, 'risd-programs-last.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      programs: [{ cwd: workspace, id: 'demo', dir: join(workspace, 'logs') }],
    })}\n`, { mode: 0o600 })
    daemon = await startRisdProcess({ home })
    const lease = await api(daemon.state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, cwd: workspace } })
    assert.equal(lease.status, 200, JSON.stringify(lease.body))
    const deadline = Date.now() + 5000
    let demo
    while (Date.now() < deadline) {
      const listed = await api(daemon.state, `/v1/programs?cwd=${encodeURIComponent(workspace)}`)
      demo = listed.body.programs.find((row) => row.id === 'demo')
      if (demo !== undefined && demo.running !== null && demo.running !== undefined && demo.running.alive === true) break
      await sleep(100)
    }
    assert.equal(demo?.running?.alive, true, 'the program the snapshot remembered runs again')
  } finally {
    if (daemon !== undefined) await daemon.stop()
    await sleep(100)
    removeHome(home)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('the programs start half stays quiet when it is off', { skip: skipWithout(HAS_BASH, 'bash') }, async () => {
  const home = makeHome('risd-life-')
  const workspace = makeProgramWorkspace()
  let daemon
  try {
    // Default policy: programs do NOT follow dsh, so a stale snapshot must not start
    // anything behind the user's back.
    writeFileSync(join(home, 'risd-programs-last.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      programs: [{ cwd: workspace, id: 'demo', dir: join(workspace, 'logs') }],
    })}\n`, { mode: 0o600 })
    daemon = await startRisdProcess({ home })
    await api(daemon.state, '/v1/leases', { method: 'POST', body: { ownerPid: process.pid, cwd: workspace } })
    await sleep(600)
    const listed = await api(daemon.state, `/v1/programs?cwd=${encodeURIComponent(workspace)}`)
    const demo = listed.body.programs.find((row) => row.id === 'demo')
    assert.ok(demo !== undefined)
    assert.notEqual(demo.running?.alive, true, 'nothing was restored while the start half is off')
  } finally {
    if (daemon !== undefined) await daemon.stop()
    await sleep(100)
    removeHome(home)
    rmSync(workspace, { recursive: true, force: true })
  }
})
