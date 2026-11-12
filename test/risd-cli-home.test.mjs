/**
 * `risd serve` without `--home` must use the machine home, not `<cwd>/undefined`.
 *
 * Node coerces an assignment of `undefined` to `process.env.X` into the STRING
 * "undefined"; the CLI used to do that before resolving the default, so every
 * machine-level file (risd.json, token, heartbeat, git state) landed under
 * `<cwd>/undefined/`. The plugin then never found the daemon, the port stayed
 * taken by a ghost and `risd stop` could not reach it (review A-P0-1).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { readRisdState } from '../lib/risd/state.js'

/**
 * SIGTERM, wait until the process is really gone, then remove the temp trees.
 *
 * Deleting straight after `kill` raced the daemon: it kept writing its heartbeat
 * and pid files into `home` while the collector walked the tree, and CI failed in
 * the `after` hook with `EACCES: Directory not empty` (m05845). Waiting for the
 * exit removes the writer; the bounded retry absorbs a last flush already queued.
 * @param {import('node:child_process').ChildProcess} child the daemon we started.
 * @param {string[]} dirs temp trees to delete.
 */
async function stopAndClean(child, dirs) {
  const gone = () => child.exitCode === null && child.signalCode === null
  if (gone()) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    await Promise.race([exited, sleep(5000)])
  }
  if (gone()) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    await Promise.race([exited, sleep(2000)])
  }
  for (const dir of dirs) {
    let lastError = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        lastError = null
        break
      } catch (error) {
        lastError = error
        await sleep(50)
      }
    }
    if (lastError !== null) throw lastError
  }
}

const CLI = new URL('../bin/risd.mjs', import.meta.url).pathname

test('a CLI run without --home resolves the machine home from the environment', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'risd-cli-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'risd-cli-cwd-'))
  const child = spawn(process.execPath, [CLI, 'serve'], {
    cwd,
    env: Object.assign({}, process.env, { DSH_RIS_IDE_PROXY_HOME: home, DSH_RISD_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    await stopAndClean(child, [home, cwd])
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const state = readRisdState(home)
      if (state !== null) { clearInterval(timer); resolve(state) }
    }, 100)
    timer.unref()
    child.once('exit', () => { clearInterval(timer); resolve(null) })
    setTimeout(() => { clearInterval(timer); resolve(null) }, 8000).unref()
  })
  assert.notEqual(started, null, `risd serve did not start: ${stderr}`)
  assert.equal(started.home, home)
  // The regression: the state was written under the cwd because the env var
  // became the literal string "undefined".
  assert.equal(existsSync(join(cwd, 'undefined')), false)
})
