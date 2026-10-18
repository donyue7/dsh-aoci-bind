# install.ps1 — 把 dsh-aoci-bind 装进一个 DSH profile（可完整卸载）
#
# 做两件事：
#   1. 复制包到 <profile>/node_modules/dsh-aoci-bind
#   2. 在 <profile>/cordis.patch.yml 的标记注释之间写入挂载行（写前备份）
#
# 用法：
#   pwsh -NoProfile -File scripts/install.ps1
#   pwsh -NoProfile -File scripts/install.ps1 -Profile desktop
#   pwsh -NoProfile -File scripts/install.ps1 -Uninstall
#
# 注意：profile 补丁会被运行中的 DSH 热加载，但新增的 Host 行是否生效取决于
# 你的 DSH 版本；如未生效，重启一次 DSH（本脚本不会替你重启）。
param(
  [string]$Profile,
  [string]$ProfileDir,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$packageDir = Split-Path -Parent $PSScriptRoot

$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh-harness-next' }
if (-not $Profile) { $Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' } }
if (-not $ProfileDir) {
  $ProfileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $homeDir "profiles\$Profile" }
}
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$target = Join-Path $ProfileDir 'node_modules\dsh-aoci-bind'

$begin = '# >>> dsh-aoci-bind (managed by scripts/install.ps1) >>>'
$end = '# <<< dsh-aoci-bind (managed by scripts/install.ps1) <<<'
$block = @(
  $begin,
  '- insert:',
  '    - id: aoci-bind',
  "      name: 'dsh-aoci-bind'",
  $end
)

Write-Output "home       : $homeDir"
Write-Output "profile    : $Profile"
Write-Output "profile dir: $ProfileDir"
Write-Output "patch file : $patchFile"

if (-not (Test-Path $ProfileDir)) { throw "profile 目录不存在: $ProfileDir" }

# 读现有补丁（可能不存在），并去掉旧的托管块
$lines = @()
if (Test-Path $patchFile) { $lines = @(Get-Content $patchFile) }
$kept = New-Object System.Collections.Generic.List[string]
$inside = $false
foreach ($line in $lines) {
  if ($line.Trim() -eq $begin) { $inside = $true; continue }
  if ($line.Trim() -eq $end) { $inside = $false; continue }
  if (-not $inside) { $kept.Add($line) }
}

if (Test-Path $patchFile) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$patchFile.bak-dsh-aoci-bind-$stamp"
  Copy-Item $patchFile $backup
  Write-Output "已备份     : $backup"
}

if ($Uninstall) {
  Set-Content -Path $patchFile -Value ($kept -join "`n") -Encoding UTF8
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Write-Output '已卸载：挂载行与安装目录都已移除。'
  exit 0
}

# 安装：复制包
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in @('lib', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE')) {
  $source = Join-Path $packageDir $item
  if (-not (Test-Path $source)) { continue }
  Copy-Item $source (Join-Path $target $item) -Recurse -Force
}

# 写挂载行
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $kept) { if ($line -ne '') { $out.Add($line) } }
if ($out.Count -gt 0) { $out.Add('') }
foreach ($line in $block) { $out.Add($line) }
Set-Content -Path $patchFile -Value ($out -join "`n") -Encoding UTF8

Write-Output "已安装     : $target"
Write-Output "已写入挂载 : $patchFile"
Write-Output ''
Write-Output '提示：新增 Host 行可能需要重启 DSH 才会出现在会话工具表；本脚本不重启 DSH。'
