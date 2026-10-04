/**
 * advisor 会话观察器（契约 §6 评审触发时机 + §7 有界窗口）。
 *
 * 纯类（cordis-free）：装配层从 `session/event` 监听转发
 * `handleEvent(sessionId, events, event)`，两种触发模式把**只读快照**
 * （`session.deriveMessages()`）渲染成评审增量交给运行时：
 *
 * 1. **标准 stepped 会话**：可评审 `turn/end`
 *    （reason.kind ∈ completed | max-tokens | error），且必须是**最新进入
 *    过 step/start 的** turn（用户掐断的回合不评审）；
 * 2. **agentic / harness 会话**（从不发 turn/end）：人类输入到达
 *    （user/message 且 source.kind==='user'，或 agent/inbox/spliced 含 user
 *    消息）**且**存在未评审的 assistant 增量 → 评审（skipLast 排除触发
 *    输入本身）。
 *
 * **模式闩锁**：会话一旦发过任意 `turn/end` 即闩锁为标准模式。
 *
 * **增量与重写**：`messages.length < cursor`（投影回退）或可见重写事件
 * （compact/*、非 append 的 surfaceOp）→ 全量重放 + `onRewrite` 回调
 * （装配层重置 steer 冷却）。
 *
 * **幂等门（每 turn 恰好评审一次）**：标准模式的评审身份是 **`(sessionId,
 * turn)` 二元组**——`seq` **不参与身份**，只作单调守卫。两层互补：
 *  - **窗口内**靠 `reviewed` 精确集合（键 `${sessionId}::${turn}`）保证正确性；
 *  - **窗口外**靠**已裁决水位** `lastReviewedSeq` 拦截（每个 `turn/end`，无论
 *    评不评，都把水位推到 `max(水位, seq)`）。
 *
 * 水位**优先、不 fallback**：命中水位直接拦截，**不回落到 `reviewed` 集合**
 * 再裁决一次——否则被窗口淘汰的旧 turn 会重新评审，「跨重启不二次计费」落空。
 * 该机制依赖 `seq` 在同一事件流中的单调性（宿主不变量，属**前提假设**）；
 * 若宿主回退/重编号 `seq`，退化为「水位优先」：**可能漏评，绝不重复计费**
 * （漏评可由用户手动 `POST review` 补回）。
 *
 * `reviewed` 持久化到 `sessions/<base64url(sessionId)>.seen.json`（**独立
 * 文件**，不与配置同文件，避免与 PATCH 争同一 inode），读写**全程 fail-open**。
 *
 * 渲染只取前台可见文本：advisor 自己注入的消息（source.kind='advisor'）
 * 一律排除（自评审排除，防递归自评）。
 *
 * @module dsh-agents/advisor/observer
 */

import { isAdvisorMessage } from './delivery.js'

/** 可评审的 turn 结束原因（跳过用户掐断的回合）。 */
const REVIEWABLE_TURN_END_KINDS = new Set(['completed', 'max-tokens', 'error'])

/** turn/end 是否为可评审结束。 */
export function isReviewableTurnEnd(event) {
  return event?.type === 'turn/end' && REVIEWABLE_TURN_END_KINDS.has(event.data?.reason?.kind)
}

/** 事件是否触发表面重写（compact/* 或非 append 的 surfaceOp）。 */
export function isRewriteEvent(event) {
  if (typeof event?.type === 'string' && event.type.startsWith('compact/')) return true
  if (['user/message', 'assistant/message', 'tool/result'].includes(event?.type)) {
    return event.surfaceOp !== 'append'
  }
  return false
}

/** 事件是否人类输入到达（agentic 触发信号）。 */
export function isHumanInputEvent(event) {
  if (event?.type === 'user/message') return event.data?.source?.kind === 'user'
  if (event?.type === 'agent/inbox/spliced') {
    return Array.isArray(event.data?.inserted) && event.data.inserted.some((m) => m?.source?.kind === 'user')
  }
  return false
}

