/**
 * The IDE's editor chunk: CodeMirror 6 + Java syntax, breakpoint gutter, debug
 * line highlight and the find/replace panel. Built by `tsdown` into
 * `lib/client-codemirror.js` and fetched by the core client on first use, so the
 * core bundle carries no editor vocabulary (and no builder is needed for it).
 *
 * The chunk is a plain DOM component: no React, no `require` from the loader —
 * `mount(parent, init)` returns a small imperative handle and every later change
 * goes through one of its setters.
 */
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration, EditorView, GutterMarker, ViewPlugin, drawSelection, gutter, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view'
import {
  defaultKeymap, deleteLine, history, historyKeymap, indentLess, indentMore, indentWithTab,
  insertBlankLine, moveLineDown, moveLineUp, redo, selectAll, toggleComment, undo,
} from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { vue } from '@codemirror/lang-vue'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, gotoLine, highlightSelectionMatches, openSearchPanel, replaceAll, replaceNext, search, searchKeymap, SearchQuery, setSearchQuery } from '@codemirror/search'
import { tags } from '@lezer/highlight'

/**
 * Opens the search panel seeded with the selected text.
 *
 * Ctrl+F in every mainstream editor searches for what is selected; the panel's
 * query lives in state (`setSearchQuery`), so dispatching it before opening is
 * enough. A multi-line selection is narrowed to its first non-empty line — the
 * panel's input is single-line and would otherwise search for an impossible
 * string. Regex metacharacters are taken literally (`literal: true`) because
 * the query comes from the user's selection, not from a regex they typed.
 */
function searchSelectedText(view) {
  const selection = view.state.selection.main
  if (selection.empty) return false
  const picked = view.state
    .sliceDoc(selection.from, selection.to)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (picked === undefined || picked === '') return false
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: picked, literal: true })) })
  return true
}

/**
 * Selects the FIRST match of the current query, searching from the top of the
 * file instead of from wherever the caret happens to be.
 *
 * Typing in the find box and the seeded (automatic) searches are both "find me
 * this text" actions: the user wants the first occurrence in the file, which is
 * also what a fresh Ctrl+F would show. The next/previous buttons keep their
 * relative behaviour — only the automatic paths reset to the document start.
 * @param {object} view - the `EditorView`.
 */
function findFirstFromStart(view) {
  view.dispatch({ selection: { anchor: 0 } })
  findNext(view)
}

/**
 * Opens the find panel seeded with `text` and jumps to the first match at/after
 * `line` — the workspace content search hands a hit over this way, so the editor
 * shows the same "content find" a Ctrl+F would, with the query already filled in.
 *
 * `line` (1-based) is optional: when the hit's line is known the caret starts
 * there first, so the next match is the one the user clicked instead of the
 * document's first occurrence. Literal (`literal: true`) because the query is
 * workspace text, not a regex.
 * @param {object} view - the `EditorView`.
 * @param {string} text - query to put in the panel.
 * @param {number} [line] - 1-based line the hit was on.
 */
function searchForText(view, text, line) {
  if (typeof text !== 'string' || text === '') return false
  if (typeof line === 'number' && Number.isFinite(line) && line > 0) {
    const target = view.state.doc.line(Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines))
    view.dispatch({ selection: { anchor: Math.max(0, target.from - 1) } })
  } else {
    // No hit line to honour: an automatic search starts from the file's top so the
    // first occurrence wins, not the next one after a caret parked deep in the file.
    view.dispatch({ selection: { anchor: 0 } })
  }
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text, literal: true })) })
  openSearchPanel(view)
  findNext(view)
  return true
}

/**
 * Marks the editor while the document has a non-empty selection.
 *
 * The active-line tint is drawn on the line itself; a multi-line selection lies
 * under several of those lines, so the current-line colour used to override the
 * selection colour on the active line. With this class the panel turns the tint
 * off while a selection exists (CSS lives in the core client).
 */
const selectionFlag = ViewPlugin.fromClass(class {
  constructor(view) {
    this.apply(view)
  }

  update(update) {
    if (update.selectionSet || update.docChanged) this.apply(update.view)
  }

  apply(view) {
    const selected = view.state.selection.ranges.some((range) => range.from !== range.to)
    view.dom.classList.toggle('dsh-ris-ide-has-selection', selected)
  }
})

