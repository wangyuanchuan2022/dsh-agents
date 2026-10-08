/**
 * retrieval/index.js —— **统一只读检索面** + 检索产物集合的**可枚举结构**（AC-45 生产者侧）。
 *
 * ## 面
 *
 * ```
 *   listFiles()                  → 工作区文件清单（排除表 + .gitignore 生效）
 *   readFile(rel)                → 单文件文本（越界/凭据/二进制/超大 → fail-closed 抛 PathPolicyError）
 *   search(query)                → 逐行命中（含行号）
 *   relatedTests(sourceRel)      → 对应测试；没有则给**显式「无对应测试」标注**（G-17）
 *   git()                        → 只读 git 面（fd-stdio；scratchDir 见下）
 *   collect({...})               → 一轮检索的产物：{bundle, inputText, ...}
 * ```
 *
 * ## 可枚举产物（AC-45）
 *
 * `collect()` 返回的 `bundle` 恒为 `{files, ranges, bytes, queries}` 四元组，
 * **同一轮内可被测试取到**并做引用闭包比对（AC-36 的「note 引用路径 ⊆ 本轮检索集」依赖它）：
 *
 * - `files`  ：本轮实际读入的文件相对路径（去重，有序）
 * - `ranges` ：本轮读入的**行区间**（`{file, start, end}`，1-based 闭区间）
 * - `bytes`  ：本轮注入文本的**字节数**——由 `budget.measureInjection()` 量出（**唯一计量函数**）
 * - `queries`：本轮用过的查询（字面量/正则的字面形态）
 *
 * ## 落盘点（S1a 判据 11）
 *
 * 本模块**不写任何文件**；唯一的落盘点在 `git.js` 的 fd-stdio 临时文件，目录由
 * `scratchDir` 注入，**缺省 = `dataDir`**（= 真实用户 advisor 数据目录 ⇒ 天然落在隔离门
 * 快照根①内）。调用方若另指定目录，**必须**先确认它在隔离门快照根列表内，否则就是
 * architect P1-9 点名的「第三类无门落盘点」。
 *
 * @module dsh-agents/advisor/retrieval/index
 */

import { createPathPolicy, createRejectionLog, PathPolicyError, REJECT } from './path-policy.js'
import { createGitReader, GitError } from './git.js'
import { DEFAULT_EXCLUDED_DIRS, listFiles as walkListFiles, snapshotWorktree } from './walk.js'
import { compileQuery, findRelatedTests, NO_TEST_ANNOTATION, searchFiles } from './search.js'
import { accountRetrieval, budgetExhaustedCarrier, measureInjection } from './budget.js'

export { REJECT, PathPolicyError, GitError, NO_TEST_ANNOTATION, measureInjection, DEFAULT_EXCLUDED_DIRS }
export { KB } from './budget.js'
export { createRejectionLog, createPathPolicy } from './path-policy.js'
export { createGitReader } from './git.js'
export { compileQuery, searchFiles, searchText, findRelatedTests, testCandidatesFor } from './search.js'
export { listFiles, snapshotWorktree, parseGitignore, parseGitattributes, createIgnoreMatcher } from './walk.js'
export {
  BASE_CONTEXT_BYTES, RETRIEVAL_CALL_BYTES, RETRIEVAL_TOTAL_BYTES, TOTAL_INJECTION_BYTES,
  BUDGET_ITEMS, budgetVerdict, accountRetrieval, budgetExhaustedCarrier,
} from './budget.js'

/** 单轮读入的文件数上限（缺省；防注入文本爆量，裁剪 chokepoint 仍在 S3）。 */
export const DEFAULT_FOCUS_SOURCE_FILES = 2
export const DEFAULT_FOCUS_TEST_FILES = 1

/** 判定一个相对路径是否「测试文件」（正则启发式，与 search.testCandidatesFor 同源口径）。 */
export function isTestPath(rel) {
  const p = String(rel ?? '')
  return /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(p)
}

/**
 * 新建可枚举的检索产物集合（**四元组**：files / ranges / bytes / queries）。
 *
 * @returns {{files:string[], ranges:Array<{file:string,start:number,end:number}>, bytes:number, queries:string[],
 *            addFile:Function, addRange:Function, addQuery:Function, setBytes:Function, toJSON:Function}}
 */
