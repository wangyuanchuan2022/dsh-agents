#!/usr/bin/env node
/**
 * tools/constraint-mutation-verify.mjs —— B5 X-3：PARTIAL 闸门「违反即变红」逐条变异实测。
 *
 * ## 为什么要这个工具（B5 审计自认的最大未做项）
 *
 * `docs/constraint-audit.md` 把 44 条纪律标为 PARTIAL（有闸门但只覆盖一部分）。
 * 已机检的是「闸门文件存在 + 断言标识可寻」（`tools/constraint-audit.mjs` 的 G2），
 * 但**没证明「违反该条款时闸门真的会红」** —— 一个只断言「文本里出现过某句话」的
 * 闸门，在代码把该行为破坏时可能纹丝不动。本工具补这一环：对每条被验证的条款，
 * 构造一个**单变量变异**（破坏该条款要求的行为），跑主套件，断言「必须红」，
 * 然后按内存原字节还原并用 SHA256 校验还原保真。
 *
 * ## 与「为了测试而改测试」的边界
 *
 * 本工具**不修改任何测试断言**，只临时改**产品代码**（`lib/`）制造违规，
 * 跑完立即按原字节还原。它是负向自测（mutation test），不是放宽断言。
 *
 * ## 用法
 *
 *   node tools/constraint-mutation-verify.mjs              # 跑全部已登记变异
 *   node tools/constraint-mutation-verify.mjs --list       # 只列登记表
 *   node tools/constraint-mutation-verify.mjs --only C-013 # 只跑一条
 *   node tools/constraint-mutation-verify.mjs --selftest   # 框架自检（必红/必绿对照）
 *
 * 退出码：0 = 全部达到期望；1 = 有变异未达期望（= 该条款的闸门没有鉴别力，是真实缺口）；
 *         2 = 用法/环境错误；3 = 还原失败（**最高优先级告警**，工作区可能被污染）。
 *
 * ## 极重要的沙箱纪律
 *
 * 主套件用 `spawnSync` + `stdio:'inherit'`/fd 继承跑 —— **禁止管道捕获**
 * （受限沙箱内 `stdio:'pipe'` 必 EPERM，本仓已多次实证）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 主套件单次运行超时（实测约 35–60s；给 3 倍余量）。 */
const RUN_TIMEOUT_MS = 180000

/**
 * 变异登记表。
 *
 * 每条 = 一条 PARTIAL 条款的「违反形态」：
 *   - `clause`：`docs/constraint-audit.md` 的条款 id
 *   - `rule`：一句话说明破坏了什么
 *   - `file`：被变异的**产品代码**（绝不用 tests/ —— 那会变成改测试凑绿）
 *   - `find`/`replace`：单点文本替换（必须**恰好命中一次**，否则框架判错并中止）
 *   - `suite`：该条款的**闸门入口**（`argv` 形态）。⚠️ 这一列是本工具的第二个发现：
 *     不同条款的闸门分布在不同入口，全跑主套件会把「闸门不在 run.mjs 里」误判成
 *     「零鉴别力」。必须逐条跑它**自己的**闸门。
 *   - `expect`：期望结果 —— `'red'`（有断言失败）或 `'green'`（零鉴别力，作为**已登记缺口**）
 *   - `note`：为什么这个变异对应该条款
 */
