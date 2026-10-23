# dsh-ris-ide 开发手册

> 面向开发者/维护者：安装与日常使用请看 [README.md](README.md)。本文件保留架构、路由、命令、配置、里程碑、打包/发布/Jenkins、测试与踩坑。

DSH 右侧栏的 **RIS-IDE 工作台**：文件树/搜索 + 内置 CodeMirror 编辑器 + 调试面板（断点/线程/调用栈/变量/事件）+ 日志实时跟随 + **「本地实例」**（扫描项目里的 Spring Boot 入口与前端 `package.json`，一键启动/停止/看日志，Java 可 JDWP 调试），外加把服务输出写进日志、能被一键停掉的启动包装。

解决的问题：插件的编辑器预览只在**模型 `write`/`edit` 结算且命中该文件**时才自动刷新（#855），而服务日志是外部进程写的，所以打开日志文件永远是静止的；同时插件自带的读取路由读的是**文件开头**（前 512 KiB），长日志看不到新行。

本插件由三部分组成：

| 半边 | 文件 | 内容 |
|---|---|---|
| Host | [lib/index.js](lib/index.js) | `/dsh-ris-ide/*` 路由：`tail`（文件末尾 N 字节，≤512 KiB）、`stop`（按 `<log>.pid` 停服务）、`programs`/`start`/`instances`/`config`、`tree`/`search`/`fs/*`（文件树/搜索/读写/建删移复制）、`debug/*`（JDWP）、`stream`（SSE）、`opens`（待打开队列）。全部只接受 loopback + 同源请求 |
| Client | [lib/client.js](lib/client.js) | 注册官方右侧栏 tab「RIS-IDE」（`sidebarRightTabs` + `sidebar.right.pane.tab`）：文件树/搜索、内置 CodeMirror 编辑器（懒加载 chunk）、调试 UI（断点/线程/调用栈/变量/事件多页签）、日志跟随（tail + SSE）、「本地实例」启停/配置、`/opens` 打开请求轮询 |
| Script | [bin/run-with-log.sh](bin/run-with-log.sh) / [run-with-log.ps1](bin/run-with-log.ps1) | 启动服务并把输出 `tee` 到日志文件，同时写 `<log>.pid`；trap 转发 TERM 给服务子进程（Windows 用 PowerShell 包装 + `taskkill /T`） |

浏览器半边**优先**走本插件的 tail 路由；该路由不可用时自动退回插件自己的 `GET /dsh-ris-ide/fs/read`（头部模式），并在状态栏里说明，不会假装在跟随。

---

## 1. 安装（打包 → `dsh plugin add`）

