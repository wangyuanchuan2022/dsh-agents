# 流程优化审查 · C 向【运行时长与流程结构】

- 评审对象：agent-autopilot 首跑（merge-watermelon，2026-09-12）
- 评审人：architect（HIGH / deepseek-flash）· 只读分析
- 取证窗口：2026-09-12 19:30 – 24:00（组织者会话 + 16 个子会话转录 + agent-out 全部报告）
- 取证方法：`~/.dsh/sessions/--D-tools-deepsek_harness--/session-*/session.jsonl.zstd` 内存解压逐条解析（zstandard + JSONL，未落盘任何临时文件）；时间字段 `time` / `time0`（epoch ms）；步级时长取 `step/start → step/end`，工具时长取 `tool/call → tool/result`，生成时长取 `text-chunks`/`reasoning-chunks` 的 `dt` 累加。

---

## Summary（摘要）

首跑关键路径 240.3 分钟（19:47:39 → 23:47:57，与组织者记录的"约 19:30–23:50"一致，19:30–19:47 为组织者准备期）。**墙钟的 85% 是模型生成时间，本地工具执行只占 1.2%（9.0/720 分钟级汇总），流程编排侧可削的总量只有约 40 分钟**——这意味着"优化流程结构"的天花板远低于直觉，真正的量级杠杆在每步成本与步数（618 步 × 23.8s/步）。

三条可落地且不牺牲质量的结论：① 用户门前移并与 Phase 0/1 重叠（省 10–15 min）；② Phase 3 QA 与 Phase 4 双评审并行（评审只读，省 8–9 min）；③ writer 与 verifier 并行（省 8 min）。另外发现一个配置级事实：**档位表里 LOW 与 MEDIUM 指向同一模型（glm-pro/glm-5.3-flash）**，"档位"在当前配置下退化为 HIGH / 非 HIGH 二元，而占关键路径约 4/5 的非 HIGH 会话跑在实测吞吐低 3.7× 的模型上（890 vs 235 chars/s）——这是最大的单一杠杆，但属质量权衡，需 A/B 才能定，不在本次可下结论范围。

同时给出 7 条**不建议优化项**（含三条被直觉推荐但实测为负收益的：修复轮改增量验证、合并 test-engineer 与 verifier、砍心跳）。

---

## 一、时间结构：时间线表与帕累托排序

### 1.1 关键路径时间线（逐段，单位分钟）

| # | 段 | 起 | 止 | 墙钟 | 关键路径上的内容 | 空窗归类 |
|---|---|---|---|---|---|---|
| 1 | P0 勘察+需求 | 19:47:39 | 19:56:46 | 9.1 | explore spawn 19:47:39；analyst spawn 19:48:24（错峰 45s）；analyst 完成 19:56:27，explore 19:58:56 | 有效生成 |
| 2 | **用户门 #1** | 19:56:46 | 20:15:07 | **18.4** | `ask_user_question` 三问（g07_watermelon / g08_touch / defaults_batch） | **人类等待（全跑最大空窗）** |
| 3 | P1 规划+批准 | 20:15:07 | 20:19:39 | 4.5 | planner spawn 20:15:46，turn1 出计划 20:18:43；plan_approval 20:19:03（4.7s 即答复） | 有效生成 |
| 4 | P2 Step1 vendor | 20:19:39 | 20:26:14 | 6.6 | executor e938bcd0（6.8 min） | 有效生成 |
| 5 | P2 Step2 ∥ Step3 | 20:26:14 | 20:51:01 | 24.8 | d6815301（19.8 min）∥ 4a81796c（24.2 min），错峰 37s | 有效生成（**已并行**） |
| 6 | **P2 Step4 game/step** | 20:51:01 | 21:35:44 | **44.7** | d3041e82，59 步，含 3 次裁决往返（21:11:46 / 21:13:00 / 21:30:37） | 有效生成（**最大单项**） |
| 7 | P2 Step5 渲染输入 | 21:35:44 | 22:00:11 | 24.5 | 45e2123e，61 步 | 有效生成 |
| 8 | P2 Step6 收口验证 | 22:00:11 | 22:19:09 | 19.0 | d71ef338（21:59:50 spawn，与 Step5 尾段重叠 21s） | 有效生成 |
| 9 | P3 QA | 22:19:09 | 22:27:47 | 8.6 | test-engineer d3890c54，14 步，零发现（0/3 轮） | 有效生成 |
| 10 | P4 双评审 | 22:27:47 | 22:36:43 | 8.9 | code-reviewer 30b8a8d6（22:28:34–22:34:32）∥ security-reviewer 99895a85（22:29:18–22:36:43） | 有效生成（**已并行**） |
| 11 | **用户门 #2 + 合成** | 22:36:43 | 22:44:08 | 7.4 | 5.3 min 人类等待（q-combo-55 / q-btn-overlap）+ 2.1 min 组织者合成两份评审 | **人类等待** |
| 12 | **P4 修复轮** | 22:44:08 | 23:11:21 | **27.2** | 2b8bbf91，75 步，F1–F13 全修，519→567 断言 | 有效生成（**第二大**） |
| 13 | P4 verifier | 23:11:21 | 23:22:47 | 11.4 | 7ae20681，23 步，GO 阻塞 0 | 有效生成 |
| 14 | P5 writer | 23:22:47 | 23:31:35 | 8.8 | 06f220bc，README 92 行，6 命令亲手复跑 | 有效生成 |
| 15 | P5 git-master | 23:31:35 | 23:47:57 | 16.4 | 0358ce37，7 原子提交 34 文件，含 23:41:54 脱敏裁决往返 | 有效生成 |
| | **合计** | **19:47:39** | **23:47:57** | **240.3** | | |

### 1.2 帕累托排序（按墙钟占比）

| 排名 | 类别 | 分钟 | 占比 | 说明 |
|---|---|---|---|---|
| 1 | Phase 2 执行器（Step1–6） | 119.5 | **49.7%** | Step4 单项 44.7 = 18.6% |
| 2 | Phase 3+4 验证链 | 56.2 | **23.4%** | 修复轮 27.2 单项 = 11.3% |
| 3 | Phase 5 收尾 | 25.2 | 10.5% | git-master 16.4 最大 |
| 4 | 人类等待（两道用户门） | 23.7 | **9.8%** | 纯外部依赖 |
| 5 | Phase 0+1 | 13.7 | 5.7% | |
| 6 | 组织者回合与阶段衔接间隙 | ~2.1 | 0.9% | 实测每处交接 8–47s，最快 8s |

