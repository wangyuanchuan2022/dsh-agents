# 流程优化实施报告（pipeline-opt · executor）

> 执行会话：session-4659 00b3-6fd7-43ed-9096-0326fcb9c696（Executor，MEDIUM 档）
> 依据：dsh-agents\review\pipeline-opt-{A-prompt-cleanliness,B-omc-fidelity,C-runtime}.md + pipeline-opt-consolidated-decisions.md（用户 2026-09-13 处置记录）
> 范围声明：review\original\*.md 一字未动；清单外文件零改动；未 git commit（改动留待组织者验收后提交）；未安装任何依赖；全部写入经 edit/write 工具完成，pwsh 仅用于只读查询、node 语法检查与测试/安装器运行。
> 落盘说明：本文件为主副本；同文副本落 `D:\tools\deepsek_harness\agent-out\executor-20260913-0845.md`（两者逐字节一致，对齐 A 报告的 P1-3 处置惯例）。

---

## 逐条执行记录（12 步）

### 第 1 步 · 译稿文本修正（review\trans\*.md，生成物 personas 由第 11 步重新生成）

**1a. 只读卡假话修正**——「write/edit 工具被禁用」类断言统一改述为：
「本角色受只读纪律约束：除报告落盘外不得改动任何文件。注：DSH 不支持按会话禁用工具，本约束为纪律条款」。

| 文件:原行 | 原断言 | 处置 |
|---|---|---|
| trans\architect.md:38 | 「write 与 edit 工具被禁用【适配：…DSH 会话同样禁用 write/edit 工具…】」（A 报告 P0-2 指认的运行时 :42 源头） | Constraints 首句改述 ✅ |
| trans\analyst.md:37 | 「Write 与 Edit 工具被禁用【适配：…由任务书/沙箱落实禁用…】」 | 同上改述 ✅ |
| trans\analyst.md:116 | 「本 agent 的 Write/Edit 工具被禁用」（Open_Questions） | 改述 ✅ |
| trans\code-reviewer.md:45 | 「只读：write 与 edit 工具被禁用。」 | 改述 ✅ |
| trans\security-reviewer.md:38 | 「只读：write 与 edit 工具被禁用。」 | 改述 ✅ |
| trans\critic.md:54 | 「只读：Write 与 Edit 工具被禁用。【适配：…禁用约束同样生效】」 | 改述 ✅（自查补充，A 报告未点名） |
| trans\verifier.md:14 | frontmatter「禁用 write/edit 工具——验证角色只读」 | 改述 ✅（自查补充） |
| trans\document-specialist.md:14 | frontmatter「禁用 write/edit 工具——调研角色只读」 | 改述 ✅（自查补充） |
| trans\scientist.md:14 | frontmatter「默认禁改项目文件；.py 脚本属执行介质允许」 | 随 1b 一并改写 ✅ |

配套更新的适配清单/译制说明同源行：architect.md:143,157、analyst.md:134,141、code-reviewer.md:260、security-reviewer.md:205、critic.md:294、verifier.md:128、document-specialist.md:128。
**验证**：重装后 `grep '工具被禁用|被禁用【适配' personas\*.md = 0`。
**登记不改动**：trans\git-master.md:38「Task 工具与 agent 派生被禁用」属同类假话，但统一改述文本（只读纪律）不适用于可写角色——超出本步口径，留组织者裁决（P2 备案）。

**1b. scientist 卡 python_repl 沙箱条款整段改写**（A-P0-3，批次二批准）：
Role 段新文本 = 「DSH 无 python_repl 沙箱设施；数据分析以只读方式执行（node/pwsh 只读命令、读文件、stdin 管道解析），写盘仅限报告；重计算需求广播组织者裁决【适配：OMC python_repl→DSH 只读执行纪律】」。同步最小一致性改写：Success_Criteria 2 条、Constraints 6 条（import/文件 I/O/绘图/被封锁库四封锁 → 标准库默认 + 组织者裁决门）、Investigation_Protocol 第 4 步、Tool_Usage 2 条、Output_Format LIMITATION 示例、Failure_Modes 3 条、Final_Checklist 3 条、适配清单 4 行、译制说明①③（记录批准来源与废止原文）。
**一致性说明**：任务给定目标文本「写盘仅限报告」与卡内既有「脚本落盘 + pwsh 调 python」条款直接冲突；按任务文本为准，旧「脚本落盘」纪律随沙箱条款一并废止（改写处均带 2026-09-13 批准注记，可回溯）。

