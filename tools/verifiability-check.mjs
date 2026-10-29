#!/usr/bin/env node
/**
 * tools/verifiability-check.mjs — docs/VERIFIABILITY.md 可失败闸门（B7）。
 *
 * 职责：把「对外宣称数字」的可复核性变成机器可判的硬门 —— 不是证明数字对，
 * 而是证明**每条断言都登记了可执行复现路径 + 当次读数口径**，且路径指向的仓内
 * 文件真实存在。数字本身的正确性由 `--execute` 逐条跑命令交叉核对（重模式）。
 *
 * 矩阵形态（`docs/VERIFIABILITY.md`，五列固定）：
 *   | # | 断言 | 来源（文档:行） | 证据（数值/位置） | 复现路径（可执行命令） |
 * 按载体分节：`## README.md（N 断言）` / `## ARCHITECTURE.md（N 断言）` / ...
 *
 * 门规则（V1–V5 常驻；X1 为 `--execute` 重模式）：
 *   V1 条数下限：解析出的断言行数 ≥ MIN_ASSERTIONS，且每个分节标题声明的
 *      `（N 断言）` 必须等于该节实际行数（防「标题写 12、表里 9 行」的自欺）。
 *   V2 五列齐全：每行五列都非空；复现路径列必须以 `node `/`git `/`npm `/`pwsh `/
 *     `powershell ` 之一开头（这条是防「见代码」「参考文档」类伪路径的主门）。
 *   V3 口径必标：每行「证据」列必须含 `实测读数：` 或 `估算依据：` 之一；
 *     标了实测却缺 `实测读数：<值>` ⇒ 红；标了估算而复现路径为空 ⇒ 红
 *     （V2 已覆盖空列，此处再做显式双保险，分离两种失败的诊断）。
 *   V4 引用文件存在：复现路径里出现的仓内路径（lib/ tools/ tests/ docs/ personas/
 *     skills/ policies/ scripts/ 及根级清单文件）逐个 existsSync；
 *     **抽不到任何仓内路径的行 ⇒ 红**（路径不可解析 = 不可核验）。
 *   V5 零命中防护：解析出 0 行 ⇒ 红；且内置阳性对照 —— 喂一段已知合法的合成表格
 *     必须判绿（判据失明时阳性对照先红，杜绝「门永远绿」）。
 *   X1（`--execute`）：逐条真跑 `实测` 行的复现路径（shell 模式以支持 `git … | node …`
 *     管道；子进程输出走 fd 继承，**不用** `stdio:'pipe'` —— 本仓沙箱 pipe 捕获必 EPERM，
 *     纪律 L1-01），断言命令退出码 0 且输出含该行声明的 `实测读数`。
 *     这是「把估算写成实测」的机器防线：静态门无法证明读数可复现，只有真跑能。
 *
 * 用法：
 *   node tools/verifiability-check.mjs                # 静态门 V1–V5（快，确定性）
 *   node tools/verifiability-check.mjs --execute       # 追加 X1：真跑全部实测行（慢）
 *   node tools/verifiability-check.mjs --selftest      # 5 变异体注入必红 + 原样全绿（内存构造，不写盘）
 *   node tools/verifiability-check.mjs --doc <path>    # 指定矩阵文件（默认 docs/VERIFIABILITY.md）
 *
 * 退出码：0 全绿；1 存在门红 / 解析或读取 fail-closed / selftest 未达期望；2 用法错误。
 *
 * 零新依赖（node:fs / node:path / node:url / node:child_process / node:os）；
 * 不联网；除 `--execute` 外不 spawn。判据为纯函数（`classify` 吃文本），selftest 即复用。
 */
import { existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 仓根绝对路径（矩阵里的复现路径一律相对它解析）。 */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 默认矩阵路径（相对仓根）。 */
export const DEFAULT_DOC = 'docs/VERIFIABILITY.md'

// ── 契约常量（改口径必须同步本脚本注释 + 设计正本 agent-out/opt-b5b6b7-design.md 节 3）──

/**
 * V1 断言行数下限。
 *
 * 取值来源（**实测，不是先写 30 再凑**）：本脚本首版落地时 `docs/VERIFIABILITY.md`
 * 实解析 **44** 行，分节实测为 README 12 / ARCHITECTURE 15 / CHANGELOG 5 /
 * 工具描述 6 / docs 6（合计 44）。下限取 44 —— 后续**只许加不许减**：减行必须
 * 同步下调本常量，并在同批 diff 里写明「为什么少一条断言」（否则就是静默缩水）。
 * 设计正本要求 ≥30；本仓宣称面实测 44 条，故以真实值 44 为准（更高不违规）。
 */
export const MIN_ASSERTIONS = 44

/** 复现路径允许的起始命令前缀（V2 主门：可执行形态，不认「见代码」「参考文档」）。 */
export const PATH_PREFIXES = Object.freeze(['node ', 'git ', 'npm ', 'pwsh ', 'powershell '])

/** V3 口径标记（二选一必标；实测必须自带当次读数）。 */
export const CALIBER_MEASURED = '实测读数：'
export const CALIBER_ESTIMATED = '估算依据：'

/**
 * 可复现路径的仓内前缀（V4 宇宙）。
 * 刻意**不含** `agent-out/`：该目录 gitignored（不随仓分发），把它写进矩阵等于给
 * 外部评审者一条 clone 后跑不通的路径（本仓 CODE-P2-7 同款教训）。
 */
export const REPO_PATH_PREFIXES = Object.freeze([
  'lib/', 'tools/', 'tests/', 'docs/', 'personas/', 'skills/', 'policies/', 'scripts/',
  'package.json', 'cordis.patch.yml', 'ARCHITECTURE.md', 'CHANGELOG.md', 'README.md',
  'LICENSE', 'THIRD-PARTY-NOTICES.md', '.gitattributes',
])

/** 变异体与判据一一对应的期望（selftest 逐条核对「红在指定门上」，不只判「红了」）。 */
export const SELFTEST_EXPECTATIONS = Object.freeze([
  { id: 'MUT1', name: '某行复现路径改成「见代码」', gate: 'V2' },
  { id: 'MUT2', name: '删掉一行的证据列', gate: 'V2' },
  { id: 'MUT3', name: '估算改成实测但命令跑不出该数', gate: 'X1' },
  { id: 'MUT4', name: '复现路径指向不存在的文件', gate: 'V4' },
  { id: 'MUT5', name: '整表清空', gate: 'V1' },
])

/** 解析/读取 fail-closed 异常：结构不对 ⇒ 该门红，绝不「差不多」继续。 */
export class GateParseError extends Error {}

// ── 解析（fail-closed：表结构不明就报错，不猜）──────────────────────────────

/** 去 markdown 反引号包裹（`cmd` → cmd），供前缀判定与执行。 */
function stripTicks(cell) {
  const s = String(cell).trim()
  if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) return s.slice(1, -1).trim()
  return s
}

/** 还原表格单元格里被转义的竖线（`git a \| node b` → `git a | node b`）。 */
function unescapeCell(cell) {
  return String(cell).replace(/\\\|/g, '|').trim()
}

/**
 * 按未转义竖线切一行表格。
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') { cur += '\\|'; i++; continue }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

const HEADER_RE = /^\|\s*#\s*\|\s*断言\s*\|/
const SEP_RE = /^\|[\s:|-]+\|$/
const SECTION_RE = /^##\s+(.+?)（\s*(\d+)\s*断言\s*）\s*$/

/**
 * 解析矩阵文件全文。
 *
 * 只把紧跟 `| # | 断言 | …` 表头的表格当断言表：文档里其它表格（口径说明、漂移清单）
 * 一律忽略，避免把非断言表误当断言行（L1-14：门线不能被说明文字误触发）。
 *
 * @param {string} text
 * @returns {{sections:Array<{title:string,declared:number,rowCount:number,lineNo:number}>, rows:Array<object>}}
 */
export function parseMatrix(text) {
  const lines = String(text).split(/\r?\n/)
  const rows = []
  const sections = []
  let section = null
  let inHeader = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#')) {
      // 任何标题行都终止当前表格（含非分节的说明性标题）
      inHeader = false
      const sec = line.match(SECTION_RE)
      if (sec) {
        section = { title: sec[1].trim(), declared: Number(sec[2]), rowCount: 0, lineNo: i + 1 }
        sections.push(section)
      }
      continue
    }
    if (HEADER_RE.test(line)) { inHeader = true; continue }
    if (inHeader && SEP_RE.test(line)) continue
    if (inHeader && line.startsWith('|')) {
      const cells = splitRow(line)
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')
      if (isSeparator) continue
      if (cells.length !== 5) {
        throw new GateParseError(`第 ${i + 1} 行表格列数 = ${cells.length}（必须是 5 列）：${line.slice(0, 120)}`)
      }
      rows.push({
        lineNo: i + 1,
        section: section ? section.title : '(无分节)',
        id: stripTicks(cells[0]),
        assertion: unescapeCell(cells[1]),
        source: unescapeCell(cells[2]),
        evidence: unescapeCell(cells[3]),
        path: unescapeCell(stripTicks(cells[4])),
      })
      if (section) section.rowCount += 1
      continue
    }
    if (line !== '') inHeader = false
  }
  return { sections, rows }
}