```bash
# 打包（在包目录里）。受限沙箱下 npm 需要可写的 cache，故显式指定；
# 提权会话里裸 `npm pack` 亦可。
cd ~/workspace/dsh-ris-ide
npm pack --cache ~/workspace/.npm-cache --logs-dir ~/workspace/.npm-logs
# -> dsh-ris-ide-<version>.tgz

# 安装进 web profile（写 $HOME/.dsh，需要提权/或由你手动执行）
dsh plugin --profile web add ~/workspace/dsh-ris-ide/dsh-ris-ide-<version>.tgz
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
  "http://127.0.0.1:3080/dsh-ris-ide/tail?sessionId=<会话id>&path=~/workspace/logs/ris-model.log&bytes=1024"
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
npm run build                             # → lib/client-codemirror.js（约 800 kB / gzip 210 kB）
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
- **发布历史 / 现状（2026-10-21）**：Nexus 上曾发布过 `1.6.4`（latest）与 `1.2.43`（legacy），随后短暂清空；现已经 Jenkins 重新发布 **`dsh-ris-ide@1.6.4`**（latest），本机 profile 也已从 Nexus 安装该版本。group `npm-public` 已验证匿名可读 / 可 `npm pack`。

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
| 拉取 | `gitParameter`（`PT_TAG`）从内部 Git（gogs，地址见内部运维文档）**`haweite/dsh-ris-ide.git`** 的 tag 列表里选版本并 checkout；**只列 master 分支上的 tag**（`branchFilter: origin/master`）。仓库根是插件就用根，是整包仓库则自动切到 `dsh-ris-ide` |
| 修改版本号 | **版本号 = 选中 tag**（`v1.6.4` → `1.6.4`；**必须是 X.Y.Z 正式版，不接受 `-SNAPSHOT` 等后缀**）；选 `origin/master` 分支则沿用 `package.json` 现有版本；`private=true` 直接报错 |
| 编译打包 | 仓库里已带 `lib/client-codemirror.js` ⇒ **跳过依赖安装与构建**（Jenkins 内网 registry 未必有 `@codemirror`/`tsdown`）；否则（chunk 未提交且有 `build` 脚本）`CLEAN_NODE_MODULES`→`npm ci/install`→`npm run build`。随后 `npm test`（无真实 React 时自动 skip；`SKIP_TESTS` 可跳过）→ `npm pack` → 归档 `dist/*.tgz` |
| 发布到 Nexus | `PUBLISH=true` 时用凭据 `nexus` 生成一次性 `.npmrc`（`//host/repository/<repo>/:_auth=…`），`npm ping` 探活后 `npm publish` 到**正式仓库 `npm-releases`**（不碰快照仓库）。**版本低于已发布 latest 时用 `--tag legacy` 发布**（旧 tag 可发，但不会把 `latest` 指回旧版本）；**同版本已存在则跳过发布**（流水线重跑安全，不会被“已发布”卡住） |
| 发布到公网 npm | `PUBLISH_PUBLIC=true`（独立勾选）时在 Nexus 发布之后追加 `npm publish --access public` 到 **registry.npmjs.org**；凭据是 Jenkins **Secret text 的 id `npmjs`**（npm Automation/Granular token，带 publish 权限、绕过 2FA）。**公网已存在同版本则跳过发布**（重跑安全）；公网 latest 更高时用 `--tag legacy` 不移动 latest。不勾选则完全不访问公网 |
| 同步到 Gitee | 同样由 `PUBLISH_PUBLIC=true` 触发（勾了公网上架就同步公开仓库）：把当前版本的**受控文件**（`git archive`，不含构建产物与内网提交历史）做成一个干净单提交，force push 到 **`https://gitee.com/riscloud/dsh-ris-ide.git`** 的 `master`，并推送**与 jk 选中的 tag 同名**的 tag（选中 `1.6.8` 就推 `1.6.8`，不加 `v` 前缀；从分支构建时不创建 tag）。推完用 `git ls-remote --tags` 校验该 tag 已出现在 Gitee。凭据是 Jenkins **UsernamePassword 的 id `gitee`**（用户名 = Gitee 账号，密码 = Gitee 私人令牌） |

发布前会读正式仓库（以及勾选公网时的 npmjs）现有 `latest`：版本更低时**不移动 `latest`**，改用 `legacy` dist-tag 发布（`dsh-ris-ide@1.2.43` 这样可装，但 `dsh plugin add dsh-ris-ide` 仍装 latest）。

**发版流程**：在 gogs 插件仓库 **master** 上打 tag（如 `v1.6.4`）→ Jenkins 选这个 tag → 插件版本、tgz 名、Nexus 正式仓库上的版本一致。

> Gitee 仓库若设置了「导入仓库同步（从 jk 拉取）」，注意两点：Gitee 并未提供触发该同步的 API（OpenAPI v5 无 mirror/sync 端点，只能后台定时或页面手动点），所以流水线采用「直接推干净快照」；且手工点同步会把 jk 的**完整内网提交历史**（含内网地址/账号等旧 blob）公开到 Gitee，建议不要启用自动同步。GitHub 侧完全由 `.github/workflows/mirror-from-gitee.yml` **后台定时拉取**（每 2 小时 cron + 可手动 `workflow_dispatch`，失败重试 3 次），拉取 `git clone --mirror` → `push --mirror`，**分支和 tag 全量同步**；发布流水线不访问 GitHub、不需要任何 GitHub 凭据（GitHub 网络不稳，定时重试更可靠）。
> tag 一致性：jk（gogs）是唯一源头，tag 只在 jk 上打；流水线把**同一个 tag 名**推到 Gitee，GitHub 镜像 `--mirror` 会 1:1 复制 Gitee 的分支与 tag。能保证「名字 + 版本 + 文件内容（tree）一致」；commit hash 不会一致，因为公开仓库必须使用干净的舍弃内网历史的单提交——这是刻意取舍，不是 bug。同版本重发会 force 移动 Gitee 的 tag，但通常 `npm publish` 会先因版本已存在而失败。

### 1.7.4 安装到 DSH

```bash
# Linux/macOS 一行安装（Nexus 已开匿名只读：临时 .npmrc 只写 registry；退出/失败自动删除）
REGISTRY=<internal-nexus>/repository/npm-public/
P=~/.dsh/profiles/web; ( printf 'registry=%s\n' "$REGISTRY" > "$P/.npmrc"; trap 'rm -f "$P/.npmrc"' EXIT; dsh plugin --profile web add dsh-ris-ide@1.6.4 )

# Windows PowerShell 一行安装（同上，无凭据；try/finally 保证删除）
$REGISTRY = "<internal-nexus>/repository/npm-public/"
$P="$env:USERPROFILE\.dsh\profiles\web"; try { Set-Content "$P\.npmrc" -Encoding ascii -Value "registry=$REGISTRY"; dsh plugin --profile web add dsh-ris-ide@1.6.4 } finally { Remove-Item "$P\.npmrc" -ErrorAction SilentlyContinue }

# 或从构建产物装（离线机器常用）
dsh plugin --profile web add /path/to/dsh-ris-ide-1.6.4.tgz

# 升级/重装：必须先删除 node_modules 里的副本，否则 pnpm 可能跳过（见 AGENTS.local.md）
rm -rf ~/.dsh/profiles/web/node_modules/dsh-ris-ide
dsh plugin --profile web add dsh-ris-ide@1.6.4

# 验证挂载（只读，会重写 profile 的 cordis.yml，需相应权限）
dsh --profile web --dump-config | grep -A2 "id: ris-ide"
```

装完 **重启 `dsh web`**（composition 只在启动时组合一次），浏览器 **硬刷新**（客户端 bundle 按 package 名加载）。
宿主新增的路由（`/fs/*`、`/stream`、`/bundle`）只有重启后才存在；否则客户端会回退旧的轮询/内置编辑器。

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
| 静态自检（不联网） | `npm run check:listing`（`bin/check-listing.mjs`，15 项） |

改完这些跑一次：

```bash
npm run check:listing            # 逐条 ✅ / ⚠️ / ❌；有 ❌ 退出码 1
npm run check:listing -- --json  # 机器可读
npm run check:listing -- --net   # 额外联网确认 npm/仓库公开可达（内网会失败）
```

**脚本不是上架的替代品**：license 选哪个、仓库公开不公开、npm 包名怎么定，这些决定项只能人定。

## 2. 让 DSH 启动服务后直接在侧边栏打开日志

两步（模型侧两次工具调用；第一步的脚本负责"启动 + 落日志 + 打印路径"）：

```bash
# ① 用 bash 的后台任务启动服务：日志经 tee 同时进 job 与文件，第一行输出 LOG_FILE=<绝对路径>
bash(
  run_in_background: true,
  command: 'cd ~/workspace/ris/ris-model/ris-model-biz && \
DSH_LOG_DIR=~/workspace/logs \
~/workspace/dsh-ris-ide/bin/run-with-log.sh ris-model \
java -cp "target/classes:$(cat target/cp.txt)" cn.com.ris.cloud.model.RisModelApplication \
  --spring.profiles.active=dev \
  --spring.config.additional-location=file:$HOME/workspace/local.yml'
)
# → started background job <id>；job_output(<id>) 看增量日志，job_kill(<id>) 停服务（连进程树）

# ② 侧边栏打开日志（在 RIS-IDE 工作台的日志页打开；路径是确定的，无需解析上一步输出）
sidebar_open(target: '~/workspace/logs/ris-model.log', title: 'ris-model 日志')
```

要点：

- **不要用 `terminal_open`/`terminal_send`**（`dsh-experimental-terminal-bundle`）：它是 headless agent 终端，UI 上只有会话卡片，看不到侧边栏。`bash` 与 `job_output`/`job_kill` 由 dsh-base 挂载，与该 bundle 无关。
- **`bash` 每次都是新 shell**：cwd、变量都不保留 ⇒ 命令里自带 `cd`（上面就是这么写的）；也没有 stdin 通道，REPL / 需要回答 y/n 的交互命令不适合。
- **脚本在服务输出之前就把文件建好了**（写一行 `--- started ---`），所以 `sidebar_open` 不会因为"文件还不存在"失败；服务随后打印的每一行都会经 `tee` 同时进 job 输出和文件。
- 日志按**稳定路径**追加（`logs/ris-model.log`），所以**重启服务不用再开 tab**：同一个 tab 会继续跟随同一个文件（文件变大或变小都能显示）。想要每次运行一个独立文件就加 `DSH_LOG_STAMP=1`。
- 想换日志目录用 `DSH_LOG_DIR=<dir>`；默认是 `<当前目录>/logs`。
- `tee` 让 job 输出保持完整：`job_output(job_id)` 照常能看到启动日志，侧边栏看的是同一份字节。

### 只用一条命令时的等价写法

不想用脚本，也可以在同一条 `bash(run_in_background: true)` 命令里自己重定向：

```bash
cd ~/workspace/ris/ris-model/ris-model-biz
mkdir -p ~/workspace/logs
java -cp "target/classes:$(cat target/cp.txt)" cn.com.ris.cloud.model.RisModelApplication \
  --spring.profiles.active=dev \
  --spring.config.additional-location=file:$HOME/workspace/local.yml \
  2>&1 | tee -a ~/workspace/logs/ris-model.log
```

然后照旧 `sidebar_open(target: '~/workspace/logs/ris-model.log')`。区别只是 `LOG_FILE=` 那行需要自己拼、文件不是"启动前就存在"。

## 2.5 「本地实例」面板 —— 扫描本机程序，一键启动/停止/看日志

侧边栏的 **「本地实例」** 标签**不是**只列在跑的实例：它会扫描当前会话工作区，列出所有**可运行的程序**，每行三个按钮：

```
● ris-model-biz  [Spring]  ris/ris-model/ris-model-biz   cn.com.ris.cloud.model.RisModelApplication  [启动][停止][日志]
○ ris-ui-3       [前端]    ris-ui-3                     pnpm run dev                                [启动][停止][日志]
○ tick-app       [实例]    logs/tick-app.log            （手工启动、扫描没覆盖的历史日志）          [停止][日志]
```

### 扫描口径（`GET /dsh-ris-ide/programs`，宿主侧执行，两段式）

入口程序和前端清单**都位于靠近顶层的位置**（`project/module`、`project/ui`，一般 2–3 层），深的是 **Java 包路径**——所以分两段扫，而不是把整棵树扫很深：

1. **浅扫（深度 ≤ 5）**：找 `pom.xml`（⇒ Maven 模块目录）与 `package.json`（⇒ 前端候选）；跳过 `src`、`node_modules`、`target`、`dist`、`build`、`.git`、`logs`、`.worktrees`…
2. **对每个 Maven 模块**：只扫它的 `src/main/java`（包路径可以深，深度上限 12），且只读**类名命中** `Application/App/Main/Bootstrap` 的 `.java` 文件，再校验内容里确有 `@SpringBootApplication`。

| 类型 | 判据 | 启动方式 |
|---|---|---|
| `spring` | 模块 `src/main/java` 下的 `@SpringBootApplication` 入口；模块目录 = 该 `pom.xml` 所在目录。运行参数优先取 `.vscode/launch.json`（`cwd` 解析到该模块的那条配置，`${workspaceFolder}` 展开），否则 `--spring.profiles.active=dev`（`local.yml` 存在时再加 `--spring.config.additional-location`） | `mvn -Pdev compile` → runtime classpath → **`exec java`** |
| `frontend` | 非 `node_modules` 下的 `package.json` 且有 `dev`/`start`/`serve` 脚本；包管理器按最近的锁文件推断（`pnpm-lock.yaml`/`yarn.lock`/`package-lock.json`） | `exec <pm> run <script>` |
| `instance` | 扫描没覆盖到、但 `<cwd>/logs` 里有 `<name>.log.pid` 的历史实例 | 只能停止/看日志 |

- **打开面板的行为**：打标签页时宿主先看配置文件——
  - **没有配置** ⇒ 自动扫描并写出 `.dsh-ris-ide.json`（status `generated`）；
  - **已有配置** ⇒ 先做**不扫描**的廉价校验（目录在不在、Spring 主类源文件在不在、前端目录还有没有 `package.json`、`additional-location` 指向的 `local.yml` 对不对）：
    - 不符 ⇒ 重新扫描并**自动更新**配置（`updated`，保留你改过的字段与自定义程序）；
    - 相符 ⇒ **直接用配置当程序清单，完全不扫描**（`matched`）。实测本机 17 个程序：首次生成约 1.5 s（含扫描），之后每次打开约 **12–16 ms**。
  - **「重新扫描」**（`?refresh=1`）永远强制扫描，并把扫描结果与配置核对（有差异就顺带更新配置）。
- 发现结果宿主缓存 15 秒（`refresh=1` 或检测到配置不符时绕过缓存重新扫描）。
- **启动与项目内容同源**：浏览器只发 **程序 id**（`spring:<相对目录>#<主类>` / `frontend:<相对目录>#<脚本>`），宿主**重新扫描**后用扫描结果拼命令——页面无法让宿主执行任意命令。
- **`exec` 的位置关键**：`exec java …` / `exec <pm> run …` 让 wrapper 的子进程**就是**服务本体，所以「停止」TERM 到的是服务而不是中间 shell。

### 三个按钮

| 按钮 | 行为 |
|---|---|
| 启动 | `POST /dsh-ris-ide/start` `{ sessionId, id }` → 宿主扫描 → `spawn(bin/run-with-log.sh, [logName, bash -lc, command])`（`detached`，`DSH_LOG_DIR=<cwd>/logs`）→ 等 `<log>.pid` 出现后返回；已在跑则返回 `alreadyRunning` |
| 停止 | 复用 `POST /dsh-ris-ide/stop`（与日志页「停止服务」同一 pidfile 协议：校验 `/proc/<wrapperPid>/cmdline` 后 `SIGTERM` → 5 s → `SIGKILL`） |
| 日志 | `ctx.sidebarRight.openTab('dsh-ris-ide:ide')` 打开 IDE 工作台，并把该程序日志载入日志页（滚动/着色/换行/也能停服务）；没启动过（无日志）时置灰 |

判定"在跑"的判据与「停止服务」按钮**同源**：宿主读 `<log>.pid`，并要求 `/proc/<wrapperPid>/cmdline` 里确实出现 `run-with-log.sh`（详见 §4）。面板只画宿主报的事实，浏览器从不提交 PID，也从不提交命令。

旧的 `GET /dsh-ris-ide/instances`（只列日志目录里的实例）保留，新面板用 `programs`。

**降级**：若宿主没有官方 `sidebarRight` 服务（裁剪版 DSH / 只装 host 半边），客户端整体不加载（右侧栏没有「RIS-IDE」tab），但 `ris_dev_*` 与 `/dsh-ris-ide/*` 路由照常工作。

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

一个命令、15 个 action：`ris_dev_debug { action, … }`。

| action | 额外参数 | 作用 |
|---|---|---|
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

**面板等价操作**（人）：侧边栏「RIS-IDE」标签 → 控制台行 `▶ 启动 / ■ 停止 / 🐞 调试 / ▤ 日志`；`🐞` 就是 `start`+`open`（以调试模式重启、连上、并把工作台弹出来）。调试区的 `🐞/⏹/⏸/⏵/⤵/⤷/⤴/⟳` 与上面的 start/stop/pause/resume/step(over/into/out)/poll 一一对应；源码行号**双击加断点 = `breakpoint_add`**，单击删 = `breakpoint_remove`。

### 2.7.4 约束与坑（踩过的）

- **断点用类名 + 可执行行号**（Maven 默认带 debug 信息）；行号不在 LineNumberTable 里不会命中。
- **JDWP 只服务一个 debugger 会话**：不要用 `nc`/`telnet` 探端口，探测会把会话占掉；判断 attach 完成看 JVM 日志 `Listening for transport dt_socket`（`start` 内部就是这么等的）。
- `start` 是**重启**（不是"给现有进程挂调试"）：正在跑的服务会被停掉再以 `-agentlib:jdwp=…` 起；`suspend:true` 会真的停住启动，Spring 会卡在启动处，记得 `resume`。
- 自定义 `startCommand` 的条目要含 **`${JDWP_ARGS}`** 占位符，否则点调试/`start` 直接报错并提示（本机 ris-model-biz / ris-rm-biz / ris-upms-biz 已补）。
- 能力边界：**无表达式求值（evaluate）、无条件断点/日志断点、无热替换**；能看线程/栈/局部变量/字段/数组/String。
- 宿主重启后调试会话丢失（断点也没了），重新 `start` + `breakpoint_add` 即可。
- 关掉这组命令：Loader 行配置 `agentTools: false`（默认开）；宿主没有工具注册表时插件降级为"只有面板"（不注册 `ris_dev_*`，有测试钉着）。

## 2.9 调试（JDWP，Phase 1+2：agent 命令 + HTTP + 工作台 UI）

给「本地实例」里的 **Spring(Java) 程序**加断点调试。引擎是内嵌的 JDWP 客户端（vendored `jvm-debug-mcp` 的 `src/jdwp`，MIT，**零额外进程**、+5MB 内存，见 `lib/debug/vendor/README.md`），面板与 agent 共用同一个调试会话。

**agent 命令**（单工具多 action，省 token）：

```
ris_dev_debug { action, id|name|path, ... }
  start {id|name, suspend?}      以调试模式重启并 attach（端口随机、只绑 127.0.0.1）
  stop                           断开（服务继续跑；停服务仍用 ris_dev_stop）
  status | poll {since?}         会话状态 / 新增事件（断点命中、单步…）
  breakpoints | breakpoint_add {className, line, suspendPolicy?} | breakpoint_remove {requestId} | breakpoint_clear
  threads | stack {threadId, max?} | variables {threadId, frameIndex?}
  step {kind: over|into|out, threadId?} | resume {threadId?} | pause
```

**启动语义**：「调试」= 停止当前实例 → 以 `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:<随机端口>` 重启 → 等 JVM 自己打出 `Listening for transport dt_socket` → attach。

- **不要探测 JDWP 端口**：JDWP 只服务一个 debugger 会话，随手 `nc` 一下就把会话占了（随后 attach 会 ECONNRESET）。插件等日志行，不 probe。
- `suspend: true` = JVM 停在启动处，要点 `resume` 才继续（Spring 会停住）。
- **断点用类名+行号**（如 `cn.com.ris.cloud.model.ModelHelper`，**不是**文件路径）；类没加载时引擎会等 `ClassPrepare`（30s）。行号必须是该类 LineNumberTable 里的可执行行（maven 默认带 debug 信息）。
- 前端程序没有 JVM，不支持调试。**自定义 `startCommand`**：在 `java` 后面加 **`${JDWP_ARGS}`** 占位符——调试启动时替换成 `-agentlib:jdwp=…,address=127.0.0.1:<端口>`，普通启动时替换为空；没有该占位符的条目点调试会直接报错并提示（本机 `ris-model-biz` / `ris-rm-biz` / `ris-upms-biz` 已补上）。

**HTTP 路由**（面板用，Phase 2 接 UI）：`GET …/debug/{status,poll,breakpoints,threads,stack,variables}`、`POST …/debug/{start,stop,breakpoints,step,resume,pause}`；参数用 `sessionId` + `path`（程序 log 路径），沿用 loopback+Origin 围栏。

**能力边界（Phase 1 明确不做）**：无表达式求值（evaluate）、无条件断点/日志断点、无热替换（redefineClasses）。能看局部变量、对象字段、数组、String、线程与栈——日常排查的主体。以后必须补这些能力时，走 DAP（jdtls + java-debug，资源重）或 JDI sidecar（对比见 `work/20261019-ris-dev-debug-analysis.md`）。

**会话生命周期**：停止/重启服务会自动 detach；宿主重启后会话丢失，重新 `start` 即可；JDWP 无鉴权，仅 loopback + 随机端口 + 用完即断。Windows 同样可用（JDWP 是纯 TCP）。

**工作台 UI（Phase 2）**

- 「本地实例」行按钮：Spring 程序 `启动 / 停止 / 调试 / 进入`；前端程序 `启动 / 停止 / 进入`。
- **进入**：打开独立 tab（每程序一个，`dedupeKey = programId`，重复点击聚焦）。
- **IDE 布局**（全部尺寸可拖、记在 localStorage，按 tab 一组）：左列默认 **300px**（`sizes.left`，col-resize），左列内部下是**控制台**、默认 **260px**（`sizes.leftBottom`）；右列**调试区**默认宽 **300px**（`sizes.debugWidth`，col-resize，日志占剩下宽度）、调试/日志这一行默认高 **260px**（`sizes.rightBottom`）。**四根**分隔条平时透明、hover 才显色，拖动时锁 `body` 的 cursor/user-select。
- **没有独立顶栏**（1.1.6）：控制项并入两个面板标题行——
  - **工作空间**（左上）标题 = **工作空间路径**（放不下省略号；右侧 `⌖ 定位` + `⤢` 最大化）——`⌖` = 展开目录树并定位到当前编辑的文件；
  - **源码**（右上）标题 = **工具栏**：检索框（`flex:1` 自动扩展，结果逐级展开目录树并打开源码）+ 按钮组（`A-` `A+` `🌓` `📄` `⚙` `⟲`，定宽不伸缩）+ 本面板 `⤢`;
  - 控制台 / 调试 / 日志 标题不变。底部状态栏与提示行照旧。
- **配色**：IDE **完全跟随 DSH 的页面主题**（不再有自己的配色偏好，也不写进布局持久化）。顶栏那个外观按钮（`data-action="theme"`）切换的是 **DSH 自己的主题**（`跟随系统 → 深色 → 浅色`，调用 DSH 的 `theme` 服务 `setTheme`，由 DSH 持久化；宿主没有该服务时不显示这个按钮）。我们只按页面的明暗给出**内嵌 CodeMirror 的表面色**（`viewerThemeCss(pageDark)`：页面深色→`#1b1d23` 底/`#d8dbe0` 字，浅色→`#ffffff`/`#1f2328`），因为 CM 的语法调色板（one-dark/one-light）由页面 `isDarkScheme()` 决定，表面必须与它匹配，否则会出现深底深字（`.` 看不见）。其余面板用 `currentColor` + `color-mix` 跟随页面 token，切换主题即时生效。

- **控制台**（左下）：每个程序都有 `▶ 启动 / ■ 停止 / ▤ 日志`（**前端项目也有启动/停止**），Spring 另有 `🐞 调试`；点程序名直接打开它的日志页签。控制台 **启动绿色 / 停止红色 / 调试橙色**（同几何的 tone：`#3fb950` / `#e5534b` / `#d29922`，日志仍中性）；控制台按钮 **25px**、调试区工具行与源码标题行图标按钮 **22px**，全部定宽居中（`▶ ■ 🐞 ▤` 字形宽度不同，不定宽会参差）；顶栏所有控件（`A-`/`A+`/配色/`📄`/`⚙`/`⟲` + 检索框）统一 **20px 行高**，字形垂直居中。
- **日志**（右下右）与调试页签都可 `×` 关闭；日志区直接复用 `.log` 跟随器（跟随/换行/字号/停止服务都与日志页一致）。**初始化时若已有程序在跑**，自动把它们的日志页签（Spring 还有调试页签）加载出来。
- tab 可见且已 attach 时每 700ms 轮询 `/debug/poll`；断点命中或单步后自动刷新线程/调用栈/变量；不可见时停止轮询。
- **调试按钮**：打开工作台并自动以调试模式重启（`autoDebug`），进度与失败原因显示在底部提示行。
- agent 也能弹这个 tab：`ris_dev_debug { action: "open", name: "ris-model-biz" }`（走现有的待打开队列，面板没开也行）。

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

## 里程碑 1.0.0 → 1.1.0

RIS-IDE 达到 1.0：一个侧边栏 tab 内完成「项目控制台 + 工作空间目录 + 源码编辑 + 断点调试 + 实时日志」。

- **控制台**（左下）：图标按钮 `▶` 启动 / `■` 停止 / `🐞` 调试 / `▤` 日志，启动/调试后自动**添加并定位**日志/调试页签；
- **工作空间**（左上）：**本插件自己的 `/dsh-ris-ide/tree`** 目录树（根 = `scope.cwd`）：**按 .gitignore 过滤**（对每层用所在仓库的 `git ls-files` 可见集判断，根与各子项目各自的 ignore 都生效，`node_modules`/`target`/`logs` 不出现；子项目根始终显示，由它自己的 ignore 管内容），并在 **`java` 目录之下**把**单链包名目录折叠成一行**（`cn/com/ris/cloud/model` → `cn.com.ris.cloud.model`，标识符用 `.` 连接，最多折 12 层、遇仓库根/非标识符目录停止；`src/main/java` 这类普通文件夹**不折叠**，逐层显示）——用户口径「文件夹只在java文件夹下合并成包名」；标题栏 `⌖` 定位当前文件；
- **源码**（右上）：多页签、`fs.read` 渲染、行号列**双击加断点/单击删断点**（类名由路径自动派生）、`✎ 编辑` + `Ctrl/Cmd+S` 保存（`sidebar/write`）、`Ctrl+W`/`×` 关页签；
- **调试**（右下左）：断点/线程/调用栈/变量/事件页签，工具行有 开始/断开/暂停/继续/单步/步入/步出/刷新/收起，`/debug/poll` 仅在可见时轮询；
- **日志**（右下右）：多页签，复用 `.log` 跟随器；
- **布局**：四根分隔条（`left`/`debugWidth` col-resize、`leftBottom`/`rightBottom` row-resize）拖动调尺寸（默认 左300 / 调试300 / 下260+260）、`⟲` 还原布局尺寸、每区 `⤢`/双击标题单独最大化（还原不影响最大化）、折叠调试区、布局状态**全部持久化**（localStorage，按 IDE tab 一个键 `dsh-ris-ide:ui:<key>`）：`ui.maximized`（哪个面板最大化）、`ui.section`（调试页签）、`theme`（配色）、`font`（字号）、`sizes`（左列/调试区/两个下层尺寸）、`files`/`file`（打开的页签与激活文件）。初始化时**同步读取并应用**（首帧就是保存的状态），并会把旧版按「程序 id」存的键**自动迁移**成当前键；**首次打开**（没有任何保存）默认最大化**源码**面板，之后恢复用户自己的状态。想重置：清掉该 localStorage 键即可。、底部状态栏（含尺寸读数 `宽 左300/调试300/下260+260px`）。

**1.6.7**：**右上角的「⧉ RIS-IDE」按钮 + 独立窗口**（窗口只加载插件自己，不加载 DSH 界面/会话）。
- **入口**：`conversation.session.header.utilities` slot 注册 `{id:'ris-ide-window', order:-8}`，按 order 升序**紧贴** DSH 自己的 `open-in-app`（-10，就是那个「用 VS Code 打开」）右侧、schedule（-5）左侧；组件 `RisIdeWindowAction` 只拿 slot 标准 props 里的 `sessionId`，弹窗被拦截时在按钮位置显示 4 秒「窗口被拦截」而不是静默失败。
- **窗口页**：`GET /dsh-ris-ide/window`（宿主新增 `serveWindowPage`/`serveWindowAsset`/`serveWindowVendor`/`serveOwnFile`，都在 loopback 围栏内、`no-cache`）。`lib/standalone/window.html` 用 `<base href="/">` + loader shim（`window.__ModuleLoader__.load` 只把 `{id,factory}` 存下来）+ 两个**随包 vendored 的 React 18.2 UMD**（`lib/standalone/vendor/react.js` 10.7KB、`react-dom.js` 128.8KB）直接加载 `GET /dsh-ris-ide/window/app.js`（= 同一个 `lib/client.js` 文件流），再调 `exports.mountStandalone(root,{sessionId,cwd,programId})`。
- **为什么这样做**：弹窗里若 boot 整个 DSH 前端，会变成第二个完整 GUI 实例（会话/对话/所有插件 bundle，随会话历史越长越吃资源）。现在窗口只有 **408KB 客户端 + 143KB React + 1 条 SSE**，CodeMirror（1.17MB）仍按需懒加载；与 DSH 页**同源同 cookie**，所以不用新端口、不用 CORS、不用 token，`/dsh-ris-ide/*` 路由与 SSE 全部复用。
- **不依赖活会话**：窗口 URL 带 `sessionId`/`cwd`/`programId`；`resolveCwd` 在 session 取不到时回退绝对 `cwd`（url 里的 `programId` 由 `fetchProgramById` 换成 pending program），所以 DSH 会话关掉后窗口照样能用。
- **`mountStandalone`**：懒 `require('react-dom/client')`（DSH 页里不会执行到），sessionId 缺省用合成值 `dsh-ris-ide-window`，cwd 缺省读 localStorage 的 `dsh-ris-ide:last-cwd`，然后 createRoot 渲染 `ProgramsPanel`。
- **宿主改动 ⇒ 需要重启 `dsh web`**；纯客户端部分刷新页面即生效。测试 **222/222**（新增 `test/host-window.test.mjs` 4 条：页面/客户端/两个 vendor/404+405；client 侧 header 注册、`openStandaloneWindow` URL 与拦截、`mountStandalone` 渲染）。

**1.6.7 · 侧栏改为「RIS控制台」（控制台 + 单程序日志上下两段），面板右上角带「⧉ IDE」打开独立窗口**：
- **入口改名**：右侧栏 tab 类型与 tab 标题都从 `RIS-IDE` 改成 **`RIS控制台`**（guide 文案同步说明「完整 IDE 在独立窗口里」）——面板不再假装是 IDE。
- **compact 形态**：`ProgramsPanel` 增加 `compact` 入参；右侧栏 tab body 的 `inject` 返回 `{sessionId, visible:true, compact:true}`，独立窗口的 `mountStandalone` 显式传 `compact:false`。compact 渲染：顶部 bar（`N 个项目` + root + `⧉ IDE` + `⟳`）、错误/note 条、程序行列表（复用 `consoleBody()` 的行语义：状态点、程序名点击切日志、内存、`▶`/`■`、spring 的 `🐞` 直接在窗口里开调试）、`data-splitter="compact-log"` 横向分隔条、底部日志区 `LogTail`（SSE tail + 轮询回退，全部复用，没有第二套日志代码）。
- **日志区几何**：默认 **240px**，拖动改高度（120–720 夹紧、按窗口高度再夹），**双击分隔条恢复 240**；高度写在 `localStorage['dsh-ris-ide:ui:compact']`（`readCompactPaneHeight`，垃圾值回落 240）。拖动时同步更新 `compactPaneRef`，否则「快速拖完立刻松手」会在 React 重渲染前把旧值持久化（实测踩到）。
- **面板右上角按钮**：bar 右侧 `⧉ IDE` = `openStandaloneWindow({sessionId, cwd, programId})`；行内 `🐞` = 同一个窗口 + `debug=1`，`mountStandalone` 把 `autoDebug` 挂到 pending program 上，窗口到的同时开始 JDWP。
- **宽度**：窄侧栏（≈380px）下实测行不横向溢出（程序名 `flex:0 1 auto` 先收缩，运行按钮保留命中区）；日志行宽 380px 时自动换行。
- **测试**：新增 3 条（compact 高度读取/夹紧/回落、`inject.compact===true` 与标题 `RIS控制台`、真实 React SSR 下 compact 只出 `data-panel="compact"`/`data-action="ide-window"`/`data-splitter="compact-log"` 且**没有** `data-ide-grid`），`openStandaloneWindow` 用例补 `debug=1`；`npm test` **224/224**。

**1.6.7 · 独立窗口打开即最大化**（填满屏幕 work area）：
- **features**：`openStandaloneWindow` 不再固定 `width=1500,height=960,left=60,top=40`，改为读 `window.screen.availWidth/availHeight` → `popup=yes,width=<w>,height=<h>,left=0,top=0`（读不到 screen 时仍回退 1500×960，不会变 NaN）。
- **页面自校正**：浏览器偶尔会夹小弹窗尺寸，所以 `lib/standalone/window.html` 在 boot 里（mount 之前、`document.title` 之前）再执行一次 `window.moveTo(0, 0)` + `window.resizeTo(screen.availWidth, screen.availHeight)`——同源脚本打开的窗口允许自己调整尺寸；被拒时 try/catch 静默忽略，退回 opener 给的尺寸（不因"无法最大化"而白屏）。
- **复用同一窗口**：compact 面板 `⧉ IDE` 与行内 `🐞` 都开同一个具名窗口 `dsh-ris-ide-window`，并 `handle.focus()` 把它带到前台（再点一次不会像没反应）。
- **测试**：新增 `openStandaloneWindow` 用 `screen {availWidth:1920,availHeight:1040}` 断言 features 里 `width=1920/height=1040/left=0/top=0`，无 screen 时回退 `width=1500`；host-window 用例断言页面 HTML 含 `window.moveTo(0, 0)` 与 `window.resizeTo(window.screen.availWidth, window.screen.availHeight)`。`npm test` **225/225**。
- **冒烟**：1920×1040 视口下窗口页 `#root` 占满（getBoundingClientRect = 0,0,1920,1040），面板正常渲染；截图 `work/20261022-ris-ide-window-max.png`。真实弹窗在 agent 浏览器里被拦截（`window.open → null`），所以"最大化"的弹窗几何靠 features 单测 + 页面自校正代码覆盖，用户实机打开即可确认。

**1.6.7 · 侧栏标题栏：最大化 / 跟随 / 字号 A−A+ / 整行点选切日志**：
- **控制台标题栏**（面板顶栏）加 `⤢/⤡`（`data-action="compact-max-console"`）：最大化时列表占满面板、日志段连标题一起收起；**日志标题栏**同名按钮（`data-action="compact-max-log"`）反向操作（日志占满、控制台收起）。状态存 `localStorage['dsh-ris-ide:ui:compact-max']`（`readCompactMax`，值只认 `console`/`log`，其它一律回退分段视图），`toggleCompactMax` 写值后再 setState，还原时回到拖出来的高度。
- **日志跟随**：侧栏日志标题栏新增 `data-action="compact-follow"`（`CompactLogHead` 组件），状态提到 `ProgramsPanel` 的 `compactFollow` 并传 `following`/`onFollowingChange` 给 `LogTail` —— 与 IDE 窗口同一个「跟随」语义（按钮高亮=跟随中；暂停后不再自动滚到底，同时日志被最大化收起时 `visible:false` 不轮询）。
- **日志标题栏去掉 ⧉ IDE 按钮**（打开窗口的入口只留面板顶栏那个）；**两处 IDE 按钮 tooltip 统一简化为「在独立窗口中打开RIS-IDE」**。
- **为什么抽 `CompactLogHead`**：日志标题栏原来是内联 JSX，空数据下 SSR 测不到跟随按钮；抽成模块级纯展示组件后可直接断言 `aria-pressed`/`⤢`/`⤡` 与「没有 IDE 按钮」，UI 与测试用同一份定义。
- **日志字号 A−/A+**：侧栏日志标题栏与 IDE 日志窗格共用偏好 `PREF_FONT_SIZE`（`dsh-ris-ide.fontSize`），`compactFont` 走 `clampFontSize`，两处 A−/A+ 互相同步；`LogTail` 从标题栏拿 `fontSize`，正文只渲染文本。
- **点整行切日志**：侧栏控制台一行原来只有程序名是按钮，点行内空白（右侧大半行）什么也不发生，看起来像"选了没反应"。现在整行是 pick 目标（`cursor:pointer`），▶/■/🐞 各自 `stopPropagation`。
- **切文件必须换 viewer**：侧栏 `<LogTail>` 加了 `key={logPath}`（与 IDE 日志 pane 的 `key: activePath` 一致）。没有 key 时 React 复用同一个 viewer，标题栏已换成新程序而正文仍留着上一个文件的内容——这就是"点项目日志内容不切换"。
- **按钮尺寸统一**：侧栏新增一份「按钮度量」——`paneButton`（文字按钮：`box-sizing:border-box; height:20px; padding:0 6px`）、`paneIcon`（纯图标：**20×20**，`display:inline-flex` 居中）、`paneIconOn`（按下态同尺寸着色）、`paneIconOff`（禁用态同尺寸变暗），行内动作 `startIcon`/`stopIcon`/`debugIcon` 也复用 20×20 只换语义色。之前混着 `S.button`(padding 1px 7px ≈22px)、`S.buttonOff`(≈17px)、行内 24px，两条标题栏并排像三种控件；现在控制台行 ▶/■/🐞、顶栏 ⧉ IDE/⟳/⤢、日志栏 跟随/⤢ 全部 20px 高，纯图标一律 20px 宽（实测 `heights:[20]`、`iconWidths:[20]`）。
- **测试**：`readCompactMax`（'log'/'console'/垃圾值回落）、compact SSR 断言两个最大化按钮、`CompactLogHead` 单独 SSR（跟随 ON/OFF 的 title 与 `aria-pressed`、最大化/还原图标、无 `ide-window`、两个按钮 20px 见方的内联样式）、header 按钮 tooltip 断言新文案。`npm test` **227/227**。

**1.6.7 · 目录树只在 java 文件夹下合并包名**：
- **用户口径**：「文件夹只在java文件夹下合并成包名。」
- **改动**：`listIdeTree` 只对 `isInsideJavaDirectory(full)` 为真（路径中严格存在 `java` 祖先目录）且首段是合法 Java 标识符的目录调用 `compactChain`；`compactChain` 也只在子目录名仍是 `PACKAGE_SEGMENT`（`/^[A-Za-z_$][\w$]*$/`）时继续折。于是 `src`/`main`/`java` 逐层显示，进入 `java` 后 `cn.com.ris.cloud.model` 才折成一行；非 Java 目录（`docs/guide/...`）一律不折。
- **测试**：host 的 `listIdeTree` 折叠用例改为在 `src/main/java/cn/com/ris` 上验证（`src` 不可折叠、`docs` 不折、`java` 层折出 `cn.com.ris`、折叠行 `path` 即展开目标）；client 的 locate 实链用例同步为「先走 `src`/`main`/`java` 真实行、最后一段才是折叠包行」。`npm test` **238/238**。

**1.6.7 · 目录树：新建包名 + 新建文件包名（相对当前目录）**：
- **需求（用户原话）**：java 及下级文件夹 ——「右键菜单新建文件夹下增加 新建包名，按照“.”创建多级目录」「新建文件时支持包名（当前目录下按照包名创建多级目录+文件）」。
- **新建包名**：右键菜单在「新建文件夹」下方新增「新建包名」（`data-tree-action="new-package"`），仅当目标目录 `isJavaSourceDir()` 为真（`src/main/java` 之下，含 java 目录自身）时出现——非 Java 目录里点号名字只是奇怪的文件夹名，不该提供。弹窗输入 `cn.com.ris.cloud.model`，`packagePathOf()` 逐段校验为合法 Java 标识符（拒绝空段、斜杠路径、数字开头；容忍首尾多余的点），随后一次 `fsMkdir` 建好多级目录（宿主 `mkdir` 本就 `recursive:true`），成功后展开目标目录、选中新包，`Ctrl+Z` 可撤销。
- **新建文件的包名**（**注**：本版随后又去掉第二个输入框，见「java 下新建文件只用一个输入框」）：该字段 1.2.49 起就有（`src/main/java` 下弹输入框，`newFilePath` 把 `cn.com.ris` 展开为 `cn/com/ris`），但原来会**预填当前目录的包**（`guessPackage`）——在 `.../java/cn` 里再填 `cn.com` 会建出 `cn/cn/com/...`。现在统一为**相对当前目录**：删掉 `guessPackage` 预填，标签与占位写明「相对当前目录，可留空；如 cn.com.ris」，并保留 `src/main/java` 之外不显示该字段。
- **测试**：`packagePathOf`（合法、空段、含斜杠、数字开头、首尾点、`_a.$b.c1` → `_a/$b/c1`）；源码断言钉住菜单项紧随「新建文件夹」且带 `isJavaSourceDir` 守卫、弹窗 package 模式与文案、提交走 `fsMkdir` 建目录并展开、`guessPackage` 已移除。`npm test` **242/242**。

**1.6.7 · 预览改为内联 + 文件树复制/粘贴补全**：
- **为什么不再用 DSH 官方预览标签**：原 👁 走 `openOfficialPreview()` → `ctx.sidebarRight.openResource('dsh-resource://file/...')`；但独立窗口由 `mountStandalone()` 直接渲染 `ProgramsPanel`，**没有 `panelCtx`** ⇒ 点击必抛「官方预览不可用：右侧栏服务不可用」。现在预览完全在插件内渲染，不再依赖侧栏服务。入口位置也按需求从编辑区标题栏挪到**编辑区域上方靠右**（`previewToggleBar()`，`data-action="preview-enter"`/`"preview-exit"`）：点「预览」后编辑器整块被预览替换、按钮变「编辑」，再点回编辑器；每个文件独立记住状态（`previewOpen[path]`）。
- **渲染**：新增零依赖 `renderMarkdown(source, { mediaUrl })`——所有文本先 `escapePreviewHtml`，再自建标签（标题/段落/列表/引用/围栏代码/表格/分隔线/粗斜体删除线/行内代码/链接/图片）；`safePreviewHref` 只放行 http(s)/mailto/相对地址与 `data:image/`，`javascript:`/`vbscript:` 一律丢弃；相对图片经 `previewAssetUrl(mdPath, src)` → `fileMediaUrl(scope, 绝对路径)` 走会话媒体路由。HTML 预览用 `iframe sandbox="" srcDoc`（脚本禁跑）。预览读取**当前编辑器 buffer**（未保存修改也实时可见，顶部提示「预览含未保存修改」），不再有「读磁盘旧内容」的割裂。样式 `PREVIEW_CSS` 全部 `currentColor` + `color-mix`，跟随 DSH 主题。
- **复制 = 普通复制**：右键「复制」恢复剪贴板语义（`beginCopy('copy')`，`data-tree-action="copy"`），原地生成副本拆成独立「创建副本」（`data-tree-action="duplicate"`，仍开 duplicate 弹窗、预填 `duplicateName()`）。
- **粘贴冲突不再直接失败**：`pasteInto`/`runPaste` 遇宿主 409 `exists` 时打开 `renderPasteConflict()`（`data-tree-paste-conflict`）选**覆盖 / 改名… / 取消**；覆盖前提示旧内容不可恢复，宿主 copy/move 新增 `overwrite:true` 先删后写。改名走 `prompt.mode='paste'`，提交后复用 `runPaste(source, dir, name, false)`。剪切贴回原目录（`parentOf(from) === dirPath`）静默 no-op —— 对应「移动文件到当前目录直接忽略」。
- **系统文件粘贴/拖入**：树根 `onPaste`（`handleTreePaste`）先取 `clipboardData.files`，否则读 `text/uri-list` / `text/plain` 里的 `file://`、绝对路径（`parseClipboardPaths`，去重、跳过 `#` 注释）；文件走 **`POST /dsh-ris-ide/fs/upload`**（原始字节流、128MB 上限、`overwrite=1`，返回 `{ok,path,name,bytes}`），路径走 **`POST /dsh-ris-ide/fs/import`**（`from` 允许 workspace 外，目标目录仍须在 cwd 内，`importEntryName` 拒绝空/`.`/`..`/含斜杠的名字）。树根与目录行 `onDrop` 同样先处理 `dataTransfer.files`；键盘 Ctrl+V 只在树自身剪贴板非空时 `preventDefault`，否则放行让 paste 事件处理外部内容。
- **切文件后的树选中**：新增 effect 跟随 `props.activePath` → `setSelectedPath(active)`，关闭/切换页签后旧文件高亮不再残留。
- **测试**：`renderMarkdown`（`<script>` 转义、javascript:/vbscript: 过滤、代码块/表格、相对图片走 mediaUrl）、`parseClipboardPaths`（`file:///tmp/a%20b.md` 解码、去重、忽略 https、`C:\w\a.txt`）、host upload/import（二进制 4 字节保真、同名 409、`overwrite=1` 覆盖、workspace 外 import、`name:'../evil.md'` → 400）、SSR「预览/编辑开关在编辑区上方、工具栏保持通用」、复制/创建副本菜单。`npm test` **238/238**。
- **一个作用域回归（已修）**：初版把 `previewAssetUrl` 定义在 workbench 里却调用树组件作用域的 `parentOf`，预览带图片的 README 时直接 `ReferenceError: parentOf is not defined`。现在 helper 移到**共享作用域** `previewAssetUrl(scope, mdPath, raw)`（内部用 module 级 `parentDirOf`），workbench 只传 `scopeRef.current`；顺带修了拼路径时丢掉开头 `/` 的问题（否则 `path` 会相对 cwd 再拼一次，图片 404）。测试新增：相对图片解析到 `/dsh-ris-ide/fs/file?...path=/w/...` 绝对路径、https/空值直通，并用源码断言钉住「helper 必须在共享作用域、workbench 内不得再出现本地副本」——同类 `ReferenceError` 已被抓过两次（`previewCurrentFile`、`parentOf`），以后由测试兜住。

**1.6.7 · 预览滚动条「无端跳跃」（已修）**：
- **现象**：在 Markdown/HTML 预览里拖动滚动条，滚动位置会无故跳动。
- **根因**：`fileMediaUrl()` 总拼 `t=Date.now()` 缓存参数；预览 HTML 在每次 workbench 渲染时都调用 `renderMarkdown` 重新生成，字符串里的图片 URL 每次都变 ⇒ React 判定 `dangerouslySetInnerHTML` 内容已变，**整段替换预览 DOM** → 图片重新请求、布局变化、滚动位置被重置。workbench 会因为日志 SSE、树刷新等无关状态持续重渲染，所以看起来"没有任何操作也会跳"。
- **修复**：`fileMediaUrl(scope, path, options)` 增加 `{ cacheBust: false }`（预览图片用稳定 URL；查看器看磁盘图片仍默认带 cache-buster）；预览 HTML 用 `React.useMemo` 缓存，只在 `[previewingFile, openFile, previewText]` 变化时重算；`previewPaneNode()` 渲染 memo 值，不再每次内联 `renderMarkdown`。
- **测试**：`previewAssetUrl` 断言图片 URL 无 `t=` 参数、同一图片两次解析结果相同；新增源码断言（memo 存在且 deps 正确、pane 不再内联 `renderMarkdown`、预览调用带 `cacheBust: false`）。`npm test` **239/239**。
- **回归（装完快照立刻报）**：memo 初版放在 `scopeRef` 声明**之前**，`var` 提升让 `scopeRef` 在 memo 执行时是 `undefined` ⇒ 预览解析图片时 `TypeError: Cannot read properties of undefined (reading 'current')`。修复：memo 移到 `scopeRef.current = …` 之后，并在 `mediaUrl` 里加防御回退（`scopeRef === undefined ? {sessionId, cwd} : scopeRef.current`）；新增源码断言钉住「memo 必须在 scopeRef 之后」。`npm test` **240/240**。

**1.6.7 · Markdown / HTML 一键预览**：
- **需求**：编辑器原先只做 Markdown 源码编辑（`@codemirror/lang-markdown` 高亮），插件内没有渲染预览；只有 pdf/doc/xlsx 等会自动交给 DSH 官方预览标签，`.md` 被有意排除（默认要能编辑）。
- **做法**：新增 `OFFICIAL_TEXT_PREVIEW_EXTS = ['md','markdown','html','htm']` 与 `supportsTextPreview(path)`；编辑器 pane 标题栏在活动文件可预览时出现 **👁** 按钮（`data-action="preview"`），点击调用现成的 `openOfficialPreview()` → `dsh-resource://file/...`，由 DSH 官方资源标签渲染；`shouldUseOfficialPreview` 仍不含 md/html，自动转交行为不变。
- **未保存**：预览读磁盘内容，有未保存修改时先提示「预览读取磁盘内容：未保存的修改不会出现在预览里」，不擅自保存。
- **测试**：`supportsTextPreview` 对 md/markdown/html/HTM 为真，java/无扩展/undefined 为假，且 `shouldUseOfficialPreview` 对 md/html 仍为 false；另加一条 **workbench SSR 回归**（用 saved-UI localStorage 预开一个文件后渲染源码标题栏，断言 `.md`/`.html` 出现 `data-action="preview"`、`.java` 不出现）——它第一次就抓到了「`previewCurrentFile` 被插到错误组件作用域，按钮在渲染期抛 ReferenceError」；`npm test` **233/233**。

**1.6.7 · 上架规则（dsh-market / dsh.so）+ 本地自检**：
- **上架合规配置（规则在仓库外手册，仓库内只放配置）**：`license: MIT` + `LICENSE`；`repository`/`homepage`/`bugs` 指向 GitHub；`keywords` 含 `dsh-plugin`；`description` 改英文句 + 中文句；README 用公开 npm 安装命令为主（内网源用占位符）、加截图与「权限与安全」节；`bin/check-listing.mjs`（`npm run check:listing`，15 项静态自检）。
- **已按规则配置**（2026-10-22，`npm run check:listing` 15 项全绿）：`license: MIT` + `LICENSE`；`repository`/`homepage`/`bugs` 指向 Gitee（`riscloud/dsh-ris-ide`，组织名不同改三处）；`keywords` 含 `dsh-plugin`；`description` 改成英文句 + 中文句；README 安装章节改成**公开 npm 一行命令**为主、内网 Nexus/tgz 为备选，并新增「权限与安全」「上架状态」两节；`docs/screenshots/` 放 3 张图（市场卡片轮播只从仓库托管加载）；`package.json` 增 `check:listing` 脚本。
- **只剩发布动作**（只能人做）：建公开仓库并加 topic `dsh-plugin` → `npm publish --access public` → 向 `awesome-dsh-plugin` 提清单 PR → `https://dsh.so/submit` 提交。**内网分发（§1.7 Nexus/Jenkins）与公开市场上架是两条并行线**，互不影响。

**1.6.7 · 空 package 文件夹也显示**：
- **现象**：java 下刚建的空文件夹在树里看不见；gitignored 的目录仍应隐藏。
- **根因**：`repoAllowedPaths()` 用 `git ls-files --cached --others --exclude-standard` 收录可见条目，而它**只列文件**——空目录不在 `allowed.dirs` 里，`listIdeTree` 直接 `continue` 掉了。
- **改动**：新增 `ignoredTreeDirs(repo, relatives)`：对「未被 git 收录」的目录路径（repo 相对、结尾带 `/`）跑一次 `git check-ignore -z --stdin`，返回被忽略的集合。`listIdeTree` 里这类目录改为「被 ignore 才跳过，否则显示」——于是新建的空包目录出现，而 `target/`、`node_modules/` 等仍隐藏。每次列目录最多一次批量 check-ignore，非 git 目录完全不查。
- **测试**：`listIdeTree` 用例加 `src/main/java/empty`（显示）与 `.gitignore` 里的 `empty-ignored/`（隐藏）两个空目录。`npm test` **83/83**（host 单文件）。

**1.6.7 · java 下新建文件只用一个输入框（点号建包）**：
- **用户口径**：「java 下新建的文件不要分两个录入框，如-java文件：cloud.test = 当前文件夹下建 cloud 目录，cloud 下建 test.java」。
- **改动**：新增 `javaFilePath(dir, raw, ext)`；`src/main/java` 下新建文件时只渲染**一个名称框**，提交用 `javaFilePath`：
  - 选了带后缀的类型：先拒绝含 `/`、`\`，去掉与类型相同的尾后缀，容忍首尾多余的点，按 `.` 分段，每段必须是合法 Java 标识符（含最后一段），最后一段 `normalizeFileName(seg, ext)`、前面段拼成目录。`cloud.test` + java → `cloud/test.java`；`cn.com.ris.Foo` → `cn/com/ris/Foo.java`。
  - 「普通文件」类型（无后缀）保持字面文件名（`notes.md` 仍是 `notes.md`，不按点拆包）。
  - 非 Java 目录不受影响，仍走原来的 `newFilePath`。
- **移除第二个录入框**：删掉 `promptPackage` state / `setPromptPackage` / 独立「包名」input（`data-tree-prompt-package` 不再存在），`guessPackage` 预填彻底删除；不合法时提示 `名称不合法：如 cloud.test`。
- **测试**：`javaFilePath`（`cloud.test`、`cn.com.ris.Foo`、`Cloud.Test.java`、`ModelHelper`、首尾多余点、普通文件保留点、`cloud..test`/`cloud/test`/`9cloud.test`/空 → `''`）；源码断言不再有 `data-tree-prompt-package`、提交与预览都走 `javaFilePath`。`npm test` **141/141**（client）。

**1.6.7 · 非 java 文件点断点静默略过**：
- **用户口径**：「编辑器打断点，如果不是java文件，略过，不要报错。」
- **改动**：`toggleBreakpoint(line)` 在 `classNameFromPath(openFile)` 返回 `undefined`（文件不在 `src/main/java` 下、派生不出类名）时直接 `return`，不再弹「无法派生类名」的 toast——Markdown/JSON 等文件点 gutter 无反应，不算错误。
- **测试**：源码断言（`if (className === undefined) return` 且不再有该 toast 文案）。

**1.6.7 · 断点列表：删除按钮统一左移，预置断点也能删**：
- **用户口径**：「断点列表，移除单个断点的按钮放左侧，未启动的断点也可删除。」
- **改动**：三种行（`bp.pending` 待应用 / `bp.failed` 未生效 / 已安装）共用同一个 `data-bp-remove` 删除按钮并渲染在**行首**：
  - 预置断点（程序未启动，宿主 list 里是 `requestId:'pending'`）→ `removeBreakpoint('pending', bp)`；宿主 `engine.removeBreakpoint` 在没有 session 时按 `className + line` 过滤 `pendingBreakpoints`，所以未启动也能删；
  - 未生效行只在本地 `setDbg` 过滤（它从没进 VM）；
  - 已安装行仍按 `requestId` 删。
  - 删掉原来的右侧按钮与 failed 行的「除去」文案；按钮是**图标按钮**（20px 方块、`×`、`title="删除断点"`），与标题栏的清除全部/刷新同一套尺寸，不再用宽字「删除」挤占行宽。
- **测试**：源码断言钉住三行都先渲染 `removeButton`、预置行走 `'pending'` 标记、`'除去'` 已消失。

**1.6.7 · 弹窗提示精简**：
- **用户口径**：「精简各处的提示内容，比如 新建文件、包名等窗口提示内容太多了。」
- **改动**：`renderTreePrompt` 的标签去掉括号解释（`包名（用 . 分隔，如 cn.com.ris）` → `包名`；`粘贴后的名称` → `新名称`）；占位从整句缩成单例：`如 Makefile、README`、`如 ModelHelper 或 cloud.test`、`如 ModelHelper`、`如 cn.com.ris`、`如 model-new`、副本 `默认「xxx - 副本」`；非法名 toast 缩成 `包名不合法：如 cn.com.ris` / `名称不合法：如 cloud.test`；粘贴冲突标题改「已存在同名条目」并删掉「覆盖会删除…」长句（覆盖/改名按钮本身已说明）；「新建包名」菜单 tooltip 缩成「按「.」创建多级包目录」。
- **测试**：源码断言占位只剩单例、不再出现 `例如`、`按输入保存`、`会创建多级目录`、`覆盖会删除目标现有内容`、`目标已存在同名条目` 等长句。

**1.6.7 · 断点：行号整行可点、双击红点删除，断点列不再整列消失**：
- **用户口径**：「java文件行号也可以打断点，已打断点，双击红点删除断点」；随后报「两个断点连一块，左侧断点面板和行号消失了」。
- **行号可点**：CM6 `lineNumbers()` 挂 `domEventHandlers`（`mousedown`/`dblclick`），与断点列共用 `breakpointGesture(options, 'single' | 'double')`：未标记单击 → 加；已标记双击 → 删；已标记单击、未标记双击都不动作（避免双击的两个 `mousedown` 先删后加）。点状 gutter 仍支持单击/双击，右键菜单保留原来的 `'toggle'` 语义（未标记加、已标记删）。兜底 textarea 编辑器同步：未标记单击加、已标记双击删（`title` 同步为「单击加断点 / 双击删除断点」）。
- **整列消失的根因**：`breakpointMarkers` 按 `breakpointLines` 的**插入顺序**往 `RangeSetBuilder` 里 `add`，两个断点（点击顺序或调试返回顺序）不保证升序；`RangeSetBuilder.add` 遇到乱序直接抛 `Ranges must be added sorted by 'from' position and 'startSide'`，整条 gutter 视图构建失败 ⇒ **行号 + 断点列一起消失**。修复：先 `[...breakpointLines].sort((left, right) => left - right)` 再 `add`。浏览器实测旧 chunk `[3,2]` → 行号 0 / 断点列 0 / 圆点 0，新 chunk `[3,2]`、`[2,3]` 都正常。
- **构建**：`lib/client-codemirror.js` 是提交进仓库的产物（CI 不装依赖不构建）。仓库 `node_modules` 只有 `@codemirror`/`@lezer`、没有 tsdown，且仓库内 `npm install tsdown` 会因 devDependencies 里 `@codemirror/lang-vue@^6.0.0` 整体解析 `ETARGET`；做法是在 `/tmp/tsdown-build` 单独 `npm i tsdown@0.22.14`，再用它的 `node_modules/.bin/tsdown --config tsdown.config.mjs` 从仓库根重建。
- **测试**：源码 + 已构建 chunk 双重断言（`lineNumbers` 带 `domEventHandlers`、`breakpointGesture` single/double、排序、chunk 里真的有 `breakpointGesture(options, "double")`、兜底编辑器标题与 onClick/onDoubleClick 语义）。client **145/145**。

**1.6.7 · 空行和注释行不能打断点**：
- **用户口径**：「空行和注释行不能打断点」。
- **改动**：新增模块级 `isNonExecutableJavaLine(text)`（trim 后为空、或以 `//`、`/*`、`*` 开头 → true）；`toggleBreakpoint(line)` 在非 java 文件判空之后，先取 `docs[openFile]` 的文本、按行号看该行，命中就直接 `return`——不产生 pending 圆点，也不弹错误（与“非 java 文件静默”同一口径）。
- **测试**：`isNonExecutableJavaLine` 单测（空白/行注释/块注释/javadoc 续行/`*/` 为 true，`int x = 1;`、`a * b;`、`undefined` 为 false）+ 源码断言 `isNonExecutableJavaLine(texts[line - 1])`。

**1.6.7 · 折叠不再吞掉空目录兄弟（java 包下有空包时）**：
- **用户口径**：「目录 java\cn\com\ris\test 不显示，应该是 java\cn\com\ris\cloud\admin 合并逻辑冲突了」。
- **根因**：`compactChain` 用 `allowed.dirs`（来自 `git ls-files`，只含**文件**）判断“唯一子目录”，空目录对 git 不可见 ⇒ `ris` 下只剩 `cloud` 一个可见子项，折叠一路深入 `cloud/admin/controller`，java 层只剩一行 `cn.com.ris.cloud.admin.controller`，空包 `test` 整个消失。
- **修复**：`compactChain(full, allowed, repo)` 对不在 `allowed.dirs` 里的子目录不再直接跳过，而是收集起来用 `ignoredTreeDirs()`（一次批量 `git check-ignore --stdin`）判断：**空但未被 ignore 的目录算真实兄弟、阻止折叠**；gitignored 的空目录仍然隐藏。`listIdeTree` 把 `repo` 传进去。
- **测试**：fixture 在包下加 `cloud/admin/controller/Cloud.java` 与空 `test/`；断言 java 层折叠行仍是 `cn.com.ris`、展开后 labels = `['cloud.admin.controller', 'test', 'Foo.java']`、`test.compact === false`、`cloud.admin.controller.compact === true`。host **83/83**。

**1.6.7 · 刷新页面后断点消失（调试帧被客户端当成失败丢掉）**：
- **用户口径**：「打了断点，刷新后，断点没了。再打断点，之前的断点全出现」。
- **根因**：调试面板的事件源是 SSE `debug` topic。宿主 `tickDebug` 直接把 `debugSessions.poll()` 的原始结果 `send('debug', payload)`，**没有 `ok` 字段**；而客户端 `applyPollResult` 的准入条件是 `result.ok !== true → return`，于是刷新后订阅收到的首帧被整帧丢弃——页面不知道宿主还留着预置断点（没有 session 时它们存在 `pendingBreakpoints` 里）。下次点断点时 `toggleBreakpoint` 末尾会 `pollOnce()` 走 JSON 路由（带 `ok`），才把全部 pending 断点一次性 merge 出来，于是出现「之前的断点全冒出」。
- **修复**：① 宿主发送调试帧时包一层 `Object.assign({ ok: true }, payload)`；② 客户端 `applyPollResult` 改为只忽略**显式失败**（`result.ok === false`），不再要求 `ok === true`，兼容旧宿主/无 ok 的帧（错误帧本来就走 `debug-error`）。
- **测试**：host 新增「the debug stream carries pending breakpoints, so a reload shows its dots」（预置 `a.B:12` 后订阅 `/stream?topics=debug`，断言首帧 `ok: true` 且携带 pending 列表，结束后清理）；client 新增源码断言（`applyPollResult` 用 `ok === false` 判错，函数开头不再有 `ok !== true`）。全量 **249/249**。

**1.6.7 · 双击红点取消不了断点（预置断点被当成“不可删”）**：
- **用户口径**：「双击红点无法取消断点」。
- **先排除 gutter 手势**：把已装的 `lib/client-codemirror.js` 单独拿进测试页（`mount` 带 `breakpoints:[2]`），浏览器里双击圆点 `onToggleBreakpoint` 确实触发，`dblclick` 与 mousedown 各自独立监听、`preventDefault` 不影响 ⇒ chunk 手势没问题。
- **根因**：`toggleBreakpoint` 查找 existing 的条件是 `bp.pending !== true && bp.failed !== true`。未启动调试时会话不存在，宿主里所有断点都是 `{requestId:'pending', pending:true}`（刷新后由 debug 帧/poll 恢复），双击时找不到 existing ⇒ 走“新增”分支又 add 一次，圆点永远消不掉（也解释了「再打断点，之前的断点全出现」）。
- **修复**：existing 条件去掉 `pending !== true`（pending 同样可从 gutter 删）；宿主 `removeBreakpoint` 本来就支持 `requestId='pending'`（无 session 时按 className+line 过滤 `pendingBreakpoints`），无需改。
- **测试**：client 新增源码断言（existing 接受 pending、toggle 内不再有 pending 排除、保留 `requestId: 'pending'`）。全量 **251/251**。

**1.6.7 · CRLF 的 .gitignore 尾部空行误报，把空包目录当成 ignored**：
- **用户口径**：「空文件夹 java\cn\com\ris\test 依然看不见（ris-upms-biz 下）」；合并规则重申「java 下连续目录、目录下只有一个目录时可合并，有多个目录或有文件时不合并」。
- **根因**：`git check-ignore -z --stdin` 在 **CRLF 行尾 + 尾部空行**的 `.gitignore` 上会返回一条 `pattern` 为空的“命中”（实测任何带 `/` 的目录路径都中，LF 同样内容则不中）；旧 `ignoredTreeDirs` 把 NUL 输出的所有非空分片（source、行号、pathname）都塞进 set，调用方按 pathname 判断 ⇒ 真目录被当 ignored 隐藏。
- **修复**：改用 `check-ignore -v -z --stdin`，按 `source\0 line\0 pattern\0 pathname\0` 四元组解析，`pattern === '' || pathname === ''` 的项跳过（空 pattern 不是规则）；真 gitignore 规则仍然生效（复现探针：`kept/` 只命中空 pattern、`ignored/` 命中真实规则）。
- **测试**：host 新增「a CRLF .gitignore with a trailing blank line does not hide empty folders」（fixture CRLF `.gitignore='ignored/\r\n\r\n'`，包下空 `test` 显示、`ignored` 隐藏、折叠停在 `ris`）。全量 **251/251**。

**1.6.7 · 调试面板：页签内滚动 + 断点命中时用「停住的线程」读栈/变量，并自动切到参数**：
- **用户口径**：「断点区域的滚动条应该在 tabpage 里，而不是整体滚动」；「`DynamicRouteInitRunner:66` 打了断点，调试启动后线程列表有了，但没进入断点（也许进入了），调用栈、变量都是空的，步进等按钮灰的，但是程序暂停了（日志暂停）」；「检查是否实现：进入断点后，调试区自动切换到参数，同时自动打开断点所在文件，断点行高亮，F6 或其他调试操作后，高亮行跟随变化」。
- **根因 1（滚动）**：`panes.debug` 被包在 `S.ideBody`（`flex:1; minHeight:0; overflow:auto`）里 —— 调试页签的内容跟着外层整块滚动，页签条也会被滚走。改为 `S.debugSlot`（`flex:1; minHeight:0; display:flex; flex-direction:column; overflow:hidden`），只有 `S.debugContent`（`overflowY:auto`）滚动。
- **根因 2（灰按钮/空栈）**：JDWP 断点与单步默认 `SuspendPolicy.EventThread`，只挂起命中的那一个线程，vendor 客户端里只有 `SuspendPolicy.All` 才把 `vmSuspended` 置 true（`lib/debug/vendor/jdwp/client.js` 的 `handleEvent`）。宿主 snapshot 的 `suspendedThreads` / `currentThreadId` 本来是对的，但客户端把 `suspended` 直接映射成 `vmSuspended` ⇒ 继续/单步按钮 `disabled: dbg.suspended !== true`；同时 `loadThreads()` 用 `threads[0]`（任意 JVM 线程，不是停住的那个）去 `stack`，JDWP 拒绝 ⇒ 调用栈/变量空、`followDebugLocation` 也不执行。
- **修复**：客户端新增 `debugSnapshotSuspended(snapshot)`（`vmSuspended === true || suspendedThreads.length > 0`）与 `debugSuspendedThreadId(snapshot)`（优先 `currentThreadId`，回退最后一个 `suspendedThreads`）；`merge` 保存 `suspendedThreads`/`currentThreadId`；`applyPollResult` 用停住的线程 `loadThreads(id)`，`loadThreads` 只对该线程 `loadStack`，不再用 `threads[0]`；`control()` 步进/继续后不再立即 `loadThreads()`（那一刻线程尚未停住，读栈必失败），交给随后的 poll 与 160ms 补轮询。宿主 `engine.snapshot` 增加 `currentThreadId`（`toJsonSafe`），IDE 知道该读哪个线程。
- **自动切参数 + 跟随**：命中/步进的暂停边沿自动把调试区切到「参数」页签（不抢用户手动切页签）；打开源码、滚动到行、行高亮与步进跟随沿用既有 `followDebugLocation`（`debugFocus` → `IdeTextEditor` 的 `debugLine`/`debugNonce` → `revealDebugLine`）。
- **测试**：client 新增 `debugSnapshotSuspended`/`debugSuspendedThreadId` 单测与源码断言（`S.debugSlot`、`section: 'variables'`、`loadThreads(debugSuspendedThreadId(result))`、源码中不再有 `threads[0].threadId`）、SSR 断言 `data-debug-slot` 且该槽 `overflow:hidden`；debug-engine 的 fake client 断言 `attached.currentThreadId === '11'`；**真实 JVM 集成测试**在断点命中后断言 `suspendedThreads === [threadId]`、`currentThreadId === threadId`、`vmSuspended === false`（钉住 EventThread 语义）。

**1.6.7 · 浏览器取消图片/文件请求不再把宿主打崩（`ERR_HTTP_HEADERS_SENT`）**：
- **用户口径**：「dsh 启动完全之前打开图片，dsh 崩溃」，报 `fatal load failure: Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client`，栈落在 `writeJson ← writeTailError ← serveFs`。
- **根因**：`/fs/file`（预览图片/附件）先 `res.writeHead(200, …)` 再把文件 `pipeline()` 进响应；浏览器在启动过程中重载/取消这个 `<img>` 请求时管道以 `ERR_STREAM_PREMATURE_CLOSE` 失败，`serveFs` 的 catch 又调 `writeTailError → writeJson → writeHead`，对已经发过头的响应二次写头必然抛错。抛错从 catch 里冒出去变成未处理 rejection（路由都是 `void serveX(...)` fire-and-forget），宿主把它当致命加载失败，整个 `dsh` 退出。
- **修复**：① `writeJson` 开头检查 `res.headersSent || res.writableEnded`，已发头就 `res.destroy()` 后返回（JSON 路由统一兜底）；② `serveFs` 的流式分支失败后若已发头，`res.destroy()` 而不是再答一次错误 JSON；③ 路由分发新增 `serveSafely(res, run)`，17 个 fire-and-forget 路由全部改走它，任何 handler 的 rejection 都不会再逃逸成未处理异常。
- **测试**：host 新增两条——「a cancelled file stream is destroyed, never answered a second time」（假 `res` 是 `Writable`，首发头后第一次写就报错，断言 `writeHead` 只调用 1 次、响应被 destroy 而不是二次应答）与「a response that already started is never written again」（`writeTailError` 对已发头响应不抛、直接 destroy；`serveSafely` 对新响应答 500 JSON、对已发头响应只 destroy）。全量 **256/256**。

**1.6.7 · IDE 窗口：同一工作空间只开一个；dsh 重启后窗口自己恢复**：
- **用户口径**：「ide窗口，不关，重启dsh 能否自动恢复？同一个工作空间，是否可以控制只打开一个ide?」
- **重启恢复**：窗口页是已加载的静态页，宿主重启后 JSON 路由立刻可用（窗口 URL 带 `cwd`，`resolveCwd` 在 session 已失效时回退绝对 cwd），缺的只是那条 SSE。现在 `risStreamHub` 对**硬关闭**（`readyState === 2`，重启必然如此）不再永久放弃：按 3s→30s 退避 `scheduleRetry()` 重建；同时监听 `window` 的 `online`/`pageshow`/`focus`，断线时立即重连（`reconnectIfDown`，只在 `source === null` 时动作）。原先 `failures >= 5` 的弃线条件已删——网络抖动交给 EventSource 自己重试。
- **回退轮询 → 流式**：所有带轮询回退的订阅都补了 `onOpen`：tail、programs、debug、debugs（session 列表）在流恢复时把 `streamOk` / `debugStreamOk` / `sessionsStreamOk` 置回 true，轮询自动停掉（以前只能越降级越深，流回来了也一直轮询）。programs 之前甚至从未在流错误时开过轮询，现在也补齐 `onError`。
- **单窗口**：窗口名按 workspace cwd 哈希 —— `standaloneWindowName(cwd)` = `dsh-ris-ide-window-<base36(hash(cwd))>`，所以再点「⧉ RIS-IDE」聚焦的是本工作空间的同一个窗口，另一个工作空间仍可各有自己的窗口。`window.html` 在加载面板**之前**用 **Web Locks**（`navigator.locks.request(key, { ifAvailable: true })`，`127.0.0.1` 属安全上下文）声明独占；拿不到锁时**只提示、不自动关窗**（见下一节）。浏览器没有 Web Locks 时退化为 BroadcastChannel `ping/pong` 探测。
- **测试**：`standaloneWindowName`/`standaloneWindowKey` 单测（尾斜杠等价、不同 workspace 不同名、`openStandaloneWindow` 用 workspace 名开窗）；`window.html` 源码断言（锁在面板脚本之前、`ifAvailable: true`、`focus` 消息、与 client 相同的 key 前缀）；hub 源码断言（不再 `failures >= 5`、`scheduleRetry`、退避上限 30s、`online`/`pageshow`/`focus` 重连、四个订阅的 `onOpen` 回切）。全量 **258/258**。

**1.6.7 · 复用的 IDE 窗口不再「一闪就关」（窗口导航时的锁竞态）**：
- **用户口径**（m02980/m03015）：「点 IDE 按钮，打开窗口马上又切回到 dsh 了」，「ide 不关，重启 dsh 后，再点的按钮」。
- **根因**：窗口名按 workspace 固定，`window.open` 复用该窗口并**导航**到新 URL（重启后 `sessionId` 变了）。旧文档的 Web Lock 在新文档启动瞬间可能还没释放，`ifAvailable` 返回 `null` ⇒ 旧逻辑 `surrender()` 立刻 `window.close()`，用户只看到窗口闪一下就回到 dsh。
- **修复**（`lib/standalone/window.html`）：claim 失败先按 `120ms * attempt` 重试最多 5 次，熬过导航释放竞态；仍失败才进入「已有一个窗口」提示，**绝不自动关闭**——提示里给「关闭这个窗口」（先 `BroadcastChannel` 广播 `{type:'focus'}` 尽量把已有窗口带到前台，再 `window.close()` 自己；跨窗口 `focus()` 在浏览器里不可靠，所以按钮的语义改为「关掉这个重复窗口」）和「仍然在这里打开」（清 `blocked` 后调用 `window.__risIdeBootPanel()`）。boot 改为等 `window.__risIdeClaimReady` 决议后再挂载，避免面板先渲染再被提示覆盖。
- **窗口名按工作空间而非面板路径**：`openStandaloneWindow` 新增 `windowCwd`（默认 `knownWorkspaceCwd()`），窗口名与 `wname` 参数都用它；URL 里的 `cwd` 仍可指向程序子目录。否则从程序目录点 🐞 会得到另一个窗口名，和 ⧉ 打开的不是同一个窗口（即“重复窗口”）。`window.html` 优先读 `wname` 作为锁 key（`var key = windowName`），保证第二份文档抢不到同一把锁。
- **测试**：`window.html` 断言重试正则、`仍然在这里打开`、`doesNotMatch(/window\.close\(/)`、`__risIdeClaimReady`、`__risIdeBootPanel = bootPanel`、`blocked === true) return`；client **156/156**、全量 **262/262**。

**1.6.7 · 变量面板：对象/数组懒加载展开（`debug/expand`）**：
- **用户口径**：「参数显示内容太少了，能否非基础类型是否能用json显示或懒加载的树形显示？」
- **根因**：`getFrameVariables`（`lib/debug/vendor/jdwp/client.js`）只把对象/数组格式化成一行 `Object@<id>`；IDE 没有展开入口，`debug` 路由也没有读对象的动作。JDWP 其实已经能查 `ObjectReference.ReferenceType` + `GetValues`（vendor 里 `getObjectFields` 就是这么做的）。
- **修复**：vendor 给对象值补 `objectId` + `kind`（`object`/`array`），新增 `getObjectDetails(objectId)`（ReferenceType → 对象字段或数组前 100 项）与 `getArrayEntries`；engine 新增 `expand(logPath, objectId)`（校验十进制 id）；host `debug` GET 白名单加 `expand`；客户端变量行按 `objectId` 渲染 ▸/▾，一次点击取一层并缓存（深度上限 8），数组行显示 `[i]`、超过 100 项追加「还有 N 项（只列前 100）」。无需协议改动，也不预取（大模型对象不点不花钱）。
- **测试**：debug-engine 的 fake client 加 `getObjectDetails`，断言 `sessions.expand('/tmp/x.log', '42')` 返回字段且传给 vendor 的是 `42n`，非法 id 抛 `decimal JDWP object id`；client 源码断言 `variableRows`/`data-var-expand`/`call('expand', …)`/`DEBUG_READ_ACTIONS` 含 `expand`。全量 **261/261**。

**1.6.7 · 断点落在 JDK/依赖类（工作区没有源码）时静默忽略**：
- **用户口径**：「进入调试后，F5钻入，缺失类文件，如何处理的？」→ 随后「实在不行，类文件缺失就忽略，不要弹错误窗。」
- **原行为**：`followDebugLocation` 找不到源码时弹 toast「源码不在工作区：…」，并且 miss 不缓存 —— 每一步都重新 `fsSearch` 一遍工作区。
- **修复**：miss 也写入 `sourcePathRef`（`null` 表示查过没有），不再重复搜索；缺源码**不再弹任何 toast/错误窗**，只在调试区顶部留一行极轻的「无源码 · 类名:行号」+「重试」（清缓存重搜），调试继续/步出照常工作（断点本身是宿主装的，不受影响）。
- **测试**：client 源码断言不再出现「源码不在工作区」、`data-missing-source` 与 `无源码 ·` 保留、miss 缓存写入 `sourcePathRef`。

**1.6.7 · 调试启动 / 停止 / 继续后主动刷新日志视图**：
- **用户口径**：「进入断点后，日志也中断了，需要F8结束断点，且切换项目后才有日志。」并追问「日志是不是调试启动后，进了断点，没来得及切换？断点走完后也没切换？」
- **结论**：日志**不会**随断点切换 —— 命中断点时停住的是 JVM 线程（`DynamicRouteInitRunner:66` 在启动线程上），日志文件自然不再增长，F8 后继续；「切换项目才有日志」是日志 viewer 退订/没有重读入口的表现：`LogTail` 在 `visible` 变化或路径变化时才会重新订阅，调试 start/stop/resume 本身不触发它重读，隐藏期间（例如旧逻辑把源码头抢成最大化）还会退订。
- **修复**：调试动作后主动让日志重读 —— 工作台新增 `logNonce`，`startDebug`/`stopDebug`/`control`（`resumed`/`stepped`）后自增并作为 `reloadNonce` 传给 `LogTail`；`LogTail` 检测到 nonce 变化就 `refresh()` 一次（不重建订阅、不清用户滚动位置）。同时上一轮已让 `followDebugLocation` 不再把正在看的日志面板抢成编辑器。
- **测试**：client 源码断言 `logNonce` 状态、`reloadNonce: logNonce`、`LogTail` 读取 `props.reloadNonce` 且 start/stop/resume 三处自增。全量 **261/261**。

**1.6.7 · 断点行不在可见区时自动滚动定位**：
- **用户口径**：「断点调试时，如果当前行不在滚动可见区域，自动定位。」
- **根因**：chunk 的 `setDebugLine` 只 dispatch `setDebugLineEffect`（高亮 `.dsh-ris-ide-debug-line`），**没有任何滚动**；`revealDebugLine`（DOM 估算旧兜底编辑器的实现）在 CM6 路径上根本没有调用点 ⇒ 命中的行在视口外时，用户只看到高亮但看不到行（旧文件/调用栈深处尤其明显）。
- **修复**：chunk 新增 `applyDebugLine(view, line)`：高亮后比较 `view.viewport.fromLine/toLine`，**只有行不在视口内**才追加 `EditorView.scrollIntoView(pos, { y: 'center' })`（居中）；行已可见时不动滚动（单步时视口不会跟着抖）。挂载时带 `debugLine` 也走这条路径。
- **后台页签**：被 park 的页签是 `display:none`，视口高度为 0，滚动判断会失真 ⇒ 客户端调试 effect 在 `props.visible === false` 时先不滚，页签变为活动（effect 依赖 `props.visible`）时再应用一次，此时视口尺寸正确。
- **测试**：client 新增源码断言（chunk 的 `applyDebugLine`、`viewport.fromLine/toLine` 判定、`if (!visible) effects.push(EditorView.scrollIntoView(pos, { y: 'center' }))`、构建产物含 `scrollIntoView(pos, { y: "center" })`；client 的 `props.visible === false` 守卫与 `[props.debugLine, props.debugNonce, props.visible]` deps）。全量 **262/262**。

**1.6.7 · 启动时的日志接入更早、也不再「看起来没连上」**：
- **用户口径**：「启动和调试时日志的接入时机太晚了？日志先显示的是启动命令，然后等启动了一大半了才切到运行日志。」
- **原因**：① 工作台 `consoleStart` 要等 `requestStart` 返回（宿主等 pidfile，最多 `START_WAIT_MS=6s`）才 `selectProgram`，侧栏控制台的启动按钮也只启动、不切日志行；② 宿主 wrapper 先写 `--- command: … ---`，接着 `mvn -q` 编译期本身就静默几十秒，日志里只有命令行。
- **修复**：点击启动就切日志视图（`consoleStart` 先 `selectProgram`、侧栏 `act('start')` 先 `setActive(program)`，随后才 await）；宿主 spawn 后立刻往日志补一行 `--- 启动中：正在编译/拉起 <name>，首次输出前可能静默 10–30 秒 ---`，让「已连上但暂时无输出」和「日志没连上」在视图上可区分。
- **测试**：client 源码断言 `consoleStart` 里 `selectProgram` 在 `await requestStart` 之前、侧栏 `if (kind === 'start') setActive(program)`。全量 **265/265**。

**1.6.7 · 断点参数（变量树）：只给对象/数组展开、步进后保留树、整对象字段全量**：
- **用户口径**：「vo 下级非对象，下级就不要显示图标了；步进后参数刷新，树都收起来了；json 应该包含所有字段，只是有的值是空的；步进后再展开树报错，导致程序直接退出。」
- **修复**：
  - 展开图标只给 `kind === 'object' | 'array'` 且带 `objectId` 的行（基础类型/null/字符串不再出现 ▸）。
  - `varTree` 记录 `items`（key→行数据）；`loadVariables` 在步进后保留 `expanded`+`items`、只清空的 `children`，并有一个 effect 对每个仍展开的节点重新拉一次 children —— **值刷新、树不收起**。
  - 宿主 vendor `getObjectFields` 沿 `ClassType.Superclass`（CommandSet 3 / 命令 1）上溯收集**实例字段**（跳过 `ACC_STATIC` 0x0008），对象展开后包含继承字段；null 值仍显示 `= null` —— 等同「JSON 全字段」。
  - 展开失败（JDWP id 过期/宿主重启）在 `loadVariableChildren` 内 try/catch，清 loading + toast；面板再加 React **错误边界** `IdeErrorBoundary`（`getDerivedStateFromError` + `data-ide-crash` 横幅 + 重试），包住侧栏 tab 与独立窗口两个挂载点，渲染异常不再打崩整个 dsh 页面。
  - CI 用「只有 hooks 的最小 React stub」直接加载客户端 bundle（不装依赖），stub 没有 `React.Component`；因此错误边界基类走 `var ErrorBoundaryBase = React !== null && React !== undefined && typeof React.Component === 'function' ? React.Component : function ErrorBoundaryBase() {}`，真实宿主仍是 `React.Component`，CI 也能加载。
- **测试**：client 断言 expandable 的 kind 判定、`expanded/items` 保留、刷新 effect、`展开失败` 兜底、错误边界与两处包装；全量 **265/265**。

**1.6.7 · 调试配置弹窗：依赖 jar 源码 / 反编译 jar 可视化配置**
- 断点在依赖 jar（非工作区源码）里时，以前只 toast「找不到源码」；现在 `resolveSourcePath` 在工作区 `fsSearch` 未命中后调宿主 `GET /dsh-ris-ide/debug/source?className&path&sessionId`：用 `target/cp.txt` 找到类所在 jar → 优先 `*-sources.jar` 提取 `.java` → 用户配置的 decompiler jar 反编译 → `javap -p -c -l` 降级；产物写 `<cwd>/.dsh-ris-ide-cache/`（`sources/`、`decompiled/`、`javap/`，文件树里隐藏）后像普通源码一样打开。
- 调试面板标题栏新增 **⚙**：可视化填写「反编译 jar 路径」「反编译参数」，保存到工作区旁路配置 `.dsh-ris-ide.settings.json`（GET/POST `/dsh-ris-ide/settings`），**不改写 `.dsh-ris-ide.json`**（保留 JSONC 注释）；保存后清掉源码 miss 缓存，下一步即重新解析。
- zip 读取零外部依赖（`node:zlib` 的 `inflateRawSync` + 手读中央目录/EOCD）；配置读优先级：`.dsh-ris-ide.settings.json` → `.dsh-ris-ide.json` 的 `decompiler` / `decompilerJar`。
- 回归测试：host 的 `buildZip` 写入器 + jar 读取、sources.jar 解析进缓存、settings 读写且不生成 `.dsh-ris-ide.json`；client 断言 ⚙/弹窗字段/保存调用与缺源码时走 `fsDependencySource`。

**1.6.7 · 控制台行在启停期间加遮罩 loading**
- 控制台某程序点启动/停止后，该行立刻盖上半透明遮罩 + 旋转指示（`data-program-loading`，文案 启动中… / 停止中…），并吞掉整行点击：之前按钮虽 disabled，但整行仍可点（会切日志/重复触发），现在启停未返回前点不到任何东西。
- 实现：`PROGRAM_LOADING_CSS`（`@keyframes dshRisIdeSpin`、`.dsh-ris-ide-loading`、`.dsh-ris-ide-spinner`）注入 compact 面板；行 style 加 `position:relative; overflow:hidden`。

**1.6.7 · 文件树标题栏：.gitignore 过滤开关（眼睛图标）**
- 位置：工作区标题栏 ⟳ 与最大化之间。有 git 时**默认开启**（`data-filter-state="git"`，眼睛）；点一下变 `all`（眼睛加斜线），列出 `.gitignore` 忽略的文件和目录；再点恢复过滤。没有可用 git 时按钮禁用并提示「文件树本就显示所有文件」。
- 宿主：`/tree` 接受 `filter=all`；`listIdeTree` 在该模式下把 git 可见集合置空（文件系统即白名单；插件自己的 `.dsh-ris-ide-trash`/`.dsh-ris-ide-cache` 仍隐藏），响应新增 `git`（是否有可用 git）与 `filtered`（本次是否应用了 .gitignore），客户端据此决定按钮状态。
- 客户端：模块级 `TREE_FILTER_ALL` 被 `fsTree` 读取（query + 缓存 key），切换后 `refreshNonce` 让树重读根与全部已展开目录；`IdeTree` 每次拿到 listing 都通过 `onTreeMeta` 回报 git 是否存在。
- 已知限制：实时推送（共享 SSE 的 tree 帧）仍按 git 规则过滤，`.gitignore` 里的目录（`node_modules`/`target`）里的变化不会触发自动刷新；「显示所有」后展开或 ⟳ 能看到最新内容。
- 测试：host 新增 `filter=all shows gitignored files, the default hides them`（路由级：默认隐藏 `.gitignore` 命中的文件与目录、`git:true/filtered:true`；`filter=all` 全部出现且 `filtered:false`）；client 新增标题栏 SSR 断言（`data-action="tree-filter"`、`data-filter-state="git"`、`data-icon="eye"`）与源码断言（查询参数、缓存 key、`toggleTreeFilter`、`onTreeMeta`、眼睛/眼睛斜线图标、旧的漏斗三角已删除）。

**1.6.7 · 没有 git 的机器上，文件树与文件名搜索退化为不过滤**
- 裸机只装 DSH + 插件时可能没有 `git`。旧行为：`.git` 目录存在 ⇒ `repoAllowedPaths` 的 `git ls-files` 失败 ⇒ 可见集合为空 ⇒ **仓库里一个文件都看不到**（搜索同样空）。
- 现在：`runGit` 记住 `ENOENT`（`gitMissing`），`repoAllowedPaths` 返回 `undefined`，`listIdeTree` 按「文件系统即白名单」列出（目录+文件照常，只是不再应用 `.gitignore`）；`searchWorkspaceFiles` 对列出失败的根目录退化为 `listRawFiles` 递归。git 在时行为不变。
- 测试：`test/host-nogit.test.mjs`（独立进程，`PATH=''` 让 `spawn('git')` ENOENT；断言树里仍有 `README.md`/`A.java`、搜索仍命中）。

**1.6.7 · 异常机制加固：插件自己的错误不再打崩宿主或页面**
- 宿主（`lib/index.js`）：
  - `handleRequest` 只有一层 `try/catch` 围栏（真正的路由在 `dispatchRequest` 里），路由/写响应阶段的任何同步异常都转成 500 或直接销毁连接，不会抛回 HTTP server。
  - `serveSafely` 用 `Promise.resolve().then(run)` 包住路由体，**同步 throw 与 rejected promise 都接住**；`writeJson` 本身也不再抛（序列化失败→500，`writeHead/end` 失败→`res.destroy()`）。
  - SSE：`res.on('error')` 标记断开（否则 Node 把无监听的 'error' 当未捕获异常），`close` 时逐个 cleanup `try/catch`；`fs.watch` 回调里逐个 listener `try/catch`（一个订阅者抛错不再从 watch 回调逃逸成未捕获异常）。
- 客户端（`lib/client.js`）：新增 `guardWindowErrors(ownPage)` 页面级围栏——`unhandledrejection`/`error` → 底部可关闭错误条 + `console.error`，独立窗口里 `preventDefault()` 让页面保持可用；`pollOnce` 的 fetch 失败/程序已停止 → toast「调试状态刷新失败」并清 busy；SSE 的 `debug`/`debugs` 帧应用加 `.catch`；目录展开 IIFE 加 `try/catch`；渲染错误仍由 `IdeErrorBoundary` 兜底。
- `lib/standalone/window.html`：boot 链 `try/catch` + 共享 `failBoot()`，启动失败显示在静态覆盖层而不是变成空白窗口。
- 测试：host 新增「route 同步抛错→500 / 死响应不抛 / `handleRequest` 永不抛」；client 新增 `guardWindowErrors`、`pollOnce` catch、帧 `.catch` 的源码断言。

**1.6.7 · 依赖源码缓存：按输入指纹失效 + 有界回收**
- 缓存目录仍是 `<cwd>/.dsh-ris-ide-cache/`，新增 `manifest.json`（原子写：temp + rename），每个文件记录 `{key, kind, at}`；`key` 是输入指纹，不是时间戳：jar 的 `路径|大小|mtime` + zip 条目的 `name|size|crc`（反编译再加工具 jar 的 `大小|mtime` 与参数）。因此依赖 jar 被重新构建/替换后，下一次解析就重新提取或反编译，**不会拿到旧源码**；不靠 TTL 判断“过期”。
- 一致性代价：`javap`/反编译结果是派生文件，`key` 只覆盖输入（jar + 工具 + 参数），工具自身升级（同路径同大小同 mtime）属极少数，换工具路径或重装会自然失效。
- 资源有界：`pruneIdeCache(root, options)` 先删 `at` 超过 30 天的文件，再按最旧优先删到总量 ≤ 64MB、文件数 ≤ 2000；每次写入后触发（60s 限频，`cachePrunedAt`），并顺手清掉 manifest 里已不存在的条目。测试用 `options` 注入更小的上限验证 TTL 与容量两条路径（`__test.pruneIdeCache`）。
- 失败降级链不变：`-sources.jar` → 配置的反编译工具 jar → `javap`；任何一步失败都不写缓存、继续下一步。

**1.6.7 · 调试启动先切日志、变量树无框图标、配置弹窗标明「可选」**
- 点「启动调试 / 重新调试」时，日志面板在发出 `start` 请求**之前**就切到该程序的 `logPath`（`startDebug` 先 `setActivePath(target.logPath)` + `setLogNonce`）；之前要等 40–55s 后调试会话 attach、`applySessions` 才把视图切过去，观感就是「日志切得太晚」。
- 变量树的展开箭头改为无边框图标（`caretStyle`：`border:none; width:12px`），不再借用带边框的 `S.buttonOff`；不可展开的行用同宽空白占位对齐。
- 调试 ⚙ 弹窗文案精简：标题下第一行直接写「可选配置：不填也能看依赖类源码（jar 自带 -sources.jar 会直接用，否则 javap 反汇编）」，字段改为「反编译工具 jar（可选）」「参数（可选）」，缓存目录缩成一行；避免让人误以为必须配置、也避免把 `-sources.jar`（依赖 jar 自带的源码包）和反编译工具 jar 混为一谈。

**1.6.7 · 启动/调试的日志跟随、F8 快速连按、源码打开闪「读取中」**
- 日志跟随跨窗口：`broadcastLogFocus(logPath)` 往 `localStorage` 的 `dsh-ris-ide:log-focus` 写一条（`storage` 事件在同源其他窗口触发），工作台监听后 `selectProgram` 到该程序。此前从侧栏控制台启动/调试，IDE 窗口的日志要等调试会话 attach（40–55s）才切过去。工作台自己的启动/调试也会广播。
- 日志内容按「首次输出」刷新：`startDebug` 先记 `logSizeOf(logPath)` 基线，启动返回后用 `watchLogOutput(logPath, baseline)` 每 500ms 探一次 `/tail` 的 `size`，有第一个新字节就 `setLogNonce` 重读（Maven 编译 10–30s 静默，之前是等下一次无关刷新才显示运行日志）；90s 后放弃。
- F8 连按不再报「取栈失败」：`control()` 用 `controlBusyRef` 串行化（同一时刻只有一个调试控制请求）；`resume` 成功后立即把 `suspended/suspendedThreads/frames/variables` 置空（下一次 F8 看到的是「运行中」）；`applyPollResult` 只在 `suspended === true` 时才 `loadThreads`；`loadStack` 失败时若当前并非停住状态则静默（那是 resume/step 的竞态，不是用户可处理的错误）。
- 打开源码不再闪「读取中」/卡「加载中」：`fsRead` 加 15s `AbortController` 超时（依赖源码按需生成，javap/反编译可能很慢，超时后走常规「读取失败 + 重试」而不是永远「读取中…」）；解析依赖类时先 `note('正在获取依赖源码：<class>（sources.jar / 反编译 / javap）…')`。
- 消除 `正在加载编辑器…` 闪帧：新增 `RIS_IDE_CHUNK_VALUES` 保存**已解析**的 CodeMirror chunk，`IdeTextEditor` 的初始 state 直接取它，新打开的文件首帧就是编辑器（此前每个新文件都要等一次 chunk promise 的微任务）。

**1.6.7 · 断点归属：按源码文件所属程序，不按当前选中的日志**
- 现象：项目 A 正在调试，打开项目 B 的 java 文件点断点 → 报错（JDWP 在 A 的会话里找不到 B 的类）。
- 原因：`toggleBreakpoint` 用 `call('breakpoints', params)`，`call` 默认目标是 `viewPath`（日志面板当前选中的程序）。文件属于谁与日志选中谁无关，B 的类被塞进 A 的调试会话。
- 修复：新增 `programForSourcePath(path)`（程序 `dir` 是文件路径前缀，取最长匹配），`toggleBreakpoint` 用 `breakPath` = 所属程序的 `logPath`（找不到才回退 `viewPath`）发起 add/remove。B 没有调试会话时宿主编译为 `pending` 预置断点，逗号点照常显示；B 启动调试时自动安装。成功不加 toast（圆点本身就是反馈）。

**1.6.7 · 调试跳回已有文件时切换编辑器页签**
- 现象：在断点文件 A 上 F5 钻进文件 B，之后再执行调试操作（F6/F8/继续）停在 A 时，高亮/定位去了 A，但编辑器仍停在 B。
- 原因：`followDebugLocation` 只在文件**未打开**时调 `openPath`；A 早就是打开的页签，于是既不打开也不 `setOpenFile`，活动页签不变。
- 修复：文件已是页签时 `else if (openFile !== path) setOpenFile(path)` —— 定位到目标文件时总是激活它的页签（随后 `debugLine/debugNonce/visible` 的 effect 会滚动到行）。

**1.6.7 · 当前行一变就跟随（切文件 + 滚到行）**
- 调试器的「当前位置」就是挂起线程的**栈顶帧**。新增一个专门 effect 监听 `dbg.frames` / `dbg.suspended`：只要暂停中且栈顶帧的 `className:line` 变化，就 `followDebugLocation(top)` —— 切到该文件的页签（已打开也切）、滚动到该行（不在可见区才居中滚动）、高亮。
- 这样无论帧更新走的是哪条路径（SSE `debug` 事件、JSON 轮询、手动点栈帧、跨程序自动切换 `applySessions`），编辑器都会跟过去；`loadStack` 里原有的直接调用保留（即时性），`followedFrameRef` 记录已跟随的 `class:line` 去重，避免同一行滚两次；恢复运行（`suspended !== true`）时清空记录，循环里再次命中同一行也会重新跟随。

**1.6.7 · 非关键信息走底部状态栏，toast 只留给用户必须知道的错误**
- 新增状态栏通道：`statusText` + `statusNote(text, ttl)`（默认 4s 自清、0 表示常驻到被清），渲染在底部状态栏右侧（`data-ide-status-text`），不抢焦点、不打断操作。
- 依赖源码解析的过程提示改成状态栏：`statusNote('正在获取依赖源码：<class>…', 0)`，解析结束 `setStatusText('')`；失败也不再 toast —— 调试面板里仍有一行「无源码」提示，用户可继续/步出。
- 「正在启动 X…」同样改走状态栏（日志区本身会显示启动标记）。
- 底部状态栏删掉静态操作帮助（`Ctrl+S 保存 · …`、`F5 步入 · …`），这些内容在右下角「?」帮助面板里已有；状态栏右侧改用于瞬时状态。

**1.6.7 · 调试自动打开的文件，调试行离开后自动关闭**
- `followDebugLocation` 用 `debugOpenedRef` 记住「由调试器自己打开」的页签；调试行移动到另一个文件时，`closeDebugOpenedExcept(path)` 关掉上一个（`forgetDoc` + 从 `openFiles` 移除），避免单步风暴留下大量页签。
- 安全边界：**有未保存修改的页签不关**（`isDirty`），并从调试所有权里释放；用户自己打开/关闭该文件也会释放所有权（`openPath` 里非调试打开时移除、`closePath`/`closePaths` 同步清理），调试器不会关掉用户主动打开的文件。

**1.6.7 · 浏览器快捷键只在独立 IDE 窗口里屏蔽；DSH 页面完全不接管**
- 根因：`Ctrl+W`（关页签）、`Ctrl+R`（IDE 全局搜索）、`F5..F8`（调试）等 window 级 keydown 只看「面板 visibile」，把 DSH 页面里属于浏览器/宿主的快捷键也 `preventDefault` 了。
- 规则（用户口径）：**DSH 页面零拦截**（Ctrl+W/Ctrl+R/Ctrl+N/Ctrl+O/F5 等全部保持浏览器与 DSH 的语义）；**独立 IDE 窗口整页（body）接管与 IDE 冲突的键**。`ownsKeyTarget()` 现在只返回 `inStandaloneIdeWindow()`（`window.__dshRisIdeWindow`：`apply()` 置 false、`mountStandalone()` 置 true），三处 window 监听（Ctrl+W、IDE 搜索 Ctrl+R、调试 F5..F8）都先过它。
- 面板网的 `shouldBlockHostChord` 整块删除（DSH 组合键不再被 IDE 吞掉，`Ctrl+N/O/K` 等在两种页面都放行）；`shouldBlockHostChord`/`DSH_CHORDS` 仅保留导出与单测，不再挂在 keydown 上。IDE 窗口仍拦 `Ctrl+R`（转成 IDE 搜索，防止重载丢状态）与 `Ctrl+W`（关页签而非关窗口）。
- 调试期间 F5 不再刷新：`debugShortcut` 在**有调试会话**时接管整排 F5..F8；VM 运行时 F5/F6/F7 返回 `{ kind: 'swallow' }`（只 `preventDefault`、不动作），只有暂停中才变成步入/步过/步出 —— 现象是「调试中点了别处，按 F5 页面就刷新、调试视图全丢」，根因就是此前仅在暂停中才接管 F5。无会话时 F5 保持浏览器刷新。

**1.6.7 · 简化控制台：项目列表恢复滚动条；顶部消息 5 秒自动消失**
- 项目列表一开始是 `display:flex; flex-direction:column` 的滚动容器，行没有 `flex: 0 0 auto` —— 程序变多后 flex 收缩把每行压到 17px，内容还被 `overflow:hidden` 裁掉，列表高度永远等于内容高度，于是「没有滚动条」。行样式补 `flex: '0 0 auto'`（保持自身高度），列表按 `compactList` 的 `overflow:auto` 正常出现滚动条。
- 控制台顶部消息（`state.note`）改为 5 秒后自动清除（`useEffect + setTimeout(5000)`，`[state.note]` 变化重置）；扫描错误/扫描状态这类持续状态不受影响。

**1.6.7 · IDE 窗口的控制台：启停/调试时给程序行加遮罩**
- `ProgramWorkbench` 新增 `consoleBusy`（程序 id），`consoleStart`/`consoleStop`/`consoleDebug` 在请求期间置上、`finally` 清空；`consoleBody` 的行按 `consoleBusy === program.id` 渲染与侧栏一致的 `dsh-ris-ide-loading` 遮罩（spinner + 「启动中…/停止中…」，吞掉点击），工作台 `<style>` 注入 `PROGRAM_LOADING_CSS`。这样 40–55s 的 JDWP 重启期间不会再被点第二次。

**1.6.8 · 编辑器失焦选区、页签自动滚入、Ctrl+R 用选区搜索**
- **失焦不再残留选区**：选区颜色此前不区分焦点——chunk 主题与 `SELECTION_CSS` 都同时给了 `&.cm-focused` 与无焦点两组颜色，CodeMirror 失焦后仍绘制选区层，于是 Ctrl+A 再点别处整片青绿还在。现在只有 `.cm-editor.cm-focused` 上色，`SELECTION_CSS` 增加 `.cm-editor:not(.cm-focused) .cm-selectionBackground{background:transparent !important}`（选区数据本身不动，只改绘制）。
- **当前文件页签自动滚入可视区**：页签条是横向滚动容器，打开/跟随调试器切换文件时只改 active 样式，active 页签可能完全在视口外。页签 span 加 `data-tab-file` + `tabElsRef`，effect 依赖 `[openFile, openFiles.length]`，用 `getBoundingClientRect()` 与 `strip.scrollLeft/clientWidth` 夹取（左右各留 8px）只滚页签条本身。
- **Ctrl+R：单行选区直接当搜索词**：`selectedEditorText()` 只在选区落在 `.cm-content` 内、非空、**不含换行**、长度 ≤ `GLOBAL_FIND_SELECTION_MAX`（200）时返回文本；命中时 `setTreeQuery(选中文本)` 再聚焦搜索框（既有 debounce 检索自动跑），否则保持「聚焦搜索框 + 全选查询」。多行选区与页面其它位置的选择一律忽略。

**1.6.8 · 搜索结果显示工作空间相对路径；调试区只用类名**
- `displayWorkspacePath(path, cwd)` 是唯一的路径显示口径（`cwd` 末尾分隔符忽略，工作区外保持绝对路径）。搜索结果与「最近打开」下拉的可见文本改为相对路径，`title` 仍是全路径（悬停可看完整位置）；选择/打开逻辑仍用绝对路径。
- 调试区（断点列表、调用栈）**用类名标识位置，不显示文件路径**（用户口径：路径在这里是噪音）。断点行是「类名:行」（title 同为「类名:行」），调用栈行是「方法@行」（title 为「类名.方法:行」）。此前短暂实现过「断点行/栈行显示源码相对路径」，已按用户要求撤销，连同 `annotateBreakpointPaths()` / `annotateFramePaths()` 与合并时的 `relPath` 保留逻辑一并删除。


**1.6.8 · 断点数据统一为全局单一数据源（修复「都是历史、取消后不更新」）**
- 根因有两个：① `mergeBreakpointList` 保留所有本地 `pending/failed` 条目，而一次 poll 只返回**当前选中程序**的断点，其它程序/已取消的条目再也没有机会被清掉；② 断点页签的 `removeBreakpoint` 调 `/debug/breakpoints` 时**没带第三个 `breakPath`**，请求默认发到当前选中程序，取消别的程序的断点会删错会话（或失败），本地却已删，之后轮询又「复活」。
- 现在只有一个 `GLOBAL_BREAKPOINTS` 列表：`mergeGlobalBreakpoints(payload)` 只替换 `payload.logPath` 这个程序的切片（其它程序原样保留），同一程序宿主不再返回的旧条目直接丢弃；本地乐观条目（`pending + optimistic`，JDWP 请求最长等 30s ClassPrepare）保留 `BREAKPOINT_OPTIMISTIC_MS = 35000` 后自动清掉；`setBreakpoints()` 是唯一写入口，gutter 圆点、断点页签、状态栏计数、删除/清空逻辑都读它（程序切换时的 `dbg` 重置也用 `globalBreakpointsSnapshot()`，不会把别的程序的点藏起来）。
- 增删断点都带所属程序：gutter 用 `programForSourcePath` 解析 `breakPath`，`removeBreakpoint` 用 `bp.logPath`（pending/failed/已安装条目都带）作为 `/debug/breakpoints` 的目标，成功后只删「该程序 + 该 class:line」；「清除全部」按列表里出现的所有 `logPath` 逐个清宿主（含当前选中程序），不再只清一个会话。

**1.6.8 · 超大文本文件的只读分页预览（滚动加载，不整读、不能编辑）**

超过 512 KB 的文本文件以前只显示「文件过大，不支持预览」。现在按页打开只读预览：

- 宿主新增 `GET /dsh-ris-ide/fs/window?sessionId&path&offset&length`（窗口默认 256 KiB、单次上限 1 MiB）：返回 `{ok, kind:'text-window', offset, next, eof, size, mtimeMs, text}`。`next` 由 `utf8CompleteLength()` 把窗口尾部的半个多字节字符切掉再算，下一页从该字符的第一个字节继续，因此不会出现 U+FFFD、也不会重复/丢字；第一页顺带做 NUL 嗅探，二进制直接返回 `kind:'binary'`。原 `/fs/read` ≥512 KB 仍返回 `kind:'too-large'`（旧语义不变）。
- 客户端 `fsRead` 把 `too-large` 连同 `size` 抛给 `ensureDoc`，后者建立 `{kind:'large-text'}` 文档并调 `loadLargeTextPage()` 取第一页；`fsWindowRead()` 按 `next` 续页，`LARGE_TEXT_WINDOW_BYTES = 256 KiB`，缓冲区超过 `LARGE_TEXT_MAX_BYTES = 16 MiB` 时按行边界**释放前部**（`trimLargeTextFront()`），并把释放行数记在 `dropLines` 里：虚拟行号 = 释放行数 + 当前缓存行号，滚动位置同步上移，所以内存有上限、还能一直往下看；横幅显示「已释放前面 N 行」并提供「从头加载」重新从字节 0 取。
- 渲染用 `LargeTextPreview`：固定 18px 行高 + 只渲染可视行，滚动到距底 240px 时取下一页；不挂 CodeMirror、不提供保存，结构上不可能编辑。横幅显示「只读预览 · 大文件 / 已加载 x KB / 总大小 / 滚动到底继续加载」。

**1.6.8 · Ctrl+F 把选中的文本带入编辑器/日志的查找框**

编辑器（CodeMirror）和日志窗格都各有自己的查找框，但之前 Ctrl+F 只是把空框打开：用户先选中一段文本再按 Ctrl+F 还要重新敲一遍。现在三处都从当前高亮取词（多行选区取第一个非空行）：

- 编辑器：`src/chunks/codemirror.js` 新增 `searchSelectedText(view)`，在 `openSearchPanel` 之前 `dispatch` 一个 `setSearchQuery.of(new SearchQuery({ search: picked, literal: true }))`（`literal: true`，选中的正则元字符按字面搜）；菜单项和 `Mod-f` 键位都先取词。chunk 需重建（`/tmp/tsdown-build/node_modules/.bin/tsdown --config tsdown.config.mjs`）。
- 日志窗格：`lib/client.js` 新增 `selectedLineTextIn(element)`/`firstSelectedLine(text)`，日志根节点的 Ctrl+F 处理里先取选中行再 `setFindText`。
- 兜底文本编辑器（textarea `IdeEditor`）：Ctrl+F 时从 textarea 的 `selectionStart/End` 取选中行填进它自己的查找框。
- 文件检索框（Ctrl+R / F3）不受影响：Ctrl+F 从不写 `treeQuery`。

**1.6.8 · 公网 npm 发布改由 GitHub Actions 的 OIDC 可信发布（不再需要 npm token）**

npm 的发布 token 最长 90 天，而且 npm 没有创建 token 的 API，Jenkins 每季度换凭据很容易在发版当天踩到过期。现在公网 npm 发布改走 npm 的 **Trusted Publishing（OIDC）**，彻底不需要 token：

- 新工作流 `.github/workflows/publish-npm.yml`：`workflow_dispatch` + 每 2 小时（`23 */2 * * *`，排在 `mirror-from-gitee` 之后 6 分钟）；取仓库里最新的裸版本 tag（`^[0-9]+\.[0-9]+\.[0-9]+$`），与 `npm view dsh-ris-ide version` 比较，只有 npm 落后时才 `git checkout` 该 tag、校验 `package.json` 版本、`npm publish --access public`。`id-token: write` 由 GitHub 签发 OIDC 令牌，npm 侧凭 Trusted Publisher 配置（Owner `ris-cloud`、Repo `dsh-ris-ide`、Workflow `publish-npm.yml`）直接认证；runner 上先 `npm install -g npm@latest`（可信发布要求 npm ≥ 11.5.1）。
- **`repository.url` 必须指向 GitHub 镜像**（`git+https://github.com/ris-cloud/dsh-ris-ide.git`）：可信发布会在 npm 侧**自动**生成 provenance，并校验它和 `package.json` 的 `repository` 一致；源码 Gitee 通过 `homepage`/`bugs`/README 展示。
- **不加 `--provenance`**：可信发布时 npm 会自动附加 provenance（无需该 flag，也无法关闭）；`repository` 已指向 GitHub 镜像，所以 provenance 校验能通过。
- Jenkins `ris-jenkins/master_dsh-ris-ide`：`PUBLISH_PUBLIC` 现在只决定「推 Gitee（干净快照 + 同名 tag）」，公网 npm 由上面的工作流自动跟随新 tag；流水线不再读取 `npmjs` 凭据。
- 时机：npm 上架会晚于发版最多约 2 小时（镜像 + 定时）；需要立刻发布时在 GitHub Actions 里手动 Run 一次 `publish-npm`。
- 已发布的版本不动：若 tag 已存在或 npm 更新，工作流直接跳过，可安全重跑。

