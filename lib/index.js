/**
 * dsh-agents — DSH 侧「23 个专职角色 × 模型档位路由」插件。
 *
 * 移植自 oh-my-claudecode（OMC，MIT）的 agents 体系：19 个专职角色各自钉死
 * 一个模型档位（haiku/sonnet/opus → LOW/MEDIUM/HIGH），按角色复杂度分配模型，
 * 而不是整场会话一刀切。DSH 侧实现为三个工具：
 *
 *   agent_roles    角色目录 / 档位表 / 路由体检
 *   agent_taskbook 只合成任务书（不派活）+ 派活前置三问
 *   agent_spawn    一步派活：按角色创建子会话（注入人格 + 任务书 + 档位模型）
 *
 * 设计边界（与既有插件不重叠）：
 *   - 不实现 wake/status/list（那是 de_session 的职责，本插件只做「按角色创建」）；
 *   - 档位映射、角色覆盖、澄清模式、预设都在 cordis.patch.yml 里可配；
 *   - 人格正文放 personas/<id>.md，缺失时退化为角色摘要模式（不报错）。
 */
import { getRole, filterRoles, roleIds, ROLES, LANES, TIERS, normalizeTier } from './roles.js'
import { TIER_INTENT, resolveTierTable, resolveRoleOverrides, resolveRoute, resolveProviderForModel, listConfiguredRoutes, filterUsableCatalog } from './routing.js'
import { loadPersona, listPersonaFiles } from './persona.js'
import { composeTaskbook, preflight, stamp, dedupeEvidencePath } from './taskbook.js'
import { RoleSpawner, listPresets } from './spawn.js'
import { ToolscopeStore } from './toolscope.js'
import { installToolscopePipeline } from './toolscope-pipeline.js'
import { loadRosterData, POLICY_DIR, checkHostVersion } from './toolscope-roster.js'
import { installAgentReply, spawnDecisionAuditWriter, REPLY_AUDIT_FILENAME, REPLY_DEFAULTS } from './agent-reply.js'
import { createTiersApi, CONFIG_SCHEMA } from './settings.js'
import { CONFIG_ENDPOINT, createConfigHandler } from './http-config.js'
import { installAdvisor, resolveAdvisorConfig, resolveAdvisorDataDir, ADVISOR_TRACE_ENV } from './advisor/index.js'
import { join } from 'node:path'

export const name = 'dsh-agents'

/**
 * entry Config schema（宿主 0.1.7+ 从 entry 模块的 Config 导出读取）：
 * 三档 tiers 标 volatile，宿主 describe() 才会把本 entry 的 live 值回报给设置页
 * （没有 schema 或没有 volatile 字段的 entry 会被 dsh-settings 直接跳过）。
 */
export const Config = CONFIG_SCHEMA

/**
 * 需要声明的服务：tools（注册工具）+ agents（创建会话）。
 * 其余（llm/settings/workspaceRegistry/agentPresets）是**可选**服务，
 * 用 ctx.get 动态读取——旧快照没有它们时插件仍能加载（降级为不解析 provider、
 * 不挂预设），符合「可选服务用 ctx.get」的宿主约定。
 */
export const inject = ['tools', 'agents']

const CLARIFY_MODES = ['interactive', 'autonomous']

/** S1.5（R-13）：单授工具名形状——MCP 最终注册名 `mcp__server__tool` 或常规工具名。 */
const ALLOW_TOOLS_NAME_RE = /^(?:mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+|[A-Za-z0-9][A-Za-z0-9_.-]*)$/

/**
 * S1.5（R-13）：`agent_spawn.allowTools` 的 spawn 期校验（**只做形状**，去重保序）。
 *
 * 为何不做存在性校验：单授名的宇宙（restrictableNames）在会话 created 期才可得，
 * spawn 期没有宇宙（KB-6）。未知名不在此拒绝——created 期「不生效 + 告警」，
 * 且 deny 收缩照常应用（fail-closed，AC1.5-3 钉死「不得 fail-open」）。
 *
 * @param {unknown} value - args.allowTools 原值（undefined/null=未单授）
 * @returns {{ok:true, value:string[]}|{ok:false, message:string}}
 */
function normalizeAllowTools(value) {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'allowTools 必须是数组（每项为该会话额外单授的工具最终注册名，如 mcp__rea__rea_call）' }
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, message: 'allowTools 的元素必须是字符串（工具最终注册名）' }
    const name = item.trim()
    if (name === '') return { ok: false, message: 'allowTools 不允许空字符串（写工具最终注册名，如 mcp__rea__rea_call）' }
    if (!ALLOW_TOOLS_NAME_RE.test(name)) {
      return { ok: false, message: `allowTools 名称形状不合法："${name}"（MCP 名形如 mcp__server__tool；常规工具名只允许字母数字与 _ . -，且不以符号开头）` }
    }
    if (!out.includes(name)) out.push(name) // 去重保序
  }
  return { ok: true, value: out }
}

/**
 * 校验并规范化插件配置（配置错直接抛错——静默兜底会让"改了没生效"变黑盒）。
 * @param {object} raw - cordis.patch.yml 的 config
 */
export function resolveConfig(raw = {}) {
  const value = raw === null || typeof raw !== 'object' ? {} : raw
  const clarifyMode = value.clarifyMode === undefined ? 'interactive' : String(value.clarifyMode)
  if (!CLARIFY_MODES.includes(clarifyMode)) {
    throw new Error(`dsh-agents: config.clarifyMode 必须是 ${CLARIFY_MODES.join(' | ')}`)
  }
  const defaultPreset = value.defaultPreset === undefined || value.defaultPreset === null || String(value.defaultPreset).trim() === ''
    ? null
    : String(value.defaultPreset).trim()
  if (defaultPreset !== null && !/^[a-z0-9][a-z0-9-]*$/.test(defaultPreset)) {
    throw new Error('dsh-agents: config.defaultPreset 格式不合法（须匹配 [a-z0-9][a-z0-9-]*）')
  }
  // B1-S1（V2-1 用户裁决）：minimal 派活预设，缺省 'minimal'（宿主内置，跨机可用、
  // 不绑本机自建预设名）。存在性校验复用宿主 spawn 链（spawn.js listPresets），
  // 不存在的 id 在 spawn 时报错并列可用清单——这里只做格式守卫。
  const minimalPreset = value.minimalPreset === undefined || value.minimalPreset === null || String(value.minimalPreset).trim() === ''
    ? 'minimal'
    : String(value.minimalPreset).trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(minimalPreset)) {
    throw new Error('dsh-agents: config.minimalPreset 格式不合法（须匹配 [a-z0-9][a-z0-9-]*）')
  }
  const agentOutSubdir = value.agentOutSubdir === undefined ? 'agent-out' : String(value.agentOutSubdir).trim()
  if (agentOutSubdir === '' || /[\\/]/.test(agentOutSubdir)) {
    throw new Error('dsh-agents: config.agentOutSubdir 必须是不含路径分隔符的非空目录名')
  }
  // B1-S3：工具面收缩消融开关（缺省开=用户裁决的基线行为；关=全链 fail-open，
  // spawn role 轨标记文件与 created 管线一并停用——消融实验臂用）。
  const toolscopeEnabled = value.toolscopeEnabled !== false
  // B1-S5 小收口③（V3-2 落点裁决=config 键位）：频控常数运行时用户级可调。
  // 校验纪律与 minimalPreset 同款（fail-loud 抛错，不静默兜底——WakeRateLimiter
  // 构造器内的缺省回落只兜「未传」，不兜「传错」）。
  const num = (key, fallback, label) => {
    if (value[key] === undefined || value[key] === null) return fallback
    const n = Number(value[key])
    if (!Number.isFinite(n) || n <= 0 || (key !== 'replyWakeWindowMs' && !Number.isInteger(n))) {
      throw new Error(`dsh-agents: config.${key} 必须是正${key === 'replyWakeWindowMs' ? '数' : '整数'}（收到 ${JSON.stringify(value[key])}）——${label}`)
    }
    return n
  }
  const replyWakeWindowMs = num('replyWakeWindowMs', REPLY_DEFAULTS.windowMs, '频控滑动窗口毫秒')
  const replyWakeWindowMax = num('replyWakeWindowMax', REPLY_DEFAULTS.windowMax, '频控窗口内唤醒上限')
  const replyWakeBreakAfter = num('replyWakeBreakAfter', REPLY_DEFAULTS.breakAfter, '连续降级熔断阈值')
  return {
    tiers: resolveTierTable(value.tiers),
    roleOverrides: resolveRoleOverrides(value.roleOverrides, (id) => getRole(id) !== undefined),
    defaultPreset,
    minimalPreset,
    clarifyMode,
    agentOutSubdir,
    allowSpawn: value.allowSpawn !== false,
    toolscopeEnabled,
    replyWakeWindowMs,
    replyWakeWindowMax,
    replyWakeBreakAfter,
  }
}

