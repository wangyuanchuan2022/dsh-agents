/**
 * retrieval/git.js —— **fd-stdio** 封装的只读 git 面（`rev-parse` / `log` / `diff --numstat` / `status --porcelain`）。
 *
 * ## 为什么是 fd-stdio 而不是 pipe
 *
 * 本机受限沙箱里 `node` 的**管道捕获必 EPERM**（L1-01；`tests/skill-sync-check.mjs:255-256`
 * 与 B0 的 `tests/isolation-gate.mjs` 已实测）。故子进程输出走文件描述符继承：
 *
 * ```js
 * const fd = fs.openSync(tmpPath, 'w')                       // ← 计划 S1a 判据 13 豁免②
 * spawnSync('git', argv, { cwd, stdio: ['ignore', fd, fd] })
 * ```
 *
 * ## 三道只读/安全约束
 *
 * 1. **子命令白名单**：只允许 {@link GIT_READONLY_SUBCOMMANDS}，别的子命令（含 `-c`、
 *    `--upload-pack`、`config --global` 之类）**直接抛错**——不靠调用方自觉；
 * 2. **argv 直传**：参数以**数组元素**逐个传给 `spawnSync`，**永不经 shell**（无
 *    `exec(` / `execSync(` / `spawn(` 拼接形态；AC-10① 源码级断言）。
 *    载荷（`; rm -rf /`、`$(...)`、`&& del`）作为**位置参数**原样传递、不被解释（AC-10②）；
 * 3. **标志白名单**：只允许各子命令的已知只读标志（`--numstat` / `--porcelain` /
 *    `--oneline` / `--max-count=` / `--grep=` / `--abbrev-ref` / `--is-inside-work-tree`），
 *    其它 `--xxx` 一律拒绝（防「参数位被当成开关」）。
 *
 * ## fail-closed
 *
 * 子进程启动失败 / 非零退出 / 超时**一律抛 {@link GitError}**，**绝不静默返回空串**
 * （H-1/H-11：不得静默 skip；「查不到」与「查错了」必须可区分）。
 *
 * @module dsh-agents/advisor/retrieval/git
 */

import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { join } from 'node:path'

/** 允许的只读子命令（白名单外一律拒绝）。 */
export const GIT_READONLY_SUBCOMMANDS = Object.freeze(['rev-parse', 'log', 'diff', 'status'])

/** 各子命令允许的只读标志（前缀匹配 `key=` 形态；`-n` 走 `--max-count=`）。 */
export const GIT_ALLOWED_FLAGS = Object.freeze({
  'rev-parse': ['--abbrev-ref', '--is-inside-work-tree', '--short', '--verify', '--show-toplevel'],
  log: ['--oneline', '--max-count=', '--grep=', '--no-merges', '--name-only'],
  diff: ['--numstat', '--name-only', '--stat', '--no-color'],
  status: ['--porcelain'],
})

/** 单次 git 子进程超时（毫秒）。 */
export const GIT_TIMEOUT_MS = 10000

/**
 * 传给 git 子进程的**最小环境变量白名单**（安全 P1，security-reviewer 2026-10-09 实测）。
 *
 * 实测事故：不传 `env` 时子进程**完整继承父环境**；只要父进程里有 `GIT_DIR=<另一仓>/.git`，
 * advisor 的 `headSha()` 就会**静默变成另一个仓库**的 HEAD（`f33a17a6` → `17c5f4ed`），无任何报错。
 * ⇒ 一律传本白名单（**按构造剔除全部 `GIT_*`**），只留 git 正常运行必需的系统变量。
 *
 * 白名单口径：能跑起 git 且能找到系统配置的最小集（PATH 定位可执行、SystemRoot/WINDIR 供
 * Windows DLL、TEMP/TMP 供临时文件、HOME/USERPROFILE 供用户级 git config）。
 */
export function minimalGitEnv(base = process.env) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive',
    'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'LC_CTYPE',
  ]
  const out = {}
  for (const key of allowed) {
    const value = base?.[key]
    if (typeof value === 'string') out[key] = value
  }
  // 断言式自证：白名单里**不可能**出现任何 GIT_* 键（注入面在构造上被关闭）
  for (const key of Object.keys(out)) {
    if (key.toUpperCase().startsWith('GIT_')) delete out[key]
  }
  return out
}

