---
name: dsh-troubleshooting
description: "触发：DSH 排障、没反应、假死、权限被拒、EPERM、乱码、子会话不动、无输出｜English: DSH troubleshooting, no output, permission denied, EPERM, mojibake｜DSH 运行排障症状索引（Symptom→Causes→Diagnostics 三段式）：子会话假 idle 与 429 配额耗尽、子进程管道 EPERM、PowerShell 5 管道二进制污染与 UTF-16 重定向、mkdtemp 权限坑、Start-Process 拒绝、心跳唤醒预算、cwd 基准面半覆盖、workdir ENOENT 假象等已实证症状的快速定位手册。当出现排障、诊断、症状定位、没反应、假死、无输出、权限被拒、EPERM、乱码、假空等情形时使用。首版 8 条，增量模式。"
---

# dsh-troubleshooting · DSH 排障症状索引

把散落在本机长期记忆（key 轨）里、多会话实证过的诊断配方归一为可检索的手册。每条目按三段式组织：

- **症状（Symptom）**：你在屏幕/日志上直接看到的表象
- **可能原因（Causes）**：已实证的根因清单（按命中率排序）
- **诊断（Diagnostics）**：验证根因的具体步骤 + 已验证的处置/替代写法

来源注记：每条末尾标注 key 轨条目日期与条目名，便于回溯原始上下文。

**版本口径：首版 8 条、增量模式**——不求全。新症状按同构追加（S 编号顺延、补来源注记），不重排旧条目。组织样式参照 ECC `TROUBLESHOOTING.md` 的 Memory & Context Issues 分节（Symptom/Causes/Solutions 三段式）。

---

## 一、会话与调度

### S1 · 子会话「假 idle」（实为 provider 429 配额耗尽）

**症状（Symptom）：** spawn 的子会话连续收到消息即转 idle、零磁盘产出、无任何广播——表象像「应酬式回合」，实际什么都没做。

**可能原因（Causes）：**
- （高发）provider 周配额/月配额耗尽：每回合 step/end 直接 RATE_LIMIT（429，如 glm-pro 周配额 429 code 1310「每周/每月使用上限」）
- 内容过滤（错误码 1301）或 provider 不稳定导致回合无声失败

**诊断（Diagnostics）：**
1. 读会话转录：`C:\Users\ycwan\.dsh\sessions\<工作区目录名>\session-<id>\session.jsonl.zstd`
2. python zstandard **必须用 `stream_reader`**（一次性 `decompress` 会报 `could not determine content size in frame header`）
3. 看 `turn/end` 的 `reason.error` 与 `llm/retry` 记录——429 一目了然

处置：给 provider 等配额重置或换路由；预防=调度大量同 provider 席位前先估配额余量。

**来源：** key 轨 2026-09-21「DSH 子会话假 idle = provider 配额耗尽事故与诊断配方」。

### S6 · 心跳/通知唤醒是有界的（第 4 次起「通知到了但会话不动」）

**症状（Symptom）：** 长任务巡检心跳连续投递几次后，通知仍到达但 idle 会话不再被唤醒开新回合，巡检链断。

**可能原因（Causes）：**
- tool-jobs 插件防自激设计：每会话连续由插件通知唤醒最多 `maxConsecutiveWakes`（默认 3）次，第 4 次起降级为「不唤醒注入」（next-step）
- 只有领取到**用户亲写消息**（`source.kind==="user"`）才重置预算

**诊断（Diagnostics）：**
1. session.jsonl.zstd 里查 `agent/inbox/spliced` 记录的 `target` 字段：`next-turn`=唤醒 / `next-step`=只注入
2. 心跳只保证「通知必达」（持久 inbox，永不丢失只延迟），不保证「即时唤醒」

处置：间隔按里程碑 ETA 弹性对齐；每轮加 +5h 长尾保险心跳防巡检回合崩死；同周期几分钟错峰双心跳无效（预算按会话计）；预算外通知下回合统一领取，把收尾核验并进最后一个醒着的回合。

**来源：** key 轨 2026-09-08「DSH 后台任务完成通知的唤醒是有界的（tool-jobs）」+ 2026-09-11「长任务子会话监控心跳机制」；全文 guji 项目 kb/docs/dsh_heartbeat_wake_budget.md。

