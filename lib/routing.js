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
 * 按模型名反查所属 provider——与 GUI 模型选择框**同源**（settings 的声明式
 * provider 模型目录 + 动态 provider 的远端目录）。用于「只显式给了 model 没给
 * provider」的情况：以前只换 model 不换 provider 会把模型发给不支持的接口报
 * INVALID_REQUEST。
 *
 * 两段查找（先说清为什么分两段）：
 *   ① 声明式目录优先：settings 的 `models` 数组本地可读、零远端调用；而
 *      xdpool / codex connect 这类动态 provider 的 listModels 可能触发远端拉取
 *      或凭证刷新（单项超时 1500ms）——能本地命中就不该付这笔延迟；
 *   ② 本地没有才补全动态目录（completeDynamic=true 走与三档下拉、
 *      agent_roles 体检同一条 listConfiguredRoutes 通道）。否则会出现
 *      「下拉里选得到、派活时按模型名解析不到」的新静默不一致。
 * 优先级：声明式 provider 胜出（catalog 插入序，声明式先入，动态后补）。
 *
 * @param {object} deps - { llm, settings, completeDynamic?, dynamicOptions? }
 *   llm 缺失 = 无法解析（返回 undefined）；settings 缺失时跳过 ① 直接走 ②。
 * @param {string} model
 * @returns {Promise<string|undefined>} provider id，解析不到 undefined
 */
export async function resolveProviderForModel({ llm, settings, completeDynamic = true, dynamicOptions } = {}, model) {
  const wanted = String(model ?? '').trim()
  if (wanted === '' || !llm) return undefined
  // ① 声明式目录（本地、零远端调用）
  const declaredOnly = await listConfiguredRoutes({ llm, settings, completeDynamic: false })
  const declaredHit = firstProviderOfModel(declaredOnly, wanted)
  if (declaredHit !== undefined) return declaredHit
  // ② 动态 provider 补全（仅本地未命中时；失败/超时 = 解析不到，不抛给调用方）
  if (!completeDynamic) return undefined
  const full = await listConfiguredRoutes({ llm, settings, completeDynamic: true, dynamicOptions })
  return firstProviderOfModel(full, wanted)
}

