# ARCHITECTURE — dsh-agents 仓库全景（评审导览）

> 本文面向**外部评审者**：逐部件说明本仓 155 个跟踪文件的职责、接线与质量账。
> 使用向导（安装/快速开始/配置）见 [README.md](README.md)；上游许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
> 本文由维护侧在 2026-09-30 公开化批次编写；部件清单以 `git ls-files` 实测为准（当前 155 文件，本文自身与 CHANGELOG.md 计入；2026-10-27 R3-B1 B0+B1 收口批次后更新，对应 HEAD=`e522b9b` 系文档同步 commit）。
> 术语注：文中 IMP-xx / M-1 / 批次 N 为维护侧内部批次编号，仅作溯源标记不承载技术含义；A-full = 「干净 clone → npm install → 跑通全部可复现门」的可安装性验收模式。

---

## 0. 一句话与关键数字

**dsh-agents 是一个 DSH 插件**：把「多智能体编排」固化为 **23 个专职角色 × 三档模型路由 × 一次调用合成完整任务书** 的机制，外加 25 件工作流技能、19 个确定性机检与测量脚本、三层测试链、per-session 工具面收缩、极简派活/回复通道与独立预设装载器（R3-B1）。

| 维度 | 数值 | 验证入口 |
|---|---|---|
| 跟踪文件 | 155 | `git ls-files` 计数 |
| 角色 / 泳道 | 23（build 10 · review 6 · domain 7） | `agent_roles action=list` |
| 工作流技能 | 25（入口 2 · 流水线 4 · 协作 5 · 方法论 13 · 顾问 1） | `skills/` |
| 评审清单 | 11（语言 7 + 专项 4） | `personas/checklists/` |
| 确定性工具 | 宿主注册 3（+own 层 agent_reply）+ `tools/` 共 19（机检脚本 10 · 测量/读取 6 · 负向自测 2 · 数据 1） | `lib/index.js` + `tools/` |
| 测试断言 | 主套件 356 + crgate 65 + publish-scan 47 + persona-gate 33 + 隔离门自测 5 + LLM 回放 9 | `npm test` 串联全部入口 |
| 运行时依赖 | **1**（@deepseek-ai/schemastery，公开 registry 可装） | `package.json` |
| 上游许可 | MIT ×3（OMC / ECC / MACAE），声明全文随仓分发 | `THIRD-PARTY-NOTICES.md` |

---

## 1. 顶层布局

```
dsh-agents/
├── package.json / package-lock.json   插件清单（dsh.bundle.patch + dsh.client 双半声明）
├── cordis.patch.yml                   宿主插件行 + 全部可配项（档位路由基底）
├── lib/            (43)               插件运行时（三个宿主工具 + toolscope/reply 支撑模块 + advisor 子目录 26 件）
├── personas/       (34)               23 份角色人格 + checklists/ 11 份评审清单
├── skills/         (28)               25 个 SKILL.md + README + 2 references（replica-map.json 未跟踪）
├── policies/       (2)                toolscope 策略数据（roster 基表 + 23 角色引用表）
├── tools/          (19)               独立 CLI 工具与机检脚本（不进宿主运行时）
├── tests/          (13)               主测试 + 计数/工程卫生门 + 安装验收门 + 重启探针 + 隔离门/回放设施
├── docs/           (4)                任务书模板正本 + advisor 契约正本 + 开源复用账本 + 设计原则正本
├── README.md                          使用向导（安装 / 快速开始 / 配置 / 已知限制）
├── CHANGELOG.md                       变更记录（Keep a Changelog 风格，Unreleased 节，条目挂 commit 短哈希）
├── ARCHITECTURE.md                    本文
├── LICENSE                            MIT（本仓自身代码）
├── THIRD-PARTY-NOTICES.md             三上游版权与 MIT 全文
├── .publish-scan-allow.json           脱敏扫描豁免清单（1 条，reason 必填）
├── .gitattributes                     `* -text`（禁用换行转换，见 §1.1）
└── .gitignore
```

**目录间依赖方向**（单向，无环）：`tools/` 与 `tests/` 依赖 `lib/` 与 `personas/`；`lib/` 只依赖自身与 `@deepseek-ai/schemastery`；`skills/` 是纯提示词资产，不依赖代码。

### 1.1 `.gitattributes`（`* -text`）——「git 干净」≠「字节还原」

本仓既有配置是 `core.autocrlf=true`，且此前**没有** `.gitattributes`。两者叠加的后果是：对**已修改**的文件跑 `git checkout --` 会把 LF 重写成 CRLF（实测某文件 12593 → 12877 字节），而 **`git status` 仍显示干净**——因为 autocrlf 会在比对前把工作树内容归一化回 LF。凡是依赖逐字节比对的验收门（`skill-replica-check.ps1` 的 SHA256 比对、`.claude`/`.mjs` 产物的字节级回归），都会在这种状态下给出**绿色的错误结论**。

`* -text` 让 git 对全部路径**不做任何换行转换**，从而使「git 报干净」重新等价于「字节未被悄悄改写」。取舍与验证见提交 `S6` 的 commit message；本仓此后新增文件一律以磁盘原样入库。**该规则是加法**：它不重写任何已入库 blob，也不改变 index 中的行尾状态（加规则前后 `git ls-files --eol` 的 `i/*` 列完全一致，均为 `i/lf`）。

---

## 2. lib/ — 插件运行时（43 文件 = 顶层 17 + `advisor/` 26）

宿主加载入口是 `lib/index.js`；其余模块按职责单一划分。

