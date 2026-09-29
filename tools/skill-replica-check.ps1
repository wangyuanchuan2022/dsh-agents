# skill-replica-check.ps1 v1.0.0
# Three-way skill replica consistency check (repo source vs install roots B/C).
# Read-only. Exit codes: 0 = all MATCH; 2 = any DRIFT/MISSING/UNKNOWN; 1 = usage/environment error.
# Usage: powershell -File tools\skill-replica-check.ps1 [-RepoRoot <path>] [-VerboseReport]
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$VerboseReport
)
$ErrorActionPreference = "Stop"
$mapPath = Join-Path (Join-Path $RepoRoot "skills") "replica-map.json"
if (-not (Test-Path $mapPath)) { Write-Output "[FAIL] replica-map.json not found: $mapPath"; exit 1 }
$map = Get-Content $mapPath -Raw -Encoding UTF8 | ConvertFrom-Json
$srcRoot = Join-Path $RepoRoot "skills"
$repoSkills = Get-ChildItem $srcRoot -Directory | Select-Object -ExpandProperty Name
$mapped = @()
foreach ($root in @("B","C")) { $mapped += $map.map.$root }
$unknown = $repoSkills | Where-Object { $mapped -notcontains $_ }
$drift = 0; $missing = 0; $checked = 0; $match = 0
foreach ($root in @("B","C")) {
    $installBase = $map.installRoots.$root
    foreach ($skill in $map.map.$root) {
        $srcDir = Join-Path $srcRoot $skill
        $dstDir = Join-Path $installBase $skill
        if (-not (Test-Path $srcDir)) { Write-Output "[FAIL] repo skill missing: $skill"; $missing++; continue }
        if (-not (Test-Path $dstDir)) { Write-Output "[DRIFT] install root $root missing skill dir: $skill"; $missing++; continue }
        $srcFiles = Get-ChildItem $srcDir -Recurse -File
        foreach ($f in $srcFiles) {
            $rel = $f.FullName.Substring($srcDir.Length).TrimStart("\","/")
            $dstFile = Join-Path $dstDir $rel
            $checked++
            if (-not (Test-Path $dstFile)) { Write-Output "[MISSING] $root/$skill/$rel"; $missing++; continue }
            $h1 = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            $h2 = (Get-FileHash $dstFile -Algorithm SHA256).Hash
            if ($h1 -ne $h2) { Write-Output "[DRIFT] $root/$skill/$rel"; $drift++ } elseif ($VerboseReport) { Write-Output "[MATCH] $root/$skill/$rel" } else { $match++ }
        }
        $dstFiles = Get-ChildItem $dstDir -Recurse -File
        foreach ($f in $dstFiles) {
            $rel = $f.FullName.Substring($dstDir.Length).TrimStart("\","/")
            if (-not (Test-Path (Join-Path $srcDir $rel))) { Write-Output "[EXTRA] $root/$skill/$rel (not in repo source)"; $drift++ }
        }
    }
}
$unknownCount = ($unknown | Measure-Object).Count
foreach ($u in $unknown) { Write-Output "[UNKNOWN] repo skill not mapped to any install root: $u" }
$bad = $drift + $missing + $unknownCount
Write-Output ("SUMMARY: files_checked=$checked match=$match drift=$drift missing=$missing unknown=$unknownCount bad_total=$bad -> exit " + $(if ($bad -gt 0) { 2 } else { 0 }))
if ($bad -gt 0) { exit 2 } else { exit 0 }
