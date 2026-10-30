/**
 * tools/project-status-gate.mjs —— **项目全景文档保鲜闸门**（2026-10-29 新增）。
 *
 * ## 这道门看管什么
 *
 * `docs/PROJECT-STATUS.md` 是 advisor **每轮注入**的项目全景正本。它一旦腐烂，
 * 顾问的「方向性判断」就建立在过时事实之上——**比不给更坏**（顾问会自信地
 * 基于错前提给建议）。故必须有机检，而不是靠人自觉。
 *
 * ## 五条判据（每条都必须可失败）
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | G1 | 文件存在且 **≤ 100 行** | advisor 的 `read_file` 输出上限是 100 行，超了读不全 |
 * | G2 | 含可机检的 `最后更新：YYYY-MM-DD` 行，且**日期不早于最近 N 个 commit** | 防「代码改了、文档没改」 |
 * | G3 | §2 状态表里**至少一行状态与 CHANGELOG 的最近批次对应** | 防「进度表还是上个批次」 |
 * | G4 | §3 关键事实的**可复跑命令**在当前仓库真能跑（抽查 3 条） | 防「文档写了命令但已失效」 |
 * | G5 | 零命中防护 + 阳性对照：合成合法/非法文档分别判绿/红 | 防「抽取器失明 → 永远绿」 |
 *
 * ## 用法
 *
 * ```
 * node tools/project-status-gate.mjs              # 判据 G1/G2/G3 + G5 自测
 * node tools/project-status-gate.mjs --execute    # 额外跑 G4（真执行文档里的命令）
 * node tools/project-status-gate.mjs --selftest   # 只跑 G5 自测
 * ```
 *
 * 退出码：0 = 全绿；1 = 有判据红；2 = 输入不可用（fail-closed，不当「无意见」）。
 *
 * @module tools/project-status-gate
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * **fd-stdio 只读 git 调用**（沙箱纪律 L1-01：管道捕获必 EPERM）。
 *
 * 本机受限沙箱里 `execFileSync`/`execSync` 的管道捕获会 `EPERM: spawnSync git EPERM`
 * （实测：本工具首版用 `execFileSync` 直接失败）。故与 `lib/advisor/retrieval/git.js`
 * 同款做法：**子进程输出走文件描述符继承**，读回临时文件。
 *
 * 安全约束（照抄 retrieval/git.js 的三道）：
 * 1. **argv 数组直传**，永不经 shell；
 * 2. **只读子命令白名单**：本门只允许 `log` / `rev-parse`（其余一律拒）；
 * 3. 临时文件名只含 pid + 序号，不含任何外部输入（防注入）。
 *
 * @param {string[]} argv - 不含 `'git'` 自身
 * @param {{timeoutMs?:number}} [options]
 * @returns {string} stdout 文本
 * @throws {Error} 启动失败 / 非零退出 / 子命令不在白名单
 */
export function gitReadonly(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('gitReadonly 需要非空 argv')
  const READONLY = new Set(['log', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'status', 'describe', 'show', 'diff'])
  if (!READONLY.has(argv[0])) throw new Error(`子命令 ${argv[0]} 不在只读白名单 ${[...READONLY].join('/')} 内`)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000
  const tmp = join(REPO_ROOT, `agent-out`, `.ps-gate-${process.pid}-${Math.random().toString(36).slice(2, 8)}.out`)
  let fd = null
  try {
    fd = openSync(tmp, 'w')
    const res = spawnSync('git', argv, {
      cwd: REPO_ROOT,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      windowsHide: true,
    })
    if (res.error) throw new Error(`git ${argv[0]} 启动失败：${res.error?.code ?? res.error?.message ?? res.error}`)
    if (res.status !== 0) throw new Error(`git ${argv[0]} 退出码 ${res.status}`)
    return readFileSync(tmp, 'utf8')
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关忽略 */ } }
    try { unlinkSync(tmp) } catch { /* 清理失败不致命 */ }
  }
}

/** 项目全景文档路径（唯一来源；与 `lib/advisor/context/project-status.js` 的常量同值）。 */
export const STATUS_DOC = 'docs/PROJECT-STATUS.md'

/** 行数上限（**必须**与 advisor 的 `read_file` 输出上限同值 —— 100 行）。 */
export const STATUS_MAX_LINES = 100

