/**
 * S5 分层重构（F-4）：三个共享读取闭包的独立归属（接缝声明 §3，`agent-out/v3-s5-seams.md`）。
 *
 * `currentModel` 是被六处消费的枢纽（runtimeSignature / ensureRuntime / 事件接线 early-exit /
 * triggerReview / ctrl.snapshot / patchConfig），跨 config / runtime-pool / wiring / ctrl
 * 四个模块 ⇒ 必须独立成模块，经工厂参数注入 `store` 与 `getAgent`。
 *
 * `resolveAdvisorModel` 本体随 `currentModel` 搬入本模块（index.js re-export，
 * 消费面零变化）——避免 session-views → index 的循环 import（完成判据：无循环 import）。
 *
 * 硬模式（S-2）：本模块不 import `store.js`/`api.js`，构造期零 IO——一切依赖经工厂入参注入。
 *
 * @module dsh-agents/advisor/assemble/session-views
 */

/**
 * 会话级模型来源（契约 §1，**完全手动指定、无任何兜底**）。
 *
 * 只认该会话自己配置里的 provider/model；**不读 HIGH 档路由、不读全局
 * config.advisorProvider/advisorModel**——「未指定即不评审」是用户拍板的语义，
 * 任何静默兜底都会让「面板上写的模型」与「实际调用的模型」不一致。
 *
 * 本函数**故意只有 sessionConfig 一个入参**：历史上第二个入参是
 * `tierTableOf`（HIGH 档路由提供者），现已彻底移除。判据 B1 用「传一个
 * 一被调用就抛错的假 tierTableOf」证明它不再被读。
 *
 * @param {object} sessionConfig - 该会话配置（store.readSessionConfig 的产物）
 * @returns {{provider: string|null, model: string|null, modelSource: 'session'|'unset', reason: string|null}}
 */
export function resolveAdvisorModel(sessionConfig) {
  const cfg = sessionConfig === null || typeof sessionConfig !== 'object' ? {} : sessionConfig
  const provider = typeof cfg.provider === 'string' ? cfg.provider : ''
  const model = typeof cfg.model === 'string' ? cfg.model : ''
  if (provider !== '' && model !== '') {
    return { provider, model, modelSource: 'session', reason: null }
  }
  return {
    provider: null,
    model: null,
    modelSource: 'unset',
    reason: '本会话未指定评审模型（无任何兜底路由；请在本会话面板选择 provider 与 model）',
  }
}

/**
 * @param {object} deps
 * @param {import('../store.js').AdvisorStore} deps.store - 会话配置读取（readSessionConfig）
 * @param {(sessionId: string) => unknown} deps.getAgent - 宿主 agent 查找（装配层注入）
 * @returns {{
 *   currentModel: (sessionId: string) => { route: object, enabled: boolean },
 *   isActiveSession: (sessionId: string) => boolean,
 *   visibleMessageCount: (sessionId: string) => number | undefined,
 * }}
 */
export function createSessionViews({ store, getAgent }) {
  // S2 起**只剩会话自己这一层**：enabled/provider/model 一律读该会话的
  // 配置文件，全局 config 与任何「无会话的槽」都不再参与合并（F-2 的洞在此
  // 结构性关闭：不存在第二层，就不存在「别的会话/全局把它单独开启」的可能）。
  const currentModel = (sessionId) => {
    const override = typeof sessionId === 'string' && sessionId !== ''
      ? store.readSessionConfig(sessionId)
      : {}
    return {
      route: resolveAdvisorModel(override),
      enabled: override.enabled === true,
    }
  }

  /**
   * 活跃会话校验（Q-1 / AC-20）：`ctx.agents.get` 拿得到即视为活跃。
   *
   * **这是 liveness check，不是 authorization**——宿主 webServer 的 WebRoute
   * 只有 kind/path/handler，**没有鉴权钩子**，handler 拿的是裸 IncomingMessage。
   * 因此它能挡住「已不存在 / 已 dispose 的 sessionId」，**挡不住**「同机另一
   * 页面修改他人活跃会话的配置」。后者是已知残余风险（契约第 2 节如实声明）。
   *
   * ctx.agents 缺失 / 没有 get / get 抛错 → 一律 fail-closed（视为不活跃）。
   */
  const isActiveSession = (sessionId) => getAgent(sessionId) !== undefined

  /**
   * 该会话当前**投影**条数（seed 游标用；拿不到/抛错 → undefined）。
   *
   * 口径必须是 `deriveMessages()` 的**原始长度**：`renderAndEmit` 的游标比较
   * （`cursor.cursor > messages.length` / `effective.length <= cursor.cursor`）
   * 用的就是它，而不是过滤掉 advisor 消息与工具消息之后的可见条数。
   */
  const visibleMessageCount = (sessionId) => {
    try {
      const session = getAgent(sessionId)?.session
      if (typeof session?.deriveMessages !== 'function') return undefined
      const messages = session.deriveMessages()
      return Array.isArray(messages) ? messages.length : undefined
    } catch {
      return undefined
    }
  }

  return { currentModel, isActiveSession, visibleMessageCount }
}
