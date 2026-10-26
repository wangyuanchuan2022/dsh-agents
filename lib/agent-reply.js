/**
 * 极简回复通道（R3-B1 子特性③，S4）——own 层 agent_reply + 插件内部直投
 * sendToSession + 模式解析闸门 + 唤醒频控熔断（V3-2）+ 投递审计行（OQ#2）。
 *
 * 通道本体（设计 §2.3，权限边界即 API 形状）：
 *   1. own 层单工具 agent_reply：仅当策略 `personaMode='minimal'` 且
 *      `replyChannel='org'` 时对会话注册（agent/created 挂点）；own 层注册
 *      豁免 restrict（S2 P4 活体实证，dsh-tools view() :2975-2978——restrict
 *      只过滤继承面，永不过滤 own 层）。target 在注册时钉死为策略文件的
 *      orgId，**工具 schema 无 target 参数**——非 ORG 目标物理不可达；
 *      execute 层再兜底：即便调用方塞了多余参数也只读 message。
 *   2. 插件内部直投函数 sendToSession(targetId, msg, opts)：供插件自身通知
 *      复用；**缺省 inject（不唤醒）**；唤醒类（followup/steer）仅当 target
 *      落在**发送方策略文件**的 orgId 单元素白名单（orgId 单源——形态③热改
 *      orgId 即刻生效）。
 *   3. 模式解析闸门（纯函数）：org+idle→followup / org+running→steer /
 *      非 org 唤醒→降级 inject / offline→{delivered:false, reason:'offline'}
 *      结构化返回，全路径不抛未捕获异常（AC3-1/AC3-3）。
 *   4. 频控熔断（V3-2）：per 发送会话对唤醒类投递滑动窗口频控（缺省 60 秒
 *      窗口 ≤3 次，常数配置化），超限**自动降级 inject（消息不丢、唤醒不发）**
 *      ＋审计降级标注；连续降级 ≥10 次 → 熔断该会话唤醒通道至会话结束
 *      （disposed 清态），熔断事件 inject 告知组织者。
 *   5. 审计行（OQ#2 裁决落点）：`<dataDir>/reply-audit.jsonl` 追加单行 JSON，
 *      每次投递尝试一条（含 offline 失败与降级事件）；dataDir 与 advisor
 *      配置/toolscope 策略同一条解析链——持久面，非 agent-out 临时区。
 *   6. 群发原语不实现：无 room:/project:/多收件人路径（API 形状即边界）。
 *
 * 恢复语义（V3-6/缺 5）：delivered:false（orgId 失效等）不自动重试（防唤醒
 * 风暴）；工具把结构化失败返回给调用会话，由其在产出报告如实注明；恢复通道
 * =形态③热改策略文件 orgId。
 *
 * @module dsh-agents/agent-reply
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 投递审计文件名（OQ#2 裁决：dataDir 持久面，追加单行 JSON）。 */
export const REPLY_AUDIT_FILENAME = 'reply-audit.jsonl'

/** V3-2 缺省常数（常数配置化：WakeRateLimiter 构造器逐项覆写）。 */
export const REPLY_DEFAULTS = Object.freeze({ windowMs: 60_000, windowMax: 3, breakAfter: 10 })

/** agent_reply 描述（AC1-3 单独计量：≤200 字节且 ≤120 字；run.mjs 门线断言）。 */
export const REPLY_TOOL_DESCRIPTION
  = '回复组织者会话（目标已钉死，无 target 参数）：缺省只投不唤醒；对方 idle 则唤醒、running 同回合注入；离线返回失败不重试。'

/** 审计行 task 引用截断上限（引用非全文；单行 JSON 保持可读）。 */
const TASK_REF_MAX = 200

/**
 * 任务引用规整（审计行「任务引用」字段）：压平空白 + 截断至 200 字符。
 * @param {string} task
 * @returns {string}
 */
export function taskRef(task) {
  const text = String(task ?? '').replace(/\s+/g, ' ').trim()
  return text.length > TASK_REF_MAX ? `${text.slice(0, TASK_REF_MAX - 1)}…` : text
}