**1.6.6**：**文件树回到共用 SSE（不额外开连接），并修掉“展开闪一下”**。
- **共用 SSE**：`tree` 重新作为现有 `risStreamHub` 单条 EventSource 的一个 topic（不新增连接）；宿主只给“已打开的目录”各挂一个非递归 `fs.watch`（LRU 上限 128、`persistent:false`、无订阅者即关闭），事件经 `.git`/回收站段过滤 + `git check-ignore`（复用缓存）后 **800ms debounce** 合并成批量帧（≤200 条/帧）。
- **客户端资源守卫**：按目录 **800ms 节流**；`sameTreeEntries` 命中（行完全相同）时**不 `setLevels`、不重绘**（gitignored churn / 内容修改不触发渲染）；页面隐藏时丢弃 tree 帧，回到前台只做一次 `recoverTree`。
- **修掉“展开后整树闪/换根”**：`fsTree` 原先把 `listing.path`（被读的子目录）记成 workspace cwd，导致展开后工作台 `cwd` 变成子目录、整树以它为根重载两次；现在只记请求的 workspace `treeCwd`。
- **删除树的 `loading` 状态**（每次 true/false 都是全树渲染）；**首次展开“先读后展开”**（无占位行/busy 中间态，读完一次 `setExpanded`）。
- `recoverTree`/手动 ⟳ 保留。测试：**214/214**。

