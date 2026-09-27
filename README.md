# dsh-agents —— 19 个专职角色 × 模型档位路由（DSH 插件）

把 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC，MIT）的角色体系移植到 DSH：
**19 个专职角色，每个角色钉死一个模型档位**，派活时一步创建「带角色人格 + 钉死档位模型 + 完整任务书」的子会话。

档位不是拍脑袋：MACAE 的 ADR-003（编排者用推理型模型、参与者用便宜模型）与 OMC 的 19 个 agent 定义
（`agents/*.md` 的前 `model:` 字段）**两家独立得出同一结论**——按角色复杂度分配模型，官方口径省 30-50% token。

---

## 1. 三个工具

| 工具 | 作用 |
|---|---|
| `agent_roles` | 角色目录 / 单角色详情 / 档位路由表体检（配置的 provider+model 是否真的存在） |
| `agent_taskbook` | **只合成任务书**（不派活）：角色卡 + 职责边界 + 人格细则 + 任务 + 交付验收 + 澄清模式 + 汇报回收 + Claude→DSH 工具映射，附派活前置三问 |
| `agent_spawn` | **一步派活**：解析档位 → 注入人格与任务书 → 创建标准 DSH 会话并立即开跑（出现在左侧列表，可随时接管）；`dryRun=true` 只回路由与任务书 |

```
agent_roles(action="list", lane="review")        # 看有哪些评审角色、各自档位与模型
agent_taskbook(role="code-reviewer", task="…")   # 派活前先审任务书
agent_spawn(role="executor", task="…")           # 直接派活（默认继承发起会话的 cwd）
```

角色会话产出的默认落盘路径：`<cwd>/agent-out/<角色id>-<yyyyMMdd-HHmm>.md`（可用 `evidencePath` 覆盖），
组织者用 `de_session action=status/list` 做**角色回收核对**。

---

## 2. 19 个角色与档位

泳道：**build**（构建与分析）、**review**（评审与质量闸门）、**domain**（领域专家）。
只读 = 上游 `disallowedTools: Write, Edit` 的角色，任务书会明确写成「只读顾问」条款。

| 档位 | 角色 | 只读 |
|---|---|---|
| **HIGH**（opus，7 个：长链条推理 + 可靠结构化输出） | analyst、planner、architect、code-reviewer、security-reviewer、critic、code-simplifier | 除 planner / code-simplifier 外均只读 |
| **MEDIUM**（sonnet，10 个：主力实现与专业工作） | debugger、executor、verifier、tracer、test-engineer、designer、qa-tester、git-master、document-specialist、scientist | verifier / document-specialist / scientist 只读 |
| **LOW**（haiku，2 个：窄而快的检索/写作任务） | explore、writer | explore 只读 |

档位默认映射（本机 `settings.yaml` 里确实配置的 provider）：

| 档位 | provider / model | 设计意图 |
|---|---|---|
| LOW | `deepseek` / `deepseek-flash` | 检索、定位、文档、批量转录等窄任务 |
| MEDIUM | `glm-pro` / `glm-5.3-flash` | 实现、调试、测试、设计、数据、QA、提交等主力工作 |
| HIGH | `deepseek` / `deepseek-v4-pro` | 需求分析、规划、架构、代码/安全/计划评审 |

---

## 3. 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-agents
      name: dsh-agents
      config:
        tiers:                                    # 档位 → provider + model（改档只改这里）
          LOW:    { provider: deepseek, model: deepseek-flash }
          MEDIUM: { provider: glm-pro,  model: glm-5.3-flash }
          HIGH:   { provider: deepseek, model: deepseek-v4-pro }
        # roleOverrides:                          # 可选：按角色覆盖档位
        #   executor: { provider: deepseek, model: deepseek-v4-pro }
        # defaultPreset: standard                 # 可选：角色会话的 Agent 预设（不填=DSH 默认）
        clarifyMode: interactive                  # interactive | autonomous
        agentOutSubdir: agent-out                 # 默认产出目录名（相对 cwd）
        allowSpawn: true                          # false = 紧急刹车，禁用 agent_spawn
