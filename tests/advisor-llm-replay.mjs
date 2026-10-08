#!/usr/bin/env node
/**
 * tests/advisor-llm-replay.mjs — advisor LLM **录制 / 回放**设施（S0 判据 12）。
 *
 *   node tests/advisor-llm-replay.mjs                 # 自证：录制 → 冻结落盘 → 重新载入 → 回放逐块等价
 *   node tests/advisor-llm-replay.mjs --out <file>    # 指定录制件落点（缺省 agent-out/v3-fixtures/llm-replay/selftest.json）
 *
 * ## 与既有 stub（`tests/advisor.test.mjs:94` 的 `fakeLlm(script)`）的关系（判据 12 ③）
 *
 * | 设施 | 回答什么问题 | 用在哪条轨 |
 * |---|---|---|
 * | **stub** `fakeLlm(script)` | 调用方**手写**分片脚本 → 断言「解析 → 终态 → 投递链」 | **确定性轨**（S5 判据 5 的确定性轨 / 现有全部状态机用例） |
 * | **本设施**（录制 + 回放） | 真实 provider **跑一次** → 冻结为 fixture → 离线逐块重放 | **语义轨**（AC-40 的「结论前置」句序、AC-64 的 Prevention Rate 采集） |
 *
 * 两者**不可互相替代**：stub 的正文是测试作者写的，所以它证明不了「真实模型会不会真的先说结论」；
 * 回放件的正文是模型写的，但它不能凭空造「协议边界 ⇄ 状态机」的组合（那是 stub 的活）。
 *
 * ## 边界（如实声明，不得含糊）
 *
 * - **回放不触网**：fixture 是唯一输入；请求 key 未命中时 **fail-closed 抛错**
 *   （`error.code === 'ADVISOR_REPLAY_MISS'`），绝不静默返回空流冒充「模型没说话」。
 * - **fixture 不含请求正文**：只存 `key`（sha256 单向）+ 形状（`provider / model /
 *   maxTokens / systemChars / messageCount`）。与 `lib/advisor/runtime.js:570-572`
 *   的 trace 隐私纪律同源——正文采样等于把主会话内容复制一份出去。
 * - **录制端是透明 passthrough**：录制不改变流向调用方的分片（不裁剪、不重排），
 *   因此「录制一轮」等价于「真跑一轮」，不会因为开了录制而改变产品行为。
 * - **B0 只做设施 + 自证**：本步无网络、无 provider 凭据，故自证里的 `inner` 是
 *   「provider 形态假体」（按真实分片协议发 text-delta / usage(预估→最终) / finish）。
 *   真实 provider 适配器一注入 `createRecordingLlm({ inner })` 即成录制件。
 * - **加载期零副作用**（S0 判据 11）：本模块顶层只有声明与常量；任何写盘都在函数体内。
 *
 * @module tests/advisor-llm-replay.mjs
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { classifyCompletion } from '../lib/advisor/runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

/** 录制件版本：结构变了必须升版本（旧件会 fail-closed 拒绝载入，不静默按新结构解释）。 */
export const FIXTURE_VERSION = 1

/** 回放未命中请求 key 的错误码（fail-closed 的可断言标记）。 */
export const REPLAY_MISS_CODE = 'ADVISOR_REPLAY_MISS'

/** strict 模式下「有录制流没被请求」的错误码。 */
export const REPLAY_LEFTOVER_CODE = 'ADVISOR_REPLAY_UNCONSUMED'

/** 缺省录制件落点（`agent-out/` 是 gitignored 的过程物区，不得入库）。 */
export const DEFAULT_FIXTURE_PATH = join(REPO_ROOT, 'agent-out', 'v3-fixtures', 'llm-replay', 'selftest.json')

/** 稳定序列化：对象键排序 ⇒ 同一请求恒得同一个 key（与属性书写顺序无关）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 请求 key：`provider/model/maxTokens/system/messages` 的 sha256（单向）。
 *
 * ⚠️ 入参含消息正文，但**返回值是单向摘要**——fixture 里只落这个摘要，不落正文。
 *
 * @param {object} request `llm.stream()` 的选项
 * @returns {string} `sha256:<hex>`
 */
export function hashRequest(request = {}) {
  const shape = {
    provider: request.provider ?? null,
    model: request.model ?? null,
    maxTokens: request.maxTokens ?? null,
    system: typeof request.system === 'string' ? request.system : '',
    messages: Array.isArray(request.messages) ? request.messages : [],
  }
  return `sha256:${createHash('sha256').update(canonical(shape)).digest('hex')}`
}

