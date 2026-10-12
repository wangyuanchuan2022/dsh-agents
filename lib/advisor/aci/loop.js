/**
 * aci/loop.js —— advisor 的 agentic tool-call 循环（S3 / 计划 §2 S3，V3 最大新建面）。
 *
 * ## 跨轮语义（契约级，逐条对应计划判据）
 *
 * 1. **循环内 N 次往返 = 同一次评审**：identity 仍是 `(sessionId, turn)`，本模块
 *    不触碰 `observer.js` 的幂等门（高风险区，禁碰）；
 * 2. **轮上限**：`maxRounds`（配置键 `advisorMaxToolRounds`，缺省 4；0 = 关闭循环
 *    走单次调用）——轮次用尽而模型仍要工具 ⇒ 整次评审 dropped（不假装看过）；
 * 3. **预算 chokepoint（唯一）**：工具结果进入上下文前**必须**先过
 *    {@link BudgetPool.reserve}——本文件是全仓**唯一**的预算放行点（源码级 grep
 *    门：`.reserve(` 只出现在本文件）；预取面与模型工具面**共享同一 40KB 检索段池**
 *    （调用方把 S2 预取的已记账字节传进 `alreadyUsedBytes`），循环内逐轮记账；
 * 4. **触顶跨轮不变量**：**任一**往返 `outputTokens ≥ maxTokens` 或
 *    `finishReason === 'max-tokens'` ⇒ 整次评审 dropped（不是只看最后一轮——
 *    「第 1 轮触顶 + 第 4 轮正常」按旧行为会投递被截断的结论，本不变量堵死它）；
 * 5. **循环期失败缺省语义**：中途失败（环境类工具失败 / 流异常 / 预算耗尽 /
 *    墙钟超限 / 轮次用尽仍要工具）= 显式 `kind:'dropped'` + 调用方落 `records`
 *    一条（与触顶同形，outcome:'dropped'），**不得只留 runtime.status**；
 * 6. **墙钟上限（P1-8）**：`reviewTimeoutMs`（缺省 = `maxRounds × callTimeoutMs`）
 *    到点即整体中止——单轮超时之外的第二道预算维度；
 * 7. **不进持续会话历史**：本循环只操作**本次调用局部**的消息数组，绝不写
 *    `AdvisorConversation`（唯一入历史点仍是 runtime 的 `appendUser(增量)`）。
 *
 * @module dsh-agents/advisor/aci/loop
 */

import { measureInjection, RETRIEVAL_TOTAL_BYTES, RETRIEVAL_CALL_BYTES, budgetExhaustedCarrier } from '../retrieval/budget.js'
import { aciToolSchemas, aciToolByName, formatBadArguments, AciEnvironmentError } from './tools.js'
import { ADVISOR_MAX_TOKENS } from '../runtime.js'

/**
 * 检索段预算池（**唯一放行点**）。
 *
 * `reserve(n)` 是全仓唯一的预算写侧闸门：工具结果（以及调用方声明的预取面
 * 已用量）都从这里过账。超限拒绝，绝不静默放行。
 */
export class BudgetPool {
  constructor(options = {}) {
    this.limitBytes = Number.isFinite(options.limitBytes) && options.limitBytes > 0
      ? Math.trunc(options.limitBytes) : RETRIEVAL_TOTAL_BYTES
    this.perCallBytes = Number.isFinite(options.perCallBytes) && options.perCallBytes > 0
      ? Math.trunc(options.perCallBytes) : RETRIEVAL_CALL_BYTES
    this.usedBytes = Number.isFinite(options.alreadyUsedBytes) && options.alreadyUsedBytes > 0
      ? Math.trunc(options.alreadyUsedBytes) : 0
    /** 逐轮记账（可枚举，AC-13 ②③④ 与 AC-45 的取证面）。 */
    this.calls = []
  }

  get remaining() {
    return Math.max(0, this.limitBytes - this.usedBytes)
  }

