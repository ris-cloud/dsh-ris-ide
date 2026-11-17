// 「代理引擎跟随 dsh」 has two halves on ONE signal: the lease. The daemon starts the
// engine when the first lease arrives (proxy.startWithDsh) and tears it down when the
// last one leaves (proxy.stopWithDsh) — two switches, one signal, so the two sides
// still cannot disagree (m13950 / m03397).
// The automatic path must stay non-interactive: a password dialog cannot be a side
// effect of dsh starting (m13910) — only a click may ask.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { makeHome, removeHome, sleep, startRisdProcess } from './risd-helpers.mjs'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('a lease never starts an engine when the policy is off or no rule is actionable', async () => {
  const home = makeHome('risd-follow-')
  const daemon = await startRisdProcess({ home })
  try {
    const { port, token } = daemon.state
    const headers = {
      authorization: `Bearer ${token}`,
      'x-risd-api-version': '1',
      'content-type': 'application/json',
    }
    const lease = (cwd) => fetch(`http://127.0.0.1:${port}/v1/leases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ownerPid: process.pid, cwd }),
    })
    const save = (body) => fetch(`http://127.0.0.1:${port}/v1/config`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const engine = async () => {
      const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()
      return health.engine?.state
    }

    // Following dsh is the default, but the rule table is empty: no engine.
    assert.equal((await lease(home)).status, 200)
    await sleep(400)
    assert.equal(await engine(), 'stopped', 'an empty table is not a reason to spawn an engine')

    // Turning the start half off must stop the lease from spawning anything.
    assert.equal((await save({ lifecycle: { proxy: { startWithDsh: false } } })).status, 200)
    assert.equal((await lease(home)).status, 200)
    await sleep(400)
    assert.equal(await engine(), 'stopped', 'a policy that does not follow dsh cannot start it')
  } finally {
    await daemon.stop()
    await sleep(100)
    removeHome(home)
  }
})

test('the start half rides the lease, not a separate route or plugin call', () => {
  const server = read('lib/risd/server.js')
  const leaseAt = server.indexOf("if (path === '/v1/leases')")
  assert.ok(leaseAt > 0)
  const leaseBlock = server.slice(leaseAt, server.indexOf("const leaseMatch", leaseAt))
  assert.match(leaseBlock, /lifecycle\.proxy\.startWithDsh === true/, 'the start half the policy exposes')
  assert.match(leaseBlock, /followStartForLease\(lease\.cwd\)/, 'the lease is the start signal')

  const start = server.indexOf('function followStartForLease(')
  assert.ok(start > 0, 'the start half lives next to the engine helpers')
  const startBlock = server.slice(start, start + 2600)
  assert.match(startBlock, /engineSummary\(\)\.state === 'running'/, 'an engine that is already up is left alone')
  assert.match(startBlock, /buildProfile\(status\.config\)\.rules\.length === 0/, 'rules decide whether starting is worth it')
  assert.match(startBlock, /startRedirectors\(\{ interactive: false \}\)/, 'a startup side effect must never prompt')
  assert.match(startBlock, /reason: 'no-lease'/, 'a lease that left mid-round-trip must not spawn an engine')
  // The same promise is awaitable, so teardown can let a departing lease's start land
  // before it decides what to stop (otherwise engineCwd is still null and the engine
  // is orphaned — m13960).
  assert.match(startBlock, /followStarting = work\.finally/)
  const teardownAt = server.indexOf('function scheduleTeardown()')
  const teardownBlock = server.slice(teardownAt, server.indexOf('const leases = createLeaseRegistry', teardownAt))
  assert.match(teardownBlock, /await followStarting\.catch\(\(\) => \{\}\)/, 'teardown waits for an in-flight start')
  assert.match(teardownBlock, /followStarting === null\) return/, 'a pending start must not suppress the teardown schedule')
  assert.doesNotMatch(server, /'\/v1\/follow-start'/, 'there is no second entry point to keep in sync')

  // Teardown reads the other half of the same resource, so "start follows dsh" and
  // "stop follows dsh" cannot disagree about which resource they describe.
  assert.match(server, /if \(lifecycle\.proxy\.stopWithDsh === true\) \{\n\s+await teardownNetwork\(cwd\)/)

  assert.doesNotMatch(read('lib/risd-client.js'), /followStartRisd/, 'the plugin does not need a call')
  assert.doesNotMatch(read('lib/index.js'), /followStartRisd/, 'the lease acquired by attachBridgeState is the signal')
})

test('saving the rule table never starts the engine (m13920)', () => {
  const server = read('lib/risd/server.js')
  const at = server.indexOf("path === '/v1/proxy' && method === 'POST'")
  assert.ok(at > 0)
  const block = server.slice(at, server.indexOf("if (path === '/v1/action'", at))
  assert.doesNotMatch(block, /await startProxy\(/, 'a save must not spawn the engine')
  assert.match(block, /switchEnforcement/, 'an already-running bridge is reloaded instead')

  const ui = read('lib/risd/ui.js')
  assert.doesNotMatch(ui, /function maybeStartProxy/, 'the save-triggered start is gone')
  assert.doesNotMatch(ui, /proxy-start-with-dsh/, 'the policy is the lifecycle checkbox, not a second switch')
  assert.match(ui, /保存不会启动它/, 'the banner names the button instead of starting')
})