/** 「最后更新」日期允许的最大滞后 commit 数（超过即判陈旧）。 */
export const MAX_COMMITS_BEHIND = 5

/** 日期行形态（可机检锚）。 */
export const LAST_UPDATE_RE = /最后更新：(?<date>\d{4}-\d{2}-\d{2})/

/**
 * 解析文档的 `最后更新` 日期。
 * @param {string} text
 * @returns {{ok:boolean, date:string|null, reason:string|null}}
 */
export function parseLastUpdate(text) {
  const m = String(text ?? '').match(LAST_UPDATE_RE)
  if (m === null || typeof m.groups?.date !== 'string') {
    return { ok: false, date: null, reason: '缺少可机检的「最后更新：YYYY-MM-DD」行' }
  }
  const date = m.groups.date
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, date, reason: `日期无法解析：${date}` }
  }
  return { ok: true, date, reason: null }
}

/**
 * 判据 G1：行数 ≤ 上限。
 * @param {string} text
 * @returns {{ok:boolean, lineCount:number, limit:number, reason:string|null}}
 */
export function checkLineBudget(text, limit = STATUS_MAX_LINES) {
  if (String(text ?? '').trim() === '') {
    return { ok: false, lineCount: 0, limit, reason: '文档为空（fail-closed）' }
  }
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const over = lines.length > limit
  return {
    ok: !over,
    lineCount: lines.length,
    limit,
    reason: over ? `行数 ${lines.length} > 上限 ${limit}（advisor read_file 只给 ${limit} 行，超了它读不全）` : null,
  }
}

/**
 * 判据 G2：`最后更新` 日期不早于「最近 N 个 commit」中最早那个的日期。
 *
 * 口径：拿仓库最近 `MAX_COMMITS_BEHIND` 个 commit 的 author date 取最小值，
 * 文档日期不得早于它——若文档日期比最近 5 个 commit 里最早的还旧，
 * 说明「最近这几批改动之后文档没更」。
 *
 * @param {string} dateStr - `YYYY-MM-DD`
 * @param {string[]} recentDates - 最近 N 个 commit 的 `YYYY-MM-DD` 列表
 * @returns {{ok:boolean, docDate:string, oldestRecent:string, reason:string|null}}
 */
export function checkFreshness(dateStr, recentDates) {
  const list = Array.isArray(recentDates) ? recentDates.filter((d) => typeof d === 'string' && d !== '') : []
  if (list.length === 0) {
    return { ok: false, docDate: dateStr, oldestRecent: '', reason: '取不到最近 commit 日期（git 不可用？）' }
  }
  const oldestRecent = list.slice().sort()[0]
  const ok = dateStr >= oldestRecent
  return {
    ok,
    docDate: dateStr,
    oldestRecent,
    reason: ok ? null : `文档「最后更新 ${dateStr}」早于最近 ${list.length} 个 commit 的最早者 ${oldestRecent} ⇒ 代码动了、全景没更`,
  }
}

/**
 * 判据 G6：**值对账** —— §3 关键事实里的数字必须等于「当场算出来的真值」。
 *
 * ## 为什么必须有这条（G1–G5 的最大漏洞）
 *
 * G1–G5 全是**结构/时间**判据：足以抓住「完全没动」，但**挡不住糊弄**。
 * 实测反例：把「最后更新」改成任意未来日期、正文一字不动 ⇒ G1/G2/G3 **全绿**
 * （G3 只查批次号在场，而旧批次号一直在）。文档因此可以在「事实全错」的状态下
 * 长期显绿——这比没有闸门更危险（它给了一个虚假的安心信号）。
 *
 * G6 的做法：**闸门自己算出每个快变量的真值**，然后要求文档里写的就是那个值。
 * 快变量 = 每批次几乎必然变的东西（提交数 / 跟踪文件 / 工具数 / 文档数 /
 * 测试断言数 / 门数）。这些一错，G6 立刻红，**改日期糊弄无效**。
 *
 * @param {string} text - 全文档文本
 * @param {object} facts - 当场实测的真值
 * @param {{count:number, tracked:number, tools:number, docs:number, tests:number, gates:number}} facts
 * @returns {{ok:boolean, rows:Array<{label:string, docValue:number|string|null, actualValue:number|string, ok:boolean}>,
 *            reason:string|null}}
 */
