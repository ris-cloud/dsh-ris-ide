/**
 * Debug engine tests: the JDWP launch argument, port allocation, the session
 * registry (with a fake client) and a real-JVM integration run (skipped on
 * machines without a JDK).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __test } from '../lib/index.js'

const T = __test
const hasJavac = spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0
const hasJava = spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0

/** A fake JDWP client that records every call (the registry is what we test). */
function fakeClient(calls) {
  const handlers = new Map()
  const record = (name) => (...args) => {
    calls.push([name, ...args])
  }
  const client = {
    isConnected: true,
    vmSuspended: true,
    allSuspendedThreadIds: [11n],
    currentThreadId: 11n,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    connect: record('connect'),
    disconnect: record('disconnect'),
    getBreakpoints: () => [{ requestId: 1, className: 'a.B', line: 7 }],
    setBreakpoint: async (className, line, policy) => {
      calls.push(['setBreakpoint', className, line, policy])
      return { requestId: 2, className, line }
    },
    removeBreakpoint: record('removeBreakpoint'),
    clearAllBreakpoints: record('clearAllBreakpoints'),
    getAllThreads: async () => [{ threadId: 11n, name: 'main' }],
    getFrames: async (threadId, start, max) => {
      calls.push(['getFrames', threadId, start, max])
      return [{ frameId: 5n, location: { classID: 1n, methodID: 2n, index: 3n }, methodName: 'm', lineNumber: 9 }]
    },
    getFrameVariables: async (threadId, frameId, location) => {
      calls.push(['getFrameVariables', threadId, frameId, location])
      return [{ name: 'i', value: 10, signature: 'I', slot: 1, tag: 2 }]
    },
    getObjectDetails: async (objectId) => {
      calls.push(['getObjectDetails', objectId])
      return { kind: 'object', className: 'a.B', signature: 'La/B;', fields: [{ name: 'x', value: 1, signature: 'I', tag: 2 }] }
    },
    stepOver: record('stepOver'),
    stepInto: record('stepInto'),
    stepOut: record('stepOut'),
    resumeVM: record('resumeVM'),
    resumeThread: record('resumeThread'),
    suspendVM: record('suspendVM'),
  }
  return client
}

test('jdwpAgentArg binds loopback and honours suspend', () => {
  assert.equal(T.jdwpAgentArg(5005), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005')
  assert.match(T.jdwpAgentArg(6006, true), /suspend=y,address=127\.0\.0\.1:6006$/)
  assert.throws(() => T.jdwpAgentArg(0), /invalid debug port/)
})

test('toJsonSafe converts BigInt ids and keeps the shape', () => {
  assert.equal(T.toJsonSafe(123n), '123')
  assert.deepEqual(T.toJsonSafe({ a: 1n, b: [2n, undefined] }), { a: '1', b: ['2', null] })
})

test('allocateDebugPort returns a port number', async () => {
  const port = await T.allocateDebugPort()
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, `unexpected port ${port}`)
})

test('waitForJdwpListening waits for the JVM line instead of probing the port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-jdwp-'))
  const logPath = join(dir, 'x.log')
  await writeFile(logPath, '--- started ---\n')
  // not listening yet ⇒ it keeps waiting and then explains why
  await assert.rejects(() => T.waitForJdwpListening(logPath, 5123, 300), /JDWP 端口 5123 没有在 300ms 内就绪/)
  await writeFile(logPath, '--- started ---\nListening for transport dt_socket at address: 5123\n')
  assert.equal(await T.waitForJdwpListening(logPath, 5123, 500), true)
})

