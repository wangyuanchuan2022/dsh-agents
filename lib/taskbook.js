/**
 * 任务书合成——把「角色卡 + 人格 + 任务 + 澄清模式 + 验收与回收」拼成
 * spawn 的首条用户消息（等价替用户在角色会话里发的一条完整任务书）。
 *
 * 模板来源：MACAE 清单 Top1「任务书模板 v2」——
 *   ① 角色-模型档位（B1 双模型分工）
 *   ② 派活前置三问（B2 域闸门，见 preflight()）
 *   ③ 澄清模式与缺省决策表（B3）
 *   ④ 角色回收核对（B4，见「汇报与回收」节）
 * 另含 DSH 工具映射表：上游人格原文里的 Claude Code 专属工具（lsp_diagnostics、
 * TodoWrite、.omc/ 等）在 DSH 不存在，必须显式给出替代物，否则子会话会去找
 * 不存在的工具。
 *
 * 模板 v3 增量（2026-09-17，权威参照**本仓** docs/task-brief-v3.md——单源正本随生成器
 *   同仓维护；port-kit/docs 下的同名旧副本已于 2026-09-29 置废弃指针，勿再参照）：
 *   §3a 现状盘点（statusQuo，可选入参）/ §5.1 交付状态三值字段 / §5.2 skip 必留痕 /
 *   §7.1 断言鉴别力 / §4.1 失败降级分层表 / §6.1 回合上界与增量指引 / §8.1 等待态退出码。
 * 模板 v3.2 增量（2026-09-26，ECC 批次1 IMP-06 回收契约 + IMP-14 epic 状态语义；
 *   权威参照同上 task-brief-v3.md §5.4/§9.2 与附录 C——组织者面五机制落在文档模板，
 *   本生成面只带执行端可见的两条：回收契约条款 + 完成广播 status/evidence 自报字段）。
 * IMP-26a（2026-09-29，DP-1 修复 + 只读白名单注入）：v3.1 三个〔生成〕分节落地——
 *   §5.3 三层失败分类与 §6.2 三档熔断+收尾宽限轮固定携带，§9.1 confirmed_findings 块按
 *   confirmedFindings 入参渲染（非空才带）；完成广播条款补（wake:true）与 L4 统一口径
 *   （organizer 缺失时附直投地址警示）；interactive 澄清超时对齐正本 5 分钟（字面一致性
 *   由 tests/run.mjs 钉住）；产出路径兜底链闭合（无路径时渲染降级出口，硬门①不悬空）；
 *   readonly 角色（lib/roles.js 的 readonly 字段）自动携带只读工具白名单。
 * D-1a（2026-10-25，plan-opt-r2 工作流 D 免费段，AC-M2-1）：合成器档位差异化——
 *   静态条款三节（五/六/七）按 route.tier 三档渲染形态：LOW=指令化短句+分类决策表；
 *   HIGH=spec 条款（R/C/P 编号 + MUST）+ few-shot 段；MEDIUM=维持现行（A2b 定稿
 *   逐字冻结，兼作 D-1b 消融对照臂）。语义不变式：三档携带同一套条款语义（三值
 *   字段/skip 留痕/三层失败/回收契约/断言鉴别力/降级表/熔断/退出码——①类安全语义
 *   零丢失），差异只在表达形态；跨档共享的钉死短语以常量去重（26a 负向门对源码
 *   字面做「恰 1 次」锚点检查）。正本同步：docs/task-brief-v3.md §2b（v3.4）。
 */
import { existsSync } from 'node:fs'
import { isolationOf } from './roles.js'

/**
 * 上下文隔离泄漏模式（派发评审/验证席时对「给出去的材料」做机检）。
 *
 * 动机：会话层隔离（新会话、不带调用方历史）只解决了一半——组织者仍可能在
 * `task`/`context`/`statusQuo` 里顺手写下「我已实现并验证通过」「另一席说没
 * 问题」，于是评审席被锚定，盲评名存实亡。这里把「不该出现在任务书里的材料」
 * 变成可命中的模式，由 preflight() 以 fail-closed 告警形式暴露。
 *
 * - `author-rationale`：作者自评/理由（blind 与 isolated 都不该给）
 * - `peer-output`：其他席位的产出与结论（只有 blind 席不该给）
 */
export const ISOLATION_LEAK_PATTERNS = [
  { kind: 'author-rationale', re: /作者(自评|说明|理由)/ },
  { kind: 'author-rationale', re: /自评(结论|意见)?/ },
  { kind: 'author-rationale', re: /我(已经)?(实现|写完|改完|完成)了?/ },
  { kind: 'author-rationale', re: /我(已经)?(验证|测|试)(过|通过)/ },
  { kind: 'author-rationale', re: /我(认为|觉得|判断)[^。；\n]{0,12}(没问题|可以|通过)/ },
  { kind: 'author-rationale', re: /(这|那)(段|份|处)(代码|改动|实现)(是|由)我/ },
  { kind: 'author-rationale', re: /我的(方案|思路|实现|判断)/ },
  { kind: 'peer-output', re: /(另一|其他|其余|另一个)(评审|席位|席)/ },
  { kind: 'peer-output', re: /(code-reviewer|security-reviewer|critic)[^\n]{0,10}(已|的)?(报告|结论|说|认为)/ },
  { kind: 'peer-output', re: /(上一轮|首轮|前一轮)(评审|裁决)(结论|意见)?/ },
  { kind: 'peer-output', re: /盲评(报告|结论|结果)/ },
  { kind: 'peer-output', re: /peer[- ]?review/i },
]

