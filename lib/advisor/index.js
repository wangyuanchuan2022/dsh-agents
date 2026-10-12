/**
 * advisor 装配（契约 §1 配置键 + §5 事件接线 + **会话级模型来源**）。
 *
 * `installAdvisor(ctx, config, deps)` 装完整评审能力：
 *
 * - **模型完全手动指定、无任何兜底**（契约 §1，**不继承会话模型**）：
 *   只读**该会话自己**的配置文件 `<dataDir>/sessions/<base64url(sessionId)>.json`
 *   里的 provider/model；未指定即该会话 advisor 不工作，端点以
 *   `modelSource:'unset'` 如实说明。**没有 HIGH 档回落、没有全局 config 兜底**
 *   ——`advisorEnabled`/`advisorProvider`/`advisorModel` 三个 cordis 配置键只为
 *   兼容旧配置而继续被解析，**不参与任何生效判定**（解析到即一次性告警）。
 * - **启用也是会话级**：`enabled` **只**来自该会话自己的配置；任何其他会话的
 *   enabled、乃至全局 `config.advisorEnabled`，都**不得单独开启**本会话。
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
import { AdvisorStore, CONFIG_FILE } from './store.js'
import { AdvisorDelivery } from './delivery.js'
import { AdvisorObserver } from './observer.js'
import { AdvisorRuntime, DEFAULT_ADVISOR_SYSTEM_PROMPT } from './runtime.js'
import { createAdvisorHandler, ADVISOR_ENDPOINT } from './api.js'
import { createRetrieval } from './retrieval/index.js'
import { buildContext, renderContextSection, renderUnavailableContext } from './context/build.js'
import { loadDecisions } from './context/decisions.js'
import { screen as screenMessage, tailMessage, TRIGGER_USER, TRIGGER_ASSISTANT, TRIGGER_MANUAL } from './decision/prefilter.js'
import { createAciTools } from './aci/tools.js'
import { runToolLoop } from './aci/loop.js'

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

/**
 * **已废弃、不参与生效判定**的兼容配置键（2026-10-04 S2 / U2）。
 *
 * 这三个键**必须继续留在 `ALLOWED_KEYS`**：`cordis.patch.yml` 随包默认带着它们，
 * 把 ALLOWED_KEYS 成员删掉会让「老配置里还在的键」触发 `未知 advisor 配置键`
 * 而整个插件 boot 失败（A14/A16）。它们现在只被**解析**（保兼容）与**告警**，
 * 运行时判定一律走该会话自己的配置文件。
 *
 * 契约措辞见 docs/advisor-contract.md 第 1 节（deprecated / compatibility-only /
 * does not affect runtime behavior；文案本体在 S5a 落）。
 */
const DEPRECATED_ADVISOR_KEYS = ['advisorEnabled', 'advisorProvider', 'advisorModel']

/**
 * 三个废弃键的**随包默认值**（cordis.patch.yml 里写死的那三行）。
 * 告警只在「值与随包默认不同」时发：等于默认 = 没人配过，不该每次启动刷噪音；
 * 与默认不同（哪怕只是 `''`）= 有人在按旧方式配置，必须提醒。
 */
const DEPRECATED_KEY_DEFAULTS = { advisorEnabled: false, advisorProvider: null, advisorModel: null }

/** 提示词长度上限（契约 §1：advisorSystemPrompt ≤8KB）。 */
export const ADVISOR_SYSTEM_PROMPT_MAX = 8 * 1024

