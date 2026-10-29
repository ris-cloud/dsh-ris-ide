/**
 * Host-half tests: workspace CONTENT search (`git grep` + the no-git
 * filesystem fallback) and the single-module `mvn test` runner, plus the
 * `restart: true` path of the existing start route.
 *
 * Like host-tail.test.mjs these run without a DSH profile: the route handler is
 * a plain function of `(ctx, req, res, options)`, so a fake ctx with a session
 * header and a real listener exercise exactly what the browser hits. No real
 * Maven is needed — the spawn tests put a tiny `mvn` shim on PATH (the runner
 * resolves its executable through PATH at call time).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __test } from '../lib/index.js'

const {
  handleRequest, searchWorkspaceContent,
  CONTENT_SEARCH_PATH, RUN_TEST_PATH, START_PATH, STOP_PATH, PROGRAMS_PATH,
  runTestOutput, RUN_TEST_HEAD_CHARS, RUN_TEST_TAIL_CHARS, RUN_TEST_MAX_RECORDS,
  HARD_MAX_BYTES, PID_SUFFIX, IS_WINDOWS,
} = __test

/** One scratch directory per test process, removed when the file is done. */
const scratch = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-search-'))
after(async () => { await rm(scratch, { recursive: true, force: true }) })

/**
 * Jenkins/CI 的 `bash -lc`（被测服务的启动命令就是它）会读登录 profile，可能把
 * agent 注入的 PATH 重置掉，导致服务里的 `npm`/`node` 变成 not found（status 127）。
 * 非交互 bash 会在 profile 之后读取 `BASH_ENV`，用它把当前可用的 PATH 再补回去。
 */
const ciBashEnv = join(scratch, 'ci-bash-env.sh')
await writeFile(ciBashEnv, `export PATH="${String(process.env.PATH || '')}"\n`)
process.env.BASH_ENV = ciBashEnv

/** Start all routes on a real listener with a fake session store. */
async function withServer(run, rootCwd, options = { maxBytes: HARD_MAX_BYTES, restrictToCwd: false, stopGraceMs: 5000, minFreeMemoryBytes: 1 }) {
  const cwd = rootCwd ?? await mkdtemp(join(scratch, 'server-'))
  const ctx = { sessions: { get: (id) => (id === 's1' ? { header: { cwd } } : undefined) } }
  const server = createServer((req, res) => { handleRequest(ctx, req, res, options) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run({ base, cwd })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** One JSON POST. */
function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Poll one predicate until it holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** A git repo in a scratch dir with a couple of matchable files (index only). */
async function makeRepoFixture(label) {
  const root = await mkdtemp(join(scratch, `${label}-`))
  await writeFile(join(root, 'a.txt'), 'alpha\nbeta\nneedle one\nneedle two\nneedle three\n')
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub', 'b.txt'), 'x needle deep\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

// ── Content search helper ───────────────────────────────────────────────────

test('searchWorkspaceContent returns literal git-grep hits with absolute path, line and text', async () => {
  const root = await makeRepoFixture('content')
  const { hits, truncated, roots, files } = await searchWorkspaceContent(root, 'needle', 300, 8)
  assert.deepEqual(roots, [root])
  assert.equal(truncated, false)
  assert.equal(files, 2, 'distinct files that matched')
  assert.deepEqual(hits, [
    { path: join(root, 'a.txt'), line: 3, text: 'needle one' },
    { path: join(root, 'a.txt'), line: 4, text: 'needle two' },
    { path: join(root, 'a.txt'), line: 5, text: 'needle three' },
    { path: join(root, 'sub', 'b.txt'), line: 1, text: 'x needle deep' },
  ])
  // git grep is literal (-F): a regex metacharacter must not widen the search.
  const regexHit = await searchWorkspaceContent(root, 'need.*one', 300, 8)
  assert.deepEqual(regexHit.hits, [])
})

test('searchWorkspaceContent honours perFile and answers an empty hit list for no match', async () => {
  const root = await makeRepoFixture('cap')
  const capped = await searchWorkspaceContent(root, 'needle', 300, 2)
  const fromA = capped.hits.filter((hit) => hit.path === join(root, 'a.txt'))
  assert.equal(fromA.length, 2, 'perFile caps the matches taken from one file')

  const none = await searchWorkspaceContent(root, 'zzz-not-here', 300, 8)
  assert.deepEqual(none.hits, [])
  assert.equal(none.truncated, false)
  assert.equal(none.files, 0)
})

test('searchWorkspaceContent falls back to a case-insensitive walk without a git repo', async () => {
  const root = await mkdtemp(join(scratch, 'nogit-'))
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'nested', 'notes.md'), 'first line\nA Fallback Needle lives here\n')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]))
  const { hits, roots } = await searchWorkspaceContent(root, 'fallback needle', 300, 8)
  // /tmp (or wherever the scratch dir lives) carries no .git anywhere above it.
  assert.deepEqual(roots, [], 'no repo, so the walk is the only option')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, join(root, 'nested', 'notes.md'))
  assert.equal(hits[0].line, 2)
  assert.equal(hits[0].text, 'A Fallback Needle lives here')
})

