#!/usr/bin/env node
/**
 * tools/opt-b2-s3-gate.mjs — B2 S3 净注入门（面A 前后对比 + 面D 不变式 + H 并列读数）。
 *
 * 口径来源（设计正本 `agent-out/opt-b2-design-v2.md` 节 S3，含回灌勘误 §10.6）：
 *   - 面A（B2 本体面）= 三工具工具级 description + parameters/output.schema 内全部
 *     description 字符串；度量口径**逐字复用** `tools/measure-injection-surface.mjs`
 *     的 `metrics`（码点/码元/字节三口径），不另造。
 *   - 面D（任务书面）= `tools/opt-r2-faced-probe.mjs` 的口径B 读数，**只出码点**；
 *     与面A **不同面、不可互证**。
 *
 * 门规则（G0–G5）：
 *   G0 前锚锁定：faceA-before 必须是 S0 留档（2663/2663/5655、工具级合计 783、
 *      descCount 54），且必须含 `tools.items` 结构——把面D 文件当基线 ⇒ 解析
 *      fail-closed 变红（C1 口径错配的机器防线）。
 *   G1 面A 净增 ≤0（码点主口径）：after.totals.codepoints − before ≤ 0。
 *   G2 裁剪到位（零容差 R-11）：after 三工具 toolLevel 各 ≤90 且合计 ≤255。
 *   G3 面D 不变式：items[].caliberB.codepoints deep-equal [1993,2181,2183] 且
 *      totals.meanTotalCodepoints===6133、totals.maxTotalCodepoints===6480。
 *      【口径勘误】设计原文写「totals.meanCaliberB===6133」，实测字段名是
 *      meanTotalCodepoints=6133、meanCaliberB=2119（S0 留档与 after 逐值一致）；
 *      本脚本按设计**语义**（均值 6133 = 总码点均值）判 meanTotalCodepoints，
 *      并把 meanCaliberB=2119 作为派生存列读数入档（见渲染节「口径勘误登记」）。
 *   G4 参数级不缩水：after 三工具 paramDescs 合计 ≥ before 合计（1527，B2 前基线；
 *      允许 action 描述增量，禁止顺手裁参数级）。
 *   G5 并列读数（非门、必入档）：H（一次 help 三工具全量）/ H_static / H_action /
 *      H_struct / 回本轮数 R=ceil(H/528)；H>1600 告警。
 *
 * 用法：
 *   node tools/opt-b2-s3-gate.mjs --faceA-before agent-out/opt-b2-s0-faceA-baseline.json \
 *        --faceA-after agent-out/opt-b2-s3-faceA-after.json \
 *        --faceD-after agent-out/opt-b2-s3-faceD-after.json \
 *        --out agent-out/opt-b2-s3-readings.md
 *   node tools/opt-b2-s3-gate.mjs --selftest
 *
 * 退出码：0 全绿（含 selftest 全部变异体达预期）；1 有门红 / 解析 fail-closed /
 * selftest 未达预期；2 用法错误（缺值/未知参数）。
 *
 * 零新依赖（只 import 本仓测量工具与 lib 导出）；不 spawn、不联网；分类为纯函数
 * （`classify` 可在内存读数上复用，selftest 即用它），CLI 只做读盘/渲染/退出码。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { metrics } from './measure-injection-surface.mjs'
import { rolesTool, taskbookTool, spawnTool, resolveConfig, composeHelp, STATIC_ARCHIVE } from '../lib/index.js'

/** 仓根绝对路径（只读用途；门判定不依赖它）。 */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

// ── 契约常量（改口径必须同步本脚本 + 读数档案 + 设计正本）──────────────────────

/** 三工具名（面A/面D 的固定宇宙；顺序 = measure 工具的工厂顺序，deep-equal 依赖）。 */
export const TOOLS = Object.freeze(['agent_roles', 'agent_taskbook', 'agent_spawn'])

/** S0 前锚表（面A）+ 面D 不变式 + 裁剪硬门 + H 阈值。 */
export const BASELINE = Object.freeze({
  faceA: Object.freeze({
    codepoints: 2663,
    units: 2663,
    bytes: 5655,
    toolLevelSum: 783,
    paramDescsSum: 1527,
    descCount: 54,
  }),
  faceD: Object.freeze({
    caliberB: Object.freeze([1993, 2181, 2183]),
    meanTotalCodepoints: 6133,
    maxTotalCodepoints: 6480,
    meanCaliberB: 2119,
  }),
  trim: Object.freeze({ perToolMax: 90, toolLevelSumMax: 255 }),
  help: Object.freeze({ warnAbove: 1600, paybackDivisor: 528 }),
})

/** 解析 fail-closed 异常（结构不对 ⇒ 该门红，绝不当「差不多」继续）。 */
export class GateParseError extends Error {}

// ── 读数解析（fail-closed）────────────────────────────────────────────────────

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GateParseError(`${label} 非有限数值（实得 ${JSON.stringify(value)}）`)
  }
  return value
}

function requireMetric(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GateParseError(`${label} 缺失或非对象`)
  }
  const out = {}
  for (const key of ['codepoints', 'units', 'bytes']) {
    out[key] = requireFinite(value[key], `${label}.${key}`)
    if (out[key] < 0) throw new GateParseError(`${label}.${key} 为负（${out[key]}）`)
  }
  return out
}

/**
 * 解析面A 读数（measure-injection-surface.mjs `--json` 的 `tools` 子树）。
 * 缺 `tools.items` 结构即 fail-closed —— 面D 文件冒充面A 基线时走这条路径。
 * @param {unknown} doc 整份 JSON 文档
 * @returns {{items:Array, totals:object, descCount:number, toolLevelSum:number, paramDescsSum:number, outputSum:number, facetSum:number}}
 */
