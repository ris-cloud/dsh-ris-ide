/**
 * The two inline "GUI side" routes (`/opens`, `/debugs`) are for the page served on
 * this machine, not for the LAN: like the other host routes they must refuse a
 * request whose Host authority is not loopback, or whose Origin does not match it.
 * A browser on another origin (or a DNS-rebinding attacker) must not be able to
 * read the pending-open stack or the debug-session list.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'ris-noloop-'))
process.env.DSH_RIS_IDE_PROXY_HOME = home

const { __test } = await import('../lib/index.js')
const { handleRequest, OPENS_PATH, DEBUGS_PATH } = __test

async function withServer(run) {
  const server = createServer((req, res) => { handleRequest({ sessions: { get: () => undefined } }, req, res, { maxBytes: 1024, restrictToCwd: false }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await run({ port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** One GET with arbitrary Host/Origin headers; resolves `{ status, body }`. */
function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    call.on('error', reject)
    call.end()
  })
}

test('GUI-side routes refuse a non-loopback Host', async () => {
  await withServer(async ({ port }) => {
    for (const path of [OPENS_PATH, DEBUGS_PATH]) {
      const foreignHost = await get(port, path, { host: 'evil.example' })
      assert.equal(foreignHost.status, 403, `${path} must refuse a foreign Host`)
      assert.equal(JSON.parse(foreignHost.body).code, 'forbidden')
    }
  })
})

test('GUI-side routes refuse a non-loopback Origin even with a loopback Host', async () => {
  await withServer(async ({ port }) => {
    for (const path of [OPENS_PATH, DEBUGS_PATH]) {
      const foreignOrigin = await get(port, path, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' })
      assert.equal(foreignOrigin.status, 403, `${path} must refuse a foreign Origin`)
    }
  })
})

test('GUI-side routes still answer a same-origin loopback request', async () => {
  await withServer(async ({ port }) => {
    const opens = await get(port, OPENS_PATH, { host: `127.0.0.1:${port}` })
    assert.equal(opens.status, 200)
    assert.equal(JSON.parse(opens.body).ok, true)
    const debugs = await get(port, DEBUGS_PATH, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })
    assert.equal(debugs.status, 200)
    assert.equal(JSON.parse(debugs.body).ok, true)
  })
})
