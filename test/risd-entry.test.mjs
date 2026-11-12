// Entry points into the daemon page and the `risd` CLI name.
//
// Why: the daemon page embeds the IDE and can switch workspace, so it replaced
// both "open the IDE window" buttons. The page is served by the daemon, whose
// origin the client cannot guess — the host view has to report it. And the CLI is
// `risd <cmd>` (the package exposes bin.risd), not `node bin/risd.mjs`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const bin = readFileSync(new URL('../bin/risd.mjs', import.meta.url), 'utf8')

test('the host view reports the daemon page address', () => {
  // proxyView (daemonMode=off ⇒ available:false) and mergeRisdView both carry it.
  assert.equal((host.match(/risd: risdBridge !== null && risdBridge\.state !== null/g) ?? []).length, 2)
  assert.match(host, /url: risdBridge\.state\.url, port: risdBridge\.state\.port/)
})

test('the CLI is `risd`, exposed through package.json', () => {
  assert.deepEqual(pkg.bin, { risd: 'bin/risd.mjs' })
  assert.match(bin, /^#!\/usr\/bin\/env node/)
})

test('clicking ⧉ starts a stopped daemon instead of falling back to the old window', () => {
  // The client asks the host to spawn it when the proxy view says unavailable…
  assert.match(client, /routeUrl\('dsh-ris-ide\/risd\/ensure'\)\.href, \{ method: 'POST' \}/)
  // The cold path: an empty prefetch hands over to `ensure`, and its answer is cached.
  assert.match(client, /if \(risd === null\) \{[\s\S]{0,400}routeUrl\('dsh-ris-ide\/risd\/ensure'\)\.href, \{ method: 'POST' \}/)
  assert.match(client, /risd = rememberRisdAddress\(risdAddressOf\(body\)\)/)
  // …and the host exposes a loopback-only POST that calls ensureRisd.
  assert.match(host, /pathname === RISD_ENSURE_PATH/)
  assert.match(host, /if \(method !== 'POST'\) \{\s+writeJson\(res, 405/)
  assert.match(host, /async function serveRisdEnsure\(ctx, req, res, options\)/)
  assert.match(host, /ensureRisd\(\{ home: proxyHomeDir\(\) \}\)/)
  assert.match(host, /url: `http:\/\/127\.0\.0\.1:\$\{state\.port\}`/)
  // Once spawned the page lands on the IDE tab, same as a normal click.
  assert.match(client, /\?cwd=' \+ encodeURIComponent\(cwd\) : ''/)
})

test('an agent can start the daemon from what the errors say', () => {
  // CLI: `risd status|health` on a stopped daemon prints the command that starts it.
  assert.match(bin, /hint: run `risd serve` to start it \(clicking ⧉ in dsh also starts it\)/)
  // Tools: a tool call re-spawns the daemon once before falling back to local.
  assert.match(host, /const healDaemon = async \(\) => \{/)
  assert.match(host, /const ensured = await ensureRisd\(\{ home: proxyHomeDir\(\) \}\)\.catch/)
  assert.match(host, /noteRisdHealFailure\(ensured\.reason/)
  assert.match(host, /if \(risdHealBlocked\(now\)\) return null/, 'a tripped breaker stops the heal')
  assert.match(host, /const healed = await healDaemon\(\)/) // C-P2-2: the result is also warned about
})

test('off mode refuses to raise a daemon, so the two owners never overlap', async () => {
  // C2-P0-1: a daemon unconditionally arms the heartbeat and its own janitor, and
  // the janitor REPLACES a watcher owned by another pid. Starting one from off mode
  // silently removed the plugin's crash cleanup and a daemon crash tore down the
  // engine the plugin was still using. The route answers "unavailable" and the
  // client falls back to the standalone window.
  assert.match(host, /if \(options\.daemonMode !== 'auto'\) \{\n[\s\S]{0,300}daemonMode=off：IDE 请用独立窗口/)
  assert.doesNotMatch(host, /显式请求启动了 risd/)
})

test('a hot reload from off to auto drops the legacy exit hook and janitor', async () => {
  // Review C-P1-6: the exit hook, heartbeat and janitor installed by an earlier
  // apply stay in the process across a profile hot reload; in auto mode the daemon
  // owns all three and two owners would fight over the engine.
  assert.match(host, /function releaseLegacyLifecycle\(\) \{/)
  assert.match(host, /if \(options\.daemonMode === 'auto'\) \{\n\s+\/\/ Switching off→auto[\s\S]{0,300}releaseLegacyLifecycle\(\)/)
})

test('an api-version mismatch is a "restart dsh" answer, not a failed start (C-P2-1)', () => {
  // The daemon's own 409 code: the same mismatched binary stays running, so retrying
  // the spawn would only burn the heal breaker (and the page would say "版本与插件不一致"
  // only after three tool calls stopped working).
  assert.match(host, /const mismatch = ensured\.reason === 'api-mismatch'/)
  assert.match(host, /if \(ensured\.reason === 'api-mismatch'\) \{\n\s+warnDaemonMismatch\(\)/)
  assert.match(host, /code === 'api-mismatch'[\s\S]{0,200}risd-upgrade-required/)
  // The forward path maps it to design §7.1's 503 instead of reusing the 409 branch.
  assert.match(host, /new TailError\('risd-upgrade-required'[\s\S]{0,120}503\)/)
})
