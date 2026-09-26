# PyTorch 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与语言清单（python.md）叠加加载（不互斥），发现同等定级。
> 来源：ECC agents/pytorch-build-resolver.md:99-106（锚 :105）全量保真提炼（【适配】只加头部映射与行内标注，未删原文语义）。

## 所有权边界

- 适用：被评 Python 文件含 torch 导入或张量操作时，与 python.md 叠加加载；纯后端 Python 不套用。
- 分工：训练/张量/显存特有缺陷归本清单；Python 通用缺陷归 python.md；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、关键原则（Key Principles）

1. **只做外科手术式修复**——不重构，只修错误。
2. **绝不改模型架构**，除非错误本身要求。
3. **绝不未经批准用 `warnings.filterwarnings` 静音警告**。
4. **总是验证张量形状**——修复前后各一次（形状验证）。
5. **总是先用小批量测试**（`batch_size=2`）（小批量优先）。
6. **修根因优先于压症状**。

## 二、常见伴随模式（ECC 同文记忆修复建议）

7. 验证循环未包 `with torch.no_grad():`（显存浪费/梯度泄漏）。
8. 缺 `del tensor; torch.cuda.empty_cache()` 的显存回收点。
9. 该开未开梯度检查点：`model.gradient_checkpointing_enable()`。
10. 该用未用混合精度：`torch.cuda.amp.autocast()`。

## 三、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 形状类发现（shape mismatch）必须给出两侧张量的实际形状与期望形状推导，不接受「形状可能不匹配」式表述。
- OOM 类发现按 ECC Stop Conditions 口径呈现：`batch_size=1` 仍 OOM → 建议更小模型或梯度检查点，不硬修。
- 本清单未覆盖的 PyTorch 模式按通用清单处理；可提议补条目。