/**
 * 检出任务书材料里不该出现的隔离泄漏。
 * @param {object} input
 * @param {object|string} input.role
 * @param {string[]} [input.texts] - 实际会写进任务书的调用方文本；调用方必须把
 *   材料面参数全部纳入（task/context/statusQuo/confirmedFindings/defaults/deliverable/
 *   acceptance——漏列的面不机检，隔离契约形同虚设）
 * @returns {{mode:string, leaks:Array<{kind:string, hit:string}>}}
 */
export function detectIsolationLeaks({ role, texts = [] }) {
  const mode = isolationOf(role)
  const leaks = []
  if (mode !== 'shared') {
    for (const raw of texts) {
      const text = String(raw ?? '')
      if (text.trim() === '') continue
      for (const { kind, re } of ISOLATION_LEAK_PATTERNS) {
        // blind 席才算 peer-output 泄漏；isolated 席拿到同席材料是设计允许的
        if (kind === 'peer-output' && mode !== 'blind') continue
        const m = re.exec(text)
        if (m !== null && !leaks.some((l) => l.kind === kind && l.hit === m[0])) {
          leaks.push({ kind, hit: m[0] })
        }
      }
    }
  }
  return { mode, leaks }
}

/** 隔离契约小节（blind/isolated 才渲染；shared 角色完全不渲染）。 */
function isolationSection(role, mode) {
  const L = []
  if (mode === 'shared') return L
  L.push('### 1.1 上下文隔离契约（本次派活的硬约束）')
  L.push('')
  L.push(`- 隔离模式：**${mode === 'blind' ? 'blind（并行盲评席）' : 'isolated（独立评审/验证席）'}**。`)
  L.push('- 会话层：本会话是**全新会话**，不继承派活方的对话历史——你看不到作者的推理过程、也不应试图去猜。')
  L.push('- 材料层：**故意未提供**下列材料，且不得向组织者索取：')
  L.push('  - 作者的自评、设计理由、实现过程中的取舍说明（under review 的是**产出本身**，不是作者的论证）；')
  if (mode === 'blind') {
    L.push('  - **其他评审席的产出与结论**（并行盲评的意义在于锚定独立；两份任务书除角色外完全一致）；')
  }
  L.push('  - 既有评审结论/历史裁决（若确需参考，由组织者在派活时明确说明，不要自行推断）。')
  L.push('- 污染处置：若收到的材料里**仍然出现**作者自评或其他席位结论，按以下处置——① 不引用、不采信；② 在报告**首行**标注「⚠️ 隔离污染：<命中的原文片段>」；③ 只以可核验的产出、证据与基准为准。')
  L.push('- 取证基底（可用的材料）：被评审对象本身（diff/文件/产物）、明确的基准（规格/清单/验收标准）、以及你自己跑出来的证据。')
  L.push('')
  return L
}

/** Claude Code 专属概念 → DSH 等价物（人格文本里出现时按此映射执行）。 */
export const TOOL_ADAPTATION = [
  ['Read / Write / Edit', 'read / write / edit（同名，路径语义一致）'],
  ['Bash', 'pwsh（独立进程不留 cwd/变量，用 workdir 参数）'],
  ['Glob / Grep', 'glob / grep（别用 shell 的 find/rg）'],
  ['TodoWrite', 'todo_write（≥2 步必建清单并逐步更新）'],
  ['Task / spawn_agent（子代理）', 'de_session spawn（子会话）或 subagent'],
  ['AskUserQuestion', 'ask_user_question，或按澄清模式 de_broadcast 问组织者'],
  ['lsp_diagnostics(_directory)', '无 LSP：用 pwsh 跑类型检查/测试命令，贴原始输出'],
  ['ast_grep_search / ast_grep_replace', '无结构化检索：grep 定位、edit 修改'],
  ['python_repl', 'pwsh 调 python（自备解释器），或计算写成脚本落盘再跑'],
  ['tmux 交互测试', 'pwsh 后台任务（run_in_background=true）+ 输出文件轮询'],
  ['.omc/plans、.omc/notepads、.omc/state', '落盘按任务书路径；跨会话记忆用 memory 工具'],
  ['<remember> / <remember priority> 标签', 'memory 工具（target=daily / project / key）'],
  ['/team、Agent 预设团队', 'de_session spawn 多会话 + de_broadcast 协调'],
]

/** 泳道默认交付要求（调用方未指定 deliverable/acceptance 时的兜底）。 */
const LANE_DELIVERABLE = {
  build: [
    '- 产出落盘：写入任务书指定路径（未指定见缺省决策表），**不要只在聊天里输出**。',
    '- 证据：每条结论附可核验依据（文件:行号 / 命令+原始输出）。',
  ],
  review: [
    '- 报告落盘：write 写入任务书指定路径（评审类只读，禁止改动被评审对象）。',
    '- 每条发现三段式：`文件:行号` + 分级（P0/P1/P2）+ 【改进点】（映射到具体文件/动作）。',
    '- 目的：从产出反推可执行改进点，不是打分或泛泛评价。',
  ],
  domain: [
    '- 产出落盘：结果写入任务书指定路径；只输出到聊天不算完成。',
    '- 证据：命令、输入、原始输出片段一并给出，便于复核。',
  ],
}

/** 自动生成的缺省决策表（仅 autonomous 模式且调用方未提供时使用）。 */
const AUTO_DEFAULTS = [
  '| 缺失项 | 缺省取值 | 依据 |',
  '|---|---|---|',
  '| 产出路径 | `<cwd>/agent-out/<角色id>-<yyyyMMdd-HHmmss>.md` | 固定目录便于组织者回收核对 |',
  '| 产出格式 | Markdown | 与 DSH 报告惯例一致 |',
  '| 处理范围 | 仅任务明示的文件/目录 | 不扩大范围（最小动作原则） |',
  '| 完成标准 | 产出落盘 + 向组织者广播 | 双条件缺一即未完成 |',
  '| 判定不了的情况 | 取保守最小动作并在产出中标注「按缺省决策」 | 授权取默认，但不许编造事实 |',
]

