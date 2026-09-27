---
name: agent-workflow-router
description: "触发：不知道用哪个流程、有哪些工作流、怎么派活、组队做、一键跑完、多角色协作、agent 工作流怎么起、帮我选个流程、这活该谁干、从哪开始｜English: which workflow, workflow router, route to agent pipeline, how to start, pick a skill｜route to agent pipeline, workflow router, pick a skill, how to start. 本技能是 22 件 Agent 工作流技能的路由入口层：按用户意图把请求接到对应技能（全自动实现→agent-autopilot／加功能→agent-feature／修 bug→agent-bugfix／评审→agent-review-squad／需求模糊→requirement-interview／重大方案→consensus-plan／清理→ai-slop-cleaner／长任务循环→agent-loop／收尾核验→verification-loop／交接→session-handoff 等），并固化派活前置三问、档位现场确认、消息纪律、工作区纪律与收尾沉淀五条硬协议。用户没点技能名而描述了任务时，先加载本技能选路，再加载目标技能执行。"
---

# Agent 工作流总入口（agent-workflow-router）

> 一句话：用户说人话，本技能负责把它接到对的那条流水线/技能上，并把派活协议走完。

## 0. 何时用（何时跳过）

- 用户描述了「想做点什么」但**没点技能名** → 先在本技能选路（§1 意图表），再用 `skill` 加载目标技能。
- 用户**直接点了技能名**（「用 autopilot」「跑一下 review-squad」）→ 跳过本技能，直接加载目标技能。
- 用户问「有哪些工作流 / 你们怎么协作」→ 读 §1 + §2 给出路由表与前置门说明。

## 1. 意图 → 技能路由表（第一跳）

| 用户意图（典型提法） | 加载技能 | 备注 |
|---|---|---|
| 全自动把项目做出来 / 从想法到代码 / 一条龙 | `agent-autopilot` | 六阶段硬门；需求模糊先补 requirement-interview |
| 给现有项目加个功能 / 实现 X / 新增特性 | `agent-feature` | 需求基本清晰时用 |
| 修这个 bug / 报错了 / 构建挂了 / 行为不对 | `agent-bugfix` | 需错误现象；疑难自动升级 tracer |
| 评审这些改动 / 合并前检查 / 找人挑毛病 | `agent-review-squad` | 只读盲评 + critic 裁决 |
| 需求还很模糊 / 别假设 / 帮我问清楚 | `requirement-interview` | 含糊度门控，未达阈值不许动代码 |
| 重大方案要先规划/评审 / 出个计划 | `consensus-plan` | planner 快照 + architect/critic 串行盲评 |
| 代码太臃肿 / 去 slop / 清理重复 | `ai-slop-cleaner` | 先锁行为再清理 |
| 长任务 / 多轮迭代 / 心跳巡检 / 循环卡死 | `agent-loop` | 三合一（机制/判断/模式） |
| 测试先行 / 补测试 / 覆盖率核验 | `tdd-workflow` | RED 门不可让渡 |
| 交付前核验 / 六相验证 / 完工检查 | `verification-loop` | 固定 VERIFICATION REPORT |
| 要更快 / 并行跑 / 多 agent 并发 | `parallel-execution-optimizer` | lane 矩阵 + 写面隔离 |
| UI 还原度 / 截图比对 / 视觉保真 | `visual-verdict` | JSON verdict，score≥90 才收工 |
| 会话要满了 / 换会话继续 / 跨天收工 | `session-handoff` | 八节交接文档 |
| 发布前把关 / 脱敏 / 推送前扫描 | `opensource-sanitize`（配 `tools/publish-scan.mjs` 单仓放行门） | critical=0 才放行 |
| 子会话缺参数 / 澄清协议 | `subagent-clarify` | interactive 模式默认走它 |
| DSH 本身出问题（假死/权限/乱码/无输出） | `dsh-troubleshooting` | 症状索引，增量维护 |
| Git 分支/提交/rebase 决策 | `git-workflow` | 含本机「push 需用户批准」口径 |
| 错误处理/重试/熔断设计 | `error-handling` | TS/Python/Go 三语言 |
| 外发消息给外部对象 | `operator-approval-loop` | 草稿哈希 + epoch 审批账 |
| Agent 工具面/动作空间设计 | `agent-harness-construction` | observation 格式与完成率 |
| 想把经验沉淀成技能 | `skill-eval` | `skill_manage create` 前置闸 |
| 盘点技能库质量 | `skill-stocktake` | 五态裁决 |

## 2. 前置门（第二跳：先补条件，再派活）

