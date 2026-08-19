# 离线验证 Windows packaged Pi runtime 闭包。
# Profer.exe 是 GUI 子系统程序，PowerShell 的直接调用不会可靠等待，必须 Start-Process + Wait-Process。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appPath = Join-Path $root 'out/win-unpacked/Profer.exe'
$probePath = Join-Path $root 'scripts/packaged-pi-probe.cjs'
$resourcesPath = Join-Path $root 'out/win-unpacked/resources'

foreach ($path in @($appPath, $probePath, $resourcesPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "缺少 Pi runtime 闭包验证输入: $path"
  }
}

$stdout = Join-Path $root 'out/packaged-pi-probe.out.log'
$stderr = Join-Path $root 'out/packaged-pi-probe.err.log'
Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  $process = Start-Process -FilePath $appPath `
    -ArgumentList @($probePath, $resourcesPath) `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  try {
    Wait-Process -Id $process.Id -Timeout 120 -ErrorAction Stop
  } catch {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'Pi runtime closure probe timed out after 120s'
  }
  if ($process.ExitCode -ne 0) {
    $out = if (Test-Path $stdout) { Get-Content -Raw $stdout } else { '' }
    $err = if (Test-Path $stderr) { Get-Content -Raw $stderr } else { '' }
    throw "packaged Pi runtime 闭包探针失败（exit $($process.ExitCode)）`n$out`n$err"
  }
  if (Test-Path $stdout) { Get-Content $stdout }
  Write-Host '[verify:packaged-pi-runtime] OK'
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
