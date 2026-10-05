# advisor 契约（dsh-agents 内置顾问）

> 冻结于 2026-10-03。**2026-10-04 修订（S5a）**：按 S1–S4 已实现并已验证的行为同步正文——
> 第 0/1/2/4/6/7/8 节实质改写，撤回一句旧措辞（见 6.3【撤回登记】）。
> 本契约只描述**已实现并已验证**的行为，不写未落地的设计。
> 两席（服务端 / 客户端）共同遵守，偏离须先回组织者。

## 0. 它是什么

**advisor = 用「该会话手动指定的模型」，只读主会话快照，独立上下文，给主 agent 实时指导。**

- 读：主会话可见消息（只读快照，`session.deriveMessages()`，**只取 user/assistant 白名单**，见 6.2 覆盖边界）
- 想：advisor 自己的**持续会话**（跨回合累积，继承主会话零上下文）
- 说：分级意见（info / nit / concern / blocker）
- 指导：nit 及以上默认走 `agent.steer()` **实时打断/唤醒**主 agent；info 默认只记录不打扰
- 面板：右侧停靠，随时可见

模型**完全由用户手动指定，无任何兜底**：没有 HIGH 档回落、没有全局 config 兜底，也不继承主会话模型。
未为该会话指定模型 → 该会话 advisor 不工作，端点以 `modelSource:'unset'` 如实说明（见 1.2）。

与 memory-evolve 的 advisor 语义重叠（它也是只读快照自动评审）。**两套不同时开**——同回合会被评两次、token 翻倍、右侧两个面板撞车。

### 0.1 安全语义（显著位置，不只写在风险清单里）

> **`sessionId` 校验 = liveness check，not authorization。**

本端点所有 `sessionId` 相关的校验只回答「这个会话在本进程里还活着吗」，不回答「你有权改它吗」。
之所以必须写在显著位置：未来看到「`GET/PATCH` + `sessionId` + 活跃校验」这一串，极易误以为权限隔离已完成。

- **能关闭**：不存在 / 已 dispose 的 sessionId → `404`，**PATCH 分支零写盘**、**GET 响应体零泄露**
  （404 只有一个通用 error，不含 catalog / records / runtime / provider / model 任一键）；
  形状非法（缺 sessionId、非字符串、空串、超 200 字符、含 `/ \ ..`）→ `400`。
- **关闭不了**：**同机另一页面修改他人活跃会话的配置**。
- **依据**：宿主 `WebRoute` 只有 `kind` / `path` / `handler`，**没有鉴权钩子**，handler 拿到的是裸 `IncomingMessage`；
  宿主自述原文「Ambient presence is neither liveness proof nor authorization」
  （`dsh-agent/lib/types/index.d.ts:192-194`）。`ctx.agents.get(sessionId)` 返回裸 Agent
  （`dsh-agent/lib/types/index.d.ts:343`、`:138`），**不需要** `{global:true}`。
  → 该残余风险**用户已知情接受**，靠当前宿主能力无法关闭。

### 0.2 多实例声明

**多实例共享同一 `advisorDataDir` 不在支持范围。** 存储侧的「临界区全同步」是**进程内**串行
（Node 单线程 + 读—判—写全程同步无 `await`），跨进程/跨实例不成立。

## 1. 配置键（cordis.patch.yml 的 config 段，与 dsh-agents 现有键同风格）

```yaml
advisorEnabled: false            # deprecated / compatibility-only / does not affect runtime behavior
advisorProvider: null            # deprecated / compatibility-only / does not affect runtime behavior
advisorModel: null               # deprecated / compatibility-only / does not affect runtime behavior
advisorDataDir: null             # null → ~/.dsh/plugins-data/dsh-agents/advisor（锚在用户级目录，不随宿主 cwd 漂移）
advisorPanelEnabled: true        # 面板显示开关（与评审运行解耦）
advisorMaxMessages: 60           # 送入评审的有界窗口（0=无上限）
advisorMaxQueued: 32             # 评审队列上限（满=drop-newest）
advisorCallTimeoutMs: 90000      # 单次评审调用超时
advisorImmuneTurns: 2            # steer 冷却：投递后 N 个主回合内降级 inject
advisorSteerSeverities: [nit, concern, blocker]   # 走 steer 的等级
advisorInfoInject: false         # info 是否也注入
advisorSystemPrompt: ''          # 覆盖内置评审提示词（≤8KB，空=内置）
advisorPersistLimit: 200         # 记录保留条数上限
```

