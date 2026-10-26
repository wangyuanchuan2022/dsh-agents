#!/usr/bin/env node
/**
 * usage-probe.mjs — 会话日志 usage/token 持久化探针（M3 缓存对照测量基建，AC-C5 闭案）。
 *
 * 底稿：agent-out/opt-r2-probe-usage.mjs（planner 预验证探针，plan-opt-r2 §一事实①），
 *       正式化依据 plan-opt-r2 §五「第 0 步：M3 持久化探针形式化」。
 * 复用：tools/zstd-read.mjs（多帧 zstd 读取：帧边界 FCS 截断 + fail-closed 预算 + 去重行）；
 *       sessions 目录遍历与 junction 防御层移植自 tools/measure-decay.mjs iterSessionLogs
 *       （root 参数化；realpathSync.native 规范路径 + 包含判定——Windows JS realpath 对
 *       junction 判不出重解析点，必须用 native 版，2026-10-25 measure-decay 实证）。
 *
 * 测量口径（承 plan-opt-r2 §一事实①，planner 2026-10-25 亲测）：
 *   - usage 承载事件 = data.usage 对象存在的行（实测载体 = assistant/message）；
 *   - 四元组 { inputTokens, outputTokens, totalTokens, cacheReadTokens }，
 *     恒等式 totalTokens = input + output + cacheRead（cacheWriteTokens 实测恒 0/缺省）；
 *   - 首请求 = 日志序首个承载 usage 的事件（冷启动读数，D-3 主读数），第二请求单列作稳态参照；
 *   - cacheHitShare = cacheRead / (input + cacheRead)（与底稿 AVG 口径一致）。
 *
 * 诊断口径（对底稿的显式增强，三类变异体对应 selftest 断言）：
 *   - 缺 canonical 字段（四元组任一缺失/非有限数值）→ 计入 requestsWithMissing /
 *     missingCacheRead，缺失域按 0 入合计，不静默；
 *   - 坏 JSON 行 → badLines 计数，不静默丢弃；
 *   - 空 usage（对象存在但四元组全缺失）→ emptyUsage 单列，不计入请求数（防零值行虚增请求数）；
 *   - 跨帧重复行（dupLines > 0，帧边界吞并痕迹）→ fail-closed 拒测（同 measure-decay）；
 *   - 恒等式不符 → identityMismatches 计数。
 *
 * 用法：
 *   node tools/usage-probe.mjs --selftest
 *   node tools/usage-probe.mjs <session.v4.jsonl.zstd | session.jsonl> [...]   # 逐文件读数
 *   node tools/usage-probe.mjs --scan [dir] [--json] [--limit N] [--verbose]   # 缺省 dir=~/.dsh/sessions
 *
 * 输出脱敏：会话只以 sessionId 标识；cwd/消息正文/工具参数一律不出现；
 * 日志文件默认只出 basename，完整路径仅 --verbose 文本行（JSON/CSV 摘要与 errors 均不含路径）。
 * 只读宿主会话日志；零网络、零 spawn、零仓源码改动（--selftest 夹具写 os.tmpdir() 并清理）。
 * 退出码：0=读数完成且无拒测；1=读数失败（逐文件模式任一文件失败 / --scan 模式 errors>0
 * 部分拒测——CODE-P2-3，2026-10-26 起与逐文件模式语义对齐，不做「scan 恒 0」文档化豁免）；2=用法错误。
 */
