#!/usr/bin/env node
/**
 * tests/skill-sync-check.mjs — 计数漂移门 + `.gitattributes` 存在性门 + eol 一致性门。
 *
 *   node tests/skill-sync-check.mjs            # 正常跑门（exit 0 = 全过）
 *   node tests/skill-sync-check.mjs --selftest # 负向自测：变异体必须变红
 *
 * 为什么有这道门：README.md 与 ARCHITECTURE.md 曾同时存在 23 / 24 / 26 / 28 四种
 * 技能件数表述，且**没有任何机制会发现**——文档数字既不被测试读，也不被代码读，
 * 漂移只在下一次有人手改文档时才暴露。所以把这道门做成「文档里的每个数字都必须
 * 等于磁盘实测值」的机检，而不是靠下一次评审记得核对。
 *
 * 零依赖 + 纯 fs——**唯一例外是 G3**（worktree/index eol 一致性）：`git ls-files
 * --eol` 的输出没有纯 fs 等价物（index blob 的 eol 藏在 object store 里），故 G3
 * 用 **fd-stdio spawn git**（受限沙箱内管道捕获必 EPERM，fd 继承是本机实测可行的
 * 替代；探针见 agent-out/probe-eol.mjs）。G3 对任何 spawn/解析失败一律 **fail-closed**
 * 变红，绝不把「没查到」当「没问题」。
 *
 * G3 防的事故（2026-10-06 实测）：本仓 core.autocrlf=true 的历史让 28 个文件
 * worktree=CRLF 而 index=LF，`git status` 因 stat-cache 显示干净；在 `.gitattributes
 * * -text` 下对这些文件做任何 `git add` 都会把 CRLF 字节烤进 blob（全文件行尾
 * 翻转、blame 全毁、push 带巨量 eol 噪音）。
 *
 * 统计口径写在 DOCS 的 CLAIM 表旁，改口径必须同步改这里。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')

/** 被扫描的文档（数字载体）。 */
const DOCS = ['README.md', 'ARCHITECTURE.md']

/**
 * 技能计数表述的锚定式。
 *
 * **只认带技能语义锚的字面形态**（`件工作流技能` / `workflow skills` / `SKILL.md` …），
 * 不做「扫描全部数字」的宽匹配——否则 README 里的 23 个角色、11 份清单、3 个工具
 * 全会被卷进来，门直接失效（这类过宽判据在本仓已踩过：注释里的字面量触发零命中门）。
 *
 * 每条 pattern 必须恰好一个捕获组 = 被声明的件数。
 */
const CLAIM_PATTERNS = [
  { id: 'cn-workflow-skills', re: /(?<!\d)(\d+)\s*件工作流技能/g },
  { id: 'en-workflow-skills', re: /(?<!\d)(\d+)\s+workflow skills/g },
  { id: 'skills-dir-total', re: /`skills\/`\s*共\s*(\d+)\s*件/g },
  { id: 'skill-md-count', re: /(?<!\d)(\d+)\s*(?:个\s*)?SKILL\.md/g },
  { id: 'skill-dir-count', re: /(?<!\d)(\d+)\s*个技能目录/g },
  { id: 'skills-generic', re: /(?<!\d)(\d+)\s*件技能/g },
  { id: 'arch-table-cell', re: /工作流技能\s*\|\s*(\d+)/g },
  { id: 'skills-file-total', re: /(?<!\d)(\d+)\s*个文件（/g },
]

/** `.gitattributes` 必须含的规则（逐位匹配，允许行尾空白差异）。 */
const REQUIRED_ATTR = '* -text'

// ---------------------------------------------------------------------------
// 事实层：纯 fs 实测
// ---------------------------------------------------------------------------

/**
 * 递归统计 skills/ 下的文件。
 * @returns {{skillMd:number, skillDirs:number, totalFiles:number}}
 *   skillMd = 名为 SKILL.md 的文件数（技能件数的事实源）
 *   skillDirs = 含 SKILL.md 的目录数（一技能一目录）
 *   totalFiles = skills/ 下全部文件（含 README.md、replica-map.json 与 references）
 */
export function measureSkills(dir = SKILLS_DIR) {
  let skillMd = 0
  let totalFiles = 0
  const skillDirs = new Set()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        totalFiles += 1
        if (entry.name.toUpperCase() === 'SKILL.MD') {
          skillMd += 1
          skillDirs.add(dirname(full))
        }
      }
    }
  }
  if (!existsSync(dir)) throw new Error(`skills 目录不存在：${dir}`)
  walk(dir)
  return { skillMd, skillDirs: skillDirs.size, totalFiles }
}

