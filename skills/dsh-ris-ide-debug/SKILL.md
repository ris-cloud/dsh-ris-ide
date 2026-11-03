---
name: dsh-ris-ide-debug
description: "用 ris_dev_* 工具操作本机 RIS-IDE/侧边栏开发面板：列出/启动/停止/重启工作区里的 Spring Boot 与前端程序、读实时日志、并用 JDWP 调试 Java 项目（以调试模式重启并 attach、加/删/清断点、读线程/调用栈/变量、单步/继续/暂停）。当用户说「启动/停止某个服务」「看日志」「打断点/调试某个接口」「为什么这里是这个值」「跑一下 ris-model-biz/ris-upms-biz/ris-ui-3」「把 IDE 工作台打开给我看」时使用。前端项目没有 JVM，只能启停与看日志，不能调试；无表达式求值/条件断点/热替换。"
---

# RIS-IDE 调试技能（dsh-ris-ide-debug）

> 这套命令由 `dsh-ris-ide` 插件注册，和侧边栏「RIS-IDE」面板**同一套扫描/启停/调试内核**。
> 你只能**选程序**（`id` / `name` / `path`），**永远不传命令**：启动命令由宿主按工作区内容（pom / package.json / `.dsh-ris-ide/config.json`）自己拼。

## 0. 铁律（先读，避免踩坑）

1. `ris_dev_start` 是**启动进程**；`ris_dev_debug {action:"start"}` 是**以调试模式重启并 attach**（正在跑的服务会被停掉再起）。两者不可混用。
2. `start` 是异步的：Spring 约 **40–55 s** 才 UP。看 `ris_dev_status` 或 `ris_dev_logs` 判断，别急着断言失败。
3. **JDWP 只服务一个 debugger 会话**：绝对不要用 `nc`/`telnet` 探端口（会把会话占掉）。attach 完成的信号是 JVM 日志出现 `Listening for transport dt_socket`，`start` 内部已经这么等了。
4. 断点用**全限定类名 + 可执行行号**（Maven 默认带 debug 信息），**不是文件路径**；行号不在该类的 LineNumberTable 里不会命中。
5. 调试能力边界：**没有表达式求值（evaluate）、无条件断点/日志断点、无热替换**。能看线程、栈、局部变量、字段、数组、String。
6. 宿主重启后调试会话与断点都丢失；重新 `start` + `breakpoint_add` 即可。
7. `suspend: true` 会真的把 JVM 停在启动处（Spring 卡住），记得 `resume`。
8. 自定义 `startCommand` 的条目必须在 `java` 后带 `${JDWP_ARGS}` 占位符，否则调试启动直接报错（错误信息会说明）。

## 1. 发现与生命周期

| 命令 | 参数 | 作用 |
|---|---|---|
| `ris_dev_programs` | `refresh?`, `runningOnly?` | 列工作区可运行程序：`id / name / kind / dir / mainClass|script / running / pid / logPath` |
| `ris_dev_start` | `id` 或 `name` 或 `path` | 启动（Spring：`mvn -Pdev compile` → `exec java`；前端：`<pm> run <script>`），走 `run-with-log.sh`；已在跑返回 `alreadyRunning: true` |
| `ris_dev_restart` | 同上 | 停整个进程组再起（端口一定释放） |
| `ris_dev_stop` | 同上 | TERM wrapper → pidfile 宽限 → KILL；只对 `/proc` cmdline 是 `run-with-log.sh` 的 PID 发信号 |
| `ris_dev_status` | 无 / 一个 ref | 不带参＝全量；带参＝`running/pid/uptime/url/logPath` |
| `ris_dev_logs` | ref, `lines?`(80, 上限 500), `open?`(默认 true) | 读日志尾部并把「在侧边栏打开这份日志」排进队列；返回体带 `content`，直接读它 |

`name` 支持**唯一片段**（如 `ris-model`），有歧义会报错并列出候选；不确定就先用 `ris_dev_programs` 拿 `id`。

## 2. 调试（只对 `kind: spring`）

`ris_dev_debug { action, id|name|path, ... }`，全部 action：