**1c. planner 卡「等用户 proceed」改写**（A-P0-4，批次二批准）：任务给定形态「计划完成后 write 落盘并 de_broadcast(wake:true) 回组织者，由组织者转呈用户批准；子会话不得自行等待用户输入」落到 9 处——Success_Criteria:34、Constraints:40、Investigation_Protocol:59、Execution_Policy:82-83、Output_Format:104（proceed/adjust/restart 选项整段换为 DSH 广播形态）、Failure_Modes:113-114、Final_Checklist:140-141；译制说明增补修订记录（含批准出处与逐处清单）。

**1d. effort 死条款清理**（A-P1-2，18 份 × 6 种写法）：删除全部「运行时 effort/力度 继承…本条忽略」死条款行 + 对应适配清单行；含 "effort" 字样的存活行为指引行（8 份）改词保义：「行为层 effort 指引」→「行为层力度指引」。逐处清单（改前 grep 实测 42 处）：

| 文件 | 译文死条款行 | 适配清单行 | 其他 |
|---|---|---|---|
| explore.md | :75 删 | :143 删 | — |
| analyst.md | :59 删 | :138 删 | — |
| debugger.md | :82 删 | :170 删 | — |
| tracer.md | :98 删 | :185 删 | — |
| architect.md | :72 删 | :152 删 | :73 effort→力度 |
| planner.md | :80 删 | :162 删 | :81 effort→力度 |
| test-engineer.md | :89 删 | :148 删 | :90 effort→力度 |
| designer.md | :69 删 | :136 删 | :70 effort→力度 |
| code-reviewer.md | :83 删（力度变体） | :263 删 | — |
| security-reviewer.md | :74 删（力度变体） | :211 删 | — |
| qa-tester.md | :59 删（力度变体） | :122 删 | :128 译制说明②改为删除记录 |
| executor.md | :81 删 | :148 删 | :82 effort→力度 |
| document-specialist.md | :70 删 | :136 删 | :71 effort→力度 |
| scientist.md | :61 删 | :116 删 | :62 effort→力度 |
| verifier.md | :60 删 | :133 删 | :61 effort→力度 |
| critic.md | :182 删（纯适配注） | :299 删 | — |
| writer.md | :62 删（纯适配注） | :109 删 | — |
| git-master.md | :61 删（纯适配注） | :115 删 | — |

**验证**：`grep effort review\trans\*.md` 仅剩 1 处 = qa-tester 译制说明的删除记录引文「②「Runtime effort 继承父会话」死条款已按用户 2026-09-13 批准…删除」（审计留痕，非死条款本体）；重装后 `grep effort personas\*.md = 0`。

### 第 2 步 · 技能文本

**5. B-P0-2（requirement-interview）**：删除 :336「3. 主会话直接执行——小任务主会话按 spec 实现」，:337「4. 继续访谈」改号为 3；:18 映射行改为「执行选项**固定三项**：「共识精化 / 直接执行（spawn 执行会话）/ 继续访谈」，不含主会话自实现」。
**验证**：grep `主会话直接执行` = 0 命中；`不得直接闷头实现`（:338）硬规则保留且不再与任何选项矛盾（选项清单现在只有 2 项执行 + 1 项继续访谈）。

**6. A2（agent-autopilot Phase 3/4 并行 + 基线哈希门）**：最小改写 3 处——:26 阶段门补「唯一例外」；Phase 3 节改为「基线锁定后与 Phase 4 双评审并行」（基线哈希门 = test-engineer 开工前记录 run-all 输出 + 关键文件 SHA256 落盘并 de_broadcast(wake:true) 广播组织者备案；双评审基于同一基线只读评审）；Phase 4 节改为「双评审已按并行编排开工 + verifier 凭备案基线做增量对照复验」。**未动**六阶段骨架、QA 循环上限 3 轮（:53）、Phase 4 角色清单（code-reviewer+security-reviewer+verifier）等已登记缓办项。

### 第 3 步 · 插件代码