// ---------------------------------------------------------------------------
// 断言层：从文档里抽出所有计数表述
// ---------------------------------------------------------------------------

/**
 * 抽出一段文本里的全部计数表述。
 * @param {string} text 文档正文
 * @param {string} [label] 出错时用于定位的文件名
 * @returns {Array<{pattern:string, value:number, line:number, snippet:string}>}
 */
export function extractClaims(text, label = '<inline>') {
  const lines = text.split('\n')
  const claims = []
  for (const { id, re } of CLAIM_PATTERNS) {
    const rx = new RegExp(re.source, re.flags)
    let m
    while ((m = rx.exec(text)) !== null) {
      const before = text.slice(0, m.index)
      const line = before.split('\n').length
      claims.push({
        pattern: id,
        value: Number(m[1]),
        line,
        snippet: (lines[line - 1] ?? '').trim().slice(0, 90),
      })
    }
  }
  return claims.map((c) => ({ ...c, label }))
}

/** 把一条表述该等于多少真值算出来（不同表述口径不同：件数 vs 文件数）。 */
function expectedFor(pattern, facts) {
  switch (pattern) {
    case 'skills-file-total':
      return facts.totalFiles
    default:
      return facts.skillMd
  }
}

// ---------------------------------------------------------------------------
// 检查层
// ---------------------------------------------------------------------------

/**
 * 检查一批表述是否全部等于期望值。
 * 零命中不是「通过」而是「判据失明」——本项目反复踩过的假 0 坑，故 fail-closed。
 * @returns {{failures:string[], notes:string[]}}
 */
export function checkClaims(claims, facts, { requireClaims = true } = {}) {
  const failures = []
  const notes = []
  if (claims.length === 0) {
    if (requireClaims) {
      failures.push(
        '零命中 fail-closed：一段文档里没有抽出任何计数表述。' +
          '这通常意味着判据正则失配（文档改了写法），而不是「没有问题」——按失明处理。',
      )
    }
    return { failures, notes }
  }
  for (const c of claims) {
    const want = expectedFor(c.pattern, facts)
    if (c.value !== want) {
      failures.push(
        `计数漂移 ${c.label}:${c.line} [${c.pattern}] 声明 ${c.value}，实测 ${want}` +
          ` —— ${c.snippet}`,
      )
    }
  }
  notes.push(`已核对 ${claims.length} 处技能计数表述（实测 ${facts.skillMd} 件 / ${facts.totalFiles} 文件）`)
  return { failures, notes }
}

/**
 * `.gitattributes` 存在性门。
 * @returns {{failures:string[], notes:string[]}}
 */
export function checkGitattributes(root = ROOT) {
  const failures = []
  const p = join(root, '.gitattributes')
  if (!existsSync(p)) {
    failures.push('.gitattributes 不存在：本仓 core.autocrlf=true 且无此文件时「git 干净」≠「字节还原」')
    return { failures, notes: [] }
  }
  const body = readFileSync(p, 'utf8')
  const rules = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (!rules.includes(REQUIRED_ATTR)) {
    failures.push(`.gitattributes 缺少规则 ${REQUIRED_ATTR}（实测规则：${rules.length ? rules.join(' / ') : '（空文件）'}）`)
    return { failures, notes: [] }
  }
  return { failures, notes: [` .gitattributes 存在且含 "${REQUIRED_ATTR}"`] }
}

// ---------------------------------------------------------------------------
// G3：worktree / index eol 一致性门（P1-1 CRLF 雷区的常驻门）
// ---------------------------------------------------------------------------

/**
 * 解析 `git ls-files --eol` 输出（行形态：`i/lf  w/crlf  attr/-text  TABpath`）。
 * 无 TAB 的行（空行/告警）跳过；导出供 --selftest 喂合成样本。
 * @returns {Array<{index:string, worktree:string, path:string}>}
 */
export function parseEolEntries(text) {
  const entries = []
  for (const line of String(text).split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const path = line.slice(tab + 1).trim()
    const parts = line.slice(0, tab).trim().split(/\s+/)
    if (path === '' || parts.length < 2) continue
    entries.push({ index: parts[0], worktree: parts[1], path })
  }
  return entries
}

/**
 * 断言每个跟踪文件的 worktree eol 与 index eol 一致。
 *
 * 判定口径：`i/x` 与 `w/x` 去前缀后**必须相等**（含双侧 mixed == mixed）；`i/none` /
 * `w/none`（二进制，eol 无意义）跳过。任何不等 = 漂移——在 `.gitattributes * -text`
 * 下，下一次 `git add` 会把 worktree 字节原样烤进 blob，全文件行尾翻转。
 * **零条目 fail-closed**：解析出 0 条（git 缺失/输出格式漂移）按「判据失明」变红。
 * @param {Array<{index:string, worktree:string, path:string}>} entries
 * @returns {{failures:string[], notes:string[]}}
 */