import { readFileSync, existsSync, readdirSync, statSync, realpathSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { zstdCompressSync, constants } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { zstdReadInfo, countFrames } from './zstd-read.mjs'

// canonical 四元组（事实①口径）；cacheWrite 为附注观测域，不计入 canonical 缺失诊断
const QUAD = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens']
const SCAN_DEFAULT_ROOT = join(homedir(), '.dsh', 'sessions')

function share(cacheRead, input) {
  return +((cacheRead / Math.max(1, input + cacheRead)) * 100).toFixed(1)
}

/** 解析 JSONL 文本为事件数组；返回 { ev, bad, lines }。 */
function parseEventsText(text) {
  const lines = text.split('\n').filter(Boolean)
  const ev = []
  let bad = 0
  for (const line of lines) {
    try { ev.push(JSON.parse(line)) } catch { bad++ }
  }
  return { ev, bad, lines: lines.length }
}

/** 读一个会话日志文件（.zstd 多帧自动识别，否则按明文 JSONL）。
 *  zstd 解压超预算/完整性异常在 zstdReadInfo 内抛错（fail-closed 上抛给调用方）。 */
function readSessionFile(path) {
  const buf = readFileSync(path)
  const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
  if (!isZstd) return { ...parseEventsText(buf.toString('utf-8')), isZstd, zstd: null }
  const info = zstdReadInfo(buf)
  return { ...parseEventsText(info.text), isZstd, zstd: { frames: info.frames, truncated: info.truncated, dupLines: info.dupLines } }
}

function sessionMeta(ev) {
  const head = ev.find((o) => o?.type === 'session')
  return { id: head?.id || null, createdAt: Number.isFinite(head?.createdAt) ? head.createdAt : null }
}

/** 逐事件抽取 usage：返回 requests（含首/次请求）与全部诊断计数。 */
function usageOf(ev) {
  const requests = []
  const carriers = new Map()
  let emptyUsage = 0
  let missingCacheRead = 0
  let requestsWithMissing = 0
  let identityMismatches = 0
  for (const o of ev) {
    const u = o?.data?.usage
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue
    const t = String(o?.type ?? o?.event ?? o?.kind ?? '?')
    carriers.set(t, (carriers.get(t) ?? 0) + 1)
    const pick = (k) => (Number.isFinite(u[k]) ? u[k] : null)
    const input = pick('inputTokens')
    const output = pick('outputTokens')
    const total = pick('totalTokens')
    const cacheRead = pick('cacheReadTokens')
    const cacheWrite = pick('cacheWriteTokens')
    // 空 usage：对象存在但四元组全缺失——单列诊断，不计入请求数（防零值行虚增）
    if (input === null && output === null && total === null && cacheRead === null) { emptyUsage++; continue }
    const missing = QUAD.filter((k) => pick(k) === null).length
    if (missing > 0) {
      requestsWithMissing++
      if (cacheRead === null) missingCacheRead++
    }
    const i = input ?? 0, o2 = output ?? 0, t2 = total ?? 0, c = cacheRead ?? 0
    if (total !== null && t2 !== i + o2 + c) identityMismatches++
    requests.push({ type: t, input: i, output: o2, total: t2, cacheRead: c, cacheWrite: cacheWrite ?? 0 })
  }
  return { requests, carriers, emptyUsage, missingCacheRead, requestsWithMissing, identityMismatches }
}

/** 会话级读数：合计/均值/cacheHitShare + 首请求冷启动单列 + 第二请求稳态参照。 */
function sessionStats(ev, fileMeta) {
  const { requests, carriers, emptyUsage, missingCacheRead, requestsWithMissing, identityMismatches } = usageOf(ev)
  const meta = sessionMeta(ev)
  const sum = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
  for (const r of requests) {
    sum.input += r.input; sum.output += r.output; sum.total += r.total
    sum.cacheRead += r.cacheRead; sum.cacheWrite += r.cacheWrite
  }
  const n = requests.length
  const pickReq = (r) => r && { input: r.input, output: r.output, cacheRead: r.cacheRead, total: r.total, cacheWrite: r.cacheWrite, cacheHitShare: share(r.cacheRead, r.input) }
  const row = {
    sessionId: meta.id,
    createdAt: meta.createdAt,
    requests: n,
    input: sum.input,
    output: sum.output,
    totalTokens: sum.total,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    cacheHitShare: share(sum.cacheRead, sum.input),
    meanInput: n ? Math.round(sum.input / n) : 0,
    meanOutput: n ? Math.round(sum.output / n) : 0,
    meanCacheRead: n ? Math.round(sum.cacheRead / n) : 0,
    firstRequest: pickReq(requests[0] ?? null),
    secondRequest: pickReq(requests[1] ?? null),
    emptyUsage,
    requestsWithMissing,
    missingCacheRead,
    identityMismatches,
    carriers: Object.fromEntries(carriers),
    badLines: fileMeta.bad,
    isZstd: fileMeta.isZstd,
    zstdFrames: fileMeta.zstd ? fileMeta.zstd.frames : null,
    file: fileMeta.file,
  }
  Object.defineProperty(row, 'zpath', { value: fileMeta.zpath, enumerable: false })
  return row
}

/** 读一个日志文件 → 会话级读数（dupLines>0 fail-closed 拒测，同 measure-decay）。 */
function probeFile(path) {
  const parsed = readSessionFile(path)
  if (parsed.zstd && parsed.zstd.dupLines > 0) {
    throw new Error(`跨帧重复行 ${parsed.zstd.dupLines} 条（帧边界吞并痕迹）：usage 读数不可信，拒绝（fail-closed）`)
  }
  return sessionStats(parsed.ev, { bad: parsed.bad, isZstd: parsed.isZstd, zstd: parsed.zstd, file: basename(path), zpath: path })
}

// ---------- --scan：目录遍历 + junction 防御（移植 measure-decay iterSessionLogs，root 参数化） ----------

function iterSessionLogs(root) {
  if (!existsSync(root)) return []
  // junction/越界防护：Windows 上 JS realpathSync 对 junction 判不出重解析点，必须用
  // realpathSync.native 取规范路径再做包含判定——目录内被投放指向 root 之外的 junction
  // 时跳过该子树，读取面不越出 root（2026-10-25 measure-decay 存疑-1 实证修复）。
  let rootReal
  try { rootReal = realpathSync.native(root).toLowerCase() } catch { return [] }
  const withinRoot = (p) => {
    try {
      const r = realpathSync.native(p).toLowerCase()
      return r !== rootReal && r.startsWith(rootReal + sep.toLowerCase())
    } catch { return false } // 断链 junction / 竞态删除：跳过
  }
  const out = []
  for (const ws of readdirSync(root)) {
    const wsPath = join(root, ws)
    let wsSt
    try { wsSt = statSync(wsPath) } catch { continue }
    if (!wsSt.isDirectory()) continue
    if (!withinRoot(wsPath)) continue
    for (const sd of readdirSync(wsPath)) {
      const sPath = join(wsPath, sd)
      let sSt
      try { sSt = statSync(sPath) } catch { continue }
      if (!sSt.isDirectory()) continue
      if (!withinRoot(sPath)) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
        const zp = join(sPath, name)
        if (!existsSync(zp)) continue
        // 文件级越界防护（2026-10-26 security R2 P2-2，与 measure-decay 同步修）：日志文件
        // 本身也可能是指向 root 外的 reparse point，入队前同样过包含判定，越界/断链跳过。
        if (!withinRoot(zp)) continue
        out.push({ zpath: zp }); break
      }
    }
  }
  return out.sort((a, b) => (a.zpath < b.zpath ? -1 : 1))
}