- **需求含糊**（只有模糊动词、无验收判据、无具体锚点）→ 先 `requirement-interview`；含糊度 ≤ 阈值且用户明确批准执行路径前，不许改代码。
- **方案重大/不可逆**（动公共 API、改数据 schema、删文件、上线、发布）→ 先 `consensus-plan`，用户批准后才执行。
- **长任务/多轮**（预计跨多回合或 spawn 多席）→ 先用 `agent-loop` 定停止条件：`max-runs` / `max-cost` / `max-duration` / `completion-signal` **至少其一**，否则不许启动。
- **对外发消息** → `operator-approval-loop`（人工批准每一封）。
- **上下文将满** → 先 `session-handoff` 落交接，再继续干活。

## 3. 派活协议（硬约束，每次派活都过一遍）

1. **派活前置三问**：这活哪个会话能做？它有对应工具与数据吗？是否要它做它做不到的副作用（写库/删数据/外发消息/装依赖）？任一不过 → 不派或改写任务。
2. **档位现场确认**：先跑 `agent_roles action=tiers` 读**当次**解析结果（LOW/MEDIUM/HIGH → 实际 provider/model）；**禁止越档**显式指定 provider+model。
3. **任务书预审或直接派**：`agent_taskbook(role=…, task=…)` 审稿 → `agent_spawn(role=…, task=…, evidencePath=…)` 派活（插件自动合成八节任务书）。报告类任务**必须显式传 evidencePath**。
4. **任务书必含四条**：① 硬性完成标准双条件（**写盘落盘 + 点对点 `de_broadcast` 回报**，缺一即未完成）② 增量落盘要求（先骨架后分段追加）③ 「**完成标准未满足前不要停止工作回合**」条款 ④ **组织者会话 ID 预写**（免子会话猜）。
5. **消息纪律**：完成/状态汇报一律**点对点直投组织者**；禁 `project:` 伪接收者与多收件人发送；一次只唤醒一个会话。
6. **工作区纪律**：子会话**不传 cwd**（继承组织者工作区）；项目子目录用相对前缀表达，禁止指到工作区之外。
7. **回收核对**：`de_session action=status/list` 逐席核对；**完成广播只证送达不证开工** → 双查 running + 磁盘增量；假 idle（零产出转 idle）处置=补发含硬条款的开工指令 + 再次确认 running（先例已固化）。

## 4. 收尾与沉淀（第三跳）

- **交付前**：`verification-loop`（六相命令矩阵）或按任务类型用 `visual-verdict`（视觉）/ 真实输入全量跑（机检类）。
- **长任务收尾**：`agent-loop` 退出码语义（2=熔断 / 1=未完成 / 0=完成）+ 清理残留心跳与后台任务。
- **跨会话**：`session-handoff` 写八节交接（What Did NOT Work 必填）。
- **经验沉淀**：`skill-eval` 四态裁决（Save/Improve/Absorb/Drop）后再 `skill_manage create`。
- **发布/外发**：`opensource-sanitize` 放行门（critical=0）+ `operator-approval-loop` 审批。

## 5. 组合范式（多技能串联）

| 场景 | 串联链 |
|---|---|
| 新项目 | router →（requirement-interview）→ agent-autopilot → verification-loop →（session-handoff） |
| 加功能 | router → agent-feature →（agent-review-squad）→ verification-loop |
| 修 bug | router → agent-bugfix →（tdd-workflow）→ verification-loop |
| 大重构 | router → ai-slop-cleaner → tdd-workflow → verification-loop |
| 长跑实验 | router → agent-loop（+ parallel-execution-optimizer）→ verification-loop |
| 发布 | router → opensource-sanitize →（operator-approval-loop） |
| 交接班 | router → session-handoff →（接手会话读交接继续） |

## 6. 不做的事

- **不在本技能里执行任务本身**——只选路 + 走协议，执行归目标技能。
- **不跳硬门**：计划未批准不进执行、验证不过不进下一阶段、越档不做、含糊度未达标不动代码。
- **不假设**：缺信息按 `subagent-clarify` 协议问组织者/用户；不编造参数、不擅自终止。
- **不重复造轮子**：目标技能已覆盖的流程细节不在本技能复述；本技能只保留路由与协议。

## 7. 自检（路由后回看一遍）

- [ ] 选中的技能是否与用户**真实意图**同层（要「做完」≠ 要「评审」，要「评审」≠ 要「重写」）？
- [ ] 前置门是否都过了（含糊度/批准/停止条件/上下文余量）？
- [ ] 任务书四条硬条款是否写全（双条件/增量落盘/不停回合/ORG ID）？
- [ ] 档位是否**现场确认**过、有无越档？
- [ ] 收尾三件是否安排（核验/交接/沉淀）？
