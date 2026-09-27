---
name: verification-loop
description: "触发：收尾核验、完工检查、六相验证、验证报告、交付前验证｜English: verification loop, six-phase verification, verify before done, verification report｜验证环路（verifier 检查表，引用不并入角色）：完工自报前的六相验证——build/type/lint/test/security/diff 六相命令矩阵逐相过门，输出固定 VERIFICATION REPORT；Build 失败即 STOP；跳过项单列 skipped 不计入通过。ECC 原文：A comprehensive verification system for Claude Code sessions. Use when verifying a Claude Code session's work before claiming it is complete.【适配：验证对象=Claude Code 会话 → DSH 会话/交付物（子会话产出、报告、diff）】中文触发：验证、收尾核验、完工检查、六相验证、VERIFICATION REPORT、验证报告。English triggers: verification loop, verify before done, six-phase verification, verification report."
---

<!-- DSH-ADAPT-HEADER BEGIN（移植层新增块。B 档语义=承重段重写后落地：非 A 档全量保真；承重段逐条对应 ECC 原文（锚点 file:line + 原文引句在位），固定 VERIFICATION REPORT 格式为逐字保留段。源冻结 sha256-16 见 metadata.ecc-source）

metadata:（ECC frontmatter 散字段收编于此——DSH frontmatter 契约仅 name+description）
  origin: ECC
  license: MIT
  ecc-source: ecc-analysis/src/ECC-main/skills/verification-loop/SKILL.md（ECC v2.2.2，sha256-16 F0D56107F79E607D，129 行）
  ported: IMP-17② · P1 · ecc-analysis batch2 → staging/verification-loop/

## ECC→DSH 适配映射表（宿主设施 → DSH 原语）

| ECC 宿主设施（锚点） | DSH 对位 |
|---|---|
| 「Claude Code sessions」验证对象（:3，C 报告选定宿主绑定声明行） | 【适配：改写为 DSH 会话/交付物——子会话产出、报告文件、git diff；"before claiming it is complete" 对应本机交付状态纪律（未过验证不得自报 DELIVERED_WITH_EVIDENCE）】 |
| PostToolUse hooks 互补定位（:126-129） | 【适配：DSH 无 hooks——定位改为「阶段门 + 收尾核验（verifier 新鲜证据）」，ECC 原文保留并加行内适配（见正文「与 hooks 的集成」）】 |
| npm/pnpm/tsc/pyright/ruff 命令（六相矩阵 :21-90） | 按项目实际 runner/工具链参数化（行内【适配】）；Windows/DSH 侧用 pwsh 直跑，npm run 管道子进程有 EPERM 风险时改直跑 node_modules 内 bin（本机既有配方） |
| Phase 5 安全扫描 grep（:69-77） | 【适配：三模式 grep（sk-/api_key/console.log）过弱且与 security-reviewer 职能重复——DSH 侧改调 security-reviewer 角色或 security_review 工具；grep 仅作速查非完备】 |
| Continuous Mode `/verify`（:113-124） | 【适配：DSH 无该命令 → 阶段门（每相过门）+ 收尾机检脚本；长会话按里程碑对齐巡检（心跳纪律）】 |
| VERIFICATION REPORT（:95-111） | 固定格式逐字保留，兼作 DSH 机检脚本的 stdout 契约（C 改进点①） |
| 覆盖率阈值 80%（:56-61） | 【适配：与 tdd-workflow 同一条款——本机覆盖纪律=100%（互补双跑合并口径）为目标，80% 仅绝对下限，不因本技能下调】 |

## 承重段锚点总表（本件四个承重段）

| 承重段 | ECC 锚点 | 落位 |
|---|---|---|
| 六相命令矩阵 | :21-90（C 报告锚点 :3 为宿主绑定声明行，对象改写见「对象声明」） | 正文「六相验证」逐相保留 |
| 固定 VERIFICATION REPORT 格式 | :95-111（C 报告锚点 :128 为 hooks 互补声明行，改写见正文末节） | 正文「输出格式」**逐字保留** + DSH 增补块（独立标注） |
| 对象声明 | :3 | 正文「对象声明（承重段）」原文引句 + 改写 |
| hooks 互补定位 | :128 | 正文「与 hooks 的集成（承重段）」原文引句 + 改写 |

-->

# 验证环路（verification-loop · DSH 版）

DSH 会话/交付物的完整验证系统。【适配：定位=verifier 的检查表（C 报告 B-2 重叠判定）——agent-autopilot Phase 3 QA 与 verifier 角色已做「取证收尾」，但没有分相命令矩阵与 VERIFICATION REPORT 固定格式；本件与它们是追加引用关系，不是合并关系】

## 对象声明（承重段 · ECC :3）

ECC 原文锚定：

> :3 — "A comprehensive verification system for Claude Code sessions. Use when verifying a Claude Code session's work before claiming it is complete."

【适配（C 改造点①·宿主绑定处必须改写）：验证对象 = Claude Code 会话 → **DSH 会话/交付物**：完成特性或重大代码改动之后、创建 PR 之前、想确保质量门全过时、重构之后（:15-19 触发场景原样保留）。在 DSH 侧的硬含义：验证未过，不得把交付自报为 DELIVERED_WITH_EVIDENCE；自报 DONE 无效，验收权在组织者/用户】

## 六相验证（承重段 · ECC :21-90 逐相在场）

> 每相的命令为 ECC 原文命令；【适配】行给出 DSH/Windows 侧参数化与替代。命令中的 runner 按项目实际解析（先探测再替换，同 tdd-workflow Step 0）。

