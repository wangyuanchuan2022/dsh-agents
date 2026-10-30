/**
 * context/repository.js —— **Repository Context 层**（三层装配的第三层；AC-60 分级）。
 *
 * ## L1 / L2 / L3 分级（产品第 7 条）
 *
 * | 级 | 内容 | 本步状态 |
 * |---|---|---|
 * | **L1** | 文件树 + Git diff/status + 最近历史 + 搜索（S1a 的只读面） | **已实装** |
 * | **L2** | **相关文件 · 符号精读**：命中 source 时精读其正文 + 配对测试 + **符号区间** | **已实装**（AC-60-L2）；B4 起符号面 = **AST（web-tree-sitter）**，引擎未就绪/降级时回落**正则启发式**并**显式标注**（`degraded` 语义见 `retrieval/symbols.js`） |
 * | **L3** | 依赖图 / 全量 AST 精确分析 | **未实装** —— 契约须标「**设计意向（未实现，登记增强批次 B4）**」（审定面文档纪律：不得写成现在时；B4 落地的是 L2 符号级，不含依赖图） |
 *
 * **符号面的粒度上限（S1a 判据 12 的口径，B4 修订）**：AST 引擎就绪时符号 = tree-sitter
 * Query 四类 capture（function/class/method/call，行列精确）；**降级态**（引擎未就绪 /
 * wasm 拒载 / init 失败）= **正则启发式**，注入文本必须注明「正则启发式」，且
 * **降级态不断言符号级**（AC-36 的 `checkSymbolRefs` 对降级 bundle 返回 `asserted:false`）。
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
import { ensureSymbolEngine, extractSymbolsRegex, isSupportedExtension, peekSymbolEngine, SUPPORTED_EXTENSIONS } from '../retrieval/symbols.js'

/** 分级标记。 */
export const LEVEL_L1 = 'L1'
export const LEVEL_L2 = 'L2'
export const LEVEL_L3 = 'L3'

/** L3 的审定面措辞（**不得**写成现在时）。 */
export const L3_NOT_IMPLEMENTED_NOTE = '设计意向（未实现，登记增强批次 B4）'

/**
 * L2 精读的缺省文件数上限（`advisorContextMaxFiles` 未配置时的值）。
 * `0` = **关闭 L2 精读**（只保留 L1）；负值/非法值 ⇒ 回落本缺省。
 */
export const DEFAULT_L2_MAX_FILES = 4

/**
 * **每文件最多注入几个符号的正文**（2026-10-29 L2 符号正文修复）。
 *
 * 取值依据（实测）：`lib/advisor/runtime.js` 有 1040 行 / 58 个符号；若全量注入
 * 正文会瞬间吃满 40KB 检索段池。取 6 = 只给「最相关的几个符号」的实现，
 * 其余靠模型自己 `read_file` 精读（工具面在，不缺通路）。
 */
export const L2_MAX_SYMBOL_BODIES = 6

/**
 * **单个符号正文的注入行数上限**。
 *
 * 取 40 行：覆盖绝大多数 JS 函数/类的实现主体（超过 40 行的多半是巨型函数，
 * 而巨型函数本身就是一条值得顾问指出的问题——**截断事实会显式标注**）。
 * 20 个符号 × 40 行 × 约 40 字节 ≈ 32KB，仍在 40KB 池内；配合每文件 6 个符号，
 * 4 文件最坏 24 个符号，实际受 `RETRIEVAL_TOTAL_BYTES` 裁剪兜底。
 */
export const L2_MAX_LINES_PER_SYMBOL = 40

