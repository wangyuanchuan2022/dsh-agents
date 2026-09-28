---
name: consensus-plan
description: "触发：规划方案、方案评审、出个计划、重大方案先评审、架构方案讨论、计划要评审｜English: plan review, design review, consensus plan, architecture decision｜共识规划技能：规划与执行严格分离——前置门拦截欠规格的执行请求转规划；Planner 产出固定快照计划（RALPLAN-DR 结构：原则 3-5 条/决策驱动 top3/可行方案 ≥2 及排除理由；高危 deliberate 预演 3 失败场景+扩展测试计划）；Architect 与 Critic 对同一快照串行独立评审（严格先后、互不可见对方输出、仅 Planner 合成修订、≤5 轮至 APPROVE）；计划全程 pending approval 不改源码不 commit 不 spawn 执行；轻任务同会话三帽分相，重任务 spawn architect/critic 子会话（可显式指定不同 provider）。触发：用户要求规划或评审重大方案，或执行请求过模糊（≤15 有效词且无具体锚点）被前置门拦截转规划。"
---

# 共识规划（consensus-plan）

## 规划/执行边界（先读）
本技能是规划模块。可以检查上下文、起草或更新 plan/spec/proposal 工件，但工件必须标 **pending approval**——除非用户在当前回合已显式选择执行、或经结构化批准 UI 批准。显式执行批准前**禁止**：跑变更类 shell 命令、改源文件、commit、push、开 PR、调执行技能、spawn 实现任务。

## 前置门：拦截欠规格的执行请求
执行模式（ralph/autopilot/team 类）在模糊请求上会浪费算力做范围发现，产出偏题的半成品。本门拦截并转规划，保证：显式范围（PRD）、可测验收（test spec）、三方共识、执行有界。

**过门（有任一具体信号即可直执行）：**
| 信号类型 | 例 | 为何过 |
|---|---|---|
| 文件路径 | `修 src/hooks/bridge.ts` | 指向具体文件 |
| issue/PR 号 | `实现 #42` | 具体工作项 |
| camelCase 符号 | `修 processKeywordDetector` | 指名具体函数 |
| PascalCase 符号 | `更新 UserModel` | 指名具体类 |
| snake_case 符号 | `修 user_model` | 指名具体标识符 |
| 测试命令 | `跑 npm test 并修失败` | 有显式测试目标 |
| 编号步骤 | `做：1.加X 2.测Y` | 结构化交付物 |
| 验收标准 | `加登录 - 验收标准：...` | 显式成功定义 |
| 错误引用 | `修 auth 里的 TypeError` | 具体错误 |
| 代码块 | `加：\`\`\`ts ... \`\`\`` | 给了具体代码 |
| 转义前缀 | `force: 修一下` / `! 修一下` | 用户显式越权 |

**被门拦（转规划）：**「修一下这个」「做个 app」「优化性能」「加个鉴权」——模糊动词、无锚点。

**门参数**：只拦 ≤15 有效词且无任何具体锚点的执行请求；更详细的请求不拦。

**端到端示例：**
1. 用户说「加用户鉴权」
2. 门检测：执行关键词 + 欠规格（无文件/函数/测试规格）
3. 转本技能并说明原因
4. 共识运行：Planner 立计划（动哪些文件、什么鉴权方式、什么测试）→ Architect 评审健全性 → Critic 验证质量与可测性
5. 共识通过后用户选执行路径（spawn 多会话并行 / goal 循环串行）
6. 带清晰有界的计划开始执行

**故障排查：**
| 问题 | 解法 |
|---|---|
| 门对规格良好的请求误触发 | 给请求加文件引用/函数名/issue 号作锚点 |
| 想绕过门 | 加 `force:` 或 `!` 前缀 |
| 模糊请求没触发门 | 门只拦 ≤15 有效词且无锚点的；加细节或显式点名本技能 |
| 转进规划了但想要执行 | 用结构化批准选项，或明说哪个执行技能继续；只说「就这样做/跳过规划」只会以 pending approval 工件结束规划 |

## RALPLAN-DR 计划结构（Planner 产出，评审前先给紧凑摘要）
1. **原则**（3-5 条）
2. **决策驱动**（top 3）
3. **可行方案**（≥2 个）+ 有界 pros/cons
4. 只剩一个可行方案时：写明其余方案的显式作废理由
5. **deliberate 模式追加**：pre-mortem（3 个失败场景）+ 扩展测试计划（单测/集成/端到端/可观测性）
 - 显式 `--deliberate` 强制开启；或请求含高危信号时自动开启：auth/安全、数据迁移、破坏性变更、生产事故、合规/PII、公共 API 破坏

## 评审循环（核心纪律）
1. **Planner** 立初始计划 + RALPLAN-DR 摘要，形成**固定快照**
2. （--interactive 时）AskUserQuestion 呈现草稿 + 原则/驱动/方案摘要：进入评审 / 要求修改 / 跳过评审。默认全自动进评审
3. **Architect 评审**：评架构健全性，必须给出**最强钢人反题**、至少一个真实权衡张力、可能时给综合。deliberate 模式下须显式标记原则违例。Architect 只评固定快照、不得改它；**Architect 输出不得传给 Critic**
4. **Critic 评审**：步骤 3 完成后才启动。独立评同一快照，**不得消费或收到 Architect 评审**。检查：原则-方案一致性、备选公平性、风险缓解清晰度、验收标准可测、验证步骤具体；deliberate 模式下缺/弱预演或测试计划即 REJECT。Critic 是独立单独等待的任务调用——**绝不并行**
5. **重审循环**（≤5 轮）：任何非 APPROVE（ITERATE/REJECT）都跑完整闭环：a. Planner 收集双方反馈（只有 Planner 在双方完成后合成）→ b. Planner 修订计划 → c. 回 Architect → d. 回 Critic → e. 循环至 APPROVE 或 5 轮 → f. 5 轮未过 → 取最优版本交用户
6. Critic 通过后计划标 **pending approval**（除非用户已显式批准执行）。最终计划必须含 ADR：决策/驱动/考虑过的备选/为何选它/后果/后续项
7. 用户选执行路径（多会话并行 → 任务书模板 v2；串行 → goal 循环），或要求修改，或否决

> **纪律**：步骤 3、4 严格串行；两个评审消费同一固定快照；Architect 输出不过 Critic；只在 Planner 合成时汇合。

## DSH 执行形态
- **轻任务**（单会话可承载）：同会话三帽严格分相——Planner 全文 → 切 Architect 帽评审 → 切 Critic 帽评审，三段在对话中显式分隔不混写
- **重任务/高危**：`de_session spawn` 两个评审子会话（**显式 provider+model**，评审类用强模型；可用不同 provider 增加视角多样性，即 OMC `--architect codex` 的对应物），任务书只附固定快照（Critic 任务书**不含** Architect 结论），报告落盘 `docs/plans/reviews/` + `de_broadcast(wake:true)` 回传，组织者只做合成
- 收尾：计划落盘 `docs/plans/<slug>.md`，标 pending approval + ADR（决策/驱动/备选/为何选它/后果/后续）

## 排障
| 症状 | 处置 |
|---|---|
| 三帽混写、互相污染 | 轻任务也要硬分相：Planner 写完停笔，Architect 段从头读快照，Critic 段只看快照 |
| Critic 抄 Architect 观点 | 违反盲评：重来，Critic 任务书剔除 Architect 内容 |
| 5 轮不收敛 | 取最优版交用户裁决，附分歧清单；不无限循环 |
| 计划被拿去直接执行 | 违反 pending approval 边界：停下，先补用户显式批准 |