export function checkEolEntries(entries) {
  const failures = []
  if (!Array.isArray(entries) || entries.length === 0) {
    failures.push(
      '零条目 fail-closed：git ls-files --eol 解析出 0 条跟踪文件。' +
        '这通常意味着 git 缺失/执行失败或输出格式漂移，而不是「没有问题」——按失明处理。',
    )
    return { failures, notes: [] }
  }
  let flagged = 0
  for (const e of entries) {
    if (e.index === 'i/none' || e.worktree === 'w/none') continue // 二进制：eol 无意义
    if (e.index.slice(2) === e.worktree.slice(2)) continue
    failures.push(
      `eol 漂移 ${e.path}：index=${e.index} worktree=${e.worktree}` +
        ' —— `* -text` 下 git add 会把 worktree 字节原样烤进 blob（全文件行尾翻转、blame 全毁）',
    )
    flagged += 1
  }
  const notes = [`${entries.length} 个跟踪文件 eol 一致（worktree == index，无 crlf/mixed 漂移）`]
  return { failures, notes: flagged === 0 ? notes : [] }
}

/**
 * 活体检查：spawn `git ls-files --eol`（fd-stdio，见文件头注释的例外说明）。
 * spawn 失败 / 非零退出 → fail-closed 变红。
 * @returns {{failures:string[], notes:string[]}}
 */
export function checkEolConsistency(root = ROOT) {
  const tmp = join(tmpdir(), `dsh-agents-eol-${process.pid}.txt`)
  let status = null
  let err = null
  let fd = null
  try {
    fd = openSync(tmp, 'w')
    const r = spawnSync('git', ['ls-files', '--eol'], { cwd: root, stdio: ['ignore', fd, fd] })
    status = r.status
    err = r.error ?? null
  } catch (error) {
    err = error
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关闭时忽略 */ } }
  }
  if (err !== null || status !== 0) {
    return {
      failures: [
        `git ls-files --eol 执行失败（exit=${String(status)}, error=${String(err?.message ?? err)}）——fail-closed，不当作「无问题」`,
      ],
      notes: [],
    }
  }
  let text = ''
  try { text = readFileSync(tmp, 'utf8') } finally { try { unlinkSync(tmp) } catch { /* best effort */ } }
  return checkEolEntries(parseEolEntries(text))
}

// ---------------------------------------------------------------------------
// 阳性对照：证明判据本身不是空门
// ---------------------------------------------------------------------------

/**
 * 阳性对照：对**已知必定命中**的合成样本跑抽取器。
 * 抽取器若因正则写错而恒零命中，这里会红——从而拒绝把「没抓到数字」读成「没问题」。
 * @returns {{failures:string[]}}
 */
export function positiveControl(facts = { skillMd: 25, totalFiles: 29 }) {
  const failures = []
  const N = facts.skillMd
  const F = facts.totalFiles
  // [样例行, 该行应当抽出的数值序列] —— 逐行声明期望，判据自身不靠手数
  const sample = [
    ['本插件外加 25 件工作流技能。', [N]],
    ['plus 25 workflow skills that orchestrate them.', [N]],
    ['`skills/` 共 25 件，分五组。', [N]],
    ['## 4. skills/ — 工作流技能（29 文件 = 25 SKILL.md + README.md）', [N]],
    ['skills/ 25 件工作流技能（25 个技能目录，29 个文件（含', [N, N, F]],
    ['| 工作流技能 | 25（入口 2） |', [N]],
    ['装机同步：25 件技能分装于两个用户级技能根', [N]],
  ]
  const text = sample.map((s) => s[0]).join('\n')
  const claims = extractClaims(text, '<positive-control>')
  if (claims.length === 0) {
    failures.push(`阳性对照红：抽取器对已知样本零命中（CLAIM_PATTERNS 已失明），实得 ${claims.length} 条`)
    return { failures }
  }
  // 判据一：每条 pattern 都必须在样本上命中（某条失配 = 该类表述从此不再被门看）
  const ids = new Set(claims.map((c) => c.pattern))
  const missing = CLAIM_PATTERNS.filter((p) => !ids.has(p.id)).map((p) => p.id)
  if (missing.length) {
    failures.push(`阳性对照红：以下判据在已知样本上未命中（正则失配）：${missing.join(', ')}`)
  }
  // 判据二：逐行比对抽出的数值（只命中不取值 = 抓到别的数字，等于没判）
  let i = 0
  for (const [line, expected] of sample) {
    const got = claims.filter((c) => c.line === i + 1).map((c) => c.value)
    if (got.join(',') !== expected.join(',')) {
      failures.push(
        `阳性对照红：第 ${i + 1} 行抽出的数值是 [${got.join(',')}]，期望 [${expected.join(',')}] —— ${line}`,
      )
    }
    i += 1
  }
  return { failures }
}

