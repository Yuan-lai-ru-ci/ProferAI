# Profer 更新文件上传脚本
# 将 Windows 安装包和 latest.yml 上传到国内更新服务器
# 用法: .\scripts\upload-update.ps1

$ErrorActionPreference = "Stop"

$outDir = "out"
$server = "ecs-user@47.109.108.57"
$remoteDir = "/home/ecs-user/profer-updates"
$nginxDir = "/usr/share/nginx/html/profer-updates"

# 找到最新的 exe
$exe = Get-ChildItem "$outDir\Profer Setup *.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) {
  Write-Error "未找到安装包，请先运行 electron-builder --win"
  exit 1
}

$yml = "$outDir\latest.yml"
$blockmap = "$exe.blockmap"

if (-not (Test-Path $yml)) {
  Write-Error "未找到 latest.yml"
  exit 1
}

Write-Host "上传文件到 $server ..."
Write-Host "  $($exe.Name)"
Write-Host "  latest.yml"
Write-Host "  $($blockmap | Split-Path -Leaf)"

# 上传到用户目录
scp $exe.FullName "${server}:${remoteDir}/"
scp $yml "${server}:${remoteDir}/latest.yml"
if (Test-Path $blockmap) {
  scp $blockmap "${server}:${remoteDir}/"
}

# 复制到 nginx 目录
ssh $server "mkdir -p $nginxDir && cp $remoteDir/* $nginxDir/ && echo '更新文件已部署到 nginx'"

Write-Host "完成! 更新地址: http://47.109.108.57/profer-updates/latest.yml"