/** 时间锚点（工具输出前置，模型拿它判断新旧）。 */
function fmtNow(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 可选服务读取（cordis 惯例：ctx.<name> 属性访问）。
 * ⚠️ 不要用 ctx.get('settings') 字符串取服务——cordis 的 get 不认字符串服务名，
 * 曾经因此静默拿不到 settings 导致设置卡整条链路失效（2026-09-12 实证）。
 */
function peekService(ctx, name) {
  try { return ctx?.[name] } catch { return undefined }
}

/** root 上下文解析（llm/provider 目录注册在应用根；隔离作用域可能缺目录）。 */
function rootOf(ctx) {
  try { const viaGet = ctx?.get?.('root'); if (viaGet) return viaGet } catch { /* 试下一路 */ }
  try { if (ctx?.root) return ctx.root } catch { /* 试下一路 */ }
  return null
}

/**
 * llm 服务解析（照 dsh-memory-evolve advisor 的 NO_ADAPTER 教训）：llm 适配器
 * 与 configurable-provider 目录都注册在**应用根**上下文；隔离作用域的 ctx.llm
 * 可能解析得到却缺目录（表现为 provider 目录恒空 → 设置卡回退手填）。解析链
 * = root.get('llm') → root.llm → 本 ctx 属性访问兜底。
 */
function resolveLlm(ctx) {
  const root = rootOf(ctx)
  try { const viaRoot = root?.get?.('llm'); if (viaRoot) return viaRoot } catch { /* 试下一路 */ }
  try { if (root?.llm) return root.llm } catch { /* 试下一路 */ }
  return peekService(ctx, 'llm')
}

/** settings 服务同样优先走 root（与 llm 同链；本 ctx 属性访问兜底）。 */
function resolveSettings(ctx) {
  const root = rootOf(ctx)
  try { const viaRoot = root?.get?.('settings'); if (viaRoot) return viaRoot } catch { /* 试下一路 */ }
  try { if (root?.settings) return root.settings } catch { /* 试下一路 */ }
  return peekService(ctx, 'settings')
}

/** 诊断摘要（端点 diag 字段用；一次看清服务解析到哪一层断了）。 */
function serviceDiag(s) {
  if (s === undefined || s === null) return 'missing'
  if (typeof s.listConfigurableProviders === 'function') {
    let n = -1
    try { n = s.listConfigurableProviders().length } catch { n = -1 }
    return `llm-ok(dir=${n})`
  }
  if (typeof s.get === 'function') return 'ok'
  return `type:${typeof s}`
}

function catalogDiag(ctx) {
  return {
    root: rootOf(ctx) ? 'found' : 'none',
    llm: serviceDiag(resolveLlm(ctx)),
    settings: serviceDiag(resolveSettings(ctx)),
  }
}

/** 默认产出路径（组织者回收核对用；调用方给了 evidencePath 则不覆盖）。 */
function defaultEvidencePath(cwd, subdir, roleId) {
  if (!cwd) return null
  const sep = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${subdir}${sep}${roleId}-${stamp()}.md`
}

/**
 * minimal 轨四行 brief（B1 子特性①，裁 4/V2-6）：
 * 任务正文 / 产出落盘路径 / orgId / 完成标准——orgId 单一事实源=派活参数
 * （organizer）；四个字段各占一行，多行正文按调用方原文保留。
 */
function composeMinimalBrief({ task, evidencePath, organizer, acceptance }) {
  const orNone = (value, fallback = '（未指定）') => {
    if (value === null || value === undefined) return fallback
    const trimmed = String(value).trim()
    return trimmed !== '' ? trimmed : fallback
  }
  return [
    `任务：${String(task).trim()}`,
    `产出落盘：${orNone(evidencePath)}`,
    `orgId：${orNone(organizer)}`,
    `完成标准：${orNone(acceptance, '（未指定——完成后如实报告）')}`,
  ].join('\n')
}

/** 角色 + 路由的展示行（agent_roles 与 agent_spawn 复用）。 */
function roleRow(role, route) {
  return {
    id: role.id,
    name: role.name,
    lane: role.lane,
    tier: route.tier,
    defaultTier: role.tier,
    omcModel: role.omcModel,
    level: role.level,
    readonly: role.readonly,
    provider: route.provider,
    model: route.model,
    routeSource: route.source,
    description: role.description,
  }
}

/** 角色列表文本渲染（render 用）。 */
function renderRoles(value) {
  const lines = [`⏰ ${fmtNow(value.now)}`, '']
  if (value.tiers) {
    lines.push('档位路由表：')
    for (const tier of TIERS) {
      const route = value.tiers[tier]
      lines.push(`  ${tier.padEnd(6)} → ${route.provider ?? '(未解析)'} / ${route.model ?? '(未解析)'} ｜ ${TIER_INTENT[tier]}`)
    }
    if (value.routeWarnings?.length) {
      lines.push('', '路由体检告警：')
      for (const w of value.routeWarnings) lines.push(`  - ${w}`)
    }
  }
  if (value.roles?.length) {
    lines.push('', `角色（${value.roles.length}）：`)
    for (const role of value.roles) {
      const flags = [role.readonly ? '只读' : '可写', role.personaInstalled ? `人格 ${role.personaHash}` : '人格未安装']
      lines.push(`  ${role.id.padEnd(20)} ${role.tier.padEnd(6)} ${role.model ?? '(继承)'} ｜ ${role.name} ｜ ${flags.join(' / ')}`)
      lines.push(`    ${role.description}`)
    }
  }
  if (value.role) {
    lines.push(`角色：${value.role.id}（${value.role.name}）`)
    lines.push(`- 档位：${value.role.tier}（角色默认 ${value.role.defaultTier}）→ ${value.role.provider ?? '(未解析)'} / ${value.role.model ?? '(未解析)'}`)
    lines.push(`- 职责：${value.role.mission ?? ''}`)
    lines.push(`- 边界：${value.role.readonly ? '只读顾问（禁改文件）' : '可写实施（限任务范围内）'}`)
    lines.push(`- 人格：${value.role.personaInstalled ? `已安装（sha256:${value.role.personaHash}，${value.role.personaChars} 字符）` : '未安装——角色摘要模式'}`)
  }
  if (value.message) lines.push('', value.message)
  return lines.join('\n')
}

/**
 * 迁移前工具级 description 逐字存档（B2 S1；help 全量的「工具级全文」单源）。
 *
 * 口径：不是从 catalog 行反推、不重写——就是迁移前原文逐字（外部 oracle 由
 * `git show <pre-S1-sha>:lib/index.js` 比对，B2 交付报告留痕）。catalog 行与本
 * 存档构成**双源**，由 `tests/run.mjs` 的 PROMISES 正断言 + 反向漂移门（Q1/Q2）
 * + sha256 fixture（Q3）三方看死：改措辞忘记同步必红。
 */
export const STATIC_ARCHIVE = Object.freeze({
  agent_roles: "角色与档位路由目录（dsh-agents）：列出 23 个专职角色（19 个移植自 oh-my-claudecode，4 个批次3 新建）及其**钉死的模型档位**，或查单个角色的详情，或对档位路由表做体检（配置的 provider/model 是否真的存在）。档位三档 LOW/MEDIUM/HIGH ← haiku/sonnet/opus：检索/文档类走 LOW，实现/调试/测试类走 MEDIUM，需求分析/规划/架构/评审类走 HIGH。派活前先用本工具确认角色 id 与档位，再用 agent_spawn 一步创建角色会话。",
  agent_taskbook: "按角色合成任务书（dsh-agents，**不创建会话**）：输出「角色卡（角色-模型档位）+ 职责边界 + 人格细则 + 任务 + 交付与验收 + 澄清模式与缺省决策表 + 汇报回收」全文，附派活前置三问自检与本次路由解析结果。用途：① 派活前先审任务书；② 需要人工确认或转交他人执行时取全文；③ 想先看档位与模型再决定是否 spawn。要直接派活请用 agent_spawn。",
  agent_spawn: "按角色创建子会话并派发任务书（dsh-agents）：**一步派活**——选角色 → 解析档位模型 → 注入角色人格与任务书 → 创建标准 DSH 会话并立即开跑（等价替用户发消息，会话出现在左侧列表可随时接管）。角色与档位用 agent_roles 查；只想看任务书不派活用 agent_taskbook。默认继承发起会话的 cwd；模型按角色档位钉死（LOW/MEDIUM/HIGH → 见 tiers），可用 tier/model/provider 覆盖但属\"越档\"，返回里会记录理由位。⚠️ 本工具只创建，不负责 wake/status/list（那是 de_session 的职责）。dryRun=true 时只回任务书与路由，不创建会话。",
})

/**
 * 三工具工具级 catalog 行（B2 S1 裁剪对象；≤90 码点硬门，必备安全子串由测试看死）。
 *
 * 原则：常驻字符只为「路由决策」服务——分工互指 / 何时用 / 怎么不踩线；全量
 * 语义走 `agent_roles action='help'`（按需披露）。改措辞不得删必备子串、不得破
 * ≤90，且必须同步 STATIC_ARCHIVE 相关的 PROMISES/Q2 断言语义。
 */
export const CATALOG = Object.freeze({
  agent_roles: "角色与档位路由目录：list/show/tiers/set/reset，LOW/MEDIUM/HIGH 三档；spawn 前先 tiers 核对。全量：action='help'。",
  agent_taskbook: "按角色合成任务书全文，不创建会话（派前审/转交他人取全文）；直接派活用 agent_spawn。全量见 agent_roles action='help'。",
  agent_spawn: "按角色创建子会话并派任务书。只创建：wake/status 走 de_session；预览 dryRun=true。详见 agent_roles action='help'。",
})

/** help 全量的工具级原文段落顺序（渲染与断言共用，防两处各自排序漂移）。 */
const HELP_TOOL_ORDER = ['agent_roles', 'agent_taskbook', 'agent_spawn']

/**
 * help 全量渲染（纯函数，不依赖 ctx/宿主；S2 合同测试与 S3 机测同源）。
 *
 * 输出 = 3 段 STATIC_ARCHIVE 工具级原文（带工具名小标题）+ 活 action 参数表
 * （从当前 definition 现拼：类型 / 必填 / enum 全值 / 当前 description）。
 * 参数表天然不过时：enum 增长直接进 help；catalog 行的静态承诺由 Q2 反向门看管。
 *
 * @param {object} defs - 三个活 definition：{agent_roles, agent_taskbook, agent_spawn}
 * @returns {string} help 全文（塞进既有 message 字段，不扩 output.schema）
 * @throws {Error} defs.agent_roles.parameters.properties.action 缺失（契约破坏大声失败）
 */
export function composeHelp(defs) {
  const actionParam = defs?.agent_roles?.parameters?.properties?.action
  if (actionParam === null || typeof actionParam !== 'object') {
    throw new Error('composeHelp: 缺 defs.agent_roles.parameters.properties.action（help 活参数表来源）')
  }
  const required = Array.isArray(defs.agent_roles.parameters.required) ? defs.agent_roles.parameters.required : []
  const enumValues = Array.isArray(actionParam.enum) ? actionParam.enum : []
  const lines = ["# dsh-agents 三工具全量帮助（agent_roles action='help' 恒定回全量）", '']
  for (const toolName of HELP_TOOL_ORDER) {
    lines.push(`## ${toolName}`, STATIC_ARCHIVE[toolName], '')
  }
  lines.push('## agent_roles.action（活参数表：从当前 definition 现拼）')
  lines.push(`- 类型：${actionParam.type ?? '(未声明)'}${required.includes('action') ? '（必填）' : '（可选）'}`)
  lines.push(`- 枚举：${enumValues.join(' | ') || '(空)'}`)
  lines.push(`- 说明：${actionParam.description ?? ''}`)
  return lines.join('\n')
}