// ── Content search route ────────────────────────────────────────────────────

test('GET /search-content serves hits and rejects a missing q or the wrong method', async () => {
  const root = await makeRepoFixture('content-route')
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}${CONTENT_SEARCH_PATH}?sessionId=s1&q=needle&perFile=2&limit=50`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.root, root)
    assert.equal(body.hits.length, 3, 'perFile=2 from a.txt, plus one from sub/b.txt')
    assert.deepEqual(body.hits[0], { path: join(root, 'a.txt'), line: 3, text: 'needle one' })
    assert.equal(body.truncated, false)
    assert.deepEqual(body.roots, [root])
    assert.equal(typeof body.files, 'number')

    const empty = await fetch(`${base}${CONTENT_SEARCH_PATH}?sessionId=s1&q=${encodeURIComponent('   ')}`)
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).code, 'bad-request')

    const noSession = await fetch(`${base}${CONTENT_SEARCH_PATH}?q=needle`)
    assert.equal(noSession.status, 400)

    const wrongMethod = await postJson(base, CONTENT_SEARCH_PATH, { sessionId: 's1', q: 'needle' })
    assert.equal(wrongMethod.status, 405)
  }, root)
})

// ── Run-test route: validation ──────────────────────────────────────────────

/** A cwd holding one real Maven module (`mod/pom.xml`). */
async function makeMavenFixture(label) {
  const root = await mkdtemp(join(scratch, `${label}-`))
  await mkdir(join(root, 'mod'), { recursive: true })
  await writeFile(join(root, 'mod', 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>\n')
  return root
}

test('POST /run-test validates sessionId, module containment and the -Dtest selector', async () => {
  const root = await makeMavenFixture('run-test-args')
  await withServer(async ({ base }) => {
    const noSession = await postJson(base, RUN_TEST_PATH, { module: 'mod', test: 'Demo' })
    assert.equal(noSession.status, 400)

    // No pom.xml under that directory: a clear 404, not a spawn.
    const unknown = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'nope', test: 'Demo' })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).code, 'unknown-module')

    // `..` never escapes the session cwd; absolute module paths are refused too.
    const escape = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: '../mod', test: 'Demo' })
    assert.equal(escape.status, 400)
    assert.equal((await escape.json()).code, 'bad-request')

    const absolute = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: join(root, 'mod'), test: 'Demo' })
    assert.equal(absolute.status, 400)

    // A selector that is not a plain Maven name is refused before any spawn.
    const metacharacters = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'mod', test: 'Demo; rm -rf /' })
    assert.equal(metacharacters.status, 400)
    assert.equal((await metacharacters.json()).code, 'bad-request')

    const missingTest = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'mod' })
    assert.equal(missingTest.status, 400)

    // Status: unknown / missing id are clear errors, other methods a 405.
    const unknownId = await fetch(`${base}${RUN_TEST_PATH}?sessionId=s1&id=rt-nope`)
    assert.equal(unknownId.status, 404)
    assert.equal((await unknownId.json()).code, 'not-found')
    const noId = await fetch(`${base}${RUN_TEST_PATH}?sessionId=s1`)
    assert.equal(noId.status, 400)
    const wrongMethod = await fetch(`${base}${RUN_TEST_PATH}`, { method: 'DELETE' })
    assert.equal(wrongMethod.status, 405)
  }, root)
})

// ── Run-test route: spawning (a `mvn` shim on PATH, no real Maven) ──────────

/** A directory holding an executable `mvn` shell script. */
async function makeMvnShim(label, script) {
  const dir = await mkdtemp(join(scratch, `${label}-`))
  const file = join(dir, 'mvn')
  await writeFile(file, `#!/bin/sh\n${script}\n`)
  await chmod(file, 0o755)
  return dir
}

