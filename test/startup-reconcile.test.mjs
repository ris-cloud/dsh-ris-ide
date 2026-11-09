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

let root
let home
let gitConfig

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
  const result = await reconcileStartupLeftovers()
  assert.equal(result.ok, true)
  assert.deepEqual(result.notes, [])
})

test('a git entry from a dead engine is removed (it is ours)', async () => {
  const key = 'http.https://git.example.com/.proxy'
  const value = 'socks5h://10.0.0.1:1080'
  writeGitState({ key, host: 'git.example.com', value })
  git(['config', '--global', key, value])
  const result = await reconcileStartupLeftovers()
  assert.ok(result.notes.some((note) => /git 代理/.test(note)), result.notes.join('; '))
  assert.equal(gitGet(key), '')
  assert.equal(existsSync(join(home, 'git-proxy.json')), false, 'state file is gone')
})

test('a foreign git value is left alone', async () => {
  const key = 'http.https://other.example.com/.proxy'
  writeGitState({ key, host: 'other.example.com', value: 'socks5h://10.0.0.1:1080' })
  git(['config', '--global', key, 'http://corp-proxy:3128'])
  const result = await reconcileStartupLeftovers()
  assert.ok(result.notes.some((note) => /保留了/.test(note)), result.notes.join('; '))
  assert.equal(gitGet(key), 'http://corp-proxy:3128')
})

test('a stale pidfile and a dead risd.json are cleared', async () => {
  writeFileSync(join(home, 'proxy.pid'), '999999\n', 'utf8')
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({ pid: 999999, port: 1, token: 'x', apiVersion: 1 })}\n`, 'utf8')
  const result = await reconcileStartupLeftovers()
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
  const result = await reconcileStartupLeftovers()
  assert.ok(result.notes.some((note) => /ProxyBridgeSvc/.test(note)), result.notes.join('; '))
  assert.equal(existsSync(join(dir, 'proxybridge-service.json')), false, 'service state cleared')
})

test('the git config file is only touched for our own entries', () => {
  const text = readFileSync(gitConfig, 'utf8')
  assert.doesNotMatch(text, /git\.example\.com/)
})
