/**
 * S5 分层重构（F-4）：观察器 + 宿主事件接线（接缝声明 §3）。
 *
 * 持有 `manualReviews`（手动补评标记）与 observer 实例；五个事件订阅
 * （session/event + agent/created|disposed + session/disposed，全 {global:true}）
 * 与 P1-1 的 enabled 早退整体搬移。原闭包环在此消解：onDelta 经**工厂入参**
 * 拿到 pool 的 `ensureRuntime`（pool 先于本模块构造，不再依赖 TDZ 晚绑定）。
 *
 * 硬模式（S-2）：本模块不 import `store.js`/`api.js`，构造期零 IO（事件订阅本身
 * 不是 IO；落盘全部发生在事件回调内，与原实现时机一致）。
 *
 * @module dsh-agents/advisor/assemble/wiring
 */

import { AdvisorObserver } from '../observer.js'
import { tailMessage, TRIGGER_USER, TRIGGER_ASSISTANT, TRIGGER_MANUAL } from '../decision/prefilter.js'

/**
 * @param {object} deps
 * @param {object} deps.ctx - 插件上下文（on 事件订阅面）
 * @param {object} deps.config - resolveAdvisorConfig 产物
 * @param {object} deps.logger
 * @param {(sessionId: string) => unknown} deps.getAgent
 * @param {(sessionId: string) => {sessionId: string, sessionName: string|null}} deps.sessionMeta
 * @param {import('../store.js').AdvisorStore} deps.store - seen 持久化
 * @param {import('../delivery.js').AdvisorDelivery} deps.delivery
 * @param {{ currentModel: (id: string) => { route: object, enabled: boolean } }} deps.views
 * @param {(sessionId: string) => object | undefined} deps.ensureRuntime - pool 注入（原晚绑定点）
 * @param {(sessionId: string) => void} deps.disposeRuntime - pool 注入
 * @param {(sessionId: string) => void} deps.forgetRuntimeState - pool 注入（agent/disposed 清状态桶）
 * @returns {{ observer: AdvisorObserver, markManualReview: (id: string) => void, disposers: Array<() => void> }}
 */
export function createWiring({
  ctx, config, logger, getAgent, sessionMeta, store, delivery, views,
  ensureRuntime, disposeRuntime, forgetRuntimeState,
}) {
  /** S2：手动补评标记（POST 触发的一轮不过预筛——人明确要求评审就是最强信号）。 */
  const manualReviews = new Set()
  /**
   * S2：触发源**由渲染结果推导**（不动 observer 的求值序）——
   * 「最后说话的是用户」⇒ user-message，否则 assistant-stepped（G-13 技术缺省：
   * 非用户消息不过预筛）。判定与预筛同源（`prefilter.tailMessage`），避免两处口径。
   */
  const triggerOf = (markdown) => (tailMessage(markdown).role === 'assistant' ? TRIGGER_ASSISTANT : TRIGGER_USER)

  const observer = new AdvisorObserver({
    maxMessages: config.advisorMaxMessages,
    getSession: (sessionId) => getAgent(sessionId)?.session,
    sessionMeta,
    // S3 幂等门：seen 持久化走 store 的独立文件（sessions/<b64>.seen.json），
    // 与配置分文件——两个面写不到同一个 inode，PATCH 与评审落盘不会互相覆盖。
    loadSeen: (sessionId) => store.readSeen(sessionId),
    saveSeen: (sessionId, state) => store.writeSeen(sessionId, state),
    onDelta: (sessionId, delta, meta) => {
      try {
        const manual = manualReviews.has(sessionId)
        if (manual) manualReviews.delete(sessionId)
        const trigger = manual ? TRIGGER_MANUAL : triggerOf(String(delta?.markdown ?? ''))
        ensureRuntime(sessionId)?.enqueue({ ...delta, trigger }, meta)
      } catch (error) {
        logger.warn?.(`[dsh-agents] advisor onDelta 抛错（本轮丢弃）：${error?.message ?? error}`)
      }
    },
    onSteppedTurnEnd: (sessionId) => delivery.onSteppedTurnEnd(sessionId),
    onRewrite: (sessionId) => delivery.reset(sessionId),
    logger,
  })

  const disposers = []

  // ---- 事件接线（全 {global:true}：隔离作用域下也必须收到全部会话事件）----
  // ctx.on 是宿主事件订阅面；缺失时（假宿主/裁剪版快照）如实告警并不接线，
  // 其余能力（端点 GET/PATCH/POST、记录）仍然可用。
  if (typeof ctx?.on !== 'function') {
    logger.warn?.('[dsh-agents] advisor：当前上下文没有 ctx.on 事件订阅面，自动评审未接线（端点与记录仍可用）')
  } else {
    disposers.push(ctx.on('session/event', (session, event) => {
      // P1-1（必修）：**未启用该会话 advisor 的会话不得进观察器落盘路径**。
      //
      // `session/event` 是全局接线（`{global:true}`），**所有会话**都会到这里；
      // 而观察器在每个 `turn/end` 上无条件推进水位并写 seen 文件。不早退的话，
      // 一个从未开启 advisor 的会话跑完一轮就会凭空产生
      // `sessions/<b64>.seen.json`，并按 M=256 每回合整份重写十几 KB。
      //
      // 早退必须落在**落盘之前**（这里，`observer.handleEvent` 之前）；
      // 放进 `ensureRuntime` 是错的 —— 那是 S2 的运行时重建路径，运行时只在
      // 评审时才被用到，与观察器的落盘时机不同源。
      if (!views.currentModel(session.id).enabled) return
      // DSH 0.1.2-alpha.4+ 的 Session 不再暴露 .events（改经 ownEvents()），
      // 三档兜底：ownEvents() → .events → []（宁可本回合无可评审内容也不抛错）。
      try {
        observer.handleEvent(session.id, session.ownEvents?.() ?? session.events ?? [], event)
      } catch (error) {
        logger.warn?.(`[dsh-agents] advisor session/event 处理异常（已含在本层）：${error?.message ?? error}`)
      }
    }, { global: true }))
    disposers.push(ctx.on('agent/created', ({ agent }) => {
      delivery.registerAgent(agent)
      ensureRuntime(agent.id)
    }, { global: true }))
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      observer.disposeSession(agent.id)
      disposeRuntime(agent.id)
      delivery.unregisterAgent(agent.id)
      forgetRuntimeState(agent.id) // 会话真的没了才丢状态桶；配置层面的停用保留「上次评审」时间
    }, { global: true }))
    disposers.push(ctx.on('session/disposed', (session) => {
      observer.disposeSession(session.id)
      disposeRuntime(session.id)
      delivery.unregisterAgent(session.id)
      forgetRuntimeState(session.id)
    }, { global: true }))
  } // end ctx.on 接线分支

  return {
    observer,
    markManualReview: (sessionId) => { manualReviews.add(sessionId) },
    disposers,
  }
}
