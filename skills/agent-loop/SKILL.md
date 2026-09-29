---
name: agent-loop
description: "触发：长任务循环、跑多轮、心跳巡检、循环卡死、熔断、DAG 编排、自主循环、拆任务并行跑、设计一个 loop｜English: autonomous loop, long-running task, heartbeat, circuit breaker, DAG orchestration｜DSH 自主循环三层合一技能（机制 + 判断 + 模式）：机制层=loop-start 启动前三查与停止条件落盘 / loop-status 跨会话快照与退出码语义（2=熔断 1=未完成 0=完成）/ guard 同一步骤 3 轮无落盘增量即熔断移交组织者 / 心跳纪律三要素（唤醒有界、间隔按里程碑 ETA 对齐、+5h 长尾保险心跳）；判断层=四条件门、可判定目标、五崩法、三条红线、plan/build/judge；模式层=顺序流水线、De-Sloppify 清理遍、RFC 驱动 DAG 编排、DSH 原语选型树、循环硬门（max-runs / max-cost / max-duration / completion-signal 至少其一）。Use when 编排长任务循环、spawn 子会话跑多轮迭代、组织心跳巡检链、判断循环是否卡死、跨会话读取循环状态、设计或体检一个 loop、给实现步骤配清理遍、把大特性拆成 DAG 并行跑、评估循环模式选型。中文触发：起循环、跑长任务、心跳巡检、循环卡死、熔断、loop 快照、退出码、循环模式、流水线、DAG 编排、拆任务并行、清理遍、deslop、循环硬门、选型树、写 loop、设计 loop、做一个 loop、检查 loop 对不对、loop 体检、loop 会不会跑飞、可判定目标、五个崩法、plan build judge。English triggers: autonomous loop, loop status, loop guard, watchdog, circuit break a loop, heartbeat chain, stale loop detection, stop condition, design an agent loop, write a loop, check a loop, loop review, prevent a runaway loop, goal-oriented loop, decidable goal, plan/build/judge, loop pattern, sequential pipeline, DAG orchestration, de-sloppify pass, bounded loop, merge queue."
---

# Agent Loop — 机制 / 判断 / 模式 三层合一

> **一句话定位**：一个技能同时回答三个问题——「循环怎么起、怎么巡检、怎么熔断」（§A）、「这个循环的目标本身对不对、会不会跑飞」（§B）、「该选哪种循环形态」（§C）。
> **使用顺序建议**：先用 §B 判断「该不该建这个循环、目标是否机器可判」，再用 §C 选形态，最后用 §A 起循环并巡检；已经在跑循环、怀疑它卡死时，直接跳 §A-2/§A-3。

## 本文件导航（节号 ↔ 三层结构）

| 节 | 层 | 内容概要 |
|---|---|---|
| §A 机制层 | 机制 | 0 总览 / A loop-start / B loop-status / C guard / D 心跳纪律 / E 反模式 |
| §B 判断层 | 判断 | Premise / When to use / Red-line premise / Action 1（Step 0-5）/ Action 2 五崩法+三红线 / Worked example / One-line close / Lineage |
| §C 模式层 | 模式 | §1 顺序流水线 / §5 De-Sloppify / §6 DAG 编排 / §7 选型树 / §8 硬门与反模式 / §9 References |
| §D 部署与触发 | 部署 | 合并版新增 |

---

# §A 机制层 — 循环怎么起、怎么巡检、怎么熔断

> 机制层技能：管「循环怎么起、怎么巡检、怎么熔断」。「循环目标本身对不对、会不会跑飞」的判断层见**本技能 §B**——两层配套，本节不重复判断层内容。

### §A 头部适配映射表（种子段落宿主设施 → DSH 原语）

| ECC 宿主设施（种子段落） | DSH 对位 |
|---|---|
| `npx ecc loop-status --json`（CLI 扫描 ~/.claude/projects 转录找僵死信号） | de_session status/list 巡检 + 本技能 §A-2 状态快照文件（跨会话只读） |
| `--watch` / `--watch-count`（有界刷新流） | pwsh 后台心跳任务（run_in_background=true）+ job_output 领取（有界由 tool-jobs 唤醒预算承担） |
| `--exit-code` | 语义按 DSH 口径重定义：2=熔断 / 1=未完成 / 0=完成（§A-2.3） |
| `--write-dir ~/.claude/loops`（index.json + per-session JSON 快照） | `<项目>/loop-state/`（任务书指定路径优先）：index.json + <session-id>.json |
| `.claude/plans/` runbook 落盘 | 任务书/计划文件 + loop-state 停止条件文件（§A-1.2） |
| `ECC_HOOK_PROFILE` 未禁用检查 | DSH 无 hooks——改查：完成判据机器可判（跑本技能 §B 四条件门）+ 档位路由合规（agent_roles action=tiers，禁越档）+ 消耗额度项成本核算书已批 |
| Claude transcript JSONL 扫描 | `~/.dsh/sessions/<工作区目录>/session-<id>/session.jsonl.zstd`（只读取证；python zstandard 须 stream_reader） |

## §A.0 三段式总览

- **loop-start**（§A-1）：开跑前。安全前置检查 + 停止条件落盘，缺一不开跑。
- **loop-status**（§A-2）：巡检态。每轮循环把状态写成跨会话可读快照；退出码三态语义。
- **guard**（§A-3）：熔断态。同一步骤 3 轮无新落盘增量即熔断，点对点移交组织者，不无限续命。

## §A-1 loop-start — 启动前安全前置检查 + 停止条件落盘

（种子：commands/loop-start.md:26-30「Required Safety Checks」三条——先验证测试通过再起首轮；确认 hook profile 未被全局禁用；确认循环有显式停止条件。ECC 逐条 DSH 适配如下。）

### §A-1.1 开跑前三查（全过才准起循环）

