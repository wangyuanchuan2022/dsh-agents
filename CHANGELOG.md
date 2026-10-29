# Changelog

本文件记录 dsh-agents 的全部显著变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；仓库当前处于 Unreleased 阶段，全部条目归档于 Unreleased 节，每条挂 commit 短哈希可溯源（`git show <hash>`）。

## [Unreleased]

本节覆盖 R3-B0（死重清除）与 R3-B1 全程（2026-10-26 → 2026-10-27，`fc41b7c`..`e522b9b`）。

B2 段（注入面裁剪 + 按需 help + 按会话单授，2026-10-28）条目见下方 **B2 ①/②/③**——代码与测试落于 `b745068`（S1+S1.5+S2），门/读数/文档落于本文件同批的 S3+S4 commit。

### Added

**advisor 项目全景层 + `docs/PROJECT-STATUS.md`（2026-10-29）**

> 动机（实测）：advisor 的可见面里真人消息只占 **1.02% 字符**、`tool/call` 与 `tool/result` 全部被 role 白名单滤掉 ⇒ 它不知道项目在做什么、到哪了；而 AC-62 门又让「继续 / 下一步做什么」这类消息**完全不触发仓库检索**（12 条推进消息实测 7 条零检索）——恰恰是最需要全局视野的时刻。调研与实测全量见 `agent-out/advisor-global-vision-research.md`（31 个可重跑探针）。

- 新增 **`docs/PROJECT-STATUS.md`**（98 行）：项目全景正本，七节（是什么 / 当前进度表 / 关键事实 / 不可违反决策 / 已知限制 / 去哪找细节 / 维护契约），回答「要干什么 / 现在到哪 / 下一步做什么」。
- 新增 **`lib/advisor/context/project-status.js`**：`loadProjectStatus()` + `renderProjectStatus()`。两条硬纪律：① 文件不存在 / 抛错 / **纯空白**三态一律 `available:false` 并显式渲染「不可用」（AC-4 同源，不静默省略）；② 行数上限 `PROJECT_STATUS_MAX_LINES = 100` **与 ACI `read_file` 的 `MAX_TOOL_OUTPUT_LINES` 同值同口径**——advisor 自己读同一份文档也只能拿 100 行，注入面给更多会造成「对同一份文档两个认知」；超限尾部截断并**显式标注丢了几个行**。
- `context/build.js`：`buildContext()` 新增第四段「项目全景」，**计入 Repository 池（40KB）而非 Base**——`BASE_CONTEXT_BYTES = 8KB` 的冻结口径**一字未动**。依据：Repository 池实测典型用量 2,445 B / 40,960 B（6%），全景 7.3 KB 后二者合计 9.7 KB，仍余 31 KB。
- `assemble/context-hooks.js`：`contextFor` 在 **AC-62 门之前**装配全景段——它是**单文件精确路径读取**，不属于 AC-62 定义的「昂贵仓库分析」（递归遍历 / 子进程 / AST / 大文件读取），故普通聊天也能看到项目全景。端到端实测：「继续」场景下仓库检索仍是 `available:false`（门照常生效），而全景段照常注入。
- 新增 4 条测试（主套件 **378 → 382**）：`PS-1` 不可用三态显式标注 / `PS-2` 行数上限与 `read_file` 同口径（含恰好 100 行不截断、101 行截断标 1 行）/ `PS-3` 并入 Repository 池不动 Base + **AC-62 门挡不住它**（含「门必须仍然生效」的前置断言，防有人把门关掉让断言变假绿）/ `PS-4` 真实文件存在、≤100 行、含可机检的「最后更新：YYYY-MM-DD」行（防腐烂）。
- **变异必红实测 2 例**：① 上限 100→200 ⇒ `PS-2` 红；② 空文件判据退回旧写法 ⇒ `PS-1` 红。均按内存原字节还原，`sha256` 前后一致。
- 文档同步：`ARCHITECTURE.md`（167 跟踪文件 / lib 44 = 17+27 / advisor context 5 件 / 主套件 382 / 合计 558）、`README.md`（目录树 + advisor 特性段）。
- **过程中被既有闸门抓到一个真实约束**：`AC-6①` 要求决策正本路径字面量**只允许出现在 `decisions.js` 一处**，我初版在 `project-status.js` 注释表格里复述了它 ⇒ 主套件变红。修法是改我的注释（不复述该路径），**不是放宽闸门**。

