// "Stop the daemon" must stop what the daemon supervises.
//
// The maintenance page is the only UI when no dsh is open: if stopping the daemon
// left JVMs (or the proxy engine behind them) running with nothing to stop them,
// the only remedy would be `kill`. A handoff (upgrade) is different and is covered
// by risd-handoff.test.mjs — it must keep them alive.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { sleep, startRisdProcess } from './risd-helpers.mjs'

let daemon
let workspace

function api(state, path, { method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port: state.port,
      path,
      method,
      timeout: 8000,
      headers: Object.assign(
        { authorization: `Bearer ${state.token}`, 'x-risd-api-version': '1' },
        payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      ),
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', (error) => resolve({ status: 0, body: { error: String(error?.message) } }))
    if (payload !== '') req.write(payload)
    req.end()
  })
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'risd-shutdown-ws-'))
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
      stopGraceMs: 1500,
    }],
  }, null, 2)}\n`, 'utf8')
  daemon = await startRisdProcess({ port: 0 })
})

after(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
})

test('shutdown stops the programs it supervises before exiting', async () => {
  const started = await api(daemon.state, '/v1/programs', {
    method: 'POST',
    body: { cwd: workspace, action: 'start', id: 'demo' },
  })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const pid = started.body.pid
  assert.ok(Number.isInteger(pid) && pid > 0, 'the start result carries the wrapper pid')
  assert.equal(alive(pid), true, 'the program is running')

  const shutdown = await api(daemon.state, '/v1/shutdown', { method: 'POST', body: { reason: 'test' } })
  assert.equal(shutdown.status, 200)

  // Give the wrapper's TERM grace a moment, then require the process to be gone.
  let gone = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!alive(pid)) { gone = true; break }
    await sleep(200)
  }
  assert.equal(gone, true, 'stopping the daemon must not leave the program behind')
})
