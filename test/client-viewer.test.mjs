/**
 * Client-half tests: the platform module contract, the viewer registration,
 * prefix-safe URL building, the pure state helpers, an SSR render of the
 * component, and the two-tier read (tail route → fs.read fallback) against a
 * real HTTP listener driven by the host half's own reader.
 *
 * The client bundle is loaded exactly the way the browser loads it: a fake
 * `window.__ModuleLoader__` captures the `{ id, factory }` registration, and
 * the factory runs with a `require` that answers `react`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __test as hostTest } from '../lib/index.js'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Where a *real* React (with `react-dom/server`) can be loaded from, or `''`
 * when there is none — the tests then fall back to the stub below.
 *
 * Candidates, in order:
 *   1. `DSH_RIS_IDE_REACT_ROOT` — explicit override (CI cache, custom layout);
 *   2. this repo's own `node_modules` — after `npm install`: `react`/`react-dom`
 *      are devDependencies, so a plain checkout works anywhere;
 *   3. a sibling `dsh-better-sidebar` checkout — local-dev convenience only,
 *      resolved *relative* to this file.
 *
 * No absolute machine path is baked in and nothing reaches the network:
 * `npm test` must pass on a bare clone with no `npm install` at all.
 */
function findReactRoot() {
  const candidates = [
    process.env.DSH_RIS_IDE_REACT_ROOT,
    join(ROOT, 'node_modules'),
    join(ROOT, '..', 'tools', 'dsh-better-sidebar', 'node_modules'),
    join(ROOT, '..', 'dsh-better-sidebar', 'node_modules'),
  ].filter(Boolean)
  for (const root of candidates) {
    try {
      require(`${root}/react`)
      require(`${root}/react-dom/server`)
      return root
    } catch { /* try the next candidate */ }
  }
  return ''
}

const REACT_ROOT = findReactRoot()

/** Real React/ReactDOM when the sibling checkout has them (SSR test), else a stub. */
function loadReact() {
  try {
    return { value: require(`${REACT_ROOT}/react`), real: true }
  } catch {
    return { value: stubReact(), real: false }
  }
}

/** Minimal hook surface: enough to load and call the module without a DOM. */
function stubReact() {
  // React 把 children 也放进 props.children；stub 必须一致，否则纯断言（treeLabel 等）
  // 在 CI（没有真实 React）下会拿到 undefined。
  const element = (type, props, ...children) => {
    const next = Object.assign({}, props)
    if (children.length === 1) next.children = children[0]
    else if (children.length > 1) next.children = children
    return { type, props: next, children }
  }
  return {
    Component: class Component {
      constructor(props) { this.props = props || {} }
      setState(next) { this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next) }
    },
    createElement: element,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
}

/** Capture the module registration the way the platform loader does. */
let registration = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
await import('../lib/client.js')

const { value: React, real: reactIsReal } = loadReact()

/**
 * The standalone window mounts through `react-dom/client`; the factory's require
 * is fixed at load time, so the stub lives here and records what was rendered
 * (no DOM needed — the real panel is exercised by the SSR test below).
 */
const standaloneRoots = []
const stubReactDomClient = {
  createRoot: (container) => ({
    render: (element) => { standaloneRoots.push({ container, element }) },
  }),
}

const client = registration.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom/client') return stubReactDomClient
  throw new Error(`unexpected module request: ${name}`)
})
const T = client.__test

/**
 * Run `apply` with a context whose effects are tracked, and return a disposer.
 * The plugin now owns a long-lived interval (the open-request poller), so a test
 * that leaves the effects undisposed would keep the process alive.
 */
function applyTracked(args) {
  const disposers = []
  const ctx = Object.assign({}, args, {
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
  })
  client.apply(ctx)
  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* teardown only */ }
    }
  }
}


/** A client context shaped like the official DSH right-Sidebar services. */
function rightSidebarContext() {
  const state = { types: [], slots: [], opened: [] }
  const disposers = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    sidebarRightTabs: {
      register: (definition) => { state.types.push(definition); return () => {} },
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => { state.slots.push({ spec, component }); return () => {} },
    },
    sidebarRight: {
      openTab: (kind) => { state.opened.push(kind) },
    },
  }
  return { ctx, state, disposers }
}

test('closing the active tab works on chords browsers do not reserve', () => {
  // browser-reachable chords
  assert.equal(T.closeTabChord({ altKey: true, key: 'w' }), true, 'Alt+W')
  assert.equal(T.closeTabChord({ ctrlKey: true, altKey: true, key: 'W' }), true, 'Ctrl+Alt+W')
  assert.equal(T.closeTabChord({ ctrlKey: true, key: 'F4' }), true, 'Ctrl+F4')
  // Ctrl+W is still claimed (it works in the desktop shell even though a plain
  // browser may close the tab first)
  assert.equal(T.closeTabChord({ ctrlKey: true, key: 'w' }), true)
  assert.equal(T.closeTabChord({ metaKey: true, key: 'w' }), true)
  // never on plain typing or unrelated chords
  assert.equal(T.closeTabChord({ key: 'w' }), false)
  assert.equal(T.closeTabChord({ key: 'q' }), false)
  assert.equal(T.closeTabChord({ ctrlKey: true, shiftKey: true, key: 'w' }), false, 'Ctrl+Shift+W closes the window')
  assert.equal(T.closeTabChord(undefined), false)
})

test('double-clicking a title-bar control does not maximise the pane', () => {
  const control = { closest: (selector) => selector.includes('button') ? { tagName: 'BUTTON' } : null }
  const text = { closest: () => null }
  const nothing = { }
  assert.equal(T.headerDoubleClickIsTitle(control), false, 'debug toolbar buttons')
  assert.equal(T.headerDoubleClickIsTitle(text), true, 'the title text itself')
  assert.equal(T.headerDoubleClickIsTitle(nothing), true, 'an element without closest')
  assert.equal(T.headerDoubleClickIsTitle(null), true)
  assert.equal(T.headerDoubleClickIsTitle(undefined), true)
  // the search box in the editor header is an input
  const input = { closest: (selector) => selector.includes('input') ? { tagName: 'INPUT' } : null }
  assert.equal(T.headerDoubleClickIsTitle(input), false)
})

test('only invisible outcomes and failures raise a toast', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Visible-in-the-UI successes stay silent: the row/tab/marker already changed.
  for (const silent of ['已保存 ', '已启动 ', '已停止 ', '已切换到', '已关闭其他', '已加断点 ',
    '已删除断点', '已标记断点', '已预置断点', '已撤销：', '已新建文件 ', '已新建文件夹 ',
    '已粘贴到', '已移动到', '已自动切换到调试中的项目', '已还原布局尺寸']) {
    assert.equal(source.includes(silent), false, `${silent} must not toast`)
  }
  // Failures and warnings keep their toast (nothing else would tell the user).
  for (const kept of ['保存失败：', '启动失败：', '停止失败：', '加断点失败：', '删断点失败：',
    '清断点失败：', '撤销失败：', '移动失败：', '粘贴失败：', '新建文件失败：',
    '取线程失败：', '取栈失败：', '取变量失败：', '文件不存在，已从最近历史移除：',
    '已复制路径：', '已复制文件名：']) {
    assert.ok(source.includes(kept), `${kept} must stay`)
  }
  // An explicit ⟳ is a user action whose result may be invisible (nothing changed),
  // so it keeps a short confirmation toast.
  assert.ok(source.includes('文件树已刷新'), 'manual tree refresh confirms with a toast')
  // The clipboard and the trash are not visible anywhere else: keep telling them.
  // (The strip at the top of the tree is gone — the toast alone carries the state.)
  assert.ok(source.includes("'已复制 ' : '已剪切 '"), 'clipboard state is invisible: keep it')
  assert.equal(source.includes('data-tree-clipboard'), false, 'no clipboard strip above the tree')
  assert.ok(source.includes('已移到回收站'))
})

test('the tab dropdown lists open files then recent history, capped at 30', () => {
  assert.equal(T.TAB_MENU_LIMIT, 30)
  // open tabs stay in strip order; recent files append (newest first), no dupes
  const rows = T.tabMenuEntries(['/a.java', '/b.java'], ['/c.java', '/a.java', '/d.java'])
  assert.deepEqual(rows.map((row) => [row.path, row.open]), [
    ['/a.java', true], ['/b.java', true], ['/c.java', false], ['/d.java', false],
  ])
  // the cap applies to the total, open tabs included
  const many = Array.from({ length: 40 }, (_, i) => '/f' + i)
  assert.equal(T.tabMenuEntries(many.slice(0, 5), many.slice(5), 30).length, 30)
  assert.equal(T.tabMenuEntries(many, [], 30).length, 30)
  assert.deepEqual(T.tabMenuEntries([], []), [])
  assert.deepEqual(T.tabMenuEntries(undefined, undefined), [])
})

test('the empty search box offers at most 20 recent files', () => {
  assert.equal(T.SEARCH_RECENT_LIMIT, 20)
  const rows = T.searchHistoryEntries(['/a.java', '/b.java'], ['/b.java'])
  assert.deepEqual(rows, [{ path: '/a.java', open: false }, { path: '/b.java', open: true }])
  // the recorded list itself is capped, so the dropdown can never exceed it
  const many = Array.from({ length: 40 }, (_, i) => '/f' + i)
  assert.equal(T.searchHistoryEntries(many, [], 20).length, 20)
  assert.equal(T.pushRecent(many, '/new').length, 30, 'default push cap stays the tab-menu cap')
  assert.equal(T.pushRecent(many, '/new', T.SEARCH_RECENT_LIMIT).length, 20)
  // duplicates in storage cannot duplicate rows
  assert.deepEqual(T.searchHistoryEntries(['/a', '/a', ''], []), [{ path: '/a', open: false }])
  assert.deepEqual(T.searchHistoryEntries(undefined, undefined), [])
})

test('a history entry whose file vanished is detected before opening', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (href, init) => {
    calls.push({ href: String(href), method: (init && init.method) || 'GET' })
    return { ok: true, status: 404, json: async () => ({ ok: false, message: 'not-found' }) }
  }
  try {
    assert.equal(await T.fileMissing({ sessionId: 's1', cwd: '/w' }, '/w/gone.java'), true)
    assert.match(calls[0].href, /dsh-ris-ide\/fs\/read/)
    assert.match(calls[0].href, /path=%2Fw%2Fgone\.java/)
    // 200 means it still exists
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: 'text', content: 'x' }) })
    assert.equal(await T.fileMissing({ sessionId: 's1' }, '/w/here.java'), false)
    // a failed request is not proof of deletion: keep the row
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await T.fileMissing({ sessionId: 's1' }, '/w/maybe.java'), false)
    assert.equal(await T.fileMissing({ sessionId: 's1' }, ''), true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('recent files are moved to the front, deduped and bounded', () => {
  assert.deepEqual(T.pushRecent(['/a', '/b'], '/c'), ['/c', '/a', '/b'])
  assert.deepEqual(T.pushRecent(['/a', '/b'], '/a'), ['/a', '/b'])
  assert.deepEqual(T.pushRecent([], '/a', 2), ['/a'])
  assert.deepEqual(T.pushRecent(['/a', '/b'], '/c', 2), ['/c', '/a'])
  assert.equal(T.pushRecent(Array.from({ length: 40 }, (_, i) => '/f' + i), '/new').length, 30)
  assert.deepEqual(T.pushRecent(undefined, '/a'), ['/a'])
  assert.deepEqual(T.pushRecent(['/a'], ''), ['/a'])
})

test('bulk close separates victims from the dirty ones it must ask about', () => {
  const dirty = (path) => path === '/b.java' || path === '/c.java'
  const others = T.bulkClosePlan(['/a.java', '/b.java', '/c.java'], '/a.java', dirty, true)
  assert.deepEqual(others.victims, ['/b.java', '/c.java'])
  assert.deepEqual(others.dirty, ['/b.java', '/c.java'])
  const all = T.bulkClosePlan(['/a.java', '/b.java'], '/a.java', dirty, false)
  assert.deepEqual(all.victims, ['/a.java', '/b.java'])
  assert.deepEqual(all.dirty, ['/b.java'])
  assert.deepEqual(T.bulkClosePlan([], undefined, dirty, false), { victims: [], dirty: [] })
})

test('the editor surfaces the batch-close prompt and the tab dropdown', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const action of ['bulk-save-close', 'bulk-discard-close', 'bulk-cancel-close', 'tabs-menu']) {
    assert.ok(source.includes(`'data-action': '${action}'`), `${action} is wired`)
  }
  assert.match(source, /'data-bulk-prompt': '1'/)
  assert.match(source, /'data-tabs-menu': '1'/)
  assert.match(source, /recent: recentFiles/, 'the history survives a reload')
  assert.match(source, /'data-search-history': '1'/, 'the empty search box shows the history')
  assert.match(source, /'data-search-history-row': row.path/)
})

test('the bundle registers under the package name and exports a cordis plugin', () => {
  assert.equal(registration.id, 'dsh-ris-ide')
  assert.equal(client.name, 'dsh-ris-ide')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['sidebarRight', 'sidebarRightTabs', 'slots'], 'only the official DSH services')
  assert.equal(typeof T, 'object')
})



test('apply registers the console tab with the official right-Sidebar registry', () => {
  const { ctx, state } = rightSidebarContext()
  client.apply(ctx)
  assert.equal(state.types.length, 1, 'one tab type')
  const definition = state.types[0]
  assert.equal(definition.id, 'dsh-ris-ide')
  assert.equal(definition.kind, 'dsh-ris-ide:ide')
  assert.equal(definition.multiple, false)
  // The sidebar carries the COMPACT console, not the IDE: the label says so.
  assert.equal(definition.title(), 'RIS控制台')
  assert.equal(definition.guide[0].title(), 'RIS控制台')

  const body = state.slots.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')
  assert.ok(body !== undefined, 'the body is registered in the tab slot')
  assert.equal(body.spec.key, 'dsh-ris-ide')
  assert.equal(typeof body.component, 'function')
  const injected = body.spec.inject('s1')
  assert.equal(injected.sessionId, 's1')
  assert.equal(injected.visible, true)
  assert.equal(injected.compact, true, 'the sidebar tab renders the compact shape')
  assert.ok(state.slots.some((entry) => entry.spec.name === 'sidebar.right.pane.tab.title' && entry.spec.key === 'dsh-ris-ide'))
})

test('the compact panel is console rows plus a resizable 240px log pane', () => {
  assert.equal(T.COMPACT_PANE_DEFAULT, 240)
  assert.equal(T.readCompactPaneHeight(), 240, 'nothing saved yet')
  const storage = {
    getItem: (key) => (key === T.COMPACT_UI_KEY ? '360' : null),
    setItem: () => {},
  }
  const previous = globalThis.window.localStorage
  globalThis.window.localStorage = storage
  try {
    assert.equal(T.readCompactPaneHeight(), 360, 'a dragged height is remembered')
    storage.getItem = () => '20'
    assert.equal(T.readCompactPaneHeight(), 120, 'clamped at the bottom')
    storage.getItem = () => '5000'
    assert.equal(T.readCompactPaneHeight(), 720, 'clamped at the top')
    storage.getItem = () => 'not-a-number'
    assert.equal(T.readCompactPaneHeight(), 240, 'garbage falls back to the default')
  } finally {
    globalThis.window.localStorage = previous
  }
})

test('the compact panel remembers which section is maximized', () => {
  assert.equal(T.readCompactMax(), '', 'nothing saved yet: the split view')
  const storage = {
    getItem: (key) => (key === T.COMPACT_MAX_KEY ? 'log' : null),
    setItem: () => {},
  }
  const previous = globalThis.window.localStorage
  globalThis.window.localStorage = storage
  try {
    assert.equal(T.readCompactMax(), 'log', 'the maximized log is remembered')
    storage.getItem = () => 'console'
    assert.equal(T.readCompactMax(), 'console')
    storage.getItem = () => 'editor'
    assert.equal(T.readCompactMax(), '', 'an unknown section degrades to the split view')
    storage.getItem = () => 'not-json'
    assert.equal(T.readCompactMax(), '')
  } finally {
    globalThis.window.localStorage = previous
  }
})

test('the compact shape renders the console and the IDE-window button, not the full workbench', { skip: !reactIsReal }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderToStaticMarkup(React.createElement(T.ProgramsPanel, { sessionId: 's1', cwd: '/w/project', visible: true, compact: true }))
  assert.match(markup, /data-panel="compact"/)
  assert.match(markup, /data-compact-bar="1"/)
  assert.match(markup, /data-action="ide-window"/, 'the panel top-right opens the IDE window')
  assert.match(markup, /data-splitter="compact-log"/, 'the log pane has a drag handle')
  // Each title bar keeps its own maximize toggle (console = the top bar, log =
  // the log header); the log header no longer carries the IDE-window button.
  assert.match(markup, /data-action="compact-max-console"/, 'the console title bar can maximize itself')
  assert.match(markup, /data-action="compact-max-log"/, 'the log title bar can maximize itself')
  const logHeadAt = markup.indexOf('data-compact-log')
  assert.ok(logHeadAt > 0)
  const logHead = markup.slice(logHeadAt)
  assert.doesNotMatch(logHead, /data-action="ide-window"/, 'the log header has no IDE button any more')
  // The full IDE's grid belongs to the standalone window only.
  assert.doesNotMatch(markup, /data-ide-grid/)
})

test('the compact log title bar owns the follow switch and its maximize toggle', { skip: !reactIsReal }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const render = (props) => renderToStaticMarkup(React.createElement(T.CompactLogHead, Object.assign({
    logPath: '/w/logs/ris-model-biz.log',
    programName: 'ris-model-biz',
    logFileName: 'ris-model-biz.log',
    following: true,
    maximized: false,
    onToggleFollow() {},
    onToggleMaximize() {},
  }, props)))
  const markup = render({})
  assert.match(markup, /data-action="compact-follow"/, 'the follow/pause button lives in the log title bar')
  assert.match(markup, /aria-pressed="true"/, 'following is the default: the button is ON')
  assert.match(markup, /title="跟随中：点击暂停跟随"/)
  assert.match(markup, /data-action="compact-max-log"/, 'the same bar keeps its maximize toggle ')
  assert.match(markup, /⤢/, 'not maximized: the button offers maximize')
  assert.doesNotMatch(markup, /data-action="ide-window"/, 'the log bar no longer opens the IDE window')
  // The log's A−/A+ pair lives here too (shared PREF_FONT_SIZE with the IDE pane).
  assert.match(markup, /data-action="compact-font-down"/, 'the log bar can shrink its font')
  assert.match(markup, /data-action="compact-font-up"/, 'the log bar can grow its font')
  assert.match(markup, /title="放大日志字号（当前 12.5px）"/, 'the size is stated from the prop')
  const bigger = render({ fontSize: 15 })
  assert.match(bigger, /title="缩小日志字号（当前 15px）"/)
  // No log file = nothing to size or follow: the bar only keeps the maximize seat.
  const empty = render({ logPath: '', logFileName: '' })
  assert.doesNotMatch(empty, /compact-font-/, 'no font buttons without a log file')
  assert.doesNotMatch(empty, /compact-follow/, 'no follow button without a log file')
  // Paused state flips both the label and the pressed state.
  const paused = render({ following: false, maximized: true })
  assert.match(paused, /aria-pressed="false"/)
  assert.match(paused, /title="已暂停：点击继续跟随（自动滚到最新）"/)
  assert.match(paused, /⤡/, 'maximized: the button offers restore')
  // One button metric for the whole compact panel: 20px tall, glyph-only = 20x20.
  assert.equal((markup.match(/height:20px/g) || []).length >= 2, true, 'both log-bar buttons are 20px tall')
  assert.equal((markup.match(/width:20px/g) || []).length >= 2, true, 'both log-bar buttons are 20px wide')
})

test('apply adds a Session-header button immediately right of DSH\'s open-in-app action', () => {
  const { ctx, state } = rightSidebarContext()
  client.apply(ctx)
  const header = state.slots.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
  assert.ok(header !== undefined, 'the header utilities slot gets the button')
  assert.equal(header.spec.id, 'ris-ide-window')
  // open-in-app owns -10 and schedule-catalog -5: -8 sits between them, i.e. the
  // second icon, to the RIGHT of the VS Code button.
  assert.equal(header.spec.order, -8)
  assert.equal(typeof header.component, 'function')
  if (reactIsReal) {
    // Hooks need a renderer, so the button is asserted through a real SSR pass.
    const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
    const markup = renderToStaticMarkup(React.createElement(header.component, { sessionId: 's1' }))
    assert.match(markup, /data-action="ris-ide-window"/)
    assert.match(markup, /RIS-IDE/)
    assert.match(markup, /title="在独立窗口中打开RIS-IDE"/, 'the tooltip is the short wording')
  }
})

test('openStandaloneWindow hands the scope to the plugin\'s own page', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const opened = []
  globalThis.window = {
    open: (...args) => { opened.push(args); return { focus() {} } },
  }
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  try {
    T.openStandaloneWindow({ sessionId: 's1', cwd: '/w/project', programId: 'p1' })
    assert.equal(opened.length, 1)
    const [url, name, features] = opened[0]
    const parsed = new URL(url)
    // Same origin as the DSH page: no new port, cookie auth comes along.
    assert.equal(parsed.origin, 'http://127.0.0.1:3080')
    assert.equal(parsed.pathname, '/dsh-ris-ide/window')
    assert.equal(parsed.searchParams.get('sessionId'), 's1')
    assert.equal(parsed.searchParams.get('cwd'), '/w/project')
    assert.equal(parsed.searchParams.get('programId'), 'p1')
    assert.equal(parsed.searchParams.get('debug'), null, 'plain open: no auto-debug')
    // One IDE window per workspace: the name is derived from the cwd, so a
    // second click on the same workspace reuses this window, while another
    // workspace keeps its own window.
    assert.equal(name, T.standaloneWindowName('/w/project'), 'a workspace-keyed window name')
    assert.equal(parsed.searchParams.get('wname'), name, 'the page claims the same name the opener used')
    assert.match(name, /^dsh-ris-ide-window-[0-9a-z]+$/)
    // A program-subdirectory cwd roots the panel there, but the WINDOW still
    // follows the workspace (`windowCwd`), so it never opens a second window.
    globalThis.window.localStorage = { getItem: () => '/w/project' }
    T.openStandaloneWindow({ sessionId: 's1', cwd: '/w/project/sub', programId: 'p1' })
    const scoped = new URL(opened[opened.length - 1][0])
    assert.equal(scoped.searchParams.get('cwd'), '/w/project/sub', 'the panel keeps its rooted cwd')
    assert.equal(opened[opened.length - 1][1], T.standaloneWindowName('/w/project'), 'the window name stays workspace-keyed')
    assert.match(features, /popup=yes/)
    // The compact panel's 🐞 button: same window, plus "start the JDWP session".
    T.openStandaloneWindow({ sessionId: 's1', cwd: '/w/project', programId: 'p1', debug: true })
    assert.equal(new URL(opened[opened.length - 1][0]).searchParams.get('debug'), '1')
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})

test('openStandaloneWindow asks for the whole screen work area (maximized)', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const opened = []
  globalThis.window = {
    screen: { availWidth: 1920, availHeight: 1040 },
    open: (...args) => { opened.push(args); return { focus() {} } },
  }
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  try {
    T.openStandaloneWindow({ sessionId: 's1' })
    const features = opened[0][2]
    assert.match(features, /width=1920/, 'the work area width, not a fixed width')
    assert.match(features, /height=1040/, 'the work area height, not a fixed height')
    assert.match(features, /left=0/, 'pinned to the left edge')
    assert.match(features, /top=0/, 'pinned to the top edge')
    assert.match(features, /popup=yes/)
    // No screen information (odd hosts): keep the old fallback instead of NaN.
    globalThis.window = { open: (...args) => { opened.push(args); return { focus() {} } } }
    T.openStandaloneWindow({ sessionId: 's1' })
    assert.match(opened[1][2], /width=1500/)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})

test('openStandaloneWindow reports a blocked popup instead of failing silently', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { open: () => null }
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  try {
    assert.throws(() => T.openStandaloneWindow({ sessionId: 's1' }), /被拦截/)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})

test('mountStandalone renders the IDE panel with no DSH context at all', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { open: () => ({}) }
  globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }
  standaloneRoots.length = 0
  try {
    const container = { id: 'root' }
    await T.mountStandalone(container, { sessionId: 's1', cwd: '/w/project' })
    assert.equal(standaloneRoots.length, 1, 'one react-dom root is created')
    assert.equal(standaloneRoots[0].container, container)
    const { element } = standaloneRoots[0]
    // The panel sits under the error boundary, so one render error cannot blank
    // the window; the boundary itself is the outermost component.
    assert.equal(element.type, T.IdeErrorBoundary, 'the panel is wrapped in the error boundary')
    const panel = element.props.children
    assert.equal(typeof panel.type, 'function', 'the panel component, not a wrapper')
    assert.equal(panel.props.sessionId, 's1')
    assert.equal(panel.props.cwd, '/w/project')
    assert.equal(panel.props.visible, true)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})

test('routeUrl keeps a reverse-proxy directory prefix', () => {
  const previous = globalThis.document
  globalThis.document = { baseURI: 'http://host/dataops/proxy/3080/?token=abc#x' }
  try {
    assert.equal(T.routeUrl('dsh-ris-ide/tail').href, 'http://host/dataops/proxy/3080/dsh-ris-ide/tail')
    assert.equal(T.routeUrl('/sidebar/api/fs.read').href, 'http://host/dataops/proxy/3080/sidebar/api/fs.read')
  } finally {
    globalThis.document = previous
  }
})

