#!/usr/bin/env node
/**
 * session-guard.mjs — 会话 liveness/悬尾检查（M5-4 guard 接线，plan-opt-r2 §五 工作流 B）。
 *
 * 职责（opt-r1-m5-verdict §四 逐条落地）：消费 tools/measure-decay.mjs --scan --json 的
 * 悬尾字段（tailDangling / lastEventAt / sessionId），按 liveness 核对序输出三态分类——
 *   构造性在飞（liveness=running 或 guard 自身白名单或尾龄≈0；跳过等下一拍）
 *   疑转净  （尾龄 < 阈值且非在飞；建议重扫确认）
 *   死亡·中止候选（尾龄 ≥ 阈值；只报警不判因）
 * 阈值 24h 起步：实测尾龄双峰间隔 16 天无人区（0h vs 388h+），阈值在该区间内不敏感。
 *
 * 边界（verdict 裁定落地，与本实现一一对应）：
 *   - 密度衰减字段（segments[].density）禁入分类判据（该用途已由 verdict §三 作废）——
 *     分类只消费 tailDangling/lastEventAt/sessionId 三字段，density 全程不读。
 *   - 候选只报警不判因；死因走人事后确认（C-8 式裁定）累积进 agent-out/death-cases.md
 *     （--death-cases <file> 追加模板行，按 sessionId 幂等去重；
 *     库内「已证实无声死亡」≥1 例前不部署任何无声死亡特异判别）。
 *   - liveness 的取得形态（如实声明）：脚本无法调用 de_session 工具——无 --live-* 输入时
 *     输出「待 liveness 核对清单 + 组织者核对指令（de_session status <id>）」；
 *     --live-running/--live-idle/--live-offline <id,id,…> 由组织者巡检时粘贴状态回填二次分类。
 *   - 「测量者自悬」排除（A1 设计定案）：--self <id> 白名单强制在飞（双通道之一）；
 *     liveness=running 与尾龄≈0 年龄窗为天然覆盖（三代实证的瞬态悬尾尾龄均 ≈0h）。
 *
 * 用法：
 *   node tools/session-guard.mjs --selftest
 *   node tools/session-guard.mjs --scan [--in <scan.json>] [--min-core N] [--threshold-hours H]
 *        [--inflight-hours H] [--live-running id1,id2] [--live-idle id] [--live-offline id]
 *        [--self id] [--death-cases <path>] [--json] [--verbose]
 *
 * 输入：默认现场调 measure-decay --scan --json（子进程 fd 继承取输出——沙箱内 stdio:'pipe'
 * 捕获会 EPERM，故落临时文件再读）；--in <file> 直接消费预生成的 scan JSON（等价口径）。
 * 输出脱敏：与 measure-decay 同口径——会话只以 sessionId 标识，零消息正文零文件路径。
 * 退出码：0=巡检报告完成（候选是报警不是失败）；1=运行失败；2=用法错误。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, openSync, closeSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const MEASURE_DECAY = join(HERE, 'measure-decay.mjs')

const GUARD_THRESHOLD_H = 24 // 死亡·中止候选阈值（24h 起步，verdict §四.1）
const GUARD_INFLIGHT_H = 1   // 无 liveness 时的「构造性在飞」尾龄窗（在飞实测尾龄 ≈0h；须 < 阈值）

const STATE_CLEAN = 'clean'
const STATE_INFLIGHT = 'inflight'
const STATE_SUSPECT = 'suspect'
const STATE_CANDIDATE = 'candidate'
const STATE_LABELS = {
  [STATE_CLEAN]: '干净（无悬尾）',
  [STATE_INFLIGHT]: '构造性在飞（跳过等下一拍）',
  [STATE_SUSPECT]: '疑转净（建议重扫确认）',
  [STATE_CANDIDATE]: '死亡·中止候选（只报警不判因）',
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '?')
const r2 = (x) => Math.round(x * 100) / 100

/** 尾龄（小时）；lastEventAt 缺失/非有限数 → null（防御分支，分类为疑转并注明）。 */
function ageHours(row, ctx) {
  const t = row ? row.lastEventAt : null
  return Number.isFinite(t) ? (ctx.nowMs - t) / 3.6e6 : null
}

