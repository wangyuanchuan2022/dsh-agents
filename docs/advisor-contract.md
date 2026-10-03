# advisor 契约（dsh-agents 内置顾问）

> 冻结于 2026-10-03。两席（服务端 / 客户端）共同遵守，偏离须先回组织者。

## 0. 它是什么

**advisor = 用 HIGH 档高级模型，只读主会话快照，独立上下文，给主 agent 实时指导。**

- 读：主会话可见消息（只读快照，`session.deriveMessages()`）
- 想：advisor 自己的**持续会话**（跨回合累积，继承主会话零上下文）
- 说：分级意见（info / nit / concern / blocker）
- 指导：nit 及以上默认走 `agent.steer()` **实时打断/唤醒**主 agent；info 默认只记录不打扰
- 面板：右侧停靠，随时可见

与 memory-evolve 的 advisor 语义重叠（它也是只读快照自动评审）。**两套不同时开**——同回合会被评两次、token 翻倍、右侧两个面板撞车。本 advisor 默认 `advisorEnabled: false`，需手动开。

## 1. 配置键（cordis.patch.yml 的 config 段，与 dsh-agents 现有键同风格）

```yaml
advisorEnabled: false            # 默认关（用户拍板）
advisorProvider: null            # null → 回落 HIGH 档当前 provider
advisorModel: null               # null → 回落 HIGH 档当前 model
advisorDataDir: null             # null → <cwd>/.dsh-agents/advisor
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

### 模型回落链（**不继承会话模型**）

`advisorProvider/advisorModel` 任一为空 → 读 **HIGH 档当前路由**：
`settings 服务 tiers.HIGH` → 回落 `bundle patch 的 config.tiers.HIGH` → 都拿不到则 `runtime.status='error'` 并在记录里说明。
判「是否回落」通过响应字段 `modelSource: 'config' | 'HIGH'`。

## 2. HTTP 端点（webServer.register，exact path）

`/plugins/dsh-agents/advisor` —— 形态照 `lib/http-config.js`：回环地址 + Origin 同源双重防护；JSON 出入参。

### GET

```json
{
  "ok": true,
  "enabled": false,
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "modelSource": "HIGH",
  "catalog": { "<provider>": ["<model>", "..."] },
  "runtime": { "status": "disabled|idle|reviewing|error", "lastAt": 0, "queue": 0, "error": null },
  "records": [
    { "id": "…", "sessionId": "…", "sessionName": "…", "severity": "concern",
      "text": "…", "createdAt": 0, "outcome": "steer|inject|recorded|dropped" }
  ]
}
```

`records` 按 `createdAt` 倒序，最多 `advisorPersistLimit` 条。

### PATCH

请求 `{ enabled?: boolean, provider?: string, model?: string }`（至少一个键）。
- 非法形状（未知键、空字符串、provider/model 单给其一）→ **400 + `{error}`**
- provider/model 双给 → 写入并置 `modelSource:'config'`
- 写盘落 `<advisorDataDir>/config.json`（不扩展宿主 settings schema）
- 成功返回与 GET 同形载荷

### POST

请求 `{ action: 'review', sessionId: '<id>' }` → 手动触发一次评审。
响应 `{ ok: true, triggered: true }` 或 `{ ok: false, reason: 'disabled|busy|no-session' }`（HTTP 200，不抛错）。

## 3. 客户端 slot

- slot name：`conversation.session.header.actions`（宿主已确认存在，jobs / subagent / agent-team / agent-preset 都在用）
- id：`dsh-agents-advisor`；order：`80`
- props = `inject()` 返回值（形状自定，参考 `dsh-client-ui-jobs/lib/client.js:610` 的注册范式与 `PropsRuntime` 类型）
- UI：贴右边缘的 capsule（纵向可拖、位置持久化到 localStorage）→ 点击开合右侧停靠面板（`createPortal` 到 `document.body`）

## 4. 记录字段（两席共用，不许各造一套）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定唯一 |
| `sessionId` | string | 主会话 |
| `sessionName` | string | 展示名，可为 null |
| `severity` | `'info'\|'nit'\|'concern'\|'blocker'` | 分级 |
| `text` | string | 意见正文，单条 ≤200 字 |
| `createdAt` | number | epoch ms |
| `outcome` | `'steer'\|'inject'\|'recorded'\|'dropped'` | 实际投递通道 |

## 5. 投递语义（指导工作进行）

```
info      + advisorInfoInject=false → recorded（面板可见，主会话不打扰）
info      + advisorInfoInject=true  → inject（永不 steer）
nit/concern/blocker ∈ steerSeverities 且不在冷却 → steer（实时打断指导）
同上但 severity 不在列表 或 处于 advisorImmuneTurns 冷却窗口 → inject
缺 agent（无 steer/inject）→ dropped + 日志告警
```

消息形态：`user-role` 消息 + `source.kind='advisor'` + `notice` form + summary。
agent 注册表：`agent/created` 时 `agents.set(agent.id, agent)`（`agent.id === session.id`），`agent/disposed`/`session/disposed` 时注销；兜底 `ctx.agents?.get(sessionId)`。

## 6. 评审触发时机（observer）

两种模式，会话一旦发过任意 `turn/end` 即闩锁为标准模式：

1. **标准 stepped 会话**：可评审 `turn/end`（`reason.kind ∈ completed|max-tokens|error`），且必须是**最新进入过 `step/start` 的** turn（用户掐断的回合不评审）。
2. **agentic / harness 会话**（从不发 `turn/end`）：人类输入到达（`user/message` 且 `source.kind==='user'`，或 `agent/inbox/spliced` 含 user 消息）**且**存在未评审的 assistant 增量 → 评审（`skipLast` 排除触发输入本身）。

投影回退（`messages.length < cursor`）或可见重写（`compact/*`、非 append 的 `surfaceOp`）→ 全量重放 + 重置冷却。

## 7. 评审提示词输出契约

要求模型输出**严格 JSON**：

```json
{ "notes": [ { "severity": "concern", "text": "…" } ] }
```

- 解析失败 → 记 `runtime.status='error'`，不投递，不吞错（写日志并落一条 error 记录）
- 单轮最多 `advisorMaxMessages` 条可见消息入窗
- 评审员持续会话按消息粒度追加，上下文**只属于 advisor**

## 8. 文件所有权（防冲突）

| 席 | 可改 | 禁碰 |
|---|---|---|
| 服务端 | `lib/advisor/**`（新建）、`lib/index.js`（仅装配段）、`cordis.patch.yml`（仅 advisor* 键）、`tests/advisor-*.test.mjs`、`tests/run.mjs`（仅注册新测试） | `lib/client.js` |
| 客户端 | `lib/client.js`（仅此一个文件） | `lib/advisor/**`、`lib/index.js`、`cordis.patch.yml`、服务端测试 |

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