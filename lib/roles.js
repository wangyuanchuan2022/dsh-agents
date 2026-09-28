/**
 * dsh-agents 角色注册表——19 个专职角色（移植自 oh-my-claudecode，MIT）。
 *
 * 本文件只放**元数据**（id/泳道/档位/权限边界/官方描述），不放人格正文：
 * 人格正文在 personas/<id>.md（经用户批准后写入），缺失时角色会话退化为
 * 只用元数据描述（任务书里明确标注「人格文件未安装」）。
 *
 * 档位（tier）三档，与 OMC 的 Claude 家族名一一对应：
 *   LOW ← haiku / MEDIUM ← sonnet / HIGH ← opus
 * 档位到 provider+model 的实际映射见 routing.js（可在 cordis.patch.yml 改）。
 *
 * 上游来源：oh-my-claudecode 的 agents/ 目录（MIT；对照底本为本地过程物，不随仓库分发）
 */

/**
 * 上下文隔离模式（派发评审/验证类角色时的硬约束）。
 *
 * - `blind`：并行盲评席——不得获得 ①作者自评/理由 ②**其他席位**的产出与结论。
 * - `isolated`：独立评审/验证席——不得获得作者自评/理由（可获得被评审对象的客观材料）。
 * - `shared`：不适用（实现/协作类角色可共享上下文）。
 *
 * **两层隔离缺一不可**：会话层由 `agent_spawn` 保证（每次派活都是全新 DSH 会话，
 * 不继承调用方对话历史）；材料层由本表 + 任务书的「上下文隔离契约」约束
 * （任务书里到底给了什么）。只有会话层干净、材料层泄漏作者结论，仍是假盲评。
 */
export const BLIND_ROLES = ['code-reviewer', 'security-reviewer']
export const ISOLATED_ROLES = ['critic', 'code-simplifier', 'verifier']

/**
 * 取角色的隔离模式（接受角色对象或 id；未知 id 视作 shared）。
 * @param {object|string} role
 * @returns {'blind'|'isolated'|'shared'}
 */
export function isolationOf(role) {
  const id = typeof role === 'string' ? String(role).trim().toLowerCase() : role?.id
  if (BLIND_ROLES.includes(id)) return 'blind'
  if (ISOLATED_ROLES.includes(id)) return 'isolated'
  return 'shared'
}

/** 泳道：build=构建与分析，review=评审与质量闸门，domain=领域专家。 */
export const LANES = {
  build: '构建与分析（搜索/需求/规划/架构/调试/实现/验证/溯源）',
  review: '评审与质量闸门（代码审查/简化/安全/批判）',
  domain: '领域专家（测试/设计/文档/QA/提交/资料/数据）',
}

/** 档位的规范名与别名（别名对齐 OMC 的 Claude 家族名，便于互认）。 */
export const TIER_ALIASES = {
  low: 'LOW', medium: 'MEDIUM', high: 'HIGH',
  haiku: 'LOW', sonnet: 'MEDIUM', opus: 'HIGH',
}

/** 规范档位顺序（由弱到强）。 */
export const TIERS = ['LOW', 'MEDIUM', 'HIGH']

/**
 * 19 个角色定义。`description` 为 OMC 原文（逐字），`readonly` 表示该角色
 * 在 OMC 中被禁写（disallowedTools: Write, Edit）——DSH 侧对应「只读顾问」，
 * 由任务书用文字约束（DSH 无法按会话禁工具，见 README「已知限制」）。
 */
