---
name: skill-stocktake
description: "触发：盘点技能、技能审查、技能质量、该退休哪些技能、技能库存｜English: skill stocktake, audit skills, skill quality review｜技能质量盘点（auditing Claude skills for quality 的 DSH 版）：对 DSH 技能库（四根扫描）做 Quick Scan（仅变更技能）与 Full Stocktake 全盘两模式，批评席子会话按检查表+整体判断给五态裁决（Keep/Improve/Update/Retire/Merge into [X]），判定理由必须自含证据可决策；results.json 缓存+断点续跑。ECC 原文：Use when auditing Claude skills and commands for quality. Supports Quick Scan (changed skills only) and Full Stocktake modes with sequential subagent batch evaluation.【适配：扫描根 ~/.claude/skills → DSH 四根；「7d/30d 使用」列无数据源显式降级 mtime/hit-stats 说明】中文触发：盘点技能、技能审查、技能质量、skill 盘点、库存盘点、retire 技能。English triggers: skill stocktake, audit skills, skill quality review, quick scan."
---

<!-- DSH-ADAPT-HEADER BEGIN（移植层新增块。B 档语义=承重段重写后落地：非 A 档全量保真；承重段逐条对应 ECC 原文（锚点 file:line + 原文引句在位），五态裁决 JSON 与判定理由质量要求为逐字保留段。源冻结 sha256-16 见 metadata.ecc-source）

metadata:（ECC frontmatter 散字段收编于此——DSH frontmatter 契约仅 name+description）
  origin: ECC
  ecc-source: ecc-analysis/src/ECC-main/skills/skill-stocktake/SKILL.md（ECC v2.2.2，sha256-16 AA8F287C48C5A33B，195 行 + 3 个 bash 脚本）
  ported: IMP-17③ · P1 · ecc-analysis batch2 → staging/skill-stocktake/

## ECC→DSH 适配映射表（宿主设施 → DSH 原语）

| ECC 宿主设施（锚点） | DSH 对位 |
|---|---|
| 扫描根 `~/.claude/skills/` + `{cwd}/.claude/skills/`（:14-19） | 【适配（C 改造点①）：DSH 四根，优先级降序=项目 `.dsh/skills`、项目 `.agents/skills` → 用户 `~/.dsh/skills` → 用户 `~/.agents/skills`（本机技能根扫描 rank 实证口径）】 |
| `/skill-stocktake` 斜杠命令（:10） | 技能直调：用户点名「盘点技能/技能质量审查/stocktake」触发，无独立命令 |
| `results.json` 缓存 `~/.claude/skills/skill-stocktake/results.json`（:41, :47, :166） | 【适配：`<项目>/agent-out/skill-stocktake-results.json`（或任务书指定路径）；缓存与断点续跑语义原样保留（C 改造点④）】 |
| scripts/scan.sh / quick-diff.sh / save-results.sh（:48, :55, :62，ECC bash 脚本不随技能分发） | 【适配：pwsh 只读扫描等价——Get-ChildItem 枚举四根 SKILL.md + frontmatter 解析 + LastWriteTime(mtime)；diff=与 results.json 记录的 mtime 比对；断点=results.json 的 batch_progress.status 字段】 |
| `7d use` / `30d use` 列（:74-75, :149） | 【适配（C 改造点②）**skipped 声明**：ECC 版频次依赖 `~/.claude/observations.jsonl` 使用日志，DSH 无对应数据源——该两列无频次数据，显式降级为 mtime（+可选记忆侧车 hit-stats 且必须标注「命中计数≠使用频次」）；不得呈现任何伪装的使用频次数字】 |
| Agent tool `subagent_type="general-purpose"`（:79-95） | 【适配（C 改造点③）：de_session spawn 批评席子会话；角色/档位按组织者任务书与档位路由表（2026-09-26 用户新规：禁越档显式指定 provider+model，spawn 前先跑 agent_roles action=tiers）】 |
| MEMORY.md / CLAUDE.md（重叠检查 :111、唯一性 :129、行数 :162） | 【适配：~/.dsh/AGENTS.md + 项目 AGENTS.md + 记忆轨（memory/user/key）】 |
| WebSearch（:112 新鲜度核验） | 【适配：web_search 工具】 |
| 归档/删除需用户确认（:194） | 【适配：DSH 侧一致——skill 目录整目录删除即回滚（技能目录实时失效重发布）；记忆类归档走 memory archive 语义】 |
| 连续批评席分块（:101） | 【适配：de_session spawn 逐块派发，每块 ~20 技能；并发纪律按组织者任务书（错峰启动）】 |