/** 提取「实测读数：X」里的读数（V3 / X1 用；读到空白或标点为止）。 */
export function measuredReading(evidence) {
  const m = String(evidence).match(/实测读数[：:]\s*([^\s（(，,；;、]+)/)
  return m ? m[1].trim() : null
}

/**
 * 从复现路径里抽仓内路径候选（V4 用）。
 *
 * 两种形态都认（否则 `readdirSync('skills')` 这类「引号裹目录名」的合法命令会被
 * 误判成「抽不到路径」）：
 *   ① 带路径段：`lib/roles.js`、`./docs/task-brief-v3.md`
 *   ② 引号裹裸目录名：`'skills'`、`"tests"`、`'docs'`（命令里作目录参数时常见）
 *
 * @param {string} command
 * @returns {string[]} 去重后的相对路径（已剥 `./`，已剔尾部标点，目录不带尾斜杠）
 */
export function extractRepoPaths(command) {
  const found = []
  const text = String(command)
  const push = (raw) => {
    let p = raw
    if (p.startsWith('./')) p = p.slice(2)
    p = p.replace(/[.,;:]+$/, '')
    if (p.endsWith('/')) p = p.slice(0, -1)
    if (p && !found.includes(p)) found.push(p)
  }
  for (const prefix of REPO_PATH_PREFIXES) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // ① 带路径段（相对路径可有 ./ 前缀）
    const withPath = new RegExp(`(?:^|[\\s'"(=\\[])((?:\\./)?${esc}[A-Za-z0-9_./-]*)`, 'g')
    let m
    while ((m = withPath.exec(text)) !== null) push(m[1])
    // ② 引号裹裸目录/文件名（prefix 去掉尾斜杠后原样出现）
    const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    const bareRe = new RegExp(`['"(]${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['")]`, 'g')
    while ((m = bareRe.exec(text)) !== null) push(bare)
  }
  return found
}

// ── 判定（纯函数：吃文本 + 可选 runner，不看时钟）──────────────────────────

/** V5 阳性对照用的静态判定（只判 V2/V3/V4，不递归进 V5，避免无限自证）。 */
function classifyStructural(text) {
  const gates = []
  let rows = []
  try {
    rows = parseMatrix(text).rows
  } catch (e) {
    gates.push({ id: 'V2', pass: false, detail: e.message })
    return { gateMap: Object.fromEntries(gates.map((g) => [g.id, g])), rows }
  }
  const v2 = rows.length > 0 && rows.every((r) =>
    [r.id, r.assertion, r.source, r.evidence, r.path].every((c) => c !== '') &&
    PATH_PREFIXES.some((p) => r.path.startsWith(p)))
  const v3 = rows.length > 0 && rows.every((r) =>
    r.evidence.includes('实测') ? measuredReading(r.evidence) !== null : r.evidence.includes('估算'))
  const v4 = rows.length > 0 && rows.every((r) => {
    const ps = extractRepoPaths(r.path)
    return ps.length > 0 && ps.every((p) => existsSync(join(REPO_ROOT, p)))
  })
  gates.push({ id: 'V2', pass: v2, detail: '' }, { id: 'V3', pass: v3, detail: '' }, { id: 'V4', pass: v4, detail: '' })
  return { gateMap: Object.fromEntries(gates.map((g) => [g.id, g])), rows }
}

/**
 * 在矩阵文本上跑 V1–V5（+ 可选 X1）。
 *
 * `runCommand` 注入点：`--execute` 传真实执行器；`--selftest` 传内存假执行器
 * （变异体 MUT3 靠它证明「实测读数 ≠ 命令实际输出」会被抓）。
 *
 * @param {string} text 矩阵全文
 * @param {{runCommand?: ((row:object)=>{status:number,output:string})|null}} [options]
 * @returns {{pass:boolean, gates:Array<object>, gateMap:object, rows:Array, sections:Array, parseError:string|null}}
 */
