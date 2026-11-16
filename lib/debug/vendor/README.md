# vendor/jdwp — jvm-debug-mcp 的 JDWP 引擎（内嵌）

`lib/debug/vendor/jdwp/*.js` 是 [Riku-KANO/jvm-debug-mcp](https://github.com/Riku-KANO/jvm-debug-mcp) 的
**JDWP 引擎**编译产物（`src/jdwp/*` 三个文件），**不是**它的 MCP 层。

- 上游版本：1.0.0，commit `d51f66b`（见 `UPSTREAM_COMMIT`）
- 许可：MIT（见 `LICENSE`），版权归 Riku Kano
- 体积：`client.js` 40.5KB + `constants.js` 17.1KB + `protocol.js` 7.4KB = **64.9KB**
- 运行时依赖：**0**（只用 `node:net`、`node:events`；上游的 `@modelcontextprotocol/sdk` 与 `zod` 只在 `dist/index.js` 那层用到，本项目不引用）
- 源码：`src/jdwp/*.ts` 一并放在这里（约 2004 行 TS），方便审计与修改

## 为什么内嵌而不是跑 MCP 子进程

| | 内嵌引擎 | MCP 子进程 |
|---|---|---|
| 磁盘 | 64.9KB | 65KB + 10.3MB（MCP SDK 4.7MB + zod 5.6MB） |
| 进程 | 0（跑在 DSH 宿主里） | +1 个 Node 进程（~40–60MB） |
| 内存 | +5MB RSS（实测） | ~40–60MB |
| 集成 | 面板/agent/路由共用同一会话 | 工具在 `mcp__jvm-debug__*`，面板需另建通道 |

## 本地补丁（重 vendor 时必须保留）

**`sendCommand` 的看门狗定时器要清掉**（2026-11-11，`jdwp/client.js` 与 `src/jdwp/client.ts` 同步）：

```js
const timer = setTimeout(() => { /* 超时 reject */ }, this.timeout)
timer.unref?.()
this.pendingRequests.set(id, { resolve, reject, timer })
// processBuffer 收到对应 reply 时：
clearTimeout(pending.timer)
```

上游原实现每条命令都留一个 **10 s** 定时器、且不 `unref`、回复到达也不 `clearTimeout`：最后一条命令之后事件循环被吊满 10 s（`test/debug-engine.test.mjs` 因此从 1.9 s 变成 12.5 s），真实调试会话收尾也会白等。清理点就是收 reply 的那一支（`const pending = this.pendingRequests.get(id)` 之后、`pending.resolve(...)` 之前）——`clearTimeout(undefined)` 本身是安全的，所以不额外判空；别把清理只写在 `delete` 之后却漏掉 early-return 的分支。

## 重新构建（上游有更新或改了 TS 源码时）

```bash
git clone https://github.com/Riku-KANO/jvm-debug-mcp.git /tmp/jvm-debug-mcp
cd /tmp/jvm-debug-mcp && pnpm install && npx tsc
# 只取引擎三件套（MCP 层不要）
cp dist/jdwp/{client,constants,protocol}.js <本目录>/jdwp/
cp src/jdwp/{client,constants,protocol}.ts   <本目录>/src/jdwp/
cp LICENSE <本目录>/LICENSE
git rev-parse --short HEAD > <本目录>/UPSTREAM_COMMIT
```

## 已知能力边界（引擎本身）

能：行断点（类名+行）、方法断点、线程/全 VM 挂起、单步 over/into/out、多线程、调用栈、局部变量、对象字段、数组、String 值。
不能：表达式求值（evaluate）、条件断点、日志断点、热替换（redefineClasses）——这些需要 DAP/JDI 级别实现，本插件 Phase 1 不做。
