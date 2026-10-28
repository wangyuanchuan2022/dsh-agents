/**
 * per-session 工具面策略文件（R3-B1 子特性② 数据层，S1）。
 *
 * 落点：`<dataDir>/sessions/<base64url(sessionId)>.toolscope.json`——与 advisor
 * 的会话配置（`<b64>.json`）和幂等 seen（`<b64>.seen.json`）**同目录、异文件名**
 * （承 advisor seen.json 同款考量）：base64url 字母表 `[A-Za-z0-9_-]` 不含 `.`，
 * 三个后缀不可能碰撞；同目录共享让 per-session 状态只有一个盘点入口。
 *
 * schema（版本化，v1；S3 加法扩展见 normalizeToolscope 注释）：
 *   { schemaVersion, sessionId, personaMode: 'minimal'|'role',
 *     toolPolicy: { tier: 'full'|'grant'|'none', allow: string[], deny: string[] },
 *     replyChannel: 'org'|null, orgId: string|null,
 *     role: string|null, task: string|null, taskbook: string|null, preset: string|null,
 *     createdAt, updatedAt }
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
 * minimal 整集定义兜底常量（S3 转正说明）。
 *
 * 名单按 S2 P1 结论校准、**Phase B 二次校准（2026-10-26，宿主真实注册面锚定）**：
 * dsh-tool-fs 只注册 read / write / edit / read_image（dsh-tool-fs/lib/index.js
 * 注册名实测锚定，**无 glob/grep**——旧名单含此二名会对预设会话 unknown-names
 * 必拒 → fail-open 裸面，即 Phase B 事故二）；编辑补
 * dsh-tool-str-replace-editor 的 `str_replace_editor`（注册名实测）；执行
 * dsh-tool-pwsh 的 `pwsh`。**单一事实源=policies/toolscope-roster.json 的
 * presets['eval-coding'].tools**（数据化热修），本常量只是数据缺失时的兜底，
 * run.mjs 漂移门钉死两者 deep-equal（改名单必须改数据文件，常量随之同步）。
 *
 * ⚠️ own 层工具（agent_reply 等）**不得**入列——P4 实证 own 层名不在
 * restrictableNames 里，列入 allow 即 unknown 必拒（AC2-3）；own 层豁免是
 * 自动语义，不需要也不会出现在名单里。
 */
export const MINIMAL_TOOLSET_FULL = Object.freeze(['read', 'write', 'edit', 'read_image', 'str_replace_editor', 'pwsh'])

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
 * S3 加法扩展（向后兼容，schemaVersion 保持 1）：可选字段
 *   role     role 轨会话的角色 id（null=minimal/未标）——管线按 roster 表收缩的键
 *   task     任务正文原文（交叉校验硬闸的扫描输入之一；created 时 prompt 尚未
 *            入会话，这是唯一时序安全的来源）
 *   taskbook 任务书全文（审计取证面；gate 扫描用 persona(运行期现读)+task）
 *   preset   预置策略档 id（'eval-coding'|'read-only'）；spawn 时已解析进 allow，
 *            此字段仅作溯源披露
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
  // S3 加法可选字段：string|null；空串归一为 null；其余类型大声失败。
  const optionalText = (value, label) => {
    if (value === null || value === undefined || value === '') return null
    if (typeof value !== 'string') throw new Error(`toolscope: ${label} 必须是字符串或 null`)
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  const role = optionalText(raw.role, 'role')
  const task = optionalText(raw.task, 'task')
  const taskbook = optionalText(raw.taskbook, 'taskbook')
  const preset = optionalText(raw.preset, 'preset')
  return {
    schemaVersion: TOOLSCOPE_SCHEMA_VERSION,
    sessionId,
    personaMode,
    toolPolicy: { tier, allow, deny },
    replyChannel,
    orgId,
    role,
    task,
    taskbook,
    preset,
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
   * @param {object|null} [options.presets] - 预置策略档数据（policies 基表 presets；
   *   缺省/缺档回落 MINIMAL_TOOLSET_FULL——run.mjs 漂移门钉死两者相等）
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.fs = options.fs ?? nodeFs
    this.presets = options.presets ?? null
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
   * S3 转正：allow 名单数据化——优先显式 input.allow > 预置档 eval-coding
   * （policies 基表，P1 校准后转正）> MINIMAL_TOOLSET_FULL 常量兜底；
   * preset 字段留痕 'eval-coding'（溯源披露）。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} [input] - { orgId?: string|null, allow?: string[], preset?: string,
   *   extraAllow?: string[]（S1.5 单授：**只 append 并集**，不改 input.allow 的替换语义） }
   * @returns {object} 落盘后的规范化记录
   */
  writeMinimal(sessionId, input = {}) {
    const preset = input.preset ?? 'eval-coding'
    const presetTools = this.presets?.[preset]?.tools
    const base = input.allow ?? (presetTools ? [...presetTools] : [...MINIMAL_TOOLSET_FULL])
    // S1.5（R-13 / r2 P0-2）：单授走 append——`input.allow` 的**替换**语义逐字不变
    //（tests/run.mjs:1290 用显式 allow 断言 missing 恰为 ghosts；改成并集会混入
    // MINIMAL_TOOLSET_FULL 的 str_replace_editor 而必红）。
    const extra = Array.isArray(input.extraAllow) ? input.extraAllow : []
    const allow = extra.length > 0 ? [...new Set([...base, ...extra])] : base
    return this.write(sessionId, {
      sessionId,
      personaMode: 'minimal',
      toolPolicy: {
        tier: 'full',
        allow,
        deny: input.deny ?? [],
      },
      replyChannel: 'org',
      orgId: input.orgId ?? null,
      preset,
    })
  }

  /**
   * role 轨标记写（S3）：role 默认收缩的激活记录——管线在 agent/created 读到
   * 本文件才收缩（无文件=非本插件派发/标记丢失，fail-open 不收缩）。tier 用
   * 'grant' 语义（role 轨默认收缩+grant 放权；禁整集替换在管线侧拒绝）。
   * role/task/taskbook 三字段同落：role 是 roster 键，task 是交叉校验硬闸的
   * 扫描输入（created 时 prompt 尚未入会话），taskbook 留审计取证。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} input - { role: string, task?: string, taskbook?: string,
   *   allow?: string[]（S1.5 单授：并入 grant 轨放权集，管线 `:209-211` 已有合并语义） }
   * @returns {object} 落盘后的规范化记录
   */
  writeRole(sessionId, { role, task, taskbook, allow } = {}) {
    return this.write(sessionId, {
      sessionId,
      personaMode: 'role',
      role: role ?? null,
      task: task ?? null,
      taskbook: taskbook ?? null,
      toolPolicy: { tier: 'grant', allow: normalizeStringList(allow ?? []) ?? [], deny: [] },
      replyChannel: null,
      orgId: null,
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
