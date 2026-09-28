/**
 * 档位路由——角色档位（LOW/MEDIUM/HIGH）到 DSH provider+model 的解析。
 *
 * 设计依据（两家独立得出同一结论，见 MACAE ADR-003 与 OMC agents/*.md）：
 * 路由/评审/裁决类角色用强模型，执行/检索/转录类角色用快模型——按角色固定
 * 档位而不是全局一刀切，官方口径省 30-50% token。
 *
 * 解析优先级（高 → 低）：
 *   ① 调用期显式 provider+model（agent_spawn 参数，最高优先，需记越档理由）
 *   ② 调用期显式 tier（覆盖角色档位）
 *   ③ 配置 roleOverrides[<roleId>]（cordis.patch.yml，按角色改档）
 *   ④ 配置 tiers[<TIER>]（cordis.patch.yml，档位默认表）
 *   ⑤ 内置默认表（DEFAULT_TIERS）
 *
 * 本模块纯函数为主（便于直跑测试）；只有 resolveProviderForModel 需要宿主
 * 的 llm/settings 服务（按模型名反查所属 provider，与 GUI 模型选择框同源）。
 */
import { normalizeTier, TIERS } from './roles.js'
import { settingsValueReader } from './settings-compat.js'

/**
 * 内置默认档位表（本机 settings.yaml 里确实配置的 provider+model）。
 * ⚠️ 不是「最优模型」的断言，而是按通道成本/能力梯度选的可跑默认值；
 * 换档直接改 cordis.patch.yml 的 config.tiers，不必改代码。
 */
export const DEFAULT_TIERS = {
  LOW: { provider: 'deepseek', model: 'deepseek-flash' },
  MEDIUM: { provider: 'glm-pro', model: 'glm-5.3-flash' },
  HIGH: { provider: 'deepseek', model: 'deepseek-v4-pro' },
}

/** 档位设计意图（写进任务书与 agent_roles 输出，让调用方知道为什么这么配）。 */
export const TIER_INTENT = {
  LOW: '低复杂度：检索、定位、文档、批量转录等窄任务（快而便宜）',
  MEDIUM: '标准复杂度：实现、调试、测试、设计、数据、QA、提交等主力工作',
  HIGH: '高复杂度：需求分析、规划、架构、代码/安全/计划评审等需要长链条推理与可靠结构化输出',
}

/** 校验 {provider, model} 二元组；不合法抛错（配置错要大声失败，不静默兜底）。 */
function assertRoute(route, where) {
  if (route === null || typeof route !== 'object') {
    throw new Error(`dsh-agents: ${where} 必须是 { provider, model } 对象`)
  }
  const provider = String(route.provider ?? '').trim()
  const model = String(route.model ?? '').trim()
  if (provider === '' || model === '') {
    throw new Error(`dsh-agents: ${where} 的 provider 与 model 都必须是非空字符串`)
  }
  return { provider, model }
}

/**
 * 解析插件配置里的档位表（缺省项回落内置默认）。
 * @param {object} rawTiers - config.tiers（部分给出即可）
 * @returns {Record<string, {provider:string, model:string}>}
 */
export function resolveTierTable(rawTiers) {
  const table = {}
  for (const tier of TIERS) {
    const configured = rawTiers !== null && typeof rawTiers === 'object' ? rawTiers[tier] : undefined
    table[tier] = configured === undefined
      ? { ...DEFAULT_TIERS[tier] }
      : assertRoute(configured, `config.tiers.${tier}`)
  }
  // 未知档位键 = 拼写错误配置，直接报错（避免"改了没生效"的黑盒）
  for (const key of Object.keys(rawTiers ?? {})) {
    if (!TIERS.includes(String(key).toUpperCase())) {
      throw new Error(`dsh-agents: config.tiers 含未知档位 "${key}"（合法值：${TIERS.join(' / ')}）`)
    }
  }
  return table
}