`DSH_AGENTS_ADVISOR_DATA_DIR` 环境变量可覆盖数据目录（单测/冒烟与真实数据物理隔离用，优先级低于显式配置）。

### 1.1 三个废弃键：`advisorEnabled` / `advisorProvider` / `advisorModel`

**deprecated / compatibility-only / does not affect runtime behavior。**

- 它们**必须继续留在 `ALLOWED_KEYS`**：`cordis.patch.yml` 随包默认带着它们，删掉成员会让「老配置里还在的键」
  触发「未知 advisor 配置键」而**整个插件 boot 失败**。
- 现在只被**解析**（保兼容）与**告警**，**不参与任何生效判定**。解析不做严格校验（绝不抛错）：
  为一个零作用的键让插件 boot 失败是本末倒置，且抛错发生在告警之前，运维者永远看不到「不影响运行时行为」这条告警。
- 告警条件：键**存在于原始配置且值与随包默认不同**（默认 `false` / `null` / `null`；空串也算「有人配过」，会告警）。
- **为什么不能只写 deprecated**：配置里存在一个**看起来像开关、实际完全不生效**的键，维护者极易据此重新接回逻辑。

### 1.2 模型来源（per-session，**无兜底**）

只认**该会话自己**的配置文件 `<dataDir>/sessions/<base64url(sessionId)>.json` 里的 `provider` / `model`：

| 情形 | `provider` / `model` | `modelSource` | 运行时 |
|---|---|---|---|
| 该会话配置了 provider + model | 原值 | `'session'` | 评审照常 |
| 未指定（含半填、空串） | `null` / `null` | `'unset'` | **不工作**；GET 的 `runtime.status='error'`、`runtime.error` = 原因文案 |

- 不读 HIGH 档路由表、不读全局 `config.advisorProvider/advisorModel`、**不与任何其他会话合并**
  （「存在第二层」这件事本身被结构性排除，故不存在「别的会话/全局把它单独开启」的可能）。
- **`enabled` 也是彻底会话级**：`enabled:true` 必须同时具备该会话的 provider 与 model（见 2.2 的 U2 成对规则），
  不存在「先开再补模型」的中间态。

## 2. HTTP 端点（webServer.register，exact path）

`/plugins/dsh-agents/advisor` —— 形态照 `lib/http-config.js`：回环地址 + Origin 同源双重防护；JSON 出入参；body 上限 8KB。

### 2.1 GET

请求 `GET /plugins/dsh-agents/advisor?sessionId=<id>`。**`sessionId` 必填**：缺失 / 形状非法 → `400`；
形状合法但会话不存在或不活跃 → `404`（在任何快照计算与模型目录读取之前返回，响应体零泄露，见 0.1）。

```json
{
  "ok": true,
  "enabled": true,
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "modelSource": "session",
  "catalog": { "<provider>": ["<model>", "..."] },
  "runtime": { "status": "disabled|idle|reviewing|error", "lastAt": 0, "queue": 0, "error": null },
  "records": [
    { "id": "…", "sessionId": "…", "sessionName": "…", "severity": "concern",
      "text": "…", "createdAt": 0, "outcome": "steer|inject|recorded|dropped" }
  ]
}
```

未为该会话指定模型时 `provider` / `model` 均为 `null`、`modelSource` 为 `'unset'`（见 1.2）。
`records` **按会话过滤**，按 `createdAt` 倒序，最多 `advisorPersistLimit` 条。
除 `catalog`（全局 provider→模型目录）外，载荷里的每个键都**只属于所问会话**：
配置来自该会话自己的配置文件，`runtime` 状态也按会话分桶（别的会话评审失败不会出现在本会话面板上）。

### 2.2 PATCH

请求 `{ sessionId, enabled?, provider?, model? }`（至少一个键）。**`sessionId` 必填**——端点不再有「无会话」的落点。

