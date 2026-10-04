/**
 * advisor 服务端测试（桩宿主：fake ctx / fake session / fake agent / fake llm）。
 *
 * 覆盖四层：
 *  1. **配置校验**（resolveAdvisorConfig）+ **会话级模型来源**（resolveAdvisorModel）：
 *     只有 'session'（该会话手动指定）与 'unset'（未指定、**无任何兜底**）两态；
 *  2. **观察器**（observer）：两种触发模式 + 模式闩锁 + 增量游标 + 重写检测
 *     + 有界窗口 + advisor 消息自评审排除；
 *  3. **运行时**（runtime）：严格 JSON 输出契约（解析失败 → status=error +
 *     落记录 + 不投递）、队列上限 drop-newest、持续会话累积、投递四态记录；
 *  4. **端点**（api + store）：GET/PATCH/POST 形状、回环 + Origin 双重防护、
 *     非法形状 400、记录保留上限与倒序。
 *
 * 全部用内存桩，不依赖真实 DSH 宿主；数据目录写 tests/.tmp-advisor/。
 *
 * @module tests/advisor.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  resolveAdvisorConfig, resolveAdvisorModel, installAdvisor, ADVISOR_ENDPOINT,
  resolveAdvisorDataDir, DEFAULT_ADVISOR_DATA_DIR, ADVISOR_DATA_DIR_ENV, ADVISOR_TRACE_ENV,
} from '../lib/advisor/index.js'
import { AdvisorObserver, isRewriteEvent, isReviewableTurnEnd, isHumanInputEvent, findLastMessageTurnEnd, renderVisibleSurface } from '../lib/advisor/observer.js'
import { AdvisorRuntime, parseReviewOutput, AdvisorConversation } from '../lib/advisor/runtime.js'
import { AdvisorDelivery, buildAdvisorMessage, isAdvisorMessage } from '../lib/advisor/delivery.js'
import { AdvisorStore, normalizeRecord, sessionConfigPath, CONFIG_FILE } from '../lib/advisor/store.js'
import { createAdvisorHandler, normalizeAdvisorPatch, normalizeSessionId, SESSION_ID_MAX } from '../lib/advisor/api.js'

// ── 桩件 ──────────────────────────────────────────────────────────────────

/** 假消息（deriveMessages 投影的元素）。 */
function msg(role, text, extra = {}) {
  return { role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' }, ...extra }
}

/** 假会话（deriveMessages 返回当前数组）。 */
function fakeSession(messages) {
  return { deriveMessages: () => messages }
}

/** 假 agent：记录 steer / inject 调用。 */
function fakeAgent(id) {
  const calls = { steer: [], inject: [] }
  return {
    id,
    calls,
    steer: (m) => calls.steer.push(m),
    inject: (m) => calls.inject.push(m),
    session: fakeSession([]),
  }
}

/** 假 ctx：on / effect / inject / agents.get 全在位。 */
function fakeCtx({ webServer = true } = {}) {
  const handlers = new Map()
  const routes = []
  const ctx = {
    agents: { get: () => undefined },
    on: (event, fn) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn))
    },
    emit: (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) },
    effect: (fn) => { fn() },
    inject: (deps, cb) => {
      if (webServer && deps.includes('webServer')) {
        cb({
          effect: (fn) => { fn() },
          webServer: { register: (route) => { routes.push(route); return () => {} } },
        })
      }
    },
  }
  return { ctx, routes, emit: ctx.emit }
}

/** 假 llm：按脚本返回文本分片。 */
function fakeLlm(script) {
  const calls = []
  return {
    calls,
    stream: (options) => {
      calls.push(options)
      const text = typeof script === 'function' ? script(options, calls.length) : script
      return (async function* () {
        if (typeof text === 'string' && text !== '') yield { type: 'text-delta', text }
        else if (typeof text === 'number') { /* 超时脚本：不产分片，靠 abort 退出 */ }
      })()
    },
  }
}

function tempDir(tag) {
  const dir = join(tmpdir(), `dsh-agents-advisor-${tag}-${process.pid}-${Math.floor(process.randomUUID ? 0 : 0)}${Date.now()}`)
  mkdtempSync(join(tmpdir(), `dsh-adv-${tag}-`))
  return dir
}

// ── 1. 配置校验 + 模型回落链 ─────────────────────────────────────────────

