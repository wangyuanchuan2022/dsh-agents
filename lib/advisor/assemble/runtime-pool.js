/**
 * S5 分层重构（F-4）：per-session 运行时池（接缝声明 §3）。
 *
 * 持有全部运行时可变上下文：`runtimes` / `signatures` / `runtimeStates` 三张 Map
 * 归本模块独占（接缝声明 §2④）；装配层与 wiring 只经工厂返回的访问器消费，
 * 不得直接摸内部 Map。`ensureRuntime` 以**函数引用**注入 wiring——原闭包环
 * （observer.onDelta → ensureRuntime → 反向消费 delivery/store/runtimeStates）
 * 由「delivery/store 所有权上收装配层 + 构造序 pool 先于 wiring」消解。
 *
 * 硬模式（S-2）：本模块不 import `store.js`/`api.js`，构造期零 IO。
 *
 * @module dsh-agents/advisor/assemble/runtime-pool
 */

import { AdvisorRuntime } from '../runtime.js'

/**
 * @param {object} deps
 * @param {object} deps.config - resolveAdvisorConfig 产物（活读）
 * @param {import('../store.js').AdvisorStore} deps.store - record 落盘
 * @param {import('../delivery.js').AdvisorDelivery} deps.delivery - 意见投递
 * @param {(row: object) => void} deps.traceSink - 取证 sink
 * @param {object} deps.logger
 * @param {(sessionId: string) => unknown} deps.getAgent
 * @param {{ currentModel: (id: string) => { route: object, enabled: boolean } }} deps.views - session-views
 * @param {() => string} deps.systemPromptOf
 * @param {(sessionId: string) => string} deps.runtimeSignature - **留在装配层**（S0 形态锁读死 index.js）
 * @param {{ contextFor, prefilterFor, aciLoop }} deps.hooks - context-hooks
 * @param {(() => object) | undefined} [deps.resolveLlm] - llm 惰性解析（优先于 llm）
 * @param {object | undefined} [deps.llm] - llm 服务（resolveLlm 缺省时用）
 * @returns {{
 *   ensureRuntime: (sessionId: string) => object | undefined,
 *   disposeRuntime: (sessionId: string) => void,
 *   runtimeOf: (sessionId: string) => object | undefined,
 *   runtimeStateOf: (sessionId: string) => object,
 *   runtimeIds: () => string[],
 *   signatureDrifted: (sessionId: string) => boolean,
 *   forgetRuntimeState: (sessionId: string) => void,
 *   disposeAll: () => void,
 * }}
 */
export function createRuntimePool({
  config, store, delivery, traceSink, logger, getAgent, views, systemPromptOf,
  runtimeSignature, hooks, resolveLlm, llm: llmService,
}) {
  const runtimes = new Map()
  const signatures = new Map()
  /** 某会话「从未评审过」时的运行时状态初值（per-session，绝不共享引用）。 */
  const initialRuntimeState = () => ({ status: 'idle', lastAt: 0, queue: 0, error: null })
  /**
   * 运行时状态镜像：**按会话分桶**（GET 的 runtime 字段）。
   *
   * 曾是单一全局对象，onStatus 无条件写它、snapshot 也不看 sessionId 就返回——
   * 于是 A 会话一次评审失败，会让**从未评审过的 B 会话**在面板上看到
   * 「运行：异常 / 评审输出不是严格 JSON…」和 A 的时间戳。与 records 按会话
   * 过滤（B15）是同型缺陷，只是发生在 runtime 字段上。
   */
  const runtimeStates = new Map()
  const runtimeStateOf = (sessionId) => runtimeStates.get(sessionId) ?? initialRuntimeState()

  const ensureRuntime = (sessionId) => {
    const { route, enabled } = views.currentModel(sessionId)
    if (!enabled) return undefined
    if (route.modelSource !== 'session') return undefined // 硬门禁：未指定模型时绝不调模型
    // llm 惰性解析：宿主服务可能晚于 apply 挂载（务必用 root 解析链，见 lib/index.js）
    let llm = null
    try {
      llm = typeof resolveLlm === 'function' ? resolveLlm() : (llmService ?? null)
    } catch { llm = null }
    if (typeof llm?.stream !== 'function') return undefined
    const existing = runtimes.get(sessionId)
    if (existing !== undefined && signatures.get(sessionId) === runtimeSignature(sessionId)) return existing
    if (existing !== undefined) {
      runtimes.delete(sessionId)
      signatures.delete(sessionId)
      existing.dispose()
    }
    const runtime = new AdvisorRuntime({
      provider: route.provider,
      model: route.model,
      systemPrompt: systemPromptOf(),
      llm,
      maxQueued: config.advisorMaxQueued,
      callTimeoutMs: config.advisorCallTimeoutMs,
      maxMessages: config.advisorMaxMessages,
      deliver: (note, meta) => delivery.route(sessionId, note),
      record: (record) => { store.append(record) },
      onStatus: (snapshot) => { runtimeStates.set(sessionId, { ...snapshot }) },
      trace: traceSink,
      logger,
      // S2：三层上下文装配 + 规则预筛（两个都是**注入式**钩子；缺省 undefined = S1 行为）
      context: hooks.contextFor,
      prefilter: hooks.prefilterFor,
      // S3：agentic 工具循环（注入式；0 = 关闭 ⇒ undefined，runtime 走单次调用）
      toolLoop: config.advisorMaxToolRounds > 0 ? hooks.aciLoop : undefined,
    })
    runtimes.set(sessionId, runtime)
    signatures.set(sessionId, runtimeSignature(sessionId))
    return runtime
  }

  const disposeRuntime = (sessionId) => {
    const runtime = runtimes.get(sessionId)
    if (runtime === undefined) return
    runtimes.delete(sessionId)
    signatures.delete(sessionId)
    runtime.dispose()
  }

  return {
    ensureRuntime,
    disposeRuntime,
    runtimeOf: (sessionId) => runtimes.get(sessionId),
    runtimeStateOf,
    runtimeIds: () => [...runtimes.keys()],
    signatureDrifted: (sessionId) => signatures.get(sessionId) !== runtimeSignature(sessionId),
    forgetRuntimeState: (sessionId) => { runtimeStates.delete(sessionId) },
    disposeAll: () => {
      for (const sessionId of [...runtimes.keys()]) disposeRuntime(sessionId)
      runtimes.clear()
    },
  }
}
