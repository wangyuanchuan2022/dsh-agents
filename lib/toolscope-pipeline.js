/**
 * restrict 管道（R3-B1 子特性② S3）：把 per-session 工具面策略变成
 * agent/created 挂点上的真实 agent.ctx.tools.restrict 调用。
 *
 * 数据流（时序已被 S2 探针钉死，agent-out/b1-probes.md P2）：
 *   spawn.beforeCreate（全同步）先落盘 <dataDir>/sessions/<b64>.toolscope.json
 *   → agents.create → agent/created 事件（首请求组装之前，serial）→
 *   本模块读策略文件 → 预校验 → restrict({allow|deny}) → disposer 入共享 lift 表
 *   → agent/disposed 清理。prompt 在 create 之后才 followup（spawn.js:283），
 *   因此「任务书正文」唯一时序安全的来源就是策略文件本身（spawn 时随文件落盘）。
 *
 * 宿主契约（@deepseek-ai/dsh dsh-tools/lib/index.js 活体确认，S2 P1/P2/P4）：
 *   1. restrict 只接受 agent 作用域 ctx（agent.ctx.tools.restrict）；
 *   2. allow/deny 含宿主不认识的工具名会**整段抛错**（:2906-2908 区）——所以
 *      管线必须先用 view(agent).restrictableNames 预校验（AC2-3 三件套）；
 *   3. 多次 restrict 是**交集**语义——不 lift 旧的就设新的会「越收越窄」
 *      （AC2-2 必须防），所以任何设置前先 lift-before-set（经共享表）；
 *   4. restrict 返回的 disposer 就是解除句柄；own 层注册的工具天然豁免且
 *      **不在** restrictableNames 里（P4）——因此 allow 名单里绝不能写 own
 *      层工具名（写了即 unknown 必拒），豁免是自动的。
 *
 * MCP 最终名（P1 实证规则，mcpPublicName）：策略数据一律写**最终注册名**
 * （干净名 mcp__server__raw 直通；有损名 normalized 截 51 + '_' + sha256 前
 * 12hex）；管线对名字零改写、按最终名透传。
 *
 * fail-open 方向不变量：本模块任何路径的失败（读面缺失/预校验不过/交叉校验
 * 不过/restrict 抛错）都不抛出、不收缩（或 lift 已设），会话保持全工具面。
 *
 * @module dsh-agents/toolscope-pipeline
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getRole } from './roles.js'
import { loadPersona } from './persona.js'

/** 跨代共享 lift 表的 globalThis 键（V3-1：承 suite sharedLift 实证教训）。 */
export const SHARED_LIFT_SYMBOL = Symbol.for('dsh-agents:toolscope-shared-lift')

/** 模块代次计数（诊断用；同进程每 install 一次递增）。 */
let generationCounter = 0

/**
 * 取（或建）跨代共享 lift 表：Map<sessionId, {dispose, gen, at, action}>。
 * 挂在 globalThis 上——插件 HMR/换代后新模块实例仍能提起旧代设下的 restrict，
 * 防交集叠加锁死（AC2-2 跨代用例）。
 * @returns {Map<string, object>}
 */
export function sharedLiftTable() {
  let table = globalThis[SHARED_LIFT_SYMBOL]
  if (!(table instanceof Map)) {
    table = new Map()
    globalThis[SHARED_LIFT_SYMBOL] = table
  }
  return table
}

/**
 * MCP 工具最终注册名（P1 活体实证规则，源码锚 dsh-mcp-client/lib/index.js:96-102）：
 *   joined     = `mcp__${serverName}__${rawName}`
 *   normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
 *   干净且 ≤64   → joined 原样
 *   否则         → normalized 截 51 + '_' + sha256(`${serverName}\0${rawName}`) 前 12hex
 * hash 输入是**原始** serverName\0rawName（非 normalized）；「有损」判定含字符替换
 * （哪怕替换后未超长）。策略数据写 MCP 工具时用本函数推导最终名，不可猜写。
 * @param {string} serverName - MCP server 注册名
 * @param {string} rawName - server 声明的原始工具名
 * @returns {string} 最终注册名
 */