| 文件 | 职责 | 评审要点 |
|---|---|---|
| `index.js` | 插件入口：`name` / `inject=['tools']` / `apply(ctx)`；注册 **3 个宿主工具**（agent_roles / agent_taskbook / agent_spawn） | fail-loud 约定：未知档位/角色/半个路由/非法 clarifyMode 一律抛错；`allowSpawn` 紧急刹车开关 |
| `roles.js` | 23 角色注册表（id/泳道/档位/隔离模式/只读标记），模块级缓存 | 隔离映射 blind/isolated/shared 三者之和恒等于 23（测试钉值） |
| `routing.js` | 档位路由解析：调用期显式 → roleOverrides → settings 用户层 → cordis 基底 → 内置默认；`tierSources` 记录每档来源 | 「档位是配置不是常量」——任何时刻可查解析值与来源 |
| `persona.js` | 人格加载（`personas/<id>.md` 剥 frontmatter 取正文；缺文件退化摘要模式并在任务书标注）+ body_hash 留档 | 哈希域说明：文件级 sha256 与正文 body_hash 是不同域，不可互比。body_hash 域口径（2026-10-25 R2 C-2 统一重算后）：23 文件全量 = `sha256(splitFrontmatter(body))` 前 8 位，仓内可复验；装机期 13 文件旧声明值经 C-1 tracer 实锤为装机时点快照值（baseline@9bc6c90 正文的 body 域复算值，正文演进后未同步重算），已按 body 域统一重写 frontmatter 单行（正文零改动） |
| `taskbook.js` | **七节任务书合成**（R3-B0 删原 §八工具映射节，节号保留空洞）+ 派活前置三问（副作用关键词 fail-closed）+ 上下文隔离契约注入 + 泄漏机检 | 六参数 null 穿透守卫（`!= null`，防 `String(null)==='null'` 骗过 trim）；库层入参守卫四态 throws（role/route/task/clarifyMode）；**档位渲染差异化（D-1a）**：§五/§六/§七 按 route.tier 三档形态（LOW=指令化短句+分类决策表 / HIGH=spec 条款+few-shot / MEDIUM=v3.3 定稿（A2b+5ef5c7e R3 返工）逐字冻结），语义不变式见 docs/task-brief-v3.md §2b |
| `spawn.js` | 会话创建：对齐宿主 `de_session` 的踩坑修复时序（WorkspaceRegistry 异步就绪 → 惰性 getter 用时解析；主名 workspace + 旧名兜底） | 「只按真名注册」回归门在 tests/run.mjs |
| `persona-gate.js` | **装配期判据**（install-personas 与 verify-imp26 共用）：LEGACY_OMC_IDS 19 豁免表 / 基线双形态判据（标题形态或非空标签块，空 tag stub 拒收，CRLF 容忍）/「不做什么」缺失 warn | 2026-09-30 曾因交付态偏差丢失导致安装器悬空引用，已按负向自测契约重建并 33/0 全绿（见 §7 案例一） |
| `settings.js` | 三档配置：settings 命名空间 `dsh-agents` 注册 + tiersApi | 与设置页卡片共用同一解析值（改完即时生效） |
| `settings-compat.js` | 宿主 settings 服务版本差异兼容层（旧 get(ns) → 新 SettingsForms describe()；typeof 守卫降级） | 宿主 0.1.7 换代的适配层，能力面降级不崩 |
| `http-config.js` | 设置卡数据端点：`GET/PATCH /plugins/dsh-agents/config`（回环 + Origin 同源防护；回环地址判定收口在白名单） | 端点只绑 loopback |
| `client.js` | 浏览器半：设置卡（`window.__ModuleLoader__.load` 懒 CJS 工厂 → `settings.plugin.item` 槽位） | 无 `dsh.client` 字段则宿主引导图不含此半（README §设置页） |
| `toolscope.js` | per-session 工具面策略文件读写（`<dataDir>/sessions/<b64>.toolscope.json`，schema v1：personaMode/toolPolicy{tier:full\|grant\|none,allow,deny}/replyChannel/orgId/role/task/taskbook） | 写 fail-closed（校验失败零写盘）读 fail-open（损坏→null）；与 advisor 配置同目录异名（b64url 无 `.` 三后缀不碰撞）；临界区全同步 |
| `toolscope-pipeline.js` | restrict 管道：agent/created 决策核（decideToolscope）+ unknown 预校验 + lift-before-set + **跨代 sharedLift**（globalThis Symbol.for，防交集叠加锁死）+ G9 去重通知 + fail-open 全路径 + 死会话留存清扫 + V3-3 生效率审计环（有界 200） | 任何 refuse/skip 路径绝不调用 restrict（AC2-3 三件套）；own 层名禁入 allow（P4 豁免是自动语义） |
| `toolscope-roster.js` | roster 数据层：两文件加载（损坏 fail-open 不静默）、构建期扫描核（scanRoleReferences，与漂移门同实现）、G11 覆盖率报告、**M11 宿主版本读取面**（detectHostVersion：插件树向上走查 + APPDATA npm 全局前缀候选；checkHostVersion mismatch 告警/unknown 静默）、M13 留存计划纯函数 | 「不猜记缺口」——反引号显式提及不在宇宙才报 unclassified；版本读取两路全落空=null 不抛 |
| `agent-reply.js` | 极简回复通道：own 层 agent_reply（target 注册时钉死 orgId、schema 无 target 参数）+ 内部直投 sendToSession（缺省 inject）+ 模式解析闸门（纯函数）+ **V3-2 频控熔断**（滑动窗口 60s/3 + 连降 10 熔断至会话结束）+ 审计（reply-audit.jsonl；spawn 决策行并轨 kind:'spawn'；尺寸阈值轮转 `.1` 一代有界留存） | 唤醒白名单=发送方策略文件 orgId 单元素（按次现读，热改即刻生效）；delivered:false 不自动重试；降级请求计入窗口（连降计数可定义） |
| `yaml-mini.js` | **最小 YAML 子集解析器**（PhaseB 选项③）：嵌套 map/seq + 单引号/整数/布尔标量 + 全行注释；flow/双引号/多行标量/TAB/锚点/标签 fail-fast 列行号 | 不做通用 YAML 的诚实边界；只服务磁盘预设装载器 |
| `disk-presets.js` | **磁盘预设装载器**（PhaseB 选项③）：`~/.dsh/.agent-presets/<id>/` 装载（preset.yml 元数据 + agent.cordis.yml 组件清单，未知键 fail-fast 列名）+ 组件级挂载契约（plugin 优先 / apply 兜底降级声明 / cordis:group 拍平偏差声明 / 未知形态 fail-fast 列名） | 目录存在即权威（损坏响亮失败不回落宿主）；组件包与插件同住 node_modules 树 import 可解析 |
| `advisor/store.js` | advisor 存储：会话级分文件 + 幂等 seen + `records.jsonl` | 临界区全同步（见 §2.1） |
| `advisor/api.js` | advisor 端点 `/plugins/dsh-agents/advisor`（GET / PATCH / POST） | sessionId 三处共用同一个形状判据（见 §2.1） |
| `advisor/observer.js` | 每 turn 触发一次的幂等门（宿主真实身份 `(sessionId, turn, seq)`） | 只评审主会话汇总，子会话 step 不可见 |
| `advisor/runtime.js` | 评审调用、输出预算 16384、终态显式优先级链 | 触顶不投递、记 `runtime.error`，**不降级** info/recorded |
| `advisor/delivery.js` | 分级意见投递（nit 及以上默认 `agent.steer()` 实时打断） | 绝不回退投递等级 |
| `advisor/index.js` | **装配层**（S5 分层重构后）：配置解析 → 启动告警 → store+delivery 所有权 → 组装 assemble/ 四模块 → ctrl（snapshot/patchConfig/triggerReview）→ 端点 → 幂等 dispose；旧全局配置文件只停用不迁移 | 未知配置键 fail-loud；空 `advisorDataDir` 抛错；`runtimeSignature` 三态形态有源码级锁 |
| `advisor/assemble/`（4） | S5 分层重构（F-4，只移动不改语义）：`session-views.js`（currentModel/isActiveSession/visibleMessageCount 三共享读取闭包 + resolveAdvisorModel 本体）/ `context-hooks.js`（检索面+三层上下文+预筛+工具循环钩子）/ `runtime-pool.js`（runtimes/signatures/runtimeStates 三 Map 独占）/ `wiring.js`（observer + 五段事件接线） | 注入严格单向 `index → 四模块`、四模块互不 import、不 import store.js/api.js、构造期零 IO；闭包环由「delivery/store 所有权上收 + 构造序 pool 先于 wiring」消解（接缝声明为维护侧过程物，未随仓分发） |
| `advisor/retrieval/`（7） | V3 只读检索地基：`budget.js` 预算唯一源（Base 8KB 与检索段 40KB **并列独立**）· `path-policy.js` 越界/凭据/二进制/超大等 10 类拒绝（junction 用 `realpathSync.native` 防绕过）· `git.js` fd-stdio + 参数白名单 + 最小 env（剔除全部 `GIT_*`）· `symbols.js` 符号抽取（B4：web-tree-sitter AST，降级=正则启发式显式标注）· `walk`/`search`/`index` 遍历检索 | **只读边界源码级门**：写 API 禁令 + 9 条豁免条条活性；预算数字唯一源，测试码写死即红 |
| `advisor/context/`（4） | V3 三层上下文装配：Conversation / Project（`docs/DECISIONS.md` 决策保护，advisor 只读）/ Repository（L1 文件树+Git+搜索，L2 精读由 `advisorContextMaxFiles` 控制可关） | Base 与 Repository 并列独立互不占用（总注入 ≤48KB）；缺层显式「不可用」不静默 |
| `advisor/decision/prefilter.js` | V3 规则预筛（分级）：user 消息完整规则 / assistant 只挡整轮纯 ACK / unknown fail-open 放行 | 拦截 = 漏评（代价高于多评一次），故判据收敛为整串 ACK 精确匹配；near-miss 反例入样本集 |

