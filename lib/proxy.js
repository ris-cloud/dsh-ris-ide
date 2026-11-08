/**
 * Proxy engine: rules → local forwarders + a loopback CONNECT proxy that tunnels
 * through ONE upstream SOCKS5 server.
 *
 * What a rule can do (design A — no drivers, no admin rights, any OS):
 *   - `program` decides WHO gets the proxy settings: rules are named after a
 *     program (`java.exe`, `git`, `node`, `curl`, `navicat.exe`) and the
 *     injection below only touches a program whose name matches a rule.
 *   - `hosts` (exact IP / hostname / `1.2.3.*` wildcard, comma separated) and
 *     `ports` (`5432`, `1000-1010`, comma separated) decide WHAT may go through
 *     the tunnel. Every axis is REQUIRED; a blank one rejects the whole row
 *     (fail-closed) — `*` is how "everything" is spelled.
 *   - Two mechanisms are derived from the enabled rules:
 *       1. a loopback HTTP CONNECT proxy (`127.0.0.1:<listenPort>`) whose
 *          allow-list is the union of the rules — this is what makes wildcard
 *          hosts and port RANGES work at all, because the destination is only
 *          known per connection;
 *       2. same-port shadow listeners (`127.0.0.1:<targetPort>` → SOCKS →
 *          `host:targetPort`) for rules whose hosts are literal IPs — that is
 *          what lets a program which only accepts a host/port (Navicat, a JDBC
 *          URL, …) reach the internal server by pointing its connection at
 *          127.0.0.1 instead of the real IP.
 *   - `injection` returns the settings a launcher should apply for a program:
 *     env (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` → the LOCAL loopback CONNECT
 *     proxy, so every connection is checked against the allow-list) and JVM
 *     flags (`-Dhttp.proxyHost`/`-Dhttps.proxyHost`; `-DsocksProxyHost` only for
 *     a `direct` row, because the CONNECT proxy is not a SOCKS server).
 *     `git` gets a scoped `git config` entry instead of a command-line flag, so
 *     every git caller (including other plugins) picks it up.
 *
 * The engine is deliberately free of any DSH/host dependency: the plugin loads
 * it as a module, and `node lib/proxy.js …` runs it as a CLI (that is how
 * dsh-ris-yds borrows it without duplicating the tunnel code).
 *
 * SECURITY: listening sockets are loopback-only and the CONNECT proxy answers
 * loopback peers only. The allow-list is enforced per destination — but it is
 * the union of all rules, because an HTTP proxy cannot tell which local program
 * opened a connection.
 */

import { execFileSync, spawn, spawnSync as spawnSyncImpl } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, watchFile, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ONE engine and ONE config per machine, not per workspace.
 *
 * A loopback port is a machine-level resource, so "two workspaces, two engines"
 * could never work: the second bind fails, and a program that both workspaces
 * share (java, git) cannot be told apart per workspace anyway. Sharing the file
 * lets every workspace add its own rows (`rule.workspace`) while the ports are
 * bound exactly once.
 */
export const PROXY_HOME_DIRNAME = '.dsh-ris-ide'
export const PROXY_FILENAME = 'proxy.json'
export const PROXY_PID_FILENAME = 'proxy.pid'
export const PROXY_LOG_FILENAME = 'proxy-forward.log'

/**
 * Directory holding the shared config, pidfile and log.
 *
 * `DSH_RIS_IDE_PROXY_HOME` overrides it — tests need an isolated home, and a
 * user may want the state on another disk.
 * @returns absolute directory (may not exist yet).
 */
export function proxyHomeDir() {
  const override = typeof process.env.DSH_RIS_IDE_PROXY_HOME === 'string' ? process.env.DSH_RIS_IDE_PROXY_HOME.trim() : ''
  if (override !== '') return resolve(override)
  return join(homedir(), PROXY_HOME_DIRNAME)
}

/**
 * Programs that can be *told* to use SOCKS from the command line or an env var.
 * Anything not listed here (Navicat, the mysql/JDBC clients, …) can only reach
 * the tunnel through a same-port loopback mapping, which is why new rows default
 * to mapped for those and unmapped for these.
 */
export const SOCKS_CAPABLE_PROGRAMS = Object.freeze([
  'java', 'javaw', 'mvn', 'gradle', 'node', 'npm', 'npx', 'git', 'curl', 'python', 'python3', 'bash', 'sh', 'zsh',
])
/** Marker carried in the forwarder's argv; the ONLY thing that makes a pid ours. */
export const PROXY_MARKER = 'dsh-ris-ide-proxy'
/** Which OS this process runs on — the loopback-mapping and pid checks differ. */
export const IS_WINDOWS = process.platform === 'win32'

/**
 * Which side of the OS boundary this engine runs on. `wsl` matters because a
 * loopback listener started here is NOT the loopback a Windows program sees:
 * 127.0.0.1 means "this side", so a Windows client must be handed the real
 * proxy address instead of a 127.0.0.1 mapping.
 * @returns `'windows' | 'wsl' | 'linux' | 'macos'`.
 */
export function engineSide() {
  if (IS_WINDOWS) return 'windows'
  if (process.platform === 'darwin') return 'macos'
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl'
  } catch { /* not readable: treat as plain linux */ }
  return 'linux'
}

/** Default loopback port of the CONNECT proxy. */
export const DEFAULT_LISTEN_PORT = 11081
/** A rule row is cheap; a thousand of them is a typo, not a setup. */
export const MAX_RULES = 200
/** Cap on derived same-port listeners (each one holds a local port). */
export const MAX_SHADOW_TARGETS = 64
const SOCKS_CONNECT_TIMEOUT_MS = 15000
const HEADER_MAX_BYTES = 16 * 1024

/* ------------------------------------------------------------------ rules -- */

/**
 * The rows a workspace starts with: generated, NOT enabled, never persisted —
 * the dialog adds them for the current workspace when it has no row for that
 * program yet, so a shared config does not accumulate four dead rows per
 * workspace that ever opened the dialog.
 * @param workspace - workspace label the rows are shown for.
 * @returns four rule stubs.
 */
export const AUTO_PROGRAMS = Object.freeze(['java', 'git'])

export function autoRules(workspace = '') {
  return AUTO_PROGRAMS.map((program) => ({
    id: `auto-${program}`,
    program,
    hosts: '',
    ports: '',
    enabled: false,
    shadow: false,
    source: 'auto',
    workspace,
  }))
}

/**
 * Parse `1.2.3.4, 10.0.0.*, gitlab.example.com` into matchable patterns.
 * `*` is the only wildcard and stands for a whole dotted segment (or a prefix).
 * @param spec - the rule's raw `hosts` text.
 * @returns `{ patterns, invalid }` — patterns in input order, rejected fragments verbatim.
 */
export function parseHostSpec(spec) {
  const patterns = []
  const invalid = []
  const text = typeof spec === 'string' ? spec : ''
  for (const raw of text.split(',')) {
    const item = raw.trim()
    if (item === '') continue
    // A pattern is host-shaped: letters/digits/dots/dashes/underscores plus `*`.
    if (!/^[A-Za-z0-9*]([A-Za-z0-9.*_-]*[A-Za-z0-9*])?$/.test(item)) {
      invalid.push(item)
      continue
    }
    if (!patterns.includes(item)) patterns.push(item)
  }
  return { patterns, invalid }
}

