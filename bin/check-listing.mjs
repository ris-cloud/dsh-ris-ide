#!/usr/bin/env node
/**
 * 上架自检：把 dsh-market（awesome-dsh-plugin 目录）与 dsh.so 的收录条件，变成能在本地跑的检查。
 *
 *   npm run check:listing
 *   npm run check:listing -- --json
 *   npm run check:listing -- --strict        # 警告也算失败
 *   npm run check:listing -- --net           # 额外尝试联网确认仓库/包公开可达（内网环境会失败）
 *
 * 规则来源与逐条解释在**仓库外**的插件开发手册（`docs/dsh-plugin-listing-guide.md`）。这里是**静态**检查：license 选哪个、仓库要不要公开、
 * npm 包名怎么定，这些决定项脚本只能标记出来，得人定。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const STRICT = argv.includes('--strict')
const NET = argv.includes('--net')

const results = []
const ok = (id, detail) => results.push({ id, level: 'ok', detail })
const warn = (id, detail) => results.push({ id, level: 'warn', detail })
const fail = (id, detail) => results.push({ id, level: 'error', detail })

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'))
}

async function readText(rel) {
  try {
    return await readFile(join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** 递归列出目录下的文件（跳过 node_modules / .git / 构建产物） */
async function listFiles(dir, acc = []) {
  let entries
  try {
    entries = await readdir(join(ROOT, dir), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      await listFiles(rel, acc)
    } else {
      acc.push(rel)
    }
  }
  return acc
}

const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.vue'])
const PUBLIC_HOSTS = ['github.com', 'gitee.com', 'gitlab.com']

