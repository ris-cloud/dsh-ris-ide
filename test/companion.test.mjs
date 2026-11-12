// The two plugins must stay usable standalone, so the companion hint is a
// RECOMMENDATION that only appears when the workspace really looks like a
// YonBIP/YMS project — never on an ordinary Java/Vue repo.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __test } from '../lib/index.js'

const { detectCompanionPlugin, renderProgramList } = __test

function workspace() {
  return mkdtempSync(join(tmpdir(), 'ris-companion-'))
}

test('a plain workspace gets no companion hint', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'pom.xml'), '<project/>')
    assert.equal(detectCompanionPlugin(dir), null)
    assert.doesNotMatch(renderProgramList({ root: dir, dir, programs: [] }), /dsh-ris-yds/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('yms-home marks the workspace as YonBIP/YMS', () => {
  const dir = workspace()
  try {
    mkdirSync(join(dir, 'yms-home'))
    const found = detectCompanionPlugin(dir)
    assert.equal(found.plugin, 'dsh-ris-yds')
    assert.match(found.detected, /yms-home/)
    assert.match(found.hint, /YMS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('.vscode/settings.json with yds.* marks it too', () => {
  const dir = workspace()
  try {
    mkdirSync(join(dir, '.vscode'))
    writeFileSync(join(dir, '.vscode', 'settings.json'), JSON.stringify({ 'yds.module': 'c-ass-kk-hans' }))
    assert.equal(detectCompanionPlugin(dir).plugin, 'dsh-ris-yds')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the program list renders the hint as an optional extra line', () => {
  const dir = workspace()
  try {
    mkdirSync(join(dir, 'yms-home'))
    const text = renderProgramList({ root: dir, dir: join(dir, 'logs'), programs: [], companion: detectCompanionPlugin(dir) })
    assert.match(text, /No runnable programs/)
    assert.match(text, /Optional companion plugin: dsh-ris-yds/)
    // Null companion keeps the rendered list exactly as before.
    assert.doesNotMatch(renderProgramList({ root: dir, dir, programs: [], companion: null }), /Optional companion plugin/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