function scanAll(root) {
  const rows = []
  const errors = []
  for (const { zpath } of iterSessionLogs(root)) {
    try {
      rows.push(probeFile(zpath))
    } catch (e) {
      errors.push({ file: basename(zpath), error: String(e && e.message || e).split(zpath).join(basename(zpath)).slice(0, 120) })
    }
  }
  return { rows, errors }
}

function totalsOf(rows) {
  const t = { sessions: rows.length, withUsage: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, emptyUsage: 0, requestsWithMissing: 0, identityMismatches: 0 }
  for (const r of rows) {
    if (r.requests > 0) t.withUsage++
    t.requests += r.requests; t.input += r.input; t.output += r.output
    t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite
    t.emptyUsage += r.emptyUsage; t.requestsWithMissing += r.requestsWithMissing; t.identityMismatches += r.identityMismatches
  }
  return t
}

function textRow(r) {
  const f = r.firstRequest
  const first = f ? `1st{in=${f.input},cr=${f.cacheRead},share=${f.cacheHitShare}%}` : '1st{-}'
  return [
    `req=${r.requests}`,
    `in=${r.input}`,
    `cacheRead=${r.cacheRead}`,
    `out=${r.output}`,
    `share=${r.cacheHitShare}%`,
    first,
    `miss=${r.requestsWithMissing}(cr:${r.missingCacheRead})`,
    `empty=${r.emptyUsage}`,
    `ident=${r.identityMismatches}`,
    `bad=${r.badLines}`,
  ].join(' ')
}

