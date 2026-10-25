#!/usr/bin/env node
/**
 * measure-injection-surface.mjs — A1 全注入面基线测量（plan-opt-r1 §七 A1，AC-M1-1 扩展版）。
 *
 * 统一口径实测四个注入面并输出读数（码点 / UTF-16 码元 / UTF-8 字节三口径）：
 *   面A 工具面    lib/index.js 三工具（agent_roles / agent_taskbook / agent_spawn）的
 *                 工具级 description + parameters / output.schema 内全部 description
 *                 字符串补量（结构字符不计，只计描述字符串值）。
 *   面B 技能面    skills 目录各 SKILL.md frontmatter description 逐条 + 合计（25 个）。
 *                 personas/checklists/ 11 文件不在口径，显式标注。
 *   面C persona 面 personas/*.md 23 文件逐文件全文字符数（单文件口径，裁决 1）。
 *   面D 任务书面  composeTaskbook dryRun 抽样 3 角色（explore/executor/analyst）×
 *                 同一任务文本，总字符 + 分节统计；样本全文落盘 --samples 目录。
 *
 * 用法：
 *   node tools/measure-injection-surface.mjs [--json <path>] [--report <path>]
 *        [--samples <dir>] [--diff <prev.json>] [--selftest]
 *
 * 确定性保证：零 spawn（沙箱 stdio:'pipe' EPERM 纪律）、零网络、不读时钟参与读数
 * （composeTaskbook 的 stamp 时间戳只进样本正文，15 字符等宽定长，不进统计读数）。
 * ±0 复跑：同一工作区跑两遍 --json，再用 --diff 对比（meta.measuredAt 除外全字段相等）。
 *
 * 退出码：0 成功；1 断言/解析失败（fail-closed）；2 用法错误。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { rolesTool, taskbookTool, spawnTool, resolveConfig } from '../lib/index.js'
import { getRole } from '../lib/roles.js'
import { loadPersona, splitFrontmatter } from '../lib/persona.js'
import { resolveRoute, TIER_INTENT } from '../lib/routing.js'
import { composeTaskbook } from '../lib/taskbook.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SKILLS_DIR = join(ROOT, 'skills')
const PERSONAS_DIR = join(ROOT, 'personas')

/** 测量口径常量（plan §三「口径写死」；数量变更 = 口径变更，须同步本脚本与基线报告）。 */
const EXPECT = { skills: 25, personas: 23, checklists: 11, taskbookRoles: 3 }
const SAMPLE_ROLES = ['explore', 'executor', 'analyst']
/** dryRun 抽样用中性任务文本（组织者约束：≤50 字、中性、三角色通用）。 */
const SAMPLE_TASK = '梳理 tools 目录脚本的用途清单，输出一页 markdown 索引；只读不改文件。'

// ── 度量原语（导出供单测复用，2026-10-25 P2-7）────────────────────────────────

/** 三口径字符度量：码点 / UTF-16 码元 / UTF-8 字节。 */
export function metrics(str) {
  const s = String(str)
  return { codepoints: [...s].length, units: s.length, bytes: Buffer.byteLength(s, 'utf8') }
}

function addMetrics(a, b) {
  return {
    codepoints: a.codepoints + b.codepoints,
    units: a.units + b.units,
    bytes: a.bytes + b.bytes,
  }
}

const ZERO = { codepoints: 0, units: 0, bytes: 0 }

/** 递归收集 schema 树内全部 description 字符串（结构字符不计，只计描述字符串值）。 */
export function collectDescriptions(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectDescriptions(item, out)
    return out
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') out.push(value)
    else collectDescriptions(value, out)
  }
  return out
}

function sha256Short(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, 16).toUpperCase()
}

// ── 面A 工具面 ───────────────────────────────────────────────────────────────