/**
 * 只读工具白名单（IMP-26a 本体）：readonly 角色（lib/roles.js 的 readonly 字段）
 * 的任务书自动携带，把「只读顾问」从一句权限声明落成可执行的工具边界。
 * 白名单外的动作不默认允许，保留「说明意图后请求确认」出口（防只读席被硬卡死）。
 */
const READONLY_WHITELIST = [
  // SEC-P2-4d（2026-10-26）：M3 重排把角色卡移到文档尾部，「权限边界：只读顾问」声明
  // 的提示位置显著后移——在白名单节头部补一行前向引用对冲（渲染字面保持任务书指定最小形态）。
  '### 只读工具白名单（readonly 硬边界）',
  '',
  '- 权限边界：只读顾问（详见角色卡）。',
  '',
  '- 本角色为**只读席位**：允许的工具仅限——`grep` / `cat` / `ls` / `read`（只读检索与查看）+ `git log` / `git diff` / `git show --no-pager`（只读历史查看）。',
  '- 禁止：`rm` 等删除类命令、`git push` 等远端/仓库状态变更、`npm install` 等依赖安装，以及 `write` / `edit` 等一切写盘动作。',
  '- 白名单外的动作不默认允许：先在产出中**说明意图**，经组织者**确认后方可执行**；确认前保持只读。',
  '',
]

/** 只读白名单渲染（readonly === true 才携带；可写角色完全不渲染）。 */
function readonlyToolSection(role) {
  return role.readonly === true ? READONLY_WHITELIST : []
}

// ── D-1a 档位差异化（AC-M2-1，plan-opt-r2 工作流 D 免费段）────────────────────
// 三档渲染形态（正本 docs/task-brief-v3.md §2b；取态理由见 agent-out/opt-r2-d1a-report.md）：
//   LOW    = 指令化短句 + 分类决策表（探针/检索类轻席：一眼可执行、表代替散文）
//   HIGH   = spec 条款（R/C/P 编号 + MUST）+ few-shot 段（评审/规划类强席：格式即规范）
//   MEDIUM = 现行形态（v3.3 定稿：A2b + 5ef5c7e R3 返工，逐字冻结——run.mjs 14 行断言与 26a 负向门锚点钉在该
//            形态上，同时充当 D-1b 消融的对照臂；唯一变量原则）
// 语义不变式：三档携带同一套条款语义（三值字段/skip 留痕/三层失败/回收契约/断言
// 鉴别力/降级表/熔断/退出码——①类安全语义零丢失），差异只在表达形态。
// 锚点唯一性：跨档共享的钉死短语以常量去重——tools/taskbook-26a-negative.mjs 对
// 源码字面做「恰 1 次」检查，字面在两档模板里各写一遍会让门失配（M4 实证）。
const PHRASE_LAST_ROUND = '最后一轮只能交付'

/** §五 交付与验收静态条款（按档位渲染；MEDIUM 分支 = v3.3 定稿原文逐字：A2b + 5ef5c7e R3 返工）。 */
function deliverClauses(tier) {
  if (tier === 'LOW') {
    return [
      '- 汇报只许自报两种状态：`DELIVERED_WITH_EVIDENCE`（已落盘+已广播）或 `BLOCKED_NEED_HUMAN`（卡点需人介入）。`DONE` 只有组织者/用户能给，自报无效。',
      '- 环境原因没跑的检查必须记 `skipped + 原因 + 复跑命令`，不算通过。',
      '- 没做完的步骤按下面决策表申报，禁止混用：',
      '',
      '| 情况 | 申报动作 |',
      '|---|---|',
      '| 单次调用失败 | attempt 级：重试 +1；连败 3 次熔断 |',
      '| 对象没处理完 | `skipped(理由)+复跑命令` 或 `blocked(原因+复跑命令)` |',
      '| 整场停摆 | `run_failure=类目`；已完成部分照常交付 |',
      '',
      '- 派过子会话必须留回收计划：落盘非空+广播到达才算核销，超时按退出码 2/4/5；单 agent 能干的活不分层。',
      '- 涉解析/分类/闸门/测试的改动：① 断言至少一条 **≥3 元素输入**；② 新闸门必配**注入必红**负向自测；③ 验收链含「**真实输入无 workaround 全量跑**」。',
    ]
  }
  if (tier === 'HIGH') {
    return [
      '- R1 交付状态：只许自报 `DELIVERED_WITH_EVIDENCE`（已落盘+已广播）/ `BLOCKED_NEED_HUMAN`；`DONE` MUST 组织者/用户确认，自报无效。',
      '- R2 skip 留痕：未执行的检查 MUST 记 `skipped + 原因 + 复跑命令`，不计入通过项。',
      '- R3 失败分类（未完成 MUST 落层申报，禁止混用）：attempt 级=单次调用失败（连败 3 次熔断）；item 级=对象没处理完（`skipped(理由)+复跑命令`/`blocked(原因+复跑命令)`）；run 级=整场停摆（`run_failure=类目`，已完成部分照常交付）。',
      '- R4 回收契约：分层派活 MUST 留可核销回收计划（核销=落盘非空+广播到达；超时按退出码 2/4/5）；不为单 agent 能装下的活分层。',
      '- R5 断言鉴别力（涉解析/分类/闸门/测试改动适用）：① 解析/分类类至少一条 **≥3 元素输入**断言；② 新增闸门 MUST 配**注入必红**负向自测；③ 验收链含「**真实输入无 workaround 全量跑**」，不能只跑自造 fixture。',
    ]
  }
  return [
    '- 交付状态三值字段：只能自报 `DELIVERED_WITH_EVIDENCE`（已落盘+已广播）/ `BLOCKED_NEED_HUMAN`（卡点需人介入）；`DONE` 仅组织者/用户可确认——执行者自报 DONE 无效。',
    '- skip 必留痕：因环境未执行的检查记 `skipped + 原因 + 复跑命令`，不得计入通过项。',
    '- 三层失败分类（未完成步骤必须落层申报，禁止混用）：attempt 级=单次调用失败（连续 3 次按三档熔断）；item 级=对象没处理完（`skipped(封闭枚举理由)+复跑命令`/`blocked(原因+复跑命令)`）；run 级=整场停摆（`run_failure=<类目>`，已完成部分照常交付）。',
    '- 回收契约：分层派活须留可核销回收计划（核销=落盘非空+广播到达，缺一不核销；超时按退出码 2/4/5）；不为单 agent 能装下的活分层。',
    '- 断言鉴别力条款（涉解析/分类/闸门/测试类改动适用）：① 解析/分类类至少一条 **≥3 元素输入**断言；② 新增闸门**必须配注入必红**负向自测；③ 验收链含「**真实输入无 workaround 全量跑**」，不能只跑自造 fixture。',
  ]
}

