# dsh-ris-ide 开发手册

> 面向开发者/维护者：安装与日常使用请看 [README.md](README.md)。本文件保留架构、路由、命令、配置、里程碑、打包/发布/Jenkins、测试与踩坑。

DSH 右侧栏的 **RIS-IDE 面板**：侧栏「RIS控制台」只放控制台 + 单程序实时日志（轻量、常挂）；完整工作台在**独立窗口**里——文件树/搜索 + 内置 CodeMirror 编辑器 + 调试面板（断点/线程/调用栈/变量/事件）+ 日志实时跟随 + **「本地实例」**（扫描项目里的 Spring Boot 入口与前端 `package.json`，一键启动/停止/看日志，Java 可 JDWP 调试），外加把服务输出写进日志、能被一键停掉的启动包装。

解决的问题：插件的编辑器预览只在**模型 `write`/`edit` 结算且命中该文件**时才自动刷新（#855），而服务日志是外部进程写的，所以打开日志文件永远是静止的；同时插件自带的读取路由读的是**文件开头**（前 512 KiB），长日志看不到新行。

本插件由三部分组成：

| 半边 | 文件 | 内容 |
|---|---|---|
| Host | [lib/index.js](lib/index.js) | `/dsh-ris-ide/*` 路由：`tail`（文件末尾 N 字节，≤512 KiB）、`stop`（按 `<log>.pid` 停服务）、`programs`/`start`/`instances`/`config`、`tree`/`search`/`fs/*`（文件树/搜索/读写/建删移复制）、`debug/*`（JDWP）、`stream`（SSE）、`opens`（待打开队列）。全部只接受 loopback + 同源请求 |
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

实测（本机 DSH 0.2.1-rc.2）：`dsh plugin add` 会把包写进 `dependencies`，**并自动把 `dsh-ris-ide` 追加到 `dsh.profile.bundles`**，不需要手工补清单。**挂载**由本包的 `dsh.bundle.patch`（[cordis.patch.yml](cordis.patch.yml)）在 profile 启动时合并成一个 Loader 行：

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
| `auto`（默认） | 探测到 **Git Bash** 就用它，否则用原生 PowerShell | 大多数情况 |
| `bash` | `bin/run-with-log.sh`（与 Linux 同款：POSIX 路径、优雅 TERM 停止） | 装了 Git Bash / 想和 Linux 行为一致 |
| `powershell` | `bin/run-with-log.ps1`（零依赖，PowerShell 5.1+） | 没装 Git Bash，或不想依赖它 |

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

## 1.7 打包 / 发布（Nexus）/ 安装（Jenkins 流水线）

### 1.7.1 本地或 Jenkins 上的打包命令

```bash
# 1) 依赖（devDependencies 里有 tsdown + @codemirror/*，是 chunk 的构建输入）
npm install --no-audit --no-fund          # 有 package-lock.json 时用 npm ci

# 2) 构建编辑器 chunk（core client 是手写单文件，不需要构建）
npm run build                             # → lib/client-codemirror.js（约 1.13 MB / gzip 324 KiB）
test -s lib/client-codemirror.js

# 3) 测试
npm test                                  # node --test "test/*.test.mjs"

# 4) 出包
mkdir -p dist && npm pack --pack-destination dist
#   → dist/dsh-ris-ide-<version>.tgz    （含 lib/、bin/、skills/ 与 cordis.patch.yml）
```

**包管理器**：构建/发布统一用 **npm**（仓库没有 lockfile；pnpm 只多一层 corepack/环境依赖，收益不大）。
Jenkins 工作区会跨 tag 复用，旧构建残留的 `node_modules` 会让 `npm install` 变成 no-op ⇒ 流水线提供
`CLEAN_NODE_MODULES`（默认开）：构建前先 `rm -rf node_modules` 再安装。

**依赖与 CI**：仓库里已提交构建产物 `lib/client-codemirror.js`，Jenkins 构建时**不装 devDependencies**（内网 registry 可能解析不到 `@codemirror/*`/`tsdown`）；只有 chunk 缺失、需要现构建时才安装。工作区残留的未跟踪 `package-lock.json` 会被自动删除（避免 `npm ci` 用旧锁解析失败）。

**测试与 CI（可移植性红线）**：`npm test` 只跑 `node --test "test/*.test.mjs"`，**不装依赖、不联网、不读任何本机/内网路径**——裸克隆 `git clone && npm test` 就能跑（`test/harness.test.mjs` 会守住这条）：

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

### 1.7.4 安装到 DSH

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