**B5 X-3 补做：PARTIAL 闸门「违反即变红」逐条变异实测（2026-10-29）**

- 新增 `tools/constraint-mutation-verify.mjs`：对 `docs/constraint-audit.md` 的 PARTIAL 条款构造**单变量变异**（只改产品代码 `lib/`·`tools/`，**绝不改测试**）→ 跑**该条款自己的闸门入口** → 断言必红 → 按内存原字节还原并校验 sha256。五条纪律：单点替换必须恰好命中 1 次（0 次/多次即抛错 fail-closed）、逐条跑它自己的闸门、还原保真校验（不等即 exit 3）、fd-stdio 跑子进程（禁管道捕获）、`find !== replace` 防空转。`--selftest` 5/5、`--list`、`--only <条款>`。
- **实测 7 条全部达期望，变异零残留**（7 个被变异文件 `git diff --quiet HEAD` 全通过）：**5 条 PARTIAL 闸门经证实有真实鉴别力**（C-013 persona-gate baseline / C-014 toolscope fail-closed deny / C-018 publish-scan secrets=critical / C-051 advisor seq 水位门 / C-056 advisor 回合计数冷却）；**2 条原为零鉴别力缺口**（C-064 任务书「报告落盘」条款、C-107 `lastReviewedSeq` 哨兵 -1）——**已补值断言并验证变红**（见下条）。
- **两条缺口已补齐（2026-10-29）**：① C-064 → `tests/run.mjs` 新增「泳道交付条款必须逐字在场」用例（三泳道 7 条交付条款逐字断言 + 泳道互不串味反向断言；原断言只查「报告落盘」四字，该四字在别处也出现，等于没查）；② C-107 → `tests/advisor.test.mjs` 新增「全新会话的 lastReviewedSeq 哨兵必须是 -1」（值断言 + seq=0 放行的行为断言 + 损坏文件回落 -1 反向断言）。主套件 **375 → 377/0**；变异登记表 C-064/C-107 期望由 `green` 改 `red`，**7/7 全部实测变红**。
- **新增方法论缺口（已回灌审计正本 §7.1）**：**「闸门入口错位」会把有牙齿的闸门误判成没牙齿**——本工具初版让所有变异都跑 `tests/run.mjs`，导致 C-013/C-018 被误判「零鉴别力」，而它们的闸门实际在 `tools/verify-imp26.mjs` 与 `tools/publish-scan.test.mjs`（都不在 run.mjs 链上）。判据：先确认条款的闸门在哪条命令里，再谈鉴别力。
- **续做轮：44 条 PARTIAL 全量实测完成**（登记表 7 → 44 条，`tools/constraint-mutation-verify.mjs` +373 行）。组织者独立整批复跑：**达期望 44 / 未达期望 0 / 还原失败 0**，`git status` 仅登记表改动、`lib/` `tests/` `docs/` 全干净（变异零残留）。结论：**43 条闸门本就有真实鉴别力，第 44 条（C-101）确认缺口后已补齐 → 44/44 全部有牙**——本审计「PARTIAL = 有闸门但只覆盖一部分」的定级是准确的，不是「大部分其实没人看管」。
- **C-101 唯一缺口 → 已补齐并验证（2026-10-29）**：`lib/persona.js` 的「（人格文件未安装）角色摘要」标记去掉后主套件曾 377/0 全绿。根因：`tests/run.mjs` 的断言包在 `if (!persona.installed)` 里，而本仓 23/23 份 personas 全部已安装（组织者独立复核 confirmed）⇒ **分支永不进入，是结构性死码**；审计正本原判「覆盖较完整」被推翻。**修法**：新增「合成 role 走真缺省分支 + 已安装 role 不得出现该文案」用例（阴性臂断言 installed=false/hash=null/file=null/文案在场/含角色名与职责；阳性臂断言已安装角色 installed=true/hash 存在/不含该文案）。主套件 **377 → 378/0**；变异登记表 C-101 期望由 `green` 改 `red`，**44/44 全部实测变红、零缺口**。
- **另有两条方法论发现（已回灌 §7.1）**：① 同一报错有多个分支，`find` 串全局唯一 ≠ 该路径在闸门下会被执行（C-108 首锚点打在死分支上，实测绿，换到夹具真正触发的分支才红）；② 补口的外溢半径 —— 给 C-064 补的「泳道交付条款逐字在场」值断言顺带钉住了 C-003/C-004/C-070/C-072/C-073 五条相邻条款，**值断言的覆盖半径常大于它被补的那一条**。