/** 角色目录/档位工具定义。 */
export function rolesTool(ctx, config, tiersApi = null, options = null) {
  const api = tiersApi ?? {
    getTable: () => config.tiers, getScope: () => null, hasScope: () => false,
    getBase: () => config.tiers, sourcesOf: () => ({}),
  }
  /** 观测面审计（R-2/m8 fail-open：审计缺失或抛错绝不影响工具返回）。 */
  const audit = (record) => {
    try {
      options?.getDecisionAudit?.()?.(record)
    } catch (e) {
      console.error('[dsh-agents] help 审计写入失败（fail-open）:', e?.message ?? e)
    }
  }
  // const def（不是匿名 return）：help 分支要读「当前活 definition」现拼 action
  // 参数表（同源，禁自比自）；对既有分支语义零影响。
  const def = {
    name: 'agent_roles',
    description: CATALOG.agent_roles,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'tiers', 'set', 'reset', 'help'], description: 'list=列角色（可按 lane/tier 过滤）；show=查单个角色详情（需 role）；tiers=档位路由表 + 体检；set=手动设置某档位的 provider+model（即时生效，写入 Web 设置页同源的设置服务）；reset=清除设置页里的用户覆盖，回落 cordis 配置/内置默认；help=三工具全量帮助' },
        role: { type: 'string', description: 'show 必填：角色 id（如 executor / code-reviewer / explore）' },
        lane: { type: 'string', enum: ['build', 'review', 'domain'], description: 'list 可选：按泳道过滤' },
        tier: { type: 'string', description: 'list 可选：按档位过滤；set 必填：要设置的档位（LOW/MEDIUM/HIGH，也接受 haiku/sonnet/opus）' },
        provider: { type: 'string', description: 'set 必填：该档位的 provider 路由 id' },
        model: { type: 'string', description: 'set 必填：该档位的模型 id' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          now: { type: 'integer', description: '当前时间戳（时间锚点）' },
          message: { type: 'string' },
          roles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                lane: { type: 'string' },
                tier: { type: 'string' },
                defaultTier: { type: 'string' },
                omcModel: { type: 'string' },
                level: { type: 'integer' },
                readonly: { type: 'boolean' },
                provider: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                routeSource: { type: 'string' },
                description: { type: 'string' },
                personaInstalled: { type: 'boolean' },
                personaHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['id', 'name', 'lane', 'tier'],
            },
          },
          role: {
            oneOf: [{
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                lane: { type: 'string' },
                tier: { type: 'string' },
                defaultTier: { type: 'string' },
                provider: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                readonly: { type: 'boolean' },
                mission: { type: 'string' },
                personaInstalled: { type: 'boolean' },
                personaHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                personaChars: { type: 'integer' },
              },
              required: ['id', 'tier'],
            }, { type: 'null' }],
          },
          tiers: {
            oneOf: [{
              type: 'object',
              additionalProperties: false,
              properties: {
                LOW: { type: 'object', additionalProperties: true, properties: { provider: { oneOf: [{ type: 'string' }, { type: 'null' }] }, model: { oneOf: [{ type: 'string' }, { type: 'null' }] } } },
                MEDIUM: { type: 'object', additionalProperties: true, properties: { provider: { oneOf: [{ type: 'string' }, { type: 'null' }] }, model: { oneOf: [{ type: 'string' }, { type: 'null' }] } } },
                HIGH: { type: 'object', additionalProperties: true, properties: { provider: { oneOf: [{ type: 'string' }, { type: 'null' }] }, model: { oneOf: [{ type: 'string' }, { type: 'null' }] } } },
              },
            }, { type: 'null' }],
          },
          routeWarnings: { type: 'array', items: { type: 'string' }, description: 'tiers 体检：配置的 provider/model 在现有模型目录中找不到等问题' },
          tierSources: { type: 'object', additionalProperties: true, description: '各档位当前生效来源（值为字符串）：设置（用户层覆盖）/ cordis 配置基底 / 内置默认，键为档位名' },
        },
        required: ['ok', 'now'],
      },
      render: (_args, value) => [{ type: 'text', text: renderRoles(value) }],
    },
    async execute(args) {
      const action = String(args.action ?? '').trim()
      const now = Date.now()
      // B2 S1（R-2/R-7）：help 恒定回三工具全量（3 段迁移前工具级原文 + 活 action
      // 参数表）；承载走既有 message 字段（renderRoles 已消费），不新增参数、不扩 schema。
      if (action === 'help') {
        const helpText = composeHelp({
          agent_roles: def,
          agent_taskbook: taskbookTool(ctx, config, api),
          agent_spawn: spawnTool(ctx, config, null, () => null, api),
        })
        audit({ kind: 'help', tool: 'agent_roles', action: 'help', tools: HELP_TOOL_ORDER.length, helpCodepoints: [...helpText].length })
        return { ok: true, now, message: helpText }
      }
      if (action === 'list') {
        const roles = filterRoles({ lane: args.lane, tier: args.tier }).map((role) => {
          const route = resolveRoute({ role, tierTable: api.getTable(), roleOverrides: config.roleOverrides })
          const persona = loadPersona(role)
          return { ...roleRow(role, route), personaInstalled: persona.installed, personaHash: persona.hash }
        })
        if (roles.length === 0) {
          return { ok: false, now, message: `没有匹配的角色（lane=${args.lane ?? '*'}，tier=${args.tier ?? '*'}）。角色 id：${roleIds().join(', ')}` }
        }
        const installed = roles.filter((r) => r.personaInstalled).length
        return {
          ok: true, now, roles,
          message: `共 ${roles.length} 个角色（已安装人格 ${installed}/${roles.length}）。泳道：${Object.entries(LANES).map(([k, v]) => `${k}=${v}`).join('；')}`,
        }
      }
      if (action === 'show') {
        const role = getRole(args.role)
        if (role === undefined) {
          return { ok: false, now, message: `未知角色 "${args.role ?? ''}"。可用：${roleIds().join(', ')}` }
        }
        const route = resolveRoute({ role, tierTable: api.getTable(), roleOverrides: config.roleOverrides })
        const persona = loadPersona(role)
        return {
          ok: true, now,
          role: {
            ...roleRow(role, route),
            mission: role.mission,
            personaInstalled: persona.installed,
            personaHash: persona.hash,
            personaChars: persona.text.length,
          },
        }
      }
      if (action === 'tiers') {
        const tierTable = api.getTable()
        const catalog = await listConfiguredRoutes({ llm: resolveLlm(ctx), settings: resolveSettings(ctx) })
        const routeWarnings = []
        for (const tier of TIERS) {
          const route = tierTable[tier]
          const models = catalog[route.provider]
          if (models === undefined) {
            routeWarnings.push(`档位 ${tier}：provider "${route.provider}" 不在当前已配置 provider 目录中（模型配置可能拼错或该 provider 未配 key）`)
          } else if (!models.includes(route.model)) {
            routeWarnings.push(`档位 ${tier}：provider "${route.provider}" 的模型目录里没有 "${route.model}"（现有：${models.slice(0, 12).join(', ')}${models.length > 12 ? ' …' : ''}）`)
          }
        }
        for (const [roleId, route] of Object.entries(config.roleOverrides)) {
          const models = catalog[route.provider]
          if (models !== undefined && !models.includes(route.model)) {
            routeWarnings.push(`角色覆盖 ${roleId}：provider "${route.provider}" 的模型目录里没有 "${route.model}"`)
          }
        }
        const tierSources = api.sourcesOf(tierTable)
        if (!api.hasScope()) {
          routeWarnings.push('settings 服务未挂接（旧宿主快照或 schemastery 缺失）：当前仅 cordis 配置生效，set/reset 不可用')
        }
        const personas = listPersonaFiles()
        return {
          ok: true, now, tiers: tierTable, tierSources, routeWarnings,
          message: `档位表见 tiers（来源标注见 tierSources）；人格文件已安装 ${personas.length}/${ROLES.length}${personas.length > 0 ? `（${personas.map((p) => p.id).join(', ')}）` : '（全部角色处于摘要模式）'}；可用 Agent 预设：${listPresets().join(', ') || '（未发现）'}`,
        }
      }
      if (action === 'set') {
        const tier = normalizeTier(args.tier)
        if (tier === null) {
          return { ok: false, now, message: `未知档位 "${args.tier ?? ''}"（合法值：${TIERS.join(' / ')}，也接受别名 haiku/sonnet/opus）` }
        }
        const provider = String(args.provider ?? '').trim()
        const model = String(args.model ?? '').trim()
        if (provider === '' || model === '') {
          return { ok: false, now, message: 'set 需要 provider 与 model 都是非空字符串' }
        }
        const scope = api.getScope()
        if (!scope || typeof scope.update !== 'function') {
          return { ok: false, now, message: '设置服务不可用（缺 settings 服务或 @deepseek-ai/schemastery 依赖）——请改 cordis.patch.yml 的 config.tiers' }
        }
        try {
          // ⚠️ 宿主 scope.update(patch) 只收 patch 一个参数（ns 在 register 时已闭包
          // 绑定）；两参调用会把 'dsh-agents' 字符串当 patch，报「must be a plain object」。
          await scope.update({ tiers: { [tier]: { provider, model } } })
        } catch (e) {
          return { ok: false, now, message: `写入设置失败：${e?.message ?? e}` }
        }
        const table = api.getTable()
        const catalog = await listConfiguredRoutes({ llm: resolveLlm(ctx), settings: resolveSettings(ctx) })
        const routeWarnings = []
        const models = catalog[provider]
        if (models === undefined) routeWarnings.push(`provider "${provider}" 不在当前已配置 provider 目录中`)
        else if (!models.includes(model)) routeWarnings.push(`provider "${provider}" 的模型目录里没有 "${model}"`)
        return {
          ok: true, now, tiers: table, tierSources: api.sourcesOf(table), routeWarnings,
          message: `已写入设置：${tier} → ${provider} / ${model}（即时生效，无需重启）${routeWarnings.length ? '；注意：' + routeWarnings.join('；') : ''}`,
        }
      }
      if (action === 'reset') {
        const scope = api.getScope()
        if (!scope || typeof scope.replace !== 'function') {
          return { ok: false, now, message: '设置服务不可用——当前本就只有 cordis 配置在生效，无需 reset' }
        }
        try {
          await scope.replace({}) // 宿主契约：scope.replace(section)，ns 已闭包绑定
        } catch (e) {
          return { ok: false, now, message: `重置失败：${e?.message ?? e}` }
        }
        return {
          ok: true, now, tiers: api.getTable(), tierSources: api.sourcesOf(api.getTable()),
          message: '已清除设置页的用户层覆盖，回落 cordis 配置基底 / 内置默认。',
        }
      }
      // R-2：未知 action 出口写 tool-error 行（为裁决 1 翻转条件提供分母）。kind 必须
      // 显式给——writer 缺省注入 kind:'spawn'（lib/agent-reply.js:80），record spread 覆盖。
      audit({ kind: 'tool-error', tool: 'agent_roles', reason: 'unknown-action', action })
      return { ok: false, now, message: `未知 action "${action}"（合法：list / show / tiers / set / reset / help）` }
    },
  }
  return def
}

