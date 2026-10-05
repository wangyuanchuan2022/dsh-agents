/**
 * advisor 记录与会话级配置持久化（契约 §2 PATCH 落盘 / §4 记录字段）。
 *
 * 契约只要求两件事，这里只做这两件，不引入 memory-evolve 那套 live 事件环
 * （右侧面板走 GET 全量拉取，不需要 seq 游标）：
 *
 *  1. **records.jsonl** —— 终态意见逐行追加（id/sessionId/sessionName/
 *     severity/text/createdAt/outcome 六字段，两席共用不许各造一套）；
 *     超过 `advisorPersistLimit` 时重写文件只保留最近 N 条（保留上限由
 *     配置给出，默认 200）。读回容忍尾行残缺（崩溃半行）与中间坏行。
 *  2. **sessions/<base64url(sessionId)>.json** —— **每个会话一个独立文件**，
 *     只落 `enabled/provider/model` 三键。分文件而不是共用一个
 *     `config.json`：多个会话可同时改配置，共用单文件要做「读-改-写」，
 *     A 读 B 写 A 写就会丢更新，且并发写同一文件还有文件损坏风险；
 *     分文件后不同会话天然写不到同一个 inode。契约明确「不扩展宿主
 *     settings schema」，所以它不进 cordis.patch.yml，也不进宿主 settings；
 *     只在本数据目录里落盘，重启后仍生效。
 *
 * 纯类（fs 直连，写入路径由构造参数给出），便于测试注入目录。
 *
 * @module dsh-agents/advisor/store
 */

import * as nodeFs from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 记录文件与旧全局配置文件名（数据目录内）。 */
export const RECORDS_FILE = 'records.jsonl'
export const CONFIG_FILE = 'config.json'

/** 会话配置子目录名（`<dataDir>/sessions/<base64url(sessionId)>.json`）。 */
export const SESSIONS_DIR = 'sessions'

/** 单条记录字节上限（超限截断存储，避免异常长文本撑爆面板）。 */
export const RECORD_MAX_BYTES = 8 * 1024

/** 记录字段白名单与顺序（契约 §4；落盘与响应同形，杜绝两席各造一套）。 */
export const RECORD_FIELDS = ['id', 'sessionId', 'sessionName', 'severity', 'text', 'createdAt', 'outcome']

/** 严重度与投递通道枚举（契约 §4 / §5）。 */
export const SEVERITIES = ['info', 'nit', 'concern', 'blocker']
export const OUTCOMES = ['steer', 'inject', 'recorded', 'dropped']

/**
 * 会话级配置文件路径：**每个会话一个独立文件**，文件名是 sessionId 的
 * base64url 编码。
 *
 * 为什么分文件而不是共用一个 `config.json`（2026-10-03 定）：
 * 多个会话可同时改配置，共用单文件要做「读-改-写」，A 读 B 写 A 写就会
 * 丢更新，且并发写同一文件还有文件损坏风险。分文件后不同会话天然写不到
 * 同一个 inode，并发更新互不干扰；配合 #atomicWrite（temp+rename）保证
 * 单文件自身不出现半截内容。
 *
 * 编码是必须的：sessionId 是外部字符串，直接拼路径等于路径穿越
 * （`../../` 或盘符/冒号都能逃出 dataDir）。base64url 输出集是
 * `[A-Za-z0-9_-]`，对文件名安全且可逆；该字母表不含 `.`，故
 * `sessions/<b64>.json`（配置）与 `sessions/<b64>.seen.json`（幂等 seen，
 * 见 S3）不可能碰撞。
 *
 * @param {string} dataDir - advisor 数据目录
 * @param {string} sessionId - 会话 id
 * @returns {string} 该会话配置文件的绝对路径
 */
export function sessionConfigPath(dataDir, sessionId) {
  const encoded = Buffer.from(String(sessionId), 'utf8').toString('base64url')
  return join(dataDir, SESSIONS_DIR, `${encoded}.json`)
}

/**
 * 会话幂等 seen 文件路径：`sessions/<base64url(sessionId)>.seen.json`。
 *
 * **与配置分文件同理，且必须独立成文件**（S3 定）：配置面由 `PATCH` 写、
 * seen 面由观察器每轮 `turn/end` 后写。两者共用一个文件就必须对同一 inode
 * 做读-改-写，并发 PATCH 与评审落盘会互相覆盖（正是 S1 分文件的成因）。
 * base64url 字母表 `[A-Za-z0-9_-]` 不含 `.`，故 `<b64>.json` 与
 * `<b64>.seen.json` 不可能碰撞。
 *
 * @param {string} dataDir - advisor 数据目录
 * @param {string} sessionId - 会话 id
 * @returns {string} 该会话 seen 文件的绝对路径
 */
