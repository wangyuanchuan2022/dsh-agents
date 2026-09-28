/**
 * dsh-agents — DSH 侧「19 个专职角色 × 模型档位路由」插件。
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
import { createTiersApi, CONFIG_SCHEMA } from './settings.js'
import { CONFIG_ENDPOINT, createConfigHandler } from './http-config.js'

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
  const agentOutSubdir = value.agentOutSubdir === undefined ? 'agent-out' : String(value.agentOutSubdir).trim()
  if (agentOutSubdir === '' || /[\\/]/.test(agentOutSubdir)) {
    throw new Error('dsh-agents: config.agentOutSubdir 必须是不含路径分隔符的非空目录名')
  }
  return {
    tiers: resolveTierTable(value.tiers),
    roleOverrides: resolveRoleOverrides(value.roleOverrides, (id) => getRole(id) !== undefined),
    defaultPreset,
    clarifyMode,
    agentOutSubdir,
    allowSpawn: value.allowSpawn !== false,
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

/** 角色目录/档位工具定义。 */
export function rolesTool(ctx, config, tiersApi = null) {
  const api = tiersApi ?? {
    getTable: () => config.tiers, getScope: () => null, hasScope: () => false,
    getBase: () => config.tiers, sourcesOf: () => ({}),
  }
  return {
    name: 'agent_roles',
    description: '角色与档位路由目录（dsh-agents）：列出 19 个专职角色（移植自 oh-my-claudecode）及其**钉死的模型档位**，或查单个角色的详情，或对档位路由表做体检（配置的 provider/model 是否真的存在）。档位三档 LOW/MEDIUM/HIGH ← haiku/sonnet/opus：检索/文档类走 LOW，实现/调试/测试类走 MEDIUM，需求分析/规划/架构/评审类走 HIGH。派活前先用本工具确认角色 id 与档位，再用 agent_spawn 一步创建角色会话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'tiers', 'set', 'reset'], description: 'list=列角色（可按 lane/tier 过滤）；show=查单个角色详情（需 role）；tiers=档位路由表 + 体检；set=手动设置某档位的 provider+model（即时生效，写入 Web 设置页同源的设置服务）；reset=清除设置页里的用户覆盖，回落 cordis 配置/内置默认' },
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
          message: `档位表见 tiers（来源标注见 tierSources）；人格文件已安装 ${personas.length}/19${personas.length > 0 ? `（${personas.map((p) => p.id).join(', ')}）` : '（全部角色处于摘要模式）'}；可用 Agent 预设：${listPresets().join(', ') || '（未发现）'}`,
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
      return { ok: false, now, message: `未知 action "${action}"（合法：list / show / tiers / set / reset）` }
    },
  }
}

/** 任务书合成工具（不派活）。 */
export function taskbookTool(ctx, config, tiersApi = null) {
  const api = tiersApi ?? { getTable: () => config.tiers, getScope: () => null, hasScope: () => false }
  return {
    name: 'agent_taskbook',
    description: '按角色合成任务书（dsh-agents，**不创建会话**）：输出「角色卡（角色-模型档位）+ 职责边界 + 人格细则 + 任务 + 交付与验收 + 澄清模式与缺省决策表 + 汇报回收 + Claude→DSH 工具映射」全文，附派活前置三问自检与本次路由解析结果。用途：① 派活前先审任务书；② 需要人工确认或转交他人执行时取全文；③ 想先看档位与模型再决定是否 spawn。要直接派活请用 agent_spawn。',
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
    deliverable: args.deliverable, acceptance: args.acceptance,
    evidencePath: evidencePathFinal, organizer: args.organizer, cwd,
  })
  const preflightResult = preflight({ role, task: args.task, route })
  return { route, persona, evidencePath: evidencePathFinal, text, preflightResult }
}

