// Automatic daemon starts must not loop: a risd that cannot boot (broken home,
// stolen port, bad Node install) would otherwise be re-spawned on every click or
// tool call, each attempt paying the full health-probe timeout.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  noteRisdHealFailure,
  noteRisdHealSuccess,
  risdHealBlocked,
  risdHealReason,
} from '../lib/index.js'

test('three failures inside the window pause automatic starts', () => {
  const t0 = 1_000_000
  noteRisdHealSuccess()
  noteRisdHealFailure('port busy', t0)
  noteRisdHealFailure('port busy', t0 + 1000)
  assert.equal(risdHealBlocked(t0 + 2000), false, 'two failures are not enough')
  noteRisdHealFailure('port busy', t0 + 2000)
  assert.equal(risdHealBlocked(t0 + 2001), true, 'the third trips the breaker')
  const reason = risdHealReason(t0 + 2001)
  assert.match(reason, /连续 3 次自动启动 risd 失败/)
  assert.match(reason, /port busy/)
  assert.match(reason, /risd serve/)
  // Still blocked shortly before the cooldown ends, free again after it.
  assert.equal(risdHealBlocked(t0 + 2000 + 5 * 60_000 - 10), true)
  assert.equal(risdHealBlocked(t0 + 2000 + 5 * 60_000 + 10), false)
})

test('a success clears the breaker', () => {
  const t0 = 2_000_000
  noteRisdHealSuccess()
  noteRisdHealFailure('boom', t0)
  noteRisdHealFailure('boom', t0 + 10)
  noteRisdHealFailure('boom', t0 + 20)
  assert.equal(risdHealBlocked(t0 + 30), true)
  noteRisdHealSuccess()
  assert.equal(risdHealBlocked(t0 + 40), false)
  assert.equal(risdHealReason(t0 + 40), '')
})

test('failures spread across the window do not trip it', () => {
  const t0 = 3_000_000
  noteRisdHealSuccess()
  noteRisdHealFailure('x', t0)
  noteRisdHealFailure('x', t0 + 3 * 60_000)
  noteRisdHealFailure('x', t0 + 6 * 60_000)
  assert.equal(risdHealBlocked(t0 + 6 * 60_000 + 1), false)
})