**1.6.5**：**文档拆分 + 一批交互修复**。
- **文档**：`README.md` 只留用户向说明（功能/安装/使用/配置/卸载），开发维护内容全部移到 `DEVELOPMENT.md`（不打包进 npm 包）。
- **CRLF 文件一打开就显示 `*`**：CodeMirror 内部把 `\r\n` 归一成 `\n`，旧代码拿归一后的值跟磁盘原文比较 ⇒ 永远是“已修改”。读取时记住文件 EOL、文档内部统一 LF，保存时按原 EOL 写回（`docTextForDisk`）。
- **“不保存”关闭后再次打开同一文件仍是 `*`**：关闭/丢弃统一 `forgetDoc(path)`（清 document + viewer 上报的 dirty），重新打开不在页签里的文件时先丢弃残留 document、强制从磁盘读。
- **文件树滚动位置**：`overflow-anchor: none` + `scrollbar-gutter: stable`、行点击 `focus({preventScroll:true})`；加 **scroll watchdog**（逐帧对比用户最后位置，行点击不算滚动，滚轮/触控/键盘/拖滚动条期间不抢）与 **5s rAF 保持**；恢复目标不被 clamp 后的 0 覆盖；手动展开后 **15s 内忽略 watcher 刷新，`recoverTree` 也跳过**刚手动加载的目录（展开后 1~2s 的“跳顶”就是它们引起的）。
- **关页签后树高亮不消失**：树高亮只把仍在 `openFiles` 里的文件算作选中，关闭时清掉 `selectedPath`。
纯客户端改动（刷新页面即生效）。测试 214/214。

