#!/usr/bin/env node
/**
 * tests/isolation-gate.mjs — 进程边界双快照隔离门（advisor V3 / S0 判据 9 + 10）。
 *
 *   node tests/isolation-gate.mjs                 # 正常跑门：before → import(run.mjs) → after，断言相等
 *   node tests/isolation-gate.mjs --selftest      # 元测试：探针必红 → 移除探针必绿 → 退出预算必生效
 *   node tests/isolation-gate.mjs --inject <mod>  # 内部：在 after 之前注入一个模块（--selftest 用）
 *   node tests/isolation-gate.mjs --no-exit-close # 内部：故意不显式收口（证明「残留句柄会挂住」为真）
 *
 * ## 为什么需要这道门（P0-1）
 *
 * `tests/advisor.test.mjs:2138` 的真实 dataDir 基线是**模块加载时**捕获的
 * （`const REAL_DATA_DIR_BASELINE = snapshotTree(DEFAULT_ADVISOR_DATA_DIR)`）。
 * 任何在该行**求值之前**发生的加载期写盘都会被**烘焙进基线**，于是收尾断言
 * `testRealDataDirIsolation`（`advisor.test.mjs:2699`）看不见它——「跑测试绝不
 * 碰用户目录」在这种情形下是**假绿**。本门把快照提前到**进程入口**（任何测试
 * 模块求值之前），把证明责任从「模块加载时刻」前移到「进程边界」，因此它同时
 * 覆盖同文件规则自身覆盖不到的那一类加载期副作用。
 *
 * ## C-1（architect 留的硬条件）
 *
 * `tests/run.mjs` 的 `process.exit(...)` 已按判据 9 改为 `process.exitCode = ...`
 * （**符号锚**：`process.exitCode = failures.length === 0 ? 0 : 1`——行号会漂移，不写行号），
 * runner **不再强制终止**。若 advisor runtime 的 `setTimeout` / `AbortController` /
 * 未 dispose 的 runtime 池仍有句柄存活，进程会**挂住**——在门线上表现为**超时**
 * 而非**红**，这是最坏的失败形态。故本门：
 *   ① after 快照之后**显式 `process.exit(code)`** 收口（不留任何句柄主动权）；
 *   ② 「N 秒内退出」是**可跑断言**（下面的看门狗 + `[ASSERT] 退出预算` 行），
 *      不是注释；超时 → `exit 3` 并打印 FAIL，把「挂住」变成可判定的红。
 *
 * ## 快照根（S0 判据 11 / 判据 12 的「显式加入快照根列表」）
 *
 *   ① 真实 dataDir `~/.dsh/plugins-data/dsh-agents/advisor`（主目标）
 *   ② `agent-out/v3-fixtures`（判据 12 的录制件落点）——不显式列入它就会变成
 *      architect P1-9 点名的「**第三类无门落盘点**」。
 *
 * ## 零依赖 / 沙箱纪律
 *
 * 纯 `node:fs` + `node:crypto`；子进程一律 **fd-stdio**（`stdio:['ignore', fd, fd]`），
 * 不做管道捕获——本机沙箱内 node 的 pipe 捕获必 EPERM。
 *
 * @module tests/isolation-gate.mjs
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

/** 门线主目标（独立计算，与 lib/advisor 的常量**交叉核对**而不是直接依赖）。 */
export const REAL_DATA_DIR = join(homedir(), '.dsh', 'plugins-data', 'dsh-agents', 'advisor')

/** S0 判据 12 的录制件落点（显式加入快照根列表）。 */
export const FIXTURE_ROOT = join(REPO_ROOT, 'agent-out', 'v3-fixtures')

/** 快照根列表：① 真实 dataDir ② 录制件根。 */
export const SNAPSHOT_ROOTS = [REAL_DATA_DIR, FIXTURE_ROOT]

