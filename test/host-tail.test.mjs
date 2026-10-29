/**
 * Host-half tests: the tail reader, path containment, the loopback fence, the
 * byte clamps, and the whole route over a real node:http server.
 *
 * These run without a DSH profile: the route handler is a plain function of
 * `(ctx, req, res, ceiling)`, so a fake ctx with a session header and a real
 * listener exercise exactly what the browser will hit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __test } from '../lib/index.js'

const {
  resolvePath, isLoopbackRequest, readTail, clampBytes, serveTail, serveStop, handleRequest,
  readPidFile, readService, isAlive, isRunWithLogWrapper, listInstances,
  scanPrograms, buildStartSpec, parseJsonc, readLaunchConfigs, launchFor,
  sanitizeLogName, defaultSpringArgs, quoteShell,
  readProgramConfig, mergeProgramConfig, buildConfigDocument, detectConfigDrift,
  mergeConfigDocuments, discoverPrograms,
  registerAgentTools, resolveProgramRef, takePendingOpens, enqueueOpen,
  profileFromPomText, readProjectProfile, projectRootOf, localYmlFor, normalizeSpringArgs, resolveSpringArgs,
  configMatchesWorkspace, programsFromConfigEntries, decoratePrograms,
  normalizeStringArray, windowsStartSpec, pickGitBash, resolveWindowsRuntime, IS_WINDOWS,
  startProgram, stopLogPath, processGroupLeader, groupMembers, jsonSafe,
  SKILL_NAME, PKG_VERSION, bundledSkillPath, findProjectRoot, skillRootFor, skillFileState, installSkill,
  skillRootsFor, syncInstalledSkills,
  TAIL_PATH, STOP_PATH, INSTANCES_PATH, PROGRAMS_PATH, START_PATH, CONFIG_PATH, OPENS_PATH, DEBUG_PATH,
  DEFAULT_BYTES, HARD_MAX_BYTES, MIN_BYTES, PID_SUFFIX,
} = __test
const WRAPPER = fileURLToPath(new URL('../bin/run-with-log.sh', import.meta.url))

/** One scratch directory per test process. */
const scratch = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-'))

/**
 * Jenkins/CI 的 `bash -lc`（被测服务的启动命令就是它）会读登录 profile，可能把
 * agent 注入的 PATH 重置掉，导致服务里的 `npm`/`node` 变成 not found（status 127）。
 * 非交互 bash 会在 profile 之后读取 `BASH_ENV`，用它把当前可用的 PATH 再补回去。
 */
const ciBashEnv = join(scratch, 'ci-bash-env.sh')
await writeFile(ciBashEnv, `export PATH="${String(process.env.PATH || '')}"\n`)
process.env.BASH_ENV = ciBashEnv

/** `<n>` numbered lines, LF-terminated. */
function numberedLines(count, width = 4) {
  let out = ''
  for (let index = 1; index <= count; index += 1) out += `line ${String(index).padStart(width, '0')}\n`
  return out
}

test('readTail returns the whole file when the window is larger than it', async () => {
  const file = join(scratch, 'small.log')
  const content = numberedLines(10)
  await writeFile(file, content)
  const tail = await readTail(file, 64 * 1024)
  assert.equal(tail.mode, 'tail')
  assert.equal(tail.elided, 0)
  assert.equal(tail.content, content)
  assert.equal(tail.size, Buffer.byteLength(content))
  assert.equal(typeof tail.mtimeMs, 'number')
})

test('readTail reads the END of a file that outgrew the window', async () => {
  const file = join(scratch, 'big.log')
  const content = numberedLines(5000)
  await writeFile(file, content)
  const tail = await readTail(file, 4096)
  assert.ok(tail.elided > 0, 'the read must have elided a prefix')
  assert.ok(tail.content.length <= 4096)
  // The window is the file's tail: its last line is the file's last line.
  const fileLines = content.split('\n').filter(line => line !== '')
  const tailLines = tail.content.split('\n').filter(line => line !== '')
  assert.equal(tailLines[tailLines.length - 1], fileLines[fileLines.length - 1])
  assert.equal(tailLines[0], fileLines[fileLines.length - tailLines.length])
  // …and no partial first line survived the cut.
  assert.match(tailLines[0], /^line \d+$/)
})

test('readTail drops the partial first line and repairs a split UTF-8 character', async () => {
  const file = join(scratch, 'utf8.log')
  // 3-byte characters, so a byte window almost always lands mid-character.
  const content = Array.from({ length: 400 }, (_, index) => `中文日志 ${index} ✅`).join('\n') + '\n'
  await writeFile(file, content)
  const tail = await readTail(file, 700)
  assert.ok(tail.elided > 0)
  assert.ok(!tail.content.startsWith('\uFFFD'), 'a split leading character must be dropped, not replaced')
  assert.ok(tail.content.startsWith('中文日志 '), `expected a whole first line, got ${JSON.stringify(tail.content.slice(0, 20))}`)
  assert.ok(content.endsWith(tail.content.slice(-8)))
})

test('readTail serves an unterminated single line as-is (no newline to cut at)', async () => {
  const file = join(scratch, 'one-line.log')
  await writeFile(file, 'x'.repeat(9000))
  const tail = await readTail(file, 2048)
  assert.equal(tail.elided, 9000 - 2048)
  assert.equal(tail.content.length, 2048)
})

test('the live log view shows only the CURRENT run of a reused log file', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-run-'))
  const file = join(dir, 'svc.log')

  // string helper: keep everything from the last start marker on
  const twoRuns = [
    '--- svc started 2026-10-19T10:00:00+08:00 ---',
    '--- command: java ... ---',
    'OLD RUN LINE',
    '--- svc exited 2026-10-19T11:00:00+08:00 (status 143) ---',
    '--- svc started 2026-10-20T20:47:40+08:00 ---',
    '--- command: java ... ---',
    'NEW RUN LINE',
    '',
  ].join('\n')
  const trimmed = __test.trimToCurrentRun(twoRuns)
  assert.equal(trimmed.includes('OLD RUN LINE'), false)
  assert.match(trimmed, /^--- svc started 2026-10-20T20:47:40/, 'starts at the newest marker')
  assert.ok(trimmed.includes('NEW RUN LINE'))
  // logs without the wrapper marker (application-owned logs) stay untouched
  assert.equal(__test.trimToCurrentRun('plain app log\n'), 'plain app log\n')
  assert.equal(__test.trimToCurrentRun(''), '')
  // CRLF markers still count
  assert.equal(__test.trimToCurrentRun('a\n--- x started 1 ---\r\nb\n').startsWith('--- x started'), true)
  // byte offset helper
  const buffer = Buffer.from(twoRuns, 'utf8')
  const offset = __test.lastStartMarkerOffset(buffer)
  assert.ok(offset > 0)
  assert.equal(buffer.subarray(offset).toString('utf8').startsWith('--- svc started 2026-10-20'), true)

  await writeFile(file, twoRuns)
  const live = await __test.readTail(file, 64 * 1024)
  assert.equal(live.content.includes('OLD RUN LINE'), false, 'the default view is this run only')
  assert.ok(live.content.includes('NEW RUN LINE'))
  // paging back through `/tail?before=` must still reach the old run
  const older = await __test.readTailWindow(file, 64 * 1024, live.from)
  assert.ok(older.content.includes('OLD RUN LINE'), 'history stays reachable on demand')
})

test('readTail handles an empty file', async () => {
  const file = join(scratch, 'empty.log')
  await writeFile(file, '')
  const tail = await readTail(file, 1024)
  assert.equal(tail.size, 0)
  assert.equal(tail.elided, 0)
  assert.equal(tail.content, '')
})

test('readTail refuses a missing path and a directory', async () => {
  await assert.rejects(() => readTail(join(scratch, 'nope.log'), 1024), (error) => error.code === 'not-found')
  await assert.rejects(() => readTail(scratch, 1024), (error) => error.code === 'not-a-file')
})

test('resolvePath matches the sidebar read rule: relative joins cwd, absolute stays, no fence by default', async () => {
  const cwd = join(scratch, 'ws')
  await mkdir(join(cwd, 'logs'), { recursive: true })
  assert.equal(resolvePath(cwd, 'app.log'), join(cwd, 'app.log'))
  assert.equal(resolvePath(cwd, 'logs/app.log'), join(cwd, 'logs', 'app.log'))
  assert.equal(resolvePath(cwd, join(cwd, 'logs', 'app.log')), join(cwd, 'logs', 'app.log'))
  // The sidebar's own `ensureWorkspacePath` is plain `resolveTarget` with no
  // containment fence, so an absolute path outside the cwd is readable there —
  // and must be readable here too, or the viewer would silently downgrade to
  // head mode for a log the editor can already preview.
  assert.equal(resolvePath(cwd, '../secrets.log'), resolve(cwd, '../secrets.log'))
  assert.equal(resolvePath(cwd, '/etc/hosts'), '/etc/hosts')
  // `restrictToCwd: true` is the opt-in for deployments that want the fence.
  assert.throws(() => resolvePath(cwd, '../secrets.log', true), (error) => error.code === 'outside-workspace')
  assert.throws(() => resolvePath(cwd, '/etc/hosts', true), (error) => error.code === 'outside-workspace')
  assert.equal(resolvePath(cwd, 'logs/app.log', true), join(cwd, 'logs', 'app.log'))
  assert.equal(resolvePath(cwd, '.', true), cwd)
})

test('isLoopbackRequest admits loopback authorities only', () => {
  const req = (headers) => ({ headers })
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080' })), true)
  assert.equal(isLoopbackRequest(req({ host: 'localhost:3080' })), true)
  assert.equal(isLoopbackRequest(req({ host: '[::1]:3080' })), true)
  assert.equal(isLoopbackRequest(req({ host: '127.5.6.7' })), true)
  assert.equal(isLoopbackRequest(req({ host: '192.168.1.20:3080' })), false)
  assert.equal(isLoopbackRequest(req({ host: 'evil.example' })), false)
  assert.equal(isLoopbackRequest(req({})), false)
  // An Origin, when present, must name the same authority.
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' })), false)
  assert.equal(isLoopbackRequest(req({ host: '127.0.0.1:3080', origin: '127.0.0.1:3080' })), false)
})

test('clampBytes clamps both ends and falls back', () => {
  assert.equal(clampBytes('2048', DEFAULT_BYTES, HARD_MAX_BYTES), 2048)
  assert.equal(clampBytes(2048, DEFAULT_BYTES, HARD_MAX_BYTES), 2048)
  assert.equal(clampBytes('0', DEFAULT_BYTES, HARD_MAX_BYTES), MIN_BYTES)
  assert.equal(clampBytes('-5', DEFAULT_BYTES, HARD_MAX_BYTES), MIN_BYTES)
  assert.equal(clampBytes('nonsense', DEFAULT_BYTES, HARD_MAX_BYTES), DEFAULT_BYTES)
  assert.equal(clampBytes(undefined, DEFAULT_BYTES, HARD_MAX_BYTES), DEFAULT_BYTES)
  assert.equal(clampBytes('99999999', DEFAULT_BYTES, HARD_MAX_BYTES), HARD_MAX_BYTES)
  assert.equal(clampBytes('1.9', DEFAULT_BYTES, HARD_MAX_BYTES), MIN_BYTES)
})