/** Run `fn` with `prepend` first on PATH, restoring the original PATH after. */
async function withPath(prepend, fn) {
  const original = process.env.PATH
  process.env.PATH = `${prepend}:${original ?? ''}`
  try {
    return await fn()
  } finally {
    process.env.PATH = original
  }
}

/** Run `fn` with PATH replaced entirely (so no `mvn` can be found). */
async function withPathOnly(dir, fn) {
  const original = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    process.env.PATH = original
  }
}

/** Poll one run to its terminal state. */
async function waitForRun(base, id) {
  let body
  const settled = await waitFor(async () => {
    const response = await fetch(`${base}${RUN_TEST_PATH}?sessionId=s1&id=${encodeURIComponent(id)}`)
    assert.equal(response.status, 200)
    body = await response.json()
    return body.running === false
  }, 15000)
  assert.ok(settled, `run ${id} did not finish: ${JSON.stringify(body)}`)
  return body
}

test('POST /run-test spawns mvn and the status poll reports interleaved output', { skip: IS_WINDOWS }, async () => {
  const root = await makeMavenFixture('run-test-spawn')
  const shim = await makeMvnShim('mvn-ok', [
    'echo "STDOUT-ARGS:$*"',
    'echo "STDERR-LINE" 1>&2',
    'echo "STDOUT-LINE"',
    'exit 0',
  ].join('\n'))
  await withPath(shim, async () => {
    await withServer(async ({ base }) => {
      const response = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'mod', test: 'Demo#case1' })
      assert.equal(response.status, 200)
      const started = await response.json()
      assert.equal(started.ok, true)
      assert.match(started.id, /^rt-/)
      assert.equal(typeof started.startedAt, 'number')
      assert.equal(started.command,
        "mvn -Pdev -q -pl mod test '-Dtest=Demo#case1' -DfailIfNoTests=false -DskipITs")

      const finished = await waitForRun(base, started.id)
      assert.equal(finished.status, 'done')
      assert.equal(finished.exitCode, 0)
      assert.equal(finished.running, false)
      assert.equal(typeof finished.durationMs, 'number')
      assert.match(finished.output, /STDOUT-ARGS:-Pdev -q -pl mod test -Dtest=Demo#case1 -DfailIfNoTests=false -DskipITs/)
      assert.match(finished.output, /STDERR-LINE/, 'stderr is folded into the same console')
      assert.match(finished.output, /STDOUT-LINE/)

      // The profile override reaches the command line.
      const custom = await (await postJson(base, RUN_TEST_PATH, {
        sessionId: 's1', module: 'mod', test: 'Demo', profile: 'ci',
      })).json()
      assert.equal((await waitForRun(base, custom.id)).exitCode, 0)
      assert.match(custom.command, /-Pci /)
    }, root)
  })
})

