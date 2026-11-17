/**
 * An engine left behind by a previous dsh process (the Ctrl+C leak under the old
 * teardown) must be adopted and reported as inherited, not ignored or duplicated.
 *
 * A live janitor means the machine already has an owner for that engine (another
 * dsh, or a watcher about to clean up after a crash) — that engine must NOT be
 * claimed as ours.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'ris-inherit-'))
const workspace = mkdtempSync(join(tmpdir(), 'ris-inherit-ws-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { __test } = await import('../lib/index.js')
const { proxyPid, proxyPidPath } = await import('../lib/proxy.js')
const { janitorStatePath, disarmJanitor } = await import('../lib/janitor.js')

const PROXY = fileURLToPath(new URL('../lib/proxy.js', import.meta.url))
const MARKER = 'dsh-ris-ide-proxy'
/** @type {import('node:child_process').ChildProcess | null} */
let engine = null

/** @returns {Promise<number>} a port the OS says is free right now. */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Resolve once something accepts a TCP connection on the port.
 * @param {number} port the port to probe.
 * @param {{attempts?: number, interval?: number}} [options] budget.
 * @returns {Promise<boolean>} whether the port accepted a connection.
 */
function waitForPort(port, { attempts = 60, interval = 100 } = {}) {
  return new Promise((resolve) => {
    let tries = 0
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => {
        socket.destroy()
        tries += 1
        if (tries >= attempts) resolve(false)
        else setTimeout(attempt, interval)
      })
    }
    attempt()
  })
}

/**
 * Poll a predicate until it holds (or the attempts run out).
 * @param {() => boolean} predicate the condition.
 * @param {{attempts?: number, interval?: number}} [options] budget.
 * @returns {Promise<boolean>} whether it held.
 */
function waitFor(predicate, { attempts = 120, interval = 100 } = {}) {
  return new Promise((resolve) => {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
      } else if (tries >= attempts) {
        clearInterval(timer)
        resolve(false)
      }
    }, interval)
  })
}

/**
 * Spawn a detached engine exactly the way startProxy does, and publish its pidfile.
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number}>} the child and its port.
 */
async function spawnOrphanEngine() {
  const port = await freePort()
  writeFileSync(join(home, 'proxy.json'), JSON.stringify({
    listenPort: port,
    socks: { host: '10.3.91.121', port: 1080 },
    rules: [],
    shadows: [],
  }))
  const child = spawn(process.execPath, [PROXY, '--cwd', workspace, 'serve', `--marker=${MARKER}`], {
    detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.unref()
  writeFileSync(proxyPidPath(), String(child.pid))
  return { child, port }
}

/**
 * Kill a spawned engine (SIGTERM is enough; it exits within the poll budget).
 * @param {import('node:child_process').ChildProcess} child the engine.
 * @returns {Promise<void>} settles when it is gone.
 */
async function killEngine(child) {
  if (child.exitCode === null) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    await waitFor(() => child.exitCode !== null, { attempts: 50, interval: 100 })
  }
}

after(async () => {
  if (engine !== null) await killEngine(engine)
  disarmJanitor()
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

test('an engine with no watcher is adopted and shown as inherited', async () => {
  // The pre-fix crash path: process.exit() killed dsh, the detached engine kept
  // running, and no janitor state survived to name its owner.
  rmSync(janitorStatePath(), { force: true })
  const spawned = await spawnOrphanEngine()
  engine = spawned.child
  const ready = await waitForPort(spawned.port)
  assert.equal(ready, true, 'the engine should start listening in the temp home')
  assert.equal(await waitFor(() => proxyPid() === engine.pid), true, 'the pidfile must identify the engine')

  const adopted = __test.adoptLeftoverEngine()
  assert.notEqual(adopted, null, 'an engine with no watcher must be adopted')
  assert.equal(adopted.pid, engine.pid)

  const view = await __test.proxyView(workspace)
  assert.equal(view.running, true, 'the adopted engine is the running one')
  assert.equal(view.inherited, true, 'the dialog must mark it as inherited')
  assert.equal(view.inheritedPid, engine.pid)
  assert.equal(view.inheritedFrom, 0, 'no watcher state means the old dsh pid is unknown')
  assert.equal(view.owner, 0, 'nothing owns it before this process arms the watcher')
})

test('the banner disappears once the adopted engine is gone', async () => {
  assert.notEqual(engine, null)
  await killEngine(engine)
  rmSync(proxyPidPath(), { force: true })
  assert.equal(__test.adoptLeftoverEngine(), null, 'a dead engine is nothing to inherit')
  const view = await __test.proxyView(workspace)
  assert.equal(view.inherited, false)
})

test('a live watcher means the engine has an owner and must not be claimed', async () => {
  const spawned = await spawnOrphanEngine()
  engine = spawned.child
  assert.equal(await waitForPort(spawned.port), true, 'the engine should start listening')
  assert.equal(await waitFor(() => proxyPid() === engine.pid), true, 'the pidfile must identify the engine')
  // A watcher exists and is alive, but it watches a dead dsh: this is the
  // crash-in-progress case — the engine is about to be cleaned up, not ours.
  writeFileSync(janitorStatePath(), JSON.stringify({
    // The watcher pid must be a live process that is NOT us: disarmJanitor() in the
    // teardown would SIGTERM its own test runner otherwise.
    pid: engine.pid,
    owner: 999999,
    log: join(home, 'janitor.log'),
  }))
  assert.equal(__test.adoptLeftoverEngine(), null, 'a live watcher is not ours to take over')
  const view = await __test.proxyView(workspace)
  assert.equal(view.inherited, false, 'the dialog must not claim an engine another watcher owns')
  rmSync(janitorStatePath(), { force: true })
})