/**
 * 三态分类（核心判据）。liveness 核对序（verdict §四.1）：
 *   running/self 白名单 → 在飞（瞬态悬尾，等下一拍；age 只作记录不作判据）
 *   尾龄 ≥ 阈值        → 死亡·中止候选（idle/offline 均不豁免；liveness 记录在案）
 *   尾龄 < 在飞窗      → 构造性在飞（无 liveness 时的年龄窗天然覆盖）
 *   其余               → 疑转净（建议重扫确认）
 * 密度禁入：本函数与 ageHours 均不触碰 row.segments（mutant M3 负向自测守护该边界）。
 */
function classifyRow(row, ctx) {
  const id = (row && row.sessionId) || null
  const dangling = row ? row.tailDangling || null : null
  const ageH = ageHours(row, ctx)
  if (!dangling) return { sessionId: id, state: STATE_CLEAN, tailDangling: null, ageH: Number.isFinite(ageH) ? r2(ageH) : null }
  if (ctx.live.get(id) === 'running' || ctx.selfIds.has(id)) return { sessionId: id, state: STATE_INFLIGHT, tailDangling: dangling, ageH: Number.isFinite(ageH) ? r2(ageH) : null, via: ctx.live.get(id) === 'running' ? 'liveness:running' : 'self-whitelist', lastEventAt: row.lastEventAt }
  if (ageH === null) return { sessionId: id, state: STATE_SUSPECT, tailDangling: dangling, ageH: null, liveness: ctx.live.get(id) || null, note: 'lastEventAt 缺失，尾龄不可判（防御分支）', lastEventAt: row.lastEventAt }
  if (ageH >= ctx.thresholdH) return { sessionId: id, state: STATE_CANDIDATE, tailDangling: dangling, ageH: r2(ageH), liveness: ctx.live.get(id) || 'offline/不在清单', lastEventAt: row.lastEventAt }
  if (ageH < ctx.inflightH) return { sessionId: id, state: STATE_INFLIGHT, tailDangling: dangling, ageH: r2(ageH), via: 'age-window', liveness: ctx.live.get(id) || null, lastEventAt: row.lastEventAt }
  return { sessionId: id, state: STATE_SUSPECT, tailDangling: dangling, ageH: r2(ageH), liveness: ctx.live.get(id) || null, lastEventAt: row.lastEventAt }
}

/** 对 rows 全量分类；opts={nowMs,thresholdH,inflightH,live:Map,selfIds:Set}。 */
function classifyRows(rows, opts) {
  const ctx = {
    nowMs: Number.isFinite(opts && opts.nowMs) ? opts.nowMs : Date.now(),
    thresholdH: Number.isFinite(opts && opts.thresholdH) ? opts.thresholdH : GUARD_THRESHOLD_H,
    inflightH: Number.isFinite(opts && opts.inflightH) ? opts.inflightH : GUARD_INFLIGHT_H,
    live: opts && opts.live instanceof Map ? opts.live : new Map(),
    selfIds: opts && opts.selfIds instanceof Set ? opts.selfIds : new Set(),
  }
  if (!(ctx.inflightH < ctx.thresholdH)) throw new Error(`配置非法：inflightH(${ctx.inflightH}) 必须 < thresholdH(${ctx.thresholdH})`)
  return (rows || []).map((row) => classifyRow(row, ctx))
}

// sessionId 白名单（2026-10-26 security R2 P2-3）：sessionId 来自日志 session 头行 head.id，
// 损坏/恶意日志可携带含 `|`/换行的任意串——写入 death-cases.md 表格前白名单校验，非法形态
// 替换为净化占位（宿主真实形态 = session-<uuid>，白名单不伤真值）。占位内非白名单字符
// 一并替换为 `_`：截断预览若保留原始字符（如 `|`、换行）则注入面未关死。
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const safeId = (id) => {
  if (id && SAFE_ID_RE.test(id)) return id
  const preview = String(id ?? '').slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '_')
  return preview ? `?(${preview}…)` : '?'
}

/** 死因人事后确认的累积模板行（guard 只报警不判因；死因列恒为「待人工裁定」占位）。 */
function templateRow(c, nowMs) {
  return `| ${iso(nowMs)} | ${safeId(c.sessionId)} | ${c.tailDangling || '?'} | ${iso(c.lastEventAt)} | ${Number.isFinite(c.ageH) ? c.ageH.toFixed(1) : '?'} | （待人工裁定） | （待填：de_session status 读数 / 用户裁定原文） | guard 自动追加 |`
}