test('the debug session registry maps the engine API', async () => {
  const calls = []
  const client = fakeClient(calls)
  const sessions = T.createDebugSessions({ clientFactory: () => client })
  const program = { id: 'spring:x#a.B', name: 'x', logPath: '/tmp/x.log' }
  const attached = await sessions.attach(program, 5100)
  assert.deepEqual(calls[0], ['connect', '127.0.0.1', 5100])
  assert.equal(attached.attached, true)
  assert.deepEqual(attached.suspendedThreads, ['11'])
  assert.equal(attached.currentThreadId, '11', 'the stopped thread is reported so the IDE can read its frames')

  // engine events land in the ring, JSON-safe
  // requestId 1 is the fake client's registered breakpoint (a.B:7) → the event is
  // tagged with it; an unknown request stays untagged.
  client.emit('breakpoint', { requestId: 1, threadId: 11n, location: { index: 3n } })
  client.emit('breakpoint', { requestId: 99, threadId: 11n, location: { index: 4n } })
  const polled = sessions.poll('/tmp/x.log', 0)
  assert.equal(polled.seq >= 2, true)
  const hit = polled.events.find((event) => event.type === 'breakpoint')
  assert.equal(hit.payload.threadId, '11', 'BigInt ids are strings in the event payload')
  // The event is tagged with the breakpoint it belongs to (the fake client reports
  // requestId 1 = a.B:7), so a second consumer can tell whose breakpoint hit.
  assert.equal(hit.payload.className, 'a.B')
  assert.equal(hit.payload.line, 7)
  const unknown = polled.events.filter((event) => event.type === 'breakpoint' && event.payload.requestId === 99)[0]
  assert.equal(unknown.payload.className, undefined, 'an unknown request id is left alone')
  assert.equal(JSON.stringify(polled).includes('"threadId":"11"'), true)

  assert.equal(sessions.status('/tmp/x.log').attached, true)
  assert.deepEqual(sessions.listBreakpoints('/tmp/x.log'), [{ requestId: 1, className: 'a.B', line: 7 }])
  const threads = await sessions.threads('/tmp/x.log')
  assert.equal(threads[0].threadId, '11')
  const frames = await sessions.stack('/tmp/x.log', '11', 0, 10)
  assert.equal(frames[0].frameId, '5')
  assert.equal(frames[0].methodName, 'm')
  const vars = await sessions.variables('/tmp/x.log', '11', 0)
  assert.equal(vars[0].name, 'i')
  assert.deepEqual(calls.find((call) => call[0] === 'getFrameVariables').slice(2), [5n, { classID: 1n, methodID: 2n, index: 3n }])

  // An object variable expands on demand (the IDE lazily fetches its fields).
  const expanded = await sessions.expand('/tmp/x.log', '42')
  assert.equal(expanded.kind, 'object')
  assert.equal(expanded.fields[0].name, 'x')
  assert.deepEqual(calls.find((call) => call[0] === 'getObjectDetails').slice(1), [42n])
  await assert.rejects(() => sessions.expand('/tmp/x.log', '4x'), /decimal JDWP object id/)

  const breakpoint = await sessions.addBreakpoint('/tmp/x.log', ' a.B ', 12, 'all')
  assert.deepEqual(breakpoint, { requestId: 2, className: 'a.B', line: 12 })
  assert.deepEqual(calls.find((call) => call[0] === 'setBreakpoint').slice(1), ['a.B', 12, 'all'])

  await sessions.step('/tmp/x.log', 'over')
  await sessions.step('/tmp/x.log', 'into')
  await sessions.step('/tmp/x.log', 'out')
  assert.deepEqual(calls.filter((call) => call[0].startsWith('step')).map((call) => call[0]), ['stepOver', 'stepInto', 'stepOut'])
  await sessions.resume('/tmp/x.log')
  await sessions.resume('/tmp/x.log', '11')
  await sessions.pause('/tmp/x.log')
  assert.deepEqual(calls.filter((call) => ['resumeVM', 'resumeThread', 'suspendVM'].includes(call[0])).map((call) => call[0]), ['resumeVM', 'resumeThread', 'suspendVM'])

  // bad arguments and detached sessions fail with machine codes
  await assert.rejects(() => sessions.addBreakpoint('/tmp/x.log', '', 1), (error) => error.code === 'bad-argument')
  await assert.rejects(() => sessions.stack('/tmp/x.log', 'abc'), (error) => error.code === 'bad-argument')
  await assert.rejects(() => sessions.step('/tmp/x.log', 'sideways'), (error) => error.code === 'bad-argument')
  await assert.rejects(() => sessions.threads('/tmp/none.log'), (error) => error.code === 'not-attached')
  assert.equal(sessions.status('/tmp/none.log').attached, false, 'status never throws (the panel polls it)')

  assert.deepEqual(await sessions.detach('/tmp/x.log'), { detached: true })
  assert.equal(sessions.status('/tmp/x.log').attached, false)
  assert.deepEqual(await sessions.detach('/tmp/x.log'), { detached: false })
})