/** Extension → a CodeMirror language support, so one editor serves many files. */
const LANGUAGE_BY_EXT = {
  java: () => java(),
  kt: () => java(),
  vue: () => vue(),
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  xml: () => xml(),
  html: () => html(),
  htm: () => html(),
  svg: () => xml(),
  yml: () => yaml(),
  yaml: () => yaml(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  sql: () => sql(),
  md: () => markdown(),
}

/**
 * Language support for one path ('' = plain text).
 * @param {string} path - absolute or workspace-relative file path.
 * @returns {object|null} the CodeMirror extension, or null for plain text.
 */
function languageForPath(path) {
  const name = String(path === undefined || path === null ? '' : path)
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const factory = LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()]
  return factory === undefined ? null : factory()
}

/** Breakpoint lines the gutter should draw (module-level so the marker builder is cheap). */
let breakpointLines = new Set()

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'dsh-ris-ide-bp'
    dot.textContent = '●'
    return dot
  }
}

const breakpointMarker = new BreakpointMarker()

/** One line's marker: a dot on a breakpoint line, nothing otherwise. */
function breakpointMarkers(view) {
  const builder = new RangeSetBuilder()
  // RangeSetBuilder insists on ascending positions: the breakpoints arrive in
  // the order they were clicked (or as the debugger lists them), so sort before
  // building — an unsorted add throws and takes the WHOLE gutter row (line
  // numbers included) off screen.
  for (const line of [...breakpointLines].sort((left, right) => left - right)) {
    if (line < 1 || line > view.state.doc.lines) continue
    builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, breakpointMarker)
  }
  return builder.finish()
}

/**
 * Breakpoint gestures shared by both gutters (the dot column and the line
 * numbers): a single click on an UNMARKED line adds a breakpoint; a
 * double-click on a MARKED line removes it. A single click on an already
 * marked line does nothing, so the two mousedowns of a double-click cannot
 * remove-then-re-add before `dblclick` arrives.
 *
 * @param {object} options - the mount options carrying `onToggleBreakpoint`.
 * @param {'single'|'double'|'toggle'} gesture - which gesture this is.
 */
function breakpointGesture(options, gesture) {
  return (viewInstance, line) => {
    const number = viewInstance.state.doc.lineAt(line.from).number
    if (typeof options.onToggleBreakpoint !== 'function') return false
    const marked = breakpointLines.has(number)
    if (gesture === 'single' && marked) return true
    if (gesture === 'double' && !marked) return true
    options.onToggleBreakpoint(number)
    return true
  }
}

/** Set the highlighted debug line (the IDE follows the suspended frame with it). */
const setDebugLineEffect = StateEffect.define()

/**
 * Highlight a suspended line, and scroll it into the middle of the viewport when
 * it is NOT already visible.
 *
 * Stepping through a method normally keeps the line on screen, and jumping the
 * scroll for every step would be jarring; a frame that is far away (a caller, a
 * new file) must come into view though. `scrollIntoView` with `y: 'center'` is
 * only dispatched in the off-screen case.
 *
 * @param {import('@codemirror/view').EditorView} view - editor state.
 * @param {number|null|undefined} line - 1-based source line.
 */
function applyDebugLine(view, line) {
  const total = view.state.doc.lines
  const target = line === null || line === undefined ? null : Number(line)
  if (target === null || !Number.isFinite(target) || target < 1 || target > total) {
    view.dispatch({ effects: setDebugLineEffect.of(null) })
    return
  }
  const pos = view.state.doc.line(target).from
  const viewport = view.viewport
  const visible = target >= viewport.fromLine && target <= viewport.toLine
  const effects = [setDebugLineEffect.of(target)]
  if (!visible) effects.push(EditorView.scrollIntoView(pos, { y: 'center' }))
  view.dispatch({ effects })
}

const debugLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDebugLineEffect)) continue
      const line = effect.value
      if (line === null || line < 1 || line > transaction.state.doc.lines) return Decoration.none
      const from = transaction.state.doc.line(line).from
      return Decoration.set([Decoration.line({ class: 'dsh-ris-ide-debug-line' }).range(from)])
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Java token colours; the same palette in both themes keeps the page's own look. */
function highlightStyle() {
  return HighlightStyle.define([
    { tag: tags.keyword, color: '#c678dd' },
    { tag: [tags.typeName, tags.className], color: '#e5c07b' },
    { tag: [tags.string, tags.special(tags.string)], color: '#98c379' },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#7f848e', fontStyle: 'italic' },
    { tag: [tags.number, tags.bool, tags.null], color: '#d19a66' },
    { tag: tags.annotation, color: '#d19a66' },
    { tag: tags.operator, color: '#56b6c2' },
    { tag: [tags.function(tags.variableName), tags.propertyName], color: '#61afef' },
    { tag: tags.definition(tags.variableName), color: '#e06c75' },
    { tag: tags.invalid, color: '#e06c75', textDecoration: 'underline' },
  ])
}

