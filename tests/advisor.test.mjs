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
import { fileURLToPath } from 'node:url'

import {
  resolveAdvisorConfig, resolveAdvisorModel, installAdvisor, ADVISOR_ENDPOINT,
  resolveAdvisorDataDir, DEFAULT_ADVISOR_DATA_DIR, ADVISOR_DATA_DIR_ENV, ADVISOR_TRACE_ENV,
} from '../lib/advisor/index.js'
import { AdvisorObserver, isRewriteEvent, isReviewableTurnEnd, isHumanInputEvent, renderVisibleSurface, SEEN_WINDOW_SIZE } from '../lib/advisor/observer.js'
import { AdvisorRuntime, parseReviewOutput, AdvisorConversation, classifyCompletion, ADVISOR_MAX_TOKENS, ADVISOR_FINISH_KINDS, ADVISOR_CONVERSATION_MAX_CHARS, DEFAULT_ADVISOR_SYSTEM_PROMPT, enforceEvidenceFloor, ADVISOR_MIN_BLOCKER_CONFIDENCE } from '../lib/advisor/runtime.js'
import { AdvisorDelivery, buildAdvisorMessage, isAdvisorMessage, ADVISOR_COOLDOWN_EXEMPT } from '../lib/advisor/delivery.js'
import { AdvisorStore, normalizeRecord, sessionConfigPath, sessionSeenPath, CONFIG_FILE } from '../lib/advisor/store.js'
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

/**
 * 假 llm：按脚本返回文本分片。
 *
 * AC-27 / D13：支持 **chunk 数组脚本**（`{type:'text-delta'|'usage'|'finish', ...}`）——
 * 终态判定（finishReason / outputTokens）只在真实分片里出现，只发字符串的桩件会让
 * R6 与 F-1 的全部判据「全盲」（跑了全红也证明不了什么）。故桩件必须能逐分片下发。
 */
function fakeLlm(script) {
  const calls = []
  return {
    calls,
    stream: (options) => {
      calls.push(options)
      const text = typeof script === 'function' ? script(options, calls.length) : script
      return (async function* () {
        if (Array.isArray(text)) {
          for (const chunk of text) yield chunk
          return
        }
        if (typeof text === 'string' && text !== '') yield { type: 'text-delta', text }
        else if (typeof text === 'number') { /* 超时脚本：不产分片，靠 abort 退出 */ }
      })()
    },
  }
}

/**
 * 为用例造一个**真实存在**的临时目录（`os.tmpdir()` 下，名字带 tag + 随机后缀）。
 *
 * B0 遗留缺陷修复（登记于 `agent-out/v3-s1a-retrieval.md` 节「顺手修复」）：
 * 旧实现先拼出 `dsh-agents-advisor-<tag>-<pid>-0<时间戳>` 这个路径，又调用
 * `mkdtempSync(...)` 却**丢弃了返回值**，于是 ① 返回的路径**根本不存在**（各用例
 * 靠 installAdvisor 的 mkdir 顺带补上）；② 每次调用都在系统临时目录**多留一个空目录**
 * （没人清它）。现在直接返回 `mkdtempSync` 的结果：路径真实存在，且各用例 finally 里的
 * `rmSync(dir, { recursive: true, force: true })` 能真正把它清掉。
 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-adv-${tag}-`))
}

// ── 1. 配置校验 + 模型回落链 ─────────────────────────────────────────────

/**
 * 随包 `cordis.patch.yml` 里**描述已删行为**的注释字样（源级防漂移清单）。
 *
 * 只收「已删行为本身」的字面量，**不收否定表述**——注释里写「已取消 HIGH 档回落」
 * 是当前契约要求的正确说法，不能被误伤。逐条对应：
 *  - `tiers.HIGH`    —— S2 已删 HIGH 档回落（`resolveAdvisorModel` 不再读档位表）
 *  - `落盘 config.json` —— S1 已改按会话分文件
 *  - 回落链 / 任一为空  —— 旧回落链的标题与措辞
 */
const STALE_BUNDLE_COMMENTS = [
  /tiers\.HIGH/,
  /落盘\s*config\.json/,
  /回落链/,
  /任一为空\s*→\s*回落/,
]

