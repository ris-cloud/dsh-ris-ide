/**
 * risd — the scoped `git config --global` entry (Phase 1b P5).
 *
 * The plugin used to own this: `syncGitProxy` decided which remote host the tunnel
 * is for and wrote a single `http.https://<host>/.proxy = socks5h://…` key (plus
 * the Windows-side git config, which cannot resolve internal hosts). Ownership
 * moves here together with the bridge, for the same reason: the git entry is a
 * machine-level side effect, and whoever owns the engine must be able to undo it
 * when the last lease goes away.
 *
 * Kept byte-compatible with the plugin's implementation (same file, same shape,
 * same precedence) so a machine that switches between `daemonMode=off` and `auto`
 * does not end up with two different entries.
 *
 * @module dsh-risd/git
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitProxyPlan, proxyHomeDir, readProxyConfig, runWindowsGitConfig } from '../proxy.js'
import { programKey } from '../proxy.js'

export const GIT_PROXY_STATE_FILENAME = 'git-proxy.json'

export function gitProxyStatePath() {
  return join(proxyHomeDir(), GIT_PROXY_STATE_FILENAME)
}

export function readGitProxyState() {
  try {
    const raw = JSON.parse(readFileSync(gitProxyStatePath(), 'utf8'))
    return {
      key: typeof raw?.key === 'string' ? raw.key : '',
      host: typeof raw?.host === 'string' ? raw.host : '',
      // What we actually wrote. Recorded so teardown can tell OUR entry from one a
      // human (or another tool) has since replaced (E7: clear by ownership).
      value: typeof raw?.value === 'string' ? raw.value : '',
    }
  } catch {
    return { key: '', host: '' }
  }
}

export function writeGitProxyState(state) {
  const path = gitProxyStatePath()
  if (state === null) {
    try { rmSync(path, { force: true }) } catch { /* nothing to clear */ }
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/** Run `git config --global …`; never throws, always resolves. */
export function runGitConfig(args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', ['config', '--global', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }))
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git config exited ${code}` }))
  })
}

/** Current `git config --global --get <key>` value, or '' when unset. */
function gitConfigValue(key) {
  if (key === '') return ''
  const out = spawnSync('git', ['config', '--global', '--get', key], {
    encoding: 'utf8', windowsHide: true, timeout: 4000,
  })
  if (out.status !== 0 || typeof out.stdout !== 'string') return ''
  return out.stdout.trim()
}

function gitOriginHost(cwd) {
  const out = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8', windowsHide: true, timeout: 4000,
  })
  if (out.status !== 0 || typeof out.stdout !== 'string') return ''
  try { return new URL(out.stdout.trim()).host } catch { return '' }
}

function gitRuleHost(cwd) {
  const rules = readProxyConfig(cwd).rules
  for (const rule of rules) {
    if (rule.enabled !== true) continue
    if (programKey(rule.program) !== 'git') continue
    const first = String(rule.hosts ?? '').split(',')[0].trim()
    if (first !== '') return first
  }
  return ''
}

/**
 * Write or clear the git entry. Precedence is the plugin's, deliberately: explicit
 * host → the table's own git rule → the host we wrote last time → repo origin.
 * A mirror is not a target, so origin comes last.
 */
export async function syncGitProxy({ cwd, host, enabled }) {
  const previous = readGitProxyState()
  if (enabled !== true) {
    // E7: only undo an entry we wrote. `clearGitProxy()` compares the CURRENT
    // value with the recorded one, so a proxy the user set by hand survives.
    const key = previous.key
    if (key === '') return { ok: true, key: '' }
    const cleared = await clearGitProxy()
    return {
      ok: true,
      key,
      cleared: cleared.cleared === true || cleared.skipped === 'already-gone',
      windowsCleared: cleared.windowsCleared === true,
      ...(cleared.skipped === undefined ? {} : { skipped: cleared.skipped }),
    }
  }
  const target = (typeof host === 'string' && host !== '')
    ? host
    : (gitRuleHost(cwd) || (previous.host !== '' ? previous.host : gitOriginHost(cwd)))
  if (target === '') return { ok: false, error: '没有 git 规则也没有 origin，无法确定代理作用域', key: '' }
  if (previous.key !== '' && previous.host !== '' && previous.host !== target) {
    // Same ownership check on the switch path: never unset a value somebody else
    // put in place (review B-P0-1).
    await clearGitProxy()
  }
  const plan = gitProxyPlan(readProxyConfig(cwd), { host: target, enabled: true })
  if (plan.value === '') return { ok: false, error: '没有可用的 SOCKS 地址', key: plan.key }
  const written = await runGitConfig([plan.key, plan.value])
  if (written.ok !== true) return { ok: false, error: written.error, key: plan.key }
  const windows = runWindowsGitConfig([plan.key, plan.value])
  writeGitProxyState({ key: plan.key, host: target, value: plan.value, windows: windows.ok === true })
  return { ok: true, key: plan.key, host: target, windows }
}

/**
 * Host of the first enabled `git` rule in a table (pure: no disk read).
 * @param {object} config - engine config.
 * @returns {string} host pattern, or '' when the table declares no git tunnel.
 */
export function enabledGitRuleHost(config) {
  const rules = Array.isArray(config?.rules) ? config.rules : []
  for (const rule of rules) {
    if (rule?.enabled !== true) continue
    if (programKey(rule.program) !== 'git') continue
    const first = String(rule.hosts ?? '').split(',')[0].trim()
    if (first !== '') return first
  }
  return ''
}

/**
 * Re-align the scoped git entry with the table that was just saved.
 *
 * The save path used to write `proxy.json` and reload the bridge only, leaving the
 * `git config --global` entry of the PREVIOUS host in place: editing/deleting the
 * git rule kept every terminal pointed at a dead tunnel ("旧代理无法取消"). The
 * table is the source of truth, so:
 *  - a git rule still exists  → syncGitProxy() switches to it (it unsets the old
 *    host-scoped key first, and only when the recorded value is still ours);
 *  - no git rule survives     → clear whatever we wrote before.
 *
 * @param {{cwd: string, host?: string}} options - workspace and an optional explicit host.
 * @returns {Promise<{ok: boolean, host?: string, changed: boolean, cleared?: object, error?: string}>} outcome.
 */
export async function reconcileGitProxy({ cwd, host = '' } = {}) {
  const target = (typeof host === 'string' && host !== '') ? host : enabledGitRuleHost(readProxyConfig(cwd))
  if (target === '') {
    const previous = readGitProxyState()
    if (previous.key === '') return { ok: true, changed: false }
    const cleared = await clearGitProxy()
    return { ok: true, changed: true, cleared }
  }
  const applied = await syncGitProxy({ cwd, host: target, enabled: true })
  return {
    ok: applied.ok === true,
    host: target,
    changed: true,
    ...(applied.ok === true ? {} : { error: applied.error }),
  }
}

/**
 * Undo whatever we wrote, on both sides. Used by teardown; never throws.
 *
 * E7 (ownership): the entry is only unset when it is still OURS — the recorded
 * value, or (for state written before `value` was recorded) a `socks5h://` value,
 * which is the shape this module always writes. A key that somebody replaced with
 * their own proxy must survive our teardown; only our stale bookkeeping is dropped.
 */
export async function clearGitProxy() {
  const previous = readGitProxyState()
  if (previous.key === '') return { ok: true, key: '', skipped: 'nothing-recorded' }
  const current = gitConfigValue(previous.key)
  const ours = current !== '' && (previous.value !== '' ? current === previous.value : current.startsWith('socks5h://'))
  if (ours !== true) {
    writeGitProxyState(null)
    return { ok: true, key: previous.key, skipped: current === '' ? 'already-gone' : 'foreign-value', current }
  }
  const cleared = await runGitConfig(['--unset', previous.key])
  const windowsCleared = runWindowsGitConfig(['--unset', previous.key])
  writeGitProxyState(null)
  return { ok: true, key: previous.key, cleared: cleared.ok === true, windowsCleared: windowsCleared.ok === true }
}