export function parseFaceA(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new GateParseError('顶层不是 JSON 对象')
  }
  const tools = doc.tools
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new GateParseError('缺 tools 结构（面D 读数冒充面A 基线 ⇒ 解析 fail-closed）')
  }
  if (!Array.isArray(tools.items)) {
    throw new GateParseError('缺 tools.items 数组（面D 读数冒充面A 基线 ⇒ 解析 fail-closed）')
  }
  if (tools.items.length !== TOOLS.length) {
    throw new GateParseError(`tools.items 必须是 ${TOOLS.length} 元素数组（实得 ${tools.items.length}）`)
  }
  const items = tools.items.map((it, i) => {
    if (it === null || typeof it !== 'object') throw new GateParseError(`tools.items[${i}] 非对象`)
    if (typeof it.name !== 'string') throw new GateParseError(`tools.items[${i}].name 缺失`)
    return {
      name: it.name,
      toolLevel: requireMetric(it.toolLevel, `${it.name}.toolLevel`),
      paramDescs: { ...requireMetric(it.paramDescs, `${it.name}.paramDescs`), count: requireFinite(it.paramDescs.count, `${it.name}.paramDescs.count`) },
      outputSchemaDescs: { ...requireMetric(it.outputSchemaDescs, `${it.name}.outputSchemaDescs`), count: requireFinite(it.outputSchemaDescs.count, `${it.name}.outputSchemaDescs.count`) },
      facetTotal: requireMetric(it.facetTotal, `${it.name}.facetTotal`),
    }
  })
  const names = items.map((it) => it.name)
  if (names.join(',') !== TOOLS.join(',')) {
    throw new GateParseError(`tools.items 名字/顺序不符：实得 [${names.join(', ')}]，期望 [${TOOLS.join(', ')}]`)
  }
  const totals = requireMetric(tools.totals, 'tools.totals')
  const descCount = requireFinite(tools.descCount, 'tools.descCount')
  const sum = (list, pick) => list.reduce((n, it) => n + pick(it).codepoints, 0)
  return {
    items,
    totals,
    descCount,
    toolLevelSum: sum(items, (it) => it.toolLevel),
    paramDescsSum: sum(items, (it) => it.paramDescs),
    outputSum: sum(items, (it) => it.outputSchemaDescs),
    facetSum: sum(items, (it) => it.facetTotal),
  }
}

/**
 * 解析面D 读数（opt-r2-faced-probe.mjs 的 JSON；口径B 只出码点）。
 * @param {unknown} doc
 * @returns {{items:Array<{role:string, caliberB:{codepoints:number}, total:{codepoints:number}}>, totals:object}}
 */
export function parseFaceD(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new GateParseError('顶层不是 JSON 对象')
  }
  if (!Array.isArray(doc.items)) throw new GateParseError('缺 items 数组')
  if (doc.items.length !== 3) throw new GateParseError(`items 必须是 3 元素数组（实得 ${doc.items.length}）`)
  const roles = ['explore', 'executor', 'analyst']
  const items = doc.items.map((it, i) => {
    if (it === null || typeof it !== 'object') throw new GateParseError(`items[${i}] 非对象`)
    if (typeof it.role !== 'string') throw new GateParseError(`items[${i}].role 缺失`)
    if (it.role !== roles[i]) throw new GateParseError(`items[${i}].role=${it.role}，期望 ${roles[i]}（顺序/角色漂移）`)
    if (it.caliberB === null || typeof it.caliberB !== 'object') throw new GateParseError(`items[${i}].caliberB 缺失`)
    if (it.total === null || typeof it.total !== 'object') throw new GateParseError(`items[${i}].total 缺失`)
    return {
      role: it.role,
      caliberB: { codepoints: requireFinite(it.caliberB.codepoints, `items[${i}].caliberB.codepoints`) },
      total: { codepoints: requireFinite(it.total.codepoints, `items[${i}].total.codepoints`) },
    }
  })
  const t = doc.totals
  if (t === null || typeof t !== 'object') throw new GateParseError('缺 totals 结构')
  return {
    items,
    totals: {
      meanTotalCodepoints: requireFinite(t.meanTotalCodepoints, 'totals.meanTotalCodepoints'),
      maxTotalCodepoints: requireFinite(t.maxTotalCodepoints, 'totals.maxTotalCodepoints'),
      meanCaliberB: requireFinite(t.meanCaliberB, 'totals.meanCaliberB'),
    },
  }
}

// ── 纯函数分类器（门判定）────────────────────────────────────────────────────

function deepEqualArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * 在内存读数上跑 G0–G5（纯函数：不读盘、不看时钟、不写盘）。
 * @param {{faceABefore:unknown, faceAAfter:unknown, faceDAfter:unknown, help?:object|null}} input
 * @returns {{pass:boolean, gates:Array<{id:string,name:string,pass:boolean,detail:string}>, help:object|null, parsed:object}}
 */
