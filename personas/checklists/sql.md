# SQL/数据库评审清单（code-reviewer v2 伴随资产）

> 总原则：precision over recall。与语言清单叠加加载（不互斥），发现同等定级。
> 来源：ECC agents/database-reviewer.md:69-90（锚 :74）全量保真提炼（【适配】只加头部映射与行内标注，未删原文语义）。

## 所有权边界

- 适用：.sql 文件加载；其他语言文件中出现 SQL/ORM 查询模式时与该语言清单叠加加载。
- 分工：数据库反模式与 schema/查询复查项归本清单；通用注入防线归通用清单安全节（两侧双查不冲突，取更严者）；发现同等定级。

## 一、反模式清单（Anti-Patterns to Flag）

1. 生产代码中的 `SELECT *`
2. ID 用 `int`（用 `bigint`）；无理由的 `varchar(255)`（用 `text`）
3. 无时区的 `timestamp`（用 `timestamptz`）
4. 随机 UUID 作主键（用 UUIDv7 或 IDENTITY）
5. 大表上的 OFFSET 分页
6. 未参数化查询（SQL 注入风险）
7. 给应用用户 `GRANT ALL`
8. RLS 策略逐行调用函数（未包 `SELECT`）

## 二、复查清单（Review Checklist）

- 所有 WHERE/JOIN 列已建索引
- 复合索引列序正确
- 数据类型恰当（bigint、text、timestamptz、numeric）
- 多租户表已启用 RLS
- RLS 策略使用 `(SELECT auth.uid())` 模式
- 外键已建索引
- 无 N+1 查询模式
- 复杂查询跑过 EXPLAIN ANALYZE
- 事务保持短小

## 三、评审动作

- 命中即按通用清单定级；每条发现附 file:line + 逐字证据（人格 <Positioning_Integrity> 三级校验）。
- 反模式清单为「命中即报」；复查清单为「逐项核对、未核对项入覆盖账」，不得以沉默表示复查通过。
- 本清单以 PostgreSQL/Supabase 语境为源（ECC 原文如此），其他数据库按语义映射后套用，映射差异在发现中注明。
- 本清单未覆盖的数据库模式按通用清单处理；可提议补条目。