/** 请求的**可入库形状**（不含正文）：provider / model / maxTokens / systemChars / messageCount。 */
export function requestShape(request = {}) {
  return {
    provider: request.provider ?? null,
    model: request.model ?? null,
    maxTokens: request.maxTokens ?? null,
    systemChars: typeof request.system === 'string' ? request.system.length : 0,
    messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
  }
}

/** 空 fixture 骨架。 */
export function emptyFixture(source = {}) {
  return { version: FIXTURE_VERSION, recordedAt: null, source, entries: [] }
}

/**
 * 录制包装器：透明 passthrough + 逐块冻结。
 *
 * 冻结口径与产品一致：`finishReason` / `outputTokens` 取 **last-wins**（与
 * `lib/advisor/runtime.js:586-589` 同语义——provider 常先发偏小的预估 usage）。
 *
 * @param {{inner:{stream:Function}, fixture?:object}} options
 * @returns {{calls:object[], fixture:()=>object, stream:Function}}
 */
export function createRecordingLlm({ inner, fixture = emptyFixture() } = {}) {
  if (inner === null || typeof inner?.stream !== 'function') {
    throw new Error('createRecordingLlm 需要一个实现 stream() 的内层 llm（真实 provider 适配器）')
  }
  if (!Array.isArray(fixture.entries)) throw new Error('createRecordingLlm 的 fixture.entries 必须是数组')
  const calls = []
  const entries = fixture.entries
  return {
    calls,
    /** 冻结后的 fixture 快照（深拷贝，避免调用方后续改动污染已冻结件）。 */
    fixture: () => JSON.parse(JSON.stringify({ ...fixture, entries })),
    stream(options = {}) {
      calls.push(options)
      const entry = {
        index: entries.length,
        key: hashRequest(options),
        request: requestShape(options),
        chunks: [],
        finishReason: null,
        outputTokens: null,
        text: '',
      }
      entries.push(entry)
      const source = inner.stream(options)
      return (async function* () {
        for await (const chunk of source) {
          // 可 JSON 往返校验：不可序列化的分片（Date/Map/函数）必须**抛错**而不是静默丢字段，
          // 否则录制件会与真实流悄悄不等价。
          const frozen = chunk === undefined ? null : JSON.parse(JSON.stringify(chunk))
          entry.chunks.push(frozen)
          if (frozen?.type === 'text-delta' && typeof frozen.text === 'string') entry.text += frozen.text
          if (frozen?.type === 'finish' && typeof frozen.reason === 'string') entry.finishReason = frozen.reason
          if (frozen?.type === 'usage' && Number.isFinite(frozen?.usage?.outputTokens)) {
            entry.outputTokens = Number(frozen.usage.outputTokens)
          }
          yield chunk // ← 透明：调用方拿到的仍是内层原分片
        }
      })()
    },
  }
}

/**
 * 回放 llm：按 fixture 逐块 yield，**不触网**。
 *
 * @param {{fixture:object, strict?:boolean}} options
 * @returns {{calls:object[], leftover:()=>number, assertAllConsumed:()=>number, stream:Function}}
 */
export function createReplayLlm({ fixture, strict = true } = {}) {
  if (!Array.isArray(fixture?.entries)) throw new Error('createReplayLlm 需要一个含 entries 数组的 fixture')
  const pending = new Map()
  for (const entry of fixture.entries) {
    const queue = pending.get(entry.key) ?? []
    queue.push(entry)
    pending.set(entry.key, queue)
  }
  const calls = []
  const leftover = () => [...pending.values()].reduce((n, q) => n + q.length, 0)
  return {
    calls,
    leftover,
    /** strict 模式下有未消费录制流即抛错（防止「回放件被静默忽略一半」）。 */
    assertAllConsumed() {
      const remaining = leftover()
      if (strict && remaining > 0) {
        const error = new Error(`回放有 ${remaining} 条录制分片流未被请求（strict 模式视为故障）`)
        error.code = REPLAY_LEFTOVER_CODE
        throw error
      }
      return remaining
    },
    stream(options = {}) {
      calls.push(options)
      const key = hashRequest(options)
      const queue = pending.get(key)
      if (queue === undefined || queue.length === 0) {
        const error = new Error(`回放未命中：请求 key ${key} 不在 fixture 里（fail-closed，绝不返回空流）`)
        error.code = REPLAY_MISS_CODE
        throw error
      }
      const entry = queue.shift()
      return (async function* () {
        for (const chunk of entry.chunks) yield JSON.parse(JSON.stringify(chunk))
      })()
    },
  }
}

