---
name: session-handoff
description: "DSH 会话交接：把一个会话的工作状态提炼成八节交接文档（What We Are Building / What WORKED·带证据 / What Did NOT Work+确切原因 / What Has NOT Been Tried Yet / Current State of Files / Decisions Made / Blockers & Open Questions / Exact Next Step），供接手会话或新会话全量吸收后继续；含同一目录多份交接文档时的候选排序判据（只对自动发现排序、显式路径直读不替换）。不自建会话存储——DSH 已有 session.jsonl.zstd 全量转录，交接文档只承担「意图与判断层」。Use when 会话上下文快耗尽、跨天续做、把工作移交另一会话或子会话、或接手别人的交接文档。中文触发：交接、会话接续、换会话继续、跨天收工、handoff、接手别人的活、写交接文档。English triggers: session handoff, hand off work to another session, resume from a handoff, context is running out, continue tomorrow, absorb a handoff."
---

<!-- DSH-ADAPT-HEADER BEGIN（移植层新增块：frontmatter 契约化 + ECC→DSH 映射表。本件为种子合成新技能（IMP-21③，B 报告候选 3 降配版）：八节格式与候选排序判据自 ECC 种子段移植，存储面全部换 DSH 原语。）

metadata:
  origin: ECC-seeded synthesis
  ecc-source:
    - ecc-analysis/src/ECC-main/commands/save-session.md:70-180（八节会话文件格式种子；sha256-16 A9488A8819D6C65F）
    - ecc-analysis/src/ECC-main/commands/resume-session.md:56-68（候选排序判据种子；sha256-16 B09BCB22FEB10ADB）
  ported: IMP-21③ · P1 · ecc-analysis batch2 → staging/session-handoff/
  storage-note: 不自建会话存储——DSH 已有 ~/.dsh/sessions/<工作区目录>/session-<id>/session.jsonl.zstd 全量转录（zstd 压缩 JSONL，compaction 不清除盘明细）；交接文档是提炼层不是存储层，引入第二套全局会话存储=双写冲突（PLAN §5.2 同判）

## ECC→DSH 适配映射表（种子段落宿主设施 → DSH 原语）

| ECC 宿主设施（种子段落） | DSH 对位 |
|---|---|
| `~/.claude/session-data/` 全局会话文件目录 | **不建等价目录**：交接文档落任务书/组织者指定路径（缺省 `<项目>/agent-out/handoff/`），文件名 `YYYY-MM-DD-<slug>-handoff.md` |
| session.tmp 会话文件（Claude 自存格式） | session.jsonl.zstd 全量转录（只读取证；导出器=course/export_chat.py；zstandard 必须 stream_reader） |
| /save-session 收尾写盘 + 展示给用户确认 | 本技能 §2 八节格式落盘 + de_broadcast 点对点告知接手方/组织者（有 ORG ID 一律直投） |
| /resume-session 开工吸收 + SESSION LOADED 简报 | 本技能 §4 吸收协议（同款固定简报格式）+ de_session wake 接手会话 |
| 候选排序对象 session.tmp 文件 | 同一交接目录里的多份 .md 交接文档（判据语义逐条对应，见 §3） |
-->

# Session Handoff（会话交接八节格式）

## 0. 定位与边界

- **交接文档=提炼层**：写「结论、判断、失败教训、下一步」，让零记忆的接手方直接续做。全量过程证据已在 session.jsonl.zstd——交接文档不复述过程、细节争议回转录查，**不建第二套全局会话存储**。
- **何时写**：上下文将耗尽前、跨天收工前、移交另一会话/子会话前、完成里程碑做阶段交接时。
- **双向纪律**：写侧不省节（空节写「无」也要落节）；读侧不跳读（先全量吸收再动工）。

## 1. 写前收集

- 修改文件清单与当前状态（git diff / 测试构建结果的新鲜取证，不凭记忆）。
- 本会话讨论过什么、试过什么、定了什么、卡在哪。
- 失败路径逐条记下**确切原因**（§2 第 3 节的原料）。

## 2. 八节交接格式

