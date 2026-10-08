/**
 * context/repository.js —— **Repository Context 层**（三层装配的第三层；AC-60 分级）。
 *
 * ## L1 / L2 / L3 分级（产品第 7 条）
 *
 * | 级 | 内容 | 本步状态 |
 * |---|---|---|
 * | **L1** | 文件树 + Git diff/status + 最近历史 + 搜索（S1a 的只读面） | **已实装** |
 * | **L2** | **相关文件 · 符号精读**：命中 source 时精读其正文 + 配对测试 + **符号区间**（正则启发式） | **已实装**（AC-60-L2） |
 * | **L3** | 依赖图 / AST 精确分析（tree-sitter） | **未实装** —— 契约须标「**设计意向（未实现，登记增强批次 B4）**」（审定面文档纪律：不得写成现在时） |
 *
 * **符号面的粒度上限（S1a 判据 12 的口径）**：L2 的「符号」= **正则启发式**
 * （`export function` / `class` / `const x =` / 顶层 `function`），**无作用域语义、无 AST 精度**；
 * 因此依赖它的判据只断「引用路径 ⊆ 本轮检索集」，**不断**「符号级发现」。
 *
 * ## AC-62：普通聊天**不做昂贵仓库分析**
 *
 * 昂贵 = 递归遍历 / 子进程 / AST / 大文件读取。本层入口先过
 * `prefilter.shouldRunRepoAnalysis(messageText)`：未命中保守白名单 ⇒ 直接返回
 * `available:false` 且**零检索、零子进程**（`retrievalCalls:0` / `gitCalls:0`）。
 * 这与 AC-17/18（不调模型）**正交**：本层断的是「即使调了模型也不做昂贵分析」。
 *
 * @module dsh-agents/advisor/context/repository
 */

import { shouldRunRepoAnalysis, tailMessage } from '../decision/prefilter.js'

/** 分级标记。 */
export const LEVEL_L1 = 'L1'
export const LEVEL_L2 = 'L2'
export const LEVEL_L3 = 'L3'

/** L3 的审定面措辞（**不得**写成现在时）。 */
export const L3_NOT_IMPLEMENTED_NOTE = '设计意向（未实现，登记增强批次 B4）'

/** 「不可用」标注前缀。 */
export const UNAVAILABLE_MARK = '不可用'

/**
 * 正则启发式抽取**符号区间**（L2 的「符号精读」载体；无 AST 精度）。
 *
 * @param {string} text
 * @param {string} rel
 * @returns {Array<{file:string, start:number, end:number, symbol:string, kind:string}>}
 */
export function extractSymbolRanges(text, rel) {
  const lines = String(text ?? '').split(/\r?\n/)
  const ranges = []
  const patterns = [
    { kind: 'function', re: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'local-function', re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'method', re: /^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  ]
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of patterns) {
      const m = lines[i].match(p.re)
      if (m === null) continue
      ranges.push({ file: rel, start: i + 1, end: i + 1, symbol: m[1], kind: p.kind })
      break
    }
  }
  return ranges
}

