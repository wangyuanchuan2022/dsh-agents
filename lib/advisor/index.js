/**
 * advisor 装配（契约 §1 配置键 + §5 事件接线 + 模型回落链）。
 *
 * `installAdvisor(ctx, config, deps)` 装完整评审能力：
 *
 * - **模型回落链**（契约 §1，**不继承会话模型**）：
 *   advisorProvider/advisorModel 任一为空 → 读 **HIGH 档当前路由**
 *   （settings 服务 tiers.HIGH → 回落 bundle patch 的 config.tiers.HIGH，
 *   两者都拿不到则 runtime.status='error' 并在记录/响应里说明）。
 *   判「是否回落」通过响应字段 modelSource: 'config' | 'HIGH'；
 * - **llm 服务必须走 root 解析链**（照抄 lib/index.js 的 rootOf/resolveLlm）：
 *   隔离作用域里 ctx.llm 可能解析得到却缺 provider 目录——
 *   `ctx.get?.('root') ?? ctx.root` → `root.get('llm')` → `root.llm` → 本 ctx 兜底；
 * - **事件接线**（全 {global:true}）：session/event → observer；
 *   agent/created|disposed、session/disposed → 生命周期对称清理；
 * - **per-session 运行时**：签名变化时重建；dispose 幂等。
 *
 * @module dsh-agents/advisor/index
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AdvisorStore } from './store.js'
import { AdvisorDelivery } from './delivery.js'
import { AdvisorObserver } from './observer.js'
import { AdvisorRuntime, DEFAULT_ADVISOR_SYSTEM_PROMPT } from './runtime.js'
import { createAdvisorHandler, ADVISOR_ENDPOINT } from './api.js'

export { ADVISOR_ENDPOINT }

/** advisor 数据目录的环境变量覆盖（单测/冒烟隔离用，见 resolveAdvisorDataDir）。 */
export const ADVISOR_DATA_DIR_ENV = 'DSH_AGENTS_ADVISOR_DATA_DIR'

/** 取证开关：设任意非空值即把评审调用的**完整 chunk 序列**逐条落盘到 <dataDir>/chunk-trace.jsonl。 */
/**
 * 取证开关：设任意非空值即把评审调用的**完整 chunk 序列**逐条落盘到 <dataDir>/chunk-trace.jsonl。
 * 等价方式：数据目录下创建名为 `trace-on` 的哨兵文件。
 * 两者都**随建随用、随删随停，无需重启**（2026-10-03 修正：早先实现是构造期一次求值，
 * 与「无需重启」这句宣称不符，导致取证白跑一轮 A/B）。
 */
export const ADVISOR_TRACE_ENV = 'DSH_AGENTS_ADVISOR_TRACE'

/**
 * 数据目录缺省值——**锚在用户级 DSH 目录，绝不随宿主进程 cwd 漂移**。
 * 事故记录（2026-10-03）：早先实现用 `join(宿主进程工作目录, '.dsh-agents', 'advisor')`，
 * 而 DSH 进程 cwd = `C:\Users\ycwan`，于是数据落到了用户主目录；且冒烟测试直写真实
 * 目录，遗留 config.json 把评审默认打开、模型指到 MEDIUM 档，构成「默认值偏离」的假象。
 */
export const DEFAULT_ADVISOR_DATA_DIR = join(homedir(), '.dsh', 'plugins-data', 'dsh-agents', 'advisor')

/**
 * 解析数据目录，优先级：显式配置 > 环境变量 > 稳定默认路径。
 *
 * 环境变量存在的意义是**让冒烟/单测与真实数据物理隔离**——测试只要导出
 * `DSH_AGENTS_ADVISOR_DATA_DIR=<临时目录>`，构造期就绝不会触碰用户数据目录
 * （回归断言见 tests/advisor.test.mjs 的 dataDir 组）。
 *
 * @param {unknown} configured - 配置里的 advisorDataDir（未规范化）
 * @returns {string} 绝对或相对路径（相对路径由调用方约定基准）
 */
export function resolveAdvisorDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  const fromEnv = process.env[ADVISOR_DATA_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return DEFAULT_ADVISOR_DATA_DIR
}

/** 提示词长度上限（契约 §1：advisorSystemPrompt ≤8KB）。 */
export const ADVISOR_SYSTEM_PROMPT_MAX = 8 * 1024

