// P4: the agent tools ask risd first when the plugin runs in daemonMode=auto.
//
// These tests never boot a real daemon: a tiny HTTP server records what the
// tools ask for, __test.setRisdBridge() points the plugin at it, and the local
// branch stays available as the fallback (checked by closing the server).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerAgentTools, __test } from '../lib/index.js'

const ROW = {
  id: 'demo',
  name: 'demo',
  kind: 'spring',
  logName: 'demo',
  dir: '.',
  relDir: '.',
  logPath: '/tmp/risd-tools.test/demo.log',
  running: { pid: 11, alive: true, uptimeMs: 1000 },
}

function fakeDaemon() {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw === '' ? undefined : JSON.parse(raw)
      requests.push({ method: req.method, url: req.url, body })
      const json = (value) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      const url = String(req.url ?? '')
      // C-P2-2: the tools probe /v1/health once per window before trusting the
      // bridge's daemon pointer, so the fake daemon has to answer it like the real one.
      if (req.method === 'GET' && url === '/v1/health') {
        return json({ ok: true, apiVersion: 1, version: '1.8.0', pid: 4242, port: server.address().port, state: 'ready' })
      }
      if (req.method === 'GET' && url.startsWith('/v1/programs/log')) {
        return json({ ok: true, path: ROW.logPath, exists: true, running: true, pid: 11, text: 'line1\nline2\n' })
      }
      if (req.method === 'GET' && url.startsWith('/v1/programs')) {
        return json({ ok: true, cwd: '/tmp/ws', dir: 'logs', programs: [ROW] })
      }
      if (req.method === 'POST' && url === '/v1/programs') {
        return json({ ok: true, cwd: '/tmp/ws', action: body?.action, alreadyRunning: false, program: ROW })
      }
      if (req.method === 'POST' && url === '/v1/debug') {
        if (body?.action === 'status') return json({ ok: true, action: 'status', attached: false, port: 0 })
        if (body?.action === 'breakpoints') return json({ ok: true, breakpoints: [{ id: 1, className: 'A', line: 12 }] })
        if (body?.action === 'threads') return json({ ok: true, threads: [{ id: 't1', name: 'main' }] })
        return json({ ok: true, action: body?.action })
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'not-found' }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}

function toolContext(cwd, warnings = []) {
  const definitions = new Map()
  const ctx = {
    sessions: { get: () => ({ header: { cwd } }) },
    tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
    logger: { warn(message) { warnings.push(String(message)) } },
  }
  return { ctx, definitions }
}

const exec = { agent: { session: { id: 'session-1' } } }