const DEATH_CASES_HEADER = [
  '# death-cases.md — 悬尾候选死因 ground-truth 案例库',
  '',
  '<!-- guard 对「死亡·中止候选」只报警不判因（m5-verdict §四.2）；死因由人事后确认（C-8 式裁定）回填本表「死因裁定/证据」两列。',
  '     库内「已证实无声死亡」案例 ≥1 例之前，不部署任何无声死亡特异判别（AC-M5-3 方向判定在案例库充实后可重开）。',
  '     本文件由 tools/session-guard.mjs --death-cases 追加（按 sessionId 幂等去重）。 -->',
  '',
  '| 确认时点 | sessionId | 悬尾类型 | lastEventAt | 尾龄(h) | 死因裁定 | 证据/裁定来源 | 备注 |',
  '|---|---|---|---|---|---|---|---|',
  '',
].join('\n')

/** 向案例库幂等追加候选模板行：已含该 sessionId 的行跳过；文件不存在则先写头。 */
function appendDeathCases(filePath, candidates, nowMs) {
  let text
  if (existsSync(filePath)) {
    text = readFileSync(filePath, 'utf8')
    if (!text.endsWith('\n')) text += '\n'
  } else {
    text = DEATH_CASES_HEADER
  }
  const fresh = (candidates || []).filter((c) => c.sessionId && !text.includes(safeId(c.sessionId)))
  if (!fresh.length) return { appended: 0, skipped: (candidates || []).length, filePath }
  text += fresh.map((c) => templateRow(c, nowMs)).join('\n') + '\n'
  writeFileSync(filePath, text, 'utf8')
  return { appended: fresh.length, skipped: (candidates || []).length - fresh.length, filePath }
}

// ---------- CLI（--scan） ----------

function usageExit(msg) {
  console.error(`[用法错误] ${msg}`)
  process.exit(2)
}

function numArg(argv, flag, dflt, int) {
  const i = argv.indexOf(flag)
  if (i < 0) return dflt
  const v = argv[i + 1]
  const re = int ? /^\d+$/ : /^\d+(\.\d+)?$/
  if (v === undefined || !re.test(String(v))) usageExit(`${flag} 需要非负${int ? '整数' : '数'}，收到：${v ?? '(缺值)'}`)
  return Number(v)
}

function idsArg(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) usageExit(`${flag} 需要逗号分隔的会话 id`)
    out.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
  }
  return out
}

/** 取 scan 数据：--in 读文件；否则现场 spawn measure-decay（fd 继承，沙箱安全）。 */
function loadScan(argv, minCore) {
  const inIdx = argv.indexOf('--in')
  if (inIdx >= 0) {
    const p = argv[inIdx + 1]
    if (!p || p.startsWith('--')) usageExit('--in 需要 measure-decay --scan --json 输出文件路径')
    let text
    try { text = readFileSync(p, 'utf8') } catch (e) { fatal(`--in 文件读取失败：${e.message}`) }
    return parseScan(text, `--in ${p}`)
  }
  // fd 继承取子进程输出（L1-01：沙箱内 stdio:'pipe' 捕获会 EPERM——落临时文件再读）
  let tmp = null
  try { tmp = mkdtempSync(join(tmpdir(), 'session-guard-')) } catch { tmp = join(REPO_ROOT, 'agent-out', `.guard-${process.pid}-${Date.now()}`); mkdirSync(tmp, { recursive: true }) }
  const outPath = join(tmp, 'scan.json')
  const fd = openSync(outPath, 'w')
  try {
    const r = spawnSync(process.execPath, [MEASURE_DECAY, '--scan', '--min-core', String(minCore), '--json'], { stdio: ['ignore', fd, 'inherit'], cwd: REPO_ROOT })
    if (r.error) fatal(`spawn measure-decay 失败：${r.error.message}（替代：node tools/measure-decay.mjs --scan --min-core 0 --json > scan.json 后用 --in 接入）`)
    if (typeof r.status === 'number' && r.status !== 0) fatal(`measure-decay exit ${r.status}（替代：同上 --in 两步法）`)
  } finally { closeSync(fd) }
  let text
  try { text = readFileSync(outPath, 'utf8') } finally { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不遮蔽主流程 */ } }
  return parseScan(text, 'spawn:measure-decay')
}

