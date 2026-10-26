/**
 * dsh-agents 直跑测试（node tests/run.mjs）——不用 node --test：
 * DSH 沙箱内 node 的 pipe 子进程捕获会 EPERM，测试必须单进程直跑。
 *
 * 覆盖两层：
 *  ① 纯逻辑：角色注册表 / 档位路由 / 任务书合成 / 派活前置三问 / 配置校验；
 *  ② 契约与流程（假宿主）：工具定义是否满足 DSH 硬约束（parameters 单一
 *     type + 顶层 required、output.schema + render），以及 agent_spawn 从
 *     组任务书到 agents.create + followup + attach 的完整链路。
 */
import assert from 'node:assert/strict'
import { ROLES, getRole, roleIds, normalizeTier, filterRoles, isolationOf } from '../lib/roles.js'
import {
  DEFAULT_TIERS, TIER_INTENT, resolveTierTable, resolveRoleOverrides, resolveRoute, resolveProviderForModel, listConfiguredRoutes, filterUsableCatalog,
} from '../lib/routing.js'
import { composeTaskbook, preflight, stamp, dedupeEvidencePath } from '../lib/taskbook.js'
import { loadPersona, listPersonaFiles, splitFrontmatter } from '../lib/persona.js'
import { listPresets } from '../lib/spawn.js'
import { resolveConfig, apply, Config } from '../lib/index.js'
import { ToolscopeStore, toolscopePath, normalizeToolscope, MINIMAL_TOOLSET_FULL, TOOLSCOPE_SCHEMA_VERSION } from '../lib/toolscope.js'
import {
  mcpPublicName, looseToolRefs, conservativeTaskRefs, decideToolscope,
  DedupNotifier, refuseKey, sharedLiftTable, installToolscopePipeline,
} from '../lib/toolscope-pipeline.js'
import {
  REPLY_DEFAULTS, REPLY_AUDIT_FILENAME, REPLY_TOOL_DESCRIPTION,
  resolveDeliveryMode, WakeRateLimiter, taskRef, agentReplyTool, installAgentReply,
} from '../lib/agent-reply.js'
import {
  loadRosterData, scanRoleReferences, buildCoverageReport, compareHostVersion,
  planRetentionSweep, POLICY_DIR,
} from '../lib/toolscope-roster.js'
import { efficiencyReadings, replayEntries, EFFICIENCY_THRESHOLD } from '../tools/toolscope-efficiency.mjs'
import { createTiersApi, CONFIG_SCHEMA } from '../lib/settings.js'
import { CONFIG_ENDPOINT, createConfigHandler } from '../lib/http-config.js'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let passed = 0
const failures = []
/** 跑一个断言块，记录失败但继续（一次拿到全部问题）。 */
function test(title, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
  }
}
async function testAsync(title, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
  }
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
/** 构造一个最小 cordis ctx（记录注册的工具、伪造 agents 服务）。
 * inject 模拟宿主语义：依赖服务都在 ctx 上时同步回调，否则不回调（等挂载）。 */
function fakeCtx(overrides = {}) {
  const tools = new Map()
  const created = []
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    agents: {
      create: async (options) => {
        created.push(options)
        return { agent: { followup: (msg) => created.push({ followup: msg }) }, dispose: () => {} }
      },
    },
    effect: (fn) => { fn() },
    inject: (deps, cb) => { if (deps.every((d) => ctx[d] !== undefined)) cb(ctx) },
    get: (name) => overrides[name],
  }
  Object.assign(ctx, overrides)
  return { ctx, tools, created }
}

// ── ① 角色注册表 ──────────────────────────────────────────────────────────
test('角色共 23 个且 id 唯一', () => {
  assert.equal(ROLES.length, 23)
  assert.equal(new Set(roleIds()).size, 23)
  for (const role of ROLES) assert.match(role.id, /^[a-z][a-z0-9-]*$/, `id 不合法：${role.id}`)
})

test('档位分布与来源一致（opus 10 / sonnet 11 / haiku 2；批次3 ECC 扩展 MEDIUM +1、HIGH +3）', () => {
  const byTier = (t) => ROLES.filter((r) => r.tier === t).length
  assert.equal(byTier('HIGH'), 10, 'HIGH(opus) 数量')
  assert.equal(byTier('MEDIUM'), 11, 'MEDIUM(sonnet) 数量')
  assert.equal(byTier('LOW'), 2, 'LOW(haiku) 数量')
})

test('档位别名与泳道过滤', () => {
  assert.equal(normalizeTier('haiku'), 'LOW')
  assert.equal(normalizeTier('SONNET'), 'MEDIUM')
  assert.equal(normalizeTier('opus'), 'HIGH')
  assert.equal(normalizeTier('nope'), null)
  assert.deepEqual(filterRoles({ lane: 'review' }).map((r) => r.id).sort(), ['code-reviewer', 'code-simplifier', 'critic', 'rag-reviewer', 'security-reviewer', 'silent-failure-hunter'])
  assert.deepEqual(filterRoles({ tier: 'haiku' }).map((r) => r.id).sort(), ['explore', 'writer'])
  assert.equal(filterRoles({ lane: 'build', tier: 'HIGH' }).length, 5) // analyst/planner/architect/harness-optimizer/spec-miner
})

test('只读角色集合与 OMC disallowedTools 一致', () => {
  const readonly = ROLES.filter((r) => r.readonly).map((r) => r.id).sort()
  assert.deepEqual(readonly, [
    'analyst', 'architect', 'code-reviewer', 'critic', 'document-specialist',
    'explore', 'rag-reviewer', 'scientist', 'security-reviewer', 'silent-failure-hunter', 'spec-miner', 'verifier',
  ])
})

// ── ② 档位路由 ────────────────────────────────────────────────────────────
test('档位表缺省回落内置默认、部分覆盖生效', () => {
  const table = resolveTierTable({ HIGH: { provider: 'glm-pro', model: 'glm-5.3' } })
  assert.deepEqual(table.HIGH, { provider: 'glm-pro', model: 'glm-5.3' })
  assert.deepEqual(table.LOW, DEFAULT_TIERS.LOW)
  assert.deepEqual(table.MEDIUM, DEFAULT_TIERS.MEDIUM)
})

test('档位表：未知档位键与半个路由都大声失败', () => {
  assert.throws(() => resolveTierTable({ ULTRA: { provider: 'x', model: 'y' } }), /未知档位/)
  assert.throws(() => resolveTierTable({ LOW: { provider: 'x' } }), /必须是非空字符串/)
})

test('角色覆盖表：未知角色报错', () => {
  assert.throws(
    () => resolveRoleOverrides({ nosuchrole: { provider: 'a', model: 'b' } }, (id) => getRole(id) !== undefined),
    /未知角色/,
  )
  const ok = resolveRoleOverrides({ executor: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, (id) => getRole(id) !== undefined)
  assert.deepEqual(ok.executor, { provider: 'deepseek', model: 'deepseek-v4-pro' })
})

test('路由解析：角色默认档 / 显式档 / 显式路由 / 角色覆盖优先级', () => {
  const table = resolveTierTable(undefined)
  const executor = getRole('executor')
  const base = resolveRoute({ role: executor, tierTable: table })
  assert.equal(base.tier, 'MEDIUM')
  assert.deepEqual([base.provider, base.model], [DEFAULT_TIERS.MEDIUM.provider, DEFAULT_TIERS.MEDIUM.model])
  assert.equal(base.source, 'tier-default')
  assert.equal(base.overridden, false)

  const raised = resolveRoute({ role: executor, tierTable: table, tier: 'opus' })
  assert.equal(raised.tier, 'HIGH')
  assert.equal(raised.source, 'explicit-tier')
  assert.equal(raised.overridden, true)
  assert.equal(raised.roleTier, 'MEDIUM')

  const explicit = resolveRoute({ role: executor, tierTable: table, provider: 'glm-pro', model: 'glm-5.3' })
  assert.equal(explicit.source, 'explicit-route')
  assert.deepEqual([explicit.provider, explicit.model], ['glm-pro', 'glm-5.3'])

  const half = resolveRoute({ role: executor, tierTable: table, model: 'glm-5.3' })
  assert.equal(half.source, 'explicit-route')
  assert.equal(half.provider, null, '只给 model 时 provider 留空，由调用方按名解析')
  assert.equal(half.model, 'glm-5.3')

  const overrides = resolveRoleOverrides({ executor: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, (id) => getRole(id) !== undefined)
  const byRole = resolveRoute({ role: executor, tierTable: table, roleOverrides: overrides })
  assert.equal(byRole.source, 'role-override')
  assert.equal(byRole.model, 'deepseek-v4-pro')

  const tierWins = resolveRoute({ role: executor, tierTable: table, roleOverrides: overrides, tier: 'LOW' })
  assert.equal(tierWins.source, 'explicit-tier', '显式档位优先于角色覆盖表')
  assert.equal(tierWins.tier, 'LOW')

  assert.throws(() => resolveRoute({ role: executor, tierTable: table, tier: 'ULTRA' }), /未知档位/)
})

test('缺宿主 llm/settings 时按模型名解析安全返回 undefined', async () => {
  assert.equal(await resolveProviderForModel({}, 'deepseek-flash'), undefined)
  assert.equal(await resolveProviderForModel({ llm: {}, settings: {} }, 'deepseek-flash'), undefined)
})

test('可用目录过滤：留有模型的；按适配器名单过滤；名单不可得时不误杀', () => {
  const full = {
    'glm-pro': ['glm-5.3-flash'],          // 有适配器有模型 → 留
    'deepseek': [],                        // 没配模型 → 剔
    'anthropic': ['claude-x'],             // 无适配器 → 剔
    'ghost': 'not-array',                  // 脏数据 → 剔
  }
  const filtered = filterUsableCatalog(full, ['glm-pro'])
  assert.deepEqual(filtered, { 'glm-pro': ['glm-5.3-flash'] })
  // 适配器名单拿不到（null）= 只剔无模型项，保留其余（降级不误杀）
  assert.deepEqual(filterUsableCatalog(full, null), { 'glm-pro': ['glm-5.3-flash'], anthropic: ['claude-x'] })
  assert.deepEqual(filterUsableCatalog(undefined, ['x']), {})
})

// ── ③ 任务书合成 ──────────────────────────────────────────────────────────
test('任务书含七节（八节已删），且钉死档位与模型', () => {
  const role = getRole('code-reviewer')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const text = composeTaskbook({
    role, persona, route, tierIntent: TIER_INTENT[route.tier], task: '审查 dsh-agents 的 lib/spawn.js',
    clarifyMode: 'interactive', evidencePath: 'D:\\tmp\\review.md', organizer: 'session-abc', cwd: 'D:\\tmp',
  })
  for (const section of ['## 一、角色卡', '## 二、职责与边界', '## 三、人格细则', '## 四、本次任务', '## 五、交付与验收', '## 六、澄清模式', '## 七、汇报与回收核对']) {
    assert.ok(text.includes(section), `缺小节 ${section}`)
  }
  assert.ok(text.includes('**HIGH**'))
  assert.ok(text.includes(DEFAULT_TIERS.HIGH.model))
  assert.ok(text.includes('**只读顾问**'), '只读角色必须标注只读边界')
  assert.ok(text.includes('双条件，缺一即未完成'))
  assert.ok(text.includes('D:\\tmp\\review.md'))
  assert.ok(text.includes('session-abc'))
  assert.ok(!text.includes('## 八、Claude Code → DSH 工具映射'), '八节已删（B0）：任务书不得再携带工具映射表')
  assert.ok(text.includes('de_broadcast'))
  assert.ok(text.includes('subagent-clarify'), 'interactive 模式须指向澄清协议技能')
})

test('autonomous 模式：禁提问 + 缺省决策表（内置兜底 / 调用方覆盖）', () => {
  const role = getRole('explore')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const auto = composeTaskbook({ role, persona, route, task: '找 X', clarifyMode: 'autonomous' })
  assert.ok(auto.includes('autonomous（禁提问）'))
  assert.ok(auto.includes('缺省决策表'))
  assert.ok(auto.includes('严禁编造事实'))
  assert.ok(!auto.includes('subagent-clarify'))
  const custom = composeTaskbook({ role, persona, route, task: '找 X', clarifyMode: 'autonomous', defaults: '| 缺项 | 默认 |\n|---|---|\n| 路径 | /x |' })
  assert.ok(custom.includes('| 路径 | /x |'))
})

test('可写角色不标只读', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const text = composeTaskbook({ role, persona: loadPersona(role), route, task: '实现 X' })
  assert.ok(text.includes('可写实施'))
  assert.ok(!text.includes('**只读顾问**'))
})

test('泳道默认交付要求随泳道变化', () => {
  const review = getRole('critic')
  const build = getRole('executor')
  const table = resolveTierTable(undefined)
  const reviewText = composeTaskbook({ role: review, persona: loadPersona(review), route: resolveRoute({ role: review, tierTable: table }), task: 't' })
  const buildText = composeTaskbook({ role: build, persona: loadPersona(build), route: resolveRoute({ role: build, tierTable: table }), task: 't' })
  assert.ok(reviewText.includes('报告落盘'))
  assert.ok(reviewText.includes('P0/P1/P2'))
  assert.ok(buildText.includes('证据'))
})

// ── ③b 任务书模板 v3 增量条款（§3a/§5.1/§5.2/§7.1/§4.1/§6.1/§8.1） ───────────
test('v3 §3a：statusQuo 提供时渲染现状盘点（含对账说明行），缺省时完全不渲染', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const base = { role, persona, route, task: 't' }
  const withStatus = composeTaskbook({ ...base, context: '背景若干', statusQuo: '| 盘点项 | 结果 |\n|---|---|\n| 产出文件 | 无 |' })
  assert.ok(withStatus.includes('### 现状盘点（派活前对账）'), 'statusQuo 提供时必须渲染现状盘点小节')
  assert.ok(withStatus.includes('组织者派活前对账结论'), '须前置「对账结论」说明行')
  assert.ok(withStatus.includes('盘点枚举失败≠对象不存在'), '须含「枚举失败≠对象不存在」条款')
  assert.ok(withStatus.includes('| 产出文件 | 无 |'), '用户传入正文须原样携带')
  assert.ok(withStatus.indexOf('### 现状盘点') > withStatus.indexOf('### 背景与上下文'), '现状盘点须排在背景与上下文之后')
  assert.ok(composeTaskbook({ ...base, statusQuo: '无历史产出' }).includes('### 现状盘点'), '无 context 时 statusQuo 仍须渲染')
  const without = composeTaskbook({ ...base, context: '背景若干' })
  assert.ok(!without.includes('现状盘点'), 'statusQuo 缺省时不得渲染该小节')
  assert.ok(!composeTaskbook({ ...base, statusQuo: '   ' }).includes('现状盘点'), '空白 statusQuo 视同缺省')
})

// IMP-26a P1 后续批（hunter 双席探针回归，2026-09-30）：六参数显式 null 不得渲染字面量
// "null"（String(null)==="null" 骗过 trim 非空判定）；organizer 空白串三态归一；
// autonomous 无路径降级出口改 L4 run 级失败申报（与禁提问条款不再矛盾）。
test('IMP-26a 修复：六参数 null 穿透不渲染 + organizer 空白串归一 + autonomous 降级 L4 语义', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const base = { role, persona, route, task: 't' }
  const nullText = composeTaskbook({ ...base, context: null, statusQuo: null, confirmedFindings: null, deliverable: null, acceptance: null, defaults: null, clarifyMode: 'autonomous' })
  assert.ok(!nullText.includes('### 背景与上下文'), 'null context 视同缺省（不得渲染该小节）')
  assert.ok(!nullText.includes('### 现状盘点'), 'null statusQuo 视同缺省')
  assert.ok(!nullText.includes('### confirmed_findings'), 'null confirmedFindings 视同缺省')
  assert.ok(!nullText.includes('验收标准（组织者判定用）'), 'null acceptance 视同缺省')
  assert.ok(!nullText.includes('null'), '全文不得出现字面量 null（六参数穿透已闭合）')
  const blankOrg = composeTaskbook({ ...base, organizer: '   ' })
  assert.ok(blankOrg.includes('未携带组织者会话 ID'), '空白串 organizer 须触发缺省警示（不得渲染空白收件地址）')
  const autoNoPath = composeTaskbook({ ...base, clarifyMode: 'autonomous' })
  assert.ok(autoNoPath.includes('run_failure=cwd_missing'), 'autonomous 无路径降级出口须指向 L4 run 级失败申报')
  assert.ok(!autoNoPath.includes('索要工作目录'), 'autonomous 降级文案不得残留「索要工作目录」的提问语义')
})

// DP-1 P2-9/F-15 修复回归：composeTaskbook 库层入参守卫（注入必红——坏入参必须响亮报错）
test('IMP-26a P2 批：composeTaskbook 入参守卫四态 throws', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  assert.throws(() => composeTaskbook({ persona, route, task: 't' }), /role/, '缺 role 须抛错')
  assert.throws(() => composeTaskbook({ role, persona, task: 't' }), /route/, '缺 route 须抛错（P2-9 裸崩溃改有信息报错）')
  assert.throws(() => composeTaskbook({ role, persona, route, task: '  ' }), /task/, '空白 task 须抛错')
  assert.throws(() => composeTaskbook({ role, persona, route, task: 't', clarifyMode: 'autnomous' }), /clarifyMode/, '拼错的 clarifyMode 须抛错（不得静默回落 interactive）')
})

test('v3 §5.1/§5.2：交付状态三值字段 + skip 必留痕', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const text = composeTaskbook({ role, persona: loadPersona(role), route, task: 't', acceptance: '断言全绿' })
  assert.ok(text.includes('交付状态三值字段'), '须有「交付状态三值字段」条款')
  assert.ok(text.includes('DELIVERED_WITH_EVIDENCE'), '执行者可自报 DELIVERED_WITH_EVIDENCE')
  assert.ok(text.includes('BLOCKED_NEED_HUMAN'), '执行者可自报 BLOCKED_NEED_HUMAN')
  assert.ok(text.includes('执行者自报 DONE 无效'), 'DONE 只能由组织者/用户确认')
  assert.ok(text.includes('skip 必留痕'), '须有「skip 必留痕」条款')
  assert.ok(text.includes('skipped + 原因 + 复跑命令'), 'skip 须记录原因与复跑命令')
  assert.ok(text.includes('不得计入通过项'), 'skipped 不得计入通过项')
})

test('v3 §7.1：断言鉴别力条款三条硬要求齐备', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const text = composeTaskbook({ role, persona: loadPersona(role), route, task: 't' })
  assert.ok(text.includes('断言鉴别力条款'), '须有「断言鉴别力条款」')
  assert.ok(text.includes('≥3 元素输入'), '① 解析/分类类须有 ≥3 元素输入断言')
  assert.ok(text.includes('注入必红') && text.includes('负向自测'), '② 新增闸门须配注入必红负向自测')
  assert.ok(text.includes('真实输入无 workaround 全量跑'), '③ 须含真实输入全量跑一项')
})

test('v3 §4.1：失败降级分层表 L1–L4 齐备，且 interactive 超时指向 L2（单一口径）', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const interactive = composeTaskbook({ role, persona, route, task: 't', clarifyMode: 'interactive' })
  assert.ok(interactive.includes('失败降级分层表'), '须有失败降级分层表')
  for (const [level, action] of [['L1', '查缺省决策表'], ['L2', '该字段为默认值'], ['L3', '说明替代方式'], ['L4', '不得静默停止']]) {
    assert.ok(interactive.includes(`| ${level} |`), `降级表缺 ${level} 行`)
    assert.ok(interactive.includes(action), `${level} 行动作语义缺失：${action}`)
  }
  const timeoutLine = interactive.split('\n').find((line) => line.includes('超时降级'))
  assert.ok(timeoutLine && timeoutLine.includes('L2'), 'interactive 超时降级须指向分层表 L2，避免双口径')
  // 分层表两模式共用（autonomous 亦须携带，便于 L3/L4 处置）
  const auto = composeTaskbook({ role, persona, route, task: 't', clarifyMode: 'autonomous' })
  assert.ok(auto.includes('失败降级分层表'), 'autonomous 模式同样携带降级分层表')
})

test('v3 §6.1/§8.1：回合上界与增量指引 + 等待态退出码表 0/2/3/4/5', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const text = composeTaskbook({ role, persona: loadPersona(role), route, task: 't' })
  assert.ok(text.includes('最多 3 轮无新落盘增量的往返'), '须有回合上界（3 轮无增量即收尾）')
  assert.ok(text.includes('广播移交组织者重划界'), '达限须列清单广播移交组织者')
  assert.ok(text.includes('不重做已确认的部分'), '增量指引：只处理增量，不重做已确认部分')
  assert.ok(text.includes('等待态退出码表'), '须有等待态退出码表')
  for (const code of ['0', '2', '3', '4', '5']) assert.ok(text.includes(`| ${code} |`), `退出码表缺码 ${code}`)
  for (const [code, meaning] of [['0', '正常回收'], ['2', '未广播'], ['3', '已广播但组织者未确认'], ['4', '断点重派'], ['5', '不判死不重派']]) {
    const line = text.split('\n').find((l) => l.startsWith(`| ${code} |`))
    assert.ok(line && line.includes(meaning), `退出码 ${code} 的语义缺失：${meaning}`)
  }
})

// ── ③c 新条款断言自检：注入必红（防恒真断言） ─────────────────────────────
test('v3 新条款断言注入必红：删掉对应条款后各谓词变假（断言有鉴别力）', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const text = composeTaskbook({ role, persona: loadPersona(role), route, task: 't', statusQuo: '无历史产出' })
  // 变异体 = 抹掉承载该条款的那一行；谓词与上面的存在性断言同构。
  const drop = (needle) => text.split('\n').filter((line) => !line.includes(needle)).join('\n')
  const cases = [
    ['现状盘点', '#1', (t) => t.includes('### 现状盘点（派活前对账）') && t.includes('盘点枚举失败≠对象不存在'), '### 现状盘点'],
    ['三值字段', '#2', (t) => t.includes('DELIVERED_WITH_EVIDENCE') && t.includes('执行者自报 DONE 无效'), '交付状态三值字段'],
    ['skip 留痕', '#5', (t) => t.includes('skipped + 原因 + 复跑命令') && t.includes('不得计入通过项'), 'skip 必留痕'],
    ['断言鉴别力', '#4', (t) => t.includes('≥3 元素输入') && t.includes('真实输入无 workaround 全量跑'), '断言鉴别力条款'],
    ['降级分层表', '#13', (t) => t.includes('| L4 |') && t.includes('广播卡点'), '| L4 |'],
    ['退出码表', '#12', (t) => t.includes('| 5 |') && t.includes('不判死不重派'), '| 5 |'],
    ['回合上界', '#8', (t) => t.includes('最多 3 轮无新落盘增量的往返'), '回合上界：'],
  ]
  for (const [name, no, predicate, needle] of cases) {
    assert.equal(predicate(text), true, `${name}（${no}）谓词在原件上应为真`)
    assert.equal(predicate(drop(needle)), false, `${name}（${no}）注入变异后谓词必红`)
  }
})