**R3-B5/B6/B7 三道结构化闸门 + 两项实测缺陷修复（2026-10-29）**

**B5 约束结构化审计**（`docs/constraint-audit.md` 291 行 + `tools/constraint-audit.mjs`）
- 把「提示词级纪律」逐条盘点到「有没有机器闸门看管」：抽样 4 个载体共 **108 条款**（AGENTS.md 47 / design-principles 15 / task-brief-v3 37 / README 已知限制 9），按四档结构化程度（ENFORCED 2 · PARTIAL 44 · MANUAL 22 · N/A 40=37.0%）与 P0/P1/P2 定级（P0=14）逐条给判据与 `文件:行号`。
- 核心发现：**PARTIAL 绝大多数只覆盖「指令已下达」，不覆盖「指令被遵守」**——主套件大量断言是 `assert.ok(text.includes(...))`。四个真改代码的变异实测佐证：MUT-A/B 有鉴别力（373/2、374/1），而 MUT-C（`store.js:91` 哨兵 `-1`→`0`，design-principles 1.3 点名的静默漏评形态）与 MUT-D（删任务书「报告落盘」硬条款）**主套件 375/0 全绿、零鉴别力**。
- 闸门 G1–G5（覆盖完整 / ENFORCED 必须可验证 / N/A 占比上限 / P0 必有可落地整改 / 零命中防护）+ `--selftest` 6/6。

**B6 档位别名契约字节级 enforced**（`docs/alias-contract.md` + `tools/alias-contract-gate.mjs` + `tests/fixtures/alias-contract.sha256.json`）
- 沿用 routing-suite 教训（别名 4 对字节漂移、文档自述「保持同步」而 SHA256 全不同）：把 `TIER_ALIASES` / 角色 `omcModel` / 人格 `omc_model` / 文档表述四处一致性做成 A1–A6 闸门 + 契约正文 sha256 指纹门（改契约必须同步改 fixture）。
- **两处真实例外按裁决登记而非抹平**：`harness-optimizer`（tier HIGH / omcModel sonnet，底本 sonnet 批次3 上调）、`rag-reviewer`（tier HIGH / omcModel sonnet，DP-7 上调）——契约形态是「相等，或登记在带理由例外表」。`lib/roles.js` 一字未改。
- `--selftest` 7/7（含「改契约不动 fixture」「例外理由清空」）；另有 10 项 fail-closed 演练（fixture 缺失/格式错/陈旧例外/冗余例外等）。

**B7 VERIFIABILITY 矩阵**（`docs/VERIFIABILITY.md` + `tools/verifiability-check.mjs`）
- 44 条对外宣称断言 × 五列（断言 / 来源 / 证据 / 可执行复现路径 / 口径），覆盖 README、ARCHITECTURE、CHANGELOG、工具描述、docs 五个载体；实测 44 / 估算 0，每条附能真跑的命令。
- 闸门 V1–V5 + X1（矩阵声明的实测读数必须真出现在命令输出里，防「声称实测但跑不出该数」）+ `--selftest` 6/6。

**两项实测缺陷修复（由 B5 审计挖出，已复现并锁回归）**
- **D-2（安全级）**：`tools/publish-scan.mjs` 对超过 `maxFileBytes`（缺省 1MiB）的文件直接 `stats.skippedLarge++; return` —— 文件被静默跳过、不进 findings，于是**含真实 `sk-` 密钥的 1.1MiB 文件判 `PASS`**（实测对照：同内容 49B → FAIL / 1.1MiB → PASS）。这与全局闸门规范「输入超限按安全事件显式拒绝」正相反。修复：超限改记 `category='limits'` 的 critical finding ⇒ verdict 必然 FAIL；仍不回读超限内容（防大文件进内存/报告）。新增回归 T16a–T16e 五条成对断言（对照小文件必 FAIL + 超限必 FAIL + limits 类 + snippet 空），publish-scan 自测 47 → **53**；变异实测（把 fail-closed 改回静默 return）三断言精确变红，还原后字节 sha256 一致。
- **D-1（账实不符）**：`ARCHITECTURE.md:21` 声明「`npm test` 串联全部入口」与实测不符（旧 `test` 只串 5 个，crgate 65 / publish-scan 53 / persona-gate 33 / taskbook-26a 11 / 注入面门 7 全未接入）。修复方向是**让声明变真**：`package.json` 的 `test` 从 5 入口扩到 **13 入口**（另加三道新门），并补 8 个 `gate:*` 独立脚本。