/**
 * 从源文件正文里**切出符号的实现段**（L2「符号精读」的兑现；2026-10-29 修复）。
 *
 * ## 为什么必须有这个函数
 *
 * 修复前 L2 只注入「文件名 + 行数 + 符号名列表」，**从不使用符号的 start/end**。
 * 实测（`agent-out/_advisor-vision-probes/_probe-l2-body.mjs`）：从
 * `lib/advisor/runtime.js` 取 5 行独有内容与注入文本比对，**0/5 命中**——
 * 顾问知道「有个函数叫 buildMessages」但**看不到它长什么样**。
 * 这与契约「相关文件 · 符号精读」的字面承诺不符（已登记为契约与实现漂移）。
 *
 * ## 边界（不静默）
 *
 * - 符号缺 `start`/`end`（降级正则态可能不完整）⇒ 跳过该符号，计入 `skipped`；
 * - 区间越界 / 非法 ⇒ 跳过，计入 `skipped`；
 * - 单符号超行数上限 ⇒ **截断并显式记入 `truncated`**（不静默丢）；
 * - 全部符号都用不上 ⇒ `slices:[]`，由调用方给「符号区间不可用」的显式文案。
 *
 * @param {string} text - 源文件全文
 * @param {Array<{start?:number, end?:number, symbol?:string, name?:string, kind?:string}>} symbols
 * @param {{maxSymbols?:number, maxLinesPerSymbol?:number}} [options]
 * @returns {{slices:Array<{start:number,end:number,symbol:string,kind:string,lines:string[]}>,
 *            skipped:number, truncated:string[]}}
 */