| action | 额外参数 | 作用 |
|---|---|---|
| `open` | — | 只把 RIS-IDE 工作台 tab 弹给用户（**不开始调试**） |
| `start` | `suspend?` | 以 JDWP 重启并 attach（随机 loopback 端口） |
| `stop` | — | 只断开，服务继续跑（真要停服务用 `ris_dev_stop`） |
| `status` | — | `attached / suspended / port`，很便宜，可反复调 |
| `poll` | `since?` | 增量事件（断点命中/单步/vmstart）；记住上次的 `seq` 传 `since`，否则会重复读 |
| `breakpoints` | — | 列断点 `requestId / className / line` |
| `breakpoint_add` | `className`, `line`, `suspendPolicy?`(thread\|all) | 加行断点 |
| `breakpoint_remove` | `requestId` | 删一个 |
| `breakpoint_clear` | — | 清空 |
| `threads` | — | 线程列表 |
| `stack` | `threadId`, `max?`(50) | 调用栈 |
| `variables` | `threadId`, `frameIndex?`(0) | 局部变量/字段/数组（String 在 `stringValue`） |
| `step` | `kind?`(over\|into\|out), `threadId?` | 单步 |
| `resume` | `threadId?` | 继续 |
| `pause` | — | 挂起 |

## 3. 标准调试回合（照抄即可）

**先查状态再动手**（`state` 一次给出：运行中/pid/内存、JDWP attached/port/suspended、已有断点、预置断点数）：

```
ris_dev_programs  {}                                            # 找 id / name
ris_dev_debug     { "action": "state", "name": "<program>" }    # ← 先看：能调试吗/连了吗/已有哪些断点
ris_dev_debug     { "action": "start", "name": "<program>" }    # 40–55 s（静默：不弹 IDE）
ris_dev_debug     { "action": "status","name": "<program>" }    # attached=true / port
ris_dev_debug     { "action": "breakpoint_add", "name": "<program>",
                    "className": "cn.com.ris.cloud.model.ModelHelper", "line": 168 }
ris_dev_debug     { "action": "breakpoint_remove", "name": "<program>",
                    "className": "cn.com.ris.cloud.model.ModelHelper", "line": 168 }   # 按位置删（已知 requestId 也可传 requestId）
ris_dev_logs      { "name": "<program>", "lines": 120, "open": false }   # 配合日志看启动/请求（不弹侧边栏）
ris_dev_debug     { "action": "poll",   "name": "<program>" }    # 等命中（记 seq）
ris_dev_debug     { "action": "threads","name": "<program>" }
ris_dev_debug     { "action": "stack",  "name": "<program>", "threadId": "<id>" }
ris_dev_debug     { "action": "variables", "name": "<program>", "threadId": "<id>", "frameIndex": 0 }
ris_dev_debug     { "action": "step",   "name": "<program>", "kind": "over" }
ris_dev_debug     { "action": "resume", "name": "<program>" }
ris_dev_debug     { "action": "stop",   "name": "<program>" }    # 只断开
ris_dev_stop      { "name": "<program>" }                        # 真要停服务
```



```
ris_dev_programs  {}                                            # 找 id / name
ris_dev_debug     { "action": "open",  "name": "<program>" }    # 让用户在 IDE 里看到
ris_dev_debug     { "action": "start", "name": "<program>" }    # 40–55 s
ris_dev_debug     { "action": "status","name": "<program>" }    # attached=true / port
ris_dev_debug     { "action": "breakpoint_add", "name": "<program>",
                    "className": "cn.com.ris.cloud.model.ModelHelper", "line": 168 }
ris_dev_logs      { "name": "<program>", "lines": 120 }          # 配合日志看启动/请求
ris_dev_debug     { "action": "poll",   "name": "<program>" }    # 等命中（记 seq）
ris_dev_debug     { "action": "threads","name": "<program>" }
ris_dev_debug     { "action": "stack",  "name": "<program>", "threadId": "<id>" }
ris_dev_debug     { "action": "variables", "name": "<program>", "threadId": "<id>", "frameIndex": 0 }
ris_dev_debug     { "action": "step",   "name": "<program>", "kind": "over" }
ris_dev_debug     { "action": "resume", "name": "<program>" }
ris_dev_debug     { "action": "stop",   "name": "<program>" }    # 只断开
ris_dev_stop      { "name": "<program>" }                        # 真要停服务
```

典型节奏：`poll` 没事件就先给用户**发真实请求**（前端/接口）再 `poll`；命中后用 `threads → stack → variables` 定位，`resume` 继续；循环排查时保留断点、只 `poll since=<seq>`。

## 3.5 和 IDE 共享同一份调试状态（重要）

宿主只有一个 `debugSessions` 单例：**你的 `ris_dev_debug` 和用户在 IDE 里点的是同一个 JDWP 连接**。断点、挂起状态、事件队列、`seq` 都是共享的；你 `breakpoint_add` 的断点用户能看见，用户在行号上加的断点你也能看见。