/** 任务书合成工具（不派活）。 */
export function taskbookTool(ctx, config, tiersApi = null) {
  const api = tiersApi ?? { getTable: () => config.tiers, getScope: () => null, hasScope: () => false }
  return {
    name: 'agent_taskbook',
    description: CATALOG.agent_taskbook,
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色 id（必填，如 executor / code-reviewer / explore）' },
        task: { type: 'string', description: '任务正文（必填）：要这个角色做什么，写具体目标与范围' },
        tier: { type: 'string', description: '可选：覆盖角色默认档位（LOW/MEDIUM/HIGH 或 haiku/sonnet/opus）' },
        model: { type: 'string', description: '可选：显式指定模型（需与 provider 搭配或可被自动解析）' },
        provider: { type: 'string', description: '可选：显式指定 provider 路由 id' },
        cwd: { type: 'string', description: '可选：角色会话的工作目录（缺省=发起会话的 cwd）' },
        clarifyMode: { type: 'string', enum: ['interactive', 'autonomous'], description: '可选：澄清模式（缺省取插件配置）。interactive=缺参数按 subagent-clarify 协议问组织者；autonomous=禁提问，按缺省决策表取值' },
        defaults: { type: 'string', description: '可选（autonomous 用）：缺省决策表（markdown 表格）；不给则用内置表' },
        context: { type: 'string', description: '可选：背景/上下文（材料路径、前序结论等）' },
        statusQuo: { type: 'string', description: '可选：现状盘点（v3 §3a，组织者派活前对账结论；非空才渲染为「现状盘点（派活前对账）」小节）' },
        confirmedFindings: { type: 'string', description: '可选：confirmed_findings 已结论清单（v3 §9.1，增量评审轮结构化下发；非空才渲染，自动附否定式指令与免查凭证条款）' },
        organizer: { type: 'string', description: '可选：组织者会话 ID（完成广播 de_broadcast 的直投收件地址，注入任务书 §七；缺失时任务书会附「向派活方索取直投地址」警示）' },
        evidencePath: { type: 'string', description: '可选：产出落盘路径（不给则按 <cwd>/<agentOutSubdir>/<角色id>-<时间戳>.md 生成）' },
        deliverable: { type: 'string', description: '可选：交付要求（覆盖泳道默认值，每行一条）' },
        acceptance: { type: 'string', description: '可选：验收标准（每行一条）' },
      },
      required: ['role', 'task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          now: { type: 'integer' },
          message: { type: 'string' },
          role: { type: 'string' },
          tier: { type: 'string' },
          provider: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          routeSource: { type: 'string' },
          personaInstalled: { type: 'boolean' },
          personaHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          evidencePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          taskbook: { type: 'string', description: '任务书全文（可直接作为 spawn 的首条消息）' },
          preflight: { type: 'array', items: { type: 'string' }, description: '派活前置三问' },
          isolation: { type: 'string', description: '上下文隔离模式：blind（并行盲评席）/ isolated（独立评审验证席）/ shared' },
          isolationLeaks: { type: 'array', items: { type: 'string' }, description: '材料层隔离泄漏机检结果（空=干净）' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'now'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `⏰ ${fmtNow(value.now)}`,
          value.ok ? `角色 ${value.role}（档位 ${value.tier} → ${value.provider ?? '?'} / ${value.model ?? '?'}，定档：${value.routeSource}）` : '',
          value.personaInstalled ? `人格：已安装 sha256:${value.personaHash}` : (value.ok ? '人格：⚠️ 未安装（角色摘要模式）' : ''),
          value.evidencePath ? `产出路径：${value.evidencePath}` : '',
          '',
          '派活前置三问：',
          ...(value.preflight ?? []).map((q) => `  ${q}`),
          value.isolation && value.isolation !== 'shared'
            ? `上下文隔离：**${value.isolation}**${(value.isolationLeaks ?? []).length > 0 ? `（材料机检发现 ${value.isolationLeaks.length} 处泄漏，见下方告警）` : '（材料机检干净；任务书已带隔离契约条款）'}`
            : '',
          ...(value.warnings ?? []).length > 0 ? ['', '告警：', ...(value.warnings ?? []).map((w) => `  - ${w}`)] : [],
          '',
          '任务书全文：',
          '',
          value.taskbook ?? value.message ?? '',
        ].filter((line) => line !== '').join('\n'),
      }],
    },
    async execute(args) {
      const now = Date.now()
      const role = getRole(args.role)
      if (role === undefined) {
        return { ok: false, now, message: `未知角色 "${args.role ?? ''}"。可用：${roleIds().join(', ')}` }
      }
      const task = String(args.task ?? '').trim()
      if (task === '') return { ok: false, now, message: '任务正文为空——请写清要这个角色做什么。' }
      if (args.clarifyMode !== undefined && !CLARIFY_MODES.includes(String(args.clarifyMode))) {
        return { ok: false, now, message: `clarifyMode 必须是 ${CLARIFY_MODES.join(' | ')}` }
      }
      const { route, persona, evidencePath, text, preflightResult } = buildTaskbook({
        ctx, config, role, args, tierTable: api.getTable(),
      })
      return {
        ok: true, now,
        role: role.id, tier: route.tier, provider: route.provider, model: route.model,
        routeSource: route.source, personaInstalled: persona.installed, personaHash: persona.hash,
        evidencePath, taskbook: text,
        preflight: preflightResult.questions, warnings: preflightResult.warnings,
        isolation: preflightResult.isolation.mode,
        isolationLeaks: preflightResult.isolation.leaks.map((l) => `${l.kind}: ${l.hit}`),
      }
    },
  }
}

