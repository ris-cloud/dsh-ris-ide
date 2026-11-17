// The maintenance page's build stamp: "which daemon code is this process running,
// and what would a restart load?". It is computed from file metadata only — never
// contents — and cached briefly because /v1/health is polled (review A3-P2-9).
import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILD_STAMP_TTL_MS, UI_SOURCE_FILES, __test, buildStamp } from '../lib/risd/build.js'

test('buildStamp is stable metadata and a short cache does not change it (review A3-P2-9)', () => {
  const first = buildStamp()
  assert.match(first, /^[0-9a-f]{12}$/, 'twelve hex chars identify the daemon code')
  assert.equal(buildStamp(), first, 'the cache returns the same stamp for unchanged files')
  assert.equal(BUILD_STAMP_TTL_MS, 5000, 'health may lag up to five seconds, not minutes')
  assert.ok(UI_SOURCE_FILES.length >= 10, 'the stamp covers the modules the page renders')

  // A forced recompute over unchanged files must agree: the stamp is a function of
  // size+mtime, not of how many times it was asked.
  __test.resetBuildStampCache()
  assert.equal(buildStamp(), first)
})
