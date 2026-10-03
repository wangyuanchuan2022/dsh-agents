/**
 * advisor 评审运行时（契约 §7 输出契约 + §6 触发后的评审执行）。
 *
 * 每个被评审的主会话一条运行时：
 *  - **有界队列**（advisorMaxQueued，默认 32，满 = drop-newest，永不阻塞主循环）；
 *  - **串行 drain**（fire-and-forget），一次只在飞一轮评审；
 *  - **评审员持续会话**：世界事件（主会话可见消息）为 user 消息、她自己的
 *    建议为 assistant 消息，逐条累积；每次评审**全量重放**（无截断），上下文
 *    **只属于 advisor**（契约 §0：继承主会话零上下文）；
 *  - **严格 JSON 输出解析**：只接受 `{ "notes": [ { "severity", "text" } ] }`
 *    （契约 §7）。解析失败 → runtime.status='error'、不投递、写日志并落一条
 *    error 记录（不吞错）；
 *  - **调用超时**（advisorCallTimeoutMs，默认 90s）：AbortSignal + 每次 next 的
 *    竞争兜底（provider 忽略 AbortSignal 也能退出）；
 *  - **评审窗口**：单轮最多 advisorMaxMessages 条可见消息入窗（由 observer 侧
 *    渲染截断，此处只做一次防御性再截断）。
 *
 * 纯类：llm / 存储 / 投递全部注入，测试可用桩件替换。
 *
 * @module dsh-agents/advisor/runtime
 */

/** 输出 token 上限（5120：避免推理把预算吃光导致空回复）。 */
export const ADVISOR_MAX_TOKENS = 5_120

/** 单条意见文本上限（契约 §4：单条 ≤200 字，这里留一点余量后由 store 截断）。 */
export const ADVISOR_NOTE_MAX_CHARS = 400

/** 内置评审提示词（advisorSystemPrompt 非空时整体覆盖本段）。 */
export const DEFAULT_ADVISOR_SYSTEM_PROMPT = `你是一个独立的顾问（advisor），挂在主会话旁边实时观察并给出分级建议。

你看到的是主会话的**可见消息**（用户输入与主 Agent 回复，按时间顺序；advisor 自己注入的消息不会出现在这里）。你的上下文与主 Agent 完全独立——你不读它的记忆、也不假设它记得什么。

严重度分级（契约）：
- info：可做可不做的小提示；不采纳也完全没问题。
- nit：值得顺手处理的明确改进点（命名、格式、表达清晰度、边界情况）。
- concern：值得在继续之前权衡的重大风险，或明显更优的方向。
- blocker：继续下去明显是浪费工作（与用户显式指令矛盾、原地打转、方案根本不可行）。

输出格式：**严格 JSON**，不要输出任何其他内容（不要散文、不要 markdown 围栏）：
{"notes":[{"severity":"info|nit|concern|blocker","text":"建议正文"}]}

规则：
- notes 数组可以为空（没有值得说的就返回 {"notes":[]}）——宁缺毋滥，不要为说而说。
- 每条 text 是针对当前可见消息的具体、可执行、简洁的观察。
- 评审输入可能含用户隐私或密钥——绝不回显 secret、绝不引用敏感原文。
- 你的建议会**以用户指令的形式进入主会话**（主 Agent 会把它当成用户说的话）：请用命令式、第一人称用户口吻书写（如"请把 X 补上"），不要出现"我是顾问""作为评审员"等暴露身份的措辞。
- 用中文输出。`

/** 评审员持续会话上下文（契约 §0/§7：跨回合累积，只属于 advisor）。 */
export class AdvisorConversation {
  constructor() {
    /** { role: 'user'|'assistant', text } 时间序。 */
    this.messages = []
  }

  get length() {
    return this.messages.length
  }

  appendUser(text) {
    if (String(text ?? '') === '') return
    this.messages.push({ role: 'user', text: String(text) })
  }

  appendAssistant(text) {
    if (String(text ?? '') === '') return
    this.messages.push({ role: 'assistant', text: String(text) })
  }

  /** 快照（供调用全量重放；返回新数组，调用方不得原地改）。 */
  snapshot() {
    return this.messages.map((message) => ({ ...message }))
  }

