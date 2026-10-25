#!/usr/bin/env node
/**
 * measure-decay.mjs — 会话日志工具调用密度衰减测量（早/中/晚三段）。
 *
 * 移植自：yjh051108/dsh-routing-suite main@1952733 graded/scripts/measure.mjs（MIT License）
 *   上游：https://github.com/yjh051108/dsh-routing-suite/tree/1952733/graded/scripts/measure.mjs
 * 保留上游口径：--selftest 小样夹具断言计数；分三段 = 事件索引三等分；
 * 聚合输出零文本内容（脱敏：只出计数，不出任何消息/参数正文）。
 * 本地适配（与上游的差异，均有据）：
 *   1) 输入支持宿主 session(.v4).jsonl.zstd（多帧循环解压，经 tools/zstd-read.mjs）
 *      与普通 .jsonl；上游只吃明文 JSONL；
 *   2) 测量总体 = 核心会话骨架事件（user/message、assistant/message、tool/call、
 *      tool/result）——库外插件事件（如 session-log-demo/heartbeat、approval/asked
 *      等白名单外类型）只计入 otherEvents 聚合计数，不逐项列出、不落盘（任务书「事件类型白名单」条款）。
 *      上游日志无插件噪声，分段直接用全体事件；宿主日志不滤插件事件会稀释晚段密度，
 *      故分段在核心骨架上做（口径写死于此，复跑 ±0 以本文件为准）；
 *   3) --selftest 在上游 10 事件夹具之外，新增 ≥2 帧 zstd 文件夹具与单帧对照——
 *      防「只解第一帧也退出码 0」的假绿（plan-opt-r1 §九风险 7 / 断言鉴别力②）；
 *      解析类断言均 ≥3 元素输入（断言鉴别力①）；
 *   4) 新增 --scan（批量测量 ~/.dsh/sessions 全部会话）与 --cases（确定性候选规则）模式；
 *   5) measure 新增 tailDangling 死亡签名字段（悬尾事件对检测，L1-04 无声死亡特征）：
 *      实测三段衰减对「日志在死亡点直接截断」的会话结构性失明（截断不改变早段均匀交织），
 *      衰减口径抓摆烂（持续产出文本不调工具），死亡靠尾悬事件识别——两族信号互补。
 *   6) zstd 读取安全接线（2026-10-25 security R1 P1-1 收口）：读端换 zstdReadInfo
 *      （帧边界 FCS 截断 + 解压预算 fail-closed），跨帧重复行（dupLines>0，帧边界吞并痕迹）
 *      一律 fail-closed 拒测——旧实现把被吞帧内容静默重复计入读数（真实日志实测 3 文件 5 重复行）；
 *      --selftest 新增大帧（16KiB 对齐贪读）夹具与预算注入必红断言（旧夹具全小帧，对此零鉴别力）。
 *
 * 用法：
 *   node tools/measure-decay.mjs --selftest
 *   node tools/measure-decay.mjs <session.v4.jsonl.zstd | session.jsonl> [--json]
 *   node tools/measure-decay.mjs --scan [--min-core N] [--limit N] [--json] [--verbose]
 *   node tools/measure-decay.mjs --cases [--json]
 *
 * 输出脱敏：会话只以 sessionId 标识；cwd/消息正文/工具参数一律不出现在输出。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { zstdRead, zstdReadInfo, countFrames, dedupLines } from './zstd-read.mjs'

const SEGMENTS = ['early', 'mid', 'late']
// 核心会话骨架事件类型（测量总体；白名单外的只进 otherEvents 聚合数）
const CORE_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
// --cases 确定性候选规则参数（规则参数非结论判定；方向判定归用户，C-8）
const CASES_MIN_CORE = 120        // 长会话下限：核心事件数
const CASES_MIN_TOOLS = 30        // 长会话下限：工具调用总数
const CASES_MIN_EARLY_TOOLS = 10  // 早段工具数下限（防小分子噪声）
const CASES_CLIFF_RATIO = 0.15    // 晚段/早段 ≤ 0.15 → 骤降候选
const CASES_HEALTHY_RATIO = 0.5   // 晚段/早段 ≥ 0.5 且晚段 ≥ 5 → 健康对照
// --scan 显示下限（核心事件数）；0 = 全量
const SCAN_DEFAULT_MIN_CORE = 30

/** 解析 JSONL 文本为事件数组（跳过非 JSON 行）；返回 {ev, bad}。 */
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
 *  返回 { ev, bad, lines, isZstd, zstd }；zstd = { frames, truncated, dupLines }（非 zstd 为 null）。
 *  zstd 解压超预算/完整性异常在 zstdReadInfo 内抛错（fail-closed 上抛给调用方）。 */