/** Start all routes on a real listener with a fake session store. */
async function withServer(run, options = { maxBytes: HARD_MAX_BYTES, restrictToCwd: false, stopGraceMs: 5000, minFreeMemoryBytes: 1 }, rootCwd) {
  const cwd = rootCwd ?? join(scratch, `server-ws-${options.restrictToCwd === true ? 'strict' : 'open'}`)
  await mkdir(cwd, { recursive: true })
  const ctx = { sessions: { get: (id) => (id === 's1' ? { header: { cwd } } : undefined) } }
  const server = createServer((req, res) => { handleRequest(ctx, req, res, options) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  try {
    return await run({ base, cwd, port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Poll one predicate until it holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** Poll until a child process has exited. */
async function waitForExit(child, timeoutMs = 5000) {
  return waitFor(() => Promise.resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs)
}

test('the route end-to-ends a tail through real HTTP', async () => {
  await withServer(async ({ base, cwd }) => {
    const content = numberedLines(2000)
    await writeFile(join(cwd, 'service.log'), content)
    const response = await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=service.log&bytes=2048`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.ok(body.elided > 0)
    assert.equal(body.mode, 'tail')
    assert.ok(content.endsWith(body.content))
    assert.equal(body.size, Buffer.byteLength(content))
    // Relative and absolute spellings resolve to the same file.
    const absolute = await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=${encodeURIComponent(join(cwd, 'service.log'))}&bytes=2048`)
    assert.equal((await absolute.json()).content, body.content)
  })
})

test('the route refuses what it must, with machine codes', async () => {
  await withServer(async ({ base, port }) => {
    const get = (query) => fetch(`${base}${TAIL_PATH}?${query}`)
    assert.equal((await get('sessionId=s1')).status, 400)                              // path missing
    assert.equal((await get('path=x.log')).status, 400)                                // sessionId missing
    assert.equal((await get('sessionId=nope&path=x.log')).status, 400)                 // unknown session
    assert.equal((await get('sessionId=s1&path=missing.log')).status, 404)             // no such file
    assert.equal((await fetch(`${base}/dsh-ris-ide/other`)).status, 404)              // unknown route
    assert.equal((await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=x.log`, { method: 'POST' })).status, 405)
    // Default (parity with the sidebar's own read): no containment fence, so a
    // `..` path is merely "not found", never a policy refusal.
    assert.equal((await get('sessionId=s1&path=..%2Fescape.log')).status, 404)
    assert.equal((await (await get('sessionId=s1&path=..%2Fescape.log')).json()).code, 'not-found')
    // A foreign Host authority is refused before any file work.
    const foreign = await new Promise((resolve, reject) => {
      const call = httpRequest({
        host: '127.0.0.1',
        port,
        path: `${TAIL_PATH}?sessionId=s1&path=x.log`,
        headers: { host: 'evil.example' },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      call.on('error', reject)
      call.end()
    })
    assert.equal(foreign, 403)
  })
})

test('restrictToCwd: true turns the containment fence on', async () => {
  await withServer(async ({ base, cwd }) => {
    const content = numberedLines(50)
    await writeFile(join(cwd, 'ok.log'), content)
    const inside = await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=ok.log`)
    assert.equal(inside.status, 200)
    const outside = await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=..%2Fescape.log`)
    assert.equal(outside.status, 403)
    assert.equal((await outside.json()).code, 'outside-workspace')
    const absolute = await fetch(`${base}${TAIL_PATH}?sessionId=s1&path=${encodeURIComponent('/etc/hosts')}`)
    assert.equal(absolute.status, 403)
  }, { maxBytes: HARD_MAX_BYTES, restrictToCwd: true })
})

/** One JSON POST to the stop route. */
function post(base, body) {
  return fetch(`${base}${STOP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('readService reads the pidfile and reports liveness', async () => {
  const dir = join(scratch, 'pid-ws')
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'svc.log')
  await writeFile(log, 'x\n')
  assert.equal(await readService(log), undefined, 'no pidfile means no service')

  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await writeFile(`${log}${PID_SUFFIX}`, `${child.pid} ${process.pid} 1700000000000\n`)
    const service = await readService(log)
    assert.equal(service.pid, child.pid)
    assert.equal(service.wrapperPid, process.pid)
    assert.equal(service.alive, true)
    assert.equal(await isRunWithLogWrapper(process.pid), false, 'the host process is not the wrapper script')

    // Junk, short, and PID-1 files all read as "no service": a hand-made file
    // can never aim a signal somewhere.
    await writeFile(`${log}${PID_SUFFIX}`, 'not a pidfile\n')
    assert.equal(await readPidFile(log), undefined)
    await writeFile(`${log}${PID_SUFFIX}`, '1 1 1\n')
    assert.equal(await readPidFile(log), undefined)
  } finally {
    child.kill('SIGKILL')
  }
})

test('the stop route refuses a PID that is not the wrapper script', async () => {
  await withServer(async ({ base, cwd }) => {
    const log = join(cwd, 'fake.log')
    await writeFile(log, 'x\n')
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      await writeFile(`${log}${PID_SUFFIX}`, `${child.pid} ${child.pid} 1\n`)
      const response = await post(base, { sessionId: 's1', path: log })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).code, 'unverifiable')
      assert.equal(isAlive(child.pid), true, 'a refused PID must still be running')
    } finally {
      child.kill('SIGKILL')
    }
  })
})

test('the stop route answers no-service without a pidfile and refuses a foreign Host', async () => {
  await withServer(async ({ base, cwd, port }) => {
    const log = join(cwd, 'plain.log')
    await writeFile(log, 'x\n')
    const missing = await post(base, { sessionId: 's1', path: log })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, 'no-service')
    assert.equal((await post(base, { sessionId: 's1' })).status, 400)
    assert.equal((await fetch(`${base}${TAIL_PATH}`, { method: 'POST' })).status, 405, 'POST to the tail path is the wrong method')

    const foreign = await new Promise((resolve, reject) => {
      const call = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: STOP_PATH,
        headers: { host: 'evil.example', 'content-type': 'application/json', 'content-length': 2 },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      call.on('error', reject)
      call.end('{}')
    })
    assert.equal(foreign, 403)
  })
})

test('the stop route terminates a real run-with-log.sh service end to end', async () => {
  await withServer(async ({ base, cwd }) => {
    const logDir = join(cwd, 'logs')
    const log = join(logDir, 'stoptest.log')
    const wrapper = spawn(WRAPPER, ['stoptest', 'sleep', '60'], {
      env: { ...process.env, DSH_LOG_DIR: logDir },
      stdio: 'ignore',
    })
    try {
      assert.equal(await waitFor(() => existsSync(`${log}${PID_SUFFIX}`)), true, 'the wrapper writes its pidfile')
      const service = await readService(log)
      assert.equal(service.alive, true)
      assert.equal(await isRunWithLogWrapper(service.wrapperPid), true)

      const response = await post(base, { sessionId: 's1', path: log })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.stopped, true)
      assert.equal(body.alreadyStopped, false)
      assert.equal(isAlive(body.wrapperPid), false, 'the wrapper must be gone')
      assert.equal(existsSync(`${log}${PID_SUFFIX}`), false, 'the wrapper removes its pidfile')
      assert.equal(await waitForExit(wrapper), true, 'the spawned wrapper process exits')
      // The wrapper writes its exit banner just before it exits; under a loaded
      // parallel test run the read can win the race, so poll briefly.
      let banner = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        banner = await readFile(log, 'utf8')
        if (/stoptest exited/.test(banner)) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.match(banner, /stoptest exited/)
      // …and a second stop is a clean "already stopped".
      assert.equal((await post(base, { sessionId: 's1', path: log })).status, 404)
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    }
  })
})

test('listInstances finds a real run-with-log.sh service and reports it verified', async () => {
  const logDir = join(scratch, 'instances-live')
  const log = join(logDir, 'instlive.log')
  const wrapper = spawn(WRAPPER, ['instlive', 'sleep', '60'], {
    env: { ...process.env, DSH_LOG_DIR: logDir },
    stdio: 'ignore',
  })
  try {
    assert.equal(await waitFor(() => existsSync(`${log}${PID_SUFFIX}`)), true, 'the wrapper writes its pidfile')
    const entries = await listInstances(logDir)
    assert.equal(entries.length, 1, 'exactly the one started instance')
    const only = entries[0]
    assert.equal(only.name, 'instlive', 'the `.log` suffix is stripped from the label')
    assert.equal(only.logPath, log)
    assert.equal(only.verified, true, 'the wrapper PID really is our script')
    assert.equal(only.alive, true)
    assert.equal(typeof only.startedAt, 'number')
    assert.ok(only.size > 0, 'the wrapper already wrote its banner into the log')
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
  }
})

test('listInstances ignores junk pidfiles and orders live instances first', async () => {
  const logDir = join(scratch, 'instances-mixed')
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'noise.log'), 'not a service\n')
  await writeFile(join(logDir, 'noise.log.pid'), 'junk\n')
  await writeFile(join(logDir, 'orphan.log'), 'log without a pidfile\n')
  assert.deepEqual(await listInstances(logDir), [], 'junk and pidfile-less logs are not instances')
})

test('the instances route lists services and refuses a directory outside the session cwd', async () => {
  await withServer(async ({ base, cwd }) => {
    const logDir = join(cwd, 'logs')
    const log = join(logDir, 'routetest.log')
    const wrapper = spawn(WRAPPER, ['routetest', 'sleep', '60'], {
      env: { ...process.env, DSH_LOG_DIR: logDir },
      stdio: 'ignore',
    })
    try {
      assert.equal(await waitFor(() => existsSync(`${log}${PID_SUFFIX}`)), true, 'the wrapper writes its pidfile')
      const ok = await fetch(`${base}${INSTANCES_PATH}?sessionId=s1`)
      assert.equal(ok.status, 200)
      const body = await ok.json()
      assert.equal(body.ok, true)
      assert.equal(body.dir, logDir, 'the default directory is <cwd>/logs')
      assert.equal(body.entries.length, 1)
      assert.equal(body.entries[0].name, 'routetest')
      assert.equal(body.entries[0].alive, true)

      // The fence: a directory outside the session cwd is refused, so this route
      // can never be turned into a general-purpose directory lister.
      const outside = await fetch(`${base}${INSTANCES_PATH}?sessionId=s1&dir=/tmp`)
      assert.equal(outside.status, 403)
      // Wrong method / unknown route still answer their own machine codes.
      assert.equal((await fetch(`${base}${INSTANCES_PATH}?sessionId=s1`, { method: 'POST' })).status, 405)
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
    }
  })
})

// ── Program discovery + start ───────────────────────────────────────────────

/** A tiny workspace: one Spring module, one frontend, one node_modules decoy. */
async function makeProgramFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-fixture-'))
  const moduleDir = join(root, 'proj-a', 'proj-a-biz')
  await mkdir(join(moduleDir, 'src', 'main', 'java', 'cn', 'x'), { recursive: true })
  await writeFile(join(moduleDir, 'pom.xml'), '<project/>')
  await writeFile(
    join(moduleDir, 'src', 'main', 'java', 'cn', 'x', 'DemoApplication.java'),
    'package cn.x;\n@SpringBootApplication\npublic class DemoApplication { public static void main(String[] args) {} }\n',
  )
  const uiDir = join(root, 'proj-a', 'ui')
  await mkdir(uiDir, { recursive: true })
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'demo-ui', scripts: { dev: 'vite' } }))
  await writeFile(join(uiDir, 'pnpm-lock.yaml'), '')
  const decoy = join(root, 'node_modules', 'decoy')
  await mkdir(decoy, { recursive: true })
  await writeFile(join(decoy, 'package.json'), JSON.stringify({ name: 'decoy', scripts: { dev: 'nope' } }))
  await mkdir(join(root, '.vscode'), { recursive: true })
  await writeFile(join(root, '.vscode', 'launch.json'), `{
    // JSONC: comments and trailing commas must be tolerated
    "configurations": [
      {
        "name": "demo",
        "mainClass": "cn.x.DemoApplication",
        "cwd": "\${workspaceFolder}/proj-a/proj-a-biz",
        "args": ["--spring.profiles.active=dev", "--spring.config.additional-location=file:\${workspaceFolder}/local.yml",],
      },
    ],
  }`)
  return { root, moduleDir, uiDir }
}

/** A workspace whose only program is a frontend app that stays alive. */
async function makeStartableFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-start-'))
  const dir = join(root, 'ui')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'tick-app',
    scripts: { dev: 'node -e "process.on(\'SIGTERM\',()=>process.exit(0));setInterval(()=>{},1000)"' },
  }))
  return { root }
}

test('scanPrograms finds Spring Boot entries and frontend manifests, and skips node_modules', async () => {
  const { root, moduleDir, uiDir } = await makeProgramFixture()
  const logsDir = join(root, 'logs')
  const programs = await scanPrograms(root, logsDir, true)
  const spring = programs.filter((p) => p.kind === 'spring')
  const frontend = programs.filter((p) => p.kind === 'frontend')
  assert.equal(spring.length, 1, 'one Spring Boot entry point')
  assert.equal(frontend.length, 1, 'one frontend manifest')
  assert.equal(programs.some((p) => p.name === 'decoy'), false, 'node_modules is not scanned')
  assert.equal(spring[0].mainClass, 'cn.x.DemoApplication')
  assert.equal(spring[0].dir, moduleDir)
  assert.equal(spring[0].project, 'proj-a')
  assert.equal(spring[0].logName, 'proj-a-proj-a-biz')
  assert.equal(spring[0].logPath, join(logsDir, 'proj-a-proj-a-biz.log'))
  assert.equal(spring[0].hasLog, false)
  assert.equal(spring[0].running, undefined, 'nothing owns its log yet')
  assert.equal(spring[0].launch.mainClass, 'cn.x.DemoApplication', 'launch.json supplies the run configuration')
  assert.deepEqual(spring[0].launch.args, [
    '--spring.profiles.active=dev',
    `--spring.config.additional-location=file:${join(root, 'local.yml')}`,
  ])
  assert.equal(frontend[0].dir, uiDir)
  assert.equal(frontend[0].name, 'demo-ui')
  assert.equal(frontend[0].script, 'dev')
  assert.equal(frontend[0].packageManager, 'pnpm', 'inferred from pnpm-lock.yaml')
})

test('parseJsonc tolerates comments and trailing commas', () => {
  assert.deepEqual(parseJsonc('{\n  // line\n  "a": 1, /* block */\n  "b": [1, 2,],\n}'), { a: 1, b: [1, 2] })
  assert.equal(parseJsonc('[1,,]'), null)
})

test('readLaunchConfigs/launchFor pick the configuration whose cwd is the module', async () => {
  const { root, moduleDir } = await makeProgramFixture()
  const configs = await readLaunchConfigs(root)
  assert.equal(configs.length, 1)
  assert.equal(configs[0].mainClass, 'cn.x.DemoApplication')
  assert.equal(configs[0].cwd, moduleDir)
  assert.equal(launchFor(configs, moduleDir, root).name, 'demo')
  assert.equal(launchFor(configs, join(root, 'elsewhere'), root), undefined)
})

test('buildStartSpec composes the documented Spring Boot command and execs the JVM', () => {
  const workspace = '/ws'
  const logsDir = '/ws/logs'
  const program = { kind: 'spring', dir: '/ws/proj/a-biz', mainClass: 'cn.x.App', launch: null }
  const spec = buildStartSpec(program, { workspace, logsDir })
  assert.equal(spec.cwd, '/ws/proj/a-biz')
  assert.ok(spec.wrapperPath.endsWith('bin/run-with-log.sh'))
  assert.match(spec.command, /mvn -Pdev compile/)
  assert.match(spec.command, /-Dmdep\.includeScope=runtime/)
  assert.match(spec.command, /exec java -DJM\.LOG\.PATH=\/ws\/logs/)
  assert.match(spec.command, /-Dcsp\.sentinel\.log\.dir=\/ws\/logs\/csp/)
  assert.match(spec.command, /-cp "target\/classes:\$\(cat target\/cp\.txt\)" cn\.x\.App --spring\.profiles\.active=dev/)

  const launched = buildStartSpec(
    Object.assign({}, program, { launch: { mainClass: 'cn.x.Other', args: ['--debug'] } }),
    { workspace, logsDir },
  )
  assert.match(launched.command, /cn\.x\.Other --spring\.profiles\.active=dev --debug$/)

  const frontend = buildStartSpec(
    { kind: 'frontend', dir: '/ws/ui', packageManager: 'pnpm', script: 'dev' },
    { workspace, logsDir },
  )
  assert.equal(frontend.command, 'cd /ws/ui && exec pnpm run dev')
})

test('quoteShell / sanitizeLogName / defaultSpringArgs behave', async () => {
  assert.equal(quoteShell('plain/path:x'), 'plain/path:x')
  assert.equal(quoteShell('a b'), "'a b'")
  assert.equal(quoteShell("it's"), "'it'\\''s'")
  assert.equal(sanitizeLogName('@ris/ui 3'), 'ris-ui-3')
  assert.equal(sanitizeLogName('///'), 'program')
  // 用一个临时 workspace（而不是某个写死的本机路径）：CI/别人的机器上没有那个目录。
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-args-'))
  try {
    await writeFile(join(workspace, 'local.yml'), 'gray.VERSION: ci\n')
    const args = defaultSpringArgs(workspace)
    assert.equal(args[0], '--spring.profiles.active=dev')
    assert.match(args[1] ?? '', /^--spring\.config\.additional-location=file:/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the programs route scans over HTTP and the start route refuses bad input', async () => {
  const { root } = await makeProgramFixture()
  await withServer(async ({ base }) => {
    const listing = await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)
    assert.equal(listing.status, 200)
    const body = await listing.json()
    assert.equal(body.ok, true)
    assert.equal(body.programs.length, 2)
    assert.equal(body.root, root)
    assert.equal((await fetch(`${base}${PROGRAMS_PATH}`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}${START_PATH}`)).status, 405)

    const unknown = await fetch(`${base}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: 'spring:nope#X' }),
    })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).code, 'unknown-program')

    const missing = await fetch(`${base}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    assert.equal(missing.status, 400)
  }, undefined, root)
})

test('the start route launches a program through run-with-log.sh and stop terminates it', async () => {
  const { root } = await makeStartableFixture()
  await withServer(async ({ base }) => {
    const listing = await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)
    const programs = (await listing.json()).programs
    const program = programs.find((entry) => entry.kind === 'frontend')
    assert.ok(program !== undefined, 'the fixture frontend program is discovered')

    const started = await fetch(`${base}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: program.id }),
    })
    const startedBody = await started.json()
    assert.equal(started.status, 200, JSON.stringify(startedBody))
    assert.equal(startedBody.ok, true)
    assert.equal(startedBody.alreadyRunning, false)
    assert.equal(startedBody.program.running.alive, true)
    const logPath = startedBody.program.logPath
    assert.equal(existsSync(logPath), true, 'the wrapper created the log file')
    assert.equal(existsSync(`${logPath}${PID_SUFFIX}`), true, 'the wrapper wrote its pidfile')

    const again = await (await fetch(`${base}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: program.id }),
    })).json()
    assert.equal(again.alreadyRunning, true, 'a second start is a no-op')

    const stopped = await fetch(`${base}${STOP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', path: logPath }),
    })
    const stoppedBody = await stopped.json()
    assert.equal(stopped.status, 200, JSON.stringify(stoppedBody))
    assert.equal(stoppedBody.stopped, true)
    assert.equal(existsSync(`${logPath}${PID_SUFFIX}`), false, 'the pidfile is gone after the stop')
  }, undefined, root)
})


// ── User config: generate / drift / update ─────────────────────────────────

/** Path of the workspace program config: inside the state folder, never a dotfile. */
function configPathOf(root) {
  return join(root, '.dsh-ris-ide', 'config.json')
}

/** Create the workspace state folder a config/settings fixture is written into. */
async function ensureStateDir(root) {
  await mkdir(join(root, '.dsh-ris-ide'), { recursive: true })
}

/** Write one `.dsh-ris-ide/config.json` fixture. */
async function writeConfig(root, doc) {
  await ensureStateDir(root)
  await writeFile(configPathOf(root), JSON.stringify(doc, null, 2))
}

test('readProgramConfig tolerates JSONC and ignores invalid rows', async () => {
  const { root } = await makeProgramFixture()
  const empty = await readProgramConfig(root)
  assert.equal(empty.exists, false)
  assert.deepEqual(empty.entries, [])

  await ensureStateDir(root)
  await writeFile(configPathOf(root), `{
    // a comment
    "programs": [
      { "name": "ok", "dir": "proj-a/ui", "startCommand": "true", },
      { "dir": "no-name" },
      "junk",
    ],
  }`)
  const cfg = await readProgramConfig(root)
  assert.equal(cfg.exists, true)
  assert.equal(cfg.entries.length, 1)
  assert.equal(cfg.entries[0].name, 'ok')

  await writeFile(configPathOf(root), '{ nope')
  const broken = await readProgramConfig(root)
  assert.equal(broken.exists, true)
  assert.match(broken.error, /JSON/)
  assert.deepEqual(broken.entries, [])
})