export function testConfig(t) {
  t('配置：缺省值与契约 §1 一致', () => {
    const c = resolveAdvisorConfig({})
    assert.equal(c.advisorEnabled, false)
    assert.equal(c.advisorPanelEnabled, true)
    assert.equal(c.advisorMaxMessages, 60)
    assert.equal(c.advisorMaxQueued, 32)
    assert.equal(c.advisorCallTimeoutMs, 90000)
    assert.equal(c.advisorImmuneTurns, 2)
    assert.deepEqual(c.advisorSteerSeverities, ['nit', 'concern', 'blocker'])
    assert.equal(c.advisorInfoInject, false)
    assert.equal(c.advisorSystemPrompt, '')
    assert.equal(c.advisorPersistLimit, 200)
  })

  t('配置：非法形状大声抛错（未知键 / 负数 / 超长提示词 / 未知等级 / 空 dataDir）', () => {
    assert.throws(() => resolveAdvisorConfig({ advisorFoo: 1 }), /未知 advisor 配置键/)
    assert.doesNotThrow(() => resolveAdvisorConfig({ tiers: {}, clarifyMode: 'interactive' }), '非 advisor 键不得被当成 advisor 配置校验')
    assert.throws(() => resolveAdvisorConfig({ advisorMaxQueued: -1 }), /非负整数/)
    assert.throws(() => resolveAdvisorConfig({ advisorMaxMessages: 1.5 }), /非负整数/)
    assert.throws(() => resolveAdvisorConfig({ advisorSystemPrompt: 'x'.repeat(9 * 1024) }), /上限/)
    assert.throws(() => resolveAdvisorConfig({ advisorSteerSeverities: ['ultra'] }), /未知等级/)
    assert.throws(() => resolveAdvisorConfig({ advisorSteerSeverities: 'nit' }), /必须是数组/)
    assert.throws(() => resolveAdvisorConfig({ advisorDataDir: '' }), /空字符串/)
  })

  // P1-2 必修：advisorProvider/advisorModel 已废弃且**不承载生效语义**，因此
  // 半填/空串/非字符串都必须**放行**——为三个零作用的键让整个插件 boot 失败，
  // 且（抛错发生在告警之前）运维者永远看不到那条「不影响运行时行为」的告警。
  t('P1-2 半填废弃键不 boot 失败：四种手滑写法全部放行，并恰好一条 deprecated 告警', () => {
    const halfFilled = [
      { advisorProvider: 'gp' },
      { advisorModel: 'gm' },
      { advisorProvider: '' },
      { advisorProvider: 0 },
    ]
    for (const raw of halfFilled) {
      const dir = tempDir('p1-2')
      try {
        const messages = []
        const logger = { warn: (m) => messages.push(String(m)), error: (m) => messages.push(String(m)) }
        let booted = true
        let advisor = null
        try {
          advisor = installAdvisor(fakeCtx(), raw, { dataDir: dir, resolveLlm: () => fakeLlm('{"notes":[]}'), logger })
        } catch (error) {
          booted = false
          assert.fail(`${JSON.stringify(raw)} 不得让插件 boot 失败：${error?.message ?? error}`)
        }
        assert.equal(booted, true, `${JSON.stringify(raw)} 必须能装起来`)
        const deprecations = messages.filter((m) => m.includes('已废弃'))
        assert.equal(deprecations.length, 1, `${JSON.stringify(raw)} 必须恰好一条废弃告警（实得 ${deprecations.length}：${JSON.stringify(messages)}）`)
        // 放行不等于生效：半填的废弃键不得成为该会话的模型来源
        const snap = advisor.ctrl.snapshot('s-p12')
        assert.equal(snap.enabled, false, `${JSON.stringify(raw)} 不得凭废弃键开启会话`)
        assert.equal(snap.modelSource, 'unset', `${JSON.stringify(raw)} 不得成为模型兜底`)
        advisor?.dispose()
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
    // 阳性对照：随包默认（= 默认值）不得刷废弃告警，否则每次启动都是噪音
    const dir = tempDir('p1-2b')
    try {
      const messages = []
      const logger = { warn: (m) => messages.push(String(m)), error: (m) => messages.push(String(m)) }
      const advisor = installAdvisor(fakeCtx(), { advisorEnabled: false, advisorProvider: null, advisorModel: null }, { dataDir: dir, logger })
      assert.equal(messages.filter((m) => m.includes('已废弃')).length, 0, '随包默认值不得触发废弃告警')
      advisor.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // S2 重写（原「配置优先 → HIGH 档 → error 三态」）：模型**完全手动指定、
  // 无任何兜底**——没有 HIGH 档回落，也没有全局 config 兜底。
  t('B1 模型来源：只有 session/unset 两态，HIGH 表彻底不被读', () => {
    const configured = resolveAdvisorModel({ provider: 'prov-a', model: 'm-a' })
    assert.deepEqual([configured.provider, configured.model, configured.modelSource], ['prov-a', 'm-a', 'session'])
    // 单给其一（半配置）也判 unset——不猜、不补
    const partial = resolveAdvisorModel({ provider: 'prov-a' })
    assert.equal(partial.modelSource, 'unset')
    assert.equal(partial.provider, null)
    // ★核心判据：传一个「一被调用就抛错」的假 tierTableOf，必须不抛错
    // （证明 HIGH 档路由表根本没被读；旧实现会调用它并把 modelSource 判成 HIGH）
    let tierTouched = false
    const r = resolveAdvisorModel({}, () => { tierTouched = true; throw new Error('HIGH 表被读了') })
    assert.equal(tierTouched, false, 'resolveAdvisorModel 不得再读取任何档位路由表')
    assert.equal(r.modelSource, 'unset')
    assert.deepEqual([r.provider, r.model], [null, null])
    assert.match(String(r.reason), /未指定评审模型/)
  })
}

// ── 1b. 数据目录锚定 + 冒烟隔离（2026-10-03 防复发回归门）─────────────────
// 事故：早先用 join(process.cwd(), '.dsh-agents', 'advisor')，DSH 进程 cwd 是
// C:\Users\ycwan → 数据落到用户主目录；且冒烟测试直写真实目录，遗留 config.json
// 把评审默认打开、把模型指到 MEDIUM 档，制造了「默认值偏离」的假象。
// 回归锁三条：路径锚定、源码级禁 cwd、构造期物理隔离。

export function testDataDir(t) {
  t('dataDir：缺省锚定稳定路径，绝不随宿主进程 cwd 漂移', () => {
    assert.equal(resolveAdvisorDataDir(undefined), DEFAULT_ADVISOR_DATA_DIR)
    assert.equal(resolveAdvisorDataDir(null), DEFAULT_ADVISOR_DATA_DIR)
    assert.equal(resolveAdvisorDataDir('   '), DEFAULT_ADVISOR_DATA_DIR, '空白串等同未配置')
    assert.ok(DEFAULT_ADVISOR_DATA_DIR.startsWith(homedir()), '默认路径必须锚在用户级 DSH 目录')
    assert.ok(
      !DEFAULT_ADVISOR_DATA_DIR.startsWith(process.cwd()),
      '默认路径不得落在宿主进程 cwd 下（cwd 随启动目录漂移）',
    )
  })

  t('dataDir：优先级 配置 > env > 稳定默认（env 是冒烟隔离的唯一入口）', () => {
    const prev = process.env[ADVISOR_DATA_DIR_ENV]
    try {
      process.env[ADVISOR_DATA_DIR_ENV] = '/tmp/env-isolated-dir'
      assert.equal(resolveAdvisorDataDir(undefined), '/tmp/env-isolated-dir', 'env 必须覆盖默认')
      assert.equal(resolveAdvisorDataDir('/explicit/dir'), '/explicit/dir', '显式配置优先于 env')
    } finally {
      if (prev === undefined) delete process.env[ADVISOR_DATA_DIR_ENV]
      else process.env[ADVISOR_DATA_DIR_ENV] = prev
    }
  })

  t('dataDir：源码级禁止 process.cwd() 参与 advisor 目录（防漂移复发）', () => {
    for (const rel of ['../lib/index.js', '../lib/advisor/index.js']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
      assert.ok(
        !src.includes('process.cwd()'),
        `${rel} 不得用 process.cwd() 解析 advisor 数据目录（会随 DSH 启动目录漂移）`,
      )
    }
  })

  t('构造期：env 指向临时目录时真实 dataDir 不被创建/改动（冒烟不得触生产状态）', () => {
    const stampOf = (p) => {
      try { const s = statSync(p); return { exists: true, mtimeMs: s.mtimeMs } } catch { return { exists: false, mtimeMs: 0 } }
    }
    const tmp = mkdtempSync(join(tmpdir(), 'advisor-datadir-'))
    const isolated = join(tmp, 'isolated')
    const before = stampOf(DEFAULT_ADVISOR_DATA_DIR)
    const prevDir = process.env[ADVISOR_DATA_DIR_ENV]
    const prevTrace = process.env[ADVISOR_TRACE_ENV]
    try {
      process.env[ADVISOR_DATA_DIR_ENV] = isolated
      const advisor = installAdvisor(fakeCtx(), {}, {})
      assert.ok(existsSync(isolated), '必须创建 env 指定的隔离目录')
      assert.deepEqual(
        stampOf(DEFAULT_ADVISOR_DATA_DIR), before,
        '构造期不得触碰真实 dataDir（这正是残留 config.json 的成因）',
      )
      advisor.dispose()
    } finally {
      if (prevDir === undefined) delete process.env[ADVISOR_DATA_DIR_ENV]
      else process.env[ADVISOR_DATA_DIR_ENV] = prevDir
      if (prevTrace === undefined) delete process.env[ADVISOR_TRACE_ENV]
      else process.env[ADVISOR_TRACE_ENV] = prevTrace
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  t('取证：ADVISOR_TRACE_ENV 默认关闭，未设时不产生 trace 设施', () => {
    const prev = process.env[ADVISOR_TRACE_ENV]
    const prevDir = process.env[ADVISOR_DATA_DIR_ENV]
    try {
      delete process.env[ADVISOR_TRACE_ENV]
      const tmp = mkdtempSync(join(tmpdir(), 'advisor-trace-'))
      process.env[ADVISOR_DATA_DIR_ENV] = tmp
      const advisor = installAdvisor(fakeCtx(), {}, {})
      assert.ok(
        !existsSync(join(tmp, 'chunk-trace.jsonl')),
        '未开启取证时不得写 chunk-trace（行为必须与取证前一致）',
      )
      advisor.dispose()
      rmSync(tmp, { recursive: true, force: true })
    } finally {
      if (prev === undefined) delete process.env[ADVISOR_TRACE_ENV]
      else process.env[ADVISOR_TRACE_ENV] = prev
      // 原写法是无条件 delete，会把上一个用例设的隔离目录**静默清掉**——
      // 用例顺序一换，后续 installAdvisor 就可能落回真实用户目录。
      if (prevDir === undefined) delete process.env[ADVISOR_DATA_DIR_ENV]
      else process.env[ADVISOR_DATA_DIR_ENV] = prevDir
    }
  })

  // 事故回归（2026-10-03）：traceSink 曾是构造期求值，于是文档里「重启后 touch 一下
  // 哨兵即可开、删掉即停」与实现不符——哨兵在进程启动后创建根本不生效，取证被迫
  // 多重启一轮，第一轮 A/B 拿到的是无效证据（chunk-trace.jsonl 压根没生成）。
  t('取证哨兵：进程启动后创建 trace-on 立即生效、删除即停（无需重启）', async () => {
    const dir = tempDir('sentinel')
    const traceFile = join(dir, 'chunk-trace.jsonl')
    const sentinel = join(dir, 'trace-on')
    const prevTrace = process.env[ADVISOR_TRACE_ENV]
    try {
      delete process.env[ADVISOR_TRACE_ENV] // 纯哨兵路径，不靠环境变量
      assert.ok(!existsSync(sentinel), '前置：构造期目录里不得有哨兵')

      const messages = [msg('user', '写点代码'), msg('assistant', '好')]
      const events = [{ type: 'step/start', data: { turn: 't1' } }]
      const turnEnd = { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } }
      const agent = fakeAgent('sess-sen')
      agent.session = { id: 'sess-sen', deriveMessages: () => messages, ownEvents: () => [...events, turnEnd] }
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const llm = fakeLlm('{"notes":[{"severity":"nit","text":"可读性建议"}]}')
      const installed = installAdvisor(ctx, {}, {
        dataDir: dir,
        resolveLlm: () => llm,
      })
      // U2 第 8 条：启用与模型改由**该会话自己的配置**决定（不再有全局开关）
      installed.ctrl.patchConfig('sess-sen', { enabled: true, provider: 'h', model: 'hm' })
      emit('agent/created', { agent })

      // ① 无哨兵 → 不落 trace
      emit('session/event', agent.session, turnEnd)
      await installed.ctrl.runtimeOf('sess-sen')?.waitForDrain()
      assert.ok(!existsSync(traceFile), '未创建哨兵时不得落 trace')

      // ② 进程运行中创建哨兵 → 立即生效，不得要求重启
      writeFileSync(sentinel, '')
      installed.ctrl.triggerReview('sess-sen')
      await installed.ctrl.runtimeOf('sess-sen')?.waitForDrain()
      assert.ok(existsSync(traceFile), '★进程启动后创建 trace-on 必须立即生效，无需重启')
      const rows = readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.ok(rows.some((r) => r.phase === 'call-start'), 'trace 须含 call-start（带 provider/model/maxTokens）')
      assert.ok(rows.some((r) => r.type === 'text-delta'), 'trace 须含 text-delta 分片')
      assert.ok(rows.some((r) => r.phase === 'call-end'), 'trace 须含 call-end')
      const start = rows.find((r) => r.phase === 'call-start')
      assert.equal(start.model, 'hm', 'call-start 记录的模型必须与当前评审一致')

      // ③ 删除哨兵 → 立即停止
      const sizeBefore = readFileSync(traceFile, 'utf8').length
      rmSync(sentinel)
      installed.ctrl.triggerReview('sess-sen')
      await installed.ctrl.runtimeOf('sess-sen')?.waitForDrain()
      assert.equal(readFileSync(traceFile, 'utf8').length, sizeBefore, '删除哨兵后必须立即停止记录')

      installed.dispose()
    } finally {
      if (prevTrace === undefined) delete process.env[ADVISOR_TRACE_ENV]
      else process.env[ADVISOR_TRACE_ENV] = prevTrace
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // fail-open is a hard requirement (2026-10-03): the diagnostics sink is a
  // bypass only. A no-permission dir / full disk / unserialisable row may cost us
  // that one log line, never the review itself.
  t('fail-open：trace 钩子抛错不得打断评审（仍产出、仍投递、runtime 不置 error）', async () => {
    const dir = tempDir('failopen')
    try {
      const messages = [msg('user', '写点代码'), msg('assistant', '好')]
      const events = [{ type: 'step/start', data: { turn: 't1' } }]
      const turnEnd = { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } }
      const agent = fakeAgent('sess-fo')
      agent.session = { id: 'sess-fo', deriveMessages: () => messages, ownEvents: () => [...events, turnEnd] }
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const llm = fakeLlm('{"notes":[{"severity":"concern","text":"先补测试"}]}')
      let traceCalls = 0
      const explodingTrace = () => { traceCalls += 1; throw new Error('simulated: disk full / no permission') }
      const installed = installAdvisor(ctx, {}, {
        dataDir: dir,
        resolveLlm: () => llm,
        trace: explodingTrace,
      })
      installed.ctrl.patchConfig('sess-fo', { enabled: true, provider: 'h', model: 'hm' })
      emit('agent/created', { agent })
      emit('session/event', agent.session, turnEnd)
      await installed.ctrl.runtimeOf('sess-fo')?.waitForDrain()

      assert.ok(traceCalls > 0, 'trace 钩子确实被调用过（否则本用例测不到东西）')
      const snap = installed.ctrl.snapshot('sess-fo')
      assert.equal(snap.runtime.error, null, 'trace 抛错不得被记成评审失败')
      assert.equal(snap.records.length, 1, '评审必须照常产出记录')
      assert.equal(snap.records[0].text, '先补测试')
      assert.equal(agent.calls.steer.length, 1, 'concern 必须照常 steer 到主 agent')
      assert.equal(llm.calls.length, 1, '模型调用不受影响')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

// ── 2. 观察器 ────────────────────────────────────────────────────────────

export function testObserver(t) {
  t('观察器：标准 stepped 会话——最新进入过 step 的 turn/end 才评审', () => {
    const deltas = []
    const messages = [msg('user', '做 X')]
    const session = { id: 's1', ownEvents: () => [], deriveMessages: () => messages }
    const observer = new AdvisorObserver({ getSession: () => session, onDelta: (id, d) => deltas.push(d) })
    const events = [
      { type: 'step/start', data: { turn: 't1' } },
      { type: 'turn/end', seq: 10, data: { turn: 't1', reason: { kind: 'completed' } } },
    ]
    observer.handleEvent('s1', events, events[1])
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].messageCount, 1)
    // 用户掐断的回合不评审
    const aborted = { type: 'turn/end', seq: 11, data: { turn: 't2', reason: { kind: 'aborted' } } }
    observer.handleEvent('s1', [...events, { type: 'step/start', data: { turn: 't2' } }, aborted], aborted)
    assert.equal(deltas.length, 1, 'aborted 回合不得触发评审')
  })

  t('观察器：turn/end 事件谓词与 step 检测', () => {
    assert.equal(isReviewableTurnEnd({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), true)
    assert.equal(isReviewableTurnEnd({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), false)
    const events = [
      { type: 'step/start', data: { turn: 't1' } },
      { type: 'turn/end', seq: 5, data: { turn: 't1' } },
    ]
    assert.equal(findLastMessageTurnEnd(events).seq, 5)
    assert.equal(findLastMessageTurnEnd([{ type: 'turn/end', seq: 9, data: { turn: 't9' } }]), undefined)
  })

  t('观察器：agentic 模式——人类输入 + 未评审 assistant 增量才评审；发过 turn/end 即闩锁', () => {
    const deltas = []
    let messages = [msg('user', 'hi'), msg('assistant', 'ok')]
    const session = { id: 's2', deriveMessages: () => messages }
    const observer = new AdvisorObserver({ getSession: () => session, onDelta: (id, d) => deltas.push(d) })
    // 人类输入到达（user/message + source.kind=user）
    const evt = { type: 'user/message', data: { source: { kind: 'user' } }, surfaceOp: 'append' }
    observer.handleEvent('s2', [], evt)
    assert.equal(deltas.length, 1, '有 assistant 增量时应评审')
    // 无新增 assistant → 不评审
    observer.handleEvent('s2', [], evt)
    assert.equal(deltas.length, 1, '没有未评审 assistant 增量时不评审')
    // 闩锁：发过 turn/end 后 agentic 门休眠
    const te = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }
    observer.handleEvent('s2', [], te)
    messages = [...messages, msg('assistant', 'more')]
    observer.handleEvent('s2', [], evt)
    assert.equal(deltas.length, 1, '闩锁为标准模式后 user/message 不再触发')
    assert.equal(isHumanInputEvent(evt), true)
    assert.equal(isHumanInputEvent({ type: 'assistant/message' }), false)
  })

  t('观察器：重写事件检测 + 投影回退 → 全量重放', () => {
    assert.equal(isRewriteEvent({ type: 'compact/summary' }), true)
    assert.equal(isRewriteEvent({ type: 'user/message', surfaceOp: 'replace' }), true)
    assert.equal(isRewriteEvent({ type: 'user/message', surfaceOp: 'append' }), false)
    // agentic 语义：触发输入本身不评审（skipLast），游标停在它之前
    const deltas = []
    let messages = [msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')]
    const human = { type: 'user/message', data: { source: { kind: 'user' } }, surfaceOp: 'append' }
    const session = { id: 's3', deriveMessages: () => messages }
    let rewrites = 0
    const observer = new AdvisorObserver({
      getSession: () => session,
      onDelta: (id, d) => deltas.push(d),
      onRewrite: () => { rewrites += 1 },
    })
    // 第一轮：全量（游标 0），且排除触发输入 u2
    observer.handleEvent('s3', [], human)
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].messageCount, 2, '首轮评审 u1/a1，排除触发输入 u2')
    assert.ok(!deltas[0].markdown.includes('u2'))
    assert.equal(rewrites, 0)
    // compact 重写 → 标记 pendingRebuild + onRewrite（装配层重置冷却）
    observer.handleEvent('s3', [], { type: 'compact/summary', data: {} })
    assert.equal(rewrites, 1, 'compact/* 必须触发 onRewrite')
    // 重放后应取**全部**可见消息，而不是只取增量
    messages = [msg('user', 'u1'), msg('assistant', 'a1'), msg('assistant', 'a2'), msg('user', 'u3')]
    deltas.length = 0
    observer.handleEvent('s3', [], human)
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].messageCount, 3, '重写后全量重放（排除触发输入 u3）')
    // 投影回退（可见消息比游标还短）→ 仍然全量重放而不是增量
    messages = [msg('user', 'u1'), msg('assistant', 'a2b')]
    deltas.length = 0
    observer.handleEvent('s3', [], human)
    assert.equal(deltas.length, 1, '投影回退仍要补评审')
    assert.equal(deltas[0].messageCount, 1, '回退后取全部剩余可见消息（1 条）')
  })

  t('观察器：有界窗口截取最近 N 条 + advisor 消息排除', () => {
    const messages = [
      buildAdvisorMessage({ severity: 'nit', text: '内部意见' }),
      msg('user', 'u1'), msg('assistant', 'a1'), msg('assistant', 'a2'), msg('assistant', 'a3'),
    ]
    const rendered = renderVisibleSurface(messages, 2)
    assert.equal(rendered.messageCount, 2, '窗口 2 → 只留最近 2 条可见消息')
    assert.ok(!rendered.markdown.includes('内部意见'), 'advisor 自己的消息不进评审输入')
    assert.ok(rendered.markdown.includes('a2') && rendered.markdown.includes('a3'))
    assert.equal(isAdvisorMessage(messages[0]), true)
    // 0 = 无上限
    assert.equal(renderVisibleSurface(messages, 0).messageCount, 4)
  })
}

// ── 3. 运行时 ────────────────────────────────────────────────────────────

export function testRuntime(t) {
  t('严格 JSON：合法 notes 解析；缺 notes / 非法 JSON / 非对象 → error', () => {
    const ok = parseReviewOutput('{"notes":[{"severity":"concern","text":"请检查 X"}]}')
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.notes, [{ severity: 'concern', text: '请检查 X' }])
    // 缺 notes → error
    assert.match(parseReviewOutput('{"foo":1}').error, /notes/)
    // 非法 JSON（围栏/散文）→ error（严格契约，不做容错提取）
    assert.match(parseReviewOutput('```json\n{"notes":[]}\n```').error, /严格 JSON/)
    assert.match(parseReviewOutput('随便说点什么').error, /严格 JSON/)
    // 顶层数组 → error
    assert.ok(parseReviewOutput('[{"severity":"nit","text":"x"}]').error)
    // 空数组 notes → 无意见（不是 error）
    const empty = parseReviewOutput('{"notes":[]}')
    assert.equal(empty.error, undefined)
    assert.deepEqual(empty.notes, [])
    // severity 非法 → 归一 nit
    assert.equal(parseReviewOutput('{"notes":[{"severity":"xxx","text":"t"}]}').notes[0].severity, 'nit')
  })

  t('运行时：单轮评审 → 逐条投递 + 落记录 + 持续会话累积', async () => {
    const delivered = []
    const recorded = []
    const statuses = []
    const llm = fakeLlm((opts, n) => (n === 1
      ? '{"notes":[{"severity":"concern","text":"第一轮意见"}]}'
      : '{"notes":[{"severity":"nit","text":"第二轮意见"}]}'))
    const runtime = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 'sys', llm,
      deliver: (note) => { delivered.push(note); return 'steer' },
      record: (r) => recorded.push(r),
      onStatus: (s) => statuses.push(s.status),
    })
    runtime.enqueue({ markdown: '<用户对Agent说>U1</用户对Agent说>' }, { sessionId: 's', sessionName: '会话' })
    await runtime.waitForDrain()
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].text, '第一轮意见')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].outcome, 'steer')
    assert.equal(recorded[0].severity, 'concern')
    // 持续会话累积：第二轮的输入应含第一轮历史 + 自己的输出
    runtime.enqueue({ markdown: '<用户对Agent说>U2</用户对Agent说>' }, { sessionId: 's' })
    await runtime.waitForDrain()
    assert.equal(llm.calls.length, 2)
    const secondInput = llm.calls[1].messages
    assert.ok(secondInput.some((m) => JSON.stringify(m.content).includes('第一轮意见')), '第二轮输入应含自己上一轮输出（持续会话）')
    assert.ok(secondInput.at(-1).content[0].text.includes('U2'), '最后一条是本轮增量')
  })

  t('运行时：输出解析失败 → status=error + 落记录 + 不投递', async () => {
    const delivered = []
    const recorded = []
    const runtime = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 'sys', llm: fakeLlm('这不是 JSON'),
      deliver: (note) => { delivered.push(note); return 'steer' },
      record: (r) => recorded.push(r),
    })
    runtime.enqueue({ markdown: 'U' }, { sessionId: 's' })
    await runtime.waitForDrain()
    assert.equal(delivered.length, 0, '解析失败不得投递')
    assert.equal(runtime.status, 'error')
    assert.ok(runtime.error)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].outcome, 'dropped', '解析失败记录为 dropped')
  })

  t('运行时：空输出不调模型（无可见内容）', async () => {
    const llm = fakeLlm('{"notes":[]}')
    const runtime = new AdvisorRuntime({ provider: 'p', model: 'm', systemPrompt: 's', llm, deliver: () => 'steer', record: () => {} })
    runtime.enqueue({ markdown: '   ' }, { sessionId: 's' })
    await runtime.waitForDrain()
    assert.equal(llm.calls.length, 0)
  })

  t('运行时：队列上限满时丢最新（drop-newest），不阻塞', async () => {
    const llm = fakeLlm(new Array(40).fill('{"notes":[]}'))
    const runtime = new AdvisorRuntime({ provider: 'p', model: 'm', systemPrompt: 's', llm, maxQueued: 2, deliver: () => 'recorded', record: () => {} })
    // 手动占用 drain（构造一个慢 llm 用 pending 控制）——直接测 enqueue 返回值
    runtime.disposed = false
    const r1 = runtime.enqueue({ markdown: 'a' }, { sessionId: 's' })
    const r2 = runtime.enqueue({ markdown: 'b' }, { sessionId: 's' })
    assert.equal(r1, true)
    // 第三条在队列满时应被拒（draining 中队列可能已消费，用 maxQueued=1 更稳）
    runtime.dispose()
    const slow = new AdvisorRuntime({ provider: 'p', model: 'm', systemPrompt: 's', llm, maxQueued: 1, deliver: () => 'recorded', record: () => {} })
    slow.draining = true // 冻结 drain，队列不消费
    assert.equal(slow.enqueue({ markdown: 'x' }, { sessionId: 's' }), true)
    assert.equal(slow.enqueue({ markdown: 'y' }, { sessionId: 's' }), false, '队列满 → 丢最新')
    slow.dispose()
  })

  t('运行时：投递返回 false → 记录 outcome=dropped', async () => {
    const recorded = []
    const runtime = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 's',
      llm: fakeLlm('{"notes":[{"severity":"blocker","text":"X"}]}'),
      deliver: () => false,
      record: (r) => recorded.push(r),
    })
    runtime.enqueue({ markdown: 'U' }, { sessionId: 's' })
    await runtime.waitForDrain()
    assert.equal(recorded[0].outcome, 'dropped')
  })

  t('持续会话：append/snapshot/stats/reset', () => {
    const conv = new AdvisorConversation()
    conv.appendUser('u1'); conv.appendAssistant('a1'); conv.appendUser('u2')
    assert.equal(conv.length, 3)
    assert.deepEqual(conv.snapshot().map((m) => m.role), ['user', 'assistant', 'user'])
    assert.ok(conv.stats().charCount >= 5)
    conv.reset()
    assert.equal(conv.length, 0)
  })
}