// ── ③d IMP-26a（DP-1 修复 + 只读白名单注入） ───────────────────────────────
test('IMP-26a ① 完成广播带（wake:true）与 L4 同口径；organizer 缺失附直投地址警示', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const withOrg = composeTaskbook({ role, persona, route, task: 't', organizer: 'session-org-1' })
  // 精确锚点：回收契约行也含「完成广播」字样，必须锚定第七节广播条款行本体
  const broadcastLine = withOrg.split('\n').find((l) => l.includes('完成广播：`de_broadcast`'))
  assert.ok(broadcastLine, '须存在「完成广播：de_broadcast」条款行')
  assert.ok(broadcastLine.includes('（wake:true）'), '完成广播条款必须带（wake:true）（DP-1 P1-2：inject 不唤醒）')
  assert.ok(broadcastLine.includes('`session-org-1`'), 'organizer 必须渲染为直投收件地址')
  assert.ok(withOrg.includes('（wake:true）广播卡点'), '同文本内 L4 条款仍带（wake:true）——两处同口径')
  const noOrg = composeTaskbook({ role, persona, route, task: 't' })
  const noOrgLine = noOrg.split('\n').find((l) => l.includes('完成广播：`de_broadcast`'))
  assert.ok(noOrgLine, '须存在「完成广播：de_broadcast」条款行')
  assert.ok(noOrgLine.includes('（wake:true）'), '无 organizer 时 wake:true 不缺席')
  assert.ok(noOrgLine.includes('未携带组织者会话 ID') && noOrgLine.includes('禁止群发'), '无 organizer 须附「向派活方索取直投地址」警示')
})

test('IMP-26a ② 澄清超时口径字面一致：三档三处提取与正本全等（CODE-P2-2）', () => {
  const genSrc = readFileSync(fileURLToPath(new URL('../lib/taskbook.js', import.meta.url)), 'utf8')
  const docSrc = readFileSync(fileURLToPath(new URL('../docs/task-brief-v3.md', import.meta.url)), 'utf8')
  // D-1a 把「5 分钟」裂成三处措辞（LOW 无「过」/HIGH 带「超时：」前缀/MEDIUM 现行）——
  // 三处分别提取并断言与正本全等（旧版单正则只命中 MEDIUM，LOW/HIGH 失去钉死锚点）。
  const lowMatch = /超\s*(\d+)\s*分钟无回音/.exec(genSrc)
  const highMatch = /超时：\s*(\d+)\s*分钟/.exec(genSrc)
  const medMatch = /超过\s*(\d+)\s*分钟无回音/.exec(genSrc)
  const docMatch = /超时 <N=(\d+)> 分钟/.exec(docSrc)
  assert.ok(lowMatch, '生成面 LOW 须含「超 N 分钟无回音」字面')
  assert.ok(highMatch, '生成面 HIGH 须含「超时：N 分钟」字面')
  assert.ok(medMatch, '生成面 MEDIUM 须含「超过 N 分钟无回音」字面')
  assert.ok(docMatch, '正本须含「超时 <N=x> 分钟」占位')
  assert.equal(lowMatch[1], docMatch[1], `LOW（${lowMatch[1]} 分钟）与正本（${docMatch[1]} 分钟）口径必须一致（DP-1 P1-3）`)
  assert.equal(highMatch[1], docMatch[1], `HIGH（${highMatch[1]} 分钟）与正本（${docMatch[1]} 分钟）口径必须一致（DP-1 P1-3）`)
  assert.equal(medMatch[1], docMatch[1], `MEDIUM（${medMatch[1]} 分钟）与正本（${docMatch[1]} 分钟）口径必须一致（DP-1 P1-3）`)
  assert.equal(lowMatch[1], '5', '统一取值=5（LOW；如改值须三处+正本+本断言同改）')
  assert.equal(highMatch[1], '5', '统一取值=5（HIGH；如改值须三处+正本+本断言同改）')
  assert.equal(medMatch[1], '5', '统一取值=5（MEDIUM 正本；如改值须三处+正本+本断言同改）')
})

await testAsync('IMP-26a ③ organizer/statusQuo/confirmedFindings 进两工具 schema 且透传渲染', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, {})
  for (const name of ['agent_taskbook', 'agent_spawn']) {
    const props = tools.get(name).parameters.properties
    for (const key of ['organizer', 'statusQuo', 'confirmedFindings']) {
      assert.equal(props[key]?.type, 'string', `${name} 缺 ${key} 参数（DP-1 P1-A/B 死参数修复）`)
    }
  }
  const tool = tools.get('agent_taskbook')
  const r = await tool.execute({
    role: 'code-reviewer', task: '增量评审',
    statusQuo: '| 盘点项 | 结果 |\n|---|---|\n| 上轮产出 | review/r1.md |',
    confirmedFindings: '1. src/a.js:10 - `foo()` 未判空 - 结论：已修复\n2. src/b.js:20 - `bar()` 越界 - 结论：已修复\n3. src/c.js:30 - `baz()` 泄漏 - 结论：已修复',
    organizer: 'session-org-9', evidencePath: 'D:\\tmp\\r2.md',
  })
  assert.equal(r.ok, true, r.message ?? '')
  assert.ok(r.taskbook.includes('### 现状盘点（派活前对账）'), 'statusQuo 须经工具面渲染 §3a 小节')
  assert.ok(r.taskbook.includes('| 上轮产出 | review/r1.md |'), 'statusQuo 正文原样透传')
  assert.ok(r.taskbook.includes('### confirmed_findings（上一轮已结论清单'), 'confirmedFindings 须经工具面渲染 §9.1 块')
  for (const line of ['1. src/a.js:10', '2. src/b.js:20', '3. src/c.js:30']) {
    assert.ok(r.taskbook.includes(line), `已结论清单 ≥3 元素逐条透传：${line}`)
  }
  assert.ok(r.taskbook.includes('不得因清单存在而止步') && r.taskbook.includes('免查需凭证'), '否定式指令与免查凭证条款自动附加')
  assert.ok(r.taskbook.includes('`session-org-9`'), 'organizer 经工具面渲染为广播收件地址')
})

test('IMP-26a ④ v3.1 三节落地：§5.3/§6.2 两模式固定携带，§9.1 缺省不渲染', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  for (const mode of ['interactive', 'autonomous']) {
    const text = composeTaskbook({ role, persona, route, task: 't', clarifyMode: mode })
    assert.ok(text.includes('三层失败分类（未完成步骤必须落层申报，禁止混用）'), `${mode}：§5.3 三层失败分类条款缺席（DP-1 P1-1）`)
    for (const marker of ['attempt 级', 'item 级', 'run 级', 'run_failure=', 'skipped(封闭枚举理由)+复跑命令']) {
      assert.ok(text.includes(marker), `${mode}：§5.3 缺要素 ${marker}`)
    }
    assert.ok(text.includes('### 三档熔断与收尾宽限轮'), `${mode}：§6.2 小节缺席`)
    assert.ok(text.includes('这是第二次连续失败，修参数或交付') && text.includes('最后一轮只能交付'), `${mode}：§6.2 三档反馈/收尾宽限语义缺失`)
  }
  const plain = composeTaskbook({ role, persona, route, task: 't' })
  assert.ok(!plain.includes('confirmed_findings（上一轮已结论清单'), 'confirmedFindings 缺省时 §9.1 块不渲染')
})

test('IMP-26a ⑤ 产出路径兜底链闭合：无路径渲染降级出口，硬门①不悬空；null 不串化', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const interactive = composeTaskbook({ role, persona, route, task: 't', clarifyMode: 'interactive' })
  assert.ok(interactive.includes('产出落盘路径：⚠️ **未指定**'), '无路径须渲染显式警示行（DP-1 F-4）')
  assert.ok(interactive.includes('向组织者索要明确路径'), 'interactive 降级出口=向组织者索要路径')
  assert.ok(!interactive.includes('到上面指定路径'), '无路径时硬门①不得悬空引用「上面指定路径」')
  assert.ok(interactive.includes('路径未预置'), '硬门①须改用降级措辞')
  const auto = composeTaskbook({ role, persona, route, task: 't', clarifyMode: 'autonomous' })
  assert.ok(auto.includes('按下方「缺省决策表」的产出路径行取默认落点'), 'autonomous 降级出口=缺省决策表')
  assert.ok(!auto.includes('`null`'), 'evidencePath=null 不得串化渲染字面 null')
  const withPath = composeTaskbook({ role, persona, route, task: 't', evidencePath: 'D:\\tmp\\out.md' })
  assert.ok(withPath.includes('到上面指定路径') && !withPath.includes('⚠️ **未指定**'), '有路径时硬门①保持原措辞且不渲染警示')
})

test('IMP-26a 白名单：readonly 角色自动携带、可写角色不携带（全角色分类断言 ≥3 元素）', () => {
  const table = resolveTierTable(undefined)
  let readonlyCount = 0
  for (const role of ROLES) {
    const text = composeTaskbook({ role, persona: loadPersona(role), route: resolveRoute({ role, tierTable: table }), task: 't' })
    const has = text.includes('### 只读工具白名单（readonly 硬边界）')
    assert.equal(has, role.readonly === true, `${role.id}（readonly=${role.readonly}）白名单携带状态错误`)
    if (role.readonly === true) {
      readonlyCount += 1
      for (const marker of ['`grep`', '`cat`', '`ls`', '`read`', '`git log`', '`git diff`', '`git show --no-pager`']) {
        assert.ok(text.includes(marker), `${role.id} 白名单缺允许项 ${marker}`)
      }
      for (const ban of ['`rm` 等删除类命令', '`git push` 等远端/仓库状态变更', '`npm install` 等依赖安装']) {
        assert.ok(text.includes(ban), `${role.id} 白名单缺禁止项 ${ban}`)
      }
      assert.ok(text.includes('说明意图') && text.includes('确认后方可执行'), `${role.id} 缺「说明意图后请求确认」出口`)
    }
  }
  assert.ok(readonlyCount >= 3, `readonly 角色应 ≥3 个，实际 ${readonlyCount}`)
})

// ── ③e D-1a 档位差异化（AC-M2-1，plan-opt-r2 工作流 D 免费段） ────────────────
// 断言鉴别力①：≥3 元素（同角色 × LOW/MEDIUM/HIGH 三档路由）——单元素/双臂断言
// 分不出「串接/取首个/按角色贴标签」假实现；同角色只变档位直接证明渲染由档位输入驱动。
const D1A_TASK = '梳理 tools 目录脚本的用途清单'
function d1aCompose(tier, roleId = 'explore', extra = {}) {
  const role = getRole(roleId)
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined), tier })
  return composeTaskbook({ role, persona: loadPersona(role), route, task: D1A_TASK, ...extra })
}
const D1A_HAS_LOW = (t) => t.includes('| 情况 |')
// CODE-P2-6：HIGH 档 R1–R5 逐条编号前缀各查 + R3 的 run_failure 标记（既单查 few-shot+R1 时
// R2–R5 被误删/改写无门红）；注入必红随之取任一单条 R 行删除即翻假（见 ④ 注入断言）。
const D1A_HAS_HIGH = (t) => t.includes('### few-shot')
  && ['- R1 ', '- R2 ', '- R3 ', '- R4 ', '- R5 '].every((p) => t.includes(p))
  && t.includes('run_failure')

test('D-1a 档位差异化：同角色×三档渲染互异且各命中模式特征（防串接/取首个）', () => {
  const low = d1aCompose('LOW')
  const med = d1aCompose('MEDIUM')
  const high = d1aCompose('HIGH')
  // ① 三档输出两两不等（模板面 diff 非空——三档返回同一形态即假实现）
  assert.notEqual(low, med)
  assert.notEqual(med, high)
  assert.notEqual(low, high)
  // ② 各档命中自己的模式特征，且不携带他档特征（LOW=决策表 / HIGH=few-shot+R 编号）
  assert.ok(D1A_HAS_LOW(low), 'LOW 须含分类决策表（| 情况 | 表）')
  assert.ok(!low.includes('### few-shot') && !low.includes('- R1 '), 'LOW 不得携带 HIGH 特征')
  assert.ok(D1A_HAS_HIGH(high), 'HIGH 须含 few-shot 段与 spec 编号条款')
  assert.ok(!high.includes('| 情况 |'), 'HIGH 不得携带 LOW 特征')
  // ③ MEDIUM=现行形态（v3.3 定稿=A2b+5ef5c7e R3 返工，逐字冻结；D-1b 消融对照臂基线）：三特征全不携带
  assert.ok(!D1A_HAS_LOW(med) && !D1A_HAS_HIGH(med), 'MEDIUM 须保持现行形态（无 LOW/HIGH 特征）')
  // ④ 注入必红（断言鉴别力②）：抹掉特征行后各谓词必假——谓词非恒真
  const drop = (text, needle) => text.split('\n').filter((line) => !line.includes(needle)).join('\n')
  assert.equal(D1A_HAS_LOW(drop(low, '| 情况 |')), false, 'LOW 特征谓词注入必红')
  assert.equal(D1A_HAS_HIGH(drop(high, '### few-shot')), false, 'HIGH 特征谓词注入必红（few-shot 行）')
  assert.equal(D1A_HAS_HIGH(drop(high, '- R3 ')), false, 'HIGH 特征谓词注入必红（R3 编号行——CODE-P2-6 逐条锚点可独立杀伤）')
})

test('D-1a 三自然档角色同任务 dryRun：explore/executor/analyst 各归各位且模板段互异', () => {
  // 计划断言①照录：≥3 角色 × 同一任务 dryRun 合成，LOW/HIGH 输出 diff 非空且各命中模式特征
  const build = (id) => {
    const role = getRole(id)
    return composeTaskbook({ role, persona: loadPersona(role), route: resolveRoute({ role, tierTable: resolveTierTable(undefined) }), task: D1A_TASK })
  }
  const explore = build('explore') // LOW
  const executor = build('executor') // MEDIUM
  const analyst = build('analyst') // HIGH
  assert.ok(D1A_HAS_LOW(explore), 'explore(LOW) 命中决策表特征')
  assert.ok(!D1A_HAS_LOW(executor) && !D1A_HAS_HIGH(executor), 'executor(MEDIUM) 保持现行')
  assert.ok(D1A_HAS_HIGH(analyst), 'analyst(HIGH) 命中 few-shot+spec 特征')
  // 模板静态段（§五~§七，人格之外的部分）跨档 diff 非空：差异在模板本身，不只是人格
  const slice = (t) => t.slice(t.indexOf('## 五、'), t.indexOf('## 一、角色卡'))
  assert.notEqual(slice(explore), slice(analyst), 'LOW/HIGH 模板段 diff 非空')
  assert.notEqual(slice(executor), slice(analyst), 'MEDIUM/HIGH 模板段 diff 非空')
  assert.notEqual(slice(explore), slice(executor), 'LOW/MEDIUM 模板段 diff 非空')
})

// ── ④ 派活前置三问 ────────────────────────────────────────────────────────
test('三问恒为 3 条；副作用动作命中告警；越档有理由位', () => {
  const role = getRole('executor')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const plain = preflight({ role, task: '读 lib/index.js 并总结', route })
  assert.equal(plain.questions.length, 3)
  assert.equal(plain.warnings.length, 0)

  const risky = preflight({ role, task: '把改动 git push 到远端并部署', route })
  assert.ok(risky.warnings.some((w) => w.includes('fail-closed')))

  const raised = preflight({ role, task: 'x', route: { ...route, overridden: true, tier: 'HIGH', roleTier: 'MEDIUM' } })
  assert.ok(raised.warnings.some((w) => w.includes('越档')))
})

// ── ④b 上下文隔离（评审/验证席） ──────────────────────────────────────────
test('隔离模式映射：blind=并行盲评席 / isolated=独立评审验证席 / 其余 shared', () => {
  const byMode = {}
  for (const role of ROLES) (byMode[isolationOf(role)] ??= []).push(role.id)
  assert.deepEqual(byMode.blind.sort(), ['code-reviewer', 'security-reviewer', 'silent-failure-hunter'], '并行盲评席三席（批次3 静默失败专项加入）')
  assert.deepEqual(byMode.isolated.sort(), ['code-simplifier', 'critic', 'verifier'], '独立评审/验证席三席')
  assert.equal((byMode.shared ?? []).length, 17, '其余 17 个角色不适用隔离（批次3 harness-optimizer/spec-miner 为 shared：演进评测需见配置全貌与基线、规格提取为产物型工作）')
  assert.equal(byMode.blind.length + byMode.isolated.length + byMode.shared.length, ROLES.length)
  assert.equal(isolationOf('code-reviewer'), 'blind', '接受 id 字符串')
  assert.equal(isolationOf('ghost'), 'shared', '未知 id 视作 shared（不抛错）')
  // 实现类角色不得被误标为隔离（否则组织者不敢给必要上下文）
  for (const id of ['executor', 'debugger', 'planner', 'analyst']) {
    assert.equal(isolationOf(getRole(id)), 'shared', `${id} 应为 shared`)
  }
})

test('任务书：盲评/独立席带「上下文隔离契约」，实现类角色不带', () => {
  const table = resolveTierTable(undefined)
  const build = (id, extra = {}) => {
    const role = getRole(id)
    return composeTaskbook({
      role, persona: loadPersona(role), route: resolveRoute({ role, tierTable: table }), task: '审查 lib/spawn.js 的改动', ...extra,
    })
  }
  const blind = build('code-reviewer')
  assert.ok(blind.includes('### 1.1 上下文隔离契约'), '盲评席必须带隔离契约小节')
  assert.ok(blind.includes('**blind（并行盲评席）**'))
  assert.ok(blind.includes('其他评审席的产出与结论'), 'blind 必须显式声明不给其他席位产出')
  assert.ok(blind.includes('全新会话'), '须声明会话层隔离')
  assert.ok(blind.includes('隔离污染'), '须给污染处置条款')
  assert.ok(blind.indexOf('### 1.1 上下文隔离契约') < blind.indexOf('## 二、职责与边界'), '隔离契约须在职责/材料之前')

  const isolated = build('verifier')
  assert.ok(isolated.includes('**isolated（独立评审/验证席）**'))
  assert.ok(!isolated.includes('其他评审席的产出与结论'), 'isolated 席不该被声明为「不给同席材料」')

  const shared = build('executor')
  assert.equal(shared.includes('上下文隔离契约'), false, '实现类角色不渲染隔离契约')
})

test('隔离泄漏机检：作者自评/其他席位结论命中告警，干净材料不误报', () => {
  const role = getRole('code-reviewer')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const clean = preflight({ role, task: '审查 src/a.js 的改动，按 P0/P1/P2 分级并给 文件:行号', route })
  assert.equal(clean.isolation.mode, 'blind')
  assert.deepEqual(clean.isolation.leaks, [])
  assert.ok(clean.warnings.some((w) => w.includes('材料机检未发现泄漏')), '干净时须有正向声明（可审计）')

  const author = preflight({ role, task: '这是我已经实现并验证过的改动，请复核', route })
  assert.ok(author.isolation.leaks.some((l) => l.kind === 'author-rationale'), '作者自评必须被检出')
  assert.ok(author.warnings.some((w) => w.includes('隔离泄漏（作者自评/理由）')))

  const peer = preflight({ role, task: '按另一席的评审结论补查遗漏', route })
  assert.ok(peer.isolation.leaks.some((l) => l.kind === 'peer-output'), '其他席位结论必须被检出')
  assert.ok(peer.warnings.some((w) => w.includes('盲评被锚定')))

  // 泄漏可以从任意将写进任务书的文本进入（context/statusQuo/deliverable/acceptance）
  const viaContext = preflight({ role, task: '审查改动', route, extraTexts: ['作者说明：这部分是我实现的核心逻辑'] })
  assert.ok(viaContext.isolation.leaks.length > 0, 'extraTexts 里也要能检出（正文之外的入口）')

  // isolated 席：作者自评算泄漏，他人的席位结论不算（critic 本就要汇总裁决）
  const critic = getRole('critic')
  const criticRoute = resolveRoute({ role: critic, tierTable: resolveTierTable(undefined) })
  const criticPeer = preflight({ role: critic, task: '汇总两份盲评报告并裁决', route: criticRoute, extraTexts: ['另一席的报告见 agent-out/code-reviewer.md'] })
  assert.equal(criticPeer.isolation.mode, 'isolated')
  assert.deepEqual(criticPeer.isolation.leaks, [], 'critic 拿到两份盲评报告是设计允许的')
  const criticAuthor = preflight({ role: critic, task: '评审这份改动', route: criticRoute, extraTexts: ['我的方案是先重构再补测试'] })
  assert.ok(criticAuthor.isolation.leaks.some((l) => l.kind === 'author-rationale'))

  // 实现类角色不做隔离机检（避免噪音）
  const exec = getRole('executor')
  const execRoute = resolveRoute({ role: exec, tierTable: resolveTierTable(undefined) })
  const execPre = preflight({ role: exec, task: '我已经实现了 X，继续补 Y', route: execRoute })
  assert.equal(execPre.isolation.mode, 'shared')
  assert.deepEqual(execPre.isolation.leaks, [])
})

// ── ⑤ 配置校验 ────────────────────────────────────────────────────────────
test('配置校验：非法值大声失败，合法值规范化', () => {
  const ok = resolveConfig({ clarifyMode: 'autonomous', defaultPreset: 'standard', agentOutSubdir: 'out' })
  assert.equal(ok.clarifyMode, 'autonomous')
  assert.equal(ok.defaultPreset, 'standard')
  assert.equal(ok.allowSpawn, true)
  assert.deepEqual(ok.tiers.HIGH, DEFAULT_TIERS.HIGH)
  assert.throws(() => resolveConfig({ clarifyMode: 'sometimes' }), /clarifyMode/)
  assert.throws(() => resolveConfig({ defaultPreset: 'Bad_Id' }), /defaultPreset/)
  assert.throws(() => resolveConfig({ agentOutSubdir: 'a/b' }), /agentOutSubdir/)
  assert.throws(() => resolveConfig({ roleOverrides: { ghost: { provider: 'a', model: 'b' } } }), /未知角色/)
  assert.equal(resolveConfig({ allowSpawn: false }).allowSpawn, false)
})