**7. A-P0-1（lib\persona.js）**：`splitFrontmatter` 改为**循环剥块**（`while (text.startsWith('---'))`：逐块剥 `---…---` 围栏，剥后清前导换行；围栏未闭合时 break 按无 frontmatter 处理；meta 首块优先），并导出供单测。理由注记写入函数头注释（19 份双模型声明根因）。
**单测**（tests\run.mjs 新增 2 块）：含连续两段 frontmatter 的样本 → body 不含任何 frontmatter 行、首块 meta 优先；单块剥除与无 frontmatter 原样返回。

**8. B-P0-1（tools\install-personas.mjs）**：
- ① `extractPersonaBody` 终止条件由「译文小节后第一个行首 `## ` 行」（原 :44-46）改为只认行首 `## 适配清单` / `## 译制说明`（`SECTION_END` 正则）；
- ② 新增**安装期断言**：`countXmlTags(提取正文) == transPersonaRegionTags(译文段)`——对照面用整文正则独立切「## 译文」段（与提取器的逐行扫描不同实现路径），不等即 `console.error + process.exit(1)`；主循环改两遍式（先全量解析+断言，全过才统一写盘），断言失败**任何人格都不落盘**；
- ③ 附带**双 frontmatter 根除**（步骤 11 验收 `grep '^model:' personas = 0` 的必然要求，A 报告 P0-1 文件层修复）：新增 `stripLeadingFrontmatter`，安装器落盘前剥离译文段开头内嵌的 OMC 原始 frontmatter（与 persona.js 同规则；运行时循环剥块保留作兜底）；
- ④ review\BRIEF.md 第四节增补硬规则：「凡影响运行时行为的存疑项/适配说明必须写成译文行内【适配：】标注，不得只写在适配清单/译制说明（安装器只保留「## 译文」，后两者不进 persona）」并附 code-reviewer model=haiku 实例。

**9. A4（lib\taskbook.js + lib\index.js）**：
- ① `dedupeEvidencePath(path, exists?, now?)` 导出：目标已存在则追加 `-<HHmmss>` 后缀（扩展名保留、无扩展名直接追加）；`lib\index.js buildTaskbook` 在 evidencePath 解析后（显式传入或 defaultEvidencePath 生成都算）统一过一遍去重（index.js:507-508 附近）；
- ② `stamp()` 分钟→**秒**精度（`yyyyMMdd-HHmmss`），AUTO_DEFAULTS 缺省产出路径文档同步为 `<角色id>-<yyyyMMdd-HHmmss>.md`。
- **调用点核查**（改前 grep）：`stamp(` 仅 2 处消费——taskbook.js:102 任务书头部生成时间（展示用）与 index.js:135 默认产出文件名（唯一性用途，分钟精度正是撞车根因）。**无人把 stamp 当分钟精度数据依赖** → 按任务改秒，无需保留原样。单测同步更新（秒格式断言）+ 新增去重单测（同路径两次生成不撞名）。

### 第 4 步 · 测试与重新生成

**10.** `node --check` 5 个被改 js 全过：lib\persona.js / lib\taskbook.js / lib\index.js / tools\install-personas.mjs / tests\run.mjs。
测试套件 `node tests/run.mjs`（直跑，规避沙箱 pipe EPERM）：

```
dsh-agents tests: 39 passed, 0 failed   [exit 0]
```
（基线 36+ 全绿保持；本轮净增 3 块：循环剥块 ×2、dedupeEvidencePath ×1，stamp 断言随秒精度更新。）
**调试过程自证**（供审计）：首跑 2 处失败均被测试逮住——①循环剥块在围栏后空行场景漏剥第二块（`replace(/^\r?\n/)` 只剥一个换行 → 改 `replace(/^[\r\n]+/)`）；②dedupe 单测自身两处笔误（漏把 no-ext 路径放进已存在集合、期望值误带 .md）。修复后全绿。

