---
name: skill-stocktake
description: "触发：盘点技能、技能审查、技能质量、该退休哪些技能、技能库存｜English: skill stocktake, audit skills, skill quality review｜技能质量盘点（auditing Claude skills for quality 的 DSH 版）：对 DSH 技能库（四根扫描）做 Quick Scan（仅变更技能）与 Full Stocktake 全盘两模式，批评席子会话按检查表+整体判断给五态裁决（Keep/Improve/Update/Retire/Merge into [X]），判定理由必须自含证据可决策；results.json 缓存+断点续跑。中文触发：盘点技能、技能审查、技能质量、skill 盘点、库存盘点、retire 技能。English triggers: skill stocktake, audit skills, skill quality review, quick scan."
---

# skill-stocktake（技能质量盘点 · DSH 版）

对 DSH 技能库做质量盘点的命令式流程：质量检查表 + 整体 AI 判断。两模式：Quick Scan（仅自上次运行以来变更的技能）与 Full Stocktake（全盘）。

## 范围与扫描根

盘点目标为 **DSH 四根**（优先级降序）：

| 根 | 说明 |
|---|---|
| `<项目>/.dsh/skills/` | 项目级技能（目录存在时） |
| `<项目>/.agents/skills/` | 项目级技能（目录存在时） |
| `~/.dsh/skills/` | 用户级技能 |
| `~/.agents/skills/` | 用户级技能（skill_manage 库默认位） |

Phase 1 开工时必须**显式列出**找到了哪些根、各扫到多少文件（:21 原文纪律："At the start of Phase 1, the command explicitly lists which paths were found and scanned."）。要盘点特定项目，就在该项目根目录发起；项目无技能目录时只盘用户级（:32 语义对应）。

## 模式

| 模式 | 触发 | 时长 |
|------|---------|---------|
| Quick Scan | `results.json` 存在（缺省） | 5–10 min |
| Full Stocktake | `results.json` 不存在，或显式 `full` | 20–30 min |

Results 缓存：`<项目>/agent-out/skill-stocktake-results.json`（缓存与断点续跑语义保留，C 改造点④）。

## Quick Scan 流程

只重评自上次运行以来变更的技能（5–10 min）：

1. 读 results 缓存；
2. 对四根做 mtime diff；
3. diff 为空 → 报告「自上次运行以来无变更」并停止；
4. 只用 Phase 2 同一标准重评变更件；
5. 未变更技能结转上次结果；
6. 只输出 diff；
7. 把结果写回 results 缓存。

## Full Stocktake 流程

### Phase 1 — 盘点

扫描四根：枚举技能文件、提取 frontmatter、收集 mtime。呈现扫描摘要与库存表，格式对齐 ECC 原文（找到/未找到逐根标注）：

```
Scanning:
 ✓ ~/.dsh/skills/ (N files)
 ✓ ~/.agents/skills/ (N files)
 ✗ <项目>/.dsh/skills/ (not found — 用户级 only)
```

库存表——ECC 原表头保留如下（:74-75 原文）：

```markdown
| Skill | 7d use | 30d use | Description |
|-------|--------|---------|-------------|
```

### Phase 2 — 质量评价

启动批评席子会话，携带完整库存与检查表：
- [ ] Freshness of technical references verified (use WebSearch if tool names / CLI flags / APIs are present)
- [ ] Usage frequency considered
```

裁决判据：

| Verdict | Meaning |
|---------|---------|
| Keep | Useful and current |
| Improve | Worth keeping, but specific improvements needed |
| Update | Referenced technology is outdated (verify with WebSearch) |
| Retire | Low quality, stale, or cost-asymmetric |
| Merge into [X] | Substantial overlap with another skill; name the merge target |

评价是**整体 AI 判断**，不是数值打分（:126 原文纪律）。导向维度四条（:126-130 保留）：Actionability（有能立即行动的代码/命令/步骤）、Scope fit（名称/触发/内容对齐，不宽不窄）、Uniqueness（价值不可被 AGENTS.md/记忆/其他技能替代）、Currency（技术引用在当前环境可用）。

**判定理由质量要求（承重段，勿改写）**：

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

### Phase 3 — 汇总表

ECC 原表头保留（:149）：

```markdown
| Skill | 7d use | Verdict | Reason |
|-------|--------|---------|--------|
```

### Phase 4 — 处置

1. **Retire / Merge**：逐文件给出详尽论证后再向用户确认：发现了什么具体问题（重叠/过时/引用失效等）；什么替代物覆盖同一需求（Retire 指到既有技能/规则，Merge 指到目标文件与要整合的内容）；移除的影响面（依赖技能、AGENTS.md/记忆引用、受影响工作流）。
2. **Improve**：给出具体改进建议与理由（如「430→200 行，因 X/Y 节与某技能重复」）；用户决定是否执行。
3. **Update**：给出核验过来源的更新内容。
4.检查 AGENTS.md/记忆轨规模，超限提议压缩。

归档/删除操作永远需要用户显式确认（:194 原文纪律）。

## Results 文件模式

`evaluated_at` 必须是评价完成时刻的真实 UTC 时间（ECC :168-169 原文纪律：经命令取 `date -u +%Y-%m-%dT%H:%M:%SZ` 形态，**不得**用 `T00:00:00Z` 一类日期近似值充数。）：

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

## Notes

- 评价是盲评：同一检查表适用于所有技能，不论来源（ECC、自研、自动提取）
- 归档/删除操作永远需要用户显式确认
- 不按技能来源分支裁决