**三个宿主工具**（由 index.js 注册，全部经宿主 schema 严格子集校验——`tests/boot-schema-check.mjs` 用宿主真实校验器跑六项全 PASS）：

- **agent_roles** — 角色目录 / 单角色详情 / 档位路由表体检（`tiers` 回显 23/23 与来源）/ 用户层改档（set/reset）。
- **agent_taskbook** — 只合成七节任务书不派活（先审后派）。
- **agent_spawn** — 一步派活：解析档位 → 注入人格与任务书 → 创建标准 DSH 会话开跑；`personaMode='minimal'` 极简派活（免角色、四行 brief、provider+model 必填缺即拒、策略文件同事务落盘 fail-fast、返回体披露已应用策略）。
- **agent_reply（own 层，非宿主工具位）** — 仅 minimal×org 会话经策略注册（agent/created 挂点），不在宿主全局工具面；回复组织者，受 V3-2 频控熔断约束（见 §2.2）。

**不在本仓的近亲工具**：批次3 曾交付五个独立 check 模块（memory_secret_lint / config_guard / scope_loop_guard / invisible_chars / manifest_alignment），由本机另一插件（port-kit 系）承载并经安装态活体验证——**本仓不含其源码**，LIVE-VERIFIED 是本机安装态验证记录而非本仓可复现断言，外部评审者在本仓内无法核验此行，评审时请跳过。

### 2.1 advisor — 内置顾问（被动机制，无工具面）

> **详设不在本文**：`docs/advisor-contract.md` 是契约正本（冻结于 2026-10-03，S5a 按 S1–S4 已实现行为同步）。本节只给四条最易误解的边界，细节与取舍以正本为准。

1. **是什么——被动机制、无工具面。** advisor 在每个 turn 结束后自动用「该会话手动指定的模型」只读主会话可见消息、独立上下文，给主 agent 分级建议（info / nit / concern / blocker），nit 及以上默认走 `agent.steer()` 实时打断指导。**它不是工具**：不注册任何 `advisor*` 工具，**不占 `agent_roles` / `agent_taskbook` / `agent_spawn` 三个工具位**。模型完全手动指定、无任何兜底（无 HIGH 档回落、无全局 config 兜底、不继承主会话模型）；未为该会话指定模型即该会话不评审。

2. **数据落盘位置。** 配置按会话分文件存 `<advisorDataDir>/sessions/<base64url(sessionId)>.json`；幂等去重集合存**独立**文件 `sessions/<b64>.seen.json`（不与配置争同一文件）；终态意见记录写**全局单文件** `<advisorDataDir>/records.jsonl`，**按会话过滤后**返回。

3. **端点与 sessionId 强制。** `webServer.register({kind:'exact', path:'/plugins/dsh-agents/advisor'})`：**GET / PATCH 必须带 `sessionId`**，缺失或形状非法即 `400`；会话不存在/不活跃 `404`（PATCH 零写盘、GET 响应体零泄露）。**POST 恒 200**（失败以 `{ok:false, reason}` 表达，不抛错）。> ⚠️ `sessionId` 校验是 **liveness check，不是 authorization**——宿主 `WebRoute` 没有鉴权钩子，本端点挡得住「不存在的会话」，挡不住「同机另一页面改他人活跃会话的配置」。该残余风险见契约 §0.1，用户已知情接受。

4. **与三个工具的关系。** advisor **不是工具、不派活**，也**不会被 `agent_spawn` 触发**——它由 observer 在会话 turn 结束时自行触发；派活侧的三件套（`agent_roles` / `agent_taskbook` / `agent_spawn`）与 advisor 完全正交，会话启用 advisor 与派活互不影响。

### 2.1.1 V3 增量（B0–B5 全部关账；B1 `1fa7317`/`74c2e07`、B2/B3 修复 `971644e`、B4 `e6d6809`、B5/S5 收官 2026-10-13）

产品定位升级：从「只看聊天挑问题」到「**只读、repository-aware 的独立工程顾问**」——同时读仓库，目标是「更早阻止错误方向，并且自己足够轻」。

**已实现（B0–B5 关账，主套件 287/0 全门绿）：**