1. **基线绿（新鲜输出）**：首轮起跑前的验证（构建/测试/验收链）必须在本会话新鲜跑过并展示输出，不假设上一会话的绿还有效。
2. **判据可判（DSH 替代 hook-profile 检查）**：DSH 无 hooks，没有运行时拦截兜底——完成判据必须机器可判（跑**本技能 §B** 的四条件门：可判定目标/边界条件/失败回退/评审独立）。判据含糊的循环在 DSH 里必然跑飞，因为没有任何机制能拦住它。
3. **额度与档位合规**：消耗 API 额度的循环先出成本核算书并获用户批准（用户固化纪律）；子会话一律用档位路由表内模型——spawn 前跑 `agent_roles action=tiers` 以当次回显为准，禁止任何形式的越档显式指定。

### §A-1.2 停止条件落盘（硬门，缺一不开跑）

把停止条件写进循环状态文件（默认 `<项目>/loop-state/index.json`，任务书指定路径优先）：

- **max-runs（最大轮数）/ max-cost（成本上限）/ max-duration（时长上限）/ completion-signal（完成信号）至少其一**——四形态全缺的循环禁止启动（与**本技能 §C-8** 硬门同源，ECC 原文「Always have a max-runs, max-cost, max-duration, or completion signal」）。
- **回合上界**：同一步骤在同一会话内最多 3 轮无新落盘增量的往返（**§A-3** guard 的触发线，开跑前就写进快照）。
- 停止条件变更走任务书修订，不静默改、不中途放宽。

### §A-1.3 循环状态文件骨架

```json
{
 "loop_id": "<任务/批次名>",
 "pattern": "<sequential|batch|dag>",
 "stop_condition": { "max_runs": 10, "max_cost_usd": null, "max_duration": "8h", "completion_signal": "ALL_TESTS_GREEN" },
 "round_budget": { "rounds_no_progress_limit": 3 },
 "phase": "<running|paused|done|circuit_broken>",
 "exit_code": null,
 "rounds_since_progress": 0,
 "last_checkpoint": "<时间戳+最后落盘产物>"
}
```

（JSON 为示意骨架；字段可按任务增减，stop_condition 与 rounds_no_progress_limit 两块必填。）

## §A-2 loop-status — 跨会话可读状态快照 + 退出码语义

（种子：commands/loop-status.md:52-72——`--write-dir` 维护 index.json 与 per-session JSON 快照供兄弟终端与 watchdog 读取；「快照只是本地转录分析的快照，不控制、不超时运行时工具调用」。）

### §A-2.1 快照纪律

- 每轮循环结束**覆盖写** `loop-state/index.json`（一行一轮：sessionId/pattern/phase/rounds_since_progress/heartbeat 链/eta/exit_code/last_checkpoint）与 `<session-id>.json`（该会话全量载荷）。
- 快照是跨会话接口：任何心跳回合、组织者巡检、兄弟会话判断循环状态，只读快照，不必唤醒循环本体。
- **快照是观察面不是控制面**：写快照不等于熔断；熔断以 §A-3 判定为准。细节争议取证回 session.jsonl.zstd（只读），快照不替代转录。

### §A-2.2 心跳回合标准动作

心跳醒来先做四件事：① `job_output` 领取积压通知（可能多条，逐条核对）；② 巡检落盘增量（产出文件 mtime/大小/行数，不凭对方自述）；③ 更新 §A-2.1 快照；④ 按需链下一条心跳（间隔按 §A-4.2）。

### §A-2.3 退出码语义（本技能约定，组织者巡检按码处置）

| exit | 含义 | 组织者处置 |
|---|---|---|
| **2** | 熔断（guard 触发，或停止条件命中） | 重划界/接管/按断点重派 |
| **1** | 未完成（循环在跑或待续） | 等下一心跳或继续 |
| **0** | 完成（完成判据满足且验证过，展示新鲜输出） | 正常回收验收 |

（注：ECC 原语义 2=发现僵死信号、1=无法扫描转录；DSH 侧重定义收窄为循环三态。僵死信号检测在 DSH 由 §A-3 guard + 心跳巡检承担；转录取证不可用属环境故障，走失败降级 L3/L4 上报，不占码位。）

## §A-3 guard — 3 轮无增量熔断

- **判定**：同一步骤在同一会话内连续 **3 轮**无新落盘增量（产出文件 mtime/大小无变化、无新文件、快照无更新）→ 判熔断，exit_code=2。以「落盘增量」为唯一判据，不以「自认有进展」为准；「写了但没存」与「没写」同罪。
- **熔断动作**（按序，不得静默停止）：
 1. 停止该步骤续命——不第 4 次重试；
 2. `de_broadcast` **点对点直投组织者会话**（有 ORG ID 一律直投，禁用 project: 伪接收者），正文含：卡点现象、已试 3 轮各自的动作与失败原因、当前落盘状态、剩余项清单、退出码 2；
 3. 快照 phase 置 `circuit_broken`、exit_code=2，移交组织者重划界。
- **三种失败降级分层**（任务书缺省决策表）：缺参数查缺省表（L1/L2）→ 工具不可用换等价能力并声明（L3）→ 产出无法落盘/任务无法继续必须广播卡点（L4，wake:true）。

## §A-4 心跳纪律三要素（本机已固化纪律，内嵌原文——不重造）

> 来源：`D:\python\projects\guji\kb\docs\dsh_heartbeat_wake_budget.md`（2026-09-08 夜间巡检静默断链根因分析，tool-jobs `maxConsecutiveWakes` 转录取证）+ 全局记忆「DSH 后台任务完成通知的唤醒是有界的（tool-jobs）」条。三要素为长期生效纪律，本技能只做汇编落位。

### §A-4.1 唤醒有界

每个会话**连续由插件通知唤醒最多 3 次**（`maxConsecutiveWakes` 默认 3），第 4 次起通知降级为不唤醒注入（next-step），idle 会话不领取形成盲区；只有领取到**用户亲写消息**（source.kind==="user"）才重置预算——心跳通知本身是 kind=plugin，自激链永不补充自己花掉的预算。**心跳只保证「通知必达」不保证「即时唤醒」**：通知永不丢失只延迟（持久 inbox，下回合批量领取）。预算按会话计不按任务计——同周期几分钟错峰双心跳无效。`maxConsecutiveWakes` 未暴露到 profile/settings，调它需改宿主代码且升级失效。