function readSessionFile(path) {
  const buf = readFileSync(path)
  const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
  if (!isZstd) return { ...parseEventsText(buf.toString('utf-8')), isZstd, zstd: null }
  const info = zstdReadInfo(buf)
  return { ...parseEventsText(info.text), isZstd, zstd: { frames: info.frames, truncated: info.truncated, dupLines: info.dupLines } }
}

/** 从事件流取会话头元数据（仅 id/createdAt，不取 cwd）。 */
function sessionMeta(ev) {
  const head = ev.find((o) => o?.type === 'session')
  return { id: head?.id || null, createdAt: Number.isFinite(head?.createdAt) ? head.createdAt : null }
}

/** 核心测量（上游 measure(ev) 移植 + 宿主适配字段）。 */
function measure(ev) {
  const core = ev.filter((o) => CORE_TYPES.has(o?.type))
  const tools = {}
  const marks = []
  let readImages = 0, redteam = 0
  for (const o of ev) {
    if (o?.type !== 'tool/call') continue
    const n = o?.data?.name
    if (n === 'mark_task') {
      let a = {}
      try { a = JSON.parse(o.data.arguments || '{}') } catch { /* 参数非 JSON：按空处理 */ }
      marks.push({ level: a.level, title: a.title })
    } else if (n) {
      tools[n] = (tools[n] || 0) + 1
    }
    if (n === 'read_image') readImages++
    if (n === 'redteam_verdict') redteam++
  }
  const totalTools = Object.values(tools).reduce((a, b) => a + b, 0)
  const totalToolCalls = core.filter((o) => o?.type === 'tool/call').length
  // 分段：核心骨架按事件索引三等分（早/中/晚）——口径承上游（上游对全体事件分段）
  const n = core.length
  const segStats = SEGMENTS.map((name, i) => {
    const part = core.slice(Math.floor(n * i / 3), Math.floor(n * (i + 1) / 3))
    const toolsInSeg = part.filter((o) => o?.type === 'tool/call')
    return {
      name,
      events: part.length,
      tools: toolsInSeg.length, // 口径 = tool/call 事件数（含 mark_task，同上游）
      density: part.length ? +(toolsInSeg.length / part.length).toFixed(3) : 0,
      share: totalToolCalls ? +((toolsInSeg.length / totalToolCalls) * 100).toFixed(1) : 0,
    }
  })
  // 末次工具调用在核心骨架中的位置比（尾部静默信号）
  let lastToolIdx = -1
  for (let i = core.length - 1; i >= 0; i--) {
    if (core[i]?.type === 'tool/call') { lastToolIdx = i; break }
  }
  // 死亡签名（L1-04 无声死亡特征）：日志尾部「等回应型」事件未获配对回应——
  // tool/call 无后续 tool/result、step/start 无 end、turn/start 无 end、
  // approval/asked 无 decided、compaction/start 无 end。按固定优先级序取首个命中
  // （tool/call > step/start > turn/start > approval/asked > compaction/start），
  // 不是「最靠后者」——注释与实现口径已于 2026-10-25 P2-6 对齐。
  // 测量学注记：三段密度衰减对「日志在死亡点直接截断」的会话结构性失明
  // （截断不改变前段均匀交织），衰减口径抓的是摆烂（持续产出文本不调工具）；
  // 死亡靠尾悬事件识别——两族信号互补，缺一不可。
  const lastIdx = {}
  for (let i = ev.length - 1; i >= 0; i--) {
    const t = ev[i]?.type
    if (t && !(t in lastIdx)) lastIdx[t] = i
  }
  const gt = (a, b) => (lastIdx[a] ?? -1) > (lastIdx[b] ?? -1)
  let tailDangling = null
  if (gt('tool/call', 'tool/result')) tailDangling = 'tool/call'
  else if (gt('step/start', 'step/end')) tailDangling = 'step/start'
  else if (gt('turn/start', 'turn/end')) tailDangling = 'turn/start'
  else if (gt('approval/asked', 'approval/decided')) tailDangling = 'approval/asked'
  else if (gt('compaction/start', 'compaction/end')) tailDangling = 'compaction/start'
  const times = ev.map((o) => o?.time).filter((t) => Number.isFinite(t))
  const spanMin = times.length >= 2 ? +(((Math.max(...times) - Math.min(...times)) / 60000)).toFixed(1) : 0
  const firstEventAt = times.length ? Math.min(...times) : null
  const lastEventAt = times.length ? Math.max(...times) : null
  // otherEvents = 白名单外事件（插件/宿主杂项），会话头行（type==='session'）为结构事件不计入
  const nSession = ev.filter((o) => o?.type === 'session').length
  return {
    coreEvents: n,
    otherEvents: ev.length - n - nSession,
    tools: totalTools,
    toolBreakdown: tools,
    toolCalls: totalToolCalls,
    marks: marks.length,
    markL2: marks.filter((m) => m.level === 'L2').length,
    markL1: marks.filter((m) => m.level === 'L1').length,
    readImages,
    redteam,
    segments: segStats,
    lastToolRatio: core.length > 1 && lastToolIdx >= 0 ? +(lastToolIdx / (core.length - 1)).toFixed(3) : null,
    tailDangling,
    spanMin,
    firstEventAt,
    lastEventAt,
  }
}