### Phase 1 · Build Verification（:23-31）
```bash
# Check if project builds
npm run build 2>&1 | tail -20
# OR
pnpm build 2>&1 | tail -20
```
If build fails, STOP and fix before continuing.（原文纪律：build 失败即 STOP，修复前不得继续。）

【适配：Windows/DSH 侧=项目构建命令直跑（Vite 项目 `node node_modules\vite\bin\vite.js build`）；`2>&1 | tail` 管道形态在 pwsh 捕获下正常，但 npm run 管道子进程有 EPERM 风险时改直跑 bin 并落日志文件。「build 失败即 STOP」为不可让渡纪律】

### Phase 2 · Type Check（:33-43）
```bash
set -o pipefail
# TypeScript projects
npx --no-install tsc --noEmit 2>&1 | head -30

# Python projects
pyright . 2>&1 | head -30
```
Report all type errors. Fix critical ones before continuing.

【适配：tsc 用增量+超时纪律（长仓加 timeout 防挂死）；pyright 未装时用项目既有类型检查器（ruff type-check/mypy/pyright 任一在位者），工具不在位须在报告该相标 skipped+原因+复跑命令，不得静默记 PASS】

### Phase 3 · Lint Check（:45-52）
```bash
# JavaScript/TypeScript
npm run lint 2>&1 | head -30

# Python
ruff check . 2>&1 | head -30
```

【适配：同相参数化——项目没有 lint 配置时该相输出「未配置 lint」并单列 skipped，不计入通过】

### Phase 4 · Test Suite（:54-67）
```bash
# Run tests with coverage
npm run test -- --coverage 2>&1 | tail -50

# Check coverage threshold
# Target: 80% minimum
```
Report:
- Total tests: X
- Passed: X
- Failed: X
- Coverage: X%

【适配：命令按项目 runner 参数化（jest/vitest/pytest/node --test 各自的 coverage 形态）；覆盖率口径=本机 100%（互补双跑合并口径）为目标、80% 仅绝对下限（与 tdd-workflow 同一条款适配，ECC "80% minimum" 注释原样保留于上方代码块）；四元组（Total/Passed/Failed/Coverage）为必报字段】

### Phase 5 · Security Scan（:69-77）
```bash
# Check for secrets
grep -rn "sk-" --include="*.ts" --include="*.js" . 2>/dev/null | head -10
grep -rn "api_key" --include="*.ts" --include="*.js" . 2>/dev/null | head -10

# Check for console.log
grep -rn "console.log" --include="*.ts" --include="*.tsx" src/ 2>/dev/null | head -10
```

【适配（C 改造点②）：三模式 grep 过弱且与 security-reviewer 职能重复——DSH 侧正式扫描改调 **security-reviewer 角色**或 **security_review 工具**（装插件/依赖前审查的全局纪律已固化）；本相 grep 保留为速查（调试代码泄漏：console.log/TODO/HACK/debugger），并声明其非完备性：只查上述模式 ≠ 无秘密】

### Phase 6 · Diff Review（:79-90）
```bash
# Show what changed
git diff --stat
git diff HEAD~1 --name-only
```
Review each changed file for:
- Unintended changes
- Missing error handling
- Potential edge cases

【适配（C 改进点②）：diff 相与 code-reviewer 覆盖面账显式分工——本相查「非预期改动/缺失错误处理/边界隐患」三件；深度质量/逻辑/性能评审归 code-reviewer，两处不得各查一半，报告里注明覆盖面切分】

## 输出格式（承重段 · ECC :95-111 逐字保留）

跑完全部六相后，产出验证报告，格式**逐字保留**如下：

```
VERIFICATION REPORT
=================

Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (X errors)
Lint:      [PASS/FAIL] (X warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (X issues)
Diff:      [X files changed]

Overall:   [READY/NOT READY] for PR

Issues to Fix:
1. ...
2. ...
```

【适配（C 改进点①）：该格式兼作 DSH 收尾机检脚本的 **stdout 契约**——脚本按此格式输出，组织者可按行机检（各相 PASS/FAIL 与 Overall 行）。
【适配（C 改进点③）DSH 增补格式块（紧跟上述固定块之后输出，不改固定块一字）：

```
Skipped:   [X items]
1. <未执行的检查> — 原因：<环境/工具缺失等> — 复跑：<命令>
```

跳过项必须单列 skipped 并附原因与复跑命令，**不计入通过项**——Overall 只按实际执行的相判定；六相中任一「因环境跳过」都不得让 Overall 报 READY 而 skipped 为空】

## 持续模式（Continuous Mode · ECC :113-124）

ECC 原文语义保留：长会话每 15 分钟或在重大改动后跑一轮验证；设心智检查点——每完成一个函数后、每完成一个组件后、进入下一任务前。ECC 原文给出的入口为 `Run: /verify`。

【适配（C 改造点③）：DSH 无 `/verify` 命令 → 落地为「阶段门 + 收尾机检脚本」：每阶段验收即跑对应相（Build/Type/Test），收尾跑全六相并输出 VERIFICATION REPORT；长会话巡检按里程碑 ETA 对齐（本机心跳纪律），不做均分短周期空转】

## 与 hooks 的集成（承重段 · ECC :126-129）

ECC 原文锚定：

> :128 — "This skill complements PostToolUse hooks but provides deeper verification. Hooks catch issues immediately; this skill provides comprehensive review."

【适配（C 改造点④）：DSH 无 hooks——原文保留，定位在 DSH 侧替换为：相内即时反馈由每相命令本身承担（hooks 的对位物），跨相全面复查由本件承担；「即时抓错 + 深度复核」的互补结构不变，载体从 hooks 变为阶段门与收尾核验】