/**
 * Parse `5432, 1000-1010` into a sorted, de-duplicated port list.
 * @param spec - the rule's raw `ports` text.
 * @returns `{ ports, invalid }` — ports are integers 1…65535.
 */
export function parsePortSpec(spec) {
  const ports = new Set()
  const invalid = []
  const text = typeof spec === 'string' ? spec : ''
  for (const raw of text.split(',')) {
    const item = raw.trim()
    if (item === '') continue
    const range = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(item)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to > 65535 || from > to) {
        invalid.push(item)
        continue
      }
      for (let port = from; port <= to; port += 1) ports.add(port)
      continue
    }
    // `*` is the explicit "every port"; an EMPTY spec is not the same thing — a rule
    // without a port range does not apply at all (the dialog says so), because a
    // silently unrestricted rule is how a proxy leaks.
    if (item === '*') {
      ports.add(0)
      continue
    }
    if (/^\d{1,5}$/.test(item)) {
      const port = Number(item)
      if (port >= 1 && port <= 65535) {
        ports.add(port)
        continue
      }
    }
    invalid.push(item)
  }
  return { ports: [...ports].sort((a, b) => a - b), invalid }
}

/**
 * Does one host pattern match one concrete host?
 * `1.2.3.*` matches `1.2.3.4`; `*.example.com` matches `a.example.com`; an exact
 * string matches case-insensitively (DNS names are case-insensitive).
 * @param pattern - a pattern from {@link parseHostSpec}.
 * @param host - the destination host (IP literal or DNS name).
 * @returns true when the pattern covers the host.
 */
export function hostMatches(pattern, host) {
  if (typeof pattern !== 'string' || pattern === '' || typeof host !== 'string' || host === '') return false
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern.toLowerCase() === host.toLowerCase()
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(host.toLowerCase())
}

/**
 * Whether a rule can actually do something.
 *
 * A rule only applies when it is enabled AND names a program AND names a host
 * pattern AND names a port pattern: every axis is explicit, and "match
 * everything" is spelled `*` rather than left blank. A blank axis used to mean
 * "unrestricted", which is indistinguishable from a half-written row — and a
 * half-written row that silently proxies everything is worse than one that does
 * nothing.
 * @param rule - a normalised rule.
 * @returns `{ effective: boolean, reason: string }` — reason is user-facing text.
 */
export function ruleEffectiveness(rule) {
  const program = typeof rule?.program === 'string' ? rule.program.trim() : ''
  const hostSpec = typeof rule?.hosts === 'string' ? rule.hosts.trim() : ''
  const portSpec = typeof rule?.ports === 'string' ? rule.ports.trim() : ''
  const hosts = parseHostSpec(hostSpec)
  const ports = parsePortSpec(portSpec)
  if (rule?.enabled !== true) return { effective: false, reason: '未启用' }
  if (program === '') return { effective: false, reason: '缺程序' }
  if (hostSpec === '' || hosts.patterns.length === 0) return { effective: false, reason: '缺 IP（全匹配写 *）' }
  if (hosts.invalid.length > 0) return { effective: false, reason: 'IP 有无效片段' }
  if (portSpec === '' || ports.ports.length === 0) return { effective: false, reason: '缺端口（全匹配写 *）' }
  if (ports.invalid.length > 0) return { effective: false, reason: '端口有无效片段' }
  return { effective: true, reason: '' }
}