/** The editor surface, tuned to the IDE's compact panes. */
function surfaceTheme(fontSize) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: fontSize + 'px', backgroundColor: 'transparent' },
    '.cm-scroller': { fontFamily: 'var(--dsh-ris-ide-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.45' },
    '.cm-content': { padding: '2px 0' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 2px', opacity: 0.55 },
    '.cm-bp-gutter': { width: '14px', cursor: 'pointer' },
    '.dsh-ris-ide-bp': { color: '#e5534b', fontSize: '11px', lineHeight: '1' },
    '.dsh-ris-ide-debug-line': { backgroundColor: 'rgba(210, 153, 34, 0.22)' },
    '&.cm-focused': { outline: 'none' },
    // The selected range must read stronger than the other matches: teal for the
    // selection, amber for `highlightSelectionMatches`.
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(86, 182, 194, 0.50)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(86, 182, 194, 0.42)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(210, 153, 34, 0.30)' },
    '.cm-selectionMatch-main': { backgroundColor: 'rgba(210, 153, 34, 0.45)' },
  })
}

/**
 * The editor's right-click menu: the operations people reach for while writing
 * code. Each item is plain data so the React host draws it with the panel's own
 * menu styling (one menu system, one theme).
 * @param {EditorView} view - the live editor view.
 * @param {object} options - the mount options (`onSave`).
 * @returns {Array<{label: string, shortcut?: string, disabled?: boolean, separator?: boolean, run?: Function}>} items.
 */
function editorMenuItems(view, options) {
  const selection = view.state.selection.main
  const hasSelection = selection.from !== selection.to
  const readOnly = view.state.readOnly
  const run = (command) => () => {
    command(view)
    view.focus()
  }
  const clipboardCopy = () => {
    const text = view.state.sliceDoc(selection.from, selection.to)
    if (text !== '') void navigator.clipboard.writeText(text)
    view.focus()
  }
  const clipboardCut = () => {
    const text = view.state.sliceDoc(selection.from, selection.to)
    if (text !== '') void navigator.clipboard.writeText(text)
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert: '' } })
    view.focus()
  }
  const clipboardPaste = () => {
    void navigator.clipboard.readText().then((text) => {
      if (typeof text === 'string' && text !== '') view.dispatch(view.state.replaceSelection(text))
      view.focus()
    })
  }
  return [
    { label: '撤销', shortcut: 'Ctrl+Z', disabled: readOnly, run: run(undo) },
    { label: '重做', shortcut: 'Ctrl+Shift+Z', disabled: readOnly, run: run(redo) },
    { separator: true },
    { label: '剪切', shortcut: 'Ctrl+X', disabled: readOnly || !hasSelection, run: clipboardCut },
    { label: '复制', shortcut: 'Ctrl+C', disabled: !hasSelection, run: clipboardCopy },
    { label: '粘贴', shortcut: 'Ctrl+V', disabled: readOnly, run: clipboardPaste },
    { separator: true },
    { label: '全选', shortcut: 'Ctrl+A', run: run(selectAll) },
    { label: '注释/取消注释', shortcut: 'Ctrl+/', disabled: readOnly, run: run(toggleComment) },
    { label: '增加缩进', shortcut: 'Tab', disabled: readOnly, run: run(indentMore) },
    { label: '减少缩进', shortcut: 'Shift+Tab', disabled: readOnly, run: run(indentLess) },
    { separator: true },
    { label: '删除当前行', shortcut: 'Ctrl+D / Ctrl+Shift+K', disabled: readOnly, run: run(deleteLine) },
    { label: '在上方插入行', shortcut: 'Ctrl+Enter', disabled: readOnly, run: run(insertBlankLine) },
    { label: '上移当前行', shortcut: 'Alt+↑', disabled: readOnly, run: run(moveLineUp) },
    { label: '下移当前行', shortcut: 'Alt+↓', disabled: readOnly, run: run(moveLineDown) },
    { separator: true },
    { label: '查找 / 替换', shortcut: 'Ctrl+F', run: run((instance) => { const seeded = searchSelectedText(instance); openSearchPanel(instance); if (seeded) findFirstFromStart(instance) }) },
    { label: '转到行', shortcut: 'Ctrl+G', run: run((instance) => { gotoLine(instance) }) },
    { separator: true },
    {
      label: '保存',
      shortcut: 'Ctrl+S',
      disabled: readOnly,
      run: () => {
        if (typeof options.onSave === 'function') options.onSave()
        view.focus()
      },
    },
  ]
}