test('the plugin keeps ONE hidden folder: legacy dot-folders and dotfiles fold in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-state-'))
  await mkdir(join(root, '.dsh-ris-ide-trash'), { recursive: true })
  await writeFile(join(root, '.dsh-ris-ide-trash', 'parked.txt'), 'parked')
  await mkdir(join(root, '.dsh-ris-ide-cache', 'sources'), { recursive: true })
  await writeFile(join(root, '.dsh-ris-ide-cache', 'sources', 'A.java'), 'class A {}')
  await writeFile(join(root, '.dsh-ris-ide.json'), JSON.stringify({ version: 1, programs: [] }))
  await writeFile(join(root, '.dsh-ris-ide.settings.json'), JSON.stringify({ decompiler: { jar: '/opt/cfr/cfr.jar' } }))

  const tree = await __test.listIdeTree(root, root)
  assert.equal(tree.entries.some((entry) => entry.name === '.dsh-ris-ide'), false, 'the state folder is never a tree row')
  assert.equal(tree.entries.some((entry) => entry.name === '.dsh-ris-ide.json'), false, 'nor the legacy config dotfile')

  assert.equal(await readFile(join(root, '.dsh-ris-ide', 'trash', 'parked.txt'), 'utf8'), 'parked', 'a parked delete survives the move')
  assert.equal(await readFile(join(root, '.dsh-ris-ide', 'cache', 'sources', 'A.java'), 'utf8'), 'class A {}')
  assert.equal(existsSync(join(root, '.dsh-ris-ide', 'config.json')), true, 'the legacy config moved into the folder')
  assert.equal(existsSync(join(root, '.dsh-ris-ide', 'settings.json')), true, 'and so did the settings file')
  assert.equal(existsSync(join(root, '.dsh-ris-ide-trash')), false, 'the legacy folder is gone')
  assert.equal(existsSync(join(root, '.dsh-ris-ide.json')), false, 'the legacy config dotfile is gone')
  assert.equal(existsSync(join(root, '.dsh-ris-ide.settings.json')), false, 'the legacy settings dotfile is gone')

  // A newer file at the new location wins: a legacy one is left alone, never overwritten.
  await writeFile(configPathOf(root), JSON.stringify({ version: 1, programs: [] }))
  const legacyAgain = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-legacy-'))
  await mkdir(join(root, '.dsh-ris-ide'), { recursive: true })
  assert.equal(existsSync(configPathOf(root)), true)
  await rm(legacyAgain, { recursive: true, force: true })
})

test('a legacy entry that collides with a newer one is parked, never dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-state-collide-'))
  await mkdir(join(root, '.dsh-ris-ide', 'trash'), { recursive: true })
  await writeFile(join(root, '.dsh-ris-ide', 'trash', 'parked.txt'), 'newer')
  await mkdir(join(root, '.dsh-ris-ide-trash'), { recursive: true })
  await writeFile(join(root, '.dsh-ris-ide-trash', 'parked.txt'), 'legacy')

  await __test.listIdeTree(root, root)

  const trash = join(root, '.dsh-ris-ide', 'trash')
  assert.equal(await readFile(join(trash, 'parked.txt'), 'utf8'), 'newer', 'the newer file keeps the plain name')
  const { readdir } = await import('node:fs/promises')
  const parked = (await readdir(trash)).filter((name) => name.startsWith('parked.txt-legacy-'))
  assert.equal(parked.length, 1, 'the older file is kept under a suffixed name')
  assert.equal(await readFile(join(trash, parked[0]), 'utf8'), 'legacy', 'and its bytes survive')
  assert.equal(existsSync(join(root, '.dsh-ris-ide-trash')), false, 'the legacy folder goes away once it is empty')
  await rm(root, { recursive: true, force: true })
})

test('mergeProgramConfig applies user fields, adds manual programs and honors disabled', async () => {
  const { root } = await makeProgramFixture()
  const logsDir = join(root, 'logs')
  const scanned = await scanPrograms(root, logsDir, true)
  const frontend = scanned.find((p) => p.kind === 'frontend')
  await writeConfig(root, {
    version: 1,
    programs: [
      { id: frontend.id, name: 'renamed', logName: 'custom-log', env: { FOO: 'bar' }, args: ['--x'], stopGraceMs: 3000 },
      { name: 'custom-service', dir: 'proj-a/ui', startCommand: 'exec sleep 3600', logName: 'custom-service' },
      { name: 'gone', dir: 'nowhere', startCommand: 'true', disabled: true },
    ],
  })
  const merged = await scanPrograms(root, logsDir, true)
  const renamed = merged.find((p) => p.id === frontend.id)
  assert.equal(renamed.name, 'renamed')
  assert.equal(renamed.logName, 'custom-log')
  assert.deepEqual(renamed.env, { FOO: 'bar' })
  assert.deepEqual(renamed.args, ['--x'])
  assert.equal(renamed.stopGraceMs, 3000)
  assert.equal(renamed.overridden, true)
  const manual = merged.find((p) => p.name === 'custom-service')
  assert.equal(manual.kind, 'manual')
  assert.equal(manual.startCommand, 'exec sleep 3600')
  assert.equal(manual.fromConfig, true)
  assert.equal(merged.some((p) => p.name === 'gone'), false, 'disabled entries are hidden')
  assert.equal(merged.some((p) => p.kind === 'spring' && p.overridden !== true), true, 'the other program is untouched')
})

test('detectConfigDrift reports added/missing/changed and never blames manual entries', async () => {
  const { root } = await makeProgramFixture()
  const logsDir = join(root, 'logs')
  const plain = await scanPrograms(root, logsDir, true)
  const doc = buildConfigDocument(plain)
  doc.programs.push({ name: 'manual-x', dir: 'proj-a/ui', startCommand: 'exec sleep 1', logName: 'manual-x' })
  doc.programs.push({ id: 'frontend:gone#dev', name: 'gone-app', kind: 'frontend', dir: 'gone', script: 'dev' })
  await writeConfig(root, doc)

  const ui2 = join(root, 'proj-a', 'ui2')
  await mkdir(ui2, { recursive: true })
  await writeFile(join(ui2, 'package.json'), JSON.stringify({ name: 'ui-2', scripts: { dev: 'vite' } }))
  await scanPrograms(root, logsDir, true) // forceRefresh also refreshes the discovery cache
  const discovered = await discoverPrograms(root)
  const drift = detectConfigDrift(discovered, doc.programs, root)
  assert.equal(drift.stale, true)
  assert.deepEqual(drift.added, ['ui-2'])
  assert.deepEqual(drift.missing, ['gone-app'])
  assert.deepEqual(drift.manual, ['manual-x'])
  assert.deepEqual(drift.changed, [])
})

test('mergeConfigDocuments keeps user edits and additions while adding new programs', async () => {
  const { root } = await makeProgramFixture()
  const logsDir = join(root, 'logs')
  const plain = await scanPrograms(root, logsDir, true)
  const doc = buildConfigDocument(plain)
  const frontend = doc.programs.find((entry) => entry.kind === 'frontend')
  frontend.name = 'renamed-ui'
  frontend.env = { FOO: 'bar' }
  frontend.stopGraceMs = 2500
  doc.programs.push({ name: 'manual-y', dir: 'proj-a/ui', startCommand: 'exec sleep 1', logName: 'manual-y' })
  doc.programs.push({ id: 'frontend:gone#dev', name: 'gone-app', kind: 'frontend', dir: 'gone', script: 'dev' })
  const next = buildConfigDocument(await scanPrograms(root, logsDir, true))
  const updated = mergeConfigDocuments(next, doc.programs, root)
  const kept = updated.programs.find((entry) => entry.kind === 'frontend')
  assert.equal(kept.name, 'renamed-ui')
  assert.deepEqual(kept.env, { FOO: 'bar' })
  assert.equal(kept.stopGraceMs, 2500)
  assert.equal(updated.programs.some((entry) => entry.name === 'manual-y'), true, 'manual additions survive')
  assert.equal(updated.programs.some((entry) => entry.name === 'gone-app'), false, 'stale auto entries are dropped')
})

test('the config route generates, refuses to clobber and updates in place', async () => {
  const { root } = await makeProgramFixture()
  await withServer(async ({ base }) => {
    const post = (body) => fetch(`${base}${CONFIG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ sessionId: 's1' }, body)),
    })
    const first = await post({})
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.count, 2)
    const configPath = configPathOf(root)
    assert.equal(existsSync(configPath), true)
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /dsh-ris-ide 程序配置/, 'the generated file carries a header comment')

    assert.equal((await post({})).status, 409, 'an existing file is not clobbered by a bare generate')

    const doc = parseJsonc(text)
    const frontend = doc.programs.find((entry) => entry.kind === 'frontend')
    frontend.name = 'renamed-ui'
    frontend.env = { FOO: 'bar' }
    doc.programs.push({ name: 'manual-y', dir: 'proj-a/ui', startCommand: 'exec sleep 1', logName: 'manual-y' })
    await writeFile(configPath, JSON.stringify(doc, null, 2))

    const update = await post({ mode: 'update' })
    assert.equal(update.status, 200)
    assert.equal((await update.json()).mode, 'update')
    const updated = parseJsonc(await readFile(configPath, 'utf8'))
    const kept = updated.programs.find((entry) => entry.kind === 'frontend')
    assert.equal(kept.name, 'renamed-ui', 'user edit survives an update')
    assert.deepEqual(kept.env, { FOO: 'bar' })
    assert.equal(updated.programs.some((entry) => entry.name === 'manual-y'), true, 'manual addition survives')

    assert.equal((await post({ mode: 'overwrite' })).status, 200)
    const reset = parseJsonc(await readFile(configPath, 'utf8'))
    assert.equal(reset.programs.some((entry) => entry.name === 'manual-y'), false, 'overwrite drops user additions')
  }, undefined, root)
})

test('the programs route reports config drift, and start honors startCommand/logName/grace', async () => {
  const { root } = await makeStartableFixture()
  await ensureStateDir(root)
  await writeFile(configPathOf(root), JSON.stringify({
    version: 1,
    programs: [{
      name: 'tick-app',
      dir: 'ui',
      startCommand: 'exec node -e "process.on(\'SIGTERM\',()=>process.exit(0));setInterval(()=>{},1000)"',
      logName: 'custom-tick',
      stopGraceMs: 2000,
    }],
  }, null, 2))
  await withServer(async ({ base }) => {
    // a new program appears in the workspace → the config is reported stale
    const extra = join(root, 'ui2')
    await mkdir(extra, { recursive: true })
    await writeFile(join(extra, 'package.json'), JSON.stringify({ name: 'ui-2', scripts: { dev: 'vite' } }))
    const listing = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)).json()
    assert.equal(listing.config.exists, true)
    assert.equal(listing.config.status, 'updated', 'a forced rescan reconciles the config')
    assert.equal(listing.config.drift.reconciled, true)
    assert.equal(listing.programs.some((entry) => entry.name === 'ui-2'), true, 'the new program is listed')
    assert.equal((await readFile(configPathOf(root), 'utf8')).includes('ui-2'), true, 'and written into the config')

    const program = listing.programs.find((entry) => entry.name === 'tick-app')
    assert.equal(program.logName, 'custom-tick', 'the config logName wins')
    const started = await (await fetch(`${base}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: program.id }),
    })).json()
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.program.logPath, join(root, 'logs', 'custom-tick.log'))
    const record = await readPidFile(started.program.logPath)
    assert.equal(record.graceMs, 2000, 'the per-program stop grace is recorded in the pidfile')

    const stopped = await (await fetch(`${base}${STOP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', path: started.program.logPath }),
    })).json()
    assert.equal(stopped.stopped, true)
  }, undefined, root)
})


// ── Model-facing tools (ris_dev_*) ──────────────────────────────────────────

/** A host ctx with one session rooted at `root` and a capturing tool registry. */
function toolCtx(root) {
  const tools = []
  const ctx = {
    sessions: { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
  }
  return { ctx, tools }
}

test('registerAgentTools exposes ris_dev_programs/start/stop/logs and degrades cleanly', () => {
  const { ctx, tools } = toolCtx('/tmp/x')
  const dispose = registerAgentTools(ctx, {})
  assert.deepEqual(tools.map((tool) => tool.name), [
    'ris_dev_programs', 'ris_dev_start', 'ris_dev_stop', 'ris_dev_logs', 'ris_dev_status', 'ris_dev_restart', 'ris_dev_debug',
    'ris_dev_skill',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(Array.isArray(tool.output.render({}, { ok: true })))
  }
  dispose()
  assert.doesNotThrow(() => registerAgentTools(Object.assign({}, ctx, { tools: undefined }), {}), 'no ctx.tools must not throw')
  const off = toolCtx('/tmp/x')
  registerAgentTools(off.ctx, { agentTools: false })
  assert.equal(off.tools.length, 0, 'agentTools: false registers nothing')
})

test('resolveProgramRef matches by id, exact name and a unique fragment', () => {
  const programs = [
    { id: 'spring:a#A', name: 'a-biz' },
    { id: 'spring:b#B', name: 'b-biz' },
  ]
  assert.equal(resolveProgramRef(programs, { id: 'spring:a#A' }).name, 'a-biz')
  assert.equal(resolveProgramRef(programs, { name: 'b-biz' }).name, 'b-biz')
  assert.equal(resolveProgramRef(programs, { name: 'a-' }).name, 'a-biz')
  assert.equal(resolveProgramRef(programs, { name: 'nope' }), undefined)
  assert.equal(resolveProgramRef(programs, {}), undefined)
  assert.throws(() => resolveProgramRef(programs, { name: '-biz' }), /matches/)
})

test('the tools list, start, read and stop a program through the shared core', async () => {
  const { root } = await makeStartableFixture()
  const { ctx, tools } = toolCtx(root)
  const dispose = registerAgentTools(ctx, {})
  try {
    const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
    const tool = (name) => tools.find((definition) => definition.name === name)

    const listed = await tool('ris_dev_programs').execute({}, exec)
    assert.equal(listed.ok, true)
    assert.equal(listed.programs.length, 1)
    assert.equal(listed.programs[0].running, false)

    const started = await tool('ris_dev_start').execute({ id: listed.programs[0].id }, exec)
    assert.equal(started.ok, true)
    assert.equal(started.alreadyRunning, false)
    assert.equal(started.program.running, true)

    const again = await tool('ris_dev_start').execute({ name: 'tick-app' }, exec)
    assert.equal(again.alreadyRunning, true)

    const logs = await tool('ris_dev_logs').execute({ name: 'tick-app', lines: 5 }, exec)
    assert.equal(logs.ok, true)
    assert.equal(logs.running, true)
    assert.equal(logs.opened, true)
    assert.equal(typeof logs.content, 'string')
    const opens = takePendingOpens()
    assert.equal(opens.length, 1)
    assert.equal(opens[0].sessionId, 's1')
    assert.equal(opens[0].logPath, logs.path)

    const stopped = await tool('ris_dev_stop').execute({ name: 'tick-app' }, exec)
    assert.equal(stopped.ok, true)
    assert.equal(stopped.stopped, true)
    await assert.rejects(() => tool('ris_dev_stop').execute({ name: 'tick-app' }, exec), /no \.pid record/)
  } finally {
    dispose()
  }
})

test('the opens route drains the queue exactly once', async () => {
  enqueueOpen({ sessionId: 's1', logPath: '/w/logs/a.log', title: 'a' })
  enqueueOpen({ sessionId: 's2', logPath: '/w/logs/b.log', title: 'b' })
  const { ctx } = toolCtx('/w')
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res, { maxBytes: HARD_MAX_BYTES, restrictToCwd: false, stopGraceMs: 5000 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const first = await (await fetch(`${base}${OPENS_PATH}`)).json()
    assert.equal(first.ok, true)
    assert.equal(first.opens.length, 2)
    const second = await (await fetch(`${base}${OPENS_PATH}`)).json()
    assert.equal(second.opens.length, 0, 'the queue is consume-on-read')
    assert.equal((await fetch(`${base}${OPENS_PATH}`, { method: 'POST' })).status, 405)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})


// ── Regressions: stop must free the port; tool output must be lossless JSON ─

test('stopping a wrapped command kills its whole process group (pnpm-style grandchildren)', async () => {
  // The reported bug: `pnpm run dev` does not forward SIGTERM, so stopping only
  // the runner left vite holding its port. The wrapper is spawned detached
  // (own group) exactly like the host does it.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-tree-'))
  const log = join(dir, 'tree.log')
  const grandchildFile = join(dir, 'grandchild.pid')
  const wrapper = spawn(
    WRAPPER,
    ['tree', 'bash', '-c', 'sleep 300 & echo $! > "$0"; wait', grandchildFile],
    { env: { ...process.env, DSH_LOG_DIR: dir }, stdio: 'ignore', detached: true },
  )
  wrapper.unref()
  try {
    assert.equal(await waitFor(() => existsSync(`${log}${PID_SUFFIX}`)), true, 'the wrapper wrote its pidfile')
    assert.equal(await waitFor(() => existsSync(grandchildFile)), true, 'the grandchild started')
    const grandchild = Number((await readFile(grandchildFile, 'utf8')).trim())
    assert.equal(isAlive(grandchild), true, 'the grandchild (the port holder) is alive')
    assert.equal(typeof (await processGroupLeader(wrapper.pid)), 'number', 'the detached wrapper leads a group')

    const outcome = await stopLogPath(log, 5000)
    assert.equal(outcome.stopped, true)
    await waitFor(() => isAlive(grandchild) === false, 4000)
    assert.equal(isAlive(grandchild), false, 'the grandchild is gone, so its port is free')
    assert.equal(existsSync(`${log}${PID_SUFFIX}`), false, 'the pidfile is cleaned up')
  } finally {
    try { process.kill(-wrapper.pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

test('a start whose command dies immediately fails loudly, with the log tail', async () => {
  const { root } = await makeStartableFixture()
  await ensureStateDir(root)
  await writeFile(configPathOf(root), JSON.stringify({
    version: 1,
    programs: [{
      name: 'tick-app',
      dir: 'ui',
      startCommand: 'exec sh -c "echo boom: port 8080 already bound; exit 3"',
      logName: 'dies-fast',
    }],
  }, null, 2))
  const { ctx } = toolCtx(root)
  const disposers = []
  ctx.tools = { register: (definition) => { disposers.push(definition); return () => {} } }
  registerAgentTools(ctx, {})
  const start = disposers.find((definition) => definition.name === 'ris_dev_start')
  const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
  await assert.rejects(
    () => start.execute({ name: 'tick-app' }, exec),
    (error) => {
      assert.match(error.message, /start-failed|退出了/)
      assert.match(error.message, /boom: port 8080 already bound/, 'the log tail explains why')
      return true
    },
  )
})

test('every ris_dev_* result is lossless JSON (no undefined values)', async () => {
  const assertJsonSafe = (value, path = '$') => {
    if (value === undefined) assert.fail(`undefined at ${path}`)
    if (Array.isArray(value)) value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`))
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) assertJsonSafe(item, `${path}.${key}`)
    }
  }
  const { root } = await makeStartableFixture()
  const { ctx, tools } = toolCtx(root)
  const dispose = registerAgentTools(ctx, {})
  try {
    const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
    const byName = (name) => tools.find((definition) => definition.name === name)
    const listed = await byName('ris_dev_programs').execute({}, exec)
    assertJsonSafe(listed)
    assert.equal(listed.programs[0].pid, null, 'a stopped program reports null, not undefined')
    const started = await byName('ris_dev_start').execute({ id: listed.programs[0].id }, exec)
    assertJsonSafe(started)
    const logs = await byName('ris_dev_logs').execute({ name: 'tick-app' }, exec)
    assertJsonSafe(logs)
    const stopped = await byName('ris_dev_stop').execute({ name: 'tick-app' }, exec)
    assertJsonSafe(stopped)
    takePendingOpens()
    // jsonSafe is the mechanism; pin its contract directly too
    assert.deepEqual(jsonSafe({ a: undefined, b: [1, undefined], c: { d: undefined } }), { a: null, b: [1, null], c: { d: null } })
  } finally {
    dispose()
  }
})


