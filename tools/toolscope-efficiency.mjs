#!/usr/bin/env node
/**
 * V3-3 收缩生效率读数组消费器（R3-B1 S5）：把 restrict 管道的审计读数组变成
 * 三个生效率读数——对账通过率 / 实际收缩占比 / fail-open 原因分布（缺失清单聚合）。
 * 阈值（设计 V3-3）：对账生效率 <50% 触发表修复轮，不带病进消融实验。
 *
 * 两种输入（同一消费核）：
 *   1. `efficiencyReadings(entries)` 纯函数——直接吃 installToolscopePipeline(...).audit()
 *      的内存环快照（{sessionId, action, reason?, missing?}）。
 *   2. `replayEntries({dataDir, roster})` 离线重放——读 <dataDir>/sessions/*.toolscope.json
 *      持久策略文件，用与管线**同一决策核**（decideToolscope）重放每会话决策，产出同构
 *      entries 再进消费核。宿主未重启/进程内存环已清时，这是唯一可复跑的读数来源。
 *
 * 口径（如实声明）：
 *   - 对账分母 = 决策真正走到交叉校验/预校验闸的会话（allow/deny/refuse + skip 中
 *     reason='nothing-to-strip'——闸跑过且通过，只是无可收）；tier='none' 等未进闸的
 *     skip 不进分母（fail-open 非对账失败）。
 *   - 收缩占比分母 = 有策略文件（策略承载）的会话总数；分子 = 实际调用了 restrict 的
 *     会话（allow/deny）。
 *   - 重放宇宙 = classMap ∪ coreBase（构建期扫描同宇宙）；运行期真宇宙是该会话的
 *     restrictableNames，离线不可得——重放读数是「管线将会做什么」的近似，报告须带
 *     此口径标注。
 *
 * 用法：
 *   node tools/toolscope-efficiency.mjs [--dataDir <dir>] [--out <json 路径>]
 *   缺省 dataDir = resolveAdvisorDataDir 链（配置 > DSH_AGENTS_ADVISOR_DATA_DIR >
 *   ~/.dsh/plugins-data/dsh-agents/advisor）；--out 缺省只打印不落盘。
 *   零样本 = exit 0 + verdict 'no-sample'（如实无样本，不伪装读数）。
 *
 * @module dsh-agents/toolscope-efficiency
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRosterData, POLICY_DIR } from '../lib/toolscope-roster.js'
import { decideToolscope } from '../lib/toolscope-pipeline.js'
import { getRole } from '../lib/roles.js'
import { loadPersona } from '../lib/persona.js'
import { resolveAdvisorDataDir } from '../lib/advisor/index.js'

/** 生效率阈值（设计 V3-3：<50% 触发表修复轮）。 */
export const EFFICIENCY_THRESHOLD = 0.5

/**
 * 生效率读数组消费核（纯函数）：三值 = 对账通过率 / 实际收缩占比 / fail-open 原因分布。
 * @param {Array<{sessionId: string, action: string, reason?: string|null, missing?: string[]}>} entries
 *   管线 audit() 快照或 replayEntries 产物（同构形状）。
 * @returns {object} readings（shape 见下；empty=true 表示零输入）
 */
export function efficiencyReadings(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object' && typeof e.action === 'string') : []
  if (list.length === 0) {
    return { empty: true, sessions: 0, verdict: 'no-sample', note: '零输入：无策略承载会话（宿主未重启/新装/内存环已清且无可重放文件）' }
  }
  const sessions = new Set(list.map((e) => e.sessionId)).size
  /** 对账闸分母：allow/deny/refuse + nothing-to-strip（闸跑过且通过）。 */
  const GATE_ACTIONS = new Set(['allow', 'deny', 'refuse'])
  let gateDenominator = 0
  let gatePassed = 0
  let applied = 0
  const byReason = {}
  const missingAgg = {}
  for (const e of list) {
    if (e.action === 'allow' || e.action === 'deny') {
      gateDenominator += 1
      gatePassed += 1
      applied += 1
      continue
    }
    if (e.action === 'refuse') {
      gateDenominator += 1
      byReason[e.reason ?? 'unknown'] = (byReason[e.reason ?? 'unknown'] ?? 0) + 1
      for (const name of e.missing ?? []) missingAgg[name] = (missingAgg[name] ?? 0) + 1
      continue
    }
    if (e.action === 'skip') {
      byReason[e.reason ?? 'unknown'] = (byReason[e.reason ?? 'unknown'] ?? 0) + 1
      if (e.reason === 'nothing-to-strip') {
        gateDenominator += 1 // 闸跑过且通过（无可收不算失败）
        gatePassed += 1
      }
    }
  }
  const gatePassRate = gateDenominator > 0 ? gatePassed / gateDenominator : null
  const shrinkRatio = sessions > 0 ? applied / sessions : null
  const verdict = gateDenominator === 0
    ? 'no-gate-samples'
    : (gatePassRate < EFFICIENCY_THRESHOLD ? 'efficiency-low-repair-round' : 'efficiency-ok')
  return {
    empty: false,
    sessions,
    applied,
    gate: { denominator: gateDenominator, passed: gatePassed, passRate: gatePassRate, threshold: EFFICIENCY_THRESHOLD },
    shrink: { ratio: shrinkRatio },
    failOpen: { byReason, missingAgg },
    verdict,
  }
}