/**
 * 模式解析闸门（纯函数，AC3-1 矩阵的判定核）。
 *
 * | isOrg | targetState | wake | → mode |
 * |---|---|---|---|
 * | true | running | true | steer（同回合可见，不打断）|
 * | true | idle | true | followup（唤醒开新回合）|
 * | false | idle/running | true | inject＋degraded='wake-denied-non-org'（唤醒拒绝，消息不丢）|
 * | 任意 | idle/running | false | inject（缺省只投不唤醒）|
 * | 任意 | 其他（含 undefined）| 任意 | offline（结构化失败，调用方不投递）|
 *
 * @param {{isOrg: boolean, targetState: ('idle'|'running'|string|undefined|null), wake?: boolean}} input
 * @returns {{mode: 'followup'|'steer'|'inject'|'offline', wake: boolean, degraded: string|null}}
 */
export function resolveDeliveryMode({ isOrg, targetState, wake = false } = {}) {
  if (targetState !== 'idle' && targetState !== 'running') {
    return { mode: 'offline', wake: false, degraded: null }
  }
  if (!wake) return { mode: 'inject', wake: false, degraded: null }
  if (!isOrg) return { mode: 'inject', wake: false, degraded: 'wake-denied-non-org' }
  return targetState === 'running'
    ? { mode: 'steer', wake: true, degraded: null }
    : { mode: 'followup', wake: true, degraded: null }
}

/**
 * 唤醒类滑动窗口频控器（V3-2）。
 *
 * 语义（按发送会话独立记账）：
 *   - 滑动窗口：最近 windowMs 内的唤醒类**请求**（含被降级的）超过 windowMax
 *     次 → 本次降级 inject（消息不丢、唤醒不发）；
 *   - 连续降级计数只在某次请求**获准唤醒**时清零；连续降级达 breakAfter 次
 *     → 熔断该会话唤醒通道（之后一律 inject）**至会话结束**（clear 解除）；
 *   - `now` 可注入（测试拨钟，不等真实 60 秒）。
 */
export class WakeRateLimiter {
  /**
   * @param {{windowMs?: number, windowMax?: number, breakAfter?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : REPLY_DEFAULTS.windowMs
    this.windowMax = Number.isInteger(options.windowMax) && options.windowMax > 0 ? options.windowMax : REPLY_DEFAULTS.windowMax
    this.breakAfter = Number.isInteger(options.breakAfter) && options.breakAfter > 0 ? options.breakAfter : REPLY_DEFAULTS.breakAfter
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** sessionId → 最近唤醒类请求时间戳数组（滑动窗口原料）。 */
    this.windows = new Map()
    /** sessionId → 当前连续降级次数。 */
    this.consecutive = new Map()
    /** 已熔断的发送会话（至会话结束）。 */
    this.brokenSet = new Set()
  }

  /**
   * 一次唤醒类请求过闸。
   * @param {string} sessionId - 发送会话（记账键）
   * @returns {{allowed: boolean, reason: string|null, consecutive: number, circuitBroken: boolean}}
   *   circuitBroken=true 仅在本次请求恰好触发熔断的那一次为 true（下游据此广播）。
   */
  request(sessionId) {
    if (this.brokenSet.has(sessionId)) {
      return { allowed: false, reason: 'circuit-broken', consecutive: this.consecutive.get(sessionId) ?? 0, circuitBroken: false }
    }
    const t = this.now()
    const win = (this.windows.get(sessionId) ?? []).filter((ts) => t - ts < this.windowMs)
    win.push(t)
    this.windows.set(sessionId, win)
    if (win.length > this.windowMax) {
      const n = (this.consecutive.get(sessionId) ?? 0) + 1
      this.consecutive.set(sessionId, n)
      const circuitBroken = n >= this.breakAfter
      if (circuitBroken) this.brokenSet.add(sessionId)
      return { allowed: false, reason: 'window-exceeded', consecutive: n, circuitBroken }
    }
    this.consecutive.delete(sessionId) // 获准唤醒：连续降级计数清零
    return { allowed: true, reason: null, consecutive: 0, circuitBroken: false }
  }

  /** 该会话唤醒通道是否已熔断。 */
  broken(sessionId) {
    return this.brokenSet.has(sessionId)
  }

  /** 会话结束清态（agent/disposed · session/disposed 挂点调用）。 */
  clear(sessionId) {
    this.windows.delete(sessionId)
    this.consecutive.delete(sessionId)
    this.brokenSet.delete(sessionId)
  }
}