/**
 * 组装任务书（agent_taskbook 与 agent_spawn 共用同一份逻辑，保证「先看后派」
 * 与「直接派」产出完全一致）。
 */
function buildTaskbook({ config, role, args, cwdHint, tierTable }) {
  const route = resolveRoute({
    role, tierTable: tierTable ?? config.tiers, roleOverrides: config.roleOverrides,
    tier: args.tier, model: args.model, provider: args.provider,
  })
  const persona = loadPersona(role)
  const clarifyMode = args.clarifyMode === undefined ? config.clarifyMode : String(args.clarifyMode)
  if (!CLARIFY_MODES.includes(clarifyMode)) {
    throw new Error(`clarifyMode 必须是 ${CLARIFY_MODES.join(' | ')}`)
  }
  const cwd = args.cwd !== undefined && String(args.cwd).trim() !== '' ? String(args.cwd).trim() : (cwdHint ?? null)
  const evidencePath = args.evidencePath !== undefined && String(args.evidencePath).trim() !== ''
    ? String(args.evidencePath).trim()
    : defaultEvidencePath(cwd, config.agentOutSubdir, role.id)
  // A4：同名去重——目标已存在则追加 -<HHmmss> 后缀，防两份任务书拿到同一路径
  const evidencePathFinal = dedupeEvidencePath(evidencePath)
  const text = composeTaskbook({
    role, persona, route, tierIntent: TIER_INTENT[route.tier], task: args.task,
    clarifyMode, defaults: args.defaults, context: args.context,
    // DP-1 F-3 修复：statusQuo 透传渲染（此前只进机检不进任务书，§3a 通道公开面死路）；
    // DP-1 P1-1 修复：confirmedFindings 透传（v3.1 §9.1 confirmed_findings 块）。
    statusQuo: args.statusQuo, confirmedFindings: args.confirmedFindings,
    deliverable: args.deliverable, acceptance: args.acceptance,
    evidencePath: evidencePathFinal, organizer: args.organizer, cwd,
  })
  const preflightResult = preflight({
    role, task: args.task, route,
    // 隔离机检覆盖**全部会写进任务书的调用方文本**（正文 + 背景 + 现状盘点 + 已结论清单 + 交付/验收 + 缺省决策表）
    extraTexts: [args.context, args.statusQuo, args.confirmedFindings, args.deliverable, args.acceptance, args.defaults],
  })
  return { route, persona, evidencePath: evidencePathFinal, text, preflightResult }
}

