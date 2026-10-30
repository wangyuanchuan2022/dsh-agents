# 项目全景（PROJECT STATUS）

> **本文给 advisor 与零上下文接手者**：读这一份就知道「这项目要干什么、现在到哪、下一步做什么」。
> **硬约束：全文 ≤ 100 行**——advisor 的 `read_file` 输出上限是 100 行（`lib/advisor/aci/observation.js:18`），
> 超了它读不全等于没有。**更新时机**：每批次关账时（与 CHANGELOG 同步），并改下面这行。
> 最后更新：2026-10-29 · `master@a338eb5`

## 1. 这是什么

**dsh-agents 是一个 DSH 插件**，把「多智能体编排」固化成机制：**23 个专职角色 × 三档模型路由（LOW/MEDIUM/HIGH）×
一次调用合成完整任务书**，外加 25 个工作流技能、24 个确定性机检工具、三道测试链。

对外的三个宿主工具（`lib/index.js` 注册，只有这三个）：`agent_roles`（查角色/档位目录）、
`agent_taskbook`（合成七节任务书全文，**只合成不派活**）、`agent_spawn`（建子会话 + 派任务书；
`personaMode='role'` 走角色库，`'minimal'` 走极简四行 brief）。

内建的 **advisor 顾问**是被动机制：每 turn 结束后自动评审主会话（模型与会话级手动指定、无任何兜底），
**不占上面三个工具位、不设 advisor\* 工具**。契约正本 `docs/advisor-contract.md`。

## 2. 当前进度（R3 批次，2026-10-26 → ）

用户里程碑指令：「**当所有 Dsh routing suit 的特性都集成完毕之后，进行一轮消融实验**」（原文见 §6）。

| 批次 | 内容 | 状态 |
|---|---|---|
| R3-A | R2 免费段整合 8 项（档位差异化任务书 / 静态远场布局 / 净注入门 / session-guard / usage-probe / body_hash 门 / 设计原则正本 / 衰减测量） | ✅ |
| R3-B0 | 死重清除（人格原生化收尾 + 任务书 §八 CC 工具映射节删除） | ✅ |
| R3-B1 | 极简条件人格基座 + per-session 工具面收缩 + 极简回复通道 | ✅ |
| R3-B2 | 二级披露（catalog 首句 + 按需 help + 按会话单授 allowTools） | ✅ `b745068` |
| R3-B3 | 首轮锚定 / 渐进披露 | ⏸ **未开工**（收益评估先行） |
| R3-B4 | M2 档位消融探针（按模型校准任务书） | ⏸ **未开工**（需 API 成本核算书） |
| R3-B5 | 约束结构化审计（提示词纪律 → 结构闸门逐条盘点） | ✅ 44 条 PARTIAL 全量变异实测 |
| R3-B6 | 档位别名契约字节级 enforced | ✅ A1–A6 + sha256 指纹门 |
| R3-B7 | VERIFIABILITY 矩阵交付格式 | ✅ 44 条宣称 × 五列，`--execute` 45/45 |
| R3-C | **消融实验**（集成完毕后的效果评测） | ⏸ **未启动**（前置 B3/B4 + 成本核算书） |

**下一步唯一最重要的事**：B3 / B4 是否开工取决于用户裁决（都在等「收益评估」与「成本核算书」）；
若不做，主线直接进 R3-C 消融实验。

## 3. 关键事实（**G6 值对账**：闸门自己算真值，本文数字必须相等）

| 维度 | 值 | 怎么核 |
|---|---|---|
| 分支 / HEAD | `master` @ `a338eb5` | `git rev-parse --short HEAD` |
| 提交 / 跟踪文件 | 181 / 169 | `git rev-list --count HEAD` / `git ls-files` |
| 角色 / 人格文件 | 23 / 34（23 人格 + 11 评审清单） | `Get-ChildItem personas -Recurse -Filter *.md` |
| 工作流技能 | 25 个 `SKILL.md` | `Get-ChildItem skills -Recurse -Filter SKILL.md` |
| 确定性工具 / 文档正本 | 25 / 8 | `Get-ChildItem tools -File` / `docs` |
| 运行时依赖 | **2**（schemastery + web-tree-sitter@0.27.0，均 MIT） | `package.json` |
| 主测试套件 / `npm test` 门数 | 全绿 / 14 道门 | `node tests/run.mjs` |

## 4. 不可违反的既有决策（违反即 blocker）