### §A-4.2 间隔按里程碑 ETA 对齐

心跳间隔按里程碑完成验收点弹性对齐（近期约 45min；跨里程碑完成点按 ETA+15min 余量），**不要均分短周期**。起链前先算唤醒预算账：每个计时器心跳自问「醒来时能验证到什么新状态」——早于目标 ETA、验不到新状态的纯计时器心跳直接砍，把 3 次预算花在里程碑上。

### §A-4.3 +5h 长尾保险心跳

每轮巡检链外挂**一条 +5h 长尾保险心跳**，防「巡检回合中途崩死没接上链」——短链正常时长尾落空无害（降级注入、下轮顺带领取）；短链断头时，长尾 5 小时后仍能复活巡检。长跑收尾过夜方案：晚间最后一次互动后链 45m → 90m → 150m 三级心跳，覆盖约 4.7h，其后通知积累、早晨首批领取。

## §A-5 反模式

1. **无退出条件的循环**——违 §A-1.2 硬门，禁止启动。
2. **只等完成广播不巡检落盘**——子会话可能无声死亡（内容过滤 1301 / provider 429 配额耗尽），广播与心跳双通道兜底。
3. **快照只写一次**——§A-2.1 要求每轮覆盖写，跨会话接口失效等于没有。
4. **熔断后原地重试**——§A-3：3 轮上限，第 4 次动作只能是上报，不是重试。
5. **心跳均分短周期烧预算**——违 §A-4.2，空转计时器应当场砍掉。
6. **把唤醒降级当通知丢失**——§A-4.1：静默=延迟不是丢数据，下回合先领取积压再动作。

---

# §B 判断层 — 目标对不对、会不会跑飞

> 判断层负责「WRITE 一个循环（该不该建、目标能不能机器判、选哪种类型、选哪套骨架）」与「REVIEW 一个循环（五崩法 + 可判定性/边界/回退/评审独立 + 红线）」。机制实现（怎么起、怎么巡检、怎么熔断）见**本技能 §A**；循环形态与编排模式见**本技能 §C**。

### §B 头部适配块（ECC→DSH 映射表 + DSH 侧补充）

**ECC→DSH 适配映射表（宿主设施 → DSH 原语）**

| ECC 宿主设施（正文原样保留） | DSH 对位 |
|---|---|
| `/goal` 斜杠命令（servo 闭环） | create_goal / goal 工具（达目标即停；update_goal complete 收尾） |
| `/loop` 斜杠命令（恒温器 regulator） | DSH 无原生等价：pwsh 后台心跳任务（run_in_background）+ 组织者巡检（机制细节见本技能 §A-2/§A-4） |
| `/schedule` / cron | Windows 计划任务（Register-ScheduledTask；沙箱内 schtasks 必挂，建议交用户终端） |
| Claude Code sub-agents（main Claude dispatching plan/build/judge） | de_session spawn 三角色子会话 + 组织者合成 |
| CLAUDE.md（常驻规则文件） | ~/.dsh/AGENTS.md（全局）+ 项目 AGENTS.md + memory 轨 |
| `autonomous-loops` / `continuous-agent-loop` | 合并后即**本技能 §C 模式层**（§C-1 顺序流水线 / §C-5 清理遍 / §C-6 DAG 编排 / §C-7 选型树 / §C-8 硬门）；运行时机制层由 goal 工具 / ralph / de_session wake + 心跳承载（§A） |
| hooks / MCP / claude CLI | 本件零依赖（源件 C 报告宿主依赖扫描确认），无需降级 |

**DSH 循环原语对照（源件 C 报告 A-1 改进点①）**

goal=servo（达目标即停）｜ralph=有界重跑（fresh-agent 迭代，轮数上限）｜de_session wake=regulator（按需触发）｜心跳/Windows 计划任务=cron（定时触发）。

**五崩法 × DSH 最小机检（源件 C 报告 A-1 改进点②）**

#1 目标不可判定→验收标准必须机器可判；#2 自审自判→评审者不得是作者（squad 盲评 / verifier 新鲜证据）；#3 删测试过门→断言测试文件数与断言计数不降于基线；#4 指望运行时提问→澄清必须前置（见下）；#5 陈旧记忆→记忆审查轮 + decay 归档。

**与 subagent-clarify 交叉引用（源件 C 报告 A-1 改进点③）**

崩法 #4「指望 agent 运行中提问」↔ subagent-clarify「缺参数不得瞎猜、按链路取人类输入」——同一条纪律：澄清必须前置，开工前问清。（该技能为独立技能，保持跨技能引用。）

## §B 正文

> **Premise.** An LLM is a feed-forward system: prompt in → tokens out, with no built-in "steer toward the goal" across turns. To make it *behave* like a goal-oriented system, you wrap a feedback loop around it. This skill helps you **write** that loop correctly and **review** it so it won't run away.

### §B-1 When to use / not

**Use it when:**
- You want to hand a repeating task to an agent that runs over and over (write→test, test→fix, fix→verify…).
- You already have a loop and worry it spins, cheats, or runs a wrong answer to completion.

**Don't use it for:**
- A one-off task → just do it; don't wrap a loop around it.
- A plain timer / poll → use `/loop`; no design needed.
- *How to wire the loop architecture* (pipelines → DAGs, long-run recovery) → that's the mechanism layer; see **本技能 §C**。**This skill only covers "is the goal right, and will it run away" — it does not re-explain mechanism.**

### §B-2 Red-line premise: two levels of feedback

| Level | Who owns it | What it does |
|---|---|---|
| **Execution** (low) | machine / agent | Measures "how far from the literal goal" and grinds it to zero. The machine is strong here. |
| **Judgment** (high) | **human** | Decides "is this goal itself right, should it change, should it stop." The machine can't step outside its own loop to question the goal. |