/**
 * 解析按角色覆盖表；roleId 必须存在（防拼错静默失效）。
 * @param {object} rawOverrides - config.roleOverrides
 * @param {(id:string)=>boolean} exists - 角色存在性判定（注入以便测试）
 * @returns {Record<string, {provider:string, model:string}>}
 */
export function resolveRoleOverrides(rawOverrides, exists) {
  const out = {}
  if (rawOverrides === null || rawOverrides === undefined) return out
  if (typeof rawOverrides !== 'object') throw new Error('dsh-agents: config.roleOverrides 必须是对象')
  for (const [roleId, route] of Object.entries(rawOverrides)) {
    if (!exists(roleId)) throw new Error(`dsh-agents: config.roleOverrides 含未知角色 "${roleId}"`)
    out[roleId] = assertRoute(route, `config.roleOverrides.${roleId}`)
  }
  return out
}

/**
 * 为角色解析实际使用的档位与模型路由。
 *
 * @param {object} input
 * @param {object} input.role - 角色定义（roles.js 条目）
 * @param {object} input.tierTable - resolveTierTable 的结果
 * @param {object} [input.roleOverrides] - resolveRoleOverrides 的结果
 * @param {string} [input.tier] - 调用期显式档位（覆盖角色档位）
 * @param {string} [input.model] - 调用期显式模型
 * @param {string} [input.provider] - 调用期显式 provider
 * @returns {{tier:string, provider:string|null, model:string|null, source:string, roleTier:string, overridden:boolean}}
 *   source ∈ explicit-route | explicit-tier | role-override | tier-default
 *   provider/model 为 null 表示"未指定"（调用方后续按模型名解析或继承发起会话）
 */
export function resolveRoute({ role, tierTable, roleOverrides = {}, tier, model, provider }) {
  const explicitModel = model === undefined ? '' : String(model).trim()
  const explicitProvider = provider === undefined ? '' : String(provider).trim()
  const explicitTier = tier === undefined || tier === null || String(tier).trim() === ''
    ? null
    : normalizeTier(tier)
  if (tier !== undefined && tier !== null && String(tier).trim() !== '' && explicitTier === null) {
    throw new Error(`dsh-agents: 未知档位 "${tier}"（合法值：${TIERS.join(' / ')}，也接受别名 haiku/sonnet/opus）`)
  }

  // ① 显式 provider+model：完全接管（tier 仅作记录）
  if (explicitModel !== '' || explicitProvider !== '') {
    if (explicitModel === '' || explicitProvider === '') {
      // 只给一半：provider 缺 → 由调用方按模型名解析（见 spawn.js），这里如实标注
      return {
        tier: explicitTier ?? role.tier,
        provider: explicitProvider === '' ? null : explicitProvider,
        model: explicitModel === '' ? null : explicitModel,
        source: 'explicit-route',
        roleTier: role.tier,
        overridden: true,
      }
    }
    return {
      tier: explicitTier ?? role.tier,
      provider: explicitProvider,
      model: explicitModel,
      source: 'explicit-route',
      roleTier: role.tier,
      overridden: explicitTier !== null ? explicitTier !== role.tier : true,
    }
  }

  // ② / ③ / ④ 档位定档
  const effectiveTier = explicitTier ?? role.tier
  const source = explicitTier !== null
    ? 'explicit-tier'
    : (roleOverrides[role.id] !== undefined ? 'role-override' : 'tier-default')
  const route = roleOverrides[role.id] !== undefined && explicitTier === null
    ? roleOverrides[role.id]
    : tierTable[effectiveTier]
  return {
    tier: effectiveTier,
    provider: route.provider,
    model: route.model,
    source,
    roleTier: role.tier,
    overridden: effectiveTier !== role.tier,
  }
}

/**
 * 按模型名反查所属 provider——与 GUI 模型选择框同源（settings 的 provider
 * 模型目录）。用于「只显式给了 model 没给 provider」的情况：以前只换 model
 * 不换 provider 会把模型发给不支持的接口报 INVALID_REQUEST。
 *
 * @param {object} deps - { llm, settings }（缺任一 = 无法解析，返回 undefined）
 * @param {string} model
 * @returns {Promise<string|undefined>} provider id，解析不到 undefined
 */