/** 非法配置键（只允许契约 §1 列出的 advisor* 键）。 */
const ALLOWED_KEYS = new Set([
  'advisorEnabled', 'advisorProvider', 'advisorModel', 'advisorDataDir',
  'advisorPanelEnabled', 'advisorMaxMessages', 'advisorMaxQueued',
  'advisorCallTimeoutMs', 'advisorImmuneTurns', 'advisorSteerSeverities',
  'advisorInfoInject', 'advisorSystemPrompt', 'advisorPersistLimit',
  // S2 新增（H-6 四处同步：① 此处 ② resolveAdvisorConfig ③ cordis.patch.yml ④ 契约 §1）
  'advisorContextMaxFiles',
  // S3 新增（同上四处同步；契约 §1 条文留 S5）：agentic 工具循环的往返上限（0 = 关闭循环）
  'advisorMaxToolRounds',
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
  // advisorEnabled/advisorProvider/advisorModel 仍在 ALLOWED_KEYS 里（兼容旧配置，
  // 见 DEPRECATED_ADVISOR_KEYS），但解析结果**不参与任何生效判定**（U2 第 4 条）。
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
  // ⚠️ advisorProvider/advisorModel 是**已废弃键**（见 DEPRECATED_ADVISOR_KEYS）：
  // 这里**只做宽容解析，绝不抛错**。它们已不承载任何生效语义，为一个零作用的键
  // 让整个插件 boot 失败是本末倒置——而且抛错发生在 installAdvisor 的废弃告警
  // **之前**，运维者拿到的是致命报错，永远看不到那条「不影响运行时行为」的告警
  // （告警与实际行为自相矛盾）。半填 / 空串 / 非字符串一律归一成 null。
  const provider = advisorCfg.advisorProvider === undefined || advisorCfg.advisorProvider === null
    || String(advisorCfg.advisorProvider).trim() === ''
    ? null : String(advisorCfg.advisorProvider).trim()
  const model = advisorCfg.advisorModel === undefined || advisorCfg.advisorModel === null
    || String(advisorCfg.advisorModel).trim() === ''
    ? null : String(advisorCfg.advisorModel).trim()
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
    // S2 新增键（四处同步之②）：单轮 L2「相关文件 · 符号精读」的源文件数上限。
    // 0 = 关闭 L2 精读（只保留 L1 文件树/git/搜索）。语义与默认值见 S2 报告与契约 §1。
    advisorContextMaxFiles: readInt(advisorCfg.advisorContextMaxFiles, 'advisorContextMaxFiles', 4),
    // S3 新增键（四处同步之②）：agentic 工具循环的往返上限（缺省 4，【待产品复核 G-15】）。
    // 0 = 关闭工具循环（退回单次调用，S2 行为）。负数/非整数大声抛错（readInt）。
    advisorMaxToolRounds: readInt(advisorCfg.advisorMaxToolRounds, 'advisorMaxToolRounds', 4),
  }
}

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
 * 安装 advisor。
 * @param {object} ctx - 插件上下文（agents 顶层注入；webServer 动态注入）
 * @param {object} rawConfig - cordis.patch.yml 的 advisor* 键（未规范化）
 * @param {object} deps
 * @param {string} deps.dataDir - 数据目录
 * @param {object} [deps.llm] - llm 服务（**必须经 root 解析链拿**，见 lib/index.js resolveLlm）
 * @param {() => object} [deps.resolveLlm] - llm 惰性解析（**优先于 deps.llm**：服务可能晚于 apply 挂载）
 * @param {() => object} [deps.tierTableOf] - **已不再被消费**（S2 起 HIGH 档回落取消；接线为兼容旧调用点保留，见 lib/index.js 装配段注释）
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
  // 旧文件裁决（契约「存在即忽略」）：旧版把 PATCH 结果写在全局 config.json，
  // 现在配置分文件存 <dataDir>/sessions/<base64url(sessionId)>.json，该文件既不读
  // 也不迁移、不删除用户文件——但必须**可见**：否则「我明明开了却没生效」无从查起。
  // 一次性告警（每次启动至多一条）。
  if (existsSync(join(dataDir, CONFIG_FILE))) {
    logger.warn?.(
      `[dsh-agents] advisor：检测到旧全局配置 ${join(dataDir, CONFIG_FILE)}，已停用（不读取、不自动迁移、不删除）；`
      + '配置改为按会话分文件存放，请在本会话面板重新指定模型并开启。',
    )
  }
  // U2 第 4 条：三个兼容键仍被解析（保 boot 兼容），但**不参与生效判定**；
  // 配置里出现即一次性告警，避免维护者误以为改它们还能控制 advisor。
  const deprecatedPresent = DEPRECATED_ADVISOR_KEYS.filter((key) => {
    const value = rawConfig?.[key]
    // 与**随包默认值**逐项比对，而不是「是否 falsy」：随包默认是
    // advisorEnabled:false / advisorProvider:null / advisorModel:null，用 falsy 判
    // 会把 `advisorProvider: ''` 这类**真实的手滑**一起吞掉、连告警都不发。
    return key in (rawConfig ?? {}) && value !== DEPRECATED_KEY_DEFAULTS[key]
  })
  if (deprecatedPresent.length > 0) {
    logger.warn?.(
      `[dsh-agents] advisor：配置键 ${deprecatedPresent.join(' / ')} 已废弃（compatibility-only，不影响运行时行为）；`
      + 'advisor 的启用与评审模型已彻底改为会话级，请在会话面板为该会话单独指定模型并开启。',
    )
  }
  /**
   * 取证落盘（默认关闭）：ADVISOR_TRACE_ENV 非空时把评审调用的**完整 chunk 序列**
   * （含 finish.reason / usage）逐条写进 <dataDir>/chunk-trace.jsonl。
   * 存在意义：2026-10-03 的「评审返回空内容」需要区分「代码缺陷」与
   * 「特定模型输出形态」，而 runtime 的行为在此保持不变——只观察，不改语义。
   */
  // deps.trace allows injecting a custom sink (tests use a throwing stub to prove
  // fail-open). Production always uses the default writer below.
  const traceSink = typeof deps.trace === 'function' ? deps.trace : (row) => {
    /**
     * 取证开关联态判定：**每次调用都重新读**环境变量与哨兵文件。
     * 事故记录（2026-10-03）：早先在 installAdvisor 构造期求值一次 traceSink，
     * 于是「重启后 touch 一下 trace-on 即可开」这句宣称与实现不符——哨兵在进程
     * 启动后创建根本不生效，取证被迫多重启一轮、且第一轮 A/B 取到无效证据。
     * 现在哨兵随建随用、随删随停，与对外宣称一致。
     */
    try {
      const flag = process.env[ADVISOR_TRACE_ENV]
      const on = (typeof flag === 'string' && flag !== '') || existsSync(join(dataDir, 'trace-on'))
      if (!on) return
    // 取证绝不能影响主流程：写盘失败静默吞掉。
    appendFileSync(join(dataDir, 'chunk-trace.jsonl'), `${JSON.stringify({ at: Date.now(), ...row })}\n`)
    } catch { /* fail-open: a failing diagnostics sink must never break the review loop */ }
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

  const systemPromptOf = () => {
    // 会话配置只落 enabled/provider/model 三键，提示词仍是全局配置项（S2 才动）。
    const custom = config.advisorSystemPrompt
    return custom !== '' ? custom : DEFAULT_ADVISOR_SYSTEM_PROMPT
  }

  // ── S2：只读检索面 / 决策保护 / 三层上下文（按 root 缓存）────────────────────
  // root = **会话 cwd 工作区根**（G-16）；宿主 session 形状不可得时回落 deps.cwd，
  // 两者都没有 ⇒ 上下文层显式标「不可用」——**绝不**回落宿主启动目录（既有源码级门禁止）。
  // 测试用 deps.resolutionRootOf 注入夹具根（与 `deps.trace` 同一种注入风格）。
  const retrievalByRoot = new Map()
  const retrievalFor = (root) => {
    let facet = retrievalByRoot.get(root)
    if (facet === undefined) {
      facet = createRetrieval({ root, dataDir, maxEntries: deps.retrievalMaxEntries })
      retrievalByRoot.set(root, facet)
    }
    return facet
  }
  const resolutionRootOf = deps.resolutionRootOf
    ?? ((sessionId) => deps.cwd ?? getAgent(sessionId)?.session?.cwd ?? null)

  /**
   * 三层上下文装配（注入进 runtime 的 `context` 钩子）。
   *
   * - **Base Context**（≤8KB）= 契约锚 + 系统提示 + Project State + 决策保护
   *   —— **不含会话消息历史**（G-2；历史由 runtime 的会话窗口独立承载）；
   * - **Repository Context**（L1+L2，≤40KB）= S1a 的只读检索面；
   *   普通聊天 ⇒ **零检索零子进程**（AC-62，由 `shouldRunRepoAnalysis` 把门）；
   * - 装配抛错由 runtime 兜成 fail-open（见 `runtime.#buildContextSection`）。
   */
  const contextFor = ({ markdown, meta }) => {
    const sessionId = meta?.sessionId
    const root = resolutionRootOf(sessionId)
    // ⚠️ 刻意**不**回落宿主启动目录（既有源码级门禁止该 API 出现在本文件；
    //    advisor 的路径一律不随启动目录漂移）
    if (typeof root !== 'string' || root === '') {
      return { section: renderUnavailableContext('未解析到会话工作区根（resolutionRootOf 未提供且会话未暴露 cwd）⇒ 本轮不做仓库分析'), result: null }
    }
    const retrieval = retrievalFor(root)
    const decisions = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
    const sessionCfg = typeof sessionId === 'string' && sessionId !== '' ? store.readSessionConfig(sessionId) : {}
    const result = buildContext({
      retrieval,
      messageText: markdown,
      systemPrompt: systemPromptOf(),
      decisions,
      project: { phase: sessionCfg.projectPhase ?? null },
      maxFiles: config.advisorContextMaxFiles,
    })
    return { section: renderContextSection(result), result }
  }

  /** 规则预筛（注入进 runtime 的 `prefilter` 钩子；**纯本地规则**、零 token）。 */
  const prefilterFor = ({ text, role, trigger }) => screenMessage({ text, role, trigger })

  /**
   * S3：agentic 工具循环（注入进 runtime 的 `toolLoop` 钩子）。
   *
   * - 工具面按**会话工作区根**现取（`retrievalFor(root)` 复用 S1a 检索面，
   *   不重写第二套）；root 解析不出 ⇒ 空工具集（循环退化为多轮纯文本）；
   * - 预算池**逐次评审新建**，`alreadyUsedBytes` 接收 S2 预取面的已记账字节
   *   ⇒ 预取面与模型工具面**共享同一 40KB 检索段池**（判据 8 的池归属）；
   * - `advisorMaxToolRounds === 0` 时装配层不注入本钩子（runtime 走单次调用）。
   */
  const aciLoop = async (call) => {
    const root = resolutionRootOf(call.meta?.sessionId)
    const retrieval = typeof root === 'string' && root !== '' ? retrievalFor(root) : null
    const prefetchBytes = call.contextResult?.repositoryBytes
    return runToolLoop({
      llm: call.llm,
      provider: call.provider,
      model: call.model,
      systemPrompt: call.systemPrompt,
      messages: call.messages,
      tools: retrieval === null ? [] : createAciTools({ retrieval }),
      maxRounds: config.advisorMaxToolRounds,
      maxTokens: call.maxTokens,
      callTimeoutMs: call.callTimeoutMs,
      signal: call.signal,
      trace: call.trace,
      meta: call.meta,
      alreadyUsedBytes: Number.isFinite(prefetchBytes) ? prefetchBytes : 0,
    })
  }

  const runtimeSignature = (sessionId) => {
    const { route, enabled } = currentModel(sessionId)
    if (!enabled) return 'off'
    if (route.modelSource !== 'session') return `unset:${route.reason ?? ''}`
    return [
      route.provider, route.model, systemPromptOf(),
      config.advisorMaxQueued, config.advisorCallTimeoutMs, config.advisorPersistLimit,
      JSON.stringify(config.advisorSteerSeverities), config.advisorInfoInject, config.advisorImmuneTurns,
    ].join(' ')
    // 注：advisorMaxToolRounds **不进签名**——它是全局配置键（boot 时定值），且
    // aciLoop 每次调用活读 `config.advisorMaxToolRounds`；进签名反而会打破
    // S0-3 的「三态形态逐字锁定」判据而不带来任何重建收益。
  }

  const ensureRuntime = (sessionId) => {
    const { route, enabled } = currentModel(sessionId)
    if (!enabled) return undefined
    if (route.modelSource !== 'session') return undefined // 硬门禁：未指定模型时绝不调模型
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
      onStatus: (snapshot) => { runtimeStates.set(sessionId, { ...snapshot }) },
      trace: traceSink,
      logger,
      // S2：三层上下文装配 + 规则预筛（两个都是**注入式**钩子；缺省 undefined = S1 行为）
      context: contextFor,
      prefilter: prefilterFor,
      // S3：agentic 工具循环（注入式；0 = 关闭 ⇒ undefined，runtime 走单次调用）
      toolLoop: config.advisorMaxToolRounds > 0 ? aciLoop : undefined,
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
    if (!currentModel(session.id).enabled) return
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
    runtimeStates.delete(agent.id) // 会话真的没了才丢状态桶；配置层面的停用保留「上次评审」时间
  }, { global: true }))
  disposers.push(ctx.on('session/disposed', (session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
    runtimeStates.delete(session.id)
  }, { global: true }))
  } // end ctx.on 接线分支

  /** 手动触发一次评审（契约 §2 POST）：
   *  `no-session`（不存在/已 dispose/取不到 agent）/ `unset`（会话在但未配模型）/
   *  `disabled`（配了模型但本会话未开启）/ `busy`。
   *  **恒 200**：失败一律用 reason 表达（契约已冻结该形状，客户端按 payload.ok 分支）。 */
  const triggerReview = (sessionId) => {
    // Q-3 / B16：活跃校验必须在进入 triggerReview 之前，失败不消耗任何额度。
    if (!isActiveSession(sessionId)) return { ok: false, reason: 'no-session' }
    const { route, enabled } = currentModel(sessionId)
    if (route.modelSource !== 'session') return { ok: false, reason: 'unset' }
    if (!enabled) return { ok: false, reason: 'disabled' }
    const runtime = runtimes.get(sessionId) ?? ensureRuntime(sessionId)
    if (runtime === undefined) return { ok: false, reason: 'no-session' }
    if (runtime.draining) return { ok: false, reason: 'busy' }
    const session = getAgent(sessionId)?.session
    if (session === undefined || typeof session.deriveMessages !== 'function') {
      return { ok: false, reason: 'no-session' }
    }
    // 手动触发强制全量重放：复位游标后下一次渲染取全部可见消息。
    // S2（AC-21「补评可用」）：手动补评**不过预筛**——人明确要求评审是最强信号，
    // 被预筛拦过的那一轮可以靠它补评（标记在同一次同步 renderAndEmit 内被消费）。
    manualReviews.add(sessionId)
    observer.resetCursor(sessionId)
    observer.renderAndEmit(sessionId)
    return { ok: true, reason: null }
  }

  const ctrl = {
    /** 端点 GET/PATCH 的状态快照（契约 §2）——**只看该会话自己**的配置与记录。 */
    snapshot(sessionId) {
      const { route, enabled } = currentModel(sessionId)
      const limit = config.advisorPersistLimit
      const state = runtimeStateOf(sessionId)
      const runtime = !enabled
        ? { status: 'disabled', lastAt: state.lastAt, queue: 0, error: null }
        : (route.modelSource === 'session'
          ? state
          : { status: 'error', lastAt: state.lastAt, queue: state.queue, error: route.reason })
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
        records: store.list(sessionId, limit),
      }
    },

    /**
     * 应用 PATCH（契约 §2）：enabled 单键、provider/model 成对，写入**该会话**的
     * per-session 分文件（不扩展宿主 settings schema），并让运行时签名漂移。
     *
     * U2 成对规则**不在这里判**——它已下沉进 `store.writeSessionConfig` 的同一段
     * 同步临界区（F-4）：此处再判一次就是 check-then-act，临界区外的读会让并发
     * PATCH 出现「判过时成立、写时已失效」的竞态。校验失败由 store 抛同步异常，
     * api.js 的既有 catch 转 400。
     */
    patchConfig(sessionId, patch) {
      // P1-1 配套：在 **false → true 的那一刻**，且**观察器此前已持有该会话状态**时，
      // 把游标 seed 到当前长度。
      //
      // 两个条件缺一不可：
      //  ① 只认 false→true 这一跳 —— 对已在跑的会话改 provider/model 绝不能
      //     重 seed，否则会把进行中的增量跳过；
      //  ② 只在观察器**已经见过**该会话时 seed —— P1-1 的早退让「未启用期间的
      //     事件从不进观察器」，但「从未启用过的全新会话」与「中途开启的会话」
      //     在 patchConfig 这一刻**无法区分**（都可能已有若干条消息）。对全新
      //     会话 seed 会把它的**第一轮评审清空**（游标直接落到末尾），这条
      //     代价已实测：会让 5 条既有用例变红。全新会话没有「未消费的增量」
      //     可言，因此不需要 seed。
      const wasEnabled = currentModel(sessionId).enabled
      store.writeSessionConfig(sessionId, patch)
      // 签名变了的运行时重建；关掉则全部停（逐会话比较，别的会话配置变动不影响它）
      for (const sid of [...runtimes.keys()]) {
        if (!currentModel(sid).enabled) {
          disposeRuntime(sid)
          continue
        }
        if (signatures.get(sid) !== runtimeSignature(sid)) {
          disposeRuntime(sid)
          ensureRuntime(sid)
        }
      }
      if (!wasEnabled && currentModel(sessionId).enabled && observer.hasSessionState(sessionId)) {
        const visible = visibleMessageCount(sessionId)
        if (visible !== undefined) observer.seedTo(sessionId, visible)
      }
    },

    triggerReview,

    /** 活跃会话校验（Q-1）：供端点 GET/PATCH 在任何快照计算/写盘之前 fail-closed。 */
    isActiveSession,

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