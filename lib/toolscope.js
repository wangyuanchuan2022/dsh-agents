/**
 * per-session 工具面策略文件（R3-B1 子特性② 数据层，S1）。
 *
 * 落点：`<dataDir>/sessions/<base64url(sessionId)>.toolscope.json`——与 advisor
 * 的会话配置（`<b64>.json`）和幂等 seen（`<b64>.seen.json`）**同目录、异文件名**
 * （承 advisor seen.json 同款考量）：base64url 字母表 `[A-Za-z0-9_-]` 不含 `.`，
 * 三个后缀不可能碰撞；同目录共享让 per-session 状态只有一个盘点入口。
 *
 * schema（版本化，v1）：
 *   { schemaVersion, sessionId, personaMode: 'minimal'|'role',
 *     toolPolicy: { tier: 'full'|'grant'|'none', allow: string[], deny: string[] },
 *     replyChannel: 'org'|null, orgId: string|null, createdAt, updatedAt }
 *
 * 三条硬语义（承 advisor store.js 已纠正设计，2026-10-26 任务书）：
 *   1. **写入临界区全同步**——read→merge→write 全程无 await（Node 单线程下
 *      天然串行，同一会话两次并发写不可能交错）。temp+rename **不是**并发
 *      保护（A 读 B 写 A 写照样丢），它只防「单文件半截内容」；并发安全由
 *      全同步临界区提供，不得倒置归因。
 *   2. **写路径 fail-closed**——normalize 校验失败抛同步异常且零写盘；
 *   3. **读路径 fail-open**——文件缺失/损坏/形状不对返回 null（只告警一次），
 *      不把调用方（S3 对账 / S4 回复通道）带崩。
 *
 * 信任边界（V3-5/M14，与 advisor 同款用户知情接受）：策略文件为**同机任意
 * 进程可写面**——orgId/工具面可被本机他进程篡改；宿主无鉴权钩子，此处只做
 * 形状校验不做来源鉴别。
 *
 * @module dsh-agents/toolscope
 */
import * as nodeFs from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** schema 版本（结构不兼容变更时递增；读取侧按版本拒绝陌生大版本）。 */
export const TOOLSCOPE_SCHEMA_VERSION = 1

/** 文件名后缀（独立成文件，防与 advisor `<b64>.json`/`<b64>.seen.json` 争文件）。 */
export const TOOLSCOPE_SUFFIX = '.toolscope.json'

/** 会话子目录名（与 advisor store 的 SESSIONS_DIR 同值；此处不 import advisor，保持零耦合）。 */
export const TOOLSCOPE_SESSIONS_DIR = 'sessions'

/** toolPolicy 档名枚举：full=minimal 整集显式定义；grant=role 轨放权；none=豁免收缩。 */
export const TOOL_POLICY_TIERS = ['full', 'grant', 'none']

/** 回复通道枚举（S1 只有 'org'；schema 留扩展位）。 */
export const REPLY_CHANNELS = ['org']

/**
 * minimal 整集定义（V3-5/M5 补显式字段；数据化便于热修）。
 *
 * ⚠️ 占位版：eval-coding 档底线集（读类＋写类＋执行类＋S4 agent_reply）的
 * **最终名单以 P1 盘点（S2）与 AC1-4 彩排（S5）钉死**——设计 §2.1「名单数据化，
 * 以 AC1-4 彩排钉死」。此处先给保守常用名， restrict 应用（S3）前允许改表。
 */
export const MINIMAL_TOOLSET_FULL = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'pwsh'])

/**
 * 会话策略文件路径：`<dataDir>/sessions/<base64url(sessionId)>.toolscope.json`。
 *
 * sessionId 必须编码后进文件名（advisor store.js 同判据）：sessionId 是外部
 * 字符串，直接拼路径等于路径穿越；base64url 输出集对文件名安全且可逆。
 *
 * @param {string} dataDir - 数据目录（advisorDataDir 同源解析，见 lib/index.js apply）
 * @param {string} sessionId - 会话 id
 * @returns {string} 该会话策略文件的绝对路径
 */
export function toolscopePath(dataDir, sessionId) {
  const encoded = Buffer.from(String(sessionId), 'utf8').toString('base64url')
  return join(dataDir, TOOLSCOPE_SESSIONS_DIR, `${encoded}${TOOLSCOPE_SUFFIX}`)
}

/** 非空字符串数组规范化（trim + 丢空串 + 去重；非数组/元素非字符串 → undefined=不合法）。 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    const trimmed = item.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * 策略记录规范化（写路径唯一入口；表外键一律丢弃，非法值抛同步异常）。
 *
 * @param {object} raw - 待规范化记录（merge 后形态）
 * @returns {object} 规范化记录
 * @throws {Error} tier/personaMode/replyChannel 非法或 allow/deny 不是字符串数组
 */