/**
 * 幂等 seen 集合的窗口容量 **M**。
 *
 * **取值 M=256，未经实测，按保守值取值**（S3 改动要点 6 的**路径 B**：用户
 * 2026-10-04 拍板「取保守值，不实测」；计划第 7 节 #1 的**路径 A**——实测
 * 一个会话两次重启之间的去重事件条数后回写——本轮未走）。
 *
 * **翻转条件**：日后实测出该条数超过本值，把本常量调大即可；**判据与测试
 * 一律引用本常量，禁止写死字面量**——写死会在取值变更时把正确实现误判红
 * （计划 v4 必修 2 的硬要求）。
 *
 * M 只影响「水位回退」这一降级场景：正常路径下窗口外的重放由**已裁决水位**
 * 拦截（见 `handleEvent`），故 M 偏小最多在「seq 回退后重新落回窗口外」时漏评，
 * 而不会重复计费。
 */
export const SEEN_WINDOW_SIZE = 256

/**
 * 每会话的幂等状态：精确去重集合（有界，窗口 M）+ 已裁决水位。
 *
 * `list` 与 `set` **必须并存**：`set` 供 O(1) 命中判定，`list` 供按写入顺序
 * 淘汰最旧条目（保留最近 M 条）。只留 `set` 就无法有界淘汰——那正是 S1 内存
 * LRU 跨不了重启的同型问题。
 */
class SessionSeen {
  constructor() {
    /** 已评审幂等键，按写入顺序（旧 → 新）。 */
    this.list = []
    /** `list` 的 Set 视图（命中判定）。 */
    this.set = new Set()
    /** 已裁决水位；-1 = 尚未裁决过任何 turn/end。 */
    this.lastReviewedSeq = -1
  }
}

/** 从消息 content 抽可见文本（只取 text 块；图片等以占位标注）。 */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image' || block.type === 'image-url') parts.push('[image omitted]')
  }
  return parts.join('\n').trim()
}

/**
 * 渲染可见消息表面（advisor 消息排除）。
 * @param {Array} messages - deriveMessages 结果
 * @param {number} maxMessages - 有界窗口（0 = 无上限）
 * @returns {{markdown: string, messageCount: number, charCount: number}|null}
 */
export function renderVisibleSurface(messages, maxMessages) {
  const visible = []
  for (const message of messages ?? []) {
    if (isAdvisorMessage(message)) continue // 自评审排除
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    visible.push({ role: message.role, text })
  }
  if (visible.length === 0) return null
  const windowed = maxMessages > 0 && visible.length > maxMessages ? visible.slice(-maxMessages) : visible
  const lines = windowed.map((entry) => (
    entry.role === 'user'
      ? `<用户对Agent说>\n${entry.text}\n</用户对Agent说>`
      : `<Agent对用户说>\n${entry.text}\n</Agent对用户说>`
  ))
  const markdown = lines.join('\n\n')
  return { markdown, messageCount: windowed.length, charCount: markdown.length }
}

/** 每会话的观察状态（游标 + 重建待定标记）。 */
class SessionCursor {
  constructor() {
    /** 已消费的 deriveMessages 条数（增量游标）。 */
    this.cursor = 0
    /** 是否处于"重建待定"（rewrite 事件后下一次触发全量重放）。 */
    this.pendingRebuild = false
  }

  seedTo(length) {
    this.cursor = length
    this.pendingRebuild = false
  }

  reset() {
    this.cursor = 0
    this.pendingRebuild = true
  }
}

/**
 * @param {object} options
 * @param {number} [options.maxMessages] - 有界窗口（默认 60，0 = 无上限）
 * @param {(sessionId: string) => object|undefined} options.getSession - 会话提供者
 * @param {(sessionId: string) => object} [options.sessionMeta] - { sessionId, sessionName }
 * @param {(sessionId: string, delta: object, meta: object) => void} options.onDelta
 * @param {(sessionId: string) => object} [options.loadSeen] - 读幂等快照（缺省 = 纯内存去重）
 * @param {(sessionId: string, state: object) => void} [options.saveSeen] - 写幂等快照
 * @param {number} [options.seenWindowSize] - seen 窗口容量 M（默认 SEEN_WINDOW_SIZE）
 * @param {(sessionId: string) => void} [options.onSteppedTurnEnd] - 可评审回合结束（投递冷却递减）
 * @param {(sessionId: string) => void} [options.onRewrite] - 表面重写（重置冷却）
 * @param {object} [options.logger]
 */
