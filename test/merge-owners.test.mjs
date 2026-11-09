/**
 * `mergeConfigs` must preserve a rule's per-workspace `owners` map.
 *
 * `yds` writes the map and later withdraws only its own endpoints from it. The
 * read path (`normalizeConfig`) already kept it; the daemon write path rebuilt each
 * row from a fixed field list and dropped it, so one config round trip broke
 * `yds stop` (review B-P0-2 / D-P0-1). These tests pin the write path.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeConfigs, normalizeConfig, normalizeOwners } from '../lib/proxy.js'

// The canonical (normalized) shape: hosts/ports are comma strings.
const ydsOwners = () => ({
  '/ws/a': { program: 'java', hosts: '10.0.0.1', ports: '3306', enabled: true, shadow: false, direct: false },
})

/** A stored table: one driven (`yds`) row with owners, one user row. */
function storedConfig() {
  return normalizeConfig({
    socks: { host: '127.0.0.1', port: 1080 },
    listenPort: 7890,
    rules: [
      {
        id: 'yds-java',
        label: 'YonCode java',
        program: 'java',
        hosts: '10.0.0.1',
        ports: '3306',
        enabled: true,
        source: 'yds',
        workspace: '/ws/a',
        owners: ydsOwners(),
      },
      { id: 'user-curl', program: 'curl', hosts: '10.0.0.2', ports: '80', enabled: true, source: 'user', workspace: '/ws/b' },
    ],
    shadows: [],
  })
}

const row = (config, id) => config.rules.find((item) => item.id === id)

test('a driven row keeps its owners across the write path when the patch restates them', () => {
  const merged = mergeConfigs(storedConfig(), {
    replaceRulesFrom: 'yds',
    rules: [{
      id: 'yds-java',
      program: 'java',
      hosts: '10.0.0.7',
      ports: '3306',
      enabled: true,
      source: 'yds',
      owners: {
        '/ws/a': { program: 'java', hosts: ['10.0.0.7'], ports: ['3306'], enabled: true },
        '/ws/c': { program: 'java', hosts: ['10.0.0.7'], ports: ['3306'], enabled: true },
      },
    }],
  })
  const owners = row(merged, 'yds-java').owners
  assert.deepEqual(Object.keys(owners).sort(), ['/ws/a', '/ws/c'])
  assert.equal(owners['/ws/a'].hosts, '10.0.0.7', 'arrays are stored as the canonical comma string')
  assert.equal(owners['/ws/a'].program, 'java')
})

test('a whole-source replacement does not inherit owners the patch does not restate', () => {
  const merged = mergeConfigs(storedConfig(), {
    replaceRulesFrom: 'yds',
    rules: [{ id: 'yds-java', program: 'java', hosts: '10.0.0.3', ports: '3306', enabled: true, source: 'yds' }],
  })
  assert.equal(row(merged, 'yds-java').owners, undefined, 'the replacement is a delete-and-recreate, not an edit')
})

test('editing a different row never loses the driven row owners', () => {
  const merged = mergeConfigs(storedConfig(), {
    rules: [{ id: 'user-curl', program: 'curl', hosts: '10.0.0.2', ports: '81', enabled: true, source: 'user' }],
  })
  assert.equal(row(merged, 'user-curl').ports, '81')
  assert.deepEqual(row(merged, 'yds-java').owners, ydsOwners())
})

test('editing the driven row without restating owners inherits the stored map', () => {
  const merged = mergeConfigs(storedConfig(), {
    rules: [{ id: 'yds-java', program: 'java', hosts: '10.0.0.9', ports: '3306', enabled: true, source: 'yds' }],
  })
  assert.equal(row(merged, 'yds-java').hosts, '10.0.0.9')
  assert.deepEqual(row(merged, 'yds-java').owners, ydsOwners(), 'a plain edit is not a withdrawal')
})