// ── 4. 投递（delivery） ──────────────────────────────────────────────────

export function testDelivery(t) {
  t('投递：info+infoInject=false → recorded（不打扰）；infoInject=true → inject（永不 steer）', () => {
    const agent = fakeAgent('s')
    const d1 = new AdvisorDelivery({ immuneTurns: 2, infoInject: false })
    d1.registerAgent(agent)
    assert.equal(d1.route('s', { severity: 'info', text: 'i' }), 'recorded')
    assert.equal(agent.calls.inject.length, 0)
    const d2 = new AdvisorDelivery({ immuneTurns: 2, infoInject: true })
    d2.registerAgent(agent)
    assert.equal(d2.route('s', { severity: 'info', text: 'i' }), 'inject')
    assert.equal(agent.calls.steer.length, 0)
  })

  t('投递：nit 在 steerSeverities 且不在冷却 → steer；冷却窗口内降级 inject', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 2, steerSeverities: ['nit', 'concern', 'blocker'] })
    d.registerAgent(agent)
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'steer')
    assert.equal(agent.calls.steer.length, 1)
    // 冷却中（immuneTurns=2）
    assert.equal(d.route('s', { severity: 'concern', text: 'c' }), 'inject')
    // 走完 2 个主回合后恢复 steer
    d.onSteppedTurnEnd('s')
    assert.equal(d.route('s', { severity: 'concern', text: 'c' }), 'inject')
    d.onSteppedTurnEnd('s')
    assert.equal(d.route('s', { severity: 'concern', text: 'c' }), 'steer')
  })

  t('投递：severity 不在 steerSeverities → inject；缺 agent → false(dropped)', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 0, steerSeverities: ['blocker'] })
    d.registerAgent(agent)
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'inject')
    // 缺 agent
    assert.equal(d.route('ghost', { severity: 'blocker', text: 'b' }), false)
    // info 且 agent 无 inject → 丢弃（绝不回退 steer）
    const bare = { id: 'x', steer: () => {} }
    const d2 = new AdvisorDelivery({ immuneTurns: 0, infoInject: true })
    d2.registerAgent(bare)
    assert.equal(d2.route('x', { severity: 'info', text: 'i' }), false)
  })

  t('投递：重写重置冷却（onRewrite → reset）', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 1, steerSeverities: ['nit'] })
    d.registerAgent(agent)
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'steer')
    d.reset('s') // 重写
    assert.equal(d.route('s', { severity: 'nit', text: 'n2' }), 'steer', '重写后冷却应清零')
  })

  t('消息形态：user-role + source.kind=advisor + notice form + summary', () => {
    const m = buildAdvisorMessage({ severity: 'concern', text: '请修 X' })
    assert.equal(m.role, 'user')
    assert.equal(m.source.kind, 'advisor')
    assert.equal(m.source.form, 'notice')
    assert.ok(m.source.summary.startsWith('[concern]'))
    assert.equal(m.content[0].type, 'text')
  })
}

