// Stale-UI handshake (m09693): the plugin tells an open page which client bundle
// the host serves now, so a page that booted an older one can reload itself instead
// of relying on the user pressing Ctrl+Shift+R.
//
// The daemon half (its own module graph) lives in test/risd-api.test.mjs and
// test/risd-ui.test.mjs; this file covers the host route plus the client hook.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { handleRequest } from '../lib/index.js'

let home
let workspace
let server
let port

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-build-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'dsh-build-ws-'))
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  server = createServer((req, res) => {
    handleRequest({ sessions: { get: () => ({ header: { cwd: workspace } }) } }, req, res, { maxBytes: 1024, restrictToCwd: false })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  delete process.env.DSH_RIS_IDE_PROXY_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function getJson(path, host) {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(text) } catch { body = null }
        resolve({ status: res.statusCode, body })
      })
    })
    call.on('error', () => resolve({ status: 0, body: null }))
    call.end()
  })
}

test('GET /dsh-ris-ide/build names the client bundle being served', async () => {
  const { status, body } = await getJson('/dsh-ris-ide/build')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.build, /^[0-9a-f]{12}$/, 'a stable 12-hex stamp, not a raw mtime')
})

test('the stamp is stable while the bundle does not change', async () => {
  // A page takes its FIRST answer as the baseline; a stamp that wobbled between two
  // requests would make every page reload itself in a loop.
  const first = await getJson('/dsh-ris-ide/build')
  const second = await getJson('/dsh-ris-ide/build')
  assert.equal(first.body.build, second.body.build)
})

test('a non-loopback Host cannot read the build stamp', async () => {
  const { status } = await getJson('/dsh-ris-ide/build', 'evil.example')
  assert.equal(status, 403)
})

test('the build route is read-only', async () => {
  const status = await new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path: '/dsh-ris-ide/build', method: 'POST', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    call.on('error', () => resolve(0))
    call.end()
  })
  assert.equal(status, 405)
})

test('a stale page offers a refresh and never reloads itself', () => {
  // Source-level assertions: both lives of this watcher (stream hello and the
  // slow poll) must compare against the SAME baseline, otherwise a page could
  // "notice" its own seed and raise a hint for nothing. Reloading is a user
  // action — an automatic reload would throw away the IDE window's unsaved
  // buffers (review C3-P1-2), so the watcher must not navigate by itself.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const watcher = source.slice(source.indexOf('function watchClientBuild()'), source.indexOf('function selectProgram'))
  assert.match(watcher, /function watchClientBuild\(\)/)
  assert.match(watcher, /pageBuildId === null/)
  assert.match(watcher, /note\(payload\.build\)/, 'the stream hello carries the stamp')
  assert.match(watcher, /routeUrl\('dsh-ris-ide\/build'\)/, 'the baseline is seeded before the hello arrives')
  assert.doesNotMatch(watcher, /location\.reload\(\)/, 'no self-reload: it would drop unsaved editor buffers')
  assert.match(watcher, /showStaleBuildNotice\(build\)/, 'the bar names the build it warns about')
  assert.match(watcher, /BUILD_POLL_MS/, 'a foreground page re-asks on a slow timer')
  assert.match(watcher, /setInterval\(pollBuild, BUILD_POLL_MS\)/)
  assert.match(watcher, /addEventListener\('focus', pollBuild\)/, 'coming back to the tab also re-checks')
  assert.match(watcher, /staleNoticeDismissedFor/, 'a dismissed hint stays closed for that build')
})

test('the stale-build bar carries a refresh button', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const notice = source.slice(source.indexOf('function showStaleBuildNotice'), source.indexOf('function watchClientBuild'))
  assert.match(notice, /textContent = '刷新'/)
  assert.match(notice, /location\.reload\(\)/, 'the reload happens only when the user clicks it')
  assert.match(notice, /staleNoticeDismissedFor = staleNoticeBuild/)
})
