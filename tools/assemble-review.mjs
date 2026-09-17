/**
 * 审批稿装配：把 19 个角色的「OMC 英文原文 + 中文 DSH 适配译文」拼成逐篇对照稿，
 * 供用户逐篇批准。产出：
 *   review/对照/<id>.md   单角色对照（原文逐字 + 译文）
 *   review/审批稿索引.md   总索引与完成度（哪篇已译、哪篇待译、体积）
 *
 * 用法：node tools/assemble-review.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLES } from '../lib/roles.js'

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '')
const REVIEW = join(ROOT, 'review')
const ORIGINAL = join(REVIEW, 'original')
const TRANS = join(REVIEW, 'trans')
const OUT = join(REVIEW, '对照')

mkdirSync(OUT, { recursive: true })

const rows = []
for (const role of ROLES) {
  const originalPath = join(ORIGINAL, `${role.id}.md`)
  const transPath = join(TRANS, `${role.id}.md`)
  const hasOriginal = existsSync(originalPath)
  const hasTrans = existsSync(transPath)
  const original = hasOriginal ? readFileSync(originalPath, 'utf8').trim() : ''
  const trans = hasTrans ? readFileSync(transPath, 'utf8').trim() : ''

  const lines = []
  lines.push(`# ${role.id} — ${role.name}（对照稿）`)
  lines.push('')
  lines.push(`- 档位：**${role.tier}**（OMC model: ${role.omcModel}，level ${role.level}）｜泳道：${role.lane}｜${role.readonly ? '只读角色' : '可写角色'}`)
  lines.push(`- 上游原文：\`review/original/${role.id}.md\`（oh-my-claudecode，MIT，${original.length} 字符）`)
  lines.push(`- 中文 DSH 适配版：${hasTrans ? `\`review/trans/${role.id}.md\`（${trans.length} 字符）` : '**尚未译制**'}`)
  lines.push('')
  lines.push(`> 批准后写入：\`personas/${role.id}.md\`（即下方「中文版」正文；如需修改请直接指出篇号与小节）`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 一、英文原文（逐字，未改动）')
  lines.push('')
  lines.push(original === '' ? '_（原文缺失）_' : original)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 二、中文版（忠实全译 + 就地 DSH 适配，待批准）')
  lines.push('')
  lines.push(trans === '' ? '_（待译：该篇尚未产出，可能仍在译制队列中）_' : trans)
  lines.push('')

  writeFileSync(join(OUT, `${role.id}.md`), lines.join('\n'), 'utf8')
  rows.push({ role, original: original.length, trans: trans.length, done: hasTrans })
}

const done = rows.filter((row) => row.done)
const index = []
index.push('# dsh-agents 人格审批稿索引')
index.push('')
index.push(`> 进度：**${done.length}/${rows.length}** 已译出中文版（装配时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}）`)
index.push('> 逐篇对照稿在 `review/对照/<id>.md`（英文原文在上、中文版在下）；批准后我把中文版写入 `personas/<id>.md` 并让插件生效。')
index.push('')
index.push('| # | 角色 | 档位 | 泳道 | 边界 | 原文 | 中文版 | 对照稿 |')
index.push('|---|---|---|---|---|---|---|---|')
rows.forEach((row, i) => {
  index.push(`| ${i + 1} | ${row.role.id} — ${row.role.name} | ${row.role.tier} | ${row.role.lane} | ${row.role.readonly ? '只读' : '可写'} | ${row.original} 字符 | ${row.done ? `${row.trans} 字符` : '**待译**'} | [打开](对照/${row.role.id}.md) |`)
})
index.push('')
index.push('## 批准方式')
index.push('')
index.push('- 全部通过：回一句「全部通过」；')
index.push('- 部分通过／要改：按「篇号 或 角色 id + 小节 + 改法」说，例如「critic 的 `Failure_Modes_To_Avoid` 删掉第 3 条」「explore 全文通过，writer 重写」；')
index.push('- 未批准的篇目保持「摘要模式」（插件不注入人格，只按任务书条款约束），已批准的先落地生效。')
index.push('')
writeFileSync(join(REVIEW, '审批稿索引.md'), index.join('\n'), 'utf8')

console.log(`[assemble-review] 对照稿 ${rows.length} 篇已生成；中文版完成度 ${done.length}/${rows.length}`)
for (const row of rows.filter((r) => !r.done)) console.log(`  pending: ${row.role.id}`)