test('state helpers report the shape the viewer renders', () => {
  assert.equal(T.countLines(''), 0)
  assert.equal(T.countLines('a\n'), 1)
  assert.equal(T.countLines('a\nb'), 2)
  assert.equal(T.formatBytes(512), '512 B')
  assert.equal(T.formatBytes(2048), '2.0 KB')
  assert.equal(T.formatBytes(3 * 1024 * 1024), '3.0 MB')

  const tail = T.stateFromPayload({ ok: true, content: 'a\nb\n', mode: 'tail', size: 4, elided: 99 })
  assert.equal(tail.lines, 2)
  assert.equal(tail.mode, 'tail')
  assert.equal(tail.elided, 99)
  assert.equal(tail.error, undefined)

  const head = T.stateFromPayload({ ok: true, content: 'only\n', mode: 'head', truncated: true, note: 'head-mode' })
  assert.equal(head.mode, 'head')
  assert.equal(head.truncated, true)

  assert.equal(T.stateFromPayload(undefined).loading, true)
  assert.equal(T.stateFromPayload({ ok: false, error: 'boom' }).error, 'boom')
  assert.match(T.metaText(tail), /4 B/)
  assert.match(T.metaText(tail), /2 行/)
  assert.match(T.metaText(tail), /省略前 99 B/)
  assert.match(T.metaText(head), /头部模式/)
})

test('the component renders the tail it was handed', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderToStaticMarkup(React.createElement(T.LogTail, {
    scope: { sessionId: 's1', cwd: '/tmp' },
    path: 'service.log',
    customData: { ok: true, content: 'BOOT-OK\nlistening on 16220\n', mode: 'tail', size: 34, elided: 0, mtimeMs: 1 },
  }))
  assert.match(markup, /BOOT-OK/)
  assert.match(markup, /listening on 16220/)
  // The viewer BODY has no bar since 1.6.1: follow/wrap/size are drawn by the log
  // pane's title bar (see the workbench title-bar tests below).
  assert.doesNotMatch(markup, /暂停跟随|继续跟随|换行:开/)
  assert.doesNotMatch(markup, /data-action="follow"/)
  assert.match(markup, /data-dsh-ris-ide="viewer"/)

  const headMarkup = renderToStaticMarkup(React.createElement(T.LogTail, {
    scope: { sessionId: 's1', cwd: '/tmp' },
    path: 'service.log',
    customData: { ok: true, content: 'HEAD\n', mode: 'head', truncated: true, note: 'head-mode' },
  }))
  assert.match(headMarkup, /退回头部读取/)
})

/** One listener that answers both tiers; `disableTail` flips the first off. */
async function withLogServer(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-client-'))
  const file = join(cwd, 'service.log')
  let content = ''
  for (let index = 1; index <= 3000; index += 1) content += `tick ${index}\n`
  await writeFile(file, content)

  const state = { disableTail: false, disableStop: false, disableConfig: false, tailCalls: 0, headCalls: 0, stopCalls: 0, stopBody: undefined, configCalls: 0, configBody: undefined, opens: [], openCalls: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (req.method === 'GET' && url.pathname === '/dsh-ris-ide/opens') {
      state.openCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, opens: state.opens }))
      state.opens = []
      return
    }
    if (req.method === 'POST' && url.pathname === '/dsh-ris-ide/config') {
      state.configCalls += 1
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        state.configBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(state.disableConfig ? 409 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.disableConfig
          ? { ok: false, code: 'config-exists', message: 'exists' }
          : { ok: true, path: '/w/.dsh-ris-ide.json', count: 3, mode: state.configBody.mode ?? 'generate' }))
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/dsh-ris-ide/stop') {
      state.stopCalls += 1
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        state.stopBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(state.disableStop ? 409 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(state.disableStop
          ? { ok: false, code: 'unverifiable', message: 'nope' }
          : { ok: true, stopped: true, alreadyStopped: false, forced: false, waitedMs: 12, pid: 4242, wrapperPid: 4241 }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/dsh-ris-ide/tail') {
      state.tailCalls += 1
      if (state.disableTail) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'forbidden', message: 'loopback requests only' }))
        return
      }
      void hostTest.readTail(file, Number(url.searchParams.get('bytes') ?? 2048)).then((tail) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...tail }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/dsh-ris-ide/fs/read') {
      // The head tier is OUR route now (the sidebar api is gone).
      state.headCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        kind: 'text',
        content: `HEAD-ONLY for ${url.searchParams.get('path')}\n`,
        truncated: true,
        mtimeMs: 7,
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: `http://127.0.0.1:${server.address().port}/` }
  try {
    return await run({ cwd, file, content, state })
  } finally {
    globalThis.document = previousDocument
    // `fetch` keeps connections alive; without this `server.close()` would wait
    // for a pooled socket and the test file would never finish.
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('readLog prefers the host tail route and falls back to fs.read', async () => {
  await withLogServer(async ({ file, content, state }) => {
    const scope = { sessionId: 's1', cwd: '/tmp' }

    const tail = await T.readLog(file, scope, undefined, 2048)
    assert.equal(tail.ok, true)
    assert.equal(tail.mode, 'tail')
    assert.equal(state.tailCalls, 1)
    assert.equal(state.headCalls, 0, 'the fallback must not run when the tail route answers')
    assert.ok(content.endsWith(tail.content), 'the tail must be the file end')
    assert.ok(tail.content.length <= 2048)

    // Refuse the tail route: the viewer must degrade to the head tier with a note.
    state.disableTail = true
    const head = await T.readLog(file, scope, undefined, 2048)
    assert.equal(head.ok, true)
    assert.equal(head.mode, 'head')
    assert.equal(head.note, 'head-mode')
    assert.equal(head.truncated, true)
    assert.match(head.content, /^HEAD-ONLY for /)
    assert.equal(state.headCalls, 1)
  })
})

test('readLog reports an error only when both tiers fail', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://127.0.0.1:1/' }
  try {
    const result = await T.readLog('x.log', { sessionId: 's1' }, undefined, 2048)
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  } finally {
    globalThis.document = previousDocument
  }
})

test('parseLine decorates timestamps and levels', () => {
  const info = T.parseLine('2026-10-16 20:55:51.123  INFO 1 --- [main] Started')
  assert.equal(info.level, 'INFO')
  assert.deepEqual(info.parts.map((part) => part.text), [
    '2026-10-16 20:55:51.123', '  ', 'INFO', ' 1 --- [main] Started',
  ])
  assert.ok(info.parts[0].style.opacity < 1, 'the timestamp is dimmed')
  assert.equal(info.parts[2].style.fontWeight, 600, 'the level token is bold')
  assert.equal(info.parts[2].style.color, undefined, 'INFO keeps the text color')

  const error = T.parseLine('2026-10-16 20:55:51 ERROR boom')
  assert.equal(error.level, 'ERROR')
  assert.equal(error.parts[2].style.color, '#e5534b')

  const warn = T.parseLine('WARN something')
  assert.equal(warn.level, 'WARN')
  assert.equal(warn.parts[0].style.color, '#d29922')

  const plain = T.parseLine('just a line')
  assert.equal(plain.level, undefined)
  assert.deepEqual(plain.parts, [{ text: 'just a line' }])

  const empty = T.parseLine('')
  assert.deepEqual(empty.parts, [{ text: '' }])
})

test('ANSI SGR becomes styled spans and other CSI sequences disappear', () => {
  const colored = T.parseLine('\u001B[31merror\u001B[0m plain')
  assert.equal(colored.parts.length, 2)
  assert.equal(colored.parts[0].text, 'error')
  assert.equal(colored.parts[0].style.color, '#e5534b')
  assert.equal(colored.parts[1].text, ' plain')

  const merged = T.ansiSegments('\u001B[32mok\u001B[32m!\u001B[0m done')
  assert.deepEqual(merged.map((part) => part.text), ['ok!', ' done'])

  const cursor = T.parseLine('\u001B[2K\u001B[1Gclean')
  assert.deepEqual(cursor.parts.map((part) => part.text), ['clean'])

  assert.deepEqual(T.applySgr({}, '31'), { color: '#e5534b' })
  assert.deepEqual(T.applySgr({ color: '#e5534b' }, '1'), { color: '#e5534b', fontWeight: 600 })
  assert.deepEqual(T.applySgr({ color: '#e5534b', fontWeight: 600 }, '0'), {})
  assert.deepEqual(T.applySgr({}, '38;2;1;2;3'), { color: 'rgb(1,2,3)' })
  assert.deepEqual(T.applySgr({}, '38;5;196'), { color: 'rgb(255,55,55)' })
})

test('the log view keeps only the current run of a reused log file', () => {
  const twoRuns = [
    '--- svc started 2026-10-19T10:00:00+08:00 ---',
    'OLD LINE',
    '--- svc exited 2026-10-19T11:00:00+08:00 (status 143) ---',
    '--- svc started 2026-10-20T20:47:40+08:00 ---',
    'NEW LINE',
    '',
  ].join('\n')
  const trimmed = T.trimLogToCurrentRun(twoRuns)
  assert.equal(trimmed.includes('OLD LINE'), false)
  assert.match(trimmed, /^--- svc started 2026-10-20T20:47:40/)
  assert.ok(trimmed.includes('NEW LINE'))
  // marker at position 0 / no marker / empty: unchanged
  const single = '--- svc started 1 ---\nbody\n'
  assert.equal(T.trimLogToCurrentRun(single), single)
  assert.equal(T.trimLogToCurrentRun('plain\n'), 'plain\n')
  assert.equal(T.trimLogToCurrentRun(''), '')
  assert.equal(T.trimLogToCurrentRun(undefined), undefined)
})

test('parseLog splits, drops the trailing blank and caps the window', () => {
  assert.deepEqual(T.parseLog('a\nb\n').map((line) => line.parts[0].text), ['a', 'b'])
  assert.deepEqual(T.parseLog(''), [])
  assert.equal(T.parseLog('x\n'.repeat(5000)).length, 4000, 'the cap keeps the window bounded')
})

test('clampFontSize and serviceText hold the supported ranges', () => {
  assert.equal(T.clampFontSize('14'), 14)
  assert.equal(T.clampFontSize(9), 10)
  assert.equal(T.clampFontSize(99), 20)
  assert.equal(T.clampFontSize('nonsense'), T.DEFAULT_FONT_SIZE)
  assert.equal(T.serviceText(undefined), '')
  assert.equal(T.serviceText({ pid: 7, alive: true }), '运行中 (pid 7)')
  assert.equal(T.serviceText({ pid: 7, alive: false }), '已停止 (pid 7)')
  // Liveness without a pid (legacy row / fixture) keeps the label readable.
  assert.equal(T.serviceText({ alive: true }), '运行中')
  // Both buttons were removed in 1.2.8 (stop duplicates the console; 到底部
  // duplicates the follow toggle).
  assert.match(T.MONO_FAMILY, /Ubuntu Sans Mono/)
})

test('the log viewer is read-only: no stop button, no redundant 到底部', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const render = (customData) => renderToStaticMarkup(React.createElement(T.LogTail, {
    scope: { sessionId: 's1', cwd: '/tmp' },
    path: 'service.log',
    customData: customData,
  }))

  const running = render({
    ok: true, content: 'BOOT-OK\n', mode: 'tail', serviceKnown: true,
    service: { pid: 4242, wrapperPid: 4241, alive: true },
  })
  assert.match(running, /data-service="running"/)
  assert.ok(!running.includes('data-action="stop"'), 'stopping lives in the console, not the log viewer')
  assert.ok(!running.includes('停止服务'))
  assert.ok(!running.includes('data-action="bottom"'), 'following already snaps to the bottom')
  // 1.6.1: the in-body bar is gone — its controls live in the log pane title bar.
  assert.ok(!running.includes('换行:开'), 'no wrap label in the body')
  assert.ok(!running.includes('data-action="font-up"'), 'no size button in the body')
  assert.ok(!running.includes('data-action="follow"'), 'no follow button in the body')
  assert.ok(!running.includes('运行中'), 'the service label is in the pane title bar')
  assert.match(running, /data-wrap="on"/, 'wrap is on by default (body wraps)')

  const exited = render({
    ok: true, content: 'BYE\n', mode: 'tail', serviceKnown: true,
    service: { pid: 4242, alive: false },
  })
  assert.match(exited, /data-service="stopped"/)
  assert.ok(!exited.includes('data-action="stop"'), 'an exited service offers no stop button')

  const none = render({ ok: true, content: 'x\n', mode: 'tail', serviceKnown: true })
  assert.match(none, /data-service="none"/)
  assert.ok(!none.includes('data-action="stop"'))
})

// 1.6.10: the title-bar wrap toggle was a dead button — neither body style
// existed, so both modes fell back to the browser default and nothing moved.
test('the log wrap toggle really changes the body flow', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const render = (wrap) => renderToStaticMarkup(React.createElement(T.LogTail, {
    scope: { sessionId: 's1', cwd: '/tmp' },
    path: 'service.log',
    wrap,
    customData: { ok: true, content: 'BOOT-OK\n', mode: 'tail', serviceKnown: true },
  }))
  const wrapped = render(true)
  assert.match(wrapped, /data-wrap="on"/)
  assert.match(wrapped, /white-space:pre-wrap/, 'wrap on breaks long lines at the pane edge')
  const plain = render(false)
  assert.match(plain, /data-wrap="off"/)
  assert.match(plain, /white-space:pre/, 'wrap off keeps lines intact and scrolls horizontally')
})

test('requestStop posts the scope and reports the outcome', async () => {
  await withLogServer(async ({ file, state }) => {
    const ok = await T.requestStop(file, { sessionId: 's1', cwd: '/tmp' })
    assert.equal(ok.ok, true)
    assert.equal(ok.stopped, true)
    assert.equal(state.stopCalls, 1)
    assert.deepEqual(state.stopBody, { sessionId: 's1', cwd: '/tmp', path: file })

    state.disableStop = true
    const refused = await T.requestStop(file, { sessionId: 's1' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'unverifiable')
    assert.match(refused.error, /nope/)
  })
})



test('openInstanceLog opens the IDE tab through the official right sidebar', () => {
  const { ctx, state } = rightSidebarContext()
  T.openInstanceLog(ctx, { sessionId: 's1', cwd: '/w' }, '/w/logs/ris-model.log', 'ris-model 日志')
  assert.deepEqual(state.opened, ['dsh-ris-ide:ide'])
  assert.equal(typeof T.selectProgram, 'function', 'the pending program helper is part of the surface')
})

test('openInstanceLog refuses loudly when the right sidebar is absent', () => {
  // Regression guard: the panel used to reference `apply`'s `ctx` from module
  // scope, which surfaced as "ctx is not defined" when the human clicked.
  assert.throws(() => T.openInstanceLog(null, { sessionId: 's1' }, '/x.log', 'x'), /右侧栏服务不可用/)
  assert.throws(() => T.openInstanceLog({}, { sessionId: 's1' }, '/x.log', 'x'), /右侧栏服务不可用/)
})


test('generateConfig asks the host to write or update the config', async () => {
  await withLogServer(async ({ state }) => {
    const scope = { sessionId: 's1', cwd: '/w' }
    const generated = await T.generateConfig(scope)
    assert.equal(generated.ok, true)
    assert.equal(generated.path, '/w/.dsh-ris-ide.json')
    assert.equal(generated.mode, 'generate')
    assert.equal(state.configCalls, 1)
    assert.deepEqual(state.configBody, { sessionId: 's1', cwd: '/w' })

    const updated = await T.generateConfig(scope, 'update')
    assert.equal(updated.ok, true)
    assert.equal(updated.mode, 'update')
    assert.deepEqual(state.configBody, { sessionId: 's1', cwd: '/w', mode: 'update' })

    state.disableConfig = true
    const refused = await T.generateConfig(scope, 'overwrite')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'config-exists')
    assert.match(refused.error, /exists/)
  })
})


test('the plugin keeps its SSE connections inside the per-origin budget', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // HTTP/1.1 allows 6 connections per origin; the host itself holds one for its
  // session stream. One shared hub + one tail + one debug stream is the budget.
  const opened = (source.match(/new EventSource\(/g) || []).length
  assert.ok(opened <= 3, `expected at most 3 EventSources, found ${opened}`)
  assert.match(source, /function risStreamHub\(\)/, 'the hub exists')
  for (const topic of ['tree', 'programs', 'debugs', 'opens']) {
    assert.match(source, new RegExp("topics: \\['" + topic + "\\'\\]"), `${topic} rides the shared hub`)
  }
  assert.match(source, /function useDocumentVisible\(\)/, 'background tabs release their streams')
  // The regression that blocked the whole GUI: six streams per IDE panel.
  assert.doesNotMatch(source, /url\.searchParams\.set\('topics', 'tree'\)/)
})

test('the client plugin drains host-side open requests into the IDE tab', async () => {
  await withLogServer(async ({ state }) => {
    state.opens = [{ sessionId: 's1', cwd: '/w', logPath: '/w/logs/ris-model.log', title: 'ris-model 日志' }]
    const { ctx, state: right } = rightSidebarContext()
    const dispose = applyTracked(ctx)
    await T.drainOpenRequests()
    dispose()
    assert.equal(state.openCalls >= 1, true, 'the queue is drained at least once')
    assert.deepEqual(right.opened, ['dsh-ris-ide:ide'], 'a pending log opens the IDE tab')
  })
})


test('classNameFromPath derives the Java class name from RIS source paths', () => {
  const fromPath = client.__test.classNameFromPath
  assert.equal(fromPath('/ws/ris/ris-model/ris-model-biz/src/main/java/cn/com/ris/cloud/model/ModelHelper.java'), 'cn.com.ris.cloud.model.ModelHelper')
  assert.equal(fromPath('ris/x/src/main/java/cn/com/X.java'), 'cn.com.X')
  assert.equal(fromPath('/ws/src/main/java/Probe.java'), 'Probe')
  assert.equal(fromPath('/ws/ris/x/src/main/java/cn/com/X.java'.replace(/\//g, '\\')), 'cn.com.X')
  assert.equal(fromPath('/ws/ris/x/src/main/java/cn/com/X.kt'), undefined)
  assert.equal(fromPath(''), undefined)
  assert.equal(fromPath(undefined), undefined)
})

test('requestDebug builds read URLs and write bodies', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ ok: true, attached: true, seq: 3, events: [] }) }
  }
  try {
    const scope = { sessionId: 's1', cwd: '/w' }
    const polled = await client.__test.requestDebug('poll', scope, { path: '/w/logs/x.log', since: 2 })
    assert.deepEqual(polled, { ok: true, attached: true, seq: 3, events: [] })
    assert.match(calls[0].url, /dsh-ris-ide\/debug\/poll\?/)
    assert.match(calls[0].url, /sessionId=s1/)
    assert.match(calls[0].url, /since=2/)
    assert.equal(calls[0].init.method, undefined, 'reads are GET')

    await client.__test.requestDebug('breakpoints', scope, { path: '/w/logs/x.log', add: { className: 'a.B', line: 7 } })
    assert.equal(calls[1].init.method, 'POST')
    const body = JSON.parse(calls[1].init.body)
    assert.deepEqual(body, { path: '/w/logs/x.log', add: { className: 'a.B', line: 7 }, sessionId: 's1', cwd: '/w' })

    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'not-attached', message: 'nope' }) })
    const failed = await client.__test.requestDebug('step', scope, { path: '/w/logs/x.log', kind: 'over' })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'not-attached')
  } finally {
    globalThis.fetch = original
  }
})


test('fsTree asks our tree route and keeps the folded labels', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        path: '/w/proj',
        entries: [
          { name: 'model', label: 'model', path: '/w/proj/model', isDir: true, compact: false },
          { name: 'cloud', label: 'cn.com.ris.cloud.model', path: '/w/proj/cn/com/ris/cloud/model', isDir: true, compact: true },
          { name: 'a.java', label: 'a.java', path: '/w/proj/a.java', isDir: false },
        ],
        truncated: false,
      }),
    }
  }
  try {
    const tree = await T.fsTree({ sessionId: 's1', cwd: '/w' }, '/w/proj')
    assert.equal(tree.entries.length, 3)
    assert.equal(tree.entries[1].label, 'cn.com.ris.cloud.model', 'the compact label survives')
    assert.equal(tree.entries[1].path, '/w/proj/cn/com/ris/cloud/model', 'the folded path is the expansion target')
    assert.equal(tree.path, '/w/proj')
    assert.equal(tree.truncated, false)

    const url = new URL(calls[0].url, 'http://dsh.internal')
    assert.equal(url.pathname.endsWith('/dsh-ris-ide/tree'), true, `unexpected url ${calls[0].url}`)
    assert.equal(url.searchParams.get('path'), '/w/proj')
    assert.equal(url.searchParams.get('sessionId'), 's1')
    assert.equal(url.searchParams.get('cwd'), '/w')
  } finally {
    globalThis.fetch = original
  }
})

test('fsTree surfaces the host message instead of the HTTP status', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, message: 'boom' }),
  })
  try {
    await assert.rejects(T.fsTree({ sessionId: 's1-fail', cwd: '/w' }, '/w/proj-fail'), /boom/)
  } finally {
    globalThis.fetch = original
  }
})

test('fsRead asks our own fs/read route and rejects binary or oversized files', async () => {
  const original = globalThis.fetch
  const calls = []
  const answer = (payload) => async (href) => {
    calls.push(String(href))
    return { ok: true, status: 200, json: async () => payload }
  }
  const scope = { sessionId: 's1', cwd: '/w' }
  try {
    globalThis.fetch = answer({ ok: true, kind: 'text', content: 'hello', size: 5, mtimeMs: 1 })
    assert.equal(await T.fsRead(scope, '/w/a.java'), 'hello')
    const url = new URL(calls[0])
    assert.equal(url.pathname.endsWith('/dsh-ris-ide/fs/read'), true, 'must not use the sidebar api')
    assert.equal(url.searchParams.get('path'), '/w/a.java')
    assert.equal(url.searchParams.get('sessionId'), 's1')

    globalThis.fetch = answer({ ok: true, kind: 'binary', size: 5 })
    await assert.rejects(T.fsRead(scope, '/w/a.png'), /二进制/)

    globalThis.fetch = answer({ ok: true, kind: 'too-large', size: 9000000 })
    await assert.rejects(T.fsRead(scope, '/w/big.log'), /过大/)
  } finally {
    globalThis.fetch = original
  }
})

test('fsSearch asks our gitignore-aware host route and returns absolute files', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (href, init) => {
      calls.push({ href: String(href), method: (init && init.method) || 'GET' })
      return { ok: true, status: 200, json: async () => ({ ok: true, matches: ['/w/ris/a.java', '/w/b.ts'], truncated: false, files: 13755 }) }
    }
    const result = await T.fsSearch({ sessionId: 's1', cwd: '/w' }, 'a.java')
    assert.deepEqual(result.matches, ['/w/ris/a.java', '/w/b.ts'])
    assert.deepEqual(result.dirs, {}, 'the gitignore search returns files only')
    assert.equal(calls.length, 1)
    const url = new URL(calls[0].href)
    assert.equal(url.pathname.endsWith('/dsh-ris-ide/search'), true, 'must use this plugin\'s search route')
    assert.equal(url.searchParams.get('q'), 'a.java')
    assert.equal(url.searchParams.get('cwd'), '/w')
    assert.equal(url.searchParams.get('sessionId'), 's1')
  } finally {
    globalThis.fetch = original
  }
})

test('fsWrite posts JSON to our own fs/write route and returns the fresh baseline', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ ok: true, mtimeMs: 123 }) }
  }
  try {
    const written = await T.fsWrite({ sessionId: 's1', cwd: '/w' }, '/w/a.java', 'new text')
    assert.equal(written.mtimeMs, 123)
    const url = new URL(calls[0].url, 'http://dsh.internal')
    assert.ok(url.pathname.endsWith('/dsh-ris-ide/fs/write'), `unexpected url ${calls[0].url}`)
    assert.equal(calls[0].init.method, 'POST')
    assert.match(calls[0].init.headers['content-type'], /application\/json/)
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's1', cwd: '/w', path: '/w/a.java', content: 'new text' })

    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, message: 'conflict' }) })
    await assert.rejects(T.fsWrite({ sessionId: 's1', cwd: '/w' }, '/w/a.java', 'x'), /conflict/)
  } finally {
    globalThis.fetch = original
  }
})

test('undo back to the saved text is not dirty any more', () => {
  assert.equal(T.docDirty({ kind: 'text', text: 'a', saved: 'a' }, { dirty: true }), false, 'mirrored text wins over the stale toolbar flag')
  assert.equal(T.docDirty({ kind: 'text', text: 'a', saved: 'b' }, undefined), true)
  assert.equal(T.docDirty(undefined, { dirty: true }), true, 'before the text is mirrored the toolbar flag is the only signal')
  assert.equal(T.docDirty(undefined, undefined), false)
  assert.equal(T.docDirty({ kind: 'media' }, { dirty: true }), true)
  assert.equal(T.fileBaseName('/w/ris/src/A.java'), 'A.java')
  assert.equal(T.fileBaseName('/w/ris'), 'ris')
  assert.equal(T.fileBaseName(''), '')
})