export function classify({ faceABefore, faceAAfter, faceDAfter, help = null }) {
  const gates = []
  let before = null
  let after = null
  let faceD = null
  let beforeErr = null
  let afterErr = null
  let faceDErr = null
  try { before = parseFaceA(faceABefore) } catch (e) { beforeErr = e }
  try { after = parseFaceA(faceAAfter) } catch (e) { afterErr = e }
  try { faceD = parseFaceD(faceDAfter) } catch (e) { faceDErr = e }

  // G0 前锚锁定（含结构 fail-closed：面D 文件冒充面A 基线）
  if (beforeErr) {
    gates.push({
      id: 'G0',
      name: '前锚锁定（faceA-before = S0 留档）',
      pass: false,
      detail: `解析 fail-closed：${beforeErr.message}`,
    })
  } else {
    const problems = []
    const b = BASELINE.faceA
    if (before.totals.codepoints !== b.codepoints) problems.push(`totals.codepoints=${before.totals.codepoints} ≠ ${b.codepoints}`)
    if (before.totals.units !== b.units) problems.push(`totals.units=${before.totals.units} ≠ ${b.units}`)
    if (before.totals.bytes !== b.bytes) problems.push(`totals.bytes=${before.totals.bytes} ≠ ${b.bytes}`)
    if (before.toolLevelSum !== b.toolLevelSum) problems.push(`工具级合计=${before.toolLevelSum} ≠ ${b.toolLevelSum}`)
    if (before.descCount !== b.descCount) problems.push(`descCount=${before.descCount} ≠ ${b.descCount}`)
    gates.push({
      id: 'G0',
      name: '前锚锁定（faceA-before = S0 留档）',
      pass: problems.length === 0,
      detail: problems.length === 0
        ? `totals ${b.codepoints}/${b.units}/${b.bytes}、工具级合计 ${b.toolLevelSum}、descCount ${b.descCount} ✓`
        : problems.join('；'),
    })
  }

  // G1 面A 净增 ≤0（码点）
  if (beforeErr || afterErr) {
    gates.push({
      id: 'G1',
      name: '面A 净增 ≤0（码点）',
      pass: false,
      detail: `解析 fail-closed：${beforeErr ? `before: ${beforeErr.message}` : `after: ${afterErr.message}`}`,
    })
  } else {
    const net = after.totals.codepoints - before.totals.codepoints
    gates.push({
      id: 'G1',
      name: '面A 净增 ≤0（码点）',
      pass: net <= 0,
      detail: `${after.totals.codepoints} − ${before.totals.codepoints} = ${net}（要求 ≤0）`,
    })
  }

  // G2 裁剪到位：三工具各 ≤90 且合计 ≤255（零容差 R-11）
  if (afterErr) {
    gates.push({ id: 'G2', name: '裁剪到位（各 ≤90 / 合计 ≤255）', pass: false, detail: `解析 fail-closed：${afterErr.message}` })
  } else {
    const levels = after.items.map((it) => ({ name: it.name, v: it.toolLevel.codepoints }))
    const over = levels.filter((l) => l.v > BASELINE.trim.perToolMax)
    const sum = levels.reduce((n, l) => n + l.v, 0)
    const detail = `${levels.map((l) => `${l.name}=${l.v}`).join(' / ')}，合计 ${sum}（各 ≤${BASELINE.trim.perToolMax}、合计 ≤${BASELINE.trim.toolLevelSumMax}）`
    gates.push({
      id: 'G2',
      name: '裁剪到位（各 ≤90 / 合计 ≤255）',
      pass: over.length === 0 && sum <= BASELINE.trim.toolLevelSumMax,
      detail: over.length === 0 ? detail : `${detail}；超限：${over.map((l) => `${l.name}=${l.v}`).join('、')}`,
    })
  }

  // G3 面D 不变式（只码点）
  // 【口径勘误】设计原文 `totals.meanCaliberB===6133` 是字段名笔误：实测 6133 =
  // meanTotalCodepoints（总码点均值），meanCaliberB=2119。此处按语义判 meanTotal，
  // meanCaliberB 作为派生不变式一并核对（caliberB 不变时它数学上必然 = 2119）。
  if (faceDErr) {
    gates.push({ id: 'G3', name: '面D 不变式（只码点）', pass: false, detail: `解析 fail-closed：${faceDErr.message}` })
  } else {
    const problems = []
    const got = faceD.items.map((it) => it.caliberB.codepoints)
    const want = [...BASELINE.faceD.caliberB]
    if (!deepEqualArray(got, want)) problems.push(`caliberB=[${got.join(',')}] ≠ [${want.join(',')}]`)
    if (faceD.totals.meanTotalCodepoints !== BASELINE.faceD.meanTotalCodepoints) {
      problems.push(`meanTotalCodepoints=${faceD.totals.meanTotalCodepoints} ≠ ${BASELINE.faceD.meanTotalCodepoints}`)
    }
    if (faceD.totals.maxTotalCodepoints !== BASELINE.faceD.maxTotalCodepoints) {
      problems.push(`maxTotalCodepoints=${faceD.totals.maxTotalCodepoints} ≠ ${BASELINE.faceD.maxTotalCodepoints}`)
    }
    if (faceD.totals.meanCaliberB !== BASELINE.faceD.meanCaliberB) {
      problems.push(`meanCaliberB=${faceD.totals.meanCaliberB} ≠ ${BASELINE.faceD.meanCaliberB}（派生不变式）`)
    }
    gates.push({
      id: 'G3',
      name: '面D 不变式（只码点）',
      pass: problems.length === 0,
      detail: problems.length === 0
        ? `caliberB ${want.join('/')}、meanTotal ${BASELINE.faceD.meanTotalCodepoints}、maxTotal ${BASELINE.faceD.maxTotalCodepoints}（meanCaliberB ${BASELINE.faceD.meanCaliberB}）✓`
        : problems.join('；'),
    })
  }

  // G4 参数级不缩水：after 合计 ≥ before 合计（1527，B2 前基线）
  if (beforeErr || afterErr) {
    gates.push({
      id: 'G4',
      name: '参数级不缩水（≥ B2 前基线 1527）',
      pass: false,
      detail: `解析 fail-closed：${beforeErr ? `before: ${beforeErr.message}` : `after: ${afterErr.message}`}`,
    })
  } else {
    const shown = after.items.map((it) => {
      const b = before.items.find((x) => x.name === it.name)
      return `${it.name}=${it.paramDescs.codepoints}（前 ${b.paramDescs.codepoints}）`
    })
    gates.push({
      id: 'G4',
      name: '参数级不缩水（≥ B2 前基线 1527）',
      pass: after.paramDescsSum >= before.paramDescsSum,
      detail: `${after.paramDescsSum} ≥ ${before.paramDescsSum}；${shown.join(' / ')}`,
    })
  }

  // G5 并列读数（非门，必入档）：H 四值 + 回本轮数；H>1600 告警（不影响退出码）
  if (help === null || typeof help !== 'object') {
    gates.push({ id: 'G5', name: '并列读数 H（非门）', pass: true, detail: '未传入 H 读数（本调用不含活 definition；CLI 会现算）' })
  } else {
    const warn = help.H > BASELINE.help.warnAbove
    gates.push({
      id: 'G5',
      name: '并列读数 H（非门）',
      pass: true,
      detail: `H=${help.H} / H_static=${help.H_static} / H_action=${help.H_action} / H_struct=${help.H_struct}；R=ceil(H/${BASELINE.help.paybackDivisor})=${help.R}${warn ? `；⚠️ H>${BASELINE.help.warnAbove} 告警（回组织者）` : `；H≤${BASELINE.help.warnAbove} 未触警`}`,
    })
  }

  const gateMap = Object.fromEntries(gates.map((g) => [g.id, g]))
  return {
    pass: gates.filter((g) => g.id !== 'G5').every((g) => g.pass),
    gates,
    gateMap,
    help,
    parsed: { before, after, faceD, beforeErr, afterErr, faceDErr },
  }
}