export function createBundle() {
  const files = []
  const ranges = []
  const queries = []
  let bytes = 0
  return {
    files,
    ranges,
    queries,
    get bytes() { return bytes },
    addFile(rel) { if (typeof rel === 'string' && rel !== '' && !files.includes(rel)) files.push(rel); return this },
    addRange(file, start, end) {
      ranges.push({ file, start: Math.trunc(start), end: Math.trunc(end) })
      return this
    },
    addQuery(source) { if (typeof source === 'string' && source !== '' && !queries.includes(source)) queries.push(source); return this },
    setBytes(n) { bytes = Number.isFinite(n) ? Math.trunc(n) : 0; return this },
    toJSON() { return { files: [...files], ranges: ranges.map((r) => ({ ...r })), bytes, queries: [...queries] } },
  }
}

/**
 * 建统一只读检索面。
 *
 * @param {{root:string, dataDir?:string, scratchDir?:string, maxFileBytes?:number,
 *          excludedDirs?:string[], maxEntries?:number, fs?:object, spawnSync?:Function, pid?:number}} options
 */
export function createRetrieval(options = {}) {
  const policy = createPathPolicy({
    root: options.root,
    maxFileBytes: options.maxFileBytes,
    denyExtra: options.denyExtra,
  })
  const rejectionLog = options.rejectionLog ?? createRejectionLog({ limit: options.rejectionLogLimit })
  const excludedDirs = Array.isArray(options.excludedDirs) && options.excludedDirs.length > 0
    ? options.excludedDirs : [...DEFAULT_EXCLUDED_DIRS]
  /** fd-stdio 落点：显式 `scratchDir` > `dataDir`（隔离门快照根①内）⇒ 二者都缺则 git 面不可用。 */
  const scratchDir = typeof options.scratchDir === 'string' && options.scratchDir !== ''
    ? options.scratchDir
    : (typeof options.dataDir === 'string' && options.dataDir !== '' ? options.dataDir : null)
  let gitReader = null

  const listFiles = () => walkListFiles({
    policy,
    excludedDirs,
    maxEntries: options.maxEntries,
    ignore: options.ignore,
  })

  const readFile = (rel) => policy.readText(rel, { log: rejectionLog })

  const search = (query, opts = {}) => {
    const compiled = compileQuery(query)
    const files = Array.isArray(opts.files) && opts.files.length > 0 ? opts.files : listFiles().files
    return { ...searchFiles({ policy, files, compiled, maxHits: opts.maxHits, log: rejectionLog }), compiled }
  }

  const relatedTests = (sourceRel, files) => findRelatedTests({
    sourceRel,
    files: Array.isArray(files) ? files : listFiles().files,
  })

  const root = () => policy.root

  const git = () => {
    if (gitReader !== null) return gitReader
    if (scratchDir === null) {
      throw new GitError('GIT_SCRATCH_MISSING', '未提供 scratchDir/dataDir：fd-stdio 临时文件必须落在隔离门可见根内（S1a 判据 11）')
    }
    gitReader = createGitReader({
      cwd: policy.root,
      scratchDir,
      fs: options.fs,
      spawnSync: options.spawnSync,
      pid: options.pid,
      timeoutMs: options.timeoutMs,
    })
    return gitReader
  }

  /** 工作树内容快照（AC-11 的「评审前后完全相同」判据用）。 */
  const worktreeSnapshot = () => snapshotWorktree({ policy, excludedDirs, maxEntries: options.maxEntries })

  /**
   * 一轮检索：产出可枚举 `bundle` + 最终注入文本 `inputText`。
   *
   * **四类内容（AC-2）**：文件清单（≥2 条路径）/ 源码正文 / 测试文件内容 / git 事实。
   * **AC-3**：每个 focus 源文件若找不到对应测试，`inputText` 里出现**逐字「无对应测试」**。
   *
   * @param {{queries?:Array<object>|object, focusSource?:string[], focusSourceLimit?:number,
   *          focusTestLimit?:number, includeGit?:boolean, baseText?:string,
   *          includeFileList?:boolean}} [input]
   * @returns {object}
   */
  const collect = (input = {}) => {
    const bundle = createBundle()
    const listed = listFiles()
    const allRel = listed.files.map((f) => f.rel)
    const queryList = Array.isArray(input.queries) ? input.queries : (input.queries === undefined ? [] : [input.queries])

    // ① 文件清单（AC-2a：≥2 条路径）
    const focusSource = Array.isArray(input.focusSource) && input.focusSource.length > 0
      ? input.focusSource.filter((r) => allRel.includes(r))
      : allRel.filter((rel) => !isTestPath(rel))
    const sourceLimit = Number.isFinite(input.focusSourceLimit) ? Math.trunc(input.focusSourceLimit) : DEFAULT_FOCUS_SOURCE_FILES
    const testLimit = Number.isFinite(input.focusTestLimit) ? Math.trunc(input.focusTestLimit) : DEFAULT_FOCUS_TEST_FILES
    const sourceFiles = focusSource.slice(0, Math.max(1, sourceLimit || 1))
    const testFiles = allRel.filter(isTestPath).slice(0, Math.max(1, testLimit))

    const sections = []
    if (input.includeFileList !== false) {
      sections.push(`## 文件清单（${allRel.length} 个候选）`)
      for (const rel of allRel.slice(0, 50)) {
        bundle.addFile(rel)
        sections.push(`- ${rel}`)
      }
      if (allRel.length > 50) sections.push(`- …（其余 ${allRel.length - 50} 个略）`)
    }

    // ② 源码正文（AC-2b）+ 测试内容（AC-2c）
    const readInto = (rel, title, cache) => {
      try {
        const read = readFile(rel)
        bundle.addFile(rel).addRange(rel, 1, read.text.split(/\r?\n/).length)
        sections.push(`## ${title}：${rel}`)
        sections.push('```')
        sections.push(read.text.replace(/\r\n?/g, '\n').replace(/\n$/, ''))
        sections.push('```')
        cache.set(rel, read.text)
        return read.text
      } catch (error) {
        sections.push(`## ${title}：${rel}（读取被拒绝：${error?.code ?? '?'}）`)
        return null
      }
    }
    const cache = new Map()
    for (const rel of sourceFiles) readInto(rel, '源码', cache)
    for (const rel of testFiles) readInto(rel, '对应测试', cache)

    // ③ 检索命中（逐行带行号）
    for (const query of queryList) {
      const compiled = compileQuery(query ?? {})
      bundle.addQuery(compiled.source)
      const result = searchFiles({ policy, files: allRel, compiled, maxHits: input.maxHits, log: rejectionLog })
      sections.push(`## 检索命中（${compiled.source}，${result.hits.length} 条${result.truncated ? '，已截断' : ''}）`)
      for (const hit of result.hits.slice(0, 50)) {
        bundle.addFile(hit.file).addRange(hit.file, hit.line, hit.line)
        sections.push(`- ${hit.file}:${hit.line}:${hit.column} ${hit.text.trim().slice(0, 160)}`)
      }
    }

    // ④ 对应测试标注（AC-3 / G-17：找不到必须显式标注，不得静默省略）
    const annotations = []
    for (const rel of sourceFiles) {
      const found = relatedTests(rel, allRel)
      for (const t of found.tests) bundle.addFile(t)
      if (found.annotation !== null) annotations.push({ source: rel, annotation: found.annotation })
    }
    if (annotations.length > 0) {
      sections.push('## 标注')
      for (const a of annotations) sections.push(`- ${a.source}：${NO_TEST_ANNOTATION}（候选测试路径均不存在：${relatedTests(a.source, allRel).candidates.slice(0, 3).join(', ')} …）`)
    }

    // ⑤ git 事实（AC-2d）
    let gitFacts = null
    let gitError = null
    if (input.includeGit !== false) {
      try {
        gitFacts = git().facts()
        sections.push('## Git 事实')
        sections.push(`- HEAD ${gitFacts.headSha}`)
        sections.push(`- 分支 ${gitFacts.branch}`)
        sections.push(`- 工作树 status：${gitFacts.statusSummary.total} 条（改动 ${gitFacts.statusSummary.modified} / 未跟踪 ${gitFacts.statusSummary.untracked}）`)
        for (const row of gitFacts.recent.slice(0, 5)) sections.push(`- ${row.sha.slice(0, 7)} ${row.subject}`)
      } catch (error) {
        gitError = { code: error?.code ?? 'git-failed', message: error?.message ?? String(error) }
        sections.push(`## Git 事实（不可用：${gitError.code}）`)
      }
    }

    const inputText = [input.baseText ?? '', sections.join('\n')].filter((s) => s !== '').join('\n\n')
    const measured = measureInjection(inputText)
    bundle.setBytes(measured.bytes)
    const accounting = accountRetrieval({
      baseText: input.baseText ?? '',
      calls: [{ label: 'retrieval#1', text: inputText }],
    })
    return {
      bundle,
      inputText,
      bytes: measured.bytes,
      chars: measured.chars,
      accounting,
      files: listed.files,
      excluded: listed.excluded,
      rejected: listed.rejected,
      rejectionLog: rejectionLog.list(),
      annotations,
      gitFacts,
      gitError,
      truncated: listed.truncated,
    }
  }

  return {
    policy,
    root,
    scratchDir,
    excludedDirs,
    rejectionLog,
    listFiles,
    readFile,
    search,
    relatedTests,
    git,
    worktreeSnapshot,
    collect,
    /** 预算耗尽载体（G-24）——生产侧由 S3 调用，本步只交付载体构造器。 */
    exhaustedCarrier: budgetExhaustedCarrier,
  }
}
