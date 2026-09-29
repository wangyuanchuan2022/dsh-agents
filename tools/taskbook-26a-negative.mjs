/**
 * IMP-26a 注入必红负向自测（DP-1 修复 + 只读白名单的回归门）。
 *
 * 用法：node tools/taskbook-26a-negative.mjs   （零依赖，单进程直跑，exit 0=全绿）
 *
 * 原理（merge-watermelon verify-gates-negative 同型）：对 lib/taskbook.js 源码做
 * 定向变异（每个变异体对应一类断言），把变异体写进临时目录动态 import，
 * 断言「原件上为真的谓词在变异体上必假（红）」。若源码漂移导致变异锚点
 * 失配，本工具响亮报错——不静默放过。
 *
 * 变异体 ↔ 断言类别一一对应（断言鉴别力纪律）：
 *   M1  完成广播 wake:true 条款        （DP-1 P1-2）
 *   M2  interactive 超时字面一致性      （DP-1 P1-3）
 *   M3  §5.3 三层失败分类 run_failure   （DP-1 P1-1）
 *   M4  §6.2 三档熔断收尾宽限           （DP-1 P1-1）
 *   M5  §9.1 confirmedFindings 条件渲染（DP-1 P1-1）
 *   M6  无路径警示行                    （DP-1 F-4/P2-7）
 *   M7  硬门①降级措辞（禁悬空引用）     （DP-1 F-4/P2-7）
 *   M8  只读白名单携带                  （IMP-26a）
 *   M9  只读白名单门控（readonly 判定） （IMP-26a）
 *   M10 organizer 缺失直投地址警示      （DP-1 P1-A/F-2）
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIBDIR = join(HERE, '..', 'lib')
const SRC = join(LIBDIR, 'taskbook.js')
const DOCS = join(HERE, '..', 'docs', 'task-brief-v3.md')

/** 只读角色与可写角色的最小桩（与 composeTaskbook 所需字段一致）。 */
const mkRole = (id, readonly) => ({ id, name: id, lane: 'build', mission: 'm', description: 'd', readonly })
const ROUTE = { tier: 'LOW', provider: 'p', model: 'm', source: 'tier-default' }
const PERSONA = { installed: false, hash: null, text: 'PERSONA' }

/** 原件行为谓词：全部必须在未变异源码上为真（自检），在对应变异体上为假（红）。 */
const tExec = (mod, extra = {}) => mod.composeTaskbook({ role: mkRole('executor', false), persona: PERSONA, route: ROUTE, task: 't', ...extra })
const tRo = (mod, extra = {}) => mod.composeTaskbook({ role: mkRole('explore', true), persona: PERSONA, route: ROUTE, task: 't', ...extra })

const broadcastLine = (t) => t.split('\n').find((l) => l.includes('完成广播：`de_broadcast`')) ?? ''

const MUTANTS = [
  { id: 'M1-wake', desc: '完成广播条款去 wake:true',
    from: '（wake:true） → 组织者', to: ' → 组织者',
    verify: (mod) => broadcastLine(tExec(mod, { organizer: 'session-x' })).includes('（wake:true）') },
  { id: 'M2-timeout', desc: '超时字面 5→15（与正本失一致）',
    from: '超过 5 分钟无回音', to: '超过 15 分钟无回音',
    verify: (_mod, src) => {
      const gen = /超过\s*(\d+)\s*分钟无回音/.exec(src)?.[1]
      const doc = /超时 <N=(\d+)> 分钟/.exec(readFileSync(DOCS, 'utf8'))?.[1]
      return gen !== undefined && doc !== undefined && gen === doc
    } },
  { id: 'M3-failure53', desc: '§5.3 三层失败分类 run_failure 标记移除',
    from: 'run_failure=<类目>', to: 'run_failure_MISSING=<类目>',
    verify: (mod) => tExec(mod).includes('run_failure=') && tExec(mod).includes('attempt 级') },
  { id: 'M4-fuse62', desc: '§6.2 收尾宽限轮语义移除',
    from: '最后一轮只能交付', to: '最后一轮只可提交',
    verify: (mod) => tExec(mod).includes('### 三档熔断与收尾宽限轮') && tExec(mod).includes('最后一轮只能交付') },
  { id: 'M5-cf91', desc: '§9.1 confirmed_findings 条件渲染短路',
    from: "if (confirmedFindings !== undefined && String(confirmedFindings).trim() !== '') {", to: 'if (false) {',
    verify: (mod) => tExec(mod, { confirmedFindings: '1. a.js:1 - x - y' }).includes('confirmed_findings（上一轮已结论清单') },
  { id: 'M6-pathwarn', desc: '无路径警示行改写（降级出口消失）',
    from: '产出落盘路径：⚠️ **未指定**', to: '产出落盘路径：PATH-MISSING',
    verify: (mod) => tExec(mod).includes('产出落盘路径：⚠️ **未指定**') },
  { id: 'M7-gate-dangle', desc: '硬门①降级措辞回退为悬空「上面指定路径」',
    from: '路径未预置——按「产出落盘路径」行的降级出口确定后落盘，不得只在聊天里输出', to: '到上面指定路径',
    verify: (mod) => !tExec(mod).includes('到上面指定路径') },
  { id: 'M8-wl-off', desc: '只读白名单渲染调用移除',
    from: 'L.push(...readonlyToolSection(role))', to: ';',
    verify: (mod) => tRo(mod).includes('### 只读工具白名单（readonly 硬边界）') },
  { id: 'M9-wl-open', desc: '白名单门控失效（可写角色也携带）',
    from: 'return role.readonly === true ? READONLY_WHITELIST : []', to: 'return READONLY_WHITELIST',
    verify: (mod) => !tExec(mod).includes('### 只读工具白名单（readonly 硬边界）') },
  { id: 'M10-organizer', desc: 'organizer 缺失警示移除',
    from: " ⚠️ **未携带组织者会话 ID**——完成后向派活方（wake 你的来源）索取直投地址，禁止群发", to: " （无直投地址）",
    verify: (mod) => broadcastLine(tExec(mod)).includes('未携带组织者会话 ID') },
]