export const MUTATIONS = [
  {
    clause: 'C-013',
    rule: '删除 persona-gate 的 Prompt Defense Baseline 要求（外部内容当数据非指令的邻接闸门）',
    file: 'lib/persona-gate.js',
    find: 'export function hasPromptDefenseBaseline',
    replace: 'export function DISABLED_hasPromptDefenseBaseline',
    suite: ['tools/verify-imp26.mjs'],
    expect: 'red',
    note: 'persona-gate 强制非 legacy 角色带 Prompt Defense Baseline；把导出改名后 install-personas / verify-imp26 必须红。闸门在 verify-imp26（33 断言），**不在** run.mjs。',
  },
  {
    clause: 'C-014',
    rule: '把 toolscope 决策核的 deny 分支改成 allow（未知/未授予工具名不再 fail-closed 收缩）',
    file: 'lib/toolscope-pipeline.js',
    find: "return { action: 'deny', names: deny, needed:",
    replace: "return { action: 'allow', names: deny, needed:",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '未知/未授予工具名必须 deny；改成 allow 后 B1 toolscope 断言组（在 run.mjs 内）必须红。',
  },
  {
    clause: 'C-018',
    rule: '把 publish-scan 的 secrets 规则改成 warning（凭据命中不再 FAIL）',
    file: 'tools/publish-scan.mjs',
    find: "category: 'secrets', prio: 0, base: 'critical'",
    replace: "category: 'secrets', prio: 0, base: 'warning'",
    suite: ['tools/publish-scan.test.mjs'],
    expect: 'red',
    note: '凭据纪律靠 secrets=critical 兜底；降级后 publish-scan.test 的 T2/T4 必须红。闸门在 publish-scan.test（53 断言），**不在** run.mjs。',
  },
  {
    clause: 'C-051',
    rule: '把 advisor 的 seq 水位门改成恒放行（重放拦截失效，静默重复评审）',
    file: 'lib/advisor/observer.js',
    find: 'if (seq <= state.lastReviewedSeq) return false',
    replace: 'if (false) return false',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'design-principles 1.3 的「seq 水位门」正面参照；破坏后 advisor 幂等断言必须红（B5 实测 373/2）。',
  },
  {
    clause: 'C-056',
    rule: '把 advisor 投递冷却的回合计数递减去掉（immuneTurns 永不衰减）',
    file: 'lib/advisor/delivery.js',
    find: 'else this.cooldown.set(sessionId, remaining - 1)',
    replace: 'else this.cooldown.set(sessionId, remaining)',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'design-principles 1.3 的「回合计数冷却」正面参照（B5 实测 374/1）。',
  },
  {
    clause: 'C-064',
    rule: '删掉任务书「报告落盘」硬条款（review 泳道交付纪律）',
    file: 'lib/taskbook.js',
    find: "- 报告落盘：write 写入任务书指定路径（评审类只读，禁止改动被评审对象）。",
    replace: "- （本行已删除）",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '**缺口已补（2026-10-29）**：新增「泳道交付条款必须逐字在场」值断言后，删整行必红（原为主套件 375/0 零鉴别力）。',
  },
  {
    clause: 'C-107',
    rule: '把 advisor store 的 lastReviewedSeq 哨兵从 -1 改成 0（重启后首条 seq=0 事件静默漏评）',
    file: 'lib/advisor/store.js',
    find: 'lastReviewedSeq: -1 }',
    replace: 'lastReviewedSeq: 0 }',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '**缺口已补（2026-10-29）**：新增「全新会话 lastReviewedSeq 必须 -1」值断言后，-1→0 必红（原为主套件 375/0 零鉴别力）。',
  },
  // ── B5 X-3 续做（2026-10-29）：剩余 37 条 PARTIAL ───────────────────────────
  // 口径同前 7 条：单点变异产品代码 → 跑该条款**自己的**闸门入口 → 断言必须红；
  // 实测绿了的如实改 `expect: 'green'` 并在 note 写明建议补什么断言。
  {
    clause: 'C-070',
    rule: '删掉任务书 build 泳道「产出落盘」条文里的「不要只在聊天里输出」（只聊天不算完成的口子被打开）',
    file: 'lib/taskbook.js',
    find: '（未指定见缺省决策表），**不要只在聊天里输出**。',
    replace: '（未指定见缺省决策表）。',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「报告/产出必须 write 落盘、只输出聊天不算完成」的生成面条文；去掉该句后，run.mjs 的泳道逐字值断言（C-064 补的那条）必须红——证明这条交付硬条款现已进入看管。',
  },
  {
    clause: 'C-071',
    rule: '完成广播条款去掉（wake:true）（组织者 idle 时收不到完成广播，回收被拖长）',
    file: 'lib/taskbook.js',
    find: '（wake:true）→ 组织者',
    replace: ' → 组织者',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'IMP-26a ①「完成广播必须带（wake:true）」；去掉后任务书广播行不再带该标记，run.mjs 的广播条款断言必须红。',
  },
  {
    clause: 'C-072',
    rule: 'review 泳道三段式去掉「文件:行号」锚点（发现不再要求可核验定位）',
    file: 'lib/taskbook.js',
    find: '三段式：`文件:行号` +',
    replace: '三段式：',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「每个发现必须带 文件:行号 证据」的生成面；P0/P1/P2 仍在场（故与 C-073 的口不同），去掉锚点后泳道逐字值断言必须红。',
  },
  {
    clause: 'C-078',
    rule: '把「执行者自报 DONE 无效」改成「有效」（DONE 只有组织者/用户能给的三值边界被打开）',
    file: 'lib/taskbook.js',
    find: '——执行者自报 DONE 无效',
    replace: '——执行者自报 DONE 有效',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '交付状态三值字段的第三值边界；改口后 run.mjs §5.1 的「执行者自报 DONE 无效」断言必须红。',
  },
  {
    clause: 'C-083',
    rule: '把硬性完成标准的「双条件，缺一即未完成」改成「单条件即可」（核销双条件被降级为单条件）',
    file: 'lib/taskbook.js',
    find: '（**双条件，缺一即未完成**）',
    replace: '（**单条件即可**）',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「完成核销单：产出已落盘 + 已广播，缺一不核销」的任务书面；改口后 run.mjs 的「双条件，缺一即未完成」断言必须红。',
  },
  {
    clause: 'C-003',
    rule: '删掉 build 泳道「证据：每条结论附可核验依据（文件:行号 / 命令+原始输出）」整条（事实/证据分离的交付面失守）',
    file: 'lib/taskbook.js',
    find: '- 证据：每条结论附可核验依据（文件:行号 / 命令+原始输出）。',
    replace: '- （证据要求已删除）',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「区分事实与猜测」在任务书面要求每条结论附可核验依据；删行后 run.mjs:263 的「证据」在场断言 + C-064 泳道逐字值断言双双变红。注意审计正本称本条闸门只查「证据」二字——C-064 补口后已升级为逐字值断言。',
  },
  {
    clause: 'C-004',
    rule: '删掉 review 泳道三段式里的【改进点】（批评不带替代方案即可交付）',
    file: 'lib/taskbook.js',
    find: '+ 【改进点】（映射到具体文件/动作）。',
    replace: '。',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「批评必须带替代方案」=任务书要求每发现附【改进点】。审计正本称「【改进点】无断言」——实测该断言已由 C-064 的泳道逐字值断言（run.mjs:281）覆盖，删掉即红。',
  },
  {
    clause: 'C-010',
    rule: '把 DedupNotifier 的去重判定改成恒放行（同类别键重复广播，告警噪音回归）',
    file: 'lib/toolscope-pipeline.js',
    find: 'if (prev !== undefined && rank <= prev) return false',
    replace: 'if (false) return false',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「告警按类别键去重」前半条（同键只发一次 + 严重度升级可重发）由 run.mjs 的 G9 去重用例看管；恒放行后「同键去重（不重复广播）」必红。⚠️ 后半条「环路判定取满 5 次缓冲」本仓无实现，故无法用变异验证（见报告「无法施加」清单）。',
  },
  {
    clause: 'C-021',
    rule: '让 settings 命名空间在宿主 settings 服务可用时不注册（「模块能 import」不再等于「宿主已接线」）',
    file: 'lib/settings.js',
    find: '        scope = settings.register(SETTINGS_NS, TIERS_SCHEMA, { base: { tiers: baseTiers } })',
    replace: '        scope = null',
    suite: ['tests/installed-smoke.mjs'],
    expect: 'red',
    note: 'C-021 的闸门是装机副烟测（从 profile node_modules 真实路径 import + 断言 settings 注册/端点可用）。本机该门可跑（本仓 profile 是 junction 指向工作区），故不标 unverifiable；不注册后 installed-smoke 打印「[FAIL] settings 未注册」exit 1。该脚本仍未进 npm test（审计正本 §7 D-1 的缺口仍在）。',
  },
  {
    clause: 'C-022',
    rule: '删掉 agent_spawn 工具注册（真实 apply 路径 boot 后工具不齐）',
    file: 'lib/index.js',
    find: "ctx.effect(() => ctx.tools.register(spawnTool(ctx, config, spawner, requesterOf, tiersApi, toolscopeStore, { decisionAudit: spawnDecisionAudit })), 'dsh-agents: agent_spawn tool')",
    replace: 'void 0',
    suite: ['tests/boot-schema-check.mjs'],
    expect: 'red',
    note: '「修复后必须走宿主真实启动路径验证闭环（或至少干跑 compose/boot 检查）」的闸门 = boot-schema-check 走真实 apply 入口断言三工具注册齐全；删注册后其「三个工具全部注册」检查必红。',
  },
  {
    clause: 'C-052',
    rule: '把投递冷却判定改成恒不冷却（墙钟阈值无法替代的事件计数窗口被拆掉）',
    file: 'lib/advisor/delivery.js',
    find: 'const cooling = (this.cooldown.get(sessionId) ?? 0) > 0',
    replace: 'const cooling = false',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「节流窗口用事件计数表达」的正面参照：冷却窗口内 nit 必须降级 inject；恒不冷却后 advisor.test 的「冷却窗口内 nit 降级 inject」必红（该用例经 run.mjs 聚合执行）。⚠️ 反向禁止（禁用墙钟节流）仍无闸门扫描。',
  },
  {
    clause: 'C-063',
    rule: '删掉隔离契约的「会话层：本会话是全新会话」声明（会话层隔离只剩口头约定）',
    file: 'lib/taskbook.js',
    find: '- 会话层：本会话是**全新会话**，不继承派活方的对话历史',
    replace: '- 会话层：不继承派活方的对话历史',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「会话层隔离：每席全新 DSH 会话」的任务书面；去掉「全新会话」后 run.mjs:651 的 blind.includes(\'全新会话\') 必红。⚠️ 机制层（lib/spawn.js 每席新会话）仍无独立闸门。',
  },
  {
    clause: 'C-065',
    rule: '把 blind 的隔离模式标签改成别的措辞（blind（并行盲评席）标记消失）',
    file: 'lib/taskbook.js',
    find: "'blind（并行盲评席）'",
    replace: "'并行评审席'",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'blind 席定义的渲染锚点；改标签后 run.mjs:649 的 **blind（并行盲评席）** 断言必红。⚠️ 「两席任务书除角色外逐字一致」仍无闸门。',
  },
  {
    clause: 'C-066',
    rule: '把 isolated 的隔离模式标签改成别的措辞（isolated（独立评审/验证席）标记消失）',
    file: 'lib/taskbook.js',
    find: "'isolated（独立评审/验证席）'",
    replace: "'独立评审席'",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'isolated 席定义的渲染锚点；改标签后 run.mjs:656 的 **isolated（独立评审/验证席）** 断言必红。',
  },
  {
    clause: 'C-067',
    rule: '把 executor 误列入 isolated 名单（shared 席被当成隔离席，其余 shared 席语义被破坏）',
    file: 'lib/roles.js',
    find: "export const ISOLATED_ROLES = ['critic', 'code-simplifier', 'verifier']",
    replace: "export const ISOLATED_ROLES = ['critic', 'code-simplifier', 'verifier', 'executor']",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「其余 shared 实现/协作类角色不做隔离」的名单；把 executor 塞进 isolated 后 run.mjs:628 的 isolated 三席 deepEqual 与 :635 的 shared 归属断言必红。注意审计正本称「其余 14 个总数无断言」——实测已由 run.mjs:629 的 shared==17 值断言覆盖。',
  },
  {
    clause: 'C-073',
    rule: '删掉 review 泳道的「分级（P0/P1/P2）」要求（发现不再要求分级）',
    file: 'lib/taskbook.js',
    find: '+ 分级（P0/P1/P2）',
    replace: '+ 分级',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「发现按 P0/P1/P2 分级」的任务书面；删掉后 run.mjs:262 的 P0/P1/P2 在场断言与 C-064 逐字值断言必红。',
  },
  {
    clause: 'C-076',
    rule: '把可自报状态 DELIVERED_WITH_EVIDENCE 改写成 DELIVERED（三值字段第一值失名）',
    file: 'lib/taskbook.js',
    find: '只能自报 `DELIVERED_WITH_EVIDENCE`（已落盘+已广播）',
    replace: '只能自报 `DELIVERED`（已落盘+已广播）',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '交付状态三值之一；改名后 run.mjs:358 的 DELIVERED_WITH_EVIDENCE 断言必红。⚠️ 「自报值与实际是否相符」仍无闸门（见 C-078/C-083 同族）。',
  },
  {
    clause: 'C-077',
    rule: '把 BLOCKED_NEED_HUMAN 状态名从任务书抹掉（卡点状态不可自报）',
    file: 'lib/taskbook.js',
    find: '`BLOCKED_NEED_HUMAN`（卡点需人介入）；`DONE`',
    replace: '`BLOCKED`（卡点需人介入）；`DONE`',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '交付状态三值之二；改名后 run.mjs:359 的 BLOCKED_NEED_HUMAN 断言必红。',
  },
  {
    clause: 'C-079',
    rule: '把「attempt 级」这一层失败分类名改掉（三层失败分类第一层失名）',
    file: 'lib/taskbook.js',
    find: 'attempt 级=单次调用失败（连续 3 次按三档熔断）',
    replace: '单次失败级=单次调用失败（连续 3 次按三档熔断）',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '三层失败分类的 attempt 层标记；改层名后 run.mjs:504 的 marker 断言必红。⚠️ 本变异只证明「层名在场」被看管；「重试计数 +1 / 连败 3 次熔断」的运行期行为本仓无实现、无观测面（审计正本已注明）。',
  },
  {
    clause: 'C-080',
    rule: '把 item 级的跳过格式从 skipped(封闭枚举理由)+复跑命令 收窄成 skipped+复跑命令（理由封闭枚举失守）',
    file: 'lib/taskbook.js',
    find: '`skipped(封闭枚举理由)+复跑命令`',
    replace: '`skipped+复跑命令`',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'item 级处置格式；去掉「封闭枚举理由」后 run.mjs:504 的该 marker 断言必红。⚠️ 「理由必须落在封闭枚举内」的校验只在 crgate 自己的账上（crgate.test.mjs:134-136），不覆盖任务书报告。',
  },
  {
    clause: 'C-081',
    rule: '把 run 级的 run_failure=<类目> 标记改写成 RF=<类目>（整场停摆申报标记失名）',
    file: 'lib/taskbook.js',
    find: 'run 级=整场停摆（`run_failure=<类目>`',
    replace: 'run 级=整场停摆（`RF=<类目>`',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: 'run 级处置格式；去掉 run_failure= 后 run.mjs:504 的 marker 断言必红。⚠️ 「类目必须来自封闭枚举」仍无校验（同 C-080）。',
  },
  {
    clause: 'C-084',
    rule: '把退出码 5 的处置语义「不判死不重派」改成「超时重派」（依赖阻塞被误当可重派）',
    file: 'lib/taskbook.js',
    find: '| 5 | 依赖阻塞 | 挂待办，**不判死不重派** |',
    replace: '| 5 | 依赖阻塞 | 挂待办，**超时重派** |',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「超时未回收按退出码 2/4/5 处置」的退码表语义；改语义后 run.mjs:402 对退出码 5 的行内语义断言必红。⚠️ 「处置动作是否真按码执行」仍无闸门。',
  },
  {
    clause: 'C-089',
    rule: '把回合上界从 3 轮放宽到 5 轮（同一步骤无增量往返的上界失守）',
    file: 'lib/taskbook.js',
    find: '**最多 3 轮无新落盘增量的往返**',
    replace: '**最多 5 轮无新落盘增量的往返**',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「回合上界：最多 3 轮无新落盘增量的往返」；改成 5 轮后 run.mjs:397 的逐字断言必红。⚠️ 「运行时是否真的在 3 轮收尾」仍无观测。',
  },
  {
    clause: 'C-090',
    rule: '把增量指引改成允许重做已确认部分（收到唤醒后重做已确认部分）',
    file: 'lib/taskbook.js',
    find: '**不重做已确认的部分**',
    replace: '**可以重做已确认的部分**',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「只处理增量、不重做已确认部分」；语义反转后 run.mjs:399 的逐字断言必红。',
  },
  {
    clause: 'C-091',
    rule: '把三档熔断的第 2 档反馈改成「继续重试」（连败反馈不再变形态）',
    file: 'lib/taskbook.js',
    find: '原错误（可重试）→ 2 「这是第二次连续失败，修参数或交付」',
    replace: '原错误（可重试）→ 2 「继续重试」',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「三档熔断：连败反馈必须改变形态」的第 2 档语义；改写后 run.mjs:508 的「这是第二次连续失败，修参数或交付」断言必红。',
  },
  {
    clause: 'C-092',
    rule: '把收尾宽限轮短语从「最后一轮只能交付」改成「最后一轮只可提交」（宽限轮语义软化）',
    file: 'lib/taskbook.js',
    find: "const PHRASE_LAST_ROUND = '最后一轮只能交付'",
    replace: "const PHRASE_LAST_ROUND = '最后一轮只可提交'",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「收尾宽限轮：最后一轮只能交付」的钉死短语（跨档共享常量）；改写后 run.mjs:508 断言必红。⚠️ tools/taskbook-26a-negative.mjs 的 M4 锚定同一常量，但那是另一条门。',
  },
  {
    clause: 'C-093',
    rule: '让「无 settings 服务时」的来源标注恒报「内置默认」（回落来源不再显式可见）',
    file: 'lib/settings.js',
    find: "out[tier] = baseTiers?.[tier] ? 'cordis 配置' : '内置默认'",
    replace: "out[tier] = '内置默认'",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「回落显式可见，不得静默顶替」在档位来源这一处的实现；恒报内置默认后 run.mjs:2748 的「cordis 配置」断言必红。⚠️ 通用性缺口仍在——只覆盖档位这一处回落点。',
  },
  {
    clause: 'C-097',
    rule: '删掉断言鉴别力①「≥3 元素输入」（多元素断言要求消失）',
    file: 'lib/taskbook.js',
    find: '① 解析/分类类至少一条 **≥3 元素输入**断言；② 新增闸门**必须配注入必红**',
    replace: '① 解析/分类类至少一条多元素断言；② 新增闸门**必须配注入必红**',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「解析/分类类至少一条 ≥3 元素输入断言」；去掉后 run.mjs:371 的 ≥3 元素输入断言必红。⚠️ 全称要求（每个新增闸门都满足）仍无 meta 闸门。',
  },
  {
    clause: 'C-098',
    rule: '删掉断言鉴别力②「注入必红」的负向自测要求',
    file: 'lib/taskbook.js',
    find: '② 新增闸门**必须配注入必红**负向自测',
    replace: '② 新增闸门**必须配负向自测**',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「新增闸门必须配注入必红负向自测」；去掉「注入必红」后 run.mjs:372 的联合断言必红。⚠️ 全称要求（每个 tools/*.mjs 都要有 --selftest）仍无 meta 闸门。',
  },
  {
    clause: 'C-099',
    rule: '删掉断言鉴别力③「真实输入无 workaround 全量跑」',
    file: 'lib/taskbook.js',
    find: '测试类改动适用）：① 解析/分类类至少一条 **≥3 元素输入**断言；② 新增闸门**必须配注入必红**负向自测；③ 验收链含「**真实输入无 workaround 全量跑**」，不能只跑自造 fixture。',
    replace: '测试类改动适用）：① 解析/分类类至少一条 **≥3 元素输入**断言；② 新增闸门**必须配注入必红**负向自测。',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「验收链必须含真实仓库/真实输入无 workaround 全量跑」；删掉后 run.mjs:373 的断言必红。⚠️ 全称要求仍无 meta 闸门。',
  },
  {
    clause: 'C-100',
    rule: '把 critic 的 readonly 标记去掉（只读角色集合与 OMC disallowedTools 契约漂移）',
    file: 'lib/roles.js',
    find: "id: 'critic', name: 'Critic', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,",
    replace: "id: 'critic', name: 'Critic', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: false,",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「只读角色的工具面约束分两层」的层 1 名单；去掉 critic 的 readonly 后 run.mjs:126 的 12 席 deepEqual 必红（且只读白名单不再随该席渲染）。',
  },
  {
    clause: 'C-101',
    rule: '把「人格文件缺失时退化的摘要文案」标记去掉（摘要模式不再自证）',
    file: 'lib/persona.js',
    find: '（人格文件未安装）角色摘要',
    replace: '角色摘要',
    suite: ['tests/run.mjs'],
    expect: 'green',
    note: '**实测零鉴别力（2026-10-29）**：run.mjs:720 的该断言包在 `if (!persona.installed)` 分支里，而本仓 23/23 份 personas/*.md 全部已安装 → 缺省态断言是死码，删掉摘要标记主套件仍 377/0 全绿。**建议补**：用合成 role（id 不存在于 personas/）调 loadPersona，断言 installed===false + hash===null + text 含「人格文件未安装」；再配「已安装 role 该文案不得出现」的反向对照（阳性/阴性两臂）。',
  },
  {
    clause: 'C-102',
    rule: '把 catalog 行的「只创建」承诺改写成「创建」（只创建不管理的边界承诺消失）',
    file: 'lib/index.js',
    find: 'agent_spawn: "按角色创建子会话并派任务书。只创建：wake/status 走 de_session；预览 dryRun=true。',
    replace: 'agent_spawn: "按角色创建子会话并派任务书。创建：wake/status 走 de_session；预览 dryRun=true。',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「只创建，不管理：wake/status/list/rename 归 de_session」的工具级承诺；去掉「只创建」后 run.mjs:3411 的必备子串断言必红。⚠️ 「rename」的文档漂移（README 列了但 catalog 未提）仍是真缺口，见审计正本 §7 D-6。',
  },
  {
    clause: 'C-104',
    rule: '把越档告警里的「理由：」字段去掉（越档不再留理由位）',
    file: 'lib/index.js',
    find: '本次 ${built.route.tier}。理由：${reason}',
    replace: '本次 ${built.route.tier}。',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「越档会记入返回并在任务书里留理由位」；去掉理由段后 run.mjs:880 的「越档 + 跨模块重构」联合断言必红。',
  },
  {
    clause: 'C-105',
    rule: '把 roster 不可用时的 fail-open 改成照常收缩（roster 缺失也强推限制）',
    file: 'lib/toolscope-pipeline.js',
    find: "if (!roster) return { action: 'skip', reason: 'roster-unavailable', grantMissing: [], ...audit }",
    replace: "if (!roster) return { action: 'allow', names: [], ...audit }",
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「agent_spawn 依赖宿主 agents 服务；服务缺失不影响创建」的 fail-open 语义（roster 不可用 ⇒ 不收缩）；改成 allow 后 run.mjs:1575 的「roster 不可用：fail-open 不收缩」断言必红。',
  },
  {
    clause: 'C-106',
    rule: '把 tiers 回显的 tierSources 改成空对象（档位真实生效来源不再回显）',
    file: 'lib/index.js',
    find: 'const tierSources = api.sourcesOf(tierTable)',
    replace: 'const tierSources = {}',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「档位表随配置变化，真实生效值以 agent_roles action=tiers 回显为准」；sourcesOf 被短路后 run.mjs:2760 的 tierSources.HIGH 值断言必红。',
  },
  {
    clause: 'C-108',
    rule: '把「预设不存在」报错里的「可用预设（磁盘）：」清单去掉（fail-fast 不再列可用清单）',
    file: 'lib/spawn.js',
    find: '可用预设（磁盘）：',
    replace: '（清单已省略）：',
    suite: ['tests/run.mjs'],
    expect: 'red',
    note: '「minimal 预设缺失时 fail-fast 并列可用清单」；run.mjs:1157 的真实执行路径是 **registry 解析失败分支**（lib/spawn.js:311，`预设 "${resolvedPreset}" 不存在或解析失败…可用预设（磁盘）：`），不是服务完全缺失分支（:202/:320 在本测夹具下不触发——首次变异打在 :202 上实测绿，已按实测改锚点）。去掉清单后 message.includes(\'可用预设\') 必红。',
  },
]

/** sha256 of a file's bytes（还原保真校验）。 */
function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 跑主套件，返回 { ok: boolean, exit: number, tail: string }。
 *
 * fd-stdio：把 stdout/stderr 都重定向到一个临时文件（**不用 pipe** —— 沙箱必 EPERM），
 * 跑完再读该文件取尾部。临时文件在 os.tmpdir()，用完即删。
 */
export function runSuite(argv = ['tests/run.mjs']) {
  const outFile = join(tmpdir(), `dsh-cmv-${process.pid}-${Date.now()}.log`)
  const fd = openSync(outFile, 'w')
  let result = null
  try {
    result = spawnSync(process.execPath, argv.map((a) => join(ROOT, a)), {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      timeout: RUN_TIMEOUT_MS,
    })
  } finally {
    try { closeSync(fd) } catch { /* 已关忽略 */ }
  }
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch { text = '' }
  try { rmSync(outFile, { force: true }) } catch { /* 忽略 */ }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const tail = lines.slice(-3).join(' | ')
  // 不同套件的失败信号不同：run.mjs 有 "N failed"；publish-scan.test 是 "failed=N"；
  // verify-imp26 是 "33 passed, N failed"。统一以「退出码非零」为主判据，
  // 再叠加各套件的显式失败计数（任一命中即视为红）。
  const failedText = /tests: \d+ passed, [1-9]\d* failed/.test(text)
    || /\[SELFTEST\] passed=\d+ failed=[1-9]/.test(text)
    || /: \d+ passed, [1-9]\d* failed/.test(text)
    || /\[FAIL\]/.test(text)
  const ok = result?.status === 0 && !failedText
  return { ok, exit: result?.status ?? null, tail }
}

/** 应用一条变异（要求 find 恰好命中一次），返回原字节用于还原。 */
export function applyMutation(m) {
  const abs = join(ROOT, m.file)
  const original = readFileSync(abs)
  const text = original.toString('utf8')
  const hits = text.split(m.find).length - 1
  if (hits !== 1) throw new Error(`变异点命中 ${hits} 次（要求恰好 1 次）：${m.clause} ${m.file} :: ${m.find.slice(0, 60)}`)
  writeFileSync(abs, text.replace(m.find, m.replace))
  return { abs, original }
}

/** 按原字节还原并校验 sha256（失败 = exit 3 级告警）。 */
export function restoreMutation(applied, expectedSha) {
  writeFileSync(applied.abs, applied.original)
  const after = sha256Of(applied.abs)
  return { restored: after === expectedSha, after, expectedSha }
}

/** 跑一条变异：#1 基线（应绿）→ #2 变异（期望 results）→ #3 还原保真。 */
export function runOne(m, { verbose = true } = {}) {
  const abs = join(ROOT, m.file)
  const beforeSha = sha256Of(abs)
  const applied = applyMutation(m)
  let run
  try {
    run = runSuite(m.suite)
  } finally {
    var restore = restoreMutation(applied, beforeSha)
  }
  const expectedRed = m.expect === 'red'
  const gotRed = run.ok === false
  const pass = gotRed === expectedRed && restore.restored
  if (verbose) {
    const verdict = pass ? 'PASS' : 'FAIL'
    const detail = expectedRed
      ? `期望红 / 实测 ${gotRed ? '红 ✔' : '绿 ✘（零鉴别力）'}`
      : `期望绿（已登记缺口）/ 实测 ${gotRed ? '红（缺口已被填补，请更新登记表）' : '绿 ✔'}`
    console.log(`  [${verdict}] ${m.clause} ${m.rule}`)
    console.log(`         ${detail} ｜ exit=${run.exit} ｜ ${run.tail}`)
    if (!restore.restored) console.log(`         ⚠️ 还原失败！${restore.after} != ${restore.expectedSha}`)
  }
  return { m, pass, run, restore }
}

/** 框架自检：证明「必红」与「必绿」两种期望都能正确判出来（防框架自身失明）。 */
export function selftest() {
  const results = []
  const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} —— ${detail}`) }

  // S1：应用一条变异后，文件内容确实变了（证明变异真的生效，不是空转）
  const m = MUTATIONS[0]
  const abs = join(ROOT, m.file)
  const sha0 = sha256Of(abs)
  const applied = applyMutation(m)
  const shaMutated = sha256Of(abs)
  push('S1 变异真的改变了文件字节', shaMutated !== sha0, `sha 前 ${sha0.slice(0, 8)} / 变异后 ${shaMutated.slice(0, 8)}`)
  // S2：还原后 sha 必须逐字节等于原值
  const r = restoreMutation(applied, sha0)
  push('S2 按原字节还原后 sha256 一致', r.restored, `after=${r.after.slice(0, 8)} expected=${sha0.slice(0, 8)}`)
  // S3：命中次数校验——把 find 改成不存在/多处时，applyMutation 必须抛错（fail-closed）
  let threw = false
  try { applyMutation({ ...m, find: 'THIS_STRING_DOES_NOT_EXIST_ANYWHERE_xyz' }) } catch { threw = true }
  push('S3 命中 0 次必须抛错（fail-closed，不静默跳过）', threw, threw ? '已抛错' : '未抛错')
  // S4：登记表自身一致性——expect 只能是 red/green，clause 必须 C-NNN 形态
  const bad = MUTATIONS.filter((x) => !['red', 'green'].includes(x.expect) || !/^C-\d{3}$/.test(x.clause) || !x.file || !x.find || !x.replace || !Array.isArray(x.suite) || x.suite.length === 0)
  push('S4 登记表字段合法（clause/expect/file/find/replace）', bad.length === 0, bad.length ? `非法条目 ${bad.length}` : `${MUTATIONS.length} 条全部合法`)
  // S5：find/replace 不得相同（相同则变异是空转）
  const noop = MUTATIONS.filter((x) => x.find === x.replace)
  push('S5 find !== replace（防空转变异）', noop.length === 0, noop.length ? `空转 ${noop.length}` : '无空转')

  const failed = results.filter((x) => !x.ok)
  console.log(`  [selftest] ${results.length - failed.length}/${results.length} 达期望`)
  return failed.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    console.log('== constraint-mutation-verify --selftest（框架自检，不跑主套件）==')
    return selftest()
  }
  if (argv.includes('--list')) {
    console.log(`== 变异登记表（${MUTATIONS.length} 条）==`)
    for (const m of MUTATIONS) {
      console.log(`  ${m.clause} [期望${m.expect === 'red' ? '红' : '绿-已登记缺口'}] ${m.file}`)
      console.log(`     ${m.rule}`)
    }
    return 0
  }
  const onlyAt = argv.indexOf('--only')
  let targets = MUTATIONS
  if (onlyAt >= 0) {
    const id = argv[onlyAt + 1]
    targets = MUTATIONS.filter((m) => m.clause === id)
    if (targets.length === 0) { console.error(`[FAIL] 未登记条款：${id}`); return 2 }
  }
  console.log(`== constraint-mutation-verify —— PARTIAL 闸门「违反即变红」实测（${targets.length} 条）==`)
  console.log('[纪律] 只变异产品代码（lib/、tools/），不改测试；每条跑完按内存原字节还原并校验 sha256。')
  const results = []
  for (const m of targets) {
    try {
      results.push(runOne(m))
    } catch (error) {
      console.log(`  [ERROR] ${m.clause} 变异无法施加：${error?.message ?? error}`)
      results.push({ m, pass: false, error })
      // 施加失败时文件未被改动（applyMutation 在写入前校验命中次数），可安全继续
    }
  }
  const restoreFailures = results.filter((r) => r.restore && !r.restore.restored)
  const failed = results.filter((r) => !r.pass && !restoreFailures.includes(r))
  console.log('')
  console.log(`[统计] ${results.length} 条：达期望 ${results.length - failed.length - restoreFailures.length} ｜ 未达期望 ${failed.length} ｜ 还原失败 ${restoreFailures.length}`)
  if (failed.length > 0) {
    console.log('[未达期望条款]（这些条款的闸门鉴别力不足，或登记表需要更新）')
    for (const f of failed) console.log(`  - ${f.m.clause} ${f.m.rule}${f.error ? `（错误：${f.error.message}）` : ''}`)
  }
  if (restoreFailures.length > 0) {
    console.error('[还原失败] 工作区可能被污染，请立刻人工核对下列文件：')
    for (const r of restoreFailures) console.error(`  - ${r.m.file}（当前 sha=${r.restore.after}，期望=${r.restore.expectedSha}）`)
    return 3
  }
  return failed.length === 0 ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