### 1.3 子会话时间构成（16 会话汇总 328.0 分钟，含并行重叠，用于拆解"时间去哪了"）

| 构成 | 分钟 | 占 328 min | 取证口径 |
|---|---|---|---|
| 模型推理（步时长 − 工具时长） | **236.5** | **72.1%** | Σ(`step/end`−`step/start`) − Σ 工具span |
| ├ 首 token 等待（TTFT） | 29.6 | 9.0% | Σ(`step/start` → 首块 chunk) |
| ├ 可见流式输出 | 108.1 | 33.0% | Σ `dt`（506,231 个 chunk） |
| └ 工具参数生成 + 步内收尾 | 98.8 | 30.1% | 残差 |
| 本地工具执行 | 9.0 | 2.7% | Σ(`tool/call`→`tool/result`)，212 次 pwsh 共 333.6s |
| 步间与空闲 | 82.5 | 25.2% | 其中 planner 空闲 77.0（**不在关键路径**，Phase 2 正在并行跑） |

> **口径警告**：98.8 分钟"工具参数生成"不是可疑残差——`text-chunks`/`reasoning-chunks` 只记录可见文本与推理块，**不含 write/edit 的工具参数载荷**。实测证据：test-engineer 可见生成仅 23,833 字符，而其报告 37,660 B（test-engineer-phase3-report.md）。所以这 98.8 min 是真实的模型输出时间（写文件、写报告的内容生成），只是没被 chunk 通道计数。这直接决定了一条反直觉结论：**"减少验证次数"省不到时间，因为每次验证的算力成本只有 2.4–2.9 秒**（见 §三）。

**帕累托结论：墙钟被模型生成时间主导（关键路径上约 204 min / 240 min ≈ 85%），编排层（并行、门、心跳、错峰、交接）可削总量只有约 40 分钟。** 任何以"精简流程环节"为名的优化，收益天花板都在 15% 量级；要动 50% 量级必须动"每步成本 × 步数"。

### 1.4 每步成本结构（三个样本会话的步级解剖）

| 会话 | 步数 | TTFT/步 | 流式/步 | 流式后/步 | 步间/步 | 步均总 |
|---|---|---|---|---|---|---|
| writer 06f220bc（P5，LOW） | 17 | 1.8s | 22.0s | 6.2s | 0.5s | 30.5s |
| executor Step4 d3041e82（P2，MEDIUM） | 59 | 2.3s | 34.1s | 7.6s | 0.4s | 45.0s |
| verifier 7ae20681（P4，MEDIUM） | 23 | 1.6s | 16.8s | 9.0s | 0.5s | 27.9s |

固定开销（TTFT + 流式后 + 步间）= 10.3s/步（Step4）。Step4 因此有 59 × 10.3s = **10.1 min（占其 44.7 min 的 22.6%）与输出量无关**；这才是"减少步数"的真实收益来源。

---

## 二、重复验证审计：全量电池被跑了几次

### 2.1 逐次列举（tool/pwsh 真实执行 + 聚合行 `ALL PASS (files=8 asserts=N)` 双证）

| # | 时刻 | 会话 | 角色 | 断言数 | 电池耗时 | 树状态 |
|---|---|---|---|---|---|---|
| 1 | 22:15:41→22:15:43 | d71ef338 | executor Step 6 | 519 | 2.4s | Step6 冻结（修复前基线） |
| 2 | 22:20:55→22:20:57 | d3890c54 | test-engineer P3 | 519 | 2.3s | 同上（未变） |
| 3 | 22:31:06→22:31:08 | 30b8a8d6 | code-reviewer | 519 | 2.4s | 同上（未变） |
| 4 | 23:06:18→23:06:20 | 2b8bbf91 | 修复轮 executor | 567 | 2.4s | 修复中期 |
| 5 | 23:08:01→23:08:04 | 2b8bbf91 | 修复轮 executor | 567 | 2.9s | 修复收尾 |
| 6 | 23:12:45→23:12:47 | 7ae20681 | verifier | 567 | 2.3s | 修复后冻结 |
| 7 | 23:27:02→23:27:05 | 06f220bc | writer | 567 | 2.4s | 修复后冻结 |

**共 7 次全量电池执行，合计算力约 17 秒。** 其中 567 断言版 4 次（修复轮 2 次 + verifier 1 次 + writer 1 次），519 断言版 3 次（Step6 / test-engineer / code-reviewer）。

**对组织者清单的三处修正**：
- ✅ "Step6 一次、test-engineer 一次、code-reviewer 一次、writer 一次、verifier 一次"——五次均确认，**但前三者是 519 断言版**（F1–F13 修复前的基线），不是 567。
- ➕ **修复轮跑了 2 次全量**（23:06:18 中期 + 23:08:01 收尾），清单漏计。
- ➖ **git-master 一次都没跑**。它在 23:42:04 的 pwsh 命令里出现 `run-all.mjs` 字样，但那是提交块脚本内的**路径清单**（同一命令输出为 `== BLOCK 1 chore(meta) ==` 的 git 提交日志），实测该会话 `asserts=567` 结果记录为 0 条。同理 code-reviewer 22:28:45 的 `run-all.mjs` 字样也是文件清单而非执行。

补充：另有 3 个会话（code-reviewer 22:30:23、test-engineer 22:20:14、fix-round 22:44:52 / 22:45:39、verifier 23:13:40、writer 23:29:57）出现聚合行文本，但来源是 `read` 工具读到的**上游报告引用**，不是二次执行——已按 tool 类型剔除。

### 2.2 "验证职责重叠"的必要性边界