/** Whether an IPv4 literal (no DNS name) — the only thing a shadow listener can target. */
export function isIpv4Literal(host) {
  return typeof host === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/**
 * Normalise a stored config (or `undefined`) into the shape the engine uses.
 * Unknown fields are dropped, rule rows are validated, and the four auto rows
 * are appended when the stored file predates them.
 * @param raw - parsed JSON (may be null/garbage).
 * @returns the effective config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const socksRaw = source.socks !== null && typeof source.socks === 'object' ? source.socks : {}
  const host = typeof socksRaw.host === 'string' ? socksRaw.host.trim() : ''
  const port = Number(socksRaw.port)
  const listenPort = Number(source.listenPort)
  // Loopback mapping targets that belong to the FALLBACK path, not to the rule
  // table: when ProxyBridge cannot run, some client (a JDBC driver, Navicat) can
  // only be pointed at 127.0.0.1, so the engine binds a listener per destination.
  // Keeping them out of `rules` means the table stays "what should be proxied"
  // and the user never sees an implementation detail there.
  const shadows = []
  const rawShadows = Array.isArray(source.shadows) ? source.shadows : []
  for (const item of rawShadows.slice(0, MAX_SHADOW_TARGETS)) {
    if (item === null || typeof item !== 'object') continue
    const host = typeof item.host === 'string' ? item.host.trim() : ''
    const port = Number(item.port)
    const localPort = Number(item.localPort)
    if (!isIpv4Literal(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const listen = Number.isInteger(localPort) && localPort > 1023 && localPort < 65536 ? localPort : port
    if (shadows.some((entry) => entry.host === host && entry.port === port && entry.localPort === listen)) continue
    shadows.push({ host, port, localPort: listen })
  }
  const rules = []
  const rawRules = Array.isArray(source.rules) ? source.rules : []
  for (const item of rawRules.slice(0, MAX_RULES)) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : `rule-${rules.length + 1}`
    const program = typeof item.program === 'string' ? item.program.trim() : ''
    const hostSpec = typeof item.hosts === 'string' ? item.hosts.trim() : ''
    const portSpec = typeof item.ports === 'string' ? item.ports.trim() : ''
    const enabled = item.enabled === true
    const hostsParsed = parseHostSpec(hostSpec).patterns
    const portsParsed = parsePortSpec(portSpec).ports
    const bindable = hostsParsed.length > 0 && hostsParsed.every(isIpv4Literal) && portsParsed.length > 0
    // A program that speaks SOCKS needs no mapping; one that cannot is only
    // reachable through a same-port loopback listener, so it gets one unless the
    // stored file says otherwise (an explicit true/false always wins).
    const shadow = typeof item.shadow === 'boolean' ? item.shadow : bindable && !isSocksCapableProgram(program)
    if (program === '' && hostSpec === '' && portSpec === '') continue
    // Migration: the starter rows used to include `node` and `curl`; they are not
    // offered any more, so drop a stored one instead of leaving an empty row the
    // dialog can no longer create (a user's OWN node/curl row is kept — its source
    // is not `auto`).
    if (item.source === 'auto' && AUTO_PROGRAMS.includes(programKey(program)) !== true) continue
    rules.push({
      id,
      // A human label the provider of the row supplies ("YonCode java"); the dialog
      // and the ProxyBridge profile show it instead of the raw id.
      label: typeof item.label === 'string' ? item.label.trim().slice(0, 60) : '',
      program,
      hosts: hostSpec,
      ports: portSpec,
      enabled,
      // Loopback mapping only helps a client that CANNOT take a proxy address,
      // and only when that client runs on this side of the OS boundary (a
      // Windows program cannot reach a WSL 127.0.0.1).
      shadow,
      // Opt-out from the allow-list: `direct` hands the program the upstream
      // SOCKS address instead of this engine's CONNECT proxy. Defaults to false
      // — an old config file (no field) must keep the enforced path — and only
      // a literal `true` enables it.
      direct: item.direct === true,
      source: typeof item.source === 'string' ? item.source : 'user',
      // Which workspace contributed this row ('' = the generated defaults, which
      // belong to the machine). The engine is shared, so this is the only way to
      // tell "my rule" from "the other workspace's rule" in the dialog.
      workspace: typeof item.workspace === 'string' ? item.workspace : '',
    })
  }
  // The table is MACHINE-level: ProxyBridge hooks the kernel and matches by
  // process name, so a rule cannot be scoped to a workspace or a session. The
  // `workspace` field is therefore a provenance label only, never part of a
  // rule's identity:
  //  - generated/user rows are one switch per PROGRAM for the whole machine, so
  //    opening the dialog from another workspace cannot add a second `java` row;
  //  - driven (`yds`) rows describe ENDPOINTS, not programs — several may share
  //    the `jdbc` label and each is a distinct destination — so they keep their id.
  const seen = new Set()
  const deduped = []
  for (const rule of rules) {
    const key = rule.source === 'yds' ? `yds\u0000${rule.id}` : `prog\u0000${programKey(rule.program)}`
    if (programKey(rule.program) !== '' && seen.has(key)) continue
    seen.add(key)
    deduped.push(rule)
  }
  return {
    socks: {
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    },
    listenPort: Number.isInteger(listenPort) && listenPort > 1023 && listenPort < 65536 ? listenPort : DEFAULT_LISTEN_PORT,
    rules: deduped,
    shadows,
  }
}

/**
 * The allow-list of every ENABLED, effective rule. A rule contributes only its
 * parsed axes; a row with a blank axis contributes nothing (see
 * {@link ruleEffectiveness}).
 * @param config - a normalised config.
 * @returns `{ hostPatterns: string[], ports: number[] }` — either list empty ⇒
 *   DENY everything (fail-closed; "allow everything" is spelled `*`).
 */
export function allowList(config) {
  const hostPatterns = []
  const ports = new Set()
  for (const rule of config.rules) {
    // A half-written row contributes nothing: every axis must be explicit.
    if (ruleEffectiveness(rule).effective !== true) continue
    for (const pattern of parseHostSpec(rule.hosts).patterns) {
      if (!hostPatterns.includes(pattern)) hostPatterns.push(pattern)
    }
    for (const port of parsePortSpec(rule.ports).ports) ports.add(port)
  }
  return { hostPatterns, ports: [...ports].sort((a, b) => a - b) }
}

/**
 * Whether the allow-list admits a destination.
 * @param allow - result of {@link allowList}.
 * @param host - destination host.
 * @param port - destination port.
 * @returns true when the connection may be tunnelled.
 */
export function allowAdmits(allow, host, port) {
  if (allow.hostPatterns.length === 0) return false
  if (!allow.hostPatterns.some((pattern) => hostMatches(pattern, host))) return false
  if (allow.ports.length === 0) return false
  return allow.ports.includes(0) || allow.ports.includes(Number(port))
}

/**
 * Same-port shadow listeners derived from the enabled rules: only literal-IPv4
 * destinations can be pre-bound, and the local port equals the remote one so a
 * program only has to replace the host with `127.0.0.1`.
 * @param config - a normalised config.
 * @returns `[{ host, port, localPort }]` capped at {@link MAX_SHADOW_TARGETS}.
 */
export function shadowTargets(config) {
  const seen = new Set()
  const targets = []
  // Explicit fallback list (written by a client plugin such as dsh-ris-yds) first.
  for (const entry of Array.isArray(config.shadows) ? config.shadows : []) {
    const key = `${entry.host}:${entry.port}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ host: entry.host, port: entry.port, localPort: entry.localPort })
    if (targets.length >= MAX_SHADOW_TARGETS) return targets
  }
  // Rules may still request a mapping themselves (opt-in per row).
  for (const rule of config.rules) {
    if (!rule.enabled || rule.shadow !== true) continue
    const hosts = parseHostSpec(rule.hosts).patterns.filter(isIpv4Literal)
    const ports = parsePortSpec(rule.ports).ports
    for (const host of hosts) {
      for (const port of ports) {
        const key = `${host}:${port}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ host, port, localPort: port })
        if (targets.length >= MAX_SHADOW_TARGETS) return targets
      }
    }
  }
  return targets
}

/** Loopback destinations that must never be sent through the tunnel. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'

/**
 * Which side of the OS boundary a program runs on.
 * `'local'` (the default) — and `engineSide()`'s own value — means "this
 * machine"; anything else means the other side (e.g. `'windows'` when this
 * engine runs in WSL, or `'wsl'` when the caller is the Windows-side launcher).
 * @param options - `{ side }` from {@link injectionFor}.
 * @returns `'local'` or `'remote'`.
 */
function injectionSide(options) {
  const raw = typeof options?.side === 'string' ? options.side.trim().toLowerCase() : ''
  if (raw === '' || raw === 'local') return 'local'
  if (raw === engineSide()) return 'local'
  return 'remote'
}

/**
 * What a launcher should apply for one program: the rule whose `program` names
 * it (exact, case-insensitive, extension-insensitive) must be ENABLED.
 *
 * The default injected address is the LOCAL loopback CONNECT proxy
 * (`http://127.0.0.1:<listenPort>`), NOT the upstream SOCKS server: every
 * connection a started program makes then passes through the engine's
 * allow-list, which is what enforces the rule's `hosts`/`ports`. Handing out
 * `ALL_PROXY=socks5h://<upstream>` would let the program reach anything the
 * SOCKS server can, silently ignoring both axes.
 *
 * A row that explicitly sets `direct: true` opts out and gets the upstream
 * SOCKS address (plus the JVM `-DsocksProxyHost` switch it needs). `direct`
 * defaults to false — including for every config file written before the field
 * existed — so the enforced path is the default. The JVM's `-DsocksProxyHost`
 * cannot point at an HTTP proxy, so the local path uses the HTTP proxy flags
 * only (Java ignores proxy env vars by default).
 *
 * Fail-closed rules:
 *  - no enabled rule for the program, no configured upstream, or a program that
 *    cannot be told a proxy address at all (not in
 *    {@link SOCKS_CAPABLE_PROGRAMS}: a JDBC driver, Navicat) ⇒ `null` — the
 *    latter can only reach the tunnel through a same-port `127.0.0.1` shadow
 *    listener;
 *  - a rule that is not effective ⇒ an object whose `env`/`jvmArgs` are empty
 *    plus a user-facing `reason` (the caller injects nothing).
 *
 * A program on the OTHER side of the OS boundary cannot reach this machine's
 * 127.0.0.1, so a non-direct row injects nothing there either; `direct` is the
 * variant that also works across the boundary (it needs no local listener).
 *
 * @param program - program name or path (`java.exe`, `/usr/bin/node`, `git`).
 * @param config - a normalised config.
 * @param options - `{ side }`; `'local'` (default) or `engineSide()`'s value
 *   means "this machine"; anything else is the other side.
 * @returns `null` when no proxy applies, else
 *   `{ program, side, direct, env, jvmArgs, socksUrl, httpProxyUrl, listenPort, reason }`.
 */