// ── 5. 存储 + 端点 ───────────────────────────────────────────────────────

export function testStoreAndApi(t) {
  t('存储：追加 → 倒序读回 → 按 persistLimit 保留上限裁剪', () => {
    const dir = tempDir('store')
    try {
      const store = new AdvisorStore({ dataDir: dir, persistLimit: 3 })
      for (let i = 0; i < 5; i++) {
        store.append({ sessionId: 's', severity: 'nit', text: `note-${i}`, createdAt: 1000 + i, outcome: 'steer' })
      }
      const listed = store.list()
      assert.equal(listed.length, 3, '超过上限只保留最近 3 条')
      assert.equal(listed[0].text, 'note-4', '按 createdAt 倒序')
      assert.ok(listed[0].id && listed[0].createdAt >= 1004)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('存储：记录规范化（裁字段、截 200 字、非法 severity → null）', () => {
    const r = normalizeRecord({ sessionId: 's', severity: 'nit', text: 'x'.repeat(300), outcome: 'weird', createdAt: 5, extra: 'drop' })
    assert.deepEqual(Object.keys(r).sort(), ['createdAt', 'id', 'outcome', 'sessionId', 'sessionName', 'severity', 'text'])
    assert.equal(r.text.length, 200)
    assert.equal(r.outcome, 'dropped')
    assert.equal(normalizeRecord({ severity: 'ultra', text: 'x' }), null)
    assert.equal(normalizeRecord({ severity: 'nit', text: '   ' }), null)
  })

  // S1 改写（原「config.json 读写」用例）：全局单份 config.json 的读写面已删除，
  // 配置改为 per-session 分文件（判据 A3/A4/A5 迁到 testSessionStore）。
  // 这里只锁「删除」这一事实本身 + CONFIG_FILE 常量按计划保留（用于旧文件检测）。
  t('存储：全局 config.json 读写面已删除，CONFIG_FILE 常量保留', () => {
    const dir = tempDir('cfg')
    try {
      const store = new AdvisorStore({ dataDir: dir, persistLimit: 10 })
      assert.equal(store.readConfig, undefined, 'readConfig 必须已删除（旧全局配置不再读取）')
      assert.equal(store.writeConfig, undefined, 'writeConfig 必须已删除（旧全局配置不再写入）')
      assert.equal(CONFIG_FILE, 'config.json', 'CONFIG_FILE 常量按计划保留（供旧文件存在性检测）')
      assert.equal(store.readSessionConfig('s1').constructor, Object)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('端点 PATCH 形状校验：sessionId 必填 / 未知键 / 空串 / 单给其一 → 抛错；合法放行', () => {
    assert.throws(() => normalizeAdvisorPatch({}), /至少一个键/)
    assert.throws(() => normalizeAdvisorPatch({ nope: 1 }), /未知键/)
    assert.throws(() => normalizeAdvisorPatch({ enabled: true }), /缺少 sessionId/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: '  ', enabled: true }), /空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 7, enabled: true }), /非空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 'x'.repeat(201), enabled: true }), /上限/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 's', provider: 'p' }), /成对/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 's', model: 'm' }), /成对/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 's', provider: '', model: 'm' }), /空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 's', provider: 'p', model: '' }), /空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ sessionId: 's', enabled: 'yes' }), /布尔/)
    assert.deepEqual(normalizeAdvisorPatch({ sessionId: 's', enabled: true }), { sessionId: 's', enabled: true })
    assert.deepEqual(
      normalizeAdvisorPatch({ sessionId: ' s ', provider: ' p ', model: ' m ' }),
      { sessionId: 's', provider: 'p', model: 'm' },
    )
  })

  // S2 重写：端点与配置彻底绑定会话（sessionId 必填 + 活跃校验 + 记录按会话过滤）。
  // 逐条判据（B6/B9-B12/B14-B18/B21/B22）集中在 testPerSessionEndpoint 组。
  t('端点：GET/PATCH/POST 走真实 handler（回环+Origin+形状）', async () => {
    const dir = tempDir('api')
    try {
      const { ctx } = fakeCtx()
      ctx.agents.get = (id) => (id === 's-api' ? fakeAgent('s-api') : undefined)
      const installed = installAdvisor(ctx, {}, {
        dataDir: dir,
        resolveLlm: () => fakeLlm('{"notes":[]}'),
      })
      const handler = createAdvisorHandler({ ctrl: installed.ctrl, loadCatalog: async () => ({ p: ['m'] }) })

      // GET（带 sessionId）
      const res1 = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', '/plugins/dsh-agents/advisor?sessionId=s-api'), res1)
      assert.equal(res1.statusCode, 200)
      const b1 = res1.json()
      assert.equal(b1.ok, true)
      assert.equal(b1.modelSource, 'unset')
      assert.deepEqual(b1.catalog, { p: ['m'] })
      assert.ok(Array.isArray(b1.records))

      // PATCH 改 provider/model → modelSource=session，仍 200
      const res2 = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-api', provider: 'p2', model: 'm2' }), res2)
      assert.equal(res2.statusCode, 200)
      assert.equal(res2.json().modelSource, 'session')
      assert.equal(res2.json().provider, 'p2')

      // PATCH 非法 → 400
      const res3 = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-api', provider: 'only' }), res3)
      assert.equal(res3.statusCode, 400)

      // POST review（无 agent → no-session，恒 200）
      const res4 = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 'ghost' }), res4)
      assert.equal(res4.statusCode, 200)
      assert.equal(res4.json().ok, false)
      assert.ok(['disabled', 'unset', 'busy', 'no-session'].includes(res4.json().reason))

      // 非回环 → 403
      const res5 = fakeRes()
      await handler(fakeReq('GET', undefined, '192.0.2.9'), res5)
      assert.equal(res5.statusCode, 403)

      // Origin 不匹配 → 403
      const res6 = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', 'http://evil.example:3080'), res6)
      assert.equal(res6.statusCode, 403)

      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('端点：端点路径 = 契约 §2 的 /plugins/dsh-agents/advisor', () => {
    assert.equal(ADVISOR_ENDPOINT, '/plugins/dsh-agents/advisor')
  })
}

// ── 6. 装配（installAdvisor）集成：事件驱动一整条链路 ──────────────────

