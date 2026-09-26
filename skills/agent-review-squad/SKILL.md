---
name: agent-review-squad
description: 评审小队（agent-review-squad，编排 dsh-agents 的 4 个 sub agent）：OMC「Code Review」组合的 DSH 直译——code-reviewer（质量/逻辑/SOLID/性能）与 security-reviewer（OWASP/密钥/危险模式）对同一 diff 并行独立盲评（P0/P1/P2 + 文件:行号 + 【改进点】），critic 做最终质量闸门汇总裁决（不仅评审「有什么」还指出「缺什么」，误批代价高于误驳），可选 code-simplifier 出行为不变简化建议交 executor 落地。只读评审 + 组织者合成，评审报告落盘双条件核销。适用于：合并前评审、里程碑验收、安全敏感改动审查。触发：用户说「评审这些改动/code review/帮我审一下/合并前检查」，或 agent-autopilot/agent-feature 的 Phase 4 需要外部评审火力。v2（OCR 确定性工程增强）：规格信封/覆盖账闭合/critic 删除闸门/锚定机检/现行性标注/人可复述最小结论。
---

# 评审小队（agent-review-squad）v2

> v2 融合 alibaba/open-code-review「确定性工程 × Agent」机制：规格信封、覆盖账闭合、critic 删除闸门、锚定机检、现行性标注、人可复述最小结论。OMC 原有编排全部保留。
> 编排 4 角色：code-reviewer + security-reviewer（并行盲评）→ critic（汇总裁决）→ 可选 code-simplifier（简化建议）。
> 派活方式、回收监控与 `agent-autopilot` 一致（主路径 agent_spawn / 降级 de_session+personas）。本技能只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。
> 🔧 确定性闸门工具：`node D:\tools\deepsek_harness\dsh-agents\tools\crgate.mjs`（随 dsh-agents 插件分发；用法见其 --help）。

## 输入（组织者准备）★ 派活前置校验——缺任一项派活前响亮失败并回头补齐，禁止评审员开工后瞎猜

- [ ] **评审对象**（三选一，钉死不可漂移）：① 未提交改动（workspace）② 提交/区间（给出 resolved SHA，如 `--commit <sha>` 或 `--from <ref> --to <ref>`）③ 陌生仓库全量审计（scan，`--all`）
- [ ] **产出目录**：`review/<批次>/`（预先新建，不得复用历史批次；review/、review2/… 递增）
- [ ] **风险声明**（封闭枚举）：auth / 输入处理 / 密钥凭据 / 数据迁移 / 行为兼容 / 无
- [ ] **规格信封（覆盖分母）**：`crgate.mjs freeze --repo <目录> [--from --to | --commit <sha> | --all] --out review/<批次>/review-spec.json`——spec.json 即两席共用的覆盖分母（reviewable/excluded 文件清单 + 排除理由 + 身份三哈希），两份任务书**引用同一路径同一哈希**。组织者未预先产出时，由评审员按人格协议第 0 步自产并回填本路径
- [ ] **评审上下文**：改动意图（这些文件是干嘛的）、风险声明落成一句话背景

## 执行顺序

### 1. code-reviewer + security-reviewer（HIGH，均只读）——并行盲评
- **同一 spec、同一产出目录、互不可见对方报告**（盲评防锚定；两份任务书除角色外完全一致）
- code-reviewer 视角：规格符合性、逻辑正确性、错误处理、反模式、SOLID、性能
- security-reviewer 视角：OWASP Top 10、硬编码密钥、危险模式，按 严重度×可利用性×影响面 排序
- 统一产出格式：P0/P1/P2 分级 + 文件:行号 证据 + 【改进点】小节 + **覆盖账**（spec 每项落四态之一：reviewed / skipped(封闭枚举理由+复跑方式) / blocked(原因+复跑命令) / waived(引用用户指示原文)）+ **评审身份块**（head_sha / selection_hash / spec_sha / 语言清单 / 模型）
- **锚定机检门（交付前置，不可省）**：报告落盘后运行 `crgate.mjs anchor --repo <目录> --report <报告> --spec <spec> --strict`（历史审查加 `--at <被审提交>`），exit 0 才算交付完成，anchor-report.json 随批次归档
- 派活错峰 15s，两份并行跑