**测试账**：主套件 375 不变；`npm test` 串联入口 5 → 13；合计断言 375+65+53+33+11+5+9 = **551**（另有三道新门各带 selftest）；`tools/` 20 → 23 文件（机检脚本 11 → 14）；`docs/` 4 → 7 文件。

**动态 provider 接入三档路由选择范围（xd pool / codex connect，2026-10-29）**

- `lib/routing.js` 新增 `completeDynamicProviders()`：`listConfiguredRoutes` 原只读声明式 settings 的 `models` 数组，而 `dsh-xdpool`（xdpool / xdpool-global / xdpool-aggregate / xdpool-free）与 `dsh-codex-connect`（openai-codex）只调 `ctx.llm.registerAdapter()`、目录来自远端 catalog，因此被 `filterUsableCatalog` 按「无模型目录不列」整条丢弃——表现为设置页三档下拉与 `agent_roles` 体检里完全看不到这些 provider。现以宿主通用 API `llm.listModels(provider)` 补全该缺口，并自动惠及 advisor 面板目录、`resolveProviderForModel` 反查与配置端点（五处调用同源）。
- 补全的三条纪律：① 逐个容错（单个 provider 抛错/挂起只跳过它自己）；② `declared` 白名单——声明式 provider 一律不被远端覆盖，哪怕它读到空 `models`（空目录是「配置不全」的诊断信号，不该被远端结果掩盖）；③ 有界并发（缺省 4）+ 单项超时（缺省 1500ms，按「响应速度优先」裁定）——设置页是同步等它的，宁可少列几行也不让整页卡住。
- 实现细节：超时计时器**不可 unref**——挂起的 `listModels` 永不 settle 时，若事件循环再无活动句柄，Node 会直接退出而 `await` 永远等不到（本次开发中实测踩到：整条链静默 exit 0）。
- 回归测试 4 条（`tests/run.mjs`）：动态 provider 必须入目录 / 声明式不被覆盖（含空目录）/ 单点失败不连坐 + 挂起超时切断 / `completeDynamic=false` 退回纯声明式语义 + 并发上限生效。两个变异体（关闭补全、去掉 declared 白名单）各自精确变红，还原后字节 SHA256 一致。
- `resolveProviderForModel` 同步两段查找（2026-10-29 补）：① 声明式目录优先（本地零远端调用，命中即返回）；② 本地未命中才补全动态目录，优先级=声明式胜出。否则会出现「下拉里选得到、派活时按模型名解析不到」的新静默不一致。新增回归断言 3 条（动态模型可反查 / 声明式命中不付远端延迟 / 解析不到回 undefined）。
- `agent_spawn` 的模型可用性提示（`lib/index.js`，派活热路径）同样改两段：声明式目录命中即不补全远端，只有「档位指向声明式目录里没有的 provider」才补——避免每次 dispatch 都付 1.5s 级远端延迟（典型场景：档位指向 xd pool / codex connect）。
- 变异体必红实测（3 个）：关闭动态补全 → 目录缺 xdpool 条目红；去掉 declared 白名单 → 声明式被远端覆盖红；反查不做动态兜底 → 动态模型反查不到红。实测后按内存原字节还原，`lib/routing.js` sha256 前后一致（A24091…071E）。

**B1 ① 极简条件人格（minimal 派活形态）**

- `6e31a51` — `agent_spawn` 新增 `personaMode='minimal'`：免角色、四行 brief（任务 / 产出落盘 / orgId / 完成标准）、provider+model 必填缺即拒（旁路档位路由后无回落链）、`minimalPreset` 预设路由、策略文件写失败 fail-fast（G8）、返回体披露已应用策略（G10）。

**B1 ② per-session 工具面收缩**

