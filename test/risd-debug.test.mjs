// Daemon-side JDWP ownership (P3): one window owns a program's session, and the
// breakpoint set survives a daemon restart as pending breakpoints (an attached
// socket cannot survive, and is not pretended to).
//
// No JVM here: the engine takes a fake JDWP client and fake start/stop hooks, so the
// test is about ownership + persistence rather than the protocol.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createDebugEngine } from '../lib/risd/debug.js'

let home
let workspace

/** The smallest fake client the session registry drives. */
function fakeClient(calls = []) {
  const record = (name) => (...args) => { calls.push([name, ...args]) }
  return {
    isConnected: true,
    vmSuspended: true,
    allSuspendedThreadIds: [11n],
    currentThreadId: 11n,
    on() {},
    connect: record('connect'),
    disconnect: record('disconnect'),
    getBreakpoints: () => [],
    setBreakpoint: async (className, line, policy) => { calls.push(['setBreakpoint', className, line, policy]); return { requestId: 2, className, line } },
    removeBreakpoint: record('removeBreakpoint'),
    clearAllBreakpoints: record('clearAllBreakpoints'),
    getAllThreads: async () => [{ threadId: 11n, name: 'main' }],
    getFrames: async (threadId, start, max) => [{ frameId: 5n, location: { classID: 1n, methodID: 2n, index: 3n }, methodName: 'm', lineNumber: 9 }],
    getFrameVariables: async () => [{ name: 'i', value: 10, signature: 'I', slot: 1, tag: 2 }],
    getObjectDetails: async () => ({ kind: 'object', className: 'a.B', signature: 'La/B;', fields: [] }),
    stepOver: record('stepOver'),
    stepInto: record('stepInto'),
    stepOut: record('stepOut'),
    resumeVM: record('resumeVM'),
    resumeThread: record('resumeThread'),
    suspendVM: record('suspendVM'),
  }
}

