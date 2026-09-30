/**
 * persona-gate.js — persona 装配期判据（批次3 IMP-26c；闸门 tools/install-personas.mjs
 * 与负向自测 tools/verify-imp26.mjs 共用同一份代码）。
 *
 * 两级判据（D-5 流程防线，对照 ECC 上游 67/68 角色自带 Prompt Defense Baseline 的事实）：
 *   ① 注入基线节（Prompt Defense Baseline）——LEGACY_OMC_IDS 之外的角色缺失即 error
 *     （19 个 OMC 历史角色豁免：上游无此节是历史形态，非本次移植引入的缺口）；
 *   ② 「## 不做什么」节缺失 → warn（提示性，不阻断）。
 *
 * 基线双形态判据：
 *   - 标题形态：行首 `## Prompt Defense Baseline`（ECC 原版形态）；
 *   - 标签形态：`<Prompt_Defense_Baseline>...</Prompt_Defense_Baseline>`（批次3 staging
 *     移植角色形态）——**空 tag 对（仅空白）按 stub 拒收**。
 */

/** 19 个 OMC 历史角色 id 豁免表（fail-closed 的白名单语义：仅表内 id 免基线判据）。 */
export const LEGACY_OMC_IDS = new Set([
  'analyst',
  'architect',
  'code-reviewer',
  'code-simplifier',
  'critic',
  'debugger',
  'designer',
  'document-specialist',
  'executor',
  'explore',
  'git-master',
  'planner',
  'qa-tester',
  'scientist',
  'security-reviewer',
  'test-engineer',
  'tracer',
  'verifier',
  'writer',
])

const BASELINE_HEADING_RE = /^## Prompt Defense Baseline[ \t]*\r?$/m
const BASELINE_TAG_RE = /<Prompt_Defense_Baseline>([\s\S]*?)<\/Prompt_Defense_Baseline>/
const NO_DO_RE = /^## 不做什么/m

/** 标题形态或标签形态任一命中即有基线；空标签对（stub）不算。 */
export function hasPromptDefenseBaseline(body) {
  const text = String(body ?? '')
  if (BASELINE_HEADING_RE.test(text)) return true
  const m = BASELINE_TAG_RE.exec(text)
  return m !== null && m[1].trim() !== ''
}

/** 「## 不做什么」节（行首出现即算，正文缩进形态不认）。 */
export function hasNoDoSection(body) {
  return NO_DO_RE.test(String(body ?? ''))
}

/**
 * 装配期 findings（纯函数，无副作用）。
 * @returns {Array<{level:'error'|'warn', code:string, message:string}>}
 *   - 非 LEGACY_OMC_IDS 角色缺注入基线 → { level:'error', code:'baseline-missing' }
 *   - 缺「## 不做什么」节 → { level:'warn', code:'no-do-missing' }（恰一条，message 固定）
 */
export function personaGateFindings(id, body) {
  const findings = []
  if (!LEGACY_OMC_IDS.has(id) && !hasPromptDefenseBaseline(body)) {
    findings.push({ level: 'error', code: 'baseline-missing', message: '缺注入基线（Prompt Defense Baseline）' })
  }
  if (!hasNoDoSection(body)) {
    findings.push({ level: 'warn', code: 'no-do-missing', message: '缺「## 不做什么」节' })
  }
  return findings
}