test('ris_dev_status answers "is it up?" and ris_dev_restart restarts in place', async () => {
  const { root } = await makeStartableFixture()
  const { ctx, tools } = toolCtx(root)
  const dispose = registerAgentTools(ctx, {})
  try {
    const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
    const tool = (name) => tools.find((definition) => definition.name === name)

    const before = await tool('ris_dev_status').execute({ name: 'tick-app' }, exec)
    assert.equal(before.ok, true)
    assert.equal(before.found, true)
    assert.equal(before.running, false, 'nothing is running yet')
    assert.equal(before.pid, null)
    assert.equal(before.restartable, true)

    const overall = await tool('ris_dev_status').execute({}, exec)
    assert.equal(overall.total, 1)
    assert.equal(overall.running.length, 0)
    assert.deepEqual(overall.stopped.map((row) => row.name), ['tick-app'])

    const started = await tool('ris_dev_start').execute({ name: 'tick-app' }, exec)
    assert.equal(started.ok, true)
    const firstPid = started.program.pid
    assert.equal(typeof firstPid, 'number')

    const up = await tool('ris_dev_status').execute({ name: 'tick-app' }, exec)
    assert.equal(up.running, true)
    assert.equal(up.pid, firstPid)
    assert.ok(Number.isFinite(up.uptimeMs), 'uptime is reported')
    assert.equal(up.url, null, 'this fixture logs no URL')

    const restarted = await tool('ris_dev_restart').execute({ name: 'tick-app' }, exec)
    assert.equal(restarted.ok, true)
    assert.equal(restarted.restarted, true, 'it was running, so restart really stopped it')
    assert.equal(restarted.stopped.stopped, true)
    assert.equal(restarted.alreadyRunning, false)
    assert.equal(restarted.program.running, true)
    assert.notEqual(restarted.program.pid, firstPid, 'the new instance has a new pid')

    const afterRestart = await tool('ris_dev_status').execute({ name: 'tick-app' }, exec)
    assert.equal(afterRestart.running, true)
    assert.equal(afterRestart.pid, restarted.program.pid)

    // stopping it first must not make restart fail: it degrades to "just start"
    await tool('ris_dev_stop').execute({ name: 'tick-app' }, exec)
    const coldRestart = await tool('ris_dev_restart').execute({ name: 'tick-app' }, exec)
    assert.equal(coldRestart.restarted, false, 'nothing was running')
    assert.equal(coldRestart.program.running, true)

    // the grouped status view lists it under running now
    const summary = await tool('ris_dev_status').execute({}, exec)
    assert.deepEqual(summary.running.map((row) => row.name), ['tick-app'])
    assert.equal(summary.stopped.length, 0)

    await tool('ris_dev_stop').execute({ name: 'tick-app' }, exec)
  } finally {
    dispose()
  }
})


// ── Project entry pom drives the Spring profile; project root owns local.yml ─

test('the Spring profile comes from the project entry pom (runtime args follow it)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-pom-'))
  await mkdir(join(root, 'ris', 'm1'), { recursive: true })
  await writeFile(join(root, 'ris', 'pom.xml'), `<project>
    <profiles>
      <profile>
        <id>dev</id>
        <properties><profiles.active>dev</profiles.active></properties>
        <activation><activeByDefault>true</activeByDefault></activation>
      </profile>
      <profile><id>prod</id></profile>
    </profiles>
  </project>`)
  // a child module that only declares <parent>
  await writeFile(join(root, 'ris', 'm1', 'pom.xml'), `<project>
    <parent>
      <groupId>cn.com.ris.cloud</groupId>
      <artifactId>ris</artifactId>
      <version>3.1.0-SNAPSHOT</version>
      <relativePath>../pom.xml</relativePath>
    </parent>
  </project>`)
  assert.equal(readProjectProfile(root, join(root, 'ris', 'm1')), 'dev')
  assert.deepEqual(parseJsonc(JSON.stringify([])), [])

  // a project whose default profile is not dev
  await mkdir(join(root, 'ris2', 'm2'), { recursive: true })
  await writeFile(join(root, 'ris2', 'pom.xml'), `<project>
    <profiles><profile><id>test</id><activation><activeByDefault>true</activeByDefault></activation></profile></profiles>
  </project>`)
  assert.equal(readProjectProfile(root, join(root, 'ris2', 'm2')), 'test')
  // a project with no pom at all falls back to dev (the RISCloud convention)
  await mkdir(join(root, 'lonely'), { recursive: true })
  assert.equal(readProjectProfile(root, join(root, 'lonely')), 'dev')

  // argument normalization follows the pom and the project-root local.yml
  await writeFile(join(root, 'ris2', 'local.yml'), 'x: 1\n')
  assert.equal(localYmlFor(root, join(root, 'ris2', 'm2')), join(root, 'ris2', 'local.yml'))
  assert.deepEqual(normalizeSpringArgs(['--spring.profiles.active=dev'], root, join(root, 'ris2', 'm2')), [
    '--spring.profiles.active=test',
    `--spring.config.additional-location=file:${join(root, 'ris2', 'local.yml')}`,
  ])
  assert.equal(profileFromPomText('<project><properties><profiles.active>uat</profiles.active></properties></project>'), 'uat')
  assert.equal(profileFromPomText('<project/>'), undefined)
})