/**
 * 退出预算（毫秒）：门必须在预算内收口，否则判**超时红**（exit 3）。
 * 缺省 120s ≈ 实测门耗时（约 3s）的 40 倍：既不会误伤慢机器，也仍是一条真断言。
 * 环境变量 `ISOLATION_GATE_EXIT_BUDGET_MS` 可覆盖（--selftest 用它把超时场景压到秒级）。
 */
export const EXIT_BUDGET_MS = Number(process.env.ISOLATION_GATE_EXIT_BUDGET_MS ?? 120000)
export const EXIT_OK = 0
export const EXIT_RED = 1
export const EXIT_BUDGET_EXCEEDED = 3

/** 探针标签：--selftest 断言它必须出现在子进程输出里（证明探针真的被执行）。 */
export const PROBE_LABEL = 'PROBE_LOAD_TIME_WRITE'

/**
 * 为什么不直接落在真实 dataDir：**本机沙箱的 file policy 是 workspace-write**，
 * 对 `C:\Users\<user>\.dsh\...` 的写入被内核式拒绝（实测 `EPERM`）。探针改为落在
 * 工作区内的快照根上，机制完全等价——门对**每个快照根**跑同一段 snapshot/diff 代码，
 * 红/绿只取决于「窗口内有无写盘」，与根的物理位置无关。真实 dataDir 变体仍会尝试
 * 一次并把结果如实打印（全权限环境下两个根会同时红）。
 *
 * ⚠️ **并发边界（2026-10-29 实测，如实登记）**：本门的**探针**已做到同机并发安全
 * （见下 PROBE_TARGET 与 adoptProbeTarget），但 `tests/run.mjs` 内部还有一批
 * **固定路径夹具**（`tests/.fixture/`、`.fixture-minimal/`、`tests/.fixture-toolscope…` 等，
 * 由 `fileURLToPath(new URL('./.fixture-…/', import.meta.url))` 硬编码），同一台机器
 * 上两个 isolation-gate（或 npm test 与另一席的 run.mjs）并发时仍会互相踩到
 * `ENOTEMPTY: Directory not empty`。这属于 **run.mjs 的既有设计限制**，本门无法在
 * 不改 run.mjs 的前提下消除。因此：**本门不承诺并发安全**，并发跑请错峰。
 * 单跑序列（npm test）不受影响。
 */
/** 探针文件名前缀（**每个进程唯一**，见 PROBE_TARGET 注释）。 */
const PROBE_BASENAME_PREFIX = '.isolation-gate-probe'

/**
 * 探针落点（**工作区内、且是本门的快照根之一**）。
 *
 * 为什么带 pid + 时间戳：本门与 `--selftest` 都可能**同机并发**跑（例如 npm test 与
 * 另一席的 `node tests/isolation-gate.mjs --selftest` 同时执行）。固定文件名会让
 * 两个实例互相污染对方的快照窗口——A 的 after 快照拍到 B 刚写的探针文件，判定为
 * 「窗口内发生变化」⇒ **假红**（2026-10-29 实测：本席与 B7 席并发时两次假红，
 * 单跑 3 次全绿）。这与 `PROBE_REAL_TARGET` 的 EPERM 是同类问题：不是门不灵，
 * 是**门的测量环境被另一个测量者改动了**。
 *
 * 修法两条同时生效：
 *   ① 探针名唯一（pid + 时间戳）——两个实例不再指向同一个文件；
 *   ② 快照过滤：只把**本进程自己的**探针视为快照项，其他 instances 的探针名一律
 *      从快照里剔除（见 snapshotTree 的 ignoreProbe 参数）。
 * 独立性：本门仍然只认「自己的探针写盘」这条因果——selftest 的必红场景照旧成立
 * （探针由本进程注入、本进程快照捕获），**判定没有被削弱**。
 */
export const PROBE_TARGET = join(FIXTURE_ROOT, `${PROBE_BASENAME_PREFIX}-${process.pid}-${Date.now()}`)

