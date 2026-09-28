---
name: verification-loop
description: "触发：收尾核验、完工检查、六相验证、验证报告、交付前验证｜English: verification loop, six-phase verification, verify before done, verification report｜验证环路（verifier 检查表，引用不并入角色）：完工自报前的六相验证——build/type/lint/test/security/diff 六相命令矩阵逐相过门，输出固定 VERIFICATION REPORT；Build 失败即 STOP；跳过项单列 skipped 不计入通过。中文触发：验证、收尾核验、完工检查、六相验证、VERIFICATION REPORT、验证报告。English triggers: verification loop, verify before done, six-phase verification, verification report."
---

# 验证环路（verification-loop · DSH 版）

DSH 会话/交付物的完整验证系统。

## 对象声明（承重段 · ECC :3）

ECC 原文锚定：

> :3 — "A comprehensive verification system for Claude Code sessions. Use when verifying a Claude Code session's work before claiming it is complete."

## 六相验证（承重段 · ECC :21-90 逐相在场）

> 每相的命令为 ECC 原文命令；行给出 DSH/Windows 侧参数化与替代。命令中的 runner 按项目实际解析（先探测再替换，同 tdd-workflow Step 0）。

### Phase 1 · Build Verification（:23-31）
```bash
# Check if project builds
npm run build 2>&1 | tail -20
# OR
pnpm build 2>&1 | tail -20
```
If build fails, STOP and fix before continuing.（原文纪律：build 失败即 STOP，修复前不得继续。）

### Phase 2 · Type Check（:33-43）
```bash
set -o pipefail
# TypeScript projects
npx --no-install tsc --noEmit 2>&1 | head -30

# Python projects
pyright . 2>&1 | head -30
```
Report all type errors. Fix critical ones before continuing.

### Phase 3 · Lint Check（:45-52）
```bash
# JavaScript/TypeScript
npm run lint 2>&1 | head -30

# Python
ruff check . 2>&1 | head -30
```

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

### Phase 5 · Security Scan（:69-77）
```bash
# Check for secrets
grep -rn "sk-" --include="*.ts" --include="*.js" . 2>/dev/null | head -10
grep -rn "api_key" --include="*.ts" --include="*.js" . 2>/dev/null | head -10

# Check for console.log
grep -rn "console.log" --include="*.ts" --include="*.tsx" src/ 2>/dev/null | head -10
```

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

## 输出格式（承重段 · ECC :95-111 逐字保留）

跑完全部六相后，产出验证报告，格式**逐字保留**如下：

```
VERIFICATION REPORT
=================

Build: [PASS/FAIL]
Types: [PASS/FAIL] (X errors)
Lint: [PASS/FAIL] (X warnings)
Tests: [PASS/FAIL] (X/Y passed, Z% coverage)
Security: [PASS/FAIL] (X issues)
Diff: [X files changed]

Overall: [READY/NOT READY] for PR

Issues to Fix:
1. ...
2. ...
```

## 持续模式（Continuous Mode · ECC :113-124）

ECC 原文语义保留：长会话每 15 分钟或在重大改动后跑一轮验证；设心智检查点——每完成一个函数后、每完成一个组件后、进入下一任务前。ECC 原文给出的入口为 `Run: /verify`。

## 与 hooks 的集成（承重段 · ECC :126-129）

ECC 原文锚定：

> :128 — "This skill complements PostToolUse hooks but provides deeper verification. Hooks catch issues immediately; this skill provides comprehensive review."