| 环节 | 是否保留 | 判据（证据） |
|---|---|---|
| Step6 自跑 | ✅ 保留 | executor 的完成判据本体；本次它把 519 基线钉住，后续三次 519 复跑才有比对基准 |
| test-engineer 独立复跑 | ✅ 保留（但见建议 A2 并行化） | 独立复跑五步命令卡零读数偏差（test-engineer-phase3-report.md:692-693）——这是"同树不同会话，逐位一致"的**确定性证据**，只有换个会话跑才成立 |
| code-reviewer 跑电池 | ⚠️ 可降级为只读证据 | 评审的产出是 P0/P1/P2 清单，电池只提供"改动没弄坏东西"的兜底；本次它跑出的 519 与上游一致，未产生任何发现 |
| 修复轮 2 次电池 | ✅ 保留 | 都在修 13 项的过程中，是开发循环的一部分，非重复验证 |
| verifier 复验 | ✅ **必须保留** | 它跑在**修复后的不同树**（567 vs 519），是唯一"不信任执行者自报"的独立复核；且抽查 F1–F13 13/13 VERIFIED、68 AC 三列分流 |
| writer 跑电池 | ⚠️ 保留但可缩 | writer 的价值是"README 每条命令亲手复跑"（06f220bc 报告口径）；本次跑了全量+闸门 7 条 |
| git-master 未跑 | ➖ 事实澄清 | 它做的是敏感扫描门 + 7 原子提交，未跑电池；无质量损失 |

**关键量化结论**：把全量电池从 7 次压到 3 次，只能省下 **约 10 秒算力**。**"重复验证"的真实成本不在测试执行，而在每次验证所消耗的 agent 步数**：test-engineer 用 14 步 / 7.7 min 换一次"零偏差"结论（其实只有 2.3s 是跑测试，其余是读文档、建 todo、写 37KB 报告）。所以优化方向不是"要不要重复"，而是"每次验证花多少步"。

---

## 三、阶段结构评估：DSH 版是否过度分期

### 3.1 与 OMC 原版的阶段数对照

| 流程 | 阶段数 | 阶段序列 | 评审/验证的组织方式 |
|---|---|---|---|
| OMC autopilot（默认 profile） | **3** | `ralplan` → `execution` → `qa` | qa 阶段内含验证 |
| OMC team（canonical） | **5（+fix 循环）** | `team-plan → team-prd → team-exec → team-verify → team-fix(loop)` | **review 与 verification 合并在一个 `team-verify` 阶段**，按风险条件加派：安全敏感加 security-reviewer、>20 文件或架构级改动加 code-reviewer（team/SKILL.md:110,118） |
| OMC team 必备项 | — | `verifier` **always run**（team/SKILL.md:110） | |
| **DSH agent-autopilot** | **6** | Phase 0 扩写 → 1 规划 → 2 执行 → 3 QA → 4 验证 → 5 收尾 | QA（Phase 3）与评审+verifier（Phase 4）**拆成两个串行阶段** |

DSH 版把 OMC 的"一个 verify 阶段"拆成了"Phase 3 QA + Phase 4 评审 + Phase 4 verifier"，并额外加了 Phase 0（扩写）与 Phase 5（收尾）。**实测代价：Phase 3 + Phase 4 = 56.2 + 8.6 = 64.8 min，占全跑 27.0%。**

### 3.2 判断：不是"分期过多"，而是"分期之间的等待没有被并行化"

三个证据说明分期本身没白花：
1. Phase 0 产出了 68 条 AC + spec v1.1（62,454 B），Phase 1 产出六步计划（54,150 B）——下游六个 executor 的完成判据全部可追溯到这两份文档；省掉它们的收益无法在单样本上论证。
2. Phase 4 的评审火力是本次修复轮的**唯一输入**：F1–F13 全部来自 code-reviewer / security-reviewer 的 P1/P2 条目（code-reviewer-phase4-report.md 40,624 B、security-reviewer-phase4-report.md 44,706 B）。
3. verifier 是唯一与执行者隔离的取证环节。

**真问题在于阶段间的"读-写依赖"被当成了"读-读依赖"来串行**：
- Phase 3（test-engineer）与 Phase 4 双评审都是**只读**会话，读的是同一棵 Step6 冻结树，彼此不产生写依赖 —— 却串行排了 8.6 + 8.9 = 17.5 min。
- writer 读的是修复后的冻结树，verifier 也是；两者无写冲突（writer 只写 README.md）—— 却串行排了 11.4 + 8.8 = 20.2 min。
- git-master 依赖最终树，与 writer 有真实的写依赖（README 属于要提交的 docs 块，git-master-phase5-report 的 7 个提交含 docs 提交）—— 这一处**串行是结构必需的**。

---

## 四、通信开销：任务书、报告与广播

| 通信面 | 体量 | 观测 |
|---|---|---|
| 任务书（16 份） | 6,445–12,792 字符，中位约 8,100，合计约 133K 字符 | 相当于子会话可见生成量的 ~7.6% |
| 报告（agent-out 14 份 .md） | 合计 **272,154 B**（最大 code-reviewer 40,624 / security-reviewer 44,706 / test-engineer 37,660） | 是任务书体量的 **2 倍** |
| 规格与计划 | spec 62,454 B + plan 54,150 B = 116,604 B | 被下游反复 read/grep |
| 广播 | 子会话 42 次 `de_broadcast` + 组织者 31 次 = **73 次**；Step4 单会话 7 次 | 广播工具本身耗时 10.8s（42 次），可忽略 |
| 上下文重复注入 | 每会话 **2–6 次** `Current runtime context`（≈40K 字符的全局记忆 + 用户档案快照）；16 会话合计注入 ~1.52M 字符 | **与子会话总生成量 1.76M 字符同量级** |

**回答"高 token 高耗时的通信是否可比"：不可比，方向相反。** 广播是 73 次 / 10.8 秒（纯粹的编排信号，成本可忽略）；而任务是**上下文注入**——每个子会话每次开场都被重灌约 40K 字符的全量长期记忆与用户档案，16 个会话 2–6 次 ≈ 1.52M 字符输入。按 glm-5.3-flash 的 prefill 计，这是 TTFT（29.6 min）的主要构成之一，也是"每个新角色都要重新认识环境"的隐性成本。

**"组织者人工核验每角色 1–2 回合"这一环**：实测组织者在窗口内 28 turn / 169 step、生成 198,400 字符 / 14.0 min 流式，`agent_spawn`+`de_session(status/list)` 共 27 次、`read` 15 次、`memory` 29 次。即每个角色回收约 1.7 个组织者回合。**可降低，但收益是 token 与组织者注意力，不是墙钟**——因为核验发生在子会话运行的同时（组织者 median 步间隔 14.1s，p90 276.7s）。

---

## 五、档位与模型：本次最被低估的杠杆