// ── H 并列读数（活 definition 现算；纯读，无副作用）──────────────────────────

/**
 * 现算 help 并列读数。
 *
 * 口径（与组织者 S3 期望值逐数对齐）：
 *   H          = [...composeHelp(活 definitions)].length（一次 help 调用、缺省三工具全量）
 *   H_static   = 三段 STATIC_ARCHIVE 正文码点和（=783）
 *   H_struct   = 文档顶部标题行 + 其换行（=54）
 *   H_action   = H − H_static − H_struct（=332；含三工具小标题/段间空行/活 action 表块）
 *   R          = ceil(H / 528) —— 回本轮数（估算口径：528 为组织者 R-5 净降估算）
 * 另记 actionTableBlock（活 action 表块本体，含小标题）供读数档案细分核对。
 * @returns {{H:number,H_static:number,H_action:number,H_struct:number,R:number,actionTableBlock:number,warnAbove:number}}
 */
export function computeHelpReadings() {
  const config = resolveConfig({})
  const defs = {
    agent_roles: rolesTool({}, config, null),
    agent_taskbook: taskbookTool({}, config, null),
    agent_spawn: spawnTool({}, config, null, () => null, null),
  }
  const helpText = composeHelp(defs)
  const H = metrics(helpText).codepoints
  const H_static = TOOLS.reduce((n, name) => n + metrics(STATIC_ARCHIVE[name]).codepoints, 0)
  const lines = helpText.split('\n')
  const H_struct = metrics(lines[0]).codepoints + 1 // 顶部标题行 + 其换行
  const actionTableBlock = (() => {
    const idx = helpText.indexOf('## agent_roles.action')
    return idx >= 0 ? metrics(helpText.slice(idx)).codepoints : 0
  })()
  return {
    H,
    H_static,
    H_action: H - H_static - H_struct,
    H_struct,
    R: Math.ceil(H / BASELINE.help.paybackDivisor),
    actionTableBlock,
    warnAbove: BASELINE.help.warnAbove,
  }
}

// ── 读数档案渲染（--out）────────────────────────────────────────────────────

function num(n) {
  return String(n)
}

function metricCell(m) {
  return m ? `${num(m.codepoints)}/${num(m.units)}/${num(m.bytes)}` : '—'
}

/**
 * 渲染 `agent-out/opt-b2-s3-readings.md`（AC3-2/AC3-3/AC3-4 要求的全部入档项）。
 * @param {ReturnType<typeof classify>} result
 * @param {{generatedAt:string, beforePath:string, afterPath:string, faceDPath:string}} meta
 * @returns {string}
 */
