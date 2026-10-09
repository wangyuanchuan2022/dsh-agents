/**
 * context/build.js —— **三层上下文装配**（AC-1 / AC-4 / AC-5 / AC-13 / AC-16 / AC-59）。
 *
 * ## 三层与两个预算面的关系（**唯一口径**）
 *
 * ```
 *   ① Conversation（会话可见消息快照）   预算：ADVISOR_CONVERSATION_MAX_CHARS = 96_000 **字符**
 *                                        └─ 由 runtime 的持续会话窗口实现（本模块只**声明**，不装内容）
 *   ② Project State（项目阶段/git 事实）  ┐
 *   ③ Repository（L1 + L2）              ┘ 均属「上下文段」，其中
 *        Base Context（基础上下文）= 契约锚 + 系统提示 + Project State + 决策保护
 *                                    ≤ 8 KB（BASE_CONTEXT_BYTES）
 *        Repository Context        = L1 + L2 ≤ 40 KB（RETRIEVAL_TOTAL_BYTES；单次 ≤20KB）
 * ```
 *
 * **关系 = 叠加（G-14）**：总注入 = 96K 字符历史 + ≤40KB 检索段 + ≤8KB 基础上下文；
 * 三者**互不占用、互不挤压**（§1.1 唯一口径，禁止第二种读法）。
 * **基础上下文不含会话消息历史**（G-2）：历史由 runtime 的会话窗口独立承载。
 * 该声明同时是 AC-16 的「唯一口径」载体（{@link describeBudgetRelation}），
 * 且有一条边界测试把它跑出来（历史满 + 满额仓库面 → 不溢出、不崩）。
 *
 * ## 不可用必须显式（AC-4）
 *
 * 任一层不可用（无决策文件 / git 不可用 / 普通聊天不做仓库分析）⇒ 该层区块内出现
 * **逐字「不可用」**标注，**其余层照常进入**——绝不静默省略。
 *
 * ## 落步边界
 *
 * 本模块只做**装配与计量**；**预算裁剪的闸门在 S3**（多轮循环才能逼出「二次 retrieval /
 * 检索段合计」）。这里唯一的裁剪是 Base Context 的 8KB 硬上限（AC-13 要求注入文本 ≤8KB），
 * 裁剪事实**可观测**（`trimmed` / `droppedBytes` / `accounting`）。
 *
 * @module dsh-agents/advisor/context/build
 */

import {
  BASE_CONTEXT_BYTES, RETRIEVAL_CALL_BYTES, RETRIEVAL_TOTAL_BYTES, TOTAL_INJECTION_BYTES,
  BUDGET_ITEMS, accountRetrieval, measureInjection,
} from '../retrieval/budget.js'
import { renderDecisions, UNAVAILABLE_MARK as DECISIONS_UNAVAILABLE } from './decisions.js'
import { buildProjectState } from './project.js'
import { buildRepositoryContext } from './repository.js'

/** 三层（顺序即装配顺序）。 */
export const CONTEXT_LAYERS = Object.freeze(['conversation', 'project', 'repository'])

/** 段标题（注入文本里的可断言锚）。 */
export const BASE_TITLE = '## 基础上下文（Base Context）'
export const REPOSITORY_TITLE = '## 仓库上下文（Repository Context）'

/** 预算关系（AC-16 的唯一口径标记）。 */
export const BUDGET_RELATION = 'additive'

/**
 * AC-16 的**唯一口径声明**（逐字：任何别处都不得给出第二种读法）。
 * 也供 S5 契约直接引用。
 */
export const BUDGET_RELATION_STATEMENT = [
  `总注入 = ≤96_000 字符会话历史（${'ADVISOR_CONVERSATION_MAX_CHARS'}，**独立预算池**）`,
  `+ ≤40KB 检索段（Repository Context：${RETRIEVAL_TOTAL_BYTES} 字节，单次 ≤${RETRIEVAL_CALL_BYTES} 字节）`,
  `+ ≤8KB 基础上下文（Base Context：${BASE_CONTEXT_BYTES} 字节）`,
  `⇒ 总上限 ${TOTAL_INJECTION_BYTES} 字节 + 96K 字符；三者**叠加**、互不占用、互不挤压（G-14 / §1.1 唯一口径）`,
  '基础上下文**不含会话消息历史**（G-2）——历史由 runtime 的持续会话窗口独立承载',
].join(' ')

/** 逐字返回唯一口径声明（测试与契约对账用）。 */
export function describeBudgetRelation() {
  return BUDGET_RELATION_STATEMENT
}