function textRow(m) {
  const segs = m.segments.map((s) => `${s.name}:${s.tools}t/d${s.density}/s${s.share}%`).join(' ')
  const tail = m.lastToolRatio === null ? 'lastTool@-' : `lastTool@${Math.round(m.lastToolRatio * 100)}%`
  return [
    `core=${m.coreEvents}`,
    `tools=${m.tools}`,
    `marks=${m.marks}(L2:${m.markL2},L1:${m.markL1})`,
    `read_image=${m.readImages}`,
    `redteam=${m.redteam}`,
    `other=${m.otherEvents}`,
    `span=${m.spanMin}min`,
    `dangling=${m.tailDangling ?? '-'}`,
    tail,
    `segments=${segs}`,
  ].join(' | ')
}

// ---------- 夹具与自测 ----------

const CHECKSUM_OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 上游小样夹具（graded 工具形态，10+ 事件，断言口径同上游）。 */
function gradedFixture() {
  const ev = []
  const push = (type, data) => ev.push({ type, data })
  for (let i = 0; i < 4; i++) push('user/message', { content: [{ type: 'text', text: `hello ${i}` }] })
  push('tool/call', { name: 'pwsh', arguments: JSON.stringify({ command: 'ls' }) })
  push('tool/call', { name: 'read_image', arguments: JSON.stringify({ file_path: 'x.png' }) })
  for (let i = 0; i < 3; i++) push('user/message', { content: [{ type: 'text', text: `mid ${i}` }] })
  push('tool/call', { name: 'pwsh', arguments: JSON.stringify({ command: 'pwd' }) })
  push('tool/call', { name: 'mark_task', arguments: JSON.stringify({ level: 'L2', title: '项', status: 'completed' }) })
  push('tool/call', { name: 'mark_task', arguments: JSON.stringify({ level: 'L1', title: '组', status: 'completed' }) })
  push('tool/result', { message: { content: [{ type: 'tool-result', text: 'ok' }] } })
  return ev
}

/** 宿主 v4 形态夹具：核心骨架 24 事件（early 4 工具 / mid 2 / late 0，三段计数两两不同）
 *  + 3 条库外插件事件（session-log-demo/heartbeat，须只进 otherEvents）。 */
