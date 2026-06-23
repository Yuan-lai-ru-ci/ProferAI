# Upload Profer Windows update files to the domestic update server.
# Usage: run from apps/electron: powershell -File .\scripts\upload-update.ps1

$ErrorActionPreference = "Stop"

$outDir = "out"
$server = "ecs-user@47.109.108.57"
$remoteDir = "/home/ecs-user/profer-updates"
$nginxDir = "/usr/share/nginx/html/profer-updates"
$feedUrl = "http://47.109.108.57/profer-updates/latest.yml"
$stagingDir = Join-Path $outDir "update-upload"

$yml = "$outDir\latest.yml"

if (-not (Test-Path $yml)) {
  Write-Error "latest.yml not found"
  exit 1
}

function Get-YamlValue([string]$path, [string]$key) {
  $line = Get-Content $path | Where-Object { $_ -match "^\s*$key\s*:\s*(.+?)\s*$" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$key\s*:\s*", "").Trim().Trim("'").Trim('"')
}

function Compare-VersionString([string]$left, [string]$right) {
  $leftParts = $left.Split(".") | ForEach-Object { [int]$_ }
  $rightParts = $right.Split(".") | ForEach-Object { [int]$_ }
  $max = [Math]::Max($leftParts.Count, $rightParts.Count)
  for ($i = 0; $i -lt $max; $i++) {
    $l = if ($i -lt $leftParts.Count) { $leftParts[$i] } else { 0 }
    $r = if ($i -lt $rightParts.Count) { $rightParts[$i] } else { 0 }
    if ($l -gt $r) { return 1 }
    if ($l -lt $r) { return -1 }
  }
  return 0
}

function Get-WebText([string]$url) {
  $content = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10).Content
  if ($content -is [byte[]]) {
    return [Text.Encoding]::UTF8.GetString($content)
  }
  return [string]$content
}

function Invoke-NativeCommand([string]$command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$manifestVersion = Get-YamlValue $yml "version"
$manifestPath = Get-YamlValue $yml "path"

if (-not $manifestVersion -or -not $manifestPath) {
  Write-Error "latest.yml is missing version or path"
  exit 1
}

$appAsar = Join-Path $outDir "win-unpacked\resources\app.asar"
if (-not (Test-Path $appAsar)) {
  Write-Error "$appAsar not found. Run bun run dist:win-commercial first."
  exit 1
}

$verifyScript = @'
const asar = require('@electron/asar')
const [archive, expectedVersion] = process.argv[1] === '-'
  ? process.argv.slice(2)
  : process.argv.slice(1)
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
const main = asar.extractFile(archive, 'dist/main.cjs').toString('utf8')

if (pkg.version !== expectedVersion) {
  throw new Error(`Packaged version ${pkg.version} does not match latest.yml ${expectedVersion}`)
}

if (!main.includes('http://47.109.108.57/profer-updates/')) {
  throw new Error('Packaged app does not include the commercial update feed')
}

const commercialTargetLiteral = 'false ? "oss" : "commercial"'
const commercialTargetReturn = 'return target === "commercial" ? "commercial" : "oss"'
if (!main.includes(commercialTargetLiteral) || !main.includes(commercialTargetReturn)) {
  throw new Error('Packaged app is not a commercial build and may use GitHub Releases')
}
'@

Write-Host "Checking packaged update target..."
$verifyScript | node - $appAsar $manifestVersion
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

# electron-builder manifests must match the uploaded artifact names exactly.
$manifestExe = if ($manifestPath) { Join-Path $outDir $manifestPath } else { $null }
$fallbackExe = Get-ChildItem "$outDir\Profer*Setup*$manifestVersion*.exe" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($manifestExe -and (Test-Path -LiteralPath $manifestExe)) {
  $exe = Get-Item $manifestExe
} elseif ($fallbackExe) {
  $exe = $fallbackExe
} else {
  Write-Error "Installer $manifestPath not found. Run bun run dist:win-commercial first."
  exit 1
}

$blockmap = "$($exe.FullName).blockmap"
if (-not (Test-Path $blockmap)) {
  Write-Error "Blockmap not found: $blockmap"
  exit 1
}

$remoteVersion = $null
try {
  $remoteLatest = Get-WebText $feedUrl
  $remoteVersionLine = $remoteLatest -split "`n" | Where-Object { $_ -match "^\s*version\s*:" } | Select-Object -First 1
  if ($remoteVersionLine) {
    $remoteVersion = ($remoteVersionLine -replace "^\s*version\s*:\s*", "").Trim().Trim("'").Trim('"')
  }
} catch {
  Write-Warning "Cannot read remote latest.yml, skipping remote version comparison: $($_.Exception.Message)"
}

if ($remoteVersion -and (Compare-VersionString $manifestVersion $remoteVersion) -le 0) {
  Write-Error "latest.yml version $manifestVersion is not newer than remote version $remoteVersion"
  exit 1
}

Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

$stagedExe = Join-Path $stagingDir $manifestPath
$stagedBlockmap = "$stagedExe.blockmap"
$stagedYml = Join-Path $stagingDir "latest.yml"

Copy-Item $exe.FullName $stagedExe -Force
Copy-Item $blockmap $stagedBlockmap -Force
Copy-Item $yml $stagedYml -Force

Write-Host "Uploading files to $server ..."
Write-Host "  $manifestPath"
Write-Host "  latest.yml"
Write-Host "  $($manifestPath).blockmap"

Invoke-NativeCommand "scp" @($stagedExe, "${server}:${remoteDir}/")
Invoke-NativeCommand "scp" @($stagedYml, "${server}:${remoteDir}/latest.yml")
Invoke-NativeCommand "scp" @($stagedBlockmap, "${server}:${remoteDir}/")

$publishCommand = "set -e; mkdir -p $nginxDir; cp $remoteDir/* $nginxDir/; echo update-files-deployed-to-nginx"
Invoke-NativeCommand "ssh" @($server, "sudo sh -c '$publishCommand'")

Write-Host "Done. Update feed: $feedUrl"