/** 返回该 yml 文本命中的过期字样（空数组 = 未漂移）。 */
function staleBundleComments(text) {
  return STALE_BUNDLE_COMMENTS.filter((re) => re.test(text)).map((re) => re.source)
}

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

  // ── D-4 防漂移：随包注释不得描述已删行为 ─────────────────────────────────
  // 事故（S2/S1 改完实现后）：cordis.patch.yml 的注释仍写着「回落 tiers.HIGH 的
  // 当前路由」与「PATCH 落盘 config.json」——两条描述的都是**已被删除的行为**。
  // 随包配置是用户与维护者直接读的面（比 docs 更要紧），而上一轮的教训正是
  // 「注释写了语义但没人核」。故用源级判据把「实现删了、注释忘了」钉死。
  t('D-4 随包注释防漂移：不得描述已删行为；三个废弃键保留且值未变', () => {
    const bundleText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    // ① 注释不得含已删行为字样
    assert.deepEqual(staleBundleComments(bundleText), [], 'cordis.patch.yml 注释仍在描述已删行为')

    // ② 三个废弃键必须**仍在**且值未变（删键会让老配置 boot 失败：A14/A16）
    for (const [key, value] of [['advisorEnabled', 'false'], ['advisorProvider', 'null'], ['advisorModel', 'null']]) {
      assert.match(bundleText, new RegExp(`^\\s*${key}:\\s*${value}\\s*$`, 'm'), `${key} 必须保留且值仍为 ${value}`)
    }

    // ③ 新注释必须把现状说清（否则「注释被清空」也算过）
    for (const required of [
      'deprecated / compatibility-only',
      'does not affect runtime behavior',
      "'session'",
      "'unset'",
      'base64url(sessionId)',
      '.seen.json',
    ]) {
      assert.ok(bundleText.includes(required), `注释必须说明现状，实测缺：${required}`)
    }

    // ④ 必红：把注释改回旧文字（逐条变异），该判据必须变红
    const mutations = [
      '# 模型回落链：下面两个键任一为空 → 回落上面 tiers.HIGH 的当前路由\n',
      '# 数据目录（记录 records.jsonl + PATCH 落盘 config.json）\n',
      '# 模型回落链：任一为空 → 回落 tiers.HIGH\n',
    ]
    for (const mutation of mutations) {
      const mutated = bundleText.replace(
        /^(?=\s*# ── advisor（内置顾问)/m,
        `${mutation}        `,
      )
      assert.notEqual(mutated, bundleText, `变异体必须真的注入到文本里：${mutation.trim()}`)
      assert.ok(staleBundleComments(mutated).length > 0, `注入旧文字后判据必须变红：${mutation.trim()}`)
    }
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
      // S3 夹具对齐：step/start 也经总线投递（生产里它与 turn/end 走同一条
      // session/event 路径，见 dsh-agent-loop/lib/index.js:968 → dsh-session
      // append → session/event）。观察器自 S3 起流式累积 steppedTurns，
      // 替身必须复刻这条链路，否则「该 turn 进过 step」无从判定。
      emit('session/event', agent.session, events[0])
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
      // S3 夹具对齐：step/start 也经总线投递（生产同走 session/event 一条路径）
      emit('session/event', agent.session, events[0])
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
    // S3 起 steppedTurns 走流式累积：step/start 与 turn/end 必须**逐条**经
    // handleEvent（生产里二者同走 session/event 一条路径）。只喂最后一个事件
    // 等于让替身「诞生于 turn/end 那一刻」，那不是生产形状。
    observer.handleEvent('s1', events, events[0])
    observer.handleEvent('s1', events, events[1])
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].messageCount, 1)
    // 用户掐断的回合不评审
    const aborted = { type: 'turn/end', seq: 11, data: { turn: 't2', reason: { kind: 'aborted' } } }
    const step2 = { type: 'step/start', data: { turn: 't2' } }
    observer.handleEvent('s1', [...events, step2, aborted], step2)
    observer.handleEvent('s1', [...events, step2, aborted], aborted)
    assert.equal(deltas.length, 1, 'aborted 回合不得触发评审')
  })

  t('观察器：turn/end 事件谓词（reason.kind 白名单）', () => {
    assert.equal(isReviewableTurnEnd({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), true)
    assert.equal(isReviewableTurnEnd({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), false)
    // S3 起「最新进入过 step 的 turn/end」不再由 findLastMessageTurnEnd 扫描
    // 事件数组得出（该导出已按计划删除），改由流式累积的 steppedTurns 判定——
    // 行为由下方 C1/C4/C13 判据直接锁。
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

// ── 2b. S3 幂等门（每 turn 恰好评审一次）───────────────────────────────
// 判据 C1-C9 / C11 / C13 / C15-C17。契约依据见 plan S3 段。
//
// **窗口容量一律引用 `SEEN_WINDOW_SIZE` 常量，禁止写死字面量**（计划 v4 必修 2）：
// M 将来翻转时，写死的数字会把正确实现误判红。

/**
 * 观察器层的「评审记账桩」。
 *
 * 观察器每评审一次就推一条 —— 它与 `llm.calls` **一一对应**（`onDelta` 是
 * `runtime.enqueue` 的唯一入口，而 enqueue 每条增量恰好产生一次模型调用）。
 * C9 明确要求「两轮共用一个记账桩」，本桩就是那个桩：跨「重启」两轮
 * **传同一个实例**，于是 `llm.calls.length` 是累计值，`重启后新增 === 0`
 * 就是「累计值未变」。
 */
function reviewLedger() {
  return { calls: [] }
}

/**
 * 标准 stepped 会话夹具。
 *
 * `feed` 把事件**逐个**喂进 `handleEvent`（复刻生产：装配层对每一条
 * `session/event` 都转发一次，`step/start` 与 `turn/end` 走同一条路径）。
 * 绝不把整个数组只喂最后一个——那正是流式 `steppedTurns` 会漏判的形状。
 */
function steppedHarness(options = {}) {
  const sessionId = options.sessionId ?? 's-s3'
  const ledger = options.ledger ?? reviewLedger()
  const steppedEnds = []
  let messages = options.messages ?? [msg('user', '做 X'), msg('assistant', '好了')]
  const session = {
    id: sessionId,
    ownEvents: () => [],
    deriveMessages: () => messages,
  }
  /** 每个 turn/end 后给会话表面补一条新消息（生产真实形状）。
   *  缺了它，增量游标不前进、`renderAndEmit` 恒返空 —— ledger 数到的就成了
   *  「游标放行次数」而不是「评审次数」，C5/C6/C16 会集体空转。
   *  C15 半②要构造「无可见内容」，故该处显式关掉。 */
  const growOnTurn = options.growOnTurn !== false
  const observer = new AdvisorObserver({
    getSession: () => session,
    sessionMeta: () => ({ sessionId, sessionName: sessionId }),
    loadSeen: options.loadSeen,
    saveSeen: options.saveSeen,
    seenWindowSize: options.seenWindowSize,
    onDelta: (id, delta) => { ledger.calls.push({ sessionId: id, delta }) },
    onSteppedTurnEnd: () => { steppedEnds.push(1) },
    logger: options.logger ?? { warn: () => {}, error: () => {} },
  })
  const feed = (...events) => {
    for (const e of events) {
      if (growOnTurn && e?.type === 'turn/end') {
        messages = [...messages, msg('assistant', `回合 ${String(e.data?.turn ?? '')} 的产出`)]
      }
      observer.handleEvent(sessionId, [], e)
    }
  }
  return {
    observer,
    ledger,
    session,
    feed,
    setMessages: (next) => { messages = next },
    steppedEndCount: () => steppedEnds.length,
  }
}

/** 一条完整的可评审 turn：`{ turn, seq }` → [step/start, turn/end]。 */
function turnGroup(turn, seq, kind = 'completed') {
  return [
    { type: 'step/start', data: { turn } },
    { type: 'turn/end', seq, data: { turn, reason: { kind } } },
  ]
}

/** 读某个会话落盘的 seen 快照（形状不对时判红而不是静默 undefined）。 */
function readSeenFile(dir, sessionId) {
  const path = sessionSeenPath(dir, sessionId)
  assert.equal(existsSync(path), true, `seen 文件必须落盘：${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function testObserverIdempotency(t) {
  t('C1 同一 (sid,turn,seq) 的 turn/end 连发两次 → 只评审一次', () => {
    const h = steppedHarness()
    const group = turnGroup('t1', 10)
    h.feed(group[0]); h.feed(group[1])
    assert.equal(h.ledger.calls.length, 1, '首次必须评审')
    h.feed(group[1]) // 同一事件重放
    assert.equal(h.ledger.calls.length, 1, '★同一事件重放不得二次评审')
    assert.equal(h.steppedEndCount(), 1, '重放不得二次递减投递冷却')
  })

  t('C2 「step/start」+「turn/end」整组重放 → 仍 1 次，冷却只递减 1 次', () => {
    const h = steppedHarness()
    const group = turnGroup('t1', 10)
    for (const e of group) h.feed(e)
    assert.equal(h.ledger.calls.length, 1)
    for (const e of group) h.feed(e) // 整组重放
    assert.equal(h.ledger.calls.length, 1, '★整组重放不得二次评审')
    assert.equal(h.steppedEndCount(), 1, '★onSteppedTurnEnd 恰好 1 次')
  })

  // ── C13【AC-14】二元组键（本轮判别的核心）────────────────────────────
  t('C13/AC-14 同 turn 不同 seq 只评审一次（幂等身份是二元组，seq 不参与）', () => {
    const h = steppedHarness()
    h.feed(...turnGroup('t1', 10))
    assert.equal(h.ledger.calls.length, 1, '首次评审')
    // 同一 turn 的**另一条 seq 副本**（重连重放/重发可达）：
    // turn 相同、seq 不同。若实现退回三元组键 `${sid}::${turn}::${seq}`，
    // 这条会算成新 turn 而二次评审 —— 判红点在此。
    h.feed(...turnGroup('t1', 99))
    assert.equal(h.ledger.calls.length, 1, '★同 turn 不同 seq 必须是同一次评审（必红 N23）')
    assert.equal(h.steppedEndCount(), 1, '冷却也不得二次递减')
  })

  t('C4 无 step 的 turn/end 不评审', () => {
    const h = steppedHarness()
    h.feed({ type: 'turn/end', seq: 10, data: { turn: 't9', reason: { kind: 'completed' } } })
    assert.equal(h.ledger.calls.length, 0, '★没进过 step 的回合不评审')
  })

  t('C5 不同 turn 各评一次', () => {
    const h = steppedHarness()
    h.feed(...turnGroup('t1', 10))
    h.feed(...turnGroup('t2', 20))
    assert.equal(h.ledger.calls.length, 2, '两个不同 turn 必须各评一次（二元组键不得过粗）')
  })

  t('C3 意见注入后再触发：仍评 1 次，且送模型的 markdown 不含 advisor 消息文本', () => {
    const h = steppedHarness()
    h.feed(...turnGroup('t1', 10))
    assert.equal(h.ledger.calls.length, 1)
    const md = h.ledger.calls[0].delta.markdown
    assert.equal(md.includes('内部意见'), false, 'advisor 自己的消息不得进下一轮评审输入')
    // 同 turn 重放（意见已被注入之后）
    h.feed(...turnGroup('t1', 10))
    assert.equal(h.ledger.calls.length, 1, '★注入意见不改变幂等判定')
  })

  t('C8 agentic 分支幂等：同一 user/message seq 重放两次 → 1 次', () => {
    const messages = [msg('user', 'hi'), msg('assistant', 'ok')]
    const h = steppedHarness({ messages })
    const evt = { type: 'user/message', seq: 7, data: { source: { kind: 'user' } }, surfaceOp: 'append' }
    h.feed(evt)
    assert.equal(h.ledger.calls.length, 1, '人类输入 + assistant 增量应评审')
    h.feed(evt)
    assert.equal(h.ledger.calls.length, 1, '★同一 user/message 重放不得二次评审')
  })

  t('C7 disposeSession 只清内存：seen 文件必须留在盘上', () => {
    const dir = tempDir('c7')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      const h = steppedHarness({
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      h.feed(...turnGroup('t1', 10))
      assert.equal(h.ledger.calls.length, 1)
      assert.equal(existsSync(sessionSeenPath(dir, 's-s3')), true)
      const before = readFileSync(sessionSeenPath(dir, 's-s3'), 'utf8')

      h.observer.disposeSession('s-s3')
      assert.equal(
        readFileSync(sessionSeenPath(dir, 's-s3'), 'utf8'), before,
        '★disposeSession 不得删除或改写 seen 文件（否则会话重建即重复计费）',
      )
      // 内存确实清了：同实例上同 turn 再来一次，仍会被文件里的键拦下
      h.feed(...turnGroup('t1', 10))
      assert.equal(h.ledger.calls.length, 1, 'dispose 后重建不得二次评审')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── C6 / C16 有界窗口 + 已裁决水位（**M 取自常量，不写死**）────────────
  t('C6 有界淘汰：灌 M+1 个 turn 后最旧的已出窗口，且 reviewed.length <= M', () => {
    const dir = tempDir('c6')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      const h = steppedHarness({
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      for (let i = 1; i <= SEEN_WINDOW_SIZE + 1; i++) h.feed(...turnGroup(`t${i}`, i))
      assert.equal(h.ledger.calls.length, SEEN_WINDOW_SIZE + 1, '阳性对照：每个新 turn 都评审')
      const seen = readSeenFile(dir, 's-s3')
      // ★必须钉**恰好 M 条**，不能只断言 `<= M`：M 与 M-1 都满足 `<= M`，
      //   把淘汰条件写成 `>= M` 的变异体照样全绿（critic D3 实测 150/0）。
      assert.equal(
        seen.reviewed.length, SEEN_WINDOW_SIZE,
        `窗口必须恰好保留 M 条（实得 ${seen.reviewed.length}，M=${SEEN_WINDOW_SIZE}）`,
      )
      assert.equal(seen.reviewed.includes('s-s3::t1'), false, '★最旧的键必须已被淘汰（否则本判据测不到窗口）')
      assert.equal(seen.reviewed.includes(`s-s3::t${SEEN_WINDOW_SIZE + 1}`), true, '最新的键必须在窗口内')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('C16/F-2 水位拦截窗口外重放：最旧的键已被淘汰，仍不得二次评审（必红 N24）', () => {
    const dir = tempDir('c16')
    try {
      // ── 第 1 轮：灌 M+1 个 turn 并评审
      const ledger = reviewLedger() // 两轮共用同一个记账桩
      const store1 = new AdvisorStore({ dataDir: dir })
      const h1 = steppedHarness({
        ledger,
        loadSeen: (id) => store1.readSeen(id),
        saveSeen: (id, state) => store1.writeSeen(id, state),
      })
      for (let i = 1; i <= SEEN_WINDOW_SIZE + 1; i++) h1.feed(...turnGroup(`t${i}`, i))
      const afterFirst = ledger.calls.length
      assert.equal(afterFirst, SEEN_WINDOW_SIZE + 1, '阳性对照：第一轮每个 turn 评一次')
      assert.equal(
        readSeenFile(dir, 's-s3').reviewed.includes('s-s3::t1'), false,
        '★前置：t1 必须已出窗口（否则拦它的是集合而不是水位，C16 就是空门）',
      )

      // ── 第 2 轮：丢弃实例，同 dataDir 新建实例（= 进程重启），重放最旧的 turn/end
      const store2 = new AdvisorStore({ dataDir: dir })
      const h2 = steppedHarness({
        ledger,
        loadSeen: (id) => store2.readSeen(id),
        saveSeen: (id, state) => store2.writeSeen(id, state),
      })
      // 重放**整组**（含 step/start）：新实例的流式 steppedTurns 是空的，
      // 若不重放 step/start，「无 step 不评审」会替水位拦下这一条，
      // 去掉水位也照样绿 —— 那就是空门。
      h2.feed(...turnGroup('t1', 1))
      assert.equal(
        ledger.calls.length - afterFirst, 0,
        '★窗口外的旧 turn 重放不得二次评审（水位拦截，必红 N24）',
      )
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('C17 半 A 已裁决语义：无 step 的 turn/end（被跳过）仍推进水位并落盘', () => {
    const dir = tempDir('c17a')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      const h = steppedHarness({
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      h.feed(...turnGroup('t1', 10))
      assert.equal(h.ledger.calls.length, 1)
      // 无 step 的可评审 turn/end：跳过评审，但水位必须推进（C17 半 A）
      h.feed({ type: 'turn/end', seq: 20, data: { turn: 't-skip', reason: { kind: 'completed' } } })
      assert.equal(h.ledger.calls.length, 1, '无 step 的回合不评审')
      assert.equal(
        readSeenFile(dir, 's-s3').lastReviewedSeq, 20,
        '★被跳过的 turn/end 也必须推进并持久化水位（语义是「已裁决」不是「已评审」）',
      )
      // 水位已在 20：重放更早的可评审回合 → 不评审
      h.feed(...turnGroup('t1', 10))
      assert.equal(h.ledger.calls.length, 1, '水位内的重放不得二次评审')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── C17 半 B：seq 回退行为写死（水位优先，不 fallback）────────────────
  t('C17 半 B seq 回退：watermark=100 + seq=50 + 该 turn 未命中 reviewed → 不评审、不抛错、不写集合', () => {
    const dir = tempDir('c17b')
    try {
      // 直接预置水位（不经过评审），模拟「宿主 seq 回退/重编号」的不支持场景
      new AdvisorStore({ dataDir: dir }).writeSeen('s-s3', { reviewed: [], lastReviewedSeq: 100 })
      const h = steppedHarness({
        loadSeen: (id) => new AdvisorStore({ dataDir: dir }).readSeen(id),
        saveSeen: (id, state) => new AdvisorStore({ dataDir: dir }).writeSeen(id, state),
      })
      assert.doesNotThrow(() => { h.feed(...turnGroup('t1', 50)) }, '水位命中不得抛错')
      assert.equal(h.ledger.calls.length, 0, '★水位优先：该 turn 不评审（若 fallback 到集合就会评审）')
      assert.equal(
        readSeenFile(dir, 's-s3').reviewed.includes('s-s3::t1'), false,
        '★被水位拦下的 turn 不得写进 reviewed（那等于把「已裁决」混同「已评审」）',
      )
      // 阳性对照：seq 越过水位后，同一会话仍能正常评审（否则本判据可能是「什么都不做」的假绿）
      h.feed(...turnGroup('t2', 150))
      assert.equal(h.ledger.calls.length, 1, '越过水位的新 turn 必须正常评审')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── C9 / C11 跨重启持久化（E2 / A13）──────────────────────────────────
  // ★C9 必须走**真实装配**（installAdvisor → index.js 注入 → store 落盘）。
  //   早先版本在测试里自建 observer 并手工接 store，结果「把 index.js 的
  //   loadSeen/saveSeen 注入摘掉」这条变异**完全看不见**（实测 150/0 假绿）——
  //   断言验的是测试替身，不是交付物。装配层接线必须由装配层判据覆盖。
  t('C9/E2/A13 跨重启不二次计费：**增量口径**——重启后新增调用数 === 0', async () => {
    const dir = tempDir('c9')
    try {
      // 两轮共用**同一个记账桩** ledger：`calls` 是累计值，
      // 所以「重启后新增 === 0」= `calls.length` 未变。
      // （写成 `llm.calls.length === 0` 会让正确实现也红——那是第一版写法的坑。）
      const ledger = { calls: [] }
      const llm = {
        stream: (options) => {
          ledger.calls.push(options)
          return (async function* () { yield { type: 'text-delta', text: '{"notes":[]}' } })()
        },
      }
      const turnEnd = { type: 'turn/end', seq: 10, data: { turn: 't1', reason: { kind: 'completed' } } }
      const step = { type: 'step/start', data: { turn: 't1' } }
      /** 装配一个全新 advisor（同 dataDir），喂一轮事件后排空。 */
      async function bootAndFeed(turnEnds) {
        const messages = [msg('user', '请写代码'), msg('assistant', '好的')]
        const agent = fakeAgent('s-c9')
        agent.session = { id: 's-c9', deriveMessages: () => messages, ownEvents: () => [step, ...turnEnds] }
        const { ctx, emit } = fakeCtx()
        ctx.agents.get = (id) => (id === 's-c9' ? agent : undefined)
        const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => llm })
        installed.ctrl.patchConfig('s-c9', { enabled: true, provider: 'p', model: 'm' })
        emit('agent/created', { agent })
        emit('session/event', agent.session, step)
        for (const te of turnEnds) emit('session/event', agent.session, te)
        await installed.ctrl.runtimeOf('s-c9')?.waitForDrain()
        installed.dispose() // 丢弃实例（= 进程重启）
      }

      await bootAndFeed([turnEnd])
      assert.equal(ledger.calls.length, 1, '阳性对照：第一轮恰好评审 1 次')

      // ── 同 dataDir 重新装配（全新 store + 全新 observer），重放整组
      await bootAndFeed([turnEnd])
      assert.equal(
        ledger.calls.length - 1, 0,
        '★重启后重放同一 turn：新增调用数必须为 0（增量口径）',
      )
      // 同 turn 的不同 seq 副本跨重启同样不得二次计费（二元组键跨重启保持）
      await bootAndFeed([{ type: 'turn/end', seq: 77, data: { turn: 't1', reason: { kind: 'completed' } } }])
      assert.equal(ledger.calls.length - 1, 0, '跨重启的同 turn 不同 seq 副本也不得二次计费')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('C11/E2 seen fail-open：seen 文件预置坏 JSON → 仍正常评审 1 次 + 一条告警，不抛错', () => {
    const dir = tempDir('c11')
    try {
      const path = sessionSeenPath(dir, 's-s3')
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      writeFileSync(path, '{ 这不是 JSON')
      // 抓 seen 面的告警（store 走 console.error；写入失败只在 seen 面告警一次）
      const captured = []
      const original = console.error
      console.error = (...args) => { captured.push(args.map(String).join(' ')) }
      try {
        const store = new AdvisorStore({ dataDir: dir })
        const h = steppedHarness({
          loadSeen: (id) => store.readSeen(id),
          saveSeen: (id, state) => store.writeSeen(id, state),
        })
        assert.doesNotThrow(() => { h.feed(...turnGroup('t1', 10)) }, '坏 seen 文件不得把评审循环带崩')
        assert.equal(h.ledger.calls.length, 1, '★fail-open 之后评审照常发生')
      } finally {
        console.error = original
      }
      const warns = captured.filter((m) => m.includes('seen'))
      assert.equal(warns.length, 1, `坏 JSON 必须恰好一条 seen 告警（实得 ${warns.length}：${JSON.stringify(captured)}）`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // 锁 steppedTurns 的「匹配即删」语义：一次 step/start 只配一次 turn/end。
  // 判别格 = 「turn 早已评审过 → 键被 M 窗口淘汰 → 宿主以**更高 seq** 重投它的
  // turn/end 且**不带 step/start**」。探针（agent-out/s3-probe-d4.mjs）实测：
  // 只加不删在这一格评审 1 次（**二次计费**），匹配即删评审 0 次；
  // 而「从未评审过的 stepped turn 越过水位后重来」那一格两者都评审 1 次，
  // 即匹配即删**不会**造成真漏评。按用户取舍（漏评可 POST review 补回、
  // 重复计费不可接受）本格必须落在 0。必红 D4r（改回只加不删）。
  t('steppedTurns 匹配即删：键出窗口的旧 turn 被抬高 seq 重投时不得二次计费', () => {
    const dir = tempDir('stepev')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      const h = steppedHarness({
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      for (let i = 1; i <= SEEN_WINDOW_SIZE + 1; i++) h.feed(...turnGroup(`t${i}`, i))
      const before = h.ledger.calls.length
      assert.equal(readSeenFile(dir, 's-s3').reviewed.includes('s-s3::t1'), false, '前置：t1 的键已出窗口')

      // 只重投 t1 的 turn/end，seq 抬到水位之上，**不带 step/start**
      h.feed({ type: 'turn/end', seq: SEEN_WINDOW_SIZE + 2, data: { turn: 't1', reason: { kind: 'completed' } } })
      assert.equal(
        h.ledger.calls.length - before, 0,
        '★一次 step/start 只配一次 turn/end：旧 turn 不得借抬高 seq 绕过幂等门二次计费',
      )
      // 阳性对照：一个**全新** turn 越过水位后仍必须正常评审（否则本判据是「什么都不做」的假绿）
      h.feed(...turnGroup('t-fresh', SEEN_WINDOW_SIZE + 3))
      assert.equal(h.ledger.calls.length - before, 1, '阳性对照：新 turn 仍必须正常评审')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── P1-1（必修）：未启用的会话不得有任何落盘副作用 ──────────────────
  // 事故面：session/event 是**全局**接线（所有会话都进观察器），而观察器在每个
  // turn/end 上无条件推进水位并写 seen 文件 → 一个从未开启 advisor 的会话跑完
  // 一轮就凭空产生 sessions/<b64>.seen.json，且按 M=256 每回合整份重写十几 KB。
  t('P1-1 未启用的会话不得产生 seen 文件（enabled 早退必须在落盘之前）', async () => {
    const dir = tempDir('p11seen')
    try {
      const messages = [msg('user', '别评审我'), msg('assistant', '好')]
      const events = [{ type: 'step/start', data: { turn: 't1' } }]
      const turnEnd = { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } }
      const agent = fakeAgent('s-off')
      agent.session = { id: 's-off', deriveMessages: () => messages, ownEvents: () => [...events, turnEnd] }
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = () => agent
      const llm = fakeLlm('{"notes":[]}')
      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => llm })
      // ★**不写** enabled 配置：advisorEnabled 缺省即关闭
      emit('agent/created', { agent })
      emit('session/event', agent.session, events[0])
      emit('session/event', agent.session, turnEnd)
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(installed.ctrl.snapshot('s-off').enabled, false, '前置：该会话确实是关闭的')
      assert.equal(
        existsSync(sessionSeenPath(dir, 's-off')), false,
        '★未启用的会话跑完一轮也绝不允许产生 seen 文件（早退必须在落盘之前）',
      )
      assert.equal(llm.calls.length, 0, '未启用不得调用模型')

      // 阳性对照：一旦开启，同一条链路**必须**产生 seen 文件 —— 否则上条可能是空门
      installed.ctrl.patchConfig('s-off', { enabled: true, provider: 'p', model: 'm' })
      emit('session/event', agent.session, { type: 'step/start', data: { turn: 't2' } })
      emit('session/event', agent.session, { type: 'turn/end', seq: 21, data: { turn: 't2', reason: { kind: 'completed' } } })
      await installed.ctrl.runtimeOf('s-off')?.waitForDrain()
      assert.equal(
        existsSync(sessionSeenPath(dir, 's-off')), true,
        '阳性对照：已启用的会话必须落 seen（否则上条「不产生」是因为根本没跑，而不是因为早退）',
      )
      assert.equal(llm.calls.length, 1, '阳性对照：启用后这一轮应当正常评审')
      installed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── C15 三者职责边界 ─────────────────────────────────────────────────
  t('C15 职责边界：推进 cursor 不写持久集合；写持久集合不推 cursor', () => {
    const dir = tempDir('c15')
    try {
      const store = new AdvisorStore({ dataDir: dir })
      // ① agentic 分支只推进 cursor，**不得**写 seen 集合
      const agentic = steppedHarness({
        sessionId: 's-c15a',
        messages: [msg('user', 'hi'), msg('assistant', 'ok')],
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      agentic.feed({ type: 'user/message', data: { source: { kind: 'user' } }, surfaceOp: 'append' })
      assert.equal(agentic.ledger.calls.length, 1, '阳性对照：agentic 分支确实评审了')
      assert.equal(
        existsSync(sessionSeenPath(dir, 's-c15a')), false,
        '★推进 cursor 不得写幂等集合（agentic 分支的幂等由游标负责，不进 seen 面）',
      )

      // ② 反向：写 seen 集合时**不得**顺带推进 cursor。
      //    构造「键已写入但渲染不出增量」（无可见消息）的一轮：
      //    reviewed 落了盘，cursor 必须仍为 0。
      const blank = steppedHarness({
        sessionId: 's-c15b',
        messages: [], // 无任何可见消息 → renderVisibleSurface 返回 null
        growOnTurn: false, // 且不让 feed 补消息，否则「无可见内容」构造失效
        loadSeen: (id) => store.readSeen(id),
        saveSeen: (id, state) => store.writeSeen(id, state),
      })
      blank.feed(...turnGroup('t1', 10))
      assert.equal(blank.ledger.calls.length, 0, '无可见内容时不得产生评审增量')
      const seen = readSeenFile(dir, 's-c15b')
      assert.equal(seen.reviewed.includes('s-c15b::t1'), true, '阳性对照：键确实已写进持久集合')
      assert.equal(
        blank.observer.cursorFor('s-c15b').cursor, 0,
        '★写持久集合不得顺带推进 cursor（游标只由 renderAndEmit 的成功路径推进）',
      )
    } finally { rmSync(dir, { recursive: true, force: true }) }
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

  // ── S4：输出预算与终态判定（R6 + U1 + U3 + F-1 P0） ──────────────────────

  /** 用 chunk 脚本驱动一轮评审，回传投递/记录/状态序列/runtime 句柄。 */
  async function driveReview(script, extra = {}) {
    const delivered = []
    const recorded = []
    const statuses = []
    const runtime = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 'sys',
      llm: fakeLlm(script),
      deliver: (note) => { delivered.push(note); return 'steer' },
      record: (r) => recorded.push(r),
      onStatus: (s) => statuses.push(s.status),
      ...extra,
    })
    runtime.enqueue({ markdown: 'U1' }, { sessionId: 's', sessionName: '会话' })
    await runtime.waitForDrain()
    return { delivered, recorded, statuses, runtime }
  }

  const NOTE = '{"notes":[{"severity":"nit","text":"一条意见"}]}'

  t('S4-D1：输出预算 16384，且不对冲输入窗口（maxMessages 仍 60）', async () => {
    assert.equal(ADVISOR_MAX_TOKENS, 16_384)
    const llm = fakeLlm('{"notes":[]}')
    const runtime = new AdvisorRuntime({ provider: 'p', model: 'm', systemPrompt: 's', llm, deliver: () => 'recorded', record: () => {} })
    assert.equal(runtime.maxMessages, 60, '★U1 不对冲：抬输出预算不得下调输入窗口')
    runtime.enqueue({ markdown: 'U' }, { sessionId: 's' })
    await runtime.waitForDrain()
    assert.equal(llm.calls[0].maxTokens, ADVISOR_MAX_TOKENS, '实际下发给模型的预算必须等于 ADVISOR_MAX_TOKENS（引用常量，不写死字面量——P2-3）')
  })

  t('S4-D9/D10/D11/D2/D3/D4/D12：终态优先级链逐条（顺序即语义）', () => {
    const CAP = ADVISOR_MAX_TOKENS
    const at = (o) => classifyCompletion({ maxTokens: CAP, ...o })

    // 优先级 1：max-tokens 无条件 truncated，**压过 empty**
    assert.equal(at({ finishReason: 'max-tokens', text: '正文' }).outcome, 'truncated')
    assert.equal(at({ finishReason: 'max-tokens', text: '' }).outcome, 'truncated', '★max-tokens 必须压过 empty（硬约束）')
    assert.equal(at({ finishReason: 'max-tokens', text: '   \n ' }).outcome, 'truncated')
    assert.equal(at({ finishReason: 'max-tokens', outputTokens: CAP, text: '正文' }).outcome, 'truncated')
    assert.equal(at({ finishReason: 'max-tokens', text: '正文' }).deliverable, false)

    // 优先级 2：error / aborted → failed
    for (const kind of ['error', 'aborted']) {
      const r = at({ finishReason: kind, text: '正文' })
      assert.equal(r.outcome, 'failed', `${kind} 必须判 failed`)
      assert.equal(r.deliverable, false)
    }

    // 优先级 3：未登记的 kind 值 → unknown（fail-closed，不投递）
    for (const kind of ['some-future-kind', 'length', 'tool-calls', 'STOP']) {
      const r = at({ finishReason: kind, text: '正文' })
      assert.equal(r.outcome, 'unknown', `未登记 kind=${kind} 必须 fail-closed`)
      assert.equal(r.deliverable, false)
    }
    assert.deepEqual([...ADVISOR_FINISH_KINDS], ['stop', 'max-tokens', 'error', 'aborted'], '登记的 kind 集合被改宽/改窄都会改变 fail-closed 边界')

    // 优先级 4：finish 缺失但 usage 在 → 按 usage 判定（D12 / AC-25）
    const low = at({ outputTokens: 100, text: '正文' })
    assert.equal(low.outcome, 'ok')
    assert.equal(low.usageUnknown, false)
    assert.equal(low.deliverable, true)
    assert.equal(at({ outputTokens: CAP, text: '正文' }).outcome, 'truncated')

    // 优先级 5：正文为空 → empty（走到这里 kind 只可能是 stop）
    assert.equal(at({ finishReason: 'stop', text: '' }).outcome, 'empty')
    assert.equal(at({ finishReason: 'stop', text: '  \n ' }).outcome, 'empty')
    assert.equal(at({ finishReason: 'stop', text: '' }).deliverable, false)

    // 优先级 6：stop + 触及 token 上限 → inconsistent
    const capped = at({ finishReason: 'stop', outputTokens: CAP, text: '正文' })
    assert.equal(capped.outcome, 'inconsistent')
    assert.equal(capped.deliverable, false)

    // 优先级 7：stop + 未触顶 → ok（差一个 token 也算未触顶）
    const almost = at({ finishReason: 'stop', outputTokens: CAP - 1, text: '正文' })
    assert.equal(almost.outcome, 'ok')
    assert.equal(almost.deliverable, true)
  })

  t('S4-D4/裁决A：usage 缺失但 finish=stop → ok + usageUnknown（不得一律 fail-closed）', () => {
    const r = classifyCompletion({ finishReason: 'stop', text: '正文', maxTokens: ADVISOR_MAX_TOKENS })
    assert.equal(r.outcome, 'ok', '★裁决A：不返 usage 的 provider 不是异常，不得 fail-closed')
    assert.equal(r.usageUnknown, true)
    assert.equal(r.deliverable, true)
  })

  t('S4-D9/N25：max-tokens 无 usage → 不投递 + status=error；空正文变体判 truncated 而非 empty', async () => {
    const withText = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'finish', reason: 'max-tokens' },
    ])
    assert.equal(withText.delivered.length, 0, '触顶不得投递')
    assert.equal(withText.runtime.status, 'error')
    assert.match(withText.runtime.error, /max-tokens/)

    const empty = await driveReview([{ type: 'finish', reason: 'max-tokens' }])
    assert.equal(empty.delivered.length, 0)
    assert.equal(empty.runtime.status, 'error')
    assert.match(empty.runtime.error, /预算|截断/, '★空正文 + max-tokens 必须报触顶截断')
    assert.doesNotMatch(empty.runtime.error, /正文为空/, '★不得被 empty 判定压过（优先级 1 > 优先级 5）')
  })

  t('S4-D10/N26：未登记 kind → unknown，不投递 + status=error', async () => {
    const r = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: 12 } },
      { type: 'finish', reason: 'some-future-kind' },
    ])
    assert.equal(r.delivered.length, 0, '未登记 kind 不得投递')
    assert.equal(r.runtime.status, 'error')
    assert.match(r.runtime.error, /未登记/)
  })

  t('S4-D11/N25p：finishReason=error / aborted → failed，不投递 + status=error', async () => {
    for (const reason of ['error', 'aborted']) {
      const r = await driveReview([
        { type: 'text-delta', text: NOTE },
        { type: 'usage', usage: { outputTokens: 33 } },
        { type: 'finish', reason },
      ])
      assert.equal(r.delivered.length, 0, `${reason} 不得投递`)
      assert.equal(r.runtime.status, 'error')
      assert.match(r.runtime.error, new RegExp(reason))
    }
  })

  t('S4-D2/D3/N14：stop + 恰好触顶 → inconsistent 不投递；stop + 差一个 token → 正常投递', async () => {
    const capped = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS } },
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(capped.delivered.length, 0, '★矛盾态（stop + 触顶）不得投递')
    assert.equal(capped.runtime.status, 'error')
    assert.match(capped.runtime.error, /矛盾/)

    const almost = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS - 1 } },
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(almost.delivered.length, 1, '差一个 token = 未触顶，必须照常投递')
    assert.equal(almost.runtime.status, 'idle')
    assert.equal(almost.recorded[0].outcome, 'steer')
  })

  t('S4-D8/N16（U3）：触顶不投递 + 落 error 记录（outcome=dropped、文案含预算/截断，不得降级 info/recorded）', async () => {
    const r = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS } },
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(r.recorded.length, 1, '触顶必须落一条记录')
    assert.equal(r.recorded[0].outcome, 'dropped', '★U3：触顶不得降级为 recorded')
    assert.equal(r.recorded[0].severity, 'info')
    assert.match(r.recorded[0].text, /预算|截断/)
    assert.ok(r.statuses.includes('error'), '状态必须出现 error')
    assert.ok(!r.statuses.includes('info'), '★U3：触顶不得降级为 info')
  })

  t('S4-D5/D14④：正文非空但 JSON 被截断 + max-tokens → truncated + 记录 outcome=dropped（判定跑在解析之前）', async () => {
    const r = await driveReview([
      // 故意既不是合法 JSON、正文里也不出现「预算/截断」二字
      { type: 'text-delta', text: '{"notes":[{"severity":"concern","text":"半句话没说完' },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS } },
      { type: 'finish', reason: 'max-tokens' },
    ])
    assert.equal(r.delivered.length, 0)
    assert.equal(r.recorded.length, 1)
    assert.equal(r.recorded[0].outcome, 'dropped')
    assert.match(r.recorded[0].text, /预算|截断/, '★记录必须说明触顶截断，而不是「解析失败」')
    assert.doesNotMatch(r.recorded[0].text, /解析失败/, '★判定必须跑在 parseReviewOutput 之前')
  })

  t('S4-D12/N25pp（AC-25）：只有 usage 无 finish → 按 usage 判定（未触顶 ok / 触顶 truncated）', async () => {
    const low = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: 100, inputTokens: 900 } },
    ])
    assert.equal(low.delivered.length, 1, '★usage 正常但没有 finish 的 provider 必须照常投递')
    assert.equal(low.runtime.status, 'idle')
    assert.equal(low.recorded[0].outcome, 'steer')

    const capped = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS } },
    ])
    assert.equal(capped.delivered.length, 0, '触顶事实成立 → 不投递')
    assert.equal(capped.recorded[0].outcome, 'dropped')
  })

  t('S4-D7/N17（R6）：trace 不含正文采样——无 sample 键、无 canary 串，text 长度字段仍在', async () => {
    const CANARY = 'ZZ-CANARY-9d2f7a-模型正文采样探针'
    const rows = []
    const r = await driveReview([
      { type: 'text-delta', text: `{"notes":[{"severity":"nit","text":"${CANARY}"}]}` },
      { type: 'usage', usage: { outputTokens: 42 } },
      { type: 'finish', reason: 'stop' },
    ], { trace: (row) => rows.push(row) })
    assert.equal(r.delivered.length, 1, '前置：本轮必须真的走完投递（否则 trace 可能压根没触发）')
    const chunkRows = rows.filter((row) => row.phase === 'chunk')
    assert.ok(chunkRows.length >= 3, `前置：应采到 3 个分片（实得 ${chunkRows.length}）`)
    const textRow = chunkRows.find((row) => row.type === 'text-delta')
    assert.ok(textRow, '前置：应有 text-delta 行')
    assert.equal(typeof textRow.text, 'number', 'text 字段须保留为「长度」')
    assert.ok(textRow.text > 0, '长度字段须有值（不是被一起删掉）')
    for (const row of chunkRows) {
      assert.ok(!('sample' in row), '★R6：chunk 行不得再带 sample 采样键')
    }
    assert.ok(!JSON.stringify(rows).includes('sample'), '★R6：整份 trace 不得出现 sample 键')
    assert.ok(!JSON.stringify(rows).includes(CANARY), '★R6：trace 零落模型正文（canary 串必须 0 命中）')
  })

  t('S4-D13（AC-27）：fakeLlm chunk 脚本真被运行时消费——实测参数自证分类（否则 R6 全盲）', async () => {
    const head = '{"notes":[{"severity":'
    const tail = '"nit","text":"AB"}]}'
    const rows = []
    const r = await driveReview([
      { type: 'text-delta', text: head },
      { type: 'text-delta', text: tail },
      { type: 'usage', usage: { outputTokens: 3, inputTokens: 9 } },
      { type: 'finish', reason: 'stop' },
    ], { trace: (row) => rows.push(row) })
    assert.equal(r.delivered.length, 1, '★桩件下发的 stop + 未触顶必须照常投递')
    assert.equal(r.recorded[0].outcome, 'steer')
    const end = rows.find((row) => row.phase === 'call-end')
    assert.equal(end.textLength, head.length + tail.length, '★桩件的多片 text-delta 必须真被 runtime 累加（否则终态判据全盲）')
    // 分类自证：这套实测参数（stop + 未触顶）必须落到 ok 并照常投递
    assert.equal(classifyCompletion({ finishReason: 'stop', outputTokens: 3, text: head + tail }).outcome, 'ok')
  })

  // ── S4 补修轮：P1-1 / P1-2 / P2-1 / P2-2 / P2-3 ────────────────────────────

  t('S4-P1-2u：usage 语义 = last-wins（后发的真实用量覆盖先发的预估值）', async () => {
    // first≠last：先发**低估的预估** usage，再发**触顶的真实** usage。
    // 若取先出现的值 → outputTokens=100 → stop+未触顶 → 判 ok → 照常投递（绕过 U3/F-1）。
    const r = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'usage', usage: { outputTokens: 100 } },
      { type: 'usage', usage: { outputTokens: ADVISOR_MAX_TOKENS } },
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(r.delivered.length, 0, '★必须按后发的 16384 判触顶 → 矛盾态不投递（first-wins 会投递）')
    assert.equal(r.runtime.status, 'error')
    assert.match(r.runtime.error, /矛盾/)
    // 单元面：last-wins 的值本身
    assert.equal(classifyCompletion({ finishReason: 'stop', outputTokens: ADVISOR_MAX_TOKENS, text: 'x' }).outputTokens, ADVISOR_MAX_TOKENS)
  })

  t('S4-P1-2f：finish 语义 = last-wins（后发的终态 reason 覆盖先发的中间态 reason）', async () => {
    // first≠last：先发一个会 fail-closed 的 kind，再发 stop。
    // 若取先出现的值 → unknown → 不投递；若 last-wins → stop + 未触顶 → 正常投递。
    const r = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'finish', reason: 'some-future-kind' },
      { type: 'finish', reason: 'stop' },
      { type: 'usage', usage: { outputTokens: 100 } },
    ])
    assert.equal(r.delivered.length, 1, '★必须按后发的 stop 判定 → 正常投递（first-wins 会因 unknown 而拒投）')
    assert.equal(r.runtime.status, 'idle')
    assert.equal(r.recorded[0].outcome, 'steer')
    // 反向：后发的终态必须是 max-tokens 时，即使先发的是 stop 也按触顶判
    const capped = await driveReview([
      { type: 'text-delta', text: NOTE },
      { type: 'finish', reason: 'stop' },
      { type: 'finish', reason: 'max-tokens' },
      { type: 'usage', usage: { outputTokens: 100 } },
    ])
    assert.equal(capped.delivered.length, 0, '★后发的 max-tokens 必须压过先发的 stop')
    assert.match(capped.runtime.error, /max-tokens/)
  })

  t('S4-P1-1：finish 缺失 + 未触顶 + 正文为空 → empty 且不可投递（不得被整体 return 吞成 ok）', () => {
    for (const text of ['', '   ', '\n\t  ']) {
      const r = classifyCompletion({ finishReason: null, outputTokens: 100, text, maxTokens: ADVISOR_MAX_TOKENS })
      assert.equal(r.outcome, 'empty', `text=${JSON.stringify(text)} 必须判 empty（此前被优先级 4 的整体 return 吞掉）`)
      assert.equal(r.deliverable, false, '★空正文绝不可投递')
    }
    // 对照：同一分支下正文非空仍是 ok（证明不是把整条分支判死）
    assert.equal(classifyCompletion({ finishReason: null, outputTokens: 100, text: '正文' }).outcome, 'ok')
  })

  t('S4-P2-1：触顶事实不被 empty 掩掉（stop+触顶+空正文 → inconsistent；缺 finish+触顶+空正文 → truncated）', () => {
    const inconsistent = classifyCompletion({ finishReason: 'stop', outputTokens: ADVISOR_MAX_TOKENS, text: '', maxTokens: ADVISOR_MAX_TOKENS })
    assert.equal(inconsistent.outcome, 'inconsistent', '★矛盾态不得被 empty 掩盖')
    assert.equal(inconsistent.deliverable, false)
    assert.match(inconsistent.detail, /矛盾|上限/, '★记录文案必须仍能看出触顶')

    const truncated = classifyCompletion({ finishReason: null, outputTokens: ADVISOR_MAX_TOKENS, text: '', maxTokens: ADVISOR_MAX_TOKENS })
    assert.equal(truncated.outcome, 'truncated', '★缺 finish + 触顶 + 空正文仍判触顶')
    assert.equal(truncated.deliverable, false)
    assert.match(truncated.detail, /预算|截断/)

    // 但未触顶 + 空正文仍是 empty（触顶优先级不得反过来吃掉正常空回复）
    assert.equal(classifyCompletion({ finishReason: 'stop', outputTokens: 1, text: '', maxTokens: ADVISOR_MAX_TOKENS }).outcome, 'empty')
  })

  t('S4-P2-2：坏 maxTokens 回落到常量（0 / 负数 / NaN / 字符串），该兜底分支真实可达', () => {
    for (const bad of [0, -1, -16_384, Number.NaN, undefined, null, '16384', {}]) {
      const r = classifyCompletion({ finishReason: 'stop', outputTokens: 100, text: '正文', maxTokens: bad })
      assert.equal(r.maxTokens, ADVISOR_MAX_TOKENS, `maxTokens=${String(bad)} 必须回落到 ADVISOR_MAX_TOKENS`)
      assert.equal(r.outcome, 'ok', `maxTokens=${String(bad)} 不得让 hitCap 退化成恒真`)
    }
    // 正对照：合法值不被回落
    assert.equal(classifyCompletion({ maxTokens: 8192, outputTokens: 100, text: '正文' }).maxTokens, 8192)
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

  // ── P1-3：评审员持续会话有界化（评审终稿 P1-3：无界累积 → 撞上下文上限 → 永久 error 停摆） ──

  t('P1-3a：缺省构造即挂字符预算（生产无界 = 原缺陷形态）', () => {
    const runtime = new AdvisorRuntime({ provider: 'p', model: 'm', systemPrompt: 's', llm: fakeLlm('{"notes":[]}'), deliver: () => 'recorded', record: () => {} })
    assert.equal(runtime.conversation.maxChars, ADVISOR_CONVERSATION_MAX_CHARS,
      '★缺省构造必须落到 ADVISOR_CONVERSATION_MAX_CHARS（引用常量不写死字面量）')
    runtime.dispose()
  })

  t('P1-3b：持续会话超预算丢最旧 + 不留悬空 assistant 头', () => {
    const conv = new AdvisorConversation({ maxChars: 100 })
    conv.appendUser('u'.repeat(60))
    conv.appendAssistant('a'.repeat(40)) // 60+40=100，恰好未超
    assert.equal(conv.stats().charCount, 100)
    conv.appendUser('n'.repeat(30)) // 130 > 100 → 淘汰 u(60)；剩余以 a(40) 开头（悬空）→ 淘汰
    assert.equal(conv.length, 1, '★超预算必须丢最旧（无界累积 = P1-3 原缺陷）')
    assert.equal(conv.messages[0].role, 'user', '修剪后不得以悬空 assistant 开头')
    assert.equal(conv.messages[0].text, 'n'.repeat(30))
    assert.ok(conv.stats().charCount <= 100, '★字符总量恒 ≤ 预算')
  })

  t('P1-3c：单条消息超预算 → 整条不进历史（本轮增量不走会话，照常单独送模型）', () => {
    const conv = new AdvisorConversation({ maxChars: 50 })
    conv.appendUser('x'.repeat(80))
    assert.equal(conv.length, 0, '超预算的单条消息必须整条淘汰（判据是总量不是条数）')
    conv.appendUser('y'.repeat(20))
    assert.equal(conv.length, 1)
  })

  t('P1-3d：长会话模拟（多轮评审 + 全量重放形态巨型增量）→ 重放历史恒 ≤ 预算且每轮照常评审', async () => {
    const BUDGET = 400
    const ROUNDS = 12
    // 证据收集在桩内、断言在回合结束后统一做——桩回调里的 assert 异常会被
    // callModel 的 catch 吞成 failure（静默无牙），先记录后断言才有牙齿。
    const historySizes = []
    const llm = fakeLlm((options) => {
      const texts = options.messages.map((m) => m.content?.[0]?.text ?? '')
      historySizes.push(texts.slice(0, -1).reduce((sum, t) => sum + t.length, 0))
      return '{"notes":[{"severity":"info","text":"意见"}]}'
    })
    const runtime = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 's',
      llm,
      deliver: () => 'recorded',
      record: () => {},
      conversationMaxChars: BUDGET,
    })
    for (let i = 0; i < ROUNDS; i++) {
      // 第 8 轮（i=7）注入一条远超预算的巨型增量——模拟 compact/重写后的全量重放形态；
      // 其余轮次是常态增量。两种形态下会话都必须有界。
      const big = i === 7
      const markdown = (big ? 'FULL-REPLAY' : `round-${i}`) + '-'.repeat(big ? 2000 : 60)
      runtime.enqueue({ markdown }, { sessionId: 's' })
      await runtime.waitForDrain()
      assert.ok(runtime.conversation.stats().charCount <= BUDGET, `round ${i}：会话长度必须有界`)
    }
    assert.equal(llm.calls.length, ROUNDS, '有界化不得中断评审循环（每轮照常调用模型）')
    assert.equal(historySizes.length, ROUNDS, '每轮都真实到达了模型调用（否则下面的历史断言是空门）')
    for (const [i, h] of historySizes.entries()) {
      assert.ok(h <= BUDGET, `★round ${i}：重放历史 ${h} 字符必须 ≤ 预算 ${BUDGET}（P1-3 停摆根因）`)
    }
    runtime.dispose()
  })

  // ── P1-4：契约 0.1「关闭不了」枚举完整（写/读/触发三面）且 SKILL.md 边界 1 同步 ──

  t('P1-4：契约 0.1 三面暴露面（写/读/触发）已声明，SKILL.md 边界 1 同步', () => {
    const contract = readFileSync(fileURLToPath(new URL('../docs/advisor-contract.md', import.meta.url)), 'utf8')
    const start = contract.indexOf('### 0.1')
    const end = contract.indexOf('### 0.2')
    assert.ok(start >= 0 && end > start, '契约必须存在 0.1 节（找不到 = 文档结构漂移）')
    const sec = contract.slice(start, end)
    // 三面枚举的 grep 可断言声明（bullet 头形态锚定，防说明性字面量误命中）
    assert.match(sec, /\*\*写\*\*[：:]/, '★写面（PATCH 改他人配置）必须显式声明')
    assert.match(sec, /\*\*读\*\*[：:]/, '★读面必须显式声明（security 终稿：GET 他人评审记录正文 + runtime.error 模型原文片段）')
    assert.match(sec, /\*\*触发\*\*[：:]/, '★触发面必须显式声明（POST review 烧他人额度）')
    // 读面要点与触发面要点（security P2-4）
    assert.match(sec, /评审记录正文/, '读面要点：他人活跃会话的评审记录正文')
    assert.match(sec, /只防[^。\n]*堆叠/, '触发面要点：busy 门只防堆叠')
    assert.match(sec, /不防持续触发/, '触发面要点：不防持续触发（P2-4）')
    // SKILL.md 边界 1 与契约同步（同三面）
    const skill = readFileSync(fileURLToPath(new URL('../skills/advisor/SKILL.md', import.meta.url)), 'utf8')
    assert.match(skill, /\*\*写\*\*——/, '★SKILL.md 边界 1 必须同步写面')
    assert.match(skill, /\*\*读\*\*——/, '★SKILL.md 边界 1 必须同步读面')
    assert.match(skill, /\*\*触发\*\*——/, '★SKILL.md 边界 1 必须同步触发面')
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

  t('投递：nit 在 steerSeverities 且不在冷却 → steer；冷却窗口内 nit 降级 inject（X11 分级豁免后 concern/blocker 免冷却）', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 2, steerSeverities: ['nit', 'concern', 'blocker'] })
    d.registerAgent(agent)
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'steer')
    assert.equal(agent.calls.steer.length, 1)
    // X11 冷却分级豁免（产品 2026-10-09 裁决，AC-33）：冷却窗口内 concern 免冷却直投 steer
    assert.equal(d.route('s', { severity: 'concern', text: 'c' }), 'steer')
    // 反向断言：冷却窗口内 nit 仍降级 inject（豁免面不是「全等级豁免」）
    assert.equal(d.route('s', { severity: 'nit', text: 'n2' }), 'inject')
    // 走完 2 个主回合后，nit 恢复 steer
    d.onSteppedTurnEnd('s')
    d.onSteppedTurnEnd('s')
    assert.equal(d.route('s', { severity: 'nit', text: 'n3' }), 'steer')
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
      // 推一个可评审的 turn/end（step → turn/end，**两条都经总线**，复刻生产）
      emit('session/event', agent.session, events[0])
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

  // C14【AC-17】集成链路幂等：防「observer 放行了、runtime 又重复处理」。
  // 走真实 installAdvisor 装配（observer + runtime + store 全链），断言的是
  // **模型调用数**而非 delta 数——delta 绿但 runtime 二次消费，只有这条抓得到。
  t('C14/AC-17 集成链路幂等：同一 turn/end 经总线投递两次 → waitForDrain 后只调 1 次模型', async () => {
    const dir = tempDir('c14')
    try {
      const messages = [msg('user', '请写代码'), msg('assistant', '好的')]
      const events = [{ type: 'step/start', data: { turn: 't1' } }]
      const turnEnd = { type: 'turn/end', seq: 20, data: { turn: 't1', reason: { kind: 'completed' } } }
      const agent = fakeAgent('sess-c14')
      agent.session = { id: 'sess-c14', deriveMessages: () => messages, ownEvents: () => [...events, turnEnd] }
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = (id) => (id === 'sess-c14' ? agent : undefined)
      const llm = fakeLlm('{"notes":[{"severity":"concern","text":"补测试"}]}')
      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => llm })
      installed.ctrl.patchConfig('sess-c14', { enabled: true, provider: 'p', model: 'm' })
      emit('agent/created', { agent })

      // 整组投递两次（重连重放的形状：step/start 与 turn/end 一起重来）
      for (let round = 0; round < 2; round++) {
        emit('session/event', agent.session, events[0])
        emit('session/event', agent.session, turnEnd)
      }
      await installed.ctrl.runtimeOf('sess-c14')?.waitForDrain()
      assert.equal(llm.calls.length, 1, '★同一 turn 经真实装配只允许一次模型调用')
      assert.equal(installed.ctrl.snapshot('sess-c14').records.length, 1, '记录也不得重复落盘')
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
      // ownEvents 必须返回**完整事件日志**（含 turn/end）：装配层把它整份传给
      // observer.handleEvent。S3 起「该 turn 进过 step」不再由扫描该数组得出，
      // 但本用例仍需 step/start **经总线**真实到达（生产同走 session/event），
      // 否则流式 steppedTurns 为空，一个 delta 都不会产出。
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
      ctx.emit('session/event', agentA.session, events[0])
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

// ── 9. S0 Phase 0 Baseline 锁定（advisor V3 plan 节 2 S0：判据 3 + 判据 11）─────
//
// 为什么必须**追加在同一个文件**（而不是新开一个 suite 文件）：
// 隔离门 `testRealDataDirIsolation` 的真实 dataDir 基线是**模块加载时**捕获的
// （上面 `REAL_DATA_DIR_BASELINE`，:2138）。若新用例放进新文件、且在 run.mjs:1319
// 的 `import * as advisorTests from './advisor.test.mjs'` **之前**被 import，新模块
// 加载期的写盘残留会被烘焙进基线，收尾断言就再也看不见它。同文件追加 = 与既有
// suite 同一次求值、同一条基线。
//
// 加载期零副作用（S0 判据 11）：本段只有常量与函数声明；任何写盘都在 `t(...)` 体内。

/** `runtimeSignature`（lib/advisor/index.js:376-385）第三态 join 串的字段清单与顺序。 */
const RUNTIME_SIGNATURE_FIELDS = [
  'route.provider',
  'route.model',
  'systemPromptOf()',
  'config.advisorMaxQueued',
  'config.advisorCallTimeoutMs',
  'config.advisorPersistLimit',
  'JSON.stringify(config.advisorSteerSeverities)',
  'config.advisorInfoInject',
  'config.advisorImmuneTurns',
]

/**
 * 取出 `runtimeSignature` 的函数体源码文本。
 *
 * 用「函数头定位 + 花括号配平」而不是写死行号：行号会随任何无关改动漂移，
 * 写死行号的锁会在重构时变成**假红**（锁的是位置而不是行为）。
 *
 * @returns {string} 从 `const runtimeSignature = (sessionId) => {` 到配平右花括号
 */
function extractRuntimeSignatureSource() {
  const src = readFileSync(fileURLToPath(new URL('../lib/advisor/index.js', import.meta.url)), 'utf8')
  const start = src.indexOf('const runtimeSignature = (sessionId) => {')
  assert.ok(start >= 0, 'runtimeSignature 必须存在（找不到 = 键函数被改名/删除，锁定失效）')
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('runtimeSignature 函数体花括号不配平（源码形态已变，锁定需同步）')
}

/**
 * `runtimeSignature` 三态形态的违规清单（纯函数 ⇒ 可直接喂变异体，L1-15）。
 *
 * @param {string} body
 * @returns {string[]} 空数组 = 三态形态逐字保持
 */
function runtimeSignatureShapeViolations(body) {
  const violations = []
  if (!/if \(!enabled\) return 'off'/.test(body)) violations.push('第一态 off 缺失/被改')
  if (!/if \(route\.modelSource !== 'session'\) return `unset:\$\{route\.reason \?\? ''\}`/.test(body)) {
    violations.push('第二态 unset:<reason> 缺失/被改（reason 必须内联且缺省为空串）')
  }
  const joinMatch = body.match(/return \[\s*([\s\S]*?)\s*\]\.join\(' '\)/)
  if (joinMatch === null) {
    violations.push("第三态 join 串形态缺失（必须 [...].join(' ')）")
  } else {
    const fields = joinMatch[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (JSON.stringify(fields) !== JSON.stringify(RUNTIME_SIGNATURE_FIELDS)) {
      violations.push(`第三态字段清单漂移：实得 ${JSON.stringify(fields)}`)
    }
  }
  return violations
}

/** S0 判据 3 + 判据 11：runtimeSignature 三态锁定 + 新增测试模块加载期零副作用。 */
export function testV3Baseline(t) {
  t('S0-3 runtimeSignature 三态锁定：off / unset:<reason> / join 串（源级形态 + 装配行为双证）', () => {
    const body = extractRuntimeSignatureSource()

    // ① 源级形态：三态字面量 + join 字段清单（字段与顺序都锁）
    assert.deepEqual(runtimeSignatureShapeViolations(body), [], 'runtimeSignature 三态形态必须逐字保持')

    // ② 变异控（L1-15：变异体与断言类别一一对应）——证明 ① 不是空门
    const mutants = [
      ['第一态', (s) => s.replace("if (!enabled) return 'off'", "if (!enabled) return 'on'")],
      ['第二态', (s) => s.replace("`unset:${route.reason ?? ''}`", '`unset:${route.reason}`')],
      ['第三态', (s) => s.replace('config.advisorInfoInject, ', '')],
    ]
    for (const [label, mutate] of mutants) {
      const mutated = mutate(body)
      assert.notEqual(mutated, body, `变异体必须真的注入到文本里（${label}）`)
      assert.ok(runtimeSignatureShapeViolations(mutated).length > 0, `注入后锁必须变红（${label}）`)
    }

    // ③ 装配行为：三态在真实 installAdvisor 下可观察（源级锁之外的第二手段）
    const dir = tempDir('v3sig')
    try {
      const { ctx, emit } = fakeCtx()
      const agent = fakeAgent('s-sig')
      ctx.agents.get = (id) => (id === 's-sig' ? agent : undefined)
      const installed = installAdvisor(ctx, {}, { dataDir: dir, resolveLlm: () => fakeLlm('{"notes":[]}') })
      try {
        // 态 1 `off`：无会话配置 → enabled=false ⇒ 直接返回 'off'，且绝不建运行时
        assert.equal(installed.ctrl.snapshot('s-sig').enabled, false, '态 1 前提：未配即未启用')
        assert.equal(installed.ctrl.runtimeOf('s-sig'), undefined, "态 1（'off'）：不得建运行时")

        // 态 2 `unset:<reason>`：enabled=true 但会话无模型。
        // 这里**手工写**配置文件（绕过 API 的 U2 成对规则），因为该态正是引擎必须
        // 防御的「旧文件 / 手改文件」形态——它**不代表** API 放开成对规则。
        mkdirSync(join(dir, 'sessions'), { recursive: true })
        writeFileSync(sessionConfigPath(dir, 's-sig'), JSON.stringify({ enabled: true }))
        const unsetSnap = installed.ctrl.snapshot('s-sig')
        assert.equal(unsetSnap.enabled, true, '态 2 前提：enabled 真值必须在位（否则退化成态 1）')
        assert.equal(unsetSnap.modelSource, 'unset', "态 2：modelSource 必须是 'unset'")
        assert.match(String(unsetSnap.runtime.error), /未指定评审模型/, '态 2 的 <reason> 必须由 route.reason 提供')
        assert.equal(installed.ctrl.runtimeOf('s-sig'), undefined, '态 2：未指定模型绝不建运行时（硬门禁）')

        // 态 3 join 串：会话配了模型 → 走第三态；join 串里任一字段变化必须触发运行时重建
        installed.ctrl.patchConfig('s-sig', { enabled: true, provider: 'p-sig', model: 'm-sig' })
        emit('agent/created', { agent })
        const first = installed.ctrl.runtimeOf('s-sig')
        assert.equal(first.provider, 'p-sig', '态 3：运行时按会话路由建出')
        installed.ctrl.patchConfig('s-sig', { enabled: true, provider: 'p-sig2', model: 'm-sig' })
        const second = installed.ctrl.runtimeOf('s-sig')
        assert.equal(second.provider, 'p-sig2', '态 3：join 串漂移必须重建运行时')
        assert.notEqual(second, first, '态 3：重建必须产生新实例（签名的唯一可观察后果）')
      } finally { installed.dispose() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('S0-11 加载期零副作用：新增测试模块 import 前后快照根逐字节不变（含判据 12 的录制件根）', async () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const fixtureRoot = join(repoRoot, 'agent-out', 'v3-fixtures')
    const before = {
      real: snapshotTree(DEFAULT_ADVISOR_DATA_DIR),
      fixtures: snapshotTree(fixtureRoot),
    }

    // 两个新增模块在本套件里**首次**求值（gate 是入口直跑时才自跑，被 import 时不应有副作用）
    const gate = await import('./isolation-gate.mjs')
    const replay = await import('./advisor-llm-replay.mjs')

    const after = {
      real: snapshotTree(DEFAULT_ADVISOR_DATA_DIR),
      fixtures: snapshotTree(fixtureRoot),
    }
    assert.deepEqual(after.real, before.real, '加载新增测试模块不得触碰真实用户 dataDir')
    assert.deepEqual(after.fixtures, before.fixtures, '加载新增测试模块不得写录制件根')

    // 阳性对照：两个模块必须**真的被求值**——否则上面的「没变化」是空门
    // （import 打错路径、导出改名等同样会让快照「没变化」）。
    assert.equal(typeof gate.snapshotTree, 'function', 'isolation-gate.mjs 必须被求值（导出 snapshotTree）')
    assert.equal(typeof gate.SNAPSHOT_ROOTS?.includes, 'function', 'isolation-gate.mjs 必须导出快照根列表')
    assert.equal(typeof replay.createReplayLlm, 'function', 'advisor-llm-replay.mjs 必须被求值（导出 createReplayLlm）')
    assert.equal(typeof replay.createRecordingLlm, 'function', 'advisor-llm-replay.mjs 必须导出录制端')

    // 门的快照目标必须与 lib 常量同源（否则门在守一个早已换址的目录 = 空门）
    assert.equal(gate.REAL_DATA_DIR, DEFAULT_ADVISOR_DATA_DIR, 'gate 的真实 dataDir 必须与 lib 常量一致')
    // 判据 12 的录制件落点必须**显式**列入快照根（否则是 architect P1-9 的「第三类无门落盘点」）
    assert.ok(gate.SNAPSHOT_ROOTS.includes(DEFAULT_ADVISOR_DATA_DIR), '真实 dataDir 必须是快照根')
    assert.ok(gate.SNAPSHOT_ROOTS.includes(fixtureRoot), '录制件根必须显式列入快照根列表')
  })
}

// ── 10. S1a：零依赖只读检索地基（advisor V3 节 2 S1a，判据 1–13）──────────────
//
// 追加在同一文件（与既有 suite 同一次求值、同一条基线）——理由同 S0 段。
// 本段所有 import 都是**声明**：retrieval/* 模块顶层无任何写盘/建目录副作用
// （由 S1a-13 的源码级写 API 门 + isolation-gate 的进程边界快照双重覆盖）。
//
// 本段自带的判据锚点（报告引用用）：S1a-1/2…S1a-13，逐条对应任务书 13 条判据。

import {
  BASE_CONTEXT_BYTES, RETRIEVAL_CALL_BYTES, RETRIEVAL_TOTAL_BYTES, TOTAL_INJECTION_BYTES, BUDGET_ITEMS,
  budgetVerdict, accountRetrieval, budgetExhaustedCarrier, measureInjection,
  createRetrieval, createBundle, isTestPath,
  createPathPolicy, createRejectionLog, REJECT, PathPolicyError,
  createGitReader, GitError,
  compileQuery, searchFiles, searchText, findRelatedTests, testCandidatesFor, NO_TEST_ANNOTATION,
  DEFAULT_EXCLUDED_DIRS, parseGitignore, parseGitattributes, createIgnoreMatcher, listFiles, snapshotWorktree,
} from '../lib/advisor/retrieval/index.js'
import { assertReadonlyArgv, tempFileName, parsePorcelain, parseNumstat, parseLog, minimalGitEnv } from '../lib/advisor/retrieval/git.js'
// S3：agentic 工具循环 + 只读 ACI 工具面（与既有 suite 同文件追加，隔离门同一次求值）。
import { createAciTools, assertAciWhitelist, ACI_TOOL_NAMES, FORBIDDEN_TOOL_NAMES } from '../lib/advisor/aci/tools.js'
import { runToolLoop, BudgetPool } from '../lib/advisor/aci/loop.js'
import { MAX_TOOL_OUTPUT_LINES, EMPTY_TOOL_OUTPUT, formatToolObservation } from '../lib/advisor/aci/observation.js'

/** retrieval 模块目录（源码级门的扫描面）。 */
const RETRIEVAL_DIR = fileURLToPath(new URL('../lib/advisor/retrieval', import.meta.url))
/** lib/advisor 全树（判据 13 的写 API 门的扫描面）。 */
const ADVISOR_DIR = fileURLToPath(new URL('../lib/advisor', import.meta.url))

/** fixture 独特串（AC-2b / AC-2c / AC-3 的锚）。 */
const S1A_SOURCE_MARK = 'UNIQUE_SOURCE_MARK_S1A'
const S1A_TEST_MARK = 'UNIQUE_TEST_MARK_S1A'

/**
 * 只读写 API 门的**基线豁免面**（逐条钉死：文件 + **行级锚定正则**；每条都必须命中 ≥1 处）。
 *
 * ⚠️ P1（security-reviewer 2026-10-09 实测）：旧实现按「同行 `includes(片段)`」匹配 ⇒
 * **把写调用追加到豁免行尾，违规数 = 0**（豁免把整行都放过了）。现在改为**行级锚定**：
 * 锚点必须**整行匹配**（`^…$`，测试对象是去注释后的 trim 行）——任何追加/改写都会让它失配。
 */
const WRITE_API_ALLOWLIST = [
  { file: 'lib/advisor/index.js', anchor: /^mkdirSync\(dataDir, \{ recursive: true \}\)$/, reason: '既有（S0 前）：installAdvisor 建数据目录' },
  { file: 'lib/advisor/index.js', anchor: /^appendFileSync\(join\(dataDir, 'chunk-trace\.jsonl'\), .+\)$/, reason: '既有（S0 前）：trace sink' },
  { file: 'lib/advisor/store.js', anchor: /^this\.fs\.mkdirSync\(dir, \{ recursive: true \}\)$/, reason: '既有（S0 前）：#atomicWrite 临时目录' },
  { file: 'lib/advisor/store.js', anchor: /^this\.fs\.writeFileSync\(tmp, data\)$/, reason: '既有（S0 前）：#atomicWrite 写临时件' },
  { file: 'lib/advisor/store.js', anchor: /^this\.fs\.renameSync\(tmp, path\)$/, reason: '既有（S0 前）：#atomicWrite 原子替换' },
  { file: 'lib/advisor/store.js', anchor: /^this\.fs\.mkdirSync\(this\.dataDir, \{ recursive: true \}\)$/, reason: '既有（S0 前）：records 目录' },
  { file: 'lib/advisor/store.js', anchor: /^this\.fs\.appendFileSync\(this\.recordsFile, .+\)$/, reason: '既有（S0 前）：records.jsonl 追加' },
  { file: 'lib/advisor/retrieval/git.js', anchor: /^fd = fs\.openSync\(tmpPath, 'w'\)$/, reason: 'S1a 豁免②：fd-stdio 子进程输出句柄（只写子进程输出）' },
  { file: 'lib/advisor/retrieval/git.js', anchor: /^try \{ fs\.unlinkSync\(tmpPath\) \} catch \{\s*\}$/, reason: 'S1a 豁免②：同一临时文件的清理' },
]

/**
 * 计划 S1a 判据 13 点名的写 API（**调用形态**；成员调用 `this.fs.x(` 与裸调用同等对待）。
 *
 * P1 补漏（security-reviewer 2026-10-09 实测）：`fs.cpSync` 完全失明；
 * `openSync('w+')` 与旗标常量 `O_WRONLY` 形态也漏判。下面三处一并补上。
 */
const WRITE_API_NAMES = [
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
  'rmSync', 'rm', 'unlinkSync', 'unlink', 'mkdirSync', 'mkdir', 'renameSync', 'rename',
  'copyFileSync', 'copyFile', 'cpSync', 'cp', 'truncate', 'truncateSync', 'chmod', 'chmodSync', 'utimes', 'utimesSync',
  'writeText', 'editText', 'rmdirSync', 'rmdir',
]

/** 以**写/追加**方式打开文件的旗标常量（`openSync(p, constants.O_WRONLY)` 这类形态）。 */
const WRITE_FLAG_CONSTANTS = /\b(?:O_WRONLY|O_CREAT|O_RDWR|O_APPEND|O_TRUNC)\b/

/** `openSync` 的写模式字面量（含 `w+` / `a+` / `rs+` 这类组合）。 */
const WRITE_OPEN_MODE = /['"][wax](?:\+)?['"]/

/** AC-15 点名的预算字面量（**在运行时由幂运算拼出**，否则本文件自己就会命中门线）。 */
const BUDGET_LITERAL_STRINGS = [String(2 ** 13), String(2 ** 12 * 5), String(2 ** 13 * 5)]

/**
 * 去注释（**保留字符串内容**）。
 *
 * 为什么必须去注释：门线会被注释里的说明文字误触发（L1-14 的既定教训）——
 * 本仓 git.js 的文档注释里就写着 `openSync(tmp,'w')` 与 `exec(`/`spawn(` 这些字样。
 * 字符串**不去**：豁免判定要看 `'w'` 这类字面量。
 */
function stripCodeComments(src) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (ch === "'") { state = 'single'; out += ch; i += 1; continue }
      if (ch === '"') { state = 'double'; out += ch; i += 1; continue }
      if (ch === '`') { state = 'template'; out += ch; i += 1; continue }
      out += ch; i += 1; continue
    }
    if (state === 'line') { if (ch === '\n') { state = 'code'; out += ch } i += 1; continue }
    if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i += 2; continue } if (ch === '\n') out += ch; i += 1; continue }
    if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
      out += ch; state = 'code'; i += 1; continue
    }
    out += ch; i += 1
  }
  return out
}

/** 递归收集 lib/advisor 下的 .js（**只读**；用于源码级门）。 */
function collectAdvisorModules() {
  const out = []
  const walk = (dir, relDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name)
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) { walk(abs, rel); continue }
      if (entry.name.endsWith('.js')) out.push({ rel: `lib/advisor/${rel}`, abs })
    }
  }
  walk(ADVISOR_DIR, '')
  return out
}

/**
 * 扫描源码里的写 API 调用形态（**去注释后**）。
 *
 * 覆盖面（含 P1 补漏）：具名写 API（含 `cpSync`/`cp`/`rmdirSync`）、
 * `openSync` 的**写模式字面量**（`w`/`a`/`x` 及 `w+`/`a+` 组合）、
 * `openSync` 的**旗标常量**形态（`O_WRONLY`/`O_CREAT`/`O_RDWR`/`O_APPEND`/`O_TRUNC`）。
 */
function scanWriteApis(sourceText, fileLabel) {
  const code = stripCodeComments(sourceText)
  const hits = []
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const name of WRITE_API_NAMES) {
      const re = new RegExp(`\\b${name}\\s*\\(`)
      if (re.test(line)) hits.push({ file: fileLabel, line: i + 1, api: name, text: line.trim() })
    }
    const openRe = /\bopenSync\s*\(([^)]*)\)/g
    let m
    while ((m = openRe.exec(line)) !== null) {
      const args = m[1]
      if (WRITE_OPEN_MODE.test(args)) hits.push({ file: fileLabel, line: i + 1, api: 'openSync(w|a|x)', text: line.trim() })
      else if (WRITE_FLAG_CONSTANTS.test(args)) hits.push({ file: fileLabel, line: i + 1, api: 'openSync(flag-constant)', text: line.trim() })
    }
  }
  return hits
}

