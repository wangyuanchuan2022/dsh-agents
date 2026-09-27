---
name: agent-harness-construction
description: Design and optimize AI agent action spaces, tool definitions, and observation formatting for higher completion rates. Use when defining or revising an agent's tool set, action space, or observation format.
---

<!-- DSH-ADAPT-HEADER BEGIN（移植层新增块：frontmatter 契约化 + ECC→DSH 映射表。剥离本块与 frontmatter 后，正文与 ECC 原件逐字一致——仅含行内【适配：…】标注，一字未删。校验：node verify-fidelity.mjs）

metadata:（ECC frontmatter 散字段收编于此——DSH frontmatter 契约仅 name+description）
  origin: ECC
  ecc-source: ecc-analysis/src/ECC-main/skills/agent-harness-construction/SKILL.md（ECC v2.2.2，sha256-16 E7FB390A6663B46E，2,100 字节 / LF 74 行）
  ported: IMP-16③ · P1 · ecc-analysis batch2 → staging/agent-harness-construction/

## ECC→DSH 适配映射表（宿主设施 → DSH 原语）

| ECC 宿主设施（正文原样保留） | DSH 对位 |
|---|---|
| Task tool 概念（C 报告 A-3 映射要点） | de_session spawn 子会话 / subagent 后台代理 |
| skills loaded on demand（:51） | DSH 技能目录四级扫描（项目 .dsh/skills、.agents/skills → 用户 ~/.dsh/skills → ~/.agents/skills），按需加载、库内全量不占常驻上下文 |
| references to files over inlining（:52） | 技能包 references/ 子目录随包入队（采纳前补进待确认目录，采纳时整目录 rename） |
| Compact at phase boundaries（:53） | DSH compaction-basic 压缩挂载（thresholdRatio 预设层可调，本项目惯例 0.6） |
| hooks / MCP / claude CLI | 本件零依赖（C 报告 A-3 宿主依赖扫描零命中），无需降级 |

## DSH 工具面契约（C 报告 A-3 改进点①）

DSH 插件 ctx.tools.register：parameters=单一 type + 顶层 required 的严格 JSON 子集；additionalProperties 只收布尔值（对象形式直接 UNSUPPORTED_SCHEMA、整个插件树启动失败）；output 缺 render 即注册失败（schema 与 render 双半缺一不可）。安装前用宿主校验器（assertSupportedJsonSchema）过一遍全部工具 schema。

## 观察面四字段 × DSH 映射（C 报告 A-3 改进点②）

status ↔ ok 布尔/退出码语义；summary ↔ render 返回文本首行（render 必须返回 [{type:'text',text}] 块数组，裸字符串会击穿宿主）；next_actions ↔ 技能目录/角色建议（de_session spawn 候选）；artifacts ↔ 落盘绝对路径。

## 机检落点登记（C 报告 A-3 改进点③）

「缺 summary 的工具输出 → 契约检查器注入必红」属工具开发（批次3 IMP-26 闸门规范），本批登记不实装，部署批由组织者派活补做。
-->

# Agent Harness Construction

Use this skill when you are improving how an agent plans, calls tools, recovers from errors, and converges on completion.

## Core Model

Agent output quality is constrained by:
1. Action space quality
2. Observation quality
3. Recovery quality
4. Context budget quality

## Action Space Design

1. Use stable, explicit tool names.
2. Keep inputs schema-first and narrow. 【适配：DSH ctx.tools.register 的 parameters 为严格 JSON 子集（additionalProperties 仅布尔值，对象形式 UNSUPPORTED_SCHEMA 整树启动失败），注册前用宿主校验器过一遍】
3. Return deterministic output shapes. 【适配：DSH 工具 output{schema,render} 双半契约——render 必须返回块数组（[{type:'text',text}]），裸字符串会击穿宿主】
4. Avoid catch-all tools unless isolation is impossible.

## Granularity Rules

- Use micro-tools for high-risk operations (deploy, migration, permissions).
- Use medium tools for common edit/read/search loops.
- Use macro-tools only when round-trip overhead is the dominant cost.

## Observation Design

Every tool response should include:
- `status`: success|warning|error
- `summary`: one-line result
- `next_actions`: actionable follow-ups
- `artifacts`: file paths / IDs 【适配：DSH 对位=output{schema,render}——status↔ok/退出码、summary↔render 首行、next_actions↔技能/角色建议（de_session spawn 候选）、artifacts↔落盘路径；四字段可机检=schema 必含四键】

## Error Recovery Contract

For every error path, include:
- root cause hint
- safe retry instruction
- explicit stop condition

## Context Budgeting

1. Keep system prompt minimal and invariant.
2. Move large guidance into skills loaded on demand. 【适配：DSH 技能目录四级扫描（项目 .dsh/skills、.agents/skills → ~/.dsh/skills → ~/.agents/skills）按需加载；skill_manage create 走待确认队列】
3. Prefer references to files over inlining long documents. 【适配：DSH 技能包 references/ 子目录随包入队——采纳前补进待确认目录，采纳时整目录 rename】
4. Compact at phase boundaries, not arbitrary token thresholds. 【适配：DSH compaction-basic 按预设合成挂载，thresholdRatio 可调（本项目惯例 0.6）；阶段边界主动收束】

## Architecture Pattern Guidance

- ReAct: best for exploratory tasks with uncertain path.
- Function-calling: best for structured deterministic flows.
- Hybrid (recommended): ReAct planning + typed tool execution.

## Benchmarking

Track:
- completion rate
- retries per task
- pass@1 and pass@3
- cost per successful task

## Anti-Patterns

- Too many tools with overlapping semantics.
- Opaque tool output with no recovery hints.
- Error-only output without next steps.
- Context overloading with irrelevant references.
