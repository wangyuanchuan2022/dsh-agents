/**
 * 角色会话创建（agent_spawn 的执行体）。
 *
 * 与 dsh-memory-evolve 的 de_session spawn **同一条宿主路径**（照抄其踩坑
 * 修复后的时序，不另辟蹊径）：
 *   ① agents.create 只写 meta.agentPreset 是**不挂预设**的——必须走
 *      agentPresets.resolve + mount 的 setup 回调（否则新会话没有官方工具）；
 *   ② 显式 model 必须自带 provider（按模型名反查 settings 目录），否则会把
 *      模型发给不支持的接口报 INVALID_REQUEST；
 *   ③ seed 事件 seq 必须从 0 开始连续（继承发起会话的 request/header）；
 *   ④ 创建后要 attachWorkspace（左侧「项目」分组），失败要重试并如实回报。
 * 这些结论来自 de_session 的实机记录，本模块按同款顺序重放，避免重踩。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** dsh home（$DSH_HOME 优先，默认 ~/.dsh）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** 扫描一个预设 root 下的合法 preset id（读不到 = 该 root 无预设，不报错）。 */
function scanPresetRoot(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PRESET_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return [] // 目录不可读（权限等）：按"无预设"处理，不阻断创建
  }
}

/**
 * 内置（shipped）预设 root 候选。两种部署布局的落点不同：
 *   - 源码/快照安装：<dsh home>/source/current/apps/cli/config/agent-presets
 *   - npm 全局安装：<...>/node_modules/@deepseek-ai/dsh/config/agent-presets
 * 后者的路径只能从**当前进程入口**反推——本插件跑在 dsh CLI 进程内，
 * process.argv[1] 即 dsh 入口文件，向上找带 config/agent-presets 的包根即可。
 * ⚠️ 2026-09-12 实证：只扫前者时，npm 全局安装下内置的 code/cordis/minimal/
 * standard 全都扫不到，agentPreset="standard" 会被误判「不存在」而拒绝创建。
 * @returns {string[]} 存在的候选 root（不存在的不进列表）
 */
function shippedPresetRootCandidates() {
  const roots = [join(dshHome(), 'source/current/apps/cli/config/agent-presets')]
  const entry = process.argv[1]
  if (entry) {
    let dir = dirname(entry)
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(dir, 'config', 'agent-presets')
      if (existsSync(candidate)) { roots.push(candidate); break }
      const parent = dirname(dir)
      if (parent === dir) break // 到根了
      dir = parent
    }
  }
  return roots
}

/** 可用预设 id（内置 shipped root 优先，user root 同名被 shadow）。 */
export function listPresets() {
  const byId = new Map()
  const roots = [
    ...shippedPresetRootCandidates().map((path) => ({ path, shipped: true })),
    { path: join(dshHome(), '.agent-presets'), shipped: false },
  ]
  for (const root of roots) {
    for (const id of scanPresetRoot(root.path)) if (!byId.has(id)) byId.set(id, true)
  }
  return [...byId.keys()].sort()
}

/** 新会话 ID（与 DSH GUI 同格式）。 */
function newSessionId() {
  return `session-${randomUUID()}`
}

/** 一条用户消息（等价用户发消息；id 稳定唯一，DSH 用它追踪）。 */
function userMessage(text) {
  return { role: 'user', id: randomUUID(), content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } }
}

function errText(err) {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : '未知错误'
}

/** 目录缺失类错误（ENOENT/ENOTDIR）= 确定性失败，重试无意义。 */
function isDirMissingError(err) {
  if (!err) return false
  const code = err.code ?? err.cause?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  return /ENOENT|no such file or directory|not a directory/i.test(errText(err))
}

/** 角色会话创建器：一个实例管插件生命周期内创建的所有会话句柄。 */
export class RoleSpawner {
  /**
   * @param {object} ctx - 已注入 agents 服务的 cordis ctx
   * @param {object} [deps]
   * @param {number[]} [deps.attachDelays] - 挂接工作区的重试延迟（测试传 [0]）
   * @param {(model:string)=>Promise<string|undefined>} [deps.resolveProviderForModel]
   */
  constructor(ctx, deps = {}) {
    this.ctx = ctx
    this.agents = ctx.agents
    this.attachDelays = Array.isArray(deps.attachDelays) && deps.attachDelays.length > 0
      ? deps.attachDelays
      : [0, 300, 1200, 4000]
    this.resolveProvider = deps.resolveProviderForModel ?? null
    /** 本实例创建过的 live 句柄（插件卸载时释放，不动用户自己的会话）。 */
    this.handles = new Map()
  }

