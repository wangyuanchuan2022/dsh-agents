# ARCHITECTURE — dsh-agents 仓库全景（评审导览）

> 本文面向**外部评审者**：逐部件说明本仓 99 个跟踪文件的职责、接线与质量账。
> 使用向导（安装/快速开始/配置）见 [README.md](README.md)；上游许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
> 本文由维护侧在 2026-09-30 公开化批次编写；部件清单以 `git ls-files` 实测为准（当前 99 文件，本文自身计入）。
> 术语注：文中 IMP-xx / M-1 / 批次 N 为维护侧内部批次编号，仅作溯源标记不承载技术含义；A-full = 「干净 clone → npm install → 跑通全部可复现门」的可安装性验收模式。

---

## 0. 一句话与关键数字

**dsh-agents 是一个 DSH 插件**：把「多智能体编排」固化为 **23 个专职角色 × 三档模型路由 × 一次调用合成完整任务书** 的机制，外加 23 件工作流技能、11 个确定性机检脚本与三层测试链。

| 维度 | 数值 | 验证入口 |
|---|---|---|
| 跟踪文件 | 99 | `git ls-files` 计数 |
| 角色 / 泳道 | 23（build 10 · review 6 · domain 7） | `agent_roles action=list` |
| 工作流技能 | 23（入口 1 · 流水线 4 · 协作 5 · 方法论 13） | `skills/` |
| 评审清单 | 11（语言 7 + 专项 4） | `personas/checklists/` |
| 确定性工具 | 宿主注册 3 + `tools/` 共 11（机检脚本 8 · 负向自测 2 · 数据 1） | `lib/index.js` + `tools/` |
| 测试断言 | 主套件 65 + crgate 65 + publish-scan 47 + persona-gate 33 | `tests/` + `tools/*.test.mjs` |
| 运行时依赖 | **1**（@deepseek-ai/schemastery，公开 registry 可装） | `package.json` |
| 上游许可 | MIT ×3（OMC / ECC / MACAE），声明全文随仓分发 | `THIRD-PARTY-NOTICES.md` |

---

## 1. 顶层布局

```
dsh-agents/
├── package.json / package-lock.json   插件清单（dsh.bundle.patch + dsh.client 双半声明）
├── cordis.patch.yml                   宿主插件行 + 全部可配项（档位路由基底）
├── lib/            (11)               插件运行时（三个宿主工具 + 支撑模块 + 装配判据）
├── personas/       (34)               23 份角色人格 + checklists/ 11 份评审清单
├── skills/         (26)               23 件工作流技能源档 + README + 附带 references
├── tools/          (11)               独立 CLI 工具与机检脚本（不进宿主运行时）
├── tests/          (7)                主测试 + 安装验收门 + 重启探针
├── docs/           (1)                任务书模板正本
├── README.md                          使用向导（安装 / 快速开始 / 配置 / 已知限制）
├── ARCHITECTURE.md                    本文
├── LICENSE                            MIT（本仓自身代码）
├── THIRD-PARTY-NOTICES.md             三上游版权与 MIT 全文
├── .publish-scan-allow.json           脱敏扫描豁免清单（1 条，reason 必填）
└── .gitignore
```

**目录间依赖方向**（单向，无环）：`tools/` 与 `tests/` 依赖 `lib/` 与 `personas/`；`lib/` 只依赖自身与 `@deepseek-ai/schemastery`；`skills/` 是纯提示词资产，不依赖代码。

---

## 2. lib/ — 插件运行时（11 文件）

宿主加载入口是 `lib/index.js`；其余模块按职责单一划分。

