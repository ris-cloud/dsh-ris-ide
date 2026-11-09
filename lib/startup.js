// Startup reconciliation: things we left on the machine last time that no longer
// match the current configuration.
//
// Why this exists (2026-11-08): the proxy's on-disk side effects outlive the process
// that created them. `git config --global http.https://<host>/.proxy` survives a
// reboot (a dead tunnel makes every git/IDE fetch to that host fail), and the Windows
// `ProxyBridgeSvc` may still be parked on Manual (we park it so the SCM does not
// resurrect it mid-session). After a reboot nothing runs any more, so no teardown
// ever restored those two; the next start has to reconcile instead of trusting that
// the previous process cleaned up.
//
// Rules: only undo what is provably ours (recorded value / `socks5h://` heuristic),
// never touch a foreign value, and only when the owner (engine / bridge) is gone.
// @module dsh-ris-ide/startup
import { existsSync, rmSync } from 'node:fs'
import { proxyPid, proxyPidPath, proxyStatus, readProxyConfig } from './proxy.js'
import { reloadFailedPath, readWindowsServiceState, redirectorStatusCached, restoreWindowsService } from './redirector.js'
import { clearGitProxy, enabledGitRuleHost, readGitProxyState, syncGitProxy } from './risd/git.js'
import { readRisdState, removeRisdState } from './risd/state.js'
import { risdHealth } from './risd-client.js'

/**
 * Bring the machine back in line with the current rules.
 *
 * @param {{cwd?: string, log?: (message: string) => void}} [options] - workspace
 *   hint (only used to resolve legacy paths) and a logger.
 * @returns {Promise<{ok: boolean, notes: string[]}>} what was cleaned (empty = clean).
 */
export async function reconcileStartupLeftovers({ cwd = '', log = () => {}, ownPid = null } = {}) {
  const notes = []
  const note = (message) => {
    notes.push(message)
    log(`[dsh-ris-ide] 启动对账：${message}`)
  }

  const gitState = readGitProxyState()
  if (gitState.key !== '') {
    const engineRunning = (await proxyStatus(cwd)).running === true
    const ruleHost = enabledGitRuleHost(readProxyConfig(cwd))
    if (engineRunning !== true) {
      const cleared = await clearGitProxy()
      if (cleared.skipped === 'foreign-value') {
        note(`保留了不是本插件写入的 git 代理（${gitState.key} = ${cleared.current ?? '?'}）`)
      } else {
        note(`引擎未运行，已清掉遗留的 git 代理 ${gitState.key}`)
      }
    } else if (ruleHost === '') {
      const cleared = await clearGitProxy()
      note(cleared.skipped === 'foreign-value'
        ? `保留了不是本插件写入的 git 代理（${gitState.key}）`
        : `规则表已没有 git 规则，已清掉遗留的 git 代理 ${gitState.key}`)
    } else if (gitState.host !== ruleHost) {
      const synced = await syncGitProxy({ cwd, host: ruleHost, enabled: true })
      note(synced.ok === true
        ? `git 代理已改指当前规则 ${ruleHost}（原 ${gitState.host || '未知'}）`
        : `git 代理改指 ${ruleHost} 失败：${synced.error ?? '未知原因'}`)
    }
  }

  // A pidfile kept from the last run is harmless to the engine code (it verifies
  // the marker before trusting a pid), but it makes the panel show a phantom
  // owner; if nothing is answering, the file no longer describes reality.
  const pidPath = proxyPidPath()
  const hadPidFile = existsSync(pidPath)
  // `proxyPid()` already drops a pidfile whose pid does not carry our marker; keep
  // the note so the user knows the phantom owner is gone rather than unexplained.
  if (proxyPid() === null && hadPidFile) {
    rmSync(pidPath, { force: true })
    note('清掉了失效的代理 pidfile（引擎未运行）')
  }

  // Same for `risd.json`: a daemon state file whose port no longer answers makes
  // the plugin believe a daemon exists (and then fail every forward with 502).
  const daemonState = readRisdState()
  if (daemonState !== null && Number(daemonState.pid) !== Number(ownPid)) {
    // Never probe/remove our OWN state: a daemon reconciles its startup leftovers
    // while it is still warming up, and a 400 ms self-request can fail under load;
    // deleting risd.json then orphaned the daemon (review A-P1-5).
    const alive = await risdHealth(daemonState, { timeoutMs: 400 })
    if (alive?.ok !== true) {
      removeRisdState()
      note(`清掉了失效的 risd.json（daemon ${daemonState.port} 未应答）`)
    }
  }

  // A reload failure marker from the previous run describes a bridge that is not
  // running any more; keeping it makes the panel warn about nothing.
  if (existsSync(reloadFailedPath()) && redirectorStatusCached().running !== true) {
    rmSync(reloadFailedPath(), { force: true })
    note('清掉了上次遗留的桥接重载失败标记')
  }

  const serviceState = readWindowsServiceState()
  if (serviceState !== null && serviceState.stoppedByUs === true) {
    if (redirectorStatusCached().running !== true) {
      const restored = restoreWindowsService()
      note(restored.restored === true
        ? '已恢复上次被停用的 ProxyBridgeSvc'
        : `ProxyBridgeSvc 未能自动恢复：${restored.reason ?? '未知原因'}（可手动把启动类型改回 Automatic）`)
    }
  }

  return { ok: true, notes }
}

/**
 * The same check but never throwing and never blocking startup.
 * @param {object} [options] - forwarded to {@link reconcileStartupLeftovers}.
 */
export function scheduleStartupReconcile(options = {}) {
  void reconcileStartupLeftovers(options).catch((error) => {
    try { options.log?.(`[dsh-ris-ide] 启动对账失败：${error?.message ?? error}`) } catch { /* logging must not throw */ }
  })
}