function short(text, max = 120) {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

async function main() {
  const pkg = await readJson('package.json')
  const readme = await readText('README.md')

  // ── dsh.so：插件 id（slug） ───────────────────────────────────────────────
  const bareName = String(pkg.name || '').replace(/^@[^/]+\//, '')
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bareName)) ok('插件 id（slug）', `"${pkg.name}" → ${bareName} 匹配 ^[a-z0-9]+(-[a-z0-9]+)*$`)
  else fail('插件 id（slug）', `"${pkg.name}" 不匹配 ^[a-z0-9]+(-[a-z0-9]+)*$：改成小写 kebab-case（scoped 包只校验 scope 后的段）`)

  // ── 版本：市场展示的是最新正式版 ─────────────────────────────────────────
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(pkg.version || ''))) {
    if (String(pkg.version).includes('-')) warn('版本号', `${pkg.version} 是预发布版；市场/dsh.so 展示 latest 语义时应发布 X.Y.Z 正式版（快照只用于本地）`)
    else ok('版本号', `${pkg.version}（合法 semver，正式版）`)
  } else {
    fail('版本号', `"${pkg.version}" 不是合法 semver`)
  }

  // ── dsh.so：DSH 兼容信号（至少一个） ─────────────────────────────────────
  const signals = []
  if (pkg.dsh && typeof pkg.dsh === 'object') signals.push('package.json 的 dsh 字段')
  if (pkg.dsh?.bundle?.patch) signals.push(`dsh.bundle.patch = ${pkg.dsh.bundle.patch}`)
  if (pkg.dsh?.plugin) signals.push('dsh.plugin.* manifest')
  if (pkg.engines?.dsh) signals.push(`engines.dsh = ${pkg.engines.dsh}`)
  if (existsSync(join(ROOT, 'cordis.patch.yml'))) signals.push('cordis.patch.yml')
  if (existsSync(join(ROOT, 'agent.cordis.yml'))) signals.push('agent.cordis manifest')
  if (signals.length) ok('DSH 兼容信号', signals.join('；'))
  else fail('DSH 兼容信号', '缺少全部信号（dsh 字段 / cordis manifest / dsh-plugin topic）')

  // ── dsh.so：README 含安装说明 ────────────────────────────────────────────
  if (!readme) fail('README 安装说明', '没有 README.md')
  else {
    const installLines = readme
      .split('\n')
      .filter((line) => /dsh plugin --profile \S+ add /.test(line))
    // 「公开」口径：这条安装命令不依赖内网 registry，市场用户照抄就能装
    const publicLine = installLines.find(
      (line) => !/registry=|\.npmrc|repository\/npm-/.test(line) && !/@\d/.test(line),
    )
    if (installLines.length === 0) {
      fail('README 安装说明', 'README 里找不到 `dsh plugin --profile <p> add …`')
    } else if (publicLine) {
      ok('README 安装说明', `含公开可直接抄的安装命令：${short(publicLine, 80)}${installLines.length > 1 ? `（另有 ${installLines.length - 1} 条内网/带版本号的备选）` : ''}`)
    } else {
      warn('README 安装说明', '安装命令都指向内部 registry 或写死了版本号；公开上架需要一条不依赖内网、不写死版本的 `dsh plugin --profile web add <包名>`')
    }
  }

  // ── dsh.so：开源 license + SPDX ─────────────────────────────────────────
  const licenseFiles = (await listFiles('.')).filter((f) => /^LICEN[CS]E(\..*)?$/i.test(f))
  const spdx = typeof pkg.license === 'string' ? pkg.license.trim() : ''
  const spdxOk = /^[A-Za-z0-9.+-]+$/.test(spdx) && !/^(UNLICENSED|SEE LICENSE IN .*|PROPRIETARY)$/i.test(spdx)
  if (spdxOk && licenseFiles.length) ok('License（SPDX）', `${spdx}，文件：${licenseFiles.join(', ')}`)
  else if (!spdx && !licenseFiles.length) fail('License（SPDX）', '既没有 package.json 的 license 字段，也没有 LICENSE 文件；dsh.so 要求开源许可证 + 可识别 SPDX（UNLICENSED 不算）')
  else if (!spdx) fail('License（SPDX）', `有 ${licenseFiles.join(', ')} 但 package.json 缺 license 字段（要写 SPDX id）`)
  else fail('License（SPDX）', `license 字段是 "${spdx}"，不是可识别的 SPDX 开源标识`)

  // ── dsh.so：可扫描源码 ───────────────────────────────────────────────────
  const sourceFiles = (await listFiles('.')).filter((f) => SRC_EXT.has(extname(f).toLowerCase()))
  if (sourceFiles.length >= 3) ok('可扫描源码', `${sourceFiles.length} 个源码/脚本文件（如 ${sourceFiles.slice(0, 3).join(', ')}…）`)
  else fail('可扫描源码', `只找到 ${sourceFiles.length} 个可扫描文件；docs-only / 空仓库不能提交`)

  // ── dsh-market：安装来源（npm 包名） ─────────────────────────────────────
  if (typeof pkg.name === 'string' && pkg.name) ok('npm 包名（目录 install 字段）', `${pkg.name}（目录里 npm/version 取自公开 registry）`)
  else fail('npm 包名', 'package.json 缺 name')

  // ── dsh.so：仓库地址（公开托管 + topic） ──────────────────────────────────
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!repoUrl) {
    fail('公开仓库地址', 'package.json 缺 repository（dsh.so 只收 GitHub / Gitee / GitLab，且用它同步星数/license/最后提交）')
  } else {
    const cleaned = String(repoUrl).replace(/^git\+/, '')
    const host = (cleaned.match(/^https?:\/\/([^/]+)/) || [])[1] || ''
    if (PUBLIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) ok('公开仓库地址', `${cleaned}（${host}）`)
    else fail('公开仓库地址', `${cleaned} 的 host 是 "${host || '未知'}"；dsh.so 只认 GitHub/Gitee/GitLab`)
  }
  if (pkg.homepage || pkg.bugs?.url) ok('homepage / bugs', short(pkg.homepage || pkg.bugs.url))
  else warn('homepage / bugs', '建议补 homepage / bugs（市场卡片与 issue 入口会用到）')

  // ── dsh.so：topic（只能人工在仓库上加，本地无法验证） ────────────────────
  const topics = Array.isArray(pkg.keywords) ? pkg.keywords.map((k) => String(k).toLowerCase()) : []
  if (topics.includes('dsh-plugin') || topics.includes('dsh-pack')) ok('keywords 的 dsh-plugin', 'package.json keywords 含 dsh-plugin / dsh-pack')
  else warn('keywords 的 dsh-plugin', 'package.json keywords 缺 dsh-plugin（同时记得在 GitHub 仓库加 topic `dsh-plugin`，dsh.so 靠它自动索引；这条只能人在仓库里加）')

  // ── dsh-market：双语描述 ─────────────────────────────────────────────────
  const desc = String(pkg.description || '')
  // 目录条目需要 en/zh 两条描述；package.json 只有一个 description，至少要求它能当英文文案用
  //（判定口径：连续 15 个 ASCII 字母/空格/标点，短串像 "Spring Boot" 不算一句英文）
  if (!desc) fail('描述（en + zh）', 'package.json 缺 description')
  else if (/[A-Za-z][A-Za-z ,.'’/()-]{15,}/.test(desc)) ok('描述（en + zh）', `package.json description 含英文句子：${short(desc, 80)}`)
  else warn('描述（en + zh）', `description 只有中文/短英文（${short(desc, 60)}）；目录条目要自己写 en/zh 两条（市场按 UI 语言显示），建议把英文句也写进 README 首段`)

  // ── dsh-market：README 截图（只从 GitHub 托管加载） ──────────────────────
  const shots = readme ? (readme.match(/!\[[^\]]*\]\(([^)]+)\)/g) || []).length : 0
  if (shots >= 2) ok('README 截图', `${shots} 张（市场卡片是轮播，仓库托管即可）`)
  else warn('README 截图', `README 只有 ${shots} 张图；市场卡片需要 2–4 张（侧栏控制台 / 独立窗口 / 调试面板），且必须由 GitHub 托管`)

  // ── 安全扫描启发式（dsh.so 阻断项：硬编码密钥 / 私钥） ───────────────────
  const scanTargets = sourceFiles.filter((f) => !/client-codemirror\.js$/.test(f)).slice(0, 400)
  const secretPatterns = [
    { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
    { name: 'OpenAI 风格 key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: '疑似硬编码口令', re: /\b(?:password|passwd|secret|apiKey|api_key)\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
  ]
  const hits = []
  for (const rel of scanTargets) {
    const text = await readText(rel)
    if (!text) continue
    for (const { name, re } of secretPatterns) {
      if (re.test(text)) hits.push(`${rel} → ${name}`)
    }
  }
  if (hits.length) warn('安全扫描（硬编码密钥）', `${hits.length} 处命中，提交前逐条确认是否误报：${hits.slice(0, 5).join('；')}`)
  else ok('安全扫描（硬编码密钥）', `${scanTargets.length} 个文件扫描，无私钥/密钥字面量命中`)

  // ── 能力声明（本插件一定会带的外围能力，提交时会被人工复核） ──────────────
  ok(
    '能力边界（人工复核项）',
    '插件会：启动/停止进程（含杀进程组）、读写工作区文件、读环境变量、注册 agent 工具。dsh.so 扫描会标出 fs-write/env/process，README 需写清用途与围栏（loopback 校验、pidfile 校验、路径限制）',
  )

  // ── 可选联网核对 ─────────────────────────────────────────────────────────
  if (NET) {
    await checkNetwork(pkg, repoUrl)
  } else {
    warn('公开可达性（可选）', '跳过联网核对（--net 开启）；内网环境通常不可达，可在有外网的机器上跑')
  }

  report()
}

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    return res.ok || res.status === 405
  } catch {
    return false
  }
}

