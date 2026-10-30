/**
 * S5 分层重构（F-4）：S2/S3 钩子族——只读检索面 / 决策保护 / 三层上下文 / 规则预筛 /
 * agentic 工具循环（接缝声明 §3）。按会话工作区根（root）缓存检索面。
 *
 * 硬模式（S-2）：本模块不 import `store.js`/`api.js`，构造期零 IO——
 * store/config/getAgent/依赖注入项全部经工厂入参注入；`retrievalByRoot` 缓存归本模块持有。
 *
 * @module dsh-agents/advisor/assemble/context-hooks
 */

import { createRetrieval } from '../retrieval/index.js'
import { buildContext, renderContextSection, renderUnavailableContext } from '../context/build.js'
import { loadDecisions } from '../context/decisions.js'
import { loadProjectStatus } from '../context/project-status.js'
import { screen as screenMessage } from '../decision/prefilter.js'
import { createAciTools } from '../aci/tools.js'
import { runToolLoop } from '../aci/loop.js'

/**
 * @param {object} deps
 * @param {object} deps.config - resolveAdvisorConfig 产物（hooks 活读，与原闭包语义一致）
 * @param {import('../store.js').AdvisorStore} deps.store
 * @param {string} deps.dataDir - 数据目录（检索面构造入参）
 * @param {(sessionId: string) => unknown} deps.getAgent
 * @param {() => string} deps.systemPromptOf - 装配层注入的提示词读取点（contextFor 用）
 * @param {((sessionId: string) => string|null) | undefined} [deps.resolutionRootOf] - 测试注入夹具根
 * @param {string | undefined} [deps.cwd] - deps.cwd（resolutionRootOf 缺省链的一环）
 * @param {number | undefined} [deps.retrievalMaxEntries] - 检索面上限（透传 createRetrieval）
 * @returns {{ retrievalFor, resolutionRootOf, contextFor, prefilterFor, aciLoop }}
 */
export function createContextHooks({
  config, store, dataDir, getAgent, systemPromptOf, resolutionRootOf: resolutionRootOfDep,
  cwd, retrievalMaxEntries,
}) {
  // ── S2：只读检索面 / 决策保护 / 三层上下文（按 root 缓存）────────────────────
  // root = **会话 cwd 工作区根**（G-16）；宿主 session 形状不可得时回落 deps.cwd，
  // 两者都没有 ⇒ 上下文层显式标「不可用」——**绝不**回落宿主启动目录（既有源码级门禁止）。
  // 测试用 deps.resolutionRootOf 注入夹具根（与 `deps.trace` 同一种注入风格）。
  const retrievalByRoot = new Map()
  const retrievalFor = (root) => {
    let facet = retrievalByRoot.get(root)
    if (facet === undefined) {
      facet = createRetrieval({ root, dataDir, maxEntries: retrievalMaxEntries })
      retrievalByRoot.set(root, facet)
    }
    return facet
  }
  const resolutionRootOf = resolutionRootOfDep
    ?? ((sessionId) => cwd ?? getAgent(sessionId)?.session?.cwd ?? null)

  /**
   * 三层上下文装配（注入进 runtime 的 `context` 钩子）。
   *
   * - **Base Context**（≤8KB）= 契约锚 + 系统提示 + Project State + 决策保护
   *   —— **不含会话消息历史**（G-2；历史由 runtime 的会话窗口独立承载）；
   * - **Repository Context**（L1+L2，≤40KB）= S1a 的只读检索面；
   *   普通聊天 ⇒ **零检索零子进程**（AC-62，由 `shouldRunRepoAnalysis` 把门）；
   * - 装配抛错由 runtime 兜成 fail-open（见 `runtime.#buildContextSection`）。
   */
  const contextFor = ({ markdown, meta }) => {
    const sessionId = meta?.sessionId
    const root = resolutionRootOf(sessionId)
    // ⚠️ 刻意**不**回落宿主启动目录（既有源码级门禁止该 API 出现在本文件；
    //    advisor 的路径一律不随启动目录漂移）
    if (typeof root !== 'string' || root === '') {
      return { section: renderUnavailableContext('未解析到会话工作区根（resolutionRootOf 未提供且会话未暴露 cwd）⇒ 本轮不做仓库分析'), result: null }
    }
    const retrieval = retrievalFor(root)
    const decisions = loadDecisions({ readText: (rel) => retrieval.readFile(rel) })
    // 项目全景段（2026-10-29）：**单文件精确路径读取**，不是递归遍历 / 子进程 /
    // AST / 大文件读取 ⇒ 不属于 AC-62 的「昂贵仓库分析」，因此在门之前装配，
    // 普通聊天（「继续」「下一步做什么」）也能看到项目全景。
    // 读不到 ⇒ loadProjectStatus 返回 available:false，渲染时显式标「不可用」（AC-4）。
    const projectStatus = loadProjectStatus({ readText: (rel) => retrieval.readFile(rel) })
    const sessionCfg = typeof sessionId === 'string' && sessionId !== '' ? store.readSessionConfig(sessionId) : {}
    const result = buildContext({
      retrieval,
      messageText: markdown,
      systemPrompt: systemPromptOf(),
      decisions,
      projectStatus,
      project: { phase: sessionCfg.projectPhase ?? null },
      maxFiles: config.advisorContextMaxFiles,
    })
    return { section: renderContextSection(result), result }
  }

  /** 规则预筛（注入进 runtime 的 `prefilter` 钩子；**纯本地规则**、零 token）。 */
  const prefilterFor = ({ text, role, trigger }) => screenMessage({ text, role, trigger })

  /**
   * S3：agentic 工具循环（注入进 runtime 的 `toolLoop` 钩子）。
   *
   * - 工具面按**会话工作区根**现取（`retrievalFor(root)` 复用 S1a 检索面，
   *   不重写第二套）；root 解析不出 ⇒ 空工具集（循环退化为多轮纯文本）；
   * - 预算池**逐次评审新建**，`alreadyUsedBytes` 接收 S2 预取面的已记账字节
   *   ⇒ 预取面与模型工具面**共享同一 40KB 检索段池**（判据 8 的池归属）；
   * - `advisorMaxToolRounds === 0` 时装配层不注入本钩子（runtime 走单次调用）。
   */
  const aciLoop = async (call) => {
    const root = resolutionRootOf(call.meta?.sessionId)
    const retrieval = typeof root === 'string' && root !== '' ? retrievalFor(root) : null
    const prefetchBytes = call.contextResult?.repositoryBytes
    return runToolLoop({
      llm: call.llm,
      provider: call.provider,
      model: call.model,
      systemPrompt: call.systemPrompt,
      messages: call.messages,
      tools: retrieval === null ? [] : createAciTools({ retrieval }),
      maxRounds: config.advisorMaxToolRounds,
      maxTokens: call.maxTokens,
      callTimeoutMs: call.callTimeoutMs,
      signal: call.signal,
      trace: call.trace,
      meta: call.meta,
      alreadyUsedBytes: Number.isFinite(prefetchBytes) ? prefetchBytes : 0,
    })
  }

  return { retrievalFor, resolutionRootOf, contextFor, prefilterFor, aciLoop }
}
