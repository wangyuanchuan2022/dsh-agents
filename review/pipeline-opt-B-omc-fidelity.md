# 流程优化审查 · B 向：OMC 原版对照与移植保真度

> 审查员：Critic（critic，HIGH 档）· 会话 session-9d8a5e69-9a5c-4d72-9bd5-ede4a6495985
> 审查日期：2026-09-13 · 工作区 D:\tools\deepsek_harness · 只读评审
> **裁定：REVISE**（19 角色译制质量高，但运行时派生与工作流技能两处失守；P0×2 + P1×10）

---

## 〇、方法基座（重要前提修正）

任务书给出的定位线索里有一条降级预案：「若本地无 OMC 完整源码：以 macae-analysis 的机制清单与映射表为基准做对照，并在报告显著注明『原版全文缺失，结论限于内部一致性对照』」。

**该降级预案未启用，也不必启用。** 实测本机存在 OMC 完整源码快照：

| 侧 | 路径 | 实测 |
|---|---|---|
| OMC 原版 | `omc-analysis\oh-my-claudecode-main\` | 完整仓库（39 个技能目录、19 个 agent、docs/adr/benchmarks/src 全在），`CLAUDE.md` 标 `OMC:VERSION:5.4.0` |
| DSH 侧 | `dsh-agents\`（19 角色 + 4 工作流技能）、`port-kit\`（5 直译技能 + task-brief-v2.md） | link: 安装入 profile web |

因此本报告是**逐字两侧对照**，不是内部一致性对照。可信度显著高于任务书预期。

### 链条完整性验证（先证"对照的底本是真的"）

评审前先证明 DSH 侧留档的英文原文与真 OMC 逐字节相同，否则后续一切对照无效：

```
review/original/<id>.md  vs  omc-analysis/.../agents/<id>.md
19/19  SHA256 完全一致（字符数逐条相同）
```

**角色集合完整性（本报告最强的一条正面结论）**：OMC `agents/` 目录**恰好 19 个文件**，与 dsh-agents 的 19 个角色**集合完全相等**（`only-in-OMC` 与 `only-in-DSH` 均为空）。也就是说 19 角色不是"挑选"，而是 OMC 实际 agent 名册的**全量**。OMC `AGENTS.md` 的 `<agent_catalog>` 里还列着 `style-reviewer`、`api-reviewer`、`product-manager` 等，但那些**在仓库里不存在对应文件**（见 P2-4），属 OMC 自身的过时目录项。

---

## 一、预判预测 vs 实际（Pre-commitment）

动手前（读任何被评审文件之前）我记下的 5 个最可能出问题区域：

| # | 预判 | 实际结果 |
|---|---|---|
| 1 | 中文译文会因"中文比英文短"被误判为精简，真正的漏译藏在长文件里 | **部分不符**——19 篇段标签 0 缺失、bullet 数无一减少；真正的漏译**不在译稿里**，而在译稿→运行时的派生环节（P0-1） |
| 2 | Claude Code 专属工具残留（TodoWrite/lsp_*/tmux）会大量留在正文 | **不符**——残留绝大多数位于 `【适配：】` 标注或"用 X（对应原 Y）"式句子里，DSH 动作在前、原提法在后。qa-tester 的 14 处 tmux 命中**全部**已映射为 `run_in_background`+`job_output`+`job_kill` |
| 3 | 技能移植会违反映射表规则（用户 2026-09-12 立的纪律） | **命中**——5 个技能只有 1 个（requirement-interview）在头部写了映射**表**，其余 3 个是单行散文（P1-7） |
| 4 | 数值阈值会在"直译"过程中被悄悄改写 | **命中且分两侧**——角色人格侧数值零漂移（我逐条核过 critic 的 10-100/7 次/3-5/5-7/<1%）；**工作流技能侧**出现 5→3（P1-2）与占位符字面化（P1-9） |
| 5 | 声称"直译 OMC 组合"的工作流技能会与实际组合名册不符 | **命中**——4 个工作流技能里 3 个名册有替换/缺失，其中 2 个已自披露、1 个未披露（P2-4/P2-5、P1-4） |

**未预判到、但影响最大的一条**：运行时产物（`personas/`）**不等于**经用户批准的译稿（`review/trans/`）。我原以为二者是同一份东西，实测 19 篇**哈希全不相同**。

---

## 二、严重度口径

任务书给的三类 shorthand 是 `P0=会致误操作的残留 / P1=明确漂移或违规精简 / P2=无害可留`。实际评审中发现的最严重缺陷**不属于"残留"**，而属于"运行时产物残缺"——它会真实改变已部署角色的行为。因此本报告的口径做一次显式泛化，并在此声明：

- **P0** = 会致误操作或使**已部署产物残缺/畸形**，必须在流水线再次投入使用前修掉
- **P1** = 明确语义漂移或违规精简，影响有界、修复成本低
- **P2** = 无害可留（卫生/措辞/一致性）

凡降级/升级均在第五节「裁决理由」中报告 Realist Check 过程。

---

## 三、P0（阻塞，先修）

### P0-1 · `personas/document-specialist.md` 运行时被静默截断，丢失 3 整节 + 输出格式

**DSH 侧证据**

- `dsh-agents/personas/document-specialist.md` —— 文件**以 `<Output_Format>` 一行结束**，其后什么都没有
- 标签出现次数：OMC 原版 **28** → 运行时 persona **16**
- 运行时缺失整节：`<Failure_Modes_To_Avoid>`（全文）、`<Examples>`（含 `<Good>`/`<Bad>`）、`<Final_Checklist>`（全文）
- 同时丢失 `<Output_Format>` 的**标签体**与 `</Output_Format>`、`</Agent_Prompt>` 两个闭合标签 → 注入子会话的是一段**未闭合且无输出契约**的 XML

**根因（三段链条，全部实测）**

1. `dsh-agents/tools/install-personas.mjs:44-46`
   ```js
   for (let i = start + 1; i < lines.length; i++) {
     if (/^##\s/.test(lines[i])) { end = i; break }
   }
   ```
   终止条件是"译文小节后**第一个行首 `## ` 行**"，而非 BRIEF 规定的固定小节名。
2. 触发点 `dsh-agents/review/trans/document-specialist.md:78` —— `## 调研：[查询]` 位于 `<Output_Format>`（第 77 行起）**内部**。
3. OMC 原版侧 `dsh-agents/review/original/document-specialist.md:44` 把标题压在同一行：
   `<Output_Format> ## Research: [Query]`
   译者按 BRIEF 第七节缺省决策表（"原文有排版噪声（表格塌陷、空标签）→ 按语义复原结构"）合法地拆成独立行 —— **该拆行本身完全忠实，我判定译稿无过**；错的是宿主提取器用行首锚定去切语义小节。

**影响**：被部署的只读角色「文档专家」运行在残缺人格上——没有输出格式模板（拿不到 `### 发现 / ### 版本说明 / ### 建议的下一步` 结构）、没有失败模式清单（"无引用""博客优先""陈旧信息"等 6 条自律全部失效）、没有收尾自检。且**完全静默**：没有断言、没有测试、日志只打印字符数与哈希。

**【改进点】**
1. `tools/install-personas.mjs:44-46` —— 终止条件改为只认 BRIEF 规定的两个小节名（`/^##\s*适配清单\s*$/` 或 `/^##\s*译制说明\s*$/`），不再用通用 `^##\s`；
2. 同脚本第 88 行 `installed += 1` 之前**加一条安装期断言**：`persona 标签出现次数 == trans 译文段标签出现次数`，不等则 `exit 1` 且不落盘（本次缺陷可被该断言 100% 捕获）；
3. 重跑 `node tools/install-personas.mjs`（`tools/approved.json` 已授权）后复核 `document-specialist` 标签数回到 28。

**同类风险（已量化，非猜测）**：我检查了全部 19 篇 OMC 原版中"标签与 `## ` 同行"的压缩排版，**只有 document-specialist L44 一处**；19 篇 trans 中也只有它有第 4 个 H2。所以这是一次**已发生的单点故障**，而非当前潜伏的普遍缺陷。但 BRIEF 明确要求译者拆解 OMC 的单行压缩排版，提取器又用行首锚定——**两条规则天然对立**：任何一次重译或 OMC 上游更新只要再出现一个压缩标题，就会再次静默截断。修复应做在**提取器**（加断言），而不是要求译者避免写标题。

---

### P0-2 · requirement-interview 新增"主会话直接执行"路径，与紧随其后的硬规则互斥

**DSH 侧证据** `port-kit/skills/requirement-interview/SKILL.md`

- `:330` `## Phase 5：执行桥`
- `:335` `2. **直接执行（spawn 执行会话）**——按 spec 写任务书 spawn 执行会话`
- `:336` `3. **主会话直接执行**——小任务主会话按 spec 实现`  ← **多出来的第 4 个选项**
- `:339` `**硬规则**：选定执行路径后必须走所选技能/会话，**不得直接闷头实现**——本技能是需求技能，不是执行技能。`

**OMC 原版侧证据** `omc-analysis/oh-my-claudecode-main/skills/deep-interview/SKILL.md`

- `:518-520` 第 5 个选项是 `Refine further`（继续访谈），**共 5 个选项，不含"主会话直接实现"**
- `:522` `**IMPORTANT:** On explicit execution selection, **MUST** invoke the chosen skill via `Skill()`. Do NOT implement directly. The deep-interview agent is a requirements agent, not an execution agent.`

**影响**：`选项 3` 授权主会话自己写码，正是 OMC 明令禁止的角色越界（requirements agent 动手改源码）；同一页 `:339` 又禁止"直接闷头实现"。DSH 子会话读到两条互斥指令，取哪条都有一半文本依据。**并且它连自己的映射表都不一致**——同文件 `:18` 的映射行写的是执行选项"收敛为「共识精化 / 直接执行 / 继续访谈」"三项，正文却出现四项。

这是本轮唯一一条**能直接导致误操作**的语义漂移（需求访谈会话未授权即改源码），因此置于 P0。

**【改进点】**
1. 删除 `requirement-interview:336` 选项 3；若要保留"小任务"通道，改写为"小任务 → 仍按 `:335` spawn 一个执行会话（轻量任务书）"，使 `:334-337` 与 `:339` 一致；
2. 在 `:18` 映射表中的 `Skill()` 行补一句"DSH 侧执行选项固定为三项，不含主会话自实现"，防止再次漂移。

---

## 四、P1（明确漂移或违规精简）

### P1-1 · 任务书打印的人格哈希与人格文件自报的 `body_hash` 是两个哈希域（19/19 全部不一致）

**DSH 侧证据**

- `dsh-agents/lib/persona.js:71` —— `const hash = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8).toUpperCase()`：哈希对象是**整个文件**（含 frontmatter）
- `dsh-agents/lib/taskbook.js:112` —— `` L.push(`- 人格文件：personas/${role.id}.md（sha256:${persona.hash}）`) ``
- `dsh-agents/tools/install-personas.mjs:65` —— `const hash = createHash('sha256').update(body, 'utf8')...`：哈希对象**只是正文**
- `dsh-agents/personas/critic.md:10` —— `body_hash: B10A3920`

**实测（19/19）**：`declared == sha256(raw)` → **全部 False**；`declared == sha256(body)` → **全部 True**。

**第一手证据**：本次派给我的任务书正文写着「人格文件：`personas/critic.md`（sha256:**39140894**）」，而该文件第 10 行自报 `body_hash: **B10A3920**`。**39140894** = sha256(整文件)，**B10A3920** = sha256(正文)。

**影响**：`persona.js:9-10` 自述"任务书头部带哈希前缀，事后能判断某个会话用的是哪一版人格"，但**按文件里写的字段去核对，19/19 都会得到"不匹配"**——审计者无法区分"人格被改过"与"两个哈希定义不同"。溯源机制名存实亡。

**【改进点】** 二选一：(a) `lib/persona.js:71` 改为对 `body` 求哈希（与 `install-personas.mjs:65` 同域）；(b) 把 frontmatter 字段改名 `raw_hash`，并在 `dsh-agents/README.md` 写明两个哈希各自覆盖什么。推荐 (a)，改动一行且使任务书哈希可直接与 persona 文件字段比对。

---

### P1-2 · agent-autopilot Phase 3 QA 循环上限 5→3，且丢失"同错重复 3 次即早停"

- **DSH**：`dsh-agents/skills/agent-autopilot/SKILL.md:51` —— 「不绿 → 失败清单回 Phase 2 派 executor/debugger 修 → 重跑。**循环上限 3 轮**，仍不绿 → 停下如实上报，不带病进 Phase 4。」
- **OMC**：`omc-analysis/.../skills/autopilot/SKILL.md:104-105` —— `Repeat up to **5** cycles` / `Stop early if the same error repeats **3** times (indicates a fundamental issue)`

**影响**：重试预算被砍 40%；"同一错误重复 3 次"这条**根因升级信号**完全消失——恰恰是"根本性问题"该被及早识别上报的场景，现在会被当成普通失败继续烧循环。

**【改进点】** `agent-autopilot/SKILL.md:51` 恢复 ≤5 轮并补回"同一错误重复 3 次即停并上报"条款；在技能头部映射表标注该阈值为 OMC 原文值。

---

### P1-3 · agent-autopilot Phase 4 缺 architect 视角，verifier 顶替，合取门变分级门

- **DSH**：`agent-autopilot/SKILL.md:54-57` —— code-reviewer + security-reviewer 并行 + verifier 取证；过门条件 = `P0 全清、P1 有处置方案、verifier 证据齐全`
- **OMC**：`skills/autopilot/SKILL.md:107-111` —— `Architect: Functional completeness` / `Security-reviewer: Vulnerability check` / `Code-reviewer: Quality review` / **`All must approve; fix and re-validate on rejection`**

**影响**：①「功能完整性」这一视角在 DSH 侧无人负责（verifier 做的是证据核验，不是功能完备性评审）；② OMC 的"三者全部批准"**合取门**被换成 P0/P1 **分级门**——一个 P0 全清但功能明显不完整的实现可以过门。

**【改进点】** `agent-autopilot/SKILL.md:54` 补派 `architect`（HIGH，只读）承担 functional completeness；若不补，则显式写明"architect 视角由 verifier 吸收"，并在技能头部映射表登记该替换（当前是静默替换）。

---

### P1-4 · agent-autopilot Phase 5 内容被整体替换且未披露

- **DSH**：`agent-autopilot/SKILL.md:59-62` —— git-master 分块提交 + 可选 writer 文档 + 角色回收核对报告
- **OMC**：`skills/autopilot/SKILL.md:113-115` —— `Phase 5 - Cleanup: Delete all state files on successful completion`（删 `.omc/state/autopilot-state.json`、`ralph-state.json`，并 `Run /oh-my-claudecode:cancel`）

**影响**：六阶段**骨架**与阶段名 1:1 保留（这点做得好，见覆盖表），但 Phase 5 的**内容**整套换掉。OMC 那套是纯宿主状态清理，DSH 无 `.omc/` 状态机，删除属合法映射——但按 BRIEF 第四节规则 2 应"照译 + `【适配：DSH 无此项…】` 标注"，此处是**静默删除 + 新增**，且技能头部只有一句 `> 结构移植自 OMC autopilot 六阶段`，无映射表。

**【改进点】** 在 `agent-autopilot/SKILL.md:9` 之后补一张 OMC→DSH 映射表（至少含 Phase 5 状态清理→无对应、companyContext→无对应、`Task(...)`→`agent_spawn`），并注明 Phase 5 为 DSH 重写。

---

### P1-5 · consensus-plan 丢失 OMC 的 "Apply improvements" 整个子流程（含 changelog）

- **DSH**：`port-kit/skills/consensus-plan/SKILL.md:65` —— step 6 只写「Critic 通过后计划标 **pending approval**…最终计划必须含 ADR」
- **OMC**：`omc-analysis/.../skills/plan/SKILL.md:116-120` —— `6. **Apply improvements**: When reviewers approve with improvement suggestions, merge all accepted improvements into the plan file before proceeding.` 含四小步：a 收集双方改进建议 / b 去重分类 / c 更新计划文件 / d **在计划末尾记 changelog 说明应用了哪些改进**
- **口径依据**：`skills/ralplan/SKILL.md:69` —— `Follow the Plan skill's full documentation for consensus mode details.` 即 ralplan 是薄别名，**共识模式的权威规格在 plan 技能里**

**影响**：reviewer 在 APPROVE 同时给出改进建议时（OMC 明确覆盖的正常路径），DSH 侧没有"合并已接受改进"的步骤——建议被静默丢弃，且无 changelog 可追溯哪些被采纳。

**【改进点】** `consensus-plan/SKILL.md:65` 之后补 step 6 的 a-d 四小步；或在技能头部改口径为"只移植 ralplan 的 140 行，不覆盖 plan 技能的共识规格"，并同步 `:8` 的"全量移植"措辞。

---

### P1-6 · consensus-plan 丢失"绝不直接实现"的绝对约束

- **DSH**：全文 grep `绝不直接|never implement` → **ABSENT**
- **OMC**：`skills/ralplan/SKILL.md:65` —— `... invoke Skill("oh-my-claudecode:team") for parallel team execution (recommended) or Skill("oh-my-claudecode:ralph") for sequential execution **-- never implement directly**`；`skills/plan/SKILL.md:130`、`:131` 各一次 `Do NOT implement directly.`

**影响**：DSH 侧只剩 `:11` 的"pending approval 前禁止改源码"与 `:11` 的"禁止 spawn 实现任务"，覆盖不了 **批准之后**由规划者自己实现这条路径——而 OMC 恰恰是在"批准后调用执行技能"这一步写的禁令。

**【改进点】** `consensus-plan/SKILL.md:66`（用户选执行路径那一步）补一句「**绝不直接实现**：计划批准后必须交 `agent_spawn`/`de_session` 执行会话，规划会话不改源码」。

---

### P1-7 · 技能头部映射表落实度 1/5（用户 2026-09-12 纪律）

| 技能 | 头部设施映射 | 形态 | 覆盖缺口 |
|---|---|---|---|
| `requirement-interview` | `:11-20` **8 行表格** ✓ | **合规** | 未覆盖 `companyContext`/`omc.jsonc`（见 P2 类缺口） |
| `consensus-plan` | `:8` 单行散文 | 不合规 | **未覆盖 `AskUserQuestion`**（正文 `:61` 裸用）；未覆盖 ralplan **状态生命周期**整节（`plan/SKILL.md:85-92`）的静默删除 |
| `ai-slop-cleaner` | `:8` 单行散文 | 不合规 | 仅覆盖 Ralph→goal 循环；正文**无** Claude 专属残留，实质达标 |
| `visual-verdict` | `:8` 单行散文 | 不合规 | 正文残留 `{{ARGUMENTS}}`（`:79`）未标注 |
| `subagent-clarify` | `:8` 血统声明 | 不适用 | **非 OMC 移植对象**（见覆盖表），无需映射表 |

**关于 consensus-plan 的状态生命周期**：`plan/SKILL.md:85-92` 有整节 `State lifecycle`（含"handoff 时不可用 `state_clear`，它会写入 30 秒 cancel 信号、关闭所有模式的 stop-hook 强制"这类高风险说明）。DSH 无 stop hook，删除属合法；但按 BRIEF 规则应"照译 + `【适配：DSH 无此项】`"，实际是**零披露删除**。

**【改进点】** 按 `requirement-interview:11-20` 的表格形态，给 `consensus-plan` / `ai-slop-cleaner` / `visual-verdict` 各补一张头部映射表；`consensus-plan` 的表内**必须**新增 `AskUserQuestion → ask_user_question` 与 `ralplan 状态生命周期 → DSH 无 stop hook，忽略` 两行。

---

### P1-8 · requirement-interview 丢失 Phase 0 阈值解析的阻塞性校验步（OMC 3.5）

- **DSH**：`port-kit/skills/requirement-interview/SKILL.md` —— Phase 1 的编号 `:64` 第 3 项 → `:68` 第 4 项，**没有 3.5**；且 `:68` 仍保留 OMC 自己的标号：`4. **超大上下文规范化（3.6）**`
- **OMC**：`skills/deep-interview/SKILL.md:105-108`
  ```
  3.5. **Verify Phase 0 threshold resolution is complete**:
     - Confirm the required first line has already been emitted: `Deep Interview threshold: <resolvedThresholdPercent> (source: ...)`
     - Confirm `<resolvedThreshold>`, `<resolvedThresholdPercent>`, and `<resolvedThresholdSource>` are available before continuing.
     - If any value is missing, return to Phase 0 instead of using a hardcoded threshold.
  ```

**证伪性证据**：DSH `:68` 把 OMC 的 `（3.6）` 标号**原样留着**，而它的前驱 3.5 不见了——编号断层自己暴露了这次删除（属误删而非有意精简）。

**影响**：丢掉的正是"**缺失即回 Phase 0，禁止用硬编码阈值继续**"的闸门；它与 P1-9 的硬编码缺陷构成闭环——闸门没了，硬编码就无人拦。

**【改进点】** 在 `requirement-interview/SKILL.md:65` 与 `:68` 之间补回 3.5 三条原文（确认首行已输出 / 确认三值可用 / 任一缺失即回 Phase 0）。

---

### P1-9 · requirement-interview 阈值占位符被写成字面量，与自身"机械带入"规则冲突

- **DSH**：`:56`「阈值默认 **0.2**，用户可在任何时刻**口头改**」+ `:60`「阈值与来源**机械地带入**后续所有环节：状态 JSON、每轮报告、spec 元数据」；但——`:83-84` 状态模板写死 `"threshold": 0.2, "threshold_source": "默认"`；`:100`/`:102` 公告模板写死 `≤20%（来源：默认）`
- **OMC**：`skills/deep-interview/SKILL.md:131-132` `"threshold": <resolvedThreshold>` / `"threshold_source": <resolvedThresholdSource>`；`:151-153` `<resolvedThresholdPercent>`

**影响**：用户按 `:56` 允许的方式把阈值口头改成 0.15 后，状态 JSON 与每轮公告**仍然写 0.2 / 默认**。该技能自己声明的"机械带入"被自己的模板推翻，跨会话恢复会读到错误阈值，且公告误导用户。

**【改进点】** `:83-84`、`:100`、`:102` 改回占位符 `<resolvedThreshold>` / `<resolvedThresholdSource>` / `<resolvedThresholdPercent>`。

---

### P1-10 · agents 目录缺 `.agents/skills` 与 `roles.js` 的 `description` 逐字声明不符

见 P2-1（同源，因影响极低并入 P2，此处仅作交叉索引，避免同一问题两处计分）。

---

## 五、P2（无害可留 / 卫生）

1. **`dsh-agents/lib/roles.js:33` 的"逐字"声明对 4 篇不成立** —— 注释写「`description` 为 OMC 原文（逐字）」，实测 `analyst` / `planner` / `architect` / `executor` 删掉了 OMC frontmatter 的 `(Opus)`/`(Sonnet)` 后缀（roles.js:46/51/56/65 vs OMC `agents/<id>.md` frontmatter），而 `designer`/`writer`/`critic` 等**保留**了 `(Sonnet)`/`(Haiku)`/`(Opus)`。**同族字段两种处理**。模型信息已在 `omcModel` 字段单列，功能影响为零。**【改进点】** 要么补齐 4 篇后缀，要么把注释改为"description 取自 OMC 原文，模型后缀已剥离并记入 omcModel"。
2. **`agent-autopilot/SKILL.md:16` 与 `:17` 完全重复** —— 「派活前过 `agent_taskbook`（或人工三问）：这事该这个角色做吗 / 它有工具数据吗 / 是不是要它做做不到的副作用。」整行出现两次。**【改进点】** 删掉 `:17`。
3. **`visual-verdict/SKILL.md:79` 残留 `任务：{{ARGUMENTS}}`** —— OMC 原版 `:77` 同形（`Task: {{ARGUMENTS}}`），属照译；但 `{{ARGUMENTS}}` 是 Claude Code 技能参数替换占位符，DSH 技能加载不做替换。会照字面出现在子会话上下文里。**判定：无害死文本**（真正的任务来自任务书），但按 BRIEF 第四节规则 2 应加 `【适配：DSH 无参数替换，忽略此行】`。**【改进点】** 同左。
4. **`agent-review-squad` 的"直译"措辞** —— description 称「OMC「Code Review」组合的 DSH 直译」，但 OMC `AGENTS.md` 该组合列的是 `style-reviewer + code-reviewer + api-reviewer + security-reviewer`，而这四个里**有两个在 OMC 仓库中不存在 agent 文件**（`agents/` 恰好 19 个，无 `style-reviewer.md`/`api-reviewer.md`）。替换为 `critic` 属被迫，且 critic 是合适的质量闸门。**判定：措辞不精确，实质合理**。**【改进点】** description 改为"参照 OMC Code Review 组合，因 OMC 名册无 style/api reviewer，改以 critic 作汇总裁决"。
5. **`agent-bugfix` 的"直译"措辞** —— OMC `Bug Investigation` 组合为 `explore + debugger + executor + test-engineer + verifier`，DSH 五角色为 `explore → debugger(→tracer) → test-engineer → verifier`：**executor 被 debugger 顶替、新增 tracer**。该替换已在 `:41` 自披露（"executor→此处由 debugger 亲自小修"），比 P2-4 处理得更诚实。**【改进点】** description 的"直译"改为"参照 OMC Bug Investigation 组合（executor 环节由 debugger 承担）"。
6. **`ai-slop-cleaner/SKILL.md:89` 把 OMC 的"韩文"扩为"中文/韩文"** —— OMC `:102` 为 `**Korean readability:** ... Korean body copy generally needs at least 14px`，DSH 写成「**可读性**：正文 11-12px 要质疑；**中文/韩文**正文一般至少 14px」。规则适用范围被**加宽**（条件变宽型漂移），对中文用户方向合理但不是原版语义。**【改进点】** 改为「韩文正文…（本机语境下中文正文同适用）」，把原版语义与本地扩展分开写。
7. **`ai-slop-cleaner/SKILL.md:39` 示例保留不存在的路径** —— 「合适：`ai-slop-cleaner skills/ralph/SKILL.md skills/ai-slop-cleaner/SKILL.md`」。DSH 技能库中有 `ralph` **工具**，但工作区不存在 `skills/ralph/SKILL.md` 该路径。**【改进点】** 换成 DSH 实存路径（如 `dsh-agents/skills/agent-autopilot/SKILL.md`）。
8. **`port-kit/docs/task-brief-v2.md:29` 漏掉 OMC broad-request 四判据之一** —— OMC `AGENTS.md`：`A request is broad when it uses vague verbs without targets, names no specific file or function, touches 3+ areas, or is a **single sentence without a clear deliverable**.` DSH 只取了前三（「只有模糊动词、无具体目标、跨 3+ 领域」），第四判据缺失；且 `areas` 译作「领域」略偏（OMC 指代码区域/模块）。**【改进点】** 补第四判据；`areas` 改「代码区域」。
9. **personas 把 OMC 原始 frontmatter 当正文注入** —— 例 `personas/critic.md:13-19`：注入体开头是一段 YAML（`name:` / `model: opus` / `level: 3` / `disallowedTools: Write, Edit`），与文件头部已正确映射的 `tier: HIGH` / `omc_model: opus` **重复**。注入文本自称 `model: opus`，而实际由 DSH 钉死为 deepseek-flash。**判定：无害死文本**（模型不会自我切换），且 `disallowedTools: Write, Edit` 对只读角色是正向强化。**【改进点】** `install-personas.mjs` 在写 body 前剥掉第二段 frontmatter（保留在 `review/trans/` 供审计）。
10. **`verifier` / `document-specialist` 的 `【适配：】` 写在 frontmatter 值内部** —— `review/trans/verifier.md:14`、`review/trans/document-specialist.md:14` 写成 `disallowedTools: Write, Edit【适配：Write/Edit → 禁用 write/edit 工具…】`，而 `explore`/`analyst`/`architect` 的同一行是干净的。无行为后果（`lib/persona.js:20-33` 只剥外层元数据块，内层整段作为惰性文本进入提示词；只读约束真正来自 `lib/roles.js` 的 `readonly: true`）。**【改进点】** 统一注解位置到 Constraints 段，frontmatter 值保持干净。
11. **运行时 persona 保留了一段在 DSH 下不可达的模式描述，且其"存疑"披露被安装器剥掉** —— `personas/code-reviewer.md:210`（源自 `review/trans/code-reviewer.md:206`）写着「当以 `model=haiku` 被调用做轻量级纯风格检查时，code-reviewer 还会覆盖代码风格关注点：」，OMC 原版 `:198` 为 `When invoked with model=haiku for lightweight style-only checks...`。**关键点**：译者对此**已正确且诚实地披露**——`trans/code-reviewer.md:269` 存疑处②写明「是 OMC 按模型档位切换行为范围的机制——本插件把 code-reviewer 钉死 HIGH（opus），该模式在 DSH 下的触发条件存疑，照译保留，删留由用户批准环节决定」。但该披露位于「译制说明」小节，而 `tools/install-personas.mjs:39-48` **按设计只保留「## 译文」**，于是：**评审者看得到这条存疑说明，运行时子会话看不到**——部署出来的 code-reviewer 人格带着一处无法触发的模式描述（`roles.js:81` 已把该角色钉死 HIGH），却没有任何 `【适配：】` 提示。**判定：无害死文本（P2）**——它是一条条件性描述而非可执行动作，且其下 checklist 仍可执行；但它同时揭示了「译制说明里的存疑项随安装被剥离」这一结构性副作用（见第六节第 2 条）。**【改进点】** 在 `trans` 侧把「DSH 钉死 HIGH，本模式不可达，忽略」写成**行内** `【适配：】` 标注（行内标注才会进 persona），与 `trans:269` 的存疑记录并存。

---

## 六、What's Missing（缺口清单，找"缺什么"而非"错什么"）

1. **无安装后完整性断言** —— `install-personas.mjs` 只打印字符数与哈希（`:83`/`:86`），不校验"译文的每个 XML 小节都进了 persona"。P0-1 正是这个空洞漏过去的。这是本次唯一一个**同时具备"高危害 + 静默 + 一行可修"**的缺口，应优先补。
2. **无 trans↔persona 一致性回归** —— `personas/` 是 `review/trans/` 的一次性派生。`body_hash` 只承诺覆盖 body，**不记录"由哪一版 trans 生成"**；若日后修订 trans 而不重跑安装，personas 会静默过期，且现有哈希机制**检测不到**。**附带的结构性副作用**：安装器按设计只保留「## 译文」（`install-personas.mjs:39-48`），因此译者写在「适配清单」与「译制说明」里的**存疑记录与映射依据在运行时全部消失**——只有写成行内 `【适配：】` 的内容才进 persona。P2-11（code-reviewer 的 `model=haiku` 模式）正是这个副作用的实例：评审者读得到存疑说明，运行时子会话读不到。**建议**：在 BRIEF 与安装器之间确立一条规则——凡影响运行时行为的存疑项**必须**写成行内标注，不得只写在译制说明里。
3. **无 OMC 版本锚** —— 5 个技能头部都写了 `v5.4.0`（我核过行数声明，`ai-slop-cleaner` 145 行、`visual-verdict` 77 行**均准确**），但 **19 张角色卡只有 `source: oh-my-claudecode/agents/<id>.md (MIT)`，没有版本号或提交号**。无法判定对照的是哪一版上游；OMC 更新后也无从做差异审计。
4. **无"OMC 组合 → DSH 工作流"的替换登记** —— 4 个工作流技能声称对应 OMC 组合，但**没有任何一处列出被替换/删除的角色**（agent-bugfix 在正文 `:41` 提了一句，agent-autopilot 完全没提）。
5. **5 个直译技能无统一映射表模板** —— 只有 requirement-interview 自建了表格，其余各写各的散文。
6. **未评估项（诚实标注）** —— OMC `skills/deep-interview` 的 `<Good>`/`<Bad>` 理由句有 4 条未译（属解释性散文，非指令，我同意不计缺陷）；`agents/<id>.md` 之外 OMC 还有 `generated/prompt-ssot/`、`docs/agent-templates/` 等提示词 SSOT 来源，本报告未对照，**不排除**上游 SSOT 与本报告所用 `agents/` 快照存在版本差。

---

## 七、Ambiguity Risks（歧义风险）

- **`consensus-plan/SKILL.md:8`**：「`autoresearch 桥 → 无，删除`」→ 理解 A：OMC ralplan 正文有此桥、DSH 删除；理解 B：指 plan 技能里的桥。
  - 实测：ralplan 全文 140 行**不含** autoresearch（我 grep 过），该行指向的是 `plan/SKILL.md` 的内容。
  - **选错理解的风险**：读者会以为"ralplan 的内容已全部覆盖"，从而不去读 plan 技能的共识规格——而 P1-5 的漏译就藏在那里。
- **`agent-bugfix/SKILL.md:8`**：`> 编排 5 角色：explore → debugger（疑难升级 tracer）→ test-engineer → verifier` 与 description「编排 dsh-agents 的 5 个 sub agent」→ 理解 A：5 个角色含 tracer；理解 B：description 里的 5 个应含 executor。
  - 实测：名册含 tracer、不含 executor（executor 环节由 debugger 承担）。
  - **选错理解的风险**：按 description 去编排会找不到 executor 环节，误以为流水线缺一环。

---

## 八、Multi-Perspective Notes（计划/技能评审：执行者 / 干系人 / 怀疑者）

- **执行者视角**：「只凭这里写的内容，我真的能照做吗？」—— 两处会卡住：`visual-verdict:79` 的 `{{ARGUMENTS}}` 不知填什么（无害但会愣一下）；`requirement-interview:336` 的"主会话直接执行"与 `:339` 的"不得直接闷头实现"互斥，执行者必须自行裁决。**其余技能步骤均可无提问执行**——工作流技能的产物路径、双条件完成标准、心跳兜底都写得可执行。
- **干系人视角**：「这解决了所述问题吗？」—— 本轮审的是**纪律执行情况**。结论是分层的：19 角色译制（纪律的第一层）执行得相当好（结构 0 缺节、数值逐条保住、映射标注规范）；但纪律的**落点**（映射表、全量保真）在两处失守：技能映射表 1/5、persona 派生无完整性校验。好消息是修复成本极低（补表 + 加一条断言 + 改 3 处字面量），收益是溯源链真正可信。
- **怀疑者视角**：「这个方案会失败的最强论据是什么？」—— 最强的反驳是"**P0-1 只影响 document-specialist，而它不在任何一条工作流流水线上**"。我核实了这条反驳：agent-autopilot 派 explore/analyst/planner/architect/executor/debugger/test-engineer/verifier/code-reviewer/security-reviewer/git-master/writer；agent-feature 派 analyst/planner/executor/test-engineer/code-reviewer/verifier；agent-bugfix 派 explore/debugger/tracer/test-engineer/verifier；agent-review-squad 派 code-reviewer/security-reviewer/critic/code-simplifier —— **确实都不派 document-specialist**。它的可达路径是 `personas/explore.md:45` 的显式升级路由（"改走 document-specialist"）与人工 `agent_spawn`。**该反驳成立**，我已据此在第五节做 Realist Check（见下），但仍保留 P0 评级，理由已列明。

---

## 九、保真度覆盖表（19 角色 + 4 工作流技能 + 5 直译技能，逐行结论，无抽样）

### 9.1 19 角色（`review/original` ↔ `review/trans` ↔ `personas` 三段）

| # | 角色 | 档位 | 结构（段标签） | 语义 | 运行时 persona | 判定 |
|---|---|---|---|---|---|---|
| 1 | explore | LOW | 15/15 | 保真（2 轮/200/500/limit 100/5 文件阈值全保住） | 30/30 标签 | **保真** |
| 2 | analyst | HIGH | 16/16 | 保真（100x 断言、"不交回 architect"、Open_Questions 禁写全强度） | 32/32 | **保真** |
| 3 | planner | HIGH | 16/16 | 保真（3-6 步、一次一问、交接前强制用户确认、≥2 方案+作废理由） | 32/32 | **保真** |
| 4 | architect | HIGH | 16/16 | 保真（强制取上下文、4 阶段、3 次失败熔断、反橡皮图章） | 32/32 | **保真** |
| 5 | debugger | MEDIUM | 15/15 | 保真（先复现、熔断、最小 diff <5%、11 条失败模式） | 34/34 | **保真** |
| 6 | executor | MEDIUM | 15/15 | 保真（最小可行 diff、独干+≤3 只读探索、禁顺手重构、完成前 grep） | 30/30 | **保真** |
| 7 | verifier | MEDIUM | 15/15 | 保真（PASS/FAIL/INCOMPLETE + VERIFIED/PARTIAL/MISSING、5 条立即驳回、30 分钟陈旧证据） | 30/30 | **保真**（P2-10 注解位置不一致） |
| 8 | tracer | MEDIUM | 17/17 | 保真 | 36/36 | **保真** |
| 9 | code-reviewer | HIGH | 22/22 | 保真 | 46/46 | **保真** |
| 10 | security-reviewer | HIGH | 18/18 | 保真 | 36/36 | **保真** |
| 11 | critic | HIGH | 16/16 | 保真（我独立复核：10-100 倍 / 7 次 / 3-5 / 5-7 / 3 场景 / <1% / 3 条以上 MAJOR 逐条对齐） | 40/40 | **保真** |
| 12 | code-simplifier | HIGH | 7/7 | 保真 | 14/14 | **保真** |
| 13 | test-engineer | MEDIUM | 16/16 | 保真（金字塔 70/20/10） | 32/32 | **保真** |
| 14 | designer | MEDIUM | 16/16 | 保真（`#F4F1EA`、"3-4 方向"、显式品牌意图覆盖领域默认） | 32/32 | **保真** |
| 15 | writer | LOW | 14/14 | 保真（写作遍与独立评审遍分离存活） | 28/28 | **保真** |
| 16 | qa-tester | MEDIUM | 14/14 | 保真（14 处 tmux **全部**映射为 run_in_background/job_output/job_kill/Test-NetConnection；3000/30s 阈值保住） | 28/28 | **保真** |
| 17 | git-master | MEDIUM | 14/14 | 保真（3+/5+/10+ 文件分批阈值、last 30 commits、--force-with-lease、禁 rebase main） | 28/28 | **保真** |
| 18 | **document-specialist** | MEDIUM | 译稿 14/14 | 译稿保真 | **28→16 标签，缺 3 节 + 输出格式** | **不保真 —— P0-1** |
| 19 | scientist | MEDIUM | 14/14 | 保真（variance**0.5、n=2,340、71%/53%/18 点、40 观测全保住） | 28/28 | **保真** |

**角色侧小结**：19 篇译稿的段标签覆盖 **19/19 零缺失**；bullet 数 19/19 **无一减少**（均为 +3%~+20%，来自拆行与适配标注）；`personas` 头部 9 个溯源字段（role/name/tier/omc_model/level/readonly/source/approved/body_hash）**19/19 齐全**。缺陷集中在**派生环节 1 篇**与**哈希域 1 处**，不在译稿本身。

### 9.2 4 个工作流技能（`dsh-agents/skills/`）

| 技能 | 对应 OMC | 保真判定 | 一句话依据 |
|---|---|---|---|
| `agent-autopilot` | `skills/autopilot` 六阶段 | **部分保真（P1-2/3/4）** | 六阶段名与跳过条件 1:1（Expansion/Planning/Execution/QA/Validation/Cleanup ↔ 扩展/规划/执行/QA/验证/收尾；ralplan→连跳 Phase1、deep-interview spec→当 Phase0 产物，均对齐），但 QA 阈值 5→3、Phase 4 缺 architect、Phase 5 内容被替换 |
| `agent-feature` | `AGENTS.md` Feature Development 组合 + team 四阶段 | **基本保真（P2）** | 六角色链与 OMC 组合逐个对齐（analyst→planner→executor→test-engineer→code-reviewer→verifier）；team 五阶段中的 team-fix 被并进步骤 4 的"循环 ≤2 轮"，语义覆盖但未点名 |
| `agent-bugfix` | `AGENTS.md` Bug Investigation 组合 | **基本保真（P2-5）** | explore→debugger→test-engineer→verifier 对齐，executor 由 debugger 顶替且已在 `:41` 自披露，新增 tracer 为增强而非删减 |
| `agent-review-squad` | `AGENTS.md` Code Review 组合 | **基本保真（P2-4）** | code-reviewer+security-reviewer 并行盲评+critic 汇裁是合格替代；OMC 该组合的 style/api reviewer 在 OMC 仓库内无 agent 文件，替换被迫，仅"直译"措辞不精确 |

### 9.3 5 个直译技能（`port-kit/skills/`）

| 技能 | OMC 对照物 | 规模比 | 保真判定 | 一句话依据 |
|---|---|---|---|---|
| `requirement-interview` | `skills/deep-interview`（802 行） | 14657/47851 = 0.31 | **部分保真（P0-2、P1-8/9）** | **机制数值几乎全保**（0.2 阈值、40/30/30 与 35/25/25/15 两组权重、3/10/20 轮限、R4/R6/R8 挑战激活与 >0.3 本体家门、>50% 更名规则、±0.05×3 停滞、0.9 捷径全对齐），但漏 3.5 阻塞校验、阈值占位符字面化、多出主会话直接执行路径 |
| `consensus-plan` | `skills/ralplan`（140 行）+ `skills/plan` 共识节 | 3890/10962 = 0.36 | **部分保真（P1-5/6/7）** | ralplan 数值全保（原则 3-5/top3 驱动/≥2 方案/预演 3 场景/≤5 轮/≤15 有效词/门信号 11 行表逐行对齐），但缺 plan 技能的 Apply improvements 子流程与"绝不直接实现"、无头部映射表 |
| `ai-slop-cleaner` | `skills/ai-slop-cleaner`（145 行） | 3128/7413 = 0.42 | **保真（P2-6/7）** | 10 个小节全对应、6 项 UI/设计清单全、4 遍清理顺序全、writer/reviewer 分离全；仅"韩文→中文/韩文"扩宽与 ralph 示例路径失效 |
| `visual-verdict` | `skills/visual-verdict`（77 行） | 2373/2433 = 0.98 | **保真（P2-3）** | 7 个小节全对应、JSON 契约形状逐字一致、score 0-100 与 ≥90 通过线保住；仅 `{{ARGUMENTS}}` 未加映射标注 |
| `subagent-clarify` | **无 OMC 同名原版** | — | **非移植对象** | OMC `skills/` 共 39 个技能目录，**无 `subagent-clarify`**；该技能 `:8` 如实声明"移植自 MACAE 的工具级 HITL 与 OMC 的 AskUserQuestion failure-mode guard"，血统陈述诚实 |

> **对任务书前提的一处更正**：任务书称这 5 个技能"声明「全量移植自 OMC 同名」"。实测**只有 4 个**这样声明（ai-slop-cleaner / requirement-interview / consensus-plan / visual-verdict），`subagent-clarify` **没有**如此声明，其自述血统为 MACAE + OMC failure-mode guard。故对它按"非移植对象"评估，不计保真度缺陷。

---

## 十、映射表落实度矩阵（第 4 类·加分项）

| 对象 | 规则要求 | 实测 | 判定 |
|---|---|---|---|
| 19 张角色卡头部 | 说明 OMC 出处与档位映射 | `personas/*.md:1-11`：`source: oh-my-claudecode/agents/<id>.md (MIT)` + `tier` + `omc_model` + `level` + `readonly` + `approved` + `body_hash`，**19/19 齐全** | **合规** |
| 19 角色的工具映射表 | （BRIEF 基线）映射表写在头部 | 角色卡内**不放**映射表，改由**任务书**注入 13 行完整表（`lib/taskbook.js:16-30` `TOOL_ADAPTATION` → `:192` 输出为「八、Claude Code → DSH 工具映射」表格）。**本次派给我的任务书即含该表** | **合规**（设计选择：映射随任务书下发而非随人格固化） |
| `requirement-interview` | 映射表写在技能头部 | `:11-20` 8 行表格 | **合规** |
| `consensus-plan` | 同上 | `:8` 单行散文；漏 `AskUserQuestion` 与状态生命周期 | **不合规（P1-7）** |
| `ai-slop-cleaner` | 同上 | `:8` 单行散文；正文无 Claude 残留，实质达标 | **形态不合规（P1-7，低危）** |
| `visual-verdict` | 同上 | `:8` 单行散文；正文残留 `{{ARGUMENTS}}` | **不合规（P1-7 + P2-3）** |
| `subagent-clarify` | 同上 | `:8` 血缘声明 | **不适用** |

**小结**：头部落度 **1/5 合规 + 3/5 散文形态 + 1/5 不适用**。修复成本极低（照 `requirement-interview:11-20` 抄模板），这是投入产出比最高的一项改进。

---

## 十一、Verdict Justification（裁决理由）

**裁定：REVISE**。不是 REJECT——19 角色译制的核心资产质量高且经得起逐字核对，P0-1 是**派生机器的缺陷**而非译稿缺陷，修好提取器 + 重跑一次即恢复完整，不需要重译任何一篇。也不是 ACCEPT-WITH-RESERVATIONS——P0-1 让一个**已部署**角色运行在残缺人格上且完全静默，P0-2 让需求技能会话可能越界改源码，两者都应在流水线再次投入使用前修掉。

**运作模式：THOROUGH → ADVERSARIAL（部分升级）**。起手 THOROUGH。触发升级的条件是"指向系统性问题的模式"而非条目数：在阶段 2-4 中发现"**纪律的落点集中在派生与技能边界两处**"这一模式（映射表 1/5、persona 派生无校验、4 个工作流技能中 3 个名册有替换）后，我在剩余部分主动扩大范围到**相邻未被点名的对象**——正是这一步让我去查了 `lib/persona.js` 的哈希域（P1-1）、`tools/install-personas.mjs` 的提取器（P0-1 根因）、以及 19 篇 OMC 原版的压缩排版（P0-1 的类风险量化）。三处都产出了实质发现。

**Realist Check（对每条 P0/P1 做现实严重度压力测试）**

- **P0-1 保留 P0（考虑过降为 P1）**。压力测试：① 现实最坏情况 = 文档专家产出无结构、跳过 6 条失败模式自律与 5 项自检——不是数据丢失/安全/资金；② 缓解因素**真实存在**：我核实 4 条工作流流水线**都不派** document-specialist，爆炸半径被限制在 `personas/explore.md:45` 的升级路由与人工 spawn；③ 发现速度 = **静默**，无断言无测试无监控；④ 未受"狩猎模式偏差"影响（这是首个发现，不构成势头）。按校准规则"缓解因素实质控制爆炸半径 → 降级"，本应降为 P1；**我保留 P0 的理由**：(a) 产物本身**畸形**（未闭合 `<Output_Format>`、无输出契约、缺 `</Agent_Prompt>`），会真实改变该角色行为；(b) 静默检测；(c) 提取器缺陷**结构性可达**——BRIEF 要求拆解 OMC 压缩排版、提取器却用行首锚定，两条规则对立，任何重译或上游更新都会再触发。**若组织者认为"未上主流水线"足以降级，P0-1 可视为 P1 处理，但我建议先修。**
- **P0-2 保留 P0，未降级**。压力测试：该漂移**不在**缓解因素覆盖范围内——requirement-interview 是 `agent-autopilot:31`、`agent-feature:41` 都会路由到的前置技能，且风险落在"源码被未授权修改"这一不可静默回滚的后果上。发现虽容易（同页两行矛盾），但后果类型属"越界写盘"。
- **P1-1 未降级**。压力测试：现实最坏情况 = 审计者困惑、耗时，非实质损害；但它是**溯源机制本身失效**（19/19 恒定不匹配），且修复一行。不涉数据/安全/资金 → 按规则本可降为 P2；**我保留 P1** 的理由：它不是"某条记录不准"，而是"该机制在所有实例上都不成立"，且当前任务书正在向每个子会话打印这个错误哈希（本次即发生），继续扩散会把错误的核对基线固化。
- **P1-2 / P1-3 / P1-4 未降级**：阈值与验证视角的改动直接影响"缺陷能否被拦住"，且 agent-autopilot 是四条流水线里最重的一条，无测试/监控可兜底。
- **P1-5 ~ P1-10 未降级**：均为有界但有据的漂移/精简，修复成本低，且都落在用户 2026-09-12 立的两条纪律（全量保真、映射表写头部）的正面射程内。

**自审结果（Self-Audit）**：本轮**无发现被移入 Open Questions**——每条 P0/P1 都有两侧 `文件:行号` 与原文引用，且 P0-1 的根因链、P0-2 的互斥文本、P1-1 的哈希双域、P1-8 的编号断层（`:68` 保留 OMC 的 `（3.6）` 标号而 3.5 消失）均已**由我亲自复算/复读**，不是采信他人转述。特别说明：三个角色语义扫描子代理给出"19 篇全部保真、0 发现"，我**没有直接采信**——独立复算了 critic 的全部数值断言（对齐）、逐行比对 explore 的译文主体（与 trans 逐字一致）、并另行查出它们未察觉的 P0-1（它们只对照译稿，未看运行时产物）。其中一条被下游子代理报为"矛盾 OMC 禁令"的发现，我复核后发现它**漏看了紧随其后的 `:339` 硬规则**，实际形态是"自相矛盾"而非"干净漂移"——已在 P0-2 中按更强也更准的表述更正。

**升级到 ACCEPT 需要改变什么**：修掉 P0-1（改提取器 + 加安装期断言 + 重跑）与 P0-2（删选项 3）；P1-2/3 的阈值与视角恢复；三个技能补齐头部映射表。**P1-5/6/8/9/10 与全部 P2 可与 ACCEPT 并存**，但建议一并处理（合计约 10 处定点编辑）。

---

## 十二、Open Questions（不计分）

1. **OMC 上游版本锚缺失**：`review/original/` 与 `omc-analysis/oh-my-claudecode-main/` 逐字节相同，但该快照自身无提交号（`CLAUDE.md` 只有 `OMC:VERSION:5.4.0`）。若上游 5.4.0 之后已修订任一 agent 提示词，本报告的对照结论对"当前上游"是否仍成立**无法判定**。
2. **OMC 提示词 SSOT 的另一来源未对照**：仓库内存在 `generated/prompt-ssot/role-reviewer.md`、`docs/agent-templates/base-agent.md`、`docs/agent-templates/tier-instructions.md`。若 OMC 的运行时提示词由这些模板 + agent 文件合成，则 `agents/*.md` 可能不是子会话实际收到的最终形态，本报告的"保真"结论需相应收窄到"对 `agents/*.md` 保真"。**未验证，属推测性追问。**
3. **P1-1 的哈希改动方向选择**：改 `persona.js` 与否会改变已部署会话打印的哈希值。若既有审计记录里已存了旧哈希（本次任务书即一条），改域后历史与新值不可比。需要在 `README` 里留一条口径变更记录——具体要求归属组织者裁决。
4. **`grep 'style-reviewer'` 全仓检索超时（120s）未完成**：我用 `agents/` 目录枚举 + glob `**/*reviewer*` 已确证 OMC 无 `style-reviewer.md`/`api-reviewer.md` 文件，但未穷尽 `src/` 与 `docs/` 内的纯文本提及。**P2-4 的结论建立在文件枚举上，不依赖这次超时的检索。**
5. **低置信度候选（不足以计分，留此备查）**：`consensus-plan` 未收录 `plan/SKILL.md:280-288` 的 `Review Quality Criteria` 数值表（Clarity 80%+ 声称须引 file:line / Testability 90%+ 判据须具体 / Verification 所有文件引用须存在）。该表在 OMC 归属 `--review` 模式而非共识模式，ralplan 正文亦未收录，故**判定为超出口径、不计缺陷**；若组织者认为"全量移植自 ralplan"应连带覆盖其指向的 plan 技能内容，则此项应升级为 P1。

---

*报告完 · 证据基线：`review/original/`（19/19 与 OMC `agents/` 逐字节一致）+ `omc-analysis/oh-my-claudecode-main/` 完整源码 + 运行时 `personas/`。所有 P0/P1 发现均经审查员亲自复核。*