## 承重段锚点总表（本件四个承重段）

| 承重段 | ECC 锚点 | 落位 |
|---|---|---|
| 五态裁决 | :99（判据表 :116-124） | 正文「Phase 2」JSON **逐字保留** |
| 判定理由质量要求 | :132-145（C 报告引证 :112 为检查表新鲜度项，原位保留于检查表） | 正文「判定理由质量要求」**全量逐字保留** |
| 「7d/30d 使用」列降级 | :74-75、:149（ECC 原表头保留 + skipped 声明） | 正文「Phase 1」「Phase 3」 |
| 断点续跑/缓存机制 | :41, :47, :101-105, :164-189 | 正文「模式」「Phase 2」「Results 文件模式」 |

-->

# skill-stocktake（技能质量盘点 · DSH 版）

对 DSH 技能库做质量盘点的命令式流程：质量检查表 + 整体 AI 判断。两模式：Quick Scan（仅自上次运行以来变更的技能）与 Full Stocktake（全盘）。【适配：定位——与 memory-consolidate（面向记忆）、plugin-security-review（面向安装审查）互补，技能质量盘点在 DSH 侧当前是空白（C 报告 B-9 重叠判定）；评价是盲评：同一检查表适用于所有技能，不按来源（ECC/自研/自动提取）分支（:193, :195 原文纪律）】

## 范围与扫描根（ECC :12-32 重写）

盘点目标为 **DSH 四根**（优先级降序）：

| 根 | 说明 |
|---|---|
| `<项目>/.dsh/skills/` | 项目级技能（目录存在时） |
| `<项目>/.agents/skills/` | 项目级技能（目录存在时） |
| `~/.dsh/skills/` | 用户级技能 |
| `~/.agents/skills/` | 用户级技能（skill_manage 库默认位） |

Phase 1 开工时必须**显式列出**找到了哪些根、各扫到多少文件（:21 原文纪律："At the start of Phase 1, the command explicitly lists which paths were found and scanned."）。要盘点特定项目，就在该项目根目录发起；项目无技能目录时只盘用户级（:32 语义对应）。

## 模式（ECC :34-41 保留）

| 模式 | 触发 | 时长 |
|------|---------|---------|
| Quick Scan | `results.json` 存在（缺省） | 5–10 min |
| Full Stocktake | `results.json` 不存在，或显式 `full` | 20–30 min |

Results 缓存：【适配】`<项目>/agent-out/skill-stocktake-results.json`（缓存与断点续跑语义保留，C 改造点④）。

## Quick Scan 流程（ECC :43-56 重写）

只重评自上次运行以来变更的技能（5–10 min）：

1. 读 results 缓存；
2. 对四根做 mtime diff（ECC 原版跑 quick-diff.sh，【适配】脚本不分发 → pwsh 只读比对：当前 mtime vs results.json 记录的 mtime）；
3. diff 为空 → 报告「自上次运行以来无变更」并停止；
4. 只用 Phase 2 同一标准重评变更件；
5. 未变更技能结转上次结果；
6. 只输出 diff；
7. 把结果写回 results 缓存。

## Full Stocktake 流程

### Phase 1 — 盘点（ECC :60-75 重写）

扫描四根：枚举技能文件、提取 frontmatter、收集 mtime（ECC 原版跑 scan.sh，【适配】pwsh 只读等价命令）。呈现扫描摘要与库存表，格式对齐 ECC 原文（找到/未找到逐根标注）：