  /**
   * 唯一放行点：记账 n 字节。超限返回 `{ok:false}`（调用方必须显式处置）。
   * @param {number} n - 要入上下文的字节数（UTF-8，由 measureInjection 量出）
   * @param {{label?:string}} [options]
   */
  reserve(n, options = {}) {
    const bytes = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
    const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'retrieval'
    const overBytes = Math.max(0, this.usedBytes + bytes - this.limitBytes)
    const row = { label, bytes, usedBytes: this.usedBytes, allowedBytes: bytes - Math.min(overBytes, bytes), over: overBytes > 0 }
    this.calls.push(row)
    if (overBytes > 0) {
      return { ok: false, overBytes, usedBytes: this.usedBytes, limitBytes: this.limitBytes, label }
    }
    this.usedBytes += bytes
    return { ok: true, usedBytes: this.usedBytes, remaining: this.remaining, limitBytes: this.limitBytes, label }
  }
}

/** 把一段文本按预算上限裁到能放下的字节数（裁剪必带显式标记——不存在零痕迹截断）。 */
function trimToBudget(text, budgetBytes) {
  if (budgetBytes <= 0) return { text: '', trimmed: text.length > 0, droppedBytes: measureInjection(text).bytes }
  const { bytes } = measureInjection(text)
  if (bytes <= budgetBytes) return { text, trimmed: false, droppedBytes: 0 }
  // 二分找最长可保留前缀（按字节），尾加显式裁剪标记。
  let lo = 0
  let hi = text.length
  const marker = '…[预算裁剪：超出检索段池上限，剩余内容未注入]'
  const markerBytes = measureInjection(marker).bytes
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureInjection(text.slice(0, mid)).bytes + markerBytes <= budgetBytes) lo = mid
    else hi = mid - 1
  }
  return { text: `${text.slice(0, lo)}${marker}`, trimmed: true, droppedBytes: bytes - measureInjection(text.slice(0, lo)).bytes }
}

/**
 * 跑一次 agentic tool-call 评审循环。
 *
 * @param {object} input
 * @param {object} input.llm - llm 服务（stream({provider,model,system,messages,maxTokens,signal,tools})）
 * @param {string} input.provider
 * @param {string} input.model
 * @param {string} input.systemPrompt
 * @param {Array<object>} input.messages - 首轮消息（runtime buildMessages 的产物）
 * @param {Array<object>} input.tools - ACI 工具集（createAciTools 产物）
 * @param {number} [input.maxRounds=4] - 往返上限（`advisorMaxToolRounds`）
 * @param {number} [input.maxTokens] - 单次调用输出上限（ADVISOR_MAX_TOKENS）
 * @param {number} [input.callTimeoutMs=90000] - 单轮超时
 * @param {number} [input.reviewTimeoutMs] - 整次评审墙钟（缺省 = maxRounds × callTimeoutMs）
 * @param {number} [input.alreadyUsedBytes=0] - 预取面已记账字节（共享 40KB 池）
 * @param {AbortSignal} [input.signal] - dispose 信号
 * @param {Function} [input.trace] - 取证发射（fail-open）
 * @param {{sessionId?:string, sessionName?:string|null}} [input.meta] - records 载体用
 * @returns {Promise<
 *   {kind:'ok', text:string, finishReason:string|null, outputTokens:number|null, rounds:number,
 *    budget:BudgetPool, bundle:{files:string[],queries:string[]}, toolCalls:Array<{round:number,name:string}>}
 *   |{kind:'dropped', reason:string, detail:string, budget:BudgetPool}
 *   |{kind:'failure', message:string}
 *   |{kind:'aborted'}>}
 */