function engineOptions(overrides = {}) {
  return Object.assign({
    home,
    clientFactory: () => fakeClient(),
    startProgram: async (cwd, logsDir, program) => ({ program, port: 5005 }),
    stopProgram: async () => ({ stopped: true }),
    waitListening: async () => true,
    attachTimeoutMs: 200,
  }, overrides)
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'risd-debug-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'risd-debug-ws-'))
  mkdirSync(join(workspace, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    defaults: {},
    programs: [
      {
        id: 'svc', name: 'svc', kind: 'spring', dir: workspace, relDir: '.', project: '',
        logName: 'svc', logPath: join(workspace, 'logs', 'svc.log'),
        startCommand: 'java ${JDWP_ARGS} -cp target/classes cn.com.ris.App',
      },
      {
        id: 'web', name: 'web', kind: 'frontend', dir: workspace, relDir: '.', project: '',
        logName: 'web', logPath: join(workspace, 'logs', 'web.log'),
      },
    ],
  }, null, 2)}\n`)
  mkdirSync(join(workspace, 'logs'), { recursive: true })
  writeFileSync(join(workspace, 'logs', 'svc.log'), 'Listening for transport dt_socket at address: 5005\n')
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

test('the window that starts a session owns it; another window cannot step it', async () => {
  const engine = createDebugEngine(engineOptions())
  const started = await engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  assert.equal(started.attached, true)
  assert.ok(Number.isInteger(started.port) && started.port > 1024, `unexpected jdwp port ${started.port}`)
  assert.equal((await engine.run({ action: 'status', cwd: workspace, id: 'svc' })).owner, 'window-a')

  await assert.rejects(
    () => engine.run({ action: 'step', cwd: workspace, id: 'svc', kind: 'over', sessionId: 'window-b' }),
    (error) => error.code === 'debug-owned',
  )
  // reads are shared: the other window may still look at threads
  assert.equal((await engine.run({ action: 'threads', cwd: workspace, id: 'svc', sessionId: 'window-b' })).threads.length, 1)
  // the owner can step
  assert.equal((await engine.run({ action: 'step', cwd: workspace, id: 'svc', kind: 'over', sessionId: 'window-a' })).stepped, 'over')
})

test('a breakpoint survives the daemon as a pending breakpoint', async () => {
  const engine = createDebugEngine(engineOptions())
  await engine.run({ action: 'breakpoint-add', cwd: workspace, id: 'svc', className: 'cn.com.ris.App', line: 12, sessionId: 'window-a' })
  const saved = JSON.parse(readFileSync(join(home, 'risd-debug.json'), 'utf8'))
  const entries = Object.values(saved.breakpoints).flat()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].className, 'cn.com.ris.App')
  assert.equal(entries[0].line, 12)

  // A fresh daemon (new engine over the same home) restores it without a JVM.
  const restarted = createDebugEngine(engineOptions())
  const status = await restarted.run({ action: 'status', cwd: workspace, id: 'svc' })
  assert.equal(status.attached, false)
  assert.equal(status.breakpoints.length, 1)
  assert.equal(status.breakpoints[0].pending, true)
  assert.equal(status.breakpoints[0].className, 'cn.com.ris.App')
})

test('detach ends the session without stopping the program', async () => {
  const calls = []
  let stopped = false
  const engine = createDebugEngine(engineOptions({
    clientFactory: () => fakeClient(calls),
    stopProgram: async () => { stopped = true; return { stopped: true } },
  }))
  await engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  const detached = await engine.run({ action: 'detach', logPath: join(workspace, 'logs', 'svc.log') })
  assert.equal(detached.detached, true)
  assert.equal(stopped, false, 'detach must not stop the JVM')
  assert.equal(await engine.size, 0)
})

test('debug start refuses non-Java rows and custom commands without the JDWP placeholder', async () => {
  const engine = createDebugEngine(engineOptions())
  await assert.rejects(
    () => engine.run({ action: 'start', cwd: workspace, id: 'web', sessionId: 'window-a' }),
    (error) => error.code === 'not-startable',
  )
  // custom without ${JDWP_ARGS}: rewrite the fixture config and retry
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    defaults: {},
    programs: [{
      id: 'svc2', name: 'svc2', kind: 'spring', dir: workspace, relDir: '.', project: '',
      logName: 'svc2', logPath: join(workspace, 'logs', 'svc2.log'), startCommand: 'java -cp target/classes cn.com.ris.App',
    }],
  }, null, 2)}\n`)
  await assert.rejects(
    () => engine.run({ action: 'start', cwd: workspace, id: 'svc2', sessionId: 'window-a' }),
    (error) => error.code === 'not-startable',
  )
})

