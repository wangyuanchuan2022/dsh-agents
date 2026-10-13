# 开源复用账本（AC-61，产品第 8 条）

> advisor V3 对第三方开源项目的复用登记。**数据来源：`agent-out/gate0-reuse-research.md`**
> （GATE 0 调研报告，2026-10-08；快照 commit 见其 §0）。本账本逐条给出来源节号/文件:行号，可回溯核验。
> 口径：**未复制任何上游源码行**（四源全为 Python，本仓为 Node ESM；唯一可 1:1 移植的 `.scm`
> 查询文件因异质 license 风险未复制——见下文 Aider「未采用」）。复用形态 = 设计借鉴 + 改造重写。

## Aider-AI/aider（Repo Map）

| 字段 | 内容 |
|---|---|
| 来源仓库 | `Aider-AI/aider`（官方仓） |
| 版本 commit | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`（main，2026-10-08 读取时） |
| License | **Apache-2.0**【实测 `gh api … --jq '.license.spdx_id'`】。⚠️ 机检注意：无 `LICENSE` 文件，正文在 `LICENSE.txt`（gate0 §A1③/C.1） |
| 复用内容 | ①「仓库骨架 + 符号抽取 + 预算上限」的 repo map 问题形态（gate0 §A1②a/d）；② token 预算控制的语义（预算上限 + 超限裁剪 + 误差带思想，`repomap.py L666-703`）；③ (path, mtime) 缓存失效思想（`repomap.py L217-262`）；④ 符号抽取分 def/ref 两类、按捕获名分类（`repomap.py L279-336`）——本仓 L2 符号精读（`lib/advisor/retrieval/symbols.js`）与检索预算唯一源（`lib/advisor/retrieval/budget.js`）承接 |
| 改造内容 | 全部 Node ESM 重写：预算不做二分而是**单一 chokepoint**（`BudgetPool`，预取面与工具面共享 40KB 池，契约 §6.5）；符号抽取 B4 前为正则启发式、B4 起为 **web-tree-sitter AST + vendor wasm sha256 硬闸门**（`lib/advisor/grammars/`），非 Aider 的 tree-sitter Python 绑定 + `.scm` 查询 |
| 未采用部分及原因 | ① **个性化 PageRank 相关性排序**（`repomap.py L365-574`，含 ×50/×10/×0.1 权重常数与 rank 分摊到 (文件,符号)）——本仓 `git grep -i pagerank lib/advisor` 零命中，如实未采用；原因：V3 的 L1/L2 分层以「文件树 + git 事实 + 搜索 + 定向精读」满足验收射程（AC-60），依赖图排序属 L3 精度升级、不在 V3 承诺内，且需引入图计算复杂度（gate0 §D5 将其列为 P1 非必需）；② **`.scm` 查询文件复制**——Aider 自带 `.scm` "adapted from" 多个上游仓、每语言 license 异质（gate0 §C 表末行），复制即触发逐仓核查义务，本仓改用官方 `tree-sitter-javascript` 包的 vendor wasm + 自写抽取逻辑；③ `grep-ast`/`pygments`/`diskcache`/`tiktoken` 依赖链——零新依赖裁决（gate0 §D2：最小新依赖集 = 空集），等价物用 fs+JSON+mtimeMs 与近似 token 计数替代 |

## SWE-agent/SWE-agent（官方上游，ACI）

| 字段 | 内容 |
|---|---|
| 来源仓库 | `SWE-agent/SWE-agent`（官方上游；用户原给的 `kevinji80/SWE-agent-playground` 为 fork/0 star/停更，gate0 §0.1 判定不引用） |
| 版本 commit | `3ea751c087f32b16e039a2233dd6eefecef325d5`（main，2026-10-08） |
| License | **MIT**【实测】 |
| 复用内容 | ① ACI 边界设计发现：工具边界收敛 + 观察格式调优（`docs/background/aci.md` 四条）；② **搜索只回命中文件名**、**观察行数上限（100 行）**、**空输出显式文案不静默**（`tools.py L29-152` / aci.md）——本仓 `lib/advisor/aci/observation.js` 承接（100 行上限 + 显式截断标记，测试 S3-13）；③ **工具声明即契约**（YAML signature/docstring/arguments 自动生成模型可见文档）——映射为本仓 ACI 工具 schema；④ 超时与连续超时熔断思想（`execution_timeout` / `max_consecutive_execution_timeouts`）——映射为 `advisorCallTimeoutMs` 单次调用超时 |
| 改造内容 | SWE-agent 用 **blocklist 黑名单**（`vim, bash, …` 前缀/精确匹配，`tools.py L29-72`），本仓 advisor 是只读顾问，改为**只读白名单**：ACI 工具注册表集合相等断言（AC-8，9 个写类工具名逐一不存在）+ git argv 白名单 + 最小 env（契约 §10.1）——「构造上不可写」而非「黑名单拦截」（gate0 §D3 第 3 条的直接采纳） |
| 未采用部分及原因 | ① **编辑类工具与 linter 门**（`str_replace_editor` 的 flake8 编辑前后双跑）——advisor 只读、无编辑动作（gate0 §D5 列 P2「仅在其事实核验职能上部分适用」）；② **blocklist 本体**——被白名单构造替代（见上）；③ SWEEnv 容器执行层——advisor 不执行命令，只读 git |

## OpenHands（software-agent-sdk + extensions）

| 字段 | 内容 |
|---|---|
| 来源仓库 | `OpenHands/software-agent-sdk`（主）+ `OpenHands/extensions`（扩展层） |
| 版本 commit | `9f47d471ee6f91ba1d140d10d34f3b26d5ac2427`（sdk main）/ `d008b81c44ae4d56d319e3b8f28ca35fc40aacbc`（extensions main），均 2026-10-08 |
| License | 均 **MIT**【实测】。⚠️ extensions 为第三方内容注册表，仓库级 MIT ≠ 逐条目可取用（gate0 §C） |
| 复用内容 | ① **Workspace 层不抽象读文件**（`workspace/base.py L171-260`：仅 execute_command / file_upload / file_download / git_changes / git_diff）——直接支撑本仓「只读检索面 + git 事实」的分层（gate0 §A3④ 第 1 条）；② **工具危险度标注**（`tool/tool.py L215-249` 的 `readOnlyHint` 等，对齐 MCP schema）——本仓逐工具 `readOnly:true` 标注（AC-9）；③ `skills/<name>/SKILL.md` 目录契约与 marketplace 索引形态——本仓 `skills/advisor/SKILL.md` 属同构对齐（gate0 §A4④）；④ **「触发词不是授权」治理条款**（extensions `AGENTS.md` 原文 "A trigger phrase is not authorization"）——与 `sessionId` liveness≠authz 边界同源，契约 §0.1 显著位置声明即此条款的落法 |
| 改造内容 | View/Condenser 的「压缩即事件」与四条不变量**未整体引入**——本仓上下文有界化走 `ADVISOR_CONVERSATION_MAX_CHARS` 丢最旧（契约 §7.1）+ observer 幂等门，形态不同；工具面走 DSH 宿主 llm.stream 的 tools 协议，非 OpenHands ToolDefinition registry |
| 未采用部分及原因 | ① **Condenser 事件化压缩**（`condenser/base.py L95-170` HARD/SOFT）——与本仓「每 turn 恰好评审一次」幂等门职责重叠，引入需先对账且成本高于当期收益（gate0 §D5 列 P2）；② **pr-review 插件的具体功能面**（Review Context Awareness / Sub-Agent Delegation 等，extensions `plugins/pr-review/README.md`）——属产品能力 backlog 参考，未在本仓落地；③ **具体 skill 正文整段取用**——未做逐条 license 核查前不取（gate0 §E 第 5 条） |

## 验证与登记

- 四源 copyleft 为零、license 全绿（gate0 §C：Apache-2.0 ×2 + MIT ×3，GPL/AGPL 为零）。
- 本仓 `package.json` 运行时依赖 = `schemastery` + `web-tree-sitter@0.27.0`（精确锁定）；后者即 gate0 §D2 唯一推荐依赖（B4 批经产品批准引入，wasm 以 vendor + sha256 硬闸门落地，`npm pack` 取官方字节，gate0 §D2 表与 B4 报告 §2）。
- 本账本由 B5/S5 建（AC-61）；上游快照若更新，复用判定须重估，本表 commit 锚为核对基准。