/** §六 interactive 模式开场三行（按档位渲染；autonomous 块跨档共享不在此）。 */
function clarifyIntroLines(tier) {
  if (tier === 'LOW') {
    return [
      '- 模式：**interactive（可澄清）**。缺关键参数：按 `subagent-clarify` 协议用 `de_broadcast`（wake:true）问组织者（参数+候选项+影响），等回传再动手。',
      '- 禁止猜值编造；已答过的不重问；等待期只做不依赖该参数的准备，不得先斩后奏。',
      '- 超 5 分钟无回音：按降级表 L2 处理（缺省值继续，产出标注「该字段为默认值」）。',
    ]
  }
  if (tier === 'HIGH') {
    return [
      '- C1 澄清：**interactive**——缺关键参数按 `subagent-clarify` 协议用 `de_broadcast`（wake:true）问组织者，等回传再继续。',
      '- C2 防编造：缺参数必须问、禁止猜值；已答不重问；等待期只做不依赖它的准备。',
      '- C3 超时：5 分钟无回音 → 按降级表 L2（缺省值继续，标注「该字段为默认值」）。',
    ]
  }
  return [
    '- 模式：**interactive（可澄清）**——缺关键参数不得瞎猜：按 `subagent-clarify` 协议用 `de_broadcast`（wake:true）问组织者（参数名+候选项+影响），等回传再继续。',
    '- 防编造：缺参数必须问、禁止猜值，已答过的不重问；等待期可做不依赖该参数的准备，不得先斩后奏。',
    '- 超时降级：超过 5 分钟无回音按「失败降级分层表」L2 处理（缺省值继续，产出标注「该字段为默认值」）。',
  ]
}

/** §六 三档熔断与收尾宽限轮两行（小节标题跨档共享；行文本按档位渲染）。 */
function fuseLines(tier) {
  if (tier === 'LOW') {
    return [
      '- 连败必须变形态：1 报原错误 → 2 明示「这是第二次连续失败，修参数或交付」→ 3 放弃不再重试；成功清零。重派第 2 次必须改写任务书。',
      `- 收尾宽限：${PHRASE_LAST_ROUND}已识别产出，不新开分析面。`,
    ]
  }
  if (tier === 'HIGH') {
    return [
      '- C4 熔断：连败反馈必须变形态——1 原错误（可重试）→ 2 「第二次连续失败，修参数或交付」→ 3 判「已放弃，不再重试」；成功清零。重派第 2 次必须改写任务书。',
      `- C5 收尾宽限：${PHRASE_LAST_ROUND}已识别产出，不新开分析面。`,
    ]
  }
  return [
    '- 三档熔断：连续失败反馈必须变形态——1 原错误（可重试）→ 2 「这是第二次连续失败，修参数或交付」→ 3 判「已放弃，不再重试」；成功清零。重派第 2 次必须显式改写任务书。',
    `- 收尾宽限轮：最后一轮只许提交已识别产出，不许新开分析面（「${PHRASE_LAST_ROUND}」）。`,
  ]
}

/** §七 汇报与回收核对条目（小节标题与退出码表跨档共享；条目按档位渲染）。 */
function reportLines(tier) {
  if (tier === 'LOW') {
    return [
      '- 广播正文带 `status=`（pending/running/blocked/done 外无效）与 `evidence=`（产出路径）；迁移须有明确事件支撑，乱跳状态是事故，须广播说明。',
      '- 长任务每个里程碑广播一次；增量随时落盘，不攒到最后。',
      '- 完成不了必须广播卡点（组织者以 `de_session status/list` 核对），不得静默停止。',
      '- 同一步骤 3 轮无落盘增量就收尾：剩余项列清单广播移交组织者重划界。',
      '- 收到唤醒/追加消息只做增量，不重做已确认的部分。',
    ]
  }
  if (tier === 'HIGH') {
    return [
      '- P1 状态自报：广播正文带 `status=`（pending/running/blocked/done 外无效）与 `evidence=`（路径）；迁移须有明确事件支撑，跳迁/复活 done 是事故，须广播说明。',
      '- P2 进度：长任务每里程碑广播一次；增量随时落盘。',
      '- P3 回收：组织者以 `de_session status/list` 核对；完成不了必须广播卡点，不得静默停止。',
      '- P4 回合上界：同一步骤 3 轮无落盘增量即收尾，剩余项列清单广播移交组织者。',
      '- P5 增量：唤醒/追加消息只做增量，不重做已确认部分。',
    ]
  }
  return [
    '- 状态自报：广播正文带 `status=`（pending/running/blocked/done 外无效）与 `evidence=`（产出路径）；迁移须有事件支撑，跳迁/复活 done 是事故，须广播说明。',
    '- 中途进度：长任务（>10 分钟）每里程碑广播一次；增量随时落盘，不攒到最后。',
    '- 角色回收：组织者以 `de_session status/list` 核对产出；无法完成必须广播卡点，不得静默停止。',
    '- 回合上界：同一步骤**最多 3 轮无新落盘增量的往返**；达限即收尾，剩余项列清单广播移交组织者重划界，不得无限续命。',
    '- 增量指引：收到唤醒/追加消息只处理增量指令，**不重做已确认的部分**（原任务在会话历史里）。',
  ]
}

