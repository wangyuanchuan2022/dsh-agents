# publish-sync-check.ps1 — 公开仓同步幂等 diff 门（consensus-plan v3 步骤 8.5 同步三件套之一）
# 语义：本地 HEAD 与 origin/master 部署面零差异 = in-sync（exit 0 跳过）；有差异 = 列出文件并 exit 1。
# 触发时机：改动部署面文件（git 跟踪的 skills/personas/lib/tools/tests/docs/根文件）后的发布动作前。
# 用法：powershell -ExecutionPolicy Bypass -File tools\publish-sync-check.ps1 [-RepoRoot <path>]
# 说明：本脚本仅检查 git 同步状态，不做任何写操作（幂等）；fetch 失败按 FAIL 处理（fail-loud）。
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

# fetch（失败即响亮——同步检查建立在最新远端引用上，陈旧引用的 in-sync 是假绿）
# PS5 陷阱：git 进度输出走 stderr，2>&1 捕获在 EAP=Stop 下会当异常抛——走 cmd /c 静默取退出码。
cmd /c "git fetch origin master >nul 2>&1"
$fetchExit = $LASTEXITCODE
if ($fetchExit -ne 0) {
  Write-Output "[FAIL] git fetch origin master failed (exit $fetchExit)"
  exit 1
}

$ahead = [int](git rev-list origin/master..HEAD --count)
$behind = [int](git rev-list HEAD..origin/master --count)

if ($ahead -eq 0 -and $behind -eq 0) {
  Write-Output "publish-sync: in-sync (local HEAD == origin/master)"
  exit 0
}

if ($ahead -gt 0) {
  Write-Output "[PENDING] local HEAD is $ahead commit(s) ahead of origin/master; changed files:"
  git diff --name-only origin/master...HEAD | ForEach-Object { "  - $_" }
  Write-Output "action: review then 'git push origin master' to publish"
  exit 1
}

if ($behind -gt 0) {
  Write-Output "[BEHIND] local HEAD is $behind commit(s) behind origin/master; files changed upstream:"
  git diff --name-only HEAD...origin/master | ForEach-Object { "  - $_" }
  Write-Output "action: git pull --ff-only (or reconcile)"
  exit 1
}