- 非法形状 → **400 + `{error}`**：未知键、`sessionId` 缺失 / 空串 / 超 200 字符 / 含 `/ \ ..`、
  `enabled` 非布尔、`provider` 或 `model` 为空串或超长、**provider/model 单给其一**。
- 会话不存在 / 不活跃 → **404 + 零写盘**（活跃校验必须在写之前）。
- 写盘落 `<advisorDataDir>/sessions/<base64url(sessionId)>.json`（**不扩展宿主 settings schema**，不进 cordis.patch.yml，也不进宿主 settings）。
- 成功返回与 GET 同形载荷。

**U2 成对规则**：`enabled === true` 必须同时具备 `provider` 与 `model`，否则 **400**、**零写盘**。
该校验与「读—判—写」在**同一段同步临界区**内完成（Node 单线程下天然串行），**不在 handler 层另判一遍**
（handler 层判一次就是 check-then-act，临界区外的读会让并发 PATCH 出现「判过时成立、写时已失效」的竞态）。

**顺序敏感性**：成对规则的判定读的是**合并后**的配置，所以并发/连发的两次 PATCH 可能只有一发的结果成立——
正常客户端交互是「先选 provider+model，再开启」，不会撞；反序（`{enabled:true}` 先到、模型后到）第一发即 400。

### 2.3 POST

请求 `{ action: 'review', sessionId: '<id>' }` → 手动触发一次评审（强制全量重放：复位游标后下一次渲染取全部可见消息）。
**恒 200**，失败一律用 reason 表达，不抛错：

| reason | 含义 |
|---|---|
| `no-session` | 不存在 / 已 dispose / 取不到 agent（**不消耗额度**） |
| `unset` | 会话在，但未为它指定评审模型 |
| `disabled` | 配了模型，但该会话未开启 |
| `busy` | 该会话评审正在飞 |

### 2.4 旧文件迁移说明

旧版把 PATCH 结果写在全局 `<advisorDataDir>/config.json`。现在**存在即忽略**：不读取、不迁移、不删除用户文件，
但**每次启动打一次告警**（至多一条）——否则「我明明开了却没生效」无从查起。配置请在会话面板重新指定。

## 3. 客户端 slot

- slot name：`conversation.session.header.actions`（宿主已确认存在，jobs / subagent / agent-team / agent-preset 都在用）
- id：`dsh-agents-advisor`；order：`80`
- props = `inject()` 返回值（形状自定，参考 `dsh-client-ui-jobs/lib/client.js:610` 的注册范式与 `PropsRuntime` 类型）
- UI：贴右边缘的 capsule（纵向可拖、位置持久化到 localStorage）→ 点击开合右侧停靠面板（`createPortal` 到 `document.body`）

## 4. 记录字段（两席共用，不许各造一套）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定唯一 |
| `sessionId` | string | 主会话（**按此字段过滤返回**） |
| `sessionName` | string | 展示名，可为 null |
| `severity` | `'info'\|'nit'\|'concern'\|'blocker'` | 分级 |
| `text` | string | 意见正文，**单条 ≤200 字（字段级约束，与内容性质无关）** |
| `createdAt` | number | epoch ms |
| `outcome` | `'steer'\|'inject'\|'recorded'\|'dropped'` | 实际投递通道 |

**200 字是字段级上限，不是「意见正文才截断」**：它约束的是记录存储面上的 `text` 字段本身，
所以错误记录（终态不投递说明、解析失败说明）与正常意见**同一条规则**。当前两处 slice 都合法：

- 终态不投递说明 `.slice(0, 200)`（runtime 侧，落一条 `severity:'info'` + `outcome:'dropped'` 的记录）；
- 解析失败说明 `.slice(0, 200)`（同上）；
- 存储面另有一次统一的 200 字兜底（`store.js` 的 `normalizeRecord`：超长则 `slice(0,199)+'…'`），
  以及模型输出侧的 400 字上限（留余量后由存储面截断）。

## 5. 投递语义（指导工作进行）

```
info      + advisorInfoInject=false → recorded（面板可见，主会话不打扰）
info      + advisorInfoInject=true  → inject（永不 steer）
nit/concern/blocker ∈ steerSeverities 且不在冷却 → steer（实时打断指导）
同上但 severity 不在列表 或 处于 advisorImmuneTurns 冷却窗口 → inject
缺 agent（无 steer/inject）→ dropped + 日志告警
```