test('a start in debug mode puts the JDWP agent into both launch plans', () => {
  const program = { kind: 'spring', dir: '/w/ris/m', mainClass: 'a.B', args: [], logName: 'm', jvmArgs: ['-Xmx1g'] }
  const posix = T.buildStartSpec(program, { workspace: '/w', logsDir: '/w/logs', debug: { port: 5005 } })
  assert.match(posix.command, /-Dcsp\.sentinel\.log\.dir=[^ ]+ -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127\.0\.0\.1:5005 -Xmx1g -cp "target\/classes:\$\(cat target\/cp\.txt\)"/)
  const windows = T.windowsStartSpec(program, { workspace: '/w', logsDir: '/w/logs', debug: { port: 5006, suspend: true } })
  assert.deepEqual(windows.spec.jvmArgs[0], '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5006')
  assert.equal(windows.spec.jvmArgs[1], '-Xmx1g')
  // no debug option ⇒ no agent argument
  assert.doesNotMatch(T.buildStartSpec(program, { workspace: '/w', logsDir: '/w/logs' }).command, /-agentlib:jdwp/)
})

test('real JVM: attach, breakpoint hit, stack, variables, step, detach', {
  skip: !hasJavac || !hasJava,
  timeout: 90000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-debug-'))
  await writeFile(join(dir, 'Probe.java'), [
    'public class Probe {',
    '  static int tick = 0;',
    '  public static void main(String[] args) throws Exception {',
    '    for (int i = 0; i < 1000; i++) { tick = work(i); Thread.sleep(100); }',
    '  }',
    '  static int work(int i) {',
    '    int doubled = i * 2;',
    '    String label = "tick-" + i;',
    '    return doubled + label.length();',
    '  }',
    '}',
  ].join('\n'))
  const compiled = spawnSync('javac', ['-g', 'Probe.java'], { cwd: dir, stdio: 'ignore' })
  assert.equal(compiled.status, 0, 'the fixture compiles')

  const port = await T.allocateDebugPort()
  const logPath = join(dir, 'probe.log')
  const { openSync } = await import('node:fs')
  const logFd = openSync(logPath, 'a')
  const child = spawn('java', [
    `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`,
    '-cp', dir, 'Probe',
  ], { cwd: dir, stdio: ['ignore', logFd, logFd] })
  const sessions = T.createDebugSessions()
  try {
    // same contract as the real start path: wait for the JVM's own JDWP line
    await T.waitForJdwpListening(logPath, port, 30000)
    await sessions.attach({ id: 'spring:probe#Probe', name: 'probe', logPath }, port)
    const breakpoint = await sessions.addBreakpoint(logPath, 'Probe', 8, 'thread')
    assert.equal(breakpoint.className, 'Probe')
    assert.equal(breakpoint.line, 8)

    // wait for the breakpoint event (the loop calls work() every 100ms)
    const deadline = Date.now() + 15000
    let hit
    while (Date.now() < deadline) {
      const polled = sessions.poll(logPath, 0)
      hit = polled.events.find((event) => event.type === 'breakpoint')
      if (hit !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(hit !== undefined, 'the breakpoint is hit')
    const threadId = hit.payload.threadId
    assert.equal(typeof threadId, 'string')

    // The IDE learns "paused" from the SNAPSHOT, not from vmSuspended: a breakpoint
    // suspends only its own thread (SuspendPolicy.EventThread), so the VM keeps
    // running and vmSuspended stays false. Reading the wrong thread is what left
    // the call stack / variables empty in the panel.
    const stopped = sessions.poll(logPath, 0)
    assert.deepEqual(stopped.suspendedThreads, [threadId], 'the hit thread is reported as suspended')
    assert.equal(stopped.currentThreadId, threadId, 'currentThreadId names the thread to read frames from')
    assert.equal(stopped.vmSuspended, false, 'EventThread suspension does not suspend the VM')

    const frames = await sessions.stack(logPath, threadId, 0, 10)
    assert.equal(frames[0].methodName, 'work')
    assert.equal(frames[0].lineNumber, 8)
    const variables = await sessions.variables(logPath, threadId, 0)
    const byName = Object.fromEntries(variables.map((item) => [item.name, item.stringValue ?? item.value]))
    assert.equal(typeof byName.i, 'number', 'the parameter is readable')
    assert.equal(typeof byName.doubled, 'number', 'the local variable is readable')
    assert.equal(byName.doubled, byName.i * 2, 'the local value matches the fixture logic')

    await sessions.step(logPath, 'over', threadId)
    await sessions.resume(logPath)
    assert.equal(sessions.status(logPath).attached, true)
  } finally {
    await sessions.detach(logPath).catch(() => {})
    child.kill('SIGKILL')
  }
})


test('a custom startCommand opts into debugging via ${JDWP_ARGS}', async () => {
  const program = { kind: 'spring', dir: '/w/m', startCommand: 'cd /w/m && exec java ${JDWP_ARGS} -cp target/classes a.B', logName: 'm' }
  const debug = T.buildStartSpec(program, { workspace: '/w', logsDir: '/w/logs', debug: { port: 5007 } })
  assert.match(debug.command, /exec java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127\.0\.0\.1:5007 -cp target\/classes a\.B$/)
  const plain = T.buildStartSpec(program, { workspace: '/w', logsDir: '/w/logs' })
  assert.match(plain.command, /exec java +-cp target\/classes a\.B$/, 'the placeholder becomes a blank when not debugging')
  assert.doesNotMatch(plain.command, /-agentlib:jdwp/)
  const windows = T.windowsStartSpec(program, { workspace: '/w', logsDir: '/w/logs', debug: { port: 5008, suspend: true } })
  assert.match(windows.spec.command, /-agentlib:jdwp=.*suspend=y.*address=127\.0\.0\.1:5008/)

  // No placeholder ⇒ refused before any process is spawned
  await assert.rejects(
    () => T.startProgramDebug('/w', '/w/logs', { kind: 'spring', dir: '/w/m', startCommand: 'exec java -cp x a.B', logName: 'm', logPath: '/w/logs/m.log' }, {}),
    (error) => error.code === 'not-startable' && /JDWP_ARGS/.test(error.message),
  )
})


// ── pre-set ("打提前量") breakpoints: no session required ────────────────────
test('breakpoints can be set before any session and are installed on attach', async () => {
  const calls = []
  const client = fakeClient(calls)
  const sessions = T.createDebugSessions({ clientFactory: () => client })
  const logPath = '/tmp/pre.log'

  // (a) no session: the add is remembered instead of throwing
  const pre = await sessions.addBreakpoint(logPath, 'cn.com.ris.X', 42)
  assert.equal(pre.pending, true)
  assert.equal(pre.line, 42)
  const listed = sessions.listBreakpoints(logPath)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].pending, true)
  assert.equal(listed[0].className, 'cn.com.ris.X')
  // the poll/status the panel uses expose it too (so the gutter shows the dot)
  assert.equal(sessions.status(logPath).breakpoints.length, 1)
  assert.equal(sessions.poll(logPath, 0).breakpoints.length, 1)

  // (b) a second pre-set breakpoint, then one is removed by className+line
  await sessions.addBreakpoint(logPath, 'cn.com.ris.Y', 7)
  assert.equal(sessions.listBreakpoints(logPath).length, 2)
  await sessions.removeBreakpoint(logPath, 'pending', 'cn.com.ris.Y', 7)
  assert.deepEqual(sessions.listBreakpoints(logPath).map((bp) => bp.className), ['cn.com.ris.X'])

  // (c) attaching installs the remembered breakpoints
  const program = { id: 'spring:x#a.B', name: 'x', logPath }
  assert.equal(sessions.pendingCount(logPath), 1, 'the host can ask before booting suspended')
  const attached = await sessions.attach(program, 5100)
  assert.equal(attached.installedPending, 1, 'attach reports what it installed')
  assert.equal(sessions.pendingCount(logPath), 0, 'the pending list is consumed by the attach')
  const installed = calls.filter((call) => call[0] === 'setBreakpoint')
  assert.ok(installed.some((call) => call[1] === 'cn.com.ris.X' && call[2] === 42), 'the pre-set breakpoint reached the new session')

  // (d) clearing drops the pre-set list as well
  await sessions.detach(logPath)
  await sessions.addBreakpoint(logPath, 'cn.com.ris.Z', 9)
  await sessions.clearBreakpoints(logPath)
  assert.deepEqual(sessions.listBreakpoints(logPath), [])
})