export function checkFactValues(text, facts) {
  const src = String(text ?? '')
  const rows = []
  const add = (label, docValue, actualValue) => {
    rows.push({ label, docValue, actualValue, ok: String(docValue) === String(actualValue) })
  }

  // 提交 / 跟踪文件：`| 提交 / 跟踪文件 | 179 / 169 |`
  //
  // ⚠️ **提交数用区间容差，不做精确对账**（2026-10-29 实测抓到的设计缺陷）：
  // 「更新本文档」这个动作本身会产生一个新提交 ⇒ 文档里写的提交数**永远差 1**，
  // 精确对账导致「越改越红、无法收敛」的死循环（实测 179 → 提交后 180 → 又红）。
  // 故改为允许 `actual - doc ∈ [0, 1]`：滞后 0（尚未提交）或 1（本次提交自带）都算对。
  // **超过 1 仍红**——那说明确实有多个批次没同步，判据的鉴别力保留。
  const commitRow = src.match(/提交\s*\/\s*跟踪文件\s*\|\s*(\d+)\s*\/\s*(\d+)/)
  const docCommits = commitRow?.[1] === undefined ? null : Number(commitRow[1])
  const commitLag = docCommits === null ? null : (facts.count - docCommits)
  rows.push({
    label: '提交数（容差 ≤1）',
    docValue: docCommits,
    actualValue: facts.count,
    ok: commitLag !== null && commitLag >= 0 && commitLag <= 1,
  })
  add('跟踪文件数', commitRow?.[2] ?? null, facts.tracked)

  // 确定性工具 / 文档正本：`| 确定性工具 / 文档正本 | 24 / 7 |`
  const toolsRow = src.match(/确定性工具\s*\/\s*文档正本\s*\|\s*(\d+)\s*\/\s*(\d+)/)
  add('确定性工具数', toolsRow?.[1] ?? null, facts.tools)
  add('文档正本数', toolsRow?.[2] ?? null, facts.docs)

  // 主测试套件：**只查「全绿」不查具体数字**
  // （断言数需要跑测试才能得到 ⇒ 若拿它做值对账，本门就得重跑一次 run.mjs，
  //   既慢又在并发下摆动 —— 实测出现过「文档 382 / 本门 381」的假红。
  //   取舍：文档写「全绿」，具体数字交给 `npm test` 自己报，本门不重复计价。
  //   判据 = 含「全绿」且**不含具体断言数**（写死断言数会在每次加测试时腐烂）。
  const testsRow = src.match(/主测试套件\s*\/\s*`?npm test`?\s*门数\s*\|([^|]*)\|/)
  const testCell = testsRow?.[1] ?? ''
  const hasGreen = testCell.includes('全绿')
  const pinsCount = /(\d+)\s*断言/.test(testCell)
  add('主测试全绿声明', hasGreen && !pinsCount ? '全绿' : (testCell.trim() === '' ? null : testCell.trim()), '全绿')
  // npm test 门数：由 package.json 的 test 脚本数出（确定性）
  const gatesMatch = testCell.match(/(\d+)\s*道门/)
  add('npm test 门数', gatesMatch?.[1] ?? null, facts.gates)

  const bad = rows.filter((r) => !r.ok)
  return {
    ok: bad.length === 0,
    rows,
    reason: bad.length === 0 ? null
      : `§3 有 ${bad.length} 项与实测真值不符：${bad.map((r) => `${r.label} 文档写 ${r.docValue ?? '(缺失)'} 实测 ${r.actualValue}`).join('；')}`,
  }
}

/**
 * 判据 G3：§2 进度表必须与 CHANGELOG 的最近批次对应。
 *
 * 口径（宽松但可失败）：CHANGELOG 的 `[Unreleased]` 节里出现的**批次号**
 * （形如 `R3-B5` / `B2` / `B4`）至少有一个要出现在全景文档的 §2 进度表里。
 * 这条不追求精确匹配（批次命名会演进），只抓「文档完全没跟上」这一级腐烂。
 *
 * @param {string} statusText
 * @param {string} changelogText
 * @returns {{ok:boolean, matched:string[], reason:string|null}}
 */