```

配置错（未知档位、未知角色 id、半个路由、非法 `clarifyMode`）**直接抛错**——静默兜底会让「改了没生效」变成黑盒。

## 4. 安装

```powershell
dsh plugin --profile web add D:\tools\deepsek_harness\dsh-agents
```

宿主契约与既有插件一致：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`（insert 一行 id/name），
`lib/index.js` 导出 `name` / `inject` / `apply`，工具经 `ctx.tools.register` 注册（`parameters` 单一 `type`
+ 顶层 `required`，`output.schema` + `output.render` 缺一注册报错）。
`inject = ['tools','agents']`；`llm`/`settings`/`workspaceRegistry`/`agentPresets` 是**可选**服务，
按宿主约定用 `ctx.get` 动态读取——旧快照缺它们时插件照常加载（降级为不按名解析 provider、不挂预设）。

---

## 5. 任务书（本插件的核心产物，来自 MACAE 清单 Top1）

派活的首条消息 = 八节任务书：

1. **角色卡**：角色 id/泳道 + 档位与**钉死的 provider/model** + 定档依据 + 权限边界 + 人格文件哈希；
2. **职责与边界**；
3. **人格细则**（`personas/<id>.md`；未安装时退化为角色摘要模式并在卡里标注）；
4. **本次任务**（+ 背景上下文）；
5. **交付与验收**：产出落盘路径、泳道默认交付要求（评审类强制「`文件:行号` + P0/P1/P2 + 【改进点】」）、
   **硬性完成标准双条件**（落盘 + `de_broadcast` 回报，缺一即未完成）；
6. **澄清模式**：`interactive`＝缺参数按 `subagent-clarify` 协议问组织者、防编造、超时降级；
   `autonomous`＝禁提问 + **缺省决策表**（未提供时用内置表）；
7. **汇报与回收核对**：完成广播对象、里程碑进度、`de_session list/status` 回收；
8. **Claude Code → DSH 工具映射**：`lsp_diagnostics`→pwsh 跑检查、`TodoWrite`→`todo_write`、
   `Task(...)`→`de_session spawn`、`.omc/*`→任务书路径 / `memory` 工具、tmux→pwsh 后台任务……

另有**派活前置三问**（MACAE B2 的 DSH 变体，方向反转）：MACAE 分类失败 fail-open 照常执行，
DSH 语境里「不派」才是安全默认——① 这事哪个会话能做 ② 目标会话有没有对应工具/数据 ③ 是否要求对方
做它做不到的副作用（写库/删数据/发消息/装依赖）。任务文本命中副作用关键词时自动告警（fail-closed）。

---

## 6. 已知限制

1. **只读角色靠文字约束，不是硬隔离**：DSH 无法按会话禁用工具，`只读顾问` 是任务书条款而非机制；
   要硬隔离需给该角色配一个禁写工具的 Agent 预设（`defaultPreset`/`agentPreset` 可指定）。
2. **人格文件需用户批准后才安装**：`personas/<id>.md` 缺失时角色退化为摘要模式（不报错、任务书里明确标注），
   此时行为约束全部来自任务书条款。
3. **只创建，不管理**：`wake`/`status`/`list`/`rename` 仍归 `de_session`；本插件不重复实现。
4. **预设只作用于创建时刻**：会话运行中不可切换预设（宿主 `agent-preset-locked`）。
5. **档位是默认值不是强制**：`tier`/`model`/`provider` 可越档，越档会记入返回并在任务书里留理由位（可审计，不阻拦）。
6. `agent_spawn` 依赖宿主 `agents` 服务；`ctx.get('workspaceRegistry')` 缺失时不影响创建，仅不挂左侧分组。

## 7. 目录