export function classify(text, options = {}) {
  const runCommand = options.runCommand ?? null
  const gates = []
  let parsed = { sections: [], rows: [] }
  let parseError = null
  try {
    parsed = parseMatrix(text)
  } catch (e) {
    parseError = e.message
  }
  const { rows, sections } = parsed
  const fail = (id, name) => gates.push({ id, name, pass: false, detail: `解析 fail-closed：${parseError}` })

  // V1 条数下限 + 分节声明一致
  if (parseError) fail('V1', '断言行数下限 + 分节声明一致')
  else {
    const problems = []
    if (rows.length < MIN_ASSERTIONS) problems.push(`断言行数 ${rows.length} < 下限 ${MIN_ASSERTIONS}`)
    for (const s of sections) {
      if (s.declared !== s.rowCount) problems.push(`分节「${s.title}」标题声明 ${s.declared} 条、实测 ${s.rowCount} 行`)
    }
    const orphan = rows.filter((r) => r.section === '(无分节)')
    if (orphan.length > 0) problems.push(`${orphan.length} 行落在任何分节之外`)
    gates.push({
      id: 'V1',
      name: '断言行数下限 + 分节声明一致',
      pass: problems.length === 0,
      detail: problems.length === 0
        ? `${rows.length} 行 ≥ 下限 ${MIN_ASSERTIONS}；${sections.length} 个分节声明与实际行数逐节一致`
        : problems.join('；'),
    })
  }

  // V2 五列齐全 + 复现路径可执行形态
  if (parseError) fail('V2', '五列齐全 + 复现路径可执行形态')
  else {
    const bad = []
    for (const r of rows) {
      if ([r.id, r.assertion, r.source, r.evidence, r.path].some((c) => c === '')) {
        bad.push(`#${r.id}（第 ${r.lineNo} 行）存在空列`)
        continue
      }
      if (!PATH_PREFIXES.some((p) => r.path.startsWith(p))) {
        bad.push(`#${r.id} 复现路径不以可执行命令开头：${r.path.slice(0, 60)}`)
      }
    }
    gates.push({
      id: 'V2',
      name: '五列齐全 + 复现路径可执行形态',
      pass: bad.length === 0,
      detail: bad.length === 0
        ? `${rows.length} 行五列非空；复现路径全部以 ${PATH_PREFIXES.map((p) => p.trim()).join(' / ')} 之一开头`
        : bad.join('；'),
    })
  }

  // V3 口径必标
  if (parseError) fail('V3', '口径必标（实测读数 / 估算依据）')
  else {
    const bad = []
    for (const r of rows) {
      const isMeasured = r.evidence.includes('实测')
      const isEstimated = r.evidence.includes('估算')
      if (!isMeasured && !isEstimated) { bad.push(`#${r.id} 未标口径（既无「实测」也无「估算」）`); continue }
      if (isMeasured && measuredReading(r.evidence) === null) {
        bad.push(`#${r.id} 标了实测但缺「${CALIBER_MEASURED}<值>」当次读数`)
      }
      if (isEstimated && r.path.trim() === '') bad.push(`#${r.id} 标了估算且复现路径为空`)
      if (isMeasured && isEstimated) bad.push(`#${r.id} 同时标实测与估算（口径必须二选一）`)
    }
    const nMeasured = rows.filter((r) => r.evidence.includes('实测')).length
    const nEstimated = rows.filter((r) => r.evidence.includes('估算')).length
    gates.push({
      id: 'V3',
      name: '口径必标（实测读数 / 估算依据）',
      pass: bad.length === 0,
      detail: bad.length === 0
        ? `${rows.length} 行口径齐全（实测 ${nMeasured} / 估算 ${nEstimated}）；实测行均自带当次读数`
        : bad.join('；'),
    })
  }

  // V4 引用仓内路径存在
  if (parseError) fail('V4', '引用仓内路径存在（existsSync）')
  else {
    const bad = []
    for (const r of rows) {
      const paths = extractRepoPaths(r.path)
      if (paths.length === 0) {
        bad.push(`#${r.id} 复现路径抽不到任何仓内路径（不可核验）：${r.path.slice(0, 60)}`)
        continue
      }
      const missing = paths.filter((p) => !existsSync(join(REPO_ROOT, p)))
      if (missing.length > 0) bad.push(`#${r.id} 引用不存在的仓内路径：${missing.join(', ')}`)
    }
    gates.push({
      id: 'V4',
      name: '引用仓内路径存在（existsSync）',
      pass: bad.length === 0,
      detail: bad.length === 0 ? `${rows.length} 行全部抽到仓内路径且逐个存在` : bad.join('；'),
    })
  }

  // V5 零命中防护 + 阳性对照
  let positiveOk = false
  let positiveDetail = '未执行（解析已失败）'
  if (!parseError) {
    const synth = classifyStructural(buildSyntheticTable(Math.max(rows.length, 1)))
    positiveOk = synth.gateMap.V2.pass && synth.gateMap.V3.pass && synth.gateMap.V4.pass
    positiveDetail = positiveOk ? '合成合法表格判绿' : '合成合法表格被判红 ⇒ 判据失明'
  }
  const zeroHit = !parseError && rows.length === 0
  gates.push({
    id: 'V5',
    name: '零命中防护 + 阳性对照',
    pass: !zeroHit && positiveOk,
    detail: zeroHit
      ? '解析出 0 行（fail-closed：没查到不等于没问题）'
      : `${rows.length} 行非零；阳性对照：${positiveDetail}`,
  })

  // X1（--execute）：实测行的当次读数必须能被命令真跑出来
  if (runCommand) {
    const bad = []
    let ran = 0
    for (const r of rows) {
      const reading = measuredReading(r.evidence)
      if (reading === null) continue // 估算行不在 X1 射程
      ran += 1
      const res = runCommand(r)
      if (!res || res.status !== 0) { bad.push(`#${r.id} 命令退出码 ${res ? res.status : 'null'}`); continue }
      const flat = String(res.output).replace(/\s+/g, ' ')
      if (!flat.includes(reading.replace(/\s+/g, ' '))) {
        bad.push(`#${r.id} 声明读数「${reading}」未在命令输出中出现`)
      }
    }
    gates.push({
      id: 'X1',
      name: '实测读数可被复现命令跑出（--execute）',
      pass: bad.length === 0,
      detail: bad.length === 0 ? `${ran} 条实测行逐条真跑，声明读数与输出逐条一致` : bad.join('；'),
    })
  }

  const REQUIRED = runCommand ? ['V1', 'V2', 'V3', 'V4', 'V5', 'X1'] : ['V1', 'V2', 'V3', 'V4', 'V5']
  const gateMap = Object.fromEntries(gates.map((g) => [g.id, g]))
  return {
    pass: REQUIRED.every((id) => gateMap[id] && gateMap[id].pass),
    gates,
    gateMap,
    rows,
    sections,
    parseError,
  }
}

