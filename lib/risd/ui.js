// The daemon's own maintenance page (Phase 3-lite, triggered by a real gap):
// when no dsh is open there is no panel, yet the daemon may still own a proxy
// engine, running programs (JVMs) and a debug session. Those must be stoppable.
//
// Phase 2-lite follow-up: the page now has three top tabs —
//   概览 · proxy state + running programs grouped by workspace + debug sessions
//   代理 · the machine-wide rule table (independent of dsh: CAS save via /v1/proxy,
//          engine start/stop, bridge restart, proxy log tail)
//   IDE  · embeds the dsh IDE window when a dsh window is answering, greyed out
//          with the reason otherwise (GET /v1/dsh reads dsh-window.json)
//
// One self-contained HTML file: no DSH client bundle, no npm dependency, no build
// step. It is served only to loopback requests (Host check) and carries the token
// inline — anyone able to load it can already read `risd.json` anyway.

/** Escape text for the inline `<script>` token assignment. */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Render the maintenance page.
 * @param options - `{ token, version, home, apiVersion }`.
 * @returns the HTML document.
 */
export function risdUiHtml(options) {
  const token = jsonForScript(options.token ?? '')
  const version = jsonForScript(options.version ?? '')
  const home = jsonForScript(options.home ?? '')
  const apiVersion = jsonForScript(String(options.apiVersion ?? '1'))
  // The code THIS process runs (see risd/build.js): the page compares it with what
  // /v1/health reports and offers a refresh once a restarted daemon has new code.
  const uiBuild = jsonForScript(String(options.uiBuild?.loaded ?? ''))
  // Which daemon PROCESS rendered this page. A restart may keep the same code but
  // issue a new token: the old page then answers 401 to everything, and comparing
  // this value with /v1/health's `instance` is how the page notices (review C3-P1-3).
  const uiInstance = jsonForScript(String(options.uiInstance ?? ''))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>risd — 本机代理与程序维护</title>
<style>
  :root { color-scheme: light; --b:#e4e7ec; --muted:#6b7280; --bg:#f7f8fa; --card:#fff; --accent:#2f7cf6; --danger:#dc2626; --ok:#15803d; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif; color:#111; }
  header { display:flex; align-items:center; gap:14px; padding:12px 24px; background:var(--card); border-bottom:1px solid var(--b); position:sticky; top:0; z-index:5; }
  header h1 { position:relative; z-index:1; font-size:15px; margin:0 0 0 6px; font-weight:650; letter-spacing:.2px; }
  .side-toggle { width:26px; height:26px; flex:0 0 26px; display:flex; align-items:center; justify-content:center;
    border:0; border-radius:6px; background:transparent; color:var(--muted); font-size:16px; line-height:1; cursor:pointer; }
  .side-toggle:hover { background:#f1f3f6; color:#111; }
  .side-toggle:disabled { opacity:.35; cursor:default; }
  .side-toggle:disabled:hover { background:transparent; color:var(--muted); }
  header .meta { color:var(--muted); font-size:12px; }
  header .spacer { flex:1; }
  nav { position:absolute; left:50%; transform:translateX(-50%); display:flex; gap:4px; }
  nav button { font:inherit; font-size:13px; padding:5px 14px; border:1px solid transparent; border-radius:7px; background:transparent; color:var(--muted); cursor:pointer; }
  nav button:hover { background:#f1f3f6; color:#111; }
  nav button[aria-selected="true"] { background:#eef4ff; border-color:#d7e4ff; color:var(--accent); font-weight:600; }
  nav button:disabled { opacity:.4; cursor:not-allowed; }
  nav button:disabled:hover { background:transparent; color:var(--muted); }
  main { padding:0; }
  .view#view-overview, .view#view-proxy { max-width:1120px; margin:0 auto; padding:18px 24px 60px; display:flex; flex-direction:column; gap:14px; }
  .view#view-ide { height:calc(100vh - 53px); }
  .ide-stale { display:flex; align-items:center; gap:8px; padding:6px 12px; background:#fff8e6; border-bottom:1px solid #f0d8a8; color:#8a5a00; font-size:12px; }
  .ide-stale[hidden] { display:none; }
  /* 「页面代码变了但 daemon 还是旧模块」提示：纯静态页面本身没有热更新，daemon
     import 过的模块也不会再读盘，只能重启 daemon；这条横幅把「为什么刷新没用」
     说出来，而不是让用户反复强刷。 */
  .ui-drift { display:flex; align-items:center; gap:8px; padding:6px 12px; background:#eef4ff; border-bottom:1px solid #d7e4ff; color:#1d4ed8; font-size:12px; }
  .ui-drift[hidden] { display:none; }
  .ui-drift span { flex:1; }
  .ui-drift button { border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; padding:0 4px; }
  .ui-drift #ui-drift-save { border:1px solid #bcd3ff; background:#fff; border-radius:6px; padding:2px 10px; }
  .ui-drift #ui-drift-save:disabled { opacity:.5; cursor:default; }
  .ui-drift #ui-drift-save[hidden] { display:none; }
  .ui-drift #ui-drift-reload { border:1px solid #bcd3ff; background:#fff; border-radius:6px; padding:2px 10px; }
  .ide-stale span { flex:1; }
  .ide-stale button { border:0; background:transparent; color:#8a5a00; font-size:15px; line-height:1; padding:0 2px; cursor:pointer; }
  .ide-stale button:hover { color:#5c3c00; }
  .view[hidden] { display:none !important; }
  section { background:var(--card); border:1px solid var(--b); border-radius:10px; padding:14px 18px; }
  section h2 { margin:0 0 10px; font-size:13px; font-weight:650; display:flex; align-items:center; gap:8px; }
  section h2 .sub { color:var(--muted); font-weight:400; font-size:12px; }
  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .grow { flex:1; }
  button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid var(--b); background:#fff; cursor:pointer; }
  button:hover { border-color:#c9ced6; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); border-color:#f3c7c7; }
  button:disabled { opacity:.45; cursor:default; }
  /* Long operations (sudo/UAC behind start) keep the button visibly busy instead of
     looking dead; the label says which half is running. */
  button[aria-busy="true"] { opacity:.7; cursor:progress; }
  input, select { font:inherit; padding:5px 8px; border:1px solid var(--b); border-radius:6px; background:#fff; }
  input.narrow { width:110px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #f0f1f4; vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td input[type="text"] { width:100%; }
  td.actions { white-space:nowrap; text-align:right; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--b); color:var(--muted); }
  .pill.on { color:var(--ok); border-color:#bbe3c8; background:#f0fdf4; }
  .pill.off { color:var(--muted); }
  .pill.warn { color:#b45309; border-color:#fde3b3; background:#fffbeb; }
  /* SOCKS reachability chip: quiet while probing, green when the greeting answered,
     amber when the host answered but is not a usable SOCKS5. */
  #proxy-ping.busy { color:var(--muted); }
  #proxy-ping.on { color:var(--ok); border-color:#bbe3c8; background:#f0fdf4; }
  #proxy-ping.warn { color:#b45309; border-color:#fde3b3; background:#fffbeb; }
  #proxy-ping.err { color:#b91c1c; border-color:#fecaca; background:#fef2f2; }
  #bridge-pill.on { color:var(--ok); border-color:#bbe3c8; background:#f0fdf4; }
  #bridge-pill.warn { color:#b45309; border-color:#fde3b3; background:#fffbeb; }
  #bridge-pill.err { color:#b91c1c; border-color:#fecaca; background:#fef2f2; }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); padding:6px 0; }
  pre { margin:8px 0 0; background:#0f172a; color:#d6deeb; padding:10px 12px; border-radius:8px; max-height:340px; overflow:auto; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
  ol.sessions, ul.programs { list-style:none; margin:0; padding:0; }
  ul.programs li, ol.sessions li { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid #f0f1f4; }
  ul.programs li:last-child, ol.sessions li:last-child { border-bottom:0; }
  .group-title { font-weight:600; font-size:12px; color:#374151; margin:10px 0 2px; }
  .ide-layout { display:flex; height:100%; min-height:0; }
  .ide-side { flex:0 0 208px; width:208px; border-right:1px solid var(--b); display:flex; flex-direction:column; min-height:0; background:#fbfbfc; }
  .ide-side[hidden] { display:none; }
  .ide-side ul { list-style:none; margin:0; padding:6px; overflow:auto; flex:1; }
  .ide-side li button { width:100%; text-align:left; border:0; background:transparent; padding:6px 8px; border-radius:6px; font-size:12.5px; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#111; }
  .ide-side li button:hover { background:#f1f3f6; }
  .ide-side li button.active { background:#eef4ff; color:var(--accent); font-weight:600; }
  .ide-side .note { padding:0 14px 10px; }
  .ide-main { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0; }
  .ide-body { flex:1; min-height:0; display:flex; flex-direction:column; }
  .ide-body .ide-frame { flex:1; width:100%; height:100%; border:0; border-radius:0; }
  .ide-body .ide-frame[hidden] { display:none; }
  .ide-body .ide-msg { flex:1; min-height:0; overflow:auto; }
  .ide-body .empty, .ide-body .banner { margin:18px; }

  .ide-frame { width:100%; height:70vh; border:1px solid var(--b); border-radius:8px; background:#fff; }
  .note { font-size:12px; color:var(--muted); }
  .life { display:flex; align-items:center; gap:10px; padding:6px 0; font-size:13px; }
  .life b { min-width:96px; font-weight:600; }
  .life input { margin:0; }
  .modal { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(17,24,39,.45); z-index:50; }
  .modal[hidden] { display:none; }
  .modal-card { width:440px; max-width:calc(100% - 32px); background:#fff; border-radius:12px; padding:20px 22px; box-shadow:0 24px 48px rgba(17,24,39,.22); }
  .modal-card h3 { margin:0 0 10px; font-size:16px; }
  .modal-card .modal-body { font-size:13px; color:#374151; line-height:1.7; }
  .modal-card .modal-body b { color:#111827; }
  .modal-card .modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
  .banner { padding:8px 12px; border-radius:8px; font-size:13px; }
  /* An empty banner wrapper is still a flex item, so the 14px gap counted it and
     pushed 概览 content down one gap lower than 代理设置 (m11445). Hidden when empty. */
  #overview-banner:empty, #proxy-banner:empty { display:none; }
  .banner.warn { background:#fffbeb; border:1px solid #fde3b3; color:#92400e; }
  .banner.ok { background:#f0fdf4; border:1px solid #bbe3c8; color:#166534; }
  .banner.err { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; }
</style>
</head>
<body>
<header>
  <button type="button" id="ide-side-toggle" class="side-toggle" title="展开工作区面板" aria-label="展开工作区面板" aria-expanded="false">›</button>
  <h1>risd</h1>
  <span class="spacer"></span>
  <nav role="tablist" aria-label="维护页">
    <button role="tab" data-tab="ide" aria-selected="false">开发环境</button>
    <button role="tab" data-tab="proxy" aria-selected="false">代理设置</button>
    <button role="tab" data-tab="overview" aria-selected="true">概览</button>
  </nav>
</header>
<div id="ui-drift" class="ui-drift" hidden>
  <span id="ui-drift-text">插件版本已更新：点「重启并刷新」后生效。</span>
  <button type="button" id="ui-drift-save" title="保存开发环境里所有未保存的文件" hidden>保存所有文件</button>
  <button type="button" id="ui-drift-reload" title="重新加载本页">刷新</button>
  <button type="button" id="ui-drift-close" title="关闭提示" aria-label="关闭提示">×</button>
</div>
<main>
  <div class="view" id="view-overview">
    <div id="overview-banner"></div>
    <section>
      <h2>守护进程 <span class="sub" id="daemon-sub"></span></h2>
      <div class="row">
        <span class="pill" id="daemon-pill">未知</span>
        <span class="muted" id="daemon-detail"></span>
        <span class="grow"></span>
        <button class="danger" id="daemon-stop">停止</button>
      </div>
    </section>
    <section>
      <h2>代理运行状态 <span class="sub" id="proxy-sub"></span></h2>
      <div class="row">
        <span class="pill" id="proxy-pill">未知</span>
        <span class="muted" id="proxy-detail"></span>
        <span class="grow"></span>
        <button id="engine-toggle" disabled>启动</button>
      </div>
    </section>
    <section>
      <h2>运行中的项目 <span class="sub">按工作区分组；只有运行中的才会出现</span></h2>
      <div id="projects"><p class="empty">加载中…</p></div>
    </section>
    <section>
      <h2>调试中的进程 <span class="sub">JDWP 会话由 daemon 持有</span></h2>
      <div id="debugs"><p class="empty">加载中…</p></div>
    </section>
    <section>
      <h2>生命周期 <span class="sub">只配置是否跟随 dsh；所有资源强制跟随 daemon（停止 daemon 时一并停止）</span></h2>
      <div id="lifecycle-rows">
        <label class="life"><b>守护进程</b><input type="checkbox" data-life="daemon.followDsh"><span class="muted">跟随 dsh：最后一个 dsh 窗口退出后，空闲 10 分钟自动退出；关掉则一直运行到手动停止</span></label>
        <label class="life"><b>代理引擎</b><input type="checkbox" data-life="proxy.followDsh"><span class="muted">跟随 dsh：没有 dsh 租约时拆除隧道（含系统层拦截）</span></label>
        <label class="life"><b>程序（JVM）</b><input type="checkbox" data-life="programs.followDsh"><span class="muted">跟随 dsh：最后一个窗口退出后停止程序</span></label>
        <label class="life"><b>调试会话</b><input type="checkbox" data-life="debug.followDsh"><span class="muted">跟随 dsh：最后一个窗口退出后断开调试</span></label>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="grow"></span>
        <span class="muted" id="lifecycle-note"></span>
        <button id="lifecycle-save">保存生命周期</button>
      </div>
    </section>
  </div>

  <div class="view" id="view-proxy" hidden>
    <section>
      <h2>ProxyBridge 组件 <span class="sub">系统层拦截所需；按需下载，缓存复用，不随插件打包</span></h2>
      <div class="row">
        <span id="bridge-pill" class="pill off">未知</span>
        <span class="muted grow" id="bridge-detail"></span>
        <button id="bridge-download">下载组件</button>
        <button id="bridge-upload">选择 tgz 上传</button>
        <input id="bridge-file" type="file" accept=".tgz,.tar.gz,application/gzip" hidden>
      </div>
      <div class="muted" id="bridge-hint" style="margin-top:6px"></div>
    </section>
    <section>
      <h2>规则表 <span class="sub">全局规则：按机器生效、不区分工作区；保存经 daemon 的 CAS，多窗口同时改不会互相覆盖</span></h2>
      <div class="row" style="margin-bottom:10px">
        <span class="pill off" id="proxy-engine-pill">未知</span>
        <span class="grow"></span>
        <button id="proxy-engine-toggle" disabled>启动</button>
        <span class="muted" id="proxy-revision"></span>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="muted">SOCKS 主机</label><input id="proxy-socks-host" class="narrow" placeholder="host">
        <label class="muted">端口</label><input id="proxy-socks-port" class="narrow" placeholder="1080">
        <span id="proxy-ping" class="pill off" role="status" title="">检测中…</span>
        <label class="muted">监听端口</label><input id="proxy-listen" class="narrow" placeholder="11081">
      </div>
      <div id="proxy-banner"></div>
      <table>
        <thead>
          <tr><th style="width:56px">启用</th><th style="width:170px">程序 / IP</th><th>目标主机</th><th style="width:120px">端口</th><th style="width:88px">状态</th><th style="width:90px">来源</th><th></th></tr>
        </thead>
        <tbody id="proxy-rules"></tbody>
      </table>
      <div class="row" style="margin-top:10px">
        <button id="proxy-add">+ 添加规则</button>
        <span class="grow"></span>
        <button id="bridge-restart" hidden>重启系统层拦截（可能提权）</button>
        <button id="proxy-log-toggle">代理日志</button>
      </div>
      <pre id="proxy-log" hidden></pre>
    </section>
  </div>

  <div class="view" id="view-ide" hidden>
    <div class="ide-layout">
      <aside class="ide-side" id="ide-side">
        <ul id="ide-ws-list"></ul>
        <p class="note">列表来自正在运行的 dsh</p>
      </aside>
      <div class="ide-main">
        <div id="ide-stale" class="ide-stale" hidden><span id="ide-stale-text"></span><button id="ide-stale-close" type="button" title="关闭提示" aria-label="关闭提示">×</button></div>
        <div id="ide-body" class="ide-body"><div id="ide-msg" class="ide-msg"><p class="empty">检查 dsh 状态…</p></div></div>
      </div>
    </div>
  </div>
</main>
<div class="modal" id="confirm" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <h3 id="confirm-title">停止守护进程？</h3>
    <div class="modal-body" id="confirm-body"></div>
    <div class="modal-actions">
      <button id="confirm-cancel">取消</button>
      <button class="danger" id="confirm-ok">停止</button>
    </div>
  </div>
</div>
<script>
(function () {
  var TOKEN = ${token};
  var VERSION = ${version};
  var HOME = ${home};
  var API_VERSION = ${apiVersion};
  // 本进程运行的页面代码指纹（见 risd/build.js）：/v1/health 的 uiBuild.loaded
  // 变了说明 daemon 重启并加载了新代码，刷新即可；只有 disk 变说明源码改了但
  // daemon 还是旧模块，刷新不会有效果，只能提示重启。
  var PAGE_BUILD = ${uiBuild};
  // 渲染本页的 daemon 进程身份：daemon 重启后 token 会变，本页的所有请求都会 401。
  // 与 /v1/health 的 instance 对比即可发现自己是个「旧页面」并提示刷新。
  var PAGE_INSTANCE = ${uiInstance};
  var initialCwd = '';
  try { initialCwd = new URLSearchParams(location.search).get('cwd') || ''; } catch { /* no URL API */ }
  var state = { tab: 'overview', cwd: initialCwd || localStorage.getItem('risd.cwd') || '', view: null, logOn: false, logTimer: null, pollTimer: null, pingTimer: null, pingSeq: 0, dsh: null, dshAvailable: null, lifecycleDirty: false, proxyDirty: false, proxyRunning: false, summary: { proxyRunning: false, programs: 0, debugs: 0 }, staleDismissed: {},
  };
  // The drift banner's current message and the message the user closed: a closed
  // hint must not pop back every 5 s, but a NEW kind of drift still has to warn.
  var driftMessage = '';
  var driftDismissedFor = '';
  // m11421: 源码比进程新（插件版本已更新）时光刷新没用——旧进程的模块图不会变，
  // 必须先重启 daemon 再加载本页，所以横幅的按钮在 restart 模式下是「重启并刷新」。
  var driftMode = 'reload';
  // One name per page load, not per iframe document: the embedded IDE claims a Web
  // Lock named after this value, and rebuilding the iframe (workspace switch, tab
  // re-entry) must not race the previous document's lock and flash 「RIS-IDE 已在
  // 另一个窗口打开」. The standalone IDE window keeps its workspace-keyed name, so
  // the two paths never contend (review C-P2-6).
  var IDE_WNAME = 'risd-ide-' + Math.random().toString(36).slice(2, 8);

  function api(path, options) {
    options = options || {};
    var headers = { authorization: 'Bearer ' + TOKEN, 'x-risd-api-version': API_VERSION };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || body.ok === false) {
          // 401 = the daemon restarted and re-issued its token: this page can never
          // recover on its own, so say so instead of failing silently on every call.
          // Do not clobber a richer message from checkBuild (it may be counting
          // unsaved editor buffers and showing 「保存所有文件」): the 401 timers
          // fire every few seconds, the drift check every five.
          if (res.status === 401 && driftMessage.indexOf('未保存') === -1 && driftMessage.indexOf('无法确认') === -1) {
            showDrift('维护页令牌已失效（daemon 已重启）：点右侧刷新');
          }
          var error = new Error(body.message || body.error || ('HTTP ' + res.status));
          error.status = res.status;
          error.body = body;
          throw error;
        }
        return body;
      });
    });
  }

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // The class is NOT free text: a rule's source field is written to proxy.json by
  // whatever plugin/editor touched it, so an unescaped class could break out of
  // the attribute and run script in a page that carries the daemon token
  // (review C-P2-4).
  function pill(text, cls) { return '<span class="pill ' + esc(cls || '') + '">' + esc(text) + '</span>'; }
  function hhmmss(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (h > 0 ? h + 'h' : '') + m + 'm' + s + 's';
  }
  function banner(kind, text) {
    // Same reasoning as pill(): the kind argument reaches the class attribute, so only the
    // three shapes this page uses may pass (review C-P2-4).
    var shape = kind === 'err' || kind === 'warn' || kind === 'ok' ? kind : 'warn';
    return text ? '<div class="banner ' + shape + '">' + esc(text) + '</div>' : '';
  }

  // ---- header ----
  function loadDaemon() {
    return api('/v1/health').then(function (body) {
      var home = body.home || HOME;
      el('daemon-pill').className = 'pill on';
      el('daemon-pill').textContent = '运行中';
      el('daemon-sub').textContent = 'pid ' + body.pid + ' · 已运行 ' + hhmmss(body.uptimeMs);
      el('daemon-detail').textContent = 'v' + body.version + ' · API v' + body.apiVersion +
        ' · ' + (body.port ? '127.0.0.1:' + body.port : '') + ' · 租约 ' + body.leases.count +
        ' · ' + (body.engine && body.engine.owned === true ? '引擎由本 daemon 托管' : '引擎由插件托管');
    }).catch(function (error) {
      el('daemon-pill').className = 'pill warn';
      el('daemon-pill').textContent = '不可达';
      el('daemon-sub').textContent = '';
      el('daemon-detail').textContent = error.message;
    });
  }

  // ---- overview ----
  function proxySummary() {
    return api('/v1/proxy?cwd=' + encodeURIComponent(state.cwd || HOME)).then(function (view) {
      el('proxy-pill').className = 'pill ' + (view.running ? 'on' : 'off');
      el('proxy-pill').textContent = view.running ? '运行中' : '未运行';
      el('proxy-sub').textContent = view.running
        ? 'pid ' + view.pid + ' · 监听 ' + view.listenPort
        : '监听端口 ' + view.listenPort + ' · 规则 ' + (view.rules || []).length + ' 条';
      el('proxy-detail').textContent = 'revision ' + view.revision;
      state.summary.proxyRunning = view.running === true;
      if (engineBusy) {
        paintEngineButtons();
      } else {
        var engineToggle = el('engine-toggle');
        if (engineToggle) {
          var running = state.summary.proxyRunning === true;
          engineToggle.disabled = false;
          engineToggle.removeAttribute('aria-busy');
          engineToggle.textContent = running ? '停止' : '启动';
          engineToggle.className = running ? 'danger' : '';
          engineToggle.title = running ? '停止引擎、系统层拦截与 git 代理' : '按当前规则表启动代理引擎（系统层拦截可能需要提权）';
        }
      }
      state.cwd = view.workspace || state.cwd;
      if (state.cwd) localStorage.setItem('risd.cwd', state.cwd);
      return view;
    }).catch(function (error) {
      el('proxy-pill').className = 'pill warn';
      el('proxy-pill').textContent = '未知';
      el('proxy-sub').textContent = error.message;
      return null;
    });
  }

  function loadProjects() {
    var box = el('projects');
    return api('/v1/workspaces').then(function (body) {
      var list = (body.workspaces || []).slice();
      if (state.cwd && list.indexOf(state.cwd) === -1) list.unshift(state.cwd);
      if (list.length === 0) { box.innerHTML = '<p class="empty">还没有记录到工作区：先在 dsh 面板里打开一次，或在「代理」页签里填路径。</p>'; return; }
      return Promise.all(list.map(function (cwd) {
        return api('/v1/programs?cwd=' + encodeURIComponent(cwd)).then(function (listed) {
          return { cwd: cwd, programs: (listed.programs || []).filter(function (row) { return row.running && row.running.alive !== false; }) };
        }).catch(function (error) { return { cwd: cwd, error: error.message }; });
      })).then(function (groups) {
        var html = '';
        groups.forEach(function (group) {
          if (group.error) { html += '<div class="group-title">' + esc(group.cwd) + '</div><p class="empty">' + esc(group.error) + '</p>'; return; }
          if (group.programs.length === 0) return;
          html += '<div class="group-title">' + esc(group.cwd) + '</div><ul class="programs">';
          group.programs.forEach(function (row) {
            html += '<li><span style="min-width:220px">' + esc(row.name || row.id) + '</span>' + pill(row.kind || '') +
              '<span class="muted">pid ' + esc(row.running && row.running.pid || '') + '</span><span class="grow"></span>' +
              '<button data-stop-program="' + esc(row.id) + '" data-cwd="' + esc(group.cwd) + '">停止</button></li>';
          });
          html += '</ul>';
        });
        box.innerHTML = html || '<p class="empty">没有正在运行的项目。</p>';
        state.summary.programs = groups.reduce(function (total, group) { return total + (group.programs ? group.programs.length : 0); }, 0);
      });
    }).catch(function (error) { box.innerHTML = '<p class="empty">' + esc(error.message) + '</p>'; });
  }

  function loadDebugs() {
    var box = el('debugs');
    return api('/v1/debug', { method: 'POST', body: { action: 'sessions' } }).then(function (body) {
      var rows = body.sessions || [];
      var stale = body.stale || [];
      state.summary.debugs = rows.length;
      if (rows.length === 0 && stale.length === 0) { box.innerHTML = '<p class="empty">没有调试中的进程。</p>'; return; }
      var html = '';
      if (stale.length > 0) {
        // Review D3: a session kept only on disk (no JVM, no attach) used to be
        // invisible here, so its breakpoint set had no page to clear it from.
        html += '<ul class="programs">';
        stale.forEach(function (row) {
          html += '<li><span style="min-width:220px">' + esc(row.logPath) + '</span>' +
            '<span class="muted">已断开 · 断点 ' + esc((row.breakpoints || []).length) + ' 个</span><span class="grow"></span>' +
            '<button data-forget-debug="' + esc(row.logPath) + '">清除记录</button></li>';
        });
        html += '</ul>';
      }
      if (rows.length > 0) html += '<ul class="programs">';
      rows.forEach(function (row) {
        var target = row.name || row.id || row.logPath;
        html += '<li><span style="min-width:220px">' + esc(target) + '</span>' +
          (row.port ? '<span class="muted">JDWP ' + esc(row.port) + '</span>' : '') +
          '<span class="muted">' + esc(row.cwd || '') + '</span><span class="grow"></span>' +
          (row.cwd && row.id ? '<button class="danger" data-stop-debug="' + esc(row.id) + '" data-cwd="' + esc(row.cwd) + '">停止</button>' : '') +
          '<button data-detach="' + esc(row.logPath) + '">断开</button></li>';
      });
      if (rows.length > 0) html += '</ul>';
      box.innerHTML = html;
    }).catch(function (error) { box.innerHTML = '<p class="empty">' + esc(error.message) + '</p>'; });
  }

  /** Fill the lifecycle checkboxes from the daemon's config (GET returns it). */
  function loadLifecycle() {
    // The 4 s overview refresh runs while the form is open; it must not overwrite a
    // checkbox the user just toggled, or the form looks broken ("勾了又弹回去").
    // Saving clears the flag (review C-P2-3).
    if (state.lifecycleDirty === true) return Promise.resolve(state.lifecycle || null);
    return api('/v1/config').then(function (body) {
      var policy = body.lifecycle || {};
      document.querySelectorAll('#lifecycle-rows input[data-life]').forEach(function (box) {
        var parts = box.getAttribute('data-life').split('.');
        var resource = policy[parts[0]] || {};
        box.checked = resource[parts[1]] === true;
      });
      state.lifecycle = policy;
      el('lifecycle-note').textContent = '';
      return policy;
    }).catch(function (error) { el('lifecycle-note').textContent = error.message; });
  }

  function lifecycleFromBoxes() {
    var policy = { daemon: {}, proxy: {}, programs: {}, debug: {} };
    document.querySelectorAll('#lifecycle-rows input[data-life]').forEach(function (box) {
      var parts = box.getAttribute('data-life').split('.');
      if (policy[parts[0]] === undefined) policy[parts[0]] = {};
      policy[parts[0]][parts[1]] = box.checked;
    });
    return policy;
  }

  function saveLifecycle() {
    var policy = lifecycleFromBoxes();
    return api('/v1/config', { method: 'POST', body: { lifecycle: policy } }).then(function (body) {
      state.lifecycle = body.lifecycle || policy;
      state.lifecycleDirty = false;
      el('lifecycle-note').textContent = '已保存';
      setTimeout(function () { if (el('lifecycle-note')) el('lifecycle-note').textContent = ''; }, 2500);
      return loadLifecycle();
    }).catch(function (error) { el('lifecycle-note').textContent = '保存失败：' + error.message; });
  }

  function refreshOverview() {
    loadDaemon();
    return Promise.all([proxySummary(), loadProjects(), loadDebugs(), loadLifecycle()]);
  }

  // ---- proxy tab ----
  /** 1521 / 1521,1000-1010 / *；其它写法是引擎用不了的笔误。 */
  function portSpecOk(value) {
    var spec = String(value === undefined || value === null ? '' : value).trim();
    if (spec === '') return false;
    if (spec === '*') return true;
    return spec.split(',').every(function (part) {
      part = part.trim();
      if (/^[0-9]+$/.test(part)) {
        var single = Number(part);
        return single >= 1 && single <= 65535;
      }
      var range = /^([0-9]+)-([0-9]+)$/.exec(part);
      if (range === null) return false;
      var low = Number(range[1]);
      var high = Number(range[2]);
      return low >= 1 && high <= 65535 && low <= high;
    });
  }
  /**
   * What the engine will do with this row right now — the answer to 「这行到底生效了
   * 没有」 without reading the log. Order matters: an incomplete row is never
   * 「生效」, and a complete row waits for the engine.
   */
  function ruleStatus(rule) {
    if (rule.enabled === false) return { cls: 'off', text: '未启用' };
    var missing = [];
    if (!String(rule.program || '').trim()) missing.push('程序');
    if (!String(rule.hosts || '').trim()) missing.push('IP');
    if (!String(rule.ports || '').trim()) missing.push('端口');
    if (missing.length > 0) return { cls: 'err', text: '缺' + missing.join('/') };
    if (!portSpecOk(rule.ports)) return { cls: 'err', text: '端口格式' };
    return state.proxyRunning === true
      ? { cls: 'on', text: '生效' }
      : { cls: 'off', text: '待启动' };
  }
  /**
   * A row's origin at a glance. The side matters on WSL: java.exe and java are two
   * rows because each side's ProxyBridge matches a different image name.
   */
  function sourceText(rule) {
    var source = String(rule.source || 'user');
    if (rule.side === 'local') return source + '·wsl';
    if (rule.side === 'windows') return source + '·win';
    return source;
  }
  function ruleRow(rule, index) {
    var status = ruleStatus(rule);
    return '<tr data-index="' + index + '">' +
      '<td><input type="checkbox" data-field="enabled"' + (rule.enabled === false ? '' : ' checked') + '></td>' +
      '<td><input type="text" data-field="program" value="' + esc(rule.program) + '"></td>' +
      '<td><input type="text" data-field="hosts" value="' + esc(rule.hosts) + '"></td>' +
      '<td><input type="text" data-field="ports" value="' + esc(rule.ports) + '"></td>' +
      '<td>' + pill(status.text, status.cls) + '</td>' +
      '<td>' + pill(sourceText(rule)) + (rule.shadow ? ' ' + pill('shadow', 'warn') : '') + (rule.direct ? ' ' + pill('direct', 'warn') : '') + '</td>' +
      '<td class="actions"><button data-remove="' + index + '">删除</button></td>' +
      '</tr>';
  }

  /**
   * The restart button is noise when nothing is stale, and the whole point when
   * something is: show it only for a failed/incomplete reload and put the reason in
   * the tooltip (a click costs a UAC prompt on Windows and sudo on this side).
   */
  function setBridgeStale(reason) {
    var stale = /未重载|旧规则|需要提权|未能重载|未重启|未能停止/.test(String(reason || ''));
    var button = el('bridge-restart');
    button.hidden = !stale;
    button.title = stale
      ? '为什么要重启：' + reason + '（点一下会停止系统层拦截并按当前规则表重新启动；Windows 会弹一次 UAC，本侧需要 sudo）'
      : '';
  }

  function renderProxyTab(view) {
    state.view = view;
    state.proxyRunning = view.running === true;
    setBridgeStale(state.lastReloadNote || '');
    el('proxy-socks-host').value = view.socks ? view.socks.host : '';
    el('proxy-socks-port').value = view.socks ? view.socks.port : '';
    el('proxy-listen').value = view.listenPort;
    el('proxy-revision').textContent = 'revision ' + view.revision;
    var enginePill = el('proxy-engine-pill');
    if (enginePill) {
      enginePill.className = 'pill ' + (state.proxyRunning ? 'on' : 'off');
      enginePill.textContent = state.proxyRunning ? '代理运行中' : '代理未运行';
      enginePill.title = state.proxyRunning ? '引擎在跑：合规的行已经生效' : '保存后如果规则完整会自动启动';
    }
    if (engineBusy) {
      paintEngineButtons();
    } else {
      var engineToggle = el('proxy-engine-toggle');
      if (engineToggle) {
        engineToggle.disabled = false;
        engineToggle.removeAttribute('aria-busy');
        engineToggle.textContent = state.proxyRunning ? '停止' : '启动';
        engineToggle.className = state.proxyRunning ? 'danger' : '';
        engineToggle.title = state.proxyRunning
          ? '停止引擎、系统层拦截与 git 代理'
          : '按当前规则表启动（保存后规则完整会自动启动；系统层拦截可能需要提权）';
      }
    }
    var rules = view.rules || [];
    el('proxy-rules').innerHTML = rules.length === 0
      ? '<tr><td colspan="7" class="empty">没有规则。系统代理至少需要一条启用且带程序/IP/端口的规则。</td></tr>'
      : rules.map(ruleRow).join('');
  }

  function rulesFromTable() {
    var rows = [];
    el('proxy-rules').querySelectorAll('tr[data-index]').forEach(function (tr) {
      var base = (state.view && state.view.rules || [])[Number(tr.getAttribute('data-index'))] || {};
      var rule = Object.assign({}, base);
      if (!rule.id) rule.id = 'user-' + Math.random().toString(36).slice(2, 9);
      rule.program = tr.querySelector('[data-field="program"]').value.trim();
      rule.hosts = tr.querySelector('[data-field="hosts"]').value.trim();
      rule.ports = tr.querySelector('[data-field="ports"]').value.trim();
      rule.enabled = tr.querySelector('[data-field="enabled"]').checked;
      if (!rule.source) rule.source = 'user';
      rows.push(rule);
    });
    return rows;
  }

  /** Everything the engine needs before a save is worth writing (and before auto-start). */
  function proxyFormIssues() {
    var issues = [];
    var host = el('proxy-socks-host').value.trim();
    var socksPort = Number(el('proxy-socks-port').value);
    if (host === '') issues.push('代理服务器地址为空');
    else if (/\s/.test(host)) issues.push('代理服务器地址含空格');
    if (!(socksPort >= 1 && socksPort <= 65535)) issues.push('代理服务器端口需为 1-65535');
    var listenPort = Number(el('proxy-listen').value);
    if (!(listenPort >= 1 && listenPort <= 65535)) issues.push('监听端口需为 1-65535');
    rulesFromTable().forEach(function (rule, index) {
      if (rule.enabled === false) return;
      var missing = [];
      if (!rule.program) missing.push('程序');
      if (!rule.hosts) missing.push('IP');
      if (!rule.ports) missing.push('端口');
      if (missing.length > 0) issues.push('第 ' + (index + 1) + ' 行缺' + missing.join('/'));
      else if (!portSpecOk(rule.ports)) issues.push('第 ' + (index + 1) + ' 行端口格式不对');
    });
    return issues;
  }

  /** A complete, enabled row is what makes starting the engine worth doing. */
  function hasActionableRule(view) {
    return (view && view.rules || []).some(function (rule) {
      return rule.enabled !== false && String(rule.program || '').trim() !== '' &&
        String(rule.hosts || '').trim() !== '' && portSpecOk(rule.ports);
    });
  }

  /**
   * 「勾选的配置不为空、有效就自动保存并启动」：editing is the save. A partially
   * filled row is not an error the user must dismiss, so the banner explains what is
   * still missing and the save happens once it is complete.
   */
  var autoSaveTimer = null;
  // Rapid edits can outrun a POST: the second write would carry the revision of the
  // first (409 against ourselves). One save in flight, then re-run if the form moved.
  var saveInFlight = null;
  var savePending = false;
  function scheduleProxySave() {
    state.proxyDirty = true;
    state.editVersion = (state.editVersion || 0) + 1;
    if (autoSaveTimer !== null) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
      autoSaveTimer = null;
      autoSaveProxy();
    }, 700);
  }
  function autoSaveProxy() {
    if (state.tab !== 'proxy') return;
    var issues = proxyFormIssues();
    if (issues.length > 0) {
      el('proxy-banner').innerHTML = banner('warn', '还没保存：' + issues.join('；'));
      return;
    }
    saveRules({ auto: true });
  }

  /**
   * After a successful save, bring the tunnel up — that is the 「并启动」 half. A
   * bridge that needs elevation is reported as a note (the restart button appears
   * from setBridgeStale), never as a silent failure.
   */
  function maybeStartProxy(view) {
    if (!view || view.running === true || hasActionableRule(view) === false) return Promise.resolve(null);
    var version = state.editVersion || 0;
    el('proxy-banner').innerHTML = banner('ok', '规则已保存，正在启动代理…');
    return api('/v1/action', { method: 'POST', body: { action: 'start', cwd: state.cwd } }).then(function (response) {
      var result = (response && response.result) || {};
      var redirector = result.redirector || {};
      var skipped = Array.isArray(redirector.skipped) ? redirector.skipped : [];
      var note = skipped.length > 0
        ? '系统层拦截需要提权：' + skipped.map(function (item) { return item.side + ':' + item.reason; }).join('；')
        : (typeof result.reloadNote === 'string' ? result.reloadNote : '');
      state.lastReloadNote = note;
      if ((state.editVersion || 0) !== version) return null;
      return loadProxyTab().then(function () {
        el('proxy-banner').innerHTML = note
          ? banner('warn', '规则已保存；' + note + '（可点「重启系统层拦截」重试）')
          : banner('ok', '规则已保存并已启动代理');
      });
    }).catch(function (error) {
      el('proxy-banner').innerHTML = banner('warn', '规则已保存，但代理启动失败：' + error.message);
      return null;
    });
  }

  function loadProxyTab() {
    // The rule table is machine-wide: no workspace picker. The workspace only tags
    // rows for bookkeeping, so the daemon falls back to its own home when omitted.
    var cwd = state.cwd || '';
    return api('/v1/proxy' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : '')).then(function (view) {
      state.cwd = view.workspace || cwd;
      localStorage.setItem('risd.cwd', state.cwd);
      renderProxyTab(view);
      // A view that just came from the daemon is the saved state by definition.
      state.proxyDirty = false;
      el('proxy-banner').innerHTML = '';
      refreshPing();
      loadBundle();
      // A save switches enforcement in the background; a failure from an earlier
      // save is reported here rather than blocking that save (m10585).
      if (view.bridge && view.bridge.ok === false && view.bridge.note) setBridgeStale(view.bridge.note);
    }).catch(function (error) { el('proxy-banner').innerHTML = banner('err', error.message); });
  }

  /**
   * Refresh the base revision without repainting: a 409 usually means our own earlier
   * save bumped the table while the user kept typing, and repainting here would
   * replace that newer text with the version we failed to write.
   */
  function refreshProxyView() {
    var cwd = state.cwd || '';
    return api('/v1/proxy' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : '')).then(function (view) {
      state.cwd = view.workspace || cwd;
      state.view = view;
      return view;
    });
  }

  function saveRules(options) {
    var auto = !!(options && options.auto);
    if (saveInFlight !== null) { savePending = true; return saveInFlight; }
    var version = state.editVersion || 0;
    var cwd = state.cwd || '';
    var body = {
      cwd: cwd || undefined,
      revision: state.view ? state.view.revision : '',
      config: {
        socks: { host: el('proxy-socks-host').value.trim(), port: Number(el('proxy-socks-port').value) || 0 },
        listenPort: Number(el('proxy-listen').value) || 0,
        rules: rulesFromTable(),
      },
    };
    var run = api('/v1/proxy', { method: 'POST', body: body }).then(function (result) {
      state.lastReloadNote = result.reloadNote || '';
      // Typing during the POST is a fresh edit, not a save of the old text: repainting
      // now would throw the new text away (it also overwrote the input the user was
      // still typing in). Write the newer form instead.
      if ((state.editVersion || 0) !== version) {
        savePending = true;
        return null;
      }
      state.proxyDirty = false;
      // Reload first, then show the outcome: loadProxyTab clears the banner itself.
      return loadProxyTab().then(function () {
        el('proxy-banner').innerHTML = banner(result.reloadNote ? 'warn' : 'ok',
          (auto ? '已自动保存' : '已保存') + '（revision ' + result.revision + '）' +
          (result.reloadNote ? ' · ' + result.reloadNote : ''));
        return maybeStartProxy(state.view);
      });
    });
    saveInFlight = run.then(function (value) {
      saveInFlight = null;
      if (savePending === true) { savePending = false; scheduleProxySave(); }
      return value;
    }, function (error) {
      saveInFlight = null;
      var retryPending = savePending === true;
      savePending = false;
      if (error.status === 409) {
        // Our own in-flight save bumped the revision: our edits are newer than the
        // table we wrote, so reload and write again once (a real foreign edit also
        // lands here, and the retry then reports the fresh table instead of a loop).
        // Rebasing on the fresh revision (no repaint) keeps the text the user is
        // still typing and writes exactly one more time.
        if (options && options.retried !== true) {
          return refreshProxyView().then(function () { return saveRules({ auto: auto, retried: true }); });
        }
        // Reload first, then show the conflict: loadProxyTab() rewrites the banner,
        // so the old order made the 409 message visible for ~50 ms (review C-P1-4).
        setTimeout(function () {
          loadProxyTab().then(function () { el('proxy-banner').innerHTML = banner('err', error.message) })
        }, 50)
        return
      }
      if (retryPending === true) scheduleProxySave(); else el('proxy-banner').innerHTML = banner('err', error.message)
    });
    return saveInFlight;
  }

  function logToggle() {
    state.logOn = !state.logOn;
    el('proxy-log').hidden = !state.logOn;
    el('proxy-log-toggle').textContent = state.logOn ? '停止日志' : '代理日志';
    syncLogTimer();
  }
  // The tail costs up to 40 KB every 2 s: poll only while the pane is actually on
  // screen (proxy tab, page visible) and pause on a hidden tab instead of keeping
  // the timer alive off-screen (review C-P2-3).
  function syncLogTimer() {
    var wanted = state.logOn === true && state.tab === 'proxy' && document.hidden !== true;
    if (wanted && state.logTimer === null) {
      pollLog();
      state.logTimer = setInterval(pollLog, 2000);
    } else if (!wanted && state.logTimer !== null) {
      clearInterval(state.logTimer);
      state.logTimer = null;
    }
  }
  function pollLog() {
    api('/v1/proxy/log?bytes=40960').then(function (body) {
      var pre = el('proxy-log');
      pre.textContent = body.text || '(空)';
      pre.scrollTop = pre.scrollHeight;
    }).catch(function (error) { el('proxy-log').textContent = error.message; });
  }

  // ---- ProxyBridge bundle (m09120 ③) ----
  // The binaries are no longer shipped in the package: they are downloaded once into
  // <proxy home>/proxybridge/bundle and reused. When the mirror is unreachable the
  // card names the URL and accepts the same .tgz by hand.
  var bundlePoll = null;
  // Remembered across renders: a failed download repeats only its error, so without
  // these the card would lose the manual URLs that make it useful in the first place
  // (review C3-P2-12), and the reinstall button would not know it is a reinstall.
  var lastBundleUrls = [];
  var lastBundleInstalled = false;
  function renderBundle(status) {
    var pill = el('bridge-pill');
    var detail = el('bridge-detail');
    var hint = el('bridge-hint');
    var button = el('bridge-download');
    var upload = el('bridge-upload');
    if (!pill) return;
    var installed = status.installed === true;
    var cls = 'pill';
    var text = '未知';
    if (status.downloading === true) { cls += ' warn'; text = '下载中…'; }
    else if (installed) { cls += ' on'; text = '已安装'; }
    else if (status.result && status.result.ok === false) { cls += ' err'; text = '下载失败'; }
    else { cls += ' off'; text = '未安装'; }
    pill.className = cls;
    pill.textContent = text;
    lastBundleInstalled = installed;
    // The install directory is an implementation detail; the card answers 「装没装、
    // 几个文件」 and keeps the paths in the hint only when something is missing.
    detail.textContent = installed
      ? '已安装 · 文件 ' + (status.files || []).length + ' 个'
      : (status.downloading === true ? '正在下载并校验…' : '系统层拦截在首次使用时需要这组文件');
    // Installed is the steady state: the card then only reports 「装了几个文件」.
    // Download/upload are recovery paths for a missing bundle, so they disappear
    // once it is installed (m10585).
    button.hidden = installed;
    upload.hidden = installed;
    button.disabled = status.downloading === true;
    button.textContent = '下载组件';
    var urls = Array.isArray(status.urls) === true && status.urls.length > 0
      ? status.urls
      : [status.url].filter(function (item) { return typeof item === 'string' && item !== ''; });
    if (urls.length > 0) lastBundleUrls = urls.slice();
    else urls = lastBundleUrls.slice();
    if (installed) { hint.textContent = ''; hint.style.whiteSpace = ''; return; }
    var lines = ['下载地址（优先 Gitee，失败自动换 GitHub）：'];
    urls.forEach(function (item) { lines.push('  ' + item); });
    if (status.result && status.result.ok === false && status.result.error) lines.push('失败原因：' + status.result.error);
    if (urls.length > 0) lines.push('也可在浏览器打开上面的地址下载 tgz，再点「选择 tgz 上传」。');
    hint.textContent = lines.join('\\n');
    hint.style.whiteSpace = 'pre-line';
  }
  function loadBundle() {
    return api('/v1/proxybridge').then(function (status) {
      renderBundle(status);
      if (status.downloading === true) startBundlePoll();
      return status;
    }).catch(function (error) { el('bridge-hint').textContent = error.message; });
  }
  function startBundlePoll() {
    if (bundlePoll !== null) return;
    bundlePoll = setInterval(function () {
      api('/v1/proxybridge').then(function (status) {
        renderBundle(status);
        if (status.downloading !== true) { clearInterval(bundlePoll); bundlePoll = null; }
      }).catch(function () { clearInterval(bundlePoll); bundlePoll = null; });
    }, 1000);
  }
  function downloadBundle() {
    // Reinstalling an existing bundle must not be answered with fromCache without
    // touching the files: ask the daemon to force the download (the endpoint hands
    // 'force' to ensureBundle).
    var force = lastBundleInstalled === true;
    renderBundle({ downloading: true });
    // Poll from the start: if the POST itself stalls, the card still follows the
    // daemon-side download instead of sitting on 「下载中…」 forever.
    startBundlePoll();
    return api('/v1/proxybridge/download', { method: 'POST', body: force === true ? { force: true } : {} }).then(function (status) {
      renderBundle(status);
      startBundlePoll();
      // Finished before the first poll (cache hit or a fast mirror).
      return loadBundle();
    }).catch(function (error) { renderBundle({ downloading: false, result: { ok: false, error: error.message } }); });
  }
  function uploadBundle(file) {
    if (!file) return;
    el('bridge-hint').textContent = '正在上传 ' + file.name + '…';
    return file.arrayBuffer().then(function (bytes) {
      return fetch('/v1/proxybridge/upload', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + TOKEN, 'x-risd-api-version': API_VERSION, 'content-type': 'application/gzip' },
        body: bytes,
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || body.ok === false) throw new Error(body.message || body.error || ('HTTP ' + res.status));
          return loadBundle();
        });
      });
    }).catch(function (error) { el('bridge-hint').textContent = '上传失败：' + error.message; });
  }

  // ---- SOCKS reachability chip ----
  // A wrong SOCKS host/port used to look identical to a healthy one until the first
  // request failed. The chip probes the upstream every 10 s while the proxy tab is on
  // screen: green = SOCKS5 greeting answered, amber = the port answered but is not a
  // usable SOCKS5, red = unreachable (the tooltip says why).
  function renderPing(result) {
    var chip = el('proxy-ping');
    if (!chip) return;
    var cls = 'pill';
    var text = '';
    if (result === null || result === undefined) { cls += ' busy'; text = '检测中…'; }
    // 没填 SOCKS 地址不是故障：灰色「未配置」，别用红点吓人（review C3-P2-9）。
    else if (result.configured === false) { cls += ' off'; text = '未配置'; }
    else if (result.ok === true) { cls += ' on'; text = '连通 ' + ((result.ms || 0) + ' ms'); }
    else if (result.socks === true) { cls += ' warn'; text = '需认证'; }
    else { cls += ' err'; text = '无法连接'; }
    chip.className = cls;
    chip.textContent = text;
    chip.title = result === null || result === undefined
      ? '正在检测代理服务器连通性…'
      : (result.configured === false
        ? '还没有填写代理服务器地址'
        : (result.ok === true ? '代理服务器可达（' + (result.host || '') + ':' + (result.port || '') + '，' + result.at + '）' : String(result.error || '连接失败')));
  }
  function refreshPing() {
    var host = el('proxy-socks-host').value.trim();
    var port = el('proxy-socks-port').value.trim();
    var token = state.pingSeq = (state.pingSeq || 0) + 1;
    // 空地址不发请求：/v1/proxy/ping 必然失败，10 s 一次的必然失败探测没有意义。
    if (host === '') { renderPing({ configured: false }); return Promise.resolve(null); }
    renderPing(null);
    return api('/v1/proxy/ping?host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port)).then(function (body) {
      if (token !== state.pingSeq) return;
      renderPing(body);
    }).catch(function (error) {
      if (token !== state.pingSeq) return;
      renderPing({ ok: false, socks: false, error: error.message, host: host, port: port });
    });
  }
  function syncPingTimer() {
    var wanted = state.tab === 'proxy' && document.hidden !== true;
    if (wanted && state.pingTimer === null) {
      if (el('proxy-socks-host').value.trim() !== '') refreshPing();
      state.pingTimer = setInterval(refreshPing, 10000);
    } else if (!wanted && state.pingTimer !== null) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  }

  // ---- IDE tab ----
  // One page can drive every workspace: the daemon reports each live dsh window
  // (cwd + sessionId); the left panel switches between them, and it can collapse
  // so the iframe gets the whole width.
  function ideTargetUrl(win) {
    var base = String(win.url || '');
    while (base.length > 1 && base.slice(-1) === '/') base = base.slice(0, -1);
    var cwd = win.cwd || state.cwd || '';
    return base + '/dsh-ris-ide/window?cwd=' + encodeURIComponent(cwd) +
      (win.sessionId ? '&sessionId=' + encodeURIComponent(win.sessionId) : '') + '&wname=' + encodeURIComponent(IDE_WNAME);
  }

  // Collapsed by default (m08228): the IDE needs the width; expand from the header.
  function sideVisible() { return localStorage.getItem('risd.ideSide') === 'on'; }
  /** Repaint the sidebar and its header toggle (one control, both states). */
  function applySide() {
    var visible = sideVisible();
    el('ide-side').hidden = !visible;
    var toggle = el('ide-side-toggle');
    if (toggle) {
      toggle.textContent = visible ? '‹' : '›';
      var label = visible ? '收起工作区面板' : '展开工作区面板';
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
      toggle.disabled = el('view-ide').hidden;
    }
  }

  function workspaceBase(cwd) {
    var parts = String(cwd || '').split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : String(cwd || '');
  }
  /** A short, stable label: the folder name, with the parent when two collide. */
  function workspaceLabel(cwd, windows) {
    var base = workspaceBase(cwd);
    var same = windows.filter(function (win) { return workspaceBase(win.cwd) === base; }).length;
    if (same <= 1) return base || '(未知工作区)';
    var parts = String(cwd || '').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function focusIdeFrame() {
    var frame = el('ide-frame');
    if (frame) { try { frame.focus(); } catch { /* focus is best effort */ } }
  }

  function selectIdeWindow(windows, cwd) {
    var win = windows.filter(function (row) { return (row.cwd || '') === cwd; })[0] || windows[0];
    if (!win) return;
    var key = win.cwd || '';
    if (win.live !== false) delete state.staleDismissed[key];
    var stale = el('ide-stale');
    if (stale) {
      stale.hidden = win.live !== false || state.staleDismissed[key] === true;
      var staleText = el('ide-stale-text');
      if (staleText) staleText.textContent = '该工作区最近没有活动（dsh 窗口可能已关闭），IDE 仍会尝试加载；若失败请重新打开 dsh 面板。';
    }
    if (win.cwd) { state.cwd = win.cwd; localStorage.setItem('risd.cwd', win.cwd); }
    var frame = ensureIdeFrame();
    frame.hidden = false;
    var url = ideTargetUrl(win);
    // Keep the document alive when the target did not change: switching tabs must
    // not throw away unsaved edits, the debugger selection or the scroll position
    // (review C-P0-1).
    if (frame.getAttribute('src') !== url) frame.src = url;
    // Move keyboard focus into the embedded IDE: cross-origin iframes receive their
    // own key events natively, but only while they hold focus. This also runs when
    // the document was reused (workspace switch), where Ctrl+F must stay inside.
    try { frame.focus(); } catch { /* focus is best effort */ }
    el('ide-ws-list').querySelectorAll('[data-cwd]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-cwd') === (win.cwd || ''));
    });
  }

  function ensureIdeFrame() {
    var frame = el('ide-frame');
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.id = 'ide-frame';
    frame.className = 'ide-frame';
    frame.title = 'RIS-IDE';
    el('ide-body').appendChild(frame);
    return frame;
  }

  function ideMessage(kind, text, note) {
    var box = el('ide-msg');
    box.hidden = false;
    box.innerHTML = banner(kind, text) + (note ? '<p class="note">' + esc(note) + '</p>' : '');
  }

  function clearIdeMessage() {
    var box = el('ide-msg');
    if (box) {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function renderIde(windows, current) {
    var selected = current || windows[0];
    el('ide-ws-list').innerHTML = windows.map(function (win) {
      var label = workspaceLabel(win.cwd, windows);
      // Non-live entries stay clickable: dsh may still have the session, the iframe
      // shows the real result (m08268).
      var suffix = win.live === false ? '（未活跃）' : '';
      return '<li><button type="button" data-cwd="' + esc(win.cwd || '') + '" title="' + esc((win.cwd || '') + (suffix ? ' ' + suffix : '')) + '">' +
        esc(label + suffix) + '</button></li>';
    }).join('');
  var staleClose = el('ide-stale-close');
  if (staleClose) {
    staleClose.onclick = function () {
      state.staleDismissed[state.cwd || ''] = true;
      var bar = el('ide-stale');
      if (bar) bar.hidden = true;
    };
  }

    el('ide-ws-list').onclick = function (event) {
      var button = event.target.closest('[data-cwd]');
      if (button) selectIdeWindow(windows, button.getAttribute('data-cwd'));
    };
    clearIdeMessage();
    ensureIdeFrame();
    applySide();
    selectIdeWindow(windows, selected.cwd || '');
  }

  function ideUnavailable(body) {
    el('ide-ws-list').innerHTML = '';
    var frame = el('ide-frame');
    if (frame) frame.hidden = true;
    ideMessage('warn', 'IDE 不可用：' + (body.reason || 'dsh 未运行'),
      'IDE 界面由 dsh 提供；启动 dsh 并打开一次 RIS-IDE 面板后，这里会自动可用。');
    applySide();
  }

  function loadIde() {
    if (!el('ide-frame') && el('ide-msg').hidden) {
      el('ide-msg').hidden = false;
      el('ide-msg').innerHTML = '<p class="empty">检查 dsh 状态…</p>';
    }
    return api('/v1/dsh').then(function (body) {
      state.dsh = body;
      state.dshSignature = dshWindowSignature(body);
      var windows = body.windows || [];
      if (!body.available || windows.length === 0) {
        ideUnavailable(body);
        return;
      }
      var preferred = state.cwd;
      var selected = windows.filter(function (win) { return (win.cwd || '') === preferred; })[0] ||
        windows.filter(function (win) { return win.live !== false; })[0] || windows[0];
      renderIde(windows, selected);
    }).catch(function (error) {
      ideMessage('err', 'IDE 状态读取失败：' + error.message);
    });
  }

  /**
   * Re-read the window list but keep the existing iframe: called when the IDE tab
   * is re-opened or the dsh window set changed. Rebuilding the element here was
   * the P0 that silently dropped unsaved edits.
   */
  function refreshIdeWindows() {
    return api('/v1/dsh').then(function (body) {
      state.dsh = body;
      state.dshSignature = dshWindowSignature(body);
      var windows = body.windows || [];
      if (!body.available || windows.length === 0) {
        ideUnavailable(body);
        return;
      }
      var preferred = state.cwd;
      var selected = windows.filter(function (win) { return (win.cwd || '') === preferred; })[0] ||
        windows.filter(function (win) { return win.live !== false; })[0] || windows[0];
      renderIde(windows, selected);
    }).catch(function (error) {
      ideMessage('err', 'IDE 状态读取失败：' + error.message);
    });
  }

  function dshWindowSignature(body) {
    // Liveness is part of the rendering state: a window going 未活跃 must repaint
    // the hint bar even though cwd/sessionId did not change.
    return (body.windows || []).map(function (win) {
      return (win.cwd || '') + '|' + (win.sessionId || '') + '|' + (win.live === false ? 'stale' : 'live');
    }).sort().join('\\n');
  }

  /** Grey the IDE tab when no dsh window is answering; re-check every 5s. */
  function syncDshTab() {
    return api('/v1/dsh').then(function (body) {
      var available = body.available === true && (body.windows || []).length > 0;
      var changed = state.dshAvailable !== available;
      state.dsh = body;
      state.dshAvailable = available;
      var tab = document.querySelector('nav button[data-tab="ide"]');
      tab.disabled = !available;
      tab.title = available
        ? '嵌入 dsh 的 IDE（可按工作区切换）'
        : ('IDE 不可用：' + (body.reason || 'dsh 未运行'));
      var signature = dshWindowSignature(body);
      var windowsChanged = state.dshSignature !== signature;
      state.dshSignature = signature;
      if (state.tab === 'ide' && (changed || windowsChanged)) {
        if (available) refreshIdeWindows();
        else ideUnavailable(body);
      }
      return available;
    }).catch(function () {
      state.dshAvailable = false;
      var tab = document.querySelector('nav button[data-tab="ide"]');
      tab.disabled = true;
      tab.title = 'IDE 不可用：无法读取 dsh 状态';
      return false;
    });
  }

  // ---- tabs ----
  function showTab(name) {
    // Refuse a disabled IDE tab BEFORE touching visibility: the old order made the
    // pane visible and then returned, so any caller other than a click (deep link,
    // shortcut) would leave an empty IDE view behind (review C-P2-9).
    if (name === 'ide') {
      var ideTab = document.querySelector('nav button[data-tab="ide"]');
      if (ideTab && ideTab.disabled) return;
    }
    state.tab = name;
    try { localStorage.setItem(TAB_STORAGE, name); } catch { /* storage off */ }
    document.querySelectorAll('nav button[data-tab]').forEach(function (button) {
      button.setAttribute('aria-selected', button.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    el('view-overview').hidden = name !== 'overview';
    el('view-proxy').hidden = name !== 'proxy';
    el('view-ide').hidden = name !== 'ide';
    if (name === 'overview') refreshOverview();
    if (name === 'proxy') loadProxyTab();
    // Re-opening the tab must not reload the embedded IDE: only the window list is
    // refreshed, the iframe (and its unsaved state) stays (review C-P0-1).
    if (name === 'ide') { if (el('ide-frame')) refreshIdeWindows(); else loadIde(); }
    // Leaving the proxy tab must stop the log tail; entering it restarts it only if
    // the pane was already on (review C-P2-3).
    syncLogTimer();
    // Same lifecycle for the reachability chip: never probe while another tab shows.
    syncPingTimer();
    // The header toggle only applies to the IDE pane: disable it (with its title
    // explaining why) while another tab is showing.
    applySide();
  }

  // ---- wiring ----
  document.querySelectorAll('nav button[data-tab]').forEach(function (button) {
    button.onclick = function () { showTab(button.getAttribute('data-tab')); };
  });
  // Stopping the daemon stops everything it supervises, so it gets a real
  // reminder (not a one-line confirm): list what is about to go away.
  function askStopDaemon() {
    return refreshOverview().catch(function () {}).then(function () {
      var summary = state.summary || {};
      var programs = summary.programs || 0;
      var debugs = summary.debugs || 0;
      var lines = [];
      lines.push('停止后需要重新启动 dsh，或手跑 <b>risd serve</b>，才能再次使用代理与 IDE。');
      lines.push('将要停止：');
      lines.push('· 代理引擎：' + (summary.proxyRunning ? '<b>运行中</b>（会一并停止）' : '未运行'));
      lines.push('· 系统层拦截：随代理一起拆除（可能弹一次提权确认）');
      lines.push('· 运行中的项目：<b>' + programs + '</b> 个' + (programs > 0 ? '（会先停止）' : ''));
      lines.push('· 调试会话：<b>' + debugs + '</b> 个' + (debugs > 0 ? '（会先断开）' : ''));
      el('confirm-body').innerHTML = lines.join('<br>');
      el('confirm').hidden = false;
      return new Promise(function (resolve) {
        function finish(value) {
          el('confirm').hidden = true;
          el('confirm-ok').onclick = null;
          el('confirm-cancel').onclick = null;
          document.removeEventListener('keydown', onKey);
          resolve(value);
        }
        function onKey(event) { if (event.key === 'Escape') finish(false); }
        el('confirm-ok').onclick = function () { finish(true); };
        el('confirm-cancel').onclick = function () { finish(false); };
        document.addEventListener('keydown', onKey);
      });
    });
  }
  el('daemon-stop').onclick = function () {
    askStopDaemon().then(function (ok) {
      if (!ok) return;
      return shutdownDaemon();
    });
  };
  // (overview's 停止 keeps its own path below; the proxy tab's stop reloads the tab.)
  function shutdownDaemon() {
    api('/v1/shutdown', { method: 'POST', body: {} }).catch(function () { /* the page dies with it */ });
    el('daemon-pill').className = 'pill off';
    el('daemon-pill').textContent = '已停止';
    el('daemon-sub').textContent = '页面已断开；下次 daemonMode=auto 的 dsh 启动或手跑 risd serve 会重新拉起';
  };
  // One button, two states: the label IS the next action (m10585). A stop leaves it
  // reading 启动, so the same spot brings the tunnel back. Starting can wait seconds
  // behind sudo/UAC, so both buttons show the in-flight action and ignore clicks
  // until it settles (user m11279).
  var engineBusy = false;
  var engineBusyAction = '';
  function paintEngineButtons() {
    var running = state.summary.proxyRunning === true || state.proxyRunning === true;
    [el('engine-toggle'), el('proxy-engine-toggle')].forEach(function (button) {
      if (!button) return;
      if (engineBusy) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = engineBusyAction === 'stop' ? '停止中…' : '启动中…';
        return;
      }
      button.removeAttribute('aria-busy');
      button.disabled = false;
      button.textContent = running ? '停止' : '启动';
      button.className = running ? 'danger' : '';
      button.title = running
        ? '停止引擎、系统层拦截与 git 代理'
        : '按当前规则表启动代理引擎（系统层拦截可能需要提权）';
    });
  }
  function toggleProxyEngine() {
    if (engineBusy) return;
    var running = state.summary.proxyRunning === true || state.proxyRunning === true;
    var action = running ? 'stop' : 'start';
    var host = state.tab === 'proxy' ? el('proxy-banner') : el('overview-banner');
    host.innerHTML = '';
    engineBusy = true;
    engineBusyAction = action;
    paintEngineButtons();
    api('/v1/action', { method: 'POST', body: { action: action, cwd: state.cwd } })
      .then(function (response) {
        var result = (response && response.result) || {};
        var redirector = result.redirector || {};
        var skipped = Array.isArray(redirector.skipped) ? redirector.skipped : [];
        if (skipped.length > 0) {
          host.innerHTML = banner('warn', '本机引擎已启动；系统层拦截需要提权：' + skipped.map(function (item) { return item.side + ':' + item.reason; }).join('；'));
        }
        engineBusy = false;
        paintEngineButtons();
        return state.tab === 'proxy' ? loadProxyTab() : refreshOverview();
      })
      .catch(function (error) {
        engineBusy = false;
        paintEngineButtons();
        host.innerHTML = banner('err', (running ? '停止' : '启动') + '代理引擎失败：' + error.message +
          (running ? '（可以再点一次重试；仍不行就停掉守护进程，它会一并拆除引擎）' : ''));
      });
  }
  el('engine-toggle').onclick = toggleProxyEngine;
  el('proxy-engine-toggle').onclick = toggleProxyEngine;
  el('lifecycle-save').onclick = saveLifecycle;
  // Any toggle means "this form is mine now": the 4 s refresh stops refilling it
  // until the save succeeds (review C-P2-3).
  el('lifecycle-rows').addEventListener('change', function () { state.lifecycleDirty = true; });

  // Re-probe while the user edits host/port: 800 ms after the last keystroke, and
  // only on the proxy tab (the inputs are hidden elsewhere).
  var pingDebounce = null;
  function queuePing() {
    if (state.tab !== 'proxy') return;
    if (pingDebounce !== null) clearTimeout(pingDebounce);
    pingDebounce = setTimeout(function () { pingDebounce = null; refreshPing(); }, 800);
  }
  el('proxy-socks-host').addEventListener('input', queuePing);
  el('proxy-socks-port').addEventListener('input', queuePing);
  // Dirty tracking: the proxy tab is the only editable form on this page, and a
  // drift-banner refresh must not silently throw the edit away (review C3 P1-3).
  // Editing is the save: every change (socks 行/端口/规则表) re-validates and, once
  // the form is complete, writes the table and starts the engine if it was down.
  el('proxy-socks-host').addEventListener('input', scheduleProxySave);
  el('proxy-socks-port').addEventListener('input', scheduleProxySave);
  el('proxy-listen').addEventListener('input', scheduleProxySave);
  el('proxy-rules').addEventListener('input', scheduleProxySave);
  el('proxy-rules').addEventListener('change', scheduleProxySave);
  el('proxy-add').onclick = function () {
    var rules = (state.view && state.view.rules ? state.view.rules.slice() : []);
    rules.push({ id: 'user-' + Math.random().toString(36).slice(2, 9), program: '', hosts: '', ports: '*', enabled: true, source: 'user', shadow: false });
    renderProxyTab(Object.assign({}, state.view || {}, { rules: rules }));
    scheduleProxySave();
  };
  el('bridge-restart').onclick = function () {
    api('/v1/action', { method: 'POST', body: { action: 'redirector-restart', cwd: state.cwd } })
      .then(function (response) {
        // The action result lives under result: reading response.started always
        // found nothing and reported "需要提权" even after a successful restart
        // (review C-P1-3).
        var result = (response && response.result) || {};
        var skipped = Array.isArray(result.skipped) ? result.skipped : [];
        var started = Array.isArray(result.started) ? result.started : [];
        var text = started.length > 0
          ? '已按新规则重启（' + started.join(',') + '）'
          : '需要提权：' + JSON.stringify(skipped.length > 0 ? skipped : (result.stopped || {}));
        el('proxy-banner').innerHTML = banner(started.length > 0 ? 'ok' : 'warn', text);
      }).catch(function (error) { el('proxy-banner').innerHTML = banner('err', error.message); });
  };
  el('bridge-download').onclick = downloadBundle;
  el('bridge-upload').onclick = function () { el('bridge-file').click(); };
  el('bridge-file').onchange = function (event) {
    var file = event.target.files && event.target.files[0];
    uploadBundle(file);
    event.target.value = '';
  };
  el('proxy-log-toggle').onclick = logToggle;
  el('proxy-rules').onclick = function (event) {
    var remove = event.target.getAttribute('data-remove');
    if (remove === null) return;
    var rules = rulesFromTable();
    rules.splice(Number(remove), 1);
    renderProxyTab(Object.assign({}, state.view || {}, { rules: rules }));
    // Deleting is an edit like any other: schedule the write, otherwise the table on
    // screen and the table the engine uses diverge until the next keystroke.
    scheduleProxySave();
  };
  el('projects').onclick = function (event) {
    var button = event.target.closest('[data-stop-program]');
    if (!button) return;
    var cwd = button.getAttribute('data-cwd');
    var id = button.getAttribute('data-stop-program');
    api('/v1/programs', { method: 'POST', body: { cwd: cwd, action: 'stop', id: id } })
      .then(loadProjects).catch(function (error) { alert(error.message); });
  };
  el('debugs').onclick = function (event) {
    var stop = event.target.closest('[data-stop-debug]');
    if (stop) {
      api('/v1/debug', { method: 'POST', body: { action: 'stop', cwd: stop.getAttribute('data-cwd'), id: stop.getAttribute('data-stop-debug') } })
        .then(loadDebugs).catch(function (error) { alert(error.message); });
      return;
    }
    var forget = event.target.closest('[data-forget-debug]');
    if (forget) {
      if (!window.confirm('清除这条调试记录？断点集合也会一起丢失。')) return;
      api('/v1/debug', { method: 'POST', body: { action: 'forget', logPath: forget.getAttribute('data-forget-debug') } })
        .then(loadDebugs).catch(function (error) { alert(error.message); });
      return;
    }
    var detach = event.target.closest('[data-detach]');
    if (!detach) return;
    api('/v1/debug', { method: 'POST', body: { action: 'detach', logPath: detach.getAttribute('data-detach') } })
      .then(loadDebugs).catch(function (error) { alert(error.message); });
  };

  // Which tab to open: an explicit ?tab= wins (handy for tests/docs), a plain
  // entry (the dsh ⧉ deep-links with only ?cwd=, m11345) and a reload both fall
  // back to the tab the user was last on (m10900). Same for the workspace:
  // showTab/selectIdeWindow write localStorage, so a shortcut- or toolbar reload
  // keeps both.
  var TAB_STORAGE = 'risd.tab';
  var requestedTab = 'overview';
  try {
    var wanted = new URLSearchParams(location.search).get('tab');
    if (wanted === 'ide' || wanted === 'proxy' || wanted === 'overview') {
      requestedTab = wanted;
    } else {
      var savedTab = localStorage.getItem(TAB_STORAGE);
      if (savedTab === 'ide' || savedTab === 'proxy' || savedTab === 'overview') requestedTab = savedTab;
    }
  } catch { /* no URL API / no storage */ }
  el('ide-side-toggle').onclick = function () {
    localStorage.setItem('risd.ideSide', sideVisible() ? 'off' : 'on');
    applySide();
  };
  // Clicking anywhere outside the iframe puts the caret back into the embedded
  // IDE. A cross-origin iframe swallows clicks inside itself, so any click that
  // reaches this document means the user left the IDE: refocus it. (Clicks on the
  // workspace list run first; focus moves after the switch has been applied.)
  document.addEventListener('click', function (event) {
    if (state.tab !== 'ide') return;
    var frame = el('ide-frame');
    if (!frame || event.target === frame) return;
    focusIdeFrame();
  }, true);
  applySide();
  // Coming back to the tab must resume the log tail immediately, and hiding the
  // page must stop it (review C-P2-3).
  document.addEventListener('visibilitychange', function () { syncLogTimer(); syncPingTimer(); });

  // ---- 页面代码漂移 / 令牌漂移（m09693、review C3-P1-3）----
  // 以前 loaded 变化直接 location.reload()：代理规则表正在编辑时刷新会丢失输入，
  // 内嵌 IDE iframe 的 beforeunload 在跨源页面里还不弹。现在只提示，刷新由用户点。
  function showDrift(text, mode) {
    var box = el('ui-drift');
    if (!box) return;
    var message = String(text || '');
    if (message !== '' && message === driftDismissedFor) return;
    driftMessage = message;
    driftMode = mode === 'restart' ? 'restart' : 'reload';
    var label = el('ui-drift-text');
    if (label) label.textContent = message;
    var button = el('ui-drift-reload');
    if (button) {
      button.disabled = false;
      button.textContent = driftMode === 'restart' ? '重启并刷新' : '刷新';
      button.title = driftMode === 'restart' ? '先重启 daemon，再重新加载本页' : '重新加载本页';
    }
    box.hidden = false;
  }
  function hideDrift() {
    var box = el('ui-drift');
    if (box) box.hidden = true;
  }
  // The embedded IDE lives in a cross-origin iframe, so the only way to know
  // whether a reload would drop unsaved editor buffers is to ask it over
  // postMessage (m10900). The iframe answers only its own parent (see
  // lib/client.js), and a frame that predates the bridge simply does not answer
  // — treated as "unknown", which never triggers an automatic reload.
  var ideAskState = { seq: 0, waiting: {} };
  function ideFrameWindow() {
    var frame = el('ide-frame');
    if (!frame) return null;
    try { return frame.contentWindow; } catch { return null; }
  }
  function askIdeDirty() {
    var target = ideFrameWindow();
    if (target === null) return Promise.resolve(0);
    var requestId = 'dirty-' + (ideAskState.seq += 1);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete ideAskState.waiting[requestId];
        resolve(null);
      }, 1500);
      ideAskState.waiting[requestId] = { resolve: resolve, timer: timer };
      try {
        target.postMessage({ type: 'dsh-ris-ide:probe-dirty', requestId: requestId }, '*');
      } catch {
        clearTimeout(timer);
        delete ideAskState.waiting[requestId];
        resolve(null);
      }
    }).then(function (data) {
      if (data === null || typeof data.count !== 'number') return null;
      return data.count;
    });
  }
  function askIdeSaveAll() {
    var target = ideFrameWindow();
    if (target === null) return Promise.resolve(false);
    var requestId = 'save-' + (ideAskState.seq += 1);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete ideAskState.waiting[requestId];
        resolve(null);
      }, 20000);
      ideAskState.waiting[requestId] = { resolve: resolve, timer: timer };
      try {
        target.postMessage({ type: 'dsh-ris-ide:save-all', requestId: requestId }, '*');
      } catch {
        clearTimeout(timer);
        delete ideAskState.waiting[requestId];
        resolve(null);
      }
    }).then(function (data) { return data !== null && data.ok === true; });
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data === null || typeof data !== 'object') return;
    if (data.type !== 'dsh-ris-ide:dirty-report' && data.type !== 'dsh-ris-ide:save-all-done') return;
    var pending = ideAskState.waiting[data.requestId];
    if (pending === undefined) return;
    delete ideAskState.waiting[data.requestId];
    clearTimeout(pending.timer);
    pending.resolve(data);
  });

  // The drift bar can offer a save-all when the embedded IDE holds drafts: a
  // reload would otherwise silently drop them (the iframe's beforeunload does
  // not run for a cross-origin reload).
  function setDriftSave(count) {
    var button = el('ui-drift-save');
    if (!button) return;
    button.hidden = !(typeof count === 'number' && count > 0);
    button.disabled = false;
    button.textContent = '保存所有文件';
  }
  function driftSaveThenReload() {
    var button = el('ui-drift-save');
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    askIdeSaveAll().then(function (saved) {
      if (saved !== true) {
        if (button) { button.disabled = false; button.textContent = '保存所有文件'; }
        showDrift('有文件没保存成功：先在开发环境里处理，再点「重启并刷新」', driftMode);
        return;
      }
      if (driftMode === 'restart') { restartDaemon(); return; }
      location.reload();
    });
  }
  // m11421: 插件版本更新后，旧 daemon 进程里 import 过的模块不会变，光刷新页面
  // 只会再拿到一份旧代码。这里让 daemon 自己交接重启（保留代理引擎），等新 instance
  // 出现在免认证的 /v1/health 上，再刷新本页。
  function restartDaemon() {
    var button = el('ui-drift-reload');
    if (button) { button.disabled = true; button.textContent = '重启中…'; }
    var previous = PAGE_INSTANCE;
    showDrift('插件版本已更新：正在重启 daemon，完成后本页会自动刷新…', 'restart');
    api('/v1/restart', { method: 'POST' }).catch(function () { /* 进程退出会切断这个请求，属正常 */ });
    var startedAt = Date.now();
    var timer = setInterval(function () {
      if (Date.now() - startedAt > 30000) {
        clearInterval(timer);
        showDrift('插件版本已更新，但 daemon 重启超时：手动重启后刷新本页', 'restart');
        if (button) { button.disabled = false; button.textContent = '重启并刷新'; }
        return;
      }
      fetch('/v1/health', { headers: { 'x-risd-api-version': '1' } })
        .then(function (res) { return res.json(); })
        .then(function (body) {
          if (body && body.ok === true && body.instance && body.instance !== previous) {
            clearInterval(timer);
            location.reload();
          }
        })
        .catch(function () { /* daemon 还没起来，下一轮再看 */ });
    }, 400);
  }
  function restartDaemonThenReload() {
    if (state.proxyDirty === true && window.confirm('代理规则还没保存，重启并刷新会丢失') !== true) return;
    askIdeDirty().then(function (count) {
      if (count === 0) { restartDaemon(); return; }
      setDriftSave(count);
      if (count === null) showDrift('无法确认开发环境里有没有未保存的文件：先保存，再点「重启并刷新」', 'restart');
      else showDrift('开发环境里有 ' + count + ' 个文件未保存：先点「保存所有文件」，再点「重启并刷新」', 'restart');
    });
  }
  function reloadPage() {
    // Unsaved proxy rules are the only edit on THIS page worth a confirm; the IDE
    // buffers are discovered through the bridge and turned into the save-all button.
    if (state.proxyDirty === true && window.confirm('代理规则还没保存，刷新会丢失') !== true) return;
    askIdeDirty().then(function (count) {
      if (count === 0) { location.reload(); return; }
      setDriftSave(count);
      if (count === null) showDrift('无法确认开发环境里有没有未保存的文件，刷新前请先保存');
      else showDrift('开发环境里有 ' + count + ' 个文件未保存：先点「保存所有文件」，再刷新');
    });
  }
  if (el('ui-drift-reload')) el('ui-drift-reload').addEventListener('click', function () {
    if (driftMode === 'restart') restartDaemonThenReload();
    else reloadPage();
  });
  if (el('ui-drift-save')) el('ui-drift-save').addEventListener('click', driftSaveThenReload);
  if (el('ui-drift-close')) {
    el('ui-drift-close').addEventListener('click', function () { driftDismissedFor = driftMessage; hideDrift(); });
  }
  function checkBuild() {
    return api('/v1/health').then(function (body) {
      if (!body) return;
      // A different instance = a restarted daemon: every token on this page is dead
      // and the HTML is stale. Reloading is the only cure — automatically when that
      // cannot lose work, otherwise with the button (the old page is unusable either
      // way: the daemon rejects its token).
      var stale = (PAGE_INSTANCE && body.instance && body.instance !== PAGE_INSTANCE)
        || (PAGE_BUILD && body.uiBuild && body.uiBuild.loaded && body.uiBuild.loaded !== PAGE_BUILD);
      if (stale) {
        return askIdeDirty().then(function (count) {
          var safe = count === 0 && state.proxyDirty !== true && state.lifecycleDirty !== true;
          if (safe) { location.reload(); return; }
          setDriftSave(count);
          if (count === null) showDrift('daemon 已重启：本页令牌已失效；无法确认开发环境里有没有未保存的文件，刷新前请先保存');
          else if (count > 0) showDrift('daemon 已重启：本页令牌已失效；开发环境里有 ' + count + ' 个文件未保存，先点「保存所有文件」');
          else showDrift('daemon 已重启：本页令牌已失效，点右侧「刷新」');
        });
      }
      var build = body.uiBuild ? body.uiBuild : null;
      if (build === null) { hideDrift(); return; }
      // disk≠loaded = 源码比进程新：刷新拿不到新代码，只能提示重启 daemon。
      if (build.disk && build.loaded && build.disk !== build.loaded) {
        showDrift('插件版本已更新，点「重启并刷新」后生效', 'restart');
        return;
      }
      hideDrift();
    }).catch(function () { /* daemon 忙/重启中：下一轮再看 */ });
  }
  state.buildTimer = setInterval(function () { if (!document.hidden) checkBuild(); }, 5000);
  void checkBuild();
  syncDshTab().then(function (available) {
    // A dsh click asks for the IDE tab; without a live dsh fall back to 概览.
    showTab(requestedTab === 'ide' && available !== true ? 'overview' : requestedTab);
  });
  state.pollTimer = setInterval(function () {
    if (document.hidden) return;
    // The window list feeds the IDE tab and the overview's daemon row; reading it
    // from the proxy tab was wasted work (review C-P2-3).
    if (state.tab === 'ide' || state.tab === 'overview') syncDshTab();
    if (state.tab === 'overview') refreshOverview();
  }, 4000);
})();
</script>
</body>
</html>`
}