test('the tree colour-codes file kinds', () => {
  assert.equal(T.fileKind({ isDir: true, name: 'src', path: '/w/src' }), 'dir')
  assert.equal(T.fileKind({ name: 'A.java', path: '/w/A.java' }), 'java')
  assert.equal(T.fileKind({ name: 'app.yml', path: '/w/app.yml' }), 'yaml')
  assert.equal(T.fileKind({ name: 'README', path: '/w/README' }), 'other')
  assert.equal(T.fileKind({ name: 'x.unknown', path: '/w/x.unknown' }), 'other')
  assert.equal(T.fileKind({ name: 'README.md', path: '/w/README.md' }), 'md')
  assert.equal(T.fileKind({ name: '.gitignore', path: '/w/.gitignore' }), 'dot')
  assert.equal(T.fileKind({ isDir: true, name: '.github', path: '/w/.github' }), 'dot')
  assert.equal(T.fileKind({ name: 'A.java', path: '/w/.cache/A.java' }), 'java', 'a dot FOLDER is what greys, not a file inside it')
  assert.notEqual(T.fileKindColor('java'), 'inherit')
  assert.notEqual(T.fileKindColor('java'), T.fileKindColor('css'), 'different kinds differ')
  assert.equal(T.fileKindColor('md'), '#9ecbff', 'markdown has its own colour')
  assert.equal(T.fileKindColor('dot'), '#8b949e', 'dot entries are grey')
  assert.equal(T.fileKindColor('nope'), 'inherit')
})

test('new file names keep exactly one suffix', () => {
  assert.equal(T.normalizeFileName('ModelHelper', 'java'), 'ModelHelper.java')
  assert.equal(T.normalizeFileName('ModelHelper.java', 'java'), 'ModelHelper.java')
  assert.equal(T.normalizeFileName('ModelHelper.JAVA', 'java'), 'ModelHelper.JAVA')
  assert.equal(T.normalizeFileName('helper.js', 'java'), 'helper.js', 'another extension is respected')
  assert.equal(T.normalizeFileName('config.', 'yml'), 'config.yml')
  assert.equal(T.normalizeFileName('  ', 'xml'), '')
  assert.equal(T.normalizeFileName('.gitignore', 'txt'), '.gitignore')
})

test('a package name becomes directories under src/main/java', () => {
  const dir = '/w/ris/ris-model/src/main/java'
  assert.equal(T.newFilePath(dir, 'cn.com.ris', 'ModelHelper', 'java'), `${dir}/cn/com/ris/ModelHelper.java`)
  assert.equal(T.newFilePath(dir, '  cn.com.ris.  ', 'ModelHelper.java', 'java'), `${dir}/cn/com/ris/ModelHelper.java`)
  assert.equal(T.newFilePath(dir, '', 'Plain', 'java'), `${dir}/Plain.java`)
  assert.equal(T.newFilePath(`${dir}/`, '', 'Plain', 'java'), `${dir}/Plain.java`)
  assert.equal(T.isJavaSourceDir(`${dir}/cn`), true)
  assert.equal(T.isJavaSourceDir('/w/src/main/kotlin'), false)
  assert.equal(T.isJavaSourceDir('/w/ris-model/src/main/java2'), false)
})

test('a package name creates multi-level folders, and only for legal identifiers', () => {
  assert.equal(T.packagePathOf('cn.com.ris'), 'cn/com/ris')
  assert.equal(T.packagePathOf('  .cn.com.ris.  '), 'cn/com/ris', 'surrounding dots are ignored')
  assert.equal(T.packagePathOf('model'), 'model')
  assert.equal(T.packagePathOf('_a.$b.c1'), '_a/$b/c1', 'Java identifier rules allow _ $ and digits after the first char')
  assert.equal(T.packagePathOf('cn..ris'), '', 'an empty segment is not a package')
  assert.equal(T.packagePathOf('cn/ris'), '', 'slashes are refused (the path is built here, not typed)')
  assert.equal(T.packagePathOf('cn.9ris'), '', 'a segment cannot start with a digit')
  assert.equal(T.packagePathOf('  .  '), '')
  assert.equal(T.packagePathOf(''), '')
})

test('the tree offers 新建包名 only under java, and a package becomes folders', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Menu entry sits right after 新建文件夹 and is guarded by isJavaSourceDir.
  assert.ok(source.indexOf("'data-tree-action': 'new-package'") > source.indexOf("'data-tree-action': 'new-dir'"), '新建包名 comes after 新建文件夹')
  assert.match(source, /isJavaSourceDir\(treeMenu\.dir\)\n\s+\? h\('button', \{ key: 'new-package'/)
  assert.match(source, /'data-tree-action': 'new-package'[^\n]*openCreatePrompt\('package', treeMenu\.dir\)/)
  // The prompt has a package mode with dotted-name hint and a path preview.
  assert.match(source, /prompt\.mode === 'package'/)
  assert.match(source, /mode === 'package'\n\s+\? '新建包名'/)
  assert.match(source, /isPackage \? '包名' : '文件夹名'/)
  // Submitting creates the multi-level directory (host mkdir is recursive) and expands it.
  assert.match(source, /packageRelative = packagePathOf\(name\)/)
  assert.match(source, /await fsMkdir\(scope, packageDir\)/)
  assert.match(source, /next\[packageBase\] = true/)
  // The file prompt under java has ONE field: dots build the package folders,
  // so the old second "包名" input is gone (and no prefill logic remains).
  assert.doesNotMatch(source, /guessPackage/)
  assert.doesNotMatch(source, /data-tree-prompt-package/)
  assert.match(source, /javaFilePath\(prompt\.dir, name, prompt\.ext\)/)
  assert.match(source, /名称不合法：如 cloud\.test/, 'the invalid-name toast stays short too')
})

test('under java one dotted name builds package folders and the file', () => {
  const java = '/w/ris/ris-model/src/main/java'
  assert.equal(T.javaFilePath(java, 'cloud.test', 'java'), `${java}/cloud/test.java`)
  assert.equal(T.javaFilePath(java, 'cn.com.ris.Foo', 'java'), `${java}/cn/com/ris/Foo.java`)
  assert.equal(T.javaFilePath(java, 'Cloud.Test.java', 'java'), `${java}/Cloud/Test.java`, 'a typed suffix is not part of the file name')
  assert.equal(T.javaFilePath(java, 'ModelHelper', 'java'), `${java}/ModelHelper.java`)
  assert.equal(T.javaFilePath(java, '  .cloud.test.  ', 'java'), `${java}/cloud/test.java`, 'stray edge dots are ignored')
  assert.equal(T.javaFilePath(java, 'notes.md', ''), `${java}/notes.md`, '普通文件 keeps dots in the name')
  assert.equal(T.javaFilePath(java, 'cloud..test', 'java'), '', 'empty segment is refused')
  assert.equal(T.javaFilePath(java, 'cloud/test', 'java'), '', 'slashes are refused')
  assert.equal(T.javaFilePath(java, '9cloud.test', 'java'), '', 'a package segment cannot start with a digit')
  assert.equal(T.javaFilePath(java, '', 'java'), '')
})

test('a stopped host produces a readable tree error and retries with backoff', () => {
  // A stale session id is rejected with 400: say so instead of retrying forever.
  const stale = new Error('no working directory for session')
  stale.status = 400
  assert.match(T.treeErrorMessage(stale), /会话上下文已失效/)
  assert.match(T.treeErrorMessage(new Error('Failed to fetch')), /宿主未响应/)
  assert.match(T.treeErrorMessage(new TypeError('fetch failed')), /宿主未响应/)
  assert.match(T.treeErrorMessage(new Error('HTTP 500')), /HTTP 500/)
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map((n) => T.treeRetryDelay(n)), [800, 1600, 3200, 6000, 10000, 10000, 10000])
  assert.equal(T.treeRetryDelay(-3), 800)
})

test('a stale session still works because the workspace path is remembered', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /WORKSPACE_CWD_KEY = 'dsh-ris-ide:last-cwd'/)
  assert.match(source, /function rememberWorkspaceCwd\(/)
  assert.match(source, /function knownWorkspaceCwd\(/)
  assert.match(source, /function scopeCwd\(/)
  assert.match(source, /var routeCwd = scopeCwd\(scope\)/, 'routes fall back to the remembered cwd')
  // Tree answers must teach the WORKSPACE cwd, never the listed directory: the
  // latter made an expanded folder look like a new workspace root (tree re-rooted
  // and flashed).
  assert.match(source, /rememberWorkspaceCwd\(treeCwd\)/, 'tree answers teach the workspace cwd')
  assert.doesNotMatch(source, /rememberWorkspaceCwd\(listing\.path\)/, 'never remember the listed dir')
  assert.match(source, /rememberWorkspaceCwd\(payload\.root\)/, 'programs answers teach the path')
})

test('the selected range is highlighted stronger than the other matches', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var SELECTION_CSS = /)
  assert.match(source, /rgba\(86,182,194,0\.42\)/, 'selection is opaque teal')
  // the active-line tint must not cover the selection on the current line(s)
  assert.match(source, /cm-selectionLayer\{z-index:5 !important;pointer-events:none !important\}/,
    'the raised selection layer must not swallow clicks meant for the caret')
  assert.match(source, /dsh-ris-ide-has-selection \.cm-activeLine/, 'selection hides the current-line tint')
  assert.match(source, /dsh-ris-ide-has-selection \.cm-activeLineGutter/)
  assert.match(source, /rgba\(86,182,194,0\.50\)/, 'focused selection is stronger')
  assert.match(source, /rgba\(210,153,34,0\.45\)/, 'the current match is amber')
  const chunk = await readFile(new URL('../lib/client-codemirror.js', import.meta.url), 'utf8')
  assert.match(chunk, /cm-selectionMatch/, 'the editor highlights other matches')
  assert.match(chunk, /210, 153, 34/, 'other matches are amber')
  assert.match(chunk, /86, 182, 194, 0\.4/, 'the selection itself is teal and opaque enough')
  assert.match(chunk, /dsh-ris-ide-has-selection/, 'the editor marks itself while a selection exists')
})

test('the tree clipboard keys only fire while the tree owns the focus', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var root = treeListRef\.current/)
  assert.match(source, /if \(!inside\) return/)
  assert.match(source, /tabIndex: -1/)
})

// 1.6.10: Ctrl+C / Ctrl+X used to read the context-menu state only, so the
// keyboard silently copied nothing; 全选 has no meaning in a single-selection
// tree and must not hand the page a text selection either.
test('Ctrl+C copies the selected tree row without the context menu', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var entry = treeMenu !== null && treeMenu\.entry !== null && treeMenu\.entry !== undefined/,
    'the context-menu entry still wins when the menu is open')
  assert.match(source, /: \(selectedPath === null \? null : findEntry\(selectedPath\)\)/,
    'the keyboard falls back to the tree selection')
  assert.match(source, /if \(entry === null \|\| entry === undefined\) return/)
  assert.match(source, /event\.key === 'a' \|\| event\.key === 'A'/, 'Ctrl+A is claimed while the tree owns the keys')
})

test('a file row is a drop target for the directory it lives in', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var dropDir = entry\.isDir === true \? entry\.path : parentOf\(entry\.path\)/)
  assert.match(source, /var isDropTarget = dropTarget === entry\.path/, 'file rows highlight too')
  assert.match(source, /void moveInto\(from, dropDir\)/, 'dropping on a file moves into its parent')
  assert.match(source, /void importExternal\(dropDir, external, \[\]\)/)
  // The row handlers must not be dir-gated any more (the bug: `undefined` let the
  // list container's "blank area = workspace root" drop swallow the event).
  assert.doesNotMatch(source, /onDrop: entry\.isDir === true \?/)
  assert.doesNotMatch(source, /onDragOver: entry\.isDir === true \?/)
})

test('a forced tree read asks the host for a fresh listing', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /if \(force === true\) url\.searchParams\.set\('fresh', '1'\)/)
})

test('the tree 复制 menu copies, while 创建副本 makes the duplicate', async () => {
  assert.equal(T.duplicateName('A.java', false), 'A - 副本.java')
  assert.equal(T.duplicateName('ModelHelper.java', false), 'ModelHelper - 副本.java')
  assert.equal(T.duplicateName('A.java', false, 2), 'A - 副本2.java')
  assert.equal(T.duplicateName('Makefile', false), 'Makefile - 副本')
  assert.equal(T.duplicateName('.gitignore', false), '.gitignore - 副本')
  assert.equal(T.duplicateName('pkg', true), 'pkg - 副本')
  assert.equal(T.duplicateName('pkg', true, 3), 'pkg - 副本3')
  assert.equal(T.duplicateName('', false), '')
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 复制 = clipboard copy (the normal meaning); 创建副本 = the in-place duplicate.
  assert.match(source, /'data-tree-action': 'copy'/, '复制 copies to the tree clipboard')
  assert.match(source, /beginCopy\('copy'\)/)
  assert.match(source, /'data-tree-action': 'duplicate'/, '创建副本 duplicates in place')
  assert.match(source, /setPrompt\(\{ mode: 'duplicate'/)
  assert.match(source, /setPromptName\(duplicateName\(/)
  assert.match(source, /副本名称不能与原文件相同/)
  // A paste collision asks for a NEW name (the 副本 convention prefilled), it does
  // not park a 覆盖/改名/取消 dialog any more — and the copy banner at the top of
  // the tree is gone.
  assert.match(source, /function parkPasteName\(source, dir, name\)/)
  assert.match(source, /setPrompt\(\{ mode: 'paste', dir: dir, ext: '', title: '粘贴为', source: source, conflict: name \}\)/)
  assert.match(source, /setPromptName\(duplicateName\(name, false\)\)/)
  assert.match(source, /if \(prompt\.conflict !== undefined && name === prompt\.conflict\)/)
  assert.match(source, /if \(isExistsProblem\(problem\)\) \{\n\s+parkPasteName\(source, dir, name\)/)
  assert.doesNotMatch(source, /data-tree-paste-conflict/)
  assert.doesNotMatch(source, /data-tree-clipboard/)
  // A COPY onto its own path is a duplicate request (falls through to the prompt),
  // while CUT → its own folder stays a silent no-op.
  assert.match(source, /if \(source\.kind === 'clipboard' && target === from && clipboard\.mode !== 'copy'\)/)
  // …and moving an entry into its own folder stays a silent no-op.
  assert.match(source, /if \(from === dirPath \|\| parentOf\(from\) === dirPath\) return/)
})

test('the recent-file dropdown is walkable like the result list', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // One highlighted index drives both dropdowns.
  assert.match(source, /var inHistory = searchHistoryRows\.length > 0/)
  assert.match(source, /var count = inHistory \? searchHistoryRows\.length : matches\.length/)
  // Landing on the box highlights row 0 of the history list.
  assert.match(source, /if \(searchHistoryRows\.length === 0\) return\n\s+setSearchActive\(0\)/)
  // …and the row can be opened with Enter without touching the caret.
  assert.match(source, /if \(inHistory\) \{\n\s+var row = searchHistoryRows\[index\]/)
  assert.match(source, /void openRecentPath\(row\.path\)/)
  assert.match(source, /'data-search-history-active': on \? '1' : '0'/)
  assert.match(source, /onMouseEnter: function \(\) \{ setSearchActive\(index\) \}/)
  assert.match(source, /最近打开 · ' \+ searchHistoryRows\.length \+ ' 个（↑↓ 选择，Enter 打开）/)
})

test('renaming a file or folder keeps tabs, drafts and history pointing at it', async () => {
  // paths under a renamed folder follow it; unrelated paths stay untouched
  assert.equal(T.remapPath('/w/a.java', '/w/a.java', '/w/b.java'), '/w/b.java')
  assert.equal(T.remapPath('/w/pkg/A.java', '/w/pkg', '/w/lib'), '/w/lib/A.java')
  assert.equal(T.remapPath('/w/pkg/deep/A.java', '/w/pkg', '/w/lib'), '/w/lib/deep/A.java')
  assert.equal(T.remapPath('/w/other.java', '/w/pkg', '/w/lib'), '/w/other.java')
  assert.equal(T.remapPath('/w/pkg2/A.java', '/w/pkg', '/w/lib'), '/w/pkg2/A.java', 'prefix must be a path segment')
  assert.equal(T.remapPath('', '/w/pkg', '/w/lib'), '')
  assert.equal(T.remapPath('/w/a', '', '/w/b'), '/w/a')
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /'data-tree-action': 'rename'/, 'the tree menu offers 重命名')
  assert.match(source, /openRenamePrompt\(findEntry\(selectedPath\)\)/, 'F2 renames the selected entry')
  assert.match(source, /onRename: renamePaths/, 'the workbench remaps open tabs')
})

test('the new-file menu starts with a plain file that keeps its name verbatim', async () => {
  // no suffix: the typed name is the file name (Makefile, .gitignore, README…)
  assert.equal(T.normalizeFileName('Makefile', ''), 'Makefile')
  assert.equal(T.normalizeFileName('.gitignore', ''), '.gitignore')
  assert.equal(T.normalizeFileName('notes.txt', ''), 'notes.txt')
  assert.equal(T.newFilePath('/w', '', 'Makefile', ''), '/w/Makefile')
  assert.equal(T.newFilePath('/w', '', 'README.md', ''), '/w/README.md')
  // a suffixed type still auto-completes
  assert.equal(T.normalizeFileName('ModelHelper', 'java'), 'ModelHelper.java')
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var NEW_FILE_TYPES = \[\n(?:\s*\/\/[^\n]*\n)*\s*\{ ext: '', label: '普通文件' \},/, 'plain file is the first entry')
  assert.match(source, /新建普通文件/)
  assert.match(source, /如 Makefile、README/, 'the plain-file hint stays short')
})

test('the tree watch only reloads loaded directories and keeps a short cache', () => {
  const levels = {
    '/w': [{ name: 'ris', path: '/w/ris', isDir: true }],
    '/w/ris': [{ name: 'src', path: '/w/ris/src', isDir: true }],
  }
  // a changed file inside a loaded folder reloads THAT folder
  assert.deepEqual(T.changedLevelsToRefresh(levels, '/w', '.', ['ris/A.java']), ['/w/ris'])
  // a changed file under the loaded root but in an unloaded folder reloads the root
  assert.deepEqual(T.changedLevelsToRefresh(levels, '/w', '.', ['db/x.sql']), ['/w'])
  // a change deep inside an unloaded folder re-renders nothing at all
  assert.deepEqual(T.changedLevelsToRefresh(levels, '/w', '.', ['ris/src/main/A.java']), [])
  // a directory event for a loaded folder reloads it
  assert.deepEqual(T.changedLevelsToRefresh(levels, '/w', '.', ['ris']), ['/w/ris'])
  assert.deepEqual(T.changedLevelsToRefresh(levels, '/w', '.', []), [])
  assert.equal(T.TREE_REFRESH_THROTTLE_MS, 800)
  // Watcher events can concern rows the tree does not draw (gitignored churn,
  // file content); an identical level must not re-render.
  const level = [
    { name: 'A.java', path: '/w/A.java', isDir: false, kind: 'java' },
    { name: 'src', path: '/w/src', isDir: true, kind: 'dir' },
  ]
  const clone = level.map((entry) => Object.assign({}, entry))
  assert.equal(T.sameTreeEntries(level, clone), true, 'same rows are a no-op')
  assert.equal(T.sameTreeEntries(level, clone.concat([{ name: 'B.java', path: '/w/B.java', isDir: false }])), false, 'a new row re-renders')
  assert.equal(T.sameTreeEntries(level, [{ name: 'src', path: '/w/src', isDir: true, kind: 'dir' }]), false, 'a removed row re-renders')
  assert.equal(T.sameTreeEntries(undefined, clone), false, 'the first load always renders')
  assert.equal(T.treeListingFresh(1000, 1500, 1500), true)
  assert.equal(T.treeListingFresh(1000, 2500, 1500), false)
  assert.equal(T.treeListingFresh(2000, 1500, 1500), false, 'clock skew is not fresh')
  assert.equal(T.TREE_LIST_TTL_MS, 1500)
})

test('deletes park in the undo trash under a unique, recognisable name', () => {
  assert.equal(T.TREE_TRASH_DIR, '.dsh-ris-ide-trash')
  assert.equal(T.trashDirFor('/w/ris'), '/w/ris/.dsh-ris-ide-trash')
  assert.equal(T.trashDirFor('/w/ris/'), '/w/ris/.dsh-ris-ide-trash')
  assert.equal(T.trashNameFor('/w/ris/src/ModelHelper.java', 1730), '1730-ModelHelper.java')
  assert.equal(T.trashNameFor('/w/ris/src', 1730), '1730-src')
})

test('rich formats hand off to the official preview addresses', () => {
  assert.equal(T.shouldUseOfficialPreview('/w/a.pdf'), true)
  assert.equal(T.shouldUseOfficialPreview('/w/a.xlsx'), true)
  assert.equal(T.shouldUseOfficialPreview('/w/a.java'), false)
  assert.equal(T.shouldUseOfficialPreview('/w/a.md'), false)
  assert.equal(T.shouldUseOfficialPreview('/w/noext'), false)
  assert.equal(
    T.officialPreviewAddress({ sessionId: 's1', cwd: '/w' }, '/w/ris/a.pdf'),
    'dsh-resource://file/session/s1/ris/a.pdf',
  )
  assert.equal(
    T.officialPreviewAddress({ sessionId: 's1', cwd: '/w' }, '/w/a b.pdf'),
    'dsh-resource://file/session/s1/a%20b.pdf',
  )
  assert.equal(
    T.officialPreviewAddress({ sessionId: 's1', cwd: '/w' }, '/other/a.pdf'),
    'dsh-resource://file/absolute/other/a.pdf',
  )
  assert.equal(
    T.officialPreviewAddress({ sessionId: 's1', cwd: 'C:\\w' }, 'C:\\w\\a.pdf'),
    'dsh-resource://file/session/s1/a.pdf',
  )
})

test('markdown/html get an on-demand official preview, not the auto hand-off', () => {
  assert.equal(T.supportsTextPreview('/w/README.md'), true)
  assert.equal(T.supportsTextPreview('/w/docs/a.markdown'), true)
  assert.equal(T.supportsTextPreview('/w/page.html'), true)
  assert.equal(T.supportsTextPreview('/w/page.HTM'), true)
  assert.equal(T.supportsTextPreview('/w/Model.java'), false)
  assert.equal(T.supportsTextPreview('/w/README'), false)
  assert.equal(T.supportsTextPreview(undefined), false)
  // The auto hand-off still leaves Markdown in the editor (it must stay editable).
  assert.equal(T.shouldUseOfficialPreview('/w/README.md'), false)
  assert.equal(T.shouldUseOfficialPreview('/w/page.html'), false)
})

test('the inline Markdown preview escapes content and only builds safe tags', () => {
  assert.match(T.renderMarkdown('# Title'), /<h1>Title<\/h1>/)
  const escaped = T.renderMarkdown('<script>alert(1)</script>')
  assert.doesNotMatch(escaped, /<script>/)
  assert.match(escaped, /&lt;script&gt;/)
  assert.doesNotMatch(T.renderMarkdown('[x](javascript:alert(1))'), /javascript:/)
  assert.doesNotMatch(T.renderMarkdown('[x](vbscript:msgbox)'), /vbscript:/)
  assert.match(T.renderMarkdown('**bold** and `code`'), /<strong>bold<\/strong>/)
  assert.match(T.renderMarkdown('```js\nconst a = 1\n```'), /<pre data-lang="js"><code>const a = 1<\/code><\/pre>/)
  const table = T.renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.match(table, /<th>a<\/th>/)
  assert.match(table, /<td>2<\/td>/)
  // relative images resolve through the IDE media route
  const media = T.renderMarkdown('![logo](img/logo.png)', { mediaUrl: (src) => '/media?path=' + encodeURIComponent(src) })
  assert.match(media, /src="\/media\?path=img%2Flogo\.png"/)
})

test('OS clipboard paths are parsed for import', () => {
  const text = '# copied files\nfile:///tmp/a%20b.md\n/tmp/c.txt\n/tmp/c.txt\nhttps://example.com/x\n'
  assert.deepEqual(T.parseClipboardPaths(text), ['/tmp/a b.md', '/tmp/c.txt'])
  assert.deepEqual(T.parseClipboardPaths('C:\\w\\a.txt'), ['C:\\w\\a.txt'])
  assert.deepEqual(T.parseClipboardPaths(''), [])
  assert.deepEqual(T.parseClipboardPaths(undefined), [])
})

test('preview images resolve relative to the Markdown file, not the tree', () => {
  const scope = { sessionId: 's1', cwd: '/w/ris' }
  const rel = T.previewAssetUrl(scope, '/w/ris/docs/README.md', '../docs/screenshots/ris-console.png')
  const url = new URL(rel, 'http://localhost')
  assert.equal(url.pathname, '/dsh-ris-ide/fs/file')
  assert.equal(url.searchParams.get('sessionId'), 's1')
  assert.equal(url.searchParams.get('path'), '/w/ris/docs/screenshots/ris-console.png')
  assert.equal(T.previewAssetUrl(scope, '/w/ris/README.md', 'https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(T.previewAssetUrl(scope, '/w/ris/README.md', ''), '')
  // Preview URLs carry NO cache-buster: a changing `t=` would regenerate the
  // preview HTML on every render and reset the scroll position.
  assert.equal(url.searchParams.get('t'), null, 'no cache-buster in a preview image URL')
  const again = T.previewAssetUrl(scope, '/w/ris/docs/README.md', '../docs/screenshots/ris-console.png')
  assert.equal(again, rel, 'the same image resolves to the same URL across renders')
})

test('the preview HTML is memoised (unrelated re-renders must not reset the scroll)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var previewHtml = React\.useMemo\(function \(\) \{/, 'the HTML is memoised')
  assert.match(source, /\}, \[previewingFile, openFile, previewText\]\)/, 'only file/text/dirty input regenerates it')
  assert.match(source, /dangerouslySetInnerHTML: \{ __html: previewHtml \}/, 'the pane renders the memoised HTML')
  assert.doesNotMatch(source, /__html: renderMarkdown\(/, 'no per-render renderMarkdown in the pane')
  assert.match(source, /fileMediaUrl\(scope, \(absolute \? '\/' : ''\) \+ stack\.join\('\/'\)\)?.*?cacheBust: false/, 'preview images opt out of the cache-buster')
})

test('the preview memo is declared after scopeRef (an early var read crashed the preview)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const scopeAt = source.indexOf('var scopeRef = useRef({ sessionId: sessionId, cwd: cwd })')
  const memoAt = source.indexOf('var previewHtml = React.useMemo(function () {')
  assert.ok(scopeAt > 0, 'scopeRef is declared')
  assert.ok(memoAt > 0, 'the memo exists')
  assert.ok(memoAt > scopeAt, 'previewHtml must be initialised after scopeRef (var hoisting)')
  assert.match(source, /scopeRef === undefined \? \{ sessionId: sessionId, cwd: cwd \}/, 'the memo also has a defensive fallback')
})

test('previewAssetUrl lives at the shared scope (it once reached for the tree-only parentOf)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\n {4}function previewAssetUrl\(scope, mdPath, raw\) \{/, 'shared scope definition')
  assert.doesNotMatch(source, /\n {6}function previewAssetUrl\(mdPath, raw\)/, 'no workbench-local copy')
  assert.match(source, /previewAssetUrl\(scope, openFile, src\)/, 'the pane passes a resolved scope')
  assert.match(source, /scopeRef\.current/, 'the resolved scope comes from scopeRef')
})

test('the tree mutations post JSON to the fs op routes', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ ok: true, path: '/w/x' }) }
  }
  try {
    const scope = { sessionId: 's1', cwd: '/w' }
    await T.fsMkdir(scope, '/w/newdir')
    await T.fsCreateFile(scope, '/w/A.java', 'class A {}')
    await T.fsCopyEntry(scope, '/w/A.java', '/w/dest')
    await T.fsMoveEntry(scope, '/w/A.java', '/w/dest')
    await T.fsRemoveEntry(scope, '/w/A.java', true)
    const routes = calls.map((call) => new URL(call.url).pathname.replace(/^.*\/dsh-ris-ide\//, ''))
    assert.deepEqual(routes, ['fs/mkdir', 'fs/create', 'fs/copy', 'fs/move', 'fs/remove'])
    for (const call of calls) assert.equal(call.init.method, 'POST')
    const createBody = JSON.parse(calls[1].init.body)
    assert.deepEqual(createBody, { sessionId: 's1', cwd: '/w', path: '/w/A.java', content: 'class A {}' })
    assert.equal(JSON.parse(calls[2].init.body).toDir, '/w/dest')
    assert.equal(JSON.parse(calls[4].init.body).recursive, true)
  } finally {
    globalThis.fetch = original
  }
})