### S8 · pwsh 工具报 node ENOENT（实为 workdir 目录不存在）

**症状（Symptom）：** pwsh 工具调用报 `Error: spawn C:\Program Files\nodejs\node.exe ENOENT`——看似宿主 node 环境坏了。

**可能原因（Causes）：**
- workdir 参数指向不存在的目录，工具先 cd 目标目录失败，报错形态误导到 node

**诊断（Diagnostics）：**
1. 先用**无 workdir** 的极简命令探针（`Write-Output probe`）确认工具健康
2. 健康即坐实是 workdir 问题：`New-Item` 建目录后重跑

实证：连续 3 次 ENOENT 皆此因，零次是 node 环境故障。

**来源：** key 轨 2026-09-19「DSH pwsh 工具的 workdir 参数指向不存在的目录时报 ENOENT 假象」。

## 二、沙箱与进程

### S2 · node 子进程 stdio:'pipe' 必 EPERM

**症状（Symptom）：** 沙箱内 node 脚本 spawn 子进程报 EPERM——`child_process.exec`、测试 runner 的内部 spawn、管道捕获全部中招。

**可能原因（Causes）：**
- Windows DSH 沙箱限制子进程命名管道捕获（`stdio:'pipe'`）

**诊断（Diagnostics）：**
1. `stdio:'inherit'` / `'ignore'` 可正常 spawn——先确认是「捕获」被拦而非「进程创建」被拦
2. 需要捕获输出时改用**文件描述符 stdio**：`openSync(log,'w')` 后 `spawn(cmd,{stdio:['ignore',fd,fd]})`——fd 直接继承不经命名管道，可正常聚合 stdout+stderr
3. Python `subprocess` 管道不受此限（MCP stdio 调用可通），EPERM 限于 node 的 pipe 捕获

**来源：** key 轨 2026-08-31「DSH Windows 沙箱进程限制」+ 2026-09-13「node 子进程输出捕获的合法替代（fd stdio）」。

### S3 · PowerShell 5 管道二进制污染与 UTF-16 重定向

**症状（Symptom）：** 三种形态：① `git show <blob> | python -c` 后哈希全变、字节数微变；② CLI 的 JSON 输出 `>` 重定向进文件后 python `json.load` 报 `UnicodeDecodeError (0xff)` 或 `Unexpected UTF-8 BOM`；③ 无 BOM UTF-8 含中文的 .ps1 直接运行报 ParserError（报错行号在注释之后很远，极具迷惑性），`Get-Content .Count` 行数比真实行数少。

**可能原因（Causes）：**
- PS5 把原生程序 stdout 按文本解码再重编码，静默污染二进制/UTF-8 内容（管道污染）
- PS5 `>` 重定向写 UTF-16LE（带 BOM 或纯 UTF-16）
- GBK 控制台按 GBK 解码无 BOM UTF-8，中文注释尾字节与下一行首字节配对吞掉换行/花括号

**诊断（Diagnostics）：**
1. 逐字节保真的 blob 级操作（git show/cat-file 哈希、二进制比对）：一律 python `subprocess.run([...], capture_output=True)` 直接捕获字节，或 `cmd /c` 重定向到文件——禁止经 PS 管道转交
2. 跨语言 JSON：PS5 侧禁写；已被污染的 JSON 用 `utf-8-sig` 读入后以无 BOM 重写；落盘后必须 python json.load 试载通过才算写完
3. .ps1 预防纪律：要么全 ASCII，要么存 UTF-8 with BOM；检查法=看前 3 字节 BOM + 非 ASCII 字节数；行数核对用字节级比对（SHA256）或 LF 计数，不用 PS5 Get-Content 计数

**来源：** key 轨 2026-09-20「PowerShell 5 管道的二进制污染」、2026-09-14「PS5 `>` 重定向写 UTF-16LE」、2026-09-17「PS5 + 无 BOM UTF-8 含中文 .ps1」、2026-09-19「Windows 跨语言 JSON 写入纪律」。

### S4 · tempfile.mkdtemp() 建出的目录不可用（0700 权限）

**症状（Symptom）：** 沙箱内 `mkdtemp` 建目录后，其内建子目录/写文件/rmdir/列目录一律 `PermissionError [WinError 5]`；把目录删掉后在**同一路径**重建也失败；`os.chmod(d, 0o777)` 无效。