export function sessionSeenPath(dataDir, sessionId) {
  const encoded = Buffer.from(String(sessionId), 'utf8').toString('base64url')
  return join(dataDir, SESSIONS_DIR, `${encoded}.seen.json`)
}

/** seen 状态初值（`-1` = 尚未裁决过任何 turn/end）。 */
const EMPTY_SEEN = () => ({ reviewed: [], lastReviewedSeq: -1 })

/**
 * 把一条意见规范成契约记录形态（裁字段、补默认值、限长文本）。
 * @param {object} input - { id, sessionId, sessionName, severity, text, createdAt, outcome }
 * @returns {object|null} 规范化记录；severity/text 缺失则 null
 */
export function normalizeRecord(input) {
  if (input === null || typeof input !== 'object') return null
  const severity = SEVERITIES.includes(input.severity) ? input.severity : null
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (severity === null || text === '') return null
  const outcome = OUTCOMES.includes(input.outcome) ? input.outcome : 'dropped'
  const createdAt = Number.isFinite(input.createdAt) ? Math.trunc(input.createdAt) : Date.now()
  let body = text
  if (body.length > 200) body = `${body.slice(0, 199)}…` // 契约：单条 ≤200 字
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : crypto.randomUUID(),
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    sessionName: typeof input.sessionName === 'string' ? input.sessionName : null,
    severity,
    text: body,
    createdAt,
    outcome,
  }
}

/**
 * 会话配置三键规范化（只认 enabled/provider/model，其余键一律丢弃）。
 * @param {object} raw - 已合并的原始对象
 * @returns {{enabled?: boolean, provider?: string, model?: string}}
 */
function normalizeSessionConfig(raw) {
  const src = raw === null || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw
  const out = {}
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled
  if (typeof src.provider === 'string' && src.provider.trim() !== '') out.provider = src.provider.trim()
  if (typeof src.model === 'string' && src.model.trim() !== '') out.model = src.model.trim()
  return out
}

/**
 * U2 成对规则：`enabled===true` 必须同时具备 provider 与 model。
 *
 * 放在这里（而不是只放 api.js 的 normalizeAdvisorPatch）是 F-4 的落法：
 * api.js 全文件零 import、拿不到 store，成对规则若只在 handler 层判，
 * 「读—判—写」的 check-then-act 就不在同一个临界区里。
 *
 * 校验失败**抛同步异常**（由 api.js 的既有 catch 转 400），且抛错前
 * 不得有任何写盘动作。
 *
 * @param {{enabled?: boolean, provider?: string, model?: string}} cfg
 * @param {string} sessionId - 仅用于错误信息
 */
function assertSessionPairing(cfg, sessionId) {
  if (cfg.enabled !== true) return
  if (cfg.provider === undefined || cfg.model === undefined) {
    throw new Error(
      `dsh-agents: 会话 ${sessionId} 不能在未配置模型时开启 advisor（enabled=true 必须同时给出 provider 与 model）`,
    )
  }
}

/**
 * advisor 存储。
 * @param {object} options
 * @param {string} options.dataDir - 数据目录（<advisorDataDir>）
 * @param {number} [options.persistLimit] - 记录保留上限（默认 200）
 * @param {object} [options.fs] - **可替换 fs 门面**（默认 node:fs）；
 *   测试用它注入 renameSync 探针，直接观察「真正 rename 之前」的 temp 路径与内容
 *   （判据 A12：事后看「无残留」是空门，必须在 rename 发生前断言）。
 */
export class AdvisorStore {
  /** 原子写 nonce（temp 名防同毫秒串写）。 */
  #nonce = 0

  constructor(options) {
    this.dataDir = options.dataDir
    this.recordsFile = join(this.dataDir, RECORDS_FILE)
    /** 旧全局配置文件（**只用于存在性检测**，不再读取，见 S1 旧文件裁决）。 */
    this.configFile = join(this.dataDir, CONFIG_FILE)
    this.sessionsDir = join(this.dataDir, SESSIONS_DIR)
    this.persistLimit = Number.isInteger(options.persistLimit) && options.persistLimit > 0
      ? options.persistLimit
      : 200
    /** 可替换 fs 门面（测试注入探针；生产恒为 node:fs）。 */
    this.fs = options.fs ?? nodeFs
    /** 写盘失败只告警一次（记录丢失不该把评审主循环带崩）。 */
    this.warned = false
    /**
     * seen 面告警的独立一次开关。
     *
     * 刻意**不复用** `warned`：记录面先告警过就会把 seen 的告警吞掉，而
     * C11 判据要求「坏 JSON → 恰好一条 warn」，共用开关会让它取决于用例顺序。
     */
    this.seenWarned = false
  }

