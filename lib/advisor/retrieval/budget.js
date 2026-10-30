/**
 * retrieval/budget.js —— **唯一预算常量源 + 唯一计量函数**（advisor V3 / S1a 判据 6 AC-13）。
 *
 * ## 唯一口径（计划 §1.1，产品裁定 + 组织者裁定；**禁止第二种读法**）
 *
 * `Base Context` 与 `Repository Context` 是**并列的两个独立预算项**——互不包含、
 * 互不挤压、互不占用：
 *
 * ```
 *   Base Context         ≤ 8 KB   （8192 B）   基础上下文（契约锚 + 系统提示层）
 *   Repository Context   ≤ 40 KB  （40960 B）  = 首次 retrieval 20KB + 二次 retrieval 20KB
 *   ─────────────────────────────────────────
 *   总注入上限           = 48 KB  （49152 B）
 * ```
 *
 * **不得**把 40KB 读成「四段总和封顶」，**不得**出现「分层上限之和不得突破总量上限」的表述。
 *
 * ## 计量对象（G-2）
 *
 * - **KB = 1024 字节**；
 * - 计量对象 = **最终注入模型的文本**（不是原始命中、不是文件大小）；
 * - Base Context **不含**会话消息历史（历史由 runtime 的会话窗口另行管理）。
 *
 * ## 为什么必须有这一份「唯一常量源」
 *
 * 预算数字一旦在多个模块里各写一遍，就会出现「契约写 8KB / 实现写 16KB」这类静默漂移，
 * 而漂移只会在真机上表现为「上下文莫名变长」。故：**常量只在本文件声明**，
 * 生产与测试**共用同一个计量函数** `measureInjection()`（禁止各自实现，AC-13 第②条）。
 *
 * ## 本步（S1a）只交付 ①常量源 ②计量函数 ③耗尽载体
 *
 * 第②③④层（首次/二次 retrieval、检索段合计的**裁剪**）只能在 S3 的多轮循环里被逼出来，
 * **唯一裁剪 chokepoint 在 S3**。本文件提供判定与载体，不在单步内做裁剪。
 *
 * @module dsh-agents/advisor/retrieval/budget
 */

/** 1 KB = 1024 字节（G-2：本仓预算口径一律 1024，不用 1000）。 */
export const KB = 1024

/**
 * **Base Context 上限**（独立声明，不与 Repository 相加）。
 *
 * **2026-10-29 由 8KB 上调至 9KB**（用户授权「可以稍微提高一下 token 限制」）。
 *
 * 上调依据（实测）：系统提示加入 P1 时机纪律 / P6 输出锚点 / P5 继续成本句后，
 * 提示词从 6,602 B 增至 6,781 B；实测 Base 在「3 条决策」场景达 8,156 B / 8,192 B，
 * **余量仅 36 B**，再添一条决策就会触发尾部截断（而截断会吃掉输出格式契约 ⇒
 * 整轮评审 parse-error 不投递）。上调 1KB 后同场景余量 1,060 B，可容纳约 8–12 条决策。
 *
 * **不是无上限**：Base 仍是有界预算，超限仍走既有的尾部截断 + 显式留痕逻辑。
 */
export const BASE_CONTEXT_BYTES = 9 * KB

/**
 * **单次 retrieval 上限**（独立声明）。
 * 20 × 1024 = 20480 字节。
 */
export const RETRIEVAL_CALL_BYTES = 20 * KB

/**
 * **检索段合计上限**（独立声明；= 两次 retrieval 之和，**不含** Base Context）。
 * 40 × 1024 = 40960 字节。
 */
export const RETRIEVAL_TOTAL_BYTES = 40 * KB

/** **总注入上限** = Base + Repository（并列项相加，互不占用）。49 KB（2026-10-29 Base 8→9KB）。 */
export const TOTAL_INJECTION_BYTES = BASE_CONTEXT_BYTES + RETRIEVAL_TOTAL_BYTES

/**
 * 预算项的**结构化声明**（供契约文档与测试做「三项独立声明」的对账；
 * 任何一处改口径都必须同时改这里与上面的常量，测试会双向对账）。
 */
export const BUDGET_ITEMS = Object.freeze({
  base: Object.freeze({
    id: 'base-context',
    bytes: BASE_CONTEXT_BYTES,
    includes: '基础上下文（契约锚 + 系统提示层）',
    excludes: '会话消息历史（G-2）',
  }),
  repository: Object.freeze({
    id: 'repository-context',
    bytes: RETRIEVAL_TOTAL_BYTES,
    includes: '首次 retrieval + 二次 retrieval（各 20KB，合计 40KB）',
    excludes: 'Base Context（并列项，互不占用）',
  }),
  singleRetrieval: Object.freeze({
    id: 'retrieval-call',
    bytes: RETRIEVAL_CALL_BYTES,
    includes: '单次 retrieval 注入文本',
    excludes: '其它轮次的 retrieval',
  }),
})

/**
 * **唯一计量函数**：最终注入模型的文本 → 字节数（UTF-8）。
 *
 * 生产（S2/S3 装配）与测试**必须共用本函数**；测试若自己 `Buffer.byteLength`
 * 就等于「各写一份口径」，AC-13 第②条明令禁止。
 *
 * @param {unknown} text - 最终要注入模型的文本
 * @returns {{chars:number, bytes:number}} `chars` = UTF-16 码元数，`bytes` = UTF-8 字节数（计量口径）
 */