消息形态：`user-role` 消息 + `source.kind='advisor'` + `notice` form + summary（summary ≤120 字）。
agent 注册表：`agent/created` 时 `agents.set(agent.id, agent)`（`agent.id === session.id`），`agent/disposed`/`session/disposed` 时注销；兜底 `ctx.agents?.get(sessionId)`。
`source.kind==='advisor'` 也是**自评审排除**的唯一依据（advisor 自己注入的消息不进下一轮评审输入，防递归自评）。

## 6. 评审触发时机（observer）

### 6.1 两种触发模式

会话一旦发过任意 `turn/end` 即闩锁为标准模式，agentic 门休眠：

1. **标准 stepped 会话**：可评审 `turn/end`（`reason.kind ∈ completed|max-tokens|error`），且必须是**进入过 `step/start` 的** turn（用户掐断的回合不评审）。
2. **agentic / harness 会话**（从不发 `turn/end`）：人类输入到达（`user/message` 且 `source.kind==='user'`，或 `agent/inbox/spliced` 含 user 消息）**且**存在未评审的 assistant 增量 → 评审（`skipLast` 排除触发输入本身）。
   投影回退（游标比可见消息还长）必须放行，否则重写后的全量重放会被这道门挡掉。

投影回退（`messages.length < cursor`）或可见重写（`compact/*`、非 append 的 `surfaceOp`）→ 全量重放 + 重置冷却。

**未启用该会话 advisor 的会话不进观察器落盘路径**：早退发生在写 seen 之前，否则每个会话每回合都会凭空产生并整份重写一个 seen 文件。

### 6.2 覆盖边界：只评审主会话汇总

**评审输入 = 该会话自身 `deriveMessages()` 投影，且只取 `user` / `assistant` 白名单；
子会话内部的 step / 工具执行过程不可见，也不在覆盖范围内。**

事实依据（非设计偏好）：

- 观察器的数据源封闭——只调当前会话的 `session.deriveMessages()`，无任何子会话展开路径；
- 子会话的产出回到父会话是 `tool/result`（role=`tool`），被 user/assistant 白名单直接滤掉，
  所以父会话评审看到的是**父会话 assistant 自己的汇总文本**；
- 独立探针实测：子会话跑完整一轮后，**送模型的输入里不含子会话哨兵文本**；子会话本身未开启时也不评审。

### 6.3 幂等语义（每 turn 至多评审一次）

- **身份 = `(sessionId, turn)` 二元组**；`seq` **不参与身份**，只作单调守卫（同一 turn 的不同 seq 副本是同一次评审）。
- 两层互补：**窗口内**靠 `reviewed` 精确集合（键 `${sessionId}::${turn}`）；**窗口外**靠**已裁决水位**
  `lastReviewedSeq`——每个 `turn/end`，无论评不评，都把水位推到 `max(水位, seq)`。
- **水位优先、不 fallback**：命中水位直接拦截，**不回落到 `reviewed` 集合**再裁决一次。
- 窗口容量 **M**：`SEEN_WINDOW_SIZE = 256`，**未经实测，按保守值取值**。
  **翻转条件**：日后实测出一个会话两次重启之间的去重事件条数超过本值，把该常量调大即可。
  **判据与测试一律引用该常量，禁止写死字面量**——写死会在取值变更时把正确实现误判红。
- `lastReviewedSeq` 初值哨兵取 `-1`（不是 0）：宿主 `SessionSeqCursor = SessionSeq | -1`，
  且宿主 `seq = log.length` **从 0 起**，用 0 会把重启后见到的第一条 `turn/end`（seq=0）判成水位内而**静默漏评**。
- **`steppedTurns` 按会话累积、不设上界**：1 万 turn 的实测 `heapUsed` 增量 ≈ **0.55 MB**（探针 P5，`node --expose-gc`；
  同规模纯字符串 `Set` 基线 0.62 MB，开销基本就是字符串本身）。`reviewed` 那份**按 M 有界**；
  两者的**清理时机一致**：`disposeSession` 四张表全清（seen 文件**留在盘上**，会话销毁再重建不得重复计费）。