### 2. critic（HIGH，只读）——最终质量闸门
- 输入：两份盲评报告 + 原始 diff + spec.json + 各席 anchor-report.json（**此时才解盲**）
- 职责：
  - 汇总裁决：去重同源发现、裁决相互矛盾的评级、确认每条 P0 证据成立
  - 缺口检查：不仅评审「报告里有什么」，还要指出「报告漏了什么」（盲区清单）
  - 处置分流：P0 必修 / P1 建议修（给修法）/ P2 记账
  - **锚定核对**：两席 anchor --strict 均通过且 anchor-report.json 在案；抽验 P0 发现的 file:line 必须逐字命中——命中不了的发现降 P2 并标「未锚定」，不得作为阻塞项
  - **覆盖闭合闸**：用 `crgate.mjs finalize --spec <spec> --ledger <该席 ledger.json>` 机检两席覆盖账——缺项（sweep 成 failed）/越界路径/空理由/未知状态/重复条目任一出现 → 该席报告判**不完整**，退回补评；覆盖账不得以 failed 终态交付
  - **删除闸门（默认动作是保留）**：对任何「建议剔除/降级」的发现执行五步法，命中即停——
    1. **保护类主体否决**：内存安全与释放、并发与竞态、错误处理完整性、资源泄漏、行为兼容性变更、安全（注入/密钥/认证）——在这些类别上 critic 没有资格自信，一律保留
    2. **价值否决**：该发现修正了真实缺陷或揭示了真实风险 → 保留
    3. **Ground A**：评论指向的代码不在其主体文件的 diff 里 → 可移出（转「越界/归档」节，非删除）
    4. **Ground B**：某一行 diff 字面反驳其核心主张（需多于一步推理才能得出矛盾 = 没有矛盾）→ 可删，且必须指名那一行
    5. **放行**
    - 以下说法等价于放行：可疑 / 我无法验证 / 低价值 / 这段代码我看着没问题 / 换我不会提
  - **现行性标注**（历史审查场景）：verdict 对每条发现核对「当前 HEAD 是否仍存在」（read 当前文件确认），已被后续提交修复的项标「已修复于 <提交>」，不参与现行裁定——历史归因与现行性分列，不可混写
- 产出：`review/<批次>/verdict.md`（评审身份块 + 总裁决 + **覆盖状态** + 分流清单 + 盲区说明 + **人可复述的最小结论 ≤5 条**——每条一句话，脱离 AI 报告也能被人复述清楚）

### 3. 可选 code-simplifier（HIGH）——简化建议
- 触发：用户点名「顺便简化」或 critic 判定可读性问题显著
- 产出：行为不变的简化建议清单（写明「为什么等价」）；**落地交给 executor**，本技能不改码

### 4. 修复回路（可选，接 agent-feature/executor）
- 增量评审的任务书必须带结构化 `<confirmed_findings>` 块：序号 + 文件 + 单行 code 摘要（≤200 字符）+ 单行结论摘要（≤300 字符），总量 ≤30 条，附否定式指令（「不要重复它们；继续在剩余面上找新发现，不得因清单存在而止步」）——该块约束的是**重复**，不是**范围**
- **免查需凭证**：免查项必须能在上一轮覆盖账找到 reviewed 记录**且**文件内容哈希未变，否则重评
- **重派熔断**：同一 P0 修复最多重派 2 次——第 2 次必须显式改写任务书（不许原样重派），第 3 次转记账交 critic 裁决；修复会话成功即清零计数
- **收尾宽限轮**：预算收紧时的最后一轮只许提交已识别的发现、不许新开分析面

## 合并判定（v2：双轨正交，分列输出）
- **交付等级**（由覆盖闭合度决定）：complete（分母全 reviewed）/ partial（有 skipped/blocked/waived 且理由齐备——必须列明未覆盖范围与原因）/ failed（有缺项或结构错误）。partial 不是失败，但必须显式声明，不得沉默。
- **合并阻塞**（由发现严重度决定）：P0 清零 + P1 全部有处置 + critic verdict 通过 → 可合并；任一 P0 未修 → 不通过，输出阻断清单
- **覆盖状态 ≠ complete 时不得给出 APPROVE**；两轨在 verdict.md 中分列
- skipped 项不得计入通过项：「已验证通过」与「未验证（skipped）」必须分列

## 触发方式
- 「评审这些改动」「code review」「帮我审一下」「合并前检查」「安全审查这些文件」
- 或其他 agent 工作流的 Phase 4 需要加强评审火力时被调用

## 纪律
- 盲评是核心：两条任务书不得提及对方存在与输出
- 只读评审：code-reviewer/security-reviewer/critic 的任务书均带只读条款，除报告与机检产物（ledger.json / anchor-report.json / final.json）外禁止改任何文件
- 评审批次目录不混用（review/、review2/…递增），防新旧发现混淆
- 机检门不跑不得交付：anchor --strict 与 finalize 的产物随批次归档，供组织者与第三方复核
- 规模边界：单批 >20 文件强制拆批或声明 partial；不支持 diff 的陌生仓库用 scan 模式（`--all`）
- 双副本同步：本技能在 `dsh-agents/skills/`（源）与 `~/.agents/skills/`（安装位）各有一份，改动必须双位同步并比对哈希（v2 前曾发生单侧漂移）

## 投递纪律（全局，2026-09-19 用户钉死）

- 子会话/评审员的完成与状态汇报一律**点对点直投**组织者会话 ID（任务书必须预写 ORG 会话 ID）；
- **严禁群发**：禁用 `project:` 伪接收者与多收件人广播——该形态会唤醒目录下全部 idle 会话，消耗各会话唤醒预算；
- **每条消息只允许唤醒一个会话**；有 ORG ID 时一律直投，仅在 ID 确实不可得时降级为其他形态，且降级须在汇报中注明；
- 需多方知晓的信息由组织者逐会话转发或汇总说明，执行会话不得代发。
