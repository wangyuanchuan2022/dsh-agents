---
name: agent-review-squad
description: "触发：评审改动、代码审查、code review、帮我审一下、合并前检查、安全审查、挑毛病｜English: code review, review my changes, pre-merge check, security review｜评审小队（agent-review-squad，编排 dsh-agents 的 4 个 sub agent）：code-reviewer（质量/逻辑/SOLID/性能）与 security-reviewer（OWASP/密钥/危险模式）对同一 diff 并行独立盲评（P0/P1/P2 + 文件:行号 + 【改进点】），critic 做最终质量闸门汇总裁决（不仅评审「有什么」还指出「缺什么」，误批代价高于误驳），可选 code-simplifier 出行为不变简化建议交 executor 落地。只读评审 + 组织者合成，评审报告落盘双条件核销。适用于：合并前评审、里程碑验收、安全敏感改动审查。触发：用户说「评审这些改动/code review/帮我审一下/合并前检查」，或 agent-autopilot/agent-feature 的 Phase 4 需要外部评审火力。v2（OCR 确定性工程增强）：规格信封/覆盖账闭合/critic 删除闸门/锚定机检/现行性标注/人可复述最小结论。"
---

# 评审小队（agent-review-squad）v2.2

> v2.2 新增（M-1 流程硬化，锚 `ecc-analysis/batch3/imp13/critic-verdict.md:215`——IMP-13 复跑 critic 移交项）：CF-24 信封 glob 核对、并行批次所有权划界、分母基准统一（scan 基准=信封声明对象根）、anchor severity 映射与零发现告警、关账前漂移复验步、产出格式补断言鉴别力自查字段。均带行内锚点。
> v2.1新增：评审面复用路由表（单一事实源）、发现归属表、CRITICAL 安全停审、对抗验证步（fail-closed）、实际达成模式三值字段、视觉交付接 visual-verdict、修复回路新鲜评审者与模型家族标注；安全触发判据按 F-3 实测收窄（路径/文件类型优先）。改动均带行内锚点。
> 编排 4 角色：code-reviewer + security-reviewer（并行盲评）→ critic（汇总裁决）→ 可选 code-simplifier（简化建议）。
> 专项对象按评审面复用路由表扩席（派席只认本表，禁临时造席）：如 silent-failure-hunter 作第 5 席并行盲评（静默失败专项）、rag-reviewer 接 RAG/检索管线、spec-miner 接 brownfield 规格提取、harness-optimizer 接 harness/流水线演进评测。
> 派活方式、回收监控与 `agent-autopilot` 一致（主路径 agent_spawn / 降级 de_session+personas）。本技能只写差异。
> ⚠️ 工作区纪律：子会话不传 cwd（继承用户派发任务的工作区）；项目子目录路径在任务书里用相对前缀表达（详见 agent-autopilot「工作区纪律」）。
> 🔧 确定性闸门工具：`node D:\tools\deepsek_harness\dsh-agents\tools\crgate.mjs`（随 dsh-agents 插件分发；用法见其 --help）。

## 输入（组织者准备）★ 派活前置校验——缺任一项派活前响亮失败并回头补齐，禁止评审员开工后瞎猜