function hostFixture() {
  const ev = []
  const t = (i) => ({ type: 'tool/call', seq: i, time: 1700000000000 + i * 1000, data: { name: i % 2 ? 'pwsh' : 'read', arguments: '{}' } })
  const tr = (i) => ({ type: 'tool/result', seq: i, time: 1700000000000 + i * 1000, data: {} })
  const u = (i) => ({ type: 'user/message', seq: i, time: 1700000000000 + i * 1000, data: { id: `u${i}` } })
  const a = (i) => ({ type: 'assistant/message', seq: i, time: 1700000000000 + i * 1000, data: { message: { id: `a${i}` } } })
  const plug = (i) => ({ type: 'session-log-demo/heartbeat', seq: i, time: 1700000000000 + i * 1000, data: { n: i } })
  // 核心 24 事件：early[0..7]=t,tr,t,tr,t,tr,t,tr（4 工具）mid[8..15]=t,tr,t,tr,u,a,u,a（2 工具）late[16..23]=u,a×8（0 工具）
  let s = 0
  const core = []
  for (let i = 0; i < 4; i++) { core.push(t(s)); core.push(tr(s)); s++ }
  for (let i = 0; i < 2; i++) { core.push(t(s)); core.push(tr(s)); s++ }
  core.push(u(s++)); core.push(a(s++)); core.push(u(s++)); core.push(a(s++))
  for (let i = 0; i < 8; i++) { core.push(i % 2 ? a(s) : u(s)); s++ }
  // 插件事件穿插：早段后、中段后、晚段中
  ev.push({ type: 'session', version: 4, id: 'session-selftest-fixture', createdAt: 1700000000000 })
  ev.push(...core.slice(0, 8), plug(100))
  ev.push(...core.slice(8, 16), plug(101))
  ev.push(...core.slice(16, 20), plug(102), ...core.slice(20))
  return ev
}

