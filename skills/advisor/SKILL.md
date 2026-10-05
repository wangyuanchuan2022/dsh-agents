---
name: advisor
description: "触发：advisor、顾问、每轮评审、每回合把关、把控全局走向、自动评审、帮我盯着、旁听评审、开个顾问、每轮有人把关｜English: advisor, review each turn, per-turn review, automatic review, oversight, second opinion, keep an eye on it｜advisor 顾问（dsh-agents 内置）：每个 turn 结束后自动用「该会话手动指定的模型」只读主会话可见消息、独立上下文，给主 agent 分级建议（info/nit/concern/blocker），nit 及以上默认走 steer 实时打断指导。**被动机制、无工具面**（不占 agent_roles / agent_taskbook / agent_spawn 三个工具位），经会话头部动作区的 Advisor 面板启用，**不设任何 advisor* 工具**；模型完全手动指定、无任何兜底，未指定即该会话不评审。含三条不可跳过的前提与六条已知边界（liveness check 非授权、至多一次、agentic 跨重启补评、只评审主会话汇总、窗口淘汰边界、多实例不共享数据目录）。"
---

# Advisor 顾问（advisor）

> 一句话：主会话每跑完一轮，自动叫一个**你手动指定**的模型来看一眼全局走向，给分级建议——它不是 sub agent，不用你派，按节拍自己出现。

## 0. 何时用 / 何时不用

- 用户说「帮我盯着 / 每轮把关 / 把控全局走向 / 开个顾问 / 每轮有人 review」→ 用本技能，先走第 2 节的面板启用三步。
- 用户说「advisor 面板打不开 / 开了没生效 / 没指定模型 / 一条意见都没有」→ 用本技能走第 6 节排查顺序。
- **不需要「每轮都要有人把关」的轻量任务**（改个措辞、查个文件、跑条命令）→ **不要开**，理由见第 5 节的成本口径。
- 想让 sub agent 干活（派角色、派任务、指定交付物）→ **不走本技能**，走 `agent-workflow-router` / `agent-general-route`。

## 1. 这是什么：被动机制、无工具面

advisor = **每个 turn 结束后自动调一个模型，给主会话「把控全局走向」的评审机制**。

| 维度 | advisor（本技能） | 三个派活工具（`agent_roles` / `agent_taskbook` / `agent_spawn`） |
|---|---|---|
| 出现方式 | **自己按节拍出现**：turn 结束即评审 | **被叫来干活**：先查角色、审任务书、再派 |
| 是不是工具 | **不是工具**。全仓 `tools.register` 只有三处，正是上面那三个（`lib/index.js:805-807`） | 就是工具 |
| 有无工具面 | **无**——不占这三个工具位，也**不设任何 `advisor*` 工具** | 工具面本体 |
| 上下文 | 自己的持续会话，**继承主会话零上下文** | 靠任务书注入上下文 |
| 产出落点 | 分级建议，以**用户指令口吻**进入主会话（nit 及以上默认 `steer` 实时打断） | sub agent 的产物按任务书交付 |

一句话区分：**sub agent 是「被叫来干活」，advisor 是「自己按节拍出现」**。想派活走派活工具，想把关才开 advisor。

## 2. 怎么用（走面板，不设工具）

**没有 `advisor*` 工具**，唯一入口是 Advisor 面板（挂 `conversation.session.header.actions` 槽位，`lib/client.js:727-734`）：

1. **开面板**：目标会话的**会话头部动作区**有个 Advisor 胶囊（可拖动、位置持久化），点它打开右侧停靠面板。
2. **选模型**（先做这步）：面板「评审模型」区选 `provider` 与 `model` → 点「保存模型」。
   来源 chip 必须从「未指定（该会话不评审）」变成「**本会话手动指定**」。
3. **启用**：勾选「**为本会话启用**」。
4. （可选）「**立即评审一次**」不等下一轮，直接补一次评审。

顺序不能反：**「为本会话启用」复选框在未选模型时是禁用的**（tooltip：「请先在下方为本会话选择评审模型（开启必须同时指定模型）」，`lib/client.js:450`）。先勾启用再补模型，第一发会被服务端 400 挡回。

面板上还能看到：运行状态（`disabled/idle/reviewing/error`）、队列长度、上次评审时间、按严重度排的评审记录。

## 3. 三条不可跳过的前提（用户拍板的硬语义）

### 3.1 模型完全手动指定、无任何兜底