export function injectionFor(program, config, options = {}) {
  const wanted = programKey(program)
  if (wanted === '') return null
  // A client that cannot be told a proxy address is not helped by a proxy URL;
  // it needs a 127.0.0.1 listener (see `shadowTargets`).
  if (isSocksCapableProgram(wanted) !== true) return null
  const rule = config.rules.find((item) => item.enabled && programKey(item.program) === wanted)
  if (rule === undefined) return null
  if (config.socks.host === '' || config.socks.port === 0) return null
  const side = injectionSide(options)
  const direct = rule.direct === true
  const socksUrl = `socks5h://${config.socks.host}:${config.socks.port}`
  const base = {
    program: wanted,
    side,
    direct,
    env: {},
    jvmArgs: [],
    socksUrl,
    httpProxyUrl: null,
    listenPort: config.listenPort,
    reason: '',
  }
  const effectiveness = ruleEffectiveness(rule)
  if (effectiveness.effective !== true) {
    return { ...base, reason: `规则不完整，未注入：${effectiveness.reason}` }
  }
  if (direct === true) {
    // Explicit opt-out from the allow-list: reproduce the pre-M1 behaviour of
    // binding the program straight to the upstream SOCKS server.
    return {
      ...base,
      env: {
        ALL_PROXY: socksUrl,
        all_proxy: socksUrl,
        HTTP_PROXY: socksUrl,
        HTTPS_PROXY: socksUrl,
        http_proxy: socksUrl,
        https_proxy: socksUrl,
      },
      jvmArgs: [
        `-DsocksProxyHost=${config.socks.host}`,
        `-DsocksProxyPort=${config.socks.port}`,
      ],
    }
  }
  if (side === 'remote') {
    return {
      ...base,
      reason: '程序在系统边界的另一侧，本机回环代理不可达；如确需直连上游请把该行设为 direct',
    }
  }
  const httpProxyUrl = `http://127.0.0.1:${config.listenPort}`
  return {
    ...base,
    httpProxyUrl,
    env: {
      ALL_PROXY: httpProxyUrl,
      all_proxy: httpProxyUrl,
      HTTP_PROXY: httpProxyUrl,
      HTTPS_PROXY: httpProxyUrl,
      http_proxy: httpProxyUrl,
      https_proxy: httpProxyUrl,
      NO_PROXY: DEFAULT_NO_PROXY,
      no_proxy: DEFAULT_NO_PROXY,
    },
    jvmArgs: [
      '-Dhttp.proxyHost=127.0.0.1',
      `-Dhttp.proxyPort=${config.listenPort}`,
      '-Dhttps.proxyHost=127.0.0.1',
      `-Dhttps.proxyPort=${config.listenPort}`,
      '-Dhttp.nonProxyHosts=localhost|127.*|[::1]',
    ],
  }
}

/** Normalise a program name/path to its bare, lower-case key (`C:\\…\\node.exe` → `node`). */
export function programKey(program) {
  if (typeof program !== 'string') return ''
  const base = program.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.trim().toLowerCase().replace(/\.(exe|cmd|bat|sh)$/, '')
}

/**
 * Whether a program accepts a SOCKS address directly (`-DsocksProxyHost`,
 * `ALL_PROXY`, `http.proxy=socks5h://…`).
 * @param program - executable name or absolute path.
 * @returns true when the program is known to speak SOCKS.
 */
export function isSocksCapableProgram(program) {
  const key = programKey(program)
  return key !== '' && SOCKS_CAPABLE_PROGRAMS.includes(key)
}

/* ------------------------------------------------------------------- I/O -- */

/** Absolute path of the ONE shared proxy config. */
export function proxyConfigPath() {
  return join(proxyHomeDir(), PROXY_FILENAME)
}

/** Absolute path of the shared pidfile. */
export function proxyPidPath() {
  return join(proxyHomeDir(), PROXY_PID_FILENAME)
}

/** Absolute path of the shared engine log. */
export function proxyLogPath() {
  return join(proxyHomeDir(), PROXY_LOG_FILENAME)
}

/**
 * Read + normalise the shared proxy config (missing/garbage ⇒ defaults).
 * @param _workspace - ignored for storage; kept so callers can pass the workspace
 *   without caring that the file is machine-level. Rows carry their own label.
 */
export function readProxyConfig(workspace) {
  const path = proxyConfigPath()
  if (existsSync(path)) {
    try {
      return normalizeConfig(parseJsonc(readFileSync(path, 'utf8')))
    } catch {
      return normalizeConfig(undefined)
    }
  }
  // Migration: engines before the shared-config change kept the file inside the
  // workspace. Read it (labelled with that workspace) so an existing setup keeps
  // its rules; the next save writes the merged result to the shared file.
  if (typeof workspace === 'string' && workspace !== '') {
    const legacy = join(workspace, '.dsh-ris-ide', PROXY_FILENAME)
    if (existsSync(legacy)) {
      try {
        const migrated = normalizeConfig(parseJsonc(readFileSync(legacy, 'utf8')))
        return Object.assign({}, migrated, {
          rules: migrated.rules.map((rule) => (rule.workspace === '' ? Object.assign({}, rule, { workspace }) : rule)),
        })
      } catch { /* fall through to defaults */ }
    }
  }
  return normalizeConfig(undefined)
}

/** Write the shared config atomically (0600: it names internal hosts and a tunnel). */
export function writeProxyConfig(_workspace, raw) {
  const config = normalizeConfig(raw)
  const path = proxyConfigPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return config
}

/**
 * Tolerant JSONC parse (comments + trailing commas), because the config file is
 * hand-editable and the rest of the plugin already writes JSONC headers.
 * @param text - file content.
 * @returns the parsed value (null when the text is empty/garbage).
 */
export function parseJsonc(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  let out = ''
  let inString = false
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
      } else if (char === quote) {
        inString = false
      }
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    out += char
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- tunnel -- */

/**
 * Open one SOCKS5 connection (no auth) and hand back the raw socket.
 * @param socks - `{ host, port }` of the upstream SOCKS server.
 * @param host - destination host (IP literal or DNS name).
 * @param port - destination port.
 * @returns a promise for the connected socket.
 */