export function mcpPublicName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && joined.length <= 64) return joined
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`, 'utf8').digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

const NEGATION_LINE = /禁止|不得|不许|禁用/

/**
 * 宽松检测器（子串全量，双向对账的独立实现之二）：对给定候选名逐个做
 * 词边界子串匹配（名字前后不得是 [A-Za-z0-9_-]，防 `subagent-clarify`
 * 误报 subagent）。缺省启用**否定语境豁免**：含「禁止/不得/不许/禁用」的
 * 行里的名字不是需求（只读白名单节以禁止语境提及 write/edit），不进引用集。
 *
 * @param {string} text - 被扫描文本
 * @param {Iterable<string>} names - 候选工具名（构建期=classMap∪coreBase；运行期=restrictableNames）
 * @param {{skipNegatedLines?: boolean}} [opts]
 * @returns {string[]} 命中名（排序去重）
 */
export function looseToolRefs(text, names, opts = {}) {
  const raw = String(text ?? '')
  const body = opts.skipNegatedLines === false
    ? raw
    : raw.split(/\r?\n/).filter((line) => !NEGATION_LINE.test(line)).join('\n')
  const hits = []
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`)
    if (re.test(body)) hits.push(name)
  }
  return hits.sort()
}

/**
 * 保守推导器（族表映射，双向对账的独立实现之一）：任务正文里的显式引用——
 * ① 反引号包名的工具名（显式、逐字）；② 族关键词命中 → 整族成员（「编辑工具」
 * → write/edit）。裸名词不猜（不判定的形态不收，记缺口交给宽松检测器兜底）。
 *
 * @param {string} text - 任务正文（策略文件 task 字段）
 * @param {object} roster - 校验过的 roster 基表（classMap/familyKeywords/coreBase/scanIgnore）
 * @param {Iterable<string>} [extraUniverse] - 额外合法名（运行期传 restrictableNames）
 * @returns {string[]} 推导出的需求名（排序去重）
 */
export function conservativeTaskRefs(text, roster, extraUniverse = []) {
  const raw = String(text ?? '')
  const universe = new Set([...classMapNames(roster.classMap), ...roster.coreBase, ...extraUniverse])
  const ignored = new Set(roster.scanIgnore ?? [])
  const hits = new Set()
  for (const match of raw.matchAll(/`([A-Za-z][A-Za-z0-9_-]*)`/g)) {
    const name = match[1]
    if (universe.has(name) && !ignored.has(name)) hits.add(name)
  }
  const keywords = roster.familyKeywords ?? {}
  for (const [family, words] of Object.entries(keywords)) {
    for (const word of words) {
      if (raw.includes(word)) {
        for (const name of roster.classMap?.[family] ?? []) {
          if (universe.has(name) && !ignored.has(name)) hits.add(name)
        }
      }
    }
  }
  return [...hits].sort()
}

/** classMap 全体成员（构建期扫描宇宙）。 */
export function classMapNames(classMap) {
  const out = []
  for (const members of Object.values(classMap ?? {})) out.push(...members)
  return out
}

/** b64url 反解（文件名 → sessionId；解不开返回空串=不可判活，按死会话处理）。 */
function safeB64UrlDecode(encoded) {
  try {
    const sid = Buffer.from(encoded, 'base64url').toString('utf8')
    return sid.trim() !== '' ? sid : ''
  } catch {
    return ''
  }
}

/**
 * 收缩决策核（纯函数，AC2 断言的主战场）。
 *
 * @param {object} input
 * @param {object} input.policy - 规范化策略记录（toolscope store read 产物）
 * @param {object|null} input.roster - roster 基表（null=数据不可用，role 轨 fail-open）
 * @param {Set<string>} input.restrictable - 该会话 restrictableNames（最终名宇宙）
 * @param {string} input.personaText - 当前人格正文（role 轨 gate 文本之一）
 * @param {string} input.taskText - 策略文件记录的任务正文
 * @returns {object} 决策：{ action:'allow'|'deny'|'skip'|'refuse', reason,
 *   names?, missing?, violations?, needed?, deny? }——names 为 restrict 载荷；
 *   missing=结构化缺失清单；violations=交叉校验违例（宽松检测器抓到的未覆盖引用）。
 */