- `53a8790` — 策略文件读写模块 `lib/toolscope.js`：`<dataDir>/sessions/<b64>.toolscope.json`（schema v1：personaMode / toolPolicy / replyChannel / orgId / role / task / taskbook），写 fail-closed、读 fail-open，orgId 单源同事务落盘。
- `cca6578` — restrict 管道模块与 roster 数据层 `lib/toolscope-pipeline.js` / `lib/toolscope-roster.js`：决策核 `decideToolscope`、双向对账检测器、G9 去重通知、跨代 sharedLift 防线、构建期扫描核；`policies/` 策略数据（roster 基表 + 23 角色引用表机产）。
- `2d013dc` — 管道接线与门线：agent/created 挂点收缩、role 轨标记、漂移门（roles 文件 vs 内存重扫 deep-equal）、AC2-1..11 断言组。
- `52e9a4d` — 收缩生效率读数组消费器 `tools/toolscope-efficiency.mjs`：对账通过率 / 收缩占比 / fail-open 分布三值 + 离线重放（同一决策核）+ 阈值 verdict；零样本如实 no-sample。

**B1 ③ 极简回复通道（agent_reply + 频控）**

- `3af21d0` — 回复通道模块 `lib/agent-reply.js`：own 层 `agent_reply` 工具（target 注册时钉死 orgId、schema 无 target 参数）、内部直投、模式解析闸门、滑动窗口频控 + 连降熔断、`reply-audit.jsonl` 审计行。
- `10954c2` — apply 接线：`installAgentReply`（minimal×org 会话注册）、`toolscopeEnabled` 消融联动、审计落 dataDir。

**B1 S5 小收口**

- `c8f4aa7` — spawn 决策日志并轨 `reply-audit.jsonl`（`kind:'spawn'` 与 `kind:'reply'` 同文件异类；`spawnDecisionAuditWriter` 工厂）。
- `e724bec` — 宿主版本公开读取面：`detectHostVersion`（插件树向上走查 + APPDATA npm 全局前缀候选）/ `checkHostVersion`（mismatch 告警、unknown 静默）；真机读数 match 0.1.7-rc.2。
- `2845187` — 频控常数 config 键位：`replyWakeWindowMs` / `replyWakeWindowMax` / `replyWakeBreakAfter`（缺省 60000 / 3 / 10，resolveConfig fail-loud 校验，非法值启动即抛错）。
- `9f38c8f` — 审计有界留存：`appendAuditLine` 共享助手，尺寸阈值（512KB）轮转 `.1` 一代（上限约 2×512KB），行级粒度轮转不丢行。

**B1 独立预设装载器（PhaseB 选项③，用户裁决：独立插件自制挂载、不依赖宿主 registry）**

- `40f5fad` — 三件落地：`lib/yaml-mini.js` 最小 YAML 子集解析器（嵌套 map/seq、单引号 / 整数 / 布尔、全行注释；flow / 双引号 / 多行标量 / TAB / 锚点 / 标签 fail-fast 列行号）+ `lib/disk-presets.js` 磁盘装载（`listDiskPresets` / `loadDiskPreset` / `mountDiskPreset`：未知键列名、目录存在即权威损坏不回落宿主、组件级挂载契约）+ spawn 链解析序（磁盘目录优先 → 宿主 registry 兜底 → 双路不可得 fail-fast）。

**B2 ① 注入面裁剪与按需 help 单源（catalog 行 + `agent_roles action='help'`）**

- 三工具工具级 description 裁为手工 catalog 行（各 ≤90 码点，实测 90/78/87）；常驻只留路由决策信息（分工互指 / 何时用 / 查 tiers·只创建·dryRun 三条安全指针），全量语义按需披露。面A 工具面 **2663 → 2225 码点**（Δ−438），工具级 **783 → 255**。
- 新增 `STATIC_ARCHIVE`（迁移前工具级原文逐字存档，267/191/325 码点）+ `composeHelp(活 definitions)` 纯函数：help 全量 = 3 段存档原文 + 活 action 参数表现拼；走既有 `message` 字段返回，**不新增参数、不扩 output.schema**。
- `rolesTool` 增 `action='help'` 分支；未知 action 合法清单增补 `help`；help/未知 action 各写一条只读审计行（`kind:'help'` / `kind:'tool-error'`，fail-open：审计缺失或抛错绝不影响工具返回）。
- 合同测试：catalog ≤90 + 必备子串、PROMISES 正向断言、Q1/Q2 反向漂移门、Q3 存档 sha256 fixture（3/3）、9 变异体注入必红（红→显式还原→绿）。

**B2 ② `agent_spawn.allowTools` 按会话单授工具入口（R-13）**

