# skills/ — 双装机根互补分工说明

> 2026-09-29 S1 巡检实证确立（三方 25/25 MATCH；起因=「哪件装哪根」此前无任何文件记录，「该装而未装」无机检可拦）。

## 装机模型

- **源副本**：本目录（dsh-agents 仓 skills/，git 管理）——唯一编辑入口。
- **装机副本两根，互补分工（互不重叠）**：
  - **B 根** `~/.agents/skills/`：10 件（四流水线 + 路由 + 协作协议类）
  - **C 根** `~/.dsh/skills/`：13 件（其余全部）
- **单一事实源**：`replica-map.json`（本目录）——新增技能入仓时**必须**同步登记其装机根，否则机检判 UNKNOWN。

## 机检（改动 skills/ 后必跑）

```powershell
powershell -File tools\skill-replica-check.ps1
```

- 全 ASCII 输出，GBK 控制台安全；
- 退出码：0 = 全 MATCH；2 = 存在 DRIFT/MISSING/UNKNOWN/EXTRA；
- 改动源副本后的标准同步流程：改仓内文件 → 跑本机检（会报 DRIFT）→ 提权 Copy-Item 到对应装机根 → 复跑机检回 0 → git commit。