因此**命中不一定是你的断点**：

- `poll` 返回的 `breakpoint`/`step` 事件现在带有 `payload.className` 和 `payload.line`（宿主用 `requestId` 回填），**先核对是不是你加的那个**；
- 不是你的：`stack`/`variables` 看到的是**用户那个断点所在线程**的栈，直接 `step` 会顺着用户的路径走。正确做法是 `resume` 或 `step {threadId: <你自己事件的 threadId>}`，然后继续 `poll since=<seq>`；
- 你的断点之后才命中时，事件会再出现一次（`requestId` 是你 `breakpoint_add` 返回的那个）；
- 用户手动 `⏵ 继续`/按 F8 也会推进同一个 VM —— 你拿到的 `seq` 跳变、或 `vmSuspended=false` 都属正常，不要当成"断点失效"。

另外：断点在 **detach/重启后会保留**（宿主把它转存成预置断点，下次 attach 自动装上）；`breakpoint_clear` 才是真清空。

## 3.6 默认静默：不要替用户弹界面

调试默认**静默进行**——`ris_dev_debug` 的任何 action（`state/start/breakpoint_*/poll/threads/stack/variables/step/resume/pause/stop`）**都不会打开或弹出 IDE**；只有 `action: "open"` 会。所以：

- **不要**「顺手 open」：除非用户说「给我看 / 打开工作台 / 我要看调试过程 / 显示日志」，才调 `ris_dev_debug {action:"open"}`（要看日志再加 `ris_dev_logs {..., "open": true}`）；
- 读日志默认带 `"open": false`（`ris_dev_logs` 默认会弹侧边栏日志）；
- 用户已经在开着工作台时**不用你 open**：它会自己跟着（别处命中断点会自动切项目、打开文件、高亮停住行）；
- 控制台 `▶ 启动`/`🐞 调试` 是用户的手动操作，走 UI；agent 负责静默的部分。

## 4. 在 IDE 里对应什么（人看到的东西）

- 侧边栏「RIS-IDE」tab：左上是工作空间目录树（整个 cwd，点文件即打开）、左下控制台（每个程序的 `▶ / ■ / 🐞 / ▤` = start / stop / debug / logs），右上是源码（**打开即可编辑**，`Ctrl/Cmd+S` 保存，未保存页签带 `*`，关闭会提示保存；源码用侧边栏渲染器，Java 有语法高亮），右下是调试 + 实时日志。
- 调试区工具行：`🐞 ⏹ ⏸ ⏵ ⤵ ⤷ ⤴ ⟳ ⊟`，分别对应 start / stop / pause / resume / step(over/into/out) / poll / 折叠。
- 源码左侧细栏是**断点栏**：双击加断点、点红点删断点（追加/删除的就是 `breakpoint_add` / `breakpoint_remove`）。
- 顶栏显示**工作空间路径**、检索框、`📄` 打开 `.dsh-ris-ide/config.json`、`⚙` 生成/更新配置、`⟲` 还原布局尺寸。

## 5. 用户问「怎么装这个技能」时

本技能随插件发布，可让用户二选一（也可直接执行）：

- 项目级（推荐，随仓库）：`<项目根>/.dsh/skills/dsh-ris-ide-debug/SKILL.md`
- 用户级（本机全局）：`~/.dsh/skills/dsh-ris-ide-debug/SKILL.md`

用工具安装（优先，幂等、会校验内容是否变化）：

```
ris_dev_skill { "action": "install", "target": "project" }   # 或 "user"
ris_dev_skill { "action": "status" }                          # 看装没装 / 是否过期
ris_dev_skill { "action": "show" }                            # 只读内容，不落盘
```

写入后 DSH 的 skills provider 会监听目录自动发现；若目录此前不存在导致没出现，重开一个会话再看技能列表。

## 6. 失败速查

| 现象 | 先查 |
|---|---|
| `start` 秒退 | `ris_dev_logs { lines: 120 }` 的尾巴（编译错/端口占用/缺环境） |
| 调试启动报「缺占位符」 | 该程序的 `startCommand` 要带 `${JDWP_ARGS}` |
| `not-attached` | 先 `status`；`start` 没完成就调 step/poll 会这样 |
| 断点不命中 | 类名是否全限定、行号是否可执行行、类是否已加载（未加载会等 `ClassPrepare` 30 s） |
| 端口被占 | 用 `ris_dev_restart`（整组进程信号），不要手 `kill` |
| 前端程序 | 没有 JVM：只能 `start/stop/logs`，`debug` 只对 Spring |