```
Scanning:
  ✓ ~/.dsh/skills/         (N files)
  ✓ ~/.agents/skills/      (N files)
  ✗ <项目>/.dsh/skills/    (not found — 用户级 only)
```

库存表——ECC 原表头保留如下（:74-75 原文）：

```markdown
| Skill | 7d use | 30d use | Description |
|-------|--------|---------|-------------|
```

【适配（C 改造点②）· skipped 声明（验收④，不得假装有频次数据）：ECC 版的 7d/30d 使用频次列依赖 `~/.claude/observations.jsonl` 使用日志——**DSH 无对应数据源**。DSH 版表头显式降级为：

```markdown
| Skill | mtime | Description |
|-------|-------|-------------|
```

mtime=最后修改时间（UTC）。记忆侧车 hit-stats（若该技能关涉的记忆条目有接入）只能作参考，且必须标注「命中计数≠使用频次」。任何输出中都不得呈现伪装的使用频次数字——本声明即该数据缺失的正式 skipped 记录：skipped（7d/30d 频次统计）+ 原因（无 observations.jsonl 对应数据源）+ 复跑条件（DSH 侧建立技能使用计数数据源后可恢复该列）】

### Phase 2 — 质量评价（ECC :77-145 重写 + 逐字保留段）

启动批评席子会话，携带完整库存与检查表：【适配（C 改造点③）ECC 原版 `Agent(subagent_type="general-purpose", …)` → `de_session spawn` 批评席子会话；分块 ~20 技能/批评席（:101 原文纪律，控制上下文）；每块评完即把中间结果写入 results 缓存（`status: "in_progress"`）；全部评完置 `status: "completed"` 进 Phase 3；启动时发现 `in_progress` 则从首个未评技能断点续跑（:103-105 原文机制保留）。批评席返回每技能 JSON——**五态裁决逐字保留如下（ECC :99 原文）**：

```text
{ "verdict": "Keep"|"Improve"|"Update"|"Retire"|"Merge into [X]", "reason": "..." }
```

每技能对照检查表（ECC :109-114 原文保留，适配行内标注）：

```
- [ ] Content overlap with other skills checked
- [ ] Overlap with MEMORY.md / CLAUDE.md checked 【适配：→ AGENTS.md（全局/项目）+ 记忆轨（memory/user/key）】
- [ ] Freshness of technical references verified (use WebSearch if tool names / CLI flags / APIs are present) 【适配：WebSearch → web_search 工具】
- [ ] Usage frequency considered 【适配：DSH 无使用频次数据源——本项降级为 mtime 陈旧度 + 触发词冲突检查作代理信号，不得编造频次】
```

裁决判据（ECC :116-124 原文保留）：

| Verdict | Meaning |
|---------|---------|
| Keep | Useful and current |
| Improve | Worth keeping, but specific improvements needed |
| Update | Referenced technology is outdated (verify with WebSearch) |
| Retire | Low quality, stale, or cost-asymmetric |
| Merge into [X] | Substantial overlap with another skill; name the merge target |

评价是**整体 AI 判断**，不是数值打分（:126 原文纪律）。导向维度四条（:126-130 保留）：Actionability（有能立即行动的代码/命令/步骤）、Scope fit（名称/触发/内容对齐，不宽不窄）、Uniqueness（价值不可被 AGENTS.md/记忆/其他技能替代）、Currency（技术引用在当前环境可用）。

【适配（C 改进点②）增列 DSH 特有裁决考量：**触发词与既有技能冲突**——两技能 description 触发词高度重叠时，按 Merge into [X]（写明目标）或 Improve（写明收窄哪个触发面）处置，理由必须点名冲突技能与冲突触发词。】

**判定理由质量要求（承重段 · ECC :132-145 全量逐字保留）**：

