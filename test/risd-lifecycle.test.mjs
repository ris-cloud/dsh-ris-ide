// Lifecycle settings: which resources follow dsh, and which follow the daemon.
// Defaults must preserve the behaviour that existed before the setting (proxy
// follows dsh, everything else stops with the daemon), and a broken policy file
// must never take the daemon down.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LIFECYCLE_DEFAULTS,
  lifecyclePath,
  mergeLifecycle,
  normalizeLifecycle,
  readLifecycle,
  writeLifecycle,
} from '../lib/risd/lifecycle.js'
import { makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'

test('defaults match the behaviour from before the setting existed', () => {
  const { value, errors } = normalizeLifecycle({})
  assert.deepEqual(errors, [])
  assert.deepEqual(value, LIFECYCLE_DEFAULTS)
  assert.equal(value.daemon.followDsh, true)
  assert.equal(value.proxy.followDsh, true)
  assert.equal(value.programs.followDsh, false, 'closing the last dsh must not stop JVMs by default')
  assert.equal(value.debug.followDsh, false)
})

test('partial input keeps the untouched defaults and rejects non-booleans', () => {
  const partial = normalizeLifecycle({ programs: { followDsh: true } })
  assert.deepEqual(partial.errors, [])
  assert.equal(partial.value.programs.followDsh, true)
  assert.equal(partial.value.proxy.followDsh, true)

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
  const current = normalizeLifecycle({ proxy: { followDsh: false }, debug: { followDsh: true } }).value
  const merged = normalizeLifecycle(mergeLifecycle(current, { programs: { followDsh: true } })).value
  assert.equal(merged.programs.followDsh, true, 'the submitted resource changed')
  assert.equal(merged.proxy.followDsh, false, 'the untouched resource kept its value')
  assert.equal(merged.debug.followDsh, true, 'the untouched resource kept its value')
  assert.equal(merged.daemon.followDsh, true)
})

test('unknown resources and keys are rejected instead of silently saved', () => {
  const unknownResource = normalizeLifecycle({ engine: { followDsh: true } })
  assert.equal(unknownResource.changed, false)
  assert.match(unknownResource.errors.join(';'), /engine 不是生命周期资源/)
  assert.equal('engine' in unknownResource.value, false)

  const unknownKey = normalizeLifecycle({ proxy: { followDsh: true, keepAlive: true } })
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
    const written = writeLifecycle(home, { programs: { followDsh: true } })
    assert.deepEqual(written.errors, [])
    assert.equal(written.value.programs.followDsh, true)
    const path = lifecyclePath(home)
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.programs.followDsh, true)
    const again = readLifecycle(home)
    assert.equal(again.value.proxy.followDsh, true)
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
      body: JSON.stringify({ lifecycle: { daemon: { followDsh: false }, programs: { followDsh: true } } }),
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody.ok, true)
    assert.equal(savedBody.lifecycle.daemon.followDsh, false)
    assert.equal(savedBody.lifecycle.programs.followDsh, true)
    assert.equal(existsSync(join(home, 'risd-lifecycle.json')), true)

    const after = await (await fetch(`http://127.0.0.1:${port}/v1/config`, { headers })).json()
    assert.equal(after.lifecycle.daemon.followDsh, false)
    assert.equal(after.lifecycle.programs.followDsh, true)

    const bad = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { proxy: { followDsh: 'true' } } }),
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).message, /followDsh 必须是 true\/false/)

    const forced = await fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lifecycle: { proxy: { followDaemon: false } } }),
    })
    assert.equal(forced.status, 400)
    assert.match((await forced.json()).message, /followDaemon 不再支持/)
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
      [{ proxy: { followDsh: true, keepAlive: true } }, /proxy\.keepAlive 不是可配置项/],
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

