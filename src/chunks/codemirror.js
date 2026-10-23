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
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap, SearchQuery, setSearchQuery } from '@codemirror/search'
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
    { label: '删除当前行', shortcut: 'Ctrl+Shift+K', disabled: readOnly, run: run(deleteLine) },
    { label: '在上方插入行', shortcut: 'Ctrl+Enter', disabled: readOnly, run: run(insertBlankLine) },
    { label: '上移当前行', shortcut: 'Alt+↑', disabled: readOnly, run: run(moveLineUp) },
    { label: '下移当前行', shortcut: 'Alt+↓', disabled: readOnly, run: run(moveLineDown) },
    { separator: true },
    { label: '查找 / 替换', shortcut: 'Ctrl+F', run: run((instance) => { searchSelectedText(instance); openSearchPanel(instance) }) },
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
        search({ top: true }),
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
          { key: 'Mod-f', preventDefault: true, run: (instance) => { searchSelectedText(instance); openSearchPanel(instance); return true } },
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