// ---------------------------------------------------------------------------
// 负向自测（--selftest）
// ---------------------------------------------------------------------------

/**
 * 变异体逐条断言目标判据变红。
 * 每个变异体只动一个变量，证明「红」来自该变量而不是别处。
 * @returns {{pass:number, total:number, failures:string[]}}
 */
export function selftest(facts) {
  const cases = []
  const good = '`skills/` 共 25 件工作流技能（25 个技能目录，29 个文件（含 README.md）'

  // 1) 正样本必须绿
  cases.push({
    name: 'M0 原件应通过',
    expectFail: false,
    run: () => checkClaims(extractClaims(good, 'M0'), facts),
  })
  // 2) 变异：件数改错（23/24/26/28 四种历史漂移值各一）
  for (const wrong of [23, 24, 26, 28]) {
    cases.push({
      name: `M1 变异：件数写成 ${wrong}`,
      expectFail: true,
      run: () => checkClaims(extractClaims(good.replace('25 件工作流技能', `${wrong} 件工作流技能`), 'M1'), facts),
    })
  }
  // 3) 变异：SKILL.md 件数写错
  cases.push({
    name: 'M2 变异：SKILL.md 写成 24',
    expectFail: true,
    run: () => checkClaims(extractClaims('共 24 SKILL.md + README', 'M2'), facts),
  })
  // 4) 变异：文件总数写错
  cases.push({
    name: 'M3 变异：文件总数写成 28',
    expectFail: true,
    run: () => checkClaims(extractClaims('（28 个文件（含 README.md）', 'M3'), facts),
  })
  // 5) 变异：零命中（判据失明）必须红而不是静默通过
  cases.push({
    name: 'M4 变异：一段没有任何计数表述的文本（假 0 防护）',
    expectFail: true,
    run: () => checkClaims(extractClaims('这段话里没有任何计数表述。', 'M4'), facts),
  })
  // 6) gitattributes 门：规则缺失 / 文件缺失
  cases.push({
    name: 'M5 变异：.gitattributes 内容只有注释没有规则',
    expectFail: true,
    run: () => {
      const root = join(ROOT, '.skill-sync-selftest-tmp')
      writeFixture(root, '# 只有注释，没有规则\n')
      const r = checkGitattributes(root)
      rmFixture(root)
      return r
    },
  })
  cases.push({
    name: 'M6 变异：.gitattributes 整文件不存在',
    expectFail: true,
    run: () => {
      const root = join(ROOT, '.skill-sync-selftest-tmp-missing')
      rmFixture(root) // 确保不存在
      return checkGitattributes(root)
    },
  })
  cases.push({
    name: 'M7 对照：.gitattributes 内容正是要求的规则',
    expectFail: false,
    run: () => {
      const root = join(ROOT, '.skill-sync-selftest-tmp-ok')
      writeFixture(root, `${REQUIRED_ATTR}\n`)
      const r = checkGitattributes(root)
      rmFixture(root)
      return r
    },
  })

  // 7) G3 eol 一致性门：合成 `git ls-files --eol` 输出逐条变异（解析层负向自测；
  //    活体层「真把文件改回 CRLF 必须变红」由 P1-1 修复时人工实测留证，见 agent-out/）
  const eolSample = (lines) => lines.join('\n')
  cases.push({
    name: 'M8 变异：i/lf + w/crlf（P1-1 原始雷形态）',
    expectFail: true,
    run: () => checkEolEntries(parseEolEntries(eolSample([
      'i/lf    w/lf    attr/-text            \tlib/client.js',
      'i/lf    w/crlf  attr/-text            \tlib/index.js',
    ]))),
  })
  cases.push({
    name: 'M9 变异：i/lf + w/mixed（当时的 .gitignore 形态）',
    expectFail: true,
    run: () => checkEolEntries(parseEolEntries(eolSample([
      'i/lf    w/mixed attr/-text            \t.gitignore',
    ]))),
  })
  cases.push({
    name: 'M10 变异：i/crlf + w/lf（反向翻转同样会重写 blob）',
    expectFail: true,
    run: () => checkEolEntries(parseEolEntries(eolSample([
      'i/crlf  w/lf    attr/-text            \tlegacy.txt',
    ]))),
  })
  cases.push({
    name: 'M11 对照：全一致样本（含二进制 i/none 与合法 i/crlf）',
    expectFail: false,
    run: () => checkEolEntries(parseEolEntries(eolSample([
      'i/lf    w/lf    attr/-text            \tlib/client.js',
      'i/crlf  w/crlf  attr/-text            \tlauncher.cmd',
      'i/none  w/none  attr/-text            \tassets/logo.png',
    ]))),
  })
  cases.push({
    name: 'M12 变异：零条目（git 缺失/输出漂移 → 失明必须红，不得静默通过）',
    expectFail: true,
    run: () => checkEolEntries(parseEolEntries('')),
  })

  const failures = []
  let pass = 0
  for (const c of cases) {
    const res = c.run()
    const failed = res.failures.length > 0
    if (failed === c.expectFail) pass += 1
    else {
      failures.push(
        `${c.name}：期望 ${c.expectFail ? '变红' : '通过'}，实得 ${failed ? '红' : '绿'}` +
          (res.failures.length ? `（${res.failures[0]}）` : ''),
      )
    }
  }
  return { pass, total: cases.length, failures }
}