export function measureInjection(text) {
  const src = typeof text === 'string' ? text : ''
  return { chars: src.length, bytes: Buffer.byteLength(src, 'utf8') }
}

/**
 * 预算判定（**只判不裁**；裁剪 chokepoint 在 S3）。
 *
 * @param {{usedBytes:number, limitBytes:number}} input
 * @returns {{ok:boolean, over:boolean, usedBytes:number, limitBytes:number, remaining:number, overflowBytes:number}}
 */
export function budgetVerdict({ usedBytes, limitBytes } = {}) {
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? Math.trunc(usedBytes) : 0
  const limit = Number.isFinite(limitBytes) && limitBytes >= 0 ? Math.trunc(limitBytes) : 0
  const remaining = Math.max(0, limit - used)
  return {
    ok: used <= limit,
    over: used > limit,
    usedBytes: used,
    limitBytes: limit,
    remaining,
    overflowBytes: Math.max(0, used - limit),
  }
}

/**
 * 把「本轮已发生的 retrieval 文本」记账为可枚举结构（**生产者侧**，供 AC-45 引用闭包）。
 *
 * 口径：`repositoryBytes` = 各次调用文本字节之和；判定分别对照
 * 单次上限（`BUDGET_ITEMS.singleRetrieval`）与检索段合计上限（`BUDGET_ITEMS.repository`）。
 * Base Context 单独记（`baseBytes`），**不并入** repository。
 *
 * @param {{calls?: Array<{label?:string, text?:string}|string>, baseText?:string}} [input]
 * @returns {{baseBytes:number, repositoryBytes:number, totalBytes:number, calls:Array<object>, verdicts:object}}
 */
export function accountRetrieval(input = {}) {
  const rawCalls = Array.isArray(input.calls) ? input.calls : []
  const calls = rawCalls.map((call, index) => {
    const label = typeof call === 'string' ? `retrieval#${index + 1}` : (call?.label ?? `retrieval#${index + 1}`)
    const text = typeof call === 'string' ? call : (typeof call?.text === 'string' ? call.text : '')
    const { bytes, chars } = measureInjection(text)
    return { label, bytes, chars, verdict: budgetVerdict({ usedBytes: bytes, limitBytes: RETRIEVAL_CALL_BYTES }) }
  })
  const baseBytes = measureInjection(input.baseText ?? '').bytes
  const repositoryBytes = calls.reduce((sum, c) => sum + c.bytes, 0)
  return {
    baseBytes,
    repositoryBytes,
    totalBytes: baseBytes + repositoryBytes,
    calls,
    verdicts: {
      base: budgetVerdict({ usedBytes: baseBytes, limitBytes: BASE_CONTEXT_BYTES }),
      perCall: calls.map((c) => c.verdict),
      repository: budgetVerdict({ usedBytes: repositoryBytes, limitBytes: RETRIEVAL_TOTAL_BYTES }),
      total: budgetVerdict({ usedBytes: baseBytes + repositoryBytes, limitBytes: TOTAL_INJECTION_BYTES }),
    },
  }
}

/** 预算耗尽/裁剪的**显式事实载体**（G-24）：与「触顶未投递」同形。 */
export const DROPPED_OUTCOME = 'dropped'

/**
 * 构造「预算耗尽」的显式事实载体（S1a 只**定义载体**，闸门执行在 S3）。
 *
 * **硬要求（G-24）**：不得只留 `runtime.status`——必须同时给出
 * ① `records` 里一条 `outcome:'dropped'`（`severity:'info'`，与 runtime 触顶路径同形，
 *    见 `lib/advisor/runtime.js:464-470`）；
 * ② `runtime.error` 文本（`#setStatus('error', detail)` 的同一句）。
 * 缺任一条，AC-14 的断言就「点不到名」。
 *
 * @param {{sessionId?:string, sessionName?:string|null, label?:string,
 *          usedBytes?:number, limitBytes?:number, reason?:string}} [input]
 * @returns {{record:object, runtimeError:string, carrier:string}}
 */
export function budgetExhaustedCarrier(input = {}) {
  const label = typeof input.label === 'string' && input.label !== '' ? input.label : 'retrieval'
  const usedBytes = Number.isFinite(input.usedBytes) ? Math.trunc(input.usedBytes) : 0
  const limitBytes = Number.isFinite(input.limitBytes) ? Math.trunc(input.limitBytes) : 0
  const reason = typeof input.reason === 'string' && input.reason !== '' ? input.reason : '预算耗尽'
  const detail = `检索预算耗尽（${label}）：${usedBytes}/${limitBytes} 字节，${reason}（未注入，dropped）`
  return {
    record: {
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sessionName: typeof input.sessionName === 'string' ? input.sessionName : null,
      severity: 'info',
      text: detail.slice(0, 200),
      outcome: DROPPED_OUTCOME,
    },
    runtimeError: detail,
    carrier: 'records.outcome=dropped + runtime.error',
  }
}
