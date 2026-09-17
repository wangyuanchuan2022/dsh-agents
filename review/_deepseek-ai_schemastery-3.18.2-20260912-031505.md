# 安全审查报告：@deepseek-ai/schemastery@3.18.2

- **判定：BLOCK — 建议阻断（未经用户明确批准不得安装）**
- 得分 9，阻断项 0（高危 3 / 中危 0 / 低危 0 / 信息 0）
- 来源：npm（tarball: https://registry.npmjs.org/@deepseek-ai/schemastery/-/schemastery-3.18.2.tgz）
- 扫描时间：2026-09-12T03:15:05.298Z；文件 8 个（扫描 8 个文本 / 108021 字节），耗时 1570 ms
- 仓库：git+https://github.com/deepseek-ai/deepseek-harness.git
- 包首次发布：2026-08-10T19:01:54.498Z；最近更新：2026-08-30T13:14:16.882Z；维护者：imccyu, tianyicui-deepseek

## 判定说明

- **BLOCK**：存在凭据/外传/混淆/装时执行等阻断级特征，或综合得分 ≥8。未经用户明确批准，**不得执行安装命令**。
- **REVIEW**：存在中低危发现（如子进程调用、动态加载、低下载依赖）。安装前必须把发现点呈现给用户确认。
- **PASS**：未发现值得注意的行为。仍建议用户知悉本次审查结论。

## 高危发现（3 条）

### [R-EVAL] 高危 — package/lib/index.cjs:42

动态求值（eval / 动态 Function / vm 执行）

```
schema.callback = new Function("return " + schema.callback)();
```

### [R-EVAL] 高危 — package/lib/index.mjs:42

动态求值（eval / 动态 Function / vm 执行）

```
schema.callback = new Function("return " + schema.callback)();
```

### [R-EVAL] 高危 — package/src/index.ts:261

动态求值（eval / 动态 Function / vm 执行）

```
schema.callback = new Function('return ' + schema.callback)()
```


## 中危发现

无。

## 低危 / 信息

无。

## 生命周期脚本

无生命周期脚本（安装阶段不会执行包内命令）。

## 依赖风险表（共 2 个；registry 存在 2；不存在 0；疑似仿冒 0；低下载 0；声明未使用 0）

| 依赖 | 类别 | registry | 周下载 | 疑似仿冒 | 说明 |
|---|---|---|---|---|---|
| @standard-schema/spec | dep | 存在 | 81677657 |  |  |
| @deepseek-ai/cosmokit | dep | 存在 | 545443 |  |  |


## 源码中的外联地址（1 个去重）

- https://github.com/deepseek-ai/deepseek-harness.git — package/package.json:10


## 二进制文件

无二进制文件。

## 密钥/证书文件

无密钥文件。

## 元数据

```json
{
  "target": "@deepseek-ai/schemastery",
  "source": "npm",
  "name": "@deepseek-ai/schemastery",
  "version": "3.18.2",
  "requestedVersion": "3.18.2",
  "description": "Type driven schema validator",
  "repository": "git+https://github.com/deepseek-ai/deepseek-harness.git",
  "maintainers": [
    "imccyu",
    "tianyicui-deepseek"
  ],
  "created": "2026-08-10T19:01:54.498Z",
  "modified": "2026-08-30T13:14:16.882Z",
  "versionsCount": 4,
  "tarballUrl": "https://registry.npmjs.org/@deepseek-ai/schemastery/-/schemastery-3.18.2.tgz",
  "scannedAt": "2026-09-12T03:15:05.298Z"
}
```