### 5.1 档位路由表实测（`agent_roles action=tiers`）

```
LOW    → glm-pro / glm-5.3-flash
MEDIUM → glm-pro / glm-5.3-flash      ← 与 LOW 同一模型
HIGH   → deepseek / deepseek-flash
```

**LOW 与 MEDIUM 完全同模型**，档位在当前配置下只有 HIGH / 非 HIGH 的二元区分。

### 5.2 吞吐实测（Σ 可见字符 / Σ 流式秒）

| 模型 | 会话 | chars/s | 步均时长 |
|---|---|---|---|
| deepseek / deepseek-flash（HIGH） | analyst 857、code-reviewer 913、security-reviewer 885、planner 926 | **857–926** | 4.3–16.7s |
| glm-pro / glm-5.3-flash（LOW/MEDIUM） | explore 244、executor 182–240、test-engineer 238、verifier 158、writer 219、git-master 225 | **158–268** | 21.2–58.9s |

**吞吐差约 3.7×**（≈890 vs ≈235 chars/s）。而关键路径上"非 HIGH"侧承载约 4/5 的推理时间（16 会话中 12 个跑 MEDIUM/LOW）。

### 5.3 逐条回答任务书的三个具体疑问

- **"writer 用 LOW 8 分钟写 92 行 README 是否反而慢于 MEDIUM？"** —— LOW 与 MEDIUM 是同一个模型，这个比较在本机配置下**不存在**。writer 的 8.7 min = 17 步 × 30.5s/步（TTFT 1.8 + 流式 22.0 + 流式后 6.2 + 步间 0.5），其中 22.0s/步的流式是为了"6 条命令亲手复跑 + 逐字段核对 + 写 92 行 README"。若只写不验，步数可降到约 6–8 步、省 4–5 min，代价是 README 降级为"转述而非实证"（见 §七 B6）。
- **"git-master 15 分钟是否可并行 writer？"** —— 不可。writer 产出 README.md，正是 git-master 第 7 个提交（`4d950b7 docs`）的内容；并行会让提交树在 staging 期间被改动，7 个原子提交的"可复现"属性失效。**但 writer 可以与 verifier 并行**（见 A3）。
- **"verifier 能否降档？"** —— verifier 现为 MEDIUM。降到 LOW 在本机配置下**等于不降**（同模型同 provider），唯一效果是任务书口径变化。真正有价值的问题是反向的：是否把 verifier 升到 HIGH（deepseek-flash，吞吐 3.7×）——但 verifier 的价值在"取证严谨"而非"写得快"，且它是唯一独立复核环节，**在没有 A/B 数据前不应动**。

---

## Analysis（分析）

### A. 时间去向的可追溯分解

1. **关键路径 240.3 min = 119.5（P2 执行器）+ 56.2（P3+P4 验证）+ 25.2（P5 收尾）+ 23.7（人类等待）+ 13.7（P0+P1）+ 2.1（组织者间隙）。**
2. **子会话侧（328 min 汇总，含并行重叠）**：模型推理 236.5 min（72.1%）= TTFT 29.6 + 可见流式 108.1 + 工具参数生成 98.8；本地工具 9.0 min（2.7%）；步间/空闲 82.5 min（25.2%，其中 planner 空闲 77.0 不在关键路径）。
3. **618 步 × 23.8s/步** 是吞吐基本面。固定开销 10.3s/步（Step4 口径）里，TTFT 2.3s、工具参数与收尾 7.6s、步间 0.4s —— 与输出量无关。

### B. 已做对的地方（不应被"提速"改坏）

- **并行已经用满**：Step2 ∥ Step3（20:26:14 起并行 24.8 min）、code-reviewer ∥ security-reviewer、explore ∥ analyst。组织者对"独立任务可并行派多个 executor"（SKILL.md:43）执行到位。
- **交接延迟极低**：verifier 完成 23:22:47 → writer spawn 23:22:55（8s）；writer 完成 23:31:35 → git-master spawn 23:32:05（30s）；修复轮完成 23:11:21 → verifier spawn 23:11:56（35s）；QA 完成 22:27:47 → 评审 spawn 22:28:34（47s）。**组织者-side 编排不是瓶颈。**
- **澄清往返没有阻塞**：Step4 三次裁决（21:11:46 / 21:13:00 / 21:30:37）期间其步间空闲合计仅 0.5 min —— 它在等裁决的同时继续生成，往返是并行的（d3041e82 步间 gap 0.5 min 为证）。
- **双条件核销 100%**：16 个子会话全部"报告落盘 + de_broadcast"。

### C. 缺陷与浪费点（按可修性排序）

| # | 现象 | 证据 | 性质 |
|---|---|---|---|
| C1 | 用户门 #1 18.4 min 纯等待，且三问（双西瓜口径/触摸交互/其余缺省）**不依赖 explore/analyst 产出** | 组织者 19:56:46 ask → 20:15:07 答复；planner 20:15:46 才 spawn | 可并行化 |
| C2 | Phase 3 与 Phase 4 读同一冻结树却串行 17.5 min | test-engineer 22:19:57–22:27:47；评审 22:28:34 起 | 可并行化 |
| C3 | writer 与 verifier 同读修复后冻结树却串行 20.2 min | verifier 23:11:56–23:22:47；writer 23:22:55–23:31:35 | 可并行化 |
| C4 | 报告路径撞车：Step2/Step3 两份任务书用同一 `executor-20260912-2026.md` | executor-20260912-2026.md:8, :20, :159（Step3 会话被迫逐字节保全 Step2 报告 10,956 B 并写登记） | 任务书下发缺陷（SKILL.md:16 已要求带步骤后缀，未执行） |
| C5 | 同会话重复跑电池：code-reviewer 22:28:45 与 22:31:06、fix-round 23:06:18 与 23:08:01（104s 内两次） | 逐次列举表 #3/#4/#5 | 捕获纪律（输出被 `Select-Object -Last N` 截断后重跑） |
| C6 | git-master 因敏感扫描门裁决往返花掉 23:32:05→23:41:54 中的一段 | 组织者 23:41:54 广播「裁决：选 A 最小脱敏」 | 缺省决策表可预置 |
| C7 | 档位表 LOW=MEDIUM，占关键路径 4/5 的会话跑低吞吐模型 | §五 吞吐实测 | 配置级 |