/** 从消息文本里抽出**被点名的仓库内路径**（L2 的 focus 来源之一）。 */
export function mentionedPaths(text) {
  const out = []
  const re = /(?:^|[\s"'`(（])((?:[\w.@-]+\/)+[\w.@-]+)/g
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const p = m[1].replace(/[),.;：:]+$/, '')
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/**
 * 装配 Repository Context（L1 + L2；L3 只给声明）。
 *
 * @param {{retrieval:object, messageText?:string, focusSource?:string[], queries?:Array<object>,
 *          includeGit?:boolean, maxFiles?:number}} input
 * @returns {{available:boolean, reason:string|null, level:string, text:string,
 *            l1:object, l2:object, l3:object, bundle:object|null,
 *            retrievalCalls:number, gitCalls:number, symbolRanges:Array<object>}}
 */
export function buildRepositoryContext(input = {}) {
  // AC-62 门只看**用户最后说的那段**（框架标签剥掉；助手独白不算「代码相关请求」）
  const messageText = String(tailMessage(input.messageText).text ?? '')
  const l3 = { level: LEVEL_L3, implemented: false, note: L3_NOT_IMPLEMENTED_NOTE }
  const emptyBundle = { files: [], ranges: [], bytes: 0, queries: [] }

  // ── AC-62 门：普通聊天零检索零子进程 ──
  if (!shouldRunRepoAnalysis(messageText)) {
    return {
      available: false,
      reason: '普通聊天（未命中代码相关白名单）⇒ 本轮不做昂贵仓库分析（AC-62）',
      level: LEVEL_L1,
      text: `### 仓库上下文（Repository Context）\n- 【${UNAVAILABLE_MARK}】普通聊天不做昂贵仓库分析（AC-62）：零遍历、零子进程、零大文件读取`,
      l1: { level: LEVEL_L1, available: false },
      l2: { level: LEVEL_L2, available: false, filesRead: 0 },
      l3,
      bundle: emptyBundle,
      retrievalCalls: 0,
      gitCalls: 0,
      symbolRanges: [],
    }
  }

  const retrieval = input.retrieval
  if (retrieval === null || typeof retrieval?.listFiles !== 'function') {
    return {
      available: false,
      reason: '未注入检索面（retrieval）',
      level: LEVEL_L1,
      text: `### 仓库上下文（Repository Context）\n- 【${UNAVAILABLE_MARK}】未注入检索面`,
      l1: { level: LEVEL_L1, available: false },
      l2: { level: LEVEL_L2, available: false, filesRead: 0 },
      l3, bundle: emptyBundle, retrievalCalls: 0, gitCalls: 0, symbolRanges: [],
    }
  }

  let retrievalCalls = 0
  let gitCalls = 0
  const lines = ['### 仓库上下文（Repository Context：L1 + L2）']

  // ── L1：文件树 + git 事实 + 搜索 ──
  const listed = retrieval.listFiles()
  retrievalCalls += 1
  const allRel = listed.files.map((f) => f.rel)
  lines.push(`#### ${LEVEL_L1} · 文件树（${allRel.length} 个候选，排除表与 .gitignore 生效）`)
  for (const rel of allRel.slice(0, 40)) lines.push(`- ${rel}`)
  if (allRel.length > 40) lines.push(`- …（其余 ${allRel.length - 40} 个略）`)

  let gitFacts = null
  let gitError = null
  if (input.includeGit !== false && typeof retrieval.git === 'function') {
    try {
      gitFacts = retrieval.git().facts()
      gitCalls += 1
      const s = gitFacts.statusSummary ?? { total: 0, modified: 0, untracked: 0 }
      lines.push(`#### ${LEVEL_L1} · Git 事实`)
      lines.push(`- HEAD ${gitFacts.headSha}（分支 ${gitFacts.branch}）`)
      lines.push(`- 工作树 ${s.total} 处（改动 ${s.modified} / 未跟踪 ${s.untracked}）`)
      // AC-5②：`git diff --numstat HEAD` 的**文件数/增删行数**必须与输入里的数字一致
      //（G-8 口径：含未提交工作树改动；测试用同一条命令独立算一遍做对账）。
      if (typeof retrieval.git().diffNumstat === 'function') {
        const rows = retrieval.git().diffNumstat({ from: 'HEAD' })
        gitCalls += 1
        const added = rows.reduce((n, r) => n + (Number.isFinite(r.added) ? r.added : 0), 0)
        const deleted = rows.reduce((n, r) => n + (Number.isFinite(r.deleted) ? r.deleted : 0), 0)
        lines.push(`- diff --numstat HEAD：${rows.length} 个文件，+${added} / -${deleted} 行（二进制 ${rows.filter((r) => r.binary).length} 个）`)
      }
      for (const row of (gitFacts.recent ?? []).slice(0, 3)) lines.push(`- ${String(row.sha).slice(0, 7)} ${row.subject}`)
    } catch (error) {
      gitError = error
      lines.push(`#### ${LEVEL_L1} · Git 事实`)
      lines.push(`- 【${UNAVAILABLE_MARK}】${error?.code ?? 'git-failed'}：${String(error?.message ?? error).slice(0, 160)}`)
    }
  }

  const queries = Array.isArray(input.queries) ? input.queries : []
  if (queries.length > 0 && typeof retrieval.search === 'function') {
    lines.push(`#### ${LEVEL_L1} · 搜索命中`)
    for (const q of queries) {
      const found = retrieval.search(q, { files: allRel })
      retrievalCalls += 1
      lines.push(`- ${found.query}：${found.hits.length} 条${found.truncated ? '（截断）' : ''}`)
      for (const hit of found.hits.slice(0, 20)) lines.push(`  - ${hit.file}:${hit.line}:${hit.column} ${hit.text.trim().slice(0, 140)}`)
    }
  }

  // ── L2：相关文件 · 符号精读（命中 source 时精读正文 + 配对测试 + 符号区间）──
  const mentioned = mentionedPaths(messageText).filter((p) => allRel.includes(p))
  const focus = (Array.isArray(input.focusSource) && input.focusSource.length > 0
    ? input.focusSource
    : (mentioned.length > 0 ? mentioned : allRel.filter((r) => !/(^|\/)(test|tests|__tests__)\//.test(r) && !/\.(test|spec)\.[a-z0-9]+$/i.test(r))))
    .filter((r) => allRel.includes(r))
  const maxFiles = Number.isFinite(input.maxFiles) && input.maxFiles > 0 ? Math.trunc(input.maxFiles) : 4
  const picked = focus.slice(0, maxFiles)
  const symbolRanges = []
  const filesRead = []
  lines.push(`#### ${LEVEL_L2} · 相关文件 · 符号精读（最多 ${maxFiles} 个源文件 + 其配对测试；符号面 = 正则启发式，无 AST 精度）`)
  for (const rel of picked) {
    let read = null
    try {
      read = retrieval.readFile(rel)
      retrievalCalls += 1
    } catch (error) {
      lines.push(`- ${rel}：读取被拒绝（${error?.code ?? 'read-failed'}）`)
      continue
    }
    filesRead.push(rel)
    const relSymbols = extractSymbolRanges(read.text, rel)
    symbolRanges.push(...relSymbols)
    lines.push(`- 精读 ${rel}（${read.text.split(/\r?\n/).length} 行；符号 ${relSymbols.length} 个：${relSymbols.slice(0, 6).map((s) => s.symbol).join(', ') || '（无）'}）`)
    // 配对测试（与 AC-3 的 source↔test 配对同源）
    if (typeof retrieval.relatedTests === 'function') {
      const paired = retrieval.relatedTests(rel, allRel)
      for (const testRel of paired.tests) {
        try {
          const testRead = retrieval.readFile(testRel)
          retrievalCalls += 1
          lines.push(`- 配对测试 ${testRel}（${testRead.text.split(/\r?\n/).length} 行）`)
        } catch { /* 配对测试读不到不致命 */ }
      }
      if (paired.annotation !== null) lines.push(`- ${rel}：${paired.annotation}（候选 ${paired.candidates.slice(0, 3).join(', ')} …）`)
    }
  }
  if (picked.length === 0) lines.push('- （无可精读的源文件）')

  lines.push(`#### ${LEVEL_L3} · 依赖图 / AST`)
  lines.push(`- 【${L3_NOT_IMPLEMENTED_NOTE}】（本步只交付 L1 + L2）`)

  const text = lines.join('\n')
  return {
    available: true,
    reason: gitError === null ? null : `git 事实不可用（${gitError?.code ?? 'git-failed'}）`,
    level: `${LEVEL_L1}+${LEVEL_L2}`,
    text,
    l1: { level: LEVEL_L1, available: true, files: allRel.length, gitAvailable: gitFacts !== null },
    l2: { level: LEVEL_L2, available: true, filesRead: filesRead.length, symbols: symbolRanges.length },
    l3,
    bundle: { files: [...new Set([...allRel.slice(0, 40), ...filesRead])], ranges: symbolRanges, bytes: Buffer.byteLength(text, 'utf8'), queries: queries.map((q) => q?.literal ?? q?.pattern ?? '') },
    retrievalCalls,
    gitCalls,
    symbolRanges,
  }
}