/** 真实 dataDir 上的同一探针（沙箱下多半 EPERM；如实记录，不静默跳过）。 */
export const PROBE_REAL_TARGET = join(REAL_DATA_DIR, `.isolation-gate-probe-real-${process.pid}-${Date.now()}`)

/** 本进程自己的探针基名集合（快照里保留它们；其他实例的探针一律剔除）。 */
const OWN_PROBE_BASENAMES = new Set([PROBE_TARGET, PROBE_REAL_TARGET].map((p) => p.split(/[\\/]/).pop()))

/**
 * 登记一个「由本进程注入、必须留在快照里」的探针落点。
 *
 * 为什么需要它（2026-10-29 实测踩到）：`--selftest` 的父进程把探针模块写到子进程去跑，
 * 而探针模块里**硬编码的是父进程的 PROBE_TARGET**（父 pid + 父时间戳）。子进程 import
 * 这个探针模块后，写的是父进程那个文件名；但子进程自己的 `OWN_PROBE_BASENAMES` 只含
 * 「子 pid」，于是它把**父进程注入的探针**判成「别的实例的探针」剔出快照 ⇒ 场景 1
 * 「注入加载期写盘 → 门必红」**再也不红**（实测 5/5 退化为 4/5）。这是并发防护
 * 反咬判定力度的经典形态：剔除规则必须能认出「注入进来的那个」。
 *
 * 做法：探针模块导出 `PROBE_TARGET`，注入方在 import 成功后立刻把它登记进本进程的
 * 白名单。未登记的探针仍会被剔除（并发防护照旧生效）。
 */
export function adoptProbeTarget(absPath) {
  if (typeof absPath !== 'string' || absPath === '') return
  const base = absPath.split(/[\\/]/).pop()
  if (typeof base === 'string' && base !== '') OWN_PROBE_BASENAMES.add(base)
}

/**
 * 是否为**别的实例**的探针文件（同机并发时剔除，防跨实例污染造成假红）。
 *
 * 只剔除「文件名以本门探针前缀开头、且不是本进程认领的」——本进程自己的探针（含
 * 由 `--inject` 注入进来的那个，见 adoptProbeTarget）必须留在快照里，否则 selftest
 * 的「必红」场景会失效（那才是真的把门弄瞎）。
 */
function isForeignProbe(name) {
  if (!name.startsWith(PROBE_BASENAME_PREFIX)) return false
  return !OWN_PROBE_BASENAMES.has(name)
}

/**
 * 递归快照（路径 + 大小 + mtime + SHA256）。
 *
 * 与 `tests/advisor.test.mjs:2113` 的 `snapshotTree` **同算法但不共享实现**：
 * 门线若复用被测面的辅助函数，辅助函数自身退化时门会跟着一起失明（L1-14）。
 * 目录 mtime **不入快照**（只记 `名字/`），否则「读一次目录」就会造成假差异。
 *
 * @param {string} dir
 * @returns {string[]} 逐行快照；目录不存在 → ['<absent>']
 */
