#!/usr/bin/env node
/**
 * tools/constraint-audit.mjs — 约束结构化审计闸门（B5）。
 *
 * 这道门看管的是 **docs/constraint-audit.md 这份审计本身**，不是应用代码：
 * 它防止审计退化成装饰——拍脑袋标 ENFORCED、拿 N/A 逃避、P0 无整改、条款表被清空。
 *
 * 门规则（G1–G5）：
 *   G1 覆盖完整：条款表行数 ≥ MIN_CLAUSES，且每行四档合法 + 定级合法。
 *      MIN_CLAUSES 的来历见常量注释（实测值，不是先写再凑）。
 *   G2 ENFORCED 必须可验证：凡标 ENFORCED 的行，其引用的闸门文件必须真实存在，
 *      且该文件内必须能找到它声称的断言标识子串。**找不到即红**——这是防
 *      「拍脑袋标 ENFORCED」的主门。
 *   G3 N/A 不许滥用：N/A 占比 > NA_MAX_RATIO 即红（阈值来历见常量注释）。
 *   G4 P0 必须有整改：每条 P0 行必须给出可执行建议（非空且含闸门形态关键词）。
 *   G5 零命中防护：条款表解析出 0 行即红（fail-closed）；并配阳性对照——
 *      喂一段已知合法的合成表格必须绿（证明解析器没失明）。
 *
 * 退出码：0 全绿；1 有门红 / 解析 fail-closed / selftest 未达期望；2 用法错误。
 *
 * 零新依赖（node:fs / node:path / node:url）；不 spawn、不联网、不写盘。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')

/** 审计正本路径（相对仓根）。 */
export const AUDIT_DOC = 'docs/constraint-audit.md'

/**
 * G1 下限：条款表最少行数。
 *
 * 来历（实测，非估值）：种子枚举器对四个载体跑出的可执行纪律条目 = 108 条
 * （~/.dsh/AGENTS.md 47 / docs/design-principles.md 15 / docs/task-brief-v3.md 37 /
 * README.md 9）。下限取 108 —— 只许变多不许变少；一旦有人删条款把表压小，
 * 本门立刻红。若上游载体真的缩短（AGENTS.md 删节），须同步下调本常量并在此
 * 注释写明是哪次变更、删了什么，否则不允许改小。
 */
export const MIN_CLAUSES = 108

/**
 * G3 阈值：N/A 占比上限。
 *
 * 来历（实测）：初稿把 62 条判成 N/A（53.4%），逐条复核后 22 条降级为 MANUAL，
 * 收敛到 40/108 = 37.0%。阈值定 0.40 —— 比实测值留 3 个百分点余量，但足够紧到
 * 「再往里塞 4 条 N/A 就红」。设计意图：N/A 是审计的逃避档，占比失控说明审计
 * 正在把「没人写闸门」伪装成「不可机检」。
 */
export const NA_MAX_RATIO = 0.40

/** 四档 / 三定级的封闭枚举。 */
export const GRADES = Object.freeze(['ENFORCED', 'PARTIAL', 'MANUAL', 'N/A'])
export const LEVELS = Object.freeze(['P0', 'P1', 'P2'])

/** G4 关键词：P0 整改建议必须含至少一个「闸门形态」词（防写成「应加强管理」）。 */
export const FIX_KEYWORDS = Object.freeze(['断言', '变异', '必红', '非零退出', 'fail-closed', 'existsSync', '正则'])

/** 解析异常（结构不对 ⇒ 该门红，绝不当「差不多」继续）。 */
export class GateParseError extends Error {}

/**
 * 从 markdown 正文解析条款表。
 *
 * 只认 §4「条款表」小节的表体（`| C-001 | ... |` 七列），不扫全文——否则文档里
 * 举例用的表格会把门骗过去。零行不是「没问题」而是「判据失明」，由 G5 变红。
 *
 * @param {string} text 审计正本全文
 * @returns {Array<{id:string,quote:string,carrier:string,grade:string,level:string,gateRef:string,assertId:string,why:string}>}
 */
