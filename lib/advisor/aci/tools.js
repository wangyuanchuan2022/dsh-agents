/**
 * aci/tools.js —— advisor 的**只读 ACI 工具面**（S3 / 计划 §2 S3 写面）。
 *
 * ## 白名单（AC-8，形态 = 白名单精确相等，不是黑名单过滤）
 *
 * ```
 *   { read_file, search, list_files, get_diff, get_git_log }
 * ```
 *
 * **构造上不存在** `write/edit/commit/push/delete/install/shell/exec/spawn`——
 * 本文件没有任何创建这些工具的代码路径；`assertAciWhitelist()` 对**实际造出来的
 * 集合**做相等断言（多一个、少一个都红），测试还配源码级 grep 门（禁名词零命中）。
 *
 * ## 只读（AC-9）
 *
 * 每个工具都带 `readOnly: true` 等价标注；`execute()` 只经 S1a 的
 * `retrieval/` 只读面取数（**复用，不重写第二套**——S3 硬约束 4）。
 *
 * ## 工具失败语义（契约 §6.5 声明项的实现侧）
 *
 * - **参数/边界类拒绝**（路径越界、凭据/二进制/超大拒绝、非法查询、坏 JSON）：
 *   返回 `isError` 工具结果（显式文案，模型可从中学到边界），循环继续；
 * - **环境类失败**（git 不可用、检索面异常）：上抛 `AciEnvironmentError`，
 *   由 `aci/loop.js` 按「循环中途失败 = dropped + records 一条」处置（判据 12）。
 *
 * @module dsh-agents/advisor/aci/tools
 */

import { formatToolObservation, formatToolError, formatBadArguments } from './observation.js'
import { compileQuery } from '../retrieval/search.js'
import { PathPolicyError } from '../retrieval/path-policy.js'
import { QueryError } from '../retrieval/search.js'
import { GitError } from '../retrieval/git.js'

/** ACI 工具白名单（**唯一声明点**；AC-8 相等断言的对象）。 */
export const ACI_TOOL_NAMES = Object.freeze(['read_file', 'search', 'list_files', 'get_diff', 'get_git_log'])

/** 禁止出现的工具名（源码级 grep 门与运行时断言共用同一清单）。 */
export const FORBIDDEN_TOOL_NAMES = Object.freeze([
  'write', 'edit', 'commit', 'push', 'delete', 'install', 'shell', 'exec', 'spawn',
])

/** 环境类失败（git 不可用等）——循环按 dropped 处置。 */
export class AciEnvironmentError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'AciEnvironmentError'
    this.code = typeof options.code === 'string' ? options.code : 'aci-environment'
  }
}

/**
 * 白名单**精确相等**断言（AC-8）。传入实际工具名数组，与 {@link ACI_TOOL_NAMES}
 * 做集合相等比较——多一个、少一个都抛错（黑名单式「过滤后为空」不算数）。
 * @param {string[]} actualNames
 * @param {{label?:string}} [options]
 */
export function assertAciWhitelist(actualNames, options = {}) {
  const label = typeof options.label === 'string' ? options.label : 'ACI'
  const actual = [...new Set(actualNames)].sort()
  const expected = [...ACI_TOOL_NAMES].sort()
  const extra = actual.filter((n) => !expected.includes(n))
  const missing = expected.filter((n) => !actual.includes(n))
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `[${label}] 工具白名单不相等：多出 [${extra.join(', ')}]，缺少 [${missing.join(', ')}]`
      + `（期望 ${expected.join(', ')}；实际 ${actual.join(', ')}）`,
    )
  }
}

/**
 * 规范化非负整数参数（B2/B3 修复批 P1-②：**不抛错**——参数类错误必须走
 * isError 工具结果让循环继续，抛通用 Error 会烧掉整次评审）。
 * @returns {{ok:boolean, value:number|null}}
 */
function readIntArg(value) {
  if (value === undefined || value === null) return { ok: true, value: null }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) return { ok: false, value: null }
  return { ok: true, value: n }
}

/**
 * 建只读 ACI 工具集（复用 S1a retrieval 面，**不重写第二套**）。
 *
 * @param {{retrieval:object, observation?:{maxLines?:number}}} options
 * @returns {Array<{name:string, description:string, parameters:object, readOnly:true, execute:Function}>}
 */
