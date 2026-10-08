/**
 * retrieval/walk.js —— 递归遍历 + `.gitignore` / `.gitattributes` 解析 + 排除表（**只读**）。
 *
 * 设计口径：
 * - **默认路径 = 纯 `node:fs` 遍历**（子进程只作可选增强，见 `git.js`）；
 * - 排除表硬编码为 `DEFAULT_EXCLUDED_DIRS`（`node_modules` / `.git` / `.idea` / `backup`
 *   / `review` / `agent-out`）——前两者是体积与语义原因，后四者是本仓的过程物/评审物，不进评审材料；
 * - `.gitignore` 语义**按目录栈**生效（git 的真实语义：子目录规则覆盖父目录），支持
 *   `!` 取反、尾 `/` 仅目录、前导 `/` 或含 `/` 锚定、`*` / `?` / `**`；
 * - `.gitattributes` 只解析出「哪些路径被判为 binary/`-text`」，作为**第二信号**（第一信号
 *   是 NUL 探测，见 `path-policy.js`）；
 * - 符号链接目录一律**不跟随**（防环、防越界；越界另有 `path-policy` 的 realpath 检查）；
 * - 全部拒绝/跳过都**留痕**（`rejected` / `excluded`），不静默丢。
 *
 * @module dsh-agents/advisor/retrieval/walk
 */

import { createHash } from 'node:crypto'

/** 遍历默认排除的目录名（任一路径段命中即整棵跳过）。 */
export const DEFAULT_EXCLUDED_DIRS = Object.freeze([
  'node_modules', '.git', '.idea', 'backup', 'review', 'agent-out',
])

/** 遍历上限（防失控；命中即置 `truncated=true`，**不静默截断**）。 */
export const DEFAULT_MAX_ENTRIES = 5000

/** 遍历深度上限（相对根的层数）。 */
export const DEFAULT_MAX_DEPTH = 12

/**
 * 把一条 glob 编译成正则（gitignore 语义子集）。
 *
 * @param {string} pattern - 不含 `!`/尾 `/` 的纯模式（调用方先剥离）
 * @param {{dirOnly:boolean}} meta
 * @returns {RegExp}
 */
function globToRegExp(pattern, meta) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 跨目录；`**` 结尾也跨目录
        if (pattern[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2 } else { out += '.*'; i += 1 }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') { out += '[^/]'; continue }
    if ('\\^$.|+()[]{}'.includes(ch)) { out += `\\${ch}`; continue }
    out += ch
  }
  return new RegExp(meta.anchored ? `^${out}${meta.dirOnly ? '/?$' : '$'}` : `(?:^|/)${out}${meta.dirOnly ? '/?$' : '$'}`)
}

/**
 * 解析 `.gitignore` 文本 → 规则数组。
 *
 * @param {string} text
 * @returns {Array<{negated:boolean, dirOnly:boolean, anchored:boolean, source:string, re:RegExp}>}
 */
export function parseGitignore(text) {
  const rules = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let body = line
    let negated = false
    if (body.startsWith('!')) { negated = true; body = body.slice(1) }
    let dirOnly = false
    if (body.endsWith('/')) { dirOnly = true; body = body.slice(0, -1) }
    const anchored = body.includes('/')
    if (body.startsWith('/')) body = body.slice(1)
    if (body === '') continue
    rules.push({ negated, dirOnly, anchored, source: line, re: globToRegExp(body, { dirOnly, anchored }) })
  }
  return rules
}

/**
 * 解析 `.gitattributes` 文本 → 规则数组（只取 pattern 与属性串）。
 *
 * @param {string} text
 * @returns {Array<{pattern:string, attrs:string[], source:string}>}
 */
export function parseGitattributes(text) {
  const rules = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [pattern, ...attrs] = line.split(/\s+/)
    if (typeof pattern !== 'string' || pattern === '') continue
    rules.push({ pattern, attrs, source: line })
  }
  return rules
}