test('POST /run-test reports a failing run and a missing mvn without throwing', { skip: IS_WINDOWS }, async () => {
  const root = await makeMavenFixture('run-test-fail')
  const shim = await makeMvnShim('mvn-fail', ['echo "BUILD FAILURE" 1>&2', 'exit 3'].join('\n'))
  await withPath(shim, async () => {
    await withServer(async ({ base }) => {
      const started = await (await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'mod', test: 'Demo' })).json()
      const finished = await waitForRun(base, started.id)
      assert.equal(finished.status, 'failed')
      assert.equal(finished.exitCode, 3)
      assert.match(finished.output, /BUILD FAILURE/)
    }, root)
  })

  // No mvn anywhere on PATH: the route still answers, and the run reports why.
  const empty = await mkdtemp(join(scratch, 'empty-path-'))
  await withPathOnly(empty, async () => {
    await withServer(async ({ base }) => {
      const response = await postJson(base, RUN_TEST_PATH, { sessionId: 's1', module: 'mod', test: 'Demo' })
      assert.equal(response.status, 200)
      const started = await response.json()
      assert.match(started.id, /^rt-/)
      const finished = await waitForRun(base, started.id)
      assert.equal(finished.status, 'failed')
      assert.equal(finished.exitCode, null)
      assert.match(finished.output, /mvn not found on PATH/)
    }, root)
  })
})

test('runTestOutput keeps the head and the tail and marks the elided middle', () => {
  const record = {
    head: 'H'.repeat(RUN_TEST_HEAD_CHARS),
    tail: `${'M'.repeat(RUN_TEST_TAIL_CHARS - 4)}TAIL`,
    total: RUN_TEST_HEAD_CHARS + RUN_TEST_TAIL_CHARS + 1000,
  }
  const output = runTestOutput(record)
  assert.ok(output.startsWith('H'.repeat(RUN_TEST_HEAD_CHARS)))
  assert.ok(output.endsWith('TAIL'))
  assert.match(output, /^H+…\(省略 \d+ 字符\)…M+T/)
  // Short output is returned whole (no marker, no loss).
  assert.equal(runTestOutput({ head: 'short', tail: 'short', total: 5 }), 'short')
})

test('the run-test records are bounded', () => {
  assert.equal(RUN_TEST_MAX_RECORDS, 10)
  assert.equal(RUN_TEST_HEAD_CHARS, 4096)
  assert.equal(RUN_TEST_TAIL_CHARS, 400000)
})

// ── Start route: restart ────────────────────────────────────────────────────

/** A workspace holding one startable frontend program (a node ticker). */
async function makeStartableFixture() {
  const root = await mkdtemp(join(scratch, 'restart-'))
  const dir = join(root, 'ui')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'tick-app',
    scripts: { dev: 'node -e "process.on(\'SIGTERM\',()=>process.exit(0));setInterval(()=>{},1000)"' },
  }))
  return root
}

test('POST /start with restart:true stops the running instance before starting a fresh one', async () => {
  const root = await makeStartableFixture()
  await withServer(async ({ base }) => {
    const programs = (await (await fetch(`${base}${PROGRAMS_PATH}?sessionId=s1&refresh=1`)).json()).programs
    const program = programs.find((entry) => entry.kind === 'frontend')
    assert.ok(program !== undefined, 'the fixture frontend program is discovered')

    const first = await (await postJson(base, START_PATH, { sessionId: 's1', id: program.id })).json()
    assert.equal(first.alreadyRunning, false)
    assert.equal(first.program.running.alive, true)
    const logPath = first.program.logPath

    const restarted = await (await postJson(base, START_PATH, { sessionId: 's1', id: program.id, restart: true })).json()
    assert.equal(restarted.ok, true)
    assert.equal(restarted.restarted, true, 'the previous instance was running, so it was stopped first')
    assert.equal(restarted.program.running.alive, true, 'a fresh instance is up')
    assert.equal(restarted.program.logPath, logPath)
    assert.notEqual(restarted.program.running.pid, first.program.running.pid, 'a new process, not the old one')

    // Stop it, then restart the stopped row: nothing to stop, so `restarted` is false.
    const stopped = await (await postJson(base, STOP_PATH, { sessionId: 's1', path: logPath })).json()
    assert.equal(stopped.stopped, true)
    const fromStopped = await (await postJson(base, START_PATH, { sessionId: 's1', id: program.id, restart: true })).json()
    assert.equal(fromStopped.restarted, false)
    assert.equal(fromStopped.program.running.alive, true)
    assert.equal((await postJson(base, STOP_PATH, { sessionId: 's1', path: logPath })).status, 200)
    assert.equal(existsSync(`${logPath}${PID_SUFFIX}`), false, 'the pidfile is gone after the last stop')
  }, root)
})