  stats() {
    let charCount = 0
    for (const message of this.messages) charCount += message.text.length
    return { messageCount: this.messages.length, charCount }
  }

  reset() {
    this.messages.length = 0
  }
}

/**
 * 严格解析评审模型输出（契约 §7）。
 * @param {string} raw - 模型回复全文
 * @returns {{notes: Array<{severity:string,text:string}>}|{error:string}}
 *   { error } 表示输出不合约——调用方据此记 runtime.status='error' 且不投递。
 */
export function parseReviewOutput(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { error: '评审模型返回空内容' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 严格契约：不剥围栏、不做括号配对提取——**解析失败就大声报错**，
    // 半吊子容错会把「模型没按契约输出」伪装成「评审没有意见」。
    return { error: `评审输出不是严格 JSON：${text.slice(0, 120)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '评审输出必须是 JSON 对象 { "notes": [...] }' }
  }
  const notes = parsed.notes
  if (!Array.isArray(notes)) return { error: '评审输出缺少 notes 数组' }
  const out = []
  for (const note of notes) {
    if (note === null || typeof note !== 'object' || Array.isArray(note)) {
      return { error: 'notes 元素必须是 { severity, text } 对象' }
    }
    const body = typeof note.text === 'string' ? note.text.trim() : ''
    if (body === '') continue // 空意见丢弃（非解析失败）
    const severity = ['info', 'nit', 'concern', 'blocker'].includes(note.severity) ? note.severity : 'nit'
    out.push({
      severity,
      text: body.length > ADVISOR_NOTE_MAX_CHARS ? `${body.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)}…` : body,
    })
  }
  return { notes: out }
}

/** 一次性取迭代器下一个值并与信号竞争（provider 忽略 AbortSignal 时的兜底）。 */
function raceNext(iterator, signal) {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => { signal.removeEventListener('abort', onAbort); resolve(result) },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
  })
}

/**
 * 一条会话的评审运行时。
 * @param {object} options
 * @param {string} options.provider
 * @param {string} options.model
 * @param {string} options.systemPrompt
 * @param {{stream: Function}} options.llm - llm 服务（必须经 root 解析链拿，见 lib/index.js）
 * @param {(note, meta) => void} options.deliver - 投递回调（内部走 AdvisorDelivery.route）
 * @param {(record) => void} options.record - 记录落盘回调（store.append）
 * @param {(status: object) => void} [options.onStatus] - 运行时状态变化回调
 * @param {number} [options.maxQueued]
 * @param {number} [options.callTimeoutMs]
 * @param {number} [options.maxMessages] - 防御性再截断（observer 已截过）
 * @param {object} [options.logger]
 */
export class AdvisorRuntime {
  constructor(options) {
    this.provider = options.provider
    this.model = options.model
    this.systemPrompt = options.systemPrompt
    this.llm = options.llm
    this.deliver = options.deliver
    this.record = options.record
    this.onStatus = options.onStatus ?? (() => {})
    this.maxQueued = Number.isInteger(options.maxQueued) && options.maxQueued > 0 ? options.maxQueued : 32
    this.callTimeoutMs = Number.isInteger(options.callTimeoutMs) && options.callTimeoutMs > 0 ? options.callTimeoutMs : 90_000
    this.maxMessages = Number.isInteger(options.maxMessages) && options.maxMessages > 0 ? options.maxMessages : 60
    this.logger = options.logger ?? console
    /**
     * 取证钩子（默认 undefined = 关闭）。设 ADVISOR_TRACE_ENV 后由装配层注入，
     * 把**完整 chunk 序列**（含 finish.reason 与 usage）逐条落盘，用于判定
     * 「空内容」究竟是代码缺陷还是特定模型的输出形态。见 agent-out/advisor-issues.md 第 1.2 节。
     */
    this.trace = typeof options.trace === 'function' ? options.trace : undefined
    this.conversation = new AdvisorConversation()
    /** @type {Array<{delta: object, meta: object}>} */
    this.queue = []
    this.status = 'idle'
    this.lastAt = 0
    this.error = null
    this.draining = false
    this.disposed = false
    this.drainPromise = null
    this.controller = new AbortController()
    /** dispose 代数：迟到回调比对代数丢弃。 */
    this.generation = 0
  }

  /** 端点下发的运行时快照（契约 §2 GET 的 runtime 字段）。 */
  statusSnapshot() {
    return { status: this.status, lastAt: this.lastAt, queue: this.queue.length, error: this.error }
  }

  /** 队列满则丢弃最新（drop-newest，最旧的更值得评审）。 */
  enqueue(delta, meta) {
    if (this.disposed) return false
    if (this.queue.length >= this.maxQueued) {
      this.logger.warn?.(`[dsh-agents] advisor 队列已满（${this.maxQueued}），丢弃最新一轮增量`)
      return false
    }
    this.queue.push({ delta, meta })
    this.kick()
    return true
  }

  kick() {
    if (this.draining || this.disposed) return
    this.#setStatus('reviewing')
    this.drainPromise = this.drain().catch((error) => {
      this.logger.error?.('[dsh-agents] advisor drain 异常（已就地吞掉，不影响主会话）：', error?.message ?? error)
    })
  }

  /** 串行 drain：逐个处理队列增量。 */
  async drain() {
    this.draining = true
    const gen = this.generation
    try {
      while (!this.disposed && this.queue.length > 0 && gen === this.generation) {
        const { delta, meta } = this.queue.shift()
        try {
          await this.process(delta, meta, gen)
        } catch (error) {
          this.logger.error?.('[dsh-agents] advisor 单轮评审异常（已含在 runtime 内）：', error?.message ?? error)
        }
      }
    } finally {
      this.draining = false
      // 只有「正常跑完一轮」才回落 idle——error 状态必须留住（契约 §7：
      // 解析失败要能从 runtime.status 看出来，不能被 drain 收尾悄悄抹平）
      if (!this.disposed && gen === this.generation && this.status === 'reviewing') this.#setStatus('idle')
    }
  }

  #setStatus(status, error = null) {
    this.status = status
    this.error = error
    this.lastAt = Date.now()
    this.onStatus(this.statusSnapshot())
  }

  /**
   * 处理一轮增量：入窗 → 全量重放持续会话 → 调模型 → 严格解析 → 逐条投递+落记录。
   * @param {object} delta - { markdown, messageCount, charCount }
   * @param {object} meta - { sessionId, sessionName }
   * @param {number} gen - 入队时的 dispose 代数
   */
  async process(delta, meta, gen) {
    if (this.disposed || gen !== this.generation) return
    const markdown = String(delta?.markdown ?? '')
    if (markdown.trim() === '') return // 无可见内容：不调模型
    this.lastAt = Date.now()
    // 本轮增量只追加一次（commit 在模型调用之后做，避免失败时重复入窗两次）
    const streamed = await this.callModel(markdown, gen)
    if (streamed.kind === 'aborted') return
    if (streamed.kind === 'failure') {
      this.#setStatus('error', streamed.message)
      this.logger.error?.(`[dsh-agents] advisor 评审调用失败：${streamed.message}`)
      return
    }
    // 调用成功：无论后续投递如何，输入都算「评审员已见过」
    this.conversation.appendUser(`### 会话增量（sessionId=${meta.sessionId}）\n${markdown}`)
    const parsed = parseReviewOutput(streamed.text)
    if (parsed.error !== undefined) {
      // 契约 §7：解析失败不投递、不吞错——状态置 error + 落一条记录说明
      this.#setStatus('error', parsed.error)
      this.logger.error?.(`[dsh-agents] advisor 输出解析失败（未投递）：${parsed.error}`)
      this.record?.({
        sessionId: meta.sessionId,
        sessionName: meta.sessionName ?? null,
        severity: 'info',
        text: `评审输出解析失败：${parsed.error}`.slice(0, 200),
        outcome: 'dropped',
      })
      return
    }
    // 输出契约通过：error 清空（下一轮起可正常评审），状态回 idle
    this.#setStatus('idle')
    for (const note of parsed.notes) {
      if (this.disposed || gen !== this.generation) return
      let outcome = false
      try {
        outcome = this.deliver(note, meta)
      } catch (error) {
        outcome = false
        this.logger.error?.('[dsh-agents] advisor 投递异常（记 dropped）：', error?.message ?? error)
      }
      const finalOutcome = outcome === false ? 'dropped' : outcome
      if (finalOutcome !== 'dropped') {
        this.conversation.appendAssistant(`[${note.severity}] ${note.text}`)
      }
      this.record?.({
        sessionId: meta.sessionId,
        sessionName: meta.sessionName ?? null,
        severity: note.severity,
        text: note.text,
        outcome: finalOutcome,
      })
    }
  }

  /**
   * 一次流式调用（含调用级超时兜底）。
   * @returns {{kind:'ok',text:string}|{kind:'failure',message:string}|{kind:'aborted'}}
   */
  /**
   * fail-open 的取证发射：诊断钩子由装配层注入，任何异常都不得冒泡打断评审循环
   * （否则一个只该丢日志的故障会变成「评审停摆」）。
   */
  emitTrace(row) {
    const trace = this.trace
    if (typeof trace !== 'function') return
    try { trace(row) } catch { /* fail-open */ }
  }

  async callModel(markdown, gen) {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort('advisor call timeout'), this.callTimeoutMs)
    const onDispose = () => deadline.abort('advisor disposed')
    this.controller.signal.addEventListener('abort', onDispose, { once: true })
    let text = ''
    try {
      const messages = this.buildMessages(markdown)
      this.emitTrace({
        phase: 'call-start',
        provider: this.provider,
        model: this.model,
        maxTokens: ADVISOR_MAX_TOKENS,
        messageCount: messages.length,
      })
      const stream = this.llm.stream({
        provider: this.provider,
        model: this.model,
        system: this.systemPrompt,
        messages,
        maxTokens: ADVISOR_MAX_TOKENS,
        signal: deadline.signal,
      })
      const iterator = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await raceNext(iterator, deadline.signal)
        if (next === 'aborted') {
          iterator.return?.().catch(() => {})
          if (deadline.signal.aborted && !this.controller.signal.aborted) {
            return { kind: 'failure', message: `评审调用超时（${this.callTimeoutMs}ms）` }
          }
          return { kind: 'aborted' }
        }
        if (next.done) break
        const chunk = next.value
        this.emitTrace({
          phase: 'chunk',
          type: chunk?.type ?? null,
          index: chunk?.index ?? null,
          text: typeof chunk?.text === 'string' ? chunk.text.length : null,
          name: chunk?.name ?? null,
          reason: chunk?.reason ?? null,
          usage: chunk?.usage ?? null,
        })
        if (chunk?.type === 'text-delta') text += chunk.text
      }
      this.emitTrace({ phase: 'call-end', textLength: text.length })
    } catch (error) {
      return { kind: 'failure', message: error?.message ?? String(error) }
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', onDispose)
    }
    if (this.disposed || gen !== this.generation) return { kind: 'aborted' }
    return { kind: 'ok', text }
  }

  /**
   * 构造模型输入：评审员持续会话全量重放 + 本轮增量段。
   * 契约 §0：上下文只属于 advisor——这里不混入主会话的任何隐藏上下文。
   */
  buildMessages(markdown) {
    const history = this.conversation.snapshot()
    const messages = history.map((message) => ({
      role: message.role,
      id: crypto.randomUUID(),
      content: [{ type: 'text', text: message.text }],
      source: message.role === 'assistant' ? { kind: 'model' } : { kind: 'user' },
    }))
    // 本轮增量作为最后一条 user 消息（条数窗口由 observer 侧的
    // advisorMaxMessages 控制，这里不再二次截断内容——重复截断会把
    // 「有界窗口」这一条契约拆成两处实现，容易漂移）
    messages.push({
      role: 'user',
      id: crypto.randomUUID(),
      content: [{ type: 'text', text: markdown }],
      source: { kind: 'user' },
    })
    return messages
  }

  /** 测试钩子：等当前 drain 轮次结束。 */
  async waitForDrain() {
    await this.drainPromise
  }

  /** 中止 in-flight 并停止 drain（幂等）。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.controller.abort('advisor disposed')
    this.queue.length = 0
    this.status = 'disabled'
    this.error = null
  }
}