let failed = 0
const fail = (msg) => { failed += 1; console.log(`  [FAIL] ${msg}`) }

// ── 自检：谓词在未变异原件上必须全真（harness 自身有鉴别力的前提） ──
const lib = await import(pathToFileURL(SRC).href)
const originalSrc = readFileSync(SRC, 'utf8')
console.log('== original self-check（谓词在原件上必须为真） ==')
for (const m of MUTANTS) {
  const hits = originalSrc.split(m.from).length - 1
  if (hits !== 1) { fail(`${m.id} 锚点失配（出现 ${hits} 次，须恰 1 次）——源码已漂移，先修本工具再回归`); continue }
  let ok = false
  try { ok = m.verify(lib, originalSrc) === true } catch (e) { fail(`${m.id} 自检抛错：${e?.message ?? e}`); continue }
  if (!ok) fail(`${m.id} 自检为假——谓词/锚点损坏`)
  else console.log(`  [OK] ${m.id} ${m.desc}`)
}
if (failed > 0) { console.log(`aborted: harness self-check failed (${failed})`); process.exit(1) }

// ── 变异注入：每个变异体上谓词必须变假（红） ──
console.log('== mutants（谓词在变异体上必须为假 = 注入必红） ==')
// 变异体必须写进 lib/ 目录本身：taskbook.js 相对导入 ./roles.js，换目录即断链。
mkdirSync(LIBDIR, { recursive: true })
try {
  for (const m of MUTANTS) {
    const mutated = originalSrc.replace(m.from, m.to)
    if (mutated === originalSrc) { fail(`${m.id} 变异未生效（替换零命中）`); continue }
    const file = join(LIBDIR, `.tmp-26a-neg-${m.id}-${Math.random().toString(36).slice(2, 8)}.mjs`)
    writeFileSync(file, mutated, 'utf8')
    try {
      const mod = await import(pathToFileURL(file).href)
      const stillGreen = m.verify(mod, mutated) === true
      if (stillGreen) fail(`${m.id} 未变红——断言对该缺陷无鉴别力`)
      else console.log(`  [OK] ${m.id} 红`)
    } catch (e) {
      fail(`${m.id} 变异体加载失败：${e?.message ?? e}`)
    } finally {
      rmSync(file, { force: true })
    }
  }
} finally {
  // ⚠️ 只清理变异体文件本身（内层 finally 已逐个删）——绝不 rmSync(LIBDIR)：
  // LIBDIR 就是 lib/ 本体，对它递归删除会把整个包源码删掉（2026-09-29 两次实证）。
  try {
    for (const f of readdirSync(LIBDIR)) {
      if (f.startsWith('.tmp-26a-neg-')) rmSync(join(LIBDIR, f), { force: true })
    }
  } catch { /* 清理失败不掩报 */ }
}

console.log(`==== taskbook-26a-negative: ${MUTANTS.length - failed}/${MUTANTS.length} mutants red ====`)
process.exit(failed === 0 ? 0 : 1)