test('the programs route generates a config on first open, then only touches it when the workspace moved', async () => {
  const { root } = await makeProgramFixture()
  // the project root owns local.yml (not the workspace root)
  await writeFile(join(root, 'proj-a', 'local.yml'), 'gray: {VERSION: test}\n')
  await withServer(async ({ base }) => {
    const first = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1`)).json()
    assert.equal(first.config.status, 'generated', 'no config ⇒ scan + write one')
    const configPath = configPathOf(root)
    assert.equal(existsSync(configPath), true)
    const generated = parseJsonc(await readFile(configPath, 'utf8'))
    const spring = generated.programs.find((entry) => entry.kind === 'spring')
    assert.deepEqual(spring.args, [
      '--spring.profiles.active=dev',
      `--spring.config.additional-location=file:${join(root, 'proj-a', 'local.yml')}`,
    ], 'the generated args point at the PROJECT local.yml, not the workspace one')

    // second open: the config matches ⇒ serve from it, no scan, file untouched
    const before = await readFile(configPath, 'utf8')
    const second = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1`)).json()
    assert.equal(second.config.status, 'matched')
    assert.equal(await readFile(configPath, 'utf8'), before, 'a matched config is not rewritten')
    assert.equal(second.programs.length, first.programs.length)
    assert.equal(second.programs.every((row) => row.fromConfig === true), true, 'rows come from the config')

    // the frontend manifest disappears ⇒ mismatch ⇒ auto-update drops the entry
    await rm(join(root, 'proj-a', 'ui', 'package.json'))
    const third = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1`)).json()
    assert.equal(third.config.status, 'updated')
    assert.equal(third.programs.some((row) => row.kind === 'frontend'), false)
    assert.equal(parseJsonc(await readFile(configPath, 'utf8')).programs.some((entry) => entry.kind === 'frontend'), false)

    // an explicit rescan always works and leaves the status stable
    const rescan = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)).json()
    assert.equal(['scanned', 'matched', 'generated', 'updated'].includes(rescan.config.status), true)
  }, undefined, root)
})

test('configMatchesWorkspace is a cheap, opinionated check', async () => {
  const { root } = await makeProgramFixture()
  const programs = await scanPrograms(root, join(root, 'logs'), true)
  const doc = buildConfigDocument(programs, root)
  assert.equal(configMatchesWorkspace(root, doc.programs), true, 'a fresh generated document matches')
  assert.equal(configMatchesWorkspace(root, []), false, 'an empty config never matches')
  // a stale workspace-root local.yml path is a mismatch when the project has one
  await writeFile(join(root, 'proj-a', 'local.yml'), 'x: 1\n')
  const stale = doc.programs.map((entry) => entry.kind === 'spring'
    ? Object.assign({}, entry, { args: ['--spring.profiles.active=dev', '--spring.config.additional-location=file:/elsewhere/local.yml'] })
    : entry)
  assert.equal(configMatchesWorkspace(root, stale), false, 'a foreign additional-location is a mismatch')
  const fresh = buildConfigDocument(programs, root)
  assert.equal(configMatchesWorkspace(root, fresh.programs), true, 'the regenerated args match')
  // A deliberately all-disabled config is authoritative (an empty program list),
  // while a completely empty file means "no config content" and never matches.
  assert.equal(configMatchesWorkspace(root, [{ disabled: true, name: 'x' }]), true)
})


// ── JVM options (memory etc.) from the config ─────────────────────────────

test('jvmArgs reach the java command (per program, or from root defaults)', () => {
  const spec = buildStartSpec(
    { kind: 'spring', dir: '/w/ris/m1', mainClass: 'a.B', args: ['--x'], jvmArgs: ['-Xmx2g', '-XX:+UseZGC', '-Dfoo=bar baz'] },
    { workspace: '/w', logsDir: '/w/logs' },
  )
  // AFTER the plugin's required -D flags (a deliberate override wins), BEFORE -cp.
  assert.match(spec.command, /-Dcsp\.sentinel\.log\.dir=[^ ]+ -Xmx2g -XX:\+UseZGC '-Dfoo=bar baz' -cp "target\/classes:/)
  assert.match(spec.command, /a\.B --x$/)

  const noJvm = buildStartSpec({ kind: 'spring', dir: '/w/m', mainClass: 'a.B', args: [] }, { workspace: '/w', logsDir: '/w/logs' })
  assert.doesNotMatch(noJvm.command, /-Xmx/, 'no jvmArgs means no extra flags')

  const programs = [{ id: 'spring:ris/m1#a.B', kind: 'spring', name: 'm1', relDir: 'ris/m1', dir: '/w/ris/m1', logName: 'm1', mainClass: 'a.B', args: [] }]
  // root defaults apply to programs that do not set their own
  assert.deepEqual(mergeProgramConfig(programs, [{ id: 'spring:ris/m1#a.B', name: 'm1' }], '/w', { jvmArgs: ['-Xmx1g'] })[0].jvmArgs, ['-Xmx1g'])
  // a per-program list wins over the defaults
  assert.deepEqual(mergeProgramConfig(programs, [{ id: 'spring:ris/m1#a.B', name: 'm1', jvmArgs: ['-Xmx4g'] }], '/w', { jvmArgs: ['-Xmx1g'] })[0].jvmArgs, ['-Xmx4g'])
  // a user-added program also inherits the defaults
  const manual = mergeProgramConfig([], [{ name: 'custom', dir: 'x', startCommand: 'true' }], '/w', { jvmArgs: ['-Xmx512m'] })[0]
  assert.deepEqual(manual.jvmArgs, ['-Xmx512m'])
  assert.deepEqual(normalizeStringArray([' -Xmx1g ', '', 7, null]), ['-Xmx1g'])
  assert.equal(normalizeStringArray([]), undefined)
})

test('the generated config documents jvmArgs, and an update keeps the user defaults', async () => {
  const { root } = await makeProgramFixture()
  const doc = buildConfigDocument(await scanPrograms(root, join(root, 'logs'), true), root)
  assert.deepEqual(doc.defaults, { jvmArgs: [] }, 'the template shows where global JVM flags go')
  const spring = doc.programs.find((entry) => entry.kind === 'spring')
  assert.deepEqual(spring.jvmArgs, [], 'every entry carries an editable jvmArgs list')

  await withServer(async ({ base }) => {
    const configPath = configPathOf(root)
    const post = (body) => fetch(`${base}${CONFIG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ sessionId: 's1' }, body)),
    })
    assert.equal((await post({})).status, 200)
    // the user adds a global memory default and a per-program override
    const edited = parseJsonc(await readFile(configPath, 'utf8'))
    edited.defaults = { jvmArgs: ['-Xmx1g'] }
    const springEntry = edited.programs.find((entry) => entry.kind === 'spring')
    springEntry.jvmArgs = ['-Xmx3g', '-Dfile.encoding=UTF-8']
    await writeFile(configPath, JSON.stringify(edited, null, 2))

    assert.equal((await post({ mode: 'update' })).status, 200)
    const updated = parseJsonc(await readFile(configPath, 'utf8'))
    assert.deepEqual(updated.defaults, { jvmArgs: ['-Xmx1g'] }, 'the global default survives an update')
    const kept = updated.programs.find((entry) => entry.kind === 'spring')
    assert.deepEqual(kept.jvmArgs, ['-Xmx3g', '-Dfile.encoding=UTF-8'], 'the per-program override survives an update')

    // and the start spec really uses them
    const listing = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1`)).json()
    const program = listing.programs.find((entry) => entry.kind === 'spring')
    assert.deepEqual(program.jvmArgs, ['-Xmx3g', '-Dfile.encoding=UTF-8'])
    const spec = buildStartSpec(program, { workspace: root, logsDir: join(root, 'logs') })
    assert.match(spec.command, /-Xmx3g -Dfile\.encoding=UTF-8/)
  }, undefined, root)
})


// ── Windows: native PowerShell wrapper, optional Git Bash runtime ─────────

test('windowsStartSpec describes the job for run-with-log.ps1', () => {
  const spring = windowsStartSpec(
    { kind: 'spring', dir: 'C:\\ws\\ris\\m1', mainClass: 'a.B', args: ['--spring.profiles.active=dev'], jvmArgs: ['-Xmx2g'], logName: 'm1' },
    { workspace: 'C:\\ws', logsDir: 'C:\\ws\\logs' },
  )
  assert.equal(spring.platform, 'win32')
  assert.ok(spring.scriptPath.endsWith('run-with-log.ps1'))
  assert.deepEqual(spring.spec, {
    logName: 'm1',
    logDir: 'C:\\ws\\logs',
    kind: 'spring',
    dir: 'C:\\ws\\ris\\m1',
    mainClass: 'a.B',
    args: ['--spring.profiles.active=dev'],
    jvmArgs: ['-Xmx2g'],
  })
  // the spec travels as base64 JSON (no quoting/arg-length traps)
  const roundTrip = JSON.parse(Buffer.from(Buffer.from(JSON.stringify(spring.spec), 'utf8').toString('base64'), 'base64').toString('utf8'))
  assert.deepEqual(roundTrip, spring.spec)

  const frontend = windowsStartSpec({ kind: 'frontend', dir: 'C:\\ws\\ui', packageManager: 'pnpm', script: 'dev', logName: 'ui' }, { workspace: 'C:\\ws', logsDir: 'C:\\ws\\logs' })
  assert.deepEqual(frontend.spec, { logName: 'ui', logDir: 'C:\\ws\\logs', kind: 'frontend', dir: 'C:\\ws\\ui', packageManager: 'pnpm', script: 'dev' })

  const custom = windowsStartSpec({ kind: 'spring', dir: 'C:\\ws', startCommand: 'java -jar x.jar', logName: 'x' }, { workspace: 'C:\\ws', logsDir: 'C:\\ws\\logs' })
  assert.equal(custom.spec.kind, 'command')
  assert.equal(custom.spec.command, 'java -jar x.jar')
  assert.equal(IS_WINDOWS, false, 'the test host is Linux; the Windows plan is exercised as data')
})

test('the Git Bash runtime is detected and can be requested explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-bash-'))
  const gitDir = join(dir, 'git', 'bin')
  const wslDir = join(dir, 'system32')
  await mkdir(gitDir, { recursive: true })
  await mkdir(wslDir, { recursive: true })
  const gitBash = join(gitDir, 'bash.exe')
  const wslBash = join(wslDir, 'bash.exe')
  await writeFile(gitBash, '')
  await writeFile(wslBash, '')
  // WSL's System32\bash.exe must never be picked (different pid/path namespace)
  assert.equal(pickGitBash([wslBash]), undefined)
  assert.equal(pickGitBash([wslBash, gitBash]), gitBash)
  assert.equal(pickGitBash([join(dir, 'missing', 'bash.exe')]), undefined)

  // auto: bash when found, PowerShell when not
  assert.deepEqual(resolveWindowsRuntime('auto', gitBash), { runtime: 'bash', bashPath: gitBash })
  assert.deepEqual(resolveWindowsRuntime('powershell', gitBash), { runtime: 'powershell' })
  // explicit bash must fail loudly when it is not installed
  assert.throws(() => resolveWindowsRuntime('bash', join(dir, 'missing', 'bash.exe')), /Git Bash/)
})

test('the windows-bash command keeps the POSIX wrapper but uses a Windows classpath', () => {
  const program = { kind: 'spring', dir: 'C:\\ws\\ris\\m1', mainClass: 'a.B', args: ['--x'], logName: 'm1' }
  const spec = buildStartSpec(program, { workspace: 'C:\\ws', logsDir: 'C:\\ws\\logs', variant: 'windows-bash' })
  assert.match(spec.command, /-cp "target\\classes;\$\(cat target\/cp\.txt\)" a\.B --x$/)
  assert.match(spec.command, /exec java -DJM\.LOG\.PATH=/)
  // ...while a plain POSIX build keeps ':' and target/classes
  const posix = buildStartSpec(program, { workspace: '/w', logsDir: '/w/logs' })
  assert.match(posix.command, /-cp "target\/classes:\$\(cat target\/cp\.txt\)" a\.B --x$/)
})


// ── Debug routes (HTTP surface) ────────────────────────────────────────────

test('the debug routes fence methods, require scope and answer a detached session', async () => {
  const { root } = await makeStartableFixture()
  await withServer(async ({ base }) => {
    // unknown action / wrong method / missing scope
    assert.equal((await fetch(`${base}${DEBUG_PATH}/nope?sessionId=s1`)).status, 404)
    assert.equal((await fetch(`${base}${DEBUG_PATH}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1' }) })).status, 405)
    assert.equal((await fetch(`${base}${DEBUG_PATH}/status`)).status, 400, 'sessionId is required')
    // status on a program that is not attached is a quiet 200 (the panel polls it)
    const status = await fetch(`${base}${DEBUG_PATH}/status?sessionId=s1&path=logs/tick.log`)
    assert.equal(status.status, 200)
    const body = await status.json()
    assert.equal(body.ok, true)
    assert.equal(body.attached, false)
    // poll is quiet too
    const poll = await (await fetch(`${base}${DEBUG_PATH}/poll?sessionId=s1&path=logs/tick.log&since=0`)).json()
    assert.deepEqual(poll.events, [])
    // POST breakpoints needs a path; POST step on a detached session is a 409
    assert.equal((await fetch(`${base}${DEBUG_PATH}/breakpoints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1' }) })).status, 400)
    const step = await fetch(`${base}${DEBUG_PATH}/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', path: 'logs/tick.log', kind: 'over' }) })
    assert.equal(step.status, 409)
    assert.equal((await step.json()).code, 'not-attached')
    // a frontend program cannot be debugged
    const listing = await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)).json()
    const frontend = listing.programs.find((entry) => entry.kind === 'frontend')
    const started = await fetch(`${base}${DEBUG_PATH}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: frontend.id }),
    })
    assert.equal(started.status, 400, 'frontend is not a Java program')
    assert.equal((await started.json()).code, 'not-startable')
  }, undefined, root)
})


// ── Bundled skill + ris_dev_skill ──────────────────────────────────────────

test('the bundled skill ships inside the package with valid frontmatter', async () => {
  assert.equal(SKILL_NAME, 'dsh-ris-ide-debug')
  const path = bundledSkillPath()
  assert.ok(existsSync(path), `bundledSkillPath must exist: ${path}`)
  const content = await readFile(path, 'utf8')
  assert.ok(content.startsWith('---'), 'the skill must start with YAML frontmatter')
  assert.match(content, /name: dsh-ris-ide-debug/)
  assert.match(content, /description:/)
  // A packaging regression would drop `skills` from `files` and ship no skill.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes('skills'), 'package.json files must include skills')
})

test('installSkill writes the bundled SKILL.md once and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-skill-'))
  try {
    // a project root marker, so the default `project` target resolves here
    await mkdir(join(root, '.git'), { recursive: true })
    const dir = join(root, '.dsh', 'skills')
    const bundled = await readFile(bundledSkillPath(), 'utf8')

    const first = await installSkill(root, undefined, dir)
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    assert.equal(first.target, 'custom')
    assert.equal(first.root, resolve(dir))
    assert.equal(first.bytes, Buffer.byteLength(bundled))
    assert.equal(await readFile(first.path, 'utf8'), bundled)

    const second = await installSkill(root, undefined, dir)
    assert.equal(second.changed, false, 'a second install must not rewrite')

    const state = await skillFileState(first.root)
    assert.equal(state.exists, true)
    assert.equal(state.upToDate, true)
    assert.equal(state.bytes, Buffer.byteLength(bundled))

    // The pure target resolution: project/agents stay in the workspace.
    assert.deepEqual(await skillRootFor(root, 'project'), { root: resolve(root, '.dsh', 'skills'), target: 'project' })
    assert.deepEqual(await skillRootFor(root, 'agents'), { root: resolve(root, '.agents', 'skills'), target: 'agents' })
    // `user` is asserted as a pure path only — never installed into the real home.
    assert.deepEqual(await skillRootFor(root, 'user'), { root: resolve(homedir(), '.dsh', 'skills'), target: 'user' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findProjectRoot walks up to the .git ancestor, not the nested start dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-root-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    const nested = join(root, 'ris', 'module', 'src')
    await mkdir(nested, { recursive: true })
    assert.equal(await findProjectRoot(nested), resolve(root))
    assert.notEqual(await findProjectRoot(nested), resolve(nested))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skillRootFor refuses an explicit dir outside the workspace and home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-skill-fence-'))
  try {
    const outside = join(tmpdir(), `dsh-ris-ide-outside-${process.pid}`)
    assert.ok(!outside.startsWith(root), 'the probe dir must be outside the workspace')
    await assert.rejects(skillRootFor(root, undefined, outside), (error) => {
      assert.equal(error.code, 'bad-path')
      assert.match(error.message, /outside the workspace or home/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ris_dev_skill is registered, renders its status and shows the bundled text', async () => {
  const { ctx, tools } = toolCtx(scratch)
  const dispose = registerAgentTools(ctx, {})
  try {
    const skill = tools.find((tool) => tool.name === 'ris_dev_skill')
    assert.ok(skill !== undefined, 'ris_dev_skill must be registered')

    const rendered = skill.output.render({}, {
      action: 'status',
      roots: [{ target: 'project', path: join(scratch, '.dsh', 'skills', SKILL_NAME, 'SKILL.md'), exists: true, upToDate: true }],
    })
    assert.deepEqual(rendered.map((part) => part.type), ['text'])
    assert.match(rendered[0].text, /up-to-date/)
    assert.match(rendered[0].text, /project → /)

    const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
    const shown = await skill.execute({ action: 'show' }, exec)
    assert.equal(shown.ok, true)
    assert.match(shown.content, /^---/)
    assert.match(shown.source, /skills[/\\]dsh-ris-ide-debug[/\\]SKILL\.md$/)
  } finally {
    dispose()
  }
})


// ── Skill auto-update (sync) ───────────────────────────────────────────────

/** The installed SKILL.md a given root would hold. */
function skillFileIn(root) {
  return join(root, SKILL_NAME, 'SKILL.md')
}

test('syncInstalledSkills refreshes a stale copy and never creates a missing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-sync-'))
  const homeUser = join(homedir(), '.dsh', 'skills')
  const homeAgents = join(homedir(), '.agents', 'skills')
  const homeBefore = { user: existsSync(skillFileIn(homeUser)), 'user-agents': existsSync(skillFileIn(homeAgents)) }
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    const projectRoot = join(root, '.dsh', 'skills')
    const projectFile = skillFileIn(projectRoot)
    await mkdir(dirname(projectFile), { recursive: true })
    await writeFile(projectFile, '---\nname: dsh-ris-ide-debug\n# stale copy from an older plugin\n---\n')
    const bundled = await readFile(bundledSkillPath(), 'utf8')

    const result = await syncInstalledSkills(root)
    assert.deepEqual(result.map((entry) => entry.target), ['project', 'agents', 'user', 'user-agents'], 'all four roots, in order')
    const by = Object.fromEntries(result.map((entry) => [entry.target, entry]))

    // The existing copy is rewritten in place.
    assert.deepEqual(by.project, {
      root: resolve(projectRoot),
      target: 'project',
      path: projectFile,
      existed: true,
      changed: true,
      upToDate: true,
    })
    assert.equal(await readFile(projectFile, 'utf8'), bundled, 'the stale copy is replaced with the bundled text')

    // A missing copy is reported, never created.
    assert.deepEqual(by.agents, {
      root: resolve(root, '.agents', 'skills'),
      target: 'agents',
      path: skillFileIn(join(root, '.agents', 'skills')),
      existed: false,
      changed: false,
      upToDate: false,
    })
    assert.ok(!existsSync(skillFileIn(join(root, '.agents', 'skills'))), 'sync must not create a missing copy')

    // The home roots are only reported; if a copy already exists there this
    // machine's sync legitimately refreshes it (that is the feature), so the
    // never-created assertion is conditional on the pre-state.
    for (const target of ['user', 'user-agents']) {
      const homeRoot = target === 'user' ? homeUser : homeAgents
      if (homeBefore[target]) {
        assert.equal(by[target].existed, true)
        assert.equal(by[target].upToDate, true)
      } else {
        assert.deepEqual(by[target], {
          root: resolve(homeRoot),
          target,
          path: skillFileIn(homeRoot),
          existed: false,
          changed: false,
          upToDate: false,
        })
        assert.ok(!existsSync(skillFileIn(homeRoot)), `sync must not create ${target}`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a second syncInstalledSkills is a no-op for every existing copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-sync2-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    const projectFile = skillFileIn(join(root, '.dsh', 'skills'))
    await mkdir(dirname(projectFile), { recursive: true })
    await writeFile(projectFile, 'stale\n')

    const first = await syncInstalledSkills(root)
    assert.equal(first.find((entry) => entry.target === 'project').changed, true, 'the first sync fixes the stale copy')

    const again = await syncInstalledSkills(root)
    assert.equal(again.length, first.length)
    for (const entry of again) {
      assert.equal(entry.changed, false, `${entry.target} must not be rewritten twice`)
      assert.equal(entry.upToDate, entry.existed, `${entry.target}: upToDate exactly when a copy exists`)
    }
    assert.deepEqual(again.find((entry) => entry.target === 'project'), {
      root: resolve(root, '.dsh', 'skills'),
      target: 'project',
      path: projectFile,
      existed: true,
      changed: false,
      upToDate: true,
    })
    assert.equal(again.find((entry) => entry.target === 'agents').existed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skillRootsFor maps the four targets to their roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-roots-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    assert.deepEqual(await skillRootsFor(root), [
      { root: resolve(root, '.dsh', 'skills'), target: 'project' },
      { root: resolve(root, '.agents', 'skills'), target: 'agents' },
      { root: resolve(homedir(), '.dsh', 'skills'), target: 'user' },
      { root: resolve(homedir(), '.agents', 'skills'), target: 'user-agents' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ris_dev_skill defaults to sync and auto-updates an existing copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-skill-sync-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    const projectFile = skillFileIn(join(root, '.dsh', 'skills'))
    await mkdir(dirname(projectFile), { recursive: true })
    await writeFile(projectFile, 'old skill text\n')

    const { ctx, tools } = toolCtx(root)
    const dispose = registerAgentTools(ctx, {})
    try {
      const skill = tools.find((tool) => tool.name === 'ris_dev_skill')
      assert.ok(skill !== undefined)
      // The schema advertises sync as the default, and says so in prose.
      assert.ok(skill.parameters.properties.action.enum.includes('sync'))
      assert.match(skill.parameters.properties.action.description, /default/)
      assert.match(skill.description, /auto-update/i)

      const exec = { agent: { session: { id: 's1' } }, signal: { throwIfAborted() {} } }
      const result = await skill.execute({}, exec)
      assert.equal(result.ok, true)
      assert.equal(result.action, 'sync', 'no action means sync')
      assert.ok(result.changed >= 1, 'the stale project copy was refreshed')
      const project = result.roots.find((entry) => entry.target === 'project')
      assert.equal(project.existed, true)
      assert.equal(project.changed, true)
      assert.equal(project.upToDate, true)
      assert.equal(await readFile(projectFile, 'utf8'), await readFile(bundledSkillPath(), 'utf8'))

      // status reports the plugin version the copies are tracking.
      const status = await skill.execute({ action: 'status' }, exec)
      assert.equal(status.ok, true)
      assert.equal(status.pluginVersion, PKG_VERSION)
    } finally {
      dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PKG_VERSION tracks package.json', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PKG_VERSION, manifest.version)
  assert.match(PKG_VERSION, /^\d+\.\d+\.\d+/)
})


// ── gitignore-aware, compact-folding IDE tree ───────────────────────────────
test('listIdeTree hides ignored files and folds package chains only under java', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-tree-'))
  try {
    await run('git', ['init', '-q'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'ignored/\n*.log\nempty-ignored/\n')
    await writeFile(join(root, 'a.java'), 'class A {}\n')
    await writeFile(join(root, 'debug.log'), 'noise\n')
    await mkdir(join(root, 'ignored'), { recursive: true })
    await writeFile(join(root, 'ignored', 'X.java'), 'class X {}\n')
    const java = join(root, 'src', 'main', 'java')
    const pkg = join(java, 'cn', 'com', 'ris')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'Foo.java'), 'class Foo {}\n')
    // A tracked chain AND an EMPTY sibling package: the empty folder is invisible
    // to `git ls-files`, so it must still stop the fold (it used to be swallowed,
    // leaving one long `cn.com.ris.cloud...` row and hiding `test` entirely).
    await mkdir(join(pkg, 'cloud', 'admin', 'controller'), { recursive: true })
    await writeFile(join(pkg, 'cloud', 'admin', 'controller', 'Cloud.java'), 'class Cloud {}\n')
    await mkdir(join(pkg, 'test'), { recursive: true })
    // Freshly created package folders are EMPTY: git cannot see them, but the tree
    // must (unless gitignore hides them).
    await mkdir(join(java, 'empty'), { recursive: true })
    await mkdir(join(java, 'empty-ignored'), { recursive: true })
    // A single-child folder chain OUTSIDE java must stay as separate rows.
    await mkdir(join(root, 'docs', 'guide'), { recursive: true })
    await writeFile(join(root, 'docs', 'guide', 'readme.md'), '# guide\n')

    const level = await __test.listIdeTree(root, root)
    const labels = level.entries.map((entry) => entry.label)
    assert.ok(labels.includes('a.java'), 'a tracked/untracked-but-not-ignored file shows')
    assert.equal(labels.includes('debug.log'), false, '*.log is ignored')
    assert.equal(labels.includes('ignored'), false, 'an ignored directory disappears')
    // src -> main -> java is a single-child chain, but it is NOT a package tail.
    assert.equal(labels.includes('src'), true, 'src/main/java is not compacted into one row')
    assert.equal(level.entries.some((entry) => entry.compact === true), false, 'nothing folds outside java')
    assert.equal(labels.includes('docs'), true, 'the docs chain is not compacted either')

    // Descend the plain folders: no compaction until the `java` folder is entered.
    const src = level.entries.find((entry) => entry.label === 'src')
    assert.equal(src.compact, false, 'a plain folder is not a compact row')
    const main = await __test.listIdeTree(src.path, root)
    assert.deepEqual(main.entries.map((entry) => entry.label), ['main'])
    const javaLevel = await __test.listIdeTree(join(java), root)
    const javaLabels = javaLevel.entries.map((entry) => entry.label)
    assert.ok(javaLabels.includes('empty'), 'an EMPTY folder under java shows (git cannot see it)')
    assert.equal(javaLabels.includes('empty-ignored'), false, 'an empty but gitignored folder stays hidden')
    const chain = javaLevel.entries.find((entry) => entry.compact === true)
    assert.ok(chain !== undefined, 'below java the single-child package chain folds')
    assert.equal(chain.label, 'cn.com.ris')
    assert.equal(chain.path, pkg, 'the folded path is the expansion target')

    // Inside the folded dir the boundary is normal again: the empty `test` package
    // still shows next to the tracked `cloud/...` chain.
    const inner = await __test.listIdeTree(chain.path, root)
    assert.deepEqual(inner.entries.map((entry) => entry.label), ['cloud.admin.controller', 'test', 'Foo.java'])
    assert.equal(inner.entries.find((entry) => entry.label === 'test').compact, false, 'an empty leaf is a plain row')
    assert.equal(inner.entries.find((entry) => entry.label === 'cloud.admin.controller').compact, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a CRLF .gitignore with a trailing blank line does not hide empty folders', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-crlf-'))
  try {
    await run('git', ['init', '-q'], { cwd: root })
    // A Windows-style .gitignore that ends in a blank line: `git check-ignore`
    // then reports an EMPTY pattern matching every directory. Taking the bare
    // pathname from that answer hid `ris-upms-biz/src/main/java/cn/com/ris/test`.
    await writeFile(join(root, '.gitignore'), 'ignored/\r\n\r\n')
    const javaDir = join(root, 'src', 'main', 'java')
    const pkg = join(javaDir, 'cn', 'com', 'ris')
    await mkdir(join(pkg, 'test'), { recursive: true })
    await mkdir(join(pkg, 'ignored'), { recursive: true })
    await mkdir(join(pkg, 'cloud'), { recursive: true })
    await writeFile(join(pkg, 'cloud', 'Cloud.java'), 'class Cloud {}\n')

    const javaLevel = await __test.listIdeTree(javaDir, root)
    const chain = javaLevel.entries.find((entry) => entry.compact === true)
    assert.ok(chain !== undefined, 'the package chain still folds')
    assert.equal(chain.label, 'cn.com.ris', 'the empty `test` sibling stops the fold at ris')
    assert.equal(chain.path, pkg)

    const inner = await __test.listIdeTree(chain.path, root)
    const labels = inner.entries.map((entry) => entry.label)
    assert.ok(labels.includes('test'), 'the CRLF blank-line quirk must not hide an empty package')
    assert.equal(labels.includes('ignored'), false, 'a real gitignore pattern still hides its folder')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findGitRoot walks up to the repo, and an unversioned tree lists raw', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-tree2-'))
  try {
    await run('git', ['init', '-q'], { cwd: root })
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'x.txt'), 'x')
    assert.equal(await __test.findGitRoot(nested, root), root)
    assert.equal(await __test.findGitRoot(nested, join(root, 'a')), undefined, 'the search stops at the limit')

    // No repo anywhere -> unfiltered listing (nothing is "ignored").
    const plain = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-tree3-'))
    try {
      await writeFile(join(plain, 'y.txt'), 'y')
      const level = await __test.listIdeTree(plain, plain)
      assert.deepEqual(level.entries.map((entry) => entry.label), ['y.txt'])
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


// ── resource guard rails: memory floor + log rotation ───────────────────────
test('availableMemoryBytes reports /proc data on Linux', async () => {
  const free = await __test.availableMemoryBytes()
  assert.equal(typeof free, 'number')
  if (process.platform === 'linux') assert.ok(free > 0, 'Linux exposes MemAvailable')
  assert.equal(__test.MIN_FREE_MEMORY_BYTES, 1024 * 1024 * 1024, 'the floor is 1 GiB')
  assert.equal(__test.LOG_ROTATE_BYTES, 32 * 1024 * 1024, 'logs rotate at 32 MiB')
})

test('assertEnoughMemory refuses only when the floor is not met', async () => {
  await __test.assertEnoughMemory(1) // 1 byte: always fine
  await assert.rejects(__test.assertEnoughMemory(Number.MAX_SAFE_INTEGER), /可用内存仅|拒绝启动/)
})

test('rotateLogIfLarge keeps one backup and truncates the live file', async () => {
  const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-rotate-'))
  try {
    const live = join(dir, 'svc.log')
    await writeFile(live, 'x'.repeat(4096))
    assert.equal(await __test.rotateLogIfLarge(live, 1024), true, 'a big log rotates')
    assert.equal((await stat(live)).size, 0, 'the live file is truncated in place (the JVM keeps its fd)')
    assert.equal((await stat(live + '.1')).size, 4096, 'the previous content is kept as .1')
    assert.equal(await __test.rotateLogIfLarge(live, 1024), false, 'a small log is left alone')
    assert.equal(await __test.rotateLogIfLarge(join(dir, 'missing.log')), false, 'a missing log is a no-op')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotateActiveLogs rotates tracked logs and forgets missing ones', async () => {
  const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-rotate2-'))
  try {
    const big = join(dir, 'big.log')
    const gone = join(dir, 'gone.log')
    await writeFile(big, 'y'.repeat(2048))
    __test.trackActiveLog(big)
    __test.trackActiveLog(gone) // never created → must be pruned, not thrown on

    const rotated = await __test.rotateActiveLogs(1024)
    assert.ok(rotated.includes(big), 'the tracked big log was rotated by the periodic sweep')
    assert.equal((await stat(big)).size, 0)
    assert.equal((await stat(big + '.1')).size, 2048)

    const again = await __test.rotateActiveLogs(1024)
    assert.equal(again.includes(big), false, 'a small log is skipped on the next sweep')
    assert.equal(again.includes(gone), false, 'a missing log is not reported as rotated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


// ── /debugs: the session list behind the IDE's auto-switch ──────────────────
test('the debug session list route exists and starts empty', async () => {
  assert.equal(__test.DEBUGS_PATH, `${__test.ROUTE_PREFIX}/debugs`)
  const sessions = await import('../lib/debug/engine.js')
  const engine = sessions.createDebugSessions({ eventLimit: 10 })
  assert.deepEqual(engine.listSessions(), [], 'no sessions before anyone attaches')
  assert.equal(engine.size, 0)
})


// ── ris_dev_debug state rendering (the agent's pre-flight snapshot) ─────────
test('the debug state snapshot renders one readable line', () => {
  const line = __test.renderDebug({
    ok: true,
    program: { id: 'spring:x#a.B', name: 'ris-auth', kind: 'spring', logPath: '/w/logs/a.log' },
    running: { alive: true, pid: 445482, rssBytes: 650 * 1024 * 1024 },
    debuggable: true,
    debug: { attached: true, port: 51234, vmSuspended: true, breakpoints: [] },
    breakpoints: [
      { requestId: 3, className: 'cn.com.ris.AuthApplication', line: 18 },
      { requestId: 'pending', className: 'cn.com.ris.ModelHelper', line: 168, pending: true },
    ],
    pendingBreakpoints: 1,
  })
  assert.match(line, /ris-auth \(spring\)/)
  assert.match(line, /running pid 445482/)
  assert.match(line, /attached port 51234 SUSPENDED/)
  assert.match(line, /cn\.com\.ris\.AuthApplication:18/)
  assert.match(line, /cn\.com\.ris\.ModelHelper:168\(预置\)/)
})


// ── /stream: SSE delta reads ───────────────────────────────────────────────
test('readFileRange returns exactly the appended bytes', async () => {
  const { writeFile, appendFile } = await import('node:fs/promises')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-range-'))
  const file = join(dir, 'x.log')
  await writeFile(file, 'one\ntwo\n')
  const first = await __test.readFileRange(file, 0, 8)
  assert.equal(first, 'one\ntwo\n')
  await appendFile(file, 'three\n')
  const delta = await __test.readFileRange(file, 8, 14)
  assert.equal(delta, 'three\n', 'only the new bytes are returned')
  assert.equal(await __test.readFileRange(file, 14, 14), '')
})

test('readTailWindow pages backwards with abutting, whole-line windows', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-window-'))
  const file = join(dir, 'svc.log')
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(40)}`)
  await writeFile(file, lines.join('\n') + '\n')

  const newest = await __test.readTailWindow(file, 1500)
  assert.equal(newest.mode, 'tail')
  assert.equal(newest.more, true)
  assert.ok(newest.content.endsWith('\n'), 'the newest window ends on a whole line')
  const older = await __test.readTailWindow(file, 1500, newest.from)
  assert.equal(older.to, newest.from, 'the windows abut exactly')
  assert.equal(older.more, true)
  const joined = older.content + newest.content
  const expected = lines.slice(lines.length - (joined.split('\n').length - 1)).join('\n') + '\n'
  assert.equal(joined, expected, 'old + new is the exact tail, without duplicated or split lines')

  // Paging all the way to the start stops reporting more.
  let cursor = older.from
  let pages = 2
  while (cursor > 0 && pages < 40) {
    const page = await __test.readTailWindow(file, 1500, cursor)
    cursor = page.from
    pages += 1
    if (page.from === 0) assert.equal(page.more, false)
  }
  assert.equal(cursor, 0, 'the oldest window starts at byte 0')
  assert.ok(pages > 2, 'this file needed several pages')
})

