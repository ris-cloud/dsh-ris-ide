// Daemon-side program supervisor: the panel rows, start/stop, and offset-based log reads.
// The rows are the same ones the plugin renders (one discovery pipeline), so a program
// started here keeps running after dsh exits and is visible from another dsh.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { api, sleep, startRisdProcess } from './risd-helpers.mjs'
import { HAS_BASH, skipWithout } from './helpers/cmd.mjs'

let daemon
let workspace

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'risd-programs-ws-'))
  mkdirSync(join(workspace, '.dsh-ris-ide'), { recursive: true })
  // A custom row keeps the test independent of npm/maven: exactly the shape the panel
  // writes for a command it does not discover by itself.
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
      stopGraceMs: 3000,
    }],
  }, null, 2)}\n`, 'utf8')
  daemon = await startRisdProcess({ port: 0 })
})

after(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
})

test('GET /v1/programs lists the panel rows from the daemon', async () => {
  const res = await api(daemon.state, `/v1/programs?cwd=${encodeURIComponent(workspace)}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  const demo = res.body.programs.find((row) => row.id === 'demo')
  assert.ok(demo !== undefined, 'custom row is present')
  assert.equal(demo.logName, 'demo')
  assert.equal(res.body.dir, join(workspace, 'logs'))
})

test('start, stop and restart a program from the daemon', { skip: skipWithout(HAS_BASH, 'bash') }, async () => {
  const started = await api(daemon.state, '/v1/programs', { method: 'POST', body: { cwd: workspace, action: 'start', id: 'demo' } })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.ok(Number.isInteger(started.body.pid), 'a pid came back')
  await sleep(300)
  const listed = await api(daemon.state, `/v1/programs?cwd=${encodeURIComponent(workspace)}`)
  const demo = listed.body.programs.find((row) => row.id === 'demo')
  assert.equal(demo.running.alive, true)
  assert.equal(existsSync(demo.logPath), true)

  const restarted = await api(daemon.state, '/v1/programs', { method: 'POST', body: { cwd: workspace, action: 'restart', id: 'demo' } })
  assert.equal(restarted.status, 200)
  assert.equal(restarted.body.ok, true)
  assert.equal(restarted.body.stopped?.stopped, true)

  const stopped = await api(daemon.state, '/v1/programs', { method: 'POST', body: { cwd: workspace, action: 'stop', id: 'demo' } })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.ok, true)
  const afterStop = await api(daemon.state, `/v1/programs?cwd=${encodeURIComponent(workspace)}`)
  const stoppedRow = afterStop.body.programs.find((row) => row.id === 'demo')
  assert.ok(stoppedRow !== undefined, 'row still listed after stop')
  assert.ok(!stoppedRow.running?.alive, 'not running after stop')
})

test('log reads page by byte offset for a follower', async () => {
  const logPath = join(workspace, 'logs', 'demo.log')
  mkdirSync(join(workspace, 'logs'), { recursive: true })
  writeFileSync(logPath, 'first line\n', 'utf8')
  const first = await api(daemon.state, `/v1/programs/log?cwd=${encodeURIComponent(workspace)}&id=demo`)
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.match(first.body.text, /first line/)
  const offset = first.body.nextOffset
  appendFileSync(logPath, 'second line\n', 'utf8')
  const follow = await api(daemon.state, `/v1/programs/log?cwd=${encodeURIComponent(workspace)}&id=demo&offset=${offset}`)
  assert.equal(follow.status, 200)
  assert.equal(follow.body.text, 'second line\n')
  assert.ok(follow.body.nextOffset > offset)
})

test('an unknown program is a 404 with a readable message', { skip: skipWithout(HAS_BASH, 'bash') }, async () => {
  const res = await api(daemon.state, '/v1/programs', { method: 'POST', body: { cwd: workspace, action: 'start', id: 'nope' } })
  assert.equal(res.status, 404)
  assert.equal(res.body.ok, false)
  assert.match(String(res.body.message), /nope/)
})

test('a log read past EOF carries reset so the caller replaces the tail', async () => {
  const logPath = join(workspace, 'logs', 'demo.log')
  mkdirSync(join(workspace, 'logs'), { recursive: true })
  writeFileSync(logPath, 'small\n', 'utf8')
  const res = await api(daemon.state, `/v1/programs/log?cwd=${encodeURIComponent(workspace)}&id=demo&offset=9999`)
  assert.equal(res.status, 200)
  assert.equal(res.body.reset, true)
  assert.equal(res.body.text, 'small\n')
})

test('a name shared by two rows is a 409 instead of the first row', async () => {
  const configPath = join(workspace, '.dsh-ris-ide', 'config.json')
  const original = readFileSync(configPath, 'utf8')
  try {
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      defaults: {},
      programs: [
        { id: 'dup-a', name: 'dup', kind: 'custom', dir: workspace, relDir: '.', project: '', logName: 'dup-a', startCommand: 'true' },
        { id: 'dup-b', name: 'dup', kind: 'custom', dir: workspace, relDir: '.', project: '', logName: 'dup-b', startCommand: 'true' },
        { id: 'demo', name: 'demo', kind: 'custom', dir: workspace, relDir: '.', project: '', logName: 'demo', startCommand: 'true' },
      ],
    })}\n`, 'utf8')
    const ambiguous = await api(daemon.state, '/v1/programs', { method: 'POST', body: { cwd: workspace, action: 'start', id: 'dup' } })
    assert.equal(ambiguous.status, 409)
    assert.equal(ambiguous.body.code, 'ambiguous')
    assert.match(String(ambiguous.body.message), /dup-a/)
    assert.match(String(ambiguous.body.message), /dup-b/)
    // The id still resolves, so a disambiguated caller keeps working.
    const logPath = join(workspace, 'logs', 'dup-a.log')
    mkdirSync(join(workspace, 'logs'), { recursive: true })
    writeFileSync(logPath, 'a\n', 'utf8')
    const log = await api(daemon.state, `/v1/programs/log?cwd=${encodeURIComponent(workspace)}&id=dup-a`)
    assert.equal(log.status, 200)
    assert.equal(log.body.text, 'a\n')
  } finally {
    writeFileSync(configPath, original, 'utf8')
  }
})