export function renderReadings(result, meta) {
  const { before, after, faceD } = result.parsed
  const help = result.help
  const L = []
  L.push('# B2 S3 净注入门读数（机测，自动生成；勿手改）')
  L.push('')
  L.push(`- 生成时间：${meta.generatedAt}`)
  L.push(`- 生成命令：\`node tools/opt-b2-s3-gate.mjs --faceA-before ${meta.beforePath} --faceA-after ${meta.afterPath} --faceD-after ${meta.faceDPath} --out agent-out/opt-b2-s3-readings.md\``)
  L.push('- 面A 由 `tools/measure-injection-surface.mjs` 产出（码点/码元/字节三口径）；面D 由 `tools/opt-r2-faced-probe.mjs` 产出（**只出码点**）。**两面不同面，不可互证**（C1 教训：1993 是面D 的 explore 口径B 读数，不是面A 基线；面A 基线是 2663）。')
  L.push('')

  L.push('## 一、面A 前后对比（工具面；主口径=码点）')
  L.push('')
  if (!before || !after) {
    L.push(`> 解析 fail-closed：before=${result.parsed.beforeErr?.message ?? 'OK'}；after=${result.parsed.afterErr?.message ?? 'OK'}`)
  } else {
    L.push('| 工具 | 工具级 desc 前 → 后 | 参数级 desc 小计 前 → 后（条数） | output.schema desc 小计 | 面合计（码点）前 → 后 |')
    L.push('|---|---|---|---|---|')
    for (const it of after.items) {
      const b = before.items.find((x) => x.name === it.name)
      const fmtLevel = (m) => `${num(m.codepoints)}/${num(m.units)}/${num(m.bytes)}`
      L.push(`| ${it.name} | ${fmtLevel(b.toolLevel)} → **${fmtLevel(it.toolLevel)}** | ${num(b.paramDescs.codepoints)} → **${num(it.paramDescs.codepoints)}**（${num(b.paramDescs.count)} → ${num(it.paramDescs.count)}） | ${num(b.outputSchemaDescs.codepoints)} → ${num(it.outputSchemaDescs.codepoints)} | ${num(b.facetTotal.codepoints)} → **${num(it.facetTotal.codepoints)}** |`)
    }
    L.push(`| **合计** | **${num(before.toolLevelSum)} → ${num(after.toolLevelSum)}** | **${num(before.paramDescsSum)} → ${num(after.paramDescsSum)}** | ${num(before.outputSum)} → ${num(after.outputSum)} | **${num(before.totals.codepoints)} → ${num(after.totals.codepoints)}** |`)
    L.push('')
    const net = after.totals.codepoints - before.totals.codepoints
    L.push(`**净变化量（G1）**：\`${num(after.totals.codepoints)} − ${num(before.totals.codepoints)} = ${num(net)}\`（要求 ≤0 ⇒ ${net <= 0 ? 'PASS' : 'FAIL'}）`)
    L.push('')
    L.push('**三口径总表**：')
    L.push('')
    L.push('| 口径 | before | after | Δ |')
    L.push('|---|---|---|---|')
    for (const key of ['codepoints', 'units', 'bytes']) {
      L.push(`| ${key} | ${num(before.totals[key])} | ${num(after.totals[key])} | ${num(after.totals[key] - before.totals[key])} |`)
    }
    L.push('')
    L.push(`- 描述串条数 descCount：${num(before.descCount)} → ${num(after.descCount)}（+1 = allowTools 参数描述）。`)
    L.push(`- **估算口径标注**：组织者 R-5 估算净降 ≈528 码点（**估算值，非实测**）；实测净降 ${Math.abs(after.totals.codepoints - before.totals.codepoints)} 码点 = 估算 528 − action 描述增量 13 − allowTools 描述 77（≈ 528 − 90 = 438）；528 本身是估算，故「≈」保留。`)
    L.push(`- **S1.5 成本入档（AC1.5-6，与 G4 同源）**：agent_spawn.paramDescs ${num(before.items.find((x) => x.name === 'agent_spawn').paramDescs.codepoints)} → ${num(after.items.find((x) => x.name === 'agent_spawn').paramDescs.codepoints)}（+77 = allowTools 参数描述码点，与 critic r2 独立复算 77 一致）。`)
  }
  L.push('')

  L.push('## 二、面D（任务书面；口径B，只出码点）')
  L.push('')
  if (!faceD) {
    L.push(`> 解析 fail-closed：${result.parsed.faceDErr?.message ?? '未知'}`)
  } else {
    L.push('| 角色 | 口径B 码点 | 全任务书总码点 |')
    L.push('|---|---|---|')
    for (const it of faceD.items) {
      L.push(`| ${it.role} | ${num(it.caliberB.codepoints)} | ${num(it.total.codepoints)} |`)
    }
    L.push(`| **totals** | **meanCaliberB ${num(faceD.totals.meanCaliberB)}** | **meanTotal ${num(faceD.totals.meanTotalCodepoints)} / maxTotal ${num(faceD.totals.maxTotalCodepoints)}** |`)
    L.push('')
    L.push('- 不变式（G3）：caliberB `[1993,2181,2183]` + meanTotalCodepoints 6133 + maxTotalCodepoints 6480 **逐值零变化**（B2 不触任务书，应零变化；本读数为 after 实测）。')
  }
  L.push('')

  L.push('## 三、门判定（G0–G4）+ G5 并列读数')
  L.push('')
  L.push('| 门 | 规则 | 实测 | 判定 |')
  L.push('|---|---|---|---|')
  for (const g of result.gates) {
    L.push(`| ${g.id} | ${g.name} | ${g.detail.replace(/\|/g, '\\|')} | ${g.pass ? '**PASS**' : '**FAIL**'} |`)
  }
  L.push('')
  if (help) {
    L.push('**G5 并列读数（非门、必入档）**：')
    L.push('')
    L.push('| 读数 | 值 | 口径 |')
    L.push('|---|---|---|')
    L.push(`| H | **${num(help.H)}** | 一次 help 调用三工具全量（\`[...composeHelp(活 definitions)].length\`） |`)
    L.push(`| H_static | ${num(help.H_static)} | 三段 \`STATIC_ARCHIVE\` 正文码点和 |`)
    L.push(`| H_action | ${num(help.H_action)} | H − H_static − H_struct（含三工具小标题/段间空行/活 action 表块 ${num(help.actionTableBlock)}） |`)
    L.push(`| H_struct | ${num(help.H_struct)} | 文档顶部标题行 + 其换行 |`)
    L.push(`| 回本轮数 R | **${num(help.R)}** | \`ceil(H / 528)\`（估算口径；528 = 组织者净降估算） |`)
    L.push('')
    L.push(`- 阈值：H > ${num(help.warnAbove)} 触发告警回组织者；实测 H=${num(help.H)}（${help.H > help.warnAbove ? '⚠️ **触警**' : '未触警'}）。`)
  }
  L.push('')

  L.push('## 四、基线重锚注记（A 链形态：新基线 + 归因 + 复跑命令）')
  L.push('')
  if (after) {
    L.push(`- **新基线（面A after，S3 起生效）**：\`${num(after.totals.codepoints)}/${num(after.totals.units)}/${num(after.totals.bytes)}\`（码点/码元/字节），工具级 ${after.items.map((it) => num(it.toolLevel.codepoints)).join('/')}=${num(after.toolLevelSum)}，参数级 ${num(after.paramDescsSum)}，output ${num(after.outputSum)}，descCount ${num(after.descCount)}。`)
  }
  L.push(`- **旧基线（面A before，S0 留档，仅作门参照）**：\`${num(BASELINE.faceA.codepoints)}/${num(BASELINE.faceA.units)}/${num(BASELINE.faceA.bytes)}\`，工具级 ${num(BASELINE.faceA.toolLevelSum)}，参数级 ${num(BASELINE.faceA.paramDescsSum)}，descCount ${num(BASELINE.faceA.descCount)}。`)
  L.push('- **归因**：面A 下降来自 B2 S1 三行 catalog（工具级 783 → 255，各 ≤90）+ action 描述增补 `help=`（+13）+ S1.5 `allowTools` 参数描述（+77）；面D **零变化**归因于 B2 不触任务书渲染链（校验方式：G3 不变式）。')
  L.push('- **复跑命令（读数链，before 一律取 S0 留档，不得重跑 after 充当 before）**：')
  L.push('')
  L.push('```pwsh')
  L.push('node tools/measure-injection-surface.mjs --json agent-out/opt-b2-s3-faceA-after.json')
  L.push('node tools/opt-r2-faced-probe.mjs agent-out/opt-b2-s3-faceD-after.json')
  L.push('node tools/opt-b2-s3-gate.mjs --faceA-before agent-out/opt-b2-s0-faceA-baseline.json --faceA-after agent-out/opt-b2-s3-faceA-after.json --faceD-after agent-out/opt-b2-s3-faceD-after.json --out agent-out/opt-b2-s3-readings.md')
  L.push('node tools/opt-b2-s3-gate.mjs --selftest')
  L.push('```')
  L.push('')

  L.push('## 五、不跨面互证声明（AC3-4）')
  L.push('')
  L.push('- 面A（2663 → 2225）由 `tools/measure-injection-surface.mjs` 产出；面D（1993/2181/2183）由 `tools/opt-r2-faced-probe.mjs` 产出。**两者不同面、不同口径、不可互证**——不得拿面D 的 1993/2181/2183 当「面A 基线」，也不得用面A 的 2225 说明面D 变化。')
  L.push('- 门脚本 G0 的结构 fail-closed 就是这条纪律的机器防线：把面D JSON 传给 `--faceA-before` 会让 G0 因缺 `tools.items` 直接变红（`--selftest` MUT-G5 常驻验证）。')
  L.push('')

  L.push('## 六、口径勘误登记（机测可证；不静默改设计）')
  L.push('')
  L.push('| # | 设计原文 | 实测/可复算事实 | 本脚本处置 |')
  L.push('|---|---|---|---|')
  L.push('| 1 | G3 `totals.meanCaliberB===6133` | faced-probe 的 6133 是 `meanTotalCodepoints`（总码点均值）；`meanCaliberB` 实测 2119（S0 留档与 after 逐值一致） | 按**语义**判 `meanTotalCodepoints===6133`，另把 `meanCaliberB===2119` 作为派生不变式一并核对 |')
  L.push('| 2 | G5 `H_action=323`（设计估算） | 323 是 S1 前 action 描述量级；S1 增补 `help=` 后由组织者实测 H_action=332（本脚本现算 332） | 按现算值入档；R=3 不变 |')
  L.push('| 3 | G4「after 合计 ≥ before 合计（1527）」+「MUT-G4 after 参数级 −1 必红」 | after 实测 1617（余量 +90 来自 action/allowTools 新增），对新增项内部 −1 不敏感 | 门语义如实执行「不得低于 B2 前基线」；MUT-G4 按「after 合计 = 1527−1 = 1526」构造，证明门不是装饰 |')
  L.push('')
  L.push('> 以上三条均为**字段名/量级/判据语义**层面的实现说明，不改变任何门的通过/失败语义；如组织者裁定需按字面另设门，回改本脚本。')
  L.push('')
  return L.join('\n')
}