export function connectSocks(socks, host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (socks === undefined || socks === null || !socks.host || !socks.port) {
      rejectPromise(new Error('upstream SOCKS address is not configured'))
      return
    }
    const socket = netConnect({ host: socks.host, port: socks.port })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      rejectPromise(error)
    }
    const timer = setTimeout(() => fail(new Error(`SOCKS connect to ${host}:${port} timed out`)), SOCKS_CONNECT_TIMEOUT_MS)
    socket.on('error', fail)
    socket.on('close', () => fail(new Error(`SOCKS server closed during handshake`)))
    socket.once('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
      let buffered = Buffer.alloc(0)
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        if (buffered.length < 2) return
        if (buffered[0] !== 0x05) return fail(new Error('not a SOCKS5 server'))
        if (buffered[1] !== 0x00) return fail(new Error(`SOCKS5 auth rejected (method ${buffered[1]})`))
        if (socket.listenerCount('data') === 0) return
        socket.removeListener('data', onData)
        const request = [0x05, 0x01, 0x00]
        const isAddressIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
        if (isAddressIpv4) {
          request.push(0x01, ...host.split('.').map(Number))
        } else {
          const name = Buffer.from(host, 'utf8')
          request.push(0x03, name.length, ...name)
        }
        request.push((port >> 8) & 0xFF, port & 0xFF)
        socket.write(Buffer.from(request))
        let reply = Buffer.alloc(0)
        const onReply = (data) => {
          reply = Buffer.concat([reply, data])
          if (reply.length < 4) return
          if (reply[0] !== 0x05) return fail(new Error('SOCKS5 回包版本不是 5'))
          if (reply[1] !== 0x00) {
            const codes = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address not supported' }
            return fail(new Error(`SOCKS5 CONNECT to ${host}:${port} failed: ${codes[reply[1]] ?? `rep=${reply[1]}`}`))
          }
          const atyp = reply[3]
          if (atyp !== 0x01 && atyp !== 0x03 && atyp !== 0x04) {
            return fail(new Error(`SOCKS5 回包地址类型未知（ATYP=${atyp}）`))
          }
          // An unknown ATYP used to make `need` NaN, and `length < NaN` is false ⇒ the
          // socket was resolved with a partially-read reply, so the leftover bytes leaked
          // into the tunnel as garbage. Every reply byte must be consumed first.
          const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : (reply.length < 5 ? 0 : 7 + reply[4])
          if (need === 0 || reply.length < need) return
          socket.removeListener('data', onReply)
          socket.removeAllListeners('close')
          if (settled) return
          // Bytes past the end of the reply arrived in the SAME chunk: they are
          // tunnel data, not handshake. Hand them back to the stream (paused, so
          // they cannot be emitted before the caller attaches its pipe) — losing
          // them would truncate the first byte of protocols that answer at once.
          if (reply.length > need) socket.unshift(reply.subarray(need))
          socket.pause()
          settled = true
          clearTimeout(timer)
          resolvePromise(socket)
        }
        socket.on('data', onReply)
      }
      socket.on('data', onData)
    })
  })
}

/**
 * One same-port shadow listener: `127.0.0.1:<localPort>` → SOCKS → `host:port`.
 * A failed UPSTREAM dial is a per-connection event (the tunnel may be down, the
 * target may refuse); only a failed listen() is fatal — a half-up proxy would
 * silently narrow the allow-list, a refused stream just fails that stream.
 */
function startShadow(target, socks, onListenError, onConnError) {
  const server = createServer((client) => {
    connectSocks(socks, target.host, target.port)
      .then((upstream) => {
        client.pipe(upstream)
        upstream.pipe(client)
        const bye = () => { client.destroy(); upstream.destroy() }
        client.on('error', bye)
        upstream.on('error', bye)
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
      })
      .catch((error) => {
        onConnError(target.host, target.port, error)
        client.destroy()
      })
  })
  server.on('error', (error) => onListenError(error))
  server.listen(target.localPort, '127.0.0.1')
  return server
}

/** The loopback CONNECT proxy: destination known per connection ⇒ wildcards work. */
function startConnectProxy(port, state, onFatal, onConnError) {
  // `state.config` is swapped on reload, so the allow-list is evaluated per
  // connection instead of being frozen at listen time (编辑规则无需重启进程).
  const allowNow = (host, targetPort) => {
    const config = state.config
    if (config.rules.filter((rule) => rule.enabled).length === 0) return false
    return allowAdmits(allowList(config), host, targetPort)
  }
  const server = createServer((client) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > HEADER_MAX_BYTES) {
        client.destroy()
        return
      }
      const end = buffered.indexOf('\r\n\r\n')
      const lineEnd = buffered.indexOf('\n')
      if (end === -1 && lineEnd === -1) return
      const head = buffered.subarray(0, end === -1 ? lineEnd : end).toString('latin1')
      const firstLine = head.split('\n')[0].replace(/\r$/, '')
      const connectMatch = /^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine)
      if (connectMatch !== null) {
        client.removeListener('data', onData)
        const host = connectMatch[1]
        const targetPort = Number(connectMatch[2])
        if (!allowNow(host, targetPort)) {
          client.end('HTTP/1.1 403 Forbidden\r\nX-Proxy-Denied: rule\r\n\r\n')
          return
        }
        connectSocks(state.config.socks, host, targetPort)
          .then((upstream) => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            client.pipe(upstream)
            upstream.pipe(client)
            client.on('error', () => upstream.destroy())
            upstream.on('error', () => client.destroy())
            client.on('close', () => upstream.destroy())
            upstream.on('close', () => client.destroy())
          })
          .catch((error) => {
            onConnError(host, targetPort, error)
            client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          })
        return
      }
      // Plain HTTP through a proxy arrives in absolute form: GET http://h:p/path
      const absoluteMatch = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s+(https?):\/\/([^/\s:]+):(\d+)([^\s]*)\s+HTTP\/1\.[01]$/i.exec(firstLine)
      if (absoluteMatch === null) {
        client.end('HTTP/1.1 400 Bad Request\r\nX-Proxy-Error: only CONNECT and absolute-form HTTP are supported\r\n\r\n')
        return
      }
      client.removeListener('data', onData)
      // Destructure by GROUP index: [0] is the whole match, [1] the method,
      // [2] the scheme, [3] host, [4] port, [5] the origin-form remainder.
      // Taking the method from index 0 made the host the scheme (`http`) and the
      // port `NaN`, so every plain-HTTP proxy request was denied — and any that
      // got through would have been rewritten with the wrong request line.
      const [, method, scheme, host, portText, rest] = absoluteMatch
      const targetPort = Number(portText)
      // `https://` cannot ride in absolute form: this request line is plaintext
      // on the wire, so forwarding it to a TLS port would send HTTP to a TLS
      // listener (the origin resets; the caller sees a broken response and no
      // hint why). The only correct spelling of an https URL through this proxy
      // is CONNECT — which already carries the allow-list decision. Fail loud
      // and tell the caller, instead of silently speaking the wrong protocol.
      if (scheme.toLowerCase() === 'https') {
        const reason = 'https:// URLs must use CONNECT: the absolute-form request line is plaintext, but the origin expects TLS. Set HTTPS_PROXY (curl/git do this automatically).\n'
        client.end(
          'HTTP/1.1 400 Bad Request\r\n'
          + 'X-Proxy-Error: https requires CONNECT\r\n'
          + 'Content-Type: text/plain; charset=utf-8\r\n'
          + 'Connection: close\r\n'
          + `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n`
          + reason,
        )
        return
      }
      if (!allowNow(host, targetPort)) {
        client.end('HTTP/1.1 403 Forbidden\r\nX-Proxy-Denied: rule\r\n\r\n')
        return
      }
      connectSocks(state.config.socks, host, targetPort)
        .then((upstream) => {
          const lines = head.split(/\r?\n/)
          lines[0] = `${method} ${rest === '' ? '/' : rest} HTTP/1.1`
          const header = lines.join('\r\n')
          upstream.write(header + '\r\n\r\n')
          const body = buffered.subarray(end === -1 ? buffered.length : end + 4)
          if (body.length > 0) upstream.write(body)
          client.pipe(upstream)
          upstream.pipe(client)
          client.on('error', () => upstream.destroy())
          upstream.on('error', () => client.destroy())
          client.on('close', () => upstream.destroy())
          upstream.on('close', () => client.destroy())
        })
        .catch((error) => {
          onConnError(host, targetPort, error)
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        })
    }
    client.on('data', onData)
    client.on('error', () => client.destroy())
  })
  server.on('error', (error) => onFatal(error))
  server.listen(port, '127.0.0.1')
  return server
}