test('absolutePath resolves cwd-relative paths and keeps absolute ones', () => {
  assert.equal(T.absolutePath('/w', 'ris/a.java'), '/w/ris/a.java')
  assert.equal(T.absolutePath('/w/', 'ris/a.java'), '/w/ris/a.java')
  assert.equal(T.absolutePath('/w', '/x/y'), '/x/y')
  assert.equal(T.absolutePath('/w', 'C:\\x\\y'), 'C:/x/y')
})

test('the editor chunk never puts null into the language compartment', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/chunks/codemirror.js', import.meta.url), 'utf8')
  assert.match(source, /languageCompartment\.of\(languageForPath\(options\.path\) \|\| \[\]\)/, 'mount guards plain-text files')
  assert.match(source, /languageCompartment\.reconfigure\(languageForPath\(path\) \|\| \[\]\)/, 'setLanguage guards too')
  // Regression: EditorState.create crashed on `null.extension` for files with no language.
  assert.doesNotMatch(source, /languageCompartment\.of\(languageForPath\(options\.path\)\)/)
})

test('the text editor loads the CodeMirror chunk and shows a loading state first', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const editor = renderToStaticMarkup(React.createElement(T.IdeTextEditor, {
    path: '/w/a.java', text: 'class A {}\n', fontRatio: 1,
  }))
  assert.match(editor, /data-codemirror-loading="1"/, 'the chunk is fetched on mount, not during SSR')
  assert.equal(typeof T.loadRisIdeChunk, 'function', 'the loader is part of the test surface')
})

test('the workbench renders the debug tabs above the reused log viewer', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderToStaticMarkup(React.createElement(client.__test.ProgramWorkbench, {
    scope: { sessionId: 's1', cwd: '/w' },
    visible: false,
    tab: {
      id: 'dsh-ris-ide:program',
      type: 'dsh-ris-ide:program',
      title: 'ris-model-biz',
      meta: { programId: 'spring:x#a.B', logPath: '/w/logs/ris-model-biz.log', name: 'ris-model-biz', kind: 'spring' },
    },
  }))
  assert.match(markup, /data-workbench/)
  assert.match(markup, /ris-model-biz/)
  for (const label of ['断点', '线程', '调用栈', '变量', '事件']) assert.match(markup, new RegExp(label))
  // The section switcher is a TAB STRIP (multi-tab), not a row of buttons: one
  // tablist, five tabs, exactly one selected, attached to the content panel.
  assert.match(markup, /data-debug-tabs="1"/, 'the debug sections are a tab strip')
  assert.equal((markup.match(/role="tab"/g) || []).length, 5, 'five section tabs')
  assert.equal((markup.match(/aria-selected="true"/g) || []).length, 1, 'exactly one active tab')
  assert.match(markup, /role="tabpanel"/)
  assert.match(markup, /data-debug-section="breakpoints"/, 'the active tab drives the content panel')
  assert.match(markup, /border-radius:4px 4px 0 0/, 'tabs look like attached page tabs')
  assert.match(markup, /border-bottom:none/, 'the tab sits on the strip border')
  assert.match(markup, /调试/)
  assert.match(markup, /data-debug-head="1"/, 'the debug pane title bar is the debug toolbar')
  assert.doesNotMatch(markup, /收起调试区/, 'the collapse control is gone')
  assert.doesNotMatch(markup, /data-tab-close="debug"/, 'no per-program debug tab strip')
  assert.doesNotMatch(markup, /data-tab-close="log"/, 'no per-program log tab strip')

  const frontend = renderToStaticMarkup(React.createElement(client.__test.ProgramWorkbench, {
    scope: { sessionId: 's1', cwd: '/w' },
    visible: false,
    tab: { meta: { programId: 'frontend:ui#dev', logPath: '/w/logs/ui.log', name: 'ui', kind: 'frontend' } },
  }))
  // The top bar carries the WORKSPACE path (one IDE tab for the whole workspace),
  // not one program's name — and a frontend debug tab has no debug controls.
  assert.match(frontend, /data-workbench-path="1"/)
  assert.doesNotMatch(frontend, /非 Java 程序/, 'the top bar no longer names a program kind')
  assert.doesNotMatch(frontend, /data-action="debug-start"/)
})

test('a mouse wheel over a tab strip scrolls it sideways, not the page', () => {
  // The strip must overflow horizontally; otherwise the default wheels through.
  assert.equal(T.tabStripWheelDelta({ deltaY: 120, deltaX: 0 }, 640, 300), 120)
  assert.equal(T.tabStripWheelDelta({ deltaY: -120, deltaX: 0 }, 640, 300), -120)
  assert.equal(T.tabStripWheelDelta({ deltaY: 120, deltaX: 0 }, 300, 300), 0, 'all tabs fit')
  assert.equal(T.tabStripWheelDelta({ deltaY: 120, deltaX: 0 }, 200, 300), 0)
  // A horizontal trackpad gesture belongs to the browser.
  assert.equal(T.tabStripWheelDelta({ deltaX: 80, deltaY: 0 }, 640, 300), 0)
  assert.equal(T.tabStripWheelDelta({ deltaX: 80, deltaY: 10 }, 640, 300), 0)
  // Non-pixel deltaModes are normalised so one notch still moves a readable amount.
  assert.equal(T.tabStripWheelDelta({ deltaY: 3, deltaMode: 1 }, 640, 300), 48)
  assert.equal(T.tabStripWheelDelta({ deltaY: 1, deltaMode: 2 }, 640, 300), 300)
  assert.equal(T.tabStripWheelDelta(undefined, 640, 300), 0)
  assert.equal(T.tabStripWheelDelta(null, 640, 300), 0)
})

test('tab strips take a NON-passive wheel listener (React onWheel is passive)', () => {
  const listeners = []
  const node = {
    scrollWidth: 640, clientWidth: 300, scrollLeft: 0,
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }) },
    removeEventListener(type, fn) { listeners.push({ type: 'remove', fn }) },
  }
  const detach = T.attachTabStripWheel(node)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, 'wheel')
  assert.deepEqual(listeners[0].options, { passive: false }, 'preventDefault works only when non-passive')

  // The listener scrolls the strip sideways and swallows the page scroll.
  let prevented = 0
  listeners[0].fn({ currentTarget: node, deltaY: 120, deltaX: 0, preventDefault() { prevented += 1 } })
  assert.equal(node.scrollLeft, 120)
  assert.equal(prevented, 1)

  // A strip whose tabs all fit keeps the default (no preventDefault needed).
  let preventedFitting = 0
  listeners[0].fn({ currentTarget: { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }, deltaY: 120, deltaX: 0, preventDefault() { preventedFitting += 1 } })
  assert.equal(preventedFitting, 0)

  detach()
  assert.equal(listeners[1].type, 'remove')
  assert.equal(listeners[1].fn, listeners[0].fn)
})

test('the source tab bar scrolls its inner strip from anywhere on the row', () => {
  const strip = { scrollWidth: 900, clientWidth: 400, scrollLeft: 0 }
  const bar = { scrollWidth: 400, clientWidth: 400, querySelector: (selector) => (selector === '[data-tab-strip]' ? strip : null) }
  assert.equal(T.tabStripOf(bar), strip, 'the bar resolves its inner scrolling strip')
  assert.equal(T.tabStripOf(strip), strip, 'an overflowing node is its own strip')
  assert.equal(T.tabStripOf(null), null)
  assert.equal(T.tabStripOf(undefined), null)

  // Wheel over the BAR (e.g. over a ◀ ▶ paging button) still moves the tabs.
  const listeners = []
  const attachNode = {
    scrollWidth: 400, clientWidth: 400, querySelector: bar.querySelector,
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }) },
    removeEventListener() {},
  }
  const detach = T.attachTabStripWheel(attachNode)
  assert.deepEqual(listeners[0].options, { passive: false })
  let prevented = 0
  listeners[0].fn({ currentTarget: attachNode, deltaY: 100, deltaX: 0, preventDefault() { prevented += 1 } })
  assert.equal(strip.scrollLeft, 100)
  assert.equal(prevented, 1)
  detach()
})

test('the top-bar controls share one 20px row height', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({ onConfig: { open() {}, generate() {}, exists: true } })
  const head = headOf(markup)
  const tags = (head.match(/<button[^>]*>/g) || []).filter((tag) => /data-action="/.test(tag))
  assert.ok(tags.length >= 5, 'the toolbar carries the A-/A+, theme and config/reset buttons')
  for (const tag of tags) {
    const action = /data-action="([^"]+)"/.exec(tag)[1]
    assert.match(tag, /height:20px/, `${action} must sit on the shared 20px row`)
    assert.match(tag, /min-height:20px/, `${action} must pin the minimum too`)
    assert.match(tag, /align-items:center/, `${action} must centre its glyph vertically`)
  }
})

test('the debug toolbar icons are inline SVG, not emoji', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const start = renderToStaticMarkup(T.ideBadgeIcon('bug', 'play', 14))
  assert.match(start, /data-icon="bug\+play"/, 'bug + play badge')
  assert.match(start, /<svg/, 'inline svg')
  const redebug = renderToStaticMarkup(T.ideBadgeIcon('bug', 'rotate', 14))
  assert.match(redebug, /data-icon="bug\+rotate"/)
  const step = renderToStaticMarkup(T.ideIcon('stepOver', 14))
  assert.match(step, /data-icon="stepOver"/)
  const all = ['bug', 'bugOff', 'play', 'playCircle', 'pauseCircle', 'rotate', 'arrowsRotate', 'stop', 'stepOver', 'stepInto', 'stepOut']
    .map((name) => renderToStaticMarkup(T.ideIcon(name, 12)))
  for (const markup of all) assert.match(markup, /<svg/, 'every icon renders')
})

test('log search finds every occurrence per line, case-insensitively', () => {
  const lines = ['INFO started', 'ERROR boom ERROR again', 'ok']
  assert.deepEqual(T.findLogMatches(lines, 'error'), [
    { line: 1, from: 0, to: 5 },
    { line: 1, from: 11, to: 16 },
  ])
  assert.deepEqual(T.findLogMatches(lines, 'ERROR'), [{ line: 1, from: 0, to: 5 }, { line: 1, from: 11, to: 16 }])
  assert.deepEqual(T.findLogMatches(lines, ''), [])
  assert.deepEqual(T.findLogMatches(lines, 'nope'), [])
  assert.deepEqual(T.findLogMatches([], 'x'), [])
  // non-overlapping scan: "aaa" searched as "aa" matches once at 0 (then 2 is past end)
  assert.deepEqual(T.findLogMatches(['aaaa'], 'aa'), [{ line: 0, from: 0, to: 2 }, { line: 0, from: 2, to: 4 }])
  assert.deepEqual(T.findLogMatches(['中文中文'], '中文'), [{ line: 0, from: 0, to: 2 }, { line: 0, from: 2, to: 4 }])
})

test('only DSH\'s own chords are swallowed inside the IDE', () => {
  // Every chord taken from DSH's web catalog is blocked.
  const dsh = [
    ['/'], ['n'], ['k'], ['o'],
  ]
  for (const [key] of dsh) assert.equal(T.shouldBlockHostChord({ ctrlKey: true, key }, false), true, `Ctrl+${key}`)
  for (const key of ['o', 'a', 'b']) assert.equal(T.shouldBlockHostChord({ ctrlKey: true, shiftKey: true, key }, false), true, `Ctrl+Shift+${key}`)
  for (const key of ['f', 'g', 'b', 'p', 't', ',' ]) assert.equal(T.shouldBlockHostChord({ ctrlKey: true, altKey: true, key }, false), true, `Ctrl+Alt+${key}`)
  assert.equal(T.shouldBlockHostChord({ ctrlKey: true, key: '`' }, false), true, 'Ctrl+` terminal')
  // Browser and native shortcuts are NOT the host's, so they pass.
  for (const key of ['c', 'v', 'x', 'a', 'z', 'y', 's', 'f', 'w', 'b', 'e', 'i', 'j', 'l', 'u', 'p']) {
    assert.equal(T.shouldBlockHostChord({ ctrlKey: true, key }, false), false, `Ctrl+${key} is native/IDE`)
  }
  assert.equal(T.shouldBlockHostChord({ ctrlKey: true, key: 'F5' }, false), false, 'Ctrl+F5 reloads the page')
  assert.equal(T.shouldBlockHostChord({ ctrlKey: true, shiftKey: true, key: 'R' }, false), false, 'Ctrl+Shift+R hard reload')
  assert.equal(T.shouldBlockHostChord({ ctrlKey: true, shiftKey: true, key: 'i' }, false), false, 'devtools')
  for (const key of ['F1', 'F2', 'F5', 'F9', 'F11', 'F12']) {
    assert.equal(T.shouldBlockHostChord({ key }, false), false, `${key} belongs to the browser`)
  }
  assert.equal(T.shouldBlockHostChord({ key: 'F3' }, false), false, 'IDE find alias')
  assert.equal(T.shouldBlockHostChord({ ctrlKey: true, key: 'r' }, false), false, 'Ctrl+R is the panel find chord')
  assert.equal(T.shouldBlockHostChord(undefined, false), false)
})

test('both reload forms are swallowed; Ctrl+Shift+R is the find chord too', () => {
  assert.equal(T.isBrowserReloadChord({ ctrlKey: true, key: 'r' }), true)
  assert.equal(T.isBrowserReloadChord({ metaKey: true, key: 'R' }), true)
  assert.equal(T.isBrowserReloadChord({ ctrlKey: true, shiftKey: true, key: 'R' }), true, 'the browser hard reload is suppressed as well')
  assert.equal(T.isBrowserReloadChord({ ctrlKey: true, key: 'f5' }), false)
  assert.equal(T.isBrowserReloadChord({ key: 'F5' }), false)
  assert.equal(T.isBrowserReloadChord({ ctrlKey: true, altKey: true, key: 'r' }), false)
  assert.equal(T.isBrowserReloadChord(undefined), false)
})

test('the shielded set is exactly DSH\'s catalog', () => {
  assert.ok(T.DSH_CHORDS.has('ctrl+n'))
  assert.ok(T.DSH_CHORDS.has('ctrl+alt+f'), 'fork session')
  assert.ok(T.DSH_CHORDS.has('ctrl+shift+a'), 'archive session')
  assert.ok(T.DSH_CHORDS.has('ctrl+/'), 'shortcut catalog')
  assert.equal(T.DSH_CHORDS.has('ctrl+f5'), false)
  assert.equal(T.DSH_CHORDS.has('f5'), false)
  assert.equal(T.chordOf({ ctrlKey: true, shiftKey: true, key: 'A' }), 'ctrl+shift+a')
  assert.equal(T.chordOf({ metaKey: true, key: 'n' }), 'ctrl+n')
  assert.equal(T.chordOf({ ctrlKey: true, altKey: true, key: ',' }), 'ctrl+alt+,')
  assert.equal(T.chordOf({ key: 'F5' }), '', 'no modifier: not a chord')
})

test('Ctrl+R focuses the workspace search (and both browser reloads are suppressed)', () => {
  assert.equal(T.GLOBAL_FIND_KEY, 'r')
  assert.equal(T.GLOBAL_FIND_LABEL, 'Ctrl+R / F3')
  assert.equal(T.isGlobalFindChord({ ctrlKey: true, key: 'r' }), true)
  assert.equal(T.isGlobalFindChord({ metaKey: true, key: 'R' }), true)
  assert.equal(T.isGlobalFindChord({ key: 'F3' }), true)
  // Ctrl+Shift+R (the browser's HARD reload) is the same chord: it must land in the
  // search box instead of throwing the whole IDE away.
  assert.equal(T.isGlobalFindChord({ ctrlKey: true, shiftKey: true, key: 'R' }), true)
  assert.equal(T.isGlobalFindChord({ ctrlKey: true, altKey: true, key: 'f' }), false, 'Ctrl+Alt+F is DSH fork')
  assert.equal(T.isGlobalFindChord({ ctrlKey: true, key: 'f' }), false, 'Ctrl+F belongs to editors')
  assert.equal(T.isGlobalFindChord(undefined), false)
})

test('Ctrl+F goes to the workspace search unless the editor owns it', () => {
  assert.equal(T.globalFindShouldFocusSearch({ tagName: 'DIV' }), true)
  assert.equal(T.globalFindShouldFocusSearch({}), true, 'focus lost on the panel still works')
  assert.equal(T.globalFindShouldFocusSearch({ tagName: 'INPUT' }), false, 'the search box keeps its own editing')
  assert.equal(T.globalFindShouldFocusSearch({ tagName: 'textarea' }), false, 'built-in editor')
  assert.equal(T.globalFindShouldFocusSearch({ tagName: 'DIV', isContentEditable: true }), false, 'CodeMirror')
  assert.equal(T.globalFindShouldFocusSearch({ tagName: 'DIV', defaultPrevented: true }), false, 'editor already handled it')
})

test('the help panel data covers tree, editor and debug shortcuts', () => {
  const sections = T.helpSections()
  assert.deepEqual(sections.map((section) => section.title), ['通用', '文件树', '编辑器', '调试（仅 Java）', '使用说明'])
  for (const section of sections) {
    assert.ok(section.rows.length > 0, `${section.title} has rows`)
    for (const row of section.rows) {
      assert.equal(typeof row.keys, 'string')
      assert.ok(row.keys.length > 0)
      assert.ok(row.desc.length > 0)
    }
  }
  const treeKeys = sections.find((section) => section.title === '文件树').rows.map((row) => row.keys).join(' ')
  assert.match(treeKeys, /Ctrl\+Z/, 'tree undo is documented')
  const editorKeys = sections.find((section) => section.title === '编辑器').rows.map((row) => row.keys).join(' ')
  assert.match(editorKeys, /Ctrl\+Shift\+K/)
  assert.match(editorKeys, /Alt\+\u2191/)
})

test('the workbench renders the bottom-right help button', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  assert.match(markup, /data-action="help"/, 'the ? button exists')
})

test('the tree title bar carries the refresh button and the .gitignore eye', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  assert.match(markup, /data-action="tree-refresh"/, '⟳ reloads the loaded tree levels')
  assert.match(markup, /data-action="reveal-active"/, 'the locate button stays')
  assert.match(markup, /data-action="tree-filter"/, 'the .gitignore toggle sits left of maximize')
  assert.match(markup, /data-filter-state="git"/, 'default state is "filtered"')
  const filterAt = markup.indexOf('data-action="tree-filter"')
  const filterMarkup = markup.slice(filterAt, filterAt + 600)
  assert.match(filterMarkup, /data-icon="eye"/, 'an eye (not a funnel/triangle) reads as visibility')
})

test('the tree .gitignore eye fetches unfiltered listings, then re-reads the tree', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var TREE_FILTER_ALL = false/, 'filtering is the default state')
  assert.match(source, /if \(TREE_FILTER_ALL\) url\.searchParams\.set\('filter', 'all'\)/, 'the toggle reaches the host')
  assert.match(source, /\(TREE_FILTER_ALL \? '\\u0000all' : ''\)/, 'the cache key folds in the mode')
  assert.match(source, /function toggleTreeFilter\(\) \{/)
  assert.match(source, /setTreeRefreshTick\(function \(value\) \{ return value \+ 1 \}\)/, 'a flip reloads root + expanded folders')
  assert.match(source, /data-filter-state': treeShowAll === true \? 'all' : 'git'/)
  assert.match(source, /ideIcon\(treeShowAll === true \? 'eyeOff' : 'eye', 14\)/, 'eye-off = ignored files shown too')
  assert.match(source, /disabled: treeGit !== true/, 'no git → nothing to filter')
  assert.match(source, /onTreeMeta: function \(meta\) \{ setTreeGit\(meta\.git === true\) \}/, 'the listing tells the bar whether git exists')
  assert.match(source, /function reportTreeMeta\(listing\)/)
  // The old funnel glyph is gone: it read as a stray triangle in a 20px row.
  assert.doesNotMatch(source, /viewBox: '0 0 16 16', stroke: true,\n\s+inner: '<path d="M2 3h12l-4\.6 5\.4/)
})

test('there is no workbench top bar: the tree header is the path, the source header is the toolbar', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({ onConfig: { open() {}, generate() {}, exists: true } })
  assert.doesNotMatch(markup, /data-workbench-head="1"/, 'the top bar is gone')

  // tree header: the workspace title IS the path, ellipsised when the column is narrow
  const treeHead = markup.slice(markup.indexOf('data-ide-pane="tree"'), markup.indexOf('data-ide-tree="1"'))
  const pathTag = (treeHead.match(/<span[^>]*data-workbench-path="1"[^>]*>/) || [''])[0]
  assert.match(treeHead, /data-workbench-path="1">\/w</, 'the tree header shows the workspace path')
  assert.match(pathTag, /text-overflow:ellipsis/, 'the path ellipsises instead of overflowing')
  assert.match(pathTag, /flex:1 1 auto/, 'the path takes the header row it has')

  // source header: search grows, action group keeps its own width
  const head = headOf(markup)
  const searchTag = (head.match(/<input[^>]*data-action="tree-search"[^>]*>/) || [''])[0]
  assert.match(searchTag, /flex:1 1 auto/, 'the search box must grow')
  const actionsTag = (head.match(/<span[^>]*data-head-actions="1"[^>]*>/) || [''])[0]
  assert.match(actionsTag, /flex:0 0 auto/, 'the action group keeps its own width')
  assert.doesNotMatch(head, /style="flex:1"/, 'no spacer spans left in the toolbar row')
})