export function normalizeToolscope(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('toolscope: 记录必须是对象')
  }
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim() !== '' ? raw.sessionId.trim() : undefined
  if (sessionId === undefined) throw new Error('toolscope: sessionId 为必填非空字符串')
  const personaMode = raw.personaMode === 'minimal' || raw.personaMode === 'role' ? raw.personaMode : undefined
  if (personaMode === undefined) throw new Error(`toolscope: personaMode 只接受 minimal|role（收到 ${JSON.stringify(raw.personaMode ?? null)}）`)
  const policy = raw.toolPolicy !== null && typeof raw.toolPolicy === 'object' && !Array.isArray(raw.toolPolicy) ? raw.toolPolicy : undefined
  if (policy === undefined) throw new Error('toolscope: toolPolicy 为必填对象')
  const tier = TOOL_POLICY_TIERS.includes(policy.tier) ? policy.tier : undefined
  if (tier === undefined) throw new Error(`toolscope: toolPolicy.tier 只接受 ${TOOL_POLICY_TIERS.join('|')}（收到 ${JSON.stringify(policy.tier ?? null)}）`)
  const allow = normalizeStringList(policy.allow)
  if (allow === undefined) throw new Error('toolscope: toolPolicy.allow 必须是字符串数组')
  const deny = normalizeStringList(policy.deny)
  if (deny === undefined) throw new Error('toolscope: toolPolicy.deny 必须是字符串数组')
  const replyChannel = raw.replyChannel === null || raw.replyChannel === undefined
    ? null
    : (REPLY_CHANNELS.includes(raw.replyChannel) ? raw.replyChannel : undefined)
  if (replyChannel === undefined) throw new Error(`toolscope: replyChannel 只接受 ${REPLY_CHANNELS.join('|')}|null（收到 ${JSON.stringify(raw.replyChannel)}）`)
  const orgId = raw.orgId === null || raw.orgId === undefined
    ? null
    : (typeof raw.orgId === 'string' && raw.orgId.trim() !== '' ? raw.orgId.trim() : undefined)
  if (orgId === undefined) throw new Error('toolscope: orgId 必须是非空字符串或 null')
  return {
    schemaVersion: TOOLSCOPE_SCHEMA_VERSION,
    sessionId,
    personaMode,
    toolPolicy: { tier, allow, deny },
    replyChannel,
    orgId,
    createdAt: Number.isFinite(raw.createdAt) ? Math.trunc(raw.createdAt) : Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 工具面策略存储（纯类，fs 直连、写入路径由构造参数给出——承 AdvisorStore
 * 可注入 fs 门面的测试先例：G8 负例注入写失败探针，观察 fail-fast 生效）。
 */
export class ToolscopeStore {
  #nonce = 0

  /**
   * @param {object} options
   * @param {string} options.dataDir - 数据目录（advisorDataDir 同源）
   * @param {object} [options.fs] - 可替换 fs 门面（默认 node:fs；测试注入写失败探针）
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.fs = options.fs ?? nodeFs
    /** 读路径告警只发一次（损坏文件被反复读时不刷屏；独立开关不复用其他面）。 */
    this.readWarned = false
  }

  /** 该会话策略文件路径。 */
  path(sessionId) {
    return toolscopePath(this.dataDir, sessionId)
  }

  #warnRead(message, error) {
    if (this.readWarned) return
    this.readWarned = true
    console.error(`[dsh-agents] toolscope 存储：${message}`, error?.message ?? error ?? '')
  }

  /**
   * 读某会话策略（不存在/损坏/大版本不识别 → null，fail-open）。
   * @param {string} sessionId - 会话 id
   * @returns {object|null} 规范化记录；无策略返回 null
   */
  read(sessionId) {
    const path = this.path(sessionId)
    if (!this.fs.existsSync(path)) return null
    try {
      const parsed = JSON.parse(this.fs.readFileSync(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object'
        && parsed.schemaVersion === TOOLSCOPE_SCHEMA_VERSION) {
        return normalizeToolscope(parsed)
      }
      this.#warnRead(`策略文件缺省或版本不识别（按无策略处理）：${sessionId}`, null)
      return null
    } catch (error) {
      this.#warnRead(`读取策略文件失败（按无策略处理）：${sessionId}`, error)
      return null
    }
  }

  /**
   * 写某会话策略（read→merge→normalize→写，**全程同步无 await**）。
   *
   * 校验失败抛同步异常且零写盘（fail-closed）；写盘失败原样抛出——由调用方
   * （agent_spawn minimal 轨）按 G8 fail-fast 中止 spawn，无策略文件的
   * minimal 会话是非法态，不得静默降级。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} patch - { sessionId 必带, personaMode, toolPolicy, replyChannel, orgId }
   * @returns {object} 落盘后的规范化记录
   */
  write(sessionId, patch) {
    const merged = { ...this.read(sessionId), ...(patch ?? {}) }
    const clean = normalizeToolscope(merged)
    this.#atomicWrite(this.path(sessionId), `${JSON.stringify(clean, null, 2)}\n`)
    return clean
  }

  /**
   * minimal 轨专用写：同事务整集定义（裁 4/V3-7）——tier='full' + 整集 allow
   * + replyChannel='org'，orgId 单一事实源=派活参数（organizer）。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} [input] - { orgId?: string|null, allow?: string[], deny?: string[] }
   * @returns {object} 落盘后的规范化记录
   */
  writeMinimal(sessionId, input = {}) {
    return this.write(sessionId, {
      sessionId,
      personaMode: 'minimal',
      toolPolicy: {
        tier: 'full',
        allow: input.allow ?? [...MINIMAL_TOOLSET_FULL],
        deny: input.deny ?? [],
      },
      replyChannel: 'org',
      orgId: input.orgId ?? null,
    })
  }

  /**
   * 原子写（temp+rename，承 advisor #atomicWrite 同款）：**只防单文件半截
   * 内容**（崩溃/外部读者视角），并发不丢更新由 write() 的全同步临界区保证；
   * temp 放同目录、temp 名带目标 basename + nonce，不同会话文件互不抢 temp。
   */
  #atomicWrite(path, data) {
    this.#nonce += 1
    const dir = dirname(path)
    this.fs.mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.tmp-toolscope-${process.pid}-${this.#nonce}-${basename(path)}`)
    this.fs.writeFileSync(tmp, data)
    this.fs.renameSync(tmp, path)
  }
}