**1.6.4**：**源码区文件页签的滚轮滚动覆盖整条页签栏**——1.6.3 把滚轮监听挂在页签条元素自身上，页签栏上的 `◀`/`▶` 翻页按钮和空白处滚轮不生效；现在监听挂在**整条页签栏**（`data-editor-tabs-bar`），在页签、翻页按钮或空白处滚轮都会横向滚动里面的页签条（事件处理时再定位内层 `[data-tab-strip]` 并 `preventDefault`，不会把页面滚走）。调试面板页签条同样保持可滚轮。测试 214/214。

**1.6.3**：**页签条支持鼠标滚轮横向滚动**——调试面板的「断点/线程/调用栈/变量/事件」页签条与源码区文件页签条，鼠标**普通滚轮**在页签条上即可左右滚动（不必 Shift+滚轮，也不会把页面滚走）；以 `deltaX` 为主的手势（触控板横滑）仍交给浏览器，页签全部装得下时不拦截。用的是原生 `wheel` 监听（`{passive:false}`——React 的 `onWheel` 是 passive，`preventDefault` 不生效），并把 `deltaMode` 归一成像素（行×16 / 页×可视宽）。测试 213/213。

**1.6.2**：**调试面板的「断点 / 线程 / 调用栈 / 变量 / 事件」由一排按钮改成多页签**——正文顶部是真正的页签条（`role="tablist"` + 5 个 `role="tab"`，与源码区文件页签同一套视觉：平页签贴住下方内容，活动页签没有下边框、与内容连成一体），每个页签右侧带**行数徽标**（断点 3 / 线程 9 …，为 0 时不显示）；正文只渲染当前页签（`data-debug-section`），面板变窄时页签条横向滚动而不是换行。测试 211/211。

