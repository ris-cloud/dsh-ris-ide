// The daemon's own maintenance page + the endpoints it needs.
//
// Why this exists: with daemonMode=auto the daemon may own the proxy engine, running
// programs (JVMs) and a JDWP session when no dsh is open. Without a page, "no dsh"
// would also mean "no way to stop anything" — the page is deliberately loopback-only
// and carries the token inline, because whoever can load it can read risd.json.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { startRisdProcess } from './risd-helpers.mjs'

let daemon
let workspace

function call(state, path, { method = 'GET', body, host, token } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers = Object.assign(
      { host: host ?? `127.0.0.1:${state.port}`, 'x-risd-api-version': '1' },
      token === null ? {} : { authorization: `Bearer ${token ?? state.token}` },
      payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    )
    const req = request({ host: '127.0.0.1', port: state.port, path, method, timeout: 8000, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        resolve({ status: res.statusCode, text, body: parsed })
      })
    })
    req.on('error', (error) => resolve({ status: 0, text: '', body: { error: String(error?.message) } }))
    if (payload !== '') req.write(payload)
    req.end()
  })
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'risd-ui-ws-'))
  mkdirSync(join(workspace, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(workspace, '.dsh-ris-ide', 'config.json'), `${JSON.stringify({
    version: 1,
    defaults: {},
    programs: [{
      id: 'demo', name: 'demo', kind: 'custom', dir: workspace, relDir: '.', project: '',
      logName: 'demo', logPath: join(workspace, 'logs', 'demo.log'), startCommand: 'true',
    }],
  }, null, 2)}\n`)
  mkdirSync(join(workspace, 'logs'), { recursive: true })
  writeFileSync(join(workspace, 'logs', 'demo.log'), 'hello\n')
  daemon = await startRisdProcess({ port: 0 })
})

after(async () => {
  await daemon?.stop()
  rmSync(workspace, { recursive: true, force: true })
})

test('the inline page script is syntactically valid', async () => {
  // A missing comma in the state literal used to kill the whole script, leaving
  // the page rendered but dead (every checkbox unchecked, no error visible).
  const page = await call(daemon.state, '/ui', { token: null })
  assert.equal(page.status, 200)
  const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length > 0, 'page has an inline script')
  for (const match of scripts) new Function(match[1]) // SyntaxError would fail the test
})