test('the SSE stream route is advertised', () => {
  assert.equal(__test.STREAM_PATH, `${__test.ROUTE_PREFIX}/stream`)
})


test('the SSE stream pushes a tail snapshot, then append deltas', async () => {
  const { mkdtemp, writeFile, appendFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-sse-'))
  const file = join(dir, 'svc.log')
  await writeFile(file, 'hello\n')

  const chunks = []
  const handlers = {}
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    flushHeaders() {},
    write(chunk) { chunks.push(String(chunk)); return true },
    end() { for (const fn of handlers.close ?? []) fn() },
    on(event, fn) { (handlers[event] ??= []).push(fn) },
  }
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    url: `/dsh-ris-ide/stream?sessionId=s1&topics=tail&tail=${encodeURIComponent(file)}`,
  }
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  await __test.serveStream(ctx, req, res)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)

  const readEvents = () => chunks.join('').split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const event = (lines.find((line) => line.startsWith('event: ')) ?? 'event: message').slice(7)
    const dataLine = lines.find((line) => line.startsWith('data: '))
    return { event, data: dataLine === undefined ? undefined : JSON.parse(dataLine.slice(6)) }
  })
  let events = readEvents()
  assert.ok(events.some((item) => item.event === 'hello'), 'the stream opens with hello')
  const snapshot = events.find((item) => item.event === 'tail')
  assert.ok(snapshot !== undefined, 'a tail snapshot is pushed first')
  assert.equal(snapshot.data.content, 'hello\n')

  await appendFile(file, 'world\n')
  await new Promise((resolve) => setTimeout(resolve, 700))
  events = readEvents()
  const appended = events.filter((item) => item.event === 'append')
  assert.ok(appended.length > 0, 'appended bytes are pushed')
  assert.equal(appended.map((item) => item.data.text).join(''), 'world\n')

  res.end()
})


// ── a stale session id must not blank the panel: the client's cwd is enough ──
test('a stale session id still answers when the client sends an absolute cwd', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-stale-'))
  const staleCtx = { sessions: { get: () => undefined } }
  const read = async (url) => {
    const chunks = []
    const res = { status: 0, writeHead(s) { this.status = s }, write(c) { chunks.push(String(c)); return true }, end(c) { if (c) chunks.push(String(c)) } }
    await __test.serveTree(staleCtx, { method: 'GET', headers: { host: '127.0.0.1:3080' }, url }, res)
    return { status: res.status, body: chunks.join('') }
  }
  const without = await read(`/dsh-ris-ide/tree?sessionId=session-gone&path=.`)
  assert.equal(without.status, 400, 'no cwd and no session: rejected')
  const withCwd = await read(`/dsh-ris-ide/tree?sessionId=session-gone&cwd=${encodeURIComponent(dir)}&path=.`)
  assert.equal(withCwd.status, 200, 'cwd alone is enough')
  assert.match(withCwd.body, /"ok":true/)
})

// ── a fresh tree read must show a file created after the last listing ──
test('fresh=1 re-reads the git-visible set so a just-copied file appears', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-fresh-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'a\n')
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  const list = async (fresh) => {
    const chunks = []
    const res = { writeHead() {}, write(c) { chunks.push(String(c)); return true }, end(c) { if (c) chunks.push(String(c)) } }
    const query = `sessionId=s1&path=${encodeURIComponent(dir)}` + (fresh ? '&fresh=1' : '')
    await __test.serveTree(ctx, { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: `/dsh-ris-ide/tree?${query}` }, res)
    const payload = JSON.parse(chunks.join(''))
    return payload.entries.map((entry) => entry.name)
  }
  const first = await list(false)
  assert.ok(first.includes('a.txt'))
  // the copy lands after the listing cache was built
  await writeFile(join(dir, 'a - 副本.txt'), 'a\n')
  const stale = await list(false)
  assert.equal(stale.includes('a - 副本.txt'), false, 'cached listing hides the new copy')
  const fresh = await list(true)
  assert.ok(fresh.includes('a - 副本.txt'), 'fresh=1 reveals it')
})

test('filter=all shows gitignored files, the default hides them', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-filter-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await writeFile(join(dir, '.gitignore'), 'secret.txt\nignored-dir/\n')
  await writeFile(join(dir, 'visible.txt'), 'v\n')
  await writeFile(join(dir, 'secret.txt'), 's\n')
  await mkdir(join(dir, 'ignored-dir'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  const list = async (extra) => {
    const chunks = []
    const res = { writeHead() {}, write(c) { chunks.push(String(c)); return true }, end(c) { if (c) chunks.push(String(c)) } }
    const query = `sessionId=s1&cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent(dir)}${extra}`
    await __test.serveTree(ctx, { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: `/dsh-ris-ide/tree?${query}` }, res)
    return JSON.parse(chunks.join(''))
  }
  const filtered = await list('')
  const filteredNames = filtered.entries.map((entry) => entry.name)
  assert.ok(filteredNames.includes('visible.txt'))
  assert.equal(filteredNames.includes('secret.txt'), false, 'the default hides gitignored files')
  assert.equal(filteredNames.includes('ignored-dir'), false)
  assert.equal(filteredNames.includes('.git'), false, 'git metadata is filtered too')
  assert.equal(filtered.git, true, 'the client needs to know git is what is filtering')
  assert.equal(filtered.filtered, true)

  // The title-bar eye toggles this: everything comes back, hidden dirs included.
  const all = await list('&filter=all')
  const allNames = all.entries.map((entry) => entry.name)
  assert.ok(allNames.includes('secret.txt'))
  assert.ok(allNames.includes('ignored-dir'))
  assert.ok(allNames.includes('.git'), '"show everything" keeps the .git row')
  assert.equal(all.filtered, false)
  assert.equal(all.git, true, 'git is still available, so the toggle can be turned back on')

  // A nested repo is listed through its own root; `.git` is metadata there too.
  await mkdir(join(dir, 'nested'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'nested') })
  const nested = await __test.listIdeTree(join(dir, 'nested'), dir)
  assert.equal(nested.entries.map((entry) => entry.name).includes('.git'), false, 'a nested repo hides its own .git')
})