  /**
   * 工作区服务（用时惰性解析）。
   *
   * ⚠️ 2026-09-14 真根因勘误（此前两轮修复都未命中）：「workspace 服务不可用」
   * 与**服务名无关**——'workspace' 只是 storage domain 名（dsh-workspace/lib/index.js:225
   * 是 defineDomain({ name: "workspace" })，昨天的「服务名勘误」误读了这一行）；
   * 真 cordis 服务是同文件 :309 `super(ctx, "workspaceRegistry")`。真正的败因是
   * **解析时机**：WorkspaceRegistry 是异步启动的 Service（static inject =
   * storageDomain/sessionPersistence，Service.init 要 open domain + 会话历史引导），
   * 本插件 apply 时它尚未就绪——构造器一次性解析拿到 undefined 后被永久缓存，
   * 之后所有 spawn 都报服务不可用（root 链加深也救不了，因为名字解析对了时机不对）。
   *
   * 解析形态照抄实证可用的 dsh-memory-evolve lib/session-orch.js:230（其 de_session
   * spawn 分组一直正常）：ctx.get('workspaceRegistry') 优先 → ctx.workspaceRegistry
   * 属性兜底；**每次访问重解析**，不缓存（服务重启/换载后自愈）。
   */
  get workspace() {
    try {
      const viaGet = typeof this.ctx?.get === 'function' ? this.ctx.get('workspaceRegistry') : undefined
      if (viaGet) return viaGet
    } catch { /* 试下一路 */ }
    try { return this.ctx?.workspaceRegistry ?? undefined } catch { return undefined }
  }

  /**
   * 创建角色会话并派发任务书。
   * @param {object} input
   * @param {string} input.prompt - 首条消息（角色任务书全文）
   * @param {string} [input.cwd]
   * @param {string} [input.provider]
   * @param {string} [input.model]
   * @param {string} [input.agentPreset]
   * @param {object} [input.requester] - 发起会话的 live Agent（继承配置与 cwd）
   * @returns {Promise<object>} { ok, sessionId?, provider?, model?, agentPreset?, attach?, message }
   */
  async spawn({ prompt, cwd, provider, model, agentPreset, requester } = {}) {
    const text = String(prompt ?? '').trim()
    if (text === '') return { ok: false, message: '任务书为空，未创建会话。' }

    // 预设：显式传入才校验（格式 + roster 存在性）；不传 = 走 DSH 默认预设
    let resolvedPreset = null
    if (agentPreset !== undefined && String(agentPreset).trim() !== '') {
      const presetRaw = String(agentPreset).trim()
      if (!PRESET_ID_RE.test(presetRaw)) {
        return { ok: false, message: `agentPreset "${presetRaw}" 格式不合法（须匹配 [a-z0-9][a-z0-9-]*）` }
      }
      const available = listPresets()
      if (!available.includes(presetRaw)) {
        return {
          ok: false,
          message: `agentPreset "${presetRaw}" 不存在。可用预设：${available.length > 0 ? available.join(', ') : '（未发现任何预设目录）'}`,
        }
      }
      resolvedPreset = presetRaw
    }

    const sessionId = newSessionId()
    const base = requester?.options ?? {}
    const explicitModel = model !== undefined && String(model).trim() !== '' ? String(model).trim() : undefined
    const explicitProvider = provider !== undefined && String(provider).trim() !== '' ? String(provider).trim() : undefined
    const resolvedModel = explicitModel ?? base.model

    let resolvedProvider = explicitProvider
    const notes = []
    if (!resolvedProvider) {
      if (explicitModel && this.resolveProvider) {
        resolvedProvider = await this.resolveProvider(explicitModel)
        if (resolvedProvider) {
          if (resolvedProvider !== base.provider) {
            notes.push(`已按模型名解析 provider=${resolvedProvider}（发起会话为 ${base.provider}）`)
          }
        } else {
          resolvedProvider = base.provider
          notes.push(`⚠️ 模型 ${explicitModel} 不在已配置 provider 的模型目录中，provider 沿用发起会话 ${resolvedProvider ?? '(无)'}——接口不支持时会报 INVALID_REQUEST`)
        }
      } else {
        resolvedProvider = base.provider
      }
    }

    const resolvedCwd = cwd ?? requester?.session?.header?.cwd ?? null

    // 继承发起会话的运行配置（思考等级等）：仅当 provider+model 都一致时整体继承
    const requesterHeader = requester?.session?.requestHeader?.()
    let seed
    if (requesterHeader?.config?.provider && requesterHeader.config.model) {
      const sameConfig = resolvedProvider === requesterHeader.config.provider && resolvedModel === requesterHeader.config.model
      const config = sameConfig
        ? { ...requesterHeader.config }
        : { provider: resolvedProvider ?? requesterHeader.config.provider, model: resolvedModel }
      seed = [{
        type: 'request/header',
        seq: 0, // seed 事件 seq 必须从 0 开始连续（DSH 校验）
        time: Date.now(),
        data: {
          header: {
            ...(sameConfig && requesterHeader.adapterDefaults ? { adapterDefaults: requesterHeader.adapterDefaults } : {}),
            config,
          },
          reason: 'initial',
        },
      }]
    }

    let handle
    // 预设必须经 setup 回调挂载（只写 meta 不挂载 = 新会话缺官方工具）
    let presetSetup = null
    try {
      try {
        const presets = this.ctx?.get?.('agentPresets')
        if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
          const resolved = await presets.resolve(resolvedPreset ?? undefined)
          const presetId = String(resolved?.id ?? '').trim() || resolvedPreset
          presetSetup = { id: presetId, setup: async (agentCtx) => { await presets.mount(agentCtx, presetId) } }
        }
      } catch (presetError) {
        console.warn(`[dsh-agents] agentPresets 解析失败（降级不挂载预设）: ${errText(presetError)}`)
      }

      handle = await this.agents.create({
        sessionId,
        agentOptions: {
          ...(resolvedProvider ? { provider: resolvedProvider } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
        },
        ...(resolvedCwd || resolvedPreset || presetSetup
          ? {
              meta: {
                ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
                ...(presetSetup ? { agentPreset: presetSetup.id } : resolvedPreset ? { agentPreset: resolvedPreset } : {}),
              },
            }
          : {}),
        ...(presetSetup ? { setup: presetSetup.setup } : {}),
        ...(seed ? { seed } : {}),
      })
    } catch (error) {
      return { ok: false, message: `创建会话失败：${errText(error)}` }
    }

    this.handles.set(sessionId, handle)
    const attach = resolvedCwd ? await this.attachWorkspace(sessionId, resolvedCwd) : null

    try {
      handle.agent.followup(userMessage(text))
    } catch (error) {
      return { ok: false, sessionId, message: `会话已创建但任务派发失败：${errText(error)}` }
    }

    return {
      ok: true,
      sessionId,
      provider: resolvedProvider ?? null,
      model: resolvedModel ?? null,
      agentPreset: presetSetup?.id ?? resolvedPreset ?? null,
      attach,
      notes,
      message: `已创建角色会话 ${sessionId}（provider=${resolvedProvider ?? '继承'}，model=${resolvedModel ?? '继承'}）`,
    }
  }

