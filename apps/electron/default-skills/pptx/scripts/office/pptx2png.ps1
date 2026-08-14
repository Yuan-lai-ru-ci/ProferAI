# 把 .pptx 转成 PNG 用于视觉 QA。
# 优先用本机 PowerPoint COM（渲染最还原），因工作区未装 LibreOffice/Poppler。
# 用法: powershell -File pptx2png.ps1 -InputPath demo.pptx -OutDir render
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [string]$OutDir = ""
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $InputPath)) { throw "找不到文件: $InputPath" }
$InputPath = (Resolve-Path $InputPath).Path
if ($OutDir -eq "") { $OutDir = Join-Path (Split-Path $InputPath) "render" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ppt = New-Object -ComObject PowerPoint.Application
$pres = $ppt.Presentations.Open($InputPath, $true, $false, $false)  # ReadOnly=true, WithWindow=false
try {
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    $out = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    $pres.Slides.Item($i).Export($out, "PNG", 1280, 720)
    Write-Output "exported $out"
  }
} finally {
  $pres.Close()
  $ppt.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
Write-Output "DONE"