- 只认**该会话自己**配置文件里的 `provider` / `model`（`lib/advisor/index.js:193-206`）。
- **不回落 HIGH 档、不读全局配置、不继承主会话模型**。`resolveAdvisorModel` 历史上第二个入参就是 HIGH 档路由提供者，**现已彻底移除**。
- **不指定 = 该会话不评审**：端点以 `modelSource:'unset'` 如实说明，`runtime.status='error'`。
- 硬门禁在运行时也成立：未指定模型时 `ensureRuntime` 直接返回 `undefined`，**绝不调模型**。

### 3.2 `advisorEnabled` / `advisorProvider` / `advisorModel` 是废弃兼容键

三者的准确措辞是 **deprecated / compatibility-only / does not affect runtime behavior**（`lib/advisor/index.js:83`）。

- **不要去改 `cordis.patch.yml` 里这三个键**——它们**必须继续留在 `ALLOWED_KEYS`**：`cordis.patch.yml` 随包默认带着它们，删掉成员会让「老配置里还在的键」触发「未知 advisor 配置键」而**整个插件 boot 失败**。
- 现在只被**解析**（保兼容，且绝不抛错）与**一次性告警**（条件：键存在且值与随包默认 `false`/`null`/`null` 不同），**不参与任何生效判定**。
- 为什么不能只写个 deprecated 了事：配置里躺着一个**看起来像开关、实际完全不生效**的键，维护者极易据此把逻辑重新接回去。

### 3.3 每会话独立配置，落在自己的文件里

- 落盘路径：`<dataDir>/sessions/<base64url(sessionId)>.json`，只落 `enabled` / `provider` / `model` 三键（`lib/advisor/store.js:64-67`）。
- 分文件而不是共用一个 `config.json`：多个会话可同时改配置，共用单文件要做「读-改-写」，A 读 B 写 A 写就会丢更新。
- **不扩展宿主 settings schema**，不进 `cordis.patch.yml`，也不进宿主 settings；重启后仍生效。
- 写入走「读—判—写全程同步」的临界区（Node 单线程天然串行）；`enabled:true` 必须同时具备 `provider` 与 `model`，否则 **400、零写盘**（U2 成对规则，`lib/advisor/store.js:142-149`）。
- 幂等 seen 集合另存 `sessions/<b64>.seen.json`，**独立文件**，不与配置争同一 inode。
- `dataDir` 默认锚在 `~/.dsh/plugins-data/dsh-agents/advisor`（**不随宿主 cwd 漂移**）。
- 旧版全局 `<dataDir>/config.json`：**存在即忽略**（不读、不迁移、不删除），但每次启动打一次告警——「我明明开了却没生效」多半就是它。

## 4. 已知边界（实测既定取舍，不是待修缺陷，如实列出不藏）

| # | 边界 | 事实与依据 | 后果 |
|---|---|---|---|
| 1 | **`sessionId` 校验是 liveness check, not authorization** | 宿主 `WebRoute` 只有 `kind`/`path`/`handler`，**没有鉴权钩子**，handler 拿的是裸 `IncomingMessage`；宿主自述原文「Ambient presence is neither liveness proof nor authorization」（`lib/advisor/index.js:343-350`） | 能关闭：不存在/已 dispose 的 sessionId → `404`，PATCH 零写盘、GET 响应体零泄露。**关闭不了（同根因 liveness≠authz 的三件暴露面）**：**写**——同机另一页面修改他人活跃会话的 advisor 配置（PATCH）；**读**——GET 他人活跃会话的全部评审记录正文与 runtime 状态（records 按会话过滤只是展示口径、过滤≠鉴权，`runtime.error` 还携带模型原文片段）；**触发**——POST `review` 烧他人会话的评审额度（`busy` 门只防同一时刻堆叠、不防持续触发，等空闲后再 POST 即可连环消耗）——该残余风险（三面）用户已知情接受，靠当前宿主能力无法关闭 |
| 2 | **「恰好一次」实为「至多一次」** | 幂等键与水位的消耗发生在**渲染之前**；无可渲染增量的 turn（典型：模型只发工具调用、结果 role=`tool` 被 user/assistant 白名单滤掉）被键 + 水位**双杀**（`lib/advisor/observer.js:385`、`:393` 直接 return） | 该 turn **永久不评**——事后补上可见内容再重放同一 turn，实测仍 0 次。需要补评走面板「立即评审一次」 |
| 3 | **agentic 分支跨重启会对整段历史补评一次（重复计费）** | agentic 路径（从不发 `turn/end` 的会话）**不碰 seen**（它没有 turn 边界可依，`lib/advisor/observer.js:263-277` 无持久化调用），幂等**只**靠内存游标；重启后游标归零 | **每重启一次，下一次人类输入就对整段历史补评一次** |
| 4 | **只评审主会话汇总，子会话内部 step 不可见** | 数据源封闭：只调当前会话 `deriveMessages()`，无子会话展开路径；子会话产出回父会话是 `tool/result`（role=`tool`），被 user/assistant 白名单直接滤掉（契约 6.2） | 父会话评审看到的是**父会话 assistant 自己的汇总文本**；子会话要评审得单独给子会话开 advisor |
| 5 | **窗口淘汰后的二次评审边界** | 键出 M 窗口（M=`SEEN_WINDOW_SIZE`=256）后，宿主若把旧 turn **整组**重投且 seq 已抬高水位，会作为新键再评审一次 | M 窗口 + 水位设计的**固有边界**，非实现缺陷；对侧取舍是宁可漏评不重复计费 |
| 6 | **多实例共享同一 `advisorDataDir` 不在支持范围** | 存储侧的「临界区全同步」是**进程内**串行，跨进程不成立 | 多实例部署需各自指定独立 `advisorDataDir` |