**可能原因（Causes）：**
- mkdtemp 以 0700 权限建目录，受限进程令牌不满足该 DACL
- Windows 上 chmod 只切只读位、不改 DACL，救不回来

**诊断（Diagnostics）：**
1. 对照实验可复现：`os.mkdir(p, 0o700)` 同症状；`os.mkdir(p, 0o777)` 与 `os.makedirs` 默认权限完全正常
2. 工程写法：临时工作目录一律 `os.makedirs(os.path.join(tempfile.gettempdir(), 唯一名))`（或先 mkdtemp、写入失败时退回同父目录的兄弟目录）
3. 附带：探针目录一旦用 mkdtemp 建出，workspace-write 下删不掉，需提权才能清理

**来源：** key 轨 2026-09-14「DSH Windows 沙箱内 tempfile.mkdtemp() 建出的目录不可用」。

### S5 · 沙箱内 Start-Process 一律 Access denied

**症状（Symptom）：** workspace-write 沙箱下 PowerShell `Start-Process` 任意参数形态（含 -Wait/-PassThru）一律 Access denied；验收链整段跑不起来。

**可能原因（Causes）：**
- 沙箱拦截进程创建 API（与 Start-Process 参数无关）

**诊断（Diagnostics）：**
1. 可靠替代=**直调 & exe 逐条执行**（与前台同路径）
2. 输出捕获：`(cmd @args 2>&1 | Out-String)`；退出码取 `$LASTEXITCODE`；落盘用 `[System.IO.File]::WriteAllText(log, $text, [Text.UTF8Encoding]::new($false))`（`>` 重定向会写 UTF-16LE，见 S3）
3. 连带坑：沙箱 shell 内嵌套调用 pwsh（PowerShell 7）不可用（PATH 无 pwsh，CommandNotFoundException）——提权脚本里执行另一个 ps1 用 `& D:\path\script.ps1` 或 powershell.exe，不写 `pwsh -File`
4. 相关但不同：node 内 spawn 是 fd stdio 可解（见 S2）；进程创建类 API（Start-Process/计划任务 schtasks.exe）是真拦，用 PowerShell 原生 cmdlet（Register-ScheduledTask 等）

实证：Start-Process 版 8 步全灭，直调版同链路全绿。

**来源：** key 轨 2026-09-15「DSH 沙箱（workspace-write）下 Start-Process 一律 Access denied」+ 2026-09-14「沙箱 shell 内嵌套调用 pwsh 不可用」。

## 三、验收与交付

### S7 · 复现指引「字符串全绿但不可执行」（cwd 基准面半覆盖）

**症状（Symptom）：** 自检/门线把复现块「命令字符串逐条比对」全部判绿，但第三方按声明的 cwd 执行时命令 MISS（文件不存在/路径错）——指引实际不可用。

**可能原因（Causes）：**
- 复现块隐含一个「cwd 基准」声明，比对面只覆盖了命令字符串面，基准面未被比对覆盖
- 跨仓库/工作区两层的项目常混用多套相对基准（工作区根 / 仓库根 / artifact 包根），任一同基准下 ≥2 条命令即 MISS

**诊断（Diagnostics）：**
1. 验收必须加一条「**同一 cwd 下逐条 Test-Path / 实际执行**」的可执行性断言（不只是字符串比对）
2. 跨仓库项目显式声明基准是「checkout 仓库根」还是「artifact 包根」（两者可以不同）
3. 泛化教训：对账类自检要把「行内元素对了」与「整行/整块可用」区分开——逐数回读被引 artifact 的原始行

**来源：** key 轨 2026-09-19「交付验收自检的『比对面 vs 基准面』半覆盖模式」（paper-probe Stage 5 实证）。

---

## 追加新条目的模板

```
### S<n> · <症状一句话标题>

**症状（Symptom）：** <表象，含误导性错误文本原文>
**可能原因（Causes）：** <已实证根因，按命中率排序>
**诊断（Diagnostics）：** <1. 验证步骤 2. 已验证处置/替代写法>
**来源：** key 轨 <日期>「<条目名>」。
```

增量纪律：新条目追加到对应分节末尾；证据不足（只有一次未复现的猜测）不入册，先进 key 轨观察。