> A thermostat can feed back "how far from 26°C," but when you have a fever and want 28°C it can't judge whether 26 is the *right* target — it just grinds toward 26. **"What to set today" is always the human's call.**
> Handing judgment / sign-off / the last switch to the machine = removing the high-level feedback = it sprints, fast and hard, toward a goal no one questioned → wrong output.

---

### §B-3 Action 1 — Write a loop (5 steps)

#### Step 0 · Subtract first: should you even build it? (4-condition gate, any miss = veto)

① the task repeats weekly or more　② verification can be automated　③ the token budget can take it　④ the agent has tools that actually *run and see the result*

Miss any one → **don't build a loop**; do it by hand or another way.
> What stops most people isn't "can I write a loop," it's "does my repo deserve one." A repo that deserves a loop has a reconciliation baseline (golden sample / upstream total) + tests + a lint guard. **A repo that doesn't deserve a loop will only have its errors amplified by one.**

#### Step 1 · Define a *machine-decidable* goal (the hard part — the loop lives or dies here)

The whole loop rides on the comparator's "is it done yet?" **The comparator can only work if your exit condition can be judged yes/no by a machine.**

- Bad: Vague ("make it good," "write it sharper") → the comparator can't judge → either it never passes (stuck retrying) or it guesses (passes/blocks at random).
- Good: Decidable ("all 96 unit tests green AND a change-list is produced," "module-02 fields filled, pytest passes, business logic untouched") → one check settles it; the loop converges cleanly.

**Five-point goal framework:**
1. **Done-criterion is machine-verifiable.**
2. **Boundary conditions defined alongside the done-criterion** ("what it must NOT do") — anti-Goodhart; missing boundaries = a license to cheat.
3. **Has a failure fallback** — retry cap N + escalate to a human when exceeded.
4. **Goal is layered.**
5. **Prefer reconciliation over assertion for the done-criterion** — anchor to external fact (golden sample / upstream total / financial tie-out / platform back-office numbers) before your own assertions. "All tests pass" can be gamed (loosen asserts, fake mocks, swallow exceptions); "diff vs the reference < 0.01" can't.

> **Self-check:** read the goal to someone who doesn't know the domain — can they run one command and tell whether it's done? If not, it isn't decidable enough. Go back.

#### Step 2 · Pick the loop type

| Your task | Loop type (cybernetic) | How it stops |
|---|---|---|
| Has a clear "done" test (write to done / a batch of images processed) | **servo** (`/goal`-style closed-loop) | stops on reaching the goal |
| No endpoint, must keep maintaining a state (inventory alert / scheduled health check) | **regulator** (`/loop`-style thermostat) | never stops; acts only on change (dead-band suppresses noise) |
| Periodic sampling, stop on a condition (watch a PR until CI is green) | **regulator with an exit** | stops when the exit condition holds |
| Must "ensure something happens on time" | wrap the above in `/schedule` | cron fires it |

> Rule of thumb: clear "done" test → servo; must keep maintaining, no endpoint → regulator; must "happen on time" → wrap a regulator in schedule.

#### Step 3 · Pick a skeleton

**Maintenance type (tend something that exists) → document-driven dispatch.**
The loop isn't "run a fixed check on a timer," it's **"read a doc on a timer, and dispatch only when the doc changed."** The doc is the task queue + state machine + human interface.
Three disciplines: ① the problem column is human-write-only, the result column is loop-write-only, **state advances one-way and never rolls back**; ② **the exit code is final** (if the script says exit 1, the script wins); ③ state advances only as far as "awaiting verification" — **the "done" cell is flipped by a human only.** The loop is the worker, not the acceptance officer.

**Greenfield type (build from scratch) → plan / build / judge, three roles.**

| Role | Does | Key |
|---|---|---|
| **Plan** | break the goal into a spec + **decidable acceptance conditions** | acceptance must be script-judgeable |
| **Build** | write to the spec | **must not change the acceptance conditions** |
| **Judge** | run acceptance **independently**; pass → stop, fail → return with the failure reason to Build | **independent + deterministic** |

Three iron rules (all bet on the judge): ① **the judge must be independent** — not the same agent as Build (grading your own homework always inflates); ② **deterministic rules** — pytest / reconciliation diff / type check / diff, never "looks right"; ③ **Build may not edit the acceptance conditions to pass**. Three failed retries → escalate to a human.

#### Step 4 · Add damping (against oscillation / runaway)

Retry cap, hard stop, human flips the last switch = damping. **Negative feedback with no damping oscillates** (the Ralph-Wiggum loop: spinning in place, burning tokens).

#### Step 5 · Land in three stages (don't go fully automatic on day one)

① **Run it once by hand** (forces you to state exactly "how the judge decides") → ② harden into a skill / Claude Code sub-agents (a main Claude loops, dispatching plan/build/judge) → ③ hang it on cron for full automation.

---

### §B-4 Action 2 — Review a loop (checklist = five failure modes)

> Run the loop past each row. **Hitting any one = this loop will misfire; send it back.** These five are negative experience (gotchas) — worth more than positive rules.

| # | Failure mode (how it breaks) | Review question (a hit = red) | Antibody |
|---|---|---|---|
| 1 | Goal is a correct platitude → **spins, burns money** | Can the exit condition be machine-judged yes/no? Or is it "manage it well / make it good"? | Replace with a decidable result condition (Action 1·Step 1) |
| 2 | "Verification" written as "check if it looks ok" → **agent confidently says fine and stops** | Is the judge the defendant itself? Does verification rest on "looks right" or deterministic rules? | Reconcile + exit code rules + independent judge |
| 3 | (worst) Only gates on "all tests pass" → **agent deletes the tests** | Is there a boundary ("what it must NOT do")? Or only a done-criterion? | Done-criterion **+ boundary** together (the Goodhart antibody) |
| 4 | Counts on the agent asking mid-run → **it won't; it runs the wrong answer to the end** | Is there any "clarify only at runtime" point? | **Front-load every clarification**; settle it once before launch |
| 5 | Bloated CLAUDE.md + stale memory → **the faster it loops, the more it errs** | Are the docs/memory it depends on fresh? Who maintains them? | Layered memory + periodic lint |