| 增量 | 落点 | 边界与取舍 |
|---|---|---|
| 只读检索地基 | `retrieval/`（6 文件） | 仓库遍历 / 搜索 / git 事实 / 路径策略 / 预算。`spawnSync` 全程 fd-stdio + 最小 env；git 参数为**允许列表**（18 组注入载荷实测全拒） |
| 三层上下文 | `context/`（4 文件） | Conversation + Project（决策保护）+ Repository（L1 + L2 可关）；上下文段**不进**持续会话历史 |
| 规则预筛 | `decision/prefilter.js` | 按消息来源分级；判据收敛为**整串 ACK 精确匹配**（子串包含会误拦真实工作消息——评审实锤后修正） |
| 测试基建 | `tests/isolation-gate.mjs` + `tests/advisor-llm-replay.mjs` | 进程边界双快照（防加载期写盘假绿）+ LLM 录制/回放；均已挂进 `npm test` 默认路径 |
| 安全修复 | `path-policy.js` / `git.js` | junction 绕过 realpath（改 `realpathSync.native`）/ NTFS ADS / 大小写变体 / 8.3 短名 / `GIT_DIR` 环境劫持（最小 env）——均有注入必红 |
| agentic 循环 + 模型工具面（B2/B3，`8efdfb8`/`971644e`） | `aci/`（3 文件：tools/loop/observation） | 模型自调**只读**检索工具（白名单集合相等断言 + `readOnly:true` 标注）；往返上限 `advisorMaxToolRounds`（缺省 4，0=关）；与预取面共享同一 40KB 检索段池（`BudgetPool.reserve` 唯一放行点）；观察 100 行上限 + 空输出显式文案 |
| 决策判断层（S4，`887daf6`） | `runtime.js` 提示词 V3 + `delivery.js` 冷却分级 | 职责分界（规则管边界、模型管判断）/ 数据隔离（`<repository-data>`）/ 停止五类（action 字段）/ 结论前置（前 200 字）/ blocker 证据下限（无 evidence 降 concern）；blocker/concern 免冷却直投 steer（X11） |
| 符号级解析（B4 = S1b，`e6d6809`） | `retrieval/symbols.js` + `grammars/`（vendor wasm） | web-tree-sitter@0.27.0（唯一运行时新依赖，MIT）；vendor `tree-sitter-javascript.wasm` sha256 硬闸门（411770B，拒写不匹配字节）；降级态=正则启发式，经 NOTICES 显式上报 |
| 分层重构 + 收官（B5/S5，2026-10-13） | `assemble/`（4 文件）+ 契约转现在时 + 复用账本 + 行为验收 | `installAdvisor` 483 行按接缝声明拆为装配层 + 4 模块（只移动不改语义，patchConfig 三段锁定用例先行）；`docs/advisor-contract.md` 转现在时（§1 新键/X11/§6.5/7.2/7.7/§10）；`docs/third-party-references.md`（AC-61）；行为验收 7 例（Case A–D + 黄金 + AC-62 + 台账机检，确定性轨） |

**安全边界（如实声明）**：advisor 的「只读」是**源码纪律层（写 API 禁令门 + 豁免条条活性）+ git 参数白名单 + 最小 env**，**不是运行时权限层**——不覆盖 `process.binding` / native addon / 网络外发。独立安全评审实证的绕过均已修复并配注入必红。

**宿主侧工具面保持为零**：advisor 仍不注册任何 `advisor*` 工具、不占三工具位。「模型工具面」（agentic 循环内模型自调只读检索）**已实现（B2，`aci/`）**；同轮 tool-call 实时拦截与 L3 依赖图/AST 精析为 V4/增强批次射程，**未实现（设计意向，登记 V4/增强批次）**。

### 2.2 R3-B1 增量（2026-10-26；极简条件人格 + per-session 工具面 + 极简回复通道）

设计正本 `agent-out/opt-b1-design.md` v3（consensus-plan 固定快照）；S1（`53a8790`/`6e31a51`）→ S2 探针（四探针全绿：挂点=agent/created、MCP 最终名规则、跨会话可达、own 层豁免）→ S3（`cca6578`/`2d013dc`）→ S4（`3af21d0`/`10954c2`）→ S5 收口（`52e9a4d`..）→ Phase B 彩排两事故修复（`6a38224`/`b4b8ee4`）→ 独立预设装载器（`40f5fad`，docs `d57c1bf`）→ 组件导入双路（`6000ab9`）→ 存在性校验双路收口（`e522b9b`，终态）。

| 特性 | 落点 | 边界与取舍 |
|---|---|---|
| ① 极简条件人格 | `spawn.js` beforeCreate 钩子 + `index.js` spawnTool `personaMode='minimal'`（四行 brief：任务/产出落盘/orgId/完成标准）+ `minimalPreset` 配置（缺省 `'minimal'`，需宿主侧真实存在该 id，缺失时 fail-fast——见节 2.3 终态校订与 README 已知限制） | provider+model 必填缺即拒（旁路档位路由后无回落链）；G8 策略文件写失败 fail-fast（不产出「有会话无策略文件」非法态）；G10 返回体披露已应用策略 |
| ② per-session 工具面收缩 | `toolscope.js`（策略文件）+ `toolscope-roster.js`（两层策略源层 1）+ `toolscope-pipeline.js`（restrict 管道）+ `policies/`（roster 基表 + 23 角色表） | role 轨默认收缩（用户裁决基线行为变更）；minimal 轨显式整集；五重保障=引用推导+构建期机检（漂移门）+双向对账（两实现互红）+fail-open+跨代 lift 防线；防的是「误用高级工具」非环境级隔离（exec 外联不受约束） |
| ③ 极简回复通道 | `agent-reply.js`（own 层 agent_reply + 直投 + 频控熔断 + 审计） | 仅 minimal×replyChannel='org' 注册；target 钉死 orgId、schema 无 target 参数（8 个收件方向参数名检查器钉死）；唤醒白名单单元素；频控 60s/3 超限降级 inject 不丢消息、连降 10 熔断至会话结束；群发原语不实现 |

**七节任务书现状**：role 轨七节渲染**逐字不变**（净注入门锚定：静态四节口径B 1993/2181/2183，S1→S5 五次实测与 Phase B 彩排后复跑均零增长）；minimal 轨不渲染七节，改产四行 brief；工具描述增量单独计量不同门（agent_spawn 增量 140B + agent_reply 220B 全口径 = 360B，≤400B 合计上界；严格口径 agent_reply 描述 169B）。

**运行时可调面**：频控常数 config 键位（`replyWakeWindowMs`/`replyWakeWindowMax`/`replyWakeBreakAfter`，缺省 60000/3/10，resolveConfig fail-loud 校验）——裁决=config 不入 roster（运行时行为参数非策略数据名单；roster 是插件分发面会被升级覆盖）。审计有界留存：reply-audit.jsonl 尺寸阈值轮转 `.1` 一代（上限 ≈2×512KB，行级粒度轮转不丢行）。M11 宿主版本读取面：插件启动 + 构建期扫描各查一次（真机读数 match 0.1.7-rc.2）；mismatch → warn（R11 重跑彩排），unknown → 静默披露。

**Phase B 状态（2026-10-27 收口，HEAD=`e522b9b`）**：四轮端到端彩排全链达标。两起事故如实入档并修复——事故一 agent_reply source.kind 被宿主 v4 会话日志校验器拒（`6a38224`：改 user 形态 + 变异必红回归，主套件 346→347）；事故二 预设未挂载裸会话（`b4b8ee4`：agentPresets 懒注入缓存 + 三路解析序 + 显式/配置预设 fail-fast + allow 名单校准宿主真实注册面，347→350）。catalog 分裂卡点（宿主 registry 与磁盘目录两套清单）经用户裁决走独立预设装载器（`40f5fad`，见节 2.3，350→355）；组件导入双路链（`6000ab9`，355→356）与存在性校验双路（`e522b9b`）先后落地。第四轮重派（registry 兜底路 + bundle 挂载）判据全过：minimal 会话自持 write/edit 亲自完成三步产出、审计零 role-spawn 行（restrict 实然生效）、agent_reply 恰一条且 idle 唤醒（delivered=true）；V3-3 实然读数 efficiency-ok（8 策略文件全 applied、对账与收缩 100%，replay 口径）；九门回归零扰动（主套件 356/0）；OQ#7 维持 skipped（全程冷重启无 dev_reload 触发面）。