本仓库**不写上架说明**，只保证"符合上架规范"：上架规则、目录字段、PR 模板、提交步骤都在**仓库外的插件开发手册**（仓库外，工作区文档目录的 `docs/dsh-plugin-listing-guide.md`）。规则变动时改那边，不用改插件仓库。

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
  - **没有配置** ⇒ 自动扫描并写出 `.dsh-ris-ide.json`（status `generated`）；
  - **已有配置** ⇒ 先做**不扫描**的廉价校验（目录在不在、Spring 主类源文件在不在、前端目录还有没有脚本）；不符 ⇒ 重新扫描并**自动更新**配置（`updated`，保留你改过的字段与自定义程序）；相符 ⇒ **直接用配置当程序清单，完全不扫描**（`matched`）。
  - **「重新扫描」**（`?refresh=1`）永远强制扫描，并把结果与配置核对（有差异就顺带更新）。
- 发现结果宿主缓存 15 秒（`refresh=1` 或检测到配置不符时绕过缓存）。
- **启动与项目内容同源**：浏览器只发**程序 id**（`spring:<相对目录>#<主类>` / `frontend:<相对目录>#<脚本>`），宿主重新扫描并拼命令，页面无法让宿主执行任意命令。
- **`exec` 的位置关键**：`exec java …` / `exec <pm> run …` 让 wrapper 的子进程**就是**服务本体，所以「停止」TERM 的是服务本身（不是中间 shell）。

- **降级**：若宿主没有官方 `sidebarRight` 服务（裁剪版 DSH / 只装 host 半边），客户端整体不加载（右侧栏没有入口）；`ris_dev_*` 工具与 HTTP 路由仍然可用。

## 2.6 程序配置：扫描生成 → 你改你加 → 漂移时更新

扫描结果可以**落成一份配置文件**，把启动/停止参数交给你维护：

```
<会话工作区>/.dsh-ris-ide.json      # JSONC（允许注释与尾逗号）
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
| `ris_dev_programs` | `refresh?` `runningOnly?` | 列出工作区可运行程序：`id / name / kind / dir / mainClass|script / running / pid / logPath`（含 `.dsh-ris-ide.json` 里自定义的程序） |
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
- **依赖 jar 源码**：优先 `-sources.jar`，没有则用配置的反编译 jar（调试面板 ⚙ 可选填，如 CFR），最后 `javap` 降级；产物写 `<cwd>/.dsh-ris-ide-cache/`，按输入指纹失效、有界回收（≤64MB / ≤2000 文件，30 天未写先删）。
- **窗口与轮询**：工作台 tab 可见且已 attach 时每 700ms 轮询 `/debug/poll`；不可见时停止轮询。停止/重启服务会自动 detach；宿主重启后会话丢失，重新 `start` 即可（断点需重加）。
- **能力边界**：无表达式求值、无条件断点/日志断点、无热替换（`redefineClasses`）；JDWP 无鉴权，仅 loopback + 随机端口 + 用完即断。

## 里程碑与版本历史

当前里程碑 **1.7.0**（下节，含此后并入的增量）；更早版本只留一行摘要——逐版本流水账以 git 历史 / npm 版本为准，不再在文档里重复。

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

## 5. 测试

```bash
cd dsh-ris-ide          # 仓库根
npm test            # = node --test "test/*.test.mjs"
```

当前 **336 条 / 7 个文件**：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/client-viewer.test.mjs` | 211 | 客户端 SSR 快照 + 源码守卫（快捷键、菜单、批处理、查找面板、日志级别、diff、帮助数据…） |
| `test/host-tail.test.mjs` | 95 | `/tail`/`/stream`/`/stop`/`/start`/`/run-test`/`/search-content`、pidfile 协议、编码探测、路径围栏 |
| `test/debug-engine.test.mjs` | 11 | JDWP 会话状态机、断点映射、栈/变量解码 |
| `test/host-search.test.mjs` | 10 | 内容检索白名单、命中上限、截断标记 |
| `test/host-window.test.mjs` | 4 | 独立窗口的路径/尺寸/单例参数 |
| `test/harness.test.mjs` | 4 | 测试自身不依赖本机路径（裸克隆可跑）、React 探测 |
| `test/host-nogit.test.mjs` | 1 | 无 git 时树/检索退化 |

规矩：

- **裸克隆可跑**：`npm test` 不联网、不装依赖、不写死本机路径；真实 React 按 `DSH_RIS_IDE_REACT_ROOT` → 仓库 `node_modules` → 兄弟项目 `tools/*/node_modules` 找，都没有则 SSR 用例自动 skip（`harness.test.mjs` 守着）。
- **CI**：用 `BASH_ENV` 把 PATH 补回 `bash -lc`（否则启动类用例报 `npm/node not found`）；仓库已提交 `lib/client-codemirror.js` ⇒ 正常构建跳过依赖安装与 chunk 构建，只有改了 `src/chunks/**` 才需要现构建。
- 用例里对「源码文本」的断言较多（快捷键优先级、菜单结构这类不好用渲染断言的东西），改相关代码时要同步改断言——这是有意为之。