/** §七 HIGH 档 few-shot 段（汇报正文形态示例；LOW/MEDIUM 不渲染——HIGH 模式特征锚点）。 */
function fewShotLines(tier) {
  if (tier !== 'HIGH') return []
  return [
    '### few-shot（汇报格式）',
    '',
    '- 完成：`status=done evidence=<路径> 结论=<一句话> 未解决项=无`',
    '- 卡点：`status=blocked evidence=<路径> 卡点=<依赖> 复跑=<命令>`',
    '',
  ]
}

/** 时间戳（yyyyMMdd-HHmmss，本地时区）——任务书头部与缺省文件名用。
 * A4：分钟→秒精度，消除同分钟并行派活的默认产出路径撞车（首跑实证）。 */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * 产出路径同名去重（A4 首跑撞车实证：两份任务书同分钟拿到同一默认路径）。
 * 目标路径已存在（exists 注入便于单测）则追加 -<HHmmss> 后缀；扩展名保留。
 */
export function dedupeEvidencePath(path, exists = (p) => existsSync(p), now = new Date()) {
  const p = String(path ?? '').trim()
  if (p === '' || !exists(p)) return p
  const pad = (n) => String(n).padStart(2, '0')
  const suffix = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dot = p.lastIndexOf('.')
  return dot > slash + 1 ? `${p.slice(0, dot)}-${suffix}${p.slice(dot)}` : `${p}-${suffix}`
}

/** 档位来源的中文说明（让子会话/组织者知道模型为何是它）。 */
function sourceLabel(source) {
  return {
    'explicit-route': '调用期显式指定 provider+model',
    'explicit-tier': '调用期显式指定档位',
    'role-override': '配置按角色覆盖（config.roleOverrides）',
    'tier-default': '档位默认表（config.tiers）',
  }[source] ?? source
}

/**
 * 合成角色任务书（= spawn 的首条用户消息）。
 *
 * @param {object} input
 * @param {object} input.role - 角色定义
 * @param {object} input.persona - loadPersona 结果
 * @param {object} input.route - resolveRoute 结果（含 tier/provider/model/source）
 * @param {object} input.tierIntent - 档位设计意图文案（TIER_INTENT[tier]）
 * @param {string} input.task - 任务正文
 * @param {string} [input.clarifyMode] - interactive | autonomous
 * @param {string} [input.defaults] - 缺省决策表（markdown，autonomous 用）
 * @param {string} [input.context] - 补充上下文（背景材料路径等）
 * @param {string} [input.statusQuo] - v3 §3a 现状盘点（组织者派活前对账结论；非空才渲染）
 * @param {string} [input.confirmedFindings] - v3 §9.1 confirmed_findings 已结论清单
 *   （增量轮结构化下发；非空才渲染，生成器自动附否定式指令与免查凭证条款）
 * @param {string} [input.deliverable] - 交付要求覆盖
 * @param {string} [input.acceptance] - 验收标准覆盖
 * @param {string} [input.evidencePath] - 产出落盘路径
 * @param {string} [input.organizer] - 组织者会话 id（回收广播对象）
 * @param {string} [input.cwd] - 工作目录
 * @returns {string} 任务书文本
 */