test('ris_dev_programs reads the daemon rows in auto mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'risd-tools-'))
  const daemon = await fakeDaemon()
  try {
    __test.setRisdBridge({ mode: 'auto', state: { url: `http://127.0.0.1:${daemon.port}`, port: daemon.port, token: 't', apiVersion: 1, pid: 4242, home: cwd }, leaseId: null, pending: null })
    const { ctx, definitions } = toolContext(cwd)
    registerAgentTools(ctx, { daemonMode: 'auto' })
    const value = await definitions.get('ris_dev_programs').execute({}, exec)
    assert.equal(value.ok, true)
    assert.equal(value.programs[0].id, 'demo')
    assert.ok(daemon.requests.some((request) => request.method === 'GET' && request.url.startsWith('/v1/programs?cwd=')))
  } finally {
    __test.setRisdBridge(null)
    await daemon.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('ris_dev_start / ris_dev_logs go through the daemon', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'risd-tools-'))
  const daemon = await fakeDaemon()
  try {
    __test.setRisdBridge({ mode: 'auto', state: { url: `http://127.0.0.1:${daemon.port}`, port: daemon.port, token: 't', apiVersion: 1, pid: 4242, home: cwd }, leaseId: null, pending: null })
    const { ctx, definitions } = toolContext(cwd)
    registerAgentTools(ctx, { daemonMode: 'auto' })

    const started = await definitions.get('ris_dev_start').execute({ id: 'demo' }, exec)
    assert.equal(started.ok, true)
    assert.equal(started.alreadyRunning, false)
    assert.equal(started.program.id, 'demo')
    assert.ok(daemon.requests.some((request) => request.method === 'POST' && request.body?.action === 'start'))

    const logs = await definitions.get('ris_dev_logs').execute({ id: 'demo', lines: 10 }, exec)
    assert.equal(logs.ok, true)
    assert.equal(logs.running, true)
    assert.match(logs.content, /line2/)
  } finally {
    __test.setRisdBridge(null)
    await daemon.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('ris_dev_debug state and threads are answered by the daemon', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'risd-tools-'))
  const daemon = await fakeDaemon()
  try {
    __test.setRisdBridge({ mode: 'auto', state: { url: `http://127.0.0.1:${daemon.port}`, port: daemon.port, token: 't', apiVersion: 1, pid: 4242, home: cwd }, leaseId: null, pending: null })
    const { ctx, definitions } = toolContext(cwd)
    registerAgentTools(ctx, { daemonMode: 'auto' })
    const debug = definitions.get('ris_dev_debug')

    const state = await debug.execute({ action: 'state', id: 'demo' }, exec)
    assert.equal(state.ok, true)
    assert.equal(state.debug.attached, false)
    assert.equal(state.breakpoints.length, 1)
    const debugCalls = () => daemon.requests
      .filter((request) => request.url === '/v1/debug')
      .map((request) => request.body.action)
    assert.deepEqual(debugCalls().slice(0, 2), ['status', 'breakpoints'])

    const threads = await debug.execute({ action: 'threads', id: 'demo' }, exec)
    assert.equal(threads.ok, true)
    assert.equal(threads.threads[0].id, 't1')
    assert.ok(debugCalls().includes('threads'))
  } finally {
    __test.setRisdBridge(null)
    await daemon.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a stopped daemon falls back to the local implementation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'risd-tools-'))
  const daemon = await fakeDaemon()
  __test.setRisdBridge({ mode: 'auto', state: { url: `http://127.0.0.1:${daemon.port}`, port: daemon.port, token: 't', apiVersion: 1, pid: 4242, home: cwd }, leaseId: null, pending: null })
  const { ctx, definitions } = toolContext(cwd)
  registerAgentTools(ctx, { daemonMode: 'auto' })
  // Trip the heal breaker: without a daemon this call must fall back locally, not
  // spawn a real one (which would also make the assertion meaningless).
  for (let attempt = 0; attempt < 3; attempt += 1) __test.noteRisdHealFailure('probe failed', Date.now())
  await daemon.close()
  try {
    const value = await definitions.get('ris_dev_programs').execute({}, exec)
    assert.equal(value.ok, true)
    // The local branch scans the (empty) workspace itself: same contract, no daemon.
    assert.deepEqual(value.programs, [])
  } finally {
    __test.setRisdBridge(null)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a half-dead daemon is demoted and the fallback is said out loud (C-P2-2)', async () => {
  // Before: a non-null pointer was trusted forever, so each tool call paid a 2 s
  // timeout and quietly ran locally — the programs it started were then invisible to
  // the daemon (stopping the daemon would not stop them).
  const cwd = mkdtempSync(join(tmpdir(), 'risd-tools-'))
  const home = mkdtempSync(join(tmpdir(), 'risd-tools-home-'))
  const previousHome = process.env.DSH_RIS_IDE_PROXY_HOME
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  const bridge = { mode: 'auto', state: { url: 'http://127.0.0.1:9', port: 9, token: 't', apiVersion: 1 }, leaseId: null, pending: null, degraded: false, lastProbeAt: 0 }
  try {
    // Trip the heal breaker so the call cannot spawn a real daemon: this test is about
    // the probe + warning, not about the spawn path.
    const now = Date.now()
    __test.setRisdBridge(bridge)
    for (let attempt = 0; attempt < 3; attempt += 1) __test.noteRisdHealFailure('probe failed', now)
    const warnings = []
    const { ctx, definitions } = toolContext(cwd, warnings)
    registerAgentTools(ctx, { daemonMode: 'auto' })
    const value = await definitions.get('ris_dev_programs').execute({}, exec)
    assert.equal(value.ok, true, 'the local implementation still answers')
    assert.equal(bridge.state, null, 'the dead pointer is dropped')
    assert.equal(bridge.degraded, true)
    assert.ok(warnings.some((message) => /不在 daemon 的托管范围内（停 daemon 不会停它）/.test(message)),
      `expected a local-fallback warning, got ${JSON.stringify(warnings)}`)
  } finally {
    __test.setRisdBridge(null)
    if (previousHome === undefined) delete process.env.DSH_RIS_IDE_PROXY_HOME
    else process.env.DSH_RIS_IDE_PROXY_HOME = previousHome
    rmSync(cwd, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