/** git 面错误（fail-closed 的显式产物）。 */
export class GitError extends Error {
  /**
   * @param {string} code - `GIT_FAILED` / `GIT_TIMEOUT` / `GIT_SPAWN_ERROR` / `GIT_SUBCOMMAND_DENIED` / `GIT_FLAG_DENIED` / `GIT_SCRATCH_MISSING`
   * @param {string} message
   * @param {{argv?:string[], status?:number|null, stderr?:string}} [detail]
   */
  constructor(code, message, detail = {}) {
    super(`[advisor retrieval] git ${code}：${message}`)
    this.name = 'GitError'
    this.code = code
    this.argv = detail.argv ?? []
    this.status = detail.status ?? null
    this.stderr = detail.stderr ?? ''
  }
}

/** 临时输出文件名（**只含进程号与序号**，不含任何外部输入，防注入文件名）。 */
export function tempFileName(pid, seq) {
  return `.advisor-retrieval-${pid}-${seq}.out`
}

/**
 * 校验 argv 是否落在只读白名单内（不合法即抛，不返回 false 让调用方忘记处理）。
 *
 * @param {string[]} argv - **不含** `'git'` 自身的参数数组
 */
export function assertReadonlyArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
    throw new GitError('GIT_SUBCOMMAND_DENIED', 'argv 必须是非空数组，且首元素为子命令名')
  }
  const sub = argv[0]
  if (!GIT_READONLY_SUBCOMMANDS.includes(sub)) {
    throw new GitError('GIT_SUBCOMMAND_DENIED', `子命令 ${sub} 不在只读白名单 ${GIT_READONLY_SUBCOMMANDS.join('/')} 内`)
  }
  const allowed = GIT_ALLOWED_FLAGS[sub] ?? []
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string') throw new GitError('GIT_FLAG_DENIED', `非字符串参数：${String(arg)}`)
    if (!arg.startsWith('-')) continue // 位置参数（ref / path / grep 载荷）原样直传
    const ok = allowed.some((flag) => (flag.endsWith('=') ? arg.startsWith(flag) : arg === flag))
    if (!ok) throw new GitError('GIT_FLAG_DENIED', `子命令 ${sub} 不允许标志 ${arg}（允许：${allowed.join(' ')}）`)
  }
  return true
}

/** 解析 `status --porcelain`：→ `[{x, y, path, untracked}]`。 */
export function parsePorcelain(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const path = line.slice(3).trim()
    rows.push({ x, y, path, untracked: x === '?' && y === '?' })
  }
  return rows
}

/** 解析 `diff --numstat`：→ `[{added, deleted, path}]`（二进制记 `null`）。 */
export function parseNumstat(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [added, deleted, ...rest] = line.split('\t')
    if (rest.length === 0) continue
    rows.push({
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
      path: rest.join('\t'),
      binary: added === '-' || deleted === '-',
    })
  }
  return rows
}

/** 解析 `log --oneline`：→ `[{sha, subject}]`。 */
export function parseLog(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const sp = line.indexOf(' ')
    rows.push(sp < 0 ? { sha: line.trim(), subject: '' } : { sha: line.slice(0, sp), subject: line.slice(sp + 1) })
  }
  return rows
}

/**
 * 建只读 git 读取器。
 *
 * @param {{cwd:string, scratchDir:string, fs?:object, spawnSync?:Function, timeoutMs?:number,
 *          pid?:number}} options
 * @returns {object} 读取面 + `argvOf()`（AC-10② 的 argv 断言用）
 */