function parseScan(text, via) {
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { fatal(`scan JSON 解析失败（${via}）：${e.message}`) }
  if (!parsed || !Array.isArray(parsed.rows)) fatal(`输入不是 measure-decay --scan --json 形状（缺 rows 数组；${via}）`)
  if (!Array.isArray(parsed.errors)) fatal(`输入缺 errors 数组（${via}）`)
  parsed._via = via
  return parsed
}

function fatal(msg) {
  console.error(`[session-guard] ${msg}`)
  process.exit(1)
}

function runScan(argv) {
  const minCore = numArg(argv, '--min-core', 0, true) // guard 默认全量：短会话悬尾同为死亡候选面（verdict §2.1 短会话 3 条）
  const thresholdH = numArg(argv, '--threshold-hours', GUARD_THRESHOLD_H)
  const inflightH = numArg(argv, '--inflight-hours', GUARD_INFLIGHT_H)
  if (!(inflightH < thresholdH)) usageExit(`--inflight-hours(${inflightH}) 必须 < --threshold-hours(${thresholdH})`)
  const dcIdx = argv.indexOf('--death-cases')
  const deathCasesPath = dcIdx >= 0 ? argv[dcIdx + 1] : null
  if (dcIdx >= 0 && (!deathCasesPath || deathCasesPath.startsWith('--'))) usageExit('--death-cases 需要文件路径')

  const live = new Map()
  const put = (flag, status) => { for (const id of idsArg(argv, flag)) { if (live.has(id) && live.get(id) !== status) usageExit(`会话 ${id} 被同时声明两种 liveness 状态`); live.set(id, status) } }
  put('--live-running', 'running'); put('--live-idle', 'idle'); put('--live-offline', 'offline')
  const selfIds = new Set(idsArg(argv, '--self'))

  const nowMs = Date.now()
  const scan = loadScan(argv, minCore)
  const cls = classifyRows(scan.rows, { nowMs, thresholdH, inflightH, live, selfIds })
  const groups = { [STATE_CLEAN]: [], [STATE_INFLIGHT]: [], [STATE_SUSPECT]: [], [STATE_CANDIDATE]: [] }
  for (const c of cls) groups[c.state].push(c)
  const checklist = [...groups[STATE_CANDIDATE], ...groups[STATE_SUSPECT]].map((c) => ({ sessionId: c.sessionId, command: `de_session status ${c.sessionId}` }))
  let dcResult = null
  if (deathCasesPath) dcResult = appendDeathCases(deathCasesPath, groups[STATE_CANDIDATE], nowMs)

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      scanned: scan.rows.length,
      errors: scan.errors,
      input: scan._via,
      now: iso(nowMs),
      thresholdH,
      inflightH,
      counts: { clean: groups[STATE_CLEAN].length, inflight: groups[STATE_INFLIGHT].length, suspect: groups[STATE_SUSPECT].length, candidate: groups[STATE_CANDIDATE].length },
      candidates: groups[STATE_CANDIDATE],
      suspects: groups[STATE_SUSPECT],
      inflight: groups[STATE_INFLIGHT],
      checklist,
      deathCasesTemplate: groups[STATE_CANDIDATE].map((c) => templateRow(c, nowMs)),
      deathCases: dcResult,
    }, null, 1))
    return
  }
  console.log(`== session-guard 悬尾巡检 ==  scanned=${scan.rows.length} errors=${scan.errors.length} input=${scan._via}`)
  console.log(`阈值=${thresholdH}h 在飞窗=${inflightH}h now=${iso(nowMs)} liveness 回填=${live.size} 条 self 白名单=${selfIds.size} 条`)
  if (scan.errors.length) for (const e of scan.errors) console.error(`ERR ${e.file} :: ${e.error}`)
  console.log(`\n[死亡·中止候选] ${groups[STATE_CANDIDATE].length} 条（只报警不判因；死因人事后确认）`)
  for (const c of groups[STATE_CANDIDATE]) {
    console.log(`  ${c.sessionId}  dangling=${c.tailDangling} 尾龄=${c.ageH}h last=${iso(c.lastEventAt)} liveness=${c.liveness}`)
    console.log(`    核对指令：de_session status ${c.sessionId}`)
    console.log(`    模板行：${templateRow(c, nowMs)}`)
  }
  console.log(`\n[疑转净] ${groups[STATE_SUSPECT].length} 条（尾龄<${thresholdH}h，建议重扫确认）`)
  for (const c of groups[STATE_SUSPECT]) console.log(`  ${c.sessionId}  dangling=${c.tailDangling} 尾龄=${c.ageH}h liveness=${c.liveness ?? '-'}${c.note ? ' 注:' + c.note : ''}`)
  console.log(`\n[构造性在飞] ${groups[STATE_INFLIGHT].length} 条（跳过等下一拍）`)
  for (const c of groups[STATE_INFLIGHT]) console.log(`  ${c.sessionId}  dangling=${c.tailDangling} 尾龄=${c.ageH}h via=${c.via}`)
  console.log(`\n[干净] ${groups[STATE_CLEAN].length} 条（无悬尾）`)
  console.log(`\n待 liveness 核对清单（候选+疑转，${checklist.length} 条）——读数用 --live-running/--live-idle/--live-offline 回填二次分类：`)
  for (const c of checklist) console.log(`  ${c.command}`)
  if (dcResult) console.log(`\ndeath-cases：追加 ${dcResult.appended} / 跳过已存在 ${dcResult.skipped} → ${dcResult.filePath}`)
}

