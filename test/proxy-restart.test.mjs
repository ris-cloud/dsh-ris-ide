// The bridge parses its profile when it starts, so a rule-table save can leave old
// rules intercepting. The daemon page therefore offers "restart bridge" right next
// to that warning, and both the daemon and the plugin must understand the action.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('the daemon page offers a restart button next to a stale-bridge note', () => {
  const ui = read('lib/risd/ui.js')
  assert.match(ui, /id="bridge-restart"/)
  // The button only appears for notes that say the bridge did not take the new rules.
  assert.match(ui, /未重载\|旧规则/)
  assert.match(ui, /'为什么要重启：'/)
  assert.match(ui, /redirector-restart/)
})

test('the daemon restarts the bridge: stop, settle, start from the new profile', () => {
  const server = read('lib/risd/server.js')
  const at = server.indexOf("action === 'redirector-restart'")
  assert.ok(at > 0, 'daemon must handle redirector-restart')
  const block = server.slice(at, at + 600)
  assert.match(block, /await stopRedirector\(\)/)
  assert.match(block, /setTimeout\(resolve, 300\)/)
  assert.match(block, /await startRedirectors\(\)/)
})

test('the plugin forwards the restart action to the daemon and can run it itself', () => {
  const index = read('lib/index.js')
  assert.match(index, /'redirector-restart'/)
  const at = index.indexOf("action === 'redirector-restart'")
  assert.ok(at > 0, 'plugin must handle redirector-restart locally')
  const block = index.slice(at, at + 400)
  assert.match(block, /await stopRedirector\(\)/)
  assert.match(block, /await startRedirectors\(\)/)
})