/** 非法配置键（只允许契约 §1 列出的 advisor* 键）。 */
const ALLOWED_KEYS = new Set([
  'advisorEnabled', 'advisorProvider', 'advisorModel', 'advisorDataDir',
  'advisorPanelEnabled', 'advisorMaxMessages', 'advisorMaxQueued',
  'advisorCallTimeoutMs', 'advisorImmuneTurns', 'advisorSteerSeverities',
  'advisorInfoInject', 'advisorSystemPrompt', 'advisorPersistLimit',
])

/** steer 等级白名单（契约 §1 advisorSteerSeverities）。 */
const STEER_SEVERITIES = new Set(['info', 'nit', 'concern', 'blocker'])

/** 非负整数校验（0 合法；负数/非整数/NaN → 抛错）。 */
function readInt(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`dsh-agents: config.${label} 必须是非负整数（收到 ${String(value)}）`)
  return n
}

/**
 * 校验并规范化 advisor 配置（契约 §1）。非法值**大声抛错**——静默兜底会让
 * "改了没生效"变黑盒。
 * @param {object} raw - cordis.patch.yml 的 config
 * @returns {object} 规范化后的 advisor 配置
 */
export function resolveAdvisorConfig(raw = {}) {
  const cfg = raw === null || typeof raw !== 'object' ? {} : raw
  // 只校验 advisor* 键——rawConfig 里还有 tiers/clarifyMode/allowSpawn 等
  // dsh-agents 既有键，把它们当「未知 advisor 键」抛错会让整个插件 boot 失败。
  const advisorOnly = Object.fromEntries(Object.entries(cfg).filter(([key]) => key.startsWith('advisor')))
  for (const key of Object.keys(advisorOnly)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`dsh-agents: 未知 advisor 配置键 "${key}"`)
  }

  const advisorCfg = advisorOnly
  const steerSeveritiesRaw = advisorCfg.advisorSteerSeverities
  let steerSeverities = ['nit', 'concern', 'blocker']
  if (steerSeveritiesRaw !== undefined && steerSeveritiesRaw !== null) {
    if (!Array.isArray(steerSeveritiesRaw)) throw new Error('dsh-agents: config.advisorSteerSeverities 必须是数组')
    for (const item of steerSeveritiesRaw) {
      if (typeof item !== 'string' || !STEER_SEVERITIES.has(item)) {
        throw new Error(`dsh-agents: config.advisorSteerSeverities 含未知等级 "${String(item)}"（合法：info/nit/concern/blocker）`)
      }
    }
    steerSeverities = [...new Set(steerSeveritiesRaw)]
  }
  const provider = advisorCfg.advisorProvider === undefined || advisorCfg.advisorProvider === null
    ? null : String(advisorCfg.advisorProvider).trim()
  const model = advisorCfg.advisorModel === undefined || advisorCfg.advisorModel === null
    ? null : String(advisorCfg.advisorModel).trim()
  if ((provider === null) !== (model === null)) {
    throw new Error('dsh-agents: config.advisorProvider 与 advisorModel 必须成对配置（单给其一非法）')
  }
  if (provider !== null && (provider === '' || model === '')) {
    throw new Error('dsh-agents: config.advisorProvider/advisorModel 不能是空字符串')
  }
  const dataDir = advisorCfg.advisorDataDir === undefined || advisorCfg.advisorDataDir === null
    ? null : String(advisorCfg.advisorDataDir).trim()
  if (dataDir !== null && dataDir === '') throw new Error('dsh-agents: config.advisorDataDir 不能是空字符串')
  const systemPrompt = advisorCfg.advisorSystemPrompt === undefined || advisorCfg.advisorSystemPrompt === null
    ? '' : String(advisorCfg.advisorSystemPrompt)
  if (systemPrompt.length > ADVISOR_SYSTEM_PROMPT_MAX) {
    throw new Error(`dsh-agents: config.advisorSystemPrompt 超过 ${ADVISOR_SYSTEM_PROMPT_MAX} 字节上限`)
  }
  return {
    advisorEnabled: advisorCfg.advisorEnabled === true,
    advisorProvider: provider === '' ? null : provider,
    advisorModel: model === '' ? null : model,
    advisorDataDir: dataDir === '' ? null : dataDir,
    advisorPanelEnabled: advisorCfg.advisorPanelEnabled !== false,
    advisorMaxMessages: readInt(advisorCfg.advisorMaxMessages, 'advisorMaxMessages', 60),
    advisorMaxQueued: readInt(advisorCfg.advisorMaxQueued, 'advisorMaxQueued', 32),
    advisorCallTimeoutMs: readInt(advisorCfg.advisorCallTimeoutMs, 'advisorCallTimeoutMs', 90_000),
    advisorImmuneTurns: readInt(advisorCfg.advisorImmuneTurns, 'advisorImmuneTurns', 2),
    advisorSteerSeverities: steerSeverities,
    advisorInfoInject: advisorCfg.advisorInfoInject === true,
    advisorSystemPrompt: systemPrompt,
    advisorPersistLimit: readInt(advisorCfg.advisorPersistLimit, 'advisorPersistLimit', 200),
  }
}