test('the IDE tab drops the toolbar and names workspaces by folder', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  const html = page.text
  assert.doesNotMatch(html, /ide-toolbar/, 'no toolbar row')
  assert.doesNotMatch(html, /新窗口打开/, 'no new-window button')
  assert.doesNotMatch(html, /id="ide-open"|id="ide-retry"|id="ide-hint"/)
  // The panel toggle moved into the header (icon only, fixed at the left); the
  // sidebar head and the floating expand chip are gone (m07956 ①).
  assert.match(html, /<header>\s*<button[^>]*id="ide-side-toggle"[^>]*>›<\/button>\s*<h1>risd<\/h1>/, 'header owns the panel toggle, left of the brand')
  assert.match(html, /class="side-toggle"/)
  assert.doesNotMatch(html, /ide-side-head|id="ide-side-show"|class="ide-expand"/)
  // The panel starts collapsed and remembers an explicit 'on' only (m08228).
  assert.match(html, /getItem\('risd\.ideSide'\) === 'on'/, 'the panel is collapsed unless the user expanded it')
  assert.doesNotMatch(html, /getItem\('risd\.ideSide'\) !== 'off'/)
  assert.match(html, /（未活跃）/, 'non-live workspaces stay listed and are labelled')
  assert.match(html, /id="ide-stale-close"/, 'the stale hint can be dismissed')
  assert.match(html, /state\.staleDismissed\[state\.cwd/, 'dismissal is remembered per workspace')
  assert.match(html, /toggle\.textContent = visible \? '‹' : '›'/, 'one control covers collapse and expand')
  assert.match(html, /toggle\.setAttribute\('aria-expanded'/)
  assert.match(html, /toggle\.disabled = el\('view-ide'\)\.hidden/, 'the toggle is inert outside the IDE pane')
  assert.match(html, /flex:0 0 208px/, 'workspace panel is a little narrower')
  // Page-code drift (m09693): a daemon module edit does NOT reach a reloaded page
  // (Node caches the module graph), so the page compares the stamp it was rendered
  // with against /v1/health's `loaded` (a restarted daemon => reload itself) and
  // `disk` (edited but not restarted => a restart hint, not a silent stale UI).
  assert.match(html, /id="ui-drift"/, 'the page owns a drift hint')
  // m11445: an empty banner wrapper still participates in the flex column gap, which
  // pushed the 概览 page 14px lower than 代理设置.
  assert.match(html, /#overview-banner:empty, #proxy-banner:empty \{ display:none; \}/, 'empty banners stop taking a gap slot')
  assert.match(html, /var PAGE_BUILD = /, 'the rendered page knows which code it runs')
  assert.match(html, /body\.uiBuild\.loaded !== PAGE_BUILD/, 'a restarted daemon is detected from the code stamp')
  assert.match(html, /build\.disk !== build\.loaded/, 'a rebuilt-but-not-restarted daemon is called out')
  // Review C3-P1-3: the banner says "refresh", it does not reload by itself (the
  // proxy rule table may be mid-edit), and a restarted daemon is noticed even when
  // its code did not change, because the page's token died with it.
  assert.match(html, /location\.reload\(\);\s*return;/, 'a stale page reloads itself')
  assert.match(html, /var safe = count === 0 && state\.proxyDirty !== true && state\.lifecycleDirty !== true/, 'reload never loses work')
  assert.match(html, /id="ui-drift-reload"/, 'the drift banner offers the refresh button')
  // m11421: 「插件版本已更新」时刷新按钮变成「重启并刷新」——光刷新只会再拿到
  // 旧代码（daemon 的模块图在内存里），所以按钮先 POST /v1/restart 再等新实例。
  assert.match(html, /var driftMode = 'reload';/, 'the banner remembers whether a restart is needed')
  assert.match(html, /插件版本已更新，点「重启并刷新」后生效/, 'a rebuilt daemon asks for restart+reload, not a bare reload')
  assert.match(html, /driftMode === 'restart' \? '重启并刷新' : '刷新'/, 'the action label follows the drift mode')
  assert.match(html, /api\('\/v1\/restart', \{ method: 'POST' \}\)/, 'the button restarts the daemon through its endpoint')
  assert.match(html, /body\.instance !== previous/, 'the page waits for a new daemon instance before reloading')
  assert.match(html, /function restartDaemonThenReload/, 'restart+reload saves the IDE buffers first')
  assert.match(html, /if \(driftMode === 'restart'\) \{ restartDaemon\(\); return; \}/, 'save-all continues into the restart')
  // m10900: the tabs are 开发环境 / 代理设置, the reload path asks the embedded IDE
  // whether anything is unsaved, and the banner can save all of it first.
  assert.match(html, /data-tab="ide" aria-selected="false">开发环境</, 'the IDE tab is called 开发环境')
  assert.match(html, /data-tab="proxy" aria-selected="false">代理设置</, 'the proxy tab is called 代理设置')
  assert.match(html, /id="ui-drift-save"/, 'the drift banner can offer 保存所有文件')
  assert.match(html, /function askIdeDirty/, 'the page asks the iframe instead of guessing')
  assert.match(html, /dsh-ris-ide:probe-dirty/, 'the probe has a named protocol')
  assert.match(html, /dsh-ris-ide:save-all/, 'the save-all request has a named protocol')
  assert.match(html, /function setDriftSave/, 'the save-all button appears only when something is unsaved')
  // m10900: a shortcut/toolbar reload keeps the tab and the workspace.
  assert.match(html, /var TAB_STORAGE = 'risd\.tab'/, 'the last tab lives under one storage key')
  assert.match(html, /localStorage\.getItem\(TAB_STORAGE\)/, 'the last tab is restored')
  assert.match(html, /localStorage\.setItem\(TAB_STORAGE, name\)/, 'switching tabs remembers the new one')
  assert.match(html, /PAGE_INSTANCE = /, 'the page knows which daemon process rendered it')
  assert.match(html, /body\.instance !== PAGE_INSTANCE/, 'a restarted daemon invalidates the page token')
  assert.match(html, /PAGE_BUILD && body\.uiBuild && body\.uiBuild\.loaded && body\.uiBuild\.loaded !== PAGE_BUILD/, 'a rebuilt daemon is noticed too')
  assert.match(html, /status === 401 && driftMessage\.indexOf\('未保存'\)/, 'a dead token is surfaced instead of failing silently, without clobbering the unsaved-buffers message')
  assert.match(html, /state\.proxyDirty === true && window\.confirm\('代理规则还没保存，刷新会丢失'\)/, 'unsaved rules are protected')
  assert.match(html, /state\.proxyDirty = true/, 'editing the rule table marks it dirty')
  // Review C3-P2-9/P2-12: an unset SOCKS host is "未配置" (neutral), not a red
  // failure; a failed download keeps the manual URLs. m10585: once installed the
  // card only reports the file count — no download/upload buttons.
  assert.match(html, /result\.configured === false/, 'no SOCKS host is a neutral state')
  assert.match(html, /lastBundleUrls/, 'the card remembers the mirror URLs across renders')
  assert.match(html, /button\.hidden = installed/, 'an installed bundle hides the download button')
  assert.match(html, /upload\.hidden = installed/, 'an installed bundle hides the upload button')
  assert.match(html, /'已安装 · 文件 ' \+ \(status\.files \|\| \[\]\)\.length \+ ' 个'/, 'the card reports the file count only')
  // ProxyBridge bundle card (m09120 ③): download-on-demand, upload fallback, URL shown.
  assert.match(html, /id="bridge-download"/, 'the proxy tab offers a download button')
  assert.match(html, /id="bridge-upload"/, 'a failed download can be replaced by a manual upload')
  assert.match(html, /function uploadBundle/, 'the upload posts the picked file')
  assert.match(html, /\/v1\/proxybridge\/upload/, 'the upload route is called')
  assert.match(html, /loadBundle\(\)/, 'the card refreshes with the tab, not once at load')
  // Component health (m11828/m11838/m11863): files + runnable per side, probed only
  // while the engine runs; a bridge left intercepting without the engine is a fault.
  assert.match(html, /id="bridge-health-pill"/, 'the card carries a health pill')
  assert.match(html, /id="bridge-health-text"/, 'health is a single line, not a per-side table (m12313)')
  assert.doesNotMatch(html, /bridge-health-recheck/, 'no manual re-check button: the card polls (m12313)')
  assert.doesNotMatch(html, /bridge-health-list/, 'no per-side file/version list (m12313)')
  assert.doesNotMatch(html, /function sideHealthLine/, 'sides are folded into one sentence')
  assert.match(html, /\/v1\/proxybridge\/health/, 'the health route is called')
  assert.match(html, /setInterval\(function \(\) \{ void loadHealth\(false\) \}, 10000\)/, 'health is re-checked on a timer (m12313)')
  assert.match(html, /function syncHealthTimer/, 'the timer follows tab visibility')
  assert.match(html, /\.then\(function \(\) \{ return loadHealth\(true\); \}\)/, 'a toggle re-probes health (engine state changed)')
  assert.match(html, /代理引擎已停止，系统层拦截仍在运行/, 'engine stopped + bridge running is called out')
  assert.match(html, /function stopStrayBridge/, 'the stray bridge can be stopped from the card')
  assert.match(html, /id="bridge-fix" hidden/, 'the card owns the single enforcement button (m13910)')
  assert.match(html, /function fixBridge/, 'the attempt reports sudo/pkexec outcome in the banner')
  assert.match(html, /el\('bridge-fix'\)\.onclick = fixBridge/)
  assert.match(html, /function paintBridgeFix/, 'state decides the label: start vs restart')
  assert.match(html, /interactive: true/, 'only a click may raise the elevation prompt')
  // m05590: "启动引擎" must not raise a password dialog. Elevation is its own click
  // (the component card's 「启动系统层拦截」), so the engine button carries no flag.
  const fixBridgeAt = html.indexOf('function fixBridge()')
  const engineToggleAt = html.indexOf('function toggleProxyEngine()')
  assert.ok(fixBridgeAt > 0 && engineToggleAt > fixBridgeAt, 'both click handlers are present')
  assert.match(html.slice(fixBridgeAt, engineToggleAt), /interactive: true/, 'the elevation click is the one that asks for a password')
  const engineBlock = html.slice(engineToggleAt, html.indexOf("el('engine-toggle').onclick", engineToggleAt))
  assert.ok(engineBlock.length > 0, 'the engine toggle block is bounded')
  assert.doesNotMatch(engineBlock, /interactive/, 'starting or stopping the engine never passes interactive (m05590)')
  assert.match(html, /button\.textContent = running \? '停止' : '启动引擎'/, 'the button says it starts the engine, not the whole stack')
  assert.doesNotMatch(html, /proxy-start-with-dsh/, 'the follow-dsh lifecycle checkbox is the only policy (m13950)')
  assert.match(html, /dsh 接入时启动引擎/, 'the lifecycle row describes both halves of following dsh')
  // The elevation note lives in the component card and clears itself (m12923).
  assert.match(html, /id="bridge-elevate-note"/, 'the component card owns the elevation note')
  assert.match(html, /function renderElevateNote\(health\)/)
  assert.match(html, /elevations\[side\] && elevations\[side\]\.active === true/)
  assert.match(html, /note\.seenActive === true && active === false/)
  assert.match(html, /stray\.linux === true \|\| stray\.windows === true/, 'stray is decided per side')
  assert.match(html, /applicable !== false/, 'only sides that exist on this host are described')
  assert.match(html, /id="bridge-health-more"/, 'the long explanation is collapsed under 说明 (m12508)')
  assert.match(html, /已降级/, 'a missing side is described as degraded, not as an error')
  assert.match(html, /degrade\.command/, 'the details name the sudo command even with no start attempt (m12359)')
  assert.match(html, /degrade\.jvmArgs/, 'the details explain the JVM/env fallback (m12486)')
  assert.match(html, /degrade\.git/, 'git is part of the degraded path too (m12567)')
  assert.match(html, /程序名称\/路径/, 'the first rule column is the program name or path (m12163)')
  assert.match(html, /拦截未启动/, 'engine up without interception is a transient state, not a green check (m12046)')
  // SOCKS reachability chip (m09120 ②): the proxy row shows live connectivity.
  assert.match(html, /id="proxy-ping"/, 'the SOCKS row carries a status chip')
  assert.match(html, /function refreshPing/, 'the chip is refreshed, not written once')
  assert.match(html, /setInterval\(refreshPing, 10000\)/, 'probing is periodic')
  assert.match(html, /queuePing/, 'editing host/port re-probes before saving')
  assert.match(html, /function workspaceLabel/, 'one label helper decides what a workspace is called')
  assert.match(html, /typeof win\.title === 'string'/, 'the dsh sidebar title wins when the host resolved one (m13800)')
  assert.match(html, /function workspacePathLabel/, 'the folder name stays as the fallback for an older host')
  assert.match(html, /\|' \+ \(typeof win\.title === 'string' \? win\.title : ''\)/, 'a rename alone must repaint the panel')
  assert.match(html, /parts\.slice\(-2\)\.join\('\/'\)/, 'collisions use the parent folder')
  assert.match(html, /focusIdeFrame\(\)/, 'outside clicks send focus back into the iframe')
})

test('re-opening the IDE tab keeps the iframe document (unsaved edits survive)', async () => {
  // Review C-P0-1: showTab('ide') used to call loadIde(), which wiped ide-body and
  // rebuilt the iframe — silently losing unsaved editor content, the debugger
  // selection and the scroll position on the most common interaction ("look at the
  // proxy tab, come back").
  const page = await call(daemon.state, '/ui', { token: null })
  assert.match(page.text, /function refreshIdeWindows\(\)/)
  assert.match(page.text, /if \(frame\.getAttribute\('src'\) !== url\) frame\.src = url/)
  assert.match(page.text, /if \(name === 'ide'\) \{ if \(el\('ide-frame'\)\) refreshIdeWindows\(\); else loadIde\(\); \}/)
  assert.match(page.text, /function ensureIdeFrame\(\)/)
  // The rebuild of #ide-body is exactly what must not happen any more.
  assert.doesNotMatch(page.text, /el\('ide-body'\)\.innerHTML = ''/)
})

test('the proxy tab edits global rules without a workspace picker', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  const html = page.text
  assert.doesNotMatch(html, /id="proxy-cwd"/, 'rules are machine-wide: no workspace input')
  assert.match(html, /全局规则：按机器生效、不区分工作区/)
  assert.doesNotMatch(html, /id="bridge-restart"/, 'the merge moved the restart into the component card (m13910)')
  assert.match(html, /为什么要重启/, 'its tooltip explains the reason')
  assert.match(html, /setBridgeStale/)
  assert.match(html, /bridgeStaleReason/, 'the stale reason is state, not a hidden input')
  assert.match(html, /保存不会启动它/, 'a save names the start button instead of starting the engine')
})

test('the overview stop button is just 停止', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  assert.match(page.text, /id="daemon-stop">停止</)
  assert.doesNotMatch(page.text, /停止 daemon</)
})

test('the proxy tab reports the restart result and keeps a 409 visible', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  // C-P1-3: the action result is nested under `result`; reading the envelope made
  // every successful restart look like "需要提权".
  assert.match(page.text, /var result = \(response && response\.result\) \|\| \{\}/)
  // C-P1-4: reload first, then show the conflict (the reload rewrites the banner).
  assert.match(page.text, /if \(error\.status === 409\) \{[\s\S]{0,900}loadProxyTab\(\)\.then/)
  // A 409 caused by our own in-flight write retries once instead of showing the
  // user a conflict they cannot resolve (m10304 auto-save serialisation).
  assert.match(page.text, /options\.retried !== true/)
  assert.match(page.text, /saveRules\(\{ auto: auto, retried: true \}\)/)
})

test('values that reach the markup are escaped, including pill/banner classes (review C-P2-4)', async () => {
  // rule.source comes from proxy.json, which any plugin/editor can write; it lands in
  // a class attribute on a page that carries the daemon token.
  const page = await call(daemon.state, '/ui', { token: null })
  assert.match(page.text, /function pill\(text, cls\) \{ return '<span class="pill ' \+ esc\(cls \|\| ''\) \+ '">' \+ esc\(text\) \+ '<\/span>'; \}/)
  assert.match(page.text, /var shape = kind === 'err' \|\| kind === 'warn' \|\| kind === 'ok' \? kind : 'warn';/)
  assert.match(page.text, /'<div class="banner ' \+ shape \+ '">' \+ esc\(text\) \+ '<\/div>'/)
})

test('the log tail and the window poll only run where they are seen (review C-P2-3)', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  // The 2 s tail follows the pane, the tab and the visibility, not just the toggle.
  assert.match(page.text, /function syncLogTimer\(\)/)
  assert.match(page.text, /var wanted = state\.logOn === true && state\.tab === 'proxy' && document\.hidden !== true;/)
  assert.match(page.text, /document\.addEventListener\('visibilitychange', function \(\) \{ syncLogTimer\(\); syncPingTimer\(\); syncHealthTimer\(\); \}\)/)
  // The 4 s poll skips the proxy tab (it does not read the window list) and a hidden page.
  assert.match(page.text, /if \(state\.tab === 'ide' \|\| state\.tab === 'overview'\) syncDshTab\(\);/)
  assert.doesNotMatch(page.text, /if \(!document\.hidden\) syncDshTab\(\);/)
  // Typing into the lifecycle form must not be undone by the refresh loop.
  assert.match(page.text, /if \(state\.lifecycleDirty === true\) return Promise\.resolve\(state\.lifecycle \|\| null\);/)
  assert.match(page.text, /el\('lifecycle-rows'\)\.addEventListener\('change'/)
  assert.match(page.text, /state\.lifecycleDirty = false;/)
})

test('the embedded IDE gets its own window-lock name (review C-P2-6)', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  // A fixed name made the rebuilt iframe race the previous document's Web Lock and
  // flash 「RIS-IDE 已在另一个窗口打开」 — and the standalone window's own name was the
  // same string, so the two could take each other's lock.
  assert.match(page.text, /var IDE_WNAME = 'risd-ide-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 8\);/)
  assert.match(page.text, /'&wname=' \+ encodeURIComponent\(IDE_WNAME\)/)
  assert.doesNotMatch(page.text, /&wname=risd-ide'/)
})

test('a disabled IDE tab is refused before the view is shown (review C-P2-9)', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  // The old order made #view-ide visible and then returned on the disabled tab.
  const body = page.text.slice(page.text.indexOf('function showTab(name)'))
  const guard = body.indexOf("if (ideTab && ideTab.disabled) return")
  const assignment = body.indexOf('state.tab = name;')
  assert.ok(guard > 0 && assignment > guard, 'the disabled check must come before state.tab/visibility')
})

test('a failed engine stop explains itself on the overview (review C-P2-8)', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  assert.match(page.text, /id="overview-banner"/)
  assert.match(page.text, /\(running \? '停止' : '启动'\) \+ '代理引擎失败：' \+ error\.message/)
  // The toggle names the retry and the escape hatch instead of a bare alert().
  assert.match(page.text, /可以再点一次重试；仍不行就停掉守护进程/)
})