  /** 原子写（temp+rename；temp 放同目录，nonce 防同毫秒串写）。
   *
   * temp 名**带目标 basename**（F-12）：两个 store 实例写同一目录下的
   * **不同**会话文件时，temp 路径天然不同，不会互相抢同一个 temp。
   *
   * 注意边界：temp+rename 只保证「单文件不出现半截内容」，**不保证并发
   * 不丢更新**——同一会话并发写仍会丢，防护在 `writeSessionConfig` 的
   * 同步临界区（读—判—写全程同步，见该方法注释）。
   */
  #atomicWrite(path, data) {
    this.#nonce += 1
    const dir = dirname(path)
    this.fs.mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.tmp-advisor-${process.pid}-${this.#nonce}-${basename(path)}`)
    this.fs.writeFileSync(tmp, data)
    this.fs.renameSync(tmp, path)
  }

  #warn(message, error) {
    if (this.warned) return
    this.warned = true
    console.error(`[dsh-agents] advisor 存储：${message}`, error?.message ?? error ?? '')
  }

  /** seen 面告警（独立开关，见 `seenWarned`）。 */
  #warnSeen(message, error) {
    if (this.seenWarned) return
    this.seenWarned = true
    console.error(`[dsh-agents] advisor 存储：${message}`, error?.message ?? error ?? '')
  }

  /**
   * 追加一条意见记录（先规范化 → 追加 → 按保留上限裁剪）。
   * @param {object} input - 原始记录
   * @returns {object|null} 落盘后的记录；非法记录返回 null
   */
  append(input) {
    const record = normalizeRecord(input)
    if (record === null) return null
    try {
      this.fs.mkdirSync(this.dataDir, { recursive: true })
      this.fs.appendFileSync(this.recordsFile, `${JSON.stringify(record)}\n`, 'utf8')
      this.#trim()
    } catch (error) {
      this.#warn('追加记录失败（意见仍会投递，只是不落盘）', error)
    }
    return record
  }

  /** 保留上限裁剪（读全量 → 只留最近 persistLimit 条 → 重写）。 */
  #trim() {
    const all = this.#readAll()
    if (all.length <= this.persistLimit) return
    const kept = all.slice(all.length - this.persistLimit)
    this.#atomicWrite(this.recordsFile, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`)
  }

  /** 读全部记录（跳过坏行，容忍尾行残缺）。 */
  #readAll() {
    if (!this.fs.existsSync(this.recordsFile)) return []
    let raw = ''
    try {
      raw = this.fs.readFileSync(this.recordsFile, 'utf8')
    } catch (error) {
      this.#warn('读取记录失败（按空处理）', error)
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object') out.push(parsed)
      } catch {
        // 坏行（崩溃半行）跳过——记录面是尽力而为，不因一行坏数据全灭
      }
    }
    return out
  }

  /**
   * 最近记录（createdAt 倒序，最多 limit 条）。
   *
   * **按会话过滤**（Q-5）：advisor 的启用与评审模型已彻底会话级，records
   * 面板也必须只显示所问会话的意见——否则 A 会话开启评审后，B 会话的面板
   * 会看到 A 的意见，并误以为「advisor 在 B 上也开着」。
   *
   * @param {string} [sessionId] - 会话 id；非字符串（如 undefined）= 不过滤（返回全量）
   * @param {number} [limit] - 返回条数上限（缺省用 persistLimit）
   */
  list(sessionId, limit) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : this.persistLimit
    let all = this.#readAll()
      .map(normalizeRecord)
      .filter((r) => r !== null)
    if (typeof sessionId === 'string') all = all.filter((r) => r.sessionId === sessionId)
    all.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return all.slice(0, cap)
  }

  /**
   * 读某会话的配置（不存在/损坏/形状不对 → 空对象）。
   * @param {string} sessionId - 会话 id
   * @returns {{enabled?: boolean, provider?: string, model?: string}}
   */
  readSessionConfig(sessionId) {
    const path = sessionConfigPath(this.dataDir, sessionId)
    if (!this.fs.existsSync(path)) return {}
    try {
      const parsed = JSON.parse(this.fs.readFileSync(path, 'utf8'))
      return normalizeSessionConfig(parsed)
    } catch (error) {
      this.#warn(`读取会话配置失败（按未覆盖处理）：${sessionId}`, error)
      return {}
    }
  }

  /**
   * 写某会话的配置（读—判—写**三步全程同步**，中间不得出现 `await`）。
   *
   * 为什么必须全同步（Q-2 + F-4）：
   * Node 单线程下，同步的「读既存 → 按 patch 合并 → 校验 U2 成对规则 →
   * 原子写」天然串行，同一会话的两次并发写不可能交错；
   * 一旦把其中任一步改成 `await`（哪怕只是 `await readFile`），
   * 临界区就被切开变成 check-then-act，两次并发写必然丢更新
   * （注入必红 N3：改成 async 后判据 A9 变红）。
   *
   * 校验失败抛**同步异常**且**零写盘**，由 api.js 的既有 catch 转 400。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} patch - { enabled?, provider?, model? }
   * @returns {{enabled?: boolean, provider?: string, model?: string}} 落盘后的配置
   */
  writeSessionConfig(sessionId, patch) {
    const next = { ...this.readSessionConfig(sessionId), ...(patch ?? {}) }
    const clean = normalizeSessionConfig(next)
    assertSessionPairing(clean, sessionId)
    this.#atomicWrite(sessionConfigPath(this.dataDir, sessionId), `${JSON.stringify(clean, null, 2)}\n`)
    return clean
  }

  /**
   * 读某会话的幂等 seen 状态（不存在 / 损坏 / 形状不对 → 空状态）。
   *
   * **fail-open 是硬要求**（C11）：seen 文件坏了只丢「跨重启不重复计费」这
   * 一层保护，绝不能把评审循环带崩，因此这里**只告警不抛错**。
   *
   * `lastReviewedSeq` 的初值哨兵是 **-1 而不是 0**，理由与「宿主 seq 从几
   * 起」直接相关且**容易写反**：宿主事件 seq **从 0 起**（`session.append`
   * 里 `seq: SessionSeq(this.log.length)` 在入栈前求值，故第一条事件的 seq
   * 就是 0）。水位判定是 `seq <= lastReviewedSeq → 拦截`，所以初值若取 0，
   * 重启后见到的**第一条** `turn/end`（seq=0）会命中 `0 <= 0` 被当成「已裁决
   * 区间内」而**静默漏评**。取 -1 才能让 seq=0 正常放行。
   *
   * @param {string} sessionId - 会话 id
   * @returns {{reviewed: string[], lastReviewedSeq: number}}
   */
  readSeen(sessionId) {
    const path = sessionSeenPath(this.dataDir, sessionId)
    if (!this.fs.existsSync(path)) return EMPTY_SEEN()
    try {
      const parsed = JSON.parse(this.fs.readFileSync(path, 'utf8'))
      const src = parsed !== null && typeof parsed === 'object' ? parsed : {}
      return {
        reviewed: Array.isArray(src.reviewed) ? src.reviewed.filter((k) => typeof k === 'string') : [],
        lastReviewedSeq: Number.isFinite(src.lastReviewedSeq) ? src.lastReviewedSeq : -1,
      }
    } catch (error) {
      this.#warnSeen(`读取会话 seen 失败（按未评审处理，降级为纯内存去重）：${sessionId}`, error)
      return EMPTY_SEEN()
    }
  }

  /**
   * 写某会话的幂等 seen 状态（原子写；失败只告警，绝不抛给评审循环）。
   *
   * 与 `writeSessionConfig` 一样**全程同步**（无 await），所以观察器同一
   * 事件循环内的「读—改—写」天然串行，不会丢水位推进。
   *
   * @param {string} sessionId - 会话 id
   * @param {{reviewed: string[], lastReviewedSeq: number}} state
   */
  writeSeen(sessionId, state) {
    const src = state !== null && typeof state === 'object' ? state : {}
    const payload = {
      reviewed: Array.isArray(src.reviewed) ? src.reviewed.filter((k) => typeof k === 'string') : [],
      lastReviewedSeq: Number.isFinite(src.lastReviewedSeq) ? src.lastReviewedSeq : -1,
      updatedAt: Date.now(),
    }
    try {
      this.#atomicWrite(sessionSeenPath(this.dataDir, sessionId), `${JSON.stringify(payload)}\n`)
    } catch (error) {
      this.#warnSeen(`写会话 seen 失败（评审照常，仅跨重启去重降级）：${sessionId}`, error)
    }
  }
}
