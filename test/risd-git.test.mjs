/**
 * risd — the scoped git entry follows the rule table on every save.
 *
 * Saving rules used to reload only the bridge/profile; the `git config --global`
 * entry of the previous host survived, so repointing or deleting the git rule left
 * every terminal pointed at a dead tunnel ("旧代理无法取消"). reconcileGitProxy()
 * is what the save path now calls before the new table takes effect.
 *
 * The tests use a throwaway HOME/DSH_RIS_IDE_PROXY_HOME and point GIT_CONFIG_GLOBAL
 * at a temp file, so the machine's own git config is never touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'risd-git-home-'))
const workspace = mkdtempSync(join(tmpdir(), 'risd-git-ws-'))
const globalConfig = join(home, 'gitconfig')
writeFileSync(globalConfig, '')
process.env.DSH_RIS_IDE_PROXY_HOME = home
process.env.GIT_CONFIG_GLOBAL = globalConfig

const git = await import('../lib/risd/git.js')
const proxy = await import('../lib/proxy.js')

const SOCKS = { host: '127.0.0.1', port: 1080 }

/** Write a table whose only rule (when host !== '') tunnels git to that host. */
function writeTable(host) {
  const rules = host === ''
    ? []
    : [{ id: 'yds-git', program: 'git', hosts: host, ports: '*', enabled: true, source: 'yds', workspace }]
  proxy.writeProxyConfig(workspace, { socks: SOCKS, listenPort: 0, rules })
}

/** @returns {string} the scoped key a host's proxy would live under. */
function keyFor(host) {
  return `http.https://${host}/.proxy`
}

/** @returns {string} current global value of a key ('' when unset). */
function readKey(key) {
  const out = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', windowsHide: true })
  return String(out.stdout ?? '').trim()
}

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

test('a saved table keeps the git entry on the current host', async () => {
  writeTable('git-a.example')
  const first = await git.reconcileGitProxy({ cwd: workspace })
  assert.equal(first.ok, true)
  assert.equal(first.host, 'git-a.example')
  assert.equal(readKey(keyFor('git-a.example')), `socks5h://${SOCKS.host}:${SOCKS.port}`)
})

test('repointing the git rule unsets the old host and writes the new one', async () => {
  writeTable('git-b.example')
  const second = await git.reconcileGitProxy({ cwd: workspace })
  assert.equal(second.ok, true)
  assert.equal(second.host, 'git-b.example')
  assert.equal(readKey(keyFor('git-a.example')), '', 'the previous host key must be gone')
  assert.equal(readKey(keyFor('git-b.example')), `socks5h://${SOCKS.host}:${SOCKS.port}`)
})

test('deleting the git rule clears the entry instead of leaving a dead tunnel', async () => {
  writeTable('')
  const cleared = await git.reconcileGitProxy({ cwd: workspace })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.changed, true)
  assert.equal(readKey(keyFor('git-b.example')), '')
  assert.equal(existsSync(git.gitProxyStatePath()), false, 'bookkeeping must not outlive the entry')
})

test('a value somebody else replaced is left alone (E7 ownership)', async () => {
  writeTable('git-c.example')
  await git.reconcileGitProxy({ cwd: workspace })
  assert.equal(readKey(keyFor('git-c.example')), `socks5h://${SOCKS.host}:${SOCKS.port}`)
  spawnSync('git', ['config', '--global', keyFor('git-c.example'), 'http://their-proxy:3128'], { encoding: 'utf8' })
  writeTable('')
  const cleared = await git.reconcileGitProxy({ cwd: workspace })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.cleared?.skipped, 'foreign-value')
  assert.equal(readKey(keyFor('git-c.example')), 'http://their-proxy:3128', 'their value must survive')
  assert.equal(existsSync(git.gitProxyStatePath()), false, 'our bookkeeping is dropped')
})

test('disabling the proxy also leaves a foreign git value alone', async () => {
  // Review B-P0-1: only clearGitProxy() had the ownership check; the disable and
  // host-switch paths unset the key directly, so a user's own scoped proxy was
  // deleted whenever the plugin stopped the tunnel.
  const host = 'git-d.example'
  const key = keyFor(host)
  writeTable(host)
  const applied = await git.syncGitProxy({ cwd: workspace, host, enabled: true })
  assert.equal(applied.ok, true)
  spawnSync('git', ['config', '--global', key, 'http://their-proxy:3128'], { encoding: 'utf8', windowsHide: true })
  const off = await git.syncGitProxy({ cwd: workspace, host, enabled: false })
  assert.equal(off.ok, true)
  assert.equal(off.skipped, 'foreign-value')
  assert.equal(readKey(key), 'http://their-proxy:3128', 'their value must survive a disable')
  assert.equal(existsSync(git.gitProxyStatePath()), false)
})