function restoreFixture() {
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    defaults: {},
    programs: [{
      id: 'svc', name: 'svc', kind: 'spring', dir: workspace, relDir: '.', project: '',
      logName: 'svc', logPath: join(workspace, 'logs', 'svc.log'),
      startCommand: 'java ${JDWP_ARGS} -cp target/classes cn.com.ris.App',
    }],
  }, null, 2)}\n`)
}

test('a failed attach does not leave a frozen JVM behind', async () => {
  restoreFixture()
  // Review B-P1-2: the JVM was started with suspend=y, attach then failed, and
  // nobody was left to resume or stop it — a frozen process on a bare JDWP port.
  const stopped = []
  const engine = createDebugEngine(engineOptions({
    clientFactory: () => { throw new Error('connect refused') },
    stopProgram: async (logPath) => { stopped.push(logPath); return { stopped: true } },
  }))
  await assert.rejects(
    () => engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' }),
    (error) => error.code === 'debug-failed',
  )
  assert.deepEqual(stopped, [join(workspace, 'logs', 'svc.log')], 'the half-started program is stopped again')
})

test('dropping owners lets the next window drive the session', async () => {
  restoreFixture()
  // Review B-P1-1: owner ids belonged to dsh windows that no longer exist, so a
  // fresh window was locked out with 409 debug-owned until the daemon restarted.
  const engine = createDebugEngine(engineOptions())
  await engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  engine.releaseOwners()
  const stepped = await engine.run({ action: 'step', cwd: workspace, id: 'svc', kind: 'over', sessionId: 'window-b' })
  assert.equal(stepped.stepped, 'over')
})

test('a JVM left behind by a dead daemon is reported as stale (B-P2-13)', async () => {
  restoreFixture()
  const logPath = join(workspace, 'logs', 'svc.log')
  const engine = createDebugEngine(engineOptions({
    // A real start reports the JVM pid; without it the record cannot be pruned.
    startProgram: async (cwd, logsDir, program) => ({
      program: Object.assign({}, program, { running: { pid: process.pid, alive: true } }),
      port: 5005,
    }),
  }))
  const started = await engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  const saved = JSON.parse(readFileSync(join(home, 'risd-debug.json'), 'utf8'))
  assert.equal(saved.sessions.length, 1)
  assert.equal(saved.sessions[0].logPath, logPath)
  assert.equal(saved.sessions[0].port, started.port)
  assert.equal(saved.sessions[0].pid, process.pid)

  // The daemon was SIGKILLed: the socket is gone but the JVM still listens on the
  // random JDWP port. A new daemon must report it instead of forgetting it.
  const restarted = createDebugEngine(engineOptions())
  const sessions = await restarted.run({ action: 'sessions' })
  assert.equal(sessions.sessions.length, 0)
  assert.equal(sessions.stale.length, 1)
  assert.equal(sessions.stale[0].port, started.port)
  assert.equal(sessions.stale[0].pid, process.pid)
  assert.equal(sessions.stale[0].logPath, logPath)

  // Stopping the program clears the record on disk as well.
  await restarted.run({ action: 'stop', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  const third = createDebugEngine(engineOptions())
  assert.deepEqual((await third.run({ action: 'sessions' })).stale, [])
})

test('a stale record whose JVM is gone is dropped, not shown (B-P2-13)', async () => {
  writeFileSync(join(home, 'risd-debug.json'), `${JSON.stringify({
    version: 1,
    breakpoints: {},
    session: { logPath: join(workspace, 'logs', 'svc.log'), port: 4999, pid: 999999, startedAt: new Date().toISOString() },
  }, null, 2)}\n`)
  const engine = createDebugEngine(engineOptions())
  assert.deepEqual((await engine.run({ action: 'sessions' })).stale, [])
})

test('a session kept only on disk is listed as stale and can be forgotten (D3)', async () => {
  restoreFixture()
  const logPath = join(workspace, 'logs', 'svc.log')
  const engine = createDebugEngine(engineOptions({
    startProgram: async (cwd, logsDir, program) => ({
      program: Object.assign({}, program, { running: { pid: process.pid, alive: true } }),
      port: 5005,
    }),
  }))
  await engine.run({ action: 'start', cwd: workspace, id: 'svc', sessionId: 'window-a' })
  await engine.run({ action: 'breakpoint-add', cwd: workspace, id: 'svc', className: 'cn.com.ris.App', line: 12, sessionId: 'window-a' })

  // New daemon: the socket is gone (the "JVM" pid here is this test process, alive),
  // so the record is stale and the page can offer to clear it.
  const restarted = createDebugEngine(engineOptions())
  const listed = await restarted.run({ action: 'sessions' })
  assert.equal(listed.sessions.length, 0)
  assert.equal(listed.stale.length, 1)
  assert.equal(listed.stale[0].logPath, logPath)
  const forgotten = await restarted.run({ action: 'forget', logPath })
  assert.equal(forgotten.forgotten, true)
  assert.equal((await restarted.run({ action: 'sessions' })).stale.length, 0)
  const saved = JSON.parse(readFileSync(join(home, 'risd-debug.json'), 'utf8'))
  assert.deepEqual(saved.breakpoints, {})
  assert.equal(saved.sessions, undefined)
})