1. **advisor 模型完全手动指定、无兜底**——不回落 HIGH 档、不读全局配置、不继承主会话模型；未指定即不评审。
2. **`advisorEnabled`/`advisorProvider`/`advisorModel` 是废弃键**（compatibility-only），但**必须留在 `ALLOWED_KEYS`**——删掉会让老配置触发「未知键」导致**整个插件 boot 失败**。
3. **advisor 只读**：不写文件、不改代码（源码级禁令，不是运行时权限层）。
4. **禁止群发广播**：一次只唤醒一个会话；子会话完成汇报**直投组织者**。
5. **子代理一律走档位路由、禁越档**；spawn 前先 `agent_roles action=tiers` 核对。
6. **不杀用户进程**；23:00–07:00 不做需要用户批准的操作。
7. **装插件/加依赖前必须先 `security_review`**；BLOCK 判定不得安装。
8. **测试失败不得改测试凑绿**——修代码本身；确需改断言须证明原断言过时并留痕。

## 5. 已知限制（如实列出，不藏）

1. `sessionId` 校验是 **liveness check 而非授权**——宿主 WebRoute 无鉴权钩子，同机另一页面可改他人活跃会话的 advisor 配置（用户已知情接受）。
2. advisor「恰好一次」实为**至多一次**：只发工具调用、无可见文本的 turn 会被永久跳过（可手动补评）。
3. advisor 只评审**主会话汇总**，子会话内部 step 与工具执行过程不可见。
4. `agent_spawn` 的 `cwd` 传不存在路径**不报错**（静默当工作区），派完须 `status` + 磁盘双查。
5. `core.autocrlf=true` + `.gitattributes` 为 `* -text`——**「git 干净」≠「字节还原」**，变异还原禁 `git checkout --`。
6. 并行跑两个 `tests/run.mjs` 会 `ENOTEMPTY`（固定路径夹具），并发请错峰。
7. **`docs/DECISIONS.md` 尚不存在** ⇒ advisor 的「决策漂移检测」层每轮报「不可用」，能力空转。

## 6. 去哪找细节（按需检索，不要全量读）

| 想知道 | 读哪 |
|---|---|
| 安装 / 配置 / 已知限制全量 | `README.md` |
| 逐部件职责与接线 | `ARCHITECTURE.md` |
| 每批改了什么（挂 commit 哈希） | `CHANGELOG.md`（Unreleased 节） |
| advisor 行为契约（**改 advisor 前必读**） | `docs/advisor-contract.md` |
| 任务书七节模板 / 提示词纪律 → 闸门对照（108 条款） | `docs/task-brief-v3.md` / `docs/constraint-audit.md` |
| 对外宣称 × 五列证据矩阵 / 档位别名契约 + 例外登记 | `docs/VERIFIABILITY.md` / `docs/alias-contract.md` |
| 今后写代码的判定纪律 | `docs/design-principles.md` |
| **R3 路线图与全部待办** / 开放的决策点 | `agent-out/opt-r3-goals.md` / `agent-out/open-questions.md` |

> `agent-out/`、`review/`、`backup/` 在 advisor 的 walk **排除表**内 ⇒ `list_files`/`search` **看不见**，
> 只有精确路径 `read_file` 能读。要让 advisor 用上某份过程物，必须在提示词里**写明路径**。

## 7. 维护契约（**判据清单已冻结**，见「残余缝」）

**闸门**：`node tools/project-status-gate.mjs --execute`（`npm test` 第 14 道门），**判据冻结为 6 条**：
G1 行数≤100（= `read_file` 上限）/ G2 「最后更新」不早于最近 5 commit / G3 §2 提到 CHANGELOG 最近批次 /
G4 §3 只读命令真能跑 / G6 §3 快变量与闸门自算真值相等 / G5 以上自测 21 例（含阴性对照 + 阳性必红）。
**节奏**：每批次关账由**收尾人与 CHANGELOG 同批**更新，必改 §2 + §3 + 顶部「最后更新」；
超 100 行就**删内容并指向正本**，不放宽上限（放宽须先改 `MAX_TOOL_OUTPUT_LINES`，`PS-2` 会红）。

**残余缝（明确不打算用闸门堵，靠流程）**：① **语义陈旧**——数字全对、但正文对本次变化仍描述过时或敷衍，
机器判不了（**这条不可机器闭合**）；② 判据只覆盖 §3 的 6 个快变量，不覆盖 §2 每行状态真实性；
③ 本门**不校验**「文档与代码是否同一 commit」。
对冲：**文档更新与代码改动必须落同一 commit**（收尾人自查 + reviewer 检查项），这是唯一强制点。
