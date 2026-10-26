/**
 * dsh-ris-ide — browser half.
 *
 * A self-contained IDE panel registered as a tab in DSH's OFFICIAL right Sidebar
 * (`ctx.sidebarRightTabs` + the `sidebar.right.pane.tab` slot). It does not need
 * any other plugin: file reads/writes come from this plugin's own host routes
 * (`/dsh-ris-ide/fs/*`), the tree/search from `/dsh-ris-ide/tree|search`, live
 * data from `/dsh-ris-ide/stream` (SSE), and the editor is a lazily-built
 * CodeMirror chunk (`/dsh-ris-ide/bundle?name=codemirror`).
 *
 * The panel: a project console (start/stop/debug/select), a file tree, source
 * tabs, a debug pane (breakpoints/threads/stack/variables/events) and the live
 * log of the selected program.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ris-ide',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    /** Viewer identity kept for the `.log` descriptor shape (no longer registered). */
    var VIEWER_ID = 'dsh-ris-ide:log'
    /** DSH right-Sidebar registration id (the body/title slot key). */
    var IDE_TAB_ID = 'dsh-ris-ide'
    /** The tab-kind discriminator `sidebarRight.openTab(kind)` names. */
    var IDE_TAB_KIND = 'dsh-ris-ide:ide'
    /** Legacy ids kept so external tools/older docs still resolve. */
    var INSTANCES_TAB_ID = IDE_TAB_KIND
    var PROGRAM_TAB_ID = IDE_TAB_KIND
    /**
     * The client context, captured by `apply`. The panel is a module-scope
     * component (React must see a stable function identity), so its click handler
     * cannot reach the `ctx` parameter of `apply` directly — this is that bridge.
     */
    var panelCtx = null
    /** Program the RIS-IDE tab should switch to on its next render (set by agent/opens). */
    var pendingProgram = null

    /**
     * Last-resort page fence for the IDE UI: an async bug in one of our handlers
     * (a fetch rejecting after the program stopped, a poll landing on a removed
     * frame) must degrade to a readable banner, not an unhandled rejection that
     * leaves the window blank. In the standalone window we also swallow the event
     * (dsh's own page keeps its own reporting; there we only surface a banner).
     * @param {boolean} ownPage - true inside the standalone RIS-IDE window.
     */
    function guardWindowErrors(ownPage) {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
      if (window.__dshRisIdeErrorFence === true) return
      window.__dshRisIdeErrorFence = true
      window.__dshRisIdeOwnPage = ownPage === true
      var bar = null
      function show(message) {
        try {
          if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
          if (bar === null || bar.isConnected !== true) {
            bar = document.createElement('div')
            bar.setAttribute('data-ide-error-bar', '1')
            bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:6px;background:#3a1d1d;color:#ffd9d9;font:12px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:pre-wrap;word-break:break-word'
            var text = document.createElement('div')
            text.style.flex = '1 1 auto'
            bar.appendChild(text)
            var close = document.createElement('button')
            close.type = 'button'
            close.textContent = '✕'
            close.style.cssText = 'border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 2px'
            close.addEventListener('click', function () {
              if (bar !== null) {
                bar.remove()
                bar = null
              }
            })
            bar.appendChild(close)
            bar.__text = text
            document.body.appendChild(bar)
          }
          bar.__text.textContent = String(message).split('\n').slice(0, 6).join('\n')
        } catch {
          // The fence itself must never throw.
        }
      }
      window.addEventListener('unhandledrejection', function (event) {
        console.error('[dsh-ris-ide] unhandled rejection', event.reason)
        show('后台任务出错（已拦截，界面可继续使用）：\n' + messageOf(event.reason))
        if (window.__dshRisIdeOwnPage === true) event.preventDefault()
      })
      window.addEventListener('error', function (event) {
        var error = event.error !== undefined ? event.error : event.message
        if (error === undefined || error === null || error === '') return
        console.error('[dsh-ris-ide] uncaught error', error)
        show('界面出错（已拦截，可继续操作）：\n' + messageOf(error))
        if (window.__dshRisIdeOwnPage === true) event.preventDefault()
      })
    }

    /**
     * Whether this page IS the standalone RIS-IDE window (the whole body belongs to
     * the IDE). There, browser shortcuts are claimed page-wide; in the DSH page the
     * panel must only claim keys whose event target is inside the IDE.
     * @returns {boolean} true inside the standalone window.
     */
    function inStandaloneIdeWindow() {
      return typeof window !== 'undefined' && window.__dshRisIdeWindow === true
    }

    /** Point the RIS-IDE tab at one program (consumed by the panel). */
    function selectProgram(program) {
      pendingProgram = program === null || program === undefined ? null : program
    }
    /**
     * Debug poll cadence: fast while a JDWP session is attached (a breakpoint can
     * fire at any moment), slow while there is nothing to poll — an OPEN debug tab
     * with no session used to hammer `/debug/poll` 1.4 times a second forever.
     * @param {boolean} attached - whether a session is attached.
     * @returns {number} delay in ms.
     */
    function debugPollDelay(attached) {
      return attached === true ? 700 : 5000
    }

    /** Poll cadence while the tab is visible. */
    var POLL_MS = 1000
    /** Panel poll cadence: discovery is cached on the host, so each tick is pidfile reads. */
    var PANEL_POLL_MS = 3000
    /** Tail window per poll (host route hard-caps a single response at 512 KiB). */
    var TAIL_BYTES = 64 * 1024
    /** Hard cap on the streamed log text kept in memory (one long session). */
    var STREAM_MAX_CHARS = 256 * 1024
    /** How often the page drains pending "open this log" requests from the host. */
    var OPEN_POLL_MS = 2500

    /**
     * Resolve one host route against the page's own directory. Leading slashes
     * are stripped on purpose: a prefix-less path is what keeps a reverse-proxy
     * directory (and the shell's custom scheme) working.
     * @param {string} path - route, with or without a leading slash.
     * @returns {URL} the absolute request URL.
     */
    /** Where the last successful host answer said the workspace is. */
    var WORKSPACE_CWD_KEY = 'dsh-ris-ide:last-cwd'

    /**
     * Remember the workspace directory of the last successful host answer.
     * The right-sidebar tab outlives session switches (`keepMounted`), so its
     * `sessionId` can go stale and the host then answers every route with 400.
     * The host accepts an absolute `cwd` from the client, which is enough to keep
     * the panel working across a session switch or a `dsh web` restart.
     * @param {string} value - absolute workspace path.
     */
    function rememberWorkspaceCwd(value) {
      if (typeof value !== 'string' || value === '' || value[0] !== '/') return
      try { window.localStorage.setItem(WORKSPACE_CWD_KEY, value) } catch { /* private mode */ }
    }

    /** @returns {string|undefined} the remembered workspace path. */
    function knownWorkspaceCwd() {
      try {
        var value = window.localStorage.getItem(WORKSPACE_CWD_KEY)
        return typeof value === 'string' && value[0] === '/' ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * A scope with a usable `cwd`, falling back to the remembered workspace.
     * @param {{sessionId?: string, cwd?: string}|undefined} scope - caller scope.
     * @returns {string|undefined} the workspace path to send to the host.
     */
    function scopeCwd(scope) {
      if (scope !== null && scope !== undefined && typeof scope.cwd === 'string' && scope.cwd !== '') return scope.cwd
      return knownWorkspaceCwd()
    }

    /**
     * The log pane of ONE plugin instance (sidebar console or standalone window)
     * has no idea that another instance just started/debugged a program. A storage
     * event (same origin, fires in every other window) carries the selected log
     * path, so starting a program from the console also moves the IDE window's log
     * pane immediately instead of only when the debug session attaches ~40s later.
     */
    var LOG_FOCUS_KEY = 'dsh-ris-ide:log-focus'

    /**
     * @param {string} logPath - the log the user should now be watching.
     */
    function broadcastLogFocus(logPath) {
      if (typeof logPath !== 'string' || logPath === '') return
      try {
        window.localStorage.setItem(LOG_FOCUS_KEY, JSON.stringify({ path: logPath, at: Date.now() }))
      } catch { /* private mode / quota: the broadcast is best-effort */ }
    }

    function routeUrl(path) {
      var base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
        ? document.baseURI
        : 'http://dsh.internal/'
      var url = new URL(base)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return new URL(String(path).replace(/^\/+/, ''), url.href)
    }

    /**
     * ONE EventSource for every "global" topic of this plugin.
     *
     * HTTP/1.1 allows six connections per origin. Opening one stream per topic
     * (tree, programs, debug, debugs, opens) plus the host's own session stream
     * exhausted that budget: every later fetch (open a file, send a message) sat
     * in the browser's queue — which is why the whole GUI froze after the IDE had
     * been open for a while, and why closing the IDE "fixed" it. The hub keeps a
     * single connection for the global topics and rebuilds it only when the topic
     * set changes; the per-path streams (tail, debug) stay separate but pause
     * while the document is hidden.
     */
    var RIS_HUB_TOPICS = [
      'hello', 'tree', 'programs', 'debugs', 'opens', 'stream-error',
      'tail', 'append', 'service', 'tail-error', 'debug', 'debug-error',
    ]
    var RIS_STREAM_HUB = null

    /** Subscribe an object `{topics, sessionId?, cwd?, handlers, onOpen?}` to the hub. */
    function risStreamHub() {
      if (RIS_STREAM_HUB !== null) return RIS_STREAM_HUB
      var subscribers = new Set()
      var source = null
      var signature = ''
      /** The tail path the CURRENT connection carries ('' when none). */
      var servedTail = ''
      var rebuildTimer = null
      var retryTimer = null
      var retryDelay = 3000
      var failures = 0
      function closeSource() {
        if (source === null) return
        try { source.close() } catch { /* already closed */ }
        source = null
      }
      function build() {
        if (subscribers.size === 0) {
          closeSource()
          signature = ''
          return
        }
        var topics = []
        var sessionId
        var cwd
        var tail
        var tailBytes
        var debugPath
        subscribers.forEach(function (sub) {
          ;(sub.topics || []).forEach(function (topic) { if (topics.indexOf(topic) === -1) topics.push(topic) })
          if (sessionId === undefined && typeof sub.sessionId === 'string' && sub.sessionId !== '') sessionId = sub.sessionId
          if (cwd === undefined && typeof sub.cwd === 'string' && sub.cwd !== '') cwd = sub.cwd
          if (cwd === undefined) cwd = knownWorkspaceCwd()
          if (tail === undefined && typeof sub.tail === 'string' && sub.tail !== '') tail = sub.tail
          if (tailBytes === undefined && typeof sub.tailBytes === 'number' && sub.tailBytes > 0) tailBytes = sub.tailBytes
          if (debugPath === undefined && typeof sub.debugPath === 'string' && sub.debugPath !== '') debugPath = sub.debugPath
        })
        topics.sort()
        var next = topics.join(',') + '|' + [sessionId || '', cwd || '', tail || '', tailBytes || '', debugPath || ''].join('|')
        if (source !== null && next === signature) {
          // Same shape as the live socket — but a viewer may have JOINED it since,
          // and the host picked its tail path when it connected. Report that path
          // so a viewer wanting another file can fall back to polling instead of
          // sitting on a stream that carries someone else's text.
          notifyOpen()
          return
        }
        closeSource()
        signature = next
        servedTail = tail || ''
        var url = routeUrl('dsh-ris-ide/stream')
        url.searchParams.set('topics', topics.join(','))
        if (sessionId !== undefined) url.searchParams.set('sessionId', sessionId)
        if (cwd !== undefined) url.searchParams.set('cwd', cwd)
        if (tail !== undefined) url.searchParams.set('tail', tail)
        if (tailBytes !== undefined) url.searchParams.set('bytes', String(tailBytes))
        if (debugPath !== undefined) url.searchParams.set('path', debugPath)
        source = new EventSource(url.href)
        source.addEventListener('open', function () {
          failures = 0
          retryDelay = 3000
          notifyOpen()
        })
        source.onerror = function () {
          // EventSource retries by itself; tell subscribers so a panel that needs a
          // fallback can start its own poll after repeated failures. A HARD failure
          // (400/404, readyState 2) never heals: stop reconnecting so a stale
          // session cannot keep hammering the host forever.
          failures += 1
          var readyState = source !== null ? source.readyState : 2
          // Only a HARD failure (400/404, readyState 2) needs our own retry: the
          // browser retries the other cases by itself. A dsh restart closes the
          // socket exactly this way, so retry with a small backoff instead of
          // giving up — an IDE window left open must come back on its own.
          var fatal = readyState === 2
          subscribers.forEach(function (sub) {
            if (typeof sub.onError === 'function') sub.onError(fatal ? 2 : readyState)
          })
          if (fatal) {
            closeSource()
            signature = ''
            scheduleRetry()
          }
        }
        RIS_HUB_TOPICS.forEach(function (topic) {
          source.addEventListener(topic, function (event) {
            var payload
            try { payload = JSON.parse(event.data) } catch { return }
            subscribers.forEach(function (sub) {
              if ((sub.topics || []).indexOf(topic) === -1) return
              var handler = sub.handlers !== undefined ? sub.handlers[topic] : undefined
              if (typeof handler === 'function') handler(payload)
            })
          })
        })
      }
      /** Tell subscribers the connection is up, and WHICH tail it carries. */
      function notifyOpen() {
        subscribers.forEach(function (sub) {
          if (typeof sub.onOpen === 'function') sub.onOpen({ tail: servedTail })
        })
      }
      function scheduleRetry() {
        if (retryTimer !== null || subscribers.size === 0) return
        retryTimer = setTimeout(function () {
          retryTimer = null
          build()
        }, retryDelay)
        retryDelay = Math.min(30000, retryDelay * 2)
      }
      /** A closed socket is reopened as soon as the browser says it is back. */
      function reconnectIfDown() {
        if (subscribers.size === 0 || source !== null) return
        signature = ''
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        build()
      }
      function schedule() {
        if (rebuildTimer !== null) return
        rebuildTimer = setTimeout(function () {
          rebuildTimer = null
          build()
        }, 80)
      }
      function onVisibility() {
        if (typeof document === 'undefined') return
        if (document.visibilityState === 'hidden') {
          // Do not squat on a connection while the tab is in the background.
          closeSource()
          signature = ''
          return
        }
        signature = ''
        build()
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibility)
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', reconnectIfDown)
        window.addEventListener('pageshow', reconnectIfDown)
        window.addEventListener('focus', reconnectIfDown)
      }
      RIS_STREAM_HUB = {
        /** The tail path the live connection is following ('' when none). */
        tailPath: function () { return servedTail },
        /**
         * @param {{topics: string[], sessionId?: string, cwd?: string, handlers: object, onOpen?: Function}} sub - the subscription.
         * @returns {Function} unsubscribe.
         */
        subscribe: function (sub) {
          subscribers.add(sub)
          schedule()
          return function () {
            subscribers.delete(sub)
            schedule()
          }
        },
      }
      return RIS_STREAM_HUB
    }

    /**
     * Whether the document is currently visible. Used by the per-path streams:
     * a background tab must not keep a connection (the six-per-origin budget is
     * shared with the host's own session stream).
     * @returns {boolean} true while the tab is in the foreground.
     */
    function useDocumentVisible() {
      var [visible, setVisible] = React.useState(function () {
        return typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
      })
      React.useEffect(function () {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        function onChange() { setVisible(document.visibilityState !== 'hidden') }
        document.addEventListener('visibilitychange', onChange)
        return function () { document.removeEventListener('visibilitychange', onChange) }
      }, [])
      return visible
    }

    /**
     * Preferred read: this plugin's tail route (last N bytes).
     * @param {string} path - the previewed file.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {number} bytes - tail window.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<object>} a viewer payload.
     */
    async function readViaTailRoute(path, scope, bytes, signal, before) {
      var query = new URLSearchParams()
      query.set('sessionId', scope.sessionId)
      query.set('path', path)
      if (typeof scope.cwd === 'string' && scope.cwd !== '') query.set('cwd', scope.cwd)
      query.set('bytes', String(bytes))
      if (typeof before === 'number' && Number.isFinite(before) && before > 0) query.set('before', String(Math.floor(before)))
      var response = await fetch(routeUrl('dsh-ris-ide/tail?' + query.toString()).href, {
        method: 'GET',
        cache: 'no-store',
        signal: signal,
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return {
          ok: false,
          code: parsed && parsed.code ? parsed.code : 'http',
          error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status,
        }
      }
      return payloadFromTail(parsed)
    }

    /**
     * Fallback read when the tail route is unavailable: our own `/fs/read`
     * (whole file, 512 KiB cap; the viewer notes when it was cut).
     * @param {string} path - the previewed file.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<object>} a viewer payload.
     */
    async function readViaFsRead(path, scope, signal) {
      var url = routeUrl('dsh-ris-ide/fs/read')
      url.searchParams.set('sessionId', scope.sessionId)
      var readCwd = scopeCwd(scope)
      if (readCwd !== undefined) url.searchParams.set('cwd', readCwd)
      url.searchParams.set('path', path)
      var response = await fetch(url.href, { headers: { accept: 'application/json' }, signal: signal })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return { ok: false, error: parsed !== null && parsed.message !== undefined ? parsed.message : 'HTTP ' + response.status }
      }
      if (parsed.kind === 'binary') return { ok: false, error: '这是二进制文件，不能作为文本日志显示' }
      if (parsed.kind === 'too-large') return { ok: false, error: '文件过大，不能作为文本日志显示' }
      return {
        ok: true,
        content: typeof parsed.content === 'string' ? parsed.content : '',
        mode: 'head',
        truncated: parsed.truncated === true,
        size: parsed.size,
        elided: 0,
        mtimeMs: parsed.mtimeMs,
        note: 'head-mode',
        // The head reader knows nothing about the pidfile; the component keeps
        // the service state it already had instead of dropping the stop button.
        serviceKnown: false,
      }
    }

    /**
     * Read the log once: tail route first, `fs.read` fallback. A refusal is a
     * refusable degradation (head mode + a note), not an error state — only a
     * failure of BOTH tiers reports an error to the viewer.
     * @param {string} path - the previewed file.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @param {number} [bytes] - tail window for the preferred tier.
     * @returns {Promise<object>} a viewer payload.
     */
    async function readLog(path, scope, signal, bytes, before) {
      var failure = null
      try {
        var tail = await readViaTailRoute(path, scope, bytes || TAIL_BYTES, signal, before)
        if (tail.ok === true) return tail
        failure = tail.error
      } catch (error) {
        if (signal && signal.aborted) throw error
        failure = messageOf(error)
      }
      try {
        var head = await readViaFsRead(path, scope, signal)
        if (head.ok === true) return head
        return { ok: false, error: head.error || failure || '读取失败' }
      } catch (error) {
        if (signal && signal.aborted) throw error
        return { ok: false, error: messageOf(error) || failure || '读取失败' }
      }
    }

    /** Normalize the host route's own body. */
    function payloadFromTail(parsed) {
      return {
        ok: true,
        content: typeof parsed.content === 'string' ? parsed.content : '',
        mode: 'tail',
        size: typeof parsed.size === 'number' ? parsed.size : undefined,
        elided: typeof parsed.elided === 'number' ? parsed.elided : 0,
        from: typeof parsed.from === 'number' ? parsed.from : (typeof parsed.elided === 'number' ? parsed.elided : 0),
        more: parsed.more === true,
        mtimeMs: typeof parsed.mtimeMs === 'number' ? parsed.mtimeMs : undefined,
        truncated: false,
        // Authoritative: the tail route reads the pidfile on every poll, so an
        // absent `service` here means "nothing is running" (and the stop button
        // must disappear), unlike head mode which simply does not know.
        service: normalizeService(parsed.service),
        serviceKnown: true,
      }
    }

    /** One `service` payload from the host, or `undefined`. */
    function normalizeService(value) {
      if (value === null || typeof value !== 'object') return undefined
      var pid = typeof value.pid === 'number' ? value.pid : undefined
      if (pid === undefined) return undefined
      return {
        pid: pid,
        wrapperPid: typeof value.wrapperPid === 'number' ? value.wrapperPid : undefined,
        startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined,
        alive: value.alive === true,
      }
    }

    /**
     * Ask the host to stop the service that `run-with-log.sh` started. The host
     * route validates the pidfile's PID against `/proc/<pid>/cmdline` before it
     * signals anything, so this request can only ever reach that wrapper.
     * @param {string} path - the previewed log path.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @returns {Promise<object>} `{ ok: true, stopped, forced, waitedMs, … }`
     *  or `{ ok: false, error, code }`.
     */
    async function requestStop(path, scope) {
      var body = { sessionId: scope.sessionId, path: path }
      if (typeof scope.cwd === 'string' && scope.cwd !== '') body.cwd = scope.cwd
      var response = await fetch(routeUrl('dsh-ris-ide/stop').href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return {
          ok: false,
          code: parsed && parsed.code ? parsed.code : 'http',
          error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status,
        }
      }
      return parsed
    }

    /**
     * Viewer state from one payload. `loading` is the pre-first-read state;
     * `error` replaces the whole body.
     * @param {object} [payload] - payload from `readLog`, or `customData`.
     * @returns {object} component state.
     */
    /** `--- svc started 2026-… ---` line that `run-with-log.*` appends per start. */
    var LOG_RUN_MARKER_RE = /^--- .*? started .*? ---\r?$/gm

    /**
     * Keep only the current run of a reused log file (everything from the last
     * start marker on). Application-owned logs have no marker and pass through.
     * @param {string} content - decoded log text.
     * @returns {string} the current run.
     */
    function trimLogToCurrentRun(content) {
      if (typeof content !== 'string' || content === '') return content
      LOG_RUN_MARKER_RE.lastIndex = 0
      var match
      var offset = -1
      while ((match = LOG_RUN_MARKER_RE.exec(content)) !== null) {
        offset = match.index
        if (match.index === LOG_RUN_MARKER_RE.lastIndex) LOG_RUN_MARKER_RE.lastIndex += 1
      }
      return offset > 0 ? content.slice(offset) : content
    }

    function stateFromPayload(payload) {
      if (payload === undefined || payload === null)return { content: '', lines: 0, loading: true }
      if (payload.ok !== true) {
        return { content: '', lines: 0, loading: false, error: payload.error || '读取失败' }
      }
      var content = trimLogToCurrentRun(typeof payload.content === 'string' ? payload.content : '')
      return {
        content: content,
        lines: countLines(content),
        loading: false,
        error: undefined,
        mode: payload.mode === 'head' ? 'head' : 'tail',
        truncated: payload.truncated === true,
        size: payload.size,
        elided: payload.elided || 0,
        mtimeMs: payload.mtimeMs,
        note: payload.note,
        service: payload.service,
        serviceKnown: payload.serviceKnown === true,
      }
    }

    /** Line count for the status bar (a trailing newline is not a new line). */
    function countLines(content) {
      if (content === '') return 0
      var lines = content.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines.length
    }

    /** Human byte size. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** One message from an unknown thrown value. */
    function messageOf(error) {
      if (error === null || error === undefined) return ''
      return error instanceof Error ? error.message : String(error)
    }

    /** Status-bar text: size, lines, what was elided, which tier answered. */
    function metaText(view) {
      var parts = []
      if (typeof view.size === 'number') parts.push(formatBytes(view.size))
      parts.push(view.lines + ' 行')
      if (view.elided > 0) parts.push('省略前 ' + formatBytes(view.elided))
      if (view.mode === 'head') parts.push('头部模式')
      return parts.join(' · ')
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    //
    // A log line is rendered as spans rather than one text node, so the viewer
    // can show what the app meant: ANSI SGR colors (Maven and Spring Boot emit
    // them), the leading timestamp dimmed, and the level token colored. ANSI
    // wins where it exists — the writer already chose colors — and only lines
    // without SGR get the timestamp/level treatment.

    /** ANSI SGR foreground palette (30-37, 90-97). */
    var ANSI_FG = {
      30: '#4d4d4d', 31: '#e5534b', 32: '#3fb950', 33: '#d29922', 34: '#4c8dff',
      35: '#bc8cff', 36: '#39c5cf', 37: '#b3b3b3',
      90: '#7d8590', 91: '#ff7b72', 92: '#56d364', 93: '#e3b341', 94: '#79c0ff',
      95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc',
    }
    /** Any CSI sequence: SGR (`…m`) is styled, everything else is dropped. */
    var CSI_RE = /\u001B\[([0-9;?]*)([A-Za-z])/g
    /** `2026-10-16 20:55:51.123` / `2026-10-16T20:55:51,123Z` at line start. */
    var TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)/
    /** A level token anywhere in the line (logback / spring / plain). */
    var LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|SEVERE)\b/

    /** The CSS color one level token gets; INFO stays uncolored (it is the noise floor). */
    function levelColor(level) {
      if (level === 'ERROR' || level === 'FATAL' || level === 'SEVERE') return '#e5534b'
      if (level === 'WARN' || level === 'WARNING') return '#d29922'
      if (level === 'DEBUG' || level === 'TRACE') return '#7d8590'
      return undefined
    }

    /**
     * One line's spans plus its level, from raw text.
     * @param {string} text - one line, ANSI included.
     * @returns {{ level: string|undefined, parts: {text: string, style?: object}[] }}
     */
    function parseLine(text) {
      var hasAnsi = text.indexOf('\u001B[') !== -1
      if (hasAnsi) {
        var parts = ansiSegments(text)
        var plain = parts.map(function (part) { return part.text }).join('')
        var match = LEVEL_RE.exec(plain)
        return { level: match ? match[1] : undefined, parts: parts }
      }
      var out = []
      var rest = text
      var stamp = TIMESTAMP_RE.exec(rest)
      if (stamp !== null) {
        out.push({ text: stamp[1], style: S.timestamp })
        rest = rest.slice(stamp[1].length)
      }
      var level = LEVEL_RE.exec(rest)
      if (level !== null) {
        if (level.index > 0) out.push({ text: rest.slice(0, level.index) })
        var color = levelColor(level[1])
        out.push({ text: level[0], style: color === undefined ? S.level : Object.assign({}, S.level, { color: color }) })
        rest = rest.slice(level.index + level[0].length)
      }
      if (rest !== '') out.push({ text: rest })
      if (out.length === 0) out.push({ text: '' })
      return { level: level ? level[1] : undefined, parts: out }
    }

    /**
     * Split one ANSI-colored line into styled spans. Non-SGR sequences (cursor
     * moves, erases, OSC titles) are dropped so they never render as garbage.
     * @param {string} text - the raw line.
     * @returns {{text: string, style?: object}[]} spans in order.
     */
    function ansiSegments(text) {
      var parts = []
      var style = {}
      var cursor = 0
      CSI_RE.lastIndex = 0
      var match = CSI_RE.exec(text)
      while (match !== null) {
        if (match.index > cursor) push(parts, text.slice(cursor, match.index), style)
        if (match[2] === 'm') style = applySgr(style, match[1])
        cursor = match.index + match[0].length
        match = CSI_RE.exec(text)
      }
      if (cursor < text.length) push(parts, text.slice(cursor), style)
      if (parts.length === 0) parts.push({ text: '' })
      return parts
    }

    /** Append one span, merging into the previous one when the style matches. */
    function push(parts, text, style) {
      if (text === '') return
      var last = parts[parts.length - 1]
      var styleText = JSON.stringify(style)
      if (last !== undefined && last.__style === styleText) {
        last.text += text
        return
      }
      parts.push({ text: text, style: Object.keys(style).length === 0 ? undefined : Object.assign({}, style), __style: styleText })
    }

    /** Fold one SGR parameter list into a style. */
    function applySgr(style, params) {
      var codes = params === '' ? [0] : params.split(';').map(function (part) { return part === '' ? 0 : Number(part) })
      var next = Object.assign({}, style)
      for (var index = 0; index < codes.length; index += 1) {
        var code = codes[index]
        if (code === 0) next = {}
        else if (code === 1) next.fontWeight = 600
        else if (code === 2) next.opacity = 0.6
        else if (code === 3) next.fontStyle = 'italic'
        else if (code === 4) next.textDecoration = 'underline'
        else if (code === 22 || code === 23 || code === 24) { delete next.fontWeight; delete next.fontStyle; delete next.textDecoration }
        else if (code === 39) delete next.color
        else if (ANSI_FG[code] !== undefined) next.color = ANSI_FG[code]
        else if (code === 38 && codes[index + 1] === 5) { next.color = ansi256(codes[index + 2]); index += 2 }
        else if (code === 38 && codes[index + 1] === 2) { next.color = rgb(codes[index + 2], codes[index + 3], codes[index + 4]); index += 4 }
      }
      return next
    }

    /** One xterm-256 palette index as a CSS color. */
    function ansi256(index) {
      if (!Number.isFinite(index)) return undefined
      if (index < 8) return ANSI_FG[30 + index]
      if (index < 16) return ANSI_FG[90 + (index - 8)]
      if (index >= 232) {
        var grey = 8 + (index - 232) * 10
        return rgb(grey, grey, grey)
      }
      var n = index - 16
      return rgb(
        55 + 40 * Math.floor(n / 36),
        55 + 40 * (Math.floor(n / 6) % 6),
        55 + 40 * (n % 6),
      )
    }

    /** One 24-bit ANSI color as a CSS color. */
    function rgb(r, g, b) {
      var clamp = function (value) { return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0)) }
      return 'rgb(' + clamp(r) + ',' + clamp(g) + ',' + clamp(b) + ')'
    }

    /**
     * Split file content into rendered lines. Capped so a huge tail cannot
     * build an unbounded element tree; the cap keeps the NEWEST lines.
     * @param {string} content - the tail window.
     * @returns {{level: string|undefined, parts: object[]}[]} lines in order.
     */
    function parseLog(content) {
      if (typeof content !== 'string' || content === '') return []
      var lines = content.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length > MAX_RENDER_LINES) lines = lines.slice(lines.length - MAX_RENDER_LINES)
      return lines.map(parseLine)
    }

    /**
     * Whether a double click belongs to the pane TITLE (and should therefore
     * toggle that pane's maximised state). Every pane header also carries
     * controls — the debug toolbar, the search box, the ⤢/⤡ button — and a double
     * click on one of them must stay with that control.
     * @param {object|null} target - the event target.
     * @returns {boolean} true when the click hit the title area itself.
     */
    function headerDoubleClickIsTitle(target) {
      if (target === null || target === undefined) return true
      if (typeof target.closest !== 'function') return true
      var control = target.closest('button, input, textarea, select, a, label, [data-no-maximize]')
      return control === null || control === undefined
    }

    /** One persisted UI preference; storage failures fall back silently. */
    function readPref(key, fallback) {
      try {
        var value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch (error) {
        return fallback
      }
    }

    /** Persist one UI preference; a failure is not worth surfacing. */
    function writePref(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch (error) {
        // private mode / storage disabled: the choice just does not persist
      }
    }

    /** Storage key + default height of the compact panel's log pane. */
    var COMPACT_UI_KEY = 'dsh-ris-ide:ui:compact'
    var COMPACT_PANE_DEFAULT = 240

    /**
     * The compact panel's log pane height: 240px out of the box, remembered
     * afterwards, clamped so the pane can never swallow the console.
     * @returns {number} a usable pixel height.
     */
    function readCompactPaneHeight() {
      var raw = readPref(COMPACT_UI_KEY, '')
      var value = raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(value)) return COMPACT_PANE_DEFAULT
      return Math.min(Math.max(120, value), 720)
    }

    /** Storage key of the compact panel's maximized section ('' | 'console' | 'log'). */
    var COMPACT_MAX_KEY = 'dsh-ris-ide:ui:compact-max'

    /**
     * Which compact section is maximized: 'console', 'log', or '' for the split
     * view. A stale/garbage value degrades to the split view, never to a blank
     * panel (same tolerance as the saved height).
     * @returns {string}
     */
    function readCompactMax() {
      var raw = readPref(COMPACT_MAX_KEY, '')
      return raw === 'console' || raw === 'log' ? raw : ''
    }

    /** Clamp a font size read from storage into the supported range. */
    /** The IDE-wide content font size: 10–18px in 0.5 steps (A−/A+ control). */
    function clampUiFont(value) {
      var size = Number(value)
      if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
      return Math.min(18, Math.max(10, Math.round(size * 2) / 2))
    }

    function clampFontSize(value) {
      var size = Number(value)
      if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
      return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
    }

    /**
     * Service status label for a header (compact: 运行中 / 已停止). The pid is
     * omitted when the row carries only liveness (a program row built by an old
     * host / a test fixture must not render `pid undefined`).
     * @param {{alive?: boolean, pid?: number}} service - the pidfile's service.
     * @returns the label, or '' when there is no service at all.
     */
    function serviceText(service) {
      if (service === undefined || service === null) return ''
      var pid = Number.isFinite(service.pid) ? ' (pid ' + service.pid + ')' : ''
      return service.alive ? '运行中' + pid : '已停止' + pid
    }

    /**
     * Wheel → horizontal scroll for a tab strip. A plain (vertical) wheel over a
     * tab strip must move the strip sideways instead of scrolling the page; a
     * horizontal trackpad gesture (deltaX dominant) is left to the browser, and
     * a strip whose tabs all fit keeps the default too.
     * @param {object} event - the wheel event (deltaX/deltaY/deltaMode).
     * @param {number} scrollWidth - the strip's full content width.
     * @param {number} clientWidth - the strip's visible width.
     * @returns {number} pixels to add to `scrollLeft` (0 → keep the default).
     */
    function tabStripWheelDelta(event, scrollWidth, clientWidth) {
      if (event === undefined || event === null) return 0
      var width = Number(scrollWidth) || 0
      var visible = Number(clientWidth) || 0
      if (!(width > visible)) return 0
      var dx = Number(event.deltaX) || 0
      var dy = Number(event.deltaY) || 0
      if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) return 0
      if (dy === 0) return 0
      if (event.deltaMode === 1) return dy * 16
      if (event.deltaMode === 2) return dy * visible
      return dy
    }

    /**
     * The scrolling element a wheel listener should move: the node itself when it
     * overflows, else its inner `[data-tab-strip]` child. The source pane listens
     * on the whole tab-BAR row (so the wheel works over the tabs, the ◀ ▶ paging
     * buttons and the empty space alike); the debug pane listens on the strip.
     * @param {object|null} node - the listener target.
     * @returns {object|null} the strip to scroll.
     */
    function tabStripOf(node) {
      if (node === undefined || node === null || typeof node !== 'object') return null
      if (node.scrollWidth > node.clientWidth) return node
      var inner = typeof node.querySelector === 'function' ? node.querySelector('[data-tab-strip]') : null
      return inner === null || inner === undefined ? node : inner
    }

    /**
     * The native wheel listener behind {@link attachTabStripWheel}. It is attached
     * with `{passive:false}` because React's `onWheel` is passive: `preventDefault`
     * there is ignored and the page would scroll as well.
     * @param {WheelEvent} event - native wheel event whose currentTarget is the strip.
     */
    function onTabStripWheel(event) {
      var node = tabStripOf(event === undefined || event === null ? undefined : event.currentTarget)
      if (node === null) return
      var delta = tabStripWheelDelta(event, node.scrollWidth, node.clientWidth)
      if (delta === 0) return
      event.preventDefault()
      node.scrollLeft += delta
    }

    /**
     * Make one tab strip wheel-scrollable.
     * @param {object|null} node - the strip element.
     * @returns {Function} detacher (safe to call when nothing was attached).
     */
    function attachTabStripWheel(node) {
      if (node === null || node === undefined || typeof node.addEventListener !== 'function') return function () {}
      node.addEventListener('wheel', onTabStripWheel, { passive: false })
      return function () { node.removeEventListener('wheel', onTabStripWheel) }
    }

    var MAX_RENDER_LINES = 4000
    var DEFAULT_FONT_SIZE = 12.5
    var MIN_FONT_SIZE = 10
    var MAX_FONT_SIZE = 20
    var PREF_WRAP = 'dsh-ris-ide.wrap'
    var PREF_FONT_SIZE = 'dsh-ris-ide.fontSize'
    /** The theme's mono token first, then what a Linux desktop actually has. */
    var MONO_FAMILY = "var(--dsw-font-mono, 'Ubuntu Sans Mono', 'Ubuntu Mono', 'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', 'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)"

    var BASE_STYLES = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        fontFamily: MONO_FAMILY, fontSize: DEFAULT_FONT_SIZE + 'px',
      },
      bar: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flex: '0 0 auto', flexWrap: 'wrap',
        borderBottom: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11,
      },
      status: { opacity: 0.85, whiteSpace: 'nowrap' },
      meta: { opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      service: { whiteSpace: 'nowrap', color: '#3fb950' },
      serviceStopped: { whiteSpace: 'nowrap', opacity: 0.65 },
      spacer: { flex: 1 },
      button: {
        font: 'inherit', padding: '1px 7px', cursor: 'pointer', color: 'inherit', lineHeight: 1.6,
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 4,
      },
      buttonOn: {
        font: 'inherit', padding: '1px 7px', cursor: 'pointer', color: 'inherit', lineHeight: 1.6,
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 34%, transparent)', borderRadius: 4,
      },
      /** Session-header action: opens the standalone IDE window (compact icon + label). */
      windowButton: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 8px',
        font: 'inherit', fontSize: 12, lineHeight: 1, cursor: 'pointer', color: 'inherit',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        borderRadius: 6, whiteSpace: 'nowrap',
      },
      windowButtonIcon: { fontSize: 13, lineHeight: 1 },
      windowButtonError: {
        font: 'inherit', fontSize: 11, lineHeight: 1, whiteSpace: 'nowrap', color: '#d29922',
      },
      /** Compact sidebar panel: console rows on top, one log pane pinned below. */
      compactPick: {
        font: 'inherit', padding: 0, cursor: 'pointer', color: 'inherit', lineHeight: 1.5,
        background: 'transparent', border: 'none', textAlign: 'left',
        flex: '0 1 auto', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      compactList: {
        flex: '1 1 0', minHeight: 60, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1,
        padding: '2px 8px 4px',
      },
      compactLog: {
        display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', flex: '0 0 auto',
        borderTop: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      },
      compactLogHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', flex: '0 0 auto',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11,
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      },
      compactLogTitle: { fontWeight: 600, whiteSpace: 'nowrap' },
      compactEmpty: {
        flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: 0.6, fontSize: 11,
      },
      compactNote: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', flex: '0 0 auto',
        fontSize: 11, fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
      },
      compactNoteText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      /**
       * The compact panel's ONE button metric: 20px tall, and a glyph-only button
       * is exactly 20x20. The sidebar title bars hold both kinds next to each
       * other, so mixed paddings read as three different sizes; one box ends that.
       */
      paneButton: {
        boxSizing: 'border-box', height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: '0 6px',
        cursor: 'pointer', color: 'inherit', background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 4,
      },
      /** Glyph-only variant of `paneButton`: the SAME 20x20 square every time. */
      paneIcon: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        cursor: 'pointer', color: 'inherit', background: 'transparent',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 4,
      },
      /** Icon button in its "on" state (pressed): same box, tinted. */
      paneIconOn: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        cursor: 'pointer', color: 'inherit',
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 34%, transparent)', borderRadius: 4,
      },
      /** Icon button that cannot act right now: same box, visibly inert. */
      paneIconOff: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        color: 'inherit', opacity: 0.4, cursor: 'default',
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 4,
      },
      /** Row actions keep the 20x20 box and only change colour. */
      startIcon: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        cursor: 'pointer', color: '#3fb950',
        background: 'color-mix(in srgb, #3fb950 12%, transparent)',
        border: '1px solid color-mix(in srgb, #3fb950 45%, transparent)', borderRadius: 4,
      },
      stopIcon: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        cursor: 'pointer', color: '#e5534b',
        background: 'color-mix(in srgb, #e5534b 12%, transparent)',
        border: '1px solid color-mix(in srgb, #e5534b 45%, transparent)', borderRadius: 4,
      },
      debugIcon: {
        boxSizing: 'border-box', width: 20, height: 20, flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 11, lineHeight: 1, padding: 0,
        cursor: 'pointer', color: '#d29922',
        background: 'color-mix(in srgb, #d29922 12%, transparent)',
        border: '1px solid color-mix(in srgb, #d29922 45%, transparent)', borderRadius: 4,
      },
      /** Console tone: green = start, red = stop, orange = debug. */
      debug: {
        font: 'inherit', padding: '1px 8px', cursor: 'pointer', lineHeight: 1.6,
        color: '#d29922', background: 'color-mix(in srgb, #d29922 12%, transparent)',
        border: '1px solid color-mix(in srgb, #d29922 45%, transparent)', borderRadius: 4,
      },
      start: {
        font: 'inherit', padding: '1px 8px', cursor: 'pointer', lineHeight: 1.6,
        color: '#3fb950', background: 'color-mix(in srgb, #3fb950 12%, transparent)',
        border: '1px solid color-mix(in srgb, #3fb950 45%, transparent)', borderRadius: 4,
      },
      stop: {
        font: 'inherit', padding: '1px 8px', cursor: 'pointer', lineHeight: 1.6,
        color: '#e5534b', background: 'color-mix(in srgb, #e5534b 12%, transparent)',
        border: '1px solid color-mix(in srgb, #e5534b 45%, transparent)', borderRadius: 4,
      },
      notice: {
        flex: '0 0 auto', padding: '4px 8px', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        fontSize: 11, lineHeight: 1.45,
        background: 'color-mix(in srgb, #d08b00 16%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      },
      error: {
        flex: '0 0 auto', padding: '6px 8px', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        fontSize: 11, lineHeight: 1.45,
        background: 'color-mix(in srgb, #d33 16%, transparent)',
      },
      log: {
        flex: 1, minHeight: 0, margin: 0, padding: '6px 8px', overflow: 'auto',
        tabSize: 4, lineHeight: 1.5, overflowWrap: 'anywhere',
      },
      /**
       * The wrap toggle used to be a dead button: neither style existed, so both
       * modes rendered with the browser default and nothing changed. `pre` keeps
       * the log's own long lines intact and lets the body scroll horizontally;
       * `pre-wrap` breaks them at the pane edge.
       */
      logWrap: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' },
      logPre: { whiteSpace: 'pre', overflowWrap: 'normal', wordBreak: 'normal' },
      line: { minHeight: '1.5em' },
      timestamp: { opacity: 0.55 },
      level: { fontWeight: 600 },
      empty: { opacity: 0.55, fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 12 },

      /* ---- "本地实例" 面板 ---- */
      instWrap: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 12,
      },
      instList: { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0' },
      instRow: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      instDotOn: { color: '#3fb950', flex: '0 0 auto' },
      instDotOff: { opacity: 0.35, flex: '0 0 auto' },
      instName: { fontWeight: 600, whiteSpace: 'nowrap' },
      instMeta: { opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      instEmpty: { opacity: 0.55, padding: '10px', fontSize: 12 },
      /** Program rows: name + kind badge + relative dir/entry point + three buttons. */
      progRow: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      progWhere: {
        display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1,
        lineHeight: 1.35, overflow: 'hidden',
      },
      progRel: { opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      progMeta: { opacity: 0.5, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      kindSpring: {
        flex: '0 0 auto', fontSize: 10, padding: '0 5px', borderRadius: 999, whiteSpace: 'nowrap',
        color: '#3fb950', border: '1px solid color-mix(in srgb, #3fb950 45%, transparent)',
      },
      kindFrontend: {
        flex: '0 0 auto', fontSize: 10, padding: '0 5px', borderRadius: 999, whiteSpace: 'nowrap',
        color: '#4c8dff', border: '1px solid color-mix(in srgb, #4c8dff 45%, transparent)',
      },
      kindInstance: {
        flex: '0 0 auto', fontSize: 10, padding: '0 5px', borderRadius: 999, whiteSpace: 'nowrap',
        opacity: 0.6, border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
      },
      editedMark: { opacity: 0.55, fontSize: 10, marginLeft: 2 },
      /** Program workbench: a collapsible debug pane above the reused log viewer. */
      workbench: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      /** Left identity block: shrinks (ellipsis on the path) before anything else. */
      /** The console row of the program both panes currently show. */
      consoleRowOn: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '1px 4px', borderRadius: 3,
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        boxShadow: 'inset 2px 0 0 #d29922',
      },
      /** Status-bar 💬 button: modest, with a count when there are unread messages. */
      messageButton: {
        font: 'inherit', padding: '0 5px', cursor: 'pointer', color: 'inherit',
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 3, lineHeight: 1.4, flex: '0 0 auto',
      },
      /** Session message log: fixed above the status bar, bottom-right. */
      messagePanel: {
        position: 'fixed', right: 10, bottom: 30, width: 'min(460px, 60vw)', maxHeight: '40vh',
        display: 'flex', flexDirection: 'column', zIndex: 96,
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 5,
        background: 'color-mix(in srgb, currentColor 10%, Canvas)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.32)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11,
      },
      messageHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
      },
      messageList: { overflow: 'auto', padding: '6px 10px', minHeight: 0 },
      messageRow: { display: 'flex', gap: 6, padding: '2px 0', alignItems: 'baseline' },
      messageTime: { flex: '0 0 auto', opacity: 0.6 },
      /** Floating hint layer: bottom-centre, stacked, click-through. */
      toastLayer: {
        position: 'fixed', left: '50%', bottom: 14, transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch',
        zIndex: 95, pointerEvents: 'none', maxWidth: 'min(560px, 80vw)',
      },
      toast: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        pointerEvents: 'auto', borderRadius: 5,
        // Light-orange advisory tint (the same family the inline notice strip used):
        // legible on both schemes and clearly "a hint", not a dialog.
        border: '1px solid color-mix(in srgb, #d08b00 55%, transparent)',
        background: 'color-mix(in srgb, #ffd79a 85%, Canvas)',
        color: '#3a2a08',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.3)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11.5,
        animation: 'dshRisIdeToastIn 140ms ease-out',
      },
      /** Tab-strip right-click menu (fixed at the pointer). */
      tabMenu: {
        position: 'fixed', zIndex: 80, minWidth: 104, padding: '2px 0',
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 4,
        background: 'color-mix(in srgb, currentColor 8%, Canvas)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11,
      },
      tabMenuItem: {
        display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
        padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: 'none',
      },
      /** The source pane's header/toolbar: search grows, action group is fixed. */
      searchWrap: { position: 'relative', flex: '1 1 auto', minWidth: 120, display: 'flex' },
      searchInputFull: { width: '100%' },
      /** Results panel anchored below the search box. */
      searchDropdown: {
        position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 60,
        maxHeight: 260, overflowY: 'auto', overflowX: 'hidden',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 4,
        background: 'color-mix(in srgb, currentColor 7%, Canvas)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
        fontFamily: MONO_FAMILY, fontSize: 11, padding: '2px 0',
      },
      searchHeader: {
        padding: '1px 6px', opacity: 0.55, fontSize: 10, whiteSpace: 'nowrap',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      },
      searchRow: {
        display: 'flex', gap: 4, alignItems: 'center', padding: '1px 6px', cursor: 'pointer',
        whiteSpace: 'nowrap', overflow: 'hidden',
      },
      /** The row under the dropdown's keyboard/hover highlight (same box, tinted). */
      searchRowOn: { background: 'color-mix(in srgb, currentColor 18%, transparent)' },
      editorPaneHead: {
        display: 'flex', alignItems: 'center', gap: 4, padding: '1px 4px', flex: '0 0 auto',
        // NOT `overflow: hidden`: this row is the search box's anchor, and clipping it
        // also clipped the results dropdown (rows existed in the DOM but were
        // invisible). The inner `headActions` keeps its own overflow to stay tidy.
        overflow: 'visible', position: 'relative', zIndex: 30,
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11, opacity: 0.95,
      },
      /** Right control block: its own fixed width — it never stretches or squeezes the search. */
      headActions: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', minWidth: 0, maxWidth: '55%', overflow: 'hidden' },
      /** Top-bar workspace search: centred by a flex spacer on each side. */
      headSearch: {
        flex: '1 1 auto', minWidth: 120, height: 20, boxSizing: 'border-box', font: 'inherit', fontSize: 11, padding: '0 6px',
        background: 'transparent', color: 'inherit', borderRadius: 4,
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      },
      /** Workspace path in the top bar: one line, ellipsis when long. */
      headPath: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
      /** "已暂停" pill next to the path. */
      badgeWarn: {
        flex: '0 0 auto', fontSize: 10, padding: '0 5px', borderRadius: 999, whiteSpace: 'nowrap',
        color: '#d08b00', border: '1px solid color-mix(in srgb, #d08b00 45%, transparent)',
      },
      workbenchBody: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      debugPane: {
        flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 12,
      },
      /** Debug pane slot: only the section body scrolls, the tab strip stays put. */
      debugSlot: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      /** The debug pane's own tool row (start/stop/step/refresh/collapse). */
      debugToolbar: {
        display: 'flex', gap: 4, alignItems: 'center', padding: '4px 8px', flex: '0 0 auto',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      },
      /** Debug pane: the 断点/线程/… switcher is a real TAB STRIP (multi-tab) — same
       *  language as the source pane's file tabs, attached to the content below. */
      debugTabsBar: {
        display: 'flex', gap: 2, padding: '2px 4px 0', alignItems: 'flex-end', flex: '0 0 auto',
        overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'thin', whiteSpace: 'nowrap',
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      debugSectionTab: {
        font: 'inherit', fontSize: 11, lineHeight: 1.6, padding: '1px 9px', cursor: 'pointer',
        color: 'inherit', opacity: 0.7, background: 'transparent', whiteSpace: 'nowrap',
        border: '1px solid transparent', borderBottom: 'none', borderRadius: '4px 4px 0 0',
      },
      debugSectionTabOn: {
        font: 'inherit', fontSize: 11, lineHeight: 1.6, padding: '1px 9px', cursor: 'pointer',
        color: 'inherit', opacity: 1, whiteSpace: 'nowrap',
        background: 'color-mix(in srgb, currentColor 10%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderBottom: 'none',
        borderRadius: '4px 4px 0 0', marginBottom: -1,
      },
      /** The little per-tab counter (断点 3 / 线程 12 …). */
      debugTabCount: { marginLeft: 4, opacity: 0.55, fontSize: 10 },
      debugTab: {
        font: 'inherit', padding: '1px 8px', borderRadius: 4, cursor: 'pointer',
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      },
      debugTabOn: {
        font: 'inherit', padding: '1px 8px', borderRadius: 4, cursor: 'pointer',
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 40%, transparent)',
      },
      /** Vertical scroll only: a 300px-wide debug pane must not grow a horizontal bar. */
      debugContent: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '4px 10px' },
      debugRow: { display: 'flex', gap: 8, alignItems: 'center', padding: '1px 0', whiteSpace: 'nowrap' },
      debugMono: { fontFamily: MONO_FAMILY, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
      debugForm: { display: 'flex', gap: 4, alignItems: 'center', padding: '4px 0', flexWrap: 'wrap' },
      debugInput: {
        fontFamily: MONO_FAMILY, fontSize: 11, padding: '1px 4px', minWidth: 0,
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
        borderRadius: 3, color: 'inherit',
      },
      debugResize: { height: 4, cursor: 'ns-resize', background: 'color-mix(in srgb, currentColor 8%, transparent)' },
      debugLog: { flex: 1, minHeight: 0 },
      /* IDE 2x2 grid: every pane has an icon header; ⤢ maximizes it alone. */
      ideGrid: { flex: 1, minHeight: 0, display: 'flex', gap: 2, padding: 2 },
      ideCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      idePane: {
        flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 3,
        overflow: 'hidden',
      },
      idePaneMax: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 3, overflow: 'hidden' },
      idePaneFill: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 3, overflow: 'hidden' },
      ideHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '1px 6px', flex: '0 0 auto',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11, opacity: 0.9,
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      /**
       * The LOG pane's header carries the viewer chrome that used to be an
       * in-body bar (service state, wrap, size, find, follow). It wraps instead
       * of clipping when the pane is narrow — the title bar must never hide a
       * control, and the body below it is only log text now.
       */
      ideHeadWrap: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '1px 6px', flex: '0 0 auto', flexWrap: 'wrap', rowGap: 2,
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11, opacity: 0.9,
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      ideBody: { flex: 1, minHeight: 0, overflow: 'auto' },
      /** Log pane: tabs + one viewer, NO outer scroller (the log body scrolls). */
      /** Log pane: tabs + one viewer, NO outer scroller (only the log body scrolls). */
      logPane: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      /** The viewer fills what the tab strip leaves; `minHeight:0` lets it shrink. */
      logSlot: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      logViewerSlot: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      idePlaceholder: { padding: '10px', opacity: 0.55, fontSize: 12 },
      /** The tree pane fills its box and scrolls its own rows. */
      treeWrap: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' },
      treeList: {
        flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '2px 0', fontFamily: MONO_FAMILY, fontSize: 12,
        // 展开/折叠会插入或移除整行：禁用浏览器滚动锚定，滚动条不会自己跳；
        // 稳定滚动条槽位避免“是否出现滚动条”导致的横向抖动。
        overflowAnchor: 'none', scrollbarGutter: 'stable',
      },
      treeRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden' },
      treeRowOn: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', background: 'color-mix(in srgb, currentColor 12%, transparent)' },
      treeTwist: { width: 12, flex: '0 0 auto', opacity: 0.7 },
      /** Folded-chain separator: bold + a 1.5px halo makes the dot readable on dark. */
      foldSeparator: { fontWeight: 700, padding: '0 0.5px', textShadow: '0 0 1.5px currentColor' },
      /** Source pane: tab bar + optional prompt bar + the document itself. */
      editorPane: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' },
      editorTabsBar: {
        display: 'flex', gap: 2, padding: '2px 4px', alignItems: 'center', flex: '0 0 auto',
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      /** The tab strip scrolls horizontally; ◀ ▶ page it. */
      editorTabStrip: {
        display: 'flex', gap: 2, flex: '1 1 auto', minWidth: 0,
        overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'thin', whiteSpace: 'nowrap',
      },
      tabPage: {
        font: 'inherit', fontSize: 10, lineHeight: 1.4, padding: '0 4px', cursor: 'pointer',
        color: 'inherit', opacity: 0.7, background: 'transparent', borderRadius: 3,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      },
      tabAction: {
        font: 'inherit', fontSize: 10, lineHeight: 1.5, padding: '0 5px', cursor: 'pointer', whiteSpace: 'nowrap',
        color: 'inherit', opacity: 0.85, background: 'transparent', borderRadius: 3,
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      },
      /** Always-editable document: gutter (line numbers + breakpoints) and the textarea. */
      editorWrap: { display: 'flex', flex: '1 1 0', minHeight: 0, fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: 1.5 },
      editorGutter: {
        flex: '0 0 auto', minWidth: 44, overflow: 'hidden', textAlign: 'right',
        padding: '2px 0 2px 2px', opacity: 0.65, userSelect: 'none',
      },
      /** Scrolled by the textarea's onScroll (translated, not re-rendered). */
      gutterInner: { padding: '0 6px 0 0', willChange: 'transform' },
      gutterRow: { height: '1.5em', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' },
      gutterBpRow: { height: '1.5em', cursor: 'pointer', color: '#f14c4c', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
      editorTextarea: {
        flex: 1, minWidth: 0, margin: 0, padding: '2px 8px', resize: 'none', border: 'none', outline: 'none',
        background: 'transparent', color: 'inherit', font: 'inherit', lineHeight: 1.5,
        whiteSpace: 'pre', overflow: 'auto', tabSize: 4,
      },
      /** Every open file stays mounted; inactive panes only collapse. */
      filePanes: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
      filePane: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' },
      filePaneHidden: { display: 'none' },
      /** Read-only preview of a file above the whole-read limit (windowed). */
      largeText: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      largeTextBar: {
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '3px 8px', fontSize: 11,
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      },
      largeTextBox: {
        flex: '1 1 0', minHeight: 0, overflow: 'auto', outline: 'none',
        padding: '4px 8px', fontFamily: MONO_FAMILY, fontSize: 12,
        lineHeight: '18px', whiteSpace: 'pre', fontVariantLigatures: 'none',
      },
      largeTextLine: { height: 18, lineHeight: '18px', whiteSpace: 'pre' },
      /** Full-editor Markdown/HTML preview (replaces the editor while open). */
      previewPane: {
        flex: '1 1 0', minHeight: 0, minWidth: 0,
        display: 'flex', flexDirection: 'column',
        background: 'color-mix(in srgb, Canvas 94%, currentColor 5%)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 12,
      },
      /** Right-aligned 预览 / 编辑 switch directly above the file's editor area. */
      previewToggleBar: {
        flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
        padding: '2px 6px 0',
      },
      previewBody: {
        flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: '10px 14px',
        lineHeight: 1.6, overflowWrap: 'break-word',
      },
      previewFrame: { flex: '1 1 0', minHeight: 0, width: '100%', border: 'none', background: 'Canvas' },
      /** External breakpoint column + the embedded sidebar viewer next to it. */
      viewerWrap: { flex: '1 1 0', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'row' },
      bpGutter: {
        flex: '0 0 14px', position: 'relative', overflow: 'hidden', userSelect: 'none', cursor: 'pointer',
        borderRight: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
      },
      viewerHost: { flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      /** Editor line-number context menu (fixed at the pointer). */
      lineMenu: {
        position: 'fixed', zIndex: 90, minWidth: 132, padding: '2px 0',
        border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 4,
        background: 'color-mix(in srgb, currentColor 8%, Canvas)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', fontSize: 11,
      },
      lineMenuItem: {
        display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
        padding: '3px 10px', cursor: 'pointer', background: 'transparent', border: 'none',
      },
      fallbackWrap: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' },
      /** Fallback editor column: optional find bar above the scroll area. */
      editorColumn: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' },
      findBar: {
        display: 'flex', gap: 4, alignItems: 'center', padding: '2px 6px', flex: '0 0 auto',
        borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
      },
      findInput: {
        flex: '0 1 220px', minWidth: 80, fontFamily: MONO_FAMILY, fontSize: 11, padding: '1px 4px',
        background: 'transparent', color: 'inherit', borderRadius: 3,
        border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
      },
      /** Media previews (images / PDF), both fed by the sidebar's raw file route. */
      mediaWrap: { flex: '1 1 0', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: 8 },
      mediaImage: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
      mediaFrame: { flex: '1 1 0', width: '100%', height: '100%', border: 'none', background: '#fff' },
      editorCode: { flex: 1, minWidth: 0, overflow: 'auto', padding: '2px 8px', whiteSpace: 'pre' },
      gutterBp: { color: '#f14c4c', fontWeight: 700 },
      editorTabs: { display: 'flex', gap: 2, padding: '2px 4px', flexWrap: 'wrap', flex: '0 0 auto', minHeight: 0, borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)' },
      editorTab: { font: 'inherit', fontSize: 11, padding: '1px 6px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)' },
      editorTabOn: { font: 'inherit', fontSize: 11, padding: '1px 6px', borderRadius: 3, cursor: 'pointer', background: 'color-mix(in srgb, currentColor 14%, transparent)', border: '1px solid color-mix(in srgb, currentColor 35%, transparent)' },
      /** The tab's `×` — small, dim until the tab is hovered/active. */
      tabClose: { marginLeft: 4, opacity: 0.55, padding: '0 2px', borderRadius: 2 },
      buttonOff: {
        font: 'inherit', padding: '1px 7px', color: 'inherit', opacity: 0.4, cursor: 'default',
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        borderRadius: 4,
      },
      /** Disabled icon button: same box, visibly inert (dim + not-allowed). */
      buttonDisabled: {
        font: 'inherit', padding: '1px 7px', color: 'inherit', opacity: 0.32, cursor: 'not-allowed',
        background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
        borderRadius: 4,
      },
      stopDisabled: {
        font: 'inherit', padding: '1px 8px', lineHeight: 1.6, opacity: 0.32, cursor: 'not-allowed',
        color: '#e5534b', background: 'color-mix(in srgb, #e5534b 6%, transparent)',
        border: '1px solid color-mix(in srgb, #e5534b 18%, transparent)', borderRadius: 4,
      },
    }
    /**
     * Style sets at one font scale. The IDE computes ONE scale from its A−/A+
     * state and hands it down as a `fontRatio` prop; each pane takes its own set
     * with `stylesFor(ratio)` (a local `var S` shadows the module default). That
     * keeps the scaling per-tree — a module-global ratio would leak into the
     * sidebar's own `.log` viewer, whose chrome is rendered from these same
     * blocks.
     */
    var STYLE_SETS = new Map()
    function stylesFor(ratio) {
      var key = Math.max(0.25, Math.min(3, typeof ratio === 'number' && ratio > 0 ? ratio : 1))
      key = Math.round(key * 100) / 100
      var cached = STYLE_SETS.get(key)
      if (cached !== undefined) return cached
      var set
      if (key === 1) {
        set = BASE_STYLES
      } else {
        var scaled = {}
        Object.keys(BASE_STYLES).forEach(function (name) {
          var style = BASE_STYLES[name]
          if (style === null || typeof style !== 'object') { scaled[name] = style; return }
          var next = Object.assign({}, style)
          if (typeof next.fontSize === 'number') next.fontSize = Math.round(next.fontSize * key * 2) / 2
          scaled[name] = next
        })
        set = scaled
      }
      STYLE_SETS.set(key, set)
      return set
    }
    /** The unscaled set: components outside the IDE (the sidebar's own viewers). */
    var S = stylesFor(1)

    /** Scaled CSS for viewers that paint their own font (CodeMirror pins 13px). */
    function viewerFontCss(size) {
      return '[data-workbench="ris-ide"] .cm-editor{font-size:' + size + 'px !important}'
        + '[data-workbench="ris-ide"] .cm-scroller{line-height:1.5}'
    }
    /**
     * DSH's own theme service (`ctx.provide('theme', …)` from ui-theme), read
     * indirectly: property access on an un-injected service throws under cordis,
     * while `get()` returns undefined for a host that does not provide it.
     * @returns {{getTheme?: Function, setTheme?: Function}|undefined} the service.
     */
    function dshThemeService() {
      try {
        if (panelCtx === null || panelCtx === undefined || typeof panelCtx.get !== 'function') return undefined
        var service = panelCtx.get('theme')
        return service !== null && typeof service === 'object' ? service : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * The DSH theme service's `preference` (`system` / `dark` / `light`).
     * @param {object|undefined} service - from {@link dshThemeService}.
     * @returns {string|undefined} the preference.
     */
    function themePreferenceOf(service) {
      try {
        if (service === undefined || typeof service.getTheme !== 'function') return undefined
        var snapshot = service.getTheme()
        var preference = snapshot !== null && typeof snapshot === 'object' ? snapshot.preference : undefined
        return preference === 'dark' || preference === 'light' || preference === 'system' ? preference : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * The PAGE's colour scheme, exactly as the sidebar's CodeMirror decides it
     * (`isDarkScheme()` in better-sidebar: `colorScheme` style if the app pinned
     * one, else the media query).
     * @returns {boolean} whether the page renders dark.
     */
    function pageIsDark() {
      try {
        if (typeof document === 'undefined') return true
        if (document.documentElement.style.colorScheme !== '') {
          return document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
        }
        return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      } catch (error) {
        return true
      }
    }

    /**
     * Colour overrides for the EMBEDDED viewer when the IDE pins a scheme.
     *
     * The sidebar's CodeMirror picks its SYNTAX PALETTE from the PAGE
     * (`isDarkScheme()`), one-light or one-dark, with concrete colours; we cannot
     * reconfigure that from outside. Pinning the OPPOSITE surface used to paint a
     * dark editor with the light palette — one-light's operator colour is BLACK,
     * so every `.` (an operator token in Java) vanished. So: only restate the
     * surface when the pinned scheme AGREES with the page (then the palette matches
     * too); on a conflict the editor keeps the page's scheme and stays readable,
     * while our chrome still uses the pinned one. `auto` emits nothing at all.
     * @param {'auto'|'dark'|'light'} theme - the IDE's pinned scheme.
     * @param {boolean} [darkPage] - the page's scheme (defaults to the live probe).
     * @returns {string} CSS to append to the workbench `<style>`.
     */
    function viewerThemeCss(darkPage) {
      // CodeMirror's SYNTAX PALETTE is chosen by the PAGE (`isDarkScheme()`), and we
      // cannot reconfigure it. The IDE therefore just FOLLOWS the DSH theme, and the
      // surface stated here matches that palette — otherwise the editor inherits the
      // chrome background and tokens land on the wrong colour (the invisible '.').
      var pageDark = typeof darkPage === 'boolean' ? darkPage : pageIsDark()
      if (!pageDark) {
        return '[data-workbench="ris-ide"] .cm-editor{background:#ffffff !important;color:#1f2328 !important}'
          + '[data-workbench="ris-ide"] .cm-gutters{background:transparent !important;color:#6e7781 !important;border-right:1px solid #d0d7de !important}'
          + '[data-workbench="ris-ide"] .cm-activeLine{background:#f6f8fa !important}'
          + '[data-workbench="ris-ide"] .cm-activeLineGutter{background:#f6f8fa !important}'
          + '[data-workbench="ris-ide"] .cm-cursor{border-left-color:#1f2328 !important}'
          + '[data-workbench="ris-ide"] .tok-comment{color:#6a737d !important}'
          + '[data-workbench="ris-ide"] .tok-keyword{color:#cf222e !important}'
          + '[data-workbench="ris-ide"] .tok-string{color:#0a3069 !important}'
          + '[data-workbench="ris-ide"] .tok-number{color:#0550ae !important}'
          + '[data-workbench="ris-ide"] .tok-typeName,[data-workbench="ris-ide"] .tok-className{color:#8250df !important}'
          + '[data-workbench="ris-ide"] .tok-variableName,[data-workbench="ris-ide"] .tok-propertyName{color:#1f2328 !important}'
      }
      return '[data-workbench="ris-ide"] .cm-editor{background:#1b1d23 !important;color:#d8dbe0 !important}'
        + '[data-workbench="ris-ide"] .cm-gutters{background:transparent !important;color:#8b949e !important;border-right:1px solid #30363d !important}'
        + '[data-workbench="ris-ide"] .cm-activeLine{background:#262a33 !important}'
        + '[data-workbench="ris-ide"] .cm-activeLineGutter{background:#262a33 !important}'
        + '[data-workbench="ris-ide"] .cm-cursor{border-left-color:#d8dbe0 !important}'
        + '[data-workbench="ris-ide"] .tok-comment{color:#6a9955 !important}'
        + '[data-workbench="ris-ide"] .tok-keyword{color:#569cd6 !important}'
        + '[data-workbench="ris-ide"] .tok-string{color:#ce9178 !important}'
        + '[data-workbench="ris-ide"] .tok-number{color:#b5cea8 !important}'
        + '[data-workbench="ris-ide"] .tok-typeName,[data-workbench="ris-ide"] .tok-className{color:#4ec9b0 !important}'
        + '[data-workbench="ris-ide"] .tok-variableName,[data-workbench="ris-ide"] .tok-propertyName{color:#d8dbe0 !important}'
    }

    /**
     * The viewer body: the last-window log rendered line by line, a follow
     * toggle, wrap and font controls, and a stop button whenever the pidfile
     * says a service is running. Read-only for the FILE — stopping the service
     * is the one write this viewer offers, and the host route validates the
     * pidfile before it signals anything.
     * @param {object} props - `FileViewerProps` (`scope`, `path`, `customData`).
     * @returns {object} the viewer element.
     */
    /**
     * Find every occurrence of `query` (case-insensitive) in the given line texts.
     * Each match names the line index and the [from, to) window inside that line.
     * @param {string[]} lineTexts - one plain string per rendered line.
     * @param {string} query - the search text ('' = no matches).
     * @returns {Array<{line: number, from: number, to: number}>} matches in reading order.
     */
    function findLogMatches(lineTexts, query) {
      var needle = String(query === undefined || query === null ? '' : query)
      if (needle === '') return []
      var lowered = needle.toLowerCase()
      var out = []
      ;(Array.isArray(lineTexts) ? lineTexts : []).forEach(function (text, line) {
        var haystack = String(text === undefined || text === null ? '' : text).toLowerCase()
        var at = haystack.indexOf(lowered)
        while (at !== -1) {
          out.push({ line: line, from: at, to: at + lowered.length })
          at = haystack.indexOf(lowered, at + lowered.length)
        }
      })
      return out
    }

    function LogTail(props) {
      // Inside the IDE this follows the A−/A+ ratio for its chrome; the sidebar's
      // own `.log` viewer passes nothing and stays at the default set.
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var scope = props.scope
      var path = props.path
      // Primitive dependencies: `scope` is an object the host may re-create on
      // every render, and depending on it would resubscribe (and so reset) the
      // poll timer far more often than once a second.
      var sessionId = scope ? scope.sessionId : undefined
      var cwd = scope ? scope.cwd : undefined
      if (typeof cwd !== 'string' || cwd === '') cwd = knownWorkspaceCwd()
      var [view, setView] = useState(function () { return stateFromPayload(props.customData) })
      // These controls live in the LOG PANE'S TITLE BAR inside the IDE, so the
      // workbench passes them down (value + change callback) and the viewer body
      // is only log text. When rendered on its own (tests, an older caller) the
      // local fallbacks keep the viewer usable.
      var [ownFollowing, setOwnFollowing] = useState(true)
      var following = typeof props.following === 'boolean' ? props.following : ownFollowing
      var setFollowing = function (next) {
        var value = typeof next === 'function' ? next(following) : next
        setOwnFollowing(value)
        if (typeof props.onFollowingChange === 'function') props.onFollowingChange(value)
      }
      // Wrap is ON by default: log lines are long, and the user asked for it.
      var [ownWrap] = useState(function () { return readPref(PREF_WRAP, '1') !== '0' })
      var wrap = typeof props.wrap === 'boolean' ? props.wrap : ownWrap
      var [ownFontSize] = useState(function () { return clampFontSize(readPref(PREF_FONT_SIZE, DEFAULT_FONT_SIZE)) })
      var fontSize = typeof props.fontSize === 'number' ? props.fontSize : ownFontSize
      // The IDE-wide A−/A+ multiplies the viewer's own size; the `.log` viewer in
      // the sidebar passes nothing and keeps its pref verbatim.
      var fontScale = typeof props.scale === 'number' && props.scale > 0 ? props.scale : 1
      var effectiveFontSize = fontScale === 1 ? fontSize : clampFontSize(fontSize * fontScale)
      var logRef = useRef(null)
      var busyRef = useRef(false)
      /** "加载更多": the byte offset the loaded content starts at, and whether older text exists. */
      var [earliest, setEarliest] = useState(null)
      var [hasMore, setHasMore] = useState(false)
      var [loadingMore, setLoadingMore] = useState(false)
      var [atTop, setAtTop] = useState(false)
      /** Log search: open state, query, and the index of the current match. */
      var [findOpen, setFindOpen] = useState(false)
      var [findText, setFindText] = useState('')
      var [findIndex, setFindIndex] = useState(0)
      var findInputRef = useRef(null)
      var scrollToLineRef = useRef(-1)

      // The sidebar may re-run the descriptor's load() (model edits, viewer
      // rematch); adopt that content rather than ignoring it.
      useEffect(function () {
        if (props.customData !== undefined) setView(stateFromPayload(props.customData))
      }, [props.customData])

      var refresh = React.useCallback(async function () {
        if (busyRef.current) return
        busyRef.current = true
        try {
          var next = await readLog(path, { sessionId: sessionId, cwd: cwd }, undefined, TAIL_BYTES)
          setView(function (previous) {
            // Head mode cannot see the pidfile: keep what the tail route last
            // told us so the stop button does not flicker away.
            var merged = next.ok === true && next.serviceKnown !== true
              ? Object.assign({}, next, { service: previous.service, serviceKnown: previous.serviceKnown })
              : next
            if (
              previous.content === merged.content
              && previous.error === merged.error
              && previous.mode === merged.mode
              && previous.size === merged.size
              && serviceKey(previous) === serviceKey(merged)
            ) return previous
            return merged
          })
        } catch (error) {
          setView(function (previous) { return Object.assign({}, previous, { error: messageOf(error) }) })
        } finally {
          busyRef.current = false
        }
      }, [path, sessionId, cwd])

      // Tail only while this viewer is actually on screen. The sidebar keeps every
      // open tab mounted, so without this guard each hidden `.log` viewer kept
      // hitting `/tail` once a second.
      var tailVisible = props.visible !== false
      /**
       * External reload requests: the workbench bumps `reloadNonce` after a debug
       * start/stop/resume, where the file may have restarted or un-frozen without
       * any `append` frame reaching this viewer. Ignore the first render (the
       * initial load already happens below).
       */
      var reloadSeenRef = useRef(props.reloadNonce)
      useEffect(function () {
        if (props.reloadNonce === undefined) return
        if (reloadSeenRef.current === props.reloadNonce) return
        reloadSeenRef.current = props.reloadNonce
        if (tailVisible) void refresh()
      }, [props.reloadNonce, refresh, tailVisible])
      /**
       * Live streaming: one `text/event-stream` response pushes the tail as the file
       * grows, instead of a `/tail` request per second. `EventSource` reconnects on
       * its own; after two failures we fall back to the JSON polling below so an old
       * host (or a proxy that buffers) still works.
       */
      var [streamOk, setStreamOk] = useState(function () { return typeof EventSource === 'function' })
      useEffect(function () {
        if (!tailVisible || streamOk !== true) return undefined
        if (typeof EventSource !== 'function' || typeof path !== 'string' || path === '') return undefined
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        // Sidebar viewers get their payload from the descriptor's loader, not from
        // a file path: nothing to stream.
        if (props.customData !== undefined) return undefined
        // The tail rides the plugin's SINGLE stream connection: one socket for the
        // whole panel keeps the browser's per-origin budget free for the host.
        var failures = 0
        return risStreamHub().subscribe({
          topics: ['tail'],
          sessionId: sessionId,
          cwd: typeof cwd === 'string' ? cwd : undefined,
          tail: path,
          tailBytes: TAIL_BYTES,
          handlers: {
            tail: function (payload) {
              // Another viewer's snapshot (two panes, one socket): ignore it.
              if (payload !== null && payload !== undefined && typeof payload.path === 'string' && payload.path !== path) return
              setView(stateFromPayload(payload))
            },
            append: function (payload) {
              var text = typeof payload.text === 'string' ? payload.text : ''
              if (text === '') return
              // A new `--- started ---` line = the service restarted: drop the old
              // run instead of appending to it.
              if (/--- .*? started .*? ---/.test(text)) {
                setView(function (previous) {
                  return Object.assign({}, previous, {
                    content: trimLogToCurrentRun(text),
                    lines: countLines(trimLogToCurrentRun(text)),
                    loading: false,
                    error: undefined,
                    mode: 'tail',
                  })
                })
                return
              }
              setView(function (previous) {
                var content = String(previous.content || '') + text
                // Keep the buffer bounded: a very long session must not grow forever.
                if (content.length > STREAM_MAX_CHARS) content = content.slice(content.length - STREAM_MAX_CHARS)
                return Object.assign({}, previous, {
                  content: content,
                  lines: countLines(content),
                  loading: false,
                  error: undefined,
                  mode: 'tail',
                  size: previous.size === undefined ? undefined : previous.size + text.length,
                  serviceKnown: previous.serviceKnown === true || payload.serviceKnown === true,
                })
              })
            },
            service: function (payload) {
              setView(function (previous) {
                return Object.assign({}, previous, { service: payload.service, serviceKnown: true })
              })
            },
            'tail-error': function (payload) {
              setView(function (previous) {
                return Object.assign({}, previous, { loading: false, error: payload.error || '读取失败' })
              })
            },
          },
          onOpen: function (info) {
            failures = 0
            // The panel shares ONE streaming socket and that socket carries ONE
            // tail path. When the host bound it to another file (another log viewer
            // mounted first), this pane would never see its own file on the stream
            // — poll `/tail` for it instead of waiting forever.
            var served = info !== null && info !== undefined && typeof info.tail === 'string' ? info.tail : ''
            setStreamOk(served === '' || served === path)
          },
          onError: function (readyState) {
            failures += 1
            // Old host / buffering proxy: fall back to the JSON poll below.
            if (failures >= 2 || readyState === 2) setStreamOk(false)
          },
        })
      }, [tailVisible, streamOk, path, sessionId, cwd, props.customData])

      useEffect(function () {
        // First paint: read the tail once even when the shared stream is already
        // connected. A live connection only pushes what is written from NOW on, so
        // a pane mounting onto an existing socket would start empty and stay behind
        // (the "log freezes on the start command until I click the row" bug).
        if (!tailVisible) return
        if (props.customData !== undefined) return
        if (typeof EventSource !== 'function') return
        void refresh()
      }, [])

      useEffect(function () {
        // The stream is authoritative while it is connected; polling resumes only
        // when it failed (old host, buffering proxy, tab restored from bfcache).
        if (!tailVisible || streamOk) return undefined
        var cancelled = false
        var timer = null
        var tick = function () {
          timer = setTimeout(async function () {
            if (cancelled) return
            var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
            if (!hidden) await refresh()
            if (!cancelled) tick()
          }, POLL_MS)
        }
        void refresh()
        tick()
        return function () {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [refresh, tailVisible, streamOk])

      useEffect(function () {
        var element = logRef.current
        if (following && element !== null) element.scrollTop = element.scrollHeight
      }, [view.content, view.lines, following, wrap, effectiveFontSize])

      useEffect(function () {
        if (view.ok !== true) return
        if (typeof view.from === 'number' && Number.isFinite(view.from)) setEarliest(view.from)
        else if (typeof view.elided === 'number' && view.elided > 0) setEarliest(view.elided)
        setHasMore(view.more === true || (typeof view.from === 'number' && view.from > 0) || (typeof view.elided === 'number' && view.elided > 0))
      }, [view.ok, view.from, view.elided, view.more, path])

      var lines = React.useMemo(function () { return parseLog(view.content) }, [view.content])
      var lineTexts = React.useMemo(function () {
        return lines.map(function (line) { return line.parts.map(function (part) { return part.text }).join('') })
      }, [lines])
      var findMatches = React.useMemo(function () { return findLogMatches(lineTexts, findText) }, [lineTexts, findText])
      var currentMatch = findMatches.length === 0 ? null : findMatches[Math.min(findIndex, findMatches.length - 1)]
      useEffect(function () {
        if (currentMatch === null) { scrollToLineRef.current = -1; return }
        scrollToLineRef.current = currentMatch.line
        setFollowing(false)
        var element = logRef.current
        if (element === null) return
        var row = element.children[currentMatch.line]
        if (row === undefined) return
        var top = row.offsetTop - element.clientHeight / 2 + row.offsetHeight / 2
        element.scrollTop = Math.max(0, top)
      }, [currentMatch === null ? 'none' : currentMatch.line + ':' + currentMatch.from, findText])
      useEffect(function () {
        if (!findOpen) return
        if (findInputRef.current !== null) findInputRef.current.focus()
      }, [findOpen])

      var onScroll = function () {
        var element = logRef.current
        if (element === null) return
        var atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
        setFollowing(function (previous) { return previous === atEnd ? previous : atEnd })
        setAtTop(function (previous) {
          var next = element.scrollTop <= 2
          return previous === next ? previous : next
        })
      }

      /** Prepend one older window; the viewport stays on the same line. */
      var loadMore = function () {
        if (loadingMore || hasMore !== true || typeof earliest !== 'number') return
        var element = logRef.current
        var previousHeight = element === null ? 0 : element.scrollHeight
        var previousTop = element === null ? 0 : element.scrollTop
        setLoadingMore(true)
        void (async function () {
          try {
            var older = await readLog(path, { sessionId: sessionId, cwd: cwd }, undefined, TAIL_BYTES, earliest)
            if (older.ok !== true) {
              setView(function (previous) { return Object.assign({}, previous, { error: older.error || '更早的日志读取失败' }) })
              return
            }
            setView(function (previous) {
              var merged = Object.assign({}, previous, { content: older.content + previous.content })
              if (older.content === '') merged.error = '已经到日志开头了'
              return merged
            })
            if (typeof older.from === 'number') setEarliest(older.from)
            setHasMore(older.more === true || (typeof older.from === 'number' && older.from > 0))
            setFollowing(false)
            // Keep the line the reader was looking at in place.
            setTimeout(function () {
              var node = logRef.current
              if (node === null) return
              node.scrollTop = previousTop + (node.scrollHeight - previousHeight)
            }, 0)
          } catch (problem) {
            setView(function (previous) { return Object.assign({}, previous, { error: messageOf(problem) }) })
          } finally {
            setLoadingMore(false)
          }
        })()
      }

      // Wrap/size/find/follow are drawn by the LOG PANE'S TITLE BAR (the
      // workbench owns their state); the viewer body no longer has a bar.
      // Stop/start belongs to the console's programme rows (and to the model tools);
      // the log viewer only reads. Keeping a second stop button here duplicated the
      // console and could also stop a service the reader did not mean to touch.
      var service = view.service
      var canStop = service !== undefined && service.alive === true

      var dismissals = useDismissedNotices()
      var notice = null
      if (view.mode === 'head') {
        notice = h(ClosableNotice, {
          styles: S, kind: 'log-head', signature: 'head:' + (view.truncated === true) + ':' + String(view.size),
          onDismiss: dismissals.dismiss,
        }, view.truncated
          ? '宿主 tail 路由不可用，已退回头部读取：只显示文件开头 512 KiB，新行不会出现。'
          : '宿主 tail 路由不可用，已退回头部读取（文件小于 512 KiB，内容完整）。')
      }
      // 日志查看器不显示“只显示末尾…”的截断提示：直接展示末尾内容即可。

      /** Render one part's text, wrapping the query hits in <mark> (style kept). */
      function renderPart(part, partIndex, partStart, matches) {
        if (findText === '' || matches.length === 0) {
          return h('span', { key: partIndex, style: part.style }, part.text)
        }
        var text = part.text
        var segments = []
        var cursor = 0
        matches.forEach(function (match, matchIndex) {
          var from = match.from - partStart
          var to = match.to - partStart
          if (match.line !== undefined && (to <= 0 || from >= text.length)) return
          var start = Math.max(0, from)
          var end = Math.min(text.length, to)
          if (start > cursor) segments.push({ text: text.slice(cursor, start), mark: false })
          segments.push({ text: text.slice(start, end), mark: true, current: currentMatch !== null && currentMatch.line === match.line && currentMatch.from === match.from })
          cursor = Math.max(cursor, end)
          void matchIndex
        })
        if (cursor < text.length) segments.push({ text: text.slice(cursor), mark: false })
        return h('span', { key: partIndex, style: part.style }, segments.map(function (segment, segmentIndex) {
          if (!segment.mark) return h('span', { key: segmentIndex }, segment.text)
          return h('mark', {
            key: segmentIndex,
            style: segment.current
              ? { background: '#d29922', color: '#1b1f24', borderRadius: 2 }
              : { background: 'rgba(210, 153, 34, 0.38)', color: 'inherit', borderRadius: 2 },
          }, segment.text)
        }))
      }

      var body = view.loading
        ? h('div', { style: S.empty }, '读取中…')
        : view.content === ''
          ? h('div', { style: S.empty }, '(尚无输出)')
          : lines.map(function (line, index) {
            // Matches are filtered per line so each part can offset into them.
            var lineMatches = findText === '' ? [] : findMatches.filter(function (match) { return match.line === index })
            var parts = []
            var partStart = 0
            line.parts.forEach(function (part, partIndex) {
              parts.push(renderPart(part, partIndex, partStart, lineMatches))
              partStart += part.text.length
            })
            return h('div', { key: index, style: wrap ? S.logWrap : S.logPre }, parts)
          })

      return h('div', {
        style: Object.assign({}, S.root, { fontSize: effectiveFontSize + 'px' }),
        tabIndex: 0,
        'data-dsh-ris-ide': 'viewer',
        onKeyDown: function (event) {
          // Ctrl+F inside the log pane opens the log's own find bar (the IDE-wide
          // Ctrl+F is handled at the panel level and checks defaultPrevented).
          if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault()
            event.stopPropagation()
            var highlighted = selectedLineTextIn(event.currentTarget)
            if (highlighted !== '') {
              setFindText(highlighted)
              setFindIndex(0)
            }
            setFindOpen(true)
            return
          }
          if (event.key === 'Escape' && findOpen) {
            event.preventDefault()
            setFindOpen(false)
          }
        },
        'data-wrap': wrap ? 'on' : 'off',
        'data-service': canStop ? 'running' : service === undefined ? 'none' : 'stopped',
      },
        findOpen
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px', borderBottom: '1px solid rgba(127,127,127,0.25)' }, 'data-log-find-bar': '1' },
            h('input', {
              ref: findInputRef, type: 'search', value: findText, placeholder: '在日志中查找（Enter 下一个，Shift+Enter 上一个）',
              style: Object.assign({}, S.headSearch, { flex: '1 1 auto', minWidth: 0 }),
              'data-log-find': '1',
              onChange: function (event) { setFindText(event.target.value); setFindIndex(0) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (findMatches.length === 0) return
                  setFindIndex(function (previous) {
                    var delta = event.shiftKey ? -1 : 1
                    return (previous + delta + findMatches.length) % findMatches.length
                  })
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setFindOpen(false)
                  setFindText('')
                }
              },
            }),
            h('span', { style: S.meta, 'data-log-find-count': '1' },
              findText === '' ? '' : (findMatches.length === 0 ? '0/0' : (Math.min(findIndex, findMatches.length - 1) + 1) + '/' + findMatches.length)),
            h('button', {
              type: 'button', style: S.button, 'data-action': 'log-find-prev', title: '上一个（Shift+Enter）',
              onClick: function () {
                if (findMatches.length === 0) return
                setFindIndex(function (previous) { return (previous - 1 + findMatches.length) % findMatches.length })
              },
            }, '↑'),
            h('button', {
              type: 'button', style: S.button, 'data-action': 'log-find-next', title: '下一个（Enter）',
              onClick: function () {
                if (findMatches.length === 0) return
                setFindIndex(function (previous) { return (previous + 1) % findMatches.length })
              },
            }, '↓'),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-action': 'log-find-close', title: '关闭查找（Esc）',
              onClick: function () { setFindOpen(false); setFindText('') },
            }, '×'))
          : null,
        view.error !== undefined ? h('div', { style: Object.assign({}, S.error, { display: 'flex', alignItems: 'center', gap: 6 }), role: 'alert' },
          h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, view.error),
          h('button', {
            type: 'button', style: Object.assign({}, S.buttonOff, { flex: '0 0 auto', padding: '0 4px' }),
            'data-notice-close': 'log-error', title: '关闭这条提示',
            onClick: function () { dismissals.dismiss('log-error', String(view.error)) },
          }, '×')) : null,
        notice,
        h('div', { style: Object.assign({}, S.root, { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }) },
          h('div', {
            ref: logRef, style: S.log, onScroll: onScroll,
            'data-state': view.loading ? 'loading' : 'ready',
          }, body),
          atTop && hasMore
            ? h('button', {
              type: 'button',
              style: {
                position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)', zIndex: 3,
                padding: '2px 10px', fontSize: 'inherit', cursor: 'pointer',
                background: '#d29922', color: '#1b1f24', border: 'none', borderRadius: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              },
              'data-action': 'log-load-more',
              onClick: function (event) { event.stopPropagation(); loadMore() },
            }, loadingMore ? '加载中…' : '↑ 加载更多（更早的日志）')
            : null),
      )
    }

    /** Identity of the service part of a view, for change detection. */
    function serviceKey(view) {
      if (view === undefined || view.service === undefined) return ''
      return view.service.pid + ':' + (view.service.alive ? '1' : '0')
    }

    /** Cordis services this client plugin needs before it may register. */
    var inject = ['sidebarRight', 'sidebarRightTabs', 'slots']

    var DEBUG_SECTIONS = [
      { id: 'breakpoints', label: '断点' },
      { id: 'threads', label: '线程' },
      { id: 'stack', label: '调用栈' },
      { id: 'variables', label: '变量' },
      { id: 'events', label: '事件' },
    ]

    /** Extensions the browser can show inline through the sidebar's media route. */
    var IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
    var PDF_EXTS = ['pdf']

    /** Lowercase extension of a path (no leading dot), or ''. */
    function extOf(path) {
      var name = String(path === undefined || path === null ? '' : path)
      var at = name.lastIndexOf('.')
      var slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
      if (at === -1 || at < slash) return ''
      var ext = name.slice(at + 1).toLowerCase()
      return /^[a-z0-9]+$/.test(ext) ? ext : ''
    }
    /** True for files the IDE shows as an <img> instead of text. */
    function isImagePath(path) { return IMAGE_EXTS.indexOf(extOf(path)) !== -1 }
    /** True for PDFs the IDE shows in a sandboxed iframe. */
    function isPdfPath(path) { return PDF_EXTS.indexOf(extOf(path)) !== -1 }

    /**
     * URL of better-sidebar's raw media route for one file.
     *
     * `/sidebar/file` streams the file's BYTES with the right content-type
     * (binary-safe), which is exactly what an `<img>`/`<iframe>` needs — the IDE
     * therefore renders images/PDFs with the same route the sidebar's own viewer
     * uses instead of re-implementing media handling.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @returns {string} the href.
     */
    function fileMediaUrl(scope, path, options) {
      var url = routeUrl('dsh-ris-ide/fs/file')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('path', path)
      // Showing a file that may have changed on disk (viewer image) wants a fresh
      // read. The Markdown preview passes `{ cacheBust: false }`: its URLs must stay
      // identical across renders, or React regenerates the preview HTML and the
      // scroll position jumps on every unrelated re-render.
      if (options === undefined || options === null || options.cacheBust !== false) {
        url.searchParams.set('t', String(Date.now()))
      }
      return url.href
    }

    /** Extension → colour kind for the file tree. */
    var FILE_KIND_BY_EXT = {
      java: 'java', kt: 'java', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', vue: 'js', ts: 'ts', tsx: 'ts',
      json: 'json', xml: 'xml', yml: 'yaml', yaml: 'yaml', properties: 'props', html: 'html', htm: 'html',
      css: 'css', scss: 'css', less: 'css', md: 'md', txt: 'doc', sql: 'sql', sh: 'sh', bat: 'sh',
      png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
      svg: 'image', pdf: 'pdf', zip: 'archive', jar: 'archive', gz: 'archive', tar: 'archive', py: 'js',
    }
    /** How each kind is coloured (works on light and dark pages). */
    var FILE_KIND_COLORS = {
      java: '#d19a66', js: '#e5c07b', ts: '#61afef', json: '#98c379', xml: '#56b6c2', yaml: '#c678dd',
      props: '#98c379', html: '#e06c75', css: '#56b6c2', doc: '#9aa5b1', sql: '#d19a66', sh: '#98c379',
      image: '#c678dd', pdf: '#e06c75', archive: '#d19a66', md: '#9ecbff', dot: '#8b949e', other: 'inherit',
    }
    /** The file types the "新建文件" menu offers. */
    var NEW_FILE_TYPES = [
      // First and un-suffixed: a file whose name is used exactly as typed
      // (`Makefile`, `.gitignore`, `README`, or any suffix the user writes).
      { ext: '', label: '普通文件' },
      { ext: 'java', label: 'Java 类' },
      { ext: 'js', label: 'JavaScript' },
      { ext: 'ts', label: 'TypeScript' },
      { ext: 'vue', label: 'Vue' },
      { ext: 'html', label: 'HTML' },
      { ext: 'xml', label: 'XML' },
      { ext: 'yml', label: 'YAML' },
      { ext: 'properties', label: 'Properties' },
      { ext: 'json', label: 'JSON' },
      { ext: 'md', label: 'Markdown' },
      { ext: 'sql', label: 'SQL' },
      { ext: 'css', label: 'CSS' },
      { ext: 'txt', label: '文本' },
    ]

    /**
     * Whether one document has unsaved edits.
     *
     * Once the text is mirrored (`doc.kind === 'text'`) the buffered text IS the
     * truth: comparing it with the saved copy makes Ctrl+Z back to the original
     * clear the `*` again. The toolbar's own flag is only a fallback for mounts
     * whose text has not been mirrored yet.
     * @param {object|undefined} doc - the document record (`{kind, text, saved}`).
     * @param {object|undefined} viewerState - the editor toolbar state.
     * @returns {boolean} true when the document differs from what was saved.
     */
    function docDirty(doc, viewerState) {
      if (doc !== undefined && doc.kind === 'text' && typeof doc.text === 'string') {
        return doc.text !== doc.saved
      }
      return viewerState !== undefined && viewerState.dirty === true
    }

    /**
     * The panel-wide chord that focuses the workspace search.
     * Ctrl+R was tried first but DSH itself binds it; Ctrl+F belongs to editors.
     * Ctrl/Cmd+Alt+F has no host binding, and F3 is the familiar "find" alias.
     */
    var GLOBAL_FIND_KEY = 'r'
    /** Longest single-line editor selection Ctrl+R turns into a workspace search. */
    var GLOBAL_FIND_SELECTION_MAX = 200

    /** Where the shortcut is documented, so the strings cannot drift apart. */
    var GLOBAL_FIND_LABEL = 'Ctrl+R / F3'

    /**
     * The IDE's "close the active source tab" chords.
     *
     * Browsers reserve Ctrl+W and do **not** let a page cancel it (Chrome, Edge and
     * Firefox all close the tab regardless of `preventDefault`), so the panel also
     * accepts chords that do reach the page: Alt+W and Ctrl+Alt+W — plus Ctrl+F4.
     * Ctrl/Cmd+W is still claimed, which works wherever the platform allows
     * interception (the DSH desktop shell).
     * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event - key facts.
     * @returns {boolean} true when the panel should close the active tab.
     */
    function closeTabChord(event) {
      var facts = event === undefined || event === null ? {} : event
      var key = String(facts.key === undefined || facts.key === null ? '' : facts.key).toLowerCase()
      var meta = facts.ctrlKey === true || facts.metaKey === true
      var alt = facts.altKey === true
      if (facts.shiftKey === true) return false
      if (key === 'f4') return meta
      if (key !== 'w') return false
      // Alt+W / Ctrl+Alt+W are not browser-reserved, so they always reach the page.
      if (alt) return true
      return meta
    }

    /**
     * Whether the browser would treat the keydown as a reload.
     *
     * The panel must suppress both forms even while an editor/input has focus
     * (Ctrl+R there would otherwise reload the whole GUI and lose the IDE state).
     * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event - key facts.
     * @returns {boolean} true for Ctrl/Cmd+R and Ctrl/Cmd+Shift+R.
     */
    function isBrowserReloadChord(event) {
      var facts = event === undefined || event === null ? {} : event
      var meta = facts.ctrlKey === true || facts.metaKey === true
      if (!meta || facts.altKey === true) return false
      var key = String(facts.key === undefined || facts.key === null ? '' : facts.key).toLowerCase()
      // Both forms are the IDE's: plain Ctrl+R is the find chord, and Ctrl+Shift+R
      // (the browser's hard reload) is swallowed by the same net so it cannot throw
      // the IDE away. event.key is 'R' while Shift is held, hence toLowerCase().
      return key === 'r'
    }

    /**
     * The chords DSH itself binds in the web GUI (read from its own catalog:
     * `dsh-client-ui-workspace` and `dsh-client-ui-shortcuts` defaults for
     * `web:linux` / `web:windows`).
     *
     * The IDE swallows exactly these — nothing else. Browser/native shortcuts
     * (F5, Ctrl+F5, F11, F12, Ctrl+Shift+I, Ctrl+P, …) keep working, and every
     * key the panel or the editor handles itself is untouched.
     */
    var DSH_CHORDS = new Set([
      'ctrl+/',            // shortcuts.open
      'ctrl+alt+,',        // settings.open
      'ctrl+n',            // session.new
      'ctrl+k',            // session.search
      'ctrl+o',            // workspace.add
      'ctrl+shift+o',      // workspace.openLocal
      'ctrl+alt+p',        // workspace.files
      'ctrl+alt+g',        // session.rename
      'ctrl+alt+f',        // session.fork (复制/分叉会话)
      'ctrl+shift+a',      // session.archive
      'ctrl+alt+b',        // sidebar.left.toggle (web)
      'ctrl+shift+b',      // sidebar.right.toggle (web)
      'ctrl+alt+t',        // browser.new
      'ctrl+`',            // terminal.new (Control+Backquote)
    ])

    /**
     * Canonical form of a keydown chord (`ctrl+shift+a`), for {@link DSH_CHORDS}.
     * `primary` is Ctrl on Windows/Linux and Cmd on macOS; both normalize to `ctrl`.
     * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event - key facts.
     * @returns {string} the normalized chord, or '' when no modifier is held.
     */
    function chordOf(event) {
      var facts = event === undefined || event === null ? {} : event
      var meta = facts.ctrlKey === true || facts.metaKey === true
      var alt = facts.altKey === true
      var shift = facts.shiftKey === true
      var key = String(facts.key === undefined || facts.key === null ? '' : facts.key).toLowerCase()
      if (key === '' || (!meta && !alt && !shift)) return ''
      var parts = []
      if (meta) parts.push('ctrl')
      if (alt) parts.push('alt')
      if (shift) parts.push('shift')
      parts.push(key)
      return parts.join('+')
    }

    /**
     * Whether a keydown is one of DSH's own chords and must not reach the host.
     * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, defaultPrevented?: boolean}} event - key facts.
     * @param {boolean} editable - true when the event comes from an input/contenteditable.
     * @returns {boolean} true when the panel should stop the event.
     */
    function shouldBlockHostChord(event, editable) {
      var facts = event === undefined || event === null ? {} : event
      if (facts.defaultPrevented === true) return false
      // The IDE's own find chord is handled by the panel, not blocked.
      if (isGlobalFindChord(facts)) return false
      // DSH chords are swallowed everywhere in the panel — some of them (sidebar
      // toggles) fire with `editable` focus too, and a text field never needs them.
      void editable
      var chord = chordOf(facts)
      if (chord === '') return false
      return DSH_CHORDS.has(chord)
    }

    /**
     * Whether a keydown is the IDE's workspace-search chord (Ctrl/Cmd+R).
     *
     * Ctrl+Shift+R counts as the same chord: it is the browser's HARD reload, and a
     * reload would throw the whole IDE away, so it has to land in the search box too.
     * Ctrl+F stays with the editor's own find panel.
     * @param {object} event - a KeyboardEvent-like object.
     * @returns {boolean} true for Ctrl+R / Cmd+R (Shift allowed).
     */
    function isGlobalFindChord(event) {
      var facts = event === undefined || event === null ? {} : event
      var key = String(facts.key === undefined || facts.key === null ? '' : facts.key).toLowerCase()
      var meta = facts.ctrlKey === true || facts.metaKey === true
      if (meta && facts.altKey !== true && key === GLOBAL_FIND_KEY) return true
      // F3 alone: the classic find key (no modifier, so typing is never affected).
      return facts.altKey !== true && facts.ctrlKey !== true && facts.metaKey !== true && key === 'f3'
    }

    // Ctrl+Alt+F is DSH's "Fork session" (复制/派生会话) and Ctrl+Alt+G renames:
    // both are swallowed inside the IDE (see shouldBlockHostChord).

    /**
     * Whether a Ctrl/Cmd+F keydown belongs to the IDE's WORKSPACE search.
     *
     * The editor keeps its own find panel: a keystroke that is already handled
     * (`defaultPrevented`), comes from an input/textarea/contenteditable (the
     * editor and the search box are all one of those), or has no real target
     * belongs to whoever had focus. Everything else is the panel-wide shortcut.
     * @param {{tagName?: string, isContentEditable?: boolean, defaultPrevented?: boolean}} target - the event facts.
     * @returns {boolean} true when the IDE should focus its search box.
     */
    function globalFindShouldFocusSearch(target) {
      var facts = target === undefined || target === null ? {} : target
      if (facts.defaultPrevented === true) return false
      var tag = String(facts.tagName === undefined || facts.tagName === null ? '' : facts.tagName).toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
      if (facts.isContentEditable === true) return false
      return true
    }

    /**
     * The text selected inside one of our CodeMirror editors.
     *
     * Ctrl+R normally focuses the workspace search box; when the editor has a
     * single-line selection it becomes the search query instead. A selection from
     * anywhere outside `.cm-content` (a log line, a path label) is ignored.
     * @returns {string} selected text, or '' when there is none / it is multiline.
     */
    function selectedEditorText() {
      if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return ''
      var selection = window.getSelection()
      if (selection === null || selection === undefined || selection.rangeCount === 0) return ''
      var text = String(selection.toString())
      if (text === '' || text.indexOf('\n') !== -1 || text.length > GLOBAL_FIND_SELECTION_MAX) return ''
      var node = selection.anchorNode
      var element = node === null || node === undefined ? null : (node.nodeType === 1 ? node : node.parentElement)
      if (element === null || element === undefined || typeof element.closest !== 'function') return ''
      if (element.closest('.cm-content') === null) return ''
      return text
    }

    /** The first non-empty line of a text block (find bars are single-line). */
    function firstSelectedLine(text) {
      var lines = String(text).split('\n')
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index].trim()
        if (line !== '') return line
      }
      return ''
    }

    /** Whether a DOM node (selection anchor/focus) lives inside `element`. */
    function selectionNodeInside(node, element) {
      if (node === null || node === undefined) return false
      var el = node.nodeType === 1 ? node : node.parentElement
      if (el === null || el === undefined || typeof element.contains !== 'function') return false
      return element.contains(el)
    }

    /**
     * The first non-empty line of the current selection, only when the whole
     * selection is inside `element` — used by Ctrl+F so the log viewer and the
     * plain-text fallback editor search for what the user highlighted.
     */
    function selectedLineTextIn(element) {
      if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return ''
      if (element === null || element === undefined) return ''
      var selection = window.getSelection()
      if (selection === null || selection === undefined || selection.rangeCount === 0) return ''
      var text = String(selection.toString())
      if (text === '' || text.length > GLOBAL_FIND_SELECTION_MAX) return ''
      if (!selectionNodeInside(selection.anchorNode, element) || !selectionNodeInside(selection.focusNode, element)) return ''
      return firstSelectedLine(text)
    }

    /**
     * A workspace path as the panels show it: relative under `cwd`.
     * @param {string} path - absolute path.
     * @param {string} cwd - the workspace root (a trailing separator is ignored).
     * @returns {string} the relative path, or the absolute one when outside.
     */
    function displayWorkspacePath(path, cwd) {
      var value = String(path === undefined || path === null ? '' : path)
      var root = String(cwd === undefined || cwd === null ? '' : cwd).replace(/[\\/]+$/, '')
      if (value === '' || root === '') return value
      if (value === root) return value
      if (value.indexOf(root + '/') === 0) return value.slice(root.length + 1)
      if (value.indexOf(root + '\\') === 0) return value.slice(root.length + 1)
      return value
    }

    /** Retry delays for an unreachable host: quick first, then calm. */
    var TREE_RETRY_DELAYS_MS = [800, 1600, 3200, 6000, 10000]

    /** Human text for a failed level read (a stopped host is not "HTTP 0"). */
    function treeErrorMessage(problem) {
      var text = messageOf(problem) || '未知错误'
      var status = problem !== null && problem !== undefined ? problem.status : undefined
      // Session switched away: the panel is bound to the old session id, and the
      // host rejects that id with 400 — retrying forever only spams the host.
      if (status === 400 || /unknown session|会话|bad-request/i.test(text)) {
        return '会话上下文已失效：切换会话后请重新打开 IDE 标签'
      }
      if (/failed to fetch|networkerror|load failed|fetch failed/i.test(text)) {
        return '目录读取失败：宿主未响应（dsh 可能已停止或正在重启），恢复后会自动重新加载'
      }
      return '目录读取失败：' + text
    }

    /**
     * Delay before the next automatic tree retry (capped at the last entry).
     * @param {number} attempt - 0-based retry attempt.
     * @returns {number} milliseconds to wait.
     */
    function treeRetryDelay(attempt) {
      var index = Math.max(0, Math.min(TREE_RETRY_DELAYS_MS.length - 1, Number(attempt) || 0))
      return TREE_RETRY_DELAYS_MS[index]
    }

    /**
     * Which LOADED tree levels a filesystem change should re-read.
     *
     * A recursive watcher reports every touched file. Refreshing the workspace
     * root for each of them (the old climb-to-loaded-ancestor rule) made the whole
     * tree re-render continuously while logs/builds churned, which is what made
     * expansion and the editor feel slow. Only the changed file's DIRECT parent
     * matters, and only when that level is on screen.
     * @param {object} levels - loaded levels keyed by absolute path.
     * @param {string} cwd - session workspace root.
     * @param {string} rootPath - tree root as rendered (usually the cwd or '.').
     * @param {string[]} relatives - watcher paths relative to the watched root.
     * @returns {string[]} absolute directories to reload (deduped).
     */
    function changedLevelsToRefresh(levels, cwd, rootPath, relatives) {
      // The tree root is normally rendered as '.', which must stay the cwd itself
      // (naive joining would produce `/w/./ris` and miss every loaded level).
      var rawRoot = String(rootPath === undefined || rootPath === null ? '' : rootPath)
      var root = rawRoot === '' || rawRoot === '.'
        ? String(cwd === undefined || cwd === null ? '' : cwd).replace(/[\\/]+$/, '')
        : absolutePath(cwd, rawRoot)
      var dirs = {}
      ;(Array.isArray(relatives) ? relatives : []).forEach(function (relative) {
        var absolute = absolutePath(root, String(relative))
        var parent = parentDirOf(absolute)
        // (0) the changed path IS a loaded folder (a directory event): reload its
        // own level; its parent's row is unchanged.
        if (levels[absolute] !== undefined) { dirs[absolute] = true; return }
        // (1) the changed file's own folder is on screen: reload it.
        if (levels[parent] !== undefined) { dirs[parent] = true; return }
        // (2) walk up to the nearest loaded level; reload it only when the child
        // on the way down is NEW there (a created folder/file), because a change
        // deep inside an unloaded folder changes nothing the tree currently draws.
        var cursor = absolute
        for (var depth = 0; depth < 64; depth += 1) {
          var up = parentDirOf(cursor)
          if (up === cursor) return
          var child = cursor
          cursor = up
          if (levels[up] === undefined) continue
          var known = false
          var entries = levels[up] || []
          for (var index = 0; index < entries.length; index += 1) {
            if (entries[index].path === child) { known = true; break }
          }
          if (!known) dirs[up] = true
          return
        }
      })
      return Object.keys(dirs)
    }

    /** Parent directory of a `/`-separated path (module scope twin of the tree's own). */
    function parentDirOf(path) {
      var value = String(path === undefined || path === null ? '' : path)
      var cut = value.lastIndexOf('/')
      return cut <= 0 ? value : value.slice(0, cut)
    }
    /** Minimum gap between two watcher-driven reloads of the same directory. */
    var TREE_REFRESH_THROTTLE_MS = 800

    /**
     * Whether two rendered levels draw exactly the same rows. A watcher event can
     * concern entries the tree hides (gitignored churn) or file content; re-rendering
     * an identical level would be a visible flash for no reason, so the reload is
     * skipped in that case.
     * @param {object[]|undefined} left - currently rendered entries.
     * @param {object[]|undefined} right - freshly read entries.
     * @returns {boolean} true when nothing the tree draws changed.
     */
    function sameTreeEntries(left, right) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false
      if (left.length !== right.length) return false
      for (var index = 0; index < left.length; index += 1) {
        var a = left[index] || {}
        var b = right[index] || {}
        if (a.path !== b.path) return false
        if ((a.isDir === true) !== (b.isDir === true)) return false
        if ((a.compact === true) !== (b.compact === true)) return false
        if ((a.label || a.name) !== (b.label || b.name)) return false
        if (a.kind !== b.kind) return false
      }
      return true
    }

    /** Deleted entries park here so Ctrl+Z can bring them back. */
    var TREE_TRASH_DIR = '.dsh-ris-ide-trash'

    /** The workspace's undo trash directory (created on first delete). */
    function trashDirFor(root) {
      return String(root === undefined || root === null ? '' : root).replace(/[\\/]+$/, '') + '/' + TREE_TRASH_DIR
    }

    /**
     * Unique parked name inside the trash; keeps the real basename at the end so
     * a restore is recognisable (`1730...-ModelHelper.java`).
     * @param {string} path - the deleted path.
     * @param {number} [stamp] - clock override (tests).
     * @returns {string} the basename to park under.
     */
    function trashNameFor(path, stamp) {
      return String(typeof stamp === 'number' ? stamp : Date.now()) + '-' + fileBaseName(path)
    }

    /**
     * Inline SVG icon data for the debug toolbar (Font Awesome 6 + VS Code step
     * glyphs, both MIT/CC-BY and already present in the profile's react-icons).
     * Inline instead of an icon dependency: a handful of paths, no runtime cost.
     */
    var IDE_ICONS = {
      bug: { viewBox: '0 0 512 512', inner: '<path d="M256 0c53 0 96 43 96 96l0 3.6c0 15.7-12.7 28.4-28.4 28.4l-135.1 0c-15.7 0-28.4-12.7-28.4-28.4l0-3.6c0-53 43-96 96-96zM41.4 105.4c12.5-12.5 32.8-12.5 45.3 0l64 64c.7 .7 1.3 1.4 1.9 2.1c14.2-7.3 30.4-11.4 47.5-11.4l112 0c17.1 0 33.2 4.1 47.5 11.4c.6-.7 1.2-1.4 1.9-2.1l64-64c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-64 64c-.7 .7-1.4 1.3-2.1 1.9c6.2 12 10.1 25.3 11.1 39.5l64.3 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-64 0c0 24.6-5.5 47.8-15.4 68.6c2.2 1.3 4.2 2.9 6 4.8l64 64c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0l-63.1-63.1c-24.5 21.8-55.8 36.2-90.3 39.6L272 240c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 239.2c-34.5-3.4-65.8-17.8-90.3-39.6L86.6 502.6c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3l64-64c1.9-1.9 3.9-3.4 6-4.8C101.5 367.8 96 344.6 96 320l-64 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l64.3 0c1.1-14.1 5-27.5 11.1-39.5c-.7-.6-1.4-1.2-2.1-1.9l-64-64c-12.5-12.5-12.5-32.8 0-45.3z"/>' },
      bugOff: { viewBox: '0 0 640 512', inner: '<path d="M38.8 5.1C28.4-3.1 13.3-1.2 5.1 9.2S-1.2 34.7 9.2 42.9l592 464c10.4 8.2 25.5 6.3 33.7-4.1s6.3-25.5-4.1-33.7L477.4 348.9c1.7-9.4 2.6-19 2.6-28.9l64 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-64.3 0c-1.1-14.1-5-27.5-11.1-39.5c.7-.6 1.4-1.2 2.1-1.9l64-64c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-64 64c-.7 .7-1.3 1.4-1.9 2.1C409.2 164.1 393.1 160 376 160l-112 0c-8.3 0-16.3 1-24 2.8L38.8 5.1zM320 0c-53 0-96 43-96 96l0 3.6c0 15.7 12.7 28.4 28.4 28.4l135.1 0c15.7 0 28.4-12.7 28.4-28.4l0-3.6c0-53-43-96-96-96zM160.3 256L96 256c-17.7 0-32 14.3-32 32s14.3 32 32 32l64 0c0 24.6 5.5 47.8 15.4 68.6c-2.2 1.3-4.2 2.9-6 4.8l-64 64c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l63.1-63.1c24.5 21.8 55.8 36.2 90.3 39.6l0-143.7L166.7 227.3c-3.4 9-5.6 18.7-6.4 28.7zM336 479.2c36.6-3.6 69.7-19.6 94.8-43.8L336 360.7l0 118.5z"/>' },
      play: { viewBox: '0 0 384 512', inner: '<path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/>' },
      rotate: { viewBox: '0 0 512 512', inner: '<path d="M463.5 224l8.5 0c13.3 0 24-10.7 24-24l0-128c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8l119.5 0z"/>' },
      playCircle: { viewBox: '0 0 512 512', inner: '<path d="M0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256zM188.3 147.1c-7.6 4.2-12.3 12.3-12.3 20.9l0 176c0 8.7 4.7 16.7 12.3 20.9s16.8 4.1 24.3-.5l144-88c7.1-4.4 11.5-12.1 11.5-20.5s-4.4-16.1-11.5-20.5l-144-88c-7.4-4.5-16.7-4.7-24.3-.5z"/>' },
      pauseCircle: { viewBox: '0 0 512 512', inner: '<path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM224 192l0 128c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-128c0-17.7 14.3-32 32-32s32 14.3 32 32zm128 0l0 128c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-128c0-17.7 14.3-32 32-32s32 14.3 32 32z"/>' },
      arrowsRotate: { viewBox: '0 0 512 512', inner: '<path d="M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160 352 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l111.5 0c0 0 0 0 0 0l.4 0c17.7 0 32-14.3 32-32l0-112c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 35.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1L16 432c0 17.7 14.3 32 32 32s32-14.3 32-32l0-35.1 17.6 17.5c0 0 0 0 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.8c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352l34.4 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L48.4 288c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z"/>' },
      stop: { viewBox: '0 0 384 512', inner: '<path d="M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128z"/>' },
      stepOver: { viewBox: '0 0 16 16', inner: '<path d="M9.99993 13C9.99993 14.103 9.10293 15 7.99993 15C6.89693 15 5.99993 14.103 5.99993 13C5.99993 11.897 6.89693 11 7.99993 11C9.10293 11 9.99993 11.897 9.99993 13ZM13.2499 2C12.8359 2 12.4999 2.336 12.4999 2.75V4.027C11.3829 2.759 9.75993 2 7.99993 2C5.03293 2 2.47993 4.211 2.06093 7.144C2.00193 7.554 2.28793 7.934 2.69793 7.993C2.73393 7.999 2.76993 8.001 2.80493 8.001C3.17193 8.001 3.49293 7.731 3.54693 7.357C3.86093 5.159 5.77593 3.501 8.00093 3.501C9.52993 3.501 10.9199 4.264 11.7439 5.501H9.75093C9.33693 5.501 9.00093 5.837 9.00093 6.251C9.00093 6.665 9.33693 7.001 9.75093 7.001H13.2509C13.6649 7.001 14.0009 6.665 14.0009 6.251V2.751C14.0009 2.337 13.6649 2.001 13.2509 2.001L13.2499 2Z"/>' },
      stepInto: { viewBox: '0 0 16 16', inner: '<path d="M10 13C10 14.103 9.10304 15 8.00004 15C6.89704 15 6.00004 14.103 6.00004 13C6.00004 11.897 6.89704 11 8.00004 11C9.10304 11 10 11.897 10 13ZM12.03 5.22C11.737 4.927 11.262 4.927 10.969 5.22L8.74904 7.44V1.75C8.74904 1.336 8.41304 1 7.99904 1C7.58504 1 7.24904 1.336 7.24904 1.75V7.439L5.02904 5.219C4.73604 4.926 4.26104 4.926 3.96804 5.219C3.67504 5.512 3.67504 5.987 3.96804 6.28L7.46804 9.78C7.61404 9.926 7.80604 10 7.99804 10C8.19004 10 8.38204 9.927 8.52804 9.78L12.028 6.28C12.321 5.987 12.321 5.512 12.028 5.219L12.03 5.22Z"/>' },
      stepOut: { viewBox: '0 0 16 16', inner: '<path d="M9.99802 13C9.99802 14.103 9.10102 15 7.99802 15C6.89502 15 5.99802 14.103 5.99802 13C5.99802 11.897 6.89502 11 7.99802 11C9.10102 11 9.99802 11.897 9.99802 13ZM12.03 4.71999L8.53002 1.21999C8.23702 0.926994 7.76202 0.926994 7.46902 1.21999L3.96902 4.71999C3.67602 5.01299 3.67602 5.48799 3.96902 5.78099C4.26202 6.07399 4.73702 6.07399 5.03002 5.78099L7.25002 3.56099V9.24999C7.25002 9.66399 7.58602 9.99999 8.00002 9.99999C8.41402 9.99999 8.75002 9.66399 8.75002 9.24999V3.56099L10.97 5.78099C11.116 5.92699 11.308 6.00099 11.5 6.00099C11.692 6.00099 11.884 5.92799 12.03 5.78099C12.323 5.48799 12.323 5.01299 12.03 4.71999Z"/>' },
      // LOG pane title-bar controls (the viewer body carries no bar since 1.6.1).
      wrap: {
        viewBox: '0 0 16 16', stroke: true,
        inner: '<path d="M1.5 3.5h13M1.5 8h8.2a2.6 2.6 0 1 1 0 5.2H7.4"/><path d="M9.2 11.6 7.4 13.2l1.8 1.6"/><path d="M1.5 12.5h4.2"/>',
      },
      follow: { viewBox: '0 0 384 512', inner: '<path d="M169.4 470.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 370.8 224 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 306.8L54.6 265.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z"/>' },
      // Tree title bar: the .gitignore toggle. An EYE reads as "what you see";
      // eye-off means "ignored files are shown too" (a funnel looked like a
      // random triangle in the 20px head row).
      eye: {
        viewBox: '0 0 16 16', stroke: true,
        inner: '<path d="M1.4 8s2.6-4.2 6.6-4.2S14.6 8 14.6 8 12 12.2 8 12.2 1.4 8 1.4 8z"/><circle cx="8" cy="8" r="1.9"/>',
      },
      eyeOff: {
        viewBox: '0 0 16 16', stroke: true,
        inner: '<path d="M1.4 8s2.6-4.2 6.6-4.2c1.3 0 2.5.4 3.5 1"/><path d="M14.6 8s-2.6 4.2-6.6 4.2c-1.3 0-2.5-.4-3.5-1"/><path d="M2.2 2.2l11.6 11.6"/>',
      },
    }

    /**
     * One inline icon.
     * @param {string} name - key of {@link IDE_ICONS}.
     * @param {number} size - square edge in px.
     * @returns {object|null} the svg element (null for an unknown name).
     */
    function ideIcon(name, size) {
      var box = IDE_ICONS[name]
      if (box === undefined) return null
      var edge = Number(size) > 0 ? Number(size) : 13
      var face = {
        viewBox: box.viewBox, width: edge, height: edge,
        'data-icon': name, style: { display: 'block' },
      }
      // Two icon families: solid fills (the debug toolbar) and stroked outlines
      // (the wrap glyph, which would lose its shape as a fill).
      if (box.stroke === true) {
        face.fill = 'none'
        face.stroke = 'currentColor'
        face.strokeWidth = 1.6
        face.strokeLinecap = 'round'
        face.strokeLinejoin = 'round'
      } else {
        face.fill = 'currentColor'
      }
      face.dangerouslySetInnerHTML = { __html: box.inner }
      return h('svg', face)
    }

    /**
     * A base icon with a small badge in its bottom-right corner (bug + ▶ / ⟳):
     * one glance tells "start debugging" from "debug again".
     * @param {string} base - base icon name.
     * @param {string} badge - badge icon name.
     * @param {number} size - square edge in px.
     * @returns {object} the composed element.
     */
    function ideBadgeIcon(base, badge, size) {
      var edge = Number(size) > 0 ? Number(size) : 14
      var badgeSize = Math.max(7, Math.round(edge * 0.52))
      return h('span', { style: { position: 'relative', display: 'inline-block', width: edge, height: edge }, 'data-icon': base + '+' + badge },
        h('span', { style: { position: 'absolute', inset: 0 } }, ideIcon(base, edge)),
        h('span', {
          style: {
            position: 'absolute', right: -2, bottom: -2, width: badgeSize, height: badgeSize,
            borderRadius: 2, background: 'Canvas', display: 'flex', alignItems: 'center', justifyContent: 'center',
          },
        }, ideIcon(badge, badgeSize - 1)))
    }

    /**
     * The help panel's content: grouped shortcuts plus a short how-to. Kept as
     * data (not JSX) so the panel and its test read the same source.
     * @returns {Array<{title: string, rows: Array<{keys: string, desc: string}>}>} sections.
     */
    function helpSections() {
      return [
        {
          title: '通用',
          rows: [
            { keys: 'Ctrl+S', desc: '保存当前文件' },
            { keys: 'Ctrl+W', desc: '关闭当前页签（有未保存修改会先确认）' },
            { keys: 'Ctrl+R / F3', desc: '聚焦工作空间文件检索框（面板内会屏蔽浏览器刷新；编辑器内 Ctrl+F 是文件内查找）' },
            { keys: 'Ctrl+W / Alt+W', desc: '关闭当前源码页签（浏览器抢占 Ctrl+W 时用 Alt+W，Ctrl+F4 亦可）' },
            { keys: '焦点在 IDE 内时', desc: 'DSH 自身的单修饰键快捷键被屏蔽，浏览器右键菜单也不弹出（编辑器/输入框内不拦截）' },
            { keys: '双击标题', desc: '最大化 / 还原该面板' },
            { keys: '拖分隔条', desc: '调整左列 / 调试区 / 下层的尺寸' },
          ],
        },
        {
          title: '文件树',
          rows: [
            { keys: '右键', desc: '新建文件（Java/JS/Vue/XML/YAML…）、新建文件夹、粘贴、复制、剪切、删除、刷新、复制文件名/路径' },
            { keys: 'Del', desc: '删除（移入回收站，可撤销）' },
            { keys: 'Ctrl+Z', desc: '撤销文件操作：删除 / 新建 / 粘贴 / 移动' },
            { keys: 'Ctrl+C / X / V', desc: '复制 / 剪切 / 粘贴' },
            { keys: '拖放', desc: '拖到文件夹或文件上移动（文件 = 移到它所在目录）；拖到树空白处移到工作区根' },
            { keys: '⟳ / ⌖', desc: '标题栏：刷新文件树 / 定位当前文件' },
          ],
        },
        {
          title: '编辑器',
          rows: [
            { keys: '右键', desc: '撤销/重做、剪切/复制/粘贴、全选、注释、缩进、删除行、插入行、上下移行、查找、转到行、保存' },
            { keys: 'Ctrl+Z / Ctrl+Shift+Z', desc: '撤销 / 重做（退回到保存内容时页签 * 消失）' },
            { keys: 'Ctrl+Shift+K', desc: '删除当前行' },
            { keys: 'Alt+↑ / Alt+↓', desc: '上移 / 下移当前行' },
            { keys: 'Ctrl+/', desc: '注释 / 取消注释' },
            { keys: 'Ctrl+F', desc: '查找 / 替换' },
            { keys: 'Ctrl+G', desc: '转到行' },
            { keys: 'Tab / Shift+Tab', desc: '增加 / 减少缩进' },
          ],
        },
        {
          title: '调试（仅 Java）',
          rows: [
            { keys: 'F5 / F6 / F7 / F8', desc: '步入 / 单步 / 步出 / 继续' },
            { keys: '双击行号', desc: '添加 / 删除断点' },
            { keys: 'bug + ▶', desc: '控制台行上的调试图标：以调试模式重启并挂上断点；bug + ⟳ 是重新调试' },
          ],
        },
        {
          title: '使用说明',
          rows: [
            { keys: '启动服务', desc: '控制台点该行的 ▶ 启动、■ 停止、调试图标（bug + ▶）；日志区自动跟随选中程序' },
            { keys: '看日志', desc: '只有运行中的程序流式加载日志；未运行也能看历史日志' },
            { keys: '配置文件', desc: '源码标题栏 📄 打开 .dsh-ris-ide.json（jvmArgs / startCommand），⚙ 按扫描结果更新' },
            { keys: '官方预览', desc: 'pdf / doc / xlsx 等会自动用 DSH 官方预览标签打开；.md / .html 在编辑器标题栏点 👁 预览' },
          ],
        },
      ]
    }

    /** Copy text through the async clipboard API, with a legacy fallback. */
    function copyText(text) {
      var value = String(text === undefined || text === null ? '' : text)
      try {
        if (typeof navigator !== 'undefined' && navigator !== null
          && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          void navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        // fall through to the textarea trick
      }
      try {
        var area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '1')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        var ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok === true
      } catch {
        return false
      }
    }

    /** Basename of a slash path ('' when empty). */
    function fileBaseName(path) {
      var value = String(path === undefined || path === null ? '' : path)
      var cut = value.lastIndexOf('/')
      return cut === -1 ? value : value.slice(cut + 1)
    }

    /**
     * Name of a duplicated copy, keeping the extension: `A.java` → `A - 副本.java`,
     * `Makefile` → `Makefile - 副本`, a folder `pkg` → `pkg - 副本`.
     * @param {string} name - the current file/folder name.
     * @param {boolean} isDir - folders have no extension to preserve.
     * @param {number} [index] - 1 for the first copy, 2 for `副本2`, …
     * @returns {string} the copy's name.
     */
    function duplicateName(name, isDir, index) {
      var raw = String(name === undefined || name === null ? '' : name).trim()
      if (raw === '') return ''
      var number = typeof index === 'number' && index > 1 ? String(Math.floor(index)) : ''
      var suffix = ' - 副本' + number
      if (isDir === true) return raw + suffix
      // Keep a dotfile (`.gitignore`) whole; otherwise insert before the last dot.
      var dot = raw.lastIndexOf('.')
      if (dot <= 0) return raw + suffix
      return raw.slice(0, dot) + suffix + raw.slice(dot)
    }

    /** Colour kind of one tree entry (`dir` for folders, `dot` for dot-entries). */
    function fileKind(entry) {
      if (entry === null || entry === undefined) return 'other'
      var rawName = String(entry.name || entry.path || '')
      var baseName = rawName.slice(rawName.lastIndexOf('/') + 1)
      // `.github`, `.gitignore`, `.vscode`… read as secondary/config entries: grey.
      if (baseName.charAt(0) === '.' && baseName.length > 1 && baseName !== '..') return 'dot'
      if (entry.isDir === true) return 'dir'
      var name = rawName
      var dot = name.lastIndexOf('.')
      if (dot <= 0) return 'other'
      return FILE_KIND_BY_EXT[name.slice(dot + 1).toLowerCase()] || 'other'
    }
    function fileKindColor(kind) { return FILE_KIND_COLORS[kind] || 'inherit' }

    /**
     * One-suffix file name: `Foo` + `java` → `Foo.java`, `Foo.java` stays as is,
     * and a name that already carries another known extension is left alone.
     * @param {string} raw - what the user typed.
     * @param {string} ext - the type's extension (without the dot).
     * @returns {string} the file name, or '' when empty.
     */
    function normalizeFileName(raw, ext) {
      var name = String(raw === undefined || raw === null ? '' : raw).trim()
      if (name === '') return ''
      var suffix = String(ext === undefined || ext === null ? '' : ext).replace(/^\.+/, '').toLowerCase()
      if (suffix === '') return name
      if (new RegExp('\\.' + suffix + '$', 'i').test(name)) return name
      // A dotfile (`.gitignore`) is a name, not a file type: leave it alone.
      if (name.charAt(0) === '.' && name.indexOf('.', 1) === -1) return name
      if (/\.[a-z0-9]{1,8}$/i.test(name)) return name
      return name.replace(/\.+$/, '') + '.' + suffix
    }

    /**
     * Absolute target of a new file: a package name (only meaningful under
     * `src/main/java`) becomes directories below the chosen folder.
     * @param {string} dir - absolute folder the menu was opened on.
     * @param {string} pkg - `cn.com.demo` or ''.
     * @param {string} name - file name as typed.
     * @param {string} ext - extension of the chosen type.
     * @returns {string} absolute file path ('' when the name is empty).
     */
    function newFilePath(dir, pkg, name, ext) {
      var file = normalizeFileName(name, ext)
      if (file === '') return ''
      var folder = String(dir === undefined || dir === null ? '' : dir).replace(/[\\/]+$/, '')
      var packagePath = String(pkg === undefined || pkg === null ? '' : pkg).trim()
        .replace(/^\.+/, '').replace(/\.+$/, '').replace(/\./g, '/')
      if (packagePath !== '') folder = folder + '/' + packagePath
      return folder + '/' + file
    }

    /**
     * Target of a new file under a Java source root: the dialog has ONE name field
     * and dots build the package folders — `cloud.test` (type Java class) creates
     * `cloud/` and `test.java` in it; `cn.com.Foo` creates `cn/com/Foo.java`.
     * Only the last dot-separated segment is the file; every segment must be a
     * legal Java identifier (a stray `..` or `/` is refused, not sanitized).
     * Types whose extension is added by the dialog expand dots; the un-suffixed
     * "普通文件" type keeps dots as part of the file name (`notes.md` stays a name).
     * @param {string} dir - absolute folder the menu was opened on.
     * @param {string} raw - name as typed.
     * @param {string} ext - extension of the chosen type ('' for 普通文件).
     * @returns {string} absolute file path ('' when invalid).
     */
    function javaFilePath(dir, raw, ext) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim()
      if (text === '') return ''
      var folder = String(dir === undefined || dir === null ? '' : dir).replace(/[\\/]+$/, '')
      if (String(ext === undefined || ext === null ? '' : ext) === '') {
        var literal = normalizeFileName(text, '')
        return literal === '' ? '' : folder + '/' + literal
      }
      var suffix = String(ext).replace(/^\.+/, '')
      if (new RegExp('\\.' + suffix + '$', 'i').test(text)) text = text.slice(0, -(suffix.length + 1))
      if (/[\\/]/.test(text)) return ''
      text = text.replace(/^\.+/, '').replace(/\.+$/, '')
      if (text === '') return ''
      var segments = text.split('.')
      for (var index = 0; index < segments.length; index += 1) {
        if (!/^[A-Za-z_$][\w$]*$/.test(segments[index])) return ''
      }
      var file = normalizeFileName(segments[segments.length - 1], ext)
      if (file === '') return ''
      var packagePath = segments.slice(0, -1).join('/')
      return folder + '/' + (packagePath === '' ? '' : packagePath + '/') + file
    }

    /**
     * The new location of a path after `from` was renamed/moved to `to`.
     * @param {string} path - a path that may sit under `from`.
     * @param {string} from - old absolute path (file or directory).
     * @param {string} to - new absolute path.
     * @returns {string} the remapped path (unchanged when unrelated).
     */
    function remapPath(path, from, to) {
      if (typeof path !== 'string' || path === '' || typeof from !== 'string' || from === '') return path
      if (path === from) return to
      var prefix = from.endsWith('/') ? from : from + '/'
      return path.startsWith(prefix) ? to + path.slice(from.length) : path
    }

    /** Whether a folder is inside a `src/main/java` source root. */
    function isJavaSourceDir(path) {
      return /(^|[\\/])src[\\/]main[\\/]java([\\/]|$)/.test(String(path === undefined || path === null ? '' : path))
    }

    /**
     * A package name (`cn.com.ris`) turned into a relative directory path
     * (`cn/com/ris`). Every segment must be a legal Java identifier and slashes
     * are refused, so a typo can never escape the folder the menu was opened on.
     * @param {string} raw - what the user typed (surrounding dots are ignored).
     * @returns {string} the relative directory path, or '' when it is not a package.
     */
    function packagePathOf(raw) {
      var text = String(raw === undefined || raw === null ? '' : raw).trim()
        .replace(/^\.+/, '').replace(/\.+$/, '')
      if (text === '') return ''
      var segments = text.split('.')
      for (var index = 0; index < segments.length; index += 1) {
        if (!/^[A-Za-z_$][\w$]*$/.test(segments[index])) return ''
      }
      return segments.join('/')
    }

    /**
     * The row the workspace-search dropdown highlights when results arrive.
     *
     * The host answers in `git ls-files` order, so the full file name the user typed
     * (`ModelHelper.java`) is not necessarily row 0 — the row whose NAME matches the
     * query exactly is what they mean, and only when there is none does row 0 win.
     * @param {{matches?: string[], dirs?: object}|null|undefined} hits - dropdown payload.
     * @param {string} query - the search box text.
     * @returns {number} index into `hits.matches`; -1 when there is nothing to highlight.
     */
    function searchHitActiveIndex(hits, query) {
      var matches = hits !== null && hits !== undefined && Array.isArray(hits.matches) ? hits.matches : []
      if (matches.length === 0) return -1
      var wanted = String(query === undefined || query === null ? '' : query).trim().toLowerCase()
      if (wanted !== '') {
        var dirs = hits.dirs !== null && hits.dirs !== undefined && typeof hits.dirs === 'object' ? hits.dirs : {}
        for (var index = 0; index < matches.length; index += 1) {
          var path = String(matches[index] === undefined || matches[index] === null ? '' : matches[index])
          if (dirs[path] === true) continue
          if (fileBaseName(path).toLowerCase() === wanted) return index
        }
      }
      return 0
    }

    /**
     * The toolbar search's dropdown: results hang directly UNDER the search box
     * (an absolutely-positioned panel), not inside the tree. Clicking a file opens
     * it and reveals it in the tree; clicking a directory just expands the tree to
     * it. `hits` is `{matches, dirs}` or `{error}`; `null` renders nothing.
     *
     * The highlighted row is `props.active` (an index into `hits.matches`), owned by
     * the panel so the arrow keys work while the SEARCH BOX keeps focus: hovering a
     * row only reports itself (`props.onHover`), it never touches focus or the caret.
     */
    function SearchResults(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var hits = props.hits
      var cwd = typeof props.cwd === 'string' ? props.cwd : ''
      var active = typeof props.active === 'number' ? props.active : -1
      // Keep the highlighted row inside the dropdown's OWN scroll box: the list is
      // `overflow:auto`, so its scrollTop moves and the page never scrolls.
      var listRef = useRef(null)
      useEffect(function () {
        var list = listRef.current
        if (list === null || list === undefined || typeof list.getBoundingClientRect !== 'function') return
        var row = typeof list.querySelector === 'function' ? list.querySelector('[data-search-hit-active="1"]') : null
        if (row === null) return
        var box = list.getBoundingClientRect()
        var rect = row.getBoundingClientRect()
        var next = revealScrollTop(rect.top, rect.bottom, box.top, box.bottom, list.scrollTop)
        if (next !== list.scrollTop) list.scrollTop = next
      }, [active, hits])
      if (hits === null || hits === undefined) return null
      var rows
      if (hits.error !== undefined) {
        rows = [h('div', { key: 'err', style: S.idePlaceholder }, '检索失败：' + hits.error)]
      } else if (!Array.isArray(hits.matches) || hits.matches.length === 0) {
        rows = [h('div', { key: 'none', style: S.idePlaceholder }, '没有匹配的文件')]
      } else {
        rows = hits.matches.map(function (path, index) {
          var isDir = hits.dirs !== undefined && hits.dirs !== null && hits.dirs[path] === true
          var isActive = index === active
          return h('div', {
            key: path,
            style: isActive ? Object.assign({}, S.searchRow, S.searchRowOn) : S.searchRow,
            title: path,
            'data-search-hit': isDir ? 'dir' : 'file',
            'data-search-hit-path': path,
            'data-search-hit-active': isActive ? '1' : '0',
            onMouseEnter: function () { if (typeof props.onHover === 'function') props.onHover(index) },
            onClick: function () { props.onPick(path, isDir) },
          },
            h('span', { style: { opacity: 0.55, flex: '0 0 auto' } }, isDir ? '▸' : '·'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, displayWorkspacePath(path, cwd)))
        })
      }
      return h('div', {
        ref: listRef,
        style: S.searchDropdown, 'data-search-results': '1',
        // Swallow the mousedown so picking a row cannot blur the search box: the
        // caret stays put and the user can keep typing (same trick as the history
        // list above).
        onMouseDown: function (event) { event.preventDefault() },
      },
        h('div', { style: S.searchHeader }, props.busy === true ? '检索中…' : ('匹配 ' + (hits.matches ? hits.matches.length : 0) + ' 个')),
        rows)
    }

    /**
     * A tree row's text: folded package chains (`cn.com.ris.cloud.model`) get their
     * separators drawn as their own spans, bold with a faint halo — at 12px on a
     * dark background a plain '.' is a single sub-pixel and reads as invisible.
     */
    function treeLabel(S, entry) {
      var label = entry.label || entry.name
      if (entry.compact !== true || typeof label !== 'string') return label
      var separator = label.indexOf('.') !== -1 ? '.' : '/'
      var parts = label.split(separator)
      if (parts.length < 2) return label
      var out = []
      parts.forEach(function (part, index) {
        if (index > 0) out.push(h('span', { key: 'sep' + index, style: S.foldSeparator }, separator))
        out.push(h('span', { key: 'part' + index }, part))
      })
      return out
    }

    /**
     * Left-top pane: the workspace directory tree (one level per expand, driven
     * by better-sidebar's `fs.tree`) plus a filename search (`fs.search`).
     * Clicking a file asks the parent to open it in the editor pane.
     */
    /**
     * A reminder appended to the start message when a program has no `jvmArgs`:
     * the JVM then picks `-Xmx` ≈ ¼ of physical RAM, which several concurrent
     * Spring services can turn into swapping.
     * @param {{jvmArgs?: string[]}} program - the program that just started.
     * @returns {string} '' when bounds are configured, else the hint.
     */
    function heapHint(program) {
      var args = program !== null && program !== undefined && Array.isArray(program.jvmArgs) ? program.jvmArgs : []
      if (args.length > 0) return ''
      return ' · 未配置 jvmArgs：JVM 最大堆默认≈内存/4，多开时建议在 .dsh-ris-ide.json 设 defaults.jvmArgs（如 ["-Xmx768m"]）'
    }

    /**
     * Whether a console row can open its log. Only a RUNNING service is writing
     * one; opening a stopped row used to produce an empty viewer plus a `/tail`
     * read of a file nobody appends to.
     * @param {{running?: {alive?: boolean}, hasLog?: boolean}|null} program - one console row.
     * @returns {boolean} true when the log should be loaded.
     */
    function canOpenLog(program) {
      if (program === null || program === undefined || typeof program !== 'object') return false
      if (program.hasLog === false) return false
      var running = program.running
      return running !== null && running !== undefined && running.alive === true
    }

    /**
     * Compact memory label for the console (`620 MB`, `1.8 GB`).
     * @param {number} bytes - resident bytes (0/unknown → empty string).
     * @returns {string} the label.
     */
    function formatMemory(bytes) {
      var value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ''
      var mb = value / (1024 * 1024)
      return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'
    }

    /** How many messages the session keeps for the status-bar log. */
    var MESSAGE_LIMIT = 200

    /**
     * `HH:MM:SS` for one timestamp (local time, zero-padded).
     * @param {number} at - epoch milliseconds.
     * @returns {string} the clock label, `--:--:--` for junk.
     */
    function formatClock(at) {
      var value = Number(at)
      if (!Number.isFinite(value)) return '--:--:--'
      var date = new Date(value)
      function pad(part) { return part < 10 ? '0' + part : String(part) }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /**
     * Keep the newest `limit` messages (oldest dropped first).
     * @param {object[]} list - `{id, text, at}`, oldest first.
     * @param {number} [limit] - max entries (defaults to {@link MESSAGE_LIMIT}).
     * @returns {object[]} a new array no longer than the limit.
     */
    function capMessages(list, limit) {
      var max = typeof limit === 'number' ? limit : MESSAGE_LIMIT
      if (!Array.isArray(list)) return []
      return list.length <= max ? list : list.slice(list.length - max)
    }

    /**
     * Drop ONE message from the session log (its own row button in the panel).
     * @param {object[]} list - `{id, text, at}`, oldest first.
     * @param {number|string} id - the message id to remove.
     * @returns {object[]} a new list without that message.
     */
    function dropMessage(list, id) {
      if (!Array.isArray(list)) return []
      return list.filter(function (message) { return message !== null && String(message.id) !== String(id) })
    }

    /**
     * Eclipse-style debug shortcuts: `F5` step into, `F6` step over, `F7` step
     * return (out), `F8` resume. Returns the engine action to run, or undefined
     * for any other key / when the state makes it meaningless.
     * @param {string} key - the `KeyboardEvent.key` value (e.g. 'F6').
     * @param {{attached?: boolean, suspended?: boolean}} state - debug state.
     * @returns {{kind: string, mode?: string}|undefined} what to run.
     */
    function debugShortcut(key, state) {
      if (state === null || state === undefined || state.attached !== true) return undefined
      if (key === 'F8') return { kind: 'run', mode: 'resume' }
      if (key === 'F5' || key === 'F6' || key === 'F7') {
        // A live session owns the whole F5..F8 row: F5 would otherwise reload
        // the window the moment the user clicks elsewhere (the CLI user asked
        // for exactly this). While the VM runs there is nothing to step, so the
        // key is swallowed instead of reaching the browser.
        if (state.suspended !== true) return { kind: 'swallow' }
        if (key === 'F5') return { kind: 'run', mode: 'step-into' }
        if (key === 'F6') return { kind: 'run', mode: 'step-over' }
        return { kind: 'run', mode: 'step-out' }
      }
      return undefined
    }

    /** How long a floating hint stays on screen before it fades away. */
    var TOAST_TTL_MS = 5000
    /** How many floating hints are kept at once (oldest is dropped first). */
    var TOAST_LIMIT = 5

    /**
     * Trim the toast list to its limit, dropping the OLDEST entries.
     * @param {object[]} list - `{id, text}` hints, oldest first.
     * @param {number} [limit] - max entries (defaults to {@link TOAST_LIMIT}).
     * @returns {object[]} a new array no longer than the limit.
     */
    function capToasts(list, limit) {
      var max = typeof limit === 'number' ? limit : TOAST_LIMIT
      if (!Array.isArray(list)) return []
      return list.length <= max ? list : list.slice(list.length - max)
    }

    /** Hard cap on tree nesting; a cyclic/broken listing must not blow the stack. */
    var TREE_MAX_DEPTH = 64
    /** Left padding (px) for one tree depth: 6px base, 11px per level. */
    var TREE_INDENT_STEP = 11
    /** Row indentation for a tree depth (depth 0 = the root level). */
    function treeIndent(depth) {
      return 6 + Math.max(0, depth) * TREE_INDENT_STEP
    }
    /** `{[path]: true}` primitive for ancestor-chain copies (keys may be any path). */
    function defineKey(path) {
      var out = {}
      out[path] = true
      return out
    }

    /**
     * The visible entry of ONE level that contains `filePath` (its own path, or a
     * prefix of it). Compaction means a single entry can stand for a whole raw
     * chain (`cn.com.ris.cloud.model`), so locate() must walk the RENDERED tree —
     * walking the raw path ancestors instead is what left folders empty when a
     * chain was folded.
     * @param {object[]} entries - one level's rows.
     * @param {string} filePath - absolute target file.
     * @returns {object|undefined} the directory entry to descend into.
     */
    function childEntryFor(entries, filePath) {
      if (!Array.isArray(entries)) return undefined
      var best
      for (var index = 0; index < entries.length; index += 1) {
        var entry = entries[index]
        if (entry === null || typeof entry !== 'object' || entry.isDir !== true) continue
        var base = String(entry.path || '').replace(/[\\/]+$/, '')
        if (base === '' || base === filePath) continue
        if (filePath === base || filePath.indexOf(base + '/') === 0) {
          if (best === undefined || base.length > String(best.path).length) best = entry
        }
      }
      return best
    }

    function IdeTree(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var scope = props ? props.scope : undefined
      var cwd = scope ? scope.cwd : undefined
      var rootPath = props.rootPath || cwd || '.'
      var [expanded, setExpanded] = useState(function () { return {} })
      /** Directories whose FIRST read is in flight (the twisty shows …). */
      var [levels, setLevels] = useState(function () { return {} })
      var [error, setError] = useState(undefined)
      /** A stale session (HTTP 400) is not retried: only reopening the tab helps. */
      var [treeFatal, setTreeFatal] = useState(false)
      var [degraded, setDegraded] = useState(false)
      var treeDismissals = useDismissedNotices()
      /** The row to scroll into view after a locate/search reveal. */
      var [reveal, setReveal] = useState(null)
      var revealNonceRef = useRef(0)
      /**
       * 展开一个**尚未加载过**的文件夹是两次提交：先插占位行（加载中…），
       * fetch 回来后再换成子行。第二次提交会让列表的 scroll 位置被重置
       * （表现为“点开文件夹，文件树跳到顶端”）。这里在点击时记下 scrollTop，
       * 并在随后的提交里恢复；只在一个短窗口内生效，避免外部刷新把它拽回去。
       */
      /**
       * Scroll watchdog. The tree list is an `overflow:auto` div and the browser /
       * React commits sometimes reset its `scrollTop` to 0 (expanding an unloaded
       * folder, a watcher refresh arriving later, the list node being replaced).
       * Instead of chasing every commit, remember the last position the HUMAN
       * ended up at and put the list back there whenever a commit moves it on its
       * own. While the user is actually scrolling (wheel / touch / keys / holding
       * the mouse down, incl. the scrollbar) every change is accepted, so the
       * watchdog never fights manual scrolling.
       */
      var treeListRef = useRef(null)
      var lastGoodTopRef = useRef(0)
      var userInputUntilRef = useRef(0)
      var pointerDownRef = useRef(false)
      var guardedListRef = useRef(null)
      function markUserInput() {
        userInputUntilRef.current = Date.now() + 600
      }
      /** Accept `top` as the new baseline (a user scroll, or an intentional reveal). */
      function rememberTop(top) {
        lastGoodTopRef.current = top
      }
      /**
       * Frame-level hold: some resets never go through a React commit (browser
       * scroll anchoring/clamping), so a per-frame check for a short window is the
       * only place that sees them. Skipped while the user is scrolling.
       */
      var holdUntilRef = useRef(0)
      var holdingRef = useRef(false)
      var holdFrameRef = useRef(null)
      if (holdFrameRef.current === null) {
        holdFrameRef.current = function () {
          var list = treeListRef.current
          if (list === null || Date.now() > holdUntilRef.current) {
            holdingRef.current = false
            // The hold is over: whatever position survived is the new baseline
            // (e.g. the level got shorter for a real reason: a folder collapsed).
            if (list !== null) lastGoodTopRef.current = list.scrollTop
            return
          }
          var userActive = pointerDownRef.current || Date.now() < userInputUntilRef.current
          if (!userActive && list.scrollTop !== lastGoodTopRef.current) {
            list.scrollTop = lastGoodTopRef.current
          }
          requestAnimationFrame(holdFrameRef.current)
        }
      }
      function holdScroll(ms) {
        if (typeof requestAnimationFrame !== 'function') return
        holdUntilRef.current = Math.max(holdUntilRef.current, Date.now() + (ms === undefined ? 5000 : ms))
        if (holdingRef.current) return
        holdingRef.current = true
        requestAnimationFrame(holdFrameRef.current)
      }
      var useLayoutEffect = React.useLayoutEffect || React.useEffect
      var treeListRef = useRef(null)

      /** Levels already being fetched (a double click must not fire two reads). */
      var inflightRef = useRef({})
      /**
       * Fetch one level and store it under ITS path.
       *
       * `path` is a parameter on purpose: a `setLevels` updater runs LATER (React
       * batches it), so writing `next[someLoopVariable]` inside the updater makes
       * every write land on whatever that variable ended up being — that bug put the
       * last listing under several keys and left expanded folders showing "（空）".
       * @param {string} path - absolute directory.
       * @returns {Promise<object[]>} the level's entries.
       */
      /** Tell the workbench whether this workspace has git (drives the toggle). */
      function reportTreeMeta(listing) {
        if (props !== null && props !== undefined && typeof props.onTreeMeta === 'function') {
          props.onTreeMeta({ git: listing.git === true, filtered: listing.filtered !== false })
        }
      }
      async function fetchLevel(path) {
        var listing = await fsTree(scope, path)
        reportTreeMeta(listing)
        setLevels(function (prev) { var next = Object.assign({}, prev); next[path] = listing.entries; return next })
        if (listing.degraded === true) setDegraded(true)
        return listing.entries
      }
      async function loadLevel(path, force, options) {
        var background = options !== undefined && options !== null && options.background === true
        var quiet = background || (options !== undefined && options !== null && options.quiet === true)
        // One request per directory at a time: an expand, a poll hit and a ⟳ share
        // the promise instead of doubling the wait.
        var existing = inflightRef.current[path]
        if (existing !== undefined) return existing
        var pending = (async function () {
          try {
            var listing = await fsTree(scope, path, force === true)
            reportTreeMeta(listing)
            // A poll whose signature changed can still describe the SAME rows
            // (gitignored churn, file content). Keep the old array, skip the render.
            if (sameTreeEntries(levelsRef.current[path], listing.entries)) {
              if (!background) setError(undefined)
              return true
            }
            setLevels(function (prev) { var next = Object.assign({}, prev); next[path] = listing.entries; return next })
            if (!background) setError(undefined)
            if (listing.degraded === true) setDegraded(true)
            return true
          } catch (problem) {
            // A background poll never pops an error banner: the old level stays,
            // and the signature baseline is reverted so the next tick retries.
            if (background) return false
            // The host's own message is the only diagnostic a user can act on, so
            // it is rendered in place of the tree (never swallowed).
            if (problem !== null && problem !== undefined && problem.status === 400) setTreeFatal(true)
            setError(treeErrorMessage(problem) + '（' + path + '）')
            return false
          } finally {
            delete inflightRef.current[path]
          }
        })()
        inflightRef.current[path] = pending
        return pending
      }
      useEffect(function () { void loadLevel(rootPath, false) }, [rootPath])

      /** Expand one directory level (idempotent) without opening a file. */
      async function expandDir(path) {
        if (levels[path] === undefined) await loadLevel(path, false)
        setExpanded(function (prev) { var next = Object.assign({}, prev); next[path] = true; return next })
        revealRow(absolutePath(cwd, path))
      }

      /**
       * Expand the RENDERED directory chain down to one file, then open it.
       *
       * Follows `childEntryFor` level by level, so a folded node
       * (`cn.com.ris.cloud.model`) is expanded as the ONE row it is instead of
       * walking absolute-path ancestors that no row represents — the old walk left
       * the branch empty. Depth is capped and a visited set stops on any repeat.
       * @param {string} target - file path (relative to `cwd` or absolute).
       */
      async function locate(target) {
        var filePath = absolutePath(cwd, target)
        var current = absolutePath(cwd, rootPath)
        var visited = {}
        for (var guard = 0; guard < 64; guard += 1) {
          if (visited[current] === true) break
          visited[current] = true
          var entries = levels[current]
          if (entries === undefined) {
            try {
              entries = await fetchLevel(current)
            } catch (problem) {
              break // best effort: the source pane still opens
            }
          }
          var next = childEntryFor(entries, filePath)
          if (next === undefined) break
          if (next.path === filePath) break
          var descend = next.path
          // Load BEFORE expanding: an expanded dir with no cached level renders the
          // "（空）" placeholder until the user collapses/re-expands it by hand.
          if (levels[descend] === undefined) {
            try { await fetchLevel(descend) } catch (problem) { /* best effort */ }
          }
          setExpanded(function (prev) { var state = Object.assign({}, prev); state[descend] = true; return state })
          current = descend
        }
        props.onOpen(filePath)
        revealRow(filePath)
      }

      /**
       * Scroll the tree so one row is visible (the search dropdown's "定位").
       *
       * Expanding the branch made the row EXIST but left the tree scrolled where it
       * was, so the located file was often below the fold and the vertical scrollbar
       * never moved. The list scrolls itself (it is the `overflow:auto` element), so
       * the row's offset is applied to that element, not to the window.
       * @param {string} path - absolute row path to reveal.
       */
      function revealRow(path) {
        revealNonceRef.current += 1
        setReveal({ path: path, nonce: revealNonceRef.current })
      }

      useEffect(function () {
        if (reveal === null) return undefined
        var list = treeListRef.current
        if (list === null) return undefined
        var attempts = 0
        var timer = null
        function attempt() {
          attempts += 1
          var rows = list.querySelectorAll('[data-tree-path]')
          for (var index = 0; index < rows.length; index += 1) {
            if (rows[index].getAttribute('data-tree-path') !== reveal.path) continue
            var rowRect = rows[index].getBoundingClientRect()
            var listRect = list.getBoundingClientRect()
            list.scrollTop = revealScrollTop(rowRect.top, rowRect.bottom, listRect.top, listRect.bottom, list.scrollTop)
            rememberTop(list.scrollTop)
            return
          }
          // The level may still be rendering (async fetch ⇒ one more pass).
          if (attempts < 12) timer = setTimeout(attempt, 60)
        }
        attempt()
        return function () { if (timer !== null) clearTimeout(timer) }
      }, [reveal])

      // Closing a file tab must also drop the tree's file selection: the row was
      // highlighted via `selectedPath`, which used to survive the close and leave
      // the file highlighted after its tab was gone.
      useEffect(function () {
        if (selectedPath === null) return
        if (!Array.isArray(props.openFiles)) return
        if (props.openFiles.indexOf(selectedPath) !== -1) return
        var entry = findEntry(selectedPath)
        if (entry.isDir === true) return
        setSelectedPath(null)
      }, [props.openFiles, selectedPath])

      // Opening ANOTHER file (tab click, history, search) must move the tree
      // selection with the editor: `selectedPath` used to keep highlighting the
      // previous file, so two rows looked selected at once. Directories stay
      // selectable — only an editor switch re-targets the selection.
      useEffect(function () {
        var active = typeof props.activePath === 'string' ? props.activePath : ''
        if (active === '') return
        if (selectedPath === active) return
        setSelectedPath(active)
      }, [props.activePath])

      // Keep the input listeners attached to whichever list node is current, and
      // reconcile `scrollTop` after every commit.
      var listInputRef = useRef(null)
      if (listInputRef.current === null) listInputRef.current = function (event) { markUserInput() }
      var listDownRef = useRef(null)
      if (listDownRef.current === null) {
        listDownRef.current = function (event) {
          // Row clicks select/open a file — they are NOT scrolling. Only a press
          // on the list itself (its scrollbar / empty area) hands control over.
          if (event !== null && event !== undefined && event.target !== treeListRef.current) return
          markUserInput()
          pointerDownRef.current = true
        }
      }
      var listScrollRef = useRef(null)
      if (listScrollRef.current === null) {
        listScrollRef.current = function () {
          var list = treeListRef.current
          if (list === null) return
          var userActive = pointerDownRef.current || Date.now() < userInputUntilRef.current
          if (userActive) {
            rememberTop(list.scrollTop)
            return
          }
          // No human input behind this scroll: it is a programmatic reset (focus,
          // commit, browser anchoring). Put it back immediately; the scroll event
          // fires after paint, so this also catches jumps a layout effect missed.
          if (list.scrollTop !== lastGoodTopRef.current) {
            // Do NOT accept a clamped value: the content is briefly shorter during
            // the refresh commit; the rAF hold/host commits will retry when the
            // rows are tall again.
            list.scrollTop = lastGoodTopRef.current
          }
        }
      }
      useLayoutEffect(function () {
        holdScroll(5000)
        var list = treeListRef.current
        if (guardedListRef.current !== list) {
          var previous = guardedListRef.current
          if (previous !== null) {
            previous.removeEventListener('wheel', listInputRef.current)
            previous.removeEventListener('touchstart', listInputRef.current)
            previous.removeEventListener('touchmove', listInputRef.current)
            previous.removeEventListener('keydown', listInputRef.current)
            previous.removeEventListener('pointerdown', listDownRef.current)
            previous.removeEventListener('mousedown', listDownRef.current)
            previous.removeEventListener('scroll', listScrollRef.current)
          }
          guardedListRef.current = list
          if (list !== null) {
            list.addEventListener('wheel', listInputRef.current, { passive: true })
            list.addEventListener('touchstart', listInputRef.current, { passive: true })
            list.addEventListener('touchmove', listInputRef.current, { passive: true })
            list.addEventListener('keydown', listInputRef.current)
            list.addEventListener('pointerdown', listDownRef.current)
            list.addEventListener('mousedown', listDownRef.current)
            list.addEventListener('scroll', listScrollRef.current, { passive: true })
          }
        }
        if (list !== null) {
          var top = list.scrollTop
          var userActive = pointerDownRef.current || Date.now() < userInputUntilRef.current
          if (userActive) {
            rememberTop(top)
          } else if (top !== lastGoodTopRef.current) {
            list.scrollTop = lastGoodTopRef.current
          }
        }
      })
      useEffect(function () {
        function up() { pointerDownRef.current = false }
        window.addEventListener('pointerup', up)
        window.addEventListener('mouseup', up)
        window.addEventListener('pointercancel', up)
        return function () {
          window.removeEventListener('pointerup', up)
          window.removeEventListener('mouseup', up)
          window.removeEventListener('pointercancel', up)
        }
      }, [])
      // The toolbar's search dropdown asks the tree to reveal a hit; the request
      // carries a nonce so picking the same file twice still re-runs this.
      var locateRequest = props.locateRequest
      useEffect(function () {
        if (locateRequest === null || locateRequest === undefined) return
        if (locateRequest.kind === 'dir') void expandDir(locateRequest.path)
        else void locate(locateRequest.path)
      }, [locateRequest === null || locateRequest === undefined ? 0 : locateRequest.nonce])

      // ── tree mutations: context menu, prompt, clipboard, drag&drop ────────
      /** Open context menu: `{entry, dir, x, y, sub}`. */
      var [treeMenu, setTreeMenu] = useState(null)
      /** Pending creation dialog: `{mode:'file'|'dir', dir, ext?, title}`. */
      var [prompt, setPrompt] = useState(null)
      var [promptName, setPromptName] = useState('')
      /** Pending delete confirmation: the entry to remove. */
      var [pendingDelete, setPendingDelete] = useState(null)
      /** Clipboard for copy/cut: `{mode, path, isDir, name}`. */
      var [clipboard, setClipboard] = useState(null)
      var [selectedPath, setSelectedPath] = useState(null)
      var [dropTarget, setDropTarget] = useState(null)
      /** LIFO of invertible file operations (Ctrl+Z). Ref: no re-render needed. */
      var undoStackRef = useRef([])
      var promptInputRef = useRef(null)
      /** Auto-retry bookkeeping for an unreachable/reloading host. */
      var treeRetryRef = useRef({ attempt: 0, timer: null })
      var levelsRef = useRef(levels)
      levelsRef.current = levels
      /** Per-directory throttle for watcher-driven reloads. */
      var treeRefreshAtRef = useRef({})
      var treeRefreshTimersRef = useRef({})
      /** A tree frame arrived while the page was hidden: reload once on return. */
      var treeDirtyRef = useRef(false)

      /** The parent folder of a path (the tree only needs string maths). */
      function parentOf(path) {
        var value = String(path === undefined || path === null ? '' : path)
        var cut = value.lastIndexOf('/')
        return cut <= 0 ? value : value.slice(0, cut)
      }
      /** Look one entry up in the levels already loaded. */
      function findEntry(path) {
        var keys = Object.keys(levels)
        for (var index = 0; index < keys.length; index += 1) {
          var list = levels[keys[index]] || []
          for (var scan = 0; scan < list.length; scan += 1) {
            if (list[scan].path === path) return list[scan]
          }
        }
        var name = String(path).slice(String(path).lastIndexOf('/') + 1)
        return { path: path, name: name, isDir: false }
      }
      function notify(message) {
        if (props !== null && props !== undefined && typeof props.onNote === 'function') props.onNote(message)
      }
      /** Re-read one directory level in the background (no spinner, no banner). */
      async function refreshLevel(dirPath) {
        await loadLevel(dirPath, true, { background: true })
      }
      /** Reload the root and every expanded folder (title-bar ⟳ / recovery). */
      async function refreshTree() {
        var paths = [absolutePath(cwd, rootPath)].concat(Object.keys(expanded).filter(function (path) { return expanded[path] === true }))
        var failed = 0
        for (var index = 0; index < paths.length; index += 1) {
          var ok = await loadLevel(paths[index], true)
          if (ok === false) failed += 1
        }
        // The button re-reads silently otherwise (no spinner/loading state), so a
        // short toast is the only confirmation that the click did something.
        notify(failed === 0
          ? '文件树已刷新'
          : ('文件树刷新失败 ' + failed + ' 个目录（其余已更新）'))
      }
      useEffect(function () {
        if (props.refreshNonce === undefined || props.refreshNonce === null || props.refreshNonce === 0) return undefined
        void refreshTree()
        return undefined
      }, [props.refreshNonce])

      /**
       * Refresh the levels touched by a `tree` frame: for each changed relative
       * path take its folder, climb to the deepest directory we already loaded,
       * and reload that one level. A changed path outside the loaded tree is
       * ignored (nothing to redraw).
       */
      function refreshChanged(relatives) {
        changedLevelsToRefresh(levels, cwd, rootPath, relatives).forEach(function (dir) {
          var now = Date.now()
          var last = treeRefreshAtRef.current[dir] || 0
          if (now - last < TREE_REFRESH_THROTTLE_MS) {
            // Coalesce: one trailing reload per window instead of a burst.
            if (treeRefreshTimersRef.current[dir] !== undefined) return
            treeRefreshTimersRef.current[dir] = setTimeout(function () {
              delete treeRefreshTimersRef.current[dir]
              treeRefreshAtRef.current[dir] = Date.now()
              void refreshLevel(dir)
            }, TREE_REFRESH_THROTTLE_MS - (now - last))
            return
          }
          treeRefreshAtRef.current[dir] = now
          void refreshLevel(dir)
        })
      }
      useEffect(function () {
        if (typeof window === 'undefined' || typeof EventSource !== 'function') return undefined
        if (props.visible === false) return undefined
        if (scope === undefined || scope === null || typeof scope.sessionId !== 'string') return undefined
        var openedBefore = false
        return risStreamHub().subscribe({
          topics: ['tree'],
          sessionId: scope.sessionId,
          cwd: typeof scope.cwd === 'string' ? scope.cwd : undefined,
          onOpen: function () {
            // A reconnect means the host is back: reload what is on screen so a
            // banner left over from the outage disappears by itself.
            if (openedBefore) void recoverTree()
            openedBefore = true
          },
          handlers: {
            tree: function (payload) {
              if (payload === null || payload.ok !== true) return
              if (!Array.isArray(payload.changed)) return
              // A background tab does not need to re-render the tree: remember that
              // something changed and do ONE reload when the page is visible again.
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                treeDirtyRef.current = true
                return
              }
              refreshChanged(payload.changed)
            },
          },
        })
      }, [props.visible, scope.sessionId, scope.cwd])
      useEffect(function () {
        return function () {
          Object.keys(treeRefreshTimersRef.current).forEach(function (dir) {
            clearTimeout(treeRefreshTimersRef.current[dir])
          })
          treeRefreshTimersRef.current = {}
        }
      }, [])


      // Returning to the tab flushes the hidden-tab tree changes once.
      useEffect(function () {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        function onVisible() {
          if (document.visibilityState === 'hidden') return
          if (!treeDirtyRef.current) return
          treeDirtyRef.current = false
          void recoverTree()
        }
        document.addEventListener('visibilitychange', onVisible)
        return function () { document.removeEventListener('visibilitychange', onVisible) }
      }, [])

      /** Reload the root (and every expanded level) after the host comes back. */
      async function recoverTree() {
        var paths = [rootPath].concat(Object.keys(expanded).filter(function (path) { return expanded[path] === true }))
        for (var index = 0; index < paths.length; index += 1) await loadLevel(paths[index], true)
      }
      // While an error is on screen, keep retrying by itself: stopping dsh used to
      // leave a dead "重试" banner that survived the host coming back.
      useEffect(function () {
        if (error === undefined) {
          treeRetryRef.current.attempt = 0
          setTreeFatal(false)
          return undefined
        }
        // A stale session id never recovers by itself: do not hammer the host.
        if (treeFatal === true) return undefined
        if (treeRetryRef.current.timer !== null) return undefined
        var attempt = treeRetryRef.current.attempt
        var delay = treeRetryDelay(attempt)
        var timer = setTimeout(function () {
          treeRetryRef.current.timer = null
          treeRetryRef.current.attempt = attempt + 1
          void recoverTree()
        }, delay)
        treeRetryRef.current.timer = timer
        return function () {
          if (treeRetryRef.current.timer !== null) {
            clearTimeout(treeRetryRef.current.timer)
            treeRetryRef.current.timer = null
          }
        }
      }, [error, expanded, treeFatal])
      // Coming back to the tab is also a recovery signal (the host may have been
      // restarted while the page sat in the background).
      useEffect(function () {
        if (typeof window === 'undefined') return undefined
        function onWake() {
          if (document.visibilityState === 'hidden') return
          if (error === undefined) return
          void recoverTree()
        }
        window.addEventListener('focus', onWake)
        document.addEventListener('visibilitychange', onWake)
        return function () {
          window.removeEventListener('focus', onWake)
          document.removeEventListener('visibilitychange', onWake)
        }
      }, [error, expanded])

      function openCreatePrompt(mode, dir, ext) {
        setTreeMenu(null)
        var label = mode === 'dir'
          ? '新建文件夹'
          : mode === 'package'
            ? '新建包名'
            : (String(ext || '') === '' ? '新建普通文件' : ('新建 ' + String(ext).toUpperCase() + ' 文件'))
        setPrompt({ mode: mode, dir: dir, ext: ext || '', title: label })
        setPromptName('')

      }
      useEffect(function () {
        if (prompt === null || promptInputRef.current === null) return
        promptInputRef.current.focus()
        promptInputRef.current.select()
      }, [prompt])

      async function submitPrompt() {
        if (prompt === null) return
        var name = promptName.trim()
        if (name === '') return
        try {
          if (prompt.mode === 'duplicate') {
            var source = prompt.entry
            if (name === (source.name || fileBaseName(source.path))) {
              notify('副本名称不能与原文件相同')
              return
            }
            if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
              notify('文件名不能包含 / 或 \\')
              return
            }
            await duplicateEntry(source, name)
            setPrompt(null)
            return
          }
          if (prompt.mode === 'rename') {
            var entry = prompt.entry
            var parent = parentOf(entry.path)
            if (name === entry.name) { setPrompt(null); return }
            if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
              notify('文件名不能包含 / 或 \\')
              return
            }
            await fsMoveEntry(scope, entry.path, parent, name)
            var renamed = parent.replace(/[\\/]+$/, '') + '/' + name
            rememberUndo('重命名 ' + entry.name + ' → ' + name, async function () {
              await fsMoveEntry(scope, renamed, parent, entry.name)
              await refreshLevel(parent)
              remapRenamed(renamed, entry.path)
            })
            await refreshLevel(parent)
            setSelectedPath(renamed)
            remapRenamed(entry.path, renamed)
            setPrompt(null)
            return
          }
          if (prompt.mode === 'paste') {
            if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
              notify('文件名不能包含 / 或 \\')
              return
            }
            var pasteDir = prompt.dir
            var pasteSource = prompt.source
            // A colliding paste asked for a DIFFERENT name: keeping the old one
            // would just bounce back to this prompt forever.
            if (prompt.conflict !== undefined && name === prompt.conflict) {
              notify('「' + name + '」已存在，请改个名字')
              return
            }
            setPrompt(null)
            await runPaste(pasteSource, pasteDir, name)
            return
          }
          if (prompt.mode === 'package') {
            var packageRelative = packagePathOf(name)
            if (packageRelative === '') {
              notify('包名不合法：如 cn.com.ris')
              return
            }
            var packageBase = prompt.dir.replace(/[\\/]+$/, '')
            var packageDir = packageBase + '/' + packageRelative
            await fsMkdir(scope, packageDir)
            rememberUndo('新建包 ' + name, async function () {
              await fsRemoveEntry(scope, packageDir, false)
              await refreshLevel(packageBase)
            })
            await refreshLevel(packageBase)
            setExpanded(function (prev) { var next = Object.assign({}, prev); next[packageBase] = true; return next })
            setSelectedPath(packageDir)
            setPrompt(null)
            return
          }
          if (prompt.mode === 'dir') {
            var dirPath = prompt.dir.replace(/[\\/]+$/, '') + '/' + name
            await fsMkdir(scope, dirPath)
            rememberUndo('新建文件夹 ' + name, async function () {
              await fsRemoveEntry(scope, dirPath, false)
              await refreshLevel(prompt.dir)
            })
            await refreshLevel(prompt.dir)
            setExpanded(function (prev) { var next = Object.assign({}, prev); next[prompt.dir] = true; return next })
          } else {
            // Inside a Java source root the single name field carries the package
            // too: `cloud.test` → `cloud/test.java`. Non-Java folders keep the
            // plain "file name (+ optional type suffix)" behaviour.
            var target = isJavaSourceDir(prompt.dir)
              ? javaFilePath(prompt.dir, name, prompt.ext)
              : newFilePath(prompt.dir, '', name, prompt.ext)
            if (target === '') {
              if (isJavaSourceDir(prompt.dir)) notify('名称不合法：如 cloud.test')
              return
            }
            await fsCreateFile(scope, target, '')
            rememberUndo('新建文件 ' + fileBaseName(target), async function () {
              await fsRemoveEntry(scope, target, false)
              await refreshLevel(parentOf(target))
            })
            await refreshLevel(parentOf(target))
            props.onOpen(target)
          }
          setPrompt(null)
        } catch (problem) {
          notify((prompt.mode === 'duplicate' ? '复制副本失败：' : prompt.mode === 'rename' ? '重命名失败：' : prompt.mode === 'paste' ? '粘贴失败：' : prompt.mode === 'dir' ? '新建文件夹失败：' : '新建文件失败：') + messageOf(problem))
        }
      }

      /** Renamed paths must travel to the workbench (tabs, drafts, history). */
      function remapRenamed(from, to) {
        if (typeof props.onRename === 'function') props.onRename(from, to)
      }

      /** Copy `entry` to `name` inside its own folder (the duplicate dialog's action). */
      async function duplicateEntry(entry, name) {
        if (entry === null || entry === undefined) return
        var copyName = String(name === undefined || name === null ? '' : name).trim()
        if (copyName === '') return
        var dir = parentOf(entry.path)
        if (copyName.includes('/') || copyName.includes('\\') || copyName === '.' || copyName === '..') return
        var answer = await fsCopyEntry(scope, entry.path, dir, copyName)
        var copied = answer !== null && answer !== undefined && typeof answer.path === 'string'
          ? answer.path
          : dir.replace(/[\\/]+$/, '') + '/' + copyName
        rememberUndo('复制 ' + fileBaseName(entry.path) + ' 为 ' + copyName, async function () {
          await fsRemoveEntry(scope, copied, true)
          await refreshLevel(dir)
        })
        await refreshLevel(dir)
        setSelectedPath(copied)
      }

      /** Ask for a new name for a tree entry (file or folder). */
      function openRenamePrompt(entry) {
        if (entry === null || entry === undefined || typeof entry.path !== 'string') return
        setTreeMenu(null)
        setPrompt({ mode: 'rename', dir: parentOf(entry.path), ext: '', title: '重命名', entry: entry })
        setPromptName(entry.name || fileBaseName(entry.path))
      }

      function beginCopy(mode) {
        // Ctrl+C / Ctrl+X arrive with no context menu open, so resolve the entry
        // from the tree selection as well — the keyboard used to no-op silently
        // (only the right-click menu ever worked).
        var entry = treeMenu !== null && treeMenu.entry !== null && treeMenu.entry !== undefined
          ? treeMenu.entry
          : (selectedPath === null ? null : findEntry(selectedPath))
        if (entry === null || entry === undefined) return
        setClipboard({ mode: mode, path: entry.path, isDir: entry.isDir === true, name: entry.name || entry.path })
        setTreeMenu(null)
        notify((mode === 'copy' ? '已复制 ' : '已剪切 ') + (entry.name || entry.path))
      }

      /** Whether a failed host call was the "target exists" collision. */
      function isExistsProblem(problem) {
        return String(problem !== null && problem !== undefined && problem.code !== undefined ? problem.code : '') === 'exists'
      }

      /** Leaf name a paste would create for one source. */
      function pasteEntryName(source, requestedName) {
        if (typeof requestedName === 'string' && requestedName.trim() !== '') return requestedName.trim()
        if (source.kind === 'clipboard' && clipboard !== null) return fileBaseName(clipboard.path)
        if (source.kind === 'file' && source.file !== undefined) return String(source.file.name || '')
        if (source.kind === 'path') return fileBaseName(source.path)
        return ''
      }

      /**
       * Park a colliding paste and ask for a different leaf name.
       *
       * A collision is not a failure and not a 覆盖 question: the source is still
       * on disk, so the only way forward is a new name. The prompt is prefilled with
       * the tree's own 副本 convention (`A.java` → `A - 副本.java`) and refuses to
       * resubmit the colliding name (see the prompt's `paste` branch).
       * @param {object} source - the paste source (`clipboard` | `file` | `path`).
       * @param {string} dir - absolute destination directory.
       * @param {string} name - the leaf name that already exists there.
       */
      function parkPasteName(source, dir, name) {
        notify('「' + name + '」已存在，请改个名字')
        setPrompt({ mode: 'paste', dir: dir, ext: '', title: '粘贴为', source: source, conflict: name })
        setPromptName(duplicateName(name, false))
      }

      /**
       * Perform ONE paste (tree clipboard, an uploaded `File`, or an outside path).
       *
       * A collision does not just fail: it opens the 粘贴为 prompt with a 副本 name,
       * because the source is still on disk and the only way forward is a different
       * leaf name. Pasting a CUT entry back into its own folder is silently ignored —
       * that is a no-op, not an error, and it must never be mistaken for "overwrite
       * the source". Pasting a COPY onto its own path is NOT a no-op either: it falls
       * through to the same prompt, i.e. "duplicate under a new name".
       * @param {object} source - `{kind:'clipboard'}` | `{kind:'file', file}` |
       *  `{kind:'path', path}`.
       * @param {string} dir - absolute destination directory.
       * @param {string} [requestedName] - explicit leaf name (改名 flow), else derived.
       * @returns {Promise<string|undefined>} the created path, or undefined.
       */
      async function runPaste(source, dir, requestedName) {
        var name = pasteEntryName(source, requestedName)
        if (name === '') return undefined
        var trimmedDir = dir.replace(/[\\/]+$/, '')
        var target = trimmedDir + '/' + name
        var from = source.kind === 'clipboard' && clipboard !== null ? clipboard.path : ''
        if (source.kind === 'clipboard' && target === from && clipboard.mode !== 'copy') {
          // Cut → its own folder: a no-op, not an error. A copy onto its own path is
          // the user asking for a duplicate, so it falls through to the 409 below.
          return undefined
        }
        try {
          if (source.kind === 'clipboard') {
            if (clipboard.mode === 'copy') {
              await fsCopyEntry(scope, from, dir, name)
            } else {
              await fsMoveEntry(scope, from, dir, name)
            }
          } else if (source.kind === 'file') {
            await fsUpload(scope, dir, name, source.file)
          } else {
            await fsImportPath(scope, dir, source.path, name)
          }
        } catch (problem) {
          if (isExistsProblem(problem)) {
            parkPasteName(source, dir, name)
            return undefined
          }
          notify('粘贴失败：' + messageOf(problem))
          return undefined
        }
        if (source.kind === 'clipboard' && clipboard.mode === 'move') {
          var originParent = parentOf(from)
          rememberUndo('粘贴 ' + name, async function () {
            await fsMoveEntry(scope, target, originParent, fileBaseName(from))
            await refreshLevel(originParent)
            await refreshLevel(dir)
          })
          setClipboard(null)
        } else {
          rememberUndo('粘贴 ' + name, async function () {
            await fsRemoveEntry(scope, target, true)
            await refreshLevel(dir)
          })
        }
        await refreshLevel(dir)
        var sourceDir = from === '' ? '' : parentOf(from)
        if (source.kind === 'clipboard' && sourceDir !== trimmedDir) await refreshLevel(sourceDir)
        setExpanded(function (prev) { var next = Object.assign({}, prev); next[trimmedDir] = true; return next })
        setSelectedPath(target)
        return target
      }

      /** Paste the tree's own clipboard into `dirPath`. */
      async function pasteInto(dirPath) {
        if (clipboard === null) return
        await runPaste({ kind: 'clipboard' }, dirPath, undefined)
      }

      /**
       * Import OS-clipboard content (a `paste` with no tree clipboard): `File`
       * blobs go up as raw bytes, `file://`/path text goes through `/fs/import`.
       * Files that already exist stop at the first collision and open the same
       * 粘贴为 prompt as a tree paste.
       * @param {string} dir - absolute destination directory.
       * @param {File[]} files - pasted blobs (may be empty).
       * @param {string[]} paths - parseClipboardPaths() result (may be empty).
       */
      async function importExternal(dir, files, paths) {
        var imported = 0
        var total = files.length + paths.length
        for (var index = 0; index < total; index += 1) {
          var source = index < files.length
            ? { kind: 'file', file: files[index] }
            : { kind: 'path', path: paths[index - files.length] }
          var created = await runPaste(source, dir, undefined)
          if (created === undefined) break
          imported += 1
        }
        if (imported > 0) notify('已导入 ' + imported + ' 个文件')
      }

      /**
       * The tree list's `paste` handler. The tree only prevents the browser's
       * default paste when it actually imports something: an ordinary text paste
       * still behaves like a text paste.
       * @param {ClipboardEvent} event - paste event on the focused tree.
       */
      function handleTreePaste(event) {
        var transfer = event.clipboardData
        if (transfer === null || transfer === undefined) return
        var files = []
        try { files = Array.prototype.slice.call(transfer.files || []) } catch { files = [] }
        var dir = pasteTargetDir()
        if (files.length > 0) {
          event.preventDefault()
          void importExternal(dir, files, [])
          return
        }
        var text = ''
        try { text = transfer.getData('text/uri-list') || '' } catch { text = '' }
        if (text.trim() === '') { try { text = transfer.getData('text/plain') || '' } catch { text = '' } }
        var paths = parseClipboardPaths(text)
        if (paths.length === 0) return
        event.preventDefault()
        void importExternal(dir, [], paths)
      }
      /** Remember one inverse operation for Ctrl+Z (bounded: 50 entries). */
      function rememberUndo(label, run) {
        undoStackRef.current.push({ label: label, run: run })
        if (undoStackRef.current.length > 50) undoStackRef.current.shift()
      }
      /** Invert the most recent file operation. */
      async function undoLast() {
        var item = undoStackRef.current.pop()
        if (item === undefined) {
          notify('没有可撤销的文件操作')
          return
        }
        try {
          await item.run()
        } catch (problem) {
          notify('撤销失败：' + messageOf(problem))
        }
      }

      async function removeEntry(entry) {
        try {
          // Delete = move into <workspace>/.dsh-ris-ide-trash, so Ctrl+Z restores
          // it and nothing is lost by a mis-click.
          var rootDir = absolutePath(cwd, rootPath)
          var trash = trashDirFor(rootDir)
          await fsMkdir(scope, trash)
          var parked = trashNameFor(entry.path)
          await fsMoveEntry(scope, entry.path, trash, parked)
          await refreshLevel(parentOf(entry.path))
          rememberUndo('删除 ' + (entry.name || fileBaseName(entry.path)), async function () {
            await fsMoveEntry(scope, trash + '/' + parked, parentOf(entry.path), fileBaseName(entry.path))
            await refreshLevel(parentOf(entry.path))
          })
          if (selectedPath === entry.path) setSelectedPath(null)
          notify('已移到回收站 ' + (entry.name || fileBaseName(entry.path)) + '（Ctrl+Z 撤销）')
        } catch (problem) {
          notify('删除失败：' + messageOf(problem))
        } finally {
          setPendingDelete(null)
        }
      }
      async function moveInto(from, dirPath) {
        if (from === dirPath || parentOf(from) === dirPath) return
        try {
          await fsMoveEntry(scope, from, dirPath)
          var moved = dirPath.replace(/[\\/]+$/, '') + '/' + fileBaseName(from)
          rememberUndo('移动 ' + fileBaseName(from), async function () {
            await fsMoveEntry(scope, moved, parentOf(from), fileBaseName(from))
            await refreshLevel(dirPath)
            await refreshLevel(parentOf(from))
          })
          await refreshLevel(dirPath)
          await refreshLevel(parentOf(from))
        } catch (problem) {
          notify('移动失败：' + messageOf(problem))
        } finally {
          setDropTarget(null)
        }
      }
      /** Folder a paste should land in: the selection itself, or its parent. */
      function pasteTargetDir() {
        if (selectedPath === null) return absolutePath(cwd, rootPath)
        var entry = findEntry(selectedPath)
        return entry.isDir === true ? entry.path : parentOf(entry.path)
      }

      // Del / Ctrl+C / Ctrl+X / Ctrl+V while the IDE is on screen. Typing in the
      // prompt (or the editor) is ignored: those keys belong to the field.
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        if (props.visible === false) return undefined
        function onKey(event) {
          var target = event.target
          if (target !== null && target !== undefined) {
            var tag = String(target.tagName || '').toUpperCase()
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true) return
          }
          // The tree only claims Del/Ctrl+C/X/V while it owns the focus: selecting
          // text in the log and pressing Ctrl+C must reach the browser's copy, not
          // the tree's file clipboard.
          var root = treeListRef.current
          var active = typeof document !== 'undefined' ? document.activeElement : null
          var inside = root !== null && (
            (target !== null && target !== undefined && typeof root.contains === 'function' && root.contains(target))
            || active === root
          )
          if (!inside) return
          if (prompt !== null || pendingDelete !== null) return
          if (selectedPath === null) return
          var meta = event.ctrlKey || event.metaKey
          if (event.key === 'F2') {
            event.preventDefault()
            openRenamePrompt(findEntry(selectedPath))
            return
          }
          if (event.key === 'Delete') {
            event.preventDefault()
            setPendingDelete(findEntry(selectedPath))
            return
          }
          if (meta && (event.key === 'z' || event.key === 'Z') && event.shiftKey !== true) {
            event.preventDefault()
            void undoLast()
            return
          }
          if (meta && (event.key === 'a' || event.key === 'A')) {
            // The tree is single-selection, so 全选 has nothing to expand into.
            // Claim the key anyway: unclaimed, the browser selected the whole page
            // and the following Ctrl+C copied that page text instead of the file.
            event.preventDefault()
            return
          }
          if (meta && (event.key === 'c' || event.key === 'C')) {
            event.preventDefault()
            beginCopy('copy')
            return
          }
          if (meta && (event.key === 'x' || event.key === 'X')) {
            event.preventDefault()
            beginCopy('cut')
            return
          }
          if (meta && (event.key === 'v' || event.key === 'V')) {
            // External content (OS files / file paths) has no tree clipboard;
            // leave the key alone so the browser fires `paste` and
            // `handleTreePaste` can import it. Only our own clipboard is ours.
            if (clipboard === null) return
            event.preventDefault()
            void pasteInto(pasteTargetDir())
          }
        }
        window.addEventListener('keydown', onKey, true)
        return function () { window.removeEventListener('keydown', onKey, true) }
      }, [selectedPath, clipboard, prompt, pendingDelete, expanded, levels, treeMenu])

      // A click anywhere else closes the menu.
      useEffect(function () {
        if (treeMenu === null || typeof window === 'undefined') return undefined
        function onDown(event) {
          var target = event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function'
            && target.closest('[data-tree-menu="1"]') !== null) return
          setTreeMenu(null)
        }
        window.addEventListener('mousedown', onDown)
        return function () { window.removeEventListener('mousedown', onDown) }
      }, [treeMenu])

      function toggle(entry) {
        if (!entry.isDir) {
          props.onOpen(entry.path)
          return
        }
        var list = treeListRef.current
        if (expanded[entry.path] === true) {
          setExpanded(function (prev) { var next = Object.assign({}, prev); next[entry.path] = false; return next })
          return
        }
        var path = entry.path
        if (levels[path] !== undefined) {
          setExpanded(function (prev) { var next = Object.assign({}, prev); next[path] = true; return next })
            return
        }
        // Load BEFORE expanding with NO intermediate state at all: setting a
        // busy flag/loading state re-rendered the row (▸ → … → ▾) and then the
        // children, which reads as a flash. One commit, children ready.
        void (async function () {
          try {
            var ok = await loadLevel(path, false, { quiet: true })
            if (ok === false) return
            setExpanded(function (prev) { var next = Object.assign({}, prev); next[path] = true; return next })
          } catch (problem) {
            note('展开目录失败：' + messageOf(problem))
          }
        })()
      }
      /**
       * Flatten the visible tree into rows.
       *
       * `chain` carries the absolute paths on the CURRENT branch: a row whose path
       * repeats an ancestor (or nesting beyond {@link TREE_MAX_DEPTH}) is dropped
       * instead of recursing — a malformed/cyclic listing then renders flat rather
       * than throwing `Maximum call stack size exceeded` through the panel.
       * @param {string} path - absolute directory whose level is rendered.
       * @param {number} depth - current nesting depth.
       * @param {object} [ancestors] - paths already on this branch.
       * @returns {Array} React rows.
       */
      function rowsFor(path, depth, ancestors, rendered) {
        if (depth > TREE_MAX_DEPTH) return []
        var chain = ancestors === undefined ? {} : ancestors
        var seen = rendered === undefined ? {} : rendered
        var indent = treeIndent(depth)
        var entries = levels[path]
        if (entries === undefined) {
          return [h('div', { key: 'load-' + path, style: Object.assign({}, S.treeRow, { paddingLeft: indent }) }, h('span', { style: { opacity: 0.5 } }, '（空）'))]
        }
        var out = []
        entries.forEach(function (entry) {
          // One absolute path renders ONCE. Stale/overlapping expanded keys (an old
          // raw-path walk, a collapsed chain) used to draw the same folder twice;
          // the guard also makes any residual cycle terminate flat.
          if (seen[entry.path] === true) return
          seen[entry.path] = true
          var open = expanded[entry.path] === true
          var isActive = props.activePath === entry.path
          var isRevealed = reveal !== null && reveal.path === entry.path
          var isSelected = selectedPath === entry.path
            && (entry.isDir === true || !Array.isArray(props.openFiles) || props.openFiles.indexOf(entry.path) !== -1)
          // Dropping ON a file means "into the folder that file lives in" — a row
          // is always a drop target; only the expand/collapse toggle is dir-only.
          var dropDir = entry.isDir === true ? entry.path : parentOf(entry.path)
          var isDropTarget = dropTarget === entry.path
          out.push(h('div', {
            key: entry.path,
            style: Object.assign({}, isActive || isRevealed || isSelected ? S.treeRowOn : S.treeRow, {
              paddingLeft: indent,
              boxShadow: isDropTarget ? 'inset 0 0 0 1px #d29922' : undefined,
            }),
            title: entry.path + '（右键：新建/粘贴/复制/剪切/删除/刷新）',
            'data-tree-path': entry.path,
            'data-tree-revealed': isRevealed ? '1' : undefined,
            'data-tree-selected': isSelected ? '1' : undefined,
            'data-tree-drop': isDropTarget ? '1' : undefined,
            draggable: true,
            onDragStart: function (event) {
              try {
                event.dataTransfer.setData('text/plain', entry.path)
                event.dataTransfer.effectAllowed = 'move'
              } catch {
                // older engines: the drop handler re-reads the selection
              }
              setSelectedPath(entry.path)
            },
            onDragOver: function (event) {
              event.preventDefault()
              try { event.dataTransfer.dropEffect = 'move' } catch { /* ignore */ }
              if (dropTarget !== entry.path) setDropTarget(entry.path)
            },
            onDragLeave: function () {
              if (dropTarget === entry.path) setDropTarget(null)
            },
            onDrop: function (event) {
              event.preventDefault()
              event.stopPropagation()
              var external = []
              try { external = Array.prototype.slice.call(event.dataTransfer.files || []) } catch { external = [] }
              if (external.length > 0) {
                void importExternal(dropDir, external, [])
                setDropTarget(null)
                return
              }
              var from = ''
              try { from = event.dataTransfer.getData('text/plain') } catch { from = '' }
              if (from === '') from = selectedPath === null ? '' : selectedPath
              if (from !== '' && from !== entry.path) void moveInto(from, dropDir)
              setDropTarget(null)
            },
            onClick: function () {
              setSelectedPath(entry.path)
              toggle(entry)
              if (treeListRef.current !== null) treeListRef.current.focus({ preventScroll: true })
            },
            onContextMenu: function (event) {
              event.preventDefault()
              event.stopPropagation()
              setSelectedPath(entry.path)
              setTreeMenu({
                entry: entry,
                dir: entry.isDir === true ? entry.path : parentOf(entry.path),
                x: event.clientX, y: event.clientY, sub: 'main',
              })
            },
          },
            h('span', {
              style: Object.assign({}, S.treeTwist, entry.isDir === true ? { cursor: 'pointer' } : {}),
              // The triangle only toggles; the row (name) also selects. Without the
              // explicit stopPropagation the same click ran the row's handler too,
              // which is what made the two click targets feel different.
              'data-tree-twisty': entry.isDir === true ? (open ? 'open' : 'closed') : undefined,
              // Same outcome as clicking the row: select + expand/collapse. The
              // stopPropagation only prevents the row handler running twice.
              onClick: entry.isDir === true
                ? function (event) { event.stopPropagation(); setSelectedPath(entry.path); toggle(entry) }
                : undefined,
            }, entry.isDir ? (open ? '▾' : '▸') : ''),
            h('span', {
              style: {
                overflow: 'hidden', textOverflow: 'ellipsis',
                color: fileKind(entry) === 'dot' ? fileKindColor('dot') : (entry.isDir === true ? undefined : fileKindColor(fileKind(entry))),
                opacity: fileKind(entry) === 'dot' ? 0.85 : undefined,
              },
              'data-file-kind': fileKind(entry),
            }, treeLabel(S, entry))))
          if (entry.isDir && open && chain[entry.path] !== true) {
            out = out.concat(rowsFor(entry.path, depth + 1, Object.assign({}, chain, defineKey(entry.path)), seen))
          }
        })
        return out
      }

      /** The row context menu (main list or the "new file" sub-list). */
      function renderTreeMenu() {
        if (treeMenu === null) return null
        var items
        if (treeMenu.sub === 'new') {
          items = [h('div', { key: 'hint', style: S.searchHeader }, '新建文件')]
          NEW_FILE_TYPES.forEach(function (type) {
            items.push(h('button', {
              key: 'new-' + type.ext, type: 'button', style: S.tabMenuItem, 'data-tree-new': type.ext,
              onClick: function () { openCreatePrompt('file', treeMenu.dir, type.ext) },
            }, type.ext === '' ? type.label : (type.label + '  .' + type.ext)))
          })
        } else {
          items = [
            h('button', { key: 'new-file', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'new-file', onClick: function () { setTreeMenu(function (prev) { return prev === null ? prev : Object.assign({}, prev, { sub: 'new' }) }) } }, '新建文件 ▸'),
            h('button', { key: 'new-dir', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'new-dir', onClick: function () { openCreatePrompt('dir', treeMenu.dir) } }, '新建文件夹'),
            // Packages only exist under a Java source root: reveal the action only there
            // (elsewhere a dotted name would just be a weird folder name).
            isJavaSourceDir(treeMenu.dir)
              ? h('button', { key: 'new-package', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'new-package', title: '按「.」创建多级包目录', onClick: function () { openCreatePrompt('package', treeMenu.dir) } }, '新建包名')
              : null,
            h('button', {
              key: 'paste', type: 'button', 'data-tree-action': 'paste',
              style: clipboard === null ? Object.assign({}, S.tabMenuItem, { opacity: 0.45 }) : S.tabMenuItem,
              disabled: clipboard === null,
              title: clipboard === null ? '剪贴板为空' : ('粘贴「' + clipboard.name + '」到 ' + treeMenu.dir),
              onClick: function () {
                if (clipboard === null) return
                var dir = treeMenu.dir
                setTreeMenu(null)
                void pasteInto(dir)
              },
            }, '粘贴'),
            h('button', {
              key: 'rename', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'rename',
              title: '重命名（F2）',
              onClick: function () { openRenamePrompt(treeMenu.entry) },
            }, '重命名'),
            h('button', {
              key: 'copy', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'copy',
              title: '复制到剪贴板（Ctrl+C；到目标目录再用粘贴）',
              onClick: function () { beginCopy('copy') },
            }, '复制'),
            h('button', {
              key: 'duplicate', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'duplicate',
              title: '在当前目录生成一份副本（同名会先让你确认名称）',
              onClick: function () {
                var entry = treeMenu.entry
                setTreeMenu(null)
                setPrompt({ mode: 'duplicate', dir: parentOf(entry.path), ext: '', title: '创建副本', entry: entry })
                setPromptName(duplicateName(entry.name || fileBaseName(entry.path), entry.isDir === true, 1))
              },
            }, '创建副本'),
            h('button', { key: 'cut', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'cut', onClick: function () { beginCopy('cut') } }, '剪切'),
            h('button', { key: 'delete', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'delete', onClick: function () { setPendingDelete(treeMenu.entry); setTreeMenu(null) } }, '删除'),
            h('button', {
              key: 'copy-name', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'copy-name',
              onClick: function () {
                var entry = treeMenu.entry
                setTreeMenu(null)
                notify(copyText(fileBaseName(entry.path)) ? '已复制文件名：' + fileBaseName(entry.path) : '复制失败：剪贴板不可用')
              },
            }, '复制文件名'),
            h('button', {
              key: 'copy-path', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'copy-path',
              onClick: function () {
                var entry = treeMenu.entry
                setTreeMenu(null)
                notify(copyText(entry.path) ? '已复制路径：' + entry.path : '复制失败：剪贴板不可用')
              },
            }, '复制文件路径'),
            h('button', {
              key: 'refresh', type: 'button', style: S.tabMenuItem, 'data-tree-action': 'refresh',
              onClick: function () { var dir = treeMenu.dir; setTreeMenu(null); void refreshLevel(dir) },
            }, '刷新'),
          ]
        }
        return h('div', {
          style: Object.assign({}, S.tabMenu, { left: treeMenu.x, top: treeMenu.y, position: 'fixed', zIndex: 900, minWidth: 150 }),
          'data-tree-menu': '1',
          onMouseDown: function (event) { event.stopPropagation() },
        }, items)
      }

      /** The "new file/folder" dialog (name + optional package). */
      function renderTreePrompt() {
        if (prompt === null) return null
        var isFile = prompt.mode === 'file'
        var isPackage = prompt.mode === 'package'
        var isRename = prompt.mode === 'rename'
        var isDuplicate = prompt.mode === 'duplicate'
        var isPaste = prompt.mode === 'paste'
        var preview = isRename || isDuplicate || isPaste
          ? prompt.dir.replace(/[\\/]+$/, '') + '/' + (promptName === '' ? '<新名称>' : promptName)
          : isFile
            ? (isJavaSourceDir(prompt.dir)
              ? javaFilePath(prompt.dir, promptName === '' ? '<包名>.<名称>' : promptName, prompt.ext)
              : newFilePath(prompt.dir, '', promptName === '' ? '<名称>' : promptName, prompt.ext))
            : isPackage
              ? prompt.dir.replace(/[\\/]+$/, '') + '/' + (promptName === '' ? '<包名>' : (packagePathOf(promptName) || promptName))
              : ''
        return h('div', {
          style: { position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,0.32)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
          'data-tree-prompt': prompt.mode,
          onMouseDown: function (event) { if (event.target === event.currentTarget) setPrompt(null) },
        },
          h('div', { style: { width: 380, maxWidth: '92vw', background: 'Canvas', color: 'inherit', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: 6, boxShadow: '0 18px 48px rgba(0,0,0,0.4)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'system-ui, sans-serif', fontSize: 12 } },
            h('div', { style: { fontWeight: 600 } }, prompt.title),
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('span', { style: { opacity: 0.7 } }, isRename ? '新名称' : isDuplicate ? '副本名称' : isPaste ? '新名称' : isFile ? '文件名' : isPackage ? '包名' : '文件夹名'),
              h('input', {
                ref: promptInputRef, type: 'text', value: promptName,
                placeholder: isRename || isDuplicate || isPaste
                  ? (isDuplicate ? '默认「xxx - 副本」' : '新名称')
                  : isFile
                    ? (prompt.ext === ''
                      ? '如 Makefile、README'
                      : isJavaSourceDir(prompt.dir)
                        ? '如 ModelHelper 或 cloud.test'
                        : '如 ModelHelper')
                    : isPackage
                      ? '如 cn.com.ris'
                      : '如 model-new',
                style: S.headSearch, 'data-tree-prompt-name': '1',
                onChange: function (event) { setPromptName(event.target.value) },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') { event.preventDefault(); void submitPrompt() }
                  else if (event.key === 'Escape') { event.preventDefault(); setPrompt(null) }
                },
              })),
            isFile || isPackage || isRename || isDuplicate || isPaste
              ? h('div', { style: Object.assign({}, S.meta, { wordBreak: 'break-all' }), 'data-tree-prompt-path': '1' }, preview)
              : null,
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
              h('button', { type: 'button', style: S.buttonOff, onClick: function () { setPrompt(null) } }, '取消'),
              h('button', { type: 'button', style: S.button, 'data-tree-prompt-ok': '1', onClick: function () { void submitPrompt() } }, '确定'))))
      }

      /** The delete confirmation (recursive for folders). */
      function renderTreeConfirm() {
        if (pendingDelete === null) return null
        var isDir = pendingDelete.isDir === true
        return h('div', {
          style: { position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,0.32)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
          'data-tree-confirm': '1',
        },
          h('div', { style: { width: 340, maxWidth: '92vw', background: 'Canvas', color: 'inherit', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', borderRadius: 6, boxShadow: '0 18px 48px rgba(0,0,0,0.4)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'system-ui, sans-serif', fontSize: 12 } },
            h('div', { style: { fontWeight: 600 } }, isDir ? '删除文件夹？' : '删除文件？'),
            h('div', { style: { opacity: 0.75, wordBreak: 'break-all' } }, pendingDelete.path + (isDir ? '（连同内容）' : '')),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
              h('button', { type: 'button', style: S.buttonOff, onClick: function () { setPendingDelete(null) } }, '取消'),
              h('button', { type: 'button', style: Object.assign({}, S.button, { color: '#e5534b' }), 'data-tree-confirm-ok': '1', onClick: function () { void removeEntry(pendingDelete) } }, '删除'))))
      }

      return h('div', { style: S.treeWrap, 'data-ide-tree': '1' },
        degraded === true && treeDismissals.isOpen('tree-degraded', 'v1')
          ? h(ClosableNotice, {
            styles: S, kind: 'tree-degraded', signature: 'v1', onDismiss: treeDismissals.dismiss,
          },
            '宿主进程版本较旧：目录读取已回退（无 .gitignore 过滤/包名折叠）。重启 ',
            h('code', null, 'dsh web'),
            ' 后启用。')
          : null,
        error !== undefined
          ? h('div', { style: Object.assign({}, S.error, { display: 'flex', alignItems: 'center', gap: 6 }), role: 'alert', 'data-tree-error': '1' },
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, error + '（正在自动重试…）'),
            h('button', { type: 'button', style: S.button, 'data-tree-retry': '1', title: '立即重新读取', onClick: function () { void recoverTree() } }, '重试'),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-notice-close': 'tree-error', title: '关闭这条提示',
              onClick: function () { setError(undefined) },
            }, '×'))
          : null,
        h('div', {
          ref: treeListRef, style: Object.assign({}, S.treeList, { outline: 'none' }), 'data-tree-root': rootPath,
          tabIndex: -1,
          onClick: function () { setTreeMenu(null) },
          onPaste: handleTreePaste,
          onDragOver: function (event) { event.preventDefault() },
          onDrop: function (event) {
            event.preventDefault()
            var rootDir = absolutePath(cwd, rootPath)
            var external = []
            try { external = Array.prototype.slice.call(event.dataTransfer.files || []) } catch { external = [] }
            if (external.length > 0) { void importExternal(rootDir, external, []); return }
            var from = ''
            try { from = event.dataTransfer.getData('text/plain') } catch { from = '' }
            if (from === '') from = selectedPath === null ? '' : selectedPath
            if (from !== '' && parentOf(from) !== rootDir) void moveInto(from, rootDir)
          },
        }, rowsFor(rootPath, 0, {}, {})),
        renderTreeMenu(),
        renderTreePrompt(),
        renderTreeConfirm())
    }

    /**
     * Right-top pane: the opened TEXT file — editable on arrival.
     *
     * The workbench owns the document (`docs[path] = {text, saved}`), so this is a
     * controlled view: switching tabs keeps an unsaved draft, the tab's `*` comes
     * from `text !== saved`, and Ctrl/Cmd+S asks the parent to write the file.
     * The line-number gutter doubles as the breakpoint control (click an
     * unmarked line adds, double-click a marked line removes) and stays glued to
     * the textarea's scroll.
     */
    function IdeEditor(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var text = typeof props.text === 'string' ? props.text : ''
      var lines = text.split('\n')
      var areaRef = useRef(null)
      var [findOpen, setFindOpen] = useState(false)
      var [findText, setFindText] = useState('')
      var [replaceText, setReplaceText] = useState('')
      var [findNote, setFindNote] = useState(undefined)
      /** Selection to apply once a replace has landed (the text prop updates). */
      var pendingSelRef = useRef(null)
      useEffect(function () {
        var pending = pendingSelRef.current
        if (pending === null) return
        pendingSelRef.current = null
        var area = areaRef.current
        if (area === null || area === undefined) return
        area.focus()
        area.setSelectionRange(pending.start, pending.end)
      }, [text])
      /** Select the next occurrence (wrapping once) — the fallback editor's find. */
      function findNext() {
        var area = areaRef.current
        if (area === null || area === undefined || findText === '') return
        var from = typeof area.selectionEnd === 'number' ? area.selectionEnd : 0
        var index = text.indexOf(findText, from)
        if (index === -1) index = text.indexOf(findText)
        if (index === -1) { setFindNote('没有匹配'); return }
        area.focus()
        area.setSelectionRange(index, index + findText.length)
        setFindNote(undefined)
      }
      var marked = {}
      ;(props.breakpoints || []).forEach(function (bp) { marked[bp.line] = true })
      var innerRef = useRef(null)
      function syncScroll(event) {
        var inner = innerRef.current
        if (inner !== null && inner !== undefined) inner.style.transform = 'translateY(-' + event.target.scrollTop + 'px)'
      }
      /** Replace the current match (or the next one) in THIS file only. */
      function replaceOne() {
        var area = areaRef.current
        if (area === null || area === undefined || findText === '') return
        var from = area.selectionStart
        var to = area.selectionEnd
        var selected = text.slice(from, to)
        var start = selected === findText ? from : text.indexOf(findText, from)
        if (start === -1) start = text.indexOf(findText)
        if (start === -1) { setFindNote('没有匹配'); return }
        var next = text.slice(0, start) + replaceText + text.slice(start + findText.length)
        pendingSelRef.current = { start: start + replaceText.length, end: start + replaceText.length }
        if (typeof props.onChange === 'function') props.onChange(next)
        setFindNote('已替换')
      }
      /** Replace every occurrence in THIS file (single undo step via onChange). */
      function replaceAll() {
        if (findText === '') return
        var count = 0
        var parts = text.split(findText)
        count = parts.length - 1
        if (count === 0) { setFindNote('没有匹配'); return }
        if (typeof props.onChange === 'function') props.onChange(parts.join(replaceText))
        setFindNote('已替换 ' + count + ' 处（未保存）')
      }
      function onKeyDown(event) {
        if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
          event.preventDefault()
          var findArea = areaRef.current
          if (findArea !== null && findArea !== undefined && typeof findArea.selectionStart === 'number' && findArea.selectionEnd > findArea.selectionStart) {
            var highlighted = firstSelectedLine(text.slice(findArea.selectionStart, findArea.selectionEnd))
            if (highlighted !== '') {
              setFindText(highlighted)
              setFindNote(undefined)
            }
          }
          setFindOpen(true)
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          if (typeof props.onSave === 'function') props.onSave()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          var target = event.target
          var from = target.selectionStart
          var to = target.selectionEnd
          // execCommand keeps the browser's undo stack; the splice path is the
          // fallback for engines that dropped it.
          if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            target.setSelectionRange(from, to)
            document.execCommand('insertText', false, '  ')
            return
          }
          if (typeof props.onChange === 'function') props.onChange(text.slice(0, from) + '  ' + text.slice(to))
        }
      }
      var findBar = findOpen ? h('div', { style: S.findBar, 'data-editor-find': '1' },
        h('input', {
          style: S.findInput, value: findText, placeholder: '在文件中查找…', autoFocus: true,
          'data-action': 'find-input',
          onChange: function (event) { setFindText(event.target.value); setFindNote(undefined) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') { event.preventDefault(); findNext() }
            if (event.key === 'Escape') { event.preventDefault(); setFindOpen(false) }
          },
        }),
        h('input', {
          style: Object.assign({}, S.findInput, { flex: '0 1 200px' }), value: replaceText, placeholder: '替换为…',
          'data-action': 'replace-input',
          onChange: function (event) { setReplaceText(event.target.value); setFindNote(undefined) },
          onKeyDown: function (event) { if (event.key === 'Escape') { event.preventDefault(); setFindOpen(false) } },
        }),
        h('button', { type: 'button', style: S.button, 'data-action': 'replace-one', title: '替换当前匹配（仅本文件）', onClick: replaceOne }, '替换'),
        h('button', { type: 'button', style: S.button, 'data-action': 'replace-all', title: '替换本文件全部匹配（仅本文件）', onClick: replaceAll }, '全部替换'),
        h('span', { style: S.meta }, findNote === undefined ? 'Enter 下一个 · Esc 关闭' : findNote),
        h('button', { type: 'button', style: S.buttonOff, 'data-action': 'find-close', title: '关闭查找', onClick: function () { setFindOpen(false) } }, '×')) : null
      return h('div', { style: S.editorColumn },
        findBar,
        h('div', { style: S.editorWrap },
        h('div', { style: S.editorGutter, 'data-editor-gutter': '1' },
          h('div', { ref: innerRef, style: S.gutterInner },
            lines.map(function (_, index) {
              var line = index + 1
              var hasBp = marked[line] === true
              return h('div', {
                key: 'g' + line, style: hasBp ? S.gutterBpRow : S.gutterRow,
                title: hasBp ? '双击删除断点' : '单击加断点',
                'data-line': line,
                onClick: function () { if (!hasBp) props.onToggleBreakpoint(line) },
                onDoubleClick: function () { if (hasBp) props.onToggleBreakpoint(line) },
              }, (typeof props.debugLine === 'number' && props.debugLine === line ? '▸ ' : '') + (hasBp ? '●' : String(line)))
            }))),
        h('textarea', {
          style: S.editorTextarea,
          value: text,
          spellCheck: false,
          wrap: 'off',
          autoComplete: 'off',
          'data-editor-textarea': '1',
          onChange: function (event) { if (typeof props.onChange === 'function') props.onChange(event.target.value) },
          onScroll: syncScroll,
          onKeyDown: onKeyDown,
          ref: areaRef,
        })))
    }

    /**
     * The saved layout of one IDE tab: `{ui:{maximized,section}, sizes, font,
     * theme, files, file}`. Persisted per tab under `dsh-ris-ide:ui:<key>`.
     *
     * The workspace tab used to be keyed per PROGRAM (the panel passed the first
     * program's meta), so a user's maximised pane / colour scheme / font size could
     * silently reset after that key became `…:workspace`. When the exact key has
     * nothing saved, adopt the first other `dsh-ris-ide:ui:*` entry and let the
     * normal persist effect copy it to the current key.
     * @param {string} storageKey - the current tab's key.
     * @returns {object|null} the saved blob.
     */
    function readSavedUi(storageKey) {
      try {
        if (typeof localStorage === 'undefined') return null
        var raw = localStorage.getItem(storageKey)
        if (raw !== null) {
          var own = JSON.parse(raw)
          return own !== null && typeof own === 'object' ? own : null
        }
        if (typeof localStorage.key !== 'function') return null
        for (var index = 0; index < localStorage.length; index += 1) {
          var key = localStorage.key(index)
          if (typeof key !== 'string' || key.indexOf('dsh-ris-ide:ui:') !== 0 || key === storageKey) continue
          var legacyRaw = localStorage.getItem(key)
          if (legacyRaw === null) continue
          var legacy = JSON.parse(legacyRaw)
          if (legacy !== null && typeof legacy === 'object') return legacy
        }
        return null
      } catch (error) {
        return null
      }
    }


    /** Error boundary around a foreign viewer: a broken one must not blank the IDE. */

    /**
     * `cn.com.ris.Foo$Bar` → `cn/com/ris/Foo.java` (inner classes fold to the
     * outermost file). The debugger reports class names, the tree/source needs a
     * file path; this is the pure half of that mapping.
     * @param {string} className - the debugger's class name.
     * @returns {string|undefined} slash-relative source path, undefined for junk.
     */
    function sourceRelativeSuffix(className) {
      var cleaned = String(className === undefined || className === null ? '' : className).replace(/\$.*$/, '').trim()
      if (cleaned === '') return undefined
      return cleaned.replace(/\./g, '/') + '.java'
    }

    /**
     * The line whose rendered line-number cell contains `clientY`, read straight
     * from the DOM. Used when the cached gutter map has not caught up yet.
     * @param {HTMLElement|null} host - the `[data-viewer-host]` element.
     * @param {number} clientY - viewport Y.
     * @returns {number|undefined} the 1-based line.
     */
    function lineFromPoint(host, clientY) {
      if (host === null || host === undefined) return undefined
      var cells = host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')
      for (var index = 0; index < cells.length; index += 1) {
        var box = cells[index].getBoundingClientRect()
        if (clientY < box.top || clientY >= box.bottom) continue
        var line = parseGutterLine(cells[index].textContent)
        if (line !== undefined) return line
      }
      return undefined
    }

    /**
     * A line-number gutter cell's text → its line number (`"42"` → 42).
     * @param {string|undefined} text - the cell's textContent.
     * @returns {number|undefined} the line, undefined for spacer/blank cells.
     */
    function parseGutterLine(text) {
      var trimmed = String(text === undefined || text === null ? '' : text).trim()
      return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
    }

    /**
     * Stable signature of a config drift report — a dismissal sticks to THIS drift
     * (a different set of added/missing/changed items shows the notice again).
     * @param {{added?: string[], missing?: string[], changed?: string[]}|null} drift - the drift payload.
     * @returns {string} the signature.
     */
    function driftSignature(drift) {
      if (drift === null || drift === undefined || typeof drift !== 'object') return 'none'
      return 'drift:' + (drift.added || []).join(',') + '|' + (drift.missing || []).join(',') + '|' + (drift.changed || []).join(',')
    }

    /**
     * A one-line advisory strip with a dismiss ✕ on the right. Every user-visible
     * notice in the plugin renders through this, so nothing can get stuck on screen
     * (the notes are set by async host calls and used to outlive their usefulness).
     * @param {object} props - `{styles, kind, signature, onDismiss, children}`.
     * @returns {object} React element.
     */
    function ClosableNotice(props) {
      var S = props.styles
      return h('div', {
        style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: 6 }),
        'data-notice': props.kind,
      },
        h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, props.children),
        h('button', {
          type: 'button', style: Object.assign({}, S.buttonOff, { flex: '0 0 auto', padding: '0 4px' }),
          'data-notice-close': props.kind, title: '关闭这条提示',
          onClick: function () { props.onDismiss(props.signature) },
        }, '×'))
    }

    /**
     * Per-notice dismissal state: a notice stays closed until its SIGNATURE changes
     * (a new message, or the same one after the state moved on).
     * @returns {{isOpen: function(string, string): boolean, dismiss: function(string, string): void}}
     */
    function useDismissedNotices() {
      var [dismissed, setDismissed] = useState(function () { return {} })
      return {
        isOpen: function (kind, signature) { return dismissed[kind] !== signature },
        dismiss: function (kind, signature) {
          setDismissed(function (prev) {
            if (prev[kind] === signature) return prev
            var next = Object.assign({}, prev)
            next[kind] = signature
            return next
          })
        },
      }
    }

    /**
     * Typography for the inline Markdown/HTML preview. The renderer emits bare
     * tags (it can only build them itself — see `renderMarkdown`), so their look
     * is defined here, scoped to `[data-ide-preview]` and in `currentColor` so it
     * follows both the page theme and A−/A+.
     */
    var PREVIEW_CSS = '[data-ide-preview] h1,[data-ide-preview] h2,[data-ide-preview] h3,[data-ide-preview] h4,[data-ide-preview] h5,[data-ide-preview] h6'
      + '{margin:1em 0 0.4em;line-height:1.3;font-weight:600}'
      + '[data-ide-preview] h1{font-size:1.55em}[data-ide-preview] h2{font-size:1.32em;border-bottom:1px solid color-mix(in srgb,currentColor 16%,transparent);padding-bottom:0.2em}'
      + '[data-ide-preview] h3{font-size:1.15em}[data-ide-preview] h4,[data-ide-preview] h5,[data-ide-preview] h6{font-size:1em}'
      + '[data-ide-preview] p{margin:0.5em 0}'
      + '[data-ide-preview] a{color:#4493f8;text-decoration:none}[data-ide-preview] a:hover{text-decoration:underline}'
      + '[data-ide-preview] code{font-family:var(--dsw-font-mono,monospace);font-size:0.92em;padding:0.1em 0.35em;border-radius:3px;background:color-mix(in srgb,currentColor 10%,transparent)}'
      + '[data-ide-preview] pre{margin:0.7em 0;padding:8px 10px;overflow:auto;border-radius:4px;background:color-mix(in srgb,currentColor 7%,transparent);border:1px solid color-mix(in srgb,currentColor 12%,transparent)}'
      + '[data-ide-preview] pre code{padding:0;background:transparent;font-size:0.9em}'
      + '[data-ide-preview] ul,[data-ide-preview] ol{margin:0.45em 0;padding-left:1.6em}[data-ide-preview] li{margin:0.15em 0}'
      + '[data-ide-preview] blockquote{margin:0.6em 0;padding:0.1em 0.9em;border-left:3px solid color-mix(in srgb,currentColor 30%,transparent);opacity:0.85}'
      + '[data-ide-preview] hr{margin:1em 0;border:none;border-top:1px solid color-mix(in srgb,currentColor 18%,transparent)}'
      + '[data-ide-preview] table{border-collapse:collapse;margin:0.7em 0;font-size:0.95em}'
      + '[data-ide-preview] th,[data-ide-preview] td{border:1px solid color-mix(in srgb,currentColor 22%,transparent);padding:3px 8px;text-align:left}'
      + '[data-ide-preview] th{background:color-mix(in srgb,currentColor 8%,transparent);font-weight:600}'
      + '[data-ide-preview] img{max-width:100%;height:auto;border-radius:3px;background:color-mix(in srgb,currentColor 6%,transparent)}'
      + '[data-ide-preview] del{opacity:0.65}'

    /** CSS class marking the debugger's current line inside CodeMirror. */
    var DEBUG_LINE_CLASS = 'ris-ide-debug-line'
    /** Slide-in for a floating hint (bottom layer, so it rises into place). */
    var TOAST_CSS = '@keyframes dshRisIdeToastIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'
    /**
     * Console-row loading mask: a translucent cover with a spinner while that
     * program is starting/stopping, so a second click cannot fire another
     * start/stop before the first host call answers.
     */
    var PROGRAM_LOADING_CSS = '@keyframes dshRisIdeSpin{to{transform:rotate(360deg)}}'
      + '.dsh-ris-ide-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;'
      + 'background:color-mix(in srgb,currentColor 12%,transparent);cursor:progress;z-index:3;font-size:11px;'
      + 'border-radius:4px;}'
      + '.dsh-ris-ide-spinner{width:10px;height:10px;border-radius:50%;flex:0 0 auto;'
      + 'border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;'
      + 'animation:dshRisIdeSpin .7s linear infinite;display:inline-block}'
    /** Amber band + left bar; readable on both schemes (surface is scoped to us). */
    var DEBUG_LINE_CSS = '[data-workbench="ris-ide"] .' + DEBUG_LINE_CLASS
      + '{background:color-mix(in srgb, #d29922 26%, transparent) !important;box-shadow:inset 2px 0 0 #d29922}'

    /**
     * Scrollbars in the IDE. The editor scrolls with plain `auto` overflow
     * (CM6's `.cm-scroller{overflowX:auto}` makes the other axis `auto` too): the
     * bars are classic, non-overlay and appear only when content overflows — which
     * is what we want. What they LOOK like, though, comes from the host theme
     * (5px wide, transparent track, near-invisible thumb), so an overflowing editor
     * shows a 5px sliver that reads as "no scrollbar at all". Give it a real one and
     * keep `auto`: neither `overflow-y:scroll` nor `scrollbar-gutter:stable` here —
     * both would reserve an empty gutter on files that do not overflow.
     */
    var SCROLLBAR_CSS = '[data-workbench="ris-ide"] ::-webkit-scrollbar{width:10px;height:10px}'
      + '[data-workbench="ris-ide"] ::-webkit-scrollbar-track{background:rgba(127,127,127,0.14);border-radius:999px}'
      + '[data-workbench="ris-ide"] ::-webkit-scrollbar-thumb'
      + '{background:rgba(86,182,194,0.55);border:2px solid transparent;border-radius:999px;background-clip:content-box}'
      + '[data-workbench="ris-ide"] ::-webkit-scrollbar-thumb:hover{background:rgba(86,182,194,0.80);background-clip:content-box}'
      + '[data-workbench="ris-ide"] ::-webkit-scrollbar-corner{background:0 0}'
      + '@supports not selector(::-webkit-scrollbar){'
      + '[data-workbench="ris-ide"] *{scrollbar-width:thin;scrollbar-color:rgba(86,182,194,0.65) rgba(127,127,127,0.14)}}'

    /**
     * Selection colours for the embedded editor, injected from the panel itself.
     * CodeMirror draws the selection into its own layer, and the page's stylesheet
     * can win that fight — the result was "other matches are highlighted, the text
     * I selected is not". The selected range is teal, the other matches amber, so
     * the selection always reads as the stronger one.
     *
     * Raising the layer paints the selection ABOVE `.cm-content`, so it has to be
     * transparent to the pointer as well: the layer is a plain `<div>` spanning the
     * whole scroller (CM only does this for its cursor layer), and without
     * `pointer-events:none` a click on a highlighted range stopped there — the
     * caret never moved into the selection, nor into the amber "current match" of
     * the search panel (which is a selection too). Both needed a second click.
     */
    var SELECTION_CSS = '[data-workbench="ris-ide"] .cm-selectionLayer{z-index:5 !important;pointer-events:none !important}'
      // While anything is selected the active-line tint is switched off: it is
      // painted on the line itself and used to hide the selection colour on the
      // current line (both for a single range and for a multi-line selection).
      + '[data-workbench="ris-ide"] .cm-editor.dsh-ris-ide-has-selection .cm-activeLine'
      + '{background:transparent !important;box-shadow:none !important}'
      + '[data-workbench="ris-ide"] .cm-editor.dsh-ris-ide-has-selection .cm-activeLineGutter'
      + '{background:transparent !important}'
      + '[data-workbench="ris-ide"] .cm-selectionBackground'
      + '{background:rgba(86,182,194,0.42) !important}'
      + '[data-workbench="ris-ide"] .cm-editor.cm-focused .cm-selectionBackground'
      + '{background:rgba(86,182,194,0.50) !important}'
      // An unfocused editor must stop painting the selection: clicking a tab or
      // the debug pane has to clear the teal highlight, not leave it behind.
      + '[data-workbench="ris-ide"] .cm-editor:not(.cm-focused) .cm-selectionBackground'
      + '{background:transparent !important}'
      + '[data-workbench="ris-ide"] .cm-selectionMatch'
      + '{background-color:rgba(210,153,34,0.30) !important}'
      + '[data-workbench="ris-ide"] .cm-selectionMatch-main'
      + '{background-color:rgba(210,153,34,0.45) !important}'

    /**
     * Scroll an editor host to one source line and mark it.
     *
     * The embedded sidebar viewer is CodeMirror, whose EditorView we cannot reach
     * from here, so the reveal works on the rendered DOM instead: estimate the
     * offset from the line height, scroll the `.cm-scroller`, then — once the
     * viewport has re-rendered — find the real row by matching the line-number
     * gutter cell and tag the neighbouring `.cm-line` with {@link DEBUG_LINE_CLASS}.
     * The fallback textarea editor is handled directly (scroll + select the line).
     * @param {HTMLElement|null} host - the `[data-viewer-host]` element.
     * @param {number} line - 1-based source line.
     */
    function revealDebugLine(host, line) {
      if (host === null || host === undefined || !(line > 0)) return
      var area = host.querySelector('textarea[data-editor-textarea]')
      if (area !== null) {
        var texts = String(area.value === undefined ? '' : area.value).split('\n')
        var lineHeight = 19
        var styles = typeof getComputedStyle === 'function' ? getComputedStyle(area) : null
        if (styles !== null && parseFloat(styles.lineHeight) > 0) lineHeight = parseFloat(styles.lineHeight)
        var offset = 0
        for (var index = 0; index < Math.min(line - 1, texts.length); index += 1) offset += lineHeight
        area.scrollTop = Math.max(0, offset - area.clientHeight / 2 + lineHeight / 2)
        var start = 0
        for (var before = 0; before < Math.min(line - 1, texts.length); before += 1) start += texts[before].length + 1
        var end = start + (texts[line - 1] === undefined ? 0 : texts[line - 1].length)
        area.focus()
        if (typeof area.setSelectionRange === 'function') area.setSelectionRange(start, end)
        return
      }
      var scroller = host.querySelector('.cm-scroller')
      if (scroller === null) return
      var rendered = host.querySelectorAll('.cm-line')
      var rowHeight = rendered.length > 0 ? rendered[0].getBoundingClientRect().height : 0
      if (!(rowHeight > 0)) rowHeight = 19
      scroller.scrollTop = Math.max(0, Math.min((line - 1) * rowHeight - scroller.clientHeight / 2 + rowHeight / 2, scroller.scrollHeight))
      var after = function () {
        var gutter = host.querySelector('.cm-lineNumbers')
        var cell = null
        if (gutter !== null) {
          var cells = gutter.querySelectorAll('.cm-gutterElement')
          for (var index = 0; index < cells.length; index += 1) {
            if (String(cells[index].textContent || '').trim() === String(line)) { cell = cells[index]; break }
          }
        }
        var target = null
        var lines = host.querySelectorAll('.cm-line')
        if (cell !== null) {
          var cellTop = cell.getBoundingClientRect().top
          for (var scan = 0; scan < lines.length; scan += 1) {
            if (Math.abs(lines[scan].getBoundingClientRect().top - cellTop) < 3) { target = lines[scan]; break }
          }
          var delta = cellTop - (scroller.getBoundingClientRect().top + scroller.clientHeight / 2)
          if (Math.abs(delta) > 4) scroller.scrollTop += delta
        }
        var stale = host.querySelectorAll('.' + DEBUG_LINE_CLASS)
        for (var clear = 0; clear < stale.length; clear += 1) stale[clear].classList.remove(DEBUG_LINE_CLASS)
        if (target !== null) target.classList.add(DEBUG_LINE_CLASS)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(after)
      else after()
    }

    /**
     * One text file: the sidebar's own viewer plus (for Java sources) the
     * external breakpoint column. `props.visible` parks a file that is not the
     * active tab — parked panes stay MOUNTED so the viewer keeps its draft and
     * its dirty state, exactly like the sidebar's own keep-mounted tabs.
     */
    /** Chunk factories already materialised (one per chunk name). */
    var RIS_IDE_CHUNKS = {}

    /**
     * Load one lazily-built client chunk (currently only the CodeMirror editor).
     *
     * The chunk is a plain script fetched from this plugin's own host route; it
     * parks its CJS factory on `globalThis.__dshRisIdeChunks__[name]`, so it never
     * goes through the DSH module loader (a chunk id is not in its resolution
     * graph). Failures are cached too: a missing build must not retry on each
     * render — the caller falls back to the built-in editor.
     * @param {string} name - chunk name (`codemirror`).
     * @returns {Promise<object>} the chunk's exports.
     */
    /** Resolved chunk values, so a NEW editor mounts without the loading flash. */
    var RIS_IDE_CHUNK_VALUES = {}
    function loadRisIdeChunk(name) {
      if (RIS_IDE_CHUNKS[name] !== undefined) return RIS_IDE_CHUNKS[name]
      RIS_IDE_CHUNKS[name] = new Promise(function (resolve, reject) {
        if (typeof document === 'undefined') {
          reject(new Error('no document'))
          return
        }
        function materialise() {
          var registry = globalThis.__dshRisIdeChunks__ || {}
          var factory = registry[name]
          if (typeof factory !== 'function') {
            reject(new Error('chunk factory missing: ' + name))
            return
          }
          try {
            resolve(factory(function (specifier) { throw new Error('chunk requires ' + specifier) }))
          } catch (error) {
            reject(error)
          }
        }
        if (typeof (globalThis.__dshRisIdeChunks__ || {})[name] === 'function') {
          materialise()
          return
        }
        var url = routeUrl('dsh-ris-ide/bundle')
        url.searchParams.set('name', name)
        var script = document.createElement('script')
        script.src = url.href
        script.async = true
        script.onload = materialise
        script.onerror = function () { reject(new Error('chunk failed to load: ' + name)) }
        document.head.appendChild(script)
      })
      RIS_IDE_CHUNKS[name].then(function (value) { RIS_IDE_CHUNK_VALUES[name] = value }, function () { /* fallback editor */ })
      return RIS_IDE_CHUNKS[name]
    }

    /** Mounts the CodeMirror chunk and pushes prop changes into the handle. */
    function IdeCodeMirror(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var hostRef = useRef(null)
      var handleRef = useRef(null)
      var callbacksRef = useRef({})
      var ratio = typeof props.fontRatio === 'number' && props.fontRatio > 0 ? props.fontRatio : 1
      var breakpointLines = (props.breakpoints || []).map(function (bp) { return bp.line })
      callbacksRef.current = {
        onChange: props.onChange,
        onSave: props.onSave,
        onToggleBreakpoint: props.onToggleBreakpoint,
        onToolbarState: props.onToolbarState,
      }
      useEffect(function () {
        var host = hostRef.current
        if (host === null) return undefined
        var handle = props.chunk.mount(host, {
          doc: typeof props.text === 'string' ? props.text : '',
          path: typeof props.path === 'string' ? props.path : '',
          onContextMenu: function (payload) {
            if (typeof props.onEditorMenu === 'function') props.onEditorMenu(payload)
          },
          fontSize: DEFAULT_FONT_SIZE * ratio,
          readOnly: false,
          breakpoints: breakpointLines,
          debugLine: typeof props.debugLine === 'number' ? props.debugLine : null,
          onChange: function (text) {
            var callbacks = callbacksRef.current
            if (typeof callbacks.onChange === 'function') callbacks.onChange(text)
            var saved = props.savedText
            if (typeof callbacks.onToolbarState === 'function') {
              callbacks.onToolbarState({
                // Undo back to the saved text is NOT dirty: compare instead of
                // assuming every edit is a change.
                dirty: typeof saved === 'string' ? text !== saved : true,
                saveState: 'idle', mode: 'editable', editable: true,
              })
            }
          },
          onSave: function () {
            var callbacks = callbacksRef.current
            if (typeof callbacks.onToolbarState === 'function') callbacks.onToolbarState({ dirty: true, saveState: 'saving', mode: 'editable', editable: true })
            if (typeof callbacks.onSave === 'function') callbacks.onSave()
          },
          onToggleBreakpoint: function (line) {
            var callbacks = callbacksRef.current
            if (typeof callbacks.onToggleBreakpoint === 'function') callbacks.onToggleBreakpoint(line)
          },
        })
        handleRef.current = handle
        if (typeof props.onToolbarState === 'function') props.onToolbarState({ dirty: false, saveState: 'saved', mode: 'editable', editable: true })
        return function () {
          handle.destroy()
          handleRef.current = null
        }
      }, [props.chunk])
      useEffect(function () {
        var handle = handleRef.current
        if (handle !== null && handle.getValue() !== props.text) handle.setDoc(props.text)
      }, [props.text])
      useEffect(function () {
        var handle = handleRef.current
        if (handle !== null) handle.setBreakpoints(breakpointLines)
      }, [JSON.stringify(breakpointLines)])
      useEffect(function () {
        var handle = handleRef.current
        if (handle !== null && typeof handle.setLanguage === 'function') handle.setLanguage(typeof props.path === 'string' ? props.path : '')
      }, [props.path])
      useEffect(function () {
        var handle = handleRef.current
        if (handle === null) return
        var line = typeof props.debugLine === 'number' ? props.debugLine : null
        if (line === null) {
          handle.setDebugLine(null)
          return
        }
        // A parked tab is `display:none`, so its viewport has zero height — the
        // scroll decision would be wrong. Re-run when this tab becomes active
        // (the effect depends on `props.visible`), which is also the moment the
        // user can actually see the line.
        if (props.visible === false) return
        handle.setDebugLine(line)
        handle.focus()
      }, [props.debugLine, props.debugNonce, props.visible])
      useEffect(function () {
        var handle = handleRef.current
        if (handle !== null) handle.setFontSize(DEFAULT_FONT_SIZE * ratio)
      }, [ratio])
      return h('div', {
        ref: hostRef,
        style: { flex: '1 1 0', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        'data-codemirror': '1',
      })
    }

    /**
     * The IDE's text editor: CodeMirror 6 (Java syntax, breakpoint gutter,
     * debug-line highlight, find/replace) loaded as a lazy chunk, with the
     * built-in textarea editor as the fallback when the chunk is unavailable.
     */
    function IdeTextEditor(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      // A chunk that is already resolved is used on the FIRST render: otherwise
      // every newly opened file flashed "正在加载编辑器…" for a frame.
      var [chunk, setChunk] = useState(function () { return RIS_IDE_CHUNK_VALUES.codemirror || null })
      var [failed, setFailed] = useState(false)
      useEffect(function () {
        var cancelled = false
        loadRisIdeChunk('codemirror').then(function (loaded) {
          if (!cancelled) setChunk(loaded)
        }, function () {
          if (!cancelled) setFailed(true)
        })
        return function () { cancelled = true }
      }, [])
      if (chunk !== null) return h(IdeCodeMirror, Object.assign({}, props, { chunk: chunk }))
      return failed
        ? h(IdeEditor, props)
        : h('div', { style: S.idePlaceholder, 'data-codemirror-loading': '1' }, '正在加载编辑器…')
    }

    /**
     * One non-text file: images render inline, PDFs in a sandboxed frame, and
     * anything else says so instead of showing garbage. Both media kinds come from
     * better-sidebar's raw `/sidebar/file` route (the same one its own viewer
     * uses), so the IDE inherits its content-type handling and the SVG sandbox CSP
     * rather than re-implementing media serving.
     */
    /**
     * Keep only the TAIL of a loaded large-text buffer.
     *
     * Cutting at a newline keeps the line grid stable (so scroll math and the
     * line count stay coherent) and lets the caller drop earlier bytes from memory
     * while the reader keeps going down the file.
     * @param {string} text - loaded text.
     * @param {number} maxBytes - how much text to keep (UTF-16 units ≈ bytes here).
     * @returns {{text:string, droppedLines:number, droppedChars:number}} kept tail + what was freed.
     */
    function trimLargeTextFront(text, maxBytes) {
      if (typeof text !== 'string' || text.length <= maxBytes) return { text: typeof text === 'string' ? text : '', droppedLines: 0, droppedChars: 0 }
      var cut = text.indexOf('\n', text.length - maxBytes)
      if (cut === -1) return { text: text, droppedLines: 0, droppedChars: 0 }
      var dropped = text.slice(0, cut + 1)
      return { text: text.slice(cut + 1), droppedLines: dropped.split('\n').length - 1, droppedChars: dropped.length }
    }

    function IdeMediaView(props) {
      var S = stylesFor(props && typeof props.fontRatio === 'number' ? props.fontRatio : 1)
      var path = props.path
      var kind = props.kind
      var scope = props.scope
      if (kind === 'image') {
        return h('div', { style: S.mediaWrap, 'data-file-kind': 'image' },
          h('img', { src: fileMediaUrl(scope, path), alt: String(path).split('/').pop(), style: S.mediaImage }))
      }
      if (kind === 'pdf') {
        return h('div', { style: S.mediaWrap, 'data-file-kind': 'pdf' },
          h('iframe', {
            src: fileMediaUrl(scope, path), title: String(path).split('/').pop(),
            sandbox: 'allow-same-origin allow-scripts', style: S.mediaFrame,
          }))
      }
      return h('div', { style: S.idePlaceholder, 'data-file-kind': kind },
        kind === 'binary'
          ? '二进制文件，不支持预览'
          : kind === 'too-large' ? '文件过大，不支持预览' : '（无法预览）')
    }

    /**
     * The whole RIS-IDE workbench: workspace tree + console + source/tabs + debug
     * + live log, with a workspace-level identity (the top bar shows the workspace
     * path, not one program).
     *
     * Source files are editable straight away; `docs` holds each open document's
     * draft so switching tabs never loses a change, and the tab label carries `*`
     * while `text !== saved`. Non-text files render through
     * {@link IdeMediaView}. The debug pane and log pane take one tab per program
     * and poll `/debug/poll` only while their tab is visible.
     */
    function ProgramWorkbench(props) {
      var scope = props ? props.scope : undefined
      var tab = props ? props.tab : undefined
      var meta = tab !== null && tab !== undefined && tab.meta !== null && typeof tab.meta === 'object' ? tab.meta : {}
      var sessionId = scope ? scope.sessionId : undefined
      var cwd = scope ? scope.cwd : undefined
      var programs = Array.isArray(props.programs) ? props.programs : []
      var metaKind = typeof meta.kind === 'string' ? meta.kind : 'spring'
      var metaLogPath = typeof meta.logPath === 'string' ? meta.logPath : ''
      var programKey = typeof meta.programId === 'string' ? meta.programId : ''
      var visible = props ? props.visible !== false : true
      /** The workspace search box (Ctrl+Alt+F / F3 target outside the editor). */
      var searchInputRef = useRef(null)
      /** The panel root: the boundary of "inside the IDE" for the shortcut shield. */
      var workbenchRef = useRef(null)
      /** Open-source-tab cap: past it the OLDEST clean tab is dropped. */
      var FILE_LIMIT = 20

      var [dbg, setDbg] = useState(function () {
        return { attached: false, port: null, suspended: false, suspendedThreads: [], currentThreadId: null, seq: 0, events: [], breakpoints: globalBreakpointsSnapshot(), threads: [], frames: [], variables: [], missingSource: null, lastError: null }
      })
      /** Live debug state for async handlers: the SSE subscription stays mounted
       *  across suspends, so reading `dbg` from its closure would be stale. */
      var dbgRef = useRef(dbg)
      dbgRef.current = dbg
      var storageKey = 'dsh-ris-ide:ui:' + (programKey !== '' ? programKey : (metaLogPath !== '' ? metaLogPath : 'workspace'))
      var savedUi = readSavedUi(storageKey)
      
      var [consoleBusy, setConsoleBusy] = useState('')
var [ui, setUi] = useState(function () {
        // First ever open of an IDE tab (no saved layout, real browser): start with
        // the SOURCE pane maximised so the editor gets the whole area, and let the
        // normal persistence save that state — every later open restores whatever
        // the user left (including "not maximised"). SSR has no localStorage, so
        // tests/previews keep the plain 2x2 grid.
        var firstOpen = savedUi === null && typeof localStorage !== 'undefined'
        var base = { section: 'breakpoints', collapsed: false, threadId: undefined, frameIndex: 0, note: undefined, busy: false, maximized: firstOpen ? 'editor' : null }
        return savedUi !== null && typeof savedUi.ui === 'object' ? Object.assign(base, savedUi.ui) : base
      })
      /** The three user-draggable pane sizes (px). */
      var [sizes, setSizes] = useState(function () {
        var base = { left: 300, leftBottom: 260, rightBottom: 260, debugWidth: 300 }
        if (savedUi !== null && savedUi.sizes !== null && typeof savedUi.sizes === 'object') {
          Object.keys(base).forEach(function (key) {
            var value = Number(savedUi.sizes[key])
            if (Number.isFinite(value) && value > 0) base[key] = value
          })
        }
        return base
      })
      /** Content font size for EVERY pane (persisted per tab with the layout). */
      var [uiFont, setUiFont] = useState(function () {
        return savedUi !== null && savedUi.font !== undefined && savedUi.font !== null
          ? clampUiFont(savedUi.font)
          : DEFAULT_FONT_SIZE
      })
      // This pane's style set (all its blocks scaled by the A−/A+ ratio). A
      // LOCAL `S` shadows the module default, so nothing leaks to other trees.
      var S = stylesFor(uiFont / DEFAULT_FONT_SIZE)
      var fontRatio = uiFont / DEFAULT_FONT_SIZE
      // The IDE does NOT own a colour scheme: it follows DSH's page theme, and the
      // toolbar button drives THAT (`theme` service), so no colour is persisted in
      // the layout blob any more.
      var dshTheme = dshThemeService()
      var [themePreference, setThemePreference] = useState(function () { return themePreferenceOf(dshTheme) })
      var pageDark = pageIsDark()
      // DSH recolours the page asynchronously (attribute + CSS vars), so re-read the
      // resolved scheme whenever it announces a change.
      useEffect(function () {
        if (dshTheme === undefined || panelCtx === null || panelCtx === undefined || typeof panelCtx.on !== 'function') return undefined
        function onChange() { setThemePreference(themePreferenceOf(dshTheme)) }
        var dispose = panelCtx.on('theme/change', onChange)
        return typeof dispose === 'function' ? dispose : undefined
      }, [])
      var [hoverSplit, setHoverSplit] = useState(null)
      var [treeQuery, setTreeQuery] = useState('')
      /** The workspace search box has focus (empty box ⇒ recent-file dropdown). */
      var [searchFocused, setSearchFocused] = useState(false)
      /** Dropdown payload for the toolbar search: null | {matches,dirs} | {error}. */
      var [searchHits, setSearchHits] = useState(null)
      var [searchBusy, setSearchBusy] = useState(false)
      /** Dropdown highlight: an index into `searchHits.matches`, -1 when there is none. */
      var [searchActive, setSearchActive] = useState(-1)
      /** One-shot "reveal this hit in the tree" request (nonce makes repeats work). */
      var [locateRequest, setLocateRequest] = useState(null)
      var locateNonceRef = useRef(0)
      /** Bumped by the tree title bar's ⟳ (the tree reloads its loaded levels). */
      var [treeRefreshTick, setTreeRefreshTick] = useState(0)
      /** The workspace sits in a git repo, so .gitignore filtering is meaningful. */
      var [treeGit, setTreeGit] = useState(false)
      /** false = apply .gitignore (default when git exists), true = show all files. */
      var [treeShowAll, setTreeShowAll] = useState(false)
      /**
       * Flip the tree's .gitignore filter. The mode lives in TREE_FILTER_ALL (the
       * fetch layer reads it), and a refreshNonce bump makes the tree re-read the
       * root and every expanded folder under the NEW mode.
       */
      function toggleTreeFilter() {
        if (treeGit !== true) return
        var next = treeShowAll !== true
        TREE_FILTER_ALL = next
        setTreeShowAll(next)
        setTreeRefreshTick(function (value) { return value + 1 })
        note(next ? '文件树：显示所有文件（含 .gitignore 忽略的）' : '文件树：按 .gitignore 过滤')
      }
      // Warm the editor chunk while the panel is idle: opening the first file then
      // costs a mount, not a 1.2 MB download + parse.
      useEffect(function () {
        if (typeof window === 'undefined') return undefined
        var timer = setTimeout(function () {
          void loadRisIdeChunk('codemirror').catch(function () { /* fallback editor stays */ })
        }, 300)
        return function () { clearTimeout(timer) }
      }, [])
      /** The editor's right-click menu (`{x, y, items}`); null when closed. */
      var [editorMenu, setEditorMenu] = useState(null)
      /** Bottom-right help panel (shortcuts + how-to). */
      var [helpOpen, setHelpOpen] = useState(false)
      /**
       * Bottom status bar message: transient, non-critical progress like
       * "正在获取依赖源码…". Toasts stay reserved for things the user must know
       * (failures); this channel never steals focus and clears itself.
       */
      var [statusText, setStatusText] = useState('')
      var statusTimerRef = useRef(null)
      function statusNote(text, ttl) {
        if (typeof text !== 'string' || text === '') return
        setStatusText(text)
        if (statusTimerRef.current !== null && typeof clearTimeout === 'function') clearTimeout(statusTimerRef.current)
        if (typeof setTimeout !== 'function') return
        statusTimerRef.current = setTimeout(function () {
          statusTimerRef.current = null
          setStatusText('')
        }, typeof ttl === 'number' && ttl > 0 ? ttl : 4000)
      }
      useEffect(function () {
        return function () {
          if (statusTimerRef.current !== null && typeof clearTimeout === 'function') clearTimeout(statusTimerRef.current)
        }
      }, [])
      useEffect(function () {
        if (editorMenu === null || typeof window === 'undefined') return undefined
        function onDown(event) {
          var target = event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function'
            && target.closest('[data-editor-menu="1"]') !== null) return
          setEditorMenu(null)
        }
        function onKey(event) { if (event.key === 'Escape') setEditorMenu(null) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [editorMenu])
      /** Where the debugger is suspended: `{path, line, nonce}` (drives reveal). */
      var [debugFocus, setDebugFocus] = useState(null)
      /**
       * Lazy variable tree: expanded row keys and the children fetched for them.
       * Objects/arrays are expanded ONE click at a time via `debug/expand`, so a big
       * model object costs nothing until the user opens it.
       */
      var [varTree, setVarTree] = useState(function () { return { expanded: {}, children: {}, loading: {}, items: {} } })
      // Dependency-source settings (debug pane title bar ⚙): a user-supplied
      // decompiler jar is the only way to show sources for jar classes that ship
      // no `-sources.jar`. Purely visual here; the host does the work.
      var [debugSettingsOpen, setDebugSettingsOpen] = useState(false)
      var [debugSettings, setDebugSettings] = useState(function () { return { jar: '', args: '', loading: false, error: '', savedAt: 0 } })
      /** Bumped after a debug action that restarts/unfreezes the service: re-read the log tail. */
      var [logNonce, setLogNonce] = useState(0)
      var debugFocusNonceRef = useRef(0)
      /** `class:line` of the frame already followed (dedupes the follow effect). */
      var followedFrameRef = useRef('')
      /**
       * Files the DEBUGGER opened on its own (never the user). When the debug
       * location moves to another file, the previous one is closed again so a
       * step storm does not leave a trail of tabs. Dirty tabs are kept (never
       * throw away edits) and stop being "debug-owned" the moment the user opens
       * or edits them.
       */
      var debugOpenedRef = useRef([])
      var debugOpeningRef = useRef(false)
      /** className → absolute source path (a step storm must not re-search). */
      var sourcePathRef = useRef({})

      /**
       * The on-disk source path of a class reported by the debugger.
       *
       * `cn.com.ris.X` maps to `…/cn/com/ris/X.java`; the host's gitignore-aware
       * filename search finds `X.java` candidates and the longest matching path
       * suffix wins (inner classes `Outer$Inner` are folded to `Outer`).
       * @param {string} className - the debugger's class name.
       * @returns {Promise<string|undefined>} absolute source path.
       */
      async function resolveSourcePath(className) {
        var cleaned = String(className === undefined || className === null ? '' : className).replace(/\$.*$/, '').trim()
        if (cleaned === '') return undefined
        var remembered = sourcePathRef.current[cleaned]
        if (remembered !== undefined) return remembered === null ? undefined : remembered
        var relativeSuffix = sourceRelativeSuffix(cleaned)
        var fileEnding = '/' + cleaned.split('.').pop() + '.java'
        try {
          var hits = await fsSearch(scopeRef.current, fileEnding.slice(1))
          var candidates = (hits.matches || []).map(function (item) { return absolutePath(cwd, item) })
          var found = candidates.find(function (item) { return item.endsWith('/' + relativeSuffix) })
          if (found === undefined) found = candidates.find(function (item) { return item.endsWith(fileEnding) })
          if (found === undefined) {
            // Not in the workspace: it is a dependency class. Ask the host to pull
            // it out of a `-sources.jar`, decompile it, or at least javap it (the
            // files land in `.dsh-ris-ide-cache` and open in the editor).
            statusNote('正在获取依赖源码：' + cleaned + '…', 0)
            found = await fsDependencySource(scopeRef.current, cleaned, activePathRef === undefined ? activePath : activePathRef.current)
            setStatusText('')
          }
          // Cache a MISS as well: stepping through a JDK/dependency class would
          // otherwise re-scan the workspace (`fsSearch`) on every single frame.
          sourcePathRef.current[cleaned] = found === undefined ? null : found
          return found
        } catch (error) {
          return undefined
        }
      }

      /**
       * Open the source of one debugger frame and move the editor there.
       *
       * Called whenever the debugger suspends (breakpoint hit, step) and when the
       * user picks a frame: opens the file if needed, switches a maximised
       * non-source pane back to the editor, and bumps `debugFocus` so the pane
       * scrolls to the line and highlights it.
       * @param {{className?: string, lineNumber?: number}} frame - a JDWP frame.
       */
      /**
       * Close every debug-opened tab except `currentPath` (the file the debugger
       * just landed in). Dirty tabs are kept and released from debug ownership.
       */
      function closeDebugOpenedExcept(currentPath) {
        var stale = debugOpenedRef.current.filter(function (item) { return item !== currentPath })
        if (stale.length === 0) { debugOpenedRef.current = [currentPath]; return }
        var kept = stale.filter(function (item) { return openFiles.indexOf(item) !== -1 && isDirty(item) === true })
        debugOpenedRef.current = [currentPath].concat(kept)
        var victims = stale.filter(function (item) { return openFiles.indexOf(item) !== -1 && isDirty(item) !== true })
        if (victims.length === 0) return
        setOpenFiles(function (previous) {
          return previous.filter(function (item) { return victims.indexOf(item) === -1 })
        })
        victims.forEach(function (item) { forgetDoc(item) })
        if (openFile !== undefined && victims.indexOf(openFile) !== -1) setOpenFile(currentPath)
      }
      async function followDebugLocation(frame) {
        if (frame === null || frame === undefined) return
        var line = Number(frame.lineNumber)
        if (!(line > 0)) return
        followedFrameRef.current = String(frame.className || '') + ':' + line
        var path = await resolveSourcePath(frame.className)
        if (path === undefined) {
          // JDK / dependency class: no source in the workspace. Ignore it QUIETLY
          // (no toast, no dialog) — the debug pane's one-line banner says where we
          // stopped, and continuing / stepping out keeps working. The miss is
          // cached too, so a step storm never re-scans the workspace.
          setDbg(function (prev) { return Object.assign({}, prev, { missingSource: { className: frame.className || '?', line: line } }) })
          return
        }
        if (dbgRef.current.missingSource !== null && dbgRef.current.missingSource !== undefined) {
          setDbg(function (prev) { return Object.assign({}, prev, { missingSource: null }) })
        }
        var alreadyOpen = openFiles.indexOf(path) !== -1
        if (!alreadyOpen) {
          if (debugOpenedRef.current.indexOf(path) === -1) debugOpenedRef.current = debugOpenedRef.current.concat([path])
          closeDebugOpenedExcept(path)
          debugOpeningRef.current = true
          openPath(path)
          debugOpeningRef.current = false
        } else {
          if (debugOpenedRef.current.indexOf(path) === -1) debugOpenedRef.current = debugOpenedRef.current.concat([path])
          closeDebugOpenedExcept(path)
        }
        // Stepping BACK to a file that is already an open tab must activate it:
        // openPath() was skipped when the tab existed, so the editor stayed on the
        // file we stepped into while the marker/highlight moved to another tab.
        if (alreadyOpen && openFile !== path) setOpenFile(path)
        setDebugFocus(function (prev) {
          debugFocusNonceRef.current += 1
          return { path: path, line: line, nonce: debugFocusNonceRef.current }
        })
        setUi(function (prev) {
          // A maximised pane would hide the line: fall back to the editor so the
          // breakpoint is actually visible. The LOG pane is the exception: while
          // debugging you usually watch the service log, and stealing it on every
          // hit made the log look "stuck" even after F8 (the pane stayed hidden).
          if (prev.maximized === null || prev.maximized === 'editor' || prev.maximized === 'log') return prev
          return Object.assign({}, prev, { maximized: 'editor' })
        })
      }
      /** Open source files, remembered across reloads (order = open order). */
      var [openFiles, setOpenFiles] = useState(function () {
        var restored = savedUi !== null && Array.isArray(savedUi.files)
          ? savedUi.files.filter(function (item) { return typeof item === 'string' && item !== '' })
          : []
        var unique = []
        restored.forEach(function (item) { if (unique.indexOf(item) === -1) unique.push(item) })
        return unique.slice(Math.max(0, unique.length - FILE_LIMIT))
      })
      var [openFile, setOpenFile] = useState(function () {
        var remembered = savedUi !== null && typeof savedUi.file === 'string' ? savedUi.file : undefined
        var files = savedUi !== null && Array.isArray(savedUi.files) ? savedUi.files : []
        if (remembered !== undefined && files.indexOf(remembered) !== -1) return remembered
        return files.length > 0 ? files[files.length - 1] : undefined
      })
      /** path -> preview pane open (`{path: true}`). Per file, not global. */
      var [previewOpen, setPreviewOpen] = useState(function () { return {} })
      /** path -> {kind:'text',text,saved} | {kind:'image'|'pdf'|'binary'|'too-large'} | {kind:'error',error} */
      var [docs, setDocs] = useState(function () { return {} })
      /** Latest docs map for async loaders (state is closure-stale otherwise). */
      var docsRef = useRef(docs)
      docsRef.current = docs
      var [savingPath, setSavingPath] = useState(undefined)
      var [pendingClose, setPendingClose] = useState(undefined)
      /** Bulk close waiting for a decision: `{keepActive, victims, dirty}`. */
      var [pendingBulk, setPendingBulk] = useState(undefined)
      /** Files opened recently (newest first), shown under the open tabs. */
      var [recentFiles, setRecentFiles] = useState(function () {
        var list = savedUi !== null && Array.isArray(savedUi.recent) ? savedUi.recent : []
        var unique = []
        list.forEach(function (item) {
          if (isNonEmptyString(item) && unique.indexOf(item) === -1) unique.push(item)
        })
        return unique.slice(0, SEARCH_RECENT_LIMIT)
      })
      /** The tab dropdown (open tabs + recent history) is open. */
      var [tabsMenuOpen, setTabsMenuOpen] = useState(false)
      /** Toolbar state each mounted sidebar viewer reports (`dirty`, `saveState`, …). */
      var [viewerStates, setViewerStates] = useState(function () { return {} })
      /** A "save then close" in flight, waiting for the viewer's saveState. */
      var [pendingSaveClose, setPendingSaveClose] = useState(undefined)
      /** path -> the viewer's `{ save, setMode }` commands (a ref: never re-renders). */
      var viewerControlsRef = useRef({})
      var [reloadTick, setReloadTick] = useState(0)
      // ONE selected program drives the debug pane AND the log pane (the console
      // switches them together), so neither pane keeps a tab strip.
      var [activePath, setActivePath] = useState(metaLogPath)
      var activePathRef = useRef(metaLogPath)
      activePathRef.current = activePath
      var viewPath = activePath
      var logTab = activePath
      var setViewPath = setActivePath
      /**
       * Follow the log another plugin window just focused. Starting/debugging from
       * the sidebar console used to move the IDE window's log pane only when the
       * debug session attached (40–55 s later): the storage event now carries it.
       */
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onStorage(event) {
          if (event.key !== LOG_FOCUS_KEY || typeof event.newValue !== 'string' || event.newValue === '') return
          var parsed
          try { parsed = JSON.parse(event.newValue) } catch (error) { return }
          var path = parsed !== null && typeof parsed.path === 'string' ? parsed.path : ''
          if (path === '') return
          var found
          for (var index = 0; index < programs.length; index += 1) {
            if (programs[index] !== null && programs[index] !== undefined && programs[index].logPath === path) {
              found = programs[index]
              break
            }
          }
          if (found !== undefined) selectProgram(found)
          else {
            setActivePath(path)
            activePathRef.current = path
          }
          // Even when the pane already shows this log: `selectProgram` is a no-op
          // for the same path, and the start that sent this broadcast may already
          // have written lines that no frame delivered. Re-read once.
          setLogNonce(function (value) { return value + 1 })
        }
        window.addEventListener('storage', onStorage)
        return function () { window.removeEventListener('storage', onStorage) }
      }, [programs])
      var setLogTab = setActivePath
      /** `programs` as of the CURRENT render (effects must not read stale props). */
      var programsRef = useRef([])
      var ideGridRef = useRef(null)
      var stripRef = useRef(null)
      /** Source-tab DOM nodes by path, for keeping the active tab in view. */
      var tabElsRef = useRef({})
      /** Wheel listeners for the two tab strips (source files + debug sections). */
      var detachSourceTabsWheel = useRef(null)
      var detachDebugTabsWheel = useRef(null)
      /**
       * Wheel-→-sideways for the SOURCE pane: the listener sits on the whole tab
       * BAR row, so the wheel works over the tabs, the ◀ ▶ paging buttons and the
       * empty space alike (the handler resolves the inner scrolling strip).
       */
      var attachSourceTabsBar = React.useCallback(function (node) {
        if (typeof detachSourceTabsWheel.current === 'function') detachSourceTabsWheel.current()
        detachSourceTabsWheel.current = attachTabStripWheel(node)
      }, [])
      /** Same wheel-→-sideways behaviour for the DEBUG section strip. */
      var attachDebugTabs = React.useCallback(function (node) {
        if (typeof detachDebugTabsWheel.current === 'function') detachDebugTabsWheel.current()
        detachDebugTabsWheel.current = attachTabStripWheel(node)
      }, [])
      var startedRef = useRef(false)
      /** Last seen event seq PER program path (one poller, several programs). */
      var seqRef = useRef({})
      var busyRef = useRef(false)
      /** One debug control call at a time: F8 twice must not resume a resumed VM. */
      var controlBusyRef = useRef(false)
      var scopeRef = useRef({ sessionId: sessionId, cwd: cwd })
      scopeRef.current = { sessionId: sessionId, cwd: cwd }

      /**
       * Memoised preview HTML (declared AFTER `scopeRef`: it reads `scopeRef.current`,
       * and a `var` read before its assignment is `undefined` — that crashed the
       * preview once with "Cannot read properties of undefined (reading 'current')").
       * Regenerating it on every unrelated re-render (a log tick, a tree frame) makes
       * React replace the preview DOM: images reload and the scroll position jumps.
       * Only the file and its text may produce a new string (the dirty marker is
       * rendered outside the HTML).
       */
      var previewingFile = openFile !== undefined && openFile !== '' && supportsTextPreview(openFile) === true && previewOpen[openFile] === true
      var previewText = previewingFile && docs[openFile] !== undefined && docs[openFile].kind === 'text' ? docs[openFile].text : ''
      var previewHtml = React.useMemo(function () {
        if (!previewingFile) return ''
        return renderMarkdown(previewText, {
          mediaUrl: function (src) {
            // Defensive: a `var` read before assignment is `undefined`, so fall back
            // to the plain scope instead of crashing the whole preview.
            var scope = scopeRef === undefined ? { sessionId: sessionId, cwd: cwd } : scopeRef.current
            return previewAssetUrl(scope, openFile, src)
          },
        })
      }, [previewingFile, openFile, previewText])

      /**
       * The log viewer's CHROME lives in the log pane's TITLE BAR now (the body is
       * only log text): service state + wrap / size / follow. Keeping the state
       * here gives the title bar and the viewer one source of truth. Find stays a
       * viewer shortcut (Ctrl+F) with its own in-body bar — no title-bar button.
       */
      var [logFollowing, setLogFollowing] = useState(true)
      var [logWrap, setLogWrap] = useState(function () { return readPref(PREF_WRAP, '1') !== '0' })
      var [logFontSize, setLogFontSize] = useState(function () { return clampFontSize(readPref(PREF_FONT_SIZE, DEFAULT_FONT_SIZE)) })
      // A different log file re-follows (the viewer used to remount and reset this).
      useEffect(function () {
        setLogFollowing(true)
      }, [activePath])
      /** Toggle the log's soft wrap (persisted like the old in-body bar did). */
      function toggleLogWrap() {
        setLogWrap(function (previous) {
          var next = !previous
          writePref(PREF_WRAP, next ? '1' : '0')
          return next
        })
      }
      /** Bump the LOG's own font size (the pane A−/A+ is the IDE-wide one). */
      function bumpLogFont(delta) {
        setLogFontSize(function (previous) {
          var next = clampFontSize(previous + delta)
          writePref(PREF_FONT_SIZE, String(next))
          return next
        })
      }

      /** Tab label of a program (project name), falling back to the log file name. */
      function programNameOf(logPathValue) {
        for (var index = 0; index < programs.length; index += 1) {
          if (programs[index].logPath === logPathValue) return programs[index].name
        }
        return String(logPathValue).split('/').pop().replace(/\.log$/, '')
      }
      /** Basename of a file path. */
      function shortName(path) { return String(path === undefined || path === null ? '' : path).split('/').pop() }

      // The debug/log target follows the SELECTED debug tab, not "the first
      // program": the workbench is workspace-level, several programs coexist.
      var viewProgram = undefined
      for (var programIndex = 0; programIndex < programs.length; programIndex += 1) {
        if (programs[programIndex].logPath === viewPath) { viewProgram = programs[programIndex]; break }
      }
      programsRef.current = programs
      programsRef.current = programs
      var debuggable = viewProgram !== undefined ? viewProgram.kind === 'spring' : metaKind === 'spring'
      /** The one program both panes show (undefined until something is selected). */
      var activeProgram = viewProgram
      var debugProgramId = viewProgram !== undefined ? viewProgram.id : (programKey !== '' ? programKey : undefined)

      function call(action, params, path) {
        return requestDebug(action, scopeRef.current, Object.assign({ path: path !== undefined ? path : viewPath }, params))
      }
      /**
       * Show a transient hint: floats at the bottom, stacks vertically, fades after
       * {@link TOAST_TTL_MS}. Replaces the old single inline note line (which had to
       * be dismissed by hand and only ever showed the LAST message).
       * @param {string} text - the message.
       */
      function note(text) {
        if (typeof text !== 'string' || text === '') return
        toastSeqRef.current += 1
        var id = toastSeqRef.current
        setToasts(function (prev) { return capToasts((prev || []).concat([{ id: id, text: text }])) })
        setMessages(function (prev) { return capMessages((prev || []).concat([{ id: id, text: text, at: Date.now() }])) })
        setUnreadMessages(function (prev) { return prev + 1 })
        if (typeof setTimeout !== 'function') return
        toastTimersRef.current[id] = setTimeout(function () {
          delete toastTimersRef.current[id]
          setToasts(function (prev) { return (prev || []).filter(function (item) { return item.id !== id }) })
        }, TOAST_TTL_MS)
      }
      /** Drop one hint now (its ✕ / the auto-dismiss timer both land here). */
      function dismissToast(id) {
        var timer = toastTimersRef.current[id]
        if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer)
        delete toastTimersRef.current[id]
        setToasts(function (prev) { return (prev || []).filter(function (item) { return item.id !== id }) })
      }
      useEffect(function () {
        return function () {
          var timers = toastTimersRef.current
          Object.keys(timers).forEach(function (key) { if (typeof clearTimeout === 'function') clearTimeout(timers[key]) })
          toastTimersRef.current = {}
        }
      }, [])
      /** Replace the global breakpoint list AND the copy this workbench renders. */
      function setBreakpoints(next) {
        var list = typeof next === 'function' ? next(GLOBAL_BREAKPOINTS.slice()) : next
        GLOBAL_BREAKPOINTS = Array.isArray(list) ? list : []
        setDbg(function (prev) { return Object.assign({}, prev, { breakpoints: GLOBAL_BREAKPOINTS }) })
      }
      function merge(payload) {
        var seqPath = payload !== null && payload !== undefined && typeof payload.logPath === 'string' ? payload.logPath : viewPath
        if (payload !== null && payload !== undefined && payload.seq !== undefined && seqPath !== '') seqRef.current[seqPath] = payload.seq
        var breakpoints = mergeGlobalBreakpoints(payload)
        setDbg(function (prev) {
          return {
            attached: payload.attached === true,
            port: payload.port !== undefined ? payload.port : prev.port,
            suspended: debugSnapshotSuspended(payload),
            suspendedThreads: Array.isArray(payload.suspendedThreads) ? payload.suspendedThreads.map(function (id) { return String(id) }) : [],
            currentThreadId: payload.currentThreadId === undefined || payload.currentThreadId === null ? null : String(payload.currentThreadId),
            seq: payload.seq !== undefined ? payload.seq : prev.seq,
            events: (payload.events || []).concat(prev.events).slice(0, 200),
            breakpoints: breakpoints,
            threads: prev.threads,
            frames: prev.frames,
            variables: prev.variables,
            missingSource: prev.missingSource,
            lastError: payload.lastError !== undefined ? payload.lastError : prev.lastError,
          }
        })
      }

      // ── documents ────────────────────────────────────────────────────────
      /** Whether one open file has text that differs from what is on disk. */
      function isDirty(path) {
        return docDirty(docs[path], viewerStates[path])
      }
      /**
       * Forget one path's document AND the last viewer state it reported.
       *
       * Closing with 不保存 drops the tab (and its document), but the viewer's
       * reported `dirty` used to survive in `viewerStates`; reopening the same
       * path then showed `*` again (and a kept document could keep the old draft).
       * Any close/discard must clear both, so a reopen always reads from disk.
       * @param {string} path - absolute file path.
       */
      function forgetDoc(path) {
        setDocs(function (prev) {
          if (prev[path] === undefined) return prev
          var next = Object.assign({}, prev)
          delete next[path]
          return next
        })
        setViewerStates(function (prev) {
          if (prev[path] === undefined) return prev
          var next = Object.assign({}, prev)
          delete next[path]
          return next
        })
      }
      /** Load one document (idempotent): media kinds need no read at all. */
      function ensureDoc(path) {
        if (typeof path !== 'string' || path === '') return
        if (docs[path] !== undefined) return
        if (isPdfPath(path) || isImagePath(path)) {
          var kind = isPdfPath(path) ? 'pdf' : 'image'
          setDocs(function (prev) { if (prev[path] !== undefined) return prev; var next = Object.assign({}, prev); next[path] = { kind: kind }; return next })
          return
        }
        var cancelled = { current: false }
        fsRead(scopeRef.current, path).then(function (text) {
          if (cancelled.current) return
          // CodeMirror normalises CRLF to LF internally; keep the document in LF
          // and remember the file's own EOL so saving writes it back unchanged
          // (otherwise every CRLF file opened dirty).
          var raw = typeof text === 'string' ? text : ''
          var eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n'
          var normalized = eol === '\r\n' ? raw.replace(/\r\n/g, '\n') : raw
          setDocs(function (prev) { var next = Object.assign({}, prev); next[path] = { kind: 'text', text: normalized, saved: normalized, eol: eol }; return next })
        }).catch(function (problem) {
          if (cancelled.current) return
          var code = problem && problem.kind !== undefined ? problem.kind : undefined
          if (code === 'too-large') {
            // Above the whole-read limit: open a windowed READ-ONLY preview
            // instead of an empty "文件过大" state.
            var size = typeof problem.size === 'number' ? problem.size : 0
            setDocs(function (prev) {
              if (prev[path] !== undefined) return prev
              var next = Object.assign({}, prev)
              next[path] = { kind: 'large-text', text: '', offset: 0, next: 0, eof: false, size: size, loading: false, error: undefined, dropLines: 0 }
              return next
            })
            void loadLargeTextPage(path)
            return
          }
          setDocs(function (prev) {
            var next = Object.assign({}, prev)
            next[path] = code === 'binary'
              ? { kind: code }
              : { kind: 'error', error: messageOf(problem) || '读取失败' }
            return next
          })
        })
      }
      /**
       * Append the next page to a large text preview.
       *
       * The preview keeps the loaded text in memory but only renders the visible
       * slice, and stops at `LARGE_TEXT_MAX_BYTES`, so opening a 1 GB log costs one
       * window, not the file.
       * @param {string} path - file path whose page should be appended.
       */
      async function loadLargeTextPage(path) {
        var doc = docsRef.current[path]
        if (doc === undefined || doc.kind !== 'large-text') return
        if (doc.loading === true || doc.eof === true) return
        var from = typeof doc.next === 'number' ? doc.next : 0
        setDocs(function (prev) {
          var current = prev[path]
          if (current === undefined || current.kind !== 'large-text' || current.loading === true) return prev
          var next = Object.assign({}, prev)
          next[path] = Object.assign({}, current, { loading: true })
          return next
        })
        var page
        try {
          page = await fsWindowRead(scopeRef.current, path, from, LARGE_TEXT_WINDOW_BYTES)
        } catch (problem) {
          setDocs(function (prev) {
            var current = prev[path]
            if (current === undefined || current.kind !== 'large-text') return prev
            var next = Object.assign({}, prev)
            next[path] = Object.assign({}, current, { loading: false, error: messageOf(problem) || '读取失败' })
            return next
          })
          return
        }
        setDocs(function (prev) {
          var current = prev[path]
          if (current === undefined || current.kind !== 'large-text') return prev
          // Keep memory bounded while the reader keeps scrolling: drop the front
          // (at a line boundary) once the buffer passes the cap, and remember how
          // many lines went away so the virtual grid stays aligned.
          var loaded = String(current.text || '') + page.text
          var trimmed = trimLargeTextFront(loaded, LARGE_TEXT_MAX_BYTES)
          var next = Object.assign({}, prev)
          next[path] = Object.assign({}, current, {
            text: trimmed.text,
            dropLines: (typeof current.dropLines === 'number' ? current.dropLines : 0) + trimmed.droppedLines,
            offset: page.offset,
            next: page.next,
            eof: page.eof,
            size: page.size || current.size,
            loading: false,
            error: undefined,
          })
          return next
        })
      }

      /**
       * Start the large-text preview over from byte 0, discarding the tail buffer.
       * Used by the "从头加载" button once earlier pages have been freed.
       * @param {string} path - file whose preview should restart.
       */
      function reloadLargeTextFromStart(path) {
        setDocs(function (prev) {
          var current = prev[path]
          if (current === undefined || current.kind !== 'large-text') return prev
          var next = Object.assign({}, prev)
          next[path] = Object.assign({}, current, {
            text: '', offset: 0, next: 0, eof: false, dropLines: 0, loading: false, error: undefined,
          })
          return next
        })
        void loadLargeTextPage(path)
      }

      /**
       * Toggle the inline preview for the active Markdown/HTML file.
       *
       * This is rendered INSIDE the workbench (no DSH sidebar resource tab): the
       * IDE also runs in its own standalone window, where `panelCtx` is null and
       * `ctx.sidebarRight` does not exist, so delegating to the official preview
       * tab made 👁 fail with "右侧栏服务不可用". Rendering here works in both
       * hosts and previews the live buffer, not the stale on-disk copy.
       */
      function togglePreview() {
        if (openFile === '' || !supportsTextPreview(openFile)) return
        var target = openFile
        setPreviewOpen(function (prev) {
          var next = Object.assign({}, prev)
          if (next[target] === true) delete next[target]
          else next[target] = true
          return next
        })
      }

      function openPath(target) {
        var path = absolutePath(cwd, target)
        if (debugOpeningRef.current !== true && debugOpenedRef.current.indexOf(path) !== -1) {
          // The user opened this file themselves: it is no longer a debug-owned tab.
          debugOpenedRef.current = debugOpenedRef.current.filter(function (item) { return item !== path })
        }
        // PDF/Office/Excel: the official preview tab renders these better than
        // anything this panel can do, so hand them over instead of opening a
        // binary tab (images still render inline here).
        if (shouldUseOfficialPreview(path)) {
          try {
            openOfficialPreview(panelCtx, scopeRef.current !== undefined ? scopeRef.current : { sessionId: '', cwd: cwd }, path)
          } catch (error) {
            note('官方预览不可用：' + messageOf(error))
          }
          return
        }
        var next = capOpenFiles(openFiles, path, FILE_LIMIT, isDirty)
        if (next === null) {
          note('已打开 ' + FILE_LIMIT + ' 个文件且都有未保存修改，请先关闭一个再打开 ' + shortName(path))
          return
        }
        // A path that is NOT already open must be read from disk: a document or
        // viewer dirty flag left over from a previous (discarded) open would
        // otherwise make the reopened tab show `*` again.
        if (openFiles.indexOf(path) === -1) forgetDoc(path)
        if (next !== openFiles) setOpenFiles(next)
        setOpenFile(path)
        setRecentFiles(function (previous) { return pushRecent(previous, path, SEARCH_RECENT_LIMIT) })
      }
      function closePath(path) {
        debugOpenedRef.current = debugOpenedRef.current.filter(function (item) { return item !== path })
        var index = openFiles.indexOf(path)
        if (index === -1) { forgetDoc(path); return }
        var next = openFiles.filter(function (item) { return item !== path })
        setOpenFiles(next)
        forgetDoc(path)
        if (path !== openFile) return
        setOpenFile(next.length === 0 ? undefined : next[Math.min(Math.max(index, 0), next.length - 1)])
      }
      /**
       * Reopen a path picked from a history row (search box or tab dropdown).
       * A file that no longer exists is dropped from the history instead of
       * opening a tab that can only fail.
       * @param {string} path - remembered absolute path.
       */
      async function openRecentPath(path) {
        var missing = await fileMissing(scopeRef.current, path)
        if (missing) {
          setRecentFiles(function (previous) {
            return previous.filter(function (item) { return item !== path })
          })
          note('文件不存在，已从最近历史移除：' + shortName(path))
          return
        }
        openPath(path)
      }
      /** Close a tab, asking about unsaved changes first. */
      function requestClose(path) {
        if (isDirty(path)) setPendingClose(path)
        else closePath(path)
      }
      /** Disk text for a document: restore the file's original line endings. */
      function docTextForDisk(doc) {
        if (doc === undefined || doc === null) return ''
        var text = typeof doc.text === 'string' ? doc.text : ''
        return doc.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
      }
      function savePath(path) {
        var controls = viewerControlsRef.current[path]
        if (controls !== undefined && typeof controls.save === 'function') {
          // The sidebar viewer owns the document; its save writes through the
          // sidebar's own /sidebar/write route and reports saveState back.
          controls.save()
          return Promise.resolve(true)
        }
        var doc = docs[path]
        if (doc === undefined || doc.kind !== 'text') return Promise.resolve(true)
        setSavingPath(path)
        return fsWrite(scopeRef.current, path, docTextForDisk(doc)).then(function () {
          setDocs(function (prev) {
            var next = Object.assign({}, prev)
            var current = next[path]
            if (current !== undefined) next[path] = Object.assign({}, current, { saved: current.text })
            return next
          })
          return true
        }).catch(function (problem) {
          note('保存失败：' + messageOf(problem))
          return false
        }).then(function (ok) {
          setSavingPath(undefined)
          return ok
        })
      }
      /**
       * A tree rename changed `from` to `to`: open tabs, drafts and the history
       * follow, so the editor never keeps a tab pointing at a vanished path.
       * @param {string} from - old absolute path (a file or a whole folder).
       * @param {string} to - new absolute path.
       */
      function renamePaths(from, to) {
        if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') return
        setOpenFiles(function (prev) { return prev.map(function (path) { return remapPath(path, from, to) }) })
        setRecentFiles(function (prev) { return prev.map(function (path) { return remapPath(path, from, to) }) })
        setOpenFile(function (prev) { return typeof prev === 'string' ? remapPath(prev, from, to) : prev })
        setDocs(function (prev) {
          var next = {}
          Object.keys(prev).forEach(function (key) { next[remapPath(key, from, to)] = prev[key] })
          return next
        })
        setViewerStates(function (prev) { return {} })
        setPendingClose(function (prev) { return typeof prev === 'string' ? remapPath(prev, from, to) : prev })
      }

      /** Close a batch of tabs at once and pick the next active one. */
      function closePaths(victims) {
        if (victims.length === 0) return
        debugOpenedRef.current = debugOpenedRef.current.filter(function (item) { return victims.indexOf(item) === -1 })
        var remaining = openFiles.filter(function (path) { return victims.indexOf(path) === -1 })
        var activeClosed = openFile !== undefined && victims.indexOf(openFile) !== -1
        setOpenFiles(remaining)
        victims.forEach(function (path) { forgetDoc(path) })
        if (activeClosed) {
          var index = openFiles.indexOf(openFile)
          setOpenFile(remaining.length === 0 ? undefined : remaining[Math.min(Math.max(index, 0), remaining.length - 1)])
        }
        setPendingBulk(undefined)
      }
      /** Save every dirty victim of a bulk close; false when one write failed. */
      async function saveBulk(paths) {
        for (var index = 0; index < paths.length; index += 1) {
          var path = paths[index]
          var doc = docs[path]
          if (doc === undefined || doc.kind !== 'text' || isDirty(path) !== true) continue
          try {
            await fsWrite(scopeRef.current, path, docTextForDisk(doc))
          } catch (problem) {
            note('保存失败：' + shortName(path) + ' ' + messageOf(problem))
            return false
          }
          setDocs(function (previous) {
            var next = Object.assign({}, previous)
            var current = next[path]
            if (current !== undefined && current.kind === 'text') next[path] = Object.assign({}, current, { saved: current.text })
            return next
          })
        }
        return true
      }
      /**
       * Bulk close (right-click → 关闭其他/全部关闭). Dirty tabs are never dropped
       * silently: one prompt offers save-all / discard-all / cancel for the batch.
       */
      function bulkClose(keepActive) {
        var plan = bulkClosePlan(openFiles, openFile, isDirty, keepActive)
        if (plan.victims.length === 0) {
          return
        }
        if (plan.dirty.length === 0) {
          closePaths(plan.victims)
          return
        }
        setPendingBulk({ keepActive: keepActive, victims: plan.victims, dirty: plan.dirty })
      }

      // ── debug ────────────────────────────────────────────────────────────
      async function consoleStart(program) {
        // Watch this program's log while it starts: mvn compile is quiet, so the
        // view has to switch at click time, not after the spawn settles.
        selectProgram(program)
        broadcastLogFocus(program.logPath)
        var logPath = typeof program.logPath === 'string' ? program.logPath : ''
        // Same first-output watch as the debug path. Without it the pane can sit on
        // the wrapper's marker/command line forever: a start's output arrives as
        // live frames onto an already-open stream, and one missed frame (or a
        // viewer mounted a moment too late) is never recovered by a snapshot.
        var baseline = logPath === '' ? undefined : await logSizeOf(logPath)
        setUi(function (prev) { return Object.assign({}, prev, { busy: true, note: '' }) })
        statusNote('正在启动 ' + program.name + '…', 0)
        setConsoleBusy(program.id)
        var result
        try {
          result = await requestStart(program.id, scopeRef.current)
        } finally {
          setConsoleBusy('')
        }
        setUi(function (prev) { return Object.assign({}, prev, { busy: false }) })
        if (logPath !== '') {
          setLogNonce(function (value) { return value + 1 })
          watchLogOutput(logPath, baseline)
        }
        if (result.ok !== true) return note('启动失败：' + result.error)
      }
      /** Any program with a pidfile can be stopped, frontend included. */
      async function consoleStop(program) {
        statusNote('正在停止 ' + program.name + '…', 0)
        setConsoleBusy(program.id)
        var result
        try {
          result = await requestStop(program.logPath, scopeRef.current)
        } finally {
          setConsoleBusy('')
        }
        statusNote('')
        if (result.ok !== true) return note('停止失败：' + result.error)
      }
      async function consoleDebug(program) {
        selectProgram(program)
        broadcastLogFocus(program.logPath)
        sourcePathRef.current = {}
        setDbg(function () { return { attached: false, port: null, suspended: false, suspendedThreads: [], currentThreadId: null, seq: 0, events: [], breakpoints: globalBreakpointsSnapshot(), threads: [], frames: [], variables: [], missingSource: null, lastError: null } })
        setUi(function (prev) { return Object.assign({}, prev, { busy: true, note: '正在以调试模式重启 ' + program.name + '（Spring 约 40–55s）…' }) })
        // The row keeps its own mask for the whole JDWP restart: the console must
        // not accept a second start/debug click while the JVM is coming up.
        setConsoleBusy(program.id)
        var result
        try {
          result = await requestDebug('start', scopeRef.current, { id: program.id })
        } finally {
          setConsoleBusy('')
        }
        setUi(function (prev) { return Object.assign({}, prev, { busy: false, note: result.ok === true ? ('已连接调试 ' + program.name + '，端口 ' + (result.port ?? '?')) : ('调试启动失败：' + result.error) }) })
        await pollOnce(program.logPath)
      }
      /** Add (and focus) one program's live-log tab. */
      /**
       * Open (and focus) one program's live-log tab.
       * @param {object} program - one console row.
       * @param {boolean} [force] - bypass the running check (used right after a start
       *   or a debug restart, when the rows we hold still say "stopped").
       */
      /**
       * Switch BOTH panes to one program (clicking it in the console).
       *
       * Only a running program fetches its log; a stopped one still becomes active
       * so the debug pane/breakpoints follow it.
       * @param {object} program - one console row.
       */
      function selectProgram(program) {
        if (program === null || program === undefined || typeof program.logPath !== 'string' || program.logPath === '') return
        var same = program.logPath === activePathRef.current
        if (!same) {
          setActivePath(program.logPath)
          activePathRef.current = program.logPath
          sourcePathRef.current = {}
          setVarTree({ expanded: {}, children: {}, loading: {}, items: {} })
          setDbg(function () { return { attached: false, port: null, suspended: false, suspendedThreads: [], currentThreadId: null, seq: 0, events: [], breakpoints: globalBreakpointsSnapshot(), threads: [], frames: [], variables: [], missingSource: null, lastError: null } })
        }
        void pollOnce(program.logPath)
      }
      async function loadThreads(threadId) {
        var result = await call('threads')
        if (result.ok !== true) return note('取线程失败：' + result.error)
        var threads = result.threads || []
        setDbg(function (prev) { return Object.assign({}, prev, { threads }) })
        // Only a STOPPED thread has frames. Using `threads[0]` (whichever JVM thread
        // happens to come first) made `stack` fail, which is exactly why the call
        // stack/variables stayed empty after a breakpoint hit.
        var target = threadId
        if (target === undefined) {
          var known = dbgRef.current.currentThreadId
          if (known === undefined || known === null || known === '') {
            var ids = dbgRef.current.suspendedThreads || []
            known = ids.length > 0 ? ids[ids.length - 1] : undefined
          }
          target = known
        }
        if (target !== undefined && target !== null && target !== '') await loadStack(String(target))
      }
      /**
       * The suspended TOP FRAME is the source of truth for "where the debugger is".
       * A dedicated effect watches it, so ANY update of the frame (SSE event, JSON
       * poll, manual stack read, auto-switch to another program) moves the editor:
       * switch file, scroll the line into view, highlight it. `loadStack` also calls
       * `followDebugLocation` directly for immediacy; the dedupe ref keeps that from
       * double-scrolling the same line.
       */
      useEffect(function () {
        if (dbg.suspended !== true) {
          followedFrameRef.current = ''
          return
        }
        var frames = dbg.frames || []
        if (frames.length === 0) return
        var top = frames[0]
        var line = Number(top.lineNumber)
        if (!(line > 0)) return
        var className = String(top.className || '')
        if (className === '') return
        if (followedFrameRef.current === className + ':' + line) return
        followedFrameRef.current = className + ':' + line
        void followDebugLocation(top)
      }, [dbg.frames, dbg.suspended])
      async function loadStack(threadId) {
        var result = await call('stack', { threadId: threadId, max: 50 })
        if (result.ok !== true) {
          // Pressing F8 while the previous resume is still settling makes this
          // read a running thread: that is a race, not something to report.
          if (dbgRef.current.suspended !== true) return
          return note('取栈失败：' + result.error)
        }
        var frames = result.frames || []
        setUi(function (prev) { return Object.assign({}, prev, { threadId: threadId, frameIndex: 0 }) })
        setDbg(function (prev) { return Object.assign({}, prev, { frames, variables: [] }) })
        if (frames.length > 0) {
          await loadVariables(threadId, 0)
          // Breakpoint hit / step: take the editor to the suspended line.
          await followDebugLocation(frames[0])
        }
      }
      async function loadVariables(threadId, frameIndex) {
        var result = await call('variables', { threadId: threadId, frameIndex: frameIndex })
        if (result.ok !== true) return note('取变量失败：' + result.error)
        setUi(function (prev) { return Object.assign({}, prev, { frameIndex: frameIndex }) })
        setDbg(function (prev) { return Object.assign({}, prev, { variables: result.variables || [] }) })
        // A step refreshes the values, not the tree: keep every expanded row (and
        // the item behind it) and drop the cached children so they are re-read.
        setVarTree(function (prev) { return { expanded: prev.expanded, children: {}, loading: {}, items: prev.items } })
      }
      /**
       * After a step re-reads the frame, reopen every expanded node once so the
       * visible values follow the new frame without collapsing the tree.
       */
      useEffect(function () {
        var keys = Object.keys(varTree.expanded)
        if (keys.length === 0) return
        keys.forEach(function (key) {
          if (varTree.children[key] !== undefined || varTree.loading[key] === true) return
          var item = varTree.items[key]
          if (item === undefined) return
          void loadVariableChildren(key, item)
        })
      }, [dbg.variables, ui.frameIndex])
      /**
       * Apply one `/debug/poll` payload — the JSON route and the SSE `debug` event
       * both land here, so a streamed debug session behaves exactly like a polled one.
       * @param {object} result - poll payload (`ok`, `attached`, `seq`, `events`).
       */
      async function applyPollResult(result) {
        // Stream frames and JSON poll results share this path. Older hosts send the
        // debug frame without `ok` (it is not an error shape either), so only an
        // explicit failure is ignored; the fields themselves are the contract.
        if (result === null || result === undefined || result.ok === false) return
        // A breakpoint / step suspends ONE thread (SuspendPolicy.EventThread), so
        // `vmSuspended` stays false while the program is visibly stopped.
        var suspended = debugSnapshotSuspended(result)
        var wasSuspended = dbgRef.current.suspended === true
        merge(result)
        var interesting = (result.events || []).some(function (event) {
          return event.type === 'breakpoint' || event.type === 'step' || event.type === 'vmstart'
        })
        if (interesting && result.attached === true) {
          // Stopped: land on the 参数 tab, so the stopped frame's variables are what
          // the user sees without an extra click.
          if (wasSuspended !== true && suspended) {
            setUi(function (prev) {
              if (prev.section === 'variables') return prev
              return Object.assign({}, prev, { section: 'variables' })
            })
          }
          // Only a suspended thread has frames. Between a resume reply and the
          // next stop the payload can still carry events with nothing stopped;
          // reading a running thread's stack is what produced 取栈失败.
          if (suspended) await loadThreads(debugSuspendedThreadId(result))
        }
        if (result.attached === true && !suspended) {
          // The VM runs again (e.g. the last breakpoint was removed and resumed):
          // the highlight AND the stale stack/variables must go, otherwise the
          // debug pane keeps showing frames for a thread that is not paused.
          setDebugFocus(function (prev) { return prev === null ? prev : null })
          setDbg(function (prev) {
            if (prev.suspended !== true && (prev.frames || []).length === 0 && (prev.variables || []).length === 0) return prev
            return Object.assign({}, prev, { frames: [], variables: [] })
          })
          setUi(function (prev) {
            if (prev.threadId === undefined && prev.frameIndex === 0) return prev
            return Object.assign({}, prev, { threadId: undefined, frameIndex: 0 })
          })
        }
      }

      async function pollOnce(path) {
        // `path` polls the NEW program instead of the one still in the render
        // closure; an empty path means "no program selected" and short-circuits.
        var target = path !== undefined ? path : viewPath
        if (busyRef.current || target === '') return
        busyRef.current = true
        try {
          var result = await call('poll', { since: seqRef.current[target] || 0 }, target)
          await applyPollResult(result)
        } catch (problem) {
          // A stopped program / dropped connection rejects the fetch; the pane must
          // keep working, so this becomes a hint instead of an unhandled rejection.
          note('调试状态刷新失败：' + messageOf(problem))
        } finally {
          busyRef.current = false
        }
      }
      /** Right-click menu of a tab strip: {kind:'source'|'log'|'debug', x, y}. */
      var [tabMenu, setTabMenu] = useState(null)
      var workbenchDismissals = useDismissedNotices()
      /** Floating hints at the bottom, stacked oldest→newest; each self-dismisses. */
      var [toasts, setToasts] = useState([])
      /** Session message log behind the status-bar 💬 button (oldest first). */
      var [messages, setMessages] = useState([])
      var [messagePanelOpen, setMessagePanelOpen] = useState(false)
      /** Messages the user has not looked at yet (drives the badge). */
      var [unreadMessages, setUnreadMessages] = useState(0)
      var toastSeqRef = useRef(0)
      var toastTimersRef = useRef({})
      function openTabMenu(kind, event) {
        event.preventDefault()
        event.stopPropagation()
        setTabMenu({ kind: kind, x: event.clientX, y: event.clientY })
      }
      function closeTabMenu() { setTabMenu(null) }
      function closeOtherTabsOf() { bulkClose(true) }
      function closeAllTabsOf() { bulkClose(false) }

      /** Default pane sizes: left column / left console / right bottom row. */
      var DEFAULT_SIZES = { left: 300, leftBottom: 260, rightBottom: 260, debugWidth: 300 }
      /** Top-right "restore layout": only the pane SIZES go back to defaults —
       *  maximise mode (which pane is full-screened) is the user's own choice and
       *  is deliberately left alone. */
      function resetLayout() {
        setSizes(Object.assign({}, DEFAULT_SIZES))
        setHoverSplit(null)
      }
      /** Current log size in bytes, or undefined while the log cannot be read. */
      async function logSizeOf(path) {
        try {
          var view = await readViaTailRoute(path, scopeRef.current, 1024)
          return view !== null && view !== undefined && typeof view.size === 'number' ? view.size : undefined
        } catch (error) {
          return undefined
        }
      }
      var logWatchRef = useRef(undefined)
      /**
       * Wait for the restarted service to actually WRITE something, then refresh
       * the tail. A start waits for the wrapper's marker but Maven compiles quietly
       * for 10–30 s: switching to the log at click time shows an empty file, so the
       * content only appeared once the JVM logged. This flips the view on the first
       * new byte instead of on the next unrelated refresh.
       * @param {string} path - the program log being watched.
       * @param {number|undefined} baseline - size before the start.
       */
      function watchLogOutput(path, baseline) {
        if (typeof path !== 'string' || path === '') return
        if (logWatchRef.current !== undefined) clearInterval(logWatchRef.current)
        var started = Date.now()
        var timer = setInterval(function () {
          if (Date.now() - started > 90000) { clearInterval(timer); logWatchRef.current = undefined; return }
          void logSizeOf(path).then(function (size) {
            if (size === undefined) return
            if (baseline !== undefined && size === baseline) return
            clearInterval(timer)
            logWatchRef.current = undefined
            if (activePathRef.current !== path) {
              setActivePath(path)
              activePathRef.current = path
            }
            setLogNonce(function (value) { return value + 1 })
          })
        }, 500)
        logWatchRef.current = timer
      }
      React.useEffect(function () {
        return function () { if (logWatchRef.current !== undefined) clearInterval(logWatchRef.current) }
      }, [])
      async function startDebug() {
        if (!debuggable || debugProgramId === undefined || ui.busy) {
          return
        }
        // The debug start RESTARTS that program, so its log is about to begin a
        // new run: point the log pane at it BEFORE waiting for the spawn, not
        // after the debug session attaches (~40s later).
        var target = viewProgram
        var logPath = target !== undefined && typeof target.logPath === 'string' && target.logPath !== '' ? target.logPath : ''
        if (logPath !== '') {
          if (activePathRef.current !== logPath) {
            setActivePath(logPath)
            activePathRef.current = logPath
          }
          broadcastLogFocus(logPath)
        }
        var baseline = logPath === '' ? undefined : await logSizeOf(logPath)
        setUi(function (prev) { return Object.assign({}, prev, { busy: true, note: '正在以调试模式重启（Spring 约 40–55s）…' }) })
        var result = await call('start', { id: debugProgramId })
        setUi(function (prev) { return Object.assign({}, prev, { busy: false, note: result.ok === true ? ('已连接调试，端口 ' + (result.port ?? '?')) : ('调试启动失败：' + result.error) }) })
        // The debug start RESTARTS the service, so its log file began a new run:
        // the pane is already pointed at it; wait for the first real output (Maven
        // is quiet) and re-read the tail the moment bytes appear.
        if (logPath !== '') {
          setLogNonce(function (value) { return value + 1 })
          watchLogOutput(logPath, baseline)
        }
        await pollOnce()
      }
      /** 重新调试：断开（如果已连接）再以调试模式重启，一步完成。 */
      async function restartDebug() {
        if (dbg.attached === true) await stopDebug()
        await startDebug()
      }
      async function stopDebug() {
        var result = await call('stop')
        setUi(function (prev) { return Object.assign({}, prev, { note: result.ok === true ? '已断开调试（服务继续运行）' : ('断开失败：' + result.error) }) })
        setLogNonce(function (value) { return value + 1 })
        await pollOnce()
      }
      async function control(action, kindName) {
        // A fast second F8 used to hit the host while the first resume was still
        // in flight: the second call ran against a VM with no suspended thread,
        // and the follow-up stack read failed. One control call at a time.
        if (controlBusyRef.current) return
        controlBusyRef.current = true
        try {
          await runControl(action, kindName)
        } finally {
          controlBusyRef.current = false
        }
      }
      async function runControl(action, kindName) {
        var result = kindName === undefined ? await call(action) : await call(action, { kind: kindName })
        if (result.ok !== true) return note(action + ' 失败：' + result.error)
        if (action === 'resume') {
          // Resume succeeded: the VM is running again. Flip the buttons and drop
          // the stopped frame NOW, otherwise a fast F8 still sees "suspended" and
          // fires a second resume (the source of 取栈失败).
          setDbg(function (prev) {
            if (prev.suspended !== true) return prev
            return Object.assign({}, prev, { suspended: false, suspendedThreads: [], frames: [], variables: [] })
          })
        }
        await pollOnce()
        if (result.stepped !== undefined || result.resumed !== undefined) {
          // The single-step EVENT often lands a few ms after the reply: poll once
          // more so the editor follows immediately instead of on the next tick.
          // (Do NOT load frames here: right after a step/resume the thread is not
          // stopped yet, so reading it would only fail.)
          setTimeout(function () { void pollOnce() }, 160)
          // A resume un-freezes the JVM, so its log starts moving again: pull the
          // tail once now (the suspended run may have left this viewer behind).
          setTimeout(function () { setLogNonce(function (value) { return value + 1 }) }, 200)
        }
      }
      /**
       * The program that OWNS a source file: the longest program dir that is a
       * path prefix. A breakpoint belongs to the owning program — sending it to
       * whichever program log happened to be selected made "add a breakpoint in
       * project B while A is running" a JDWP class-not-found error.
       */
      function programForSourcePath(path) {
        var best
        var bestLength = -1
        var list = programsRef.current || []
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index]
          if (item === null || item === undefined || typeof item.dir !== 'string' || item.dir === '') continue
          var dir = item.dir
          if (path === dir || path.indexOf(dir + '/') === 0 || path.indexOf(dir + '\\') === 0) {
            if (dir.length > bestLength) { best = item; bestLength = dir.length }
          }
        }
        return best
      }
      /**
       * Gutter toggle: add or remove the breakpoint on one opened-file line.
       *
       * The list flips OPTIMISTICALLY (a `pending` row/dot) so the click is
       * instant; the JDWP call then confirms it. Adding a breakpoint at RUNTIME is
       * supported by JDWP — the VM may keep running — but if the class has not
       * been loaded yet the host call waits for ClassPrepare (up to 30 s), which
       * is exactly what the pending state is for.
       */
      async function toggleBreakpoint(line) {
        var className = classNameFromPath(openFile)
        // Only Java files have classes to breakpoint: clicking the gutter of a
        // Markdown/JSON/... file simply does nothing (no toast — it is not an error).
        if (className === undefined) return
        // Blank / comment-only lines hold no executable code: the debugger would
        // snap somewhere else, so refuse quietly (no dot, no error).
        var openDoc = docs[openFile]
        var texts = openDoc !== undefined && openDoc.kind === 'text' ? String(openDoc.text).split('\n') : []
        if (isNonExecutableJavaLine(texts[line - 1])) return
        var failed = (dbg.breakpoints || []).find(function (bp) {
          return bp.className === className && bp.line === line && bp.failed === true
        })
        if (failed !== undefined) {
          // Clicking a marker that never took effect just clears it.
          setBreakpoints(function (prev) {
            return prev.filter(function (bp) { return !(bp.className === className && bp.line === line) })
          })
          return
        }
        var owner = programForSourcePath(openFile)
        var breakPath = owner !== undefined && typeof owner.logPath === 'string' && owner.logPath !== '' ? owner.logPath : viewPath
        var existing = (dbg.breakpoints || []).find(function (bp) {
          // A pre-set breakpoint (`pending`, no debug session yet) must toggle OFF
          // from the gutter too: it is a real row the user can see, and the host
          // removes it by className+line when `requestId` is the 'pending' marker.
          return bp.className === className && bp.line === line && bp.failed !== true
        })
        // No marker yet: show an optimistic `pending` dot while the JDWP call runs.
        var provisional = {
          requestId: 'pending', className: className, line: line, pending: true,
          logPath: breakPath, optimistic: true, optimisticAt: Date.now(),
        }
        if (existing !== undefined) {
          setBreakpoints(function (prev) {
            return prev.filter(function (bp) { return !(bp.className === className && bp.line === line) })
          })
        } else {
          setBreakpoints(function (prev) {
            return prev.filter(function (bp) { return !(bp.className === className && bp.line === line) }).concat([provisional])
          })
        }
        var result
        try {
          result = existing !== undefined
            ? await call('breakpoints', { remove: { requestId: existing.requestId, className: className, line: line } }, breakPath)
            : await call('breakpoints', { add: { className: className, line: line } }, breakPath)
        } catch (problem) {
          result = { ok: false, error: messageOf(problem) }
        }
        if (result.ok !== true) {
          // Keep the marker visible as FAILED (hollow ring + tooltip) instead of
          // removing it: a breakpoint that silently disappeared was worse than one
          // that stays and explains why.
          setBreakpoints(function (prev) {
            var list = prev.filter(function (bp) { return !(bp.className === className && bp.line === line) })
            if (existing !== undefined) return list.concat([existing])
            if (result.error !== undefined && /not-attached|no debug session/i.test(String(result.error))) return list
            return list.concat([{ requestId: 'failed', className: className, line: line, failed: true, error: result.error, logPath: breakPath }])
          })
          note((existing !== undefined ? '删断点失败：' : '加断点失败：') + (result.error || '未知错误'))
          return
        }
        // A pre-set breakpoint (no session yet) is installed when debugging starts.
        if (result.pending === true) {
          // Pre-set for the OWNING program (possibly not the selected one): the
          // dot is the feedback, so stay silent (toasts are for failures).
          await pollOnce(breakPath)
          return
        }
        // JDWP snaps to the nearest executable line; the marker follows the real one.
        var installedLine = result.line !== undefined && result.line !== null ? Number(result.line) : line
        if (installedLine !== line) {
          setBreakpoints(function (prev) {
            var list = prev.filter(function (bp) { return !(bp.className === className && bp.line === line && bp.pending === true) })
            return list.concat([{ requestId: result.requestId, className: className, line: installedLine, logPath: breakPath }])
          })
        }
        await pollOnce(breakPath)
      }
      /**
       * Delete one breakpoint from the debug list.
       * @param {string|number} requestId - real JDWP request id, or 'pending'.
       * @param {object} [entry] - the row (needed to match a pre-set breakpoint).
       */
      async function removeBreakpoint(requestId, entry) {
        var logPath = entry !== undefined && entry !== null && typeof entry.logPath === 'string' && entry.logPath !== '' ? entry.logPath : viewPath
        var payload = { requestId: requestId }
        if (entry !== undefined && entry !== null) {
          if (typeof entry.className === 'string') payload.className = entry.className
          if (entry.line !== undefined) payload.line = entry.line
        }
        var result = await call('breakpoints', { remove: payload }, logPath)
        if (result.ok !== true) return note('删断点失败：' + result.error)
        if (entry !== undefined && entry !== null) {
          setBreakpoints(function (prev) {
            return prev.filter(function (bp) {
              return !(bp.className === entry.className && bp.line === entry.line && String(bp.logPath === undefined ? '' : bp.logPath) === String(logPath))
            })
          })
        }
        await pollOnce(logPath)
      }
      /** Wipe every breakpoint — the host's EventRequests and local markers. */
      async function clearBreakpoints() {
        // Local markers first: failed/pending rows only exist client-side, and the
        // user hitting "clear" means ALL of them.
        var targets = []
        ;(dbg.breakpoints || []).forEach(function (bp) {
          var path = bp !== null && bp !== undefined && typeof bp.logPath === 'string' ? bp.logPath : ''
          if (path !== '' && targets.indexOf(path) === -1) targets.push(path)
        })
        if (viewPath !== '' && targets.indexOf(viewPath) === -1) targets.push(viewPath)
        setBreakpoints([])
        // The list is global, so "clear" must reach EVERY program that owns a dot:
        // each debug session (and each pre-set pending list) lives on its logPath.
        var failures = []
        for (var index = 0; index < targets.length; index += 1) {
          var cleared = await call('breakpoints', { clear: true }, targets[index])
          if (cleared.ok !== true) failures.push(targets[index])
        }
        if (failures.length > 0) note('清断点失败：' + failures.length + ' 个程序未清空')
        await pollOnce()
      }

      // ── effects ──────────────────────────────────────────────────────────
      /** Load the selected document (and a remembered one on first render). */
      useEffect(function () {
        ensureDoc(openFile)
      }, [openFile, sessionId, reloadTick])

      /** Remember open files, the active one and the layout. */
      useEffect(function () {
        try {
          if (typeof localStorage === 'undefined') return
          localStorage.setItem(storageKey, JSON.stringify({
            ui: { collapsed: ui.collapsed, maximized: ui.maximized, section: ui.section },
            files: openFiles,
            file: openFile,
            recent: recentFiles,
            sizes: sizes,
            font: uiFont,
          }))
        } catch (error) { /* private mode / quota: layout memory is best-effort */ }
      }, [ui.collapsed, ui.maximized, ui.section, openFiles, openFile, recentFiles, sizes.left, sizes.leftBottom, sizes.rightBottom, sizes.debugWidth, uiFont])

      /**
       * Ctrl/Cmd+W closes the active source tab (asking when dirty); Ctrl/Cmd+F4
       * does the same. The handler is registered in the CAPTURE phase and claims
       * the key even when no tab is open: otherwise Chrome applies its own
       * "close the window" behaviour and the whole DSH window disappears.
       */
      useEffect(function () {
        if (!visible) return undefined
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onKey(event) {
          if (!ownsKeyTarget(event.target)) return
          if (!closeTabChord({
            key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
            altKey: event.altKey, shiftKey: event.shiftKey,
          })) return
          // Ctrl+W is claimed, but browsers may close the tab anyway; Alt+W and
          // Ctrl+Alt+W always reach this handler. `stopImmediatePropagation` keeps
          // the host's own shortcut adapter out of the way as well.
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          if (typeof openFile !== 'string') {
            return
          }
          requestClose(openFile)
        }
        window.addEventListener('keydown', onKey, true)
        return function () { window.removeEventListener('keydown', onKey, true) }
      }, [openFile, docs, visible])

      /** The message panel closes on a click anywhere else (or Escape). */
      useEffect(function () {
        if (!messagePanelOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onDown(event) {
          var target = event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function'
            && target.closest('[data-message-panel="1"],[data-action="messages"]') !== null) return
          setMessagePanelOpen(false)
        }
        function onKey(event) { if (event.key === 'Escape') setMessagePanelOpen(false) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
      }, [messagePanelOpen])

      /** The tab context menu closes on any outside click or Escape. */
      useEffect(function () {
        if (tabsMenuOpen !== true || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onDown() { setTabsMenuOpen(false) }
        function onKey(event) { if (event.key === 'Escape') setTabsMenuOpen(false) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [tabsMenuOpen])

      useEffect(function () {
        if (tabMenu === null || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onDown() { setTabMenu(null) }
        function onKey(event) { if (event.key === 'Escape') setTabMenu(null) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
      }, [tabMenu])

      /** Toolbar search: debounce, then ask the sidebar's fs.search for matches. */
      useEffect(function () {
        var text = treeQuery.trim()
        if (text === '') { setSearchHits(null); setSearchBusy(false); return undefined }
        var cancelled = false
        setSearchBusy(true)
        var timer = setTimeout(function () {
          fsSearch(scopeRef.current, text).then(function (result) {
            if (cancelled) return
            setSearchHits(searchHitPayload(result, cwd))
            setSearchBusy(false)
          }).catch(function (problem) {
            if (cancelled) return
            setSearchHits({ error: messageOf(problem) || '未知错误' })
            setSearchBusy(false)
          })
        }, 250)
        return function () { cancelled = true; clearTimeout(timer) }
      }, [treeQuery, cwd])

      /**
       * New results (and every keystroke) reset the highlight: the row whose file
       * name matches the query exactly, else the first row — so the dropdown opens
       * with a visible target and Enter is never a no-op.
       */
      useEffect(function () {
        setSearchActive(searchHitActiveIndex(searchHits, treeQuery))
      }, [searchHits, treeQuery])

      /** A dropdown pick: open files, reveal either kind in the tree, close the list. */
      function pickSearchHit(path, isDir) {
        setTreeQuery('')
        setSearchHits(null)
        locateNonceRef.current += 1
        setLocateRequest({ kind: isDir === true ? 'dir' : 'file', path: path, nonce: locateNonceRef.current })
        if (isDir !== true) openPath(path)
      }

      var runningSignature = programs.filter(function (program) {
        return program.running !== null && program.running !== undefined && program.running.alive === true
      }).map(function (program) { return program.kind + '|' + program.logPath }).join(',')
      // First load with no explicit target: pick the first RUNNING service (else the
      // first program) so both panes show something instead of a blank placeholder.
      useEffect(function () {
        var running = programs.filter(function (program) {
          return program.running !== null && program.running !== undefined && program.running.alive === true
        })
        if (running.length === 0) return
        if (activePathRef.current !== '') return
        var preferred = running.filter(function (program) { return program.kind === 'spring' })[0] || running[0]
        if (preferred !== undefined) {
          setActivePath(preferred.logPath)
          activePathRef.current = preferred.logPath
        }
      }, [runningSignature, sessionId])

      /** Finish a "save then close": the viewer's saveState is the signal. */
      useEffect(function () {
        if (pendingSaveClose === undefined) return
        var state = viewerStates[pendingSaveClose]
        if (state === undefined) return
        if (state.saveState === 'saved') {
          var target = pendingSaveClose
          setPendingSaveClose(undefined)
          closePath(target)
        } else if (state.saveState === 'failed') {
          setPendingSaveClose(undefined)
          note('保存失败，页签保持打开')
        }
      }, [viewerStates, pendingSaveClose])

      /**
       * Poll the debug session only while this tab is visible, and only as fast as
       * there is something to watch: 700 ms while attached, 5 s otherwise (a
       * session started elsewhere is still picked up within one slow tick).
       */
      /** Debug events stream; false ⇒ the JSON poll below takes over. */
      var [debugStreamOk, setDebugStreamOk] = useState(function () { return typeof EventSource === 'function' })
      useEffect(function () {
        if (!visible || viewPath === '' || debugStreamOk !== true) return undefined
        if (typeof EventSource !== 'function') return undefined
        var failures = 0
        return risStreamHub().subscribe({
          topics: ['debug', 'debug-error'],
          sessionId: sessionId ?? '',
          cwd: typeof cwd === 'string' ? cwd : undefined,
          debugPath: viewPath,
          handlers: {
            debug: function (payload) {
              void applyPollResult(payload).catch(function (problem) {
                console.error('[dsh-ris-ide] debug frame failed', problem)
              })
            },
            'debug-error': function (payload) {
              note(payload !== null && payload !== undefined && typeof payload.error === 'string' ? payload.error : '调试流中断')
            },
          },
          onOpen: function () {
            failures = 0
            setDebugStreamOk(true)
          },
          onError: function (readyState) {
            failures += 1
            if (failures >= 2 || readyState === 2) setDebugStreamOk(false)
          },
        })
      }, [visible, viewPath, sessionId, cwd, debugStreamOk])

      useEffect(function () {
        if (!visible || viewPath === '' || debugStreamOk) return undefined
        var cancelled = false
        var timer = null
        function schedule() {
          timer = setTimeout(async function () {
            if (cancelled) return
            var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
            if (!hidden) await pollOnce()
            if (!cancelled) schedule()
          }, debugPollDelay(dbg.attached === true))
        }
        void pollOnce()
        schedule()
        return function () {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [visible, viewPath, sessionId, dbg.attached, debugStreamOk])

      /**
       * Follow a breakpoint that hits in a program we are NOT showing.
       *
       * The fast poller only talks to one session, so every ~1.2 s this asks the
       * host for ALL live sessions: one that suspended (or has events newer than we
       * have seen) becomes the active program. Polling it then loads events →
       * threads → stack → `followDebugLocation()`, which opens the source file at the
       * hit line and highlights it.
       */
      var [sessionsStreamOk, setSessionsStreamOk] = useState(function () { return typeof EventSource === 'function' })
      useEffect(function () {
        if (!visible) return undefined
        var cancelled = false
        var timer = null
        var unsubscribe = null
        var sessionsStreamFailures = 0
        /** One session list, from either the stream or the fallback poll. */
        async function applySessions(sessions) {
          if (cancelled) return
          for (var index = 0; index < sessions.length; index += 1) {
            var session = sessions[index]
            if (session === null || session.attached !== true || typeof session.logPath !== 'string') continue
            var known = seqRef.current[session.logPath]
            if (session.logPath === activePathRef.current) {
              seqRef.current[session.logPath] = Math.max(known || 0, Number(session.seq) || 0)
              continue
            }
            var freshEvents = known !== undefined && Number(session.seq) > known
            if (!freshEvents && debugSnapshotSuspended(session) !== true) continue
            var target = session.logPath
            setActivePath(target)
            activePathRef.current = target
            setDbg(function () { return { attached: false, port: null, suspended: false, suspendedThreads: [], currentThreadId: null, seq: 0, events: [], breakpoints: globalBreakpointsSnapshot(), threads: [], frames: [], variables: [], missingSource: null, lastError: null } })
            var hitName = ''
            var list = programsRef.current || []
            for (var scan = 0; scan < list.length; scan += 1) {
              if (list[scan].logPath === target) { hitName = list[scan].name; break }
            }
            await pollOnce(target)
            break
          }
        }
        if (sessionsStreamOk === true && typeof EventSource === 'function') {
          unsubscribe = risStreamHub().subscribe({
            topics: ['debugs'],
            onOpen: function () {
              sessionsStreamFailures = 0
              setSessionsStreamOk(true)
            },
            onError: function (readyState) {
              sessionsStreamFailures += 1
              if (sessionsStreamFailures >= 2 || readyState === 2) setSessionsStreamOk(false)
            },
            handlers: {
              debugs: function (payload) {
                if (Array.isArray(payload.sessions)) {
                  void applySessions(payload.sessions).catch(function (problem) {
                    console.error('[dsh-ris-ide] sessions frame failed', problem)
                  })
                }
              },
            },
          })
        }
        async function tick() {
          if (cancelled) return
          var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
          if (!hidden) {
            var result = await requestDebugs(scopeRef.current)
            if (result.ok === true && Array.isArray(result.sessions)) await applySessions(result.sessions)
          }
          if (!cancelled) timer = setTimeout(tick, 1200)
        }
        if (sessionsStreamOk !== true) timer = setTimeout(tick, 1200)
        return function () {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          if (unsubscribe !== null) unsubscribe()
        }
      }, [visible, sessionId, sessionsStreamOk])

      /**
       * Whether a keyboard event belongs to the IDE: only the standalone IDE
       * window (whole body) claims browser shortcuts. A DSH page never does, even
       * when the keydown target sits inside the IDE tab.
       * @param {EventTarget|null|undefined} target - the keydown target.
       * @returns {boolean} true when the IDE should claim the key.
       */
      function ownsKeyTarget(target) {
        // The standalone IDE window owns the whole body. On a DSH page the IDE
        // tab shares the page with the host, so it claims NO browser shortcuts:
        // Ctrl+W/Ctrl+R/F5 keep their browser meaning there (the panel still has
        // its own keymaps for editing).
        return inStandaloneIdeWindow()
      }
      /**
       * Eclipse-style debug keys: F5 step into, F6 step over, F7 step out, F8
       * resume. While a debug session is attached the whole F5..F8 row belongs to
       * the IDE (F5 must never reload the window mid-debug, even after a click
       * moved focus elsewhere); with no session F5 is the browser's reload again.
       */
      useEffect(function () {
        if (!visible || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onKey(event) {
          if (!ownsKeyTarget(event.target)) return
          if (event.ctrlKey || event.metaKey || event.altKey) return
          var action = debugShortcut(event.key, { attached: dbg.attached, suspended: dbg.suspended })
          if (action === undefined) return
          event.preventDefault()
          if (action.kind === 'swallow') return
          if (action.mode === 'resume') void control('resume')
          else if (action.mode === 'step-over') void control('step', 'over')
          else if (action.mode === 'step-into') void control('step', 'into')
          else if (action.mode === 'step-out') void control('step', 'out')
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [visible, viewPath, dbg.attached, dbg.suspended])

      /** `autoDebug` (the 「调试」 button) starts the session on arrival. */
      useEffect(function () {
        if (!debuggable || startedRef.current) return
        if (meta.autoDebug === true && typeof sessionId === 'string' && sessionId !== '') {
          startedRef.current = true
          void startDebug()
        }
      }, [])

      // ── small pieces ─────────────────────────────────────────────────────
      /**
       * One button. `icon: true` pins a fixed width (22px, centred) — glyphs like
       * ▶ ■ 调试图标 ▤ have different advance widths, so without this the control rows
       * (console, debug toolbar, top bar) look ragged.
       */
      function button(label, handler, options) {
        var opts = options || {}
        var base = opts.start === true
          ? (opts.disabled === true ? S.buttonDisabled : S.start)
          : opts.debug === true ? S.debug
            : opts.stop === true
            ? (opts.disabled === true ? S.stopDisabled : S.stop)
            : (opts.disabled === true ? S.buttonDisabled : (opts.off === true ? S.buttonOff : S.button))
        var style = Object.assign({}, base)
        if (opts.icon === true) Object.assign(style, { width: 22, minWidth: 22, padding: '1px 0', textAlign: 'center' })
        if (typeof opts.width === 'number') Object.assign(style, { width: opts.width, minWidth: opts.width })
        if (typeof opts.height === 'number') {
          // One fixed row height: the top bar mixes glyph buttons (📄 ⚙ ⟲) with
          // two-character ones (A- A+), and padding-only sizing made them differ
          // by a pixel or two.
          Object.assign(style, {
            height: opts.height, minHeight: opts.height, lineHeight: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            paddingTop: 0, paddingBottom: 0,
          })
        }
        return h('button', {
          key: opts.key,
          type: 'button', style: style,
          disabled: opts.disabled === true,
          'data-action': opts.action, 'data-theme-state': opts['data-theme-state'], title: opts.title, onClick: handler,
        }, label)
      }
      /** How many rows the tab's section currently holds (0 → no badge). */
      function debugSectionCount(id) {
        if (id === 'breakpoints') return (dbg.breakpoints || []).length
        if (id === 'threads') return (dbg.threads || []).length
        if (id === 'stack') return (dbg.frames || []).length
        if (id === 'variables') return (dbg.variables || []).length
        return (dbg.events || []).length
      }
      /** One debug section TAB (the 断点/线程/… switcher is a tab strip now). */
      function tabButton(section) {
        var active = ui.section === section.id
        var count = debugSectionCount(section.id)
        return h('button', {
          key: section.id,
          type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false',
          style: active ? S.debugSectionTabOn : S.debugSectionTab,
          'data-section': section.id,
          title: section.label + (count > 0 ? '（' + count + '）' : ''),
          onClick: function () { setUi(function (prev) { return Object.assign({}, prev, { section: section.id }) }) },
        }, section.label, count > 0 ? h('span', { style: S.debugTabCount }, String(count)) : null)
      }
      /** Page the tab strip left/right (the strip itself scrolls horizontally). */
      function pageTabs(direction) {
        var node = stripRef.current
        if (node === null || node === undefined || typeof node.scrollBy !== 'function') return
        node.scrollBy({ left: direction * Math.max(120, node.clientWidth - 60), behavior: 'smooth' })
      }
      // Opening a file, or following the debugger into one, must make its tab
      // reachable without hunting with the ◀ / ▶ buttons: scroll just the STRIP
      // (never an ancestor) until the active tab sits inside its viewport.
      useEffect(function () {
        var strip = stripRef.current
        var tab = tabElsRef.current[openFile]
        if (strip === null || strip === undefined || tab === null || tab === undefined) return
        var margin = 8
        var stripBox = strip.getBoundingClientRect()
        var tabBox = tab.getBoundingClientRect()
        if (tabBox.left < stripBox.left + margin) {
          strip.scrollLeft = Math.max(0, strip.scrollLeft - (stripBox.left - tabBox.left) - margin)
        } else if (tabBox.right > stripBox.right - margin) {
          strip.scrollLeft = strip.scrollLeft + (tabBox.right - stripBox.right) + margin
        }
      }, [openFile, openFiles.length])

      /**
       * Expand/collapse one variable row (lazy tree).
       *
       * Only a row carrying a JDWP `objectId` is expandable; its fields / array
       * entries are fetched once through `debug/expand`, then cached per key.
       * @param {string} key - the row's stable key.
       * @param {object} item - the variable entry (needs `objectId`).
       */
      /**
       * Fetch one row's children through `debug/expand` and cache them.
       *
       * Errors (JDWP hiccup, host restart) stay inside the pane: the loading marker
       * is cleared and a toast explains, so a broken expand never crashes the app.
       */
      async function loadVariableChildren(key, item) {
        if (item === null || item === undefined || typeof item.objectId !== 'string' || item.objectId === '') return
        setVarTree(function (prev) {
          return Object.assign({}, prev, { loading: Object.assign({}, prev.loading, { [key]: true }) })
        })
        var result
        try {
          result = await call('expand', { objectId: item.objectId })
        } catch (problem) {
          result = { ok: false, error: messageOf(problem) }
        }
        setVarTree(function (prev) {
          var next = { expanded: Object.assign({}, prev.expanded), children: Object.assign({}, prev.children), loading: Object.assign({}, prev.loading), items: Object.assign({}, prev.items) }
          delete next.loading[key]
          if (result.ok !== true) {
            note('展开失败：' + result.error)
            return next
          }
          var children = []
          if (result.kind === 'array') {
            (result.entries || []).forEach(function (entry) {
              children.push(Object.assign({}, entry, { name: '[' + entry.index + ']' }))
            })
            if (result.truncated === true) {
              children.push({ name: '…', value: '还有 ' + Math.max(0, Number(result.length || 0) - children.length) + ' 项（只列前 100）' })
            }
          } else {
            children = result.fields || []
            if (children.length === 0) children.push({ name: '…', value: '（没有字段）' })
          }
          next.children[key] = children
          // Remember the child rows too, so an already-open grandchild can refresh
          // after the next step without the user collapsing the tree.
          children.forEach(function (child, index) {
            if (child === null || child === undefined) return
            if (typeof child.objectId !== 'string' || child.objectId === '') return
            var name = child.name !== undefined ? child.name : '[' + index + ']'
            next.items[key + '/' + name + '#' + index] = child
          })
          return next
        })
      }
      /**
       * Expand/collapse one variable row (lazy tree).
       *
       * Only a row carrying a JDWP `objectId` is expandable; its fields / array
       * entries are fetched once through `debug/expand`, then cached per key.
       * @param {string} key - the row's stable key.
       * @param {object} item - the variable entry (needs `objectId`).
       */
      function toggleVariable(key, item) {
        var open = varTree.expanded[key] === true
        if (open) {
          setVarTree(function (prev) {
            var expanded = Object.assign({}, prev.expanded)
            delete expanded[key]
            return Object.assign({}, prev, { expanded: expanded })
          })
          return
        }
        setVarTree(function (prev) {
          return Object.assign({}, prev, {
            expanded: Object.assign({}, prev.expanded, { [key]: true }),
            items: Object.assign({}, prev.items, { [key]: item }),
          })
        })
        if (Array.isArray(varTree.children[key])) return
        void loadVariableChildren(key, item)
      }
      /** One level of the variable tree (recursive, depth-capped). */
      function variableRows(items, parentKey, depth) {
        var out = []
        ;(items || []).forEach(function (item, index) {
          var raw = item === null || item === undefined ? {} : item
          var name = raw.name !== undefined ? raw.name : '[' + (raw.index !== undefined ? raw.index : index) + ']'
          var key = parentKey + '/' + name + '#' + (raw.index !== undefined ? raw.index : index)
          var expandable = (raw.kind === 'object' || raw.kind === 'array') && typeof raw.objectId === 'string' && raw.objectId !== '' && depth < 8
          var value = raw.stringValue !== undefined && raw.stringValue !== null ? raw.stringValue : raw.value
          var display = typeof value === 'string' ? value : String(value)
          var open = varTree.expanded[key] === true
          var loading = varTree.loading[key] === true
          var hint = raw.kind === 'array' ? 'Array' : raw.kind === 'object' ? 'Object' : ''
          // A tree caret, not a button: no border/box around the glyph, so the
          // variable list reads like IDEA/VSCode's variables pane.
          var caretStyle = {
            font: 'inherit', padding: '0', margin: '0 3px 0 0', width: 12, minWidth: 12,
            textAlign: 'center', background: 'transparent', border: 'none',
            color: 'inherit', opacity: 0.72, cursor: 'pointer', lineHeight: 1.4,
          }
          out.push(h('div', {
            key: 'var-' + key,
            style: Object.assign({}, S.debugRow, { paddingLeft: (2 + depth * 12) + 'px' }),
            'data-var-key': key,
          },
            expandable
              ? h('button', {
                type: 'button', style: caretStyle, title: open ? '收起' : '展开（读取字段/元素）',
                'data-var-expand': key,
                onClick: function () { void toggleVariable(key, raw) },
              }, loading ? '…' : (open ? '▾' : '▸'))
              : h('span', { style: Object.assign({}, caretStyle, { cursor: 'default' }) }, ''),
            h('span', { style: S.debugMono }, name + ' = ' + display + (hint !== '' && display.indexOf('@') !== -1 ? '  (' + hint + ')' : ''))))
          if (open && Array.isArray(varTree.children[key])) out = out.concat(variableRows(varTree.children[key], key, depth + 1))
        })
        return out
      }
      /** "No source in the workspace" banner (JDK / dependency frames). */
      function missingSourceRow() {
        var missing = dbg.missingSource
        if (missing === null || missing === undefined) return null
        return h('div', { style: Object.assign({}, S.debugRow, { gap: 6, padding: '2px 0' }), 'data-missing-source': '1' },
          h('span', { style: S.meta }, '无源码 · ' + missing.className + ':' + missing.line),
          h('button', {
            type: 'button', style: S.buttonOff, title: '清除缓存并重新在工作区搜索该类的源码',
            'data-missing-retry': '1',
            onClick: function () {
              var cleaned = String(missing.className || '').replace(/\$.*$/, '').trim()
              delete sourcePathRef.current[cleaned]
              setDbg(function (prev) { return Object.assign({}, prev, { missingSource: null }) })
              void followDebugLocation({ className: missing.className, lineNumber: missing.line })
            },
          }, '重试'))
      }
      /** The name a breakpoint row shows: the Java class name (paths are noise here). */
      function breakpointLabel(bp) {
        return bp === null || bp === undefined || bp.className === undefined ? '?' : String(bp.className)
      }
      /** The tooltip of a breakpoint row: the same class name, plus the line. */
      function breakpointTitle(bp) {
        var base = bp === null || bp === undefined || bp.className === undefined ? '?' : String(bp.className)
        return base + ':' + (bp === null || bp === undefined || bp.line === undefined ? '?' : bp.line)
      }
      var rows = []
      if (ui.section === 'breakpoints') {
        rows = dbg.breakpoints.map(function (bp) {
          // Every row — installed, waiting for its class, or failed — carries its
          // own remove button on the LEFT, so a pre-set breakpoint (no debug
          // session yet) can be deleted just like a live one.
          // Icon-only, like the title-bar controls: one fixed 20px square.
          var removeStyle = Object.assign({}, S.buttonOff, {
            width: 20, minWidth: 20, height: 20, padding: '0 0', lineHeight: 1, textAlign: 'center',
          })
          var removeButton = h('button', {
            type: 'button', style: removeStyle, title: '删除断点', 'data-bp-remove': '1',
            onClick: function () { void removeBreakpoint(bp.pending === true ? 'pending' : bp.requestId, bp) },
          }, '×')
          if (bp.pending === true) {
            return h('div', { key: 'bp-pending-' + bp.className + ':' + bp.line, style: S.debugRow, 'data-bp-pending': '1' },
              removeButton,
              h('span', { style: S.debugMono, title: breakpointTitle(bp) }, breakpointLabel(bp) + ':' + (bp.line === undefined ? '?' : bp.line) + '  待应用（等待类加载…）'))
          }
          if (bp.failed === true) {
            return h('div', { key: 'bp-failed-' + bp.className + ':' + bp.line, style: S.debugRow, 'data-bp-failed': '1', title: bp.error === undefined ? '未生效' : String(bp.error) },
              h('button', {
                type: 'button', style: removeStyle, title: '删除断点', 'data-bp-remove': '1',
                onClick: function () {
                  // A failed breakpoint never reached the VM: forget it locally.
                  setDbg(function (prev) {
                    return Object.assign({}, prev, { breakpoints: (prev.breakpoints || []).filter(function (item) { return !(item.className === bp.className && item.line === bp.line) }) })
                  })
                },
              }, '×'),
              h('span', { style: S.debugMono, title: breakpointTitle(bp) }, '○ ' + breakpointLabel(bp) + ':' + (bp.line === undefined ? '?' : bp.line) + '  未生效'))
          }
          return h('div', { key: 'bp-' + bp.requestId, style: S.debugRow },
            removeButton,
            h('span', { style: S.debugMono, title: breakpointTitle(bp) }, breakpointLabel(bp) + ':' + (bp.line === undefined ? '?' : bp.line) + '  #' + bp.requestId))
        })
      } else if (ui.section === 'threads') {
        rows = dbg.threads.map(function (thread) {
          var id = thread.threadId !== undefined ? thread.threadId : thread.id
          var selected = String(ui.threadId) === String(id)
          return h('div', { key: 'th-' + id, style: S.debugRow },
            h('button', {
              type: 'button', style: selected ? S.debugTabOn : S.debugTab,
              onClick: function () { void loadStack(id) },
            }, (thread.name || 'thread') + '  #' + id))
        })
      } else if (ui.section === 'stack') {
        rows = dbg.frames.map(function (frame, index) {
          var selected = ui.frameIndex === index
          var className = String(frame !== null && frame.className !== undefined ? frame.className : '')
          var method = frame.methodName === undefined || frame.methodName === null ? '?' : String(frame.methodName)
          var line = frame.lineNumber === undefined ? '?' : frame.lineNumber
          // The debug pane names Java locations by CLASS, not by file path.
          var title = (className === '' ? '' : className + '.') + method + ':' + line
          return h('div', { key: 'frame-' + index, style: S.debugRow },
            h('button', {
              type: 'button', style: selected ? S.debugTabOn : S.debugTab, title: title,
              onClick: function () {
                if (ui.threadId !== undefined) void loadVariables(ui.threadId, index)
                void followDebugLocation(frame)
              },
            }, method + '@' + line))
        })
      } else if (ui.section === 'variables') {
        rows = variableRows(dbg.variables || [], 'frame:' + (ui.frameIndex === undefined ? 0 : ui.frameIndex), 0)
      } else {
        rows = dbg.events.map(function (event) {
          return h('div', { key: 'ev-' + event.seq, style: S.debugRow },
            h('span', { style: S.debugMono }, '#' + event.seq + ' ' + event.type + ' ' + JSON.stringify(event.payload || {}).slice(0, 160)))
        })
      }

      // The debug CONTROLS live in the pane's title bar now (see paneHead) — the
      // body is the section TAB STRIP plus the active tab's content.
      var pane = h('div', { style: S.debugPane },
        h('div', { ref: attachDebugTabs, style: S.debugTabsBar, role: 'tablist', 'data-debug-tabs': '1' }, DEBUG_SECTIONS.map(tabButton)),
        h('div', { style: S.debugContent, role: 'tabpanel', 'data-debug-section': ui.section },
          missingSourceRow(),
          rows.length === 0
            ? h('span', { style: S.meta }, ui.section === 'breakpoints'
              ? '还没有断点（在左侧源码行号上双击添加，单击删除）'
              : '（这里还没有数据）')
            : rows))

      /**
       * Read-only preview of a text file above the whole-read limit.
       *
       * Pages are fetched on demand (`loadLargeTextPage`) as the box scrolls near
       * its bottom, and only the visible lines are rendered (fixed 18px rows), so
       * the DOM and the memory stay bounded by one page plus the viewport.
       * Editing is impossible by construction: no editor is mounted and nothing
       * writes this file back.
       */
      function LargeTextPreview(props) {
        var doc = props.doc
        var boxRef = React.useRef(null)
        var [scrollTop, setScrollTop] = React.useState(0)
        var [viewportHeight, setViewportHeight] = React.useState(600)
        var lineHeight = 18
        var lines = React.useMemo(function () { return String(doc.text || '').split('\n') }, [doc.text])
        var dropLines = typeof doc.dropLines === 'number' ? doc.dropLines : 0
        var total = dropLines + lines.length
        var prevDropRef = React.useRef(dropLines)
        var first = Math.max(0, Math.floor(scrollTop / lineHeight) - 4)
        var count = Math.max(0, Math.ceil(viewportHeight / lineHeight) + 8)
        var visible = lines.slice(first, first + count)
        function onScroll(event) {
          var box = event.currentTarget
          setScrollTop(box.scrollTop)
          setViewportHeight(box.clientHeight)
          if (box.scrollTop + box.clientHeight > box.scrollHeight - 240) props.onLoadMore()
        }
        React.useEffect(function () {
          if (boxRef.current !== null) setViewportHeight(boxRef.current.clientHeight)
        }, [doc.size])
        // Freeing the front shrinks the scroll height: move the viewport by the
        // same amount so the line the reader is looking at stays put.
        React.useEffect(function () {
          var freed = dropLines - prevDropRef.current
          prevDropRef.current = dropLines
          if (freed > 0 && boxRef.current !== null) {
            boxRef.current.scrollTop = Math.max(0, boxRef.current.scrollTop - freed * lineHeight)
          }
        }, [dropLines])
        var loadedKb = Math.round(String(doc.text || '').length / 1024)
        var totalMb = typeof doc.size === 'number' && doc.size > 0 ? doc.size / (1024 * 1024) : 0
        var loadedNote = '已加载 ' + loadedKb + ' KB / ' + totalMb.toFixed(1) + ' MB'
        return h('div', { style: S.largeText, 'data-large-text': '1' },
          h('div', { style: S.largeTextBar, 'data-large-text-bar': '1' },
            h('span', { style: { fontWeight: 600 } }, '只读预览 · 大文件'),
            h('span', { style: S.spacer }),
            h('span', { style: S.meta, 'data-large-text-loaded': String(loadedKb) }, loadedNote),
            doc.eof === true
              ? h('span', { style: S.meta }, '（已全部加载）')
              : h('span', { style: S.meta }, '（滚动到底继续加载）'),
            dropLines > 0
              ? h('span', { style: S.meta, 'data-large-text-freed': String(dropLines) }, '已释放前面 ' + dropLines + ' 行')
              : null,
            dropLines > 0
              ? h('button', {
                type: 'button', style: S.buttonOff, 'data-large-text-restart': '1', title: '从文件开头重新加载（会丢弃当前已释放的部分）',
                onClick: function () { props.onRestart() },
              }, '从头加载')
              : null,
            doc.loading === true ? h('span', { style: S.meta }, '加载中…') : null),
          doc.error !== undefined
            ? h('div', { style: S.error, role: 'alert', 'data-large-text-error': '1' }, '读取失败：' + String(doc.error))
            : null,
          h('div', { ref: boxRef, style: S.largeTextBox, onScroll: onScroll, tabIndex: 0, 'data-large-text-body': '1' },
            h('div', { style: { position: 'relative', height: Math.max(1, total) * lineHeight } },
              h('div', { style: { position: 'absolute', top: first * lineHeight, left: 0, right: 0 } },
                visible.map(function (line, index) {
                  return h('div', { key: first + index, style: S.largeTextLine, 'data-large-text-line': String(first + index + 1) }, line === '' ? '\u00a0' : line)
                })))))
      }

      /** The source pane: paged/closable file tabs + the editor or a preview. */
      /**
       * One mounted file pane. ALL open files stay mounted (inactive ones are
       * `display:none`): the sidebar's viewer keeps the draft and the dirty flag
       * inside itself, so unmounting a tab would silently drop unsaved edits —
       * the sidebar's own editor host parks tabs the same way.
       */
      function filePane(path) {
        var active = path === openFile
        var doc = docs[path]
        var brk = (dbg.breakpoints || []).filter(function (bp) { return bp.className === classNameFromPath(path) })
        var body
        if (doc === undefined) {
          body = h('div', { style: S.idePlaceholder }, '读取中…')
        } else if (doc.kind === 'image' || doc.kind === 'pdf' || doc.kind === 'binary') {
          body = h(IdeMediaView, { scope: scopeRef.current, path: path, kind: doc.kind, fontRatio: fontRatio })
        } else if (doc.kind === 'large-text') {
          body = h(LargeTextPreview, {
            doc: doc,
            onLoadMore: function () { void loadLargeTextPage(path) },
            onRestart: function () { reloadLargeTextFromStart(path) },
          })
        } else if (doc.kind === 'error') {
          body = workbenchDismissals.isOpen('file-error', path + ':' + String(doc.error)) ? h('div', { style: Object.assign({}, S.error, { display: 'flex', alignItems: 'center', gap: 6 }), role: 'alert', 'data-file-error': '1' },
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, '读取失败：' + String(doc.error || '未知错误')),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-notice-close': 'file-error', title: '关闭这条提示',
              onClick: function () { workbenchDismissals.dismiss('file-error', path + ':' + String(doc.error)) },
            }, '×'),
            h('button', {
              type: 'button', style: S.button, title: '重新读取',
              onClick: function () {
                setDocs(function (prev) { var next = Object.assign({}, prev); delete next[path]; return next })
                setReloadTick(function (value) { return value + 1 })
              },
            }, '重试'))
            : h('div', { style: S.idePlaceholder }, '读取失败（提示已关闭，重新打开文件可重试）')
        } else {
          body = h(IdeTextEditor, {
            scope: scopeRef.current,
            path: path,
            fontRatio: fontRatio,
            title: shortName(path),
            text: doc.text,
            savedText: doc.saved,
            onEditorMenu: setEditorMenu,
            visible: active,
            version: reloadTick,
            breakpoints: brk, // {line} objects; the gutter only needs the numbers
            debugLine: debugFocus !== null && debugFocus.path === path ? debugFocus.line : undefined,
            debugNonce: debugFocus === null ? 0 : debugFocus.nonce,
            onToggleBreakpoint: toggleBreakpoint,
            onChange: function (text) {
              setDocs(function (prev) {
                var next = Object.assign({}, prev)
                var current = next[path]
                if (current !== undefined && current.kind === 'text') next[path] = Object.assign({}, current, { text: text })
                return next
              })
            },
            onSave: function () { void savePath(path) },
            onReload: function () { setReloadTick(function (value) { return value + 1 }) },
            onToolbarState: function (state) {
              setViewerStates(function (prev) {
                var current = prev[path]
                if (current !== undefined && current.dirty === state.dirty && current.saveState === state.saveState
                  && current.mode === state.mode && current.editable === state.editable) return prev
                var next = Object.assign({}, prev)
                next[path] = state
                return next
              })
            },
            onToolbarControls: function (controls) {
              var store = viewerControlsRef.current
              if (controls === null || controls === undefined) delete store[path]
              else store[path] = controls
            },
          })
        }
        return h('div', { key: path, style: active && previewOpen[path] !== true ? S.filePane : S.filePaneHidden, 'data-file-mounted': path, 'data-file-active': active ? '1' : '0' }, body)
      }

      /**
       * The inline preview overlay: Markdown renders through `renderMarkdown`
       * (escaped, tags owned by us), HTML renders in a fully sandboxed iframe
       * (arbitrary markup never touches the IDE document). Always shows the
       * CURRENT buffer, so unsaved edits preview live — no disk round-trip.
       * @returns {object|null} the pane element, or null when closed.
       */
      function previewPaneNode() {
        if (openFile === '' || supportsTextPreview(openFile) !== true) return null
        if (previewOpen[openFile] !== true) return null
        var doc = docs[openFile]
        var content
        if (doc === undefined) {
          content = h('div', { style: S.idePlaceholder }, '读取中…')
        } else if (doc.kind !== 'text') {
          content = h('div', { style: S.idePlaceholder }, '该文件不是文本，无法预览')
        } else if (/\.html?$/i.test(openFile)) {
          content = h('iframe', {
            style: S.previewFrame, sandbox: '', srcDoc: doc.text,
            title: 'HTML 预览：' + shortName(openFile), 'data-preview-frame': '1',
          })
        } else {
          content = h('div', {
            style: S.previewBody,
            dangerouslySetInnerHTML: { __html: previewHtml },
            'data-preview-markdown': '1',
          })
        }
        return h('div', { style: S.previewPane, 'data-ide-preview': openFile },
          isDirty(openFile)
            ? h('div', { style: Object.assign({}, S.meta, { padding: '2px 8px 0', opacity: 0.65 }) }, '预览含未保存修改')
            : null,
          content)
      }

      /**
       * Right-aligned 预览/编辑 switch above the file's editor area. Only
       * Markdown/HTML files get it; the workbench toolbar stays generic.
       * @returns {object|null} the bar, or null for non-previewable files.
       */
      function previewToggleBar() {
        if (openFile === '' || supportsTextPreview(openFile) !== true) return null
        var previewing = previewOpen[openFile] === true
        return h('div', { style: S.previewToggleBar, 'data-preview-toggle': previewing ? 'open' : 'closed' },
          h('button', {
            type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 8px' }),
            'data-action': previewing ? 'preview-exit' : 'preview-enter',
            title: previewing
              ? '返回编辑 ' + shortName(openFile)
              : '预览 ' + shortName(openFile) + '（Markdown/HTML 在编辑器区域内渲染，显示当前内容）',
            onClick: function () { togglePreview() },
          }, previewing ? '编辑' : '预览'))
      }

      /** The source pane: paged/closable file tabs above every mounted file. */
      function editorBody() {
        var breakpoints = dbg.breakpoints || []
        var bar = h('div', { ref: attachSourceTabsBar, style: S.editorTabsBar, 'data-editor-tabs-bar': '1' },
          h('button', { type: 'button', style: S.tabPage, 'data-tab-page': 'prev', title: '上一页页签', onClick: function () { pageTabs(-1) } }, '◀'),
          h('div', { ref: stripRef, style: S.editorTabStrip, 'data-tab-strip': '1' },
            openFiles.length === 0
              ? h('span', { style: S.meta }, '没有打开的文件')
              : openFiles.map(function (path) {
                var active = path === openFile
                return h('span', {
                  key: path, style: active ? S.editorTabOn : S.editorTab,
                  ref: function (element) {
                    if (element === null || element === undefined) { delete tabElsRef.current[path]; return }
                    tabElsRef.current[path] = element
                  },
                  'data-tab-file': path,
                  title: path + (isDirty(path) ? '（未保存）' : '') + '（右键：关闭其他/全部）',
                  onClick: function () { setOpenFile(path) },
                  onContextMenu: function (event) { openTabMenu('source', event) },
                },
                  shortName(path) + (isDirty(path) ? '*' : ''),
                  h('span', {
                    style: S.tabClose, title: '关闭', 'data-tab-close': 'source',
                    onClick: function (event) { event.stopPropagation(); requestClose(path) },
                  }, '×'))
              })),
          h('button', { type: 'button', style: S.tabPage, 'data-tab-page': 'next', title: '下一页页签', onClick: function () { pageTabs(1) } }, '▶'),
          h('button', {
            type: 'button', style: S.tabPage, 'data-action': 'tabs-menu', title: '已打开的文件与最近历史（最多 30 条）',
            onMouseDown: function (event) { event.stopPropagation() },
            onClick: function () { setTabsMenuOpen(function (open) { return open !== true }) },
          }, '▾'))
        var prompt = pendingClose !== undefined
          ? h('div', { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: 6 }), 'data-close-prompt': '1' },
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, '「' + shortName(pendingClose) + '」有未保存的修改：'),
            h('button', {
              type: 'button', style: S.button, 'data-action': 'save-close', title: '保存后关闭',
              onClick: function () {
                var target = pendingClose
                var controls = viewerControlsRef.current[target]
                setPendingClose(undefined)
                if (controls !== undefined && typeof controls.save === 'function') {
                  // The save finishes inside the viewer; close when it reports 'saved'.
                  setPendingSaveClose(target)
                  controls.save()
                  return
                }
                void savePath(target).then(function (ok) { if (ok) closePath(target) })
              },
            }, '保存并关闭'),
            h('button', {
              type: 'button', style: S.buttonOff, 'data-action': 'discard-close', title: '丢弃修改并关闭',
              onClick: function () {
                var target = pendingClose
                setPendingClose(undefined)
                forgetDoc(target)
                closePath(target)
              },
            }, '不保存'),
            h('button', {
              type: 'button', style: S.buttonOff, 'data-action': 'cancel-close', title: '保持打开',
              onClick: function () { setPendingClose(undefined) },
            }, '取消'),
            // The ✕ sits on the FAR RIGHT of every advisory strip, this one included.
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-notice-close': 'close-prompt', title: '关闭提示（保持打开）',
              onClick: function () { setPendingClose(undefined) },
            }, '×'))
          : null
        var bulkPrompt = pendingBulk !== undefined
          ? h('div', { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: 6 }), 'data-bulk-prompt': '1' },
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
              pendingBulk.dirty.length + ' 个页签有未保存的修改（'
              + pendingBulk.dirty.slice(0, 2).map(shortName).join('、')
              + (pendingBulk.dirty.length > 2 ? ' 等' : '') + '）：'),
            h('button', {
              type: 'button', style: S.button, 'data-action': 'bulk-save-close', title: '全部保存后关闭',
              onClick: function () {
                var pending = pendingBulk
                void saveBulk(pending.dirty).then(function (ok) {
                  if (!ok) return
                  closePaths(pending.victims)
                })
              },
            }, '保存并关闭'),
            h('button', {
              type: 'button', style: S.buttonOff, 'data-action': 'bulk-discard-close', title: '丢弃全部修改并关闭',
              onClick: function () {
                var pending = pendingBulk
                closePaths(pending.victims)
              },
            }, '不保存'),
            h('button', {
              type: 'button', style: S.buttonOff, 'data-action': 'bulk-cancel-close', title: '全部保持打开',
              onClick: function () { setPendingBulk(undefined) },
            }, '取消'),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-notice-close': 'bulk-prompt', title: '关闭提示（全部保持打开）',
              onClick: function () { setPendingBulk(undefined) },
            }, '×'))
          : null
        var body = openFiles.length === 0
          ? h('div', { style: S.idePlaceholder, 'data-no-file': '1' }, '在左侧选择一个文件：打开即可编辑，Ctrl/Cmd+S 保存')
          : openFiles.map(filePane)
        var menuRows = tabsMenuOpen ? tabMenuEntries(openFiles, recentFiles, TAB_MENU_LIMIT) : []
        var recentHeaderShown = false
        var tabsMenu = tabsMenuOpen
          ? h('div', {
            style: Object.assign({}, S.tabMenu, {
              position: 'absolute', right: 4, top: 24, minWidth: 230, maxHeight: 320,
              overflowY: 'auto', zIndex: 945,
            }),
            'data-tabs-menu': '1',
            onMouseDown: function (event) { event.stopPropagation() },
          },
            menuRows.length === 0 ? h('span', { style: Object.assign({}, S.meta, { display: 'block', padding: '4px 10px' }) }, '还没有打开过文件')
              : menuRows.map(function (row, index) {
                var header = null
                if (row.open !== true && recentHeaderShown !== true) {
                  recentHeaderShown = true
                  header = h('div', {
                    key: 'recent-header',
                    style: Object.assign({}, S.meta, { display: 'block', padding: '4px 10px 2px', borderTop: '1px solid color-mix(in srgb, currentColor 14%, transparent)' }),
                  }, '最近历史')
                }
                var dirty = isDirty(row.path)
                var item = h('button', {
                  key: 'tab-row:' + row.path,
                  type: 'button',
                  style: Object.assign({}, S.tabMenuItem, { display: 'flex', gap: 6, alignItems: 'center', width: '100%' }),
                  'data-tab-row': row.path,
                  'data-tab-row-open': row.open === true ? '1' : '0',
                  title: row.path + (dirty ? '（未保存）' : ''),
                  onClick: function () {
                    setTabsMenuOpen(false)
                    if (row.open === true) setOpenFile(row.path)
                    else void openRecentPath(row.path)
                  },
                },
                  h('span', { style: { opacity: 0.7, flex: '0 0 auto' } }, row.open === true ? '●' : '·'),
                  h('span', {
                    style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, shortName(row.path) + (dirty ? '*' : '')),
                  row.open === true ? null : h('span', { style: { opacity: 0.5, fontSize: 10, flex: '0 0 auto' } }, '历史'))
                return header === null ? item : [header, item]
              }))
          : null
        var previewing = openFile !== '' && previewOpen[openFile] === true && supportsTextPreview(openFile) === true
        return h('div', { style: Object.assign({}, S.editorPane, { position: 'relative' }), 'data-editor-pane': '1' },
          bar,
          tabsMenu,
          prompt,
          bulkPrompt,
          previewToggleBar(),
          h('div', { style: S.filePanes }, body, previewing ? previewPaneNode() : null))
      }

      /** The console: every discoverable program with start/stop/debug/log. */
      function consoleBody() {
        return h('div', { style: S.ideBody },
          programs.map(function (program) {
            var alive = program.running !== null && program.running !== undefined && program.running.alive === true
            var startable = program.kind !== 'instance'
            var selected = program.logPath === activePath
            var busy = consoleBusy === program.id
            return h('div', {
              key: program.id,
              style: Object.assign({}, selected ? S.consoleRowOn : S.debugRow, { position: 'relative', overflow: 'hidden' }),
              'data-console-on': selected ? '1' : undefined,
              title: selected ? program.name + '（当前项目）' : undefined,
            },
              h('span', { style: alive ? S.instDotOn : S.instDotOff, title: alive ? '运行中' : '未运行' }, '●'),
              h('span', {
                style: Object.assign({}, S.debugMono, { cursor: 'pointer' }),
                title: '切换到 ' + program.name + '（日志 + 调试一次只显示这个项目）',
                'data-console-pick': program.logPath,
                onClick: function () { selectProgram(program) },
              }, program.name),
              h('span', { style: S.spacer }),
              alive && formatMemory(program.running.rssBytes) !== ''
                ? h('span', { style: S.meta, title: '常驻内存（VmRSS）' }, formatMemory(program.running.rssBytes))
                : null,
              startable && !alive ? button('▶', function () { void consoleStart(program) }, { icon: true, width: 25, start: true, action: 'console-start', title: '启动 ' + program.name }) : null,
              alive ? button('■', function () { void consoleStop(program) }, { icon: true, width: 25, stop: true, action: 'console-stop', title: '停止 ' + program.name }) : null,
              program.kind === 'spring' ? button(ideBadgeIcon('bug', 'play', 13), function () { void consoleDebug(program) }, { icon: true, width: 25, debug: true, off: ui.busy, action: 'console-debug', title: '调试 ' + program.name }) : null,
              busy
                ? h('div', {
                  key: 'loading',
                  className: 'dsh-ris-ide-loading',
                  'data-program-loading': program.id,
                  title: '正在' + (alive ? '停止' : '启动') + ' ' + program.name + '…',
                  onClick: function (event) { event.stopPropagation(); event.preventDefault() },
                  onMouseDown: function (event) { event.stopPropagation(); event.preventDefault() },
                },
                  h('span', { className: 'dsh-ris-ide-spinner' }),
                  h('span', null, alive ? '停止中…' : '启动中…'))
                : null)
          }),
          h('div', { style: S.idePlaceholder },
            '共 ' + programs.length + ' 个项目',
            (function () {
              var running = programs.filter(function (program) {
                return program.running !== null && program.running !== undefined && program.running.alive === true
              })
              if (running.length === 0) return ''
              var total = running.reduce(function (sum, program) { return sum + (Number(program.running.rssBytes) || 0) }, 0)
              return ' · 运行中 ' + running.length + (total > 0 ? ' · 约 ' + formatMemory(total) : '')
            })()))
      }

      // The editor pane's header IS the toolbar now (no workbench-level top bar):
      // the search box grows, the fixed action group holds the layout/font/theme
      // controls, and the pane's own maximiser stays at the far right.
      // Both dropdowns share ONE highlighted index (`searchActive`): the recent-file
      // list while the box is empty, the result list once a query is typed. Either
      // way the arrow keys move the ROW and never the caret, so typing can go on.
      var searchHistoryRows = searchFocused === true && treeQuery.trim() === ''
        ? searchHistoryEntries(recentFiles, openFiles, SEARCH_RECENT_LIMIT)
        : []
      // Landing on the box highlights the first recent file, ready for Enter — the
      // same "default row" the result list gets from its own reset effect.
      useEffect(function () {
        if (searchHistoryRows.length === 0) return
        setSearchActive(0)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by list shape
      }, [searchFocused, treeQuery, searchHistoryRows.length])
      var paneSearch = h('span', { style: S.searchWrap, 'data-search-box': '1' },
        h('input', {
          ref: searchInputRef,
          style: Object.assign({}, S.headSearch, S.searchInputFull), type: 'search', value: treeQuery,
          placeholder: '在工作空间中检索文件…',
          title: '全工作空间文件名检索（结果在搜索框下方，点击直接打开/定位）',
          'data-action': 'tree-search',
          onChange: function (event) { setTreeQuery(event.target.value) },
          onFocus: function () { setSearchFocused(true) },
          onBlur: function () { setSearchFocused(false) },
          onKeyDown: function (event) {
            if (event.key === 'Escape') { event.preventDefault(); setTreeQuery(''); setSearchFocused(false); return }
            // Whichever dropdown is open is the walkable list: the recent-file list
            // while the box is empty, the results once a query is typed.
            var matches = searchHits !== null && searchHits !== undefined && Array.isArray(searchHits.matches) ? searchHits.matches : []
            var inHistory = searchHistoryRows.length > 0
            var count = inHistory ? searchHistoryRows.length : matches.length
            if (count === 0) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              // The arrow moves the highlighted ROW, not the caret: the box keeps
              // focus and the cursor position, so typing can go on right after a look.
              event.preventDefault()
              var step = event.key === 'ArrowDown' ? 1 : -1
              setSearchActive(function (current) {
                var from = current >= 0 && current < count ? current : 0
                return (from + step + count) % count
              })
              return
            }
            if (event.key !== 'Enter') return
            event.preventDefault()
            var index = searchActive >= 0 && searchActive < count ? searchActive : 0
            if (inHistory) {
              var row = searchHistoryRows[index]
              if (row === undefined) return
              setTreeQuery('')
              setSearchFocused(false)
              void openRecentPath(row.path)
              return
            }
            var chosen = matches[index]
            pickSearchHit(chosen, searchHits.dirs !== undefined && searchHits.dirs !== null && searchHits.dirs[chosen] === true)
          },
        }),
        searchFocused === true && treeQuery.trim() === ''
          ? (function () {
            if (searchHistoryRows.length === 0) return null
            return h('div', {
              style: S.searchDropdown, 'data-search-history': '1',
              // Keep the input focused so the blur does not eat the click.
              onMouseDown: function (event) { event.preventDefault() },
            },
              h('div', { style: S.searchHeader }, '最近打开 · ' + searchHistoryRows.length + ' 个（↑↓ 选择，Enter 打开）'),
              searchHistoryRows.map(function (row, index) {
                var on = index === searchActive
                return h('div', {
                  key: 'history:' + row.path,
                  style: on ? Object.assign({}, S.searchRow, S.searchRowOn) : S.searchRow,
                  title: row.path,
                  'data-search-history-row': row.path,
                  'data-search-history-active': on ? '1' : '0',
                  onMouseEnter: function () { setSearchActive(index) },
                  onClick: function () {
                    setTreeQuery('')
                    setSearchFocused(false)
                    void openRecentPath(row.path)
                  },
                },
                  h('span', { style: { opacity: 0.55, flex: '0 0 auto' } }, row.open === true ? '●' : '·'),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, displayWorkspacePath(row.path, cwd)))
              }))
          })()
          : h(SearchResults, {
            hits: searchHits, busy: searchBusy, onPick: pickSearchHit,
            active: searchActive, onHover: setSearchActive,
            fontRatio: fontRatio, cwd: cwd,
          }))
      // Panel-wide net: while the IDE is on screen the host's shortcut adapter and
      // the browser's own context menu never see events that belong to this panel.
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        if (visible === false) return undefined
        function inPanel(target) {
          var root = workbenchRef.current
          if (root === null || target === null || target === undefined) return false
          return typeof root.contains === 'function' && root.contains(target)
        }
        function onKey(event) {
          if (!inPanel(event.target)) return
          // A DSH page keeps every browser shortcut: the net only exists inside
          // the standalone IDE window.
          if (!inStandaloneIdeWindow()) return
          if (isBrowserReloadChord(event)) {
            // Never let the GUI reload from inside the IDE (Ctrl+R / Ctrl+Shift+R),
            // not even while the editor has focus.
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            var input = searchInputRef.current
            if (input !== null) {
              input.focus()
              input.select()
            }
            return
          }
        }
        function onMenu(event) {
          if (!inPanel(event.target)) return
          event.preventDefault()
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('contextmenu', onMenu, true)
        return function () {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('contextmenu', onMenu, true)
        }
      }, [visible])

      // Ctrl/Cmd+F: the editor wins (its own find panel marks the event handled and
      // is an editable target), otherwise focus the workspace search box.
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        if (visible === false) return undefined
        function onKey(event) {
          // Page-wide Ctrl+R would steal the browser's reload from the DSH shell:
          // the find chord only belongs to the IDE when the event is ours.
          if (!ownsKeyTarget(event.target)) return
          if (!isGlobalFindChord(event)) return
          var input = searchInputRef.current
          if (input === null) return
          // A single-line selection in the editor IS the query the user means:
          // Ctrl+R searches for it instead of asking them to copy it by hand.
          var picked = selectedEditorText()
          if (picked !== '') {
            event.preventDefault()
            event.stopPropagation()
            setTreeQuery(picked)
            input.focus()
            input.select()
            return
          }
          var target = event.target
          if (!globalFindShouldFocusSearch({
            tagName: target === null || target === undefined ? '' : target.tagName,
            isContentEditable: target !== null && target !== undefined && target.isContentEditable === true,
            defaultPrevented: event.defaultPrevented === true,
          })) return
          event.preventDefault()
          event.stopPropagation()
          input.focus()
          input.select()
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [visible])

      /** Bottom-right help: every shortcut group plus a short how-to. */
      function renderHelpPanel() {
        return h('div', {
          style: Object.assign({}, S.messagePanel, { width: 'min(560px, 74vw)', maxHeight: '62vh' }),
          'data-help-panel': '1',
        },
          h('div', { style: S.messageHead },
            h('span', { style: { fontWeight: 600 } }, '快捷键与使用说明'),
            h('span', { style: S.spacer }),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-action': 'help-close',
              onClick: function () { setHelpOpen(false) },
            }, '×')),
          h('div', { style: S.messageList, 'data-help-list': '1' },
            helpSections().map(function (section) {
              return h('div', { key: section.title, style: { padding: '2px 0 6px' } },
                h('div', { style: { fontWeight: 600, marginBottom: 2 } }, section.title),
                section.rows.map(function (row, index) {
                  return h('div', { key: index, style: { display: 'flex', gap: 8, padding: '1px 0', alignItems: 'baseline' } },
                    h('code', { style: { flex: '0 0 132px', opacity: 0.85 } }, row.keys),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, row.desc))
                }))
            })))
      }

      var paneActions = [
        button('A-', function () { setUiFont(function (value) { return clampUiFont(value - 0.5) }) }, {
          key: 'font-minus', height: 20, width: 26, action: 'font-minus', title: '减小各面板字号（当前 ' + uiFont + 'px）',
        }),
        button('A+', function () { setUiFont(function (value) { return clampUiFont(value + 0.5) }) }, {
          key: 'font-plus', height: 20, width: 26, action: 'font-plus', title: '增大各面板字号（当前 ' + uiFont + 'px）',
        }),
      ]
      // Appearance control drives DSH's OWN theme (persisted by DSH): the IDE simply
      // follows the page, so there is no second colour preference to keep in sync.
      if (dshTheme !== undefined && typeof dshTheme.setTheme === 'function') {
        var nextPreference = themePreference === 'system' ? 'dark' : themePreference === 'dark' ? 'light' : 'system'
        paneActions.push(button(themePreference === 'dark' ? '🌙' : themePreference === 'light' ? '☀️' : '🌓', function () {
          try { dshTheme.setTheme(nextPreference) } catch (error) { /* host refused: leave it */ }
          setThemePreference(themePreferenceOf(dshTheme))
        }, {
          key: 'theme', height: 20, width: 26, action: 'theme', 'data-theme-state': themePreference || 'system',
          title: 'DSH 配色：' + (themePreference === 'dark' ? '深色' : themePreference === 'light' ? '浅色' : '跟随系统')
            + '（点击切换 跟随系统 → 深色 → 浅色；IDE 全部跟随 DSH）',
        }))
      }
      var paneConfig = props.onConfig !== null && typeof props.onConfig === 'object' ? props.onConfig : null
      if (paneConfig !== null && typeof paneConfig.open === 'function') {
        paneActions.push(button('📄', function () { paneConfig.open() }, { key: 'config-open', icon: true, height: 20, action: 'config-open', title: '打开配置文件 .dsh-ris-ide.json（启动参数由你维护）' }))
      }
      if (paneConfig !== null && typeof paneConfig.generate === 'function') {
        paneActions.push(button('⚙', function () { paneConfig.generate() }, { key: 'config-generate', icon: true, height: 20, action: 'config-generate', title: paneConfig.exists === true ? '更新配置：按当前扫描结果同步 .dsh-ris-ide.json（保留你改过的字段）' : '生成配置：把扫描到的程序写成 .dsh-ris-ide.json' }))
      }
      paneActions.push(button('⟲', resetLayout, { key: 'layout-reset', icon: true, height: 20, action: 'layout-reset', title: '还原布局尺寸：左列 300px、调试区 300px、两个下层 260px（不改变最大化状态）' }))

      /** Load the visual debug settings from the host (⚙ opens on a fresh read). */
      async function refreshDebugSettings() {
        setDebugSettings(function (prev) { return Object.assign({}, prev, { loading: true, error: '' }) })
        try {
          var payload = await fsSettings(scopeRef.current)
          var decompiler = payload.decompiler === null || payload.decompiler === undefined ? {} : payload.decompiler
          setDebugSettings({
            jar: typeof decompiler.jar === 'string' ? decompiler.jar : '',
            args: Array.isArray(decompiler.args) ? decompiler.args.join(' ') : '',
            loading: false,
            error: '',
            savedAt: 0,
          })
        } catch (error) {
          setDebugSettings(function (prev) { return Object.assign({}, prev, { loading: false, error: messageOf(error) }) })
        }
      }

      function openDebugSettings() {
        setDebugSettingsOpen(true)
        void refreshDebugSettings()
      }

      async function saveDebugSettings() {
        var jar = String(debugSettings.jar || '').trim()
        var argsText = String(debugSettings.args || '').trim()
        var args = argsText === '' ? [] : argsText.split(/\s+/).filter(function (item) { return item !== '' })
        setDebugSettings(function (prev) { return Object.assign({}, prev, { loading: true, error: '' }) })
        try {
          var payload = await fsSaveSettings(scopeRef.current, { decompilerJar: jar, decompilerArgs: args })
          var decompiler = payload.decompiler === null || payload.decompiler === undefined ? {} : payload.decompiler
          setDebugSettings({
            jar: typeof decompiler.jar === 'string' ? decompiler.jar : '',
            args: Array.isArray(decompiler.args) ? decompiler.args.join(' ') : '',
            loading: false,
            error: '',
            savedAt: Date.now(),
          })
          // A decompiler change must invalidate the remembered CLASS MISSES so the
          // next step into that class tries again.
          Object.keys(sourcePathRef.current).forEach(function (key) {
            if (sourcePathRef.current[key] === null) delete sourcePathRef.current[key]
          })
          note(jar === '' ? '已清除反编译 jar：依赖类将只显示 javap 反汇编' : '调试配置已保存：依赖类优先用 ' + jar + ' 反编译')
        } catch (error) {
          setDebugSettings(function (prev) { return Object.assign({}, prev, { loading: false, error: messageOf(error) }) })
        }
      }

      /** The ⚙ dialog: decompiler jar + optional argument template (host-side work). */
      function debugSettingsModal() {
        if (debugSettingsOpen !== true) return null
        var settingsRow = function (labelText, hint, node) {
          return h('div', { key: labelText, style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 } },
            h('span', { style: { fontSize: 11, opacity: 0.72 } }, labelText),
            node,
            hint === '' ? null : h('span', { style: { fontSize: 11, opacity: 0.5, lineHeight: 1.4 } }, hint))
        }
        var jarInput = h('input', {
          type: 'text',
          value: debugSettings.jar,
          placeholder: '如 /opt/cfr/cfr.jar',
          'data-debug-settings-jar': '1',
          style: Object.assign({}, S.input || {}, { fontSize: 12 }),
          onInput: function (event) { setDebugSettings(function (prev) { return Object.assign({}, prev, { jar: event.target.value }) }) },
        })
        var argsInput = h('input', {
          type: 'text',
          value: debugSettings.args,
          placeholder: '默认 {classfile}，空格分隔',
          'data-debug-settings-args': '1',
          style: Object.assign({}, S.input || {}, { fontSize: 12 }),
          onInput: function (event) { setDebugSettings(function (prev) { return Object.assign({}, prev, { args: event.target.value }) }) },
        })
        return h('div', {
          style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'color-mix(in srgb, #000 38%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
          'data-debug-settings': '1',
          onMouseDown: function () { setDebugSettingsOpen(false) },
        },
          h('div', {
            style: Object.assign({}, S.card || {}, {
              width: 520, maxWidth: '92vw', padding: 14, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2,
              background: 'var(--dsw-surface, #ffffff)', color: 'inherit', boxShadow: '0 18px 40px rgba(0,0,0,.35)', maxHeight: '86vh', overflowY: 'auto',
            }),
            onMouseDown: function (event) { event.stopPropagation() },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontWeight: 600 } }, '调试配置'),
              h('span', { style: S.spacer }),
              h('button', { type: 'button', style: S.buttonOff, 'data-debug-settings-close': '1', title: '关闭', onClick: function () { setDebugSettingsOpen(false) } }, '×')),
            h('div', { style: { fontSize: 11, opacity: 0.62, lineHeight: 1.5, marginTop: 4 } },
              '可选配置：不填也能看依赖类源码（jar 自带 -sources.jar 会直接用，否则 javap 反汇编）。'),
            settingsRow('反编译工具 jar（可选）', '如 CFR / Procyon 的 jar；填了就把字节码还原成 .java。', jarInput),
            settingsRow('参数（可选）', '默认 {classfile}。', argsInput),
            h('div', { style: { fontSize: 11, opacity: 0.5, lineHeight: 1.5, marginTop: 10 } },
              '缓存：.dsh-ris-ide-cache（已从文件树隐藏）'),
            debugSettings.error === '' ? null : h('div', { style: { fontSize: 11, color: '#d9534f', marginTop: 8 } }, debugSettings.error),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
              h('button', { type: 'button', style: S.buttonOn || S.buttonOff, 'data-debug-settings-save': '1', disabled: debugSettings.loading === true, onClick: function () { void saveDebugSettings() } }, debugSettings.loading === true ? '保存中…' : '保存'),
              debugSettings.savedAt === 0 ? null : h('span', { style: { fontSize: 11, opacity: 0.6 } }, '已保存'),
              h('span', { style: S.spacer }),
              h('button', { type: 'button', style: S.buttonOff, 'data-debug-settings-cancel': '1', onClick: function () { setDebugSettingsOpen(false) } }, '关闭'))))
      }

      return h('div', {
        ref: workbenchRef,
        style: Object.assign({}, S.workbench, { fontSize: uiFont + 'px' }),
        'data-workbench': 'ris-ide',
        'data-theme': themePreference || 'page',
        onContextMenu: function (event) { event.preventDefault() },
      },
        // The sidebar's CodeMirror theme pins 13px, so the embedded viewer needs
        // this rule, not inheritance, to follow A−/A+.
        h('style', { key: 'ide-font' }, viewerFontCss(uiFont) + viewerThemeCss(pageDark) + DEBUG_LINE_CSS + PREVIEW_CSS + SELECTION_CSS + SCROLLBAR_CSS + TOAST_CSS + PROGRAM_LOADING_CSS),
        (function () {
          var panes = {
            tree: h(IdeTree, {
              scope: scope, rootPath: cwd || '.', locateRequest: locateRequest, activePath: openFile,
              openFiles: openFiles,
              onOpen: openPath, onRename: renamePaths, fontRatio: fontRatio, refreshNonce: treeRefreshTick, onNote: note, visible: visible,
              onTreeMeta: function (meta) { setTreeGit(meta.git === true) },
            }),
            console: consoleBody(),
            editor: editorBody(),
            debug: h('div', { style: S.debugSlot, 'data-debug-slot': '1' }, pane),
            log: h('div', { style: S.logPane },
              activeProgram === undefined
                ? h('div', { style: S.idePlaceholder, 'data-log-empty': '1' }, '在控制台点击一个项目：日志和调试都只显示该项目')
                : activeProgram.hasLog === false
                  ? h('div', { style: S.idePlaceholder, 'data-log-empty': '1' }, '「' + activeProgram.name + '」还没有日志文件（启动后会生成）')
                  : h('div', { style: S.logSlot, 'data-log-slot': '1' }, h(LogTail, {
                    key: activePath,
                    scope: scope,
                    path: activePath,
                    scale: fontRatio,
                    fontRatio: fontRatio,
                    // The pane TITLE BAR owns these controls now (the body is only
                    // log text); the viewer renders whatever the title bar decides.
                    following: logFollowing,
                    wrap: logWrap,
                    fontSize: logFontSize,
                    onFollowingChange: setLogFollowing,
                    // Paused while the log pane is hidden (another pane maximised, or
                    // the whole IDE tab parked): a hidden viewer must not poll `/tail`.
                    visible: ui.maximized === null || ui.maximized === 'log',
                    // Bumped after debug start/stop/resume: a fresh run (or an
                    // un-frozen JVM) must be re-read even when no frame arrived.
                    reloadNonce: logNonce,
                  }))),
          }
          // Fall back to the log file's base name while `programs` is still loading
          // (an agent-opened tab carries a logPath before the scan arrives).
          var activeName = activeProgram !== undefined ? activeProgram.name : (activePath === '' ? '' : programNameOf(activePath))
          var titles = {
            tree: '工作空间', console: '▤ 控制台', editor: '源码',
            debug: '调试' + (activeName === '' ? '' : ' · ' + activeName),
            log: '▤ 日志' + (activeName === '' ? '' : ' · ' + activeName),
          }
          /** Maximise this pane alone (double-click a header does the same). */
          var toggleMax = function (id) {
            setUi(function (prev) { return Object.assign({}, prev, { maximized: prev.maximized === id ? null : id }) })
          }
          /** One pane header, with the controls that belong to that pane. */
          var paneHead = function (id, maxed) {
            var maximize = h('button', {
              type: 'button', style: S.buttonOff, title: maxed ? '还原' : '最大化',
              onClick: function () { toggleMax(id) },
            }, maxed ? '⤡' : '⤢')
            var onDouble = {
              onDoubleClick: function (event) {
                // Controls in the title bar keep their own click behaviour: a
                // double click on the debug toolbar / search box must not also
                // maximise the pane.
                if (!headerDoubleClickIsTitle(event === undefined || event === null ? undefined : event.target)) return
                toggleMax(id)
              },
            }
            if (id === 'debug') {
              // The debug pane's TITLE BAR is the debug toolbar: start, stop,
              // pause/resume, the three step kinds and the poll refresh. No
              // collapse control any more — the pane is always open.
              return h('div', Object.assign({ style: S.ideHead, 'data-debug-head': '1' }, onDouble),
                debuggable ? button(ui.busy ? '…' : ideBadgeIcon('bug', 'play', 14), startDebug, { icon: true, debug: true, height: 20, disabled: ui.busy || dbg.attached, off: dbg.attached, action: 'debug-start', title: dbg.attached ? '已连接调试' : '以调试模式重启并连接' }) : null,
                debuggable ? button(ideBadgeIcon('bug', 'rotate', 14), function () { void restartDebug() }, {
                  icon: true, height: 20, action: 'debug-restart',
                  disabled: ui.busy, off: ui.busy,
                  title: dbg.attached ? '重新调试：断开后以调试模式重启' : '重新调试：以调试模式重启并连接',
                }) : null,
                // The whole debug toolbar is ALWAYS rendered (stable layout): a
                // control that cannot act right now is disabled with a reason in
                // its tooltip, instead of vanishing and leaving the user hunting
                // for it. Stepping only works while a thread is suspended, pausing
                // only while it runs.
                debuggable ? button(ideIcon('bugOff', 14), stopDebug, {
                  icon: true, height: 20, action: 'debug-stop',
                  disabled: !dbg.attached, off: !dbg.attached,
                  title: dbg.attached ? '断开调试（服务继续运行）' : '断开调试（当前未连接）',
                }) : null,
                debuggable ? button(ideIcon('pauseCircle', 14), function () { void control('pause') }, {
                  icon: true, height: 20, action: 'debug-pause',
                  disabled: !dbg.attached || dbg.suspended === true, off: !dbg.attached || dbg.suspended === true,
                  title: !dbg.attached ? '暂停（未连接调试）' : dbg.suspended ? '暂停（已经停住）' : '暂停（挂起 VM）',
                }) : null,
                debuggable ? button(ideIcon('playCircle', 14), function () { void control('resume') }, {
                  icon: true, height: 20, action: 'debug-resume',
                  disabled: !dbg.attached || dbg.suspended !== true, off: !dbg.attached || dbg.suspended !== true,
                  title: !dbg.attached ? '继续执行（F8，未连接调试）' : dbg.suspended ? '继续执行（F8）' : '继续执行（F8，当前未停住）',
                }) : null,
                debuggable ? button(ideIcon('stepOver', 14), function () { void control('step', 'over') }, {
                  icon: true, height: 20, action: 'step-over',
                  disabled: !dbg.attached || dbg.suspended !== true, off: !dbg.attached || dbg.suspended !== true,
                  title: '单步（跳过，F6）' + (!dbg.attached ? '：未连接调试' : dbg.suspended ? '' : '：命中/暂停后才可用'),
                }) : null,
                debuggable ? button(ideIcon('stepInto', 14), function () { void control('step', 'into') }, {
                  icon: true, height: 20, action: 'step-into',
                  disabled: !dbg.attached || dbg.suspended !== true, off: !dbg.attached || dbg.suspended !== true,
                  title: '步入（F5）' + (!dbg.attached ? '：未连接调试' : dbg.suspended ? '' : '：命中/暂停后才可用'),
                }) : null,
                debuggable ? button(ideIcon('stepOut', 14), function () { void control('step', 'out') }, {
                  icon: true, height: 20, action: 'step-out',
                  disabled: !dbg.attached || dbg.suspended !== true, off: !dbg.attached || dbg.suspended !== true,
                  title: '步出（F7）' + (!dbg.attached ? '：未连接调试' : dbg.suspended ? '' : '：命中/暂停后才可用'),
                }) : null,
                button(ideIcon('arrowsRotate', 14), function () { void pollOnce() }, { icon: true, height: 20, action: 'debug-refresh', title: '刷新调试状态' }),
                // Always present (stable header), disabled while there is nothing to
                // clear. `⌫` replaces the old in-body "全部清除" text button.
                button('⌫', function () { void clearBreakpoints() }, {
                  icon: true, height: 20, action: 'breakpoints-clear',
                  disabled: (dbg.breakpoints || []).length === 0,
                  off: true,
                  title: (dbg.breakpoints || []).length === 0 ? '清除全部断点（当前没有断点）' : '清除全部断点（含未生效的）',
                }),
                // Debug settings live behind ⚙: dependency sources are resolved
                // host-side, so this dialog only chooses the decompiler jar.
                button('⚙', openDebugSettings, { key: 'debug-settings', icon: true, height: 20, action: 'debug-settings', title: '调试配置：依赖 jar 源码 / 反编译 jar' }),
                h('span', { style: S.spacer }),
                maximize)
            }
            if (id === 'editor') {
              // The source pane's header doubles as the IDE's toolbar.
              return h('div', Object.assign({ style: S.editorPaneHead, 'data-editor-head': '1' }, onDouble),
                paneSearch,
                h('span', { style: S.headActions, 'data-head-actions': '1' }, paneActions),
                maximize)
            }
            if (id === 'tree') {
              // The workspace title IS the path (ellipsised when the column is narrow).
              return h('div', Object.assign({ style: S.ideHead }, onDouble),
                h('span', { style: S.headPath, title: cwd || '工作空间', 'data-workbench-path': '1' }, cwd || '工作空间'),
                h('button', {
                  type: 'button', style: S.buttonOff, 'data-action': 'reveal-active', title: '定位到当前编辑的文件',
                  onClick: function () {
                    locateNonceRef.current += 1
                    setLocateRequest({ kind: 'file', path: openFile, nonce: locateNonceRef.current })
                  },
                }, '⌖'),
                h('button', {
                  type: 'button', style: S.buttonOff, 'data-action': 'tree-refresh', title: '刷新文件树（重新读取已展开的目录）',
                  onClick: function () { setTreeRefreshTick(function (value) { return value + 1 }) },
                }, '⟳'),
                h('button', {
                  type: 'button',
                  style: Object.assign({}, S.buttonOff, treeGit === true ? {} : { opacity: 0.38, cursor: 'default' }),
                  'data-action': 'tree-filter',
                  'data-filter-state': treeShowAll === true ? 'all' : 'git',
                  disabled: treeGit !== true,
                  title: treeGit !== true
                    ? '当前工作区没有可用的 git：文件树本就显示所有文件'
                    : (treeShowAll === true
                      ? '显示所有文件：开（含 .gitignore 忽略的；点击恢复过滤）'
                      : '.gitignore 过滤：开（点击显示所有文件）'),
                  onClick: toggleTreeFilter,
                }, ideIcon(treeShowAll === true ? 'eyeOff' : 'eye', 14)),
                maximize)
            }
            if (id === 'log') {
              // The viewer's chrome used to be an in-body bar; it lives HERE now,
              // so the log body is nothing but log text. Every control is an icon
              // button, matching the debug toolbar's fixed 20px row.
              var logService = activeProgram !== undefined && activeProgram.running !== null && activeProgram.running !== undefined
                ? activeProgram.running
                : undefined
              var logAlive = logService !== undefined && logService.alive === true
              var logControls = activeProgram !== undefined && activeProgram.hasLog !== false
              var logStatus = logService !== undefined
                ? h('span', {
                  style: logAlive ? S.service : S.serviceStopped,
                  'data-log-service': logAlive ? 'running' : 'stopped',
                  title: '读 pidfile：' + serviceText(logService),
                }, serviceText(logService))
                : activeProgram !== undefined
                  ? h('span', { style: S.serviceStopped, 'data-log-service': 'none', title: '日志文件旁没有 pidfile：服务未运行' }, '未运行')
                  : null
              return h('div', Object.assign({ style: S.ideHeadWrap, 'data-log-head': '1' }, onDouble),
                h('span', { style: { whiteSpace: 'nowrap' }, title: activePath === '' ? undefined : activePath }, titles[id]),
                logStatus,
                h('span', { style: S.spacer }),
                logControls ? button(ideIcon('wrap', 13), toggleLogWrap, {
                  icon: true, height: 20, action: 'wrap', off: logWrap !== true,
                  title: logWrap ? '自动换行：开（点击关闭）' : '自动换行：关（点击打开）',
                }) : null,
                logControls ? button('A−', function () { bumpLogFont(-1) }, {
                  icon: true, height: 20, action: 'font-down', title: '缩小日志字号（当前 ' + logFontSize + 'px）',
                }) : null,
                logControls ? button('A+', function () { bumpLogFont(1) }, {
                  icon: true, height: 20, action: 'font-up', title: '放大日志字号（当前 ' + logFontSize + 'px）',
                }) : null,
                logControls ? button(ideIcon('follow', 13), function () { setLogFollowing(function (value) { return !value }) }, {
                  icon: true, height: 20, action: 'follow', off: logFollowing !== true,
                  title: logFollowing ? '跟随中：点击暂停跟随' : '已暂停：点击继续跟随（自动滚到最新）',
                }) : null,
                maximize)
            }
            return h('div', Object.assign({ style: S.ideHead }, onDouble),
              h('span', null, titles[id]),
              h('span', { style: S.spacer }),
              maximize)
          }
          var slot = function (id) {
            if (ui.maximized !== null && ui.maximized !== id) return null
            var maxed = ui.maximized === id
            return h('div', { key: id, style: maxed ? S.idePaneMax : S.idePane, 'data-ide-pane': id },
              paneHead(id, maxed),
              panes[id])
          }
          /**
           * One splitter drag. The pane size is measured against the SPLITTER'S
           * PARENT box (`currentTarget.parentElement`), so the same handler serves
           * the column split (parent = grid) and both row splits (parent = the
           * column whose bottom pane is being sized) without any extra refs.
           */
          function drag(kind) {
            var horizontal = kind === 'left' || kind === 'debugWidth'
            return function (event) {
              event.preventDefault()
              var host = event.currentTarget && event.currentTarget.parentElement
              var rect = host && typeof host.getBoundingClientRect === 'function'
                ? host.getBoundingClientRect()
                : { left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800 }
              function move(moveEvent) {
                setSizes(function (prev) {
                  var next = Object.assign({}, prev)
                  if (horizontal) {
                    // `left` / `debugWidth` are WIDTHS (anchor: the parent box's
                    // left edge — the grid for the left column, the bottom row for
                    // the debug pane).
                    var width = moveEvent.clientX - rect.left
                    if (kind === 'left') next.left = Math.min(Math.max(180, width), Math.max(200, rect.width - 240))
                    else next.debugWidth = Math.min(Math.max(180, width), Math.max(200, rect.width - 220))
                  } else {
                    // `leftBottom` / `rightBottom` are BOTTOM-ROW HEIGHTS (anchor:
                    // the parent column's bottom edge).
                    var height = rect.bottom - moveEvent.clientY
                    next[kind] = Math.min(Math.max(120, height), Math.max(150, rect.height - 120))
                  }
                  return next
                })
              }
              function stop() {
                if (typeof document !== 'undefined') {
                  document.body.style.cursor = ''
                  document.body.style.userSelect = ''
                }
                if (typeof window === 'undefined') return
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', stop)
              }
              if (typeof document !== 'undefined') {
                document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
                document.body.style.userSelect = 'none'
              }
              if (typeof window !== 'undefined') {
                window.addEventListener('mousemove', move)
                window.addEventListener('mouseup', stop)
              }
            }
          }
          /** A 4px hairline: invisible until hovered, then a faint colour. */
          var splitter = function (kind) {
            return h('div', {
              key: 'split-' + kind,
              'data-splitter': kind,
              title: kind === 'left' ? '拖动调整左列宽度' : (kind === 'debugWidth' ? '拖动调整调试区宽度' : '拖动调整下层高度'),
              style: {
                flex: '0 0 4px',
                cursor: kind === 'left' || kind === 'debugWidth' ? 'col-resize' : 'row-resize',
                background: hoverSplit === kind ? 'color-mix(in srgb, currentColor 24%, transparent)' : 'transparent',
                transition: 'background 120ms',
              },
              onMouseEnter: function () { setHoverSplit(kind) },
              onMouseLeave: function () { setHoverSplit(null) },
              onMouseDown: drag(kind),
            })
          }
          var grid = h('div', { ref: ideGridRef, style: S.ideGrid, 'data-ide-grid': 'grid' },
            // LEFT column: workspace tree above the console. `sizes.left` is the
            // column WIDTH; `sizes.leftBottom` is the console height.
            h('div', { style: Object.assign({}, S.ideCol, { width: sizes.left, flex: '0 0 auto' }), 'data-ide-col': 'left' },
              h('div', { style: Object.assign({}, S.ideCol, { flex: '1 1 0', minHeight: 40 }) }, slot('tree')),
              splitter('leftBottom'),
              h('div', { style: Object.assign({}, S.ideCol, { height: sizes.leftBottom, flex: '0 0 auto' }) }, slot('console'))),
            splitter('left'),
            // RIGHT column: source above (debug | log). `sizes.rightBottom` is the
            // height of the debug/log row.
            h('div', { style: Object.assign({}, S.ideCol, { flex: '1 1 0' }), 'data-ide-col': 'right' },
              h('div', { style: Object.assign({}, S.ideCol, { flex: '1 1 0', minHeight: 60 }) }, slot('editor')),
              splitter('rightBottom'),
              h('div', { style: Object.assign({}, S.ideCol, { height: sizes.rightBottom, flex: '0 0 auto', flexDirection: 'row' }), 'data-debug-row': '1' },
                h('div', { style: { width: sizes.debugWidth, flex: '0 0 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } }, slot('debug')),
                splitter('debugWidth'),
                h('div', { style: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' } }, slot('log')))))
          if (ui.maximized !== null) {
            return h('div', { ref: ideGridRef, style: S.ideGrid }, slot(ui.maximized))
          }
          return grid
        })(),
        h('div', { style: S.ideHead, 'data-ide-status': 'status' },
          h('span', null, debuggable ? (dbg.attached ? ('调试 :' + (dbg.port === null ? '?' : dbg.port)) : '未调试') : '非 Java'),
          h('span', null, ' · 断点 ' + (dbg.breakpoints ? dbg.breakpoints.length : 0)),
          h('span', null, ' · 项目 ' + programs.length),
          h('span', null, ' · 文件 ' + openFiles.length + '/' + FILE_LIMIT + (openFiles.filter(isDirty).length > 0 ? '（' + openFiles.filter(isDirty).length + ' 未保存）' : '')),
          h('span', { style: S.spacer }),
          // Transient progress/status: the static key hints moved into the ? help panel.
          h('span', {
            style: Object.assign({}, S.status, { maxWidth: '58%', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.8 }),
            'data-ide-status-text': statusText === '' ? '0' : '1',
            title: statusText,
          }, statusText),
          // Bottom-RIGHT corner: help, then the session message log.
          h('button', {
            type: 'button', style: S.messageButton, 'data-action': 'help',
            title: '快捷键与使用说明',
            onClick: function () { setHelpOpen(function (open) { return !open }) },
          }, '?'),
          // Bottom-RIGHT corner: the session message log button (with unread badge).
          h('button', {
            type: 'button', style: S.messageButton, 'data-action': 'messages', 'data-unread': String(unreadMessages),
            title: messages.length === 0 ? '本会话还没有消息' : '本会话消息（' + messages.length + ' 条）',
            onClick: function () {
              setMessagePanelOpen(function (open) { return !open })
              setUnreadMessages(0)
            },
          }, '💬' + (unreadMessages > 0 ? ' ' + unreadMessages : ''))),
        // Session message log: every hint the IDE produced this session, newest
        // first, opened from the 💬 button on the LEFT of the status bar.
        editorMenu === null ? null : h('div', {
          style: Object.assign({}, S.tabMenu, { left: editorMenu.x, top: editorMenu.y, position: 'fixed', zIndex: 950, minWidth: 200 }),
          'data-editor-menu': '1',
          onMouseDown: function (event) { event.stopPropagation() },
        }, (editorMenu.items || []).map(function (item, index) {
          if (item.separator === true) {
            return h('div', { key: 'sep' + index, style: { height: 1, margin: '3px 0', background: 'color-mix(in srgb, currentColor 18%, transparent)' } })
          }
          return h('button', {
            key: 'item' + index, type: 'button',
            style: item.disabled === true
              ? Object.assign({}, S.tabMenuItem, { opacity: 0.4, cursor: 'default' })
              : S.tabMenuItem,
            disabled: item.disabled === true,
            'data-editor-action': item.label,
            onClick: function () {
              setEditorMenu(null)
              if (item.disabled === true || typeof item.run !== 'function') return
              try { item.run() } catch (error) { note(String(error && error.message ? error.message : error)) }
            },
          },
            h('span', { style: { flex: '1 1 auto', textAlign: 'left' } }, item.label),
            item.shortcut === undefined ? null : h('span', { style: { opacity: 0.55, marginLeft: 14, fontSize: 11 } }, item.shortcut))
        })),
        helpOpen ? renderHelpPanel() : null,
        messagePanelOpen
          ? h('div', { style: S.messagePanel, 'data-message-panel': '1' },
            h('div', { style: S.messageHead },
              h('span', { style: { fontWeight: 600 } }, '本会话消息（' + messages.length + '）'),
              h('span', { style: S.spacer }),
              h('button', {
                type: 'button', style: S.buttonOff, 'data-action': 'messages-clear',
                onClick: function () { setMessages([]); setUnreadMessages(0) },
              }, '清空'),
              h('button', {
                type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-action': 'messages-close',
                onClick: function () { setMessagePanelOpen(false) },
              }, '×')),
            h('div', { style: S.messageList, 'data-message-list': '1' },
              messages.length === 0
                ? h('span', { style: S.meta }, '本会话还没有消息')
                : messages.slice().reverse().map(function (message) {
                  return h('div', { key: 'msg-' + message.id, style: S.messageRow, 'data-message': String(message.id) },
                    h('span', { style: S.messageTime }, formatClock(message.at)),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, message.text),
                    h('button', {
                      type: 'button', style: Object.assign({}, S.buttonOff, { flex: '0 0 auto', padding: '0 4px', lineHeight: 1 }),
                      'data-message-remove': String(message.id), title: '删除这条消息',
                      onClick: function () { setMessages(function (prev) { return dropMessage(prev, message.id) }) },
                    }, '×'))
                })))
          : null,
        // Floating hints: bottom-centre, stacked vertically, newest at the bottom.
        // The layer ignores pointer events; each hint re-enables them so the ✕ works.
        toasts.length === 0 ? null : h('div', { style: S.toastLayer, 'data-toast-layer': '1' },
          toasts.map(function (toast) {
            return h('div', { key: toast.id, style: S.toast, 'data-toast': String(toast.id), role: 'status' },
              h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, toast.text),
              h('button', {
                type: 'button', style: Object.assign({}, S.buttonOff, { flex: '0 0 auto', padding: '0 4px' }),
                'data-toast-close': String(toast.id), title: '关闭提示',
                onClick: function () { dismissToast(toast.id) },
              }, '×'))
          })),
        typeof props.configNote === 'string' && props.configNote !== ''
          && workbenchDismissals.isOpen('config-note', props.configNote)
          ? h(ClosableNotice, {
            styles: S, kind: 'config-note', signature: props.configNote, onDismiss: workbenchDismissals.dismiss,
          }, props.configNote)
          : null,
        // Right-click menu of a tab strip. Sources keep their dirty tabs when
        // bulk-closing (bulkClose); log/debug tabs have no drafts to lose.
        tabMenu === null ? null : h('div', {
          style: Object.assign({}, S.tabMenu, { left: tabMenu.x, top: tabMenu.y }),
          'data-tab-menu': tabMenu.kind,
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('button', { type: 'button', style: S.tabMenuItem, 'data-action': 'ctx-close-others', onClick: function () { closeOtherTabsOf(); closeTabMenu() } }, '关闭其他'),
          h('button', { type: 'button', style: S.tabMenuItem, 'data-action': 'ctx-close-all', onClick: function () { closeAllTabsOf(); closeTabMenu() } }, '全部关闭')),
        debugSettingsModal())
    }

    /**
     * Client plugin body: register the IDE tab (type + body + chip title) with
     * the official DSH right-Sidebar registry, and start the page-side open queue.
     * @param {object} ctx - client context carrying `sidebarRight*`/`slots`.
     */
    function apply(ctx) {
      guardWindowErrors(false)
      if (typeof window !== 'undefined') window.__dshRisIdeWindow = false
      // The IDE is a DSH right-Sidebar tab: a tab TYPE (stage one) plus its body
      // and chip title (stage two), all through the official registry — no other
      // plugin is involved.
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: IDE_TAB_ID,
          kind: IDE_TAB_KIND,
          multiple: false,
          keepMounted: true,
          // The sidebar entry is the COMPACT console (rows + one live log); the
          // full IDE lives in the standalone window, so the tab is named for what
          // it actually is instead of promising an IDE it no longer carries.
          title: function () { return 'RIS控制台' },
          guide: [{
            id: 'dsh-ris-ide',
            order: 50,
            title: function () { return 'RIS控制台' },
            description: function () { return '本机可运行项目（Spring Boot / 前端）的启动、停止与实时日志；完整 IDE 在独立窗口里' },
          }],
        })
      }, 'dsh-ris-ide: right-sidebar tab type')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: IDE_TAB_ID,
            inject: function (sessionId) {
              // The panel only needs the session: every host route resolves the
              // cwd from the session itself, so nothing else has to be threaded.
              // `compact` is the sidebar shape (console + one log); the standalone
              // window passes nothing and gets the full IDE.
              return { sessionId: sessionId || '', visible: true, compact: true }
            },
          }, function IdePanelBoundary(props) { return h(IdeErrorBoundary, null, h(ProgramsPanel, props)) })
        })
      }, 'dsh-ris-ide: right-sidebar tab body')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: IDE_TAB_ID,
          }, function IdeTabTitle() { return h('span', null, 'RIS控制台') })
        })
      }, 'dsh-ris-ide: right-sidebar tab title')
      // A SECOND entry point for the same panel: a header button in the Session
      // header, immediately to the right of DSH's own "open in app" action
      // (order -10), so it reads as "open this workspace's IDE". It opens the
      // plugin's standalone window instead of the sidebar tab — no DSH shell, no
      // session, no conversation: a window that can stay open all day.
      ctx.effect(function () {
        return ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'ris-ide-window',
            order: -8,
            label: function () { return '在独立窗口中打开RIS-IDE' },
          }, RisIdeWindowAction)
        })
      }, 'dsh-ris-ide: session-header window button')
      // Model-driven log opens (`ris_dev_logs`) need a page-side poller, and it
      // must run even on a host whose sidebar has no `registerTab`. A document is
      // the browser's own signal that there is a page to talk to (SSR/test
      // environments have none, and must not spawn background requests).
      panelCtx = ctx
      if (typeof document !== 'undefined') {
        ctx.effect(function () {
          var disposed = false
          var timer = null
          // The open queue rides the shared stream hub: a page-side poller runs even
          // on a host whose /stream is missing (old host, buffering proxy).
          function startPolling() {
            if (timer !== null || disposed) return
            timer = setInterval(function () {
              if (document.visibilityState === 'hidden') return
              void drainOpenRequests()
            }, OPEN_POLL_MS)
          }
          var unsubscribe = null
          if (typeof EventSource === 'function') {
            unsubscribe = risStreamHub().subscribe({
              topics: ['opens'],
              handlers: {
                opens: function (payload) {
                  if (Array.isArray(payload.opens) && payload.opens.length > 0) applyOpenRequests(payload.opens)
                },
              },
            })
          } else {
            startPolling()
          }
          return function () {
            disposed = true
            if (timer !== null) clearInterval(timer)
            if (unsubscribe !== null) unsubscribe()
          }
        }, 'dsh-ris-ide: sidebar open stream')
      }

    }

    /**
     * Show the IDE tab in DSH's right Sidebar (the official service; nothing else
     * is involved). The panel itself then lists every program, so "open a log" is
     * "open the IDE" plus a pending selection.
     * @param {object|null} ctx - client context captured by `apply`.
     * @throws {Error} when the right-Sidebar service is unavailable.
     */
    function openIdeTab(ctx) {
      var right = ctx ? ctx.sidebarRight : undefined
      if (right === undefined || typeof right.openTab !== 'function') {
        throw new Error('右侧栏服务不可用')
      }
      right.openTab(IDE_TAB_KIND)
    }

    /** Named window handle: a second click focuses the window already open. */
    var WINDOW_NAME = 'dsh-ris-ide-window'
    /**
     * Stable per-workspace suffix for the IDE window name.
     *
     * Keying the window by the workspace keeps ONE IDE per workspace: clicking
     * ⧉ RIS-IDE again reuses (and focuses) the window of this workspace, while a
     * window for another workspace is left alone. `window.html` re-derives the
     * same string from its URL to claim the single-instance lock.
     * @param {string} [cwd] - workspace cwd.
     * @returns {string} base36 hash (empty cwd ⇒ hash of '').
     */
    function standaloneWindowKey(cwd) {
      var value = typeof cwd === 'string' ? String(cwd).replace(/[\\/]+$/, '') : ''
      var hash = 0
      for (var index = 0; index < value.length; index += 1) hash = ((hash * 31) + value.charCodeAt(index)) | 0
      return (hash >>> 0).toString(36)
    }
    /** Browser window name for the workspace's single IDE window. */
    function standaloneWindowName(cwd) {
      return WINDOW_NAME + '-' + standaloneWindowKey(cwd)
    }
    /**
     * Synthetic session id for a window opened without one. The host only needs a
     * cwd for every IDE route (`resolveCwd`), so a made-up id is harmless and the
     * window keeps working after the DSH session that opened it is gone.
     */
    var STANDALONE_SESSION = 'dsh-ris-ide-window'

    /**
     * Open (or focus) the standalone IDE window.
     *
     * The window is NOT a second DSH page: it is this plugin's own minimal page
     * (`/dsh-ris-ide/window`), which boots nothing but this browser half plus a
     * vendored React. That is the whole point — no session, no conversation, no
     * other plugin bundle — so a window left open all day stays small instead of
     * growing with the session history. Same origin and cookie, same host routes,
     * one SSE connection.
     * @param {{sessionId?: string, cwd?: string, programId?: string}} [options] - scope to hand over.
     * @returns {Window} the opened window handle.
     * @throws {Error} when the environment has no `window.open`, or the popup was blocked.
     */
    function openStandaloneWindow(options) {
      var opts = options === null || options === undefined ? {} : options
      if (typeof window === 'undefined' || typeof window.open !== 'function') {
        throw new Error('当前环境不支持打开独立窗口')
      }
      var url = routeUrl('dsh-ris-ide/window')
      if (typeof opts.sessionId === 'string' && opts.sessionId !== '') url.searchParams.set('sessionId', opts.sessionId)
      var cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : knownWorkspaceCwd()
      if (cwd !== undefined) url.searchParams.set('cwd', cwd)
      // The window NAME (and the single-instance lock derived from it) follows the
      // WORKSPACE, not the path the panel happens to be rooted at: opening the
      // debug window from inside a program directory must still reuse the one IDE
      // window instead of stacking a second one for that directory.
      var windowCwd = typeof opts.windowCwd === 'string' && opts.windowCwd !== '' ? opts.windowCwd : knownWorkspaceCwd()
      var windowName = standaloneWindowName(windowCwd !== undefined ? windowCwd : cwd)
      url.searchParams.set('wname', windowName)
      if (typeof opts.programId === 'string' && opts.programId !== '') url.searchParams.set('programId', opts.programId)
      // `debug: true` = open on that program AND start its JDWP session, which is
      // what the compact panel's 🐞 button promises (the window owns the debug UI).
      if (opts.debug === true) url.searchParams.set('debug', '1')
      // A browser cannot be told to "maximize" through window.open features, so ask
      // for the screen's work area at 0,0; window.html enforces it once more on load
      // in case the opener size is clamped (the OS still allows restore/resize).
      var screenInfo = typeof window !== 'undefined' && window.screen !== null && window.screen !== undefined ? window.screen : null
      var workWidth = screenInfo !== null && typeof screenInfo.availWidth === 'number' && screenInfo.availWidth > 0 ? screenInfo.availWidth : 1500
      var workHeight = screenInfo !== null && typeof screenInfo.availHeight === 'number' && screenInfo.availHeight > 0 ? screenInfo.availHeight : 960
      var features = 'popup=yes,width=' + workWidth + ',height=' + workHeight + ',left=0,top=0'
      var handle = window.open(url.href, windowName, features)
      if (handle === null || handle === undefined) {
        throw new Error('独立窗口被拦截：请允许本站弹窗后重试')
      }
      return handle
    }

    /**
     * Mount the IDE panel into a plain container, outside DSH's module system.
     *
     * Called by the standalone window page, which loads this file directly instead
     * of booting the DSH frontend. Nothing here needs the DSH client context: the
     * panel self-fetches from `/dsh-ris-ide/*` and the host falls back to the
     * absolute `cwd` when it cannot resolve the session.
     * @param {Element} container - element to render into.
     * @param {{sessionId?: string, cwd?: string, programId?: string}} [options] - scope from the URL.
     * @returns {Promise<object>} the react-dom root handle.
     */
    async function mountStandalone(container, options) {
      // We own this page: swallow async errors here (visible banner + console)
      // instead of letting the browser/dsh treat them as a fatal load failure.
      guardWindowErrors(true)
      if (typeof window !== 'undefined') window.__dshRisIdeWindow = true
      var opts = options === null || options === undefined ? {} : options
      var sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : STANDALONE_SESSION
      var cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : knownWorkspaceCwd()
      var scope = { sessionId: sessionId, cwd: cwd }
      if (typeof opts.programId === 'string' && opts.programId !== '') {
        var program = await fetchProgramById(scope, opts.programId)
        // `autoDebug` makes the workbench start the JDWP session on arrival, so
        // the compact panel's 🐞 button lands directly in a debugging window.
        if (program !== undefined) selectProgram(Object.assign({}, program, { autoDebug: opts.debug === true }))
      }
      var reactDom = require('react-dom/client')
      var createRoot = reactDom !== null && reactDom !== undefined ? reactDom.createRoot : undefined
      if (typeof createRoot !== 'function') throw new Error('react-dom/client 不可用')
      var root = createRoot(container)
      // The window always shows the FULL IDE (compact is the sidebar's shape).
      root.render(h(IdeErrorBoundary, null, h(ProgramsPanel, { sessionId: sessionId, cwd: cwd, visible: true, compact: false })))
      return root
    }

    /**
     * Resolve one program row by id (the window URL carries only the id).
     * A failed lookup is not fatal: the window then opens on the program list.
     * @param {{sessionId: string, cwd?: string}} scope - the window's scope.
     * @param {string} programId - `ProgramStatus.id` from the host.
     * @returns {Promise<object|undefined>} the row, or undefined when unknown.
     */
    async function fetchProgramById(scope, programId) {
      try {
        var url = routeUrl('dsh-ris-ide/programs')
        url.searchParams.set('sessionId', scope.sessionId)
        var routeCwd = scopeCwd(scope)
        if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
        var response = await fetch(url.href, { headers: { accept: 'application/json' } })
        var payload = await response.json().catch(function () { return null })
        if (payload === null || payload.ok !== true) return undefined
        rememberWorkspaceCwd(payload.root)
        var programs = Array.isArray(payload.programs) ? payload.programs : []
        for (var index = 0; index < programs.length; index += 1) {
          var row = programs[index]
          if (row !== null && row !== undefined && row.id === programId) return row
        }
        return undefined
      } catch {
        return undefined
      }
    }

    /**
     * Session-header action: open the IDE in its own window.
     *
     * Registered in `conversation.session.header.utilities` with order -8, i.e.
     * immediately to the RIGHT of DSH's own "open in app" action (-10) and left of
     * the schedule / log buttons. `sessionId` arrives as a standard slot prop.
     * @param {{sessionId?: string}} props - standard slot props.
     * @returns {object} the button element.
     */
    function RisIdeWindowAction(props) {
      var sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : ''
      var [blocked, setBlocked] = useState(false)
      useEffect(function () {
        if (blocked !== true) return undefined
        var timer = setTimeout(function () { setBlocked(false) }, 4000)
        return function () { clearTimeout(timer) }
      }, [blocked])
      if (blocked === true) {
        return h('span', { style: S.windowButtonError, role: 'status', title: '允许本站弹窗后重试' }, '窗口被拦截')
      }
      function onClick(event) {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        try {
          var handle = openStandaloneWindow({ sessionId: sessionId })
          if (handle !== null && typeof handle.focus === 'function') handle.focus()
        } catch (error) {
          console.warn('dsh-ris-ide: 独立窗口打开失败：' + messageOf(error))
          setBlocked(true)
        }
      }
      return h('button', {
        type: 'button',
        style: S.windowButton,
        title: '在独立窗口中打开RIS-IDE',
        'aria-label': '在独立窗口中打开RIS-IDE',
        'data-action': 'ris-ide-window',
        onClick: onClick,
      },
        h('span', { style: S.windowButtonIcon, 'aria-hidden': 'true' }, '⧉'),
        h('span', null, 'RIS-IDE'))
    }

    /**
     * Open one instance's log: point the IDE at that program and show its tab.
     * Module-scope on purpose: the panel component cannot reach `apply`'s `ctx`
     * parameter, so the context is threaded in explicitly.
     * @param {object|null} ctx - client context captured by `apply`.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} logPath - absolute path of the instance log.
     * @param {string} title - tab title.
     * @throws {Error} when the right-Sidebar service is unavailable.
     */
    function openInstanceLog(ctx, scope, logPath, title) {
      selectProgram({ name: title, logPath: logPath, kind: 'log' })
      openIdeTab(ctx)
    }

    /** GET-style debug actions (everything else is POSTed). */
    var DEBUG_READ_ACTIONS = ['status', 'poll', 'breakpoints', 'threads', 'stack', 'variables', 'expand']

    /**
     * One debug API call. Reads go through the query string, writes through JSON.
     * @param {string} action - status|poll|breakpoints|threads|stack|variables|start|stop|step|resume|pause.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {object} [params] - action arguments (`path`, `className`, `line`, `threadId`, …).
     * @returns {Promise<object>} the parsed payload, or `{ ok: false, code, error }`.
     */
    /**
     * Every live JDWP session (`GET /dsh-ris-ide/debugs`). The workbench shows ONE
     * program, so this is how a breakpoint in a DIFFERENT program is noticed.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @returns {Promise<{ok: boolean, sessions?: object[], error?: string}>} the reply.
     */
    async function requestDebugs(scope) {
      var url = routeUrl('dsh-ris-ide/debugs')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      var response = await fetch(url.href, { headers: { accept: 'application/json' } })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return { ok: false, error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status }
      }
      return parsed
    }

    async function requestDebug(action, scope, params) {
      var url = routeUrl('dsh-ris-ide/debug/' + action)
      var payload = Object.assign({}, params)
      var init = { headers: { accept: 'application/json' } }
      // `breakpoints` reads when listing, writes when adding/removing/clearing.
      var mutation = payload.add !== undefined || payload.remove !== undefined || payload.clear === true
      if (DEBUG_READ_ACTIONS.indexOf(action) !== -1 && !(action === 'breakpoints' && mutation)) {
        url.searchParams.set('sessionId', scope.sessionId)
        var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
        Object.keys(payload).forEach(function (key) {
          var value = payload[key]
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        })
      } else {
        payload.sessionId = scope.sessionId
        if (typeof scope.cwd === 'string' && scope.cwd !== '') payload.cwd = scope.cwd
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload)
      }
      var response = await fetch(url.href, init)
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return {
          ok: false,
          code: parsed && parsed.code ? parsed.code : 'http',
          error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status,
        }
      }
      return parsed
    }

    /**
     * One directory level through THIS plugin's host route: it honours every
     * .gitignore (root + each subproject + nested) and folds single-child
     * directory chains into one row (`cn.com.ris.cloud.model`). The sidebar's
     * `fs.tree` lists literally everything (node_modules included) and has no
     * notion of ignored files.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute directory (or '.' for the workspace root).
     * @returns {Promise<{path: string, entries: object[], truncated: boolean}>}
     */
    /** Directory listings are reused for this long (the watch keeps them fresh). */
    var TREE_LIST_TTL_MS = 1500
    /** `sessionId\0path` → `{at, listing}` (see {@link treeListingFresh}). */
    var TREE_LIST_CACHE = {}
    /**
     * The tree title bar's .gitignore toggle: false = filter (default when git is
     * available), true = show every file. Read by fsTree (query + cache key) and
     * flipped by the workbench; a module-level flag because the fetch helpers sit
     * outside React.
     */
    var TREE_FILTER_ALL = false

    /** Whether a cached listing is still fresh. */
    function treeListingFresh(at, now, ttl) {
      var age = Number(now) - Number(at)
      return Number.isFinite(age) && age >= 0 && age < (typeof ttl === 'number' ? ttl : TREE_LIST_TTL_MS)
    }

    async function fsTree(scope, path, force) {
      var key = (scope && typeof scope.sessionId === 'string' ? scope.sessionId : '') + '\u0000' + String(path) + (TREE_FILTER_ALL ? '\u0000all' : '')
      var cached = TREE_LIST_CACHE[key]
      if (force !== true && cached !== undefined && treeListingFresh(cached.at, Date.now(), TREE_LIST_TTL_MS)) {
        return cached.listing
      }
      var url = routeUrl('dsh-ris-ide/tree')
      url.searchParams.set('sessionId', scope.sessionId)
      var treeCwd = scopeCwd(scope)
      if (treeCwd !== undefined) url.searchParams.set('cwd', treeCwd)
      url.searchParams.set('path', path)
      // .gitignore toggle: 'all' lists ignored files too (the host still hides the
      // plugin's own trash/cache folders).
      if (TREE_FILTER_ALL) url.searchParams.set('filter', 'all')
      // A forced read follows a filesystem change (create/copy/rename): ask the
      // host to re-read its git-visible set too, or the new entry stays hidden.
      if (force === true) url.searchParams.set('fresh', '1')
      var response = await fetch(url.href, { headers: { accept: 'application/json' } })
      var parsed = await response.json().catch(function () { return null })
      if (response.ok && parsed !== null && parsed.ok === true) {
        var listing = {
          path: typeof parsed.path === 'string' ? parsed.path : path,
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          truncated: parsed.truncated === true,
          // `git` drives the toggle's enabled state; older hosts omit it (false).
          git: parsed.git === true,
          filtered: parsed.filtered !== false,
        }
        if (Object.keys(TREE_LIST_CACHE).length > 500) TREE_LIST_CACHE = {}
        TREE_LIST_CACHE[key] = { at: Date.now(), listing: listing }
        // Remember the WORKSPACE cwd of the request, not the listed directory:
        // storing `listing.path` made every expanded folder look like the new
        // workspace, so the workbench's `cwd` (scope-less panels fall back to this
        // remembered value) flipped to the folder, re-rooted the whole tree and
        // remounted the levels — the "flash" after expanding a folder.
        if (treeCwd !== undefined) rememberWorkspaceCwd(treeCwd)
        return listing
      }
      var failure = new Error((parsed && parsed.message) || ('HTTP ' + response.status))
      failure.status = response.status
      throw failure
    }
    /**
     * One text-file read through THIS plugin's host route (`GET /fs/read`).
     * Replaced the sidebar's `fs.read` so the IDE no longer needs that plugin.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @returns {Promise<{content:string, size:number, mtimeMs?:number}>} the text.
     */
    async function fsRead(scope, path) {
      var url = routeUrl('dsh-ris-ide/fs/read')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('path', path)
      // A hung read would leave the editor on "读取中…" forever (a dependency
      // source is generated on demand, and a slow javap/decompile can stall):
      // bound it, so a failure becomes the usual retry banner instead.
      var controller = new AbortController()
      var timer = setTimeout(function () { controller.abort() }, 15000)
      var response
      try {
        response = await fetch(url.href, { headers: { accept: 'application/json' }, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error((parsed && parsed.message) || ('HTTP ' + response.status))
      }
      var result = parsed
      // The host tags every read: `{kind:'text'|'binary'|'too-large'}`. The kind is
      // carried ON the error so the IDE can render the right empty state instead
      // of guessing from the message.
      if (result.kind === 'binary') {
        var binary = new Error('这是二进制文件，不支持预览')
        binary.kind = 'binary'
        throw binary
      }
      if (result.kind === 'too-large') {
        var oversized = new Error('文件过大，不支持预览')
        oversized.kind = 'too-large'
        oversized.size = result.size
        oversized.mtimeMs = result.mtimeMs
        throw oversized
      }
      if (typeof result.content === 'string') return result.content
      var unreadable = new Error('不可读文件')
      unreadable.kind = 'error'
      throw unreadable
    }

    /** Window size for the large-file preview (the host caps a single read at 1 MiB). */
    var LARGE_TEXT_WINDOW_BYTES = 256 * 1024
    /** Stop paging past this much loaded text: the preview stays bounded. */
    var LARGE_TEXT_MAX_BYTES = 16 * 1024 * 1024

    /**
     * One window of a large text file through THIS plugin's host route
     * (`GET /fs/window`). `next` is the byte offset of the following window;
     * `eof` says the file ended inside this one.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @param {number} offset - byte offset to start at.
     * @param {number} [length] - bytes to request.
     * @returns {Promise<{text:string, offset:number, next:number, eof:boolean, size:number}>} the window.
     */
    async function fsWindowRead(scope, path, offset, length) {
      var url = routeUrl('dsh-ris-ide/fs/window')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('path', path)
      url.searchParams.set('offset', String(Math.max(0, Math.floor(Number(offset) || 0))))
      url.searchParams.set('length', String(Math.max(1, Math.floor(Number(length) || LARGE_TEXT_WINDOW_BYTES))))
      var response = await fetch(url.href, { headers: { accept: 'application/json' }, cache: 'no-store' })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error((parsed && parsed.message) || ('HTTP ' + response.status))
      }
      if (parsed.kind === 'binary') {
        var binary = new Error('这是二进制文件，不支持预览')
        binary.kind = 'binary'
        throw binary
      }
      if (parsed.kind !== 'text-window' || typeof parsed.text !== 'string') {
        throw new Error('不可读文件')
      }
      return {
        text: parsed.text,
        offset: Number(parsed.offset) || 0,
        next: Number(parsed.next) || 0,
        eof: parsed.eof === true,
        size: Number(parsed.size) || 0,
      }
    }

    /**
     * Whether a remembered file is gone (host answers 404 for missing paths).
     * History entries outlive the files they point at: a rename or delete in the
     * tree must remove the stale row instead of opening an empty editor.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute path remembered in the history.
     * @returns {Promise<boolean>} true when the file no longer exists.
     */
    async function fileMissing(scope, path) {
      if (typeof path !== 'string' || path === '') return true
      var url = routeUrl('dsh-ris-ide/fs/read')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('path', path)
      try {
        var response = await fetch(url.href, { headers: { accept: 'application/json' }, cache: 'no-store' })
        return response.status === 404
      } catch (error) {
        // Network trouble is not proof that the file vanished: keep the row.
        return false
      }
    }

    /** Formats the official document preview renders far better than we can. */
    var OFFICIAL_PREVIEW_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv']
    /** Markdown/HTML stay editable in the plugin but can be previewed on demand. */
    var OFFICIAL_TEXT_PREVIEW_EXTS = ['md', 'markdown', 'html', 'htm']

    /**
     * Whether a file has a rendered preview worth offering next to the editor.
     * These are NOT auto-handed to the official tab (the editor is the default),
     * but the editor header exposes a 👁 button that opens the official tab.
     * @param {string} path - file path.
     * @returns {boolean} true for Markdown/HTML.
     */
    function supportsTextPreview(path) {
      var name = String(path === undefined || path === null ? '' : path)
      var dot = name.lastIndexOf('.')
      if (dot < 0) return false
      return OFFICIAL_TEXT_PREVIEW_EXTS.indexOf(name.slice(dot + 1).toLowerCase()) !== -1
    }

    /** Escape the five HTML-significant characters of one text node. */
    function escapePreviewHtml(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    /** Only harmless protocols survive; `javascript:` / non-image `data:` links are dropped. */
    function safePreviewHref(raw) {
      var href = String(raw === undefined || raw === null ? '' : raw).trim()
      var lower = href.toLowerCase()
      if (lower === '') return ''
      if (lower.indexOf('javascript:') === 0 || lower.indexOf('vbscript:') === 0) return ''
      if (lower.indexOf('data:') === 0 && lower.indexOf('data:image/') !== 0) return ''
      return href
    }

    /** Resolve an image source for the preview (relative path → workspace media route). */
    function previewImageUrl(raw, options) {
      var src = String(raw === undefined || raw === null ? '' : raw).trim()
      if (/^data:image\//i.test(src) || /^https?:\/\//i.test(src)) return src
      if (typeof options.mediaUrl === 'function') return String(options.mediaUrl(src) || '')
      return ''
    }

    /**
     * Resolve a Markdown-relative asset path (`![](img/x.png)`) to the IDE's
     * file-media URL. Shared scope on purpose: the tree's own `parentOf` only
     * exists inside the tree, and reaching for it from the workbench is how
     * this helper first broke with `ReferenceError: parentOf is not defined`.
     * @param {object} scope - `{ sessionId, cwd }` of the panel.
     * @param {string} mdPath - absolute path of the Markdown file.
     * @param {string} raw - the src exactly as written in the document.
     * @returns {string} media URL (or the original absolute URL).
     */
    function previewAssetUrl(scope, mdPath, raw) {
      var src = String(raw === undefined || raw === null ? '' : raw).trim()
      if (src === '') return ''
      if (/^(data:image\/|https?:\/\/)/i.test(src)) return src
      var base = parentDirOf(mdPath)
      var joined = src.charAt(0) === '/' ? src : base + '/' + src.replace(/^\.\//, '')
      var absolute = joined.charAt(0) === '/'
      var stack = []
      joined.split('/').forEach(function (part) {
        if (part === '' || part === '.') return
        if (part === '..') { if (stack.length > 1) stack.pop(); return }
        stack.push(part)
      })
      // Keep the leading slash: a relative path would resolve against the cwd twice.
      return fileMediaUrl(scope, (absolute ? '/' : '') + stack.join('/'), { cacheBust: false })
    }

    /**
     * Inline Markdown → HTML. EVERYTHING is HTML-escaped before this runs, so a
     * Markdown file can never inject markup into the IDE page; the only tags in
     * the output are the ones this function builds itself.
     * @param {string} text - escaped block text.
     * @param {object} options - `{ mediaUrl(src) }` for relative images.
     * @returns {string} safe HTML.
     */
    function renderMarkdownInline(text, options) {
      var stash = []
      function keep(html) { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000' }
      var out = String(text === undefined || text === null ? '' : text)
      // Inline code first: its content must not be re-parsed for emphasis/links.
      out = out.replace(/`([^`]+)`/g, function (_, code) { return keep('<code>' + code + '</code>') })
      // Images before links (an image is a link with a leading `!`).
      out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, alt, src) {
        var url = previewImageUrl(src, options)
        if (url === '') return keep(escapePreviewHtml(alt))
        return keep('<img src="' + escapePreviewHtml(url) + '" alt="' + escapePreviewHtml(alt) + '" loading="lazy">')
      })
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (_, label, href) {
        var safe = safePreviewHref(href)
        if (safe === '') return keep(label)
        return keep('<a href="' + escapePreviewHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>')
      })
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
      out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      out = out.replace(/(^|[^_])_([^_\s][^_]*)_(?!_)/g, '$1<em>$2</em>')
      out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
      return out.replace(/\u0000(\d+)\u0000/g, function (_, index) { return stash[Number(index)] })
    }

    /**
     * Dependency-free Markdown → HTML for the in-plugin preview pane.
     *
     * The IDE is deliberately lightweight: pulling a full parser/sanitizer just
     * to peek at a README would undo that. This covers what notes/READMEs use —
     * headings, paragraphs, lists, blockquotes, fenced code, tables, rules and
     * inline emphasis/links/images — and OWNS every tag it emits. Raw HTML in a
     * `.md` file is shown as text; `.html` files are previewed in a sandboxed
     * iframe instead, which is the only place arbitrary markup may run.
     * @param {string} source - Markdown text.
     * @param {object} [options] - `{ mediaUrl(src) }` resolving relative images.
     * @returns {string} safe HTML.
     */
    function renderMarkdown(source, options) {
      var opts = options === undefined || options === null ? {} : options
      var lines = String(source === undefined || source === null ? '' : source).replace(/\r\n?/g, '\n').split('\n')
      function inline(text) { return renderMarkdownInline(escapePreviewHtml(text), opts) }
      var html = []
      var index = 0
      while (index < lines.length) {
        var line = lines[index]
        if (/^\s*$/.test(line)) { index += 1; continue }
        var fence = /^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/.exec(line)
        if (fence !== null) {
          var marker = fence[1].slice(0, 3)
          var body = []
          index += 1
          while (index < lines.length && lines[index].trim().indexOf(marker) !== 0) { body.push(lines[index]); index += 1 }
          index += 1
          var lang = String(fence[2] || '')
          html.push('<pre' + (lang === '' ? '' : ' data-lang="' + escapePreviewHtml(lang) + '"') + '><code>' + escapePreviewHtml(body.join('\n')) + '</code></pre>')
          continue
        }
        var heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading !== null) {
          var level = heading[1].length
          html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
          index += 1
          continue
        }
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); index += 1; continue }
        if (line.indexOf('|') !== -1 && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(lines[index + 1].trim())) {
          function splitRow(row) {
            return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim() })
          }
          var head = splitRow(line)
          index += 2
          var rowsHtml = []
          while (index < lines.length && lines[index].indexOf('|') !== -1 && !/^\s*$/.test(lines[index])) {
            rowsHtml.push('<tr>' + splitRow(lines[index]).map(function (cell) { return '<td>' + inline(cell) + '</td>' }).join('') + '</tr>')
            index += 1
          }
          html.push('<table><thead><tr>' + head.map(function (cell) { return '<th>' + inline(cell) + '</th>' }).join('') + '</tr></thead><tbody>' + rowsHtml.join('') + '</tbody></table>')
          continue
        }
        if (/^\s*>/.test(line)) {
          var quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          html.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>')
          continue
        }
        var bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (bullet !== null || ordered !== null) {
          var tag = bullet !== null ? 'ul' : 'ol'
          var pattern = bullet !== null ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/
          var items = []
          var item = pattern.exec(lines[index])
          while (item !== null) {
            var itemText = item[1]
            var task = /^\[([ xX])\]\s+(.*)$/.exec(itemText)
            if (task !== null) itemText = (task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') + task[2]
            items.push('<li>' + inline(itemText) + '</li>')
            index += 1
            item = index < lines.length ? pattern.exec(lines[index]) : null
          }
          html.push('<' + tag + '>' + items.join('') + '</' + tag + '>')
          continue
        }
        var paragraph = []
        while (index < lines.length && !/^\s*$/.test(lines[index])
          && !/^\s*(#{1,6}\s|>|```|~~~|\||([-*+]|\d+[.)])\s)/.test(lines[index])
          && !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length === 0) { index += 1; continue }
        html.push('<p>' + inline(paragraph.join(' ')) + '</p>')
      }
      return html.join('\n')
    }

    /**
     * Absolute paths a clipboard/`text/uri-list` payload refers to.
     *
     * Copying a file in the OS file manager offers NO `File` objects to the
     * browser (privacy), only `file://` URLs or plain paths — this is the parser
     * that turns that text into importable sources. Comments (`# …`) from
     * `text/uri-list` and whitespace-only lines are skipped; duplicates collapse.
     * @param {string} text - clipboard text (`text/uri-list` or `text/plain`).
     * @returns {string[]} absolute paths, in order.
     */
    function parseClipboardPaths(text) {
      var seen = {}
      var out = []
      String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
        var line = raw.trim()
        if (line === '' || line.charAt(0) === '#') return
        var path = ''
        if (/^file:\/\//i.test(line)) {
          try { path = decodeURIComponent(new URL(line).pathname) } catch { path = line.replace(/^file:\/\//i, '') }
        } else if (line.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(line)) {
          path = line
        }
        if (path === '' || seen[path] === true) return
        seen[path] = true
        out.push(path)
      })
      return out
    }

    /** Whether a path should be opened by the official preview tab instead. */
    function shouldUseOfficialPreview(path) {
      var name = String(path === undefined || path === null ? '' : path)
      var dot = name.lastIndexOf('.')
      if (dot < 0) return false
      return OFFICIAL_PREVIEW_EXTS.indexOf(name.slice(dot + 1).toLowerCase()) !== -1
    }

    /**
     * Official `dsh-resource://` address for one file: the session form when the
     * file is under the session's workspace root, else the absolute form.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @returns {string} the resource address.
     */
    function officialPreviewAddress(scope, path) {
      var normalized = String(path === undefined || path === null ? '' : path).replace(/\\/g, '/')
      var root = scope !== null && scope !== undefined && typeof scope.cwd === 'string' ? scope.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      var sessionId = scope !== null && scope !== undefined && typeof scope.sessionId === 'string' ? scope.sessionId : ''
      var encode = function (value) { return value.split('/').filter(function (part) { return part !== '' }).map(encodeURIComponent).join('/') }
      if (sessionId !== '' && root !== '' && (normalized === root || normalized.indexOf(root + '/') === 0)) {
        var relative = normalized === root ? '' : normalized.slice(root.length + 1)
        if (relative !== '') return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encode(relative)
      }
      return 'dsh-resource://file/absolute/' + encode(normalized)
    }

    /**
     * Open one file in the official preview tab (markdown/HTML/PDF/Office/Excel).
     * @param {object|null} ctx - client context captured by `apply`.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @throws {Error} when the right-Sidebar service is unavailable.
     */
    function openOfficialPreview(ctx, scope, path) {
      var right = ctx !== null && ctx !== undefined ? ctx.sidebarRight : undefined
      if (right === undefined || typeof right.openResource !== 'function') throw new Error('右侧栏服务不可用')
      right.openResource(officialPreviewAddress(scope, path))
    }

    /**
     * One file-tree mutation (`/fs/mkdir|create|copy|move|remove`). The host
     * refuses collisions and the workspace root; the caller surfaces the message.
     * @param {string} action - route leaf.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {object} payload - action-specific fields (`path`, `from`, `toDir`, …).
     * @returns {Promise<object>} the host payload.
     */
    async function fsOp(action, scope, payload) {
      var url = routeUrl('dsh-ris-ide/fs/' + action)
      var response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({
          sessionId: scope.sessionId,
        }, typeof scope.cwd === 'string' && scope.cwd !== '' ? { cwd: scope.cwd } : {}, payload)),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        var failure = new Error(parsed !== null && parsed.message !== undefined ? parsed.message : 'HTTP ' + response.status)
        // The paste flow branches on `exists` to offer 改名/覆盖: keep the host's
        // machine code on the error instead of flattening it into a message.
        failure.code = parsed !== null && typeof parsed.code === 'string' ? parsed.code : ''
        throw failure
      }
      return parsed
    }
    function fsMkdir(scope, path) { return fsOp('mkdir', scope, { path: path }) }
    function fsCreateFile(scope, path, content) { return fsOp('create', scope, { path: path, content: content === undefined ? '' : content }) }
    function fsCopyEntry(scope, from, toDir, name, overwrite) {
      return fsOp('copy', scope, { from: from, toDir: toDir, name: name, overwrite: overwrite === true })
    }
    function fsMoveEntry(scope, from, toDir, name, overwrite) {
      return fsOp('move', scope, { from: from, toDir: toDir, name: name, overwrite: overwrite === true })
    }
    function fsRemoveEntry(scope, path, recursive) { return fsOp('remove', scope, { path: path, recursive: recursive === true }) }

    /**
     * Upload ONE pasted/dropped `File` as raw bytes into a tree directory.
     *
     * The JSON body routes cannot carry a binary attachment, so this streams the
     * blob itself (`fetch` body = `File`) with the metadata in the query string.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} dir - absolute target directory.
     * @param {string} name - leaf file name (no separators).
     * @param {Blob|File} blob - the file bytes.
     * @param {boolean} [overwrite] - replace an existing entry (user chose 覆盖).
     * @returns {Promise<object>} the host payload (`{ok, path, name, bytes}`).
     */
    async function fsUpload(scope, dir, name, blob, overwrite) {
      var url = routeUrl('dsh-ris-ide/fs/upload')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('dir', dir)
      url.searchParams.set('name', name)
      if (overwrite === true) url.searchParams.set('overwrite', '1')
      var response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        var failure = new Error(parsed !== null && parsed.message !== undefined ? parsed.message : 'HTTP ' + response.status)
        failure.code = parsed !== null && typeof parsed.code === 'string' ? parsed.code : ''
        throw failure
      }
      return parsed
    }

    /**
     * Copy a path that lives OUTSIDE the workspace into a tree directory — the
     * `file://`/path half of an OS "copy file → paste in the tree" gesture (the
     * `File` half goes through `fsUpload`).
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} from - absolute local path (file or directory).
     * @param {string} dir - absolute target directory.
     * @param {string} [name] - leaf name (defaults to the source basename).
     * @param {boolean} [overwrite] - replace an existing entry.
     * @returns {Promise<object>} the host payload (`{ok, path, name}`).
     */
    async function fsImportPath(scope, from, dir, name, overwrite) {
      return fsOp('import', scope, { from: from, dir: dir, name: name, overwrite: overwrite === true })
    }

    /**
     * Write a text file back.
     *
     * `/sidebar/api` has NO `fs.write` method (it answers 404); the sidebar's one
     * text-write route is a raw `POST sidebar/write?sessionId&cwd&path` whose body
     * IS the document (`text/plain`), answered with `{ ok:true, value:{ok:true,
     * mtimeMs?} }`. This is the same route the sidebar's own editor uses.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} path - absolute file path.
     * @param {string} content - the whole new document.
     * @returns {Promise<{mtimeMs?: number}>} the fresh baseline.
     */
    async function fsWrite(scope, path, content) {
      var url = routeUrl('dsh-ris-ide/fs/write')
      var response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: scope.sessionId,
          ...(typeof scope.cwd === 'string' && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
          path: path,
          content: content,
        }),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        if (parsed !== null && parsed.message !== undefined) throw new Error(parsed.message)
        throw new Error('HTTP ' + response.status)
      }
      return { mtimeMs: parsed.mtimeMs }
    }
    /**
     * Workspace filename search — through THIS plugin's host route, which runs
     * `git ls-files --cached --others --exclude-standard` per repo root, so every
     * .gitignore (including each subproject's own and nested ones) is honoured.
     * The sidebar's `fs.search` walks the whole tree instead (node_modules,
     * target, ... included) and only knows the workspace's root cwd.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {string} query - case-insensitive path/basename substring.
     * @returns {Promise<{matches: string[], dirs: object}>} absolute file paths.
     */
    async function fsSearch(scope, query) {
      var url = routeUrl('dsh-ris-ide/search')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('q', query)
      url.searchParams.set('limit', '300')
      var response = await fetch(url.href, { headers: { accept: 'application/json' } })
      var parsed = await response.json().catch(function () { return null })
      if (response.ok && parsed !== null && parsed.ok === true) {
        return { matches: Array.isArray(parsed.matches) ? parsed.matches : [], dirs: {} }
      }
      throw new Error((parsed && parsed.message) || ('HTTP ' + response.status))
    }

    /**
     * GET `/dsh-ris-ide/settings`: the IDE-owned settings kept beside the program
     * config (currently the decompiler jar used for dependency classes).
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @returns {Promise<object>} the settings payload.
     */
    async function fsSettings(scope) {
      var url = routeUrl('dsh-ris-ide/settings')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      var response = await fetch(url.href, { headers: { accept: 'application/json' } })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error(parsed !== null && typeof parsed.message === 'string' ? parsed.message : 'HTTP ' + response.status)
      }
      return parsed
    }

    /**
     * POST `/dsh-ris-ide/settings`: persist the visual debug settings.
     * @param {object} scope - owning session.
     * @param {{decompilerJar?: string, decompilerArgs?: string[]}} payload - settings to write.
     * @returns {Promise<object>} the saved settings.
     */
    async function fsSaveSettings(scope, payload) {
      var url = routeUrl('dsh-ris-ide/settings')
      var response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId: scope.sessionId }, typeof scope.cwd === 'string' && scope.cwd !== '' ? { cwd: scope.cwd } : {}, payload)),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error(parsed !== null && typeof parsed.message === 'string' ? parsed.message : 'HTTP ' + response.status)
      }
      return parsed
    }

    /**
     * GET `/dsh-ris-ide/debug/source`: resolve one dependency class to a readable
     * cached file (extracted `-sources.jar` entry, decompiled output or javap).
     * @param {object} scope - owning session.
     * @param {string} className - class name of the frame.
     * @param {string} logPath - the debugged program's log (identifies the program).
     * @returns {Promise<string|undefined>} absolute path of the cached file.
     */
    async function fsDependencySource(scope, className, logPath) {
      var url = routeUrl('dsh-ris-ide/debug/source')
      url.searchParams.set('sessionId', scope.sessionId)
      var routeCwd = scopeCwd(scope)
      if (routeCwd !== undefined) url.searchParams.set('cwd', routeCwd)
      url.searchParams.set('className', className)
      if (typeof logPath === 'string' && logPath !== '') url.searchParams.set('path', logPath)
      var response = await fetch(url.href, { headers: { accept: 'application/json' } })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) return undefined
      return typeof parsed.path === 'string' && parsed.path !== '' ? parsed.path : undefined
    }

    /**
     * Turn an `fsSearch()` reply into the toolbar dropdown payload.
     *
     * `fsSearch` answers `{matches, dirs}` where `dirs` is a PLAIN OBJECT keyed by
     * path (the host route matches files only, so it is normally `{}`). Iterating it
     * as an array crashed the dropdown with `result.dirs.forEach is not a function`,
     * which made every filename search look broken — hence this single helper, with
     * `Object.keys` (an array reply is still accepted for the legacy path).
     * @param {{matches?: string[], dirs?: object|string[]}} result - search reply.
     * @param {string} cwd - session workspace root for relative paths.
     * @returns {{matches: string[], dirs: object}} dropdown payload.
     */
    function searchHitPayload(result, cwd) {
      var source = result !== null && result !== undefined ? result : {}
      var rawDirs = source.dirs !== null && source.dirs !== undefined ? source.dirs : {}
      var keys = Array.isArray(rawDirs) ? rawDirs : Object.keys(rawDirs)
      var dirs = {}
      keys.forEach(function (item) { dirs[absolutePath(cwd, item)] = true })
      var matches = Array.isArray(source.matches) ? source.matches : []
      return { matches: matches.map(function (item) { return absolutePath(cwd, item) }), dirs: dirs }
    }

    /**
     * The `scrollTop` that brings a row into a scrolling list.
     *
     * Used after a locate/search reveal: expanding the branch makes the row exist,
     * but the list itself is `overflow:auto`, so its own `scrollTop` must move —
     * scrolling the page (or `scrollIntoView`) moved the wrong thing.
     * @param {number} rowTop - row's viewport top.
     * @param {number} rowBottom - row's viewport bottom.
     * @param {number} listTop - list's viewport top.
     * @param {number} listBottom - list's viewport bottom.
     * @param {number} scrollTop - the list's current scrollTop.
     * @returns {number} the scrollTop to apply (never negative).
     */
    function revealScrollTop(rowTop, rowBottom, listTop, listBottom, scrollTop) {
      if (rowTop < listTop) return Math.max(0, scrollTop - (listTop - rowTop))
      if (rowBottom > listBottom) return Math.max(0, scrollTop + (rowBottom - listBottom))
      return scrollTop
    }

    /**
     * Resolve a sidebar path (absolute, or cwd-relative as `fs.search` returns
     * them) against the session cwd, so tree rows and editor tabs share ONE key
     * per file. Also folds `\` to `/` so Windows paths compare equal.
     * @param {string} cwd - the session workspace root.
     * @param {string} path - absolute or cwd-relative path.
     * @returns {string} an absolute, slash-normalized path.
     */
    function absolutePath(cwd, path) {
      var value = String(path === undefined || path === null ? '' : path).replace(/\\/g, '/')
      if (value === '') return value
      var absolute = /^([a-zA-Z]:\/|\/)/.test(value) || /^~(\/|$)/.test(value)
      if (absolute) return value
      var root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root === '') return value
      return root + '/' + value.replace(/^\/+/, '')
    }

    /**
     * The ONE breakpoint list every rendering reads (gutter dots, breakpoint tab,
     * status bar, removal logic). A snapshot only refreshes the slice of the
     * program it polled (`payload.logPath`), so entries of another program are not
     * dropped just because that program is not selected; a stale local entry is
     * dropped as soon as its own program reports it gone.
     *
     * Local optimistic entries (`pending:true, optimistic:true`) survive until the
     * host confirms them — the JDWP request may wait up to 30 s for ClassPrepare.
     */
    var GLOBAL_BREAKPOINTS = []
    /** How long an optimistic entry may outlive the snapshot that lacks it. */
    var BREAKPOINT_OPTIMISTIC_MS = 35000
    function globalBreakpointsSnapshot() { return GLOBAL_BREAKPOINTS }
    /** Stable identity of a breakpoint within its program (class + line). */
    function breakpointKey(bp) {
      var className = bp === null || bp === undefined ? '' : String(bp.className === undefined || bp.className === null ? '' : bp.className)
      var line = bp === null || bp === undefined ? '' : String(bp.line === undefined || bp.line === null ? '' : bp.line)
      return className + ':' + line
    }
    /**
     * Fold one debug snapshot into the global list.
     * @param {object|null} payload - poll/status payload carrying `logPath` + `breakpoints`.
     * @returns {object[]} the new global list.
     */
    function mergeGlobalBreakpoints(payload) {
      var snapshot = payload !== null && payload !== undefined ? payload : {}
      var logPath = typeof snapshot.logPath === 'string' ? snapshot.logPath : ''
      var incoming = Array.isArray(snapshot.breakpoints) ? snapshot.breakpoints : []
      var seen = {}
      incoming.forEach(function (bp) { if (bp !== null && typeof bp === 'object') seen[breakpointKey(bp)] = true })
      var next = []
      var now = Date.now()
      GLOBAL_BREAKPOINTS.forEach(function (bp) {
        if (bp === null || typeof bp !== 'object') return
        if (String(bp.logPath === undefined || bp.logPath === null ? '' : bp.logPath) !== logPath) { next.push(bp); return }
        // This snapshot speaks for THIS program: host truth wins, except for a
        // local optimistic dot whose request has not come back yet.
        var optimistic = bp.optimistic === true && now - Number(bp.optimisticAt === undefined ? 0 : bp.optimisticAt) < BREAKPOINT_OPTIMISTIC_MS
        if (optimistic && seen[breakpointKey(bp)] !== true) next.push(bp)
      })
      incoming.forEach(function (bp) {
        if (bp !== null && typeof bp === 'object') next.push(Object.assign({}, bp, { logPath: logPath }))
      })
      var deduped = []
      var at = {}
      next.forEach(function (bp) {
        var key = String(bp.logPath || '') + '\u0000' + breakpointKey(bp)
        if (at[key] === undefined) { at[key] = deduped.length; deduped.push(bp) }
        else deduped[at[key]] = bp
      })
      GLOBAL_BREAKPOINTS = deduped
      return deduped
    }

    /**
     * Whether a debug snapshot has a STOPPED thread.
     *
     * JDWP breakpoints and steps use `SuspendPolicy.EventThread`: only the hitting
     * thread stops and `vmSuspended` stays false, so the whole pane must fold both
     * flags into one "paused" predicate (buttons, cleared stack, tab switching).
     * @param {object} snapshot - `/debug/poll` payload or SSE `debug` frame.
     * @returns {boolean} true when at least one thread (or the whole VM) is stopped.
     */
    function debugSnapshotSuspended(snapshot) {
      if (snapshot === null || snapshot === undefined) return false
      if (snapshot.vmSuspended === true) return true
      return Array.isArray(snapshot.suspendedThreads) && snapshot.suspendedThreads.length > 0
    }

    /**
     * The thread to read frames/variables from after a suspend.
     *
     * The host reports `currentThreadId` (the thread a breakpoint/step stopped);
     * fall back to the newest `suspendedThreads` entry for older payloads.
     * @param {object} snapshot - `/debug/poll` payload or SSE `debug` frame.
     * @returns {string|undefined} a JSON-string thread id, or undefined when nothing is stopped.
     */
    function debugSuspendedThreadId(snapshot) {
      if (snapshot === null || snapshot === undefined) return undefined
      var current = snapshot.currentThreadId
      if (current !== undefined && current !== null && current !== '') return String(current)
      var ids = Array.isArray(snapshot.suspendedThreads) ? snapshot.suspendedThreads : []
      if (ids.length === 0) return undefined
      return String(ids[ids.length - 1])
    }

    /**
     * Enforce the open-file cap: when adding `path` would exceed `limit`, drop the
     * OLDEST tabs that have no unsaved change (never a dirty one — a draft is
     * worth more than the new tab). Returns the list to use, or `null` when every
     * tab is dirty and the open must be refused.
     * @param {string[]} files - current open files, in open order.
     * @param {string} path - the file about to open (already normalized).
     * @param {number} limit - the cap (20).
     * @param {(path: string) => boolean} isDirty - dirty predicate.
     * @returns {string[]|null} the capped list (may still contain `path`).
     */
    function capOpenFiles(files, path, limit, isDirty) {
      if (files.indexOf(path) !== -1) return files
      var next = files.concat([path])
      while (next.length > limit) {
        var victim = -1
        for (var index = 0; index < next.length - 1; index += 1) {
          if (isDirty(next[index]) !== true) { victim = index; break }
        }
        if (victim === -1) return null
        next.splice(victim, 1)
      }
      return next
    }

    /** Total rows the tab dropdown shows: open tabs first, then recent history. */
    var TAB_MENU_LIMIT = 30

    /** How many recently opened files are recorded at all (the search box shows these). */
    var SEARCH_RECENT_LIMIT = 20

    /** Non-empty string test used by the list helpers (path rows only). */
    function isNonEmptyString(value) {
      return typeof value === 'string' && value !== ''
    }

    /**
     * Move one path to the front of a recent list (dedupe, bounded).
     * @param {string[]} recent - previously remembered paths, newest first.
     * @param {string} path - the file that was just opened.
     * @param {number} [limit] - maximum entries kept (default {@link TAB_MENU_LIMIT}).
     * @returns {string[]} a new list, newest first.
     */
    function pushRecent(recent, path, limit) {
      var source = Array.isArray(recent) ? recent : []
      var cap = typeof limit === 'number' && limit >= 0 ? limit : TAB_MENU_LIMIT
      if (!isNonEmptyString(path)) return source.slice(0, cap)
      var list = source.filter(function (item) { return isNonEmptyString(item) && item !== path })
      list.unshift(path)
      return list.slice(0, cap)
    }

    /**
     * Rows of the tab dropdown: every open tab (in strip order, flagged `open`),
     * then the recent files that are not open any more. The whole list is capped
     * so it can never grow into an unbounded menu.
     * @param {string[]} openFiles - open tab paths, in strip order.
     * @param {string[]} recent - remembered paths, newest first.
     * @param {number} [limit] - total row cap (default {@link TAB_MENU_LIMIT}).
     * @returns {{path: string, open: boolean}[]} menu rows.
     */
    function tabMenuEntries(openFiles, recent, limit) {
      var cap = typeof limit === 'number' && limit >= 0 ? limit : TAB_MENU_LIMIT
      var open = (Array.isArray(openFiles) ? openFiles : []).filter(isNonEmptyString)
      var rows = open.map(function (path) { return { path: path, open: true } })
      ;(Array.isArray(recent) ? recent : []).forEach(function (path) {
        if (!isNonEmptyString(path) || open.indexOf(path) !== -1) return
        rows.push({ path: path, open: false })
      })
      return rows.slice(0, cap)
    }

    /**
     * Rows for the empty search box: the files opened most recently, newest first.
     * Open tabs are flagged so the row can say "already open".
     * @param {string[]} recent - remembered paths, newest first.
     * @param {string[]} openFiles - open tab paths.
     * @param {number} [limit] - row cap (default {@link SEARCH_RECENT_LIMIT}).
     * @returns {{path: string, open: boolean}[]} menu rows.
     */
    function searchHistoryEntries(recent, openFiles, limit) {
      var cap = typeof limit === 'number' && limit >= 0 ? limit : SEARCH_RECENT_LIMIT
      var open = (Array.isArray(openFiles) ? openFiles : []).filter(isNonEmptyString)
      var rows = []
      ;(Array.isArray(recent) ? recent : []).forEach(function (path) {
        if (!isNonEmptyString(path) || rows.some(function (row) { return row.path === path })) return
        rows.push({ path: path, open: open.indexOf(path) !== -1 })
      })
      return rows.slice(0, cap)
    }

    /**
     * Split the tabs a bulk close would remove from the ones it must ask about.
     * @param {string[]} openFiles - open tab paths, in strip order.
     * @param {string|undefined} activePath - the active tab (kept for "close others").
     * @param {function(string): boolean} isDirty - per-path draft check.
     * @param {boolean} keepActive - true for "close others", false for "close all".
     * @returns {{victims: string[], dirty: string[]}} all victims and their dirty subset.
     */
    function bulkClosePlan(openFiles, activePath, isDirty, keepActive) {
      var victims = []
      var dirty = []
      ;(Array.isArray(openFiles) ? openFiles : []).forEach(function (path) {
        if (keepActive && path === activePath) return
        victims.push(path)
        if (isDirty(path) === true) dirty.push(path)
      })
      return { victims: victims, dirty: dirty }
    }

    /**
     * Derive a Java class name from a source path (RIS layout:
     * `src/main/java/cn/com/.../Cls.java` → `cn.com....Cls`).
     * @param {string} path - absolute or workspace-relative source path.
     * @returns {string|undefined} the class name, when the path looks like Java source.
     */
    /**
     * True when a Java source line has no executable code: blank, or comment-only.
     *
     * A breakpoint there is meaningless (the debugger would snap to the nearest
     * executable line), so the gutter click is ignored instead of adding a dot.
     * @param {string|undefined} text - one source line.
     * @returns {boolean} whether a breakpoint on it must be refused.
     */
    function isNonExecutableJavaLine(text) {
      if (typeof text !== 'string') return false
      var trimmed = text.trim()
      if (trimmed === '') return true
      if (trimmed.startsWith('//')) return true
      return trimmed.startsWith('/*') || trimmed.startsWith('*')
    }

    function classNameFromPath(path) {
      if (typeof path !== 'string' || path === '') return undefined
      var normalized = path.replace(/\\/g, '/')
      var marker = '/src/main/java/'
      var index = normalized.indexOf(marker)
      var rest = index !== -1 ? normalized.slice(index + marker.length) : normalized.replace(/^.*\/src\/main\/java\//, '')
      if (!/\.java$/.test(rest)) return undefined
      var className = rest.replace(/\.java$/, '').split('/').join('.')
      return className === '' ? undefined : className
    }

    /**
     * Open one program's workbench tab (debug pane + live log).
     * @param {object} ctx - client context captured by `apply`.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {object} program - one row from the programs panel.
     * @param {boolean} [autoStartDebug] - start a debug session on mount.
     */
    function openProgramWorkbench(ctx, scope, program, autoStartDebug) {
      selectProgram(Object.assign({}, program, { autoDebug: autoStartDebug === true }))
      openIdeTab(ctx)
    }

    /**
     * Ask the host to start one discovered program.
     *
     * Only the PROGRAM ID crosses the wire: the host re-scans and composes the
     * command from repository content, so this call can never execute a command
     * the page made up.
     * @param {string} programId - `id` of a row from `GET /programs`.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @returns {Promise<object>} `{ ok: true, alreadyRunning, program }` or
     *  `{ ok: false, code, error }`.
     */
    async function requestStart(programId, scope) {
      var body = { sessionId: scope.sessionId, id: programId }
      if (typeof scope.cwd === 'string' && scope.cwd !== '') body.cwd = scope.cwd
      var response = await fetch(routeUrl('dsh-ris-ide/start').href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return {
          ok: false,
          code: parsed && parsed.code ? parsed.code : 'http',
          error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status,
        }
      }
      return parsed
    }

    /**
     * Ask the host to write (or update) the user-editable config from a fresh scan.
     * @param {{sessionId: string, cwd?: string}} scope - owning session.
     * @param {'generate'|'update'|'overwrite'} [mode] - `update` refreshes a
     *  drifted file while keeping user edits; `overwrite` replaces it.
     * @returns {Promise<object>} `{ ok: true, path, count, mode }` or
     *  `{ ok: false, error, code }`.
     */
    async function generateConfig(scope, mode) {
      var body = { sessionId: scope.sessionId }
      if (mode === 'update' || mode === 'overwrite') body.mode = mode
      if (typeof scope.cwd === 'string' && scope.cwd !== '') body.cwd = scope.cwd
      var response = await fetch(routeUrl('dsh-ris-ide/config').href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      var parsed = await response.json().catch(function () { return null })
      if (!response.ok || parsed === null || parsed.ok !== true) {
        return {
          ok: false,
          code: parsed && parsed.code ? parsed.code : 'http',
          error: parsed && parsed.message ? parsed.message : 'HTTP ' + response.status,
        }
      }
      return parsed
    }

    /**
     * Drain the host's pending "open this log in the sidebar" requests.
     *
     * This is what makes the model-facing `ris_dev_logs` tool visible to the
     * human: the tool queues `{ sessionId, cwd, logPath, title }` on the host and
     * this poller opens each one through the sidebar service. Runs at plugin
     * scope (not inside the panel), so it works whether or not the tab is open.
     */
    /**
     * Open everything the host queued (`ris_dev_logs`, `ris_dev_debug open`, …).
     * Fed either by the JSON route or by the `opens` SSE event — both land here.
     * @param {object[]} opens - pending open requests.
     */
    function applyOpenRequests(opens) {
      if (panelCtx === null) return
      for (var index = 0; index < opens.length; index += 1) {
        var item = opens[index]
        if (item === null || typeof item !== 'object' || typeof item.logPath !== 'string') continue
        try {
          if (item.kind === 'program') {
            openProgramWorkbench(panelCtx, { sessionId: item.sessionId, cwd: item.cwd }, {
              id: item.programId,
              name: item.title || '程序',
              logPath: item.logPath,
              kind: item.programKind || 'spring',
            }, item.autoDebug === true)
            continue
          }
          openInstanceLog(panelCtx, { sessionId: item.sessionId, cwd: item.cwd }, item.logPath, item.title || '日志')
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[dsh-ris-ide] opening the requested log failed:', messageOf(error))
        }
      }
    }

    function drainOpenRequests() {
      if (panelCtx === null) return Promise.resolve()
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return Promise.resolve()
      return fetch(routeUrl('dsh-ris-ide/opens').href, { headers: { accept: 'application/json' } })
        .then(function (response) { return response.json() })
        .then(function (payload) {
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) return
          applyOpenRequests(Array.isArray(payload.opens) ? payload.opens : [])
        })
        .catch(function () { /* the next tick retries */ })
    }

    /**
     * The "本地实例" panel — a launcher, not just a log list.
     *
     * Rows come from `GET /programs`, which scans the session workspace for
     * runnable programs (Spring Boot `@SpringBootApplication` entry points and
     * frontend manifests with a dev script) and decorates each with its running
     * state. Three buttons per row:
     *
     *   启动 → POST /start  (host re-scans and composes the command itself)
     *   停止 → POST /stop   (the pidfile protocol the log viewer already uses)
     *   日志 → opens the program's `.log` through the sidebar service, where the
     *          existing viewer tails it live.
     *
     * The browser never sends a command and never sends a PID; the host decides
     * both. Discovery is cached on the host (15 s), so polling this panel costs
     * a few pidfile reads, not a tree walk.
     */
    /**
     * The compact panel's LOG title bar: which program/file the tail belongs to,
     * then the two controls that belong to this pane — follow/pause and maximize.
     * Presentational on purpose: the panel and the tests render the same thing.
     */
    function CompactLogHead(props) {
      var following = props.following !== false
      var fontSize = typeof props.fontSize === 'number' ? props.fontSize : DEFAULT_FONT_SIZE
      return h('div', { style: S.compactLogHead },
        h('span', { style: S.compactLogTitle, title: props.logPath }, props.programName),
        props.logFileName !== '' ? h('span', { style: S.meta }, props.logFileName) : null,
        h('span', { style: S.spacer }),
        // The IDE's log title bar carries A−/A+; the compact one keeps the same
        // two buttons on the same preference, so the sidebar can be read at a
        // comfortable size without opening the window.
        props.logPath !== ''
          ? h('button', {
            type: 'button', style: S.paneButton, 'data-action': 'compact-font-down',
            title: '缩小日志字号（当前 ' + fontSize + 'px）',
            onClick: function (event) {
              if (typeof props.onFontDown === 'function') props.onFontDown(event)
            },
          }, 'A−')
          : null,
        props.logPath !== ''
          ? h('button', {
            type: 'button', style: S.paneButton, 'data-action': 'compact-font-up',
            title: '放大日志字号（当前 ' + fontSize + 'px）',
            onClick: function (event) {
              if (typeof props.onFontUp === 'function') props.onFontUp(event)
            },
          }, 'A+')
          : null,
        props.logPath !== ''
          ? h('button', {
            type: 'button', style: following ? S.paneIconOn : S.paneIcon,
            'data-action': 'compact-follow',
            'aria-pressed': following ? 'true' : 'false',
            title: following ? '跟随中：点击暂停跟随' : '已暂停：点击继续跟随（自动滚到最新）',
            onClick: function (event) {
              if (typeof props.onToggleFollow === 'function') props.onToggleFollow(event)
            },
          }, ideIcon('follow', 13))
          : null,
        h('button', {
          type: 'button', style: S.paneIcon, 'data-action': 'compact-max-log',
          'aria-pressed': props.maximized === true ? 'true' : 'false',
          title: props.maximized ? '还原' : '最大化',
          onClick: function (event) {
            if (typeof props.onToggleMaximize === 'function') props.onToggleMaximize(event)
          },
        }, props.maximized ? '⤡' : '⤢'))
    }

    /**
     * Keeps one broken render from taking the whole IDE (or the dsh page) down.
     *
     * The debug variable tree fetches JDWP ids that can go stale between steps; a
     * stale id must show a banner with a retry, never a blank window.
     */
    /**
     * `React.Component` normally; the bare constructor covers minimal test
     * harnesses (CI loads this bundle with a stub that only carries the hooks).
     * Real hosts always provide the class, and the boundary then works as usual.
     */
    var ErrorBoundaryBase = React !== null && React !== undefined && typeof React.Component === 'function'
      ? React.Component
      : function ErrorBoundaryBase() {}
    class IdeErrorBoundary extends ErrorBoundaryBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = this.retry.bind(this)
      }
      static getDerivedStateFromError(error) {
        return { error: error === null || error === undefined ? new Error('未知错误') : error }
      }
      componentDidCatch(error) {
        try {
          console.error('[ris-ide] panel render failed', error)
        } catch (ignored) {
          // console may be unavailable; the banner below still shows the message.
        }
      }
      retry() {
        this.setState({ error: null })
      }
      render() {
        if (this.state.error === null) return this.props.children
        return h('div', {
          style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', lineHeight: '1.5' },
          'data-ide-crash': '1',
        },
          h('div', { style: { fontWeight: 600 } }, 'RIS-IDE 面板出错了'),
          h('div', { style: { opacity: 0.7 } }, '这次渲染被拦下了，dsh 会话没有受影响。'),
          h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', opacity: 0.85 } },
            String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', { type: 'button', 'data-ide-crash-retry': '1', onClick: this.retry }, '重试')))
      }
    }

    function ProgramsPanel(props) {
      var [active, setActive] = useState(function () { return pendingProgram })
      /**
       * Bumped when a start/stop may have moved this pane's log beyond the frames
       * already delivered: the log viewer re-reads the tail once (see `reloadNonce`).
       */
      var [compactLogNonce, setCompactLogNonce] = useState(0)
      useEffect(function () {
        if (pendingProgram === null) return undefined
        setActive(pendingProgram)
        pendingProgram = null
        return undefined
      }, [])
      // The official right-Sidebar body receives `sessionId` directly; older
      // call sites pass the whole scope object.
      var scope = props ? props.scope : undefined
      var sessionId = scope !== undefined && scope !== null ? scope.sessionId : (props ? props.sessionId : undefined)
      var cwd = scope !== undefined && scope !== null ? scope.cwd : (props ? props.cwd : undefined)
      // A stale session id must not blank the panel: the host still accepts a cwd.
      if (typeof cwd !== 'string' || cwd === '') cwd = knownWorkspaceCwd()
      // COMPACT mode is the sidebar panel: console rows on top, ONE program's
      // live log below. The full IDE (tree/editor/debug) lives only in the
      // standalone window, so the sidebar stays cheap and readable.
      var compact = props !== null && props !== undefined && props.compact === true
      // Which program the compact log pane follows; undefined means "pick one".
      var [compactPick, setCompactPick] = useState(undefined)
      var [compactPane, setCompactPane] = useState(readCompactPaneHeight)
      var compactPaneRef = useRef(compactPane)
      compactPaneRef.current = compactPane
      var [compactSplitHover, setCompactSplitHover] = useState(false)
      // Which of the two compact sections owns the panel ('' = split view). The
      // sidebar is too narrow for the IDE's 2x2 maximize, but "最大化这一段" is
      // still useful when reading a long log or a long program list.
      var [compactMax, setCompactMax] = useState(readCompactMax)
      // The compact log pane's "follow the tail" switch. LogTail defaults to
      // following, but the sidebar view had no control for it — the IDE title bar
      // owned that button, so the compact header needs its own.
      var [compactFollow, setCompactFollow] = useState(true)
      // The compact log's own font size, on the SAME preference the IDE's log
      // pane writes (`PREF_FONT_SIZE`): A−/A+ in either place agrees.
      var [compactFont, setCompactFont] = useState(function () {
        return clampFontSize(readPref(PREF_FONT_SIZE, DEFAULT_FONT_SIZE))
      })
      var [state, setState] = useState(function () {
        return { loading: true, programs: [], root: undefined, dir: undefined, config: undefined, error: undefined, note: undefined }
      })
      // Top-bar messages are transient: keep them for 5 seconds, then clear them
      // (errors and the scan status stay as long as they are current).
      useEffect(function () {
        if (state.note === undefined || state.note === null) return undefined
        var timer = setTimeout(function () {
          setState(function (prev) {
            if (prev.note === undefined || prev.note === null) return prev
            return Object.assign({}, prev, { note: undefined })
          })
        }, 5000)
        return function () { clearTimeout(timer) }
      }, [state.note])

      var [busyId, setBusyId] = useState(undefined)
      var busyRef = useRef(false)
      var panelDismissals = useDismissedNotices()

      var refresh = React.useCallback(async function (force) {
        if (typeof sessionId !== 'string' || sessionId === '' || busyRef.current) return
        busyRef.current = true
        try {
          var url = routeUrl('dsh-ris-ide/programs')
          url.searchParams.set('sessionId', sessionId)
          if (typeof cwd === 'string' && cwd !== '') url.searchParams.set('cwd', cwd)
          if (force === true) url.searchParams.set('refresh', '1')
          var response = await fetch(url.href, { headers: { accept: 'application/json' } })
          var payload = await response.json().catch(function () { return undefined })
          if (payload !== undefined && payload !== null) rememberWorkspaceCwd(payload.root)
          if (!response.ok || payload === undefined || payload.ok !== true) {
            setState(function (prev) {
              return Object.assign({}, prev, {
                loading: false,
                error: (payload && payload.message) || ('HTTP ' + response.status),
              })
            })
            return
          }
          setState(function (prev) {
            return {
              loading: false,
              programs: payload.programs || [],
              root: payload.root,
              dir: payload.dir,
              config: payload.config,
              error: undefined,
              note: prev.note,
            }
          })
        } catch (error) {
          setState(function (prev) { return Object.assign({}, prev, { loading: false, error: messageOf(error) }) })
        } finally {
          busyRef.current = false
        }
      }, [sessionId, cwd])

      /** Console rows stream (fallback: the 3 s poll below). */
      var [streamOk, setStreamOk] = useState(function () { return typeof EventSource === 'function' })
      useEffect(function () {
        if (streamOk !== true || props.visible === false) return undefined
        if (typeof EventSource !== 'function' || typeof sessionId !== 'string' || sessionId === '') return undefined
        var failures = 0
        return risStreamHub().subscribe({
          topics: ['programs'],
          sessionId: sessionId,
          cwd: typeof cwd === 'string' ? cwd : undefined,
          onOpen: function () {
            failures = 0
            setStreamOk(true)
          },
          onError: function (readyState) {
            failures += 1
            if (failures >= 2 || readyState === 2) setStreamOk(false)
          },
          handlers: {
            programs: function (payload) {
              setState(function (prev) {
                return {
                  loading: false,
                  programs: Array.isArray(payload.programs) ? payload.programs : [],
                  root: payload.root,
                  dir: payload.dir,
                  config: payload.config,
                  error: undefined,
                  note: prev.note,
                }
              })
            },
            'stream-error': function (payload) {
              // Keep the last rows on screen; the note explains the degraded stream.
              setState(function (prev) { return Object.assign({}, prev, { error: payload.error || '流式更新失败' }) })
            },
          },
        })
      }, [streamOk, sessionId, cwd, props.visible])

      useEffect(function () {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ loading: false, programs: [], root: undefined, dir: undefined, config: undefined, error: '没有会话上下文', note: undefined })
          return undefined
        }
        void refresh(false)
        // Parked panel tabs stay mounted too: poll only while visible AND the
        // browser tab is in the foreground — and only when the stream is down.
        var panelVisible = props.visible !== false
        if (!panelVisible || streamOk) return undefined
        var timer = setInterval(function () {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh(false)
        }, PANEL_POLL_MS)
        return function () { clearInterval(timer) }
      }, [refresh, sessionId, props.visible, streamOk])

      /** Start or stop one row, then refresh the state it just changed. */
      function act(kind, program) {
        if (busyId !== undefined) return
        setBusyId(program.id)
        // Show this program's log from the first moment: the start call waits for
        // a pidfile (up to START_WAIT_MS), and Maven compile is silent. The same
        // event moves the standalone IDE window's log pane right away.
        if (kind === 'start') { setActive(program); broadcastLogFocus(program.logPath); setCompactLogNonce(function (value) { return value + 1 }) }
        var scopeArg = { sessionId: sessionId, cwd: cwd }
        var task = kind === 'start' ? requestStart(program.id, scopeArg) : requestStop(program.logPath, scopeArg)
        task.then(function (result) {
          setBusyId(undefined)
          var note
          if (result.ok !== true) note = (kind === 'start' ? '启动失败：' : '停止失败：') + (result.error || '未知错误')
          else if (kind === 'start') {
            note = result.alreadyRunning === true ? program.name + ' 已在运行' : program.name + ' 已启动' + heapHint(program)
          }
          else if (result.alreadyStopped === true) note = program.name + ' 此前已停止'
          else note = program.name + ' 已停止'
          setState(function (prev) { return Object.assign({}, prev, { note: note }) })
          // The start/stop settled and the wrapper wrote its marker: re-read once
          // so the pane cannot stay on the pre-start text.
          setCompactLogNonce(function (value) { return value + 1 })
          void refresh(false)
        }).catch(function (error) {
          setBusyId(undefined)
          setState(function (prev) {
            return Object.assign({}, prev, { note: (kind === 'start' ? '启动失败：' : '停止失败：') + messageOf(error) })
          })
        })
      }

      /** Write or update the user-editable config from a scan. */
      function generateConfigFile(mode) {
        if (busyId !== undefined) return
        setBusyId('__config__')
        generateConfig({ sessionId: sessionId, cwd: cwd }, mode).then(function (result) {
          setBusyId(undefined)
          setState(function (prev) {
            return Object.assign({}, prev, {
              note: result.ok === true
                ? '已生成配置：' + result.path + '（共 ' + result.count + ' 条；可改可加，保存后约 3 秒生效）'
                : '生成配置失败：' + (result.error || '未知错误'),
            })
          })
          void refresh(true)
        }).catch(function (error) {
          setBusyId(undefined)
          setState(function (prev) { return Object.assign({}, prev, { note: '生成配置失败：' + messageOf(error) }) })
        })
      }

      /** Open the config file in the sidebar editor (JSON 走插件的编辑器). */
      function openConfig() {
        var path = state.config !== undefined && state.config !== null ? state.config.path : undefined
        if (typeof path !== 'string' || path === '') return
        // The standalone window has no DSH right sidebar, so there is no sidebar
        // editor to open into. Say WHERE the file is instead of failing loudly.
        if (panelCtx === null || panelCtx === undefined) {
          setState(function (prev) { return Object.assign({}, prev, { note: '独立窗口没有侧边栏编辑器，配置文件在 ' + path }) })
          return
        }
        try {
          openInstanceLog(panelCtx, { sessionId: sessionId, cwd: cwd }, path, '本地实例配置')
        } catch (error) {
          setState(function (prev) { return Object.assign({}, prev, { note: '打开配置失败：' + messageOf(error) }) })
        }
      }

      /** Open one program's workbench tab (debug pane + live log). */
      /** Switch this tab from the project list into one project's IDE. */
      function openWorkbench(program, autoDebug) {
        selectProgram(Object.assign({}, program, { autoDebug: autoDebug === true }))
        setActive(pendingProgram)
        pendingProgram = null
      }

      /** Open one program's log in the sidebar (the `.log` viewer takes it from there). */
      function openLog(program) {
        try {
          openInstanceLog(panelCtx, { sessionId: sessionId, cwd: cwd }, program.logPath, program.name + ' 日志')
        } catch (error) {
          setState(function (prev) { return Object.assign({}, prev, { note: '打开日志失败：' + messageOf(error) }) })
        }
      }

      var configExists = state.config !== undefined && state.config !== null && state.config.exists === true

      // ── compact (sidebar) panel ───────────────────────────────────────────
      // Two rows of information only: every program as one console line, and the
      // log of the selected one underneath. Everything else (tree, editor, debug)
      // is one click away in the standalone window, so the sidebar does not have
      // to carry it — and a panel that stays mounted all day costs nothing extra.

      /** The row the log pane follows: the explicit pick, else a sensible default. */
      function compactProgram() {
        var rows = state.programs
        if (rows.length === 0) return undefined
        for (var pickIndex = 0; pickIndex < rows.length; pickIndex += 1) {
          if (rows[pickIndex].id === compactPick) return rows[pickIndex]
        }
        // Nothing picked (first render): prefer a running program — that is the
        // one whose log someone actually wants — else the first with a log file.
        for (var aliveIndex = 0; aliveIndex < rows.length; aliveIndex += 1) {
          var aliveRow = rows[aliveIndex]
          if (aliveRow.running !== null && aliveRow.running !== undefined && aliveRow.running.alive === true) return aliveRow
        }
        for (var logIndex = 0; logIndex < rows.length; logIndex += 1) {
          if (typeof rows[logIndex].logPath === 'string' && rows[logIndex].logPath !== '') return rows[logIndex]
        }
        return rows[0]
      }

      /** Bump the compact log's font size (`A−`/`A+`), persisted like the IDE's. */
      function bumpCompactFont(delta) {
        setCompactFont(function (previous) {
          var next = clampFontSize(previous + delta)
          writePref(PREF_FONT_SIZE, String(next))
          return next
        })
      }

      /** Open the standalone window on the picked program (or on the workspace). */
      function openCompactWindow() {
        var picked = compactProgram()
        try {
          // Reuse the one window (named), and bring it forward: a second click on
          // ⧉ IDE should focus the IDE the user already has, not look dead.
          var handle = openStandaloneWindow({ sessionId: sessionId, cwd: cwd, programId: picked !== undefined ? picked.id : undefined })
          if (handle !== null && handle !== undefined && typeof handle.focus === 'function') handle.focus()
        } catch (error) {
          setState(function (prev) { return Object.assign({}, prev, { note: '打开 IDE 窗口失败：' + messageOf(error) }) })
        }
      }

      /** Drag the hairline above the log pane; the height is remembered on release. */
      /** Maximize one compact section (console | log); the other one is parked. */
      function toggleCompactMax(section) {
        var next = compactMax === section ? '' : section
        writePref(COMPACT_MAX_KEY, next)
        setCompactMax(next)
      }

      function dragLogPane(event) {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        var startY = event.clientY
        var startHeight = compactPaneRef.current
        var viewport = typeof window !== 'undefined' ? window.innerHeight : 800
        function move(moveEvent) {
          var next = startHeight - (moveEvent.clientY - startY)
          // Keep at least 120px of log and 120px of console on screen.
          var height = Math.min(Math.max(120, next), Math.max(160, viewport - 200))
          // Keep the ref current: `stop` persists it, and a fast drag can release
          // before React has re-rendered with the new state.
          compactPaneRef.current = height
          setCompactPane(height)
        }
        function stop() {
          if (typeof document !== 'undefined') {
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
          }
          if (typeof window !== 'undefined') {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', stop)
          }
          writePref(COMPACT_UI_KEY, String(compactPaneRef.current))
        }
        if (typeof document !== 'undefined') {
          document.body.style.cursor = 'row-resize'
          document.body.style.userSelect = 'none'
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', stop)
        }
      }

      /** One console line: state dot, name (click follows its log), memory, run controls. */
      function compactRow(program) {
        var running = program.running
        var alive = running !== null && running !== undefined && running.alive === true
        var startable = program.kind !== 'instance'
        var busy = busyId === program.id
        var picked = compactPick !== undefined && program.id === compactPick
        return h('div', {
          key: program.id,
          // The sidebar is narrow: the name shrinks first, the run controls keep
          // their hit area instead of spilling past the panel edge.
          style: Object.assign({}, picked ? S.consoleRowOn : S.debugRow, { flex: '0 0 auto', minWidth: 0, cursor: 'pointer', position: 'relative', overflow: 'hidden' }),
          'data-compact-row': program.name,
          'data-compact-on': picked ? '1' : undefined,
          title: program.name + (program.dir !== undefined ? '（' + program.dir + '）' : ''),
          // The WHOLE row picks the log: a console list is clicked anywhere, and
          // clicking the blank part of a row used to do nothing at all, which
          // reads as "the pick is broken".
          onClick: function () { setCompactPick(program.id) },
        },
          h('span', { style: alive ? S.instDotOn : S.instDotOff, title: alive ? '运行中' : '未运行' }, '●'),
          h('button', {
            type: 'button', style: S.compactPick,
            title: '查看 ' + program.name + ' 的实时日志',
            'data-compact-pick': program.id,
            onClick: function (event) {
              event.stopPropagation()
              setCompactPick(program.id)
            },
          }, program.name),
          h('span', { style: S.spacer }),
          alive && formatMemory(running.rssBytes) !== ''
            ? h('span', { style: S.meta, title: '常驻内存（VmRSS）' }, formatMemory(running.rssBytes))
            : null,
          startable && !alive
            ? h('button', {
              type: 'button', style: busy ? S.paneIconOff : S.startIcon, disabled: busy, 'data-action': 'start',
              title: '启动 ' + program.name,
              onClick: function (event) { event.stopPropagation(); void act('start', program) },
            }, busy ? '…' : '▶')
            : null,
          alive
            ? h('button', {
              type: 'button', style: busy ? S.paneIconOff : S.stopIcon, disabled: busy, 'data-action': 'stop',
              title: '停止 ' + program.name,
              onClick: function (event) { event.stopPropagation(); void act('stop', program) },
            }, busy ? '…' : '■')
            : null,
          program.kind === 'spring'
            ? h('button', {
              type: 'button', style: S.debugIcon, 'data-action': 'debug-window',
              title: '在独立窗口里调试 ' + program.name + '（含断点/调用栈/变量）',
              onClick: function (event) {
                event.stopPropagation()
                try {
                  openStandaloneWindow({ sessionId: sessionId, cwd: cwd, programId: program.id, debug: true })
                } catch (error) {
                  setState(function (prev) { return Object.assign({}, prev, { note: '打开 IDE 窗口失败：' + messageOf(error) }) })
                }
              },
            }, ideBadgeIcon('bug', 'play', 13))
            : null,
          // While the start/stop call is in flight, cover the row: the buttons
          // are already disabled, but the row itself must not answer clicks
          // either (it selects/picks the program).
          busy
            ? h('div', {
              key: 'loading',
              className: 'dsh-ris-ide-loading',
              'data-program-loading': program.id,
              title: '正在' + (alive ? '停止' : '启动') + ' ' + program.name + '…',
              onClick: function (event) { event.stopPropagation(); event.preventDefault() },
              onMouseDown: function (event) { event.stopPropagation(); event.preventDefault() },
            },
              h('span', { className: 'dsh-ris-ide-spinner' }),
              h('span', null, alive ? '停止中…' : '启动中…'))
            : null)
      }

      /** The compact panel itself. */
      function compactPanel() {
        var picked = compactProgram()
        var logPath = picked !== undefined && typeof picked.logPath === 'string' ? picked.logPath : ''
        var maxed = compactMax
        /** Title-bar maximize for one section (same ⤢/⤡ affordance as the IDE panes). */
        var maxButton = function (section) {
          var isMaxed = maxed === section
          return h('button', {
            type: 'button', style: S.paneIcon, 'data-action': 'compact-max-' + section,
            'aria-pressed': isMaxed ? 'true' : 'false',
            title: isMaxed ? '还原' : '最大化',
            onClick: function () { toggleCompactMax(section) },
          }, isMaxed ? '⤡' : '⤢')
        }
        return h('div', { style: S.root, 'data-panel': 'compact' },
          h('style', { key: 'compact-loading-css' }, PROGRAM_LOADING_CSS),
          h('div', { style: S.bar, 'data-compact-bar': '1' },
            h('span', { style: S.status }, state.loading ? '扫描中…' : (state.programs.length + ' 个项目')),
            h('span', { style: S.meta, title: state.root }, state.root || ''),
            h('span', { style: S.spacer }),
            h('button', {
              type: 'button', style: S.paneButton, 'data-action': 'ide-window',
              title: '在独立窗口中打开RIS-IDE' + (picked !== undefined ? '：' + picked.name : ''),
              onClick: openCompactWindow,
            }, '⧉ IDE'),
            h('button', {
              type: 'button', style: state.loading ? S.paneIconOff : S.paneIcon,
              disabled: state.loading, 'data-action': 'compact-rescan',
              title: '重新扫描项目（发现结果缓存 15 秒）',
              onClick: function () { void refresh(true) },
            }, '⟳'),
            // The console's title bar IS this top bar: maximize the row list alone.
            maxButton('console')),
          state.error !== undefined && state.error !== null
            ? h('div', { style: S.compactNote, 'data-compact-error': '1' }, '扫描失败：' + state.error)
            : null,
          state.note !== undefined && state.note !== null
            ? h('div', { style: S.compactNote, 'data-compact-note': '1' },
              h('span', { style: S.compactNoteText }, state.note),
              h('button', {
                type: 'button', style: S.paneIcon, title: '知道了',
                onClick: function () { setState(function (prev) { return Object.assign({}, prev, { note: undefined }) }) },
              }, '✕'))
            : null,
          // A maximized section parks the other one entirely (its header too: the
          // visible header's ⤡ is the way back, so there is nothing to lose).
          maxed === 'log'
            ? null
            : h('div', { style: S.compactList, 'data-compact-list': '1' },
              state.programs.length === 0
                ? h('div', { style: S.idePlaceholder }, state.loading ? '正在扫描工作区…' : '没有发现可运行的项目')
                : state.programs.map(compactRow)),
          maxed !== ''
            ? null
            : h('div', {
            key: 'split-compact-log',
            'data-splitter': 'compact-log',
            title: '拖动调整日志区高度（双击恢复 ' + COMPACT_PANE_DEFAULT + 'px）',
            style: {
              flex: '0 0 4px',
              cursor: 'row-resize',
              background: compactSplitHover ? 'color-mix(in srgb, currentColor 24%, transparent)' : 'transparent',
              transition: 'background 120ms',
            },
            onMouseEnter: function () { setCompactSplitHover(true) },
            onMouseLeave: function () { setCompactSplitHover(false) },
            onMouseDown: dragLogPane,
            onDoubleClick: function () {
              setCompactPane(COMPACT_PANE_DEFAULT)
              writePref(COMPACT_UI_KEY, String(COMPACT_PANE_DEFAULT))
            },
          }),
          maxed === 'console'
            ? null
            : h('div', {
              style: Object.assign(
                {},
                S.compactLog,
                // Split view: fixed height, draggable. Maximized: it owns the panel.
                maxed === 'log' ? { flex: '1 1 auto', height: undefined } : { height: compactPane },
              ),
              'data-compact-log': '1',
            },
            h(CompactLogHead, {
              logPath: logPath,
              programName: picked !== undefined ? picked.name : '日志',
              logFileName: picked !== undefined && typeof picked.logPath === 'string' && picked.logPath !== ''
                ? String(picked.logPath).split('/').pop()
                : '',
              following: compactFollow,
              onToggleFollow: function () { setCompactFollow(function (value) { return !value }) },
              fontSize: compactFont,
              onFontDown: function () { bumpCompactFont(-1) },
              onFontUp: function () { bumpCompactFont(1) },
              maximized: maxed === 'log',
              onToggleMaximize: function () { toggleCompactMax('log') },
            }),
            logPath !== ''
              ? h(LogTail, {
                // A different file is a different viewer: remount it, exactly like
                // the IDE's log pane (`key: activePath`). Without the key the pane
                // kept the previous file's text while the title bar already showed
                // the new program, so a pick looked like it did nothing.
                key: logPath,
                scope: { sessionId: sessionId, cwd: cwd },
                path: logPath,
                // One source of truth for the follow switch, exactly like the IDE:
                // the header button drives `LogTail`, not the other way round.
                following: compactFollow,
                onFollowingChange: setCompactFollow,
                // The title bar owns the size; the body only renders text.
                fontSize: compactFont,
                // A parked log pane must not poll `/tail` either.
                visible: props.visible !== false && maxed !== 'console',
                // A start/stop that settled re-reads the tail once (see act()).
                reloadNonce: compactLogNonce,
              })
              : h('div', { style: S.compactEmpty }, '点上面的程序名，这里显示它的实时日志'))
        )
      }

      if (compact) return compactPanel()

      return h(ProgramWorkbench, {
        scope: { sessionId: sessionId, cwd: cwd },
        visible: true,
        programs: state.programs,
        // Workspace-level IDE: no single "current" program, so the top bar shows
        // the workspace path and the console lists every program.
        program: null,
        onSelectProgram: setActive,
        // The IDE top bar's ⚙/📄 buttons: generation lives in this panel (it owns
        // the scan/config state), so it is handed down rather than re-fetched.
        onConfig: {
          open: openConfig,
          generate: function () { generateConfigFile(configExists ? 'update' : undefined) },
          exists: configExists,
        },
        configNote: state.note,
        tab: {
          id: PROGRAM_TAB_ID,
          type: PROGRAM_TAB_ID,
          title: 'RIS-IDE',
          meta: { logPath: '', name: '工作空间' },
        },
      })

      var rows = state.programs.map(function (program) {
        var running = program.running
        var alive = running !== null && running !== undefined && running.alive === true
        var busy = busyId === program.id
        var kindLabel = program.kind === 'spring'
          ? 'Spring'
          : program.kind === 'frontend'
            ? '前端'
            : program.kind === 'manual'
              ? '配置'
              : '实例'
        var kindStyle = program.kind === 'spring' ? S.kindSpring : program.kind === 'frontend' ? S.kindFrontend : S.kindInstance
        var edited = program.fromConfig === true || program.overridden === true
        var meta = program.kind === 'spring'
          ? program.mainClass
          : program.kind === 'frontend'
            ? program.packageManager + ' run ' + program.script
            : program.relDir
        return h('div', { key: program.id, style: S.progRow, 'data-program': program.name, 'data-kind': program.kind },
          h('span', { style: alive ? S.instDotOn : S.instDotOff, title: alive ? '运行中' : '未运行' }, '●'),
          h('span', { style: S.instName, title: program.dir }, program.name,
            edited ? h('span', { style: S.editedMark, title: '来自 .dsh-ris-ide.json（可编辑/禁用/改启动参数）' }, '✎') : null),
          h('span', { style: kindStyle, title: program.kind }, kindLabel),
          h('span', { style: S.progWhere },
            h('span', { style: S.progRel, title: program.dir }, program.relDir),
            h('span', { style: S.progMeta, title: meta }, meta)),
          h('span', { style: S.spacer }),
          program.kind === 'instance'
            ? null
            : (alive
              ? h('button', { type: 'button', style: S.buttonOff, disabled: true, 'data-action': 'start' }, '启动')
              : h('button', {
                type: 'button', style: busy ? S.buttonDisabled : S.button, disabled: busy, 'data-action': 'start',
                title: '启动 ' + program.name,
                onClick: function () { act('start', program) },
              }, busy ? '…' : '▶')),
          alive
            ? h('button', {
              type: 'button', style: busy ? S.stopDisabled : S.stop, disabled: busy, 'data-action': 'stop',
              title: '停止 ' + program.name,
              onClick: function () { act('stop', program) },
            }, busy ? '…' : '■')
            : h('button', { type: 'button', style: S.buttonOff, disabled: true, 'data-action': 'stop' }, '停止'),
          program.kind === 'spring'
            ? h('button', {
              type: 'button', style: busy ? S.buttonDisabled : S.button, disabled: busy, 'data-action': 'debug',
              title: '调试：以 JDWP 模式重启并打开 IDE',
              onClick: function () { openWorkbench(program, true) },
            }, '调试')
            : null,
          h('button', {
            type: 'button', style: S.button, 'data-action': 'enter',
            title: '进入 IDE：文件树 / 源码（行号断点）/ 调试 / 实时日志',
            onClick: function () { openWorkbench(program, false) },
          }, '进入'),
        )
      })

      return h('div', { style: S.instWrap, 'data-panel': 'programs' },
        h('div', { style: S.bar },
          h('span', { style: S.status }, state.loading ? '扫描中…' : (state.programs.length + ' 个项目')),
          h('span', { style: S.meta, title: state.root }, state.root || ''),
          h('span', { style: S.spacer }),
          state.config !== undefined && state.config !== null && state.config.exists === true
            ? h('button', {
              type: 'button', style: S.button, 'data-action': 'open-config',
              title: '在侧边栏打开 ' + state.config.path + '（改完保存即可生效）',
              onClick: openConfig,
            }, '打开配置')
            : null,
          h('button', {
            type: 'button', style: S.button, disabled: busyId === '__config__', 'data-action': 'config',
            title: state.config !== undefined && state.config !== null && state.config.exists === true
              ? '按当前扫描结果更新配置：新增的程序补上、失效的自动条目删掉，你改过的字段与自定义程序保持不动'
              : '把扫描到的程序与启停参数写成 .dsh-ris-ide.json，之后由你维护',
            onClick: function () {
              var exists = state.config !== undefined && state.config !== null && state.config.exists === true
              generateConfigFile(exists ? 'update' : undefined)
            },
          }, busyId === '__config__'
            ? '写入中…'
            : (state.config !== undefined && state.config !== null && state.config.exists === true ? '更新配置' : '生成配置')),
          h('button', {
            type: 'button', style: S.button, disabled: state.loading, 'data-action': 'rescan',
            title: '重新扫描项目（发现结果缓存 15 秒）',
            onClick: function () { void refresh(true) },
          }, '重新扫描')),
        state.config !== undefined && state.config !== null && state.config.status === 'generated'
          && panelDismissals.isOpen('config-generated', 'generated:' + String(state.config.path))
          ? h(ClosableNotice, {
            styles: S, kind: 'config-generated', signature: 'generated:' + String(state.config.path), onDismiss: panelDismissals.dismiss,
          }, '已按扫描结果自动生成配置 ' + state.config.path + '（可编辑，保存后生效）')
          : null,
        state.config !== undefined && state.config !== null && state.config.status === 'updated'
          && panelDismissals.isOpen('config-updated', 'updated')
          ? h(ClosableNotice, {
            styles: S, kind: 'config-updated', signature: 'updated', onDismiss: panelDismissals.dismiss,
          }, '配置已与工作区同步（新增程序已补、失效条目已删；你改过的字段保留）')
          : null,
        state.config !== undefined && state.config !== null && state.config.drift !== undefined
          && state.config.drift !== null && state.config.drift.stale === true
          && panelDismissals.isOpen('drift', driftSignature(state.config.drift))
          ? h(ClosableNotice, {
            styles: S, kind: 'drift', signature: driftSignature(state.config.drift), onDismiss: panelDismissals.dismiss,
          },
            '配置与工作区不一致：',
            state.config.drift.added.length > 0 ? '新增 ' + state.config.drift.added.length + ' 个项目 ' : '',
            state.config.drift.missing.length > 0 ? '· 失效 ' + state.config.drift.missing.length + ' 条 ' : '',
            state.config.drift.changed.length > 0 ? '· 变更 ' + state.config.drift.changed.length + ' 条 ' : '',
            '⇒ 点「更新配置」（保留你改过的字段与自定义程序）')
          : null,
        state.note !== undefined && panelDismissals.isOpen('panel-note', String(state.note))
          ? h(ClosableNotice, {
            styles: S, kind: 'panel-note', signature: String(state.note), onDismiss: panelDismissals.dismiss,
          }, state.note)
          : null,
        state.error !== undefined && panelDismissals.isOpen('panel-error', String(state.error))
          ? h('div', { style: Object.assign({}, S.error, { display: 'flex', alignItems: 'center', gap: 6 }), role: 'alert' },
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, state.error),
            h('button', {
              type: 'button', style: Object.assign({}, S.buttonOff, { padding: '0 4px' }), 'data-notice-close': 'panel-error', title: '关闭这条提示',
              onClick: function () { panelDismissals.dismiss('panel-error', String(state.error)) },
            }, '×'))
          : null,
        rows.length > 0
          ? h('div', { style: S.instList }, rows)
          : h('div', { style: S.instEmpty }, state.loading
            ? '正在扫描项目…'
            : '没有发现可启动的项目（找 @SpringBootApplication 入口与 package.json 的 dev/start/serve 脚本）'))
    }

    var name = 'dsh-ris-ide'

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    // The standalone window (`/dsh-ris-ide/window`) loads this file directly and
    // mounts the panel itself; there is no DSH loader in that page.
    exports.mountStandalone = mountStandalone
    /** Test-only surface (the browser loader ignores unknown exports). */
    exports.__test = {
      VIEWER_ID: VIEWER_ID,
      INSTANCES_TAB_ID: INSTANCES_TAB_ID,
      // The standalone window: the header button, the popup helper and the
      // mount entry the window's own page calls (none of them needs DSH's ctx).
      RisIdeWindowAction: RisIdeWindowAction,
      openStandaloneWindow: openStandaloneWindow,
      mountStandalone: mountStandalone,
      fetchProgramById: fetchProgramById,
      WINDOW_NAME: WINDOW_NAME,
      standaloneWindowKey: standaloneWindowKey,
      standaloneWindowName: standaloneWindowName,
      STANDALONE_SESSION: STANDALONE_SESSION,
      openInstanceLog: openInstanceLog,
      requestStart: requestStart,
      generateConfig: generateConfig,
      drainOpenRequests: drainOpenRequests,
      ProgramWorkbench: ProgramWorkbench,
      ProgramsPanel: ProgramsPanel,
      IdeErrorBoundary: IdeErrorBoundary,
      PROGRAM_TAB_ID: PROGRAM_TAB_ID,
      // The compact sidebar shape: its default log-pane height (240px) and the
      // persisted reader the drag handle writes through.
      COMPACT_PANE_DEFAULT: COMPACT_PANE_DEFAULT,
      COMPACT_UI_KEY: COMPACT_UI_KEY,
      CompactLogHead: CompactLogHead,
      COMPACT_MAX_KEY: COMPACT_MAX_KEY,
      readCompactMax: readCompactMax,
      readCompactPaneHeight: readCompactPaneHeight,
      requestDebug: requestDebug,
      requestDebugs: requestDebugs,
      classNameFromPath: classNameFromPath,
      isNonExecutableJavaLine: isNonExecutableJavaLine,
      openProgramWorkbench: openProgramWorkbench,
      // The sidebar file API bridge: the `/sidebar/api` envelope unwrap and the
      // raw `/sidebar/write` route are load-bearing (an envelope bug once blanked
      // the whole tree), so they are directly testable.
      fsTree: fsTree,
      fsRead: fsRead,
      fsWrite: fsWrite,
      fsSearch: fsSearch,
      searchHitPayload: searchHitPayload,
      absolutePath: absolutePath,
      capOpenFiles: capOpenFiles,
      clampUiFont: clampUiFont,
      viewerFontCss: viewerFontCss,
      viewerThemeCss: viewerThemeCss,
      stylesFor: stylesFor,
      SearchResults: SearchResults,
      searchHitActiveIndex: searchHitActiveIndex,
      mergeGlobalBreakpoints: mergeGlobalBreakpoints,
      /** Test seam: seed the global breakpoint list (no host/session needed). */
      __setGlobalBreakpoints: function (list) { GLOBAL_BREAKPOINTS = Array.isArray(list) ? list : [] },
      globalBreakpointsSnapshot: globalBreakpointsSnapshot,
      displayWorkspacePath: displayWorkspacePath,
      selectedEditorText: selectedEditorText,
      debugSnapshotSuspended: debugSnapshotSuspended,
      debugSuspendedThreadId: debugSuspendedThreadId,
      readSavedUi: readSavedUi,
      treeLabel: treeLabel,
      childEntryFor: childEntryFor,
      sourceRelativeSuffix: sourceRelativeSuffix,
      parseGutterLine: parseGutterLine,
      driftSignature: driftSignature,
      capToasts: capToasts,
      capMessages: capMessages,
      dropMessage: dropMessage,
      formatClock: formatClock,
      /** Test seam: point the foreign-viewer/theme context at a stub. */
      __setPanelCtx: function (value) { panelCtx = value },
      TOAST_TTL_MS: TOAST_TTL_MS,
      treeIndent: treeIndent,
      OPEN_POLL_MS: OPEN_POLL_MS,
      PANEL_POLL_MS: PANEL_POLL_MS,
      POLL_MS: POLL_MS,
      debugPollDelay: debugPollDelay,
      canOpenLog: canOpenLog,
      debugShortcut: debugShortcut,
      docDirty: docDirty,
      pushRecent: pushRecent,
      searchHistoryEntries: searchHistoryEntries,
      fileMissing: fileMissing,
      SEARCH_RECENT_LIMIT: SEARCH_RECENT_LIMIT,
      tabMenuEntries: tabMenuEntries,
      bulkClosePlan: bulkClosePlan,
      TAB_MENU_LIMIT: TAB_MENU_LIMIT,
      headerDoubleClickIsTitle: headerDoubleClickIsTitle,
      copyText: copyText,
      fileBaseName: fileBaseName,
      trimLogToCurrentRun: trimLogToCurrentRun,
      remapPath: remapPath,
      duplicateName: duplicateName,
      helpSections: helpSections,
      ideIcon: ideIcon,
      ideBadgeIcon: ideBadgeIcon,
      trashDirFor: trashDirFor,
      trashNameFor: trashNameFor,
      TREE_TRASH_DIR: TREE_TRASH_DIR,
      changedLevelsToRefresh: changedLevelsToRefresh,
      sameTreeEntries: sameTreeEntries,
      treeListingFresh: treeListingFresh,
      treeRetryDelay: treeRetryDelay,
      globalFindShouldFocusSearch: globalFindShouldFocusSearch,
      isGlobalFindChord: isGlobalFindChord,
      GLOBAL_FIND_KEY: GLOBAL_FIND_KEY,
      GLOBAL_FIND_LABEL: GLOBAL_FIND_LABEL,
      shouldBlockHostChord: shouldBlockHostChord,
      isBrowserReloadChord: isBrowserReloadChord,
      inStandaloneIdeWindow: inStandaloneIdeWindow,
      closeTabChord: closeTabChord,
      DSH_CHORDS: DSH_CHORDS,
      chordOf: chordOf,
      findLogMatches: findLogMatches,
      treeErrorMessage: treeErrorMessage,
      TREE_LIST_TTL_MS: TREE_LIST_TTL_MS,
      TREE_REFRESH_THROTTLE_MS: TREE_REFRESH_THROTTLE_MS,
      fileKind: fileKind,
      fileKindColor: fileKindColor,
      normalizeFileName: normalizeFileName,
      newFilePath: newFilePath,
      javaFilePath: javaFilePath,
      packagePathOf: packagePathOf,
      isJavaSourceDir: isJavaSourceDir,
      NEW_FILE_TYPES: NEW_FILE_TYPES,
      fsMkdir: fsMkdir,
      fsCreateFile: fsCreateFile,
      fsCopyEntry: fsCopyEntry,
      fsMoveEntry: fsMoveEntry,
      fsRemoveEntry: fsRemoveEntry,
      shouldUseOfficialPreview: shouldUseOfficialPreview,
      supportsTextPreview: supportsTextPreview,
      trimLargeTextFront: trimLargeTextFront,
      renderMarkdown: renderMarkdown,
      previewAssetUrl: previewAssetUrl,
      renderMarkdownInline: renderMarkdownInline,
      parseClipboardPaths: parseClipboardPaths,
      fsUpload: fsUpload,
      fsImportPath: fsImportPath,
      officialPreviewAddress: officialPreviewAddress,
      openOfficialPreview: openOfficialPreview,
      selectProgram: selectProgram,
      revealScrollTop: revealScrollTop,
      formatMemory: formatMemory,
      heapHint: heapHint,
      TAIL_BYTES: TAIL_BYTES,
      PREF_WRAP: PREF_WRAP,
      PREF_FONT_SIZE: PREF_FONT_SIZE,
      MONO_FAMILY: MONO_FAMILY,
      DEFAULT_FONT_SIZE: DEFAULT_FONT_SIZE,
      routeUrl: routeUrl,
      readLog: readLog,
      readViaTailRoute: readViaTailRoute,
      readViaFsRead: readViaFsRead,
      requestStop: requestStop,
      stateFromPayload: stateFromPayload,
      countLines: countLines,
      formatBytes: formatBytes,
      metaText: metaText,
      levelColor: levelColor,
      parseLine: parseLine,
      parseLog: parseLog,
      ansiSegments: ansiSegments,
      applySgr: applySgr,
      clampFontSize: clampFontSize,
      serviceText: serviceText,
      tabStripWheelDelta: tabStripWheelDelta,
      tabStripOf: tabStripOf,
      attachTabStripWheel: attachTabStripWheel,
      LogTail: LogTail,
      IdeTextEditor: IdeTextEditor,
      IdeCodeMirror: IdeCodeMirror,
      IdeEditor: IdeEditor,
      loadRisIdeChunk: loadRisIdeChunk,
    }
    return module.exports
  },
})