// ── the tree topic: filesystem changes reach the browser without a manual ⟳ ──
test('the tree topic pushes changed relative paths from a recursive watch', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-tree-'))
  await mkdir(join(dir, 'svc', 'src'), { recursive: true })

  const chunks = []
  const handlers = {}
  let ended = false
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    flushHeaders() {},
    write(chunk) { if (ended) return false; chunks.push(String(chunk)); return true },
    end() { if (ended) return; ended = true; for (const fn of handlers.close ?? []) fn() },
    on(event, fn) { (handlers[event] ??= []).push(fn) },
  }
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    url: `/dsh-ris-ide/stream?sessionId=s1&topics=tree`,
  }
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  await __test.serveStream(ctx, req, res)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(res.status, 200)

  // A directory earns a watcher when the client lists it (that is "it is open").
  const listChunks = []
  await __test.serveTree(ctx, {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    url: `/dsh-ris-ide/tree?sessionId=s1&path=${encodeURIComponent(join(dir, 'svc', 'src'))}`,
  }, { writeHead(status, headers) { this.status = status; this.headers = headers }, write(c) { listChunks.push(String(c)); return true }, end(c) { if (c) listChunks.push(String(c)) } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  await writeFile(join(dir, 'svc', 'src', 'Probe.java'), 'class Probe {}\n')
  // TREE_DEBOUNCE_MS is 800ms on purpose (resource guard); leave headroom.
  await new Promise((resolve) => setTimeout(resolve, 1600))
  const events = chunks.join('').split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    return {
      event: (lines.find((line) => line.startsWith('event: ')) ?? 'event: message').slice(7),
      data: (() => {
        const line = lines.find((item) => item.startsWith('data: '))
        return line === undefined ? undefined : JSON.parse(line.slice(6))
      })(),
    }
  })
  const treeEvents = events.filter((item) => item.event === 'tree')
  assert.ok(treeEvents.length > 0, 'a tree frame is pushed after the write')
  const frame = treeEvents.find((item) => Array.isArray(item.data?.changed) && item.data.changed.length > 0)
  assert.ok(frame !== undefined, 'the frame carries changed paths')
  assert.ok(frame.data.changed.some((path) => String(path).includes('Probe.java')), 'the new file is named')
  assert.equal(frame.data.watched, true)
  res.end()
})


// ── filename search must never answer "nothing" just because cwd is a subdir ──
test('searchWorkspaceFiles climbs to the enclosing repo and falls back to a raw walk', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-search-'))
  await execFileSync('git', ['init', '-q'], { cwd: root })
  await mkdir(join(root, 'svc', 'src'), { recursive: true })
  await writeFile(join(root, 'svc', 'src', 'RisAuthApplication.java'), 'class RisAuthApplication {}\n')
  await writeFile(join(root, 'README.md'), '# x\n')
  await execFileSync('git', ['add', '-A'], { cwd: root })

  // A subdirectory of a repo (the "opened a program directory" case): climbing finds it.
  const nested = await __test.searchWorkspaceFiles(join(root, 'svc', 'src'), 'risauth', 10)
  assert.equal(nested.roots.length, 1)
  assert.ok(nested.matches.some((path) => path.endsWith('RisAuthApplication.java')))

  // No git anywhere: the raw walk still finds the file.
  const bare = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-bare-'))
  await mkdir(join(bare, 'a', 'b'), { recursive: true })
  await writeFile(join(bare, 'a', 'b', 'ModelHelper.java'), 'class ModelHelper {}\n')
  const raw = await __test.searchWorkspaceFiles(bare, 'modelhelper', 10)
  assert.ok(raw.matches.some((path) => path.endsWith('ModelHelper.java')), 'raw walk fallback')
})


// ── our own workspace file API (no dsh-better-sidebar) ─────────────────────
test('the fs routes read text, refuse binary/oversized and write back', async () => {
  const { mkdtemp, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-fs-'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }

  /** Drive one route handler with fake req/res. */
  async function call(pathname, { query = {}, body } = {}) {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers },
      write(chunk) { chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)) },
      on() {},
    }
    const url = `/dsh-ris-ide/${pathname}?` + new URLSearchParams(query).toString()
    const req = body === undefined
      ? { method: 'GET', url, headers: { host: '127.0.0.1:3080' } }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url, headers: { host: '127.0.0.1:3080' } })
    await __test.serveFs(ctx, req, res, {})
    const text = chunks.join('')
    return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
  }

  const textFile = join(dir, 'A.java')
  await write(textFile, 'class A {}\n')
  const read = await call('fs/read', { query: { sessionId: 's1', path: textFile } })
  assert.equal(read.status, 200)
  assert.equal(read.body.kind, 'text')
  assert.equal(read.body.content, 'class A {}\n')

  const binaryFile = join(dir, 'x.bin')
  await write(binaryFile, Buffer.from([0x00, 0x01, 0x02]))
  assert.equal((await call('fs/read', { query: { sessionId: 's1', path: binaryFile } })).body.kind, 'binary')

  const bigFile = join(dir, 'big.txt')
  await write(bigFile, 'x'.repeat(600 * 1024))
  assert.equal((await call('fs/read', { query: { sessionId: 's1', path: bigFile } })).body.kind, 'too-large')

  const written = await call('fs/write', { body: { sessionId: 's1', path: textFile, content: 'class A { int x; }\n' } })
  assert.equal(written.status, 200)
  assert.equal(written.body.ok, true)
  assert.equal((await call('fs/read', { query: { sessionId: 's1', path: textFile } })).body.content, 'class A { int x; }\n')
})

// ── a browser that cancels an image/file stream must not kill the host ─────
test('route bodies can never escape as uncaught exceptions', async () => {
  // 1) A route body that throws SYNCHRONOUSLY (not just a rejected promise) is
  // answered with 500 instead of throwing out of the HTTP handler.
  const chunks = []
  const res = {
    status: 0, headers: {}, headersSent: false, writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
    end(text) { chunks.push(String(text)); this.writableEnded = true },
    destroy() { this.destroyed = true },
  }
  __test.serveSafely(res, () => { throw new Error('sync boom') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.status, 500)
  assert.match(chunks.join(''), /sync boom/)

  // 2) A response that throws while writing (dead socket) must not throw back.
  const dead = {
    headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { throw new Error('socket is gone') },
    end() { throw new Error('socket is gone') },
    destroy() { this.destroyed = true },
  }
  __test.writeTailError(dead, new Error('after destroy'))
  assert.equal(dead.destroyed, true)

  // 3) handleRequest's own fence: routing on a half-dead response never throws.
  const ctx = { sessions: { get: () => ({ header: { cwd: process.cwd() } }) } }
  assert.doesNotThrow(() => {
    __test.handleRequest(ctx, { method: 'GET', url: '/dsh-ris-ide/nope', headers: { host: '127.0.0.1:1' } }, dead, {})
  })
})

test('a cancelled file stream is destroyed, never answered a second time', async () => {
  const { mkdtemp, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Writable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-abort-'))
  const image = join(dir, 'shot.png')
  await write(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

  // The fake response starts a 200 (the stream headers), then dies on the first
  // byte — exactly what an aborted img request looks like to the host.
  let writeHeads = 0
  let destroyedByGuard = false
  const res = new Writable({
    write(chunk, encoding, callback) { callback(new Error('client went away')) },
  })
  res.headersSent = false
  res.writeHead = function (status) {
    writeHeads += 1
    if (writeHeads > 1) throw new Error('headers already sent')
    this.headersSent = true
    this.status = status
  }
  const originalDestroy = res.destroy.bind(res)
  res.destroy = function (error) { destroyedByGuard = true; return originalDestroy(error) }

  const req = { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: `/dsh-ris-ide/fs/file?sessionId=s1&path=${encodeURIComponent(image)}` }
  // Before the guard this rejected (writeTailError → writeHead on a sent response),
  // which surfaced as `fatal load failure: ERR_HTTP_HEADERS_SENT` and killed dsh.
  await __test.serveFs({ sessions: { get: () => ({ header: { cwd: dir } }) } }, req, res, {})
  assert.equal(writeHeads, 1, 'the headers went out exactly once')
  assert.equal(res.status, 200)
  assert.equal(destroyedByGuard, true, 'the aborted response is destroyed, not re-answered')
})

test('a response that already started is never written again', async () => {
  // writeTailError itself must be a no-op on a sent response.
  const sent = { headersSent: true, writableEnded: false, destroyed: false, writeHead() { throw new Error('must not reach writeHead') }, destroy() { this.destroyed = true } }
  assert.doesNotThrow(() => __test.writeTailError(sent, new Error('boom')))
  assert.equal(sent.destroyed, true)

  // serveSafely answers a fresh response as JSON, and destroys a started one.
  const chunks = []
  const fresh = {
    status: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
    end(text) { chunks.push(String(text)); this.writableEnded = true },
    destroy() { this.destroyed = true },
  }
  await __test.serveSafely(fresh, async () => { throw new Error('boom') })
  assert.equal(fresh.status, 500)
  assert.equal(JSON.parse(chunks.join('')).ok, false)

  const started = {
    headersSent: true,
    writableEnded: false,
    destroyed: false,
    writeHead() { throw new Error('must not reach writeHead') },
    end() { throw new Error('must not end') },
    destroy() { this.destroyed = true },
  }
  await __test.serveSafely(started, async () => { throw new Error('boom') })
  assert.equal(started.destroyed, true)
})


// ── lazy client chunks (the CodeMirror editor bundle) ──────────────────────
test('the bundle route serves the built CodeMirror chunk and refuses other names', async () => {
  async function call(query) {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers },
      write(chunk) { chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)) },
      on() {},
    }
    const req = { method: 'GET', url: `/dsh-ris-ide/bundle?${new URLSearchParams(query).toString()}`, headers: { host: '127.0.0.1:3080' } }
    await __test.serveBundle(req, res)
    return { status: res.status, headers: res.headers, body: chunks.join('') }
  }

  const chunk = await call({ name: 'codemirror' })
  assert.equal(chunk.status, 200)
  assert.match(chunk.headers['content-type'], /text\/javascript/)
  assert.match(chunk.body.slice(0, 200), /globalThis\.__dshRisIdeChunks__/, 'the chunk parks its factory on the plugin registry')
  assert.match(chunk.body, /exports\.mount = mount/, 'and exports the editor mount')

  const unknown = await call({ name: 'nope' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body, /unknown chunk/)
})


// ── the watch filter must use the tree's own ignore rules (no git per event) ──
test('treeWatchAccepts keeps visible files and drops gitignored churn', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-watch-'))
  await execFileSync('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'logs/\ntarget/\n')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'A.java'), 'class A {}\n')
  await mkdir(join(root, 'logs'), { recursive: true })
  await writeFile(join(root, 'logs', 'svc.log'), 'tick\n')

  const accepted = await __test.treeWatchAccepts(root, ['src/A.java', 'logs/svc.log', 'target/x/classes/Y.class', '.git/refs/heads/main'])
  assert.deepEqual(accepted, ['src/A.java'], 'only the visible file survives')
})

test('SSE frames are dropped when the socket is backed up', () => {
  assert.equal(__test.shouldDropSseFrame(0), false)
  assert.equal(__test.shouldDropSseFrame(undefined), false)
  assert.equal(__test.shouldDropSseFrame(__test.SSE_MAX_BUFFER_BYTES), false)
  assert.equal(__test.shouldDropSseFrame(__test.SSE_MAX_BUFFER_BYTES + 1), true)
})

// ── undo trash: hidden from the tree, and restorable by an explicit name ─────
test('the undo trash is never a tree row and move honours an explicit name', async () => {
  const { mkdtemp, mkdir, readdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-trash-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'A.java'), 'class A {}\n')

  const treeChunks = []
  const treeRes = { writeHead(status, headers) { this.status = status; this.headers = headers }, write(c) { treeChunks.push(String(c)); return true }, end(c) { if (c !== undefined && c !== null) treeChunks.push(String(c)) } }
  const treeReq = { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: '/dsh-ris-ide/tree?sessionId=s1' }
  await __test.serveTree({ sessions: { get: () => ({ header: { cwd: dir } }) } }, treeReq, treeRes)
  const entries = JSON.parse(treeChunks.join('')).entries.map((entry) => entry.name)
  assert.deepEqual(entries, ['src'], 'the trash never appears as a row')

  // move A.java into the trash under a parked name, then move it back by name
  async function op(pathname, body) {
    const chunks = []
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, write(c) { chunks.push(String(c)); return true }, end(c) { if (c !== undefined) chunks.push(String(c)) }, on() {} }
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: `/dsh-ris-ide/${pathname}`, headers: { host: '127.0.0.1:3080' } })
    await __test.serveFsOp({ sessions: { get: () => ({ header: { cwd: dir } }) } }, req, res, {})
    return { status: res.status, body: JSON.parse(chunks.join('') || 'null') }
  }
  await op('fs/mkdir', { sessionId: 's1', path: join(dir, '.dsh-ris-ide', 'trash') })
  const parked = await op('fs/move', { sessionId: 's1', from: join(dir, 'src', 'A.java'), toDir: join(dir, '.dsh-ris-ide', 'trash'), name: '1730-A.java' })
  assert.equal(parked.status, 200)
  assert.equal(parked.body.path, join(dir, '.dsh-ris-ide', 'trash', '1730-A.java'))
  const restored = await op('fs/move', { sessionId: 's1', from: join(dir, '.dsh-ris-ide', 'trash', '1730-A.java'), toDir: join(dir, 'src'), name: 'A.java' })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.path, join(dir, 'src', 'A.java'))
  assert.equal((await readdir(join(dir, 'src'))).includes('A.java'), true)
  assert.equal((await op('fs/move', { sessionId: 's1', from: join(dir, 'src', 'A.java'), toDir: join(dir, 'src'), name: '../evil' })).status, 400)
})


// ── file-tree mutations (menu / shortcuts / drag&drop) ─────────────────────
test('fs op routes create, copy, move and remove without clobbering', async () => {
  const { mkdtemp, mkdir, readdir, readFile, rm, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-ops-'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }

  async function call(pathname, body) {
    const chunks = []
    const res = {
      status: 0,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      write(chunk) { chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)) },
      on() {},
    }
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      method: 'POST',
      url: `/dsh-ris-ide/${pathname}`,
      headers: { host: '127.0.0.1:3080' },
    })
    await __test.serveFsOp(ctx, req, res, {})
    const text = chunks.join('')
    return { status: res.status, body: text === '' ? undefined : JSON.parse(text) }
  }

  const pkgDir = join(dir, 'src/main/java/cn/com/demo')
  assert.equal((await call('fs/mkdir', { sessionId: 's1', cwd: dir, path: pkgDir })).status, 200)
  const created = await call('fs/create', { sessionId: 's1', cwd: dir, path: join(pkgDir, 'Demo.java'), content: 'class Demo {}' })
  assert.equal(created.status, 200)
  assert.equal(await readFile(join(pkgDir, 'Demo.java'), 'utf8'), 'class Demo {}')
  // never overwrite an existing file
  assert.equal((await call('fs/create', { sessionId: 's1', cwd: dir, path: join(pkgDir, 'Demo.java') })).status, 409)

  // copy into another directory keeps the basename
  const copyDir = join(dir, 'backup')
  await mkdir(copyDir, { recursive: true })
  const copied = await call('fs/copy', { sessionId: 's1', cwd: dir, from: join(pkgDir, 'Demo.java'), toDir: copyDir })
  assert.equal(copied.status, 200)
  assert.equal(await readFile(join(copyDir, 'Demo.java'), 'utf8'), 'class Demo {}')
  // …and a second copy refuses the collision
  assert.equal((await call('fs/copy', { sessionId: 's1', cwd: dir, from: join(pkgDir, 'Demo.java'), toDir: copyDir })).status, 409)
  // A destination given as a FILE means its folder — the tree hands over the
  // selected row, and "copy next to this file" is what a user means there.
  const besideCopy = await call('fs/copy', { sessionId: 's1', cwd: dir, from: join(pkgDir, 'Demo.java'), toDir: join(copyDir, 'Demo.java'), name: 'Beside.java' })
  assert.equal(besideCopy.status, 200)
  assert.equal(await readFile(join(copyDir, 'Beside.java'), 'utf8'), 'class Demo {}')

  // move
  const movedDir = join(dir, 'moved')
  await mkdir(movedDir, { recursive: true })
  const moved = await call('fs/move', { sessionId: 's1', cwd: dir, from: join(pkgDir, 'Demo.java'), toDir: movedDir })
  assert.equal(moved.status, 200)
  assert.equal((await readdir(pkgDir)).includes('Demo.java'), false)

  // non-empty directory needs explicit recursive
  assert.equal((await call('fs/remove', { sessionId: 's1', cwd: dir, path: movedDir })).status, 409)
  const removed = await call('fs/remove', { sessionId: 's1', cwd: dir, path: movedDir, recursive: true })
  assert.equal(removed.status, 200)
  assert.equal((await readdir(dir)).includes('moved'), false)

  // the workspace root is never a legal mutation target
  assert.equal((await call('fs/mkdir', { sessionId: 's1', cwd: dir, path: dir })).status, 409)

  // A path is only a string from the page: a mutation never leaves the tree
  // root, so `../` (or an absolute path outside) cannot widen a delete.
  const escape = join(dir, '..', 'escape-me.txt')
  await write(escape, 'outside')
  const escaped = await call('fs/remove', { sessionId: 's1', cwd: dir, path: escape, recursive: true })
  assert.equal(escaped.status, 403)
  assert.equal(await readFile(escape, 'utf8'), 'outside', 'the outside file survives the attempt')
  await rm(escape, { force: true })
  assert.equal((await call('fs/copy', { sessionId: 's1', cwd: dir, from: join(pkgDir, 'Demo.java'), toDir: join(dir, '..') })).status, 403)

  // Special characters are just characters: no shell ever sees this name, and
  // removing it leaves every sibling alone.
  const odd = join(copyDir, "; rm -rf * $(id) 'quoted' & echo.txt")
  await write(odd, 'safe')
  await write(join(copyDir, 'neighbour.txt'), 'keep')
  assert.equal((await call('fs/remove', { sessionId: 's1', cwd: dir, path: odd })).status, 200)
  assert.equal(await readFile(join(copyDir, 'neighbour.txt'), 'utf8'), 'keep')
  // …and a control character in a name is refused outright
  assert.equal((await call('fs/create', { sessionId: 's1', cwd: dir, path: join(copyDir, 'bad\nname.txt') })).status, 400)
})

