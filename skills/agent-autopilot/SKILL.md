---
name: agent-autopilot
description: 项目全流程自动实现（agent-autopilot，编排 dsh-agents 的 19 个 sub agent）：六阶段自动跑完「想法→验证过的代码」——Phase 0 扩写（explore 勘察现状 + analyst 需求转验收标准）、Phase 1 规划（planner 出 3-6 步计划，复杂边界加 architect）、Phase 2 执行（executor 逐任务派活，debugger 兜底，interactive 模式缺参数走 subagent-clarify）、Phase 3 QA（test-engineer 循环到测试全绿）、Phase 4 验证（code-reviewer + security-reviewer 并行评审 + verifier 新鲜证据核验）、Phase 5 收尾（git-master 提交 + 角色回收核对报告）；阶段间硬门（计划需用户批准、验证不过不进下一阶段），已存在的 requirement-interview spec 或 consensus-plan 计划可跳过对应前置阶段。触发：用户说「自动实现这个项目/autopilot/从想法到代码/全自动做完」，或需求已清晰的多阶段项目开发。
---

# 项目全流程自动实现（agent-autopilot）

> 编排对象：dsh-agents 插件的 19 个 sub agent（工具：`agent_roles` / `agent_taskbook` / `agent_spawn`）。
> 结构移植自 OMC autopilot 六阶段 + team 阶段路由表。

## 派活方式（主路径 / 降级路径）
- **主路径**：dsh-agents 插件已装（存在 `agent_spawn` 工具）→ `agent_spawn(role=<角色>, task=<任务>, evidencePath=<可选>)`。插件会自动：钉档位模型、注入人格、合成八节任务书（含交付验收与硬性完成标准双条件）、生成产出路径 `agent-out/<角色id>-<时间戳>.md`。
- **⚠️ 工作区纪律（2026-09-12 用户规则，长期生效）**：子会话一律派在**用户派发任务的工作区**——不传 `cwd`（缺省继承组织者会话的工作区）；确需在任务书里引用项目子目录时，用相对本工作区的前缀（如 `merge-watermelon\docs\plans\x.md`）表达，不要把子会话 cwd 指进子目录。禁止把 cwd 指到工作区之外。
- **降级路径**（无 agent_spawn 工具）：读 `D:\tools\deepsek_harness\dsh-agents\personas\<角色>.md` 人格全文 + 按 dsh-agents README 第 5 节手写八节任务书 → `de_session spawn`（**显式 provider+model**，档位表以 `agent_roles action=tiers` 实时读到的为准；同样不传 cwd，继承组织者工作区）。
- 派活前过 `agent_taskbook`（或人工三问）：这事该这个角色做吗 / 它有工具数据吗 / 是不是要它做做不到的副作用。
- 报告路径防撞车：同一流水线多 executor 并行时，任务书里显式给 evidencePath 并带步骤后缀（如 `agent-out\executor-step4-report.md`）。
- 派活前过 `agent_taskbook`（或人工三问）：这事该这个角色做吗 / 它有工具数据吗 / 是不是要它做做不到的副作用。

## 回收与监控（全程）
- 每个角色会话的硬性完成标准双条件：**报告落盘 agent-out/ + de_broadcast(wake:true) 回组织者**，缺一即未完成。
- 组织者用 `de_session action=status/list` 做角色回收核对；长任务配心跳闹钟（pwsh 后台 sleep 300-360s）兜底。
- 派活错峰约 15 秒（并发≤3 作用于开启瞬间）。
- 角色会话死亡（无广播且状态非 running）：按其产出断点补派；重试上限 2 次，超限如实上报。

## 阶段门（硬规则）
每阶段完成才进下一阶段（唯一例外：Phase 3 与 Phase 4 的双评审按 A2 基线哈希门并行，见下）；阶段产物落盘；**Phase 1 的计划必须经用户批准**才能进 Phase 2。

---

## Phase 0 · 扩写（现状 + 需求）
- **跳过条件**：已存在 requirement-interview 的 spec（`docs/specs/`）→ 直接当 Phase 0 产物；已存在 consensus-plan 计划（`docs/plans/`）→ 连 Phase 1 都跳过，直接进 Phase 2。
- 派 `explore`（LOW，只读）：勘察项目现状——结构、技术栈、相关模块、可复用部件，落盘勘察报告。
- 派 `analyst`（HIGH，只读）：把需求转成可实施的验收标准（每条可测试），标出需求缺口；缺口大的回 ask_user_question 补齐。
- 产物：`docs/specs/autopilot-<slug>.md`（目标/范围/非目标/验收标准清单）。