/**
 * 离线重放：把 <dataDir>/sessions/*.toolscope.json 喂进与管线同一决策核，产出同构
 * entries（供 efficiencyReadings 消费）。roster 传 loadRosterData(...).roster。
 * @param {{dataDir?: string, roster?: object|null}} input
 * @returns {{entries: Array<object>, files: number, parseErrors: string[]}}
 */
export function replayEntries({ dataDir, roster } = {}) {
  const dir = join(String(dataDir ?? resolveAdvisorDataDir(null)), 'sessions')
  const entries = []
  const parseErrors = []
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.toolscope.json'))
  } catch {
    return { entries, files: 0, parseErrors: [`sessions 目录不可读：${dir}`] }
  }
  const universe = new Set([
    ...Object.values(roster?.classMap ?? {}).flat(),
    ...(roster?.coreBase ?? []),
  ])
  for (const f of files) {
    let policy
    try {
      policy = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch (error) {
      parseErrors.push(`${f}: ${error?.message ?? error}`)
      continue
    }
    let personaText = ''
    if (policy?.role) {
      try {
        const role = getRole(policy.role)
        personaText = role ? loadPersona(role).text : ''
      } catch { /* 与管线 resolvePersonaText 同款兜底：取不到按空串 */ }
    }
    let decision
    try {
      decision = decideToolscope({
        policy,
        roster: roster ?? null,
        restrictable: universe,
        personaText,
        taskText: policy?.task ?? '',
      })
    } catch (error) {
      entries.push({ sessionId: policy?.sessionId ?? f, action: 'skip', reason: 'replay-decide-threw', missing: [], detail: String(error?.message ?? error) })
      continue
    }
    entries.push({ sessionId: policy?.sessionId ?? f, action: decision.action, reason: decision.reason ?? null, missing: decision.missing ?? [] })
  }
  return { entries, files: files.length, parseErrors }
}

function main() {
  const argv = process.argv.slice(2)
  const argOf = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const dataDir = argOf('--dataDir') ?? resolveAdvisorDataDir(null)
  const outPath = argOf('--out')
  const { roster, error } = loadRosterData(POLICY_DIR)
  if (error) console.error(`[toolscope-efficiency] roster 数据告警（fail-open 继续）：${error}`)
  const { entries, files, parseErrors } = replayEntries({ dataDir, roster })
  const readings = efficiencyReadings(entries)
  const result = {
    meta: {
      script: 'tools/toolscope-efficiency.mjs',
      caliber: 'replay（离线重放同一决策核；宇宙=classMap∪coreBase，非运行期 restrictableNames）',
      dataDir,
      policyFiles: files,
      parseErrors,
      threshold: EFFICIENCY_THRESHOLD,
      generatedAt: new Date().toISOString(),
    },
    readings,
  }
  const text = JSON.stringify(result, null, 2)
  console.log(text)
  if (outPath) {
    writeFileSync(outPath, `${text}\n`, 'utf8')
    console.error(`[toolscope-efficiency] 读数已落盘：${outPath}`)
  }
  if (parseErrors.length > 0) console.error(`[toolscope-efficiency] ${parseErrors.length} 个策略文件解析失败（已跳过并列出）`)
}

if (process.argv[1] && process.argv[1].endsWith('toolscope-efficiency.mjs')) main()