**前提假设（seq 单调性）**：

> 水位机制依赖 `seq` 在**同一事件流中的单调性**；这是本机制的**前提假设**。
> 若宿主发生 seq 回退 / 重编号，属**不支持场景**，此时退化为**水位优先**——
> **可能漏评**（可手动 `POST review` 补回），**绝不重复计费**。

【撤回登记】本契约早前版本写过「水位仅作优化性拦截、**不得作为唯一正确性依据**」。该句**已撤回**：
它与「窗口外重放由水位拦截」（不重复计费）**不可兼得**——若水位命中即 fallback 到 `reviewed`，
被窗口淘汰的旧 turn 会被重新评审，跨重启不重复计费的目标落空。取舍依据是
「**可能漏评比重复计费更轻**」：漏评可手动补，重复计费是用户已拍板的成本问题。

### 6.4 三条契约边界声明（既定取舍，不是待修缺陷）

1. **「恰好一次」实为「至多一次」。** 幂等键与水位的消耗发生在渲染**之前**；无可渲染增量的 turn
   （典型：模型只发工具调用、结果 role=`tool` 被白名单滤掉）被键 + 水位**双杀**，
   **永久不评**——事后补上可见内容再重放同一 turn，实测仍 **0 次**。这是「绝不重复计费」的既定代价；
   需要补评走手动 `POST review`。
2. **agentic 分支跨重启会重复补评。** agentic 路径不碰 seen（它没有 turn 边界可依），幂等**只**靠内存游标；
   而 `seedTo` **仅在 false→true 那一跳且观察器已持有该会话状态时**触发，重启后游标归零。
   → **agentic 会话每重启一次，下一次人类输入就对整段历史补评一次（重复计费）**。
3. **窗口淘汰后的二次评审边界。** 键出 M 窗口后，宿主若把一个旧 turn **整组**重投（且 seq 已抬高过水位），
   重投的 `step/start` 会**重新标记 stepped**，`steppedTurns` 的匹配即删拦不住（它只配对同一轮里的
   step/start 与 turn/end），水位也拦不住（seq 更高）→ 会作为新键再评审一次。
   这是 **M 窗口 + 水位设计的固有边界**，非实现缺陷；对侧保障是 6.3 的水位优先取舍（宁可漏评不重复计费）。

## 7. 评审提示词输出契约与终态判定

### 7.1 输出格式与解析

要求模型输出**严格 JSON**：

```json
{ "notes": [ { "severity": "concern", "text": "…" } ] }
```

- **不剥围栏、不做括号配对提取**——解析失败就大声报错（记 `runtime.status='error'` + 落一条 error 记录 + 写日志）。
  半吊子容错会把「模型没按契约输出」伪装成「评审没有意见」。
- 空 `text` 的意见**丢弃**（非解析失败）；未知 `severity` 归一为 `nit`。
- 单轮最多 `advisorMaxMessages` 条可见消息入窗；评审员持续会话按消息粒度追加，上下文**只属于 advisor**。

### 7.2 终态判定：显式优先级链（**顺序即语义，不可重排**）

判定跑在**输出解析之前**——否则被截断的正文会先撞上「解析失败」，把真正的触顶事实伪装成格式问题。

判定输入两路信号：`finishReason`（`type==='finish'` 分片的 `reason`）与 `outputTokens`（`type==='usage'` 分片的 `usage.outputTokens`）。
已登记 kind：`ADVISOR_FINISH_KINDS = ['stop', 'max-tokens', 'error', 'aborted']`。
本轮输出预算：`ADVISOR_MAX_TOKENS = 16384`（抬高预算**不对冲**输入窗口，单轮最坏 ≈ 25K tokens，用户知情）。
「触顶」= `outputTokens` 达到本轮预算上限。