/** 把事件数组写成多帧 zstd 文件（模拟宿主写端：首帧 header + 后续事件帧，带 checksum）。 */
function writeZstdFrames(path, evGroups) {
  const bufs = evGroups.map((g) => zstdCompressSync(Buffer.from(g.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf-8'), CHECKSUM_OPTS))
  writeFileSync(path, Buffer.concat(bufs))
}

function selftest() {
  let failures = 0
  const assert = (cond, label) => {
    if (cond) console.log(`  ok   ${label}`)
    else { failures++; console.error(`  FAIL ${label}`) }
  }

  // 夹具 1：上游 graded 小样（口径同上游 selftest）
  console.log('[1] graded fixture（上游口径）')
  const m1 = measure(gradedFixture())
  assert(m1.tools === 3, `tools===3 (got ${m1.tools})`)
  assert(m1.readImages === 1, `readImages===1 (got ${m1.readImages})`)
  assert(m1.marks === 2 && m1.markL2 === 1 && m1.markL1 === 1, `marks===2 L2===1 L1===1 (got ${m1.marks}/${m1.markL2}/${m1.markL1})`)
  assert(m1.redteam === 0, `redteam===0 (got ${m1.redteam})`)
  assert(m1.segments.reduce((a, b) => a + b.tools, 0) === 5, `segment tool/call 总数===5 含 mark_task (got ${m1.segments.reduce((a, b) => a + b.tools, 0)})`)

  // 夹具 2：宿主 v4 形态（三段计数 4/2/0 两两不同——分不出「三等分」与「取首个」的断言没有鉴别力）
  console.log('[2] host v4 fixture（三段 4/2/0 + 插件事件白名单外）')
  const fix = hostFixture()
  const m2 = measure(fix)
  assert(m2.coreEvents === 24, `coreEvents===24 (got ${m2.coreEvents})`)
  assert(m2.otherEvents === 3, `otherEvents===3 插件事件只计数 (got ${m2.otherEvents})`)
  assert(!('session-log-demo/heartbeat' in m2.toolBreakdown), '插件事件不入 toolBreakdown')
  assert(m2.toolCalls === 6 && m2.tools === 6, `tools===6 (got ${m2.tools})`)
  assert(m2.segments[0].tools === 4, `early===4 (got ${m2.segments[0].tools})`)
  assert(m2.segments[1].tools === 2, `mid===2 (got ${m2.segments[1].tools})`)
  assert(m2.segments[2].tools === 0, `late===0 (got ${m2.segments[2].tools})`)
  assert(m2.segments[0].density === 0.5, `early density===0.500 (got ${m2.segments[0].density})`)
  assert(m2.lastToolRatio > 0.3 && m2.lastToolRatio < 0.6, `lastToolRatio∈(0.3,0.6) (got ${m2.lastToolRatio})`)
  assert(m2.tailDangling === null, `尾事件为 assistant/message → 悬尾===null (got ${m2.tailDangling})`)

  // 悬尾阳性对照（L1-14 零/阴性结论必配阳性）：尾部补未配对事件应逐类命中
  const mkTail = (type) => measure([...fix, { type, seq: 999, time: 1700000099999, data: {} }]).tailDangling
  assert(mkTail('tool/call') === 'tool/call', `尾补 tool/call → 悬尾=tool/call (got ${mkTail('tool/call')})`)
  assert(mkTail('step/start') === 'step/start', `尾补 step/start → 悬尾=step/start (got ${mkTail('step/start')})`)
  assert(mkTail('turn/start') === 'turn/start', `尾补 turn/start → 悬尾=turn/start (got ${mkTail('turn/start')})`)
  assert(mkTail('approval/asked') === 'approval/asked', `尾补 approval/asked → 悬尾=approval/asked (got ${mkTail('approval/asked')})`)
  assert(mkTail('compaction/start') === 'compaction/start', `尾补 compaction/start → 悬尾=compaction/start (got ${mkTail('compaction/start')})`)
  // tool/call 在前但之后已有 tool/result → 不悬
  const mWithResult = measure([...fix, { type: 'tool/call', seq: 998, time: 1700000099998, data: {} }, { type: 'tool/result', seq: 999, time: 1700000099999, data: {} }])
  assert(mWithResult.tailDangling === null, `tool/call 后有 tool/result → 悬尾===null (got ${mWithResult.tailDangling})`)

  // 夹具 3：多帧 zstd 文件（≥2 帧，风险 7）+ 单帧对照
  console.log('[3] zstd 多帧夹具（3 帧：header + 事件两帧）与单帧对照')
  let tmp = null
  try { tmp = mkdtempSync(join(tmpdir(), 'measure-decay-selftest-')) } catch { tmp = null }
  if (!tmp) { tmp = join(process.cwd(), 'agent-out', `.selftest-${process.pid}-${Date.now()}`); mkdirSync(tmp, { recursive: true }) }
  try {
    const ev = hostFixture()
    const header = ev.filter((o) => o.type === 'session')
    const rest = ev.filter((o) => o.type !== 'session')
    const g1 = header
    const g2 = rest.slice(0, Math.ceil(rest.length / 2))
    const g3 = rest.slice(Math.ceil(rest.length / 2))
    const multi = join(tmp, 'multi.zstd')
    writeZstdFrames(multi, [g1, g2, g3])
    const multiBuf = readFileSync(multi)
    assert(countFrames(multiBuf) === 3, `多帧文件帧数===3 (got ${countFrames(multiBuf)})`)
    const parsed = parseEventsText(zstdRead(multi))
    assert(parsed.lines === 1 + rest.length, `多帧全解出行数===${1 + rest.length} (got ${parsed.lines})`)
    assert(parsed.ev.length === 1 + rest.length, `多帧全解出事件===${1 + rest.length} (got ${parsed.ev.length})`)
    assert(parsed.bad === 0, `多帧全解零坏行 (got ${parsed.bad})`)
    const m3 = measure(parsed.ev)
    assert(m3.segments[0].tools === 4 && m2.segments[1].tools === m3.segments[1].tools && m3.segments[2].tools === 0,
      `多帧读回三段读数与内存夹具一致 (got ${m3.segments.map((s) => s.tools).join('/')})`)
    // 负向自测（注入必红）：若读取器退化成「只解第一帧」，事件数只剩 1（header），上行断言即红
    let firstOnlyText = ''
    try { firstOnlyText = zstdDecompressSync(multiBuf).toString('utf-8') } catch { /* 单帧退化路径 */ }
    const firstOnly = parseEventsText(firstOnlyText)
    assert(parsed.ev.length > firstOnly.ev.length, `循环解帧产出 > 单帧产出（只解第一帧必红）(${parsed.ev.length} > ${firstOnly.ev.length})`)

    const single = join(tmp, 'single.zstd')
    writeZstdFrames(single, [[...header, ...rest]])
    assert(countFrames(readFileSync(single)) === 1, `单帧文件帧数===1 (got ${countFrames(readFileSync(single))})`)
    const parsed1 = parseEventsText(zstdRead(single))
    assert(parsed1.ev.length === 1 + rest.length && parsed1.bad === 0, '单帧文件全解一致')

    // 大帧负向夹具（2026-10-25 security R1 P1-1 注入必红；断言鉴别力②）：
    // 旧夹具全为小帧（<16KiB 且未 16KiB 对齐），对「sync 贪读吞帧」零鉴别力——修不修都绿。
    console.log('[4] 大帧夹具（16KiB 对齐贪读 + 尾随帧）与 fail-closed 预算')
    // 4a 贪读阳性对照（L1-14）：flat 16384×2 双帧是矩阵探针实测的必触发形态。
    //    变异体映射：去掉 FCS 截断 → 4a-3 红（贪读输出未截回，总长翻倍）；
    //    本机 Node 若无贪读缺陷 → 4a-4 红明示「对照失败」（覆盖缺失可见，不静默）。
    const flat = Buffer.alloc(16384, 0x61)
    const twoFlat = Buffer.concat([zstdCompressSync(flat, CHECKSUM_OPTS), zstdCompressSync(flat, CHECKSUM_OPTS)])
    const infoFlat = zstdReadInfo(twoFlat)
    assert(infoFlat.frames === 2, `flat 双帧帧数===2 (got ${infoFlat.frames})`)
    assert(infoFlat.dupLines === 0, `flat 双帧零重复行（截断已消除吞并）(got ${infoFlat.dupLines})`)
    assert(infoFlat.text.length === 32768, `修复后总内容===32768（贪读输出被截回单帧精确长度）(got ${infoFlat.text.length})`)
    let greedyRaw = 0
    try { greedyRaw = zstdDecompressSync(twoFlat).length } catch { /* 环境无贪读：greedyRaw 保持 0 */ }
    assert(greedyRaw > 16384, `环境贪读阳性对照：raw sync ${greedyRaw} > 单帧 16384（红＝本机 Node 无贪读缺陷，4a 失去变异体杀伤力，须换触发形态）`)
    // 4b 真实形态：header 帧 + 事件帧 + ≥16KiB 大帧 + 尾随帧 → 全解无重复无丢失（尾帧被吞则必红）
    const bigEvents = Array.from({ length: 400 }, (_, i) => ({ type: 'user/message', seq: 1000 + i, time: 1700000100000 + i * 10, data: { id: `big${i}`, note: 'y'.repeat(48) } }))
    const big = join(tmp, 'big.zstd')
    writeZstdFrames(big, [header, rest.slice(0, 8), bigEvents, rest.slice(8)])
    const parsedBig = parseEventsText(zstdRead(big))
    assert(parsedBig.bad === 0, `大帧文件零坏行 (got ${parsedBig.bad})`)
    assert(parsedBig.ev.length === 1 + rest.length + bigEvents.length,
      `大帧文件全解事件===${1 + rest.length + bigEvents.length}（尾帧被吞则必红）(got ${parsedBig.ev.length})`)
    const infoBig = zstdReadInfo(readFileSync(big))
    assert(infoBig.dupLines === 0, `大帧文件零重复行 (got ${infoBig.dupLines})`)
    // 4c 去重行防护本体（变异体：去掉 dedupLines → 此断言红）
    const dd = dedupLines('a\nb\na\nc\n')
    assert(dd.text === 'a\nb\nc\n' && dd.dupLines === 1, `去重行防护：重复行去除且计数 (got ${JSON.stringify(dd.text)} / ${dd.dupLines})`)
    // 4d 预算 fail-closed（变异体映射：去掉对应上限检查 → 对应断言红）
    let threw = false
    try { zstdReadInfo(twoFlat, { maxTotalBytes: 1024 }) } catch { threw = true }
    assert(threw, '总量预算 fail-closed：maxTotalBytes=1024 必须拒绝')
    threw = false
    try { zstdReadInfo(twoFlat, { maxFrameBytes: 1024 }) } catch { threw = true }
    assert(threw, '单帧预算 fail-closed：maxFrameBytes=1024 必须拒绝')
    threw = false
    try { zstdReadInfo(twoFlat, { maxFrames: 1 }) } catch { threw = true }
    assert(threw, '帧数上限 fail-closed：maxFrames=1 对双帧文件必须拒绝')
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不遮蔽断言结果 */ }
  }

  if (failures) {
    console.error(`SELFTEST FAIL (${failures} 断言失败)`)
    process.exit(1)
  }
  console.log('SELFTEST OK |', textRow(m1), '|', textRow(m2))
  return 0
}

// ---------- --scan / --cases ----------

function iterSessionLogs() {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const ws of readdirSync(root)) {
    const wsPath = join(root, ws)
    let wsSt
    try { wsSt = statSync(wsPath) } catch { continue }
    if (!wsSt.isDirectory()) continue
    for (const sd of readdirSync(wsPath)) {
      const sPath = join(wsPath, sd)
      let sSt
      try { sSt = statSync(sPath) } catch { continue }
      if (!sSt.isDirectory()) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
        const zp = join(sPath, name)
        if (existsSync(zp)) { out.push({ zpath: zp }); break }
      }
    }
  }
  return out.sort((a, b) => (a.zpath < b.zpath ? -1 : 1))
}