function runScan(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  // --scan 后第一个非 -- 开头参数为目录（缺省 ~/.dsh/sessions）
  const si = argv.indexOf('--scan')
  let dir = SCAN_DEFAULT_ROOT
  const nxt = si >= 0 && si + 1 < argv.length ? argv[si + 1] : null
  if (nxt && !nxt.startsWith('--')) dir = nxt
  // P2-9 同款显式校验：--limit 需非负整数，缺失/非法不得静默变缺省
  const num = (k, dflt) => {
    const v = get(k)
    if (v === null) return dflt
    if (!/^\d+$/.test(String(v))) {
      console.error(`[用法错误] ${k} 需要非负整数，收到：${v}`)
      process.exitCode = 2
      return null
    }
    return Number(v)
  }
  const limit = num('--limit', 0)
  if (limit === null) return
  const asJson = argv.includes('--json')
  const verbose = argv.includes('--verbose')
  const t0 = Date.now()
  const { rows, errors } = scanAll(dir)
  const totals = totalsOf(rows)
  const shown = [...rows].sort((a, b) => b.requests - a.requests || b.input - a.input)
  const out = limit > 0 ? shown.slice(0, limit) : shown
  if (asJson) {
    console.log(JSON.stringify({ root: basename(dir), scanned: rows.length, totals, errors, rows: out }, null, 1))
  } else {
    console.log(`scanned=${totals.sessions} withUsage=${totals.withUsage} errors=${errors.length} shown=${out.length} in ${Date.now() - t0}ms`)
    console.log(`TOTAL req=${totals.requests} in=${totals.input} cacheRead=${totals.cacheRead} out=${totals.output} cacheWrite=${totals.cacheWrite} miss=${totals.requestsWithMissing} empty=${totals.emptyUsage} ident=${totals.identityMismatches}`)
    for (const e of errors) console.error(`ERR ${e.file} :: ${e.error}`)
    for (const r of out) {
      console.log(`${(r.sessionId || '?').padEnd(40)} ${textRow(r)}`)
      if (verbose) console.log(`    ${r.zpath}`)
    }
  }
  // CODE-P2-3（2026-10-26）：部分拒测必须响亮——errors>0 时 exit 1，与逐文件模式
  // （runFiles 逐文件 exitCode=1）退出码语义对齐；脚本化消费方按退出码即可发现「部分拒测」，
  // 无需解析输出。errors 本身已双通道显式可见（stdout errors 数组 + stderr ERR 行），不静默。
  if (errors.length > 0) process.exitCode = 1
}

// ---------- --selftest：≥3 元素断言（鉴别力①）+ 三类变异体注入必红（L1-15） ----------

const CHECKSUM_OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 夹具事件构造：请求值两两不同（防「取首个/取末个/单元素」假实现全绿）。 */
function goldenEvents() {
  const mk = (type, data) => ({ type, data })
  const u = (input, output, total, cacheRead) => mk('assistant/message', { usage: { inputTokens: input, outputTokens: output, totalTokens: total, cacheReadTokens: cacheRead } })
  return [
    mk('session', { version: 4, id: 'session-selftest-fixture', createdAt: 1700000000000 }),
    mk('user/message', { text: 'hello' }),                       // 噪声：无 usage，不入读数
    u(1000, 100, 1100, 0),      // 首请求（冷启动）：cacheRead=0
    u(200, 30, 5230, 5000),     // 第二请求（稳态）
    u(300, 40, 7340, 7000),     // 第三请求
    mk('tool/call', { name: 'read', arguments: '{}' }),          // 噪声
  ]
}

