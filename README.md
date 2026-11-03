# dsh-ris-ide

**RIS-IDE local dev panel for the DSH (DeepSeek Harness) web GUI** — tail your service logs, start/stop workspace programs, debug Java with JDWP, browse and edit files, all without leaving the chat window. A standalone IDE window carries no session history, so it can stay open all day.

DSH（DeepSeek Harness）Web GUI 右侧栏里的 **RIS-IDE 本地开发面板**：不用离开聊天界面，就能看服务日志、启停本地程序；文件树 / 编辑器 / Java 断点调试在**独立窗口**里（侧栏只放控制台 + 实时日志，保持轻量）。

> 面向开发者/维护者的文档（架构、路由、命令、配置字段、里程碑、打包/发布/Jenkins、测试与踩坑）见 [DEVELOPMENT.md](https://gitee.com/riscloud/dsh-ris-ide/blob/master/DEVELOPMENT.md)。

## 轻量级 IDE

这不是又一个桌面 IDE，也不打算替代 IDEA / VS Code——它要解决的是「看一眼、改一下、跑一下、断一下」这类碎片化操作必须切窗口的问题：

- **按需加载，不常驻重资源**：编辑能力来自独立懒加载的 CodeMirror chunk（约 1.1MB，**第一次打开文件时才拉取**）；不起 language server、不做全库索引、没有后台守护进程、不新开端口，只复用 DSH 已有的 `/dsh-ris-ide/*` 路由和**一条 SSE**。
- **面板本身很轻**：侧栏只留「RIS控制台」（控制台 + 实时日志，默认 240px）；完整工作台放在**独立窗口**，该窗口不加载 DSH 界面、不带会话历史（插件主客户端约 680KB + DSH 的 React + 一条 SSE；编辑器能力是另外按需拉的 1.1MB chunk），开一整天也不会随会话历史变重。
- **日常闭环够用**：git 口径文件树与**文件名 + 文件内容**搜索（内容检索走 `git grep`、无索引；标题栏眼睛可临时关闭 .gitignore 过滤）、编辑/保存/多页签（含与磁盘的逐行 `±` 对比、Java 单测一键 `▶` 运行）、Markdown/HTML 内联预览（编辑/预览一键切换，开关悬浮在编辑区右上角、不占行高，不依赖侧栏服务）、目录变更自动跟随、日志实时跟随与着色（点启动立刻切到该程序日志，编译静默期有提示；可按级别 `W+`/`E+` 过滤）、程序启停/**重启**/**批量启停**、Java JDWP 断点调试，以及给 agent 的 `ris_dev_*`——都在同一处完成。
- **与重型 IDE 互补**：大重构、全局索引、深度语言服务仍交给 IDEA；这里负责顺手改一行、跑一下、看日志、和 agent 协作时共用同一个面板。

| 侧栏「RIS控制台」：控制台 + 实时日志|
|---|
| ![侧栏「RIS控制台」](https://gitee.com/riscloud/dsh-ris-ide/raw/master/docs/screenshots/ris-console.png) |

| 独立窗口（打开即最大化、无会话历史；控制台标题栏有 📄/⚙）|
|---|
| ![独立窗口](https://gitee.com/riscloud/dsh-ris-ide/raw/master/docs/screenshots/ris-ide-window.png) |

## 功能

- **程序控制台**：扫描工作区的 Spring Boot 入口、前端 `package.json` 脚本与有 pidfile 的历史实例；每行 `▶ 启动 / ■ 停止 / ⟳ 重启 / 🐞 调试 / ▤ 日志`，启停期间行上有遮罩（文案按动作）。勾选 2 行以上时标题栏出现 **▶ 批量启动 / ■ 批量停止 / 清除**（按列表顺序启动、倒序停止、跳过无需动作的，按钮上显示 `i/N`）。点程序行（名称或整行）下方日志立刻跟随该程序。
- **日志**：走一条共享 SSE 实时增量；ANSI/级别着色，默认**只看本次启动**（更早内容向上滚动仍可加载）；标题栏 `级 → W+ → E+` 级别过滤、换行开关（真正的 `pre-wrap`/`pre`）、`A−/A+` 字号、跟随/暂停、`Ctrl+F` 查找条、内容溢出时**滚动条常驻可见**；标题栏显示 `运行中 (pid N)` 并可一键**停止服务**（pidfile + `/proc` 校验后才发信号）。
- **文件树**：git 口径（`.gitignore` 过滤，标题栏眼睛可临时关闭；没有 git 也能用）；新建/新建包名/重命名/复制/移动/删除/从系统导入（复制/剪切同时把文件列表写进**系统剪贴板**，可直接粘贴到资源管理器/桌面：WSL 走 PowerShell，Linux 走 xclip/wl-copy，macOS 走 JXA）；**Ctrl+点击多选**、`Ctrl+A` 全选、批量复制/剪切/粘贴/拖动/删除（重名自动「 副本」「 副本(n)」，成功提示带「撤销」，一条批量操作只占一次撤销）；点文件夹行 = 展开/折叠，换根走右键菜单「**进入**」（行首出现 `↑ 上级` 逐级返回）；「新建文件 ▸」hover 在右侧弹出类型面板；新建/重命名/粘贴为/删除确认等弹窗**锚定在鼠标旁**；工作区变更经同一条 SSE **静默**自动刷新，只有标题栏 ⟳ 点击才提示结果。
- **检索**：同一个框搜**文件名 + 文件内容**（内容走宿主 `git grep -n`、无索引、上限 200 条）；两类结果排在一起，首屏 40 行、滚到近底再追加 60 行（末尾提示剩余行数），`↑/↓` + `Enter` 打开；默认指向文件名完全匹配的那行、否则第一行；选中后检索词与结果**保留**，快捷键聚焦时**全选**框内文字；内容命中会把检索词带进编辑器查找框并定位到命中行。
- **编辑器**：按需加载的 CodeMirror（Java 等语法高亮）、多页签（切换时页签自动滚入可视区）、保存/脏标记、`Ctrl+D` 删行、自绘**两行式查找/替换面板**（查找一行、替换一行，等宽输入框 + 图标按钮 + 匹配计数 + `Aa`/`.*`/`ab` + `↑/↓`/替换/全部替换）；**点选区或搜索命中块当次就把光标放进去**；失焦不残留全选色；有未保存页签时关闭页签/刷新页面先确认；`±` 打开与磁盘版本的逐行对比（仅在有未保存修改时可用）；`src/test/java/**/*Test.java` 标题栏出现 **▶ 运行测试**（`mvn -pl <module> test -Dtest=<类>`，输出保留开头 4K + 省略 + 结尾 400K，状态 通过/失败/超时，可重跑）。
- **预览**：`.md/.markdown/.html/.htm` 编辑/预览切换按钮**悬浮在编辑区右上角**（不占代码行高，预览含未保存修改）；超过整读上限的大文本以**只读分页预览**打开（滚到近底取下一页、内存超限释放前文、滚动位置按文件记住），标题栏「编辑」可强制全量加载进编辑（上限 32MB）。
- **JDWP 调试（仅 Java）**：点行号加断点、双击红点删除（空行/注释行忽略）；断点/线程/调用栈/变量/单步/继续；对象与数组懒加载展开、继承字段与空值也列出；依赖 jar 自动取 `-sources.jar`，没有则 `javap` 反汇编，也可在调试面板 ⚙ 填反编译 jar（如 CFR），缓存按 jar 指纹失效并有 64MB/30 天上限回收；命中后自动切「参数」页签、打开源码并高亮当前行；前端程序只能启停/看日志。
- **独立窗口**：聊天页右上角 **⧉ RIS-IDE**（或控制台标题栏 ⧉）打开，**填满屏幕**、**不加载 DSH 界面/不带会话历史**，与侧栏同一套 `/dsh-ris-ide/*` 路由与 cookie，没有新端口；窗口按**工作空间**单例，从程序目录调试也不会开出第二个。
- **给 agent 用**：内置 `ris_dev_*` 工具（列程序/状态/启动/重启/停止/读日志/调试/安装 skill），与面板共用同一套宿主命令。
- **跨平台**：Linux/macOS 用 bash 包装；Windows 自动选 Git Bash 或原生 PowerShell 包装，停止用 `taskkill /T` 杀整棵进程树。

## 安装

需要 DSH `>= 0.2.0-rc.2`，且 Web GUI 带官方右侧栏服务（`sidebarRight` / `sidebarRightTabs` / `slots`）。

**本插件自身不依赖任何外部资源**：零运行时 npm 依赖、客户端产物（含 CodeMirror）已随包发布、不联网、不起独立端口，只使用 DSH 自带路由与 Node 内置模块。本机工具只在特定能力上需要：`git`（有则按 gitignore 过滤文件树/搜索；**没有 git 也能用**，退化为不过滤）、JDK `java`/`javap`（启动/调试 Java 程序、反汇编依赖类）、Maven（默认起 Spring 服务时会 `mvn compile`，本地仓库没缓存时会联网下载依赖）、Node/前端包管理器（启动前端 dev server）。

发布到 npmjs 后：

```bash
dsh plugin --profile web add dsh-ris-ide
```

在**内网环境**里，把 registry 指向公司内部的 npm 源（地址见内部运维文档，不在此仓库公开），装完同样是上面这条命令：

```bash
# 例：临时 .npmrc 只写 registry，退出/失败自动删除
P=~/.dsh/profiles/web; ( printf 'registry=<internal-registry>\n' > "$P/.npmrc"; trap 'rm -f "$P/.npmrc"' EXIT; dsh plugin --profile web add dsh-ris-ide )
```

离线 / 内网机器也可以直接装 tgz：

```bash
dsh plugin --profile web add /path/to/dsh-ris-ide-<version>.tgz
```

说明：

- `dsh plugin add` 会写 `~/.dsh`（沙箱会话里需要提权）；它会把插件加入 profile 的 `dependencies` 与 `bundles`。
- 装完**重启 `dsh web`**（Loader 在启动时组合一次），浏览器再**硬刷新**（Ctrl+Shift+R）加载新的客户端 bundle。
- **升级**：先删掉 profile 里旧副本再装，否则 pnpm 可能因 `Lockfile is up to date` 跳过：
  `rm -rf ~/.dsh/profiles/web/node_modules/dsh-ris-ide`，然后重跑上面的安装命令（换成新版本号）。

## 使用

1. 打开 DSH Web GUI，右侧栏进入「**RIS控制台**」标签（完整工作台可从聊天页右上角 **⧉ RIS-IDE** 按钮在独立窗口打开，见下）。
2. 首次打开会在工作区根生成 `.dsh-ris-ide/config.json`（扫描生成；之后按它启动，可在面板里改配置后更新），生成完成后会提示文件位置。`.dsh-ris-ide/` 是插件在工作区里的**唯一**隐藏目录：配置 `config.json`、调试设置 `settings.json`、删除回收 `trash/`、源码缓存 `cache/`、复制暂存 `stage/`。
3. 程序行上的控件（侧栏「RIS控制台」与独立工作台的控制台同一套行语义）：
   - **▶ 启动 / ■ 停止**：启动后日志自动可看；停止按 pidfile 校验后 TERM → 宽限 → KILL，连进程组一起收掉。
   - **🐞 调试**：仅 Spring/Java 程序，点击直接在独立窗口里以 JDWP 模式重启并 attach（含断点 / 线程 / 调用栈 / 变量 / 事件）。
   - **⟳ 重启**：改完代码后的日常动作——运行中的先停（释放 pidfile）再按原参数起，已停止的就是启动；两种状态下按钮都在（`POST /start` 带 `restart:true`）。
   - **批量启停**：每行左侧有复选框，勾上 2 行以上时标题栏出现「已勾选 N 项」+ **▶ / ■ / 清除**——按列表顺序启动、倒序停止，自动跳过已在运行/已停止的，按钮上显示 `i/N` 进度。
   - **点程序名或整行**：下面的日志区立刻跟随该程序的实时日志。
   - 行上没有「进入」按钮：完整工作台用面板顶栏 **⧉ IDE**（或聊天页右上角 **⧉ RIS-IDE**）打开——上调试区，下实时日志，右侧文件树与编辑器。
4. 日志：直接在工作台或日志页查看；`Ctrl+F` 打开日志内查找，标题栏按钮按 `级 → W+ → E+` 过滤级别（WARN/ERROR 的缩进续行保留）。agent 说“看日志”时等效于 `ris_dev_logs`，会把日志弹到这个面板。
5. 调试（Java）：先看状态（`ris_dev_debug state`）→ 启动调试（`start`）→ 加断点（类名 + 行号）→ 线程/栈/变量/单步。自定义 `startCommand` 必须在 `java` 后带 **`${JDWP_ARGS}`** 占位符，否则调试启动会直接报错。

## 配置

配置写在**工作区根**的 `.dsh-ris-ide/config.json`（面板自动生成/校验/更新，也可以手改；老版本放在工作区根的 `.dsh-ris-ide.json` 会在首次打开时自动搬进去）：

| 字段 | 作用 |
|---|---|
| `defaults.jvmArgs` | 所有程序的默认 JVM 参数（如 `["-Xmx2g"]`） |
| 程序条目 `jvmArgs` / `args` / `env` | 该程序的 JVM 参数 / 应用参数 / 环境变量（`jvmArgs` 覆盖 `defaults`） |
| `startCommand` | 覆盖自动拼装的启动命令（自定义启动方式；含调试占位符 `${JDWP_ARGS}`） |
| `logName` / `stopGraceMs` / `disabled` | 日志文件名 / 停止宽限（默认 5000 ms） / 是否跳过该程序 |

字段的完整语义、扫描规则与冲突处理见 [DEVELOPMENT.md](https://gitee.com/riscloud/dsh-ris-ide/blob/master/DEVELOPMENT.md) §2.6。

## 权限与安全

能力边界（插件**只在以你身份运行的本地 DSH 里**工作）：

- **启动/停止进程**：按工作区扫描结果执行 Maven / npm 启动命令，停止时按 pidfile 校验后杀整个进程组；不监听公网端口、不做远程控制。
- **文件读写**：宿主路由只服务 loopback 请求；路径按会话 `cwd` 解析（默认不强制包含性限制，除非配置 `restrictToCwd: true`）；写入走 `/dsh-ris-ide/fs/write`。
- **环境变量与日志**：读取运行时 `PATH`/`HOME` 等以拼装启动命令，日志只读工作区内 `.log` 文件。
- **无遥测**：不向外发送任何请求（除浏览器从本机 DSH 宿主拉 `/dsh-ris-ide/*` 与 SSE）。
- 所有 HTTP 路由都拒绝非 loopback Host/Origin，避免被本机其它网页借用。

## Windows

已支持：启动包装自动选择 **Git Bash**（有则用同款 `run-with-log.sh`）或原生 **PowerShell**（`run-with-log.ps1`，零依赖），停止用 `taskkill /T` 杀整棵进程树。WSL bash 不支持，需要时用 `startCommand` 包 `wsl.exe`。细节见 [DEVELOPMENT.md](https://gitee.com/riscloud/dsh-ris-ide/blob/master/DEVELOPMENT.md) §1.5。

## 卸载

```bash
dsh plugin --profile web remove dsh-ris-ide   # 同时移除 bundles 条目
```

然后重启 `dsh web`。

## 源码与镜像

- Gitee（主仓库）：<https://gitee.com/riscloud/dsh-ris-ide>
- GitHub（只读镜像，每 2 小时从 Gitee 自动同步）：<https://github.com/ris-cloud/dsh-ris-ide>——请勿在 GitHub 侧提交，会被下一次同步覆盖。
- npm 包的 `repository` 字段指向 GitHub 镜像：npm 的 OIDC 可信发布会自动生成 provenance，要求 `repository` 与构建所在的 GitHub 仓库一致；源码仍以 Gitee 为准（`homepage`/`bugs` 与本文档均指向 Gitee）。

## 开发

打包与发布、路由与内部实现、测试、里程碑与踩坑都在 **[DEVELOPMENT.md](https://gitee.com/riscloud/dsh-ris-ide/blob/master/DEVELOPMENT.md)**；上架规则与提交步骤在**仓库外**的插件开发手册里——本仓库只放符合规范的配置与 `npm run check:listing` 自检。