export async function resolveProviderForModel({ llm, settings }, model) {
  const wanted = String(model ?? '').trim()
  if (wanted === '' || !llm || !settings) return undefined
  const listProviders = typeof llm.listConfigurableProviders === 'function'
    ? () => llm.listConfigurableProviders()
    : null
  if (listProviders === null) return undefined
  // 宿主 0.1.7 起 settings 换成 forms 形态（旧 get(ns) 已移除）——两代形态自适应；
  // 直连 get 会抛 TypeError，使整个 provider 反查静默失效（2026-09-28 实证）。
  const readNs = settingsValueReader(settings)
  try {
    for (const entry of listProviders()) {
      let profile
      try {
        const value = readNs(entry.settingsNs)
        profile = value !== undefined && Array.isArray(entry.settingsPath) && entry.settingsPath.length > 0
          ? getPath(value, entry.settingsPath)
          : value
      } catch { continue /* 该 provider 配置读不到：跳过，不影响其他 provider */ }
      // settingsPath 可能指到 providers 层或单个 provider 配置层，两种都兼容
      const rawModels = profile !== undefined && Array.isArray(profile.models)
        ? profile.models
        : Array.isArray(profile?.[entry.provider]?.models)
          ? profile[entry.provider].models
          : []
      if (rawModels.some((m) => String(m?.id ?? '') === wanted)) return entry.provider
    }
  } catch { /* 目录整体读取失败 = 解析不到（调用方退回继承并发提示） */ }
  return undefined
}

/** 取对象路径值（本地实现，避免跨模块耦合）。 */
function getPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/**
 * 过滤出「可用」的 provider 目录（设置卡下拉数据源）：
 *  - 只留有模型目录的 provider（没配模型 = 下拉也没东西可选）；
 *  - activeProviders 给出时（llm.listProviders() 的已注册适配器 id 列表），
 *    只留其中的——声明了路由但没配适配器/key 的不算可用；
 *  - activeProviders 传 null = 无法判定适配器状态，保留全部非空项（降级不误杀）。
 * 当前已保存的 provider 不在过滤结果里也不影响：客户端 Picker 会置顶保留现值。
 */
export function filterUsableCatalog(catalog, activeProviders) {
  const out = {}
  let active = null
  if (activeProviders !== null && activeProviders !== undefined) {
    active = activeProviders instanceof Set ? activeProviders : new Set(activeProviders)
  }
  for (const [provider, models] of Object.entries(catalog ?? {})) {
    if (!Array.isArray(models) || models.length === 0) continue
    if (active !== null && !active.has(provider)) continue
    out[provider] = models
  }
  return out
}

/**
 * 列出现有 provider 目录中「模型 id → provider」映射（agent_roles 体检用）。
 * @param {{llm?:object, settings?:object}} deps
 * @returns {Promise<Record<string,string[]>>} provider → 模型 id 列表
 */
export async function listConfiguredRoutes({ llm, settings }) {
  const out = {}
  if (!llm || !settings || typeof llm.listConfigurableProviders !== 'function') return out
  // 同上：两代 settings 形态自适应（新宿主的 describe() 索引只建一次）。
  const readNs = settingsValueReader(settings)
  try {
    for (const entry of llm.listConfigurableProviders()) {
      try {
        const value = readNs(entry.settingsNs)
        const profile = value !== undefined && Array.isArray(entry.settingsPath) && entry.settingsPath.length > 0
          ? getPath(value, entry.settingsPath)
          : value
        const rawModels = profile !== undefined && Array.isArray(profile.models)
          ? profile.models
          : Array.isArray(profile?.[entry.provider]?.models)
            ? profile[entry.provider].models
            : []
        out[entry.provider] = rawModels.map((m) => String(m?.id ?? '')).filter((id) => id !== '')
      } catch { continue /* 单个 provider 读不到：跳过 */ }
    }
  } catch { /* 目录整体不可读：返回已收集到的部分 */ }
  return out
}
