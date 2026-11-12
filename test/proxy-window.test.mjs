import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const page = readFileSync(new URL('../lib/standalone/window.html', import.meta.url), 'utf8')

test('the panel no longer opens a proxy dialog at all', () => {
  // Proxy rules live on the risd page (a machine-level resource, editable without
  // dsh); both console shapes lost their 🌐, so nothing in the plugin opens the
  // in-panel dialog or the standalone proxy window any more.
  assert.doesNotMatch(client, /data-action': 'compact-proxy'/)
  // Neither console (header rows and the sidebar compact bar) pushes a 🌐 button
  // any more, and the flag that opened the dialog is gone with it. Moved here from
  // risd-entry.test.mjs, which only carried these two negative assertions.
  assert.doesNotMatch(client, /consoleConfigActions\.push\(button\('🌐'/)
  assert.doesNotMatch(client, /compactProxyOpen/)
  assert.doesNotMatch(client, /setProxyOpen\(true\)|setCompactProxyOpen\(true\)/)
  assert.doesNotMatch(client, /focus-ack/)
})

test('the dead proxy-window opener and its polling hook are gone (review C-P2-7)', () => {
  // These had no caller left once the 🌐 buttons went: keeping them meant a second
  // way to open a proxy document and a second poll of /dsh-ris-ide/proxy that
  // nobody consumed.
  assert.doesNotMatch(client, /openProxyWindow/)
  assert.doesNotMatch(client, /proxyWindowHandles|proxyWindowNameFor/)
  assert.doesNotMatch(client, /proxyRunWatch|proxyRunKey|refreshProxyRun|useProxyRunning/)
  // Nothing in the panel builds a view=proxy URL any more, and the component that
  // rendered it is deleted (D4).
  assert.doesNotMatch(client, /set\('view', 'proxy'\)/)
  assert.doesNotMatch(client, /opts\.view === 'proxy'/)
})

test('the window page no longer forwards the dead `view` parameter', () => {
  // The proxy-only window went with the dialog (D4); keeping the parameter alive
  // meant the page and the client disagreed about a mode nobody could reach.
  assert.doesNotMatch(page, /params\.get\('view'\)/)
  assert.doesNotMatch(page, /view: view,/)
  // D4 deleted the in-panel ProxyDialog together with its standalone rendering.
  assert.doesNotMatch(client, /opts\.view === 'proxy'/)
  assert.doesNotMatch(client, /standalone: true,/)
})

test('no panel button reflects engine state any more', () => {
  // The grey/blue 🌐 indicator went with the buttons; engine state is shown in the
  // risd page's overview instead.
  assert.doesNotMatch(client, /color: proxyRunning === true/)
  assert.doesNotMatch(client, /useProxyRunning\(\{ sessionId: sessionId, cwd: cwd \}\)/)
})