// ── ⑥ 人格加载 ────────────────────────────────────────────────────────────
test('人格未安装时退化为摘要模式且不报错', () => {
  const role = getRole('executor')
  const persona = loadPersona(role)
  assert.equal(typeof persona.text, 'string')
  assert.ok(persona.text.length > 0)
  if (!persona.installed) {
    assert.equal(persona.hash, null)
    assert.ok(persona.text.includes('人格文件未安装'))
  }
  assert.ok(Array.isArray(listPersonaFiles()))
})

test('时间戳格式（A4：秒精度，防同分钟默认路径撞车）', () => {
  assert.match(stamp(new Date(2026, 8, 12, 9, 5, 7)), /^20260912-090507$/)
})

test('splitFrontmatter 循环剥块：连续两段 frontmatter 全部剥除（A-P0-1 回归门）', () => {
  const raw = [
    '---', 'role: executor', 'name: Executor', 'tier: MEDIUM', '---', '',
    '---', 'name: executor', 'model: sonnet', 'level: 2', 'disallowedTools: Write, Edit', '---', '',
    '<Agent_Prompt>', '  正文开始', '</Agent_Prompt>', '',
  ].join('\n')
  const { meta, body } = splitFrontmatter(raw)
  assert.equal(body, '<Agent_Prompt>\n  正文开始\n</Agent_Prompt>')
  assert.ok(!body.includes('name:'), '正文不得残留任何 frontmatter 行（19 份双模型声明的根因）')
  assert.ok(!/\bmodel:/.test(body))
  assert.ok(!body.includes('disallowedTools'))
  assert.equal(meta.role, 'executor', '首块（安装器溯源字段）优先生效')
  assert.equal(meta.name, 'Executor', '首块值不被第二块覆盖')
  assert.equal(meta.tier, 'MEDIUM')
})

test('splitFrontmatter：单块剥除与无 frontmatter 原样返回', () => {
  const single = '---\nrole: x\n---\n\n正文A\n---\n正文B（正文内水平线保留）'
  const { body } = splitFrontmatter(single)
  assert.ok(body.startsWith('正文A'))
  assert.ok(body.includes('正文B'))
  const plain = '没有 frontmatter 的文本'
  assert.equal(splitFrontmatter(plain).body, plain)
})

test('dedupeEvidencePath：目标已存在则追加 -<HHmmss>，同路径两次生成不撞名（A4）', () => {
  const now = new Date(2026, 8, 13, 10, 20, 30)
  const existing = new Set([
    'D:\\w\\agent-out\\executor-20260913-1020.md',
    'D:\\w\\agent-out\\no-ext',
  ])
  const exists = (p) => existing.has(p)
  const first = dedupeEvidencePath('D:\\w\\agent-out\\executor-20260913-1020.md', exists, now)
  assert.equal(first, 'D:\\w\\agent-out\\executor-20260913-1020-102030.md', '追加 -<HHmmss> 后缀且保留扩展名')
  existing.add(first)
  const second = dedupeEvidencePath(first, exists, new Date(2026, 8, 13, 10, 20, 31))
  assert.notEqual(second, first, '同一路径两次生成不得撞名')
  assert.match(second, /-102031\.md$/)
  assert.equal(dedupeEvidencePath('D:\\w\\agent-out\\fresh.md', exists, now), 'D:\\w\\agent-out\\fresh.md', '不存在时不加后缀')
  assert.equal(dedupeEvidencePath('D:\\w\\agent-out\\no-ext', exists, now), 'D:\\w\\agent-out\\no-ext-102030', '无扩展名路径直接追加')
  assert.equal(dedupeEvidencePath('', exists, now), '')
})

// ── ⑦ 工具契约 + 完整派活链路（假宿主） ───────────────────────────────────
await testAsync('apply 注册三个工具且满足 DSH 定义契约', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), ['agent_roles', 'agent_spawn', 'agent_taskbook'])
  for (const [name, def] of tools) {
    assert.equal(typeof def.description, 'string', `${name} 缺 description`)
    assert.equal(def.parameters.type, 'object', `${name} parameters 必须是单一 type=object`)
    assert.ok(Array.isArray(def.parameters.required) && def.parameters.required.length > 0, `${name} 缺顶层 required`)
    assert.ok(def.parameters.properties && typeof def.parameters.properties === 'object', `${name} 缺 properties`)
    assert.equal(typeof def.output?.schema, 'object', `${name} 缺 output.schema`)
    assert.equal(typeof def.output?.render, 'function', `${name} 缺 output.render`)
    assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
    const rendered = def.output.render({}, { ok: true, now: Date.now() })
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text' && typeof rendered[0].text === 'string', `${name} render 必须返回文本块数组`)
  }
})

await testAsync('agent_roles：list / show / tiers 三个动作', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, {})
  const list = await tools.get('agent_roles').execute({ action: 'list', lane: 'review' })
  assert.equal(list.ok, true)
  assert.equal(list.roles.length, 6)
  assert.equal(typeof list.now, 'number')

  const show = await tools.get('agent_roles').execute({ action: 'show', role: 'critic' })
  assert.equal(show.role.tier, 'HIGH')
  assert.ok(show.role.personaInstalled === true || show.role.personaInstalled === false)

  const bad = await tools.get('agent_roles').execute({ action: 'show', role: 'nope' })
  assert.equal(bad.ok, false)
  assert.ok(bad.message.includes('未知角色'))

  const tiers = await tools.get('agent_roles').execute({ action: 'tiers' })
  assert.deepEqual(tiers.tiers.HIGH, DEFAULT_TIERS.HIGH)
  assert.equal((await tools.get('agent_roles').execute({ action: 'xyz' })).ok, false)
})

await testAsync('agent_taskbook：出全文与三问，未知角色/空任务被拒', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, {})
  const tool = tools.get('agent_taskbook')
  const good = await tool.execute({ role: 'verifier', task: '核对 lib/spawn.js 的完成声明', tier: 'HIGH', tierReason: 'x' })
  assert.equal(good.ok, true)
  assert.equal(good.tier, 'HIGH')
  assert.ok(good.taskbook.includes('Verifier'))
  assert.equal(good.preflight.length, 3)
  assert.ok(good.evidencePath === null || typeof good.evidencePath === 'string')

  assert.equal((await tool.execute({ role: 'ghost', task: 'x' })).ok, false)
  assert.equal((await tool.execute({ role: 'verifier', task: '   ' })).ok, false)
  assert.equal((await tool.execute({ role: 'verifier', task: 'x', clarifyMode: 'nope' })).ok, false)
})

await testAsync('agent_spawn：dryRun 不创建；正式派活走 create+followup 并回显档位', async () => {
  const { ctx, tools, created } = fakeCtx({ workspaceRegistry: undefined })
  apply(ctx, {})
  const tool = tools.get('agent_spawn')

  const dry = await tool.execute({ role: 'explore', task: '找 X', dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(created.length, 0, 'dryRun 不得创建会话')
  assert.equal(dry.tier, 'LOW')
  assert.equal(dry.provider, DEFAULT_TIERS.LOW.provider)

  const requester = {
    options: { provider: 'glm-pro', model: 'glm-5.3-flash' },
    session: { header: { cwd: 'D:\\work\\demo' }, requestHeader: () => ({ config: { provider: 'glm-pro', model: 'glm-5.3-flash' } }) },
  }
  const real = await tool.execute({ role: 'executor', task: '实现 X' }, { agent: requester })
  assert.equal(real.ok, true)
  assert.match(real.sessionId, /^session-[0-9a-f-]{36}$/)
  assert.equal(real.tier, 'MEDIUM')
  assert.equal(real.provider, DEFAULT_TIERS.MEDIUM.provider)
  assert.equal(real.model, DEFAULT_TIERS.MEDIUM.model)
  assert.ok(real.evidencePath.includes('agent-out'), '默认产出路径应落在 agent-out 下')

  const createCall = created[0]
  assert.equal(createCall.sessionId, real.sessionId)
  assert.deepEqual(createCall.agentOptions, { provider: DEFAULT_TIERS.MEDIUM.provider, model: DEFAULT_TIERS.MEDIUM.model })
  assert.equal(createCall.meta.cwd, 'D:\\work\\demo')
  // ⚠️ 2026-09-29 根因修复：不得再用 seed 注入 request/header（该事件落在 seq 0，
  // 即任何 turn 之外；v4 要求 request/header 处于已打开的 turn 内
  // ——dsh-session-format-v3-to-v4 lib/index.js:571/:990，否则会话日志重载时报
  // 「request/header is outside an open turn」，即「历史加载失败」）。
  // 运行配置一律走 agentOptions（思考等级 = AgentOptions.reasoningEffort）。
  assert.equal(createCall.seed, undefined, '不得再传 seed（v4：request/header 必须在打开的 turn 内）')
  const followup = created.find((entry) => entry.followup)
  assert.ok(followup, '必须 followup 派发任务书')
  assert.ok(followup.followup.content[0].text.includes('角色任务书'), '首条消息应是角色任务书')
  assert.equal(followup.followup.source.kind, 'user')
})

await testAsync('agent_spawn：越档记理由、allowSpawn=false 拦停、预设校验', async () => {
  const { ctx, tools, created } = fakeCtx()
  apply(ctx, { allowSpawn: false })
  const denied = await tools.get('agent_spawn').execute({ role: 'executor', task: 'x' })
  assert.equal(denied.ok, false)
  assert.ok(denied.message.includes('allowSpawn'))

  const { ctx: ctx2, tools: tools2, created: created2 } = fakeCtx()
  apply(ctx2, {})
  const spawned = await tools2.get('agent_spawn').execute({ role: 'executor', task: 'x', tier: 'HIGH', tierReason: '跨模块重构' })
  assert.equal(spawned.ok, true)
  assert.ok(spawned.warnings.some((w) => w.includes('越档') && w.includes('跨模块重构')))
  assert.equal(created2.length >= 2, true)

  const badPreset = await tools2.get('agent_spawn').execute({ role: 'executor', task: 'x', agentPreset: 'Not_A_Preset' })
  assert.equal(badPreset.ok, false)
  assert.ok(badPreset.message.includes('格式不合法'))
})

await testAsync('内置预设 root 反推：从进程入口向上找到 config/agent-presets', async () => {
  // npm 全局安装时内置预设不在 <dsh home>/source/... 下，只能从 dsh 入口反推；
  // 用假 fixture 复现该布局，避免测试依赖本机安装位置。
  const fixture = fileURLToPath(new URL('./.fixture/', import.meta.url))
  mkdirSync(join(fixture, 'bin'), { recursive: true })
  mkdirSync(join(fixture, 'config', 'agent-presets', 'standard'), { recursive: true })
  const saved = process.argv[1]
  process.argv[1] = join(fixture, 'bin', 'dsh.js')
  try {
    assert.ok(listPresets().includes('standard'), '应能从进程入口反推内置预设 root')
  } finally {
    process.argv[1] = saved
    rmSync(fixture, { recursive: true, force: true })
  }
})

// ── B1 S1：per-session 工具面策略文件（toolscope，R3-B1 子特性② 数据层） ──
/** toolscope 用例的隔离数据目录（.fixture 系 gitignored；用完即清）。 */
function toolscopeFixtureDir() {
  return fileURLToPath(new URL('./.fixture-toolscope/', import.meta.url))
}

await testAsync('toolscope：roundtrip 写→读字段一致（allow ≥3 元素）+ 同目录三后缀文件名不碰撞', async () => {
  const dir = toolscopeFixtureDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    const sid = 'session-abc123'
    const written = store.writeMinimal(sid, { orgId: 'session-org-1' })
    assert.equal(written.schemaVersion, TOOLSCOPE_SCHEMA_VERSION)
    assert.equal(written.personaMode, 'minimal')
    assert.deepEqual(written.toolPolicy, { tier: 'full', allow: [...MINIMAL_TOOLSET_FULL], deny: [] })
    assert.ok(written.toolPolicy.allow.length >= 3, 'allow 清单 ≥3 元素（断言鉴别力纪律）')
    assert.equal(written.replyChannel, 'org')
    assert.equal(written.orgId, 'session-org-1')

    const back = store.read(sid)
    assert.ok(back !== null, '写后读必须命中')
    assert.deepEqual(
      { schemaVersion: back.schemaVersion, sessionId: back.sessionId, personaMode: back.personaMode, toolPolicy: back.toolPolicy, replyChannel: back.replyChannel, orgId: back.orgId },
      { schemaVersion: written.schemaVersion, sessionId: written.sessionId, personaMode: written.personaMode, toolPolicy: written.toolPolicy, replyChannel: written.replyChannel, orgId: written.orgId },
      'roundtrip 字段一致（写→读）',
    )

    // 文件名判据（承 advisor store.js:58-61）：base64url 字母表不含 `.`，
    // 同 sessionId 的 advisor 配置 / seen / toolscope 三后缀互不碰撞。
    const b64 = Buffer.from(sid, 'utf8').toString('base64url')
    assert.equal(toolscopePath(dir, sid), join(dir, 'sessions', `${b64}.toolscope.json`))
    assert.equal(new Set([`${b64}.json`, `${b64}.seen.json`, `${b64}.toolscope.json`]).size, 3, '三后缀互不碰撞')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('toolscope：非法档名/非法 allow/空 orgId 抛同步异常且零写盘；merge 保留既有 orgId；损坏文件 fail-open', async () => {
  const dir = toolscopeFixtureDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    const sid = 'session-neg'
    // 三类非法输入（≥3 元素负例夹具，逐类命中一条校验）：
    assert.throws(() => normalizeToolscope({ sessionId: sid, personaMode: 'minimal', toolPolicy: { tier: 'all', allow: ['read'], deny: [] } }), /tier/)
    assert.throws(() => normalizeToolscope({ sessionId: sid, personaMode: 'minimal', toolPolicy: { tier: 'full', allow: 'read', deny: [] } }), /allow/)
    assert.throws(() => normalizeToolscope({ sessionId: sid, personaMode: 'minimal', toolPolicy: { tier: 'full', allow: ['read'], deny: [] }, orgId: '   ' }), /orgId/)
    assert.equal(store.read(sid), null, '校验失败零写盘（fail-closed）')

    store.writeMinimal(sid, { orgId: 'session-org-keep' })
    const second = store.write(sid, { sessionId: sid, personaMode: 'minimal', toolPolicy: { tier: 'full', allow: ['read'], deny: [] }, replyChannel: 'org' })
    assert.equal(second.orgId, 'session-org-keep', '二次写不带 orgId 时 merge 保留既有值（read→merge 语义）')

    writeFileSync(store.path(sid), '{broken json', 'utf8')
    assert.equal(store.read(sid), null, '损坏文件 fail-open：返回 null 不抛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('toolscope：底层写盘失败原样抛出（G8 fail-fast 的前提语义，fs 门面注入写失败探针）', async () => {
  const dir = toolscopeFixtureDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({
      dataDir: dir,
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        writeFileSync: () => { throw new Error('EPERM: 磁盘拒绝写入') },
        renameSync: () => { throw new Error('rename 不应被走到') },
        readFileSync: () => { throw new Error('read 不应被走到') },
      },
    })
    assert.throws(() => store.writeMinimal('session-x', { orgId: 'session-org-2' }), /磁盘拒绝/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── B1 S1：agent_spawn personaMode（minimal 轨）与 AC1-1 / AC1-2 / G8 ─────
// 环境确定性配方：① 预设 fixture——把 process.argv[1] 指到假入口，借 spawn.js 的
// 内置 root 反推找到 <fixture>/config/agent-presets/minimal（'minimal' 预设存在，
// 不依赖本机安装布局）；② 数据目录 env 隔离——DSH_AGENTS_ADVISOR_DATA_DIR 指向
// fixture 内目录，toolscope 落盘绝不触碰真实 ~/.dsh（承 advisor 测试同款纪律）。
const ADVISOR_DATA_DIR_ENV = 'DSH_AGENTS_ADVISOR_DATA_DIR'
const BUILTIN_SECTION_SEVEN = [
  '## 一、角色卡', '## 二、职责与边界', '## 三、人格细则', '## 四、本次任务',
  '## 五、交付与验收', '## 六、澄清模式', '## 七、汇报与回收核对',
]
function minimalEnvSetup() {
  const dir = fileURLToPath(new URL('./.fixture-minimal/', import.meta.url))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'config', 'agent-presets', 'minimal'), { recursive: true })
  const handle = {
    dir,
    prevArgv1: process.argv[1],
    prevDataDir: process.env[ADVISOR_DATA_DIR_ENV],
  }
  process.argv[1] = join(dir, 'bin', 'dsh.js')
  process.env[ADVISOR_DATA_DIR_ENV] = join(dir, 'data')
  return handle
}
function minimalEnvTeardown(handle) {
  process.argv[1] = handle.prevArgv1
  if (handle.prevDataDir === undefined) delete process.env[ADVISOR_DATA_DIR_ENV]
  else process.env[ADVISOR_DATA_DIR_ENV] = handle.prevDataDir
  rmSync(handle.dir, { recursive: true, force: true })
}
/** minimal 用例的发起会话假体（cwd 已知，requestHeader 供思考等级继承判定）。 */
function minimalRequester() {
  return {
    options: { provider: 'p0', model: 'm0' },
    session: { header: { cwd: 'D:\\work\\eval' }, requestHeader: () => ({ config: { provider: 'p0', model: 'm0' } }) },
  }
}
/** minimal 轨落盘的 sessions 目录（与 apply 内 store 同一 dataDir 解析链）。 */
function minimalSessionsDir(handle) {
  return join(handle.dir, 'data', 'sessions')
}

await testAsync('B1 AC1-1：minimal 产四行 brief（无角色人格/无七节）+ 策略文件同事务先落盘（create 入口已可见）+ 缺 model 拒绝（M9 负例）+ G10 披露', async () => {
  const env = minimalEnvSetup()
  try {
    const { ctx, tools, created } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx, {})
    const tool = tools.get('agent_spawn')
    // 同事务判据探针：包一层 agents.create，在 create 入口检查策略文件是否已落盘
    //（beforeCreate 全同步先于 create ⇒ create 被调时文件必须已存在）。
    let createSawPolicyFile = null
    const origCreate = ctx.agents.create
    ctx.agents.create = async (options) => {
      const sessionsDir = minimalSessionsDir(env)
      createSawPolicyFile = existsSync(sessionsDir)
        && readdirSync(sessionsDir).some((f) => f.endsWith('.toolscope.json'))
      return origCreate(options)
    }

    const r = await tool.execute({
      task: '写一个 fizzbuzz 函数并通过测试',
      personaMode: 'minimal',
      provider: 'prov-x', model: 'model-x',
      organizer: 'session-org-9',
      acceptance: '测试全绿',
      cwd: 'D:\\work\\eval',
    }, { agent: minimalRequester() })
    assert.equal(r.ok, true, r.message)
    assert.equal(r.personaMode, 'minimal')
    assert.match(r.sessionId, /^session-[0-9a-f-]{36}$/)
    assert.equal(r.agentPreset, 'minimal', '缺省 minimalPreset=宿主内置 minimal（V2-1）')
    assert.equal(r.provider, 'prov-x')
    assert.equal(r.model, 'model-x')
    // G10：返回体披露已应用策略
    assert.equal(r.toolscope?.orgId, 'session-org-9')
    assert.equal(r.toolscope?.toolPolicy?.tier, 'full')
    assert.ok(r.toolscope?.toolPolicy?.allow?.length >= 3, 'allow 整集 ≥3 元素')
    assert.equal(r.toolscope?.replyChannel, 'org')
    assert.ok(typeof r.toolscope?.path === 'string' && r.toolscope.path.endsWith('.toolscope.json'))

    // 四行 brief 断言（正例）
    const followup = created.find((e) => e.followup)
    assert.ok(followup, '必须 followup 派发 brief')
    const briefText = followup.followup.content[0].text
    assert.equal(briefText.split('\n').length, 4, `brief 恰四行，实得 ${briefText.split('\n').length} 行`)
    assert.ok(briefText.startsWith('任务：写一个 fizzbuzz 函数并通过测试'), briefText)
    assert.ok(briefText.includes('产出落盘：'))
    assert.ok(briefText.includes('orgId：session-org-9'), 'orgId 单一事实源=派活参数 organizer（V2-6）')
    assert.ok(briefText.includes('完成标准：测试全绿'))
    // AC1-1 反向断言：不含角色人格与七节任务书
    for (const banned of [...BUILTIN_SECTION_SEVEN, 'Agent_Prompt', '角色任务书']) {
      assert.ok(!briefText.includes(banned), `minimal brief 不得含「${banned}」`)
    }
    // 同事务（裁 4/V3-7）：create 入口时策略文件已在盘上
    assert.equal(createSawPolicyFile, true, 'agents.create 入口必须已见策略文件（先落盘后 create）')
    // G10 与磁盘一致：返回体 path 即真实落点且可读回
    const onDisk = new ToolscopeStore({ dataDir: join(env.dir, 'data') }).read(r.sessionId)
    assert.equal(onDisk?.orgId, 'session-org-9', '磁盘文件与 G10 披露一致')

    // M9 负例：缺 model 拒绝，不建会话不落盘
    const createdBefore = created.length
    const sessionsBefore = existsSync(minimalSessionsDir(env)) ? readdirSync(minimalSessionsDir(env)).length : 0
    const noModel = await tool.execute({ task: 'x', personaMode: 'minimal', provider: 'prov-x', organizer: 'session-org-9' }, { agent: minimalRequester() })
    assert.equal(noModel.ok, false)
    assert.ok(noModel.message.includes('provider+model'), noModel.message)
    assert.equal(created.length, createdBefore, 'M9 负例不得创建会话')
    assert.equal(existsSync(minimalSessionsDir(env)) ? readdirSync(minimalSessionsDir(env)).length : 0, sessionsBefore, 'M9 负例零落盘')
  } finally {
    minimalEnvTeardown(env)
  }
})

await testAsync('B1 AC1-1 回归：缺省 role 路径七节逐节渲染 + 落 role 轨策略标记（S3 起语义更新，原断言「不落策略文件」过时）', async () => {
  const env = minimalEnvSetup()
  try {
    const { ctx, tools, created } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx, {})
    const r = await tools.get('agent_spawn').execute({ role: 'executor', task: '实现 X' }, { agent: minimalRequester() })
    assert.equal(r.ok, true, r.message)
    assert.equal(r.personaMode, 'role')
    const followup = created.find((e) => e.followup)
    const text = followup.followup.content[0].text
    for (const section of BUILTIN_SECTION_SEVEN) {
      assert.ok(text.includes(section), `role 路径七节回归：缺「${section}」`)
    }
    // 【断言改写留痕 2026-10-26】原断言（S1）：「role 路径不落策略文件（S1 只有
    // minimal 轨写）」——S1 阶段事实，已被 S3 需求取代：role 默认收缩需要 per-session
    // 激活记录（role id 是 roster 键、task/taskbook 是交叉校验硬闸的时序安全输入，
    // created 时 prompt 尚未入会话），故 role 轨 spawn 落 tier='grant' 标记文件。
    // 原判据的语义核心（role 路径渲染行为不变）保留在上方七节逐节断言；本断言
    // 反转为「标记文件在盘上且字段正确」。依据：opt-b1-design.md §2.2/裁 3 +
    // 任务书产出清单 ①（agent/created 内按会话策略应用 restrict 的前置数据）。
    assert.equal(existsSync(minimalSessionsDir(env)), true, 'role 轨落策略标记文件（S3 role 默认收缩激活记录）')
    const marker = new ToolscopeStore({ dataDir: join(env.dir, 'data') }).read(r.sessionId)
    assert.equal(marker?.personaMode, 'role')
    assert.equal(marker?.role, 'executor')
    assert.equal(marker?.toolPolicy?.tier, 'grant')
    assert.ok(marker?.taskbook?.includes('# 角色任务书'), 'taskbook 全文随标记落盘')
    assert.equal(marker?.task, '实现 X')
    // G10 同款披露：返回体 toolscope 字段与磁盘一致
    assert.equal(r.toolscope?.role, 'executor')
    assert.ok(r.toolscope?.path?.endsWith('.toolscope.json'))
  } finally {
    minimalEnvTeardown(env)
  }
})

await testAsync('B1 AC1-2：minimalPreset 路由（配置生效/显式优先/缺省 minimal/格式错 apply 响亮失败/不存在列清单复用宿主校验）', async () => {
  const env = minimalEnvSetup()
  mkdirSync(join(env.dir, 'config', 'agent-presets', 'eval-min'), { recursive: true })
  try {
    assert.equal(resolveConfig({}).minimalPreset, 'minimal', 'resolveConfig 缺省 minimal（V2-1）')
    assert.throws(() => resolveConfig({ minimalPreset: 'Bad_Preset' }), /minimalPreset 格式不合法/, '格式错大声失败')
    const { ctx } = fakeCtx()
    assert.throws(() => apply(ctx, { minimalPreset: 'Bad_Preset' }), /格式不合法/, 'apply 入口同样响亮（配置错不静默）')

    const { ctx: ctx1, tools: tools1 } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx1, { minimalPreset: 'eval-min' })
    const r1 = await tools1.get('agent_spawn').execute({ task: 'x', personaMode: 'minimal', provider: 'p', model: 'm', cwd: 'D:\\work\\eval' }, { agent: minimalRequester() })
    assert.equal(r1.ok, true, r1.message)
    assert.equal(r1.agentPreset, 'eval-min', '配置 minimalPreset 生效')

    const { ctx: ctx2, tools: tools2 } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx2, { minimalPreset: 'eval-min' })
    const r2 = await tools2.get('agent_spawn').execute({ task: 'x', personaMode: 'minimal', provider: 'p', model: 'm', agentPreset: 'minimal', cwd: 'D:\\work\\eval' }, { agent: minimalRequester() })
    assert.equal(r2.ok, true, r2.message)
    assert.equal(r2.agentPreset, 'minimal', '显式 agentPreset 优先于配置')

    // 不存在的预设 id → 复用宿主 spawn 链校验：报错并列可用清单（不自制白名单）
    const { ctx: ctx3, tools: tools3 } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx3, { minimalPreset: 'ghost-preset' })
    const r3 = await tools3.get('agent_spawn').execute({ task: 'x', personaMode: 'minimal', provider: 'p', model: 'm' }, { agent: minimalRequester() })
    assert.equal(r3.ok, false)
    assert.ok(r3.message.includes('不存在') && r3.message.includes('可用预设'), r3.message)
  } finally {
    minimalEnvTeardown(env)
  }
})