export function decideToolscope({ policy, roster, restrictable, personaText = '', taskText = '' }) {
  const tier = policy?.toolPolicy?.tier
  const universe = restrictable instanceof Set ? restrictable : new Set(restrictable ?? [])
  const ignore = new Set(roster?.scanIgnore ?? [])
  const audit = { tier: tier ?? null, personaMode: policy?.personaMode ?? null, role: policy?.role ?? null }

  if (tier === 'none') return { action: 'skip', reason: 'tier-none', ...audit }

  // role 轨禁整集替换（裁 3：role 轨仅 grant 放权与 none 豁免；AC2-10 负例）。
  if (tier === 'full' && policy.personaMode === 'role') {
    return { action: 'refuse', reason: 'role-full-forbidden', missing: [], ...audit }
  }

  if (tier === 'full') {
    // 显式整集（minimal 轨/例外档）：allow 名单按最终名逐字透传（含 MCP 名）。
    const allow = [...new Set(policy.toolPolicy.allow ?? [])]
    const missing = allow.filter((name) => !universe.has(name)).sort()
    if (missing.length > 0) {
      // AC2-3 三件套之一：结构化缺失清单（另两件=会话存活+restrict 未调用，由
      // install 层保证：refuse 路径绝不触碰 restrict）。
      return { action: 'refuse', reason: 'unknown-names', missing, ...audit }
    }
    if (allow.length === 0) return { action: 'skip', reason: 'empty-allow', ...audit }
    // 交叉校验硬闸：宽松检测器扫（人格+任务正文），引用不得落在整集之外。
    const violations = gateViolations({ personaText, taskText, universe, ignore, kept: new Set(allow) })
    if (violations.length > 0) {
      return { action: 'refuse', reason: 'ref-coverage', missing: violations, violations, ...audit }
    }
    return { action: 'allow', names: allow, ...audit }
  }

  if (tier === 'grant') {
    if (policy.personaMode !== 'role') return { action: 'skip', reason: 'grant-non-role', ...audit }
    if (!roster) return { action: 'skip', reason: 'roster-unavailable', ...audit }
    const entry = roster.roles?.[policy.role]
    if (!Array.isArray(entry)) {
      // 缺角色 fail-open 不收缩（AC2-11）。
      return { action: 'skip', reason: 'role-not-in-roster', ...audit }
    }
    const needed = new Set([...roster.coreBase, ...entry])
    for (const name of conservativeTaskRefs(taskText, roster, universe)) needed.add(name)
    // grant 放权：显式 allow 名单并入 needed（AC2-10 覆盖语义）。
    for (const name of policy.toolPolicy.allow ?? []) needed.add(name)
    const deny = [...universe].filter((name) => !needed.has(name)).sort()
    const violations = gateViolations({ personaText, taskText, universe, ignore, kept: new Set(needed) })
    if (violations.length > 0) {
      // AC2-6/AC2-9：策略集合覆盖不了任务书引用 ⇒ 拒绝应用 + 缺失清单（fail-open）。
      return { action: 'refuse', reason: 'ref-coverage', missing: violations, violations, needed: [...needed].sort(), deny, ...audit }
    }
    if (deny.length === 0) return { action: 'skip', reason: 'nothing-to-strip', ...audit }
    return { action: 'deny', names: deny, needed: [...needed].sort(), ...audit }
  }

  return { action: 'skip', reason: 'unknown-tier', ...audit }
}

/** 交叉校验硬闸：宽松检测器的引用集中，凡是不被 kept 保留的都是违例。 */
function gateViolations({ personaText, taskText, universe, ignore, kept }) {
  const text = `${personaText ?? ''}\n${taskText ?? ''}`
  const hits = looseToolRefs(text, universe).filter((name) => !ignore.has(name))
  return hits.filter((name) => !kept.has(name))
}

/**
 * G9 对账失败通知去重器：按「类别键」（会话×缺失集）去重，同一键只发一次；
 * 严重度升级（info→warning→critical）允许重发；reset 清键（条件解除语义）。
 */
export class DedupNotifier {
  constructor(emit = (payload) => console.error('[dsh-agents] toolscope：', JSON.stringify(payload))) {
    this.emitFn = emit
    /** key → 已发过的最高严重度 */
    this.seen = new Map()
  }

  notify(key, payload, level = 'warning') {
    const rank = { info: 0, warning: 1, critical: 2 }[level] ?? 1
    const prev = this.seen.get(key)
    if (prev !== undefined && rank <= prev) return false
    this.seen.set(key, rank)
    this.emitFn({ ...payload, level })
    return true
  }

  reset(key) {
    if (key === undefined) this.seen.clear()
    else this.seen.delete(key)
  }
}