/** 基础上下文的契约锚（只读边界 + 三面声明；不含任何会话内容）。 */
export const BASE_ANCHORS = Object.freeze([
  '- 只读边界：advisor **只读**——不写文件、不改代码、不执行任何修改操作（产品第 1 条）',
  '- 缺口显式：任一层不可用时给出「不可用」标注，不得无中生有、不得静默省略',
  '- 预算口径：Base Context 与 Repository Context 并列独立（§1.1）；计量对象 = 最终注入文本的字节数',
])

/**
 * 按字节上限裁剪（**唯一实现点**；Base Context 的 8KB 硬上限用它）。
 *
 * @param {string} text
 * @param {number} limitBytes
 * @param {string} [label]
 * @returns {{text:string, bytes:number, trimmed:boolean, droppedBytes:number, limitBytes:number}}
 */
export function trimToBudget(text, limitBytes, label = '基础上下文') {
  const src = String(text ?? '')
  const total = measureInjection(src).bytes
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? Math.trunc(limitBytes) : 0
  if (total <= limit) return { text: src, bytes: total, trimmed: false, droppedBytes: 0, limitBytes: limit, over: false }
  // ⚠️ 调用方是**硬上限**（Base 8KB / Repository 40KB）：本函数**承诺返回 ≤ limit**。
  //    guard 用尽仍超限时**不得**把超限内容返回（P1：code-reviewer 指出旧实现可能返回超限）——
  //    退化成「只剩裁剪说明」并置 `over:true`（可观测），由调用方决定是否报错。
  const markerOf = (keptBytes) => `\n…（${label}超出预算：已裁剪 ${total - keptBytes} 字节并保留上限说明（上限 ${limit} 字节，口径见 retrieval/budget.js））`
  let keep = src
  let marker = markerOf(0)
  for (let guard = 0; guard < 4096; guard += 1) {
    const kept = measureInjection(keep).bytes
    marker = markerOf(kept)
    const withMarker = measureInjection(keep + marker).bytes
    if (withMarker <= limit) break
    keep = keep.slice(0, Math.max(0, keep.length - Math.max(1, Math.ceil((withMarker - limit) / 3))))
  }
  let finalText = keep + marker
  let over = measureInjection(finalText).bytes > limit
  if (over) {
    // 兜底：连「裁剪后的正文 + 说明」都装不下（limit 极小）⇒ 只留最简说明，宁可丢内容也不越限
    finalText = `【${label}：上限 ${limit} 字节，内容已全部裁剪】`
    over = measureInjection(finalText).bytes > limit
    if (over) finalText = ''
    over = measureInjection(finalText).bytes > limit
  }
  return {
    text: finalText,
    bytes: measureInjection(finalText).bytes,
    trimmed: true,
    droppedBytes: total - measureInjection(keep).bytes,
    limitBytes: limit,
    over,
  }
}

/**
 * 装配 **Base Context**（≤8KB；**不含会话消息历史**）。
 *
 * @param {{systemPrompt?:string, decisions?:object, project?:object, anchors?:string[]}} input
 * @returns {{text:string, bytes:number, available:boolean, trimmed:boolean, droppedBytes:number,
 *            unresolved:Array<string>, parts:object}}
 */
export function buildBaseContext(input = {}) {
  const parts = {
    systemPrompt: String(input.systemPrompt ?? ''),
    anchors: (Array.isArray(input.anchors) ? input.anchors : BASE_ANCHORS).join('\n'),
    project: typeof input.project?.text === 'string' ? input.project.text : '',
    decisions: renderDecisions(input.decisions),
  }
  const sections = [
    BASE_TITLE,
    '### 契约锚（只读边界 / 缺口显式 / 预算口径）',
    parts.anchors,
    parts.project,
    parts.decisions,
  ].filter((s) => s !== '')
  const raw = [parts.systemPrompt === '' ? '' : `### 系统提示（advisorSystemPrompt）\n${parts.systemPrompt}`, ...sections]
    .filter((s) => s !== '')
    .join('\n\n')
  const trimmed = trimToBudget(raw, BASE_CONTEXT_BYTES, '基础上下文')
  const unresolved = []
  if (input.decisions?.available === false) unresolved.push(`决策保护（${DECISIONS_UNAVAILABLE}）`)
  if (input.project?.available === false) unresolved.push(`git 事实（${DECISIONS_UNAVAILABLE}）`)
  return {
    text: trimmed.text,
    bytes: trimmed.bytes,
    available: true,
    trimmed: trimmed.trimmed,
    droppedBytes: trimmed.droppedBytes,
    unresolved,
    parts,
  }
}

/**
 * 装配**整轮上下文段**：Base（≤8KB）+ Repository（L1+L2，≤40KB）+ 会话层声明。
 *
 * @param {{retrieval?:object, messageText?:string, systemPrompt?:string, decisions?:object,
 *          project?:{gitFacts?:object|null, gitError?:object|null, phase?:string|null, files?:Array},
 *          focusSource?:string[], queries?:Array<object>, includeGit?:boolean, maxFiles?:number,
 *          conversationChars?:number}} input
 * @returns {object}
 */