export class AdvisorObserver {
  constructor(options) {
    this.maxMessages = options.maxMessages ?? 60
    this.getSession = options.getSession
    this.sessionMeta = options.sessionMeta ?? (() => ({}))
    this.onDelta = options.onDelta
    /**
     * seen 窗口容量 M。**判据与测试一律引用 `SEEN_WINDOW_SIZE`，不写死
     * 字面量**——写死会在 M 变更时把正确实现误判红。
     */
    this.seenWindowSize = Number.isInteger(options.seenWindowSize) && options.seenWindowSize > 0
      ? options.seenWindowSize
      : SEEN_WINDOW_SIZE
    this.loadSeen = options.loadSeen
    this.saveSeen = options.saveSeen
    this.onSteppedTurnEnd = options.onSteppedTurnEnd
    this.onRewrite = options.onRewrite
    this.logger = options.logger ?? console
    this.cursors = new Map()
    this.pendingSeeds = new Map()
    this.turnEndSessions = new Set()
    /** 每会话「进入过 step/start 的 turn」集合（流式累积，见 handleEvent）。 */
    this.steppedTurns = new Map()
    /** 每会话幂等状态（惰性加载 seen 快照）。 */
    this.seen = new Map()
  }

  setMaxMessages(value) {
    this.maxMessages = value
  }

  /**
   * 事件入口（装配层从 session/event 监听转发）。
   *
   * `events` 只保留为**调用方契约**（装配层传整份会话事件日志）；S3 起观察器
   * **不再扫描它**——「这个 turn 有没有进入过 step/start」改为流式累积的
   * `steppedTurns`。保留该参数以免改动装配层调用点。
   */
  handleEvent(sessionId, events, event) {
    if (isRewriteEvent(event)) {
      this.cursorFor(sessionId).pendingRebuild = true
      this.onRewrite?.(sessionId)
    }
    // 「进入过 step 的 turn」改为**流式累积**（只加不删）：同一 turn 的重复
    // turn/end 由幂等键拦，这个集合的职责只剩回答「该 turn 有没有进入过
    // step/start」。若改成匹配即删，重复的第二个 turn/end 会因集合已空而被
    // 误判成「无 step 回合」，C13 就成了空门（拦它的其实是 stepped 而非键）。
    if (event?.type === 'step/start') {
      this.steppedFor(sessionId).add(String(event?.data?.turn))
    }
    if (event?.type === 'turn/end') this.turnEndSessions.add(sessionId)
    // 已裁决水位：**命中即拦截，水位优先，不 fallback 到 reviewed 集合**。
    if (event?.type === 'turn/end' && this.#advanceWatermark(sessionId, event.seq) === false) {
      this.#persistSeen(sessionId)
      return
    }
    if (isReviewableTurnEnd(event)) {
      // 必须是进入过 step/start 的 turn（拒绝/空输入/取消产生的无 step 回合
      // 不评审）。注意水位此时**已推进**，所以跳过也必须落盘（C17 半 A）。
      if (!this.steppedFor(sessionId).has(String(event?.data?.turn))) {
        this.#persistSeen(sessionId)
        return
      }
      // 幂等身份 = `(sessionId, turn)` 二元组；**seq 不参与身份**。
      const isNewTurn = this.#addReviewedKey(sessionId, `${sessionId}::${String(event?.data?.turn)}`)
      this.#persistSeen(sessionId)
      // 键已存在 → 直接 return（不评审、不递减冷却、不推进游标）
      if (!isNewTurn) return
      this.onSteppedTurnEnd?.(sessionId)
      this.renderAndEmit(sessionId)
      return
    }
    // 非可评审的 turn/end（如 aborted）同样推进并落盘水位（无 step/无需评审）
    if (event?.type === 'turn/end') {
      this.#persistSeen(sessionId)
      return
    }
    // agentic 门（模式闩锁：标准会话此门休眠）
    if (this.turnEndSessions.has(sessionId)) return
    if (!isHumanInputEvent(event)) return
    const messages = this.messagesOf(sessionId)
    if (messages === undefined) return
    // 只读谓词：没有未评审的 assistant 增量则不渲染也不推进游标
    // （会话首条用户输入不触发——首轮评审发生在第一个 turn/end）。
    // 例外：投影回退（游标比可见消息还长）必须放行——否则重写后的全量重放
    // 会被这道门挡掉，而重放本身正是"补回被回退掉的那部分评审"。
    const cursor = this.cursorFor(sessionId)
    const rolledBack = cursor.cursor > messages.length
    if (!rolledBack && !this.hasUnreviewedAssistant(sessionId, messages)) return
    this.onSteppedTurnEnd?.(sessionId)
    // 排除触发输入本身（该输入属于下一轮增量）
    this.renderAndEmit(sessionId, { skipLast: true })
  }

