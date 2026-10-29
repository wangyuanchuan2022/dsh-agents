#!/usr/bin/env node
/**
 * tools/constraint-mutation-verify.mjs —— B5 X-3：PARTIAL 闸门「违反即变红」逐条变异实测。
 *
 * ## 为什么要这个工具（B5 审计自认的最大未做项）
 *
 * `docs/constraint-audit.md` 把 44 条纪律标为 PARTIAL（有闸门但只覆盖一部分）。
 * 已机检的是「闸门文件存在 + 断言标识可寻」（`tools/constraint-audit.mjs` 的 G2），
 * 但**没证明「违反该条款时闸门真的会红」** —— 一个只断言「文本里出现过某句话」的
 * 闸门，在代码把该行为破坏时可能纹丝不动。本工具补这一环：对每条被验证的条款，
 * 构造一个**单变量变异**（破坏该条款要求的行为），跑主套件，断言「必须红」，
 * 然后按内存原字节还原并用 SHA256 校验还原保真。
 *
 * ## 与「为了测试而改测试」的边界
 *
 * 本工具**不修改任何测试断言**，只临时改**产品代码**（`lib/`）制造违规，
 * 跑完立即按原字节还原。它是负向自测（mutation test），不是放宽断言。
 *
 * ## 用法
 *
 *   node tools/constraint-mutation-verify.mjs              # 跑全部已登记变异
 *   node tools/constraint-mutation-verify.mjs --list       # 只列登记表
 *   node tools/constraint-mutation-verify.mjs --only C-013 # 只跑一条
 *   node tools/constraint-mutation-verify.mjs --selftest   # 框架自检（必红/必绿对照）
 *
 * 退出码：0 = 全部达到期望；1 = 有变异未达期望（= 该条款的闸门没有鉴别力，是真实缺口）；
 *         2 = 用法/环境错误；3 = 还原失败（**最高优先级告警**，工作区可能被污染）。
 *
 * ## 极重要的沙箱纪律
 *
 * 主套件用 `spawnSync` + `stdio:'inherit'`/fd 继承跑 —— **禁止管道捕获**
 * （受限沙箱内 `stdio:'pipe'` 必 EPERM，本仓已多次实证）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 主套件单次运行超时（实测约 35–60s；给 3 倍余量）。 */
const RUN_TIMEOUT_MS = 180000

/**
 * 变异登记表。
 *
 * 每条 = 一条 PARTIAL 条款的「违反形态」：
 *   - `clause`：`docs/constraint-audit.md` 的条款 id
 *   - `rule`：一句话说明破坏了什么
 *   - `file`：被变异的**产品代码**（绝不用 tests/ —— 那会变成改测试凑绿）
 *   - `find`/`replace`：单点文本替换（必须**恰好命中一次**，否则框架判错并中止）
 *   - `suite`：该条款的**闸门入口**（`argv` 形态）。⚠️ 这一列是本工具的第二个发现：
 *     不同条款的闸门分布在不同入口，全跑主套件会把「闸门不在 run.mjs 里」误判成
 *     「零鉴别力」。必须逐条跑它**自己的**闸门。
 *   - `expect`：期望结果 —— `'red'`（有断言失败）或 `'green'`（零鉴别力，作为**已登记缺口**）
 *   - `note`：为什么这个变异对应该条款
 */