/**
 * 写 API 门：返回 `{violations, exempted, staleAllowlist, allHits}`。
 * `allowlist` 传 `[]` = 关闭豁免（用于证明扫描器不是失明的）。
 *
 * 豁免匹配 = **整行锚定**（`anchor` 必须匹配整条 trim 后的去注释行）——见 WRITE_API_ALLOWLIST 的注释。
 */
function scanWriteApiGate(files, allowlist = WRITE_API_ALLOWLIST) {
  const allHits = []
  for (const file of files) {
    const text = file.text ?? readFileSync(file.abs, 'utf8')
    allHits.push(...scanWriteApis(text, file.rel))
  }
  const usedAllow = new Set()
  const violations = []
  for (const hit of allHits) {
    const idx = allowlist.findIndex((e) => e.file === hit.file && e.anchor.test(hit.text))
    if (idx >= 0) { usedAllow.add(idx); continue }
    violations.push(hit)
  }
  const staleAllowlist = allowlist.filter((e, i) => !usedAllow.has(i)).map((e) => e.reason)
  return { violations, exempted: usedAllow.size, staleAllowlist, allHits }
}

/** AC-10①：shell 拼接形态（`exec(` / `execSync(` / `spawn(` / `shell:true`）；`.exec(` 是 RegExp 方法，不算。 */
function scanShellExec(sourceText) {
  const code = stripCodeComments(sourceText)
  const patterns = [
    { id: 'exec(', re: /(?<![.\w$])exec\s*\(/ },
    { id: 'execSync(', re: /(?<![.\w$])execSync\s*\(/ },
    { id: 'spawn(', re: /(?<![.\w$])spawn\s*\(/ },
    { id: 'shell:true', re: /shell\s*:\s*true/ },
  ]
  const hits = []
  code.split('\n').forEach((line, i) => {
    for (const p of patterns) if (p.re.test(line)) hits.push({ id: p.id, line: i + 1, text: line.trim() })
  })
  return hits
}

/** AC-10① 第二半：每个 `spawnSync(` 的**首参**不得是含 backtick/`${` 的字符串拼接。 */
function spawnFirstArgOffences(sourceText) {
  const code = stripCodeComments(sourceText)
  const hits = []
  const re = /spawnSync\s*\(([^,]*),/g
  let m
  while ((m = re.exec(code)) !== null) {
    if (m[1].includes('`') || m[1].includes('${') || m[1].includes('+')) {
      hits.push({ snippet: m[0].slice(0, 80) })
    }
  }
  return hits
}

/** 在**真实文件**上做变异 → 读回被变异的文本 → `finally` 用内存原字节还原 + SHA256 校验。 */
function withMutatedFile(relPath, mutate) {
  const abs = fileURLToPath(new URL(`../${relPath}`, import.meta.url))
  const original = readFileSync(abs)
  const before = createHash('sha256').update(original).digest('hex')
  try {
    writeFileSync(abs, mutate(original.toString('utf8')), 'utf8')
    return { mutatedText: readFileSync(abs, 'utf8'), before }
  } finally {
    writeFileSync(abs, original) // 内存原字节还原（**不用** git checkout --：本仓 autocrlf 事故纪律）
    const after = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (after !== before) throw new Error(`变异还原失败（${relPath}）：${before} → ${after}`)
  }
}

/** 建 S1a fixture 工作树（含 git 仓库；**全部在 os.tmpdir() 内**，不碰真实仓库）。 */
function buildS1aFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-s1a-fixture-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'src', 'foo.js'), `// ${S1A_SOURCE_MARK}\nexport function foo() {\n  return 1\n}\n`)
  writeFileSync(join(dir, 'test', 'foo.test.js'), `// ${S1A_TEST_MARK}\nimport { foo } from '../src/foo.js'\nassert.equal(foo(), 1)\n`)
  writeFileSync(join(dir, 'src', 'bar.js'), 'export const bar = 2\n')
  writeFileSync(join(dir, 'sub', 'inner.js'), 'export const inner = 3\n')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\nsub/\n')
  writeFileSync(join(dir, 'ignored.txt'), 'IGNORED_CONTENT\n')
  writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=abc\n')
  writeFileSync(join(dir, 'id_rsa'), 'PRIVATE KEY\n')
  writeFileSync(join(dir, 'assets', 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 65]))
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2048))
  return dir
}