- [ ] **评审对象**（三选一，钉死不可漂移）：① 未提交改动（workspace）② 提交/区间（给出 resolved SHA，如 `--commit <sha>` 或 `--from <ref> --to <ref>`）③ 陌生仓库全量审计（scan，`--all`）
- [ ] **产出目录**：`review/<批次>/`（预先新建，不得复用历史批次；review/、review2/… 递增）
- [ ] **风险声明**（封闭枚举）：auth / 输入处理 / 密钥凭据 / 数据迁移 / 行为兼容 / 无
- [ ] **规格信封（覆盖分母）**：`crgate.mjs freeze --repo <目录> [--from --to | --commit <sha> | --all] --out review/<批次>/review-spec.json`——spec.json 即两席共用的覆盖分母（reviewable/excluded 文件清单 + 排除理由 + 身份三哈希），两份任务书**引用同一路径同一哈希**。组织者未预先产出时，由评审员按人格协议第 0 步自产并回填本路径。**分母基准统一（M-1）**：scan/freeze 的 repo 基准 = **信封声明的对象根**（IMP-13 实证 A 席以包目录、B 席以仓库根，两席分母不可直接比较）；包外文件（如 tests/run.mjs）暂进不了机检账，由组织者在信封里人工声明 `--extra` 式清单（crgate --extra 为已登记工具缺口，落地前靠人工声明）
- [ ] **信封实物核对（CF-24，M-1）**：派活前对信封里描述的对象做一次 glob 实测核对（路径、扩展名、目录归属）——IMP-13 三席同遇「信封写 `lib\*.mjs` 实为 `.js`、tests 在包外」偏差；**信封以 glob 实测为准**，不符即改信封再冻结，禁止评审员开工后自行脑补修正
- [ ] **所有权划界（M-1）**：多批次并行时，任务书/信封必须显式声明本批判次的**所有权边界**（哪些目录/文件归本批判，哪些归并行批）——IMP-13 实证冻结后对象目录被并行批次写入（lib/checks 五工具漂移进冻结窗口外），未划界则漂移面无处归属
- [ ] **评审上下文**：改动意图（这些文件是干嘛的）、风险声明落成一句话背景

## 执行顺序

### 1. code-reviewer + security-reviewer（HIGH，均只读）——并行盲评
- **同一 spec、同一产出目录、互不可见对方报告**（盲评防锚定；两份任务书除角色外完全一致）
- **隔离是机制不是默契（两层，缺一不可）**：① **会话层**——每席都由 `agent_spawn` 创建**全新会话**，不继承组织者对话历史；② **材料层**——两席角色的隔离模式为 `blind`，`agent_taskbook` / `agent_spawn` 会自动在任务书里写入「上下文隔离契约」并**机检下发的材料**：正文/背景/现状盘点/交付验收里若出现**作者自评**（「我已经实现并验证过」）或**其他席位结论**（「另一席说没问题」），返回里以 fail-closed 告警点名命中原文，`isolationLeaks` 非空即须清理后重派。只有本席能看到的材料才叫盲评——两席任务书除角色外必须逐字一致。
- **禁止把作者立场塞进任务书**：`deliverable`/`acceptance` 只写可核验的判据，不写作者的取舍理由；确需背景时给**客观事实**（文件职责、风险声明一句话），不给辩解。
- code-reviewer 视角：规格符合性、逻辑正确性、错误处理、反模式、SOLID、性能
- security-reviewer 视角：OWASP Top 10、硬编码密钥、危险模式，按 严重度×可利用性×影响面 排序
- **安全席触发判据（F-3 实测修正，路径/文件类型优先）**：派 security-reviewer 的条件以路径/文件类型命中为准——`auth/**`、`*secret*`、`*.sql`、中间件/路由文件、`crypto` 模块 import；通用词表（token/hash/session/query 等）仅作补充信号、不得单独触发（ECC 词表实测 20 行滑窗 32.7%、按 3 hunk 估算约 69% diff 命中＝恒开伪条件，锚 `workflows/orch-review.workflow.js:59` + `ecc-analysis/review/B-workflows.md:111-117`）。安全敏感仓库可显式声明 always-on 双评，无需伪装条件触发
- **发现归属表（cross-cutting 默认归 security-reviewer）**：一条发现同时命中两席领域时按本表定席，防双席重复报同一问题稀释信号——① 跨切面发现（一个改动同时引入质量与安全问题，如新增的注入点、未校验的迁移）→ **默认归 security-reviewer**，code-reviewer 只在逻辑正确性面独立呈现；② 纯质量面 → code-reviewer；③ 归属争议 → 双席各自原始报告照常落盘，critic 合并时裁决归属，不预合并
- **CRITICAL 安全即停审**：任一席在盲评中发现 CRITICAL 级安全问题（可利用的注入/密钥泄漏/认证绕过类）→ 立即停止本席后续分析面、`de_broadcast(wake:true)` 告知组织者；critic 收到后**优先处置**（先于去重与覆盖闭合），裁决「续审 / 升级用户 / 转修复回路」。停审不是丢弃——本席已产出发现照常落盘归档
- 统一产出格式：P0/P1/P2 分级 + 文件:行号 证据 + 【改进点】小节 + **覆盖账**（spec 每项落四态之一：reviewed / skipped(封闭枚举理由+复跑方式) / blocked(原因+复跑命令) / waived(引用用户指示原文)）+ **评审身份块**（head_sha / selection_hash / spec_sha / 语言清单 / 模型 / **实际达成模式** / **断言鉴别力自查**）——「断言鉴别力自查」字段（M-1）：报告含解析/分类/闸门/测试类发现时，逐条自报对模板 §7.1 断言鉴别力条款的自查结果（元素数达标/负向必红配齐/真实输入全量跑），字段化后可机检（IMP-13 B 席自查出 glob 2 元素违反条款①，机制有效但无落点字段）
- **实际达成模式（三值字段，必带）**：评审身份块必须记录本次评审的实际达成模式——`实机`（真实运行了被审对象）/ `截图`（渲染取证但未交互）/ `仅代码`（纯静态审阅）+ 降级理由。凡未实机运行，必须显式声明降级原因（如沙箱不可起服务），**不得把静态审阅悄悄算作实机核验**
- **锚定机检门（交付前置，不可省）**：报告落盘后运行 `crgate.mjs anchor --repo <目录> --report <报告> --spec <spec> --strict`（历史审查加 `--at <被审提交>`），exit 0 才算交付完成，anchor-report.json 随批次归档。**severity 映射（M-1）**：anchor 判 UNANCHORED 的发现按 CRITICAL 级处置（证据不可锚定＝发现不可复核）；**零发现告警（M-1）**：任一席零发现时必须在报告显式声明「零发现合法」（引 code-reviewer v2.3 误报清单条款）并附覆盖账 complete 佐证，静默零发现视同未审
- 派活错峰 15s，两份并行跑

