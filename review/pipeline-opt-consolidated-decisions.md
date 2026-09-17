# 流程优化审查 · 三向合成决议清单（待用户拍板）

- 组织者：session-1766c134-a4b1-4f1f-a408-8c361544a8e4 · 2026-09-13 合成
- 依据：A 提示词清洁（review\pipeline-opt-A-prompt-cleanliness.md）/ B OMC 保真（pipeline-opt-B-omc-fidelity.md）/ C 时长结构（pipeline-opt-C-runtime.md）
- 三向裁定一致：**REVISE**——系统底子扎实（19/19 角色名册与 OMC 全量相等、译稿 19/19 逐字节保真、双条件一次通过率 100%），缺陷集中在**派生环节（提取器/组装）、少数误导条款、流程串行结构、模型档位配置**四类。

## 批次一：工程侧确定性 P0（四连修，零争议）

| # | 缺陷 | 修法 | 改动面 |
|---|---|---|---|
| A-P0-1 | persona.js:20-33 剥 frontmatter 只剥首段 → 19 份任务书双模型声明 | loadPersona 循环剥块 | 插件代码 1 处 |
| A-P0-2 | 只读角色卡断言「write/edit 被禁用」与 README 矛盾（DSH 无按会话禁工具设施） | 改述为「只读纪律约束」 | 角色卡文本 |
| B-P0-1 | install-personas.mjs:44-46 行首锚定切分把 document-specialist 在 `## 调研：` 处截断（28→16 标签） | 提取器终止条件改只认 `## 适配清单`/`## 译制说明` + 安装期标签数断言 + 重跑；**配套硬规则（B-P2-11 同根）**：BRIEF 与安装器之间确立「凡影响运行时行为的存疑项/适配说明必须写成行内 `【适配：】`，不得只写在适配清单/译制说明」 | 插件代码 + BRIEF + 重新生成 |
| B-P0-2 | requirement-interview:336 新增「主会话直接执行」与 :339「不得闷头实现」互斥（OMC 明令禁止） | 删选项 3，:18 表注明执行选项固定三项 | 技能文本 2 处 |

## 批次二：人格正文/死文本删减（动人格卡，需用户批准）

1. **A-P0-3** scientist 卡 OMC python_repl 沙箱封锁条款（DSH 无此设施，分析能力被砍空）→ 映射为 DSH 等价说明或删除
2. **A-P0-4** planner 卡 OMC「等用户 proceed」协议（子会话形态无执行对象）→ 改写为 DSH 形态
3. **A-P1-2** 「effort 继承…本条忽略」死条款 18 份 × 6 种写法 → 清理
4. （保真评估：以上均为「DSH 无对应设施的 OMC 宿主残留」，属映射范畴非违规精简；review/original 底本不动）

## 批次三：流程结构与技能修复批（建议全做，A3 默认不采纳）

- A1 用户门前移 5-10min；**A2 P3∥P4 双评审并行 8-9min**（需基线哈希门）；A4 **报告路径唯一化**（taskbook.js 自动加步骤后缀 + stamp 秒精度）2-4min 消除审计隐患【优先】；A5 可预置裁决进缺省决策表；A6 禁 Select-Object 截断（杜绝同会话重跑）；A7 完成自证块（deliverable_verify 机检）；A9 只读角色批量工具纪律
- B 向技能修复：autopilot QA 循环恢复 5 轮+早停（P1-2）、Phase 4 补「何时加派 critic/architect」判据（P1-3）、Phase 5 披露替代说明（P1-4）、consensus-plan 补 changelog 子流程与 never-implement（P1-5/6）、技能映射表 4/5 补齐（P1-7）、requirement-interview 补 3.5 节与阈值口径（P1-8/9）、溯源哈希域统一（P1-1，采用 raw_hash 改名方案）
- A 向冗余清理：工具映射表按人格过滤（省 7%）、模板 v2 与自动节去重、SKILL.md 重复行
- **A3（writer∥verifier 并行 8min）默认不采纳**——README「亲手复跑」属性与质量权衡，留观察
- 组织者裁决备案：B-P0-1 维持 P0（畸形产物+静默+结构性可达）；consensus-plan Review Quality Criteria 表记 P2 backlog；subagent-clarify 非移植对象不计缺陷

## 批次四：模型档位 A/B（潜在最大杠杆，需立项）

- 实测：设置卡 LOW 与 MEDIUM 同指 glm-pro/glm-5.3-flash（三档退化二元）；deepseek-flash 吞吐 3.7× 于 glm-5.3-flash，而关键路径 4/5 会话在慢侧
- 选项：① 立项 A/B（一条小型流水线样本，MEDIUM 换 deepseek-flash 对照质量与时长）② 直接改设置卡（快但质量未验）③ 暂不动
- 注意：这是**用户设置卡的配置问题**，非插件缺陷；A/B 结论需 2-3 条样本

## 总账

- 提速：结构批 32-48min（13-20%）+ 模型 A/B 潜在 30-70min；token：低风险压缩 ~12.6%/run（≈1.3 万 tokens）
- 明确不做：B1 增量验证（净亏）、B2 verifier 并入 test-engineer（消灭独立取证）、B8 砍 Phase 0、裁阶段数
- 实施顺序建议：批次一（半天）→ 批次三（一天）→ 批次二（随批次三）→ 批次四（立项后单独跑）

## 处置记录（用户 2026-09-13 拍板）

- 批次一：**四连修执行**
- 批次二：**执行**（scientist 映射改写 + planner 改写 + 18 份 effort 死条款清理；底本不动）
- 批次三：**只做 A2（P3∥P4 双评审并行，含基线哈希门）+ A4（报告路径唯一化 + stamp 秒精度）**；A1/A3/A5/A6/A7/A9 及 B 向 P1 修复、A 向其余冗余清理 → 全部登记缓办
- 批次四：**暂不动**（LOW/MEDIUM 同模型现状维持；deepseek-flash 3.7× 数据留档备查）
