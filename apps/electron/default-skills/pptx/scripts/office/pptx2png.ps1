# 把 .pptx 转成 PNG 用于视觉 QA。
# Windows 优先使用本机 PowerPoint COM；每页输出 1280x720 PNG。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File pptx2png.ps1 -InputPath demo.pptx -OutDir render
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$ppt = $null
$pres = $null

try {
  if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
    throw "找不到 PPTX 文件: $InputPath"
  }

  $InputPath = (Resolve-Path -LiteralPath $InputPath).Path
  if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path (Split-Path -Parent $InputPath) "render"
  }
  $OutDir = [System.IO.Path]::GetFullPath($OutDir)
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  $ppt = New-Object -ComObject PowerPoint.Application
  # PowerPoint COM 要求 MsoTriState（msoFalse = 0），不能传 PowerShell Boolean。
  $ppt.Visible = 0
  # PpAlertLevel：ppAlertsNone = 1；0 不是有效枚举值。
  $ppt.DisplayAlerts = 1
  # Open(FileName, ReadOnly, Untitled, WithWindow)
  $pres = $ppt.Presentations.Open($InputPath, $true, $false, $false)

  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $out = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    if (Test-Path -LiteralPath $out) {
      Remove-Item -LiteralPath $out -Force
    }
    $pres.Slides.Item($i).Export($out, "PNG", 1280, 720)
    if (-not (Test-Path -LiteralPath $out -PathType Leaf)) {
      throw "第 $i 页导出失败: $out"
    }
    Write-Output "exported $out"
  }

  Write-Output "DONE: $($pres.Slides.Count) slide(s) -> $OutDir"
}
catch {
  throw "PPTX Visual QA 渲染失败: $($_.Exception.Message)"
}
finally {
  if ($null -ne $pres) {
    try { $pres.Close() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) } catch {}
  }
  if ($null -ne $ppt) {
    try { $ppt.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
