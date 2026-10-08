/**
 * retrieval/search.js —— 字面 + 正则检索（**按行返回命中，含行号**）+ 「无对应测试」显式标注。
 *
 * 两条硬约束：
 * 1. **命中必须带行号**（`{file, line, column, text}`）——没有行号的命中对模型不可用，
 *    也无法支撑 AC-36 的「引用路径 ⊆ 本轮检索集」闭包比对；
 * 2. **非法正则 fail-closed 上抛**（绝不静默降级成「没命中」——那会让「查不到」与
 *    「查错了」不可区分）。
 *
 * 符号面口径（S1a 判据 12 / §2.4）：本模块是**正则启发式**，**无语义作用域、无 AST 精度**；
 * 若 B4（tree-sitter）长期不批，AC-36 只断「note 引用的路径 ⊆ 本轮检索集」，不断「符号级发现」。
 *
 * @module dsh-agents/advisor/retrieval/search
 */

/** 「无对应测试」的**逐字**标注（G-17：显式标注并继续，不升级为 concern）。 */
export const NO_TEST_ANNOTATION = '无对应测试'

/** 单次检索的命中上限（防爆量；命中即置 `truncated`，不静默截断）。 */
export const DEFAULT_MAX_HITS = 200

/** 非法查询（正则编译失败 / 空查询）——fail-closed 的显式错误类型。 */
export class QueryError extends Error {
  constructor(message) {
    super(`[advisor retrieval] 查询非法：${message}`)
    this.name = 'QueryError'
  }
}

/**
 * 编译查询：字面量或正则。
 *
 * @param {{literal?:string, pattern?:string, flags?:string, caseInsensitive?:boolean}} query
 * @returns {{kind:'literal'|'pattern', source:string, preview:(line:string)=>object|null}}
 * @throws {QueryError} 空查询 / 非法正则
 */
export function compileQuery(query = {}) {
  const flags = typeof query.flags === 'string' ? query.flags : (query.caseInsensitive === true ? 'i' : '')
  if (typeof query.pattern === 'string' && query.pattern !== '') {
    let re
    try {
      re = new RegExp(query.pattern, flags)
    } catch (error) {
      throw new QueryError(`正则编译失败（${query.pattern}，flags=${flags}）：${error?.message ?? error}`)
    }
    return {
      kind: 'pattern',
      source: `/${query.pattern}/${flags}`,
      preview(line) {
        const m = re.exec(line)
        if (m === null) return null
        return { index: m.index, length: m[0].length, match: m[0] }
      },
    }
  }
  if (typeof query.literal === 'string' && query.literal !== '') {
    const needle = query.caseInsensitive === true ? query.literal.toLowerCase() : query.literal
    return {
      kind: 'literal',
      source: query.literal,
      preview(line) {
        const haystack = query.caseInsensitive === true ? line.toLowerCase() : line
        const index = haystack.indexOf(needle)
        if (index < 0) return null
        return { index, length: needle.length, match: line.slice(index, index + needle.length) }
      },
    }
  }
  throw new QueryError('必须给 literal 或 pattern 之一（两者皆空 = 无法判定「查不到」还是「查错了」）')
}

/**
 * 在**一段文本**里检索，返回逐行命中（1-based 行号）。
 *
 * @param {string} text
 * @param {ReturnType<typeof compileQuery>} compiled
 * @param {{maxHits?:number, file?:string}} [opts]
 * @returns {{hits:Array<{file:string,line:number,column:number,text:string,match:string}>, truncated:boolean}}
 */
export function searchText(text, compiled, opts = {}) {
  const maxHits = Number.isFinite(opts.maxHits) && opts.maxHits > 0 ? Math.trunc(opts.maxHits) : DEFAULT_MAX_HITS
  const file = typeof opts.file === 'string' ? opts.file : ''
  const hits = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (hits.length >= maxHits) return { hits, truncated: true }
    const hit = compiled.preview(lines[i])
    if (hit === null) continue
    hits.push({ file, line: i + 1, column: hit.index + 1, text: lines[i], match: hit.match })
  }
  return { hits, truncated: false }
}

/**
 * 在多文件上检索（**只读**：经 `policy.readText` 读，被拒文件进 `rejected` 留痕）。
 *
 * @param {{policy:object, files:Array<{rel:string}|string>, query:object, maxHits?:number,
 *          log?:object}} options
 * @returns {{hits:Array<object>, scanned:number, rejected:Array<object>, truncated:boolean, query:string}}
 */
export function searchFiles(options = {}) {
  const policy = options.policy
  if (policy === null || typeof policy?.readText !== 'function') {
    throw new Error('[advisor retrieval] searchFiles 需要 path-policy 实例（policy）')
  }
  const compiled = options.compiled ?? compileQuery(options.query ?? {})
  const maxHits = Number.isFinite(options.maxHits) && options.maxHits > 0
    ? Math.trunc(options.maxHits) : DEFAULT_MAX_HITS
  const files = Array.isArray(options.files) ? options.files : []
  const hits = []
  const rejected = []
  let scanned = 0
  let truncated = false
  for (const file of files) {
    if (hits.length >= maxHits) { truncated = true; break }
    const rel = typeof file === 'string' ? file : file?.rel
    if (typeof rel !== 'string' || rel === '') continue
    let read
    try {
      read = policy.readText(rel, { log: options.log })
    } catch (error) {
      rejected.push({ rel, code: error?.code ?? 'read-failed', reason: error?.reason ?? error?.message ?? '' })
      continue
    }
    scanned += 1
    const found = searchText(read.text, compiled, { maxHits: maxHits - hits.length, file: rel })
    hits.push(...found.hits)
    if (found.truncated) { truncated = true; break }
  }
  return { hits, scanned, rejected, truncated, query: compiled.source }
}

/**
 * 由源文件路径推出**候选测试文件**（正则启发式，不依赖任何依赖表）。
 *
 * @param {string} sourceRel - 例 `src/foo.js`
 * @returns {string[]} 候选相对路径（按优先级排列，去重）
 */
export function testCandidatesFor(sourceRel) {
  const parts = String(sourceRel ?? '').split('/').filter((s) => s !== '')
  if (parts.length === 0) return []
  const name = parts.pop()
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const dir = parts.join('/')
  const out = []
  const push = (p) => { if (p !== '' && !out.includes(p)) out.push(p) }
  if (dir !== '') {
    push(`${dir}/${stem}.test${ext}`)
    push(`${dir}/__tests__/${stem}.test${ext}`)
    push(`${dir}/${stem}.spec${ext}`)
  }
  push(`test/${stem}.test${ext}`)
  push(`tests/${stem}.test${ext}`)
  push(`__tests__/${stem}.test${ext}`)
  push(`test/${stem}${ext}`)
  if (dir !== '') push(`test/${dir}/${stem}.test${ext}`)
  return out
}

/**
 * 找源文件的对应测试（AC-3）：**找不到必须给显式标注**，不得静默省略。
 *
 * @param {{files:Array<{rel:string}|string>, sourceRel:string}} input
 * @returns {{source:string, candidates:string[], tests:string[], annotation:string|null}}
 */
export function findRelatedTests(input = {}) {
  const present = new Set((Array.isArray(input.files) ? input.files : []).map((f) => (typeof f === 'string' ? f : f?.rel)).filter(Boolean))
  const candidates = testCandidatesFor(input.sourceRel)
  const tests = candidates.filter((c) => present.has(c))
  return {
    source: String(input.sourceRel ?? ''),
    candidates,
    tests,
    annotation: tests.length === 0 ? NO_TEST_ANNOTATION : null,
  }
}
