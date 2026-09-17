---
name: agent-review-squad
description: 评审小队（agent-review-squad，编排 dsh-agents 的 4 个 sub agent）：OMC「Code Review」组合的 DSH 直译——code-reviewer（质量/逻辑/SOLID/性能）与 security-reviewer（OWASP/密钥/危险模式）对同一 diff 并行独立盲评（P0/P1/P2 + 文件:行号 + 【改进点】），critic 做最终质量闸门汇总裁决（不仅评审「有什么」还指出「缺什么」，误批代价高于误驳），可选 code-simplifier 出行为不变简化建议交 executor 落地。只读评审 + 组织者合成，评审报告落盘双条件核销。适用于：合并前评审、里程碑验收、安全敏感改动审查。触发：用户说「评审这些改动/code review/帮我审一下/合并前检查」，或 agent-autopilot/agent-feature 的 Phase 4 需要外部评审火力。
---

# 评审小队（agent-review-squad）

> 编排 4 角色：code-reviewer + security-reviewer（并行盲评）→ critic（汇总裁决）→ 可选 code-simplifier（简化建议）。
> 派活方式、回收监控与 `agent-autopilot` 一致（主路径 agent_spawn / 降级 de_session+personas）。本技能只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。

## 输入（组织者准备）
- 评审对象：diff/文件清单/提交区间（缺省=当前未提交改动或最近一次提交）
- 评审上下文：改动意图（这几个文件是干嘛的）、风险声明（是否触及 auth/输入/密钥/迁移）
- 产出目录：`review/<批次>/`（预先指定，防与历史评审混淆）

## 执行顺序

### 1. code-reviewer + security-reviewer（HIGH，均只读）——并行盲评
- **同一 diff 快照、同一产出目录、互不可见对方报告**（盲评防锚定；两份任务书除角色外完全一致）
- code-reviewer 视角：规格符合性、逻辑正确性、错误处理、反模式、SOLID、性能
- security-reviewer 视角：OWASP Top 10、硬编码密钥、危险模式，按 严重度×可利用性×影响面 排序
- 统一产出格式：P0/P1/P2 分级 + 文件:行号 证据 + 【改进点】小节
- 派活错峰 15s，两份并行跑

### 2. critic（HIGH，只读）——最终质量闸门
- 输入：两份盲评报告 + 原始 diff（**此时才解盲**）
- 职责：
  - 汇总裁决：去重同源发现、裁决相互矛盾的评级、确认每条 P0 证据成立
  - 缺口检查：不仅评审「报告里有什么」，还要指出「报告漏了什么」（盲区清单）
  - 处置分流：P0 必修 / P1 建议修（给修法）/ P2 记账
- 产出：`review/<批次>/verdict.md`（总裁决 + 分流清单 + 盲区说明）

### 3. 可选 code-simplifier（HIGH）——简化建议
- 触发：用户点名「顺便简化」或 critic 判定可读性问题显著
- 产出：行为不变的简化建议清单（写明「为什么等价」）；**落地交给 executor**，本技能不改码

### 4. 修复回路（可选，接 agent-feature/executor）
- P0/P1 修复派 executor，修完回步骤 1 只评增量（「已结论项免查」）

## 合并判定
- P0 清零 + P1 全部有处置 + critic verdict 为通过 → 评审通过，可合并
- 任一 P0 未修 → 不通过，输出阻断清单

## 触发方式
- 「评审这些改动」「code review」「帮我审一下」「合并前检查」「安全审查这些文件」
- 或其他 agent 工作流的 Phase 4 需要加强评审火力时被调用

## 纪律
- 盲评是核心：两条任务书不得提及对方存在与输出
- 只读评审：code-reviewer/security-reviewer/critic 的任务书均带只读条款，除报告外禁止改任何文件
- 评审批次目录不混用（review/、review2/…递增），防新旧发现混淆