/** 三工具工厂以最小 mock 调用，取 definition（name/description/parameters/output.schema）。 */
function measureTools() {
  const config = resolveConfig({})
  const factories = [
    ['agent_roles', () => rolesTool({}, config, null)],
    ['agent_taskbook', () => taskbookTool({}, config, null)],
    ['agent_spawn', () => spawnTool({}, config, null, () => null, null)],
  ]
  const items = []
  for (const [expectedName, make] of factories) {
    const def = make()
    if (def?.name !== expectedName) throw new Error(`面A：工具工厂返回 name=${def?.name}，期望 ${expectedName}`)
    if (typeof def.description !== 'string' || def.description === '') {
      throw new Error(`面A：${expectedName} 工具级 description 缺失`)
    }
    const toolLevel = metrics(def.description)
    const paramDescs = collectDescriptions(def.parameters)
    const outDescs = collectDescriptions(def.output?.schema)
    if (paramDescs.length === 0) throw new Error(`面A：${expectedName} parameters 内未收集到任何 description（收集器或结构异常）`)
    const paramTotal = paramDescs.map(metrics).reduce(addMetrics, ZERO)
    const outTotal = outDescs.map(metrics).reduce(addMetrics, ZERO)
    items.push({
      name: expectedName,
      toolLevel: { ...toolLevel },
      paramDescs: { count: paramDescs.length, ...paramTotal },
      outputSchemaDescs: { count: outDescs.length, ...outTotal },
      facetTotal: addMetrics(addMetrics(toolLevel, paramTotal), outTotal),
    })
  }
  const totals = items.map((it) => it.facetTotal).reduce(addMetrics, ZERO)
  const descCount = items.reduce((n, it) => n + 1 + it.paramDescs.count + it.outputSchemaDescs.count, 0)
  return { items, totals, descCount }
}

// ── 面B 技能面 ───────────────────────────────────────────────────────────────

/** skills/<dir>/SKILL.md frontmatter description 逐条（解析复用 lib/persona.js splitFrontmatter）。
 *  dir 参数缺省测量仓内 skills/，自测可注入临时夹具目录（2026-10-25 P1-2 自测需要）。
 *  本函数只收集不断言；fail-closed 口径判定统一在 assertSkillCaliber。 */
function measureSkills(dir = SKILLS_DIR) {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const items = []
  const failures = []
  for (const name of dirs) {
    const abs = join(dir, name, 'SKILL.md')
    let raw
    try {
      raw = readFileSync(abs, 'utf8')
    } catch {
      failures.push(`skills/${name}/SKILL.md 不存在`)
      continue
    }
    const desc = splitFrontmatter(raw).meta.description
    if (typeof desc !== 'string' || desc === '') {
      failures.push(`skills/${name}/SKILL.md frontmatter description 解析为空`)
      continue
    }
    items.push({ id: name, ...metrics(desc), sha256: sha256Short(abs) })
  }
  const totals = items.map((it) => ({ codepoints: it.codepoints, units: it.units, bytes: it.bytes })).reduce(addMetrics, ZERO)
  return { items, totals, failures }
}

/** 面B fail-closed 口径断言：① 数量等于口径；② 零坏文件。任何一条不满足即抛（exit 1）。
 *  2026-10-25 P1-2（code-reviewer R1）：旧实现只查①——坏 SKILL.md 被「合法数凑足」掩蔽
 *  （fail-open）：26 目录 25 合法时 exit 0，基线静默漏计。 */
function assertSkillCaliber({ items, failures }) {
  if (items.length !== EXPECT.skills) {
    throw new Error(
      `面B：技能数 ${items.length} ≠ 口径 ${EXPECT.skills}（失败：${failures.join('；') || '无'}）。` +
      '口径变更须同步改本脚本 EXPECT 与基线报告。',
    )
  }
  if (failures.length > 0) {
    throw new Error(
      `面B：目录数凑足口径但存在 ${failures.length} 个坏技能文件（fail-closed 拒测）：${failures.join('；')}。` +
      '坏文件使基线静默漏计，修复后再测。',
    )
  }
}

// ── 面C persona 面 ───────────────────────────────────────────────────────────

