import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPlanFor } from '../lib/index.js'

/**
 * A clone without node_modules is the common case for a fresh frontend checkout:
 * the panel must install before it runs, and the log has to say so.
 */
test('installPlanFor installs only when dependencies are missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  // No package.json: not a node project at all.
  assert.equal(installPlanFor(root), null)

  writeFileSync(join(root, 'package.json'), '{"name":"demo"}')
  assert.deepEqual(installPlanFor(root), { pm: 'npm', args: ['install', '--no-audit', '--no-fund'], dir: root })

  // An empty node_modules is what a killed install leaves behind.
  mkdirSync(join(root, 'node_modules'))
  assert.notEqual(installPlanFor(root), null)

  writeFileSync(join(root, 'node_modules', 'leftover'), '')
  assert.equal(installPlanFor(root), null)

  // Lockfile decides the package manager.
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  assert.equal(installPlanFor(root)?.pm, 'pnpm')
  rmSync(join(root, 'pnpm-lock.yaml'))
  writeFileSync(join(root, 'yarn.lock'), '')
  assert.equal(installPlanFor(root)?.pm, 'yarn')

  rmSync(root, { recursive: true, force: true })
})