// ---------- selftest（夹具 ≥3 态 + 注入必红 3 变异体 + 原件全绿） ----------

/** 模块自引用（selftest 谓词对「原件」跑用；变异测试对临时副本跑用，两者同一谓词可比较）。 */
const SELF_MOD = { classifyRows, classifyRow, templateRow, appendDeathCases }

/** 夹具构造（≥3 元素输入，断言鉴别力①：三态 × 多元素；closed-fact 形态 423h/388h 直接入夹具）。 */
function makeFixture(nowMs) {
  const H = 3.6e6
  const mk = (id, dangling, ageH, lateDensity) => ({
    sessionId: id,
    tailDangling: dangling,
    lastEventAt: nowMs - ageH * H,
    coreEvents: 42,
    segments: [{ name: 'early', density: 0.5 }, { name: 'mid', density: 0.4 }, { name: 'late', density: lateDensity }],
  })
  return [
    mk('session-f-inflight', 'tool/call', 100, 0.6),  // liveness=running（尾龄故意超阈值——只有 liveness 分支能保它不判死）
    mk('session-f-self', 'step/start', 100, 0.6),     // --self 白名单（测量者自悬排除通道）
    mk('session-f-stale', 'tool/call', 423, 0.6),     // 封闭事实形态①（b81832fd 423h）
    mk('session-f-stale2', 'step/start', 388, 0.6),   // 封闭事实形态②（19af7c0d 388h）
    mk('session-f-suspect', 'turn/start', 5, 0),      // 疑转净 + 晚段密度 0（M3 密度入判据的杀伤靶）
    mk('session-f-suspect2', 'tool/call', 3, 0.9),    // 疑转净第二元素
    mk('session-f-clean', null, 1000, 0.6),           // 老而无悬尾=干净（阈值只作用于悬尾行）
  ]
}

function makeCtx(nowMs) {
  return { nowMs, live: new Map([['session-f-inflight', 'running']]), selfIds: new Set(['session-f-self']) }
}

const stateMap = (mod) => new Map(mod.classifyRows(makeFixture(NOW), makeCtx(NOW)).map((r) => [r.sessionId, r.state]))