/**
 * 模型回落链（契约 §1，**不继承会话模型**）。
 * @param {object} config - resolveAdvisorConfig 产物
 * @param {() => object|null} [tierTableOf] - 取 HIGH 档路由（settings 服务 → cordis 基底）
 * @returns {{provider: string|null, model: string|null, modelSource: 'config'|'HIGH'|null, reason: string|null}}
 */
export function resolveAdvisorModel(config, tierTableOf) {
  if (config.advisorProvider !== null && config.advisorModel !== null) {
    return { provider: config.advisorProvider, model: config.advisorModel, modelSource: 'config', reason: null }
  }
  // 双空 → 回落 HIGH 档当前路由（settings → bundle patch 基底）
  let table = null
  try {
    table = typeof tierTableOf === 'function' ? tierTableOf() : null
  } catch { table = null }
  const high = table?.HIGH
  if (high && typeof high.provider === 'string' && high.provider !== '' && typeof high.model === 'string' && high.model !== '') {
    return { provider: high.provider, model: high.model, modelSource: 'HIGH', reason: null }
  }
  return {
    provider: null,
    model: null,
    modelSource: null,
    reason: '未配置 advisorProvider/advisorModel，且 HIGH 档当前路由不可解析（settings 服务与 cordis 基底均拿不到）',
  }
}

/**
 * 安装 advisor。
 * @param {object} ctx - 插件上下文（agents 顶层注入；webServer 动态注入）
 * @param {object} rawConfig - cordis.patch.yml 的 advisor* 键（未规范化）
 * @param {object} deps
 * @param {string} deps.dataDir - 数据目录
 * @param {object} [deps.llm] - llm 服务（**必须经 root 解析链拿**，见 lib/index.js resolveLlm）
 * @param {() => object} [deps.resolveLlm] - llm 惰性解析（**优先于 deps.llm**：服务可能晚于 apply 挂载）
 * @param {() => object} [deps.tierTableOf] - HIGH 档路由提供者（tiersApi.getTable）
 * @param {(sessionId: string) => string|null} [deps.sessionNameOf] - 会话名
 * @param {() => Promise<Record<string, string[]>>} [deps.loadCatalog] - provider→模型目录
 * @param {object} [deps.logger]
 * @returns {{dispose: () => void, ctrl: object}}
 */
