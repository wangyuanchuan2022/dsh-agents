---
name: agent-autopilot
description: "触发：自动实现整个项目、全自动做完、从想法到代码、帮我一条龙做出来、多阶段项目开发、端到端实现｜English: autopilot, build the whole project, end-to-end implementation, idea to code, full pipeline｜项目全流程自动实现（agent-autopilot，编排 dsh-agents 的 23 个 sub agent）：六阶段自动跑完「想法→验证过的代码」——Phase 0 扩写（explore 勘察现状 + analyst 需求转验收标准）、Phase 1 规划（planner 出 3-6 步计划，复杂边界加 architect）、Phase 2 执行（executor 逐任务派活，debugger 兜底，interactive 模式缺参数走 subagent-clarify）、Phase 3 QA（test-engineer 循环到测试全绿）、Phase 4 验证（code-reviewer + security-reviewer 并行评审 + verifier 新鲜证据核验）、Phase 5 收尾（git-master 提交 + 角色回收核对报告）；阶段间硬门（计划需用户批准、验证不过不进下一阶段），已存在的 requirement-interview spec 或 consensus-plan 计划可跳过对应前置阶段。触发：用户说「自动实现这个项目/autopilot/从想法到代码/全自动做完」，或需求已清晰的多阶段项目开发。"
---

# 项目全流程自动实现（agent-autopilot）

> 编排对象：dsh-agents 插件的 23 个 sub agent（工具：`agent_roles` / `agent_taskbook` / `agent_spawn`）。

## 派活方式（主路径 / 降级路径）
- **主路径**：dsh-agents 插件已装（存在 `agent_spawn` 工具）→ `agent_spawn(role=<角色>, task=<任务>, evidencePath=<可选>)`。插件会自动：钉档位模型、注入人格、合成八节任务书（含交付验收与硬性完成标准双条件）、生成产出路径 `agent-out/<角色id>-<时间戳>.md`。
- **⚠️ 工作区纪律（2026-09-12 用户规则，长期生效）**：子会话一律派在**用户派发任务的工作区**——不传 `cwd`（缺省继承组织者会话的工作区）；确需在任务书里引用项目子目录时，用相对本工作区的前缀（如 `merge-watermelon\docs\plans\x.md`）表达，不要把子会话 cwd 指进子目录。禁止把 cwd 指到工作区之外。
- **降级路径**（无 agent_spawn 工具）：读 `dsh-agents 仓根\personas\<角色>.md` 人格全文 + 按 dsh-agents README 第 5 节手写八节任务书 → `de_session spawn`（**显式 provider+model**，档位表以 `agent_roles action=tiers` 实时读到的为准；同样不传 cwd，继承组织者工作区）。
- 派活前过 `agent_taskbook`（或人工三问）：这事该这个角色做吗 / 它有工具数据吗 / 是不是要它做做不到的副作用。
- **需求原文直读门（硬门，先于三问）**：任务书需求段必须逐字取自原始需求材料（read 原文后粘贴）——禁止凭任务名/摘要/记忆转写臆造需求；评测型任务取 instruction 类原文直读。实证：2026-09-30 fastapi 首次 spawn 凭任务名臆造需求，10 分钟后才发现返工。臆造需求=派活事故，此门不过=不派活（口径正本：docs/task-brief-v3.md §1c）。
- 报告路径防撞车：同一流水线多 executor 并行时，任务书里显式给 evidencePath 并带步骤后缀（如 `agent-out\executor-step4-report.md`）。
- **档位路由输出两字段**：降级路径手动选档或任何非标派活时，任务书角色档位行必须补记两字段——**置信度**（高/中/低 + 一句理由）与**失败回退档**（首选失败时降到哪档/升到哪席）。主路径 agent_spawn 的任务书由插件合成，两字段由组织者校对时补记；任务书模板层固定两列由任务书批次另行处置（该文件不归本批所有权）

## 选角触发表（主动选角，无需用户点名）
> 来源：ECC 上游 AGENTS.md「Agent Orchestration」节 9 条触发规则（github.com/affaan-m/everything-claude-code）按 DSH 语境映射。单一事实源纪律：新增/调整席一律改 squad「评审面复用路由表」，本表只引用已注册席 id（roles.js 23 席），不自造席；ECC 无对应席的规则如实标注映射落点，不硬凑。

