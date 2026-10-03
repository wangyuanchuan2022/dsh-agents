/**
 * advisor 投递层（契约 §5 投递语义）。
 *
 * 四种 outcome（两席与端点共用）：
 *   - `steer`    nit/concern/blocker ∈ advisorSteerSeverities 且不在冷却 → agent.steer() 实时打断；
 *   - `inject`   info+advisorInfoInject / severity 不在列表 / 冷却窗口内 → agent.inject()（非唤醒）；
 *   - `recorded` info 且 advisorInfoInject=false → 只记录（面板可见，主会话不打扰）；
 *   - `dropped`  缺 agent（无 steer/inject）→ 返回 false，由调用方记 dropped + 日志告警。
 *
 * 另含契约 §5 的消息形态构造：user-role + source.kind='advisor' + notice form +
 * summary（GUI 折叠行给用户看，Agent 只见全文）。
 *
 * @module dsh-agents/advisor/delivery
 */

/** advisor 注入消息的 source.kind（自评审排除与投递标记的唯一依据）。 */
export const ADVISOR_SOURCE_KIND = 'advisor'

/** notice summary 长度上限（DSH CONTEXT_SUMMARY_MAX_CHARS 约定）。 */
export const SUMMARY_MAX_CHARS = 120

/** 判断一条消息是否由 advisor 注入（评审输入要排除，防递归自评）。 */
export function isAdvisorMessage(message) {
  return message !== null && typeof message === 'object' && message.source?.kind === ADVISOR_SOURCE_KIND
}

/** 摘要截断（超长以省略号收尾）。 */
export function boundSummary(summary) {
  const text = String(summary ?? '')
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text
}

/**
 * 构造一条 advisor 投递消息（user-role，source.kind='advisor'）。
 * @param {{severity: string, text: string}} note
 */
export function buildAdvisorMessage(note) {
  return {
    role: 'user',
    id: crypto.randomUUID(),
    content: [{ type: 'text', text: note.text }],
    source: {
      kind: ADVISOR_SOURCE_KIND,
      form: 'notice',
      summary: boundSummary(`[${note.severity}] ${note.text}`),
    },
  }
}

/**
 * advisor 投递器。
 * @param {object} options
 * @param {(sessionId: string) => object|undefined} [options.lookupAgent] - agent 注册表兜底（ctx.agents.get）
 * @param {number} [options.immuneTurns] - steer 冷却：投递后 N 个主回合内降级 inject（默认 2）
 * @param {string[]} [options.steerSeverities] - 走 steer 的等级（缺省 nit/concern/blocker）
 * @param {boolean} [options.infoInject] - info 是否也注入（缺省 false=只记录）
 */
export class AdvisorDelivery {
  constructor(options = {}) {
    this.lookupAgent = options.lookupAgent ?? (() => undefined)
    this.immuneTurns = Number.isInteger(options.immuneTurns) ? options.immuneTurns : 2
    this.steerSeverities = Array.isArray(options.steerSeverities) ? options.steerSeverities : ['nit', 'concern', 'blocker']
    this.infoInject = options.infoInject === true
    /** agent.id → agent（agent.id === session.id）。 */
    this.agents = new Map()
    /** 冷却闩锁：还需完成的主回合数（>0 = 武装中）。 */
    this.cooldown = new Map()
  }

  /** agent/created：登记（keyed by agent.id）。 */
  registerAgent(agent) {
    if (agent?.id !== undefined) this.agents.set(agent.id, agent)
  }

  /** agent/disposed / session/disposed：注销（冷却一并清除）。 */
  unregisterAgent(sessionId) {
    this.agents.delete(sessionId)
    this.cooldown.delete(sessionId)
  }

  /** 一个主回合完成：递减冷却（observer onSteppedTurnEnd 驱动）。 */
  onSteppedTurnEnd(sessionId) {
    const remaining = this.cooldown.get(sessionId)
    if (remaining === undefined || remaining <= 0) return
    if (remaining <= 1) this.cooldown.delete(sessionId)
    else this.cooldown.set(sessionId, remaining - 1)
  }

  /** 表面重写：重置冷却（observer onRewrite 驱动；契约 §6 全量重放 + 重置冷却）。 */
  reset(sessionId) {
    this.cooldown.delete(sessionId)
  }

  /** 配置热更（冷却长度/steer 等级/info 注入原地生效）。 */
  configure(options = {}) {
    if (Number.isInteger(options.immuneTurns)) this.immuneTurns = options.immuneTurns
    if (Array.isArray(options.steerSeverities)) this.steerSeverities = options.steerSeverities
    if (options.infoInject !== undefined) this.infoInject = options.infoInject === true
  }

  /**
   * 投递一条意见。
   * @param {string} sessionId - 主会话 id
   * @param {{severity: string, text: string}} note
   * @returns {'steer'|'inject'|'recorded'|false} false = 缺 agent，调用方记 dropped
   */
  route(sessionId, note) {
    const agent = this.agents.get(sessionId) ?? this.lookupAgent(sessionId)
    if (agent === undefined || agent === null) {
      console.warn(`[dsh-agents] advisor：会话 ${sessionId} 无 agent，意见丢弃（severity=${note?.severity}）`)
      return false
    }
    // info 默认只记录不打扰（面板可见，主会话不受影响）
    if (note.severity === 'info' && !this.infoInject) return 'recorded'
    const message = buildAdvisorMessage(note)
    // info 即使注入也永不 steer（最低等级不值得打断）
    if (note.severity === 'info') {
      if (typeof agent.inject !== 'function') {
        console.warn(`[dsh-agents] advisor：会话 ${sessionId} 的 agent 无 inject()，info 意见丢弃（绝不回退 steer）`)
        return false
      }
      agent.inject(message)
      return 'inject'
    }
    const steering = this.steerSeverities.includes(note.severity)
    const cooling = (this.cooldown.get(sessionId) ?? 0) > 0
    if (steering && !cooling) {
      if (this.immuneTurns > 0) this.cooldown.set(sessionId, this.immuneTurns) // 投递即武装冷却
      if (typeof agent.steer !== 'function') {
        console.warn(`[dsh-agents] advisor：会话 ${sessionId} 的 agent 无 steer()，改走 inject`)
        if (typeof agent.inject !== 'function') return false
        agent.inject(message)
        return 'inject'
      }
      agent.steer(message)
      return 'steer'
    }
    // 降级 inject（severity 不在列表 或 冷却窗口内）
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return 'inject'
    }
    if (typeof agent.steer === 'function') {
      agent.steer(message)
      return 'steer'
    }
    console.warn(`[dsh-agents] advisor：会话 ${sessionId} 的 agent 既无 steer() 也无 inject()，意见丢弃`)
    return false
  }
}