| 文件 | 职责 | 评审要点 |
|---|---|---|
| `index.js` | 插件入口：`name` / `inject=['tools']` / `apply(ctx)`；注册 **3 个宿主工具**（agent_roles / agent_taskbook / agent_spawn） | fail-loud 约定：未知档位/角色/半个路由/非法 clarifyMode 一律抛错；`allowSpawn` 紧急刹车开关 |
| `roles.js` | 23 角色注册表（id/泳道/档位/隔离模式/只读标记），模块级缓存 | 隔离映射 blind/isolated/shared 三者之和恒等于 23（测试钉值） |
| `routing.js` | 档位路由解析：调用期显式 → roleOverrides → settings 用户层 → cordis 基底 → 内置默认；`tierSources` 记录每档来源 | 「档位是配置不是常量」——任何时刻可查解析值与来源 |
| `persona.js` | 人格加载（`personas/<id>.md` 剥 frontmatter 取正文；缺文件退化摘要模式并在任务书标注）+ body_hash 留档 | 哈希域说明：文件级 sha256 与正文 body_hash 是不同域，不可互比 |
| `taskbook.js` | **八节任务书合成** + 派活前置三问（副作用关键词 fail-closed）+ 上下文隔离契约注入 + 泄漏机检 | 六参数 null 穿透守卫（`!= null`，防 `String(null)==='null'` 骗过 trim）；库层入参守卫四态 throws（role/route/task/clarifyMode） |
| `spawn.js` | 会话创建：对齐宿主 `de_session` 的踩坑修复时序（WorkspaceRegistry 异步就绪 → 惰性 getter 用时解析；主名 workspace + 旧名兜底） | 「只按真名注册」回归门在 tests/run.mjs |
| `persona-gate.js` | **装配期判据**（install-personas 与 verify-imp26 共用）：LEGACY_OMC_IDS 19 豁免表 / 基线双形态判据（标题形态或非空标签块，空 tag stub 拒收，CRLF 容忍）/「不做什么」缺失 warn | 2026-09-30 曾因交付态偏差丢失导致安装器悬空引用，已按负向自测契约重建并 33/0 全绿（见 §7 案例一） |
| `settings.js` | 三档配置：settings 命名空间 `dsh-agents` 注册 + tiersApi | 与设置页卡片共用同一解析值（改完即时生效） |
| `settings-compat.js` | 宿主 settings 服务版本差异兼容层（旧 get(ns) → 新 SettingsForms describe()；typeof 守卫降级） | 宿主 0.1.7 换代的适配层，能力面降级不崩 |
| `http-config.js` | 设置卡数据端点：`GET/PATCH /plugins/dsh-agents/config`（回环 + Origin 同源防护；回环地址判定收口在白名单） | 端点只绑 loopback |
| `client.js` | 浏览器半：设置卡（`window.__ModuleLoader__.load` 懒 CJS 工厂 → `settings.plugin.item` 槽位） | 无 `dsh.client` 字段则宿主引导图不含此半（README §设置页） |

**三个宿主工具**（由 index.js 注册，全部经宿主 schema 严格子集校验——`tests/boot-schema-check.mjs` 用宿主真实校验器跑六项全 PASS）：

- **agent_roles** — 角色目录 / 单角色详情 / 档位路由表体检（`tiers` 回显 23/23 与来源）/ 用户层改档（set/reset）。
- **agent_taskbook** — 只合成八节任务书不派活（先审后派）。
- **agent_spawn** — 一步派活：解析档位 → 注入人格与任务书 → 创建标准 DSH 会话开跑。

**不在本仓的近亲工具**：批次3 曾交付五个独立 check 模块（memory_secret_lint / config_guard / scope_loop_guard / invisible_chars / manifest_alignment），由本机另一插件（port-kit 系）承载并经安装态活体验证——**本仓不含其源码**，LIVE-VERIFIED 是本机安装态验证记录而非本仓可复现断言，外部评审者在本仓内无法核验此行，评审时请跳过。

---

## 3. personas/ — 角色人格（34 文件）

### 3.1 角色人格（23 份，frontmatter + 单个 `<Agent_Prompt>` 块）

三泳道 × 三档位全景（🔒 = 只读角色，任务书写成只读顾问条款——DSH 无法按会话禁用工具，这是文字约束，见 README 已知限制 1）：

| 档位 | build | review | domain |
|---|---|---|---|
| HIGH | analyst 🔒 · planner · architect 🔒 · spec-miner 🔒 · harness-optimizer | code-reviewer 🔒 · security-reviewer 🔒 · critic 🔒 · code-simplifier · rag-reviewer 🔒 | — |
| MEDIUM | debugger · executor · verifier 🔒 · tracer | silent-failure-hunter 🔒 | test-engineer · designer · qa-tester · git-master · document-specialist 🔒 · scientist 🔒 |
| LOW | explore 🔒 | — | writer |

