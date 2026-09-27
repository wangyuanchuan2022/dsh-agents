---
name: parallel-execution-optimizer
description: "触发：并行加速、多 agent 并发、批量工具调用、并行验证、怎么更快做完｜English: parallelize, concurrent agents, batched tool calls, speed up｜Use when the user wants a task done much faster through parallel work, concurrent agents, batched tool calls, isolated worktrees, or many independent verification lanes without losing correctness."
---

<!-- DSH-ADAPT-HEADER BEGIN（移植层新增块：frontmatter 契约化 + ECC→DSH 映射表。剥离本块与 frontmatter 后，正文与 ECC 原件逐字一致——仅含行内【适配：…】标注，一字未删。校验：node verify-fidelity-56.mjs）

metadata:（ECC frontmatter 散字段收编于此——DSH frontmatter 契约仅 name+description）
  origin: ECC
  ecc-source: ecc-analysis/src/ECC-main/skills/parallel-execution-optimizer/SKILL.md（ECC v2.2.2，sha256-16 B44DEF0F7C24AB25）
  ported: IMP-16⑥ · P2 · ecc-analysis batch2 → staging/parallel-execution-optimizer/
  license: MIT（ECC frontmatter 散字段，原样收编）

## ECC→DSH 适配映射表（宿主设施 → DSH 原语）

| ECC 宿主设施（正文原样保留） | DSH 对位 |
|---|---|
| tools: Read, Write, Edit, Bash, Grep, Glob（frontmatter 散字段） | read / write / edit / pwsh（Bash 对位：每次调用独立进程，用 workdir 参数）/ grep / glob |
| isolated worktrees（写面隔离） | git worktree（沙箱可用）或多个子会话各占独立写面；并行授权判据=写面不碰撞（正文 Only run lanes… 一句，哑门断言） |
| separate sessions + poll（长任务） | de_session spawn 子会话 + de_session status 巡检 / 后台 job job_output / pwsh 心跳闹钟（见行内适配） |
| background process 条款（正文 Never let… 一句，哑门） | DP-3 批准口径行内适配（原文一字不删）：DSH 长任务=后台 job+增量落盘+心跳巡检+任务书回收契约 |
| verification table（Output Shape） | DSH 报告惯例：产出落盘 + 点对点广播双条件，证据（命令输出/退出码）进报告 |
-->

# Parallel Execution Optimizer

Use this skill when speed comes from doing independent work at the same time:
repo inspection, file reads, API checks, browser checks, build/test lanes,
deploy readbacks, or multi-worktree implementation passes.

## Core Pattern

Turn urgency into a dependency graph before acting.

1. Define the objective and done signal.
2. Split work into lanes.
3. Mark each lane as parallel, sequential, or gated.
4. Run independent reads/checks together.
5. Keep writes isolated by file, worktree, branch, service, or dataset.
6. Merge only after evidence shows the lanes are compatible.
7. End with a verification table, not a vague speed claim.

## Lane Matrix

Before a large push, write a compact matrix:

```text
Lane | Can run in parallel? | Write surface | Risk | Verification
Repo scan | yes | none | low | rg/git status outputs
Backend patch | maybe | src/api | medium | unit tests
Frontend patch | maybe | app/components | medium | browser screenshot
Deploy readback | after build | remote service | high | live URL + logs
```

Only run lanes in parallel when their write surfaces do not collide.

## Execution Rules

- Batch file reads, searches, status checks, and metadata queries.
- Use isolated worktrees for large unrelated implementation lanes. 【适配：git worktree 在 DSH 沙箱内可用；DSH 对位亦可=多个子会话各占独立写面（文件/目录/分支隔离），授权判据=写面不碰撞（Lane Matrix 节）】
- Start long-running tests, builds, backfills, and deploys in separate sessions,
  then poll them deliberately. 【适配：separate sessions → DSH de_session spawn 子会话（用户规则：优先子会话而非后台 agent）；poll → de_session status 巡检 / 后台 job job_output / pwsh 心跳闹钟（后台 sleep，完成通知唤醒有界）】
- If a lane discovers a blocker that changes the plan, pause dependent lanes
  and update the matrix.
- Never let a background process outlive the turn unless the user explicitly
  asked for a continuing service. 【适配：DSH 长任务=后台 job+增量落盘+心跳巡检+任务书回收契约；本条在 DSH 语境下指临时探测进程，长任务见 DSH 心跳纪律】
- Do not parallelize destructive commands, migrations, writes to the same table,
  or live customer-impacting deploys without an explicit gate.

## Output Shape

Use this when reporting:

```text
Parallel execution result:
- Lanes run: 5
- Lanes completed: 4
- Blocked lane: deploy readback, waiting on DNS propagation
- Fast path found: batched repo scan + focused tests
- Verification: lint pass, unit pass, live smoke pass
```

## Failure Modes

- More concurrency that creates conflicting edits.
- Benchmarking the tool instead of the task.
- Treating "fast" as done before correctness is proven.
- Forgetting to poll running sessions.
- Hiding skipped checks behind a success summary.