export function createGitReader(options = {}) {
  if (typeof options.cwd !== 'string' || options.cwd === '') throw new GitError('GIT_FAILED', 'createGitReader 需要 cwd')
  if (typeof options.scratchDir !== 'string' || options.scratchDir === '') {
    throw new GitError('GIT_SCRATCH_MISSING', 'createGitReader 需要 scratchDir（fd-stdio 临时文件必须落在隔离门可见根内）')
  }
  const fs = options.fs ?? { openSync, closeSync, readFileSync, unlinkSync }
  const spawnSync = options.spawnSync ?? nodeSpawnSync
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : GIT_TIMEOUT_MS
  const pid = Number.isFinite(options.pid) ? Math.trunc(options.pid) : process.pid
  let seq = 0
  const spawns = []

  /** 单次执行：**唯一**的子进程出入口（argv 直传 + fd-stdio + fail-closed + 临时文件必删）。 */
  const run = (argv, label) => {
    assertReadonlyArgv(argv)
    seq += 1
    const tmpPath = join(options.scratchDir, tempFileName(pid, seq))
    let fd = null
    let result = null
    let text = ''
    let spawnError = null
    try {
      fd = fs.openSync(tmpPath, 'w') // ← 豁免②：fd-stdio 子进程输出句柄（只写子进程输出，不写业务数据）
      result = spawnSync('git', argv, {
        cwd: options.cwd,
        stdio: ['ignore', fd, fd],
        timeout: timeoutMs,
        windowsHide: true,
        // 最小 env（安全 P1）：绝不继承父环境的 GIT_*（`GIT_DIR` 实测可静默重定向仓库）
        env: minimalGitEnv(options.env ?? process.env),
      })
      text = fs.readFileSync(tmpPath, 'utf8')
    } catch (error) {
      spawnError = error
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关忽略 */ } }
      try { fs.unlinkSync(tmpPath) } catch { /* 已删忽略 */ } // ← 豁免②：临时文件生命周期（用完即删）
    }
    spawns.push({ label, argv: ['git', ...argv], tmpPath })
    if (spawnError !== null) {
      throw new GitError('GIT_SPAWN_ERROR', `${label} 启动/读取失败：${spawnError?.message ?? spawnError}`, { argv: ['git', ...argv] })
    }
    if (result?.error !== undefined && result.error !== null) {
      const code = result.error.code === 'ETIMEDOUT' ? 'GIT_TIMEOUT' : 'GIT_SPAWN_ERROR'
      throw new GitError(code, `${label} 子进程错误：${result.error.message}`, { argv: ['git', ...argv] })
    }
    if (result?.status !== 0) {
      throw new GitError('GIT_FAILED', `${label} 非零退出（status=${result?.status}）：${text.trim().slice(0, 200)}`, {
        argv: ['git', ...argv], status: result?.status ?? null, stderr: text.slice(0, 2000),
      })
    }
    return { text, status: result?.status ?? 0, argv: ['git', ...argv] }
  }

  return {
    cwd: options.cwd,
    scratchDir: options.scratchDir,
    /** 执行过的子进程记录（**取证用**：argv 逐元素可断言，AC-10②）。 */
    spawns: () => spawns.map((s) => ({ ...s, argv: [...s.argv] })),
    /** 纯函数：把参数数组还原成完整 argv（不执行）。 */
    argvOf: (argv) => { assertReadonlyArgv(argv); return ['git', ...argv] },
    /** 是否在 git 工作树内（不抛错，仅探测）。 */
    available() {
      try { run(['rev-parse', '--is-inside-work-tree'], 'is-inside-work-tree'); return true } catch { return false }
    },
    headSha() { return run(['rev-parse', 'HEAD'], 'rev-parse HEAD').text.trim() },
    branch() { return run(['rev-parse', '--abbrev-ref', 'HEAD'], 'rev-parse --abbrev-ref HEAD').text.trim() },
    statusPorcelain() { return parsePorcelain(run(['status', '--porcelain'], 'status --porcelain').text) },
    statusText() { return run(['status', '--porcelain'], 'status --porcelain').text },
    /** `diff --numstat <from> <to>`；`from`/`to` 作为位置参数**原样直传**。 */
    diffNumstat({ from = 'HEAD', to = null } = {}) {
      const argv = ['diff', '--numstat', from]
      if (typeof to === 'string' && to !== '') argv.push(to)
      return parseNumstat(run(argv, `diff --numstat ${argv.slice(2).join(' ')}`).text)
    },
    /** `log --oneline --max-count=<limit>`。 */
    recentLog({ limit = 10 } = {}) {
      const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 10
      return parseLog(run(['log', '--oneline', `--max-count=${n}`], `log --oneline --max-count=${n}`).text)
    },
    /**
     * `log --oneline --grep=<needle>`：**载荷原样直传**（AC-10② 的注入位）。
     * `needle` 含 `;` / `$()` / `&&` 时不解释、不过滤，只作为一个 argv 元素。
     */
    grepLog({ needle, limit = 10 } = {}) {
      const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 10
      const argv = ['log', '--oneline', `--max-count=${n}`, `--grep=${String(needle ?? '')}`]
      return parseLog(run(argv, 'log --grep=<needle>').text)
    },
    /** AC-2(d) 的「git 事实」：一次拿到 sha / 分支 / 状态摘要 / 最近提交。 */
    facts() {
      const sha = this.headSha()
      const branch = this.branch()
      const status = this.statusPorcelain()
      const log = this.recentLog({ limit: 5 })
      return {
        headSha: sha,
        branch,
        statusSummary: { total: status.length, modified: status.filter((r) => !r.untracked).length, untracked: status.filter((r) => r.untracked).length },
        statusPaths: status.map((r) => r.path),
        recent: log,
      }
    },
  }
}