await testAsync('B1 G8：策略文件写失败 fail-fast——不创建会话、不派 brief（dataDir 指向文件的确定性失败注入）', async () => {
  const env = minimalEnvSetup()
  try {
    // dataDir 指向一个已存在的**文件**：<file>/sessions 的 mkdirSync 必然失败 → 写失败
    const blockerFile = join(env.dir, 'blocker')
    writeFileSync(blockerFile, 'not a directory', 'utf8')
    process.env[ADVISOR_DATA_DIR_ENV] = blockerFile
    const { ctx, tools, created } = fakeCtx({ workspaceRegistry: undefined })
    apply(ctx, {})
    const r = await tools.get('agent_spawn').execute({ task: 'x', personaMode: 'minimal', provider: 'p', model: 'm', organizer: 'session-org-8' }, { agent: minimalRequester() })
    assert.equal(r.ok, false, 'G8：写失败必须 fail-fast')
    assert.ok(r.message.includes('fail-fast'), r.message)
    assert.equal(created.length, 0, '未创建会话（不产出非法态）')
    assert.equal(created.some((e) => e.followup), false, '未派发 brief')
  } finally {
    minimalEnvTeardown(env)
  }
})

// ── B1 S3：restrict 管道（toolscope-pipeline / roster 数据 / AC2-1..11）────
// 假宿主纪律：工具面用**忠实复刻宿主语义**的最小 fake（dsh-tools 活体确认的三条：
// unknown 名整段抛错 / restrict 返回 disposer / 多次 restrict 交集叠加）——fake 的
// 抛错行为与宿主 :2906-2908 区逐字对齐，保证「去预检变异必红」对照有效。

/** S3 测试隔离数据目录（.fixture 系 gitignored；用完即清）。 */
function toolscopeS3Dir() {
  return fileURLToPath(new URL('./.fixture-toolscope-s3/', import.meta.url))
}

