# C# 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与通用清单合并使用，发现同等定级。覆盖 .cs。

## 所有权边界

- 适用：仅被评文件扩展名为 .cs 时加载与套用；其他文件不得引用本清单条款。
- 分工：C#/.NET 特有缺陷归本清单；通用安全/逻辑正确性/代码质量/性能/最佳实践归 code-reviewer 通用清单；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、安全（裁定依据级）

1. **SQL 注入**：查询中字符串拼接/插值——用参数化查询或 EF Core。
2. **命令注入**：`Process.Start` 的输入未验证——校验并净化。
3. **路径穿越**：用户控制的文件路径——用 `Path.GetFullPath` + 前缀检查。
4. **不安全反序列化**：`BinaryFormatter`、`TypeNameHandling.All` 的 `JsonSerializer`。
5. **硬编码密钥**：源码中的 API key、连接串——用配置/secret manager。
6. **CSRF/XSS**：缺 `[ValidateAntiForgeryToken]`、Razor 输出未编码。

## 二、错误处理（裁定依据级）

7. **空 catch 块**：`catch { }` 或 `catch (Exception) { }`——处理或重抛。
8. **吞异常**：`catch { return null; }`——记上下文日志、抛特定异常。
9. **缺 `using`/`await using`**：手动 dispose `IDisposable`/`IAsyncDisposable`。
10. **阻塞 async**：`.Result`、`.Wait()`、`.GetAwaiter().GetResult()`——用 `await`。

## 三、异步模式（HIGH）

11. **公共 async API 缺 CancellationToken**。
12. **fire-and-forget**：`async void`（事件处理器除外）——返回 `Task`。

## 四、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 机器检查（存在则跑、跑不了记 skipped）：dotnet build / dotnet format --verify-no-changes。
- 本清单未覆盖的 C# 模式按通用清单处理；可提议补条目（报告尾部「清单增补建议」）。