```markdown
# Handoff: YYYY-MM-DD <topic>

**会话：** <session id / 会话名>
**更新时间：** <时间>
**项目：** <项目路径>

## 1. What We Are Building
（1-3 段：在做什么、为什么、在更大系统里的位置——零记忆可懂。）

## 2. What WORKED (with evidence)
（只列确认有效的，每条带证据：测试绿/实测输出/返回码/截图。
  没有证据的移到第 4 节。没有则写「Nothing confirmed working yet」。）

## 3. What Did NOT Work (and why)
（最重要的一节：每个失败尝试写确切原因。「报了 X 错因为 Y」有用，「没用」没用。
  缺此节，接手会话必然盲目重踩失败路径。）
- **<尝试>** — 失败因为：<确切原因/报错原文>
（还没有失败就写「No failed approaches yet.」）

## 4. What Has NOT Been Tried Yet
（有希望但没试的方向，具体到接手者知道第一步做什么。没有则写「No specific untried approaches identified.」）

## 5. Current State of Files
| 文件 | 状态 | 说明 |
|---|---|---|
（每格：Complete / In Progress / Broken / Not Started + 说明。没动文件就写「No files modified this session.」）

## 6. Decisions Made
- **<决策>** — 理由：<为什么选它而不是备选>
（防接手方重新翻案已定决策。没有则写「No major decisions made this session.」）

## 7. Blockers & Open Questions
（未解决问题、等待中的外部依赖。没有则写「No active blockers.」）

## 8. Exact Next Step
（下一步唯一最重要的事，精确到零思考开工。
  未定则写「未定——先看第 4/7 节再定向」。）
```

- **八节齐全**：不省节，空节如实写「无」——不完整的交接比诚实的空节更糟。
- **第 3 节是核心**：接手方会盲目重试失败路径，除非确切原因写在盘上。每会话一份新档，**不追加旧档**（追加会让失败教训失去时点）。

## 3. 候选排序判据（同一目录多份交接文档、自动发现时用）

**只对自动发现的候选排序；接手方显式给了文件路径就直接读该文件，不排序、不替换、哪怕它更空。**（承自 resume-session.md:54 同款红线。）

1. 剔除不可读、空、纯空白、只含标题/元数据/分隔符/占位符（如「[待填写]」「- [ ]」「[Session context goes here]」类）的文档。
2. 剔除只有一条任务且八节实质内容皆空的提纲式文档——结构性过滤「一句话总结的回声稿」，不依赖任何特定提示词文本。
3. 保留实质填充的候选：有已完成/进行中工作、具体下一步、具体上下文路径、多任务、修改文件清单、用过的工具之一。
4. 实质候选中取修改时间最新者。
5. 同刻 tie-break（保确定性）：填充节多者 → 非占位内容多者 → 字节大者 → 路径字典序小者；计数在剔除标题/元数据/分隔符/占位文本后进行。

（判据逐条对应 resume-session.md:56-68，对象从 session.tmp 换成交接 .md 文档。）

## 4. 接手吸收协议

1. 找到/收到交接文档后**全文读入**（先吸收，不急着动工）。
2. 按固定格式回简报（格式固定、不跳节，空节也要出现）：

```
SESSION LOADED: <实际解析路径>
PROJECT: <项目/主题>
WHAT WE'RE BUILDING:（用自己话 2-3 句）
CURRENT STATE:
  Working: <确认有效 N 项>
  In Progress: <进行中文件>
  Not Started: <计划未动>
WHAT NOT TO RETRY:
  <逐条失败尝试+确切原因——此节必回显，哪怕「None」>
OPEN QUESTIONS / BLOCKERS: <逐条>
NEXT STEP: <原文下一步；未定义则提示先看第 4/7 节>
```

3. **引用核对**：交接文档提到的文件在盘上核对存在性，缺失即报 `WARNING: <path> referenced in handoff but not found on disk`；文档距今超过 7 天报时效 WARNING 再继续。
4. 下一步明确且接手指令为「继续」类时按原文下一步执行；未定义则与组织者确认方向，不擅自定向、不自动开工改文件。
5. 交接文档是**只读历史记录**——吸收时不修改它；本会话收工时另写新档。

## 5. 反模式

1. 只写「做了什么」不写「为什么失败」——第 3 节缺失是最高频交接事故。
2. 交接文档替代转录取证——细节争议回 session.jsonl.zstd 查（zstandard 用 stream_reader），不靠记忆复述。
3. 建第二套全局会话存储——DSH 已有转录持久化，重复建设=双写冲突。
4. 多份交接文档互相 append——每会话一份新档。
5. 隐式发现时跳过排序判据、或显式路径时套用排序替换用户指定文件——两头都违 §3。