/** 宿主 restrict 语义最小复刻：unknown 抛错 + disposer + 交集叠加 + own 层豁免。 */
function fakeToolsService(names, own = []) {
  const universe = new Set(names)
  const restrictions = []
  const calls = []
  const disposed = []
  const admits = (name) => restrictions.every((r) => (r.allow === undefined || r.allow.has(name)) && (r.deny === undefined || !r.deny.has(name)))
  const api = {
    calls,
    disposed,
    activeCount: () => restrictions.length,
    visibleOf: () => new Set([...universe].filter(admits)),
    view() {
      const visible = new Set([...universe].filter(admits))
      for (const o of own) visible.add(o) // own 层豁免：恒可见且不入 restrictable（P4）
      return { visible, knownNames: new Set([...universe, ...own]), restrictableNames: new Set(universe) }
    },
  }
  const scoped = {
    tools: {
      view: () => api.view(),
      restrict(filter) {
        calls.push(filter)
        const allow = filter.allow
        const deny = filter.deny
        if (allow === undefined && deny === undefined) throw new Error('tools.restrict({}) is a no-op')
        const unknown = [...allow ?? [], ...deny ?? []].filter((n) => !universe.has(n))
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}`)
        }
        const entry = {
          ...(allow !== undefined ? { allow: new Set(allow) } : {}),
          ...(deny !== undefined ? { deny: new Set(deny) } : {}),
        }
        restrictions.push(entry)
        let done = false
        return () => {
          if (done) return
          done = true
          const i = restrictions.indexOf(entry)
          if (i >= 0) restrictions.splice(i, 1)
          disposed.push(entry)
        }
      },
    },
  }
  return { api, scoped }
}

/** 假 agent（pipeline 只用 id 与 ctx.tools 两个面）。 */
function fakeAgent(id, scoped) {
  return { id, ctx: scoped }
}

/** 事件捕获假 ctx（install 接线测试用）。 */
function fakeEventCtx() {
  const handlers = new Map()
  const registered = []
  const ctx = {
    on(event, fn, opts) {
      handlers.set(event, fn)
      registered.push({ event, opts })
      return () => handlers.delete(event)
    },
  }
  return { ctx, handlers, registered }
}

/** S3 决策测试共用 roster fixture（手造小表；真实数据测试单独走 POLICY_DIR）。 */
function s3RosterFixture() {
  return {
    version: 1,
    coreBase: ['read', 'de_broadcast'],
    scanIgnore: ['de_session'],
    classMap: { 'read-class': ['read', 'glob', 'grep'], 'write-class': ['write', 'edit'], 'exec-class': ['pwsh'] },
    familyKeywords: { 'write-class': ['编辑工具'], 'read-class': ['检索'] },
    roles: {},
  }
}

/** S3 测试宇宙（13 真实名 + own 层 agent_reply，AC2-4/7 同款参考基面）。 */
const S3_UNIVERSE = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'read_image', 'de_broadcast', 'de_session', 'agent_spawn', 'todo_write', 'memory', 'web_search']

await testAsync('S3 mcpPublicName：P1 活体四分支逐字对上（干净直通/大小写保留/有损 hash/超长 hash）', async () => {
  assert.equal(mcpPublicName('probetest', 'clean_tool'), 'mcp__probetest__clean_tool', '干净名直通')
  assert.equal(mcpPublicName('probetest', 'MiXeD-Case_123'), 'mcp__probetest__MiXeD-Case_123', '大小写保留')
  assert.equal(mcpPublicName('probetest', 'has space!'), 'mcp__probetest__has_space__c8b9b295711c', '有损名=normalized+sha256 前 12hex（P1 活体读数）')
  assert.equal(
    mcpPublicName('probetest', 'x'.repeat(80)),
    `mcp__probetest__${'x'.repeat(35)}_0d0a200d2615`,
    '超长名=截 51+hash（P1 活体读数 0d0a200d2615）',
  )
})

await testAsync('S3 looseToolRefs：子串全量+词边界防误报+否定语境豁免（6 候选名夹具）+豁免关闭对照', async () => {
  const names = ['read', 'write', 'edit', 'de_session', 'agent_spawn', 'grep']
  const text = [
    '- 允许：用 grep 检索文本模式',
    '- 禁止：`write` / `edit` 等一切写盘动作',
    '- 组织者以 `de_session status/list` 核对产出',
    '- 协议名 subagent-clarify 不得误报为 subagent',
    '- 用 read 读文件',
  ].join('\n')
  const hits = looseToolRefs(text, names)
  assert.deepEqual(hits, ['de_session', 'grep', 'read'], '否定行豁免+连字词防误报（subagent-clarify 不命中）')
  const unfiltered = looseToolRefs(text, names, { skipNegatedLines: false })
  assert.deepEqual(unfiltered, ['de_session', 'edit', 'grep', 'read', 'write'], '关闭豁免对照：write/edit 回到命中集（豁免生效的差分证据）')
})

await testAsync('S3 conservativeTaskRefs：反引号显式+族关键词展开；裸名词不猜；scanIgnore 生效', async () => {
  const base = s3RosterFixture()
  // 本用例局部扩 universe：de_session 进 classMap 才能检验 scanIgnore（否则「不在宇宙」与「被忽略」不可区分）
  base.classMap['dispatch-class'] = ['de_session', 'agent_spawn']
  const text = '用 `web_search` 查资料；需要编辑工具改文件；裸名词 write 不应被猜记；`de_session` 按名单忽略'
  const refs = conservativeTaskRefs(text, base, ['web_search'])
  assert.deepEqual(refs, ['web_search', 'write', 'edit'].sort(), '反引号显式（web_search）+ 关键词展开（write/edit）')
  assert.equal(conservativeTaskRefs('需要 write 但没反引号', base).includes('write'), false, '裸名词不猜')
  assert.equal(conservativeTaskRefs('`de_session` 引用', base).includes('de_session'), false, 'scanIgnore 名单生效（在宇宙且被忽略）')
  assert.equal(conservativeTaskRefs('`agent_spawn` 显式需要', base).includes('agent_spawn'), true, '名单外显式引用正常收录（对照）')
})

await testAsync('S3 AC2-3 unknown 防御三件套：结构化缺失清单+restrict 未调用+会话存活（allow 5 元素含 2 unknown）+去预检变异必红对照', async () => {
  const dir = toolscopeS3Dir()
  const store = new ToolscopeStore({ dataDir: dir })
  const sid = 'session-s3-ac3'
  store.writeMinimal(sid, { orgId: null, allow: ['read', 'write', 'ghost-tool-a', 'ghost-tool-b', 'pwsh'] })
  const svc = fakeToolsService(S3_UNIVERSE, ['agent_reply'])
  const emits = []
  const pipeline = installToolscopePipeline({
    ctx: fakeEventCtx().ctx, store, roster: s3RosterFixture(),
    logger: { warn: () => {}, error: () => {} },
  })
  pipeline.notifier.emitFn = (p) => emits.push(p)
  try {
    const agent = fakeAgent(sid, svc.scoped)
    pipeline.onCreated(agent)
    assert.equal(svc.api.calls.length, 0, 'AC2-3 三件套之二：restrict 未被调用')
    const wire = [...svc.scoped.tools.view().visible].sort()
    assert.equal(wire.length, S3_UNIVERSE.length + 1, 'AC2-3 之三：会话创建存活（wire 全工具面含 own 层）')
    assert.equal(emits.length, 1, 'G9：拒绝通知恰好一条')
    assert.deepEqual(emits[0].missing, ['ghost-tool-a', 'ghost-tool-b'], 'AC2-3 之一：结构化缺失清单（排序去重）')
    assert.equal(emits[0].reason, 'unknown-names')
    // 去预检变异必红对照：同一 allow 直接打宿主形态 restrict 必抛（预检的价值所在）
    assert.throws(() => svc.scoped.tools.restrict({ allow: ['read', 'write', 'ghost-tool-a', 'ghost-tool-b', 'pwsh'] }), /unknown global tools/, '宿主对 unknown 名整段抛错（去预检即红）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-2a 同代两次策略=最后一次（lift-before-set）+交集变异对照必红', async () => {
  const dir = toolscopeS3Dir()
  const store = new ToolscopeStore({ dataDir: dir })
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob']
  const sid = 'session-s3-ac2a'
  store.writeRole(sid, { role: 'scan-role', task: '整理发现', taskbook: 'x' })
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  try {
    const agent = fakeAgent(sid, svc.scoped)
    pipeline.onCreated(agent)
    const afterFirst = [...svc.api.visibleOf()].sort()
    assert.ok(!afterFirst.includes('write') && afterFirst.includes('glob'), '第一次收缩生效')
    pipeline.onCreated(agent) // 同会话重放（resume 语义）：lift 旧设新
    assert.equal(svc.api.activeCount(), 1, 'lift-before-set：至多一个我方 restrict 生效（不叠加）')
    assert.equal(svc.api.disposed.length, 1, '旧 disposer 恰被提起一次')
    assert.deepEqual([...svc.api.visibleOf()].sort(), afterFirst, '同策略重放结果幂等（G13 不变量 9）')
    // 变异对照（必红证明）：不去旧直接设新 = 宿主交集语义 ⇒ 可见面越收越窄
    const r1 = svc.scoped.tools.restrict({ deny: ['write'] })
    const r2 = svc.scoped.tools.restrict({ deny: ['glob'] })
    const stacked = [...svc.api.visibleOf()].sort()
    assert.ok(!stacked.includes('write') && !stacked.includes('glob'), '交集对照：without lift 双 deny 都生效（证明上面断言能抓「越收越窄」）')
    r1()
    r2()
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-2b 跨代 sharedLift：旧代设下的 restrict 可被新代 lift，可见面恢复且无交集叠加', async () => {
  const dir = toolscopeS3Dir()
  const store = new ToolscopeStore({ dataDir: dir })
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob', 'grep']
  const sid = 'session-s3-ac2b'
  store.writeRole(sid, { role: 'scan-role', task: '检索并汇报', taskbook: 'x' })
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline1 = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  const pipeline2 = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  try {
    const agent = fakeAgent(sid, svc.scoped)
    pipeline1.onCreated(agent)
    assert.equal(sharedLiftTable().get(sid)?.gen, pipeline1.gen, 'gen1 表项在共享表（globalThis Symbol.for 跨代共享）')
    assert.ok(!svc.scoped.tools.view().visible.has('write'), 'gen1 策略下 write 被收')
    // 模拟换代时策略内容变化（preset 热修/表更新）：新代按新表放行 write/edit
    roster.roles['scan-role'] = ['glob', 'grep', 'write', 'edit']
    pipeline2.onCreated(agent) // 新代接管：必须提起旧代 restrict 再设新（防交集锁死）
    assert.equal(svc.api.activeCount(), 1, '跨代无交集叠加（旧代已 lift）')
    assert.equal(svc.api.disposed.length, 1, '旧代 disposer 被新代提起')
    assert.equal(sharedLiftTable().get(sid)?.gen, pipeline2.gen, '表项换代')
    const visible = [...svc.scoped.tools.view().visible].sort()
    assert.ok(visible.includes('write') && visible.includes('edit'), 'write/edit 恢复可见（按新代策略，不被旧代交集锁死）')
  } finally {
    pipeline1.dispose()
    pipeline2.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-5 dispose 清理：agent/disposed 后 disposer 已调+共享表无残留+二次 disposed 幂等', async () => {
  const dir = toolscopeS3Dir()
  const store = new ToolscopeStore({ dataDir: dir })
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob']
  const sid = 'session-s3-ac5'
  store.writeRole(sid, { role: 'scan-role', task: 'x', taskbook: 'x' })
  const svc = fakeToolsService(S3_UNIVERSE)
  const { ctx, handlers, registered } = fakeEventCtx()
  const pipeline = installToolscopePipeline({ ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  try {
    assert.deepEqual(registered.map((r) => r.event).sort(), ['agent/created', 'agent/disposed', 'session/disposed'], '三个生命周期事件全接线（global）')
    const agent = fakeAgent(sid, svc.scoped)
    handlers.get('agent/created')({ agent })
    assert.equal(svc.api.activeCount(), 1, '已收缩')
    handlers.get('agent/disposed')({ agent })
    assert.equal(svc.api.activeCount(), 0, 'AC2-5：disposer 已调（无残留 restrict）')
    assert.equal(sharedLiftTable().has(sid), false, '共享表无残留（跨代防线成立的前提）')
    assert.equal(svc.api.visibleOf().size, S3_UNIVERSE.length, '可见面完全恢复')
    handlers.get('agent/disposed')({ agent })
    handlers.get('session/disposed')({ id: sid })
    assert.equal(svc.api.disposed.length, 1, '二次 disposed 幂等（disposer 只调一次）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-6/AC2-9 交叉校验硬闸：任务引用被 deny 收掉⇒拒绝应用+缺失清单+restrict 未调用；差分对照（无该引用即应用）与关键词互红正例', async () => {
  const dir = toolscopeS3Dir()
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob']
  const store = new ToolscopeStore({ dataDir: dir })
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  const emits = []
  pipeline.notifier.emitFn = (p) => emits.push(p)
  try {
    // 负例（必红主体）：任务正文裸提 write（保守推导器不猜、宽松检测器抓到、deny 会收掉）
    const sid1 = 'session-s3-ac6-neg'
    store.writeRole(sid1, { role: 'scan-role', task: '把结果写入文件，并说明 write 的用法', taskbook: 'x' })
    pipeline.onCreated(fakeAgent(sid1, svc.scoped))
    assert.equal(svc.api.calls.length, 0, 'AC2-6：拒绝应用（restrict 未调用）')
    assert.equal(emits.length, 1, '缺失清单广播恰一条')
    assert.deepEqual(emits[0].missing, ['write'], '缺失清单=宽松检测器抓到的未覆盖引用')
    assert.equal(emits[0].reason, 'ref-coverage')
    // 差分对照（鉴别力证明）：同样的表与宇宙，去掉 write 引用 ⇒ 正常应用（write 确实被收）
    const sid2 = 'session-s3-ac6-pos'
    store.writeRole(sid2, { role: 'scan-role', task: '整理发现并汇报', taskbook: 'x' })
    pipeline.onCreated(fakeAgent(sid2, svc.scoped))
    assert.equal(svc.api.calls.length, 1, '无未覆盖引用 ⇒ 正常应用')
    assert.ok(!svc.api.visibleOf().has('write'), '对照证明：write 在无引用时确会被收（拒绝来自覆盖闸，非误报）')
    // 收拾 sid2 的 restrict（共享 fake 服务，防交集污染 sid3 断言）
    const prevEntry = sharedLiftTable().get(sid2)
    prevEntry?.dispose?.()
    sharedLiftTable().delete(sid2)
    // AC2-9 互红正例：族关键词路径（保守推导器）兜住显式需求 ⇒ 应用且保留
    const sid3 = 'session-s3-ac9-pos'
    store.writeRole(sid3, { role: 'scan-role', task: '需要编辑工具修正结论', taskbook: 'x' })
    pipeline.onCreated(fakeAgent(sid3, svc.scoped))
    assert.equal(svc.api.activeCount(), 1, '关键词路径：needed 含 write/edit ⇒ 应用收缩')
    assert.ok(svc.api.visibleOf().has('write') && svc.api.visibleOf().has('edit'), '族表展开保住 write/edit（双向对账的保守侧生效）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-7/AC2-4：explore 默认收缩正例（真实 roster）——首请求可见面不含 write/edit/de_session；own 层豁免（agent_reply 恒可见且不入名单）', async () => {
  const dir = toolscopeS3Dir()
  const data = loadRosterData(POLICY_DIR)
  assert.equal(data.error, null, `真实策略数据应无损坏：${data.error ?? ''}`)
  const store = new ToolscopeStore({ dataDir: dir, presets: data.presets })
  const sid = 'session-s3-ac7'
  store.writeRole(sid, { role: 'explore', task: '在代码库中检索 auth 相关模式并汇报', taskbook: 'x' })
  const svc = fakeToolsService(S3_UNIVERSE, ['agent_reply'])
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster: data.roster, logger: { warn: () => {}, error: () => {} } })
  try {
    pipeline.onCreated(fakeAgent(sid, svc.scoped))
    const visible = [...svc.scoped.tools.view().visible].sort()
    // P1 前置条件满足：参考基面含 de_session（探针报告盘点节），AC2-7 非恒红
    assert.ok(S3_UNIVERSE.includes('de_session'), 'P1 前置：universe 含 de_session（条件化不恒红）')
    assert.ok(!visible.includes('write'), 'AC2-7：write 被收')
    assert.ok(!visible.includes('edit'), 'AC2-7：edit 被收')
    assert.ok(!visible.includes('de_session'), 'AC2-7：de_session 被收')
    for (const keep of ['read', 'glob', 'grep', 'pwsh', 'de_broadcast']) {
      assert.ok(visible.includes(keep), `explore 保留 ${keep}（roster/coreBase）`)
    }
    assert.ok(visible.includes('agent_reply'), 'AC2-4：own 层豁免——收缩后 own 层仍可见')
    const payloads = svc.api.calls
    assert.equal(payloads.length, 1)
    const named = [...(payloads[0].deny ?? []), ...(payloads[0].allow ?? [])]
    assert.equal(named.includes('agent_reply'), false, 'AC2-4：own 层名不入 restrict 名单（P4：不在 restrictableNames，列入即 unknown 必拒）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-8：executor 席保留写类（真实 roster）', async () => {
  const dir = toolscopeS3Dir()
  const data = loadRosterData(POLICY_DIR)
  const store = new ToolscopeStore({ dataDir: dir, presets: data.presets })
  const sid = 'session-s3-ac8'
  store.writeRole(sid, { role: 'executor', task: '实现 X 并跑测试', taskbook: 'x' })
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster: data.roster, logger: { warn: () => {}, error: () => {} } })
  try {
    pipeline.onCreated(fakeAgent(sid, svc.scoped))
    const visible = [...svc.scoped.tools.view().visible]
    for (const keep of ['write', 'edit', 'pwsh', 'read', 'glob', 'grep', 'todo_write', 'de_broadcast']) {
      assert.ok(visible.includes(keep), `AC2-8：executor 保留 ${keep}`)
    }
    assert.ok(!visible.includes('agent_spawn'), 'executor 收掉未引用的派活类（agent_spawn 走 organizer 面）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-10 覆盖语义：grant 放权并入 needed / none 豁免跳过 / role×full 拒绝（禁整集替换）', async () => {
  const dir = toolscopeS3Dir()
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob']
  const store = new ToolscopeStore({ dataDir: dir })
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  try {
    // (a) grant 放权：显式 allow 并入 needed ⇒ grep 保留
    const sid1 = 'session-s3-ac10a'
    store.write(sid1, { sessionId: sid1, personaMode: 'role', role: 'scan-role', toolPolicy: { tier: 'grant', allow: ['grep'], deny: [] } })
    pipeline.onCreated(fakeAgent(sid1, svc.scoped))
    assert.ok(svc.api.visibleOf().has('grep'), 'grant 放权：grep 保留')
    assert.equal(svc.api.activeCount(), 1)
    // 收拾 sid1 的 restrict（共享 fake 服务，防污染后续分案的可见面断言）
    const prevEntry = sharedLiftTable().get(sid1)
    prevEntry?.dispose?.()
    sharedLiftTable().delete(sid1)
    // (b) tier none：豁免收缩（零 restrict 调用增量）
    const callsBefore = svc.api.calls.length
    const sid2 = 'session-s3-ac10b'
    store.write(sid2, { sessionId: sid2, personaMode: 'role', role: 'scan-role', toolPolicy: { tier: 'none', allow: [], deny: [] } })
    pipeline.onCreated(fakeAgent(sid2, svc.scoped))
    assert.equal(svc.api.calls.length, callsBefore, 'none：不新增 restrict 调用')
    assert.equal(svc.api.visibleOf().size, S3_UNIVERSE.length, 'none：全工具面')
    // (c) role 轨禁整集替换：tier=full 拒绝（fail-open 不收缩）
    const sid3 = 'session-s3-ac10c'
    store.write(sid3, { sessionId: sid3, personaMode: 'role', role: 'scan-role', toolPolicy: { tier: 'full', allow: ['read'], deny: [] } })
    pipeline.onCreated(fakeAgent(sid3, svc.scoped))
    assert.equal(svc.api.calls.length, callsBefore, '禁整集替换：不应用（零 restrict 增量）')
    const decision = decideToolscope({
      policy: store.read(sid3), roster, restrictable: new Set(S3_UNIVERSE), personaText: '', taskText: '',
    })
    assert.equal(decision.action, 'refuse')
    assert.equal(decision.reason, 'role-full-forbidden')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 AC2-11 fail-open 核对：roster 不可用/缺角色 ⇒ 不收缩；构建期报告列未入库角色（2 缺失夹具）', async () => {
  const dir = toolscopeS3Dir()
  const roster = s3RosterFixture()
  roster.roles['scan-role'] = ['glob']
  const store = new ToolscopeStore({ dataDir: dir })
  const svc = fakeToolsService(S3_UNIVERSE)
  // (a) roster null（数据不可用）⇒ grant 跳过
  const p1 = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster: null, logger: { warn: () => {}, error: () => {} } })
  const sid1 = 'session-s3-ac11a'
  store.writeRole(sid1, { role: 'scan-role', task: 'x', taskbook: 'x' })
  p1.onCreated(fakeAgent(sid1, svc.scoped))
  assert.equal(svc.api.calls.length, 0, 'roster 不可用：fail-open 不收缩')
  p1.dispose()
  // (b) 缺角色 ⇒ skip role-not-in-roster
  const p2 = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  const sid2 = 'session-s3-ac11b'
  store.writeRole(sid2, { role: 'ghost-role', task: 'x', taskbook: 'x' })
  const decision = decideToolscope({ policy: store.read(sid2), roster, restrictable: new Set(S3_UNIVERSE), personaText: '', taskText: '' })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'role-not-in-roster')
  p2.onCreated(fakeAgent(sid2, svc.scoped))
  assert.equal(svc.api.calls.length, 0, '缺角色：不收缩')
  p2.dispose()
  // (c) 构建期报告列未入库角色（AC2-11 + G11）
  const base = roster
  const roleTable = { explore: ['read'], executor: ['read', 'write'] }
  const fakeRoles = [
    { id: 'explore', tier: 'LOW' }, { id: 'executor', tier: 'MEDIUM' },
    { id: 'ghost-a', tier: 'LOW' }, { id: 'ghost-b', tier: 'HIGH' },
  ]
  const report = buildCoverageReport({ roles: fakeRoles, base, roleTable, generatedAt: '2026-10-26T00:00:00Z' })
  assert.deepEqual(report.missingRoles, ['ghost-a', 'ghost-b'], '报告列未入库角色')
  assert.ok(report.lines.join('\n').includes('未入库角色（运行期 fail-open 不收缩）：ghost-a、ghost-b'), '报告正文显式披露')
})

await testAsync('S3 G9 通知去重：同会话×同缺失集只发一次/缺失集变更再发/严重度升级重发/reset 清键', async () => {
  const emits = []
  const notifier = new DedupNotifier((p) => emits.push(p))
  const key1 = refuseKey('session-x', ['write'])
  assert.equal(notifier.notify(key1, { sessionId: 'session-x', missing: ['write'] }), true, '首发')
  assert.equal(notifier.notify(key1, { sessionId: 'session-x', missing: ['write'] }), false, '同键去重（不重复广播）')
  assert.equal(emits.length, 1)
  const key2 = refuseKey('session-x', ['write', 'grep'])
  assert.equal(notifier.notify(key2, { sessionId: 'session-x', missing: ['write', 'grep'] }), true, '缺失集变更=新类别键，再发')
  assert.equal(notifier.notify(key1, { sessionId: 'session-x', missing: ['write'] }, 'critical'), true, '严重度升级允许重发')
  assert.equal(emits.length, 3)
  notifier.reset(key1)
  assert.equal(notifier.notify(key1, { sessionId: 'session-x', missing: ['write'] }), true, 'reset 后同键可再发（条件解除语义）')
  assert.notEqual(refuseKey('a', ['x']), refuseKey('b', ['x']), '会话维度参与类别键')
})

await testAsync('S3 漂移门（R9 机检）：真实 policies 数据形状合法+eval-coding 与 MINIMAL_TOOLSET_FULL 相等（转正一致性）+23 角色 roles 文件与内存重扫 deep-equal', async () => {
  const data = loadRosterData(POLICY_DIR)
  assert.equal(data.error, null, `数据加载无错误：${data.error ?? ''}`)
  assert.equal(data.base.version, 1)
  assert.deepEqual(data.base.coreBase, ['read', 'de_broadcast'], 'coreBase=设计钉死的 read+de_broadcast')
  assert.deepEqual(data.presets['eval-coding'].tools, [...MINIMAL_TOOLSET_FULL], 'eval-coding 转正名单与兜底常量相等（单一事实源漂移门）')
  assert.ok(Array.isArray(data.presets['read-only'].tools) && data.presets['read-only'].tools.length >= 3, 'read-only 档在位（≥3 元素）')
  assert.equal(Object.keys(data.roles).length, 23, '23 角色全入库')
  for (const role of ROLES) {
    const expected = scanRoleReferences(role, data.base)
    assert.deepEqual(data.roles[role.id], expected.rostered, `漂移门：${role.id} 的 roles 文件与内存重扫一致（人格/模板变了须重跑 node tools/scan-role-toolrefs.mjs）`)
  }
  assert.equal(compareHostVersion('0.1.7-rc.2', '0.1.7-rc.2'), 'match')
  assert.equal(compareHostVersion('0.1.7-rc.2', '0.2.0'), 'mismatch')
  assert.equal(compareHostVersion('0.1.7-rc.2', null), 'unknown')
})

await testAsync('S3 AC2-1 read-only 预置档：wire 可见面不含 write∪exec∪dispatch 类（真实 presets 数据，12 名宇宙）', async () => {
  const dir = toolscopeS3Dir()
  const data = loadRosterData(POLICY_DIR)
  const store = new ToolscopeStore({ dataDir: dir, presets: data.presets })
  const sid = 'session-s3-ac1'
  const readOnlyTools = data.presets['read-only'].tools
  store.write(sid, {
    sessionId: sid, personaMode: 'minimal', toolPolicy: { tier: 'full', allow: readOnlyTools, deny: [] },
    replyChannel: 'org', orgId: null, preset: 'read-only',
  })
  const svc = fakeToolsService(S3_UNIVERSE, ['agent_reply'])
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster: data.roster, logger: { warn: () => {}, error: () => {} } })
  try {
    pipeline.onCreated(fakeAgent(sid, svc.scoped))
    const visible = [...svc.scoped.tools.view().visible].sort()
    for (const banned of ['write', 'edit', 'pwsh', 'agent_spawn', 'de_session', 'todo_write', 'memory']) {
      assert.ok(!visible.includes(banned), `AC2-1：read-only 档不含 ${banned}（write/exec/dispatch 类）`)
    }
    for (const kept of readOnlyTools) {
      assert.ok(visible.includes(kept), `read-only 档保留 ${kept}`)
    }
    assert.ok(visible.includes('agent_reply'), 'own 层 agent_reply 自动豁免可见（读类+agent_reply 语义）')
    assert.equal(svc.api.calls.length, 1)
    assert.deepEqual(svc.api.calls[0].allow, [...readOnlyTools], 'allow 按最终名透传（含 MCP 名同理；顺序=策略名单原序）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 留存清扫（M13）：死会话按 mtime 有界清理、活会话永不清理、roster 无 retention 配置时零动作', async () => {
  assert.deepEqual(
    planRetentionSweep({
      files: ['aaa1.toolscope.json', 'aaa2.toolscope.json', 'aaa3.toolscope.json', 'aaa4.toolscope.json'],
      mtimeOf: (f) => Number(f.replace(/\D/g, '')),
      sessionIdOf: (f) => `session-${f.replace(/\D/g, '')}`,
      keep: new Set(['session-4']),
      maxFiles: 2,
    }),
    ['aaa1.toolscope.json'],
    '死会话按 mtime 新→旧保留 2 份，最旧被清；活会话保留',
  )
  assert.deepEqual(planRetentionSweep({ files: ['a.toolscope.json'], mtimeOf: () => 1, sessionIdOf: () => 's', keep: new Set(), maxFiles: 0 }), [], 'maxFiles=0 ⇒ 零动作')
  // 管线集成：活会话（tier none 只注册存活）+2 个死文件 ⇒ maxFiles=1 只清最旧死文件
  const dir = toolscopeS3Dir()
  const roster = s3RosterFixture()
  roster.retention = { maxFiles: 1 }
  const store = new ToolscopeStore({ dataDir: dir })
  const sessionsDir = join(dir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const mk = (sid, name) => {
    const p = join(sessionsDir, `${Buffer.from(sid, 'utf8').toString('base64url')}.toolscope.json`)
    writeFileSync(p, '{}\n', 'utf8')
    return p
  }
  const pDeadOld = mk('session-dead-old')
  const pDeadNew = mk('session-dead-new')
  const pLive = mk('session-s3-live')
  const pForeign = join(sessionsDir, 'irrelevant.json')
  writeFileSync(pForeign, '{"advisor":"config-shape"}\n', 'utf8')
  const now = Date.now()
  utimesSync(pDeadOld, new Date(now - 100000), new Date(now - 100000))
  utimesSync(pDeadNew, new Date(now - 1000), new Date(now - 1000))
  utimesSync(pLive, new Date(now), new Date(now))
  const svc = fakeToolsService(S3_UNIVERSE)
  const pipeline = installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  try {
    store.write('session-s3-live', { sessionId: 'session-s3-live', personaMode: 'role', role: 'scan-role', toolPolicy: { tier: 'none', allow: [], deny: [] } })
    pipeline.onCreated(fakeAgent('session-s3-live', svc.scoped))
    pipeline.onDisposed('session-some-dead-id')
    assert.equal(existsSync(pLive), true, '活会话策略文件保留')
    assert.equal(existsSync(pDeadOld), false, '最旧死文件被清（maxFiles=1）')
    assert.equal(existsSync(pDeadNew), true, '较新死文件保留')
    assert.equal(existsSync(pForeign), true, '只清 .toolscope.json 后缀（同目录 advisor 配置文件不误删）')
  } finally {
    pipeline.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S3 install 接线：enabled=false 或缺 ctx.on ⇒ null（插件其余能力不受影响）；dispose 解除全部监听', async () => {
  assert.equal(resolveConfig({}).toolscopeEnabled, true, '缺省开（用户裁决基线）')
  assert.equal(resolveConfig({ toolscopeEnabled: false }).toolscopeEnabled, false, '消融开关可关')
  const dir = toolscopeS3Dir()
  const store = new ToolscopeStore({ dataDir: dir })
  const roster = s3RosterFixture()
  assert.equal(installToolscopePipeline({ ctx: {}, store, roster, logger: { warn: () => {}, error: () => {} } }), null, '缺 ctx.on ⇒ null（advisor wiring 同款降级）')
  assert.equal(installToolscopePipeline({ ctx: fakeEventCtx().ctx, store, roster, enabled: false, logger: { warn: () => {}, error: () => {} } }), null, 'enabled=false ⇒ null（消融臂）')
  const { ctx, handlers } = fakeEventCtx()
  const pipeline = installToolscopePipeline({ ctx, store, roster, logger: { warn: () => {}, error: () => {} } })
  assert.equal(handlers.size, 3)
  pipeline.dispose()
  assert.equal(handlers.size, 0, 'dispose 解除全部监听')
  assert.equal(sharedLiftTable().size, 0, 'dispose 后共享表清空（无跨代残留）')
  rmSync(dir, { recursive: true, force: true })
})

// ── B1 S4：极简回复通道（agent-reply / AC3-1..4 + AC3-6；AC3-5 端到端归 S5）──
// 通道四件套：own 层 agent_reply（target 注册时钉死，schema 无 target）＋内部
// 直投 sendToSession（缺省 inject）＋模式解析闸门＋频控熔断（V3-2）＋审计行。
// 假宿主纪律：投递目标假体只复刻宿主 Agent 的 status/followup/steer/inject
// 公开面（dsh-agent-loop :800-813 语义：followup=唤醒收件、steer=同回合可见、
// inject=只投不唤醒；offline=agents.get 无条目，P3 负例语义）。

/** S4 测试隔离目录（.fixture 系 gitignored；用完即清）。 */
function agentReplyDir() {
  return fileURLToPath(new URL('./.fixture-agent-reply/', import.meta.url))
}

/** 可拨钟（频控测试拨钟推进，不等真实 60 秒）。 */
function tickClock(start = 1_000_000) {
  let t = start
  return { at: () => t, advance: (ms) => { t += ms } }
}

/** 投递目标假体：记录 followup/steer/inject 调用序（公开面最小复刻）。 */
function s4AgentsService(targets) {
  const byId = new Map()
  for (const [id, spec] of Object.entries(targets)) {
    byId.set(id, {
      id,
      status: spec.status,
      calls: [],
      followup(msg) { this.calls.push(['followup', msg]) },
      steer(msg) { this.calls.push(['steer', msg]) },
      inject(msg) { this.calls.push(['inject', msg]) },
    })
  }
  return {
    byId,
    get: (id) => byId.get(id),
    callsOf: (id) => byId.get(id)?.calls ?? [],
  }
}

/** S4 用 scoped 假工具服务：在 S3 fakeToolsService 语义上加 register 面（own 层注册）。 */
function s4ScopedTools(globalNames) {
  const universe = new Set(globalNames)
  const restrictions = []
  const registered = new Map()
  const restrictCalls = []
  const admits = (name) => restrictions.every((r) => (r.allow === undefined || r.allow.has(name)) && (r.deny === undefined || !r.deny.has(name)))
  return {
    registered,
    restrictions,
    calls: restrictCalls,
    tools: {
      register(def) {
        if (registered.has(def.name)) throw new Error(`duplicate tool "${def.name}" in one layer`)
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
      view() {
        const visible = new Set([...universe].filter(admits))
        for (const name of registered.keys()) visible.add(name) // own 层豁免：恒可见（P4）
        return { visible, knownNames: new Set([...universe, ...registered.keys()]), restrictableNames: new Set(universe) }
      },
      restrict(filter) {
        restrictCalls.push(filter)
        const allow = filter.allow
        const deny = filter.deny
        if (allow === undefined && deny === undefined) throw new Error('tools.restrict({}) is a no-op')
        const unknown = [...allow ?? [], ...deny ?? []].filter((n) => !universe.has(n))
        if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}`)
        const entry = {
          ...(allow !== undefined ? { allow: new Set(allow) } : {}),
          ...(deny !== undefined ? { deny: new Set(deny) } : {}),
        }
        restrictions.push(entry)
        let done = false
        return () => {
          if (done) return
          done = true
          const i = restrictions.indexOf(entry)
          if (i >= 0) restrictions.splice(i, 1)
        }
      },
    },
  }
}