/** 该路径是否被 `.gitattributes` 判为二进制/非文本（`-text` 或 `binary`）。 */
export function isBinaryAttr(rules, rel) {
  const name = rel.split('/').pop() ?? rel
  let verdict = false
  for (const rule of Array.isArray(rules) ? rules : []) {
    const pat = rule.pattern.replace(/^\//, '')
    const hit = pat.startsWith('*.') ? name.endsWith(pat.slice(1))
      : (pat === rel || pat === name || (pat.endsWith('/*') && rel.startsWith(pat.slice(0, -1))))
    if (!hit) continue
    for (const attr of rule.attrs) {
      if (attr === 'binary' || attr === '-text' || attr === 'text=false') verdict = true
      if (attr === 'text' || attr === '-binary') verdict = false
    }
  }
  return verdict
}

/**
 * 建「按目录栈生效」的 gitignore 匹配器（子目录规则覆盖父目录，最后命中者胜）。
 */
export function createIgnoreMatcher() {
  const stack = []
  return {
    /** @param {string} baseRel 该 `.gitignore` 所在目录的相对路径（根为 ''） */
    push(baseRel, text) { stack.push({ baseRel, rules: parseGitignore(text) }) },
    pop() { stack.pop() },
    size() { return stack.length },
    /** @returns {boolean} 是否被忽略 */
    isIgnored(rel, isDir) {
      let ignored = false
      for (const layer of stack) {
        const { baseRel, rules } = layer
        let candidate = rel
        if (baseRel !== '') {
          if (!(rel === baseRel || rel.startsWith(`${baseRel}/`))) continue // 该层只管自己子树
          candidate = rel.slice(baseRel.length + 1)
          if (candidate === '') continue
        }
        for (const rule of rules) {
          if (rule.dirOnly && !isDir) continue
          if (rule.re.test(candidate)) ignored = !rule.negated
        }
      }
      return ignored
    },
  }
}

/**
 * 递归列举工作区内的候选文件（**只读**）。
 *
 * @param {{policy:object, excludedDirs?:string[], maxEntries?:number, maxDepth?:number,
 *          ignore?:ReturnType<typeof createIgnoreMatcher>}} options
 * @returns {{files:Array<{rel:string,size:number}>, excluded:Array<object>, rejected:Array<object>,
 *            attributes:Array<object>, truncated:boolean, scannedDirs:number}}
 */
export function listFiles(options = {}) {
  const policy = options.policy
  if (policy === null || typeof policy?.listDir !== 'function') {
    throw new Error('[advisor retrieval] listFiles 需要 path-policy 实例（policy）')
  }
  const excludedDirs = new Set(
    (Array.isArray(options.excludedDirs) && options.excludedDirs.length > 0
      ? options.excludedDirs
      : DEFAULT_EXCLUDED_DIRS).filter((s) => typeof s === 'string'),
  )
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
    ? Math.trunc(options.maxEntries) : DEFAULT_MAX_ENTRIES
  const maxDepth = Number.isFinite(options.maxDepth) && options.maxDepth >= 0
    ? Math.trunc(options.maxDepth) : DEFAULT_MAX_DEPTH
  const ignore = options.ignore ?? createIgnoreMatcher()

  const files = []
  const excluded = []
  const rejected = []
  const attributes = []
  let truncated = false
  let scannedDirs = 0

  const loadSideFiles = (absDir, relDir) => {
    for (const name of ['.gitignore', '.gitattributes']) {
      const rel = relDir === '' ? name : `${relDir}/${name}`
      const verdict = policy.check(rel)
      if (!verdict.ok) continue
      try {
        const { text } = policy.readText(rel)
        if (name === '.gitignore') ignore.push(relDir, text)
        else attributes.push(...parseGitattributes(text))
      } catch { /* 侧文件读不了不算致命（它本身不是评审材料） */ }
    }
  }

  const walkDir = (absDir, relDir, depth) => {
    if (depth > maxDepth) { excluded.push({ rel: relDir, code: 'depth-limit', reason: `超过深度上限 ${maxDepth}` }); return }
    scannedDirs += 1
    const before = ignore.size()
    loadSideFiles(absDir, relDir)
    let entries
    try {
      entries = policy.listDir(absDir)
    } catch (error) {
      rejected.push({ rel: relDir, code: 'unreadable-dir', reason: `readdir 失败：${error?.code ?? error}` })
      for (let i = before; i < ignore.size(); i += 1) ignore.pop()
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (files.length >= maxEntries) { truncated = true; break }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const abs = policy.join(rel)
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) { excluded.push({ rel, code: 'excluded-dir', reason: `排除表命中：${entry.name}` }); continue }
        if (ignore.isIgnored(rel, true)) { excluded.push({ rel, code: 'gitignored', reason: '被 .gitignore 忽略' }); continue }
        walkDir(abs, rel, depth + 1)
        continue
      }
      if (entry.isSymbolicLink()) { excluded.push({ rel, code: 'symlink', reason: '符号链接不跟随' }); continue }
      if (ignore.isIgnored(rel, false)) { excluded.push({ rel, code: 'gitignored', reason: '被 .gitignore 忽略' }); continue }
      const verdict = policy.check(rel)
      if (!verdict.ok) { rejected.push({ rel: verdict.rel, code: verdict.code, reason: verdict.reason, size: verdict.size }); continue }
      files.push({ rel: verdict.rel, size: verdict.size })
    }
    for (let i = before; i < ignore.size(); i += 1) ignore.pop()
  }

  walkDir(policy.root, '', 0)
  return { files, excluded, rejected, attributes, truncated, scannedDirs }
}

/**
 * 对工作树做**内容哈希快照**（AC-11：评审前后逐字节完全相同）。
 *
 * 口径：tracked 与 untracked **一视同仁**（都在根下递归），每文件记 `rel + size + sha256`；
 * 排除表与 `.gitignore` 同样生效（否则 `node_modules` 会让快照慢到不可用）。
 *
 * @param {{policy:object, excludedDirs?:string[], maxEntries?:number}} options
 * @returns {{entries:Array<{rel:string,size:number,sha256:string}>, digest:string, truncated:boolean}}
 */
export function snapshotWorktree(options = {}) {
  const listed = listFiles(options)
  const entries = []
  for (const file of listed.files) {
    try {
      const read = options.policy.readText(file.rel)
      entries.push({ rel: file.rel, size: read.bytes, sha256: createHash('sha256').update(read.text, 'utf8').digest('hex') })
    } catch (error) {
      entries.push({ rel: file.rel, size: file.size, sha256: `<rejected:${error?.code ?? '?'}>` })
    }
  }
  const digest = createHash('sha256').update(entries.map((e) => `${e.rel}:${e.size}:${e.sha256}`).join('\n'), 'utf8').digest('hex')
  return { entries, digest, truncated: listed.truncated }
}