### 2. critic（HIGH，只读）——最终质量闸门
- 输入：两份盲评报告 + 原始 diff + spec.json + 各席 anchor-report.json（**此时才解盲**）
- 职责：
 - **CRITICAL 安全优先处置**：存在 §1 的停审信号时，先裁决该事项（续审/升级用户/转修复回路），再进入常规流程
 - 汇总裁决：去重同源发现、裁决相互矛盾的评级、确认每条 P0 证据成立。**去重键 = 文件 + 归一化证据代码片段**，不是标题措辞或行号；证据为空的发现退回原席补证据，不得参与去重合并
 - 缺口检查：不仅评审「报告里有什么」，还要指出「报告漏了什么」（盲区清单）
 - **视觉交付裁决门（GAN 纪律③）**：交付含 UI/视觉改动时，视觉面必须过 `visual-verdict` 技能（score ≥90 且 verdict=pass 才算视觉面通过；低于线必须继续编辑并重跑判定，新截图过线前不得宣布完成）；visual-verdict 不可用（无截图/无参考图）时显式降级并记入评审身份块「实际达成模式」，不得跳过不提
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
 - **关账前漂移复验（M-1）**：verdict 落盘前对冻结对象做一次哈希/mtime 复验（crgate 身份哈希比对或 Get-FileHash 抽验）——冻结后对象被并行批次写入时，verdict 必须显式声明「本裁决适用冻结时点 <哈希/时间戳>，漂移新增面（逐项列出）不在覆盖账内、由 ORG 裁决归属」（IMP-13 实证：冻结后 lib/checks 五工具漂移，三席结论仅适用冻结时点；漂移面不得静默混入现行裁决）
- 产出：`review/<批次>/verdict.md`（评审身份块 + 总裁决 + **覆盖状态** + 分流清单 + 盲区说明 + **人可复述的最小结论 ≤5 条**——每条一句话，脱离 AI 报告也能被人复述清楚）

