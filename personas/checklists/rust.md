# Rust 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与通用清单合并使用，发现同等定级。覆盖 .rs。
> 来源：ECC agents/rust-reviewer.md:30-44 全量保真提炼（【适配】只加头部映射与行内标注，未删原文语义）。

## 所有权边界

- 适用：仅被评文件扩展名为 .rs 时加载与套用；其他文件不得引用本清单条款。
- 分工：Rust 特有缺陷归本清单；通用安全/逻辑正确性/代码质量/性能/最佳实践归 code-reviewer 通用清单；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、安全（裁定依据级）

1. **未检查的 unwrap()/expect()**：生产代码路径——用 `?` 或显式处理。
2. **unsafe 无正当理由**：缺 `// SAFETY:` 注释记录不变量。
3. **SQL 注入**：查询中的字符串插值——用参数化查询。
4. **命令注入**：`std::process::Command` 的输入未验证。
5. **路径穿越**：用户控制的路径未经 canonicalization 与前缀检查。
6. **硬编码密钥**：源码中的 API key、密码、token。
7. **不安全反序列化**：无 size/depth 限制地反序列化不可信数据。
8. **裸指针 use-after-free**：无生命周期保证的 unsafe 指针操作。

## 二、错误处理（裁定依据级）

9. **错误被静音**：对 `#[must_use]` 类型使用 `let _ = result;`。
10. **缺错误上下文**：`return Err(e)` 无 `.context()` 或 `.map_err()`。
11. **可恢复错误用 panic**：生产路径中的 `panic!()`、`todo!()`、`unreachable!()`。
12. **库用 `Box<dyn Error>`**：应改用 `thiserror` 做类型化错误。

## 三、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 机器检查（存在则跑、跑不了记 skipped）：cargo check / cargo clippy -- -D warnings / cargo fmt --check / cargo test。【适配：ECC 原文为评审前置步骤，DSH 侧按「存在则跑、跑不了记 skipped+复跑命令」执行】
- 本清单未覆盖的 Rust 模式按通用清单处理；可提议补条目（报告尾部「清单增补建议」）。