| 优先级 | 条件 | outcome | 投递 |
|---|---|---|---|
| 1 | `finishReason === 'max-tokens'` | `truncated`（**无条件**） | 否 |
| 2 | `finishReason ∈ {error, aborted}` | `failed` | 否 |
| 3 | 未知 / 未登记的 kind 值 | `unknown`（fail-closed） | 否 |
| 4 | 触及 token 上限（`finishReason ∈ {null, stop}`） | 缺 finish → `truncated`；`stop` → `inconsistent` | 否 |
| 5 | 正文为空（此时触顶已被优先级 4 排除） | `empty` | 否 |
| 6 | 未触顶 + 正文非空（`finishReason ∈ {null, stop}`） | `ok` | **是** |

用 if 早返回逐条表达，**不用「顺序表」**——顺序表会掩盖「谁压过谁」。

### 7.3 七情形分类表（穷举 126 组合实测：互斥完备、零静默丢失）

| 输入情形 | outcome | deliverable |
|---|---|---|
| `finishReason='max-tokens'` | truncated | 否 |
| max-tokens + **空正文** | truncated | 否 |
| `finishReason='error'` / `'aborted'` | failed | 否 |
| 未登记 / 未在 `ADVISOR_FINISH_KINDS` 的 kind | unknown | 否 |
| finish 缺失 + usage 触顶 | truncated | 否 |
| `stop` + 触顶（矛盾态） | inconsistent | 否 |
| `stop` + 触顶 + 空正文 | inconsistent | 否 |
| 未触顶 + 空正文 | empty | 否 |
| finish 缺失 + 未触顶 + 空正文 | empty | 否 |
| `stop` + 未触顶 + 正文非空 | ok | **是** |
| finish 缺失 + usage 在 + 未触顶 | ok | **是** |
| usage 缺失 + `stop` | ok | **是** |

**四条不变量**（全输入空间穷举验证零违规）：

- **I1** 空正文绝不 deliverable
- **I2** 触顶绝不 deliverable
- **I3** 触顶绝不被 `empty` 掩掉
- **I4** 未登记 kind 必 fail-closed

**三条硬约束**（它们是 F-1 P0 与用户评审的修正项，代码与测试都按这三条锁死）：

1. **`max-tokens` 优先于 empty**——即使正文为空，只要 `finishReason==='max-tokens'` 就判 `truncated` 而非 `empty`（优先级 1 压过 5）。
2. **触顶优先于 empty**——触顶是事实、正文为空只是表象；否则 `stop` + 恰好触顶 + 空正文会落 `empty`，触顶事实被 empty 文案完全掩掉。
3. **优先级 4 不得整体 return**——`finishReason === null` 分支在未触顶时必须让控制流**落到优先级 5**，
   否则「正文为空」这一档在该分支下永不可达（`{finishReason:null, outputTokens:100, text:''}` 会被误判成可投递的 `ok`）。

**标签口径不得含糊**：`truncated` **专指** `max-tokens` 或「缺 finish + 触顶」；
`stop` + 触顶用 **`inconsistent`**。二者**行为一致**（不投递 + 记 error），**只是标签不同**——
`stop` 在触顶时是矛盾态（`stop` ≠ 成功），混用标签会在诊断时把矛盾态读成正常截断。

### 7.4 信号取值语义：**last-wins**

`finish.reason` 与 `usage.outputTokens` 各取**最后一次**出现的分片值（后出现的覆盖先出现的），**不是 first-wins**。

**理由**：provider 常先发一个**预估 usage**（偏小）再发最终 usage。若取先出现的值会**低估 `outputTokens`** →
被截断的评审会判成 `ok` → **照常投递，直接绕过「触顶不投递」**。`finish` 同理（协议可能先给中间态 reason 再给终态 reason）。
已由两组用例锁定（均构造 first≠last 两个值）。

### 7.5 裁决 A：两种「kind 不可信」必须分开

「**未知 / 未登记的 kind → fail-closed**」与「**`finish` 字段缺失但 `usage` 在 → 按 usage 判定**」
是**两条独立分支，不可合并**：

- **未知 / 未登记的 kind 值**（协议扩展或异常，如 `'some-future-kind'`、`'length'`）→ 优先级 3，`unknown`，不投递。
- **`finish` 缺失但 `usage` 在**（provider 形态差异，允许任一缺失）→ **按 usage 判定**，走优先级 4 / 6。
- 同理，「usage 缺失但 `finish='stop'`」**不 fail-closed** → 优先级 6，`ok` + `usageUnknown:true`。

