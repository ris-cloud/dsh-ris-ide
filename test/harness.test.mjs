/**
 * Portability guard for the test harness itself.
 *
 * `npm test` must work on a bare clone: no `npm install`, no network, no
 * internal/machine-specific paths. That is easy to break by accident (a
 * helpful default pointing at a colleague's checkout, an SSR fixture pulled
 * from a private registry), so these checks fail loudly when it happens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = 'test/harness.test.mjs'

// Assembled from parts so this file does not trip its own scan.
const HOME_DIR = new RegExp(['', 'home', '[^/\\\\\\s]+', ''].join('/'))
const USERS_DIR = new RegExp(['', 'Users', '[^/\\\\\\s]+', ''].join('/'))
const WINDOWS_USERS = new RegExp(['[A-Za-z]:\\\\', 'Users', '[^\\\\\\s]+'].join('\\\\'))
const INTERNAL_HOSTS = /jk\.ris\.com\.cn|ris\.com\.cn(?![a-z])/i

/** Every tracked source/doc file the guard looks at (`node_modules` and the vendored bundles are skipped). */
async function sourceFiles() {
  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'vendor') continue
        await walk(path)
        continue
      }
      if (!/\.(mjs|js|json|md|yml|yaml)$/.test(entry.name)) continue
      if (entry.name === 'client-codemirror.js' || entry.name === 'client.js' && dir === 'lib') continue
      if (path === SELF) continue
      out.push(path)
    }
  }
  for (const dir of ['test', 'lib', 'bin', 'skills']) await walk(dir)
  for (const file of ['package.json', 'README.md', 'DEVELOPMENT.md', 'cordis.patch.yml']) out.push(file)
  return out
}

test('the test harness carries no machine-specific path', async () => {
  const offenders = []
  for (const file of await sourceFiles()) {
    const text = await readFile(join(ROOT, file), 'utf8')
    for (const [name, re] of [['home dir', HOME_DIR], ['macOS home', USERS_DIR], ['Windows home', WINDOWS_USERS]]) {
      const match = text.match(re)
      if (match) offenders.push(`${file}: ${name} → ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [], 'test/docs must not hard-code a machine path (use a relative candidate or an env var)')
})

test('no internal/private host leaks into tests or docs', async () => {
  const offenders = []
  for (const file of await sourceFiles()) {
    const match = (await readFile(join(ROOT, file), 'utf8')).match(INTERNAL_HOSTS)
    if (match) offenders.push(`${file}: ${match[0]}`)
  }
  assert.deepEqual(offenders, [], 'public files use placeholders such as <internal-nexus>/<internal-git>')
})

test('npm test needs no install and no network', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"', 'test script stays dependency-free (node:test only)')
  for (const hook of ['pretest', 'posttest']) {
    assert.equal(pkg.scripts[hook], undefined, `${hook} must not exist, or npm test stops being self-contained`)
  }
  // react/react-dom are optional extras: `npm install` provides them for the SSR
  // assertions, a bare clone falls back to the stub and skips those.
  assert.ok(pkg.devDependencies.react, 'react is a devDependency (public registry), never a runtime dependency')
  assert.ok(pkg.devDependencies['react-dom'], 'react-dom is a devDependency (public registry)')
})

test('test files import only builtins and relative modules', async () => {
  const dir = join(ROOT, 'test')
  const offenders = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.test.mjs')) continue
    if (relative(ROOT, join(dir, name)) === SELF) continue
    const text = await readFile(join(dir, name), 'utf8')
    for (const match of text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = match[1]
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue
      offenders.push(`${name}: ${spec}`)
    }
  }
  assert.deepEqual(offenders, [], 'a test importing a package would need npm install (and a registry) to run')
})
