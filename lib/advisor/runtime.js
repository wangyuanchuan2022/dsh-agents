/**
 * advisor 评审运行时（契约 §7 输出契约 + §6 触发后的评审执行）。
 *
 * 每个被评审的主会话一条运行时：
 *  - **有界队列**（advisorMaxQueued，默认 32，满 = drop-newest，永不阻塞主循环）；
 *  - **串行 drain**（fire-and-forget），一次只在飞一轮评审；
 *  - **评审员持续会话**：世界事件（主会话可见消息）为 user 消息、她自己的
 *    建议为 assistant 消息，逐条累积但**字符预算有界**（超预算丢最旧，见
 *    {@link ADVISOR_CONVERSATION_MAX_CHARS}——P1-3：无界累积会在模型上下文
 *    上限处永久停摆）；每次评审重放有界历史 + 本轮增量，上下文**只属于
 *    advisor**（契约 §0：继承主会话零上下文）；
 *  - **终态优先级链**（契约 §7 / S4）：先看 provider 的 `finishReason`、再看
 *    用量、最后才看正文——触顶（`max-tokens`）或终态不可信时**一律不投递**，
 *    记 runtime.status='error' + 落一条 error 记录（**绝不降级** info/recorded）。
 *    判定跑在输出解析**之前**，否则被截断的正文会伪装成「解析失败」；
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

/**
 * 输出 token 上限（16384）。
 *
 * U1「不对冲」：抬预算**不下调**输入窗口（`advisorMaxMessages` 保持 60），
 * 成本量级约 3.2 倍（单轮 input≈8.5K + output 封顶 ≈16K ≈ 25K tokens），
 * 用户知情接受。触发上限的语义见 {@link classifyCompletion}。
 */
export const ADVISOR_MAX_TOKENS = 16_384

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

/**
 * 评审员持续会话的字符预算（P1-3 修复，2026-10-06）。
 *
 * **为什么必须有界**：每次评审把整个持续会话重放进模型输入，无界累积下
 * 单轮输入 = Σ全部历史增量，按每 turn 增量 1-3K tokens 计约 40-120 turn
 * 即超过 128K 上下文窗口 → llm 调用必败 → `runtime.status='error'` 且无自愈
 * 路径（评审终稿 P1-3：长会话必然永久停摆）。超预算丢最旧（修剪后悬空的
 * assistant 头一并淘汰）；单条超预算的消息整条不进历史——本轮增量本身
 * 不走会话（process 在模型调用后才入窗），照常单独送模型。
 *
 * **取值口径（保守估算，非精确值）**：按最坏 1 token/字符（CJK）计，历史
 * ≤96K tokens；加首轮典型增量 ≈8.5K + 系统提示 ≈1K + 输出封顶 16K ≈ 121.5K
 * < 128K。实际中文 tokenizer ≈0.6 token/字符，真实余量更大。预算只约束
 * **历史**——本轮增量由 observer 侧 `advisorMaxMessages` 窗口约束（唯一实现点，
 * 此处不重复截断）。
 */
export const ADVISOR_CONVERSATION_MAX_CHARS = 96_000

/** 评审员持续会话上下文（契约 §0/§7：跨回合累积，只属于 advisor；字符预算有界）。 */
export class AdvisorConversation {
  constructor(options = {}) {
    /** { role: 'user'|'assistant', text } 时间序。 */
    this.messages = []
    // 预算：正整数生效（测试可注入小值）；缺省/非法值回落常量（classifyCompletion 同款防御，
    // 坏值不得让有界化退化成恒无界）。
    this.maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : ADVISOR_CONVERSATION_MAX_CHARS
  }

  get length() {
    return this.messages.length
  }

  appendUser(text) {
    if (String(text ?? '') === '') return
    this.messages.push({ role: 'user', text: String(text) })
    this.#enforceBound()
  }

  appendAssistant(text) {
    if (String(text ?? '') === '') return
    this.messages.push({ role: 'assistant', text: String(text) })
    this.#enforceBound()
  }