**Plus three red lines (violate any = not allowed to go automatic):**
- **Keep judgment with the human.** Acceptance / the "done" cell is flipped by a human; the loop is not the acceptance officer.
- **Responsibility doesn't transfer.** Anything whose failure you can't afford (merge the wrong PR / publish the wrong thing / misallocate money) → **don't hand over the authority automatically.**
- **Counter-intuitive warning.** The more "self-improving / rewrites-its-own-rules" a loop is, the **stricter the human review it needs** (to see what it rewrote the rules into) — not looser. The machine is too fast to intercept after the fact, so the human's judgment must sit **before the action** (a hard gate), not as a post-hoc patch.

---

### §B-5 Worked example — reviewing a "nightly green-keeper" loop

You want a loop that runs every night and fixes whatever tests are failing.

- **Naive goal:** "make all tests pass." → Step-1 self-check fails: this is the bait for failure mode #3.
- **Decidable goal (fixed):** "all tests green **AND** no test file deleted or weakened **AND** coverage not lowered **AND** a change-list produced." Boundary now defined alongside the done-criterion.
- **Type:** servo with a retry cap of 3 (Step 2 + Step 4).
- **Skeleton:** plan/build/judge — the **judge is CI run independently**, never the fixing agent (Step 3).

Now run the **review checklist**, and it catches what the naive version would have missed:
- **#3 hit** → the naive "all tests pass" lets the agent delete a failing test to "win." Fixed by the boundary "no test file deleted/weakened."
- **#2 hit** → if the fixing agent also judged its own fix, it would pass itself. Fixed by "judge = independent CI, deterministic."
- **#4 hit** → if a fix is ambiguous, the agent won't stop to ask at 2 a.m.; it'll commit a guess. Fixed by front-loading: ambiguous fixes are left for the human, not guessed.
- **Red line** → the loop opens a PR but **does not auto-merge**; the human flips the last switch (responsibility doesn't transfer).

The naive loop and the reviewed loop differ by four lines of constraint — and that's the difference between "wakes you to a deleted test suite" and "wakes you to a clean PR."

---

### §B-6 One-line close

> The hard part of writing a loop isn't "can I write a loop," it's **defining a goal a machine can reconcile** — decidable, bounded, reconciliation-based. The controller must be deterministic and external; keep judgment and the standard with the human; the system tends toward entropy, so maintain it.
> **A loop only rewards someone who has already thought it through. Count on it to think for you, and it will happily think wrong, with you, at scale.**

---

### §B-7 Lineage

> Lineage: Wiener's two-level feedback (*The Human Use of Human Beings*, 1950) for the judgment/execution split and red lines; the plan/build/judge pattern from Anatoli's *Loops explained* and Addy's *Loop Engineering*.
> Mechanism layer (how to wire the loop architecture): see **本技能 §C**。This skill does not re-implement mechanism; it covers goal definition and runaway prevention only.

---

# §C 模式层 — 选哪种循环形态、怎么编排

### §C 头部适配映射表（正文原样保留处 → DSH 原语）

| ECC 宿主设施（正文原样保留处） | DSH 对位 |
|---|---|
| `claude -p`（非交互单步调用） | de_session spawn 子会话（任务书=完整提示词，跑完收报告）；或同会话分步执行；或 pwsh 后台任务 |
| `--model opus/sonnet/haiku` 模型路由 | agent_roles 档位路由（LOW/MEDIUM/HIGH）；spawn 前跑 agent_roles action=tiers 以当次回显为准，禁止任何形式的越档显式指定（2026-09-26 用户规则） |
| `--allowedTools` 读写面限制 | 只读角色（explore/code-reviewer 等）+ 任务书权限边界（可写实施 / 只读评审） |
| Task 工具并行 sub-agents | de_session spawn 多角色子会话（错峰启动；并发≤3 只约束开启瞬间） |
| `.claude/commands/infinite.md` 斜杠命令 | 不移植（依赖 ECC 命令面）；DSH 对位=workflow 工具（用户显式要求时）或组织者分批编排 |
| shell for 循环串起循环体 | pwsh 直跑循环体 + 每轮调 de_session spawn（沙箱内 node 管道捕获 EPERM——子进程输出用 fd stdio 或落盘中转） |
| SHARED_TASK_NOTES.md 跨迭代上下文 | 落盘状态文件（loop-state/ 或任务书指定路径）+ memory 工具（项目轨）；快照纪律见**本技能 §A-2** |
| jj/Jujutsu worktree 隔离 | git worktree，或按任务书「单写者所有权」做文件面隔离 |
| 全状态持久化到 SQLite、断点续跑 | 落盘 JSON 快照（loop-state/index.json）+ memory 项目轨 + 交接文档（session-handoff 技能） |
| `gh pr create` / CI 轮询合并队列 | 组织者合成 + 分块 git commit 检查点（用户分块检查点纪律）；push 需用户批准，不自动 push |

## §C-1 Sequential Pipeline (`claude -p`)

**The simplest loop.** Break daily development into a sequence of non-interactive `claude -p` calls. Each call is a focused step with a clear prompt.

### Core Insight

> If you can't figure out a loop like this, it means you can't even drive the LLM to fix your code in interactive mode.

The `claude -p` flag runs Claude Code non-interactively with a prompt, exits when done. Chain calls to build a pipeline:

```bash
#!/bin/bash
# daily-dev.sh — Sequential pipeline for a feature branch

set -e

# Step 1: Implement the feature
claude -p "Read the spec in docs/auth-spec.md. Implement OAuth2 login in src/auth/. Write tests first (TDD). Do NOT create any new documentation files."

# Step 2: De-sloppify (cleanup pass)
claude -p "Review all files changed by the previous commit. Remove any unnecessary type tests, overly defensive checks, or testing of language features (e.g., testing that TypeScript generics work). Keep real business logic tests. Run the test suite after cleanup."

# Step 3: Verify
claude -p "Run the full build, lint, type check, and test suite. Fix any failures. Do not add new features."

# Step 4: Commit
claude -p "Create a conventional commit for all staged changes. Use 'feat: add OAuth2 login flow' as the message."
```

### Key Design Principles

1. **Each step is isolated** — A fresh context window per `claude -p` call means no context bleed between steps.
2. **Order matters** — Steps execute sequentially. Each builds on the filesystem state left by the previous.
3. **Negative instructions are dangerous** — Don't say "don't test type systems." Instead, add a separate cleanup step (see [De-Sloppify Pattern](#c-5-the-de-sloppify-pattern)).
4. **Exit codes propagate** — `set -e` stops the pipeline on failure.

### Variations

**With model routing:**

```bash
# Research with Opus (deep reasoning)
claude -p --model opus "Analyze the codebase architecture and write a plan for adding caching..."

# Implement with Sonnet (fast, capable)
claude -p "Implement the caching layer according to the plan in docs/caching-plan.md..."

# Review with Opus (thorough)
claude -p --model opus "Review all changes for security issues, race conditions, and edge cases..."
```

**With environment context:**

```bash
# Pass context via files, not prompt length
echo "Focus areas: auth module, API rate limiting" > .claude-context.md
claude -p "Read .claude-context.md for priorities. Work through them in order."
rm .claude-context.md
```

**With `--allowedTools` restrictions:**

```bash
# Read-only analysis pass
claude -p --allowedTools "Read,Grep,Glob" "Audit this codebase for security vulnerabilities..."

# Write-only implementation pass
claude -p --allowedTools "Read,Write,Edit,Bash" "Implement the fixes from security-audit.md..."
```

---

## §C-5 The De-Sloppify Pattern

**An add-on pattern for any loop.** Add a dedicated cleanup/refactor step after each Implementer step.

### The Problem

When you ask an LLM to implement with TDD, it takes "write tests" too literally:
- Tests that verify TypeScript's type system works (testing `typeof x === 'string'`)
- Overly defensive runtime checks for things the type system already guarantees
- Tests for framework behavior rather than business logic
- Excessive error handling that obscures the actual code

### Why Not Negative Instructions?

Adding "don't test type systems" or "don't add unnecessary checks" to the Implementer prompt has downstream effects:
- The model becomes hesitant about ALL testing
- It skips legitimate edge case tests
- Quality degrades unpredictably

### The Solution: Separate Pass

Instead of constraining the Implementer, let it be thorough. Then add a focused cleanup agent:

```bash
# Step 1: Implement (let it be thorough)
claude -p "Implement the feature with full TDD. Be thorough with tests."

# Step 2: De-sloppify (separate context, focused cleanup)
claude -p "Review all changes in the working tree. Remove:
- Tests that verify language/framework behavior rather than business logic
- Redundant type checks that the type system already enforces
- Over-defensive error handling for impossible states
- Console.log statements
- Commented-out code

Keep all business logic tests. Run the test suite after cleanup to ensure nothing breaks."
```

### In a Loop Context

```bash
for feature in "${features[@]}"; do
 # Implement
 claude -p "Implement $feature with TDD."

 # De-sloppify
 claude -p "Cleanup pass: review changes, remove test/code slop, run tests."

 # Verify
 claude -p "Run build + lint + tests. Fix any failures."

 # Commit
 claude -p "Commit with message: feat: add $feature"
done
```

### Key Insight

> Rather than adding negative instructions which have downstream quality effects, add a separate de-sloppify pass. Two focused agents outperform one constrained agent.

---

## §C-6 Ralphinho / RFC-Driven DAG Orchestration

**The most sophisticated pattern.** An RFC-driven, multi-agent pipeline that decomposes a spec into a dependency DAG, runs each unit through a tiered quality pipeline, and lands them via an agent-driven merge queue. Created by enitrat (credit: @enitrat).

### Architecture Overview

```
RFC/PRD Document
 │
 ▼
 DECOMPOSITION (AI)
 Break RFC into work units with dependency DAG
 │
 ▼
┌──────────────────────────────────────────────────────┐
│ RALPH LOOP (up to 3 passes) │
│ │
│ For each DAG layer (sequential, by dependency): │
│ │
│ ┌── Quality Pipelines (parallel per unit) ───────┐ │
│ │ Each unit in its own worktree: │ │
│ │ Research → Plan → Implement → Test → Review │ │
│ │ (depth varies by complexity tier) │ │
│ └────────────────────────────────────────────────┘ │
│ │
│ ┌── Merge Queue ─────────────────────────────────┐ │
│ │ Rebase onto main → Run tests → Land or evict │ │
│ │ Evicted units re-enter with conflict context │ │
│ └────────────────────────────────────────────────┘ │
│ │
└──────────────────────────────────────────────────────┘
```

### RFC Decomposition

AI reads the RFC and produces work units:

```typescript
interface WorkUnit {
 id: string; // kebab-case identifier
 name: string; // Human-readable name
 rfcSections: string[]; // Which RFC sections this addresses
 description: string; // Detailed description
 deps: string[]; // Dependencies (other unit IDs)
 acceptance: string[]; // Concrete acceptance criteria
 tier: "trivial" | "small" | "medium" | "large";
}
```

**Decomposition Rules:**
- Prefer fewer, cohesive units (minimize merge risk)
- Minimize cross-unit file overlap (avoid conflicts)
- Keep tests WITH implementation (never separate "implement X" + "test X")
- Dependencies only where real code dependency exists

The dependency DAG determines execution order:
```
Layer 0: [unit-a, unit-b] ← no deps, run in parallel
Layer 1: [unit-c] ← depends on unit-a
Layer 2: [unit-d, unit-e] ← depend on unit-c
```

### Complexity Tiers

Different tiers get different pipeline depths:

| Tier | Pipeline Stages |
|------|----------------|
| **trivial** | implement → test |
| **small** | implement → test → code-review |
| **medium** | research → plan → implement → test → PRD-review + code-review → review-fix |
| **large** | research → plan → implement → test → PRD-review + code-review → review-fix → final-review |

This prevents expensive operations on simple changes while ensuring architectural changes get thorough scrutiny.

### Separate Context Windows (Author-Bias Elimination)

Each stage runs in its own agent process with its own context window:

| Stage | Model | Purpose |
|-------|-------|---------|
| Research | Sonnet | Read codebase + RFC, produce context doc |
| Plan | Opus | Design implementation steps |
| Implement | Codex | Write code following the plan |
| Test | Sonnet | Run build + test suite |
| PRD Review | Sonnet | Spec compliance check |
| Code Review | Opus | Quality + security check |
| Review Fix | Codex | Address review issues |
| Final Review | Opus | Quality gate (large tier only) |

**Critical design:** The reviewer never wrote the code it reviews. This eliminates author bias — the most common source of missed issues in self-review.

### Merge Queue with Eviction

After quality pipelines complete, units enter the merge queue:

```
Unit branch
 │
 ├─ Rebase onto main
 │ └─ Conflict? → EVICT (capture conflict context)
 │
 ├─ Run build + tests
 │ └─ Fail? → EVICT (capture test output)
 │
 └─ Pass → Fast-forward main, push, delete branch
```

**File Overlap Intelligence:**
- Non-overlapping units land speculatively in parallel
- Overlapping units land one-by-one, rebasing each time

**Eviction Recovery:**
When evicted, full context is captured (conflicting files, diffs, test output) and fed back to the implementer on the next Ralph pass:

```markdown
## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING

Your previous implementation conflicted with another unit that landed first.
Restructure your changes to avoid the conflicting files/lines below.

{full eviction context with diffs}
```

### Data Flow Between Stages

```
research.contextFilePath ──────────────────→ plan
plan.implementationSteps ──────────────────→ implement
implement.{filesCreated, whatWasDone} ─────→ test, reviews
test.failingSummary ───────────────────────→ reviews, implement (next pass)
reviews.{feedback, issues} ────────────────→ review-fix → implement (next pass)
final-review.reasoning ────────────────────→ implement (next pass)
evictionContext ───────────────────────────→ implement (after merge conflict)
```

### Worktree Isolation

Every unit runs in an isolated worktree (uses jj/Jujutsu, not git):
```
/tmp/workflow-wt-{unit-id}/
```

Pipeline stages for the same unit **share** a worktree, preserving state (context files, plan files, code changes) across research → plan → implement → test → review.

### Key Design Principles

1. **Deterministic execution** — Upfront decomposition locks in parallelism and ordering
2. **Human review at leverage points** — The work plan is the single highest-leverage intervention point
3. **Separate concerns** — Each stage in a separate context window with a separate agent
4. **Conflict recovery with context** — Full eviction context enables intelligent re-runs, not blind retries
5. **Tier-driven depth** — Trivial changes skip research/review; large changes get maximum scrutiny
6. **Resumable workflows** — Full state persisted to SQLite; resume from any point

### When to Use Ralphinho vs Simpler Patterns

| Signal | Use Ralphinho | Use Simpler Pattern |
|--------|--------------|-------------------|
| Multiple interdependent work units | Yes | No |
| Need parallel implementation | Yes | No |
| Merge conflicts likely | Yes | No (sequential is fine) |
| Single-file change | No | Yes (sequential pipeline) |
| Multi-day project | Yes | Maybe (continuous-claude) |
| Spec/RFC already written | Yes | Maybe |
| Quick iteration on one thing | No | Yes (NanoClaw or pipeline) |

---

## §C-7 选型决策树（DSH 原语选项树——替代原件「Choosing the Right Pattern」决策矩阵）

```
任务是单一聚焦改动？
├─ 是 → 会话内直接做，不建循环（别为一步活建循环）
└─ 否 → 有已写好的规格/RFC（或已过 requirement-interview / consensus-plan）？
 ├─ 是 → 需要多单元并行实现？
 │ ├─ 是 → §C-6 DAG 编排：de_session spawn 分层并行（错峰启动）
 │ │ + 组织者合成 + 分块 commit 检查点
 │ └─ 否 → §C-1 顺序流水线：de_session spawn 逐步串行
 └─ 否 → 需要同一件事的很多变体（批量生成）？
 ├─ 是 → 有界批量：workflow 工具（用户显式要求时）
 │ 或组织者分批 spawn（必须附停止条件）
 └─ 否 → §C-1 顺序流水线 + §C-5 ai-slop-cleaner 清理遍
定时/巡检类（无终点、维持状态）→ pwsh 后台心跳任务 + 本技能 §A
 （loop-status 快照 + 退出码 + 熔断）
到期触达类 → Windows 计划任务（用户终端代建）+ dtodo 挂到期项
跨回合目标续跑 → create_goal / goal 工具（达目标即停）；ralph 仅在用户显式要求 fresh-agent 迭代时用
```

配套判据：任何循环启动前必须有 max-runs / max-cost / max-duration / completion-signal 之一落盘为停止条件（§C-8 硬门）；DSH 侧补充两条——消耗额度的批量循环先出成本核算书；批量并行 spawn 前跑 agent_roles action=tiers 确认档位。

## §C-8 硬门与反模式（#1 为硬门判据；#2-#6 为反模式条目，配 DSH 落点）

1. **Infinite loops without exit conditions** — Always have a max-runs, max-cost, max-duration, or completion signal.
2. **No context bridge between iterations** — Each `claude -p` call starts fresh. Use `SHARED_TASK_NOTES.md` or filesystem state to bridge context.
3. **Retrying the same failure** — If an iteration fails, don't just retry. Capture the error context and feed it to the next attempt.
4. **Negative instructions instead of cleanup passes** — Don't say "don't do X." Add a separate pass that removes X.
5. **All agents in one context window** — For complex workflows, separate concerns into different agent processes. The reviewer should never be the author.
6. **Ignoring file overlap in parallel work** — If two parallel agents might edit the same file, you need a merge strategy (sequential landing, rebase, or conflict resolution).

## §C-9 References

| Project | Author | Link |
|---------|--------|------|
| Ralphinho | enitrat | credit: @enitrat |
| Infinite Agentic Loop | disler | credit: @disler（本移植未含该节，§3 未移植） |
| Continuous Claude | AnandChowdhary | credit: @AnandChowdhary（本移植未含该节，§4 未移植） |
| NanoClaw | ECC | `/claw` command in ECC repo（本移植未含该节，§2 未移植） |
| Verification Loop | ECC | `skills/verification-loop/` in ECC repo |

DSH 侧关联（合并版更新）：本技能 §A 机制层三段式/ 本技能 §B 判断层/ ai-slop-cleaner（已装，清理遍执行体，§C-5）/ session-handoff。

---

# §D 部署与触发说明（合并版新增节，非源件内容）

## §D-1 部署名与替换关系

- **部署名 = `agent-loop`**（frontmatter `name`）。单一技能承载三层：§A 机制层 / §B 判断层 / §C 模式层。
- 本件**取代**原三个技能目录：`agent-loop`（机制层）、`loop-design-check`（判断层）、`autonomous-loops`（模式层）。三者内容已全量并入本件。
- 部署纪律：把本件 `SKILL.md` 落到技能根的 `agent-loop/` 目录；**原 `loop-design-check/` 与 `autonomous-loops/` 目录必须同时移除或归档**——否则两个技能目录与合并件的 description 触发词重叠，同一请求会同时命中两件，回到合并前的问题（且判断层/模式层内容出现双副本漂移风险）。
- DSH 技能根扫描 rank（本机事实）：项目 `.dsh/skills` / `.agents/skills` → 用户 `~/.dsh/skills` → `~/.agents/skills`；技能目录监听实时失效重发布，采纳/落盘后当前运行中的会话即可拾取替换版，无需重启。
- 落盘位置在工作区外（如 `~/.agents/skills/agent-loop/`）时，DSH 沙箱需 `danger-full-access` 提权；标准作业模式=工作区内改好 → 校验 → 一次性提权拷回 → SHA256 双侧比对。

## §D-2 触发词覆盖（三技能合并后的完整触发面）

| 来源 | 中文触发词 | English triggers |
|---|---|---|
| 源 1 机制层 | 起循环、跑长任务、心跳巡检、循环卡死、熔断、loop 快照、退出码、回合上界 | autonomous loop, loop status, loop guard, watchdog, circuit break a loop, heartbeat chain, stale loop detection, stop condition |
| 源 2 判断层 | 写 loop、设计 loop、做一个 loop、检查 loop 对不对、loop 体检、loop 会不会跑飞、可判定目标、五个崩法、plan build judge | design an agent loop, write a loop, check a loop, loop review, prevent a runaway loop, goal-oriented loop, decidable goal, plan/build/judge |
| 源 3 模式层 | 循环模式、流水线、DAG 编排、拆任务并行、清理遍、deslop、循环硬门、选型树 | loop pattern, sequential pipeline, DAG orchestration, de-sloppify pass, bounded loop, merge queue |

上述词表全部写入 frontmatter `description`（单行、值内引号一律用单引号以保 YAML 安全）。

## §D-3 加载后怎么用（三层路由）

1. **要起一个循环**（长任务/多轮迭代）→ 先读 §B-3 Step 0 四条件门判断「该不该建」，再读 §B-3 Step 1 定可判定目标与边界条件。
2. **选形态** → §C-7 选型决策树（单会话直做 / 顺序流水线 / DAG 并行 / 有界批量 / 定时巡检 / 到期触达 / 跨回合目标）。
3. **起跑前** → §A-1 三查 + 停止条件落盘（§A-1.2 硬门，四形态至少其一）；骨架照 §A-1.3。
4. **跑起来之后** → 每轮覆盖写快照（§A-2.1）；心跳回合四动作（§A-2.2）；间隔按 §A-4.2；挂 §A-4.3 长尾保险。
5. **怀疑跑飞/卡死** → §A-3 3 轮无落盘增量熔断 + 上报；同时用 §B-4 五崩法逐行过一遍循环设计本身。
6. **收尾** → 退出码三态（§A-2.3）；红线（§B-4 三条）决定「能不能全自动」；交付验收仍按项目既有纪律（落盘 + 广播双条件）。

## §D-4 外部依赖（保持跨技能引用，不并入本件）

| 技能/工具 | 用途 | 本件引用处 |
|---|---|---|
| ai-slop-cleaner | 清理遍执行体（五类 slop、质量门、writer/reviewer 分离） | §C-5、§C-8 #4 |
| subagent-clarify | 澄清前置（崩法 #4 的抗体链路） | §B 头部交叉引用 |
| requirement-interview / consensus-plan | 规格前置（拆 DAG 前要有规格） | §C-6 RFC Decomposition、§C-7 |
| session-handoff | 阶段交接与断点续跑 | §C-6 Key Design Principles #6、映射表 |
| memory-consolidate / memory decay | 崩法 #5 陈旧记忆的抗体 | §B-4 #5 |
| de_session / de_broadcast / job_output / agent_roles / dtodo / create_goal / ralph / workflow | DSH 运行时原语（映射表对位目标） | §A 头部映射表、§B 头部映射表、§C 头部映射表、§C-7 |

## §D-5 保真与维护纪律

- **全量保真**：三源每个实质小节在合并版中均有落点；未删内容。
- **跨技能引用内部化**：源件中所有「见 loop-design-check 技能 / 见 agent-loop 技能 / 见 autonomous-loops 技能」类引用均已改写为「本技能 §X」；对外部技能（ai-slop-cleaner 等）的引用保持不变。
- **节号即接口**：本件节号（§A-1.2 / §A-2.3 / §A-3 / §B-3 / §B-4 / §C-5 / §C-8 等）被正文多处交叉引用；改动节号必须同步改写全部引用点。
- **源 3 上游滞后风险**：ECC 上游已把 canonical 换为 `continuous-agent-loop`（见「溯源」节 upstream-retired）；如将来在本机移植 `continuous-agent-loop`，模式层应与其对齐后择优合并，勿双份并存。