---

## Root Cause（根因）

**根因不是"阶段太多"或"验证重复"，而是：(1) 墙钟由模型生成时间决定，而 (2) 档位/模型配置把大部分关键路径放在吞吐低 3.7× 的模型上，且 (3) 流程把三处"只读阶段"当串行读-写链排队。**

展开：
1. **量级错配**。本地工具执行 9.0 min / 328 min = 2.7%，编排间隙约 2.1 min / 240 min = 0.9%。把这两项全部优化到零，也只能省约 11 分钟（4.6%）。而模型生成侧 236.5 min（子会话）／关键路径约 204 min（85%）才是墙钟本体。**任何以"精简环节"为纲领的优化都注定在 5–15% 量级封顶。**
2. **档位退化为二元**。LOW 与 MEDIUM 同模型，使"档位路由"这个设计卖点在当前配置下只剩 HIGH/非 HIGH 两档；而实测吞吐差 3.7×（890 vs 235 chars/s），非 HIGH 侧承载关键路径 4/5。这是唯一能触及 50% 量级的杠杆，但它换的是模型能力，属质量权衡。
3. **只读依赖被当写依赖串行**。Phase 3 / Phase 4 双评审（读同一冻结树）、verifier / writer（读同一修复后冻结树）三处共串行约 37.7 min，其中可并行部分约 26 min。OMC 之所以更短，不是因为它阶段少，而是因为它把 review 与 verification 合并在一个 `team-verify` 阶段内**并行加派**（team/SKILL.md:110）。
4. **每步固定成本无人管**。618 步 × 10.3s 固定开销 ≈ 106 min（含工具参数生成这一实质输出，其中纯等待 TTFT 29.6 min）。步数由任务的粒度纪律决定，而任务书从未要求"把互不依赖的 read/grep/glob 合并到一步"。

---

## Recommendations（建议清单）

> 每条：**预期节省（分钟级，实测口径）/ 改动点 / 风险与反论**。节省量已扣除重叠收益，标注为区间。

### A1. 用户门前移：开工即问，与 Phase 0/1 重叠 —— **省 10–15 min**
- **改动点**：`dsh-agents/skills/agent-autopilot/SKILL.md` Phase 0 首行加硬规则："组织者在 spawn explore/analyst 的**同一回合**内，把全部产品口径类问题（可由用户偏好单独回答、不依赖勘察结论的）一次性 ask_user_question 打包发出；人类答复期间继续推进 Phase 0"。组织者 SOP 同步。
- **证据**：用户门 #1 18.4 min（19:56:46–20:15:07）是全跑最大单块空窗，占 7.6%；三问内容为"双西瓜相撞→双消+55 分 / 触摸=拖动瞄准+抬手投放 / 其余按缺省"，均属产品偏好。
- **风险与反论**：**反论成立度中等**。G-07 当时是以"双消+55 分（analyst 默认；避免越界 bug）"的形式给出的选项——**若没有 analyst 的默认值，问题本身会变形**（用户可能给出无法实现的答案）。因此更稳的版本是"**探索/分析一开始就 spawn，同时把不依赖结论的问题（如交互方式、平台范围）先问出去**"，把依赖结论的口径题留到 analyst 完成后立即问。按此保守版，实际节省 5–10 min。另一个反论：用户不在场时该等待完全不可压缩，本条只在"用户在场但需要思考时间"时生效。

### A2. Phase 3 与 Phase 4 双评审并行 —— **省 8–9 min**
- **改动点**：`agent-autopilot/SKILL.md` Phase 3/4 之间加一句并行许可："Phase 3 与 Phase 4 的**只读**评审可同时启动（三者读同一冻结树，评审不写代码）；评审任务书必须记录基线**内容哈希/断言基线**（本次为 `files=8 asserts=519`），若 QA 产生新的写操作，评审结论作废并按新基线重跑"。
- **证据**：test-engineer 22:19:57–22:27:47（8.6 min）与评审 22:28:34–22:36:43（8.9 min）串行；三者均只读（test-engineer 报告 §一：五步命令卡全部为 `node ...` 只读复跑 + 逐字节比对）。
- **风险与反论**：**反论有分量**。若 test-engineer 真发现失败（它的 3 轮循环就是为这个设计的），并行的评审就是审一棵即将改变的树——轻则浪费评审算力，重则修复轮拿到过期行号（本次评审报告里满是 `file:line` 引用）。缓解：任务书要求评审报告标注基线哈希，QA 若改动则评审重跑。**净收益仍为正**，因为 QA 失败路径在本次是 0/3 轮（test-engineer-phase3-report.md:692-693 零偏差）。

### A3. writer 与 verifier 并行 —— **省 8 min**
- **改动点**：`agent-autopilot/SKILL.md` Phase 5 顺序说明改为"verifier（MEDIUM）与 writer（LOW）可在修复轮结束后同时 spawn（错峰 15s）"；并在 writer 任务书加约束"README 内的命令卡以 verifier 的取证基线与最终树为准；若 verifier 回报阻塞>0，writer 须复跑并可能重写"。
- **证据**：verifier 23:11:56–23:22:47（11.4 min）与 writer 23:22:55–23:31:35（8.8 min）串行，两者同读修复后冻结树；writer 只写 `README.md`，与 index.html 交付物无交集（交付物 147,350 B 单文件已由 Step6/fix-round 冻结）。
- **风险与反论**：若 verifier 判 NO-GO 要求再修，README 会写在一棵将被改动的树上（本次 verifier 为 GO、阻塞 0，风险未实现）。writer 的"每条命令亲手复跑"是 README 可信度的来源（见 B6），改动树会让复跑结果失效。缓解：把 writer 的复跑排在其最后一步，并在 GO 后才定稿。**若组织者认为 README 的实证属性优先于 8 分钟，则本条可弃**——这是本次唯一"质量换时间"色彩的建议。

