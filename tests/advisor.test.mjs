/**
 * advisor 服务端测试（桩宿主：fake ctx / fake session / fake agent / fake llm）。
 *
 * 覆盖四层：
 *  1. **配置校验**（resolveAdvisorConfig）+ **模型回落链**（resolveAdvisorModel）：
 *     配置优先 → HIGH 档 → error 三态，`modelSource` 语义；
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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveAdvisorConfig, resolveAdvisorModel, installAdvisor, ADVISOR_ENDPOINT,
  resolveAdvisorDataDir, DEFAULT_ADVISOR_DATA_DIR, ADVISOR_DATA_DIR_ENV, ADVISOR_TRACE_ENV,
} from '../lib/advisor/index.js'
import { AdvisorObserver, isRewriteEvent, isReviewableTurnEnd, isHumanInputEvent, findLastMessageTurnEnd, renderVisibleSurface } from '../lib/advisor/observer.js'
import { AdvisorRuntime, parseReviewOutput, AdvisorConversation } from '../lib/advisor/runtime.js'
import { AdvisorDelivery, buildAdvisorMessage, isAdvisorMessage } from '../lib/advisor/delivery.js'
import { AdvisorStore, normalizeRecord } from '../lib/advisor/store.js'
import { createAdvisorHandler, normalizeAdvisorPatch } from '../lib/advisor/api.js'

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

  t('配置：非法形状大声抛错（未知键 / 单给 provider / 负数 / 超长提示词 / 未知等级）', () => {
    assert.throws(() => resolveAdvisorConfig({ advisorFoo: 1 }), /未知 advisor 配置键/)
    assert.doesNotThrow(() => resolveAdvisorConfig({ tiers: {}, clarifyMode: 'interactive' }), '非 advisor 键不得被当成 advisor 配置校验')
    assert.throws(() => resolveAdvisorConfig({ advisorProvider: 'p' }), /成对/)
    assert.throws(() => resolveAdvisorConfig({ advisorModel: 'm' }), /成对/)
    assert.throws(() => resolveAdvisorConfig({ advisorMaxQueued: -1 }), /非负整数/)
    assert.throws(() => resolveAdvisorConfig({ advisorMaxMessages: 1.5 }), /非负整数/)
    assert.throws(() => resolveAdvisorConfig({ advisorSystemPrompt: 'x'.repeat(9 * 1024) }), /上限/)
    assert.throws(() => resolveAdvisorConfig({ advisorSteerSeverities: ['ultra'] }), /未知等级/)
    assert.throws(() => resolveAdvisorConfig({ advisorSteerSeverities: 'nit' }), /必须是数组/)
    assert.throws(() => resolveAdvisorConfig({ advisorProvider: '', advisorModel: 'm' }), /空字符串/)
  })

  t('模型回落：配置优先 → HIGH 档 → error 三态', () => {
    const configured = resolveAdvisorConfig({ advisorProvider: 'prov-a', advisorModel: 'm-a' })
    const r1 = resolveAdvisorModel(configured, () => ({ HIGH: { provider: 'h', model: 'hm' } }))
    assert.deepEqual([r1.provider, r1.model, r1.modelSource], ['prov-a', 'm-a', 'config'])
    // 任一为空 → 回落 HIGH
    const partial = { ...configured, advisorModel: null }
    const r2 = resolveAdvisorModel(partial, () => ({ HIGH: { provider: 'h', model: 'hm' } }))
    assert.deepEqual([r2.provider, r2.model, r2.modelSource], ['h', 'hm', 'HIGH'])
    // HIGH 拿不到 → error（此时必须**未配** advisorProvider/advisorModel）
    const unconfigured = resolveAdvisorConfig({})
    const r3 = resolveAdvisorModel(unconfigured, () => ({}))
    assert.equal(r3.modelSource, null)
    assert.match(r3.reason, /HIGH/)
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
      delete process.env[ADVISOR_DATA_DIR_ENV]
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
      const installed = installAdvisor(ctx, { advisorEnabled: true }, {
        dataDir: dir,
        resolveLlm: () => llm,
        tierTableOf: () => ({ HIGH: { provider: 'h', model: 'hm' } }),
      })
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
      const installed = installAdvisor(ctx, { advisorEnabled: true }, {
        dataDir: dir,
        resolveLlm: () => llm,
        tierTableOf: () => ({ HIGH: { provider: 'h', model: 'hm' } }),
        trace: explodingTrace,
      })
      emit('agent/created', { agent })
      emit('session/event', agent.session, turnEnd)
      await installed.ctrl.runtimeOf('sess-fo')?.waitForDrain()

      assert.ok(traceCalls > 0, 'trace 钩子确实被调用过（否则本用例测不到东西）')
      const snap = installed.ctrl.snapshot()
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

  t('存储：config.json 读写（PATCH 落盘面）', () => {
    const dir = tempDir('cfg')
    try {
      const store = new AdvisorStore({ dataDir: dir, persistLimit: 10 })
      assert.deepEqual(store.readConfig(), {})
      store.writeConfig({ enabled: true, provider: 'p', model: 'm' })
      const read = store.readConfig()
      assert.equal(read.enabled, true)
      assert.equal(read.provider, 'p')
      store.writeConfig({ enabled: false })
      assert.equal(store.readConfig().enabled, false)
      assert.equal(store.readConfig().provider, 'p', '部分更新保留既有键')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('端点 PATCH 形状校验：未知键 / 空串 / 单给其一 → 抛错；合法放行', () => {
    assert.throws(() => normalizeAdvisorPatch({}), /至少一个键/)
    assert.throws(() => normalizeAdvisorPatch({ nope: 1 }), /未知键/)
    assert.throws(() => normalizeAdvisorPatch({ provider: 'p' }), /成对/)
    assert.throws(() => normalizeAdvisorPatch({ model: 'm' }), /成对/)
    assert.throws(() => normalizeAdvisorPatch({ provider: '', model: 'm' }), /空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ provider: 'p', model: '' }), /空字符串/)
    assert.throws(() => normalizeAdvisorPatch({ enabled: 'yes' }), /布尔/)
    assert.deepEqual(normalizeAdvisorPatch({ enabled: true }), { enabled: true })
    assert.deepEqual(normalizeAdvisorPatch({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  })

  t('端点：GET/PATCH/POST 走真实 handler（回环+Origin+形状）', async () => {
    const dir = tempDir('api')
    try {
      const model = { advisorProvider: 'p', advisorModel: 'm', advisorEnabled: true }
      const { ctx } = fakeCtx()
      const installed = installAdvisor(ctx, model, {
        dataDir: dir,
        resolveLlm: () => fakeLlm('{"notes":[]}'),
        tierTableOf: () => ({ HIGH: { provider: 'h', model: 'hm' } }),
      })
      const handler = createAdvisorHandler({ ctrl: installed.ctrl, loadCatalog: async () => ({ p: ['m'] }) })

      // GET
      const res1 = fakeRes()
      await handler(fakeReq('GET'), res1)
      assert.equal(res1.statusCode, 200)
      const b1 = res1.json()
      assert.equal(b1.ok, true)
      assert.equal(b1.modelSource, 'config')
      assert.deepEqual(b1.catalog, { p: ['m'] })
      assert.ok(Array.isArray(b1.records))
      assert.ok(['idle', 'reviewing', 'disabled', 'error'].includes(b1.runtime.status))

      // PATCH 改 provider/model → modelSource=config，仍 200
      const res2 = fakeRes()
      await handler(fakeReq('PATCH', { provider: 'p2', model: 'm2' }), res2)
      assert.equal(res2.statusCode, 200)
      assert.equal(res2.json().modelSource, 'config')

      // PATCH 非法 → 400
      const res3 = fakeRes()
      await handler(fakeReq('PATCH', { provider: 'only' }), res3)
      assert.equal(res3.statusCode, 400)

      // POST review（无 agent → no-session，恒 200）
      const res4 = fakeRes()
      await handler(fakeReq('POST', { action: 'review', sessionId: 'ghost' }), res4)
      assert.equal(res4.statusCode, 200)
      assert.equal(res4.json().ok, false)
      assert.ok(['disabled', 'busy', 'no-session'].includes(res4.json().reason))

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
      const installed = installAdvisor(ctx, { advisorEnabled: true }, {
        dataDir: dir,
        resolveLlm: () => llm,
        tierTableOf: () => ({ HIGH: { provider: 'h', model: 'hm' } }),
      })
      // 发 agent/created（登记 agent + 建运行时）
      emit('agent/created', { agent })
      // 推一个可评审的 turn/end（step → turn/end）
      emit('session/event', agent.session, events[1])
      // 等评审排空
      await installed.ctrl.runtimeOf('sess-1')?.waitForDrain()
      // steer 被调用（第一轮不在冷却）
      assert.equal(agent.calls.steer.length, 1, 'concern ∈ steerSeverities 且首次投递应 steer')
      assert.equal(agent.calls.steer[0].source.kind, 'advisor')
      // 记录落盘
      const records = installed.ctrl.snapshot().records
      assert.equal(records.length, 1)
      assert.equal(records[0].text, '请补充测试')
      assert.equal(records[0].outcome, 'steer')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('集成：默认关（advisorEnabled=false）时不建运行时、不调模型', async () => {
    const dir = tempDir('off')
    try {
      const agent = fakeAgent('sess-off')
      const llm = fakeLlm('{"notes":[{"severity":"blocker","text":"X"}]}')
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => llm, tierTableOf: () => ({ HIGH: { provider: 'h', model: 'hm' } }) })
      emit('agent/created', { agent })
      emit('session/event', agent.session, {
        type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } },
      })
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(llm.calls.length, 0, '默认关不得发起模型调用')
      const snap = installed.ctrl.snapshot()
      assert.equal(snap.enabled, false)
      assert.equal(snap.runtime.status, 'disabled')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('集成：HIGH 档回落——双空配置时 modelSource=HIGH', () => {
    const dir = tempDir('fallback')
    try {
      const { ctx } = fakeCtx()
      const installed = installAdvisor(ctx, { advisorEnabled: true }, {
        dataDir: dir,
        resolveLlm: () => fakeLlm('{"notes":[]}'),
        tierTableOf: () => ({ HIGH: { provider: 'high-prov', model: 'high-model' } }),
      })
      const snap = installed.ctrl.snapshot()
      assert.equal(snap.modelSource, 'HIGH')
      assert.equal(snap.provider, 'high-prov')
      assert.equal(snap.model, 'high-model')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

// ── HTTP 桩（照抄 run.mjs 的 fakeReq/fakeRes） ───────────────────────────

function fakeReq(method, body, remote = '127.0.0.1', origin = null, host = '127.0.0.1:3080') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const headers = { host }
  if (origin) headers.origin = origin
  return {
    method,
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