test('a debug RESTART keeps the breakpoints (detach re-queues them for attach)', async () => {
  const calls = []
  const client = fakeClient(calls)
  const sessions = T.createDebugSessions({ clientFactory: () => client })
  const program = { id: 'spring:x#a.B', name: 'x', logPath: '/tmp/restart.log' }

  await sessions.attach(program, 5100)
  // The fake client reports one live breakpoint (a.B:7), like a real session would.
  assert.equal(sessions.listBreakpoints('/tmp/restart.log').length, 1)

  // Restart = detach + attach: the breakpoint must survive as a pre-set one…
  await sessions.detach('/tmp/restart.log')
  assert.equal(sessions.pendingCount('/tmp/restart.log'), 1, 'detach re-queued the live breakpoint')
  assert.equal(sessions.listBreakpoints('/tmp/restart.log')[0].className, 'a.B')

  // …and be installed into the fresh session.
  const before = calls.filter((call) => call[0] === 'setBreakpoint').length
  await sessions.attach(program, 5100)
  const installed = calls.filter((call) => call[0] === 'setBreakpoint')
  assert.ok(installed.length > before, 'the re-attach installed the kept breakpoint')
  assert.ok(installed.slice(before).some((call) => call[1] === 'a.B' && call[2] === 7))
  assert.equal(sessions.pendingCount('/tmp/restart.log'), 0, 'consumed by the attach')
})


test('breakpoint_remove accepts className+line (no request id) on a live session', async () => {
  const calls = []
  const client = fakeClient(calls)
  const sessions = T.createDebugSessions({ clientFactory: () => client })
  await sessions.attach({ id: 'spring:x#a.B', name: 'x', logPath: '/tmp/rm.log' }, 5100)
  // The fake session reports a.B:7 (requestId 1); the caller only knows the source location.
  const removed = await sessions.removeBreakpoint('/tmp/rm.log', undefined, 'a.B', 7)
  assert.deepEqual(removed, { removed: true, requestId: 1 })
  assert.ok(calls.some((call) => call[0] === 'removeBreakpoint' && call[1] === 1))
  // Nothing matches ⇒ a clear, actionable error instead of silently doing nothing.
  await assert.rejects(() => sessions.removeBreakpoint('/tmp/rm.log', undefined, 'a.B', 999), /requestId \(or className \+ line\) is required/)
})