  /**
   * 有界化（P1-3）：超预算从最旧开始淘汰；修剪后不得以悬空 assistant 开头
   * （其对应的 user 增量已被淘汰，留着会让历史从半截对话开始）。
   * 单条超预算的消息会被整条淘汰（循环判据是「总量超预算」而非「条数」）。
   */
  #enforceBound() {
    let total = 0
    for (const message of this.messages) total += message.text.length
    while (this.messages.length > 0 && total > this.maxChars) {
      total -= this.messages[0].text.length
      this.messages.shift()
    }
    while (this.messages.length > 0 && this.messages[0].role === 'assistant') {
      this.messages.shift()
    }
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

/** 已登记的 `finishReason` 取值（契约 §7）。表外的取值一律按「未登记」fail-closed。 */
export const ADVISOR_FINISH_KINDS = Object.freeze(['stop', 'max-tokens', 'error', 'aborted'])

/**
 * 评审终态的**显式优先级链**（契约 §7）。
 *
 * ⚠️ **顺序即语义，不可重排**（S4 的 P0 修正项 F-1）。用 if 早返回逐条表达，
 * 而不是查一张「顺序表」——顺序表会掩盖「谁压过谁」：
 *
 * | 优先级 | 条件 | outcome | 投递 |
 * |---|---|---|---|
 * | 1 | `finishReason === 'max-tokens'` | `truncated`（**无条件**） | 否 |
 * | 2 | `finishReason ∈ {error, aborted}` | `failed` | 否 |
 * | 3 | 未知 / 未登记的 kind 值 | `unknown`（fail-closed） | 否 |
 * | 4 | 触及 token 上限（`finishReason ∈ {null, stop}`） | 缺 finish → `truncated`；`stop` → `inconsistent` | 否 |
 * | 5 | 正文为空 | `empty` | 否 |
 * | 6 | 未触顶 + 正文非空（`finishReason ∈ {null, stop}`） | `ok` | 是 |
 *
 * **硬约束 1**：**即使正文为空，只要 `finishReason === 'max-tokens'`，必须判 `truncated`
 * 而非 `empty`**——优先级 1 压过优先级 5。把 empty 检查挪到 kind 判定之前即缺陷形态
 * （注入必红 N25 专守这条优先关系）。
 *
 * **硬约束 2（P2-1）**：**触顶是事实，正文为空只是表象**——优先级 4（触顶）压在
 * 优先级 5（empty）之上。否则 `stop` + 恰好触顶 + 空正文会落 `empty`，触顶事实被
 * empty 文案完全掩掉（注入必红 P2-1 守这条）。
 *
 * **硬约束 3（P1-1）**：**优先级 4 的 `finishReason === null` 分支不得整体 return**——
 * 未触顶时必须让控制流**落到优先级 5**，否则「正文为空」这一档在该分支下永不可达
 * （`{finishReason:null, outputTokens:100, text:''}` 会被误判成可投递的 `ok`；
 * 注入必红 P1-1 守这条）。
 *
 * **裁决 A：两种「kind 不可信」必须分开，不得合并成一条 fail-closed**：
 *  - **未知 / 未登记的 kind 值**（协议扩展或异常，如 `'some-future-kind'`、`'length'`）
 *    → `unknown`，不投递；
 *  - **`finish` 缺失但 `usage` 在**（provider 形态差异，AC-25 要求「允许任一缺失」）
 *    → **按 usage 判定**，见优先级 4 / 6。
 *
 * 合并两者会误杀「不返 finish 但 usage 正常」的 provider——那不是异常而是正常形态；
 * 同理「usage 缺失但 `finish='stop'`」也不 fail-closed（优先级 6 → `ok` +
 * `usageUnknown:true`）。注入必红 N25pp/D14_3 分别守这两侧不被合并。
 *
 * @param {object} input
 * @param {string|null} [input.finishReason] - `type==='finish'` 分片的 `reason`
 * @param {number|undefined} [input.outputTokens] - `type==='usage'` 分片的 `usage.outputTokens`
 * @param {number} [input.maxTokens] - 本轮输出预算上限；非正数 / 非数时回落到
 *   {@link ADVISOR_MAX_TOKENS}（`classifyCompletion` 是导出纯函数，调用方可能传进
 *   坏值；生产侧由本模块常量提供，见 `callModel`）
 * @param {string} [input.text] - 本轮模型正文
 * @returns {{outcome: string, deliverable: boolean, usageUnknown: boolean,
 *            finishReason: string|null, outputTokens: number|null,
 *            maxTokens: number, detail: string}}
 */
export function classifyCompletion(input = {}) {
  const finishReason = typeof input.finishReason === 'string' && input.finishReason !== '' ? input.finishReason : null
  const outputTokens = Number.isFinite(input.outputTokens) ? Number(input.outputTokens) : null
  // 防御性回落：坏预算值（0 / 负数 / NaN / 字符串）一律用本模块常量，绝不让 hitCap
  // 退化成「恒真」或「恒假」。
  const maxTokens = Number.isFinite(input.maxTokens) && Number(input.maxTokens) > 0
    ? Number(input.maxTokens)
    : ADVISOR_MAX_TOKENS
  const text = typeof input.text === 'string' ? input.text : ''
  const usageUnknown = outputTokens === null
  const hitCap = outputTokens !== null && outputTokens >= maxTokens
  const base = { usageUnknown, finishReason, outputTokens, maxTokens }
  const cap = `${outputTokens ?? '无用量'}/${maxTokens}`

  // 优先级 1：max-tokens **无条件** truncated（必须压过优先级 5 的 empty 判定）。
  if (finishReason === 'max-tokens') {
    return {
      ...base,
      outcome: 'truncated',
      deliverable: false,
      detail: `评审输出触及输出预算上限被截断（finishReason=max-tokens，${cap} tokens，未投递）`,
    }
  }
  // 优先级 2：error / aborted 与既有失败路径合流。
  if (finishReason === 'error' || finishReason === 'aborted') {
    return {
      ...base,
      outcome: 'failed',
      deliverable: false,
      detail: `评审调用以 finishReason=${finishReason} 结束（${cap} tokens，未投递）`,
    }
  }
  // 优先级 3：未登记的 kind 值（不是「字段缺失」）→ fail-closed。
  if (finishReason !== null && !ADVISOR_FINISH_KINDS.includes(finishReason)) {
    return {
      ...base,
      outcome: 'unknown',
      deliverable: false,
      detail: `评审返回未登记的 finishReason=${finishReason}（fail-closed，未投递）`,
    }
  }
  // ── 到这里 finishReason ∈ {null, 'stop'}（未登记值已在上一步 fail-closed）──

  // 优先级 4：触及 token 上限 —— **触顶事实优先于一切表象判定**（含「正文为空」）。
  //   · finish 缺失 + 触顶（AC-25/D12）：触顶事实成立 → truncated；
  //   · stop + 触顶：矛盾态（stop ≠ 成功）→ inconsistent。
  //   两者行为一致：不投递 + error，只是标签不同以免诊断时混淆。
  if (hitCap) {
    if (finishReason === null) {
      return {
        ...base,
        outcome: 'truncated',
        deliverable: false,
        detail: `评审输出触及输出预算上限被截断（未收到 finish，用量已达 ${cap} tokens，未投递）`,
      }
    }
    return {
      ...base,
      outcome: 'inconsistent',
      deliverable: false,
      detail: `评审矛盾态：finishReason=stop 但用量已达输出预算上限（${cap} tokens，stop ≠ 成功，未投递）`,
    }
  }

  // 优先级 5：正文为空。此处**触顶已被优先级 4 排除**，故 empty 不会掩掉触顶事实
  // （硬约束 2）；此处**未触顶**，故 empty 是对该轮的准确描述（硬约束 3）。
  if (text.trim() === '') {
    return { ...base, outcome: 'empty', deliverable: false, detail: '评审正文为空（未投递）' }
  }

  // 优先级 6：kind ∈ {null, 'stop'}、未触顶、正文非空 → 正常投递。
  return {
    ...base,
    outcome: 'ok',
    deliverable: true,
    detail: usageUnknown
      ? `评审未收到用量，按未触顶处理（${cap} tokens，usageUnknown）`
      : `评审正常完成（${cap} tokens，未触顶${finishReason === null ? '，未收到 finish' : ''}）`,
  }
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
 * @param {number} [options.conversationMaxChars] - 持续会话字符预算（缺省 =
 *   ADVISOR_CONVERSATION_MAX_CHARS；测试注入小值用，见 P1-3 判据）
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
    // P1-3：持续会话有界（conversationMaxChars 可注入小值供测试；生产缺省即常量预算）
    this.conversation = new AdvisorConversation({ maxChars: options.conversationMaxChars })
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
   * 处理一轮增量：入窗 → 重放有界持续会话 → 调模型 → 严格解析 → 逐条投递+落记录。
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
    // ★ 终态判定**跑在 parseReviewOutput 之前**：触顶/失败/未知 kind 一律不投递
    //   且不降级（U3）。若反序，被截断的正文会先撞上「解析失败」路径，把真正的
    //   触顶事实伪装成格式问题（注入必红 D14④ 守这条次序）。
    const completion = classifyCompletion({
      finishReason: streamed.finishReason,
      outputTokens: streamed.outputTokens,
      maxTokens: ADVISOR_MAX_TOKENS,
      text: streamed.text,
    })
    if (!completion.deliverable) {
      this.#setStatus('error', completion.detail)
      this.logger.error?.(`[dsh-agents] advisor ${completion.outcome}（未投递）：${completion.detail}`)
      this.record?.({
        sessionId: meta.sessionId,
        sessionName: meta.sessionName ?? null,
        severity: 'info',
        text: completion.detail.slice(0, 200),
        outcome: 'dropped',
      })
      return
    }
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
   * @returns {{kind:'ok',text:string,finishReason:string|null,outputTokens:number|null}
   *          |{kind:'failure',message:string}|{kind:'aborted'}}
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
    // 终态与用量：**取最后一个出现的值**（provider 可能先发预估 usage 再发最终 usage）。
    let finishReason = null
    let outputTokens = null
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
          // ⚠️ 这里**只记长度、不采样正文**：trace 落在用户数据目录里，正文采样等于
          // 把主会话内容与模型原文复制一份出去（R6 射程，本轮已撤）。
          // 内容级诊断改走「长度 + usage + reason」三元组先定位到具体分片。
          name: chunk?.name ?? null,
          reason: chunk?.reason ?? null,
          usage: chunk?.usage ?? null,
        })
        if (chunk?.type === 'text-delta') text += chunk.text
        // 终态判定所需的两路信号（契约 §7）：`type==='finish'` 的 `reason` 与
        // `type==='usage'` 的 `usage.outputTokens`。
        //
        // **语义 = last-wins（后出现的值覆盖先出现的）**，不是 first-wins：provider
        // 常先发一个**预估 usage**（偏小）再发最终 usage，若取先出现的值会低估
        // outputTokens → 被截断的评审判 `ok` → **照常投递，直接绕过 U3 与 F-1**。
        // finish 同理（协议可能先给中间态 reason 再给终态 reason）。
        // 注入必红 P1-2f / P1-2u 守这条（两组用例都构造 first≠last 两个值）。
        if (chunk?.type === 'finish' && typeof chunk.reason === 'string') finishReason = chunk.reason
        if (chunk?.type === 'usage' && Number.isFinite(chunk?.usage?.outputTokens)) {
          outputTokens = Number(chunk.usage.outputTokens)
        }
      }
      this.emitTrace({ phase: 'call-end', textLength: text.length })
    } catch (error) {
      return { kind: 'failure', message: error?.message ?? String(error) }
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', onDispose)
    }
    if (this.disposed || gen !== this.generation) return { kind: 'aborted' }
    return { kind: 'ok', text, finishReason, outputTokens }
  }

  /**
   * 构造模型输入：重放有界持续会话（入窗时已按 ADVISOR_CONVERSATION_MAX_CHARS 修剪）+ 本轮增量段。
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