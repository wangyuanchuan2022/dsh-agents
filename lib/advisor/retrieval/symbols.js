/**
 * retrieval/symbols.js —— **符号级抽取（B4 = S1b，方案 A1）**：web-tree-sitter AST 为主，
 * 正则启发式（S1a 现状）为**显式降级路径**。
 *
 * ## 硬闸门（安全纪律：wasm 是可信输入边界）
 *
 * - vendor wasm 落盘 `lib/advisor/grammars/tree-sitter-javascript.wasm`（411,770 B），
 *   **加载前先做 SHA256 断言**（不匹配 ⇒ **拒载**，降级正则并显式给 reason——上游
 *   `Language.load` 失败只抛**空消息 Error**，无任何诊断，故诊断必须自造）。
 * - `Parser.init()` 进程级 lazy singleton；`Query` 是**顶层具名导出**（0.27.0 下
 *   `Parser.Query` 不是构造器）。
 * - 加载后断言 `Language.abiVersion ∈ [13, 15]`（0.27.0 的支持区间）。
 * - **模块加载期零副作用**（H-4）：所有 init/load 都发生在首次调用 `createSymbolEngine`
 *   之后；不触碰真实 dataDir（wasm 字节从仓内 lib/advisor/grammars/ 或注入 bytes 读取）。
 *
 * ## 降级语义（AC-36 配套）
 *
 * 任何失败（import 失败 / init 失败 / sha 不匹配拒载 / ABI 越界 / parse 异常）⇒
 * 返回 `degraded:true` 的正则引擎，`reason` 写明根因；L2 注入文本与 collect 符号表
 * 都必须把降级态标注出来（**不静默**当 AST 用）。
 *
 * @module dsh-agents/advisor/retrieval/symbols
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** vendor wasm 的 SHA256（硬闸门；来源 tree-sitter-javascript@0.25.0 官方 tarball）。 */
export const EXPECTED_WASM_SHA256 = '5FB488D0CABB4775A594BAB85682DE5AD6CE83C0D6AC997A9F82DD084D571240'
/** vendor wasm 的字节数。 */
export const WASM_EXPECTED_BYTES = 411770
/** web-tree-sitter 0.27.0 支持的 parser ABI 区间。 */
export const ABI_SUPPORTED = [13, 15]

/** 本批（B4）支持符号级解析的源扩展名：**只支持 JavaScript 一族**（AC-56 缺省口径）。 */
export const SUPPORTED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx']

/** 判断一个相对路径是否在支持面内（未支持 ⇒ 调用方必须**显式**标注，不得静默当无语法）。 */
export function isSupportedExtension(rel) {
  const p = String(rel ?? '').toLowerCase()
  return SUPPORTED_EXTENSIONS.some((ext) => p.endsWith(ext))
}

const WASM_REL = path.join('..', 'grammars', 'tree-sitter-javascript.wasm')