/** 投递消息形态（user-role + 插件来源标记；P3 探针活体验证过宿主拼接语义）。 */
function buildReplyMessage({ from, text }) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: `【agent_reply·来自 ${from}】\n${String(text)}` }],
    source: { kind: 'plugin', plugin: 'dsh-agents' },
  }
}

/**
 * own 层 agent_reply 工具定义工厂（schema 无 target 参数——AC3-2；
 * 目标与发送方身份在注册时经闭包钉死，execute 只读 message）。
 *
 * @param {{fromId: string, orgId: string|null, task: string, send: (input: {text: string}) => object}} deps
 * @returns {object} 宿主工具定义（name/description/parameters/output/execute）
 */
export function agentReplyTool({ fromId, orgId, task, send }) {
  void orgId // target 由 send 闭包钉死；orgId 仅作文档性入参（防误用：注册点必须显式声明目标）
  return {
    name: 'agent_reply',
    description: REPLY_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '回复正文（纯文本，送达组织者会话）' },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          delivered: { type: 'boolean', description: 'false=未送达（结构化失败，不自动重试）' },
          mode: { type: 'string', enum: ['followup', 'steer', 'inject', 'offline', 'skipped'] },
          reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          degraded: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '降级标注：window-exceeded/circuit-broken/wake-denied-non-org' },
        },
        required: ['ok', 'delivered', 'mode', 'reason', 'degraded'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `agent_reply：${value.delivered ? `已投递（${value.mode}${value.degraded ? `，降级 ${value.degraded}` : ''}）` : `未投递（${value.reason ?? '未知原因'}）`}`,
      }],
    },
    async execute(args) {
      const text = String(args?.message ?? '').trim()
      if (text === '') {
        return { ok: false, delivered: false, mode: 'skipped', reason: 'empty-message', degraded: null }
      }
      return send({ text })
    },
  }
}

/**
 * 安装极简回复通道：agent/created 按策略注册 own 层 agent_reply；
 * agent/disposed · session/disposed 清频控态（熔断至会话结束的「会话终」锚点）。
 * 事件面缺失（假宿主/裁剪快照）时告警并返回 null——插件其余能力不受影响
 * （toolscope 管线同款降级）。任何注册失败 fail-open：会话没有回复工具但
 * 照常工作，响亮留痕。
 *
 * @param {object} deps
 * @param {object} deps.ctx - 插件上下文（on 事件订阅面 + agents 服务兜底）
 * @param {object} deps.store - ToolscopeStore（策略文件读：orgId 单源）
 * @param {string} [deps.dataDir] - 审计落点目录（advisorDataDir 同源解析链）
 * @param {boolean} [deps.enabled=true] - 消融联动（toolscopeEnabled：策略面关＝orgId 数据源关，回复通道一并停）
 * @param {object} [deps.agents] - agents 服务（缺省走 ctx.agents；测试注入假服务）
 * @param {WakeRateLimiter} [deps.limiter] - 频控器（缺省按 REPLY_DEFAULTS 新建）
 * @param {string} [deps.auditPath] - 审计文件全路径（缺省 <dataDir>/reply-audit.jsonl；测试隔离用）
 * @param {() => number} [deps.now] - 时钟注入（测试拨钟）
 * @param {object} [deps.logger] - { warn?, error? }
 * @returns {object|null} { dispose, onCreated, onDisposed, sendToSession, audit } 或 null
 */