- 新参数 `allowTools`（数组，元素=工具最终注册名；形状校验 fail-fast，去重保序）：role 轨并入 grant 放权集；minimal 轨走 `extraAllow` **append**（不替换预设集，`input.allow` 替换语义保持）；created 期未知名 fail-closed 收缩照常 + `DedupNotifier` warning 告警（类别键与 refuse 分源）；输出披露 `allowedTools` + notes「单授 N 项」。
- 面A 成本入档：`agent_spawn.paramDescs` 581 → 658（+77 = allowTools 描述码点）。

**B2 ③ S3 净注入门（可失败机测）**

- 新增 `tools/opt-b2-s3-gate.mjs`：G0 前锚锁定（S0 留档 2663/2663/5655、工具级 783、descCount 54；缺 `tools.items` 结构 ⇒ 解析 fail-closed，面D 文件冒充面A 基线直接红）/ G1 面A 净增 ≤0 / G2 裁剪到位（各 ≤90、合计 ≤255，零容差）/ G3 面D 不变式（1993/2181/2183 + meanTotal 6133 + maxTotal 6480，只码点）/ G4 参数级不缩水；G5 并列读数 H=1169、H_static=783、H_action=332、H_struct=54、回本轮数 R=3（估算口径）。`--selftest` 7/7（原样全绿 + MUT-G0..G5 六变异必红，含「只裁 1 字符」与「面D 冒充基线」）。读数档案 `agent-out/opt-b2-s3-readings.md`。


### Changed

- **B2 工具面描述来源变更（2026-10-28）**：三工具 description 从迁移前全文改为 catalog 行；`agent_roles` 新增 `help` action。参数级 description、任务书渲染、persona、策略数据零改动（面A 参数级 1527 → 1617 的 +90 全部来自 action `help=` 增补 +13 与 `allowTools` 新增 +77）。
- **测试账（B2）**：主套件 356 → 368（新增 12 用例，既有断言零删改）；`tools/` 19 → 20 文件（新增 `opt-b2-s3-gate.mjs`）。
- `0aef7ff` — **B0** 人格正文全部 DSH 原生化收尾：18 行 / 8 文件实改（裸 CC 工具名 → DSH 原生指令 + inline「对应原 X」注记），body_hash 刷新 23/23。
- `2b8b7a6` — **B0** 任务书删原第八节「Claude Code → DSH 工具映射」：七节定型（节号空洞保留）、兜底句「未列工具视作不可用」移入职责与边界节、run.mjs 反向断言钉死。
- `2d013dc` — **基线行为变更**：role 轨会话默认按构建期推导的 per-role 引用表收缩工具面（fail-open 全路径保障；`toolscopeEnabled=false` 整链停用可回退）。
- `b4b8ee4` — 显式 / 配置预设解析失败语义从静默降级升级为 **fail-fast 拒绝派活**：报错列可用预设、零会话创建；role 轨无显式预设照旧 legacy 降级（不扩大范围）。
- 测试账：主套件 346 → 356 全程门绿（逐步增量见 Fixed 与注记）。

### Fixed

**两起 Phase B 事故（如实入档）**

- `6a38224` — **事故一：agent_reply 投递实炸**。投递消息 `source.kind='plugin'` 被宿主 v4 会话日志校验器拒绝（followup 唤醒 idle 会话时 SessionFormatError，ORG 未唤醒、消息不落收件箱）。修复：改 `source.kind='user'`（对齐 spawn 链在役形态），来源归属保留在 content 首行信封；补变异必红专项回归（主套件 346→347）。
- `b4b8ee4` — **事故二：minimal 会话裸面（预设从未挂载）**。插件 fiber 内 `ctx.get('agentPresets')` 拿不到宿主 registry 服务 → 静默降级不挂预设 → 裸会话无预设工具 → 策略 allow 名全 unknown → 收缩 fail-open。修复：agentPresets 懒注入缓存 + RoleSpawner 三路解析序；allow 名单校准宿主真实注册面（eval-coding = read/write/edit/read_image/str_replace_editor/pwsh，read-only = read/read_image/de_broadcast，移除 glob/grep 幻影名）；`MINIMAL_TOOLSET_FULL` 常量与 roster 同步、classMap 补 str_replace_editor（主套件 347→350）。

**彩排拦截修复链**