```
dsh-agents/
  package.json          插件清单（dsh.bundle.patch + dsh.client 浏览器半声明）
  cordis.patch.yml      宿主插件行 + 全部可配项
  lib/roles.js          19 角色注册表（元数据；人格正文不在此）
  lib/routing.js        档位路由解析 + 按模型名反查 provider + 目录体检
  lib/persona.js        人格加载（personas/<id>.md，缺文件退化 + 哈希留档）
  lib/taskbook.js       任务书合成 + 派活前置三问
  lib/spawn.js          会话创建（对齐 de_session 的踩坑修复时序）
  lib/settings.js       三档配置：settings 命名空间注册（标准 ctx.inject 接线）+ tiersApi
  lib/http-config.js    设置卡数据端点（GET/PATCH /plugins/dsh-agents/config）
  lib/client.js         浏览器半：设置卡（settings.plugin.item 槽位，懒 CJS 工厂格式）
  lib/index.js          插件入口 + 三个工具定义
  personas/             19 份人格正文（经用户逐篇批准后写入）
  personas/checklists/  11 份评审清单（语言 7 + 专项 4，按扩展名路由）
  docs/task-brief-v3.md 任务书模板正本（v3.2：回收契约 + 工作单元状态语义）
  skills/               23 件工作流技能（见 §9，源副本；装机副本 ~/.agents/skills 与 ~/.dsh/skills）
  review/               审批材料：BRIEF.md（译制规范）、original/（OMC 原文）、trans/（中文+适配）
  tests/run.mjs         直跑测试（46 项：纯逻辑 + 假宿主全链路 + 端点 + 浏览器半/manifest 门）
  tests/boot-schema-check.mjs  宿主真实校验器验收门（装前必过）
  tests/installed-smoke.mjs    安装副本烟测（工具+settings+端点三方同源）
  tests/probe-boot.mjs  重启后探针：宿主引导图含 dsh-agents + client.js 可分发
  tools/crgate.mjs      评审确定性机检（freeze/anchor/finalize，自测 65 断言）
  tools/publish-scan.mjs 发布前脱敏机检（v1.0.4，六类扫描+三值裁定，自测 47 断言）
  tools/install-personas.mjs   人格批量安装（默认跳过 code-reviewer v2+，防降级覆盖）
```

测试：`node tests/run.mjs`（不用 `node --test`——DSH 沙箱内 node 的 pipe 子进程捕获会 EPERM）。
工具自测：`node tools/crgate.test.mjs`（65）+ `node tools/publish-scan.test.mjs`（47）。

## 8. 来源与许可

- 角色定义与人格原文：oh-my-claudecode（MIT，Copyright © Yeachan Heo），原文逐字留档于 `review/original/`；
- 任务书模板：MACAE（Microsoft，MIT）可移植机制清单 B1/B2/B3/B4；
- 会话创建时序：`dsh-memory-evolve` 的 `de_session` 实机踩坑记录（presets 挂载、provider 解析、seed seq、工作区挂接）。

---

## 9. 完整工作流技能集（skills/，23 件）

技能分四组。**源副本=本仓 `skills/`**；装机副本：流水线/协作/路由十一件在 `~/.agents/skills/`，工作流方法论十三件在
`~/.dsh/skills/`——**改动必须双位同步并比对哈希**（单向改动=漂移，2026-09-26 已抓过两起先例）。
入口纪律：所有技能的 `description` **触发词前置**（`触发：<中文提法>｜English: <triggers>｜<职责正文>`）——
DSH 技能目录只显示 description 前 ~330-500 字符，触发词写在末尾会被截断而无法被自动发现。

### 9.0 路由入口（1 件，用户没点技能名时先加载它）

| 技能 | 作用 |
|---|---|
| `agent-workflow-router` | **总入口**：按用户意图路由到下面 22 件之一（§1 意图表 22 行），并固化五条硬协议（派活前置三问／档位现场确认禁越档／任务书四条必含（双条件+增量落盘+不停回合+ORG ID）／消息纪律（点对点、禁 project:）／工作区纪律（不传 cwd）），附前置门（含糊→requirement-interview、重大方案→consensus-plan、长任务→agent-loop 停止条件、上下文将满→session-handoff）与组合范式（新项目/加功能/修 bug/大重构/长跑实验/发布 六条串联链） |

