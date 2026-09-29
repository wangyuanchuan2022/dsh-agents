/**
 * 人格安装：把**已批准**的译文（review/trans/<id>.md）写入 personas/<id>.md。
 *
 * 批准纪律（用户 2026-09-12 要求）：人格逐篇批准后才写入——本脚本默认只处理
 * 白名单里的 id，白名单由 tools/approved.json 给出（{"approved": ["executor", ...]}，
 * 或 "all" 表示全部批准）。没有白名单 = 什么都不写（fail-closed）。
 *
 * 写入内容 = 译文文件的正文（**剥掉审阅用的头部与收尾两节**，只保留「## 译文」
 * 小节——终止条件只认 `## 适配清单` / `## 译制说明`，B-P0-1），加上 frontmatter
 * （role/tier/omc/source/hash 溯源）。安装期对每篇做「提取段标签计数 == 译文段
 * 标签计数」断言，不等即 exit 1 且不落盘。
 *
 * 装配期两级断言（批次3 IMP-26c，D-5 流程防线；判据在 lib/persona-gate.js，
 * 与 tools/verify-imp26.mjs 负向自测共用同一份代码）：
 *  ① 注入基线节（Prompt Defense Baseline）——LEGACY_OMC_IDS 之外的角色缺失
 *     即 fail loudly 拒装（exit 1 且不落盘任何人格，报文件名）；OMC 历史集
 *     （19 篇，无该节）豁免。
 *  ② 「## 不做什么」节缺失 → 打印装配警告，继续装配（非阻断——历史 persona
 *     兼容；警告走 stderr）。
 *
 * 用法：node tools/install-personas.mjs [--dry-run]
 * 测试接缝：设 INSTALL_PERSONAS_ROOT=<dir> 可把安装根重定向到 fixture 树
 *（负向自测 tools/verify-imp26.mjs 用）；缺省 = 本仓库根，行为不变。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { ROLES, getRole } from '../lib/roles.js'
import { personaGateFindings } from '../lib/persona-gate.js'

// 测试接缝（IMP-26c）：INSTALL_PERSONAS_ROOT 重定向安装根（verify-imp26 用）；
// 未设时 = 仓库根，行为与原先逐字节一致。
const ROOT = process.env.INSTALL_PERSONAS_ROOT
  ? process.env.INSTALL_PERSONAS_ROOT
  : dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '')
const TRANS = join(ROOT, 'review', 'trans')
const PERSONAS = join(ROOT, 'personas')
const APPROVED = join(ROOT, 'tools', 'approved.json')
const dryRun = process.argv.includes('--dry-run')

/** 读取批准白名单；文件不存在或格式不对 = 没有批准任何篇（fail-closed）。 */
function readApproved() {
  if (!existsSync(APPROVED)) return null
  try {
    const parsed = JSON.parse(readFileSync(APPROVED, 'utf8'))
    if (parsed === 'all') return 'all'
    if (Array.isArray(parsed?.approved)) return parsed.approved.map((id) => String(id).trim()).filter((id) => id !== '')
  } catch {
    return null // 白名单读不出来：按"未批准"处理，绝不误装
  }
  return null
}

/** 从对照稿里取出「## 译文」小节正文（去掉审阅用章节）。
 * B-P0-1：终止条件只认行首 `## 适配清单` / `## 译制说明` 两个收尾小节名——
 * 旧的「第一个行首 `## ` 行」会命中译文内部的小节标题（如 document-specialist
 * Output_Format 里的 `## 调研：[查询]`），把已部署人格静默截断（28→16 标签）。 */
const SECTION_END = /^##\s*(适配清单|译制说明)\s*$/

function extractPersonaBody(text) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s*译文\s*$/.test(line.trim()))
  if (start === -1) return null // 格式不符规范：不猜，报错让译者修
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_END.test(lines[i].trim())) { end = i; break }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

/** 剥掉译文段开头内嵌的 OMC 原始 frontmatter（可连续多块）——双 frontmatter 根除
 * （A-P0-1 文件层修复）：安装器头部之外，personas 文件不得再携带第二段 frontmatter。
 * 与 lib/persona.js 的 splitFrontmatter 同规则；运行时循环剥块保留作兜底。 */
function stripLeadingFrontmatter(text) {
  let t = String(text)
  while (t.startsWith('---')) {
    const end = t.indexOf('\n---', 3)
    if (end === -1) break
    t = t.slice(end + 4).replace(/^[\r\n]+/, '')
  }
  return t.trim()
}

/** 段标签（<Tag> / </Tag>）出现次数——安装期断言用。 */
function countXmlTags(text) {
  return (String(text).match(/<\/?[A-Za-z][\w-]*>/g) ?? []).length
}