## Phase 1 · 规划
- 派 `planner`（HIGH）：把 spec 转成 3-6 步工作计划，每步带：涉及文件、完成判据、依赖关系。
- 复杂边界系统加派 `architect`（HIGH，只读）评审计划：每条结论带 文件:行号。
- **门：计划呈用户批准**（ask_user_question：批准并开始执行 / 要求修改）。不批准不写码。

## Phase 2 · 执行
- 按计划逐任务派 `executor`（MEDIUM）：任务书带该步的文件范围与完成判据；最小可行 diff。
- 独立任务可并行派多个 executor（错峰 15s）；文件冲突任务串行。
- 每步完成后：
  - 编译/类型错误 → 派 `debugger`（MEDIUM）追根因最小修复；
  - interactive 澄清模式：executor 缺参数 → subagent-clarify 协议（广播问组织者 → ask_user → 回传；超时按任务书缺省决策表降级并标注）。
- 每步过验收判据才勾掉（todo_write 同步真实进度）。

## Phase 3 · QA（基线锁定后与 Phase 4 双评审并行）
- **基线哈希门（A2，先于一切动工）**：`test-engineer` 开工前记录测试 run-all 输出与关键文件 SHA256 清单，落盘备案（如 `agent-out/autopilot-baseline-<slug>.md`）并 de_broadcast(wake:true) 广播组织者备案。
- 派 `test-engineer`（MEDIUM）：按测试金字塔补测试（单元为主）、跑全部测试。
- **并行编排**：基线锁定后，本阶段 `test-engineer` 与 Phase 4 的双评审（`code-reviewer` + `security-reviewer`，均只读）同时开工（错峰 15s）——双评审基于**同一基线**只读评审本次全部改动。
- QA 循环（仅 test-engineer 侧）：不绿 → 失败清单回 Phase 2 派 executor/debugger 修 → 重跑。循环上限 3 轮，仍不绿 → 停下如实上报，不带病进收尾。

## Phase 4 · 验证
- `code-reviewer`（HIGH，只读）+ `security-reviewer`（HIGH，只读）已按 Phase 3 的并行编排开工，基于基线哈希门锁定的**同一基线**只读评审：P0/P1/P2 分级 + 文件:行号 + 【改进点】。
- 涉及 auth/加密/输入处理 → security-reviewer 必派；>20 文件或架构级改动 → code-reviewer 必派。
- 修复轮完成后派 `verifier`（MEDIUM，只读）：对「完成」声明取证——凭备案基线做**增量对照复验**（新鲜测试输出、实际运行结果与基线的 delta），不信任「应该能跑」。
- P0 全清、P1 有处置方案、verifier 证据齐全 → 过门；否则回 Phase 2 定向修，修复后 verifier 再复验增量。

## Phase 5 · 收尾
- 派 `git-master`（MEDIUM）：分块提交建检查点（如 feat(core)/fix(x)），提交信息符合仓库惯例。
- 可选派 `writer`（LOW）：README/用法文档（每个示例命令必须验证过）。
- **角色回收核对报告**：对照全程派活记录逐角色核销（产出落盘？广播收到？验收过？），用 deliverable_verify 插件工具机检（可用时）。报告落盘 `agent-out/autopilot-summary-<时间戳>.md`。

## 触发方式
- 用户说：「自动实现这个项目」「autopilot」「从想法到代码」「全自动做完」
- 或：需求清晰的多阶段项目开发任务

## 失败与中止
- 任何阶段卡死（角色 2 次重派仍不达标）：停下、汇总已完成的与卡点，交用户裁决；不静默跳阶段。
- 用户说停：立即停，保留全部阶段产物与状态，汇报当前进度。

## 投递纪律（全局，2026-09-19 用户钉死）

- 子会话/评审员的完成与状态汇报一律**点对点直投**组织者会话 ID（任务书必须预写 ORG 会话 ID）；
- **严禁群发**：禁用 `project:` 伪接收者与多收件人广播——该形态会唤醒目录下全部 idle 会话，消耗各会话唤醒预算；
- **每条消息只允许唤醒一个会话**；有 ORG ID 时一律直投，仅在 ID 确实不可得时降级为其他形态，且降级须在汇报中注明；
- 需多方知晓的信息由组织者逐会话转发或汇总说明，执行会话不得代发。