/** 落盘（父目录按需创建；`agent-out/` 为 gitignored 过程物区）。 */
export function saveFixture(path, fixture) {
  const out = {
    ...fixture,
    version: FIXTURE_VERSION,
    recordedAt: fixture.recordedAt ?? new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)
  return path
}

/** 载入（版本不符 / 结构损坏一律抛错，不静默按残缺内容继续）。 */
export function loadFixture(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed?.version !== FIXTURE_VERSION) {
    throw new Error(`fixture 版本不匹配：实得 ${parsed?.version}，期望 ${FIXTURE_VERSION}`)
  }
  if (!Array.isArray(parsed.entries)) throw new Error('fixture 损坏：entries 必须是数组')
  return parsed
}

/** 把一次流完整读成 `{chunks, text, finishReason, outputTokens}`（与运行时同口径）。 */
export async function drain(stream) {
  const chunks = []
  let text = ''
  let finishReason = null
  let outputTokens = null
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk?.type === 'text-delta') text += chunk.text
    if (chunk?.type === 'finish' && typeof chunk.reason === 'string') finishReason = chunk.reason
    if (chunk?.type === 'usage' && Number.isFinite(chunk?.usage?.outputTokens)) outputTokens = Number(chunk.usage.outputTokens)
  }
  return { chunks, text, finishReason, outputTokens }
}

// ---------------------------------------------------------------------------
// 自证（node tests/advisor-llm-replay.mjs）
// ---------------------------------------------------------------------------

/**
 * 「provider 形态假体」：按真实分片协议发流（text-delta 分片 + 预估 usage → 最终 usage + finish）。
 *
 * B0 无网络/无 provider 凭据，故自证的内层用假体；**接口形态与真实适配器完全一致**
 * （`stream(options) → AsyncIterable<chunk>`），真实适配器可原样替换。
 */
export function providerShapedStub(payload) {
  const text = typeof payload === 'string' ? payload : '{"notes":[]}'
  const head = text.slice(0, Math.max(1, Math.floor(text.length / 2)))
  const tail = text.slice(head.length)
  return {
    stream: () => (async function* () {
      yield { type: 'text-delta', text: head }
      yield { type: 'text-delta', text: tail }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 12 } } // 预估（偏小）
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 137 } } // 最终（last-wins）
      yield { type: 'finish', reason: 'stop' }
    })(),
  }
}

/**
 * 自证主流程：录制 → 冻结落盘 → **重新从磁盘载入** → 回放 → 逐块/终态等价 + fail-closed 两侧。
 *
 * @param {{outPath?:string, log?:(line:string)=>void}} [options]
 * @returns {Promise<number>} 0=全绿；1=有断言失败
 */