/**
 * Run the engine in the foreground until killed: the CONNECT proxy plus every
 * shadow listener. One throwing listener fails the whole process — a half-up
 * proxy is worse than a failed one, because the allow-list would silently narrow.
 * @param config - a normalised config.
 * @param options - `{ log }` sink for human-readable lines.
 * @returns a never-resolving promise (resolves only on SIGTERM/SIGINT).
 */
export function runEngine(config, options = {}) {
  const log = typeof options.log === 'function' ? options.log : (line) => console.log(line)
  if (config.socks.host === '' || config.socks.port === 0) throw new Error('上游 SOCKS 地址未配置（.env 的 socks.host / socks.port）')
  const state = { config }
  const servers = []
  const onFatal = (error) => {
    log(`[${PROXY_MARKER}] listener error: ${error?.message ?? error}`)
    shutdown(1)
  }
  // Per-connection failures are routine (target down, tunnel hiccup); log the
  // first few so the panel can show WHY a stream failed, then stay quiet.
  let connErrors = 0
  const onConnError = (host, port, error) => {
    connErrors += 1
    if (connErrors <= 8) log(`[${PROXY_MARKER}] tunnel to ${host}:${port} failed: ${error?.message ?? error}`)
    else if (connErrors === 9) log(`[${PROXY_MARKER}] further tunnel failures suppressed`)
  }
  const proxyServer = startConnectProxy(config.listenPort, state, onFatal, onConnError)
  servers.push(proxyServer)
  log(`[${PROXY_MARKER}] CONNECT proxy 127.0.0.1:${config.listenPort} -> socks5 ${config.socks.host}:${config.socks.port}`)
  /** localPort -> shadow server, so a reload can add/drop single listeners. */
  const shadowServers = new Map()
  const applyShadows = (nextConfig) => {
    // Two hosts mapped to the SAME local port cannot both be bound: the second entry
    // used to overwrite the first in the map, so traffic for host A silently reached
    // host B. Keep the first and say what was dropped.
    const wanted = new Map()
    for (const target of shadowTargets(nextConfig)) {
      if (wanted.has(target.localPort)) {
        const kept = wanted.get(target.localPort)
        log(`[${PROXY_MARKER}] shadow 127.0.0.1:${target.localPort} 已被 ${kept.host}:${kept.port} 占用，忽略 ${target.host}:${target.port}`)
        continue
      }
      wanted.set(target.localPort, target)
    }
    for (const [localPort, server] of shadowServers) {
      if (wanted.has(localPort)) continue
      try { server.close() } catch { /* already gone */ }
      shadowServers.delete(localPort)
      log(`[${PROXY_MARKER}] shadow 127.0.0.1:${localPort} removed`)
    }
    for (const [localPort, target] of wanted) {
      if (shadowServers.has(localPort)) continue
      // A shadow is a convenience (local clients like Navicat dial 127.0.0.1); losing one
      // port must never kill the CONNECT proxy that the enforcement path needs.
      const server = startShadow(target, nextConfig.socks, (error) => {
        log(`[${PROXY_MARKER}] shadow 127.0.0.1:${localPort} 不可用: ${error?.message ?? error}`)
        shadowServers.delete(localPort)
        try { server.close() } catch { /* not listening */ }
      }, onConnError)
      shadowServers.set(localPort, server)
      log(`[${PROXY_MARKER}] shadow 127.0.0.1:${localPort} -> ${target.host}:${target.port}`)
    }
  }
  applyShadows(config)
  /**
   * Re-read the config and apply it without dropping the process: rules are edited
   * while the proxy keeps running (no restart, in-flight connections keep going).
   */
  const reload = () => {
    if (typeof options.readConfig !== 'function') return
    let next = null
    try {
      next = options.readConfig()
    } catch (error) {
      log(`[${PROXY_MARKER}] reload failed: ${error?.message ?? error}`)
      return
    }
    if (next === null || next === undefined) return
    if (next.socks.host === '' || next.socks.port === 0) {
      log(`[${PROXY_MARKER}] reload skipped: SOCKS 上游未配置`)
      return
    }
    state.config = next
    applyShadows(next)
    const enabled = next.rules.filter((rule) => rule.enabled).length
    log(`[${PROXY_MARKER}] reloaded: ${enabled} rules`)
  }
  if (typeof options.readConfig === 'function') {
    if (typeof options.configPath === 'string' && options.configPath !== '') {
      watchFile(options.configPath, { interval: 1000 }, reload)
    } else {
      setInterval(reload, 2000).unref?.()
    }
  }
  let stopped = false
  function shutdown(code) {
    if (stopped) return
    stopped = true
    for (const server of servers) {
      try { server.close() } catch { /* already closed */ }
    }
    setTimeout(() => process.exit(code), 50).unref?.()
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  log(`[${PROXY_MARKER}] ready (${servers.length} listeners)`)
  return new Promise(() => {})
}

/* ------------------------------------------------------------ process life -- */

/** Whether a pid is alive. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * The command line of a pid, or '' when it cannot be read. Linux/WSL read
 * `/proc`; Windows asks CIM (Node has no /proc there, and a pidfile alone must
 * NEVER be enough to justify a kill); macOS uses `ps`.
 * @param pid - candidate process id.
 * @returns the command line text.
 */
export function pidCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  if (IS_WINDOWS) {
    try {
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      return text.trim()
    } catch {
      return ''
    }
  }
  if (process.platform === 'darwin') {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 4000 }).trim()
    } catch {
      return ''
    }
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return ''
  }
}

/** Whether a pid's command line carries our marker (never signal a stranger). */
export function pidIsProxy(pid) {
  if (!pidAlive(pid)) return false
  const commandLine = pidCommandLine(pid)
  return commandLine !== '' && commandLine.includes(PROXY_MARKER)
}

/** The running engine's pid, or null (stale pidfile is removed). */
export function proxyPid(cwd) {
  const path = proxyPidPath()
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  const pid = Number(text)
  if (!Number.isInteger(pid) || pid <= 0) {
    try { unlinkSync(path) } catch { /* ignore */ }
    return null
  }
  if (pidIsProxy(pid)) return pid
  try { unlinkSync(path) } catch { /* ignore */ }
  return null
}

/** Whether something is listening on a loopback port. */
export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const socket = netConnect({ host, port })
    const done = (value) => { socket.destroy(); resolvePromise(value) }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Terminate an engine we ourselves just spawned and that failed to come up.
 *
 * Identity is re-checked before signalling: `pid` comes from our own child, but by the
 * time an 8 s wait is over it may have exited and been recycled — and the marker in
 * argv is the only proof that the process is ours.
 */
async function reapFailedStart(pid, logPath) {
  if (pidIsProxy(pid) !== true) return
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pidAlive(pid) !== true) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  if (IS_WINDOWS) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
  try { appendFileSync(logPath, `[${PROXY_MARKER}] startup failed: process ${pid} killed\n`) } catch { /* ignore */ }
}