test('pasted OS files upload and import into the tree', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-paste-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-src-'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }

  function response() {
    const chunks = []
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      write(chunk) { chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)) },
      on() {},
    }
    return { res, read: () => (chunks.join('') === '' ? undefined : JSON.parse(chunks.join(''))) }
  }

  async function upload(query, bytes) {
    const { res, read } = response()
    const req = Object.assign(Readable.from([Buffer.from(bytes)]), {
      method: 'POST',
      url: '/dsh-ris-ide/fs/upload?' + new URLSearchParams(query).toString(),
      headers: { host: '127.0.0.1:3080' },
    })
    await __test.serveFsImport(ctx, req, res, {})
    return { status: res.status, body: read() }
  }

  async function importPath(body) {
    const { res, read } = response()
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {
      method: 'POST',
      url: '/dsh-ris-ide/fs/import',
      headers: { host: '127.0.0.1:3080' },
    })
    await __test.serveFsImport(ctx, req, res, {})
    return { status: res.status, body: read() }
  }

  // A pasted/dropped File arrives as raw bytes; binary must survive untouched.
  const target = join(dir, 'pasted.bin')
  const first = await upload({ sessionId: 's1', cwd: dir, dir, name: 'pasted.bin' }, [0, 1, 2, 255])
  assert.equal(first.status, 200)
  assert.equal(first.body.bytes, 4)
  assert.deepEqual([...await readFile(target)], [0, 1, 2, 255])
  assert.equal((await upload({ sessionId: 's1', cwd: dir, dir, name: 'pasted.bin' }, 'x')).status, 409)
  assert.equal((await upload({ sessionId: 's1', cwd: dir, dir, name: 'pasted.bin', overwrite: '1' }, 'new')).status, 200)
  assert.equal(await readFile(target, 'utf8'), 'new')

  // A paste aimed AT a file lands in that file's folder instead of failing: the
  // tree can hand over the selected file row as the destination.
  const besideUpload = await upload({ sessionId: 's1', cwd: dir, dir: target, name: 'beside.bin' }, 'b')
  assert.equal(besideUpload.status, 200)
  assert.equal(await readFile(join(dir, 'beside.bin'), 'utf8'), 'b')
  // …but a destination that does not exist is still refused
  const nowhere = await upload({ sessionId: 's1', cwd: dir, dir: join(dir, 'nope'), name: 'x.bin' }, 'x')
  assert.equal(nowhere.status, 400)

  // A path copied outside the workspace is imported in (the destination stays guarded).
  const sourceFile = join(outside, 'notes.md')
  await writeFile(sourceFile, '# hi\n')
  const imported = await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir })
  assert.equal(imported.status, 200)
  assert.equal(await readFile(join(dir, 'notes.md'), 'utf8'), '# hi\n')
  assert.equal((await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir })).status, 409)
  assert.equal((await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir, overwrite: true })).status, 200)
  // the same file→folder rule governs a copied path
  const besideImport = await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir: target, name: 'notes-beside.md' })
  assert.equal(besideImport.status, 200)
  assert.equal(await readFile(join(dir, 'notes-beside.md'), 'utf8'), '# hi\n')
  // …and a leaf name can never escape the destination directory
  assert.equal((await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir, name: '../evil.md' })).status, 400)
  // The DESTINATION is guarded too: an overwrite paste (which removes the
  // colliding entry) can never be aimed at a directory outside the tree.
  assert.equal((await importPath({ sessionId: 's1', cwd: dir, from: sourceFile, dir: outside, name: 'notes.md', overwrite: true })).status, 403)
  assert.equal(await readFile(sourceFile, 'utf8'), '# hi\n', 'nothing outside the tree was touched')
  // A control character never reaches a file name (it would corrupt every
  // line-oriented protocol downstream).
  assert.equal((await upload({ sessionId: 's1', cwd: dir, dir, name: 'bad\nname.bin' }, 'x')).status, 400)
})

// ── the debug stream: a page reload must still show its pre-set breakpoints ──
test('the debug stream carries pending breakpoints, so a reload shows its dots', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-debug-stream-'))
  const logPath = join(dir, 'app.log')
  // Pre-set breakpoint: no debug session at all, exactly the state after a reload.
  await __test.debugSessions.addBreakpoint(logPath, 'a.B', 12)

  const chunks = []
  const handlers = {}
  let ended = false
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    flushHeaders() {},
    write(chunk) { if (ended) return false; chunks.push(String(chunk)); return true },
    end() { if (ended) return; ended = true; for (const fn of handlers.close ?? []) fn() },
    on(event, fn) { (handlers[event] ??= []).push(fn) },
  }
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    url: `/dsh-ris-ide/stream?sessionId=s1&topics=debug&path=${encodeURIComponent(logPath)}`,
  }
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  try {
    await __test.serveStream(ctx, req, res)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(res.status, 200)
    const frames = chunks.join('').split('\n\n').filter((block) => block.startsWith('event: debug\n'))
    assert.ok(frames.length > 0, 'the debug topic pushes an immediate frame')
    const payload = JSON.parse(frames[0].split('\n').find((line) => line.startsWith('data: ')).slice(5))
    assert.equal(payload.ok, true, 'the frame is a success payload for the client')
    assert.deepEqual(payload.breakpoints, [{ requestId: 'pending', pending: true, className: 'a.B', line: 12, suspendPolicy: 'thread' }])
  } finally {
    await __test.debugSessions.clearBreakpoints(logPath)
    res.end()
  }
})

// ── dependency sources: jar entries, sources.jar extraction, settings ────────
/** Build a minimal stored-only zip so the jar reader is exercised offline. */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDirectory, eocd])
}

test('the jar reader lists entries and extracts stored bytes', async () => {
  const { mkdtemp, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-zip-'))
  const jar = join(dir, 'dep-1.0.jar')
  const classBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 1, 2, 3])
  await write(jar, buildZip([{ name: 'pkg/Dep.class', data: classBytes }, { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' }]))
  const entries = await __test.readZipEntries(jar)
  assert.deepEqual(entries.map((entry) => entry.name), ['pkg/Dep.class', 'META-INF/MANIFEST.MF'])
  const bytes = await __test.readZipEntry(jar, entries[0])
  assert.deepEqual(bytes, classBytes)
  assert.equal(await __test.readZipEntries(join(dir, 'missing.jar')).then((list) => list.length), 0)
})

test('a dependency class resolves from its sources.jar into the workspace cache', async () => {
  const { mkdtemp, mkdir, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-src-'))
  const programDir = join(cwd, 'prog')
  await mkdir(join(programDir, 'target'), { recursive: true })
  const binaries = join(programDir, 'libs', 'dep-1.0.jar')
  const sources = join(programDir, 'libs', 'dep-1.0-sources.jar')
  await mkdir(join(programDir, 'libs'), { recursive: true })
  await write(binaries, buildZip([{ name: 'pkg/Dep.class', data: Buffer.from([0xca, 0xfe]) }]))
  await write(sources, buildZip([{ name: 'pkg/Dep.java', data: 'package pkg;\npublic class Dep { int value; }\n' }]))
  await write(join(programDir, 'target', 'cp.txt'), [binaries, '/nonexistent/other.jar'].join('\n'))

  const resolved = await __test.resolveDependencySource(cwd, programDir, 'pkg.Dep')
  assert.ok(resolved !== undefined, 'the sources.jar entry is found')
  assert.equal(resolved.kind, 'sources')
  assert.equal(resolved.jar, sources)
  assert.equal(resolved.path, join(cwd, '.dsh-ris-ide', 'cache', 'sources', 'pkg.Dep.java'))
  const text = await (await import('node:fs/promises')).readFile(resolved.path, 'utf8')
  assert.match(text, /public class Dep/)

  assert.equal(await __test.resolveDependencySource(cwd, programDir, 'pkg.Missing'), undefined)
})

test('a rebuilt jar invalidates the cached dependency source', async () => {
  const { mkdtemp, mkdir, readFile: read, stat, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-cache-'))
  const programDir = join(cwd, 'prog')
  const binaries = join(programDir, 'libs', 'dep-1.0.jar')
  const sources = join(programDir, 'libs', 'dep-1.0-sources.jar')
  await mkdir(join(programDir, 'libs'), { recursive: true })
  await mkdir(join(programDir, 'target'), { recursive: true })
  await write(binaries, buildZip([{ name: 'pkg/Dep.class', data: Buffer.from([0xca, 0xfe]) }]))
  await write(sources, buildZip([{ name: 'pkg/Dep.java', data: 'package pkg;\npublic class Dep {}\n' }]))
  await write(join(programDir, 'target', 'cp.txt'), binaries)

  const first = await __test.resolveDependencySource(cwd, programDir, 'pkg.Dep')
  const firstText = await read(first.path, 'utf8')
  assert.match(firstText, /public class Dep/)
  const firstInfo = await stat(first.path)

  // Rebuilding the source jar must invalidate the cached copy: the cache is keyed
  // by the jar's size/mtime and the entry, not by "the file exists therefore it's
  // correct" — otherwise an updated dependency keeps serving old sources.
  await new Promise((resolve) => setTimeout(resolve, 12))
  await write(sources, buildZip([{ name: 'pkg/Dep.java', data: 'package pkg;\n/** rebuilt */\npublic class Dep {}\n' }]))
  const again = await __test.resolveDependencySource(cwd, programDir, 'pkg.Dep')
  assert.equal(again.path, first.path)
  assert.match(await read(again.path, 'utf8'), /rebuilt/)
  assert.ok((await stat(again.path)).mtimeMs > firstInfo.mtimeMs)

  const manifest = await __test.readCacheManifest(join(cwd, '.dsh-ris-ide', 'cache'))
  assert.equal(manifest.entries['sources/pkg.Dep.java'].kind, 'sources')
})

test('the dependency cache prunes aged and oversized entries', async () => {
  const { mkdtemp, mkdir, readdir, utimes, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-gc-'))
  const root = join(cwd, '.dsh-ris-ide', 'cache')
  const dir = join(root, 'sources')
  await mkdir(dir, { recursive: true })
  const writeOne = async (name, text, ageMs) => {
    const file = join(dir, name)
    await write(file, text)
    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs)
      await utimes(file, past, past)
    }
    return file
  }
  await writeOne('Old.java', '0123456789', 2 * 60 * 60 * 1000)
  await writeOne('Mid.java', '0123456789', 0)
  await writeOne('New.java', '0123456789', 0)

  // 1) TTL: files untouched for longer than the window go first.
  await __test.pruneIdeCache(root, { force: true, maxBytes: 1024 * 1024, maxFiles: 100, maxAgeMs: 60 * 60 * 1000 })
  assert.deepEqual((await readdir(dir)).sort(), ['Mid.java', 'New.java'])

  // 2) Size budget: drop the oldest remaining until the tree fits.
  await __test.pruneIdeCache(root, { force: true, maxBytes: 15, maxFiles: 100, maxAgeMs: 0 })
  assert.deepEqual(await readdir(dir), ['New.java'])
})

test('the visual debug settings persist the decompiler jar without touching the program config', async () => {
  const { mkdtemp, readFile: read, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-settings-'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }
  const answer = () => {
    const chunks = []
    const res = {
      status: 0, headers: {}, headersSent: false, writableEnded: false, destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      end(text) { chunks.push(String(text)); this.writableEnded = true },
      destroy() { this.destroyed = true },
    }
    return { res, json: () => JSON.parse(chunks.join('')) }
  }

  const posted = answer()
  await __test.serveSettings(ctx, {
    method: 'POST', headers: { host: '127.0.0.1:3080' }, url: '/dsh-ris-ide/settings',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ sessionId: 's1', decompilerJar: '/opt/cfr/cfr.jar', decompilerArgs: ['{classfile}'] })) },
  }, posted.res, {})
  assert.equal(posted.res.status, 200)
  assert.equal(posted.json().decompiler.jar, '/opt/cfr/cfr.jar')
  const settingsPath = join(dir, '.dsh-ris-ide', 'settings.json')
  const saved = JSON.parse(await read(settingsPath, 'utf8'))
  assert.deepEqual(saved.decompiler, { jar: '/opt/cfr/cfr.jar', args: ['{classfile}'] })
  assert.equal(await read(join(dir, '.dsh-ris-ide', 'config.json'), 'utf8').catch(() => undefined), undefined, 'the program config stays untouched')

  const got = answer()
  await __test.serveSettings(ctx, { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: '/dsh-ris-ide/settings?sessionId=s1' }, got.res, {})
  assert.equal(got.res.status, 200)
  assert.equal(got.json().decompiler.jar, '/opt/cfr/cfr.jar')
  assert.equal(got.json().cacheDir, join(dir, '.dsh-ris-ide', 'cache'))

  // Clearing the field removes the key from the settings file.
  const cleared = answer()
  await __test.serveSettings(ctx, {
    method: 'POST', headers: { host: '127.0.0.1:3080' }, url: '/dsh-ris-ide/settings',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ sessionId: 's1', decompilerJar: '' })) },
  }, cleared.res, {})
  assert.equal(JSON.parse(await read(settingsPath, 'utf8')).decompiler, undefined)
})

// ── windowed reads power the read-only preview of oversized text files ─────
test('fs/window pages a large file and never splits a multi-byte character', async () => {
  const { mkdtemp, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-window-'))
  const ctx = { sessions: { get: () => ({ header: { cwd: dir } }) } }

  /** Drive fs/window with fake req/res. */
  async function call(query) {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers },
      write(chunk) { chunks.push(String(chunk)); return true },
      end(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)) },
      on() {},
    }
    const url = '/dsh-ris-ide/fs/window?' + new URLSearchParams(query).toString()
    const req = { method: 'GET', url, headers: { host: '127.0.0.1:3080' } }
    await __test.serveFs(ctx, req, res, {})
    return { status: res.status, body: JSON.parse(chunks.join('')) }
  }

  // 'ab中文cd' = 10 bytes; a 3-byte window lands INSIDE 中, so its tail is held
  // back for the next request instead of being decoded as U+FFFD.
  const text = join(dir, 'mixed.txt')
  await write(text, 'ab中文cd')
  const head = await call({ sessionId: 's1', path: text, offset: 0, length: 3 })
  assert.equal(head.body.kind, 'text-window')
  assert.equal(head.body.text, 'ab')
  assert.equal(head.body.next, 2)
  assert.equal(head.body.eof, false)
  const middle = await call({ sessionId: 's1', path: text, offset: head.body.next, length: 3 })
  assert.equal(middle.body.text, '中')
  assert.equal(middle.body.next, 5)

  // A window at/after EOF answers cleanly instead of reading past the end.
  const tail = await call({ sessionId: 's1', path: text, offset: 999, length: 10 })
  assert.equal(tail.body.eof, true)
  assert.equal(tail.body.text, '')
  assert.equal(tail.body.next, 10)

  // A big text file pages by offset; the last page reports eof.
  const big = join(dir, 'big.txt')
  await write(big, 'x'.repeat(600 * 1024))
  const first = await call({ sessionId: 's1', path: big, offset: 0, length: 1024 })
  assert.equal(first.body.text.length, 1024)
  assert.equal(first.body.size, 600 * 1024)
  const last = await call({ sessionId: 's1', path: big, offset: 600 * 1024 - 100, length: 1024 })
  assert.equal(last.body.eof, true)
  assert.equal(last.body.text.length, 100)

  // Binary is rejected on the FIRST window (later windows never fetch).
  const bin = join(dir, 'x.bin')
  await write(bin, Buffer.from([0x61, 0x00, 0x62]))
  assert.equal((await call({ sessionId: 's1', path: bin, offset: 0, length: 1024 })).body.kind, 'binary')

  // The UTF-8 trimmer keeps complete bytes only.
  assert.equal(__test.utf8CompleteLength(Buffer.from('ab中', 'utf8').subarray(0, 3)), 2)
  assert.equal(__test.utf8CompleteLength(Buffer.from('ab中', 'utf8')), 5)
  assert.equal(__test.utf8CompleteLength(Buffer.alloc(0)), 0)
})