/** personas/*.md 23 文件逐文件全文（单文件口径，裁决 1）；checklists/ 11 文件不在口径、显式标注。 */
function measurePersonas() {
  const files = readdirSync(PERSONAS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort()
  if (files.length !== EXPECT.personas) {
    throw new Error(`面C：persona 文件数 ${files.length} ≠ 口径 ${EXPECT.personas}。口径变更须同步改本脚本 EXPECT 与基线报告。`)
  }
  const items = files.map((name) => {
    const abs = join(PERSONAS_DIR, name)
    const raw = readFileSync(abs, 'utf8')
    return { file: name, ...metrics(raw), sha256: sha256Short(abs) }
  })
  const totals = items.map((it) => ({ codepoints: it.codepoints, units: it.units, bytes: it.bytes })).reduce(addMetrics, ZERO)

  const checklistDir = join(PERSONAS_DIR, 'checklists')
  let excluded = { dir: 'personas/checklists', count: 0, files: [], note: 'plan §三边界排除；按需加载文件，非会话预注入面' }
  if (statSync(checklistDir).isDirectory()) {
    const cl = readdirSync(checklistDir).filter((f) => f.toLowerCase().endsWith('.md')).sort()
    if (cl.length !== EXPECT.checklists) {
      throw new Error(`面C：checklists 文件数 ${cl.length} ≠ 口径 ${EXPECT.checklists}。口径变更须同步改本脚本 EXPECT 与基线报告。`)
    }
    excluded = {
      dir: 'personas/checklists',
      count: cl.length,
      files: cl.map((f) => ({ file: f, bytes: Buffer.byteLength(readFileSync(join(checklistDir, f)), 'utf8') })),
      note: 'plan §三边界排除；按需加载文件，非会话预注入面',
    }
  }
  return { items, totals, excluded }
}

// ── 面D 任务书面 ─────────────────────────────────────────────────────────────

/** 按二级标题切节：节 = `^## ` 标题行至下一 `## ` 标题行前（含标题行）；头部记 preamble。 */
export function splitSections(text) {
  const lines = String(text).split('\n')
  const sections = []
  let current = { title: '(preamble 头部)', lines: [] }
  for (const line of lines) {
    if (/^## /.test(line)) {
      sections.push({ title: current.title, text: current.lines.join('\n') })
      current = { title: line.trim(), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push({ title: current.title, text: current.lines.join('\n') })
  return sections
}

/** composeTaskbook dryRun 抽样（同 lib/taskbook.js 真实合成链，零 spawn 零模型调用）。 */
function measureTaskbooks(samplesDir) {
  const config = resolveConfig({})
  const items = []
  for (const id of SAMPLE_ROLES) {
    const role = getRole(id)
    if (!role) throw new Error(`面D：角色 ${id} 不存在于 lib/roles.js`)
    const persona = loadPersona(role)
    const route = resolveRoute({ role, tierTable: config.tiers, roleOverrides: config.roleOverrides })
    const text = composeTaskbook({
      role, persona, route,
      tierIntent: TIER_INTENT[route.tier],
      task: SAMPLE_TASK,
      clarifyMode: 'interactive',
    })
    const sections = splitSections(text).map((sec) => ({ title: sec.title, ...metrics(sec.text) }))
    items.push({
      role: id,
      total: { ...metrics(text) },
      sectionCount: sections.length,
      sections,
    })
    if (samplesDir) {
      mkdirSync(samplesDir, { recursive: true })
      writeFileSync(join(samplesDir, `${id}.md`), text, 'utf8')
    }
  }
  if (items.length !== EXPECT.taskbookRoles) {
    throw new Error(`面D：抽样角色数 ${items.length} ≠ 口径 ${EXPECT.taskbookRoles}`)
  }
  for (const it of items) {
    if (it.sectionCount < 5) throw new Error(`面D：${it.role} 任务书分节数 ${it.sectionCount} < 5（分节解析或合成异常）`)
    if (it.total.codepoints < 1000) throw new Error(`面D：${it.role} 任务书仅 ${it.total.codepoints} 码点（合成异常）`)
  }
  const totals = { meanCodepoints: Math.round(items.reduce((n, it) => n + it.total.codepoints, 0) / items.length), maxCodepoints: Math.max(...items.map((it) => it.total.codepoints)) }
  return { sampleTask: SAMPLE_TASK, items, totals, note: '样本正文含 stamp 生成时间戳（15 字符等宽定长），仅读数参与 ±0 对比；任务书面 C-11 排除瘦身，读数仅 Round 2 备料' }
}

// ── 汇总 / diff / 报告 ───────────────────────────────────────────────────────

function buildReadings(samplesDir = null) {
  const tools = measureTools()
  const skills = measureSkills()
  assertSkillCaliber(skills) // fail-closed：数量≠口径 或 存在坏文件 → 抛（exit 1），不产出基线
  const personas = measurePersonas()
  return {
    meta: {
      script: 'tools/measure-injection-surface.mjs',
      measuredAt: new Date().toISOString(),
      caliber: 'codepoints 主口径（对齐 explore ②节 801 字符口径）；units=UTF-16 码元；bytes=UTF-8',
    },
    tools,
    skills,
    personas,
    taskbooks: measureTaskbooks(samplesDir),
  }
}

/** --diff：除 meta.measuredAt 外逐字段深比较，全部相等才判 ±0。 */
function diffReadings(prev, curr) {
  const strip = (r) => {
    const { meta: { measuredAt, ...restMeta }, ...rest } = r
    return { meta: restMeta, ...rest }
  }
  const a = strip(prev)
  const b = strip(curr)
  const diffs = []
  const walk = (x, y, path) => {
    if (x === y) return
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') {
      diffs.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`)
      return
    }
    if (Array.isArray(x) !== Array.isArray(y)) {
      diffs.push(`${path}: 类型不同（array vs object）`)
      return
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    for (const k of keys) {
      if (!(k in x)) diffs.push(`${path}.${k}: 仅新读数存在`)
      else if (!(k in y)) diffs.push(`${path}.${k}: 仅旧读数存在`)
      else walk(x[k], y[k], `${path}.${k}`)
    }
  }
  walk(a, b, 'readings')
  return diffs
}

function fmt(n) {
  return String(n)
}

function renderReport(r, samplesDir = null) {
  const L = []
  L.push('## 读数口径')
  L.push('')
  L.push('- 三口径：**码点**（`[...str].length`，主口径，对齐 explore ②节 801 字符口径）/ **UTF-16 码元**（`str.length`）/ **UTF-8 字节**（`Buffer.byteLength`）。')
  L.push('- 工具面结构字符（键名/类型标记）不计，只计 description 字符串值（plan §七 A1「同口径补量」）。')
  L.push('- 技能 frontmatter description 解析复用 `lib/persona.js` 的 `splitFrontmatter`（剥引号后的值文本；仓内无既有 description 解析器，此为本仓口径）。')
  L.push('- 口径分列：本仓面（下述四面）／宿主面（de_* 工具与宿主技能目录，本轮不动，无读数）。')
  L.push('')
  L.push('## 面A 工具面（合计判定，裁决 1）')
  L.push('')
  L.push('| 工具 | 工具级 desc（码点/码元/字节） | 参数级 desc 条数 | 参数级 desc 小计 | output.schema desc 条数 | output 小计 | 面合计（码点/码元/字节） |')
  L.push('|---|---|---|---|---|---|---|')
  for (const it of r.tools.items) {
    const t = it.toolLevel
    const p = it.paramDescs
    const o = it.outputSchemaDescs
    const f = it.facetTotal
    L.push(`| ${it.name} | ${fmt(t.codepoints)}/${fmt(t.units)}/${fmt(t.bytes)} | ${fmt(p.count)} | ${fmt(p.codepoints)}/${fmt(p.units)}/${fmt(p.bytes)} | ${fmt(o.count)} | ${fmt(o.codepoints)}/${fmt(o.units)}/${fmt(o.bytes)} | ${fmt(f.codepoints)}/${fmt(f.units)}/${fmt(f.bytes)} |`)
  }
  const tt = r.tools.totals
  L.push(`| **合计（${fmt(r.tools.descCount)} 条描述串）** | — | — | — | — | — | **${fmt(tt.codepoints)}/${fmt(tt.units)}/${fmt(tt.bytes)}** |`)
  L.push('')
  L.push('## 面B 技能面（目录整体合计判定，裁决 1）')
  L.push('')
  L.push('| 技能 id | desc 码点 | 码元 | 字节 | sha256(16) |')
  L.push('|---|---|---|---|---|')
  for (const it of r.skills.items) L.push(`| ${it.id} | ${fmt(it.codepoints)} | ${fmt(it.units)} | ${fmt(it.bytes)} | ${it.sha256} |`)
  const st = r.skills.totals
  L.push(`| **合计（${fmt(r.skills.items.length)} 条）** | **${fmt(st.codepoints)}** | **${fmt(st.units)}** | **${fmt(st.bytes)}** | — |`)
  L.push('')
  L.push(`> 排除标注：${r.personas.excluded.dir} ${fmt(r.personas.excluded.count)} 文件**不在测量口径**（${r.personas.excluded.note}）：${r.personas.excluded.files.map((f) => f.file).join('、')}。`)
  L.push('')
  L.push('## 面C persona 面（单文件口径，裁决 1）')
  L.push('')
  L.push('| 文件 | 码点 | 码元 | 字节 | sha256(16) | ≥5K 码点 |')
  L.push('|---|---|---|---|---|---|')
  for (const it of r.personas.items) {
    L.push(`| ${it.file} | ${fmt(it.codepoints)} | ${fmt(it.units)} | ${fmt(it.bytes)} | ${it.sha256} | ${it.codepoints >= 5000 ? '是（A3 候选）' : '否'} |`)
  }
  const pt = r.personas.totals
  L.push(`| **合计（${fmt(r.personas.items.length)} 文件）** | **${fmt(pt.codepoints)}** | **${fmt(pt.units)}** | **${fmt(pt.bytes)}** | — | — |`)
  L.push('')
  L.push('## 面D 任务书面（抽样记录，C-11 排除瘦身，Round 2 备料）')
  L.push('')
  L.push(`- 抽样任务文本（${fmt([...r.taskbooks.sampleTask].length)} 码点，中性）：「${r.taskbooks.sampleTask}」`)
  L.push(samplesDir
    ? `- 合成链：\`composeTaskbook\`（lib/taskbook.js:223）dryRun 直调，零 spawn、零模型调用；样本全文见 \`${samplesDir}/\`。`
    : '- 合成链：`composeTaskbook`（lib/taskbook.js:223）dryRun 直调，零 spawn、零模型调用；本次运行未落盘样本（`--samples <dir>` 可落盘）。')
  L.push('')
  L.push('| 角色 | 总码点 | 总码元 | 总字节 | 分节数 |')
  L.push('|---|---|---|---|---|')
  for (const it of r.taskbooks.items) {
    L.push(`| ${it.role} | ${fmt(it.total.codepoints)} | ${fmt(it.total.units)} | ${fmt(it.total.bytes)} | ${fmt(it.sectionCount)} |`)
  }
  L.push(`| **抽样合计** | **均值 ${fmt(r.taskbooks.totals.meanCodepoints)} / 最大 ${fmt(r.taskbooks.totals.maxCodepoints)}** | — | — | — |`)
  L.push('')
  L.push('分节明细（各角色任务书逐节码点）：')
  L.push('')
  for (const it of r.taskbooks.items) {
    L.push(`**${it.role}**：${it.sections.map((s) => `${s.title}=${fmt(s.codepoints)}`).join('｜')}`)
    L.push('')
  }
  return L.join('\n')
}

// ── selftest（解析类断言 ≥3 元素输入；断言鉴别力①条款）──────────────────────

function selftest() {
  const results = []
  const t = (name, fn) => {
    try {
      fn()
      results.push(['PASS', name, ''])
    } catch (err) {
      results.push(['FAIL', name, err.message])
    }
  }
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
  }

  t('metrics 三口径（含代理对 emoji：码点≠码元）', () => {
    eq(metrics('a你👍'), { codepoints: 3, units: 4, bytes: 8 }, '三口径计数')
  })
  t('collectDescriptions ≥3 元素嵌套收集', () => {
    const schema = {
      type: 'object',
      description: '顶层描述',
      properties: {
        a: { type: 'string', description: '参数A' },
        b: { type: 'object', properties: { c: { type: 'string', enum: ['x'], description: '嵌套C' } } },
      },
      items: [{ type: 'string', description: '数组项' }],
    }
    eq(collectDescriptions(schema), ['顶层描述', '参数A', '嵌套C', '数组项'], '四条描述全收集且有序')
  })
  t('splitFrontmatter 解析夹具 ≥3（双引号/裸值/emoji 值）', () => {
    eq(splitFrontmatter('---\nname: x\ndescription: "你好 world"\n---\n正文').meta.description, '你好 world', '双引号')
    eq(splitFrontmatter('---\ndescription: 裸值\n---\n正文').meta.description, '裸值', '裸值')
    eq(splitFrontmatter('---\ndescription: "a👍b"\n---\n正文').meta.description, 'a👍b', 'emoji 值')
  })
  t('splitSections 分节夹具（3 节 + preamble）', () => {
    const text = ['# 标题', '', '头部文本', '', '## 一、甲', '甲正文', '', '## 二、乙', '乙正文', '续行'].join('\n')
    const secs = splitSections(text)
    eq(secs.length, 3, '节总数（preamble+2）')
    eq(secs[0].title, '(preamble 头部)', 'preamble 标题')
    eq(metrics(secs[1].text).codepoints, metrics(['## 一、甲', '甲正文', ''].join('\n')).codepoints, '第一节内容')
    eq(metrics(secs[2].text).codepoints, metrics(['## 二、乙', '乙正文', '续行'].join('\n')).codepoints, '第二节内容')
  })
  t('描述串空集兜底（无 description 的 schema → 空数组不崩）', () => {
    eq(collectDescriptions({ type: 'object', properties: { x: { type: 'string' } } }), [], '空收集')
  })

  // ── 面B fail-closed 负向自测（2026-10-25 P1-2 注入必红；断言鉴别力②）──────────
  // 变异体映射：assertSkillCaliber 去掉 failures 臂 → 「坏文件凑足」用例红；
  //             去掉数量臂 → 「数量≠口径」用例红；measureSkills 解析坏 → 正例用例红。
  const mkSkillDir = (entries) => {
    const dir = mkdtempSync(join(tmpdir(), 'mis-selftest-'))
    for (const [id, desc] of entries) {
      mkdirSync(join(dir, id), { recursive: true })
      const fm = desc === null ? '---\nname: x\n---\n正文' : `---\nname: ${id}\ndescription: "${desc}"\n---\n正文`
      writeFileSync(join(dir, id, 'SKILL.md'), fm, 'utf8')
    }
    return dir
  }
  t('measureSkills 夹具 ≥3 元素（合法目录全收集、合计=逐条码点和）', () => {
    const dir = mkSkillDir([['skill-a', '描述A'], ['skill-b', '描述B'], ['skill-c', '描述C']])
    try {
      const r = measureSkills(dir)
      eq(r.items.length, 3, '三条全收集')
      eq(r.failures, [], '零失败')
      eq(r.totals.codepoints, [...'描述A'].length + [...'描述B'].length + [...'描述C'].length, '合计=三条码点和')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  t('坏 SKILL.md + 合法数凑足必须红（fail-open 洞注入必红，P1-2）', () => {
    const valid = Array.from({ length: EXPECT.skills }, (_, i) => [`skill-${i}`, `描述${i}`])
    const dir = mkSkillDir([...valid, ['skill-bad', null]]) // 26 目录：25 合法 + 1 坏（description 缺失）
    try {
      const r = measureSkills(dir)
      eq(r.items.length, EXPECT.skills, '合法数恰好凑足口径（旧实现在此 exit 0）')
      eq(r.failures.length, 1, '坏文件被记录进 failures')
      let threw = false
      try { assertSkillCaliber(r) } catch { threw = true }
      if (!threw) throw new Error('含坏文件时 assertSkillCaliber 未抛——fail-open 洞回归（必须红）')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  t('数量 ≠ 口径必须红（fail-closed 数量臂保持）', () => {
    const valid = Array.from({ length: EXPECT.skills - 1 }, (_, i) => [`skill-${i}`, `描述${i}`])
    const dir = mkSkillDir(valid) // 24 合法 < 口径 25
    try {
      const r = measureSkills(dir)
      let threw = false
      try { assertSkillCaliber(r) } catch { threw = true }
      if (!threw) throw new Error('数量≠口径时 assertSkillCaliber 未抛（必须红）')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  t('parseArgs 尾参缺值必须报用法错误（退出码 2 契约，P2-3）', () => {
    const saved = process.exitCode
    try {
      eq(parseArgs(['--json']), null, '--json 末参无值 → null（用法错误）')
      eq(parseArgs(['--diff']), null, '--diff 末参无值 → null（--diff 被吞会让用户误以为跑过对比）')
      eq(parseArgs(['--json', 'out.json']).json, 'out.json', '带值正常解析')
      eq(parseArgs(['--selftest']).selftest, true, '布尔旗标不受影响')
    } finally {
      process.exitCode = saved // 负向用例的退出码副作用不外溢到自测进程（否则 9/9 PASS 也 exit 2）
    }
  })

  const failed = results.filter((r) => r[0] === 'FAIL')
  for (const [status, name, msg] of results) console.log(`[selftest] ${status}  ${name}${msg ? `  ←  ${msg}` : ''}`)
  console.log(`[selftest] ${results.length - failed.length}/${results.length} PASS`)
  return failed.length === 0
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { json: null, report: null, samples: null, diff: null, selftest: false }
  const WITH_VALUE = { '--json': 'json', '--report': 'report', '--samples': 'samples', '--diff': 'diff' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') { opts.selftest = true; continue }
    const key = WITH_VALUE[a]
    if (key) {
      const v = argv[++i]
      if (v === undefined) {
        // 2026-10-25 P2-3（security R1）：值缺失此前被静默吞掉（undefined → falsy → 分支跳过），
        // 尤其 --diff 被吞会让用户误以为跑过 ±0 对比——恢复「2=用法错误」契约。
        console.error(`[用法错误] ${a} 需要一个值（收到末参，值缺失）`)
        process.exitCode = 2
        return null
      }
      opts[key] = v
      continue
    }
    console.error(`[用法错误] 未知参数 ${a}`)
    process.exitCode = 2
    return null
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts === null) return false
  if (opts.selftest) {
    const ok = selftest()
    if (!ok) process.exitCode = 1 // 自测失败必须非零退出（2026-10-25 变异体测试暴露：旧实现 FAIL 只打印不置码，闸门 fail-open）
    return ok
  }

  const readings = buildReadings(opts.samples || null)

  const json = JSON.stringify(readings, null, 2)
  if (opts.json) writeFileSync(opts.json, json, 'utf8')

  if (opts.diff) {
    const prev = JSON.parse(readFileSync(opts.diff, 'utf8'))
    const diffs = diffReadings(prev, readings)
    if (diffs.length === 0) console.log(`[diff] ±0 判定：DRIFT=0（与 ${opts.diff} 全字段相等，meta.measuredAt 除外）`)
    else {
      console.error(`[diff] 漂移 ${diffs.length} 处：`)
      for (const d of diffs) console.error(`  - ${d}`)
      process.exitCode = 1
    }
  }

  const report = renderReport(readings, opts.samples || null)
  if (opts.report) writeFileSync(opts.report, report, 'utf8')

  const tt = readings.tools.totals
  const st = readings.skills.totals
  const pt = readings.personas.totals
  console.log('[A1 注入面基线读数·摘要（主口径=码点）]')
  console.log(`  面A 工具面   合计 ${fmt(tt.codepoints)} 码点 / ${fmt(tt.units)} 码元 / ${fmt(tt.bytes)} 字节（${fmt(readings.tools.descCount)} 条描述串）`)
  console.log(`  面B 技能面   合计 ${fmt(st.codepoints)} 码点 / ${fmt(st.units)} 码元 / ${fmt(st.bytes)} 字节（${fmt(readings.skills.items.length)} 条 frontmatter description）`)
  console.log(`  面C persona  合计 ${fmt(pt.codepoints)} 码点 / ${fmt(pt.units)} 码元 / ${fmt(pt.bytes)} 字节（${fmt(readings.personas.items.length)} 文件；checklists ${fmt(readings.personas.excluded.count)} 文件不在口径）`)
  console.log(`  面D 任务书面 均值 ${fmt(readings.taskbooks.totals.meanCodepoints)} / 最大 ${fmt(readings.taskbooks.totals.maxCodepoints)} 码点（${fmt(readings.taskbooks.items.length)} 角色抽样，C-11 不瘦身）`)
  if (opts.json) console.log(`  JSON → ${opts.json}`)
  if (opts.report) console.log(`  报告节 → ${opts.report}`)
  if (opts.samples) console.log(`  样本 → ${opts.samples}/`)
  return process.exitCode !== 1
}

// 2026-10-25 P2-7：补 import guard（与 zstd-read.mjs/measure-decay.mjs 同款）——
// 被测试/工具 import 复用 metrics/collectDescriptions/splitSections 时不再整场测量。
// 退出码在 main 内部设置（1=漂移/断言失败，2=用法错误）；不调 process.exit 以保 stdout 排空。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