（上表 23 角色全量；其中 ECC 系 4 角色为：spec-miner 🔒 / harness-optimizer（HIGH·build）、rag-reviewer 🔒（HIGH·review）、silent-failure-hunter 🔒（MEDIUM·review）——档位裁定记录在 `lib/roles.js` 行内注释，含对 ECC 上游定档的调整缘由。）

**血统标注**（逐字翻译移植 / 深度改造 / 方法论移植，许可义务见 THIRD-PARTY-NOTICES）：

- **OMC 逐字翻译移植（18）**：analyst / architect / code-simplifier / critic / debugger / designer / document-specialist / executor / explore / git-master / planner / qa-tester / scientist / security-reviewer / test-engineer / tracer / verifier / writer——「逐字」指中文翻译逐字对应英文原文（含行内适配注记），非逐字节复制英文原文；OMC 上游无「注入基线」「不做什么」节，为历史形态；`lib/persona-gate.js` 的 LEGACY_OMC_IDS 豁免表即此语义。
- **OMC 底本 + 深度改造（1）**：code-reviewer——原为逐字翻译版，后升级为 v2.3 反编报形态（ECC Pre-Report Gate + 12 条误报清单 + 「零发现合法」条款），不再逐字对应上游；改造部分为本仓原创增量。
- **ECC 方法论移植（4，批次3 新角色）**：rag-reviewer（RAG/检索管线评审）· silent-failure-hunter（静默失败盲评专项）· spec-miner（brownfield 规格提取）· harness-optimizer（harness/流水线演进评测）——含 ECC 系注入基线与「不做什么」节，且各自带「评审面复用」协作位条款（回指 squad 路由表）。

### 3.2 personas/checklists/（11 份评审清单）

语言 7（go / ts / python / kotlin / rust / csharp / cpp）+ 专项 4（sql / pytorch / a11y / performance）。路由规则：先按冻结清单内文件扩展名判定语言 → read 加载 → 与通用清单合并；语言清单同语言只加载一份，专项按条件叠加（code-reviewer.md §清单路由有完整规则与映射表）。

---

## 4. skills/ — 工作流技能（26 文件 = 23 SKILL.md + README + 2 references）

全部为**纯提示词资产**（SKILL.md 单文件，description 触发词前置——DSH 技能目录只显示 description 前若干百字符）。安装：把技能目录复制到 `~/.agents/skills` 或 `~/.dsh/skills`。

**入口（1）**

- `agent-workflow-router` — 总路由：按意图接到下述技能，固化五条硬协议（派活前置三问 / 档位现场确认禁越档 / 任务书四条必含 / 点对点消息纪律 / 工作区纪律）。

**流水线（4）**——编排本插件 23 角色

- `agent-autopilot` — 旗舰六阶段（扩写/规划/执行/QA/验证/收尾）带相位门；含 ECC 映射的选角触发表。
- `agent-feature` — analyst → planner → executor → test-engineer → code-reviewer → verifier。
- `agent-bugfix` — explore → debugger（→ tracer）→ test-engineer → verifier。
- `agent-review-squad` — 双席并行盲评 → critic 裁决（→ code-simplifier）；v2.2 含 M-1 六项流程硬化（信封 glob 核对 / 所有权划界 / 分母基准统一 / severity 映射与零发现告警 / 关账前漂移复验 / 断言鉴别力自查字段）。

**协作（5）**

- `subagent-clarify`（MACAE+OMC 混合来源）— 子会话缺参数不瞎猜：结构化提问 → 广播问组织者 → 超时降级缺省表。
- `requirement-interview` — 苏格拉底式访谈 + 含糊度门控，≤阈值才准动代码。
- `consensus-plan` — 共识规划：规划与执行严格分离，planner 快照 → architect/critic 串行盲评 → ≤5 轮至 APPROVE。
- `ai-slop-cleaner` — 先锁行为再清理；五类 slop 分类 + writer/reviewer 分离。
- `visual-verdict` — 视觉判定输出结构化 JSON verdict，达标线外不得收工。

**方法论（13）**

- `agent-loop` — 长任务循环三层合一（机制：启动三查/停止条件落盘/熔断；判断：四条件门/五崩法；模式：顺序/DAG）。
- `tdd-workflow` / `verification-loop`（六相验证）/ `parallel-execution-optimizer` / `error-handling` / `git-workflow` / `operator-approval-loop`（外发审批，含 references/ 2 件契约样例）/ `agent-harness-construction` / `skill-eval` / `skill-stocktake` / `session-handoff` / `dsh-troubleshooting`（症状索引手册）/ `opensource-sanitize`（发布前脱敏六类扫描方法论，ECC 全量移植）。