| # | 触发特征 | DSH 角色（id） | 备注 |
|---|---|---|---|
| 1 | 复杂特性请求 | `planner` | HIGH；Phase 1 常规派活 |
| 2 | 刚写完/改完代码 | `code-reviewer` | HIGH 只读；Phase 4 必派（>20 文件或架构级改动硬触发） |
| 3 | 缺陷修复 或 新特性（ECC→tdd-guide） | `debugger` ＋ `test-engineer` | DSH 无 tdd-guide 席，拆两席：修复→debugger（MEDIUM，Phase 2 兜底）；测试先行→test-engineer（MEDIUM，Phase 3，引用 tdd-workflow 技能） |
| 4 | 架构决策 | `architect` | HIGH 只读；Phase 1 复杂边界加派评审 |
| 5 | 安全敏感代码 | `security-reviewer` | HIGH 只读；触发判据按 squad F-3 路径/文件类型优先（auth/**、*secret*、*.sql、中间件/路由文件、crypto import），通用词表仅补充信号 |
| 6 | brownfield 项目接手（老库规格提取） | `spec-miner` | HIGH 只读（新席 2026-09-29）；产出 specs/<capability>/spec.md + id 锚纪律 |
| 7 | 自主循环/循环监控（ECC→loop-operator） | 组织者引 `agent-loop` 技能自任 | DSH 无 loop-operator 席，不自造；循环内卡死诊断升级 `tracer`（MEDIUM） |
| 8 | harness 配置可靠性与成本 | `harness-optimizer` | HIGH（新席 2026-09-29）；读写限插件/技能/预设面 |
| 9 | RAG/检索管线改动 | `rag-reviewer` | HIGH 只读（新席 2026-09-29）；与 scientist 边界：检索配置与评估覆盖归 rag-reviewer，统计推断归 scientist |

**补充条目（DSH 侧，源=squad 路由表、非 ECC 9 条）**：静默失败嫌疑（测试绿了但功能漏跑）→ `silent-failure-hunter`（MEDIUM 只读，新席 2026-09-29；「沉默即通过」专项，可作第 5 席并行盲评）。

## 回收与监控（全程）
- 每个角色会话的硬性完成标准双条件：**报告落盘 agent-out/ + de_broadcast(wake:true) 回组织者**，缺一即未完成。
- 组织者用 `de_session action=status/list` 做角色回收核对；长任务配心跳闹钟（pwsh 后台 sleep 300-360s）兜底。
- **巡检判产出真伪**：心跳巡检验证「这份产出是不是真产出」按序执行——**⓪ 先双查推进信号**：`git status --porcelain`（工作树）+ `git log --oneline -5`（新 commit）任一有增量即席次在推进（分块提交的席工作树可能干净——**commit 也是产出**，只看产物文件会误判零改动；实证：2026-09-30 C2-executor 分块 commit 被三轮误判零改动）；① 拒不可读/空/纯空白/仅标题-元数据-分隔符-占位符（如「[此处填产出]」「- [ ]」）的文件；② 拒只有单任务且无实质结构内容的摘要回声；③ 有实质内容（已完成工作/进行中/具体下一步/具体路径/多任务）才入候选；④ 候选内取最新 mtime，同 mtime 依次比更饱满 → 更多非占位内容 → 更大字节 → 路径字典序
- **侧问插话纪律**：会话工作途中被组织者/用户插话提问时——先冻结任务态（记下正在做什么/下一步是什么）→ 直接作答（先答后理，短而完整）→ 显式宣告回到任务（「— 回到任务：<一句话>」）；插话期间禁写任何文件
- 派活错峰约 15 秒（并发≤3 作用于开启瞬间）。
- 角色会话死亡（无广播且状态非 running）：按其产出断点补派；重试上限 2 次，超限如实上报。

## 阶段门（硬规则）
每阶段完成才进下一阶段（唯一例外：Phase 3 与 Phase 4 的双评审按 A2 基线哈希门并行，见下）；阶段产物落盘；**Phase 1 的计划必须经用户批准**才能进 Phase 2。
本流水线是**门控的，不是自主的**：
1. **GATE 1 — 计划批准后**（即上句 Phase 1 门，既有条款）。
2. **GATE 2 — 收尾提交前**：git-master 产出提交清单（diff 摘要 + 拟用提交信息）呈用户确认后，才执行收尾提交与 push。本机既有纪律：中途分块检查点 commit 免逐次确认（用户已批准的工作模式）；GATE 2 作用于**收尾提交与 push**（push 本就属需用户批准的操作）。
两门之间全速流动不停。

## Step 0 · 尺寸分级

| 档 | 信号（文件数 / 新依赖或契约 / 设计含糊度） | 相位掩码（哪些阶段跑） |
|---|---|---|
| trivial | 1 文件几行 / 无新依赖 / 一眼显然 | Phase 0 跳过（组织者一行任务书直达）→ Phase 2 单 executor → Phase 3 单测 → Phase 4 verifier 取证（评审可单席）→ Phase 5 |
| small | 1 文件 1 函数 / 无 / 读码即清晰 | Phase 0 轻量（跳过 explore，验收标准并入任务书）→ 全 Phase，评审单席 |
| standard | 2-5 文件 / 可能新增内部模块 / 一个真实取舍 | 全六阶段标准跑 |
| large | 跨切面 / 新外部依赖·公共 API·需 spec 文档 / 多个开放问题 | 全六阶段 + architect 评审计划 + 评估拆批 |

- 三信号取**最高档**；**tie-breaker：触碰安全面或公共 API/契约 ⇒ 至少 standard**（security-reviewer 必派），与文件数无关
- 分级结果一行陈述写进任务书（可审计；用户可覆盖）
- Intake 语义恒跑：分级本身就是 Intake，不因 trivial 而省略

---

## Phase 0 · 扩写（现状 + 需求）
- **跳过条件**：已存在 requirement-interview 的 spec（`docs/specs/`）→ 直接当 Phase 0 产物；已存在 consensus-plan 计划（`docs/plans/`）→ 连 Phase 1 都跳过，直接进 Phase 2。
- 派 `explore`（LOW，只读）：勘察项目现状——结构、技术栈、相关模块、可复用部件，落盘勘察报告。
- 派 `analyst`（HIGH，只读）：把需求转成可实施的验收标准（每条可测试），标出需求缺口；缺口大的回 ask_user_question 补齐。
- **计划前固定检索面 8+5**：8 类检索——①相似实现 ②命名约定 ③错误处理 ④日志模式 ⑤类型定义 ⑥测试模式 ⑦配置 ⑧依赖；5 条追踪——①入口点 ②数据流 ③状态变更 ④契约 ⑤架构模式。产出统一发现表（Category | File:Lines | Pattern | Key Snippet）；任一类确认不适用时在报告里显式声明 N/A 及原因，不得静默缺类
- 产物：`docs/specs/autopilot-<slug>.md`（目标/范围/非目标/验收标准清单）。

## Phase 1 · 规划
- 派 `planner`（HIGH）：把 spec 转成 3-6 步工作计划，每步带：涉及文件、完成判据、依赖关系。
- 复杂边界系统加派 `architect`（HIGH，只读）评审计划：每条结论带 文件:行号。
- **门：计划呈用户批准**（ask_user_question：批准并开始执行 / 要求修改）。不批准不写码。

## Phase 2 · 执行
- 按计划逐任务派 `executor`（MEDIUM）：任务书带该步的文件范围与完成判据；最小可行 diff。
- 独立任务可并行派多个 executor（错峰 15s）；文件冲突任务串行。
- 每步完成后：
 - **formatter check**：跑本语言 formatter check——standard 档默认（只报告不阻断）；strict 档须用户显式声明，**非零退出码即阻断**（ECC 的 quality-gate 非 strict 时格式化失败只写日志、既不改变退出码也不阻断＝空门教训，对照 ECC 上游 `scripts/hooks/quality-gate.js`）。扩展名映射：`.ts/.tsx/.js/.jsx`→prettier；`.py`→ruff format 或 black；`.go`→gofmt；`.rs`→rustfmt；`.cs`→dotnet format；`.cpp/.cc/.h/.hpp`→clang-format；`.kt`→ktlint
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
- **对基线的 delta 块**：
 ```
 CHECKPOINT DELTA: <slug>
 Files changed: X
 Tests: +Y passed / -Z failed
 Coverage: +X% / -Y%（基线有覆盖率数据时）
 Build: [PASS/FAIL]
 ```
 对照 Phase 3 基线哈希门的备案产出计算；verifier 的增量复验引用同一 delta 口径

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