test('GET /v1/proxy works without a cwd (the rule table is machine-wide)', async () => {
  const response = await call(daemon.state, '/v1/proxy')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.ok(Array.isArray(response.body.rules), 'rules come back even when no workspace is named')
})

test('the overview offers lifecycle settings for daemon, proxy, programs and debug', async () => {
  const page = await call(daemon.state, '/ui', { token: null })
  assert.equal(page.status, 200)
  assert.match(page.text, /生命周期/)
  // Toggling is the save (m13960): no button, no second confirmation step.
  assert.doesNotMatch(page.text, /id="lifecycle-save"/)
  assert.match(page.text, /勾选即自动保存/)
  assert.match(page.text, /el\('lifecycle-rows'\)\.addEventListener\('change', scheduleLifecycleSave\)/)
  assert.match(page.text, /function scheduleLifecycleSave\(\)/)
  assert.match(page.text, /function saveLifecycle\(auto\)/)
  assert.match(page.text, /已自动保存/)
  // A toggle that lands mid-POST must not be undone by refilling the form from the
  // daemon's (older) answer: the queued save carries it instead.
  assert.match(page.text, /var queued = lifecycleQueued === true;/)
  assert.match(page.text, /queued === true \? Promise\.resolve\(\) : loadLifecycle\(\)/)
  assert.equal(page.text.includes('followDaemon'), false, 'following the daemon is forced, not configurable')
  // Two switches per row (m03397): the start half and the stop half answer different
  // questions, so they are separate checkboxes with their own column.
  for (const key of ['daemon.startWithDsh', 'daemon.stopWithDsh', 'proxy.startWithDsh', 'proxy.stopWithDsh',
    'programs.startWithDsh', 'programs.stopWithDsh', 'debug.startWithDsh', 'debug.stopWithDsh']) {
    assert.ok(page.text.includes(`data-life="${key}"`), `missing checkbox ${key}`)
  }
  assert.match(page.text, /跟随 dsh 启动/)
  assert.match(page.text, /跟随 dsh 停止/)
  // The forced daemon start is checked and disabled; a debug session has nothing to
  // auto-start, so its start cell is disabled too.
  assert.match(page.text, /data-life="daemon\.startWithDsh" checked disabled/)
  assert.match(page.text, /data-life="debug\.startWithDsh" disabled/)
  // The retired sentence about the daemon being forced is gone from the page.
  assert.equal(/所有资源强制跟随 daemon/.test(page.text), false)
  // A disabled half is not part of the payload (the server rejects unknown halves).
  assert.match(page.text, /if \(box\.disabled === true\) return;/)
  assert.match(page.text, /loadLifecycle/)
  assert.match(page.text, /v1\/config/)
})

