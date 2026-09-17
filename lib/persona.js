/**
 * 人格文件加载——personas/<id>.md。
 *
 * 约定：每个角色一个 markdown 文件，可选 frontmatter（role/version/source），
 * 正文即人格提示词。文件**不存在**时不报错，退化为「角色摘要模式」：只用
 * roles.js 的元数据（name/description/mission）组装人格段，并在任务书里
 * 明确标注「人格文件未安装」，让子会话知道自己的行为约束比完整版弱。
 *
 * 为什么要哈希：人格文件会被用户改（批准/修订），任务书头部带哈希前缀，
 * 事后能判断某个会话用的是哪一版人格。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** personas 目录（相对本模块，随插件一起分发）。 */
export const PERSONA_DIR = fileURLToPath(new URL('../personas/', import.meta.url))

/**
 * 剥掉可选的 YAML frontmatter（导出供单测），返回 { meta, body }。
 * A-P0-1：循环剥块——只要文本仍以 --- 围栏块开头就整块剥离，直至无。
 * 背景：安装器生成的头部之后，译文体内还内嵌着 OMC 原始 frontmatter
 * （name/model/level/disallowedTools），只剥首段会把第二段漏进任务书 §三，
 * 造成 19 份任务书「双模型声明」自相矛盾。meta 取首块为准（安装器溯源字段优先）。
 */
export function splitFrontmatter(raw) {
  let text = String(raw).replace(/^\uFEFF/, '')
  const meta = {}
  while (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end === -1) break // 围栏未闭合：按无 frontmatter 处理，余文原样作正文
    const head = text.slice(3, end)
    for (const line of head.split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
      if (m && meta[m[1]] === undefined) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    text = text.slice(end + 4).replace(/^[\r\n]+/, '')
  }
  return { meta, body: text.trim() }
}

/** 已安装人格文件清单（id → 字节数），agent_roles 体检与 README 用。 */
export function listPersonaFiles() {
  try {
    return readdirSync(PERSONA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => ({ id: entry.name.replace(/\.md$/i, ''), file: entry.name }))
  } catch {
    return [] // personas 目录缺失 = 尚未安装任何人格（角色摘要模式）
  }
}

/**
 * 加载一个角色的人格。
 * @param {object} role - roles.js 条目
 * @returns {{installed:boolean, text:string, hash:string|null, meta:object, file:string|null}}
 *   installed=false 时 text 为角色摘要（元数据拼接），hash=null。
 */
export function loadPersona(role) {
  const file = `${role.id}.md`
  let raw
  try {
    raw = readFileSync(new URL(`../personas/${file}`, import.meta.url), 'utf8')
  } catch {
    return {
      installed: false,
      file: null,
      hash: null,
      meta: {},
      text: [
        `（人格文件未安装）角色摘要：${role.name}——${role.description}。`,
        `职责边界：${role.mission}。`,
        '行为约束以本任务书列出的条款为准；不得自行扩大职责范围。',
      ].join('\n'),
    }
  }
  const { meta, body } = splitFrontmatter(raw)
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8).toUpperCase()
  return { installed: true, file, hash, meta, text: body }
}