/**
 * Start the engine detached, with a pidfile + log, and wait until every listener
 * answers. Verifies identity after the wait: a process that dies or never binds
 * is reported as a failure, never as "started".
 * @param cwd - workspace directory holding `.dsh-ris-ide/`.
 * @param options - `{ config, waitMs }`.
 * @returns `{ ok, pid?, config, error? }`.
 */
export async function startProxy(cwd, options = {}) {
  const config = options.config ?? readProxyConfig(cwd)
  const existing = proxyPid(cwd)
  if (existing !== null) return { ok: true, pid: existing, config, alreadyRunning: true }
  if (config.socks.host === '' || config.socks.port === 0) return { ok: false, config, error: '上游 SOCKS 地址未配置（.env 的 socks.host / socks.port）' }
  const enabled = config.rules.filter((rule) => rule.enabled)
  if (enabled.length === 0) return { ok: false, config, error: '没有启用任何代理规则' }
  // The pidfile and the log live in the machine-wide home, not under the workspace:
  // creating only `cwd/.dsh-ris-ide` (a legacy location) left a fresh home missing and
  // `openSync` failed with ENOENT on the very first start.
  const logPath = proxyLogPath()
  const pidPath = proxyPidPath()
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })
  const out = openSync(logPath, 'a', 0o600)
  // The child re-enters this file as a CLI: `serve` must be a POSITIONAL command
  // (a `--serve` flag would fall through to the default status command).
  // The marker travels in argv: it is the ONLY proof a pid is our engine (a
  // pidfile can be stale, and a recycled pid must never be signalled).
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cwd', cwd, 'serve', `--marker=${PROXY_MARKER}`], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  closeSync(out)
  child.unref()
  try { writeFileSync(pidPath, String(child.pid), { encoding: 'utf8', mode: 0o600 }) } catch { /* ignore */ }
  const ports = [config.listenPort, ...shadowTargets(config).map((target) => target.localPort)]
  const budget = Number.isInteger(options.waitMs) ? options.waitMs : 150
  const rounds = Math.max(1, Math.ceil(8000 / budget))
  for (let round = 0; round < rounds; round += 1) {
    const states = await Promise.all(ports.map((port) => portOpen(port)))
    if (states.every(Boolean) && pidIsProxy(child.pid)) {
      return { ok: true, pid: child.pid, config, ports, logPath }
    }
    if (!pidAlive(child.pid)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, budget))
  }
  // A failed start must not leave a half-up engine behind: it keeps the loopback ports
  // bound, so the next attempt fails with EADDRINUSE for a process nobody can see.
  await reapFailedStart(child.pid, logPath)
  try { unlinkSync(pidPath) } catch { /* ignore */ }
  const tail = readTail(logPath, 2048)
  const reason = pidAlive(child.pid) ? `端口 ${ports.join(', ')} 未就绪或进程身份不匹配` : '进程已退出'
  // EADDRINUSE is the multi-workspace case: every workspace's engine binds the
  // SAME 127.0.0.1 ports, so the second one cannot start — say so instead of
  // leaving the user with a bare port number.
  const busy = /EADDRINUSE/i.test(tail)
  const hint = busy
    ? '\n端口已被占用：通常是另一个工作区的代理引擎绑定着同一批 127.0.0.1 端口。先在那个工作区停止代理（或关掉它的 127.0.0.1 映射），再启动这一个。'
    : ''
  return { ok: false, config, error: `代理未能启动（${reason}）${hint}${tail === '' ? '' : `\n${tail}`}`, logPath }
}

/** Stop the detached engine (TERM → 30 s → KILL). Never signals a stranger. */
export async function stopProxy(cwd, options = {}) {
  const pid = proxyPid(cwd)
  if (pid === null) return { ok: true, stopped: false }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  const grace = Number.isInteger(options.graceMs) ? options.graceMs : 5000
  const deadline = Date.now() + grace
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  }
  if (pidAlive(pid)) {
    // Windows has no SIGKILL worth the name: taskkill /T /F is the tree kill.
    if (IS_WINDOWS) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
    }
  }
  try { unlinkSync(proxyPidPath()) } catch { /* ignore */ }
  return { ok: true, stopped: true, pid }
}

/**
 * Stop the engine from an exit handler.
 *
 * `process.on('exit')` cannot await anything, so this only sends the signal
 * (TERM, then a hard kill on Windows) and unlinks the pidfile; the engine itself
 * shuts its listeners down on TERM. Safe to call when nothing is running.
 * @param cwd - any workspace; the pid/pidfile are machine-wide.
 * @returns the pid that was signalled, or null.
 */
export function stopProxySync(cwd = '') {
  const pid = proxyPid(cwd)
  if (pid === null) return null
  if (IS_WINDOWS) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* already gone */ }
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  try { unlinkSync(proxyPidPath()) } catch { /* ignore */ }
  return pid
}

/** One-shot status for the UI: config, listeners, pid. */
export async function proxyStatus(cwd) {
  const config = readProxyConfig(cwd)
  const pid = proxyPid(cwd)
  const ports = [config.listenPort, ...shadowTargets(config).map((target) => target.localPort)]
  const states = await Promise.all(ports.map((port) => portOpen(port)))
  return {
    config,
    running: pid !== null,
    pid,
    listen: ports.map((port, index) => ({ port, open: states[index] === true })),
    logPath: proxyLogPath(),
    socksUrl: config.socks.host === '' ? null : `socks5h://${config.socks.host}:${config.socks.port}`,
  }
}