/**
 * The IDE's own find/replace panel: two rows (find, then replace), both inputs
 * sharing one grid column so they are the same width, and icon-only buttons that
 * line up with each other. CodeMirror's built-in panel puts everything on one
 * row with text labels; in a narrow embedded editor that wraps and reads nothing
 * like the rest of the plugin chrome.
 *
 * Wired through `search({createPanel})`, so it is still CodeMirror's own panel:
 * `findNext`/`replaceAll`, the query state and the key bindings keep working —
 * only the painting changes. The grid itself lives in `SEARCH_PANEL_CSS`
 * (`lib/client.js`), next to the other injected editor styles.
 * @param {object} view - the `EditorView` the panel belongs to.
 */
function ideFindPanel(view) {
  const dom = document.createElement('div')
  dom.className = 'cm-search dsh-find-panel'
  dom.setAttribute('data-ide-find', '1')

  const makeInput = (name, placeholder) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.name = name
    input.placeholder = placeholder
    input.setAttribute('aria-label', placeholder)
    input.autocomplete = 'off'
    input.spellcheck = false
    dom.append(input)
    return input
  }
  const makeButton = (action, label, title) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-find-action', action)
    button.title = title
    button.textContent = label
    dom.append(button)
    return button
  }

  /** Puts the caret in the find field with its text selected (replace = type). */
  const focusInput = () => {
    searchInput.focus()
    searchInput.select()
  }

  const searchInput = makeInput('search', '查找')
  const previousButton = makeButton('previous', '\u2191', '\u4e0a\u4e00\u4e2a\u5339\u914d\uff08Shift+Enter\uff09')
  const nextButton = makeButton('next', '\u2193', '\u4e0b\u4e00\u4e2a\u5339\u914d\uff08Enter\uff09')
  const caseButton = makeButton('case', 'Aa', '\u533a\u5206\u5927\u5c0f\u5199')
  const regexpButton = makeButton('regexp', '.*', '\u6b63\u5219\u8868\u8fbe\u5f0f')
  const wordButton = makeButton('word', 'ab', '\u5168\u8bcd\u5339\u914d')
  const closeButton = makeButton('close', '\u2715', '\u5173\u95ed\uff08Esc\uff09')
  const replaceInput = makeInput('replace', '\u66ff\u6362\u4e3a')
  const replaceButton = makeButton('replace', '\u21e5', '\u66ff\u6362\uff08Enter\uff09')
  const replaceAllButton = makeButton('replace-all', '\u21e5\u21e5', '\u5168\u90e8\u66ff\u6362\uff08Shift+Enter\uff09')
  // Two-row grid (see SEARCH_PANEL_CSS): row one ends with [ab][×] in columns
  // 6/7, so the replace buttons pin to those columns and the rows line up.
  replaceButton.style.gridRow = '2'
  replaceButton.style.gridColumn = '6'
  replaceAllButton.style.gridRow = '2'
  replaceAllButton.style.gridColumn = '7'
  const countLabel = document.createElement('span')
  countLabel.className = 'dsh-find-count'
  countLabel.setAttribute('data-find-count', '1')
  dom.append(countLabel)

  // `getSearchQuery` takes the editor STATE (`setSearchQuery` is the effect, not a
  // commit function) — passing the view here was the first bug the panel had.
  const currentQuery = () => getSearchQuery(view.state)

  /**
   * Pushes one field of the query into the editor state. `jump` also selects the
   * next match, which is what typing in the find box should do; the replace box
   * commits without jumping so editing it never scrolls the document.
   */
  const apply = (patch, jump) => {
    const current = currentQuery()
    const next = new SearchQuery({
      search: patch.search !== undefined ? patch.search : current.search,
      caseSensitive: patch.caseSensitive !== undefined ? patch.caseSensitive : current.caseSensitive,
      regexp: patch.regexp !== undefined ? patch.regexp : current.regexp,
      wholeWord: patch.wholeWord !== undefined ? patch.wholeWord : current.wholeWord,
      replace: patch.replace !== undefined ? patch.replace : current.replace,
    })
    // `setSearchQuery` is a StateEffect, so committing means dispatching it — the
    // change test keeps typing cheap and avoids a redundant jump on every keystroke.
    const changed = next.search !== current.search
      || next.replace !== current.replace
      || next.caseSensitive !== current.caseSensitive
      || next.regexp !== current.regexp
      || next.wholeWord !== current.wholeWord
    if (changed) {
      view.dispatch({ effects: setSearchQuery.of(next) })
      if (jump) findFirstFromStart(view)
      sync()
    }
    return changed
  }

  /** Total matches of the current query, capped so a pathological regex stays cheap. */
  const countMatches = () => {
    const query = currentQuery()
    if (typeof query.search !== 'string' || query.search === '') return 0
    let total = 0
    try {
      const cursor = query.getCursor(view.state)
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        total += 1
        if (total > 9999) break
      }
    } catch (error) {
      return -1
    }
    return total
  }

  /** Mirrors state → panel. Never moves the caret inside a focused input. */
  const sync = () => {
    const query = currentQuery()
    if (document.activeElement !== searchInput && searchInput.value !== query.search) searchInput.value = query.search
    if (document.activeElement !== replaceInput && replaceInput.value !== query.replace) replaceInput.value = query.replace
    caseButton.setAttribute('aria-pressed', query.caseSensitive ? 'true' : 'false')
    regexpButton.setAttribute('aria-pressed', query.regexp ? 'true' : 'false')
    wordButton.setAttribute('aria-pressed', query.wholeWord ? 'true' : 'false')
    const total = countMatches()
    countLabel.textContent = query.search === '' ? '' : total < 0 ? '\u6b63\u5219\u65e0\u6548' : total + ' \u4e2a'
  }

  const close = () => closeSearchPanel(view)

  searchInput.addEventListener('input', () => { apply({ search: searchInput.value }, true) })
  replaceInput.addEventListener('input', () => { apply({ replace: replaceInput.value }, false) })
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPrevious(view)
      else findNext(view)
      sync()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) replaceAll(view)
      else replaceNext(view)
      sync()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  dom.addEventListener('click', (event) => {
    const target = event.target
    const button = target !== null && target !== undefined && typeof target.closest === 'function'
      ? target.closest('[data-find-action]')
      : null
    if (button === null) return
    const action = button.getAttribute('data-find-action')
    const query = currentQuery()
    if (action === 'previous') findPrevious(view)
    else if (action === 'next') findNext(view)
    else if (action === 'case') apply({ caseSensitive: !query.caseSensitive }, true)
    else if (action === 'regexp') apply({ regexp: !query.regexp }, true)
    else if (action === 'word') apply({ wholeWord: !query.wholeWord }, true)
    else if (action === 'close') { close(); return }
    else if (action === 'replace') replaceNext(view)
    else if (action === 'replace-all') replaceAll(view)
    sync()
    if (action === 'replace' || action === 'replace-all') replaceInput.focus()
    else searchInput.focus()
  })

  return {
    dom,
    // Feeds CodeMirror's panel group: `top` puts the panel above the text, which
    // is where the default search panel lives and where the IDE expects it.
    top: true,
    mount() {
      sync()
      focusInput()
      // CodeMirror keeps the editor focused while it handles the keydown that
      // opened the panel, so the focus set here is bounced back to `.cm-content`
      // right after. One task later only that bounce is undone — a click into
      // another field in between must win.
      setTimeout(() => {
        const active = view.root.activeElement
        if (active === view.contentDOM || active === null) focusInput()
      }, 0)
    },
    update(update) {
      if (update.docChanged || update.selectionSet) sync()
    },
  }
}