/** 一步派活工具。 */
export function spawnTool(ctx, config, spawner, requesterOf, tiersApi = null) {
  const api = tiersApi ?? { getTable: () => config.tiers, getScope: () => null, hasScope: () => false }
  return {
    name: 'agent_spawn',
    description: '按角色创建子会话并派发任务书（dsh-agents）：**一步派活**——选角色 → 解析档位模型 → 注入角色人格与任务书 → 创建标准 DSH 会话并立即开跑（等价替用户发消息，会话出现在左侧列表可随时接管）。角色与档位用 agent_roles 查；只想看任务书不派活用 agent_taskbook。默认继承发起会话的 cwd；模型按角色档位钉死（LOW/MEDIUM/HIGH → 见 tiers），可用 tier/model/provider 覆盖但属"越档"，返回里会记录理由位。⚠️ 本工具只创建，不负责 wake/status/list（那是 de_session 的职责）。dryRun=true 时只回任务书与路由，不创建会话。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色 id（必填，如 executor / code-reviewer / explore）' },
        task: { type: 'string', description: '任务正文（必填）：要这个角色做什么' },
        cwd: { type: 'string', description: '可选：工作目录（缺省=继承发起会话的 cwd）' },
        tier: { type: 'string', description: '可选：覆盖角色档位（LOW/MEDIUM/HIGH 或 haiku/sonnet/opus）' },
        model: { type: 'string', description: '可选：显式模型（与角色档位不同时视为越档）' },
        provider: { type: 'string', description: '可选：显式 provider（只在 model 需要特定路由时用）' },
        agentPreset: { type: 'string', description: '可选：Agent 预设 id（缺省=插件配置或 DSH 默认）' },
        clarifyMode: { type: 'string', enum: ['interactive', 'autonomous'], description: '可选：澄清模式（缺省取插件配置）' },
        defaults: { type: 'string', description: '可选（autonomous 用）：缺省决策表' },
        context: { type: 'string', description: '可选：背景/上下文' },
        evidencePath: { type: 'string', description: '可选：产出落盘路径' },
        deliverable: { type: 'string', description: '可选：交付要求（覆盖泳道默认）' },
        acceptance: { type: 'string', description: '可选：验收标准' },
        tierReason: { type: 'string', description: '可选：越档（显式改档/改模型）的理由，记入返回便于事后审计' },
        dryRun: { type: 'boolean', description: '可选：true=只回任务书与路由，不创建会话' },
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
          notes: { type: 'array', items: { type: 'string' } },
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
          value.ok ? `角色 ${value.role} · 档位 ${value.tier} → ${value.provider ?? '继承'} / ${value.model ?? '继承'}（定档：${value.routeSource}）` : '',
          value.evidencePath ? `产出路径：${value.evidencePath}` : '',
          ...(value.notes ?? []).map((n) => `· ${n}`),
          ...(value.warnings ?? []).length > 0 ? ['告警：', ...(value.warnings ?? []).map((w) => `  - ${w}`)] : [],
          value.dryRun ? '\n（dryRun：未创建会话；把要用的任务书用 agent_taskbook 取全文）' : '',
        ].filter((line) => line !== '').join('\n'),
      }],
    },
    async execute(args, exec) {
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
      const requester = requesterOf?.(exec) ?? null
      if (args.dryRun === true) {
        const built = buildTaskbook({ config, role, args, cwdHint: requester?.session?.header?.cwd ?? null, tierTable: api.getTable() })
        return {
          ok: true, now, dryRun: true, role: role.id, tier: built.route.tier,
          provider: built.route.provider, model: built.route.model, routeSource: built.route.source,
          evidencePath: built.evidencePath, taskbookChars: built.text.length,
          notes: [`dryRun：未创建会话。任务书 ${built.text.length} 字符，用 agent_taskbook 可取全文。`],
        }
      }
      if (!config.allowSpawn) {
        return { ok: false, now, message: '插件配置 allowSpawn=false：已禁用角色会话创建（改 cordis.patch.yml 后重启 DSH 生效）。' }
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
      // 模型可用性提示（不阻断：provider 目录读不到时按继承处理，de_session 同款）
      const catalog = await listConfiguredRoutes({ llm: resolveLlm(ctx), settings: resolveSettings(ctx) })
      if (built.route.provider !== null && built.route.model !== null) {
        const models = catalog[built.route.provider]
        if (models !== undefined && !models.includes(built.route.model)) {
          warnings.push(`档位 ${built.route.tier} 配置的 ${built.route.provider}/${built.route.model} 不在当前模型目录中——若接口不支持会报 INVALID_REQUEST，请先核对 cordis.patch.yml 的 tiers。`)
        }
      }

      const preset = args.agentPreset !== undefined && String(args.agentPreset).trim() !== ''
        ? String(args.agentPreset).trim()
        : config.defaultPreset ?? undefined
      const result = await spawner.spawn({
        prompt: built.text,
        cwd: args.cwd,
        provider: built.route.provider ?? undefined,
        model: built.route.model ?? undefined,
        agentPreset: preset,
        requester,
      })
      if (!result.ok) {
        return { ok: false, now, role: role.id, tier: built.route.tier, warnings, message: result.message }
      }
      return {
        ok: true, now, dryRun: false,
        sessionId: result.sessionId,
        role: role.id, tier: built.route.tier,
        provider: result.provider, model: result.model,
        routeSource: built.route.source,
        agentPreset: result.agentPreset,
        evidencePath: built.evidencePath,
        taskbookChars: built.text.length,
        attach: result.attach ?? null,
        notes: [
          ...(result.notes ?? []),
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
  const spawner = new RoleSpawner(ctx, {
    resolveProviderForModel: (model) => resolveProviderForModel(
      { llm: resolveLlm(ctx), settings: resolveSettings(ctx) }, model,
    ),
  })
  /** 取发起会话的 live Agent（工具 execute 的 exec.agent）。 */
  const requesterOf = (exec) => exec?.agent ?? null

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

  ctx.effect(() => ctx.tools.register(rolesTool(ctx, config, tiersApi)), 'dsh-agents: agent_roles tool')
  ctx.effect(() => ctx.tools.register(taskbookTool(ctx, config, tiersApi)), 'dsh-agents: agent_taskbook tool')
  ctx.effect(() => ctx.tools.register(spawnTool(ctx, config, spawner, requesterOf, tiersApi)), 'dsh-agents: agent_spawn tool')
  ctx.effect(() => () => spawner.disposeSpawned(), 'dsh-agents: dispose spawned sessions')
}

export { ROLES, getRole, roleIds, normalizeTier }
