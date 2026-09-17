# dsh-agents 人格译制规范（v1，2026-09-12）

> 本文件是「19 个角色人格」译制工作的唯一规范来源。分片会话只读本文件 + 原文，
> 产出写到 `review/trans/<id>.md`。**lib/、personas/、review/original/ 一律不许改**。

## 一、背景与目的

`dsh-agents` 插件把 oh-my-claudecode（OMC，MIT）的 19 个专职角色移植到 DSH，
每个角色钉死一个模型档位（haiku/sonnet/opus → LOW/MEDIUM/HIGH）。角色人格
（persona）将在**用户逐篇批准后**写入 `personas/<id>.md` 并注入被派活的子会话。

因此本次译制产物要同时满足两件事：

1. **可核对**：忠实翻译，用户能对照英文原文确认语义没有走样（这一步是审批材料）；
2. **可直接署用**：OMC 人格大量引用 Claude Code 专属工具与流程（`lsp_diagnostics`、
   `TodoWrite`、`.omc/plans`、`ast_grep_search`、`Task(...)`、tmux 等），在 DSH 里
   不存在——必须**就地替换为 DSH 等价物并标注**，否则子会话会去找不存在的工具。

## 二、输入与输出

| 项 | 值 |
|---|---|
| 原文（只读） | `D:\tools\deepsek_harness\dsh-agents\review\original\<id>.md` |
| 译文（产出） | `D:\tools\deepsek_harness\dsh-agents\review\trans\<id>.md` |
| 角色元数据（参考，只读） | `D:\tools\deepsek_harness\dsh-agents\lib\roles.js` |
| 单篇产出上限 | 不超过 20000 字符（超出说明没做压缩，需在报告里说明） |

**每个角色一个文件**，写完一个就立刻落盘（增量落盘），不要攒到最后一次性写。

## 三、译文文件格式（严格遵守）

```markdown
# <id> — <Name>

> 原文：review/original/<id>.md（oh-my-claudecode，MIT）
> 档位：<HIGH|MEDIUM|LOW>（OMC model: <opus|sonnet|haiku>，level <n>）
> 译制：忠实全译 + 就地 DSH 适配（v1 规范）

## 译文

<全文翻译，见第四节>

## 适配清单

| 原文提法 | DSH 等价物 | 处理方式 |
|---|---|---|
| lsp_diagnostics | pwsh 跑类型检查/测试命令并贴原始输出 | 就地替换 |
| ... | ... | ... |

## 译制说明

- 逐节对应关系（原文小节 → 译文小节，缺节要说明）
- 语义存疑处（不确定的术语、可能有歧义的句子）
- 未译内容（若有：哪一段、为什么）
```

## 四、翻译规则

1. **忠实优先**：不增删语义、不合并小节、不改写结论强度。原文的 `<Role>`、
   `<Success_Criteria>`、`<Constraints>`、`<Failure_Modes_To_Avoid>` 等 XML 标签
   **原样保留**（标签名不译，标签内正文译）。标题层级、编号列表、表格结构保持。