### 2.3 独立预设挂载（PhaseB 选项③，用户裁决：独立插件自制挂载，不依赖宿主 registry）

宿主 `agentPresets` 服务是 **AgentPreset loader entry 注册制**（`dsh-agent-preset/lib/index.js`：`Service.init → ctx.agentPresets.register`），不认 `~/.dsh/.agent-presets/` 磁盘用户预设——第三轮彩排实证（spawn 报 "Unknown agent preset: minimal-eval"，fail-fast 拦截零孤儿会话）。用户裁决走**自制磁盘挂载**（桥接注册与上报宿主两路否决）：

| 部件 | 落点 | 边界与取舍 |
|---|---|---|
| yaml-mini 子集解析器 | `lib/yaml-mini.js` | 只覆盖本仓预设实际用到的构造（嵌套 map/seq、单引号、整数、布尔、全行注释）；flow 风格/双引号/多行标量/TAB/锚点/标签一律 fail-fast 列行号——**不做通用 YAML 的诚实边界** |
| 磁盘装载器 | `lib/disk-presets.js` | `listDiskPresets` / `loadDiskPreset`（preset.yml 元数据 + agent.cordis.yml 组件清单；未知键 fail-fast 列名）/ `mountDiskPreset`（组件级契约：`export{apply…}` 插件形走 `ctx.plugin` 优先、apply 直挂兜底（降级声明）；default class 服务形走 plugin；`cordis:group` v1 **拍平**+isolate 未复刻显式声明偏差；未知形态 fail-fast 列名） |
| spawn 链解析序 | `lib/spawn.js` | **磁盘目录优先 → 宿主 registry 兜底（服务可得时）**；目录存在即权威（装载失败响亮 fail-fast 不静默回落）；显式/配置预设双路都不可得 → fail-fast（b4b8ee4 ②语义保留） |

**终态校订（`6000ab9` / `e522b9b`，含宿主侧裁决性发现）**：

- **组件导入双路链**（`6000ab9`）：`importComponent` 直 import 失败 → 宿主包根 `createRequire.resolve` 兜底（detectHostVersion 同款探测；exports 只开 import 条件时回落 package.json main）转 file URL import——dev checkout 树不含住宿主 node_modules 的组件包，单路在开发态必炸；persona / pwsh / fs / str-replace-editor 四组件本地实证。
- **存在性校验双路**（`e522b9b`）：spawn 早期校验分两路——agentPresets 服务可用 → registry resolve 校验（bundle 迁移预设可达）；服务缺失 → 磁盘清单兜底（清单不认识 = 不存在并列清单；清单认识但目录缺席 + 服务缺失 = 无法挂载 fail-fast）；resolve 拒绝消息补磁盘可用清单。
- **宿主侧裁决性发现**：宿主官方技能文档明示 `~/.dsh/.agent-presets/` 为 legacy 格式（"Nothing reads that directory any more"），官方正解 = 自建预设做成 bundle 安装（`dsh plugin add`）经宿主 registry 挂载。本机评测预设 `minimal-eval` 已按此路迁移（组件 persona / pwsh / tool-fs / str_replace_editor；dsh-command-compact 因 reference 标注 preset-mountable=no 移除）；插件磁盘装载路保留为服务缺失时的独立兜底。
- **fail-fast 拦截链注记**：Phase B 四轮彩排全程零孤儿会话——预设不存在 / Unknown preset / 组件导入失败 / persona schema 必填缺失 / 存在性误拦全部被响亮拦截后转入修复，未产生静默降级会话（全过程记录见 `agent-out/opt-b1-s5-report.md` 节九/节十）。

---

## 3. personas/ — 角色人格（34 文件）

### 3.1 角色人格（23 份，frontmatter + 单个 `<Agent_Prompt>` 块）

三泳道 × 三档位全景（🔒 = 只读角色：机制层有 B1 per-session 收缩（fail-open），文字层任务书只读顾问条款仍保留——均非环境级隔离，见 README 已知限制 1）：

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

## 4. skills/ — 工作流技能（在盘 29 个文件 = 25 个 SKILL.md + README.md + replica-map.json + 2 references；其中 28 个在 git 跟踪内）

全部为**纯提示词资产**（SKILL.md 单文件，description 触发词前置——DSH 技能目录只显示 description 前若干百字符）。安装：把技能目录复制到 `~/.agents/skills` 或 `~/.dsh/skills`。

**入口（2）**

- `agent-workflow-router` — 总路由：按意图接到下述技能，固化五条硬协议（派活前置三问 / 档位现场确认禁越档 / 任务书四条必含 / 点对点消息纪律 / 工作区纪律）。
- `agent-general-route` — 兜底路由：意图表逐条对不上时接管；「体量×并行×上下文×风险」四轴判据裁决派席 or 主会话单干，persona 走双通道（`agent_spawn` 角色库要方法论 / `de_session` 临时 persona 做执行创作），附派前报备、成本闸、回收双查与「何时退回流水线」自限条款。

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

**顾问（1）**

- `advisor` — 内置顾问的触发词手册；机制本体是 `lib/advisor/`（见 §2.1），**不是工具**。提示词资产与其运行时的分工同其余技能：`skills/` 只负责「何时触发/怎么用」，行为由 `lib/` 实现。

`skills/README.md` 为源副本说明页（装机分布与同步纪律）。**装机同步**：25 件技能分装于两个用户级技能根（互补无重叠，实测 B=12 / C=13 合计 25，与仓内件数一致），`tools/skill-replica-check.ps1` 按 `skills/replica-map.json` 比对（注意：replica-map.json 含本机运维路径，已移出 git 跟踪、仅本地维护——见 §6）。

---

## 5. tools/ — 独立 CLI 与机检（19 文件 = 机检脚本 10 + 测量/读取 6 + 负向自测 2 + 数据 1）

