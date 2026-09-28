# 性能评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与语言清单叠加加载（不互斥），发现同等定级。

## 所有权边界

- 分区适用：第一节 Web Vitals 阈值【仅 Web 前端交付物适用】；第二节复杂度对照【全栈通用】。阈值只在对应分区栈内生效，跨栈套用即误报。
- 分工：性能阈值与复杂度信号归本清单；具体语言的性能缺陷实现归语言清单；发现同等定级。

## 一、Web Vitals 阈值表【仅 Web 前端适用】

| 指标 | 目标 | 超标动作 |
|---|---|---|
| First Contentful Paint | < 1.8s | 优化关键路径，内联关键 CSS |
| Largest Contentful Paint | < 2.5s | 图片懒加载，优化服务端响应 |
| Time to Interactive | < 3.8s | 代码分割，减少 JavaScript |
| Cumulative Layout Shift | < 0.1 | 为图片预留空间，避免布局抖动 |
| Total Blocking Time | < 200ms | 拆分长任务，使用 web workers |
| Bundle Size (gzipped) | < 200KB | tree shaking，懒加载，代码分割 |

## 二、复杂度对照【全栈通用】

| 模式 | 复杂度 | 更优替代 |
|---|---|---|
| 同一数据上的嵌套循环 | O(n²) | 用 Map/Set 做 O(1) 查找 |
| 循环内重复数组搜索 | 每次搜索 O(n) | 转为 Map O(1) |
| 循环内排序 | O(n² log n) | 循环外排序一次 |
| 循环内字符串拼接 | O(n²) | 用 array.join() |
| 深克隆大对象 | 每次 O(n) | 浅拷贝或 immer |
| 无记忆化的递归 | O(2^n) | 加 memoization |

## 三、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 性能发现定级沿用人格 <Performance_Review_Mode>：CRITICAL（影响生产）/ HIGH（可测量的退化）/ LOW（轻微）。
- 阈值类发现必须注明测量口径缺失风险（无 profile 数据时置信度降档呈现，不虚构实测数字）。
- 本清单未覆盖的性能模式按通用清单处理；可提议补条目。