export async function runSelftest(options = {}) {
  const outPath = options.outPath ?? DEFAULT_FIXTURE_PATH
  const log = options.log ?? ((line) => console.log(line))
  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: ok === true, detail })
    return ok === true
  }

  const request = {
    provider: 'prov-selftest',
    model: 'model-selftest',
    maxTokens: 16384,
    system: '你是只读评审（合成值）',
    messages: [{ role: 'user', content: [{ type: 'text', text: '合成输入：请评审这段改动' }] }],
  }
  const payload = '{"notes":[{"severity":"concern","text":"先不要重写整个模块","file":"lib/x.js","line":12}]}'

  // ① 录制：透明 passthrough（调用方分片 == 内层分片）
  const recorder = createRecordingLlm({ inner: providerShapedStub(payload) })
  const recorded = await drain(recorder.stream(request))
  const passthroughOk = recorded.chunks.length === 5
  check('① 录制端透明 passthrough：调用方拿到 5 个原分片（text-delta×2 + usage×2 + finish）', passthroughOk, `实得 ${recorded.chunks.length}`)

  const fixture = recorder.fixture()
  check('② 冻结件含 finishReason / outputTokens / 分块文本（判据 12 ①）',
    fixture.entries.length === 1
    && fixture.entries[0].finishReason === 'stop'
    && fixture.entries[0].outputTokens === 137
    && fixture.entries[0].text === payload
    && fixture.entries[0].chunks.length === 5,
    `entries=${fixture.entries.length} finish=${fixture.entries[0]?.finishReason} tokens=${fixture.entries[0]?.outputTokens}`)
  check('②b 冻结件不含请求正文（隐私：只有 key + 形状）',
    typeof fixture.entries[0].key === 'string'
    && fixture.entries[0].key.startsWith('sha256:')
    && !JSON.stringify(fixture.entries[0]).includes('合成输入'),
    `request=${JSON.stringify(fixture.entries[0].request)} keys=${Object.keys(fixture.entries[0].request).join(',')}`)

  // ② 落盘 + **重新载入**（证明「离线可复现」不是内存假象）
  saveFixture(outPath, fixture)
  const reloaded = loadFixture(outPath)

  // ③ 回放：逐块等价 + 终态等价（用产品**真实**的 classifyCompletion 判定）
  const replay = createReplayLlm({ fixture: reloaded })
  const replayed = await drain(replay.stream(request))
  check('③ 回放不触网且逐块等价（chunks 深比较）',
    JSON.stringify(replayed.chunks) === JSON.stringify(fixture.entries[0].chunks),
    `replay=${replayed.chunks.length} 块 / recorded=${fixture.entries[0].chunks.length} 块`)
  check('③b 回放终态等价：text / finishReason / outputTokens 与录制件一致',
    replayed.text === fixture.entries[0].text
    && replayed.finishReason === fixture.entries[0].finishReason
    && replayed.outputTokens === fixture.entries[0].outputTokens,
    `text=${replayed.text.length}字符 finish=${replayed.finishReason} tokens=${replayed.outputTokens}`)

  const originalVerdict = classifyCompletion({ text: recorded.text, finishReason: recorded.finishReason, outputTokens: recorded.outputTokens, maxTokens: 16384 })
  const replayVerdict = classifyCompletion({ text: replayed.text, finishReason: replayed.finishReason, outputTokens: replayed.outputTokens, maxTokens: 16384 })
  check('③c 产品真实终态判定器对「原流 / 回放流」给出同一 outcome（语义轨可直接复用）',
    originalVerdict.outcome === replayVerdict.outcome && replayVerdict.outcome === 'ok',
    `original=${originalVerdict.outcome} replay=${replayVerdict.outcome}`)

  check('③d strict 模式：录制流全部被请求后 leftover=0', replay.assertAllConsumed() === 0, `leftover=${replay.leftover()}`)

  // ④ fail-closed 两侧（注入必红纪律：负向必须真的抛错，不许静默空流）
  let missError = null
  try { await drain(replay.stream({ ...request, model: 'model-not-recorded' })) } catch (error) { missError = error }
  check('④ 未命中的请求 key 必须抛 ADVISOR_REPLAY_MISS（绝不静默空流）',
    missError?.code === REPLAY_MISS_CODE, `error=${missError?.code ?? '未抛错'}`)

  const partial = createReplayLlm({ fixture: reloaded })
  check('④b strict 模式：有录制流没被请求时抛 ADVISOR_REPLAY_UNCONSUMED',
    (() => { try { partial.assertAllConsumed(); return false } catch (error) { return error?.code === REPLAY_LEFTOVER_CODE } })(),
    `leftover=${partial.leftover()}`)

  const failed = checks.filter((c) => !c.ok)
  log('== dsh-agents advisor-llm-replay ==')
  log(`[facts] fixture 落点：${outPath}（agent-out/ 为 gitignored 过程物区，不入库）`)
  log(`[facts] 录制条目：${reloaded.entries.length} 条；版本 v${reloaded.version}；recordedAt=${reloaded.recordedAt}`)
  for (const c of checks) log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail === '' ? '' : `（${c.detail}）`}`)
  log(`[RESULT] ${failed.length === 0 ? `PASS — 录制/回放闭环 ${checks.length}/${checks.length}` : `FAIL — ${failed.length} 项`}`)
  return failed.length === 0 ? 0 : 1
}

/** 判定「本文件是否为进程入口」（被 import 时零副作用 —— S0 判据 11）。 */
function isEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string') return false
  try { return pathToFileURL(entry).href === import.meta.url } catch { return false }
}

if (isEntry()) {
  const argv = process.argv.slice(2)
  const outAt = argv.indexOf('--out')
  const outPath = outAt >= 0 ? argv[outAt + 1] : undefined
  runSelftest({ outPath }).then((code) => { process.exitCode = code })
}