test('the maintenance page is served to loopback and carries the token inline', async () => {
  const res = await call(daemon.state, '/ui', { token: null })
  assert.equal(res.status, 200)
  assert.match(res.text, /risd — 本机代理与程序维护/)
  assert.ok(res.text.includes(daemon.state.token), 'the page must carry the token it uses for its own calls')
  for (const title of ['概览', '代理', 'IDE', '守护进程', '代理运行状态', '运行中的项目', '调试中的进程', '规则表']) {
    assert.ok(res.text.includes(title), `missing section: ${title}`)
  }
  // The header is just "risd" + centered tabs (IDE · 代理 · 概览): the daemon
  // status moved into the overview row, so no meta text is left up there.
  assert.doesNotMatch(res.text, /id="meta"/, 'no status text in the header')
  assert.match(res.text, /<nav role="tablist"[^>]*>\s*<button role="tab" data-tab="ide"/, 'IDE is the first tab')
  assert.ok(res.text.indexOf('data-tab="ide"') < res.text.indexOf('data-tab="proxy"'), 'IDE before 代理')
  assert.ok(res.text.indexOf('data-tab="proxy"') < res.text.indexOf('data-tab="overview"'), '代理 before 概览')
  // IDE is full-bleed (no card padding) and has a collapsible workspace panel.
  assert.match(res.text, /\.view\[hidden\] \{ display:none !important; \}/)
  assert.match(res.text, /id="ide-side"/)
  assert.match(res.text, /id="ide-side-toggle"/)
  assert.match(res.text, /id="view-ide" hidden>\s*<div class="ide-layout">/, 'IDE view is a layout, not a card')
  // The page still accepts ?tab= (deep links/tests); switching workspace moves focus into the iframe.
  assert.match(res.text, /get\('tab'\)/)
  assert.match(res.text, /frame\.focus\(\)/)
  // One engine button whose label is the next action (m10585): 启动 while down,
  // 停止 while it runs. The old pair of buttons is gone.
  assert.match(res.text, /id="engine-toggle" disabled>启动/, 'the overview can start the engine')
  assert.match(res.text, /id="proxy-engine-toggle" disabled>启动/, 'the proxy tab has the same toggle')
  assert.match(res.text, /engineToggle\.textContent = running \? '停止' : '启动'/)
  // Starting can wait on sudo/UAC for seconds: the button says which half is running
  // and refuses a second click instead of looking dead (m11279).
  assert.match(res.text, /var engineBusy = false;/)
  assert.match(res.text, /if \(engineBusy\) return;/)
  assert.match(res.text, /button\.setAttribute\('aria-busy', 'true'\)/)
  assert.match(res.text, /engineBusyAction === 'stop' \? '停止中…' : '启动中…'/)
  assert.match(res.text, /button\.removeAttribute\('aria-busy'\)/)
  assert.match(res.text, /if \(engineBusy\) \{\s+paintEngineButtons\(\);/, 'the 4s refresh must not repaint over the busy label')
  assert.match(res.text, /button\[aria-busy="true"\] \{ opacity:\.7; cursor:progress; \}/)
  assert.doesNotMatch(res.text, /id="engine-start"/, 'the separate start button is gone')
  assert.doesNotMatch(res.text, /id="engine-stop"/, 'the separate stop button is gone')
  // The rule table has no 读取/保存 buttons: editing is the save (m10585).
  assert.doesNotMatch(res.text, /id="proxy-reload"/)
  assert.doesNotMatch(res.text, /id="proxy-save"/)
  // Stopping the daemon is an overview row now, not a header button: the header
  // only carries the tabs.
  assert.match(res.text, /id="daemon-stop"/, 'the daemon row owns the stop button')
  assert.doesNotMatch(res.text, /id="shutdown"/, 'no header-level close button any more')
})

test('the maintenance page refuses a non-loopback Host header (DNS rebinding)', async () => {
  const res = await call(daemon.state, '/ui', { token: null, host: 'evil.example.com' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'forbidden')
})

test('the API refuses a foreign Host or Origin (no DNS rebinding / CORS)', async () => {
  const rebinding = await call(daemon.state, '/v1/health', { token: null, host: 'evil.example.com' })
  assert.equal(rebinding.status, 403)
  // Same loopback Host, but a page on another origin is probing the port.
  const crossOrigin = await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: daemon.state.port, path: '/v1/health', timeout: 5000,
      headers: { host: `127.0.0.1:${daemon.state.port}`, origin: 'https://evil.example.com' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', () => resolve(0))
    req.end()
  })
  assert.equal(crossOrigin, 403)
})

test('GET /v1/dsh keeps quiet workspaces and marks them non-live (m08268)', async () => {
  const file = join(daemon.home, 'dsh-window.json')
  writeFileSync(file, `${JSON.stringify({ windows: [
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-a', sessionId: 's-a', at: new Date().toISOString() },
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-b', sessionId: 's-b', at: new Date(Date.now() - 10 * 60_000).toISOString() },
    { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-old', sessionId: 's-old', at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() },
  ] })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.equal(res.status, 200)
  assert.equal(res.body.available, true)
  // The 60s-old workspace stays selectable, the month-old one is pruned.
  assert.deepEqual(res.body.windows.map((row) => row.cwd), ['/tmp/ws-a', '/tmp/ws-b'])
  assert.deepEqual(res.body.windows.map((row) => row.live), [true, false])
  assert.equal(res.body.windows[0].sessionId, 's-a')
  assert.equal(res.body.url, 'http://127.0.0.1:3080')
})

test('GET /v1/dsh greys the IDE tab out when no window is live', async () => {
  writeFileSync(join(daemon.home, 'dsh-window.json'), `${JSON.stringify({ windows: [] })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.equal(res.status, 200)
  assert.equal(res.body.available, false)
  assert.match(String(res.body.reason), /dsh 未运行/)
})

test('a sidebar snapshot with no remembered window still enables the IDE (m00186)', async () => {
  // The plugin now publishes the sidebar (titles + sessions + origin) on its refresh
  // tick even when dsh never served the IDE panel, so `windows` can legitimately be
  // empty while the document proves dsh is alive. The page must offer every workspace
  // instead of greying the tab out — switching workspaces is exactly what it is for.
  const now = new Date().toISOString()
  writeFileSync(join(daemon.home, 'dsh-window.json'), `${JSON.stringify({
    windows: [],
    workspaces: [
      { cwd: '/tmp/ws-a', title: 'alpha', sessionId: 's-a', active: true },
      { cwd: '/tmp/ws-b', title: 'beta', sessionId: '', active: false },
    ],
    url: 'http://127.0.0.1:3080',
    at: now,
  })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.equal(res.status, 200)
  assert.equal(res.body.available, true, 'the sidebar snapshot is proof dsh is running')
  assert.deepEqual(res.body.windows.map((row) => [row.cwd, row.title, row.live]), [
    ['/tmp/ws-a', 'alpha', true],
    ['/tmp/ws-b', 'beta', true],
  ], 'both workspaces are selectable, in the sidebar order')
  assert.deepEqual(res.body.windows.map((row) => row.source), ['workspace', 'workspace'])
  assert.equal(res.body.windows[0].sessionId, 's-a')
  assert.equal(res.body.windows[1].sessionId, '', 'no session → the window page boots on the cwd')
  assert.deepEqual(res.body.windows.map((row) => row.active), [true, false], 'a workspace without a live session is still listed')
  assert.equal(res.body.url, 'http://127.0.0.1:3080')
})

test('the unavailable hint no longer asks the user to open the IDE panel first (m00186)', async () => {
  // The old note told the user to open the RIS-IDE panel once — that request was the
  // write which happened to seed dsh-window.json. The refresh tick publishes the
  // sidebar by itself now, so promising it would be misleading.
  const page = await call(daemon.state, '/ui', { token: null })
  assert.match(page.text, /启动 dsh（工作区在 dsh 侧栏里）后，这里会自动可用/)
  assert.doesNotMatch(page.text, /打开一次 RIS-IDE 面板/)
})

test('a workspace without a live session stays selectable, labelled 无会话 (m00186)', async () => {
  // Switching workspaces is what the panel is for. A dsh workspace whose session is
  // gone still opens: the window page boots on the cwd when it cannot resolve the
  // session, so the row must not be hidden or disabled.
  const probe = await pageProbe()
  const windows = [
    { cwd: '/tmp/ws-a', title: 'alpha', sessionId: 's-a', url: 'http://127.0.0.1:3080', live: true, active: true },
    { cwd: '/tmp/ws-b', title: 'beta', sessionId: '', url: 'http://127.0.0.1:3080', live: true, active: false },
  ]
  probe.page.renderIde(windows, windows[0])
  const list = probe.el('ide-ws-list').innerHTML
  assert.match(list, /data-cwd="\/tmp\/ws-a"/, 'the live workspace is a button')
  assert.match(list, /data-cwd="\/tmp\/ws-b"/, 'the sessionless workspace is a button too')
  assert.match(list, /alpha/)
  assert.match(list, /beta（无会话）/, 'the label says why it may not resume')
  assert.match(probe.el('ide-frame').src, /cwd=%2Ftmp%2Fws-a&sessionId=s-a/)
  // Selecting the sessionless row must still produce a loadable window URL.
  probe.page.selectIdeWindow(windows, '/tmp/ws-b')
  const src = probe.el('ide-frame').src
  assert.match(src, /cwd=%2Ftmp%2Fws-b/, 'boots on the cwd')
  assert.doesNotMatch(src, /sessionId=/, 'no session to name: the host resolves the cwd instead')
})

test('the unavailable hint names the workspaces dsh did report (m00186)', async () => {
  const probe = await pageProbe()
  probe.page.ideUnavailable({ reason: 'dsh 正在启动', knownWorkspaces: 3 })
  const html = probe.el('ide-msg').innerHTML
  assert.match(html, /IDE 不可用：dsh 正在启动/)
  assert.match(html, /已发现 3 个 dsh 工作区/, 'a count separates "starting" from "not installed"')
  // No count → no dangling parenthesis when the host reported nothing at all.
  probe.page.ideUnavailable({ reason: 'dsh 未运行' })
  assert.doesNotMatch(probe.el('ide-msg').innerHTML, /已发现/)
})

test('GET /v1/dsh mirrors the dsh sidebar: every workspace, labelled by its title (m13800)', async () => {
  // The plugin writes the sidebar snapshot next to the remembered windows. A workspace
  // nobody opened the IDE for still belongs on the page, in the sidebar's own order,
  // and the label is the dsh title — which is exactly what a rename changes.
  const now = new Date().toISOString()
  writeFileSync(join(daemon.home, 'dsh-window.json'), `${JSON.stringify({
    windows: [
      { url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-a', sessionId: 's-a', title: 'alpha', at: now },
    ],
    workspaces: [
      { cwd: '/tmp/ws-a', title: 'alpha', sessionId: 's-a' },
      { cwd: '/tmp/ws-b', title: 'beta', sessionId: '' },
    ],
    url: 'http://127.0.0.1:3080',
    at: now,
  })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.equal(res.status, 200)
  assert.equal(res.body.available, true)
  assert.deepEqual(res.body.windows.map((row) => [row.cwd, row.title, row.live]), [
    ['/tmp/ws-a', 'alpha', true],
    ['/tmp/ws-b', 'beta', true],
  ], 'sidebar order wins and both rows are selectable')
  assert.equal(res.body.windows[1].source, 'workspace', 'a workspace without a window is not a remembered window')
  assert.equal(res.body.windows[1].url, 'http://127.0.0.1:3080', 'the document origin carries it')
  assert.equal(res.body.url, 'http://127.0.0.1:3080')
})

test('GET /v1/dsh re-labels a renamed workspace without losing it (m13800)', async () => {
  // Rename = title change only: the path is the identity, so the same row comes back
  // with the new label — the page must not fall back to the folder name.
  const now = new Date().toISOString()
  writeFileSync(join(daemon.home, 'dsh-window.json'), `${JSON.stringify({
    windows: [{ url: 'http://127.0.0.1:3080', cwd: '/srv/apps/dzjg/workspace', sessionId: 's-a', title: 'dzjg-new', at: now }],
    workspaces: [{ cwd: '/srv/apps/dzjg/workspace', title: 'dzjg-new', sessionId: 's-a' }],
    url: 'http://127.0.0.1:3080',
    at: now,
  })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.equal(res.body.windows.length, 1)
  assert.equal(res.body.windows[0].cwd, '/srv/apps/dzjg/workspace', 'the path is untouched')
  assert.equal(res.body.windows[0].title, 'dzjg-new')
})

test('GET /v1/dsh drops a stale sidebar snapshot but keeps fresh windows (m13800)', async () => {
  // The snapshot is only good while its writer is alive: 8 days after the last answer
  // the workspace list is gone, while the remembered window follows its own TTL.
  const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString()
  writeFileSync(join(daemon.home, 'dsh-window.json'), `${JSON.stringify({
    windows: [{ url: 'http://127.0.0.1:3080', cwd: '/tmp/ws-a', sessionId: 's-a', title: 'alpha', at: new Date().toISOString() }],
    workspaces: [{ cwd: '/tmp/ws-a', title: 'alpha' }, { cwd: '/tmp/ws-gone', title: 'gone' }],
    url: 'http://127.0.0.1:3080',
    at: old,
  })}\n`)
  const res = await call(daemon.state, '/v1/dsh')
  assert.deepEqual(res.body.windows.map((row) => row.cwd), ['/tmp/ws-a'])
})

test('the API is still authenticated (the page just carries the token)', async () => {
  const res = await call(daemon.state, '/v1/workspaces', { token: null })
  assert.equal(res.status, 401)
})

test('workspaces the daemon has served are offered to the page', async () => {
  const before = await call(daemon.state, '/v1/workspaces')
  assert.ok(Array.isArray(before.body.workspaces))
  const status = await call(daemon.state, `/v1/status?cwd=${encodeURIComponent(workspace)}`)
  assert.equal(status.status, 200)
  const after = await call(daemon.state, '/v1/workspaces')
  assert.ok(after.body.workspaces.includes(workspace), `expected ${workspace} in ${JSON.stringify(after.body.workspaces)}`)
})

test('the proxy log tail is readable (empty when the engine never ran)', async () => {
  const res = await call(daemon.state, '/v1/proxy/log?bytes=4096')
  assert.equal(res.status, 200)
  assert.match(res.body.path, /proxy-forward\.log$/)
  assert.equal(typeof res.body.text, 'string')
})

test('debug status works for a stopped program and breakpoints persist on disk', async () => {
  const status = await call(daemon.state, '/v1/debug', {
    method: 'POST',
    body: { action: 'status', cwd: workspace, id: 'demo' },
  })
  assert.equal(status.status, 200)
  assert.equal(status.body.program.id, 'demo')
  assert.equal(status.body.attached, false)

  const added = await call(daemon.state, '/v1/debug', {
    method: 'POST',
    body: { action: 'breakpoint-add', cwd: workspace, id: 'demo', className: 'cn.com.ris.Demo', line: 42, sessionId: 's1' },
  })
  assert.equal(added.status, 200)
  assert.equal(added.body.pending, true)

  const listed = await call(daemon.state, '/v1/debug', {
    method: 'POST',
    body: { action: 'breakpoints', cwd: workspace, id: 'demo' },
  })
  assert.equal(listed.body.breakpoints.length, 1)
  assert.equal(listed.body.breakpoints[0].className, 'cn.com.ris.Demo')

  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(daemon.state.home, 'risd-debug.json'), 'utf8'))
  const entries = Object.values(saved.breakpoints).flat()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].line, 42)

  const sessions = await call(daemon.state, '/v1/debug', { method: 'POST', body: { action: 'sessions' } })
  assert.equal(sessions.status, 200)
  assert.ok(Array.isArray(sessions.body.sessions))
})

test('unknown programs and unknown actions are reported, not swallowed', async () => {
  const unknown = await call(daemon.state, '/v1/debug', {
    method: 'POST',
    body: { action: 'status', cwd: workspace, id: 'nope' },
  })
  assert.equal(unknown.status, 404)
  const bad = await call(daemon.state, '/v1/debug', {
    method: 'POST',
    body: { action: 'warp', cwd: workspace, id: 'demo' },
  })
  assert.equal(bad.status, 400)
})

test('a stale debug record is listed and can be cleared from the page (D3)', async () => {
  // The page used to render only live sessions, so a breakpoint set kept on disk
  // after a dead daemon had no UI affordance to drop it.
  const ui = readFileSync(new URL('../lib/risd/ui.js', import.meta.url), 'utf8')
  assert.match(ui, /var stale = body\.stale \|\| \[\]/)
  assert.match(ui, /data-forget-debug=/)
  assert.match(ui, /action: 'forget'/)
})

// ── the page's own handlers, run against a minimal DOM stub ───────────────────
// The maintenance page is a single inline script; compiling it with stubs lets the
// tests drive real handlers (button state, guards) instead of only grepping the
// source. The stub answers every element id with the same shape, and the script is
// patched right before its closing `})();` so the tests can reach the handlers.
function loadPageProbe(script) {
  const elements = new Map()
  const calls = { fetch: 0 }
  function fakeEl(id) {
    return {
      id, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '', checked: false,
      title: '', className: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false }, replace() {}, remove() {} },
      addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
      setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, focus() {}, blur() {},
      querySelector() { return fakeEl(`${id}:q`) }, querySelectorAll() { return [] },
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 } },
      scrollIntoView() {}, scrollTop: 0, scrollHeight: 0, offsetHeight: 0,
    }
  }
  const getById = (id) => {
    if (!elements.has(id)) elements.set(id, fakeEl(id))
    return elements.get(id)
  }
  const document = {
    hidden: false,
    title: '',
    getElementById: getById,
    querySelector: (selector) => getById(`sel:${selector}`),
    querySelectorAll: () => [],
    createElement: (tag) => fakeEl(tag),
    addEventListener() {},
    removeEventListener() {},
    body: fakeEl('body'),
    documentElement: fakeEl('html'),
  }
  const win = {
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    open: () => null,
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    location: { reload() {} },
  }
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }
  const fetch = () => {
    calls.fetch += 1
    return Promise.reject(new Error('offline'))
  }
  const patched = script.replace(
    /\}\)\(\);\s*$/,
    '; globalThis.__pageProbe = { state: state, renderHealth: renderHealth, stopStrayBridge: stopStrayBridge, driftSaveThenReload: driftSaveThenReload, paintBridgeFix: paintBridgeFix, fixBridge: fixBridge, renderIde: renderIde, ideUnavailable: ideUnavailable, selectIdeWindow: selectIdeWindow }; })();',
  )
  const run = new Function('document', 'window', 'localStorage', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'location', patched)
  run(document, win, storage, fetch, () => 0, () => {}, () => 0, win.location)
  calls.fetch = 0 // the page's own bootstrap probes /v1/health + /v1/dsh
  return { page: globalThis.__pageProbe, el: getById, calls, window: win }
}

async function pageProbe() {
  const page = await call(daemon.state, '/ui', { token: null })
  const script = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
  try {
    return loadPageProbe(script)
  } finally {
    globalThis.__pageProbe = undefined
  }
}

test('the enforcement button stays disabled while a request is in flight', async () => {
  const probe = await pageProbe()
  probe.page.state.stopBusy = true
  probe.page.state.fixBusy = true
  probe.page.renderHealth({
    ok: true,
    engineRunning: true,
    sides: { linux: { applicable: true } },
    interception: { linux: false, windows: false },
    stray: { linux: true, windows: false },
  })
  assert.equal(probe.el('bridge-health-stop').disabled, true, 'the stop button stays disabled')
  assert.equal(probe.el('bridge-fix').disabled, true, 'the enforcement button stays disabled')

  probe.page.state.stopBusy = false
  probe.page.state.fixBusy = false
  probe.page.renderHealth({
    ok: true,
    engineRunning: true,
    sides: { linux: { applicable: true } },
    interception: { linux: false },
    stray: { linux: false, windows: false },
  })
  assert.equal(probe.el('bridge-health-stop').disabled, false, 'idle renders re-enable the stop button')
  assert.equal(probe.el('bridge-fix').disabled, false, 'idle renders re-enable the enforcement button')
  assert.equal(probe.el('bridge-fix').textContent, '启动系统层拦截（可能提权）', 'a missing side starts')

  // A stale reload wins over the missing side: the click must stop the old profile
  // before it starts the new one, so the label says restart (m13910).
  probe.page.state.bridgeStaleReason = '规则未重载'
  probe.page.paintBridgeFix()
  assert.equal(probe.el('bridge-fix').textContent, '重启系统层拦截（可能提权）')
  assert.match(probe.el('bridge-fix').title, /为什么要重启/)
})

test('a second click while a health action is in flight is ignored', async () => {
  const probe = await pageProbe()
  probe.page.state.stopBusy = true
  probe.page.stopStrayBridge()
  assert.equal(probe.calls.fetch, 0, 'the duplicate stop never reaches the daemon')
})

test('the drift reload respects unsaved proxy rules', async () => {
  const probe = await pageProbe()
  probe.page.state.proxyDirty = true
  probe.window.confirm = () => false
  probe.page.driftSaveThenReload()
  assert.equal(probe.calls.fetch, 0, 'refusing the confirm aborts before saving/reloading')
})

test('the elevation warning is written after the proxy refresh', async () => {
  const source = readFileSync(new URL('../lib/risd/ui.js', import.meta.url), 'utf8')
  const slice = source.slice(source.indexOf('function toggleProxyEngine('), source.indexOf("el('engine-toggle').onclick"))
  const refreshAt = slice.indexOf('loadProxyTab()')
  const warnAt = slice.indexOf("host.innerHTML = banner('warn', warn)")
  assert.ok(refreshAt >= 0, 'the engine toggle refreshes the proxy tab')
  assert.ok(warnAt > refreshAt, 'the elevation warning is written after loadProxyTab cleared the banner')
  assert.doesNotMatch(slice, /if \(skipped\.length > 0\) \{\n\s+host\.innerHTML/, 'no warning is written before the refresh')
})

test('the drift path confirms unsaved lifecycle settings too', async () => {
  const source = readFileSync(new URL('../lib/risd/ui.js', import.meta.url), 'utf8')
  const saveAt = source.indexOf('function driftSaveThenReload()')
  const save = source.slice(saveAt, saveAt + 1600)
  assert.match(save, /proxyDirty === true && window\.confirm\('代理规则还没保存，刷新会丢失'\)/)
  assert.match(save, /lifecycleDirty === true && window\.confirm\('生命周期设置还没保存，刷新会丢失'\)/)
  const restart = source.slice(source.indexOf('function restartDaemonThenReload()'), source.indexOf('function reloadPage()'))
  assert.match(restart, /lifecycleDirty === true && window\.confirm\('生命周期设置还没保存，重启并刷新会丢失'\)/)
})

test('the IDE pane keeps its own workspace when dsh switches (m04873)', async () => {
  const source = readFileSync(new URL('../lib/risd/ui.js', import.meta.url), 'utf8')
  // dsh switching workspace changes /v1/dsh; the embedded IDE must not follow it,
  // and this page must not drag the dsh sidebar console along either.
  assert.match(source, /function pickIdeWindow\(windows\)/)
  assert.match(source, /return \{ cwd: preferred, live: false, active: false \}/)
  assert.match(source, /if \(!win && cwd\) win = \{ cwd: cwd, live: false, active: false \}/)
  const load = source.slice(source.indexOf('function loadIde()'), source.indexOf('function refreshIdeWindows()'))
  assert.match(load, /var selected = pickIdeWindow\(windows\)/)
  assert.doesNotMatch(load, /windows\.filter\(function \(win\) \{ return win\.live !== false; \}\)\[0\] \|\| windows\[0\]/)
})