`skills/README.md` 为源副本说明页（装机分布与同步纪律）。**装机同步**：23 件技能分装于两个用户级技能根（互补无重叠），`tools/skill-replica-check.ps1` 按 `skills/replica-map.json` 比对（注意：replica-map.json 含本机运维路径，已移出 git 跟踪、仅本地维护——见 §6）。

---

## 5. tools/ — 独立 CLI 与机检（11 文件 = 机检脚本 8 + 负向自测 2 + 数据 1）

| 文件 | 职责 | 自测 |
|---|---|---|
| `crgate.mjs` | 评审确定性证据链：`freeze`（覆盖分母冻结+身份哈希）/ `anchor`（发现逐条锚定，`--strict` 为交付前强制门）/ `finalize`（覆盖状态机：reviewed/skipped/blocked/waived） | `crgate.test.mjs` 65 断言 |
| `publish-scan.mjs` | 发布前脱敏机检：六类扫描（secrets/PII/内部路径/危险文件/配置完整性/git 历史）+ 三值裁定（PASS / PASS-WITH-WARNINGS / FAIL，单 CRITICAL 即 FAIL）；`--strict-tracked` 放行门、`--allow` 豁免清单（waiver={id:规则名, glob, reason}，缺 reason 响亮报错，waived 仍列示） | `publish-scan.test.mjs` 47 断言（注入必红） |
| `install-personas.mjs` | 人格批量安装到 DSH（默认跳过已有自定义版本）；**装配期两级断言**经 `lib/persona-gate.js`：非豁免角色缺注入基线 → exit 1 不落盘并报文件名；缺「不做什么」→ 警告非阻断 | `verify-imp26.mjs` 33 断言（含 fd-stdio 跑真安装器的 E2E 层） |
| `assemble-review.mjs` | 评审材料装配（`tools/approved.json` 记录批准来源与时间——approve 记录的可审计形态）。**注**：依赖 `review/original` 与 `review/trans` 目录（OMC 英文原文与中文译文的对照底本，维护侧本地过程物，不随仓分发）——clone 后可运行但产出为空对照，属内部评审过程工具非对外工具 | — |
| `publish-sync-check.ps1` | **公开仓同步幂等 diff 门**：本地 HEAD vs origin/master 零差异 exit 0；ahead 列文件 / behind 提示 pull（fetch 走 cmd /c 静默取退出码，避 PS5 stderr 陷阱） | 冒烟 in-sync exit 0 |
| `skill-replica-check.ps1` | 双装机根一致性机检：按 replica-map.json 逐技能 SHA256 比对（match/drift/missing/unknown 四态）。**注**：replica-map.json 含本机装机路径，已移出 git 跟踪、仅维护侧本地维护——clone 后运行会 FAIL exit 1（fail-loud，不静默），属本机运维脚本非对外工具 | 本地运行（需本地 replica-map.json） |
| `verify-imp26.mjs` | persona-gate 负向自测四层：①判据层纯函数（真实 executor 正文+真实 ECC 基线文本）②E2E 注入必红（fd-stdio 跑真安装器，INSTALL_PERSONAS_ROOT 重定向）③真实树全量跑 ④汇总裁定 | 33 断言——2026-09-30 修复后首次 33/0（见 §7） |
| `taskbook-26a-negative.mjs` | taskbook 六参数 null 穿透等负向断言（IMP-26a 修复的注入必红回归门） | — |
| `approved.json` | assemble-review 的批准记录（数据文件） | — |

**tools/ 面设计纪律**：全部机检脚本**注入必红**（把坏样本喂进去断言变红——只验证「好文件过门」的闸门是半成品）；输出排空后再退出；「无意见」唯一合法形态是空输出+exit 0。

---

## 6. tests/ — 测试与验收门（7 文件）