```
**Reason quality requirements** — the `reason` field must be self-contained and decision-enabling:
- Do NOT write "unchanged" alone — always restate the core evidence
- For **Retire**: state (1) what specific defect was found, (2) what covers the same need instead
  - Bad: `"Superseded"`
  - Good: `"disable-model-invocation: true already set; superseded by continuous-learning-v2 which covers all the same patterns plus confidence scoring. No unique content remains."`
- For **Merge**: name the target and describe what content to integrate
  - Bad: `"Overlaps with X"`
  - Good: `"42-line thin content; Step 4 of chatlog-to-article already covers the same workflow. Integrate the 'article angle' tip as a note in that skill."`
- For **Improve**: describe the specific change needed (what section, what action, target size if relevant)
  - Bad: `"Too long"`
  - Good: `"276 lines; Section 'Framework Comparison' (L80–140) duplicates ai-era-architecture-principles; delete it to reach ~150 lines."`
- For **Keep** (mtime-only change in Quick Scan): restate the original verdict rationale, do not write "unchanged"
  - Bad: `"Unchanged"`
  - Good: `"mtime updated but content unchanged. Unique Python reference explicitly imported by rules/python/; no overlap found."`
```

【适配：上块例句中的技能名为 ECC 库实例（continuous-learning-v2 等），DSH 侧运行时把例句当**格式范本**照抄结构即可；纪律原样：reason 必须自含证据、能支撑决策，禁止一言以蔽之】

### Phase 3 — 汇总表（ECC :147-150 重写）

ECC 原表头保留（:149）：

```markdown
| Skill | 7d use | Verdict | Reason |
|-------|--------|---------|--------|
```

【适配：同 Phase 1 的 skipped 声明——「7d use」列无数据源，DSH 版输出为 `| Skill | mtime | Verdict | Reason |`；不得伪造频次】

【适配（C 改进点③）：与 skill-scout 的「先查→后审→再建」闭环——skill-scout 属 B 档按需池（B-10，P2）**尚未移植**；移植后在此衔接其搜索步骤，当前本件止于盘点与处置建议】

### Phase 4 — 处置（ECC :152-162 保留）

1. **Retire / Merge**：逐文件给出详尽论证后再向用户确认：发现了什么具体问题（重叠/过时/引用失效等）；什么替代物覆盖同一需求（Retire 指到既有技能/规则，Merge 指到目标文件与要整合的内容）；移除的影响面（依赖技能、AGENTS.md/记忆引用、受影响工作流）。
2. **Improve**：给出具体改进建议与理由（如「430→200 行，因 X/Y 节与某技能重复」）；用户决定是否执行。
3. **Update**：给出核验过来源的更新内容。
4. 【适配】检查 AGENTS.md/记忆轨规模，超限提议压缩（ECC 原文为 MEMORY.md >100 行提议压缩，DSH 对位为全局记忆条目膨胀时的 memory-consolidate 处理）。

归档/删除操作永远需要用户显式确认（:194 原文纪律）。

## Results 文件模式（ECC :164-189 保留 + 路径适配）

`evaluated_at` 必须是评价完成时刻的真实 UTC 时间（ECC :168-169 原文纪律：经命令取 `date -u +%Y-%m-%dT%H:%M:%SZ` 形态，**不得**用 `T00:00:00Z` 一类日期近似值充数。【适配：pwsh 侧 `[DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")`】）：

```json
{
  "evaluated_at": "2026-02-21T10:00:00Z",
  "mode": "full",
  "batch_progress": {
    "total": 80,
    "evaluated": 80,
    "status": "completed"
  },
  "skills": {
    "skill-name": {
      "path": "~/.agents/skills/skill-name/SKILL.md",
      "verdict": "Keep",
      "reason": "Concrete, actionable, unique value for X workflow",
      "mtime": "2026-01-15T08:30:00Z"
    }
  }
}
```

【适配：`path` 示例已按 DSH 四根改写；schema 其余字段与断点续跑语义逐字保留】

## Notes（ECC :191-195 保留）

- 评价是盲评：同一检查表适用于所有技能，不论来源（ECC、自研、自动提取）
- 归档/删除操作永远需要用户显式确认
- 不按技能来源分支裁决
