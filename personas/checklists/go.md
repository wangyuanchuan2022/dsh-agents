# Go 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall——每条都应可指认到具体代码模式；误报消耗评审者信任。本清单与通用清单合并使用，发现同等定级。引用时格式：`[严重度] file:line - Go: <条目名>`。

## 所有权边界

- 适用：仅被评文件扩展名为 .go 时加载与套用；其他文件不得引用本清单条款。
- 分工：Go 特有缺陷归本清单；通用安全/逻辑正确性/代码质量/性能/最佳实践归 code-reviewer 通用清单；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、并发与 goroutine（裁定依据级：命中 CRITICAL/HIGH 候选）

1. **typed nil 塞进接口**：返回类型为接口时，error 分支 `return err` 却返回了非 nil 的具体类型零值（`var r *MyErr = nil; return r`）——接口非 nil 但值为 nil。识别：接口返回类型的函数里 `return 具体指针变量`。修复：直接 `return nil`。
2. **sync 原语按值拷贝**：含 Mutex/WaitGroup 的 struct 按值传参/赋值（拷贝了锁）。识别：函数参数、range 循环变量、返回值中携带 sync 字段。修复：传指针；`go vet` copylocks 可查。
3. **goroutine 泄漏**：`go func` 内阻塞在无缓冲 channel 收发或 `for { select }` 上，无 ctx 取消/退出路径。修复：ctx.Done() 守卫或 buffered channel。
4. **循环内 defer**：`for` 循环体内 `defer f.Close()` ——资源攒到函数结束才释放。修复：抽函数或显式 Close。
5. **map 并发读写**：多个 goroutine 读写同一 map 无锁（runtime 致命错）。修复：sync.RWMutex 或 sync.Map。
6. **double close / send on closed channel**：多方 close 同一 channel；向已 close 的 channel 发送。修复：close 权归属唯一发送方。

## 二、错误处理（裁定依据级）

7. **err 遮蔽**：内层作用域 `err :=`（非 `=`）新建变量，外层检查的是旧 err。识别：if/for 内 `err :=` 且函数尾部 `return err`。
8. **错误未包装或用 %v**：`fmt.Errorf("ctx: %v", err)` 断链——调用方 `errors.Is/As` 失效。修复：`%w`。
9. **忽略 err**：`json.Unmarshal`/`file.Close()`/`strconv.Atoi` 返回值丢弃。识别：调用后无 if err。
10. **defer 与命名返回值交互**：defer 里 `retErr = ...` 悄悄覆盖显式 return。识别：命名返回值 + defer 修改。
11. **panic/recover 当控制流**：库代码 panic 而非返回 error。

## 三、切片与 map

12. **切片别名共享底层数组**：`b := a[:n]` 后 append(b,…) 改写了 a 的元素。修复：显式 copy 或 full slice expr `a[:n:n]`。
13. **子切片钉住大数组**：从大 slice 取小段长期持有，GC 无法回收底层数组。修复：copy。
14. **nil map 写入**：`var m map[K]V` 未 make 即赋值（panic）。识别：包级/返回的 map 零值直接写。
15. **range 复用变量**：Go 1.21 及以下 `for _, v := range` 取 `&v`（1.22+ 已按次迭代，按 go.mod 版本判定是否构成缺陷）。

## 四、类型与数值

16. **单形式类型断言**：`v := x.(T)` 失败即 panic。修复：comma-ok 形式。
17. **整数转换截断/回绕**：int64→int32、uint 相减下溢。识别：显式 T(x) 且取值域未校验。
18. **time.After 在循环里**：每次迭代新建定时器，未触发前不回收，紧密循环内存堆积。修复：time.NewTicker。
19. **math/rand 用于安全场景**：token/ID 用全局 rand。修复：crypto/rand。
20. **context 存进 struct**：ctx 应作首参传递；库代码用 context.Background() 而非接收调用方 ctx。

## 五、结构与惯例

21. **init() 重活**：init 里做 IO/注册网络/可能 panic——测试与库消费者被绑架。
22. **接口污染**：消费方定义的大接口（>3 方法）迫使实现者膨胀；Go 惯例是"接口定义在使用方、小接口"。
23. **测试共享可变 fixture**：t.Parallel 下并行用例共享同一份可变数据；TestMain 里不还原全局状态。

## 六、错误处理——静默失败五类

【来源：ECC silent-failure-hunter.md 五类 Hunt Targets 全量保真；与「二、错误处理」的语言机制条互补——那里是 Go 机制坑，这里是静默失败反模式视角】对静默失败零容忍：

1. **空错误处理**：`_ = err` 或被忽略的 error；错误被转成 nil/零值切片且无上下文。
2. **不充分日志**：日志缺足够上下文；严重度用错；log-and-forget 式处理。
3. **危险回退**：掩盖真实失败的默认值；err 存在却返回空结果继续跑；看似优雅的路径让下游 bug 更难诊断。
4. **错误传播问题**：丢失栈（`fmt.Errorf("%v", err)` 断链）；泛化重抛；goroutine 内错误无处安放。
5. **缺失错误处理**：网络/文件/DB 路径无 timeout 或错误处理（http.Client 无 Timeout）；事务性工作无回滚。

## 七、评审动作

- 以上条目命中即按通用清单定级（安全/逻辑类 CRITICAL-HIGH，惯例类 MEDIUM-LOW）。
- 每条发现必须落到 file:line 并附逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 本清单未覆盖的 Go 模式按通用清单处理；可提议补条目（报告尾部「清单增补建议」）。
