---
name: visual-verdict
description: 视觉判定技能（visual-verdict，全量移植自 OMC 同名）：对生成截图与参考图做结构化对比，输出**只含 JSON** 的严格 verdict——score 0-100 整数、verdict（pass/revise/fail）、category_match、differences[]（具体视觉失配：布局/间距/排版/颜色/层级）、suggestions[]（与 differences 一一对应的可执行下一步编辑）、reasoning（1-2 句）；通过线 score ≥90 且 verdict=pass，低于线必须继续编辑并重跑判定，新截图过线前不得把视觉任务当完成；category_match 判定生成图是否命中目标 UI 风格类；像素级 diff（pixelmatch 类）仅作定位热点的辅助调试，判定与停止权始终在 JSON 契约。触发：任务带视觉保真要求（布局/间距/排版/组件样式）且已有生成截图与至少一张参考图，需要确定性 pass/fail 判据再继续编辑时。
---

# 视觉判定（visual-verdict）

> 全量移植自 OMC visual-verdict v5.4.0（77 行，近 1:1）。OMC→DSH 映射：截图生成用 playwright（DSH 沙箱内驱动进程需 danger-full-access 提权）；verdict 落盘 `docs/verify/visual-verdict-{slug}.json`（不用 `.verify/` 临时目录——DSH 跨回合会清空临时目录，verdict 必须跨回合可追溯）。

## 目的
把生成 UI 截图与一张或多张参考图对比，返回可驱动下一轮编辑的严格 JSON verdict。

## 何时用
- 任务带视觉保真要求（布局、间距、排版、组件样式）
- 手里有生成截图 + 至少一张参考图
- 需要确定性 pass/fail 判据再继续编辑

## 输入
- `reference_images[]`：一张或多张参考图路径
- `generated_screenshot`：当前输出图路径
- 可选 `category_hint`：目标风格类（如 `hackernews`、`sns-feed`、`dashboard`、`落地页`）

## 输出契约（只输出这个 JSON，形状完全一致）
```json
{
  "score": 0,
  "verdict": "revise",
  "category_match": false,
  "differences": ["..."],
  "suggestions": ["..."],
  "reasoning": "short explanation"
}
```

规则：
- `score`：整数 0-100
- `verdict`：短状态（`pass` / `revise` / `fail`）
- `category_match`：生成截图命中预期 UI 类别/风格时为 `true`
- `differences[]`：具体的视觉失配（布局、间距、排版、颜色、层级），禁止「整体有点不像」式空话
- `suggestions[]`：与 differences 对应的可执行下一步编辑（带方向与量级，如「导航项水平 padding +4px」）
- `reasoning`：1-2 句概述

## 阈值与循环
- 通过线 **score ≥ 90**。
- `score < 90`：继续编辑 → **重跑本判定**，然后才进入下一轮视觉评审。
- 下一张截图过线之前，**不得**把视觉任务当完成。
- verdict JSON 每轮落盘 `docs/verify/visual-verdict-{slug}.json`（可加轮号后缀），跨回合可追溯，防「记得上次 88 分」式凭记忆。

## 调试可视化
失配诊断困难时：
1. 本技能的 JSON verdict 始终是**权威判定**
2. 像素级 diff 工具（pixel diff / pixelmatch overlay）只作**辅助调试**定位热点
3. 把像素 diff 热点转写成具体的 `differences[]` 与 `suggestions[]` 更新

## 示例
```json
{
  "score": 87,
  "verdict": "revise",
  "category_match": true,
  "differences": [
    "顶部导航间距比参考图紧",
    "主按钮字重偏小"
  ],
  "suggestions": [
    "导航项水平 padding 增加 4px",
    "主按钮 font-weight 设为 600"
  ],
  "reasoning": "核心布局一致，但风格细节仍有偏差。"
}
```

## DSH 操作要点
1. 截图：playwright 驱动（提权）；多视口/多状态页要分别截图分别判定，verdict JSON 带视口/状态标注
2. 读图：`read_image` 分别读参考图与生成图后对比
3. 落盘：JSON 写 `docs/verify/`，编辑循环引用上一轮 verdict 的 suggestions 作为编辑输入
4. 判定纪律：differences 必须可操作；写不出对应 suggestion 的 difference 说明还没看懂差异，先定位再报

任务：{{ARGUMENTS}}