export function parseClauseTable(text) {
  const lines = String(text ?? '').split('\n')
  const rows = []
  let inSection = false
  for (const line of lines) {
    if (/^##\s*4\.\s*条款表/.test(line)) { inSection = true; continue }
    if (inSection && /^##\s/.test(line)) break
    if (!inSection) continue
    const m = /^\|\s*(C-\d{3})\s*\|(.*)\|\s*$/.exec(line)
    if (!m) continue
    const cells = m[2].split('|').map((s) => s.trim())
    // 期望 6 个后续列（# + 6）：原句/载体/判定/定级/闸门断言/判据说明
    if (cells.length < 6) throw new GateParseError(`条款 ${m[1]} 列数不足（实得 ${cells.length + 1} 列，期望 7）`)
    const [quote, carrier, gradeRaw, level, gateCell, why] = cells
    const grade = gradeRaw.replace(/\*/g, '').trim()
    const gateRef = (() => {
      const g = /`([^`]+:[0-9]+)`/.exec(gateCell)
      return g ? g[1] : ''
    })()
    const assertId = (() => {
      const a = /「([^」]+)」/.exec(gateCell)
      return a ? a[1] : ''
    })()
    rows.push({ id: m[1], quote, carrier, grade, level, gateRef, assertId, why })
  }
  return rows
}

/**
 * 解析 §5「只对 P0 的整改建议」小节：抽出每个 P0 条款的整改正文。
 * 为什么整改正文不在主表里：主表七列要保持可读；整改是多句断言+变异描述，
 * 放在 §5 按条款独立成节。G4 必须查**这份真正的整改正文**，否则查的是空集。
 * @param {string} text 审计正本全文
 * @returns {Map<string,string>} C-xxx → 整改正文（已 trim）
 */
export function parseFixes(text) {
  const lines = String(text ?? '').split('\n')
  const out = new Map()
  let inSection = false
  let cur = null
  for (const line of lines) {
    if (/^##\s*5\.\s*只对 P0 的整改建议/.test(line)) { inSection = true; continue }
    if (inSection && /^##\s/.test(line)) break
    if (!inSection) continue
    const h = /^###\s+(C-\d{3})\b/.exec(line)
    if (h) { cur = h[1]; out.set(cur, ''); continue }
    if (cur === null) continue
    const f = /^-\s*\*\*整改\*\*：(.+)$/.exec(line.trim())
    if (f) out.set(cur, (out.get(cur) ?? '') + f[1].trim())
  }
  return out
}

/**
 * 在内存解析结果上跑 G1–G5（纯函数：不读盘、不看时钟、不写盘）。
 * G2 需要读闸门文件，故注入一个 `readGate(file)` 读取器（selftest 里用假读取器）。
 *
 * @param {Array<object>} rows parseClauseTable 的结果
 * @param {{readGate?:(file:string)=>string|null, positiveControl?:boolean}} [opts]
 * @returns {{pass:boolean, gates:Array<{id:string,name:string,pass:boolean,detail:string}>, gateMap:object, stats:object}}
 */
export function classify(rows, opts = {}) {
  const readGate = opts.readGate ?? ((file) => {
    const p = join(REPO_ROOT, file)
    if (!existsSync(p)) return null
    try { return readFileSync(p, 'utf8') } catch { return null }
  })
  const gates = []
  const list = Array.isArray(rows) ? rows : []

  // ── G1 覆盖完整 ──────────────────────────────────────────────────────────
  {
    const problems = []
    if (list.length < MIN_CLAUSES) problems.push(`条款表 ${list.length} 行 < 下限 ${MIN_CLAUSES}`)
    for (const r of list) {
      if (!GRADES.includes(r.grade)) problems.push(`${r.id} 判定非法「${r.grade}」（须 ${GRADES.join('/')} 之一）`)
      if (!LEVELS.includes(r.level)) problems.push(`${r.id} 定级非法「${r.level}」（须 ${LEVELS.join('/')} 之一）`)
    }
    gates.push({
      id: 'G1',
      name: `覆盖完整（≥${MIN_CLAUSES} 行 + 四档/定级合法）`,
      pass: problems.length === 0,
      detail: problems.length === 0 ? `${list.length} 行，四档与定级全部合法` : problems.slice(0, 6).join('；') + (problems.length > 6 ? ` …共 ${problems.length} 处` : ''),
    })
  }

  // ── G2 ENFORCED 必须可验证（防拍脑袋标 ENFORCED 的主门）──────────────────
  {
    const enforced = list.filter((r) => r.grade === 'ENFORCED')
    const problems = []
    if (enforced.length === 0) {
      problems.push('没有任何 ENFORCED 行——审计声称「有闸门在跑」的能力为空，判据失明')
    }
    for (const r of enforced) {
      if (!r.gateRef) { problems.push(`${r.id} 标 ENFORCED 但没给闸门 文件:行号`); continue }
      if (!r.assertId) { problems.push(`${r.id} 标 ENFORCED 但没给断言标识`); continue }
      const file = r.gateRef.replace(/:[0-9]+$/, '')
      const text = readGate(file)
      if (text === null) { problems.push(`${r.id} 声称的闸门文件不存在：${file}`); continue }
      if (!text.includes(r.assertId)) problems.push(`${r.id} 断言标识「${r.assertId}」在 ${file} 内找不到（拍脑袋标 ENFORCED）`)
    }
    gates.push({
      id: 'G2',
      name: 'ENFORCED 必须可验证（文件存在 + 断言标识可寻）',
      pass: problems.length === 0,
      detail: problems.length === 0 ? `${enforced.length} 条 ENFORCED 全部通过文件+断言标识核验` : problems.slice(0, 6).join('；'),
    })
  }

  // ── G3 N/A 不许滥用 ─────────────────────────────────────────────────────
  {
    const na = list.filter((r) => r.grade === 'N/A').length
    const ratio = list.length === 0 ? 0 : na / list.length
    gates.push({
      id: 'G3',
      name: `N/A 不许滥用（占比 ≤ ${(NA_MAX_RATIO * 100).toFixed(0)}%）`,
      pass: list.length > 0 && ratio <= NA_MAX_RATIO,
      detail: `${na}/${list.length} = ${(ratio * 100).toFixed(1)}%（上限 ${(NA_MAX_RATIO * 100).toFixed(0)}%）`,
    })
  }

  // ── G4 P0 必须有整改 ────────────────────────────────────────────────────
  // 查的是 §5 里该条款的**真正整改正文**（fixes 注入）；没注入时退回落判据说明。
  {
    const fixes = opts.fixes instanceof Map ? opts.fixes : null
    const p0 = list.filter((r) => r.level === 'P0')
    const problems = []
    for (const r of p0) {
      const fixBody = fixes !== null ? (fixes.get(r.id) ?? '') : (r.fix ?? '')
      if (!fixBody || !fixBody.trim()) {
        problems.push(`${r.id} P0 但 §5 没有整改正文`)
        continue
      }
      const hasKeyword = FIX_KEYWORDS.some((k) => fixBody.includes(k))
      if (!hasKeyword) problems.push(`${r.id} P0 整改正文缺闸门形态关键词（${FIX_KEYWORDS.join('/')}）`)
    }
    gates.push({
      id: 'G4',
      name: 'P0 必须有整改（§5 正文 + 闸门形态关键词）',
      pass: problems.length === 0,
      detail: problems.length === 0 ? `${p0.length} 条 P0 在 §5 均有可落地整改` : problems.slice(0, 6).join('；'),
    })
  }

  // ── G5 零命中防护 + 阳性对照 ────────────────────────────────────────────
  {
    const empty = list.length === 0
    gates.push({
      id: 'G5',
      name: '零命中防护（解析 0 行即红）',
      pass: !empty,
      detail: empty
        ? '仅解析出 0 行条款——判据失明（表格格式漂移/文件被清空），按失明处理，绝不当「没问题」'
        : `解析出 ${list.length} 行（非零）`,
    })
  }

  const gateMap = Object.fromEntries(gates.map((g) => [g.id, g]))
  const na = list.filter((r) => r.grade === 'N/A').length
  return {
    pass: gates.every((g) => g.pass),
    gates,
    gateMap,
    stats: {
      total: list.length,
      ENFORCED: list.filter((r) => r.grade === 'ENFORCED').length,
      PARTIAL: list.filter((r) => r.grade === 'PARTIAL').length,
      MANUAL: list.filter((r) => r.grade === 'MANUAL').length,
      'N/A': na,
      naRatio: list.length === 0 ? 0 : na / list.length,
      P0: list.filter((r) => r.level === 'P0').length,
    },
  }
}

/**
 * 阳性对照：喂一段**已知合法**的合成条款表，解析器必须抽出预期行数且 G1–G5 全绿。
 * 判据若因正则写错而恒零命中，这里会红——从而拒绝把「没抓到」读成「没问题」。
 * @returns {{pass:boolean, detail:string}}
 */
export function positiveControl() {
  const header = [
    '## 4. 条款表',
    '',
    '| # | 原句片段（≤40 字） | 载体 | 判定 | 定级 | 闸门断言 | 判据说明 |',
    '|---|---|---|---|---|---|---|',
  ]
  const body = []
  const n = MIN_CLAUSES
  for (let i = 0; i < n; i++) {
    const id = 'C-' + String(i + 1).padStart(3, '0')
    // 构造：~50% PARTIAL（带可核验闸门，指向本文件自身）、少量 ENFORCED、少量 N/A。
    // 这里刻意用本文件自己的路径+标识（SENTINEL_ASSERT）当闸门，保证 G2 可真实通过。
    if (i % 20 === 0) {
      body.push(`| ${id} | 合成样本 ${i} | \`docs/constraint-audit.md:1\` | **ENFORCED** | P1 | \`tools/constraint-audit.mjs:100\`<br>「SENTINEL_ASSERT」 | 合成样本：闸门可验证（断言、变异、必红 均在场）。 |`)
    } else if (i % 20 === 1) {
      body.push(`| ${id} | 合成样本 ${i} | \`docs/constraint-audit.md:1\` | **N/A** | P2 | — | 合成样本：本体不可机检（判断性纪律，非逃避档）。 |`)
    } else {
      body.push(`| ${id} | 合成样本 ${i} | \`docs/constraint-audit.md:1\` | **PARTIAL** | P2 | \`tools/constraint-audit.mjs:100\`<br>「SENTINEL_ASSERT」 | 合成样本：覆盖一部分。 |`)
    }
  }
  const text = [...header, ...body, '', '## 5. 下一节', ''].join('\n')
  const rows = parseClauseTable(text)
  const res = classify(rows, { readGate: () => 'SENTINEL_ASSERT' })
  if (rows.length !== n) {
    return { pass: false, detail: `阳性对照红：合成表应解析 ${n} 行，实得 ${rows.length} 行` }
  }
  if (!res.pass) {
    const bad = res.gates.filter((g) => !g.pass).map((g) => `${g.id}: ${g.detail}`)
    return { pass: false, detail: `阳性对照红：合成合法表未全绿（${bad.join(' | ')}）` }
  }
  return { pass: true, detail: `合成合法表解析 ${rows.length} 行并全绿（判据未失明）` }
}
// ── selftest（≥5 变异体，每个只动一个变量）──────────────────────────────────