| 文件 | 职责 | 自测 |
|---|---|---|
| `crgate.mjs` | 评审确定性证据链：`freeze`（覆盖分母冻结+身份哈希）/ `anchor`（发现逐条锚定，`--strict` 为交付前强制门）/ `finalize`（覆盖状态机：reviewed/skipped/blocked/waived） | `crgate.test.mjs` 65 断言 |
| `publish-scan.mjs` | 发布前脱敏机检：六类扫描（secrets/PII/内部路径/危险文件/配置完整性/git 历史）+ 三值裁定（PASS / PASS-WITH-WARNINGS / FAIL，单 CRITICAL 即 FAIL）；`--strict-tracked` 放行门、`--allow` 豁免清单（waiver={id:规则名, glob, reason}，缺 reason 响亮报错，waived 仍列示） | `publish-scan.test.mjs` 47 断言（注入必红） |
| `install-personas.mjs` | 人格批量安装到 DSH（默认跳过已有自定义版本）；**装配期两级断言**经 `lib/persona-gate.js`：非豁免角色缺注入基线 → exit 1 不落盘并报文件名；缺「不做什么」→ 警告非阻断 | `verify-imp26.mjs` 33 断言（含 fd-stdio 跑真安装器的 E2E 层） |
| `assemble-review.mjs` | 评审材料装配（`tools/approved.json` 记录批准来源与时间——approve 记录的可审计形态）。**注**：依赖 `review/original` 与 `review/trans` 目录（OMC 英文原文与中文译文的对照底本，维护侧本地过程物，不随仓分发）——clone 后可运行但产出为空对照，属内部评审过程工具非对外工具 | — |
| `publish-sync-check.ps1` | **公开仓同步幂等 diff 门**：本地 HEAD vs origin/master 零差异 exit 0；ahead 列文件 / behind 提示 pull（fetch 走 cmd /c 静默取退出码，避 PS5 stderr 陷阱） | 冒烟 in-sync exit 0 |
| `skill-replica-check.ps1` | 双装机根一致性机检：按 replica-map.json 逐技能 SHA256 比对（match/drift/missing/unknown 四态）。**注**：replica-map.json 含本机装机路径，已移出 git 跟踪、仅维护侧本地维护——clone 后运行会 FAIL exit 1（fail-loud，不静默），属本机运维脚本非对外工具 | 本地运行（需本地 replica-map.json） |
| `verify-imp26.mjs` | persona-gate 负向自测四层：①判据层纯函数（真实 executor 正文+真实 ECC 基线文本）②E2E 注入必红（fd-stdio 跑真安装器，INSTALL_PERSONAS_ROOT 重定向）③真实树全量跑 ④汇总裁定 | 33 断言——2026-09-30 修复后首次 33/0（见 §7） |
| `taskbook-26a-negative.mjs` | taskbook 六参数 null 穿透等负向断言（IMP-26a 修复的注入必红回归门；R3 时代扩为 11 变异体） | 11/11 变异必红 |
| `session-guard.mjs` | 会话悬尾巡检门（clean/suspect/candidate/inflight 四态）：liveness 回填（running/idle/offline）+ self 白名单（测量者自悬排除）+ death-cases 幂等追加；只报警不判因（死因人事后确认）；输入复用 `measure-decay --scan --json`，`--json` 出机器读数 | `--selftest` 19 断言（7 元素 4 态夹具 + 注入必红 3/3：去 liveness 分支 / 去阈值比较 / 密度判据回流，变异副本动态 import） |
| `measure-injection-surface.mjs` | A1 全注入面基线测量：面A 工具面 / 面B 技能面 / 面C persona 面 / 面D 任务书面四口同测（码点/码元/字节三口径），`--diff` 支持 ±0 复跑判定；面B fail-closed 双臂（数量≠口径 或 坏文件存在 → exit 1） | `--selftest` 9 断言（含坏文件凑足/数量≠口径/尾参缺值注入必红） |
| `measure-decay.mjs` | 会话日志工具调用密度衰减测量（早/中/晚三段）+ 尾悬死亡签名 + `--scan`/`--cases` 批量模式；zstd 读取经 `zstd-read.mjs`（帧边界 FCS 截断 + fail-closed 预算 + 重复行拒测） | `--selftest` 50 断言（含大帧贪读夹具与预算注入必红） |
| `zstd-read.mjs` | 宿主多帧 zstd 会话日志读取器：Frame_Magic 候选扫描 → 逐候选解压 → 按帧头 Frame_Content_Size 截断回单帧（Node sync 解码对 16KiB 对齐帧贪读吞并后续帧的防御）+ 帧数/单帧/累计三重预算 + 去重行防护 | 由 measure-decay selftest 覆盖（变异体必红 4/4） |
| `usage-probe.mjs` | 会话日志 usage/token 持久化探针（M3 缓存对照测量基建，AC-C5）：canonical 四元组 + 恒等式/缺字段/坏行/空 usage 四类诊断 + 首请求冷启动/第二请求稳态/cacheHitShare；多帧 zstd 经 `zstd-read.mjs`；`--scan` 批量模式 | `--selftest` 24 断言（3 请求黄金夹具值两两不同 + 三类变异必红：缺字段/坏 JSON/空 usage + 2 帧 zstd 端到端） |
| `opt-r2-faced-probe.mjs` | 面 D 净注入读数探针（口径B：头部+静态三节+参数模板行；R3 净注入门复跑入口）——输出路径**必填**（缺参 exit 2，防历史基线被静默覆盖） | 与 measure-injection-surface 共用 splitSections/metrics（零口径漂移） |
| `scan-role-toolrefs.mjs` | toolscope 构建期角色引用扫描（B1 S3）：23 角色全扫 → `policies/toolscope-roles.json` + G11 覆盖率报告 + M11 宿主版本构建期查一次；损坏 fail-closed 非零退出 | 漂移门（run.mjs：roles 文件 vs 内存重扫 deep-equal） |
| `toolscope-efficiency.mjs` | V3-3 收缩生效率读数组消费器（B1 S5）：对账通过率/实际收缩占比/fail-open 原因分布三值；`efficiencyReadings` 纯函数（吃管线 audit 环）+ `replayEntries` 离线重放（同一决策核）；阈值 50%（低于 → verdict 触发表修复轮）；零样本如实 `no-sample` | run.mjs 消费核/重放/无样本如实申报 4 条 |
| `approved.json` | assemble-review 的批准记录（数据文件） | — |

**tools/ 面设计纪律**：全部机检脚本**注入必红**（把坏样本喂进去断言变红——只验证「好文件过门」的闸门是半成品）；输出排空后再退出；「无意见」唯一合法形态是空输出+exit 0。

---

## 6. tests/ — 测试与验收门（13 文件）