test('the console debug button is orange and the toolbar search renders a dropdown', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderWorkbench({
    programs: [
      { id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', running: { alive: false } },
    ],
  })
  const debugTag = ((markup.match(/<button[^>]*>/g) || []).filter((tag) => tag.includes('data-action="console-debug"'))[0]) || ''
  assert.match(debugTag, /color:#d29922/, 'the debug button must be orange')
  assert.match(debugTag, /border:1px solid color-mix\(in srgb, #d29922/, 'the orange border belongs with it')

  // The search box owns a dropdown container anchored under it; it renders
  // nothing until there is a result.
  assert.match(markup, /data-search-box="1"/, 'the search input sits in a relative box')
  assert.doesNotMatch(markup, /data-search-results="1"/, 'no dropdown before a search runs')

  // The dropdown itself: files vs directories, and its own picker.
  const picked = []
  const hits = renderToStaticMarkup(React.createElement(T.SearchResults, {
    hits: { matches: ['/w/a.java', '/w/src'], dirs: { '/w/src': true } },
    busy: false,
    onPick: (path, isDir) => { picked.push([path, isDir]) },
  }))
  assert.match(hits, /data-search-results="1"/)
  assert.match(hits, /匹配 2 个/)
  assert.match(hits, /title="\/w\/a\.java"[^>]*data-search-hit="file"/)
  assert.match(hits, /title="\/w\/src"[^>]*data-search-hit="dir"/)
  assert.match(renderToStaticMarkup(React.createElement(T.SearchResults, { hits: { matches: [], dirs: {} }, busy: true })), /检索中…/)
  assert.equal(renderToStaticMarkup(React.createElement(T.SearchResults, { hits: null })), '')
  assert.deepEqual(picked, [], 'rendering must not fire a pick')
})

test('the breakpoint list is global: one program\'s poll never drops another program\'s dots', () => {
  T.__setGlobalBreakpoints([])
  const first = T.mergeGlobalBreakpoints({ logPath: '/w/a.log', breakpoints: [{ requestId: 7, className: 'a.B', line: 10 }] })
  assert.deepEqual(first, [{ requestId: 7, className: 'a.B', line: 10, logPath: '/w/a.log' }], 'host rows carry their program')
  const both = T.mergeGlobalBreakpoints({ logPath: '/w/b.log', breakpoints: [{ requestId: 8, className: 'b.C', line: 2 }] })
  assert.deepEqual(both.map((bp) => `${bp.logPath}|${bp.className}:${bp.line}`), ['/w/a.log|a.B:10', '/w/b.log|b.C:2'], 'a poll only replaces its own slice')
  // The program's own snapshot is the truth for that program: entries it no longer
  // reports must go (this is what used to leave "historical" dots around).
  const pruned = T.mergeGlobalBreakpoints({ logPath: '/w/a.log', breakpoints: [] })
  assert.deepEqual(pruned.map((bp) => bp.className), ['b.C'], 'only the polled program is pruned')
  // An optimistic local dot survives for a little while, then it is pruned too.
  T.__setGlobalBreakpoints([{ requestId: 'pending', className: 'c.D', line: 4, pending: true, logPath: '/w/c.log', optimistic: true, optimisticAt: Date.now() }])
  assert.equal(T.mergeGlobalBreakpoints({ logPath: '/w/c.log', breakpoints: [] }).length, 1, 'a fresh optimistic dot survives its snapshot')
  T.__setGlobalBreakpoints([{ requestId: 'pending', className: 'c.E', line: 4, pending: true, logPath: '/w/c.log', optimistic: true, optimisticAt: Date.now() - 60000 }])
  assert.equal(T.mergeGlobalBreakpoints({ logPath: '/w/c.log', breakpoints: [] }).length, 0, 'an expired optimistic dot is pruned')
  // Once the host reports the class+line, the optimistic dot is replaced by it.
  T.__setGlobalBreakpoints([{ requestId: 'pending', className: 'c.F', line: 6, pending: true, logPath: '/w/c.log', optimistic: true, optimisticAt: Date.now() }])
  const confirmed = T.mergeGlobalBreakpoints({ logPath: '/w/c.log', breakpoints: [{ requestId: 11, className: 'c.F', line: 6 }] })
  assert.deepEqual(confirmed, [{ requestId: 11, className: 'c.F', line: 6, logPath: '/w/c.log' }])
  T.__setGlobalBreakpoints([])
})

test('the debug pane names Java locations by class, never by file path', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /function breakpointLabel\(bp\) \{\n        return bp === null \|\| bp === undefined \|\| bp\.className === undefined \? '\?' : String\(bp\.className\)/)
  assert.match(source, /\}, method \+ '@' \+ line\)/, 'stack rows show method@line')
  assert.match(source, /var title = \(className === '' \? '' : className \+ '\.'\) \+ method \+ ':' \+ line/, 'stack titles are class.method:line')
  assert.doesNotMatch(source, /annotateBreakpointPaths/, 'breakpoint rows are not path-annotated')
  assert.doesNotMatch(source, /annotateFramePaths/, 'stack rows are not path-annotated')
})

test('panel paths are relative to the workspace root, absolute only outside it', () => {
  assert.equal(T.displayWorkspacePath('/w/src/a.java', '/w'), 'src/a.java')
  assert.equal(T.displayWorkspacePath('/w/src/a.java', '/w/'), 'src/a.java', 'a trailing separator is ignored')
  assert.equal(T.displayWorkspacePath('/elsewhere/a.java', '/w'), '/elsewhere/a.java', 'outside stays absolute')
  assert.equal(T.displayWorkspacePath('/w', '/w'), '/w')
  assert.equal(T.displayWorkspacePath('', '/w'), '')
  assert.equal(T.displayWorkspacePath('C:\\w\\a.java', 'C:\\w'), 'a.java')
})

test('search results show workspace-relative text with the absolute path as title', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderToStaticMarkup(React.createElement(T.SearchResults, {
    hits: { matches: ['/w/src/a.java', '/outside/b.java'], dirs: {} },
    busy: false,
    cwd: '/w',
    onPick: () => {},
  }))
  assert.match(markup, /title="\/w\/src\/a\.java"/)
  assert.match(markup, />src\/a\.java</, 'the visible text is relative')
  assert.match(markup, /title="\/outside\/b\.java"/)
  assert.match(markup, />\/outside\/b\.java</, 'outside the workspace the text stays absolute')
})

test('Ctrl+R turns a single-line editor selection into the search query', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /function selectedEditorText\(\)/)
  assert.match(source, /if \(text === '' \|\| text\.indexOf\('\\n'\) !== -1 \|\| text\.length > GLOBAL_FIND_SELECTION_MAX\) return ''/, 'multiline / oversized selections are ignored')
  assert.match(source, /if \(element\.closest\('\.cm-content'\) === null\) return ''/, 'only editor selections count')
  assert.match(source, /var picked = selectedEditorText\(\)[\s\S]{0,400}?setTreeQuery\(picked\)/, 'the pick becomes the query')
  assert.match(source, /h\(SearchResults, \{[\s\S]{0,240}?active: searchActive, onHover: setSearchActive,[\s\S]{0,120}?fontRatio: fontRatio, cwd: cwd,/, 'results know the workspace root and the highlighted row')
})

test('an unfocused editor stops painting its selection', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\[data-workbench="ris-ide"\] \.cm-editor:not\(\.cm-focused\) \.cm-selectionBackground/)
  assert.match(source, /:not\(\.cm-focused\) \.cm-selectionBackground'\s*\n\s*\+ '\{background:transparent !important\}'/)
})

test('the active source tab is scrolled into the strip', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /var tabElsRef = useRef\(\{\}\)/)
  assert.match(source, /'data-tab-file': path/)
  assert.match(source, /var tab = tabElsRef\.current\[openFile\][\s\S]{0,700}?strip\.scrollLeft = Math\.max\(0, strip\.scrollLeft - \(stripBox\.left - tabBox\.left\) - margin\)/, 'a tab left of the viewport scrolls it in')
  assert.match(source, /\}, \[openFile, openFiles\.length\]\)/, 'the active file drives it')
})

test('treeLabel draws folded separators as their own bold spans', () => {
  const plain = T.treeLabel({}, { name: 'a.java', label: 'a.java', compact: false })
  assert.equal(plain, 'a.java', 'normal rows stay one string')
  const folded = T.treeLabel({ foldSeparator: { fontWeight: 700 } }, { compact: true, label: 'cn.com.ris' })
  assert.ok(Array.isArray(folded), 'a folded chain renders parts + separators')
  assert.equal(folded.length, 5, 'two separators + three parts')
  assert.equal(folded[1].type, 'span')
  assert.equal(folded[1].props.children, '.', 'the separator character survives')
  assert.equal(folded[1].props.style.fontWeight, 700)
})

test('fsTree fails loudly on a host without the tree route (no sidebar fallback)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, message: 'unknown route /dsh-ris-ide/tree' }) })
  try {
    await assert.rejects(T.fsTree({ sessionId: 's1', cwd: '/w' }, '/w'), /unknown route/)
  } finally {
    globalThis.fetch = original
  }
})

test('the saved layout (maximised + theme + font + sizes) restores on init, even from a legacy key', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  try {
    // A legacy per-program blob: the panel used to key the layout by program id.
    const legacy = JSON.stringify({
      ui: { maximized: 'editor', section: 'threads' },
      theme: 'light',
      font: 15,
      sizes: { left: 420, leftBottom: 300, rightBottom: 220, debugWidth: 320 },
      files: [],
      file: undefined,
    })
    const store = new Map([['dsh-ris-ide:ui:spring:ris/ris-model#a.B', legacy]])
    globalThis.localStorage = {
      get length() { return store.size },
      key: (index) => Array.from(store.keys())[index],
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value) },
    }
    const markup = renderWorkbench({ tab: { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace' } })
    const root = workbenchRootTagOf(markup)
    assert.match(root, /font-size:15px/, 'the persisted font size is applied at init')
    assert.match(root, /data-theme="page"/, 'the IDE itself no longer stores a colour scheme')
    assert.doesNotMatch(markup, /data-ide-pane="tree"/, 'the persisted maximised pane is applied at init')
    assert.match(markup, /data-ide-pane="editor"/)
  } finally {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
  }
})

test('readSavedUi prefers the exact key, falls back to a legacy one, and survives junk', () => {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  try {
    const store = new Map([
      ['dsh-ris-ide:ui:workspace', JSON.stringify({ ui: { maximized: null }, font: 13 })],
      ['dsh-ris-ide:ui:spring:x#y', JSON.stringify({ ui: { maximized: 'tree' }, font: 18 })],
    ])
    globalThis.localStorage = {
      get length() { return store.size },
      key: (index) => Array.from(store.keys())[index],
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: () => {},
    }
    assert.equal(T.readSavedUi('dsh-ris-ide:ui:workspace').font, 13, 'the exact key wins')

    const withoutExact = new Map(Array.from(store.entries()).filter(([key]) => key !== 'dsh-ris-ide:ui:workspace'))
    globalThis.localStorage = {
      get length() { return withoutExact.size },
      key: (index) => Array.from(withoutExact.keys())[index],
      getItem: (key) => (withoutExact.has(key) ? withoutExact.get(key) : null),
      setItem: () => {},
    }
    assert.equal(T.readSavedUi('dsh-ris-ide:ui:workspace').font, 18, 'a legacy per-program key is adopted')

    withoutExact.set('dsh-ris-ide:ui:broken', '{not json')
    assert.ok(T.readSavedUi('dsh-ris-ide:ui:nothing') !== null, 'junk does not throw')
  } finally {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
  }
})

test('childEntryFor follows the RENDERED rows, so a folded chain still locates', () => {
  const levels = {
    '/w': [
      { name: 'ris', label: 'ris', path: '/w/ris', isDir: true },
      { name: 'README.md', label: 'README.md', path: '/w/README.md', isDir: false },
    ],
    '/w/ris': [
      // The whole src/main/java/cn/com/ris/cloud/model chain is ONE row.
      { name: 'model', label: 'src.main.java.cn.com.ris.cloud.model', path: '/w/ris/src/main/java/cn/com/ris/cloud/model', isDir: true, compact: true },
      { name: 'README.md', label: 'README.md', path: '/w/ris/README.md', isDir: false },
    ],
    '/w/ris/src/main/java/cn/com/ris/cloud/model': [
      { name: 'Foo.java', label: 'Foo.java', path: '/w/ris/src/main/java/cn/com/ris/cloud/model/Foo.java', isDir: false },
    ],
  }
  const file = '/w/ris/src/main/java/cn/com/ris/cloud/model/Foo.java'
  const chain = []
  let current = '/w'
  for (let guard = 0; guard < 16; guard += 1) {
    const next = T.childEntryFor(levels[current] || [], file)
    if (next === undefined) break
    chain.push(next.path)
    current = next.path
  }
  assert.deepEqual(chain, ['/w/ris', '/w/ris/src/main/java/cn/com/ris/cloud/model'],
    'the folded row is the one that gets expanded (no raw ancestors)')
  assert.equal(current, '/w/ris/src/main/java/cn/com/ris/cloud/model')
  // No match, a file target, and junk entries are all safe.
  assert.equal(T.childEntryFor(levels['/w'], '/w/other/x.txt'), undefined)
  assert.equal(T.childEntryFor([{ path: file, isDir: false }], file), undefined)
  assert.equal(T.childEntryFor(undefined, file), undefined)
  assert.equal(T.childEntryFor([null, 'x', { path: '/w/ris', isDir: false }], file), undefined)
})