合并两者会**误杀**「不返 finish 但 usage 正常」的 provider——那不是异常而是正常形态。

### 7.6 不投递时的处置（不降级）

任何 `deliverable: false` 的轮次：`runtime.status='error'` + `error` = 原因文案 + 落一条
`severity:'info'` + `outcome:'dropped'` 的记录 + 写日志。**绝不降级成 `info` / `recorded`**——
被截断的评审意见基于不完整判断，**危险的 blocker 比没有更危险**。

## 8. 文件所有权

### 8.1 席位（本改造批次为**单席**流程）

| 范围 | 可改 | 禁碰 |
|---|---|---|
| 服务端 + 契约文档（**本改造批次为单席**，S1–S4 已完成、S5a 本批交付） | `lib/advisor/**`、`lib/index.js`（仅装配段）、`cordis.patch.yml`（仅 advisor* 键）、`tests/advisor.test.mjs`、`tests/run.mjs`（仅注册）、`docs/advisor-contract.md` | `lib/client.js`、`skills/**`、`README.md`、`ARCHITECTURE.md` |
| 客户端与技能（后续批次：S5b / S6） | `lib/client.js`、`skills/**`、`README.md`、`ARCHITECTURE.md` | 服务端实现与服务端测试（`lib/advisor/**`、`tests/advisor.test.mjs`） |

### 8.2 数据目录文件所有权

| 文件 | 内容 | 写者 | 备注 |
|---|---|---|---|
| `<dataDir>/sessions/<base64url(sessionId)>.json` | 该会话 `enabled` / `provider` / `model` 三键 | `PATCH` 端点 | 分文件避免多会话「读-改-写」丢更新；base64url 兼作路径穿越防护 |
| `<dataDir>/sessions/<b64>.seen.json` | `{ reviewed: string[], lastReviewedSeq: number, updatedAt }` | 观察器 | **独立文件**，避免与配置争同一 inode（并发 PATCH 与评审落盘互相覆盖） |
| `<dataDir>/records.jsonl` | 终态意见逐行追加，全局单文件 | 记录落盘 | **按会话过滤返回**；超 `advisorPersistLimit` 时重写只留最近 N 条 |
| `<dataDir>/config.json` | 旧全局配置 | **无人** | **存在即忽略**：不读、不迁移、不删除，下次启动打一次「已停用」告警 |
| `<dataDir>/chunk-trace.jsonl` | 取证 chunk 序列 | 取证钩子 | 默认关闭；随建随用、随删随停，无需重启 |

配置与 seen 的读写**全程 fail-open**：写盘失败只告警一次，不打断评审循环（记录丢失 / 跨重启去重降级都不该让主循环崩）。

## 9. 参考实现（只读，不许直接复制粘贴当交付）

| 需要的能力 | 参考 |
|---|---|
| 观察器/触发/增量/重写 | `D:\tools\deepsek_harness\dsh-memory-evolve\lib\advisor\observer.js` |
| 评审运行时/持续会话/解析 | `…\dsh-memory-evolve\lib\advisor\runtime.js`、`prompt.js`、`conversation.js` |
| 指导投递/冷却/登记 | `…\dsh-memory-evolve\lib\advisor\delivery.js`、`kinds.js` |
| 记录持久化 | `…\dsh-memory-evolve\lib\advisor\store.js` |
| 端点范式（本仓） | `dsh-agents/lib/http-config.js` |
| 服务解析（本仓，**必须照抄这条链**） | `dsh-agents/lib/index.js` 的 `rootOf` / `resolveLlm` / `listConfiguredRoutes` |
| 客户端 slot 范式 | `…\@deepseek-ai\dsh-client-ui-jobs\lib\client.js:596-621` |
| 客户端现有接线 | `dsh-agents/lib/client.js`（Picker 暗色主题坑已在里面修好，照抄其配色写法） |

> llm 服务**必须**走 root 解析链（`ctx.get?.('root') ?? ctx.root` → `root.get('llm')` → `root.llm` → 本 ctx 兜底）。隔离作用域里 `ctx.llm` 可能解析得到却缺 provider 目录。
