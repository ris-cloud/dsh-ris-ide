/**
 * The tree's copy mirrored onto the OS clipboard so a file manager can paste it.
 *
 * A web page cannot publish a file list (Chromium refuses `text/uri-list` on
 * `Clipboard.write`, and a synthetic `copy` event only yields Chrome's private
 * flavour), so the Host builds the platform command. These tests pin the command
 * shape and the route contract — never the real clipboard, which belongs to the
 * developer's desktop, not to CI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { __test } from '../lib/index.js'

const {
  CLIPBOARD_FILES_PATH,
  CLIPBOARD_READ_PATH,
  CLIPBOARD_MAX_ENTRIES,
  CLIPBOARD_MAX_PAYLOAD,
  CLIPBOARD_STAGE_DIR,
  clipboardScope,
  stageClipboardCopy,
  pruneClipboardStage,
  clipboardStageMapping,
  windowsClipboardScript,
  windowsClipboardReadScript,
  parseClipboardRead,
  clipboardPathsToLinux,
  readSystemFileClipboard,
  writeSystemFileClipboard,
  serveClipboardFiles,
  serveClipboardRead,
  isWsl,
} = __test

test('the clipboard route is one POST under the plugin prefix', () => {
  assert.equal(CLIPBOARD_FILES_PATH, '/dsh-ris-ide/clipboard/files')
  assert.equal(typeof serveClipboardFiles, 'function')
  assert.equal(CLIPBOARD_MAX_ENTRIES, 200, 'one copy is a selection, not a whole disk')
  assert.equal(CLIPBOARD_MAX_PAYLOAD, 256 * 1024, 'the stdin payload is bounded too')
})

test('the PowerShell script writes CF_HDROP with the intent Explorer reads', () => {
  const copy = windowsClipboardScript(false)
  assert.match(copy, /Add-Type -AssemblyName System\.Windows\.Forms/, 'the clipboard API comes from WinForms')
  assert.match(copy, /\$data\.SetData\('FileDrop', \[string\[\]\]\$lines\)/, 'paths go in as a FileDrop list')
  assert.match(copy, /\$data\.SetData\('Preferred DropEffect', \[byte\[\]\]@\(1,0,0,0\)\)/, 'copy is DROPEFFECT_COPY')
  assert.match(copy, /\[System\.Windows\.Forms\.Clipboard\]::SetDataObject\(\$data, \$true\)/, 'the data is flushed, so it survives the PowerShell process')
  assert.match(windowsClipboardScript(true), /\[byte\[\]\]@\(2,0,0,0\)/, 'cut is DROPEFFECT_MOVE')
})

test('no file name can reach the PowerShell script as code', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // The script is a constant: the paths ride on stdin, one per line.
  assert.match(source, /\[Console\]::OpenStandardInput\(\)/, 'the list is read from stdin')
  assert.match(source, /\[Text\.Encoding\]::UTF8\.GetString/, 'stdin bytes are decoded as UTF-8')
  assert.equal(/windowsPaths\.map\(powershellLiteral\)/.test(source), false, 'no path is interpolated into the script')
  assert.equal(/function powershellLiteral/.test(source), false, 'the literal quoter is gone with the interpolation')
  // …and the list is handed over as stdin, never as an argument vector entry.
  assert.match(source, /'powershell\.exe', \['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded\], `\$\{windowsPaths\.join\('\\n'\)\}\\n`\)/)
  // The route refuses names the line protocol cannot express.
  assert.match(source, /复制到系统剪贴板不支持路径里的换行或控制字符/)
  assert.match(source, /CLIPBOARD_MAX_PAYLOAD/)
})

test('the Host owns the platform call, the client only asks for it', async () => {
  assert.equal(typeof writeSystemFileClipboard, 'function')
  assert.equal(typeof isWsl(), 'boolean', 'WSL detection is a platform fact, never request data')
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /isLoopbackRequest\(req\)\) throw new TailError\('forbidden'/, 'the route is loopback-fenced')
  assert.match(source, /paths\.length > CLIPBOARD_MAX_ENTRIES/, 'the count is capped')
  assert.match(source, /'wslpath'/, 'WSL paths are translated for the Windows clipboard')
  assert.match(source, /'linux-xclip'/, 'a GNOME desktop gets the copy|cut flavour')
  assert.match(source, /'linux-wl-copy'/, 'a plain Wayland desktop falls back to text/uri-list')
  assert.match(source, /'macos-appkit'/, 'Finder pasteboard is written through JXA')
  // Every child process is spawned without a shell, with a hard timeout.
  assert.equal(/shell: true/.test(source), false, 'no child is run through a shell')
  assert.match(source, /child\.kill\('SIGKILL'\)/, 'a stuck helper is killed')
  // macOS gets the paths as argv, not as JXA source.
  assert.match(source, /'osascript', \['-l', 'JavaScript', '-e', script, \.\.\.paths\]/)
})

test('the route rejects relative, missing, control-character and oversized lists before touching the clipboard', async () => {
  const server = createServer((req, res) => { void serveClipboardFiles(undefined, req, res, {}) })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const base = `http://127.0.0.1:${server.address().port}/dsh-ris-ide/clipboard/files`
  const post = (body) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ paths: ['notes.txt'] })).status, 400, 'a relative path has no meaning on the OS clipboard')
    assert.equal((await post({ paths: ['/definitely/not/here.txt'] })).status, 404, 'a stale row must not put a ghost on the clipboard')
    assert.equal((await post({ paths: ['/tmp/it\nis.txt'] })).status, 400, 'a line break would split one name into two entries')
    assert.equal((await post({ paths: ['/tmp/it\u0000is.txt'] })).status, 400, 'a NUL cannot survive a text channel')
    const tooMany = Array.from({ length: CLIPBOARD_MAX_ENTRIES + 1 }, (_, index) => `/tmp/clip-${index}.txt`)
    assert.equal((await post({ paths: tooMany })).status, 400, 'the cap is enforced')
    assert.equal((await post({ paths: [] })).status, 400, 'an empty list is a caller bug')
    // A COPY must be staged first, and staging needs the workspace. Without it the
    // route refuses rather than publishing the originals.
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const real = join(await mkdtemp(join(tmpdir(), 'dsh-clip-route-')), 'a.txt')
    await writeFile(real, 'x', 'utf8')
    const noWorkspace = await post({ paths: [real] })
    assert.equal(noWorkspace.status, 400, 'a copy that cannot be staged is refused')
    assert.match((await noWorkspace.json()).message, /sessionId/, 'the message says why')
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
})

test('the clipboard scope is read from the query string, like every tree route', () => {
  const query = new URL('http://dsh.internal/dsh-ris-ide/clipboard/files?sessionId=session-1&cwd=%2Fw')
  // The page puts the scope in the QUERY (that is how `clipboardQuery` builds it).
  // Reading only the body made copy answer "复制到系统剪贴板需要 sessionId".
  assert.deepEqual(clipboardScope({}, query), { sessionId: 'session-1', cwd: '/w' }, 'a page-built query resolves')
  assert.deepEqual(clipboardScope({ sessionId: 'body', cwd: '/b' }, new URL('http://dsh.internal/x')), { sessionId: 'body', cwd: '/b' }, 'a body still works')
  assert.deepEqual(clipboardScope({ sessionId: 'body' }, query), { sessionId: 'body', cwd: '/w' }, 'the body wins per field, the query fills the gap')
  assert.deepEqual(clipboardScope({}, new URL('http://dsh.internal/x')), { sessionId: '', cwd: '' }, 'nothing carried reads as empty scope')
})

test('the clipboard can be READ back: Explorer copies reach the tree on WSL', () => {
  assert.equal(CLIPBOARD_READ_PATH, '/dsh-ris-ide/clipboard/read')
  assert.equal(typeof serveClipboardRead, 'function')
  assert.equal(typeof readSystemFileClipboard, 'function')
  // The read script is a constant too — it prints, it never interpolates a path.
  const script = windowsClipboardReadScript()
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms/)
  assert.match(script, /GetDataObject\(\)/)
  assert.match(script, /\$data\.GetData\("FileDrop"\)/)
  assert.match(script, /"F:" \+ \[string\]\$file/, 'one line per file, so a name is never escaped as code')
  assert.match(script, /"T:" \+ \[Convert\]::ToBase64String/, 'the text flavour is base64, so newlines survive')
  const parsed = parseClipboardRead([
    'F:' + ['C:', 'Users', 'dev', 'Desktop', 'README.md'].join('\\'),
    'F:' + ['', '', 'wsl.localhost', 'Ubuntu-24.04', 'home', 'user', 'AGENTS.md'].join('\\'),
    `T:${Buffer.from('hello\nworld', 'utf8').toString('base64')}`,
  ].join('\r\n'))
  assert.deepEqual(parsed.files, [
    ['C:', 'Users', 'dev', 'Desktop', 'README.md'].join('\\'),
    ['', '', 'wsl.localhost', 'Ubuntu-24.04', 'home', 'user', 'AGENTS.md'].join('\\'),
  ])
  assert.equal(parsed.text, 'hello\nworld')
})

test('Windows clipboard paths map to paths this filesystem can import', () => {
  const wslRoot = ['', '', 'wsl.localhost', 'Ubuntu-24.04'].join('\\')
  const otherRoot = ['', '', 'wsl.localhost', 'OtherDistro'].join('\\')
  const serverRoot = ['', '', 'server', 'share'].join('\\')
  const mapped = clipboardPathsToLinux([
    wslRoot + '\\' + ['home', 'user', 'AGENTS.md'].join('\\'),
    ['', '', 'wsl$', 'Ubuntu-24.04'].join('\\') + '\\' + ['tmp', 'a b.txt'].join('\\'),
    ['C:', 'Users', 'dev', 'Desktop', 'README.md'].join('\\'),
    otherRoot + '\\' + ['home', 'x.txt'].join('\\'),
    serverRoot + '\\' + 'x.txt',
    '/already/linux',
    '/already/linux',
  ], { distro: 'Ubuntu-24.04' })
  assert.deepEqual(mapped, [
    '/' + ['home', 'user', 'AGENTS.md'].join('/'),
    '/' + ['tmp', 'a b.txt'].join('/'),
    '/' + ['mnt', 'c', 'Users', 'dev', 'Desktop', 'README.md'].join('/'),
    '/already/linux',
  ], 'a foreign distro or an SMB share is not visible here; duplicates collapse')
  assert.deepEqual(clipboardPathsToLinux([]), [])
  assert.deepEqual(clipboardPathsToLinux('not a list'), [])
})

test('reading the clipboard is a loopback-fenced GET, never a write', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /const CLIPBOARD_READ_PATH = `\$\{ROUTE_PREFIX\}\/clipboard\/read`/)
  assert.match(source, /if \(pathname === CLIPBOARD_READ_PATH\) \{/, 'the dispatch knows the route')
  assert.match(source, /message: 'GET only'/, 'only a read is allowed on it')
  assert.match(source, /async function serveClipboardRead\(ctx, req, res\) \{[\s\S]{0,400}isLoopbackRequest\(req\)\) throw new TailError\('forbidden'/,
    'the same loopback fence as the write route')
  assert.match(source, /'macos-appkit'[\s\S]{0,2000}'linux-wl-paste'/, 'each platform reads the flavour it wrote')
})

test('a COPY is published from a hidden staging area, never from the originals', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, stat, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'dsh-clip-'))
  const sourceFile = join(root, 'AGENTS.md')
  await writeFile(sourceFile, '# agents\n', 'utf8')
  const folder = join(root, 'docs')
  await mkdir(folder)
  await writeFile(join(folder, 'note.txt'), 'note', 'utf8')

  const stage = await stageClipboardCopy(root, [sourceFile, folder])
  assert.notEqual(stage, null, 'staging succeeds inside one filesystem')
  assert.equal(stage.staged.length, 2)
  assert.deepEqual(stage.originals, [sourceFile, folder])
  assert.ok(stage.staged[0].startsWith(join(root, CLIPBOARD_STAGE_DIR)), 'the copy lives under the hidden stage')
  assert.notEqual(stage.staged[0], sourceFile, 'the clipboard points at the copy, not the original')
  // A plain file is a HARDLINK: same inode, no extra bytes, originals untouched.
  assert.equal((await stat(stage.staged[0])).ino, (await stat(sourceFile)).ino, 'files are hard-linked, not duplicated')
  assert.equal(await readFile(stage.staged[0], 'utf8'), '# agents\n')
  assert.equal(await readFile(sourceFile, 'utf8'), '# agents\n', 'the original is still there')
  // A directory cannot be hard-linked, but each FILE inside it is: the staged tree
  // is a mirror of names, so a big folder costs inodes instead of bytes.
  assert.equal((await stat(stage.staged[1])).isDirectory(), true)
  assert.equal((await stat(join(stage.staged[1], 'note.txt'))).ino, (await stat(join(folder, 'note.txt'))).ino,
    'files inside a staged folder are hard links too')
  assert.equal(await readFile(join(stage.staged[1], 'note.txt'), 'utf8'), 'note')
  assert.equal(await readFile(join(folder, 'note.txt'), 'utf8'), 'note')

  // The manifest translates a staged path back to the original: Ctrl+C → Ctrl+V
  // inside the tree must keep looking like the original selection.
  const mapping = await clipboardStageMapping(root)
  assert.equal(mapping.get(stage.staged[0]), sourceFile)
  assert.equal(mapping.get(stage.staged[1]), folder)

  // Old batches are pruned: the staging area cannot grow without bound.
  for (let index = 0; index < 5; index += 1) await stageClipboardCopy(root, [sourceFile])
  await pruneClipboardStage(root)
  const batches = (await readdir(join(root, CLIPBOARD_STAGE_DIR), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  assert.ok(batches.length <= 3, 'only the recent batches survive')
})

test('only a COPY is staged; a cut still publishes the real file', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /if \(body\.cut !== true\) \{[\s\S]{0,600}stageClipboardCopy\(root, paths\)/,
    'copy goes through the staging area')
  assert.match(source, /published = stage\.staged/, 'the clipboard gets the staged paths, not the originals')
  assert.match(source, /const mapping = await clipboardStageMapping\(root\)/, 'a read translates staged paths back')
  assert.match(source, /files\.map\(\(path\) => mapping\.get\(resolve\(path\)\) \?\? path\)/)
  assert.match(source, /if \(dirent\.name === IDE_STATE_DIR\) continue/, 'the state folder (trash/cache/stage) is never a tree row')
  assert.match(source, /'\.dsh-ris-ide',/, 'the watcher ignores its churn')
})

test('the copy route reads the workspace scope the page actually sends', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // The page builds `?sessionId&cwd` (see `clipboardQuery`). Reading only the JSON
  // body made every real copy fail with "复制到系统剪贴板需要 sessionId".
  assert.match(source, /const scope = clipboardScope\(body, url\)/, 'the route parses the query string')
  assert.match(source, /const root = clipboardRoot\(ctx, scope\.sessionId, scope\.cwd\)/, 'the scope feeds the staging root')
})

test('a copy that cannot be staged fails instead of publishing the originals', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // The old shape — stage, and on failure quietly hand out the real paths — is the
  // silent downgrade that lets Explorer move files out of the workspace.
  assert.equal(/stage === null[\s\S]{0,160}published = paths/.test(source), false,
    'no silent fallback to the originals')
  assert.equal(/stageClipboardCopy\(root, paths\)\n\s+if \(stage === null\)/.test(source), false)
  assert.match(source, /超过 \$\{megabytes\} MB，已取消复制到系统剪贴板/, 'the toast stays short but says the copy was cancelled')
  assert.match(source, /复制到系统剪贴板需要 sessionId/, 'without a workspace there is nothing to stage into')
  // A real refusal is an error the page reports, not a "copied" toast.
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /notify\('没能放到系统剪贴板：' \+ messageOf\(problem\)/)
  assert.match(client, /if \(code === 'unsupported'\) \{/, 'only "no backend at all" still writes the paths as text')
})
