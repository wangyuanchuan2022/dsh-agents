/**
 * advisor 记录与运行时配置持久化（契约 §2 PATCH 落盘 / §4 记录字段）。
 *
 * 契约只要求两件事，这里只做这两件，不引入 memory-evolve 那套 live 事件环
 * （右侧面板走 GET 全量拉取，不需要 seq 游标）：
 *
 *  1. **records.jsonl** —— 终态意见逐行追加（id/sessionId/sessionName/
 *     severity/text/createdAt/outcome 六字段，两席共用不许各造一套）；
 *     超过 `advisorPersistLimit` 时重写文件只保留最近 N 条（保留上限由
 *     配置给出，默认 200）。读回容忍尾行残缺（崩溃半行）与中间坏行。
 *  2. **config.json** —— PATCH 写入的 `enabled/provider/model` 三键。
 *     契约明确「不扩展宿主 settings schema」，所以它不进 cordis.patch.yml，
 *     也不进宿主 settings；只在本数据目录里落盘，重启后仍生效。
 *
 * 纯类（fs 直连，写入路径由构造参数给出），便于测试注入目录。
 *
 * @module dsh-agents/advisor/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 记录文件与配置文件名（数据目录内）。 */
export const RECORDS_FILE = 'records.jsonl'
export const CONFIG_FILE = 'config.json'

/** 单条记录字节上限（超限截断存储，避免异常长文本撑爆面板）。 */
export const RECORD_MAX_BYTES = 8 * 1024

/** 记录字段白名单与顺序（契约 §4；落盘与响应同形，杜绝两席各造一套）。 */
export const RECORD_FIELDS = ['id', 'sessionId', 'sessionName', 'severity', 'text', 'createdAt', 'outcome']

/** 严重度与投递通道枚举（契约 §4 / §5）。 */
export const SEVERITIES = ['info', 'nit', 'concern', 'blocker']
export const OUTCOMES = ['steer', 'inject', 'recorded', 'dropped']

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
 * advisor 存储。
 * @param {object} options
 * @param {string} options.dataDir - 数据目录（<advisorDataDir>）
 * @param {number} [options.persistLimit] - 记录保留上限（默认 200）
 */
export class AdvisorStore {
  /** 原子写 nonce（temp 名防同毫秒串写）。 */
  #nonce = 0

  constructor(options) {
    this.dataDir = options.dataDir
    this.recordsFile = join(this.dataDir, RECORDS_FILE)
    this.configFile = join(this.dataDir, CONFIG_FILE)
    this.persistLimit = Number.isInteger(options.persistLimit) && options.persistLimit > 0
      ? options.persistLimit
      : 200
    /** 写盘失败只告警一次（记录丢失不该把评审主循环带崩）。 */
    this.warned = false
  }

  /** 原子写（temp+rename；temp 放同目录，nonce 防同毫秒串写）。 */
  #atomicWrite(path, data) {
    this.#nonce += 1
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.tmp-advisor-${process.pid}-${this.#nonce}`)
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  }

  #warn(message, error) {
    if (this.warned) return
    this.warned = true
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
      mkdirSync(this.dataDir, { recursive: true })
      appendFileSync(this.recordsFile, `${JSON.stringify(record)}\n`, 'utf8')
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
    if (!existsSync(this.recordsFile)) return []
    let raw = ''
    try {
      raw = readFileSync(this.recordsFile, 'utf8')
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
   * @param {number} [limit] - 返回条数上限（缺省用 persistLimit）
   */
  list(limit) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : this.persistLimit
    const all = this.#readAll()
      .map(normalizeRecord)
      .filter((r) => r !== null)
    all.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return all.slice(0, cap)
  }

  /** 读配置文件（不存在/损坏/形状不对 → 空对象）。 */
  readConfig() {
    if (!existsSync(this.configFile)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out = {}
      if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled
      if (typeof parsed.provider === 'string' && parsed.provider.trim() !== '') out.provider = parsed.provider.trim()
      if (typeof parsed.model === 'string' && parsed.model.trim() !== '') out.model = parsed.model.trim()
      return out
    } catch (error) {
      this.#warn('读取 config.json 失败（按未覆盖处理）', error)
      return {}
    }
  }

  /** 写配置文件（只落 enabled/provider/model 三键）。 */
  writeConfig(patch) {
    const next = { ...this.readConfig(), ...patch }
    const clean = {}
    if (typeof next.enabled === 'boolean') clean.enabled = next.enabled
    if (typeof next.provider === 'string' && next.provider.trim() !== '') clean.provider = next.provider.trim()
    if (typeof next.model === 'string' && next.model.trim() !== '') clean.model = next.model.trim()
    this.#atomicWrite(this.configFile, `${JSON.stringify(clean, null, 2)}\n`)
    return clean
  }
}