function toText(ev) {
  return ev.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

function selftest() {
  let failures = 0
  const assert = (cond, label) => {
    if (cond) console.log(`  ok   ${label}`)
    else { failures++; console.error(`  FAIL ${label}`) }
  }
  const statsOf = (ev) => sessionStats(ev, { bad: 0, isZstd: false, zstd: null, file: 'fixture', zpath: 'fixture' })

  // [1] 黄金夹具（3 请求，值两两不同）：合计/均值/首请求冷启动逐项钉死
  console.log('[1] golden fixture（3 请求 + 噪声事件，值两两不同）')
  const g1 = statsOf(goldenEvents())
  assert(g1.requests === 3, `requests===3 (got ${g1.requests})`)
  assert(g1.input === 1500 && g1.output === 170 && g1.cacheRead === 12000 && g1.totalTokens === 13670,
    `合计 in=1500 out=170 cacheRead=12000 total=13670 (got ${g1.input}/${g1.output}/${g1.cacheRead}/${g1.totalTokens})`)
  assert(g1.meanInput === 500 && g1.meanCacheRead === 4000, `均值 in=500 cacheRead=4000 (got ${g1.meanInput}/${g1.meanCacheRead})`)
  assert(g1.identityMismatches === 0, `恒等式零失配 (got ${g1.identityMismatches})`)
  assert(g1.firstRequest && g1.firstRequest.input === 1000 && g1.firstRequest.cacheRead === 0,
    `首请求冷启动 in=1000 cacheRead=0 (got ${JSON.stringify(g1.firstRequest)})`)
  assert(g1.secondRequest && g1.secondRequest.cacheRead === 5000, `第二请求 cacheRead=5000 (got ${JSON.stringify(g1.secondRequest)})`)
  assert(g1.cacheHitShare === 88.9, `会话 cacheHitShare===88.9% (got ${g1.cacheHitShare})`)
  assert(g1.carriers['assistant/message'] === 3 && !g1.carriers['user/message'] && !g1.carriers['tool/call'],
    `载体只计 usage 事件 (got ${JSON.stringify(g1.carriers)})`)
  assert(g1.requestsWithMissing === 0 && g1.emptyUsage === 0, `零诊断 (got ${g1.requestsWithMissing}/${g1.emptyUsage})`)

  // [2] 变异体①缺 cacheRead 字段：删第二请求的 cacheReadTokens。
  //     断言映射：去掉缺失域诊断逻辑 → miss 断言红；静默 0 填充不诊断 → 本块全绿即假实现。
  console.log('[2] 变异①缺 cacheRead 字段（第二请求删除 cacheReadTokens）')
  const m1ev = goldenEvents().map((o, i) => {
    if (i === 3 && o.data?.usage) { const { cacheReadTokens, ...rest } = o.data.usage; void cacheReadTokens; return { ...o, data: { usage: rest } } }
    return o
  })
  const m1 = statsOf(m1ev)
  assert(m1.requests === 3, `缺字段请求仍计请求 requests===3 (got ${m1.requests})`)
  assert(m1.missingCacheRead === 1 && m1.requestsWithMissing === 1, `缺 cacheRead 诊断=1 (got cr:${m1.missingCacheRead}/all:${m1.requestsWithMissing})`)
  assert(m1.cacheRead === 7000, `缺字段按 0 入合计 cacheRead===7000=12000-5000 (got ${m1.cacheRead})`)
  assert(m1.identityMismatches === 1, `totalTokens 有值而缺失域按 0 → 恒等式失配被暴露 ident===1 (got ${m1.identityMismatches})`)

  // [3] 变异体②坏 JSON 行：合法行间注入一条坏行。
  //     断言映射：去掉 badLines 计数（静默丢弃）→ bad 断言红。
  console.log('[3] 变异②坏 JSON 行（1 条坏行夹在合法行间）')
  const ev2 = goldenEvents()
  const lines2 = toText(ev2).split('\n').filter(Boolean)
  lines2.splice(3, 0, '{"type":"assistant/message","data":{"usage":{"inputTokens":')
  const p2 = parseEventsText(lines2.join('\n') + '\n')
  assert(p2.bad === 1, `坏行计数 bad===1 (got ${p2.bad})`)
  assert(p2.ev.length === ev2.length, `合法行全数解析 ev===${ev2.length} (got ${p2.ev.length})`)
  const g2 = sessionStats(p2.ev, { bad: p2.bad, isZstd: false, zstd: null, file: 'fixture', zpath: 'fixture' })
  assert(g2.requests === 3 && g2.input === 1500 && g2.badLines === 1, `坏行不入读数且留痕 req=3 in=1500 bad=1 (got ${g2.requests}/${g2.input}/${g2.badLines})`)

  // [4] 变异体③空 usage（四元组全缺失的空对象）。
  //     断言映射：把空 usage 计入请求数（虚增）→ requests 断言红；静默吞掉 → empty 断言红。
  console.log('[4] 变异③空 usage（data.usage = {}）')
  const m3ev = [...goldenEvents(), { type: 'assistant/message', data: { usage: {} } }]
  const m3 = statsOf(m3ev)
  assert(m3.emptyUsage === 1, `空 usage 单列诊断 empty===1 (got ${m3.emptyUsage})`)
  assert(m3.requests === 3, `空 usage 不虚增请求数 requests===3 (got ${m3.requests})`)
  assert(m3.input === 1500 && m3.cacheRead === 12000, `合计不受空 usage 污染 in=1500 cacheRead=12000 (got ${m3.input}/${m3.cacheRead})`)
  assert(m3.carriers['assistant/message'] === 4, `载体计数含空 usage 事件=4（与请求数 3 区分）(got ${m3.carriers['assistant/message']})`)

  // [5] zstd 多帧端到端接线：黄金夹具写成 2 帧 zstd（header 帧 + 事件帧），读回读数必须一致
  console.log('[5] zstd 多帧端到端（2 帧：header + 事件）')
  let tmp = null
  try { tmp = mkdtempSync(join(tmpdir(), 'usage-probe-selftest-')) } catch { tmp = null }
  if (!tmp) { tmp = join(process.cwd(), 'agent-out', `.usage-selftest-${process.pid}-${Date.now()}`); mkdirSync(tmp, { recursive: true }) }
  try {
    const ev = goldenEvents()
    const header = ev.filter((o) => o.type === 'session')
    const rest = ev.filter((o) => o.type !== 'session')
    const zp = join(tmp, 'fixture.v4.jsonl.zstd')
    writeFileSync(zp, Buffer.concat([
      zstdCompressSync(Buffer.from(toText(header)), CHECKSUM_OPTS),
      zstdCompressSync(Buffer.from(toText(rest)), CHECKSUM_OPTS),
    ]))
    const buf = readFileSync(zp)
    assert(countFrames(buf) === 2, `帧数===2 (got ${countFrames(buf)})`)
    const rz = probeFile(zp)
    assert(rz.zstdFrames === 2, `读回帧数===2 (got ${rz.zstdFrames})`)
    assert(rz.requests === 3 && rz.input === 1500 && rz.cacheRead === 12000, `zstd 读回与内存夹具一致 req=3 in=1500 cr=12000 (got ${rz.requests}/${rz.input}/${rz.cacheRead})`)
    assert(rz.firstRequest.cacheRead === 0 && rz.secondRequest.cacheRead === 5000, `zstd 读回冷启动/稳态一致 (got ${rz.firstRequest.cacheRead}/${rz.secondRequest.cacheRead})`)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不遮蔽断言结果 */ }
  }

  if (failures) {
    console.error(`SELFTEST FAIL (${failures} 断言失败)`)
    process.exit(1)
  }
  console.log(`SELFTEST OK | golden req=${g1.requests} in=${g1.input} cacheRead=${g1.cacheRead} share=${g1.cacheHitShare}% | 变异必红断言 3/3 在位（缺字段/坏JSON/空usage）`)
  return 0
}

// ---------- main ----------

function runFiles(files) {
  for (const f of files) {
    let row
    try { row = probeFile(f) } catch (e) {
      console.error(`[usage-probe] ${basename(f)} :: ${String(e && e.message || e)}`)
      process.exitCode = 1
      continue
    }
    console.log(`\n=== ${basename(f)}`)
    console.log(textRow(row))
    console.log(`carriers: ${Object.entries(row.carriers).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`)
    if (row.secondRequest) {
      console.log(`2nd{in=${row.secondRequest.input},cr=${row.secondRequest.cacheRead},share=${row.secondRequest.cacheHitShare}%}`)
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--selftest') { selftest(); return }
  if (argv[0] === '--scan') { runScan(argv); return }
  const files = argv.filter((a) => !a.startsWith('--'))
  if (files.length > 0) { runFiles(files); return }
  console.error('用法: node tools/usage-probe.mjs <file.zstd|file.jsonl> [...] | --selftest | --scan [dir] [--json] [--limit N] [--verbose]')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