// 自测用的极简文件写/删（只在本仓 .skill-sync-selftest-tmp* 内，绝不碰真实文件）
function writeFixture(root, body) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, '.gitattributes'), body)
}
function rmFixture(root) {
  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function run() {
  const facts = measureSkills()
  const lines = []
  lines.push('== dsh-agents skill-sync-check ==')
  lines.push(
    `[facts] skills/**/SKILL.md = ${facts.skillMd}（技能目录 ${facts.skillDirs}），skills/ 文件总数 = ${facts.totalFiles}`,
  )

  const failures = []
  const notes = []

  // G0 阳性对照先行：判据失明时后面所有「绿」都不可信
  const pc = positiveControl(facts)
  failures.push(...pc.failures)
  if (pc.failures.length === 0) notes.push(`[G0] 阳性对照 PASS（${CLAIM_PATTERNS.length} 类表述形态均可抽取且取值正确，判据未失明）`)

  // G1 计数门
  for (const doc of DOCS) {
    const p = join(ROOT, doc)
    if (!existsSync(p)) {
      failures.push(`${doc} 不存在，无法核对计数`)
      continue
    }
    const claims = extractClaims(readFileSync(p, 'utf8'), doc)
    const r = checkClaims(claims, facts)
    failures.push(...r.failures)
    if (r.notes.length) notes.push(`[G1] ${doc} ${r.notes[0].trim()}`)
  }

  // G2 .gitattributes 门
  const ga = checkGitattributes(ROOT)
  failures.push(...ga.failures)
  if (ga.notes.length) notes.push(`[G2]${ga.notes[0]}`)

  // G3 worktree/index eol 一致性门（P1-1：stat-cache 假象下 git status 报干净，
  // 但 `* -text` 下任何 git add 都会把 worktree 的 crlf/mixed 字节烤进 blob）
  const eol = checkEolConsistency(ROOT)
  failures.push(...eol.failures)
  if (eol.notes.length) notes.push(`[G3] ${eol.notes[0]}`)

  for (const n of notes) lines.push(`  ${n}`)
  if (failures.length === 0) {
    lines.push('[RESULT] PASS — 计数 + .gitattributes + eol 一致性全对')
    for (const l of lines) console.log(l)
    process.exitCode = 0
  } else {
    for (const l of lines) console.log(l)
    console.log(`[RESULT] FAIL — ${failures.length} 项`)
    for (const f of failures) console.log(`  [FAIL] ${f}`)
    process.exitCode = 1
  }
}

function runSelftest() {
  const facts = measureSkills()
  const pc = positiveControl(facts)
  const st = selftest(facts)
  console.log('== dsh-agents skill-sync-check --selftest ==')
  console.log(`[facts] skills/**/SKILL.md = ${facts.skillMd}，文件总数 = ${facts.totalFiles}`)
  console.log(`[G0] 阳性对照：${pc.failures.length === 0 ? 'PASS' : `FAIL — ${pc.failures.join('; ')}`}`)
  console.log(`[NEG] 变异体：${st.pass}/${st.total} 达到期望`)
  for (const f of st.failures) console.log(`  [FAIL] ${f}`)
  const ok = pc.failures.length === 0 && st.failures.length === 0 && st.pass === st.total
  console.log(`[RESULT] ${ok ? 'PASS — 判据有牙齿' : 'FAIL — 判据退化'}`)
  process.exitCode = ok ? 0 : 1
}

if (process.argv.includes('--selftest')) runSelftest()
else run()