### 2b. 对抗验证（verifier 席，MEDIUM，只读）——CRITICAL/HIGH 逐条过验证
- 触发：critic 合并后存在 CRITICAL/HIGH 发现 → 逐条派 `verifier` 做对抗验证
- **举证责任默认分配（GAN 式对抗，非「再查一遍」）**：发现默认视为成立；verifier 只有从 diff 明确证明「误报」且 confidence ≥ **0.8** 才允许建议清除阻塞项；`isReal=false 但 confidence < 0.8` ＝ 不确定，**一律留在 blocking**——不确定性永远不得降级阻塞项
- **fail-closed（对抗验证器不可用时该项留 blocking）**：verifier 挂掉 / 工具失败 / 超时 → 该项留在 blocking 并标「未对抗验证——kept as blocking」，不得降级为 advisory、不得静默跳过
- **实现层次（DP-4 已定论）**：本节为提示词约束 + verdict 后处理断言（critic 逐条核对 verdict 的 isReal/confidence 字段与清除清单一致）——**禁止写 schema 层**（DSH workflow 工具 schema 子集不含 allOf/if-then，DP-4 实测报 unsupported keyword，锚 PLAN-improvement §3.4 依赖图 DP-4 行）
- 产出：对抗验证结论并入 verdict.md（每条 CRITICAL/HIGH 标：confirmed / refuted(≥0.8) / uncertain(留 blocking) / unverified(留 blocking)）

### 3. 可选 code-simplifier（HIGH）——简化建议
- 触发：用户点名「顺便简化」或 critic 判定可读性问题显著
- 产出：行为不变的简化建议清单（写明「为什么等价」）；**落地交给 executor**，本技能不改码

### 4. 修复回路（可选，接 agent-feature/executor）
- **评测席 ≠ 产出席（GAN 纪律①）**：修复产出的新 diff 由独立评审席评判——产出会话（executor/修复会话）不得自评（「你的工作是建造不是评判，评判归 Evaluator」）；评审席只读、不得顺手改码
- **每轮换新鲜评审者**：修复后的每轮复评必须开**新评审会话**执行，不得复用上一轮评审会话——携带上一轮上下文会产生锚定偏差。复评任务书仍可带 `<confirmed_findings>`（约束重复，见下条）；成本注：新会话消耗快照注入预算（本机已知长流水线成本大头），复评轮次受重派熔断约束，不为新鲜性无限开新席
- **模型家族多样性显式标注**：并行双席/复评席尽量落不同模型家族（本机档位路由 HIGH 与非 HIGH 解析到不同模型，天然可得）；两席同家族时必须在 verdict 显式告警「真模型多样性未达成，但上下文隔离仍有效」，不得静默降级
- 增量评审的任务书必须带结构化 `<confirmed_findings>` 块：序号 + 文件 + 单行 code 摘要（≤200 字符）+ 单行结论摘要（≤300 字符），总量 ≤30 条，附否定式指令（「不要重复它们；继续在剩余面上找新发现，不得因清单存在而止步」）——该块约束的是**重复**，不是**范围**
- **免查需凭证**：免查项必须能在上一轮覆盖账找到 reviewed 记录**且**文件内容哈希未变，否则重评
- **重派熔断**：同一 P0 修复最多重派 2 次——第 2 次必须显式改写任务书（不许原样重派），第 3 次转记账交 critic 裁决；修复会话成功即清零计数
- **收尾宽限轮**：预算收紧时的最后一轮只许提交已识别的发现、不许新开分析面

## 评审面复用路由表
> 锚：`ecc-analysis/review/A-agents.md:241-246`（每加一个专项就重造席位＝反模式；ECC `agents/mle-reviewer.md:32-47` 的 11 行路由同型）+ network-architect「Handoff To Focused Skills」原则＝深挖交给专门面，不在评审提示里自造 runbook。
> 本表是**唯一**派席依据：什么评审对象默认派哪席在此定死；**新增角色/席位一律先改本表再投入使用**（批次3 新角色人格必含同型「评审面复用」节并回指本表）。禁止绕开本表在任务书里临时造席。