- `6000ab9` — 组件导入双路链：dev checkout 内动态 import 裸名解析不到住宿主 node_modules 的组件包（装载器读到预设但挂组件必炸）。修复：直 import 失败 → 宿主包根 `createRequire.resolve` 兜底（exports 只开 import 条件时回落 package.json main）转 file URL import；persona / pwsh / fs / str-replace-editor 四组件本地实证；补机器无关负例 1 条（主套件 355→356）。
- `e522b9b` — 存在性校验误杀 bundle 迁移预设：bundle 预设只活在宿主 registry，磁盘扫描看不到，早期校验误报「不存在」。修复：校验分两路——服务可用 → registry resolve 校验（bundle 预设可达）；服务缺失 → 磁盘清单兜底（清单不认识 = 不存在并列清单；清单认识但目录缺席 + 服务缺失 = 无法挂载 fail-fast）；resolve 拒绝消息补磁盘可用清单；fakeCtx 假服务升级为按 listPresets 认真校验（主套件 356/0 维持）。

### Docs

- `fc41b7c` — B0 终验措辞序（纯排版）。
- `79657cc` — B1 S5 文档增量：README 三形态特性 / agent_reply 行 / B1 配置键 / 计数账；ARCHITECTURE 新增节 2.2 B1 增量。
- `d57c1bf` — PhaseB 选项③ 文档增量：ARCHITECTURE 新增节 2.3 独立预设挂载；README 特性节与目录结构同步。
- **B2 S4 文档同步（2026-10-28，`8ded417`）**：README 三工具表补 `help` 与 `allowTools` 单授一句、特性节补注入面裁剪（面A 2663→2225）、测试计数 356→368；ARCHITECTURE 三工具小节补 help 单源/allowTools、`tools/` 19→20（新增 `opt-b2-s3-gate.mjs` 行）、测试断言 356→368、B1 工具描述增量账标注为历史快照；本文件 B2 条目见 Added/Changed（不预填哈希）。

### 注记

- **四轮 fail-fast 拦截链（Phase B 端到端彩排，全程零孤儿会话）**：逐次拦截类型——① 缺省预设 `minimal` 本机不存在（列可用清单，防线正确）；② registry 与 `~/.dsh/.agent-presets/` 两套清单分裂拦「Unknown agent preset: minimal-eval」→ 转用户裁决（选项③）；③ 组件导入失败拦（→ `6000ab9`）；④ 用户手写预设 persona 行字段错（`text` ≠ schema 必填 `prefix`）被宿主 schema 校验拦；⑤ 存在性校验误拦 bundle 预设（→ `e522b9b`）。第四轮重派全链达标（2026-10-27，registry 兜底路 + bundle 挂载）：minimal 会话自持 write/edit 亲自完成三步产出、审计零 role-spawn 行、agent_reply 恰一条且 idle 唤醒、九门回归零扰动。
- **宿主侧裁决性发现**：宿主官方技能文档明示 `~/.dsh/.agent-presets/` 为 legacy 格式（"Nothing reads that directory any more"）；正解 = 自建预设做成 bundle 安装（`dsh plugin add`）经宿主 registry 挂载。插件磁盘装载路保留为宿主服务缺失时的独立兜底。
- **主套件计数演进**：346 → 347（`6a38224`）→ 350（`b4b8ee4`）→ 355（`40f5fad`）→ 356（`6000ab9`；`e522b9b` 维持）→ 368（B2 S2，2026-10-28，`b745068`）→ 375（动态 provider 接入三档选择范围，2026-10-29，`41ad468`）→ 375 维持（B5/B6/B7 三道新门未并入主套件，各走独立 selftest）→ **377（B5 X-3 补两条值断言：任务书泳道交付条款逐字在场 + `lastReviewedSeq` 哨兵 -1），终态 378/0**；`npm test` 串联入口 5 → 13（`0e0942a`）。
- **静态注入面零增长**：净注入口径B 1993/2181/2183 历次实测与锚逐字一致（S1→S5 五次 + Phase B 彩排后复跑）；工具描述增量单独计量，合计 ≤400B 上界（严格口径 309B / 全口径 360B）——**B2 起该账为历史快照**：三工具工具级描述裁为 catalog 行后面A 由 2663 降至 2225 码点（工具级 783→255），面D 口径B 仍 1993/2181/2183 零变化，净门见 `tools/opt-b2-s3-gate.mjs`。