/**
 * Mount CodeMirror into one element.
 * @param {HTMLElement} parent - the host element (the React component owns it).
 * @param {object} init - `{doc, readOnly, fontSize, dark, breakpoints, debugLine, onChange, onSave, onToggleBreakpoint}`.
 * @returns {object} imperative handle.
 */
export function mount(parent, init) {
  const options = init || {}
  breakpointLines = new Set(Array.isArray(options.breakpoints) ? options.breakpoints : [])
  const themeCompartment = new Compartment()
  const readOnlyCompartment = new Compartment()
  const languageCompartment = new Compartment()
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: typeof options.doc === 'string' ? options.doc : '',
      extensions: [
        // Both the line numbers and the dot column toggle breakpoints; the dot
        // column is the narrower marker, the numbers are the big click target.
        lineNumbers({
          domEventHandlers: {
            mousedown(viewInstance, line, event) {
              if (event.button !== 0) return false
              event.preventDefault()
              return breakpointGesture(options, 'single')(viewInstance, line)
            },
            dblclick(viewInstance, line) {
              return breakpointGesture(options, 'double')(viewInstance, line)
            },
          },
        }),
        gutter({
          class: 'cm-bp-gutter',
          markers: breakpointMarkers,
          domEventHandlers: {
            mousedown(viewInstance, line, event) {
              if (event.button !== 0) return false
              event.preventDefault()
              return breakpointGesture(options, 'single')(viewInstance, line)
            },
            dblclick(viewInstance, line) {
              return breakpointGesture(options, 'double')(viewInstance, line)
            },
            contextmenu(viewInstance, line, event) {
              event.preventDefault()
              return breakpointGesture(options, 'toggle')(viewInstance, line)
            },
          },
        }),
        history(),
        drawSelection(),
        selectionFlag,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        indentUnit.of('    '),
        // A Compartment must hold an Extension: plain-text files have no language
        // support, and `null` here crashes EditorState.create ("reading 'extension'").
        languageCompartment.of(languageForPath(options.path) || []),
        syntaxHighlighting(highlightStyle()),
        // The IDE's own two-row find/replace panel (see `ideFindPanel`).
        search({ top: true, createPanel: ideFindPanel }),
        highlightSelectionMatches(),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run() {
              if (typeof options.onSave === 'function') options.onSave()
              return true
            },
          },
          { key: 'Mod-/', preventDefault: true, run: toggleComment },
          { key: 'Mod-g', preventDefault: true, run: (instance) => { gotoLine(instance); return true } },
          { key: 'Mod-f', preventDefault: true, run: (instance) => { const seeded = searchSelectedText(instance); openSearchPanel(instance); if (seeded) findFirstFromStart(instance); return true } },
          // Ctrl/Cmd+D deletes the current line (VS Code muscle memory). The
          // browser's own Ctrl+D (add bookmark) is pre-empted by preventDefault;
          // Mod-Shift+K stays as the second binding so old habits keep working.
          { key: 'Mod-d', preventDefault: true, run: deleteLine },
          { key: 'Mod-Shift-k', preventDefault: true, run: deleteLine },
          { key: 'Alt-ArrowUp', run: moveLineUp },
          { key: 'Alt-ArrowDown', run: moveLineDown },
          { key: 'Mod-Enter', run: insertBlankLine },
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        debugLineField,
        readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly === true)),
        themeCompartment.of(surfaceTheme(Number(options.fontSize) || 12.5)),
        EditorView.domEventHandlers({
          contextmenu(event, instance) {
            if (typeof options.onContextMenu !== 'function') return false
            event.preventDefault()
            event.stopPropagation()
            options.onContextMenu({ x: event.clientX, y: event.clientY, items: editorMenuItems(instance, options) })
            return true
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (typeof options.onChange === 'function') options.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })
  if (options.debugLine !== undefined && options.debugLine !== null) {
    applyDebugLine(view, options.debugLine)
  }
  return {
    focus() { view.focus() },
    /**
     * Workspace content-search hand-off: open the find panel on `text` and jump
     * to the hit on `line` (1-based, optional).
     * @param {string} text - the searched text.
     * @param {number} [line] - the hit's line number.
     */
    searchFor(text, line) {
      searchForText(view, text, line)
      view.focus()
    },
    getValue() { return view.state.doc.toString() },
    /** Replace the whole document without reporting it as a user edit. */
    setDoc(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: typeof text === 'string' ? text : '' } })
    },
    setBreakpoints(lines) {
      breakpointLines = new Set(Array.isArray(lines) ? lines : [])
      // Re-run the gutter's markers callback by touching the document selection.
      view.dispatch({ selection: view.state.selection })
    },
    setDebugLine(line) {
      applyDebugLine(view, line)
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly === true)) })
    },
    /** Swap the language support (the caller changes files inside one tab). */
    setLanguage(path) {
      view.dispatch({ effects: languageCompartment.reconfigure(languageForPath(path) || []) })
    },
    setFontSize(fontSize) {
      view.dispatch({ effects: themeCompartment.reconfigure(surfaceTheme(Number(fontSize) || 12.5)) })
    },
    destroy() { view.destroy() },
  }
}