export function createAciTools(options = {}) {
  const retrieval = options.retrieval
  if (retrieval === null || typeof retrieval !== 'object') {
    throw new Error('createAciTools 需要 S1a retrieval 面（retrieval）')
  }
  const obs = { maxLines: options.observation?.maxLines }

  /** git 面统一入口：GitError（环境类）升格为 AciEnvironmentError。 */
  const gitFacet = () => {
    try {
      return retrieval.git()
    } catch (error) {
      if (error instanceof GitError) throw new AciEnvironmentError(`git 面不可用：${error.message}`, { code: error.code ?? 'git-unavailable' })
      throw error
    }
  }

  const tools = [
    {
      name: 'read_file',
      description: '读取工作区内一个文本文件的内容（只读；越界/凭据/二进制/超大文件会被显式拒绝）。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区相对路径' } }, required: ['path'] },
      readOnly: true,
      execute(args) {
        const rel = typeof args?.path === 'string' ? args.path : ''
        // P1-②：参数类错误 = isError 结果（循环继续，模型可自行修正），不抛通用 Error。
        if (rel === '') return errorResult('bad-arguments', 'read_file 需要非空 path（工作区相对路径）')
        let read
        try {
          read = retrieval.readFile(rel)
        } catch (error) {
          if (error instanceof PathPolicyError) return errorResult(error.code ?? 'path-denied', error.message)
          throw error
        }
        const view = formatToolObservation(read.text, obs)
        return { text: `# read_file ${rel}\n${view.text}`, isError: false, files: [rel], ranges: [{ file: rel, start: 1, end: view.lines }] }
      },
    },
    {
      name: 'search',
      description: '在工作区内做字面/正则检索，按行返回命中（含文件路径与行号）。',
      parameters: {
        type: 'object',
        properties: {
          literal: { type: 'string', description: '字面查询（与 pattern 二选一）' },
          pattern: { type: 'string', description: '正则查询（与 literal 二选一）' },
          caseInsensitive: { type: 'boolean', description: '忽略大小写' },
        },
      },
      readOnly: true,
      execute(args) {
        let compiled
        try {
          compiled = compileQuery(args ?? {})
        } catch (error) {
          if (error instanceof QueryError) return errorResult('query-invalid', error.message)
          throw error
        }
        const result = retrieval.search(args ?? {})
        const lines = result.hits.map((h) => `${h.file}:${h.line}:${h.column} ${h.text.trim().slice(0, 160)}`)
        if (result.truncated) lines.push(`…[检索命中已截断：查询 ${compiled.source}]`)
        const view = formatToolObservation(lines.join('\n'), obs)
        return {
          text: `# search ${compiled.source}（${result.hits.length} 条${result.truncated ? '，已截断' : ''}）\n${view.text}`,
          isError: false,
          files: result.hits.map((h) => h.file),
          queries: [compiled.source],
        }
      },
    },
    {
      name: 'list_files',
      description: '列出工作区文件清单（已应用排除表与 .gitignore）。',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      execute() {
        const listed = retrieval.listFiles()
        const view = formatToolObservation(listed.files.map((f) => f.rel).join('\n'), obs)
        return {
          text: `# list_files（${listed.files.length} 个${listed.truncated ? '，已截断' : ''}）\n${view.text}`,
          isError: false,
          files: listed.files.slice(0, obs.maxLines ?? 100).map((f) => f.rel),
        }
      },
    },
    {
      name: 'get_diff',
      description: '读取 git diff --numstat（每文件增删行数；只读子命令，参数原样直传）。',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string', description: '起始 revision（缺省 HEAD）' }, to: { type: 'string', description: '目标 revision（可省）' } },
      },
      readOnly: true,
      execute(args) {
        const from = typeof args?.from === 'string' && args.from !== '' ? args.from : 'HEAD'
        const to = typeof args?.to === 'string' && args.to !== '' ? args.to : null
        const rows = gitFacet().diffNumstat({ from, to })
        const view = formatToolObservation(rows.map((r) => `${r.added}\t${r.deleted}\t${r.path}`).join('\n'), obs)
        return { text: `# get_diff ${from}${to ? ` ${to}` : ''}\n${view.text}`, isError: false, files: [] }
      },
    },
    {
      name: 'get_git_log',
      description: '读取 git 提交历史（--oneline；可按 --grep 过滤，载荷原样直传不解释）。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '条数上限（缺省 10）' }, grep: { type: 'string', description: '按提交说明子串过滤' } },
      },
      readOnly: true,
      execute(args) {
        const parsedLimit = readIntArg(args?.limit)
        if (!parsedLimit.ok) {
          // P1-②：坏 limit = isError 结果（不抛——抛通用 Error 会烧掉整次评审）
          return errorResult('bad-arguments', `get_git_log 的 limit 必须是非负整数（收到 ${String(args?.limit)}）`)
        }
        const limit = parsedLimit.value ?? 10
        const git = gitFacet()
        const rows = typeof args?.grep === 'string' && args.grep !== ''
          ? git.grepLog({ needle: args.grep, limit })
          : git.recentLog({ limit })
        const view = formatToolObservation(rows.map((r) => `${r.sha} ${r.subject}`).join('\n'), obs)
        return { text: `# get_git_log${args?.grep ? ` --grep=${args.grep}` : ''}\n${view.text}`, isError: false, files: [] }
      },
    },
  ]

  /** 错误结果构造（参数/边界类：显式 isError 结果，循环继续）。 */
  function errorResult(code, message) {
    return { text: formatToolError({ code, message }), isError: true, files: [] }
  }

  // 构造出口自检：白名单相等（AC-8 的生产侧执行点；测试另做独立断言）。
  assertAciWhitelist(tools.map((t) => t.name), { label: 'createAciTools' })
  return tools
}

/** 把工具集投喂给 llm.stream 的 ToolSchema 形态（只暴露 name/description/parameters）。 */
export function aciToolSchemas(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/** 按名取工具；未登记名返回 null（调用方给显式 isError 结果）。 */
export function aciToolByName(tools, name) {
  return tools.find((t) => t.name === name) ?? null
}

/** 参数坏 JSON 的显式结果文本（供 loop 复用同一文案源）。 */
export { formatBadArguments }