| 评审对象（触发特征） | 默认派席 | 备注 |
|---|---|---|
| 逻辑正确性 / 错误处理 / 反模式 / SOLID / 性能 | code-reviewer | 常驻两席之一 |
| 安全面（OWASP / 密钥 / 注入 / 危险模式） | security-reviewer | 常驻两席之一；触发判据按 §1「F-3 实测修正」（路径/文件类型优先） |
| 跨切面发现（同时踩质量+安全两域） | security-reviewer | 按 §1 发现归属表定席 |
| 语言专项（py/ts/go/kotlin/rust/cs/cpp 习惯与陷阱） | code-reviewer + `personas/checklists/<lang>.md` | 按扩展名路由，不建语言专项席（A 报告既定方向） |
| 视觉/UI 交付保真 | critic 强制走 `visual-verdict` 技能 | 现有技能非角色（GAN 纪律③） |
| 数据库 / SQL / 迁移面 | security-reviewer（数据迁移风险声明）+ `personas/checklists/sql.md` | 清单落位后生效 |
| RAG / 检索管线 | rag-reviewer（HIGH，只读；批次3 波1 已建席 2026-09-29） | 与 scientist 边界写死：检索配置与评估覆盖归 rag-reviewer，统计推断归 scientist；人格含 guji 本地条款 G-1..G-5 |
| brownfield 规格提取 | spec-miner（HIGH，只读；批次3 波2 已建席 2026-09-29） | 产出约定：<repo>/specs/<capability>/spec.md + id 锚纪律；与 analyst（前瞻设计）/explore（代码勘察）边界：只做「从既有代码提取规格」 |
| 静默失败专项（绿了但漏跑） | silent-failure-hunter（MEDIUM，只读；批次3 波1 已建席 2026-09-29） | 可作第 5 席并行盲评（入 BLIND_ROLES）；「沉默即通过」专项 SP-1..5；最终席位编排以组织者与任务书为准（非排他） |
| 文档一致性（新契约/门禁需持久文档） | critic 在盲区清单提示 → 由组织者派 `writer`/`document-specialist` | 不占评审席 |
| harness/流水线演进评测 | harness-optimizer（HIGH，读写限插件/技能/预设面；批次3 波2 已建席 2026-09-29） | 含 eval-harness 内联化素材（三类 Grader/pass@k-pass^k/反模式/最佳实践）；DSH 等价物先行（pwsh 只读清单） |

## 合并判定（v2：双轨正交，分列输出）
- **交付等级**（由覆盖闭合度决定）：complete（分母全 reviewed）/ partial（有 skipped/blocked/waived 且理由齐备——必须列明未覆盖范围与原因）/ failed（有缺项或结构错误）。partial 不是失败，但必须显式声明，不得沉默。
- **席位级 fail-closed**：任一席位没跑成（盲评席失败/被跳过/对抗验证席不可用）⇒ verdict **永不 clean APPROVE**，与该席位本来会发现什么无关——「没跑」与「跑了没问题」必须分得清清楚楚。席位失败的记录进交付等级 failed，且失败席位的覆盖分母整体转 skipped(理由=席位失败+复跑方式)，不得伪装 reviewed
- **合并阻塞**（由发现严重度决定）：P0 清零 + P1 全部有处置 + critic verdict 通过 + §2b 对抗验证无「uncertain/unverified 留 blocking」项 → 可合并；任一 P0 未修 → 不通过，输出阻断清单
- **覆盖状态 ≠ complete 时不得给出 APPROVE**；两轨在 verdict.md 中分列
- skipped 项不得计入通过项：「已验证通过」与「未验证（skipped）」必须分列

## 触发方式
- 「评审这些改动」「code review」「帮我审一下」「合并前检查」「安全审查这些文件」
- 或其他 agent 工作流的 Phase 4 需要加强评审火力时被调用

## 纪律
- 盲评是核心：两条任务书不得提及对方存在与输出
- 派席只认路由表：新增/调整席位一律改「评审面复用路由表」（单一事实源），禁止任务书临时造席
- 对抗验证与席位失败一律 fail-closed（§2b / 合并判定席位级条款），禁静默降级为 advisory
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