export const ROLES = [
  // ── build lane ───────────────────────────────────────────────────────────
  {
    id: 'explore', name: 'Explore', lane: 'build', tier: 'LOW', omcModel: 'haiku', level: 3, readonly: true,
    description: 'Codebase search specialist for finding files and code patterns',
    mission: '回答「X 在哪」「哪些文件含 Y」「Z 怎么连到 W」，给出可直接使用的定位结果',
  },
  {
    id: 'analyst', name: 'Analyst', lane: 'build', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,
    description: 'Pre-planning consultant for requirements analysis',
    mission: '把已定产品范围转成可实施的验收标准，在规划开始前抓出需求缺口',
  },
  {
    id: 'planner', name: 'Planner', lane: 'build', tier: 'HIGH', omcModel: 'opus', level: 4, readonly: false,
    description: 'Strategic planning consultant with interview workflow',
    mission: '把「做 X」解释为「为 X 写工作计划」，产出 3-6 步、带验收标准的工作计划',
  },
  {
    id: 'architect', name: 'Architect', lane: 'build', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,
    description: 'Strategic Architecture & Debugging Advisor (READ-ONLY)',
    mission: '读代码后给出可执行的架构建议与根因诊断，每条结论可追溯到 文件:行号',
  },
  {
    id: 'debugger', name: 'Debugger', lane: 'build', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: false,
    description: 'Root-cause analysis, regression isolation, stack trace analysis, build/compilation error resolution',
    mission: '把缺陷追到根因并给最小修复；优先让红构建变绿而不是顺手重构',
  },
  {
    id: 'executor', name: 'Executor', lane: 'build', tier: 'MEDIUM', omcModel: 'sonnet', level: 2, readonly: false,
    description: 'Focused task executor for implementation work',
    mission: '严格按规格实现代码改动；最小可行 diff，不过度设计、不扩大范围',
  },
  {
    id: 'verifier', name: 'Verifier', lane: 'build', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: true,
    description: 'Verification strategy, evidence-based completion checks, test adequacy',
    mission: '要求完成声明有**新鲜证据**支撑；复现与取证，而不是信任「应该能跑」',
  },
  {
    id: 'tracer', name: 'Tracer', lane: 'build', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: false,
    description: 'Evidence-driven causal tracing with competing hypotheses, evidence for/against, uncertainty tracking, and next-probe recommendations',
    mission: '把观察与解释分开，保留竞争假设，按证据强度排序，并给出最能消减不确定性的下一步探测',
  },
  // ── review lane ──────────────────────────────────────────────────────────
  {
    id: 'code-reviewer', name: 'Code Reviewer', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,
    description: 'Code Reviewer v2（OCR 确定性工程融合版；OMC v1 已于 2026-09-24 弃用）：coverage-ledger 可核销评审——crgate freeze 冻结覆盖分母、覆盖账四态闭合、file:line 三级定位锚定（anchor --strict 机检门）、语言清单按需路由、历史审查现行性标注、裁定与覆盖状态双轨正交输出',
    mission: '分级（P0/P1/P2）代码审查：先冻结覆盖分母（crgate freeze），阶段1 规格符合性先行，再查安全/逻辑/错误处理/反模式/SOLID/性能；覆盖账闭合 + 每条发现带锚定证据，未锚定的 CRITICAL/HIGH 不得交付',
  },
  {
    id: 'security-reviewer', name: 'Security Reviewer', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,
    description: 'Security vulnerability detection specialist (OWASP Top 10, secrets, unsafe patterns)',
    mission: '按 严重度×可利用性×影响面 排序安全漏洞，先抓最危险的',
  },
  {
    id: 'critic', name: 'Critic', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: true,
    description: 'Work plan and code review expert — thorough, structured, multi-perspective (Opus)',
    mission: '最终质量闸门：不仅评审「有什么」，还要指出「缺什么」，误批的代价远高于误驳',
  },
  {
    id: 'code-simplifier', name: 'Code Simplifier', lane: 'review', tier: 'HIGH', omcModel: 'opus', level: 3, readonly: false,
    description: 'Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise.',
    mission: '在不改变行为的前提下简化代码：优先可读、显式的写法，不做过度紧凑的技巧化',
  },
  // ── domain lane ──────────────────────────────────────────────────────────
  {
    id: 'test-engineer', name: 'Test Engineer', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: false,
    description: 'Test strategy, integration/e2e coverage, flaky test hardening, TDD workflows',
    mission: '设计测试策略（金字塔 70/20/10）、写测试、加固抖动测试、守 TDD 纪律',
  },
  {
    id: 'designer', name: 'Designer', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 2, readonly: false,
    description: 'UI/UX Designer-Developer for stunning interfaces (Sonnet)',
    mission: '做用户记得住的界面：交互设计 + 框架惯用写法 + 视觉打磨（字体/配色/动效/布局）',
  },
  {
    id: 'writer', name: 'Writer', lane: 'domain', tier: 'LOW', omcModel: 'haiku', level: 2, readonly: false,
    description: 'Technical documentation writer for README, API docs, and comments (Haiku)',
    mission: '写开发者愿意读的技术文档；每个示例与命令都必须验证过',
  },
  {
    id: 'qa-tester', name: 'QA Tester', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: false,
    description: 'Interactive CLI testing specialist using tmux for session management',
    mission: '用真实运行的进程验证行为（而非只跑单测）：起服务、发命令、抓输出、对预期、清干净',
  },
  {
    id: 'git-master', name: 'Git Master', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: false,
    description: 'Git expert for atomic commits, rebasing, and history management with style detection',
    mission: '原子提交、风格匹配的提交信息、安全的历史操作与分支管理',
  },
  {
    id: 'document-specialist', name: 'Document Specialist', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 2, readonly: true,
    description: 'External Documentation & Reference Specialist',
    mission: '按「本地仓库文档 → 官方外部文档 → 其他来源」的可信度顺序找答案并给出可核验引用',
  },
  {
    id: 'scientist', name: 'Scientist', lane: 'domain', tier: 'MEDIUM', omcModel: 'sonnet', level: 3, readonly: true,
    description: 'Data analysis and research execution specialist',
    mission: '统计与假设检验：每个结论都有算出来的统计量，每个局限都被写明',
  },
]

/** 按 id 索引（构建期一次性，未知 id 返回 undefined）。 */
const INDEX = new Map(ROLES.map((role) => [role.id, role]))

/** 取单个角色定义。@param {string} id @returns {object|undefined} */
export function getRole(id) {
  return INDEX.get(String(id ?? '').trim().toLowerCase())
}

/** 全部角色 id（校验报错时列举用）。@returns {string[]} */
export function roleIds() {
  return ROLES.map((role) => role.id)
}

/** 规范化档位名（大小写不敏感，接受 haiku/sonnet/opus 别名）。 */
export function normalizeTier(raw) {
  const key = String(raw ?? '').trim().toLowerCase()
  return TIER_ALIASES[key] ?? null
}

/**
 * 按泳道/档位过滤角色（均不传 = 全部）。
 * @param {{lane?:string, tier?:string}} [filter]
 * @returns {object[]}
 */
export function filterRoles({ lane, tier } = {}) {
  const wantLane = lane === undefined || lane === '' ? null : String(lane).trim().toLowerCase()
  const wantTier = tier === undefined || tier === '' ? null : normalizeTier(tier)
  return ROLES.filter((role) => {
    if (wantLane !== null && role.lane !== wantLane) return false
    if (wantTier !== null && role.tier !== wantTier) return false
    return true
  })
}
