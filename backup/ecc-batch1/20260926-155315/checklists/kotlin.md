# Kotlin 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与通用清单合并使用，发现同等定级。覆盖 .kt/.kts。

## 一、语言陷阱（裁定依据级）

1. **表达式体函数内裸 return**：`fun f(): T = try { ... return x }` 编译错"Returns are not allowed for expression body"；更隐蔽的是函数体含早退分支（`?: return 默认值`）时必须块体化 `{ return try { ... } }`。识别：`= try`/`= if`/`= when` 开头且体内有 return。
2. **Java interop 平台类型**：从 Java 返回值直接当非空用（平台类型 `T!`，运行时 NPE）。识别：调用 Java API 链上无 ?. 的解引用。修复：显式可空标注或 ?.。
3. **!! 滥用**：非空断言把 NPE 从编译期挪到运行期。修复：?.let / requireNotNull（带消息）。
4. **when 不穷尽**：非 sealed 类型的 when 无 else 分支静默漏分支；对 enum 加新值时 when 编译器警告被忽略。修复：sealed hierarchy + 穷尽 when。
5. **forEach 里的非局部 return**：`list.forEach { return }` 返回的是外层函数（与 for 不同源直觉）；`return@forEach` 才是继续下一项。识别：forEach 内裸 return。
6. **lazy 默认线程安全模式**：lazy { } 默认 SYNCHRONIZED（热路径锁竞争）；多线程读的属性要显式选模式；LazyThreadSafetyMode.NONE 仅限单线程证明。
7. **data class 含数组/可变集合属性**：equals/hashCode/toString 基于数组引用（相同内容不等）与可变字段（作 key 后语义漂移）。

## 二、协程（裁定依据级）

8. **GlobalScope.launch**：生命周期不受管的协程——泄漏、取消不达。修复：结构化并发（viewModelScope/lifecycleScope/自定义 scope + cancel）。
9. **runBlocking 在生产路径**：阻塞线程等协程（Android 主线程/服务端 worker 死锁源）。仅测试与 main 可用。
10. **suspend 函数内阻塞调用**：suspend 里直接 File IO / Thread.sleep / 同步网络——阻塞调度线程。修复：withContext(Dispatchers.IO)。
11. **async 无 await / 异常吞没**：async 的异常在 await 时才抛，未 await 的失败静默；SupervisorJob 缺失导致一子失败全组取消。
12. **Flow 冷流副作用重复执行**：每次 collect 重新执行上游（网络/DB 重复调用）。修复：stateIn/shareIn 或显式说明。

## 三、空安全与作用域函数

13. **lateinit 生命周期**：lateinit 在初始化前被访问（UninitializedPropertyAccessException）； lateinit var 与可空 + by lazy 的取舍未说明。
14. **scope function 返回值混淆**：apply 返回 receiver、also 返回 receiver、let/run 返回 lambda 结果——链式后接错类型的调用。识别：`.apply { }` 结果被当转换值用。
15. **Elvis 与 require/check 语义错位**：数据合法性该用 require/check（IllegalArgumentException/IllegalState），拿 Elvis + throw IllegalStateException 混用使契约不可读。

## 四、结构与并发

16. **object 单例可变状态**：object 声明的可变属性被多线程读写（Kotlin 单例=进程级全局）。修复：不可变/加锁/收敛到依赖注入。
17. **companion object 持有重资源/Context**（Android）：静态持有 Activity/View 引用=泄漏。
18. **Sequence/List 链式误用**：同一 Sequence 多次终端操作（第二次为空）；小集合用 Sequence 反而更慢。
19. **inline + reified 边界**：reified 只在 inline 函数可用；inline 大函数体导致字节码膨胀（非 public inline 引用私有 API 的编译错另计）。
20. **value class 装箱**：value class 作可空/接口类型时装箱回退，性能预期失效。

## 五、评审动作

- 命中即按通用清单定级；#1/#8/#10/#11 属裁定依据级（CRITICAL/HIGH 候选）。
- 每条发现附 file:line + 逐字证据（三级定位自校验）。
- Android 相关条目（#8/#17）在非 Android 仓库按对应宿主语义映射（如 GUI 框架生命周期）。
- 本清单未覆盖的模式按通用清单处理；可提议补条目。