export function installAgentReply(deps = {}) {
  const { ctx, store, dataDir, enabled = true, agents = null, limiter = null, auditPath = null, logger = console } = deps
  if (enabled === false) return null
  if (typeof ctx?.on !== 'function') {
    logger.warn?.('[dsh-agents] reply：当前上下文没有 ctx.on 事件订阅面，回复通道未接线（minimal 会话将没有 agent_reply）')
    return null
  }
  const clock = typeof deps.now === 'function' ? deps.now : Date.now
  const limiterImpl = limiter instanceof WakeRateLimiter ? limiter : new WakeRateLimiter({ now: clock })
  // agents 可注入两种形态：服务对象（{get}，宿主 agents 服务/测试假服务）或
  // 取值函数；缺省走 ctx.agents（advisor getAgent 同款惰性解析，服务晚挂载自愈）。
  const getAgent = typeof agents === 'function'
    ? agents
    : (id) => {
      try {
        if (agents && typeof agents.get === 'function') return agents.get(id) ?? undefined
        return ctx?.agents?.get?.(id) ?? undefined
      } catch { return undefined }
    }
  const file = auditPath ?? join(String(dataDir ?? ''), REPLY_AUDIT_FILENAME)
  /** 有界内存环（测试/S5 读数面；持久真相在 jsonl 文件）。 */
  const ring = []

  /**
   * 审计行（OQ#2）：每次投递尝试一条，append 单行 JSON 到持久面。
   * 写盘失败不抛（审计是观测面不是投递主链）：内存环仍记，error 响亮留痕。
   */
  const audit = (record) => {
    const line = { kind: 'reply', time: new Date(clock()).toISOString(), ...record }
    ring.push(line)
    if (ring.length > 200) ring.splice(0, ring.length - 200)
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
    } catch (error) {
      logger.error?.(`[dsh-agents] reply：审计行写盘失败（不影响投递）：${error?.message ?? error}`)
    }
    return line
  }

  /** orgId 单元素白名单：发送方自己策略文件的 orgId（replyChannel='org' 才有）。 */
  const orgWhitelistOf = (from) => {
    try {
      const policy = store.read(from)
      return policy?.replyChannel === 'org' && policy?.orgId ? [policy.orgId] : []
    } catch {
      return []
    }
  }

  /** 熔断事件告知组织者：inject 不唤醒（不占对方回合）；失败仅日志，不影响主链。 */
  const notifyOrgBroken = ({ from, targetId }) => {
    try {
      const agent = getAgent(targetId)
      if (!agent || typeof agent.inject !== 'function') return
      agent.inject(buildReplyMessage({
        from,
        text: `⚠️ 会话 ${from} 的唤醒类投递已连续降级达上限（V3-2），其对本通道的唤醒已熔断至会话结束，后续一律只投不唤醒。`,
      }))
      audit({ from, to: targetId, form: 'inject', task: 'circuit-break-notice', delivered: true, reason: null, degraded: null })
    } catch (error) {
      logger.error?.(`[dsh-agents] reply：熔断通知失败（不影响投递主链）：${error?.message ?? error}`)
    }
  }

  /**
   * 插件内部直投函数（供插件自身通知复用）：缺省 inject 不唤醒；唤醒类仅当
   * target 落在发送方策略文件的 orgId 单元素白名单，且受同一频控熔断约束。
   * 全路径结构化返回，不抛未捕获异常（AC3-3）。
   *
   * @param {string} targetId - 目标会话 id
   * @param {string} text - 消息正文
   * @param {{from?: string, task?: string, wake?: boolean}} [opts]
   * @returns {{ok: boolean, delivered: boolean, mode: string, reason: string|null, degraded: string|null}}
   */
  const sendToSession = (targetId, text, { from = 'dsh-agents', task = '', wake = false } = {}) => {
    const agent = getAgent(targetId)
    if (!agent) {
      // offline：store 无活体条目（P3 负例语义）——结构化失败，不抛、不重试。
      audit({ from, to: targetId, form: 'offline', task: taskRef(task), delivered: false, reason: 'offline', degraded: null })
      return { ok: false, delivered: false, mode: 'offline', reason: 'offline', degraded: null }
    }
    const whitelist = orgWhitelistOf(from)
    let decision = resolveDeliveryMode({ isOrg: whitelist.includes(targetId), targetState: agent.status, wake })
    if (decision.wake) {
      const gate = limiterImpl.request(from)
      if (!gate.allowed) {
        decision = { mode: 'inject', wake: false, degraded: gate.reason === 'circuit-broken' ? 'circuit-broken' : 'window-exceeded' }
        if (gate.circuitBroken) notifyOrgBroken({ from, targetId: whitelist[0] ?? targetId })
      }
    }
    try {
      agent[decision.mode](buildReplyMessage({ from, text }))
    } catch (error) {
      logger.error?.(`[dsh-agents] reply：投递调用抛错（结构化返回，不重试）：${from}→${targetId} ${error?.message ?? error}`)
      audit({ from, to: targetId, form: decision.mode, task: taskRef(task), delivered: false, reason: 'deliver-threw', degraded: decision.degraded })
      return { ok: false, delivered: false, mode: decision.mode, reason: 'deliver-threw', degraded: decision.degraded }
    }
    audit({ from, to: targetId, form: decision.mode, task: taskRef(task), delivered: true, reason: null, degraded: decision.degraded })
    return { ok: true, delivered: true, mode: decision.mode, reason: null, degraded: decision.degraded }
  }

  const onCreated = (agent) => {
    const id = agent?.id
    if (!id) return
    let policy = null
    try {
      policy = store.read(id)
    } catch (error) {
      logger.error?.(`[dsh-agents] reply：策略文件读取抛错（不注册 agent_reply）：${id} ${error?.message ?? error}`)
      return
    }
    // 注册门控：仅 minimal × replyChannel='org'（裁 4：minimal 轨同事务写全整集
    // 含 replyChannel='org'；role 轨/无策略/其他通道一律零触碰）。
    if (!policy || policy.personaMode !== 'minimal' || policy.replyChannel !== 'org') return
    if (!policy.orgId) {
      audit({ from: id, to: null, form: 'skipped', task: taskRef(policy.task), delivered: false, reason: 'no-org-target', degraded: null })
      return
    }
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.register !== 'function') {
      audit({ from: id, to: policy.orgId, form: 'skipped', task: taskRef(policy.task), delivered: false, reason: 'tools-face-unavailable', degraded: null })
      return
    }
    const definition = agentReplyTool({
      fromId: id,
      orgId: policy.orgId,
      task: policy.task ?? '',
      // 回复即唤醒类请求（闸门解析 idle→followup / running→steer；受频控熔断）。
      send: ({ text }) => sendToSession(policy.orgId, text, { from: id, task: policy.task ?? '', wake: true }),
    })
    try {
      tools.register(definition)
    } catch (error) {
      logger.error?.(`[dsh-agents] reply：agent_reply 注册失败（fail-open，会话无回复工具）：${id} ${error?.message ?? error}`)
      audit({ from: id, to: policy.orgId, form: 'skipped', task: taskRef(policy.task), delivered: false, reason: 'register-threw', degraded: null })
    }
  }

  const onDisposed = (id) => {
    if (!id) return
    limiterImpl.clear(id)
  }

  const disposers = []
  disposers.push(ctx.on('agent/created', ({ agent } = {}) => {
    try { onCreated(agent) } catch (error) {
      logger.error?.(`[dsh-agents] reply：created 处理异常（fail-open）：${error?.message ?? error}`)
    }
  }, { global: true }))
  disposers.push(ctx.on('agent/disposed', ({ agent } = {}) => {
    try { onDisposed(agent?.id) } catch (error) {
      logger.error?.(`[dsh-agents] reply：disposed 处理异常：${error?.message ?? error}`)
    }
  }, { global: true }))
  disposers.push(ctx.on('session/disposed', (session) => {
    try { onDisposed(session?.id) } catch (error) {
      logger.error?.(`[dsh-agents] reply：session/disposed 处理异常：${error?.message ?? error}`)
    }
  }, { global: true }))

  return {
    onCreated,
    onDisposed,
    /** 插件内部直投原语（通知复用；缺省 inject）。 */
    sendToSession,
    /** 审计读数面（内存环快照；持久真相在 jsonl）。 */
    audit: () => [...ring],
    /** 频控器引用（S5/测试读数：broken/consecutive）。 */
    limiter: limiterImpl,
    dispose() {
      for (const d of disposers.splice(0)) {
        try { d?.() } catch { /* 幂等 */ }
      }
    },
  }
}