| 文件 | 职责 | 当前账 |
|---|---|---|
| `run.mjs` | 主测试：纯逻辑 + 假宿主全链路 + 端点 + advisor 全链 + 浏览器半/manifest 门 + 26a 负向组 + V3 基线组 + V3 行为验收组 + D-1a 档位差异化判别组 + **B1 三特性组**（AC1/AC2/AC3 断言 + spawn 决策并轨 + 生效率读数组 + M11 读取面 + 频控 config + 审计轮转 + 预设挂载/磁盘装载器）+ 独立门接线组（body-hash 真实门+自测 / usage-probe 自测 / session-guard 自测，子进程 stdio inherit 直跑、非零退出即入账） | **356 passed / 0 failed** |
| `advisor.test.mjs` | advisor 专项：存储/端点/observer/runtime/检索/上下文/预筛/agentic/行为验收（主套件内的 advisor 分组来源） | 含于 356 |
| `isolation-gate.mjs` | **进程边界双快照隔离门**：before 快照 → 动态 import 主套件 → after 快照 → 断言相等（防「加载期写盘被烘焙进基线」的假绿）；看门狗强制收口；`--selftest` 必红→必绿 | exit 0；selftest **5/5** |
| `advisor-llm-replay.mjs` | **LLM 录制/回放设施**：录制端透明 passthrough → 落盘 fixture（不存请求正文）→ 回放逐块深比较；`ADVISOR_REPLAY_MISS`/`UNCONSUMED` 双侧 fail-closed | **9/9** |
| `skill-sync-check.mjs` | **计数漂移门 + `.gitattributes` 门 + eol 一致性门**：README/ARCHITECTURE 里每处技能计数表述必须等于 `skills/**/SKILL.md` 实测件数；全跟踪文件 worktree==index 行尾一致；零命中 fail-closed + 阳性对照 + `--selftest` | PASS（变异体 **16/16** 达到期望） |
| `body-hash-check.mjs` | **persona body_hash 一致性门**（R2 C-2/C-1 根因机制化）：全 `personas/*.md` 按 body 域公式重算比对，漂移/缺字段/形态非法响亮失败；公式唯一源 = `lib/persona.js` splitFrontmatter；已接入 run.mjs 标准门序列（R2 接线批：真实门 + `--selftest` 双注册，子进程形态） | 真实 23 文件 PASS（exit 0）；`--selftest` 函数级变异 **7/7** 必红（不碰真实文件） |
| `boot-schema-check.mjs` | **装前必过门**：宿主真实校验器（dsh-tools assertSupportedJsonSchema）验证三工具 parameters + output.schema。**前置条件：本机已安装 DSH 宿主**（宿主包路径经 APPDATA 运行时解析）——无宿主环境跑不了，非 clone 即可复现门 | 六项 ALL PASS |
| `installed-smoke.mjs` | 安装副本烟测：工具 + settings + 端点三方同源 | 安装后跑 |
| `probe-boot.mjs` / `probe-catalog.mjs` / `probe-client.mjs` / `probe-tier-save-loss.mjs` | 重启后探针：宿主引导图含本插件 / 工具目录可发现 / client.js 可分发 / 三档写保真回归 | 重启后跑 |
| `verify-live.mjs` | 安装态活体验证支撑 | — |

**复现命令**（clone 后）：

**第一组——任何 Node 环境即可复现（五门，公开 registry 装 1 个运行时依赖）：**