/** 正则启发式抽取符号区间（S1a 现状原样保留 = 降级路径的实现本体）。 */
export function extractSymbolsRegex(text, rel) {
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

function regexEngine(reason) {
  return {
    mode: 'regex',
    degraded: true,
    reason: reason ?? '正则启发式（AST 引擎未就绪）',
    extract: (text, rel) => extractSymbolsRegex(text, rel),
  }
}

/**
 * 显式降级封装：把同步抽取体的异常也收进降级态（不向上抛——调用方是注入文本装配，
 * 符号抽取失败不该炸整轮评审，但**必须**在 reason 里可见）。
 */
function withRegexFallback(fn, why) {
  return (text, rel) => {
    try {
      return fn(text, rel)
    } catch (error) {
      return extractSymbolsRegex(text, rel).map((s) => ({ ...s, degraded: true, reason: `${why}: ${error?.message ?? error}` }))
    }
  }
}

/**
 * 构建 AST 符号引擎。**任何一步失败都返回降级正则引擎（degraded:true + reason）**。
 *
 * @param {{wasmBytes?:Uint8Array|Buffer, wasmPath?:string}} [options]
 *   `wasmBytes` = 注入字节（测试用；纯内存，不读盘）；缺省读 vendor wasm。
 * @returns {Promise<{mode:'ast'|'regex', degraded:boolean, reason:string|null,
 *            extract:Function}>}
 */
export async function createSymbolEngine(options = {}) {
  let wasmBytes = options.wasmBytes ?? null
  let wasmFile = options.wasmPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), WASM_REL)
  // 期望哈希：生产恒为常量；测试可用注入字节配套声明（用于打「sha 过门但 wasm 损坏」的 Language.load 诊断路径）
  const expectedSha = options.expectedSha256 ?? EXPECTED_WASM_SHA256
  let sha = null
  try {
    if (wasmBytes === null) wasmBytes = fs.readFileSync(wasmFile)
    wasmBytes = Uint8Array.from(wasmBytes)
    sha = createHash('sha256').update(wasmBytes).digest('hex').toUpperCase()
    // 硬闸门：sha256 不匹配 ⇒ 拒载（绝不把来源不明的字节交给 emscripten 胶水）
    if (sha !== expectedSha) {
      return regexEngine(`wasm sha256 拒载（实得 ${sha.slice(0, 16)}…，期望 ${expectedSha.slice(0, 16)}…，${wasmBytes.length}B）`)
    }
  } catch (error) {
    return regexEngine(`wasm 读取失败（${wasmFile}：${error?.code ?? error?.message ?? error}）⇒ 降级正则启发式`)
  }

  try {
    const mod = await import('web-tree-sitter')
    const { Parser, Language, Query } = mod
    await Parser.init()
    let JS
    try {
      JS = await Language.load(wasmBytes)
    } catch (error) {
      // 上游失败抛空消息 Error——诊断必须自造（文件 + 字节数 + sha + 期望 ABI）
      return regexEngine(`Language.load 失败（bytes=${wasmBytes.length} sha256=${sha.slice(0, 16)}… 期望 ABI ${ABI_SUPPORTED[0]}-${ABI_SUPPORTED[1]}；上游错误消息=${JSON.stringify(error?.message ?? String(error))}）`)
    }
    const abi = JS.abiVersion
    if (!Number.isFinite(abi) || abi < ABI_SUPPORTED[0] || abi > ABI_SUPPORTED[1]) {
      return regexEngine(`grammar ABI ${abi} 越界（支持 ${ABI_SUPPORTED[0]}-${ABI_SUPPORTED[1]}）`)
    }
    const parser = new Parser()
    parser.setLanguage(JS)
    const query = new Query(JS, `
      (function_declaration name: (identifier) @fn.name)
      (class_declaration    name: (identifier) @class.name)
      (method_definition    name: (property_identifier) @method.name)
      (call_expression      function: (identifier) @call.name)
    `)
    const KIND = { 'fn.name': 'function', 'class.name': 'class', 'method.name': 'method', 'call.name': 'call' }
    /**
     * 符号名节点的**父节点类型**到「声明节点」的映射（2026-10-29 补）。
     *
     * ## 为什么需要这个
     *
     * Query 捕获的是 **name 节点**（`(function_declaration name: (identifier) @fn.name)`），
     * 所以 `c.node.startPosition/endPosition` 只覆盖**标识符所在的那一行**。
     * 实测后果：L2「符号精读」按 start/end 切片只能切到 `export function alpha() {`
     * 这一行，**切不到函数体**（`_probe-l2-body` 实测 0/5 行命中）。
     *
     * 修法二选一：改 Query 捕获整节点（会破坏 B4-2 已钉死的 `alpha.start == 2` 判据，
     * 且调用表达式的父节点可能跨多行），或**保留 start/end 语义不动、另给声明区间**。
     * 取后者——`declStart`/`declEnd` 是**新增字段**，既有消费方零影响。
     */
    const DECL_PARENT_OF = {
      'fn.name': new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration']),
      'class.name': new Set(['class_declaration', 'class']),
      'method.name': new Set(['method_definition']),
    }
    const extractAst = (text, rel) => {
      const tree = parser.parse(String(text ?? ''))
      const seen = new Set()
      const out = []
      for (const c of query.captures(tree.rootNode)) {
        const kind = KIND[c.name]
        if (kind === undefined) continue
        const name = c.node.text
        const start = c.node.startPosition.row + 1
        const end = c.node.endPosition.row + 1
        const key = `${start}:${end}:${name}:${kind}`
        if (seen.has(key)) continue
        seen.add(key)
        const entry = { file: rel, start, end, name, symbol: name, kind }
        // 声明区间（尽量给完整声明节点的行范围；拿不到就省略字段，消费方自行回落 start/end）
        const allowed = DECL_PARENT_OF[c.name]
        const parent = c.node.parent
        if (allowed !== undefined && parent !== null && allowed.has(parent.type)) {
          const declStart = parent.startPosition.row + 1
          const declEnd = parent.endPosition.row + 1
          if (Number.isInteger(declStart) && Number.isInteger(declEnd) && declEnd >= declStart) {
            entry.declStart = declStart
            entry.declEnd = declEnd
          }
        }
        out.push(entry)
      }
      return out
    }
    return {
      mode: 'ast',
      degraded: false,
      reason: null,
      extract: withRegexFallback(extractAst, 'AST 抽取异常，降级正则'),
    }
  } catch (error) {
    return regexEngine(`web-tree-sitter 初始化失败（${error?.message ?? error}）⇒ 降级正则启发式`)
  }
}

// ── 进程级 lazy singleton（首次 ensure 时才 init；模块加载期零副作用）──
let enginePromise = null
let engineReady = null // 已就绪的引擎（供同步 peek）

/**
 * 取得（并缓存）符号引擎。缺省路径下失败自动降级，**永不 reject**。
 * 测试可传 `{wasmBytes}` 注入（确定性；不落盘）。
 */
export function ensureSymbolEngine(options = {}) {
  if (engineReady !== null && (options.wasmBytes === undefined)) return Promise.resolve(engineReady)
  if (enginePromise === null || options.wasmBytes !== undefined) {
    enginePromise = createSymbolEngine(options).then((engine) => {
      if (options.wasmBytes === undefined) engineReady = engine
      return engine
    })
  }
  return enginePromise
}

/** 同步 peek：引擎已就绪则返回，否则 null（调用方走正则降级并标注）。 */
export function peekSymbolEngine() {
  return engineReady
}

/**
 * AC-36 的符号级闭包核查：note 引用的符号名 ∈ 本轮符号表。
 * AST 不可用（降级/未就绪）时 `asserted:false`——**降级态不断言符号级**（判据口径）。
 *
 * @param {{symbols?:Array<{name:string}>, symbolsSource?:string}} bundle
 * @param {string[]} symbolRefs
 * @returns {{asserted:boolean, missing:string[], source:string|null}}
 */
export function checkSymbolRefs(bundle, symbolRefs) {
  const symbols = Array.isArray(bundle?.symbols) ? bundle.symbols : []
  const source = typeof bundle?.symbolsSource === 'string' ? bundle.symbolsSource : null
  const astAvailable = symbols.length > 0 && source === 'ast'
  if (!astAvailable) return { asserted: false, missing: [], source }
  const known = new Set(symbols.map((s) => s.name))
  const missing = (symbolRefs ?? []).filter((n) => !known.has(n))
  return { asserted: true, missing, source }
}