export function testIntegration(t) {
  t('集成：session/event → observer → runtime → steer 投递 → 记录落盘', async () => {
    const dir = tempDir('e2e')
    try {
      const messages = [msg('user', '请写代码'), msg('assistant', '好的')]
      const events = [
        { type: 'step/start', data: { turn: 't1' } },
        { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } },
      ]
      const agent = fakeAgent('sess-1')
      // 会话带 ownEvents()（DSH 0.1.2-alpha.4+ 的形状；装配层三档兜底读它）
      agent.session = { id: 'sess-1', deriveMessages: () => messages, ownEvents: () => events }
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = (id) => (id === 'sess-1' ? agent : undefined)
      const llm = fakeLlm('{"notes":[{"severity":"concern","text":"请补充测试"}]}')
      const installed = installAdvisor(ctx, {}, {
        dataDir: dir,
        resolveLlm: () => llm,
      })
      // U2 第 8 条：开启与模型走该会话自己的配置
      installed.ctrl.patchConfig('sess-1', { enabled: true, provider: 'p', model: 'm' })
      // 发 agent/created（登记 agent + 建运行时）
      emit('agent/created', { agent })
      // 推一个可评审的 turn/end（step → turn/end）
      emit('session/event', agent.session, events[1])
      // 等评审排空
      await installed.ctrl.runtimeOf('sess-1')?.waitForDrain()
      // steer 被调用（第一轮不在冷却）
      assert.equal(agent.calls.steer.length, 1, 'concern ∈ steerSeverities 且首次投递应 steer')
      assert.equal(agent.calls.steer[0].source.kind, 'advisor')
      // 记录落盘（按会话过滤后仍能读到本会话这一条）
      const records = installed.ctrl.snapshot('sess-1').records
      assert.equal(records.length, 1)
      assert.equal(records[0].text, '请补充测试')
      assert.equal(records[0].outcome, 'steer')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // U2 第 10 条：用例名与语义同步——「默认关」已不再是**全局开关**，而是
  // 「该会话没写配置」。
  t('集成：会话未写配置时不建运行时、不调模型（U2：无全局开关）', async () => {
    const dir = tempDir('off')
    try {
      const agent = fakeAgent('sess-off')
      const llm = fakeLlm('{"notes":[{"severity":"blocker","text":"X"}]}')
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => llm })
      emit('agent/created', { agent })
      emit('session/event', agent.session, {
        type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } },
      })
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(llm.calls.length, 0, '未写会话配置不得发起模型调用')
      const snap = installed.ctrl.snapshot('sess-off')
      assert.equal(snap.enabled, false)
      assert.equal(snap.runtime.status, 'disabled')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // S2 重写（原「HIGH 档回落」用例）：B2 + B3 —— 未指定模型即不评审，
  // 且传进来的 HIGH 档路由**完全不被消费**。
  t('B2/B3 未配模型：不建运行时、不调模型，快照如实报 unset/disabled', async () => {
    const dir = tempDir('unset')
    try {
      const agent = fakeAgent('sess-unset')
      const llm = fakeLlm('{"notes":[]}')
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const installed = installAdvisor(ctx, {}, {
        dataDir: dir,
        resolveLlm: () => llm,
        tierTableOf: () => ({ HIGH: { provider: 'high-prov', model: 'high-model' } }),
      })
      emit('agent/created', { agent })
      assert.equal(installed.ctrl.runtimeOf('sess-unset'), undefined, '未配模型不得建运行时')
      emit('session/event', agent.session, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } })
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(llm.calls.length, 0, '未配模型不得调用任何模型（含 HIGH 档路由）')
      const snap = installed.ctrl.snapshot('sess-unset')
      assert.equal(snap.modelSource, 'unset')
      assert.equal(snap.provider, null)
      assert.equal(snap.model, null)
      assert.equal(snap.runtime.status, 'disabled')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

// ── 5b. 会话级配置存储（S1 判据 A1-A16）─────────────────────────────────
// 每条用例名带判据编号，便于「变异体 → 变红断言」对照。

export function testSessionStore(t) {
  /** 可替换 fs 门面 + renameSync 探针：在**真正 rename 之前**抓 temp 路径与内容。 */
  function probeStore(dataDir, options = {}) {
    const calls = []
    const facade = {
      ...nodeFs,
      renameSync: (from, to) => {
        calls.push({
          from,
          to,
          content: nodeFs.readFileSync(from, 'utf8'),
          dirAtRename: dirname(from),
        })
        return nodeFs.renameSync(from, to)
      },
    }
    return { store: new AdvisorStore({ dataDir, ...options, fs: facade }), calls }
  }

  t('A1 路径：同一 sessionId 幂等、不同会话不同文件、恒落 sessions/', () => {
    const dir = join(tmpdir(), 'dsh-adv-a1')
    const first = sessionConfigPath(dir, 's1')
    assert.equal(sessionConfigPath(dir, 's1'), first, '同一 sessionId 必须给出同一路径')
    assert.notEqual(sessionConfigPath(dir, 's2'), first, '不同会话必须落到不同文件')
    assert.equal(dirname(first), join(dir, 'sessions'))
    assert.equal(dirname(sessionConfigPath(dir, 's2')), join(dir, 'sessions'))
  })

  t('A2 路径穿越：恶意 sessionId 全部被 base64url 关在 sessions/ 内', () => {
    const dir = join(tmpdir(), 'dsh-adv-a2')
    // 空串不在此列：空 sessionId 由 S2 的形状层拒收（B8/B20），S1 不可达
    const hostiles = ['../../evil', 'C:\\x', '..', 'a/b', 'a\\b', '\u0000', '会话🙂', '..\\..\\etc\\passwd']
    for (const sid of hostiles) {
      const p = sessionConfigPath(dir, sid)
      assert.equal(dirname(p), join(dir, 'sessions'), `${JSON.stringify(sid)} 必须留在 sessions/ 子目录内`)
      assert.match(basename(p), /^[A-Za-z0-9_-]+\.json$/, `${JSON.stringify(sid)} 的文件名必须是 base64url`)
    }
  })

  t('A3/A4 读写：不存在读成空对象；三键齐写后再单写 enabled 保留 provider/model', () => {
    const dir = tempDir('sesscfg')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      assert.deepEqual(store.readSessionConfig('s1'), {}, '文件不存在必须读成空对象')
      store.writeSessionConfig('s1', { enabled: true, provider: 'p', model: 'm' })
      assert.deepEqual(store.readSessionConfig('s1'), { enabled: true, provider: 'p', model: 'm' })
      store.writeSessionConfig('s1', { enabled: false })
      const after = store.readSessionConfig('s1')
      assert.equal(after.enabled, false)
      assert.equal(after.provider, 'p', '部分更新必须保留既有 provider')
      assert.equal(after.model, 'm', '部分更新必须保留既有 model')
      assert.equal(existsSync(sessionConfigPath(dir, 's1')), true, '落点必须是该会话自己的文件')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A5 隔离：两会话互不覆盖，且不再产生旧全局 config.json', () => {
    const dir = tempDir('sessiso')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      store.writeSessionConfig('s1', { enabled: true, provider: 'p1', model: 'm1' })
      store.writeSessionConfig('s2', { enabled: false })
      assert.deepEqual(
        store.readSessionConfig('s1'), { enabled: true, provider: 'p1', model: 'm1' },
        '写 s2 不得覆盖 s1 的配置',
      )
      assert.deepEqual(store.readSessionConfig('s2'), { enabled: false })
      assert.equal(existsSync(join(dir, CONFIG_FILE)), false, 'S1 起不得再写旧全局 config.json')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A6（辅助判据）：写入后 sessions/ 下无 .tmp-advisor-* 残留', () => {
    const dir = tempDir('tmpclean')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      store.writeSessionConfig('s1', { enabled: false })
      store.writeSessionConfig('s2', { provider: 'p', model: 'm' })
      const leftovers = readdirSync(join(dir, 'sessions')).filter((n) => n.startsWith('.tmp-advisor-'))
      assert.deepEqual(leftovers, [], 'temp 文件必须被 rename 消费掉')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A9 并发不丢更新：同会话两次并发写，终态同时具备两次写的字段', async () => {
    const dir = tempDir('sessrace')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      // 故意不 await：async 实现下两次写会读到同一份旧值，后写覆盖前写（丢更新）
      const first = store.writeSessionConfig('s1', { provider: 'p', model: 'm' })
      const second = store.writeSessionConfig('s1', { enabled: false })
      await Promise.all([first, second])
      assert.deepEqual(
        store.readSessionConfig('s1'), { enabled: false, provider: 'p', model: 'm' },
        '终态必须同时具备两次写的字段（同步临界区 = 天然串行）',
      )
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A12 原子写探针：rename 前 temp 与目标同目录、内容完整可 parse、探针恰一次', () => {
    const dir = tempDir('atomic')
    try {
      const { store, calls } = probeStore(dir)
      store.writeSessionConfig('s1', { enabled: true, provider: 'p', model: 'm' })
      const target = sessionConfigPath(dir, 's1')
      assert.equal(calls.length, 1, '一次写入必须恰好触发一次 rename（既不零次也不多次）')
      const [call] = calls
      assert.equal(call.to, target, 'rename 目标必须是该会话配置文件')
      assert.notEqual(call.from, target, '必须经由临时文件（直接对目标 rename 等于没做原子写）')
      assert.equal(call.dirAtRename, dirname(target), 'temp 必须与目标同目录（跨目录 rename 不保证原子）')
      assert.doesNotThrow(() => JSON.parse(call.content), 'rename 之前 temp 内容必须是完整 JSON')
      assert.ok(call.content.includes('"provider": "p"'), '探针读到的是本次写入的新内容')
      assert.equal(existsSync(target), true, 'rename 之后目标文件存在')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A13 F-12：两个 store 实例写同一目录的不同会话，temp 名互不相同', () => {
    const dir = tempDir('f12')
    try {
      const a = probeStore(dir)
      const b = probeStore(dir)
      a.store.writeSessionConfig('s1', { enabled: false })
      b.store.writeSessionConfig('s2', { enabled: false })
      assert.equal(a.calls.length, 1)
      assert.equal(b.calls.length, 1)
      assert.notEqual(
        basename(a.calls[0].from), basename(b.calls[0].from),
        'temp 名必须含各自目标 basename，否则两个实例会抢同一个 temp 路径',
      )
      assert.ok(basename(a.calls[0].from).includes(basename(sessionConfigPath(dir, 's1'))))
      assert.ok(basename(b.calls[0].from).includes(basename(sessionConfigPath(dir, 's2'))))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A14 F-13：writeSessionConfig 与 ctrl.patchConfig 都必须是非 async 函数', () => {
    assert.equal(
      AdvisorStore.prototype.writeSessionConfig.constructor.name, 'Function',
      'writeSessionConfig 一旦变 async，同步临界区即失效（N19）',
    )
    const dir = tempDir('sync')
    try {
      const installed = installAdvisor(fakeCtx(), {}, { dataDir: dir })
      assert.equal(installed.ctrl.patchConfig.constructor.name, 'Function', 'patchConfig 不得是 async')
      assert.doesNotThrow(() => installed.ctrl.patchConfig('sess-a14', { enabled: false }))
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * 断言「同步抛错」：实现若改成 async，返回的是 rejected promise 而非抛错，
   * 这里把它显式判红（并吞掉拒绝，避免未处理拒绝把整个测试进程带崩）。
   * @param {() => unknown} fn
   * @returns {Error|null} 捕获到的同步异常
   */
  function throwsSync(fn) {
    let returned
    try {
      returned = fn()
    } catch (error) {
      return error
    }
    if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
      returned.then(() => {}, () => {})
      throw new Error('必须是同步抛错（实现返回了 Promise，说明它已变成 async 函数）')
    }
    return null
  }

  t('A15 U2 成对规则：enabled=true 无模型抛同步异常，且目标文件零变化', () => {
    const dir = tempDir('pairing')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      // ① 已有配置（enabled:false）的会话：非法补丁必须抛错且文件逐字节不变
      store.writeSessionConfig('s1', { enabled: false })
      const before = readFileSync(sessionConfigPath(dir, 's1'), 'utf8')
      assert.match(String(throwsSync(() => store.writeSessionConfig('s1', { enabled: true }))?.message ?? ''), /模型/)
      assert.equal(
        readFileSync(sessionConfigPath(dir, 's1'), 'utf8'), before,
        '校验失败时目标文件必须零变化',
      )
      // ② 全新会话：enabled:true 无模型 → 抛错且不落任何文件
      assert.match(String(throwsSync(() => store.writeSessionConfig('fresh', { enabled: true }))?.message ?? ''), /模型/)
      assert.equal(existsSync(sessionConfigPath(dir, 'fresh')), false, '校验失败不得留下任何文件')
      // ③ 单给 provider 同样非法（必须成对给出）
      assert.match(
        String(throwsSync(() => store.writeSessionConfig('s2', { enabled: true, provider: 'p' }))?.message ?? ''), /模型/,
      )
      assert.equal(existsSync(sessionConfigPath(dir, 's2')), false)
      // ④ 成对给出 → 放行
      assert.doesNotThrow(() => store.writeSessionConfig('s3', { enabled: true, provider: 'p', model: 'm' }))
      assert.equal(store.readSessionConfig('s3').enabled, true)
      // ⑤ 已有模型时单写 enabled:true → 合法（合并语义，不是重新校验整份历史）
      store.writeSessionConfig('s4', { provider: 'p', model: 'm' })
      assert.doesNotThrow(() => store.writeSessionConfig('s4', { enabled: true }))
      assert.equal(store.readSessionConfig('s4').enabled, true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A7 旧文件裁决：旧 config.json 存在即忽略（一次性告警 + 绝不读取 + 不删用户文件）', () => {
    const dir = tempDir('legacy')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, CONFIG_FILE),
        `${JSON.stringify({ enabled: true, provider: 'legacy', model: 'legacy' })}\n`,
      )
      const messages = []
      const logger = { warn: (m) => messages.push(String(m)), error: (m) => messages.push(String(m)) }
      const installed = installAdvisor(fakeCtx(), { advisorEnabled: false }, { dataDir: dir, logger })

      const legacyWarns = messages.filter((m) => m.includes('旧全局配置'))
      assert.equal(legacyWarns.length, 1, `旧全局配置必须恰好告警一次（实得 ${legacyWarns.length}）`)
      assert.equal(existsSync(join(dir, CONFIG_FILE)), true, '不删除用户文件')
      const snap = installed.ctrl.snapshot('any')
      assert.notEqual(snap.provider, 'legacy', '旧 config.json 的 provider 不得被读取')
      assert.notEqual(snap.model, 'legacy', '旧 config.json 的 model 不得被读取')
      assert.equal(snap.enabled, false, '旧 config.json 的 enabled 也不得生效')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('A16a/A16c 不变量：advisorEnabled 键仍在 ALLOWED_KEYS 内（键缺席才会 boot 失败）', () => {
    assert.doesNotThrow(
      () => resolveAdvisorConfig({ advisorEnabled: true, advisorProvider: null, advisorModel: null }),
      '键在场时不得抛错（cordis.patch.yml 随包默认带这一行）',
    )
    assert.doesNotThrow(() => resolveAdvisorConfig({ advisorEnabled: false }))
    // 阳性对照：校验器本身是活的（未知 advisor 键确实抛错），否则上面的「不抛」没有意义
    assert.throws(() => resolveAdvisorConfig({ advisorDefinitelyNotAKey: 1 }), /未知 advisor 配置键/)
  })
}

// ── 真实用户数据目录的隔离门（S2 必修 3）───────────────────────────────
// 事故面：installAdvisor 默认数据目录是 **真实用户目录**
// `~/.dsh/plugins-data/dsh-agents/advisor`。S1 只给 boot-schema-check.mjs 加了
// 隔离，本套件没有，于是「跑测试绝不碰用户目录」只是**恰好没触发**而不是被断言
// 过的性质——差一条会写 records 的路径就会写进用户真实数据。
// 落法：模块加载时对真实目录做一次**递归快照**（路径 + 大小 + mtime + SHA256），
// 套件最后一个用例逐项比对。它注册在 run.mjs 的最后，是真正的收尾断言。
function snapshotTree(dir) {
  const out = []
  let rootStat
  try { rootStat = statSync(dir) } catch { return ['<absent>'] }
  if (!rootStat.isDirectory()) return ['<not-a-directory>']
  const walk = (current, rel) => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { out.push(`${rel}/<unreadable>`); return }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name)
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { out.push(`${name}/`); walk(full, name); continue }
      try {
        const st = statSync(full)
        out.push(`${name} size=${st.size} mtimeMs=${st.mtimeMs} sha256=${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      } catch (error) {
        out.push(`${name} <stat-failed:${error?.code ?? '?'}>`)
      }
    }
  }
  walk(dir, '')
  return out
}

/** 模块加载即拍下真实目录的基线（早于任何用例跑）。 */
const REAL_DATA_DIR_BASELINE = snapshotTree(DEFAULT_ADVISOR_DATA_DIR)

// ── HTTP 桩（照抄 run.mjs 的 fakeReq/fakeRes） ───────────────────────────

/** 假请求：url 缺省指向端点本身（**不带 query** → GET 形状非法 → 400）。
 *  B7 要构造「req.url 为 undefined」，直接把 url 显式传 undefined 即可。 */
function fakeReq(method, body, remote = '127.0.0.1', origin = null, host = '127.0.0.1:3080', url = ADVISOR_ENDPOINT) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const headers = { host }
  if (origin) headers.origin = origin
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    headers,
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
}
function fakeRes() {
  const res = { statusCode: 0, bodyText: '' }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (payload) => { res.bodyText = payload }
  res.json = () => JSON.parse(res.bodyText)
  return res
}

// ── 7. S2 会话级模型来源 + 端点绑定 + 记录过滤 + 活跃校验 ────────────────
// 判据 B2-B22（每条用例名带编号，便于「变异体 → 变红断言」对照）+ S2 开工前置
// 第 1 条的 F-2 判据。契约依据见 agent-out/plan-per-session-advisor.md S2 段。

/** 最小可用 ctx（无事件面、无 webServer），用于只测端点与会话配置的场景。 */
function bareCtx(agents) {
  const ctx = { effect: (f) => f(), inject: () => {} }
  if (agents !== undefined) ctx.agents = agents
  ctx.on = () => () => {}
  return ctx
}

/** 带活跃会话的 ctx：`agents.get` 只认传入的 id 集合。 */
function ctxWithSessions(ids, extra = {}) {
  const set = new Set(ids)
  return bareCtx({ get: (id) => (set.has(id) ? fakeAgent(id) : undefined), ...extra })
}

export function testPerSessionEndpoint(t) {
  /** 通用装配：给定活跃会话集合，返回 handler 与 installed。 */
  function boot(dir, activeIds, deps = {}) {
    const handlers = new Map()
    const ctx = bareCtx({ get: (id) => (activeIds.includes(id) ? fakeAgent(id) : undefined) })
    ctx.emit = (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) }
    ctx.on = (event, fn) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn))
    }
    const llm = deps.llm ?? fakeLlm('{"notes":[]}')
    const installed = installAdvisor(ctx, deps.config ?? {}, { dataDir: dir, resolveLlm: () => llm, ...(deps.extra ?? {}) })
    const handler = createAdvisorHandler({ ctrl: installed.ctrl, loadCatalog: async () => ({ 'prov-a': ['m-a'] }) })
    return { ctx, llm, installed, handler }
  }

  const getUrl = (sessionId) => `${ADVISOR_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`

  // ── S2 开工前置第 1 条：F-2 跨层取值洞 ────────────────────────────────
  // S1 的三层合并（全局 config ← 无会话过渡槽 ← 会话配置）会造出两种越界开启：
  //  ① 过渡槽里 enabled=true + 会话只有模型 → 该会话被「自动开启」，用的模型从未用于开启它；
  //  ② config.advisorEnabled=true → 开启所有会话。
  //  S2 删掉过渡层后两种都不可能；本判据把「槽文件**真的躺在盘上**」也钉住，
  //  防止日后有人加回「读一个共享开关」的路径。
  t('F-2 前置1：别的会话 / 遗留过渡槽 / 全局配置都不得单独开启本会话', () => {
    const dir = tempDir('f2')
    try {
      const { installed } = boot(dir, [])
      // ① 会话 A 完整开启（模型 + enabled）
      installed.ctrl.patchConfig('sess-A', { enabled: true, provider: 'p', model: 'm' })
      assert.equal(installed.ctrl.snapshot('sess-A').enabled, true, '阳性对照：A 自己是开启的')

      // ② 遗留的「无会话过渡槽」文件**真的躺在盘上**（base64url('advisor-endpoint')）
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      writeFileSync(
        sessionConfigPath(dir, 'advisor-endpoint'),
        `${JSON.stringify({ enabled: true, provider: 'slot-prov', model: 'slot-model' })}\n`,
      )

      // 会话 B 什么都没写 → 必须仍是关闭，且不得借用 A 或槽的模型
      const b = installed.ctrl.snapshot('sess-B')
      assert.equal(b.enabled, false, '★A 的 enabled=true 不得开启 B')
      assert.equal(b.modelSource, 'unset')
      assert.equal(b.provider, null)
      assert.equal(b.model, null)
      assert.equal(installed.ctrl.runtimeOf('sess-B'), undefined, 'B 不得被建出运行时')
      assert.equal(existsSync(sessionConfigPath(dir, 'advisor-endpoint')), true, '不得自动删除用户/遗留文件')

      // 前置 2 的字面量锁：过渡层连同它的常量名一起消失（源码级零命中）。
      const indexSrc = readFileSync(new URL('../lib/advisor/index.js', import.meta.url), 'utf8')
      assert.equal(indexSrc.includes('SESSIONLESS_SLOT'), false, '★S2 必须删掉 S1 的无会话过渡槽常量及其全部引用')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B13 兼容键不承载生效语义：config.advisorEnabled=true 不开启任何会话，且恰好一条 deprecated 告警', () => {
    const dir = tempDir('depr')
    try {
      const messages = []
      const { ctx } = ctxWithSessions(['sess-dep'])
      const installed = installAdvisor(ctx, { advisorEnabled: true, advisorProvider: 'gp', advisorModel: 'gm' }, {
        dataDir: dir,
        resolveLlm: () => fakeLlm('{"notes":[]}'),
        logger: { warn: (m) => messages.push(String(m)), error: (m) => messages.push(String(m)) },
      })
      const snap = installed.ctrl.snapshot('sess-dep')
      assert.equal(snap.enabled, false, '★全局 advisorEnabled=true 不得开启会话')
      assert.equal(snap.modelSource, 'unset', '全局 advisorProvider/advisorModel 也不得兜底')
      assert.equal(snap.provider, null)
      assert.equal(snap.model, null)
      const deprecations = messages.filter((m) => m.includes('已废弃'))
      assert.equal(deprecations.length, 1, `必须恰好一条 deprecated 告警（实得 ${deprecations.length}：${JSON.stringify(messages)}）`)
      assert.match(deprecations[0], /advisorEnabled/)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── 端点形状 ───────────────────────────────────────────────────────
  t('B6 GET：缺 sessionId / 空 sessionId → 400；带活跃 sessionId → 200', async () => {
    const dir = tempDir('b6')
    try {
      const { installed, handler } = boot(dir, ['s-b6'])
      const cases = [
        [ADVISOR_ENDPOINT, 400],
        [getUrl(''), 400],
        [getUrl('   '), 400],
      ]
      for (const [url, want] of cases) {
        const res = fakeRes()
        await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', url), res)
        assert.equal(res.statusCode, want, `${url} 应得 ${want}`)
      }
      const ok = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-b6')), ok)
      assert.equal(ok.statusCode, 200)
      assert.equal(ok.json().ok, true)
      assert.equal(ok.json().modelSource, 'unset')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B7 GET：req.url 为 undefined → 400（仅假宿主可构造，真机不可达，仍必须 fail-closed）', async () => {
    const dir = tempDir('b7')
    try {
      const { installed, handler } = boot(dir, ['s-b7'])
      // 注意：默认参数在「显式传 undefined」时会被替换，因此只能建好 req 再抹掉 url
      const req = fakeReq('GET')
      req.url = undefined
      const res = fakeRes()
      await handler(req, res)
      assert.equal(res.statusCode, 400)
      assert.match(res.json().error, /URL/)
      // 阳性对照：url 可读但没带 sessionId → 400（不同分支、同样 fail-closed）
      const res2 = fakeRes()
      await handler(fakeReq('GET'), res2)
      assert.equal(res2.statusCode, 400)
      assert.equal(typeof res2.json().error, 'string')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B8 PATCH：sessionId 缺 / 非串 / 空白 / 超 200 → 400 且零写盘', async () => {
    const dir = tempDir('b8')
    try {
      const { installed, handler } = boot(dir, ['s-b8'])
      const bodies = [
        { enabled: false },
        { sessionId: 42, enabled: false },
        { sessionId: '   ', enabled: false },
        { sessionId: 'x'.repeat(SESSION_ID_MAX + 1), enabled: false },
      ]
      for (const body of bodies) {
        const res = fakeRes()
        await handler(fakeReq('PATCH', body), res)
        assert.equal(res.statusCode, 400, `${JSON.stringify(body).slice(0, 40)} 应得 400`)
      }
      assert.equal(existsSync(sessionConfigPath(dir, 's-b8')), false, '形状非法不得留下任何文件')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B19/AC-06 路径形状：sessionId 含 / \\ .. → 400（形状层直拒，不依赖 base64url 兜底）', async () => {
    const dir = tempDir('b19')
    try {
      const { installed, handler } = boot(dir, ['s-b19'])
      for (const bad of ['a/b', 'a\\b', '..', '../etc', 'a/../b']) {
        // GET 与 PATCH 两条路径都要拒
        const g = fakeRes()
        await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl(bad)), g)
        assert.equal(g.statusCode, 400, `GET ?sessionId=${bad} 应得 400`)
        const p = fakeRes()
        await handler(fakeReq('PATCH', { sessionId: bad, enabled: false }), p)
        assert.equal(p.statusCode, 400, `PATCH sessionId=${bad} 应得 400`)
      }
      // 阳性对照：合法 id 仍然放行（否则本判据可能是空门）
      const ok = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-b19', enabled: false }), ok)
      assert.equal(ok.statusCode, 200)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B20/AC-07 同一校验函数：GET/PATCH/POST 三处 sessionId 形状校验走同一函数（源码级）', () => {
    const source = readFileSync(new URL('../lib/advisor/api.js', import.meta.url), 'utf8')
    const callSites = source
      .split('\n')
      .filter((line) => line.includes('normalizeSessionId(') && !line.includes('export function normalizeSessionId'))
    assert.equal(callSites.length, 3, `normalizeSessionId 必须恰好被三处引用（实得 ${callSites.length}：${JSON.stringify(callSites)}）`)
    // 阳性对照：该函数确实存在且真的会拒非法输入
    assert.equal(typeof normalizeSessionId, 'function')
    assert.throws(() => normalizeSessionId('..'), /路径分隔符/)
    assert.equal(normalizeSessionId(' ok '), 'ok')
  })

  // ── PATCH 落盘语义 ─────────────────────────────────────────────────
  t('B9/B10 PATCH：{sessionId,provider,model} → 200 且只落该会话文件；单给其一 → 400', async () => {
    const dir = tempDir('b9')
    try {
      const { installed, handler } = boot(dir, ['s-b9'])
      const ok = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-b9', provider: 'prov-a', model: 'm-a' }), ok)
      assert.equal(ok.statusCode, 200)
      assert.equal(ok.json().modelSource, 'session')
      assert.deepEqual(JSON.parse(readFileSync(sessionConfigPath(dir, 's-b9'), 'utf8')), {
        provider: 'prov-a', model: 'm-a',
      })
      // 另一个会话的文件**不得**被创建（端点不再有全局落点）
      assert.equal(existsSync(sessionConfigPath(dir, 'advisor-endpoint')), false, '不得复活 S1 的无会话过渡槽')
      const bad = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-b9', provider: 'only' }), bad)
      assert.equal(bad.statusCode, 400)
      assert.deepEqual(
        JSON.parse(readFileSync(sessionConfigPath(dir, 's-b9'), 'utf8')),
        { provider: 'prov-a', model: 'm-a' },
        '非法补丁不得改动已落盘内容',
      )
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B11/B12 U2 成对：{sessionId,enabled:true} 无模型 → 400 且零写盘；{sessionId,enabled:false} → 200', async () => {
    const dir = tempDir('b11')
    try {
      const { installed, handler } = boot(dir, ['s-b11'])
      const bad = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-b11', enabled: true }), bad)
      assert.equal(bad.statusCode, 400, '未配模型时不得开启')
      assert.equal(existsSync(sessionConfigPath(dir, 's-b11')), false, '失败补丁必须零写盘')
      const off = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-b11', enabled: false }), off)
      assert.equal(off.statusCode, 200, 'enabled:false 单键合法')
      assert.deepEqual(JSON.parse(readFileSync(sessionConfigPath(dir, 's-b11'), 'utf8')), { enabled: false })
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B4/B5 运行时随会话配置重建：改模型后 runtimeOf(sid).provider 漂移，两会话互不影响', () => {
    const dir = tempDir('b4')
    try {
      const { installed, ctx } = boot(dir, ['s-a', 's-b'])
      installed.ctrl.patchConfig('s-a', { enabled: true, provider: 'p1', model: 'm1' })
      installed.ctrl.patchConfig('s-b', { enabled: true, provider: 'q1', model: 'n1' })
      // 运行时由宿主 agent/created 事件建出（与真实链路同序：先有配置，后建运行时）
      ctx.emit('agent/created', { agent: fakeAgent('s-a') })
      ctx.emit('agent/created', { agent: fakeAgent('s-b') })
      const firstA = installed.ctrl.runtimeOf('s-a')
      assert.equal(firstA.provider, 'p1')
      assert.equal(installed.ctrl.runtimeOf('s-b').provider, 'q1')

      installed.ctrl.patchConfig('s-a', { provider: 'p2', model: 'm2', enabled: true })
      const secondA = installed.ctrl.runtimeOf('s-a')
      assert.equal(secondA.provider, 'p2', '★改配置必须重建该会话的运行时')
      assert.notEqual(secondA, firstA, '重建必须产生新实例')
      assert.equal(installed.ctrl.runtimeOf('s-b').provider, 'q1', '★B 会话不得被 A 的改动带偏')

      // 关掉 A 不影响 B
      installed.ctrl.patchConfig('s-a', { enabled: false })
      assert.equal(installed.ctrl.snapshot('s-a').enabled, false)
      assert.equal(installed.ctrl.snapshot('s-b').enabled, true)
      assert.equal(installed.ctrl.runtimeOf('s-a'), undefined)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B17/F-4 并发 PATCH：handler 级两条在途，终态绝不出现 enabled=true 而无 model', async () => {
    const dir = tempDir('b17')
    try {
      const { installed, handler } = boot(dir, ['s-b17'])
      const resA = fakeRes()
      const resB = fakeRes()
      // 两条都不 await，先各自跑到 await 点再交错汇合
      await Promise.all([
        handler(fakeReq('PATCH', { sessionId: 's-b17', provider: 'p', model: 'm' }), resA),
        handler(fakeReq('PATCH', { sessionId: 's-b17', enabled: true }), resB),
      ])
      assert.ok([200, 400].includes(resA.statusCode) && [200, 400].includes(resB.statusCode), '两条都只能 200 或 400')
      // ★先把微任务排空再读盘：否则「写盘被推迟到 await 之后」的变异体会让本用例
      //   读到「文件还没出现」而空过——空过的并发判据比没有判据更危险。
      await new Promise((r) => setImmediate(r))
      const path = sessionConfigPath(dir, 's-b17')
      if (!existsSync(path)) {
        // 两条都被拒 → 终态「什么都没写」同样自洽（U2 成对规则先于写盘生效）
        assert.equal(resA.statusCode, 400, '未写盘只允许两条都被拒（否则有写没落）')
        assert.equal(resB.statusCode, 400)
        installed.dispose()
        return
      }
      const final = JSON.parse(readFileSync(path, 'utf8'))
      assert.notEqual(
        final.enabled === true && (!final.provider || !final.model), true,
        `终态不得 enabled=true 而无 model（实得 ${JSON.stringify(final)}）`,
      )
      // 顺序敏感性：先模型后开启 → 应合并成 enabled+model 自洽状态
      const dir2 = tempDir('b17b')
      try {
        const h2 = boot(dir2, ['s-x'])
        const r1 = fakeRes(); const r2 = fakeRes()
        await h2.handler(fakeReq('PATCH', { sessionId: 's-x', provider: 'p', model: 'm' }), r1)
        await h2.handler(fakeReq('PATCH', { sessionId: 's-x', enabled: true }), r2)
        assert.equal(r2.statusCode, 200)
        assert.deepEqual(JSON.parse(readFileSync(sessionConfigPath(dir2, 's-x'), 'utf8')), {
          enabled: true, provider: 'p', model: 'm',
        })
        h2.installed.dispose()
      } finally { rmSync(dir2, { recursive: true, force: true }) }
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── 活跃校验（Q-1 / AC-20 / AC-21 / AC-22）─────────────────────────
  t('B14 活跃校验：agents.get 拿不到的 sessionId → GET/PATCH 均 404 且目标文件零变化', async () => {
    const dir = tempDir('b14')
    try {
      const { installed, handler } = boot(dir, ['s-live'])
      // ghost 会话先落一份既有配置：404 分支不得读它、更不得改它
      installed.ctrl.patchConfig('s-ghost', { enabled: true, provider: 'gp', model: 'gm' })
      const path = sessionConfigPath(dir, 's-ghost')
      const before = readFileSync(path, 'utf8')

      const g = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-ghost')), g)
      assert.equal(g.statusCode, 404)
      assert.equal(readFileSync(path, 'utf8'), before, 'GET 404 不得改动文件')

      const p = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-ghost', provider: 'hack', model: 'hack' }), p)
      assert.equal(p.statusCode, 404)
      assert.equal(readFileSync(path, 'utf8'), before, '★PATCH 404 必须是零写盘')

      // 阳性对照：活跃会话同一请求 200（否则本判据是空门）
      const ok = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-live', provider: 'p', model: 'm' }), ok)
      assert.equal(ok.statusCode, 200)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B18/AC-21/F-14 404 响应体零泄露：不含 catalog/records/runtime/provider/model 任一键，也不含他人配置与记录文本', async () => {
    const dir = tempDir('b18')
    try {
      const { installed, handler } = boot(dir, ['s-A'])
      installed.ctrl.patchConfig('s-A', { enabled: true, provider: 'secret-prov-A', model: 'secret-model-A' })
      const store = new AdvisorStore({ dataDir: dir })
      store.append({ sessionId: 's-A', severity: 'nit', text: 'secret-note-A', createdAt: 10, outcome: 'recorded' })
      store.append({ sessionId: 's-A', severity: 'concern', text: 'secret-note-B', createdAt: 11, outcome: 'recorded' })

      const res = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-missing')), res)
      assert.equal(res.statusCode, 404)
      const body = res.bodyText
      for (const key of ['catalog', 'records', 'runtime', 'provider', 'model']) {
        assert.equal(body.includes(key), false, `404 响应体不得含 "${key}" 键（实得 ${body}）`)
      }
      for (const leak of ['secret-prov-A', 'secret-model-A', 'secret-note-A', 'secret-note-B']) {
        assert.equal(body.includes(leak), false, `404 响应体不得泄露 ${leak}`)
      }
      // 阳性对照：真正活跃的会话 GET 是完整载荷（含那几键）——否则上面的「不含」是空门
      const ok = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-A')), ok)
      assert.equal(ok.statusCode, 200)
      for (const key of ['catalog', 'records', 'runtime', 'provider', 'model']) {
        assert.equal(ok.bodyText.includes(`"${key}"`), true, `200 载荷应含 "${key}"`)
      }
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B15/Q-5 records 按会话过滤：GET ?sessionId=s1 只返回 s1 的记录', async () => {
    const dir = tempDir('b15')
    try {
      const { installed, handler } = boot(dir, ['s1', 's2'])
      const store = new AdvisorStore({ dataDir: dir })
      store.append({ sessionId: 's1', severity: 'nit', text: 'note-s1', createdAt: 10, outcome: 'recorded' })
      store.append({ sessionId: 's2', severity: 'nit', text: 'note-s2', createdAt: 20, outcome: 'recorded' })

      const r1 = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s1')), r1)
      const b1 = r1.json()
      assert.deepEqual(b1.records.map((r) => r.text), ['note-s1'], '★s1 只能看到自己的记录')

      const r2 = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s2')), r2)
      assert.deepEqual(r2.json().records.map((r) => r.text), ['note-s2'])

      // ★过滤必须在**截断之前**：若实现写成「先按 persistLimit 截断再过滤」，
      //   在 persistLimit 条被别的会话占满时就会把本会话的记录挤成空数组
      //   ——只断言「s1 只含 s1」的那条对该缺陷完全无感（critic 的 C11 实测 130/0）。
      //   这里把 persistLimit 压到 1、且让**别的会话**占掉那唯一的名额。
      const tight = new AdvisorStore({ dataDir: dir, persistLimit: 1 })
      assert.equal(tight.list('s1', 1).length, 1, '★persistLimit=1 且名额被 s2 占满时，s1 仍必须拿到自己那条')
      assert.deepEqual(tight.list('s1', 1).map((r) => r.text), ['note-s1'])
      // 阳性对照：不做会话过滤时同样返回 1 条（说明上条不是「恰好也过」）
      assert.equal(tight.list(undefined, 1).length, 1, '不过滤时只返回最近 1 条（对照组）')
      assert.deepEqual(tight.list(undefined, 1).map((r) => r.text), ['note-s2'], '对照组拿到的是最近那条 s2')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B16/Q-3 POST：对 ghost → 200+no-session 且零模型调用；对「存在但未配模型」→ 200+unset', async () => {
    const dir = tempDir('b16')
    try {
      const llm = fakeLlm('{"notes":[]}')
      const { installed, handler } = boot(dir, ['s-live'], { llm })
      const ghost = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 'ghost' }), ghost)
      assert.equal(ghost.statusCode, 200, 'POST 契约恒 200')
      assert.deepEqual(ghost.json(), { ok: false, reason: 'no-session' })
      assert.equal(llm.calls.length, 0, '★活跃校验失败不得消耗额度')

      const unset = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 's-live' }), unset)
      assert.equal(unset.statusCode, 200)
      assert.deepEqual(unset.json(), { ok: false, reason: 'unset' })
      assert.equal(llm.calls.length, 0)

      // 配了模型但未开启 → disabled（与 unset 区分开）
      installed.ctrl.patchConfig('s-live', { provider: 'p', model: 'm' })
      const off = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 's-live' }), off)
      assert.deepEqual(off.json(), { ok: false, reason: 'disabled' })

      // POST 的 sessionId 也走同一形状校验
      const bad = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 'a/b' }), bad)
      assert.equal(bad.statusCode, 400)
      const missing = fakeRes()
      await handler(fakeReq('POST', { action: 'review' }), missing)
      assert.equal(missing.statusCode, 400)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('B21/AC-20 ctx.agents 三态（缺失 / 无 get / get 抛错）全部 fail-closed 且零写盘', async () => {
    for (const [label, agents] of [
      ['agents 缺失', undefined],
      ['agents 无 get', {}],
      ['agents.get 抛错', { get: () => { throw new Error('boom') } }],
    ]) {
      const dir = tempDir('b21')
      try {
        const ctx = bareCtx(agents)
        ctx.on = () => () => {}
        const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => fakeLlm('{"notes":[]}') })
        const handler = createAdvisorHandler({ ctrl: installed.ctrl, loadCatalog: async () => ({}) })
        const g = fakeRes()
        await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-x')), g)
        assert.ok([400, 404].includes(g.statusCode), `${label}：GET 必须 fail-closed（实得 ${g.statusCode}）`)
        const p = fakeRes()
        await handler(fakeReq('PATCH', { sessionId: 's-x', provider: 'p', model: 'm' }), p)
        assert.ok([400, 404].includes(p.statusCode), `${label}：PATCH 必须 fail-closed（实得 ${p.statusCode}）`)
        assert.equal(existsSync(sessionConfigPath(dir, 's-x')), false, `${label}：必须零写盘`)
        const post = fakeRes()
        await handler(fakeReq('POST', { action: 'review', sessionId: 's-x' }), post)
        assert.equal(post.statusCode, 200)
        assert.deepEqual(post.json(), { ok: false, reason: 'no-session' })
        installed.dispose()
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  t('B22/AC-22 残余风险固化：同回环来源 + 有效活跃 sessionId 的请求**被接受**（断言 200，不是断言被拒绝）', async () => {
    const dir = tempDir('b22')
    try {
      const { installed, handler } = boot(dir, ['s-owner'])
      const g = fakeRes()
      await handler(fakeReq('GET', undefined, '127.0.0.1', null, '127.0.0.1:3080', getUrl('s-owner')), g)
      assert.equal(g.statusCode, 200, '宿主无鉴权钩子：同回环来源对活跃会话的请求就是会被接受')
      const p = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-owner', provider: 'p', model: 'm' }), p)
      assert.equal(p.statusCode, 200)
      assert.equal(installed.ctrl.snapshot('s-owner').model, 'm')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // P1-1 必修：runtime 字段曾是一份**全局**镜像，A 的评审失败会污染从未评审的 B。
  t('P1-1 runtime 状态按会话隔离：A 的评审错误不得出现在从未评审的 B 上', async () => {
    const dir = tempDir('p11')
    try {
      // 输出不是严格 JSON → runtime 走 status=error 分支（A 侧真失败，非构造）
      const handlers = new Map()
      const messages = [msg('user', '请写代码'), msg('assistant', '好的')]
      const events = [{ type: 'step/start', data: { turn: 't1' } }]
      const turnEnd = { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } }
      // ownEvents 必须返回**完整事件日志**（含 turn/end）：观察器用
      // findLastMessageTurnEnd(events) 反查「最新进入过 step 的 turn/end」，
      // 日志里缺 turn/end 就直接 return，一个 delta 都不会产出。
      const agentA = fakeAgent('s-A')
      agentA.session = { id: 's-A', deriveMessages: () => messages, ownEvents: () => [...events, turnEnd] }
      const agentB = fakeAgent('s-B')
      agentB.session = { id: 's-B', deriveMessages: () => messages, ownEvents: () => [] }
      const registry = { 's-A': agentA, 's-B': agentB }
      const ctx = bareCtx({ get: (id) => registry[id] })
      ctx.on = (event, fn) => {
        const list = handlers.get(event) ?? []
        list.push(fn)
        handlers.set(event, list)
        return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn))
      }
      ctx.emit = (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) }

      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => fakeLlm('这不是 JSON') })
      installed.ctrl.patchConfig('s-A', { enabled: true, provider: 'p', model: 'm' })
      ctx.emit('agent/created', { agent: agentA })
      ctx.emit('session/event', agentA.session, turnEnd)
      await installed.ctrl.runtimeOf('s-A')?.waitForDrain()

      // 阳性对照：A 确实进入了 error 状态且带上了时间戳（否则本用例测不到东西）
      const a = installed.ctrl.snapshot('s-A').runtime
      assert.equal(a.status, 'error', 'A 的评审必须真的失败（阳性对照）')
      assert.ok(a.lastAt > 0, `A 必须有 lastAt（实得 ${a.lastAt}）`)
      assert.ok(String(a.error).length > 0, 'A 必须带错误说明')

      // ★B 从未评审过：不得带 A 的 error / lastAt
      //   B 未开启 → disabled 口径；再把 B 配成「已开启但一次没评审」，
      //   那它必须回到 idle 初值——两条读数都不许出现 A 的错误与时间戳。
      const bOff = installed.ctrl.snapshot('s-B').runtime
      assert.equal(bOff.status, 'disabled', 'B 未开启时读数是 disabled')
      assert.equal(bOff.lastAt, 0, '★B 不得带 A 的 lastAt')
      assert.equal(bOff.error, null, `★B 不得带 A 的错误说明（实得 ${JSON.stringify(bOff.error)}）`)

      installed.ctrl.patchConfig('s-B', { enabled: true, provider: 'p2', model: 'm2' })
      const bOn = installed.ctrl.snapshot('s-B').runtime
      assert.equal(bOn.status, 'idle', `★B 已开启但从未评审，必须是初值 idle（实得 ${bOn.status}）`)
      assert.equal(bOn.lastAt, 0, '★B 不得带 A 的 lastAt')
      assert.equal(bOn.error, null, `★B 不得带 A 的错误说明（实得 ${JSON.stringify(bOn.error)}）`)
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

// ── 8. 真实用户数据目录隔离门（必须注册在 run.mjs 的最后）─────────────────

export function testRealDataDirIsolation(t) {
  t('隔离门：整个套件运行期间真实用户 advisor 数据目录逐字节零变化', () => {
    const after = snapshotTree(DEFAULT_ADVISOR_DATA_DIR)
    assert.deepEqual(
      after, REAL_DATA_DIR_BASELINE,
      `跑测试绝不允许触碰真实用户数据目录 ${DEFAULT_ADVISOR_DATA_DIR}\n`
      + `加载时基线：${JSON.stringify(REAL_DATA_DIR_BASELINE, null, 2)}\n`
      + `运行后实况：${JSON.stringify(after, null, 2)}`,
    )
  })

  // 阳性对照：snapshotTree 必须真的看得见「增 / 删 / 改」，否则上面那条是空门。
  t('隔离门自检：snapshotTree 看得见目录结构与内容变化（否则上一条是空门）', () => {
    const dir = tempDir('snapgate')
    try {
      assert.deepEqual(snapshotTree(join(dir, 'nope')), ['<absent>'], '不存在的目录必须如实报缺席')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'a.txt'), 'one')
      const first = snapshotTree(dir)
      assert.deepEqual(first.map((line) => line.split(' ')[0]), ['a.txt', 'sub/'], `结构必须被看见（实得 ${JSON.stringify(first)}）`)
      writeFileSync(join(dir, 'a.txt'), 'two')
      const second = snapshotTree(dir)
      assert.notDeepEqual(second, first, '内容变化（SHA256）必须被看见')
      rmSync(join(dir, 'a.txt'))
      assert.deepEqual(snapshotTree(dir), ['sub/'], '删除也必须被看见')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}