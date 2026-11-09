/**
 * Shared helpers for the risd tests (not a test file: the npm glob only picks
 * up `test/*.test.mjs`).
 *
 * Every test gets its own `DSH_RIS_IDE_PROXY_HOME`-style home under the OS temp
 * dir, so the machine-level `~/.dsh-ris-ide` is never read or written.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRisdState } from '../lib/risd/state.js'

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
    if (state !== null) {
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
