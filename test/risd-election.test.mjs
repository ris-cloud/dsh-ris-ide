/**
 * risd election: one daemon per machine.
 *
 * The three outcomes a spawner must be able to tell apart are:
 * - another risd already owns the port -> harmless, exit 0, do NOT touch its state;
 * - a daemon speaking another `/v1` version owns it -> upgrade required, exit 3;
 * - something that is not risd owns it -> actionable diagnosis, exit 4.
 *
 * Killing by pid is never part of any of them, so the tests also assert that a
 * losing spawner leaves the winner's token untouched.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { readRisdState, risdStatePath } from '../lib/risd/state.js'
import { makeHome, removeHome, runRisdCli, startRisdProcess } from './risd-helpers.mjs'

test('a second daemon reports already-running and leaves the state alone', async (t) => {
  const home = makeHome()
  t.after(() => removeHome(home))
  const first = await startRisdProcess({ home })
  t.after(() => first.stop())
  const token = readRisdState(home).token

  const second = await runRisdCli(['serve', '--home', home, '--port', String(first.state.port)])
  assert.equal(second.code, 0, second.err)
  assert.match(second.err, /already running/)
  assert.equal(readRisdState(home).token, token, 'the loser must not overwrite the winner state')
  assert.equal(readRisdState(home).pid, first.state.pid)
})

test('a foreign listener on another apiVersion yields exit 3', async (t) => {
  const home = makeHome()
  t.after(() => removeHome(home))
  const foreign = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, apiVersion: 2, pid: process.pid }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  t.after(() => foreign.close())
  const port = foreign.address().port

  const result = await runRisdCli(['serve', '--home', home, '--port', String(port)])
  assert.equal(result.code, 3, result.err)
  assert.match(result.err, /upgrade required/)
})

test('a legacy /v1 daemon (no apiVersion) yields exit 3 as well', async (t) => {
  const home = makeHome()
  t.after(() => removeHome(home))
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pid: process.pid }))
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  t.after(() => foreign.close())

  const result = await runRisdCli(['serve', '--home', home, '--port', String(foreign.address().port)])
  assert.equal(result.code, 3, result.err)
})

test('a port occupied by something that is not risd yields exit 4 and a diagnosis', async (t) => {
  const home = makeHome()
  t.after(() => removeHome(home))
  const foreign = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not here')
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  t.after(() => foreign.close())

  const result = await runRisdCli(['serve', '--home', home, '--port', String(foreign.address().port)])
  assert.equal(result.code, 4, result.err)
  assert.match(result.err, /occupied/)
  assert.match(result.err, /--port/)
})

test('serve writes state 0600 in a 0700 home and removes it on shutdown', async (t) => {
  const home = makeHome()
  t.after(() => removeHome(home))
  const daemon = await startRisdProcess({ home })
  const path = risdStatePath(home)
  const state = readRisdState(home)
  assert.match(state.token, /^[0-9a-f]{64}$/)
  assert.equal(state.apiVersion, 1)
  assert.equal(state.pid, daemon.state.pid)
  assert.ok(state.port > 0)

  const { statSync } = await import('node:fs')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(home).mode & 0o777, 0o700)

  const stopped = await runRisdCli(['stop', '--home', home])
  assert.equal(stopped.code, 0, stopped.err)
  assert.equal(readRisdState(home), null)
  assert.throws(() => readFileSync(path, 'utf8'))
  void daemon
})