/** 逐行解析审计 jsonl（AC3-4 的持久面取证入口）。 */
function readAuditLines(file) {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

/** target 形参数的健壮性检查器（AC3-2 断言本体：schema 不得声明收件方向参数）。 */
const REPLY_FORBIDDEN_PARAMS = ['target', 'to', 'recipient', 'recipients', 'sessionId', 'sessionIds', 'roomId', 'organizer']
function assertNoTargetParam(def) {
  const props = def.parameters?.properties ?? {}
  const hit = REPLY_FORBIDDEN_PARAMS.filter((key) => Object.hasOwn(props, key))
  assert.deepEqual(hit, [], `agent_reply schema 不得声明收件方向参数，命中：${hit.join(', ')}`)
}

await testAsync('S4 AC3-1 模式解析矩阵：org idle→followup / org running→steer / 非 org 唤醒→inject 降级 / offline→offline / 无唤醒→inject（5 格 ≥3 元素输入）', async () => {
  assert.deepEqual(resolveDeliveryMode({ isOrg: true, targetState: 'idle', wake: true }), { mode: 'followup', wake: true, degraded: null })
  assert.deepEqual(resolveDeliveryMode({ isOrg: true, targetState: 'running', wake: true }), { mode: 'steer', wake: true, degraded: null })
  assert.deepEqual(resolveDeliveryMode({ isOrg: false, targetState: 'idle', wake: true }), { mode: 'inject', wake: false, degraded: 'wake-denied-non-org' })
  assert.deepEqual(resolveDeliveryMode({ isOrg: false, targetState: 'running', wake: true }), { mode: 'inject', wake: false, degraded: 'wake-denied-non-org' })
  assert.deepEqual(resolveDeliveryMode({ isOrg: true, targetState: undefined, wake: true }), { mode: 'offline', wake: false, degraded: null }, '宿主漂移（status 读不到）按 offline 拒投——fail-safe 方向')
  assert.deepEqual(resolveDeliveryMode({ isOrg: true, targetState: 'idle', wake: false }), { mode: 'inject', wake: false, degraded: null }, '缺省只投不唤醒（内部直投缺省语义）')
})

await testAsync('S4 AC3-6 频控熔断纯逻辑：60 秒窗 ≤3、第 4 次降级、连降 10 次熔断至会话终、成功清零、clear 解除；去频控变异必红对照', async () => {
  const clock = tickClock()
  const lim = new WakeRateLimiter({ now: clock.at }) // 缺省常数 60_000/3/10
  assert.deepEqual({ windowMs: lim.windowMs, windowMax: lim.windowMax, breakAfter: lim.breakAfter }, REPLY_DEFAULTS, '缺省常数=REPLY_DEFAULTS（60s/3/10）')
  const seq = [1, 2, 3, 4, 5].map(() => lim.request('session-min'))
  assert.deepEqual(seq.slice(0, 3).map((r) => r.allowed), [true, true, true], '窗口内前 3 次获准')
  assert.equal(seq[3].allowed, false, '第 4 次降级')
  assert.equal(seq[3].reason, 'window-exceeded')
  assert.equal(seq[4].consecutive, 2, '连续降级计数累计')
  clock.advance(60_001)
  const slid = lim.request('session-min')
  assert.equal(slid.allowed, true, '窗口滑动后旧请求出窗，再次获准')
  assert.equal(lim.request('session-min').consecutive, 0, '获准唤醒清零连续降级计数')
  // 灌满窗口（现共 3 条，consecutive=0），随后同一窗内连打 10 次全降级——
  // 第 10 次连续降级触发熔断（REPLY_DEFAULTS.breakAfter=10）。
  lim.request('session-min')
  let broke = null
  for (let i = 0; i < 10; i++) broke = lim.request('session-min')
  assert.equal(broke.allowed, false)
  assert.equal(broke.consecutive, 10)
  assert.equal(broke.circuitBroken, true, '第 10 次连续降级触发熔断（下游据此广播组织者）')
  assert.equal(lim.broken('session-min'), true)
  assert.equal(lim.request('session-min').reason, 'circuit-broken', '熔断后一律拒绝唤醒（后续全 inject）')
  clock.advance(10 * 60_000)
  assert.equal(lim.request('session-min').allowed, false, '熔断不受窗口滑动影响（至会话结束）')
  lim.clear('session-min')
  assert.equal(lim.broken('session-min'), false, 'clear（会话终锚点）解除熔断')
  assert.equal(lim.request('session-min').allowed, true, '解除后恢复窗口语义')
  // 去频控变异必红对照（AC3-6 负向）：windowMax 放开=去频控，第 4 次同窗请求
  // 获准唤醒——AC3-6 断言「第 4 次必须 inject」在变异体下必翻红。
  const mutant = new WakeRateLimiter({ now: clock.at, windowMax: Number.MAX_SAFE_INTEGER })
  const mutantSeq = [1, 2, 3, 4].map(() => mutant.request('session-min'))
  assert.deepEqual(mutantSeq.map((r) => r.allowed), [true, true, true, true], '变异体第 4 次仍获准 ⇒ AC3-6 断言（第 4 次降级）必红')
  assert.notEqual(mutantSeq[3].allowed, false, '变异体观测值≠被要求值：断言有抓变异的能力（对照证据）')
})

await testAsync('S4 AC3-2 agent_reply schema 无 target 参数（负向必红：加 target 变异即翻红）+ DSH 硬约束 + 描述 ≤120 字且 ≤200 字节 + execute 物理忽略多余参数', async () => {
  const def = agentReplyTool({ fromId: 'session-min', orgId: 'session-org', task: 't', send: () => ({ ok: true }) })
  assert.equal(def.name, 'agent_reply')
  // DSH 硬约束（工具契约）：parameters 单一 type + 顶层 required、output.schema + render
  assert.equal(def.parameters.type, 'object')
  assert.deepEqual(def.parameters.required, ['message'])
  assert.equal(typeof def.output.render, 'function', 'output.render 必须是函数（宿主 register 契约）')
  assert.ok(def.output.schema && typeof def.output.schema === 'object')
  // 计量门（AC1-3 单独计量归因）：描述 ≤120 字且 ≤200 字节（双口径同过）
  assert.ok(REPLY_TOOL_DESCRIPTION.length <= 120, `描述 ${REPLY_TOOL_DESCRIPTION.length} 字 ≤120`)
  assert.ok(Buffer.byteLength(REPLY_TOOL_DESCRIPTION, 'utf8') <= 200, `描述 ${Buffer.byteLength(REPLY_TOOL_DESCRIPTION, 'utf8')} 字节 ≤200`)
  assertNoTargetParam(def)
  // 负向必红：给变异体加 target 参数，同检查器必须翻红（断言有抓变异能力）
  const mutant = { ...def, parameters: { ...def.parameters, properties: { ...def.parameters.properties, target: { type: 'string' } } } }
  assert.throws(() => assertNoTargetParam(mutant), /不得声明收件方向参数.*target/, '加 target 变异必红（AC3-2 负向对照）')
  // 物理不可达：execute 只读 message——多余参数（哪怕叫 target）不进投递链
  const seen = []
  const exec = agentReplyTool({ fromId: 'session-min', orgId: 'session-org', task: 't', send: (input) => { seen.push(input); return { ok: true, delivered: true, mode: 'inject', reason: null, degraded: null } } })
  const r = await exec.execute({ message: '进度 50%', target: 'session-evil', to: 'session-evil' })
  assert.deepEqual(seen, [{ text: '进度 50%' }], 'send 只收 message 文本，target/to 物理不可达')
  assert.equal(r.delivered, true)
  const empty = await exec.execute({ message: '   ' })
  assert.equal(empty.delivered, false, '空正文不投递')
  assert.equal(empty.reason, 'empty-message')
  assert.equal(seen.length, 1, '空正文不触发 send')
})

await testAsync('S4 注册门控：minimal×replyChannel=org 才注册（role/无策略/replyChannel null 零触碰）；orgId 缺失跳过并审计；own 层注册豁免 restrict（真实 def 复证 P4）', async () => {
  const dir = agentReplyDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    const clock = tickClock()
    const svc = s4ScopedTools(['read', 'write'])
    const agents = s4AgentsService({ 'session-org': { status: 'idle' } })
    const pipeline = installAgentReply({ ctx: fakeEventCtx().ctx, store, dataDir: dir, agents, now: clock.at, logger: { warn: () => {}, error: () => {} } })
    try {
      // 正例：minimal × org → 注册；目标钉死 orgId
      store.writeMinimal('session-min', { orgId: 'session-org', task: '实现回复通道' })
      const minAgent = { id: 'session-min', ctx: svc }
      pipeline.onCreated(minAgent)
      assert.equal(svc.registered.has('agent_reply'), true, 'minimal×org 注册 agent_reply')
      const def = svc.registered.get('agent_reply')
      assert.equal(def.name, 'agent_reply')
      // own 层豁免复证（真实 def）：restrict allow 只留 read，agent_reply 仍可见
      svc.tools.restrict({ allow: ['read'] })
      assert.equal(svc.tools.view().visible.has('agent_reply'), true, 'own 层在收缩后仍可见（P4 语义）')
      assert.equal(svc.tools.view().visible.has('write'), false, 'restrict 生效（对照面）')
      // 负例 1：role 轨 → 零触碰
      store.writeRole('session-role', { role: 'executor', task: 'x' })
      pipeline.onCreated({ id: 'session-role', ctx: s4ScopedTools(['read', 'write']) })
      // 负例 2：minimal 但 replyChannel=null → 零触碰
      store.write('session-nochan', { sessionId: 'session-nochan', personaMode: 'minimal', toolPolicy: { tier: 'full', allow: ['read'], deny: [] }, replyChannel: null, orgId: null })
      pipeline.onCreated({ id: 'session-nochan', ctx: s4ScopedTools(['read', 'write']) })
      // 负例 3：无策略文件（非本插件派发）→ 零触碰
      pipeline.onCreated({ id: 'session-foreign', ctx: s4ScopedTools(['read', 'write']) })
      assert.equal(svc.registered.size, 1, '只有 minimal×org 会话拿到 agent_reply（其余零触碰）')
      // 负例 4：minimal×org 但 orgId 缺失 → 跳过注册 + 审计 no-org-target
      store.write('session-noorg', { sessionId: 'session-noorg', personaMode: 'minimal', toolPolicy: { tier: 'full', allow: ['read'], deny: [] }, replyChannel: 'org', orgId: null })
      const noorgSvc = s4ScopedTools(['read'])
      pipeline.onCreated({ id: 'session-noorg', ctx: noorgSvc })
      assert.equal(noorgSvc.registered.size, 0, '无 orgId 不注册（无钉死目标的通道是无效通道）')
      assert.equal(pipeline.audit().some((l) => l.reason === 'no-org-target' && l.from === 'session-noorg'), true, '跳过留审计痕')
    } finally {
      pipeline.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S4 AC3-3 offline 结构化失败不抛 + 内部直投缺省 inject/白名单唤醒/模式矩阵（AC3-1 集成面）', async () => {
  const dir = agentReplyDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    store.writeMinimal('session-min', { orgId: 'session-org' })
    const agents = s4AgentsService({ 'session-org': { status: 'idle' }, 'session-peer': { status: 'running' } })
    const pipeline = installAgentReply({ ctx: fakeEventCtx().ctx, store, dataDir: dir, agents, logger: { warn: () => {}, error: () => {} } })
    try {
      // AC3-3：offline → 结构化失败，不抛、不重试
      const ghost = pipeline.sendToSession('session-ghost', 'hello', { from: 'session-min' })
      assert.deepEqual(ghost, { ok: false, delivered: false, mode: 'offline', reason: 'offline', degraded: null })
      assert.equal(agents.callsOf('session-ghost').length, 0, 'offline 无任何投递调用')
      // 内部直投缺省 inject（不唤醒）
      const plain = pipeline.sendToSession('session-org', '通知', { from: 'session-min' })
      assert.deepEqual(plain, { ok: true, delivered: true, mode: 'inject', reason: null, degraded: null })
      assert.deepEqual(agents.callsOf('session-org').map(([mode]) => mode), ['inject'])
      // 唤醒类：target=orgId（白名单单元素）idle→followup
      const wake = pipeline.sendToSession('session-org', '完成汇报', { from: 'session-min', wake: true })
      assert.equal(wake.mode, 'followup')
      // 唤醒类：非 org 目标 → 降级 inject + 标注（消息不丢、唤醒不发）
      const denied = pipeline.sendToSession('session-peer', '越权唤醒?', { from: 'session-min', wake: true })
      assert.equal(denied.mode, 'inject')
      assert.equal(denied.degraded, 'wake-denied-non-org')
      assert.deepEqual(agents.callsOf('session-peer').map(([mode]) => mode), ['inject'])
      // org running → steer（同回合可见）
      agents.byId.get('session-org').status = 'running'
      const steer = pipeline.sendToSession('session-org', '补充', { from: 'session-min', wake: true })
      assert.equal(steer.mode, 'steer')
      // 信封：user-role + 插件来源 + 首行归属标记
      const last = agents.callsOf('session-org').at(-1)
      assert.equal(last[1].role, 'user')
      assert.equal(last[1].source.kind, 'plugin')
      assert.ok(last[1].content[0].text.startsWith('【agent_reply·来自 session-min】'), '首行归属标记（防伪装用户指令）')
      assert.ok(last[1].content[0].text.endsWith('补充'))
    } finally {
      pipeline.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S4 AC3-6 频控熔断集成：第 4 次唤醒降级 inject+审计标注、连降 10 次熔断+通知组织者、会话终清态恢复；去频控变异必红对照', async () => {
  const dir = agentReplyDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    store.writeMinimal('session-min', { orgId: 'session-org' })
    const clock = tickClock()
    const agents = s4AgentsService({ 'session-org': { status: 'idle' } })
    const pipeline = installAgentReply({ ctx: fakeEventCtx().ctx, store, dataDir: dir, agents, now: clock.at, logger: { warn: () => {}, error: () => {} } })
    try {
      const send = (n) => pipeline.sendToSession('session-org', `m${n}`, { from: 'session-min', wake: true })
      // 窗口 ≤3（REPLY_DEFAULTS）：1..3 followup，第 4 次降级 inject
      assert.deepEqual([send(1).mode, send(2).mode, send(3).mode], ['followup', 'followup', 'followup'])
      const fourth = send(4)
      assert.equal(fourth.mode, 'inject', 'AC3-6：第 4 次唤醒类投递实际以 inject 送达')
      assert.equal(fourth.degraded, 'window-exceeded')
      assert.equal(agents.callsOf('session-org').at(-1)[0], 'inject', '消息不丢（以 inject 送达）')
      // 连续降级至 10（第 4..13 次）→ 第 13 次触发熔断并通知组织者
      let broke = null
      for (let n = 5; n <= 13; n++) broke = send(n)
      assert.equal(broke.degraded, 'window-exceeded')
      assert.equal(pipeline.limiter.broken('session-min'), true, '连降 10 次熔断至会话终')
      const notice = agents.callsOf('session-org').find(([mode, msg]) => mode === 'inject' && msg.content[0].text.includes('熔断'))
      assert.ok(notice, '熔断事件已 inject 告知组织者（不唤醒）')
      // 熔断后：唤醒请求一律 inject + circuit-broken 标注
      const after = send(14)
      assert.equal(after.mode, 'inject')
      assert.equal(after.degraded, 'circuit-broken')
      // 会话终（disposed）清态 → 恢复窗口语义
      pipeline.onDisposed('session-min')
      assert.equal(pipeline.limiter.broken('session-min'), false)
      assert.equal(send(15).mode, 'followup', '会话终后熔断态清空，窗口语义恢复')
      // 审计降级标注（AC3-4 + V3-2「审计行记降级事件」）
      const auditLines = readAuditLines(join(dir, REPLY_AUDIT_FILENAME))
      const degradedLine = auditLines.find((l) => l.degraded === 'window-exceeded')
      assert.ok(degradedLine, '审计行含降级标注')
      assert.equal(degradedLine.form, 'inject')
      // 去频控变异必红对照：放开 windowMax 的同构管线，第 4 次是 followup
      // ⇒ AC3-6 断言（第 4 次=inject）在变异体下必翻红。
      const mutantPipeline = installAgentReply({
        ctx: fakeEventCtx().ctx, store, dataDir: dir, agents,
        limiter: new WakeRateLimiter({ now: clock.at, windowMax: Number.MAX_SAFE_INTEGER }),
        auditPath: join(dir, 'mutant-audit.jsonl'),
        logger: { warn: () => {}, error: () => {} },
      })
      try {
        const mutantSend = (n) => mutantPipeline.sendToSession('session-org', `mm${n}`, { from: 'session-min', wake: true })
        assert.deepEqual([mutantSend(1).mode, mutantSend(2).mode, mutantSend(3).mode, mutantSend(4).mode], ['followup', 'followup', 'followup', 'followup'], '去频控变异体第 4 次仍 followup ⇒ AC3-6 断言必红（对照证据）')
      } finally {
        mutantPipeline.dispose()
      }
    } finally {
      pipeline.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S4 AC3-4 审计行字段齐（时间/发起会话/目标/形态/任务引用）+ jsonl 持久面落盘 + task 引用截断', async () => {
  const dir = agentReplyDir()
  mkdirSync(dir, { recursive: true })
  try {
    const store = new ToolscopeStore({ dataDir: dir })
    store.writeMinimal('session-min', { orgId: 'session-org', task: '实现回复通道四件套' })
    const agents = s4AgentsService({ 'session-org': { status: 'idle' } })
    const pipeline = installAgentReply({ ctx: fakeEventCtx().ctx, store, dataDir: dir, agents, logger: { warn: () => {}, error: () => {} } })
    try {
      pipeline.sendToSession('session-org', 'a', { from: 'session-min', task: '实现回复通道四件套', wake: true })
      pipeline.sendToSession('session-ghost', 'b', { from: 'session-min', task: '实现回复通道四件套' })
      pipeline.sendToSession('session-org', 'c', { from: 'session-min', task: `${'长'.repeat(300)}` })
      const file = join(dir, REPLY_AUDIT_FILENAME)
      assert.equal(existsSync(file), true, '审计落盘 dataDir 持久面（OQ#2 裁决）')
      const lines = readAuditLines(file)
      assert.ok(lines.length >= 3, `≥3 条审计行（实得 ${lines.length}，断言鉴别力）`)
      for (const line of lines) {
        assert.equal(line.kind, 'reply')
        assert.ok(typeof line.time === 'string' && !Number.isNaN(Date.parse(line.time)), `时间字段 ISO 可解析：${line.time}`)
        assert.equal(line.from, 'session-min', '发起会话字段')
        assert.ok('to' in line && line.to !== undefined, '目标字段')
        assert.ok(['followup', 'steer', 'inject', 'offline', 'skipped'].includes(line.form), `形态字段：${line.form}`)
        assert.ok(typeof line.task === 'string', '任务引用字段')
        assert.ok('delivered' in line, 'delivered 字段')
      }
      assert.equal(lines[0].form, 'followup')
      assert.equal(lines[0].task, '实现回复通道四件套')
      assert.equal(lines[1].form, 'offline', 'offline 失败也留审计行（每次投递尝试一条）')
      assert.equal(lines[1].delivered, false)
      assert.equal(lines[2].task.length, 200, 'task 引用截断至 200 字符（引用非全文）')
      assert.equal(pipeline.audit().length, lines.length, '内存环与文件一致')
    } finally {
      pipeline.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testAsync('S4 杂项：taskRef 规整 + install 降级（enabled=false 或缺 ctx.on ⇒ null）+ dispose 解除全部监听', async () => {
  assert.equal(taskRef('  a\n b  '), 'a b', '压平空白')
  assert.equal(taskRef(`${'x'.repeat(300)}`).length, 200, '截断 200')
  assert.equal(taskRef(null), '', 'null 安全')
  const dir = agentReplyDir()
  const store = new ToolscopeStore({ dataDir: dir })
  assert.equal(installAgentReply({ ctx: {}, store, dataDir: dir, logger: { warn: () => {}, error: () => {} } }), null, '缺 ctx.on ⇒ null（toolscope 管线同款降级）')
  assert.equal(installAgentReply({ ctx: fakeEventCtx().ctx, store, dataDir: dir, enabled: false, logger: { warn: () => {}, error: () => {} } }), null, 'enabled=false ⇒ null（消融联动）')
  const { ctx, handlers } = fakeEventCtx()
  const pipeline = installAgentReply({ ctx, store, dataDir: dir, logger: { warn: () => {}, error: () => {} } })
  assert.equal(handlers.size, 3, 'created/disposed×2 三事件接线')
  pipeline.dispose()
  assert.equal(handlers.size, 0, 'dispose 解除全部监听')
  rmSync(dir, { recursive: true, force: true })
})

await testAsync('B1 S4 集成（apply 接线）：minimal 派活→created 注册 agent_reply→execute 回 ORG（idle 唤醒 followup）；role 会话不注册；org 离线结构化失败；审计落 <dataDir>/reply-audit.jsonl', async () => {
  const env = minimalEnvSetup()
  try {
    let orgLive = true
    const orgCalls = []
    const orgAgent = {
      id: 'session-org-e2e',
      status: 'idle',
      followup(m) { orgCalls.push(['followup', m]) },
      steer(m) { orgCalls.push(['steer', m]) },
      inject(m) { orgCalls.push(['inject', m]) },
    }
    const handlers = new Map()
    const createdEvents = []
    const { ctx, tools } = fakeCtx({
      on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event) },
      agents: {
        create: async (options) => {
          createdEvents.push(options)
          return { agent: { followup: (msg) => createdEvents.push({ followup: msg }) }, dispose: () => {} }
        },
        get: (id) => (id === 'session-org-e2e' && orgLive ? orgAgent : undefined),
      },
      workspaceRegistry: undefined,
    })
    apply(ctx, {})
    assert.equal(handlers.has('agent/created'), true, 'apply 接线 agent/created（toolscope/reply 两条管线同事件挂点）')
    const spawnToolDef = tools.get('agent_spawn')
    const r = await spawnToolDef.execute({
      task: '写一个 fizzbuzz 函数并通过测试',
      personaMode: 'minimal',
      provider: 'prov-x', model: 'model-x',
      organizer: 'session-org-e2e',
      cwd: 'D:\\work\\eval',
    }, { agent: minimalRequester() })
    assert.equal(r.ok, true, r.message)
    assert.equal(r.toolscope?.orgId, 'session-org-e2e')
    // 假宿主 create 不派发事件：手动派发（suite/探针同款），ctx 带 scoped 工具面
    const minSvc = s4ScopedTools(['read', 'write', 'edit', 'glob', 'grep', 'pwsh'])
    handlers.get('agent/created')({ agent: { id: r.sessionId, ctx: minSvc } })
    assert.equal(minSvc.registered.has('agent_reply'), true, 'created 挂点按策略注册 own 层 agent_reply')
    assertNoTargetParam(minSvc.registered.get('agent_reply'))
    // 端到端：minimal 会话调 agent_reply → org idle → followup 唤醒收件
    const reply = await minSvc.registered.get('agent_reply').execute({ message: '任务完成，产出已落盘' })
    assert.equal(reply.delivered, true)
    assert.equal(reply.mode, 'followup', 'AC3-1 集成面：org idle → followup')
    assert.equal(orgCalls.length, 1)
    assert.ok(orgCalls[0][1].content[0].text.startsWith('【agent_reply·来自'), '信封首行归属标记')
    // role 会话：created 零触碰（不注册回复工具）
    const r2 = await spawnToolDef.execute({ role: 'explore', task: '检索 X' }, { agent: minimalRequester() })
    assert.equal(r2.ok, true, r2.message)
    const roleSvc = s4ScopedTools(['read', 'glob', 'grep', 'pwsh'])
    handlers.get('agent/created')({ agent: { id: r2.sessionId, ctx: roleSvc } })
    assert.equal(roleSvc.registered.has('agent_reply'), false, 'role 轨会话不注册回复通道')
    // org 离线（agents.get 无条目）→ 结构化失败不抛（AC3-3 端到端面）
    orgLive = false
    const offline = await minSvc.registered.get('agent_reply').execute({ message: 'again' })
    assert.deepEqual(offline, { ok: false, delivered: false, mode: 'offline', reason: 'offline', degraded: null })
    // 审计落盘 = dataDir 持久面（OQ#2 裁决的 apply 级证据）
    const auditFile = join(env.dir, 'data', REPLY_AUDIT_FILENAME)
    assert.equal(existsSync(auditFile), true, '审计文件落 <dataDir>/reply-audit.jsonl')
    const lines = readAuditLines(auditFile)
    assert.ok(lines.length >= 2, `审计行 ≥2（实得 ${lines.length}）`)
    assert.equal(lines.at(-1).form, 'offline')
    assert.equal(lines.at(-1).to, 'session-org-e2e')
    // OQ#2 后半（S5 收口）：spawn 决策行并轨同一审计文件——kind:'spawn' 与
    // kind:'reply' 同文件异类；两次派活（minimal+role）各留一条。
    const spawnLines = lines.filter((l) => l.kind === 'spawn')
    assert.equal(spawnLines.length, 2, `spawn 决策行 2 条（实得 ${spawnLines.length}）`)
    assert.ok(spawnLines.every((l) => typeof l.time === 'string' && !Number.isNaN(Date.parse(l.time))), 'spawn 行时间字段 ISO 可解析')
    assert.equal(spawnLines[0].personaMode, 'minimal')
    assert.equal(spawnLines[0].preset, 'minimal', 'minimal 决策行带预设（V2-1 缺省）')
    assert.equal(spawnLines[0].provider, 'prov-x')
    assert.equal(spawnLines[0].model, 'model-x')
    assert.equal(spawnLines[0].orgId, 'session-org-e2e')
    assert.equal(spawnLines[1].personaMode, 'role')
    assert.equal(spawnLines[1].role, 'explore', 'role 决策行带角色 id')
    assert.equal(spawnLines[1].tier, 'LOW', 'role 决策行带档位（explore=LOW）')
    assert.deepEqual(lines.filter((l) => l.kind === 'reply').map((l) => l.form), ['followup', 'offline'], '回复行与 spawn 行同文件互不干扰')
  } finally {
    minimalEnvTeardown(env)
  }
})

// ── B1 S5：V3-3 收缩生效率读数组消费（efficiencyReadings + replayEntries）────
// 三值 = 对账通过率 / 实际收缩占比 / fail-open 原因分布（缺失清单聚合）；
// 阈值（设计 V3-3）：对账生效率 <50% → verdict 触发表修复轮。

test('S5 V3-3 生效率读数组消费核：三值口径 + nothing-to-strip 计入闸分母 + 缺失清单聚合（7 元素夹具）', () => {
  const entries = [
    { sessionId: 's1', action: 'allow' },                                                              // full 整集应用
    { sessionId: 's2', action: 'deny' },                                                               // role 收缩应用
    { sessionId: 's3', action: 'deny' },
    { sessionId: 's4', action: 'refuse', reason: 'ref-coverage', missing: ['write', 'edit'] },         // 交叉校验拒绝
    { sessionId: 's5', action: 'refuse', reason: 'ref-coverage', missing: ['write'] },                 // 同名缺失聚合
    { sessionId: 's6', action: 'skip', reason: 'tier-none' },                                          // 未进闸（不对账分母）
    { sessionId: 's7', action: 'skip', reason: 'nothing-to-strip' },                                   // 进闸且通过
  ]
  const r = efficiencyReadings(entries)
  assert.equal(r.empty, false)
  assert.equal(r.sessions, 7, '收缩占比分母=策略承载会话数')
  assert.equal(r.applied, 3, '实际收缩=allow/deny 会话数')
  assert.equal(r.gate.denominator, 6, '对账分母=allow/deny/refuse + nothing-to-strip（3+2+1）')
  assert.equal(r.gate.passed, 4)
  assert.ok(Math.abs(r.gate.passRate - 4 / 6) < 1e-9, `对账通过率=4/6（实得 ${r.gate.passRate}）`)
  assert.ok(Math.abs(r.shrink.ratio - 3 / 7) < 1e-9, `收缩占比=3/7（实得 ${r.shrink.ratio}）`)
  assert.deepEqual(r.failOpen.byReason, { 'ref-coverage': 2, 'tier-none': 1, 'nothing-to-strip': 1 })
  assert.deepEqual(r.failOpen.missingAgg, { write: 2, edit: 1 }, '缺失清单跨会话聚合（write 出现 2 次）')
  assert.equal(r.verdict, 'efficiency-ok')
  assert.equal(EFFICIENCY_THRESHOLD, 0.5, '阈值钉值（设计 V3-3）')
})

test('S5 V3-3 生效率低于阈值 → verdict 触发表修复轮；空输入 → no-sample 不伪装读数', () => {
  const low = efficiencyReadings([
    { sessionId: 'a', action: 'refuse', reason: 'ref-coverage', missing: ['x'] },
    { sessionId: 'b', action: 'refuse', reason: 'unknown-names', missing: ['y', 'z'] },
    { sessionId: 'c', action: 'refuse', reason: 'ref-coverage', missing: ['x'] },
    { sessionId: 'd', action: 'allow' },
    { sessionId: 'e', action: 'deny' },
  ])
  assert.equal(low.gate.denominator, 5)
  assert.equal(low.gate.passed, 2)
  assert.ok(low.gate.passRate < EFFICIENCY_THRESHOLD, '2/5=0.4 < 0.5')
  assert.equal(low.verdict, 'efficiency-low-repair-round', '触发表修复轮判据在位')
  const empty = efficiencyReadings([])
  assert.deepEqual({ empty: empty.empty, sessions: empty.sessions, verdict: empty.verdict }, { empty: true, sessions: 0, verdict: 'no-sample' })
})

test('S5 V3-3 replayEntries：离线重放同一决策核（真实 roster + 夹具策略文件 3 会话 → deny/skip/allow 同构 entries）', () => {
  const roster = loadRosterData(POLICY_DIR).roster
  assert.ok(roster, '真实 roster 可加载（重放前置）')
  assert.ok(roster.roles.explore, 'explore 在表（deny 路径前置）')
  const dir = fileURLToPath(new URL('./.fixture-s5-replay/data', import.meta.url))
  const sessionsDir = join(dir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  try {
    const mk = (sessionId, body) => writeFileSync(
      join(sessionsDir, `${Buffer.from(sessionId, 'utf8').toString('base64url')}.toolscope.json`),
      JSON.stringify({ schemaVersion: 1, sessionId, personaMode: body.personaMode, toolPolicy: body.toolPolicy, replyChannel: 'org', orgId: 'session-org', createdAt: 0, updatedAt: 0, ...body.extra }),
      'utf8',
    )
    mk('s5-role-in-roster', { personaMode: 'role', toolPolicy: { tier: 'grant', allow: [] }, extra: { role: 'explore', task: '检索资料' } })
    mk('s5-ghost-role', { personaMode: 'role', toolPolicy: { tier: 'grant', allow: [] }, extra: { role: 'ghost-role', task: '检索资料' } })
    mk('s5-minimal-full', { personaMode: 'minimal', toolPolicy: { tier: 'full', allow: [...MINIMAL_TOOLSET_FULL] }, extra: { task: '评测任务' } })
    const { entries, files, parseErrors } = replayEntries({ dataDir: dir, roster })
    assert.equal(files, 3, '三个策略文件全部进入重放')
    assert.deepEqual(parseErrors, [], '零解析错误')
    const byId = Object.fromEntries(entries.map((e) => [e.sessionId, e]))
    assert.equal(byId['s5-role-in-roster'].action, 'deny', '在表角色 → 收缩应用（同管线决策核）')
    assert.equal(byId['s5-ghost-role'].action, 'skip', '缺角色 fail-open skip role-not-in-roster')
    assert.equal(byId['s5-ghost-role'].reason, 'role-not-in-roster')
    assert.equal(byId['s5-minimal-full'].action, 'allow', 'minimal 整集（MINIMAL_TOOLSET_FULL ⊆ 宇宙）→ allow')
    const r = efficiencyReadings(entries)
    assert.equal(r.sessions, 3)
    assert.equal(r.applied, 2)
    assert.equal(r.verdict, 'efficiency-ok')
  } finally {
    rmSync(fileURLToPath(new URL('./.fixture-s5-replay/', import.meta.url)), { recursive: true, force: true })
  }
})

test('S5 V3-3 replayEntries：真实 dataDir 当前状态如实呈现（零策略文件 → no-sample，不伪装读数）', () => {
  const roster = loadRosterData(POLICY_DIR).roster
  const { entries, parseErrors } = replayEntries({ dataDir: join('.tmp-nonexistent-s5', 'data'), roster })
  assert.equal(entries.length, 0, 'sessions 目录不可读 → 零 entries（不抛不猜）')
  assert.deepEqual(parseErrors.map((p) => p.startsWith('sessions 目录不可读')), [true])
  const r = efficiencyReadings(entries)
  assert.equal(r.verdict, 'no-sample')
})

// ── settings 接线：三档模型运行时配置（设置页同源） ───────────────────────
/** 最小 settings 服务假体：base 分层 + user 层深合并（register/update/replace）。 */
function fakeSettings() {
  let user = {}
  const deepMerge = (b, u) => {
    const out = Array.isArray(b) ? [...(b ?? [])] : { ...(b ?? {}) }
    for (const [k, v] of Object.entries(u ?? {})) {
      out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v
    }
    return out
  }
  return {
    register: (ns, schema, opts = {}) => ({
      get: () => deepMerge(opts.base ?? {}, user),
      // ⚠️ 对照宿主 SettingsProvider 真契约：scope.update(patch)/scope.replace(section)
      //（ns 已闭包绑定）；此前假体写成 (ns, patch) 掩盖了「两参调用」真 bug。
      update: async (patch) => {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError(`settings update for "${ns}" must be a plain object`)
        user = deepMerge(user, patch)
      },
      replace: async (section) => {
        if (section === null || typeof section !== 'object' || Array.isArray(section)) throw new TypeError(`settings replace for "${ns}" must be a plain object`)
        user = section ?? {}
      },
    }),
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

await testAsync('settings 接线：无 settings 服务时回落 cordis 配置，set 不可用', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { tiers: { HIGH: { provider: 'prov-x', model: 'model-x' } } })
  await settle()
  const r = await tools.get('agent_roles').execute({ action: 'tiers' })
  assert.equal(r.ok, true)
  assert.equal(r.tiers.HIGH.provider, 'prov-x')
  assert.equal(r.tiers.LOW.provider, DEFAULT_TIERS.LOW.provider)
  assert.equal(r.tierSources.HIGH, 'cordis 配置')
  assert.equal(r.tierSources.LOW, 'cordis 配置', 'resolveConfig 已把内置默认填进基底，来源显示为 cordis 配置')
  const s = await tools.get('agent_roles').execute({ action: 'set', tier: 'MEDIUM', provider: 'p', model: 'm' })
  assert.equal(s.ok, false)
  assert.ok(s.message.includes('设置服务不可用'))
})

await testAsync('settings 接线：set 即时改档 + tierSources 标注 + reset 回落', async () => {
  const { ctx, tools } = fakeCtx({ settings: fakeSettings() })
  apply(ctx, { tiers: { HIGH: { provider: 'prov-x', model: 'model-x' } } })
  await settle()
  const before = await tools.get('agent_roles').execute({ action: 'tiers' })
  assert.equal(before.tierSources.HIGH, 'cordis 配置基底')
  assert.equal(before.tierSources.LOW, 'cordis 配置基底')

  const set = await tools.get('agent_roles').execute({ action: 'set', tier: 'medium', provider: 'glm-pro', model: 'glm-5.3' })
  assert.equal(set.ok, true, set.message)
  assert.equal(set.tiers.MEDIUM.provider, 'glm-pro')
  assert.equal(set.tiers.MEDIUM.model, 'glm-5.3')
  assert.equal(set.tierSources.MEDIUM, '设置（用户层覆盖）')
  assert.equal(set.tiers.HIGH.provider, 'prov-x', '未设置的档位不受影响')

  const badTier = await tools.get('agent_roles').execute({ action: 'set', tier: 'ULTRA', provider: 'p', model: 'm' })
  assert.equal(badTier.ok, false)
  const half = await tools.get('agent_roles').execute({ action: 'set', tier: 'LOW', provider: 'p' })
  assert.equal(half.ok, false)

  const reset = await tools.get('agent_roles').execute({ action: 'reset' })
  assert.equal(reset.ok, true)
  assert.equal(reset.tiers.MEDIUM.provider, DEFAULT_TIERS.MEDIUM.provider)
  assert.equal(reset.tiers.HIGH.provider, 'prov-x', 'reset 回落 cordis 基底而非内置默认')
})

await testAsync('settings 接线：taskbook/spawn 的档位跟随设置实时变化', async () => {
  const { ctx, tools } = fakeCtx({ settings: fakeSettings() })
  apply(ctx, {})
  await settle()
  const tb = await tools.get('agent_taskbook').execute({ role: 'executor', task: 'x' })
  assert.equal(tb.tier, 'MEDIUM')
  assert.equal(tb.provider, DEFAULT_TIERS.MEDIUM.provider)
  const set = await tools.get('agent_roles').execute({ action: 'set', tier: 'MEDIUM', provider: 'other-prov', model: 'other-model' })
  assert.equal(set.ok, true)
  const dry = await tools.get('agent_spawn').execute({ role: 'executor', task: 'x', dryRun: true })
  assert.equal(dry.provider, 'other-prov')
  assert.equal(dry.model, 'other-model')
})

await testAsync('workspace 挂接：服务经深度解析可达时 spawn 自动挂分组（ctx.get 字符串不可用的回归门）', async () => {
  const attached = []
  const fakeWs = { id: 'ws-1', title: 'deepsek_harness', attachSession: async (sid) => { attached.push(sid) } }
  const registry = {
    resolveByPath: async (p) => (String(p).endsWith('deepsek_harness') ? fakeWs : undefined),
    create: async () => fakeWs,
  }
  const { ctx, tools } = fakeCtx({ workspaceRegistry: registry })
  apply(ctx, {})
  const r = await tools.get('agent_spawn').execute(
    { role: 'explore', task: '找 X', cwd: 'D:\\work\\demo' },
    { agent: null },
  )
  assert.equal(r.ok, true, r.message)
  assert.equal(r.attach?.ok, true, 'attach 必须成功：workspaceRegistry 经 ctx 属性深度解析可达')
  assert.equal(attached.length, 1, 'attachSession 应被调用一次')
})

await testAsync('workspace 挂接（2026-09-14 时机勘误）：apply 时服务未就绪、用时才就绪也能挂上（惰性解析回归门）', async () => {
  const attached = []
  const fakeWs = { id: 'ws-real', title: 'deepsek_harness', attachSession: async (sid) => { attached.push(sid) } }
  const registry = {
    resolveByPath: async (p) => (String(p).endsWith('deepsek_harness') ? fakeWs : undefined),
    create: async () => fakeWs,
  }
  // 还原宿主真实时序（真根因回归门）：WorkspaceRegistry 是异步启动的 Service，
  // 本插件 apply 时它尚未就绪（undefined），真正 spawn 时才就绪。构造器一次性
  // 解析的旧实现会把 undefined 永久缓存 → 本用例必红；惰性 getter 用时解析 → 绿。
  // （服务名勘误勘误：'workspace' 只是 storage domain 名，见 dsh-workspace
  // lib/index.js:225 defineDomain；真服务名是 :309 super(ctx, "workspaceRegistry")。）
  const { ctx, tools } = fakeCtx({ workspaceRegistry: undefined })
  apply(ctx, {})
  ctx.workspaceRegistry = registry // 服务后到：宿主 Service 异步 init 完成
  const r = await tools.get('agent_spawn').execute(
    { role: 'explore', task: '找 X', cwd: 'D:\\work\\demo' },
    { agent: null },
  )
  assert.equal(r.ok, true, r.message)
  assert.equal(r.attach?.ok, true, 'attach 必须成功：用时解析应在 spawn 时拿到已就绪的服务')
  assert.equal(r.attach.workspaceId, 'ws-real', '应命中 workspaceRegistry 名下注册的服务')
  assert.equal(attached.length, 1, 'attachSession 应被调用一次')
})

// ── 宿主 schema 子集守卫：additionalProperties 必须是布尔 ─────────────────
// 宿主 dsh-tools 的 assertSupportedJsonSchema 只接受 additionalProperties: boolean；
// 对象形式（additionalProperties: { type: 'string' }）会让整个插件树启动失败
// （2026-09-12 实证：tierSources 曾以此炸掉 profile boot）。此测试永久拦截该类问题。
await testAsync('宿主 schema 子集守卫：全部工具的 additionalProperties 均为布尔', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, {})
  assert.equal(tools.size >= 3, true, `应注册至少 3 个工具，实际 ${tools.size}`)
  const walk = (node, path, violations) => {
    if (node === null || typeof node !== 'object') return
    if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties = ${JSON.stringify(node.additionalProperties)}`)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const [propName, propSchema] of Object.entries(value)) walk(propSchema, `${path}.properties.${propName}`, violations)
      } else if (['items', 'additionalProperties'].includes(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (typeof value.type === 'string' || value.properties || value.items || value.oneOf) walk(value, `${path}.${key}`, violations)
      } else if (key === 'oneOf' && Array.isArray(value)) {
        value.forEach((sub, i) => walk(sub, `${path}.oneOf[${i}]`, violations))
      }
    }
  }
  for (const [name, def] of tools) {
    const violations = []
    walk(def.parameters, `${name}.parameters`, violations)
    walk(def.output?.schema, `${name}.output.schema`, violations)
    assert.deepEqual(violations, [], `${name} 存在不被宿主支持的 schema 片段`)
  }
})

// ── 设置卡数据端点（lib/http-config.js，浏览器半的读写面） ────────────────
function fakeReq({ method = 'GET', body = undefined, remote = '127.0.0.1', origin = null, host = '127.0.0.1:3080' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
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
  const res = { statusCode: 0, headers: null, bodyText: '' }
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers }
  res.end = (payload) => { res.bodyText = payload }
  res.json = () => JSON.parse(res.bodyText)
  return res
}

async function testEndpoint(title, fn) {
  const { ctx } = fakeCtx({ settings: fakeSettings() })
  const tiersApi = createTiersApi(ctx, resolveTierTable({ HIGH: { provider: 'prov-x', model: 'model-x' } }))
  const catalogRef = { data: { 'prov-x': ['model-a', 'model-b'] } }
  const handler = createConfigHandler({ tiersApi, loadCatalog: async () => catalogRef.data })
  try {
    await fn(handler, catalogRef)
    passed += 1
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
  }
}

await testEndpoint('端点 GET：回 tiers/base/sources/settingsAvailable/catalog 全量状态', async (handler) => {
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.settingsAvailable, true)
  assert.equal(body.tiers.HIGH.provider, 'prov-x')
  assert.equal(body.base.HIGH.provider, 'prov-x')
  assert.equal(body.sources.LOW, 'cordis 配置基底')
  assert.deepEqual(body.catalog['prov-x'], ['model-a', 'model-b'], '模型目录须随 GET 下发（设置卡下拉同源数据）')
})

await testEndpoint('端点 PATCH：改档 → 状态即时更新；回位与全清两条路都通', async (handler) => {
  const set = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { tier: 'MEDIUM', provider: 'glm-pro', model: 'glm-5.3' } }), set)
  assert.equal(set.statusCode, 200)
  const after = set.json()
  assert.equal(after.tiers.MEDIUM.provider, 'glm-pro')
  assert.equal(after.sources.MEDIUM, '设置（用户层覆盖）')

  const resetOne = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { reset: 'medium' } }), resetOne)
  assert.equal(resetOne.json().tiers.MEDIUM.provider, DEFAULT_TIERS.MEDIUM.provider)

  const setLow = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { tier: 'LOW', provider: 'p1', model: 'm1' } }), setLow)
  assert.equal(setLow.json().tiers.LOW.provider, 'p1')
  const resetAll = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { resetAll: true } }), resetAll)
  const final = resetAll.json()
  assert.equal(final.tiers.LOW.provider, DEFAULT_TIERS.LOW.provider)
  assert.equal(final.sources.LOW, 'cordis 配置基底')
})

await testEndpoint('端点 PATCH：非法形状/未知档位大声 400，不写坏状态', async (handler) => {
  const cases = [
    { body: { tier: 'ULTRA', provider: 'p', model: 'm' } },
    { body: { tier: 'LOW', provider: '', model: 'm' } },
    { body: { foo: 1 } },
    { body: [1, 2] },
    { body: 'not json' },
  ]
  for (const c of cases) {
    const res = fakeRes()
    await handler(fakeReq({ method: 'PATCH', body: c.body }), res)
    assert.equal(res.statusCode, 400, `应 400：${JSON.stringify(c.body)}`)
    assert.ok(typeof res.json().error === 'string' && res.json().error !== '')
  }
  const check = fakeRes()
  await handler(fakeReq(), check)
  assert.equal(check.json().tiers.HIGH.provider, 'prov-x', '失败的 PATCH 不得改状态')
})

await testEndpoint('端点防护：非回环 403；Origin 与 Host 不一致 403；其他方法 405', async (handler) => {
  const remote = fakeRes()
  await handler(fakeReq({ remote: '192.0.2.9' }), remote) // RFC 5737 文档段 IP（TEST-NET-1），非回环语义不变
  assert.equal(remote.statusCode, 403)
  const evil = fakeRes()
  await handler(fakeReq({ origin: 'http://evil.example:3080' }), evil)
  assert.equal(evil.statusCode, 403)
  const put = fakeRes()
  await handler(fakeReq({ method: 'PUT' }), put)
  assert.equal(put.statusCode, 405)
})

await testEndpoint('端点：settings 缺席时 PATCH 报可读错误（degrade 而非 500 崩）', async (handler) => {
  const { ctx } = fakeCtx()
  const tiersApi = createTiersApi(ctx, resolveTierTable(undefined))
  const bare = createConfigHandler({ tiersApi })
  const res = fakeRes()
  await bare(fakeReq({ method: 'PATCH', body: { tier: 'LOW', provider: 'p', model: 'm' } }), res)
  assert.equal(res.statusCode, 400)
  assert.ok(res.json().error.includes('设置服务不可用'))
  const get = fakeRes()
  await bare(fakeReq(), get)
  assert.equal(get.statusCode, 200)
  assert.equal(get.json().settingsAvailable, false, 'GET 仍可读（回落 cordis 配置）')
})

// ── 新宿主（0.1.7+）settings forms 形态：describe/update/mutate 路径 ───────
/** 假 SettingsForms：单个 entry（ns=dsh-agents）的 config + revision，可注入一次冲突。 */
function fakeSettingsForms({ tiers = { HIGH: { provider: 'prov-x', model: 'model-x' } }, conflictOnce = false } = {}) {
  let value = { tiers }
  let revision = 1
  let conflictPending = conflictOnce
  const calls = { update: [], mutate: [], configure: [] }
  const conflict = () => { const e = new Error('settings conflict'); e.code = 'SETTINGS_CONFLICT'; return e }
  return {
    calls,
    describe: () => [{ ns: 'dsh-agents', autoGenerate: true, schema: null, value, revision, applies: 'live' }],
    configure: (presentation) => { calls.configure.push(presentation); return () => {} },
    update: async (ns, patch, expectedRevision) => {
      calls.update.push({ ns, patch, expectedRevision })
      if (conflictPending) { conflictPending = false; revision += 1; throw conflict() }
      if (ns !== 'dsh-agents') throw new Error(`unexpected ns ${ns}`)
      if (expectedRevision !== undefined && expectedRevision !== revision) { revision += 1; throw conflict() }
      value = { ...value, ...patch, tiers: { ...(value.tiers ?? {}), ...(patch.tiers ?? {}) } }
      revision += 1
    },
    mutate: async (ns, ops, expectedRevision) => {
      calls.mutate.push({ ns, ops, expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== revision) { revision += 1; throw conflict() }
      for (const op of ops) if (op.op === 'unset' && op.path.join('.') === 'tiers') delete value.tiers
      revision += 1
    },
  }
}

/** 用 forms 形态假宿主跑一个端点用例（回传 settings 以便断言写入调用）。 */
async function testEndpointForms(title, fn, options) {
  const settings = fakeSettingsForms(options)
  const { ctx } = fakeCtx({ settings })
  const tiersApi = createTiersApi(ctx, resolveTierTable({ HIGH: { provider: 'prov-x', model: 'model-x' } }))
  const handler = createConfigHandler({ tiersApi })
  try {
    await fn(handler, tiersApi, settings)
    passed += 1
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
  }
}

await testEndpointForms('新宿主 forms：hasScope=true（可写）、无 register 作用域、抑制宿主自动页、档位从 entry config 读出', async (handler, tiersApi, settings) => {
  assert.equal(tiersApi.hasScope(), true, 'describe+update 可用即视为可写（否则设置卡降级为不可用）')
  assert.equal(tiersApi.getScope(), null, '新宿主没有 register 作用域')
  assert.deepEqual(settings.calls.configure.at(-1), { auto: false }, '自带设置卡 → 必须抑制宿主为同一 entry 自动生成的表单页')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.settingsAvailable, true)
  assert.equal(body.tiers.HIGH.provider, 'prov-x')
  assert.equal(body.sources.HIGH, 'cordis 配置基底')
})

await testEndpointForms('新宿主 forms：PATCH 改档走 update(ns, patch, revision) 并即时回读', async (handler, tiersApi, settings) => {
  const res = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { tier: 'MEDIUM', provider: 'glm-pro', model: 'glm-5.3' } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().tiers.MEDIUM.provider, 'glm-pro')
  const last = settings.calls.update.at(-1)
  assert.equal(last.ns, 'dsh-agents')
  assert.equal(last.patch.tiers.MEDIUM.model, 'glm-5.3')
  assert.equal(typeof last.expectedRevision, 'number', '必须带 describe() 的 revision 做乐观并发')
})

await testEndpointForms('新宿主 forms：revision 冲突自动重试一次后成功（不落 400）', async (handler, tiersApi, settings) => {
  const res = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { tier: 'LOW', provider: 'p2', model: 'm2' } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(settings.calls.update.length, 2, '首次 SETTINGS_CONFLICT 应重试而不是失败')
  assert.equal(res.json().tiers.LOW.model, 'm2')
}, { conflictOnce: true })

await testEndpointForms('新宿主 forms：resetAll 走 mutate(unset tiers) 回落 bundle 基底', async (handler, tiersApi, settings) => {
  const res = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { resetAll: true } }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(settings.calls.mutate.at(-1).ops, [{ op: 'unset', path: ['tiers'] }])
  assert.equal(res.json().tiers.HIGH.provider, 'prov-x', 'unset 后回落 cordis 基底')
})

// ── 忠实宿主假体：复刻 0.1.7 的「写单档」真实语义（2026-10-06 活体实测） ──
/**
 * 与上面 fakeSettingsForms 的关键差别（后者是**空门**，永远测不出回退缺陷）：
 *  ① describe() 同时回报两个层——`value` = **loader 内存快照**（entry.fiber.config /
 *     entry.options.config）、`user` = **profile patch 覆盖层**（宿主每次 describe
 *     从磁盘重读，见 dsh-config-editor/lib/index.js:45 `loadProfileDirectory`）；
 *  ② update() 的**合并基底是 loader 快照**（dsh-settings/lib/index.js:471-472
 *     `mergeLayers(current = entry.options.config, input)`），不是上一次写入的结果；
 *     落盘写回的是整个 volatile 投影（dsh-config-editor/lib/index.js:104）；
 *  ③ 写盘**不刷新 loader 快照**——2026-10-06 活体实测：PATCH 改 LOW 后 MEDIUM 从
 *     磁盘层 deepseek-official/deepseek-flash 被写回内存层 openrouter-ai/…（陈旧值）。
 * 这三个语义合起来才是「保存一档 → 另外两档掉回基底」的成因；缺①或②的假体测不出。
 *
 * ⚠️ `patch` 参数 = profile patch 的 **entry config 层**（形如 `{ tiers: {…} }`），
 * 不是裸 tiers 映射。传错形状会让 `entry.user.tiers === undefined`，插件静默按「无用户层」
 * 处理 —— 整个回归锁会变成空门（2026-10-06 本席实测踩中，靠 tests/probe-tier-save-loss.mjs
 * 的 plumbing 自检抓出）。故 hostTierFixture 里加了形状自检断言，见下。
 */
function hostTierFake({ memory, patch = {} } = {}) {
  const clone = (v) => JSON.parse(JSON.stringify(v))
  let revision = 1
  let memorySnapshot = clone({ tiers: memory }) // loader 内存快照：写盘后不刷新
  let patchLayer = clone(patch) // profile patch 覆盖层：每次 describe 从磁盘重读
  const calls = { update: [] }
  const deepMerge = (under, over) => {
    if (under === null || typeof under !== 'object' || Array.isArray(under)) return over
    if (over === null || typeof over !== 'object' || Array.isArray(over)) return over
    const out = { ...under }
    for (const [key, value] of Object.entries(over)) {
      Object.defineProperty(out, key, {
        value: Object.hasOwn(out, key) ? deepMerge(out[key], value) : value,
        enumerable: true, configurable: true, writable: true,
      })
    }
    return out
  }
  return {
    calls,
    /** 测试钩子：直接改「磁盘层」，模拟别处（其它会话/手改/上一次写入）留下的用户层覆盖。 */
    setPatchLayer: (next) => { patchLayer = clone(next); revision += 1 },
    patchLayer: () => clone(patchLayer),
    describe: () => [{
      ns: 'dsh-agents', autoGenerate: false, schema: null, applies: 'live', revision,
      value: clone(memorySnapshot), // 陈旧层
      user: clone(patchLayer), // 新鲜层
    }],
    configure: () => () => {},
    update: async (ns, input, expectedRevision) => {
      calls.update.push({ ns, input, expectedRevision })
      if (ns !== 'dsh-agents') throw new Error(`unexpected ns ${ns}`)
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const e = new Error('settings conflict'); e.code = 'SETTINGS_CONFLICT'; throw e
      }
      patchLayer = deepMerge(memorySnapshot, input) // 合并基底 = 陈旧的 loader 快照
      revision += 1 // ⚠️ memorySnapshot 故意不刷新（复刻实测到的非热更新）
    },
    mutate: async () => { throw new Error('hostTierFake.mutate 未实现（本组用例不走 resetAll）') },
  }
}

/** 三档全给、值互不相同——单元素断言分不出「整份写回」与「只写一档」，必须三档同时可判。 */
const HOST_MEMORY_TIERS = {
  LOW: { provider: 'mem-low', model: 'mem-low-m' },
  MEDIUM: { provider: 'mem-med', model: 'mem-med-m' },
  HIGH: { provider: 'mem-high', model: 'mem-high-m' },
}
const HOST_PATCH_TIERS = {
  LOW: { provider: 'user-low', model: 'user-low-m' },
  MEDIUM: { provider: 'user-med', model: 'user-med-m' },
  HIGH: { provider: 'user-high', model: 'user-high-m' },
}

/** 造一套「内存层陈旧 + 磁盘层已有三档用户覆盖」的宿主，返回端点与写日志。 */
function hostTierFixture() {
  const settings = hostTierFake({ memory: HOST_MEMORY_TIERS, patch: { tiers: HOST_PATCH_TIERS } })
  // plumbing 自检：假体的两层形状不对 → 直接炸，绝不让回归锁退化成空门。
  const probe = settings.describe()[0]
  assert.equal(probe.value?.tiers?.MEDIUM?.model, 'mem-med-m', '假体 value 层（陈旧）形状不对')
  assert.equal(probe.user?.tiers?.MEDIUM?.model, 'user-med-m', '假体 user 层（新鲜）形状不对——传错 patch 形状会让回归锁变空门')
  const { ctx } = fakeCtx({ settings })
  const tiersApi = createTiersApi(ctx, resolveTierTable(HOST_MEMORY_TIERS))
  const handler = createConfigHandler({ tiersApi, loadCatalog: async () => ({ 'new-low': ['new-low-m'] }) })
  return { settings, tiersApi, handler }
}

await testAsync('负向自测（假体有牙）：按修复前的载荷形状（整份取陈旧 value 层）写单档 → 必须复现另两档回退', async () => {
  const { settings } = hostTierFixture()
  const stale = settings.describe()[0].value.tiers // 修复前 writeTiers 读的就是这一层
  await settings.update('dsh-agents', { tiers: { ...stale, LOW: { provider: 'new-low', model: 'new-low-m' } } }, 1)
  const after = settings.patchLayer().tiers
  assert.equal(after.MEDIUM.model, 'mem-med-m', '陈旧层写回必须把 MEDIUM 打回内存层值——假体若无此行为则回归锁是空门')
  assert.equal(after.HIGH.model, 'mem-high-m', '同一断言对 HIGH 也必须成立')
})

await testAsync('回归锁：writeTiers 写单档不得丢掉其余档的既有用户层值（文件:行号 settings.js:226-230）', async () => {
  const { settings, tiersApi } = hostTierFixture()
  await tiersApi.writeTiers({ LOW: { provider: 'new-low', model: 'new-low-m' } })
  const after = settings.patchLayer().tiers
  assert.equal(after.LOW.model, 'new-low-m', '被改的那一档必须落库')
  assert.equal(after.MEDIUM.model, 'user-med-m', '未被改的 MEDIUM 必须保留用户层值，不许被陈旧内存层 mem-med-m 覆盖')
  assert.equal(after.HIGH.model, 'user-high-m', '未被改的 HIGH 必须保留用户层值，不许被陈旧内存层 mem-high-m 覆盖')
})

await testAsync('回归锁（端点层）：PATCH 改一档后其余两档仍报「用户层覆盖」（用户原话症状的可判定判据）', async () => {
  const { handler } = hostTierFixture()
  const res = fakeRes()
  await handler(fakeReq({ method: 'PATCH', body: { tier: 'LOW', provider: 'new-low', model: 'new-low-m' } }), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.tiers.LOW.model, 'new-low-m')
  assert.equal(body.tiers.MEDIUM.model, 'user-med-m', 'PATCH 回读里 MEDIUM 不得掉回基底')
  assert.equal(body.tiers.HIGH.model, 'user-high-m', 'PATCH 回读里 HIGH 不得掉回基底')
  assert.equal(body.sources.MEDIUM, '设置（用户层覆盖）', 'MEDIUM 值 ≠ 基底 → 必须报「用户层覆盖」而不是「cordis 配置基底」')
  assert.equal(body.sources.HIGH, '设置（用户层覆盖）', 'HIGH 同理')
})

await testAsync('回归锁：连续写两档时先前写入的那一档不被后一次写回退（陈旧层只在首次暴露）', async () => {
  const { settings, tiersApi } = hostTierFixture()
  await tiersApi.writeTiers({ LOW: { provider: 'new-low', model: 'new-low-m' } })
  await tiersApi.writeTiers({ HIGH: { provider: 'new-high', model: 'new-high-m' } })
  const after = settings.patchLayer().tiers
  assert.equal(after.LOW.model, 'new-low-m', '第二次写 HIGH 不得把第一次写的 LOW 打回去')
  assert.equal(after.HIGH.model, 'new-high-m')
  assert.equal(after.MEDIUM.model, 'user-med-m', '两次写都不许动未被触及的 MEDIUM')
})

test('entry Config：导出 schema 且三档标 volatile（否则宿主 describe() 直接跳过本 entry）', () => {
  assert.ok(Config !== undefined, 'lib/index.js 必须导出 Config（宿主从 entry 模块读取）')
  assert.equal(Config, CONFIG_SCHEMA, 'index.js 的 Config 必须就是 settings.js 的 CONFIG_SCHEMA')
  const tiers = CONFIG_SCHEMA.dict?.tiers
  assert.ok(tiers, 'Config 必须声明 tiers')
  for (const tier of ['LOW', 'MEDIUM', 'HIGH']) {
    assert.equal(tiers.dict?.[tier]?.meta?.volatile, true, `${tier} 必须标 volatile（describe() 只回报 volatile 字段）`)
    assert.ok(tiers.dict[tier].dict?.provider && tiers.dict[tier].dict?.model, `${tier} 必须声明 provider/model`)
  }
  assert.equal(CONFIG_SCHEMA.dict?.allowSpawn?.meta?.volatile, true)
  assert.equal(CONFIG_SCHEMA.dict?.clarifyMode?.meta?.volatile, true)
  // 普通配置也必须声明：schemastery 按 schema 归一 config，漏声明会让这些值丢失
  for (const key of ['roleOverrides', 'defaultPreset', 'agentOutSubdir']) {
    assert.ok(CONFIG_SCHEMA.dict?.[key], `Config 必须声明 ${key}（否则 loader 归一后配置丢失）`)
  }
})

// ── provider 目录解析：两代 settings 形态（旧 get / 新 describe） ─────────
await testAsync('provider 目录：新宿主 forms 形态下 listConfiguredRoutes / resolveProviderForModel 仍可用', async () => {
  const formsSettings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      value: { providers: { 'prov-x': { models: [{ id: 'model-a' }, { id: 'model-b' }] } } },
    }],
    update: async () => {},
  }
  const llm = { listConfigurableProviders: () => [{ provider: 'prov-x', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'prov-x'] }] }
  const catalog = await listConfiguredRoutes({ llm, settings: formsSettings })
  assert.deepEqual(catalog['prov-x'], ['model-a', 'model-b'], '目录必须能从 describe() 读到（否则设置卡下拉为空）')
  assert.equal(await resolveProviderForModel({ llm, settings: formsSettings }, 'model-b'), 'prov-x')
})

await testAsync('provider 目录：旧宿主 get(ns) 路径保持原行为', async () => {
  const legacy = { get: (ns) => (ns === 'llm-pi-ai' ? { providers: { 'p-legacy': { models: [{ id: 'm1' }] } } } : undefined) }
  const llm = { listConfigurableProviders: () => [{ provider: 'p-legacy', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p-legacy'] }] }
  assert.deepEqual((await listConfiguredRoutes({ llm, settings: legacy }))['p-legacy'], ['m1'])
  assert.equal(await resolveProviderForModel({ llm, settings: legacy }, 'm1'), 'p-legacy')
})

await testAsync('provider 目录：settings 无读取面时目录记空列表而不抛错', async () => {
  const llm = { listConfigurableProviders: () => [{ provider: 'p', settingsNs: 'llm-pi-ai', settingsPath: [] }] }
  assert.deepEqual(await listConfiguredRoutes({ llm, settings: {} }), { p: [] }, '读不到配置 → 该 provider 记空列表（不抛错）')
  assert.equal(await resolveProviderForModel({ llm, settings: {} }, 'm'), undefined)
})

// ── 浏览器半（lib/client.js）：模块加载器工厂格式 + 设置卡注册 ─────────────
test('client 半：__ModuleLoader__ 工厂格式、无 import、注册 settings.plugins.tab 卡', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.ok(src.startsWith("window.__ModuleLoader__.load({ id: 'dsh-agents', factory:"), '必须是懒 CJS 工厂格式（宿主 bundle 纯度门）')
  assert.ok(src.includes("require('react')"), 'React 经宿主 seed 模块 require')
  assert.ok(!/\bimport\s[\s"'{]/.test(src), '浏览器半不得有 import 语句')
  assert.ok(src.includes("name: 'settings.plugins.tab'"), '必须注册进宿主 0.1.7+ 的插件设置页槽位（settings.plugins.tab；旧 settings.plugin.item 已不存在）')
  assert.ok(src.includes("id: 'dsh-agents'"), 'tab id 必须等于 settings 命名空间')
  assert.ok(/label:\s*\(\)\s*=>/.test(src), 'list 槽位必须给 label 才会在「插件」页出现行标题')
  assert.ok(src.includes("inject: ['slots']"))
  assert.ok(src.includes(CONFIG_ENDPOINT), '卡片数据面必须指向插件端点')
  assert.ok(src.includes("createElement('select'"), 'provider/model 必须用下拉（与输入框模型选择同源）')
  assert.doesNotThrow(() => new Function(src), 'client.js 语法必须可编译')
})

test('package.json：dsh.client 声明 + exports ./client 指向存在的文件', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  assert.equal(pkg.dsh?.client?.platform, 'web', '必须有 dsh.client.platform=web（否则宿主引导图不含本插件的浏览器半）')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins'))
  const clientEntry = pkg.exports?.['./client']
  assert.equal(typeof clientEntry, 'string', 'exports 必须声明 ./client')
  const clientPath = fileURLToPath(new URL(`../${clientEntry.replace(/^\.\//, '')}`, import.meta.url))
  assert.ok(existsSync(clientPath), `client 入口文件必须存在：${clientEntry}`)
})

// ── advisor 服务端（lib/advisor/**：配置/观察器/运行时/投递/存储/端点） ────
// 全部用 await 包装（testAsync）：advisor 侧有同步断言也有异步链路（评审 drain），
// await 对非 Promise 返回值同样成立。
import * as advisorTests from './advisor.test.mjs'
for (const suite of [
  advisorTests.testConfig,
  advisorTests.testDataDir,
  advisorTests.testObserver,
  advisorTests.testObserverIdempotency,
  advisorTests.testRuntime,
  advisorTests.testDelivery,
  advisorTests.testStoreAndApi,
  advisorTests.testSessionStore,
  advisorTests.testPerSessionEndpoint,
  advisorTests.testIntegration,
  // S0 Phase 0 Baseline（advisor V3 节 2 S0）：runtimeSignature 三态锁定 +
  // 新增测试模块（isolation-gate / advisor-llm-replay）的**加载期零副作用**机检。
  // 位置约束：必须排在 testRealDataDirIsolation **之前**——后者是收尾断言，
  // 任何新用例都不得绕到它之后（见下方注释）。
  advisorTests.testV3Baseline,
  // S1a：零依赖只读检索地基（advisor V3 节 2 S1a，AC-2/3/10/11/12/13/14/15/45/refs）
  // 位置约束同上：必须排在 testRealDataDirIsolation **之前**。
  advisorTests.testS1aRetrieval,
  // S2：三层上下文装配 + 规则预筛 + 配置面（advisor V3 节 2 S2，判据 1–16）
  advisorTests.testS2Context,
  // 安全 P0/P1（security-reviewer 2026-10-09 的 PoC：junction / ADS / 大小写 / 8.3 / git env）
  advisorTests.testRetrievalSecurity,
  // B1 第二批修复（code-reviewer P1-1/2/3 + security-reviewer 高优先 P1）
  advisorTests.testB1SecondPass,
  // S3：agentic 工具循环 + 只读 ACI 工具面（advisor V3 节 2 S3，判据 S3-1…S3-13）
  // 位置约束同上：必须排在 testRealDataDirIsolation **之前**。
  advisorTests.testS3ToolLoop,
  // S4：决策判断层——prompt V3 重写（AC-58 五类锚必红 / P0-3 结论前置）+ 冷却分级豁免
  // （X11/AC-33 两条断言）+ 证据下限（AC-30/31/63）+ 可选字段兼容（AC-43/32）。
  // 位置约束同上：必须排在 testRealDataDirIsolation **之前**。
  advisorTests.testS4Decision,
  // B2/B3 修复批（code-P1-1/P1-2 + security-P1-1/P1-2 + P2 择要，判据 FX-1…FX-5）。
  // 位置约束同上：必须排在 testRealDataDirIsolation **之前**。
  advisorTests.testS3FixBatch,
  // B4（S1b）：tree-sitter 符号级（方案 A1）——依赖闸门 / sha256 硬闸门 / 降级路径 / AC-36 符号级闭包。
  // 位置约束：必须排在 testRealDataDirIsolation **之前**；且因本套件会 warm 符号引擎（AST 就绪），
  // 必须排在所有依赖「引擎未就绪 ⇒ 正则降级」文本的既有用例（S2-16 等）之后。
  advisorTests.testB4Symbols,
  // B5（S5）：patchConfig 三段行为等价锁定 + 行为验收族——必须在 testRealDataDirIsolation 之前
  advisorTests.testS5Closeout,
  // 必须最后：它比对的是「模块加载时的真实用户数据目录快照」与「现在」，
  // 只有排在所有 advisor 用例之后才是真正的收尾断言。
  advisorTests.testRealDataDirIsolation,
]) {
  // advisor.test.mjs 用 t(name, fn) 收集用例，这里转成本 run.mjs 的断言器
  const cases = []
  suite((name, fn) => cases.push([name, fn]))
  for (const [name, fn] of cases) {
    await testAsync(`[advisor] ${name}`, fn)
  }
}

// ── 独立门脚本接线（opt-r2 接线批 R2 ④）──────────────────────────────────
// 三个自包含门（body-hash-check / usage-probe --selftest / session-guard --selftest）
// 以子进程接入标准门序列。形态约束（任务书⑤）：门必须「失败即非零退出」的响亮形态，
// 禁静默跳过——spawnSync 启动失败与非零退出都显式入账 failures；子进程输出走 stdio
// inherit 直落控制台（读数行 = 门自己的 [RESULT] 行），不做 pipe 捕获（沙箱 EPERM 纪律）。
// 三门均零 dataDir 写入（body-hash 只读 personas/；两探针 selftest 夹具写 tmpdir 并自清理），
// 不触碰隔离门（tests/isolation-gate.mjs）的快照根。位置约束：advisor 组收尾断言
// testRealDataDirIsolation 之后、汇总之前——非 advisor 用例，不影响其「组内最后」语义。

/** 跑一个独立门脚本：任何非零结局都响亮入账，没有静默路径。失败走 throw——
 * 由 test() 的 catch 记入 failures（与套件既有失败通道同构，账面不虚增 passed）。 */
function gateScript(relPath, args = []) {
  const script = fileURLToPath(new URL(relPath, import.meta.url))
  const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (res.error) throw new Error(`子进程启动失败（${res.error.message}）——门未执行，fail-closed`)
  if (res.status !== 0) throw new Error(`退出码 ${res.status ?? `信号 ${res.signal}`} ≠ 0——门判红，读数见上方子进程输出`)
}

test('独立门 body-hash-check.mjs：真实 personas/*.md 全量 body_hash 一致（真实输入无 workaround）', () => {
  gateScript('../tests/body-hash-check.mjs')
})
test('独立门 body-hash-check --selftest：阳性对照 + 函数级变异 7/7 注入必红（零真实文件写入）', () => {
  gateScript('../tests/body-hash-check.mjs', ['--selftest'])
})
test('独立门 usage-probe --selftest：24 断言（≥3 元素夹具）+ 三类变异必红（缺字段/坏JSON/空usage）', () => {
  gateScript('../tools/usage-probe.mjs', ['--selftest'])
})
test('独立门 session-guard --selftest：夹具 7 元素 4 态 + 注入必红 3/3（变异副本动态 import）', () => {
  gateScript('../tools/session-guard.mjs', ['--selftest'])
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`dsh-agents tests: ${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
// 退出码语义不变（0=全绿 / 1=有失败），但**不再强制终止进程**：
// tests/isolation-gate.mjs 需要 `await import('./run.mjs')` 之后继续拍 after 快照并断言相等。
// 若这里仍用 process.exit(...)，包装器的 after 快照与断言永远不会执行（S0 判据 9 的实现约束）。
// 代价（C-1）：残留句柄（setTimeout / AbortController / 未 dispose 的 runtime 池）不再被强制
// 切断 ⇒ 由隔离门在 after 快照之后**显式收口**，并用「N 秒内退出」的可跑看门狗断言兜住。
process.exitCode = failures.length === 0 ? 0 : 1
