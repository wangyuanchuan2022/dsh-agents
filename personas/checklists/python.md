# Python 评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与通用清单合并使用，发现同等定级。覆盖 .py。

## 所有权边界

- 适用：仅被评文件扩展名为 .py 时加载与套用；其他文件不得引用本清单条款。
- 分工：Python 特有缺陷归本清单；通用安全/逻辑正确性/代码质量/性能/最佳实践归 code-reviewer 通用清单；Django 专属条款仅 Django 项目适用；发现同等定级，归属冲突按「更具体者拥有」裁决。

## 一、默认值与共享状态（裁定依据级）

1. **可变默认参数**：`def f(x=[])` / `def f(d={})` —— 默认值在函数定义时创建一次，跨调用共享。识别：默认值为 list/dict/set/对象。修复：None 哨兵 + 函数体内新建。
2. **类属性可变共享**：`class C: items = []` —— 所有实例共享同一 list。修复：`__init__` 内实例化；dataclass 用 `field(default_factory=list)`。
3. **闭包晚绑定**：`[lambda: i for i in range(3)]` 全部引用同一个 i（循环变量）。修复：默认参数钉值 `lambda i=i:`。
4. **`list * n` 浅复制**：`[[0] * n] * m` —— m 行是同一个 list 的引用。修复：列表推导逐行新建。
5. **迭代时修改容器**：遍历 dict/list 时增删元素（RuntimeError 或静默跳过）。修复：遍历副本 `list(d.items())`。

## 二、异常与资源（裁定依据级）

6. **裸 except / except Exception: pass**：吞掉 KeyboardInterrupt/SystemExit，吞掉真实缺陷。修复：精确异常类型；至少记日志。
7. **finally 吞异常**：finally 里 return/raise 覆盖进行中的异常。
8. **资源未用 with**：open()、锁、连接未用上下文管理器（异常路径泄漏）。修复：with / contextlib.closing。
9. **assert 做运行时校验**：`python -O` 下 assert 被整体剥除——校验静默消失。修复：显式 if + raise。
10. **except 后重新 raise 丢失链**：`raise NewErr(...)` 应 `raise NewErr(...) from e`。

## 三、语言语义

11. **is 与 == 混用**：`x is None` 正确场景之外的 is 比较——小整数/驻留字符串偶然通过，其他全错。
12. **str/bytes 边界**：网络/文件读回 bytes 直接当 str 拼接（TypeError）或 encode 双重。
13. **// 与 / 与 round**：整数地板除负数（-7//2=-4）；round 银行家舍入（round(0.5)=0）。
14. **可变全局状态**：模块级 dict/list 被多函数修改且无锁；多线程下非原子复合操作（i+=1）。
15. **GIL 误用**：threading 跑 CPU 密集（无并行收益）；asyncio 事件循环里跑阻塞调用（requests、time.sleep、重 CPU）——整个循环卡死。修复：ProcessPoolExecutor / to_thread。
16. **chained comparison 副作用**：`a < f() < b` 中 f() 调用次数与顺序不直观。

## 四、安全（裁定依据级）

17. **SQL/命令注入**：字符串拼接/f-string 进 execute()、os.system、shell=True 的 subprocess。修复：参数化查询、参数数组、shlex.quote。
18. **pickle 反序列化不可信数据**：等价任意代码执行。修复：JSON 或限定来源。
19. **eval/exec 用户输入**；yaml.load 无 Loader 参数（yaml.safe_load）。
20. **临时文件竞态**：固定路径临时文件（可预测、可抢注）；mkdtemp 后 DACL/权限问题在多用户目录。

## 五、工程惯例

21. **可变类型注解默认**：`def f(x: list = [])` 与 #1 同源——注解场景 mypy 会报但运行时坑一致。
22. **循环内重复重活**：循环体内 re.compile、重复打开同一文件、重复查询不变量（性能 MEDIUM）。
23. **__del__ 依赖确定性清理**：解释器退出/引用环下不保证调用。修复：显式 close/with。
24. **测试污染全局**：测试改 os.environ/工作目录/chdir 不还原；pytest tmp_path 之外的落盘。

## 六、错误处理——静默失败五类

【来源：ECC silent-failure-hunter.md 五类 Hunt Targets 全量保真】对静默失败零容忍：

1. **空异常块**：`except: pass` 或被忽略的异常；错误被转成 `None`/空列表且无上下文。
2. **不充分日志**：日志缺足够上下文；严重度用错；log-and-forget 式处理。
3. **危险回退**：掩盖真实失败的默认值；`except Exception: return []`；看似优雅的路径让下游 bug 更难诊断。
4. **错误传播问题**：丢失栈（`raise NewErr(...)` 不带 `from e`）；泛化重抛；缺失 async 处理。
5. **缺失错误处理**：网络/文件/DB 路径无 timeout 或错误处理；事务性工作无回滚。

Django 附条【来源：ECC django-reviewer.md:72/:124，仅 Django 项目适用】：

6. **嵌套可写 serializer 无 `update()`**：默认 update 静默忽略嵌套数据。
7. **缺 `@pytest.mark.django_db`**：测试静默未连数据库。

## 七、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（三级定位自校验）。
- 类型注解仅作参考信号，不作为"有注解=类型安全"的依据；外部边界仍按 #8 校验。
- 本清单未覆盖的模式按通用清单处理；可提议补条目。
