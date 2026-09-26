---
name: agent-bugfix
description: 缺陷追猎流水线（agent-bugfix，编排 dsh-agents 的 5 个 sub agent）：OMC「Bug Investigation」组合的 DSH 直译——explore 先定位相关代码 → debugger 把缺陷追到根因并给最小修复（优先让红变绿不顺手重构）→ 疑难杂症升级 tracer 做竞争假设与证据排序 → test-engineer 写回归测试锁住根因（防复发）→ verifier 取证收尾（修复证据 + 无回归证据）。适用于：报错、行为不符预期、构建失败等缺陷修复任务。触发：用户说「修这个 bug/报错了/行为不对/修完验证」，且能提供错误现象（报错文本/复现步骤/截图）。
---

# 缺陷追猎流水线（agent-bugfix）

> 编排 5 角色：explore → debugger（疑难升级 tracer）→ test-engineer → verifier。
> 派活方式、回收监控、失败处理与 `agent-autopilot` 一致（主路径 agent_spawn / 降级 de_session+personas）。本技能只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。
> ECC 批次1 IMP-09 增量：Step 0 尺寸分级+相位掩码（tie-breaker 安全面/公共 API⇒standard）、explore 定位检索面。均带行内锚点。

## Step 0 · 尺寸分级（IMP-09①，仪式随爆炸半径缩放）
> 锚 ECC `skills/orch-pipeline/SKILL.md:39-54` + `ecc-analysis/review/B-workflows.md` §3 M-1。三信号取最高档；分级结果一行写进任务书（可审计，用户可覆盖）。

| 档 | 信号 | 相位掩码（对应下方步骤号） |
|---|---|---|
| trivial | 单文件单函数 / 无新依赖 / 根因读码即显然 | 0 → 2 → 3 → 4（跳过 1 explore，debugger 自带定位） |
| small | 1-2 文件 / 无 / 定位路径清晰 | 0 → 1 → 2 → 3 → 4 |
| standard | 多文件 / 修复可能引内部接口调整 / 现象有歧义 | 0 → 1 → 2 →(2b 视升级条件)→ 3 → 4 |
| large/跨切 | 修复引出多文件重构或跨系统改动 | **不修**——转 agent-feature / agent-autopilot（既有条款） |

- **tie-breaker：缺陷触及安全面（鉴权/注入/密钥）或公共 API/契约 ⇒ 至少 standard**，且 tracer 升级条件从严（锚 `orch-pipeline/SKILL.md:52-54`）

## 执行顺序

### 0. 前置收集（组织者自己做，不派活）
- 收齐缺陷材料：报错文本/堆栈、复现步骤、预期 vs 实际、最近相关改动（git log/diff）
- 材料不全 → 先问用户要（缺陷描述是本流水线的唯一必需输入）

### 1. explore（LOW，只读）——定位
- 输入：报错堆栈中的文件/符号 + 特征关键词
- **定位检索面（IMP-09⑨，缺省从简）**：缺陷修复以定位为先，检索面取 8+5 全集的定位相关子集——错误处理模式、类型定义、测试模式、配置、依赖 5 类检索 + 契约、数据流、入口点 3 条追踪；不适用的显式声明 N/A（全集定义见 agent-autopilot Phase 0；锚 ECC `commands/prp-plan.md:97-125` + B-workflows.md §3 M-15「explore 任务书」落点）
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

## 投递纪律（全局，2026-09-19 用户钉死）

- 子会话/评审员的完成与状态汇报一律**点对点直投**组织者会话 ID（任务书必须预写 ORG 会话 ID）；
- **严禁群发**：禁用 `project:` 伪接收者与多收件人广播——该形态会唤醒目录下全部 idle 会话，消耗各会话唤醒预算；
- **每条消息只允许唤醒一个会话**；有 ORG ID 时一律直投，仅在 ID 确实不可得时降级为其他形态，且降级须在汇报中注明；
- 需多方知晓的信息由组织者逐会话转发或汇总说明，执行会话不得代发。