/** 一步派活工具。 */
export function spawnTool(ctx, config, spawner, requesterOf, tiersApi = null, toolscope = null, options = null) {
  // OQ#2 后半（S5 收口）：spawn 决策日志并轨 reply-audit.jsonl——与回复审计行
  // 同文件异类（kind:'spawn'），宿主日志面 console.info 保留不动（双面各司其职）。
  const decisionAudit = options?.decisionAudit ?? null
  const api = tiersApi ?? { getTable: () => config.tiers, getScope: () => null, hasScope: () => false }
  return {
    name: 'agent_spawn',
    description: CATALOG.agent_spawn,
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色 id（如 executor / code-reviewer / explore；personaMode=minimal 时可省）' },
        task: { type: 'string', description: '任务正文（必填）：要做什么' },
        personaMode: { type: 'string', enum: ['role', 'minimal'], description: "可选：'minimal'=极简派活（免角色，产四行 brief；provider+model 必填，orgId=organizer 参数）。缺省 'role'" },
        cwd: { type: 'string', description: '可选：工作目录（缺省=继承发起会话的 cwd）' },
        tier: { type: 'string', description: '可选：覆盖角色档位（LOW/MEDIUM/HIGH 或 haiku/sonnet/opus）' },
        model: { type: 'string', description: '可选：显式模型（与角色档位不同时视为越档）' },
        provider: { type: 'string', description: '可选：显式 provider（只在 model 需要特定路由时用）' },
        agentPreset: { type: 'string', description: '可选：Agent 预设 id（缺省=插件配置或 DSH 默认）' },
        clarifyMode: { type: 'string', enum: ['interactive', 'autonomous'], description: '可选：澄清模式（缺省取插件配置）' },
        defaults: { type: 'string', description: '可选（autonomous 用）：缺省决策表' },
        context: { type: 'string', description: '可选：背景/上下文' },
        statusQuo: { type: 'string', description: '可选：现状盘点（v3 §3a 对账结论；非空才渲染为「现状盘点（派活前对账）」小节）' },
        confirmedFindings: { type: 'string', description: '可选：confirmed_findings 已结论清单（v3 §9.1，增量轮结构化下发；非空才渲染）' },
        organizer: { type: 'string', description: '可选：组织者会话 ID（完成广播 de_broadcast 直投收件地址，注入任务书 §七）' },
        evidencePath: { type: 'string', description: '可选：产出落盘路径' },
        deliverable: { type: 'string', description: '可选：交付要求（覆盖泳道默认）' },
        acceptance: { type: 'string', description: '可选：验收标准' },
        tierReason: { type: 'string', description: '可选：越档（显式改档/改模型）的理由，记入返回便于事后审计' },
        allowTools: { type: 'array', items: { type: 'string' }, description: '可选：本会话额外单授的工具最终注册名（如 mcp__rea__rea_call）；role 轨并入放权集，minimal 轨并入预设集；未知名不生效并告警' },
        dryRun: { type: 'boolean', description: '可选：true=只回任务书与路由，不创建会话' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          now: { type: 'integer' },
          message: { type: 'string' },
          dryRun: { type: 'boolean' },
          sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          role: { type: 'string' },
          tier: { type: 'string' },
          provider: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          routeSource: { type: 'string' },
          agentPreset: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          evidencePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          taskbookChars: { type: 'integer' },
          targetSessionId: { oneOf: [{ type: 'string' }, { type: 'null' }, ] },
          attach: { oneOf: [{ type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } }, { type: 'null' }] },
          personaMode: { type: 'string', description: "本次派活形态：'role'（缺省）| 'minimal'" },
          toolscope: {
            oneOf: [{
              type: 'object',
              additionalProperties: true,
              description: 'minimal 轨已落盘的策略文件记录（G10 披露：path/tier/allow/orgId/replyChannel）',
            }, { type: 'null' }],
          },
          notes: { type: 'array', items: { type: 'string' } },
          isolation: { type: 'string', description: '上下文隔离模式：blind（并行盲评席）/ isolated（独立评审验证席）/ shared' },
          isolationLeaks: { type: 'array', items: { type: 'string' }, description: '材料层隔离泄漏机检结果（空=干净）' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'now'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `⏰ ${fmtNow(value.now)}`,
          value.message ?? '',
          value.sessionId ? `会话 ID：${value.sessionId}` : '',
          value.ok && value.personaMode === 'minimal'
            ? `minimal 派活 · provider ${value.provider ?? '继承'} / model ${value.model ?? '继承'} · 预设 ${value.agentPreset ?? '∅'}`
            : '',
          value.ok && value.personaMode !== 'minimal'
            ? `角色 ${value.role} · 档位 ${value.tier} → ${value.provider ?? '继承'} / ${value.model ?? '继承'}（定档：${value.routeSource}）`
            : '',
          value.toolscope ? `策略文件：tier=${value.toolscope.toolPolicy?.tier ?? '?'} allow=${value.toolscope.toolPolicy?.allow?.length ?? 0} 项 · orgId=${value.toolscope.orgId ?? '∅'} → ${value.toolscope.path ?? '?'}` : '',
          value.evidencePath ? `产出路径：${value.evidencePath}` : '',
          ...(value.notes ?? []).map((n) => `· ${n}`),
          value.isolation && value.isolation !== 'shared'
            ? `上下文隔离：**${value.isolation}**${(value.isolationLeaks ?? []).length > 0 ? `（材料机检发现 ${value.isolationLeaks.length} 处泄漏，见告警）` : '（材料机检干净）'}`
            : '',
          ...(value.warnings ?? []).length > 0 ? ['告警：', ...(value.warnings ?? []).map((w) => `  - ${w}`)] : [],
          value.dryRun ? '\n（dryRun：未创建会话；把要用的任务书用 agent_taskbook 取全文）' : '',
        ].filter((line) => line !== '').join('\n'),
      }],
    },
    async execute(args, exec) {
      const now = Date.now()
      // B1-S1：personaMode 路由（'role' 缺省 | 'minimal'）。minimal 旁路角色解析、
      // 人格注入与七节任务书渲染，改产四行 brief（设计 §2.1）；role 路径语义逐字不变。
      const personaMode = args.personaMode === undefined || String(args.personaMode).trim() === ''
        ? 'role'
        : String(args.personaMode).trim()
      if (personaMode !== 'role' && personaMode !== 'minimal') {
        return { ok: false, now, message: `personaMode 只接受 role | minimal（收到 "${args.personaMode}"）` }
      }
      const task = String(args.task ?? '').trim()
      if (task === '') return { ok: false, now, message: '任务正文为空——请写清要做什么。' }
      // S1.5（R-13）：按会话单授工具名单——spawn 期只做形状校验（存在性 created 期才
      // 可得，KB-6）；两轨都吃这份名单（role 并放权集 / minimal 并预设集）。
      const allowToolsResult = normalizeAllowTools(args.allowTools)
      if (!allowToolsResult.ok) return { ok: false, now, personaMode, message: allowToolsResult.message }
      const allowTools = allowToolsResult.value
      const requester = requesterOf?.(exec) ?? null

      // ── minimal 轨（B1 子特性①，§2.1/裁 4）────────────────────────────────
      if (personaMode === 'minimal') {
        // M9：minimal 旁路档位路由 ⇒ provider+model 必填，缺即拒（无任何回落链，
        // 承 advisor「模型完全手动指定、无兜底」同款精神）。
        const providerMin = String(args.provider ?? '').trim()
        const modelMin = String(args.model ?? '').trim()
        if (providerMin === '' || modelMin === '') {
          return { ok: false, now, personaMode, message: 'personaMode=minimal 需要 provider+model 显式指定（minimal 旁路档位路由后无任何模型回落链，缺即拒）。' }
        }
        // orgId 单一事实源＝派活参数（V2-6）；缺省 null（brief 渲染「未指定」）。
        const orgId = String(args.organizer ?? '').trim() || null
        const cwdMin = args.cwd !== undefined && String(args.cwd).trim() !== ''
          ? String(args.cwd).trim()
          : (requester?.session?.header?.cwd ?? null)
        const evidencePathMin = dedupeEvidencePath(
          args.evidencePath !== undefined && String(args.evidencePath).trim() !== ''
            ? String(args.evidencePath).trim()
            : defaultEvidencePath(cwdMin, config.agentOutSubdir, 'minimal'),
        )
        // 预设路由（AC1-2/V2-1 用户裁决）：显式 agentPreset > config.minimalPreset
        //（缺省 'minimal'，宿主内置、跨机可用）；存在性校验复用宿主 spawn 链
        //（spawn.js listPresets 报错并列可用清单），不自制白名单。
        const presetMin = args.agentPreset !== undefined && String(args.agentPreset).trim() !== ''
          ? String(args.agentPreset).trim()
          : config.minimalPreset ?? 'minimal'
        const brief = composeMinimalBrief({ task, evidencePath: evidencePathMin, organizer: orgId, acceptance: args.acceptance })
        // T2 缓解：spawn 决策日志一行（personaMode 实参等）——console.info 宿主日志面
        // + reply-audit.jsonl 持久审计面（OQ#2 后半并轨，S5 收口）。
        console.info(`[dsh-agents] spawn 决策：personaMode=minimal preset=${presetMin} provider=${providerMin} model=${modelMin} orgId=${orgId ?? '∅'} evidencePath=${evidencePathMin ?? '∅'}`)
        decisionAudit?.({ personaMode, preset: presetMin, provider: providerMin, model: modelMin, orgId, evidencePath: evidencePathMin ?? null, dryRun: args.dryRun === true })
        // brief 仅四行：role 轨专用参数带了也会被丢弃——显式披露，不静默吞。
        const droppedParams = ['context', 'statusQuo', 'confirmedFindings', 'deliverable', 'defaults']
          .filter((key) => args[key] !== undefined && String(args[key]).trim() !== '')
        const droppedNote = droppedParams.length > 0 ? [`minimal brief 仅四行，以下参数被忽略：${droppedParams.join(', ')}`] : []
        if (args.dryRun === true) {
          return {
            ok: true, now, dryRun: true, personaMode,
            provider: providerMin, model: modelMin,
            routeSource: 'minimal-bypass',
            agentPreset: presetMin,
            evidencePath: evidencePathMin,
            taskbookChars: brief.length,
            notes: [...droppedNote, `dryRun：未创建会话。minimal brief ${brief.length} 字符：`, brief],
          }
        }
        if (!config.allowSpawn) {
          return { ok: false, now, personaMode, message: '插件配置 allowSpawn=false：已禁用会话创建（改 cordis.patch.yml 后重启 DSH 生效）。' }
        }
        if (toolscope === null) {
          return { ok: false, now, personaMode, message: 'toolscope 存储不可用：minimal 会话必须同事务落策略文件（无策略文件=非法态），已中止。' }
        }
        // G8/裁 4：同事务——beforeCreate 在 agents.create 前同步落盘策略文件，
        // 写失败 fail-fast（不产出「有会话无策略文件」的非法态）；
        // G10：已应用策略经返回体 toolscope 字段披露（调用方可见）。
        const resultMin = await spawner.spawn({
          prompt: brief,
          cwd: args.cwd,
          provider: providerMin,
          model: modelMin,
          agentPreset: presetMin,
          requester,
          beforeCreate: (sessionId) => toolscope.writeMinimal(sessionId, { orgId, extraAllow: allowTools }),
        })
        if (!resultMin.ok) {
          return { ok: false, now, personaMode, message: resultMin.message }
        }
        return {
          ok: true, now, dryRun: false, personaMode,
          sessionId: resultMin.sessionId,
          provider: resultMin.provider, model: resultMin.model,
          routeSource: 'minimal-bypass',
          agentPreset: resultMin.agentPreset,
          evidencePath: evidencePathMin,
          taskbookChars: brief.length,
          toolscope: resultMin.policy ? {
            ...resultMin.policy,
            path: toolscope.path(resultMin.sessionId),
            // S1.5：披露实际生效的工具面名单（含单授并集；additionalProperties:true，不扩 description）
            allowedTools: resultMin.policy.toolPolicy?.allow ?? [],
          } : null,
          attach: resultMin.attach ?? null,
          isolation: 'shared',
          isolationLeaks: [],
          notes: [
            ...(resultMin.notes ?? []),
            ...droppedNote,
            allowTools.length > 0 ? `单授 ${allowTools.length} 项：${allowTools.join(', ')}` : '',
            resultMin.attach?.ok ? `已挂到工作区「${resultMin.attach.workspaceTitle ?? resultMin.attach.workspaceId}」` : (resultMin.attach ? `⚠️ 未挂接工作区分组：${resultMin.attach.error ?? '未知'}` : ''),
            `minimal brief 已作为首条消息派发（${brief.length} 字符，预设 ${resultMin.agentPreset ?? '∅'}）；策略文件同事务落盘（G10 见 toolscope 字段）。`,
          ].filter((line) => line !== ''),
          warnings: [],
        }
      }

      const role = getRole(args.role)
      if (role === undefined) {
        return { ok: false, now, personaMode, message: `未知角色 "${args.role ?? ''}"。可用：${roleIds().join(', ')}` }
      }
      if (args.clarifyMode !== undefined && !CLARIFY_MODES.includes(String(args.clarifyMode))) {
        return { ok: false, now, personaMode, message: `clarifyMode 必须是 ${CLARIFY_MODES.join(' | ')}` }
      }
      if (args.dryRun === true) {
        const built = buildTaskbook({ config, role, args, cwdHint: requester?.session?.header?.cwd ?? null, tierTable: api.getTable() })
        return {
          ok: true, now, dryRun: true, personaMode, role: role.id, tier: built.route.tier,
          provider: built.route.provider, model: built.route.model, routeSource: built.route.source,
          evidencePath: built.evidencePath, taskbookChars: built.text.length,
          isolation: built.preflightResult.isolation.mode,
          isolationLeaks: built.preflightResult.isolation.leaks.map((l) => `${l.kind}: ${l.hit}`),
          notes: [`dryRun：未创建会话。任务书 ${built.text.length} 字符，用 agent_taskbook 可取全文。`],
        }
      }
      if (!config.allowSpawn) {
        return { ok: false, now, personaMode, message: '插件配置 allowSpawn=false：已禁用角色会话创建（改 cordis.patch.yml 后重启 DSH 生效）。' }
      }
      const built = buildTaskbook({ config, role, args, cwdHint: requester?.session?.header?.cwd ?? null, tierTable: api.getTable() })

      // 越档属于有意决策：记入返回，便于事后审计（不阻拦）
      const warnings = [...built.preflightResult.warnings]
      if (built.route.overridden) {
        const reason = args.tierReason !== undefined && String(args.tierReason).trim() !== ''
          ? String(args.tierReason).trim()
          : '（未给 tierReason）'
        warnings.push(`越档：角色 ${role.id} 默认 ${built.route.roleTier}，本次 ${built.route.tier}。理由：${reason}`)
      }
      // 模型可用性提示（不阻断：provider 目录读不到时按继承处理，de_session 同款）。
      // ⚠️ 两段查找：派活是热路径，声明式目录本地可读、零远端调用；只有「档位指向
      // 一个声明式目录里没有的 provider」（典型=动态 provider：xd pool / codex
      // connect）才补全远端目录，避免每次 dispatch 都付 1.5s 级远端延迟。
      let catalog = await listConfiguredRoutes({ llm: resolveLlm(ctx), settings: resolveSettings(ctx), completeDynamic: false })
      if (built.route.provider !== null && catalog[built.route.provider] === undefined) {
        catalog = await listConfiguredRoutes({ llm: resolveLlm(ctx), settings: resolveSettings(ctx) })
      }
      if (built.route.provider !== null && built.route.model !== null) {
        const models = catalog[built.route.provider]
        if (models !== undefined && !models.includes(built.route.model)) {
          warnings.push(`档位 ${built.route.tier} 配置的 ${built.route.provider}/${built.route.model} 不在当前模型目录中——若接口不支持会报 INVALID_REQUEST，请先核对 cordis.patch.yml 的 tiers。`)
        }
      }

      const preset = args.agentPreset !== undefined && String(args.agentPreset).trim() !== ''
        ? String(args.agentPreset).trim()
        : config.defaultPreset ?? undefined
      // T2 缓解：spawn 决策日志一行（personaMode 实参等）——console.info 宿主日志面
      // + reply-audit.jsonl 持久审计面（OQ#2 后半并轨，S5 收口）。
      console.info(`[dsh-agents] spawn 决策：personaMode=role role=${role.id} tier=${built.route.tier} provider=${built.route.provider ?? '继承'} model=${built.route.model ?? '继承'} preset=${preset ?? '∅'} orgId=${String(args.organizer ?? '').trim() || '∅'}`)
      decisionAudit?.({ personaMode, role: role.id, tier: built.route.tier, provider: built.route.provider ?? null, model: built.route.model ?? null, preset: preset ?? null, orgId: String(args.organizer ?? '').trim() || null, dryRun: false })
      // B1-S3：role 轨标记文件（role 默认收缩的激活记录）。与 minimal 轨的 G8
      // fail-fast **不同**——role 收缩是优化不是合法性前提：写失败降级为 fail-open
      // 不收缩（管线读不到文件即跳过），响亮留痕后照常创建会话。
      const roleBeforeCreate = config.toolscopeEnabled === false || toolscope === null
        ? undefined
        : (sessionId) => {
          try {
            return toolscope.writeRole(sessionId, { role: role.id, task, taskbook: built.text, allow: allowTools })
          } catch (error) {
            console.error(`[dsh-agents] role 策略标记写失败（fail-open 不收缩）：${error?.message ?? error}`)
            return null
          }
        }
      const result = await spawner.spawn({
        prompt: built.text,
        cwd: args.cwd,
        provider: built.route.provider ?? undefined,
        model: built.route.model ?? undefined,
        agentPreset: preset,
        requester,
        beforeCreate: roleBeforeCreate,
      })
      if (!result.ok) {
        return { ok: false, now, personaMode, role: role.id, tier: built.route.tier, warnings, message: result.message }
      }
      return {
        ok: true, now, dryRun: false, personaMode,
        sessionId: result.sessionId,
        role: role.id, tier: built.route.tier,
        provider: result.provider, model: result.model,
        routeSource: built.route.source,
        agentPreset: result.agentPreset,
        evidencePath: built.evidencePath,
        taskbookChars: built.text.length,
        // G10 同款披露（S3）：role 轨落盘的策略标记（tier=grant，role/task 同记录）。
        toolscope: result.policy ? {
          ...result.policy,
          path: toolscope?.path?.(result.sessionId) ?? null,
          // S1.5：披露实际生效的工具面名单（含单授并入放权集）
          allowedTools: result.policy.toolPolicy?.allow ?? [],
        } : null,
        attach: result.attach ?? null,
        isolation: built.preflightResult.isolation.mode,
        isolationLeaks: built.preflightResult.isolation.leaks.map((l) => `${l.kind}: ${l.hit}`),
        notes: [
          ...(result.notes ?? []),
          allowTools.length > 0 ? `单授 ${allowTools.length} 项：${allowTools.join(', ')}` : '',
          result.attach?.ok ? `已挂到工作区「${result.attach.workspaceTitle ?? result.attach.workspaceId}」` : (result.attach ? `⚠️ 未挂接工作区分组：${result.attach.error ?? '未知'}` : ''),
          `任务书已作为首条消息派发（${built.text.length} 字符，角色 ${role.id}，档位 ${built.route.tier}）。`,
          '角色回收核对：用 de_session action=status/list 查该会话状态与产出（预期产出路径见 evidencePath）。',
        ].filter((line) => line !== ''),
        warnings,
      }
    },
  }
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 上下文（已注入 tools/agents）
 * @param {object} rawConfig - cordis.patch.yml 的 config
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  // B1-PhaseB 修复①（组织者诊断一）：agentPresets 懒注入缓存。旧路径 spawn.js 的
  // ctx.get 在插件 fiber 活体拿不到该服务（宿主 registry 注册在 loader 侧 fiber），
  // 静默降级出「无预设裸会话」= Phase B 事故形态。settings 同款 ctx.inject 懒接线
  // （lib/settings.js:139 先例；宿主 registry 自身 :491 也用同形态接 settings）：
  // 服务进图后缓存引用；缺失（旧宿主）回调不触发，spawn 侧按「显式预设 fail-fast /
  // role 轨 legacy 降级」处理。静态 inject 会炸老宿主加载（index.js 头部兼容约束），勿用。
  let agentPresetsRef = null
  try {
    ctx.inject?.(['agentPresets'], (pctx) => {
      agentPresetsRef = pctx?.agentPresets ?? (typeof pctx?.get === 'function' ? pctx.get('agentPresets') : null) ?? null
    })
  } catch { /* 注入面缺失：保持 null，spawn 侧解析序兜底（ctx.get/属性） */ }
  const spawner = new RoleSpawner(ctx, {
    resolveProviderForModel: (model) => resolveProviderForModel(
      { llm: resolveLlm(ctx), settings: resolveSettings(ctx) }, model,
    ),
    agentPresetsOf: () => agentPresetsRef,
  })
  /** 取发起会话的 live Agent（工具 execute 的 exec.agent）。 */
  const requesterOf = (exec) => exec?.agent ?? null
  /** 取指定会话的 live Agent（advisor 投递/会话名用；服务晚挂载时惰性解析）。 */
  const getAgent = (sessionId) => {
    try { return ctx?.agents?.get?.(sessionId) ?? undefined } catch { return undefined }
  }

  /**
   * 设置接线（宿主标准写法，对照 dsh-settings 的 installSettingsSection）：
   * ctx.inject(['settings'], cb) 等 settings 服务挂载后在宿主 settings 服务上
   * 注册 'dsh-agents' 命名空间（Web 设置页配置卡的一半：命名空间）。挂不上
   * 时 tiersApi 自动回落 cordis 配置链，插件其余功能不受影响。
   */
  const tiersApi = createTiersApi(ctx, config.tiers)

  /**
   * 设置卡数据端点（配置卡的另一半：浏览器半 lib/client.js 读写的 HTTP 面）。
   * 照 dsh-dafeiyu 模式：webServer.register 挂 exact 路由，effect 里挂以便随
   * 插件卸载。webServer 服务缺失（无 Web profile）时静默跳过——设置卡会显示
   * 「不可用」，工具面不受影响。
   */
  try {
    ctx.inject?.(['webServer'], (httpCtx) => {
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: CONFIG_ENDPOINT,
          handler: createConfigHandler({
            tiersApi,
            // provider→模型目录：与 GUI 输入框模型选择同源，且只留「可用」项——
            // llm.listProviders()（已注册适配器）过滤 + 无模型目录的不列。
            loadCatalog: async () => {
              const llm = resolveLlm(ctx)
              const full = await listConfiguredRoutes({ llm, settings: resolveSettings(ctx) })
              let active = null
              try { active = (llm?.listProviders?.() ?? []).map((p) => p.id) } catch { active = null }
              return filterUsableCatalog(full, active)
            },
            // 诊断：catalog 为空时一眼看清服务解析断在哪层（随 GET 下发）。
            diag: () => catalogDiag(ctx),
          }),
        }),
        'dsh-agents: config endpoint',
      )
    })
  } catch (e) {
    console.error('[dsh-agents] 设置卡端点接线失败（设置卡将显示不可用）：', e?.message ?? e)
  }

  /**
   * advisor（内置顾问，默认关；见 docs/advisor-contract.md）：
   * 读主会话只读快照 → 调**该会话手动指定**的模型评审 → 分级意见投递回主 agent
   * （steer 实时打断 / inject 非唤醒）。数据目录见 resolveAdvisorDataDir
   * （锚在用户级 DSH 目录，**绝不随宿主进程 cwd 漂移**）。
   *
   * 2026-10-04 S2 / U2 起：**启用与模型彻底会话级、无任何兜底路由**——
   * 本段的 `advisorConfig` 只保留「不参与生效判定」的兼容键解析（删掉键会让老
   * 配置 boot 失败，A14/A16），advisor 实际读的是每个会话自己的配置文件。
   *
   * ⚠️ `resolveAdvisorConfig` **故意留在 try 之外**：它对未知 advisor* 键
   * **大声抛错**，那是配置错误的正确暴露面；放进 try 会被 catch 吞掉、变成
   * 「面板显示不可用」这种看不出根因的降级（F-3 改进点 3）。
   *
   * 配置错大声抛错（与 resolveConfig 同纪律）；端点/监听缺失时静默降级——
   * 工具面不受影响。
   */
  const advisorConfig = resolveAdvisorConfig(rawConfig)
  // 数据目录锚定稳定路径（resolveAdvisorDataDir：配置 > env > ~/.dsh/plugins-data/…），
  // 绝不随宿主进程 cwd 漂移；ADVISOR_TRACE_ENV 非空时额外开启 chunk 序列取证。
  const advisorDataDir = resolveAdvisorDataDir(advisorConfig.advisorDataDir)
  let advisorDispose = null
  try {
    const advisor = installAdvisor(ctx, advisorConfig, {
      dataDir: advisorDataDir,
      // llm 必须走 root 解析链（隔离作用域 ctx.llm 可能缺 provider 目录）
      resolveLlm: () => resolveLlm(ctx),
      // 兼容保留：HIGH 档回落已随 S2 取消，installAdvisor **不再消费**这个接线。
      // 留着是为了旧调用点/旧打包产物不必同步改；别误以为改 tiers 会影响 advisor。
      tierTableOf: () => tiersApi.getTable(),
      sessionNameOf: (sessionId) => getAgent(sessionId)?.session?.header?.title ?? null,
      loadCatalog: async () => {
        const llm = resolveLlm(ctx)
        const full = await listConfiguredRoutes({ llm, settings: resolveSettings(ctx) })
        let active = null
        try { active = (llm?.listProviders?.() ?? []).map((p) => p.id) } catch { active = null }
        return filterUsableCatalog(full, active)
      },
    })
    advisorDispose = advisor.dispose
  } catch (e) {
    console.error('[dsh-agents] advisor 装配失败（工具面不受影响，面板将显示不可用）：', e?.message ?? e)
  }

  // B2 S1（R-2/m8）：help / tool-error 审计行并轨 reply-audit.jsonl（writer 在 :1030
  // 创建、晚于本注册）——用**惰性 getter**（execute 期才取值），不改既有创建顺序。
  ctx.effect(() => ctx.tools.register(rolesTool(ctx, config, tiersApi, { getDecisionAudit: () => spawnDecisionAudit })), 'dsh-agents: agent_roles tool')
  ctx.effect(() => ctx.tools.register(taskbookTool(ctx, config, tiersApi)), 'dsh-agents: agent_taskbook tool')
  // B1-S1：per-session 工具面策略存储（minimal 轨同事务落盘）。数据目录与 advisor
  // 同源（resolveAdvisorDataDir 解析链：配置 > DSH_AGENTS_ADVISOR_DATA_DIR > 稳定默认），
  // 文件名独立（<b64>.toolscope.json）防与 advisor 配置/seen 争文件。
  // B1-S3：roster 策略数据（层 1）随插件分发（policies/ 相对本模块解析，装机副本
  // 同构）；加载损坏 fail-open 不静默（error 响亮留痕，role 轨全跳过、minimal 轨
  // 回落 MINIMAL_TOOLSET_FULL 常量兜底）。
  const toolscopeData = config.toolscopeEnabled === false
    ? { roster: null, presets: null, error: null }
    : loadRosterData(POLICY_DIR)
  if (toolscopeData.error) {
    console.error(`[dsh-agents] toolscope 策略数据加载失败（fail-open 不收缩）：${toolscopeData.error}`)
  }
  // B1-S5/M11：插件启动查一次宿主版本（roster pinnedHostVersion vs 运行时读取面）。
  // mismatch → warn（R11：彩排与 AC2 断言重跑）；unknown → info 披露（M11：不告警）。
  if (toolscopeData.base) {
    const hostVerdict = checkHostVersion({ base: toolscopeData.base })
    if (hostVerdict.verdict === 'match') console.info(`[dsh-agents] M11 宿主版本比对一致：${hostVerdict.actual}（${hostVerdict.via}）`)
    else if (hostVerdict.verdict === 'unknown') console.info(`[dsh-agents] M11 宿主版本未知（未找到 ${'@deepseek-ai/dsh'} 的 package.json）——比对跳过（pinned=${hostVerdict.pinned ?? '∅'}）`)
  }
  const toolscopeStore = new ToolscopeStore({ dataDir: advisorDataDir, presets: toolscopeData.presets })
  // OQ#2 后半：spawn 决策审计写入器（与回复审计行同文件异类 kind:'spawn'）。
  const spawnDecisionAudit = spawnDecisionAuditWriter(join(advisorDataDir, REPLY_AUDIT_FILENAME))
  ctx.effect(() => ctx.tools.register(spawnTool(ctx, config, spawner, requesterOf, tiersApi, toolscopeStore, { decisionAudit: spawnDecisionAudit })), 'dsh-agents: agent_spawn tool')
  // B1-S3：restrict 管道（agent/created 挂点，S2 P2 ①格裁决=首步即收缩）。
  // 事件订阅面缺失（假宿主/裁剪快照）时安装器返回 null 并告警——插件其余能力不受影响。
  let toolscopePipeline = null
  try {
    toolscopePipeline = installToolscopePipeline({
      ctx,
      store: toolscopeStore,
      roster: toolscopeData.roster,
      enabled: config.toolscopeEnabled,
    })
  } catch (e) {
    console.error('[dsh-agents] toolscope 管线装配失败（fail-open 不收缩）：', e?.message ?? e)
  }
  if (toolscopePipeline) {
    ctx.effect(() => () => toolscopePipeline.dispose(), 'dsh-agents: dispose toolscope pipeline')
  }
  // B1-S4：极简回复通道（own 层 agent_reply + 内部直投 sendToSession + 模式解析
  // 闸门 + 频控熔断 V3-2 + 审计行 OQ#2 → <dataDir>/reply-audit.jsonl）。与 restrict
  // 管线同一策略文件数据源（orgId 单源）；消融联动 toolscopeEnabled——策略面关=
  // orgId 数据源关，回复通道一并停（G13 #13 全链零行为口径）。事件面缺失（假宿主/
  // 裁剪快照）时安装器返回 null 并告警，插件其余能力不受影响；注册失败 fail-open
  // （会话没有回复工具但照常工作，响亮留痕）。
  let replyPipeline = null
  try {
    replyPipeline = installAgentReply({
      ctx,
      store: toolscopeStore,
      dataDir: advisorDataDir,
      enabled: config.toolscopeEnabled,
      // S5 小收口③：频控常数 config 键位（resolveConfig 已 fail-loud 校验）。
      limiterOptions: { windowMs: config.replyWakeWindowMs, windowMax: config.replyWakeWindowMax, breakAfter: config.replyWakeBreakAfter },
    })
  } catch (e) {
    console.error('[dsh-agents] 回复通道装配失败（minimal 会话无 agent_reply，其余能力不受影响）：', e?.message ?? e)
  }
  if (replyPipeline) {
    ctx.effect(() => () => replyPipeline.dispose(), 'dsh-agents: dispose agent-reply pipeline')
  }
  ctx.effect(() => () => advisorDispose?.(), 'dsh-agents: dispose advisor')
  ctx.effect(() => () => spawner.disposeSpawned(), 'dsh-agents: dispose spawned sessions')
}

export { ROLES, getRole, roleIds, normalizeTier }
