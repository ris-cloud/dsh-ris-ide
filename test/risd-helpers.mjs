/**
 * Shared helpers for the risd tests (not a test file: the npm glob only picks
 * up `test/*.test.mjs`).
 *
 * Every test gets its own `DSH_RIS_IDE_PROXY_HOME`-style home under the OS temp
 * dir, so the machine-level `~/.dsh-ris-ide` is never read or written.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { readRisdState, RISD_API_VERSION } from '../lib/risd/state.js'

export const RISD_BIN = fileURLToPath(new URL('../bin/risd.mjs', import.meta.url))

export function makeHome(prefix = 'risd-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeHome(home) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(home, { recursive: true, force: true })
      return
    } catch {
      /* daemon may still be closing its log/handles */
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(500) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/**
 * Spawn `risd serve` and wait until its state file exists and health answers.
 * @returns `{ child, home, state, lines, stop }` — `lines` is the collected stderr.
 */
export async function startRisdProcess({ home = makeHome(), port = 0, env = {} } = {}) {
  // The daemon applies the machine-level git proxy through `git config --global`,
  // which honours HOME/GIT_CONFIG_GLOBAL. Point both at the throwaway home unless
  // the caller says otherwise: a `/v1/action start` fixture with a git rule must
  // never edit the real ~/.gitconfig (found after a full-suite run wrote a
  // `git.example.com` entry into the developer's config).
  const isolated = {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    // Answer the two PowerShell probes with "nothing is running" (see
    // `probesStubbed` in lib/redirector.js): a cold `Get-Process` costs ~8 s on WSL
    // and the answer used to be whatever bridge was up on the developer's desktop,
    // so the save paths in these tests were slow AND order-dependent.
    DSH_RIS_IDE_STUB_PROBES: '1',
  }
  const child = spawn(process.execPath, [RISD_BIN, 'serve', '--home', home, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...isolated, ...env },
  })
  const lines = []
  child.stdout.on('data', (chunk) => lines.push(String(chunk)))
  child.stderr.on('data', (chunk) => lines.push(String(chunk)))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = readRisdState(home)
    // A handoff deliberately leaves the PREDECESSOR's note in place (same home,
    // same port, its token) until the successor rewrites it. Returning that note
    // hands the caller a dead daemon's token: health may answer (it is
    // unauthenticated) while every authenticated route replies 401 — a flake that
    // only shows up when the successor is slow to write its own note.
    if (state !== null && Number(state.pid) === child.pid) {
      const probe = await health(state.port)
      if (probe?.ok === true) {
        return { child, home, state, lines, stop: () => stopRisdProcess(child) }
      }
    }
    if (child.exitCode !== null) break
    await sleep(60)
  }
  child.kill('SIGKILL')
  throw new Error(`risd did not become ready; stderr:\n${lines.join('')}`)
}

/** Ask the child to exit, then hard-kill if it did not. */
export async function stopRisdProcess(child) {
  if (child.exitCode !== null) return child.exitCode
  child.kill('SIGTERM')
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return child.exitCode
    await sleep(40)
  }
  child.kill('SIGKILL')
  return null
}

/** Run the CLI once and capture `{ code, out, err }`. */
export function runRisdCli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RISD_BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

export { health }

// ---------------------------------------------------------------------------
// Engine fixtures (risd-engine / risd-handoff / risd-teardown had three copies).
// ---------------------------------------------------------------------------

/** A random high port, so parallel test files do not fight over the engine fixtures. */
export function pickPort() {
  return 20000 + Math.floor(Math.random() * 20000)
}

/**
 * Write the machine-level `proxy.json` an engine test starts from: one enabled java
 * rule and a dead SOCKS upstream. `workspace` is the row's owner (default: the home).
 */
export function writeEngineFixture(home, port, { workspace = home } = {}) {
  writeFileSync(join(home, 'proxy.json'), JSON.stringify({
    socks: { host: '127.0.0.1', port: 1, dbPort: 0, redisPort: 0 },
    listenPort: port,
    rules: [{
      id: 'rule-1',
      program: 'java',
      hosts: ['127.0.0.1'],
      ports: ['443'],
      enabled: true,
      shadow: false,
      source: 'user',
      workspace,
    }],
  }, null, 2))
}

/** Authorization headers for a daemon started by `startRisdProcess`. */
export function risdHeaders(state) {
  return { authorization: `Bearer ${state.token}`, 'x-risd-api-version': String(RISD_API_VERSION), 'content-type': 'application/json' }
}

/**
 * Poll `fn` until it returns true. 15 s by default: a teardown is 300 ms debounce +
 * the engine's 5 s grace + bridge/git attempts, which exceeds 8 s on a loaded machine.
 */
export async function waitFor(fn, timeoutMs = 15000, stepMs = 120) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return false
}

/** `kill(0)`: is the process still there? */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Fake bridge (risd-bridge-degrade / risd-host-p2 had two copies).
// ---------------------------------------------------------------------------

/** Minimal `ServerResponse` stand-in for the `serveProxy`/`serveProxyAction` tests. */
export function fakeRes() {
  return {
    status: 0,
    chunks: [],
    writeHead(status) { this.status = status },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

/** Minimal `IncomingMessage` (a Readable) for the same tests. */
export function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  return req
}

/**
 * The in-memory bridge `lib/index.js` hands to `__test.setRisdBridge`; `url: null`
 * means "the pointer was already dropped" (degraded, no daemon).
 */
export function risdBridge({ url = null, port = 9, token = 'token-x', leaseId = 'lease-x', degraded = false, warnedAt = 0, lastProbeAt = Date.now() } = {}) {
  return {
    mode: 'auto',
    state: url === null ? null : { url, token, apiVersion: RISD_API_VERSION, port },
    leaseId,
    pending: null,
    warnedAt,
    degraded,
    lastProbeAt,
  }
}

// ---------------------------------------------------------------------------
// JSON client (risd-programs / risd-shutdown had two copies of `api`).
// ---------------------------------------------------------------------------

/** One JSON request against a running daemon; transport errors land as `{status: 0}`. */
export function api(state, path, { method = 'GET', body } = {}) {
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