**11.** 重跑 `node tools/install-personas.mjs`：
- 首跑断言**自证有效**：我第一版对照面实现（反向扫「最后一个收尾小节」）把适配清单表圈进了对照段，断言立即拦截 executor（31≠32）并 exit 1 不落盘——随后把对照面改为按 BRIEF 格式的整文正则独立切片后通过（断言机制本身经过了一次真实回归检验）；
- 正式安装：**19/19 全过，跳过 0，exit 0**（逐篇读数见上一步输出：document-specialist 3388 字符 / hash FE7D259C / 段标签 30）；
- document-specialist 完整性复查：30 个 XML 标签全部成对闭合，`## 调研：[查询]`（:81）位于 `<Output_Format>` 内部不再截断，`<Failure_Modes_To_Avoid>`/`<Examples>`（含 Good/Bad）/`<Final_Checklist>` 整节回归，`</Output_Format>`（:94）与 `</Agent_Prompt>`（末行）闭合；
- `grep '^model:' personas\*.md = 0`（双 frontmatter 根除）；
- `grep effort personas\*.md = 0`；`grep '工具被禁用|被禁用【适配' personas\*.md = 0`。

### 第 5 步 · 部署同步

| 源 | 目标 | 源 SHA256 | 部署 SHA256 | 判定 |
|---|---|---|---|---|
| dsh-agents\skills\agent-autopilot\SKILL.md | C:\Users\ycwan\.agents\skills\agent-autopilot\SKILL.md | 65F37B6DC8215E80729CEB727FF9EC8DAF609CAF10D1B04F3B2C69D95373AA04 | 同左 | **MATCH** |
| port-kit\skills\requirement-interview\SKILL.md | C:\Users\ycwan\.agents\skills\requirement-interview\SKILL.md | D355EDB0A3B27D6E14BBDD235EEAAECF7B4F30D67906AAF9539D7001E2C2134F | 同左 | **MATCH** |

（沙箱先拒工作区外写入 → 按既定「工作区改→提权拷回→哈希比对」流程提权重试同一命令成功。）
**lib 与 personas 生成物不拷贝**：dsh-agents 以 link: 安装（Junction），lib\*.js 与 personas\*.md 的改动随重启生效。

---

## 待 DSH 重启后活体验证清单（本次不重启）

1. persona.js 循环剥块：spawn 任意角色后核对任务书 §三 首行不再是 `name:/model: opus` 类 YAML（19 份双模型声明根除的活体证据），§一 模型声明与人格正文零冲突；
2. taskbook.js：任务书头部时间戳为秒精度（`· 20260913-HHMMSS ·`）；同路径二次派活时 evidencePath 带 `-<HHmmss>` 后缀；
3. install-personas 新断言：对任一 trans 人为插入行首 `## ` 小节跑安装应 exit 1（回归门活体演示，可选）；
4. planner / scientist 重装人格的实派行为（planner 不再「等 proceed」；scientist 只读执行纪律）。

## 偏差与备案（供评审专查）

- 【D1】安装器新增 `stripLeadingFrontmatter`：A 报告 P0-1 只点名 loadPersona 循环剥块（运行时），本报告额外在安装器落盘侧同步剥除——依据是任务步骤 11 的验收硬指标「`grep '^model:' personas\*.md` 为 0（双 frontmatter 根除）」，运行时剥块无法满足文件层 grep=0。被替换语义（文件层保留内嵌 frontmatter 供审计）原文在此留痕：审计诉求改由 review\trans\ 底稿承担。
- 【D2】scientist 卡「脚本落盘」条款随沙箱条款一并改写（见 1b 一致性说明）——任务给定文本「写盘仅限报告」与旧条款矛盾，取任务文本为准，全部改写处带批准注记。
- 【D3】git-master.md:38「Task 工具与 agent 派生被禁用」未改动（同类假话、不同工具，统一只读改述不适用），登记待裁决。
- 【D4】agent-autopilot SKILL.md:17 与 :15 的逐字重复行（A-P1-6）按处置记录属「A 向冗余清理·缓办」，未动。
- 【D5】requirement-interview 部署副本与源档的既知漂移（A 报告 P2-5：部署侧多 3 空行）本次随部署同步自然消除（部署=源逐字节拷贝）。

## 摘要

12 步全部完成：trans 层 18 份卡修正（假话 7 卡 9 处 + scientist 整段改写 + planner 9 处 DSH 化 + 42 处 effort 死条款清理）、requirement-interview 互斥选项根除、agent-autopilot P3∥P4 并行+基线哈希门、persona.js 循环剥块、install-personas 提取器修复+安装期断言+双 frontmatter 根除、taskbook 路径去重+秒精度；测试 39/39 绿；19/19 重装断言全过；两份技能部署哈希 MATCH。改动留待组织者验收后提交。
