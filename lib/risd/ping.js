/**
 * Reachability probe for the SOCKS upstream shown on the proxy tab.
 *
 * The page used to render "unreachable" only after the engine failed to reload, so a
 * wrong host/port looked identical to a healthy one until the first request failed.
 * The probe connects to the configured SOCKS endpoint and performs the SOCKS5
 * greeting: a plain TCP accept is not enough (a random service on that port answers
 * too), while requiring a `05 00` answer also tells the user their SOCKS server is
 * up and does not need authentication.
 *
 * m03429: a SOCKS5 greeting is still only half the story — a server can answer
 * `05 00` and then refuse (or hang on) every CONNECT, which is exactly the failure
 * a tunnel user hits. When a destination is known (`target`, derived from the rule
 * table/shadows on the proxy tab) the probe finishes the handshake with a real
 * CONNECT and reports `usable`: `true` = the far side forwarded a connection,
 * `false` = handshake fine but forwarding failed (the error says why), `null` =
 * nothing to verify against (greeting only). The K8s/CI runner has no upstream, so
 * this stays a single short-lived socket with no retries.
 *
 * Deliberately dependency-free and side-effect-free (one short-lived socket, no
 * retries): the page polls it every few seconds.
 *
 * @module risd/ping
 */
import { createConnection } from 'node:net'

import { parseHostSpec, parsePortSpec } from '../proxy.js'

const GREETING = Buffer.from([0x05, 0x01, 0x00])

/** SOCKS5 reply codes → the phrase the chip's tooltip shows. */
const REPLY_TEXT = {
  1: '通用失败',
  2: '规则不允许该连接',
  3: '网络不可达',
  4: '主机不可达',
  5: '连接被拒绝',
  6: 'TTL 过期',
  7: '不支持该命令',
  8: '不支持该地址类型',
}

/**
 * Pick a destination that proves the tunnel really forwards.
 *
 * The proxy tab can only verify "SOCKS is usable" against a real destination, and
 * the only destinations it knows are the ones the user configured: the loopback
 * mapping shadows (already concrete) or the first rule that names a literal host and
 * port. A wildcard cannot be probed (which port would that be?), so such rows are
 * skipped instead of guessed — a guessed port would report a healthy tunnel as broken.
 *
 * @param config - normalized proxy config (`lib/proxy.js#normalizeConfig`).
 * @returns `{host: string, port: number}` or null when nothing is concrete enough.
 */
export function probeTarget(config) {
  const shadows = Array.isArray(config?.shadows) ? config.shadows : []
  for (const entry of shadows) {
    const host = typeof entry?.host === 'string' ? entry.host.trim() : ''
    const port = Number(entry?.port)
    if (host !== '' && Number.isInteger(port) && port > 0 && port < 65536) return { host, port }
  }
  const rules = Array.isArray(config?.rules) ? config.rules : []
  for (const rule of rules) {
    if (rule?.enabled !== true) continue
    const hosts = parseHostSpec(rule.hosts).patterns.filter((pattern) => !pattern.includes('*'))
    const ports = parsePortSpec(rule.ports).ports.filter((port) => Number.isInteger(port) && port > 0)
    if (hosts.length === 0 || ports.length === 0) continue
    return { host: hosts[0], port: ports[0] }
  }
  return null
}

/** The target shape the probe accepts, or null when it cannot be dialled. */
function normalizeTarget(target) {
  if (target === null || typeof target !== 'object') return null
  const host = typeof target.host === 'string' ? target.host.trim() : ''
  const port = Number(target.port)
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** SOCKS5 CONNECT request for a host:port (`socks5h` semantics: name, not IP). */
function connectRequest(target) {
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.host)
  if (ipv4) {
    const parts = target.host.split('.').map(Number)
    return Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts, Math.floor(target.port / 256), target.port % 256])
  }
  const name = Buffer.from(target.host, 'utf8')
  if (name.length > 255) return null
  return Buffer.from([0x05, 0x01, 0x00, 0x03, name.length, ...name, Math.floor(target.port / 256), target.port % 256])
}