**另两条使用面约束**（不是边界，是会直接咬人的事实）：

- **与 memory-evolve 的 advisor 语义重叠**（它也是只读快照自动评审）。**两套不同时开**——同回合会被评两次、token 翻倍、右侧两个面板撞车。
- **触发上限不投递、不降级**：触顶（`max-tokens`）或终态不可信时一律不投递，记 `runtime.status='error'` 并落一条记录，**绝不降级成 info/recorded**——被截断的评审意见基于不完整判断，危险的 blocker 比没有更危险。

## 5. 成本口径与何时不该开

- **单轮输入 ≈8.5K tokens 起步**（口径：`lib/advisor/runtime.js:33` 记录的量级估算「单轮 input≈8.5K + output 封顶 ≈16K ≈ 25K tokens」；随对话变长与配置 `advisorMaxMessages` 变化，**这是量级不是精确值**）。
- 输出预算 `ADVISOR_MAX_TOKENS = 16384`，**抬高预算不对冲输入窗口**（`advisorMaxMessages` 保持 60），首轮最坏 ≈25K tokens——用户知情接受。
- **成本随 turn 数先线性涨、到预算后封顶**：评审员是持续会话，跨回合累积，每次评审重放**有界**历史（字符预算 `ADVISOR_CONVERSATION_MAX_CHARS`，超预算丢最旧——2026-10-06 P1-3 修复；此前无截断累积会让长会话撞模型上下文上限后**永久 error 停摆**）+ 本轮增量。
- **据此的开关判据**：不需要「每轮都要有人把关」的轻量任务**不要开**——每轮一次模型调用就是一份起步成本，而这类任务主会话自己就做得完。需要把关的场合（大改造、多轮长跑、方向容易跑偏的活）才值得。

## 6. 出问题时的排查顺序

按此顺序查，**先盘事实再改配置**：

1. **面板里「来源」chip 是什么**？显示「未指定（该会话不评审）」→ 根本是第 3.1 条，先选模型保存。
2. **「运行」状态**：`error` 看面板上的「运行异常」文案（未指定模型会在这里明说）；`disabled` → 该会话没勾启用。
3. **是不是开了但一条记录都没有**？对照第 4 节边界 2：那一轮可能本来就无可评审增量（模型只调工具）。用「立即评审一次」验证链路通不通。
4. **启动日志里有没有废弃键告警**？有就说明有人在按旧方式配 `cordis*` 那三个键——它们改了不生效，回到面板重配（不是去改 `cordis.patch.yml`）。
5. **有没有「检测到旧全局配置 `config.json`」告警**？有 → 旧配置已停用，面板重配即可。
6. **是不是与 memory-evolve 的 advisor 同时开了**？两套不同时开（见第 4 节）。
7. 以上都对仍异常 → 才考虑代码/环境层，此时再读 `docs/advisor-contract.md` 全文（契约第 0/1/2/4/6/7/8 节是行为的单一事实源）。

## 7. 自检（收工前回看）

- [ ] 说的是 advisor 的行为，而不是 sub agent 的行为（本技能**不派活**，它只解释一个被动评审机制）？
- [ ] 引用行为前核过 `docs/advisor-contract.md` 或 `lib/advisor/**`，而不是凭印象复述？
- [ ] 讲成本时带了口径（≈、量级、来自哪条记录）？
- [ ] 需要「每轮把关」的场合才建议开，而不是无脑推荐？
- [ ] 有没有把第 4 节的边界藏起来？尤其边界 1（liveness check ≠ 授权）与边界 3（agentic 重复计费）必须说。