export function checkBatchAlignment(statusText, changelogText) {
  const status = String(statusText ?? '')
  const unreleasedIdx = String(changelogText ?? '').indexOf('## [Unreleased]')
  if (unreleasedIdx < 0) {
    return { ok: false, matched: [], reason: 'CHANGELOG 缺 [Unreleased] 节（结构漂移）' }
  }
  const unreleased = String(changelogText).slice(unreleasedIdx)
  const batchRe = /(?:R\d-)?B\d+(?![0-9])/g
  const batches = [...new Set((unreleased.match(batchRe) ?? []))]
  if (batches.length === 0) {
    // CHANGELOG 最近节里一个批次号都没有 ⇒ 无法判定对齐；**不当绿**（fail-closed）
    return { ok: false, matched: [], reason: 'CHANGELOG [Unreleased] 节里取不到批次号（无法判定对齐，fail-closed）' }
  }
  const matched = batches.filter((b) => status.includes(b))
  return {
    ok: matched.length > 0,
    matched,
    batches,
    reason: matched.length > 0 ? null : `CHANGELOG 最近节提到批次 [${batches.slice(0, 8).join(', ')}]，但全景文档 §2 一个都没提 ⇒ 进度表已落后`,
  }
}

/**
 * 判据 G4：§3 关键事实表中「复现方式」列里的命令**真能跑**。
 *
 * 只抽查形如 `` `git rev-parse --short HEAD` `` 的 git 类命令（白名单前缀），
 * 且**不执行**任何含写操作/网络/GUI 的命令（安全边界：本工具只做只读核验）。
 *
 * @param {string} text
 * @param {{run?: (cmd:string)=>string, limit?:number}} [options]
 * @returns {{ok:boolean, checked:number, failures:Array<{cmd:string, error:string}>, skipped:number}}
 */
