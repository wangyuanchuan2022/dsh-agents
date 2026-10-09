/**
 * retrieval/path-policy.js —— 只读路径边界 + 敏感/二进制/超大拒绝 + **越界 fail-closed + 留痕**。
 *
 * ## 语义（G-16 缺省表 + 产品第 1 条「advisor 不得改文件」）
 *
 * 只读**会话 cwd 工作区内**；显式拒绝：
 *
 * | code | 触发 |
 * |---|---|
 * | `out-of-root` | 解析后不在 `root` 内（含 `..` 逃逸、绝对路径外指） |
 * | `symlink-escape` | 符号链接的 **realpath** 落在 `root` 之外 |
 * | `credential` | `.env*` / `*.pem` / `*.key` / `*.p12` / `id_rsa` / `.npmrc` / `.aws/credentials` 等 |
 * | `git-internals` | 任一路径段为 `.git`（对象库/引用不是评审材料） |
 * | `binary` | 内容含 NUL 字节（首 8KB 探测） |
 * | `oversized` | 字节数 > `maxFileBytes`（缺省 256KB） |
 * | `not-a-file` / `missing` | 目录 / 不存在 |
 *
 * ## 两条硬要求
 *
 * 1. **fail-closed**：越界/被拒一律**显式拒绝**——绝不允许「返回空内容」冒充
 *    「读到了但没内容」（AC-12 的原文禁令）。
 * 2. **可查拒绝记录**：每次拒绝都进 `createRejectionLog()`，可按 code 汇总、
 *    可逐条枚举（AC-12 要求「产生可查拒绝记录」）。
 *
 * ## 本模块的只读性
 *
 * 只使用 `readFileSync` / `statSync` / `realpathSync` / `readdirSync` / `lstatSync`
 * ——**不含任何写文件 API**（受 S1a 判据 13 的源码级禁令约束，本文件无需豁免）。
 *
 * @module dsh-agents/advisor/retrieval/path-policy
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { KB } from './budget.js'

/** 拒绝码（**稳定契约**：面板/记录/测试都按它分支，不得随意改名）。 */
export const REJECT = Object.freeze({
  OUT_OF_ROOT: 'out-of-root',
  SYMLINK_ESCAPE: 'symlink-escape',
  CREDENTIAL: 'credential',
  GIT_INTERNALS: 'git-internals',
  BINARY: 'binary',
  OVERSIZED: 'oversized',
  NOT_A_FILE: 'not-a-file',
  MISSING: 'missing',
  INVALID: 'invalid',
  /** NTFS 备用数据流（ADS）：`file:stream` —— 如 `.env::$DATA`（安全 P1）。 */
  ADS: 'ads-stream',
})

/**
 * 系统级 realpath（**必须用 `.native`**）。
 *
 * 安全 P0（security-reviewer 2026-10-09 实测）：Node 的 **JS 版** `realpathSync`
 * 对 Windows junction 判不出重解析点（`lstatSync(junction).isSymbolicLink() === false`
 * 而 `.isDirectory() === true`），于是**原样返回未解析路径** ——
 * 任何「realpath 是否离开 root」的判据都会被静默短路。
 * `.native` 走系统 realpath，junction / symlink / 8.3 短名都能正确解析。
 */
const nativeRealpath = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

/** Windows 大小写不敏感：包含关系与名字判据一律在**归一化大小写**后比较（安全 P1）。 */
const foldCase = process.platform === 'win32' ? (s) => String(s).toLowerCase() : (s) => String(s)