| 文件 | 职责 | 当前账 |
|---|---|---|
| `run.mjs` | 主测试：纯逻辑 + 假宿主全链路 + 端点 + 浏览器半/manifest 门 + 26a 负向组（65 断言） | **65 passed / 0 failed** |
| `boot-schema-check.mjs` | **装前必过门**：宿主真实校验器（dsh-tools assertSupportedJsonSchema）验证三工具 parameters + output.schema。**前置条件：本机已安装 DSH 宿主**（宿主包路径经 APPDATA 运行时解析）——无宿主环境跑不了，非 clone 即可复现门 | 六项 ALL PASS |
| `installed-smoke.mjs` | 安装副本烟测：工具 + settings + 端点三方同源 | 安装后跑 |
| `probe-boot.mjs` / `probe-catalog.mjs` / `probe-client.mjs` | 重启后探针：宿主引导图含本插件 / 工具目录可发现 / client.js 可分发 | 重启后跑 |
| `verify-live.mjs` | 安装态活体验证支撑 | — |

**复现命令**（clone 后）：

**第一组——任何 Node 环境即可复现（四门，公开 registry 装 1 个运行时依赖）：**

```bash
npm install                        # 公开 registry 可装（1 个运行时依赖）
node tests/run.mjs                 # 65/0
node tools/crgate.test.mjs         # 65/0
node tools/publish-scan.test.mjs   # 47/0
node tools/verify-imp26.mjs        # 33/0
```

**第二组——需本机已安装 DSH 宿主（安装态验证，外部评审者无宿主时跳过）：**

```bash
node tests/boot-schema-check.mjs   # ALL PASS（宿主真实校验器）
node tests/installed-smoke.mjs     # 安装副本烟测
```

> 已知环境注记：受限沙箱（如 DSH 自身 Windows 沙箱）内 node 的管道子进程捕获会 EPERM，逐文件直跑是可靠方式；PowerShell 5 下含中文注释的 .ps1 必须存 UTF-8 with BOM。

---

## 7. 质量与安全账（评审者速查）

### 7.1 质量账

| 门 | 账面 |
|---|---|
| 主套件 | 65/0 |
| crgate 自测 | 65/0 |
| publish-scan 自测 | 47/0（注入必红） |
| persona-gate 自测（verify-imp26） | **33/0**（2026-09-30 修复后首次全绿） |
| boot-schema（宿主真实校验器） | 6/6 PASS（**需本机已安装 DSH 宿主**，非 clone 即可复现） |
| 可安装性（A-full 验收） | 干净 clone → npm install → 第一组四门全绿（boot-schema 需宿主环境，见 §6 分组） |

### 7.2 安全与发布账