/**
 * 合成合法表格（阳性对照 / selftest 底座）。路径刻意用真实存在的仓内文件
 * （`lib/roles.js`），否则 V4 会把「合成样本自己不可核验」判红 —— 阳性对照必须真绿。
 * @param {number} [count]
 * @returns {string}
 */
export function buildSyntheticTable(count = 3) {
  const L = []
  L.push('# 合成阳性对照（内存构造，不写盘）')
  L.push('')
  L.push(`## 合成载体（${count} 断言）`)
  L.push('')
  L.push('| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |')
  L.push('|---|---|---|---|---|')
  for (let i = 1; i <= count; i++) {
    L.push(`| X${i} | 合成断言 ${i} | 合成来源:${i} | 实测读数：${i} | node --input-type=module -e "import{existsSync}from'node:fs';console.log(existsSync('lib/roles.js')?${i}:'')" |`)
  }
  L.push('')
  return L.join('\n')
}

// ── 渲染与执行 ──────────────────────────────────────────────────────────────

/**
 * 真实执行器：shell 模式（支持 `git … | node …` 管道）+ fd 继承捕获。
 * 不用 `stdio:'pipe'` —— 本仓沙箱 pipe 捕获必 EPERM（L1-01），改用临时 fd。
 *
 * 超时缺省 600s：矩阵里有 `node tests/isolation-gate.mjs --selftest`（实测 ~175s，
 * 内含 3 次 run.mjs 全量跑）与 `node tests/run.mjs`（实测 ~35s）这类重行；
 * 超时值太小会把「慢」误判成「跑不出读数」（本脚本首版 180s 就踩过 A13 假红）。
 */