export function composeTaskbook({
  role, persona, route, tierIntent, task, clarifyMode = 'interactive', defaults,
  context, statusQuo, confirmedFindings, deliverable, acceptance, evidencePath, organizer, cwd,
}) {
  // DP-1 P2-9/F-15：库层入参守卫（工具层已有校验，直通消费方此前无防护——
  // task 缺失产出空任务节、route 缺失裸崩溃，均无报错信号）。
  if (role == null || typeof role.id !== 'string' || role.id === '') throw new TypeError('composeTaskbook: role（含 id）为必填')
  if (route == null || typeof route.tier !== 'string') throw new TypeError('composeTaskbook: route（resolveRoute 结果，含 tier/provider/model）为必填——请先跑 resolveRoute，勿传 null')
  if (task == null || String(task).trim() === '') throw new TypeError('composeTaskbook: task 为必填且不得为空白')
  if (clarifyMode !== 'interactive' && clarifyMode !== 'autonomous') throw new TypeError(`composeTaskbook: clarifyMode 只接受 interactive|autonomous，收到「${clarifyMode}」`)
  const L = []
  // M3 静态重排（Round 2 工作流 A，A1 设计见 agent-out/opt-r2-a1-design.md）：
  // 「静态远场 → 动态近场」布局——远场（头部去 stamp → 三人格 → 1.1 隔离契约 → 二职责 →
  // 八工具映射 → 五静态条款 → 六澄清 → 七汇报）为跨 spawn 共享前缀，逐 spawn 变化项
  // （stamp/evidencePath/organizer/deliverable/acceptance）集中尾置「本次参数」块（§四 内）。
  // 节名与编号零改动（跨节引用「按第五/六节处置」恒真；锚点=tests/run.mjs「任务书含七节」测试钉 8 节 includes——不写死行号，防插入漂移腐化，CODE-P2-8）。
  L.push(`# 角色任务书 · ${role.name}（${role.id}）`)
  L.push('')
  L.push(`> 由 dsh-agents 生成 · 档位路由 ${route.tier}`)
  L.push('')

  // ── 三、人格细则 ────────────────────────────────────────────────────────
  L.push('## 三、人格细则')
  L.push('')
  L.push(persona.text)
  L.push('')

  // 上下文隔离契约（评审/验证席才渲染；置于职责之前——先立约束再给材料/职责；
  // tests/run.mjs 隔离契约顺序断言钉「### 1.1 上下文隔离契约」须先于「## 二、职责与边界」——锚点式引用不写死行号（CODE-P2-8））
  L.push(...isolationSection(role, isolationOf(role)))

  // ── 二、职责与边界 ──────────────────────────────────────────────────────
  L.push('## 二、职责与边界')
  L.push('')
  L.push(`- 职责：${role.mission}`)
  L.push(`- 上游角色描述（oh-my-claudecode，MIT）：${role.description}`)
  L.push('- 边界：只做本角色职责内的事；发现任务越出职责范围，按第五/六节处置，不要顺手代做其他角色的事。')
  // IMP-26a：只读角色自动携带工具白名单（按 roles.js 的 readonly 字段判定）
  L.push(...readonlyToolSection(role))
  L.push('')

  // ── 八、DSH 工具映射 ────────────────────────────────────────────────────
  L.push('## 八、Claude Code → DSH 工具映射')
  L.push('')
  L.push('| 人格中提到的 | 在 DSH 里用 |')
  L.push('|---|---|')
  for (const [from, to] of TOOL_ADAPTATION) L.push(`| ${from} | ${to} |`)
  L.push('')
  L.push('> 未列工具视作不可用：找最接近的 DSH 能力替代，产出中说明。')
  L.push('')

  // ── 五、交付与验收（静态条款；D-1a 起按 route.tier 三档渲染）────────────────
  // M3 静态重排：逐 spawn 变化行（evidencePath/deliverable/硬门措辞/acceptance）
  // 移至尾部「本次参数」块，本节只留跨 spawn 恒定的申报与验收语义条款。
  L.push('## 五、交付与验收')
  L.push('')
  // D-1a：LOW=指令化短句+分类决策表 / HIGH=R 编号 spec 条款 / MEDIUM=A2b 定稿原文。
  // （逐条条款注释随文本迁入 deliverClauses 各分支；语义不变式见该函数头注释。）
  L.push(...deliverClauses(route.tier))
  L.push('')

  // ── 六、澄清模式 ────────────────────────────────────────────────────────
  L.push('## 六、澄清模式')
  L.push('')
  if (clarifyMode === 'autonomous') {
    L.push('- 模式：**autonomous（禁提问）**——不提问不等确认；缺信息按下方缺省决策表取值，产出标注「按缺省决策」。')
    L.push('- 严禁编造事实：缺省表只授权取默认值，不授权臆造；判定不了如实写「未获得该信息」，取最保守动作。')
    L.push('')
    L.push('### 缺省决策表')
    L.push('')
    const table = defaults != null && String(defaults).trim() !== ''
      ? String(defaults).trim().split(/\r?\n/)
      : AUTO_DEFAULTS
    if (!(defaults != null && String(defaults).trim() !== '')) {
      L.push('')
      L.push('> ℹ️ 调用方未提供 defaults，以上为内置缺省表（回落显式可见，不得静默顶替）。')
    }
    L.push(...table)
  } else {
    // D-1a：interactive 开场三行按档位渲染（LOW 短句 / HIGH C 编号 / MEDIUM 原文）
    L.push(...clarifyIntroLines(route.tier))
  }
  L.push('')
  // v3 §4.1：失败降级分层表（两模式共用；L2 为 interactive 超时的唯一口径；四级语义见正本节4.1）
  L.push('### 失败降级分层表')
  L.push('')
  L.push('| 层级 | 情形 | 动作 |')
  L.push('|---|---|---|')
  L.push('| L1 | 缺参数 | interactive=按协议问组织者；autonomous=查缺省决策表 |')
  L.push('| L2 | 澄清超时无回音 | 缺省值继续，产出标注「该字段为默认值」 |')
  L.push('| L3 | 工具不可用 | 换最接近等价能力完成，产出说明替代方式 |')
  L.push('| L4 | 产出无法落盘/无法继续 | **必须 `de_broadcast`（wake:true）广播卡点**，不得静默停止 |')
  L.push('')
  // v3.1 §6.2：三档熔断与收尾宽限轮（IMP-26a 落地；标题跨档共享，行文本 D-1a 按档位渲染）
  L.push('### 三档熔断与收尾宽限轮')
  L.push('')
  L.push(...fuseLines(route.tier))
  L.push('')

  // ── 七、汇报与回收 ──────────────────────────────────────────────────────
  L.push('## 七、汇报与回收核对')
  L.push('')
  // v3.2 §9.2 执行面（IMP-14 epic 状态语义对齐）：条目 D-1a 起按档位渲染
  //（子会话自报状态走白名单词；迁移白名单表见正本节9.2）
  L.push(...reportLines(route.tier))
  L.push('')
  // D-1a：HIGH 档追加 few-shot 段（汇报正文形态示例；LOW/MEDIUM 返回空不渲染）
  L.push(...fewShotLines(route.tier))
  // v3 §8.1：等待态退出码表（码值语义与处置见正本节8.1）
  L.push('### 等待态退出码表')
  L.push('')
  L.push('| 码 | 含义 | 组织者处置 |')
  L.push('|---|---|---|')
  L.push('| 0 | 产出完整且已广播 | 正常回收验收 |')
  L.push('| 2 | 有产出但未广播 | 查文件补广播，或直接验收 |')
  L.push('| 3 | 已广播但组织者未确认 | 进入验收 |')
  L.push('| 4 | 上游产物变更需重跑 | 按断点重派（带增量指引） |')
  L.push('| 5 | 依赖阻塞 | 挂待办，**不判死不重派** |')
  L.push('')

  // ── 一、角色卡（动态近场：cwd/档位来源等逐 spawn 变化项）──────────────────
  L.push('## 一、角色卡（角色-模型档位）')
  L.push('')
  L.push(`- 角色：**${role.name}**（id \`${role.id}\`，泳道：${role.lane}）`)
  L.push(`- 模型档位：**${route.tier}** —— 本会话已按该档位钉死模型 ${route.provider ?? '(未解析)'} / ${route.model ?? '(未解析)'}（定档依据：${sourceLabel(route.source)}）`)
  if (tierIntent) L.push(`- 档位意图：${tierIntent}`)
  L.push(`- 权限边界：${role.readonly ? '**只读顾问**——禁止写/改任何文件（含被评审对象），产出全部走报告；需要实施时移交 executor 类角色' : '可写实施——只在任务指定范围内改动文件'}`)
  L.push(`- 人格文件：${persona.installed ? `personas/${role.id}.md（sha256:${persona.hash}）` : '⚠️ **未安装**——本次以角色摘要模式运行，行为约束以本任务书条款为准'}`)
  if (cwd) L.push(`- 工作目录：${cwd}`)
  L.push('')

  // ── 四、本次任务 ────────────────────────────────────────────────────────
  L.push('## 四、本次任务')
  L.push('')
  L.push(String(task ?? '').trim())
  L.push('')
  if (context != null && String(context).trim() !== '') {
    L.push('### 背景与上下文')
    L.push('')
    L.push(String(context).trim())
    L.push('')
  }
  // v3 §3a：派活前对账结论（缺省完全不渲染该小节）
  if (statusQuo != null && String(statusQuo).trim() !== '') {
    L.push('### 现状盘点（派活前对账）')
    L.push('')
    L.push('以下为组织者派活前对账结论，据此判定全新/断点续传/重做；盘点枚举失败≠对象不存在。')
    L.push('')
    L.push(String(statusQuo).trim())
    L.push('')
  }
  // v3.1 §9.1：confirmed_findings 块（IMP-26a 落地；confirmedFindings 非空才渲染，
  // 生成器自动附否定式指令与免查凭证条款——该块约束的是重复，不是范围）
  if (confirmedFindings != null && String(confirmedFindings).trim() !== '') {
    L.push('### confirmed_findings（上一轮已结论清单，增量轮免查依据）')
    L.push('')
    L.push(String(confirmedFindings).trim())
    L.push('')
    L.push('- 纪律：不要重复上述已结论项；继续在剩余面上找新发现，不得因清单存在而止步——该块约束的是**重复**，不是**范围**。')
    L.push('- 免查需凭证：免查项必须在上一轮覆盖账有 reviewed 记录**且**文件内容哈希未变，否则重评。')
    L.push('')
  }

  // ── 本次参数（逐 spawn 变化项集中区；M3 静态重排尾置）─────────────────────
  // 集中：organizer 完成广播 / stamp / evidencePath / deliverable / acceptance——
  // 跨 spawn 共享前缀由此向前延伸到 §四 task 文本（A1 设计 1.1/1.2）。
  L.push('### 本次参数（逐 spawn 变化项）')
  L.push('')
  // DP-1 P1-2 修复：完成广播补（wake:true），与降级分层表 L4 条款统一口径（inject 不唤醒,
  // idle 组织者收不到完成广播会拖长回收）；organizer 缺失时附直投地址警示（F-2 改进点）。
  // IMP-26a P1 后续批（hunter 双席 P2-2）：organizer 纯空白串 trim 归一——truthy 判定
  // 会把 "   " 渲染成不可见收件地址且警示不触发，三态归一（有 id / 空白=缺省 / null）。
  const orgId = typeof organizer === 'string' ? organizer.trim() : organizer
  L.push(`- 完成广播：\`de_broadcast\`（wake:true）→ 组织者${orgId ? ` \`${orgId}\`` : ' ⚠️ **未携带组织者会话 ID**——向派活方索取直投地址，禁止群发'}（subject「${role.id} 完成」），正文=产出绝对路径+一句话结论+未解决项。`)
  L.push(`- 生成时刻：${stamp()}`)
  // DP-1 F-4/P2-7 修复：路径兜底链闭合——evidencePath 缺失（含 null）时渲染显式降级
  // 出口（autonomous=按缺省决策表；interactive=向组织者索要），硬门①不再悬空引用
  // 「上面指定路径」；null 也不再串化成字面量 "null" 渲染。
  const hasEvidencePath = evidencePath != null && String(evidencePath).trim() !== ''
  if (hasEvidencePath) {
    L.push(`- 产出落盘路径：\`${String(evidencePath).trim()}\``)
  } else {
    L.push(`- 产出落盘路径：⚠️ **未指定**——${clarifyMode === 'autonomous' ? '按下方「缺省决策表」的产出路径行取默认落点；若 cwd 亦未获得，按 L4 用 de_broadcast 广播 `run_failure=cwd_missing` 卡点（失败申报，非提问——不违反禁提问条款）' : '按降级分层表 L1 用 de_broadcast（wake:true）向组织者索要明确路径，得到答复再落盘'}。`)
  }
  const deliverableLines = deliverable != null && String(deliverable).trim() !== ''
    ? String(deliverable).trim().split(/\r?\n/)
    : LANE_DELIVERABLE[role.lane] ?? LANE_DELIVERABLE.build
  // DP-1 P2-6/F-12：已有列表/表格标记的行不加前缀（'| x |' 被加 '- ' 会破坏表格渲染）；
  // 其余行加 '- ' 保持列表语义。
  const alreadyListed = (line) => /^\s*(-|\*|\+|\d+\.|\|)/.test(line)
  L.push(...deliverableLines.map((line) => (alreadyListed(line) ? line : `- ${line}`)))
  L.push(`- 硬性完成标准（**双条件，缺一即未完成**）：① 产出用 write 落盘${hasEvidencePath ? '到上面指定路径' : '（路径未预置——按「产出落盘路径」行的降级出口确定后落盘，不得只在聊天里输出）'}；② de_broadcast 发完成消息。只聊天输出或只落盘不广播都算未完成。`)
  if (acceptance != null && String(acceptance).trim() !== '') {
    L.push('- 验收标准（组织者判定用）：')
    L.push(...String(acceptance).trim().split(/\r?\n/).map((line) => (alreadyListed(line) ? `  ${line}` : `  - ${line}`)))
  }
  L.push('')

  return L.join('\n')
}