function scanAll() {
  const rows = []
  const errors = []
  for (const { zpath } of iterSessionLogs()) {
    try {
      const { ev, bad, isZstd, zstd } = readSessionFile(zpath)
      if (zstd && zstd.dupLines > 0) {
        // 跨帧重复行 = 帧边界吞并痕迹：读数已不可信，静默计入会污染 scan 聚合——fail-closed 拒测
        throw new Error(`跨帧重复行 ${zstd.dupLines} 条（帧边界吞并痕迹）：测量读数不可信，拒绝（fail-closed）`)
      }
      const m = measure(ev)
      const meta = sessionMeta(ev)
      rows.push({ sessionId: meta.id, createdAt: meta.createdAt, isZstd, badLines: bad, ...m, zpath })
    } catch (e) {
      errors.push({ zpath, error: String(e && e.message || e).slice(0, 120) })
    }
  }
  return { rows, errors }
}

function flag(row) {
  const early = row.segments[0].tools
  const late = row.segments[2].tools
  const ratio = early > 0 ? +(late / early).toFixed(3) : null
  const isLong = row.coreEvents >= CASES_MIN_CORE && row.tools >= CASES_MIN_TOOLS
  let kind = 'gray'
  if (isLong && row.tailDangling) kind = 'candidate-dangling' // L1-04 死亡签名（长会话）
  else if (isLong && early >= CASES_MIN_EARLY_TOOLS) {
    if (late === 0) kind = 'candidate-zero' // 骤降归零
    else if (ratio !== null && ratio <= CASES_CLIFF_RATIO) kind = 'candidate-cliff' // 骤降
    else if (ratio !== null && ratio >= CASES_HEALTHY_RATIO && late >= 5) kind = 'healthy'
  }
  return { kind, earlyTools: early, lateTools: late, earlyLateRatio: ratio, isLong, tailDangling: row.tailDangling }
}

