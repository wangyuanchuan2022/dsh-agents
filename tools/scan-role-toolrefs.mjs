#!/usr/bin/env node
/**
 * toolscope 构建期角色引用扫描（R3-B1 S3 ⑤，设计 §2.2「构建期
 * tools/scan-role-toolrefs.mjs 扫 23 角色人格＋任务书模板静态面」）：
 *
 *   1. 对 23 个角色跑扫描核（lib/toolscope-roster.js scanRoleReferences——
 *      与 run.mjs 漂移门同一实现，杜绝两套口径）；
 *   2. 产出 policies/toolscope-roles.json（per-role 表，入库数据）；
 *   3. 产出 G11 per-role 覆盖率报告 → agent-out/toolscope-g11-coverage.md
 *      （agent-out 为 gitignored 证据区，报告同时走 stdout 摘要行）。
 *
 * 漂移同步（OQ#6 落点裁决=独立脚本＋run.mjs 漂移门）：人格/任务书模板变更后
 * 重跑本脚本；忘记重跑时 run.mjs 的 deep-equal 漂移门先红。
 *
 * 退出码：0=成功写入；非 0=基表损坏/扫描核抛错（fail-closed 响亮失败，不静默）。
 *
 * @module dsh-agents/scan-role-toolrefs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ROLES } from '../lib/roles.js'
import { loadRosterData, buildCoverageReport, scanRoleReferences, POLICY_DIR, ROSTER_ROLES_FILE } from '../lib/toolscope-roster.js'

const data = loadRosterData(POLICY_DIR)
if (!data.base) {
  console.error(`[scan-role-toolrefs] 基表损坏，fail-closed：${data.error ?? '未知'}`)
  process.exit(2)
}
const base = data.base

const roleTable = {}
const allUnclassified = []
for (const role of ROLES) {
  const { rostered, unclassified } = scanRoleReferences(role, base)
  roleTable[role.id] = rostered
  for (const name of unclassified) allUnclassified.push(`${role.id}:${name}`)
}

const generatedAt = new Date().toISOString()
const payload = {
  generatedAt,
  generator: 'tools/scan-role-toolrefs.mjs',
  rosterVersion: base.version,
  scanFace: 'persona + taskbook §七(reportLines/fewShotLines) + readonly-whitelist; detector=loose(negation-aware) - scanIgnore',
  roles: roleTable,
}
mkdirSync(POLICY_DIR, { recursive: true })
const rolesPath = join(POLICY_DIR, ROSTER_ROLES_FILE)
writeFileSync(rolesPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

const report = buildCoverageReport({ roles: ROLES, base, roleTable, generatedAt })
const reportPath = fileURLToPath(new URL('../agent-out/toolscope-g11-coverage.md', import.meta.url))
writeFileSync(reportPath, `${report.lines.join('\n')}\n`, 'utf8')

console.log(`[scan-role-toolrefs] roles=${Object.keys(roleTable).length}/${ROLES.length} refs=${Object.values(roleTable).reduce((n, list) => n + list.length, 0)} unclassified=${allUnclassified.length}`)
if (report.missingRoles.length > 0) console.log(`[scan-role-toolrefs] 未入库角色（fail-open）：${report.missingRoles.join(', ')}`)
if (allUnclassified.length > 0) console.log(`[scan-role-toolrefs] 未归类反引号（披露待增补）：${allUnclassified.join(', ')}`)
console.log(`[scan-role-toolrefs] 写出 ${rolesPath}`)
console.log(`[scan-role-toolrefs] G11 报告 ${reportPath}`)
process.exit(0)