### A4. 报告路径唯一化（插件级自动去重） —— **省 2–4 min + 消除审计隐患**
- **改动点**：优先改**插件代码** `dsh-agents/lib/taskbook.js`：生成默认 `evidencePath`（`agent-out/<角色id>-<时间戳>.md`）时，若目标文件已存在则自动追加 `-2`/`-3` 或在时间戳后加步骤序号；并在任务书"交付"节回显最终路径。次选改 SKILL.md：把"并行派活时 evidencePath 必须含 `-step<N>` 后缀"从建议句升为**派活前置检查项**。
- **证据**：Step2（d6815301）与 Step3（4a81796c）两份任务书同为 `agent-out\executor-20260912-2026.md`；Step3 会话被迫 copy 保全 Step2 报告（10,956 B）并写页首登记与建议（executor-20260912-2026.md:8, :20, :159）。SKILL.md:16 已有"报告路径防撞车"要求但未被执行。
- **风险与反论**：几乎无。唯一反论是自动改路径会让组织者"按预期的路径去找文件"落空——所以必须把最终路径回显在返回值与任务书里（已含在改动点中）。

### A5. 把可预置的裁决写进任务书缺省决策表 —— **省 3–5 min**
- **改动点**：组织者 SOP + 各角色任务书模板的"缺省决策表"（`port-kit/docs/task-brief-v2.md` 已有该节）：把已知会遇到的裁决点预置为默认值，例如"敏感扫描门命中本机路径时：默认执行 A 最小脱敏并记入 spec 修订记录，不必回问"、"口径类歧义（如连击是否作用于消失奖励）：默认按 spec 的 G-07 字面口径，不套连击倍数"。
- **证据**：① git-master 23:32:05 spawn → 23:41:54 收到脱敏裁决（该往返后 23:47:57 收尾）；② Step4 三次裁决往返（21:11:46 / 21:13:00 / 21:30:37）虽未阻塞（步间 gap 0.5 min），但消耗组织者 3 个回合 + 3 次广播；③ 用户门 #2 的 5.3 min 等待中，"55 分×连击"是一个本可在 spec G-07 里预先钉死的口径。
- **风险与反论**：预置默认值会削弱"带实测证据再裁决"的质量。反论处理：只对**已在 spec/计划里写明字面口径**的歧义预置默认；对涉及产品方向（用户偏好）的仍必须问人。本次事件恰好符合前者（G-07 字面口径 vs 连击倍数的实现冲突）。

### A6. "一次捕获、落盘再读"纪律，杜绝同会话重复跑 —— **省 1–2 min**
- **改动点**：SKILL.md "回收与监控"节加一条工具纪律，并进各角色任务书模板："所有验证命令的完整输出必须重定向到 `agent-out/raw/<步骤>-<命令>.log` 后 `read`，**禁止** `Select-Object -Last N` 截断捕获——截断会导致重跑"。
- **证据**：code-reviewer 在 45s 内跑了两次电池（22:28:45 文件清单式命令 + 22:31:06 完整跑）；fix-round 在 104s 内跑了两次（23:06:18 + 23:08:01，后者用 `Select-Object -Last 12/-3/-2` 拼四条命令）；verifier 与 writer 也各有一次"结果不全→read 上游报告"的补救。**这不是"重复验证"，是捕获失败导致的重试。**
- **风险与反论**：落盘 raw 日志会污染 agent-out 目录（需 `agent-out/raw/` 子目录并纳入 .gitignore）。反论很弱。

### A7. 「完成自证块」降低组织者核验成本 —— **省组织者 2–4 min（token 收益更大）**
- **改动点**：任务书模板"交付与验收"节增加**机器可校验的固定形状自证块**（建议 YAML/JSON 单块）：`deliverable_path` + `sha256` + `evidence[]`（命令 / 退出码 / 关键行 / 时刻）+ `broadcast_msg_id` + `baseline_hash`。组织者核验从"重读报告 + 复跑"降为"读一块 + 抽查一项"。可选接入已开发未安装的 `dsh-port-kit` `deliverable_verify` 工具做机检（port-kit 档案：插件已开发完但未安装）。
- **证据**：组织者窗口内 169 步 / 28 turn、`agent_spawn`+`de_session` 27 次、`read` 15 次；每角色回收约 1.7 回合。
- **风险与反论**：**自证清单是自证，不是独立证据**——若组织者把它当橡皮章，质量会降。定位必须写清：自证块降低的是"格式与完整性核验"成本，**不替代**抽查与 verifier 的独立取证。另外该收益主要落在 token 与组织者注意力上（核验与子会话运行并行），**墙钟收益有限（2–4 min）**，不要高估。

### A8. 复核档位路由表：LOW 与 MEDIUM 同模型 + 3.7× 吞吐差 —— **潜在 30–70 min，但本次不下结论（需 A/B）**
- **改动点**：先做**零风险的一步**：把 LOW 与 MEDIUM 的档位语义显式化——要么给 LOW 配一个真正更小更快的模型（当前两者同值使"档位"名不副实，也让"降档"类优化（如任务书问的"verifier 能否降档"）变成空操作），要么在设置卡/文档里注明"本机 LOW 与 MEDIUM 等价"。**再考虑**对具体角色做模型 A/B。
- **证据**：`agent_roles action=tiers` 输出 LOW = MEDIUM = `glm-pro/glm-5.3-flash`；吞吐实测 deepseek-flash 857–926 chars/s vs glm-5.3-flash 158–268 chars/s；16 会话中 12 个跑 MEDIUM/LOW，承载关键路径约 4/5 的推理时间。
- **风险与反论**：**这是本次最大的杠杆，也是最不能草率动的一条。** 反论有三：① 3.7× 是**流式吞吐**，而每步成本里还有与模型无关的部分（工具参数生成、步间），实际墙钟收益低于按比例外推；② deepseek-flash 在**多文件精确编辑**（executor 的主工作）上的能力未经本机验证，本次 519→567、0 个 P0 的成果是在 glm-5.3-flash 上取得的，换模型会使这套校准失效；③ 单次运行的 A/B 不显著（本机此前有"扩样后 CI 仍重叠"的教训）。**建议：只做语义澄清（零风险），模型 A/B 待有 2–3 条同类流水线样本后再做。**

### A9. 只读角色的步数压缩（批量工具调用纪律） —— **省 3–6 min**
- **改动点**：任务书模板 + 各只读角色任务书加一句："互不依赖的 read/grep/glob 必须在**同一步**内并行发起；不得重复读取已在上下文中的文件"。可只对 explore / code-reviewer / security-reviewer / verifier 生效（**不施加于执行类循环**）。
- **证据**：每步固定开销 10.3s（Step4 口径）；只读会话步数偏高（code-reviewer 36 步、security-reviewer 28 步、verifier 23 步）；组织者自己的步间中位数 14.1s。
- **风险与反论**：对**实现类**会话，小步 read-edit-test 循环正是质量机制（本次 P0=0 与此有关），压缩步数有真实风险——所以本条**明确只限只读角色**。即便受限，收益也只是 3–6 min。

