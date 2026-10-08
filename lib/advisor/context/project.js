/**
 * context/project.js —— **Project State 层**（三层装配的第二层）。
 *
 * 内容：项目阶段（`projectPhase`）+ 分支 / HEAD / 工作树脏度 / 最近提交。
 *
 * ## `projectPhase` 的口径（G-4）
 *
 * - **会话级配置键优先**（`sessionConfig.projectPhase`，见 `store.SESSION_CONFIG_KEYS`）；
 * - 未配置 ⇒ **本地规则启发**（`heuristicPhase`，**零模型调用**——用模型判阶段会让每轮
 *   多一次调用，与 AC-18 的零 token 断言正面冲突）；
 * - **非法值 fail-closed**（`assertPhase` 抛错，写路径上零落盘）。
 *
 * ## fail-open 边界
 *
 * git 不可用（非仓库 / 子进程失败）**不阻断本层**：该层照常输出，只是把
 * 「git 事实不可用」显式写出来（AC-4 的同源纪律：不可用必须显式，不静默省略）。
 *
 * @module dsh-agents/advisor/context/project
 */

/** 合法的阶段取值（G-4；非法值 fail-closed）。 */
export const PROJECT_PHASES = Object.freeze(['design', 'build', 'review', 'ship'])

/** 阶段来源（可观测；AC-19 的同源纪律）。 */
export const PHASE_SOURCE_SESSION = 'session-config'
export const PHASE_SOURCE_HEURISTIC = 'local-heuristic'
export const PHASE_SOURCE_UNAVAILABLE = 'unavailable'

/** 「不可用」标注前缀（AC-4）。 */
export const UNAVAILABLE_MARK = '不可用'

/** 阶段值合法化（非法 ⇒ 抛错；写路径上因此零落盘）。 */
export function assertPhase(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !PROJECT_PHASES.includes(value)) {
    throw new Error(`dsh-agents: projectPhase 必须是 ${PROJECT_PHASES.join(' / ')} 之一（收到 ${JSON.stringify(value)}）`)
  }
  return value
}

/** 测试文件/文档路径判定（本地规则，与检索面的 `isTestPath` 同源口径）。 */
function isTestOrDoc(rel) {
  return /(^|\/)(test|tests|__tests__|docs)\//.test(rel) || /\.(test|spec)\.[a-z0-9]+$/i.test(rel) || /\.md$/i.test(rel)
}

/**
 * **本地规则**推阶段（零模型、零 IO；输入是 git 事实 + 文件清单）。
 *
 * 规则（保守、可解释，顺序即优先级）：
 * 1. 无 git 事实 ⇒ `design`（还没进入版本控制 = 设计期）；
 * 2. 工作树有改动：**改动全落在测试/文档** ⇒ `review`；否则 ⇒ `build`；
 * 3. 工作树干净：最近提交里有 release/chore/version 字样或 tag ⇒ `ship`；否则 ⇒ `build`。
 *
 * @param {{gitFacts?:object|null, files?:Array<{rel:string}|string>}} input
 * @returns {{phase:string, reason:string}}
 */
export function heuristicPhase(input = {}) {
  const facts = input.gitFacts ?? null
  if (facts === null || typeof facts !== 'object') {
    return { phase: 'design', reason: '无 git 事实（尚未进入版本控制）' }
  }
  const statusPaths = Array.isArray(facts.statusPaths) ? facts.statusPaths : []
  if (statusPaths.length > 0) {
    const allTestOrDoc = statusPaths.every((p) => isTestOrDoc(String(p)))
    return allTestOrDoc
      ? { phase: 'review', reason: `工作树 ${statusPaths.length} 处改动全在测试/文档` }
      : { phase: 'build', reason: `工作树 ${statusPaths.length} 处改动含实现文件` }
  }
  const recent = Array.isArray(facts.recent) ? facts.recent : []
  const releaseish = recent.some((r) => /release|chore\(release\)|version|bump|v\d+\.\d+/i.test(String(r?.subject ?? '')))
  return releaseish
    ? { phase: 'ship', reason: '工作树干净且最近提交含发布/版本字样' }
    : { phase: 'build', reason: '工作树干净、无发布迹象' }
}

/**
 * 装配 Project State 层。
 *
 * @param {{gitFacts?:object|null, gitError?:object|null, phase?:string|null,
 *          files?:Array<{rel:string}|string>}} input
 * @returns {{available:boolean, phase:string|null, phaseSource:string, text:string, facts:object|null}}
 */
export function buildProjectState(input = {}) {
  const sessionPhase = assertPhase(input.phase ?? null)
  const heuristic = heuristicPhase({ gitFacts: input.gitFacts, files: input.files })
  const phase = sessionPhase ?? heuristic.phase
  const phaseSource = sessionPhase !== null
    ? PHASE_SOURCE_SESSION
    : (input.gitFacts == null ? PHASE_SOURCE_UNAVAILABLE : PHASE_SOURCE_HEURISTIC)
  const lines = ['### 项目状态（Project State）']
  lines.push(`- 阶段：${phase}（来源：${phaseSource}${sessionPhase === null ? `，启发规则：${heuristic.reason}` : '，会话级配置优先（G-4）'}）`)
  if (input.gitFacts == null) {
    const reason = input.gitError?.message ?? input.gitError?.code ?? 'git 事实不可用（非仓库或子进程失败）'
    lines.push(`- 【${UNAVAILABLE_MARK}】git 事实：${reason}`)
    return { available: false, phase, phaseSource, text: lines.join('\n'), facts: null }
  }
  const facts = input.gitFacts
  lines.push(`- 分支：${facts.branch ?? '?'}；HEAD：${String(facts.headSha ?? '?').slice(0, 12)}`)
  const summary = facts.statusSummary ?? { total: 0, modified: 0, untracked: 0 }
  lines.push(`- 工作树：${summary.total} 处（改动 ${summary.modified} / 未跟踪 ${summary.untracked}）`)
  for (const row of (Array.isArray(facts.recent) ? facts.recent : []).slice(0, 3)) {
    lines.push(`- 最近提交：${String(row.sha ?? '').slice(0, 7)} ${row.subject ?? ''}`)
  }
  return { available: true, phase, phaseSource, text: lines.join('\n'), facts }
}