**1.6.1**：**日志区条栏上移到面板标题栏，按钮改图标**——日志正文上方原本有一行「服务状态 + 换行/字号/查找/跟随」条栏，现整行删除，改为日志面板**标题栏**内：服务状态（`运行中 (pid N)` / `已停止 (pid N)`，无 pidfile 时 `未运行`）+ 图标按钮（换行、A−、A+、跟随；沿用调试标题栏的 22px 定宽 / 20px 行高，换行与跟随是内联 SVG，状态为关/暂停时置灰）；**不放「查找」按钮**（日志内 `Ctrl+F` 仍打开正文里的查找栏）。效果：日志正文多出整行高度，状态与按钮不随日志滚动。纯客户端改动，刷新页面即生效（宿主无需重启）。测试 211/211。

**1.6.0**：**日志只显示「本次启动」**——同一个 `logName` 的日志文件是多**追加**的（`run-with-log.*` 每次启动写一行 `--- <名字> started <时间> ---`），以前面板/`ris_dev_logs` 会把上次运行的内容也混进来。现在：① 宿主 `readTailWindow` 的**最新窗口**从最后一条 start 标记开始切片（`trimToCurrentRun` / `lastStartMarkerOffset`，按字节定位，UTF-8 安全）；`/tail?before=` 翻历史时**不切**，旧内容仍可「加载更多」看到；② 流式 `tail` 检测到新增内容里出现 start 标记（服务被重启/重新调试）时**重发整窗**而不是 append，客户端立即切到新一次运行；③ 客户端也做了同样的裁剪（兼容未重启的旧宿主）。另外把内存闸门的下限做成可注入（`options.minFreeMemoryBytes`，测试用 `1` 绕过），测试 211/211。

**1.5.6**：**复制/新建/重命名后目录里看不到新条目**——宿主的 `/tree` 用 `git ls-files` 结果做过滤，这份结果缓存 **30 秒**；`/fs/copy` 之后立刻重读目录时缓存还是旧的，新文件被过滤掉。修复：① 宿主 `/tree?fresh=1` 会**立即**让该仓库的可见文件集合失效再列目录（`invalidateAllowedCacheNow`，绕过 1 秒节流）；② 客户端所有强制刷新（`fsTree(force)`，即新建/复制/粘贴/重命名/拖动/标题 ⟳）都带 `fresh=1`；③ 再加一次 **1.1 秒后的延迟重读**兜底，即使宿主是旧版本（忽略 `fresh`）也能在 watcher 让缓存失效后补上。**注意**：`fresh` 是宿主改动 ⇒ 需要重启 `dsh web` 才彻底生效；不重启时第 ③ 条也能让新文件出现。测试 209/209。

**1.5.5**：**「复制」= 复制并生成副本，且先弹窗改名字**——右键「复制」不再只是放内部剪贴板，而是弹出「复制副本」对话框：名称预填 `xxx - 副本`（扩展名保留：`A.java → A - 副本.java`、目录 `pkg → pkg - 副本`、点文件 `.gitignore → .gitignore - 副本`），可改成任意名字再确认；确认后走宿主 `/fs/copy` 在**同目录**生成副本，目标同名会报「已存在」，不可与原文件同名；副本生成后可 `Ctrl+Z` 撤销（删掉副本）；`Ctrl+C / Ctrl+X` 仍是复制/剪切到剪贴板供粘贴（菜单项只保留「剪切」）。

**1.5.4**：**文件/文件夹重命名**——目录树右键菜单新增「重命名」（快捷键 **F2**），弹窗预填当前名、实时预览目标路径；确认后走宿主 `POST /fs/move`（同名目录内改名，`rename(2)`，目标已存在会拒绝 `409`）；**打开页签、未保存草稿、最近历史都跟着改路径**（`remapPath()`：文件本身/目录前缀两种映射），重命名可 `Ctrl+Z` 撤销（撤销时路径再映射回来）；重命名文件夹时，其下所有打开的文件一起跟随。测试 206/206。

**1.5.3**：**当前行高亮不再盖住选区**——当前行底色是画在行元素上的，跨行选中时它会把选中行（含当前行）的选区颜色压掉。现在 chunk 里加了一个轻量 `ViewPlugin`（`selectionFlag`）：只要有非空选区就给编辑器加 `dsh-ris-ide-has-selection` 类，面板 CSS 随即把 `.cm-activeLine` / `.cm-activeLineGutter` 底色置为透明，并把 `.cm-selectionLayer` 提到 `z-index:5`；所以选中文本、Shift 多行选择时，当前行显示的是**选区颜色**（青）而不是当前行底色，未选中时当前行底色照旧。chunk 已重建（1.17MB）。测试 205/205。

**1.5.2**：**「新建文件」子菜单补上「普通文件」并排第一**——无后缀类型（`ext: `），文件名**按输入原样保存**（`Makefile`、`.gitignore`、`README`，或你自己写后缀如 `notes.txt` 也照写，不自动补 `.xxx`）；标题显示「新建普通文件」，占位提示「按输入保存，不自动加后缀」；其余类型（Java 类、JS、TS、Vue…）仍自动补后缀。测试 205/205。

**1.5.1**：① **编辑器选中内容有高亮了**——页面样式可能盖掉 CodeMirror 自绘的选区（表现为"其他匹配高亮、自己选的不高亮"），面板现在直接注入 `SELECTION_CSS`：选区青色 `rgba(86,182,194,0.42)`（聚焦时 0.50），其余匹配琥珀 `rgba(210,153,34,0.30/0.45)`，chunk 里的 `surfaceTheme` 同步改色并重新构建；② **日志里 Ctrl+C 能复制了**——树面板的 Del/Ctrl+C/X/V 处理器原来只在输入框/编辑器内让位，选中日志文字按 Ctrl+C 仍会被它截走去复制文件；现在这些键**只在树容器拥有焦点时**生效（树可聚焦、点击行即获得焦点），日志/其他区域的文本选择走浏览器原生复制。测试 204/204。

**1.5.0**：**一条 SSE 连接 + 会话切换自愈**（承接 1.4.0 的阻塞问题，也是"IDE 开着 dsh 仍被阻塞"的收尾）：① `tail` 与 `debug` 不再各自开 EventSource，全部并入 `risStreamHub()` 的**同一条**连接（`topics=tail,debug,…` + `tail=`/`path=`/`bytes=` 参数，宿主本来就支持多话题合并），插件**总共只占 1 个连接**；hub 对硬失败（`readyState 2` 即 400/404，或连续 5 次错误）**停止重连**，避免陈旧会话无限重试。② **陈旧 sessionId 自愈**：右侧栏 tab 是 `keepMounted`，切换会话后仍带着旧 `sessionId`，宿主对所有路由回 **400**（`no working directory for session`）——现在客户端记住**上一次成功的 cwd**（`dsh-ris-ide:last-cwd`），所有路由都带 `cwd`，宿主允许用客户端 cwd 兜底（`scopeCwd()`），面板在会话切换/`dsh web` 重启后不再整块失效。③ 仍拿到 400 时：树只提示「会话上下文已失效：切换会话后请重新打开 IDE 标签」并**停止自动重试**（不再刷宿主）。测试 202/202。

**1.4.7**：**大幅减少浮动提示**——原则改为"界面已体现的不提示，只提示看不见的结果与异常"。去掉 27 条成功提示：保存成功、启动/停止成功、控制台切换项目、关闭页签（单个/批量/关闭其他）、加/删/预置/清断点、自动切到调试中的项目、布局还原、文件树刷新、新建文件/文件夹、粘贴/移动、撤销、用官方预览打开、没有可关闭页签等。**保留**：所有失败与异常（保存/启动/停止/断点/撤销/移动/粘贴/新建失败、取线程/栈/变量失败、宿主未响应）、重要警告（文件数上限、历史文件不存在）、以及**界面上看不到结果**的动作（复制/剪切到剪贴板、移到回收站并提示 Ctrl+Z、断点类名无法派生、无源码可定位）。测试 200/200。

**1.4.6**：**关页签快捷键与浏览器 Ctrl+W 的冲突**——浏览器（Chrome/Edge/Firefox）把 `Ctrl+W` 保留为"关闭标签页"且**不允许网页 `preventDefault` 拦截**，所以面板新增浏览器拿不到的等价键：**`Alt+W`**、**`Ctrl+Alt+W`**（`Ctrl+F4` 原有）；`Ctrl/Cmd+W` 仍照旧接管（在 DSH 桌面壳/Electron 里能真正拦下浏览器关闭）。`closeTabChord()` 为纯函数（Shift 组合不接管，避免抢 Ctrl+Shift+W），命中后 `preventDefault + stopPropagation + stopImmediatePropagation`；帮助面板补该行，测试 199/199。

**1.4.5**：**标题栏按钮不再触发双击最大化**——各区域标题栏的双击最大化现在先判断事件目标：落在 `button / input / textarea / select / a / label`（或 `[data-no-maximize]`）上就直接放弃（调试工具条、搜索框、`⌖`/`⟳`、`A-`/`A+`、`⤢` 等按钮双击只执行自己的动作），只有点在标题文字/空白处才最大化；`headerDoubleClickIsTitle()` 为纯函数并有测试（198/198）。

**1.4.4**：**历史里已不存在的文件自动移除**——从搜索框历史或页签 `▾` 下拉选一个**已被重命名/删除**的文件时，先用 `fileMissing()` 探一下（`GET /fs/read`，404 ⇒ 不存在），命中即把它从最近历史里删掉并提示「文件不存在，已从最近历史移除：xxx」，不再打开一个注定失败的页签；网络异常不算删除（保留记录）。页签下拉里"已打开"的行仍然只是切换激活，不做探测。测试 197/197。

**1.4.3**：**搜索框聚焦即出最近历史**——工作空间检索框获得焦点且内容为空时，下拉显示**最近打开的文件**（最新在前，`●` 表示当前已打开；点一行即打开该文件）；历史记录总数上限 **20**（`SEARCH_RECENT_LIMIT`，随布局持久化到 `recent`），`searchHistoryEntries()` 生成行并去重，输入任意字符就切回检索结果，Esc/失焦关闭。测试 196/196。

**1.4.2**：① **批量关闭的保存提示**——右键「关闭其他/全部关闭」时，若被关闭的页签里有未保存修改，弹一条提示 **`保存并关闭 / 不保存 / 取消`**（一次处理整批：`bulkClosePlan` 分出 victims 与 dirty，`saveBulk` 逐个写盘，任一失败即中止并保留页签）；② **编辑器页签右侧下拉 `▾`**——列出**已打开的文件**（`●` + 未保存 `*`）以及**最近历史**（打开过、当前未打开），点击即打开；总数上限 **30** 条（`TAB_MENU_LIMIT`），历史随布局一起持久化（`recent`），`pushRecent()` 去重前插、`tabMenuEntries()` 生成行，点击外部/Esc 关闭。新增纯函数 `pushRecent` / `tabMenuEntries` / `bulkClosePlan` 与 4 组测试（195/195）。

**1.4.1**：状态栏去掉 `· 宽 左某/调试某/下某+某px` 的布局尺寸读数（布局仍可拖分隔条调整、`⟲` 仍能还原）。

**1.4.0**（关键修复：**IDE 卡死并阻塞 DSH 的根因**）：插件原来同时开 **6 条 EventSource**（`tail` / `tree` / `debug` / `debugs` / `opens` / `programs`），而 **HTTP/1.1 每个源只允许 6 条连接**、DSH 自己还要占一条会话流 —— 连接池被占满后，浏览器把所有普通请求（发消息、读目录、打开文件）无限排队：表现就是"IDE 开久了以后文件夹打不开、发消息后端收不到"，**关掉 IDE 立刻恢复**（已由用户复现确认）。修复：① 新增 `risStreamHub()`，把 4 个全局话题（`tree/programs/debugs/opens`）合并到**一条** EventSource，按订阅集合动态重连（80ms 合并）；② `tail` 与 `debug` 保留独立流（各自带路径参数），但**标签页隐藏时关闭、回到前台重连**（`useDocumentVisible()`）。现在连接占用：空闲 1 + 宿主 1 = 2；看日志 3；调试中 4 —— 始终低于 6。新增回归测试断言 `new EventSource` ≤ 3 且四个话题都走 hub。

