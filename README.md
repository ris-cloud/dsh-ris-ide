# dsh-ris-ide

**RIS-IDE local dev panel for the DSH (DeepSeek Harness) web GUI** — tail your service logs, start/stop workspace programs, debug Java with JDWP, browse and edit files, all without leaving the chat window. A standalone IDE window carries no session history, so it can stay open all day.

DSH（DeepSeek Harness）Web GUI 右侧栏里的 **RIS-IDE 本地开发面板**：不用离开聊天界面，就能看服务日志、启停本地程序、给 Java 断点调试、浏览和编辑工作区文件。

> 面向开发者/维护者的文档（架构、路由、命令、配置字段、里程碑、打包/发布/Jenkins、测试与踩坑）见 [DEVELOPMENT.md](https://gitee.com/riscloud/dsh-ris-ide/blob/master/DEVELOPMENT.md)。

## 轻量级 IDE

这不是又一个桌面 IDE，也不打算替代 IDEA / VS Code——它要解决的是「看一眼、改一下、跑一下、断一下」这类碎片化操作必须切窗口的问题：

- **按需加载，不常驻重资源**：编辑能力来自独立懒加载的 CodeMirror chunk（约 1.1MB，**第一次打开文件时才拉取**）；不起 language server、不做全库索引、没有后台守护进程、不新开端口，只复用 DSH 已有的 `/dsh-ris-ide/*` 路由和**一条 SSE**。
- **面板本身很轻**：侧栏只留「RIS控制台」（控制台 + 实时日志，默认 240px）；完整工作台放在**独立窗口**，该窗口不加载 DSH 界面、不带会话历史（插件客户端约 435KB + DSH 的 React + 一条 SSE），开一整天也不会随会话历史变重。
- **日常闭环够用**：git 口径文件树与文件名搜索（标题栏眼睛可临时关闭 .gitignore 过滤）、编辑/保存/多页签、Markdown/HTML 内联预览（编辑/预览一键切换，不依赖侧栏服务）、目录变更自动跟随、日志实时跟随与着色（点启动立刻切到该程序日志，编译静默期有提示）、程序启停、Java JDWP 断点调试，以及给 agent 的 `ris_dev_*`——都在同一处完成。
- **与重型 IDE 互补**：大重构、全局索引、深度语言服务仍交给 IDEA；这里负责顺手改一行、跑一下、看日志、和 agent 协作时共用同一个面板。

| 侧栏「RIS控制台」：控制台 + 实时日志|
|---|
| ![侧栏「RIS控制台」](https://gitee.com/riscloud/dsh-ris-ide/raw/master/docs/screenshots/ris-console.png) |

| 独立窗口（打开即最大化，无会话历史） 标题栏最大化 / 跟随 / 字号|
|---|
| ![独立窗口](https://gitee.com/riscloud/dsh-ris-ide/raw/master/docs/screenshots/ris-ide-window.png) |

## 功能

- **日志实时跟随**：`.log` 不停在打开那一刻；按行着色（ANSI / ERROR-WARN-INFO）、自动换行（标题栏的换行开关真正在 `pre-wrap`/`pre` 之间切换，关掉就是横向滚动）、字号调节、暂停/到底；默认**只看本次启动**（重启后自动切到新一段），历史仍可加载。启动/停止/重启/调试后日志面板会**立刻补齐**（不再停在启动命令行上、等下一次重连才刷新），点项目行也不再是「唯一能让它动一下」的办法。日志标题栏显示服务状态（`运行中 (pid N)` / `已停止`），可直接停止服务。编辑器与日志的滚动条在内容溢出时**常驻可见**（不再是宿主题那条几乎看不见的 5px 细缝）。
- **侧栏「RIS控制台」**：右侧栏的面板只保留**控制台 + 实时日志**上下两段——上面每行一个程序（状态点 / 内存 / ▶ ■ / 🐞），点程序名（或整行任意位置）下面就跟它的日志；分隔条可拖动，**默认 240px**、双击恢复、高度会记住；两段标题栏各有 **⤢ 最大化/还原**，日志标题栏还有 **A− / A+ 字号**（与 IDE 日志窗格共用一份偏好）与 **跟随/暂停**。文件树 / 编辑器 / 调试都在独立窗口里，面板自身很轻、能一直挂着。
- **独立窗口**：聊天页右上角（VS Code 按钮右侧）的 **⧉ RIS-IDE** 按钮可在自己的窗口里打开完整工作台（面板右上角也有同样入口），**打开即填满屏幕**（按工作区尺寸定位到 0,0，不再是固定 1500×960）——该窗口**不加载 DSH 界面、不带会话**（只用插件自己的约 435KB 客户端 + DSH 提供的 React + 一条 SSE），长期开着也不随会话历史变重；与侧栏面板是同一条 `/dsh-ris-ide/*` 路由、同一个 cookie，没有新端口。窗口名按工作空间固定，再点只聚焦复用同一个窗口；窗口名按工作空间（而非当前目录）固定，所以从程序目录进调试也不会开出第二个窗口；若确实检测到另一个窗口，会提示「关闭这个窗口 / 仍然在这里打开」，不会自动关。
- **本地实例**：扫描工作区里的 Spring Boot 入口与前端 `package.json` 脚本，一键**启动 / 停止 / 重启 / 看日志**（启停未返回前该行盖上 loading 遮罩，点不到第二次）；首次打开自动生成 `.dsh-ris-ide.json` 保存启动参数（JVM 参数、env、日志名、停止宽限），之后按配置启动，配置漂移时提示更新。
- **JDWP 调试（仅 Java）**：点行号加断点、双击红点删除（空行与注释行自动忽略）；启动/调试时日志自动跟随该程序（其它窗口也会跟着切），F8 连按不会报取栈失败；调试自动打开的文件在调试行离开后自动关闭（有未保存修改的保留），断点列表与调用栈用类名标识位置，断点信息全局同步（其它程序的历史点不会残留、取消后立即消失）；断点 / 线程 / 调用栈 / 变量 / 单步 / 继续；对象与数组变量可点开懒加载查看（含继承字段、空值也列出；步进刷新后展开状态保留），基础类型不显示展开图标；依赖 jar 里的类会自动从 `-sources.jar` 提取源码、否则用 `javap` 反汇编，也可在调试面板 ⚙ 里**可选**填一个反编译工具 jar（如 CFR）；缓存按依赖 jar 指纹失效（jar 重建即重取），并有 64MB/30 天上限自动回收；命中后自动切到「参数」页签，并打开源码、高亮当前行（行不在可见区时自动滚动居中；单步/继续后行号跟随），调试面板与 agent 共用同一个会话；前端程序只能启停和看日志。
- **文件树 + 编辑器**：git 口径的目录树与文件名搜索（结果显示工作空间相对路径、悬停看全路径；Ctrl+R 有单行选区时直接搜该文本，**Ctrl+Shift+R 同 Ctrl+R**——不再触发浏览器硬刷新；结果下拉支持**上下键移动 + Enter 打开**，默认指向文件名完全匹配的那一行、否则第一行，移动高亮时搜索框的光标不受影响、可以接着打字（聚焦且输入为空时的「最近打开」下拉同样默认选中第一行、可上下键 + Enter）；编辑器/日志里 Ctrl+F 会把选中的文本带入各自的查找框，不占用这个文件检索框）、选中树里的文件按 **Ctrl+C 复制、Ctrl+A 全选树**（光标不会跑进编辑器）、内置 CodeMirror（Java 等语法高亮；切换文件时页签自动滚入可视区、编辑器失焦后不残留全选色、点选区里的任何位置（含搜索命中的橙色块）当次就把光标放进去）、保存、新建/复制/移动/删除、多页签、拖放移动（拖到**文件**上 = 移到该文件所在目录）、从系统粘贴/拖入文件导入；`src/main/java` 下可直接**新建包名**（`cn.com.x` 按点建多级目录），新建文件也只填一个名字（`cloud.test` 自动建包并补 `.java`）；超过整读上限的大文本文件以**只读分页预览**打开（滚到接近底部才取下一页，内存超上限后释放前面的内容、可从头重载，不能编辑）。
- **文件树自动跟随**：工作区里新建/删除/重命名会经侧栏**同一条 SSE**自动更新，只重读变化的目录、行没变就不重绘；标题栏 **⟳** 可强制按 git 口径重新读取（结果会弹提示）。
- **预览与复制粘贴**：`.md/.markdown/.html/.htm` 在编辑区域上方有「预览」开关（点后编辑器变预览、按钮变「编辑」，预览当前内容含未保存修改）；树右键「复制」是普通复制（树顶不再有剪贴板横条），粘贴到**文件**上 = 粘进它所在目录，遇到同名直接弹「粘贴为」要求**改个文件名**（预填「A - 副本.java」；复制贴回自身也同样走改名，等于生成副本）；从系统文件管理器复制/拖入的文件可直接导入当前目录（`/fs/upload` 原始字节、`/fs/import` 路径导入）。
- **给 agent 用**：内置 `ris_dev_*` 工具（列程序 / 状态 / 启动 / 重启 / 停止 / 读日志 / 调试 / 安装 skill），agent 可以直接操作同一个面板。
- **跨平台**：Linux / macOS 用 bash 包装；Windows 自动选 Git Bash 或原生 PowerShell 包装（`taskkill /T` 杀整棵进程树）。

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
2. 首次打开会在工作区根生成 `.dsh-ris-ide.json`（扫描生成；之后按它启动，可在面板里改配置后更新）。
3. 程序行上的按钮：
   - **启动 / 停止**：启动后日志自动可看；停止按 pidfile 校验后 TERM → 宽限 → KILL，连进程组一起收掉。
   - **调试**：仅 Spring/Java 程序，会以 JDWP 模式重启并 attach。
   - **进入**：打开独立工作台——上调试区（断点 / 线程 / 调用栈 / 变量 / 事件，多页签），下实时日志，右侧文件树与编辑器。
4. 日志：直接在工作台或日志页查看；`Ctrl+F` 打开日志内查找。agent 说“看日志”时等效于 `ris_dev_logs`，会把日志弹到这个面板。
5. 调试（Java）：先看状态（`ris_dev_debug state`）→ 启动调试（`start`）→ 加断点（类名 + 行号）→ 线程/栈/变量/单步。自定义 `startCommand` 必须在 `java` 后带 **`${JDWP_ARGS}`** 占位符，否则调试启动会直接报错。

## 配置

配置写在**工作区根**的 `.dsh-ris-ide.json`（面板自动生成/校验/更新，也可以手改）：

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
- **文件读写**：宿主路由只服务 loopback 请求，路径经 `cwd` 解析并限制在工作区内；写入走 `/dsh-ris-ide/fs/write`。
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