export function extractSymbolBodies(text, symbols, options = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const maxSymbols = Number.isInteger(options.maxSymbols) && options.maxSymbols > 0
    ? options.maxSymbols : L2_MAX_SYMBOL_BODIES
  const maxLinesPerSymbol = Number.isInteger(options.maxLinesPerSymbol) && options.maxLinesPerSymbol > 0
    ? options.maxLinesPerSymbol : L2_MAX_LINES_PER_SYMBOL

  const slices = []
  const truncated = []
  const seenNames = new Set()
  let skipped = 0
  const list = Array.isArray(symbols) ? symbols : []
  for (const symbol of list) {
    // 同名符号只取一次：`String(...)` 这类调用会出现很多次，若不挡会占满
    // L2_MAX_SYMBOL_BODIES 名额（实测 6 个名额里 3 个被 String 占掉，
    // 真正的函数实现反而进不来）。
    const displayName = String(symbol?.symbol ?? symbol?.name ?? '(匿名)')
    if (seenNames.has(displayName)) {
      skipped += 1
      continue
    }
    if (slices.length >= maxSymbols) {
      // 名额用尽：**不静默**，计入 skipped（调用方会渲染「另有 N 个未注入」）
      skipped += 1
      continue
    }
    const start = Number.isFinite(symbol?.start) ? Math.trunc(symbol.start) : null
    const end = Number.isFinite(symbol?.end) ? Math.trunc(symbol.end) : null
    // 1-based 闭区间；非法/越界一律跳过（不猜测、不无中生有）
    if (start === null || end === null || start < 1 || end < start || start > lines.length) {
      skipped += 1
      continue
    }
    // 正文区间优先取**声明区间**（declStart/declEnd，AST 态由父节点给出）——
    // 否则只有 name 节点的一行（实测：`export function alpha() {` 切不到函数体）。
    // 声明区间不可用时回落 start/end（降级正则态即此形态）。
    const bodyStart = Number.isFinite(symbol?.declStart) ? Math.trunc(symbol.declStart) : start
    const bodyEnd = Number.isFinite(symbol?.declEnd) ? Math.trunc(symbol.declEnd) : end
    const safeStart = Math.max(1, bodyStart)
    const safeEnd = Math.min(Math.max(bodyEnd, safeStart), lines.length)
    let bodyLines = lines.slice(safeStart - 1, safeEnd)
    const name = displayName
    // 区间**包含关系**去重：若本符号的行区间完全落在已注入的某个区间内
    // （典型：类的各方法都在类体内），则该方法的正文已在类段落里出现——
    // 再注入一次是纯重复（实测 class + 4 个 method 会占满 6 个名额，真正
    // 想看的方法反而挤掉）。此时**不占名额**、计入 skipped（调用方会上报）。
    const covered = slices.find((prev) => safeStart >= prev.start && safeEnd <= prev.end)
    if (covered !== undefined) {
      skipped += 1
      continue
    }
    seenNames.add(name)
    if (bodyLines.length > maxLinesPerSymbol) {
      bodyLines = bodyLines.slice(0, maxLinesPerSymbol)
      truncated.push(name)
    }
    slices.push({
      start: safeStart,
      end: safeEnd,
      symbol: name,
      kind: String(symbol.kind ?? 'symbol'),
      lines: bodyLines,
    })
  }
  return { slices, skipped, truncated }
}

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
  return extractSymbolsRegex(text, rel)
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
  const emptyBundle = { files: [], ranges: [], bytes: 0, queries: [], symbols: [], symbolsSource: 'regex' }

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
  //
  // ⚠️ `maxFiles = 0` 的语义 = **关闭 L2 精读**（P1-1，code-reviewer 2026-10-09 实测：
  // 旧实现 `> 0 ? : 4` 把显式的 0 回落成 4 ⇒「用户关掉 L2 却仍注入 4 个源文件正文」）。
  // 该语义在 `cordis.patch.yml` / `index.js` 注释 / 契约（S5）**三处**都写着「0 = 关闭」，
  // 故这里按文档实现；同时把「已关闭」写进注入文本（可断言、不静默）。
  const rawMaxFiles = Number.isFinite(input.maxFiles) ? Math.trunc(input.maxFiles) : DEFAULT_L2_MAX_FILES
  const maxFiles = rawMaxFiles >= 0 ? rawMaxFiles : DEFAULT_L2_MAX_FILES
  const l2Disabled = maxFiles === 0
  const mentioned = mentionedPaths(messageText).filter((p) => allRel.includes(p))
  const focus = (Array.isArray(input.focusSource) && input.focusSource.length > 0
    ? input.focusSource
    : (mentioned.length > 0 ? mentioned : allRel.filter((r) => !/(^|\/)(test|tests|__tests__)\//.test(r) && !/\.(test|spec)\.[a-z0-9]+$/i.test(r))))
    .filter((r) => allRel.includes(r))
  const picked = l2Disabled ? [] : focus.slice(0, maxFiles)
  const symbolRanges = []
  const filesRead = []
  // B4：符号引擎 = 显式注入 > 进程级已就绪 singleton（peek）> 未就绪（正则降级 + 触发后台 warm）
  let symbolEngine = input.symbolEngine ?? null
  if (symbolEngine === null && !l2Disabled) {
    symbolEngine = peekSymbolEngine()
    if (symbolEngine === null) {
      ensureSymbolEngine().catch(() => { /* ensureSymbolEngine 永不 reject；兜底防 unhandled */ })
    }
  }
  const symbolSource = symbolEngine === null ? 'regex' : (symbolEngine.degraded ? 'regex' : 'ast')
  const symbolFaceNote = symbolEngine === null
    ? '符号面 = 正则启发式，无 AST 精度'
    : (symbolEngine.degraded
      ? `符号面 = 正则启发式（降级：${symbolEngine.reason}）；无 AST 精度`
      : '符号面 = AST（web-tree-sitter，tree-sitter-javascript wasm sha256 校验通过）')
  lines.push(l2Disabled
    ? `#### ${LEVEL_L2} · 相关文件 · 符号精读\n- 【已关闭】advisorContextMaxFiles = 0 ⇒ 本轮不做 L2 精读（只保留 L1 文件树/Git/搜索）`
    : `#### ${LEVEL_L2} · 相关文件 · 符号精读（最多 ${maxFiles} 个源文件 + 其配对测试；${symbolFaceNote}）`)
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
    // AC-56：未支持扩展名**显式标注**（不静默当无语法处理）
    if (symbolEngine !== null && !isSupportedExtension(rel)) {
      lines.push(`- ${rel}：非 JS 源（扩展名不在支持面 ${SUPPORTED_EXTENSIONS.join('/')}）⇒ 不做符号级解析（AC-56，显式标注）`)
    }
    const relSymbols = (symbolEngine !== null && !isSupportedExtension(rel))
      ? [] // AC-56：未支持扩展名不交给 JS grammar（上面已显式标注）
      : (symbolEngine !== null ? symbolEngine.extract(read.text, rel) : extractSymbolRanges(read.text, rel))
    symbolRanges.push(...relSymbols)
    lines.push(`- 精读 ${rel}（${read.text.split(/\r?\n/).length} 行；符号 ${relSymbols.length} 个：${relSymbols.slice(0, 6).map((s) => s.symbol).join(', ') || '（无）'}）`)
    // ── 符号正文切片（2026-10-29 修复）：━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 此前 L2 **只打印符号名与行数、从不使用符号的 start/end 行号** ⇒ 模型看到
    // 「runtime.js 有 59 个符号、叫 buildMessages」但**看不到这些符号的实现**。
    // 实测：从源文件取 5 行独有内容与注入文本比对，0/5 命中（探针 _probe-l2-body）。
    // 与契约「相关文件 · 符号精读」的字面承诺不符，已登记为契约与实现漂移。
    const bodySlices = extractSymbolBodies(read.text, relSymbols, {
      maxSymbols: L2_MAX_SYMBOL_BODIES,
      maxLinesPerSymbol: L2_MAX_LINES_PER_SYMBOL,
    })
    for (const slice of bodySlices.slices) {
      lines.push(`  - 符号正文 ${rel}:${slice.start}-${slice.end} ${slice.kind} ${slice.symbol}`)
      lines.push('```')
      for (const line of slice.lines) lines.push(line)
      lines.push('```')
    }
    if (bodySlices.skipped > 0) {
      lines.push(`  - …（另有 ${bodySlices.skipped} 个符号的正文未注入：超出「每文件 ${L2_MAX_SYMBOL_BODIES} 个符号」上限，可用 read_file 精确读取）`)
    }
    if (bodySlices.truncated.length > 0) {
      lines.push(`  - …（${bodySlices.truncated.length} 个符号正文超过 ${L2_MAX_LINES_PER_SYMBOL} 行已截断：${bodySlices.truncated.slice(0, 5).join(', ')}）`)
    }
    if (relSymbols.length > 0 && bodySlices.slices.length === 0) {
      lines.push(`  - （符号区间不可用 ⇒ 未注入正文；符号面来源 = ${symbolSource}）`)
    }
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
  if (!l2Disabled && picked.length === 0) lines.push('- （无可精读的源文件）')

  lines.push(`#### ${LEVEL_L3} · 依赖图 / AST`)
  lines.push(`- 【${L3_NOT_IMPLEMENTED_NOTE}】（本步只交付 L1 + L2）`)

  const text = lines.join('\n')
  return {
    available: true,
    reason: gitError === null ? null : `git 事实不可用（${gitError?.code ?? 'git-failed'}）`,
    level: l2Disabled ? LEVEL_L1 : `${LEVEL_L1}+${LEVEL_L2}`,
    text,
    /** P1-2：把 git 事实**原样回传**，供 Project State 层复用（避免第二次子进程、也避免「永久不可用」） */
    gitFacts,
    gitError,
    l1: { level: LEVEL_L1, available: true, files: allRel.length, gitAvailable: gitFacts !== null },
    l2: { level: LEVEL_L2, available: !l2Disabled, disabled: l2Disabled, maxFiles, filesRead: filesRead.length, symbols: symbolRanges.length, symbolSource, degraded: symbolEngine === null ? true : symbolEngine.degraded },
    l3,
    bundle: { files: [...new Set([...allRel.slice(0, 40), ...filesRead])], ranges: symbolRanges, bytes: Buffer.byteLength(text, 'utf8'), queries: queries.map((q) => q?.literal ?? q?.pattern ?? ''), symbols: symbolRanges, symbolsSource: symbolSource },
    retrievalCalls,
    gitCalls,
    symbolRanges,
    symbolSource,
  }
}