export function makeShellRunner({ timeoutMs = 600000 } = {}) {
  return function runCommand(row) {
    const f = join(tmpdir(), `verifiability-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
    let status = null
    let output = ''
    let fd = null
    try {
      fd = openSync(f, 'w')
      const r = spawnSync(row.path, { shell: true, cwd: REPO_ROOT, stdio: ['ignore', fd, fd], timeout: timeoutMs })
      closeSync(fd)
      fd = null
      status = r.status
      if (r.error) {
        output = `[spawn 失败] ${r.error.code ?? r.error.message}\n`
        status = status === null ? -1 : status
      }
      output += readFileSync(f, 'utf8')
    } catch (e) {
      output = `[runner 异常] ${e.message}`
      status = -1
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
      try { unlinkSync(f) } catch { /* ignore */ }
    }
    return { status, output }
  }
}

/** 渲染一屏判定结果。 */
export function renderReport(result, meta = {}) {
  const L = []
  L.push('== verifiability-check（docs/VERIFIABILITY.md 可失败闸门）==')
  if (meta.doc) L.push(`  矩阵：${meta.doc}`)
  L.push(`  解析：${result.sections.length} 个分节 / ${result.rows.length} 条断言`)
  for (const g of result.gates) L.push(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id} ${g.name} —— ${g.detail}`)
  L.push(`[RESULT] ${result.pass ? 'PASS — 全部门绿' : 'FAIL — 存在门红'}`)
  return L.join('\n')
}

// ── selftest（5 变异体：内存构造，每个只动一个变量，各自精确变红）──────────

/**
 * 从真实矩阵派生「原样 + 5 变异体」，逐条核对期望（见 SELFTEST_EXPECTATIONS）。
 * 全部在内存里构造表格文本，**不写盘、不改真实文件**（本仓 L1-15 纪律）。
 * @param {string} docText 真实矩阵全文（只读）
 */
export function selftest(docText) {
  const rows = []
  const base = parseMatrix(docText).rows
  const readingById = new Map(base.map((r) => [r.id, measuredReading(r.evidence)]))
  const bySection = new Map()
  for (const r of base) {
    if (!bySection.has(r.section)) bySection.set(r.section, [])
    bySection.get(r.section).push(r)
  }

  /** 按 mutate(list) 重建矩阵文本（分节声明按实际行数重算，保证只动一个变量）。 */
  const render = (mutate) => {
    const L = ['# selftest 矩阵（内存构造）', '']
    let n = 0
    for (const [section, list] of bySection) {
      const kept = mutate(list).filter((r) => r !== null)
      if (kept.length === 0) continue
      L.push(`## ${section}（${kept.length} 断言）`, '')
      L.push('| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |')
      L.push('|---|---|---|---|---|')
      for (const r of kept) {
        n += 1
        L.push(`| ${[r.id, r.assertion, r.source, r.evidence, r.path.replace(/\|/g, '\\|')].join(' | ')} |`)
      }
      L.push('')
    }
    return { text: L.join('\n'), count: n }
  }

  /** 内存假执行器：回放该行「原本」声明的读数（MUT3 靠它暴露「声明 ≠ 可跑出」）。 */
  const echoRunner = (row) => {
    const v = readingById.get(row.id)
    return { status: 0, output: v === null ? '' : v }
  }

  const original = render((list) => list)
  const good = classify(original.text, { runCommand: echoRunner })
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5', 'X1']
  rows.push({
    name: '原样（内存副本）必须全绿',
    ok: good.pass && ids.every((id) => good.gateMap[id] && good.gateMap[id].pass),
    detail: `${ids.map((id) => `${id}=${good.gateMap[id] && good.gateMap[id].pass ? '绿' : '红'}`).join(' ')}（${original.count} 行）`,
  })

  /** 只改第一处命中，重建文本后按 bySection 重算分节声明。 */
  const mutateFirst = (mutate) => {
    let done = false
    return render((list) => list.map((r) => {
      if (done) return r
      const next = mutate(r)
      if (next !== r) done = true
      return next
    })).text
  }

  const checkMutant = (id, mutator, gate) => {
    const text = mutateFirst(mutator)
    const result = classify(text, { runCommand: echoRunner })
    const target = result.gateMap[gate]
    const spec = SELFTEST_EXPECTATIONS.find((e) => e.id === id)
    rows.push({
      name: `${id} ${spec.name} → ${gate} 必红`,
      ok: Boolean(target && !target.pass) && !result.pass,
      detail: `${result.gates.map((g) => `${g.id}=${g.pass ? '绿' : '红'}`).join(' ')}；${gate}: ${target ? target.detail.slice(0, 150) : '缺门'}`,
    })
  }

  checkMutant('MUT1', (r) => ({ ...r, path: '见代码' }), 'V2')
  checkMutant('MUT2', (r) => ({ ...r, evidence: '' }), 'V2')
  // MUT3 —— 设计正本写「估算改成实测但命令跑不出该数」。本矩阵**实测 44 / 估算 0**
  // （估算口径按设计正本要求单列在「估算口径登记」节，不进矩阵），故没有可改的估算行；
  // 改成等价形态：把某行的实测读数改成命令跑不出的数（999）—— 断言的还是同一件事：
  // 「证据列声明的读数必须能被复现路径真跑出来」，echoRunner 回放原读数即可判红 X1。
  checkMutant('MUT3', (r) => (r.evidence.includes('实测读数') ? { ...r, evidence: '实测读数：999' } : r), 'X1')
  checkMutant('MUT4', (r) => ({ ...r, path: 'node tools/__b7_selftest_missing__.mjs' }), 'V4')
  {
    const empty = '# selftest 矩阵（清空）\n\n## 空载体（0 断言）\n\n| # | 断言 | 来源（文档:节或行） | 证据（数值/位置） | 复现路径（可执行命令） |\n|---|---|---|---|---|\n'
    const result = classify(empty, { runCommand: echoRunner })
    rows.push({
      name: 'MUT5 整表清空 → V1/V5 必红',
      ok: !result.gateMap.V1.pass && !result.gateMap.V5.pass && !result.pass,
      detail: result.gates.map((g) => `${g.id}=${g.pass ? '绿' : '红'}`).join(' '),
    })
  }

  const failed = rows.filter((r) => !r.ok)
  return { pass: rows.length - failed.length, total: rows.length, rows }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { doc: DEFAULT_DOC, execute: false, selftest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') { opts.selftest = true; continue }
    if (a === '--execute') { opts.execute = true; continue }
    if (a === '--doc') {
      const v = argv[++i]
      if (v === undefined) {
        console.error('[用法错误] --doc 需要一个值（收到末参，值缺失）')
        process.exitCode = 2
        return null
      }
      opts.doc = v
      continue
    }
    console.error(`[用法错误] 未知参数 ${a}`)
    console.error('用法: node tools/verifiability-check.mjs [--execute] [--selftest] [--doc <path>]')
    process.exitCode = 2
    return null
  }
  return opts
}

function readDoc(path) {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8')
  } catch (e) {
    throw new GateParseError(`矩阵读取失败（${path}）：${e.message}`)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts === null) return

  if (opts.selftest) {
    let docText
    try {
      docText = readDoc(opts.doc)
    } catch (e) {
      console.error(`[fail-closed] ${e.message}`)
      process.exitCode = 1
      return
    }
    let st
    try {
      st = selftest(docText)
    } catch (e) {
      console.error(`[fail-closed] selftest 解析失败：${e.message}`)
      process.exitCode = 1
      return
    }
    console.log('== verifiability-check --selftest（注入必红；变异体在内存构造，不写盘）==')
    for (const row of st.rows) console.log(`[selftest] ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}  —— ${row.detail}`)
    console.log(`[selftest] ${st.pass}/${st.total} PASS（变异体期望 ${SELFTEST_EXPECTATIONS.length}/${SELFTEST_EXPECTATIONS.length} 达期望）`)
    if (st.pass !== st.total) {
      console.error('[selftest] FAIL — 变异体未达期望，门判据退化')
      process.exitCode = 1
    }
    return
  }

  let docText
  try {
    docText = readDoc(opts.doc)
  } catch (e) {
    console.error(`[fail-closed] ${e.message}`)
    process.exitCode = 1
    return
  }
  const runCommand = opts.execute ? makeShellRunner() : null
  const result = classify(docText, { runCommand })
  console.log(renderReport(result, { doc: opts.doc }))
  if (!result.pass) {
    console.error('[FAIL] 存在门红 —— 未达交付标准（fail-closed）')
    process.exitCode = 1
  }
}

// import guard（供后续工具复用 classify / parseMatrix / selftest 时不整场跑 CLI）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