### 9.1 流水线技能（4 件，编排本插件 19 角色）

| 技能 | 角色 | 用途 |
|---|---|---|
| `agent-autopilot` | 全 19 角色按需（六阶段核心链） | 旗舰：想法→验证过的代码，六阶段硬门（v2.1 增尺寸分级+相位掩码/席位 fail-closed/档位置信度等十条机制） |
| `agent-feature` | analyst→planner→executor→test-engineer→code-reviewer→verifier | 明确特性的六角色流水线 |
| `agent-bugfix` | explore→debugger(→tracer)→test-engineer→verifier | 缺陷追猎：根因→回归锁→取证 |
| `agent-review-squad` | code-reviewer+security-reviewer 并行盲评→critic 裁决(→code-simplifier) | 评审小队（v2.1 增评审面复用路由表/CRITICAL 即停/对抗验证 fail-closed 等九条） |

### 9.2 协作技能（5 件，工作流的外围协议，源自 port-kit）

| 技能 | 作用 |
|---|---|
| `subagent-clarify` | 子会话澄清协议：缺信息不瞎猜，结构化提问→广播问组织者→超时降级缺省表 |
| `requirement-interview` | 需求访谈：苏格拉底式提问+数学化含糊度门控，含糊度≤阈值才准动代码 |
| `consensus-plan` | 共识规划：规划与执行分离，planner 快照→architect/critic 串行盲评→≤5 轮至 APPROVE |
| `ai-slop-cleaner` | AI 屎山清理：先锁行为再清理，五类 slop 分类+单味道单批次+writer/reviewer 分离 |
| `visual-verdict` | 视觉判定：截图 vs 参考图的结构化 JSON verdict，score≥90 且 pass 才准收工 |

### 9.3 工作流方法论技能（13 件，源自 Everything Claude Code v2.2.2 分析移植）

| 技能 | 工作流环节 | 说明 |
|---|---|---|
| `agent-loop` | 长任务循环 | **三合一**（机制/判断/模式三层，787 行）：loop-start/status/guard + 心跳纪律三要素 + 五崩法 + DAG 编排选型树——吸收已废弃的 loop-design-check 与 autonomous-loops（2026-09-27 合并） |
| `tdd-workflow` | 实现/测试 | RED 门不可让渡+TDD 证据报告五列表（供 test-engineer 引用；80% 覆盖率条款按本机 100% 口径适配） |
| `verification-loop` | 收尾核验 | 六相命令矩阵+固定 VERIFICATION REPORT（verifier 人格同款格式） |
| `parallel-execution-optimizer` | 并行编排 | lane 矩阵+写面隔离并行授权判据 |
| `error-handling` | 健壮性 | TS/Python/Go 错误处理模式（类型化错误/重试/熔断） |
| `git-workflow` | 提交纪律 | 分支策略/合并 vs rebase/冲突解决（push 类条款按本机「push 需用户批准」适配） |
| `operator-approval-loop` | 外发审批 | epoch 键控审批账+一次投递保证（含 references/ 审批账 schema 与断言脚本） |
| `agent-harness-construction` | 工具面设计 | 动作空间/工具定义/observation 格式设计与优化 |
| `skill-eval` | 经验沉淀 | skill_manage create 前置闸：grep 重叠→四态裁决→写后校验 |
| `skill-stocktake` | 技能盘点 | 五态裁决（Keep/Improve/Update/Retire/Merge），「7d/30d 使用」列降级 mtime/hit-stats |
| `session-handoff` | 会话交接 | 八节交接文档（What Did NOT Work=核心节），session.jsonl.zstd 为唯一转录事实源 |
| `dsh-troubleshooting` | 排障 | 本机实证症状索引（假 idle=429/EPERM/PS5 管道污染等 8 条，增量模式） |
| `opensource-sanitize` | 发布把关 | 六类扫描+三值裁定，配套 `tools/publish-scan.mjs`（push 前跑单仓放行门） |