**建议合计（去重后、保守口径）：A1 5–10 + A2 8–9 + A3 8 + A4 2–4 + A5 3–5 + A6 1–2 + A7 2–4 + A9 3–6 ≈ 32–48 min / 240 min = 13–20%。**
A8 为独立量级（30–70 min）但需 A/B，不计入合计。

---

## 不建议优化项（看似可省实则必要）

### B1. 「修复轮改增量验证、不跑全量电池+重建」—— 实测为负收益 ❌
全量电池跑完 8 套件 567 断言耗时 **2.3–2.9 秒**（逐次列举表 7 次实测 2.3/2.3/2.4/2.4/2.9/2.3/2.4s），`build-html` 重建与 `verify-single-file` 同样在秒级。改增量验证要额外付出"判断哪些套件受影响"的推理步（一个 read/grep 步 ≈ 20–40s），**净亏**。修复轮的 27.2 min 全部花在 75 个生成步上（步均 21.2s），与"跑哪些测试"无关。**这条直觉上最像优化，实测最像陷阱。**

### B2. 「verifier 并入 test-engineer 复验」—— 会取消唯一的独立取证 ❌
两者跑在**不同的树**上：test-engineer 是修复前的 519 基线（22:20:57），verifier 是修复后的 567（23:12:47）。verifier 的产出是"GO 阻塞 0 + F1–F13 抽查 13/13 VERIFIED + 68 AC 三列分流"，即**独立于执行者自报的新鲜证据**。合并等于让执行方的同伴给自己发合格证，与 OMC "Always run verifier"（team/SKILL.md:110）直接冲突。

### B3. 「砍掉心跳、只在完成广播时唤醒」—— 心跳未造成可测墙钟损失 ❌
组织者窗口内 26 次心跳（`pwsh Start-Sleep` 240–480s）、93 次 inbox 注入（next-turn 56 / next-step 37）；但实测**每次子会话完成的交接延迟为 8–47 秒**（verifier→writer 8s、writer→git-master 30s、fix→verifier 35s、QA→评审 47s），说明心跳没有拖慢反应。心跳的成本是组织者 token 与唤醒预算（连续 3 次降级），不是墙钟。**真正该做的是把心跳间隔按子会话 ETA 对齐（避免空转心跳烧唤醒名额），而不是取消它**——这与既有记忆「预算感知调度」一致。

### B4. 「取消 spawn 错峰 15s」—— 占 0.3%，且是用户纪律 ❌
三次错峰（19:47:52、20:26:22、22:28:38）合计约 45 秒 = 全跑 0.3%。而"并发≤3 作用于开启瞬间"是用户固化的工程纪律，本次全程零模型断联，取消它是拿稳定性换 0.3%。

### B5. 「压缩评审报告体量（40KB + 44KB）」—— 报告是修复轮的唯一输入 ❌
code-reviewer 的 P1=2 / P2=16 与 security-reviewer 的 P1=1 / P2=8 直接生成修复轮的 F1–F13 清单（含文件:行号与【改进点】），修复轮完成后 verifier 又按行号抽查 13/13。报告里的 `file:line` 引用密度就是下游可执行性。压体量=提高漏修概率，且省下的是**读取成本而非生成成本**。若要控制，应该限制"证据行"的重复引用，而不是限制发现数。

### B6. 「writer 只跑受影响单套件」—— 与 writer 的存在理由冲突 ❌
writer 的价值定义为"README 里每条示例命令必须验证过"（SKILL.md:61）。本次它跑了完整电池 + 闸门 7 条，才敢在 README 里写命令卡。改成部分复跑，README 就从"实证"降级为"转述"，**省 7 秒算力换来一份不可信文档**。（若要提速，正确做法是 A3 的并行，而不是减少复跑。）

### B7. 「六阶段裁成三阶段（对齐 OMC autopilot）」—— 本次样本不支持 ❌
本次运行的**元目的就是测试这条流程**（用户指令："开发一个网页版的合成大西瓜，以测试这个流程"）。用一次运行的结果去裁掉未被证伪的阶段，是用推测替换已验证机制。OMC 之所以阶段数少，是因为它把 review 与 verify **并行合并在 `team-verify` 内部**（team/SKILL.md:110），而不是因为它的阶段做得浅——**正确的 DSH 化是 A2/A3 的"阶段内并行"，不是删阶段**。

### B8. 「Phase 0 扩写可跳过」—— 本次由它产出的 68 条 AC 是下游全链判据 ❌
spec 62,454 B / 68 AC 与 plan 54,150 B 是六个 executor 的完成判据、评审的核对基准、verifier 的 68 AC 三列分流依据。SKILL.md:31 已给了跳过条件（已存在 requirement-interview spec 或 consensus-plan 计划）——**跳过是"已有产物"时的复用，不是"省时间"时的裁剪**，两者不可混用。

---

## Trade-offs（权衡）

| 选项 | 利 | 弊 |
|---|---|---|
| A. 按 A1–A9 做流程并行化 | 保守省 32–48 min（13–20%），改动集中在 SKILL.md 与任务书模板，零模型风险 | 收益天花板明确（编排侧总量仅约 40 min）；A2/A3 引入"基线漂移"风险，需靠哈希门约束 |
| B. 动档位/模型（A8 的激进版：把 MEDIUM 换到 deepseek-flash） | 单杠杆潜在 30–70 min，是唯一能触及 50% 量级的选项 | 换掉本次 519→567、0 P0 成果所依赖的模型；与本机既有教训（单次 A/B 不显著、需扩样）冲突；多文件编辑能力未验证 |
| C. 维持现状，只做 A4/A6 这类零风险修复 | 无质量风险，改动 2 处，可立即落地 | 只省 3–6 min，等于承认"这次慢是正常的" |
| D. 对齐 OMC 把 QA 与验证合并为单阶段 | 阶段数 6→5，结构更接近原版 | 单样本证据不足以证明阶段拆分是多余的；且 OMC 的短来自**阶段内并行**而非合并（B7） |