/** 在 provider→模型目录里按模型 id 反查 provider（返回首个命中，声明式在前）。 */
function firstProviderOfModel(catalog, wanted) {
  for (const [provider, models] of Object.entries(catalog ?? {})) {
    if (Array.isArray(models) && models.some((id) => String(id ?? '') === wanted)) return provider
  }
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
 * 补齐「动态 provider」的模型目录（xd pool / codex connect 这一类）。
 *
 * 为什么需要这条通道：`listConfigurableProviders()` 只列**声明式** provider
 * （settings 里带 `models` 数组的 pi-ai 路由）。而 xdpool（xdpool /
 * xdpool-global / xdpool-aggregate / xdpool-free）与 dsh-codex-connect
 * （openai-codex）只调 `ctx.llm.registerAdapter()`——它们的模型目录来自远端
 * catalog，settings 里没有 `models` 数组。于是 `listConfiguredRoutes` 对它们
 * 返回空数组，`filterUsableCatalog` 再按「无模型目录不列」整条丢弃，表现为
 * 设置页三档下拉与 agent_roles 体检里**完全看不到**这些 provider。
 *
 * `llm.listModels(provider)` 是宿主通用 API（不依赖声明式目录），能问到任何
 * 已注册 adapter 的模型清单，因此用它补这一块。
 *
 * 三条纪律：
 *   ① **逐个容错**：某个 provider 列不出来（未登录 / 远端不可达 / 宿主抛
 *      INVALID_CATALOG）只跳过它自己，绝不连坐其余目录；
 *   ② **不覆盖声明式 provider**：`declared` 里的 provider 一律由 settings 说了
 *      算——哪怕它读到的是空数组（models 未配好），也不拿远端目录去填。理由：
 *      两种来源混填会让「this provider 到底谁配的」无法回答，而空目录本身是
 *      一条有意义的诊断信号（配置没写全），不该被远端结果掩盖；
 *   ③ **有界并发 + 超时**：xdpool / codex 的 listModels 可能触发远端拉取或
 *      刷新令牌，设置页是同步等它的，因此并发封顶、单项超时，宁可缺项也不
 *      让设置页卡住（缺项的后果是下拉少几行，卡住的后果是整页打不开）。
 *
 * @param {object} llm - 宿主 llm 服务
 * @param {Record<string,string[]>} catalog - 已有的 provider → 模型 id 目录（就地补全）
 * @param {{declared?:Iterable<string>, known?:Iterable<string>, timeoutMs?:number, concurrency?:number}} [options]
 *   declared = 由声明式目录（settings）拥有的 provider id，这些一律跳过；
 *   known = 已知 provider id 全集（默认取 listProviders + listConfigurableProviders）；
 *   timeoutMs 缺省 1500，concurrency 缺省 4。
 * @returns {Promise<Record<string,string[]>>} 补全后的目录（同一对象）
 */
export async function completeDynamicProviders(llm, catalog, options = {}) {
  const out = catalog && typeof catalog === 'object' ? catalog : {}
  if (!llm || typeof llm.listModels !== 'function') return out
  // 1500ms 是「响应速度优先」的取舍（2026-10-29 用户裁定）：正常命中的 provider
  // 不到 1 秒就回来，只有远端卡住的那一个才等满 1500ms 后跳过。
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 1500
  const concurrency = Number.isFinite(options.concurrency) && options.concurrency > 0 ? Math.floor(options.concurrency) : 4
  // ② 声明式 provider 白名单：即使目录值为空，也不许远端覆盖。
  const declared = options.declared === undefined || options.declared === null
    ? new Set()
    : new Set([...options.declared].map((id) => String(id ?? '')))

  // 候选 = 已注册 adapter 具备、且不归声明式所有的 provider。
  let candidates = []
  if (Array.isArray(options.known)) {
    candidates = options.known.map((id) => String(id ?? '')).filter((id) => id !== '')
  } else {
    const ids = []
    try {
      for (const p of llm.listProviders?.() ?? []) ids.push(String(p?.id ?? ''))
    } catch { /* listProviders 不可用：退回声明式目录 */ }
    try {
      for (const entry of llm.listConfigurableProviders?.() ?? []) ids.push(String(entry?.provider ?? ''))
    } catch { /* 同上 */ }
    candidates = ids
  }
  candidates = [...new Set(candidates)].filter((id) => {
    if (id === '' || declared.has(id)) return false
    const existing = out[id]
    return !(Array.isArray(existing) && existing.length > 0)
  })
  if (candidates.length === 0) return out

  const listOne = async (provider) => {
    let timer = null
    try {
      const listing = await Promise.race([
        Promise.resolve().then(() => llm.listModels(provider)),
        // ⚠️ 这个计时器**不能 unref**：挂起的 listModels（远端不响应、令牌刷新卡住）
        // 永远不会 settle，一旦计时器被 unref，事件循环里再无活动句柄，
        // Node 会直接退出、await 永远等不到（2026-10-29 实测：整条链静默 exit 0）。
        // 保留为强引用，宁可多存活一个 timeoutMs 的句柄，也要保证这一项一定会结束。
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        }),
      ])
      const ids = Array.isArray(listing)
        ? listing.map((m) => String(m?.id ?? '')).filter((id) => id !== '')
        : []
      if (ids.length > 0) out[provider] = [...new Set(ids)]
    } catch { /* ① 单项失败不影响其余 provider */ }
    finally { if (timer) clearTimeout(timer) }
  }

  // ③ 有界并发：worker 池而不是 Promise.all 全量并发。
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) {
      const provider = candidates[next++]
      await listOne(provider)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 列出现有 provider 目录中「模型 id → provider」映射（agent_roles 体检用）。
 *
 * 两个来源合流：① 声明式 provider（settings 的 `models` 数组）；
 * ② 动态 provider（只注册 adapter、目录来自远端，经 completeDynamicProviders
 * 补全）。没有 ② 时 xd pool / codex connect 的模型在三档下拉里不可见。
 *
 * @param {{llm?:object, settings?:object, completeDynamic?:boolean, dynamicOptions?:object}} deps
 * @returns {Promise<Record<string,string[]>>} provider → 模型 id 列表
 */
export async function listConfiguredRoutes({ llm, settings, completeDynamic = true, dynamicOptions } = {}) {
  const out = {}
  /** 声明式目录拥有的 provider：这些不参与远端补全（见 ② 条纪律）。 */
  const declared = new Set()
  if (llm && settings && typeof llm.listConfigurableProviders === 'function') {
    // 同上：两代 settings 形态自适应（新宿主的 describe() 索引只建一次）。
    const readNs = settingsValueReader(settings)
    try {
      for (const entry of llm.listConfigurableProviders()) {
        declared.add(String(entry?.provider ?? ''))
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
  }
  if (completeDynamic) {
    try {
      await completeDynamicProviders(llm, out, { ...dynamicOptions, declared })
    } catch { /* 动态补全整体失败：保留声明式目录，不抛给调用方 */ }
  }
  return out
}
