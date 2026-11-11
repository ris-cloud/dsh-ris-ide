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
 * Deliberately dependency-free and side-effect-free (one short-lived socket, no
 * retries): the page polls it every few seconds.
 *
 * @module risd/ping
 */
import { createConnection } from 'node:net'

const GREETING = Buffer.from([0x05, 0x01, 0x00])

/**
 * Probe a SOCKS5 endpoint.
 * @param {{host: string, port: number, timeoutMs?: number, connect?: Function}} options
 *   `host`/`port` of the SOCKS server; `connect` is injectable for tests.
 * @returns {Promise<{ok: boolean, socks: boolean, ms: number, at: string, host: string, port: number, error?: string}>}
 */
export function pingSocks(options = {}) {
  const host = typeof options.host === 'string' ? options.host.trim() : ''
  const port = Number(options.port)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(200, Number(options.timeoutMs)) : 2000
  const at = new Date().toISOString()
  const base = { host, port, at, ms: 0, socks: false }
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ...base, ok: false, error: host === '' ? '未配置代理服务器地址' : '端口无效' })
  }
  const started = Date.now()
  const connect = typeof options.connect === 'function' ? options.connect : createConnection
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try { socket?.destroy() } catch { /* already gone */ }
      resolve({ ...base, ms: Date.now() - started, ...result })
    }
    timer = setTimeout(() => finish({ ok: false, error: `连接超时（${timeoutMs} ms）` }), timeoutMs)
    timer.unref?.()
    try {
      socket = connect({ host, port })
      socket.setTimeout?.(timeoutMs, () => finish({ ok: false, error: `连接超时（${timeoutMs} ms）` }))
      socket.once('error', (error) => {
        finish({ ok: false, error: describeError(error) })
      })
      socket.once('connect', () => {
        socket.write(GREETING)
      })
      // A peer may accept the connection and close it without ever answering the
      // greeting. Waiting for the timeout would report a healthy-but-silent SOCKS
      // server as 「连接超时」 2 s later; report the FIN immediately instead.
      socket.once('end', () => finish({ ok: false, socks: false, error: '连接被关闭（代理未返回 SOCKS5 握手响应）' }))
      socket.once('close', () => finish({ ok: false, socks: false, error: '连接被关闭（代理未返回 SOCKS5 握手响应）' }))
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 2) return
        clearTimeout(timer)
        if (buffer[0] !== 0x05) {
          finish({ ok: false, socks: false, error: '端口有服务但不是 SOCKS5（握手版本不符）' })
          return
        }
        if (buffer[1] !== 0x00) {
          finish({ ok: false, socks: true, error: 'SOCKS5 要求认证（仅支持无认证代理）' })
          return
        }
        finish({ ok: true, socks: true })
      })
    } catch (error) {
      clearTimeout(timer)
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