- **脱敏放行门（双口径，2026-09-30 复测）**：
  - **公开仓 clone 账面（分发物真实账）**：`node tools/publish-scan.mjs --repo . --strict-tracked` → **PASS-WITH-WARNINGS（critical=0，warning=17）**。17 条构成：loopback 白名单 ×12（lib/http-config.js:28 端点守卫、tests/* 5 个文件的探测目标、personas/document-specialist.md:67 与 skills/opensource-sanitize 教学文本 ×4）、`.secrets` 引用 ×3（opensource-sanitize 的扫描模式教学文本）、私网 IP 教学文本 ×1——全部为回环守卫代码或脱敏方法论教学样例，无真实内网信息。
  - **维护侧工作树账面**：同命令 + `--allow .publish-scan-allow.json` → PASS-WITH-WARNINGS（critical=0，warning=27，waived=2）。比 clone 多出的 10 条全部位于未分发的本地过程物（`review/` 对照底本 8 条 + `backup/` 快照 1 条 + replica-map.json 豁免 2 条）。
  - 豁免清单 `.publish-scan-allow.json` 仅 1 条且 reason 公开可见；注意 waiver 需显式传 `--allow`（非自动加载）。
- **端到端复核**：干净 clone 公开仓后六模式敏感 grep（用户级路径 / 盘符绝对路径 / 会话 id / file:/// / 密钥样态 / 本地分析目录引用）**全零命中**。
- **第三方独立扫描（gitleaks 8.30.1，2026-09-30）**：对全量 git 历史（56 commits）与活树各扫一遍（`gitleaks detect --redact` / `detect --no-git --redact`），两侧各报 **3 条命中，全部位于 `tools/publish-scan.test.mjs`（L88 / L118 / L175）**——逐条定性均为注入必红测试的显式假凭据 fixture（`placeholder body` 字样私钥块 / `sk-0123456789abcdef` 顺序占位 / `ghp_` + 字母表倒序 + `654321` 的假 token），不可用、非真实格式；与自研扫描器「凭据样态均为占位」的结论交叉一致。gitleaks 无占位识别故判 leak，自研扫描器按占位降级 warning——口径差异已记录，安全结论一致：**无真实凭据泄露**。复现命令与 fingerprint 见 gitleaks 报告（维护侧留档；外部评审者可用任意版本 gitleaks 独立复跑）。
- **git 历史注记**：本仓由私有开发仓直接转公开，历史 commit 含开发期过程物（评审中间稿等）。活文件树已按上述门清理；历史面无密钥级内容（自研扫描器 git-history 层 critical=0，sk- 形态命中均确认为文档占位样态；gitleaks 独立交叉验证同结论，见上条）。历史清洗（history rewrite）为可选运维动作，经第三方扫描确认无真实泄露后**暂不执行**——评审者评估历史面时可依此口径。

### 7.3 案例一：一次评审级盘点揪出的 critical 缺陷（已修复）

编写本文前的逐文件盘点（`git ls-files` 对照文档断言）发现：`install-personas.mjs` import 的判据模块 `lib/persona-gate.js` **从未入库**（工具不可运行，且 18 份 OMC persona 的工作树副本回退到旧态——此前的误删事故只恢复了部分文件）。修复路径：按负向自测（verify-imp26 的 33 断言契约）逆向重建判据模块 + `git restore` 归位 18 文件 + 修复测试夹具的 CRLF 静默失效——修复后 verify-imp26 首次 33/0 全绿。

**负面证据的自我认定**：该缺陷存在期间，主套件 65 断言全绿且未预警——主套件不覆盖「工具 import 依赖完整性」这一装配面，属测试覆盖的真实盲区；此缺陷能存活到发布前盘点才被发现，说明「测试账面绿」不能替代「逐文件断言核对」。案例按此双重含义保留：既有盘点方法论的价值，也有发布前流程存在漏洞的记录。

### 7.4 已知限制

完整 8 条见 README「已知限制」。核心三条：只读角色是任务书条款而非硬隔离（可用禁写工具的 Agent 预设补硬隔离）；人格文件缺失时角色退化摘要模式运行；上下文隔离是「硬会话层 + 软材料层」（材料层靠机检告警而非阻断）。

---

## 8. 与上游的关系

本仓是三个 MIT 上游的**移植与再实现**，义务履行（版权与许可全文）见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

1. **oh-my-claudecode（OMC）**：19 个基础角色人格的底本——18 份逐字翻译移植（中文译文逐字对应英文原文），1 份（code-reviewer）在底本上深度改造升级为 v2.3。
2. **everything-claude-code（ECC）**：4 个专项角色方法论、11 份评审清单、opensource-sanitize 技能与 publish-scan 的方法论来源。
3. **MACAE（Microsoft）**：任务书模板机制来源；subagent-clarify 的工具级 HITL 机制参考（与 OMC guard 混合来源）。

移植原则：方法论**全量保真**（OMC 宿主设施→DSH 原语只做映射不做删减）；适配决策记录在提交历史（commit message），不占运行时上下文。上游逐字对照底本不随公开版分发（本地评审过程物），需要时可按 NOTICES 所列上游仓库自行取源比对。

---

## 9. 评审建议路径

1. **先跑后读**：§6 第一组四门（Node 环境即可复现）是本文全部代码断言的可执行性前提；第二组需宿主环境。
2. **主链路**：`lib/index.js`（工具注册）→ `lib/taskbook.js`（任务书合成与防御面）→ `lib/spawn.js`（会话创建时序）。
3. **机制深度**：`lib/persona-gate.js` + `tools/verify-imp26.mjs`（判据与负向自测同构）；`tools/crgate.mjs`（评审证据链状态机）。
4. **安全面**：`tools/publish-scan.mjs`（规则表）+ `.publish-scan-allow.json`（豁免与理由）。
5. **提示词资产**：`skills/agent-review-squad/SKILL.md`（流程硬化最密的一件）与 `personas/code-reviewer.md`（反编报三件套）。
6. **欢迎攻击**：fail-loud 边界（未知输入）、隔离机检的绕过面、任务书模板与生成器的一致性——这些是维护侧最希望被外部视角检验的位置。issue 与 PR 均欢迎。