/** 读真实审计正本（selftest 的「原样」基准；真实输入无 workaround）。 */
export function loadAuditText(root = REPO_ROOT) {
  const p = join(root, AUDIT_DOC)
  if (!existsSync(p)) throw new GateParseError(`审计正本不存在：${p}`)
  return readFileSync(p, 'utf8')
}

/**
 * 注入必红自测：每个变异体只动一个变量，断言**指定的那道门**变红（不是随便哪道门）。
 * 断言「指定门红」而非「整体红」——否则一个变异可能被无关的门碰红，鉴别力就假了。
 * @returns {{pass:number, total:number, rows:Array<{name:string,ok:boolean,detail:string}>}}
 */
export function selftest() {
  const rows = []
  const baseText = loadAuditText()
  const baseRows = parseClauseTable(baseText)
  const readGate = (file) => {
    const p = join(REPO_ROOT, file)
    if (!existsSync(p)) return null
    try { return readFileSync(p, 'utf8') } catch { return null }
  }

  const run = (name, mutate, expectGate) => {
    let res
    let mutated
    try {
      mutated = mutate(baseText)
      if (mutated === baseText) {
        rows.push({ name, ok: false, detail: '变异未生效（替换零命中）——构造无效，不允许进判定' })
        return
      }
      const parsed = parseClauseTable(mutated)
      res = classify(parsed, { readGate, fixes: parseFixes(mutated) })
    } catch (e) {
      rows.push({ name, ok: false, detail: `解析/判定抛错（应返回结构化判定）：${e.message}` })
      return
    }
    const target = res.gateMap[expectGate]
    const ok = target !== undefined && target.pass === false && res.pass === false
    const reds = res.gates.filter((g) => !g.pass).map((g) => g.id)
    rows.push({
      name,
      ok,
      detail: `期望 ${expectGate} 红；实测红门=[${reds.join(',') || '无'}]` + (ok ? '' : ' ← 未达预期'),
    })
  }

  // 0) 原样必须全绿（对照组）
  {
    const res = classify(baseRows, { readGate, fixes: parseFixes(baseText) })
    rows.push({
      name: '原样审计正本（全绿对照）',
      ok: res.pass === true,
      detail: res.pass ? `G1–G5 全绿，${res.stats.total} 行` : `红门=[${res.gates.filter((g) => !g.pass).map((g) => g.id).join(',')}]`,
    })
  }

  // 1) 某行 ENFORCED 改成引用不存在的闸门文件 → G2 必红
  run('MUT1 ENFORCED 引用不存在的闸门文件', (t) => {
    const m = /\| (C-\d{3}) \|([^\n]*)\*\*ENFORCED\*\*([^\n]*)\n/.exec(t)
    if (!m) throw new Error('找不到 ENFORCED 行做变异')
    const line = m[0]
    const mutated = line.replace(/`[^`]+\.mjs:[0-9]+`/, '`tools/definitely-not-exist-gate.mjs:9999`')
    if (mutated === line) throw new Error('未能替换闸门引用')
    return t.replace(line, mutated)
  }, 'G2')

  // 2) 某行判据改成乱码 → G1 必红（四档非法）
  run('MUT2 判定改成乱码', (t) => {
    const m = /\| (C-\d{3}) \|([^\n]*?)\*\*PARTIAL\*\*([^\n]*)\n/.exec(t)
    if (!m) throw new Error('找不到 PARTIAL 行做变异')
    const line = m[0]
    return t.replace(line, line.replace('**PARTIAL**', '**乱码判据**'))
  }, 'G1')

  // 3) 删掉一条 P0 在 §5 的整改正文 → G4 必红
  run('MUT3 删掉一条 P0 的整改正文', (t) => {
    const m = /^-\s*\*\*整改\*\*：.+$/m.exec(t)
    if (!m) throw new Error('找不到 §5 的整改行做变异')
    return t.replace(m[0], '- **整改**：')
  }, 'G4')

  // 4) 整表清空 → G5 必红（零命中防护）
  run('MUT4 整表清空', (t) => {
    const start = t.indexOf('## 4. 条款表')
    if (start < 0) throw new Error('找不到条款表小节')
    const end = t.indexOf('## 5.', start)
    if (end < 0) throw new Error('找不到下一节边界')
    return t.slice(0, start) + '## 4. 条款表\n\n（表被清空）\n\n' + t.slice(end)
  }, 'G5')

  // 5) N/A 占比拉满 → G3 必红
  run('MUT5 N/A 占比拉满', (t) => {
    const start = t.indexOf('## 4. 条款表')
    if (start < 0) throw new Error('找不到条款表小节')
    const end = t.indexOf('## 5.', start)
    const head = t.slice(0, start)
    const body = t.slice(start, end)
    const tail = t.slice(end)
    const over = body
      .split('\n')
      .map((l) => {
        if (!/^\| C-\d{3} \|/.test(l)) return l
        return l.replace(/\*\*(ENFORCED|PARTIAL|MANUAL)\*\*/, '**N/A**')
      })
      .join('\n')
    return head + over + tail
  }, 'G3')

  const failed = rows.filter((r) => !r.ok)
  return { pass: rows.length - failed.length, total: rows.length, rows }
}

function runSelftest() {
  const st = selftest()
  console.log('== constraint-audit --selftest（注入必红；真实正本 + 内存变异）==')
  for (const row of st.rows) console.log(`[selftest] ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  —— ${row.detail}`)
  console.log(`[selftest] ${st.pass}/${st.total} PASS`)
  if (st.pass !== st.total) {
    console.error('[selftest] FAIL — 变异体未达预期，门判据退化')
    process.exitCode = 1
  }
}

// ── 渲染（正常跑的道门输出 + 可选 --out 报告）───────────────────────────────

function run() {
  const text = loadAuditText()
  const rows = parseClauseTable(text)
  const res = classify(rows, { fixes: parseFixes(text) })
  console.log('== constraint-audit（约束结构化审计闸门）==')
  for (const g of res.gates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id} ${g.name} —— ${g.detail}`)
  const s = res.stats
  console.log(`  [统计] 条款 ${s.total} · ENFORCED ${s.ENFORCED} · PARTIAL ${s.PARTIAL} · MANUAL ${s.MANUAL} · N/A ${s['N/A']}（${(s.naRatio * 100).toFixed(1)}%）· P0 ${s.P0}`)
  console.log(`[RESULT] ${res.pass ? 'PASS — G1–G5 全绿' : 'FAIL — 存在门红'}`)
  if (!res.pass) process.exitCode = 1
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) runSelftest()
  else if (args.length === 0) run()
  else {
    console.error(`用法：node tools/constraint-audit.mjs [--selftest]（未知参数：${args.join(' ')}）`)
    process.exitCode = 2
  }
}