  /** 该会话「进入过 step/start 的 turn」集合（惰性建，不建无用条目）。 */
  steppedFor(sessionId) {
    let set = this.steppedTurns.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.steppedTurns.set(sessionId, set)
    }
    return set
  }

  /**
   * 该会话的幂等状态（**惰性**加载 seen 快照）。
   *
   * 惰性是硬要求：构造期必须零 IO——`testDataDir` 的「env 指向临时目录时
   * 真实 dataDir 不被创建/改动」判据正依赖这一点。
   */
  seenFor(sessionId) {
    let state = this.seen.get(sessionId)
    if (state === undefined) {
      state = new SessionSeen()
      if (typeof this.loadSeen === 'function') {
        try {
          const raw = this.loadSeen(sessionId)
          if (raw !== null && typeof raw === 'object') {
            if (Array.isArray(raw.reviewed)) {
              const kept = raw.reviewed.filter((k) => typeof k === 'string').slice(-this.seenWindowSize)
              state.list = kept
              state.set = new Set(kept)
            }
            if (Number.isFinite(raw.lastReviewedSeq)) state.lastReviewedSeq = raw.lastReviewedSeq
          }
        } catch (error) {
          // fail-open：seen 读失败只丢「跨重启不重复计费」这层保护，不打断评审
          this.logger.warn?.(`[dsh-agents] advisor 读 seen 失败（降级为纯内存去重）：${error?.message ?? error}`)
        }
      }
      this.seen.set(sessionId, state)
    }
    return state
  }

  /**
   * 推进已裁决水位（**水位优先**）。
   *
   * @param {string} sessionId
   * @param {number} seq - 事件的 seq；非有限值（宿主未给）→ 不拦截也不推进
   * @returns {boolean} false = 被水位拦截；true = 放行（且已推进水位）
   */
  #advanceWatermark(sessionId, seq) {
    if (!Number.isFinite(seq)) return true
    const state = this.seenFor(sessionId)
    // ★水位优先：命中即 return，**不回落到 reviewed 集合**再裁决一次
    if (seq <= state.lastReviewedSeq) return false
    state.lastReviewedSeq = seq
    return true
  }

  /**
   * 把幂等键加入有界集合（窗口内保留最近 M 条，最旧的先淘汰）。
   * @returns {boolean} true = 新键（该 turn 首次评审）；false = 键已存在
   */
  #addReviewedKey(sessionId, key) {
    const state = this.seenFor(sessionId)
    if (state.set.has(key)) return false
    state.set.add(key)
    state.list.push(key)
    if (state.list.length > this.seenWindowSize) {
      state.set.delete(state.list.shift())
    }
    return true
  }

  /** 落盘 seen 快照（无写回调 = 纯内存去重；写失败只告警，不打断评审）。 */
  #persistSeen(sessionId) {
    if (typeof this.saveSeen !== 'function') return
    const state = this.seen.get(sessionId)
    if (state === undefined) return
    try {
      this.saveSeen(sessionId, { reviewed: state.list.slice(), lastReviewedSeq: state.lastReviewedSeq })
    } catch (error) {
      this.logger.warn?.(`[dsh-agents] advisor 写 seen 失败（评审照常）：${error?.message ?? error}`)
    }
  }

  /** 是否存在未评审的 assistant 增量（agentic 门控谓词，只读）。 */
  hasUnreviewedAssistant(sessionId, messages) {
    const cursor = this.cursorFor(sessionId)
    if (messages.length <= cursor.cursor) return false
    for (let i = cursor.cursor; i < messages.length; i++) {
      const message = messages[i]
      if (message?.role === 'assistant' && !isAdvisorMessage(message)) return true
    }
    return false
  }

  /** 渲染（增量或重建）并回调 onDelta。 */
  renderAndEmit(sessionId, options = {}) {
    const messages = this.messagesOf(sessionId)
    if (messages === undefined) return
    const cursor = this.cursorFor(sessionId)
    // 投影回退检测：结果比已消费的还短 → 全量重放
    if (!cursor.pendingRebuild && cursor.cursor > messages.length) cursor.pendingRebuild = true
    const effective = options.skipLast === true && messages.length > 0 ? messages.slice(0, -1) : messages
    if (cursor.pendingRebuild || cursor.cursor === 0) {
      cursor.pendingRebuild = false
      const delta = renderVisibleSurface(effective, this.maxMessages)
      if (delta === null) return
      cursor.cursor = effective.length
      this.onDelta(sessionId, delta, this.sessionMeta(sessionId))
      return
    }
    if (effective.length <= cursor.cursor) return
    const added = effective.slice(cursor.cursor)
    const delta = renderVisibleSurface(added, this.maxMessages)
    if (delta === null) return // 无可见内容：不推进游标，下轮还在窗口里
    cursor.cursor = effective.length
    this.onDelta(sessionId, delta, this.sessionMeta(sessionId))
  }

  /** 只读取快照（拿不到/抛错 → undefined，绝不外抛）。 */
  messagesOf(sessionId) {
    const session = this.getSession(sessionId)
    if (session === undefined || session === null || typeof session.deriveMessages !== 'function') return undefined
    try {
      const messages = session.deriveMessages()
      return Array.isArray(messages) ? messages : undefined
    } catch (error) {
      this.logger.warn?.(`[dsh-agents] advisor deriveMessages 抛错（本轮跳过）：${error?.message ?? error}`)
      return undefined
    }
  }

  cursorFor(sessionId) {
    let cursor = this.cursors.get(sessionId)
    if (cursor === undefined) {
      cursor = new SessionCursor()
      const seed = this.pendingSeeds.get(sessionId)
      if (seed !== undefined) {
        cursor.seedTo(seed)
        this.pendingSeeds.delete(sessionId)
      }
      this.cursors.set(sessionId, cursor)
    }
    return cursor
  }

  /** 会话销毁：清理**内存**观察状态（seen 文件**不动** —— C7：
   *  disposeSession 只清内存，持久化的幂等集合必须留在盘上，
   *  否则会话销毁再重建就会重复计费）。 */
  disposeSession(sessionId) {
    this.cursors.delete(sessionId)
    this.pendingSeeds.delete(sessionId)
    this.turnEndSessions.delete(sessionId)
    this.steppedTurns.delete(sessionId)
    this.seen.delete(sessionId)
  }

  /** 中途开启：seed 到当前长度（不全量回放历史）。 */
  seedTo(sessionId, length) {
    const cursor = this.cursors.get(sessionId)
    if (cursor === undefined) {
      this.pendingSeeds.set(sessionId, length)
      return
    }
    cursor.seedTo(length)
  }

  /** 手动触发：复位游标 → 下一次渲染全量重放（端点 POST review 用）。 */
  resetCursor(sessionId) {
    this.cursors.delete(sessionId)
    this.pendingSeeds.delete(sessionId)
  }
}