/**
 * risd — the read-only proxy view.
 *
 * Phase 1a hands the browser the same picture the plugin used to build itself,
 * minus the parts that need the plugin's program registry (per-rule run state)
 * and its in-process leftovers (`inherited` engine banner). The plugin decorates
 * those locally after forwarding, so `lib/client.js` sees an unchanged shape.
 *
 * Everything here is derived from the same files the engine reads — `proxy.json`,
 * the janitor state, the redirector cache — so the daemon never invents state.
 *
 * @module dsh-risd/view
 */
import { createHash } from 'node:crypto'
import { allowList, engineSide, gitProxyPlan, proxyConfigPath, proxyHomeDir, proxyStatus } from '../proxy.js'
import { janitorStatus } from '../janitor.js'
import { buildProfile } from '../redirector.js'

/**
 * The CAS base the dialog sends back with a save. Mirrors `configRevision` in
 * `lib/index.js` byte for byte (same fields, same order, same 12-char prefix);
 * `test/risd-api.test.mjs` asserts the two agree so a future edit cannot drift.
 * @param config - the normalised config file contents.
 * @returns 12 hex chars.
 */
export function risdConfigRevision(config) {
  const view = {
    socks: [String(config?.socks?.host ?? ''), Number(config?.socks?.port ?? 0)],
    listenPort: Number(config?.listenPort ?? 0),
    rules: (Array.isArray(config?.rules) ? config.rules : []).map((rule) => [
      String(rule.id ?? ''),
      String(rule.program ?? ''),
      String(rule.hosts ?? ''),
      String(rule.ports ?? ''),
      rule.enabled === true,
      rule.shadow === true,
      String(rule.source ?? ''),
    ]),
  }
  return createHash('sha1').update(JSON.stringify(view)).digest('hex').slice(0, 12)
}

/**
 * @param cwd - workspace the caller asked about.
 * @returns the base view (no rule decorations, no inherited-engine banner).
 */
export async function risdProxyView(cwd) {
  const status = await proxyStatus(cwd)
  const watcher = janitorStatus()
  return {
    ok: true,
    side: engineSide(),
    revision: risdConfigRevision(status.config),
    configPath: proxyConfigPath(),
    home: proxyHomeDir(),
    shared: true,
    workspace: cwd,
    socks: status.config.socks,
    listenPort: status.config.listenPort,
    // The maintenance page edits the table, so it needs the raw rows; the plugin
    // still decorates its own copy with per-rule run state after forwarding.
    rules: (Array.isArray(status.config.rules) ? status.config.rules : []).map((rule) => Object.assign({}, rule)),
    running: status.running,
    pid: status.pid,
    listen: status.listen,
    logPath: status.logPath,
    socksUrl: status.socksUrl,
    allow: allowList(status.config),
    git: gitProxyPlan(status.config, {}),
    // How many profile rules a sync would emit. Live bridge status is NOT probed
    // here: on WSL that costs seconds (`/mnt/c` exists -> powershell probe), and the
    // plugin already merges its cached status into the forwarded view. The old
    // `managedBy:'plugin'` label outlived Phase 1b, where the daemon took over the
    // bridge lifecycle (review A-P2-4).
    redirector: { managedBy: 'daemon', rules: buildProfile(status.config).rules.length },
    janitor: watcher,
    owner: watcher.owner,
  }
}
