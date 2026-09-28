---
name: agent-feature
description: "触发：加个功能、实现一个功能、新增特性、给项目加 X、做个小需求、feature 流水线｜English: add a feature, implement X, new feature pipeline, feature development｜特性开发流水线（agent-feature，编排 dsh-agents 的 6 个 sub agent）：analyst 把特性需求转成可测验收标准 → planner 出带完成判据的分步计划 → executor 按步实现（最小 diff）→ test-engineer 补测试并跑绿 → code-reviewer 分级评审 → verifier 取证收尾；对应 OMC team 的 team-plan/team-prd/team-exec/team-verify 四阶段。适用于：给现有项目加一个明确的新特性（需求基本清晰，不需要完整 autopilot）。触发：用户说「加个特性/实现 X 功能/feature 流水线」，且能指名目标项目与特性描述。"
---

# 特性开发流水线（agent-feature）

> 编排 6 角色：analyst → planner → executor → test-engineer → code-reviewer → verifier。
> 派活方式、回收监控、失败处理与 `agent-autopilot` 完全一致（主路径 agent_spawn / 降级 de_session+personas；错峰 15s；双条件完成标准；回收核对）。本技能不重复，只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。

## Step 0 · 尺寸分级

| 档 | 信号 | 相位掩码（对应下方执行顺序步骤号） |
|---|---|---|
| trivial | 1 文件几行 / 无新依赖 / 一眼显然 | 跳过 1-2（组织者把验收标准写进任务书）→ 3 → 4 → 6；评审单席 |
| small | 1 文件 1 函数 / 无 / 读码即清晰 | 1 轻量 → 2 一步计划 → 3 → 4 → 5 单席 → 6 |
| standard | 2-5 文件 / 可能新增内部模块 / 一个真实取舍 | 全 6 步标准跑 |
| large | 跨切面 / 新外部依赖·公共 API / 多个开放问题 | 全 6 步 + planner 加 architect 交叉评审 + 评估拆批 |

- **tie-breaker：触碰安全面或公共 API/契约 ⇒ 至少 standard**（security-reviewer 并行双评必派），与文件数无关

## 执行顺序

### 1. analyst（HIGH，只读）——需求转验收
- 输入：用户的特性描述 + 目标项目现状（可先让主会话快速 glob/read 一眼，或派 explore 补勘察）
- **计划前固定检索面 8+5**：8 类检索（相似实现/命名约定/错误处理/日志模式/类型定义/测试模式/配置/依赖）+ 5 条追踪（入口点/数据流/状态变更/契约/架构模式），产出统一发现表；不适用项显式声明 N/A 及原因
- 输出：验收标准清单（每条可测试）+ 边界与非目标 + 需求缺口提问
- 缺口大 → 组织者 ask_user_question 补齐后再继续

### 2. planner（HIGH）——分步计划
- 输入：验收标准清单
- 输出：3-6 步计划，每步带涉及文件与完成判据；标注哪些步可并行
- **门：计划呈用户批准**（轻特性可并入第 1 步产出一次批）

### 3. executor（MEDIUM）——逐步实现
- 每步一个任务书：文件范围 + 完成判据 + 最小 diff 纪律
- **每步收尾跑 formatter check**：standard 档默认只报告不阻断；strict 档须用户显式声明且非零退出码即阻断；扩展名映射表见 agent-autopilot Phase 2
- 可并行的步错峰派多个 executor；碰同一文件的步串行

### 4. test-engineer（MEDIUM）——测试锁行为
- 为新特性补单元/集成测试；全量测试跑绿
- 不绿回步骤 3 定向修（循环 ≤2 轮）

### 5. code-reviewer（HIGH，只读）——分级评审
- 对特性全部 diff 出 P0/P1/P2 + 文件:行号 + 【改进点】
- 涉及安全面（输入/鉴权/密钥）→ 升级为与 security-reviewer 并行双评

### 6. verifier（MEDIUM，只读）——取证收尾
- 对照第 1 步验收标准逐条取证：新鲜测试输出 + 实际运行证据
- 全过 → 交付报告；有未证项 → 如实标注，不宣布完成

## 与 agent-autopilot 的关系
- 特性需求**不清晰**（只有模糊想法）→ 先走 requirement-interview 或直接用 agent-autopilot（其 Phase 0 会补扩写）
- 特性**清晰**、规模中等 → 本技能（少两个阶段，更快）

## 触发方式
- 「加个特性：X」「实现 X 功能」「走 feature 流水线」
- 判据：能指名目标项目 + 一句话说清特性 = 需求基本清晰

## 投递纪律（全局，2026-09-19 用户钉死）

- 子会话/评审员的完成与状态汇报一律**点对点直投**组织者会话 ID（任务书必须预写 ORG 会话 ID）；
- **严禁群发**：禁用 `project:` 伪接收者与多收件人广播——该形态会唤醒目录下全部 idle 会话，消耗各会话唤醒预算；
- **每条消息只允许唤醒一个会话**；有 ORG ID 时一律直投，仅在 ID 确实不可得时降级为其他形态，且降级须在汇报中注明；
- 需多方知晓的信息由组织者逐会话转发或汇总说明，执行会话不得代发。