async function checkNetwork(pkg, repoUrl) {
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%2F', '/')}`
  const npmOk = await head(npmUrl)
  if (npmOk) ok('公开 npm 可达', `${npmUrl} 200`)
  else fail('公开 npm 可达', `${npmUrl} 不可达：需先发布到公开 npm（只发在内部 registry 的包，市场装不到）`)

  if (repoUrl) {
    const url = String(repoUrl).replace(/^git\+/, '').replace(/\.git$/, '')
    const repoOk = await head(url)
    if (repoOk) ok('公开仓库可达', `${url} 200`)
    else fail('公开仓库可达', `${url} 不可达或需要登录：dsh.so/dsh-market 都要公开可拉取`)
  }
}

function report() {
  const errors = results.filter((r) => r.level === 'error')
  const warns = results.filter((r) => r.level === 'warn')
  const icon = { ok: '✅', warn: '⚠️ ', error: '❌' }
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors: errors.length, warnings: warns.length, results }, null, 2))
  } else {
    console.log('\n上架条件自检（dsh-market / dsh.so）· 规则见仓库外插件开发手册\n')
    for (const r of results) {
      console.log(`${icon[r.level]} ${r.id}`)
      if (r.detail) console.log(`   ${r.detail}`)
    }
    console.log(`\n合计：${results.length} 项 · ❌ ${errors.length} · ⚠️ ${warns.length}`)
    if (errors.length) {
      console.log('\n必须先解决：')
      for (const r of errors) console.log(`  ❌ ${r.id} — ${r.detail}`)
    }
    if (!errors.length) console.log(warns.length && !STRICT ? '\n静态条件里没有阻断项；⚠️ 需要人确认。' : '\n全部通过。')
  }
  const failed = errors.length > 0 || (STRICT && warns.length > 0)
  process.exitCode = failed ? 1 : 0
}

await main()