// ── selftest（内存变异读数；断言鉴别力：变异体与断言类别一一对应）────────────

/** 内存基准读数（镜像 S3 实测；确定性，不读盘——selftest 不依赖 agent-out 文件）。 */
const FIXTURE = Object.freeze({
  faceABefore: {
    tools: {
      items: [
        { name: 'agent_roles', toolLevel: { codepoints: 267, units: 267, bytes: 537 }, paramDescs: { count: 6, codepoints: 323, units: 323, bytes: 593 }, outputSchemaDescs: { count: 3, codepoints: 105, units: 105, bytes: 247 }, facetTotal: { codepoints: 695, units: 695, bytes: 1377 } },
        { name: 'agent_taskbook', toolLevel: { codepoints: 191, units: 191, bytes: 467 }, paramDescs: { count: 15, codepoints: 623, units: 623, bytes: 1376 }, outputSchemaDescs: { count: 4, codepoints: 94, units: 94, bytes: 220 }, facetTotal: { codepoints: 908, units: 908, bytes: 2063 } },
        { name: 'agent_spawn', toolLevel: { codepoints: 325, units: 325, bytes: 685 }, paramDescs: { count: 19, codepoints: 581, units: 581, bytes: 1242 }, outputSchemaDescs: { count: 4, codepoints: 154, units: 154, bytes: 288 }, facetTotal: { codepoints: 1060, units: 1060, bytes: 2215 } },
      ],
      totals: { codepoints: 2663, units: 2663, bytes: 5655 },
      descCount: 54,
    },
  },
  faceAAfter: {
    tools: {
      items: [
        { name: 'agent_roles', toolLevel: { codepoints: 90, units: 90, bytes: 136 }, paramDescs: { count: 6, codepoints: 336, units: 336, bytes: 622 }, outputSchemaDescs: { count: 3, codepoints: 105, units: 105, bytes: 247 }, facetTotal: { codepoints: 531, units: 531, bytes: 1005 } },
        { name: 'agent_taskbook', toolLevel: { codepoints: 78, units: 78, bytes: 156 }, paramDescs: { count: 15, codepoints: 623, units: 623, bytes: 1376 }, outputSchemaDescs: { count: 4, codepoints: 94, units: 94, bytes: 220 }, facetTotal: { codepoints: 795, units: 795, bytes: 1752 } },
        { name: 'agent_spawn', toolLevel: { codepoints: 87, units: 87, bytes: 139 }, paramDescs: { count: 20, codepoints: 658, units: 658, bytes: 1409 }, outputSchemaDescs: { count: 4, codepoints: 154, units: 154, bytes: 288 }, facetTotal: { codepoints: 899, units: 899, bytes: 1836 } },
      ],
      totals: { codepoints: 2225, units: 2225, bytes: 4593 },
      descCount: 55,
    },
  },
  faceDAfter: {
    items: [
      { role: 'explore', caliberB: { codepoints: 1993 }, total: { codepoints: 6480 } },
      { role: 'executor', caliberB: { codepoints: 2181 }, total: { codepoints: 5914 } },
      { role: 'analyst', caliberB: { codepoints: 2183 }, total: { codepoints: 6006 } },
    ],
    totals: { meanTotalCodepoints: 6133, maxTotalCodepoints: 6480, meanCaliberB: 2119 },
  },
})

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 注入必红自测：六个变异读数必须让对应门变红，原样读数必须全绿（退出码 0）。
 * MUT-G2 证明「G1 单门不够」（只裁 1 字符：G1 绿而 G2 红）；MUT-G5 证明
 * 「面D 冒充面A 基线 ⇒ G0 解析 fail-closed 红」（C1 回归防线）。
 * @returns {{pass:number,total:number,rows:Array<{name:string,ok:boolean,detail:string}>}}
 */