export async function runToolLoop(input = {}) {
  const llm = input.llm
  const maxRounds = Number.isInteger(input.maxRounds) && input.maxRounds > 0 ? input.maxRounds : 4
  const maxTokens = Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? input.maxTokens : ADVISOR_MAX_TOKENS
  const callTimeoutMs = Number.isFinite(input.callTimeoutMs) && input.callTimeoutMs > 0 ? input.callTimeoutMs : 90_000
  const reviewTimeoutMs = Number.isFinite(input.reviewTimeoutMs) && input.reviewTimeoutMs > 0
    ? input.reviewTimeoutMs : maxRounds * callTimeoutMs
  const tools = Array.isArray(input.tools) ? input.tools : []
  const trace = typeof input.trace === 'function' ? input.trace : () => {}
  const meta = input.meta ?? {}
  const pool = new BudgetPool({ alreadyUsedBytes: input.alreadyUsedBytes })
  const bundleFiles = new Set()
  const bundleQueries = new Set()
  const toolCallLog = []

  // 整次评审墙钟（P1-8）：一条硬 deadline 罩住全部往返。
  const reviewClock = new AbortController()
  const wallTimer = setTimeout(() => reviewClock.abort('advisor review wall clock'), reviewTimeoutMs)
  const onOuterAbort = () => reviewClock.abort('advisor disposed')
  if (input.signal?.aborted) reviewClock.abort('advisor disposed')
  else input.signal?.addEventListener('abort', onOuterAbort, { once: true })

  /** 消费一轮流，聚合文本 / 工具调用块 / finish / usage（last-wins，同 runtime 口径）。 */
  async function consumeRound(messages, signal) {
    let text = ''
    let finishReason = null
    let outputTokens = null
    const toolBlocks = []
    // 与 runtime.callModel 同形的取证锚（取证哨兵用例按 call-start 定位每轮调用）。
    trace({ phase: 'call-start', provider: input.provider, model: input.model, maxTokens, messageCount: messages.length, toolRound: true })
    const stream = llm.stream({
      provider: input.provider,
      model: input.model,
      system: input.systemPrompt,
      messages,
      maxTokens,
      signal,
      // 宿主 llm.stream 的 tools 通道（实测支持：GenerateOptions.tools +
      // dsh-llm/lib/index.js:2312 透传）。工具面只声明只读 ACI 白名单。
      tools: aciToolSchemas(tools),
    })
    const iterator = stream[Symbol.asyncIterator]()
    for (;;) {
      const next = await raceNext(iterator, signal)
      if (next === 'aborted') {
        iterator.return?.().catch(() => {})
        return { aborted: true }
      }
      if (next.done) break
      const chunk = next.value
      // 与 runtime.callModel 同形的逐分片取证（只记长度，不采样正文——R6 纪律）。
      trace({
        phase: 'chunk',
        type: chunk?.type ?? null,
        index: chunk?.index ?? null,
        text: typeof chunk?.text === 'string' ? chunk.text.length : null,
        name: chunk?.block?.name ?? chunk?.name ?? null,
        reason: chunk?.reason ?? null,
        usage: chunk?.usage ?? null,
      })
      if (chunk?.type === 'text-delta') text += chunk.text
      if (chunk?.type === 'block-end' && chunk?.block?.type === 'tool-call') toolBlocks.push(chunk.block)
      if (chunk?.type === 'finish' && typeof chunk.reason === 'string') finishReason = chunk.reason
      if (chunk?.type === 'usage' && Number.isFinite(chunk?.usage?.outputTokens)) outputTokens = Number(chunk.usage.outputTokens)
    }
    trace({ phase: 'call-end', textLength: text.length, toolRound: true })
    return { aborted: false, text, finishReason, outputTokens, toolBlocks }
  }

  try {
    let messages = [...(Array.isArray(input.messages) ? input.messages : [])]
    let rounds = 0
    while (rounds < maxRounds) {
      rounds += 1
      // 单轮超时：每轮独立 AbortController，与墙钟任一触发即中止。
      const roundClock = new AbortController()
      const onWall = () => roundClock.abort(reviewClock.signal.reason)
      reviewClock.signal.addEventListener('abort', onWall, { once: true })
      const roundTimer = setTimeout(() => roundClock.abort('advisor call timeout'), callTimeoutMs)
      trace({ phase: 'tool-round-start', round: rounds, maxRounds, messageCount: messages.length })
      let round
      try {
        round = await consumeRound(messages, roundClock.signal)
      } finally {
        clearTimeout(roundTimer)
        reviewClock.signal.removeEventListener('abort', onWall)
      }
      if (round.aborted) {
        if (reviewClock.signal.aborted && input.signal?.aborted !== true) {
          const detail = `整次评审墙钟超限（${reviewTimeoutMs}ms，第 ${rounds} 轮中止，未投递）`
          trace({ phase: 'tool-loop-wallclock', detail })
          return { kind: 'dropped', reason: 'review-wall-clock', detail, budget: pool }
        }
        return { kind: 'aborted' }
      }
      trace({ phase: 'tool-round-end', round: rounds, textLength: round.text.length, finishReason: round.finishReason, outputTokens: round.outputTokens, toolCalls: round.toolBlocks.length })

      // ── 触顶跨轮不变量：任一往返触顶 ⇒ 整次评审 dropped（不是只看最后一轮）──
      const hitCap = (round.outputTokens !== null && round.outputTokens >= maxTokens) || round.finishReason === 'max-tokens'
      if (hitCap) {
        const detail = `第 ${rounds} 轮触顶（finishReason=${round.finishReason ?? '无'}，outputTokens=${round.outputTokens ?? '无'}/${maxTokens}）⇒ 整次评审 dropped（未投递）`
        trace({ phase: 'tool-loop-cap', round: rounds, detail })
        return { kind: 'dropped', reason: 'output-cap', detail, budget: pool }
      }

      if (round.finishReason === 'tool-calls' || round.toolBlocks.length > 0) {
        if (round.toolBlocks.length === 0) {
          const detail = `第 ${rounds} 轮 finishReason=tool-calls 但未捕获任何工具调用块（协议异常，未投递）`
          trace({ phase: 'tool-loop-protocol', round: rounds, detail })
          return { kind: 'dropped', reason: 'tool-calls-without-blocks', detail, budget: pool }
        }
        if (rounds >= maxRounds) {
          const detail = `工具往返已达上限（${maxRounds} 轮）而模型仍请求工具——不假装看过，整次评审 dropped（未投递）`
          trace({ phase: 'tool-loop-rounds-exhausted', detail })
          return { kind: 'dropped', reason: 'tool-rounds-exhausted', detail, budget: pool }
        }
        // 回放 assistant 工具调用块 + 逐个执行 + 以 role:'tool' 结果回填（局部消息，不进持续会话历史）。
        messages = [...messages, {
          role: 'assistant',
          id: crypto.randomUUID(),
          content: round.toolBlocks.map((b) => ({ type: 'tool-call', id: b.id, name: b.name, arguments: b.arguments })),
          source: { kind: 'model' },
        }]
        for (const block of round.toolBlocks) {
          toolCallLog.push({ round: rounds, name: block.name })
          const result = await executeToolCall({ block, tools, pool })
          // 环境类/意外异常 ⇒ 循环级失败（调用方落 dropped 记录，判据 12 同形）。
          if (result.kind === 'failure') return { kind: 'failure', message: result.message }
          for (const f of result.files ?? []) bundleFiles.add(f)
          for (const q of result.queries ?? []) bundleQueries.add(q)
          messages = [...messages, {
            role: 'tool',
            id: crypto.randomUUID(),
            toolCallId: block.id,
            content: [{ type: 'text', text: result.text }],
            source: { kind: 'tool', callId: block.id },
            ...(result.isError === true ? { isError: true } : {}),
          }]
          if (result.dropped !== undefined) {
            trace({ phase: 'tool-loop-dropped', round: rounds, detail: result.dropped.detail })
            return { kind: 'dropped', ...result.dropped, budget: pool }
          }
        }
        continue
      }

      // 终态（stop / null）：正文即评审输出，交 runtime 的 classify/parse 链。
      return {
        kind: 'ok',
        text: round.text,
        finishReason: round.finishReason,
        outputTokens: round.outputTokens,
        rounds,
        budget: pool,
        bundle: { files: [...bundleFiles], queries: [...bundleQueries] },
        toolCalls: toolCallLog,
      }
    }
    // 防御性出口（while 条件已含 rounds < maxRounds，理论不可达）：
    const detail = `工具往返耗尽（${maxRounds} 轮）且无终态——fail-closed，整次评审 dropped（未投递）`
    return { kind: 'dropped', reason: 'tool-rounds-exhausted', detail, budget: pool }
  } catch (error) {
    return { kind: 'failure', message: error?.message ?? String(error) }
  } finally {
    clearTimeout(wallTimer)
    input.signal?.removeEventListener('abort', onOuterAbort)
  }

  /** 执行单个工具调用：预算池过账 + 显式观察 + 失败语义二分（参数类 vs 环境类）。 */
  async function executeToolCall({ block, tools: set, pool: budget }) {
    const name = typeof block.name === 'string' ? block.name : ''
    const tool = aciToolByName(set, name)
    if (tool === null) {
      return { text: `（工具调用被拒绝：code=unknown-tool；未登记的工具名 ${name || '(空)'}）`, isError: true, files: [] }
    }
    let args = {}
    const raw = typeof block.arguments === 'string' ? block.arguments : ''
    if (raw.trim() !== '') {
      try {
        args = JSON.parse(raw)
      } catch {
        return { text: formatBadArguments('arguments 不是合法 JSON'), isError: true, files: [] }
      }
    }
    let out
    try {
      out = await tool.execute(args)
    } catch (error) {
      if (error instanceof AciEnvironmentError) {
        // 环境类失败（git 不可用等）⇒ 循环级 dropped（判据 12 的同形处置）。
        const carrier = budgetExhaustedCarrier({
          sessionId: meta.sessionId, sessionName: meta.sessionName ?? null,
          label: `tool:${name}`, reason: `环境类失败：${error.message}`,
        })
        return {
          text: `（工具调用失败：code=${error.code}；${error.message}）`,
          isError: true, files: [],
          dropped: { reason: 'tool-environment', detail: `工具 ${name} 环境类失败（${error.code}）：${error.message} ⇒ 整次评审 dropped（未投递）`, carrier },
        }
      }
      return { kind: 'failure', message: error?.message ?? String(error) }
    }
    // ── 预算 chokepoint（唯一放行点）：工具结果必须先 reserve 再进上下文 ──
    if (budget.remaining <= 0 && measureInjection(out.text).bytes > 0) {
      return budgetDropped(name, `tool:${name}`)
    }
    const perCallCap = Math.min(budget.perCallBytes, budget.remaining)
    const fit = trimToBudget(out.text, perCallCap)
    const view = fit.trimmed
      ? { text: fit.text === '' ? `（工具结果未注入：检索段池剩余 ${budget.remaining} 字节，不足以承载任何内容）` : fit.text }
      : { text: out.text }
    const finalBytes = measureInjection(view.text).bytes
    const verdict = budget.reserve(finalBytes, { label: `tool:${name}` })
    if (!verdict.ok) {
      return budgetDropped(name, `tool:${name}`)
    }
    return { text: view.text, isError: out.isError === true, files: out.files ?? [], queries: out.queries ?? [] }

    /** 预算耗尽的统一 dropped 载体（调用方落 records 一条，与触顶同形）。 */
    function budgetDropped(toolName, label) {
      const carrier = budgetExhaustedCarrier({
        sessionId: meta.sessionId, sessionName: meta.sessionName ?? null,
        label, usedBytes: budget.usedBytes, limitBytes: budget.limitBytes,
        reason: '检索段池（预取面 + 工具面共享 40KB）耗尽',
      })
      return {
        text: `（工具结果未注入：检索段池耗尽 ${budget.usedBytes}/${budget.limitBytes} 字节）`,
        isError: true, files: [],
        dropped: { reason: 'budget-exhausted', detail: `检索段预算耗尽（工具 ${toolName}，${budget.usedBytes}/${budget.limitBytes} 字节）⇒ 整次评审 dropped（未投递）`, carrier },
      }
    }
  }
}

/** 一次性取迭代器下一个值并与信号竞争（与 runtime.raceNext 同构）。 */
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
