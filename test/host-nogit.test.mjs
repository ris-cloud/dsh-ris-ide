/**
 * A machine with the plugin but WITHOUT git: the file tree and filename search
 * must fall back to the filesystem instead of showing an empty repository.
 *
 * This lives in its own test file on purpose: the host module remembers "git is
 * missing" for the life of the process (so it does not spawn git per tree level),
 * and a dedicated process keeps that stickiness away from the other host tests.
 * Run with PATH emptied, which makes `spawn('git')` fail with ENOENT.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __test } from '../lib/index.js'

const { listIdeTree, searchWorkspaceFiles } = __test

test('without git, the tree and filename search fall back to the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-nogit-'))
  // A git REPO (only the .git directory is needed to find the root) whose
  // .gitignore would normally hide README.md — without git there is no filter.
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'src', 'main', 'java'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# readme\n')
  await writeFile(join(root, 'src', 'main', 'java', 'A.java'), 'class A {}\n')
  await writeFile(join(root, '.gitignore'), 'README.md\n')

  const savedPath = process.env.PATH
  process.env.PATH = ''
  try {
    const listing = await listIdeTree(root, root)
    const labels = listing.entries.map((entry) => entry.label)
    assert.ok(labels.includes('src'), 'directories are still listed')
    assert.ok(labels.includes('README.md'), 'files are not hidden by a .gitignore we cannot evaluate')

    const src = listing.entries.find((entry) => entry.label === 'src')
    const javaDir = join(src.path, 'main', 'java')
    const inner = await listIdeTree(javaDir, root)
    assert.deepEqual(inner.entries.map((entry) => entry.label), ['A.java'])

    const found = await searchWorkspaceFiles(root, 'a.java', 10)
    assert.ok(found.matches.some((path) => path.endsWith('A.java')), 'filename search still answers')
  } finally {
    process.env.PATH = savedPath
  }
})