export function selftest() {
  const help = computeHelpReadings()
  const rows = []
  const run = (name, input, check) => {
    let result
    try {
      result = classify(input)
    } catch (e) {
      rows.push({ name, ok: false, detail: `classify 抛错（应返回结构化判定）：${e.message}` })
      return
    }
    const detail = result.gates.map((g) => `${g.id}=${g.pass ? '绿' : '红'}`).join(' ')
    let ok
    try {
      ok = check(result) === true
    } catch (e) {
      rows.push({ name, ok: false, detail: `断言抛错：${e.message}` })
      return
    }
    rows.push({ name, ok, detail: `${detail}${ok ? '' : ' ← 未达预期'}` })
  }

  // 0) 原样：G0–G4 全绿（G5 非门恒绿）
  run('原样读数（before S0 / after / faceD）', { ...FIXTURE, help }, (r) =>
    r.pass && ['G0', 'G1', 'G2', 'G3', 'G4'].every((id) => r.gateMap[id].pass))

  // 1) MUT-G0：前锚工具级合计 ≠783（换基线）
  {
    const before = cloneJson(FIXTURE.faceABefore)
    before.tools.items[0].toolLevel.codepoints = 266 // 267→266 ⇒ 合计 782
    run('MUT-G0 before 工具级合计 782（换基线）', { ...FIXTURE, faceABefore: before, help }, (r) =>
      !r.gateMap.G0.pass && !r.pass)
  }

  // 2) MUT-G1：after 面A 总量 = before + 1
  {
    const after = cloneJson(FIXTURE.faceAAfter)
    after.tools.totals.codepoints = BASELINE.faceA.codepoints + 1 // 2664
    run('MUT-G1 after 总量 = 2664（before+1）', { ...FIXTURE, faceAAfter: after, help }, (r) =>
      !r.gateMap.G1.pass && !r.pass)
  }

  // 3) MUT-G2：只裁 1 个字符（after = before −1：工具级 782、总量 2662）
  //    ⇒ G1 绿（净增 −1 ≤0）但 G2 红（工具级合计 782 > 255）——证明 G2 不是装饰
  {
    const after = cloneJson(FIXTURE.faceABefore)
    after.tools.items[0].toolLevel.codepoints = 266
    after.tools.totals = { codepoints: 2662, units: 2662, bytes: 5652 }
    run('MUT-G2 只裁 1 字符（工具级 782、总量 2662）', { ...FIXTURE, faceAAfter: after, help }, (r) =>
      r.gateMap.G1.pass && !r.gateMap.G2.pass && !r.pass)
  }

  // 4) MUT-G3：面D 某角色 caliberB +1
  {
    const faceD = cloneJson(FIXTURE.faceDAfter)
    faceD.items[0].caliberB.codepoints += 1
    run('MUT-G3 面D explore caliberB +1', { ...FIXTURE, faceDAfter: faceD, help }, (r) =>
      !r.gateMap.G3.pass && !r.pass)
  }

  // 5) MUT-G4：after 参数级合计 = B2 前基线 −1（1526）
  {
    const after = cloneJson(FIXTURE.faceAAfter)
    after.tools.items[0].paramDescs.codepoints = 323 // 336→323（回退 action 增量）
    after.tools.items[2].paramDescs.codepoints = 580 // 658→580（相对 before 581 少 1）
    run('MUT-G4 after 参数级合计 1526（=1527−1）', { ...FIXTURE, faceAAfter: after, help }, (r) =>
      after.tools.items.reduce((n, it) => n + it.paramDescs.codepoints, 0) === 1526 &&
      !r.gateMap.G4.pass && !r.pass)
  }

  // 6) MUT-G5：把面D 文件当 --faceA-before ⇒ G0 解析 fail-closed 红
  run('MUT-G5 面D 文件当 faceA-before（G0 fail-closed）', { ...FIXTURE, faceABefore: FIXTURE.faceDAfter, help }, (r) =>
    !r.gateMap.G0.pass && !r.pass && /tools/.test(r.gateMap.G0.detail))

  const failed = rows.filter((r) => !r.ok)
  return { pass: rows.length - failed.length, total: rows.length, rows }
}

