/**
 * The standalone window routes: one self-contained page that does NOT boot the
 * DSH frontend. The page loads this plugin's OWN browser half plus a vendored
 * React, so the window carries no session, no conversation and no other plugin
 * bundle — the whole point of keeping it open all day.
 *
 * Same harness style as host-tail.test.mjs: a real node:http listener over
 * `handleRequest`, so the browser's actual requests are what is asserted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'

import { __test } from '../lib/index.js'

const { handleRequest, WINDOW_PAGE_PATH, WINDOW_APP_PATH, WINDOW_VENDOR_PREFIX } = __test

/** Serve `handleRequest` on a loopback port and return its base URL. */
async function startHost() {
  const server = createServer((req, res) => {
    handleRequest({}, req, res, {})
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

/** One request; resolves with status, headers and the body as a string. */
function request(base, path, options = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest(`${base}${path}`, { method: options.method ?? 'GET' }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => done({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', fail)
    req.end()
  })
}

test('the standalone window page is a self-contained HTML document', async () => {
  const host = await startHost()
  try {
    const page = await request(host.base, WINDOW_PAGE_PATH)
    assert.equal(page.status, 200)
    assert.match(page.headers['content-type'], /text\/html/)
    // Root base: every `/dsh-ris-ide/*` fetch from the panel then lands on the
    // same origin/port the DSH page uses (same cookie, no proxy, no new server).
    assert.match(page.body, /<base href="\/"/)
    // Vendored React first, then the plugin's own browser half, then the boot.
    const vendorAt = page.body.indexOf('window/vendor/react.js')
    const appAt = page.body.indexOf('window/app.js')
    assert.ok(vendorAt > 0, 'the page loads the vendored React')
    assert.ok(appAt > vendorAt, 'the browser half loads after React')
    assert.match(page.body, /__ModuleLoader__/, 'the page shims the module loader')
    assert.match(page.body, /mountStandalone/, 'and calls the standalone mount entry')
    // Script-opened windows may size themselves: the page fills the work area so
    // the IDE opens "maximized" even when the opener size is clamped.
    assert.match(page.body, /window\.moveTo\(0, 0\)/, 'the page repositions itself to the screen origin')
    assert.match(page.body, /window\.resizeTo\(window\.screen\.availWidth, window\.screen\.availHeight\)/, 'and fills the work area')
  } finally {
    await host.close()
  }
})

test('the window app route serves the same hand-written client half', async () => {
  const host = await startHost()
  try {
    const app = await request(host.base, WINDOW_APP_PATH)
    assert.equal(app.status, 200)
    assert.match(app.headers['content-type'], /text\/javascript/)
    assert.match(app.headers['cache-control'], /no-cache/)
    assert.match(app.body, /window\.__ModuleLoader__\.load/)
    assert.match(app.body, /exports\.mountStandalone = /, 'the mount entry ships in the bundle')
  } finally {
    await host.close()
  }
})

test('the vendored React UMD files are served under the vendor prefix', async () => {
  const host = await startHost()
  try {
    const react = await request(host.base, `${WINDOW_VENDOR_PREFIX}react.js`)
    assert.equal(react.status, 200)
    assert.match(react.headers['content-type'], /text\/javascript/)
    assert.ok(react.body.length > 5000, 'the real UMD build, not a stub')
    assert.match(react.body, /createElement/)

    const reactDom = await request(host.base, `${WINDOW_VENDOR_PREFIX}react-dom.js`)
    assert.equal(reactDom.status, 200)
    assert.ok(reactDom.body.length > 100000, 'react-dom UMD with the client entry')
    assert.match(reactDom.body, /createRoot/)
  } finally {
    await host.close()
  }
})

test('unknown vendor assets and non-GET window requests are refused', async () => {
  const host = await startHost()
  try {
    const unknown = await request(host.base, `${WINDOW_VENDOR_PREFIX}../client.js`)
    assert.equal(unknown.status, 404, 'only the two mapped names are servable')

    const missing = await request(host.base, `${WINDOW_VENDOR_PREFIX}lodash.js`)
    assert.equal(missing.status, 404)

    const post = await request(host.base, WINDOW_PAGE_PATH, { method: 'POST' })
    assert.equal(post.status, 405)
  } finally {
    await host.close()
  }
})