/**
 * 派活前置三问（MACAE B2 的 DSH 变体）——组织者在派活前自检。
 * 注意方向反转：MACAE 分类失败默认执行（fail-open），DSH 语境里「不派」才是
 * 安全默认；三问判不出就先补能力再说。
 *
 * @param {object} input
 * @param {object} input.role
 * @param {string} input.task
 * @param {object} input.route
 * @param {boolean} [input.modelVerified] - 模型是否已在 provider 目录中校验通过
 * @param {string} [input.modelWarning]
 * @param {string[]} [input.extraTexts] - 会写进任务书的其他调用方文本（context/statusQuo/deliverable/acceptance），
 *   用于隔离泄漏机检
 * @returns {{questions:string[], warnings:string[], isolation:{mode:string, leaks:Array<{kind:string,hit:string}>}}}
 */
export function preflight({ role, task, route, modelVerified, modelWarning, extraTexts = [] }) {
  const text = String(task ?? '')
  const questions = [
    `① 这件事该谁做：本任务落在 ${role.name}（${role.id}）的职责内吗？越界部分是否该拆给别的角色（如只读角色不得代做实施）。`,
    `② 目标会话有没有相应工具/数据：本角色会话具备 DSH 通用工具（read/write/edit/pwsh/glob/grep/todo_write/de_broadcast/de_session 等）${role.readonly ? '，但按人格约定只读' : ''}；任务若依赖专用工具（知识库、渠道、外部 CLI），先确认它们在本会话可用。`,
    '③ 是否要求对方做它做不到的副作用：真实写库、删数据、发消息、下单、装依赖、改工作区外文件——这类动作默认 fail-closed（判不出就不做），需要时由组织者自己执行或先补能力。',
  ]
  const warnings = []
  if (route !== null && route !== undefined && route.overridden) {
    warnings.push(`本次档位与角色默认档位不同（角色默认 ${route.roleTier} → 实际 ${route.tier}）：越档是有意为之的话，请在汇报里写明理由。`)
  }
  if (modelWarning !== undefined && modelWarning !== '') warnings.push(modelWarning)
  if (modelVerified === false && (modelWarning === undefined || modelWarning === '')) {
    warnings.push('模型未在 provider 目录中校验通过——派活前请确认路由可用。')
  }
  // 副作用关键词：命中即提示 fail-closed 复核（读/分析类不拦）。
  // DP-1 F-13：中文泛词收窄为动宾形态——「发消息/发送」在 DSH 任务书语境是完成广播
  // 的标配动作而非副作用，命中会造成恒真告警噪音；「删除」收窄到数据/库表面。
  const sideEffect = /(git\s+push|npm\s+(i|install)|pnpm\s+(i|add)|pip\s+install|rm\s+-rf|del\s+\/|删除(数据|库|表|生产)|推送(到|代码|镜像)|部署(到|上线)|下单|写库|DROP\s+TABLE)/i.exec(text)
  if (sideEffect) {
    warnings.push(`任务文本命中副作用动作「${sideEffect[0]}」：写/外发/安装类判定不了就不做（fail-closed），派活前请确认目标会话确实有该权限与授权。`)
  }
  // 上下文隔离泄漏：评审/验证席的材料机检（fail-closed 告警，不阻断但必须显式可见）
  const isolation = detectIsolationLeaks({ role, texts: [text, ...extraTexts] })
  if (isolation.mode !== 'shared') {
    if (isolation.leaks.length === 0) {
      warnings.push(`上下文隔离：本席为 ${isolation.mode} 模式（${isolation.mode === 'blind' ? '并行盲评——不含其他席位产出' : '独立评审——不含作者自评'}），材料机检未发现泄漏；任务书已带「上下文隔离契约」条款。`)
    } else {
      for (const leak of isolation.leaks) {
        warnings.push(leak.kind === 'author-rationale'
          ? `⚠️ 隔离泄漏（作者自评/理由）：「${leak.hit}」出现在将下发给 ${role.id}（${isolation.mode}）的材料里——评审席只该拿到产出与基准，请删掉作者立场性表述后重派；若坚持保留，报告结论不得作为独立评审采信。`
          : `⚠️ 隔离泄漏（其他席位产出）：「${leak.hit}」出现在将下发给 ${role.id}（blind）的材料里——盲评被锚定即失去意义，请为每一席准备除角色外完全一致的任务书，删掉其他席位的结论后重派。`)
      }
    }
  }
  return { questions, warnings, isolation }
}
