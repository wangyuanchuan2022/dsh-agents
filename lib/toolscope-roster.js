/**
 * roster 策略数据层（R3-B1 S3）：两层策略源的**层 1**——
 *   policies/toolscope-roster.json  手写基表（version/coreBase/classMap/
 *                                   familyKeywords/scanIgnore/pinnedHostVersion/
 *                                   retention/presets 双预置档）
 *   policies/toolscope-roles.json   机产 per-role 表（tools/scan-role-toolrefs.mjs
 *                                   扫 23 角色人格＋任务书模板静态面生成）
 *
 * 语义（设计 §2.2/V2-3，组织者任务书钉死）：
 *   - 运行期 needed = coreBase ∪ roster[role] ∪ 任务正文引用（族表映射；
 *     不判定的形态不收；裸名词不猜记缺口）——decideToolscope 消费；
 *   - 缺角色 fail-open 不收缩（roles 文件缺该角色 ⇒ skip）；
 *   - 数据损坏 fail-open 且不静默（loader 返回 error，由接线方响亮留痕，M7 精神）；
 *   - 双预置档名单数据化（eval-coding/read-only），MINIMAL_TOOLSET_FULL 占位
 *     名单按 P1 结论校准后转正——eval-coding.tools 与 lib/toolscope.js 的
 *     MINIMAL_TOOLSET_FULL 常量由 run.mjs 漂移门钉死相等（单一事实源=本数据文件）。
 *
 * 构建期扫描核（scanRoleReferences）扫描面＝设计 §2.2 点名的三节：
 *   人格正文 ＋ §七汇报条目（reportLines/fewShotLines，按角色档位）＋ 只读白名单节。
 *   不扫 §五/§六/本次参数——那些是跨角色通用模板面（「产出用 write 落盘」类
 *   输出指令对任何角色都渲染，收进 per-role 表会让收缩永不生效）。
 * 检测器＝宽松检测器（looseToolRefs，子串全量＋否定语境豁免）＋ scanIgnore
 *   数据名单（de_session 在 §七里以「组织者以 de_session 核对」的组织者语境
 *   出现，不是会话自身需求；真实需要经任务正文反引号显式引用获得保护）。
 *
 * @module dsh-agents/toolscope-roster
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPersona } from './persona.js'
import { reportLines, fewShotLines, readonlyToolSection } from './taskbook.js'
import { looseToolRefs, classMapNames } from './toolscope-pipeline.js'

/** 策略数据目录（随插件分发；相对本模块解析，装机副本同构）。 */
export const POLICY_DIR = fileURLToPath(new URL('../policies/', import.meta.url))

export const ROSTER_BASE_FILE = 'toolscope-roster.json'
export const ROSTER_ROLES_FILE = 'toolscope-roles.json'

/** roster 基表形状校验（结构错返回错误串，不抛——损坏走 fail-open 不静默）。 */
function validateBase(base) {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return '基表不是对象'
  if (!Number.isFinite(base.version)) return 'version 缺失'
  if (!Array.isArray(base.coreBase) || base.coreBase.length === 0 || base.coreBase.some((n) => typeof n !== 'string')) {
    return 'coreBase 必须是非空字符串数组'
  }
  if (base.classMap === null || typeof base.classMap !== 'object' || Array.isArray(base.classMap)) {
    return 'classMap 必须是对象'
  }
  for (const [family, members] of Object.entries(base.classMap)) {
    if (!Array.isArray(members) || members.some((n) => typeof n !== 'string')) return `classMap.${family} 必须是字符串数组`
  }
  if (base.presets !== undefined) {
    if (base.presets === null || typeof base.presets !== 'object' || Array.isArray(base.presets)) return 'presets 必须是对象'
    for (const [id, preset] of Object.entries(base.presets)) {
      if (!Array.isArray(preset?.tools) || preset.tools.length === 0 || preset.tools.some((n) => typeof n !== 'string')) {
        return `presets.${id}.tools 必须是非空字符串数组`
      }
    }
  }
  if (base.scanIgnore !== undefined && (!Array.isArray(base.scanIgnore) || base.scanIgnore.some((n) => typeof n !== 'string'))) {
    return 'scanIgnore 必须是字符串数组'
  }
  if (base.familyKeywords !== undefined) {
    if (typeof base.familyKeywords !== 'object' || base.familyKeywords === null) return 'familyKeywords 必须是对象'
    for (const [family, words] of Object.entries(base.familyKeywords)) {
      if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) return `familyKeywords.${family} 必须是字符串数组`
    }
  }
  return null
}

