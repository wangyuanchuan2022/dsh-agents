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
import { createTiersApi, CONFIG_SCHEMA } from '../lib/settings.js'
import { CONFIG_ENDPOINT, createConfigHandler } from '../lib/http-config.js'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
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
test('任务书含七节 + 工具映射，且钉死档位与模型', () => {
  const role = getRole('code-reviewer')
  const route = resolveRoute({ role, tierTable: resolveTierTable(undefined) })
  const persona = loadPersona(role)
  const text = composeTaskbook({
    role, persona, route, tierIntent: TIER_INTENT[route.tier], task: '审查 dsh-agents 的 lib/spawn.js',
    clarifyMode: 'interactive', evidencePath: 'D:\\tmp\\review.md', organizer: 'session-abc', cwd: 'D:\\tmp',
  })
  for (const section of ['## 一、角色卡', '## 二、职责与边界', '## 三、人格细则', '## 四、本次任务', '## 五、交付与验收', '## 六、澄清模式', '## 七、汇报与回收核对', '## 八、Claude Code → DSH 工具映射']) {
    assert.ok(text.includes(section), `缺小节 ${section}`)
  }
  assert.ok(text.includes('**HIGH**'))
  assert.ok(text.includes(DEFAULT_TIERS.HIGH.model))
  assert.ok(text.includes('**只读顾问**'), '只读角色必须标注只读边界')
  assert.ok(text.includes('双条件，缺一即未完成'))
  assert.ok(text.includes('D:\\tmp\\review.md'))
  assert.ok(text.includes('session-abc'))
  assert.ok(text.includes('lsp_diagnostics'), '工具映射表须列出 Claude 专属工具')
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

test('IMP-26a ② 澄清超时口径字面一致：生成面与模板正本同为 5 分钟（单测钉住两边）', () => {
  const genSrc = readFileSync(fileURLToPath(new URL('../lib/taskbook.js', import.meta.url)), 'utf8')
  const docSrc = readFileSync(fileURLToPath(new URL('../docs/task-brief-v3.md', import.meta.url)), 'utf8')
  const genMatch = /超过\s*(\d+)\s*分钟无回音/.exec(genSrc)
  const docMatch = /超时 <N=(\d+)> 分钟/.exec(docSrc)
  assert.ok(genMatch, '生成面须含「超过 N 分钟无回音」字面')
  assert.ok(docMatch, '正本须含「超时 <N=x> 分钟」占位')
  assert.equal(genMatch[1], docMatch[1], `生成面（${genMatch[1]} 分钟）与正本（${docMatch[1]} 分钟）口径必须一致（DP-1 P1-3）`)
  assert.equal(genMatch[1], '5', '统一取值=5（对齐正本；如改值须两侧同改并同步本断言）')
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

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`dsh-agents tests: ${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