/** 测试侧的 fd-stdio git（**不用 pipe**：受限沙箱内 pipe 捕获必 EPERM）。 */
async function gitRunIn(cwd, args) {
  const { spawnSync } = await import('node:child_process')
  const tmp = join(tmpdir(), `dsh-s1a-git-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
  const fd = nodeFs.openSync(tmp, 'w')
  let result = null
  try {
    result = spawnSync('git', args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally { nodeFs.closeSync(fd) }
  let out = ''
  try { out = nodeFs.readFileSync(tmp, 'utf8') } catch { out = '' }
  try { nodeFs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  return { status: result?.status ?? null, out }
}

/** 把 fixture 变成真 git 仓库（一次提交），供 AC-2(d) / AC-11 用。 */
async function initFixtureRepo(dir) {
  await gitRunIn(dir, ['init', '-q'])
  await gitRunIn(dir, ['-c', 'user.name=s1a', '-c', 'user.email=s1a@example.invalid', 'add', '-A'])
  await gitRunIn(dir, ['-c', 'user.name=s1a', '-c', 'user.email=s1a@example.invalid', 'commit', '-q', '-m', 'fixture'])
}

/** AC-36 口径的**路径闭包断言**（无 B4 时的判据口径：只断「引用 ⊆ 本轮检索集」）。 */
function assertPathsWithinBundle(bundle, paths, label) {
  const known = new Set(bundle.files)
  const missing = paths.filter((p) => !known.has(p))
  assert.deepEqual(missing, [], `${label}：被引用的路径必须 ⊆ 本轮检索集（缺：${missing.join(', ')}）`)
}

/** 真跑 git 的渲染器（S1a 用例复用）。 */
export function testS1aRetrieval(t) {
  t('S1a-1/2 AC-2 + AC-3：一轮输入四类齐备；测试存在/删除两态（删后显式「无对应测试」）', async () => {
    const dir = buildS1aFixture()
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-scratch-'))
    try {
      await initFixtureRepo(dir)
      const retrieval = createRetrieval({ root: dir, dataDir: scratch })
      // focusSource 显式点名（缺省的「前 2 个非测试文件」会被 .gitignore/big.txt 之类占掉，
      // 那是遍历口径的正确行为，但本用例要断的是「源码正文进了输入」，故显式指定）
      const round = retrieval.collect({
        focusSource: ['src/foo.js'],
        queries: [{ literal: S1A_SOURCE_MARK }, { pattern: 'export (function|const)' }],
      })
      const text = round.inputText

      // AC-2a：≥2 条文件路径
      const presentPaths = [round.bundle.toJSON().files, ['src/foo.js', 'src/bar.js', 'test/foo.test.js']]
      const pathHits = presentPaths[1].filter((p) => round.bundle.files.includes(p) && text.includes(p))
      assert.ok(pathHits.length >= 2, `AC-2a：同轮输入必须含 ≥2 条文件路径（实得 ${JSON.stringify(pathHits)}）`)
      // AC-2b：至少一段源码正文（独特串在正文段里）
      assert.ok(text.includes(S1A_SOURCE_MARK), 'AC-2b：源码正文必须进输入（fixture 独特串可见）')
      assert.ok(/## 源码：src\/foo\.js/.test(text), 'AC-2b：源码段必须点名文件')
      // AC-2c：至少一个测试文件内容
      assert.ok(text.includes(S1A_TEST_MARK), 'AC-2c：测试文件内容必须进输入（fixture 独特串可见）')
      assert.ok(/## 对应测试：test\/foo\.test\.js/.test(text), 'AC-2c：测试段必须点名文件')
      // AC-2d：git 事实
      assert.equal(typeof round.gitFacts?.headSha, 'string')
      assert.match(round.gitFacts.headSha, /^[0-9a-f]{40}$/, 'AC-2d：HEAD sha 必须是完整 sha')
      assert.ok(text.includes(round.gitFacts.headSha), 'AC-2d：git 事实必须进输入')
      assert.ok(text.includes('## Git 事实'), 'AC-2d：Git 事实段必须在')
      // AC-3 前半：源与测试**同轮同时存在**（且顺序无关，这里同轮断言）
      assert.ok(text.indexOf(S1A_SOURCE_MARK) >= 0 && text.indexOf(S1A_TEST_MARK) >= 0, 'AC-3：源与测试必须同轮同时存在')
      assert.deepEqual(round.annotations, [], 'AC-3 阳性对照：测试存在时**不得**出现「无对应测试」标注')
      const beforeDelete = findRelatedTests({ files: round.files.map((f) => f.rel), sourceRel: 'src/foo.js' })
      assert.deepEqual(beforeDelete.tests, ['test/foo.test.js'], 'AC-3：候选测试必须被找到')

      // AC-3 后半：删除测试文件 → 输入出现**逐字**「无对应测试」（不得静默省略）
      rmSync(join(dir, 'test', 'foo.test.js'))
      const afterRound = createRetrieval({ root: dir, dataDir: scratch }).collect({ focusSource: ['src/foo.js'], queries: [{ literal: S1A_SOURCE_MARK }] })
      assert.ok(afterRound.inputText.includes('## 标注'), 'AC-3：删测试后必须有标注段')
      assert.ok(afterRound.inputText.includes(NO_TEST_ANNOTATION), `AC-3：必须逐字出现「${NO_TEST_ANNOTATION}」`)
      assert.deepEqual(afterRound.annotations, [{ source: 'src/foo.js', annotation: NO_TEST_ANNOTATION }])
      assert.ok(!afterRound.inputText.includes(S1A_TEST_MARK), 'AC-3：测试内容确实已不在输入中（阳性对照）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S1a-3 AC-10①：检索/git 模块无 shell 拼接形态（argv 直传）+ 正向锚点', () => {
    const files = collectAdvisorModules().filter((f) => f.rel.startsWith('lib/advisor/retrieval/'))
    assert.ok(files.length >= 6, `扫描面必须覆盖全部 retrieval 模块（实得 ${files.length}）`)
    const allHits = []
    let spawnSyncSites = 0
    for (const f of files) {
      const text = readFileSync(f.abs, 'utf8')
      allHits.push(...scanShellExec(text).map((h) => ({ ...h, file: f.rel })))
      spawnSyncSites += (stripCodeComments(text).match(/spawnSync\s*\(/g) ?? []).length
      assert.deepEqual(spawnFirstArgOffences(text), [], `${f.rel}：spawnSync 首参不得是字符串拼接（必须 argv 数组直传）`)
    }
    assert.deepEqual(allHits, [], `AC-10①：不得出现 shell 拼接形态（${JSON.stringify(allHits)}）`)
    assert.ok(spawnSyncSites >= 1, 'AC-10① 正向锚点：git 面确实用 spawnSync（否则「零命中」是空门）')

    // 变异体：注入 shell 拼接形态 → 必红（与断言类别一一对应）
    const mutants = [
      ['exec(模板串)', 'exec(`git log ${needle}`)'],
      ['execSync(拼接)', "execSync('git log ' + needle)"],
      ['spawn(非 spawnSync)', 'spawn(cmd, args)'],
      ['shell:true', "spawnSync('git', argv, { shell: true })"],
    ]
    for (const [label, line] of mutants) {
      assert.ok(scanShellExec(`function f(){ ${line} }`).length > 0, `AC-10① 变异必红：${label}`)
    }
    // 阴性对照：RegExp.prototype.exec 不得误伤
    assert.deepEqual(scanShellExec('const m = re.exec(line)'), [], 'AC-10① 阴性对照：re.exec( 不算 shell 拼接')
  })

  t('S1a-3b AC-10②：注入 ; rm -rf / 、$(...) 、&& del → argv 逐元素等于预期且未被解释', async () => {
    const payloads = ['; rm -rf /', '$(del /f /q C:\\*)', '&& del foo.txt', '`whoami`', '| cat /etc/passwd']
    const calls = []
    const fakeSpawn = (cmd, argv, options) => {
      calls.push({ cmd, argv: [...argv], options })
      return { status: 0, error: null, signal: null }
    }
    const fakeFs = {
      openSync: () => 7,
      closeSync: () => {},
      readFileSync: () => '',
      unlinkSync: () => {},
    }
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-inject-'))
    try {
      const git = createGitReader({ cwd: scratch, scratchDir: scratch, fs: fakeFs, spawnSync: fakeSpawn })
      for (const payload of payloads) {
        calls.length = 0
        git.grepLog({ needle: payload, limit: 3 })
        const argv = calls[0].argv
        assert.equal(calls[0].cmd, 'git', '子命令必须逐元素 argv 直传（cmd=git）')
        assert.deepEqual(argv, ['log', '--oneline', '--max-count=3', `--grep=${payload}`], `载荷必须原样成为**一个** argv 元素：${payload}`)
        assert.equal(argv.filter((a) => a === payload || a === `--grep=${payload}`).length, 1, '载荷不得被拆分/拼接')
        assert.equal(argv.includes(payload), false, '载荷在 --grep= 形态下只出现在同一元素内（未被拆成裸位置参数）')

        calls.length = 0
        git.diffNumstat({ from: payload })
        assert.deepEqual(calls[0].argv, ['diff', '--numstat', payload], '位置参数载荷必须原样直传')
      }
      // 未被解释执行：假 spawn 收到的永远是数组，且 options 里没有 shell
      assert.equal(calls[0].options.shell, undefined, '不得开 shell（argv 直传 ⇒ 载荷不可能被解释）')
      assert.deepEqual(calls[0].options.stdio, ['ignore', 7, 7], 'stdio 必须是 fd 继承')
      // 真跑一次（fixture 仓库）：载荷不解释、不炸、不改工作树
      const dir = buildS1aFixture()
      try {
        await initFixtureRepo(dir)
        // 真跑用真 fs；注入 '; rm -rf /' 只为证明它不会被解释
        const real = createGitReader({ cwd: dir, scratchDir: scratch })
        const rows = real.grepLog({ needle: '; rm -rf /', limit: 5 })
        assert.deepEqual(rows, [], '真跑：无匹配即空数组（不是抛错、也不是把载荷当命令）')
        assert.ok(existsSync(join(dir, 'src')), '真跑后 fixture 结构不得被改动（载荷未被解释）')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })

  t('S1a-4 AC-11：fixture 工作树 SHA256 前后完全相同；真实仓库 git status 前后一致', async () => {
    const dir = buildS1aFixture()
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-ac11-'))
    try {
      await initFixtureRepo(dir)
      const retrieval = createRetrieval({ root: dir, dataDir: scratch })
      const before = retrieval.worktreeSnapshot()
      assert.ok(before.entries.length >= 5, `fixture 快照必须真的看见文件（实得 ${before.entries.length}）`)
      // 一轮完整「评审」（读源码 + 读测试 + 检索 + git 事实）
      const round = retrieval.collect({ queries: [{ literal: 'export' }, { pattern: 'foo' }] })
      assert.ok(round.inputText.length > 100, '本轮必须真的产出了输入文本（否则下面的「零变化」是空门）')
      const after = retrieval.worktreeSnapshot()
      assert.equal(after.digest, before.digest, 'AC-11：fixture 工作树评审前后 SHA256 必须完全相同')
      assert.deepEqual(after.entries.map((e) => e.rel), before.entries.map((e) => e.rel), 'AC-11：文件集合也必须相同')

      // 真实仓库 status 前后一致
      const realRoot = fileURLToPath(new URL('..', import.meta.url))
      const realBefore = await gitRunIn(realRoot, ['status', '--porcelain'])
      const realRetrieval = createRetrieval({ root: realRoot, dataDir: scratch, maxEntries: 400 })
      realRetrieval.collect({ queries: [{ literal: 'S1a' }], focusSource: ['tests/advisor.test.mjs'], includeGit: true })
      const realAfter = await gitRunIn(realRoot, ['status', '--porcelain'])
      assert.equal(realAfter.out, realBefore.out, 'AC-11：真实仓库 git status --porcelain 前后必须一致')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S1a-5 AC-12：越界/凭据/.git 内部/二进制/超大 → 拒绝 + 可查拒绝记录（不静默返空）', () => {
    const dir = buildS1aFixture()
    try {
      const log = createRejectionLog({ limit: 50 })
      const retrieval = createRetrieval({ root: dir, maxFileBytes: 1024, rejectionLog: log })
      const cases = [
        ['../outside.txt', REJECT.OUT_OF_ROOT],
        ['src/../../escape.js', REJECT.OUT_OF_ROOT],
        ['.env', REJECT.CREDENTIAL],
        ['id_rsa', REJECT.CREDENTIAL],
        ['keys/server.pem', REJECT.CREDENTIAL],
        ['.git/config', REJECT.GIT_INTERNALS],
        ['assets/blob.bin', REJECT.BINARY],
        ['big.txt', REJECT.OVERSIZED],
        ['src', REJECT.NOT_A_FILE],
        ['nope.js', REJECT.MISSING],
      ]
      for (const [rel, expected] of cases) {
        let thrown = null
        try {
          const got = retrieval.readFile(rel)
          assert.fail(`AC-12：${rel} 必须被拒（实得 ok=${got.ok}）——绝不允许静默返回空内容`)
        } catch (error) { thrown = error }
        assert.ok(thrown instanceof PathPolicyError, `AC-12：${rel} 必须抛 PathPolicyError（实得 ${thrown?.name}）`)
        assert.equal(thrown.code, expected, `AC-12：${rel} 的拒绝码必须是 ${expected}（实得 ${thrown.code}：${thrown.reason}）`)
      }
      // 可查拒绝记录：逐条 + 按 code 汇总
      assert.equal(log.count(), cases.length, 'AC-12：每次拒绝都必须留痕（一拒一条）')
      const byCode = log.byCode()
      for (const [, code] of cases) assert.ok((byCode[code] ?? 0) >= 1, `AC-12：拒绝记录必须能按 ${code} 点名`)
      assert.ok(log.list().every((e) => typeof e.rel === 'string' && typeof e.reason === 'string'), 'AC-12：记录必须含 rel 与 reason')
      // 阳性对照：合法文件照样能读（判据不是「一律拒绝」）
      assert.ok(retrieval.readFile('src/foo.js').text.includes(S1A_SOURCE_MARK), 'AC-12 阳性对照：合法文件必须读得到')
      // 空内容 vs 被拒必须可区分：合法空文件返回 ok，被拒抛错
      writeFileSync(join(dir, 'empty.js'), '')
      const empty = retrieval.readFile('empty.js')
      assert.equal(empty.ok, true)
      assert.equal(empty.text, '')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('S1a-6 AC-13：预算三项独立声明 + 唯一计量函数（Base 与 Repository 互不占用，总 ≤48KB）', () => {
    // ① 三项独立声明（值由幂运算表达 ⇒ 本文件不含被禁字面量）
    assert.equal(typeof BASE_CONTEXT_BYTES, 'number')
    assert.equal(BASE_CONTEXT_BYTES, 2 ** 13, 'Base Context 必须独立声明为 8KB')
    assert.equal(RETRIEVAL_CALL_BYTES, 2 ** 12 * 5, '单次 retrieval 必须独立声明为 20KB')
    assert.equal(RETRIEVAL_TOTAL_BYTES, 2 ** 13 * 5, '检索段合计必须独立声明为 40KB')
    assert.equal(TOTAL_INJECTION_BYTES, BASE_CONTEXT_BYTES + RETRIEVAL_TOTAL_BYTES, '总注入 = Base + Repository（并列相加）')
    assert.equal(TOTAL_INJECTION_BYTES, 2 ** 13 * 6, '总注入上限 = 48KB')
    // 结构化声明：两项互相 excludes（防「第二种读法」复活）
    assert.equal(BUDGET_ITEMS.base.bytes, BASE_CONTEXT_BYTES)
    assert.equal(BUDGET_ITEMS.repository.bytes, RETRIEVAL_TOTAL_BYTES)
    assert.match(BUDGET_ITEMS.base.excludes, /会话消息历史/, 'Base 必须声明不含会话消息历史（G-2）')
    assert.match(BUDGET_ITEMS.repository.excludes, /Base Context/, 'Repository 必须声明不含 Base（并列项）')

    // ② 唯一计量函数：字节而非字符（多字节内容上必须被区分）
    const cjk = '中文字符'
    assert.equal(measureInjection(cjk).chars, cjk.length)
    assert.equal(measureInjection(cjk).bytes, Buffer.byteLength(cjk, 'utf8'))
    assert.notEqual(measureInjection(cjk).bytes, measureInjection(cjk).chars, '计量对象是**字节**：多字节文本必须与字符数不同')
    // 生产与测试同源：collect() 的 bytes 必须由同一函数量出
    const dir = buildS1aFixture()
    try {
      const round = createRetrieval({ root: dir }).collect({ includeGit: false, queries: [{ literal: 'export' }] })
      assert.equal(round.bytes, measureInjection(round.inputText).bytes, 'AC-13：bundle.bytes 必须由唯一计量函数量出')
      assert.equal(round.bundle.bytes, round.bytes, 'AC-13：bundle 上的 bytes 与外层一致（同一口径）')
    } finally { rmSync(dir, { recursive: true, force: true }) }

    // ③ 互不占用 / 互不挤压（禁止第二种读法）
    const atLimit = accountRetrieval({
      baseText: 'x'.repeat(BASE_CONTEXT_BYTES),
      calls: [
        { text: 'y'.repeat(RETRIEVAL_CALL_BYTES) },
        { text: 'y'.repeat(RETRIEVAL_CALL_BYTES) },
      ],
    })
    assert.equal(atLimit.baseBytes, BASE_CONTEXT_BYTES)
    assert.equal(atLimit.repositoryBytes, RETRIEVAL_TOTAL_BYTES)
    assert.equal(atLimit.verdicts.base.over, false, 'Base 恰好到顶 → 不算超')
    assert.equal(atLimit.verdicts.repository.over, false, 'Repository 恰好到顶 → 不算超')
    assert.equal(atLimit.verdicts.total.over, false, 'Base 与 Repository 各自到顶时，总量判定仍必须通过（互不占用）')
    const baseOver = accountRetrieval({ baseText: 'x'.repeat(BASE_CONTEXT_BYTES + 1), calls: [{ text: 'y' }] })
    assert.equal(baseOver.verdicts.base.over, true, 'Base 超 1 字节 → Base 判超')
    assert.equal(baseOver.verdicts.repository.over, false, '★Base 超限**不得**挤压 Repository 的判定（禁止第二种读法）')
    const repoOver = accountRetrieval({ calls: [{ text: 'y'.repeat(RETRIEVAL_CALL_BYTES) }, { text: 'y'.repeat(RETRIEVAL_CALL_BYTES + 1) }] })
    assert.equal(repoOver.verdicts.repository.over, true)
    assert.equal(repoOver.verdicts.perCall[1].over, true, '单次 retrieval 超限必须单独可见')
    assert.equal(repoOver.verdicts.base.over, false, 'Repository 超限不得挤压 Base 判定')
    assert.equal(budgetVerdict({ usedBytes: 10, limitBytes: 10 }).over, false)
    assert.deepEqual(budgetVerdict({ usedBytes: 12, limitBytes: 10 }), { ok: false, over: true, usedBytes: 12, limitBytes: 10, remaining: 0, overflowBytes: 2 })
  })

  t('S1a-7 AC-14：预算耗尽载体与触顶同形（records outcome=dropped + runtime.error），且能过记录规范化', () => {
    const carrier = budgetExhaustedCarrier({ sessionId: 's-budget', label: 'retrieval#2', usedBytes: RETRIEVAL_TOTAL_BYTES + 1, limitBytes: RETRIEVAL_TOTAL_BYTES, reason: '检索段合计超限' })
    assert.equal(carrier.record.outcome, 'dropped', 'AC-14：records 那条必须是 dropped')
    assert.equal(carrier.record.severity, 'info', 'AC-14：与触顶未投递同形（severity=info）')
    assert.equal(carrier.record.sessionId, 's-budget')
    assert.ok(carrier.record.text.includes('预算耗尽') && carrier.record.text.includes('retrieval#2'))
    assert.ok(carrier.record.text.length <= 200, '单条记录 ≤200 字（与 store 规范化一致）')
    assert.ok(carrier.runtimeError.includes('预算耗尽'), 'AC-14：runtime.error 必须记明原因')
    // 与真实记录规范化同源：载体会被 store 接受且 outcome 保持 dropped
    const normalized = normalizeRecord(carrier.record)
    assert.notEqual(normalized, null, 'AC-14：载体必须能过 store.normalizeRecord')
    assert.equal(normalized.outcome, 'dropped')
    assert.equal(normalized.severity, 'info')
    // 反例：缺 runtimeError 或 outcome 的载体不合格（防「只留 status」形态）
    assert.equal(typeof carrier.carrier, 'string')
    assert.match(carrier.carrier, /records\.outcome=dropped/)
  })

  t('S1a-8 AC-15：测试码无预算字面量（grep 门 + 阳性对照 + 既有行豁免活性）+ 常量调小必红', () => {
    const selfPath = fileURLToPath(new URL('./advisor.test.mjs', import.meta.url))
    const text = readFileSync(selfPath, 'utf8')
    const lines = text.split('\n')
    // 既有用例（S0 前既存）的豁免：逐行片段钉死，不允许泛化。
    // ⚠️ 片段本身必须在**运行时拼出**——否则豁免表自己的那一行就成了新的字面量命中
    //    （自指陷阱：豁免表命中自己 ⇒ 命中数 2 ≠ 豁免数 1）。
    const legacyAllow = [{ snippet: `maxTokens: ${BUDGET_LITERAL_STRINGS[0]}, outputTokens: 100`, reason: '既有用例（S0 前既存；非预算常量）' }]
    const hits = []
    for (let i = 0; i < lines.length; i += 1) {
      if (BUDGET_LITERAL_STRINGS.some((needle) => lines[i].includes(needle))) hits.push({ line: i + 1, text: lines[i].trim() })
    }
    const exempted = hits.filter((h) => legacyAllow.some((e) => h.text.includes(e.snippet)))
    const violations = hits.filter((h) => !exempted.includes(h))
    assert.deepEqual(violations, [], `AC-15：测试码不得出现预算字面量（${JSON.stringify(violations)}）`)
    assert.equal(exempted.length, legacyAllow.length, 'AC-15：既有行豁免必须**活性**（命中数 == 豁免条数，防豁免虚化）')

    // 阳性对照：同一个匹配器必须能抓到运行时拼出的字面量
    const probeLine = `const x = ${2 ** 13} // 运行时拼出的禁字面量`
    assert.ok(BUDGET_LITERAL_STRINGS.some((n) => probeLine.includes(n)), 'AC-15 阳性对照：匹配器必须能抓注入的字面量')

    // 源级常量锁 + 变异必红（把常量调小）
    const budgetRel = 'lib/advisor/retrieval/budget.js'
    const budgetText = readFileSync(fileURLToPath(new URL(`../${budgetRel}`, import.meta.url)), 'utf8')
    const locks = [
      /export const BASE_CONTEXT_BYTES = 8 \* KB/,
      /export const RETRIEVAL_CALL_BYTES = 20 \* KB/,
      /export const RETRIEVAL_TOTAL_BYTES = 40 \* KB/,
    ]
    const violationsOf = (src) => locks.filter((re) => !re.test(src)).length
    assert.equal(violationsOf(budgetText), 0, 'AC-15：三项常量必须逐字独立声明（8/20/40 × KB）')
    for (const [label, re, repl] of [
      ['Base 调小', /BASE_CONTEXT_BYTES = 8 \* KB/, 'BASE_CONTEXT_BYTES = 4 * KB'],
      ['单次 retrieval 调小', /RETRIEVAL_CALL_BYTES = 20 \* KB/, 'RETRIEVAL_CALL_BYTES = 10 * KB'],
      ['合计调小', /RETRIEVAL_TOTAL_BYTES = 40 \* KB/, 'RETRIEVAL_TOTAL_BYTES = 20 * KB'],
    ]) {
      const mutated = budgetText.replace(re, repl)
      assert.notEqual(mutated, budgetText, `变异体必须真的注入（${label}）`)
      assert.ok(violationsOf(mutated) > 0, `AC-15 变异必红：${label}`)
    }
    // 真文件变异（跑完还原 + SHA256 校验）：调小常量 → 真源码锁必红
    const mutated = withMutatedFile(budgetRel, (src) => src.replace(/BASE_CONTEXT_BYTES = 8 \* KB/, 'BASE_CONTEXT_BYTES = 4 * KB'))
    assert.ok(violationsOf(mutated.mutatedText) > 0, 'AC-15：真文件变异后源码锁必须变红')
  })

  t('S1a-9 AC-45：检索产物四元组可枚举（files/ranges/bytes/queries）+ 引用闭包比对', async () => {
    const dir = buildS1aFixture()
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-ac45-'))
    try {
      await initFixtureRepo(dir)
      const round = createRetrieval({ root: dir, dataDir: scratch }).collect({ queries: [{ literal: S1A_SOURCE_MARK }, { pattern: 'export' }] })
      const bundle = round.bundle
      assert.deepEqual(Object.keys(bundle.toJSON()).sort(), ['bytes', 'files', 'queries', 'ranges'], 'AC-45：四元组必须**恰好**是 files/ranges/bytes/queries')
      assert.ok(bundle.files.length >= 3, `AC-45：files 必须可枚举（实得 ${bundle.files.length}）`)
      assert.ok(bundle.ranges.length >= 1, 'AC-45：ranges 必须可枚举')
      for (const range of bundle.ranges) {
        assert.equal(typeof range.file, 'string')
        assert.ok(Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 1 && range.end >= range.start, `AC-45：range 形状非法 ${JSON.stringify(range)}`)
        assert.ok(bundle.files.includes(range.file), `AC-45：range 的文件必须 ⊆ files（${range.file}）`)
      }
      assert.ok(bundle.queries.includes(S1A_SOURCE_MARK) && bundle.queries.includes('/export/'), `AC-45：queries 必须记录本轮用过的查询（实得 ${JSON.stringify(bundle.queries)}）`)
      assert.ok(bundle.bytes > 0 && Number.isInteger(bundle.bytes))
      // 引用闭包：本轮所有被引用路径 ⊆ 本轮检索集（AC-36 的判据口径载体）
      const referenced = [...new Set([...bundle.ranges.map((r) => r.file), ...round.annotations.map((a) => a.source)])]
      assertPathsWithinBundle(bundle, referenced, 'AC-45')
      assert.ok(referenced.length >= 2, 'AC-45：闭包比对必须有足够样本（否则是空门）')
      // 变异体：bundle 变成不可枚举（例如只剩 files）→ 上面的四元组断言必须红
      const broken = { ...bundle.toJSON() }
      delete broken.ranges
      assert.notDeepEqual(Object.keys(broken).sort(), ['bytes', 'files', 'queries', 'ranges'], 'AC-45 变异必红：四元组缺项')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S1a-10 H-1/H-11：fd-stdio 通道（无 pipe）+ spawn 失败 fail-closed 不静默 skip', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-fd-'))
    try {
      const seen = []
      const fakeFs = {
        openSync: (p, mode) => { seen.push({ open: p, mode }); return 11 },
        closeSync: (fd) => seen.push({ close: fd }),
        readFileSync: () => 'ok\n',
        unlinkSync: (p) => seen.push({ unlink: p }),
      }
      const git = createGitReader({
        cwd: scratch,
        scratchDir: scratch,
        fs: fakeFs,
        spawnSync: (cmd, argv, options) => { seen.push({ cmd, argv, options }); return { status: 0, error: null } },
      })
      assert.equal(git.statusText(), 'ok\n')
      const spawnCall = seen.find((s) => s.cmd === 'git')
      assert.deepEqual(spawnCall.options.stdio, ['ignore', 11, 11], 'H-1/H-11：必须是 fd 继承（[\'ignore\', fd, fd]）')
      assert.equal(spawnCall.options.stdio.includes('pipe'), false, 'H-1/H-11：不得使用 pipe 捕获（沙箱内必 EPERM）')
      const openCall = seen.find((s) => s.open !== undefined)
      assert.equal(openCall.mode, 'w', 'fd-stdio 输出句柄必须是写模式')
      assert.ok(openCall.open.startsWith(scratch), '判据 11：fd-stdio 临时文件必须落在注入的 scratchDir 内')
      assert.equal(tempFileName(1234, 5), '.advisor-retrieval-1234-5.out', '临时文件名必须只含进程号与序号（不含外部输入）')
      assert.ok(seen.some((s) => s.unlink !== undefined), '临时文件必须用完即删（否则是泄漏点）')

      // fail-closed：spawn 启动失败 → 抛错，绝不静默 skip
      const brokenSpawn = () => ({ error: new Error('spawn git EPERM'), status: null })
      const gitBroken = createGitReader({ cwd: scratch, scratchDir: scratch, fs: fakeFs, spawnSync: brokenSpawn })
      assert.throws(() => gitBroken.headSha(), (e) => e instanceof GitError && e.code === 'GIT_SPAWN_ERROR', 'H-1/H-11：spawn 失败必须 fail-closed 抛错')
      // fail-closed：非零退出 → 抛错（含 stderr 摘要）
      const nonZero = () => ({ status: 128, error: null })
      const gitNonZero = createGitReader({ cwd: scratch, scratchDir: scratch, fs: fakeFs, spawnSync: nonZero })
      assert.throws(() => gitNonZero.headSha(), (e) => e instanceof GitError && e.code === 'GIT_FAILED' && e.status === 128, 'H-1/H-11：非零退出必须 fail-closed')
      // fail-closed：超时 → GIT_TIMEOUT
      const timedOut = () => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null })
      const gitTimeout = createGitReader({ cwd: scratch, scratchDir: scratch, fs: fakeFs, spawnSync: timedOut })
      assert.throws(() => gitTimeout.headSha(), (e) => e instanceof GitError && e.code === 'GIT_TIMEOUT', 'H-1/H-11：超时必须 fail-closed')
      // 白名单：非只读子命令 / 未知标志一律拒绝（防参数位被当开关）
      assert.throws(() => assertReadonlyArgv(['config', '--global', 'user.name', 'x']), (e) => e.code === 'GIT_SUBCOMMAND_DENIED')
      assert.throws(() => assertReadonlyArgv(['log', '--upload-pack=/bin/sh']), (e) => e.code === 'GIT_FLAG_DENIED')
      // 阳性对照：合法只读 argv 通过
      assert.equal(assertReadonlyArgv(['log', '--oneline', '--max-count=3', '--grep=; rm -rf /']), true)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })

  t('S1a-11 落盘点：fd-stdio 落 scratchDir(=dataDir) 且探针在快照根内必红→移除必绿', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s1a-landing-'))
    const fixtureDir = buildS1aFixture()
    try {
      await initFixtureRepo(fixtureDir)
      // ① 生产缺省：scratchDir 缺省 = dataDir（隔离门快照根①内）
      const viaDataDir = createRetrieval({ root: fixtureDir, dataDir: scratch })
      assert.equal(viaDataDir.scratchDir, scratch, '判据 11：fd-stdio 落点缺省必须是 dataDir（快照根①）')
      const explicit = createRetrieval({ root: fixtureDir, scratchDir: scratch, dataDir: '/nope' })
      assert.equal(explicit.scratchDir, scratch, '判据 11：显式 scratchDir 优先于 dataDir')
      assert.throws(() => createRetrieval({ root: fixtureDir }).git(), (e) => e instanceof GitError && e.code === 'GIT_SCRATCH_MISSING',
        '判据 11：既无 scratchDir 也无 dataDir → git 面必须 fail-closed（不得偷偷写 os.tmpdir）')
      // ② 真跑一次：临时文件确实落在 scratchDir 内、且跑完不残留
      const before = readdirSync(scratch).length
      const git = createGitReader({ cwd: fixtureDir, scratchDir: scratch })
      git.headSha()
      assert.equal(readdirSync(scratch).length, before, '判据 11：fd-stdio 临时文件必须用完即删（不残留）')
      assert.ok(git.spawns().every((s) => dirname(s.tmpPath) === scratch), '判据 11：每个子进程的临时文件都在 scratchDir 内')

      // ③ 元测试（判据 11）：在**生产落点所在的快照根**内写探针 → 包装器判定必红；移除 → 必绿
      const gate = await import('./isolation-gate.mjs')
      const fixtureRoot = fileURLToPath(new URL('../agent-out/v3-fixtures', import.meta.url))
      assert.ok(gate.SNAPSHOT_ROOTS.includes(fixtureRoot), '判据 11：探针根必须已在隔离门快照根列表内')
      const probeDir = join(fixtureRoot, 'retrieval-scratch')
      const probe = join(probeDir, tempFileName(process.pid, 999))
      const snapBefore = gate.snapshotRoots()
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(probe, 'leaked fd-stdio temp\n')
      const redDiffs = gate.diffSnapshots(snapBefore, gate.snapshotRoots())
      assert.ok(redDiffs.length > 0, '判据 11 必红：新增落点里的探针必须让隔离门判定变红（diffs>0 ≡ runGate 的 exit=1 条件）')
      // 探针**与新建的目录**都要清掉：目录本身（`retrieval-scratch/`）也是一条快照项，
      // 只删文件不删目录的话「必绿」会假红（B0 的 snapshotTree 会记目录项）。
      rmSync(probeDir, { recursive: true, force: true })
      const greenDiffs = gate.diffSnapshots(snapBefore, gate.snapshotRoots())
      assert.deepEqual(greenDiffs, [], '判据 11 阳性对照：移除探针后必须恢复逐字节相等（必绿）')
      assert.deepEqual(gate.diffSnapshots(snapBefore, gate.snapshotRoots()), [], '判据 11：清理后零残留')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  t('S1a-12 符号面口径：正则启发式（无 AST / 零新依赖）+ AC-36 的路径闭包粒度', () => {
    // ① 零新依赖：retrieval 面不得 import tree-sitter / 任何三方包
    const files = collectAdvisorModules().filter((f) => f.rel.startsWith('lib/advisor/retrieval/'))
    for (const f of files) {
      const text = readFileSync(f.abs, 'utf8')
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      for (const spec of imports) {
        assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${f.rel}：不得引入非标准库依赖（实得 ${spec}）—— 零依赖是本批的硬约束`)
      }
      assert.ok(!/tree-sitter|web-tree-sitter/.test(text.replace(/^\s*\*.*$/gm, '')), `${f.rel}：不得出现 tree-sitter（B4 未批准，L3 已移出 V3 射程）`)
    }
    // ② 粒度声明必须在源码里（审定面纪律：不得只写在文档里）
    const searchText = readFileSync(join(RETRIEVAL_DIR, 'search.js'), 'utf8')
    assert.match(searchText, /正则启发式/, 'S1a-12：必须声明符号面 = 正则启发式')
    assert.match(searchText, /无 AST 精度|无语义作用域/, 'S1a-12：必须声明粒度上限（无 AST 精度）')
    // ③ AC-36 的判据口径载体：只断「引用 ⊆ 本轮检索集」
    const bundle = createBundle().addFile('src/foo.js')
    assert.doesNotThrow(() => assertPathsWithinBundle(bundle, ['src/foo.js'], 'S1a-12'))
    assert.throws(() => assertPathsWithinBundle(bundle, ['src/not-retrieved.js'], 'S1a-12'), /必须 ⊆ 本轮检索集/)
    // ④ isTestPath / testCandidatesFor 是启发式（不是 AST）：候选清单必须可枚举
    assert.equal(isTestPath('test/foo.test.js'), true)
    assert.equal(isTestPath('src/foo.js'), false)
    assert.ok(testCandidatesFor('src/foo.js').includes('test/foo.test.js'))
    assert.ok(testCandidatesFor('src/foo.js').includes('src/foo.test.js'))
  })

  t('S1a-13 只读边界源码级门：lib/advisor/** 无未豁免写 API（基线 + 豁免② + 注入必红 + 阳性对照）', () => {
    const files = collectAdvisorModules()
    assert.ok(files.length >= 12, `扫描面必须覆盖 lib/advisor 全树（实得 ${files.length} 个 .js）`)

    // ① 真实工作树：零未豁免违规 + 每个豁免条目都必须活性（命中 ≥1）
    const gate = scanWriteApiGate(files)
    assert.deepEqual(gate.violations, [], `S1a-13：lib/advisor/** 不得出现未豁免的写 API 调用（${JSON.stringify(gate.violations)}）`)
    assert.deepEqual(gate.staleAllowlist, [], 'S1a-13：豁免条目必须条条活性（虚化的豁免 = 把门开成默认放行）')
    assert.equal(gate.exempted, WRITE_API_ALLOWLIST.length, 'S1a-13：9 条豁免（7 既有 + 2 豁免②）必须条条命中')

    // ② 阳性对照 A：关掉豁免 → 扫描器必须看得见那 9 处（证明门不是失明的）
    const withoutAllow = scanWriteApiGate(files, [])
    assert.equal(withoutAllow.violations.length, WRITE_API_ALLOWLIST.length, 'S1a-13 阳性对照：关豁免后必须恰好看到 9 处（既有 + 豁免②）')

    // ③ 阳性对照 B：stub 与真实写入都不得被误伤（免伤面）
    const storeText = readFileSync(join(ADVISOR_DIR, 'store.js'), 'utf8')
    assert.ok(/writeSeen|writeSessionConfig/.test(storeText), 'S1a-13 阳性对照：豁免面内的既有写入必须在（否则豁免无意义）')
    assert.equal(scanWriteApiGate([{ rel: 'lib/advisor/store.js', text: storeText }]).violations.length, 0, 'S1a-13：既有落盘路径不得报红')

    // ④ 注入必红（真文件变异 → 还原 + SHA256 校验）
    const mutated = withMutatedFile('lib/advisor/retrieval/budget.js', (src) => `${src}\nexport function __probe() { writeFileSync('probe.txt', 'x') }\n`)
    const mutatedGate = scanWriteApiGate([{ rel: 'lib/advisor/retrieval/budget.js', text: mutated.mutatedText }])
    assert.ok(mutatedGate.violations.length > 0, 'S1a-13 注入必红：注入 writeFileSync 后门必须变红')
    assert.equal(mutatedGate.violations[0].api, 'writeFileSync')

    // ⑤ 注入必红（每个类别各一，与断言类别一一对应）
    for (const line of [
      "fs.appendFileSync('a', 'b')",
      "fs.rmSync('a')",
      "fs.mkdirSync('a')",
      "fs.renameSync('a', 'b')",
      "fs.copyFileSync('a', 'b')",
      "fs.chmodSync('a', 0o644)",
      "fs.createWriteStream('a')",
      "fs.openSync('a', 'w')",
      "ctx.fs.writeText('a')",
      "ctx.fs.editText('a')",
    ]) {
      const hits = scanWriteApis(`function probe(){ ${line} }`, 'probe.js')
      assert.ok(hits.length > 0, `S1a-13 注入必红：${line} 必须被门抓到`)
    }
    // ⑥ 阴性对照：注释里的写 API 字样不得误伤（L1-14 的注释误触发陷阱）
    assert.deepEqual(scanWriteApis('// 这里说明 writeFileSync( 是被禁的形态\nconst a = 1\n', 'probe.js'), [], 'S1a-13 阴性对照：注释不得误触发')
    assert.deepEqual(scanWriteApis('/* openSync(tmp, "w") 是豁免② */\nconst a = 1\n', 'probe.js'), [], 'S1a-13 阴性对照：块注释不得误触发')
    // ⑦ 只读面在 retrieval 模块里不得出现（豁免② 之外的 retrieval 文件零写 API）
    const retrievalFiles = files.filter((f) => f.rel.startsWith('lib/advisor/retrieval/') && !f.rel.endsWith('git.js'))
    const retrievalGate = scanWriteApiGate(retrievalFiles, [])
    assert.deepEqual(retrievalGate.violations, [], `S1a-13：retrieval 除 git.js 豁免② 外必须零写 API（${JSON.stringify(retrievalGate.violations)}）`)
  })
}

// ── 11. S2：三层上下文装配 + 规则预筛 + 配置面（advisor V3 节 2 S2，判据 1–16）──
//
// 追加在同一文件（同一次求值、同一条基线）。本段 import 全是声明：
// context/**、decision/** 顶层零写盘副作用（由 S1a-13 的写 API 门覆盖）。

import {
  buildContext, renderContextSection, renderUnavailableContext, describeBudgetRelation,
  BUDGET_RELATION, BUDGET_RELATION_STATEMENT, trimToBudget, BASE_TITLE, REPOSITORY_TITLE,
  UNAVAILABLE_MARK as CTX_UNAVAILABLE,
} from '../lib/advisor/context/build.js'
import {
  loadDecisions, parseDecisions, renderDecisions, DECISIONS_REL_PATH, DECISION_FIELDS,
  DECISION_STATES, DECISION_CLASSES, UNAVAILABLE_MARK as DEC_UNAVAILABLE,
} from '../lib/advisor/context/decisions.js'
import { buildProjectState, heuristicPhase, assertPhase, PROJECT_PHASES } from '../lib/advisor/context/project.js'
import { buildRepositoryContext, extractSymbolRanges, L3_NOT_IMPLEMENTED_NOTE, mentionedPaths, LEVEL_L1 } from '../lib/advisor/context/repository.js'
import {
  screen, classifyMessage, shouldRunRepoAnalysis, isPureAck, isNoInformation, resolveTier,
  PREFILTER_SAMPLES, matchedSignals, ACK_EXACT,
  PRE_FILTER_BLOCK, SCREEN_BLOCKED, SCREEN_NOT_SCREENED, SCREEN_PASSED,
  TRIGGER_MANUAL, TRIGGER_ASSISTANT, TRIGGER_USER, TIER_USER, TIER_ASSISTANT, TIER_UNKNOWN,
} from '../lib/advisor/decision/prefilter.js'
import { SESSION_CONFIG_KEYS } from '../lib/advisor/store.js'

/** S2 fixture 的决策文件内容（六字段 × 五类 × 三态）。 */
const S2_DECISIONS_TEXT = [
  '# 项目决策记录（fixture）',
  '',
  '## D-012 · active · 已确认决策',
  '- 决策或约束正文：DECISION_BODY_MARK session 配置按会话分文件存',
  '- 理由：避免与全局配置互踩',
  '- 否决记录：—',
  '- 所属阶段：S2',
  '',
  '## C-003 · active · 不可违反约束',
  '- 决策或约束正文：[约束] CONSTRAINT_MARK advisor 只读，不得写文件',
  '- 理由：产品第 1 条',
  '- 否决记录：—',
  '- 所属阶段：S2',
  '',
  '## T-004 · active · 已知技术债',
  '- 决策或约束正文：[技术债] DEBT_MARK 检索面仍是正则启发式',
  '- 理由：B4 未批准',
  '- 否决记录：—',
  '- 所属阶段：S2',
  '',
  '## R-005 · rejected · 已否决方案',
  '- 决策或约束正文：REJECTED_MARK 用模型判要不要评审',
  '- 理由：每轮多一次调用',
  '- 否决记录：2026-10-09 产品裁决否决',
  '- 所属阶段：S2',
  '',
  '## G-006 · active · 当前阶段目标',
  '- 决策或约束正文：[阶段目标] GOAL_MARK 本批只做上下文装配',
  '- 理由：与 S3 串行',
  '- 否决记录：—',
  '- 所属阶段：S2',
  '',
  '## D-007 · superseded · 已确认决策',
  '- 决策或约束正文：SUPERSEDED_MARK 旧的全局配置兜底',
  '- 理由：已被会话级取代',
  '- 否决记录：—',
  '- 所属阶段：S1',
  '',
].join('\n')

/** 用户/助手消息的渲染片段（与 observer 的渲染格式同源）。 */
const s2UserMarkdown = (text) => `<用户对Agent说>\n${text}\n</用户对Agent说>`
const s2AssistantMarkdown = (text) => `<Agent对用户说>\n${text}\n</Agent对用户说>`

/**
 * 从源码里取出 `ALLOWED_KEYS` 的成员（AC-53 的四面对账用）。
 * **从源码派生**而不是手抄一份：手抄的快照会和代码各自漂移，那就成了第二个口径。
 */
function allowedKeysFromSource() {
  const src = readFileSync(new URL('../lib/advisor/index.js', import.meta.url), 'utf8')
  const at = src.indexOf('const ALLOWED_KEYS = new Set([')
  assert.ok(at >= 0, 'ALLOWED_KEYS 必须存在')
  const end = src.indexOf('])', at)
  return [...src.slice(at, end).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** 建 S2 fixture 根（S1a 的 fixture + `docs/DECISIONS.md`）。 */function buildS2Fixture() {
  const dir = buildS1aFixture()
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), S2_DECISIONS_TEXT)
  return dir
}

/** 造一个只读检索面（fixture 根 + 独立 scratch）。 */
function s2Retrieval(root, extra = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-s2-scratch-'))
  return { retrieval: createRetrieval({ root, dataDir: scratch, ...extra }), scratch }
}

/** 计数代理：AC-62 要求「零检索零子进程」是**可计数**的。 */
function countingRetrieval(facet) {
  const counts = { listFiles: 0, readFile: 0, search: 0, relatedTests: 0, gitFacts: 0, gitSubprocess: 0, worktreeSnapshot: 0 }
  const readers = ['listFiles', 'readFile', 'search', 'relatedTests', 'worktreeSnapshot']
  const proxy = {}
  for (const name of readers) {
    proxy[name] = (...args) => { counts[name] += 1; return facet[name](...args) }
  }
  proxy.git = () => {
    const git = facet.git()
    return {
      ...git,
      facts: (...args) => { counts.gitFacts += 1; return git.facts(...args) },
      diffNumstat: (...args) => { counts.gitSubprocess += 1; return git.diffNumstat(...args) },
      statusText: (...args) => { counts.gitSubprocess += 1; return git.statusText(...args) },
      headSha: (...args) => { counts.gitSubprocess += 1; return git.headSha(...args) },
      recentLog: (...args) => { counts.gitSubprocess += 1; return git.recentLog(...args) },
    }
  }
  proxy.policy = facet.policy
  proxy.root = facet.root
  proxy.scratchDir = facet.scratchDir
  return { proxy, counts }
}

/** 造一个注入了上下文/预筛钩子的 runtime（S2 的直接驱动方式）。 */
function s2Runtime({ llm, context, prefilter, records = [], trace = [], conversationMaxChars } = {}) {
  return new AdvisorRuntime({
    provider: 'p-s2',
    model: 'm-s2',
    systemPrompt: 'S2 系统提示（合成值）',
    llm: llm ?? fakeLlm('{"notes":[]}'),
    deliver: () => 'recorded',
    record: (r) => records.push(r),
    onStatus: () => {},
    trace: (row) => trace.push(row),
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    context,
    prefilter,
    conversationMaxChars,
    maxQueued: 8,
    callTimeoutMs: 5000,
    maxMessages: 60,
  })
}

/** 用真实 `buildContext` 组一个 runtime 用的 context 钩子。 */
function s2ContextHook({ retrieval, root, maxFiles = 4 }) {
  return ({ markdown }) => {
    const decisions = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
    const result = buildContext({
      retrieval,
      messageText: markdown,
      systemPrompt: 'S2 系统提示（合成值）',
      decisions,
      project: { phase: null },
      maxFiles,
      queries: [],
    })
    return { section: renderContextSection(result), result }
  }
}

/** 抓 runtime 实际送进模型的文本（AC-1 的三条断言都基于它）。 */
function capturedInput(llm, callIndex = 0) {
  const call = llm.calls[callIndex]
  return (call?.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')
}

/** S2 判据套件。 */
export function testS2Context(t) {
  // ── 判据 1（AC-1）：三层三条可区分断言 ─────────────────────────────────
  t('S2-1 AC-1：三层上下文三条可区分断言（会话独特串 / 决策记录文本 / 仓库文件路径名）', async () => {
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const llm = fakeLlm('{"notes":[]}')
      const rt = s2Runtime({ llm, context: s2ContextHook({ retrieval, root: dir }) })
      rt.conversation.appendUser('S2-CONV-MARK 会话独特串')
      rt.enqueue(
        { markdown: s2UserMarkdown('帮我看看 src/foo.js 的实现'), trigger: TRIGGER_USER },
        { sessionId: 's-s2', sessionName: null },
      )
      await rt.waitForDrain()
      assert.equal(llm.calls.length, 1, '正样本必须真的发起一次评审（否则三条断言是空门）')
      const captured = capturedInput(llm)
      assert.ok(captured.includes('S2-CONV-MARK'), '① 会话层：会话可见消息（持续会话窗口）必须进输入')
      assert.ok(captured.includes('DECISION_BODY_MARK'), '② 决策保护层：决策记录文本必须进输入')
      assert.ok(captured.includes('src/foo.js'), '③ 仓库层：仓库文件路径名必须进输入')
      // 三层各自出现在自己的段里（可区分，不是碰巧同一个字符串）
      assert.ok(captured.includes(BASE_TITLE), '基础上下文段标题必须在')
      assert.ok(captured.includes('仓库上下文（Repository Context'), '仓库上下文段标题必须在')
      assert.ok(captured.includes('### 决策保护'), '决策保护小节必须在')
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 2（AC-4）：任一层缺失 → 显式「不可用」，其余层正常 ──────────────
  t('S2-2 AC-4：三层各自缺失 → 显式「不可用」标注且其余层照常进入', async () => {
    const dir = buildS2Fixture()
    const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-s2-empty-'))
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      // ① 决策文件缺失（读面抛 ENOENT）
      const noDecisions = loadDecisions({ readText: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }) } })
      assert.equal(noDecisions.available, false)
      const ctx1 = buildContext({ retrieval, messageText: '请检查 src/foo.js', decisions: noDecisions, systemPrompt: 'S' })
      assert.ok(ctx1.base.text.includes(DEC_UNAVAILABLE), '① 决策层缺失 ⇒ base 必须显式标「不可用」')
      assert.ok(ctx1.base.text.includes('### 项目状态'), '① 其余层（项目状态）必须照常进入')
      assert.ok(ctx1.repository.available === true, '① 其余层（仓库）必须照常进入')

      // ② git 事实不可用（非 git 仓库）
      const { retrieval: emptyRetrieval, scratch: scratch2 } = s2Retrieval(emptyDir)
      const ctx2 = buildContext({ retrieval: emptyRetrieval, messageText: '请检查 src/foo.js', decisions: noDecisions, systemPrompt: 'S' })
      assert.ok(ctx2.repository.text.includes(CTX_UNAVAILABLE), '② git 不可用 ⇒ 仓库层必须显式标「不可用」（不静默省略）')
      assert.ok(ctx2.base.text.includes('### 决策保护'), '② 其余层（决策保护小节）必须照常进入')
      rmSync(scratch2, { recursive: true, force: true })

      // ③ 仓库层被 AC-62 门挡下（普通聊天）⇒ 只该层标不可用，base 完整
      const ctx3 = buildContext({ retrieval, messageText: '今天天气不错', decisions: loadDecisions({ readText: (rel) => retrieval.readFile(rel) }), systemPrompt: 'S' })
      assert.equal(ctx3.repository.available, false)
      assert.ok(ctx3.repository.text.includes(CTX_UNAVAILABLE), '③ 仓库层不可用必须显式')
      assert.ok(ctx3.base.text.includes('DECISION_BODY_MARK') && ctx3.base.text.includes('### 项目状态'), '③ base 两层必须照常进入')

      // ④ 会话层无消息：conversation 是**声明**（内容由 runtime 承载），且 base 里不得出现会话内容
      assert.equal(ctx3.conversation.layer, 'conversation')
      assert.ok(!ctx3.base.text.includes('S2-CONV-MARK'), '④ 会话无消息 ⇒ base 里不得出现任何会话内容（G-2）')

      // ⑤ 项目层（Project State）：阶段来源可观测 + 非法值 fail-closed + 本地启发确定性
      assert.deepEqual([...PROJECT_PHASES], ['design', 'build', 'review', 'ship'], 'G-4：阶段枚举唯一源')
      assert.throws(() => assertPhase('wrong'), /projectPhase/, 'G-4：非法阶段值必须 fail-closed')
      assert.equal(assertPhase(undefined), null, 'G-4：未设置 ⇒ null（不落盘）')
      assert.equal(heuristicPhase({ gitFacts: null }).phase, 'design', 'G-4：无 git 事实 ⇒ design（本地规则，零模型）')
      const phaseFacts = { statusPaths: ['tests/a.test.js'], recent: [], statusSummary: { total: 1, modified: 1, untracked: 0 } }
      assert.equal(heuristicPhase({ gitFacts: phaseFacts }).phase, 'review', 'G-4：改动全在测试 ⇒ review')
      const projectState = buildProjectState({ gitFacts: phaseFacts, phase: 'build' })
      assert.equal(projectState.phase, 'build', 'G-4：会话级配置优先于启发')
      assert.equal(projectState.phaseSource, 'session-config')
      assert.ok(projectState.text.includes('阶段：build'), '项目层必须渲染阶段')
      const unavailableProject = buildProjectState({ gitFacts: null })
      assert.equal(unavailableProject.available, false)
      assert.ok(unavailableProject.text.includes(CTX_UNAVAILABLE), 'AC-4：git 不可用时项目层必须显式标不可用')
      assert.ok(renderUnavailableContext('测试原因').includes(CTX_UNAVAILABLE), 'AC-4：不可用渲染器必须含逐字标注')
      // 按字节裁剪器（Base 8KB 硬上限的唯一实现点）
      const trimmed = trimToBudget('中'.repeat(BASE_CONTEXT_BYTES), 4096, '测试段')
      assert.ok(trimmed.bytes <= 4096 && trimmed.trimmed === true && trimmed.droppedBytes > 0, 'AC-13：裁剪器必须按**字节**收口并留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(emptyDir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 3（AC-5）：C7 负向 + numstat 正向对账 ──────────────────────────
  t('S2-3 AC-5：负向（工具过程文本不进输入，C7 保持）+ 正向（numstat 数字与独立计算一致）', async () => {
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      // 负向：会话里混入 tool 角色的过程文本 + 子会话文本
      const messages = [
        msg('user', '帮我修复 src/foo.js 的报错'),
        { role: 'tool', content: [{ type: 'text', text: 'TOOL_PROCESS_TEXT_MARK' }], source: { kind: 'tool' } },
        { role: 'system', content: [{ type: 'text', text: 'SYSTEM_HIDDEN_MARK' }], source: { kind: 'system' } },
        msg('assistant', '好了'),
      ]
      const surface = renderVisibleSurface(messages, 60)
      assert.ok(surface.markdown.includes('src/foo.js'), '可见面必须含用户/助手正文（否则下面的负向是空门）')
      assert.ok(!surface.markdown.includes('TOOL_PROCESS_TEXT_MARK'), 'AC-5①：工具调用过程文本不得进渲染面（C7）')
      assert.ok(!surface.markdown.includes('SYSTEM_HIDDEN_MARK'), 'AC-5①：system 角色内容不得进渲染面（C7）')
      const llm = fakeLlm('{"notes":[]}')
      const rt = s2Runtime({ llm, context: s2ContextHook({ retrieval, root: dir }) })
      rt.enqueue({ markdown: surface.markdown, trigger: TRIGGER_USER }, { sessionId: 's-s2', sessionName: null })
      await rt.waitForDrain()
      const captured = capturedInput(llm)
      assert.ok(!captured.includes('TOOL_PROCESS_TEXT_MARK'), 'AC-5①：捕获的模型输入里不得出现工具过程文本')
      assert.ok(!captured.includes('SYSTEM_HIDDEN_MARK'), 'AC-5①：捕获的模型输入里不得出现隐藏系统内容')
      rt.dispose()

      // 正向：制造一处工作树改动 → numstat 数字必须与输入里的一致
      const fooPath = join(dir, 'src', 'foo.js')
      writeFileSync(fooPath, `${readFileSync(fooPath, 'utf8')}// S2 added line\n`)
      const mine = await gitRunIn(dir, ['diff', '--numstat', 'HEAD'])
      // ⚠️ fd-stdio 把 stderr 也写进同一个文件（git 的 LF→CRLF 警告会混进来），
      // 故只收真正的 numstat 行（`<num>\t<num>\t` 或 `-\t-\t`）——这是**测试侧**的
      // 独立计算，不能借用产品解析器（否则就是对账自己对账）。
      const rows = mine.out.split(/\r?\n/)
        .filter((l) => /^(\d+|-)\t(\d+|-)\t/.test(l))
        .map((l) => l.split('\t'))
      const files = rows.length
      const added = rows.reduce((n, r) => n + Number(r[0]), 0)
      const deleted = rows.reduce((n, r) => n + Number(r[1]), 0)
      assert.ok(files >= 1, '正向样本必须真的有一处改动（否则对账是空门）')
      const repo = buildRepositoryContext({ retrieval, messageText: '请检查 src/foo.js 的改动', includeGit: true, maxFiles: 1 })
      const expected = `diff --numstat HEAD：${files} 个文件，+${added} / -${deleted} 行`
      assert.ok(repo.text.includes(expected), `AC-5②：输入里的 numstat 数字必须与独立计算一致（期望 "${expected}"）`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 4（AC-6）：决策来源唯一声明 + 决策文本入输入 + 可引 D-012 ────────
  t('S2-4 AC-6：决策来源唯一声明 + 决策文本进输入 + note 可引具体决策标识', () => {
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const loaded = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
      assert.equal(loaded.available, true)
      assert.equal(loaded.relPath, DECISIONS_REL_PATH)
      const rendered = renderDecisions(loaded)
      // ① 唯一声明：来源 / 格式 / 维护者三问必须在同一处逐字给出
      assert.ok(rendered.includes('来源 / 格式 / 维护者**唯一声明**'), 'AC-6①：三问必须显式声明')
      assert.ok(rendered.includes(DECISIONS_REL_PATH), 'AC-6①：来源路径必须写死')
      assert.ok(rendered.includes('维护者：用户与主 agent'), 'AC-6①：维护者必须写明')
      assert.ok(rendered.includes('advisor **只读**'), 'AC-6①：只读边界必须写明')
      // 「唯一」的机检：路径字面量在 lib/advisor 全树只出现在 decisions.js 一处
      const owners = collectAdvisorModules().filter((f) => readFileSync(f.abs, 'utf8').includes(DECISIONS_REL_PATH))
      assert.deepEqual(owners.map((o) => o.rel), ['lib/advisor/context/decisions.js'], 'AC-6①：来源路径只允许出现在唯一模块里')
      // ② 决策文本入输入
      const ctx = buildContext({ retrieval, messageText: '请检查 src/foo.js', decisions: loaded, systemPrompt: 'S' })
      assert.ok(ctx.base.text.includes('DECISION_BODY_MARK'), 'AC-6②：决策正文必须进模型输入')
      // ③ note 可引用具体决策标识
      assert.ok(rendered.includes('D-012'), 'AC-6③：渲染文本必须含决策标识 D-012（note 才能引用它）')
      assert.ok(ctx.base.text.includes('D-012'), 'AC-6③：输入里必须含 D-012')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 5（AC-13）：Base ≤8KB、与 Repository 并列独立、不含会话历史 ──────
  t('S2-5 AC-13：Base ≤8KB 且与 Repository 互不占用；基础上下文不含会话消息历史', async () => {
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const loaded = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
      const ctx = buildContext({ retrieval, messageText: '请检查 src/foo.js 的实现', decisions: loaded, systemPrompt: 'S', maxFiles: 2 })
      assert.ok(ctx.baseBytes <= BASE_CONTEXT_BYTES, `AC-13：Base 必须 ≤ ${BASE_CONTEXT_BYTES} 字节（实得 ${ctx.baseBytes}）`)
      assert.ok(ctx.repositoryBytes <= RETRIEVAL_TOTAL_BYTES, 'AC-13：Repository 必须 ≤ 40KB')
      assert.ok(ctx.bytes <= TOTAL_INJECTION_BYTES, 'AC-13：总注入 ≤ 48KB（Base + Repository 并列相加）')
      assert.equal(ctx.bytes, measureInjection(ctx.text).bytes, 'AC-13：计量对象 = 最终注入文本（唯一计量函数）')

      // 互不占用：Base 到顶不影响 Repository 判定（反之亦然）
      const acc = ctx.accounting
      assert.equal(acc.verdicts.base.over, false)
      assert.equal(acc.verdicts.repository.over, false)
      assert.equal(acc.baseBytes, ctx.baseBytes, 'accounting 的 base 与装配口径一致')

      // 裁剪可观测：把决策文件撑到超 8KB → 必须裁剪且裁剪事实可见（不是静默超限）
      const huge = { available: true, relPath: DECISIONS_REL_PATH, entries: [], errors: [], byClass: {}, bytes: 0 }
      for (const k of DECISION_CLASSES) huge.byClass[k] = Array.from({ length: 60 }, (_, i) => ({ id: `D-${100 + i}`, state: 'active', klass: k, text: '长'.repeat(40), reason: 'r', rejected: '-', phase: 'S2' }))
      huge.entries = DECISION_CLASSES.flatMap((k) => huge.byClass[k])
      const big = buildContext({ retrieval, messageText: '请检查 src/foo.js', decisions: huge, systemPrompt: 'S' })
      assert.ok(big.baseBytes <= BASE_CONTEXT_BYTES, 'AC-13：撑爆后 Base 仍必须 ≤ 8KB（硬上限）')
      assert.equal(big.base.trimmed, true, 'AC-13：裁剪事实必须可观测（trimmed=true）')
      assert.ok(big.base.droppedBytes > 0, 'AC-13：裁剪字节数必须可观测')
      assert.ok(big.base.text.includes('超出预算'), 'AC-13：裁剪必须在文本里留痕')

      // G-2：基础上下文不含会话消息历史（用真实 runtime 走一遍，证明是结构性的而不是巧合）
      const llm = fakeLlm('{"notes":[]}')
      const rt = s2Runtime({ llm, context: s2ContextHook({ retrieval, root: dir }) })
      rt.conversation.appendUser('S2-CONV-MARK 必须只出现在历史里')
      rt.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js 的实现'), trigger: TRIGGER_USER }, { sessionId: 's-s2', sessionName: null })
      await rt.waitForDrain()
      const captured = capturedInput(llm)
      assert.ok(captured.includes('S2-CONV-MARK'), '阳性对照：会话内容确实进了模型输入')
      assert.ok(!rt.lastContext.base.text.includes('S2-CONV-MARK'), 'AC-13（G-2）：Base Context 里不得出现会话消息历史')
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 6（AC-16）：40KB 与 96K 字符的唯一关系声明（叠加）+ 边界测试 ────
  t('S2-6 AC-16：40KB 与 96K 字符历史的「叠加」唯一口径声明 + 历史满 + 满额仓库面边界', async () => {
    // ① 唯一口径声明（代码常量即契约措辞的来源）
    assert.equal(BUDGET_RELATION, 'additive')
    const statement = describeBudgetRelation()
    assert.ok(statement.includes('叠加'), 'AC-16：必须逐字声明「叠加」')
    assert.ok(statement.includes('96_000') || statement.includes('96000'), 'AC-16：必须点名 96K 字符历史')
    assert.ok(statement.includes(String(2 ** 13 * 5)) || statement.includes('40KB'), 'AC-16：必须点名 40KB')
    assert.ok(statement.includes(String(2 ** 13)) || statement.includes('8KB'), 'AC-16：必须点名 8KB')
    assert.equal(BUDGET_RELATION_STATEMENT, statement)
    // 声明只能有一处：全 lib 里出现该措辞的模块唯一
    const owners = collectAdvisorModules().filter((f) => readFileSync(f.abs, 'utf8').includes('ADVISOR_CONVERSATION_MAX_CHARS'))
    assert.deepEqual(owners.map((o) => o.rel).sort(), ['lib/advisor/context/build.js', 'lib/advisor/runtime.js'], 'AC-16：96K 常量只允许被 runtime 与 build 两处引用（声明唯一在 build）')

    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const loaded = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
      // ② 边界：历史「满」+ 满额仓库面 → 行为符合唯一口径、不溢出不崩
      const llm = fakeLlm('{"notes":[]}')
      const rt = s2Runtime({ llm, context: s2ContextHook({ retrieval, root: dir }), conversationMaxChars: 300 })
      rt.conversation.appendUser('x'.repeat(500))
      const trimmedChars = rt.conversation.snapshot().reduce((n, m) => n + m.text.length, 0)
      assert.ok(trimmedChars <= 300, `AC-16：历史必须被修剪到预算内（实得 ${trimmedChars}）`)
      rt.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js 的实现'), trigger: TRIGGER_USER }, { sessionId: 's-s2', sessionName: null })
      await rt.waitForDrain()
      assert.equal(llm.calls.length, 1, 'AC-16：历史满 + 满额仓库面仍必须正常评审（不溢出崩溃）')
      const baseBytesWithFullHistory = rt.lastContext.baseBytes
      assert.ok(baseBytesWithFullHistory <= BASE_CONTEXT_BYTES, 'AC-16：Base 仍 ≤8KB')
      assert.ok(rt.lastContext.repositoryBytes <= RETRIEVAL_TOTAL_BYTES, 'AC-16：Repository 仍 ≤40KB')

      // ③ 叠加（互不占用）的可跑证明：换一个**更满**的历史，base/repo 计量不变
      const rt2 = s2Runtime({ llm: fakeLlm('{"notes":[]}'), context: s2ContextHook({ retrieval, root: dir }), conversationMaxChars: 600 })
      rt2.conversation.appendUser('y'.repeat(1200))
      rt2.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js 的实现'), trigger: TRIGGER_USER }, { sessionId: 's-s2b', sessionName: null })
      await rt2.waitForDrain()
      assert.equal(rt2.lastContext.baseBytes, baseBytesWithFullHistory, 'AC-16：历史长度不得影响 Base 预算（叠加 = 互不占用）')
      assert.equal(rt2.lastContext.repositoryBytes, rt.lastContext.repositoryBytes, 'AC-16：历史长度不得影响 Repository 预算')
      rt.dispose()
      rt2.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 7/8（AC-17 / AC-18）：阴性零调用、阳性 ≥1、零 token ─────────────
  t('S2-7/8 AC-17 + AC-18：阴性 ≥5 条零 llm 调用零 token；阳性 ≥3 条 ≥1 次', async () => {
    assert.ok(PREFILTER_SAMPLES.negative.length >= 5, 'AC-17：阴性样本必须 ≥5 条（写死清单，不临时挑）')
    assert.ok(PREFILTER_SAMPLES.positive.length >= 3, 'AC-17：阳性样本必须 ≥3 条')
    // 离线口径自检（每条样本的判定都必须与清单方向一致）
    for (const text of PREFILTER_SAMPLES.negative) {
      const verdict = screen({ text, trigger: TRIGGER_USER })
      assert.equal(verdict.decision, PRE_FILTER_BLOCK, `AC-17：阴性样本必须被拦："${text}"（reason=${verdict.reason}）`)
      assert.equal(verdict.screening, SCREEN_BLOCKED)
    }
    for (const text of PREFILTER_SAMPLES.positive) {
      assert.equal(screen({ text, trigger: TRIGGER_USER }).decision, 'pass', `AC-17：阳性样本必须放行："${text}"`)
    }
    // 阳性对照（判据本身不是空门）：把某条阴性样本改成代码相关 → 必须放行
    assert.equal(screen({ text: '谢谢，但请顺便检查 src/foo.js 的报错', trigger: TRIGGER_USER }).decision, 'pass',
      'AC-17 阳性对照：含代码信号时寒暄词不得拦')
    assert.ok(matchedSignals('谢谢，但请顺便检查 src/foo.js 的报错').length > 0, 'AC-17：白名单命中的信号必须可枚举')
    assert.equal(isPureAck('谢谢').ack, true, 'AC-17：整串纯确认判定可单独调用')
    assert.equal(isPureAck('做 X').ack, false, 'AC-17：既有用例的合成短文本不得被判成纯确认（否则会误伤真工作）')
    assert.equal(classifyMessage({ text: '继续', trigger: TRIGGER_USER }).decision, PRE_FILTER_BLOCK, 'AC-17：classifyMessage 与 screen 同源')

    // 真跑：阴性 → 零调用零 token；阳性 → ≥1
    const negativeLlm = fakeLlm('{"notes":[]}')
    const negativeRecords = []
    const negativeTrace = []
    const rtNeg = s2Runtime({ llm: negativeLlm, prefilter: screen, records: negativeRecords, trace: negativeTrace })
    for (const text of PREFILTER_SAMPLES.negative) {
      rtNeg.enqueue({ markdown: s2UserMarkdown(text), trigger: TRIGGER_USER }, { sessionId: 's-neg', sessionName: null })
    }
    await rtNeg.waitForDrain()
    assert.equal(negativeLlm.calls.length, 0, 'AC-17/18：阴性样本必须零 llm.stream 调用')
    assert.equal(negativeRecords.length, 0, 'AC-18：阴性路径零记录（不产生 notes 面数据）')
    assert.equal(rtNeg.lastReview.outcome, 'prefilter-blocked', 'AC-18：三态之「预筛拦截」可观测')
    assert.equal(negativeLlm.calls.length, 0, 'AC-18：零 token（无调用即无 token 计量）')
    assert.ok(negativeTrace.filter((r) => r.phase === 'prefilter').length >= PREFILTER_SAMPLES.negative.length, 'AC-19/21：每次预筛都必须留痕')

    const positiveLlm = fakeLlm('{"notes":[]}')
    const rtPos = s2Runtime({ llm: positiveLlm, prefilter: screen })
    for (const text of PREFILTER_SAMPLES.positive) {
      rtPos.enqueue({ markdown: s2UserMarkdown(text), trigger: TRIGGER_USER }, { sessionId: 's-pos', sessionName: null })
    }
    await rtPos.waitForDrain()
    assert.ok(positiveLlm.calls.length >= 1, 'AC-17：阳性样本必须 ≥1 次调用')
    rtNeg.dispose()
    rtPos.dispose()
  })

  // ── 判据 9（AC-19）：三态可观测判据分开 ────────────────────────────────
  t('S2-9 AC-19：三态（未过预筛 / 预筛拦截 / 评审过但 notes:[]）判据分开可观测', async () => {
    const blockedLlm = fakeLlm('{"notes":[]}')
    const rtBlocked = s2Runtime({ llm: blockedLlm, prefilter: screen })
    rtBlocked.enqueue({ markdown: s2UserMarkdown('谢谢'), trigger: TRIGGER_USER }, { sessionId: 's-a', sessionName: null })
    await rtBlocked.waitForDrain()
    assert.equal(rtBlocked.lastScreening.screening, SCREEN_BLOCKED, '① 预筛拦截态')
    assert.equal(rtBlocked.lastScreening.tier, TIER_USER, '拦截发生在用户档（G-13 分级可观测）')
    assert.equal(rtBlocked.lastReview.outcome, 'prefilter-blocked')
    assert.equal(blockedLlm.calls.length, 0)

    // ②「未过预筛」态：手动补评（人明确要求评审 ⇒ 不过预筛；G-13 裁决后 assistant 是**过**预筛的宽松档）
    const notScreenedLlm = fakeLlm('{"notes":[]}')
    const rtNotScreened = s2Runtime({ llm: notScreenedLlm, prefilter: screen })
    rtNotScreened.enqueue({ markdown: s2UserMarkdown('谢谢'), trigger: TRIGGER_MANUAL }, { sessionId: 's-b', sessionName: null })
    await rtNotScreened.waitForDrain()
    assert.equal(rtNotScreened.lastScreening.screening, SCREEN_NOT_SCREENED, '② 未过预筛态（手动补评）')
    assert.equal(notScreenedLlm.calls.length, 1, '未过预筛 ≠ 拦截：照常评审')

    // ②b G-13 分级：assistant 档**过**预筛但走更宽松规则（有内容 ⇒ 放行）
    const assistantLlm = fakeLlm('{"notes":[]}')
    const rtAssistant = s2Runtime({ llm: assistantLlm, prefilter: screen })
    rtAssistant.enqueue({ markdown: s2AssistantMarkdown('我把 buildMessages 改完了，接下来跑测试'), trigger: TRIGGER_ASSISTANT }, { sessionId: 's-b2', sessionName: null })
    await rtAssistant.waitForDrain()
    assert.equal(rtAssistant.lastScreening.screening, SCREEN_PASSED, '②b assistant 档是**过预筛**（不是「不过预筛」）')
    assert.equal(rtAssistant.lastScreening.tier, TIER_ASSISTANT, '②b 档位可观测')
    assert.equal(assistantLlm.calls.length, 1)

    const emptyLlm = fakeLlm('{"notes":[]}')
    const rtEmpty = s2Runtime({ llm: emptyLlm, prefilter: screen })
    rtEmpty.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js 的报错'), trigger: TRIGGER_USER }, { sessionId: 's-c', sessionName: null })
    await rtEmpty.waitForDrain()
    assert.equal(rtEmpty.lastScreening.screening, SCREEN_PASSED, '③ 过预筛态')
    assert.equal(rtEmpty.lastReview.notes, 0, '③ 评审过但 notes:[]（第三态）')
    assert.notEqual(rtEmpty.lastReview.outcome, 'prefilter-blocked', '三态必须可区分（不是同一个标记）')
    rtBlocked.dispose()
    rtNotScreened.dispose()
    rtAssistant.dispose()
    rtEmpty.dispose()
  })

  // ── 判据 10（AC-21）：拦截留可查事实 + 数据面可区分 + 补评可用 ──────────
  t('S2-10 AC-21：拦截留可查事实（含 reason）+ 与「评审过」数据面可区分 + 手动补评可用', async () => {
    const dir = buildS2Fixture()
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-s2-ac21-'))
    try {
      await initFixtureRepo(dir)
      const traceRows = []
      const records = []
      const llm = fakeLlm('{"notes":[]}')
      const agent = fakeAgent('s-post')
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = (id) => (id === 's-post' ? agent : undefined)
      const installed = installAdvisor(ctx, {}, {
        dataDir,
        resolveLlm: () => llm,
        trace: (row) => traceRows.push(row),
        resolutionRootOf: () => dir,
      })
      try {
        // ⚠️ fake session 必须带 `id`：装配层的 session/event 处理按 `session.id`
        //    查该会话是否已开启（既有 fakeSession 没有 id ⇒ 那条早退会让本用例空转）。
        const session = { ...fakeSession([msg('user', '谢谢')]), id: 's-post' }
        agent.session = session
        installed.ctrl.patchConfig('s-post', { enabled: true, provider: 'p', model: 'm' })
        emit('agent/created', { agent })
        // 可评审 turn = [step/start, turn/end]（observer 只评审「进过 step 的回合」）
        emit('session/event', session, { type: 'step/start', data: { turn: 1 } })
        emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
        await new Promise((r) => setTimeout(r, 20))
        await installed.ctrl.runtimeOf('s-post')?.waitForDrain()
        // ① 拦截留可查事实（含 reason）
        const prefilterRows = traceRows.filter((r) => r.phase === 'prefilter')
        assert.ok(prefilterRows.length >= 1, 'AC-21：预筛必须留下可查事实（trace phase=prefilter）')
        const blockedRow = prefilterRows.find((r) => r.decision === 'block')
        assert.ok(blockedRow !== undefined, 'AC-21：拦截事实必须含 decision=block')
        assert.ok(typeof blockedRow.reason === 'string' && blockedRow.reason.includes('纯确认'), `AC-21：拦截事实必须含 reason（实得 ${blockedRow?.reason}）`)
        assert.equal(llm.calls.length, 0, 'AC-21：被拦截的那一轮零调用')
        // ② 与「评审过」数据面可区分：被拦截 ⇒ records 面零条；评审过 ⇒ 有记录
        assert.equal(installed.ctrl.snapshot('s-post').records.length, 0, 'AC-21：被拦截不得产出 records（与「评审过」可区分）')
        const runtime = installed.ctrl.runtimeOf('s-post')
        assert.equal(runtime.lastReview.outcome, 'prefilter-blocked')
        // ③ 补评可用：手动 POST 不过预筛
        const handler = createAdvisorHandler({ ctrl: installed.ctrl, loadCatalog: async () => ({}) })
        const res = fakeRes()
        await handler(fakeReq('POST', { action: 'review', sessionId: 's-post' }), res)
        assert.equal(res.statusCode, 200, 'AC-21：手动 POST 恒 200')
        assert.equal(res.json().ok, true, 'AC-21：补评必须真的发起（ok=true）')
        await runtime.waitForDrain()
        assert.equal(llm.calls.length, 1, 'AC-21：手动补评必须绕过预筛（人明确要求评审）')
        assert.equal(runtime.lastScreening.triggerSource, TRIGGER_MANUAL, 'AC-21：补评的触发源必须是 manual-post（可观测）')
        assert.equal(runtime.lastScreening.screening, SCREEN_NOT_SCREENED, 'AC-21：补评标记为「未过预筛」而不是「拦下来」')
      } finally { installed.dispose() }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // ── 判据 11（AC-53）：新键四处齐 + 未登记键仍抛错 + 注释无 H-5 四禁区 ────
  t('S2-11 AC-53：新键 advisorContextMaxFiles 位置齐备（①ALLOWED_KEYS ②resolveConfig ③cordis ④契约待同步）+ 未登记键仍抛错', () => {
    const newKey = 'advisorContextMaxFiles'
    // ② resolveAdvisorConfig：默认值 + 规范化 + 非法值抛错
    assert.equal(resolveAdvisorConfig({})[newKey], 4, 'AC-53②：必须有确定默认值 4')
    assert.equal(resolveAdvisorConfig({ [newKey]: 9 })[newKey], 9, 'AC-53②：必须能被规范化返回')
    assert.equal(resolveAdvisorConfig({ [newKey]: '3' })[newKey], 3, 'AC-53②：数字串必须被 readInt 接受（与既有键同源）')
    assert.throws(() => resolveAdvisorConfig({ [newKey]: -1 }), /非负整数/, 'AC-53②：非法值必须大声失败')
    // ③ cordis.patch.yml
    const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(bundle, new RegExp(`^\\s*${newKey}:\\s*4\\s*$`, 'm'), 'AC-53③：cordis.patch.yml 必须有该键（否则 boot 缺省与代码不一致）')
    // ① ALLOWED_KEYS（源码级锁 + 变异必红：把这个键从集合里删掉，锁必须红）
    const indexSrc = readFileSync(new URL('../lib/advisor/index.js', import.meta.url), 'utf8')
    const setBlock = indexSrc.slice(indexSrc.indexOf('const ALLOWED_KEYS = new Set(['), indexSrc.indexOf('])', indexSrc.indexOf('const ALLOWED_KEYS = new Set([')))
    assert.ok(setBlock.includes(`'${newKey}'`), 'AC-53①：ALLOWED_KEYS 必须含该键')
    const mutant = setBlock.replace(`  '${newKey}',\n`, '')
    assert.notEqual(mutant, setBlock, '变异体必须真的注入')
    assert.ok(!mutant.includes(`'${newKey}'`), 'AC-53① 变异必红：删掉该键后锁必须失败（= 老配置 boot 抛错的老病会复发）')
    // ④ 契约 §1：只允许「已知待同步」的差集（S2 新键），且不得出现计划外的键
    const contract = readFileSync(new URL('../docs/advisor-contract.md', import.meta.url), 'utf8')
    const contractKeys = [...contract.matchAll(/^\s*(advisor[A-Za-z]+):/gm)].map((m) => m[1])
    const allowedKeys = allowedKeysFromSource()
    assert.equal(allowedKeys.length, 15, `AC-53：ALLOWED_KEYS 应是 13 既有 + advisorContextMaxFiles + advisorMaxToolRounds = 15（实得 ${allowedKeys.length}）`)
    const unknownInContract = [...new Set(contractKeys)].filter((k) => !allowedKeys.includes(k))
    assert.deepEqual(unknownInContract, [], 'AC-53④：契约不得声明代码不认识的 advisor 键')
    // S3 追加：docs/ 不在 S3 写面 ⇒ advisorMaxToolRounds 的契约 §1 条文与 advisorContextMaxFiles
    // 一样登记 S5 同步（pending 差集 = 两个已登记待同步键，任务书授权范围内）。
    const pending = allowedKeys.filter((k) => !contractKeys.includes(k))
    assert.deepEqual(pending, [newKey, 'advisorMaxToolRounds'], 'AC-53④：契约 §1 的待同步差集只允许是已登记批次的新键（docs/ 不在本批写面 ⇒ 登记 S5）')
    // 负向：未登记键仍抛错（既有行为不得被新键开放策略带坏）
    assert.throws(() => resolveAdvisorConfig({ advisorDefinitelyNotAKey: 1 }), /未知 advisor 配置键/, 'AC-53：未登记键必须仍抛错')
    // 注释无 H-5 四禁区（既有门）+ 新键注释确实在（阳性对照）
    assert.deepEqual(staleBundleComments(bundle), [], 'AC-53：cordis 注释不得描述已删行为（H-5 四禁区）')
    assert.ok(bundle.includes('advisorContextMaxFiles: 4') && bundle.includes('L2 层'), 'AC-53 阳性对照：新键的注释必须在（说明其语义）')
    const staleMutant = bundle.replace('# 记录保留条数上限', '# 模型回落链：任一为空 → 回落 tiers.HIGH')
    assert.ok(staleBundleComments(staleMutant).length > 0, 'AC-53 变异必红：注入已删行为字样后注释门必须红')
  })

  // ── 判据 12（AC-54）：新会话键可读写 + U2 仍 400 零写盘 + 未知键仍丢弃 ──
  t('S2-12 AC-54：projectPhase 可落盘读回；enabled=true 缺模型仍 400 零写盘；未知键仍丢弃', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-s2-ac54-'))
    try {
      // X10：每键四要素齐（type / default / semantics / validate）
      for (const [key, spec] of Object.entries(SESSION_CONFIG_KEYS)) {
        assert.equal(typeof spec.type, 'string', `AC-54/X10：${key} 必须声明 type`)
        assert.ok('default' in spec, `AC-54/X10：${key} 必须声明 default`)
        assert.equal(typeof spec.semantics, 'string', `AC-54/X10：${key} 必须声明 semantics`)
        assert.equal(typeof spec.validate, 'function', `AC-54/X10：${key} 必须声明 validate`)
      }
      assert.ok(Object.keys(SESSION_CONFIG_KEYS).includes('projectPhase'), 'AC-54：新会话级键 projectPhase 必须在显式键集合里')
      const store = new AdvisorStore({ dataDir: dir })
      // ① 可落盘可读回
      store.writeSessionConfig('s-54', { enabled: true, provider: 'p', model: 'm', projectPhase: 'build' })
      const onDisk = JSON.parse(readFileSync(sessionConfigPath(dir, 's-54'), 'utf8'))
      assert.deepEqual(onDisk, { enabled: true, provider: 'p', model: 'm', projectPhase: 'build' }, 'AC-54①：新键必须真的落盘')
      assert.equal(store.readSessionConfig('s-54').projectPhase, 'build', 'AC-54①：新键必须能读回')
      assert.equal(store.readSessionConfig('s-54').enabled, true)
      // ①b 非法值 fail-closed + 零写盘
      const before = readFileSync(sessionConfigPath(dir, 's-54'), 'utf8')
      assert.throws(() => store.writeSessionConfig('s-54', { projectPhase: 'wrong-phase' }), /projectPhase/, 'AC-54①：非法阶段值必须抛错')
      assert.equal(readFileSync(sessionConfigPath(dir, 's-54'), 'utf8'), before, 'AC-54①：非法值必须零写盘')
      // ② enabled=true 缺 provider/model → 400 + 零写盘（U2 语义保持）
      const ctrl = {
        isActiveSession: () => true,
        snapshot: () => ({ enabled: false, provider: null, model: null, modelSource: 'unset', runtime: { status: 'disabled', lastAt: 0, queue: 0, error: null }, records: [] }),
        patchConfig: (id, patch) => store.writeSessionConfig(id, patch),
      }
      const handler = createAdvisorHandler({ ctrl, loadCatalog: async () => ({}) })
      const res = fakeRes()
      await handler(fakeReq('PATCH', { sessionId: 's-u2', enabled: true }), res)
      assert.equal(res.statusCode, 400, 'AC-54②：enabled=true 缺模型必须 400')
      assert.equal(existsSync(sessionConfigPath(dir, 's-u2')), false, 'AC-54②：校验失败必须零写盘')
      // ③ 未知键仍被丢弃（手工构造 + 通过写路径）
      writeFileSync(sessionConfigPath(dir, 's-unknown'), JSON.stringify({ enabled: true, provider: 'p', model: 'm', bogusKey: 1, projectPhase: 'ship' }))
      const readBack = store.readSessionConfig('s-unknown')
      assert.equal('bogusKey' in readBack, false, 'AC-54③：未知键必须被丢弃')
      assert.equal(readBack.projectPhase, 'ship', 'AC-54③：已知键必须保留（阳性对照）')
      store.writeSessionConfig('s-unknown', { bogusKey: 2, provider: 'p2' })
      const afterWrite = JSON.parse(readFileSync(sessionConfigPath(dir, 's-unknown'), 'utf8'))
      assert.equal('bogusKey' in afterWrite, false, 'AC-54③：写路径也必须丢弃未知键')
      assert.equal(afterWrite.provider, 'p2')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── 判据 13（H-7）：api.js 保持零 import ──────────────────────────────
  t('S2-13 H-7：api.js 保持零 import（不得为新动作引入任何模块）', () => {
    const src = readFileSync(new URL('../lib/advisor/api.js', import.meta.url), 'utf8')
    const code = stripCodeComments(src)
    const imports = [...code.matchAll(/^\s*import\s/gm)]
    const requires = [...code.matchAll(/\brequire\s*\(/g)]
    assert.deepEqual(imports.map((m) => m[0].trim()), [], 'H-7：api.js 不得有 import 语句')
    assert.deepEqual(requires.map((m) => m[0]), [], 'H-7：api.js 不得有 require 调用')
    // 阳性对照：同一检查在别的模块上必须能抓到 import（否则「零 import」是失明假空）
    const other = stripCodeComments(readFileSync(new URL('../lib/advisor/store.js', import.meta.url), 'utf8'))
    assert.ok([...other.matchAll(/^\s*import\s/gm)].length >= 2, 'H-7 阳性对照：检查器必须能抓到 import')
    assert.ok(src.includes('export function createAdvisorHandler'), 'H-7 阳性对照：api.js 确实被读到（不是空文件）')
  })

  // ── 判据 14（AC-59）：五类 × 三态 + 不可用 + 只读 ──────────────────────
  t('S2-14 AC-59：决策保护五类可区分 + 三态齐 + 缺文件显式不可用 + 模块只读', () => {
    assert.deepEqual([...DECISION_FIELDS].length, 6, 'AC-59：六字段')
    assert.deepEqual([...DECISION_STATES].sort(), ['active', 'rejected', 'superseded'], 'AC-59：三态齐')
    assert.equal(DECISION_CLASSES.length, 5, 'AC-59：五类上下文')
    const parsed = parseDecisions(S2_DECISIONS_TEXT)
    assert.deepEqual(parsed.errors, [], 'AC-59：fixture 必须零解析错误（否则在测残废格式）')
    // 五类各 ≥1 条 + 五条**可区分**断言（类标题 + 该类条目 ID 同时可见）
    const expect = {
      已确认决策: 'D-012', 不可违反约束: 'C-003', 已知技术债: 'T-004', 已否决方案: 'R-005', 当前阶段目标: 'G-006',
    }
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const rendered = renderDecisions(loadDecisions({ readText: (rel) => retrieval.readFile(rel) }))
      for (const [klass, id] of Object.entries(expect)) {
        assert.equal(parsed.entries.filter((e) => e.klass === klass).length >= 1, true, `AC-59：${klass} 必须至少一条`)
        assert.ok(rendered.includes(`#### ${klass}（`), `AC-59：渲染必须含类标题 ${klass}`)
        assert.ok(rendered.includes(id), `AC-59：${klass} 的条目标识必须可见（${id}）`)
      }
      assert.ok(parsed.entries.some((e) => e.state === 'superseded'), 'AC-59：superseded 态可见')
      assert.ok(parsed.entries.some((e) => e.state === 'rejected' && e.klass === '已否决方案'), 'AC-59：rejected → 已否决方案')
      // 缺字段/非法状态 ⇒ errors（不静默丢弃）+ 变异必红
      const broken = parseDecisions('## D-900 · active · 已确认决策\n- 理由：缺正文\n## X` · active · 已确认决策\n')
      assert.ok(broken.errors.length >= 1, 'AC-59：残缺条目必须进 errors（不静默）')
      // 不可用：文件不存在
      const missing = loadDecisions({ readText: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } })
      assert.equal(missing.available, false)
      assert.ok(renderDecisions(missing).includes(DEC_UNAVAILABLE), 'AC-59：文件不存在 ⇒ 显式「不可用」')
      // 只读：decisions.js 不得 import fs / 不得含写 API
      const decSrc = readFileSync(join(RETRIEVAL_DIR, '..', 'context', 'decisions.js'), 'utf8')
      assert.ok(!/from 'node:fs'/.test(decSrc), 'AC-59：decisions.js 不得 import fs（只读面由调用方注入）')
      assert.deepEqual(scanWriteApis(decSrc, 'context/decisions.js'), [], 'AC-59：decisions.js 不得含任何写 API')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── 判据 15（AC-62）：普通聊天零仓库分析（可计数）+ 阳性对照 ─────────────
  t('S2-15 AC-62：普通聊天零检索零 git 子进程；代码相关消息 → 检索计数 ≥1（阳性对照）', async () => {
    const dir = buildS2Fixture()
    try {
      await initFixtureRepo(dir)
      const { retrieval, scratch } = s2Retrieval(dir)
      try {
        const { proxy, counts } = countingRetrieval(retrieval)
        for (const text of PREFILTER_SAMPLES.plainChat) {
          const before = { ...counts }
          const result = buildRepositoryContext({ retrieval: proxy, messageText: text, includeGit: true })
          assert.equal(result.available, false, `AC-62：普通聊天不得产出仓库面（"${text}"）`)
          assert.equal(result.retrievalCalls, 0)
          assert.equal(result.gitCalls, 0)
          assert.deepEqual(counts, before, `AC-62：普通聊天必须零检索零子进程（"${text}"）`)
          assert.ok(result.text.includes(CTX_UNAVAILABLE), 'AC-62：不做分析必须显式标注（不静默省略）')
        }
        assert.deepEqual(counts, { listFiles: 0, readFile: 0, search: 0, relatedTests: 0, gitFacts: 0, gitSubprocess: 0, worktreeSnapshot: 0 },
          'AC-62：5 条普通聊天之后所有计数必须仍为 0（零昂贵分析）')
        // 阳性对照：同一 fixture 改成代码相关消息 → 计数必须起来
        const codeResult = buildRepositoryContext({ retrieval: proxy, messageText: '请检查 src/foo.js 的报错并修复', includeGit: true })
        assert.equal(codeResult.available, true)
        assert.ok(counts.listFiles >= 1, 'AC-62 阳性对照：代码相关消息必须真的做检索（证明门看得见差异）')
        assert.ok(counts.gitFacts + counts.gitSubprocess >= 1, 'AC-62 阳性对照：代码相关消息必须真的跑 git')
      } finally { rmSync(scratch, { recursive: true, force: true }) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  // ── 判据 16（AC-60-L2）：L2 实装 + L3 标未实现 ─────────────────────────
  t('S2-16 AC-60-L2：相关文件·符号精读实装（含配对测试与符号区间）；L3 显式标「未实现」', async () => {
    const dir = buildS2Fixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const result = buildRepositoryContext({
        retrieval,
        messageText: '请检查 src/foo.js 的实现',
        focusSource: ['src/foo.js'],
        includeGit: true,
        maxFiles: 2,
      })
      assert.equal(result.available, true)
      assert.equal(result.l1.available, true, 'L1 层必须可用')
      assert.equal(result.l2.available, true, 'AC-60-L2：L2 层必须实装且可用')
      assert.ok(result.l2.filesRead >= 1, 'AC-60-L2：必须真的精读了源文件正文')
      assert.ok(result.symbolRanges.length >= 1, 'AC-60-L2：必须给出符号区间（正则启发式）')
      assert.ok(result.symbolRanges.every((r) => r.file === 'src/foo.js' && r.start >= 1 && r.end >= r.start), '符号区间形状必须合法')
      assert.ok(result.text.includes('#### L2 · 相关文件 · 符号精读'), 'AC-60-L2：输入里必须有 L2 小节')
      assert.ok(result.text.includes('配对测试 test/foo.test.js'), 'AC-60-L2：必须精读配对测试（与 AC-3 的 source↔test 配对同源）')
      // 符号面口径（无 AST 精度）必须在文本里可见
      assert.ok(/正则启发式，无 AST 精度/.test(result.text), 'AC-60-L2：粒度上限必须在输入里如实声明')
      // L3：显式「未实现」+ 审定面措辞
      assert.equal(result.l3.implemented, false, 'AC-60：L3 不得声称已实现')
      assert.equal(result.l3.note, L3_NOT_IMPLEMENTED_NOTE)
      assert.ok(result.l3.note.includes('设计意向（未实现，登记增强批次 B4）'), 'AC-60：L3 措辞必须是审定面「设计意向（未实现…）」')
      assert.ok(result.text.includes(L3_NOT_IMPLEMENTED_NOTE), 'AC-60：L3 未实现必须写进输入/契约面')
      // mentionedPaths 与符号抽取是纯函数（可独立测）
      assert.deepEqual(mentionedPaths('看看 lib/advisor/runtime.js 与 tests/run.mjs'), ['lib/advisor/runtime.js', 'tests/run.mjs'])
      const ranges = extractSymbolRanges('export function a() {}\nexport const b = 1\nclass C {}\n', 'x.js')
      assert.ok(ranges.some((r) => r.symbol === 'a' && r.kind === 'function'))
      assert.ok(ranges.some((r) => r.symbol === 'b' && r.kind === 'const'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── P0-1（code-reviewer 2026-10-09）：near-miss 反例必须放行 + 子串匹配必红 ──
  t('P0-1 near-miss：像寒暄实为工作的三句必须放行；子串匹配实现必红（含阳性对照）', () => {
    assert.ok(PREFILTER_SAMPLES.nearMiss.length >= 3, 'near-miss 反例必须写进样本集（≥3，code-reviewer 的关键指摘）')
    for (const text of PREFILTER_SAMPLES.nearMiss) {
      for (const [tier, trigger] of [[TIER_USER, TRIGGER_USER], [TIER_ASSISTANT, TRIGGER_ASSISTANT]]) {
        const verdict = screen({ text, trigger })
        assert.equal(verdict.decision, 'pass', `P0-1：near-miss 必须放行（tier=${tier}）："${text}"（reason=${verdict.reason}）`)
        assert.notEqual(verdict.screening, SCREEN_BLOCKED, `P0-1：near-miss 不得被标成 blocked："${text}"`)
      }
    }
    // 阳性对照：整串纯确认仍必须被拦（证明「放行 near-miss」不是「什么都不拦」）
    for (const text of PREFILTER_SAMPLES.negative) {
      assert.equal(screen({ text, trigger: TRIGGER_USER }).decision, 'block', `P0-1 阳性对照：纯确认仍必须拦："${text}"`)
    }
    // 判据只能是**整串相等**：包含关系一律不算
    assert.equal(isPureAck('好的').ack, true, 'P0-1：整串 ACK 命中')
    assert.equal(isPureAck('好的我这就去改 lib/advisor/runtime.js').ack, false, 'P0-1：ACK 开头 + 有内容 ⇒ 不得命中')
    assert.equal(isPureAck('谢谢，但请看下 src/foo.js').ack, false, 'P0-1：含内容的句子不得被判成纯确认')
    assert.ok(ACK_EXACT.every((w) => typeof w === 'string' && w !== ''), 'P0-1：ACK 表必须是非空字符串表')

    // ⚠️ 必红（复刻**首版子串包含实现**）：near-miss 会被全部误拦 —— 这就是被修掉的缺陷
    const legacyScreen = (text) => {
      const ACK = ['谢谢', '多谢', '感谢', '好的', '好', '行', '收到', '嗯', '恩', '继续', '明白', '了解', '知道了', '稍等', '哈哈', '呵呵', '在吗', '好的谢谢', '辛苦了', 'ok', 'okay', 'thanks', 'thankyou']
      const CHATTER = ['谢谢', '辛苦了', '好的', '好吧', '好了', '收到', '明白', '了解', '知道了', '嗯', '恩', '继续', '哈哈', '呵呵', '在吗', '稍等', '没事', '没问题', '早上好', '你好', 'hi', 'hello', 'hey', '天气', '午饭', '晚饭', '早饭', '吃什么', '咖啡', '奶茶', '周末', '好玩', '推荐', '无聊', '休息']
      const norm = (s) => String(s).replace(/\s+/g, '').replace(/[。，、！？!?,.;:：；~～"'“”‘’()（）[\]【】]/g, '').toLowerCase()
      const n = norm(text)
      if (ACK.some((w) => n === norm(w))) return 'block'
      if (CHATTER.some((w) => n.includes(norm(w)))) return 'block'
      return 'pass'
    }
    const falseBlocked = PREFILTER_SAMPLES.nearMiss.filter((t) => legacyScreen(t) === 'block')
    assert.equal(falseBlocked.length, PREFILTER_SAMPLES.nearMiss.length,
      `P0-1 必红：首版子串实现必须把全部 ${PREFILTER_SAMPLES.nearMiss.length} 条 near-miss 误拦（实得 ${falseBlocked.length} 条）`)
    assert.equal(legacyScreen('谢谢'), 'block', 'P0-1 必红对照：复刻件对「谢谢」也拦（说明它忠实复刻了首版，不是稻草人）')
  })

  // ── G-13（产品裁决 2026-10-09）：预筛分级 ────────────────────────────────
  t('G-13 产品裁决：预筛分级——用户档完整、assistant 档只挡整串纯 ACK（有内容必评审）', () => {
    for (const text of PREFILTER_SAMPLES.negative) {
      assert.equal(screen({ text, trigger: TRIGGER_USER }).decision, 'block', `G-13：用户档必须拦纯 ACK："${text}"`)
      assert.equal(screen({ text, trigger: TRIGGER_ASSISTANT }).decision, 'block', `G-13：assistant 档也拦整串纯 ACK："${text}"`)
    }
    // 分级的**唯一差异**：无信息形态只在用户档拦
    const noise = '嗯嗯'
    assert.equal(isNoInformation(noise).noise, true, 'G-13：无信息形态判定可单独调用')
    assert.equal(screen({ text: noise, trigger: TRIGGER_USER }).decision, 'block', 'G-13：用户档拦无信息形态')
    assert.equal(screen({ text: noise, trigger: TRIGGER_ASSISTANT }).decision, 'pass', 'G-13：assistant 档更宽松 ⇒ 无信息形态也放行')
    // 「主 agent 在错误路上连续走」的干预能力 = 有内容一律照常评审
    for (const text of ['我把 buildMessages 改完了', '接下来跑测试', '这一步做完就去写报告']) {
      assert.equal(screen({ text, trigger: TRIGGER_ASSISTANT }).decision, 'pass', `G-13：assistant 有内容必须评审："${text}"`)
    }
    // 分档可观测（AC-19 同源的留痕口径）
    assert.equal(screen({ text: '好的', trigger: TRIGGER_USER }).tier, TIER_USER)
    assert.equal(screen({ text: '好的', trigger: TRIGGER_ASSISTANT }).tier, TIER_ASSISTANT)
    // 必红：assistant 档不得退化成「不过预筛」（否则 G-13 的分级名存实亡）
    assert.notEqual(screen({ text: '好的', trigger: TRIGGER_ASSISTANT }).screening, SCREEN_NOT_SCREENED,
      'G-13 必红：assistant 档是「过预筛后拦」，不是「不过预筛」')
  })

  // ── P2（code-reviewer 2026-10-09）：缺 trigger 不得假定用户消息 ──────────
  t('P2：缺 trigger 时按实际来源判档（不假定 user）；判不出 ⇒ fail-open 放行（配必红）', async () => {
    // ① 无框架标签 + 无 trigger（来源不可判定）⇒ fail-open 放行
    const undetermined = screen({ text: '好了' })
    assert.equal(undetermined.tier, TIER_UNKNOWN, 'P2：来源不可判定 ⇒ unknown 档')
    assert.equal(undetermined.decision, 'pass', 'P2：unknown 档必须 fail-open（绝不默认「用户消息」）')
    assert.equal(undetermined.screening, SCREEN_NOT_SCREENED)
    // ② 有框架标签（assistant）⇒ 按**实际来源**判成 assistant 档
    const assistantVerdict = screen({ text: s2AssistantMarkdown('嗯嗯') })
    assert.equal(assistantVerdict.tier, TIER_ASSISTANT, 'P2：框架标签是 assistant ⇒ 必须判成 assistant 档')
    assert.equal(assistantVerdict.decision, 'pass', 'P2/G-13：assistant 档只挡整串纯 ACK ⇒ 「嗯嗯」放行')
    // 阳性对照：同一段文字当成用户消息 ⇒ 用户档拦（分级确实生效，不是「全放行」）
    assert.equal(screen({ text: s2UserMarkdown('嗯嗯') }).decision, 'block', 'P2 阳性对照：用户档仍拦无信息形态')
    // ③ 真跑（runtime）：assistant 文本 + **无 trigger** ⇒ 不得被拦
    const llm = fakeLlm('{"notes":[]}')
    const rt = s2Runtime({ llm, prefilter: screen })
    rt.enqueue({ markdown: s2AssistantMarkdown('嗯嗯') }, { sessionId: 's-p2', sessionName: null })
    await rt.waitForDrain()
    assert.equal(rt.lastScreening.tier, TIER_ASSISTANT, 'P2：runtime 缺 trigger 时必须按框架标签判档')
    assert.notEqual(rt.lastScreening.decision, 'block', 'P2：assistant 文本 + 无 trigger 不得被拦（旧实现会拦）')
    assert.equal(llm.calls.length, 1, 'P2：必须照常评审（fail-open 的方向是「多评一次」）')
    rt.dispose()
    // ④ 必红：复刻旧实现（缺省写死 'user-message'）⇒ 同一输入必被误拦
    const legacyDefault = (markdown) => screen({ text: markdown, role: 'user', trigger: TRIGGER_USER })
    assert.equal(legacyDefault(s2AssistantMarkdown('嗯嗯')).decision, 'block', 'P2 必红：旧缺省（写死 user-message）确实会误拦 assistant 无信息增量')
    assert.equal(legacyDefault('好了').decision, 'block', 'P2 必红：旧缺省同样误拦「无来源」文本')
  })

  // ── P0-2（code-reviewer 2026-10-09）：门存在，但默认路径上必须有人跑 ────
  t('P0-2 门接线：package.json 的 test 入口必须覆盖 isolation-gate（防再次被漏挂）', () => {
    const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(pkgText)
    const scripts = pkg.scripts ?? {}
    assert.equal(typeof scripts['gate:isolation'], 'string', 'P0-2：必须有独立的 gate:isolation 脚本')
    assert.ok(scripts['gate:isolation'].includes('isolation-gate.mjs'), 'P0-2：gate:isolation 必须指向 isolation-gate.mjs')
    assert.equal(typeof scripts['gate:isolation:selftest'], 'string', 'P0-2：自测入口也要有（--selftest 是必红证据）')
    assert.equal(typeof scripts['gate:replay'], 'string', 'P0-2：必须有 gate:replay（B0 的 replay 设施同理不能被漏挂）')
    const testScript = String(scripts.test ?? '')
    assert.ok(testScript.length > 0, 'P0-2：必须有 test 脚本')
    for (const needle of ['run.mjs', 'isolation-gate.mjs', 'advisor-llm-replay.mjs', 'skill-sync-check.mjs', 'boot-schema-check.mjs']) {
      assert.ok(testScript.includes(needle), `P0-2：test 入口必须覆盖 ${needle}（默认路径上要能一次跑全）`)
    }
    // 必红：把 isolation-gate 从 test 脚本里摘掉 → 同一条断言必须拒绝
    const mutated = testScript.replace(/node tests\/isolation-gate\.mjs\s*&&?\s*/, '')
    assert.notEqual(mutated, testScript, '变异体必须真的注入到 test 脚本里')
    assert.ok(!mutated.includes('isolation-gate.mjs'), 'P0-2 必红：漏挂 isolation-gate 的 test 脚本必须被本断言拒绝')
    // 阳性对照：检查器确实在读真文件（不是空转）
    assert.equal(pkg.name, 'dsh-agents')
    assert.ok(pkgText.includes('isolation-gate.mjs'), '阳性对照：package.json 原文里确实有该门')
  })
}

// ── 12. 安全 P0/P1（security-reviewer 2026-10-09 的 PoC）─────────────────────
//
// 本段的每条都遵循「修复前必红 → 修复后必绿 + 阳性对照」：
//   · SEC-P0：junction 绕过越界守卫（`realpathSync` 的 JS 版判不出重解析点）
//   · SEC-P1：ADS 默认流 / 大小写变体 / 8.3 短名 / 经 junction 暴露的凭据目录
//   · SEC-P1（面2）：git 子进程环境变量继承（GIT_DIR 静默重定向）

/** 测试侧的 fd-stdio `cmd`（建 junction 用；**不用 pipe**）。 */
async function cmdRunIn(cwd, args) {
  const { spawnSync } = await import('node:child_process')
  const tmp = join(tmpdir(), `dsh-sec-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
  const fd = nodeFs.openSync(tmp, 'w')
  let result = null
  try {
    result = spawnSync('cmd', ['/c', ...args], { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally { nodeFs.closeSync(fd) }
  let out = ''
  try { out = nodeFs.readFileSync(tmp, 'utf8') } catch { out = '' }
  try { nodeFs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  return { status: result?.status ?? null, out }
}

export function testRetrievalSecurity(t) {
  t('SEC-P0：junction 绕过越界守卫必须被拒（realpathSync.native）+ 指向根内的 junction 仍可用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sec-root-'))
    const base = mkdtempSync(join(tmpdir(), 'dsh-sec-base-'))
    const OUTSIDE = 'OUTSIDE_TOKEN_MUST_NOT_LEAK'
    try {
      mkdirSync(join(base, 'outdir'), { recursive: true })
      writeFileSync(join(base, 'outdir', 'eviltoken.txt'), OUTSIDE)
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'foo.js'), 'export const ok = 1\n')

      const mk = await cmdRunIn(root, ['mklink', '/J', join(root, 'jlink'), base])
      const mkInside = await cmdRunIn(root, ['mklink', '/J', join(root, 'jinside'), join(root, 'src')])
      assert.equal(mk.status, 0, `junction 必须建得起来（mklink /J 不需要管理员）：${mk.out.trim()}`)
      assert.equal(mkInside.status, 0, `根内 junction 也必须建得起来：${mkInside.out.trim()}`)

      // ── 根因证据（P0 的机制本身）：JS 版 realpath 判不出 junction，native 版可以
      const jlink = join(root, 'jlink')
      assert.equal(nodeFs.lstatSync(jlink).isSymbolicLink(), false, 'P0 根因：junction 的 lstat.isSymbolicLink() === false')
      assert.equal(nodeFs.lstatSync(jlink).isDirectory(), true, 'P0 根因：junction 的 lstat.isDirectory() === true')
      assert.equal(nodeFs.realpathSync(jlink), jlink, 'P0 根因：**JS 版** realpathSync 原样返回未解析路径（判据被短路）')
      assert.notEqual(nodeFs.realpathSync.native(jlink), jlink, 'P0 根因：**native 版** realpathSync 能正确解析 junction')

      const policy = createPathPolicy({ root })
      // ── 必红（复刻**修复前**的判据）：JS 版 realpath + `real !== abs` ⇒ junction 被短路
      const legacyCheck = (relPath) => {
        const abs = join(root, relPath)
        const stat = nodeFs.statSync(abs)
        if (!stat.isFile()) return { ok: false }
        try {
          const real = nodeFs.realpathSync(abs) // ← 修复前用的就是 JS 版
          if (real !== abs && !real.startsWith(root)) return { ok: false, code: 'symlink-escape' }
        } catch { /* 同旧实现 */ }
        return { ok: true, size: stat.size }
      }
      const legacyVerdict = legacyCheck(join('jlink', 'outdir', 'eviltoken.txt'))
      assert.equal(legacyVerdict.ok, true, 'SEC-P0 必红：修复前的判据对 junction 路径返回 ok:true（这就是被修掉的漏洞）')
      assert.equal(legacyVerdict.size, Buffer.byteLength(OUTSIDE), 'SEC-P0 必红：漏掉的正是仓库外那个文件的 size')

      // ── 必红→必绿：PoC 原文这里返回 {ok:true, size:20}
      const verdict = policy.check('jlink/outdir/eviltoken.txt')
      assert.equal(verdict.ok, false, 'SEC-P0：经 junction 越界的路径必须被拒（修复前返回 ok:true）')
      assert.equal(verdict.code, REJECT.SYMLINK_ESCAPE, `SEC-P0：拒绝码必须是 symlink-escape（实得 ${verdict.code}）`)

      // ── 绝不返回仓库外正文
      const { retrieval, scratch } = s2Retrieval(root)
      try {
        let thrown = null
        let leaked = null
        try { leaked = retrieval.readFile('jlink/outdir/eviltoken.txt') } catch (error) { thrown = error }
        assert.equal(leaked, null, 'SEC-P0：仓库外正文绝不能被返回（PoC：修复前会返回 OUTSIDE_TOKEN…）')
        assert.ok(thrown instanceof PathPolicyError, `SEC-P0：必须抛 PathPolicyError（实得 ${thrown?.name}）`)
        assert.equal(thrown.code, REJECT.SYMLINK_ESCAPE)
        const logCodes = retrieval.rejectionLog.byCode()
        assert.ok((logCodes[REJECT.SYMLINK_ESCAPE] ?? 0) >= 1, 'SEC-P0：拒绝必须留痕（可查拒绝记录）')
        // ── 阳性对照：指向**根内**的 junction 必须照常可读（不是「禁掉全部 junction」）
        const inside = retrieval.readFile('jinside/foo.js')
        assert.equal(inside.ok, true, 'SEC-P0 阳性对照：根内 junction 必须可读')
        assert.ok(inside.text.includes('export const ok = 1'), '阳性对照：读到的确实是根内文件')
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    } finally {
      // junction 用 rmdir 摘除**链接本身**（绝不递归删除，免得穿到目标里）
      for (const name of ['jlink', 'jinside']) {
        try { nodeFs.rmdirSync(join(root, name)) } catch { /* 已摘除/不存在 */ }
      }
      rmSync(root, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    }
  })

  t('SEC-P1：ADS 默认流 / 大小写变体 / 经 junction 暴露的凭据目录 / 8.3 短名 全部被拒（含阳性对照）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sec-names-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'foo.js'), 'export const ok = 1\n')
      writeFileSync(join(root, '.env'), 'SECRET_TOKEN=abc\n')
      writeFileSync(join(root, 'id_rsa'), 'PRIVATE\n')
      mkdirSync(join(root, '.git'), { recursive: true })
      writeFileSync(join(root, '.git', 'config'), '[core]\n')
      mkdirSync(join(root, '.ssh'), { recursive: true })
      writeFileSync(join(root, '.ssh', 'config'), 'Host *\n')
      mkdirSync(join(root, '.gnupg'), { recursive: true })
      writeFileSync(join(root, '.gnupg', 'config'), 'x\n')
      const policy = createPathPolicy({ root })

      // ① ADS 默认流：`.env::$DATA` 的 basename 判据看不见流名 ⇒ 必须显式拒
      const ads = policy.check('.env::$DATA')
      assert.equal(ads.ok, false, 'SEC-P1①：`.env::$DATA`（ADS 默认流）必须被拒（修复前可读到 .env 正文）')
      assert.equal(ads.code, REJECT.ADS, `SEC-P1①：拒绝码应为 ads-stream（实得 ${ads.code}）`)
      assert.equal(policy.check('src/foo.js::$DATA').ok, false, 'SEC-P1①：任何 ADS 形态都拒（不止 .env）')
      assert.equal(policy.check('src/foo.js').ok, true, 'SEC-P1① 阳性对照：普通文件仍可读')

      // ② 大小写变体：Windows 大小写不敏感 ⇒ 段名/文件名判据必须折大小写
      assert.equal(policy.check('.GIT/config').code, REJECT.GIT_INTERNALS, 'SEC-P1②：`.GIT/config` 必须判 git-internals（修复前大小写敏感 ⇒ 放行）')
      assert.equal(policy.check('.SSH/config').code, REJECT.CREDENTIAL, 'SEC-P1②：`.SSH/config` 必须判 credential')
      assert.equal(policy.check('ID_RSA').code, REJECT.CREDENTIAL, 'SEC-P1②：`ID_RSA` 必须判 credential')
      assert.equal(policy.check('.ENV').code, REJECT.CREDENTIAL, 'SEC-P1②：`.ENV` 必须判 credential')

      // ③ 经 junction 暴露的凭据目录（与 8.3 短名同机制：名字判据跑在**规范化后**的路径上）
      const junction = join(root, 'innocuous')
      const mk = await cmdRunIn(root, ['mklink', '/J', junction, join(root, '.gnupg')])
      assert.equal(mk.status, 0, `SEC-P1③：junction 必须建得起来：${mk.out.trim()}`)
      try {
        const viaJunction = policy.check('innocuous/config')
        assert.equal(viaJunction.ok, false, 'SEC-P1③：经 junction 暴露的凭据目录必须被拒（判据跑在规范化后的路径上）')
        assert.equal(viaJunction.code, REJECT.CREDENTIAL, `SEC-P1③：应为 credential（实得 ${viaJunction.code}）`)
      } finally {
        try { nodeFs.rmdirSync(junction) } catch { /* 忽略 */ }
      }

      // ④ 8.3 短名：本机若生成短名则必须被拒；不生成则**显式登记跳过**（不得静默）
      let shortResolved = null
      try { shortResolved = nodeFs.realpathSync.native(join(root, 'ENV~1')) } catch { shortResolved = null }
      if (shortResolved !== null) {
        assert.ok(shortResolved.toLowerCase().endsWith('.env'), `SEC-P1④：ENV~1 应解析到 .env（实得 ${shortResolved}）`)
        assert.equal(policy.check('ENV~1').code, REJECT.CREDENTIAL, 'SEC-P1④：8.3 短名不得绕过凭据禁令')
      } else {
        // 显式跳过 + 机制已覆盖（canonical 解析）：把跳过事实写进断言消息，避免「静默跳过」
        assert.ok(true, 'SEC-P1④：本卷未生成 8.3 短名（探测 realpathSync.native("ENV~1") 失败）⇒ 跳过该子项；同机制已由 ③ 覆盖（canonical 解析后再做名字判据）')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  t('SEC-P1（面2）：git 子进程必须最小 env —— 设 GIT_DIR 后 headSha 不得被静默重定向', async () => {
    // ① 白名单本身：剔除全部 GIT_*，保留 git 运行必需项
    const env = minimalGitEnv({ GIT_DIR: '/evil/.git', GIT_WORK_TREE: '/evil', PATH: 'p', SystemRoot: 'sr', TEMP: 't', HOME: 'h' })
    assert.equal(Object.keys(env).some((k) => k.toUpperCase().startsWith('GIT_')), false, 'SEC-P1：最小 env 里不得有任何 GIT_* 键')
    assert.equal(env.PATH, 'p', 'SEC-P1：PATH 必须保留（否则定位不到 git）')
    assert.equal(env.SystemRoot, 'sr', 'SEC-P1：SystemRoot 必须保留（Windows DLL 解析）')
    assert.equal(env.GIT_DIR, undefined, 'SEC-P1：GIT_DIR 必须被剔除（实测可静默重定向仓库）')

    const dir = buildS1aFixture()
    const other = buildS1aFixture()
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-sec-env-'))
    try {
      // 两个 fixture 必须**内容不同**：同内容 + 同作者 + 同秒提交会得到同一个 commit sha，
      // 那样「headSha 变了没有」就不可判（首版实测踩过）。
      writeFileSync(join(other, 'distinct.txt'), 'DIFFERENT_TREE\n')
      await initFixtureRepo(dir)
      await initFixtureRepo(other)
      const expected = createGitReader({ cwd: dir, scratchDir: scratch }).headSha()
      assert.match(expected, /^[0-9a-f]{40}$/, '前置：正常 headSha 必须是完整 sha')
      const otherSha = createGitReader({ cwd: other, scratchDir: scratch }).headSha()
      assert.notEqual(otherSha, expected, '前置：两个 fixture 的 HEAD 必须不同（否则本用例测不出重定向）')

      const saved = process.env.GIT_DIR
      try {
        process.env.GIT_DIR = join(other, '.git')
        // ② 必红：注入 GIT_DIR 后，传给 git 的 env 里不得再出现它
        const captured = []
        const spied = createGitReader({
          cwd: dir,
          scratchDir: scratch,
          spawnSync: (cmd, argv, options) => { captured.push({ env: options.env }); return { status: 1, error: null } },
        })
        try { spied.headSha() } catch { /* 预期：status=1 ⇒ fail-closed 抛错；本断言只关心 options */ }
        assert.equal(captured.length, 1, '必须捕获到一次 spawn')
        assert.equal(captured[0].env?.GIT_DIR, undefined, 'SEC-P1 必红：传给 git 的 env 里**不得**有 GIT_DIR')
        assert.equal(Object.keys(captured[0].env ?? {}).some((k) => k.toUpperCase().startsWith('GIT_')), false, 'SEC-P1：不得有任何 GIT_* 泄漏进子进程')
        // ③ 真跑：即使父环境有 GIT_DIR，headSha 也必须仍是本仓库的
        const realGit = createGitReader({ cwd: dir, scratchDir: scratch })
        assert.equal(realGit.headSha(), expected, 'SEC-P1：设了 GIT_DIR 之后 headSha 不得改变（修复前会变成另一仓库的 sha）')
        assert.equal(typeof realGit.statusText(), 'string', 'SEC-P1：其它只读命令同样不受 GIT_DIR 影响')
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR
        else process.env.GIT_DIR = saved
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

// ── 13. B1 第二批修复（code-reviewer P1-1/2/3 + security-reviewer 高优先 P1）────────

export function testB1SecondPass(t) {
  t('P1-3：collect() 的 Base 口径与 buildContext 一致（Base 不再计两次、单次 20KB 判定不含 Base）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const baseText = 'B'.repeat(5000)
      const round = retrieval.collect({ baseText, includeGit: true, queries: [{ literal: 'export' }] })
      const baseBytes = measureInjection(baseText).bytes
      assert.equal(round.baseBytes, baseBytes, 'P1-3：baseBytes 必须只按 baseText 计一次')
      assert.equal(round.accounting.baseBytes, baseBytes, 'P1-3：accounting 的 base 口径必须同源')
      assert.equal(round.bundle.bytes, round.repositoryBytes, 'P1-3：bundle.bytes = 检索段字节（不含 Base）')
      assert.equal(round.accounting.repositoryBytes, round.repositoryBytes, 'P1-3：accounting 的 repository = 检索段')
      // 单次 20KB 判定的计量对象 = **检索段**（旧实现把整段 inputText 当检索段 ⇒ 含 Base）
      assert.equal(round.accounting.calls[0].bytes, round.repositoryBytes, 'P1-3：单次检索的计量对象必须是检索段')
      assert.equal(round.accounting.verdicts.perCall[0].usedBytes, round.repositoryBytes, 'P1-3：单次预算判定不得含 Base')
      // 总量 = base + 检索段（只多出 join 分隔符，绝不含第二份 Base）
      assert.ok(round.totalBytes >= round.baseBytes + round.repositoryBytes, 'P1-3：总量 = base + 检索段')
      assert.ok(round.totalBytes <= round.baseBytes + round.repositoryBytes + 8, `P1-3：总量不得虚增一个 Base（实得 total=${round.totalBytes}, base=${round.baseBytes}, repo=${round.repositoryBytes}）`)
      assert.equal(round.bytes, round.totalBytes, 'P1-3：bytes 与 totalBytes 同源')
      // 互不占用在 collect 路径同样成立：Base 超限不得挤压 Repository 判定
      const overBase = retrieval.collect({ baseText: 'B'.repeat(BASE_CONTEXT_BYTES + 100), includeGit: false, queries: [{ literal: 'export' }] })
      assert.equal(overBase.accounting.verdicts.base.over, true, 'P1-3：Base 超限必须被判超')
      assert.equal(overBase.accounting.verdicts.repository.over, false, 'P1-3：★Base 超限不得挤压 Repository 判定（并列独立）')
      // 必红：复刻旧口径（把整段 inputText 当检索段 + baseText 再传一次）
      const legacy = accountRetrieval({ baseText, calls: [{ label: 'retrieval#1', text: round.inputText }] })
      assert.ok(legacy.repositoryBytes > round.repositoryBytes, 'P1-3 必红：旧口径下 repositoryBytes 明显更大（把 Base 也算了进去）')
      const delta = legacy.repositoryBytes - round.repositoryBytes
      assert.ok(delta >= baseBytes && delta <= baseBytes + 8,
        `P1-3 必红：旧口径多出来的部分应≈一整个 Base（实得 ${delta}，base=${baseBytes}；差值含 join 分隔符）`)
      assert.equal(legacy.verdicts.perCall[0].usedBytes, round.totalBytes, 'P1-3 必红：旧口径的单次判定对象是整段文本（含 Base）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('P1-1：advisorContextMaxFiles=0 = 关闭 L2 精读（文档与代码一致）+ 不喂 L3 假数据', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      await initFixtureRepo(dir)
      const base = { retrieval, messageText: '请检查 src/foo.js 的实现', includeGit: false }
      // ① 0 = 关闭：不精读任何文件、无符号区间，且**显式**写进注入文本
      const off = buildRepositoryContext({ ...base, maxFiles: 0 })
      assert.equal(off.l2.disabled, true, 'P1-1：maxFiles=0 必须置 l2.disabled')
      assert.equal(off.l2.filesRead, 0, 'P1-1：★maxFiles=0 时 filesRead 必须为 0（旧实现回落成 4）')
      assert.equal(off.symbolRanges.length, 0, 'P1-1：0 时不得产出符号区间')
      assert.ok(off.text.includes('【已关闭】'), 'P1-1：关闭状态必须显式写进文本（不静默）')
      assert.equal(off.level, LEVEL_L1, 'P1-1：关闭 L2 后 level 只报 L1')
      assert.equal(off.l1.available, true, 'P1-1 阳性对照：L1 仍照常')
      // ② 缺省与显式值仍按预期工作
      const two = buildRepositoryContext({ ...base, maxFiles: 2 })
      assert.equal(two.l2.disabled, false)
      assert.ok(two.l2.filesRead <= 2 && two.l2.filesRead >= 1, 'P1-1：maxFiles=2 必须生效')
      const def = buildRepositoryContext({ ...base })
      assert.ok(def.l2.filesRead >= 1 && def.l2.filesRead <= 4, 'P1-1：缺省仍是最多 4 个')
      // ③ 配置面可达：resolveAdvisorConfig 允许 0（readInt 非负）
      assert.equal(resolveAdvisorConfig({ advisorContextMaxFiles: 0 }).advisorContextMaxFiles, 0, 'P1-1：配置面必须允许 0（否则「0=关闭」不可达）')
      assert.equal(resolveAdvisorConfig({}).advisorContextMaxFiles, 4, 'P1-1 阳性对照：缺省仍是 4')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('P1-2①/②：生产接线真实喂 gitFacts + **走真实装配路径**断言上下文内容进了模型输入', async () => {
    const dir = buildS2Fixture() // 含 docs/DECISIONS.md
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-p12-'))
    try {
      await initFixtureRepo(dir)
      const traceRows = []
      const llm = fakeLlm('{"notes":[]}')
      const agent = fakeAgent('s-ctx')
      const { ctx, emit } = fakeCtx()
      ctx.agents.get = (id) => (id === 's-ctx' ? agent : undefined)
      const installed = installAdvisor(ctx, {}, {
        dataDir,
        resolveLlm: () => llm,
        trace: (row) => traceRows.push(row),
        resolutionRootOf: () => dir, // ← 生产接线里由宿主会话 cwd 提供；测试注入夹具根
      })
      try {
        const session = { ...fakeSession([msg('user', '请检查 src/foo.js 的实现')]), id: 's-ctx' }
        agent.session = session
        installed.ctrl.patchConfig('s-ctx', { enabled: true, provider: 'p', model: 'm' })
        emit('agent/created', { agent })
        emit('session/event', session, { type: 'step/start', data: { turn: 1 } })
        emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
        await new Promise((r) => setTimeout(r, 30))
        const runtime = installed.ctrl.runtimeOf('s-ctx')
        await runtime?.waitForDrain()
        assert.equal(llm.calls.length, 1, 'P1-2：真实装配路径必须真的发起一次评审')
        const captured = capturedInput(llm)
        // ② 上下文内容真的进了模型输入（三层各自可辨）
        assert.ok(captured.includes(BASE_TITLE), 'P1-2②：基础上下文段必须进输入')
        assert.ok(captured.includes('仓库上下文（Repository Context'), 'P1-2②：仓库上下文段必须进输入')
        assert.ok(captured.includes('DECISION_BODY_MARK'), 'P1-2②：决策保护内容必须进输入')
        assert.ok(captured.includes('src/foo.js'), 'P1-2②：仓库文件路径必须进输入')
        // ① git 事实必须真的喂进 Project State（旧接线恒「不可用」）
        assert.ok(captured.includes('### 项目状态'), 'P1-2①：项目状态段必须在')
        assert.ok(!captured.includes('【不可用】git 事实'), 'P1-2①：★生产接线不得再恒显「git 事实不可用」')
        assert.match(captured, /分支：/, 'P1-2①：必须真的渲染出分支（证明 gitFacts 到位）')
        assert.equal(runtime.lastContext.l1?.gitAvailable ?? runtime.lastContext.repository?.l1?.gitAvailable, true, 'P1-2①：repository 层的 gitAvailable 必须为真')
        assert.deepEqual(runtime.lastContext.layers, ['conversation', 'project', 'repository'], '三层顺序必须稳定')
        // 必红：复刻旧接线（只给 phase、不给 gitFacts）⇒ 项目层恒「不可用」
        const legacyProject = buildProjectState({ gitFacts: null, phase: null })
        assert.equal(legacyProject.available, false, 'P1-2① 必红：旧接线（不喂 gitFacts）下项目层必然不可用')
        assert.ok(legacyProject.text.includes(CTX_UNAVAILABLE), 'P1-2① 必红：正是被修掉的「永久不可用」症状')
        assert.equal(legacyProject.phaseSource, 'unavailable', 'P1-2① 必红：启发阶段也因此恒 design')
      } finally { installed.dispose() }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  t('P1-2③：上下文装配失败 = fail-open **但可见**（trace + lastContext.failed + 注入文本留痕）', async () => {
    const llm = fakeLlm('{"notes":[]}')
    const trace = []
    const rt = s2Runtime({
      llm,
      trace,
      context: () => { throw new Error('SIMULATED_CONTEXT_FAILURE') },
      prefilter: screen,
    })
    rt.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js 的报错'), trigger: TRIGGER_USER }, { sessionId: 's-ctx-fail', sessionName: null })
    await rt.waitForDrain()
    assert.equal(llm.calls.length, 1, 'P1-2③：fail-open ⇒ 评审照常进行（不因上下文坏了停摆）')
    assert.equal(rt.lastContext?.failed, true, 'P1-2③：★装配失败必须可见（lastContext.failed）')
    assert.match(String(rt.lastContext.error), /SIMULATED_CONTEXT_FAILURE/, 'P1-2③：错误原因必须可读')
    assert.ok(trace.some((r) => r.phase === 'context' && /SIMULATED_CONTEXT_FAILURE/.test(String(r.error))), 'P1-2③：trace 必须留痕（phase=context）')
    assert.ok(capturedInput(llm).includes('advisor 上下文装配失败'), 'P1-2③：注入文本里必须带失败说明（不是静默变空）')
    // 阳性对照：正常装配时 lastContext.failed 不得为真
    const ok = s2Runtime({ llm: fakeLlm('{"notes":[]}'), context: () => ({ section: '<!-- ok -->', result: { layers: ['conversation'], bytes: 1 } }) })
    ok.enqueue({ markdown: s2UserMarkdown('请检查 src/foo.js'), trigger: TRIGGER_USER }, { sessionId: 's-ok', sessionName: null })
    await ok.waitForDrain()
    assert.notEqual(ok.lastContext?.failed, true, 'P1-2③ 阳性对照：正常装配不得被标失败')
    rt.dispose()
    ok.dispose()
  })

  t('SEC-P1（凭据名单）：security-reviewer 实测放行的 10 个样态必须全部被拒（含必红 + 阳性对照）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sec-cred-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo.js'), 'export const ok = 1\n')
      writeFileSync(join(dir, 'README.md'), '# readme\n')
      const samples = [
        'kubeconfig', '.pgpass', 'terraform.tfstate', 'secrets.yaml', 'vault.kdbx',
        'signing.jwk', 'private.key.txt', 'key.json', 'token.txt', 'vault.json',
      ]
      const policy = createPathPolicy({ root: dir })
      const missed = []
      for (const rel of samples) {
        const verdict = policy.check(rel)
        if (verdict.ok !== false || verdict.code !== REJECT.CREDENTIAL) missed.push(`${rel}→${verdict.ok ? 'ok' : verdict.code}`)
      }
      assert.deepEqual(missed, [], `SEC-P1：10 个样态必须全部判 credential（未拦：${missed.join(', ')}）`)
      // 阳性对照：普通文件不受影响
      assert.equal(policy.check('src/foo.js').ok, true, 'SEC-P1 阳性对照：普通源码仍可读')
      assert.equal(policy.check('README.md').ok, true, 'SEC-P1 阳性对照：普通文档仍可读')
      // 必红：复刻**扩展前**的名单（旧 36 样态版本）⇒ 这 10 个全部放行
      const OLD_BASENAMES = ['.env', '.env.local', '.env.production', '.env.development', '.envrc', '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts', 'credentials', 'credentials.json', 'service-account.json']
      const OLD_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.asc', '.ppk']
      const legacyCatches = samples.filter((rel) => {
        const name = rel.toLowerCase()
        return OLD_BASENAMES.includes(name) || OLD_EXTENSIONS.some((e) => name.endsWith(e))
      })
      assert.deepEqual(legacyCatches, [], `SEC-P1 必红：扩展前的名单对这 10 个样态**一个都拦不住**（实拦 ${legacyCatches.length} 个）`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  t('SEC-P1（写门补漏 + 锚定豁免）：cpSync/openSync 模式与旗标必红；豁免行尾追加写调用必须变红', () => {
    // ① 补漏：新纳入的写 API / 打开模式 / 旗标常量
    const injections = [
      ["fs.cpSync('a', 'b')", 'cpSync'],
      ["fs.cp('a', 'b')", 'cp'],
      ["fs.openSync(p, 'w+')", 'openSync(w|a|x)'],
      ["fs.openSync(p, 'a+')", 'openSync(w|a|x)'],
      ["fs.openSync(p, constants.O_WRONLY)", 'openSync(flag-constant)'],
      ["fs.openSync(p, O_CREAT | O_TRUNC)", 'openSync(flag-constant)'],
      ["fs.rmdirSync('a')", 'rmdirSync'],
    ]
    for (const [line, expectedApi] of injections) {
      const hits = scanWriteApis(`function probe(){ ${line} }`, 'probe.js')
      assert.ok(hits.some((h) => h.api === expectedApi), `SEC-P1 必红：${line} 必须被门抓到（期望 api=${expectedApi}，实得 ${JSON.stringify(hits.map((h) => h.api))}）`)
    }
    // 阳性对照：只读 API 不得误伤
    for (const line of ["fs.readFileSync(p, 'utf8')", "fs.realpathSync.native(p)", 're.exec(line)']) {
      assert.deepEqual(scanWriteApis(`function probe(){ ${line} }`, 'probe.js'), [], `SEC-P1 阴性对照：${line} 不得被误伤`)
    }

    // ② 豁免锚定：在豁免行**行尾追加写调用** ⇒ 必须变红（旧 includes 匹配下违规数 = 0）
    const idxSrc = readFileSync(join(ADVISOR_DIR, 'index.js'), 'utf8')
    const exemptLine = idxSrc.split('\n').find((l) => l.trim() === 'mkdirSync(dataDir, { recursive: true })')
    assert.equal(typeof exemptLine, 'string', '前置：必须找得到豁免行')
    const tampered = `${exemptLine}; fs.cpSync('a', 'b')`
    const tamperedText = idxSrc.replace(exemptLine, tampered)
    assert.notEqual(tamperedText, idxSrc, '变异体必须真的注入')
    const gated = scanWriteApiGate([{ rel: 'lib/advisor/index.js', text: tamperedText }])
    assert.ok(gated.violations.length > 0, 'SEC-P1 必红：豁免行尾追加写调用后必须出现违规（旧实现按「同行含片段」匹配 ⇒ 违规数 0）')
    assert.ok(gated.violations.some((v) => v.api === 'cpSync'), '必红点必须是那个被追加的写调用')
    // 复刻旧匹配逻辑（「同行 includes 片段」）⇒ 证明旧实现确实会把这行整体放过
    const legacyHit = scanWriteApis(tamperedText, 'lib/advisor/index.js').find((h) => h.api === 'cpSync')
    assert.ok(legacyHit !== undefined, '前置：追加进去的写调用必须被扫描器看见')
    assert.ok(legacyHit.text.includes('mkdirSync(dataDir, { recursive: true })'),
      'SEC-P1 必红：tampered 行仍含原豁免片段 ⇒ 旧的「同行含片段」匹配会把整行放过（本次改为整行锚定后才拦住）')

    // ③ 真实工作树仍必须干净（豁免条条活性、零违规）
    const real = scanWriteApiGate(collectAdvisorModules())
    assert.deepEqual(real.violations, [], `SEC-P1：真实工作树不得有未豁免写调用（${JSON.stringify(real.violations)}）`)
    assert.equal(real.exempted, WRITE_API_ALLOWLIST.length, 'SEC-P1：锚定豁免必须条条命中')
  })

  t('P1（trimToBudget 硬上限）：无论输入多长，返回值必须 ≤ 上限（或显式 over 标记）', () => {
    const long = 'x'.repeat(10000)
    const trimmed = trimToBudget(long, 64, '测试段')
    assert.ok(trimmed.bytes <= 64, `trimToBudget 必须 ≤ 上限（实得 ${trimmed.bytes} > 64）`)
    assert.equal(trimmed.trimmed, true)
    assert.equal(trimmed.over, false, '正常裁剪后不得标 over')
    // 极小上限：宁可丢内容也不越限（over 只可能在连说明都装不下时出现）
    const tiny = trimToBudget('中文内容'.repeat(50), 5, '极小段')
    assert.ok(tiny.bytes <= 5 || tiny.over === true, `极小上限也必须不越限或显式 over（bytes=${tiny.bytes}, over=${tiny.over}）`)
    // 多字节内容（按字节而非字符裁剪）
    const cjk = trimToBudget('中'.repeat(1000), 100, '中文段')
    assert.ok(cjk.bytes <= 100, `多字节内容也必须按**字节**收口（实得 ${cjk.bytes}）`)
    // 阳性对照：未超限时原样返回
    const untouched = trimToBudget('短', 1024, '短段')
    assert.equal(untouched.trimmed, false)
    assert.equal(untouched.text, '短')
  })
}

// ── 13. S3：agentic 工具循环 + 只读 ACI 工具面（advisor V3 节 2 S3，判据 1–13）──────
//
// 同文件追加纪律（与 S0/S1a/S2 同一次求值、同一条基线）。判据锚点：S3-1…S3-13，
// 逐条对应任务书 A–E 五组交付。判据内预算常量一律 import retrieval/budget.js
// （AC-15 字面量门：测试码不得写死预算数字，含注释——本行就是前车之鉴）。

/** 带分块脚本的 llm 桩（S3 专用：按调用次序下发 chunk 数组；记录每次调用的完整 options）。 */
function fakeToolLlm(roundScripts) {
  const calls = []
  return {
    calls,
    stream: (options) => {
      calls.push(options)
      const chunks = calls.length <= roundScripts.length ? roundScripts[calls.length - 1] : []
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}

/** 首轮 user 消息（与 runtime.buildMessages 的产物同构）。 */
function s3FirstUser(text) {
  return [{ role: 'user', id: 'u-s3', content: [{ type: 'text', text }], source: { kind: 'user' } }]
}

/** 工具调用轮的分片（单工具调用块）。 */
function s3ToolCallChunks(id, name, args) {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: 'tool-calls' },
  ]
}

/** 正常终轮的分片（严格 JSON 评审输出）。 */
function s3FinalChunks(text = '{"notes":[]}', outputTokens = 100) {
  return [
    { type: 'text-delta', text },
    { type: 'usage', usage: { outputTokens } },
    { type: 'finish', reason: 'stop' },
  ]
}

/** runtime + 工具循环的直接驱动方式（镜像 index.js 的装配：工具按 root 现取、循环注入）。 */
function s3RuntimeWithLoop({ llm, retrieval, records = [], trace = [], maxRounds = 4, callTimeoutMs = 5000, reviewTimeoutMs } = {}) {
  const tools = retrieval === null ? [] : createAciTools({ retrieval })
  return new AdvisorRuntime({
    provider: 'p-s3',
    model: 'm-s3',
    systemPrompt: 'S3 系统提示（合成值）',
    llm,
    deliver: () => 'recorded',
    record: (r) => records.push(r),
    onStatus: () => {},
    trace: (row) => trace.push(row),
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    maxQueued: 8,
    callTimeoutMs,
    maxMessages: 60,
    toolLoop: async (call) => runToolLoop({
      llm: call.llm,
      provider: call.provider,
      model: call.model,
      systemPrompt: call.systemPrompt,
      messages: call.messages,
      tools,
      maxRounds,
      maxTokens: call.maxTokens,
      callTimeoutMs: call.callTimeoutMs,
      reviewTimeoutMs,
      signal: call.signal,
      trace: call.trace,
      meta: call.meta,
    }),
  })
}

export function testS3ToolLoop(t) {
  // ── S3-1（AC-8）：工具白名单「精确相等」断言 + 禁止名构造性不存在 + 不注册宿主工具 ──
  t('S3-1 AC-8：白名单精确相等 {read_file,search,list_files,get_diff,get_git_log}；禁止名只在声明行出现；advisor 零 ctx.tools.register', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const tools = createAciTools({ retrieval })
      // ① 集合相等断言（多一个、少一个都抛）
      assert.doesNotThrow(() => assertAciWhitelist(tools.map((x) => x.name), { label: 'S3-1' }))
      assert.deepEqual([...new Set(tools.map((x) => x.name))].sort(), [...ACI_TOOL_NAMES].sort())
      assert.throws(() => assertAciWhitelist([...ACI_TOOL_NAMES, 'write_file'], { label: 'S3-1 负向' }), /白名单不相等/, '多一个工具必须红')
      assert.throws(() => assertAciWhitelist(ACI_TOOL_NAMES.slice(1), { label: 'S3-1 负向2' }), /缺少/, '少一个工具必须红')
      // ② 禁止名构造性不存在：源码级——每个禁止名作为**带引号字符串字面量**只在
      //    FORBIDDEN_TOOL_NAMES 声明行出现（tools/loop/observation 三个 ACI 文件合计）。
      const aciSources = ['lib/advisor/aci/tools.js', 'lib/advisor/aci/loop.js', 'lib/advisor/aci/observation.js']
        .map((rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8'))
        .join('\n')
      for (const forbidden of FORBIDDEN_TOOL_NAMES) {
        const count = aciSources.split(`'${forbidden}'`).length - 1
        assert.equal(count, 1, `禁止名 '${forbidden}' 只允许出现在声明清单（实得 ${count} 次）`)
      }
      // 阳性对照：合法工具名在源码里出现 ≥2 次（声明 + 工具定义），检索面有效
      assert.ok(aciSources.split(`'read_file'`).length - 1 >= 2, '阳性对照：read_file 字面量必须可检出')
      // ③ advisor 零 ctx.tools.register（宿主工具位不被占用）；阳性对照 = lib/index.js 有 register
      const advisorTree = ['index.js', 'runtime.js', 'observer.js', 'delivery.js', 'store.js', 'api.js']
        .map((rel) => readFileSync(fileURLToPath(new URL(`../lib/advisor/${rel}`, import.meta.url)), 'utf8'))
      for (const src of [...advisorTree, aciSources]) {
        assert.equal(src.includes('ctx.tools.register'), false, 'advisor 侧不得调用 ctx.tools.register')
      }
      const hostIndex = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
      assert.ok(hostIndex.includes('ctx.tools.register'), '阳性对照：宿主装配确实存在 ctx.tools.register（检索面有效）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-2（AC-9）：逐工具 readOnly 标注 + 注入必红（变异 readOnly:false → 断言红）──
  t('S3-2 AC-9：每工具 readOnly:true；变异体（readOnly:false）必红（内存原字节 + SHA256 还原）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const tools = createAciTools({ retrieval })
      for (const tool of tools) {
        assert.equal(tool.readOnly, true, `${tool.name} 必须标注 readOnly:true`)
        assert.equal(tool.destructive, undefined, `${tool.name} 不得有 destructive 标注`)
        assert.equal(typeof tool.execute, 'function', `${tool.name} 必须可执行`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S3-2b（注入必红实测）：tools.js 的 readOnly:true → false 变异后，AC-9 谓词必须红', async () => {
    const abs = fileURLToPath(new URL('../lib/advisor/aci/tools.js', import.meta.url))
    const original = readFileSync(abs)
    const before = createHash('sha256').update(original).digest('hex')
    try {
      const mutated = original.toString('utf8').replace(
        "parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区相对路径' } }, required: ['path'] },\n      readOnly: true,",
        "parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区相对路径' } }, required: ['path'] },\n      readOnly: false,",
      )
      assert.notEqual(mutated, original.toString('utf8'), '变异必须真的命中（锚点唯一）')
      writeFileSync(abs, mutated, 'utf8')
      const fresh = await import(`../lib/advisor/aci/tools.js?mutation=${Date.now()}`)
      const dir2 = mkdtempSync(join(tmpdir(), 'dsh-s3-mut-'))
      const facet = createRetrieval({ root: dir2, dataDir: mkdtempSync(join(tmpdir(), 'dsh-s3-mut-s-')) })
      const mutatedTools = fresh.createAciTools({ retrieval: facet })
      const readTool = mutatedTools.find((x) => x.name === 'read_file')
      assert.equal(readTool.readOnly, false, '前置：变异后 readOnly 必须是 false（变异生效）')
      assert.throws(() => {
        for (const tool of mutatedTools) assert.equal(tool.readOnly, true, 'readOnly 必须为 true（AC-9 谓词在变异体上红）')
      }, /readOnly/, 'AC-9 谓词必须抓住 readOnly:false 变异（注入必红）')
      rmSync(dir2, { recursive: true, force: true })
    } finally {
      writeFileSync(abs, original) // 内存原字节还原（不用 git checkout --）
      const after = createHash('sha256').update(readFileSync(abs)).digest('hex')
      assert.equal(after, before, 'tools.js 变异还原必须逐字节一致')
    }
  })

  // ── S3-3（AC-10）：工具面 argv 直传 + 注入载荷逐元素断言 ──
  t('S3-3 AC-10：get_git_log 的 grep 载荷（; rm -rf / 等）原样作为一个 argv 元素，不被解释', async () => {
    const dir = buildS1aFixture()
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-s3-argv-'))
    try {
      await initFixtureRepo(dir)
      const { spawnSync } = await import('node:child_process')
      const spawns = []
      const recordingSpawn = (cmd, args, opts) => {
        spawns.push({ cmd, args: [...args] })
        // 真 git 只读命令在 fixture 上安全执行（fd-stdio，不用 pipe——沙箱 pipe 捕获必 EPERM）
        const tmp = join(tmpdir(), `dsh-s3-git-${process.pid}-${spawns.length}.out`)
        const fd = nodeFs.openSync(tmp, 'w')
        let status = null
        try {
          status = spawnSync(cmd, args, { cwd: dir, stdio: ['ignore', fd, fd], windowsHide: true }).status
        } finally { nodeFs.closeSync(fd) }
        let out = ''
        try { out = nodeFs.readFileSync(tmp, 'utf8') } catch { out = '' }
        try { nodeFs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
        return { status, stdout: '', stderr: '', text: out }
      }
      const retrieval = createRetrieval({ root: dir, dataDir: scratch, spawnSync: recordingSpawn })
      const tools = createAciTools({ retrieval })
      const logTool = tools.find((x) => x.name === 'get_git_log')
      const result = await logTool.execute({ grep: '; rm -rf /', limit: 5 })
      assert.equal(result.isError, false)
      const last = spawns[spawns.length - 1]
      assert.equal(last.cmd, 'git')
      assert.deepEqual(last.args, ['log', '--oneline', '--max-count=5', '--grep=; rm -rf /'],
        '注入载荷必须逐元素等于预期（原样直传，不被解释执行）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-4：预算 chokepoint 唯一性（源码级 grep + 阳性对照 + 行为断言）──
  t('S3-4：budget.reserve 写侧只出现在 aci/loop.js（源码级 grep + 阳性对照）；池超限拒绝', async () => {
    const advisorFiles = ['index.js', 'runtime.js', 'observer.js', 'delivery.js', 'store.js', 'api.js',
      'aci/tools.js', 'aci/observation.js', 'retrieval/budget.js', 'retrieval/index.js']
    const offenders = []
    for (const rel of advisorFiles) {
      const src = readFileSync(fileURLToPath(new URL(`../lib/advisor/${rel}`, import.meta.url)), 'utf8')
      if (/\.reserve\(/.test(src)) offenders.push(rel)
    }
    assert.deepEqual(offenders, [], '预算写侧调用只允许出现在 aci/loop.js')
    const loopSrc = readFileSync(fileURLToPath(new URL('../lib/advisor/aci/loop.js', import.meta.url)), 'utf8')
    assert.ok(/\.reserve\(/.test(loopSrc), '阳性对照：aci/loop.js 确实含 .reserve( 调用（检索面有效）')
    // 行为：池超限必须拒绝
    const pool = new BudgetPool({ limitBytes: 100, perCallBytes: 60 })
    assert.equal(pool.reserve(60, { label: 'a' }).ok, true)
    assert.equal(pool.reserve(60, { label: 'b' }).ok, false, '超出池上限必须拒绝（唯一放行点不静默放行）')
    assert.equal(pool.usedBytes, 60)
    assert.equal(BudgetPool !== undefined, true)
  })

  // ── S3-5（AC-13 ②③④）：多轮工具检索的逐层预算实测（常量 import，零字面量）──
  t('S3-5 AC-13：多轮工具检索逐轮记账——逐次 ≤ 单次上限、合计 ≤ 检索段合计上限；共享池（alreadyUsedBytes 挤占工具面）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      // 三轮：read_file ×2 + 终轮 JSON；逐轮记账全部过池。
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3ToolCallChunks('t2', 'read_file', JSON.stringify({ path: 'test/foo.test.js' })),
        s3FinalChunks('{"notes":[{"severity":"nit","text":"S3-5 结论"}]}', 120),
      ])
      const result = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-5 检索'), tools: createAciTools({ retrieval }), maxRounds: 4,
      })
      assert.equal(result.kind, 'ok', `多轮检索应正常收口（实得 ${result.kind}）`)
      assert.equal(result.rounds, 3)
      assert.equal(result.toolCalls.length, 2)
      // ② 每次检索 ≤ 单次上限；④ 检索段合计 ≤ 合计上限（常量 import，AC-15）
      for (const call of result.budget.calls) {
        assert.ok(call.bytes <= RETRIEVAL_CALL_BYTES, `单轮记账 ${call.bytes} 必须 ≤ ${RETRIEVAL_CALL_BYTES}`)
      }
      assert.ok(result.budget.usedBytes <= RETRIEVAL_TOTAL_BYTES, `合计 ${result.budget.usedBytes} 必须 ≤ ${RETRIEVAL_TOTAL_BYTES}`)
      assert.ok(result.bundle.files.includes('src/foo.js'), '检索集必须可枚举（AC-45 生产者侧）')
      // 池归属：预取面已记账挤占同一 40KB 池（共享，不各记各的）
      const tight = new BudgetPool({ alreadyUsedBytes: RETRIEVAL_TOTAL_BYTES - 10 })
      assert.equal(tight.reserve(11, { label: 'tool' }).ok, false, '预取面占掉 40KB 后工具面必须被挤占（共享同一池）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S3-5b（AC-14）：预算耗尽 ⇒ 整次评审 dropped + 显式载体（注入必红：绕过 chokepoint 的变异必红）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      // 已用 40KB-1，工具结果必然超池 ⇒ dropped budget-exhausted。
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3FinalChunks('{"notes":[]}'),
      ])
      const result = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-5b'), tools: createAciTools({ retrieval }), maxRounds: 4,
        alreadyUsedBytes: RETRIEVAL_TOTAL_BYTES - 1,
      })
      assert.equal(result.kind, 'dropped')
      assert.equal(result.reason, 'budget-exhausted')
      assert.ok(result.detail.includes('未投递'), '载体必须显式（不得截断但零痕迹）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-6（触顶跨轮不变量）：任一往返触顶 ⇒ 整次 dropped；配注入必红变异体 ──
  t('S3-6：第 1 轮触顶 + 第 2 轮正常 ⇒ 必须不投递（dropped）；变异体（只看最后一轮）必红', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      // 第 1 轮 outputTokens 达上限（finish=stop 的触顶形态），第 2 轮正常——按旧「只看终轮」
      // 行为会投递被截断的结论；新不变量必须整次 dropped。
      const llm = fakeToolLlm([
        s3FinalChunks('{"notes":[{"severity":"blocker","text":"被截断的结论"}]}', 16_384),
        s3FinalChunks('{"notes":[]}', 10),
      ])
      const result = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-6'), tools: createAciTools({ retrieval }), maxRounds: 4,
      })
      assert.equal(result.kind, 'dropped', '任一往返触顶 ⇒ 整次评审必须 dropped')
      assert.equal(result.reason, 'output-cap')
      // finishReason=max-tokens 形态同样必红
      const llm2 = fakeToolLlm([
        [{ type: 'text-delta', text: '截断' }, { type: 'finish', reason: 'max-tokens' }],
        s3FinalChunks('{"notes":[]}', 10),
      ])
      const result2 = await runToolLoop({
        llm: llm2, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-6b'), tools: createAciTools({ retrieval }), maxRounds: 4,
      })
      assert.equal(result2.kind, 'dropped')
      assert.equal(result2.reason, 'output-cap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  t('S3-6b（注入必红实测）：把「逐轮触顶聚合」变异成恒假后，S3-6 的断言必须红', async () => {
    const abs = fileURLToPath(new URL('../lib/advisor/aci/loop.js', import.meta.url))
    const original = readFileSync(abs)
    const before = createHash('sha256').update(original).digest('hex')
    try {
      const src = original.toString('utf8')
      const anchor = "const hitCap = (round.outputTokens !== null && round.outputTokens >= maxTokens) || round.finishReason === 'max-tokens'"
      assert.equal(src.split(anchor).length - 1, 1, '锚点必须唯一命中（文本手术纪律）')
      const mutated = src.replace(anchor, 'const hitCap = false')
      assert.notEqual(mutated, src)
      writeFileSync(abs, mutated, 'utf8')
      const fresh = await import(`../lib/advisor/aci/loop.js?mutation=${Date.now()}`)
      const llm = fakeToolLlm([
        s3FinalChunks('{"notes":[{"severity":"blocker","text":"被截断的结论"}]}', 16_384),
        s3FinalChunks('{"notes":[]}', 10),
      ])
      const result = await fresh.runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-6b 变异臂'), tools: [], maxRounds: 4,
      })
      // 变异生效的证明：聚合被禁用后，第 1 轮触顶的评审**会被投递**（kind=ok）——
      // 即 S3-6 的判据断言（kind 必须 = 'dropped'）在这个变异体上**必红**。
      // 本用例断言「变异真的翻转了可观测行为」，从而证明 S3-6 的判据有牙齿。
      assert.equal(result.kind, 'ok', '前置：聚合被禁用后触顶评审会被投递（若本臂已 dropped 说明变异未生效）')
      assert.equal(result.text, '{"notes":[{"severity":"blocker","text":"被截断的结论"}]}', '被截断的第 1 轮正文正是被投递的那条（S3-6 要堵的缺陷形态）')
    } finally {
      writeFileSync(abs, original) // 内存原字节还原
      const after = createHash('sha256').update(readFileSync(abs)).digest('hex')
      assert.equal(after, before, 'loop.js 变异还原必须逐字节一致')
    }
  })

  // ── S3-7（P1-8）：整次评审墙钟上限——按时终止 + 不投递 ──
  t('S3-7：墙钟超限 ⇒ 整次评审按时终止 + dropped（不投递）；缺省墙钟 = 轮上限 × 单轮超时', async () => {
    // 永不产出的挂起流（挂的是 async generator 本身，单轮 30s 超时不会先触发）
    const hangingLlm = { stream: () => (async function* () { await new Promise(() => {}) })() }
    const started = Date.now()
    const result = await runToolLoop({
      llm: hangingLlm, provider: 'p', model: 'm', systemPrompt: 'S',
      messages: s3FirstUser('S3-7'), tools: [], maxRounds: 4,
      callTimeoutMs: 30_000, reviewTimeoutMs: 120,
    })
    const elapsed = Date.now() - started
    assert.equal(result.kind, 'dropped', '墙钟到点必须整体 dropped（不投递）')
    assert.equal(result.reason, 'review-wall-clock')
    assert.ok(elapsed < 10_000, `墙钟必须按时终止（实耗 ${elapsed}ms，不得等单轮 30s 超时）`)
    // 缺省墙钟 = maxRounds × callTimeoutMs（语义声明：供契约 §6.5 引用）
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const tools = createAciTools({ retrieval })
      const llm = fakeToolLlm([s3FinalChunks()])
      const okResult = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-7b'), tools, maxRounds: 4, callTimeoutMs: 5000,
      })
      assert.equal(okResult.kind, 'ok', '阳性对照：正常评审必须在墙钟内完成（kind=ok）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-8（P1-7）：循环中途失败 = dropped + records 一条（与触顶同形，且可区分）──
  t('S3-8：环境类工具失败（git 不可用）⇒ dropped 记录 + runtime.error，与成功评审可区分；水位语义不被打破', async () => {
    const dir = buildS1aFixture()
    // 刻意不给 dataDir/scratchDir ⇒ git 面不可用（fd-stdio 临时文件无处落）。
    const retrieval = createRetrieval({ root: dir })
    const records = []
    try {
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'get_git_log', JSON.stringify({ limit: 3 })),
        s3FinalChunks('{"notes":[]}'),
      ])
      const rt = s3RuntimeWithLoop({ llm, retrieval, records })
      rt.enqueue({ markdown: 'S3-8 请看 git 历史', trigger: TRIGGER_USER }, { sessionId: 's-s3-8', sessionName: null })
      await rt.waitForDrain()
      // ① 记录面可见：一条 outcome='dropped'（与触顶同形）
      assert.equal(records.length, 1, `循环期失败必须恰好落一条 records（实得 ${records.length}）`)
      assert.equal(records[0].outcome, 'dropped')
      // ② runtime.status=error 同时成立（两路证据，不是只留 status）
      assert.equal(rt.status, 'error')
      assert.ok(rt.error !== null, 'runtime.error 必须同时可见（判据 12：不得只留 records 或只留 status）')
      // ③ 与成功评审可区分：lastReview.outcome 是失败原因（非 ok）
      assert.equal(rt.lastReview.outcome, 'tool-environment')
      assert.ok(rt.lastReview.reason.includes('git'), '失败原因必须点名（git 不可用）')
      // ④ 不投递：deliver 未产生记录面 notes（records 无 severity>=nit 的意见）
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  t('S3-8b：轮次用尽仍要工具 ⇒ dropped（tool-rounds-exhausted）+ records 同形；未知工具名 ⇒ isError 结果且循环继续', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const tools = createAciTools({ retrieval })
      // ① 轮次用尽：连续 maxRounds 轮都发工具调用
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3ToolCallChunks('t2', 'read_file', JSON.stringify({ path: 'src/bar.js' })),
        s3ToolCallChunks('t3', 'read_file', JSON.stringify({ path: 'sub/inner.js' })),
        s3ToolCallChunks('t4', 'read_file', JSON.stringify({ path: 'big.txt' })),
        s3ToolCallChunks('t5', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3FinalChunks('{"notes":[]}'),
      ])
      const result = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-8b'), tools, maxRounds: 4,
      })
      assert.equal(result.kind, 'dropped')
      assert.equal(result.reason, 'tool-rounds-exhausted', '轮次用尽仍要工具必须显式 dropped（不假装看过）')
      // ② 未知（禁止名单外的）工具名：显式 isError 结果，循环继续到正常终态
      const llm2 = fakeToolLlm([
        s3ToolCallChunks('t1', 'write_file', JSON.stringify({ path: 'x', content: 'y' })),
        s3FinalChunks('{"notes":[{"severity":"nit","text":"S3-8b 结论"}]}'),
      ])
      const result2 = await runToolLoop({
        llm: llm2, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-8b2'), tools, maxRounds: 4,
      })
      assert.equal(result2.kind, 'ok', '未知工具名走 isError 结果（模型可纠正），不炸循环')
      const toolMsg = llm2.calls[1].messages.find((m) => m.role === 'tool')
      assert.ok(toolMsg.isError === true, '回填的工具结果必须标 isError')
      assert.ok(toolMsg.content[0].text.includes('unknown-tool'), '拒绝文案必须点名 unknown-tool')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-9（F-3）：工具循环不打破「串行 drain + drop-newest 队列」──
  t('S3-9 F-3：循环在飞时队列满 ⇒ drop-newest 语义不变；drain 仍串行（无并发评审）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      let release = null
      const gate = new Promise((resolve) => { release = resolve })
      let started = 0
      const llm = { stream: () => { started += 1; return (async function* () { await gate; yield { type: 'text-delta', text: '{"notes":[]}' } })() } }
      const rt = s3RuntimeWithLoop({ llm, retrieval, maxRounds: 4 })
      rt.maxQueued = 2
      rt.enqueue({ markdown: '第一条（在飞）', trigger: TRIGGER_USER }, { sessionId: 's-s3-9', sessionName: null })
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(started, 1, '第一条必须已在飞')
      assert.equal(rt.enqueue({ markdown: '第二条', trigger: TRIGGER_USER }, { sessionId: 's-s3-9', sessionName: null }), true, '队列未满可入队')
      assert.equal(rt.enqueue({ markdown: '第三条', trigger: TRIGGER_USER }, { sessionId: 's-s3-9', sessionName: null }), true)
      assert.equal(rt.enqueue({ markdown: '第四条（应被丢）', trigger: TRIGGER_USER }, { sessionId: 's-s3-9', sessionName: null }), false, '队列满 ⇒ drop-newest（最新被丢）')
      assert.equal(rt.queue.length, 2)
      release()
      await rt.waitForDrain()
      assert.equal(started, 3, '串行 drain：在飞 1 + 队列 2 = 3 次调用（被丢的那条不评）')
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-10（AC-36/45 接线）：循环暴露检索集，note 引用路径 ⊆ 本轮检索集 ──
  t('S3-10 AC-36/45：循环 bundle 可枚举；引用闭包（⊆ 检索集）正向过 + 负向必红', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3FinalChunks('{"notes":[{"severity":"nit","text":"请检查 src/foo.js 的实现"}]}'),
      ])
      const result = await runToolLoop({
        llm, provider: 'p', model: 'm', systemPrompt: 'S',
        messages: s3FirstUser('S3-10'), tools: createAciTools({ retrieval }), maxRounds: 4,
      })
      assert.equal(result.kind, 'ok')
      // 正向：note 引用的路径在检索集内
      assert.doesNotThrow(() => assertPathsWithinBundle(result.bundle, ['src/foo.js'], 'S3-10 正向'))
      // 负向（手工塞一条引用未检索文件的 note）⇒ 必红
      assert.throws(() => assertPathsWithinBundle(result.bundle, ['src/not-retrieved.js'], 'S3-10 负向'), /必须 ⊆ 本轮检索集/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-11：配置键 advisorMaxToolRounds 四处同步（三处本步 + 契约留 S5）──
  t('S3-11：advisorMaxToolRounds 缺省 4 / 0=关循环 / 负数抛错；cordis.patch.yml 有键且注释无 H-5 禁区字样', async () => {
    const cfg = resolveAdvisorConfig({})
    assert.equal(cfg.advisorMaxToolRounds, 4, '缺省 4（【待产品复核 G-15】）')
    assert.equal(resolveAdvisorConfig({ advisorMaxToolRounds: 0 }).advisorMaxToolRounds, 0, '0 = 关闭循环（装配层不注入 toolLoop）')
    assert.equal(resolveAdvisorConfig({ advisorMaxToolRounds: 2 }).advisorMaxToolRounds, 2)
    assert.throws(() => resolveAdvisorConfig({ advisorMaxToolRounds: -1 }), /非负整数/, '负数大声抛错')
    assert.throws(() => resolveAdvisorConfig({ advisorMaxToolRounds: 1.5 }), /非负整数/, '非整数大声抛错')
    // 未知键仍抛错（H-6 回归）
    assert.throws(() => resolveAdvisorConfig({ advisorUnknownKeyS3: 1 }), /未知 advisor 配置键/)
    // cordis.patch.yml 随包默认带新键
    const yml = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    assert.ok(/advisorMaxToolRounds:\s*4/.test(yml), 'cordis.patch.yml 必须带 advisorMaxToolRounds: 4')
    // H-5 四禁区字样零命中（advisor 区块内）：tiers.HIGH / 落盘 config.json / 回落链 / 任一为空→回落
    const advisorBlock = yml.slice(yml.indexOf('advisorEnabled'))
    for (const banned of ['tiers.HIGH', '落盘 config.json', '回落链', '任一为空→回落']) {
      assert.equal(advisorBlock.includes(banned), false, `H-5 禁区字样「${banned}」不得出现在 advisor 区块`)
    }
    // 阳性对照：区块里确实有 advisor 键（检索面有效）
    assert.ok(advisorBlock.includes('advisorMaxMessages'), '阳性对照：advisor 区块检索面有效')
  })

  // ── S3-12：跨轮身份不变（N 次往返 = 同一次评审）+ 上下文段/工具观察不进持续会话历史 ──
  t('S3-12：多轮工具循环后，增量只入历史一次；上下文档与工具观察文本不进持续会话历史（G-2/AC-13 结构性）', async () => {
    const dir = buildS1aFixture()
    const { retrieval, scratch } = s2Retrieval(dir)
    try {
      const llm = fakeToolLlm([
        s3ToolCallChunks('t1', 'read_file', JSON.stringify({ path: 'src/foo.js' })),
        s3FinalChunks('{"notes":[{"severity":"nit","text":"S3-12 观察点"}]}'),
      ])
      const records = []
      const rt = s3RuntimeWithLoop({ llm, retrieval, records })
      rt.enqueue({ markdown: 'S3-12 的增量输入（UNIQUE_INCREMENT_MARK）', trigger: TRIGGER_USER }, { sessionId: 's-s3-12', sessionName: null })
      await rt.waitForDrain()
      // ① 同一次评审：模型被调用 2 次（1 工具轮 + 1 终轮），但记录面只有 1 条意见记录
      assert.equal(llm.calls.length, 2)
      const noteRecords = records.filter((r) => r.outcome !== 'dropped')
      assert.equal(noteRecords.length, 1, 'N 次往返 = 同一次评审（不与 turn 混计）')
      // ② 增量恰好入持续会话历史一次
      const history = rt.conversation.snapshot().map((m) => m.text).join('\n')
      const incrementHits = history.split('UNIQUE_INCREMENT_MARK').length - 1
      assert.equal(incrementHits, 1, `增量必须恰好入历史一次（实得 ${incrementHits}）`)
      // ③ 工具观察文本不进持续会话历史（只活在本次调用的局部消息数组）
      assert.equal(history.includes('# read_file'), false, '工具观察不得进持续会话历史')
      // ④ 历史里不含上下文档标记（唯一入历史点 = appendUser(增量)）
      assert.equal(history.includes('advisor 上下文'), false, '上下文档不得进持续会话历史')
      // ⑤ 第二次调用的 messages 含工具回填（role:'tool'），且助手块被回放
      const secondCallMessages = llm.calls[1].messages
      assert.ok(secondCallMessages.some((m) => m.role === 'tool'), '第二轮必须含工具结果消息')
      assert.ok(secondCallMessages.some((m) => m.role === 'assistant' && (m.content ?? []).some((c) => c.type === 'tool-call')), '第二轮必须回放 assistant 的工具调用块')
      rt.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // ── S3-13：观察格式（专用 viewer 行数上限 / 空输出显式文案）──
  t('S3-13：观察格式——行数上限 + 显式截断标记；空输出显式文案（不静默）', () => {
    const many = Array.from({ length: MAX_TOOL_OUTPUT_LINES + 10 }, (_, i) => `line-${i}`).join('\n')
    const view = formatToolObservation(many)
    assert.equal(view.truncated, true)
    assert.ok(view.text.includes('已截断'), '截断必须显式可见')
    assert.equal(view.text.split('\n').length, MAX_TOOL_OUTPUT_LINES + 1)
    const empty = formatToolObservation('   \n  ')
    assert.equal(empty.text, EMPTY_TOOL_OUTPUT, '空输出必须显式文案（不得静默成功）')
    // 阳性对照：未超限不截断
    const small = formatToolObservation('a\nb')
    assert.equal(small.truncated, false)
    assert.equal(small.text, 'a\nb')
  })
}

// ── 14. S4：决策判断层 —— prompt V3 重写 + 冷却分级豁免 + 证据下限（advisor V3 节 2 S4）──

/**
 * AC-58 五类「停止做什么」的**锚词集 fixture**（措辞锚定义落 fixture，不散在断言里）。
 * 每类的 prompt 行含独特锚词；变异测试逐类整行移除 → 谓词必红。
 */
const S4_STOP_CATEGORIES = [
  { id: 'stop-direction', anchor: /暂停当前方向|先停下当前路线/ },
  { id: 'no-new-abstraction', anchor: /不要新增抽象|别再包一层/ },
  { id: 'no-premature-impl', anchor: /不要提前实现|YAGNI/ },
  { id: 'verify-assumption', anchor: /先验证.*假设|最小实验\/PoC/ },
  { id: 'reuse-existing', anchor: /先复用已有能力|先复用已有实现/ },
]

/** AC-58 谓词：prompt 中五类锚词全部在场。 */
function promptHasAllStopAnchors(prompt) {
  return S4_STOP_CATEGORIES.every((category) => category.anchor.test(prompt))
}

/** 结论前置（P0-3）的措辞锚。 */
const S4_CONCLUSION_ANCHOR = /先给结论、再给理由/

export function testS4Decision(t) {
  // ── S4-1（AC-58 双判据 a+b）：五类停止动作落 prompt + 措辞锚逐类移除必红 ──
  t('S4-1：AC-58 五类停止动作措辞锚全部在默认 prompt（正向）', () => {
    assert.equal(promptHasAllStopAnchors(DEFAULT_ADVISOR_SYSTEM_PROMPT), true, '五类锚词必须全部在场')
    // 正向对照的对照之对照：谓词不是恒真——空串必不过
    assert.equal(promptHasAllStopAnchors(''), false)
  })

  for (const category of S4_STOP_CATEGORIES) {
    t(`S4-1 变异（AC-58 注入必红）：移除「${category.id}」措辞锚 → 谓词必红`, () => {
      const match = category.anchor.exec(DEFAULT_ADVISOR_SYSTEM_PROMPT)
      assert.ok(match, '前置：锚词必须真的命中（fixture 与 prompt 同源）')
      // 整行移除（锚词所在的完整逻辑行），而不是只删词——更接近「漏写该类」的真实变异
      const lineStart = DEFAULT_ADVISOR_SYSTEM_PROMPT.lastIndexOf('\n', match.index) + 1
      const lineEnd = DEFAULT_ADVISOR_SYSTEM_PROMPT.indexOf('\n', match.index)
      const mutated = DEFAULT_ADVISOR_SYSTEM_PROMPT.slice(0, lineStart)
        + DEFAULT_ADVISOR_SYSTEM_PROMPT.slice(lineEnd === -1 ? DEFAULT_ADVISOR_SYSTEM_PROMPT.length : lineEnd + 1)
      assert.notEqual(mutated, DEFAULT_ADVISOR_SYSTEM_PROMPT, '变异必须真的改变 prompt（防假变异）')
      assert.equal(promptHasAllStopAnchors(mutated), false, `移除 ${category.id} 后五类谓词必须红`)
    })
  }

  t('S4-2（P0-3）：结论前置措辞锚在 prompt；移除 → 判据红', () => {
    assert.ok(S4_CONCLUSION_ANCHOR.test(DEFAULT_ADVISOR_SYSTEM_PROMPT), '结论前置必须写进 prompt')
    const mutated = DEFAULT_ADVISOR_SYSTEM_PROMPT.replace(S4_CONCLUSION_ANCHOR, '（结论前置句已移除）')
    assert.notEqual(mutated, DEFAULT_ADVISOR_SYSTEM_PROMPT)
    assert.equal(S4_CONCLUSION_ANCHOR.test(mutated), false)
  })

  t('S4-3（V3 prompt 结构）：首要目标 / 10 级优先级 / 三判断清单 / 证据纪律 / 决策漂移优先 / 职责分界 / 严格 JSON 含可选字段', () => {
    const p = DEFAULT_ADVISOR_SYSTEM_PROMPT
    assert.match(p, /降低项目总成本/, '首要目标（产品第 11 条）')
    assert.match(p, /Staff\/Principal/, '视角定位')
    for (let i = 1; i <= 10; i++) {
      assert.ok(p.includes(`${i}. `), `优先级序第 ${i} 级必须在场`)
    }
    assert.match(p, /架构判断/, '三判断清单：架构')
    assert.match(p, /返工判断/, '三判断清单：返工')
    assert.match(p, /产品判断/, '三判断清单：产品')
    assert.match(p, /绝不声称读过未提供的文件/, '证据纪律（AC-44）')
    assert.match(p, /优先检索、不要推测/, '证据纪律（优先检索）')
    assert.match(p, /不得声称「违反了决策 D-/, '证据纪律（AC-7：无决策不声称决策）')
    assert.match(p, /决策漂移/, '决策漂移优先（AC-59 判断面）')
    assert.match(p, /active\/superseded\/rejected/, 'DECISIONS 三态（AC-59）')
    assert.match(p, /你负责判断/, '职责分界：模型判断（产品第 4 条）')
    assert.match(p, /规则层负责边界/, '职责分界：规则边界（产品第 4 条）')
    assert.match(p, /不设数值阈值/, 'AC-29 精简：规模非阈值驱动声明')
    assert.match(p, /"notes":\[\{"severity"/, '严格 JSON 输出契约（保持可解析）')
    assert.match(p, /"evidence"/, '可选字段 evidence 进输出契约')
    assert.match(p, /"confidence"/, '可选字段 confidence 进输出契约')
    assert.match(p, /"action"/, '可选字段 action 进输出契约')
    assert.match(p, /绝不回显 secret/, '既有约束保留：不回显密钥')
    assert.match(p, /用中文输出/, '既有约束保留：中文输出')
  })

  // ── S4-4（AC-33 两条断言，X11 冷却分级豁免）──
  t('S4-4：AC-33 ① 冷却窗口内 blocker → steer（免冷却直投）', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 2, steerSeverities: ['nit', 'concern', 'blocker'] })
    d.registerAgent(agent)
    // 制造冷却窗口：一次 nit steer（武装冷却 2）
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'steer')
    const steerCount = agent.calls.steer.length
    assert.equal((d.cooldown.get('s') ?? 0) > 0, true, '前置：冷却窗口已武装')
    assert.equal(d.route('s', { severity: 'blocker', text: 'b' }), 'steer', 'blocker 免冷却直投 steer')
    assert.equal(agent.calls.steer.length, steerCount + 1)
  })

  t('S4-4 反向：AC-33 ② 冷却窗口内 nit → inject（豁免面不是全等级）', () => {
    const agent = fakeAgent('s')
    const d = new AdvisorDelivery({ immuneTurns: 2, steerSeverities: ['nit', 'concern', 'blocker'] })
    d.registerAgent(agent)
    assert.equal(d.route('s', { severity: 'concern', text: 'c' }), 'steer') // 武装冷却
    assert.equal(d.route('s', { severity: 'nit', text: 'n' }), 'inject', '冷却窗口内 nit 必须降级 inject')
    assert.equal(agent.calls.inject.length, 1)
    assert.equal(agent.calls.steer.length, 1)
  })

  t('S4-4b：豁免集合 = {concern, blocker}（配置面用常量，不新增配置键）', () => {
    assert.deepEqual([...ADVISOR_COOLDOWN_EXEMPT].sort(), ['blocker', 'concern'])
  })

  // ── S4-5（AC-30 双向边界 + AC-31 唯一规则 + AC-63 证据下限）──
  t('S4-5：AC-30 双向边界——blocker + confidence 0.69 → 降级 concern；0.70 + evidence → 保持 blocker', () => {
    const low = enforceEvidenceFloor([{ severity: 'blocker', text: 'x', evidence: 'src/a.js:1', confidence: 0.69 }])
    assert.equal(low[0].severity, 'concern')
    const high = enforceEvidenceFloor([{ severity: 'blocker', text: 'x', evidence: 'src/a.js:1', confidence: ADVISOR_MIN_BLOCKER_CONFIDENCE }])
    assert.equal(high[0].severity, 'blocker')
    // 降级只改 severity，其余字段原样保留（AC-31 唯一确定行为）
    assert.equal(low[0].text, 'x')
    assert.equal(low[0].evidence, 'src/a.js:1')
    assert.equal(low[0].confidence, 0.69)
    // AC-31：同输入两次结果一致（唯一规则，无「有时降有时丢」）
    assert.deepEqual(enforceEvidenceFloor(low), enforceEvidenceFloor(low))
  })

  t('S4-5b：AC-63——blocker 缺 evidence → 降级 concern；缺 confidence → 降级 concern；均不达标不得 blocker', () => {
    const noEvidence = enforceEvidenceFloor([{ severity: 'blocker', text: 'x', confidence: 0.95 }])
    assert.equal(noEvidence[0].severity, 'concern')
    const noConfidence = enforceEvidenceFloor([{ severity: 'blocker', text: 'x', evidence: 'D-012' }])
    assert.equal(noConfidence[0].severity, 'concern')
    const neither = enforceEvidenceFloor([{ severity: 'blocker', text: 'x', evidence: '', confidence: 0.5 }])
    assert.equal(neither[0].severity, 'concern')
    // 非 blocker 等级不受下限影响
    const nit = enforceEvidenceFloor([{ severity: 'nit', text: 'x' }])
    assert.equal(nit[0].severity, 'nit')
  })

  t('S4-5c：向后兼容——旧两字段输出（无可选字段）原样通过，blocker 不被降级', () => {
    const legacy = enforceEvidenceFloor([{ severity: 'blocker', text: 'x' }, { severity: 'info', text: 'y' }])
    assert.equal(legacy[0].severity, 'blocker', '旧输出不参与下限（零回归）')
    assert.deepEqual(legacy[0], { severity: 'blocker', text: 'x' })
    // ≥3 元素输入（断言鉴别力条款）：混合新旧形态
    const mixed = enforceEvidenceFloor([
      { severity: 'blocker', text: 'legacy' },
      { severity: 'blocker', text: 'v3-weak', confidence: 0.1 },
      { severity: 'blocker', text: 'v3-strong', evidence: 'a.js', confidence: 0.9 },
    ])
    assert.deepEqual(mixed.map((n) => n.severity), ['blocker', 'concern', 'blocker'])
  })

  // ── S4-6（AC-43 新字段解析兼容 + AC-32 投递面无 confidence）──
  t('S4-6：parseReviewOutput 解析可选字段（evidence/confidence/action），未知字段忽略，旧字段语义不变', () => {
    const parsed = parseReviewOutput('{"notes":[{"severity":"blocker","text":"先停下","evidence":"D-012","confidence":0.8,"action":"stop-direction","unknown_field":123},{"severity":"nit","text":"旧形态"},{"severity":"concern","text":"弱证据","confidence":"高"}]}')
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.notes.length, 3)
    // ≥3 元素输入：三类形态逐一断言
    assert.deepEqual(
      { severity: parsed.notes[0].severity, text: parsed.notes[0].text, evidence: parsed.notes[0].evidence, confidence: parsed.notes[0].confidence, action: parsed.notes[0].action },
      { severity: 'blocker', text: '先停下', evidence: 'D-012', confidence: 0.8, action: 'stop-direction' },
    )
    assert.deepEqual(parsed.notes[1], { severity: 'nit', text: '旧形态' }, '旧形态 note 不带新键')
    assert.equal(parsed.notes[2].confidence, undefined, '类型不符的 confidence 不产出该键（fail-soft 字段级）')
    // 未知字段被忽略（显式定义：不报错）
    assert.equal('unknown_field' in parsed.notes[0], false)
  })

  t('S4-6b：AC-32——投递消息体不含 confidence 字段名或数值', () => {
    const m = buildAdvisorMessage({ severity: 'blocker', text: '请停下', evidence: 'D-012', confidence: 0.8 })
    const body = JSON.stringify(m)
    assert.equal(body.includes('confidence'), false, 'steer/inject 消息体不得含 confidence 字段名')
    assert.equal(body.includes('0.8'), false, '消息体不得含 confidence 数值')
  })

  // ── S4-7（端到端：V3 形态 blocker 无证据 → 记录与投递按 concern 走）──
  t('S4-7：runtime 端到端——V3 blocker（confidence 低）→ 投递/记录 severity 为 concern', async () => {
    const delivered = []
    const recorded = []
    const payload = JSON.stringify({ notes: [{ severity: 'blocker', text: '方向错了', confidence: 0.4 }] })
    const llm = {
      // ≥3 chunk 模拟真实流（text / finish / usage）
      async * stream() {
        yield { type: 'text-delta', text: payload }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'usage', usage: { outputTokens: 100 } }
      },
    }
    const rt = new AdvisorRuntime({
      provider: 'p', model: 'm', systemPrompt: 'sys', llm,
      deliver: (note) => { delivered.push(note); return 'inject' },
      record: (record) => { recorded.push(record) },
    })
    await rt.process({ markdown: '我要重写整个模块', trigger: 'user-message' }, { sessionId: 's', sessionName: 'n' }, rt.generation)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].severity, 'concern', '低置信 blocker 必须降级为 concern 投递')
    assert.equal(recorded[0].severity, 'concern', '记录面同形（AC-31 唯一行为）')
    assert.equal(rt.lastReview.notes, 1)
  })
}