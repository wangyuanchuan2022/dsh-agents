# TypeScript/JavaScript 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与通用清单合并使用，发现同等定级。覆盖 .ts/.tsx/.js/.jsx/.mjs/.cjs。

## 所有权边界

- 适用：仅被评文件扩展名为 .ts/.tsx/.js/.jsx/.mjs/.cjs 时加载与套用；其他文件不得引用本清单条款。
- 分工：TypeScript/JavaScript 特有缺陷归本清单；通用安全/逻辑正确性/代码质量/性能/最佳实践归 code-reviewer 通用清单；框架专属条款按「六、框架适用分区」归属；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、异步与 Promise（裁定依据级）

1. **浮动 Promise**：async 函数调用未 await/未 .catch（`fetch()` 丢弃）——静默吞 rejection。识别：语句位置的表达式调用返回 Promise。修复：await 或显式 void 标注 + 错误处理。
2. **forEach 里 await**：`arr.forEach(async x => await f(x))` 不等待、异常不传播。修复：for...of 或 Promise.all(map)。
3. **async throw 无捕获**：事件处理器/定时器里的 async 函数 throw → unhandledRejection。修复：try/catch 或 .catch。
4. **循环内顺序 await 本可并行**：for...of 中 await 独立请求串行化（性能缺陷，MEDIUM）。修复：Promise.all（注意并发上限）。
5. **new Promise 反模式**：把已是 Promise 的调用包进 new Promise（executor 内 throw 会被吞为 reject 之外的行为）。修复：直接 async/await。

## 二、类型安全

6. **不安全断言**：`x as T` 无运行时依据；`x as unknown as T` 双跳板绕过检查器。识别点=外部输入边界（API 响应、JSON.parse 结果）。
7. **any 传染**：公共函数参数/返回 any；any 变量继续传播。修复：unknown + 收窄。
8. **运行时边界无校验**：JSON.parse/外部响应直接当业务对象用。修复：zod/手写守卫至少校验关键字段。
9. **结构类型意外兼容**：两个语义不同但字段同形的类型互赋（缺 brand/tag）。修复：品牌类型或判别字段。
10. **泛型约束过弱**：`<T>` 上无约束却访问 T 的属性——实际是 any 逃逸。

## 三、运行时行为

11. **== 隐式转换**：`x == null` 之外一律 ===；`==` 比较 0/''/false 相互为真。
12. **?? 与 || 混淆**：`||` 对 0/''/false 误回退（`count || default` 在 count=0 时取 default）。修复：??（仅 null/undefined 回退）。
13. **optional chaining 断链**：`a?.b.c` —— b 短路后 c 段行为与预期不符（整链 undefined vs 中段 throw 的混用）；`.map()`/`.filter()` 链在 undefined 上照常 throw。
14. **Array.sort 默认字典序**：数字数组 `[10,9,1].sort()` → [1,10,9]。修复：sort((a,b)=>a-b)。
15. **parseInt 无 radix / NaN 传播**：`parseInt("08")` 老引擎八进制坑；NaN 参与比较恒 false 静默走错分支。
16. **Date 可变性**：setXxx 原地修改共享 Date；时区拼接字符串（`toISOString().slice(0,10)` 的 UTC 偏移）。

## 四、资源与状态

17. **监听器/定时器泄漏**：addEventListener/setInterval 无对应清理（React：useEffect 缺 cleanup return——该部分仅 React 适用）。
18. **共享可变模块状态**：模块级可变量被多处导入修改；函数默认参数为对象/数组（每次调用共享？不——默认参数每次求值，但跨闭包捕获的可变量是真共享）。
19. **React 陈旧闭包**（仅 React 适用）：setState 后立即读旧 state；useEffect 依赖数组漏项读到旧值。修复：函数式 setState / 完整依赖。
20. **原型污染**：以用户输入作对象键合并（`obj[userKey] = ...`，键 `__proto__`）。修复：Map 或 null-prototype。

## 五、模块与工程

21. **循环依赖**：A import B、B import A（初始化顺序拿到 undefined）。识别：模块顶层互相引用并使用。
22. **顶层 await 在 CJS/浏览器入口的兼容**；动态 import() 路径拼接用户输入（注入面）。
23. **enum 与 isolatedModules**：const enum 跨模块在单文件转译下失效。

## 六、框架适用分区

框架专属条款先探测框架标志（package.json 依赖、import 语句），探测不到对应框架时按该文件的语言通用条款评审，报告记 framework=unresolved，不得凭猜测套用框架条款【适配：ECC java-reviewer.md「两者都探测不到 → 只用通用规则并注明歧义」】。

### 仅 React 适用

- #17 的 React 部分（useEffect 缺 cleanup return）与 #19 React 陈旧闭包，仅在检测到 React 时套用；非 React 项目不得引用这两条。

### 仅 Vue 适用

24. **`:href` / `:src` 动态绑定未验证用户 URL**【来源：ECC vue-reviewer.md:58】：`javascript:` 与 `data:` scheme 会执行代码。所有接受 URL 的动态属性绑定要求 URL scheme 校验。仅在检测到 Vue 时套用。

## 七、类型设计四问

【来源：ECC type-design-analyzer.md 四维评估全量保真】对新增或重构的类型/接口逐条自问，四问全为「否」或存疑时记 LOW/MEDIUM 发现：

1. **封装**：内部细节是否隐藏？不变量能否从类型外部被破坏？
2. **不变量表达**：类型是否编码了业务规则？不可能的状态是否在类型层被阻止？
3. **不变量有用性**：这些不变量是否阻止真实 bug？是否与领域对齐？
4. **强制执行**：不变量是否由类型系统强制？是否存在容易的逃逸口（as 断言、any）？

## 八、错误处理——静默失败五类

【来源：ECC silent-failure-hunter.md 五类 Hunt Targets 全量保真】对静默失败零容忍：

1. **空 catch 块**：`catch {}` 或被忽略的异常；错误被转成 `null`/空数组且无上下文。
2. **不充分日志**：日志缺足够上下文；严重度用错；log-and-forget 式处理。
3. **危险回退**：掩盖真实失败的默认值；`.catch(() => [])`；看似优雅的路径让下游 bug 更难诊断。
4. **错误传播问题**：丢失栈；泛化重抛；缺失 async 处理。
5. **缺失错误处理**：网络/文件/DB 路径无 timeout 或错误处理；事务性工作无回滚。

## 九、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据。
- 外部输入边界（HTTP/文件/环境变量）上的类型断言优先级高于纯内部转换。
- 本清单未覆盖的模式按通用清单处理；可提议补条目。
