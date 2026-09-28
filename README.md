# dsh-agents

> 19 个专职角色 × 三档模型路由，装进 [DSH](https://github.com/deepseek-ai) 的多智能体工作台。
> 一次调用就创建一个「带角色人格 + 钉死档位模型 + 完整任务书」的子会话。

`dsh-agents` turns DSH into a role-routed multi-agent workspace: 19 specialist agents, each pinned
to a model tier (LOW / MEDIUM / HIGH), spawned in a single call with a persona, a pinned model and a
complete task brief — plus 23 workflow skills that orchestrate them end to end.

**关键词**：DSH 插件 · 多智能体编排 · 角色-模型档位路由 · 任务书合成 · 工作流技能 · agent orchestration

---

## 目录

- [为什么](#为什么)
- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [三个工具](#三个工具)
- [角色与档位](#角色与档位)
- [任务书](#任务书)
- [工作流技能](#工作流技能)
- [配置参考](#配置参考)
- [设置页](#设置页)
- [机检工具](#机检工具)
- [测试](#测试)
- [目录结构](#目录结构)
- [已知限制](#已知限制)
- [许可与致谢](#许可与致谢)

---

## 为什么

手工开子会话派活，问题往往不在「模型不够强」，而在三件事没人管：**用哪个模型、给它什么人设、任务书写到什么程度**。本插件把这三件事固化成机制：

1. **按角色复杂度分配模型，而不是拍脑袋。** [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC）在 19 个 agent 定义里给每个角色钉了一个 `model:` 字段；MACAE 的 ADR-003 从另一个方向得出同一结论——编排者用推理型模型、参与者用便宜模型。两条独立证据指向同一件事：**角色复杂度决定档位**，而不是全都上最贵的。
2. **派活是一次调用，不是一段规程。** 人格注入、档位解析、任务书合成都发生在 `agent_spawn` 内部；调用者只需要说清「谁做、做什么」。
3. **任务书是可审计的产物。** 派活消息本身就是一份八节任务书（含硬性完成标准与回收契约），可以先审后派（`agent_taskbook` 只合成不派活），也可以事后据此核对交付。

## 特性

- **19 个专职角色，3 条泳道**——build（构建与分析 8）· review（评审与质量闸门 4）· domain（领域专家 7）。
- **三档模型路由**（LOW / MEDIUM / HIGH ← haiku / sonnet / opus），档位可被用户层覆盖（设置页或 `agent_roles set`），解析优先级明确、可查来源。
- **只读角色有明确边界**——上游标注 `disallowedTools: Write, Edit` 的 **9 个角色**（explore · analyst · architect · verifier · code-reviewer · security-reviewer · critic · document-specialist · scientist）在任务书里写成只读顾问条款，任务书同时注明这只是文字约束（见[已知限制](#已知限制)）。
- **任务书八节结构** + **派活前置三问**（副作用关键词 fail-closed 告警）。
- **23 件工作流技能**：路由入口 1 + 流水线 4 + 协作 5 + 方法论 13。
- **11 份评审清单**按扩展名/专项路由（go / ts / python / kotlin / rust / csharp / cpp / sql / pytorch / a11y / performance）。
- **两个确定性机检工具**：`crgate`（评审证据链 freeze/anchor/finalize）与 `publish-scan`（发布前脱敏六类扫描 + 三值裁定）。
- **配置错就报错**——未知档位、未知角色、半个路由、非法 `clarifyMode` 一律抛错，不静默兜底。

## 环境要求

- **DSH**：需要宿主提供 `tools` 服务（工具经 `ctx.tools.register` 注册）。`settings` / `llm` / `workspaceRegistry` / `agentPresets` 为**可选**服务，按宿主约定动态读取——旧快照缺它们时插件照常加载，只是降级为「不按名解析 provider、不挂工作区分组、不挂预设」。
- **Node.js**：支持 ESM 的现代版本（本仓开发环境为 Node 24）。
- 新增 bundle 后需要**重启 DSH**：宿主引导图在启动时生成，运行中新增的插件不会被加载。

## 安装

```bash
# 本地路径安装（推荐先 git clone 到本地）
dsh plugin --profile <profile-name> add /path/to/dsh-agents

# 或直接从 git 安装
dsh plugin --profile <profile-name> add https://github.com/wangyuanchuan2022/dsh-agents
```

宿主契约与既有 DSH 插件一致：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（往插件花名册 `insert` 一行 `id`/`name`），`lib/index.js` 导出 `name` / `inject` / `apply`，工具经 `ctx.tools.register` 注册。

> 安装后**不要**再在 profile patch 里重复插入同一 `id` —— 重复 id 会让 loader 崩。

人格正文位于 `personas/`；`tools/install-personas.mjs` 可批量安装到 DSH（默认跳过已有自定义版本的角色，避免把定制版覆盖回通用版）。

## 快速开始

```js
// 1. 看有哪些角色、各自档位与实际解析到的模型
agent_roles(action="list", lane="review")
agent_roles(action="tiers")            // 档位路由表体检：配置的 provider/model 是否真的存在

// 2. 派活前先审任务书（只合成，不创建会话）
agent_taskbook(role="code-reviewer", task="评审 src/ 下这批改动，给出 P0/P1/P2 分级")

// 3. 一步派活：解析档位 → 注入人格与任务书 → 创建标准 DSH 会话并立即开跑
agent_spawn(role="executor", task="实现 X，按 tests/ 现有风格补测试")
```

角色会话产出的默认落盘路径是 `<cwd>/agent-out/<角色id>-<yyyyMMdd-HHmm>.md`（可用 `evidencePath` 覆盖）。会话本身是**标准 DSH 会话**：出现在左侧会话列表，可随时接管、继续对话或查看转录。派活方用 `de_session action=status|list` 做角色回收核对。

## 三个工具

| 工具 | 作用 |
|---|---|
| `agent_roles` | 角色目录 / 单角色详情 / **档位路由表体检**。动作：`list`（可按泳道、档位过滤）、`show`、`tiers`、`set`（改某档 provider+model，与设置页同源）、`reset`。 |
| `agent_taskbook` | **只合成任务书，不派活**：角色卡 + 职责边界 + 人格细则 + 任务 + 交付验收 + 澄清模式 + 汇报回收 + Claude→DSH 工具映射，附派活前置三问与本次路由解析结果。 |
| `agent_spawn` | **一步派活**：解析档位 → 注入人格与任务书 → 创建标准 DSH 会话并立即开跑；`dryRun=true` 只回路由与任务书；`tier` / `provider` / `model` 可越档但会记入返回（可审计，不阻拦）。 |

**边界**：本插件只**创建**会话，不负责 `wake` / `status` / `list` / `rename`——那些归 `de_session`。

## 角色与档位

档位语义：**LOW** 窄而快的检索/文档/批量任务 · **MEDIUM** 实现/调试/测试/设计等主力工作 · **HIGH** 需求分析/规划/架构/评审等长链条推理。

| 档位 | build | review | domain |
|---|---|---|---|
| **HIGH** | analyst 🔒 · planner · architect 🔒 | code-reviewer 🔒 · security-reviewer 🔒 · critic 🔒 · code-simplifier | — |
| **MEDIUM** | debugger · executor · verifier 🔒 · tracer | — | test-engineer · designer · qa-tester · git-master · document-specialist 🔒 · scientist 🔒 |
| **LOW** | explore 🔒 | — | writer |

🔒 = 只读角色（上游 `disallowedTools: Write, Edit`），任务书中写成只读顾问条款。
合计：HIGH 7 · MEDIUM 10 · LOW 2 = **19 个角色**。

档位映射分两层：

1. **基底**：`cordis.patch.yml` 的 `config.tiers`（出厂默认，见[配置参考](#配置参考)）；
2. **用户层覆盖**：设置页「Agents 三档模型路由」卡片，或 `agent_roles action=set`。
   解析优先级：调用期显式 `tier`/`provider`/`model` → `roleOverrides` → settings 用户层 → cordis 基底 → 内置默认表。

> ⚠️ 档位表是**配置**不是常量——派活前用 `agent_roles action=tiers` 查当次生效值与来源（`tierSources`），不要假设某个档位一定指向某个模型。

## 任务书

派活的首条消息 = 八节任务书：

1. **角色卡**：角色 id / 泳道 + 档位与**钉死的 provider/model** + 定档依据 + 权限边界 + 人格文件哈希；
2. **职责与边界**；
3. **人格细则**（`personas/<id>.md`；未安装时退化为角色摘要模式并在卡里标注）；
4. **本次任务** + 背景上下文；
5. **交付与验收**：产出落盘路径、泳道默认交付要求（评审类强制「`文件:行号` + P0/P1/P2 + 【改进点】」）、**硬性完成标准双条件**（落盘 + `de_broadcast` 回报，缺一即未完成）；
6. **澄清模式**：`interactive` = 缺参数按 `subagent-clarify` 协议问组织者、防编造、超时降级；`autonomous` = 禁提问 + 缺省决策表；
7. **汇报与回收核对**：完成广播对象、里程碑进度、`de_session list/status` 回收；
8. **Claude Code → DSH 工具映射**：`lsp_diagnostics`→pwsh 跑检查、`TodoWrite`→`todo_write`、`Task(...)`→`de_session spawn`、tmux→pwsh 后台任务等。

另有**派活前置三问**（方向与「失败也照常执行」相反，这里**不派才是安全默认**）：① 这事哪个会话能做？② 目标会话有没有对应工具与数据？③ 是否在要求对方做它做不到的副作用（写库/删数据/发消息/装依赖）？任务文本命中副作用关键词时自动告警（fail-closed）。

模板正本：`docs/task-brief-v3.md`——本节是结构概览，条款以正本为准。

## 工作流技能

`skills/` 共 23 件，分四组。技能的 `description` 一律**触发词前置**（`触发：<中文提法>｜English: <triggers>｜<职责>`），因为 DSH 技能目录只显示 description 前若干百字符，触发词写在末尾会被截断而无法被发现。

**入口（1）**

| 技能 | 作用 |
|---|---|
| `agent-workflow-router` | 总入口：按用户意图路由到下面 22 件之一，固化五条硬协议（派活前置三问 / 档位现场确认禁越档 / 任务书四条必含 / 点对点消息纪律 / 工作区纪律），附前置门与六条组合串联链。 |

**流水线（4）**——编排本插件的 19 角色

| 技能 | 链路 |
|---|---|
| `agent-autopilot` | 旗舰：想法 → 验证过的代码，六阶段（扩写/规划/执行/QA/验证/收尾）带相位门与 fail-closed 席位判定 |
| `agent-feature` | analyst → planner → executor → test-engineer → code-reviewer → verifier |
| `agent-bugfix` | explore → debugger（→ tracer）→ test-engineer → verifier |
| `agent-review-squad` | code-reviewer + security-reviewer 并行盲评 → critic 裁决（→ code-simplifier） |

**协作（5）**——工作流的外围协议

| 技能 | 作用 |
|---|---|
| `subagent-clarify` | 子会话澄清协议：缺信息不瞎猜，结构化提问 → 广播问组织者 → 超时降级 |
| `requirement-interview` | 需求访谈：苏格拉底式提问 + 含糊度门控，≤阈值才准动代码 |
| `consensus-plan` | 共识规划：规划与执行分离，planner 快照 → architect/critic 串行盲评 → ≤5 轮至 APPROVE |
| `ai-slop-cleaner` | 先锁行为再清理，五类 slop 分类 + 单味道单批次 + writer/reviewer 分离 |
| `visual-verdict` | 视觉判定：截图 vs 参考图输出结构化 JSON verdict，达标才准收工 |

**方法论（13）**——实现/评审/发布环节的作战手册

`agent-loop`（长任务循环：启动三查 / 停止条件落盘 / 心跳纪律 / 熔断）、`tdd-workflow`、`verification-loop`、`parallel-execution-optimizer`、`error-handling`、`git-workflow`、`operator-approval-loop`、`agent-harness-construction`、`skill-eval`、`skill-stocktake`、`session-handoff`、`dsh-troubleshooting`、`opensource-sanitize`。

安装：把需要的技能目录复制到 DSH 技能库（`~/.agents/skills` 或 `~/.dsh/skills`）即可被会话按 description 触发。

## 配置参考

全部可配项在 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-agents
      name: dsh-agents
      config:
        # 档位 → provider + model（出厂基底；按你环境里真实存在的 provider 改）
        tiers:
          LOW:    { provider: deepseek, model: deepseek-flash }
          MEDIUM: { provider: glm-pro,  model: glm-5.3-flash }
          HIGH:   { provider: deepseek, model: deepseek-v4-pro }

        # 可选：按角色覆盖档位
        # roleOverrides:
        #   executor: { provider: deepseek, model: deepseek-v4-pro }

        # 可选：角色会话使用的 Agent 预设（不填 = DSH 默认预设）
        # defaultPreset: standard

        clarifyMode: interactive   # interactive | autonomous
        agentOutSubdir: agent-out  # 未显式给 evidencePath 时的产出目录（相对 cwd）
        allowSpawn: true           # false = 紧急刹车，禁用 agent_spawn（另两个工具仍可用）
```

| 键 | 类型 | 说明 |
|---|---|---|
| `tiers` | `{LOW,MEDIUM,HIGH} → {provider,model}` | 档位路由基底。别名 `haiku`/`sonnet`/`opus` 同义。 |
| `roleOverrides` | `{<角色id>: {provider,model}}` | 按角色覆盖档位（优先级低于调用期显式传参）。 |
| `defaultPreset` | string | 角色会话的 Agent 预设 id；不填走 DSH 默认。 |
| `clarifyMode` | `interactive` \| `autonomous` | 任务书澄清模式缺省值。 |
| `agentOutSubdir` | string | 产出目录名（相对 cwd）。 |
| `allowSpawn` | boolean | 紧急刹车开关。 |

**fail-loud 约定**：未知档位、未知角色 id、半个路由（只给 provider 或只给 model）、非法 `clarifyMode` 一律**直接抛错**——静默兜底会把「改了没生效」变成黑盒。

## 设置页

DSH 设置 → 插件 → 「Agents 三档模型路由」卡片，三档各配 provider + model，支持逐档「保存 / 放弃修改 / 恢复基底」与「全部重置」。改完**即时生效，无需重启**：设置卡与 `agent_spawn` 共用同一份解析值。

接线方式与 DSH 生态既有插件的「服务端命名空间 × 浏览器端卡片」双半结构同构：**服务端**（`lib/settings.js` + `lib/http-config.js`）注册 settings 命名空间 `dsh-agents` 并挂 `GET/PATCH /plugins/dsh-agents/config`（回环 + Origin 同源防护）；**浏览器端**（`lib/client.js`）在 `settings.plugin.item` 槽位注册 `key=dsh-agents` 的卡片。两半缺一，设置页不会渲染（`package.json` 的 `dsh.client` 字段就是这半边存在的前提）。

## 机检工具

| 工具 | 作用 | 自测 |
|---|---|---|
| `tools/crgate.mjs` | 评审的确定性证据链：`freeze`（选择器）/ `anchor`（三级定位，`--strict` 为交付前强制门）/ `finalize`（覆盖状态机） | `node tools/crgate.test.mjs`（65 断言） |
| `tools/publish-scan.mjs` | 发布前脱敏机检：六类扫描（secrets / PII / 内部路径 / 危险文件 / 配置完整性 / git 历史）+ 三值裁定（PASS / PASS-WITH-WARNINGS / FAIL，单条 CRITICAL 即 FAIL）；`--strict-tracked --git-history` 为单仓放行门 | `node tools/publish-scan.test.mjs`（47 断言） |
| `tools/install-personas.mjs` | 人格批量安装（默认跳过已有自定义版本的角色） | — |
| `tools/assemble-review.mjs` | 评审材料装配（`tools/approved.json` 记录批准来源与时间） | — |

## 测试

```bash
node tests/run.mjs                    # 主测试（54 passed / 0 failed）：纯逻辑 + 假宿主全链路 + 端点 + 浏览器半/manifest 门
node tools/crgate.test.mjs            # 65 断言
node tools/publish-scan.test.mjs      # 47 断言
node tests/boot-schema-check.mjs      # 宿主真实校验器验收门（装前必过）
node tests/installed-smoke.mjs        # 安装副本烟测：工具 + settings + 端点三方同源
```

> **不要用 `node --test`**：在受限沙箱（如 DSH 自身的 Windows 沙箱）里 node 的 pipe 子进程捕获会 `EPERM`，逐文件直跑是可靠方式。
> 重启后可用 `tests/probe-boot.mjs` / `probe-catalog.mjs` / `probe-client.mjs` 探针确认宿主引导图已含本插件、工具目录与 `client.js` 均可分发。

## 目录结构

```
dsh-agents/
  package.json             插件清单（dsh.bundle.patch + dsh.client 浏览器半声明）
  cordis.patch.yml         宿主插件行 + 全部可配项
  lib/
    index.js               插件入口 + 三个工具定义
    roles.js               19 角色注册表（元数据；人格正文不在此）
    routing.js             档位路由解析 + 按模型名反查 provider + 目录体检
    persona.js             人格加载（缺文件退化 + 哈希留档）
    taskbook.js            任务书合成 + 派活前置三问
    spawn.js               会话创建（对齐 de_session 的踩坑修复时序）
    settings.js            三档配置：settings 命名空间注册 + tiersApi
    settings-compat.js     宿主 settings 服务版本差异的兼容层
    http-config.js         设置卡数据端点
    client.js              浏览器半：设置卡
  personas/                19 份人格正文
  personas/checklists/     11 份评审清单（语言 7 + 专项 4，按扩展名/专项路由）
  skills/                  23 件工作流技能（源副本）
  docs/task-brief-v3.md    任务书模板正本
  tools/                   crgate / publish-scan / install-personas / assemble-review
  tests/                   run.mjs + 宿主校验、烟测与探针
  LICENSE                  MIT
  THIRD-PARTY-NOTICES.md   第三方许可与版权声明
```

## 已知限制

1. **只读角色是文字约束，不是硬隔离**：DSH 无法按会话禁用工具，只读是任务书条款；要硬隔离需给该角色配一个禁写工具的 Agent 预设（`defaultPreset` / `agentPreset` 可指定）。
2. **人格文件缺失时退化为摘要模式**：`personas/<id>.md` 不在位时角色仍可用，但行为约束全部来自任务书条款，且任务书里会明确标注。
3. **只创建，不管理**：`wake` / `status` / `list` / `rename` 归 `de_session`。
4. **预设只作用于创建时刻**：会话运行中不可切换 Agent 预设（宿主 `agent-preset-locked`）。
5. **档位是默认值不是强制**：可以越档派活，越档会记入返回并在任务书里留理由位（便于事后审计，不阻拦）。
6. **`agent_spawn` 依赖宿主 `agents` 服务**；`workspaceRegistry` 缺失时不影响创建，只是不挂左侧工作区分组。
7. **档位表随配置变化**：README 里给的是出厂基底，真实生效值以 `agent_roles action=tiers` 的当次回显为准。

## 许可与致谢

- **本仓库自身代码**：MIT，见 [LICENSE](LICENSE)。
- **角色体系**：移植自 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)（OMC，MIT，Copyright © 2025 Yeachan Heo）——19 个角色的定义与人格原文逐字对照翻译，按 MIT 要求保留其版权与许可全文，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- **任务书模板**：源自 MACAE（Microsoft，MIT）的可移植机制清单（Top1/Top5 落地项）。
- **部分协作与方法论技能、专项评审清单、`tools/publish-scan.mjs`**：源自 [Everything Claude Code](https://github.com/affaan-m/everything-claude-code)（ECC）v2.2.2 的分析移植，全量保真 + 行内【适配】标注。
- **会话创建时序**：来自 `dsh-memory-evolve` 的 `de_session` 实机踩坑记录（预设挂载、provider 解析、种子序号、工作区挂接）。

欢迎 issue 与 PR。若你的角色/档位配置有普适价值，也欢迎回灌成基底默认。
