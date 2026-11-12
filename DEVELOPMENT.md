# dsh-ris-ide 开发手册

> 面向开发者/维护者：安装与日常使用请看 [README.md](README.md)。本文件保留架构、路由、命令、配置、里程碑、打包/发布/Jenkins、测试与踩坑。

DSH 右侧栏的 **RIS-IDE 面板**：侧栏「RIS控制台」只放控制台 + 单程序实时日志（轻量、常挂）；完整工作台在**独立窗口**里——文件树/搜索 + 内置 CodeMirror 编辑器 + 调试面板（断点/线程/调用栈/变量/事件）+ 日志实时跟随 + **「本地实例」**（扫描项目里的 Spring Boot 入口与前端 `package.json`，一键启动/停止/看日志，Java 可 JDWP 调试），外加把服务输出写进日志、能被一键停掉的启动包装。

解决的问题：插件的编辑器预览只在**模型 `write`/`edit` 结算且命中该文件**时才自动刷新（#855），而服务日志是外部进程写的，所以打开日志文件永远是静止的；同时插件自带的读取路由读的是**文件开头**（前 512 KiB），长日志看不到新行。

本插件由三部分组成：

| 半边 | 文件 | 内容 |
|---|---|---|
| Host | [lib/index.js](lib/index.js) | `/dsh-ris-ide/*` 路由：`tail`（文件末尾 N 字节，≤512 KiB）、`stop`（按 `<log>.pid` 停服务）、`programs`/`start`/`config`（`instances` 为 legacy，仅为旧链接保留）、`tree`/`search`/`fs/*`（文件树/搜索/读写/建删移复制）、`debug/*`（JDWP）、`stream`（SSE）、`opens`（待打开队列）。全部只接受 loopback + 同源请求 |
| Client | [lib/client.js](lib/client.js) | 注册官方右侧栏 tab「RIS控制台」（`sidebarRightTabs` + `sidebar.right.pane.tab`，`compact` 形态 = 控制台行 + 单程序日志）；完整工作台（文件树/搜索、内置 CodeMirror 编辑器（懒加载 chunk）、调试 UI（断点/线程/调用栈/变量/事件多页签）、日志跟随（tail + SSE））由同一个文件在独立窗口 `mountStandalone()` 里渲染；「本地实例」启停/配置、`/opens` 打开请求轮询 |
| Script | [bin/run-with-log.sh](bin/run-with-log.sh) / [run-with-log.ps1](bin/run-with-log.ps1) | 启动服务并把输出 `tee` 到日志文件，同时写 `<log>.pid`；trap 转发 TERM 给服务子进程（Windows 用 PowerShell 包装 + `taskkill /T`） |

浏览器半边**优先**走本插件的 tail 路由；该路由不可用时自动退回插件自己的 `GET /dsh-ris-ide/fs/read`（头部模式），并在状态栏里说明，不会假装在跟随。

---

## 1. 安装（打包 → `dsh plugin add`）

```bash
# 打包（在包目录里）。受限沙箱下 npm 需要可写的 cache，故显式指定；
# 提权会话里裸 `npm pack` 亦可。
cd <repo>
npm pack --cache <cache-dir> --logs-dir <log-dir>
# -> dsh-ris-ide-<version>.tgz

# 安装进 web profile（写 $HOME/.dsh，需要提权/或由你手动执行）
dsh plugin --profile web add <repo>/dsh-ris-ide-<version>.tgz
```

实测（DSH 0.2.x `rc`）：`dsh plugin add` 会把包写进 `dependencies`，**并自动把 `dsh-ris-ide` 追加到 `dsh.profile.bundles`**，不需要手工补清单。**挂载**由本包的 `dsh.bundle.patch`（[cordis.patch.yml](cordis.patch.yml)）在 profile 启动时合并成一个 Loader 行：

```yaml
- insert:
    - id: ris-ide
      name: 'dsh-ris-ide'
```

**版本号规则**：`里程碑.大更新.日常更新`（X.Y.Z）——X 只给里程碑；**Y 用于不向下兼容或改动内容较多**（升 Y 时 Z 归零）；Z 是日常更新（新功能/修复/小改）。

两个实测坑：

1. **改了内容必须提版本号**。同样的 tarball 路径第二次 `add` 时 pnpm 会打印 `Lockfile is up to date, resolution step is skipped` 直接跳过，装进 node_modules 的仍是旧副本（本次 0.1.0 → 0.1.1 就是这么修的）。改完代码 → 改 `package.json` 的 version → 重新 pack → 再 add。
2. **Loader 行名必须等于包名**（`name: 'dsh-ris-ide'`）。client-modules 用"最近的 package manifest 名 vs Loader specifier"判定客户端行；写成别名会让 host 半生效、浏览器半边静默不出现（`row id` 才可以取短别名，如 `ris-ide`）。

### 1.1 运行时依赖（DSH 官方右侧栏，不依赖第三方 sidebar）

**只依赖 DSH 自带的客户端 UI 服务**（`peerDependencies` 里声明、`optional`）：`@deepseek-ai/dsh-client-ui-sidebar-right`（`sidebarRight` / `sidebarRightTabs`）与 `@deepseek-ai/dsh-client-ui-slots`（`slots`）。面板用 `sidebarRightTabs.register(...)` + `sidebar.right.pane.tab` 槽挂进官方右侧栏；文件读写、CodeMirror 编辑器、日志查看器全部是插件自带，**与 `dsh-better-sidebar` 无关**（1.2.46 起完全解耦）。

| 半边 | 注入的服务 | 缺 service 时 |
|---|---|---|
| Host（`lib/index.js`） | `webServer` / `sessions` / `tools` | **照常工作**：`ris_dev_*` 命令、`/dsh-ris-ide/*` 路由（含 `/fs/*`）、启停/日志/调试都不受影响 |
| Client（`lib/client.js`） | `sidebarRight` / `sidebarRightTabs` / `slots` | **完全不加载**（cordis 的 `inject` 不满足就不 apply）：右侧栏不会出现「RIS-IDE」tab |

`optional: true` 只是为了允许"只装 host 半边"的部署（headless / 只给 agent 用）；GUI 场景这两个服务随 DSH 自带，正常安装即可。

**激活需要重启 GUI 进程**（`dsh web`）——composition 在启动时组合一次；重启会结束当前会话，所以请你自己执行。重启后确认：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:3080/dsh-ris-ide/tail?sessionId=<会话id>&path=<绝对日志路径>&bytes=1024"
# 期望 200（403 = Host/Origin 不在 loopback，404 = 路由没挂上 → 该行没生效）
```

卸载：

```bash
dsh plugin --profile web remove dsh-ris-ide   # 同时会移除 bundles 条目
# 重启 GUI
```

## 1.5 Windows（支持，运行时自动选）

Windows 上插件**自动选择**启动包装器（Loader 配置可强制：`runtime: "auto" | "bash" | "powershell"`）：

| runtime | 用什么 | 适用 |
|---|---|---|
| `auto`（默认） | **原生 PowerShell**（`bin/run-with-log.ps1`） | 所有 Windows 机器 |
| `bash` | `bin/run-with-log.sh`（POSIX wrapper + MSYS 路径转换） | 显式指定、且装了 Git Bash |
| `powershell` | `bin/run-with-log.ps1`（零依赖，PowerShell 5.1+） | 与 `auto` 相同（显式） |

> 2026-11-09 Windows 复核：`auto` 以前优先 Git Bash，但 `.sh` 包装器把 `C:\...`
> 原样交给 `mkdir`/`cd`，MSYS 会把盘符和反斜杠当普通字符（`mkdir -p 'C:\x'`
> 创建名为 `C:\x` 的文件、`cd 'C:\x'` 失败）。因此默认改为 PowerShell（无需
> 路径转换）；显式 `runtime: "bash"` 时 `buildStartSpec` 会把 `mkdir`/`cd` 的
> 参数转成 `/c/...`（JVM 的 `-D` 路径仍保持 Windows 拼写，因为 JVM 是 Windows
> 二进制）。**Git Bash 分支仍未在真机 Windows 冒烟**，优先用默认。

- **自定义 `startCommand` 的方言与引号**：命令交给**当前 runtime 的 shell**执行——`powershell`（含 `auto`）是 `cmd.exe /d /s /c "<命令原样>"`，`bash` 是 `bash -lc '<命令>'`。因此：
  - `powershell` 下**必须写 cmd 语法**：`%VAR%` 而不是 `${VAR}`，不能有 `$(...)`/`${...}`/`exec`。命中这些 bash 特征时启动会**直接失败并在日志里给出明确提示**（`--- <name> failed to start: startCommand uses bash command substitution $(...) ... Set runtime to "bash" ... ---`），而不是静默跑坏命令；需要 bash 方言就把该程序的 `runtime` 设为 `bash`（需 Git Bash，`mkdir`/`cd` 的参数会自动转 `/c/...`，JVM `-D` 路径保持 Windows 拼写）。
  - 引号按 cmd 语义传递：整条命令包一层引号（`/s` 只剥外层），**命令内部的 `"` 原样保留**；cmd 不认识 `\"`，所以不要再手工转义；单引号在 cmd 下只是普通字符，不表示引用。
  - 包装器脚本 `bin/run-with-log.ps1` 保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，中文注释/字符串会被拆行拆坏（这一点已在真机验证）。

- **进程校验**：Windows 用 `Get-CimInstance Win32_Process` 读命令行，确认是 `run-with-log.ps1` / `run-with-log.sh` 才允许停；
- **停止**：Windows 没有 POSIX 信号/进程组 ⇒ `taskkill /PID <wrapperPid> /T /F`，`/T` 杀整棵进程树（wrapper + java/vite + 孙进程），端口一定释放；
- **Git Bash**：只认真正的 Git Bash（`C:\Program Files\Git\bin\bash.exe` 或 PATH 里的 `bash.exe`），**跳过 System32 下的 `bash.exe`**（那是 WSL 启动器，pid/路径都不在 Windows 空间，停不掉也校验不了）。可用 `DSH_RIS_DEV_BASH` 环境变量或 Loader 配置 `bashPath` 指定；
- **WSL**：不直接支持（跨 pid/路径命名空间）。要在 WSL 里跑就用自定义命令绕过：`startCommand: "wsl.exe -e bash -lc 'cd /mnt/c/... && exec java ...'"`，由 PowerShell 包装 + `taskkill /T` 收尾；
- **依赖**：`mvn.cmd` / `java.exe` / `pnpm.cmd|npm.cmd|yarn.cmd` 在 PATH 上；
- **状态**：`run-with-log.ps1` **尚未在真机 Windows 实测**（开发机是 Linux）。能自动验证的只有数据层：`windowsStartSpec()`（Spring 命令/classpath `;`/JDWP 参数/`${JDWP_ARGS}` 替换）、`resolveWindowsRuntime()`、`pickGitBash()`（跳过 WSL 的 `System32\bash.exe`）、`taskkillTree()` 的调用参数；**脚本本体（PowerShell 语法、`Get-CimInstance`、`ProcessStartInfo` 引号、pidfile 写入时机）只能靠真机跑一次确认**。第一次用请打开「日志」确认出现 `--- exec: ... ---` 与 `--- … exited … ---`，有问题把这两行贴出来最快定位。
- **Windows 上已知的行为差异（不影响启停/调试）**：
  - 内存闸门**不生效**（`MemAvailable` 来自 `/proc/meminfo`，Windows 读不到 ⇒ 视为未知，不拒绝启动）；
  - 控制台**不显示每个程序的内存**（`VmRSS` 同理；为每行起 `Get-Process` 太贵，刻意不做）；
  - 日志轮转在文件被 JVM 独占时不生效（`truncate` 失败 → 返回 false，**不会**影响启动；下次启动前通常能轮转）；
  - 停止是 `taskkill /T /F`（硬杀）：pidfile 由脚本 `finally` 清理，硬杀时可能残留一条**已失效**的 pidfile，`readService` 会用存活探测判定为「未运行」，重启会覆盖它。

## 1.6 ProxyBridge 组件（首次使用时下载/上传，1.8.1 起不再随包发布）

系统层拦截依赖的 ProxyBridge 不再随插件打包（2.9 MB 二进制，且把上游版本钉死）：仓库里只保留下载/上传、校验与安装逻辑（`lib/proxybridge-bundle.js`），首次使用时把 `.tgz` 装进机器级缓存 `~/.dsh-ris-ide/proxybridge/bundle/`，之后复用。

| 平台 | 缓存内文件 | 版本 | 来源 |
|---|---|---|---|
| Windows | `bundle/windows/ProxyBridge_CLI.exe`、`ProxyBridgeCore.dll`、`WinDivert.dll`、`WinDivert64.sys` | v4.3.0 | 上游 `InterceptSuite/ProxyBridge` release（MIT），WinDivert（LGPL-3.0） |
| Linux/WSL | `bundle/linux/ProxyBridge`、`libproxybridge.so` | v4.0.0 | 同上 |

- **下载/上传入口**：risd 维护页「代理 → 组件」（`http://127.0.0.1:11082/ui?tab=proxy`）点「下载」，或上传 `ris-proxy.4.0.tgz`。卡片只在**未安装/下载中/下载失败**时显示下载地址、下载与上传按钮；安装完成后只留「已安装 · 文件 8 个 · 目录」一行。代码层入口是 `ensureBundleReady({url, fetchImpl, force})`（`lib/redirector.js`）→ `ensureBundle()`；**永不抛**，返回 `{ok, dir, fromCache, error, url, hint}`，路由层据此给 200/502。
- **URL 优先级 / 双镜像**：显式 `url` → `~/.dsh-ris-ide/settings.json` 的 `proxybridgeUrl` → 环境变量 `DSH_RIS_IDE_PROXYBRIDGE_URL` → 内置镜像对 `BUNDLE_URLS`。两个内置地址指向**同一份** release 附件（`ris-proxy.4.0.tgz`，随 1.8.1 发版）：**Gitee 优先**（主仓库），失败自动换 GitHub（镜像）——`ensureBundle()` 顺序重试，全部失败才报错且错误里带每个地址的原因（`tried[]`）；显式配置地址时只试那一个。只允许 https（http 仅回环地址）。
- **缓存与校验**：`manifest.json` 记录 8 个文件的大小与 sha256；`isInstalled()` 要求文件齐全且大小一致（篡改/缺文件即失效）。`force:true` 强制重下；下载失败不写缓存，下次调用重试。tgz ≤16 MB、解压后 ≤64 MB，拒绝绝对路径/`..`/符号链接/硬链接。
- **查找顺序**（`redirectorCandidates()`）：`DSH_RIS_IDE_PROXYBRIDGE` 覆盖 → 下载缓存（`~/.dsh-ris-ide/proxybridge/bundle/{windows|linux}`）→ 机器级手工解压目录（`~/.dsh-ris-ide/proxybridge/vendor/`，兼容旧安装）→ Windows 已安装的 `Program Files`（c/d/e/f 盘）或 `/mnt/{d,c,e}`。**已安装的下载缓存永远排第一**，因此卸载系统里已装的 ProxyBridge 不影响插件。
- **未安装时的诊断**：`findRedirector()` 返回 `missingBundle: true` 与 `reason`（含「维护页 → 代理 → 组件」入口和默认下载地址）；`prepareWindowsBundle()` 在组件未安装时返回 `undefined`（不是永远不存在的路径）；`startRedirector`/`syncRedirector`/`startRedirectors` 把该 reason 透传给调用方，不静默失败。
- **Windows 侧落盘（materialise）**：Windows 进程读不了 WSL 路径，所以物料化发生在 Windows 可见的目标上——把 `bundle/windows/` 复制到 `%LOCALAPPDATA%\dsh-ris-ide\proxybridge\windows`（WSL 经 `/mnt/c` 访问同一位置），此后候选第一项就是那里的 `ProxyBridge_CLI.exe`；纯 Linux（无 `/mnt/c`）不落盘，直接使用缓存路径。要点：
  - **何时刷新**：每个文件按 **size + mtime** 判断（复制后把目标 mtime 覆盖成源 mtime），重下后即使字节数相同也会重新复制；`force: true` 可强制重来。
  - **失败不缓存**：缺 `%LOCALAPPDATA%`/文件被占用等失败只写一行日志并回退到缓存路径/已安装副本，下一次调用会重试（`%LOCALAPPDATA%` 探测失败 60s 后重试）。
  - **许可文本随副本走**：`NOTICE.md` 与 `LICENSE-ProxyBridge.txt` 从缓存根目录一并复制到目标目录（WinDivert 为 LGPL，重新分发需要它们）。
  - `%LOCALAPPDATA%` 由 `cmd.exe /d /s /c echo %LOCALAPPDATA%` 取得并转成 `/mnt/c/...` 读写；非 WSL 的 Linux 会直接跳过并只提示一次。
- **单侧启动**：Windows 主机没有第二台机器，`startRedirectors()` 在 win32 只跑 `['windows']` 一侧；WSL 仍跑 Windows 与本地两侧（两个独立引擎）。
- **许可**：缓存根目录的 `NOTICE.md` 记录上游、版本与许可；ProxyBridge 为 MIT（`LICENSE-ProxyBridge.txt`），WinDivert 为 LGPL-3.0（未修改的 DLL/SYS，源码见 `https://github.com/basil00/WinDivert`）。仓库与 npm tarball 不再包含这些二进制。
- **已安装版本仍然兼容**：`ProxyBridgeSvc` 的 park/restore 逻辑不变；服务不存在时按「无需还原」处理。

## 1.7 打包 / 发布（Nexus）/ 安装（Jenkins 流水线）

### 1.7.1 本地或 Jenkins 上的打包命令

```bash
# 1) 依赖（devDependencies 里有 tsdown + @codemirror/*，是 chunk 的构建输入）
npm install --no-audit --no-fund          # 有 package-lock.json 时用 npm ci

# 2) 构建编辑器 chunk（core client 是手写单文件，不需要构建）
npm run build                             # → lib/client-codemirror.js（约 1.13 MB / gzip 324 KiB）
test -s lib/client-codemirror.js

# 3) 测试
npm test                                  # node --test --test-timeout=120000 "test/*.test.mjs"

# 4) 出包
mkdir -p dist && npm pack --pack-destination dist
#   → dist/dsh-ris-ide-<version>.tgz    （含 lib/、bin/、skills/ 与 cordis.patch.yml）
```

**包管理器**：构建/发布统一用 **npm**（仓库没有 lockfile；pnpm 只多一层 corepack/环境依赖，收益不大）。
Jenkins 工作区会跨 tag 复用，旧构建残留的 `node_modules` 会让 `npm install` 变成 no-op ⇒ 流水线提供
`CLEAN_NODE_MODULES`（默认开）：构建前先 `rm -rf node_modules` 再安装。

**依赖与 CI**：仓库里已提交构建产物 `lib/client-codemirror.js`，Jenkins 构建时**不装 devDependencies**（内网 registry 可能解析不到 `@codemirror/*`/`tsdown`）；只有 chunk 缺失、需要现构建时才安装。工作区残留的未跟踪 `package-lock.json` 会被自动删除（避免 `npm ci` 用旧锁解析失败）。

**测试与 CI（可移植性红线）**：`npm test` 只跑 `node --test --test-timeout=120000 "test/*.test.mjs"`，**不装依赖、不联网、不读任何本机/内网路径**——裸克隆 `git clone && npm test` 就能跑（`test/harness.test.mjs` 会守住这条）：

- 测试只 import `node:*` 内置模块与 `../lib/*.js`；`react` / `react-dom` 是 **devDependencies**，`npm install` 后从公开 registry 拿到，不是必需项；
- 真实 React 的寻找顺序（`test/client-viewer.test.mjs` 的 `findReactRoot()`）：`DSH_RIS_IDE_REACT_ROOT` → **本仓库 `node_modules`** → **同级 checkout**（`../tools/dsh-better-sidebar/node_modules`、`../dsh-better-sidebar/node_modules`，按文件位置相对解析）→ 都没有就回退 stub；
- 回退 stub 时**依赖 SSR 的用例自动 skip**（不是失败），所以没装依赖的机器上仍然全绿；旧 tag（<1.2.45）的测试没有这层保护，发旧版需勾 `SKIP_TESTS`。
- Jenkins 上测试会通过 `BASH_ENV` 把当前 PATH 补回 `bash -lc`（登录 profile 可能丢 node/npm，导致启动类用例 127）；`defaultSpringArgs` 用例用临时 workspace，不依赖本机路径。

`npm init` 时若 `$HOME` 不可写，给 npm 指一个工作区内的缓存（流水线里已设）：

```bash
npm pack --cache "$PWD/.npm-cache" --logs-dir "$PWD/.npm-logs" --pack-destination dist
```

### 1.7.2 发布到 Nexus（npm hosted 仓库）

> 内网主机名、账号口令、Jenkins 凭据值都属于内部信息：**只写在内部运维手册里，不提交进本仓库**；下面用 `<internal-nexus>` / `<internal-git>` 占位。

内网 Nexus 里有三个 npm 仓库（**主机地址与凭据只记在内部《运维手册》，本仓库不公开**）：

| 用途 | 地址 |
|---|---|
| 正式（tag / 正式版本） | `<internal-nexus>/repository/npm-releases/` |
| 快照（dev 构建） | `<internal-nexus>/repository/npm-snapshot/` |
| group（安装侧读取） | `<internal-nexus>/repository/npm-public/` |

- 发布账号 = Jenkins 用户名/密码凭据 id `nexus`（运维侧保存）；**密码不写进仓库/脚本**，构建期生成一次性 `.npmrc`（600，退出即删）。
- **读**：`npm-public` 已开**匿名只读**（2026-10-21）⇒ 安装/`npm view` 不需要凭据，只需把 registry 指过去；**写**（publish）仍要 `nexus` 凭据。
- 注意：**pnpm 不认 `NPM_CONFIG_REGISTRY`/`npm_config_registry` 环境变量**（实测），必须用 `.npmrc`（或 CLI `--registry` 参数）。
- `package.json` 不能有 `"private": true`（npm publish 直接拒绝）；本包已移除。**历史 tag 里带 `private` 时流水线会自动改 false**（修改版本号 stage），不要求回改历史。
- 版本号规则沿用 `里程碑.大更新.日常更新`（本机细节见内部开发手册）；Nexus 拒绝覆盖同版本 ⇒ 快照构建要带唯一后缀（流水线自动追加 `-SNAPSHOT.<BUILD_NUMBER>`）。
- 构建产物 `lib/client-codemirror.js` **已提交进仓库**；只有改过 `src/chunks/codemirror.js` 时才需要 `npm run build` 并一起提交（流水线检测到已提交 chunk 就跳过安装/构建）。
- **npm 12 起**：prerelease 版本（快照的 `-SNAPSHOT.<n>`）必须显式 `--tag`（流水线用 `--tag snapshot`），否则 `npm publish` 直接报 `You must specify a tag`。
- 验证发布结果：`npm view dsh-ris-ide`（匿名可读）或 Nexus 页面 / Jenkins 日志；发布账号只用写权限，**不要求读权限**。
- **发布现状**：latest 由最近一次发版移动（当前为 **1.7.0**）；`legacy` 留给更低版本，旧号只作历史参考。

手工发布（本机/脚本验证用；正式发版仍走 Jenkins）：

```bash
REGISTRY=<internal-nexus>/repository/npm-snapshot/   # 正式改为 npm-releases
HOST="${REGISTRY#https://}"; HOST="${HOST%%/*}"
REPO_PATH="/${REGISTRY#*://*/}"; REPO_PATH="${REPO_PATH%/}/"
umask 077
{ echo "registry=$REGISTRY"; echo "//${HOST}${REPO_PATH}:_auth=$(printf '%s:%s' "$NEXUS_USER" "$NEXUS_PASS" | base64 | tr -d '\n')"; } > .npmrc
npm publish --registry "$REGISTRY"
rm -f .npmrc
```

### 1.7.3 Jenkins 流水线（`master_dsh-ris-ide`）

Jenkins 任务脚本在 `ris-jenkins/master_dsh-ris-ide`（与该仓库其它 `master_*` 任务同目录）。**本任务只发布正式版**（`npm-releases`），不涉及快照。只做这几件事，**没有 k8s / 没有上传 zip / 没有 maven deploy/rollback**：

| stage | 做什么 |
|---|---|
| 拉取 | `gitParameter`（`PT_TAG`）从内部 Git（gogs，地址见内部运维文档）**`<internal-git>/dsh-ris-ide.git`** 的 tag 列表里选版本并 checkout；**只列 master 分支上的 tag**（`branchFilter: origin/master`）。仓库根是插件就用根，是整包仓库则自动切到 `dsh-ris-ide` |
| 修改版本号 | **版本号 = 选中 tag**（`v1.7.0` → `1.7.0`；**必须是 X.Y.Z 正式版，不接受 `-SNAPSHOT` 等后缀**）；选 `origin/master` 分支则沿用 `package.json` 现有版本；`private=true` 直接报错 |
| 编译打包 | 仓库里已带 `lib/client-codemirror.js` ⇒ **跳过依赖安装与构建**（Jenkins 内网 registry 未必有 `@codemirror`/`tsdown`）；否则（chunk 未提交且有 `build` 脚本）`CLEAN_NODE_MODULES`→`npm ci/install`→`npm run build`。随后 `npm test`（无真实 React 时自动 skip；`SKIP_TESTS` 可跳过）→ `npm pack` → 归档 `dist/*.tgz` |
| 发布到 Nexus | `PUBLISH=true` 时用凭据 `nexus` 生成一次性 `.npmrc`（`//host/repository/<repo>/:_auth=…`），`npm ping` 探活后 `npm publish` 到**正式仓库 `npm-releases`**（不碰快照仓库）。**版本低于已发布 latest 时用 `--tag legacy` 发布**（旧 tag 可发，但不会把 `latest` 指回旧版本）；**同版本已存在则跳过发布**（流水线重跑安全，不会被“已发布”卡住） |
| 发布到公网 npm | `PUBLISH_PUBLIC=true`（独立勾选）时本流水线**不直接 publish**，只把干净快照 + 同名 tag 推到 Gitee；公网 npm 由 GitHub Actions 的 **`publish-npm` 工作流用 OIDC 可信发布**跟随新 tag 自动发布（最多延迟约 2 小时）。所以**不再需要 Jenkins 的 `npmjs` 凭据**，也没有 npm token 90 天过期问题。不勾选则完全不访问公网 |
| 同步到 Gitee（含发行版） | 同样由 `PUBLISH_PUBLIC=true` 触发。**发布信息（标题 + 正文）取自 gogs 仓库的「版本发布」**：用凭据 `gogs` 登录 gogs 网页拿会话（gogs 的 `/api/v1` 匿名/basic 都只回 403，必须带登录 Cookie；且没有「按 tag 取 release」的接口，只能列 `releases` 再按 `tag_name` 筛），`name`=标题、`body`=正文；取不到时回退 tag 注释 → 提交说明 → tag 名，且**正文兜底成最近提交列表**（Gitee 对空描述回 400「发行版的描述不能为空」）。把当前版本的**受控文件**（`git archive`，不含构建产物与内网提交历史）做成一个干净单提交（提交信息固定 `dsh-ris-ide <ver>: public release (clean history)`），force push 到 **`https://gitee.com/riscloud/dsh-ris-ide.git`** 的 `master`，并推送与 jk 选中 tag 同名的 **annotated** tag（注释 = 发布信息；从分支构建不建 tag、也不建发行版）。推完 `git ls-remote --tags` 校验，再调 **Gitee OpenAPI v5** 建/更新「发行版」：`POST /repos/riscloud/dsh-ris-ide/releases`（`tag_name`/`name`/`body`/`target_commitish`），同 tag 已存在则 `PATCH …/releases/{tag}`（重跑安全）。凭据 `gitee`：用户名 = Gitee 账号，密码 = 私人令牌（需「发行版/项目写」权限） |

发布前会读正式仓库（以及勾选公网时的 npmjs）现有 `latest`：版本更低时**不移动 `latest`**，改用 `legacy` dist-tag 发布（`dsh-ris-ide@1.2.43` 这样可装，但 `dsh plugin add dsh-ris-ide` 仍装 latest）。

**发版流程**：在 gogs 仓库的 **「版本发布」页**新建发布（**tag 名 = 版本号**如 `1.7.0`，名称 = 发布标题，说明 = 正文 Markdown；gogs 会据此建出同名 tag，轻量 tag 即可）→ Jenkins 选这个 tag、勾 `PUBLISH_PUBLIC` → 插件版本 / tgz 名 / Nexus 版本 / Gitee 发行版 / GitHub Release **全部同一个版本号**，标题也完全相同，正文来自 gogs 那一份。

```bash
# 发布信息只有一个来源：gogs「版本发布」页的 名称（标题）+ 说明（正文，Markdown）。
# 发版前先在 gogs 建好该 release（tag 名 = 版本号，如 1.7.0），再到 Jenkins 选同一个 tag。
# 想让 release 里同时出现包信息，就在说明里写一行，例如：
#   npm i dsh-ris-ide@1.7.0
# Gitee 发行版与 GitHub Release 会原样展示同一份文字（版本号与 tag、npm 包版本一致）。
```

- **发布信息写在 gogs「版本发布」里**（名称 = 标题、说明 = 正文，Markdown）：gogs 建发布时会自动建出同名轻量 tag，**不要求 annotated**；annotated tag 的注释只在取不到 release 信息时作为回退。正文为空会触发 Gitee 400「发行版的描述不能为空」，流水线已兜底成最近提交列表。
- **历史 tag（1.6.x 及更早）不自动回填发布信息**：镜像流程只处理最近 10 个正式 tag，且**没有发布信息（Gitee 发行版与 tag 注释都没有）的 tag 直接跳过**。
- Gitee 的一个坑：查「某 tag 的发行版」`GET /releases/tags/{tag}` 时，**不存在的 tag 也回 HTTP 200 + 正文 `null`**（不是 404），所以流水线按 JSON 里有没有 `tag_name` 判断该 POST 还是 PATCH。
- 同版本重发前先处理 Nexus 上的同版本（否则 `npm publish` 会先失败）；Gitee 的 tag 与发行版会被覆盖更新（PATCH）。

> Gitee 仓库若设置了「导入仓库同步（从 jk 拉取）」，注意两点：Gitee 并未提供触发该同步的 API（OpenAPI v5 无 mirror/sync 端点，只能后台定时或页面手动点），所以流水线采用「直接推干净快照」；且手工点同步会把 jk 的**完整内网提交历史**（含内网地址/账号等旧 blob）公开到 Gitee，建议不要启用自动同步。GitHub 侧完全由 `.github/workflows/mirror-from-gitee.yml` **后台定时拉取**（每 2 小时 cron + 可手动 `workflow_dispatch`，失败重试 3 次），拉取 `git clone --mirror` → `push --mirror`，**分支和 tag 全量同步**；发布流水线不访问 GitHub、不需要任何 GitHub 凭据（GitHub 网络不稳，定时重试更可靠）。
> tag 一致性：内部 gogs 是唯一源头，tag 只在那里打；流水线把**同一个 tag 名**推到 Gitee，GitHub 镜像 `--mirror` 会 1:1 复制 Gitee 的分支与 tag。能保证「名字 + 版本 + 文件内容（tree）一致」；commit hash 不会一致，因为公开仓库必须使用干净的舍弃内网历史的单提交——这是刻意取舍，不是 bug。同版本重发会 force 移动 Gitee 的 tag，但通常 `npm publish` 会先因版本已存在而失败。
> **GitHub Release**：`push --mirror` 只搬运分支和 tag 对象，Release 是平台数据、不会被镜像——镜像工作流第二步按 tag 调 **Gitee 发行版接口**（`GET https://gitee.com/api/v5/repos/riscloud/dsh-ris-ide/releases/tags/{tag}`，**匿名可读**，不需要 token）取 `name`/`body` 建/更新 Release；取不到时回退 tag 注释，两者都没有就跳过。**所以 Gitee 发行版与 GitHub Release 的标题、正文、版本号完全一致，唯一来源是 gogs「版本发布」。**

### 1.7.3 安装到 DSH

```bash
# Linux/macOS 一行安装（Nexus 已开匿名只读：临时 .npmrc 只写 registry；退出/失败自动删除）
REGISTRY=<internal-nexus>/repository/npm-public/
P=~/.dsh/profiles/web; ( printf 'registry=%s\n' "$REGISTRY" > "$P/.npmrc"; trap 'rm -f "$P/.npmrc"' EXIT; dsh plugin --profile web add dsh-ris-ide@1.7.0 )

# Windows PowerShell 一行安装（同上，无凭据；try/finally 保证删除）
$REGISTRY = "<internal-nexus>/repository/npm-public/"
$P="$env:USERPROFILE\.dsh\profiles\web"; try { Set-Content "$P\.npmrc" -Encoding ascii -Value "registry=$REGISTRY"; dsh plugin --profile web add dsh-ris-ide@1.7.0 } finally { Remove-Item "$P\.npmrc" -ErrorAction SilentlyContinue }

# 或从构建产物装（离线机器常用）
dsh plugin --profile web add /path/to/dsh-ris-ide-1.7.0.tgz

# 升级/重装：必须先删除 node_modules 里的副本，否则 pnpm 可能跳过（`Lockfile is up to date` 时尤其）
rm -rf ~/.dsh/profiles/web/node_modules/dsh-ris-ide
dsh plugin --profile web add dsh-ris-ide@1.7.0

# 验证挂载（只读，会重写 profile 的 cordis.yml，需相应权限）
dsh --profile web --dump-config | grep -A2 "id: ris-ide"
```

装完 **重启 `dsh web`**（composition 只在启动时组合一次），浏览器 **硬刷新**（客户端 bundle 按 package 名加载）。
宿主新增的路由（`/fs/*`、`/stream`、`/bundle`、`/search-content`、`/run-test`、`/start` 的 `restart`）只有重启后才存在；否则客户端会回退旧的轮询/内置编辑器。

### 1.7.5 与 `dsh-better-sidebar` 的关系

**不再需要它**：文件 API、编辑器（CodeMirror chunk）与面板宿主都自带/走 DSH 官方右侧栏。
`peerDependencies` 现在只有官方 `@deepseek-ai/dsh-client-ui-sidebar-right` / `@deepseek-ai/dsh-client-ui-slots`（随 DSH 自带，声明为 optional）。
它在 profile 里装着也不冲突（我们不再注册 `log` viewer 或它的 tab）。

## 1.8 上架合规（规则在仓库外的手册里）

本仓库**不写上架说明**，只保证"符合上架规范"：上架规则、目录字段、PR 模板、提交步骤见**仓库外的《DSH 插件上架规则手册》**（`dsh-market` / `dsh.so` 两站，工作区共享文档，不属本仓库）。规则变动时改那边，不用改插件仓库。

仓库内需要长期保持的合规项：

| 项 | 位置 |
|---|---|
| 开源 license + 可识别 SPDX（MIT） | `LICENSE`、`package.json` `license` |
| 公开仓库元数据 `repository` / `homepage` / `bugs` | `package.json` |
| DSH 兼容信号 `dsh.*` / `engines.dsh` / `cordis.patch.yml` | `package.json` |
| `keywords` 含 `dsh-plugin` | `package.json` |
| 双语 `description`（英文句 + 中文句） | `package.json` |
| README：公开 npm 安装命令、截图、能力/权限边界 | `README.md`、`docs/screenshots/` |
| 静态自检（不联网） | `npm run check:listing`（`bin/check-listing.mjs`，15 项：❌0 / ⚠️1——⚠️ 是「公开可达性」需联网复核，不是失败） |

改完这些跑一次：

```bash
npm run check:listing            # 逐条 ✅ / ⚠️ / ❌；有 ❌ 退出码 1
npm run check:listing -- --json  # 机器可读
npm run check:listing -- --net   # 额外联网确认 npm/仓库公开可达（内网会失败）
```

**脚本不是上架的替代品**：license 选哪个、仓库公开不公开、npm 包名怎么定，这些决定项只能人定。

## 2. 让 DSH 启动服务后直接在侧边栏打开日志

模型侧两次工具调用即可（脚本负责「启动 + 落日志 + 打印路径」，随后按**稳定路径**打开日志页）：

```bash
# ① 后台启动（日志同时进 job 输出与文件；脚本先把文件建好再起服务）
bash(
  run_in_background: true,
  command: 'cd <workspace>/<module> && DSH_LOG_DIR=<log-dir> <repo>/bin/run-with-log.sh <name> <启动命令…>'
)
# → started background job <id>；job_output(<id>) 看增量、job_kill(<id>) 停服务（连进程树）

# ② 在工作台日志页打开（路径确定，无需解析上一步输出）
sidebar_open(target: '<log-dir>/<name>.log', title: '<name> 日志')
```

要点：

- **不要用 `terminal_open`/`terminal_send`**（headless agent 终端）：UI 上只有会话卡片，看不到侧边栏。
- **`bash` 每次都是新 shell**：cwd/变量不保留 ⇒ 命令里自带 `cd`；没有 stdin 通道，需要应答 y/n 的交互跑不了。
- **脚本在服务输出前就建好日志文件**（先写 `--- started ---`），所以 `sidebar_open` 不会因「文件还不存在」失败。
- **路径稳定** ⇒ 重启服务不用再开 tab：同一个 tab 继续跟随同一个文件。日志目录用 `DSH_LOG_DIR=<dir>` 指定，默认 `<cwd>/logs`。
- 不想用脚本就自己 `... 2>&1 | tee -a <log>`，差别只是文件不是「启动前就存在」。

## 2.5 「RIS控制台」—— 扫描工作区，一键启动/停止/看日志

右侧栏的「RIS控制台」不是只列在跑的实例：它扫描当前会话工作区，列出所有**可运行的程序**（Spring 入口、前端 dev server、以及扫描没覆盖但有 pidfile 的历史实例），每行给状态与操作按钮：

```
● ris-model-biz  [Spring]  ris/ris-model/ris-model-biz   cn.com.ris.cloud.model.RisModelApplication  [■][⟳][🐞]
○ ris-ui-3       [前端]    ris-ui-3                     pnpm run dev                                [▶][⟳]
○ tick-app       [实例]    logs/tick-app.log            （手工启动、扫描没覆盖的历史日志）          [■]
```

- 行按钮：`▶ 启动` / `■ 停止` / `⟳ 重启`（停止后按同样参数再启动）/ `🐞 调试`（仅 Spring，在独立窗口里以 JDWP 重启并 attach）；**点行**即在该行下方跟它的实时日志（没有单独的「日志」按钮）；启停期间行上有遮罩（文案按动作：启动中/停止中/重启中/调试中）。
- 控制台标题栏：`📄 打开配置` / `⚙ 更新配置` / `⧉ IDE`（独立窗口打开完整工作台）/ `⟳ 重新扫描`；两个以上勾选时出现 `已勾选 N 项` + `▶ 批量启动` / `■ 批量停止` / `清除`（按列表顺序启动、倒序停止，跳过已在运行/已停止的，按钮上显示 `i/N`）。

### 扫描口径（`GET /dsh-ris-ide/programs`，宿主侧执行，两段式）

入口程序和前端清单**都位于靠近顶层的位置**（`project/module`、`project/ui`，一般 2–3 层），深的是 **Java 包路径**：

1. **浅扫（深度 ≤ 5）**：找 `pom.xml`（⇒ Maven 模块目录）与 `package.json`（⇒ 前端候选）；跳过 `src`、`node_modules`、`target` 等噪音目录。
2. **对每个 Maven 模块**：只扫它的 `src/main/java`（包路径可以深，深度上限 12），且只读**类名命中** `Application|App|Main|Bootstrap` 的文件再校验 `@SpringBootApplication`——本机 15 个 Spring 程序全部命中；入口类不按这些词命名时需改名（或改 `ENTRY_JAVA_RE`）。

| 类型 | 判据 | 启动方式 |
|---|---|---|
| `spring` | 模块 `src/main/java` 下的 `@SpringBootApplication` 入口；模块目录 = 该 `pom.xml` 所在目录。运行参数优先取配置，其次 pom profile 推导（`-Pdev`）+ 项目根 `local.yml` | `mvn -Pdev compile` → `exec java -cp "target/classes:$(cat target/cp.txt)" <主类> …` |
| `frontend` | 非 `node_modules` 下的 `package.json`，有 `dev`/`start`/`serve` 脚本；包管理器按最近的锁文件推断 | `exec <pm> run <script>` |
| `instance` | 扫描没覆盖到、但 `<cwd>/logs` 里有 `<name>.log.pid` 的历史实例 | 只能停止/看日志 |

- **打开面板的行为**：宿主先看配置文件——
  - **没有配置** ⇒ 自动扫描并写出 `.dsh-ris-ide/config.json`（status `generated`）；
  - **已有配置** ⇒ 先做**不扫描**的廉价校验（目录在不在、Spring 主类源文件在不在、前端目录还有没有脚本）；不符 ⇒ 重新扫描并**自动更新**配置（`updated`，保留你改过的字段与自定义程序）；相符 ⇒ **直接用配置当程序清单，完全不扫描**（`matched`）。
  - **「重新扫描」**（`?refresh=1`）永远强制扫描，并把结果与配置核对（有差异就顺带更新）。
- 发现结果宿主缓存 15 秒（`refresh=1` 或检测到配置不符时绕过缓存）。
- **启动与项目内容同源**：浏览器只发**程序 id**（`spring:<相对目录>#<主类>` / `frontend:<相对目录>#<脚本>`），宿主重新扫描并拼命令，页面无法让宿主执行任意命令。
- **`exec` 的位置关键**：`exec java …` / `exec <pm> run …` 让 wrapper 的子进程**就是**服务本体，所以「停止」TERM 的是服务本身（不是中间 shell）。

- **降级**：若宿主没有官方 `sidebarRight` 服务（裁剪版 DSH / 只装 host 半边），客户端整体不加载（右侧栏没有入口）；`ris_dev_*` 工具与 HTTP 路由仍然可用。

## 2.6 程序配置：扫描生成 → 你改你加 → 漂移时更新

扫描结果可以**落成一份配置文件**，把启动/停止参数交给你维护：

```
<会话工作区>/.dsh-ris-ide/config.json   # JSONC（允许注释与尾逗号）
```

**生成**：面板头部的 **「生成配置」** → `POST /dsh-ris-ide/config` → 把当前扫描到的每个程序写成一条（带 `id/name/kind/dir/mainClass|script/logName/args/env/startCommand/stopGraceMs/disabled`）。已存在时该按钮变成 **「更新配置」**（见下）；不传 `mode` 而文件已存在会返回 409，绝不静默覆盖。

**你改 / 你加**（字段含义）：

| 字段 | 作用 |
|---|---|
| `name` / `logName` | 面板显示名 / 日志与 pidfile 用的名字（改 `logName` 等于换一份日志） |
| `args` | **应用参数**（主类之后）。Spring 的默认值来自项目入口 pom 的 profile + 项目根 `local.yml`（见下），`.vscode/launch.json` 的 args 会被规范化成同样两条；显式写了就原样使用 |
| `jvmArgs` | **JVM 参数**（`java` 与 `-cp` 之间），如 `["-Xmx2g", "-XX:+UseZGC", "-Dfile.encoding=UTF-8"]`。不写则继承顶层 `defaults.jvmArgs`；都空就不加。放在插件必需的 `-DJM.LOG.PATH`/`-Dcsp.sentinel.log.dir` **之后**，所以你写的 `-D` 可以覆盖它们 |
| `env` | 追加到启动进程的环境变量（`{}` 表示无） |
| `startCommand` | **完整 shell 命令**，给了就完全替换拼装出来的命令（会先 `cd` 到 `dir`，除非你自己以 `cd` 开头） |
| `stopGraceMs` | 停止时 TERM→KILL 的宽限；启动时写进 pidfile 第 4 列，停止按它执行 |
| `disabled` | `true` 隐藏这一条 |
| `dir` + `kind` + `mainClass`/`script` | 定义**自定义程序**（没有 `startCommand` 时用它们拼命令） |

匹配扫描结果与配置条目：**`id` → `dir`(+`kind`) → `name`**。所以改 `name` 仍能匹配上；把程序挪了目录会表现为"旧条目失效 + 新程序出现"（见漂移）。

**漂移检测与更新**：每次 `GET /programs` 都会比较配置与当前扫描，返回 `config.drift = { stale, added, missing, changed, manual }`：

- `added`：工作区里新出现、配置里还没有的程序；
- `missing`：配置里的**自动条目**，对应程序已不存在（带 `startCommand` 的**自定义条目永不判失效**）；
- `changed`：匹配上了但身份字段变了（如 `mainClass`/`script`/包管理器）。

漂移检测的结果现在由面板**自动处理**：检测到不符就重新扫描并调用「更新配置」（`POST /config` `{ mode: "update" }`）——新增程序补上、失效的自动条目删掉、**你改过的字段与自定义程序原样保留**（`mode: "overwrite"` 才是纯重置）。面板会提示「配置已与工作区同步」。手动「更新配置」按钮保留，用于你想立刻重写时。

> 如果程序**挪了目录**导致 `id` 变了：更新后会出现一条新条目，旧的自动条目在下次更新时消失；如果你在旧条目上改过 `env/startCommand` 等，把它们挪到新条目即可（自定义条目因带 `startCommand` 会被保留，不会丢）。

**Spring 的 profile 与 local.yml 从哪来**（`cn.com.ris.cloud` 项目约定）：

| 项 | 来源 |
|---|---|
| `--spring.profiles.active=<profile>` | **项目入口 pom**（`ris/pom.xml` 等）：取 `<profiles>` 里 `<activeByDefault>true</activeByDefault>` 的 `<id>`；没有就取字面量 `<profiles.active>`；只声明 `<parent>` 的模块（`ris-am`、`ris-data`…）沿 parent 链找（`<relativePath>` → 工作区里同名 artifactId 的项目 → `~/.m2/repository`）；都没有则回退 `dev`（RISCloud 约定） |
| `--spring.config.additional-location=file:<路径>` | **项目根**（程序目录的第一段：`ris/`、`ris-am/`、`ris-codegen/`…）下的 `local.yml`；项目根没有则回退工作区根 `local.yml`；都没有就**不加**这条（不会指向不存在的文件） |

`.vscode/launch.json` 里的 args 会被**规范化**成上面两条（本机 launch.json 原来指向工作区根 `local.yml`，对 ris 项目是错的，会被自动纠正），额外的参数（如 `--debug`）保留；如果你在配置里显式写了 `args`，则原样使用。

**启动参数的优先级**（拼命令时）：

1. 配置 `startCommand`（最高，直接执行）；
2. Spring `mainClass`：配置 > `.vscode/launch.json` > 扫描到的注解类；`args`：配置 > `.vscode/launch.json`（规范化）> 默认（项目 pom profile + 项目根 `local.yml`）；
3. `stopGraceMs`：配置 > 全局 `config.stopGraceMs`（默认 5 s）。

**全局 JVM 参数 / 内存**：顶层 `defaults.jvmArgs` 给所有程序一个默认值，单条 `jvmArgs` 覆盖它：

```jsonc
{
  "version": 1,
  "defaults": { "jvmArgs": ["-Xmx1g"] },          // 全局默认：内存 / GC / 编码
  "programs": [
    { "id": "spring:ris/ris-model/ris-model-biz#cn.com.ris.cloud.model.RisModelApplication",
      "name": "ris-model-biz", "kind": "spring", "dir": "ris/ris-model/ris-model-biz",
      "jvmArgs": ["-Xmx3g"] }                    // 只给这个程序调到 3g
  ]
}
```

- 只调某个程序：写在那条的 `jvmArgs`；全局统一：写 `defaults.jvmArgs`。都不写就不加任何 JVM 参数。
- 生效方式：保存后在面板点「重启」（或 `ris_dev_restart`）——正在运行的实例不会自己换参数。
- 也可以在 `env` 里用 `JAVA_TOOL_OPTIONS`（JVM 会打印 `Picked up JAVA_TOOL_OPTIONS`），但 `jvmArgs` 更直观，且不影响该进程拉起的其它 JVM。

配置是**工作区里的文件**（与仓库同一信任级）：浏览器仍只发程序 id，宿主重新扫描并读配置来拼命令，页面无法注入命令。

## 2.7 给 agent 的命令（模型侧工具）：dsh 操作 IDE 的全部入口

面板是给人点的；同一件事也给模型一组 `ris_dev_*` 命令（宿主侧 `ctx.tools.register`，与面板**同一套扫描/启停/调试内核**）。命令名固定前缀 `ris_dev_`，全部是**单工具**、参数只选"程序"（id / name / path），**永远不传命令 —— 命令由宿主按工作区内容自己拼**，所以这些工具不可能被用来执行任意命令。

### 2.7.1 程序清单与生命周期

| 命令 | 参数 | 作用 |
|---|---|---|
| `ris_dev_programs` | `refresh?` `runningOnly?` | 列出工作区可运行程序：`id / name / kind / dir / mainClass|script / running / pid / logPath`（含 `.dsh-ris-ide/config.json` 里自定义的程序） |
| `ris_dev_start` | `id` \| `name` \| `path` | 启动（Spring：`mvn -Pdev compile` → runtime classpath → `exec java …`；前端：`exec <pm> run <script>`），走 `run-with-log.sh`（日志 + pidfile + 侧边栏停止按钮）；已在跑返回 `alreadyRunning` |
| `ris_dev_restart` | `id` \| `name` \| `path` | 停（整组进程，端口一定释放）再起；没在跑就等于 start |
| `ris_dev_stop` | `id` \| `name` \| `path` | 停：TERM wrapper → 等 pidfile 宽限 → KILL；只对 `/proc` cmdline 是 `run-with-log.sh` 的 PID 发信号 |
| `ris_dev_status` | 无 \| `id` \| `name` \| `path` | 不带参 = 全量列表；带参 = 该程序的 `running/pid/uptime/url/logPath` |
| `ris_dev_skill` | `action?`(install\|status\|show\|uninstall), `target?`(project\|agents\|user\|user-agents), `dir?` | 安装/检查/读取/卸载**本插件内置的 `dsh-ris-ide-debug` skill**（见下节）；幂等，目标由调用方选 |
| `ris_dev_logs` | `id` \| `name` \| `path`，`lines?`(80/上限 500)，`open?`(默认 true) | 读日志尾部；同时把「在侧边栏打开这份日志」排进宿主队列（浏览器每 2.5 s 取走，**面板没开也能弹**）。返回里带 `content`，模型直接读 |

### 2.7.2 调试（只对 `kind: spring`；前端程序没有 JVM）

一个命令、16 个 action：`ris_dev_debug { action, … }`。动手前先 `state`（一次拿到程序行、会话状态与断点列表）。

| action | 额外参数 | 作用 |
|---|---|---|
| `state` | `id`/`name`/`path` | 程序行（running/pid/rss）+ JDWP 会话（attached/suspended/port）+ 全部断点，一次返回 |
| `open` | `id`/`name`/`path` | 只把该程序的 **RIS-IDE 工作台 tab 弹给用户**（目录树/源码/断点/调试/实时日志）；**不开始调试**，调试要再发 `start` |
| `start` | `suspend?` | 以 JDWP 模式**重启**该程序并 attach（端口随机 loopback；`suspend:true` = JVM 停在启动处，需 `resume`） |
| `stop` | — | 断开调试（服务继续跑；停服务用 `ris_dev_stop`） |
| `status` | — | `attached / suspended / port`（不 attach 不重启，很便宜） |
| `poll` | `since?` | 增量事件（断点命中、单步、vmstart），返回新 `seq`；用 `since` 传上次的 seq 就不会重复 |
| `breakpoints` | — | 列出当前断点：`requestId / className / line` |
| `breakpoint_add` | `className`, `line`, `suspendPolicy?`(thread\|all) | 加行断点。**类名**（如 `cn.com.ris.cloud.model.ModelHelper`），**不是文件路径**；类还没加载则等 `ClassPrepare`（30 s） |
| `breakpoint_remove` | `requestId` | 删一个 |
| `breakpoint_clear` | — | 清空全部 |
| `threads` | — | 线程列表 |
| `stack` | `threadId`, `max?`(默认 50) | 调用栈 |
| `variables` | `threadId`, `frameIndex?`(默认 0) | 局部变量/字段/数组（String 显示 `stringValue`） |
| `step` | `kind?`(over\|into\|out), `threadId?` | 单步（默认 over） |
| `resume` | `threadId?` | 继续 |
| `pause` | — | 暂停（挂起） |

### 2.7.3 一次完整调试会话（可直接照抄）

```
ris_dev_programs  {}                                        # 拿 id / name
ris_dev_debug     { "action": "open", "name": "ris-model-biz" }   # 让用户在 IDE 里看到
ris_dev_debug     { "action": "start", "name": "ris-model-biz" }  # 约 40–55 s 才 attach 完成
ris_dev_debug     { "action": "status", "name": "ris-model-biz" } # attached=true / port
ris_dev_debug     { "action": "breakpoint_add", "name": "ris-model-biz",
                    "className": "cn.com.ris.cloud.model.ModelHelper", "line": 168 }
ris_dev_logs      { "name": "ris-model-biz", "lines": 120 }       # 配合日志看启动过程
ris_dev_debug     { "action": "poll", "name": "ris-model-biz" }   # 等断点命中（记下 seq）
ris_dev_debug     { "action": "threads", "name": "ris-model-biz" }
ris_dev_debug     { "action": "stack", "name": "ris-model-biz", "threadId": "<上面返回的 id>" }
ris_dev_debug     { "action": "variables", "name": "ris-model-biz", "threadId": "<id>", "frameIndex": 0 }
ris_dev_debug     { "action": "step", "name": "ris-model-biz", "kind": "over" }
ris_dev_debug     { "action": "resume", "name": "ris-model-biz" }
ris_dev_debug     { "action": "stop", "name": "ris-model-biz" }   # 只断开，服务继续跑
ris_dev_stop      { "name": "ris-model-biz" }                     # 真要停服务
```

**面板等价操作**（人）：侧边栏「RIS控制台」→ 程序行 `▶ 启动 / ■ 停止 / ⟳ 重启 / 🐞 调试`（点行切日志，没有单独的「日志」按钮）；`🐞` 就是 `start`+`open`（以调试模式重启、连上、并把工作台弹出来）。调试区的 `🐞/⏹/⏸/⏵/⤵/⤷/⤴/⟳` 与上面的 start/stop/pause/resume/step(over/into/out)/poll 一一对应；源码行号**双击加断点 = `breakpoint_add`**，单击删 = `breakpoint_remove`。

### 2.7.4 约束与坑（踩过的）

- **断点用类名 + 可执行行号**（Maven 默认带 debug 信息）；行号不在 LineNumberTable 里不会命中。
- **JDWP 只服务一个 debugger 会话**：不要用 `nc`/`telnet` 探端口，探测会把会话占掉；判断 attach 完成看 JVM 日志 `Listening for transport dt_socket`（`start` 内部就是这么等的）。
- `start` 是**重启**（不是"给现有进程挂调试"）：正在跑的服务会被停掉再以 `-agentlib:jdwp=…` 起；`suspend:true` 会真的停住启动，Spring 会卡在启动处，记得 `resume`。
- 自定义 `startCommand` 的条目要含 **`${JDWP_ARGS}`** 占位符，否则点调试/`start` 直接报错并提示（本机 ris-model-biz / ris-rm-biz / ris-upms-biz 已补）。
- 能力边界：**无表达式求值（evaluate）、无条件断点/日志断点、无热替换**；能看线程/栈/局部变量/字段/数组/String。
- 宿主重启后调试会话丢失（断点也没了），重新 `start` + `breakpoint_add` 即可。
- 关掉这组命令：Loader 行配置 `agentTools: false`（默认开）；宿主没有工具注册表时插件降级为"只有面板"（不注册 `ris_dev_*`，有测试钉着）。

## 2.8 文件与编辑能力

### 文件 API（插件自带，不依赖第三方 sidebar）

文件树、搜索、读写都走本插件自己的宿主路由（1.2.44 起），路径解析与 loopback 围栏和 `/tail` 同一套：

| 动作 | 路由 | 响应 |
|---|---|---|
| 列目录 | `GET /dsh-ris-ide/tree?sessionId&cwd&path&fresh` | `{ok, path, entries, truncated}`（git 可见集合） |
| 文件名检索 | `GET /dsh-ris-ide/search?sessionId&cwd&q&limit` | `{ok, matches, dirs}`（`git ls-files` 口径，尊重 `.gitignore`） |
| 读文件 | `GET /dsh-ris-ide/fs/read?sessionId&cwd&path` | `{ok, kind:'text'|'binary'|'too-large', content?, size, mtimeMs}` |
| 写文件 | `POST /dsh-ris-ide/fs/write` JSON `{sessionId, cwd?, path, content}` | `{ok, mtimeMs}` |
| 原始字节 | `GET /dsh-ris-ide/fs/file?sessionId&cwd&path` | 按扩展名给 media content-type（图片/PDF） |
| 建/删/移/复制 | `POST /dsh-ris-ide/fs/{mkdir,create,copy,move,remove}` | 冲突 409；目录非空需 `recursive:true` |

读文件按 `kind:'text'|'binary'|'too-large'` 分支（二进制/超大文件给出可读错误）；`search` 返回 `{matches, dirs}`（`git ls-files` 口径，匹配路径由客户端统一转绝对路径当 key）；写文件是 JSON 正文，返回 `{ok, mtimeMs}`。

### 关于 `.gitattributes`：**编辑器不需要处理，交给 git**

`.gitattributes` 是 **git 自己的**规则，作用在 `checkout`/`add`/`diff`/`merge` 这些 git 操作上，**不是编辑器的职责**。而我们这边恰好只做一件事：**原样往返**——保存走插件自己的 `POST /dsh-ris-ide/fs/write`，写前探测文件的编码与换行（`fileFormatOf`）再按原样回写（`encodeText` + `restoreEol`）。所以：

- `text`/`eol=lf`/`eol=crlf`：编辑器保持文件**已有**的换行，git 在 `add`/`commit` 时按 `.gitattributes` 归一成 blob 里的 LF，工作区要不要 CRLF 由 `core.autocrlf` + `eol` 决定——这是 git 的正常行为，编辑器不掺和。
- `-text`/`binary`：git 只是按字节存、跳过 diff，不会因为我们按文本编辑而破坏它（真正的二进制文件我们读到 `fs.read` 的 `kind:'binary'` 就不会当文本打开）。
- `working-tree-encoding=GBK` 之类：blob 是 UTF-8、工作区是 GBK，靠的是**编码探测**而不是读 `.gitattributes`；插件的编码探测覆盖 UTF-8/GBK/GB18030/UTF-16，所以往返正确。
- 过滤器/LFS（`filter=lfs` 等）：smudge 出来的内容要么是文本指针（按文本看没意义）、要么是二进制（我们会拒绝当文本打开），都不危险。

**结论**：不为 `.gitattributes` 增加读取逻辑。唯一要注意的纪律是：**任何时候"整文件重写"都必须保持探测到的 EOL/编码**（保存、查找替换、未来的批量替换都是如此）——这一点现在由插件的写路径（`fsWrite` + `encodeText`/`restoreEol`）保证。如果哪天发现某个编码/换行被改坏了，再考虑接 `git check-attr` 做兜底。

### 非文本文件与 `dsh-ris-ide-debug` skill

- 图片（png/jpg/gif/webp/bmp/ico/avif/svg）用 `<img>`、PDF 用 sandbox iframe，走插件自己的原始字节路由 `GET /dsh-ris-ide/fs/file?sessionId&cwd&path`（content-type 由宿主给，SVG 还带 sandbox CSP）。
- `fs.read` 返回 `kind:'binary' | 'too-large'` 时显示「二进制文件，不支持预览」/「文件过大，不支持预览」，不会把二进制当文本渲成乱码。
- 插件**内置 skill** `skills/dsh-ris-ide-debug/SKILL.md`（随 npm 包发布）：教 agent 用 `ris_dev_*` 启停/看日志/断点调试。安装由 `ris_dev_skill` 工具完成（动作 `sync` / `install` / `status` / `show` / `uninstall`），目标可选 `project`（`<项目根>/.dsh/skills`，默认）、`agents`（`.agents/skills`）、`user`（`~/.dsh/skills`）、`user-agents`，或显式 `dir`（必须在工作区或 home 内）；幂等（内容相同则 `changed:false`），DSH 监听这些根目录会自动发现。
- **skill 自动更新**：`sync`（`ris_dev_skill` 的默认动作）会把**已存在**的副本刷新到插件内置的版本，不会创建没装过的副本；另外宿主在每个工作区的**首次 `ris_dev_*` 调用**时会自动跑一次 sync（每次进程每工作区一次），所以升级插件 + 重启后，之前装过的 skill 会自动跟着更新。`install` 仍是显式创建/覆盖的入口。

## 2.9 调试 UI（工作台）

工具面（`ris_dev_debug` 的 16 个 action）与完整命令 cookbook 在 **§2.7「给 agent 的命令」**，这里只说面板怎么用。

- **入口**：控制台行 `🐞 调试`（仅 Spring 程序；前端没有 JVM）。点击后在独立窗口打开该程序，并**自动以 JDWP 模式重启并 attach**（遮罩显示 `调试中…`），底部提示行给进度与失败原因；agent 也可 `ris_dev_debug { action: "open", name }` 弹同一个工作台。
- **加/删断点**：源码行号列单击加断点、单击红点删除（双击也可以）；空行与注释行静默忽略；不在工作区的类（JDK/依赖 jar）静默忽略。断点归属于**源码文件所属的程序**，不是当前选中的日志。
- **看现场**：断点/线程/调用栈/变量/事件五个页签；命中时自动切到「参数」并打开源码高亮当前行（不在可见区时滚动居中），单步/继续后行号跟随、切换文件时自动切页签。
- **变量树**：对象/数组点开懒加载（`/debug/expand`），继承字段与空值也列出，基础类型不显示展开图标；步进刷新后展开状态保留。
- **依赖 jar 源码**：优先 `-sources.jar`，没有则用配置的反编译 jar（调试面板 ⚙ 可选填，如 CFR），最后 `javap` 降级；产物写 `<cwd>/.dsh-ris-ide/cache/`，按输入指纹失效、有界回收（≤64MB / ≤2000 文件，30 天未写先删）。
- **窗口与轮询**：工作台 tab 可见且已 attach 时每 700ms 轮询 `/debug/poll`；不可见时停止轮询。停止/重启服务会自动 detach；宿主重启后会话丢失，重新 `start` 即可（断点需重加）。
- **能力边界**：无表达式求值、无条件断点/日志断点、无热替换（`redefineClasses`）；JDWP 无鉴权，仅 loopback + 随机端口 + 用完即断。

## 2.10 risd：常驻 daemon（Phase 1a / 1b）

代理引擎与规则表原来只有一个宿主：dsh 插件进程。`risd` 是一个**非提权**的常驻 Node 进程，`daemonMode=auto` 时由它接管机器级代理：引擎启动/停止、规则写入、git 代理、系统层拦截 reload、心跳、janitor、租约驱动拆除、升级 handoff。`daemonMode=auto` 是 1.8.0 起的默认值（`daemonMode=off` 时行为与旧版逐字节一致，整条 daemon 路径就是可回滚开关）。本节是 risd 的权威说明：所有权、进程模型、HTTP 契约、失败行为、yds 契约与操作细节都在这里，不依赖仓库外的文档；设计与否决理由属任务过程材料，不进本文。本文与代码冲突时以代码为准。

### 所有权（最重要的一条）

任一时刻只有**一个**组件允许 `startProxy/stopProxy`。切换点是 daemon 第一次成功启动引擎；之后：

- 插件不再装 exit 钩子、不认领继承引擎、不 arm janitor、不写心跳（`lib/index.js` 生命周期 effect 在 auto 下直接返回空 disposer）；
- 插件的 `POST /dsh-ris-ide/proxy`、`POST /dsh-ris-ide/proxy/action`（start/stop/git-on/git-off/redirector-*）、注入查询分别转发到 daemon 的 `POST /v1/proxy`、`POST /v1/action`、`GET /v1/injection`；
- `run`/`run-stop` 仍留在插件（本地子进程，注入只对它有效）；
- 插件清理只 `releaseLease`，**绝不停 daemon、也不碰引擎**。

### 文件与职责

| 文件 | 职责 |
|---|---|
| `bin/risd.mjs` | CLI：`serve` / `status` / `health` / `stop` / `version`；`--home`、`--port`（`0` 允许临时端口）、`DSH_RISD_PORT`；serve 把 `DSH_RIS_IDE_PROXY_HOME` 设为 `--home`（心跳/janitor/git-proxy.json 全部落在该 home） |
| `lib/risd/state.js` | `risd.json`（0600，原子写）、随机 token（32B hex）、spawn 锁（`risd.spawn.lock`，O_EXCL，10s 过期） |
| `lib/risd/server.js` | HTTP 服务、单实例选举、认证、全部端点、引擎所有权（`engineCwd`）、租约拆除、空闲退出、handoff、心跳/janitor、桥接串行 |
| `lib/risd/leases.js` | 租约注册表：按 `pid\0sessionId\0cwd` 幂等，3s 扫描 `pidAlive`，owner 消失即 `onGone` |
| `lib/risd/view.js` | 只读视图与 `risdConfigRevision`（与插件 `configRevision` 逐字节等价），**不含** `rules` |
| `lib/risd/git.js` | daemon 侧 git 代理：host 优先级（显式 → 表内 git 规则 → 上次记录 → origin）、双侧写、`git-proxy.json` 记录值、按值归属清理 |
| `lib/risd/log.js` | `risd.log`，10MB 轮转 |
| `lib/risd-client.js` | 插件侧：`probeRisd` / `ensureRisd`（抢 spawn 锁 + 轮询 health ≤5s）/ `acquireLease` / `releaseLease` / `getProxyView` / `saveProxy` / `proxyAction` / `getInjection` / `shutdownRisd` |
| `bin/proxy-janitor.mjs` | 看门狗：owner 消失即清理；**交接窗口**（state 里的 `handoffAt` 新鲜）内改为等待继任者注册并继续监视 |

### 端点

免认证：`GET /v1/health`（apiVersion/pid/port/uptime/leases/engine/heartbeat/janitor/state/home）。其余要求 `Authorization: Bearer <token>` 与 `x-risd-api-version`（缺/错 → `409 api-mismatch`；token 错 → 401）：

| 端点 | 用途 |
|---|---|
| `GET /v1/status?cwd=` / `GET /v1/proxy?cwd=` | 只读视图（revision、socks、listenPort、running、pid、listen、logPath、allow、git、janitor、daemon 概况） |
| `POST /v1/leases` / `DELETE /v1/leases/{id}` | 租约（`ownerPid` 正整数、`cwd` 可选绝对路径）。**这一条信号同时驱动「跟随 dsh」的两个半边**：第一份租约到达时若 `proxy.followDsh` 且引擎没跑且有完整规则 → 非交互启动引擎+桥接；最后一份消失 → 拆除（m13950） |
| `GET /v1/engine?cwd=` / `POST /v1/engine {action,cwd}` | 引擎状态与起停；daemon 记录 `engineCwd` 作为所有权证据，`/v1/health.engine.owned` 以它为准 |
| `POST /v1/proxy {cwd,config,revision,gitHost,replaceRulesFrom}` | 规则表写入 + CAS：revision 不匹配 → `409 {conflict:true,revision}`；空 revision 是显式强制路径；`replaceRulesFrom` 声明"整张表里这些 source 归我"，payload 未带的该 source 行会**跨 workspace** 退役（m08378：规则是全机的，按 workspace 退役会留下第二条 `java`）。保存只写表并重载**已经在跑**的拦截，绝不启动引擎（m13920） |
| `POST /v1/action {cwd,action,gitHost,ruleId,interactive}` | `start`/`stop`/`git-on`/`git-off`/`redirector-sync`/`redirector-start`/`redirector-stop`/`status`；`interactive:true` 只由页面按钮发（允许 pkexec/终端提权），自动路径一律不带（m13910） |
| `GET /v1/injection?cwd=&program=` | 与引擎同源的注入对象（`injectionFor`）：allow-list 模式给 `http://127.0.0.1:<listenPort>` + JVM http 代理参数；`direct:true` 才给 `socks5h://` + `-DsocksProxyHost` |
| `GET /v1/config` | `keepPolicy:'session'`、`idleExitMs:600000`、`lifecycle`（当前策略）、`lifecycleErrors`（策略文件被拒的原因，空数组正常） |
| `POST /v1/shutdown {handoff?}` | 先回 200，再优雅关闭；`handoff:true` 时保留引擎/心跳/janitor/state 供继任者收养 |

### 生命周期

- **单实例**：`listen()` 成功即唯一；`EADDRINUSE` 时探 `/v1/health` 500ms：同版本 → 按「已在运行」退出 0；异版本 → 3；被别的程序占 → 4 并提示换 `--port`。永远不按 pid 杀进程。
- **租约拆除**：最后一个租约 release/被扫描回收后 300ms 防抖（防「关一个窗口、马上开另一个」抖动），顺序 **git → 桥接 → 引擎**；没有任何租约且引擎/心跳都空时排 `idleExitMs=10min` 后自我退出（窗口随时可能回来重新取租约）。
- **心跳/janitor 唯一写者**：daemon 启动后每 3s 写 `janitor-heartbeat`（Windows 提权看门狗 20s 判据），并 `armJanitor({ownerPid: process.pid})`；插件在 auto 下两者都不做。
- **升级 handoff**：`POST /v1/shutdown {handoff:true}` → 写 `risd.json` 的 `handoff:{cwd,enginePid,at}` → 调 `markJanitorHandoff()` 给已武装的看门狗一个 12s 宽限 → 关 server 退出（不拆网络）。继任 daemon 启动时若 `handoff.enginePid === proxyPid()` 直接收养（`engineCwd = handoff.cwd`，pid/端口不变）。看门狗在宽限内等到新 owner 注册就继续监视，等不到才清理。
- **拆除有界**：`stop()` 的拆除用 `Promise.race([teardownNetwork, 5s])`——WSL `/mnt/c` 上桥接探测可能很慢，不能挡住 `risd stop` 或下一次 spawn；超时交给已武装的 janitor 收尾。
- **state 顺序**：先删 `risd.json`（仅当仍属于自己）再做拆除，否则 shutdown 用例/后续 spawn 会等 6s 超时。

### 插件接线（`lib/index.js`）

- `proxyView` 拆出 `proxyRulesView(cwd, config)`（规则装饰 + 模板行 + run 状态）；`mergeRisdView` 合并 daemon 视图 + 本地 rules/git/redirector/janitor/inherited。
- `daemonMode`：`config.daemonMode` 或 `DSH_RISD_MODE`，只有 `auto` 才启用；挂载时 `ensureRisd` + `acquireLease`，dispose 只 `releaseLease`。
- `serveProxy`：GET 先试 `risdForwardedView`（不可达回退本地）；POST 有 bridge 时转发 `saveProxy`，409 原样回传并附本地 `view`，转发失败回 `502 bad-gateway`；成功用本地 `proxyView` + daemon `reloadNote` 响应。
- `serveProxyAction`：`daemonActions` 集合转发；`start/stop` 成功后清 `inheritedEngine`。

### 踩坑记录

1. **daemon 视图不做桥接探测**：`redirectorStatusCached()` 在 WSL 上首次调用约 3.1s（`/mnt/c` 存在时探测 Windows 进程）；daemon 只报 `{managedBy:'plugin', rules}`，插件合并时用本地缓存状态（视图 3.1s → 5ms）。
2. **keep-alive 拖住 `server.close()`**：`keepAliveTimeout=1000` + `closeIdleConnections()` + 1.5s 后 `closeAllConnections()` 兜底。
3. **`proxyStatus()` 是 async**：漏 `await` 会让 `/v1/engine` 的 `running` 变 `undefined`（健康检查看起来「引擎没跑」）。
4. **spawn 失败必须有 `error` 监听**：cwd 不存在时 `startProxy` 原来会让 daemon 因未处理的 `error` 事件退出；现在先校验 cwd，并给 child 挂监听写进引擎日志。
5. **janitor 交接窗口**：前任退出后看门狗会在 3s 内把引擎当成孤儿拆掉，handoff 必须先把 `handoffAt` 写进 watcher state，看门狗据此等待继任者（≤12s）。
6. **E2/E3（顺带修）**：`runEngine` 的 `shutdown` 现在也 close shadows；`ready (N listeners)` 计数含 shadows（此前恒为 1，不能作为就绪判据）。

### 测试

`test/risd-election.test.mjs`（5）、`test/risd-api.test.mjs`（7）、`test/risd-lease.test.mjs`（3）、`test/risd-client.test.mjs`（5）、`test/risd-mode.test.mjs`（2，插件 `daemonMode` 集成）、`test/risd-engine.test.mjs`（2）、`test/risd-teardown.test.mjs`（2）、`test/risd-write.test.mjs`（3，并发 CAS + 注入同源）、`test/risd-handoff.test.mjs`（1）；共享 harness `test/risd-helpers.mjs`（不匹配 `test/*.test.mjs`）。

全量测试建议 `node --test --test-concurrency=4 "test/*.test.mjs"`：默认全并发（20+ 文件同时跑真套接字）在本机偶发挂住，并非本模块引入。

### 手工验证

```bash
risd serve --port 0                   # 前台跑一个（或 & 到后台）；bin/risd.mjs 由 package.json bin.risd 暴露
risd status                           # 单实例信息 / 租约数 / engine
risd health                           # 免认证 JSON
risd stop                             # 先回 200，再优雅关闭
risd stop --handoff                   # 交接退出（下一个 daemon 收养引擎）
```

## 里程碑与版本历史

当前 **1.8.3**（里程碑 1.8.0，其下按日期记录 2026-11-09/12 的增量与修复）；更早版本只留一行摘要——逐版本流水账以 git 历史 / npm 版本为准，不再在文档里重复。

### 1.7.0 · 里程碑：复评缺口 1–7

- 需求（产品评审复评：缺口 1–7）：日常闭环里七个高频动作缺真入口或只在帮助里承诺——重启、批量启停、按文件内容检索、日志级别过滤、未保存离开提醒、改动行对比、跑单测；全部做成面板里可点的真入口，不新增端口、不装依赖。
- 重启与批量启停：侧栏紧凑行与工作台控制台行都有 `⟳`（`data-action="restart"` / `"console-restart"` → `POST /start` 带 `restart:true`：运行中先停、释放 pidfile 再按原参数起；已停止就是启动）；两处每行都新增复选框（`data-compact-check` / `data-console-check`），勾选 >1 行时标题栏出现「已勾选 N 项」+ `▶` / `■` / `清除`（`data-compact-batch` / `data-console-batch`）：按列表顺序启动、倒序停止，自动跳过已运行/已停止，按钮上显示 `i/N` 进度。
- 内容检索：检索框在文件名命中之后追加**文件内容**命中（宿主 `GET /dsh-ris-ide/search-content`，每次一次 `git grep -n`、无索引、`limit=200`，非 git 仓库退化为不区分大小写遍历）；下拉里文件行图标 `📄`/`▸`、内容行图标 `≡` 并显示 `路径:行号  文本`；`↑`/`↓` 在两类行之间连续移动（只动高亮不动输入框光标），`Enter` 打开——文件行直接打开，内容行打开文件后把检索词填进编辑器查找框并执行一次 find、光标落到命中行；默认仍高亮「文件名完全匹配」行、否则第一行。
- 日志级别过滤与离开提醒：日志标题栏按钮按 `级 → W+ → E+` 循环（`data-log-level`：all / warn / error），缩进的堆栈/续行跟随上一行一起保留；IDE 页面监听 `beforeunload`，有未保存页签时关闭/刷新页面先弹浏览器确认（不静默丢改动）。
- 行对比与跑单测：编辑器标题栏 `±`（`data-action="diff"`）与磁盘版本逐行对比（`+` 新增 / `−` 删除），仅在有未保存修改时可用，「回到编辑」返回（对比面板是覆盖层、编辑器实例不卸载，行号左旧右新；回到编辑后未保存修改仍可 Ctrl+Z 逐步撤销——曾经换掉编辑器导致撤销历史丢失）打开 `src/test/java/**/xxxTest.java` 时标题栏出现 `▶`（`data-action="run-test"`），按 `mvn -P<profile> -q -pl <module> test -Dtest=<全限定类名> -DfailIfNoTests=false -DskipITs` 运行（宿主 `POST /run-test`，reactor 根 = 工作区路径第一段，模块与类名都从文件路径推导），输出面板保留 head 4096 字符 + 省略标记 + tail 400000 字符，状态为 通过 / 失败（退出码）/ 超时（900 秒），可重新运行。
- 编辑预览悬浮按钮：编辑器上方的「预览」细条改成**悬浮在编辑区右上角**的小按钮（`data-preview-toggle` 仍带 `open`/`closed` 标记，`data-action="preview-enter"` / `"preview-exit"`）：代码从第一行用到最底一行，不再被开关占去一行高度；仍是 Markdown/HTML 等可预览文件在编辑态才出现，预览态变「编辑」。
- 编辑器查找面板美化：CodeMirror 自带面板（渐变按钮、15px 输入框、自带配色）与面板整体风格不一致，`SEARCH_PANEL_CSS` 在 `[data-workbench="ris-ide"]` 内把它改成与标题栏同一套视觉——`Canvas` 混合底色 + 1px 分隔线、12px 字、20px 高的幽灵按钮（hover `color-mix(…currentColor 12%)`，去掉 `.cm-button` 背景图）、3px 圆角 20px 输入框、三个开关做成同高小 chip；命中高亮统一成琥珀色（普通 28%、当前 42% + 描边）。同一条 `<style>` 注入，深浅主题跟随页面配色。
- 内容命中把检索词交给编辑器查找：`IdeCodeMirror` 挂载后把 CM handle 注册进 `viewerControlsRef`（此前没有任何注册点，`controls.searchFor` 永远拿不到目标，点内容命中只会打开文件）；查看器还没注册时先存进 `pendingFindRef`，注册那一刻补投，等不到就按帧重试（最多 10s），不再出现 `undefined.then` 的「界面出错」提示。
- 检索框交互：选中结果后**不再清空检索词、也不清空结果集**（结果按 query 进缓存 `rememberSearchEntry`，Map LRU 上限 40 条，检索词变了才重新取数）——同一条命中可以反复打开（下拉只属于聚焦态——选中即收起并 blur，再点回检索框立刻用缓存结果展开），`Ctrl+R / Ctrl+Shift+R / F3` 聚焦检索框后**自动全选**框内文字（经 effect 在受控值刷新之后 `select()`，避免高亮被重渲染吞掉；带单行选区时仍直接以该文本为检索词）。
- 文件检索下拉不再一次画完：`SearchResults` 首屏 40 行（`SEARCH_ROWS_FIRST`），滚到近底追加 60 行（`SEARCH_ROWS_MORE`，行尾提示「滚动加载更多（剩余 N 行）」），键盘越过已画窗口时自动加宽——几百条内容命中时「再回到搜索框」不再卡。
- 编辑器查找/替换面板换成插件自绘两行版：`src/chunks/codemirror.js` 的 `ideFindPanel` 经 `search({createPanel})` 接管 CodeMirror 面板（`↑/↓` 上/下一个、`Aa`/`.*`/`ab` 三个 `aria-pressed` 状态开关、`⇥`/`⇥⇥` 替换/全部替换、`✕` 关闭、右侧匹配计数），样式在 `SEARCH_PANEL_CSS`：网格两行、两个输入框同列等宽、按钮固定 24px 列对齐（替换行的 `⇥`/`⇥⇥` 与查找行的 `ab`/`✕` 同列），匹配计数在替换行右侧；面板用 `top: true` 挂在**编辑器上方**（与 CodeMirror 默认搜索面板同位置），打开时自动聚焦查找框并全选已有关键词，输入即跳到第一个命中。（修复过程中的两个坑：`getSearchQuery` 取的是 **EditorState** 而不是 view；`setSearchQuery` 是 StateEffect，必须 `dispatch(setSearchQuery.of(next))`，直接当函数调用会静默什么也不发生。）
- 文件树换根入口 = 右键菜单「进入」：目录行右键 → 进入，把该目录当作文件树根（`data-tree-root` 变成它、行首出现 `↑ 上级` 逐级弹回工作区根）；点目录行本身（以及三角 `▸/▾`）只展开/折叠；检索里点到目录条目仍直接换根；帮助面板「文件树」段按新语义记录。
- 帮助与文档：帮助面板新增「检索」段（现在共 **8 段**：通用 / 文件树 / 检索 / 编辑器 / 日志 / 配置 / 调试（仅 Java）/ 使用说明），通用段补未保存离开提示，编辑器段补 `±` 与 `▶ 运行测试`，日志段补级别过滤，使用说明段补批量启停（并写明 `⟳` 是重启）；README 同步这七项（README 面向上架用户，只讲能力，不写运维细节）。
- 测试：`npm test` 全绿（`test/client-viewer.test.mjs` 新增日志级别、diff 面板、测试目标解析、内容检索下拉渲染、检索结果缓存/保留检索词与快捷键全选；新增 `test/host-search.test.mjs` 覆盖 `/search-content`、`/run-test` 校验/输出裁剪/记录上限、`/start` 的 `restart:true`）；`npm run check:listing` 15 项 ❌0 ⚠1。
- 生效与截图：本轮新增的是**宿主路由**（`/search-content`、`/run-test`，以及 `/start` 的 `restart:true`），旧 `dsh web` 进程里这三项会 404，**必须重启 `dsh web` 才生效**；纯客户端 UI（行复选框、`⟳`、`±`、`▶`、`级/W+/E+`、帮助面板「检索」段）硬刷新即出现。`docs/screenshots/ris-ide-window.png` 已按 1.7.0 的客户端重拍（1280×813，含复选框 / `⟳` / `±` / `▶` / `级` 等新控件）；侧栏「RIS控制台」截图（`ris-console.png`）仍待 `dsh web` 启动 token 后补拍。

#### 1.7.0 之后并入里程碑的增量

#### 1.7.1 · 文件树粘贴 / 复制三处修复 + 停止按钮图标

本轮一次更新四处，版本按用户口径统一为 **1.7.1**（仓库里 1.7.1 / 1.7.2 / 1.7.3 三个提交已合并成这一个版本号）。

##### ① 外部多文件粘贴不再在第一个同名冲突处中断

- 用户口径：「dsh-ris-ide 外部复制多个文件，到文件树 ctrl+v 只复制了单个文件。」实测（ego Chromium 151 + X11 `CLIPBOARD` 自造 3 文件剪贴板）：Linux Chrome 对多文件复制**确实投递全部 `File` blob**，无同名文件时 1.7.0 也能 3/3 落地 ⇒ 不是剪贴板/UI 层丢数据。
- 根因：`lib/client.js` 的 `importExternal(dir, files, paths)` 逐个 `await runPaste(source, dir, undefined)`，`if (created === undefined) break` —— `runPaste` 撞名时走 `parkPasteName(...)` 弹「粘贴为」卡并返回 `undefined`，于是**第一个重名文件就中止整批**，后面的文件静默丢弃（用户场景：目标文件夹里已有同名文件）。
- 修法（批量语义复用 1.7.0 已有的批处理冲突卡）：新增 `importOne(source, dir, name, overwrite)`（`File` → `/fs/upload`、外部路径 → `/fs/import`）与 `importOneWithCopyName(source, dir)`（`… 副本`/`… 副本(n)`，60 次尝试）；`importExternal` 先把 `files` 与 `paths` 合并成带 `name` 的 `sources` 并按名去重，逐项 `importOne`：**单个文件**撞名仍弹「粘贴为」（改名/覆盖，行为不变），**多个文件**撞名的收集进 `conflicts`、其余照常落地，末尾 `setBatchConflict({ …, external: true })` 用同一张「覆盖 / 生成副本」卡收口；`resolveBatchConflict` 新增 `pending.external === true` 分支（覆盖 = `importOne(..., true)`；生成副本 = `importOneWithCopyName`），undo 一条「导入 N 项」逐项删除。冲突分支在开卡**之前**先 `refreshLevel(trimmedDir)`，落盘的非冲突文件立刻出现在树里（取消卡片也不会留下看不见的文件）。
- 同时修 `handleTreePaste`：此前 `files.length > 0` 直接 `importExternal(dir, files, [])` 早退，只读文本的分支永远走不到；现在 `files` 与 `text/uri-list`/`text/plain`（`parseClipboardPaths`）**一起读**、按名去重——只投递文本的桌面/浏览器也能多文件导入，两者都有的剪贴板不会重复落盘。
- 测试：「pasting several OS files never stops at the first existing name」。

##### ② 树内 Ctrl+V 不再劫持外部粘贴（系统剪贴板优先）

- 用户口径：「文件树选择 2 文件 Ctrl+C，回系统桌面 Ctrl+V，文件复制过去了。然后将桌面文件删除，选择桌面另外 2 文件 Ctrl+C，回到文件树目录 Ctrl+V 报错，源文件不存在（之前复制出去的 2 文件）。」以及「有新的，旧的废弃。」
- 根因：`keydown` capture 里 `if (meta && (key === 'v' || key === 'V')) { if (clipboard === null) return; event.preventDefault(); void pasteInto(...) }` —— 只要树内部剪贴板非空就 `preventDefault()`，**浏览器根本不发 `paste` 事件**，于是粘的是「上一次在树里复制的那批」，而不是系统剪贴板里新复制的内容；那批源文件后来被删就报不存在。
- 修法：Ctrl+V 的 keydown **不再** claim 手势。OS 剪贴板里有没有文件只有 `paste` 事件看得见，所以 keydown 只排一个 150ms 的兜底定时器（`pasteAtRef` 记录 `paste` 事件时间，事件先到就作废兜底）——空的系统剪贴板不会发 `paste`，此时才粘树内部剪贴板；焦点在 `input`/`textarea`/`select`/`contenteditable` 时直接放行（`isTextEntry(target)`），编辑器不再被劫持。
- `handleTreePaste` 现在自己决定：`isTreeClipboardCopy(files, paths)` 按**文件名多重集**（数量 + 名字，`File` 只暴露 name）判断「这是否是回头的自家剪贴板」——`beginCopy()` 也会把同一批文件写进系统剪贴板，所以树内 Ctrl+C → Ctrl+V 必须仍然走内部语义（剪切 = 移动、不入 upload 通道）；名字对不上就是真正的外部内容，走 `importExternal`。
- **谁新谁赢，旧的作废**：`beginCopy()` 已经把同一批写进系统剪贴板，所以粘贴负载与树内那批**不同**时就说明用户此后又复制了别的东西 —— 系统剪贴板上的是新的，树里那份作废（`setClipboard(null)`）再按外部内容导入；负载是**不可导入的文本**（聊天记录、文档片段等）时同样丢弃旧复制并提示「系统剪贴板里不是文件，已清空文件树里的旧复制」，绝不把用户已经离开的旧条目再粘出来；只有「`paste` 事件没来」（系统剪贴板空/读不到）时才回退到树内剪贴板。
- 说明：网页**读不到**系统剪贴板的写入时间（Chromium 不暴露剪贴板时间戳/序列号），所以「新」是靠**内容对比**判定的，而不是比时间；`beginCopy()` 每次都会重写系统剪贴板，所以「内容不同 ⇒ 系统剪贴板更新」成立。
- 连带修复：`/fs/import` 的 `from`/`dir` 参数反了。宿主语义是 `from` = 源、`dir` = 目标目录，客户端两处调用（`runPaste` 的 uri-list 分支、`importOne`）却写成 `fsImportPath(scope, dir, source.path, …)`，于是只带 `text/uri-list`（没有 `File` blob）的粘贴报「粘贴目标不是目录」，一个文件都落不下来。已改成 `fsImportPath(scope, sourcePath, dir, …)` 并把形参改名为 `sourcePath` 防再反转；测试「a path paste sends the source as `from` and the folder as `dir`」。
- 粘贴目标是**文件**时落到它所在目录（用户口径：「粘贴目标是文件不是目录 则定位其目录」）：树可以把选中的那一行交上来，而选中的可能是文件，Ctrl+V 到文件行上要的是「放到它旁边」，不该报错。宿主新增 `resolvePasteDirectory(cwd, raw, restrict)`，`/fs/upload` 与 `/fs/import` 共用：目标存在且是目录 → 原样用；是文件 → 用它的 `dirname`；目标压根不存在 → `粘贴目标「…」不存在`（400）。`/fs/copy`、`/fs/move` 的目标目录同样走 `asFolder()`（文件 → 其目录）。客户端 `pasteTargetDir()` 本来就把文件选区解析成父目录、未知路径按文件处理，所以两侧口径一致；测试「pasted OS files upload and import into the tree」补了「文件目标」与「目标不存在」两组断言，`fs` 变更那组补了 copy 到文件目标。
- 测试：「an OS clipboard paste wins over a stale tree clipboard」「a newer OS clipboard discards the older tree clipboard」。

##### ③ 文件树里复制 / 剪切，可以直接粘贴到资源管理器

- 用户口径：「文件树的复制修复。要支持复制树里的文件到外部。」1.7.0 及之前 `beginCopy(mode)` 只写内存剪贴板（供树内 Ctrl+V），完全不碰系统剪贴板，所以在资源管理器/桌面里粘贴什么都不会出现。
- 为什么必须由宿主来写：浏览器**做不到**把文件列表放到系统剪贴板。实测（ego Chromium 151 + `/tmp/clipread` 直接读 X11 `CLIPBOARD`）：`navigator.clipboard.write([new ClipboardItem({'text/uri-list': …})])` 抛 `NotAllowedError: … Type text/uri-list not supported on write.`（`x-special/gnome-copied-files` 同样被拒）；`document.execCommand('copy')` + `copy` 事件里 `setData('text/uri-list', …)` 不抛错，但系统剪贴板只有 Chrome 私有的 `chromium/x-web-custom-data`，没有 `text/uri-list`。只有 `text/plain`（路径文本）写得进去。
- 修法：新增宿主路由 **`POST /dsh-ris-ide/clipboard/files`** `{ paths: string[], cut?: boolean }`（仅 loopback、最多 `CLIPBOARD_MAX_ENTRIES = 200` 项、逐项 `stat` 校验存在、拒绝相对路径），由 `writeSystemFileClipboard(paths, cut)` 按平台落：
  - Windows / WSL（本机就是 WSL2）：`wslpath -w` 转成 `\\wsl.localhost\<distro>\…`，用 `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand <base64(UTF-16LE 脚本)>` 执行 WinForms `DataObject`：`SetData('FileDrop', [string[]]@(…))` + `SetData('Preferred DropEffect', [byte[]]@(cut ? 2 : 1,0,0,0))` + `Clipboard::SetDataObject($data, $true)`（`$true` = flush，PowerShell 退出后剪贴板仍在；`-STA` 是 `SetDataObject` 的硬要求）。实测资源管理器侧读到的就是 `CF_HDROP` + `Preferred DropEffect=2`（move）/`1`（copy）。
  - macOS：`osascript -l JavaScript` + `ObjC.import("AppKit")` → `NSPasteboard` `writeObjects`。
  - 其它 Linux 桌面：`xclip -t x-special/gnome-copied-files`（GNOME 的 copy/cut 语义）→ 退 `wl-copy --type text/uri-list`；两者都没有就 501 `unsupported`。
- 客户端：`beginCopy()` 在 `setClipboard(...)` 之后 `void publishSystemClipboard(items, mode)`（`cut` 传 `{cut:true}` 让外面执行「移动」）。宿主调用失败**不影响树内复制**——内部剪贴板已经设好，只丢「粘到外部」；此时退回 `navigator.clipboard.writeText(paths.join('\n'))`，终端/文本框仍能用。
- **命令行的使用边界（用户口径：「如果复制到资源管理器必须要命令行的话，那就限制下命令行的使用范围，防止漏洞」）**：这条能力不得不借平台命令行（WSL/Windows 下是 `powershell.exe`），所以把范围压到最小：
  - 只跑**固定程序 + 固定参数**（`powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand`、`osascript -l JavaScript -e`、`xclip … -i`、`wl-copy --type text/uri-list`、`wslpath -w`），全部 `spawn(command, argv)`、**没有 shell**（无 `shell: true`、无 `exec`、无字符串拼命令）。
  - **路径只作为数据走 stdin**（Windows/Linux 走 stdin 行，macOS 走 `run(argv)` 的 argv），**从不进脚本正文**：`windowsClipboardScript(cut)` 里没有任何文件名，唯一插值是 `cut ? 2 : 1` 这个整数。第一版是把路径拼成单引号字面量（`'…'` 内 `'` 加 `''`），安全性全压在转义规则上；现在文件名里的 `'`、`$(`、`;`、反引号都只是名字（实测 `$(2+2) ; calc.txt`、`it's "quoted" 测试.txt` 原样落进 `CF_HDROP`，没有执行）。
  - 入口先校验：仅 loopback、只接受 `POST`、最多 200 项、必须绝对路径、必须 `stat` 存在、**拒绝含换行/回车/NUL 的路径**（它们会破坏「一行一个路径」的传输协议、把一条名字劈成两条），stdin 负载上限 `CLIPBOARD_MAX_PAYLOAD = 256 KB`。
  - 每个子进程 15 s 硬超时并 `SIGKILL`（卡住的剪贴板工具不能吊死请求）；写 stdin 失败不抛到请求外。
  - 测试：「no file name can reach the PowerShell script as code」「the route rejects relative, missing, control-character and oversized lists before touching the clipboard」。
- 生效方式：新增宿主路由 ⇒ **必须重启 `dsh web`** 才能拿到（客户端改动本身硬刷新即可）。
- 测试：`test/clipboard.test.mjs`（路由常量/参数校验：相对路径 400、不存在 404、超 200 项 400、空列表 400；`windowsClipboardScript` 的 `FileDrop`/`Preferred DropEffect`/引号转义形状），`test/client-viewer.test.mjs` 的「copying in the tree also publishes the files to the OS clipboard」。

##### ④ 停止按钮：绘制的方块图标 + 侧栏批量按钮改用同色

- 用户口径：「1. ide 控制台，停止按钮，中间的方块图标小了。2. 侧边栏控制台，多选后顶端批量停止按钮，颜色不对，切方块图标小了。」后补：「停止按钮 边框不对。边框大小跟其他按钮一致，方块居中。」「侧边栏控制台 stopGlyph is not defined」。
- 方块图标：■ 是文字字符，字形的墨迹只有字宽的一半左右，11–12px 下在 20px 侧栏按钮和 25px 工作台按钮里都像一个小点，且两种按钮里大小还不一致。新增**模块级** `stopGlyph(size = 10)` 画一个圆角 2、`background: currentColor` 的方块（侧栏 20px 按钮用默认 10×10，工作台 24px 高按钮用 11×11）；工作台控制台的批量停止 / 行内停止、侧栏控制台的批量停止 / 行内停止、旧「程序列表」面板的行内停止**五处**停止按钮统一用它（▶/⟳ 仍用文字字形，箭头本身不显小）。
- 方块必须**参与行内格式化**（`display: inline-block` + `verticalAlign: middle`）：第一版写成 `display: block`，块盒不产生行盒，同一行里 ▶/⟳/🐞 按钮仍是 20px 行高 → 那三个 25×24，停止按钮只有 25×14，边框矮一截；改回行内盒后停止按钮回到 25×24，方块水平/垂直居中。
- `stopGlyph` 必须在 **factory 顶层（模块作用域）**，不能定义在 `ProgramWorkbench` 里：侧栏 `ProgramsPanel`（`compact` 形态、批量条与行内 ■）也要调它，嵌在别处的声明会让整个侧栏控制台抛 `stopGlyph is not defined`。测试为此断言声明缩进为模块级。
- 颜色：侧栏控制台「已勾选 N 项」批量条里的 ▶/■ 之前都用中性的 `S.paneIcon`，■ 不红；现在与行内按钮同色——批量停止用 `S.stopIcon`（红）、批量启动用 `S.startIcon`（绿），禁用/进行中用 `S.paneIconOff`，与行内按钮的 `busy ? S.paneIconOff : S.stopIcon` 口径一致。工作台控制台的批量按钮本来就走 `button(..., { start/stop: true })`，颜色不变。
- 测试：「the stop mark is a drawn square, and the sidebar batch bar keeps the row tones」。

##### ⑤ 删除 / 粘贴的范围护栏：路径只是页面传来的字符串

- 用户口径：「例如命令行删除文件，防止文件名带特殊字符，导致注入或删除范围溢出之类的」「如果复制到资源管理器必须要命令行的话，那就限制下命令行的使用范围，防止漏洞」。
- **范围**：`/fs` 的所有变更（新建文件夹、新建文件、复制、移动、删除）现在都要求目标在树根（= 会话 cwd）之内 —— `insideRoot()`（根目录本身仍然 409）；此前只拦「根目录本身」，`"../../../home"` 之类的路径能把递归删除带到树外面。粘贴目标同理：`resolvePasteDirectory()` 解析完仍要求落在树根内 —— 覆盖粘贴会先 `rm -rf` 撞名项，指错地方就等于删外面的目录。越界的路径一律 403 `不能对工作区之外的路径执行…` / `粘贴目标「…」不在工作区里`。
- **名字**：`leafName()` 统一校验一个路径分量（拒绝 `.`、`..`、`/`、`\`、控制字符、超过 255 字符），复制/移动的目标名、`/fs/upload`、`/fs/import` 的 `name`、新建的末段都走它；`'; rm -rf *'`、`$(id)`、`'quoted'`、空格、中文都只是文件名。
- **无 shell**：全仓没有任何 `shell: true` / `exec` / 字符串拼命令的删除路径；删除与覆盖一律 Node `fs.rm`（`fs.rm` 删除符号链接本身、不跟随到目录）；外部命令（`git`、`javap`、反编译工具、`powershell` / `osascript` / `xclip` / `wl-copy` / `wslpath`）只用固定程序 + 固定参数，路径走 argv/stdin，并给 `git` 参数补 `--` 终止选项位。
- 测试：`npm test` 348 全绿（新增：越界删除 403 且越界文件仍在、越界复制目标 403、名字带 `; rm -rf * $(id) 'quoted' &` 只删它自己、邻居文件不动、名字带换行 400、越界覆盖粘贴 403 且外部文件未被改动）。

##### ⑥ 文件树按 .gitignore 过滤时，`.git` 元数据一并隐藏

- 用户口径：「如果文件树开启 .gitignore过滤，所有.git文件夹也过滤掉。」
- 缺口：`git ls-files` 从不列出 `.git`，`git check-ignore` 也不会把 `.git` 报成「被忽略」（它是 git 自己的元数据，不是某条图案规则命中的条目）⇒ 过滤态下 `.git` 反而是唯一一个「看着该隐藏、却一直显示」的目录，每个仓库根都带一个。
- 修法：`listIdeTree()` 在过滤态（`filter !== 'all'`，即 `allowed !== undefined`）用既有的 `TREE_WATCH_ALWAYS_IGNORED`（`.git` + 撤销回收站）跳过该行；同一条规则也进 `compactChain()`（否则 `.git` 会被当成可见兄弟、挡住包名折叠）与「git 看不见的空目录」探测。「显示所有文件」（`filter=all`）照旧显示 `.git`。嵌套仓库（子模块 / 子仓库）以自己为根列目录时同样隐藏它自己的 `.git`。
- 客户端：过滤态眼睛按钮的 tooltip 补一句「.git 元数据一并隐藏」。
- 测试：`filter=all shows gitignored files, the default hides them` 增加三条断言（过滤态无 `.git`、`filter=all` 有 `.git`、嵌套仓库列目录无 `.git`）；`npm test` 348 全绿（本机实测：对仓库根执行 `listIdeTree(root, root)` 时过滤态 `.git` 不存在、`filter=all` 存在）。

##### ⑦ 桌面 → 文件树：粘贴不再粘出「上一条树内复制」

- 用户口径：「文件复制bug . 文件树选择2文件ctrl+c 粘贴到桌面，文件树里2文件没了？此时从桌面 再复制此2文件，ctrl+v粘贴回文件树，报错：2 项失败：README.md（目标与源相同）」
- 取证：`git status` 是 ` D AGENTS.md`、` D README.md`，两个文件出现在 Windows 桌面且字节数与 `git show HEAD:` 完全一致；IDE 自己的删除一律进 `.dsh-ris-ide/trash`，而回收站里没有它们 ⇒ 删除动作不来自插件。用户确认树里按的是 **Ctrl+C**（实测此时系统剪贴板里的 `FileDrop` + `Preferred DropEffect = 1,0,0,0` 即 COPY），但文件在 Explorer 粘贴后确实离开了原目录 —— 这一段行为**至今无法归因**：插件只写剪贴板、不参与外部粘贴，且 `Shell.Application` 的 `InvokeVerb('paste')` / `AppActivate`+`SendKeys` 都无法脚本化复现 Explorer 的粘贴语义（见下条），所以不排除当时的 Explorer 把跨 `\\wsl.localhost` 的粘贴办成了移动，或文件在粘贴前后被动过。
- 真缺口（第二个症状）：**WSLg 不把 Windows 的 `CF_HDROP` 桥进 Chromium** ⇒ 从桌面复制后，树里 Ctrl+V 的 `paste` 事件是**空负载**；旧代码把「空负载」解释成「系统剪贴板里没东西」，于是回落到**树内内存剪贴板**（那是上一次树里复制、源已被移走的两项）⇒ `fs/copy` 的 `from == to` ⇒ 宿主 409 `目标与源相同`，toast 只打印第一个失败名，看起来就像「2 项失败：README.md」。
- 修法（宿主 + 客户端）：
  - 宿主新增**只读**路由 `GET /dsh-ris-ide/clipboard/read`（`CLIPBOARD_READ_PATH`）：WSL/Windows 用 PowerShell `GetDataObject()` 读 `FileDrop` 与 `UnicodeText`（脚本是常量，输出 `F:<path>` 逐行 + 一行 `T:<base64 utf8>`，路径永不被当作代码）；Linux 用 `xclip -o -t x-special/gnome-copied-files` / `wl-paste --type text/uri-list`；macOS 用 JXA 读 `NSPasteboard` 的 `NSURL` 列表。loopback 限定、8–15 s 硬超时。
  - `clipboardPathsToLinux()` 把 Windows 路径映射成本机路径：`\\wsl.localhost\<distro>\…` / `\\wsl$\<distro>\…` → 去掉前缀（**只认当前 distro**，别的发行版直接丢弃），`C:\…` → `/mnt/c/…`，已是 `/…` 的照原样；去重、上限 200 条。
  - 客户端 `handleTreePaste` 不再「空负载 = 用树内剪贴板」：空负载改问宿主（`fsClipboardState()`）；宿主读到文件列表时，**用路径比对**（`samePathList()`）判断剪贴板里是不是树里那批 —— 是就仍走树内语义（剪切 = 移动），不是就作废树内剪贴板（`setClipboard(null)`）并把这批文件走 `/fs/import` 导入。payload 非空的路径同样先用宿主读数确认，防止「同名不同位置」把桌面上的文件误当自家剪贴板。
  - 降级：宿主路由不可用（旧宿主/非 loopback）时 `readHostClipboard()` 返回 `null`，行为退回 1.7.1 之前的老逻辑，不会因为读不到而卡住粘贴。
- 测试：`test/clipboard.test.mjs` 增加「read script 是常量 + `F:`/`T:` 行协议」「Windows 路径 → Linux 路径映射（外来发行版/SMB 丢弃、去重）」「读路由是 loopback GET、只有 GET」；`test/client-viewer.test.mjs` 增加「a desktop copy reaches the tree through the Host clipboard」，并把「空负载」断言改成「空负载去问宿主」。`npm test` 352 全绿。
- 真机（本机 WSL）：`readSystemFileClipboard()` 直接调用返回 `{"files":["/tmp/movetest/m1.txt","/tmp/movetest/m2.txt"],"method":"wsl-powershell"}`（剪贴板里正是之前写入的那批 WSL 路径）。
- 已知未解：**Explorer 的粘贴语义无法用脚本复现**（`Shell.Application` 的 `InvokeVerb('paste')` 会挂住；`AppActivate` + `SendKeys('^v')` 打不进文件列表），所以「为什么变成了移动」只能从证据判断（Windows 侧执行了 MOVE）；树里按 Ctrl+X 时插件确实会把 `Preferred DropEffect = 2`（MOVE）写到系统剪贴板，这是有意为之（剪切就该移动）。

##### ⑧ 复制到系统剪贴板：先在工作区里暂存一份，再交给资源管理器

- 用户口径：「能否判断本地环境，如果文件在wsl端，复制目的windows端，此时将文件先复制到.tmp隐藏临时文件夹，实际复制的是临时文件？」，以及随后对「超限退回原件」的否决：「超限退回原行为需要商榷。因为会无声丢失文件。」
- 为什么需要：把**原件路径**放到系统剪贴板，等于把「资源管理器对这批文件做什么」的决定权交出去 —— ⑨ 里那次「文件不见了」正是无法归因于插件的后果。改成把**另一条名字**（暂存副本）交出去，原件从根上不参与外部粘贴。
- 暂存形态：工作区根的 `.dsh-ris-ide/stage/`（`.dsh-ris-ide/` 是插件唯一的隐藏目录，见 ⑨；任何过滤模式下都不作为树行显示，`TREE_WATCH_IGNORED` 也忽略它的抖动）。每次复制一个批次：`.dsh-ris-ide/stage/<批次>/<序号>/<原文件名>`，同名文件各占一个序号目录，粘出的文件名仍是原名。
- 不做字节拷贝：普通文件用**硬链接**（`fs.link`，同 inode、O(1)、不占空间），目录按原结构递归建目录 + 逐文件硬链接 ⇒ 大目录也几乎零成本。只有跨文件系统（`EXDEV`）才真拷贝，这时才计 `CLIPBOARD_STAGE_MAX_BYTES`（64 MB）预算。
- 超限不是降级：`stageClipboardCopy()` 抛 `TailError('too-large', '超过 64 MB，已取消复制到系统剪贴板', 413)`（文案要短，它会出现在 toast 里），路由直接报错；**绝不**在暂存失败时改发原件（那正是「无声丢失」的来源）。工作区未知（没有 `sessionId`）同理 400 `复制到系统剪贴板需要 sessionId`。
- `Ctrl+X`（剪切）不走暂存：剪切就是要移动，仍发**原件**并带 `Preferred DropEffect = 2`（MOVE），这是用户明确要的语义。
- 工作区归属从**查询串**读：页面发的是 `?sessionId=…&cwd=…`（与其它树路由一致），`clipboardScope(body, url)` 先看 body 再看 query。第一版只读 body ⇒ 真实复制一律 400「复制到系统剪贴板需要 sessionId」（`window` 页面的 session id 也走 query），补 `clipboardScope` 后恢复；暂存根必须是真实存在的目录，否则 400。
- 读回来要认得自己：`GET /clipboard/read` 拿 `.dsh-ris-ide/stage/*/manifest.json`（`{at, originals, staged}`）把暂存路径**译回原件**，于是树内 Ctrl+C → Ctrl+V 仍被当成「自家那批」走树内语义，不会被当成外部文件再导入一份。
- 回收：每次发布后 `pruneClipboardStage()` 保留最近 3 个批次且 24h 内的，其余删除；批次目录在发布失败时立刻清掉。
- 客户端失败口径：只有后端整体不可用（`unsupported`，例如没装 xclip/wl-copy 的 Linux）才退回「把路径写成文本」；其它失败 `notify('没能放到系统剪贴板：<原因>')` —— 看上去成功、实际没出去，比明确失败更危险。
- 测试：`test/clipboard.test.mjs` 11/11 —— 真文件 + 真目录的暂存（文件同 inode、目录内文件也是硬链接、原件内容不变、manifest 能译回、批次会被 prune 到 ≤3），「只有 COPY 走暂存、CUT 发原件」的源码断言，「暂存不了就报错、绝不发原件」的源码断言（含 `通知` 文案与 `unsupported` 例外），以及缺 `sessionId` 的 400。全量 `npm test` **355 全绿**。
- 真机（本机 WSL）：暂存后发布的 Windows 剪贴板 `FileDrop` 是 `\\wsl.localhost\Ubuntu-24.04\tmp\live-stage-ws\.dsh-ris-ide\stage\<批次>\0\a.txt`，与 `a.txt` 同 inode，`a.txt` 仍在原地；`readSystemFileClipboard()` 读回暂存路径，经 manifest 翻译回 `/tmp/live-stage-ws/a.txt`。

##### ⑨ 运行期目录收进一个 `.dsh-ris-ide/`：配置 + 回收站 + 缓存 + 暂存

- 用户口径：「插件运行期生成的 .dsh-ris-ide-xxxx 等文件夹合并成一个」，随后补充：「json 配置文件也放在此文件夹内」。
- 之前在工作区根散着三个隐藏目录、两个隐藏 json 文件：`.dsh-ris-ide-trash/`、`.dsh-ris-ide-cache/`、`.dsh-ris-ide-stage/`、`.dsh-ris-ide.json`、`.dsh-ris-ide.settings.json` —— 树里要逐个按名隐藏，用户也要逐个记。
- 现在只有一个：`.dsh-ris-ide/`
  - `config.json`（原 `.dsh-ris-ide.json`）：程序配置（JSONC，面板生成/校验/更新，也可手改）
  - `settings.json`（原 `.dsh-ris-ide.settings.json`）：调试面板的反编译 jar 等可视化设置
  - `trash/`：删除回收（Ctrl+Z 还原）
  - `cache/`：依赖 jar 的源码/反编译缓存
  - `stage/`：复制到系统剪贴板时的暂存批次（见 ⑧）
- 迁移：`ensureIdeStateDir(root)` 每个工作区每进程一次 —— 老目录按内容搬进 `trash/`/`cache/`/`stage/`（同名冲突加 `-legacy-<时间戳>` 后缀，绝不覆盖），老 dotfile 搬成 `config.json`/`settings.json`（新位置已有文件就不覆盖、旧文件留在原地），随后删掉空的旧目录。
- 读兼容、写只写新位置：`readProgramConfig()` / `readDecompilerConfig()` 先读新位置，缺失再读老 dotfile（没迁移也能用）；`writeProgramConfig()` 与 `/settings` 的 POST 先 `ensureIdeStateDir()` 再写。
- 树与 watcher：`.dsh-ris-ide` 在**任何**过滤模式下都不作树行（`if (dirent.name === IDE_STATE_DIR) continue`），`TREE_WATCH_ALWAYS_IGNORED` / `TREE_WATCH_IGNORED` 从三个名字收成一个 `.dsh-ris-ide`。
- 测试：`test/host-tail.test.mjs` 新增「the plugin keeps ONE hidden folder: legacy dot-folders and dotfiles fold in」（老 trash/cache 内容搬进新目录、老 config/settings 变成 `config.json`/`settings.json`、旧目录与旧 dotfile 消失、`.dsh-ris-ide` 不是树行）；其余断言改为新路径。`npm test` **356 全绿**。

##### ⑩ `dsh web` 重启后：独立窗口跟上新 session，点 ⧉ 不再新开第二个

- 用户口径：「ide不关， 重启dsh，ide能否自动更新sessionId和token，同时dsh端能否自动获取上次打开、已存在的ide窗口？」选定的做法 = **A（窗口自动换 session）+ B（DSH 端发现已开窗口，静默复用：只聚焦不新开、不导航）**。
- 事实前提（都已核过）：窗口页只加载本插件 bundle，`dsh web` 重启**不会**重载它，`EventSource` 自己重连；插件路由只做 loopback + same-origin 校验，**没有 token 这回事**；窗口的 sessionId 来自 URL，缺省是合成常量 `dsh-ris-ide-window`，宿主查不到就回退绝对 `cwd`，所以功能不会坏 —— 坏的是「窗口认的还是上一个 dsh 进程里的 session id」。
- A（换 session）：`/stream` 的 `hello` 帧多了两个字段 —— `session`（该 cwd **当前**活跃 session，宿主用 `ctx.sessions.list()` 从后往前找 `header.cwd` 相同的那个）与 `windowSession: {id, live}`（这条流自己带的 session 是否还活着）。独立窗口的根 `StandaloneWindow` 订阅 `hello`：自己的 session 已死（`live !== true`）就 `setSessionId(session.id)` 换成新的；还活着就**不动**（同一 dsh 里另开的新会话是另一条线，不能被这个窗口抢走标题/日志）。
- B（发现已开窗口）：窗口的 SSE 流就是它的**登记**——hub 在独立窗口页里给 `/stream` 加 `window=1` 与 `wname=<窗口名>`，宿主按流计数维护 `IDE_WINDOWS`（键优先用窗口名，无名回退 `cwd`），`GET /dsh-ris-ide/windows?name=&cwd=` 返回 `[{name, cwd, sessionId, alive, idleMs}]` 与 `session`。流断开只是 `alive:false`，`IDE_WINDOW_GRACE_MS = 90s` 宽限后才回收 —— 窗口隐藏（hub 会关流）与重载都不会被误判成关闭；`dsh web` 重启后页面重连 = 自动重新登记，**不需要持久化任何状态**。
- 点 ⧉ 的流程（用户实测三轮才定，按用户口径「降级到新窗口提示已存在旧窗口选择关闭或打开」）：**旧窗口自己关掉、再开新的**。`await standaloneWindowState(windowName, windowCwd)`（`GET /windows?name=&cwd=`，1500 ms 上限）→ 登记 `exists && alive` ⇒ `await requestStandaloneWindowClose(windowName)`：在 `BroadcastChannel(windowName)` 上发 `{type:'close'}`，随后每 100 ms 用 `/windows` 确认那条登记变为 `alive:false`（即窗口真的关了、单窗口锁释放），1500 ms 没关掉就放弃等待；然后无论关闭成功与否都 `window.open(url.href, windowName, features)` 开新窗。窗口没关掉时新窗口会撞锁，于是走窗口页自己的提示（「关闭这个窗口」/「关闭旧窗口，在这里打开」`takeover()`），用户仍有手动出路。
- 为什么不再「提窗」：第一版 `window.open('', name)` + `close()` 用户实测「闪一个窗口又迅速关闭，并没切到旧窗口」；第二版加 `focus-ack` 回执仍不行（用户判「不行，应该是被禁止」）—— 浏览器不允许一个文档把别人开的窗口提到前台。**旧窗口能自己 `window.close()`（它是脚本开的），dsh 页不能替它聚焦**，所以「让它自己关」是唯一可靠路线。
- 窗口页：`showBlocked()` 增第二个按钮「关闭旧窗口，在这里打开」→ 文案「正在关闭旧窗口…」+ 发 `{type:'close'}` + `takeover()`（轮询 `navigator.locks` 拿锁，最多 2 s，拿到即 `startHere()` 并持续持锁；超时提示「旧窗口没有关闭（可能被浏览器阻止）。请手动关掉它后重试。」）；`closeForOpener()` 响应 `{type:'close'}`。
- `dsh web` 重启后 IDE 不会自己恢复，用户口径：「dsh停止后，IDE会报错，然后dsh启动后，发个消息让IDE刷新一下，去掉异常信息。」⇒ hub 记 `hadFailure`（`source.onerror` 置 true），下一次 `source 'open'` 若发现「之前坏过」就 `announceRecovery()`：通知 `recoveryHandlers` 订阅者，并 `window.dispatchEvent(new CustomEvent('dsh-ris-ide:host-recovered'))`。`useHostRecovery(cb)`（ref 保鲜，只订阅一次）接到四处：树（`setError(undefined)` + `recoverTree()`）、日志尾（`refresh()`）、程序控制台（`refresh(false)`）、编辑器（把 `kind === 'error'` 的文档丢掉重读，**已编辑的文档不动**）。另把 `loadLevel` 成功时的 `if (!background) setError(undefined)` 改成无条件清 —— 后台刷新读成功、红横幅却「正在自动重试…」挂着，正是用户看到的那条残留。
- 一个工作空间一个窗口：窗口名 = `WINDOW_NAME + '-' + standaloneWindowKey(windowCwd)`，即**按工作空间 cwd 派生**（`wname` 进 URL、进锁 key、进 `BroadcastChannel` 频道名、进宿主登记表键）；不同工作空间 = 不同窗口/不同频道/不同登记，互不干扰（用户口径「注意，不同工作空间，用不同的IDE窗口」）。
- 窗口页：`mountStandalone` 多收一个 `windowName`（`window.html` 把 URL 的 `wname` 传进来）；无 Web Locks 的兜底探测也补了 `{type:'focus'}` 处理（之前只有 Web Locks 分支的 holder 响应）。
- 用户实测反馈（两处）：「ide还是打开个窗口又迅速关闭，并没切到旧窗口」已由「先查表不建窗」修掉；紧接着又报「关 dsh 窗口后再点 IDE ⧉ 不切过来（opener 变了）」「关掉 IDE 窗口后点 ⧉ 只提示『已切到打开窗口』、再也打不开」。⇒ 两条都是「有登记 = 一定有窗口」这个假设不成立：
  - **聚焦要回执**：`focusStandaloneWindow` 现在是 `Promise<{ack, focused}>` —— 窗口收到 `{type:'focus'}` 后 `window.focus()` 并回 `{type:'focus-ack', focused: document.hasFocus()}`（`window.html` 里的 `answerFocus()`，Web Locks 分支与无锁兜底都走它），900 ms 内没收到 ack 视为失败。ack 的 `focused === true` 才 `return null`（一个窗口都不开）；否则落到 `window.open(url.href, windowName, features)` —— 用**同名**打开会让浏览器把那个窗口重载并提到前台（换 opener 的 dsh 新标签页没资格 `focus()` 别人的窗口；宁可这一种边界情况重载一次，也不能让按钮点了没反应）。
  - **死登记不拦路**：登记的 `streams` 只代表「有没有活着的 SSE」。`alive !== true` 的登记（刚关窗口、进程重启前的旧流）**不等 ack**，直接开窗；`alive === true` 才走 focus 握手。这样「关掉 IDE → 点 ⧉」立刻开新窗，不会再被 90 s 宽限里的旧条目挡住。
- 用户实测第四轮（m03587）：「关闭旧窗口并在当前窗口打开，第一次可以，再关闭、打开 dsh 窗口，第二次点 IDE，不行了，旧窗口钩子没更新？」⇒ **确实如此**：抢到锁的窗口要负责响应 `BroadcastChannel` 上的 `{type:'close'}`（DSH 页靠它让旧窗口腾位），但第一版只有「加载时抢到锁」的路径调 `becomeHolder()`；`takeover()`（点「关闭旧窗口，在这里打开」接管）和「无 Web Locks 兜底探测」两条启动路径都没装钩子 ⇒ **接管出来的窗口对 close 消息是聋的**，下一次点 ⧉ 时握手必然超时、旧窗口赖着不走，新窗口撞锁只好弹提示，看起来就是「第二次点 IDE 不行」。修法：钩子装进 `startHere()`（首抢、手动接管、无锁探测三条路都经过它）⇒ **旧窗口关掉后钩子一定跟着落到新窗口**；`showBlocked()` 的提示页也调一次 `becomeHolder()`（被挡住的那个窗口同样能被关闭/聚焦）。
- 登记不依赖订阅哪些 topic：`/stream` 的 `cwd` 只有「请求的 topic 需要 cwd」时才会解析，可窗口的登记用不着它 —— 只订阅 `hello` 的窗口曾被漏登记（`/windows` 里看不到它，⧉ 于是又开一个）。现在 `window=1` 的流直接用 URL 里的 `cwd`（绝对路径才认）当窗口工作区，`hello.session` 也用同一个 cwd 查活 session。
- 测试：新增 `test/windows.test.mjs`（路由前缀与 GET-only 契约、登记表按名字/按 cwd、双流计数只减不减死、`liveSessionFor` 取最新同 cwd 的活 session、`/windows` 真 HTTP 往返 + 相对 cwd 400、客户端源码断言「hub 带 window/wname」「StandaloneWindow 订阅 hello 且只在 self-dead 时换」「opener 先查 /windows，有登记就发 close、缺 close 处理会被测出来」「`startHere()` 装钩子」「阻塞页也应答 close/focus」「window=1 的流按 cwd 登记」、窗口页源码断言）。`client-viewer.test.mjs` 另有三例：登记存在且回执 `focused:true` ⇒ 不开窗；回执 `focused:false`（浏览器拒绝提窗）⇒ 同名重开一次；`alive:false` 的登记 ⇒ 不等 900 ms、直接开。`npm test` 全绿。

#### 控制台「调试」的遮罩文案 / 侧栏 🐞 打开 IDE 后自动开始调试

- 用户口径：「1. 控制台 点击调试，loading 不对 显示 停止中。 2. 侧边栏控制台 点击调试 自动打开 IDE 应自动触发对应程序的调试。」
- 行遮罩文案改为**按动作**说：`busyMaskText(alive, kind)` — 调试 → `调试中…`、重启 → `重启中…`、停止/启动才看 `alive`（`停止中…`/`启动中…`）。两侧控制台各自记住 `busyKind` / `consoleBusyKind`，遮罩带 `data-program-loading-kind`。此前调试一个**运行中**的程序会闪「停止中」（宿主是在原进程上重启并挂 JDWP，看起来像点了停止）。
- 侧栏 🐞 打开的独立窗口现在真的会开始调试：窗口把目标行作为 `openProgram` 交给工作台（日志面板直接开在那个程序的日志上），`autoDebug` 改成就绪后再触发——原来挂在 `useEffect(…, [])` 且只看 tab meta，首帧 `programs` 还是空的，`debugProgramId` 为 `undefined` 就永久放弃了。
- 测试：`npm test` 全绿（`busyMaskText` 四种动作 + 遮罩标记；`openProgram`/日志预置/`autoDebug` 等待行就绪 的源码断言）。

#### 编辑器自动搜索定位到文件第一个结果

- 用户口径：「编辑器自动搜素内容时，定位到第一个结果（从文件开头搜索）。」
- 自动搜索（在查找框里打字、`Aa`/`.*`/`ab` 切换重新生效、`Ctrl+F` 带着选区预填、以及没有命中行号的 `searchFor`）现在先 `findFirstFromStart(view)`（`view.dispatch({ selection: { anchor: 0 } })` + `findNext`），**从文件开头**找第一个匹配——此前是从光标当前位置往后找，光标停在文件深处时会跳到后面某个匹配。
- `↑/↓`（上一个/下一个）保持相对当前位置；工作区内容检索点进来的命中仍带行号，照旧先跳到命中行再 find（`searchForText(view, text, line)` 的 `line` 分支未变）。
- 测试：`npm test` 全绿（源码 + 构建产物断言：`findFirstFromStart`、`if (jump) findFirstFromStart(view)`、`Ctrl+F` 预填后跳首个、`line` 分支保留）。

#### 只读预览加「编辑」：强制全量加载进入编辑

- 用户口径：「只读预览 · 大文件 右端增加编辑按钮，强制全加载进入编辑。」
- 只读预览的标题栏右端新增 `编辑` 按钮（`data-large-text-edit="1"`）：点击后按 `LARGE_TEXT_WINDOW_BYTES` 逐窗把整个文件读回来（`readWholeFileText`，预览为了控内存会丢弃前段，所以必须重新读），拼成 `kind:'text'` 文档交给普通编辑器——可改、可保存，标题栏不再出现「只读预览」。
- 上限 `LARGE_TEXT_FORCE_MAX_BYTES = 32MB`：超过则拒绝并提示（编辑一个更大的单文档只会把窗口拖死），只读预览仍可用。
- 选择被记住：路径进 `forceEditPathsRef`，关闭页签再打开时 `ensureDoc` 看到 `too-large` 也直接全量加载进编辑，不再回到预览。
- 测试：`npm test` 全绿（体积/分窗循环/`kind:'text'` 交接/上限提示/重开仍可编辑 的源码断言，加在「an oversized text file opens a read-only windowed preview」里）。

#### 文件树点击语义修正（右键「进入」换根）/ 新建文件悬浮二级菜单 / 弹窗锚定鼠标 / 日志查找条对齐 / 后台刷新静默 / 大文件预览不跳回顶部

- 文件树点文件夹行 = **只展开/折叠**（与行首三角 `▸/▾` 同义）；换根是**刻意动作**：右键菜单里的「进入」（`data-tree-action="enter-dir"`，仅目录行出现）——`openDirRoot`，`data-tree-root` 变成该目录、行首出现 `↑ 上级` 逐级弹回工作区根；检索里点目录条目依旧直接换根；帮助面板「点击文件夹」一行按新语义改写。
- 日志查找条与编辑器查找面板统一：`LogTail` 的 `data-log-find-bar` 不再用 `S.headSearch`/`S.button` 拼样式，新增 `S.logFindBar` / `S.logFindInput` / `S.logFindChip` / `S.logFindCount`——22px 输入框、24×22 chip 的 `↑`/`↓`/`×`、右对齐等宽计数，与 `SEARCH_PANEL_CSS` 的自绘面板同一套高度与配色（此前两边按钮大小、行高都不一致）。
- 后台文件树刷新静默：`refreshTree(announce)` 只在**标题栏 ⟳ 点击**时提示「文件树已刷新 / 刷新失败 N 个目录」；`.gitignore` 眼睛切换等后台重读不再弹 toast（列表本身变了就是反馈）。`treeRefresh` 状态携带 `{ tick, announce }`，`IdeTree` 收 `refreshNonce` + `refreshAnnounce`。
- 大文件只读预览不再「滚不到底、老回到顶部」：`LargeTextPreview` 原先声明在 `ProgramWorkbench` 内部，父组件每次渲染都是新的组件类型 ⇒ 每加载一页（父级 state 更新）整棵子树重挂载，滚动容器的 `scrollTop` 归零。现在提到模块作用域（稳定组件身份），并按路径把滚动偏移记在 `LARGE_TEXT_VIEW`（`Map`）：切到别的页签再切回来（`display:none` 会把滚动位置钳到 0）也能回到原处；只在容器停在顶部时恢复，用户正在滚动时绝不抢位置。
- 新建文件二级菜单改为**悬浮面板**：右键菜单「新建文件 ▸」不再把主菜单替换成文件类型列表，而是 hover 时在主菜单右侧弹出独立面板（`data-tree-submenu-panel="new"`，锚定该菜单项、`menuSub` 记住飞出的偏移；鼠标离开整块区域才收起），类型项标记仍是 `data-tree-new="<ext>"`。菜单每次开关都会清掉飞出状态（`useEffect(..., [treeMenu])`）。
- 文件操作弹窗**锚定鼠标位置**：新建/重命名/创建副本/粘贴为/删除确认不再居中遮罩，而是出现在鼠标右侧偏下（`dialogAnchor(width,height)`，`pointerRef` 在 pointerdown 记录坐标，视口边缘夹紧、兜底居中）；遮罩透明，点空白即关（删除确认的遮罩不关，防误触）。
- 测试：`npm test` 全绿（新增日志查找条 chip 断言、后台刷新静默断言、`LargeTextPreview` 模块作用域 + 滚动记忆断言；树点击语义断言改为「单击只展开 / 右键菜单 进入 换根 / 无双击手势 / 悬浮二级菜单锚定」）。

#### 文件弹窗的锚点冻结

**弹窗跟着鼠标跑**：文件操作弹窗（新建/重命名/粘贴为/删除确认）按"鼠标右侧"定位后，只要用户再按一次鼠标（哪怕只是点弹窗里的按钮、或移开后再点），弹窗就跳到新位置——因为定位是在**每次渲染时重新读实时指针**，而任何一次 pointerdown 都会刷新指针并触发重渲染。现在**在弹窗打开的那一刻把指针位置冻结**，关闭时释放；窗口从此不再移动。

- 测试：`npm test` 全绿（新增"a dialog keeps the anchor it opened at when the pointer moves or clicks again"：源码守卫——`dialogPointRef` 冻结/释放、`dialogAnchor` 只读冻结点）。

#### 粘贴撞名：单文件「改名 / 覆盖 / 取消」，批量「覆盖 / 生成副本」

**撞名的单文件粘贴不再偷偷加「副本」后缀**：卡片的文件名框里就是**原来的名字**，卡片多一个 **覆盖** 按钮——

- **确定**：名字没改动 ⇒ **不粘贴**，卡片内联提示「同名文件已存在，请改名（或点「覆盖」）」；改过名字 ⇒ 按新名字粘贴。
- **覆盖**：直接把目标目录里的同名文件替换掉（宿主 `overwrite: true`），不再二次确认。
- **取消**：什么都不做。

**拖放同样适用**：单文件拖到已存在同名文件的目标目录会停下弹同一张卡片，且保留"移动"语义（覆盖按钮移动而不是复制）。

**批量撞名不再静默加后缀**：多选 Ctrl+C / 多选拖动时，只要有同名文件就弹一张**没有文件名输入框**的卡片——标题「有 N 个同名文件」+ 名单，只有两个按钮：

- **覆盖**：把撞名的那些直接换成新的（其余文件照常落位）；
- **生成副本**：撞名的那些改名为 `… 副本` / `… 副本(n)`，其余照常落位（并用一条提示说明生成了哪些副本）。

两种选择都只影响撞名的那几个文件，整批操作仍只留一条 Ctrl+Z 撤销；Esc / 点空白处 = 取消（已落位的非撞名文件保留）。

- 测试：`npm test` 全绿（撞名预填原名、覆盖按钮、内联请改名、单文件拖放走卡片、批量弹「覆盖 / 生成副本」）。

#### 1.7.2 · 编辑器 Ctrl+F / 定位到当前文件 / 文件树高亮 / 下拉框遮挡 / 检索流式分页 / 大文件保存 / 拖动确认

用户口径（一次三条）：「① 编辑器，如果搜索面板已打开，ctrl+f 光标也要移入搜索框。② 定位到当前文件按钮，经常失效，打开文件后，进行其他操作，然后定位就失效了。获取当前文件的逻辑不对？编辑器页签高亮的就是当前文件？定位文件要展开所有上级目录，且滚动条定位到文件。③ 现在定位文件后，文件树此文件永远高亮，直到下次定位。不需要独立的高亮标识，定位展示即可，保证高亮文件和编辑器打开的文件一致。」

##### ① Ctrl+F：面板已打开时也要聚焦查找框

- 根因：自绘查找面板（`src/chunks/codemirror.js` 的 `ideFindPanel`）的搜索框没有 `main-field` 属性。`@codemirror/search` 的 `getSearchInput(view)` 只按 `querySelector("[main-field]")` 找输入框，`openSearchPanel` 在面板已打开时靠它把焦点移过去 ⇒ 找不到就什么都不做（面板已打开时 `mount()` 不会重跑，`focusInput()` 也就没人调）。
- 修法：`searchInput.setAttribute('main-field', 'true')`（与内置面板一致）；面板侧再给 `dom` 加一个 keydown 监听——焦点在替换框/开关按钮里时 CodeMirror 的 keymap 收不到按键，同样要回到查找框；日志面板与纯文本回退编辑器（`IdeEditor`）的查找条补 `findInputRef` + Ctrl+F 直接 `focus()`（它们此前只靠挂载时的 `autoFocus` / `findOpen` effect，条已打开时不会再执行）。
- 浏览器快捷键：这些监听都 `preventDefault()`，浏览器自己的查找条不会再冒出来；另外「焦点根本不在编辑器里」（页签栏、文件树、工作空间检索框——CodeMirror 的 keymap 只收文档内的按键）时由工作台补一条兜底监听：独立 IDE 窗口（`ownsKeyTarget`）里 Ctrl+F 一律 `preventDefault`，交给打开文件的编辑器句柄新方法 `handle.find()`（chunk 里就是 `openSearchPanel(view)`，已打开则聚焦查找框），没有文本编辑器时退回聚焦工作空间检索框。`event.defaultPrevented` 保证不与 CM keymap / 面板监听重复处理。
- 测试：「Ctrl+F with the search panel ALREADY open puts the caret back in the find field」（含 `handle.find()` 与兜底监听的断言）。

##### ② 定位到当前文件：展开全部上级 + 滚到那一行（并修两处失效）

- 根因 1（竞态，表现为「经常失效」）：`locate()` 的循环把每层 `setExpanded(function (prev) { … state[descend] = true … })` 里的 key 读自循环变量 `var descend`；React 延后执行 updater，执行时 `descend` 已被后面的迭代改写 ⇒ 只展开较深的一两层，最上层祖先没展开、行不存在，`reveal` 找不到 `[data-tree-path]`，于是「点了没反应」。浏览器实测（reload 后冷树、活动文件是深层文件）：`expanded` 终态只有 `.../src` 和 `.../src/chunks`，缺 `.../dsh-ris-ide`。这正是 `fetchLevel` 注释里警告过的同一个坑。
- 根因 2（换根后彻底失效）：树被右键「进入」（或检索点目录）换到子目录后 `activeRoot ≠ rootPath`，`locate()` 从 `activeRoot` 往下走；文件在根外时 `childEntryFor` 立刻返回 `undefined` ⇒ 直接 break，什么都不发生。
- 修法：先按 `childEntryFor` 把要展开的目录收进 `chain` 数组（同时预读 level），最后用**一次** `setExpanded` 把整个 chain 打开（updater 读的是冻结后的数组，不再读循环变量）；`locate()` 开头用新增的纯函数 `pathWithin(parent, child)` 判断文件是否在当前树根内，不在而工作区根能覆盖时 `setRootTrail([])` 把树复位到工作区根再走；末尾仍 `props.onOpen(filePath)` + `revealRow(filePath)`（滚动 effect 12×60ms 重试，等行渲染出来）。
- 测试：「pathWithin decides whether the locate walk can start at the tree root」「locate expands EVERY ancestor in one update and re-roots when the file is outside the tree」。

##### ③ 去掉定位的独立高亮，树里「当前文件」只跟编辑器一致

- 根因：行渲染里 `isRevealed = reveal !== null && reveal.path === entry.path`（`reveal` 直到下次定位才变）参与 `S.treeRowOn` ⇒ 定位过的行永远亮着；切到别的页签后 `activePath` 已变，旧行只剩这层定位高亮，与编辑器打开的文件对不上。
- 修法：`reveal` 只用于滚动（`isRevealed` 与 `data-tree-revealed` 全部删除）；新增 `isCurrent = isActive || (isSelected && entry.isDir === true)` —— 强高亮只表示「编辑器正在显示的文件」或「操作目标目录」；文件行仅被选中（右键、Ctrl+点击）时用较弱的 `S.treeRowMulti`；新增 `data-tree-current` 标记当前行。切页签的同步 effect 保持原样（`selectedPath` 跟随 `activePath`）；另外 `locate()` 末尾补 `selectOne(filePath)`：定位后活动文件若没变（同步 effect 不跑），之前右键选中的目录会一直带强高亮，定位这个动作本身必须把选中项改到那个文件上。
- 测试：「the tree highlight follows the editor, not the last locate」。

##### ④ 工作空间文件检索的下拉结果被编辑器查找面板遮挡

- 根因：CodeMirror baseTheme 给 `.cm-panels` 设了 `z-index: 300`（`position: sticky`），而检索下拉框锚在编辑器面板头部行 `editorPaneHead`（`z-index: 30`，本身就是一个层叠上下文）里、`z-index: 60` 只在那个上下文内有效 ⇒ 查找面板一打开就整块盖住下拉结果（下拉 y 26–292，面板 y 48–113，点哪儿都是面板元素）。头部行不能靠 `overflow: hidden` 解决（历史上已经因为裁剪下拉框翻过一次车，见 `editorPaneHead` 注释）。
- 修法：在注入的 `SEARCH_PANEL_CSS` 里把 `.cm-panels` 压到 `z-index: 20 !important` —— 它只需要盖住编辑器内容层（选区层 z 5 等），不需要压过工具栏；头部行（30）于是赢，下拉框正常显示在面板之上。
- 测试：`the editor find panel matches the IDE chrome` 增加 `.cm-panels{…z-index:20 !important}` 与 `editorPaneHead` 的 `zIndex: 30` 两条断言。

①②③④⑤⑥ 全部属于 **1.7.2** 这一个版本（不再单独发 1.7.3/1.7.3）。其中①—④只改客户端（`src/chunks/codemirror.js` 已用 `tsdown` 重建并提交 `lib/client-codemirror.js`）⇒ 硬刷新页面即生效；⑤⑥ 有宿主改动（新路由 / `fs/write` 新行为）⇒ **需重启 `dsh web`** 才完全生效（客户端半硬刷新即可，且对旧宿主有 404 / 413 的降级表现）。

##### ⑤ 工作空间检索改成流式分页（首页先渲染）

用户口径：「文件检索还是有点慢，检索过程能否也实现异步分页？比如传入 pagesize，检索结果每达到 pagesize，就异步发送结果，直到全部完成。接收端收到第一页就可以提前渲染到界面了。」

**慢在哪（先量再改）**

- 宿主 `/search?q=agent&limit=300`：**404 ms**（`files` 1655、`roots` **32**）；`/search-content?q=agent&limit=200`：**344 ms**。
- 32 个 repo root 逐个 spawn：`git ls-files -z` **顺序 1.025 s**（13 908 个文件）vs **全并行 0.094 s**；`git grep -n -I -m 8` **顺序 1.748 s** vs 并行 0.509 s。⇒ 瓶颈是 **32 次串行进程启动**，不是要扫的文件数；而且整包要等最慢的 root。

**宿主：`/search/stream` 与 `/search-content/stream`**

- 新增两条 **GET** 路由（`SEARCH_STREAM_PATH` / `CONTENT_SEARCH_STREAM_PATH`），普通检索路由保留（单文件补全等旧调用不动）。
- 应答是 **NDJSON**（`application/x-ndjson`、`cache-control: no-store`、`x-accel-buffering: no`）：`{type:'start',root,repoCount}` → 若干 `{type:'page',items}` → `{type:'done',files,matches,truncated}`（校验错误仍是普通 JSON 400，失败帧是 `{type:'error',code,message}`）。
- `pageSize` 参数（默认 `SEARCH_STREAM_PAGE_DEFAULT = 40`，上限 `SEARCH_STREAM_PAGE_MAX = 500`）；`limit` / `perFile` 语义与批量路由完全一致。
- 各 repo root **并行**跑（`SEARCH_STREAM_CONCURRENCY = 6`），但 `createOrderedPages()` 让**页按 root 顺序发出**（每个 root 一个 buffer，队首 root 没完成时后面的只缓冲）⇒ 排序与串行版逐行相同，翻页不重排；某 root 攒满 `pageSize` 立刻发一页，所以第一页在**最快的 root** 答完就到了。`limit` 的预算也按**已发出顺序**扣（不是到达顺序）：否则后面的 root 会先抢走行数，流式前缀就和批量版不一致（实测内容检索第 143 行起两条路径不同，改成按 root 顺序计预算后 `deepEqual` 完全一致）。
- 客户端断开（`res.on('close')`）或达到 `limit` 时置 `stream.aborted`、SIGTERM 所有子进程；`close()` 会把已接受但未满一页的行**按 root 顺序补发**（早期版本直接丢弃 ⇒ `limit` 小于 `pageSize` 时一页都不流，测试 `stops early at limit` 守着）。

**客户端：边收边画**

- `readSearchStream(response, onPage)`：`getReader()` + `TextDecoder` 切 NDJSON，`page` 交给 `onPage`；无 `done` 帧视为「检索连接中断」；`error` 帧抛错。
- 两个检索 effect 改成 `fsSearchStream` / `fsSearchContentStream`：每页到达即追加进 `searchHits.matches` / `contentHits` 并 `setState`（下拉框首屏只等第一页），`done` 后再把完整结果写进检索缓存；每次输入变化用 `AbortController` 中止上一条流（`isAbortError` 不显示成错误）。
- 参数：文件名检索 `limit=300`、内容检索 `limit=200`，`pageSize=40`（`SEARCH_STREAM_PAGE_SIZE`）。
- **混合版本的兜底**：宿主半只有重启 `dsh web` 才会加载新路由，而客户端半一次硬刷新就换了新代码 —— 所以 `fsSearchStream`/`fsSearchContentStream` 收到 **404** 时改问旧的批量路由、把结果当成一页交出去（下拉框不会因为宿主还没重启就报 「HTTP 404」）。

**测试**

- `test/host-search.test.mjs`：「GET /search/stream pages the filename matches in tree order and ends with done」（两个嵌套 repo、`pageSize=1` ⇒ 两页且顺序按 root）、「GET /search-content/stream pages grep hits and keeps the batch validation」（含缺 q 的 400、POST 的 405、缺 sessionId 的 400）、「GET /search/stream stops early at limit and reports truncated」。
- `test/client-viewer.test.mjs`：「streamed search answers are read page by page, not after the whole body」（跨帧切分的 NDJSON、缺 done 抛错、error 帧、无 ReadableStream 的浏览器）、「the search effects stream their pages and abort a query the user moved past」。


##### ⑦ 文件树里拖动文件，放入前先确认

- 用户口径：「文件树，拖动文件，放入时先弹出确认。」
- 根因（旧行为）：`onDrop` 直接 `void moveEntriesInto(paths, dropDir)` —— 松手即移动，鼠标滑一下、或本想拖到编辑器却落在树上，文件就已经被搬走（只能靠 Ctrl+Z 撤销，还未必意识到发生）。
- 修法：`requestMove(paths, dirPath)` 先过 `movablePaths()`（跳过自己/本来就在目标里的/把目录拖进自己子树），把要移动的行存进 `pendingMove = {paths, dir}` 并渲染确认卡：标题「移动这个文件/文件夹？」或「移动 N 项？」，列出名字与「移动到：<目录>」，按钮 `取消` / `移动`（`data-tree-move-confirm` / `-cancel` / `-ok`）。`取消`（或 Esc / 点遮罩）什么都不做；`移动` 才调 `moveEntriesInto`。行 drop 与树空白区 drop 都走这条；外部文件拖入仍走原来的导入流程。
- 键盘/焦点：确认卡打开时 Del、Ctrl+C/X/V 一律不生效（守卫里加 `pendingMove !== null`），焦点落在 `取消`，Esc 关闭后把焦点还给树；`anyDialogOpen` 也计入它，锚点冻结逻辑一致。
- 测试：`a drag inside the tree confirms before it moves anything`（`requestMove`/`movablePaths`、两处 drop 都走确认、无裸 `moveEntriesInto(paths, dropDir)`、卡片与按钮属性、Esc/焦点、键盘守卫）。

##### ⑥ 保存大文件：`fs/write` 自己的长度上限 + 超限自动分片

用户口径：「编辑较大文件时，保存报错，post 内容过大」→ 追问「判断如果超上限能否分片传输？」

**根因**

所有 `POST` 路由共用 `readJsonBody()` 的 `MAX_BODY_BYTES = 64 KB`（原本只服务 `stop` 这类两行 JSON）。而 `fs/write` 的 body **就是整个文档**：只要文件超过约 64 KB，保存必然 413 `request body too large`（编辑器却允许打开到 512 KB，还能「强制编辑」更大的文件）——报错方式和「文档能不能打开」完全对不上。

**修法（两步，第二步才是「无上限」）**

1. `fs/write` 单独一个 body 上限 `FS_WRITE_MAX_BODY_BYTES = 8 MB`（`readJsonBody(req, limit, message)` 加了两个可选参数，其它路由仍是 64 KB），超限时回中文可读消息：`文件太大（超过 8 MB），不能在这里保存；请改用其他编辑器`。
2. 超过 `SAVE_CHUNK_BYTES = 512 KB` 的保存在客户端**自动分片**：按 UTF-8 字节切成若干块、切点回退到多字节字符的首字节（不会把 `汉` 劈成两半），逐块 `POST /fs/write` 并带 `{offset, final}`。
   - 宿主把块写到同目录的 `<target>.dsh-ris-ide-saving`（`FS_WRITE_TEMP_SUFFIX`），按字节 offset 定位写；**块必须连续**（要求当前暂存文件大小 === offset），否则 409 `chunk-out-of-order`，不会在文档中间留下零字节。
   - 只有 `final !== false` 的块 `truncate(offset + bytes)` 后 `rename` 覆盖目标 ⇒ 读到的永远是旧文件或完整新文件，绝无「半截文档」；保存失败时目标文件保持原样，下次从 offset 0 重新开始即可。
   - 512 KB 以下是**单请求**（老行为不变），所以普通保存只是多一次字符串长度判断。
   - 暂存文件与目标同目录（rename 才原子）；文件树把 `<名>.dsh-ris-ide-saving` 一律跳过（崩溃后残留的也不显示）。
- 测试：`the fs routes read text, refuse binary/oversized and write back`（120 KB 单请求可保存、9 MB 单请求被 413 且不碰磁盘、分片保存含多字节字符、暂存文件 rename 后消失、跳块 409 且旧文档仍在、offset 0 重来可恢复）；`fsWrite sends an oversized document in utf8 chained chunks`（1.6 MB 汉字文本 ⇒ ≥3 块、offset 递增、只有最后一块 `final`、拼接回原文、单块失败即停）。


#### 1.7.3 · 技能：自定义 `startCommand`/变量约束 + 低内存与多开预算

- 用户口径：「① 微服务项目，java可能需要多开。② dsh-ris-ide插件技能，约束一下自定义变量，以及低内存处理」
- 技能 `skills/dsh-ris-ide-debug/SKILL.md`（158 → 193 行）：铁律 8 补「custom 条目绕过程序 `jvmArgs`、内存参数必须内联」，新增铁律 9（本机 8 GiB、常驻服务已占 ~3.5 GiB，多开前读新节）；新增 **§0.1 自定义 `startCommand` 与变量约束**（唯一占位符 `${JDWP_ARGS}`：普通启动替换成空串、调试启动替换成 `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:<随机端口>`；其它 `${...}` 不替换，`$(cat target/cp.txt)`/`$HOME` 是故意交给 bash 的；custom 分支绕过 `jvmArgs`；本机 4 个 custom 条目；保留 `-DJM.LOG.PATH`/`-Dcsp.sentinel.log.dir`；30 秒自检：`/proc/<pid>/cmdline` 应见 `-Xmx…`、不应见字面 `${JDWP_ARGS}`、调试时应见 `-agentlib:jdwp=`）；新增 **§0.2 低内存处理**（`MIN_FREE_MEMORY_BYTES = 1 GiB` 启动护栏、JVM 默认堆 = 物理内存/4 的坑、三档参数、4 服务多开实测表、8 GiB 容量口径、RSS 重复计共享页/看 PSS、OOM 症状→升档与 `dmesg` 查 oom-killer、`-XX:+ExitOnOutOfMemoryError` 行为、调档命令与 `jcmd GC.heap_info`/`VM.metaspace` 查法）；§6 失败速查补 3 行（内存不足被拒 / 多开变慢或服务消失 / 改 `jvmArgs` 无效）。
- 本机配置（工作区 `.dsh-ris-ide/config.json`，不改插件代码）：`defaults.jvmArgs` = `-Xms64m -Xmx512m -XX:MaxMetaspaceSize=320m -XX:+UseSerialGC -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8`；7 个重档 `-Xms96m -Xmx768m -XX:MaxMetaspaceSize=448m`（register/ai/am/upms/rm/wf/onlinesale）；`ris-model-biz` `-Xms128m -Xmx1g -XX:MaxMetaspaceSize=512m`；4 个自定义 `startCommand`（`ris-gateway`/`ris-model-biz`/`ris-am-biz`/`ris-upms-biz`）把同档 flags 内联进 `exec java` 行并补上 `${JDWP_ARGS}`（此前这 4 个条目没有占位符，一直无法调试）。
- 实测（2026-11-04）：4 个服务同时运行 PSS 合计 **2.33 GiB**（model-biz 689 / upms-biz 780 / auth 431 / gateway 428 MB），各 JVM 堆实际只用 87–229 MB，其余是 Metaspace committed + 代码缓存 + 线程栈 + 共享 jar 页；启动耗时（含 `mvn -am compile`）model-biz 42–62 s、upms-biz 46–58 s、auth 17–20 s、gateway 15–16 s；`ris_dev_restart ris-auth` 的 cmdline 验证新 flags 与 `-XX:+ExitOnOutOfMemoryError` 生效；`ris_dev_debug {action:"start"}` 对 `ris-gateway` attach 到端口 46521，验证占位符替换正确（cmdline 无字面 `${JDWP_ARGS}`）。
- 生效方式：这是纯技能/文档改动 ⇒ 装新快照后 `ris_dev_skill sync`（默认 target `project`）刷新 `<工作区>/.dsh/skills`，**不需要重启 `dsh web`**；本机 `AGENTS.local.md` §1/§2 同步了多开预算与档位表。

#### 1.7.3 · 独立窗口跟随当前会话的工作区 + 侧栏打开配置不再报 `shortName is not defined`

- 用户口径（2026-11-05，bip-dzjg/workspace）：「① 会话中直接点击 dsh 右上角按钮打开的 ide 是上一次会话的工作区；右侧控制台面板按钮打开 ide 是对的。② 打开运行配置文件报错 shortName is not defined，文件是正常打开了。」
- ① 根因：header 按钮（`RisIdeWindowAction`，注册在 `conversation.session.header.utilities`、order -8）只把 `sessionId` 交给 `openStandaloneWindow`；该函数在没有 `cwd` 时回退 `knownWorkspaceCwd()` = localStorage `dsh-ris-ide:last-cwd`（**整个 origin 一份**，任何一次宿主应答的 `root` 都会写它）。于是切换会话后点按钮，URL 的 `cwd` 与单窗口名 `wname` 仍指向上一个会话的工作区 ⇒ 打开/顶掉的是上一个工作区的 IDE。右侧栏面板一直正确，是因为 `openCompactWindow` 明确传了 `props.scope.cwd`。
- ① 修法：用会话作用域 slot 的标准 props `useSessions` + `sessionId` 读当前会话的 `cwd`（与 DSH 官方 `open-in-app` 同法：`useSessions((state) => state.byId[sessionId]?.cwd)`），新增模块级 `sessionWorkspaceCwd(useSessions, sessionId)`（无 hook / 无会话行 → `undefined`，调用方保留回退），header 改为 `openStandaloneWindow({ sessionId, cwd: sessionCwd, windowCwd: sessionCwd })` ⇒ URL 的 `cwd` 与单窗口名都跟当前会话走；纯客户端修复，不需要宿主改动。
- ② 根因：`shortName` 原先声明在 `ProgramWorkbench` **组件内部**，而同文件的兄弟组件 `ProgramsPanel.openConfig()`（侧栏控制台的 📄）也调用它 ⇒ `ReferenceError: shortName is not defined`。`sidebar.openResource(...)` 在报错前已经执行，所以文件正常打开，只有提示语被 catch 成「打开配置失败」。
- ② 修法：删掉组件内的 `shortName`，统一用模块级 `fileBaseName`（`lib/client.js:3153`，行为一致）；14 处调用（含 `.map(shortName)`）全部改名，两个面板共用同一实现（与 `stopGlyph` 之前踩过的坑同一类）。
- 测试（`test/client-viewer.test.mjs`）：`the header button opens THIS session's workspace, not the remembered one`（`sessionWorkspaceCwd` 取值/缺省/空 cwd，以及按钮把 `cwd`+`windowCwd` 传给 `openStandaloneWindow` 的接线）；`the config note names the file without a helper nested in another component`（不得再有 `function shortName(`、`fileBaseName` 必须在模块作用域、侧栏提示与工作台批量提示都用它）。`npm test` 388 项全绿。
- 生效方式：**纯客户端改动**（只动 `lib/client.js`）⇒ 装快照后**硬刷新页面（Ctrl+Shift+R）即生效，不需要重启 `dsh web`**。

### 1.8.0 · risd 代理 daemon（Phase 0.5 / 1a / 1b）+ 代理面板独立页签

- 用户口径（2026-11-08）：「先不开发 daemon，先修 bug」→ 两个 IDE bug 修完后「文档定版后就执行」，按当时的设计稿分阶段落地；验收后「ris-ide 1.7.3 和 ris-yds 1.0.0 都已经发版。现在版本都要更新」⇒ 本轮并入 **1.8.0**（daemon 是改动内容较多的一次，按版本号规则升 Y）。
- **Phase 0（bug 修复 + 止血）**：`process.once('exit')` 与 janitor 武装改成**进程级单例** `ensureLifecycle()`，插件 disposer 只停心跳、不再摘钩子/ disarm（`dsh` 的 Ctrl+C 是 dispose 后再 `process.exit`，旧 cleanup 把两道兜底都拆了 ⇒ 引擎被留成孤儿）；挂载时 `adoptLeftoverEngine()` 认领上一条命留下的引擎并在代理面板显示「本会话已接管」横幅；心跳写失败只 warn 一次（20s 后看门狗会拆桥接）；`/debugs`、`/opens` 补 loopback 校验。测试：`test/lifecycle.test.mjs`、`test/inherit-engine.test.mjs`。
- **Phase 1a（只读 daemon）**：`bin/risd.mjs` + `lib/risd/{state,log,leases,view,server}.js` + `lib/risd-client.js`。`risd.json`（0600，token 32B hex）+ 端口 11082 + `x-risd-api-version` 握手 + Bearer token；端点 `GET /v1/health`（免认证）、`/v1/status`、`/v1/proxy`、`/v1/leases`（3s `pidAlive` 探活）、`/v1/config`、`/v1/shutdown`；单实例选举靠 bind+health 探测（退出码 0/3/4），绝无按 pid 杀。插件 `daemonMode`（`auto|off`，默认 **off**）+ `startRisdBridge`/`risdForwardedView`，只在 GET 视图上转发，不可达回退本地。
- **Phase 1b（daemon 接管引擎）**：所有权二元（`engineCwd` 非空才算 owned，启动时发现 pidfile 只报 owned:false）；引擎 API `GET/POST /v1/engine`；租约驱动拆除（最后一条租约释放 → 300ms 防抖 → git → 桥接 → 引擎，5s 有界）；空租约 10 分钟 `idleExitMs` 退出；写入口 `POST /v1/proxy`（CAS，`risdConfigRevision` sha1 前 12，冲突 409 带当前 revision）、`POST /v1/action`、`GET /v1/injection`；`lib/risd/git.js` 复刻「显式 host→表内 git 规则→上次记录→origin」优先级并按自己记录的 value 清理（E7 不误删别人的 git 配置）；`serializeBridge()` 串行化桥接 reload/stop（E8）；**升级 handoff**：`risd stop --handoff` 把引擎写进 `risd.json` 交给继任者收养，janitor 增加 12s 交接宽限（`markJanitorHandoff` + `bin/proxy-janitor.mjs` 的 `adoptSuccessor`），否则前任看门狗会在 3s 内把引擎当孤儿拆掉。E2/E3 顺带修：引擎 shutdown 关闭 shadow 监听、`ready (N listeners)` 不再恒 1。
- **UI**：代理面板从内嵌模态改为**独立浏览器页签**（`window.open(url.href, name)`，同名复用/前置；`mountStandalone` 的 `view=proxy` 只渲染全屏 `ProxyDialog`），控制台 🌐 按运行状态着色（运行中蓝 `#2f7cf6`、未启动灰 `#9aa3ad`，4s 共享轮询 `/dsh-ris-ide/proxy`）；独立 IDE 窗口也去掉 popup features，改普通浏览器窗口（不再 `moveTo/resizeTo`）。
- **保存即换新，不留旧应用**（用户口径：「自动保存实时应用之前，要先将旧配置应用清理再换成新配置，防止旧代理无法取消」）：保存 `proxy.json` 之后、新规则生效之前，先把上一份表应用过的机器级副作用收回——① `git config --global` 的 scoped 条目按新表重新对齐（`reconcileGitProxy`：还有 git 规则就切过去，切 host 先 unset 旧 key；没有 git 规则就清掉我们写过的条目；E7 归属校验保证不动别人的值）；② ProxyBridge 重载失败（看门狗重启失败/本侧 root 进程无法热重载）时不再「报未重载了事」，而是**主动停止系统层拦截**并在 `reloadNote` 里说明，避免旧规则继续拦截而用户无法取消。daemon（`POST /v1/proxy`）与插件（`serveProxy` POST）两条保存路径都走同一顺序；新增 `test/risd-git.test.mjs`(4) 与 `test/risd-write.test.mjs` 的「a save re-points the scoped git entry」用例。
- **提权重启桥接**（用户口径：「按钮应该是提权…若权限不够时提示需要提权」）：面板在「旧规则可能仍在生效 / 需要提权」提示旁渲染 `data-proxy-restart-bridge` 按钮，动作 `redirector-restart` = `stopRedirector()` → 300ms → `startRedirectors()`；daemon `/v1/action` 与插件 `serveProxyAction` 同义（插件 `daemonActions` 已含该动作）。结果透传 `started/skipped/stopped.reason/command`，客户端转成「需要提权：<reason>（<sudo 命令>）」；该动作在 `NODE_TEST_CONTEXT` 下不会真的提权。测试 `test/proxy-restart.test.mjs`(3) 守两端动作与按钮文案（2026-11-11 该文件已并入 `test/proxy-route.test.mjs` 的 `the bridge restart action is wired on the card, in the daemon and in the plugin`，见 §2.40）。
- **顺带修**：前端程序的 `logName` 改用模块名（`kind==='frontend' ? program.name : '<project>-<name>'`）且 yds 注入的旧配置会被 `repairFrontendNames` 纠正并全局去重（`renamedLogs`），前端与后端 logName 不再撞同一份日志。
- 测试：ris-ide 全量 **531/531**（基线 481；新增 risd election/api/lease/client/engine/teardown/write/handoff/mode、lifecycle、inherit、host-noloop、proxy-window 等）。全量并发会互抢真套接字，建议 `node --test --test-concurrency=4 "test/*.test.mjs"`（默认并发下 `test/proxy.test.mjs` 偶发挂住，单跑 27/27）。
- 生效方式：宿主 `lib/*.js` 改动 ⇒ 重启 `dsh web`；纯客户端（`lib/client.js`、`window.html`）硬刷新即生效；`daemonMode` 默认 auto（1.8.0 起）；`daemonMode=off` 或 `DSH_RISD_MODE=off` 是回滚开关。

### 历史里程碑（一句话/版本）

| 版本 | 一句话 |
|---|---|
| 0.3.x | 雏形：工作区程序扫描与启动（0.3.2）→ 配置生成/漂移/更新（0.3.3）→ 模型侧 `ris_dev_*` 命令（0.3.4） |
| 1.0.0 | IDE 里程碑：侧栏一个 tab 内完成控制台 + 目录树 + 源码 + 断点调试 + 实时日志（四区可拖动布局） |
| 1.1.x | 源码区换内嵌 CodeMirror（高亮/编辑/保存/脏标记/页签上限），断点栏移到编辑器左侧，字号与配色可调 |
| 1.2.x | 目录树按 `.gitignore` 过滤、包名折叠、复制粘贴与拖拽；文件名检索走 `git ls-files`；文件内 `Ctrl+F` 支持替换 |
| 1.3.x | 性能与快捷键：大目录树按需加载、日志轮询降频、常用动作补键盘入口 |
| 1.4.x | 改成**一条共享 SSE**（修「开久了页面卡死」：多窗格各自轮询把宿主拖住） |
| 1.5.x | fresh 工作区/重命名/复制文件等文件树写动作补全 |
| 1.6.0–1.6.9 | 日志只看本次启动、标题栏图标化、调试多页签、页签滚轮横向滚动；依赖 jar 源码（反编译）与缓存指纹失效 |
| 1.6.10–1.6.12 | 交互修复批次：点选区/搜索命中进不了编辑、滚动条常驻、树 `Ctrl+C`/`Ctrl+A`、拖到文件=移到其目录、启动后日志定格、`Ctrl+Shift+R`、检索下拉键盘、换行开关；文件树多选批量操作；配置按钮进控制台标题栏 |
| 1.6.13 | 配置入口补全（侧栏 📄 用官方 sidebar 打开资源）、帮助面板可信化、删除确认焦点与 toast 撤销 |
| 1.7.2 | 编辑器 Ctrl+F 聚焦（面板已开/焦点在外都进查找框、拦浏览器查找）、定位到当前文件展开全部上级并滚动（修 React updater 读循环变量与换根两处失效）、树高亮只跟编辑器当前文件、检索下拉框压过查找面板、检索改流式分页（并行 root、按 root 顺序、首屏先出）、大文件保存超 512 KB 自动分片（8 MB 单请求上限 + 同目录暂存后原子 rename）、文件树拖动放入前先确认 |
| 1.7.3 | 技能 `dsh-ris-ide-debug` 增「自定义 `startCommand`/变量约束」（唯一占位符 `${JDWP_ARGS}`、custom 绕过 `jvmArgs`、cmdline 自检）与「低内存/多开预算」（1 GiB 护栏、默认堆=内存/4 的坑、三档参数、4 服务 PSS 2.33 GiB、8 GiB 容量口径、OOM 处理） |
| 1.7.3 | 独立窗口跟随当前会话工作区（header ⧉ 按钮用 slot 标准 props `useSessions` 读会话 `cwd`，不再回退 origin 级的 `dsh-ris-ide:last-cwd`，单窗口名同步）；侧栏「打开配置」不再报 `shortName is not defined`（组件内 helper 统一到模块级 `fileBaseName`） |
| 1.8.3 | 生命周期改为「跟随 dsh 启动 / 跟随 dsh 停止」两个半边（程序行的启动半边＝恢复上次 daemon 退出时仍在跑的程序，快照 `risd-programs-last.json`）；SOCKS 校验从「握手」升级为「真的转发一次」（CONNECT + rep 码）；git 不可用不再是一次失败就终身拉黑（60 s 隔离 + 复核）；程序行新增 🌐（在系统浏览器打开页面，经 dsh-ris-yds 注入代理自动带 YYCToken）；`sudo -n true` 探测结果缓存 5 分钟（少每分钟一条 sudo 审计） |
| 1.8.2 | 开发环境工作区面板同步 dsh 标题（path 作身份、改名即时生效、镜像侧栏完整列表）；代理引擎「跟随 dsh」补齐启动半边（挂在**租约**这条既有信号上，永不弹提权）；保存规则不再自动启动引擎；组件区单按钮「启动/重启系统层拦截（可能提权）」 |
| 1.8.1 | ProxyBridge 健康检查 + 引擎⇔组件一致性 + 提权启动（sudo → pkexec → 终端）+ 组件单行健康状态/折叠说明 + 开发环境页签·最近历史·检索缓存按工作区分区 |
| 1.8.0 | risd 代理 daemon（Phase 0.5 止血 + 1a 只读 + 1b 引擎/规则/git/桥接所有权 + handoff）；代理面板独立页签与 🌐 状态色；独立窗口改普通浏览器窗口；前端 logName 去撞名 |

### 仍然约束今天的坑（从历史条目提炼，别再踩）

- **一条共享 SSE**：订阅签名只由 topics/session/cwd/tail 决定，新窗格挂载不得强制重连；**分发帧必须按订阅路径过滤**（`risFrameWanted`：`topics` 含 `tail`、且订阅 path 与宿主实际 tail 一致），否则日志永远停在 mount 时的快照——「只有启动命令、最大化才出后续内容」就是这么来的。
- **`.cm-selectionLayer` 抬高 z-index 必须同时 `pointer-events:none`**：它盖在 `.cm-content` 上方，否则点高亮选区/搜索命中点不进编辑（要点两次）。
- **`.gitignore` 的 CRLF 尾部空行**会让 `git check-ignore` 返回空 pattern，把带 `/` 的目录整片误判为 ignored（解析时必须跳过空 pattern）。
- **响应流里禁止二次 `res.writeHead`**：浏览器取消请求会触发 `ERR_HTTP_HEADERS_SENT` 打崩宿主。
- **独立窗口单例锁按「工作空间」而非当前目录**，否则从程序目录进调试会开第二个窗口；窗口导航期的锁竞态要处理（复用的窗口不能一闪就关）。
- **编辑器 handle 要由组件 mount 后回注册**（`onToolbarControls`）：外层 `controls.searchFor` 此前没有任何注册点，静默无效。
- **CodeMirror search API**：`getSearchQuery(view.state)` 收的是 `EditorState`；`setSearchQuery` 是 `StateEffect` 要 `dispatch`；自绘面板用 `createPanel(view)` 接管后再读 `view.state`。
- **大文件预览组件必须定义在模块作用域**：定义在父组件函数体内会让父组件每次渲染都得到新的组件类型 → 整棵重挂载 → 滚动条回顶。
- **弹窗锚定鼠标**：靠 `pointerRef`（window `pointerdown` 记录），不用居中遮罩。
- **测试约定**：快捷键优先级、菜单结构这类不好渲染断言的东西用「源码文本守卫」钉住，改相关代码必须同步改断言。

### 2.11 Phase 2-lite P1：daemon 管程序清单与启停

- 归属：daemon 侧 `lib/risd/programs.js`；清单复用插件的同一条流水（`scanPrograms` /
  `programsFromConfigEntries` / `decoratePrograms`），所以 id、`logName`、日志路径、pidfile
  存活判定与面板完全一致——同一个程序在哪个 dsh 里看都是同一行。
- 端点（需 token + `x-risd-api-version`）：
  - `GET /v1/programs?cwd=&dir=&refresh=1` → `{ok,cwd,dir,programs}`（`dir` 默认 `<cwd>/logs`，
    fast path：配置文件仍匹配文件系统则不重扫）。
  - `POST /v1/programs {cwd,action:'start'|'stop'|'restart',id}` → `{ok,action,pid?,stopped?}`；
    已运行再 start 是幂等成功（面板同口径）；stop 只对 pidfile 记录的 `run-with-log.sh` wrapper 发信号。
  - `GET /v1/programs/log?id=&cwd=&dir=&offset=&bytes=` → `{ok,path,size,offset,nextOffset,text,running}`；
    带 `offset` 只返回新增字节（供 P2 的跟随/断线重放），不带则取尾部窗口。
- 并发：daemon 内 `programOp` 队列串行化 start/stop/restart，防连点把同一行拉起两次。
- 客户端封装：`lib/risd-client.js` 的 `listPrograms` / `programAction` / `readProgramLog`。
- 测试：`test/risd-programs.test.mjs`（4 条，临时 workspace + 自定义 `programs[]` 行）。

#### 日志跟随（P2）

- `GET /v1/programs/log/stream?id=&cwd=&dir=&offset=&bytes=` 返回 `text/event-stream`：
  `event: log`（新字节，`{path,size,offset,nextOffset,text,running}`）、`event: reset`（文件被截断/轮转，
  `offset` 从 0 重读）、`event: state`（程序启停）、`event: end`（`stopped`，排水 2.5s 后关流）。
- 心跳：`event: ping` 不发送，改为 SSE 注释 `: ping`（15s），断线重连由客户端带上
  `offset=<上次 nextOffset>` 续传，不重放旧字节。
- 实现：`startLogFollow`（400ms stat + 每帧 ≤64KB），不重扫工作区；存活判定只看
  `<log>.pid` + `kill(0)`，所以跟随成本与项目大小无关。

### 2.12 启动对账：把「与当前配置/状态不符」的残留清掉

重启电脑、`kill -9`、WSL 关机都不会跑任何 teardown，但两类**机器级副作用**留在磁盘上：
`git config --global http.https://<host>/.proxy`（指向已死的 `socks5h://…`）和
Windows `ProxyBridgeSvc` 被我们 park 成 Manual。下一次启动由 `lib/startup.js` 的
`reconcileStartupLeftovers()` 对账（插件 `daemonMode=off` 时在 apply 里跑；`auto` 时由 daemon
启动后跑，避免两个 owner 同时动）：

| 发现 | 判定 | 动作 |
|---|---|---|
| 有 `git-proxy.json`，引擎未运行 | 死隧道 | 只删自己写的那条（E7：记录值/`socks5h://` 才算我们），清 state |
| 引擎在跑但规则表已无 git 规则 | 配置不符 | 同上清掉 |
| git 规则换 host | 配置不符 | 改指当前 host（先 unset 旧 key） |
| 别人的值 | 不归我们 | 只清 state，保留值并在日志说明 |
| `proxybridge-service.json` 且桥接未运行 | 上次停放未恢复 | `restoreWindowsService()`（还原启动类型 + 尝试启动），失败只提示 |
| `proxy.pid` 但引擎未运行 | 幻影 owner | 删除 pidfile（`proxyPid()` 已先删则只补日志） |
| `risd.json` 但 `/v1/health` 不应答 | daemon 已死 | 删 state（否则插件会一直 502） |
| `proxybridge-reload.failed` 且桥接未运行 | 过期失败标记 | 删除（面板不再警告） |

日志统一前缀 `[dsh-ris-ide] 启动对账：…`；测试 `test/startup-reconcile.test.mjs`（6 条）。


  **宿主侧按需唤起**：`POST /dsh-ris-ide/risd/ensure`（仅回环）调 `ensureRisd({home: proxyHomeDir()})`，返回
  `{ok, spawned, risd:{available,url,port,apiVersion}}`；客户端 `openRisdPage` 先读 `/proxy` 视图里的 `risd`，
  不可用时 POST 这个路由再打开 `url/ui?cwd=…`，所以 daemon 停掉/崩掉后点 ⧉ 仍是「一键回到维护页并选中这个工作区」，
  而不是退化成旧独立窗口。

### 2.21 2026-11-09 傍晚 m09396 四项（组件卡片 / 双镜像 / 剪贴板 / 树 hover）

- **ProxyBridge 卡片只在需要时说话**：`已安装` 只渲染「已安装 · 文件 8 个 · 目录」，下载地址与「下载组件」「选择 tgz 上传」按钮全部 `hidden`；未安装/下载中/失败才出现地址（Gitee、GitHub 各一行）与按钮，失败原因单独一行。
- **双镜像下载**：`lib/proxybridge-bundle.js` 用 `BUNDLE_URLS`（Gitee 优先、GitHub 备）替代单地址 `DEFAULT_BUNDLE_URL`，新增 `resolveBundleUrls()`；`ensureBundle()` 顺序重试并返回 `{urls, tried}`，失败时 `error` 是多行汇总。daemon `GET /v1/proxybridge` 同时返回 `urls` 与 `url`（第一个）；`POST /v1/proxybridge/download` 不再固定单地址。`lib/redirector.js` 的 `ensureBundleReady()` 只在用户显式配置地址时才单发。
- **剪贴板被权限策略拦掉**（用户报 `writeText` 被 permissions policy 拦）：`/ui` 响应加 `permissions-policy: clipboard-write=*, clipboard-read=*`（IDE 页签是 `/ui` 里嵌的 dsh 页面，父文档不声明则子页 `navigator.clipboard.writeText` 直接被拒）；`lib/client.js` 的 `copyText(text)` 从「发出不等待、总是 return true」改为返回 `Promise<boolean>`：rejection 不再逃逸成宿主「后台任务出错」，而是回退 `textarea + document.execCommand('copy')`（只需点击的用户激活）。调用点（复制文件名/复制文件路径）改 `.then(ok => notify(...))`。
- **文件树 hover 下划线**（用户口径：文件和目录 hover 加下划线，不要弹跳）：树行 label span 加 `data-tree-label="1"`，注入 CSS `[data-tree-path]:hover [data-tree-label]{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}`。`text-decoration` 不改行盒尺寸 ⇒ 行高/兄弟行不位移；只作用于名字，不碰 ▸ 与行 padding；拖拽悬停行（`data-tree-drop="1"`）不画下划线。
- **测试**：`test/proxybridge-bundle.test.mjs` 15 例（新增「Gitee 502 → GitHub 成功、tried 记一条」与 `resolveBundleUrls` 顺序）；`test/risd-api.test.mjs` 状态断言改为 `urls[0]/urls[1]`。

### 2.20 2026-11-09 下午 m09120 三项（⧉ loading / SOCKS 状态 / ProxyBridge 下载化）

- **⧉ 点击慢 → 预热 + loading（`lib/client.js`）**：`RISD_PREFETCH_TTL_MS = 20000` 的模块级预热缓存（`risdPrefetch`），在会话头 mount / `onPointerEnter` / `onFocus` 时 `warmRisdAddress()` 拉一次地址；`openRisdPage` 命中缓存时**在第一个 `await` 之前同步** `window.open`（弹窗留在用户手势同一任务里，比原来更稳），冷路径仍是 prefetch → `POST /risd/ensure` → 打开。`risdOpenPending` 让双击只开一个 tab；三处 ⧉（会话头 / 面板 / 控制台）都加 `aria-busy`、`disabled`、`…` + 「打开中」。TTL 的代价：daemon 在 20 s 内换端口会指向旧地址（页面会显示 daemon 不可用）。
- **代理页 SOCKS 状态标签（`lib/risd/ping.js` + `/v1/proxy/ping`）**：TCP 连上后发 SOCKS5 greeting `05 01 00`，据应答分三态——`05 00` 连通（显示 `连通 xx ms`）、`05 非0` 需认证（`socks:true` + 琥珀色）、非 SOCKS5 或连不上（红色，title 带原因）。`/v1/proxy/ping` 默认读 `proxy.json` 的 socks，`host`/`port` query 可覆盖（页面测未保存的编辑值，800 ms 防抖）。前端只在「代理页签 + 页面可见」时 10 s 轮询（切走 clearInterval），`pingSeq` 防旧响应覆盖新值。测试 `test/risd-ping.test.mjs`（5 例 fake SOCKS）+ `test/risd-api.test.mjs` 一条路由用例。
- **ProxyBridge 改为下载/上传 + 缓存（不再内置 2.9 MB 二进制）**：
  - 新 `lib/proxybridge-bundle.js`（零依赖）：8 文件清单 `bundleLayout()`；下载 `downloadAndInstall()`（60 s 超时、follow redirect、内置 ustar 解析、只取清单内文件、拒绝绝对路径/`..`/符号链接、`dir.tmp-<pid>` 完整后 rename、tgz ≤16 MB / 解压 ≤64 MB）；`installFromTgz()` 走同一校验（手动上传）；`isInstalled()` 要求 8 文件齐全且 size 与 manifest 一致；`ensureBundle()` 缓存命中不再 fetch、失败不抛而是 `{ok:false,error,url,hint}`。
  - 安装位置 `<proxy home>/proxybridge/bundle/`（`~/.dsh-ris-ide/proxybridge/bundle`，`DSH_RIS_IDE_PROXY_HOME` 可改）；URL 优先级 env `DSH_RIS_IDE_PROXYBRIDGE_URL` → `settings.json` 的 `proxybridgeUrl` → 内置镜像对 `BUNDLE_URLS`（Gitee 优先 `gitee.com/riscloud/dsh-ris-ide/releases/download/1.8.0/ris-proxy.4.0.tgz`，GitHub 备用 `github.com/ris-cloud/dsh-ris-ide/releases/download/1.8.0/ris-proxy.4.0.tgz`，同一份附件）；**下载路径固定指向 `1.8.0` release 的 `ris-proxy.4.0.tgz`，不随插件版本号变化**（用户 2026-11-10 定；换包就覆盖同一附件并同步 `BUNDLE_SHA256`）；只允许 https，http 仅回环；`ensureBundle()` 逐地址重试并在失败时汇总原因。
  - `lib/redirector.js`：`bundledBundleDir()` 改指缓存目录；`ensureBundleReady()`（永不抛）；未安装时 `findRedirector()` / `startRedirector` / `redirectorStatus()` 带 `missingBundle:true` + `reason`（含「维护页 → 代理 → 组件」入口与下载地址），不再静默回退到不存在的路径。**WSL 仍经 `/mnt/c` 把 Windows 侧材料装进 `%LOCALAPPDATA%`**（否则要靠 `\\wsl.localhost` 启动 exe 与 WinDivert `.sys`，风险更高）；旧 `~/.dsh-ris-ide/proxybridge/vendor` 保留为回退候选。
  - daemon 端点：`GET /v1/proxybridge`（installed/dir/url/files/downloading/result）、`POST /v1/proxybridge/download`（后台下载，页面 1 s 轮询）、`POST /v1/proxybridge/upload`（raw octet-stream，≤16 MB；坏包 400 带原因）。维护页「代理 → 组件」卡片显示状态、下载按钮、上传选择与下载地址（失败时给出原因与手动上传提示）。
  - **发布 `ris-proxy.4.0.tgz`**：内容是 8 个文件（`LICENSE-ProxyBridge.txt`、`NOTICE.md`、`linux/{ProxyBridge,libproxybridge.so}`、`windows/{ProxyBridgeCore.dll,ProxyBridge_CLI.exe,WinDivert.dll,WinDivert64.sys}`），路径保持 `linux/…`、`windows/…`；`tar -czf ris-proxy.4.0.tgz -C <目录> LICENSE-ProxyBridge.txt NOTICE.md linux windows`。托管到任意 HTTPS 地址后设 `DSH_RIS_IDE_PROXYBRIDGE_URL` 或 `settings.json.proxybridgeUrl`。
- **测试**：`test/proxybridge-bundle.test.mjs` 14 例、`test/redirector-bundle.test.mjs` 13 例、`test/redirector.test.mjs` 28 例、`test/risd-ping.test.mjs` 5 例、`test/risd-api.test.mjs` 10 例、`test/client-viewer.test.mjs` 244 例；全量 **688/688 pass**。

### 2.19 2026-11-09 09:00 后代码的评审修复（2 P0 / 8 P1）

评审范围：ris-ide `e5bbc0e..7af9895`（8 笔）+ yds `8b36452..7788989`（2 笔），报告在 `work/reviews/20261109-0900/`。本节只记**行为变化**与**为什么**；逐条行号见报告。

- **P0 off 模式 ⧉ 抢 owner（C2-P0-1）**：`serveRisdEnsure` 在 `daemonMode !== 'auto'` 时不再拉起 daemon，返回 200 `{ok:false, risd:{available:false, reason:'daemonMode=off：IDE 请用独立窗口…'}}`；客户端 `openRisdPage` 回退独立窗口。原因：daemon 启动会无条件写心跳 + `armJanitor({ownerPid})`，而 janitor 遇到不同 owner 会先 disarm 旧 watcher ⇒ off 模式插件自己的崩溃清理被摘掉；反过来 daemon 崩溃会拆掉插件仍在用的引擎。**这是行为回退到 C-P1-2 之前的口径**（README 同步）。
- **P0 yds stop 失去 per-workspace 减法（D-P0-1，yds 仓 `b8ff222`）**：`lib/rules.js` 引入 `owners` map，每 workspace 一条贡献，顶层 hosts/ports/enabled/shadow/direct 由 owners 重算；`ydsRowsOf/withdrawYdsWorkspace` 按归属减。**两侧契约**：daemon 不解释 `owners`，但 `lib/proxy.js` 的 `normalizeConfig` 必须透传（`normalizeOwners`），否则面板保存一次就丢归属。
- **P1 daemon 空闲退出两条路径统一**：启动时 `engineCwd === null && leases.count() === 0` 就 arm `scheduleIdleExit()`（观察者 daemon 也会退出）；timer 回调加 `engineCwd === null` 守卫，有引擎时只重排不 stop（避免拆掉正在用的引擎）；`POST /v1/config` 的定时器在内存里就地改 lifecycle，不再「到点无条件 teardown」。
- **P1 sessionId 不继承**：`noteDshWindow` 的 `sessionId === ''` 直接返回（以前会沿用上一条的 id），`/v1/dsh` 因此不会把 A 会话的 sessionId 安到 B 工作区上；`refreshDshWindows` 只维护 `ownerPid === process.pid` 的行（同 home 两个 dsh 实例互删问题），且 `session.header.cwd !== row.cwd` 视为失效。
- **P1 Windows startCommand 方言**：`lib/index.js` 新增 `isBashDialectCommand`（`exec`/`export`/`$(…)`/反引号/`${…}`/`$VAR`）与 `resolveWindowsRuntime({bashDialect})`：`runtime=auto` 且命令是 bash 方言时回落 Git Bash，找不到就 400 提示怎么改；`startProgram` 先剥 `${JDWP_ARGS}` 再判。ps1 侧另有兜底（`bin/run-with-log.ps1` 命中方言直接失败并提示）。
- **P1 进程活性三态（yds `b8ff222`）**：`probePid` 返回 alive/dead/unknown（EPERM 与 PowerShell 探测失败都算 unknown），只有 dead/foreign 才删 pidfile；`stopPid` 返回 taskkill 退出码，kill 失败保留 pidfile 并上报，不再假装 `stopped:true`。
- **P2 摘录**：`/v1/dsh` 的未来/非有限时间戳不再永久 live；`replaceRulesFrom` 只接受 `source:'yds'`（否则 400）；reload 的 `sides` 按平台给；`dsh-window.json` 全量改成 `writeStateAtomic`；`lifecycle` 的 POST 改为「合并 + 拒绝 null/数组 + 未知键报错」，GET 返回 `lifecycleErrors`；`window.html` 删死参数 `view`；`/ui` 的重复 CSS、`dshWindowSignature` 加 `live`、清除调试记录加确认；`#ide-stale` 关闭状态、`aria-expanded`、初始 `›`。
- **测试**：ris-ide 全量 **660 例 / 659 pass**；yds **149/149**。唯一失败 `test/risd-election.test.mjs` 的 shutdown 用例在 `git stash` 掉全部改动后**同样失败**（另有一例 parked ProxyBridgeSvc），属本机负载 flake，与本轮修复无关。
- **未修（需要用户决策）**：ris-ide 1.8.0 是否发版；yds 1.1.0 首发包名（`dsh-ris-yds` vs scoped）。

### 2.18 2026-11-09 维护页工作区列表与默认收起（m08228 / m08268）

- **为什么列表会「收敛成一个」**：`/v1/dsh` 原先按 `ageMs <= 30s` 硬过滤，而 `dsh-window.json` 只在插件收到请求时写、没有周期刷新 ⇒ 空闲工作区 30 秒就老化消失（不是 URL 参数问题）。
- **daemon**：`lib/risd/server.js` 的 `/v1/dsh` 改为两级：
  - `DSH_WINDOW_LIVE_MS = 5 分钟`：每条窗口返回 `live` 布尔（前端据此标「未活跃」）；
  - `DSH_WINDOW_RETAIN_MS = 7 天`：超期条目才从列表剔除；
  - `available` = 还有记住的窗口；`url/sessionId/cwd` 取排序后第一项（live 优先、再按最近活跃）。
- **插件**：`lib/index.js` 新增 `refreshDshWindows(ctx)`（`__test` 也导出），每 `DSH_WINDOW_REFRESH_MS = 10 秒` 跑一次：对每条 `sessionId` 用 `ctx.sessions.get(id)` 判断 dsh 是否还认识该会话，认识就刷新 `at`（不改变 sessionId/cwd），有变化才写盘。定时器在 `daemonMode` 两种模式下都装（`apply` 的 effect 里，dispose 时清掉），因为它是页面列表的唯一写入方；daemon 没有 host 上下文，无法回答「这个会话还在吗」。
- **页面（`lib/risd/ui.js`）**：`sideVisible()` 改为 `localStorage === 'on'`（**默认收起**）；下拉 label 对 `live === false` 追加「（未活跃）」；选中未活跃项时 `#ide-stale` 黄条提示「该工作区最近没有活动…IDE 仍会尝试加载」；`loadIde` 选择顺序 = 上次 `state.cwd` → 第一个 live → 第一项。
- **未活跃提示条**（`#ide-stale`）：选中 `live:false` 的工作区时显示「该工作区最近没有活动…」，右侧 `×` 可关闭；关闭状态按 cwd 记在页面 `state.staleDismissed`（切到其它未活跃工作区仍会提示，切回时保持关闭），该工作区重新变成 live 时自动清掉。
- **测试期不写真实 home**：`noteDshWindow` 在 `NODE_TEST_CONTEXT` 且未设 `DSH_RIS_IDE_WINDOW_NOTE=1` 时直接返回——否则测试用的 `/tmp` 假工作区会把条目写进开发机 `~/.dsh-ris-ide/dsh-window.json`，维护页把它们当工作区列出来（m08500 的根因之一，`test/dsh-origin.test.mjs` 显式 opt-in）。
- **测试**：`test/risd-ui.test.mjs`（/v1/dsh 保留未活跃条目并带 live、默认收起、未活跃 label、提示条可关闭 + `staleDismissed`）、`test/dsh-window-refresh.test.mjs`（4 条：刷新 dsh 还认识的会话、**删除 dsh 已丢的会话条目**、无 sessionId 的条目保留、缺文件 no-op）。

### 2.17 2026-11-09 risd-ui 唯一入口 + D3/D4 收口

- **IDE 入口只走 risd-ui**（m07355）：`daemonMode` 默认 `auto`（`daemonMode=off` / `DSH_RISD_MODE=off` 一词回滚）；即使 off，显式点 ⧉ 也会经 `POST /dsh-ris-ide/risd/ensure` 拉起 daemon 并打开 `<daemon>/ui?cwd=…`（页签保留用户上次的选择，m11345），只记一条警告。测试进程（`NODE_TEST_CONTEXT`）默认仍是 off，插件套件不会起真 daemon。
- **旧代理面板已删除**（D4）：`lib/client.js` 的 `ProxyDialog` 组件、`view=proxy` 独立窗口分支及其导出全部移除；代理规则只在 risd 维护页的「代理」页签编辑（machine-level，不依赖 dsh）。
- **D3 三项**：①`proxy.followDaemon=false` 曾用 `bin/heartbeat-keeper.mjs` 续心跳；**m07741 起「跟随 daemon」强制为真，keeper 已删除**（不会再出现 daemon 退出后代理还活着的状态；想留引擎就让 daemon 继续跑，见 §2.15）；②`window.html` 在 iframe 内不再渲染「关闭这个窗口」（`window.close()` 会被拒）；③维护页概览列出「已断开」调试记录（`sessions.stale`）并可「清除记录」（`POST /v1/debug {action:'forget'}` 同时清断点集合）。
- **控制台不再自动选中日志**（m07431）：删掉「首个运行中程序自动 activePath」的 effect；未点行时日志面保持占位，不加载/定位文件。

### 2.16 2026-11-09 专家评审修复（Batch 1–3）

评审报告在 `work/reviews/20261109-risd/`（A daemon 核心 / B daemon 子系统 / C 宿主·页面·客户端 / D yds），
汇总与批次划分见 `00-汇总.md`。三个批次共修 **6 P0 + 22 P1 + 51 P2**，每条带回归测试：

- **Batch 1（6 P0，提交 `4cecc67`）**：`risd serve` 无 `--home` 把字符串 `undefined` 写进环境（状态落到 `<cwd>/undefined`）；拆除超时仍无条件 `disarmJanitor`（兜底被杀）；停止代理/换 host 时 `git --unset` 误删用户自己的值（E7 归属校验）；维护页切回 IDE 重建 iframe（丢未保存编辑）；一次转发失败永久降级本地 owner（双写 + 租约泄漏）；yds 撤规则从不生效（缺 `replaceRulesFrom`）。
- **Batch 2（P1，提交 `dfa51f2`）**：`engineOp` 异常毒化队列；stop 不 drain 在途启动；`absoluteCwd` 拒绝 Windows 盘符；`/v1/*` 缺 Host/Origin 校验；启动对账可能删自己的 `risd.json`；debug `owners` 永不释放；JDWP attach 失败留下冻结 JVM；janitor 继任收养读错字段（`owner` vs `ownerPid`）导致误杀；heal 不补租约；off 模式 ⧉ 仍拉起常驻 daemon；restart 结果读错层级；409 提示被重载清空；空 cwd 顶替别的 workspace；off→auto 热切换残留 legacy exit 钩子；yds 停止文案与 daemon 拆除策略矛盾、租约登记晚于引擎启动。
- **Batch 3（51 P2 + 测试缺口）**：daemon 413 先断链、409 缺 view、`/v1/config` 谎报 `engineRestart`、`/v1/dsh` 未校验 url、单实例不校验 home、`risd stop` 等文件不等 pid、`risd-client.openProgramLogStream` 的 `ReferenceError`、spawn 早退不报原因、日志不建目录、`view.redirector.managedBy` 陈旧、git-on/off 绕过记账、拆除 timer 与 stop 双拆、handoff 不写最后一拍心跳、`/ui` 缺 frame/CSP 防护、inherited 引擎不上报、程序 offset 越界/慢轮询/等长轮转/包装 pid 判活、同名程序 409、debug 会话记录与剪枝、redirector 旧 stop 标记、janitor 状态原子写与 cmdline 校验、yds 租约锁/原子写/`--keep-socks`/revision 缺失拒绝等。

**仍属已知边界（有意不修，已在本节与评审报告中记录）**：
- `POST /v1/proxy` 不带 `revision` 仍是「强制写入」逃生口（面板与 yds 永远带 revision）。
- （2026-11-09 后续）`proxy.followDaemon` 与「iframe 内关闭按钮」「stale 会话不展示」三项已分别由 m07741 与 D3 处理，不再属于边界。

### 2.15 生命周期设置（每个资源两个半边：跟随 dsh 启动 / 跟随 dsh 停止）

维护页「概览 → 生命周期」给四类资源各配**两个开关**（m03397）：`startWithDsh`（dsh 接入时启动/恢复）与
`stopWithDsh`（最后一个 dsh 租约消失时停止）。两半分开是因为它们回答两个不同的问题——「我开 IDE 时把我
的程序拉起来」与「我关 IDE 时别把它们杀掉」。**跟随 daemon 是强制的**（m07741）：停止 daemon 时它托管的
程序、调试会话、代理（含系统层拦截）一定一起停——否则会出现「资源还活着、页面已经没了」的无人可停状态；
提示语不在页面上重复，`followDaemon` 键仍返回 400。

配置存在 `<home>/risd-lifecycle.json`（0600，`lib/risd/lifecycle.js`）：

| 资源 | 键 | 默认 | 语义 |
|---|---|---|---|
| 守护进程 | `daemon.startWithDsh` | `true`（**强制**） | 页面灰显不可改：dsh 需要时按需拉起 daemon |
| 守护进程 | `daemon.stopWithDsh` | `true` | 最后一个租约消失后空闲 10 分钟退出；关掉 = 一直运行到手动停止（`scheduleIdleExit` 直接 return） |
| 代理引擎 | `proxy.startWithDsh` | `true` | 第一份租约到达时启动引擎（非交互，永不弹提权，需要 root 的桥接只在组件卡里提示） |
| 代理引擎 | `proxy.stopWithDsh` | `true` | 无租约时拆隧道（git → 桥接 → 引擎）；关掉 = 拆除留给 daemon 收尾 |
| 程序 | `programs.startWithDsh` | `false` | 第一份租约到达时**恢复上次 daemon 退出时仍在运行的程序**（快照 `<home>/risd-programs-last.json`） |
| 程序 | `programs.stopWithDsh` | `false` | 最后一个租约释放后停掉 daemon 托管的所有程序（默认关：没有 dsh 时维护页也能留 JVM） |
| 调试 | `debug.stopWithDsh` | `false` | 最后一个租约释放后 `debug.stopAll()`；**没有 `startWithDsh`**（调试会话属于某个页面，没有可自动启动的对象），页面启动列灰显并给 title |

- 读取：`readLifecycle(home)`（缺失/坏文件回默认，不让坏配置挡住 daemon）；写入：`writeLifecycle(home, input)`
  （`normalizeLifecycle` 只认每个资源实际存在的半边，非布尔/未知键给 `errors`；`daemon.startWithDsh=false` 与
  `debug.startWithDsh` 各有自己的报错文案；旧的 `followDaemon` 键返回 400「不再支持…」），原子 tmp+rename。
- **迁移**：旧文件的 `followDsh`（一个资源一个开关，两半共用）读入时迁移成两半（true→两半 true；`debug` 只有
  stop 半边），同一 payload 里显式给出的半边优先——调用方可以只搬动一半。下一次保存写回新结构。
- 端点：`GET /v1/config` 返回 `lifecycle`；`POST /v1/config {lifecycle}` 校验后落盘并更新内存，改
  `daemon.stopWithDsh` 会立即取消/重排空闲退出定时器。非法值 → 400，`message` 指明具体键。
- 程序启动半边的实现（`lib/risd/server.js`）：每次程序动作成功后 `saveProgramsSnapshot()` 原子写
  `risd-programs-last.json`（只记 `running.alive===true` 的行，串行队列避免「停到一半就恢复」）；第一份租约
  到达时 `restoreProgramsForLease()` 读快照、逐个在队列里 `startProgramByKey`，跳过已经活着的行，失败留给
  页面（那里有启动按钮和日志）。**每个 daemon 实例只恢复一次**：后来的租约不能把用户刚手动停掉的程序拉回来。
- 与 handoff 的关系：`risd stop --handoff` 不按生命周期表收尾，始终把引擎/程序/调试留给继任者（继任者成为
  新 owner，随后按自己的生命周期管理）。
- **空 revision 语义（评审 A-P2-2，有意保留）**：`POST /v1/proxy` 不带 `revision` 时表示「强制写入」，是
  迁移/修复工具用的逃生口；面板与 yds 永远带 revision（CAS）。文档与测试按此口径，不再当作缺失必填。
- 页面：4 行 × 2 列 `input[data-life="<resource>.<half>"]`，表头是「跟随 dsh 启动 / 跟随 dsh 停止」，
  **勾选即保存**（`change` → `scheduleLifecycleSave()`，300 ms 防抖，没有保存按钮；m13960）；`loadLifecycle()`
  从 `/v1/config` 回填；`lifecycleFromBoxes()` 跳过 `disabled` 的半边（强制的 daemon 启动、不存在的 debug 启动
  都不能进 payload，否则服务端会按未知键拒绝）。`test/risd-lifecycle.test.mjs` 覆盖默认/迁移/非法半边/坏文件/
  原子写/接口回读/程序快照恢复，`test/risd-ui.test.mjs` 断言两列、强制项 disabled、页面不含 `followDaemon` 与
  那句「所有资源强制跟随 daemon」，并编译页面内联脚本（曾经一个漏逗号让整页脚本失效、所有 checkbox 全空）。

### 2.14 工具薄转发（Phase 2-lite P4）

`daemonMode=auto` 时 daemon 拥有引擎、程序注册表与 JDWP 会话，所以 agent 工具改成
**daemon 优先、失败回退本地**（`lib/index.js` 的 `registerAgentTools`）。daemon 不可用时
工具会先 `ensureRisd()` **自动唤起一次**（`daemonStateForTools → healDaemon`，5s 节流）再回退，
所以 `risd stop`、崩溃之后 agent 调一次工具就能把维护进程拉回来；`risd status`/`health` 在未运行时
直接打印 `hint: run risd serve …`，agent 也可据此自行启动。

**防死循环**：自动唤起有熔断器（`RISD_HEAL_MAX_ATTEMPTS=3` / `RISD_HEAL_WINDOW_MS=2min` /
`RISD_HEAL_COOLDOWN_MS=5min`，模块级 `risdHeal`）——两分钟内连败 3 次就停 5 分钟，`ensure` 路由直接回
`{ok:false, risd:{available:false, reason:'连续 3 次自动启动 risd 失败（…），Ns 内不再自动唤起；请运行 risd serve 查看原因'}}`，
工具只回退本地、不再 spawn；成功一次立即清零。`risd` 自身 spawn 也有 `risd.spawn.lock` + 单实例端口选举，
不会并发堆积进程。

| 工具 | daemon 路径 | 说明 |
|---|---|---|
| `ris_dev_programs` | `GET /v1/programs` | 行与面板同源；`runningOnly` 在本地过滤 |
| `ris_dev_start` | `POST /v1/programs {action:'start'}` | 已运行是幂等成功（`alreadyRunning`） |
| `ris_dev_stop` | `POST /v1/programs {action:'stop'}` | 仅当未给 `path`；按路径停止仍走本地 |
| `ris_dev_restart` | `POST /v1/programs {action:'restart'}` | 同上 |
| `ris_dev_logs` | `GET /v1/programs/log` | 读尾窗口；侧边栏仍由插件 `enqueueOpen` 弹（本地文件路径不变） |
| `ris_dev_debug` | `POST /v1/debug` | 动作名映射：`state`=status+breakpoints、`poll`→`events`、`stop`→`detach`、`breakpoint_*`→`breakpoint-*`；`open` 只弹面板、留在本地 |

- **身份也来自 daemon**：`daemonProgramFor()` 先 `GET /v1/programs` 再按 id/logName/name/唯一片段匹配，
  避免「本地扫描」和「daemon 注册表」对同一个程序给出不同 id（`daemonMode=auto` 下 daemon 才是权威）。
- **回退**：`daemonStateForTools()` 等 bridge pending ≤3s；任何失败（daemon 停了、旧 risd、409/404）
  都 `warnFallback()`（同类 60s 只警告一次）后走原来的本地实现——所以 `daemonMode=off` 行为与旧版完全一致。
- **不变的部分**：`ris_dev_status`（pidfile/日志/uptime 都是本地事实）、`ris_dev_skill`、`run/run-stop`
  （注入环境只对插件自己拉起的子进程有意义）、面板日志窗格（本地文件 tail/SSE）。
- **过渡期**：同一个 JVM 同时被面板会话和 daemon 会话 attach 会被 JDWP 拒绝；P4 之后工具已走 daemon，
  正常路径不会再出现两边各 attach 一次——只有手动 `daemonMode=off` 与 `auto` 来回切时旧会话可能残留，重启该程序即可。
- 测试：`test/risd-tools.test.mjs`（4 条，假 daemon 记录请求 + `__test.setRisdBridge()` 注入；覆盖
  programs/start/logs/debug 转发、`state` 组合、daemon 关闭后的本地回退）。

## 3. 日志与显示

日志窗格（侧栏控制台下半段、工作台日志页签）行为一致：

- **数据源**：优先共享一条 SSE（`GET /dsh-ris-ide/stream`，宿主按订阅路径增量推 `append`），连接不可用时退回 `/tail` 轮询（1 s，页面隐藏时跳过，回前台补读一次）；内容没变不触发重渲染。
- **只看本次启动**：日志里有 `--- <name> started … ---` 分段时只显示最后一次启动之后的内容；向上滚到底会预取更早字节（`… 已加载 N KB / M MB`）。
- **级别过滤**：标题栏 `级` 按钮循环 `全部 → WARN/ERROR → ERROR`，只影响显示，内容不丢。
- **查找**：`Ctrl+F` 打开查找条（与编辑器查找面板同款的 chip 样式：输入框、`↑`/`↓`、计数、`×`），`Esc` 关闭。
- **着色**：带 ANSI SGR 的行照原样渲染（Maven / Spring Boot 输出直接有颜色，含 16/256/真彩色、加粗、下划线）；无 ANSI 的行把行首**时间戳压暗**、**级别词**着色——`ERROR/FATAL/SEVERE` 红、`WARN` 琥珀、`DEBUG/TRACE` 灰，`INFO` 保持正文色。非 SGR 的 CSI 序列（光标移动、清行）丢弃，不漏乱码。
- **字体**：默认 `var(--dsw-font-mono, …)`，回退链把本机实际有的字体排在前面（`Ubuntu Sans Mono` → `Ubuntu Mono` → … → `DejaVu Sans Mono`）；行高 1.5。
- **字号**：`A− / A+`，10–20 px，选择记在 localStorage（与 IDE 共用一份偏好）。
- **自动换行**：`换行:开 / 换行:关`，默认开，持久化（`dsh-ris-ide.wrap`）。
- **滚动条常驻**：纵向/横向滚动条始终可见（10 px、中性灰、悬停加深），不随内容 hover 消失。
- **跟随**：标题栏跟随图标切换（提示 `跟随中` / `已暂停`）；向上滚动自动暂停，滚回底部自动恢复。
- **停止服务**：标题栏状态徽标显示 `运行中 (pid N)` / `已停止`（没有 pidfile 时 `未运行`）。停止服务在控制台该行的 `■`：弹确认 → `POST /dsh-ris-ide/stop` → 宿主导出 wrapper 进程组 `SIGTERM`，等宽限（pidfile 第 4 列的每程序 `stopGraceMs`，否则默认 5 s）仍在则 `SIGKILL`；trap 把信号转给真正服务子进程，清 pidfile 后退出。日志里留 `--- <名字> exited … (status 143) ---`。

  停止的安全边界：**浏览器从不提交 PID**，只提交日志路径；宿主自己读 `<log>.pid`，并要求 `/proc/<wrapperPid>/cmdline` 里确实有 `run-with-log.sh` 才发信号，否则 409 `unverifiable`（测试专钉：pidfile 指向普通 `sleep` 进程时必须拒绝且该进程存活）。pidfile 不是「三个正整数」等于没有服务。

- 头部模式横幅出现 = tail/stream 路由没通。首查：`curl -s 'http://127.0.0.1:3080/dsh-ris-ide/tail?sessionId=<id>&path=<绝对路径>&bytes=4096'` 应返回 `{"ok":true,...}`；此时 pidfile 读不到，停止按钮不出现。

## 4. 边界与配置

| 项 | 值 |
|---|---|
| 尾部窗口 | 单次 `/tail` 默认 64 KiB、最多 512 KiB；`config.maxBytes` 默认 512 KiB（即硬上限），只能调小 |
| 推送 | 一条共享 SSE（`/dsh-ris-ide/stream`），各窗格按自己订阅的日志路径过滤；不可用时降级为 1 s 轮询（页面隐藏跳过） |
| 渲染上限 | 最多渲染窗口内最后 4000 行（防元素树无界） |
| 路径规则 | 相对路径按会话 cwd 解析，绝对路径保持绝对，**默认不做包含性限制**（否则 cwd 外的日志会静默降级成头部模式）；`config.restrictToCwd: true` 开启「必须在会话工作目录内」 |
| 停止宽限 | `config.stopGraceMs`，默认 5000，上限 60000（TERM→KILL 之间的等待） |
| 安全 | 所有 `/dsh-ris-ide/*` 路由只接受 loopback 的 Host（`localhost`/`127.x`/`[::1]`），带 Origin 必须同源；读只 GET；写/启停/调试/跑测试走 POST + JSON body；停止的 PID 只来自 pidfile 且过 `/proc` cmdline 校验 |
| 执行类动作 | 启动/停止/调试/跑单测都由宿主按扫描结果或白名单拼命令，浏览器只发程序 id 与受限参数（`/run-test` 的类名/测试名只允许字母数字与点号，模块路径必须落在工作区内且有 `pom.xml`） |
| 写动作 | 编辑器保存走 `POST /dsh-ris-ide/fs/write`（保持探测到的编码/换行）；文件树支持 mkdir/create/copy/move/remove（工作区根拒绝、非空目录需 `recursive:true`）；其余写动作只有停服务与按扫描/配置启动程序 |
| 失败面 | 两条读取通道都失败 → 错误条；只有 tail 失败 → 头部模式 + 横幅；停止失败 → 头部下方一行说明（`no-service` / `unverifiable` / `signal-failed`） |

配置写在 profile 的 Loader 行里（`cordis.patch.yml`）：

```yaml
- id: ris-ide
  name: 'dsh-ris-ide'
  config:
    maxBytes: 131072        # 每次读取的尾部窗口（上限 512 KiB）
    restrictToCwd: false    # true = 只读会话工作目录内的文件
    stopGraceMs: 5000       # 停止服务时 TERM→KILL 的宽限
    agentTools: true        # 注册 ris_dev_* 工具给模型（默认开；false = 只有面板）
```

### 2.22 2026-11-09 晚 m09693 打开中的界面不再需要手动强刷

**问题**：改完 `lib/client.js`（或 `lib/risd/ui.js`）后，已经打开的 IDE 窗口/维护页不会变——用户看到的是「必须 Ctrl+Shift+R」。这**不是 HTTP 缓存**：dsh 宿主的插件资源走 `IMMUTABLE_CACHE = public, max-age=31536000, immutable`，但路径里带内容修订（`hashRevision`，按 mtime+size），换了代码 URL 就换；daemon 的 `/ui` 也已经是 `cache-control: no-store`。真正陈旧的是两层**进程内内存**：

1. **已打开的页面**继续执行它 boot 时那份 client bundle；
2. **daemon 进程**的模块图是启动时 import 的，`ui.js` 改了 reload 也读不到（这就是「重启 daemon 才生效」的由来）。

**做法**（三层，互不依赖）：

| 层 | 指纹 | 页面行为 |
|---|---|---|
| dsh 宿主 → client bundle | `clientBundleStamp()`（`lib/index.js`，`client.js`/`client-codemirror.js`/`window.html` 的 size+mtime，12 hex） | 随 SSE `hello` 的 `build` 下发，另有 `GET /dsh-ris-ide/build` 供页面在 hello 之前先取基线；独立窗口 `location.reload()`，DSH 页面右下角弹「IDE 界面已更新：刷新页面后生效」（reload 会丢会话视图，所以交给用户） |
| daemon 页面代码 | `lib/risd/build.js` 的 `buildStamp()`（daemon 模块的 size+mtime） | 启动时取 `loaded`，每次 `/v1/health` 现算 `disk`；页面每 5s 比：`loaded` 变（daemon 重启成新代码）→ 自己 reload；只有 `disk` 变（源码比进程新）→ 顶部横幅「插件版本已更新」+「重启并刷新」按钮（m11421：`POST /v1/restart`，daemon 起 `--wait-pid` 后继再 handoff，新实例出现后本页自动 reload） |
| daemon 的 `/ui` HTML | 已经是 `no-store`，且整页内联 | 不需要额外处理 |

**边界**：页面第一次拿到的指纹即「本页运行的代码」（bundle 与指纹几乎同时从同一宿主取），之后不同才动作；`apply` 里装 watcher 前要求 `typeof EventSource === 'function'`，否则 Node 测试环境 import `client.js` 会起异步流过测试生命周期（曾触发 “EventSource is not defined” 的 uncaughtException）。

**仍需手动**：改 `lib/index.js`（新增路由/`hello` 字段本身）要重启 `dsh web` —— 宿主插件只在启动时组合，这与缓存无关。

### 2.23 2026-11-09 17:0x 次日评审修复（11:30 后代码，2 P0 / 9 P1）

对 `5d6153b^..HEAD`（38 文件 +3266/−335，含 m09031–m09909 的 PR 修复、组件下载化、构建指纹）与 yds `7788989..b8ff222` 做了专家评审（报告 `work/reviews/20261109-1130/`：A/B/C/D/E + `00-汇总.md`）。四条并发修复：

- **A `c7ad0a6`（daemon 核心）**：`GET /v1/health` 增 `instance`（= 启动时刻，无 token），`/ui` 透传 `uiInstance`；`POST /v1/config` 以磁盘为基严格校验（未知资源/未知内层键/非对象/null/数组 → 400），GET `lifecycleErrors` 实时读盘；`/v1/dsh` 增 `dropped`；`/v1/proxybridge` 增 `sha256/actualSha256/verified`，download/upload 支持 `expectedSha256`，摘要不符 → 400 `{code:'hash-mismatch',expected,actual}`；上传 >16 MB → 413、读超时 → 408；`replaceRulesFrom` 只接受 `['yds']`。
- **B `dfbbfa9`（组件完整性）**：`BUNDLE_SHA256` 固定在 `lib/proxybridge-bundle.js`（env `DSH_RIS_IDE_PROXYBRIDGE_SHA256` > settings `proxybridgeSha256` > pin；空串 = 不固定），下载先验摘要再落盘、重定向后最终主机白名单、流式 16 MB 上限，manifest 记逐文件哈希，新增 `verifyInstalled()` 内容级校验；Windows materialise 副本按 `sha256:installedAt` 指纹刷新；`mergeConfigs` **透传 owners**（此前丢失导致 yds stop 减法失效，P0）。
- **C `4e75aa4`（宿主/页面）**：**build 变化不再自动 reload**——客户端 `note()` 只弹「IDE 界面已更新」提示（按 build 记忆关闭），新增 30s `pollBuild()`（页面隐藏跳过、`focus` 兜底），独立窗口也不再 `location.reload()`；维护页 `#ui-drift` 三态（instance 不符 = token 失效 / `loaded` 不符 = daemon 重启 / `disk` 不符 = 源码比进程新）全部只提示，带「刷新」按钮与「代理规则未保存」确认；`isBashDialectCommand` 收窄（`$VAR` 只认全大写）并新增 `POWERSHELL_DIALECT_RE` 前置排除，`$env:JAVA_HOME` 不再被强制走 Git Bash。
- **Lead 额外修复（测试隔离）**：完整跑测试后发现真实 `~/.gitconfig` 被写入了 `http.https://git.example.com/.proxy = socks5h://proxy.example.com:10080`——`test/risd-helpers.mjs` 启 daemon 时只隔离了 `DSH_RIS_IDE_PROXY_HOME`，而 `/v1/action start` 的 git 规则走 `git config --global`（跟随 `HOME`/`GIT_CONFIG_GLOBAL`）。已把 spawn 默认 env 固定为 `HOME=<tmp>`、`USERPROFILE=<tmp>`、`GIT_CONFIG_GLOBAL=<tmp>/.gitconfig`（调用方可覆盖），`test/harness.test.mjs` 加源码守卫；本机被污染的条目已删并恢复 `http.https://gitlab.hanslaser.com/.proxy = socks5h://10.3.91.121:1080`。
- **D `d305fd5`（yds）**：旧表无 owners 的行迁到保留键 `'<legacy>'`（**任何 workspace 的 stop 都不撤**，下次 start 并列加入）；规则 id slug 冲突加 6 位 base36 后缀；Windows 探测 5s 缓存 + `clearProbeCache()`；`stopPid` 支持注入 `kill`/`SIGKILL` 后校验/杀进程组；`yds stop` 在 YMS 未停或身份 unknown 时**中止**（不动规则/转发器/系统层），需 `--force`。

**契约变化（两边都要记）**

| 侧 | 变化 |
|---|---|
| daemon → 页面 | `health.instance`、`/ui` 的 `PAGE_INSTANCE`、`/v1/proxybridge.{sha256,actualSha256,verified,urls,urlError}`、`/v1/proxybridge/download` 接受 `{force:true}` |
| ris-ide → yds | `mergeConfigs` 必须透传 `owners`；owners key 可为 `'<legacy>'`；规则 id 可能是 `<base>-<hash6>`；`POST /v1/proxy` 的 config 不再含 `shadows` |
| yds CLI | `yds stop` 在 YMS 未停/身份 unknown 时中止并提示，`--force` 才强撤 |

**本机验证**：`risd-api` 16/16、`risd-build` 新增；全量见 §5（`host-tail` 与 `risd-election` 两条在本机并发负载下偶发超时，单跑全过，非回归）。

**三项已定稿（2026-11-09 17:0x，维持现行实现）**：①组件摘要 = **固定 pin**（`BUNDLE_SHA256`；重发附件必须同步改常量并发版，也可用 env/settings 覆盖，置空=首次信任）；②build 变化 = **只提示不自动刷**（客户端 30s 复查 + 右下角提示，避免丢未保存编辑）；③维护页 401 自愈 = **`instance` 对比提示 + 手动刷新**（不自动换 token）。

**仍需外部动作**：发 1.8.1（打 tag 走 Jenkins → Nexus/Gitee/GitHub，见 §1.7）、把 `work/ris-proxy/ris-proxy.4.0.tgz` 上传成 **`1.8.0` release 的附件**（用户 2026-11-10 定：**下载路径固定**在 `releases/download/1.8.0/ris-proxy.4.0.tgz`，不随插件版本号变；组件包本身也不会改，真要换包就覆盖这个附件并同步 `BUNDLE_SHA256`）、yds 1.1.0 首发包名沿用 **`dsh-ris-yds`**（与仓库/安装命令一致）。

### 2.24 2026-11-09 17:5x 代理页 UX（m10304：编辑即保存 / 自动启动 / 状态列 / 停止灰显）

用户的四问归一：`代理页配置不是自动保存直接生效么？行配置校验？需要启停按钮么？…是否该显示代理程序的允许状态？ProxyBridge 不要显示安装目录。` 与 `停止按钮，已停止了按钮灰显`。实现（全部在 `lib/risd/ui.js`，daemon 无新路由）：

- **编辑即保存**：SOCKS 主机/端口、监听端口、规则表的 `input`/`change`、+添加规则、删除行都触发 700 ms 防抖的 `scheduleProxySave()`；`proxyFormIssues()` 先校验（主机非空且无空格、两个端口 1-65535、启用行必须有程序/IP/端口且端口是 `*` / 逗号列表 / `n` 或 `n-m`），不完整只在横幅写「还没保存：第 N 行缺…」，不写盘也不报错。
- **保存不启动**（2026-11-10 改，m13920）：保存只写表；引擎在跑才重载拦截，引擎没跑就在横幅写明「引擎未启动（保存不会启动它，点「启动」或组件区的「启动系统层拦截」）」。原 `maybeStartProxy/hasActionableRule` 已删——「完整就顺手启动」既让人意外，又与生命周期重复。
- **保存串行 + 冲突自愈**：同一时刻只允许一个 `POST /v1/proxy`（`saveInFlight`），落单的编辑置 `savePending` 并在完成后重排；POST 进行中用户继续输入时**不回绘**（回绘会把新输入换回旧值），只把新表单再写一次；409 时用 `refreshProxyView()` 只取新 revision（不重绘）再重试一次，仍 409 才显示「规则表已在别处被修改」。
- **状态列**（新增第 5 列）：`ruleStatus()` = 未启用 / 缺程序(`缺程序/IP/端口`) / 端口格式 / 待启动（引擎没跑）/ 生效（引擎在跑）。
- **启停与灰显**：概览「代理运行状态」加 `启动`（运行中 disabled）与 `停止`（未运行 disabled）；代理页头加 `代理运行中/代理未运行` 状态 pill + `停止`（未运行 disabled）。停止走 `/v1/action stop`（引擎 + 系统层 + git 代理一起撤）。
- **组件卡片**：`renderBundle` 的安装态只显示「已安装 · 文件 N 个」，不再泄露安装目录（目录只在未安装提示里作为路径线索）。
- 测试：`test/risd-ui.test.mjs` 24 条（新增自动保存/校验/状态列/引擎按钮/卡片去目录/409 一次重试等源码断言）；全量见 §5。

### 2.25 2026-11-09 17:2x m10585 全机一张表 + 单按钮启停（四条）

用户四条：`规则表缺了 yds 自动注入的 wsl 端的配置`、`规则表不分工作区，改动直接覆盖（配置行校验并保存，停止旧的，应用新的）。没有交叉配置的说法`、`规则表不要读取、保存按钮，停止按钮点击停止后，变成启动按钮`、`proxybridge 状态若已安装，不显示下载按钮`。

- **WSL 侧行（第 1 条，根因在 yds）**：`program` 带扩展名时 `processPattern()` 原样匹配（只命中 Windows 的 `java.exe`），裸名才是 `*name*`（两侧都中）。yds 以前只生成 `java.exe`/`git.exe`，WSL 本侧的 ProxyBridge 一条都匹配不上。现在 yds 在非 Windows 生成四条（`java.exe`/`java`、`git.exe`/`git`，各带 `side: 'windows'|'local'`），ris-ide 的 `normalizeConfig`/`mergeConfigs` 保留 `side` 字段（以前会被规范化丢掉），页面「来源」列显示 `yds·win` / `yds·wsl`。
- **整表覆盖（第 2 条）**：`POST /v1/proxy` 的 `rules` 就是最终表，未出现的行一律退役（不再按 workspace/source 保留）；`lib/proxy.js` 增加 `replaceAllRules: true`（本地档整表替换）。`replaceRulesFrom` 只留一版兼容 shim：旧 yds 只发自己那几行时按 source 退役，避免删掉用户行；新客户端不发。规则行不再写 `workspace`（保留字段只为兼容旧文件）。
- **保存即切换**：保存仍是「校验 → 写盘 → 停旧 → 起新」，但重载系统层拦截的两轮 PowerShell 探测在 WSL 上约 8 s（保存接口原本同步等它，yds 的 8 s 超时会 abort）。现在 POST 先返回（`reloadNote: '规则已保存；系统层拦截正在后台按新规则重启'`），`setImmediate` 里跑 `switchEnforcement()`；结果存 `bridgeReloadState`，`GET /v1/proxy` 带 `bridge:{at,ok,note}`，页面下次加载时失败会显示「重启系统层拦截」入口。`serializeBridge` 仍串行，每次重载重读文件，连续编辑最终落在最后一张表。
- **去按钮（第 3 条）**：删「读取」「立即保存」（编辑即保存，见 §2.24）；概览与代理页各一个 `engine-toggle` / `proxy-engine-toggle`：运行中显示「停止」（danger 样式），停止后变「启动」，两处共用 `toggleProxyEngine()`。
- **组件卡片（第 4 条）**：`renderBundle` 安装态 `button.hidden = installed`、`upload.hidden = installed`，只显示「已安装 · 文件 N 个」。
- **顺带**：`checkBuild()` 发现 daemon 实例/页面代码变了时，若不在 IDE 页签、没有未保存的代理/生命周期编辑就直接 `location.reload()`（旧页面的 token 已随 daemon 重启失效，所有 API 都会 401）；否则仍给「刷新」按钮。
- 测试：`risd-ui` 24、`risd-api` 16、`proxy` 29、yds `161` 全绿；全量见 §5。

### 2.26 2026-11-09 17:4x m10900 页签记忆 + 漂移时先存盘再刷新

用户三条：`维护页源码更新消息，若有文件编辑中未保存，应提示并增加按钮 保存所有文件`、`菜单中的 IDE 字样改为 开发环境，代理改为 代理设置`、`快捷键或按钮刷新页面时保存选中的菜单和工作区。（dsh 端点 IDE 按钮自动定位开发环境和工作区）`。

- **页签/工作区记忆**：nav 文案「开发环境 / 代理设置 / 概览」；`?tab=` 仍优先（深链/测试可用），dsh 的 ⧉ 只带 `?cwd=`（m11345：按钮的语义是「打开这个工作区的维护页」，不抢用户的页签），没有 `?tab=` 时从 `localStorage` 的 `risd.tab` 恢复上次页签（`showTab()` 每次写），工作区沿用已有的 `risd.cwd`。所以浏览器刷新/快捷键重载、以及从 dsh 点 ⧉ 进入，都停在你上次的页签（工作区会切到当前会话）。
- **漂移条先问未保存**：维护页与内嵌 IDE 跨源，唯一能知道「刷新会不会丢 buffer」的办法是 postMessage 问它：
  - 维护页 → iframe：`{type:'dsh-ris-ide:probe-dirty', requestId}`（1.5 s 超时）与 `{type:'dsh-ris-ide:save-all', requestId}`（20 s 超时），待答表 `ideAskState`。
  - iframe（`lib/client.js`）→ 只回自己的 `window.parent`：`{type:'dsh-ris-ide:dirty-report', requestId, count, names}`（`names` 取前 5 个）与 `{type:'dsh-ris-ide:save-all-done', requestId, ok}`；`save-all` 复用 `saveBulk(dirty)`，不引入新的保存路径。
  - `checkBuild()` 判定 `instance` 或 `uiBuild.loaded` 变化（= 本页 token 已随 daemon 重启失效）时，先 `askIdeDirty()`：`count === 0` 且没有未保存的代理/生命周期编辑 → `location.reload()`；否则漂移条写「开发环境里有 N 个文件未保存」并露出「保存所有文件」按钮，点它 `save-all` 成功后整页 reload（`driftSaveThenReload`），失败提示「有文件没保存成功…」。`count === null`（旧 iframe 没答）时不自动刷、提示无法确认。
  - 401 的提示不再覆盖上面的未保存文案（轮询 timer 与漂移检查可能同时触发，见 `api()` 的 `driftMessage.indexOf('未保存')` 守卫）。
- 测试：`test/risd-ui.test.mjs` 24 条（页签文案、`TAB_STORAGE` 读写、`ui-drift-save`、`askIdeDirty`、自动 reload 的三种守卫、401 不覆盖未保存文案）；`test/client-viewer.test.mjs` 246 条（新增 iframe 只答 parent、两种消息名、`saveBulk(pending)`）。
- 真机：`/ui` 点「开发环境」后直接打开 `/ui` 仍是开发环境；`/tmp/risd-dirty-demo` 独立窗口里改 `notes.txt` → `probe-dirty` 回 `{count:1,names:['notes.txt']}` → `save-all` 回 `{ok:true}` 且文件落盘；维护页在 daemon 重启后出现「保存所有文件」，点它保存并 reload 成功。

### 2.27 2026-11-09 18:1x m11279 启停按钮的 loading 态

用户：`代理点击启动 加loading`。启停要等 `POST /v1/action` 回来（引擎 spawn、git 代理写入，必要时还有 sudo/UAC 提权），以前按钮只是灰掉、看起来像没反应。

- `lib/risd/ui.js`：`engineBusy` + `engineBusyAction`，两个按钮共用一个 `paintEngineButtons()`：忙时 `disabled`、`aria-busy="true"`、文案「启动中…」/「停止中…」；`toggleProxyEngine()` 入口 `if (engineBusy) return;`（连点不会发两次 POST），`then`/`catch` 都先清 busy 再按最新状态重画。
- 4 s 的 `proxySummary()` 与页签重绘 `renderProxyTab()` 在 `engineBusy` 时不覆盖按钮文案，避免轮询把「启动中…」刷回「启动」。
- CSS：`button[aria-busy="true"] { opacity:.7; cursor:progress; }`。
- 测试：`test/risd-ui.test.mjs` 24 条（新增 busy 守卫、aria-busy、两种文案、轮询不重绘）。

### 2.28 2026-11-09 18:2x m11421「插件版本已更新」改为重启并刷新

用户：`维护页源码比 daemon 进程新：重启 daemon 后生效 刷新按钮应该是重启并刷新吧？ 先重启daemon再刷新？` 以及 `描述也应该为 插件版本已更新，xxxx`。

- 文案：`disk !== loaded` 的横幅由「维护页源码比 daemon 进程新：重启 daemon 后生效」改为「插件版本已更新，点「重启并刷新」后生效」；按钮从「刷新」改为「重启并刷新」（`showDrift(text, mode)` 的 `driftMode` 决定）。
- `POST /v1/restart`（token 保护，幂等：同一进程只成功交接一次）：返回 `{ok,restarting,pid}` 后 `setImmediate` 里 `spawnRestartSuccessor()` + `onShutdown(true)`（handoff，**不拆代理引擎/桥接**，由后继收养）。后继命令 `node bin/risd.mjs serve --wait-pid <旧 pid>`，`detached + stdio:ignore + unref`。
- `bin/risd.mjs` 新增 `--wait-pid <n>`：`serve()` 先 `waitForPidExit(pid, 20000)`（`process.kill(pid,0)` 到 ESRCH；EPERM 视为活着），保证端口已释放、handoff 戳已落盘，避免后继撞 `already-running`。
- 页面：`restartDaemon()` 先把按钮置灰成「重启中…」、发 `POST /v1/restart`（连接被退出切断属正常），再每 400ms 拉免认证的 `/v1/health`，等 `instance !== PAGE_INSTANCE` 后 `location.reload()`；30s 超时提示手动重启。若开发环境有脏 buffer，先 `askIdeDirty()`：>0 露出「保存所有文件」，`driftSaveThenReload` 保存成功后**继续走 restart** 而不是直接 reload；`proxyDirty` 仍然先 `confirm`。
- 真机：`touch lib/risd/ui.js` → 横幅「插件版本已更新，点「重启并刷新」后生效」；点按钮 → daemon 1976526 → **1977043**（`serve --wait-pid 1976526`），`engine {inherited:true,pid:1968383}` 未拆、janitor owner 换成新 pid，页面自动 reload 且新 token 可用（`/v1/config` 200、规则 5 行、代理运行中、页签仍是「代理设置」）。
- 测试：`test/risd-ui.test.mjs` 增 `driftMode`、文案、`/v1/restart`、`body.instance !== previous`、`restartDaemonThenReload`、save-all 继续 restart 断言；`test/risd-api.test.mjs` 增「restart 拉起等待旧 pid 的后继」源码守卫。全量 735 通过（risd-ui 25 / risd-api 17）。

### 2.29 2026-11-09 18:3x m11559 空横幅占掉一个 flex gap

用户：`view-overview 的 overview-banner 导致 内容区域顶端比 view-proxy 多空出14px`。

- 根因：`#view-overview`/`#view-proxy` 都是 `display:flex; flex-direction:column; gap:14px`。`#overview-banner` 是一个**常驻的空 wrapper**（只在 `toggleProxyEngine` 里才被写 `innerHTML`），空元素高度为 0，但仍然是 flex item ⇒ `gap` 照算，概览的内容整体比代理页低 14px。
- 修法：`#overview-banner:empty, #proxy-banner:empty { display:none; }`（`:empty` 对 `innerHTML === ''` 成立；写了内容就恢复 `display:block`）。`#lifecycle-note` 是行内 `<span class="muted">`，不占 gap，不在修复范围。
- 验证（daemon 用新 `POST /v1/restart` 交接重启 pid 1981380）：`/ui?tab=overview` 与 `/ui?tab=proxy` 首个子元素 `top` 都是 **69px**；给 `#proxy-banner` 写入内容后高度 38px/display block，清空后 0/display none。
- 测试：`test/risd-ui.test.mjs` 增 `#overview-banner:empty` 守卫；全量 **736/736**。

### 2.30 2026-11-09 20:1x 系统层拦截单实例（m11702/m11773）

dup 症状：两个 `ProxyBridge_CLI.exe` 同一秒启动、父进程是两个 `proxybridge-watchdog.ps1`。根因是**每次启动都新起一个 watchdog、从不结束旧的**；watchdog 只在「收到 stop」或「心跳 >20 s 过期」时退出，dsh 活着时心跳每 3 s 刷新，于是 watchdog 越积越多，任一次心跳瞬间过期就各自重启一个 CLI。WinDivert 句柄独占 ⇒ 只有一个真抓包，另一个加载了规则却没有任何 `[CONN]`，且 pid 文件只记一个，「谁在拦截」不可见。

修复（两侧都做，`fc2ee00` + `c31feaa`）：
- watchdog：命名互斥 `Local\dsh-ris-ide-proxybridge-watchdog-<home sha1 前 12>`，拿不到就退出；elevated 启动脚本起新 watchdog 前先 `Stop-Process` 旧的（报告串带 `oldWatchdogs=N`）。
- Linux 侧：`localRedirectorPids()` 扫 `/proc/*/cmdline` 返回**全部**本侧引擎；`acquireStartLock(side)` 用 `<proxy home>/locks/proxybridge-<side>.lock`（`mkdirSync` 原子、owner pid 死/锁龄 >30 s 判陈旧、默认等 15 s）包住 detect→spawn；`startRedirector` 对已在运行时的多余 pid `SIGTERM` 并回报 `reaped`；`stopRedirector` 停完记录 pid 后再扫一次，把剩余本地引擎一并结束。
- Windows 侧：elevated 启动脚本开头抢 `Local\dsh-ris-ide-proxybridge-start-<home sha1>` 互斥（`WaitOne(30000)`），失败输出 `start-busy=True`，宿主回报「另一个进程正在启动 Windows 侧拦截」；启动后仍保留杀多余 CLI 的收尾。

### 2.31 2026-11-09 20:4x ProxyBridge 组件健康检查 + 引擎停止即禁止拦截（m11828/m11838/m11863）

组件卡片除了「已安装 · 文件 N 个」再给一条健康结论，两侧分开：
- 文件：该侧启动所需的文件逐个存在且非空（linux 2 个 / windows 4 个；licence 不参与）。
- 可启动：Linux 直接跑 `ProxyBridge --version`；Windows 经 `powershell.exe -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '<exe>' --version"`，且探测的是 `%LOCALAPPDATA%\dsh-ris-ide\proxybridge\windows\ProxyBridge_CLI.exe`（`windowsBundleDir()`+`posixToWindowsPath()`）——Windows 不能从 Linux 文件系统直接 launch，缓存里的路径探不了；副本还没准备时 runs 报「尚未复制到 Windows 侧（首次启动拦截时准备）」，不当成损坏。能解析出 `x.y.z` 才算健康，失败把最后一行错误截 160 字带出来。
- 拦截状态：`redirectorStatusCached()` 的 `runningLocal/runningWindows`，显示「拦截运行中/未启动」——是状态，不是故障。

只读、不启动/不提权/不杀进程；`execFile` 超时 6–8 s；`GET /v1/proxybridge/health`（30 s 缓存，`?force=1` 穿透）。**引擎未运行时不探测**（`{ok:null, checked:false, engineRunning:false, interception, stray}`），因为组件这时根本没被使用，红色「组件异常」只会误导。引擎运行中才探测，并附带 `stray{linux,windows}`。

不变量（m11863）：**代理引擎停止时，组件不应继续运行**。启动对账在 `reconcileStartupLeftovers` 之后检查 `proxyPid() === null && redirectorStatusCached().running`，打印「代理引擎未运行：停止系统层拦截，避免把连接转发到已关闭的端口」并 `stopRedirector()`；健康响应里同样把这种状态标成 `stray`，卡片显示「组件不应运行」+「停止拦截」按钮（点击走 `POST /v1/action {action:'stop'}`）。

页面：卡片新增 `#bridge-health-pill`/`#bridge-health-detail`/`#bridge-health-list`（每侧「Linux：文件 2/2 · v4.0.0 · 拦截运行中」）/「重新检查」/「停止拦截」；`loadBundle()` 时取一次、引擎启停成功后 `loadHealth(true)` 强制刷新；`toggleProxyEngine` 成功后同样强制刷新。测试：`test/proxybridge-health.test.mjs`（3 例）、`test/risd-api.test.mjs`（引擎停止时 `checked:false`/`ok:null`/`stray` 双 false、`?force=1` 也不探测）、`test/risd-ui.test.mjs`（pill/路由/逐侧行/stray/停止按钮/模板转义）。
**单侧环境不是故障（m12019/m12029）**：一台机器只可能有一种「本侧」——原生 Linux 没有 Windows 侧、原生 Windows 没有 Linux 侧，只有 WSL 才两侧都有。`collectProxyBridgeHealth({linuxApplicable, windowsApplicable, windowsPrepared})` 对 `applicable:false` 的侧返回 `ok:true, skipped:true`（`ok` 只由适用的侧决定）；`isWslHost()` 读 `/proc/sys/kernel/osrelease` 是否含 `microsoft`，**非 WSL 不把 Windows 侧标成 applicable**，卡片也就不显示一行不存在的 Windows 侧。副本还没 materialise（`windowsPrepared:false`）同样记 skipped + note，不判红。

**引擎 ⇔ 组件一致（m12046/m12053/m12060）**：一个不变量、一个执行点 `reconcileEngineBridge(reason)`（`lib/risd/server.js`）：引擎在跑而桥接没跑 ⇒ `serializeBridge(startRedirectors())`；引擎停了而桥接还在跑 ⇒ `serializeBridge(stopRedirector())`。四条触发路径——daemon 启动（`await reconcileEngineBridge('startup')`，继承来的引擎也会把组件拉起）、健康轮询（`'health'` / `'health-stray'`）、启停动作（`/v1/action` 本身已双向处理）、以及 15 s 一次的 `bridgeSupervisor` 安全网（`BRIDGE_RECONCILE_MS`，`unref`，`stop()` 清掉）。启动/停止尝试按 `BRIDGE_PULL_INTERVAL_MS=60_000` 节流（缺提权时不会每次轮询都弹 UAC/刷日志），`reconciling` 防重入。卡片在「引擎已运行、两侧都还没拦截」时显示 warn「拦截未启动 · 正在拉起组件；需要提权时会提示原因」，不再把这一刻画成绿色「组件正常」。

呈现方式（m12313，2026-11-09 晚定稿）：健康区只有**一行**——`pill + 一句状态`，不再列每侧的文件数/版本、也没有「重新检查」按钮。状态取自定时器（proxy 页签可见时每 10 s 拉一次 `GET /v1/proxybridge/health`；route 自带 30 s 缓存，所以真正的 PowerShell 探测最多 30 s 一次），文案只有五种：`拦截运行中`（+ 哪一侧在拦截 / 另一侧未运行）、`拦截未启动`（+ 缺哪一侧、需要提权时会重试）、`组件异常`（+ 具体哪一侧、什么错）、`代理引擎未启动`、`组件不应运行`（引擎停了但拦截还在，附「停止拦截」按钮）。

**「需要 root」要给命令**（m12359）：Linux 侧桥接必须 root（eBPF）。面板以前只说「需要提权」，用户拿不到命令；现在 `GET /v1/proxybridge/health` 直接带 `commands.linux`（`redirectorCommand()` 拼出的 `sudo …/bundle/linux/ProxyBridge --profile … --verbose 2`），`lastStart.skipped[].command` 也保留每次启动尝试的命令；卡片那一行在「该侧未运行」时追加「需要 root，执行：<命令>」（完整命令同时挂在 `title` 上）。注意 dsh 本身不是 root（`uid=1000`），且某些容器/沙箱里 `sudo` 被 `no_new_privs` 挡住，这时命令能复制但要在能提权的终端里跑。

**升级或降级**（m12486）：判断就是「试着起」。daemon 的 `reconcileEngineBridge` 在引擎运行时会调用 `startRedirectors()`——能起（Windows 侧 UAC、Linux 侧 root/sudo）就是**系统层拦截**；起不来（本侧 skipped）就**降级**：`GET /v1/proxybridge/health` 返回 `degrade`（`httpProxyUrl` = `http://127.0.0.1:<listenPort>`、`jvmArgs` = `-Dhttp.proxyHost/Port` + `-Dhttps.proxyHost/Port` + `-Dhttp.nonProxyHosts`、`env` = `ALL_PROXY/HTTP_PROXY/HTTPS_PROXY/NO_PROXY`、`command` = 可粘贴的 sudo 启动命令），用户启动的程序由 launcher 注入这些（`injectionFor()` 老逻辑）。降级满足不了的（JDBC 驱动、Navicat 这类无法告知代理地址的程序）只能靠系统层拦截，所以同一份 payload 带 `command`。

降级的三条路（m12567）：JVM 参数、环境变量、**git**（daemon 自己写 `http.<host>.proxy`，`degrade.git` 带出 host/key/value；没写过时给 `git config --global http.<host>.proxy socks5h://…` 的命令）。三者都不行的（JDBC、Navicat 等拿不到代理地址的程序）仍需系统层拦截。

卡片呈现（m12508）：一行短状态（如「Windows 侧正在拦截（Linux 侧未运行 · 已降级）」）+ 可折叠「说明」；说明里才是 sudo 命令、JVM 参数、环境变量和「JDBC/Navicat 只能靠系统层拦截」的提醒。

两个实现细节（2026-11-09 当天收尾时补上，避免诊断变慢/误伤）：
- **启动不阻塞**：启动对账与「引擎不在就收掉残留拦截」都放到 `setImmediate` 里异步做，`/ready` 不再等 Windows 侧 PowerShell 探测（WSL 上 3 s+，测试里会让 fixture daemon 超过 10 s 的 ready 超时）。
- **只收自己那份**：残留拦截是否「在跑」必须先看本 proxy home 的 `proxybridge*.pid`；机器上另一份配置的 `ProxyBridge_CLI.exe` 不归这个 daemon 管（fixture 空 home 曾把用户真实拦截当成残留去 SIGTERM）。探测本身改走 `redirectorStatusAsync()`（并发的请求共享一次探测），不再用会 `spawnSync` 的同步版本堵事件循环。


### 2.32 2026-11-09 21:2x 规则表首列表头改名（m12163）

用户：`规则第一列 应该是 程序名称/路径`。表头由「程序 / IP」改为「程序名称/路径」——这一列存的确实只是程序（裸名按镜像名匹配、含路径则精确到可执行文件），IP 白名单在下一列「目标主机」。`test/risd-ui.test.mjs` 增表头断言。README 的规则表描述同步为「启用 · 程序名称/路径 · 目标主机 · 端口 · 状态 · 来源」。

## 5. 测试

```bash
cd dsh-ris-ide          # 仓库根
npm test            # = node --test --test-timeout=120000 "test/*.test.mjs"
```

当前 **788 条 / 55 个文件**（2026-11-11 整理后；下表只列早期核心文件；全套默认并发 **21.8 s**、不碰真机）：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/client-viewer.test.mjs` | 251 | 客户端 SSR 快照 + 源码守卫（快捷键、菜单、批处理、查找面板、定位/高亮、日志级别、diff、帮助数据…） |
| `test/host-tail.test.mjs` | 100 | `/tail`/`/stream`/`/stop`/`/start`/`/run-test`/`/search-content`、pidfile 协议、编码探测、路径围栏 |
| `test/clipboard.test.mjs` | 20 | 文件剪贴板（暂存副本 / 读系统剪贴板 / 路径解析）与粘贴范围护栏 |
| `test/debug-engine.test.mjs` | 11 | JDWP 会话状态机、断点映射、栈/变量解码 |
| `test/host-search.test.mjs` | 14 | 内容检索白名单、命中上限、截断标记、流式检索分页（含 root 顺序的 limit 预算） |
| `test/windows.test.mjs` | 12 | 独立窗口登记表、会话自愈、窗口接管 |
| `test/host-window.test.mjs` | 4 | 独立窗口的路径/尺寸/单例参数 |
| `test/harness.test.mjs` | 5 | 测试自身不依赖本机路径（裸克隆可跑）、React 探测 |
| `test/host-nogit.test.mjs` | 1 | 无 git 时树/检索退化 |

规矩：

- **裸克隆可跑**：`npm test` 不联网、不装依赖、不写死本机路径；真实 React 按 `DSH_RIS_IDE_REACT_ROOT` → 仓库 `node_modules` → 兄弟项目 `tools/*/node_modules` 找，都没有则 SSR 用例自动 skip（`harness.test.mjs` 守着）。
- **CI**：用 `BASH_ENV` 把 PATH 补回 `bash -lc`（否则启动类用例报 `npm/node not found`）；仓库已提交 `lib/client-codemirror.js` ⇒ 正常构建跳过依赖安装与 chunk 构建，只有改了 `src/chunks/**` 才需要现构建。
- **CI 的运行环境是纯 Linux（k8s pod）**，不是开发者的 WSL：没有 `wslpath`、没有 `/mnt/c`、没有 Windows 侧，`engineSide()` 返回 `linux`。用例不能假设「本机是 WSL」（2026-11-11 因此红了三条）。`Jenkinsfile` 的 Test 阶段包了 20 分钟 `timeout`：`node --test` 遇到泄漏的子进程会无限等待（日志停住、既无失败也无超时），由流水线判定失败而不是吊死 agent。
- 用例里对「源码文本」的断言较多（快捷键优先级、菜单结构这类不好用渲染断言的东西），改相关代码时要同步改断言——这是有意为之。

- **node 版本不同，同一个用例在两台机器上结局不同（2026-11-11，CI 只红在这里）**：CI pod 是 node 22，开发机是 node 24。node 20/22 的 test runner **自己不持句柄**：用例 `await` 的 promise 若只靠 unref 过的 timer/子进程存活（`spawnDetachedText` 就是故意的——启动器不该吊住 daemon），事件循环一见底，runner 就报 `Promise resolution is still pending but the event loop has already resolved`，并以 `cancelledByParent` **取消该文件后面的所有用例**。现象是「日志停在某条用例、既没有失败堆栈也没有超时」。修法是这类文件在顶层持一个**被引用**的 timer、`after()` 里清掉（`test/redirector.test.mjs` 的 `keepLoopAlive`）。**不要用 `--test-force-exit` 掩盖**：2026-11-11 试过（commit 4b29490）又撤回（d3fd836）——它把「真挂住」和「假挂住」一起吞掉，还让失败变成 cancelled。

- **测试不碰真机**（2026-11-11 起，见 §2.40）：慢与 flaky 的根因不是并发，而是用例真的去问 Windows（冷 PowerShell 探针 ≈8 s、`Set-Service`、`taskkill` 停掉用户桥接）。四处注入缝，新用例必须沿用，不要再 spawn 这些命令：
  - `lib/startup.js` 的 `reconcileStartupLeftovers({ cwd, log, ownPid, status, restore })`：`status`/`restore` 可注入（默认仍是真实现）；
  - `lib/redirector.js` 的 `probesStubbed()`：环境变量 `DSH_RIS_IDE_STUB_PROBES=1` 时探测直接返回空（`test/risd-helpers.mjs` 的 `isolated` 已默认设置，daemon 子进程也因此干净）；
  - `lib/index.js` 的 `__test.setWindowsProgramProbe(() => [...])`：Windows 程序列表（`windowsProgramNames()`）的注入点；
  - `test/proxy-route.test.mjs` 顶部的 `redirectorTest.setProbeHooks(PROBE_HOOKS)`：进程内的 pids/alive/taskkill 桩（到不了子进程，所以与上一条互补）。
  - `lib/redirector.js` 的 `__test.setWindowsPathTranslator(fn)` 与 `redirectorCommand({ translate: true })`：**CI 是纯 Linux（k8s pod），没有 WSL、没有 `wslpath`、没有 Windows 侧**，所以「Linux 路径的 Windows 拼写」在那台机器上算不出来。非 WSL 主机上 `test/redirector.test.mjs` 注入这个映射来断言看门狗脚本/命令行内容，`translate: true` 直接声明「被测的是翻译规则，不是本机有没有 Windows 侧」；生产代码不设这个缝、仍然问 `wslpath`。写新用例时**不要**再默认「本机是 WSL」（2026-11-11 因此红了三条 CI 用例）。
- **夹具只写一份**：daemon/端口/HTTP/fake req-res 用 `test/risd-helpers.mjs`（`pickPort`/`writeEngineFixture`/`risdHeaders`/`waitFor`/`pidAlive`/`fakeReq`/`fakeRes`/`risdBridge`/`api`）；tar/gzip 打包与 fetch 桩用 `test/helpers/tgz.mjs`。文件里再抄一份就是债。
- **测试不硬依赖外部程序（2026-11-11）**：CI 是裸镜像，连 `git`/`bash` 都未必有。用例只在 node 自带能力上跑；确实要跑外部命令的用例用 `test/helpers/cmd.mjs` 的 `hasCommand()`/`HAS_GIT`/`HAS_BASH`/`HAS_WSLPATH`/`skipWithout()` 声明 `{ skip: skipWithout(HAS_GIT, 'git') }`——**缺命令就 skip（带原因），不 fail，也不弱化断言**。`sleep` 这类纯等待不要 spawn：用 `process.execPath` 起 `setTimeout`（`test/host-tail.test.mjs` 的 pidfile 用例）。`javac/java` 同理（`test/debug-engine.test.mjs`）。全套**不 spawn `dsh`**，所以 CI 没有 dsh 也能跑。
- **每条用例有 120 s 上限**（`--test-timeout=120000`）：`node --test` 遇到泄漏的子进程/真套接字会无限等（日志停住、既无失败也无超时），流水线只能靠 20 分钟 `timeout` 兜底；加上这条后挂住的用例会**带名字失败**（`testTimeoutFailure`），能直接定位。它不掩盖问题：正常的用例最慢也就个别 grace 等待（≈3-4 s）。
- **不为了「快」合文件**：`node --test` 以**文件**为并行单位，合并文件只会把它们串行化。删/并的是**用例**（重复命题、已被行为覆盖的源码守卫），不是文件。默认并发已能 21.8 s 跑完（旧提示 `--test-concurrency=4` 已不再需要）。

### 2.33 2026-11-09 22:2x m12606 / m12782 / m12840 提权启动（sudo -n → 终端 → 命令）

- **为什么不是 web 里问密码**：`sudo` 从 HTTP 路由里读不到 TTY，问密码只会挂住请求；而 daemon 自己以 uid 1000 跑，`hasElevation()` 为假时只能降级。所以按钮把「提权」做成三次尝试：`sudo -n true` 成功就直接以 root 起 CLI（`method:'sudo'`）；否则有 `pkexec` 就 detached 起 `pkexec <cli> --profile …`（有图形 agent 才有用，2.5 s 内进程还活着就算接上）；再不行就**打开终端**把命令交给用户输密码（`method:'terminal'`，`deferred:true`），最后才是只显示命令（`method:'manual'`）。
- **窗口大小与位置（m12951 / m13083 / m13147 / m13257）**：`wt.exe --size 64,16 …` 把窗口开小；`-f`（focus 模式）会最大化，所以不再用。居中由 helper **自己启动** WT 完成：`launchCenteredTerminal()` 写 `<proxy home>/center-terminal.ps1`，脚本先记下已存在的 CASCADIA 窗口句柄，`Start-Process wt.exe` 后用「多出来的那个窗口」的真实 rect 和主屏 work area 调 `MoveWindow` 居中（argv 以 base64 JSON 跨 WSL 传递，脚本路径永不被拆开）。**不能用标题/进程找窗口**：WT 把每个窗口都放在同一个 `WindowsTerminal` 进程里，`MainWindowHandle` 和 `--title` 都会指错（m13221 实测新窗口歪、m13257 用户指出 wsl.exe 才是对的那个窗口 ⇒ 改为句柄差集）。**置顶做不到**：窗口由 WSL 里的后台进程拉起，Windows 前台锁不允许它抢焦点，`SetForegroundWindow`/`AppActivate` 都不可靠，已放弃（用户 m13137 确认）。
- **说明里也写清怎么提权（m13277）**：缺拦截的那一侧，`说明` 的第一行现在写「X 侧系统层拦截需要 root：点「提权启动」弹终端输密码，或自行打开终端执行：<命令>」，把按钮和命令放在同一句里。
- **helper 的脚本路径必须转成 Windows 路径（m13375）**：`-File` 收的是 `/home/...` 时 Windows PowerShell 打不开、静默失败（窗口不弹、`skipped` 仍然报 `method:'terminal'`）——用 `windowsPathOf()`（会走 `wslpath -w` 得到 `\\wsl.localhost\…`）而不是 `posixToWindowsPath()`（只转 `/mnt/<盘>`）。argv 里带空格的项在 `Start-Process` 前包引号（调试时 `sleep 6` 被拆成两个参数，窗口里报 `sleep: missing operand`）。
- **说明字号小一号（m13375）**：`#bridge-health-more`/`#bridge-health-detail` 用 13px（正文 14px），展开后更紧凑。
- **提示在组件卡、窗口关了自动消失（m12923）**：点击后不再往规则表 banner 写「已打开终端窗口…」，而是组件卡里的一行黄条（`#bridge-elevate-note`，复用 `banner()` 样式）；脚本把 `{side,pid,at}` 写进 `<proxy home>/elevate-<side>.json` 并 `trap 'rm -f …' EXIT`，`GET /v1/proxybridge/health` 返回 `elevations`（`readElevationState()` 判文件在不在 + pid 活不活）；页面每 10 s 复查，窗口一关（或该侧已开始拦截）黄条就消失。
- **终端候选**：`wt.exe wsl.exe -e bash -lc <script>`（WSLg 默认有这个）、`x-terminal-emulator`/`gnome-terminal`/`konsole`/`xfce4-terminal`/`mate-terminal`/`xterm`（`-e` 或 `--` 起 `bash -lc`）。非 WSL 的桌面 Linux 走这几个 X11/Wayland 客户端；**没有图形会话**（`DISPLAY`/`WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` 都没有）时跳过它们，直接给命令——headless 机器上 `xterm` 在 PATH 里不代表有窗口可开（m12884）。命令先写进 `<proxy home>/elevate-<side>.sh`（755）再让终端跑脚本：终端 argv 只有一个路径，引号问题最小，用户也能在那个窗口里看见完整命令。
- **Windows Terminal 的参数顺序**：`wt.exe` 把**第一个非选项 token** 当命令行；写成 `wt.exe -e …` 会让 WT 把 `-e` 当自己的选项并弹「错误窗：-e 参数不对」（m12840）。正确形式是 `wt.exe wsl.exe -e bash -lc <script>`。
- **输完密码窗口自动关**（m12896）：脚本先在前台 `sudo -v`（密码就在这个 TTY 里问，缓存 ticket），拿到后用 `nohup sudo -n <cli> … > elevate-<side>.log 2>&1 &` 把 CLI 脱离，打印日志路径后 `sleep 1` 退出 ⇒ 终端窗口自己关，拦截继续跑（CLI 不能随窗口死，它自己就是拦截进程）。日志落在 `<proxy home>/elevate-<side>.log`；副作用同下：root 起的进程不写我们的 pidfile，面板「停止」杀不掉。
- **页面侧**：组件卡片一行状态旁加「提权启动」（引擎运行、且存在 applicable 而没在拦截的侧时才出现）；点了置「提权中…」，`POST /v1/action {action:'start'}` 后按 `result.redirector.started/skipped` 出绿条/黄条，再刷新卡片。两个坑都踩过：`banner()` 只返回 HTML 字符串（要写 `el('proxy-banner').innerHTML = banner(...)`）；而 `loadProxyTab()` 会重绘 banner 容器 ⇒ 提示必须等它 settle 之后再写，否则刚写就被清空。`api('/v1/action')` 的回包是 `{ok, action, result}`，payload 在 `response.result` 里。
- **测试**：`test/risd-ui.test.mjs`（按钮存在、`function elevateBridge`、接线、`response.result`）；`test/redirector.test.mjs` 源码守卫（`pkexecAvailable`、`spawn('pkexec', …)`、`method: 'pkexec'|'terminal'|'manual'`、`TERMINAL_CANDIDATES`、`openElevatedTerminal`）。`risd-ui`+`redirector` 55/55。
- **边界**：终端里以 root 起的 CLI 不写我们的 pidfile ⇒ daemon 的「停止」杀不掉它（需要 `sudo kill`），这是把密码交给人的代价；提示里已说明「这个窗口可以关闭」，窗口关掉 CLI 仍在跑，健康行会显示「拦截运行中」。

### 2.37 2026-11-10 14:4x–16:4x m13800 / m13910 / m13920 / m13950 / m13960（工作区标题同步 + 跟随 dsh 的启动半边 + 保存不启动 + 单按钮 + 生命周期即选即存）

五段需求合成一轮 UI/daemon 改造。用户原话：m00001「开发环境界面-工作区面板，能否同步 dsh 的左侧工作区（考虑改名的情况，路径是不会变的）」；m00689「1. 自动启动永不提权。手点启动按钮或提权按钮，都可以弹提权 2. 按钮合并，放组件区。 3. 加个自动启动的配置，启动 dsh 自动启动引擎」；m00911「若引擎未启动，改配置不再自动启动。」；m00955「自动启动配置有问题。不应该加，而是按照生命周期来。生命周期跟随 dsh，则 dsh 启动，对应程序也启动，dsh 停，也跟着停」；m01125「不要保存按钮」（m01115「生命周期勾选自动保存」）。

**1）工作区面板同步 dsh 侧栏（m13800）**

- 数据通路选 `dsh-window.json` 扩文档：`{windows:[{url,sessionId,cwd,title,ownerPid,at}], workspaces:[{cwd,title,sessionId}], url, at}`。插件是唯一写者、risd 已在读这个文件、旧 daemon 忽略未知键 ⇒ 不必新增宿主路由，也不会出现两个写者。
- 插件取标题：`ctx.get('workspaceRegistry', false)`（不进 inject，旧 dsh 没这服务也能加载）→ `registry.list()` 的实体（`path`/`title`/`sessionIds`；`setTitle` 只改 title，path 永不变），路径按 `realpathSync.native` 规范化后比较；每个工作区的 sessionId 取 `liveSessionFor(ctx, path)`（精确 cwd 优先、祖先次之）→ 实体 `sessionIds` 末项 → `''`。
- 刷新：`refreshDshWindows` 每 10 s 重取标题，变化即重写整份文档 ⇒ 改名最多 10 s 到页面，不用点任何按钮。
- `/v1/dsh`：侧栏快照只在写作时间落在 7 天保留期内时采用（dsh 停了就退回只列窗口行），顺序=侧栏顺序；按 cwd 匹配窗口行并继承 url/sessionId/live，未匹配行 `source:'workspace'`、live 且用文档级 url；未被侧栏覆盖的窗口行追加在后。
- 面板标签：`workspaceLabel(win, windows)` 优先 `win.title`，空则退回 `workspacePathLabel`（目录名、重名带父目录）；`dshWindowSignature` 把 title 纳入签名，5 s 轮询即可重绘。

**2）「跟随 dsh」补齐启动半边（m13950，取代 m13910 的临时开关）**

- 不做单独的「启动 dsh 时自动启动引擎」开关（先加过 `proxy.startWithDsh`，用户否决）：启动与拆除都读 `lifecycle.proxy.followDsh`，同一个键不可能出现「启动跟着开、停止却没跟」的错位。旧实现只有拆除半边。
- 启动半边**挂在租约上**（与拆除同一个信号）：`POST /v1/leases` 成功、`followDsh` 为真且引擎没跑时，`setImmediate` 里跑 `followStartForLease(lease.cwd)`——引擎已在跑就跳过；`buildProfile().rules.length===0` 就跳过（跟随是策略，不是起进程的理由）；否则 `startProxy + startRedirectors({interactive:false}) + syncGitProxy`，成功后清 `bridgeReloadState`。**永不 interactive**：dsh 接入的副作用不许弹密码框，需要 root 的桥接只在组件卡里提示。有 `followStarting` 门闩，并发取租约只启动一次；这个门闩保存的是**进行中的 Promise**，`scheduleTeardown` 会先 `await` 它再决定拆什么——否则「租约刚触发启动、随即离开」时拆除侧读到 `engineCwd === null` 就跳过 `stopProxy`，留下一个没人认领的引擎（真机验证时踩到过）。启动前还会重查 `leases.count() === 0`（`skipped no-lease`），避免给已经关掉窗口的空跑一个引擎。
- 插件侧**不需要额外调用**：`attachBridgeState` 取的租约就是启动信号；插件早先那版 `followStartRisd`（以及 `/v1/follow-start` 路由）已删除，避免第二条链路与租约各说各话。
- 生命周期页文案同步：「跟随 dsh：dsh 接入时启动引擎，没有 dsh 租约时拆除隧道（含系统层拦截）；拦截需要 root 时不会自动弹窗」。

**3）保存规则不再启动引擎（m13920）**

- 删 `maybeStartProxy`/`hasActionableRule`：保存只写表；引擎在跑就由 `switchEnforcement` 在后台重载拦截，引擎没跑就在横幅写明「引擎未启动（保存不会启动它，点「启动」或组件区的「启动系统层拦截」）」。
- `POST /v1/proxy` 的 `reloadNote` 分流：桥在跑 → 「系统层拦截正在后台按新规则重启」；没跑 → 「引擎未启动，保存不会启动它」，不再谎报一次不会发生的重启。

**4）组件区单按钮（m13910）**

- 「提权启动」（组件卡）与「重启系统层拦截」（规则表）合并为组件卡里的 `#bridge-fix`：重载失败（stale）时文案「重启系统层拦截（可能提权）」、动作 `redirector-restart`；只缺拦截时「启动系统层拦截（可能提权）」、动作 `start`；两者都成立时 stale 优先（重启本来就会先停）。`paintBridgeFix()` 是唯一显隐点（`engineRunning && !stray && (stale || missing)`），忙碌时显示 启动中…/重启中…。
- 只有点击带 `interactive:true`（`/v1/action` 的 `parsed.interactive === true`，插件 `body.interactive === true` 透传）；自动路径一律不带。启动成功清 `bridgeReloadState`，按钮不再常驻到下次保存。
- 「启动」/「停止」引擎按钮仍是显式动作，`start` 同样带 `interactive:true`。

**5）生命周期勾选即保存（m13960）**

- 删掉「保存生命周期」按钮：勾选就是一次配置修改，300 ms 防抖合并连点后 `POST /v1/config`；没有按钮，也不再需要「保存」这一步。
- 请求在飞时只记一个 `lifecycleQueued`，结束后再存一次，避免两个 POST 互相覆盖；失败时保留 `lifecycleDirty` 并提示「再勾一次重试」，4 s 刷新不会把用户刚勾的框弹回去。

**测试**：新增 `test/risd-follow-start.test.mjs`（真 daemon：默认 followDsh 下取租约且空规则 → 引擎仍是 `stopped`；关掉 followDsh 后取租约同样不启动；静态守卫「启动半边挂在租约上并读同一个键」「非交互」「没有第二条入口/插件调用」「拆除读同一个键」；以及「保存不 spawn 引擎」）。同步改 `test/risd-ui.test.mjs`（bridge-fix/`paintBridgeFix`/`interactive:true`、无 bridge-restart/无 auto-start 复选框、生命周期文案）、`test/risd-lifecycle.test.mjs`（只剩 followDsh；`startWithDsh` 现在按未知键 400）、`test/proxy-restart.test.mjs`、`test/risd-api.test.mjs`、`test/client-viewer.test.mjs`（本地回退 `startRedirectors({interactive})`）。全量 778 条：777 过，`startup-reconcile` 的「parked ProxyBridgeSvc」在并发负载下超时（单跑 6/6 通过，Windows PowerShell 探测慢，非回归）。

**边界**：`workspaces` 快照的标题来自 dsh 进程内存里的 registry，dsh 挂了页面就退回窗口行（不缓存旧标题冒充现状）；租约的 `cwd` 只用于 git 规则与引擎归属，缺省 daemon home。

### 2.45 2026-11-12 18:2x–18:5x m04873（控制台与 IDE 各自跟随自己的工作区）

- 报告：dsh 侧栏控制台与 risd 维护页里嵌的 IDE，工作区互相“传染”——
  在 risd 页把 IDE 切到 B，dsh 侧栏的控制台也跟着变成 B；反过来 dsh 切工作区，已打开的 IDE
  里的控制台/日志也跟过去。要求：两边各跟各的工作区，不联动。
- 根因是**同一个 origin 只有一份“上次用过的 workspace”**：`dsh-ris-ide:last-cwd`
  （`rememberWorkspaceCwd`）。dsh 页面与 risd 页里嵌的 IDE 文档都在 `127.0.0.1:3080` 这个 origin 下，
  任何一方请求完 `/programs` 都会写这个槽；而侧栏面板在自己 session 的 store 里查不到 cwd 时
  （keepMounted 的旧 session、独立窗口页没有 `useSessions`）**把它当成自己的 workspace**，
  于是刚被另一方写进去的 B 就出现在自己面板里。
- 修法（`lib/client.js`）：
  - 新增**按 session 记的** workspace：`rememberSessionCwd(value, sessionId)` /
    `knownSessionCwd(sessionId)`（localStorage `dsh-ris-ide:cwd:<sessionId>`）。
    `last-cwd` 只在“打开窗口时没给 workspace”这类与 session 无关的场合继续用。
  - `ProgramsPanel` 里区分“确知”和“猜测”：只有 session store 或本 session 的记忆能给出
    `cwdKnown === true`；猜测值**不再**发给宿主（`if (cwdKnown === true) url.searchParams.set('cwd', …)`），
    由宿主的 `resolveCwd` 按 session header 定——猜测值正是把一个面板拖到另一个工作区的那条路。
  - `LogTail` 同样先查 `knownSessionCwd(sessionId)`；无 session 时才用 origin 级的槽。
  - 独立窗口 `StandaloneWindow` 的 `hello` 采纳逻辑加栅栏：`payload.root !== props.cwd` 时拒绝
    跟随（窗口钉在自己 URL 的工作区上）。
- 修法（`lib/risd/ui.js`）：新增 `pickIdeWindow(windows)` 与 `selectIdeWindow` 的兜底行——
  记住的 workspace 不在 dsh 镜像里时**保留它**（合成 `{cwd, live:false}`），不再回落到
  `windows[0]`，即 dsh 切工作区不会换掉这里已打开的 IDE 文档（iframe src 不变，未保存内容不丢）。
- 测试：`test/client-viewer.test.mjs` 新增 `each session remembers ITS workspace; the origin-wide slot
  stays separate (m04873)`（session 键互不覆盖、垃圾输入不落地）与 `a panel never steers the host with
  a GUESSED workspace (m04873)`（源码守卫：`cwdKnown` 才带 cwd、`rememberSessionCwd(payload.root, sessionId)`、
  独立窗口 root 栅栏、`LogTail` 走 session 记忆）；`test/risd-ui.test.mjs` 新增
  `the IDE pane keeps its own workspace when dsh switches (m04873)`。全量 **803 tests / 757 pass / 0 fail / 46 skip**。
- 部署：`lib/client.js` 刷新窗口即生效；`lib/risd/ui.js` 由 risd daemon 自己加载，**重启 daemon 后**这一半才生效。

### 2.44 2026-11-12 11:1x–11:5x m03945（程序行的 🌐：在系统浏览器里打开页面，yds 项目自动免登录）

- 需求：前端程序启动后要一个按钮直接打开浏览器；并希望自动注入参数/header（yds 项目注入 YYCToken 免登录）。
- 浏览器侧的限制决定了分层：一个页面**无法**给它打开的标签页加请求头（那是浏览器进程的权限），
  所以按钮只负责「问宿主拿地址并 `window.open`」，token 的事交给能改写页面的那一层。
- 宿主（`lib/index.js`）新增 `OPEN_TARGET_PATH = /dsh-ris-ide/open-target`（仅 GET、仅 loopback、
  必须 sessionId）→ `serveOpenTarget`：先 `findProgramById`（配置先行，缺了就轻扫一遍），
  再用既有的 `logUrl(program.logPath)` 从程序日志里取 dev server 地址（webpack/vite 都会打印
  `Local: http://localhost:<端口>`）；没有就回 `{ok:false, code:'no-url', message:'…先启动它…'}`，
  绝不编造地址。拿到地址后 `askYdsToWrap` 以 5s 超时 POST 同源 `/dsh-ris-yds/open`
  （body `{workspace, devUrl}`）；404/异常 ⇒ `null` ⇒ 回落裸地址，**所以没装 dsh-ris-yds 也能用**。
- `logUrl` 只认**本机**地址（2026-11-12 18:5x 补）：原先正则写死 `localhost`，而 MDF 脚手架打印的是
  `Node服务地址：http://<HOST地址>:3003`（旁边还有 `Java服务地址：https://srmdev…`），于是 🌐 永远回
  `no-url`。现在先剥 ANSI 颜色码，再匹配 `localhost|127.0.0.1|0.0.0.0|[::1]|[::]|<占位符>` 这几种 host，
  并把通配/占位 host 归一成 `127.0.0.1`（浏览器要拨具体回环地址）；只取最后一个匹配且只认本机，
  避免把同一行的网关 URL 当成 dev server。测试 `a dev-server URL is read from local hosts,
  placeholders and ANSI logs (m03945)` 覆盖这五类日志行。
- 客户端（`lib/client.js`）：模块级 `requestOpenTarget(program, scope)`；面板新增 `busySiteId`
  与 `openSite(program)`（失败/弹窗被拦都进面板 note 条）；侧栏行与全量面板行**都**加
  `data-action:'open-site'` 的 🌐（`event.stopPropagation()`，否则点按钮会顺带切换日志）。
- 与 dsh-ris-yds 的分工：yds 决定「怎么在浏览器里拿到带 token 的页面」（本地注入代理 +
  `YYCToken` + cookie 回放，见其 DEVELOPMENT.md §19）；ris-ide 只提供入口与候选地址。
- 测试：`test/host-tail.test.mjs`「the open-target route resolves a program by id and never invents
  a URL (m03945)」（fixture 里没日志 ⇒ `code:'no-url'`；未知 id 404；缺 sessionId 400；POST 405）；
  `test/client-viewer.test.mjs`「every program row offers the browser button…」两条渲染器都断言到。
- 部署边界：宿主路由要重启 dsh 才生效；按钮本身（client bundle）刷新页面即可。

- **m04354 按钮只属于前端行，token 措辞只属于 yds 项目。** 用户实测发现三处不对：后端（`kind:'spring'`）
  程序根本没有页面可开却也有 🌐；按钮 title 写着「yds 项目会自动注入 YYCToken」，在普通工作区里是假话。
  现在两处渲染器都按 `program.kind === 'frontend'` 出按钮（侧栏行 `startable && program.kind === 'frontend'`，
  全量行三元 `program.kind === 'frontend' ? … : null`）；title 固定为「在系统浏览器打开 <name> 的页面」，
  只有 `ydsProject === true` 时追加「（yds 项目：请求自动带上登录 token，免登录）」。
  `ydsProject` 由客户端 `requestYdsProject(scope)` 问同源 `GET /dsh-ris-yds/probe?workspace=`（yds 侧
  `probeWorkspace` 只读 `.vscode/settings.json` 找 `yds.*`，不解析端口、不启动任何东西；404/异常一律
  false）⇒ **没装 yds 或工作区不是 yds 项目时，页面里不会出现任何 yds 字样**。守卫测试在
  `test/client-viewer.test.mjs`「only a FRONTEND row offers the browser button…」。
### 2.43 2026-11-12 10:3x–11:0x m03397 / m03429（生命周期两个半边 / SOCKS 校验真的转发一次）

**m03397 生命周期配置增加两个半边。** 原来四类资源各一个 `followDsh`，把「dsh 接入时启动」与「dsh 离开时停止」
压在一个开关上；用户要求在每行分别配置，且「跟随 daemon 是强制兜底的，不需说明」（页面不再重复那句解释）。

- `lib/risd/lifecycle.js`：schema 变 `daemon{startWithDsh(强制 true),stopWithDsh}`、`proxy{startWithDsh,stopWithDsh}`、
  `programs{startWithDsh,stopWithDsh}`、`debug{stopWithDsh}`。旧文件的 `followDsh` 迁移成两半（true→两半 true），
  同一 payload 里显式半边优先；`daemon.startWithDsh=false` 报「daemon.startWithDsh 不可配置：dsh 需要时按需拉起
  守护进程（强制）」；`debug.startWithDsh` 报「不是可配置项（只能配置 stopWithDsh）」；`followDaemon` 仍 400。
- `lib/risd/server.js`：六处读取点改新键（`debug/programs/proxy.stopWithDsh`、`daemon.stopWithDsh`、
  `proxy.startWithDsh` ×2）。**程序启动半边**新增：每次程序动作成功后 `saveProgramsSnapshot()` 把
  `running.alive===true` 的行（`{cwd,id,dir}`）原子写 `<home>/risd-programs-last.json`；第一份租约到达时
  `restoreProgramsForLease()`（每个 daemon 实例只跑一次）读快照、串行 `startProgramByKey`，已活着的跳过，失败
  留给页面。写快照走串行队列，避免「stop 记录到一半就被 restore 读走」而复活程序。
- `lib/risd/ui.js`：四行 × 两列 `input[data-life]`，表头「跟随 dsh 启动 / 跟随 dsh 停止」；daemon 启动列
  `checked disabled`，debug 启动列 `disabled` + title「调试会话没有可自动启动的对象」；`.life-col{width:132px}`；
  `lifecycleFromBoxes()` 跳过 `disabled` 的半边（否则强制的/不存在的半边会进 payload 被服务端拒绝）。
- 测试：`test/risd-lifecycle.test.mjs` 重写为两半边口径（默认值、`followDsh` 迁移、显式半边优先、强制/不存在
  半边各自的报错、merge、原子写、HTTP 回读与 400）+ 两条程序恢复用例（有快照 + `programs.startWithDsh=true`
  → 第一份租约把程序拉起；策略默认关 → 什么都不启动）。`test/risd-ui.test.mjs` 断言两列、disabled、无旧说明句、
  以及 `if (box.disabled === true) return;` 守卫。`test/risd-follow-start.test.mjs`、`test/risd-api.test.mjs` 同步新键。
  结果：`risd-lifecycle` 13/13、`risd-ui` 36/36、`risd-follow-start` + `risd-api` + `risd-bridge-degrade` 24/24。

**m03429 SOCKS 主机校验从「端口有 SOCKS5 服务」变成「真能转发一次」。** 原来 `GET /v1/proxy/ping` 只做 SOCKS5
greeting（回 `05 00` 就算通），而 greeting 通过不等于能 CONNECT——服务器可能对每个 CONNECT 回 `rep≠0`，或者在
握手后挂住。现在：

- `lib/risd/ping.js` 新增 `probeTarget(config)`：优先取 `shadows[0]`（本来就是一个具体目的地），否则取第一条
  `enabled` 且 hosts/ports 模式里有**不带通配**组合的规则；都没有 → `null`。
- `pingSocks({host,port,target})`：greeting 通过后对目标发真实 CONNECT（IPv4 用 ATYP=1、主机名用 ATYP=3，
  socks5h 语义）；`rep===0` → `usable:true`；`rep!==0` → `usable:false` + 「SOCKS5 握手正常，但无法转发到
  host:port（规则不允许该连接/连接被拒绝/…）」，`REPLY_TEXT` 覆盖 rep 1-8；无目标 → `usable:null` + 「握手正常」，
  不编造结论。超时/提前关闭按阶段（greeting vs connect）给不同文案。
- `lib/risd/server.js` `/v1/proxy/ping` 读代理配置并把 `probeTarget()` 传进去；`lib/risd/ui.js` 的 chip 分四态：
  `可用 N ms`（on）/ `握手正常`（on）/ `无法转发`、`需认证`（warn）/ `无法连接`（err），title 写清「代理服务器可用
  （host:port → targetHost:targetPort）」或「配置里没有可验证的转发目标，只确认了协议」。
- 测试：`test/risd-ping.test.mjs` 新增 4 条（两阶段假 SOCKS 服务器）。`ping` 10/10、`risd-api`+`risd-ui`+`risd-ping`
  65/65。

**部署边界**：本机（含 daemon 进程）仍是旧码，需要重装 `lib/risd/{lifecycle,ping,server,ui}.js` 并重启 risd daemon
才生效；页面内联脚本随 `/ui` 立即生效。

**m03761 探针降噪（`sudo -n true` 的失败结果缓存）。** dsh 若由 Windows 侧 `wsl.exe` 启动，进程 cwd 就是
`C:\WINDOWS\system32`，所有子进程继承；risd 协调器每 60 s 重试一次后台启动，走到「没有免密 sudo」这个
分支时每次都会 `spawnSync('sudo', ['-n','true'])`，于是 journal 每分钟多一条 `a password is required ;
PWD=/mnt/c/WINDOWS/system32 ; USER=root ; COMMAND=/usr/bin/true`（sudo 对成功和失败**都**会写审计行）。
现在 `lib/redirector.js` 的 `sudoPasswordless(options)` 把答案缓存 `SUDO_PROBE_TTL_MS = 5 * 60 * 1000`：
后台尝试（`interactive !== true`）在 TTL 内复用上次答案，用户显式点提权（`interactive === true`）永远现问一次
（用户可能刚配好 NOPASSWD）；探测的 `cwd` 固定为 `homedir()`，审计行不再带 `/mnt/c/WINDOWS/system32`。
`__test.resetSudoProbe()` 给测试清缓存；`test/redirector.test.mjs` 用 PATH 上的假 `sudo` 计数（注意用
`printf '[%s]\n' "$*"`，`echo "$@"` 会被首参 `-n` 当成「不换行」而把多次调用拼成一行）。

### 2.42 2026-11-12 10:2x–10:4x m03193 / m03291（git 被一次失败永久拉黑 / 去掉「配置已与工作区同步」提示）

**m03193「ide不识别git。无法过滤文件树」——根因是模块级 `gitMissing` 布尔锁存，不是 git 本身。**
- 现象取证（对运行中的 dsh，端口 3080）：`/dsh-ris-ide/tree` 对工作区根、其下仓库、另一个并列工作区全部返回 `git:false, filtered:false`，且 `.git`、`node_modules`、被 `.gitignore` 忽略的 `.tgz` 都出现在列表里；同一批参数在**新进程**里 `listIdeTree` 返回 `git:true, filtered:true`（18 条 vs 23 条）。同进程的 `/dsh-ris-ide/search` 却仍然走 `git ls-files`（返回 116 = `git ls-files --cached --others --exclude-standard | wc -l`；走 `listRawFiles` 回退会是 120，且 `.dsh-ris-ide/config.json` 会被列出）——说明 **git 二进制可用**，只是 tree 侧被一个进程内状态判成「没有 git」。
- 机制：旧代码 `let gitMissing = false`，在任何一次 `spawn('git', …, { cwd })` 报 ENOENT 时永久置 true。而 node 对「可执行文件不存在」和「**cwd 已被删除**」的报错完全一样（`code/errno === ENOENT/-2`、`error.path === 'git'`、`syscall === 'spawn git'`，实测两种情形逐字段相同）。插件本来就在用户正在操作的文件树目录里跑 git，于是一次「在树里删掉某个目录，随后该目录上的 `git ls-files`/`check-ignore` 失败」就把整个进程的 git 关死：之后所有工作区 `git:false`（过滤开关变灰、`.gitignore` 过滤关闭），直到重启 dsh——正是用户看到的「不识别 git、无法过滤文件树」。
- 修法（`lib/index.js`）：布尔锁存换成**隔离期**。`gitMissingUntil` + `GIT_MISSING_TTL_MS = 60_000`、`gitUnavailable()`；ENOENT 时调用 `noteGitSpawnFailure()`——先用 `tmpdir()`（一定存在的 cwd）跑 `spawnSync('git', ['--version'])` 复核，只有复核也失败才隔离 60 s（到期自动重试）；任何一次成功的 git 命令调用 `noteGitSuccess()` 立刻解除隔离。所有原 `gitMissing` 读取点（内容搜索、文件名搜索、流式搜索、`repoAllowedPaths`、`listIdeTree` 的 `git:` 字段）改走 `gitUnavailable()`。
- 语义保持不变：真正没有 git 的机器仍然是「文件系统即白名单」的降级（`.git`、`.gitignore` 过滤关闭，列表回退 walk）；唯一区别是失败不再是终身判决，也不会被一个已删除的目录误伤。
- 测试：`test/host-tail.test.mjs` 新增「a git spawn failed by a deleted cwd does not disable git for the process (m03193)」——git 在时 `noteGitSpawnFailure()` 不隔离；`PATH=/definitely/not/here` 时确认缺失并隔离；`noteGitSuccess()` 立即解除。

**m03291「底部信息『配置已与工作区同步…』叉不掉，不要显示」——直接不显示这条。**
- 根因两层：①`programsPayload()` 每次轮询发现漂移都会自动写一次配置并回 `status:'updated'`，于是这条提示在切工作区后反复出现；②它由面板渲染，而 DSH 侧栏会同时挂载两份 `[data-sidebar-right-panel="push"]`（一份隐藏的 `keepMounted` 副本），✕ 只关掉被点的那份时另一份照样显示——`useDismissedNotices()` 上一轮已改成模块级共享表，但对「纯噪声」的提示而言，正确的修法是不显示。
- 改法（`lib/client.js`）：`configNoticeItems()` 不再为 `status === 'updated'` 产出条目；compact 面板里那块硬编码的 `config-updated` `ClosableNotice` 一并删除。保留两条有行动价值的提示：`generated`（首次自动生成配置）与 `drift`（配置与工作区不一致，附带「点更新配置」）。
- 测试：`test/client-viewer.test.mjs` 新增静态守卫（`lib/client.js` 不含该文案与 `'config-updated'`；`kind: 'drift'`、`kind: 'config-generated'` 仍在）。全量 790 条：744 过、0 失败、46 条跳过（缺 React SSR）。

**部署边界**：`lib/client.js` 装进安装副本后刷新 IDE 窗口即生效；`lib/index.js` 的 git 隔离修复要**重启 dsh** 才生效（重启前旧进程里的锁存仍然存在，用户仍会看到「不识别 git」）。

### 2.41 2026-11-11 11:2x–12:4x Jenkins 只红在 CI 的测试失败（node 22 事件循环 / 外部程序依赖 / 每条用例超时）

用户口径：「jenkins没有dsh，依赖dsh的测试就应该略过，或者说测试本身不就能依赖外部程序」。三次 CI 失败、两次本机全绿，逐层挖到两条根因 + 一道保险。

**① `--test-force-exit` 是错的解法（试过又撤回）**。CI 症状是「日志停在某条用例、没有失败信息」。我一度在 `npm test` 加 `--test-force-exit`（commit 4b29490），CI 变成跑完但报一批 `'Promise resolution is still pending but the event loop has already resolved'`。它把「真挂住」和「假挂住」一起吞掉，失败信息变成 cancelled —— 撤回（d3fd836）。

**② 真因：node 版本，不是 flag、也不是 WSL**。CI pod 是 node 22，开发机是 node 24。
- 复现：`/tmp/node-v22.14.0-linux-x64`（官方 tarball）+ 纯 Linux 模拟（`engineSide()` 强制 `linux`、`/tmp/fakebin/wslpath` 退出 127）→ `test/redirector.test.mjs` **7 条 `cancelledByParent`**，用例名与顺序和 CI 日志逐条对上；同一份代码 node 24 全绿。
- 机制：`spawnDetachedText` **故意** `timer.unref()` + `child.unref()`（启动器不该吊住 daemon，生产正确）。node 20/22 的 test runner **自己不持句柄**：用例 `await` 这个 promise 时事件循环见底，runner 报「promise 还在等、loop 已结束」，并把该文件**后续所有用例** `cancelledByParent` 取消。node 24 的 runner 自己保持引用，所以本机测不出来。
- 修法（只碰测试）：`test/redirector.test.mjs` 顶层持一个**被引用**的 timer（`keepLoopAlive`），`after(() => clearInterval(keepLoopAlive))` 释放。

**③ 外部程序依赖：缺了就 skip，不 fail**。CI 是裸镜像，`git`/`bash` 都未必有；`sleep` 完全没必要。
- 新增 `test/helpers/cmd.mjs`：`hasCommand()` / `HAS_GIT` / `HAS_BASH` / `HAS_WSLPATH` / `skipWithout(available, label)`。受影响用例改成 `test('…', { skip: skipWithout(HAS_GIT, 'git') }, …)`；模块级夹具里调 git 的用 `if (HAS_GIT) { … }` 包住。skip 带原因（`﹣ <用例> # git is not installed`），断言语义不动。
- `test/host-tail.test.mjs` 的两处 `spawn('sleep', ['30'])` 换成 `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])`，`sleep` 依赖消失。
- 全套**不 spawn `dsh`**（grep 证实），CI 没有 dsh 不影响；`bin/run-with-log.sh` 需要 bash，相关用例按 `HAS_BASH` skip（脚本本身那些 `sleep/tee/date` 是对被测对象的输入，保留）。

**④ 保险：每条用例 120 s 上限**。`package.json` 的 test 改为 `node --test --test-timeout=120000 "test/*.test.mjs"`。挂住的用例从「日志停住」变成**带名字失败**（`testTimeoutFailure`），`Jenkinsfile` 的 20 分钟 `timeout` 仍是最后一道；Test 阶段还会先打印 `node --version`，失败日志自带运行环境。`test/harness.test.mjs` 的脚本串守卫同步。

**验证（四组，均 0 fail）**：

| 环境 | tests | pass | fail | cancelled | skip |
|---|---|---|---|---|---|
| 本机 node 24，工具齐全 | 788 | 742 | 0 | 0 | 46 |
| 本机 node 24 + 空 PATH（`/tmp/nocommands` 全部 exit 127） | 788 | 701 | 0 | 0 | 87 |
| node 22 + 空 PATH | 788 | 701 | 0 | 0 | 87 |
| **pod 模拟**：纯 Linux + node 22 + 空 PATH | 788 | 703 | 0 | 0 | 85 |

（pod 模拟多跑 2 条、少 skip 2 条：非 WSL 主机走 `setWindowsPathTranslator` 接缝，`wslpath` 依赖只在「WSL 主机 + wslpath 被藏起来」时成立。）

**第三轮（2026-11-12 23:4x，`test/risd-cli-home.test.mjs` 的 `after` 钩子）**：CI 报 `Error: EACCES, Directory not empty: /tmp/risd-cli-home-…`，抛在 `rmSync(home, { recursive: true, force: true })`。钩子先 `child.kill('SIGTERM')` 就立刻删目录，而 `risd serve` 还在往 `home` 里写 heartbeat / pid，回收器走到一半目录又被重建（`rmdir` 拿到 ENOTEMPTY，Node 报成 EACCES）。本机 15 连跑不复现——容器里进程收尾更慢，撞窗口的概率更高。修法：`stopAndClean()` 先等 `exit`（SIGTERM 等 5 s，超时 SIGKILL 再等 2 s）再删，删除本身 20 次 ×50 ms 有界重试兜住已排队的写。`test/inherit-engine.test.mjs` 早就是这个顺序，这次把 `risd-cli-home` 对齐。**规则：spawn 出来的进程，先等它真的消失，再删它写过的临时目录。**

**第二轮（2026-11-12 23:3x，`test/proxy.test.mjs` 的 SOCKS5 分片回包）**：CI 报 `SOCKS5: a split domain reply is never accepted before it is complete` 断言 `+'resolved' -'pending'`，同一提交重跑即通过。解析器没问题（`connectSocks` 对 ATYP=域名在不足 5 字节时 `need=0` 直接返回，继续等），是**用例和它自己设置的延时代跑**：脚本先写 4 字节头、80 ms 后写尾，断言却是 `sleep(25)` 之后再读状态。pod 的 CPU 配额一旦让事件循环停 >55 ms，80 ms 定时器就在 25 ms 定时器之前到期——尾字节先落地，断言必然读到 `resolved`。已把断言搬进「写尾之前」的定时器回调（微任务先于下一个定时器 drain，凡由已收到字节造成的 settle 都已可见），并加 `Promise.race` 2 s 兜底；把解析器临时改成「4 字节即 resolve」时新用例确定性变红，证明它仍在守这条不变量。**规则：跨延时比较 promise 状态就是竞态，改成在事件发生的那一刻读状态。** 这类失败与并发无关——`--test-concurrency` 只能降低概率，不能修掉它。

### 2.40 2026-11-11 10:1x–10:5x m01004（测试文件整理：删除过期/重复用例、去重夹具、把「真机依赖」改成注入缝）

用户口径：「完成后 整理项目的测试文件，孤立简单已通过且不太可能再修改的，已过期与事实不符的，可合并或拆分提升效率的，进行删除或优化处理。」

**先量，再删。** 改前 `npm test` = 805 条 / 759 过 / 46 skip / ≈32.6 s；三路只读审计（`work/.tmp/test-triage-{proxy,host,risd}.md`）逐条给出「删/并/拆」与理由后，才动手。

- **发现的两类真问题（都不是「测试太多」）**：
  1. **用例真的在操作本机**：`test/proxy-route.test.mjs` 没注入探针，`POST /v1/proxy` 的保存路径在桥接运行时真会 `stopRedirector()`（taskkill）——跑一次测试就停掉用户 Windows 侧的桥接；`test/startup-reconcile.test.mjs` 真 spawn `Set-Service`/`Start-Service`（单跑 16.9 s），并且被本机「Windows 侧 ProxyBridge_CLI 正在跑」这个环境状态弄成 flaky（`running===true` 时根本不写恢复 note，断言必挂）。
  2. **慢的根因是等 Windows**：`detectRunningRedirector*` 的两次冷 PowerShell 探测在 WSL 里 ≈8 s（`risd-api` 里那条 16 s 的用例、`risd-write` 的四次 daemon 启动都栽在这上面），`debug-engine` 的 12 s 则是 JDWP 客户端每条命令留一个 10 s 的未清理定时器把事件循环吊住。
- **注入缝（lib/ 的改动，都是为了测试能说真话又不碰真机）**：
  - `lib/startup.js`：`reconcileStartupLeftovers({ cwd, log, ownPid, status = redirectorStatusCached, restore = restoreWindowsService })` 可注入；restore 成功后补 `clearWindowsServiceState()`（真 restore 自己会清，桩不会）。→ 12–17 s → **1.2 s**，且不再 spawn。
  - `lib/redirector.js`：`probesStubbed()` 读 `DSH_RIS_IDE_STUB_PROBES=1`，`detectRunningRedirector()`/`…Async()` 首行返回 `emptyDetection()`。放在 **env** 而不是 `__test` 钩子，是因为 daemon 子进程拿不到进程内钩子；`test/risd-helpers.mjs` 的 `isolated` 默认带上它。→ `risd-api` 那条 16.7 s → **1.34 s**，`risd-write` 12.5 → **3.1 s**。 注意该变量是**进程级**的：只在测试子进程里设，但若被外部消费者进程继承，`redirectorStatus()` 会谎报「没在跑」。`dsh-ris-yds` 读取前会临时摘除它再还原（其 `probeRedirectorStatus()`，见该仓 `DEVELOPMENT.md` §18）—— 别把「读到 stub 结果」当成桥接真的没启动。
  - `lib/index.js`：`__test.setWindowsProgramProbe(probe)`（命中缓存前生效，写入时清缓存）——Windows 程序列表不再靠真机枚举。
  - `test/proxy-route.test.mjs`：顶部 `redirectorTest.setProbeHooks({ windowsPids, localProc, windowsAlive, windowsAliveAsync, taskkill })` + `process.on('exit', reset)`。→ 17.7–26 s → **0.48 s**，且保存路径**不可能**再停掉真实桥接。
- **vendor 本地补丁（`lib/debug/vendor/jdwp/client.js` + 同名 `.ts`）**：`sendCommand` 的超时定时器改为 `timer.unref?.()` 并存进 `pendingRequests`，收到 reply 时 `clearTimeout(pending.timer)`。原来的写法每条命令留一个 10 s 定时器（且 `unref` 缺失），最后一个命令之后事件循环被吊满 10 s —— 这既让 `debug-engine` 从 1.9 s 变成 12.5 s，也让**真实调试会话**在收尾时无谓地多活 10 s。重 vendor 时务必保留（README 已注明）。
- **删/并的用例（全部是用例级，没有为「快」合文件）**：
  - 整文件删 `test/proxy-restart.test.mjs`(3)：`the component card owns ONE enforcement button` 已由 `test/risd-ui.test.mjs:166-169/219-220/706/718-726` 渲染级覆盖，daemon 与插件两端的 `stop→300ms→start` 并入 `test/proxy-route.test.mjs` 新增的 `the bridge restart action is wired on the card, in the daemon and in the plugin`（源码守卫——这条链路只有 shell 一条路，没有可注入的执行点，行为测试只能测 argv 构造）。备份 `work/.tmp/proxy-restart.test.mjs.bak`。
  - `test/redirector-bundle.test.mjs`：`ensureBundleReady` 的下载/缓存、失败映射、env 覆盖 3 条合成 1 条 `ensureBundleReady is a thin wrapper over the bundle install`（三处独有断言全留——它们 pin 的是 `lib/redirector.js` 的 wrapper 契约，bundle 模块测试覆盖不到，所以是「合」不是「删」）。
  - `test/dsh-origin.test.mjs`：`a non-loopback Host header records nothing` 的独有断言（整体 JSON 不变）并进 `a non-loopback Host is not recorded` 后删。
  - `test/client-viewer.test.mjs`：删 ProxyDialog 墓碑（`lib/`、`src/` 已无该符号，其 routeUrl 接线由 `⧉ reuses the prefetched daemon address…` 行为覆盖）；4 条并入既有（批量关闭提示→recent-file 下拉、侧栏静默/失败文案→toast、控制台忙碌遮罩→IDE console mask、状态栏进度→toast）。
  - `test/host-tail.test.mjs`：`the SSE stream route is advertised` 并入 SSE 行为测试。
  - `test/risd-api.test.mjs`：`/v1/dsh serves a sidebar snapshot whose windows are empty`（与 `test/risd-ui.test.mjs:420` 逐断言重复，先把独有的 `active:[true,false]` 移进去）与 `a sent row is upserted and a row left out is retired`（同命题并入 m10585）、内嵌 B5 正则（`janitor.test.mjs:59` 行为覆盖）、`successorArgs` 块（与 `risd-restart:21` 逐字相同）。
  - `test/risd-entry.test.mjs`：删 4 条（两个入口打开 risd 页 / 控制台不再有代理按钮 / 半死 daemon 探测 / 传输失败），分别由 `client-viewer:511/547/613`、`proxy-window`、`risd-tools:200-202`、`risd-host-p2:145-146` 覆盖；其中两条全仓唯一的负断言搬进了 `proxy-window.test.mjs`。
  - `test/risd-review-p2.test.mjs`：`/v1/config reports real values only` 是 `risd-api` 同命题用例的严格子集，删。
- **夹具去重**：`test/risd-helpers.mjs` 113 → 250 行，新增 `pickPort`/`writeEngineFixture`/`risdHeaders`/`waitFor`/`pidAlive`/`fakeReq`/`fakeRes`/`risdBridge`/`api`，替换 7 个文件里的本地副本（净 −138 行）；新建 `test/helpers/tgz.mjs`（`fileContent`/`octalField`/`tarHeader`/`makeTgz`/`fetchServing`），两个 bundle 测试改 import。
- **没有做的（判过，留作后手）**：`test/risd-mode.test.mjs:27/39/64` 还留着第三份 `fakeRes`/`fakeReq`/`waitFor` 副本（本轮 write scope 之外，可后续收敛进 `test/risd-helpers.mjs`）；`test/risd-write.test.mjs` 四条用例各起一个 daemon（≈3.1 s），共享 `before()` fixture 还能再省 ≈2 s；文件级合并（`host-noloop`+`host-window`+`client-build`→`host-http-fence`、`dsh-origin`+`dsh-window-refresh`→`dsh-window`、risd 27→21）——`node --test` 以文件为并行单位，合并只会串行化；SPLIT（`host-tail` 三段 / `client-viewer` 三分）收益是「改代码时 diff 小」，但会把 `client-viewer` 的源码守卫与 SSR 拆散、且 70/76 条纯源码守卫各自对应真实 bug（搜索框只能输 1 字符、SSE 每面板 6 条流打满 HTTP/1.1 六连接、codemirror 语言 compartment 塞 null 崩、测试期不得弹提权终端…），保留。
- **结果**：805 → **788 条**（742 过 / 46 skip，skip 全是缺 React SSR），56 → 55 个 `*.test.mjs`，20295 → 20013 行；全套 **32.6 s → 21.8 s**（空闲机器、默认并发），且默认并发下不再有真机副作用。单文件：`risd-api` 23.3 → 6.2 s、`proxy-route` ≈18 → 0.48 s、`startup-reconcile` 12–17 → 1.2 s、`debug-engine` 12.5 → 1.9 s。

### 2.39 2026-11-11 09:4x–10:0x m00388 / m00584 / m00808（通知条 ✕ 关不掉 / 还原布局换图标 + 页签重载按钮 / 最大化状态不持久化 / 重载与对比互斥）

用户三条（原文）：m00388「1. 配置已与工作区同步（新增程序已补、失效条目已删；你改过的字段保留） ，底部消息，点X关不掉。 2. 编辑器还原布局按钮换个图标，编辑器页签按钮区加 重载按钮，重新加载当前选中文件（若有修改先提示保存）。」；m00584「ide 各区块的最大化状态不要持久化。刷新或切换界面不保留区块最大化状态。现在经常打开ide，只看见编辑区，不知道是最大化造成的。」；m00808「编辑器文件重载按钮应该和对比按钮互斥，有*显示对比，没*显示重载。」

**1）通知条点 ✕ 关不掉（m00388-1）**

不是 z-index/pointer-events 问题：`ClosableNotice` 的点击确实进了 `dismiss`，但 dismissal 是**组件内 useState**。DSH 侧栏会同时挂载同一面板的多份副本——浏览器里实测有两个 `[data-sidebar-right-panel="push"]`，一个宽 0（隐藏、`keepMounted`、内含已渲染的 `data-notice=config-updated`，rect 0×0），一个是可见的 Agent Browser 面板；点 ✕ 只改了被点实例的那一份，隐藏副本下一帧又把同一条提示渲染回来，于是「点了没反应」。所以 dismissal 换成模块级共享表：`NOTICE_DISMISSALS`（kind → 已关闭的 signature）+ `NOTICE_DISMISSAL_LISTENERS`，`noticeIsOpen(kind,signature)` / `dismissNotice(kind,signature)`（变更后通知全部 listener），`useDismissedNotices()` 只订阅版本号再渲染。语义不变：signature 一变（新消息、或旧消息在新状态下重发）就重新出现；表活在当前页面，刷新后回到「打开」，跨工作区共享同一张表（同 kind+signature 在 A 关掉，B 里也不再出现）。测试缝：`__test.noticeIsOpen` / `dismissNotice` / `__resetNoticeDismissals`。

**2）还原布局按钮换图标（m00388-2 上半）**

`⟲` 和「重新加载」读起来是同一件事，换成 `▦`（按钮的 `action`/`key`/尺寸/点击行为全不变，只改字形与 title：「还原布局尺寸…（不改变最大化状态；管尺寸不管内容）」）。

**3）页签按钮区「重新加载当前文件」（m00388-2 下半）**

`reloadPath(path)` = `forgetDoc(path)` + `ensureDoc(path, true)`：**先丢草稿，再强制重读**，绝不把缓冲区合并进磁盘内容。`ensureDoc` 加 `force` 参数（原先对已加载路径直接 return）；图片/PDF 分支在 force 时写入新的 `{kind, at: Date.now()}`，让带 `t=` 的 media URL 重建、浏览器真的重新拉文件。脏页签走 `pendingReload` 提示条（`data-reload-prompt="1"`）：`保存并重载`（`savePath` 成功后才重读）/`丢弃重载`/`取消`/`×`。重载是「磁盘当下」语义，与撤销历史无关（CodeMirror 以新的 `props.text` 重挂文档）。

**4）最大化状态不再持久化（m00584）**

两处都在写：① save effect 把 `ui.maximized` 写进 `dsh-ris-ide:ui:<tab>@<workspace>`；② **首次打开**（无存档）还会主动 `maximized:'editor'`，再被①存下来——这正是用户「经常打开 ide 只看见编辑区」的来源。现在 `ui` 初始化只恢复 `collapsed`/`section`，`maximized` 恒为 `null`；save effect 不再写它，依赖数组去掉 `ui.maximized`。compact 面板的 `COMPACT_MAX_KEY`/`readCompactMax` 一并删除（机器级记忆、每个面板打开都只显示一段），`compactMax` 变成纯 view state，每次打开回到 split。旧 blob 里的 `ui.maximized` 读出后直接忽略（不做迁移删除，下一次 save 自然覆盖）；`readSavedUi` 的文档注释同步改成 `{ui:{collapsed,section},…}`。调试步进时若别的 pane 处于最大化，仍会运行时切回 editor（那是「让他看见断点行」的临时行为，不是持久化）。

**5）重载与对比互斥（m00808）**

两者问的是同一个问题（缓冲区与磁盘的关系），且只有一半有意义：脏缓冲区只能对比、干净缓冲区只能重载。原先两个按钮都在，干净时 `±` 是 disabled 死按钮。现在共用同一槽位：`isDirty(openFile) ? ±(data-action="diff") : ⟳(data-action="reload-file")`；无打开文件时 ⟳ 仍渲染但 disabled。`requestReload` 的脏分支保留为**竞态防御**（点下瞬间刚好被键盘改成脏时不至于静默丢改动），不再是主路径。

**测试**：`client-viewer` 256 条 / 210 过 / 46 skip（React SSR 缺）。新增 3 条：notice 共享表（关闭、signature 变更重开、旧 dismissal 被新 signature 取代、reset）、重载源码守卫（`reload-file`、`forgetDoc` 在 `ensureDoc(path,true)` 之前、四种按钮、`data-reload-prompt`、互斥三元）、SSR 渲染 ⟳（干净文件无 `±`、无文件时 disabled）。改造 3 条旧测试：compact maximize 不再记忆、saved layout 恢复字体/尺寸但忽略 `maximized`、首次打开呈现完整 2×2 网格。全量 `npm test` **805 tests / 759 pass / 0 fail / 46 skip**（`startup-reconcile` 的 parked ProxyBridgeSvc 在并发负载下再次超时，单跑 6/6 通过，既有 flaky）。

**边界**：本轮全部在 `lib/client.js`（+ `test/client-viewer.test.mjs`），装进安装副本后**刷新 IDE 窗口即生效，无需重启 dsh/risd**。

### 2.38 2026-11-11 09:2x–09:4x m00101 / m00122 / m00186 / m00220 / m00242（IDE 不可用 / 切换工作区 403 / 复制粘贴丢源 / 跨工作区复制 / 右键菜单 hover）

用户一次报出三条（原文）：「1. IDE 不可用：dsh 未运行（没有记住的工作区窗口），切换工作区（但是dsh端确实有此工作区，dsh启动后未作为入口传递过参数） 2. 切换工作区后，后台任务出错（已拦截，界面可继续使用）：不能对工作区之外的路径执行新建文件夹 3. 某些文件操作，复制粘贴等（非剪切删除），会导致源文件丢失」；随后补 m00122「右键 删除 ，报错是 后台任务出错（已拦截，界面可继续使用）：不能对工作区之外的路径执行新建文件夹 / 右键菜单增加hover行背景」、m00186「ide 切换工作区，能否通过api或stream获取dsh对应工作区的相关数据,避免报错」、m00220「通过粘贴板，应该可以跨工作区复制粘贴文件，和复制文件到桌面一个道理吧？」、m00242「我记得是跨区复制，然后目的地选中一个文件后粘贴」。

**定下的语义口径（先于实现，别再改）**：写侧严格（新建/粘贴目标/删除/移动限于会话工作区）；读侧（复制源）放宽到**本机已注册工作区**，与「复制文件到桌面」同一套语义；**跨工作区只允许 copy，不允许 move**（move 会跨 git 边界搬目录）；围栏 403 由客户端静默换 live session 重试一次，不再弹全局错误条。

**1）「IDE 不可用：dsh 未运行（没有记住的工作区窗口）」（bug 1）**

根因是两处叠加，都不是「dsh 没跑」：

- 写入端：`noteDshWindow` 只在带 `?sessionId=&?cwd=` 的 loopback 请求时才落盘 `dsh-window.json`，而 `refreshDshWindows` 又在 `windows.length===0` 时提前 return ⇒ `dsh web` 起来后**没人开过 IDE 面板**，文件里既无窗口行也无 `workspaces`/`url`/`at`。
- 读取端：`/v1/dsh` 的侧栏分支要求「文档新鲜 + workspaces 非空 + origin 可用」，文件不存在 ⇒ `available:false`，页面照抄 reason 成「dsh 未运行」。

修法（写入端 + 探测兜底，双轨）：

- `refreshDshWindows` 不再早退：每 10 s 无条件镜像侧栏（`dshWorkspaceRows`，每行加 `active = sessionId!=='' && isLiveSession(ctx,sessionId)`）与 origin（`rememberDshOrigin` 在 `dispatchRequest` 第一行记录 loopback 请求的**真实 Host**；回退 `dshWindowOriginFor` → `ctx.webServer.getOrigin()`），写盘条件=窗口行 dirty ∨ 镜像变化（`sameWorkspaceRows`）∨ 文档缺失/`at` 超过 10 s；两半全空则不建文件。
- 新增 `publishDshInstance`：每 tick 写 `~/.dsh-ris-ide/instances/dsh-<pid>.json {pid,url,at}` 并清 24 h 前的旧文件。**按 pid 分文件**是因为多实例共享 home，单文件会互相覆盖。
- 新增只读 `GET /dsh-ris-ide/workspaces`（`isLoopbackRequest` 否则 403，只接受 GET）→ `{ok,url,at,workspaces:[{cwd,title,sessionId,active}]}`。
- daemon 侧 `/v1/dsh`：抽出 `dshSidebarRows`；文档不可用时按 `dshProbeCandidates`（文档 origin → 各窗口 url → 5 min 内的 instances 文件，去重上限 4）串行 `probeDshWorkspaces(origin)`（600 ms 超时、https 放宽自签证书、body ≤512 KB、失败返回 null）拿真数据；仍不可用则照旧 200 并带 `knownWorkspaces`，reason 在 known>0 时改成「已发现 N 个 dsh 工作区，但没有可用的 IDE 地址（dsh 可能刚启动，稍后会自动重试）」。
- risd UI：工作区行区分 `（未活跃）`/`（无会话）`，**无 live session 也可点**（sessionId 空 + cwd 打开，SSE hello 自愈）；`dshWindowSignature` 纳入 active 位；不可用提示追加「（已发现 N 个 dsh 工作区）」。

**2）切换工作区后 403「不能对工作区之外的路径执行新建文件夹」（bug 2）**

围栏根 = `resolveCwd` 的结果，它**优先** `ctx.sessions.get(sessionId).header.cwd`；客户端发的是自己树/窗口的 `cwd`。切工作区后二者不一致，右键删除首行的 `fsMkdir(<树根>/.dsh-ris-ide/trash)` 就落在围栏外 → 403（插件全局 unhandledrejection 兜底再包成「后台任务出错（已拦截，界面可继续使用）」）。旧码还有反向错误：**页面显示 B 时 `remove A/x` 返回 200**，即静默动了 A 的树。旧码 probe（session header=A、页面 cwd=B、A/B 均注册）复现 403→200 的前后对照见 `work/.tmp/probe-fence.mjs`。

- `knownWorkspacePaths(ctx)`：`workspaceRegistry.list()` 的 `path` + `dsh-window.json` 的 `windows[].cwd`/`workspaces[].cwd`，`canonicalWorkspacePath` 去重，2 s 缓存（`KNOWN_WORKSPACES_TTL_MS`）。
- `insideKnownWorkspace(ctx,target)`：先词法包含，再 `realpathSync.native` 比对。
- `resolveCwd`：`declared === header` 直接返回（短路，不读注册表）；`declared` 属本机已知工作区则以 declared 为准；否则维持 header；都没有再回退 declared，最后 400。**任意绝对路径不放宽**。
- `insideCopySource`（只给 `FS_COPY_PATH` 的 `from` 用）：本树内或 `insideKnownWorkspace`；`move`/`remove`/`mkdir`/`create` 仍走严格 `insideRoot(target)`；`/fs/import` 原样（源本来就允许在工作区外）。
- 客户端自愈：`fsOp` 抽 `send(active)`，403 `outside-workspace` 时先取页面 live scope（`liveScopeResolver`/`liveScope`，ProgramsPanel 注册），否则 `liveSessionOfScope` 打 `GET /windows?cwd=` 拿主机 live session，**换 session 重试一次**；拿不到就原样抛，不循环。
- 附带收益：`serveStream` 同样用 `resolveCwd`，窗口 hello 现在按声明的 cwd 解析，旧 session 会被 hello 自动换掉。

**3）复制粘贴导致源文件丢失（bug 3，本次找到真实代码路径）**

`serveFsOp` 的 COPY/MOVE 与 `serveFsImport` 只用**词法字符串**判「目标不是源/不在自己内部」，而且只查了 `target === from` 与 `target.startsWith(from + sep)`，**缺反向的 `from.startsWith(target + sep)`**；随后 overwrite 路径先 `rm(target,{recursive:true})` 再 `cp`/`rename`。于是一条「copy 但目标其实是源的祖先目录」的请求就会**先删掉源**再失败。用真实 handler（`__test.serveFsOp`/`__test.serveFsImport`）在 /tmp 复现 4 条：文件源 `…/a/b/c/f.txt` → toDir=`…/a`, name=`b`, overwrite → 500 `ENOENT … lstat '…/a/b/c/f.txt'`，**a/b 整棵（含未参与复制的 sibling）消失**；目录源同型；symlink 别名 toDir→src 同型；`/fs/import` 同型。脚本：`work/.tmp/repro-alias.mjs`、`work/.tmp/repro-cross-workspace.mjs`。

修法（先校验、后原子替换，任何失败都不先删目标）：

- `assertReplacementIsSafe(source,target,action)`：四条 409 —— 同 dev+ino（same-entry『是同一个条目，拒绝覆盖以免丢数据』）、同 realpath（『目标…就是源本身，已拒绝…』）、target 在 source 内（『不能把…复制/移动到它自己内部』）、**source 在 target 内**（『…是包含源的目录：覆盖它会连源一起删掉，已拒绝』）。
- `replaceEntry(source,target,{move,overwrite,followLinks})` + `installReplacement(temp,target)`：copy 先写到同目录临时名（`replacementTempPath`，`.…dsh-ris-ide-replace-…`，树已隐藏、同目录保证 rename 原子、leaf 截 60 字符防 255 字节超限），再「旧目标→backup → rename(temp,target) → 删 backup」，任一步失败回滚且不留 temp；move 走 backup+rename。serveFsOp COPY/MOVE 的 overwrite 改走这条；`/fs/upload` 用临时名 + `wx`（不再用 `w` 截断旧目标）成功后 `installReplacement`；`/fs/import` overwrite 同样（`followLinks:true` 保留原来的解引用语义）。
- 剪贴板取证：`stageClipboardCopy` 每项把 `snapshot {path,dev,ino,size,mtimeMs,kind}` 写进 manifest；`verifyClipboardStageOriginals` 在发布/读取时比对，写 `<root>/.dsh-ris-ide/stage/integrity.log`（missing/replaced，进程内去重）；`serveClipboardRead` 回 `warnings`，客户端逐条 toast。这条不阻止丢源，但下一次能立刻指出「哪个原件不见了」。
- **有意语义变化**：目标是源的硬链接/符号链接别名时覆盖不再「成功」而是 409 same-entry；普通覆盖、目录替换、失败的上传/导入都保证旧文件不变。

**4）跨工作区复制粘贴（m00220 / m00242）**

9 个 case 全部用真实 handler 跑过（A、B 两个注册工作区，B 有嵌套目录）：A 复制（host 剪贴板 = A 的 staging 硬链接）→ B 选中 `docs/report.md` 粘贴 → 200，B 内容更新、A 源在、staging 在、两侧 trash 0；源用 A 的真实路径 → 200；B 选中项经 symlink 指到 A 同一文件 → 409 same-entry；目标是源的祖先目录 → 409；跨区 move → 403；跨区 copy 新名 → 200；不覆盖撞名 → 409 双方都在；import staging→B 同名 → 200 且 inode 不变；嵌套工作区里覆盖源所在整目录 → 409。

`pasteTargetDir` 只按当前树的 `selectedPath` 推断（`entry.isDir ? entry.path : parentOf(entry.path)`），源路径不参与 ⇒ 「选中文件后粘贴」落到其父目录，与桌面语义一致。

**5）右键菜单行 hover 背景（m00122）**

`S.tabMenuItem` 的内联 `background:transparent` 压过样式表，所以 `MENU_HOVER_CSS` 用 `[data-ris-ide-menu] button:hover:not(:disabled)` + `!important`，色值与树行一致（`rgba(0,0,0,.05)` / `color-mix` 7%）；5 个菜单容器挂 `data-ris-ide-menu`：树右键、新建 flyout、标签页列表、tab 右键、编辑器 gutter。

**测试**：`dsh-window-refresh` 12、`risd-api` 21、`risd-ui` 36（含 active 位、knownWorkspaces 提示、无会话行可点）；`host-tail` 101（`:2780` 声明 cwd 属注册工作区才掌权、`:2815` 跨工作区 copy 成功/move 403/未注册源 403）；`client-viewer` 253（`:2116` 403→重读 live session→一次重试成功、`:2144` 无可救不循环、`:2166` resolver 注册清理、`:2175` hover CSS + 5 个标记）；`clipboard` 20（原 13 + 7：丢源 4 条回归 + 原子替换）。`npm test` 全量 **802 tests / 757 pass / 0 fail / 45 skip**（skip 因测试环境缺 React SSR）。

**边界 / 部署**：host 侧（`lib/index.js`、`lib/risd/*`）改动要**重装 + 重启 dsh/risd** 才生效；`lib/client.js` 装好后刷新窗口即生效。新增的 `GET /dsh-ris-ide/workspaces` 在未重装的运行实例上返回 404，探测会自然回退到文档/实例文件。若 host 既无 `getOrigin` 又从未收到 loopback 请求，origin 仍为空（dsh 0.2.2-rc.1 的 `getOrigin` 可用，实际不触发）；多实例共享 home 只能靠 `instances/dsh-<pid>.json` 区分，单文件 `dsh-window.json` 仍是最后写者胜。

### 2.36 2026-11-10 00:0x 第二轮评审剩余项全修（m13826「全修」）

§2.35 里「未修」的 4 条 P0/P1 与 P2 清扫本轮全部落地（A/B/C 三份报告 × `00-汇总.md` 状态表）。

| 项 | 修复 |
| --- | --- |
| B-P0-1 `psElevated` 阻塞事件循环 | 新增 `spawnDetachedText()`（spawn + Promise + 超时 kill），`psElevated` 改异步；UAC 等待期间开 3 s 心跳定时器，避免短心跳老化被旧 watchdog 拆桥 |
| B-P1-2 pkexec 记父 pid / root CLI 停不掉 | pkexec 与 `sudo -n` 都在宽限后按本 home profile 扫 `/proc` 取**真正的 CLI pid** 再写 pidfile（pkexec pid 只留作 `askerPid`）；root CLI 的 `SIGTERM` 得到 EPERM 时返回 `{stopped:false, command:'sudo kill <pid>', reason:'该系统层拦截由 root 启动，请用 sudo 停止'}`，三层汇总不再谎报 `stopped:true` |
| B-P1-3 Windows 启动失败不回滚 service | 启动脚本把原始 `startType` 写 hint 文件；`recoverWindowsService()` 在「未提权 / svc 仍在跑 / pid 缺失 / 进程不活」四条失败路径恢复 ProxyBridgeSvc，成功清 hint |
| B-P1-5 stop 与 in-flight start 无互斥 | `stopRedirector` 只对**要停的那一侧**取 `acquireStartLock`（拿不到回 `pendingStart:true`）；新增非阻塞 `startLockHeld()`：什么都没检测到时若锁还在（UAC 等待期）立即回 `pendingStart`，不再白等 15 s；锁内再 detect 一次 |
| A4-P2-1/B-P1-4 机器级 kill | Windows 侧 `killWindowsCliProcesses` 与 watchdog 的 reload/teardown/prepare 全改按**本 profile 路径**过滤，无匹配 `ok:false` 不误杀；named mutex 由 `Local\` 升 `Global\`（跨 RDP 会话单实例；只在提权 PowerShell 内创建） |
| A4-P2-5 `waitForPidExit` pid 复用 | `readStartTime()`（`/proc/<pid>/stat` 字段 22）+ successor 带 `--wait-start <starttime>`；同名 pid 复用判「已退出」；非 Linux 退化旧行为；超时打一行 stderr |
| A4-P2-6 successor 丢端口 | `successorArgs({pid,port,startTime})` 带上实际绑定端口（`port 0` 时不写 `--port`）；`waitForPidExit` 移入 `lib/risd/server.js` 导出供 `bin/risd.mjs` 复用 |
| A4-P2-7/8 restarting 不复位、lastBridgeStart 不清 | spawn 抛错/`error`/非 0 `exit` 复位 `restarting` 并记日志；`lastBridgeStart` 在 action stop、redirector-stop、`teardownNetwork`、非 handoff `stop()`、reconcile 停桥分支清空 |
| A4-P2-9 unknown 当引擎停 | health 只对明确 `stopped` 短路（响应带 `engineState`）；reconcile 遇 `unknown` 直接 return（不 trigger stray、不拆桥） |
| A4-P2-3 启动 reap 无串行/stopping | 启动 reap 包进 `serializeBridge` 并先判 `stopping` |
| partial-side 不重试 | reconcile 条件改为「引擎 running 且 applicable 侧中存在未拦截的侧」→ `startRedirectors({sides: missing, interactive:false})`（保留 60 s 节流） |
| 健康路由有副作用 | `GET /v1/proxybridge/health` 改**纯只读**（不再触发 reconcile）；stray 最多滞后 15 s 由 supervisor 处理，`stray` 仍作为响应字段即时展示 |
| B-P2 清扫 | `start-busy` 判定前置（删旧后置死代码）；锁陈旧 5 s 对齐、release 不删他人锁；`proxy.json`/profile 原子写（tmp+rename）；materialise 失败 60 s 负缓存（force 绕过、成功清零）；`windowsBundleFailure` 每次尝试清零、诊断按错误码区分；`elevationScript` 用 `shellQuote` 拼 argv；`windowsPathOf({mustConvert:true})` 失败抛错；终端启动后用 elevation state 验证窗口真起来 |
| C-P2-1 工作区原地变化不重置 | `ProgramWorkbench` 加 `key={cwd || 'default'}`，cwd 变即重挂、从新键初始化（同工作区刷新不误清）。**边界**：现网挂载点 cwd 是常量，重挂不可达；若将来 cwd 动态变化，重挂会丢未保存 buffer，届时需先加 dirty 确认 |
| C-P2-2 每 render 读 localStorage | `savedUi` 改惰性 `useState(readSavedUi(...))`（该读取带一次性迁移的 `removeItem` 副作用，更不能每帧跑） |
| C-P2-5/6 提权提示被清、按钮复位 | skipped 文案改到 `loadProxyTab()` 之后写；新增 `stopBusy/elevateBusy`，忙碌时 `renderHealth` 不改文案、不复位 disabled，handler 防重入 |
| C-P2-7 轮询注释 | 写清「组件快照 30 s、拦截状态 5 s，10 s 轮询只重探 bridge，不每次读组件文件」 |
| drift 绕过未保存检查 | `driftSaveThenReload` 补 proxy/lifecycle 两个 confirm；`restartDaemonThenReload` 补 lifecycleDirty |
| compact 键不分区 | 有意：`dsh-ris-ide:ui:compact-max` / `compact-sidebar` 是本机布局偏好，两处 compact 面板共用；注释写明 `Deliberately NOT workspace-scoped` |
| UI 展示新返回值 | 停止时 `redirector.stopped === false`（root CLI / pendingStart）写 `#proxy-banner` 或 `#bridge-health-text`：`系统层拦截未完全停止：<reason>；请执行：<command>` |

**契约与边界**（写给后面维护的人）：
- `BUNDLE_URLS` 的 release tag 与 `BUNDLE_SHA256` **必须同步**：发 1.8.x 时上传新的 `ris-proxy.4.0.tgz` 后要把 pin 改成新附件真实 sha256，否则下载会 `hash-mismatch`（这是防提权组件被替换的代价，故意不 TOFU）。
- `readElevationState(side,{home})` 的 `home` 是 **proxy home**（`proxyHomeDir()`），函数内部自己拼 `proxybridge/`；传 `redirectorHome()` 会双拼（单测锁住）。
- `stopRedirector` 等锁上限：单侧 ≤15 s；`pendingStart` 表示「另一进程正在启动桥接」，UI 应提示稍后再试而不是当成失败。
- 明确没做（可接受）：`elevationScript` 只能证明窗口起来（root CLI 的 pid 由健康检查间接确认）；watchdog 在 mutex 竞争退出时可能被 starter 记下已退出 pid；`psElevated`/`restoreWindowsService` 仍是同步 PowerShell 等待（后者在 stop/exit 路径最长 30 s，exit hook 设计如此）。

测试：`test/risd-restart.test.mjs` 新增 7 例；`test/redirector.test.mjs` 42、`test/redirector-bundle.test.mjs` 15、`test/proxybridge-bundle.test.mjs` 26、`test/client-viewer.test.mjs` 248、`test/risd-ui.test.mjs` 24、`test/risd-api.test.mjs` 18 全绿；全量 **770/770 pass**（`--test-concurrency=3`，74 s）。

### 2.35 2026-11-09 23:2x 第二轮评审（20261109-2326）修复

范围 `origin/master..HEAD`（13 笔，`work/reviews/20261109-2326/`，A/B/C 三份报告 + E-lead）：评审结论 **2 P0 / 9 P1 / ~34 P2**。本轮修掉的是「同一批改动引入或直接伤到用户」的那几条，其余按严重度记录在 `00-汇总.md`。

| 项 | 修复 |
| --- | --- |
| 自动测试不再弹提权窗（m13621） | `openElevatedTerminal()` 在 `NODE_TEST_CONTEXT` 下直接返回 false（`DSH_RIS_IDE_ALLOW_TERMINAL=1` 才放行）；跑全测不会再弹 Windows Terminal |
| C-P1-1 「停止拦截」必 400 且静默 | `stopStrayBridge` 传对象 body（`api()` 自己 stringify）+ `cwd`；失败写进 `#bridge-health-text`（`banner()` 只返回 markup，不是 setter） |
| C-P1-2 legacy 布局无限重复迁移 | `readSavedUi` 只采用**同 tab** 的旧键并在采用后 `removeItem`（一次性）；同工作区其它 tab 可互认，跨工作区拒绝；按最后一个 `@` 切分（cwd 含 `@` 不误判）；逐键 `parseSavedBlob`（`compact-max='log'` 不再中断整次迁移） |
| A4-P1-1 原生 Windows 健康卡两侧都 skipped | `server.js` 的 Windows 适用性：`win32` 直接用 `installDir(home)/windows/ProxyBridge_CLI.exe`，WSL 才走 `%LOCALAPPDATA%` 副本；`createHealthCache().get` 转发并**纳入缓存键** `windowsApplicable/windowsPrepared/linuxApplicable/windowsExe` |
| A4-P1-2 手起桥接永不被清理 | 新 `localRedirectorOwnPids()`：只认 `--profile` 等于本 home profile 的进程；`detectSide`/`detectRunningRedirectorAsync` 命中时补写 pid 文件 ⇒ `risd stop`/空闲退出/崩溃重启能收掉 |
| B-P0-2 自动对账弹 pkexec/终端 | `startRedirector` 新 `interactive` 选项，门放在 pkexec **之前**；只有 `/v1/action start`（用户点「启动/提权启动」）与 `redirector-restart` 传 `interactive:true`，reconciler/启动对账一律 `manual` |
| B-P1-1 提权状态文件读写侧名不同 | 脚本写 `elevate-local.json`/`elevate-windows.json`，server 的 `elevationState()` 改读 `'local'`（原来读 `'linux'`，`active` 永假） |
| B-P1-4 跨 home 静默 kill | `startRedirector` 的去重、`stopRedirector` 的兜底 reap 都改用 `localRedirectorOwnPids()`；机器级扫描只剩诊断用途 |

未修（记录在 `00-汇总.md`，需要更大改动）：B-P0-1 `psElevated` 用 `spawnSync` 等 UAC（最长 45 s 阻塞事件循环）、B-P1-2 pkexec 记的是 pkexec 父 pid、B-P1-3 Windows 启动失败不回滚 service、B-P1-5 stop 与 in-flight start 无互斥，以及 P2 若干（`start-busy` 死代码、materialise 失败不缓存、`elevationScript` 未转义、`waitForPidExit` 无 starttime 校验等）。

测试：`test/client-viewer` 248、`test/redirector` 34、`test/risd-api` 18、`test/proxybridge-health` 4、`test/risd-ui` 24 全绿；全量见 §5。

### 2.34 2026-11-09 23:2x m13444 开发环境的页签 / 最近历史 / 检索缓存按工作区分区

- 需求（m13444 / m13509）：「编辑器，当期页签和最近历史」「文件检索结果缓存也要区分工作区」。
- **布局存储键**从 `dsh-ris-ide:ui:<program|logPath|workspace>` 变成 `…@<cwd>`（`workspaceKey = cwd || 'default'`）：打开的文件页签、当前文件、**最近文件**、布局/字号都落在本工作区的键下。`readSavedUi(storageKey, workspaceKey)` 只在「同工作区键」或「旧的无 `@` 全局键」之间做迁移采用，**绝不**跨工作区采用另一份 blob（否则 A 仓库的页签会出现在 B 仓库）。
- **检索缓存**键从 `kind:query` 变成 `kind:workspace\0query`：同一条 `git grep` 结果只对产生它的树有效；Ctrl+R / 保存后的失效只删本工作区的条目；`workspaceKey` 变化时 `searchCacheRef.current.clear()` 一次（切换工作区即换树）。
- **测试**：`test/client-viewer.test.mjs` 既有断言改到 `searchKey(...)` / `@<cwd>`；新增「tabs, recent history and search cache are scoped to one workspace (m13444)」（两个 cwd 两个键、`readSavedUi` 不跨工作区采用）+「search key 带 workspace、切换时清空」断言；`client-viewer` 247/247。