test('the locate walk against a real single-child package chain reaches the file parent', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ris-ide-locate-'))
  try {
    await run('git', ['init', '-q'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'target/\n')
    const pkg = join(root, 'src', 'main', 'java', 'cn', 'com', 'ris', 'cloud', 'model')
    await mkdir(pkg, { recursive: true })
    const file = join(pkg, 'Foo.java')
    await writeFile(file, 'class Foo {}\n')

    const levels = {}
    let current = root
    const chain = []
    for (let guard = 0; guard < 16; guard += 1) {
      levels[current] = (await hostTest.listIdeTree(current, root)).entries
      const next = T.childEntryFor(levels[current], file)
      if (next === undefined) break
      chain.push(next.path)
      current = next.path
    }
    assert.equal(current, pkg, 'the walk lands on the folded package dir')
    const rows = levels[current].map((entry) => entry.label)
    assert.deepEqual(rows, ['Foo.java'], 'the file row is rendered there')
    // Outside java every folder keeps its own row; only the package tail is folded.
    assert.deepEqual(chain.slice(0, 3), [
      join(root, 'src'),
      join(root, 'src', 'main'),
      join(root, 'src', 'main', 'java'),
    ], 'the walk descends the real src/main/java folders')
    assert.equal(chain[chain.length - 1], pkg, 'the last row is the FOLDED package node')
    assert.ok(levels[join(root, 'src', 'main', 'java')].some((entry) => entry.compact === true),
      'below java the package chain is a single compact row')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sourceRelativeSuffix maps debugger class names to source paths', () => {
  assert.equal(T.sourceRelativeSuffix('cn.com.ris.cloud.model.ModelHelper'), 'cn/com/ris/cloud/model/ModelHelper.java')
  assert.equal(T.sourceRelativeSuffix('cn.com.ris.Foo$Bar'), 'cn/com/ris/Foo.java', 'inner classes fold to the outer file')
  assert.equal(T.sourceRelativeSuffix('  a.B  '), 'a/B.java', 'whitespace is trimmed')
  assert.equal(T.sourceRelativeSuffix(''), undefined)
  assert.equal(T.sourceRelativeSuffix(undefined), undefined)
  assert.equal(T.sourceRelativeSuffix(null), undefined)
})

test('treeIndent steps 11px per depth from a 6px base', () => {
  assert.equal(T.treeIndent(0), 6)
  assert.equal(T.treeIndent(1), 17)
  assert.equal(T.treeIndent(3), 39)
  assert.equal(T.treeIndent(-2), 6, 'a bad depth never pulls rows out of the pane')
})

test('parseGutterLine reads a line number and rejects spacers', () => {
  assert.equal(T.parseGutterLine('42'), 42)
  assert.equal(T.parseGutterLine(' 7\n'), 7)
  assert.equal(T.parseGutterLine(''), undefined)
  assert.equal(T.parseGutterLine('  '), undefined)
  assert.equal(T.parseGutterLine('·'), undefined, 'folded pseudo-lines are not clickable rows')
  assert.equal(T.parseGutterLine(undefined), undefined)
})

test('formatMemory and heapHint surface memory pressure', () => {
  assert.equal(T.formatMemory(0), '')
  assert.equal(T.formatMemory(undefined), '')
  assert.equal(T.formatMemory(650 * 1024 * 1024), '650 MB')
  assert.equal(T.formatMemory(1.9 * 1024 * 1024 * 1024), '1.9 GB')
  assert.equal(T.heapHint({ jvmArgs: ['-Xmx512m'] }), '', 'configured bounds need no hint')
  assert.match(T.heapHint({}), /defaults\.jvmArgs/)
  assert.match(T.heapHint(undefined), /defaults\.jvmArgs/)
})

test('Eclipse debug keys: F5 into, F6 over, F7 out, F8 resume', () => {
  const suspended = { attached: true, suspended: true }
  const running = { attached: true, suspended: false }
  assert.deepEqual(T.debugShortcut('F5', suspended), { kind: 'run', mode: 'step-into' })
  assert.deepEqual(T.debugShortcut('F6', suspended), { kind: 'run', mode: 'step-over' })
  assert.deepEqual(T.debugShortcut('F7', suspended), { kind: 'run', mode: 'step-out' })
  assert.deepEqual(T.debugShortcut('F8', suspended), { kind: 'run', mode: 'resume' })
  assert.deepEqual(T.debugShortcut('F8', running), { kind: 'run', mode: 'resume' }, 'resume works while running too (no-op on the host)')
  assert.deepEqual(T.debugShortcut('F5', running), { kind: 'swallow' }, 'F5 is swallowed while a session runs (never reloads the page)')
  assert.deepEqual(T.debugShortcut('F6', running), { kind: 'swallow' })
  assert.deepEqual(T.debugShortcut('F7', running), { kind: 'swallow' })
  assert.equal(T.debugShortcut('F5', { attached: false }), undefined, 'nothing is claimed without a session')
  assert.equal(T.debugShortcut('F5', undefined), undefined)
  assert.equal(T.debugShortcut('Enter', suspended), undefined, 'unrelated keys pass through')
})

test('a located tree row is scrolled into the tree list, not the page', () => {
  // Row below the fold: scroll down by exactly the overflow.
  assert.equal(T.revealScrollTop(500, 520, 100, 400, 0), 120)
  // Row above the fold: scroll up.
  assert.equal(T.revealScrollTop(50, 70, 100, 400, 300), 250)
  // Already visible: untouched (and never negative).
  assert.equal(T.revealScrollTop(150, 170, 100, 400, 300), 300)
  assert.equal(T.revealScrollTop(0, 5, 100, 400, 0), 0)
})


test('the console highlights the row of the project being shown', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const tab = { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace', meta: { logPath: '/w/logs/a.log', name: 'a-biz', kind: 'spring' } }
  const markup = renderWorkbench({ tab, programs: [
    { id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', running: { alive: true } },
    { id: 'spring:b#B', name: 'b-biz', kind: 'spring', logPath: '/w/logs/b.log', running: { alive: true } },
  ] })
  assert.match(markup, /data-console-on="1"/, 'the active project row is marked')
  const selected = markup.slice(markup.indexOf('data-console-on="1"'))
  assert.match(selected.slice(0, 600), /a-biz/, 'the marked row is the selected program')
  assert.equal((markup.match(/data-console-on="1"/g) || []).length, 1, 'exactly one row is highlighted')
})

test('the log pane reads any program that has a log file, running or not', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const tab = { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace', meta: { logPath: '/w/logs/a.log', name: 'a-biz', kind: 'spring' } }
  const programsOf = (alive, hasLog) => ([{ id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', hasLog, running: { alive } }])

  const running = renderWorkbench({ tab, programs: programsOf(true, true) })
  assert.match(running, /data-log-slot="1"/, 'a running program mounts the log viewer')
  assert.match(running, /data-dsh-ris-ide="viewer"/)
  assert.match(running, /data-console-pick="\/w\/logs\/a\.log"/, 'the console row can switch to it')

  // Historical log of a STOPPED program is still readable — no start required.
  const stopped = renderWorkbench({ tab, programs: programsOf(false, true) })
  assert.match(stopped, /data-log-slot="1"/, 'a stopped program with a log file still shows it')
  assert.match(stopped, /data-dsh-ris-ide="viewer"/)

  // Only a program with no log file at all shows the placeholder.
  const noLog = renderWorkbench({ tab, programs: programsOf(false, false) })
  assert.doesNotMatch(noLog, /data-log-slot="1"|data-dsh-ris-ide="viewer"/)
  assert.match(noLog, /还没有日志文件/)
  assert.doesNotMatch(noLog, /data-tab-close="(log|debug)"/, 'no program tab strips remain')
})

test('requestDebugs asks the session list route', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (href) => {
    calls.push(String(href))
    return { ok: true, status: 200, json: async () => ({ ok: true, sessions: [{ logPath: '/w/logs/a.log', attached: true, vmSuspended: true, seq: 3 }] }) }
  }
  try {
    const result = await T.requestDebugs({ sessionId: 's1', cwd: '/w' })
    assert.equal(result.ok, true)
    assert.equal(result.sessions.length, 1)
    const url = new URL(calls[0])
    assert.equal(url.pathname.endsWith('/dsh-ris-ide/debugs'), true, `unexpected url ${calls[0]}`)
    assert.equal(url.searchParams.get('sessionId'), 's1')
  } finally {
    globalThis.fetch = original
  }
})

test('the log pane title bar carries the service state (the body has no bar)', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const tab = { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace', meta: { logPath: '/w/logs/a.log', name: 'a-biz', kind: 'spring' } }
  const program = (running) => ([{ id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', hasLog: true, running }])

  const head = logHeadOf(renderWorkbench({ tab, programs: program({ pid: 445482, alive: true }) }))
  assert.match(head, /data-log-service="running"/)
  assert.match(head, /运行中 \(pid 445482\)/)
  assert.doesNotMatch(head, /省略前/, 'the elided-size note is gone from the bar')
  assert.doesNotMatch(head, /474\.0 KB/, 'the size is gone from the bar')
  assert.doesNotMatch(head, /12 行/, 'the line count is gone from the bar')

  const stopped = logHeadOf(renderWorkbench({ tab, programs: program({ pid: 445482, alive: false }) }))
  assert.match(stopped, /data-log-service="stopped"/)
  assert.match(stopped, /已停止 \(pid 445482\)/)

  // No pidfile at all: "未运行" instead of an empty title bar.
  const none = logHeadOf(renderWorkbench({ tab, programs: program(undefined) }))
  assert.match(none, /data-log-service="none"/)
  assert.match(none, /未运行/)

  // The body itself no longer renders any of the old bar.
  const markup = renderWorkbench({ tab, programs: program({ pid: 445482, alive: true }) })
  const body = markup.slice(markup.indexOf('data-log-slot="1"'))
  assert.doesNotMatch(body, /换行:开|暂停跟随|继续跟随|运行中|已停止/)
  assert.doesNotMatch(body, /data-action="(wrap|font-down|font-up|follow)"/)
})

test('the search toolbar does not clip its results dropdown', () => {
  // Regression: `editorPaneHead` used to be `overflow: hidden`; the dropdown is its
  // absolutely-positioned child, so the rows were in the DOM but invisible.
  for (const ratio of [1, 1.25]) {
    const styles = T.stylesFor(ratio)
    assert.equal(styles.editorPaneHead.overflow, 'visible', 'the header must not clip the dropdown')
    assert.equal(styles.editorPaneHead.position, 'relative')
    assert.ok(Number(styles.editorPaneHead.zIndex) >= 10, 'the header paints above the editor body')
    assert.equal(styles.searchDropdown.position, 'absolute')
    assert.ok(Number(styles.searchDropdown.zIndex) >= 60)
    assert.ok(styles.searchDropdown.maxHeight > 0)
  }
})

test('search replies become dropdown payloads without crashing on `dirs`', () => {
  // The host /search route answers files only: `dirs` is an empty OBJECT. Treating
  // it as an array (`dirs.forEach`) threw and made every filename search look dead.
  const hostReply = T.searchHitPayload({ matches: ['/w/ris/ris-auth/A.java'], dirs: {} }, '/w')
  assert.deepEqual(hostReply.matches, ['/w/ris/ris-auth/A.java'])
  assert.deepEqual(hostReply.dirs, {})

  // No dirs at all (legacy/partial reply) must also be fine.
  const bare = T.searchHitPayload({ matches: ['x/B.java'] }, '/w')
  assert.deepEqual(bare.matches, ['/w/x/B.java'], 'relative legacy paths resolve against cwd')

  // An array of directories (older sidebar shape) still works.
  const legacy = T.searchHitPayload({ matches: [], dirs: ['/w/src'] }, '/w')
  assert.deepEqual(legacy.dirs, { '/w/src': true })

  // Junk in, empty out — never a throw.
  assert.deepEqual(T.searchHitPayload(undefined, '/w'), { matches: [], dirs: {} })
})

test('the search dropdown renders hits, empty state and errors', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const render = (hits) => renderToStaticMarkup(React.createElement(T.SearchResults, { hits, fontRatio: 1 }))
  const withHits = render({ matches: ['/w/ris/ris-auth/A.java'], dirs: {} })
  assert.match(withHits, /data-search-results="1"/)
  assert.match(withHits, /A\.java/)
  assert.match(withHits, /匹配 1 个/)
  assert.match(render({ matches: [], dirs: {} }), /没有匹配的文件/)
  assert.match(render({ error: 'boom' }), /检索失败：boom/)
})

test('the dropdown highlights the exact file-name match, else the first row', () => {
  const hits = { matches: ['/w/x/Alpha.java', '/w/y/ModelHelper.java'], dirs: {} }
  assert.equal(T.searchHitActiveIndex(hits, 'ModelHelper.java'), 1, 'the full name the user typed wins over row 0')
  assert.equal(T.searchHitActiveIndex(hits, 'modelhelper.JAVA'), 1, 'case does not matter')
  assert.equal(T.searchHitActiveIndex(hits, 'Missing.java'), 0, 'no exact name: the first row')
  assert.equal(T.searchHitActiveIndex(hits, ''), 0)
  // A directory whose basename matches is never the "file name" target.
  assert.equal(T.searchHitActiveIndex({ matches: ['/w/src', '/w/z/src'], dirs: { '/w/src': true } }, 'src'), 1, 'a directory is skipped when matching a name')
  assert.equal(T.searchHitActiveIndex({ matches: [], dirs: {} }, 'a'), -1)
  assert.equal(T.searchHitActiveIndex(null, 'a'), -1)
  assert.equal(T.searchHitActiveIndex(undefined, undefined), -1)
})

test('the highlighted search row is marked, tinted and hover-driven', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const markup = renderToStaticMarkup(React.createElement(T.SearchResults, {
    hits: { matches: ['/w/a.java', '/w/b.java'], dirs: {} },
    active: 1,
    fontRatio: 1,
    onPick: () => {},
    onHover: () => {},
  }))
  assert.match(markup, /data-search-hit-path="\/w\/a\.java"[^>]*data-search-hit-active="0"/)
  assert.match(markup, /data-search-hit-path="\/w\/b\.java"[^>]*data-search-hit-active="1"/)
  assert.match(markup, /style="[^"]*background:color-mix\(in srgb, currentColor 18%, transparent\)"[^>]*data-search-hit-active="1"/, 'the active row is tinted')
})

test('the workspace search keeps its caret while the dropdown is walked', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Arrows move the ROW, and preventDefault keeps the caret where it was.
  assert.match(source, /if \(event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'\) \{[\s\S]{0,600}?event\.preventDefault\(\)[\s\S]{0,200}?setSearchActive\(function \(current\)/, 'arrows walk the results')
  assert.match(source, /\(from \+ step \+ count\) % count/, 'the walk wraps around')
  assert.match(source, /if \(event\.key !== 'Enter'\) return[\s\S]{0,1200}?pickSearchHit\(chosen,/, 'Enter picks the highlighted row')
  assert.match(source, /if \(inHistory\) \{\n\s+var row = searchHistoryRows\[index\][\s\S]{0,300}?void openRecentPath\(row\.path\)/, 'Enter opens the highlighted recent file')
  // A click on a row must not blur the box.
  assert.match(source, /'data-search-results': '1',[\s\S]{0,400}?onMouseDown: function \(event\) \{ event\.preventDefault\(\) \}/, 'the dropdown swallows mousedown')
  // The payload arrives with a highlight already computed.
  assert.match(source, /setSearchActive\(searchHitActiveIndex\(searchHits, treeQuery\)\)/)
  assert.match(source, /function searchHitActiveIndex\(hits, query\)/)
})

test('the log pane title bar holds icon buttons (no refresh, no find button)', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const tab = { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace', meta: { logPath: '/w/logs/a.log', name: 'a-biz', kind: 'spring' } }
  const programs = [{ id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', hasLog: true, running: { pid: 42, alive: true } }]
  const head = logHeadOf(renderWorkbench({ tab, programs }))

  assert.doesNotMatch(head, /data-action="refresh"/, 'no manual refresh: the viewer follows the tail on its own')
  assert.doesNotMatch(head, />刷新</)
  // The controls that moved into the title bar, all fixed-width icon buttons
  // (the old in-body text labels are gone).
  for (const action of ['wrap', 'font-down', 'font-up', 'follow']) {
    assert.match(head, new RegExp(`data-action="${action}"`), `missing ${action}`)
  }
  assert.ok((head.match(/width:22px/g) || []).length >= 4, 'every control is a 22px icon button')
  assert.match(head, /data-icon="wrap"/, 'wrap is drawn as an inline SVG icon')
  assert.match(head, /data-icon="follow"/, 'follow is drawn as an inline SVG icon')
  assert.doesNotMatch(head, />换行:开<|>换行:关<|>暂停跟随<|>继续跟随</, 'no text labels left in the title bar')
  // Find stays a Ctrl+F shortcut with its own body bar: no title-bar button.
  assert.doesNotMatch(head, /data-action="log-find"/)

  // No log viewer mounted → no viewer controls at all.
  const empty = logHeadOf(renderWorkbench({}))
  for (const action of ['wrap', 'font-down', 'font-up', 'follow']) {
    assert.equal(empty.includes(`data-action="${action}"`), false, `${action} must not render without a viewer`)
  }
})

test('canOpenLog only allows a running program with a log file', () => {
  assert.equal(T.canOpenLog({ running: { alive: true }, hasLog: true }), true)
  assert.equal(T.canOpenLog({ running: { alive: false } }), false, 'a stopped row has no live log to load')
  assert.equal(T.canOpenLog({ running: null }), false)
  assert.equal(T.canOpenLog({ hasLog: false, running: { alive: true } }), false, 'no log file → nothing to open')
  assert.equal(T.canOpenLog(null), false)
  assert.equal(T.canOpenLog(undefined), false)
})

test('debug polling is fast only while attached', () => {
  assert.equal(T.debugPollDelay(true), 700)
  assert.equal(T.debugPollDelay(false), 5000, 'an idle debug tab backs off to one poll per five seconds')
  assert.equal(T.debugPollDelay(undefined), 5000, 'unknown = not attached')
})

test('the status bar has a 💬 message button at its right, and the log caps at 200', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  const button = markup.indexOf('data-action="messages"')
  const debugState = markup.indexOf('未调试')
  assert.ok(button > -1, 'the message button exists')
  assert.ok(button > debugState, 'it sits at the RIGHT end of the status bar')
  assert.ok(markup.indexOf('双击标题最大化') < button, 'after the shortcut hints')
  assert.ok(!markup.includes('data-message-panel'), 'the log panel starts closed')
})

test('dropMessage removes exactly one entry', () => {
  const list = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }]
  assert.deepEqual(T.dropMessage(list, 2).map((message) => message.id), [1, 3])
  assert.deepEqual(T.dropMessage(list, '2').map((message) => message.id), [1, 3], 'ids compare as strings')
  assert.equal(T.dropMessage(list, 99).length, 3, 'an unknown id is a no-op')
  assert.deepEqual(T.dropMessage(undefined, 1), [])
})

test('formatClock and capMessages keep the message log readable', () => {
  const stamp = new Date(2026, 9, 19, 8, 5, 3).getTime()
  assert.equal(T.formatClock(stamp), '08:05:03', 'zero-padded local clock')
  assert.equal(T.formatClock(undefined), '--:--:--')
  const many = Array.from({ length: 205 }, (_, index) => ({ id: index, text: 'm' + index, at: stamp }))
  const capped = T.capMessages(many)
  assert.equal(capped.length, 200)
  assert.equal(capped[199].id, 204, 'the newest message is kept')
  assert.equal(capped[0].id, 5, 'the oldest ones are dropped')
  assert.deepEqual(T.capMessages(undefined), [])
})

test('floating hints: newest last, capped at five, five-second life', () => {
  assert.equal(T.TOAST_TTL_MS, 5000)
  const list = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, text: 'm' + id }))
  const capped = T.capToasts(list)
  assert.equal(capped.length, 5, 'the stack never grows past five rows')
  assert.deepEqual(capped.map((item) => item.id), [3, 4, 5, 6, 7], 'the OLDEST hints are dropped')
  assert.deepEqual(T.capToasts([{ id: 1 }], 5), [{ id: 1 }], 'short lists pass through')
  assert.deepEqual(T.capToasts([]), [])
  assert.deepEqual(T.capToasts(undefined), [], 'junk is inert')
})

test('every advisory strip carries a ✕ to close it', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const logMarkup = renderToStaticMarkup(React.createElement(T.LogTail, {
    scope: { sessionId: 's1', cwd: '/tmp' },
    path: 'service.log',
    customData: { ok: true, content: 'HEAD\n', mode: 'head', truncated: true },
  }))
  assert.match(logMarkup, /data-notice="log-head"/)
  assert.match(logMarkup, /data-notice-close="log-head"/, 'the head-mode notice is closable')

  const workbench = renderWorkbench({ configNote: '配置已自动生成' })
  assert.match(workbench, /data-notice="config-note"/)
  assert.match(workbench, /data-notice-close="config-note"/, 'the config note is closable')
})

test('driftSignature is stable per drift payload', () => {
  const a = { added: ['x'], missing: ['y'], changed: [] }
  assert.equal(T.driftSignature(a), T.driftSignature({ added: ['x'], missing: ['y'], changed: [] }))
  assert.notEqual(T.driftSignature(a), T.driftSignature({ added: ['x', 'z'], missing: ['y'], changed: [] }))
  assert.equal(T.driftSignature(null), 'none')
  assert.equal(T.driftSignature(undefined), 'none')
})

test('the debug toolbar keeps every control visible, disabled while inapplicable', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  const head = markup.slice(markup.indexOf('data-debug-head="1"'))
  for (const action of ['debug-stop', 'debug-pause', 'debug-resume', 'step-over', 'step-into', 'step-out']) {
    const tag = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(head)
    assert.ok(tag !== null, `missing ${action}: the toolbar must not reshuffle`)
    assert.match(tag[0], /disabled/, `${action} is disabled while there is no suspended session`)
  }
})

test('the tree dialog hints stay short (labels + one-example placeholders)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // One example, no explanatory sentence in the dialogs.
  assert.match(source, /如 Makefile、README/)
  assert.match(source, /如 ModelHelper 或 cloud\.test/)
  assert.match(source, /如 cn\.com\.ris'/)
  assert.match(source, /如 model-new/)
  assert.doesNotMatch(source, /例如/)
  assert.doesNotMatch(source, /按输入保存，不自动加后缀/)
  assert.doesNotMatch(source, /会创建多级目录/)
  assert.doesNotMatch(source, /覆盖会删除目标现有内容/)
  assert.doesNotMatch(source, /目标已存在同名条目/)
})

test('every breakpoint row deletes from the LEFT, pre-set breakpoints included', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // One shared button, rendered before the row text in all three branches.
  assert.match(source, /var removeButton = h\('button', \{[\s\S]{0,240}?'data-bp-remove': '1'/)
  assert.match(source, /removeBreakpoint\(bp\.pending === true \? 'pending' : bp\.requestId, bp\)/, 'a pre-set breakpoint removes by marker')
  assert.match(source, /key: 'bp-pending-'[\s\S]{0,400}?removeButton,\s*h\('span'/, 'pending row: delete button first')
  assert.match(source, /key: 'bp-failed-'[\s\S]{0,900}?h\('button', \{[\s\S]{0,400}?'data-bp-remove': '1'[\s\S]{0,900}?h\('span'/, 'failed row: delete button first')
  assert.match(source, /key: 'bp-' \+ bp\.requestId[\s\S]{0,200}?removeButton,/, 'live row: delete button first')
  assert.doesNotMatch(source, /'除去'/, 'the failed row uses the same wording')
  // Icon-only like the title-bar controls: one fixed 20px square with ×,
  // not a wide text button that eats row width.
  assert.match(source, /width: 20, minWidth: 20, height: 20, padding: '0 0'/, 'the row delete is a 20px square icon button')
  assert.equal(source.split("'data-bp-remove': '1'").length - 1, 2, 'one shared + one failed-row icon button')
  const breakpointRows = source.slice(source.indexOf('var rows = []'), source.indexOf("} else if (ui.section === 'threads')"))
  assert.equal(breakpointRows.split("}, '×')").length - 1, 2, 'both buttons render the × glyph, no text label')
})

test('the breakpoint clear-all is a title-bar icon, not an in-body text button', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  const head = markup.indexOf('data-debug-head="1"')
  assert.ok(head > -1, 'the debug pane has a title bar')
  const refresh = markup.indexOf('data-action="debug-refresh"', head)
  const clear = markup.indexOf('data-action="breakpoints-clear"', head)
  assert.ok(clear > refresh, 'the clear icon sits in the same title bar, after refresh')
  assert.ok(!markup.includes('data-bp-toolbar'), 'the in-body 全部清除 bar is gone')
  assert.ok(!markup.includes('全部清除'), 'no text button left')
})

/** SSR-render the IDE workbench with the props a real program tab passes. */
function renderWorkbench(extra) {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  return renderToStaticMarkup(React.createElement(T.ProgramWorkbench, Object.assign({
    scope: { sessionId: 's1', cwd: '/w' },
    visible: false,
    tab: {
      id: T.PROGRAM_TAB_ID,
      type: T.PROGRAM_TAB_ID,
      title: 'ris-model-biz',
      meta: { programId: 'spring:x#a.B', logPath: '/w/logs/ris-model-biz.log', name: 'ris-model-biz', kind: 'spring' },
    },
    programs: [],
  }, extra)))
}

/** Just the top bar: from its marker up to the IDE grid that follows it. */
/** The source pane's header — the IDE toolbar now (there is no workbench top bar). */
function headOf(markup) {
  const start = markup.indexOf('data-editor-head="1"')
  const end = markup.indexOf('data-editor-pane="1"', start)
  assert.ok(start !== -1 && end > start, 'the source pane must render a toolbar header')
  return markup.slice(start, end)
}

/**
 * SSR the workbench with a file already open (via the saved-UI localStorage the
 * workbench reads on mount) — the toolbar is rendered from that state, so a
 * reference to a helper that only exists in another component scope throws here
 * instead of in the browser (that is exactly how `previewCurrentFile` broke).
 */
function renderWorkbenchWithFile(file) {
  const previous = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined
  globalThis.localStorage = { getItem: (key) => (String(key).startsWith('dsh-ris-ide:ui:') ? JSON.stringify({ files: [file], file }) : null), setItem() {} }
  try {
    return renderWorkbench({})
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

test('Markdown/HTML files get the 预览/编辑 switch above the editor, not in the toolbar', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markdown = renderWorkbenchWithFile('/w/README.md')
  assert.match(markdown, /data-action="preview-enter"/, 'a .md file offers the inline preview')
  assert.match(markdown, /data-preview-toggle="closed"/, 'the switch starts in edit mode')
  assert.doesNotMatch(markdown, /data-action="preview"/, 'the generic workbench toolbar stays generic')
  const html = renderWorkbenchWithFile('/w/page.html')
  assert.match(html, /data-action="preview-enter"/, 'a .html file offers it too')
  const java = renderWorkbenchWithFile('/w/ModelHelper.java')
  assert.doesNotMatch(java, /data-action="preview-enter"/, 'plain source files do not')
  assert.doesNotMatch(java, /data-preview-toggle/, 'and get no switch at all')
})

/**
 * The LOG pane's title bar: from its marker to the status bar. The log pane is
 * the LAST slot of the IDE grid, so everything between is its title bar.
 */
function logHeadOf(markup) {
  const start = markup.indexOf('data-log-head="1"')
  assert.ok(start !== -1, 'the log pane must render its own title bar')
  const end = markup.indexOf('data-ide-status', start)
  return markup.slice(start, end === -1 ? undefined : end)
}

test('a first ever open starts with the source pane maximised, and that state is saved', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  const writes = []
  try {
    // No saved layout at all: the workbench should collapse to the source pane.
    globalThis.localStorage = { getItem: () => null, setItem: (key, value) => { writes.push({ key, value: JSON.parse(value) }) } }
    const first = renderWorkbench({})
    assert.match(first, /data-ide-pane="editor"/, 'the first open shows the source pane')
    assert.doesNotMatch(first, /data-ide-pane="tree"/, 'the other panes are maximised away')
    // Persistence round-trip: the same `ui.maximized` the effect writes is what a
    // later open reads back (effects do not run under SSR, so emulate the write).
    globalThis.localStorage = { getItem: () => JSON.stringify({ ui: { maximized: 'editor' }, files: [], sizes: {} }), setItem() {} }
    const again = renderWorkbench({})
    assert.match(again, /data-ide-pane="editor"/, 'the saved maximised state restores')
    assert.doesNotMatch(again, /data-ide-pane="tree"/)

    // A stored layout (even "not maximised") always wins over the default.
    globalThis.localStorage = { getItem: () => JSON.stringify({ ui: { maximized: null }, files: [], sizes: {} }), setItem() {} }
    const restored = renderWorkbench({})
    assert.match(restored, /data-ide-pane="tree"/, 'a saved non-maximised layout restores the grid')
    assert.match(restored, /data-splitter="left"/)
  } finally {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
  }
})

test('the IDE grid has four draggable splitters and applies the default pane sizes', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({ onConfig: { open() {}, generate() {}, exists: true } })
  for (const kind of ['left', 'leftBottom', 'rightBottom', 'debugWidth']) {
    assert.match(markup, new RegExp(`data-splitter="${kind}"`), `missing the ${kind} splitter`)
  }
  assert.equal((markup.match(/width:300px/g) || []).length, 2, 'the left column AND the debug pane default to 300px')
  assert.equal((markup.match(/height:260px/g) || []).length, 2, 'both bottom rows default to 260px')
  const debugSplitter = (markup.match(/<div[^>]*data-splitter="debugWidth"[^>]*>/) || [''])[0]
  assert.match(debugSplitter, /col-resize/, 'the debug splitter resizes a WIDTH (left/right drag)')
  assert.match(markup, /data-debug-row="1"/, 'debug and log share one resizable bottom row')
})

test('the IDE top bar hosts the workspace search and only shows config buttons when hosted', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const head = headOf(renderWorkbench({ onConfig: { open() {}, generate() {}, exists: true } }))
  assert.match(head, /data-action="tree-search"/, 'the tree search input sits in the top bar')
  assert.match(head, /data-action="config-open"/)
  assert.match(head, /data-action="config-generate"/)

  const bare = headOf(renderWorkbench({}))
  assert.match(bare, /data-action="tree-search"/, 'the search belongs to the top bar itself')
  assert.doesNotMatch(bare, /data-action="config-open"/, 'no host callback means no config button')
  assert.doesNotMatch(bare, /data-action="config-generate"/)

  // Restore-layout is a top-bar control and needs no host callback either. It
  // resets ONLY the pane sizes; maximise mode is deliberately left alone.
  for (const bar of [head, bare]) {
    assert.match(bar, /data-action="layout-reset"/, 'the restore-layout button sits at the top bar right end')
    assert.match(bar, /title="还原布局尺寸/)
    assert.match(bar, /data-action="layout-reset"[^>]*>⟲</, 'the button is labelled ⟲')
    const resetTag = bar.match(/<button[^>]*data-action="layout-reset"[^>]*>/)
    assert.ok(resetTag !== null)
    assert.match(resetTag[0], /width:22px/, 'the restore-layout control is an icon button')
    assert.match(resetTag[0], /text-align:center/)
  }
  // The config controls are icon buttons too.
  for (const action of ['config-open', 'config-generate']) {
    const tag = head.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))
    assert.ok(tag !== null, `missing ${action}`)
    assert.match(tag[0], /width:22px/)
  }
})

test('debug controls live in the debug pane toolbar, not in the top bar', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  assert.match(markup, /data-debug-head="1"/, 'the controls live in the debug pane header')
  assert.doesNotMatch(headOf(markup), /data-action="debug-start"/, 'the start button moved out of the top bar')

  const headStart = markup.indexOf('data-debug-head="1"')
  const refresh = markup.indexOf('data-action="debug-refresh"', headStart)
  assert.ok(refresh > headStart, 'the refresh button lives in the debug pane header')
  assert.match(markup.slice(headStart, refresh), /data-action="debug-start"/, 'start precedes refresh in the same header')
})

test('the breakpoint class/line form is gone and the debug/log tabs are closable', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  assert.doesNotMatch(markup, /类名，如/, 'the manual class/line form was removed')
  assert.doesNotMatch(markup, /<button[^>]*>[^<]*加断点/, 'the 加断点 button went with the form')
  assert.match(markup, /双击添加/, 'the empty state teaches double-click breakpoints')

  assert.doesNotMatch(markup, /data-tab-close="debug"/, 'the debug pane has no tab strip')
  assert.doesNotMatch(markup, /data-tab-close="log"/, 'the log pane has no tab strip')
  assert.match(markup, /在控制台点击一个项目/, 'the log pane explains how to pick a project')
})

// ── The source pane delegating to the sidebar's own viewers ────────────────

/**
 * `apply` with a fake sidebar service: this is what publishes `panelCtx`, the
 * module-level context `SidebarEditorPane` resolves its viewer through.
 */
function applySidebar(service) {
  return applyTracked({
    betterSidebar: Object.assign({ registerFileViewer: () => () => {} }, service),
  })
}

/** SSR-render one file pane exactly like the IDE's source tab does. */
function renderPane(extra) {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  return renderToStaticMarkup(React.createElement(T.SidebarEditorPane, Object.assign({
    scope: { sessionId: 's1', cwd: '/w' },
    path: '/w/README.md',
    title: 'README.md',
    text: 'hello',
    visible: true,
    breakpoints: [],
    onToggleBreakpoint: () => {},
  }, extra)))
}

test('capOpenFiles appends under the cap and evicts only the oldest clean tab', () => {
  const dirty = new Set()
  const isDirty = (path) => dirty.has(path)

  // (a) under the cap: appended in open order.
  assert.deepEqual(T.capOpenFiles(['a', 'b'], 'c', 20, isDirty), ['a', 'b', 'c'])

  // (b) already open: the SAME list comes back (no reorder, no duplicate).
  const open = ['a', 'b']
  assert.equal(T.capOpenFiles(open, 'a', 20, isDirty), open, 'an already-open path must be a no-op')

  // (c) at the cap with clean tabs: the OLDEST clean tab goes, order is kept.
  const full = Array.from({ length: 20 }, (_, index) => `f${index}`)
  assert.deepEqual(T.capOpenFiles(full, 'new', 20, isDirty), [...full.slice(1), 'new'])

  // (d) every tab dirty: the open is refused rather than losing a draft.
  assert.equal(T.capOpenFiles(full, 'new', 20, () => true), null)

  // (e) dirty tabs are never evicted while an older clean one exists.
  dirty.add('f0')
  dirty.add('f1')
  const capped = T.capOpenFiles(full, 'new', 20, isDirty)
  assert.equal(capped.length, 20)
  assert.ok(capped.includes('f0') && capped.includes('f1'), 'dirty tabs survive')
  assert.ok(!capped.includes('f2'), 'the oldest clean tab is the victim')
  assert.deepEqual(capped, ['f0', 'f1', ...full.slice(3), 'new'])
})





test('the workbench restores open source tabs from localStorage and shows the workspace path', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  const keys = []
  globalThis.localStorage = {
    getItem: (key) => {
      keys.push(key)
      return key === 'dsh-ris-ide:ui:workspace'
        ? JSON.stringify({ ui: {}, files: ['/w/a.java', '/w/b.java'], file: '/w/a.java', sizes: {} })
        : null
    },
    setItem: () => {},
  }
  try {
    const markup = renderWorkbench({
      scope: { sessionId: 's1', cwd: '/w/work' },
      // No program meta → the WORKSPACE storage key, the one this test restores.
      tab: { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace' },
    })
    assert.ok(keys.includes('dsh-ris-ide:ui:workspace'), `unexpected storage key ${keys.join(', ')}`)
    assert.match(markup, /data-workbench-path="1">\/w\/work</, 'the top bar shows the workspace path')
    assert.equal((markup.match(/data-tab-close="source"/g) || []).length, 2, 'both restored files get a tab')
    assert.match(markup, /a\.java/)
    assert.match(markup, /b\.java/)
    assert.match(markup, /data-tab-page="prev"/)
    assert.match(markup, /data-tab-page="next"/)
    // The two bulk-close buttons moved into the tab strip's right-click menu,
    // so they are not part of the rendered bar any more.
    assert.doesNotMatch(markup, /data-action="close-others"/)
    assert.doesNotMatch(markup, /data-action="close-all"/)
  } finally {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
  }
})

test('the console starts and stops FRONTEND programs too, and only Spring gets debug', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({
    programs: [
      { id: 'frontend:ui#dev', name: 'ris-ui-3', kind: 'frontend', logPath: '/w/logs/ui.log', running: { alive: true } },
      { id: 'frontend:x#dev', name: 'ris-x', kind: 'frontend', logPath: '/w/logs/x.log', running: { alive: false } },
    ],
  })
  assert.equal((markup.match(/data-action="console-stop"/g) || []).length, 1, 'the running frontend gets a stop button')
  assert.equal((markup.match(/data-action="console-start"/g) || []).length, 1, 'the stopped frontend gets a start button')
  assert.match(markup, /data-action="console-stop" title="停止 ris-ui-3"/)
  assert.match(markup, /data-action="console-start" title="启动 ris-x"/)
  assert.doesNotMatch(markup, /console-debug/, 'debug stays Spring-only')
})