**1.3.14**：**只屏蔽 DSH 自己定义的快捷键，浏览器快捷键全部放行**——从 DSH 的快捷键目录里取出 `web:linux/windows` 的默认绑定，做成精确黑名单：`Ctrl+/`（快捷键面板）、`Ctrl+Alt+,`（设置）、`Ctrl+N`（新建会话）、`Ctrl+K`（搜索会话）、`Ctrl+O`（添加工作区）、`Ctrl+Shift+O`（打开本地）、`Ctrl+Alt+P`（工作区文件）、`Ctrl+Alt+G`（重命名会话）、`Ctrl+Alt+F`（**复制/分叉会话**）、`Ctrl+Shift+A`（归档）、`Ctrl+Alt+B`（左栏）、`Ctrl+Shift+B`（右栏）、`Ctrl+Alt+T`（浏览器）、`` Ctrl+` ``（终端）。其余一律放行：`F5`/`Ctrl+F5`（刷新）、`Ctrl+Shift+R`（硬刷新）、`F11/F12`、`Ctrl+Shift+I/J/C`（开发者工具）、`Ctrl+P`、`Ctrl+Shift+T`、以及所有文本编辑组合；`Ctrl+R` 仍是 IDE 的「定位检索框」（所以它不刷新，属于与 IDE 冲突的那一个）。实现换成 `DSH_CHORDS` 精确集合 + `chordOf()` 规范化（`primary`→`ctrl`），并清掉了先前"大范围吞键"的重复实现。

**1.3.13**：**IDE 内屏蔽 DSH 的全部快捷键**——扩展规则：① `Ctrl/Cmd+字母`（无 Alt/Shift）只放行原生编辑 `c v x a z y s f w`，其余全吞（`b/e/i/j/k/l/n/o/p/u…`，其中 `n` 是 DSH 新建会话）；② `Ctrl+Shift+…` 只放行 `Ctrl+Shift+Z`（重做）与 `Shift+Tab`（反向聚焦）；③ **`Ctrl+Alt+…` 与 Alt 单键组合全部吞掉**（`Ctrl+Alt+F` 复制会话、`Ctrl+Alt+G` 重命名、Alt+方向键等）；④ **功能键**只放行 IDE 自己的 `F3`（查找）与 `F5–F8`（调试/步进），`F1/F2/F9–F12` 一律吞；⑤ 输入框/编辑器内仍不拦（各自的编辑快捷键优先），浏览器 `Ctrl+R`/`Ctrl+Shift+R` 刷新照旧在最前面被吞。

**1.3.12**：① **`Ctrl+R` 重新作为「定位工作空间搜索框」**——面板内**捕获阶段**先吞掉浏览器刷新（`Ctrl+R` 与 `Ctrl+Shift+R` 两态都拦，**连编辑器/输入框聚焦时也拦**，避免把整个 GUI 刷新掉、丢失 IDE 状态）；不带 Shift 的形式同时聚焦并选中搜索框内容，`F3` 仍作别名。② **Shift 组合也纳入屏蔽**：`Ctrl+Shift+A/F/G/…` 一律吞掉（DSH 的 archive/find 等），只放行 `Ctrl+Shift+Z`（重做）与 `Shift+Tab`（反向聚焦）。

**1.3.11**：**避开 DSH 的「复制会话」快捷键**——从 `dsh-client-ui-workspace` 的注册里查到 DSH 绑定：`session.fork`（Fork session = 分叉/复制会话）= **`Ctrl+Alt+F`**、`session.rename` = `Ctrl+Alt+G`、`session.archive` = `Ctrl+Shift+A`、`session.new` = `Ctrl+N`、`session.search` = `Ctrl+K`、`workspace.add` = `Ctrl+O`。1.3.9 的 IDE 检索正好用了 `Ctrl+Alt+F`（会误触 fork），现改为 **`F3` / `Ctrl+Alt+E`**；并且面板内的屏蔽规则扩展为**连 Alt 组合一起吞掉**（除了 IDE 自己的 `Ctrl+Alt+E`/`F3`），所以在 IDE 里写代码不会误触发「复制会话/重命名会话」。

**1.3.10**：**整个 IDE 范围内屏蔽 DSH 快捷键与浏览器右键菜单**——① 面板根节点 + 文档**捕获阶段**双重拦截：焦点在 IDE 内时，DSH 绑定的 `Ctrl/Cmd+单字母` 组合被 `preventDefault` + `stopPropagation` + `stopImmediatePropagation`（宿主适配器在 document 上收不到事件）；② **保留**文本编辑与自用键：`Ctrl+C/V/X/A/Z/Y/S/F/W/R/N`、`Tab/Enter/Esc/Backspace/Delete`、方向键/翻页、`F5–F12`，以及 IDE 自己的 `Ctrl+Alt+F`/`F3`/调试键；③ 编辑器（contenteditable）与输入框内的按键完全不拦截；④ 右键菜单：面板内 `contextmenu` 在**捕获阶段**就 `preventDefault`，树/编辑器仍弹自己的菜单；⑤ 帮助面板加一行说明。

**1.3.9**：全局检索快捷键改为 **`Ctrl/Cmd+Alt+F`**（另有 **`F3`** 别名）——`Ctrl+R` 与 DSH 自身绑定冲突、`Ctrl+F` 归编辑器/日志，`Ctrl+Alt+F` 无宿主/浏览器绑定；帮助面板同步，`GLOBAL_FIND_LABEL` 常量化避免文案漂移。

**1.3.8**：IDE 全局快捷键由 `Ctrl+F` 改为 **`Ctrl/Cmd+R`**（聚焦工作空间文件检索框，`preventDefault` 因此不会刷新页面）；`Ctrl+F` 留给编辑器/日志面板自己的查找，互不冲突；帮助面板补该快捷键。

**1.3.7**：① **日志「加载更多」**——日志区滚到顶部时，顶部浮出「↑ 加载更多（更早的日志）」按钮，向前翻一页（`GET /tail?before=<上一窗口的 from>`，宿主的 `readTailWindow` 以**整行边界**切窗，前后窗口字节严格相接、不重不漏），prepend 后按滚动高度差**保持当前阅读位置**；到文件开头后按钮消失。② **修纯文本文件崩溃**——`languageForPath()` 对无语言支持的文件返回 `null`，而 CodeMirror 的 `Compartment` 必须持有 Extension，`EditorState.create` 直接抛 `Cannot read properties of null (reading 'extension')`（`client.js:638 slot entry crashed`）；现在 `languageCompartment.of(languageForPath(path) || [])`（`setLanguage` 同样处理），`.sh`/`.properties`/`Makefile` 等不再炸。

**1.3.6**：**日志内容支持搜索定位**——日志栏新增「查找」（`data-action="log-find"`，或在日志面板内按 `Ctrl/Cmd+F`）；输入即时高亮**全部命中**（保留原 ANSI 颜色，当前命中用琥珀实底区分），显示 `当前/总数`，`Enter`/`↓` 下一个、`Shift+Enter`/`↑` 上一个（循环），命中行自动滚动到视口中央并**暂停跟随**，`Esc`/`×` 关闭；纯函数 `findLogMatches` 负责大小写不敏感、逐行不重叠匹配（含中文）。

**1.3.5**：**IDE 全局 `Ctrl/Cmd+F` 定位到工作空间搜索框**（聚焦并选中已有内容）；**编辑器的 `Ctrl+F` 优先**——CodeMirror（contenteditable）与内置编辑器（textarea）自己的查找面板先接管，已处理（`defaultPrevented`）或焦点在输入类元素时不拦截；面板上其它位置（目录树、控制台、状态栏、焦点丢失）统一聚焦搜索框。

**1.3.4**：**停/重启 dsh 后目录错误能自愈**——① 目录读取失败时显示"宿主未响应（dsh 可能已停止或正在重启），恢复后会自动重新加载"，并开始**自动重试**（800ms→1.6s→3.2s→6s→10s 封顶）；② 树 SSE 不再在两次错误后关闭（EventSource 自己重连），**重连成功即自动重载根目录与所有已展开目录**，错误横幅自行消失；③ 窗口重新获得焦点/标签页恢复可见时，若仍有错误立即重试；④ 「重试」按钮改为立即重载根 + 已展开层级。

**1.3.3**：展开目录「时快时慢」——① **乐观展开**：点击立刻翻转三角并显示「加载中…」，不再等请求返回才展开（加载失败自动收回）；② **请求去重**：`loadLevel` 以 Promise 做 inflight 共享，展开与 watch 刷新同一目录只发一次请求；③ **刷新让路**：人工/展开刚读过的目录 **1.2 秒内**忽略 watch 刷新（原来会立刻再拉一次，造成闪烁与忽快忽慢）；④ 宿主在树流打开时**后台预热**根仓库的可见路径集合，首次展开不再等 `git ls-files`。

**1.3.2**：文件树的「展开三角」与「目录名」行为统一——三角现在有独立 `onClick`（`data-tree-twisty`），`stopPropagation` 后执行与行点击**完全相同**的动作（选中 + 展开/折叠），不会再出现"点目录名展开、点三角没反应/不一致"；三角区域加宽为可点击指针（14px 居中）。

**1.3.1**：**修「越用越卡 / 展开极慢」的根因**——之前用 `fs.watch(工作区, {recursive:true})` 做树自动刷新，这个工作区有 **35 986 个目录**，光**注册递归监听就要 5.2 秒**（实测，期间整个 dsh 事件循环被阻塞），而且每次打开面板/断线重连都重来一遍、每个监听常驻 3.6 万个 inotify watch。现在改成**只监听"已展开过的目录"**（客户端请求某个层级的 `/tree` 就等于打开了它，`noteTreeDirOpen` 按需挂非递归 watcher，40 个目录 **2 ms**，LRU 上限 128 个，没有订阅者时全部释放）；SSE `topics=tree` 改为订阅这个共享 watch hub；仓库忽略缓存失效**每秒最多一次**（写风暴不再变成每个事件一次 `git ls-files`）；另加 SSE **背压丢帧（>1 MiB 未排空即丢弃）**。

**1.3.0**（性能批次，按"改动内容较多"升中版本位）：① **文件树/展开/编辑器卡顿修复**——树自动刷新原来会把任何变化回溯到"已加载的最近祖先"（多半是工作区根），日志/构建一写就让整棵树反复重读重绘；现在只刷新**变化文件的直接父目录**（父层未加载时，只有"该层出现新条目"才刷新最近已加载层；目录事件刷它自己并加 **800ms 每目录节流**，尾部合并）。② **watcher 与文件树用同一套忽略规则**——宿主对变化路径执行 `git check-ignore --stdin`（与 `/tree` 的 gitignore 语义一致，子仓库的忽略规则各自生效），`.git`/回收站结构性跳过，非仓库目录退回既有段跳过表；**跑着的服务写 `logs/*.log` 不再触发任何树事件**。③ 目录列表 **1.5s TTL 缓存**（展开/折叠/重开秒开；⟳ 与 watch 刷新强制绕过）。④ 编辑器 chunk 在面板挂载 300ms 后**预取**，首次打开文件不必等 1.2 MB 下载。⑤ 并入 1.2.56 的**调试按钮图标化**：内联 SVG（bug+▶ 调试 / bug+⟳ 重新调试 / bug-off 断开 / 圆暂停·圆播放 / 步进三键 / 双箭头刷新），新增「重新调试」按钮（断开+重启一步）。

**1.2.55**：消息/帮助弹窗内容区补 padding——`messageList` 内边距 `6px 10px`（行内不再各自留白），帮助面板加宽到 `min(560px, 74vw)`、最高 `62vh`。

**1.2.54**：① **屏蔽浏览器右键菜单**（工作台根 `onContextMenu` 一律 `preventDefault`，树/编辑器各自弹自己的菜单）；② **编辑器右键菜单**（撤销/重做、剪切/复制/粘贴、全选、注释、增/减缩进、删除当前行、插入行、上/下移行、查找替换、转到行、保存，带快捷键提示与禁用态）；③ **编辑器常用快捷键**补齐：`Ctrl+/` 注释、`Ctrl+G` 转到行、`Ctrl+F` 面板、`Ctrl+Shift+K` 删行、`Alt+↑/↓` 移行、`Ctrl+Enter` 插入行、`Tab/Shift+Tab` 缩进；④ 状态栏右下加 **`?` 帮助**：快捷键（通用/文件树/编辑器/调试）+ 使用说明。

**1.2.53**：文件树支持 **Ctrl+Z 撤销**——删除改为**移入回收站** `<工作区>/.dsh-ris-ide-trash/<时间戳>-<原名>`（不再直接 `rm`），Ctrl+Z 移回原位并恢复原名；新建文件/文件夹、粘贴（复制→删除副本、剪切→移回）、拖放移动同样可撤销（撤销栈上限 50，撤销结果都有 toast）。宿主 `/fs/move|copy` 支持显式 `name`（拒绝 `/`、`\`、`..`），目录列表**永不显示回收站**。`Ctrl+Z` 在输入框/编辑器内不拦截（编辑器仍是自己的撤销）。

**1.2.52**：① 右键菜单「刷新节点」改名 **刷新**，并新增 **复制文件名 / 复制文件路径**（文件夹与文件都有，`navigator.clipboard` + textarea 回退）；② 修「撤销回原样后页签仍带 `*`」——脏标记改为以镜像文本为准（`docDirty`：`doc.text !== doc.saved`），编辑器 `onChange` 也按 `savedText` 计算 dirty，Ctrl+Z 退回到保存内容时 `*` 立即消失。

**1.2.51**：文件树配色细化——`.开头` 的文件与文件夹（`.github`/`.gitignore`/`.vscode`…）统一**灰色**（`fileKind` 返回 `dot`，`#8b949e`，略降透明度）；**Markdown 独立配色** `#9ecbff`（原来与 txt 同为灰 `doc`）。

**1.2.50**（借用官方能力的混合路线）：① **编辑器多语言高亮**——chunk 增加 `@codemirror/lang-{vue,html,javascript,json,xml,yaml,css,sql,markdown}`，按文件扩展名自动切换（`.vue` 为完整 SFC：template=HTML / script=JS-TS / style=CSS，java 仍是原 Java 配色），chunk 1.17 MB（懒加载，不影响核心 bundle）；② **文件树自动刷新**——宿主 `/stream` 新增 `topics=tree`（`fs.watch(cwd,{recursive:true})` + 400ms 合并，只发变化相对路径），客户端按变化路径找到**已加载的最深目录**只重读那一层；外部 git 操作/agent 写文件即时可见，旧宿主自动退回手动 ⟳；③ **富格式交给官方预览**——pdf/doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp/rtf/csv 不再用内置二进制视图，改为 `ctx.sidebarRight.openResource("dsh-resource://file/session/<sid>/<相对路径>")` 打开官方 documentpreview（PDF 分页、Office 转换、Excel 渲染、Markdown/HTML），跨工作区文件用 `absolute/` 形式。

**1.2.49**：文件树增强——① **按类型着色**（java/js/ts/json/xml/yaml/properties/html/css/md/sql/image/pdf/archive，`fileKind`/`fileKindColor`）；② **右键菜单**：文件夹「新建文件 ▸（13 种类型）/新建文件夹/粘贴/复制/剪切/删除/刷新节点」，文件「新建文件 ▸/粘贴/复制/剪切/删除/刷新节点」，待删除有确认框（目录递归）；③ **新建文件**自动补后缀并避免重复（`normalizeFileName`，点开头文件如 `.gitignore` 不补），**`src/main/java` 下弹包名输入框**，按 `cn.com.x` 生成目录（`newFilePath`）；④ **快捷键** `Del`/`Ctrl+C`/`Ctrl+X`/`Ctrl+V`（输入框/编辑器内不拦截）、**拖放移动**（拖到文件夹行或树空白处=工作区根，黄色描边提示）；⑤ 树面板标题加 **`⟳` 刷新**（重读根目录 + 所有已展开目录）；宿主新增 `POST /dsh-ris-ide/fs/mkdir|create|copy|move|remove`（冲突 409、不给工作区根、目录非空需 `recursive:true`）。

**1.2.48**：**撤销 1.2.47 的左侧入口与浮窗**（位置不符合预期）——删除 `sidebar.footer.action` 注册、`RisIdeLauncher`/`IdeFloatWindow`/浮窗 rect 持久化与相关测试；入口回到**官方右侧栏 tab**（`sidebarRightTabs` + `sidebar.right.pane.tab`，`sidebarRight.openTab("dsh-ris-ide:ide")`），与 `dsh-better-sidebar` 依然完全无关。

**1.2.47**：**左侧入口 + 浮窗**——新增 `sidebar.footer.action` 注册（与「本地记忆」同一个座位，官方左栏），点「🛠 RIS-IDE」打开**可拖动/可缩放/可最大化**的浮动窗口（`position:fixed`，rect 记在 localStorage，Esc 关闭），窗口内就是完整工作台（`ProgramsPanel`）；会话继续留在主区域，两边同时可用。右侧栏 tab 保留（`ris_dev_debug open` 仍走它）。会话 id 从官方 `ctx.sidebarRight.mounted` 取；`react-dom` 按平台模块可选加载（缺失时退回非 portal 的 fixed 定位）。

**1.2.46**（解耦完成）：面板改为注册到 **DSH 官方右侧栏**——`inject` 只用官方服务 `sidebarRight` / `sidebarRightTabs` / `slots`；`ctx.sidebarRightTabs.register({id:"dsh-ris-ide", kind:"dsh-ris-ide:ide", title, guide})` + `sidebar.right.pane.tab(.title)` 槽注册面板体与标题；`ctx.sidebarRight.openTab("dsh-ris-ide:ide")` 打开（`ris_dev_debug open`、`ris_dev_logs`、打开队列都走它）；**删除** `betterSidebar` 全部引用（`registerTab`/`registerFileViewer`/`openFile`/`openTab`）与 peer 依赖。至此 IDE 自带文件 API、编辑器、面板宿主，**与 `dsh-better-sidebar` 完全无关**。另附 `Jenkinsfile`（npm install → build → test → pack → Nexus 发布）与本节 §1.7 打包/发布/安装步骤。

**1.2.45**（解耦第二步：自带编辑器）：编辑器改为**自带 CodeMirror 6 + Java 高亮**——`src/chunks/codemirror.js` 用 tsdown 打成 `lib/client-codemirror.js`（约 796 kB / gzip 213 kB），核心客户端**手写、无需构建**，首次打开文件时从宿主 `GET /dsh-ris-ide/bundle?name=codemirror` 懒加载；chunk 自带断点列（点/右键切换）、调试行高亮、`Ctrl+S` 保存、`Ctrl+F` 查找替换、Java 语法着色；加载失败自动回退内置编辑器。删除 `SidebarEditorPane`/`SidebarFileView`/`ViewerBoundary`/`BreakpointGutter`/`viewerContext`/`storeShimFor`/`sidebarService`（原来把文件交给 sidebar 查看器渲染的那套）。构建：`npm run build`（需要 `@codemirror/*` 与 `tsdown`，见 devDependencies；本机从 profile 的 node_modules 软链解析）。

**1.2.44**（解耦第一步）：**自带工作区文件 API**——新增 `GET /dsh-ris-ide/fs/read`（文本 / `binary` / `too-large` 三态）、`POST /dsh-ris-ide/fs/write`（JSON 写 UTF-8）、`GET /dsh-ris-ide/fs/file`（按扩展名给 media content-type + CSP 收沙箱），全部 loopback 围栏、路径解析与 `/tail` 一致；客户端读取/保存/图片 PDF 预览全部改走这三条路由，**删除**对 `dsh-better-sidebar` 的 `/sidebar/api/fs.read`、`/sidebar/write`、`/sidebar/file` 依赖（含旧宿主回退分支）。剩余依赖（下一步）：面板宿主与源码查看器仍注册在 sidebar 服务上。

**1.2.43**：Windows 健壮性——`rotateLogIfLarge()` 的 `truncate` 失败不再抛出（Windows 上 JVM 独占日志时轮转静默跳过，**绝不影响启动**）；`processRssBytes()` 在 Windows 明确返回 0（无 `/proc`，控制台不显示内存列，也不为每行起 PowerShell）；README §1.5 补「Windows 已知差异」清单（内存闸门不生效、无内存列、轮转降级、硬杀后 pidfile 可能残留但会被存活探测忽略）。

**1.2.42**：修「**定位后目录区不滚动**」——搜索下拉点结果会展开目录树并打开文件，但目录树自己的 `scrollTop` 没动（行在折叠区下方，滚动条停在原处）。现在 `locate`/`expandDir` 结束后 `revealRow(path)`：在 `[data-tree-path]` 里找到该行，用 `revealScrollTop()` 只改**树列表**的 `scrollTop`（不滚页面、不用 `scrollIntoView`），并把该行临时高亮；异步层级未渲染完会重试最多 12×60ms。
**1.2.41**：检索再兜底——`cwd` 不是仓库时**向上找最近的 `.git` 仓库**再检索；整棵树都没有 git 就**直接遍历目录**（跳过 `node_modules/target/.git…`，深度 8 / 2 万条上限），保证任何目录下都不会「有输入没结果」。
**1.2.40**：① **修「检索有结果但看不见」**——源码面板工具栏 `overflow:hidden` 把搜索下拉裁掉了（DOM 里有 `data-search-hit`、`innerText` 正常，但被 20px 高的头部裁没）；改 `overflow:visible` + `position:relative; z-index:30`，下拉正常浮在编辑器上方。② **Ctrl+W 不再关掉整个 DSH 窗口**：keydown 改捕获阶段、`preventDefault+stopPropagation`，没有源码页签时只提示；另支持 `Ctrl+F4`。③ **剩余轮询也改流**：`/stream` 增 `topics=debug`（宿主侧维护 `since`，600ms 推增量事件）、`topics=debugs`（1.2s 会话列表，驱动自动切项目）、`topics=opens`（1.5s 待打开请求，1.2s→事件直推不再 fetch）；有 cwd 的话题才要求 sessionId。

**1.2.38**：**轮询改流式（SSE）**（1.2.39 为同内容 + `serveStream` 导出与 SSE 端到端测试的重新打包）——新增宿主 `GET /dsh-ris-ide/stream`（`text/event-stream`）：`topics=tail` 把日志文件增量推给查看器（首帧 `tail` 快照 + 之后 `append` 增量 + `service` 状态，400ms 检查），`topics=programs` 每 2.5s 推控制台行；日志查看器与控制台面板都改成 EventSource 优先、失败两次自动回退原 JSON 轮询（老宿主/缓冲代理照样能用），`/tail`、`/programs` 路由保留。

**1.2.37**：修**文件检索无效**——工具栏检索把 `fsSearch()` 返回的 `dirs`（一个**对象**，宿主 `/search` 只回文件所以通常是 `{}`）当数组用了（`result.dirs.forEach` 抛 `is not a function`），整个下拉框走 `catch` 只剩「检索失败」，看起来就是检索坏了。抽出纯函数 `searchHitPayload()`（`Object.keys`，数组/缺省都兼容）并加回归测试；下拉对 `matches` 缺失也做了防御。

**1.2.36**：**agent 调试默认静默**——`ris_dev_debug` 的所有 action 都不打开/弹出 IDE（只有 `action:"open"` 会），skill 的标准回合去掉 `open`、日志建议 `open:false`；只有用户说「给我看过程」时才 `open`（已开着的工作台本来就会自动跟随）。工具描述里写明这条契约，避免 agent 顺手弹窗。

**1.2.35**：agent 调试前的**状态快照**——`ris_dev_debug {action:"state"}` 一次返回程序行（running/pid/rss）、JDWP（attached/port/suspended）、**断点列表（含预置）** 与预置断点数；`breakpoint_remove` 现在支持 **按 `className`+`line`** 删除（预置断点、活断点都适用，不必先记 `requestId`）。skill / AGENTS.md / `docs/guide-parts/agent-dev-guide.md` 的标准流程都改成「先 `state` 再动手」。

**1.2.34**：`/debug/poll` 的 `breakpoint`/`step` 事件附 **`className` + `line`**（按 `requestId` 回填）——IDE 与 agent 共用同一个 JDWP 连接，「命中了谁的断点」因此可分辨；技能文档补「和 IDE 共享调试状态」的协作规则（不是自己的断点就 `resume` 或按 `threadId` 步进，别顺着别人的路径走）。

**1.2.33**：修「重启调试清掉断点」——`detach()` 现在会把**当前会话里还活着的断点**转存为**预置断点**，重启（detach → attach）时自动重新装上；只有 `⌫ 清除断点` 会真正清空（含预置列表）。

**1.2.32**：调试支持 **Eclipse 风格快捷键**——`F5` 步入、`F6` 单步（跳过）、`F7` 步出、`F8` 继续执行；只在已连接调试时接管（挂起后才接管步进键，避免平时 `F5` 被吃掉不再刷新页面）；挂起时状态栏提示「F5 步入 · F6 单步 · F7 步出 · F8 继续」，按钮 tooltip 也带上键位。

**1.2.31**：修「入口 `SpringApplication.run(...)` 的断点不生效」——根因是调试以 `suspend=n` 启动，等宿主 attach 时 `main` 那行**已经执行完了**。现在：**程序有预置断点 → 调试启动用 `suspend=y`**（JVM 在 `main` 之前停住，attach 时先把预置断点装上再继续），装上 0 个则自动 `resume` 避免挂住；`suspend` 参数改为**三态**（不传=自动、`true`/`false` 显式覆盖，路由与 `ris_dev_debug start` 都支持）。

**1.2.30**：**可以提前打断点**——没有调试会话时点行号/断点栏不再被拒，宿主编排把它记成**预置断点**（`pending`，程序级、可列表/可单独删/可全部清除）；以调试模式启动（`🐞`、`ris_dev_debug start`）**attach 成功后自动装上**并继续生效。提示语变为「已预置断点 …（以调试模式启动后生效）」。

**1.2.29**：调试标题栏**始终显示全部按钮**（`🐞 ⏹ ⏸ ⏵ ⤵ ⤷ ⤴ ⟳ ⌫`）——当前不可用的按钮**置灰并在 tooltip 说明原因**（未连接 / 已经停住 / 命中后才可用），不再按挂起状态整排增删（之前 1.2.17 的「运行中只显示 ⏸」会让人误以为步进按钮不见了）。

**1.2.28**：控制台**高亮当前项目行**（切换后对应行底色 + 左侧琥珀色竖条，`data-console-on`；悬停提示「（当前项目）」）。

**1.2.27**：日志条栏**只保留服务状态**（`服务运行中 (pid 445482)`；无 pidfile 时退回日志文件名），去掉「474.0 KB · undefined 行 · 省略前 410.0 KB」这类体积/行数元信息（顺带修掉 `undefined 行` 的显示问题）。

**1.2.26**：移除日志条栏的「刷新」按钮（日志本来就是自动跟随的，手动刷新多余）。条栏现在是：元信息 · 服务状态 · `换行:开/关` · `A−`/`A+` · `暂停跟随/继续跟随`。

**1.2.25**：① 修 `setLogTabs is not defined`（1.2.24 收敛成单项目时漏删了一段旧的「运行中程序 → 日志页签」effect，已删除）；② **不用启动也能看日志**——只要项目有日志文件，点控制台项目就能看（含历史内容）；只有「还没有日志文件」的项目才显示占位提示，切到未运行项目时提示「（未运行：显示已有日志）」。

**1.2.24**：调试/日志区**去掉页签条**——**点控制台的项目名**即可切换，两个面板**一次只显示这一个项目**（日志只在运行中才加载，未运行显示提示）；控制台的 `▤` 日志按钮删除；**命中断点时自动切换**到对应项目并打开源码定位（新增宿主 `GET /dsh-ris-ide/debugs` 列出所有活动 JDWP 会话，客户端 1.2s 慢轮询发现「别的项目挂起了/有新事件」就切过去并走正常的 poll → 调用栈 → `followDebugLocation` 流程）。

**1.2.23**（= 1.2.22 的内容，重新打包安装：pnpm 对 1.2.22 打了 `Lockfile is up to date` 跳过，装进 node_modules 的仍是旧副本，md5 校验才发现）：修日志区**双滚动条**与**页签被挤掉**——日志面板改为「页签条 `flex:0 0 auto` + 查看器插槽 `flex:1/min-height:0`」，外层不再 `overflow:auto`，只有日志正文滚动；控制台**只有运行中的程序**才加载日志（点项目名/`▤`：未运行只提示「启动之后再点开日志」；`▶` 启动与 `🐞` 调试因刚拉起进程走强制路径）。

**1.2.21**：配色改为**完全跟随 DSH 主题**——去掉 IDE 自己的 `auto/dark/light` 偏好与持久化字段；顶栏外观按钮改为调用 DSH 的 `theme` 服务（`跟随系统 → 深色 → 浅色`，由 DSH 保存；无该服务时按钮不显示）；内嵌编辑器表面色始终按页面明暗给定（`viewerThemeCss(pageDark)`），不再有「IDE 深色但编辑器浅色」的分裂状态与状态栏提示。

**1.2.20**：资源护栏——① **启动内存闸门**：`/proc/meminfo` 的 `MemAvailable` **低于 1 GB** 时拒绝启动（HTTP 507 / `low-memory`，普通启动与调试启动都拦），提示先停服务或调小 `jvmArgs`；② **日志轮转**：单个日志超过 **32 MiB** 时把旧内容复制成 `<log>.1` 并**原地截断**（保留 JVM 的 fd，`/tail` 不断流），启动时先轮转一次，之后每 60 s 对「本插件启动过的服务」再扫一遍；③ 编辑器表面色**始终跟随页面的语法调色板**（页面深色→深色底，页面浅色→浅色底），修掉「深色 chrome + 浅色调色板」造成的深底深字（`.` 看不见）。

**1.2.19**：内存可见性——宿主编排层读 `/proc/<pid>/status` 的 `VmRSS` 随实例列表返回，控制台每行显示**运行中程序的常驻内存**、底部汇总「运行中 N 个 · 约 X GB」；启动未配置 `jvmArgs` 的程序时提示「JVM 最大堆默认≈内存/4，多开建议配 `defaults.jvmArgs`」。

**1.2.18**：轮询收敛——调试 `/debug/poll` **只在已连接时 700ms**（未连接降到 5s，原来空转 1.4 次/秒）；`/tail` 只在日志查看器**可见**时拉（侧边栏的已挂载后台页签不再每秒各拉一次）；`/programs` 只在面板可见且浏览器前台时每 3s（原来无论可见性都拉）；`/opens` 隐藏时不拉。

**1.2.17**：浮动提示恢复**浅橙色**（`#ffd79a` 底 + `#d08b00` 边框、深棕字，深浅主题都可读）；调试标题栏按钮**按挂起状态出现**——运行中只显示 `⏸ 暂停`，挂起（命中/步进）时才显示 `⏵ 继续` 与 `⤵ ⤷ ⤴` 步进；VM 恢复运行后自动清空过期的调用栈/变量与高亮。

**1.2.16**：`💬` 消息按钮从状态栏最左移到**右下角**（状态栏最右端，快捷键提示之后），消息面板也随之锚定在**右下**（`right:10; bottom:30`）。

**1.2.15**：底部状态栏**最左侧加 `💬` 消息按钮**（带未读数，点击展开/收起「本会话消息」面板；点外部或 Esc 关闭）——面板按时间倒序列出本会话所有提示（`HH:MM:SS` + 内容，最多保留 200 条，`清空` 一键清掉），**每条消息右侧的 `×` 可单独删除**（`data-message-remove`）。

**1.2.14**：提示消息改为**底部浮动**（`position:fixed` 底部居中）——多条**垂直堆叠**、最新的在最下面、最多保留 5 条（超出丢最旧）、**5 秒后自动消失**（也可点 `×` 立刻关闭，滑入动画 `dshRisIdeToastIn`）；不再占用工作台的底部行。

**1.2.13**：断点「全部清除」从断点列表上方的文字按钮改成**调试面板标题栏的 `⌫` 图标按钮**（无条件显示、没有断点时置灰；同时清掉客户端「未生效/待应用」标记）。

**1.2.12**：所有**提醒条右侧都有 `×` 可关闭**——工作台提示（`ui.note`）、配置提示、文件读取失败、目录树错误/「宿主版本较旧」提示、日志区的 head 模式/省略提示与错误条、侧边栏面板的配置生成/同步/漂移/提示/错误、以及「未保存修改」确认条（`×`=保持打开）。统一走 `ClosableNotice` + `useDismissedNotices`（按**签名**去重：消息内容变了会重新出现）。

**1.2.11**：编辑器左侧**断点栏也支持右键菜单**（在第 N 行添加/移除断点）——右键与行号右键共用同一个菜单，双击/单击红点的老手势保留。

**1.2.10**：修「加断点后一闪就没了」——① **没连调试**时不再画一个立刻撤销的圆点，而是直接提示「先点 🐞」；② 加失败时**保留「○ 未生效」标记**（悬停看原因、点一下清除），不再静默消失（pending 行仍跨 poll 保留）；③ JDWP 落点改为**对齐到最近的可执行行**（空行/注释/注解行不再报错，成功后提示「对齐到第 N 行」并在该行显示断点）。

**1.2.9**：修「双击断点区加不了断点」——外部断点栏只在挂载时测量行位置，CodeMirror 异步渲染完行号后没人再量，映射为空 → 点击映射不到行；现在用 `MutationObserver`（rAF 合并）持续重测，并在映射为空时**直接从 DOM 行号格取行号**兜底。另：**编辑器自身行号**支持**双击切断点**、**右键菜单**（在第 N 行添加/移除断点，`data-line-menu` / `data-line-action="toggle-bp"`）。

**1.2.8**：日志区条栏精简——去掉「停止服务」按钮（与控制台重复，且容易误停）、去掉「到底部」（`暂停/继续跟随` 已经负责贴底）、不再显示「跟随中 / 已暂停」状态字（看按钮文案即可）；日志查看器为只读，启停只走控制台行（与 `ris_dev_*` 工具）。

**1.2.7**：目录树**逐级缩进**（6px + 每层 11px）；修「`⌖` 定位后展开的分支显示空、需手动收起再展开」——`locate()` 的 `setLevels` 写进了**循环变量闭包**（React 延后执行 updater，所有层级都写到最后一个 key），改为 `fetchLevel(path)` 参数捕获，并在**展开前先加载该层**；同一路径**只渲染一次**（`seen` 去重），修掉折叠节点被重复绘制成「重复文件夹」。

**1.2.6**：**调试位置跟随**——命中断点/单步（`⤵ ⤷ ⤴`）或点击调用栈某帧后，自动打开对应源码并定位高亮：类名 → `cn/com/…/X.java`（`sourceRelativeSuffix`，内部类折到外层文件）→ `.gitignore` 感知检索找到文件 → 打开 → 编辑器滚到该行并加琥珀色高亮带（CodeMirror 按行号槽对齐真实行；内置编辑器滚动并选中该行），断点栏显示 `▸`；VM 继续运行后高亮自动清除。

**1.2.5**：修「`⌖` 定位后文件夹空 / 再点文件夹报 `Maximum call stack size exceeded`」——`locate()` 之前按**原始路径前缀**逐级加载，但树渲染的是**折叠后的节点**（`cn.com.ris.cloud.model` 一行），于是加载的层级没有任何行对应 → 分支空；点开空行只展开不加载。现在 `locate()` **沿渲染出的行**逐级下降（`childEntryFor` 取包含目标的那个折叠节点），并：`toggle` 改为**先加载后展开**（不再出现「（空）」占位）、`loadLevel` 去重并发、`rowsFor` 加**深度上限 64 + 分支环路检测**（异常数据只会截断，不会再抛栈溢出）。新增回归测试（折叠链定位、真实单链包目录、`childEntryFor` 边界）。

**1.2.4**：持久化补齐——最大化状态、配色、字号、尺寸、打开文件都在初始化时应用，并自动迁移旧版「按程序 id」的 localStorage 键；首次打开默认最大化源码面板。

**1.2.3**：修「深色 IDE + 浅色页面 → Java 的 `.` 变黑看不见」/「Ctrl+F 查找面板不跟随深色」——内嵌 CodeMirror 的语法调色板与查找面板都跟**页面**主题，旧逻辑强制相反底色导致黑 token 落深底；现在只在 IDE 配色与页面一致时才改编辑器表面，冲突时保持页面配色并在状态栏提示。

**1.2.2**：折叠包名的 `.` 分隔符加粗 + 1.5px 光晕（深色下 12px 的 `.` 是亚像素，几乎不可见）；**宿主版本较旧（无 `/tree` 路由）时目录树自动回退**到 sidebar 读取并在树顶提示重启，不再整块报错。

**1.2.1**：文件树改走 `/dsh-ris-ide/tree`——按 `.gitignore` 过滤 + 单链目录折叠（`cn.com.ris.cloud.model`）；修 sidebar 渲染器 `cannot get property "locale" without inject`（给外来 viewer 一个宽容 ctx facade，失败的 service 查找返回 undefined）；断点改乐观更新（点击即时翻转，类未加载时显示「待应用」，跨 poll 保留 pending）。

**1.2.0**：文件名搜索改为 `.gitignore` 感知（宿主侧逐仓库 `git ls-files`，覆盖根与 26 个子项目）；当前文件内 `Ctrl+F` 支持**替换/全部替换**；工作空间标题栏加 `⌖ 定位当前文件`；关闭其他/全部关闭改为**页签右键菜单**；调试控制按钮移到调试面板标题栏并去掉收起。

**1.1.8**：工具栏搜索改下拉（结果在搜索框下方）；内嵌编辑器/内置编辑器都支持文件内 `Ctrl+F` 查找定位；控制台调试按钮橙色；修复 sidebar 渲染器报错时回退路径自身崩溃（`this.props.fallback` 未传）。

**1.1.7**：控制台 `▶` 启动=绿、`■` 停止=红（语义色，其他按钮保持中性）。

**1.1.6**：去掉独立顶栏——工作空间标题改为路径，源码标题改为「搜索框 + 按钮组」，控制项随面板走。

**1.1.5**：顶栏左右分界可视化（与下方分隔条同线的竖线，左区宽度仍随文件夹列变化）。

**1.1.4**：顶栏改三区 flex 布局——身份区 306px（= 左列 300+6，路径省略号）、检索框自动扩展、按钮组定宽；搜索框左沿与下方源码区对齐，且随左列拖动保持对齐。

**1.1.3**：顶栏按钮统一 20px 行高（字形垂直居中）、控制台按钮加宽到 25px。

**1.1.2**：顶栏配色选择（跟随页面/深色/浅色，含内嵌编辑器与日志区）；字号缩放改为**每棵 UI 树各自一份**样式集（消除全局比例泄漏到 sidebar 自带 `.log` 视图的缺陷）。

**1.1.1**：顶栏 `A-`/`A+` 统一调整各面板内容字号（含内嵌 CodeMirror 与日志区）。

**1.1.0**：源码区改为**内嵌 sidebar 渲染器**（CodeMirror，Java 有语法高亮；`toolbar:'host'` 拿它自己的 dirty/save，失败自动回退内置编辑器）、断点栏移到编辑器**外部左侧**并按行号槽对齐；打开即编辑 / `*` 脏标记 / 关闭提示保存；页签 ◀▶ 分页 + 关闭其他/全部 + 记忆 + 上限 20；控制台补前端启停；顶栏显示工作空间路径；内置 skill 支持自动更新；图标按钮统一定宽。

**1.0.9 修的关键缺陷**（都是"看起来能用、其实静默失效"）：

1. **目录树/检索/读源码全空**——`/sidebar/api` 的响应是信封 `{ok:true, value:{…}}`，旧代码按平铺取 `result.entries`/`result.content`/`result.matches`，全是 `undefined`；又因为 `ok` 为真不抛错，所以既空又无报错。现在 `sidebarFs()` 统一解信封，失败读 `error.message`。
2. **保存 404**——`/sidebar/api/fs.write` 不存在；改走原始路由 `POST /sidebar/write`（`text/plain` 正文）。
3. **`fs.read` 的 chunk 语义**——按 `kind:'text'|'binary'|'too-large'` 分支，二进制/超大文件给出可读的错误而不是空内容。

里程碑节点的技术内核仍是：内嵌 JDWP 引擎（零额外进程、+5MB 内存）、`ris_dev_*` agent 命令、`/debug/*` HTTP 路由、loopback+Origin 围栏、Windows/macOS/Linux 同一套代码。

## 3. 显示与交互

日志按行渲染，不再是"一整块 `pre` 文本"：

- **着色**：带 ANSI SGR 的行照原样渲染（Maven / Spring Boot 的输出直接有颜色，含 16/256/真彩色、加粗、下划线）；没有 ANSI 的行则把行首**时间戳压暗**、把 **级别词**着色——`ERROR/FATAL/SEVERE` 红、`WARN` 琥珀、`DEBUG/TRACE` 灰，`INFO` 保持正文色（它是噪声地板，不染）。非 SGR 的 CSI 序列（光标移动、清行）会被丢弃，不会漏成乱码。
- **字体**：默认走主题的 mono 变量 `var(--dsw-font-mono, …)`，回退链把本机实际有的字体排在前面（`Ubuntu Sans Mono` → `Ubuntu Mono` → …，最后才是 `DejaVu Sans Mono`）。原来那套 `ui-monospace/Menlo/Consolas` 在这台 Linux 上会掉到 DejaVu，就是"字体不好看"的原因。行高 1.5。
- **字号**：`A− / A+` 按钮，10–20 px，选择记在 localStorage。
- **自动换行**：`换行:开 / 换行:关` 切换按钮，**默认开**，同样持久化。
- **跟随**：`跟随中/已暂停` 徽标 + 暂停跟随 / 到底部 / 刷新；向上滚动会自动暂停跟随，滚回底部自动恢复。
- **停止服务**：只要日志旁边有 pidfile（`<log>.pid`，`run-with-log.sh` 写的）且 PID 还活着，头部就出现红色 **停止服务** 按钮（并显示 `服务运行中 (pid N)`）。点击弹确认框 → POST `/dsh-ris-ide/stop` → host 侧先 `SIGTERM` 那个 **wrapper**，等宽限（pidfile 第 4 列记录的**每程序** `stopGraceMs`，没有则用全局默认 5 s），还在就 `SIGKILL`；wrapper 的 trap 把信号转给真正的服务子进程，清掉 pidfile 后退出。日志里会留下 `--- <名字> exited … (status 143) ---`。

  停止的安全边界：**浏览器从不提交 PID**。它只提交日志路径，host 自己读 `<log>.pid`，并且要求 `/proc/<wrapperPid>/cmdline` 里确实出现 `run-with-log.sh` 才发信号；否则返回 409 `unverifiable`（测试里有一条专钉这个：pidfile 指向一个普通 `sleep` 进程时必须拒绝且该进程仍存活）。pidfile 内容不是"三个正整数"就等同于"没有服务"。

- 只在页面可见时轮询（1 s）；内容没变不触发重渲染。
- 头部模式横幅出现 = tail 路由没通（本机首查：`curl -s 'http://127.0.0.1:3080/dsh-ris-ide/tail?sessionId=<id>&path=<绝对路径>&bytes=4096'`，应返回 `{"ok":true,...}`）。这时 pidfile 读不到，停止按钮不出现（由 tail 路由的 payload 决定）。

## 4. 边界与配置

| 项 | 值 |
|---|---|
| 尾部窗口 | 默认 64 KiB，硬上限 512 KiB（`config.maxBytes` 只能调小） |
| 轮询 | 1 s（页面隐藏时跳过） |
| 渲染上限 | 最多渲染窗口内最后 4000 行（防元素树无界） |
| 路径规则 | 与插件自己的 `ensureWorkspacePath` 一致：相对路径按会话 cwd 解析，绝对路径保持绝对，**默认不做包含性限制**（插件那边也是纯 `resolveTarget`，否则日志在 cwd 外时会静默降级成头部模式）。`config.restrictToCwd: true` 可开启"必须在会话工作目录内"的严格模式 |
| 停止宽限 | `config.stopGraceMs`，默认 5000，上限 60000（TERM→KILL 之间的等待） |
| 安全 | 所有 `/dsh-ris-ide/*` 路由只接受 loopback 的 Host（`localhost`/`127.x`/`[::1]`），带 Origin 时必须同源；读只 GET；写/启停/调试走 POST + JSON body；停止的 PID 只来自 pidfile 且必须通过 `/proc` cmdline 校验 |
| 写动作 | 编辑器保存文件走 `POST /dsh-ris-ide/fs/write`（保持探测到的编码/换行）；文件树支持 mkdir/create/copy/move/remove（工作区根拒绝、目录非空需 `recursive:true`）；其余写动作只有"停止由本脚本启动的服务"与"按扫描/配置启动程序" |
| 失败面 | 两条读取通道都失败 → 组件显示错误条；只有 tail 路由失败 → 头部模式 + 横幅；停止失败 → 头部下方一行说明（`no-service` / `unverifiable` / `signal-failed`） |

配置写在 profile 的 Loader 行里（`cordis.patch.yml`）：

```yaml
- id: ris-ide
  name: 'dsh-ris-ide'
  config:
    maxBytes: 131072        # 每次读取的尾部窗口（上限 512 KiB）
    restrictToCwd: false    # true = 只读会话工作目录内的文件
    stopGraceMs: 5000       # 停止服务时 TERM→KILL 的宽限
    agentTools: true        # 注册 ris_dev_programs/status/start/restart/stop/logs 给模型
```

## 5. 测试

```bash
cd ~/workspace/dsh-ris-ide
node --test "test/*.test.mjs"
```

**当前 214 条**：`client-viewer` 121 / `host-tail` 82 / `debug-engine` 11。本机带真实 React 时 **214/214**；CI（Jenkins）没有真实 React，35 条 SSR 用例自动 skip（**179 pass / 35 skip / 0 fail**）。

**0.3.9 时累计 102 条**（0.3.2 程序扫描/启动 → 0.3.3 配置生成/漂移/更新 → 0.3.4 模型侧命令 → 0.3.5 停止整组进程/状态/重启 → 0.3.6 打开自动生成/校验 + pom profile → 0.3.7 jvmArgs → 0.3.8 Windows → 0.3.9 JDWP 调试）：**host 57**（原有尾部读取 / UTF-8 截断修复 / 空文件 / 单行无换行 / 路径规则两模式 / loopback fence / 字节钳制 / 真实 HTTP 尾读 / 错误码 / 严格模式 / pidfile 与存活判定 / 拒绝非 wrapper 的 PID / no-service 与外来 Host / **真实 `run-with-log.sh` 端到端停止**；新增 **`scanPrograms` fixture（Spring 入口 + 前端清单 + node_modules 诱饵）**、`parseJsonc`、`readLaunchConfigs`/`launchFor`、`buildStartSpec`（Spring 命令与 launch.json 覆盖、前端命令）、`quoteShell`/`sanitizeLogName`/`defaultSpringArgs`、`programs` 路由 HTTP、start 路由拒绝面（unknown-program/缺参/405）、**start→pidfile→stop 端到端**）+ **client 40**（原有契约/前缀 URL/状态助手/SSR/回退/着色/ANSI/上限/字号/停止按钮/`requestStop`；新增 **`本地实例` tab 注册 id**、`requestStart` 成功/失败、`openInstanceLog` ctx 桥、缺 `registerTab` 降级、**`generateConfig` 的 generate/update/失败**、**`drainOpenRequests` 把宿主队列里的打开请求转成 `openFile`**）；host 侧另有 **`readProgramConfig` JSONC 容错、`mergeProgramConfig`（改名/logName/env/args/grace/disabled/自定义程序）、`detectConfigDrift`（新增/失效/变更/手动条目）、`mergeConfigDocuments`（保留编辑+加新+删失效自动条目）、`POST /config` 生成/409/update/overwrite、以及 start 用配置的 `startCommand`+`logName`+`graceMs` 端到端**；0.3.4 再加 **`registerAgentTools` 注册 6 个 `ris_dev_*` 命令与降级、`resolveProgramRef` 的 id/精确名/唯一片段/歧义、工具 E2E（list→start→logs→stop）、`GET /opens` 消费一次**；0.3.5 再加 **停止整组进程（孙进程也被 TERM/KILL）、启动秒退带日志尾部报错、工具结果 lossless JSON、`ris_dev_status`/`ris_dev_restart`**；0.3.7 再加 **`jvmArgs`（每程序 + 顶层 `defaults.jvmArgs`，更新时保留，插入到插件必需 `-D` 之后）**；0.3.6 再加 **项目入口 pom 的 profile 推导（activeByDefault / `profiles.active` / parent 链 / 默认 dev）、项目根 `local.yml` 与 args 规范化、`configMatchesWorkspace` 廉价校验、`/programs` 首次自动生成 → 第二次 `matched` 不扫描 → 工作区变化自动 `updated`**；0.3.8 再加 **Windows 运行时（`windowsStartSpec` / `pickGitBash` / windows-bash classpath）**；0.3.9 再加 **JDWP 调试内核（vendor 引擎、会话注册、`/debug/*` 路由、`ris_dev_debug` 工具）+ 真实 JVM 集成测试（attach→断点→栈→变量→单步→断开）**。

**1.0.10 再加 12 条**（client 7 / host 5）：`capOpenFiles` 上限与脏页保护、`SidebarEditorPane` 派发给 sidebar 渲染器（含 `toolbar:'host'` 契约）与无服务回退、Java 才有的外部断点栏、localStorage 页签恢复 + 工作空间路径、控制台前端启停、内置 skill 打包（frontmatter + `files` 含 `skills`）、`installSkill` 幂等、`findProjectRoot`、`skillRootFor` 路径围栏、`ris_dev_skill` 注册与 `show`。

**1.0.9 再加 11 条**（client）：`sidebarFs` 解 `{ok,value}` 信封并带 session scope、`fsTree` 解信封、失败时给出宿主 `error.message`（而不是 `HTTP 400`）、`fsRead` 的 text/binary/too-large 三分支、`fsSearch` 的 `{matches,dirs}`、`fsWrite` 走 `sidebar/write`（URL/查询参数/`text/plain` 原文/解信封取 `mtimeMs`/失败信息）、`absolutePath` 相对→绝对；以及 IDE 新布局的 4 条 SSR：三根分隔条 + 默认 300/260/260 尺寸、顶栏居中检索 + 仅在有宿主时出现配置按钮（`⟲` 还原布局始终在）、调试按钮只在调试区工具行（顶栏没有 `debug-start`）、类名/行号表单已移除 + 调试/日志页签可关闭且用项目名。

> 说明：入口类按**类名启发式**（`Application|App|Main|Bootstrap`）先过滤再校验注解——本机 15 个 Spring 程序全部命中；若某个入口类不按这些名字命名，需要把文件名改成含这些词（或改 `ENTRY_JAVA_RE`）。