/** Tail of a text file (a log we may be appending to in another process). */
export function readTail(path, bytes) {
  try {
    const size = statSync(path).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, length, size - length)
    } finally {
      closeSync(fd)
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

/* -------------------------------------------------------------------- git -- */

/**
 * Apply / clear the SCOPE-LIMITED git proxy: one `http.proxy` entry (global
 * config) pointing at the upstream SOCKS server, so every git caller — the CLI,
 * the IDE, another plugin — uses the tunnel without a per-command flag.
 * @param config - a normalised config.
 * @param options - `{ host, enabled }`; host narrows the entry to one URL prefix.
 * @returns `{ ok, changed, key, value }`.
 */
/**
 * Windows git, as a path this process can execute.
 *
 * The WSL `git` writes `~/.gitconfig` inside Linux; a git started on the Windows side
 * (YonCode, VS Code, a cmd window) reads a different file and its DNS cannot resolve
 * the internal git host at all — so the same scoped proxy has to exist on both sides.
 * `where.exe` is asked each time: cheap, and it follows the user's PATH.
 * @returns {string} an executable path, '' when Windows has no git.
 */
export function windowsGitPath() {
  try {
    const out = spawnSyncImpl('where.exe', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (out.status !== 0) return ''
    const lines = String(out.stdout ?? '').split(/\r?\n/).map((line) => line.trim())
    const exe = lines.find((line) => /git\.exe$/i.test(line) === true)
    if (exe === undefined) return ''
    const mounted = /^([A-Za-z]):\\(.*)$/.exec(exe)
    if (mounted === null) return exe
    return `${mounted[1].toLowerCase() === '' ? '' : `/mnt/${mounted[1].toLowerCase()}/`}${mounted[2].replace(/\\/g, '/')}`
  } catch {
    return ''
  }
}

/**
 * Run the Windows git with one `config --global` mutation.
 * @param {string[]} args - arguments after `config --global`.
 * @returns {{ok: boolean, skipped?: boolean, error?: string}} outcome; a machine
 *   without Windows git reports `skipped` instead of failing the caller.
 */
export function runWindowsGitConfig(args) {
  const exe = windowsGitPath()
  if (exe === '') return { ok: false, skipped: true, error: 'Windows 侧没有 git' }
  try {
    const out = spawnSyncImpl(exe, ['config', '--global', ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (out.status === 0) return { ok: true }
    return { ok: false, error: String(out.stderr ?? '').trim() || `git.exe exited with ${out.status}` }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export function gitProxyPlan(config, options = {}) {
  const host = typeof options.host === 'string' ? options.host.trim() : ''
  const enabled = options.enabled !== false
  const key = host === '' ? 'http.proxy' : `http.https://${host}/.proxy`
  const value = enabled && config.socks.host !== '' ? `socks5h://${config.socks.host}:${config.socks.port}` : ''
  return { ok: true, key, value, host, enabled }
}

/* -------------------------------------------------------------------- cli -- */

/**
 * CLI entry: `node lib/proxy.js --cwd=<dir> <command>`.
 * Commands: `serve` (foreground engine), `start`, `stop`, `status`, `rules`
 * (prints the effective config as JSON), `apply --json=<cfg>|--stdin` (merge
 * rules into the stored config), `git --host=… [--off]`.
 * @param argv - process.argv.slice(2).
 * @returns exit code.
 */
export async function main(argv) {
  const args = argv.slice()
  let cwd = process.cwd()
  const positional = []
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--cwd' || token === '-C') {
      cwd = resolve(args[index + 1] ?? cwd)
      index += 1
      continue
    }
    if (token.startsWith('--cwd=')) {
      cwd = resolve(token.slice('--cwd='.length))
      continue
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2)
      if (inline !== undefined) {
        flags[name] = inline
        continue
      }
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        index += 1
      } else {
        flags[name] = 'true'
      }
      continue
    }
    positional.push(token)
  }
  const command = positional[0] ?? 'status'
  if (!isAbsolute(cwd)) cwd = resolve(cwd)
  if (command === 'serve') {
    await runEngine(readProxyConfig(cwd), {
      log: (line) => console.log(line),
      configPath: proxyConfigPath(),
      readConfig: () => readProxyConfig(cwd),
    })
    return 0
  }
  if (command === 'start') {
    const result = await startProxy(cwd)
    console.log(JSON.stringify(result))
    return result.ok ? 0 : 1
  }
  if (command === 'stop') {
    console.log(JSON.stringify(await stopProxy(cwd)))
    return 0
  }
  if (command === 'status') {
    console.log(JSON.stringify(await proxyStatus(cwd)))
    return 0
  }
  if (command === 'rules') {
    console.log(JSON.stringify(readProxyConfig(cwd)))
    return 0
  }
  if (command === 'apply') {
    let incoming = null
    if (typeof flags.json === 'string' && flags.json !== 'true') {
      incoming = JSON.parse(flags.json)
    } else {
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    const stored = readProxyConfig(cwd)
    const next = mergeConfigs(stored, incoming)
    const written = writeProxyConfig(cwd, next)
    console.log(JSON.stringify({ ok: true, config: written }))
    return 0
  }
  if (command === 'git') {
    const plan = gitProxyPlan(readProxyConfig(cwd), { host: flags.host, enabled: flags.off !== 'true' })
    console.log(JSON.stringify(plan))
    return 0
  }
  console.error(`unknown command "${command}" (serve|start|stop|status|rules|apply|git)`)
  return 2
}

/**
 * Merge an incoming config into the shared one.
 *
 * The file is machine-level, so two workspaces write into the same object. Rule
 * identity is therefore `(workspace, id)`, and `replaceRulesFrom` only clears the
 * rows of ONE owner: the caller passes `{ replaceRulesFrom: '<source>',
 * workspace: '<dir>' }` to refresh its own rows and leave everyone else's alone.
 * @param stored - the config currently in the shared file.
 * @param incoming - partial config from a caller.
 * @returns a normalised merged config.
 */
export function mergeConfigs(stored, incoming) {
  const base = normalizeConfig(stored)
  const patch = incoming !== null && typeof incoming === 'object' ? incoming : {}
  const patchWorkspace = typeof patch.workspace === 'string' ? patch.workspace : undefined
  const mergedRules = base.rules.slice()
  const dropped = new Set()
  // Rules are machine-wide, so a patch never replaces "one workspace's rows":
  // it either replaces all rows of a SOURCE (what the yds bridge does, so a
  // removed endpoint disappears) or upserts rows by id.
  if (typeof patch.replaceRulesFrom === 'string' || patch.replaceRules === true) {
    const source = typeof patch.replaceRulesFrom === 'string' ? patch.replaceRulesFrom : ''
    for (const rule of mergedRules) {
      if (rule.source === source) dropped.add(rule.id)
    }
  }
  if (Array.isArray(patch.rules)) {
    for (const rule of patch.rules) {
      if (rule === null || typeof rule !== 'object') continue
      const id = typeof rule.id === 'string' && rule.id !== '' ? rule.id : `rule-${mergedRules.length + 1}`
      // Keep an existing row's provenance when the caller does not restate it,
      // so editing from a second workspace does not relabel the origin.
      const existing = mergedRules.find((item) => item.id === id)
      const workspace = typeof rule.workspace === 'string' && rule.workspace !== ''
        ? rule.workspace
        : (existing?.workspace ?? patchWorkspace ?? '')
      const index = mergedRules.findIndex((item) => item.id === id)
      const row = {
        id,
        // Provenance label from whoever generated the row ("YonCode java"); an edit
        // that does not restate it keeps the stored one.
        label: typeof rule.label === 'string' && rule.label !== ''
          ? rule.label.trim().slice(0, 60)
          : (existing?.label ?? ''),
        program: typeof rule.program === 'string' ? rule.program : '',
        hosts: typeof rule.hosts === 'string' ? rule.hosts : '',
        ports: typeof rule.ports === 'string' ? rule.ports : '',
        enabled: rule.enabled === true,
        // `undefined` keeps the automatic choice (no mapping for SOCKS-aware
        // programs); a boolean is the caller's explicit decision.
        shadow: typeof rule.shadow === 'boolean' ? rule.shadow : undefined,
        // `undefined` keeps the stored decision: flipping the field on every edit
        // that does not restate it would silently re-enable the allow-list
        // (or silently bypass it, which is worse).
        direct: typeof rule.direct === 'boolean' ? rule.direct : existing?.direct === true,
        source: typeof rule.source === 'string' ? rule.source : 'user',
        workspace,
      }
      if (index === -1) mergedRules.push(row)
      else mergedRules[index] = row
      dropped.delete(id)
    }
  }
  return normalizeConfig({
    socks: patch.socks !== undefined ? patch.socks : base.socks,
    listenPort: patch.listenPort !== undefined ? patch.listenPort : base.listenPort,
    rules: mergedRules.filter((rule) => !dropped.has(rule.id)),
    // The fallback listener list is owned by whoever drives the tunnel, so it is
    // replaced wholesale rather than merged row by row.
    shadows: Array.isArray(patch.shadows) ? patch.shadows : base.shadows,
  })
}

if (process.argv[1] !== undefined && /proxy\.js$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code
  }).catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
}
