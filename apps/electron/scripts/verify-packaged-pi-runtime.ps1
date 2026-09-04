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
  # GUI 子系统进程在 Windows PowerShell 中可能不回填 ExitCode；此时用探针的
  # 机器可读成功 JSON 与空 stderr 作为门禁，若 ExitCode 可用仍必须为 0。
  $process.Refresh()
  $out = if (Test-Path $stdout) { Get-Content -Raw $stdout } else { '' }
  $err = if (Test-Path $stderr) { Get-Content -Raw $stderr } else { '' }
  if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
    throw "packaged Pi runtime 闭包探针失败（exit $($process.ExitCode)）`n$out`n$err"
  }
  if (-not [string]::IsNullOrWhiteSpace($err)) {
    throw "packaged Pi runtime 闭包探针输出 stderr：`n$err"
  }
  try {
    $result = $out | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "packaged Pi runtime 闭包探针未输出有效 JSON：`n$out"
  }
  if ($result.ok -ne $true) {
    throw "packaged Pi runtime 闭包探针未报告成功：`n$out"
  }
  Get-Content $stdout
  Write-Host '[verify:packaged-pi-runtime] OK'
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