function runScan(argv) {
  const get = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt }
  const minCore = Number(get('--min-core', SCAN_DEFAULT_MIN_CORE)) || 0
  const limit = Number(get('--limit', 0)) || 0
  const asJson = argv.includes('--json')
  const verbose = argv.includes('--verbose')
  const t0 = Date.now()
  const { rows, errors } = scanAll()
  const shown = rows.filter((r) => r.coreEvents >= minCore).sort((a, b) => b.coreEvents - a.coreEvents)
  const out = limit > 0 ? shown.slice(0, limit) : shown
  if (asJson) {
    console.log(JSON.stringify({ scanned: rows.length, errors, rows: out }, null, 1))
  } else {
    console.log(`scanned=${rows.length} errors=${errors.length} shown(>=${minCore}core)=${out.length} in ${Date.now() - t0}ms`)
    for (const e of errors) console.error(`ERR ${e.zpath} :: ${e.error}`)
    for (const r of out) {
      const f = flag(r)
      console.log(`${(r.sessionId || '?').padEnd(40)} core=${String(r.coreEvents).padStart(6)} tools=${String(r.tools).padStart(5)} ${textRow(r)} ${f.kind}`)
      if (verbose) console.log(`    ${r.zpath}`)
    }
  }
}

function runCases(argv) {
  const asJson = argv.includes('--json')
  const { rows, errors } = scanAll()
  const pops = rows.map((r) => ({ sessionId: r.sessionId, coreEvents: r.coreEvents, tools: r.tools, spanMin: r.spanMin, lastToolRatio: r.lastToolRatio, firstEventAt: r.firstEventAt, lastEventAt: r.lastEventAt, ...flag(r) }))
  const population = pops.filter((p) => p.isLong)
  const candidates = population.filter((p) => p.kind.startsWith('candidate'))
    .sort((a, b) => (a.kind === 'candidate-dangling' ? 0 : 1) - (b.kind === 'candidate-dangling' ? 0 : 1) || (a.earlyLateRatio ?? -1) - (b.earlyLateRatio ?? -1) || b.tools - a.tools)
  const healthy = population.filter((p) => p.kind === 'healthy')
    .sort((a, b) => (b.earlyLateRatio ?? 0) - (a.earlyLateRatio ?? 0))
  const gray = population.filter((p) => p.kind === 'gray').length
  if (asJson) {
    console.log(JSON.stringify({
      rule: { CASES_MIN_CORE, CASES_MIN_TOOLS, CASES_MIN_EARLY_TOOLS, CASES_CLIFF_RATIO, CASES_HEALTHY_RATIO },
      scanned: rows.length, errors, population: population.length, gray,
      candidates, healthy,
    }, null, 1))
  } else {
    console.log(`scanned=${rows.length} errors=${errors.length} 长会话总体=${population.length} 灰区=${gray}`)
    for (const e of errors) console.error(`ERR ${e.zpath} :: ${e.error}`)
    console.log(`\n== 候选（死亡签名/骤降/归零）==`)
    for (const c of candidates) console.log(`${c.kind.padEnd(20)} ${(c.sessionId || '?')} core=${c.coreEvents} tools=${c.tools} early=${c.earlyTools} late=${c.lateTools} ratio=${c.earlyLateRatio} dangling=${c.tailDangling ?? '-'} lastTool@${c.lastToolRatio === null ? '-' : Math.round(c.lastToolRatio * 100) + '%'} span=${c.spanMin}min`)
    console.log(`\n== 健康对照（late/early>=${CASES_HEALTHY_RATIO} 且 late>=5）==`)
    for (const h of healthy.slice(0, 15)) console.log(`${h.sessionId} core=${h.coreEvents} tools=${h.tools} early=${h.earlyTools} late=${h.lateTools} ratio=${h.earlyLateRatio} lastTool@${h.lastToolRatio === null ? '-' : Math.round(h.lastToolRatio * 100) + '%'} span=${h.spanMin}min`)
    console.log('\n注：本输出只列候选与对照的测量读数，不做死亡/摆烂方向判定（AC-M5-3 判定留待用户确认案例结局）。')
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--selftest') { selftest(); return }
  if (argv[0] === '--scan') { runScan(argv.slice(1)); return }
  if (argv[0] === '--cases') { runCases(argv.slice(1)); return }
  if (argv[0]) {
    let parsed
    try { parsed = readSessionFile(argv[0]) } catch (e) {
      console.error(`[measure-decay] ${e && e.message || e}`)
      process.exitCode = 1
      return
    }
    const { ev, bad, isZstd, zstd } = parsed
    if (zstd && zstd.dupLines > 0) {
      console.error(`[measure-decay] 跨帧重复行 ${zstd.dupLines} 条（帧边界吞并痕迹）：测量读数不可信，拒绝（fail-closed）`)
      process.exitCode = 1
      return
    }
    const m = measure(ev)
    if (bad) console.error(`note: ${bad} 非 JSON 行被跳过 (zstd=${isZstd})`)
    console.log(argv.includes('--json') ? JSON.stringify({ ...sessionMeta(ev), isZstd, badLines: bad, ...m }, null, 1) : textRow(m))
    return
  }
  console.error('用法: node tools/measure-decay.mjs <file> [--json] | --selftest | --scan | --cases')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
