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
 * 模板 v3 增量（2026-09-17，权威参照 port-kit/docs/task-brief-v3.md）：
 *   §3a 现状盘点（statusQuo，可选入参）/ §5.1 交付状态三值字段 / §5.2 skip 必留痕 /
 *   §7.1 断言鉴别力 / §4.1 失败降级分层表 / §6.1 回合上界与增量指引 / §8.1 等待态退出码。
 */
import { existsSync } from 'node:fs'

/** Claude Code 专属概念 → DSH 等价物（人格文本里出现时按此映射执行）。 */
export const TOOL_ADAPTATION = [
  ['Read / Write / Edit', 'read / write / edit（同名能力，路径语义一致）'],
  ['Bash', 'pwsh（每个调用是独立进程，不保留 cwd/变量，用 workdir 参数）'],
  ['Glob / Grep', 'glob / grep（优先用它们而不是 shell 的 find/rg）'],
  ['TodoWrite', 'todo_write（步骤 ≥2 时必须建清单并逐步更新）'],
  ['Task / spawn_agent（子代理）', 'de_session spawn（子会话）或 subagent 工具'],
  ['AskUserQuestion', 'ask_user_question，或按澄清模式走 de_broadcast 问组织者'],
  ['lsp_diagnostics(_directory)', '没有 LSP 工具：用 pwsh 跑项目的类型检查/测试命令，贴原始输出'],
  ['ast_grep_search / ast_grep_replace', '没有结构化检索：用 grep 定位、edit 修改'],
  ['python_repl', 'pwsh 里调用 python（自备解释器路径），或把计算写成脚本落盘再跑'],
  ['tmux 交互测试', 'pwsh 后台任务（run_in_background=true）+ 输出文件轮询'],
  ['.omc/plans、.omc/notepads、.omc/state', '任务书指定的落盘路径；跨会话记忆用 memory 工具'],
  ['<remember> / <remember priority> 标签', 'memory 工具（target=daily / project / key）'],
  ['/team、Agent 预设团队', 'de_session spawn 多个角色会话 + de_broadcast 协调'],
]

