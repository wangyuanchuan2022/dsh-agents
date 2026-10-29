# 档位别名契约（正本 · 字节级 enforced）

> 本文件是**契约正本**，不是说明文档：`tools/alias-contract-gate.mjs` 直接解析本文件的
> 「别名映射表」与「例外登记表」两节，并对两节正文取 sha256 与
> `tests/fixtures/alias-contract.sha256.json` 比对（A5）。**改契约必须同步改 fixture**，
> 否则闸门变红——这是「文档改了没人知道」的机器防线。
>
> 复跑命令：
> ```
> node tools/alias-contract-gate.mjs            # 正常跑：A1–A6 全绿 exit 0，任一红 exit 1
> node tools/alias-contract-gate.mjs --selftest # 变异自测：6/6 达预期 exit 0
> node tools/alias-contract-gate.mjs --print-hashes  # 只打印两节正文 sha256（改契约后取新值用）
> ```

## 0. 要解决的问题（上游教训原文）

routing-suite 的实证教训：别名文件与带版本文件**自述「保持同步」，实测 SHA256 全不同**——
4 对字节漂移，而没有任何机制发现它（原文见 `agent-out/routing-suite-full-read.md:84`：
「**C 组小结——「别名=当前版」同步契约三重失守**：① AGENTS.md 自述「无版本别名==带版本文件（一致）」；
② archive/probe 两个 README 也自述「与带版本号文件保持同步」；③ 实测 SHA256：4 对漂移」）。

本仓同构风险：档位别名在**四处**各有一份表述，任一处漂移都不会被既有测试发现：

| # | 载体 | 位置 | 由哪条闸门看管 |
|---|---|---|---|
| 1 | 代码常量 `TIER_ALIASES` / `TIERS` / `normalizeTier` | `lib/roles.js:50-56`、`:206-209` | A1 |
| 2 | 每个角色的 `tier` 与 `omcModel` 两字段 | `lib/roles.js` 23 条角色定义 | A2 |
| 3 | 人格文件 frontmatter `omc_model:` | `personas/<id>.md` 23 份 | A3 |
| 4 | 文档表述（README 别名句 + 文档面未登记别名） | `README.md:46`、`:225` 等 | A4 |
| — | 本契约自身（映射表 + 例外表正文） | 本文件 | A5（字节级指纹） |

## 一、别名映射表（正本）

语义：**别名 → 目标档位**；括号内为方向说明。`normalizeTier()` 对**规范档名自身**同样成立
（`normalizeTier('LOW') === 'LOW'`），故六条映射构成双向一致的闭合表。

| 别名 | 目标档位 | 说明 |
|---|---|---|
| `low` | `LOW` | 规范档名自身映射（小写形态） |
| `medium` | `MEDIUM` | 规范档名自身映射（小写形态） |
| `high` | `HIGH` | 规范档名自身映射（小写形态） |
| `haiku` | `LOW` | OMC Claude 家族名（底本 `model: haiku`） |
| `sonnet` | `MEDIUM` | OMC Claude 家族名（底本 `model: sonnet`） |
| `opus` | `HIGH` | OMC Claude 家族名（底本 `model: opus`） |

约束（A1 逐条机检）：

1. 上表每一行的 `目标档位` 必须等于 `TIER_ALIASES[别名]` 且等于 `normalizeTier(别名)`；
2. 上表别名集合必须与 `TIER_ALIASES` 的键集合**相等**（多一个少一个都红）；
3. 三个规范档名自身 `normalizeTier(tier) === tier`；
4. `TIERS` 的值域集合与 `TIER_ALIASES` 的值域集合必须**相等**；
5. 闸门对 `normalizeTier` 的建模必须与 `lib/roles.js` 导出的真实函数逐键一致（防闸门自说自话）。

## 二、例外登记表

契约不是「全部相等」，是「**相等，或出现在带理由的例外表里**」。下列条目是**有记录的裁决结果**，
不是 bug：`tier` 按 DSH 侧复杂度定档，`omcModel` 保留 OMC 底本的家族名，两者在裁决上调后不再相等。
**禁止**通过修改 `lib/roles.js` 抹平差异来让闸门变绿——契约的做法是登记例外。

| 角色 id | tier | omcModel | 理由 | 裁决依据 |
|---|---|---|---|---|
| `harness-optimizer` | `HIGH` | `sonnet` | 底本 model: sonnet，批次3 裁决上调 HIGH（跨配置/评测/安全三面，需长链条评测设计能力）；例外 = 家族名保留底本、DSH 档位按复杂度上调 | 批次3 IMP-25 裁决；`lib/roles.js:107` 注释原文 |
| `rag-reviewer` | `HIGH` | `sonnet` | 底本 model: sonnet，DP-7 裁决上调 HIGH（检索质量与评测覆盖双面评审属长链条推理）；例外 = 家族名保留底本、DSH 档位按复杂度上调 | DP-7 裁决；`lib/roles.js:148` 注释原文 |

约束（A2 逐条机检）：

1. 每个角色：`normalizeTier(role.omcModel) === role.tier`，**或**该 id 在上表且该行**理由非空**；
2. 上表出现 `lib/roles.js` 里不存在的角色 id ⇒ 红（防陈旧例外：角色被删/改名后例外残留）；
3. 上表的 `tier` / `omcModel` 两列必须与 `lib/roles.js` 该角色**当前**字段逐字相等 ⇒ 否则红（防例外行描述已过期）；
4. 上表登记了「实际已相等」的角色 ⇒ 红（冗余例外同样陈旧：说明例外已不再需要，应删除该行而不是长期挂着）。

## 三、契约指纹与漂移处置流程