移植纪律：ECC 来源技能**全量保真**——frontmatter 契约化 + 头部 ECC→DSH 映射块 + 行内【适配】标注，
原文零删减；保真校验脚本（47+11 断言）留档于 `ecc-analysis/batch2/verify-fidelity*.mjs`。

任务书模板正本：`docs/task-brief-v3.md`（v3.2 = v3.1 OCR 批次四件 + 回收契约（IMP-06）+ 工作单元
状态语义（IMP-14：四字段头/deps 显式声明禁正则扫/单写者/迁移白名单/收尾双门））。

---

## 10. 设置页：三档模型手动配置（2026-09-12 新增，同日修复设置卡）

插件采用与 dsh-dafeiyu 相同的「服务端命名空间 × 浏览器端卡片」双半结构（DSH 设置页
只渲染两者的交集：宿主 settings 服务已注册的命名空间 × 已在 `settings.plugin.item`
槽位注册、key=命名空间的浏览器卡片）：

- **服务端**（`lib/settings.js` + `lib/http-config.js`）：
  - `ctx.inject(['settings'], …)` 等服务挂载后注册命名空间 `dsh-agents`
    （对照 `@deepseek-ai/dsh-settings` 自带的 `installSettingsSection` 标准接线）；
    base = cordis.patch.yml 的 config.tiers，用户改值落 user 层，解析顺序
    schema 默认 < base < user；
  - `ctx.inject(['webServer'], …)` 挂 exact 路由 `GET/PATCH /plugins/dsh-agents/config`
    （回环 + Origin 同源防护），为设置卡供数；PATCH 白名单形状：
    `{tier,provider,model}` / `{reset:档位}` / `{resetAll:true}`。
- **浏览器端**（`lib/client.js`，`window.__ModuleLoader__` 懒 CJS 工厂格式）：
  注册「Agents 三档模型路由」卡片（key=`dsh-agents`），三档各配 provider+model，
  支持逐档「保存 / 放弃修改 / 恢复基底」与「全部重置」，数据走上述端点。
- `package.json` 声明 `dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings-plugins"] }`
  ——没有这个字段宿主引导图（`window.__DSH_BOOT__`）不会包含本插件的浏览器半，
  设置卡永远不会出现（2026-09-12「没有设置卡」事故根因：只有服务端一半 +
  用 `ctx.get('settings')` 字符串取服务拿不到 cordis 服务，双重静默降级）。

行为要点：

- 改完**即时生效，无需重启**——spawn/taskbook 与设置卡共用同一 settings 解析值
- 解析优先级：调用期显式 route/tier（最高）→ `roleOverrides` → **settings 用户层** → cordis 配置基底 → 内置默认表
- `agent_roles` 新增动作：`set`（tier+provider+model，AI 代改，与设置卡同源）、`reset`（清用户覆盖回落基底）；`tiers` 动作新增 `tierSources` 字段标注各档生效来源
- settings 服务或 webServer 缺失时：插件照常加载，档位回落 cordis 配置链；设置卡显示「不可用」而非报错
- 依赖：`@deepseek-ai/schemastery` ^3.18.1（宿主同款包；安全扫描 R-EVAL 为 schema 序列化复活机制，声明式用法不触碰，用户已批准引入）
- 测试守卫：`tests/run.mjs`（46 断言，含端点防护/浏览器半格式/manifest 门）、
  `tests/boot-schema-check.mjs`（宿主真实校验器 6/6）、`tests/installed-smoke.mjs`
  （安装副本烟测：工具+settings+端点三方同源）、`tests/probe-boot.mjs`（重启后
  验证宿主引导图已含 dsh-agents 且 client.js 可分发）