/**
 * The standalone IDE window across a `dsh web` restart.
 *
 * The window page is never reloaded by a restart, so it must (a) stay registered
 * with the host without any stored state — its stream IS the registration — and
 * (b) follow the session the workspace is on now, because the id in its URL died
 * with the old host. The DSH page, in turn, must find that window instead of
 * opening a second one. These tests pin the registry contract, the session lookup
 * and the client-side wiring (a real window belongs to the developer's desktop,
 * not to CI).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { __test } from '../lib/index.js'

const {
  WINDOWS_PATH,
  listIdeWindows,
  liveSessionFor,
  ideWindowOpened,
  ideWindowClosed,
  serveWindows,
} = __test

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostSource = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const windowHtml = await readFile(new URL('../lib/standalone/window.html', import.meta.url), 'utf8')

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { void handler(req, res) })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function addressOf(server) {
  const info = server.address()
  return `http://127.0.0.1:${info.port}`
}

test('the window route is one GET under the plugin prefix', () => {
  assert.equal(WINDOWS_PATH, '/dsh-ris-ide/windows')
  assert.equal(typeof serveWindows, 'function')
  const source = clientSource
  assert.match(source, /routeUrl\('dsh-ris-ide\/windows'\)/, 'the client asks the host before opening a window')
})

test('a window is alive while its stream is open, and known by its name', () => {
  const name = 'name:test-alive-window'
  ideWindowOpened(name, { name: 'test-alive-window', cwd: '/tmp/test-alive-window', sessionId: 's1' })
  const live = listIdeWindows({ name: 'test-alive-window' })
  assert.equal(live.length, 1)
  assert.equal(live[0].alive, true, 'an open stream means the window is there')
  assert.equal(live[0].sessionId, 's1')
  ideWindowClosed(name)
  const idle = listIdeWindows({ name: 'test-alive-window' })
  assert.equal(idle.length, 1, 'the entry survives a short disconnect (a reload)')
  assert.equal(idle[0].alive, false)
  assert.equal(listIdeWindows({ name: 'no-such-window' }).length, 0)
})

test('two streams of one window count twice, so one close does not end it', () => {
  const name = 'name:test-two-streams'
  ideWindowOpened(name, { name: 'test-two-streams', cwd: '/tmp/test-two-streams', sessionId: 's2' })
  ideWindowOpened(name, { name: 'test-two-streams', cwd: '/tmp/test-two-streams', sessionId: 's2' })
  ideWindowClosed(name)
  assert.equal(listIdeWindows({ name: 'test-two-streams' })[0].alive, true, 'the second stream still holds it')
  ideWindowClosed(name)
  assert.equal(listIdeWindows({ name: 'test-two-streams' })[0].alive, false)
})

test('windows without a name fall back to their workspace as the key', () => {
  const cwd = join('/tmp', 'test-unnamed-window')
  const name = 'cwd:' + cwd
  ideWindowOpened(name, { cwd, sessionId: 's3' })
  const found = listIdeWindows({ cwd })
  assert.equal(found.length, 1)
  assert.equal(found[0].alive, true)
  assert.equal(found[0].name, '')
  ideWindowClosed(name)
})

test('the workspace session is the newest live one in that cwd', () => {
  const cwd = '/tmp/test-session-workspace'
  const ctx = {
    sessions: {
      list: () => [
        { id: 'old', header: { cwd } },
        { id: 'other', header: { cwd: '/tmp/elsewhere' } },
        { id: 'new', header: { cwd } },
      ],
    },
  }
  assert.deepEqual(liveSessionFor(ctx, cwd), { id: 'new' }, 'the newest session wins')
  assert.equal(liveSessionFor(ctx, '/tmp/nothing-here'), null)
  assert.deepEqual(liveSessionFor(ctx, '/tmp/test-session-workspace/sub/program'), { id: 'new' },
    'the IDE is workspace-level: a window inside a program folder still follows the workspace session')
  assert.deepEqual(liveSessionFor({ sessions: { list: () => [{ id: 'outer', header: { cwd: '/tmp' } }] } }, '/tmp/elsewhere/x'), { id: 'outer' },
    'an ancestor session is better than nothing')
  assert.equal(liveSessionFor(undefined, cwd), null, 'a host without the service answers nothing')
  assert.equal(liveSessionFor({ sessions: { list: () => { throw new Error('detached') } } }, cwd), null)
})

test('the windows route answers the registry, and rejects a relative cwd', async () => {
  const ctx = {
    sessions: { list: () => [{ id: 'live-1', header: { cwd: '/tmp/test-route-workspace' } }] },
  }
  const server = await serve((req, res) => serveWindows(ctx, req, res))
  try {
    const base = addressOf(server)
    const ok = await fetch(base + WINDOWS_PATH + '?name=name%3Atest-route-window&cwd=' + encodeURIComponent('/tmp/test-route-workspace'))
    assert.equal(ok.status, 200)
    const payload = await ok.json()
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.windows))
    assert.deepEqual(payload.session, { id: 'live-1' }, 'the route also names the live session of that cwd')

    const bad = await fetch(base + WINDOWS_PATH + '?cwd=relative%2Fpath')
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).message, /absolute workspace path/)

    const unnamed = await fetch(base + WINDOWS_PATH)
    assert.equal(unnamed.status, 200)
    assert.equal((await unnamed.json()).session, null, 'no cwd, no session lookup')
  } finally {
    // fetch keeps its socket alive, and a plain close() would wait for it.
    server.closeAllConnections?.()
    server.close()
  }
})

test('the standalone window registers itself and follows the live session', () => {
  assert.match(clientSource, /url\.searchParams\.set\('window', '1'\)/, 'the stream says it is a window')
  assert.match(clientSource, /url\.searchParams\.set\('wname', window\.__dshRisIdeWindowName\)/, 'and which window it is')
  assert.match(clientSource, /window\.__dshRisIdeWindowName = typeof opts\.windowName === 'string' \? opts\.windowName : ''/)
  assert.match(clientSource, /function StandaloneWindow\(props\)/, 'the window root owns the scope')
  assert.match(clientSource, /topics: \['hello'\]/, 'it listens for the host hello frame')
  assert.match(clientSource, /if \(mine !== null && mine\.live === true\) return/, 'a live session id is kept, a dead one is replaced')
  assert.match(clientSource, /setSessionId\(live\)/)
  assert.match(windowHtml, /windowName: params\.get\('wname'\) \|\| ''/, 'the page hands its name to the panel')
})

test('clicking the IDE button closes the old window and opens a fresh one', () => {
  assert.match(clientSource, /async function openStandaloneWindow\(options\)/)
  assert.match(clientSource, /var state = await standaloneWindowState\(windowName, windowCwd\)/, 'the registry is asked before opening')
  // Registration must not depend on which topics the first stream asks for: a
  // window that only listens for `hello` still has to appear in the registry.
  assert.match(hostSource, /const rawWindowCwd = isIdeWindow \? \(url\.searchParams\.get\('cwd'\) \?\? ''\)\.trim\(\) : ''/, 'the window registers from its cwd parameter')
  assert.match(hostSource, /session: helloCwd === undefined \? null : liveSessionFor\(ctx, helloCwd\)/, 'the hello session follows the same cwd')
  // A dropped stream must release its registration from BOTH paths: an aborted
  // connection reports 'error' and 'close', and a window left "alive" forever
  // would make the next IDE-button click wait out a pointless close handshake.
  assert.match(hostSource, /let windowSettled = false/, 'the registration settles exactly once')
  assert.match(hostSource, /const settleWindow = \(\) => \{[\s\S]{0,240}?ideWindowClosed\(windowKey\)/, 'and it is what decrements the stream count')
  assert.match(hostSource, /res\.on\('error', \(\) => \{[\s\S]{0,400}?settleWindow\(\)/, 'an errored stream frees the window too')
  assert.match(clientSource, /if \(state\.exists === true && state\.alive === true\) \{/, 'only a LIVE window is asked to close')
  assert.match(clientSource, /await requestStandaloneWindowClose\(windowName\)/, 'a dead registration cannot block the next open')
  assert.match(clientSource, /channel\.postMessage\(\{ type: 'close' \}\)/, 'the old window is told to close itself')
  assert.match(clientSource, /if \(state\.alive !== true\) \{ release\(\); resolve\(true\); return \}/, 'the handshake waits for the stream to go')
  assert.match(clientSource, /window\.open\(url\.href, windowName, features\)/, 'the new window is opened directly (no blank popup)')
  assert.doesNotMatch(clientSource, /window\.open\('', windowName, features\)/, 'no blank popup that has to be closed again')
  assert.doesNotMatch(clientSource, /settleStandaloneWindow/)
  assert.match(windowHtml, /function closeForOpener\(\)/, 'the window can close itself on request')
  assert.match(windowHtml, /if \(data\.type === 'close'\) \{/, 'the lock holder obeys the close request')
  assert.match(windowHtml, /function takeover\(\)/, 'the blocked window offers "close the old one and open here"')
  assert.match(windowHtml, /关闭旧窗口，在这里打开/)
  // A window that takes the lock over (or sits on the blocked notice) must install
  // the same channel hooks as one that claimed it on load - otherwise the DSH page's
  // close request is never heard and the NEXT click of the IDE button is stuck.
  assert.match(windowHtml, /function startHere\(\) \{\n      claim\.blocked = false\n      \/\/ The window that ends up running[\s\S]{0,400}?becomeHolder\(\)/, 'every boot route installs the close/focus hooks on the window that ends up running')
  assert.match(windowHtml, /showBlocked\(\)\n            becomeHolder\(\)/, 'the blocked notice listens for close as well')
  assert.match(windowHtml, /else if \(data\.type === 'close'\) closeForOpener\(\)/, 'the lock holder obeys the close request')
  assert.match(windowHtml, /if \(data\.type === 'close'\) \{\n\s+\/\/ The DSH page wants a fresh window/, 'the no-Web-Locks fallback obeys it too')
})

test('each workspace gets its own window (and its own close handshake)', () => {
  assert.match(clientSource, /function standaloneWindowName\(cwd\) \{\n      return WINDOW_NAME \+ '-' \+ standaloneWindowKey\(cwd\)/, 'the window name is derived from the workspace cwd, not from the session')
  assert.doesNotMatch(clientSource, /standaloneWindowName\(sessionId\)/, 'a session id never names a window')
  assert.match(clientSource, /var windowName = standaloneWindowName\(windowCwd !== undefined \? windowCwd : cwd\)/, 'the window follows the workspace, not the panel\'s subdirectory')
})

test('a restarted host makes every pane drop its stale error and re-read', () => {
  assert.match(clientSource, /var hadFailure = false/, 'a broken stream is remembered')
  assert.match(clientSource, /hadFailure = true/, 'the error handler marks the outage')
  assert.match(clientSource, /if \(recovered === true\) announceRecovery\(\)/, 'the next open is a recovery')
  assert.match(clientSource, /function announceRecovery\(\)/, 'recovery is broadcast once per outage')
  assert.match(clientSource, /hostRecovered: function \(handler\)/, 'panes subscribe to recovery')
  assert.match(clientSource, /function useHostRecovery\(callback\)/, 'one hook for the panes')
  assert.match(clientSource, /useHostRecovery\(function \(\) \{ setError\(undefined\); void recoverTree\(\) \}\)/, 'the tree clears its banner and re-reads')
  assert.match(clientSource, /useHostRecovery\(function \(\) \{ void refresh\(\) \}\)/, 'the log tail re-reads')
  assert.match(clientSource, /useHostRecovery\(function \(\) \{ void refresh\(false\) \}\)/, 'the program console re-reads')
  assert.match(clientSource, /doc\.kind !== 'error'/, 'only documents that failed are retried (edits are kept)')
  assert.match(clientSource, /setError\(undefined\)\n              return true/, 'a successful background read also clears the tree banner')
})