### 3.1 指纹口径（A5）

- 对象：本文件「一、别名映射表（正本）」与「二、例外登记表」两节的**正文**（节标题行之后的全部行，
  到下一个二级标题 `## ` 之前为止）。
- 归一化：`CRLF → LF`（本仓 `core.autocrlf=true`，检出会改写行尾；不归一化会让指纹随检出环境假红），
  再去掉该节**末尾的空行**（节间排版不构成契约语义）。节内其余字符、空白、标点一律逐字计入。
- 摘要：`sha256(归一化正文)` 取**前 8 位十六进制大写**（与 `tests/fixtures/b2-help-archive.sha256.json` 同一形态）。
- fixture：`tests/fixtures/alias-contract.sha256.json`，两个键 `aliasMappingTable` / `exceptionRegistry`。
  fixture 缺失、JSON 非法、`algorithm`/`digestPrefix`/`digestCase` 不符、键缺失或值不合 `^[0-9A-F]{8}$` ⇒ **fail-closed 红**。

### 3.2 改契约 SOP（三步，缺一即红）

1. 改本文件对应节正文（只改该改的那一行，别顺手重排表格）；
2. 取新指纹：`node tools/alias-contract-gate.mjs --print-hashes`，把输出写进 fixture 对应键；
3. 复跑 `node tools/alias-contract-gate.mjs`（全绿）+ `node tools/alias-contract-gate.mjs --selftest`（6/6）。

### 3.3 漂移处置矩阵

| 漂移现象 | 闸门 | 处置 |
|---|---|---|
| `TIER_ALIASES` 某别名指向错档（如 `opus: 'MEDIUM'`） | A1 | 改**代码**回契约，不是改契约迁就代码；若确需换语义，先走 3.2 改契约 + 登记理由 |
| `TIERS` 与 `TIER_ALIASES` 值域不一致 | A1 | 补齐缺失档位或删除多余值，两侧同步 |
| 角色 `tier`/`omcModel` 不相等且不在例外表 | A2 | 二者择一：改字段回一致，或**登记例外**并写明裁决依据（不许静默改 `lib/roles.js` 抹平） |
| 例外表指向已不存在的角色 / 描述已过期 / 已不再需要 | A2 | 删除或更新该行；**不要**留着「以防万一」 |
| 人格 `omc_model:` 与角色 `omcModel` 不逐字相等 | A3 | 改人格 frontmatter（人格是派生面，角色字段是正本） |
| README 别名句与契约不一致 / 文档出现未登记别名 | A4 | 改文档回契约；新增别名必须先走 A1 契约变更（映射表 + fixture 同步） |
| 契约正文改了但 fixture 没改 | A5 | 按 3.2 取新指纹；**禁止**为了变绿而回退契约正文 |
| 闸门读不到文件 / 解析出 0 条 | A6 | fail-closed：先修文件/解析，绝不允许「没查到 = 没问题」 |

### 3.4 诚实边界（本契约不覆盖什么）

- 本契约只管**别名 ↔ 档位**这一条链，不管 `tier → provider+model` 的实际映射（那是配置，见
  `cordis.patch.yml` 与 `agent_roles action=tiers`，会随环境变化，不适合字节级冻结）。
- A3 只比对 `omc_model:` 一行，不校验人格正文（正文哈希另有 `body_hash` 机制）。
- A4 的文档面 = `README.md` + `docs/*.md` + `ARCHITECTURE.md`，**排除**本契约自身
  （它是 A1/A2/A5 的机检对象，自扫描会自指）与 `CHANGELOG.md`（历史记录，不改写过去）。
- 闸门只证明「四处表述一致」，**不证明**某档位配的模型适合该角色——那是档位设计评审的事。

## 四、闸门与变异自测（A1–A6）

| 门 | 断言 |
|---|---|
| A1 | 别名双向一致：映射表 ↔ `TIER_ALIASES` ↔ `normalizeTier` ↔ `TIERS` 值域四向闭合 |
| A2 | 角色字段一致：`normalizeTier(omcModel) === tier`，或带非空理由的已登记例外；例外无陈旧/冗余 |
| A3 | 人格一致：`personas/<id>.md` 的 `omc_model:` 逐字等于角色 `omcModel`，23/23 全查 |
| A4 | 文档表述一致：README 别名句与契约同向，文档面无未登记别名 |
| A5 | 契约指纹：两节正文 sha256 前 8 位大写 == fixture（缺失/格式错 fail-closed） |
| A6 | 零命中防护：解析出的别名条数/角色条数/人格条数/README 别名句条数为 0 ⇒ 红 |

`--selftest` 变异体（**内存构造，不写盘**，各自精确变红、原样全绿）：

1. `TIER_ALIASES` 里 `opus` 改指 `MEDIUM` ⇒ A1 红；
2. 删掉一个例外表的理由 ⇒ A2 红；
3. 某人格 `omc_model` 改成 `opus` ⇒ A3 红；
4. 文档里塞一个未登记别名（`opus4`）⇒ A4 红；
5. 改契约正文但不动 fixture ⇒ A5 红；
6. `TIER_ALIASES` 删空 ⇒ A1 + A6 红。

## 五、已知边界与待组织者裁定

- 本契约的两条例外是**批次3 与 DP-7 的裁决结果**，本席按设计只登记、不裁定、不改 `lib/roles.js`。
- 若组织者认为例外不应长期存在（即应把 `omcModel` 也改成 `opus`），需先改 `lib/roles.js` 并重跑本闸门，
  再删除例外行 + 按 3.2 重取指纹——这属于裁决变更，不在本契约自行处置范围内。