**推荐组合：A + C（先落地 A4/A6/A1 保守版，A2/A3 带哈希门试行，A8 只做语义澄清）。** 理由：这些改动全部作用在"只读依赖被当写依赖串行"这一真实根因上，且不触碰任何已验证的模型行为。

---

## References（引用）

### 转录取证（session.jsonl.zstd，逐条可复现）
- `~/.dsh/sessions/--D-tools-deepsek_harness--/session-1766c134-a4b1-4f1f-a408-8c361544a8e4/session.jsonl.zstd` — 组织者：窗口内 28 turn / 169 step / 26 心跳 / 73 广播（31 发出）/ 4 次 ask_user_question（等待 18.2 + 0.1 + 0.0 + 5.3 min）；`agent/inbox/spliced` next-turn 56 / next-step 37
- `session-8b5eaa6e…`（Explore 19:47:39–19:58:56）、`session-1377f0a8…`（Analyst 19:48:24–19:56:27）、`session-c70f7f9d…`（Planner 20:15:46–21:41:16，6 turn / 119 step，步间空闲 77.0 min 为非关键路径）
- `session-e938bcd0…`（Step1 20:19:39–20:26:27）、`session-d6815301…`（Step2 20:26:14–20:46:01）、`session-4a81796c…`（Step3 20:26:51–20:51:01）、`session-d3041e82…`（Step4 20:50:55–21:35:44，59 步）、`session-45e2123e…`（Step5 21:35:44–22:00:11，61 步）、`session-d71ef338…`（Step6 21:59:50–22:19:09，33 步）
- `session-d3890c54…`（Test Engineer 22:19:57–22:27:47，14 步）、`session-30b8a8d6…`（Code Reviewer 22:28:34–22:34:32，36 步）、`session-99895a85…`（Security Reviewer 22:29:18–22:36:43，28 步）
- `session-2b8bbf91…`（修复轮 22:44:08–23:11:21，75 步）、`session-7ae20681…`（Verifier 23:11:56–23:22:47，23 步）、`session-06f220bc…`（Writer 23:22:55–23:31:35，17 步）、`session-0358ce37…`（Git Master 23:32:05–23:47:57，16 步）

### 报告与文档（文件:行号）
- `merge-watermelon/agent-out/autopilot-summary-20260912-2350.md:4` — 运行时间窗与六阶段结论
- `merge-watermelon/agent-out/autopilot-summary-20260912-2350.md:17` — 六步执行器与 519→567 断言基线
- `merge-watermelon/agent-out/executor-20260912-2026.md:8, :20, :159` — 报告路径撞车登记、逐字节保全 10,956 B、建议加步骤后缀（C4 证据）
- `merge-watermelon/agent-out/executor-20260912-2026-step2.md:3` — Step2 会话 id = session-d6815301
- `merge-watermelon/agent-out/executor-20260912-2026.md:3` — Step3 会话 id = session-4a81796c（与 Step2 并行）
- `merge-watermelon/agent-out/test-engineer-phase3-report.md:692-693` — 五步复跑零偏差判据对照（A2 的"QA 未发现"证据）
- `merge-watermelon/agent-out/code-reviewer-phase4-report.md:204` — D6 偏差裁决与 P2-12 技术债（评审产出为修复轮唯一输入）
- `merge-watermelon/agent-out/git-master-phase5-report.md:55` — 敏感扫描门与 session id 类脱敏清单（C6 证据）
- `D:\tools\deepsek_harness\dsh-agents\skills\agent-autopilot\SKILL.md:16` — "报告路径防撞车…带步骤后缀"（C4：已有规则未执行）
- `D:\tools\deepsek_harness\dsh-agents\skills\agent-autopilot\SKILL.md:26` — Phase 1 计划必须用户批准（A1 的门定义）
- `D:\tools\deepsek_harness\dsh-agents\skills\agent-autopilot\SKILL.md:43` — "独立任务可并行派多个 executor"（并行已用地到位）
- `D:\tools\deepsek_harness\dsh-agents\skills\agent-autopilot\SKILL.md:61` — writer"每个示例命令必须验证过"（B6 依据）
- `omc-analysis/oh-my-claudecode-main/skills/team/SKILL.md:99` — 规范阶段序列 `team-plan → team-prd → team-exec → team-verify → team-fix(loop)`
- `omc-analysis/oh-my-claudecode-main/skills/team/SKILL.md:110` — `verifier` always run；code-reviewer/security-reviewer 按风险**条件加派**（阶段内并行）
- `omc-analysis/oh-my-claudecode-main/skills/team/SKILL.md:118` — 风险等级升级评审（>20 文件 / 安全敏感）
- `omc-analysis/oh-my-claudecode-main/skills/autopilot/SKILL.md:54, :62-65` — autopilot 默认 profile = `[ralplan, execution, qa]` 三阶段
- `omc-analysis/oh-my-claudecode-main/docs/adr/03487-named-autopilot-stage-profiles.md:53` — ralplan 与 execution 必备、ralph/qa 可选

### 工具输出（可复现命令）
- `agent_roles action=tiers` — LOW/MEDIUM 同模型（glm-pro/glm-5.3-flash）、HIGH=deepseek/deepseek-flash
- `D:\anaconda3\python.exe -X utf8 -`（zstandard + json 内存解压逐条解析，只读，未落盘临时文件）— 步级时长、工具 span、chunk `dt` 吞吐、inbox target 分布、ask_user 等待时长

### 工具映射说明（任务书 §八）
本次未使用任何 Claude 专属工具。"Read/Grep/Glob" → `read`/`grep`/`glob`；"Bash" → `pwsh`（每次独立进程，用 `workdir`）；转录解压与统计用 `pwsh` 调 `D:\anaconda3\python.exe` 经 stdin 执行内联脚本（zstandard 在 conda 主环境自带），**全程内存解析、未写任何临时文件**，因此无需清理。无 git / install / build / 写盘命令，符合只读边界。

---

## Consensus Addendum

> 本次任务书未显式声明 ralplan 共识评审，故本节按人格细则"任务书显式声明时沿用"的要求**不启用**。若组织者需要，可对 A2/A3（阶段并行化，含基线漂移风险）与 A8（模型杠杆）另起一轮 architect↔critic 共识评审。