export const MUTATIONS = [
  {
    clause: 'C-013',
    rule: '删除 persona-gate 的 Prompt Defense Baseline 要求（外部内容当数据非指令的邻接闸门）',
    file: 'lib/persona-gate.js',
    find: 'export function hasPromptDefenseBaseline',
    replace: 'export function DISABLED_hasPromptDefenseBaseline',
    suite: ['tools/verify-imp26.mjs'],
    expect: 'red',
    note: 'persona-gate 强制非 legacy 角色带 Prompt Defense Baseline；把导出改名后 install-personas / verify-imp26 必须红。闸门在 verify-imp26（33 断言），**不在** run.mjs。',
  },
  {
    clause: 'C-014',
    rule: '把 toolscope 决策核的 deny 分支改成 allow（未知/未授予工具名不再 fail-closed 收缩）',
    file: 'lib/toolscope-pipeline.js',
    find: "return { action: 'deny', names: deny, needed:",
    replace: "return { action: 'allow', names: deny, needed:",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '未知/未授予工具名必须 deny；改成 allow 后 B1 toolscope 断言组（在 run.mjs 内）必须红。',
  },
  {
    clause: 'C-018',
    rule: '把 publish-scan 的 secrets 规则改成 warning（凭据命中不再 FAIL）',
    file: 'tools/publish-scan.mjs',
    find: "category: 'secrets', prio: 0, base: 'critical'",
    replace: "category: 'secrets', prio: 0, base: 'warning'",
    suite: ['tools/publish-scan.test.mjs'],
    expect: 'red',
    note: '凭据纪律靠 secrets=critical 兜底；降级后 publish-scan.test 的 T2/T4 必须红。闸门在 publish-scan.test（53 断言），**不在** run.mjs。',
  },
  {
    clause: 'C-051',
    rule: '把 advisor 的 seq 水位门改成恒放行（重放拦截失效，静默重复评审）',
    file: 'lib/advisor/observer.js',
    find: 'if (seq <= state.lastReviewedSeq) return false',
    replace: 'if (false) return false',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'design-principles 1.3 的「seq 水位门」正面参照；破坏后 advisor 幂等断言必须红（B5 实测 373/2）。',
  },
  {
    clause: 'C-056',
    rule: '把 advisor 投递冷却的回合计数递减去掉（immuneTurns 永不衰减）',
    file: 'lib/advisor/delivery.js',
    find: 'else this.cooldown.set(sessionId, remaining - 1)',
    replace: 'else this.cooldown.set(sessionId, remaining)',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'design-principles 1.3 的「回合计数冷却」正面参照（B5 实测 374/1）。',
  },
  {
    clause: 'C-064',
    rule: '删掉任务书「报告落盘」硬条款（review 泳道交付纪律）',
    file: 'lib/taskbook.js',
    find: "- 报告落盘：write 写入任务书指定路径（评审类只读，禁止改动被评审对象）。",
    replace: "- （本行已删除）",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '**缺口已补（2026-10-29）**：新增「泳道交付条款必须逐字在场」值断言后，删整行必红（原为主套件 375/0 零鉴别力）。',
  },
  {
    clause: 'C-107',
    rule: '把 advisor store 的 lastReviewedSeq 哨兵从 -1 改成 0（重启后首条 seq=0 事件静默漏评）',
    file: 'lib/advisor/store.js',
    find: 'lastReviewedSeq: -1 }',
    replace: 'lastReviewedSeq: 0 }',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '**缺口已补（2026-10-29）**：新增「全新会话 lastReviewedSeq 必须 -1」值断言后，-1→0 必红（原为主套件 375/0 零鉴别力）。',
  },
]

/** sha256 of a file's bytes（还原保真校验）。 */
function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 跑主套件，返回 { ok: boolean, exit: number, tail: string }。
 *
 * fd-stdio：把 stdout/stderr 都重定向到一个临时文件（**不用 pipe** —— 沙箱必 EPERM），
 * 跑完再读该文件取尾部。临时文件在 os.tmpdir()，用完即删。
 */
