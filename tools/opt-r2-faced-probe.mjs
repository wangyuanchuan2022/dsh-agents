/**
 * opt-r2 面 D 前后读数探针（A1 设计 §4.1 步骤 1；2026-10-26 R2 P2 修复批移入 tools/
 * 跟踪面——正本「净注入不增长随 commit 复跑」的复跑口径入口，gitignored agent-out/
 * 内对外部 clone 不可达，CODE-P2-7）。
 *
 * 口径 = opt-r1-baseline.md 面 D 同款：composeTaskbook 直调，三角色 explore/executor/analyst ×
 * 同一任务文本（tools/measure-injection-surface.mjs 的 SAMPLE_TASK 逐字），interactive 最小输入；
 * 分节 = tools/measure-injection-surface.mjs 导出的 splitSections（零口径漂移），度量 = 同文件 metrics。
 *
 * 双口径（A1 设计 3.1）：
 *   - 全任务书 = 总码点（−15% 记录值口径）
 *   - 口径B（模板态）= 头部 + §五 + §六 + §七 + §八 + §四 内「### 本次参数」块模板行
 *     （before 无参数块 ⇒ 口径B = 头部 + 四节；「### 本次参数」行后内容整体视为模板行——
 *      min-input 形态下参数块不含调用方文本，deliverable/acceptance 缺省不渲染）
 *
 * 用法：node tools/opt-r2-faced-probe.mjs <输出.json 路径>
 *   输出路径**必填**（缺参 exit 2）——废除「无参默认写 opt-r2-faced-before.json」：
 *   默认路径曾把历史基线读数静默覆盖（2026-10-26 基线覆盖事故根因），读数落盘必须显式指定。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../lib/index.js'
import { getRole } from '../lib/roles.js'
import { loadPersona } from '../lib/persona.js'
import { resolveRoute, TIER_INTENT } from '../lib/routing.js'
import { composeTaskbook } from '../lib/taskbook.js'
import { splitSections, metrics } from './measure-injection-surface.mjs'

const SAMPLE_ROLES = ['explore', 'executor', 'analyst']
const SAMPLE_TASK = '梳理 tools 目录脚本的用途清单，输出一页 markdown 索引；只读不改文件。'
const STATIC_FOUR = ['五、交付与验收', '六、澄清模式', '七、汇报与回收核对', '八、Claude Code → DSH 工具映射']
const outPath = process.argv[2]
if (!outPath) {
  console.error('用法: node tools/opt-r2-faced-probe.mjs <输出.json 路径>\n输出路径必填（缺参 exit 2）——无参默认写 opt-r2-faced-before.json 已废除（防基线读数被静默覆盖）。')
  process.exit(2)
}

function extractParamsTemplate(sectionText) {
  const idx = sectionText.indexOf('### 本次参数')
  return idx >= 0 ? sectionText.slice(idx) : ''
}

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
  const sections = splitSections(text).map((sec) => ({ title: sec.title, text: sec.text, ...metrics(sec.text) }))
  const head = sections[0]
  const four = sections.filter((s) => STATIC_FOUR.some((k) => s.title.includes(k)))
  if (four.length !== 4) throw new Error(`面D：${id} 静态四节定位失败（命中 ${four.length}）：${sections.map((s) => s.title).join(' | ')}`)
  const paramsTpl = extractParamsTemplate(sections.find((s) => s.title.includes('四、本次任务'))?.text ?? '')
  const caliberB = {
    codepoints: head.codepoints + four.reduce((n, s) => n + s.codepoints, 0) + [...paramsTpl].length,
    parts: {
      head: head.codepoints,
      four: Object.fromEntries(four.map((s) => [s.title, s.codepoints])),
      paramsTemplate: [...paramsTpl].length,
    },
  }
  items.push({
    role: id, tier: route.tier, provider: route.provider, model: route.model,
    total: metrics(text), sectionCount: sections.length, sections, caliberB,
  })
}

const mean = (f) => Math.round(items.reduce((n, it) => n + f(it), 0) / items.length)
const readings = {
  meta: {
    script: 'tools/opt-r2-faced-probe.mjs',
    sampleTask: SAMPLE_TASK,
    sampleTaskCodepoints: [...SAMPLE_TASK].length,
    clarifyMode: 'interactive',
    caliberNote: '全任务书=总码点；口径B=头部+静态四节+本次参数块模板行（A1 设计 3.1，防搬家虚胖判定口径）',
  },
  items,
  totals: {
    meanTotalCodepoints: mean((it) => it.total.codepoints),
    maxTotalCodepoints: Math.max(...items.map((it) => it.total.codepoints)),
    meanCaliberB: mean((it) => it.caliberB.codepoints),
  },
}
writeFileSync(outPath, JSON.stringify(readings, null, 2), 'utf8')
console.log(`[faced-probe] ${outPath}`)
for (const it of items) {
  const p = it.caliberB.parts
  const byKey = (k) => Object.entries(p.four).find(([t]) => t.includes(k))?.[1] ?? '?'
  console.log(`  ${it.role} (${it.tier}): total=${it.total.codepoints} 口径B=${it.caliberB.codepoints} (head=${p.head} five=${byKey('五、')} six=${byKey('六、')} seven=${byKey('七、')} eight=${byKey('八、')} params=${p.paramsTemplate})`)
}
console.log(`  mean total=${readings.totals.meanTotalCodepoints} max=${readings.totals.maxTotalCodepoints} mean 口径B=${readings.totals.meanCaliberB}`)