test('console and debug-toolbar icon buttons are fixed-width while text buttons are not', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({
    programs: [
      { id: 'frontend:ui#dev', name: 'ris-ui-3', kind: 'frontend', logPath: '/w/logs/ui.log', running: { alive: true } },
      { id: 'frontend:x#dev', name: 'ris-x', kind: 'frontend', logPath: '/w/logs/x.log', running: { alive: false } },
      { id: 'spring:a#A', name: 'a-biz', kind: 'spring', logPath: '/w/logs/a.log', running: { alive: true } },
    ],
  })
  // Each OPENING TAG carrying a data-action: style precedes it in the SSR output.
  const tags = markup.match(/<button[^>]*>/g) || []

  const consoleTags = tags.filter((tag) => /data-action="console-/.test(tag))
  assert.ok(!consoleTags.some((tag) => tag.includes('data-action="console-log"')), 'the log button is gone')
  for (const action of ['console-start', 'console-stop', 'console-debug']) {
    assert.ok(consoleTags.some((tag) => tag.includes(`data-action="${action}"`)), `missing ${action}`)
  }
  for (const tag of consoleTags) {
    const action = /data-action="([^"]+)"/.exec(tag)[1]
    // Console buttons are 25px (22px + the user-requested 3px), the rest of the
    // 22px icon family stays as-is.
    assert.match(tag, /width:25px/, `${action} must be fixed-width (25px)`)
    assert.match(tag, /text-align:center/, `${action} must be centred`)
  }

  // The console's STOP button is the red tone; the others stay neutral.
  const stopTag = consoleTags.find((tag) => tag.includes('data-action="console-stop"'))
  const startTag = consoleTags.find((tag) => tag.includes('data-action="console-start"'))
  assert.match(stopTag, /color:#e5534b/, 'the console stop button must be red')
  assert.match(stopTag, /border:1px solid color-mix\(in srgb, #e5534b/, 'the red border belongs with it')
  assert.match(startTag, /color:#3fb950/, 'the console start button must be green')
  assert.match(startTag, /border:1px solid color-mix\(in srgb, #3fb950/, 'the green border belongs with it')

  // The debug toolbar's own icons get the same treatment.
  for (const action of ['debug-start', 'debug-refresh']) {
    const tag = tags.find((candidate) => candidate.includes(`data-action="${action}"`))
    assert.ok(tag !== undefined, `missing ${action}`)
    assert.match(tag, /width:22px/, `${action} must be fixed-width`)
  }

  // The bulk-close actions live in the tab-strip context menu now (not in the bar).
  assert.equal(tags.some((tag) => /data-action="close-others"|data-action="close-all"/.test(tag)), false)
})

// ── IDE-wide content font size (A−/A+) ─────────────────────────────────────

/** The workbench's own `<style>` child (React escapes its quotes as &quot;). */
function styleChildOf(markup) {
  const match = /<style>([\s\S]*?)<\/style>/.exec(markup)
  assert.ok(match !== null, 'the workbench must render its .cm-editor font rule')
  return match[1]
}

/** Opening tag of the tree list: its size is an author-level 12px block. */
function treeTagOf(markup) {
  const match = /<div[^>]*data-tree-root="[^"]*"[^>]*>/.exec(markup)
  assert.ok(match !== null, 'the tree list must render')
  return match[0]
}

/** Opening tag of the workbench root (`data-workbench="ris-ide"`). */
function workbenchRootTagOf(markup) {
  const match = /<div[^>]*data-workbench="ris-ide"[^>]*>/.exec(markup)
  assert.ok(match !== null, 'the workbench root must render')
  return match[0]
}

test('the top bar offers A-/A+ for the IDE-wide content font size', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const head = headOf(renderWorkbench({}))
  assert.match(head, /data-action="font-minus"/, 'A- sits in the top bar')
  assert.match(head, /data-action="font-plus"/, 'A+ sits in the top bar')
  assert.match(head, /data-action="font-minus"[^>]*title="减小各面板字号（当前 12\.5px）"[^>]*>A-</, 'A- is labelled and shows the current size')
  assert.match(head, /data-action="font-plus"[^>]*title="增大各面板字号（当前 12\.5px）"[^>]*>A\+</, 'A+ is labelled and shows the current size')
})

test('the default IDE font size is 12.5px in the CodeMirror rule and the tree stays 12px', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  assert.match(styleChildOf(markup), /\.cm-editor\{font-size:12\.5px !important\}/)
  assert.match(styleChildOf(markup), /\.cm-scroller\{line-height:1\.5\}/)
  assert.match(workbenchRootTagOf(markup), /font-size:12\.5px/, 'the workbench root carries the content size')
  assert.match(treeTagOf(markup), /font-size:12px/, 'the tree block is authored at 12px and unscaled by default')
})

test('a stored font size scales the IDE blocks through the style proxy', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  const keys = []
  globalThis.localStorage = {
    getItem: (key) => {
      keys.push(key)
      return key === 'dsh-ris-ide:ui:workspace'
        ? JSON.stringify({ font: 15, files: [], ui: {}, sizes: {} })
        : null
    },
    setItem: () => {},
  }
  try {
    // Meta-less tab → the workspace key (a program meta would use its own key).
    const markup = renderWorkbench({ tab: { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace' } })
    assert.ok(keys.includes('dsh-ris-ide:ui:workspace'), `unexpected storage keys ${keys.join(', ')}`)
    assert.match(workbenchRootTagOf(markup), /font-size:15px/, 'the stored size reaches the workbench root')
    assert.match(styleChildOf(markup), /\.cm-editor\{font-size:15px !important\}/, 'the stored size reaches CodeMirror')
    // 12px authored × (15 / 12.5) = 14.4 → nearest 0.5px = 14.5
    assert.match(treeTagOf(markup), /font-size:14\.5px/, 'author-level blocks scale with the ratio')
  } finally {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
    // No module-global ratio to reset any more: scaling is per-tree (stylesFor).
  }
})

test('clampUiFont keeps the IDE font inside 10-18px in half steps', () => {
  assert.equal(T.clampUiFont(9), 10)
  assert.equal(T.clampUiFont(19), 18)
  assert.equal(T.clampUiFont(12.3), 12.5)
  assert.equal(T.clampUiFont('abc'), 12.5)
  assert.equal(T.clampUiFont(13.7), 13.5)
  assert.equal(T.clampUiFont(12.5), 12.5)
})

test('viewerFontCss pins the embedded sidebar viewer to the current size', () => {
  const css = T.viewerFontCss(14)
  assert.equal(typeof css, 'string')
  assert.match(css, /\.cm-editor\{font-size:14px !important\}/)
  assert.match(css, /\.cm-scroller\{line-height:1\.5\}/)
})

test('LogTail multiplies its own font size by the IDE-wide scale', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  // Minimal viewer payload, the same shape the existing LogTail SSR tests use.
  const customData = { ok: true, content: 'BOOT-OK\n', mode: 'tail', size: 9, elided: 0, mtimeMs: 1 }
  const render = (extra) => renderToStaticMarkup(React.createElement(T.LogTail, Object.assign({
    scope: { sessionId: 's1', cwd: '/w' },
    path: '/w/x.log',
    customData,
  }, extra)))
  const viewerTagOf = (markup) => {
    const match = /<div[^>]*data-dsh-ris-ide="viewer"[^>]*>/.exec(markup)
    assert.ok(match !== null, 'the viewer root must render')
    return match[0]
  }

  // NOTE: `PREF_FONT_SIZE` defaults to the authored 12.5px, but the viewer's own
  // size state goes through `clampFontSize`, which steps in WHOLE pixels (its own
  // A−/A+ keeps integer steps), so the effective base is 13px of the 12.5px
  // authored default. The IDE-wide ratio multiplies THAT base.
  assert.match(viewerTagOf(render({})), /font-size:13px/, 'no scale = the viewer pref (12.5 → 13 by the integer clamp)')
  assert.match(viewerTagOf(render({ scale: 1 })), /font-size:13px/, 'scale 1 is the identity (the sidebar viewer passes nothing)')
  // 13 × 1.2 = 15.6 → clampFontSize → 16px.
  assert.match(viewerTagOf(render({ scale: 1.2 })), /font-size:16px/, 'the IDE ratio multiplies the viewer pref (13 × 1.2 → 16)')
})

// ── Colour scheme (auto / dark / light) ────────────────────────────────────

/** Stub the IDE's per-tab localStorage entry; returns a restore function. */
function stubWorkspaceUi(patch, keys) {
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => {
      if (keys !== undefined) keys.push(key)
      return key === 'dsh-ris-ide:ui:workspace'
        ? JSON.stringify(Object.assign({ files: [], ui: {}, sizes: {} }, patch))
        : null
    },
    setItem: () => {},
  }
  return () => {
    if (hadLocalStorage) globalThis.localStorage = previousLocalStorage
    else globalThis.localStorage = undefined
  }
}

test('the workbench follows the DSH theme and pins no colours of its own', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  const root = workbenchRootTagOf(markup)
  assert.match(root, /data-theme="page"/, 'no theme service in SSR → the page decides')
  assert.doesNotMatch(root, /background:#ffffff/)
  assert.doesNotMatch(root, /background:#1b1d23/)
  assert.doesNotMatch(root, /color-scheme:/, 'the IDE pins nothing')
  // The embedded editor still states the PAGE-matching surface so its one-*/one-dark
  // palette never lands on the wrong background.
  assert.match(styleChildOf(markup), /\.cm-editor\{background:#1b1d23/, 'SSR probes dark → dark surface')
})

test('the appearance button drives DSH, not a private IDE scheme', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  // No theme service (an older host, or SSR): nothing to drive → no control at all.
  T.__setPanelCtx(undefined)
  assert.doesNotMatch(headOf(renderWorkbench({})), /data-action="theme"/, 'without a theme service the control is hidden')

  const calls = []
  const service = {
    getTheme: () => ({ preference: 'system', revision: 3 }),
    setTheme: (id) => { calls.push(id) },
  }
  const disposed = []
  T.__setPanelCtx({
    get: (name) => (name === 'theme' ? service : undefined),
    on: (name, listener) => { if (name === 'theme/change') disposed.push(listener); return () => {} },
  })
  try {
    const markup = renderWorkbench({})
    const head = headOf(markup)
    assert.match(head, /data-action="theme" data-theme-state="system"/, 'the button mirrors DSH preference')
    assert.match(head, /data-action="theme"[^>]*>🌓</, 'system uses the follow glyph')
    assert.match(workbenchRootTagOf(markup), /data-theme="system"/, 'the root reports the DSH preference')
  } finally {
    T.__setPanelCtx(undefined)
  }
  assert.deepEqual(calls, [], 'rendering alone never mutates the DSH theme')
})


test('viewerThemeCss states the surface that matches the page palette', () => {
  // Light page → light surface + one-light token colours.
  const light = T.viewerThemeCss(false)
  assert.match(light, /\.cm-editor\{background:#ffffff !important;color:#1f2328 !important\}/)
  assert.match(light, /\.tok-keyword\{color:#cf222e/)

  // Dark page → dark surface + one-dark token colours.
  const dark = T.viewerThemeCss(true)
  assert.match(dark, /\.cm-editor\{background:#1b1d23 !important;color:#d8dbe0 !important\}/)
  assert.match(dark, /\.tok-keyword\{color:#569cd6/)

  // No argument → probe the page (SSR has no DOM, so it resolves dark).
  assert.match(T.viewerThemeCss(), /\.cm-editor\{background:#1b1d23/)
})

test('font scaling is per-tree: the IDE ratio reaches its own title bar, not the plain viewer', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const restore = stubWorkspaceUi({ font: 15 })
  let markup
  try {
    markup = renderWorkbench({ tab: { id: T.PROGRAM_TAB_ID, type: T.PROGRAM_TAB_ID, title: 'workspace' } })
  } finally {
    restore()
  }
  assert.match(workbenchRootTagOf(markup), /font-size:15px/, 'sanity: the IDE rendered at 15px')
  // The log pane's TITLE BAR (which owns the viewer chrome since 1.6.1) scales
  // with the IDE ratio: 11 × 1.2 → 13. A plain viewer never sees that ratio.
  assert.match(logHeadOf(markup), /font-size:13px/, 'the log title bar follows the IDE font ratio')

  const { renderToStaticMarkup } = require(`${REACT_ROOT}/react-dom/server`)
  const customData = { ok: true, content: 'BOOT-OK\n', mode: 'tail', size: 9, elided: 0, mtimeMs: 1 }
  const renderLog = (extra) => renderToStaticMarkup(React.createElement(T.LogTail, Object.assign({
    scope: { sessionId: 's1', cwd: '/w' },
    path: '/w/x.log',
    customData,
  }, extra)))
  const rootTagOf = (logMarkup) => {
    const match = /<div[^>]*data-dsh-ris-ide="viewer"[^>]*>/.exec(logMarkup)
    assert.ok(match !== null, 'the viewer root must render')
    return match[0]
  }

  // No fontRatio — exactly what the sidebar's own `.log` viewer passes. The
  // 15px IDE ratio was module-global in 1.1.1 and leaked here; it must not now.
  const plain = renderLog({})
  assert.match(rootTagOf(plain), /font-size:13px/, 'content keeps its own base (12.5 → 13 by the integer clamp)')

  // Inside the IDE the viewer gets fontRatio: its own content still does not move
  // (only the explicit scale does).
  const ratioOnly = renderLog({ fontRatio: 1.2 })
  assert.match(rootTagOf(ratioOnly), /font-size:13px/, 'content ignores fontRatio — only the explicit scale moves it')

  // ...and the explicit scale still moves the content.
  const both = renderLog({ fontRatio: 1.2, scale: 1.2 })
  assert.match(rootTagOf(both), /font-size:16px/, 'content follows the explicit scale too (13 × 1.2 → 16)')
})

test('blank and comment-only Java lines refuse a breakpoint', async () => {
  const F = T.isNonExecutableJavaLine
  assert.equal(F(''), true)
  assert.equal(F('   \t '), true, 'whitespace only')
  assert.equal(F('// note'), true, 'line comment')
  assert.equal(F('  /* block */'), true, 'block comment')
  assert.equal(F(' * javadoc'), true, 'javadoc continuation')
  assert.equal(F(' */'), true, 'block comment close')
  assert.equal(F('int x = 1;'), false, 'real code stays breakpointable')
  assert.equal(F('a * b;'), false, 'a multiplication is executable')
  assert.equal(F(undefined), false, 'unknown text is not refused')

  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /isNonExecutableJavaLine\(texts\[line - 1\]\)/, 'the gutter click consults the guard before adding a dot')
})

test('both gutters take breakpoint gestures: line-number click adds, double-click removes', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/chunks/codemirror.js', import.meta.url), 'utf8')
  const built = await readFile(new URL('../lib/client-codemirror.js', import.meta.url), 'utf8')
  // The line-number gutter is a full-width click target, not just the narrow dot column.
  assert.match(src, /lineNumbers\(\{\s*\n\s*domEventHandlers: \{/, 'the line-number gutter carries its own handlers')
  assert.match(src, /breakpointGesture\(options, 'single'\)/)
  assert.match(src, /breakpointGesture\(options, 'double'\)/)
  assert.match(src, /gesture === 'single' && marked/, 'a single click on a dot does nothing')
  assert.match(src, /gesture === 'double' && !marked/, 'a double-click only removes an existing dot')
  // Breakpoints arrive in click order; an unsorted RangeSetBuilder add throws and
  // takes the whole gutter row (line numbers included) off screen.
  assert.match(src, /\[\.\.\.breakpointLines\]\.sort\(/)
  // The committed artifact must already be the rebuilt chunk (CI does not build).
  assert.match(built, /function breakpointGesture/, 'the built chunk ships the gesture helper')
  assert.match(built, /breakpointGesture\(options, "double"\)/, 'the built chunk ships the double-click removal')
  assert.match(built, /\[\.\.\.breakpointLines\]\.sort\(/, 'the built chunk sorts marker lines')
  assert.match(built, /cm-lineNumbers/, 'the line-number gutter is still rendered')

  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /'单击加断点'/, 'the fallback editor teaches the same gesture')
  assert.match(client, /'双击删除断点'/)
  assert.match(client, /onClick: function \(\) \{ if \(!hasBp\) props\.onToggleBreakpoint\(line\) \}/)
  assert.match(client, /onDoubleClick: function \(\) \{ if \(hasBp\) props\.onToggleBreakpoint\(line\) \}/)
})

test('the debug stream frame applies without an ok flag (older hosts omit it)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A reload is served by the SSE debug topic; a frame that is not an explicit
  // error must reach `merge`, otherwise the pane shows no pre-set breakpoints.
  assert.match(source, /if \(result === null \|\| result === undefined \|\| result\.ok === false\) return/)
  const head = source.slice(source.indexOf('async function applyPollResult(result) {'))
  assert.doesNotMatch(head.slice(0, 400), /ok !== true/, 'requiring ok===true silently dropped stream frames')
})

test('a pre-set (pending) breakpoint toggles OFF from the gutter', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Every dot is `pending` until a debug session installs it; excluding pending
  // rows from `existing` made a double-click ADD instead of remove (dot stayed).
  const start = source.indexOf('async function toggleBreakpoint(line) {')
  assert.ok(start > 0, 'toggleBreakpoint is present')
  const toggler = source.slice(start, start + 6000)
  assert.match(toggler, /bp\.className === className && bp\.line === line && bp\.failed !== true/)
  assert.doesNotMatch(toggler, /bp\.pending !== true && bp\.failed !== true/, 'a pending row is removable like any other')
  assert.match(toggler, /requestId: 'pending'/, 'the pending marker is what the host resolves by class+line')
})

test('a breakpoint suspends ONE thread: suspendedThreads is what "paused" means', () => {
  const snap = T.debugSnapshotSuspended
  const thread = T.debugSuspendedThreadId
  // JDWP breakpoints/steps use SuspendPolicy.EventThread: vmSuspended stays false.
  assert.equal(snap({ vmSuspended: false, suspendedThreads: ['7'] }), true)
  assert.equal(snap({ vmSuspended: true, suspendedThreads: [] }), true)
  assert.equal(snap({ vmSuspended: false, suspendedThreads: [] }), false)
  assert.equal(snap(null), false)
  assert.equal(snap(undefined), false)
  assert.equal(thread({ vmSuspended: false, suspendedThreads: ['5', '7'], currentThreadId: '7' }), '7')
  assert.equal(thread({ suspendedThreads: ['5', '7'] }), '7', 'newest suspended thread is the fallback')
  assert.equal(thread({ currentThreadId: 11 }), '11', 'BigInt-safe JSON ids are strings')
  assert.equal(thread({ suspendedThreads: [] }), undefined)
})

test('a stopped thread drives the pane: buttons, frames, and the 参数 tab', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 1) The pane must not scroll as a whole: only the section body scrolls.
  assert.match(source, /debug: h\('div', \{ style: S\.debugSlot, 'data-debug-slot': '1' \}, pane\)/)
  assert.doesNotMatch(source, /debug: h\('div', \{ style: S\.ideBody \}, pane\)/, 'the debug pane is not wrapped in the shared scroller')
  assert.match(source, /debugSlot: \{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' \}/)
  assert.match(source, /debugContent: \{ flex: 1, minHeight: 0, overflowY: 'auto'/)

  // 2) merge keeps the stopped-thread ids and derives "paused" from them.
  assert.match(source, /suspended: debugSnapshotSuspended\(payload\)/)
  assert.match(source, /suspendedThreads: Array\.isArray\(payload\.suspendedThreads\)/)
  assert.match(source, /currentThreadId: payload\.currentThreadId/)

  // 3) Frames come from the stopped thread, not threads[0]; hitting a breakpoint
  //    lands on the 参数 tab (and the editor already follows the frame).
  assert.match(source, /await loadThreads\(debugSuspendedThreadId\(result\)\)/)
  assert.match(source, /section: 'variables'/, 'a suspend switches the debug pane to 参数')
  assert.doesNotMatch(source, /threads\[0\]\.threadId/, 'threads[0] is not necessarily the stopped thread')
  assert.match(source, /busyRef\.current \|\| target/, 'sanity: poll guard still present')

  // The SSE debug subscription stays mounted across suspends, so its handler must
  // read a REF: reading `dbg` from the effect closure would always see the state
  // from subscribe time (no tab switch after the first hit, empty frames).
  assert.match(source, /var dbgRef = useRef\(dbg\)/)
  assert.match(source, /var wasSuspended = dbgRef\.current\.suspended === true/)
  assert.match(source, /var known = dbgRef\.current\.currentThreadId/)
})

test('the debug pane scrolls inside its tab page, not with the whole pane', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, () => {
  const markup = renderWorkbench({})
  const at = markup.indexOf('data-debug-slot="1"')
  assert.ok(at > -1, 'the debug pane has its own slot wrapper')
  const window = markup.slice(Math.max(0, at - 400), at + 60)
  assert.ok(window.includes('overflow:hidden'), 'the slot clips; the tab strip must not scroll away')
  assert.ok(window.includes('flex-direction:column') || window.includes('flexDirection'), 'the slot stacks tab strip + body')
  assert.ok(markup.indexOf('data-debug-tabs="1"') > -1, 'the section tab strip still renders')
})

test('one IDE window per workspace: the window name is keyed by the workspace cwd', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(T.standaloneWindowName('/w/alpha'), T.standaloneWindowName('/w/alpha/'), 'a trailing slash must reuse the same window')
  assert.notEqual(T.standaloneWindowName('/w/alpha'), T.standaloneWindowName('/w/beta'), 'different workspaces get their own window')
  assert.ok(T.standaloneWindowName('/w/alpha').startsWith(T.WINDOW_NAME + '-'))
  assert.notEqual(T.standaloneWindowKey('/w/alpha'), T.standaloneWindowKey('/w/beta'))
  // The opener must use the workspace-keyed name, not the fixed one; the URL
  // carries it as `wname` so /window can claim the very same lock even when the
  // panel itself is rooted at a program subdirectory.
  assert.match(source, /var windowCwd = typeof opts\.windowCwd === 'string'/)
  assert.match(source, /var windowName = standaloneWindowName\(windowCwd !== undefined \? windowCwd : cwd\)/)
  assert.match(source, /url\.searchParams\.set\('wname', windowName\)/)
  assert.match(source, /window\.open\(url\.href, windowName, features\)/)
})

test('the standalone window claims a single-instance lock before booting the IDE', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../lib/standalone/window.html', import.meta.url), 'utf8')
  const from = html.indexOf('id="root"')
  const to = html.indexOf('window/vendor/react.js')
  assert.ok(from > 0 && to > from, 'the claim runs before the panel loads')
  const claim = html.slice(from, to)
  assert.match(claim, /navigator\.locks/, 'Web Locks is the primary mechanism')
  assert.match(claim, /locks\.request\(key, \{ ifAvailable: true \}/)
  assert.match(claim, /BroadcastChannel/, 'fallback channel exists')
  assert.match(claim, /params\.get\('wname'\)/, 'the opener hands the workspace window name over')
  assert.match(claim, /var key = windowName/, 'the lock key IS the window name')
  assert.match(claim, /type: 'focus'/, 'the surviving window is nudged forward')
  // A reused window (same name, e.g. after a dsh restart) can still see the old
  // document's lock for a moment: retry before believing there is a real second
  // window, and NEVER close this one (that made it flash and vanish).
  assert.match(claim, /if \(attempt < 5\) \{ setTimeout\(tryClaim, 120 \* attempt\)/, 'the claim retries through a navigation race')
  assert.match(claim, /仍然在这里打开/, 'the user can override the single-window guard')
  // Focusing another browser window is not reliably allowed, so the duplicate
  // offers an explicit "close this window" action instead — and only that button
  // may close it (never an automatic close at boot).
  assert.match(claim, /关闭这个窗口/, 'the duplicate window can be closed on demand')
  assert.equal((claim.match(/window\.close\(\)/g) || []).length, 1, 'closing happens only from the button')
  // Booting waits for the claim, so the notice cannot be raced by a mounted panel.
  assert.match(html, /window\.__risIdeClaimReady/)
  assert.match(html, /window\.__risIdeBootPanel = bootPanel/)
  assert.match(html, /blocked === true\) return/)
  // The same hash function as client.js ⇒ both compute the same key for a cwd.
  assert.equal(T.standaloneWindowKey('/w/alpha'), '1ys5bqv', 'pure hash: same on every machine')
})

test('object variables expand on demand through debug/expand, one click at a time', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // The variables tab renders a TREE: rows carry their key and a ▸/▾ toggle, and
  // a click fetches children lazily (no deep copy of a big model object).
  assert.match(source, /function variableRows\(items, parentKey, depth\)/)
  assert.match(source, /'data-var-expand': key/)
  assert.match(source, /'data-var-key': key/)
  assert.match(source, /await call\('expand', \{ objectId: item\.objectId \}\)/)
  assert.match(source, /setVarTree\(function \(prev\)/)
  // Arrays list their entries as [i] and say when the host capped the list.
  assert.match(source, /name: '\[' \+ entry\.index \+ '\]'/)
  assert.match(source, /还有 .* 项（只列前 100）/)
  // The GET whitelist must include the new read action (`requestDebug` would
  // otherwise refuse it before reaching the host).
  assert.match(source, /var DEBUG_READ_ACTIONS = \[[^\]]*'expand'/)
})

test('a frame without source in the workspace is ignored quietly', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // A JDK/dependency frame must not pop a toast (用户要求: 类文件缺失就忽略,
  // 不要弹错误窗). The debug pane shows one quiet banner instead.
  assert.doesNotMatch(source, /源码不在工作区/)
  assert.match(source, /'data-missing-source': '1'/)
  assert.match(source, /'无源码 · '/)
  // The miss stays cached so a step storm never re-scans the workspace.
  assert.match(source, /sourcePathRef\.current\[cleaned\] = found === undefined \? null : found/)
})

test('a debug start, stop or resume re-reads the log pane', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // Debug start/stop restarts the service and a resume un-freezes the JVM: the
  // log viewer must pull the tail instead of waiting for a frame that may never
  // come (the workbench passes a nonce down to LogTail).
  assert.match(source, /var \[logNonce, setLogNonce\] = useState\(0\)/)
  assert.match(source, /reloadNonce: logNonce/)
  assert.match(source, /props\.reloadNonce/)
  assert.match(source, /var reloadSeenRef = useRef\(props\.reloadNonce\)/)
  assert.match(source, /setLogNonce\(function \(value\) \{ return value \+ 1 \}\)/)
  const bumps = source.split('setLogNonce(function (value) { return value + 1 })').length - 1
  assert.ok(bumps >= 3, `start, stop and resume each bump the log nonce (found ${bumps})`)
})

test('a suspended line that is outside the viewport is scrolled into view', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(new URL('../src/chunks/codemirror.js', import.meta.url), 'utf8')
  const chunk = await readFile(new URL('../lib/client-codemirror.js', import.meta.url), 'utf8')

  // The chunk highlights the line and scrolls ONLY when it is off screen (a step
  // that stays visible must not move the viewport).
  assert.match(chunkSource, /function applyDebugLine\(view, line\)/)
  assert.match(chunkSource, /target >= viewport\.fromLine && target <= viewport\.toLine/)
  assert.match(chunkSource, /if \(!visible\) effects\.push\(EditorView\.scrollIntoView\(pos, \{ y: 'center' \}\)\)/)
  assert.match(chunkSource, /applyDebugLine\(view, line\)/)
  assert.match(chunk, /applyDebugLine/)
  assert.match(chunk, /EditorView\.scrollIntoView\(pos, \{ y: "center" \}\)/)

  // A parked tab is display:none (zero-height viewport), so the scroll decision
  // is deferred until it becomes the active tab; the debug effect depends on it.
  assert.match(source, /if \(props\.visible === false\) return/)
  assert.match(source, /\[props\.debugLine, props\.debugNonce, props\.visible\]/)
})

test('the variable tree keeps its open rows across a step and only objects get a caret', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // A primitive/string/null row has no children: no ▸, no click, nothing to open.
  assert.match(source, /var expandable = \(raw\.kind === 'object' \|\| raw\.kind === 'array'\) && typeof raw\.objectId === 'string' && raw\.objectId !== '' && depth < 8/)

  // A step re-reads this frame's variables but keeps `expanded` and the item
  // behind each open row, so the tree does not collapse under the user.
  assert.match(source, /setVarTree\(function \(prev\) \{ return \{ expanded: prev\.expanded, children: \{\}, loading: \{\}, items: prev\.items \} \}\)/)
  assert.match(source, /items: Object\.assign\(\{\}, prev\.items, \{ \[key\]: item \}\)/)
  // ... and every open node is re-fetched once, so the values follow the new frame.
  assert.match(source, /function loadVariableChildren\(key, item\)/)
  assert.match(source, /void loadVariableChildren\(key, item\)/)
  assert.match(source, /\[dbg\.variables, ui\.frameIndex\]/)

  // A stale JDWP id must be a toast + a cleared loading flag, never a crash.
  assert.match(source, /try \{\s*result = await call\('expand'/)
  assert.match(source, /catch \(problem\) \{\s*result = \{ ok: false, error: messageOf\(problem\) \}\s*\}/)
  assert.match(source, /note\('展开失败：' \+ result\.error\)/)
})

test('a render failure inside the panel shows a retry banner instead of taking dsh down', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // A class boundary is the only hook React gives for render errors; it renders a
  // banner with the message and a retry button.
  // CI loads this bundle with a hooks-only React stub (no `React.Component`), so
  // the class extends a guarded base that is `React.Component` in real hosts.
  assert.match(source, /var ErrorBoundaryBase = React !== null && React !== undefined && typeof React\.Component === 'function'/)
  assert.match(source, /class IdeErrorBoundary extends ErrorBoundaryBase/)
  assert.match(source, /static getDerivedStateFromError\(error\)/)
  assert.match(source, /'data-ide-crash': '1'/)
  assert.match(source, /'data-ide-crash-retry': '1'/)
  assert.equal(typeof T.IdeErrorBoundary, 'function')

  // BOTH mount points are wrapped (the dsh sidebar tab and the standalone window).
  assert.match(source, /function IdePanelBoundary\(props\) \{ return h\(IdeErrorBoundary, null, h\(ProgramsPanel, props\)\) \}/)
  assert.match(source, /root\.render\(h\(IdeErrorBoundary, null, h\(ProgramsPanel, \{ sessionId: sessionId, cwd: cwd, visible: true, compact: false \}\)\)\)/)
})

test('a start switches to that program log before waiting for the spawn', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // Clicking start must show this program's log immediately: the host call can
  // block for START_WAIT_MS, and Maven compile prints nothing for tens of seconds.
  assert.match(source, /async function consoleStart\(program\) \{\n\s*\/\/[\s\S]*?\n\s*selectProgram\(program\)[\s\S]*?setConsoleBusy\(program\.id\)[\s\S]*?requestStart\(program\.id, scopeRef\.current\)/)
  // The sidebar rows do the same before awaiting requestStart.
  assert.match(source, /if \(kind === 'start'\) \{ setActive\(program\); broadcastLogFocus\(program\.logPath\); setCompactLogNonce/)
  // …and every window watching another log is moved by the same broadcast.
  assert.match(source, /function broadcastLogFocus\(logPath\)/)
})

test('the debug pane has a visual settings dialog for dependency sources', { skip: !reactIsReal ? 'React unavailable for SSR' : false }, async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const markup = renderWorkbench({})
  assert.match(markup, /data-action="debug-settings"/, 'the debug title bar carries the ⚙ button')
  assert.match(source, /'data-debug-settings-jar': '1'/)
  assert.match(source, /'data-debug-settings-args': '1'/)
  assert.match(source, /'data-debug-settings-save': '1'/)
  assert.match(source, /fsSaveSettings\(scopeRef\.current, \{ decompilerJar: jar, decompilerArgs: args \}\)/)
  assert.match(source, /fsDependencySource\(scopeRef\.current, cleaned/, 'a missing workspace source asks the host for the jar source')
  assert.match(source, /dsh-ris-ide\/debug\/source/)
  assert.match(source, /-sources\.jar/)
  assert.match(source, /\.dsh-ris-ide-cache/)
})

test('the IDE console masks a program row while it starts, stops or debugs, and the compact note expires', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Per-program busy id: one row is masked, not the whole console.
  assert.match(source, /var \[consoleBusy, setConsoleBusy\] = useState\(''\)/)
  assert.match(source, /var busy = consoleBusy === program\.id/)
  assert.match(source, /setConsoleBusy\(program\.id\)/)
  assert.match(source, /data-program-loading': program\.id/)
  // The mask is the same overlay the compact console uses, on a positioned row.
  assert.match(source, /position: 'relative', overflow: 'hidden' \}\),\n\s*'data-console-on'/)
  assert.match(source, /PROGRAM_LOADING_CSS/)
  // A transient top-bar note clears itself after 5 seconds.
  assert.match(source, /\}, 5000\)\n\s*return function \(\) \{ clearTimeout\(timer\) \}/)
})

test('the console row masks itself while a start/stop is in flight', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /'data-program-loading': program\.id/)
  assert.match(source, /className: 'dsh-ris-ide-loading'/)
  assert.match(source, /dshRisIdeSpin/)
  assert.match(source, /alive \? '停止中…' : '启动中…'/)
  // The mask swallows the click, and the row is the containing block for it.
  assert.match(source, /onClick: function \(event\) \{ event\.stopPropagation\(\); event\.preventDefault\(\) \}/)
  assert.match(source, /position: 'relative', overflow: 'hidden'/)
  // Rows keep their own height so the list scrolls; a shrinkable row used to
  // squash the whole project list into the panel (no scrollbar at all).
  assert.match(source, /flex: '0 0 auto', minWidth: 0, cursor: 'pointer', position: 'relative', overflow: 'hidden'/)
})

test('debug start switches the log pane first, and the variable caret is borderless', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const from = source.indexOf('async function startDebug() {')
  assert.ok(from > 0)
  const slice = source.slice(from, from + 1800)
  // The log view jumps to the program BEFORE the host is asked to restart it
  // (waiting for the reply made it look like the switch happened ~40s late).
  const switched = slice.indexOf('setActivePath(logPath)')
  const started = slice.indexOf("await call('start'")
  assert.ok(switched > 0 && started > 0 && switched < started, 'switch the log first')
  assert.match(slice, /setLogNonce\(function \(value\) \{ return value \+ 1 \}\)/)
  // The switch follows the user into other windows, and the tail is re-read the
  // moment the restarted service prints its first byte (Maven is quiet).
  assert.match(slice, /broadcastLogFocus\(logPath\)/)
  assert.match(slice, /watchLogOutput\(logPath, baseline\)/)
  // Tree caret: glyph only, no bordered button box.
  assert.match(source, /var caretStyle = \{[\s\S]{0,400}?border: 'none'/)
  assert.match(source, /loading \? '…' : \(open \? '▾' : '▸'\)/)
  // ... and the caret no longer borrows the bordered `S.buttonOff` style.
  const caretAt = source.indexOf('var caretStyle = {')
  assert.ok(caretAt > 0)
  assert.ok(source.slice(caretAt, caretAt + 500).includes("border: 'none'"))
  // The ⚙ dialog says up front that it is optional, and names the tool jar.
  assert.match(source, /可选配置：不填也能看依赖类源码/)
  assert.match(source, /反编译工具 jar（可选）/)
})

test('a fast second F8 cannot resume twice, and a running thread never reports 取栈失败', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // One control call at a time; a resume flips the UI to "running" immediately.
  assert.match(source, /if \(controlBusyRef\.current\) return/)
  assert.match(source, /controlBusyRef\.current = true/)
  assert.match(source, /if \(action === 'resume'\) \{[\s\S]{0,400}?suspended: false, suspendedThreads: \[\], frames: \[\], variables: \[\]/)
  // A stack is only read when a thread is actually suspended …
  assert.match(source, /if \(suspended\) await loadThreads\(debugSuspendedThreadId\(result\)\)/)
  // … and a failed read for a running thread stays silent instead of toasting.
  assert.match(source, /if \(dbgRef\.current\.suspended !== true\) return\n\s*return note\('取栈失败：' \+ result\.error\)/)
  // A hung read cannot leave the editor on 读取中… forever (bounded by a timeout).
  assert.match(source, /controller\.abort\(\) \}, 15000\)/)
  // An already-resolved chunk is used on the first render of the next open file
  // (no "正在加载编辑器…" flash), and dependency resolution says what it is doing.
  assert.match(source, /var RIS_IDE_CHUNK_VALUES = \{\}/)
  assert.match(source, /RIS_IDE_CHUNK_VALUES\[name\] = value/)
  assert.match(source, /useState\(function \(\) \{ return RIS_IDE_CHUNK_VALUES\.codemirror \|\| null \}\)/)
  assert.match(source, /正在获取依赖源码：' \+ cleaned/)
})

test('the IDE fences off async exceptions instead of letting them blank the page', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A plugin handler must never surface as an unhandled rejection: the fence
  // shows a banner and (in our own window) swallows the event.
  assert.match(source, /function guardWindowErrors\(ownPage\)/)
  assert.match(source, /window\.__dshRisIdeErrorFence = true/)
  assert.match(source, /addEventListener\('unhandledrejection'/)
  assert.match(source, /addEventListener\('error'/)
  assert.match(source, /data-ide-error-bar/)
  assert.match(source, /guardWindowErrors\(true\)/)
  assert.match(source, /guardWindowErrors\(false\)/)
  // The debug poll rejects on a stopped program/network loss: it must be a hint.
  const pollAt = source.indexOf('async function pollOnce(path) {')
  assert.ok(pollAt > 0)
  const poll = source.slice(pollAt, pollAt + 1400)
  assert.match(poll, /catch \(problem\) \{/)
  assert.match(poll, /调试状态刷新失败/)
  assert.match(poll, /finally \{\n\s+busyRef\.current = false/)
  // Streamed debug/session frames are applied defensively too.
  assert.match(source, /void applyPollResult\(payload\)\.catch\(/)
  assert.match(source, /void applySessions\(payload\.sessions\)\.catch\(/)
})

test('a breakpoint belongs to the program that owns the file (never the selected log)', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // While project A was running, adding a breakpoint in project B used the
  // SELECTED program's debug session, so JDWP answered with a class-not-found
  // error. The gutter now resolves the owning program from the file path.
  assert.match(source, /function programForSourcePath\(path\) \{/)
  assert.match(source, /var dir = item\.dir/)
  assert.ok(source.includes("path.indexOf(dir + '/') === 0"))
  assert.match(source, /var owner = programForSourcePath\(openFile\)/)
  assert.match(source, /var breakPath = owner !== undefined/)
  assert.match(source, /call\('breakpoints', \{ add: \{ className: className, line: line \} \}, breakPath\)/)
  assert.match(source, /call\('breakpoints', \{ remove: \{ requestId: existing\.requestId, className: className, line: line \} \}, breakPath\)/)
})

test('following the debugger activates the file it stops in, even when already open', async () => {
  // Stepping into file B (opened as a tab), then hitting a breakpoint back in A:
  // A was already open, so openPath() was skipped and the editor stayed on B
  // while the highlight moved to A. followDebugLocation must activate the tab.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const at = source.indexOf('async function followDebugLocation(frame)')
  assert.ok(at !== -1)
  const body = source.slice(at, at + 3000)
  assert.match(body, /var alreadyOpen = openFiles\.indexOf\(path\) !== -1/)
  assert.match(body, /if \(alreadyOpen && openFile !== path\) setOpenFile\(path\)/)
})

test('a file the debugger opened on its own closes when the debug line leaves it', async () => {
  // Debug-owned tabs should not pile up while stepping: when the debug location
  // moves to another file, the previous debug-opened tab is closed — unless the
  // user edited it (dirty tabs are never thrown away) or opened it deliberately.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('var debugOpenedRef = useRef([])'))
  assert.ok(source.includes('var debugOpeningRef = useRef(false)'))
  const at = source.indexOf('function closeDebugOpenedExcept(currentPath)')
  assert.ok(at !== -1, 'the helper must exist')
  const body = source.slice(at, at + 1200)
  assert.match(body, /isDirty\(item\) === true/)
  assert.match(body, /setOpenFiles\(function \(previous\) \{/)
  assert.match(body, /victims\.forEach\(function \(item\) \{ forgetDoc\(item\) \}\)/)
  // followDebugLocation records ownership and closes the previous debug tab.
  const follow = source.indexOf('async function followDebugLocation(frame)')
  const followBody = source.slice(follow, follow + 3000)
  assert.match(followBody, /if \(debugOpenedRef\.current\.indexOf\(path\) === -1\) debugOpenedRef\.current = debugOpenedRef\.current\.concat\(\[path\]\)/)
  assert.match(followBody, /closeDebugOpenedExcept\(path\)/)
  assert.match(followBody, /debugOpeningRef\.current = true/)
})

test('every change of the suspended top frame moves the editor there', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A dedicated effect watches dbg.frames/top frame, so a stop that arrives through
  // ANY path (SSE event, poll, manual stack read, program auto-switch) is followed:
  // switch file, scroll the line into view, highlight it.
  assert.ok(source.includes("var followedFrameRef = useRef('')"))
  assert.ok(source.includes("followedFrameRef.current = String(frame.className || '') + ':' + line"))
  assert.ok(source.includes('}, [dbg.frames, dbg.suspended])'))
  assert.ok(source.includes('if (dbg.suspended !== true) {'))
  assert.ok(source.includes('followedFrameRef.current = \'\''))
  assert.ok(source.includes('void followDebugLocation(top)'))
})

test('progress goes to the status bar; toasts stay for things the user must know', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The static bottom help text moved into the ? panel.
  assert.ok(!source.includes('Ctrl+S 保存 · Ctrl+W 关页签 · 拖分隔条调大小 · 双击标题最大化'))
  assert.ok(!source.includes("' · F5 步入 · F6 单步 · F7 步出 · F8 继续'"))
  // A status channel exists and the dependency-source progress uses it (no toast).
  assert.ok(source.includes("var [statusText, setStatusText] = useState('')"))
  assert.ok(source.includes("statusNote('正在获取依赖源码：' + cleaned + '…', 0)"))
  assert.ok(source.includes("statusNote('正在启动 ' + program.name + '…', 0)"))
  assert.ok(!source.includes("note('正在获取依赖源码："))
  assert.ok(source.includes("'data-ide-status-text': statusText === '' ? '0' : '1'"))
})

test('while a debug session is attached, F5 cannot reload the window', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The state makes the key meaningless, not the handler: F5/F6/F7 still get
  // claimed (and swallowed) while the VM runs.
  assert.match(source, /if \(state\.suspended !== true\) return \{ kind: 'swallow' \}/)
  assert.match(source, /if \(action\.kind === 'swallow'\) return/)
})

test('only the standalone IDE window claims browser shortcuts; a DSH page keeps them', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The DSH page marks itself as NOT the IDE window; the standalone window marks itself.
  assert.ok(source.includes("if (typeof window !== 'undefined') window.__dshRisIdeWindow = false"))
  assert.ok(source.includes("if (typeof window !== 'undefined') window.__dshRisIdeWindow = true"))
  assert.ok(source.includes('function inStandaloneIdeWindow()'))
  // Ownership is the standalone window, FULL STOP: a DSH page never claims keys.
  assert.match(source, /function ownsKeyTarget\(target\) \{[\s\S]{0,500}?return inStandaloneIdeWindow\(\)/)
  assert.ok(!source.includes('if (inStandaloneIdeWindow()) return true'), 'no page-vs-panel split any more')
  // Ctrl+W, the find chord and the debug keys still check ownership first.
  const guards = source.split('if (!ownsKeyTarget(event.target)) return').length - 1
  assert.equal(guards, 3, 'Ctrl+W, the find chord and debug keys all bail out on foreign targets')
  // The panel net only works in the IDE window and only claims the reload chord:
  // the host's other chords (Ctrl+N/O/K/...) are released everywhere.
  assert.match(source, /if \(!inStandaloneIdeWindow\(\)\) return\n\s*if \(isBrowserReloadChord\(event\)\)/)
  assert.ok(!source.includes('shouldBlockHostChord({ key: event.key'), 'DSH chords are released; the helper stays for its own unit test')
  const previous = Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined
  try {
    globalThis.window = { __dshRisIdeWindow: true }
    assert.equal(T.inStandaloneIdeWindow(), true)
    globalThis.window = { __dshRisIdeWindow: false }
    assert.equal(T.inStandaloneIdeWindow(), false)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('Ctrl+F searches what the editor, log or fallback editor has highlighted', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(new URL('../src/chunks/codemirror.js', import.meta.url), 'utf8')
  const chunk = await readFile(new URL('../lib/client-codemirror.js', import.meta.url), 'utf8')

  // CodeMirror path: the highlighted text becomes the panel query before it opens.
  assert.match(chunkSource, /function searchSelectedText\(view\)/)
  assert.match(chunkSource, /setSearchQuery\.of\(new SearchQuery\(\{ search: picked, literal: true \}\)\)/)
  assert.match(chunk, /setSearchQuery\.of\(new SearchQuery\(\{/)
  assert.match(chunk, /literal: true/)
  assert.match(chunk, /search: picked/)
  const seeded = chunk.split('searchSelectedText(instance);').length - 1
  assert.ok(seeded >= 2, 'both the menu item and the Mod-f keymap seed the query from the selection')

  // Log viewer + plain-text fallback editor: their own find bars get the highlight.
  assert.match(source, /function selectedLineTextIn\(element\)/)
  assert.match(source, /var highlighted = selectedLineTextIn\(event\.currentTarget\)/)
  assert.match(source, /var highlighted = firstSelectedLine\(text\.slice\(findArea\.selectionStart, findArea\.selectionEnd\)\)/)
  // The workspace file search stays out of it: Ctrl+F never writes the tree query.
  const logStart = source.indexOf("'data-dsh-ris-ide': 'viewer'")
  assert.ok(logStart !== -1)
  const logHandler = source.slice(logStart, logStart + 1400)
  assert.doesNotMatch(logHandler, /setTreeQuery/)
})

test('an oversized text file opens a read-only windowed preview', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /function fsWindowRead\(scope, path, offset, length\)/)
  assert.match(source, /dsh-ris-ide\/fs\/window/)
  assert.match(source, /var LARGE_TEXT_WINDOW_BYTES = 256 \* 1024/)
  assert.match(source, /var LARGE_TEXT_MAX_BYTES = 16 \* 1024 \* 1024/)
  assert.match(source, /async function loadLargeTextPage\(path\)/)
  assert.match(source, /function LargeTextPreview\(props\)/)
  assert.match(source, /只读预览 · 大文件/)
  assert.match(source, /onLoadMore: function \(\) \{ void loadLargeTextPage\(path\) \}/)
  // Oversized reads no longer fall into the empty "文件过大" error state.
  assert.doesNotMatch(source, /code === 'binary' \|\| code === 'too-large'/)
  // The preview mounts no editor: there is nothing to edit or save.
  const branchStart = source.indexOf("} else if (doc.kind === 'large-text') {")
  assert.ok(branchStart !== -1)
  const branch = source.slice(branchStart, source.indexOf("} else if (doc.kind === 'error') {", branchStart))
  assert.doesNotMatch(branch, /IdeTextEditor/)
  // Above the cap the FRONT is freed and the reader keeps going.
  assert.match(source, /function trimLargeTextFront\(text, maxBytes\)/)
  assert.match(source, /var trimmed = trimLargeTextFront\(loaded, LARGE_TEXT_MAX_BYTES\)/)
  assert.match(source, /dropLines: \(typeof current\.dropLines === 'number' \? current\.dropLines : 0\) \+ trimmed\.droppedLines/)
  assert.match(source, /function reloadLargeTextFromStart\(path\)/)
  assert.match(source, /'data-large-text-restart': '1'/)
  assert.match(source, /已释放前面 ' \+ dropLines \+ ' 行/)
})

test('trimLargeTextFront frees whole lines and keeps the line count aligned', () => {
  const text = Array.from({ length: 200 }, (_, index) => 'line ' + index).join('\n')
  const totalLines = text.split('\n').length
  const trimmed = T.trimLargeTextFront(text, 100)
  assert.ok(trimmed.text.length <= 100, 'kept tail stays under the cap')
  assert.ok(trimmed.droppedLines > 0, 'something was freed')
  assert.ok(trimmed.text.startsWith('line '), 'the tail starts at a line boundary, not mid-line')
  assert.equal(trimmed.text.split('\n').length + trimmed.droppedLines, totalLines, 'freed lines + kept lines cover the file')
  assert.deepEqual(T.trimLargeTextFront('short', 100), { text: 'short', droppedLines: 0, droppedChars: 0 })
  assert.deepEqual(T.trimLargeTextFront('', 100), { text: '', droppedLines: 0, droppedChars: 0 })
})

test('the editor scrollbars are visible and a start re-reads its log', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // BUG3: the host theme paints a 5px near-invisible scrollbar; the panel gives
  // the editor/log/tree real bars without reserving a gutter on short files.
  assert.match(source, /var SCROLLBAR_CSS = /)
  assert.match(source, /::-webkit-scrollbar\{width:10px;height:10px\}/)
  assert.match(source, /::-webkit-scrollbar-thumb/)
  assert.match(source, /SELECTION_CSS \+ SCROLLBAR_CSS \+ TOAST_CSS/, 'injected with the panel styles')
  assert.doesNotMatch(source, /SCROLLBAR_CSS[\s\S]{0,800}?scrollbar-gutter/, 'no empty gutter on files that do not overflow')
  // BUG6: a start records a size baseline and watches for its first new byte …
  assert.match(source, /async function consoleStart\(program\) \{[\s\S]{0,700}?await logSizeOf\(logPath\)/, 'the start records a size baseline')
  assert.match(source, /async function consoleStart\(program\) \{[\s\S]{0,2400}?watchLogOutput\(logPath, baseline\)/, 'and watches the first new byte')
  // … a pane mounting on an already-open socket reads its tail once …
  assert.match(source, /if \(typeof EventSource !== 'function'\) return\n\s*void refresh\(\)/, 'first paint reads the tail')
  // … and the shared socket reports which file it follows, so a second log pane
  // polls instead of waiting on someone else's stream.
  assert.match(source, /var servedTail = ''/, 'the connection remembers its tail path')
  assert.match(source, /notifyOpen\(\)/)
  assert.match(source, /setStreamOk\(served === '' \|\| served === path\)/, 'a pane the socket does not carry falls back to polling')
  assert.match(source, /setCompactLogNonce\(function \(value\) \{ return value \+ 1 \}\)/, 'the sidebar pane re-reads after start/stop')
  // … and the host never drops a delta without re-snapshotting.
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(host, /if \(text !== '' && send\('append', \{ ok: true, text \}\) === false\) \{[\s\S]{0,200}?await snapshot\(\)/, 'a dropped frame re-snapshots')
})