/** 上抛前的 `..` 逃逸检测：规范化后必须以 root 为前缀（含分隔符边界；Windows 折大小写）。 */
function isInside(root, candidate) {
  const rel = relative(foldCase(root), foldCase(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 单文件读取上限缺省值：256KB（量级口径：远大于任何需要精读的源码文件）。 */
export const DEFAULT_MAX_FILE_BYTES = 256 * KB

/** 二进制探测窗口（首 8KB 内出现 NUL 即判二进制）。 */
export const BINARY_PROBE_BYTES = 8 * KB

/** 凭据类**文件名精确匹配**（大小写不敏感）。 */
export const CREDENTIAL_BASENAMES = Object.freeze([
  '.env', '.env.local', '.env.production', '.env.development', '.envrc',
  '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts',
  'credentials', 'credentials.json', 'service-account.json',
  // security-reviewer P1（2026-10-09）实测放行的 10 个样态中的文件名类：
  'kubeconfig', '.pgpass', 'secrets.yaml', 'secrets.yml', 'key.json',
  'vault.json', 'token.txt', 'private.key.txt', 'terraform.tfstate',
])

/** 凭据类**后缀**（大小写不敏感）。 */
export const CREDENTIAL_EXTENSIONS = Object.freeze([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.asc', '.ppk',
  // security-reviewer P1 实测放行的后缀类：
  '.kdbx', '.jwk', '.tfstate', '.key.txt',
])

/** 凭据类**路径片段**（任一段命中即拒）。 */
export const CREDENTIAL_SEGMENTS = Object.freeze(['.ssh', '.aws', '.gnupg', '.docker', '.kube'])

/** 路径策略错误（fail-closed 的显式产物；调用方**不得** catch 后当空内容处理）。 */
export class PathPolicyError extends Error {
  /**
   * @param {string} code - {@link REJECT} 之一
   * @param {string} rel - 被拒的相对路径（可读形态）
   * @param {string} reason - 人类可读原因
   */
  constructor(code, rel, reason) {
    super(`[advisor retrieval] 路径读取被拒绝（${code}）：${rel} —— ${reason}`)
    this.name = 'PathPolicyError'
    this.code = code
    this.rel = rel
    this.reason = reason
  }
}

/**
 * 可查拒绝记录（有界，环形丢弃最旧）。
 *
 * @param {{limit?:number}} [options]
 */
export function createRejectionLog(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : 200
  const entries = []
  return {
    limit,
    /** 记一条拒绝（`source` 用于区分路径检查 / 内容检查 / 遍历跳过）。 */
    push(entry) {
      const row = {
        at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
        code: typeof entry?.code === 'string' ? entry.code : REJECT.INVALID,
        rel: typeof entry?.rel === 'string' ? entry.rel : '',
        reason: typeof entry?.reason === 'string' ? entry.reason : '',
        source: typeof entry?.source === 'string' ? entry.source : 'path-policy',
      }
      if (Number.isFinite(entry?.size)) row.size = Math.trunc(entry.size)
      entries.push(row)
      while (entries.length > limit) entries.shift()
      return row
    },
    /** 逐条枚举（副本，调用方改不动内部状态）。 */
    list() { return entries.map((e) => ({ ...e })) },
    count() { return entries.length },
    /** 按 code 汇总（AC-12 的「可查」= 既能逐条也能按类点名）。 */
    byCode() {
      const out = {}
      for (const e of entries) out[e.code] = (out[e.code] ?? 0) + 1
      return out
    },
    clear() { entries.length = 0 },
  }
}

/**
 * 建路径策略。
 *
 * @param {{root:string, maxFileBytes?:number, denyExtra?:string[]}} options
 * @returns {{root:string, realRoot:string|null, maxFileBytes:number, check:(rel:string, opts?:object)=>object}}
 */
export function createPathPolicy(options = {}) {
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new Error('[advisor retrieval] createPathPolicy 需要 root（会话 cwd 工作区根）')
  }
  const root = resolve(options.root)
  const maxFileBytes = Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0
    ? Math.trunc(options.maxFileBytes)
    : DEFAULT_MAX_FILE_BYTES
  const denyExtra = Array.isArray(options.denyExtra) ? options.denyExtra.filter((s) => typeof s === 'string') : []
  let realRoot = null
  try { realRoot = nativeRealpath(root) } catch { realRoot = null }

  /**
   * 路径段级检查（凭据 / `.git` 内部）。
   *
   * **段名与文件名一律折大小写**（安全 P1，security-reviewer 2026-10-09）：
   * Windows 文件系统大小写不敏感，`.GIT/config`、`.SSH/config` 在旧实现下
   * 都判不出（`seg === '.git'` / `CREDENTIAL_SEGMENTS.includes(seg)` 是大小写敏感的）
   * ⇒ 绕过 git-internals 与凭据目录禁令。
   *
   * `rel` 传入的应是**规范化后**的相对路径（8.3 短名已被 `realpathSync.native`
   * 还原成长名，故短名同样无法绕过）。
   */
  const segmentVerdict = (rel) => {
    const segments = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
    for (const seg of segments) {
      const segLower = foldCase(seg)
      if (segLower === '.git') return { code: REJECT.GIT_INTERNALS, reason: '.git 内部（对象库/引用）不是评审材料' }
      if (CREDENTIAL_SEGMENTS.includes(segLower)) return { code: REJECT.CREDENTIAL, reason: `凭据类目录：${seg}` }
    }
    const name = segments.length > 0 ? segments[segments.length - 1] : ''
    const lower = foldCase(name)
    if (CREDENTIAL_BASENAMES.includes(lower)) return { code: REJECT.CREDENTIAL, reason: `凭据类文件名：${name}` }
    if (/^\.env(\.|$)/i.test(name)) return { code: REJECT.CREDENTIAL, reason: `环境变量文件：${name}` }
    for (const ext of CREDENTIAL_EXTENSIONS) {
      if (lower.endsWith(ext)) return { code: REJECT.CREDENTIAL, reason: `凭据类后缀：${ext}` }
    }
    for (const pattern of denyExtra) {
      const pat = foldCase(pattern)
      if (lower === pat || foldCase(rel) === pat || foldCase(rel).startsWith(`${pat}/`)) {
        return { code: REJECT.CREDENTIAL, reason: `显式拒绝清单命中：${pattern}` }
      }
    }
    return null
  }

  /**
   * 检查一个候选路径（相对 root 或绝对路径）。
   *
   * @param {string} candidate
   * @param {{includeStat?:boolean}} [opts] `includeStat` = 是否做 stat 级检查（缺省 true）
   * @returns {{ok:true, abs:string, rel:string}|{ok:false, code:string, reason:string, rel:string}}
   */
  const check = (candidate, opts = {}) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      return { ok: false, code: REJECT.INVALID, reason: '空路径', rel: '' }
    }
    // ① NTFS ADS 形态（`file:stream`，如 `.env::$DATA`）：**显式拒绝**。
    //    basename 判据看不见流名（`.env::$DATA` 的 basename 就是它本身），
    //    而 Windows 会把它当 `.env` 的默认数据流读出正文 ⇒ 必须先拦。
    const rawAbs = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate)
    const rawRel = relative(root, rawAbs) === '' ? '.' : relative(root, rawAbs).split(sep).join('/')
    const adsSegment = rawRel.split(/[\\/]+/).find((s) => s.includes(':') && !/^[A-Za-z]:$/.test(s))
    if (adsSegment !== undefined) {
      return { ok: false, code: REJECT.ADS, reason: `NTFS 数据流形态（含 ":" 的段）：${adsSegment}`, rel: rawRel }
    }
    if (!isInside(root, rawAbs)) {
      return { ok: false, code: REJECT.OUT_OF_ROOT, reason: `解析后落在工作区根之外：${rawAbs}`, rel: rawRel }
    }

    // ② **规范化（canonical）解析**：一律用 `realpathSync.native`。
    //
    //    为什么必须是 `.native`（安全 P0，security-reviewer 2026-10-09 实测）：
    //    Node 的 **JS 版** `realpathSync` 走 lstat/readlink，对 **Windows junction**
    //    （`mklink /J`）判不出重解析点（`lstatSync(junction).isSymbolicLink() === false`
    //    而 `.isDirectory() === true`）⇒ **原样返回未解析路径** ⇒ 原来的
    //    `real !== abs` 恒为 false ⇒ **整条 symlink-escape 判据被短路**。
    //    `.native` 版走系统 realpath，能正确解析 junction。
    //
    //    规范化之后再做**名字判据**（`③`）还有一个副作用好处：**8.3 短名**
    //    （`ENV~1` / `GIT~1`）会被解析成真实长名，从而无法绕过名字禁令。
    let effectiveAbs = rawAbs
    if (realRoot !== null) {
      try {
        effectiveAbs = nativeRealpath(rawAbs)
      } catch { /* 不存在/无权限：保持逻辑路径，交给 stat 报 MISSING */ }
      if (!isInside(realRoot, effectiveAbs)) {
        return {
          ok: false,
          code: REJECT.SYMLINK_ESCAPE,
          reason: `路径经规范化后落在工作区之外（junction/symlink/8.3 短名解析）：${effectiveAbs}`,
          rel: rawRel,
        }
      }
    }
    const rel = relative(root, effectiveAbs) === '' ? '.' : relative(root, effectiveAbs).split(sep).join('/')
    // ③ 名字判据（段名/文件名一律 **toLowerCase**；Windows 大小写不敏感，
    //    否则 `.GIT/config`、`.SSH/config` 会绕过；规范化已让 8.3 短名还原成长名）
    const seg = segmentVerdict(rel)
    if (seg !== null) return { ok: false, code: seg.code, reason: seg.reason, rel }
    const abs = effectiveAbs
    if (opts.includeStat === false) return { ok: true, abs, rel }
    let stat
    try {
      stat = statSync(abs)
    } catch (error) {
      return { ok: false, code: error?.code === 'ENOENT' ? REJECT.MISSING : REJECT.INVALID, reason: `stat 失败：${error?.code ?? error}`, rel }
    }
    if (!stat.isFile()) return { ok: false, code: REJECT.NOT_A_FILE, reason: '不是普通文件（目录/设备）', rel }
    if (stat.size > maxFileBytes) {
      return { ok: false, code: REJECT.OVERSIZED, reason: `文件 ${stat.size} 字节 > 上限 ${maxFileBytes}`, rel, size: stat.size }
    }
    return { ok: true, abs, rel, size: stat.size }
  }

  /**
   * 读一个文本文件（**fail-closed**：被拒即抛 {@link PathPolicyError}，绝不返回空串）。
   * 每次拒绝都写入 `log`（若提供）。
   *
   * @param {string} candidate
   * @param {{log?:ReturnType<typeof createRejectionLog>}} [opts]
   * @returns {{ok:true, abs:string, rel:string, text:string, bytes:number, size:number}}
   */
  const readText = (candidate, opts = {}) => {
    const verdict = check(candidate)
    if (!verdict.ok) {
      opts.log?.push({ code: verdict.code, rel: verdict.rel, reason: verdict.reason, size: verdict.size, source: 'path-policy' })
      throw new PathPolicyError(verdict.code, verdict.rel, verdict.reason)
    }
    const buffer = readFileSync(verdict.abs)
    const probe = buffer.subarray(0, BINARY_PROBE_BYTES)
    if (probe.includes(0)) {
      const reason = `二进制内容（首 ${BINARY_PROBE_BYTES} 字节内含 NUL）`
      opts.log?.push({ code: REJECT.BINARY, rel: verdict.rel, reason, size: verdict.size, source: 'path-policy' })
      throw new PathPolicyError(REJECT.BINARY, verdict.rel, reason)
    }
    return {
      ok: true,
      abs: verdict.abs,
      rel: verdict.rel,
      text: buffer.toString('utf8'),
      bytes: buffer.byteLength,
      size: verdict.size,
    }
  }

  /** 只读目录列举（供 walk 用；不写、不建目录）。 */
  const listDir = (abs) => readdirSync(abs, { withFileTypes: true })

  /** 只读 lstat（供 walk 判符号链接）。 */
  const lstat = (abs) => lstatSync(abs)

  return { root, realRoot, maxFileBytes, check, readText, listDir, lstat, join: (...parts) => join(root, ...parts), basename }
}
