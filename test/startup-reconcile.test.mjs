// Startup reconciliation: leftovers that no longer match today's rules/state.
// A reboot kills every process we started (engine, daemon, bridge) but NOT the two
// machine-level side effects — the scoped git entry and the parked ProxyBridgeSvc —
// so the next start must undo what is provably ours and leave everything else alone.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { reconcileStartupLeftovers } from '../lib/startup.js'
import { HAS_GIT, skipWithout } from './helpers/cmd.mjs'

let root
let home
let gitConfig

// The bridge probes are injected, never real: `redirectorStatusCached()` spawns
// PowerShell on WSL (seconds) and answers differently depending on whether the
// developer's own bridge is running, and `restoreWindowsService()` really runs
// `Set-Service`/`Start-Service`. A test that let both run was slow, flaky, and
// could restart the machine's ProxyBridgeSvc.
const idleBridge = { status: () => ({ running: false }), restore: () => ({ restored: false, reason: '未停止过服务' }) }

/** Reconcile with the bridge probes stubbed; `extra` overrides them per test. */
function reconcile(extra = {}) {
  return reconcileStartupLeftovers(Object.assign({}, idleBridge, extra))
}

function git(args) {
  const res = spawnSync('git', args, { encoding: 'utf8', env: process.env })
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

function gitGet(key) {
  const res = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', env: process.env })
  assert.ok(res.status === 0 || res.status === 1, `git --get ${key}: ${res.stderr}`)
  return res.status === 0 ? res.stdout.trim() : ''
}

function writeGitState(state) {
  writeFileSync(join(home, 'git-proxy.json'), `${JSON.stringify(state)}\n`, 'utf8')
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-ris-ide-startup-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  gitConfig = join(root, 'gitconfig')
  writeFileSync(gitConfig, '', 'utf8')
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.GIT_CONFIG_GLOBAL = gitConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

after(() => {
  delete process.env.DSH_RIS_IDE_PROXY_HOME
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_NOSYSTEM
  rmSync(root, { recursive: true, force: true })
})

test('a clean machine is a no-op', async () => {
  const result = await reconcile()
  assert.equal(result.ok, true)
  assert.deepEqual(result.notes, [])
})

test('a git entry from a dead engine is removed (it is ours)', { skip: skipWithout(HAS_GIT, 'git') }, async () => {
  const key = 'http.https://git.example.com/.proxy'
  const value = 'socks5h://10.0.0.1:1080'
  writeGitState({ key, host: 'git.example.com', value })
  git(['config', '--global', key, value])
  const result = await reconcile()
  assert.ok(result.notes.some((note) => /git 代理/.test(note)), result.notes.join('; '))
  assert.equal(gitGet(key), '')
  assert.equal(existsSync(join(home, 'git-proxy.json')), false, 'state file is gone')
})

test('a foreign git value is left alone', { skip: skipWithout(HAS_GIT, 'git') }, async () => {
  const key = 'http.https://other.example.com/.proxy'
  writeGitState({ key, host: 'other.example.com', value: 'socks5h://10.0.0.1:1080' })
  git(['config', '--global', key, 'http://corp-proxy:3128'])
  const result = await reconcile()
  assert.ok(result.notes.some((note) => /保留了/.test(note)), result.notes.join('; '))
  assert.equal(gitGet(key), 'http://corp-proxy:3128')
})

test('a stale pidfile and a dead risd.json are cleared', async () => {
  writeFileSync(join(home, 'proxy.pid'), '999999\n', 'utf8')
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({ pid: 999999, port: 1, token: 'x', apiVersion: 1 })}\n`, 'utf8')
  const result = await reconcile()
  assert.equal(existsSync(join(home, 'proxy.pid')), false, 'stale pidfile removed')
  assert.equal(existsSync(join(home, 'risd.json')), false, 'dead daemon state removed')
  assert.ok(result.notes.length >= 2, result.notes.join('; '))
})

test('a parked ProxyBridgeSvc is restored and its state cleared', async () => {
  const dir = join(home, 'proxybridge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'proxybridge-service.json'), `${JSON.stringify({
    at: Date.now(), stoppedByUs: true, originalStartType: 'Automatic', parkedOnManual: true,
  })}\n`, 'utf8')
  let restores = 0
  const result = await reconcile({ restore: () => { restores += 1; return { restored: true } } })
  assert.equal(restores, 1, 'a parked service is restored exactly once')
  assert.ok(result.notes.some((note) => /ProxyBridgeSvc/.test(note)), result.notes.join('; '))
  assert.equal(existsSync(join(dir, 'proxybridge-service.json')), false, 'service state cleared')
})

test('a parked service is left alone while the bridge is still running', async () => {
  // The restore only makes sense after a reboot: a bridge that is up right now owns
  // the service, and stopping it under the bridge would fight the driver for
  // WinDivert. This branch is why the same test used to pass or fail depending on
  // whether the developer's ProxyBridge happened to be running.
  const dir = join(home, 'proxybridge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'proxybridge-service.json'), `${JSON.stringify({
    at: Date.now(), stoppedByUs: true, originalStartType: 'Automatic', parkedOnManual: true,
  })}\n`, 'utf8')
  let restores = 0
  const result = await reconcile({
    status: () => ({ running: true }),
    restore: () => { restores += 1; return { restored: true } },
  })
  assert.equal(restores, 0, 'a running bridge keeps its service')
  assert.equal(result.notes.some((note) => /ProxyBridgeSvc/.test(note)), false, result.notes.join('; '))
  assert.equal(existsSync(join(dir, 'proxybridge-service.json')), true, 'state kept for the next start')
  rmSync(join(dir, 'proxybridge-service.json'), { force: true })
})

test('the git config file is only touched for our own entries', { skip: skipWithout(HAS_GIT, 'git') }, () => {
  const text = readFileSync(gitConfig, 'utf8')
  assert.doesNotMatch(text, /git\.example\.com/)
})