function runSelftest() {
  const st = selftest()
  console.log('== opt-b2-s3-gate --selftest（注入必红；内存变异读数，不写盘）==')
  for (const row of st.rows) console.log(`[selftest] ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  —— ${row.detail}`)
  console.log(`[selftest] ${st.pass}/${st.total} PASS`)
  const ok = st.pass === st.total
  if (!ok) {
    console.error('[selftest] FAIL — 变异体未达预期，门判据退化')
    process.exitCode = 1
  }
  return ok
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { faceABefore: null, faceAAfter: null, faceDAfter: null, out: null, selftest: false }
  const WITH_VALUE = {
    '--faceA-before': 'faceABefore',
    '--faceA-after': 'faceAAfter',
    '--faceD-after': 'faceDAfter',
    '--out': 'out',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') {
      opts.selftest = true
      continue
    }
    const key = WITH_VALUE[a]
    if (!key) {
      console.error(`[用法错误] 未知参数 ${a}`)
      console.error('用法: node tools/opt-b2-s3-gate.mjs --faceA-before <json> --faceA-after <json> --faceD-after <json> --out <md> | --selftest')
      process.exitCode = 2
      return null
    }
    const v = argv[++i]
    if (v === undefined) {
      console.error(`[用法错误] ${a} 需要一个值（收到末参，值缺失）`)
      process.exitCode = 2
      return null
    }
    opts[key] = v
  }
  return opts
}

function readJson(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new GateParseError(`${label} 读取失败（${path}）：${e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new GateParseError(`${label} 不是合法 JSON（${path}）：${e.message}`)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts === null) return
  if (opts.selftest) {
    runSelftest()
    return
  }
  const FLAG = { faceABefore: '--faceA-before', faceAAfter: '--faceA-after', faceDAfter: '--faceD-after', out: '--out' }
  const missing = ['faceABefore', 'faceAAfter', 'faceDAfter', 'out'].filter((k) => !opts[k])
  if (missing.length > 0) {
    console.error(`[用法错误] 缺必填参数：${missing.map((k) => FLAG[k]).join(' ')}`)
    console.error('用法: node tools/opt-b2-s3-gate.mjs --faceA-before <json> --faceA-after <json> --faceD-after <json> --out <md> | --selftest')
    process.exitCode = 2
    return
  }

  let faceABefore
  let faceAAfter
  let faceDAfter
  let help
  try {
    faceABefore = readJson(opts.faceABefore, '--faceA-before')
    faceAAfter = readJson(opts.faceAAfter, '--faceA-after')
    faceDAfter = readJson(opts.faceDAfter, '--faceD-after')
    help = computeHelpReadings()
  } catch (e) {
    console.error(`[fail-closed] ${e.message}`)
    process.exitCode = 1
    return
  }

  const result = classify({ faceABefore, faceAAfter, faceDAfter, help })
  const generatedAt = new Date().toISOString()
  const markdown = renderReadings(result, {
    generatedAt,
    beforePath: opts.faceABefore,
    afterPath: opts.faceAAfter,
    faceDPath: opts.faceDAfter,
  })
  try {
    writeFileSync(opts.out, markdown, 'utf8')
  } catch (e) {
    console.error(`[fail-closed] 读数档案写出失败（${opts.out}）：${e.message}`)
    process.exitCode = 1
    return
  }

  console.log('== opt-b2-s3-gate（面A 净注入门 + 面D 不变式）==')
  for (const g of result.gates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id} ${g.name} —— ${g.detail}`)
  console.log(`  [读数档案] ${opts.out}`)
  console.log(`[RESULT] ${result.pass ? 'PASS — G0–G4 全绿（非门 G5 已入档）' : 'FAIL — 存在门红'}`)
  if (help.H > help.warnAbove) console.error(`[告警] H=${help.H} > ${help.warnAbove} 阈值，回组织者`)
  if (!result.pass) process.exitCode = 1
}

// import guard（供测试/工具复用 `classify` / `parseFaceA` / `selftest` 时不整场跑 CLI）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