2. **工具与流程就地适配**（这是与"纯翻译"的关键区别）：
   - 遇到 Claude Code 专属工具/概念，译为 DSH 等价物，并在该处加行内标注
     `【适配：<原提法> → <DSH 做法>】`（同一篇内同一提法只在**首次**出现时标注，
     避免刷屏；其余处直接写 DSH 做法）。
   - 映射基线（与插件 `lib/taskbook.js` 的 TOOL_ADAPTATION 一致）：
     Read/Write/Edit→read/write/edit｜Bash→pwsh（每次调用独立进程，用 workdir）｜
     Glob/Grep→glob/grep｜TodoWrite→todo_write｜Task/spawn_agent→de_session spawn｜
     AskUserQuestion→ask_user_question（或按澄清模式走 de_broadcast）｜
     lsp_diagnostics(_directory)→pwsh 跑类型检查/测试｜
     ast_grep_search/replace→grep + edit｜python_repl→pwsh 调 python｜
     tmux→pwsh 后台任务（run_in_background）｜`.omc/plans`、`.omc/notepads`、
     `.omc/state`→任务书指定落盘路径 / memory 工具｜`<remember>` 标签→memory 工具｜
     `/team`、Agent 预设团队→de_session spawn 多会话 + de_broadcast 协调。
   - 无法映射且纯属 OMC 平台机制的内容（如 hooks、`.omc/` 状态机细节）：照译，
     并在行内加 `【适配：DSH 无此项，忽略/改用 <最接近做法>】`。
   - **硬规则（B-P0-1 配套，2026-09-13 增补）**：凡**影响运行时行为**的存疑项/
     适配说明，必须写成译文正文里的**行内** `【适配：】` 标注，**不得只写在
     「适配清单 / 译制说明」两节**——安装器只保留「## 译文」，后两者不进 persona，
     只写在那里 = 运行时子会话永远看不到（实例：code-reviewer 的 model=haiku
     模式存疑说明只写在译制说明，部署后无人可见）。
3. **保留原文英文的地方**：代码片段、命令行、文件路径、工具函数名、专有名词
   （SOLID、OWASP、TDD 等）、以及 XML 标签名。
4. **术语表（统一译法，不要各译各的）**：Role=角色｜Mission=使命｜Responsible=负责｜
   Not responsible=不负责｜Success Criteria=成功标准｜Constraints=约束｜
   Failure Modes To Avoid=要避免的失败模式｜Investigation Protocol=调查规程｜
   Tool Usage=工具使用｜Output Format=输出格式｜Final Checklist=收尾清单｜
   severity-rated=按严重度分级｜root cause=根因｜evidence=证据｜
   acceptance criteria=验收标准｜flaky test=抖动测试｜scope creep=范围蔓延｜
   over-engineering=过度设计。
5. **不要做的事**：不要写导读/评价/打分；不要加"译者注"以外的自造内容；
   不要因为某节"看起来是 OMC 专属"就删掉——**照译 + 标注**，删减留给用户批准环节。

## 五、硬性完成标准（缺一即未完成）

1. 分配给你的**每个角色**都在 `review/trans/<id>.md` 落盘（write 工具，UTF-8）；
2. 全部完成后用 `de_broadcast` 向组织者 `session-cdff963f-769d-480e-a95b-a1830dc3aa2f`
   发一条完成消息（`wake:true`），正文含：完成的 id 列表 + 每个文件的字符数 + 适配清单条数合计 + 任何未译/存疑项。
   **只写文件不广播、或只在聊天里说完成，都算未完成。**

大文件（>8K 字符的原文）建议分两次 write（先写译文主体，再 append 适配清单与说明）——
注意 write 工具是整体替换，追加请用 edit 在文件末尾补，或一次写全。

## 六、边界与纪律

- 禁止修改 `review/original/`、`lib/`、`personas/`、`cordis.patch.yml` 下任何文件；
  除自己分配的 `review/trans/<id>.md` 外不写任何文件。
- 禁止 install / build / 运行插件；本任务是纯文本译制。
- 禁止提问（autonomous）：遇到不确定的地方按下表取值，并在「译制说明」里记一笔。
- 长任务每完成 1-2 个角色广播一次进度（subject: `<id> 进度`）。

## 七、缺省决策表（禁提问模式）

| 缺失/存疑项 | 缺省取值 | 依据 |
|---|---|---|
| 某个词没有公认中文译法 | 保留英文原词，首次出现加中文简短注解 | 术语一致性优先 |
| 某段疑似 OMC 专属且无法映射 | 照译 + `【适配：DSH 无此项…】` 标注 | 删减权归用户，不归译者 |
| 原文有排版噪声（表格塌陷、空标签） | 按语义复原结构，在「译制说明」记录 | 可读性 |
| 篇幅超 20000 字符 | 压缩重复表述与示例，不删承重条款（成功标准/约束/失败模式） | 规范第二节上限 |
| 无法判断某节是否要译 | 译，并标注 | 同上 |