/** 泳道默认交付要求（调用方未指定 deliverable/acceptance 时的兜底）。 */
const LANE_DELIVERABLE = {
  build: [
    '- 产出落盘：把结果写入任务书指定的路径（未指定时见缺省决策表），**不要只在聊天里输出**。',
    '- 证据：每条结论附可核验依据（文件:行号 / 命令 + 原始输出片段）。',
  ],
  review: [
    '- 报告落盘：以 write 工具写入任务书指定路径（评审类任务只读，禁止改动被评审对象）。',
    '- 每条发现三段式：`文件:行号` + 分级（P0/P1/P2）+ 【改进点】（映射到具体文件/动作）。',
    '- 目的写清楚：从产出反推可执行改进点，而不是打分或泛泛评价。',
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
 * @param {string} [input.deliverable] - 交付要求覆盖
 * @param {string} [input.acceptance] - 验收标准覆盖
 * @param {string} [input.evidencePath] - 产出落盘路径
 * @param {string} [input.organizer] - 组织者会话 id（回收广播对象）
 * @param {string} [input.cwd] - 工作目录
 * @returns {string} 任务书文本
 */
export function composeTaskbook({
  role, persona, route, tierIntent, task, clarifyMode = 'interactive', defaults,
  context, statusQuo, deliverable, acceptance, evidencePath, organizer, cwd,
}) {
  const L = []
  L.push(`# 角色任务书 · ${role.name}（${role.id}）`)
  L.push('')
  L.push(`> 由 dsh-agents 生成 · ${stamp()} · 档位路由 ${route.tier}`)
  L.push('')

  // ── 一、角色卡 ──────────────────────────────────────────────────────────
  L.push('## 一、角色卡（角色-模型档位）')
  L.push('')
  L.push(`- 角色：**${role.name}**（id \`${role.id}\`，泳道：${role.lane}）`)
  L.push(`- 模型档位：**${route.tier}** —— 本会话已按该档位钉死模型 ${route.provider ?? '(未解析)'} / ${route.model ?? '(未解析)'}（定档依据：${sourceLabel(route.source)}）`)
  if (tierIntent) L.push(`- 档位意图：${tierIntent}`)
  L.push(`- 权限边界：${role.readonly ? '**只读顾问**——禁止写/改任何文件（含被评审对象），产出全部走报告；需要实施时移交 executor 类角色' : '可写实施——只在任务指定范围内改动文件'}`)
  L.push(`- 人格文件：${persona.installed ? `personas/${role.id}.md（sha256:${persona.hash}）` : '⚠️ **未安装**——本次以角色摘要模式运行，行为约束以本任务书条款为准'}`)
  if (cwd) L.push(`- 工作目录：${cwd}`)
  L.push('')

  // ── 二、职责与边界 ──────────────────────────────────────────────────────
  L.push('## 二、职责与边界')
  L.push('')
  L.push(`- 职责：${role.mission}`)
  L.push(`- 上游角色描述（oh-my-claudecode，MIT）：${role.description}`)
  L.push('- 边界：只做本角色职责内的事；发现任务越出职责范围，按第五/六节处置，不要顺手代做其他角色的事。')
  L.push('')

  // ── 三、人格细则 ────────────────────────────────────────────────────────
  L.push('## 三、人格细则')
  L.push('')
  L.push(persona.text)
  L.push('')

  // ── 四、本次任务 ────────────────────────────────────────────────────────
  L.push('## 四、本次任务')
  L.push('')
  L.push(String(task ?? '').trim())
  L.push('')
  if (context !== undefined && String(context).trim() !== '') {
    L.push('### 背景与上下文')
    L.push('')
    L.push(String(context).trim())
    L.push('')
  }
  // v3 §3a：派活前对账结论（缺省完全不渲染该小节）
  if (statusQuo !== undefined && String(statusQuo).trim() !== '') {
    L.push('### 现状盘点（派活前对账）')
    L.push('')
    L.push('以下为组织者派活前对账结论，据此判定全新/断点续传/重做；盘点枚举失败≠对象不存在。')
    L.push('')
    L.push(String(statusQuo).trim())
    L.push('')
  }

  // ── 五、交付与验收 ──────────────────────────────────────────────────────
  L.push('## 五、交付与验收')
  L.push('')
  if (evidencePath !== undefined && String(evidencePath).trim() !== '') {
    L.push(`- 产出落盘路径：\`${String(evidencePath).trim()}\``)
  }
  const deliverableLines = deliverable !== undefined && String(deliverable).trim() !== ''
    ? String(deliverable).trim().split(/\r?\n/)
    : LANE_DELIVERABLE[role.lane] ?? LANE_DELIVERABLE.build
  L.push(...deliverableLines.map((line) => (line.startsWith('-') ? line : `- ${line}`)))
  L.push('- 硬性完成标准（**双条件，缺一即未完成**）：① 产出已用 write 工具落盘到上面指定路径；② 已用 de_broadcast 向组织者发完成消息。只在聊天里输出、或只落盘不广播，都算未完成。')
  // v3 §5.1：交付状态三值字段（DONE 只由组织者/用户确认）
  L.push('- 交付状态三值字段：汇报时**只能自报前两值**——`DELIVERED_WITH_EVIDENCE`（产出已落盘 + 已广播，证据齐备）或 `BLOCKED_NEED_HUMAN`（卡点明确，需人介入）；`DONE`（验收通过）**只能由组织者/用户确认，执行者自报 DONE 无效**。')
  // v3 §5.2：skip 必留痕
  L.push('- skip 必留痕：任何因环境（提权/凭据/平台/网络）而**未执行的检查或步骤**，必须显式记录为 `skipped + 原因 + 复跑命令`，**不得计入通过项**（组织者核验时 skipped 单列）。')
  if (acceptance !== undefined && String(acceptance).trim() !== '') {
    L.push('- 验收标准（组织者判定用）：')
    L.push(...String(acceptance).trim().split(/\r?\n/).map((line) => (line.startsWith('-') ? `  ${line}` : `  - ${line}`)))
  }
  // v3 §7.1：断言鉴别力条款（涉及解析/分类/闸门/测试类改动时适用）
  L.push('- 断言鉴别力条款（涉及解析/分类/闸门/测试类改动时适用）：① 解析/分类类功能至少有一个 **≥3 元素输入**的断言（单元素断言分不出实现用的是「串接」还是「取首个」，零鉴别力）；② 新增闸门**必须配注入必红**的负向自测（只验证好文件过门的闸门是半成品）；③ 验收链必须含「**真实输入无 workaround 全量跑**」一项，不能只跑自造 fixture。')
  L.push('')

  // ── 六、澄清模式 ────────────────────────────────────────────────────────
  L.push('## 六、澄清模式')
  L.push('')
  if (clarifyMode === 'autonomous') {
    L.push('- 模式：**autonomous（禁提问）**——不要向任何人提问、不要停下来等确认；缺信息一律按下面的缺省决策表取值，并在产出中标注「按缺省决策」。')
    L.push('- 严禁编造事实：缺省决策表只授权你取默认值，不授权你臆造数据、路径或结论；无法判定就如实写明「未获得该信息」并按最保守动作执行。')
    L.push('')
    L.push('### 缺省决策表')
    L.push('')
    const table = defaults !== undefined && String(defaults).trim() !== ''
      ? String(defaults).trim().split(/\r?\n/)
      : AUTO_DEFAULTS
    L.push(...table)
  } else {
    L.push('- 模式：**interactive（可澄清）**——缺关键参数时**不得瞎猜**：按 `subagent-clarify` 技能协议，用 `de_broadcast`（wake:true）向组织者发结构化提问（参数名 + 候选项 + 各自影响），等答案回传后再继续。')
    L.push('- 防编造：缺参数必须问、禁止猜值、已答过的不重问；等待期间可做不依赖该参数的准备工作，但不得先斩后奏。')
    L.push('- 超时降级：超过 15 分钟无回音，按下方「失败降级分层表」L2 处理（用缺省值继续，并在产出里标注「该字段为默认值」）。')
  }
  L.push('')
  // v3 §4.1：失败降级分层表（两模式共用；L2 为 interactive 超时的唯一口径）
  L.push('### 失败降级分层表')
  L.push('')
  L.push('四级逐层降级，禁止跳层、禁止静默：')
  L.push('')
  L.push('| 层级 | 情形 | 动作 |')
  L.push('|---|---|---|')
  L.push('| L1 | 缺参数 | interactive=按澄清协议向组织者提问；autonomous=查缺省决策表 |')
  L.push('| L2 | 澄清超时无回音 | 用缺省值继续，产出中标注「该字段为默认值」 |')
  L.push('| L3 | 工具不可用 | 换最接近的等价能力完成，产出中说明替代方式 |')
  L.push('| L4 | 产出无法落盘 / 任务无法继续 | **必须 `de_broadcast`（wake:true）广播卡点**，不得静默停止 |')
  L.push('')

  // ── 七、汇报与回收 ──────────────────────────────────────────────────────
  L.push('## 七、汇报与回收核对')
  L.push('')
  L.push(`- 完成广播：\`de_broadcast\` → 组织者${organizer ? ` \`${organizer}\`` : ''}（subject 用「${role.id} 完成」），正文含：产出文件绝对路径 + 一句话结论 + 未解决项。`)
  L.push('- 中途进度：长任务（>10 分钟）每完成一个里程碑广播一次进度；增量产物随时追加落盘，不要攒到最后一次性写。')
  L.push('- 角色回收：组织者会用 `de_session action=list/status` 核对本会话是否已产出；若你无法完成，必须广播说明卡点，**不得静默停止**。')
  // v3 §6.1：回合上界与增量指引
  L.push('- 回合上界：同一步骤在同一会话内**最多 3 轮无新落盘增量的往返**；达限即收尾，把剩余项列成清单广播移交组织者重划界，不得无限续命。')
  L.push('- 增量指引：收到唤醒/追加消息时**只处理增量指令，不重做已确认的部分**（原任务已在会话历史里）。')
  L.push('')
  // v3 §8.1：等待态退出码表
  L.push('### 等待态退出码表')
  L.push('')
  L.push('在等待/收尾态自报一个码；广播正文可自报码值，组织者巡检按码处置：')
  L.push('')
  L.push('| 码 | 含义 | 组织者处置 |')
  L.push('|---|---|---|')
  L.push('| 0 | 产出完整且已广播 | 正常回收验收 |')
  L.push('| 2 | 有产出但未广播 | 查文件后要求补广播，或直接验收 |')
  L.push('| 3 | 已广播但组织者未确认 | 进入验收 |')
  L.push('| 4 | 上游产物变更需重跑 | 按断点重派（带增量指引） |')
  L.push('| 5 | 依赖阻塞（提权/用户操作/凭据） | 挂待办，**不判死不重派** |')
  L.push('')

  // ── 八、DSH 工具映射 ────────────────────────────────────────────────────
  L.push('## 八、Claude Code → DSH 工具映射（人格细则里出现的工具按此执行）')
  L.push('')
  L.push('| 人格中提到的 | 在 DSH 里用 |')
  L.push('|---|---|')
  for (const [from, to] of TOOL_ADAPTATION) L.push(`| ${from} | ${to} |`)
  L.push('')
  L.push('> 若人格细则里提到上述之外的 Claude 专属工具，视作不可用：找 DSH 里最接近的能力替代，并在产出中说明替代方式。')
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
 * @returns {{questions:string[], warnings:string[]}}
 */
export function preflight({ role, task, route, modelVerified, modelWarning }) {
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
  // 副作用关键词：命中即提示 fail-closed 复核（读/分析类不拦）
  const sideEffect = /(git\s+push|npm\s+(i|install)|pnpm\s+(i|add)|pip\s+install|rm\s+-rf|del\s+\/|删除|发消息|发送|推送|部署|下单|写库|DROP\s+TABLE)/i.exec(text)
  if (sideEffect) {
    warnings.push(`任务文本命中副作用动作「${sideEffect[0]}」：写/外发/安装类判定不了就不做（fail-closed），派活前请确认目标会话确实有该权限与授权。`)
  }
  return { questions, warnings }
}