/** G9 类别键：会话 × 缺失集（集合内容变了就是新键，会再通知）。 */
export function refuseKey(sessionId, missing) {
  return `toolscope-refuse::${sessionId}::${[...missing].sort().join('|')}`
}

/**
 * 安装 restrict 管道：挂 agent/created（首步即收缩，S2 P2 ①格裁决）与
 * agent/disposed、session/disposed（清理）。事件面缺失（假宿主/裁剪快照）时
 * 告警并返回 null——插件其余能力不受影响（advisor wiring 同款降级）。
 *
 * @param {object} deps
 * @param {object} deps.ctx - 插件上下文（on 事件订阅面）
 * @param {object} deps.store - ToolscopeStore（读策略文件）
 * @param {object|null} deps.roster - roster 基表（null=role 轨全 fail-open）
 * @param {boolean} [deps.enabled=true] - 消融开关（resolveConfig toolscopeEnabled）
 * @param {object} [deps.logger] - { warn?, error? }
 * @returns {object|null} { dispose, onCreated, onDisposed, audit } 或 null
 */
export function installToolscopePipeline(deps) {
  const { ctx, store, roster = null, enabled = true, logger = console } = deps
  if (enabled === false) return null
  if (typeof ctx?.on !== 'function') {
    logger.warn?.('[dsh-agents] toolscope：当前上下文没有 ctx.on 事件订阅面，收缩管道未接线（fail-open 不收缩）')
    return null
  }
  const gen = ++generationCounter
  const notifier = new DedupNotifier()
  /** 运行期审计（V3-3 生效率读数原料；有界）。 */
  const auditLog = []
  const audit = (record) => {
    auditLog.push({ at: Date.now(), ...record })
    if (auditLog.length > 200) auditLog.splice(0, auditLog.length - 200)
  }
  /** 活体会话集合（留存清扫的 keep 集；与 lift 表独立——未收缩的活会话也在）。 */
  const liveSessions = new Set()

  const resolvePersonaText = (policy) => {
    if (!policy?.role) return ''
    try {
      const role = getRole(policy.role)
      return role ? loadPersona(role).text : ''
    } catch {
      return ''
    }
  }

  const onCreated = (agent) => {
    const id = agent?.id
    if (!id) return
    liveSessions.add(id)
    let policy = null
    try {
      policy = store.read(id)
    } catch (error) {
      audit({ sessionId: id, action: 'skip', reason: 'policy-read-threw' })
      logger.error?.(`[dsh-agents] toolscope：策略文件读取抛错（fail-open 不收缩）：${id} ${error?.message ?? error}`)
      return
    }
    if (!policy) return // 非本插件派发/无策略：零触碰（fail-open）
    const toolsApi = agent?.ctx?.tools
    if (!toolsApi || typeof toolsApi.restrict !== 'function' || typeof toolsApi.view !== 'function') {
      audit({ sessionId: id, action: 'skip', reason: 'tools-face-unavailable' })
      return
    }
    let restrictable
    try {
      restrictable = toolsApi.view(agent).restrictableNames
    } catch (error) {
      audit({ sessionId: id, action: 'skip', reason: 'view-threw' })
      logger.error?.(`[dsh-agents] toolscope：restrictableNames 读面失败（fail-open 不收缩）：${id} ${error?.message ?? error}`)
      return
    }
    if (!(restrictable instanceof Set)) restrictable = new Set(restrictable ?? [])
    let decision
    try {
      decision = decideToolscope({
        policy, roster, restrictable,
        personaText: resolvePersonaText(policy),
        taskText: policy.task ?? '',
      })
    } catch (error) {
      audit({ sessionId: id, action: 'skip', reason: 'decide-threw' })
      logger.error?.(`[dsh-agents] toolscope：决策核抛错（fail-open 不收缩）：${id} ${error?.message ?? error}`)
      return
    }
    audit({ sessionId: id, action: decision.action, reason: decision.reason, missing: decision.missing })

    if (decision.action === 'allow' || decision.action === 'deny') {
      // lift-before-set（AC2-2 同代/跨代防线）：共享表里有旧设先 lift 再设新——
      // 宿主 restrict 是交集语义，不 lift 会越收越窄。只 lift 共享表内**自己的**
      // 旧设；preset/他人注册的约束不在表内，不因此消失（V3-5/M8 叠加语义）。
      const table = sharedLiftTable()
      const prev = table.get(id)
      if (prev) {
        table.delete(id)
        try { prev.dispose?.() } catch { /* 旧 disposer 已失效：忽略 */ }
      }
      const filter = decision.action === 'allow' ? { allow: decision.names } : { deny: decision.names }
      let disposer
      try {
        disposer = toolsApi.restrict(filter)
      } catch (error) {
        // 预校验过了仍抛错（宿主版本漂移等）：fail-open，不收缩，响亮留痕。
        logger.error?.(`[dsh-agents] toolscope：restrict 调用抛错（fail-open 不收缩）：${id} ${error?.message ?? error}`)
        audit({ sessionId: id, action: 'skip', reason: 'restrict-threw' })
        return
      }
      table.set(id, { dispose: disposer, gen, at: Date.now(), action: decision.action })
      return
    }
    if (decision.action === 'refuse') {
      notifier.notify(refuseKey(id, decision.missing ?? []), {
        kind: 'toolscope-refuse',
        sessionId: id,
        role: policy.role ?? null,
        reason: decision.reason,
        missing: decision.missing ?? [],
        detail: '工具面策略拒绝应用（fail-open，会话保持全工具面）；修复策略数据或角色表后该键变更会再通知',
      })
    }
  }

  const onDisposed = (id) => {
    if (!id) return
    liveSessions.delete(id)
    const table = sharedLiftTable()
    const entry = table.get(id)
    if (entry) {
      table.delete(id) // 先删后调：disposer 抛错也不留残留（AC2-5）
      try { entry.dispose?.() } catch { /* 幂等：已失效忽略 */ }
    }
    sweepRetention()
  }

  const sweepRetention = () => {
    const maxFiles = roster?.retention?.maxFiles
    if (!Number.isFinite(maxFiles) || maxFiles <= 0) return
    try {
      const dir = join(store.dataDir, 'sessions')
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.toolscope.json'))
        .map((f) => {
          const path = join(dir, f)
          let mtime = 0
          try { mtime = statSync(path).mtimeMs } catch { mtime = 0 }
          return { path, encoded: f.replace(/\.toolscope\.json$/, '') }
        })
      const keep = new Set(liveSessions)
      // 文件名是 b64url(sessionId)（toolscope.js 同编码可逆），反解回 id 判活：
      // 活会话的策略文件永不清理，只对死会话按 mtime 新→旧保留 maxFiles 份。
      const dead = files
        .map((f) => ({ ...f, sid: safeB64UrlDecode(f.encoded) }))
        .filter((f) => !keep.has(f.sid))
        .sort((a, b) => b.mtime - a.mtime)
      for (const file of dead.slice(maxFiles)) {
        try { unlinkSync(file.path) } catch { /* 别的进程先删了：忽略 */ }
      }
    } catch { /* sessions 目录不存在等：清扫静默跳过（有界留存是回收优化非安全语义） */ }
  }

  const disposers = []
  disposers.push(ctx.on('agent/created', ({ agent } = {}) => {
    try { onCreated(agent) } catch (error) {
      logger.error?.(`[dsh-agents] toolscope：created 处理异常（fail-open）：${error?.message ?? error}`)
    }
  }, { global: true }))
  disposers.push(ctx.on('agent/disposed', ({ agent } = {}) => {
    try { onDisposed(agent?.id) } catch (error) {
      logger.error?.(`[dsh-agents] toolscope：disposed 处理异常：${error?.message ?? error}`)
    }
  }, { global: true }))
  disposers.push(ctx.on('session/disposed', (session) => {
    try { onDisposed(session?.id) } catch (error) {
      logger.error?.(`[dsh-agents] toolscope：session/disposed 处理异常：${error?.message ?? error}`)
    }
  }, { global: true }))

  return {
    gen,
    onCreated,
    onDisposed,
    /** V3-3 生效率读数原料（S5 消费）：审计快照。 */
    audit: () => [...auditLog],
    /** 通知器（测试检查去重行为；运行期为 console 降噪面）。 */
    notifier,
    dispose() {
      const table = sharedLiftTable()
      for (const [id, entry] of [...table]) {
        table.delete(id)
        try { entry.dispose?.() } catch { /* 幂等 */ }
      }
      liveSessions.clear()
      for (const d of disposers.splice(0)) {
        try { d?.() } catch { /* 幂等 */ }
      }
    },
  }
}
