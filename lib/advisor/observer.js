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
 * 找最新一条"进入过至少一个 step"的已关闭 turn 的 turn/end 事件。
 * @param {Array} events - 会话事件日志
 * @returns {object|undefined}
 */
export function findLastMessageTurnEnd(events) {
  const steppedTurns = new Set()
  let latest
  for (const event of events ?? []) {
    if (event?.type === 'step/start') {
      steppedTurns.add(event.data?.turn)
      continue
    }
    if (event?.type === 'turn/end' && steppedTurns.delete(event.data?.turn)) latest = event
  }
  return latest
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
    this.onSteppedTurnEnd = options.onSteppedTurnEnd
    this.onRewrite = options.onRewrite
    this.logger = options.logger ?? console
    this.cursors = new Map()
    this.pendingSeeds = new Map()
    this.turnEndSessions = new Set()
  }

  setMaxMessages(value) {
    this.maxMessages = value
  }

  /** 事件入口（装配层从 session/event 监听转发）。 */
  handleEvent(sessionId, events, event) {
    if (isRewriteEvent(event)) {
      this.cursorFor(sessionId).pendingRebuild = true
      this.onRewrite?.(sessionId)
    }
    if (event?.type === 'turn/end') this.turnEndSessions.add(sessionId)
    if (isReviewableTurnEnd(event)) {
      // 必须是最新进入过 step 的 turn（拒绝/空输入/取消产生的无 step 回合不评审）
      const latest = findLastMessageTurnEnd(events)
      if (latest === undefined || latest.seq !== event.seq) return
      this.onSteppedTurnEnd?.(sessionId)
      this.renderAndEmit(sessionId)
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

  /** 会话销毁：清理观察状态。 */
  disposeSession(sessionId) {
    this.cursors.delete(sessionId)
    this.pendingSeeds.delete(sessionId)
    this.turnEndSessions.delete(sessionId)
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