export function buildContext(input = {}) {
  const layers = []
  // ① Conversation：**只声明不装内容**（内容由 runtime 的窗口承载；G-2：基础上下文不含历史）
  const conversation = {
    layer: 'conversation',
    owner: 'runtime:AdvisorConversation',
    budgetChars: Number.isFinite(input.conversationChars) && input.conversationChars > 0
      ? Math.trunc(input.conversationChars) : 96_000,
    note: '会话可见消息快照由 runtime 的持续会话窗口承载；**不进 Base Context**（G-2）',
  }
  layers.push(conversation.layer)

  // ② Repository（L1 + L2；普通聊天 ⇒ 零检索零子进程）——**先建**，因为它顺手取到了 git 事实
  const repository = buildRepositoryContext({
    retrieval: input.retrieval,
    messageText: input.messageText,
    focusSource: input.focusSource,
    queries: input.queries,
    includeGit: input.includeGit,
    maxFiles: input.maxFiles,
  })
  layers.push('repository')

  // ③ Project State（P1-2，code-reviewer 2026-10-09 实测）：
  //    **必须真的喂 git 事实**。旧实现只传 `{phase}` ⇒ 生产接线（`index.js` 的 `contextFor`）
  //    下 Project State 层**永久**显示「git 不可用」、启发阶段恒 `design`。
  //    现在按「调用方显式给 > repository 层已取到 > 无」的优先级取，**不额外起第二个子进程**。
  const project = input.projectResult ?? buildProjectState({
    gitFacts: input.project?.gitFacts ?? repository.gitFacts ?? null,
    gitError: input.project?.gitError ?? repository.gitError ?? null,
    phase: input.project?.phase ?? null,
    files: input.project?.files,
  })
  layers.push('project')

  const base = buildBaseContext({
    systemPrompt: input.systemPrompt,
    decisions: input.decisions,
    project,
  })
  const repositoryTrimmed = trimToBudget(repository.text, RETRIEVAL_TOTAL_BYTES, '仓库上下文')
  const text = [base.text, repositoryTrimmed.text].join('\n\n')
  const accounting = accountRetrieval({
    baseText: base.text,
    calls: [{ label: 'retrieval#1', text: repositoryTrimmed.text }],
  })
  return {
    // `layers` 用**语义顺序**（CONTEXT_LAYERS），与「装配顺序」解耦：
    // 装配时先建 Repository（它顺手取到 git 事实，供 Project State 复用，见上），
    // 但对外声明的三层顺序恒为 conversation → project → repository（可断言、稳定）。
    layers: [...CONTEXT_LAYERS],
    base,
    baseBytes: base.bytes,
    baseLimit: BUDGET_ITEMS.base.bytes,
    repository,
    repositoryBytes: repositoryTrimmed.bytes,
    repositoryTrimmed: repositoryTrimmed.trimmed,
    repositoryLimit: BUDGET_ITEMS.repository.bytes,
    conversation,
    text,
    bytes: measureInjection(text).bytes,
    accounting,
    anchors: { budgetRelation: BUDGET_RELATION, statement: BUDGET_RELATION_STATEMENT },
  }
}

/**
 * 「未解析到会话工作区根」时的**显式不可用段**（AC-4 同源纪律：不静默省略）。
 *
 * 刻意**不**回落 `process.cwd()`：advisor 的数据目录与工作区根都不得随宿主启动目录漂移
 * （既有源码级门 `tests/advisor.test.mjs:314` 禁止 index.js 出现 `process.cwd()`）。
 */
export function renderUnavailableContext(reason) {
  return `<!-- advisor 上下文（只进本轮，不入持续会话历史） -->\n${REPOSITORY_TITLE}\n- 【${UNAVAILABLE_MARK}】${reason}`
}

/** 不可用标注（与 decisions/project 同词）。 */
export const UNAVAILABLE_MARK = '不可用'

/**
 * 把 `buildContext()` 的结果渲染成**注入模型的单段文本**（runtime 的第三段）。
 *
 * 明确声明：**该段只进本轮调用，不进持续会话历史**——唯一入历史点是
 * `runtime.process()` 里的 `conversation.appendUser(增量)`（AC-13 同源纪律）。
 */
export function renderContextSection(result) {
  if (result === null || result === undefined) return ''
  const head = `<!-- advisor 上下文（只进本轮，不入持续会话历史）：Base ≤${BUDGET_ITEMS.base.bytes}B + Repository ≤${BUDGET_ITEMS.repository.bytes}B -->`
  return `${head}\n${result.text}`
}