export function installAdvisor(ctx, rawConfig, deps = {}) {
  const logger = deps.logger ?? console
  const config = resolveAdvisorConfig(rawConfig)
  const dataDir = resolveAdvisorDataDir(deps.dataDir ?? config.advisorDataDir)
  mkdirSync(dataDir, { recursive: true })
  /**
   * 取证落盘（默认关闭）：ADVISOR_TRACE_ENV 非空时把评审调用的**完整 chunk 序列**
   * （含 finish.reason / usage）逐条写进 <dataDir>/chunk-trace.jsonl。
   * 存在意义：2026-10-03 的「评审返回空内容」需要区分「代码缺陷」与
   * 「特定模型输出形态」，而 runtime 的行为在此保持不变——只观察，不改语义。
   */
  const traceSink = (row) => {
    /**
     * 取证开关联态判定：**每次调用都重新读**环境变量与哨兵文件。
     * 事故记录（2026-10-03）：早先在 installAdvisor 构造期求值一次 traceSink，
     * 于是「重启后 touch 一下 trace-on 即可开」这句宣称与实现不符——哨兵在进程
     * 启动后创建根本不生效，取证被迫多重启一轮、且第一轮 A/B 取到无效证据。
     * 现在哨兵随建随用、随删随停，与对外宣称一致。
     */
    const flag = process.env[ADVISOR_TRACE_ENV]
    const on = (typeof flag === 'string' && flag !== '') || existsSync(join(dataDir, 'trace-on'))
    if (!on) return
    // 取证绝不能影响主流程：写盘失败静默吞掉。
    try { appendFileSync(join(dataDir, 'chunk-trace.jsonl'), `${JSON.stringify({ at: Date.now(), ...row })}\n`) } catch { /* noop */ }
  }
  const store = new AdvisorStore({ dataDir, persistLimit: config.advisorPersistLimit })
  const disposers = []

  const getAgent = (sessionId) => {
    try { return ctx?.agents?.get?.(sessionId) ?? undefined } catch { return undefined }
  }
  const sessionNameOf = deps.sessionNameOf ?? (() => null)
  const sessionMeta = (sessionId) => ({ sessionId, sessionName: sessionNameOf(sessionId) ?? null })

  const delivery = new AdvisorDelivery({
    lookupAgent: (sessionId) => getAgent(sessionId),
    immuneTurns: config.advisorImmuneTurns,
    steerSeverities: config.advisorSteerSeverities,
    infoInject: config.advisorInfoInject,
  })

  const observer = new AdvisorObserver({
    maxMessages: config.advisorMaxMessages,
    getSession: (sessionId) => getAgent(sessionId)?.session,
    sessionMeta,
    onDelta: (sessionId, delta, meta) => {
      try {
        ensureRuntime(sessionId)?.enqueue(delta, meta)
      } catch (error) {
        logger.warn?.(`[dsh-agents] advisor onDelta 抛错（本轮丢弃）：${error?.message ?? error}`)
      }
    },
    onSteppedTurnEnd: (sessionId) => delivery.onSteppedTurnEnd(sessionId),
    onRewrite: (sessionId) => delivery.reset(sessionId),
    logger,
  })

  const runtimes = new Map()
  const signatures = new Map()
  /** 运行时状态镜像（GET 的 runtime 字段；多会话取最近一次）。 */
  const runtimeState = { status: 'idle', lastAt: 0, queue: 0, error: null }

  const currentModel = () => {
    const override = store.readConfig()
    const merged = {
      ...config,
      advisorProvider: override.provider ?? config.advisorProvider,
      advisorModel: override.model ?? config.advisorModel,
      advisorEnabled: override.enabled ?? config.advisorEnabled,
    }
    const route = resolveAdvisorModel(merged, deps.tierTableOf)
    return { route, enabled: merged.advisorEnabled }
  }

  const systemPromptOf = () => {
    const override = store.readConfig()
    const custom = typeof override.systemPrompt === 'string' ? override.systemPrompt : config.advisorSystemPrompt
    return custom !== '' ? custom : DEFAULT_ADVISOR_SYSTEM_PROMPT
  }

  const runtimeSignature = (sessionId) => {
    const { route, enabled } = currentModel()
    if (!enabled) return 'off'
    if (route.modelSource === null) return `error:${route.reason ?? ''}`
    return [
      route.provider, route.model, systemPromptOf(),
      config.advisorMaxQueued, config.advisorCallTimeoutMs, config.advisorPersistLimit,
      JSON.stringify(config.advisorSteerSeverities), config.advisorInfoInject, config.advisorImmuneTurns,
    ].join(' ')
  }

  const ensureRuntime = (sessionId) => {
    const { route, enabled } = currentModel()
    if (!enabled) return undefined
    if (route.modelSource === null) return undefined // 硬门禁：拿不到路由时绝不调模型
    // llm 惰性解析：宿主服务可能晚于 apply 挂载（务必用 root 解析链，见 lib/index.js）
    let llm = null
    try {
      llm = typeof deps.resolveLlm === 'function' ? deps.resolveLlm() : (deps.llm ?? null)
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
      onStatus: (snapshot) => { Object.assign(runtimeState, snapshot) },
      trace: traceSink,
      logger,
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

  // ---- 事件接线（全 {global:true}：隔离作用域下也必须收到全部会话事件）----
  // ctx.on 是宿主事件订阅面；缺失时（假宿主/裁剪版快照）如实告警并不接线，
  // 其余能力（端点 GET/PATCH/POST、记录）仍然可用。
  if (typeof ctx?.on !== 'function') {
    logger.warn?.('[dsh-agents] advisor：当前上下文没有 ctx.on 事件订阅面，自动评审未接线（端点与记录仍可用）')
  } else {
  disposers.push(ctx.on('session/event', (session, event) => {
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
  }, { global: true }))
  disposers.push(ctx.on('session/disposed', (session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
  }, { global: true }))
  } // end ctx.on 接线分支

  /** 手动触发一次评审（契约 §2 POST）：disabled / busy / no-session。 */
  const triggerReview = (sessionId) => {
    const { enabled } = currentModel()
    if (!enabled) return { ok: false, reason: 'disabled' }
    const runtime = runtimes.get(sessionId) ?? ensureRuntime(sessionId)
    if (runtime === undefined) return { ok: false, reason: 'no-session' }
    if (runtime.draining) return { ok: false, reason: 'busy' }
    const session = getAgent(sessionId)?.session
    if (session === undefined || typeof session.deriveMessages !== 'function') {
      return { ok: false, reason: 'no-session' }
    }
    // 手动触发强制全量重放：复位游标后下一次渲染取全部可见消息
    observer.resetCursor(sessionId)
    observer.renderAndEmit(sessionId)
    return { ok: true, reason: null }
  }

  const ctrl = {
    /** 端点 GET/PATCH 的状态快照（契约 §2）。 */
    snapshot() {
      const { route, enabled } = currentModel()
      const limit = config.advisorPersistLimit
      const runtime = route.modelSource === null && enabled
        ? { status: 'error', lastAt: runtimeState.lastAt, queue: runtimeState.queue, error: route.reason }
        : (enabled ? runtimeState : { status: 'disabled', lastAt: runtimeState.lastAt, queue: 0, error: null })
      return {
        enabled,
        provider: route.provider,
        model: route.model,
        modelSource: route.modelSource,
        panelEnabled: config.advisorPanelEnabled,
        runtime: {
          status: runtime.status,
          lastAt: runtime.lastAt,
          queue: runtime.queue,
          error: runtime.error,
        },
        records: store.list(limit),
      }
    },

    /**
     * 应用 PATCH（契约 §2）：enabled 单键、provider/model 成对。
     * 写入 config.json（不扩展宿主 settings schema），并让运行时签名漂移。
     */
    patchConfig(patch) {
      store.writeConfig(patch)
      // 签名变了的运行时重建；关掉则全部停
      for (const sessionId of [...runtimes.keys()]) {
        if (!currentModel().enabled) {
          disposeRuntime(sessionId)
          continue
        }
        if (signatures.get(sessionId) !== runtimeSignature(sessionId)) {
          disposeRuntime(sessionId)
          ensureRuntime(sessionId)
        }
      }
    },

    triggerReview,

    /** 测试/内部钩子：当前 runtime 状态。 */
    runtimeOf: (sessionId) => runtimes.get(sessionId),
  }

  // ---- HTTP 端点（webServer 缺失时静默跳过——设置卡会显示不可用）----
  try {
    ctx.inject?.(['webServer'], (httpCtx) => {
      httpCtx.effect(() => httpCtx.webServer.register({
        kind: 'exact',
        path: ADVISOR_ENDPOINT,
        handler: createAdvisorHandler({ ctrl, loadCatalog: deps.loadCatalog }),
      }), 'dsh-agents: advisor endpoint')
    })
  } catch (error) {
    console.error('[dsh-agents] advisor 端点接线失败（面板将显示不可用）：', error?.message ?? error)
  }

  let disposed = false
  return {
    dispose: () => {
      if (disposed) return // 幂等
      disposed = true
      for (const d of [...disposers].reverse()) {
        try { d() } catch (error) { logger.warn?.(`[dsh-agents] advisor disposer 抛错：${error?.message ?? error}`) }
      }
      for (const sessionId of [...runtimes.keys()]) disposeRuntime(sessionId)
      runtimes.clear()
    },
    ctrl,
  }
}