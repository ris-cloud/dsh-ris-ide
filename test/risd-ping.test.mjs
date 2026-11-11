// The proxy tab's reachability chip. It must tell three states apart — a working
// SOCKS5 upstream, a port that answers but is not SOCKS5, and nothing listening —
// because the old UI showed "unreachable" only after a failed reload.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import { pingSocks } from '../lib/risd/ping.js'

/** A server that answers the SOCKS5 greeting with `reply`. */
function fakeServer(reply) {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', () => socket.write(reply))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('a SOCKS5 server that accepts no-auth reports connected with a time', async () => {
  const { server, port } = await fakeServer(Buffer.from([0x05, 0x00]))
  try {
    const result = await pingSocks({ host: '127.0.0.1', port, timeoutMs: 1500 })
    assert.equal(result.ok, true)
    assert.equal(result.socks, true)
    assert.equal(result.host, '127.0.0.1')
    assert.equal(result.port, port)
    assert.ok(Number.isInteger(result.ms) && result.ms >= 0)
    assert.equal(typeof result.at, 'string')
  } finally {
    server.close()
  }
})

test('a port that answers but is not SOCKS5 is amber, not silently fine', async () => {
  const { server, port } = await fakeServer(Buffer.from('HTTP/1.1 400 Bad Request\r\n'))
  try {
    const result = await pingSocks({ host: '127.0.0.1', port, timeoutMs: 1500 })
    assert.equal(result.ok, false)
    assert.equal(result.socks, false)
    assert.match(result.error, /不是 SOCKS5/)
  } finally {
    server.close()
  }
})

test('a SOCKS5 server that demands authentication is reported as requiring it', async () => {
  const { server, port } = await fakeServer(Buffer.from([0x05, 0x02]))
  try {
    const result = await pingSocks({ host: '127.0.0.1', port, timeoutMs: 1500 })
    assert.equal(result.ok, false)
    assert.equal(result.socks, true)
    assert.match(result.error, /认证/)
  } finally {
    server.close()
  }
})

test('nothing listening is a clear "refused" answer, never a throw', async () => {
  // Bind and close to get a port that is almost certainly free.
  const { server, port } = await fakeServer(Buffer.from([0x05, 0x00]))
  await new Promise((resolve) => server.close(resolve))
  const result = await pingSocks({ host: '127.0.0.1', port, timeoutMs: 800 })
  assert.equal(result.ok, false)
  assert.equal(result.socks, false)
  assert.match(result.error, /拒绝|超时|重置|失败/)
})

test('a missing host or a bad port is answered without opening a socket', async () => {
  const empty = await pingSocks({ host: '', port: 1080 })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /未配置/)

  let opened = 0
  const spy = () => { opened += 1; throw new Error('must not connect') }
  const badPort = await pingSocks({ host: '127.0.0.1', port: 0, connect: spy })
  assert.equal(badPort.ok, false)
  assert.equal(opened, 0)
})

test('a peer that accepts then closes without answering is reported immediately (review A3-P2-2)', async () => {
  // A SOCKS server that dies right after accept used to look identical to a slow
  // one for the full timeout: the chip said 「连接超时」 2 s later. A FIN is an
  // answer, so report it as such.
  const server = createServer((socket) => socket.destroy())
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    const started = Date.now()
    const result = await pingSocks({ host: '127.0.0.1', port, timeoutMs: 2000 })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.socks, false)
    assert.match(result.error, /连接被关闭|连接被重置/)
    assert.ok(elapsed < 1200, `a FIN must not wait for the timeout (took ${elapsed} ms)`)
  } finally {
    server.close()
  }
})