```bash
npm install                        # 公开 registry 可装（1 个运行时依赖）
node tests/run.mjs                 # 356/0（含独立门接线组）
node tests/isolation-gate.mjs      # 隔离门（进程边界双快照）exit 0
node tests/advisor-llm-replay.mjs  # 录制/回放闭环 9/9
node tools/crgate.test.mjs         # 65/0
node tools/publish-scan.test.mjs   # 47/0
node tools/verify-imp26.mjs        # 33/0
node tests/skill-sync-check.mjs    # 计数漂移门 + .gitattributes + eol 门（零依赖纯 fs）
node tests/body-hash-check.mjs     # persona body_hash 一致性门（--selftest 函数级变异 7/7）
npm test                           # 串联入口：主套件 + 隔离门 + 回放 + 计数门 + boot（见下组）
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
| 主套件 | 356/0（含独立门接线组 + B1 三特性组） |
| 隔离门（isolation-gate） | exit 0（selftest 必红→必绿 5/5） |
| LLM 回放（advisor-llm-replay） | 9/9 |
| 计数漂移门（skill-sync-check） | PASS（阳性对照 PASS + 变异体 16/16 变红 + eol 一致） |
| crgate 自测 | 65/0 |
| publish-scan 自测 | 47/0（注入必红） |
| persona-gate 自测（verify-imp26） | **33/0**（2026-09-30 修复后首次全绿） |
| boot-schema（宿主真实校验器） | 6/6 PASS（**需本机已安装 DSH 宿主**，非 clone 即可复现） |
| 可安装性（A-full 验收） | 干净 clone → npm install → 第一组门全绿（boot-schema 需宿主环境，见 §6 分组） |

### 7.2 安全与发布账

- **脱敏放行门（双口径，2026-09-30 复测）**：
  - **公开仓 clone 账面（分发物真实账）**：`node tools/publish-scan.mjs --repo . --strict-tracked` → **PASS-WITH-WARNINGS（critical=0，warning=17）**。17 条构成：loopback 白名单 ×12（lib/http-config.js:28 端点守卫、tests/* 5 个文件的探测目标、personas/document-specialist.md:67 与 skills/opensource-sanitize 教学文本 ×4）、`.secrets` 引用 ×3（opensource-sanitize 的扫描模式教学文本）、私网 IP 教学文本 ×1——全部为回环守卫代码或脱敏方法论教学样例，无真实内网信息。
  - **维护侧工作树账面**：同命令 + `--allow .publish-scan-allow.json` → PASS-WITH-WARNINGS（critical=0，warning=27，waived=2）。比 clone 多出的 10 条全部位于未分发的本地过程物（`review/` 对照底本 8 条 + `backup/` 快照 1 条 + replica-map.json 豁免 2 条）。
  - 豁免清单 `.publish-scan-allow.json` 仅 1 条且 reason 公开可见；注意 waiver 需显式传 `--allow`（非自动加载）。
- **端到端复核**：干净 clone 公开仓后六模式敏感 grep（用户级路径 / 盘符绝对路径 / 会话 id / file:/// / 密钥样态 / 本地分析目录引用）**全零命中**。
- **第三方独立扫描（gitleaks 8.30.1，2026-09-30）**：对全量 git 历史（56 commits）与活树各扫一遍（`gitleaks detect --redact` / `detect --no-git --redact`），两侧各报 **3 条命中，全部位于 `tools/publish-scan.test.mjs`（L88 / L118 / L175）**——逐条定性均为注入必红测试的显式假凭据 fixture（占位字样私钥块 / 顺序数字占位的 sk- 样例 / 字母表倒序拼接的假 token），不可用、非真实格式；与自研扫描器「凭据样态均为占位」的结论交叉一致。gitleaks 无占位识别故判 leak，自研扫描器按占位降级 warning——口径差异已记录，安全结论一致：**无真实凭据泄露**。复现命令与 fingerprint 见 gitleaks 报告（维护侧留档；外部评审者可用任意版本 gitleaks 独立复跑）。
- **git 历史注记**：本仓由私有开发仓直接转公开，历史 commit 含开发期过程物（评审中间稿等）。活文件树已按上述门清理；历史面无密钥级内容（自研扫描器 git-history 层 critical=0，sk- 形态命中均确认为文档占位样态；gitleaks 独立交叉验证同结论，见上条）。历史清洗（history rewrite）为可选运维动作，经第三方扫描确认无真实泄露后**暂不执行**——评审者评估历史面时可依此口径。

### 7.3 案例一：一次评审级盘点揪出的 critical 缺陷（已修复）

编写本文前的逐文件盘点（`git ls-files` 对照文档断言）发现：`install-personas.mjs` import 的判据模块 `lib/persona-gate.js` **从未入库**（工具不可运行，且 18 份 OMC persona 的工作树副本回退到旧态——此前的误删事故只恢复了部分文件）。修复路径：按负向自测（verify-imp26 的 33 断言契约）逆向重建判据模块 + `git restore` 归位 18 文件 + 修复测试夹具的 CRLF 静默失效——修复后 verify-imp26 首次 33/0 全绿。

**负面证据的自我认定**：该缺陷存在期间，主套件 65 断言全绿且未预警——主套件不覆盖「工具 import 依赖完整性」这一装配面，属测试覆盖的真实盲区；此缺陷能存活到发布前盘点才被发现，说明「测试账面绿」不能替代「逐文件断言核对」。案例按此双重含义保留：既有盘点方法论的价值，也有发布前流程存在漏洞的记录。

### 7.4 已知限制

完整 8 条见 README「已知限制」。核心三条：只读角色的工具面约束是「机制层（B1 per-session 收缩，fail-open）+ 文字层（任务书条款）」双轨，均非环境级隔离（exec 外联不受约束、策略文件同机可写面=advisor 同款信任边界）；人格文件缺失时角色退化摘要模式运行；上下文隔离是「硬会话层 + 软材料层」（材料层靠机检告警而非阻断）。

**B1 开放问题状态（2026-10-26 S5 后，正本 `agent-out/opt-b1-design.md` §七）**：

- **已关**：#2 投递审计 + spawn 决策日志落点 = `reply-audit.jsonl`（S4 定 + S5 并轨，kind:'reply'/'spawn' 同文件异类）；#6 roster 同步挂点 = 独立脚本 `scan-role-toolrefs.mjs` + run.mjs 漂移门（S3 定）。
- **条件开放**：#4 P1 红分支 MCP 收缩延 B3 排期（当前 P1 绿，条件未触发）；#5 P3 红分支中转回退下的汇报契约重设计（当前 P3 绿，条件未触发）。
- **Phase B 已收口（2026-10-27）**：AC1-4/AC3-5 端到端彩排第四轮全链达标（minimal 会话自持 write/edit 亲自完成产出 + agent_reply 恰一条 idle 唤醒，见节 2.2 / 节 2.3）；#7 维持 skipped（全程冷重启、无 dev_reload 触发面）；V3-3 实然读数 efficiency-ok（8 策略文件全 applied，replay 口径 + 实然层零子派生证据）。
- **留组织者裁**：#8 路径级写约束（只读席「只读写盘」纪律的实现化，guard 阶段候选——restrict 是工具名粒度做不到）。

---

## 8. 与上游的关系

本仓是三个 MIT 上游的**移植与再实现**，义务履行（版权与许可全文）见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

1. **oh-my-claudecode（OMC）**：19 个基础角色人格的底本——18 份逐字翻译移植（中文译文逐字对应英文原文），1 份（code-reviewer）在底本上深度改造升级为 v2.3。
2. **everything-claude-code（ECC）**：4 个专项角色方法论、11 份评审清单、opensource-sanitize 技能与 publish-scan 的方法论来源。
3. **MACAE（Microsoft）**：任务书模板机制来源；subagent-clarify 的工具级 HITL 机制参考（与 OMC guard 混合来源）。

移植原则：方法论**全量保真**（OMC 宿主设施→DSH 原语只做映射不做删减）；适配决策记录在提交历史（commit message），不占运行时上下文。上游逐字对照底本不随公开版分发（本地评审过程物），需要时可按 NOTICES 所列上游仓库自行取源比对。

---

## 9. 评审建议路径

1. **先跑后读**：§6 第一组五门（Node 环境即可复现）是本文全部代码断言的可执行性前提；第二组需宿主环境。
2. **主链路**：`lib/index.js`（工具注册）→ `lib/taskbook.js`（任务书合成与防御面）→ `lib/spawn.js`（会话创建时序）。
3. **机制深度**：`lib/persona-gate.js` + `tools/verify-imp26.mjs`（判据与负向自测同构）；`tools/crgate.mjs`（评审证据链状态机）；`tests/skill-sync-check.mjs` + 其 `--selftest`（文档计数门与变异体）。
4. **安全面**：`tools/publish-scan.mjs`（规则表）+ `.publish-scan-allow.json`（豁免与理由）。
5. **提示词资产**：`skills/agent-review-squad/SKILL.md`（流程硬化最密的一件）与 `personas/code-reviewer.md`（反编报三件套）。
6. **欢迎攻击**：fail-loud 边界（未知输入）、隔离机检的绕过面、任务书模板与生成器的一致性——这些是维护侧最希望被外部视角检验的位置。issue 与 PR 均欢迎。

---

## 10. 效果评测（2026-09-30，A 组关账）

针对外部评审提出的核心问题——「23 角色三档路由是否真的优于单 agent」——维护侧做了一次受控对照评测。任务取自 DeepSWE v1.1（datacurve-ai/deep-swe）官方任务集：fastapi-implicit-head-options（全 Python 任务带中参考解最大的一题，held-out 测试 43 项 + 回归 3134 项），以官方 grader.py 零改动复用判分（本地非容器口径，平台噪声以 pristine 校准剔除后按官方同式修正，官方与修正双口径并列披露）。

### 10.1 主对照（同任务、同模型、同需求原文，唯一自变量=编排）

| 配置 | 席位链 | held-out（43） | 修正口径 | 总耗时 |
|---|---|---|---|---|
| C0 单 agent | executor ×1 | 38/43 | 未过 | 54 min |
| C1 三席 | planner → executor → verifier（全同档） | **43/43** | **通过** | 112 min |
| C2 全路由 | explore → planner → executor → test-engineer → verifier（档位按角色表，planner 高档） | **43/43** | **通过** | ~117 min |

### 10.2 差异归因（可复现）

C0 失败的 5 项全部集中于**需求歧义点的裁决**（include/router 优先级语义，C0 席自主决策选错方向）。两个编排配置的 planner 席**互不可见却独立得出同一正确裁决**——歧义裁决是编排在本任务上被证实的价值位点。C1 与 C2 的官方分并列；C2 的增量是验证置信度（独立测试矩阵 89 项 + 终验探针 422 项，均与实现席产出互不依赖），而非判分差异。

### 10.3 边界与诚实声明

- 对照实验在中等难度任务上呈**天花板效应**（单 agent 已满分，编排无上升空间）——编排价值只在难任务带可见，本结论仅来自 n=1 大型特性任务，探索性证据，不做显著性声明。
- 编排的代价：时间约 ×2.2、席位成本约 ×2-3.6（同任务同模型口径）。
- 防应试四层贯穿全程：判分资产与执行席位物理隔离、每席会话记录审计（8 席全部零命中）、任务书禁读条款（违者作废）、产物 diff 抽查。
- 判分为本地非容器复刻口径，不可与 DeepSWE 官方 leaderboard 分数直接对比。
