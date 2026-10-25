#!/usr/bin/env node
/**
 * tests/body-hash-check.mjs — persona body_hash 一致性门（C-1 根因的机制化关闭）。
 *
 *   node tests/body-hash-check.mjs            # 正常跑门：全部 personas/*.md 按 body 域公式重算比对（exit 0 = 全自洽）
 *   node tests/body-hash-check.mjs --selftest # 负向自测：函数级变异体必须变红（只变异内存合成字符串，绝不碰真实文件）
 *
 * 为什么有这道门（C-1 tracer 2026-10-25 实锤，13/13 判别性命中 baseline@9bc6c90）：
 * 装机期 13 文件的 body_hash 是装机时点快照值，正文多轮演进（imp09/11/15）后无人
 * 重算——「重算只跟随被改文件、无门约束」，漂移静默存活到 R2 C-2 全量审计才暴露。
 * 本门把「任一 persona 的 body_hash ≠ body 域复算值」变成**当场响亮失败**的机检，
 * 而不是等下一轮人工审计记得核对。
 *
 * 公式唯一源：与运行时同一实现 lib/persona.js 的 splitFrontmatter（不复制逻辑）。
 * body 域 = sha256(splitFrontmatter(raw).body).slice(0, 8).toUpperCase()。
 *
 * 负向自测纪律：函数级变异——变异只发生在**内存中的合成 persona 字符串**上，
 * 绝不变异真实文件（真实文件变异后的还原在本仓属雷区，见 ARCHITECTURE §1.1）。
 *
 * 接线状态（2026-10-25 R2 C-2）：独立脚本形态交付；接入 tests/run.mjs 标准门序列
 * **待组织者统一安排**（A 线同期在改 run.mjs，避免同文件并行编辑冲突）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitFrontmatter } from '../lib/persona.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PERSONAS_DIR = join(ROOT, 'personas')

/** body 域公式（唯一实现点，检查层与自测共用；与任务书头部留档同一域）。 */
export function bodyHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8).toUpperCase()
}

/** 磁盘事实层：personas/ 顶层 .md（checklists/ 子目录不在口径）。 */
export function loadPersonaFiles(dir = PERSONAS_DIR) {
  if (!existsSync(dir)) throw new Error(`personas 目录不存在：${dir}`)
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      id: e.name.replace(/\.md$/i, ''),
      file: `personas/${e.name}`,
      raw: readFileSync(join(dir, e.name), 'utf8'),
    }))
}

/**
 * 构造一份 body_hash 自洽的合成 persona（自测/阳性对照专用，绝不落盘）。
 * 声明值由同一公式现算，保证「原件必绿」不是手工写死的常量。
 */
export function buildSyntheticPersona(bodyText) {
  const body = bodyText ?? '<Agent_Prompt>\n <Role> 合成样本：按规格完成分配任务 0x9 </Role>\n</Agent_Prompt>\n'
  const stub = `---\nrole: synthetic-sample\nname: Synthetic Sample\ntier: MEDIUM\nbody_hash: PLACEHOLDER\n---\n\n${body}`
  const actual = bodyHash(splitFrontmatter(stub).body)
  return stub.replace('body_hash: PLACEHOLDER', `body_hash: ${actual}`)
}

/**
 * 检查层（纯函数，主流程与 --selftest 共用；输入只要字符串，函数级变异由此可行）。
 * @param {Array<{id: string, file?: string, raw: string}>} entries
 * @returns {{failures: string[], notes: string[], checked: number}}
 */
export function checkPersonaContents(entries) {
  const failures = []
  if (!Array.isArray(entries) || entries.length === 0) {
    failures.push(
      '零条目 fail-closed：personas/*.md 解析出 0 份人格。目录缺失/整体被移走按判据失明处理，绝不当作「没问题」。',
    )
    return { failures, notes: [], checked: 0 }
  }
  for (const e of entries) {
    const label = e.file ?? e.id
    const { meta, body } = splitFrontmatter(e.raw)
    const declared = meta.body_hash
    if (declared === undefined) {
      failures.push(`${label}: frontmatter 缺 body_hash 字段（新装/新改人格必须按 body 域公式留档）`)
      continue
    }
    if (!/^[0-9A-F]{8}$/.test(declared)) {
      failures.push(`${label}: body_hash 形态非法「${declared}」（须 8 位大写十六进制）`)
      continue
    }
    const computed = bodyHash(body)
    if (declared !== computed) {
      failures.push(
        `${label}: body_hash 漂移——声明 ${declared}，body 域复算 ${computed}` +
          '（正文已改而哈希未同步，C-1 根因类；修法=按公式重写 frontmatter 单行，正文零改动）',
      )
    }
  }
  const notes = [`已核对 ${entries.length} 份人格的 body_hash（body 域公式，与 lib/persona.js 同源）`]
  return { failures, notes, checked: entries.length }
}

// ---------------------------------------------------------------------------
// 阳性对照 + 负向自测（--selftest）
// ---------------------------------------------------------------------------

/** 阳性对照：合成自洽样本必须绿——判据若因实现错误恒红/恒绿，这里先暴露。 */
export function positiveControl() {
  const failures = []
  const good = buildSyntheticPersona()
  const r = checkPersonaContents([{ id: 'pc-good', raw: good }])
  if (r.failures.length !== 0 || r.checked !== 1) {
    failures.push(`阳性对照红：自洽合成样本未通过（failures=${JSON.stringify(r.failures)}，checked=${r.checked}）`)
  }
  return { failures }
}

/**
 * 变异体逐条断言：每个变异体只动一个变量，证明「红」来自该变量而不是别处。
 * 全部为函数级变异（内存字符串），零真实文件写入。
 * @returns {{pass: number, total: number, failures: string[]}}
 */