/**
 * Probe a SOCKS5 endpoint.
 * @param {{host: string, port: number, timeoutMs?: number, connect?: Function, target?: {host: string, port: number}}} options
 *   `host`/`port` of the SOCKS server; `target` is the destination the CONNECT step
 *   is proven against (omit it to only verify the greeting); `connect` is injectable
 *   for tests.
 * @returns {Promise<{ok: boolean, socks: boolean, usable: boolean|null, ms: number, at: string, host: string, port: number, target: {host: string, port: number}|null, error?: string}>}
 *   `ok` is the chip's "healthy" verdict, so a greeting that cannot forward to the
 *   configured destination is NOT ok — that is the whole point of m03429.
 */
export function pingSocks(options = {}) {
  const host = typeof options.host === 'string' ? options.host.trim() : ''
  const port = Number(options.port)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(200, Number(options.timeoutMs)) : 2000
  const target = normalizeTarget(options.target)
  const at = new Date().toISOString()
  const base = { host, port, at, ms: 0, socks: false, usable: null, target }
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ...base, ok: false, error: host === '' ? '未配置代理服务器地址' : '端口无效' })
  }
  const started = Date.now()
  const connect = typeof options.connect === 'function' ? options.connect : createConnection
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    let timer = null
    let phase = 'greeting'
    let buffer = Buffer.alloc(0)
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try { socket?.destroy() } catch { /* already gone */ }
      resolve({ ...base, ms: Date.now() - started, ...result })
    }
    const forwardingError = (reason) => ({
      ok: false,
      socks: true,
      usable: false,
      error: `SOCKS5 握手正常，但无法转发到 ${target.host}:${target.port}（${reason}）`,
    })
    timer = setTimeout(() => {
      finish(phase === 'connect'
        ? forwardingError('转发超时')
        : { ok: false, error: `连接超时（${timeoutMs} ms）` })
    }, timeoutMs)
    timer.unref?.()
    try {
      socket = connect({ host, port })
      socket.setTimeout?.(timeoutMs, () => finish(phase === 'connect'
        ? forwardingError('转发超时')
        : { ok: false, error: `连接超时（${timeoutMs} ms）` }))
      socket.once('error', (error) => {
        finish({ ok: false, error: describeError(error) })
      })
      socket.once('connect', () => {
        socket.write(GREETING)
      })
      // A peer may accept the connection and close it without ever answering the
      // greeting. Waiting for the timeout would report a healthy-but-silent SOCKS
      // server as 「连接超时」 2 s later; report the FIN immediately instead.
      const closedEarly = () => finish(phase === 'connect'
        ? { ok: false, socks: true, usable: false, error: '连接被关闭（代理未返回 CONNECT 响应）' }
        : { ok: false, socks: false, error: '连接被关闭（代理未返回 SOCKS5 握手响应）' })
      socket.once('end', closedEarly)
      socket.once('close', closedEarly)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (phase === 'greeting') {
          if (buffer.length < 2) return
          if (buffer[0] !== 0x05) {
            finish({ ok: false, socks: false, error: '端口有服务但不是 SOCKS5（握手版本不符）' })
            return
          }
          if (buffer[1] !== 0x00) {
            finish({ ok: false, socks: true, error: 'SOCKS5 要求认证（仅支持无认证代理）' })
            return
          }
          // Greeting accepted. Without a concrete destination the handshake is all
          // the evidence there is; say so instead of inventing a verdict.
          if (target === null) {
            finish({ ok: true, socks: true, usable: null })
            return
          }
          const request = connectRequest(target)
          if (request === null) {
            finish({ ok: true, socks: true, usable: null })
            return
          }
          phase = 'connect'
          buffer = Buffer.alloc(0)
          try { socket.write(request) } catch (error) {
            finish(forwardingError(describeError(error)))
          }
          return
        }
        // CONNECT verdict: 05 | REP | 00 | ATYP | BND.ADDR | BND.PORT
        if (buffer.length < 2) return
        const rep = buffer[1]
        if (rep !== 0x00) {
          finish(forwardingError(REPLY_TEXT[rep] ?? `错误码 ${rep}`))
          return
        }
        finish({ ok: true, socks: true, usable: true })
      })
    } catch (error) {
      finish({ ok: false, error: describeError(error) })
    }
  })
}

function describeError(error) {
  const code = String(error?.code ?? '')
  if (code === 'ECONNREFUSED') return '连接被拒绝（端口没有服务）'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '主机名解析失败'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达'
  if (code === 'ETIMEDOUT') return '连接超时'
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被重置（对端不是 SOCKS5 或已关闭）'
  return String(error?.message ?? error ?? '连接失败')
}