/** 安装期断言的对照面：按 BRIEF 文件格式定义，用整文正则独立切出「## 译文」段
 *（与 extractPersonaBody 的逐行正向扫描不同实现路径）。若提取器回归成「首个行首
 * `## ` 截断」或漏切，两侧标签计数必然不等（B-P0-1 的 document-specialist 缺陷
 * 28≠16 可被 100% 捕获）。返回 null = 对照面切不出（格式问题由提取分支兜底）。 */
function transPersonaRegionTags(text) {
  const m = /^##\s*译文\s*$([\s\S]*?)(?=^##\s*(?:适配清单|译制说明)\s*$)/m.exec(String(text))
  return m === null ? null : countXmlTags(m[1])
}

const approved = readApproved()
if (approved === null || (approved !== 'all' && approved.length === 0)) {
  console.log('[install-personas] 没有批准白名单（tools/approved.json）——按 fail-closed 不写入任何人格。')
  process.exit(0)
}

mkdirSync(PERSONAS, { recursive: true })
let installed = 0
let warned = 0
const skipped = []
// 两遍式（B-P0-1 安装期断言「不等即 exit 1 且不落盘」）：先全部解析并断言，
// 全部通过后才统一写盘——任何一篇失败都不会留下半更新的 personas。
const pending = []
for (const role of ROLES) {
  if (approved !== 'all' && !approved.includes(role.id)) { skipped.push(`${role.id}(未批准)`); continue }
  if (role.id === 'code-reviewer' && process.env.OCR_V1_REINSTALL !== '1') {
    skipped.push(`${role.id}(v1 已弃用，强制重装设 OCR_V1_REINSTALL=1)`)
    console.error('[install-personas] SKIP code-reviewer：OMC v1 人格已于 2026-09-24 弃用（由 v2「OCR 确定性工程融合版」取代，现行 v2.2 整文件哈希 AE04C1CA）。')
    console.error('[install-personas]   v2 由 ocr-analysis/code-reviewer-v2/staging 管理与部署（staging→verify→拷部署位→SHA256 比对），不经本工具。')
    console.error('[install-personas]   如确需回滚安装 v1（不推荐）：设环境变量 OCR_V1_REINSTALL=1 后重跑本工具。')
    continue
  }
  const transPath = join(TRANS, `${role.id}.md`)
  if (!existsSync(transPath)) { skipped.push(`${role.id}(无译文)`); continue }
  const transText = readFileSync(transPath, 'utf8')
  const extracted = extractPersonaBody(transText)
  if (extracted === null) { skipped.push(`${role.id}(译文缺「## 译文」小节)`); continue }
  const body = stripLeadingFrontmatter(extracted)
  const bodyTags = countXmlTags(body)
  const regionTags = transPersonaRegionTags(transText)
  if (regionTags !== null && bodyTags !== regionTags) {
    console.error(`[install-personas] 安装期断言失败：${role.id} 段标签计数不一致（提取 ${bodyTags} ≠ 译文段 ${regionTags}）——提取器疑似在译文内部小节截断，exit 1 且不落盘任何人格。`)
    process.exit(1)
  }
  // 装配期两级断言（IMP-26c）：error=拒装并报文件名；warn=装配警告（非阻断）。
  for (const finding of personaGateFindings(role.id, body)) {
    if (finding.level === 'error') {
      console.error(`[install-personas] 安装期断言失败：${role.id}（${transPath}）——${finding.message}；fail loudly 拒装，exit 1 且不落盘任何人格。`)
      process.exit(1)
    }
    warned += 1
    console.error(`[install-personas] 装配警告：${role.id}（${transPath}）——${finding.message}；继续装配（非阻断——历史 persona 兼容）。`)
  }
  const hash = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8).toUpperCase()
  pending.push({ role, body, hash })
}
for (const { role, body, hash } of pending) {
  const content = [
    '---',
    `role: ${role.id}`,
    `name: ${role.name}`,
    `tier: ${role.tier}`,
    `omc_model: ${role.omcModel}`,
    `level: ${role.level}`,
    `readonly: ${role.readonly}`,
    `source: oh-my-claudecode/agents/${role.id}.md (MIT)`,
    `approved: 2026-09-12`,
    `body_hash: ${hash}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
  if (dryRun) {
    console.log(`[dry-run] 将写入 personas/${role.id}.md（${body.length} 字符，hash ${hash}，段标签 ${countXmlTags(body)}）`)
  } else {
    writeFileSync(join(PERSONAS, `${role.id}.md`), content, 'utf8')
    console.log(`[install-personas] 已写入 personas/${role.id}.md（${body.length} 字符，hash ${hash}，段标签 ${countXmlTags(body)}）`)
  }
  installed += 1
}
console.log(`[install-personas] ${dryRun ? '预演' : '完成'}：${installed} 篇；跳过 ${skipped.length} 篇${skipped.length > 0 ? `（${skipped.join('、')}）` : ''}；装配警告 ${warned} 条`)
if (installed === 0) process.exit(0)
