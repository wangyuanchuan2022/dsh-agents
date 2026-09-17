---
name: agent-bugfix
description: 缺陷追猎流水线（agent-bugfix，编排 dsh-agents 的 5 个 sub agent）：OMC「Bug Investigation」组合的 DSH 直译——explore 先定位相关代码 → debugger 把缺陷追到根因并给最小修复（优先让红变绿不顺手重构）→ 疑难杂症升级 tracer 做竞争假设与证据排序 → test-engineer 写回归测试锁住根因（防复发）→ verifier 取证收尾（修复证据 + 无回归证据）。适用于：报错、行为不符预期、构建失败等缺陷修复任务。触发：用户说「修这个 bug/报错了/行为不对/修完验证」，且能提供错误现象（报错文本/复现步骤/截图）。
---

# 缺陷追猎流水线（agent-bugfix）

> 编排 5 角色：explore → debugger（疑难升级 tracer）→ test-engineer → verifier。
> 派活方式、回收监控、失败处理与 `agent-autopilot` 一致（主路径 agent_spawn / 降级 de_session+personas）。本技能只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。

## 执行顺序

### 0. 前置收集（组织者自己做，不派活）
- 收齐缺陷材料：报错文本/堆栈、复现步骤、预期 vs 实际、最近相关改动（git log/diff）
- 材料不全 → 先问用户要（缺陷描述是本流水线的唯一必需输入）

### 1. explore（LOW，只读）——定位
- 输入：报错堆栈中的文件/符号 + 特征关键词
- 输出：相关代码定位清单（文件:行号）、模块关系、可疑改动点

### 2. debugger（MEDIUM）——根因与最小修复
- 输入：缺陷材料 + explore 定位清单
- 输出：根因分析（为什么发生、为什么现在才暴露）+ **最小修复 diff**（不顺手重构、不扩范围）
- 纪律：先复现（有失败测试最好），再修；修完该缺陷现象消失

### 2b. tracer（MEDIUM，疑难升级）——竞争假设
- 升级条件：debugger 两轮仍找不到根因、或现象间歇性/多因素
- 输出：竞争假设列表（每条带支持/反对证据与强度排序）+ 下一步最能消减不确定性的探测建议
- 探测结论回 debugger 执行修复

### 3. test-engineer（MEDIUM）——回归锁
- 为根因写回归测试（修复前失败、修复后通过的测试优先）
- 全量测试跑绿；不绿回步骤 2

### 4. verifier（MEDIUM，只读）——取证
- 取证三项：根因分析成立、回归测试真实失败→通过、无新回归
- 产出：修复报告（根因/修复/证据/残留风险）

## 与 agent-autopilot 的关系
- 单个缺陷修复不需要六阶段；本流水线即 OMC Bug Investigation 组合（explore + debugger + executor→此处由 debugger 亲自小修 + test-engineer + verifier）
- 修复引出多文件重构需求 → 转 agent-feature 或 agent-autopilot

## 触发方式
- 「修这个 bug」「报错了：…」「这个行为不对」「构建红了修一下」
- 判据：存在明确的缺陷现象（报错/错行为），目标是恢复正确行为而非新增能力
