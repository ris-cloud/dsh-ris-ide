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
import { readRisdState } from '../lib/risd/state.js'

const CLI = new URL('../bin/risd.mjs', import.meta.url).pathname

test('a CLI run without --home resolves the machine home from the environment', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'risd-cli-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'risd-cli-cwd-'))
  const child = spawn(process.execPath, [CLI, 'serve'], {
    cwd,
    env: Object.assign({}, process.env, { DSH_RIS_IDE_PROXY_HOME: home, DSH_RISD_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    child.kill('SIGTERM')
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
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