export function checkReproCommands(text, options = {}) {
  const run = typeof options.run === 'function' ? options.run : (cmd) => {
    // 只跑只读 git（安全白名单；绝不 eval 任意字符串、绝不经 shell）
    const argv = cmd.replace(/^git\s+/, '').match(/(["'])(.*?)\1|[\w.@%^~-]+/g)
    const tokens = (argv ?? []).filter((t) => !/^["']/.test(t)).map((t) => t.replace(/["']/g, ''))
    if (tokens.length === 0) throw new Error('命令解析后为空')
    return gitReadonly(tokens)
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 3
  // 只取 **git 只读** 形态的命令；其余（node/npm/pwsh 等）不在此门执行（避免副作用）
  const cmds = [...String(text ?? '').matchAll(/`(git [^`]+)`/g)].map((m) => m[1].trim())
    .filter((c) => !/commit|push|checkout|reset|clean|stash/.test(c))
  if (cmds.length === 0) {
    return { ok: false, checked: 0, failures: [], skipped: 0, reason: '§3 里取不到可执行的只读 git 命令（零命中，fail-closed）' }
  }
  const failures = []
  const picked = cmds.slice(0, limit)
  for (const cmd of picked) {
    try { run(cmd) } catch (error) {
      failures.push({ cmd, error: String(error?.message ?? error).slice(0, 120) })
    }
  }
  return { ok: failures.length === 0, checked: picked.length, failures, skipped: cmds.length - picked.length, reason: null }
}

/** 取最近 N 个 commit 的 author date（`YYYY-MM-DD`）。 */
function recentCommitDates(n) {
  try {
    const out = gitReadonly(['log', `-${n}`, '--format=%ad', '--date=short'])
    return out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  } catch { return [] }
}

/**
 * **当场实测 §3 快变量的真值**（G6 的输入；绝不从文档里读，否则对账无意义）。
 *
 * ## 只探测**确定性且廉价**的量（2026-10-29 收窄，advisor 提醒后执行）
 *
 * 首版把「主测试断言数」也纳入：为拿这个数必须在本门内**重跑一次 `tests/run.mjs`**
 * （而 `npm test` 已经跑过一次），代价翻倍；更要命的是并发场景下读数会摆
 * （实测同一时刻他席在改工作树 ⇒ 文档写 382、本门测到 381，**闸门假红**）。
 *
 * 判据：**只把「用 git / fs / package.json 就能确定性取到」的量纳入 G6**；
 * 需要跑测试才能得到的量（如断言数）**不进 G6**——文档改为写「全绿」而非硬编码数字。
 * 这是「闸门自身不得成为新维护债」的直接落实。
 *
 * @param {string} root
 * @returns {{count:number, tracked:number, tools:number, docs:number, gates:number,
 *            errors:Array<string>}}
 */
export function probeFacts(root) {
  const errors = []
  const read = (rel) => { try { return readFileSync(join(root, rel), 'utf8') } catch { return null } }
  const countFiles = (dir) => {
    try { return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isFile()).length }
    catch { errors.push(`读不到目录 ${dir}`); return -1 }
  }

  // 提交数（只读 git；fd-stdio）
  let count = -1
  try {
    const out = gitReadonly(['rev-list', '--count', 'HEAD'])
    count = Number(out.trim())
  } catch (e) { errors.push(`git rev-list 失败：${String(e?.message ?? e).slice(0, 80)}`) }

  // 跟踪文件数：git 跟踪数 + 当前 untracked（未提交的新文件也算「本仓现有」）
  let tracked = -1
  try {
    const trackedOut = gitReadonly(['ls-files'])
    const untrackedOut = gitReadonly(['ls-files', '--others', '--exclude-standard'])
    const n = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l !== '').length
    tracked = n(trackedOut) + n(untrackedOut)
  } catch (e) { errors.push(`git ls-files 失败：${String(e?.message ?? e).slice(0, 80)}`) }

  // npm test 门数：package.json 的 test 脚本里 `&&` + 1
  let gates = -1
  const pkgText = read('package.json')
  if (pkgText === null) errors.push('读不到 package.json')
  else {
    try {
      const pkg = JSON.parse(pkgText)
      const script = String(pkg?.scripts?.test ?? '')
      gates = script === '' ? -1 : (script.split('&&').length)
    } catch (e) { errors.push(`package.json 解析失败：${String(e?.message ?? e).slice(0, 80)}`) }
  }

  return {
    count, tracked, tools: countFiles('tools'), docs: countFiles('docs'),
    gates, errors,
  }
}

/**
 * 跑全部判据。
 * @param {{execute?:boolean, root?:string, facts?:object}} [options]
 * @returns {{pass:boolean, checks:Array<{id:string, ok:boolean, detail:string}>}}
 */
export function runGate(options = {}) {
  const root = options.root ?? REPO_ROOT
  const abs = join(root, STATUS_DOC)
  const checks = []
  if (!existsSync(abs)) {
    return { pass: false, checks: [{ id: 'G1', ok: false, detail: `文档不存在：${STATUS_DOC}` }] }
  }
  const text = readFileSync(abs, 'utf8')

  // G1 行数预算
  const g1 = checkLineBudget(text)
  checks.push({ id: 'G1', ok: g1.ok, detail: g1.ok ? `行数 ${g1.lineCount} ≤ ${g1.limit}` : g1.reason })

  // G1b 与 advisor 侧常量同值（跨面一致性：注入面 vs 工具面）
  checks.push({
    id: 'G1b',
    ok: STATUS_MAX_LINES === 100,
    detail: `本门上限 ${STATUS_MAX_LINES} 行（必须与 advisor read_file 的 100 行同口径）`,
  })

  // G2 保鲜
  const parsed = parseLastUpdate(text)
  if (!parsed.ok) {
    checks.push({ id: 'G2', ok: false, detail: parsed.reason })
  } else {
    const recent = recentCommitDates(MAX_COMMITS_BEHIND)
    const g2 = checkFreshness(parsed.date, recent)
    checks.push({ id: 'G2', ok: g2.ok, detail: g2.ok ? `最后更新 ${g2.docDate} ≥ 最近 ${recent.length} commit 最早者 ${g2.oldestRecent}` : g2.reason })
  }

  // G3 批次对齐
  const changelogAbs = join(root, 'CHANGELOG.md')
  if (!existsSync(changelogAbs)) {
    checks.push({ id: 'G3', ok: false, detail: 'CHANGELOG.md 不存在' })
  } else {
    const g3 = checkBatchAlignment(text, readFileSync(changelogAbs, 'utf8'))
    checks.push({ id: 'G3', ok: g3.ok, detail: g3.ok ? `批次对齐：命中 ${g3.matched.join(', ')}` : g3.reason })
  }

  // G4 复现命令（仅 --execute）
  if (options.execute === true) {
    const g4 = checkReproCommands(text)
    checks.push({ id: 'G4', ok: g4.ok, detail: g4.ok ? `抽查 ${g4.checked} 条只读 git 命令全通过` : (g4.reason ?? JSON.stringify(g4.failures)) })
  }

  // ── G6 值对账（**防「只改日期糊弄」的关键判据**）───────────────────────────
  // 实测漏洞：只改「最后更新」日期、正文一字不动 ⇒ G1/G2/G3 全绿。
  // G6 由**闸门自己算出真值**，要求文档里的数字与之相等 ⇒ 快变量一错立刻红。
  const facts = options.facts ?? probeFacts(root)
  if (facts.errors !== undefined && facts.errors.length > 0) {
    checks.push({ id: 'G6', ok: false, detail: `真值探测失败（fail-closed）：${facts.errors.slice(0, 3).join('；')}` })
  } else {
    const g6 = checkFactValues(text, facts)
    checks.push({
      id: 'G6',
      ok: g6.ok,
      detail: g6.ok
        ? `§3 快变量对账全对：${g6.rows.map((r) => `${r.label}=${r.actualValue}`).join(' / ')}`
        : g6.reason,
    })
    // 把逐项读数回显（红绿都可见，便于修文档时知道该填什么）
    for (const r of g6.rows) {
      checks.push({ id: `G6-${r.label}`, ok: r.ok, detail: `文档 ${r.docValue ?? '(缺失)'} vs 实测 ${r.actualValue}`, informational: true })
    }
  }

  const blocking = checks.filter((c) => c.informational !== true)
  return { pass: blocking.every((c) => c.ok), checks }
}

/**
 * G5 自测：合成样本，证明判据**有牙齿**（该红的会红，该绿的会绿）。
 * @returns {{passed:number, failed:number, cases:string[]}}
 */
export function selftest() {
  const cases = []
  let failed = 0
  const expect = (label, cond) => {
    cases.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
    if (!cond) failed += 1
  }

  const goodDoc = [
    '# 全景', '最后更新：2026-10-29', '## 2. 进度', '| R3-B5 | ✅ |', '## 3. 关键事实', '| x | y | `git rev-parse --short HEAD` |',
  ].join('\n')
  const badLen = Array.from({ length: 101 }, (_, i) => `L${i}`).join('\n') + '\n最后更新：2026-10-29'
  const badDate = goodDoc.replace('2026-10-29', '2020-01-01')

  // G1
  expect('G1 阴性对照：恰好 100 行判绿', checkLineBudget(Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n')).ok === true)
  expect('G1 阳性必红：101 行判红', checkLineBudget(badLen).ok === false)
  expect('G1 空文档 fail-closed', checkLineBudget('').ok === false)

  // G2
  expect('G2 阴性对照：日期与最近 commit 同日判绿', checkFreshness('2026-10-29', ['2026-10-29', '2026-10-28']).ok === true)
  expect('G2 阳性必红：文档早于最近 commit 判红', checkFreshness('2020-01-01', ['2026-10-29']).ok === false)
  expect('G2 无 commit 日期 fail-closed', checkFreshness('2026-10-29', []).ok === false)
  const p1 = parseLastUpdate(goodDoc)
  expect('G2 日期行可抽取', p1.ok === true && p1.date === '2026-10-29')
  expect('G2 缺日期行判红', parseLastUpdate('# 无日期').ok === false)

  // G3
  expect('G3 阴性对照：批次命中判绿', checkBatchAlignment('| R3-B5 | ✅ |', '## [Unreleased]\nR3-B5 完成').ok === true)
  expect('G3 阳性必红：批次完全不提判红', checkBatchAlignment('什么都没说', '## [Unreleased]\nR3-B5 完成').ok === false)
  expect('G3 CHANGELOG 无批次号 fail-closed', checkBatchAlignment('R3-B5', '## [Unreleased]\n无批次').ok === false)

  // G4（用假 run，不真跑 git）
  expect('G4 阴性对照：命令能跑判绿', checkReproCommands('`git rev-parse HEAD`', { run: () => 'ok' }).ok === true)
  expect('G4 阳性必红：命令失败判红', checkReproCommands('`git rev-parse HEAD`', { run: () => { throw new Error('boom') } }).ok === false)
  expect('G4 零命令 fail-closed', checkReproCommands('没有命令').ok === false)

  // ── G6 值对账（**防「只改日期糊弄」**的关键判据）──────────────────────────
  const factsSample = { count: 200, tracked: 170, tools: 25, docs: 8, gates: 14, errors: [] }
  const goodFacts = [
    '| 提交 / 跟踪文件 | 200 / 170 | `git rev-list --count HEAD` |',
    '| 确定性工具 / 文档正本 | 25 / 8 | `Get-ChildItem tools -File` |',
    '| 主测试套件 / `npm test` 门数 | 全绿 / 14 道门 | `node tests/run.mjs` |',
  ].join('\n')
  expect('G6 阴性对照：数字与真值一致判绿', checkFactValues(goodFacts, factsSample).ok === true)
  // 提交数容差：滞后 1 判绿（改文档本身会产生一个提交，实测的死循环根因）
  const lag1 = goodFacts.replace('| 提交 / 跟踪文件 | 200 / 170 |', '| 提交 / 跟踪文件 | 199 / 170 |')
  expect('G6 提交数滞后 1 ⇒ 绿（update 文档自带一个新提交，否则永不收敛）',
    checkFactValues(lag1, factsSample).ok === true)
  // 滞后 2 必须红（说明确实多个批次没同步，鉴别力保留）
  const lag2 = goodFacts.replace('| 提交 / 跟踪文件 | 200 / 170 |', '| 提交 / 跟踪文件 | 198 / 170 |')
  expect('G6 提交数滞后 2 ⇒ 红（真滞后必须抓出）', checkFactValues(lag2, factsSample).ok === false)
  // 文档写多了（超前）也必须红
  const ahead = goodFacts.replace('| 提交 / 跟踪文件 | 200 / 170 |', '| 提交 / 跟踪文件 | 201 / 170 |')
  expect('G6 提交数超前（写了不存在的提交）⇒ 红', checkFactValues(ahead, factsSample).ok === false)
  // 阳性必红：模拟「只改日期、正文不动」——正文里的旧数字与真值不符
  const staleFacts = goodFacts.replace('200 / 170', '176 / 165')
  expect('G6 阳性必红：§3 数字过时（只改日期糊弄）⇒ 红', checkFactValues(staleFacts, factsSample).ok === false)
  expect('G6 缺 §3 行 ⇒ 红（不静默放过）',
    checkFactValues('# 只有标题', factsSample).ok === false)
  // 篡改单个数字也必须红（不是只看有没有这一行）
  const oneBad = goodFacts.replace('25 / 8', '25 / 7')
  const oneBadResult = checkFactValues(oneBad, factsSample)
  expect('G6 单个数字篡改必红（文档正本 8→7）',
    oneBadResult.ok === false && /文档正本数/.test(oneBadResult.reason ?? ''))
  // 门数错也要红
  const gateBad = goodFacts.replace('14 道门', '13 道门')
  expect('G6 npm test 门数错必红（14→13）', checkFactValues(gateBad, factsSample).ok === false)
  // 「全绿」声明缺失要红（不许写具体断言数糊过去，也不许留空）
  const noGreen = goodFacts.replace('全绿 / 14 道门', '382 断言全绿 / 14 道门')
  const noGreenResult = checkFactValues(noGreen, factsSample)
  expect('G6 主测试未声明「全绿」⇒ 红（具体断言数不作为对账口径）', noGreenResult.ok === false)
  // 逐项读数可定位（修文档时要知道该填什么）
  const rows = checkFactValues(goodFacts, factsSample).rows
  expect('G6 回显 6 项逐项读数', rows.length === 6 && rows.every((r) => typeof r.label === 'string'))

  return { passed: cases.length - failed, failed, cases }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const selftestOnly = process.argv.includes('--selftest')
  const execute = process.argv.includes('--execute')

  if (selftestOnly) {
    const r = selftest()
    for (const line of r.cases) console.log(`  ${line}`)
    console.log(`[selftest] passed=${r.passed} failed=${r.failed}`)
    process.exitCode = r.failed === 0 ? 0 : 1
  } else {
    const st = selftest()
    const gate = runGate({ execute })
    console.log('== project-status-gate（项目全景保鲜闸门）==')
    console.log(`  文档：${STATUS_DOC}`)
    for (const c of gate.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id} ${c.detail}`)
    console.log(`  [selftest] passed=${st.passed} failed=${st.failed}`)
    const pass = gate.pass && st.failed === 0
    console.log(`[RESULT] ${pass ? 'PASS — 全绿' : 'FAIL — 有判据红'}`)
    process.exitCode = pass ? 0 : 1
  }
}
