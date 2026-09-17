# 流程优化审查 · A 向【提示词清洁度】

> 评审角色：Critic（critic，HIGH 档，只读顾问）· 会话 session-173a79f5-0638-49f4-a864-bf48f8357a65 · 2026-09-13
> 对象：dsh-agents 角色提示词系统（19 人格卡 + 4 工作流技能 + 部署副本 + 任务书模板 v2 + port-kit 五技能）
> 方法：全量读（不抽样）+ 脚本化重复检测 + 首跑转录取证（16 份任务书实测）
> 只读声明：除本报告（及任务书 §五 指定的同文副本）外，未改动、未新建任何文件；未执行 git / install / build。
>
> **落盘路径说明（本报告自身即 P1-3 的活体证据）**：任务书「完成标准①」指定 `dsh-agents\review\pipeline-opt-A-prompt-cleanliness.md`，而「交付与验收」节指定 `agent-out\critic-20260913-0759.md`（= 插件默认 evidencePath）。两者不一致，本次按 P1-3 的建议以**评审目录为主副本**、`agent-out` 落同文副本，两份内容逐字节一致。

---

## 〇、对照面清单（全量，非抽样）

| 组 | 对象 | 规模 | 读取方式 |
|---|---|---|---|
| ① | `dsh-agents/personas/*.md` 19 份 | 87,055 字符（剥离首段 frontmatter 后） | 18 份 read 全文；critic.md 经本人任务书 §三 注入体全文（同一字节源） |
| ② | `dsh-agents/skills/{agent-autopilot,agent-feature,agent-bugfix,agent-review-squad}/SKILL.md` | 17,049 字节 | read 全文 4/4 |
| ③ | `C:\Users\ycwan\.agents\skills\` 同名 4 技能 | 同上 | SHA256 比对 **4/4 全等** |
| ④ | `port-kit/docs/task-brief-v2.md` | 3,494 字节 | read 全文 |
| ⑤ | `port-kit/skills/{subagent-clarify,requirement-interview,ai-slop-cleaner,consensus-plan,visual-verdict}` | 49,269 字节 | subagent-clarify 全文；其余 4 份全节标题 + 关键段 + 与①③交叉比对 |
| ⑥ | 注入链路 | `lib/persona.js`、`lib/taskbook.js`、`lib/roles.js`、`lib/index.js`（相关段） | read + 实测合成 19 份任务书 |
| ⑦ | 首跑证据 | `merge-watermelon/agent-out/` 全部 14 份报告 + `docs/plans/*` + 16 份子会话转录 | 全量读取/检索（含 UTF-8 解码修正，见 §七 自审） |

---

## 一、预判 vs 实际（Pre-commitment）

| # | 预判（读前写下） | 实际 |
|---|---|---|
| 1 | 移植时"照译+标注"必然留下 OMC 平台机制残渣（模型名/工具名/流程门） | **命中**——残留不止注解，还有整段 frontmatter 与"按模型调用"分支（P0-1、P2-2） |
| 2 | 19 份同源文案会有大面积逐字重复 | **部分证伪**——逐字重复行仅 43 组/8,791 字符，且其中 ~8,000 是 XML 标签本身；真正的问题是**同一份任务书内**的两套映射（行内【适配】+ §八 表）与"忽略本条"死文本 |
| 3 | 任务书骨架会随 spawn 次数线性放大 token | **命中且量化**——自动骨架 2,159-2,396 字符/次，其中 §八 工具表独占 949（44%），而平均只有 4.2/13 行被该角色引用 |
| 4 | 模板 v2 会与插件自动生成节重复，组织者会抄一遍 | **命中**——v2 §2/§4/§5/§1 与 taskbook §一/§六/§五/preflight 四对重叠；首跑 executor-fix 任务书 §四 末尾逐字复述了 §五+§六+§七（实测 11,932 字符转录为证） |
| 5 | 首跑会暴露"路径治理"与"全局纪律未下沉"两类缺失 | **命中**——双落盘 5+ 份、同分钟撞车 1 次（P1-3）；H4 纪律临时补进计划（§五 缺失面 1） |
| 6 | （未预判）子会话对自己"是什么模型"存在矛盾认知 | **新发现**——P0-1，19/19 份任务书同时声明两个模型 |

---

## 二、P0（误导性 / 有害条款）

### P0-1 · 人格正文残留 OMC frontmatter，与任务书的档位路由**逐份自相矛盾**

- 定位：`dsh-agents/lib/persona.js:20-33`（`splitFrontmatter` 只剥第一段 frontmatter，`indexOf('\n---', 3)` 命中首段结尾即停）→ 每份 `personas/*.md:13-19` 的第二段 frontmatter **原样进入任务书 §三**。
- 证据（本次任务书正文）：§一 写「本会话已按该档位钉死模型 deepseek / deepseek-flash（定档依据：档位默认表）」，紧接着 §三 第一段就是 `name: critic / description: … / model: opus / level: 3 / disallowedTools: Write, Edit`。code-reviewer/security-reviewer 同段还写着 `disallowedTools: write, edit # 【适配：…】`（`personas/code-reviewer.md:18`）。
- 冗余类型：**误导性条款**（同一份提示词内两个互相否定的模型声明；`disallowedTools` 又撞上 README 的"DSH 无法禁工具"）。
- 预估节省：2,274 字符（19 份）/ 首跑 16 次 ≈ **1,900 字符**；同时消解 19 份的模型误导。
- 删除风险：**极低**——**不改 personas/ 任何文件**，只在 `loadPersona` 返回前循环剥除前导 frontmatter 块（文件层保留供审计与哈希比对，`persona.js:71` 的 body_hash 语义不变）。
- 【改进点】`lib/persona.js`：把 `splitFrontmatter` 改为 `while (text.startsWith('---'))` 循环剥除；或在 `lib/taskbook.js:125-128` 拼 §三 前 `persona.text.replace(/^---[\s\S]*?\n---\s*/, '')`。附带在 §一 增一行「人格文件里若出现 model/effort 字样，一律以本节为准」（~40 字符），把这一类残留一次性降级为无害。

### P0-2 · 只读角色卡断言"write/edit 工具被禁用"，与本插件 README 的事实陈述相反

- 定位：`personas/architect.md:42`「你是 READ-ONLY（只读）。write 与 edit 工具被禁用【适配：disallowedTools: Write, Edit → **DSH 会话同样禁用 write/edit 工具，只读边界不弱化**】」；同型表述见 `personas/code-reviewer.md:49`、`security-reviewer.md:42`、`verifier.md:18,42`、`analyst.md:41`、`document-specialist.md:18`、`scientist.md:18`。
- 反证：`dsh-agents/README.md:110`「只读角色靠文字约束，不是硬隔离：**DSH 无法按会话禁用工具**，`只读顾问` 是任务书条款而非机制」。
- 冗余类型：**误导性条款**（对工具面作事实性错误断言；architect 那行是翻译时新增的断言，不是 OMC 原文）。
- 预估节省：改写等长，token 中性；收益是消除"子会话试探 write 或误以为沙箱会拦"的认知分叉。
- 删除风险：低。**只改措辞不改约束强度**：把「工具被禁用」改为「本角色约定：除本报告外不改任何文件（DSH 不技术禁用工具，靠本条款自律）」。
- 【改进点】7 处人格的首句统一为上述措辞；或更省事——在 `lib/taskbook.js:111`（§一 权限边界行）那行末尾加「（人格细则若写『工具被禁用』，按本行语义执行：是约定不是机制）」，一次覆盖 19 份。

### P0-3 · scientist 卡把 OMC python_repl 沙箱限制当 DSH 角色纪律沿用，砍掉该角色全部实际分析能力

- 定位：`personas/scientist.md:24,41,43,44,45,46`（「绝不在分析脚本中读写文件…文件 I/O 在 OMC 沙箱中被封锁」「**DSH 中 python 虽然技术上能 import，本角色按同等强度自律，一律不 import**」「不做绘图」「只报告内置算术能算出的统计量」），并写入 `Success_Criteria`（`:37`）与 `Final_Checklist`（`:102`）。
- 事实核对：DSH 沙箱只限**工作区外写盘**，import 与工作区内文件 I/O 正常（本机 anaconda `D:\anaconda3\python.exe` 自带 pandas/numpy/zstandard，见项目关键记忆）。OMC 的 python_repl 沙箱在 DSH 中**根本不存在**。
- 冗余类型：**有害条款**——该角色被禁止读 CSV/JSON、禁止用统计库，只能对"任务里已给出的字面量"做心算级统计；`[LIMITATION]` 模板还把"置信区间需要被封锁的库"写成常态。
- 预估节省：不省（属功能修复）；4,232 字符的卡在首跑未被 spawn，问题尚未暴露。
- 删除风险：**中**——`review/BRIEF.md:87`「不要因为某节看起来是 OMC 专属就删掉——照译+标注，删减留给用户批准环节」与用户 2026-09-12 全量保真规则都要求**删减须经用户批准**，故本条列为"需用户裁决的 P0"。
- 【改进点】保留"脚本落盘 + pwsh 调 python、禁内联 `python -c`"这条**真实有效的 DSH 纪律**（`:41`），删除/改写 import、文件 I/O、绘图、第三方库四项封锁；`Success_Criteria:37` 改为「数据可经 read/pwsh 取得，脚本落盘执行」。

### P0-4 · planner 卡的 OMC 访谈/批准协议在子会话形态下无执行对象（可能空转）

- 定位：`personas/planner.md:44`「用户明确要求前（『把它变成工作计划』『生成计划』）**绝不生成计划**」、`:87`「**访谈阶段是缺省状态。仅在明确要求时才生成计划**」、`:63`「展示确认摘要，等待用户明确批准」、`:118`「永远等明确的 "proceed"」、`:144-145` Final_Checklist 同问。
- 形态冲突：DSH 里 planner 是被 spawn 的子会话，`lib/taskbook.js:173` 明令其澄清路径走 `de_broadcast` → subagent-clarify，**它拿不到用户的 "proceed"**；批准门由组织者执掌（首跑实证：`merge-watermelon/docs/plans/autopilot-merge-watermelon-plan.md:8`「状态：**approved**（方式=用户批准 + 组织者 session-1766c134 裁决回传）」）。
- 冗余类型：**误导性条款**（9 行教它等一个不会到来的信号；首跑未踩雷纯因任务书把"制定计划"写成了显式请求）。
- 预估节省：~450 字符（9 行合计），但主要收益是消除"被派活却回答『我处于访谈模式』"的停工风险。
- 删除风险：低（这些行是 OMC 主会话交互形态的产物，DSH 无对应场景）。
- 【改进点】改写为 DSH 形态：「任务书即用户的明确请求；计划呈交前的实现禁令不变；批准门由组织者执掌，本角色不等待用户信号，缺参数走 subagent-clarify」。

---

## 三、P1（明确冗余，建议删/收敛）

### P1-1 · §八 工具映射表每次全量注入 949 字符，平均只有 4.2/13 行与该角色有关

- 定位：`lib/taskbook.js:16-30`（`TOOL_ADAPTATION` 13 行）+ `:187-194`（每次无条件全量拼进 §八）。
- 实测（脚本枚举 19 份人格对 13 行"原提法"的命中）：总打印 247 行，**实际被引用 79 行（32%）**；逐角色：explore 5、analyst 3、planner 2、architect 7、debugger 4、executor 10、verifier 4、tracer 3、code-reviewer 6、security-reviewer 5、critic 4、**code-simplifier 1**、test-engineer 6、designer 5、writer 3、**qa-tester 1**、git-master 4、document-specialist 2、scientist 4。
- 叠加问题：人格正文里已有 **143 处行内【适配：…】(7,580 字符)**，与 §八 表说的是同一件事——**同一份任务书里同一信息说两遍**（§八 表 949 + 行内 ~400/次）。
- 冗余类型：**重复 + 超规范**（表本身是必要的，全量注入不是）。
- 预估节省：**~600 字符/次 → 首跑 16 次 ≈ 9,600 字符（占首跑注入 7.0%）**；库里 19 份共 ~11,400 字符不被注入。
- 删除风险：**低**——人格文件一字不动，只在合成期按 `persona.text` 命中过滤，未命中行本就不适用于该角色；`:194` 的兜底句（"提到表外工具按最接近能力替代"）已覆盖漏网。
- 【改进点】`lib/taskbook.js:192` 的循环加一行谓词：`for (const [from, to] of TOOL_ADAPTATION) if (needRow(persona.text, from)) L.push(...)`，`needRow` 用各行原提法的关键词（Bash / Glob / Grep / TodoWrite / lsp_ / ast_grep / python_repl / tmux / `.omc/` / `<remember>` / `/team` / Read|Write|Edit / AskUserQuestion|Task）做 includes 判定；判不出时**全量回退**（fail-open，宁可多不可漏）。

### P1-2 · "运行时 effort 继承"死条款：18 份各写一遍"本条忽略"，且有 6 种写法

- 定位（全部实测）：`explore.md:79`、`analyst.md:63`、`debugger.md:86`、`tracer.md:102`（变体 A）；`architect.md:76`、`planner.md:84`、`test-engineer.md:93`、`designer.md:73`（B）；`code-reviewer.md:87`、`security-reviewer.md:78`、`qa-tester.md:63`（C）；`executor.md:85`、`document-specialist.md:74`、`scientist.md:65`（D）；`verifier.md:64`（E）；`critic.md:186`、`writer.md:66`、`git-master.md:65`（F，纯适配注）。
- 性质：指令内容 = 「本机制在 DSH 不存在，请忽略本行」。**信息量 0**，还带来术语漂移（努力档位 / effort / 力度三词混用，DSH 侧实际字段是 tier+provider/model）。
- 冗余类型：**无用**（BRIEF 允许的"照译+忽略标注"，但 18 份重复 6 种写法属译制噪声）。
- 预估节省：**~110 字符/次 → 首跑 ≈ 1,760 字符**；库内 ~2,000 字符。
- 删除风险：低（`disable` 类条款删掉不影响行为；真正需要的信息——"档位由 spawn 时钉死"——已在 §一 与 §八）。
- 【改进点】整行删除（属删减，按 `review/BRIEF.md:87` 需用户批准）；若求稳，最小动作=**统一为 A 变体一句**并在 `lib/taskbook.js` §一 收口，库内省 ~1,200 字符。

### P1-3 · 首跑实证：报告双落盘 + 同分钟 spawn 路径撞车（注入合约缺陷，非组织者失误）

- 定位：`lib/index.js:131-136`（默认产出路径 `<cwd>/agent-out/<角色id>-<stamp()>.md`，`stamp()` 为**分钟精度**，见 `lib/taskbook.js:61-64`）+ `lib/taskbook.js:145-152`（§五 打印该路径，且"硬性完成标准"写"① 落盘到**上面指定路径**"）+ `skills/agent-autopilot/SKILL.md:16`（要求组织者显式给 evidencePath 并带步骤后缀）+ `port-kit/docs/task-brief-v2.md:39-45`（§5 要求组织者在任务书里再写一遍落盘路径）。
- 首跑证据：
  - 双落盘：`agent-out/executor-step4-report.md:8`、`executor-step5-report.md:8`、`executor-step6-report.md:8`、`executor-phase4-fixround-report.md:13`、`code-reviewer-phase4-report.md:298` 均声明「本报告落盘 <项目内路径>；**另按任务书 §五 指定路径落一份同文副本**」（首跑 12 份已落盘报告中 ≥5 份双写，冗余写盘 100KB+）。
  - 撞车：`agent-out/executor-20260912-2026.md:8`「**报告路径撞车登记**：任务书下发的落盘路径 `agent-out\executor-20260912-2026.md` 与 Step 2 executor 会话（session-d6815301…）的报告路径相同（两份任务书用了同一时间戳 id）」，会话靠自救把 Step 2 报告改名保全为 `-step2.md`。
  - 本报告自身：任务书同时给了 `review\pipeline-opt-A-…md` 与 `agent-out\critic-20260913-0759.md` 两条路径（=插件默认值），即**该缺陷仍在每次派活时复现**。
- 冗余类型：**重复 + 超规范**（三个权威源对"报告落哪"各说各话）。
- 预估节省：每次派活省一份报告正文的重复写入（首跑 5-13 份 × 9-32KB，≈100KB+ 写盘与对应 tool 往返）；撞车自救再省一次改名+登记+组织者对账。
- 删除风险：低。
- 【改进点】三处一处归一：① `lib/index.js:135` 默认路径加秒（`stamp()` 增 `-ss`）或落盘前做存在性检测追加 `-2`；② `lib/taskbook.js:146` 那条后加一句「任务正文若另给路径，**以任务正文为唯一正文副本**，本路径仅作组织者回收索引，不再写第二份」；③ 把 `skills/agent-autopilot/SKILL.md:16` 的防撞车条款与①②合并为单一表述。

### P1-4 · 任务书模板 v2 与插件自动生成节四处重叠，首跑已发生"再抄一遍"

- 定位（模板侧）：`port-kit/docs/task-brief-v2.md:12-15`（§1 派活前置三问）≈ `lib/taskbook.js:211-231 preflight()`；`:17-24`（§2 角色与模型档位表）≈ `taskbook.js:106-113` §一；`:31-37`（§4 澄清模式 + 缺省决策表）≈ `taskbook.js:160-176` §六 + `:50-58 AUTO_DEFAULTS`；`:39-45`（§5 产出要求★）≈ `taskbook.js:143-156` §五。
- 首跑实证（实测转录）：`session-2b8bbf91` 首条 user 消息 = 11,932 字符任务书，其中 §四（组织者正文 4,773）末尾原文写着「【完成标准双条件】① 报告 write 落盘 merge-watermelon\agent-out\executor-phase4-fixround-report.md（逐条 F1-F13 证据…）；② de_broadcast(wake:true) 发组织者 session-1766c134…。缺一即未完成。**缺信息按 subagent-clarify 协议广播问组织者，禁瞎猜。**」——与 §五/§七/§六 的自动节**逐字重复**（≈250 字符）。
- 冗余类型：**重复**（模板让组织者手写插件 Already-自动注入的字段）。
- 预估节省：~200-300 字符/次 → 首跑 ≈ 4,000 字符；更大收益是消除"两处口径分叉"（例如 §五 路径 vs 任务正文路径，即 P1-3）。
- 删除风险：低（模板是组织者的工作清单，不是被注入的提示词）。
- 【改进点】`task-brief-v2.md` 头部加一行硬规则：「§1/§2/§4/§5 由 `agent_spawn`/`agent_taskbook` **自动注入**，主会话不必手写；模板只填 §0/§3/§6/§7/§8/§9」，并把 §5 的落盘路径改成"引用 §五 的 evidencePath 参数，不另起路径"。

### P1-5 · 严重度术语双轨：人格 CRITICAL/HIGH/MEDIUM/LOW ↔ 任务书 P0/P1/P2，首跑实际只跑了一套

- 定位：`lib/taskbook.js:38-42`（review 泳道交付行强制「P0/P1/P2」）vs `personas/code-reviewer.md:37,52,101-132`（CRITICAL/HIGH/MEDIUM/LOW + APPROVE/REQUEST CHANGES/COMMENT 批准标准）、`security-reviewer.md:127-139`（Severity_Definitions + 修复时限表）。
- 首跑实证（UTF-8 校正后计数）：`code-reviewer-phase4-report.md` 中 **CRITICAL 出现 0 次**、P2 34 次；`security-reviewer-phase4-report.md` P0/P1/P2 = 3/11/47，CRITICAL/HIGH/MEDIUM/LOW 各 1 次（仅在转述清单里）。即人格里"HIGH 置信度下存在 CRITICAL 则不得批准"这套判据**在 P0/P1/P2 语境下无法执行**，~600-900 字符判据静默失效。
- 冗余类型：**重复/冲突**（同一提示词内两套严重度刻度）。
- 预估节省：不省 token（若删人格刻度可省 ~600/次，但需用户批准）；本项建议**加 1 行映射**而非删。
- 删除风险：低（映射行 token 中性）。
- 【改进点】`lib/taskbook.js:41` 那条后补「（P0=阻塞 / P1=重大 / P2=建议；人格里的 CRITICAL→P0、HIGH→P1、MEDIUM/LOW→P2）」，约 60 字符，一次性对齐 4 个评审角色。

### P1-6 · agent-autopilot SKILL.md 第 15/17 行逐字重复（编辑事故）

- 定位：`skills/agent-autopilot/SKILL.md:15` 与 `:17`——**逐字节相同**（67 字符：「派活前过 `agent_taskbook`（或人工三问）：这事该这个角色做吗 / 它有工具数据吗 / 是不是要它做做不到的副作用。」），第 16 行（报告路径防撞车）插在两者之间，属插入后未删旧行的编辑事故。
- 冗余类型：**重复**。
- 预估节省：67 字符 × 每次技能加载。
- 删除风险：零。
- 【改进点】删除 `:17`（保留 `:15`）；同时把 `:16` 的防撞车表述按 P1-3 改写为"引用 evidencePath 单一来源"。

---

## 四、P2（可选优化）

| # | 定位 | 类型 | 预估节省 | 风险 / 备注 |
|---|---|---|---|---|
| P2-1 | `personas/designer.md:46-47`（Constraints）与 `:79-85`（Domain_Aware_Defaults）——"Opus 4.7 默认家族风格 / 编辑风 vs 操作型 UI / 泛化否定式指令无效"同一套内容讲两遍 | 重复 | ~700 字符（该卡 4,594 的 15%） | 低。另：`Opus 4.7` 是 OMC 侧模型名，DSH 中 designer 钉死 MEDIUM，建议改写为"模型默认风格" |
| P2-2 | 按模型分支的残留：`code-reviewer.md:209-232`（"当以 **model=haiku** 被调用做轻量级纯风格检查时…"~700 字符）、`qa-tester.md:65`（"全面档（**opus 级**）"）、`scientist.md:67-68`、`document-specialist.md:76-77`（"haiku 档/sonnet 档"） | 无用 | ~800 字符（仅命中角色触发） | 低。DSH 档位在 spawn 时钉死、运行中不可切档（`de_session` 无换档能力），此类分支永不触发 |
| P2-3 | `document-specialist.md:45,46,57,66,67`——"DSH 无 chub/Context7 → 走 web_search"连说 5 遍 | 重复 | ~300 字符 | 低。收敛为 1 处 + 其余处只写正向做法 |
| P2-4 | XML 标签开销：19 份共 447 个 `<Xxx>`/`</Xxx>`，≈9,653 字符（首跑实际注入 ≈9,000） | 超规范 | ~3,000-4,000 字符/次（上限） | **高（不建议动）**：`review/BRIEF.md:59-61` 明令 XML 标签原样保留，删标签=改译制规范，须用户裁决 |
| P2-5 | 技能源档 ↔ 部署副本漂移：4 个 agent-* 技能 SHA256 **4/4 全等**；port-kit 侧 `ai-slop-cleaner` **源档 L23 是错字"反 slok 意图"、部署副本已修成"slop"**；`requirement-interview` 部署副本多 3 个空行（477→480 行，内容一致） | — | 0 | 低但需钉死"以哪份为准"：建议在 `port-kit/README.md` 注明"部署副本为运行准据，源档回灌需哈希校验" |
| P2-6 | 跨技能职责重叠：`consensus-plan`（Planner/Architect/Critic ≤5 轮，实测提及 architect×3/critic×2）与 agent-autopilot Phase 1；`requirement-interview` 与 analyst 人格；`ai-slop-cleaner` 与 code-simplifier 人格；`visual-verdict` 与 verifier/designer | 重复（非 token） | 0 | 低。技能按需加载不占常驻，但组织者需判据：建议照 `agent-feature/SKILL.md:41-42` 的"与 agent-autopilot 的关系"体例，给每个技能加 1-2 行"何时用哪个" |
| P2-7 | `skills/agent-autopilot/SKILL.md:23`「重试上限 2 次」与用户档案（2026-08-31 固化）重复 | 重复 | ~40 字符 | 极低，登记备查即可（技能是自包含作战手册，保留合理） |

---

## 五、缺失面（首跑暴露、提示词系统未写）

1. **全局纪律 → 项目可机检约束的"转译层"缺位（H4 事件）**
   - 事实：H4（"凡将被内联进 `index.html` 的 `src/` 文件，注释禁用 Markdown 字符"）由组织者/planner 临时补进计划（`merge-watermelon/docs/plans/autopilot-merge-watermelon-plan.md:76`，自述来源「用户 HTML 纯度纪律（2026-09-01 固化）+ Step 4 偏差 D3」）；D3 的代价见 `agent-out/executor-20260912-2026.md`（装配期 H2 机械扫描阻断、被迫最小回调）与 `code-reviewer-phase4-report.md:201`（D3 裁决 "是被 plan §三 H4 直接要求的形态约束"）。
   - 根因：用户档案的 HTML 纯度纪律**每个会话都能看到**（记忆快照注入），但没有任何角色卡/技能要求把"全局纪律"**翻译成本项目的可机械判定约束**——executor 写的是 JS 注释，看不出那也算"写入 HTML 的内容"。
   - 固化建议：**不要往 19 张卡里各抄一遍用户档案**（那是重复）；应在 `skills/agent-autopilot/SKILL.md` Phase 1/2 各加 1 行：「派活前把与本任务相关的全局纪律转译成一句可机检约束（写进计划/任务书），例：HTML 纯度 → 装配源注释禁 Markdown 字符」。
2. **报告路径治理**（P1-3）：双落盘与撞车都是"临时补丁"，应固化在**插件侧**（`taskbook.js` §五 + `index.js` 默认路径），而不是模板 v2（组织者侧），因为它是注入合约问题。
3. **"我到底跑在哪个模型上"**（P0-1 的下游）：建议 §一 增一行权威声明（~40 字符），把 19 份残留 frontmatter 的误导性一次性中和。
4. **技能加载与协议保真**：`lib/taskbook.js:173` 要求 interactive 子会话"按 `subagent-clarify` 技能协议"行事，但技能是按需加载的；首跑两次澄清实战（`autopilot-summary…:41`）走通了，靠的是任务书那 3 行摘要。建议 §六 增 1 行「首次使用前先 `skill` 加载 subagent-clarify」（~30 字符），防协议细节（wake:true、结构化三要素、15 分钟降级）在未加载时失真。
5. **反向清单（首跑未触发 ≠ 可删）**——避免误删的护栏：
   - **确证生效、不可删**：只读声明（首跑 14 份报告共出现「只读」24 次，两份评审报告开篇即"未改动任何文件"声明）；双条件完成标准（12 次引用，`autopilot-summary…:26` 记 9 个收口会话一次通过率 100%）；evidence `文件:行号` 纪律（全报告贯彻）；Output_Format 结构（verifier 报告标题 = 人格 `personas/verifier.md:69-98` 原样实现；git-master 报告 = `personas/git-master.md:70-85` 的 "Style Detected/Commits Created/Verification" 原样实现）。
   - **未触发但属保险条款，不建议删**：3 次失败熔断（`debugger.md:47,61`、`architect.md:57`）、circuit breaker、`Failure_Modes_To_Avoid`、`Final_Checklist`。
   - **首跑未被 spawn，无从判定**：19 角色中 9 个未注入（architect / debugger / tracer / critic / code-simplifier / designer / qa-tester / document-specialist / scientist，合计 38,065 字符）——**不能据"未用上"判死**；其中 critic 卡（10,330 字符，最大一张）首跑的"最终质量闸门"由组织者合成替代（`agent-review-squad/SKILL.md:26-32` 的职能未被行使），这是流程配置问题不是条款问题。

---

## 六、总体 token 经济学（Token Economics）

### 6.1 库内体量（磁盘）

| 资产 | 字符/字节 | 说明 |
|---|---|---|
| 19 人格卡正文 | **87,055 字符** | 含残留 frontmatter 2,274、行内【适配】143 处 7,580、XML 标签 9,653、Examples 5,537、Output_Format 9,135 |
| 4 工作流技能 | 17,049 字节 | 部署副本 SHA256 4/4 全等 |
| port-kit 5 技能 | 49,269 字节 | 2 份与部署副本有差异（P2-5） |
| 任务书模板 v2 | 3,494 字节 | 与插件自动注入节四处重叠（P1-4） |

**库内常驻成本 = 0**：技能按需加载、人格仅在 spawn 时注入——真正成本发生在派活瞬间，且**任务书作为该会话首条 user 消息进入常驻上下文，会随会话每一轮请求重复出现**（可前缀缓存，首次全价）。首跑 executor-fix 会话 75 个 step，即 11,932 字符的任务书在其生命周期内被反复重放。

### 6.2 首跑实测注入总量（16 份任务书，逐份从子会话转录取出，非估算）

| 会话 | 角色 | 任务书字符 |
|---|---|---|
| 8b5eaa6e | explore | 7,409 |
| 1377f0a8 | analyst | 6,468 |
| c70f7f9d | planner | 8,909 |
| e938bcd0 / d6815301 / 4a81796c / d3041e82 / 45e2123e / d71ef338 / 2b8bbf91 | executor ×7 | 7,897 / 7,768 / 7,652 / 8,402 / 8,145 / 7,940 / **11,932** |
| d3890c54 | test-engineer | 8,230 |
| 30b8a8d6 | code-reviewer | **12,792** |
| 99895a85 | security-reviewer | 10,410 |
| 7ae20681 | verifier | 8,809 |
| 06f220bc | writer | **6,445** |
| 0358ce37 | git-master | 8,164 |
| **合计 16 份** | | **137,372 字符**（均值 8,586，区间 6,445–12,792） |

构成拆解：

| 组成 | 字符 | 占比 |
|---|---|---|
| 人格正文（§三） | 72,680 | 52.9% |
| 插件自动骨架（§一/二/五/六/七/八 + 头） | ~35,000（2,190/次） | 25.5% |
| 组织者手写正文（§四 + 背景） | ~29,700 | 21.6% |
| 其中 §八 工具映射表 | ~15,200（949×16） | 11.1% |

折算 token（粗估，按本语料中英混排 0.7–1.0 token/字符）：**首跑约 9.6 万–13.7 万 tokens** 的提示词注入。

### 6.3 可压缩比例

| 项 | 每次派活 | 首跑 16 次 | 占首跑注入 |
|---|---|---|---|
| P0-1 残留 frontmatter | ~120 | ~1,900 | 1.4% |
| P1-1 §八 表按人格过滤 | ~600 | ~9,600 | 7.0% |
| P1-2 effort 死条款统一/删除 | ~110 | ~1,760 | 1.3% |
| P1-4 模板去重（组织者侧） | ~250 | ~4,000 | 2.9% |
| **小计（低风险项）** | **~1,080** | **~17,260** | **12.6%** |
| P2-1/2/3 人格内重复（designer/code-reviewer 模式/doc-specialist） | ~150（按角色命中） | ~2,400 | 1.7% |
| P2-4 删 XML 标签（**需用户批准**） | ~560 | ~9,000 | 6.5% |
| **上限（含需批准项）** | **~1,790** | **~28,700** | **~21%** |

**结论**：低风险压缩空间 **≈13%**（≈1.3 万 tokens/run），全部走"组合期过滤/改写"即可实现，**不需要删除人格库任何承重条款**；含 XML 标签在内的上限约 21%，但那两项（P0-3、P2-4）触碰 `review/BRIEF.md` 的保真规范，须由用户裁决。

---

## 七、歧义风险（Ambiguity Risks）

- 任务书「完成标准①：报告落盘 `dsh-agents\review\pipeline-opt-A-prompt-cleanliness.md`」×「交付与验收：产出落盘路径 `agent-out\critic-20260913-0759.md`」 → 理解 A：以 review/ 为正式产出（组织者回收看 review/）；理解 B：以 agent-out/ 为正式产出（回收核对看 evidencePath）。
  - 选错的风险：组织者按 A 回收却只见 B 有文件（或反之）→ 判定"未完成"并重派。本次处理：**两处都落**，并在广播中显式声明主副本。
- 任务书「对照首跑实际任务书与报告」未明确"任务书从哪取" → 理解 A：merge-watermelon 内的计划/报告；理解 B：子会话转录的首条 user 消息。
  - 选错的风险：A 无法拿到组织者手写正文（首跑任务书未落盘），第 4 维度只能靠推测。本次处理：取 B（转录实测），并在报告中标注取证方式。

---

## 八、多视角备注（本对象为"提示词系统"，故用计划视角三镜）

- **执行者（组织者用起来顺不顺）**：模板 v2 的 §2/§4/§5 与插件自动节重复（P1-4），加上三处路径权威源（P1-3），导致组织者每次派活要手工做三件插件已经做过的事——首跑的"双落盘"和"撞车自救"都是这么来的。**收敛后组织者只需填任务正文**。
- **干系人（这套提示词真的在解决它声称的问题吗）**：核心目标"角色专业化 + 场景防错"是达成的——首跑 9 个收口会话双条件一次通过率 100%、2 次澄清实战零卡死、只读条款 24 次被引用并遵守。**提示词系统不是首跑的瓶颈**；瓶颈是注入合约（路径/严重度术语/模型声明）的三处口径分叉。
- **怀疑者（最强反驳）**："删这 13% 值不值？"——**不值当为省 token 冒险删条款**；本次真正值得做的是三件"零保真风险、收益明确"的事：① 组合期剥 frontmatter（P0-1，顺带修掉误导）；② §八 按人格过滤（P1-1，省 7%）；③ 路径单一化（P1-3，省一整份报告的重复写盘）。其余项建议只登记不改。

---

## 九、裁决

**VERDICT: REVISE**

- **Pre-commitment**：6 条预判 5 命中、1 部分证伪（逐字重复远少于预期，真正的问题是"同一提示词内两套映射"与死文本）。新增 1 条未预判发现（P0-1 双模型声明）。
- **Realist Check（逐条压力测试严重度）**：
  - P0-1 保留 P0：它在 **19/19 份任务书**中客观存在自相矛盾，且"误批代价 > 误驳"——但现实最坏情况是"子会话答错自己的模型/误以为可换档"，不涉及数据/安全/资金；**结论：保持 P0（误导性）但非阻塞级**，修复成本 3 行代码。
  - P0-2 保留 P0：architect 那句"DSH 会话同样禁用 write/edit"是**可被 README 直接反驳的事实错误**，且只读边界是评审流程的安全底线，不改措辞就是给"只读"留了一个错误心智模型。
  - P0-3 保留 P0（标注"需用户裁决"）：受影响角色首跑未被 spawn，属**潜伏型功能损害**而非当期故障；按"不降级涉及数据/能力损失的发现"原则不降。
  - P0-4 由潜在停工风险给出，**保持 P0 但标注"首跑未踩雷"**：触发条件是"给 planner 派一个执行型任务且未显式说'生成计划'"，属高概率、高后果的错配。
  - P1-1/1-2 维持，未上调：它们是纯 token 项，无行为影响。
  - P1-3 **维持 P1 不上调 P0**：虽然后果可见（重复落盘、撞车），但每次都有会话自救、无产出丢失（`executor-20260912-2026.md:8` 的保全动作完整），且修复直接。
- **是否升级 ADVERSARIAL**：**未升级**。触发条件（任一 CRITICAL 或 ≥3 条 MAJOR 或系统性模式）中"4 条 P0"看似触发，但经 Realist Check，四条各自独立、成因不同（frontmatter 剥离逻辑 / 措辞断言 / 平台限制沿用 / 形态错配），**不构成"同一系统性根因的连环失效"**；且相邻面（4 技能、19 卡）已全量核过，未再发现新增高危项。故全程按 THOROUGH 模式完成。
- **自审记录（Self-Audit）**：本报告的两处工具测量曾被工具本身污染——首轮 `Select-String` 读 `agent-out/*.md` 时按 ANSI 解码产生乱码，导致"未触发条款"一栏**全部假阴性**（29 个标记全 0）。发现后改用 `-Encoding UTF8` 重测并据以改写 §五 的反向清单；**原始错误结论未流入本报告**。另：P0-3/P0-4 涉及"删减"的判断已按 `review/BRIEF.md:87` 归入"需用户批准"，未作为可直接执行的整改项。

---

## 十、验收自检（对照本次任务书验收标准）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 每条发现带 文件:行号 / 角色名+条款定位 | ✅ | 全部 P0/P1 均带 `personas/xxx.md:行号`、`lib/*.js:行号` 或 `agent-out/*.md:行号` |
| 冗余类型（重复/超规范/无用/过长） | ✅ | 每发现"冗余类型"字段：P0 全为"误导性/有害"，P1-1 重复+超规范、P1-2 无用、P1-3 重复+超规范、P1-4 重复、P1-5 冲突、P1-6 重复 |
| 预估节省（字符）+ 删除风险评级 | ✅ | 每条 P1 均给单次/整轮字符数与风险等级（P0-1 极低、P1-1 低、P1-3 低、P0-3 中-需批准） |
| 对照组逐个过一遍：19 卡 + 4 技能 + 模板 v2，不许抽样 | ✅ | §〇 清单；19 卡中 18 份 read 全文、critic 经注入体全文；4 技能 read 全文 + SHA256 比对；模板 v2 全文 |
| 双条件完成（报告落盘 + de_broadcast 回组织者） | ✅ | 见落盘路径与广播记录 |
| 5 个审查维度全覆盖 | ✅ | 维度1→§三/§四重复类；维度2→§五 反向清单；维度3→§四 逐条压缩；维度4→P1-4；维度5→§五 缺失面 |

---

## 十一、Open Questions（不计分）

1. `personas/scientist.md` 的封锁条款是否为**用户明确要求保留**的保真项（若是，本报告 P0-3 应降为"登记项"）——待用户裁决。
2. 首跑未 spawn 的 9 个角色（尤其 critic、tracer、architect）是否属于流程配置问题（Stage 4 只派了 code-reviewer+security-reviewer+verifier）？若不是刻意设计，建议在 agent-autopilot Phase 4 明确"何时加派 critic"的判据（现仅在 agent-review-squad 中定义）。
3. `lib/index.js` 里 `stamp()` 是否被别处依赖为"分钟精度"（如文件名约定、组织者人工对账习惯）？改秒需同步检查调用点。
4. port-kit 侧的 `requirement-interview`/`ai-slop-cleaner` 漂移方向（部署侧修了错字、源侧未同步）是否说明部署流程缺少回灌步骤——建议纳入 port-kit 的部署记录规范（低优先）。