test('normalizeOwners whitelists the known fields and drops unusable entries', () => {
  assert.equal(normalizeOwners(null), undefined)
  assert.equal(normalizeOwners([]), undefined)
  assert.equal(normalizeOwners({}), undefined)
  assert.equal(normalizeOwners({ '/ws/x': {} }), undefined, 'an entry without a program is dropped')
  assert.equal(normalizeOwners({ '/ws/x': { program: '   ' } }), undefined)
  assert.equal(normalizeOwners({ '/ws/x': 'nope' }), undefined)
  assert.deepEqual(
    normalizeOwners({ '/ws/x': { program: ' java ', hosts: '1.2.3.4', ports: ['80', '443'], enabled: 1, extra: 'dropped' } }),
    { '/ws/x': { program: 'java', hosts: '1.2.3.4', ports: '80,443', enabled: false, shadow: false, direct: false } },
  )
})

// --- yds upgrade contract (D 段已提交 d305fd5) -----------------------------
// 1. Rows migrated from before owners existed are filed under the reserved
//    `<legacy>` bucket: it is not a workspace path, so nothing may normalise or
//    drop it, and a workspace stop must never withdraw it.
test('the reserved <legacy> owner bucket survives both write paths untouched', () => {
  const legacy = { program: 'java', hosts: ['10.0.0.1'], ports: ['3306'], enabled: true }
  const stored = normalizeConfig({
    socks: { host: '127.0.0.1', port: 1080 },
    listenPort: 7890,
    rules: [{ id: 'yds-java', program: 'java', hosts: '10.0.0.1', ports: '3306', enabled: true, source: 'yds', workspace: '/ws/a', owners: { '<legacy>': legacy } }],
    shadows: [],
  })
  assert.deepEqual(Object.keys(row(stored, 'yds-java').owners), ['<legacy>'])

  const edited = mergeConfigs(stored, {
    rules: [{ id: 'yds-java', program: 'java', hosts: '10.0.0.2', ports: '3306', enabled: true, source: 'yds' }],
  })
  assert.deepEqual(row(edited, 'yds-java').owners, {
    '<legacy>': { program: 'java', hosts: '10.0.0.1', ports: '3306', enabled: true, shadow: false, direct: false },
  })

  const replaced = mergeConfigs(stored, {
    replaceRulesFrom: 'yds',
    rules: [{ id: 'yds-java', program: 'java', hosts: '10.0.0.2', ports: '3306', enabled: true, source: 'yds', owners: { '<legacy>': legacy } }],
  })
  assert.deepEqual(Object.keys(row(replaced, 'yds-java').owners), ['<legacy>'])
})

// 2. A slug conflict makes the driver suffix the id with a short hash; the id is
//    the dedupe key (`yds\0id`) and must be stored verbatim.
test('a hashed driven id is preserved verbatim (dedupe key is the id itself)', () => {
  const merged = mergeConfigs(storedConfig(), {
    replaceRulesFrom: 'yds',
    rules: [{ id: 'yds-java-1a2b3c', program: 'java', hosts: '10.0.0.1', ports: '3306', enabled: true, source: 'yds' }],
  })
  const driven = merged.rules.filter((item) => item.source === 'yds')
  assert.deepEqual(driven.map((item) => item.id), ['yds-java-1a2b3c'])
})

// 3. The driver's POST /v1/proxy no longer sends `shadows`; a missing field must
//    keep the stored fallback listeners rather than silently dropping them.
test('a patch without shadows keeps the stored fallback listeners', () => {
  const stored = normalizeConfig({
    socks: { host: '127.0.0.1', port: 1080 },
    listenPort: 7890,
    rules: [{ id: 'user-curl', program: 'curl', hosts: '10.0.0.2', ports: '80', enabled: true, source: 'user' }],
    shadows: [{ host: '10.0.0.5', port: 3306 }],
  })
  const merged = mergeConfigs(stored, {
    rules: [{ id: 'user-curl', program: 'curl', hosts: '10.0.0.2', ports: '80', enabled: true, source: 'user' }],
  })
  assert.deepEqual(merged.shadows, [{ host: '10.0.0.5', port: 3306, localPort: 3306 }])
})