  /**
   * 把会话挂到 cwd 对应的工作区（左侧「项目」分组）。
   * 失败不再静默：返回结构化结果，重试间隔递增；目录不存在属确定性失败，直接跳过。
   */
  async attachWorkspace(sessionId, cwd) {
    if (!cwd || !this.workspace) {
      return { ok: false, workspaceId: null, workspaceTitle: null, attempts: 0, error: cwd ? 'workspace 服务不可用' : '无 cwd（无法确定所属分组）' }
    }
    let lastErr = '未知错误'
    let ws
    for (let i = 0; i < this.attachDelays.length; i++) {
      if (i > 0 && this.attachDelays[i] > 0) await new Promise((resolve) => setTimeout(resolve, this.attachDelays[i]))
      try {
        ws = await this.workspace.resolveByPath(cwd)
        if (ws === undefined) ws = await this.workspace.create(cwd) // 显式新目录：建工作区再挂
        await ws.attachSession(sessionId)
        return { ok: true, workspaceId: ws.id ?? null, workspaceTitle: ws.title ?? null, attempts: i + 1 }
      } catch (error) {
        if (isDirMissingError(error)) {
          return { ok: false, workspaceId: null, workspaceTitle: null, attempts: i + 1, skipped: true, error: `cwd 目录不存在：${cwd}（未挂接分组）` }
        }
        lastErr = errText(error)
      }
    }
    console.warn(`[dsh-agents] 会话 ${sessionId} 挂接工作区失败（已重试 ${this.attachDelays.length} 次，仅影响左侧分组显示）: ${lastErr}`)
    return { ok: false, workspaceId: ws?.id ?? null, workspaceTitle: ws?.title ?? null, attempts: this.attachDelays.length, error: lastErr }
  }

  /** 插件卸载：只释放本插件创建的会话句柄（用户自己的会话不动）。 */
  disposeSpawned() {
    for (const handle of this.handles.values()) {
      try { void handle.dispose?.() } catch { /* 句柄已失效：无需处理 */ }
    }
    this.handles.clear()
  }
}
