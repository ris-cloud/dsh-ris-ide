// Daemon-side log follow: SSE frames with byte offsets, so a reconnecting panel can
// resume without replaying the whole file. Rotation/truncation restarts at 0 with a
// `reset` frame; a stopped program drains and then ends.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { sleep, startRisdProcess } from './risd-helpers.mjs'
import { startLogFollow } from '../lib/risd/programs.js'

let daemon
let workspace
let logPath

function openStream(params, { token } = {}) {
  const query = new URLSearchParams({ cwd: workspace, id: 'demo', ...params })
  const events = []
  const waiters = []
  const req = request({
    host: '127.0.0.1',
    port: daemon.state.port,
    path: `/v1/programs/log/stream?${query.toString()}`,
    method: 'GET',
    headers: token === undefined
      ? {}
      : { authorization: `Bearer ${token}`, 'x-risd-api-version': '1', accept: 'text/event-stream' },
  }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = {}
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event.type = line.slice(6).trim()
          else if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5).trim())
        }
        if (event.type !== undefined && event.type !== 'ping') {
          events.push(event)
          for (const waiter of [...waiters]) {
            if (waiter.predicate(event)) {
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(event)
            }
          }
        }
        index = buffer.indexOf('\n\n')
      }
    })
    res.on('end', () => { for (const waiter of waiters.splice(0)) waiter.reject(new Error('stream ended')) })
  })
  req.on('error', () => {})
  req.end()
  return {
    events,
    status: null,
    waitFor(predicate, timeoutMs = 6000) {
      const existing = events.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) { waiters.splice(index, 1); reject(new Error(`timeout; events=${JSON.stringify(events)}`)) }
        }, timeoutMs).unref?.()
      })
    },
    close() { req.destroy() },
  }
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'risd-log-follow-'))
  mkdirSync(join(workspace, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    programs: [{
      id: 'demo',
      name: 'demo',
      kind: 'custom',
      dir: workspace,
      logName: 'demo',
      startCommand: 'true',
    }],
  })}\n`, 'utf8')
  logPath = join(workspace, 'logs', 'demo.log')
  mkdirSync(join(workspace, 'logs'), { recursive: true })
  daemon = await startRisdProcess({ port: 0 })
})

after(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
})

test('the stream starts with the tail and then follows appended bytes by offset', async () => {
  writeFileSync(logPath, 'first line\n', 'utf8')
  const stream = openStream({}, { token: daemon.state.token })
  const first = await stream.waitFor((event) => event.type === 'log')
  assert.match(first.data.text, /first line/)
  const offset = first.data.nextOffset
  assert.ok(offset >= 'first line\n'.length)
  appendFileSync(logPath, 'second line\n', 'utf8')
  const second = await stream.waitFor((event) => event.type === 'log' && event.data.offset === offset)
  assert.equal(second.data.text, 'second line\n')
  assert.ok(second.data.nextOffset > offset)
  stream.close()
})

test('passing an offset resumes without replaying older bytes', async () => {
  writeFileSync(logPath, 'a\n', 'utf8')
  const stream = openStream({ offset: '2' }, { token: daemon.state.token })
  appendFileSync(logPath, 'b\n', 'utf8')
  const frame = await stream.waitFor((event) => event.type === 'log')
  assert.equal(frame.data.text, 'b\n')
  assert.equal(frame.data.offset, 2)
  stream.close()
})

test('truncation restarts the follower with a reset frame', async () => {
  writeFileSync(logPath, 'longer content here\n', 'utf8')
  const stream = openStream({}, { token: daemon.state.token })
  await stream.waitFor((event) => event.type === 'log')
  writeFileSync(logPath, 'x\n', 'utf8')
  const reset = await stream.waitFor((event) => event.type === 'reset')
  assert.equal(reset.data.offset, 0)
  assert.equal(reset.data.text, 'x\n')
  stream.close()
})

test('a stopped program ends the stream after the grace window', async () => {
  writeFileSync(logPath, 'done\n', 'utf8')
  const stream = openStream({}, { token: daemon.state.token })
  await stream.waitFor((event) => event.type === 'log')
  const end = await stream.waitFor((event) => event.type === 'end', 8000)
  assert.equal(end.data.reason, 'stopped')
  stream.close()
})

test('the stream requires the token and API version', async () => {
  const res = await new Promise((resolve) => {
    const query = new URLSearchParams({ cwd: workspace, id: 'demo' })
    const req = request({
      host: '127.0.0.1', port: daemon.state.port, path: `/v1/programs/log/stream?${query.toString()}`, method: 'GET',
    }, (response) => {
      response.resume()
      response.on('end', () => resolve({ status: response.statusCode }))
    })
    req.on('error', () => resolve({ status: 0 }))
    req.end()
  })
  assert.equal(res.status, 401)
})

test('an offset past EOF says reset instead of replaying the tail', async () => {
  writeFileSync(logPath, 'tiny\n', 'utf8')
  const stream = openStream({ offset: '9999' }, { token: daemon.state.token })
  const reset = await stream.waitFor((event) => event.type === 'reset')
  assert.equal(reset.data.offset, 0)
  assert.equal(reset.data.text, 'tiny\n')
  assert.equal(reset.data.nextOffset, 'tiny\n'.length)
  stream.close()
})

test('a same-size rotation is a reset, not silence', async () => {
  writeFileSync(logPath, '0123456789\n', 'utf8')
  const stream = openStream({}, { token: daemon.state.token })
  await stream.waitFor((event) => event.type === 'log')
  const rotated = `${logPath}.rotated`
  writeFileSync(rotated, 'abcdefghij\n', 'utf8') // same byte length, different inode
  renameSync(rotated, logPath)
  const reset = await stream.waitFor((event) => event.type === 'reset', 4000)
  assert.equal(reset.data.text, 'abcdefghij\n')
  stream.close()
})

test('a slow alive check never overlaps the next tick', async () => {
  writeFileSync(logPath, '', 'utf8')
  let inFlight = 0
  let peak = 0
  const follow = startLogFollow({ logPath, running: { alive: false } }, {
    intervalMs: 20,
    stoppedGraceMs: 10_000,
    alive: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(60)
      inFlight -= 1
      return true
    },
  }, () => {})
  await sleep(300)
  follow.stop()
  assert.equal(peak, 1, 'ticks are chained, so alive checks never run concurrently')
})

test('the wrapper pid keeps the follower alive while the service pid is gone', async () => {
  const dead = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  await new Promise((resolve) => dead.once('spawn', resolve))
  dead.kill('SIGKILL')
  await new Promise((resolve) => dead.once('exit', resolve))
  const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  await new Promise((resolve) => wrapper.once('spawn', resolve))
  const pidPath = `${logPath}.pid`
  writeFileSync(pidPath, `${dead.pid} ${wrapper.pid} ${Date.now()}\n`, 'utf8')
  try {
    writeFileSync(logPath, 'shutdown in progress\n', 'utf8')
    const stream = openStream({}, { token: daemon.state.token })
    await stream.waitFor((event) => event.type === 'log')
    await sleep(700)
    assert.equal(stream.events.some((event) => event.type === 'end'), false, 'not ended while the wrapper drains')
    wrapper.kill('SIGKILL')
    const end = await stream.waitFor((event) => event.type === 'end', 8000)
    assert.equal(end.data.reason, 'stopped')
    stream.close()
  } finally {
    try { wrapper.kill('SIGKILL') } catch { /* already gone */ }
    rmSync(pidPath, { force: true })
  }
})