export function snapshotTree(dir) {
  const out = []
  let rootStat
  try { rootStat = statSync(dir) } catch { return ['<absent>'] }
  if (!rootStat.isDirectory()) return ['<not-a-directory>']
  const walk = (current, rel) => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { out.push(`${rel}/<unreadable>`); return }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // 同机并发防护：剔除别的 isolation-gate 实例的探针（本进程自己的保留，见 isForeignProbe）
      if (entry.isFile() && isForeignProbe(entry.name)) continue
      const full = join(current, entry.name)
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { out.push(`${name}/`); walk(full, name); continue }
      try {
        const st = statSync(full)
        out.push(`${name} size=${st.size} mtimeMs=${st.mtimeMs} sha256=${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      } catch (error) {
        out.push(`${name} <stat-failed:${error?.code ?? '?'}>`)
      }
    }
  }
  walk(dir, '')
  return out
}

/** 对全部快照根取快照 → `[{root, entries}]`。 */
export function snapshotRoots(roots = SNAPSHOT_ROOTS) {
  return roots.map((root) => ({ root, entries: snapshotTree(root) }))
}

/**
 * 比较两份 `snapshotRoots()` 结果，返回人类可读差异行（**空数组 = 逐字节相等**）。
 *
 * @param {{root:string,entries:string[]}[]} before
 * @param {{root:string,entries:string[]}[]} after
 * @returns {string[]}
 */
export function diffSnapshots(before, after) {
  const lines = []
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i].entries
    const a = after[i].entries
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    const added = a.filter((x) => !b.includes(x))
    const removed = b.filter((x) => !a.includes(x))
    lines.push(`根 ${before[i].root} 在快照窗口内发生变化（新增 ${added.length} 条 / 消失 ${removed.length} 条）`)
    for (const x of added.slice(0, 20)) lines.push(`  + ${x}`)
    for (const x of removed.slice(0, 20)) lines.push(`  - ${x}`)
  }
  return lines
}

/** 判定「本文件是否为进程入口」（import 本模块时绝不跑门）。 */
function isEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string') return false
  try { return pathToFileURL(entry).href === import.meta.url } catch { return false }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 跑一次门。**返回**退出码而不直接 exit，便于测试与复用；CLI 分支再显式收口。
 *
 * @param {{injectPath?: string|null, noExitClose?: boolean, injectResidual?: boolean, log?: (line:string)=>void}} [options]
 * @returns {Promise<number>} 0=绿；1=红；3=超时预算耗尽
 */
export async function runGate(options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const injectPath = options.injectPath ?? null
  const noExitClose = options.noExitClose === true
  const injectResidual = options.injectResidual === true
  const startedAt = Date.now()
  const lines = []

  // ── 看门狗：把「挂住」变成可判定的红（exit 3）。unref 保证它自己不是残留句柄 ──
  const watchdog = setTimeout(() => {
    log(`[FAIL] 未在 ${EXIT_BUDGET_MS} ms 内收口（残留句柄 / 死锁）——超时即红，不静默`)
    log(`[RESULT] FAIL — exit budget exceeded（budget=${EXIT_BUDGET_MS}ms）`)
    process.exit(EXIT_BUDGET_EXCEEDED)
  }, EXIT_BUDGET_MS)
  watchdog.unref()

  // ── ① 在任何测试模块求值之前拍 before（本门的第一件事，必须最先） ──
  const before = snapshotRoots()
  lines.push(`[facts] 快照根 ${SNAPSHOT_ROOTS.length} 个：`)
  for (const r of SNAPSHOT_ROOTS) lines.push(`  - ${r}`)
  for (const s of before) lines.push(`[before] ${s.root} → ${s.entries.length} 条快照项`)

  // 快照根交叉核对：门的快照目标必须与 lib 的常量同源（否则门在守一个早已换址的目录）
  let targetDrift = null
  try {
    const lib = await import(pathToFileURL(join(REPO_ROOT, 'lib', 'advisor', 'index.js')).href)
    if (lib.DEFAULT_ADVISOR_DATA_DIR !== REAL_DATA_DIR) {
      targetDrift = `lib 常量为 ${lib.DEFAULT_ADVISOR_DATA_DIR}，门线硬编码为 ${REAL_DATA_DIR}`
    }
  } catch (error) {
    targetDrift = `无法导入 lib/advisor/index.js 交叉核对快照目标：${error?.message ?? error}`
  }
  if (targetDrift !== null) lines.push(`[FAIL] 快照目标与 lib 常量不同源：${targetDrift}`)

  // ── ② 注入探针（仅 --selftest 用）→ ③ 求值全部测试模块 ──
  let probeNamespace = null
  if (injectPath !== null) {
    lines.push(`[PROBE] 注入加载期写盘探针模块：${injectPath}`)
    try {
      probeNamespace = await import(pathToFileURL(injectPath).href)
      // 关键：把「注入进来的探针落点」认领为本进程探针，否则它会被并发防护当外实例剔除，
      // 场景 1「注入写盘 → 门必红」会出现假绿（2026-10-29 实测退化 5/5 → 4/5）。
      adoptProbeTarget(probeNamespace?.PROBE_TARGET)
      adoptProbeTarget(probeNamespace?.PROBE_REAL_TARGET)
    } catch (error) {
      lines.push(`[FAIL] 探针模块求值抛错：${error?.message ?? error}`)
    }
  }

  let runnerExit = 0
  try {
    await import(pathToFileURL(join(HERE, 'run.mjs')).href)
    runnerExit = process.exitCode ?? 0
  } catch (error) {
    runnerExit = 1
    lines.push(`[FAIL] run.mjs 求值/执行抛错：${error?.stack ?? error}`)
  }

  // ── ④ 拍 after 并断言相等 ──
  const after = snapshotRoots()
  for (const s of after) lines.push(`[after]  ${s.root} → ${s.entries.length} 条快照项`)
  const diffs = diffSnapshots(before, after)
  if (targetDrift !== null) diffs.unshift(`快照目标与 lib 常量不同源：${targetDrift}`)

  const elapsedMs = Date.now() - startedAt
  const budgetOk = elapsedMs < EXIT_BUDGET_MS
  lines.push(`[ASSERT] 加载期写盘：before/after ${diffs.length === 0 ? '逐字节相等（PASS）' : `不相等（FAIL，${diffs.length} 条差异）`}`)
  lines.push(`[ASSERT] 子 runner 退出码：${runnerExit}（${runnerExit === 0 ? 'PASS' : 'FAIL'}）`)
  lines.push(`[ASSERT] 退出预算：elapsed=${elapsedMs}ms < budget=${EXIT_BUDGET_MS}ms → ${budgetOk ? 'PASS' : 'FAIL'}`)
  for (const d of diffs) lines.push(`[FAIL] ${d}`)

  const code = (!budgetOk || diffs.length > 0 || runnerExit !== 0) ? EXIT_RED : EXIT_OK
  lines.push(`[RESULT] ${code === EXIT_OK ? 'PASS' : 'FAIL'} — isolation-gate（exit=${code}）`)

  // ⚠️ 这里**不能** clearTimeout：`--no-exit-close` 分支靠看门狗把「挂住」转成 exit 3。
  for (const line of lines) log(line)

  // ── after 快照之后的显式收口（C-1） ──
  // 探针文件清理（父进程兜底；子进程内同名单依赖下面这段，见 --inject 分支）。
  for (const candidate of [probeNamespace?.PROBE_TARGET, probeNamespace?.PROBE_REAL_TARGET]) {
    if (typeof candidate === 'string') {
      try { rmSync(candidate, { force: true }) } catch { /* 已被清掉时忽略 */ }
    }
  }

  if (noExitClose) {
    // 故意不显式收口：把退出交给事件循环（C-1 的「残留句柄」形态）。
    // ⚠️ 看门狗**必须保持武装**——它就是「N 秒内退出」这条断言的执行体：
    //    · 若 run.mjs 真的留下句柄（定时器 / AbortController / 未 dispose 的 runtime 池）
    //      或在 --inject-residual 下被注入一个长定时器 → 事件循环不空 → 预算到点 → exit 3；
    //    · 若句柄全部自然排空 → 进程以 process.exitCode（= 门的判定码）自然退出。
    // 把 clearTimeout 放在这一支之前会把看门狗自己关掉，于是「挂住」只能等外部超时
    // ——正是 C-1 说的最坏形态（表现为超时而不是红）。不能那么写。
    process.exitCode = code
    if (injectResidual) setTimeout(() => {}, 600000) // 未 unref 的长定时器 = advisorCallTimeoutMs 的形态（远大于任何测试预算）
    return code
  }
  // 正常路径：显式收口。runner 已改成 process.exitCode，若这里不 exit，残留句柄
  // （定时器 / AbortController / 未 dispose 的 runtime）会把门挂成超时而非红。
  clearTimeout(watchdog)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// --selftest：注入必红 → 移除必绿 → 超时预算必生效
// ---------------------------------------------------------------------------

/**
 * 把探针模块写到临时目录。
 *
 * 探针内容 = **模块顶层写盘**（判据 10 要构造的那类副作用）：
 *   ① 主落点 = `PROBE_TARGET`（工作区内的快照根 ⇒ 本机沙箱下可写，机制完整跑通）；
 *   ② 真实 dataDir 变体 = 尽力尝试一次并**如实打印**结果（workspace-write 沙箱下
 *      `EPERM` —— 这不是静默降级，而是被记录的环境事实；全权限环境下两个根同时红）。
 */
function writeProbeModule() {
  const file = join(tmpdir(), `dsh-isolation-gate-probe-${process.pid}-${Date.now()}.mjs`)
  const body = [
    '// 探针（S0 判据 10）：模块顶层写盘——模拟「加载期写盘」的测试模块。',
    'import { mkdirSync, writeFileSync } from "node:fs"',
    `export const PROBE_LABEL = ${JSON.stringify(PROBE_LABEL)}`,
    `export const PROBE_TARGET = ${JSON.stringify(PROBE_TARGET)}`,
    `export const PROBE_REAL_TARGET = ${JSON.stringify(PROBE_REAL_TARGET)}`,
    `mkdirSync(${JSON.stringify(dirname(PROBE_TARGET))}, { recursive: true })`,
    'writeFileSync(PROBE_TARGET, "isolation-gate probe\\n")',
    'console.log("[PROBE] " + PROBE_LABEL + " 已在模块顶层写盘（快照根内）：" + PROBE_TARGET)',
    'try {',
    `  mkdirSync(${JSON.stringify(dirname(PROBE_REAL_TARGET))}, { recursive: true })`,
    '  writeFileSync(PROBE_REAL_TARGET, "isolation-gate probe\\n")',
    '  console.log("[PROBE] 真实 dataDir 变体同样写盘成功：" + PROBE_REAL_TARGET)',
    '} catch (error) {',
    '  console.log("[facts] 真实 dataDir 变体被环境拒绝（" + (error && error.code) + "）'
      + '——本机 file policy 非全权限；机制对每个快照根同源，故以工作区根变体为准")',
    '}',
    '',
  ].join('\n')
  writeFileSync(file, body)
  return file
}

/**
 * fd-stdio 跑一个子门（**不用 pipe**：受限沙箱内 pipe 捕获必 EPERM）。
 *
 * @param {string[]} args
 * @param {number} budgetMs 传给子进程的退出预算
 * @returns {{status:number|null, error:Error|null, signal:string|null, output:string}}
 */
function runChild(args, budgetMs) {
  const outFile = join(tmpdir(), `dsh-isolation-gate-out-${process.pid}-${Math.random().toString(36).slice(2)}.log`)
  const fd = openSync(outFile, 'w')
  let result = null
  let err = null
  try {
    result = spawnSync(process.execPath, [join(HERE, 'isolation-gate.mjs'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ISOLATION_GATE_EXIT_BUDGET_MS: String(budgetMs) },
      stdio: ['ignore', fd, fd],
      // 保险丝：即使子进程连看门狗都没跑起来，父进程也不无限等
      timeout: budgetMs + 60000,
    })
  } catch (error) {
    err = error
  } finally {
    try { closeSync(fd) } catch { /* 已关忽略 */ }
  }
  let output = ''
  try { output = readFileSync(outFile, 'utf8') } catch { output = '' }
  try { rmSync(outFile, { force: true }) } catch { /* 清理失败不影响判定 */ }
  return {
    status: result?.status ?? null,
    error: err ?? result?.error ?? null,
    signal: result?.signal ?? null,
    output,
  }
}

/** 元测试：四个场景全部达到期望才算「门有牙齿」（必红 → 必绿 → 预算生效 → 零残留）。 */
export function selftest() {
  const probeModule = writeProbeModule()
  const beforeAll = snapshotRoots()
  const results = []
  const lines = []

  try {
    // 场景 1（必红）：注入「模块顶层写盘」探针 → 门必须红，且输出里能看到探针标签
    const red = runChild(['--inject', probeModule], 120000)
    const redOk = red.status === EXIT_RED
      && red.output.includes(PROBE_LABEL)
      && red.output.includes('在快照窗口内发生变化')
    results.push({
      name: '场景1 注入加载期写盘探针 → 门必红（exit=1 + 探针标签可见）',
      ok: redOk,
      detail: `exit=${red.status} signal=${red.signal} 探针标签=${red.output.includes(PROBE_LABEL)}`,
    })
    lines.push(`[场景1] exit=${red.status}；探针标签可见=${red.output.includes(PROBE_LABEL)}；`
      + `配方内 runner 仍报「0 failed」=${/0 failed/.test(red.output)}（=判据 8 的盲区证据：runner 绿而门红）`)
    for (const l of red.output.split('\n').filter((x) => x.startsWith('[FAIL]') || x.startsWith('[RESULT]'))) lines.push(`  ${l}`)

    // 场景 2（必绿）：不注入探针 → 门必须绿
    const green = runChild([], 120000)
    const greenOk = green.status === EXIT_OK && green.output.includes('[RESULT] PASS')
    results.push({
      name: '场景2 移除探针 → 门必绿（exit=0 + [RESULT] PASS）',
      ok: greenOk,
      detail: `exit=${green.status} signal=${green.signal}`,
    })
    lines.push(`[场景2] exit=${green.status}；[RESULT] PASS=${green.output.includes('[RESULT] PASS')}`)

    // 场景 3/3b 的退出预算：**自适应**——先取场景 2（绿跑）实测的套件耗时，再给 2 倍余量。
    // 写死预算会被「套件变慢」误伤：S2 让 run.mjs 从 ~6.7s 涨到 ~15.5s，写死的 8s 会让
    // 看门狗把「套件变慢」误报成「有真实残留句柄」（本门自己的误诊，已修）。
    const greenElapsed = Number((/退出预算：elapsed=(\d+)ms/.exec(green.output) ?? [])[1])
    const hangBudgetMs = Math.max(20000, Number.isFinite(greenElapsed) ? greenElapsed * 2 : 20000)
    lines.push(`[facts] 场景 3/3b 预算 = max(20s, 绿跑实测 ${Number.isFinite(greenElapsed) ? `${greenElapsed}ms` : '解析失败'} × 2) = ${hangBudgetMs}ms`)
    // 场景 3（退出预算必生效，确定性）：--no-exit-close --inject-residual 注入一个未 unref
    // 的长定时器（= advisorCallTimeoutMs 的形态）且不显式收口 → 看门狗必须把它变成 exit 3。
    const hang = runChild(['--no-exit-close', '--inject-residual'], hangBudgetMs)
    const hangOk = hang.status === EXIT_BUDGET_EXCEEDED && hang.output.includes(`未在 ${hangBudgetMs} ms 内收口`)
    results.push({
      name: '场景3 注入残留句柄 + 不显式收口 → 看门狗在预算内 exit=3（C-1 的 N 秒断言可跑）',
      ok: hangOk,
      detail: `exit=${hang.status} signal=${hang.signal} 超时标签=${hang.output.includes(`未在 ${hangBudgetMs} ms 内收口`)}`,
    })
    lines.push(`[场景3] exit=${hang.status}；超时标签可见=${hang.output.includes(`未在 ${hangBudgetMs} ms 内收口`)}`
      + '（这一条把 C-1 的「挂住」从超时形态转成可判定的 exit=3）')

    // 场景 3b（实测登记，不设「必须挂住」的期望）：**不注入任何东西**、只是不显式收口，
    // 看真实残留句柄会不会挂住进程。S0 实测 = 自然退出（约 3s）⇒ C-1 的残留风险
    // 在本仓当前**不成立**，显式收口属预防性条款（S3 引入 agentic 循环 + 超时后必须复测）。
    // 断言只要求「在预算内有确定结局、且不是被外部保险丝杀掉」——两种结局都合法，但必须可辨。
    const plain = runChild(['--no-exit-close'], hangBudgetMs)
    const plainOk = plain.status !== null && plain.output.includes('[RESULT]')
    const plainElapsed = (/(?:退出预算：elapsed=(\d+)ms)/.exec(plain.output) ?? [])[1] ?? '?'
    results.push({
      name: '场景3b 真实残留句柄实测：不注入时必须有确定结局（自然退出 或 看门狗 exit=3）',
      ok: plainOk,
      detail: `exit=${plain.status} signal=${plain.signal} elapsed=${plainElapsed}ms/${hangBudgetMs}ms（${plain.status === EXIT_BUDGET_EXCEEDED ? '看门狗兜住 = 超出预算仍有句柄存活' : '自然退出 = 当前无残留句柄'}）`,
    })
    lines.push(`[场景3b] exit=${plain.status} signal=${plain.signal} elapsed=${plainElapsed}ms/budget=${hangBudgetMs}ms —— `
      + (plain.status === EXIT_BUDGET_EXCEEDED
        ? '实测：run.mjs 结束后**仍有**句柄存活（超出预算）'
        : '实测：run.mjs 结束后**无**残留句柄（自然退出）；显式收口为预防性条款'))
  } finally {
    // 父进程兜底清理探针（子进程内也清；这里保证即使子进程崩了也不留残渣）
    for (const target of [PROBE_TARGET, PROBE_REAL_TARGET]) {
      try { rmSync(target, { force: true }) } catch { /* 忽略 */ }
    }
    try { rmSync(probeModule, { force: true }) } catch { /* 忽略 */ }
  }

  // 复原断言：整个 selftest 前后，两个快照根必须逐字节零变化（探针不得留下残渣）
  const afterAll = snapshotRoots()
  const residue = diffSnapshots(beforeAll, afterAll)
  const restoredOk = residue.length === 0
  results.push({
    name: '场景4 selftest 自身零残留：两个快照根前后逐字节相等',
    ok: restoredOk,
    detail: residue.join(' | ') || '无差异',
  })

  const failed = results.filter((r) => !r.ok)
  const ok = failed.length === 0
  console.log('== dsh-agents isolation-gate --selftest ==')
  console.log(`[facts] 快照根：${SNAPSHOT_ROOTS.join(' | ')}`)
  console.log(`[facts] 探针落点：${PROBE_TARGET}`)
  for (const l of lines) console.log(l)
  console.log(`[NEG] 场景：${results.length - failed.length}/${results.length} 达到期望`)
  for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}（${r.detail}）`)
  console.log(`[RESULT] ${ok ? 'PASS — 门有牙齿（必红 → 必绿 → 预算生效 → 零残留）' : 'FAIL — 判据退化'}`)
  return ok ? EXIT_OK : EXIT_RED
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    process.exit(selftest())
  }
  const injectAt = argv.indexOf('--inject')
  const injectPath = injectAt >= 0 ? argv[injectAt + 1] : null
  if (injectAt >= 0 && (injectPath === undefined || injectPath.startsWith('--'))) {
    console.error('[FAIL] --inject 需要一个模块路径参数')
    process.exit(EXIT_RED)
  }
  await runGate({
    injectPath,
    noExitClose: argv.includes('--no-exit-close'),
    injectResidual: argv.includes('--inject-residual'),
  })
}

// 只在**作为入口直跑**时执行（被 import 时零副作用 —— S0 判据 11）
if (isEntry()) main()