/**
 * 加载 roster 数据（两文件都同步读；任何损坏/缺失都降级为可用子集+error 留痕，
 * 绝不抛——调用方按 error 响亮告警后继续跑 fail-open）。
 *
 * @param {string} [policyDir] - 数据目录（缺省 POLICY_DIR；测试注入 fixture 目录）
 * @param {{ readFileSync?: Function, existsSync?: Function }} [io] - 可注入 IO（测试用）
 * @returns {{ base: object|null, roles: object, rolesMeta: object|null, presets: object|null,
 *             roster: object|null, error: string|null }}
 *   roster = 合并视图 { ...base, roles }，base 损坏时为 null（管线 role 轨全 fail-open）。
 */
export function loadRosterData(policyDir = POLICY_DIR, io = {}) {
  const readFile = io.readFileSync ?? readFileSync
  const existsSync = io.existsSync ?? ((p) => {
    try { readdirSync(p); return true } catch { return false }
  })
  const out = { base: null, roles: {}, rolesMeta: null, presets: null, roster: null, error: null }
  // ① 基表
  const basePath = join(policyDir, ROSTER_BASE_FILE)
  try {
    const base = JSON.parse(readFile(basePath, 'utf8'))
    const invalid = validateBase(base)
    if (invalid) {
      out.error = `${ROSTER_BASE_FILE}：${invalid}`
    } else {
      out.base = base
      out.presets = base.presets ?? null
    }
  } catch (error) {
    out.error = `${ROSTER_BASE_FILE} 读取/解析失败：${error?.message ?? error}`
  }
  // ② 机产 per-role 表（缺失只降级不致命：全角色 fail-open，G11 报告披露）
  const rolesPath = join(policyDir, ROSTER_ROLES_FILE)
  try {
    const parsed = JSON.parse(readFile(rolesPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.roles === 'object' && parsed.roles !== null) {
      for (const [id, names] of Object.entries(parsed.roles)) {
        if (Array.isArray(names) && names.every((n) => typeof n === 'string')) out.roles[id] = names
      }
      out.rolesMeta = { generatedAt: parsed.generatedAt ?? null, generator: parsed.generator ?? null, rosterVersion: parsed.rosterVersion ?? null }
    } else {
      out.error = out.error ?? `${ROSTER_ROLES_FILE}：形状不合法（缺 roles 对象）`
    }
  } catch (error) {
    out.error = out.error ?? `${ROSTER_ROLES_FILE} 读取/解析失败：${error?.message ?? error}`
  }
  out.roster = out.base ? { ...out.base, roles: out.roles } : null
  return out
}

/**
 * 构建期扫描核（纯函数；CLI 与 run.mjs 漂移门共用同一实现，杜绝两套口径）：
 * 扫描面 = 人格正文 ＋ §七汇报条目（按角色档位）＋ 只读白名单节（readonly 席），
 * 检测器 = 宽松检测器（否定语境豁免）− scanIgnore。
 *
 * @param {object} role - roles.js 角色条目
 * @param {object} base - roster 基表（classMap/coreBase/scanIgnore）
 * @param {{ personaText?: string }} [opts] - persona 注入（缺省 loadPersona(role)）
 * @returns {{ rostered: string[], unclassified: string[] }}
 *   rostered=入表引用；unclassified=反引号显式提及但不在 classMap∪coreBase 宇宙的
 *   名单（不猜记缺口，但 G11 报告披露，供 classMap 数据维护者增补）。
 */
export function scanRoleReferences(role, base, opts = {}) {
  const personaText = opts.personaText ?? loadPersona(role).text
  const face = [
    personaText,
    ...reportLines(role.tier),
    ...fewShotLines(role.tier),
    ...readonlyToolSection(role),
  ].join('\n')
  const universe = new Set([...classMapNames(base.classMap), ...base.coreBase])
  const ignore = new Set(base.scanIgnore ?? [])
  const rostered = looseToolRefs(face, universe).filter((name) => !ignore.has(name))
  const backticked = [...new Set([...face.matchAll(/`([A-Za-z][A-Za-z0-9_-]*)`/g)].map((m) => m[1]))]
  // 反引号显式提及且通过否定语境豁免的名单（unclassified 只在其中找，防注释性文字误报）。
  const mentioned = new Set(looseToolRefs(face, backticked))
  const unclassified = backticked
    .filter((name) => !universe.has(name) && mentioned.has(name))
    .sort()
  return { rostered: [...new Set(rostered)].sort(), unclassified }
}

/**
 * G11 构建期 per-role 覆盖率报告（M12 首版覆盖披露 + AC2-11 未入库角色清单）。
 *
 * @param {object} input
 * @param {Array<object>} input.roles - 全部角色（roles.js ROLES）
 * @param {object} input.base - roster 基表
 * @param {object} input.roleTable - 机产 per-role 表（{ roleId: names[] }）
 * @param {string} input.generatedAt - 扫描时刻（ISO）
 * @returns {{ lines: string[], missingRoles: string[] }} markdown 行与未入库角色清单
 */
export function buildCoverageReport({ roles, base, roleTable, generatedAt }) {
  const lines = []
  const missingRoles = []
  let totalRefs = 0
  let totalUnclassified = 0
  lines.push('# G11 · toolscope 构建期 per-role 覆盖率报告')
  lines.push('')
  lines.push(`- 生成：${generatedAt} · 生成器：tools/scan-role-toolrefs.mjs（纯核 lib/toolscope-roster.js scanRoleReferences）`)
  lines.push(`- roster 基表版本：${base.version} · coreBase：${base.coreBase.join(', ')} · pinnedHostVersion：${base.pinnedHostVersion ?? '（未钉）'}`)
  lines.push('- 扫描面：人格正文 ＋ 任务书 §七汇报条目 ＋ 只读白名单节（设计节 2.2 点名三节）；检测器：宽松检测器（否定语境豁免）− scanIgnore')
  lines.push('- 缺口口径：unclassified = 反引号显式提及但不在 classMap 宇宙（不猜记缺口，披露待增补）；裸名词不猜为设计语义')
  lines.push('')
  lines.push('| 角色 | 档位 | 表内引用数 | 引用 | 未归类反引号 |')
  lines.push('|---|---|---|---|---|')
  for (const role of roles) {
    const entry = roleTable[role.id]
    if (!Array.isArray(entry)) {
      missingRoles.push(role.id)
      lines.push(`| ${role.id} | ${role.tier} | —（未入库，运行期 fail-open 不收缩） | — | — |`)
      continue
    }
    const { unclassified } = scanRoleReferences(role, base)
    totalRefs += entry.length
    totalUnclassified += unclassified.length
    lines.push(`| ${role.id} | ${role.tier} | ${entry.length} | ${entry.length > 0 ? entry.join('、') : '（无）'} | ${unclassified.length > 0 ? unclassified.join('、') : '—'} |`)
  }
  lines.push('')
  lines.push(`- 覆盖：${roles.length - missingRoles.length}/${roles.length} 角色入库；表内引用总计 ${totalRefs}；未归类反引号总计 ${totalUnclassified}`)
  if (missingRoles.length > 0) {
    lines.push(`- ⚠️ 未入库角色（运行期 fail-open 不收缩）：${missingRoles.join('、')}`)
  }
  if (totalUnclassified > 0) {
    lines.push('- 增补路径：把未归类名单补进 policies/toolscope-roster.json 的 classMap → 重跑 `node tools/scan-role-toolrefs.mjs` → 重跑门线')
  }
  lines.push('- 漂移同步：人格/模板变更后重跑扫描脚本；run.mjs 漂移门（roles 文件 vs 内存重扫 deep-equal）会先行拦红')
  return { lines, missingRoles }
}

/**
 * roster pinnedHostVersion 与运行时宿主版本比对（V3-5/M11 触发机制）。
 * @returns {'match'|'mismatch'|'unknown'} unknown=任一侧不可得（不告警不豁免，G11 披露）
 */
export function compareHostVersion(pinned, actual) {
  if (typeof pinned !== 'string' || pinned.trim() === '' || typeof actual !== 'string' || actual.trim() === '') return 'unknown'
  return pinned.trim() === actual.trim() ? 'match' : 'mismatch'
}

/**
 * 死会话策略文件有界留存清扫（V3-5/M13，advisor seen.json 同款精神）：
 * 按 mtime 新→旧保留 maxFiles 份**死会话**文件；活会话（keep 集）永不清理。
 * 纯函数形态便于单测（fs 全注入）。
 *
 * @param {object} input
 * @param {string[]} input.files - 会话目录里的 *.toolscope.json 文件名（不含路径）
 * @param {(name: string) => number} input.mtimeOf - 文件 mtime（ms）
 * @param {(name: string) => string} input.sessionIdOf - 文件名反解 sessionId
 * @param {Set<string>} input.keep - 活会话 id 集
 * @param {number} input.maxFiles - 死会话保留上限
 * @returns {string[]} 应删除的文件名（调用方执行删除）
 */
export function planRetentionSweep({ files, mtimeOf, sessionIdOf, keep, maxFiles }) {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return []
  const dead = files
    .filter((f) => !keep.has(sessionIdOf(f)))
    .sort((a, b) => mtimeOf(b) - mtimeOf(a))
  return dead.slice(maxFiles)
}