async function selftest() {
  let failures = 0
  const assert = (cond, label) => { if (cond) console.log(`  ok   ${label}`); else { failures++; console.error(`  FAIL ${label}`) } }
  const NOW0 = Date.now()
  NOW = NOW0

  console.log('[1] 夹具全量分类（7 元素 / 4 态，原件全绿）')
  const sm = stateMap(SELF_MOD)
  assert(sm.get('session-f-inflight') === 'inflight', 'liveness=running → 构造性在飞（M1 类别承重）')
  assert(sm.get('session-f-self') === 'inflight', 'self 白名单 → 构造性在飞（测量者自悬）')
  assert(sm.get('session-f-stale') === 'candidate' && sm.get('session-f-stale2') === 'candidate', '423h/388h 双陈旧 → 死亡·中止候选（M2 类别承重）')
  assert(sm.get('session-f-suspect') === 'suspect' && sm.get('session-f-suspect2') === 'suspect', '5h/3h 悬尾 → 疑转净（M3 类别承重）')
  assert(sm.get('session-f-clean') === 'clean', '无悬尾且 1000h → 干净（阈值只作用于悬尾行）')
  const counts = { clean: 0, inflight: 0, suspect: 0, candidate: 0 }
  for (const s of sm.values()) counts[s]++
  assert(counts.clean === 1 && counts.inflight === 2 && counts.suspect === 2 && counts.candidate === 2,
    `全量状态映射 clean1/inflight2/suspect2/candidate2 (got ${JSON.stringify(counts)})`)

  console.log('[2] 判据边界行为（原件）')
  const idleOld = classifyRows([makeFixture(NOW)[0]], { nowMs: NOW, live: new Map([['session-f-inflight', 'idle']]), selfIds: new Set() })[0]
  assert(idleOld.state === STATE_CANDIDATE && idleOld.liveness === 'idle', 'idle 且尾龄≥阈值 → 候选（idle 不豁免阈值，liveness 在案）')
  const d0 = classifyRows([{ sessionId: 'd', tailDangling: 'turn/start', lastEventAt: NOW - 5 * 3.6e6, segments: [{ name: 'late', density: 0 }] }], { nowMs: NOW })[0].state
  const d9 = classifyRows([{ sessionId: 'd', tailDangling: 'turn/start', lastEventAt: NOW - 5 * 3.6e6, segments: [{ name: 'late', density: 0.999 }] }], { nowMs: NOW })[0].state
  const dN = classifyRows([{ sessionId: 'd', tailDangling: 'turn/start', lastEventAt: NOW - 5 * 3.6e6, segments: [{ name: 'late' }] }], { nowMs: NOW })[0].state
  assert(d0 === 'suspect' && d0 === d9 && d9 === dN, `密度禁入：density 0/0.999/缺省三值分类不变（got ${d0}/${d9}/${dN}）`)
  const noTs = classifyRows([{ sessionId: 'e', tailDangling: 'tool/call' }], { nowMs: NOW })[0]
  assert(noTs.state === 'suspect' && noTs.note, 'lastEventAt 缺失 → 疑转净 + 防御注记')
  const tr = templateRow({ sessionId: 'session-x', tailDangling: 'tool/call', lastEventAt: NOW - 423 * 3.6e6, ageH: 423.1 }, NOW)
  assert(tr.includes('session-x') && tr.includes('（待人工裁定）'), '模板行含 sessionId 与（待人工裁定）占位')

  console.log('[3] death-cases 幂等追加')
  let tmp = null
  try { tmp = mkdtempSync(join(tmpdir(), 'session-guard-selftest-')) } catch { tmp = join(REPO_ROOT, 'agent-out', `.selftest-${process.pid}-${Date.now()}`); mkdirSync(tmp, { recursive: true }) }
  try {
    const dc = join(tmp, 'death-cases.md')
    writeFileSync(dc, DEATH_CASES_HEADER + '| 2026-10-25T00:00:00.000Z | session-f-stale | tool/call | ? | ? | 人为中止（C-8 形） | 用户裁定 | 起步行 |\n', 'utf8')
    const cand = (mod) => mod.classifyRows(makeFixture(NOW), makeCtx(NOW)).filter((r) => r.state === STATE_CANDIDATE)
    const dcRun1 = appendDeathCases(dc, cand(SELF_MOD), NOW)
    assert(dcRun1.appended === 1 && dcRun1.skipped === 1, `首跑追加1跳过1（b81832fd 已在库）(got ${dcRun1.appended}/${dcRun1.skipped})`)
    const dcRun2 = appendDeathCases(dc, cand(SELF_MOD), NOW)
    assert(dcRun2.appended === 0 && dcRun2.skipped === 2, `重跑幂等追加0跳过2 (got ${dcRun2.appended}/${dcRun2.skipped})`)
    assert(readFileSync(dc, 'utf8').includes('session-f-stale2'), '库文件含新追加候选行')
  } finally { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不遮蔽断言结果 */ } }

  console.log('[4] 注入必红负向自测（3 变异体 ↔ 断言类别一一对应，变异副本动态 import）')
  // 锚点用片段拼接构造：本文件既当被测源又当测试器，锚点若以连续字面量出现在 MUTANTS
  // 数组里会被唯一性校验（split 计数）数成第 2 处——拼接后源码中锚点字面量只存在于真代码行。
  const C_LV = ['if (ctx.live.get(id) === ', "'running'", ' || ctx.selfIds.has(id))'].join('')
  const C_TH_FULL = ['if (ageH >= ctx', '.thresholdH) '].join('')          // 原样（含闭括号）
  const C_TH_OPEN = ['if (ageH >= ctx', '.thresholdH || '].join('')        // 注入态开括号不闭合
  const C_RET = ['return { sessionId: id, state: STATE_', 'CANDIDATE,'].join('')
  const C_DENS = ['((row.segments && row.segments[2] && row.segments', '[2].density) ?? 1) < 0.5)'].join('')
  const src = readFileSync(resolve(process.argv[1] || 'tools/session-guard.mjs'), 'utf8')
  const MUTANTS = [
    {
      id: 'M1-debranch-liveness', desc: '去 liveness 分支（running/self 白名单失效→超龄 running 会话被误判死）',
      from: C_LV,
      to: 'if (false)',
      verify: (s) => s.get('session-f-inflight') === 'inflight' && s.get('session-f-self') === 'inflight',
    },
    {
      id: 'M2-debranch-threshold', desc: '去阈值比较（候选分支短路→423h/388h 陈旧悬尾漏报为疑转净）',
      from: C_TH_FULL,
      to: 'if (false) ',
      verify: (s) => s.get('session-f-stale') === 'candidate' && s.get('session-f-stale2') === 'candidate',
    },
    {
      id: 'M3-inject-density', desc: '密度字段入判据（作废用途回流→低密度疑转净被误升候选）',
      from: C_TH_FULL + C_RET,
      to: C_TH_OPEN + C_DENS + ' ' + C_RET,
      verify: (s) => s.get('session-f-suspect') === 'suspect' && s.get('session-f-suspect2') === 'suspect',
    },
  ]
  let tmpM = null
  try { tmpM = mkdtempSync(join(tmpdir(), 'session-guard-mutants-')) } catch { tmpM = join(REPO_ROOT, 'agent-out', `.mutants-${process.pid}-${Date.now()}`); mkdirSync(tmpM, { recursive: true }) }
  try {
    for (const m of MUTANTS) {
      const n = src.split(m.from).length - 1
      if (n !== 1) { failures++; console.error(`  FAIL ${m.id} 变异锚点失配（出现 ${n} 次，须恰 1 次）——源码漂移，响亮报错不静默`); continue }
      const mp = join(tmpM, `mutant-${m.id}.mjs`)
      writeFileSync(mp, src.replace(m.from, m.to), 'utf8')
      const mod = await import(pathToFileURL(mp).href)
      const onOriginal = m.verify(stateMap(SELF_MOD))
      const onMutant = m.verify(stateMap(mod))
      assert(onOriginal === true, `${m.id} 原件谓词为真（原件全绿）`)
      assert(onMutant === false, `${m.id} 变异体谓词翻假（夹具杀伤＝注入必红）：${m.desc}`)
    }
  } finally { try { rmSync(tmpM, { recursive: true, force: true }) } catch { /* 清理失败不遮蔽断言结果 */ } }

  if (failures) { console.error(`SELFTEST FAIL (${failures} 断言失败)`); process.exit(1) }
  console.log(`SELFTEST OK | threshold=${GUARD_THRESHOLD_H}h inflight=${GUARD_INFLIGHT_H}h | 夹具 7 元素 4 态 | 变异体 3/3 被夹具杀伤`)
}

let NOW = 0 // selftest 时钟锚（makeFixture/stateMap 共用；主流程不用）

export { classifyRows, classifyRow, templateRow, appendDeathCases, DEATH_CASES_HEADER, GUARD_THRESHOLD_H, GUARD_INFLIGHT_H, STATE_LABELS }

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--selftest') { selftest().catch((e) => { console.error(`[session-guard] selftest 异常：${e && e.stack || e}`); process.exit(1) }); return }
  if (argv[0] === '--scan') { runScan(argv.slice(1)); return }
  console.error('用法: node tools/session-guard.mjs --selftest | --scan [--in <scan.json>] [--threshold-hours H] [--live-running id,id] [--self id] [--death-cases <path>] [--json]')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