export function selftest() {
  const good = buildSyntheticPersona()
  const cases = []

  // M0 原件应通过（与阳性对照互为冗余，防 positiveControl 自身被打穿）
  cases.push({
    name: 'M0 原件应通过',
    expectFail: false,
    run: () => checkPersonaContents([{ id: 'm0', raw: good }]),
  })
  // M1 正文变异一字符（组织者指定形态：改一字符的正文过门必红）
  cases.push({
    name: 'M1 变异：正文改一字符（0x9→0x8）',
    expectFail: true,
    run: () => checkPersonaContents([{ id: 'm1', raw: good.replace('0x9', '0x8') }]),
  })
  // M2 声明值变异一字符（反向漂移：哈希被手改而正文没动）
  cases.push({
    name: 'M2 变异：body_hash 改一字符',
    expectFail: true,
    run: () => {
      const m = good.match(/body_hash: ([0-9A-F]{8})/)
      const flipped = m[1].startsWith('0') ? `1${m[1].slice(1)}` : `0${m[1].slice(1)}`
      return checkPersonaContents([{ id: 'm2', raw: good.replace(m[1], flipped) }])
    },
  })
  // M3 字段缺失（新装人格不留档）
  cases.push({
    name: 'M3 变异：frontmatter 缺 body_hash 字段',
    expectFail: true,
    run: () => checkPersonaContents([{ id: 'm3', raw: good.replace(/^body_hash: [0-9A-F]{8}\n/m, '') }]),
  })
  // M4 形态非法（小写 8 hex——公式产出恒大写，小写必是手写错值）
  cases.push({
    name: 'M4 变异：body_hash 小写形态',
    expectFail: true,
    run: () => {
      const m = good.match(/body_hash: ([0-9A-F]{8})/)
      return checkPersonaContents([{ id: 'm4', raw: good.replace(m[1], m[1].toLowerCase()) }])
    },
  })
  // M5 零条目（判据失明防护：目录空/解析失败必须红而不是静默通过）
  cases.push({
    name: 'M5 变异：零条目输入',
    expectFail: true,
    run: () => checkPersonaContents([]),
  })
  // M6 断言鉴别力（≥3 元素输入）：混合集逐元素判定——好元素不得被牵连，
  // 两类坏元素都必须被点名；只断言「有失败」分不清是抓对了还是全盘误伤。
  cases.push({
    name: 'M6 鉴别力：3 元素混合集逐元素判定',
    expectFail: true,
    run: () => {
      const bodyDrift = buildSyntheticPersona('<Agent_Prompt>\n 另一段正文 alpha\n</Agent_Prompt>\n').replace('alpha', 'alphb')
      const hashDrift = buildSyntheticPersona('<Agent_Prompt>\n 另一段正文 beta\n</Agent_Prompt>\n').replace(/body_hash: ([0-9A-F])/, 'body_hash: 0')
      const r = checkPersonaContents([
        { id: 'elem-ok', raw: good },
        { id: 'elem-body-drift', raw: bodyDrift },
        { id: 'elem-hash-drift', raw: hashDrift },
      ])
      const joined = r.failures.join('\n')
      if (!joined.includes('elem-body-drift')) r.failures.push('M6 鉴别力失败：正文漂移元素未被点名')
      if (!joined.includes('elem-hash-drift')) r.failures.push('M6 鉴别力失败：哈希漂移元素未被点名')
      if (joined.includes('elem-ok')) r.failures.push('M6 鉴别力失败：好元素被误伤')
      return r
    },
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function run() {
  const lines = []
  lines.push('== dsh-agents body-hash-check ==')
  const failures = []

  // G0 阳性对照先行：判据失明时后面所有「绿」都不可信
  const pc = positiveControl()
  failures.push(...pc.failures)
  if (pc.failures.length === 0) lines.push('[G0] 阳性对照 PASS（合成自洽样本绿，判据未失明）')

  // G1 真实输入全量跑（真实 personas/*.md，无 workaround）
  try {
    const entries = loadPersonaFiles()
    const r = checkPersonaContents(entries)
    failures.push(...r.failures)
    lines.push(`[G1] ${r.notes[0]}`)
  } catch (error) {
    failures.push(`事实层失败：${error.message}——fail-closed，不当作「无问题」`)
  }

  for (const l of lines) console.log(l)
  if (failures.length === 0) {
    console.log('[RESULT] PASS — 全部 persona 的 body_hash 与 body 域复算值一致')
    process.exitCode = 0
  } else {
    console.log(`[RESULT] FAIL — ${failures.length} 项`)
    for (const f of failures) console.log(`  [FAIL] ${f}`)
    process.exitCode = 1
  }
}

function runSelftest() {
  const pc = positiveControl()
  const st = selftest()
  console.log('== dsh-agents body-hash-check --selftest ==')
  console.log(`[G0] 阳性对照：${pc.failures.length === 0 ? 'PASS' : `FAIL — ${pc.failures.join('; ')}`}`)
  console.log(`[NEG] 变异体：${st.pass}/${st.total} 达到期望`)
  for (const f of st.failures) console.log(`  [FAIL] ${f}`)
  const ok = pc.failures.length === 0 && st.failures.length === 0 && st.pass === st.total
  console.log(`[RESULT] ${ok ? 'PASS — 判据有牙齿' : 'FAIL — 判据退化'}`)
  process.exitCode = ok ? 0 : 1
}

const args = process.argv.slice(2)
if (args.includes('--selftest')) runSelftest()
else if (args.every((a) => !a.startsWith('-'))) run()
else {
  console.error('用法：node tests/body-hash-check.mjs [--selftest]（未知参数：' + args.join(' ') + '）')
  process.exitCode = 2
}