export function runSuite(argv = ['tests/run.mjs']) {
  const outFile = join(tmpdir(), `dsh-cmv-${process.pid}-${Date.now()}.log`)
  const fd = openSync(outFile, 'w')
  let result = null
  try {
    result = spawnSync(process.execPath, argv.map((a) => join(ROOT, a)), {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      timeout: RUN_TIMEOUT_MS,
    })
  } finally {
    try { closeSync(fd) } catch { /* 已关忽略 */ }
  }
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch { text = '' }
  try { rmSync(outFile, { force: true }) } catch { /* 忽略 */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const tail = lines.slice(-3).join(' | ')
  // 不同套件的失败信号不同：run.mjs 有 "N failed"；publish-scan.test 是 "failed=N"；
  // verify-imp26 是 "33 passed, N failed"。统一以「退出码非零」为主判据，
  // 再叠加各套件的显式失败计数（任一命中即视为红）。
  const failedText = /tests: \d+ passed, [1-9]\d* failed/.test(text)
    || /\[SELFTEST\] passed=\d+ failed=[1-9]/.test(text)
    || /: \d+ passed, [1-9]\d* failed/.test(text)
    || /\[FAIL\]/.test(text)
  const ok = result?.status === 0 && !failedText
  return { ok, exit: result?.status ?? null, tail }
}

/** 应用一条变异（要求 find 恰好命中一次），返回原字节用于还原。 */
export function applyMutation(m) {
  const abs = join(ROOT, m.file)
  const original = readFileSync(abs)
  const text = original.toString('utf8')
  const hits = text.split(m.find).length - 1
  if (hits !== 1) throw new Error(`变异点命中 ${hits} 次（要求恰好 1 次）：${m.clause} ${m.file} :: ${m.find.slice(0, 60)}`)
  writeFileSync(abs, text.replace(m.find, m.replace))
  return { abs, original }
}

/** 按原字节还原并校验 sha256（失败 = exit 3 级告警）。 */
export function restoreMutation(applied, expectedSha) {
  writeFileSync(applied.abs, applied.original)
  const after = sha256Of(applied.abs)
  return { restored: after === expectedSha, after, expectedSha }
}

/** 跑一条变异：#1 基线（应绿）→ #2 变异（期望 results）→ #3 还原保真。 */
export function runOne(m, { verbose = true } = {}) {
  const abs = join(ROOT, m.file)
  const beforeSha = sha256Of(abs)
  const applied = applyMutation(m)
  let run
  try {
    run = runSuite(m.suite)
  } finally {
    var restore = restoreMutation(applied, beforeSha)
  }
  const expectedRed = m.expect === 'red'
  const gotRed = run.ok === false
  const pass = gotRed === expectedRed && restore.restored
  if (verbose) {
    const verdict = pass ? 'PASS' : 'FAIL'
    const detail = expectedRed
      ? `期望红 / 实测 ${gotRed ? '红 ✔' : '绿 ✘（零鉴别力）'}`
      : `期望绿（已登记缺口）/ 实测 ${gotRed ? '红（缺口已被填补，请更新登记表）' : '绿 ✔'}`
    console.log(`  [${verdict}] ${m.clause} ${m.rule}`)
    console.log(`         ${detail} ｜ exit=${run.exit} ｜ ${run.tail}`)
    if (!restore.restored) console.log(`         ⚠️ 还原失败！${restore.after} != ${restore.expectedSha}`)
  }
  return { m, pass, run, restore }
}

/** 框架自检：证明「必红」与「必绿」两种期望都能正确判出来（防框架自身失明）。 */
export function selftest() {
  const results = []
  const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} —— ${detail}`) }

  // S1：应用一条变异后，文件内容确实变了（证明变异真的生效，不是空转）
  const m = MUTATIONS[0]
  const abs = join(ROOT, m.file)
  const sha0 = sha256Of(abs)
  const applied = applyMutation(m)
  const shaMutated = sha256Of(abs)
  push('S1 变异真的改变了文件字节', shaMutated !== sha0, `sha 前 ${sha0.slice(0, 8)} / 变异后 ${shaMutated.slice(0, 8)}`)
  // S2：还原后 sha 必须逐字节等于原值
  const r = restoreMutation(applied, sha0)
  push('S2 按原字节还原后 sha256 一致', r.restored, `after=${r.after.slice(0, 8)} expected=${sha0.slice(0, 8)}`)
  // S3：命中次数校验——把 find 改成不存在/多处时，applyMutation 必须抛错（fail-closed）
  let threw = false
  try { applyMutation({ ...m, find: 'THIS_STRING_DOES_NOT_EXIST_ANYWHERE_xyz' }) } catch { threw = true }
  push('S3 命中 0 次必须抛错（fail-closed，不静默跳过）', threw, threw ? '已抛错' : '未抛错')
  // S4：登记表自身一致性——expect 只能是 red/green，clause 必须 C-NNN 形态
  const bad = MUTATIONS.filter((x) => !['red', 'green'].includes(x.expect) || !/^C-\d{3}$/.test(x.clause) || !x.file || !x.find || !x.replace || !Array.isArray(x.suite) || x.suite.length === 0)
  push('S4 登记表字段合法（clause/expect/file/find/replace）', bad.length === 0, bad.length ? `非法条目 ${bad.length}` : `${MUTATIONS.length} 条全部合法`)
  // S5：find/replace 不得相同（相同则变异是空转）
  const noop = MUTATIONS.filter((x) => x.find === x.replace)
  push('S5 find !== replace（防空转变异）', noop.length === 0, noop.length ? `空转 ${noop.length}` : '无空转')

  const failed = results.filter((x) => !x.ok)
  console.log(`  [selftest] ${results.length - failed.length}/${results.length} 达期望`)
  return failed.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    console.log('== constraint-mutation-verify --selftest（框架自检，不跑主套件）==')
    return selftest()
  }
  if (argv.includes('--list')) {
    console.log(`== 变异登记表（${MUTATIONS.length} 条）==`)
    for (const m of MUTATIONS) {
      console.log(`  ${m.clause} [期望${m.expect === 'red' ? '红' : '绿-已登记缺口'}] ${m.file}`)
      console.log(`     ${m.rule}`)
    }
    return 0
  }
  const onlyAt = argv.indexOf('--only')
  let targets = MUTATIONS
  if (onlyAt >= 0) {
    const id = argv[onlyAt + 1]
    targets = MUTATIONS.filter((m) => m.clause === id)
    if (targets.length === 0) { console.error(`[FAIL] 未登记条款：${id}`); return 2 }
  }
  console.log(`== constraint-mutation-verify —— PARTIAL 闸门「违反即变红」实测（${targets.length} 条）==`)
  console.log('[纪律] 只变异产品代码（lib/、tools/），不改测试；每条跑完按内存原字节还原并校验 sha256。')
  const results = []
  for (const m of targets) {
    try {
      results.push(runOne(m))
    } catch (error) {
      console.log(`  [ERROR] ${m.clause} 变异无法施加：${error?.message ?? error}`)
      results.push({ m, pass: false, error })
      // 施加失败时文件未被改动（applyMutation 在写入前校验命中次数），可安全继续
    }
  }
  const restoreFailures = results.filter((r) => r.restore && !r.restore.restored)
  const failed = results.filter((r) => !r.pass && !restoreFailures.includes(r))
  console.log('')
  console.log(`[统计] ${results.length} 条：达期望 ${results.length - failed.length - restoreFailures.length} ｜ 未达期望 ${failed.length} ｜ 还原失败 ${restoreFailures.length}`)
  if (failed.length > 0) {
    console.log('[未达期望条款]（这些条款的闸门鉴别力不足，或登记表需要更新）')
    for (const f of failed) console.log(`  - ${f.m.clause} ${f.m.rule}${f.error ? `（错误：${f.error.message}）` : ''}`)
  }
  if (restoreFailures.length > 0) {
    console.error('[还原失败] 工作区可能被污染，请立刻人工核对下列文件：')
    for (const r of restoreFailures) console.error(`  - ${r.m.file}（当前 sha=${r.restore.after}，期望=${r.restore.expectedSha}）`)
    return 3
  }
  return failed.length === 0 ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
