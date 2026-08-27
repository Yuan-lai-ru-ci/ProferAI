#!/usr/bin/env node
/**
 * 准备当前宿主平台的 Bun runtime。
 *
 * electron-builder 在目标平台 runner 上执行本脚本：
 * - darwin-arm64 → bun-darwin-aarch64.zip → resources/vendor/bun/bun
 * - darwin-x64   → bun-darwin-x64.zip → resources/vendor/bun/bun
 * - win32-x64    → bun-windows-x64.zip → resources/vendor/bun/bun.exe
 *
 * 优先复用版本和 SHA-256 均匹配的本地 Bun；找不到时下载固定版本的 ZIP，
 * 校验 ZIP 和二进制后再写入资源目录。解压和路径处理不依赖 Windows 专用命令。
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).proma?.bun
const version = config?.version
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || !config?.targets || typeof config.targets !== 'object') {
  throw new Error('apps/electron/package.json 中 proma.bun.version / targets 配置无效')
}

const PLATFORM_TARGETS = {
  'darwin-arm64': { archive: 'bun-darwin-aarch64.zip', binary: 'bun' },
  'darwin-x64': { archive: 'bun-darwin-x64.zip', binary: 'bun' },
  'win32-x64': { archive: 'bun-windows-x64.zip', binary: 'bun.exe' },
}

function getPlatformTarget(platform = process.platform, arch = process.arch) {
  const platformArch = `${platform}-${arch}`
  const target = PLATFORM_TARGETS[platformArch]
  if (!target) throw new Error(`不支持的 Bun 平台架构: ${platformArch}`)
  const checksums = config.targets[platformArch]
  if (!checksums || !/^[a-f0-9]{64}$/i.test(checksums.sha256 || '') || !/^[a-f0-9]{64}$/i.test(checksums.binarySha256 || '')) {
    throw new Error(`apps/electron/package.json 缺少 ${platformArch} 的 Bun SHA-256 配置`)
  }
  return {
    platformArch,
    archive: target.archive,
    binary: target.binary,
    sha256: checksums.sha256.toLowerCase(),
    binarySha256: checksums.binarySha256.toLowerCase(),
  }
}

const target = getPlatformTarget()
const vendorDir = path.join(appRoot, 'resources', 'vendor', 'bun')
const destination = path.join(vendorDir, target.binary)
const expectedVersion = version
const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${target.archive}`

function getVersion(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function getSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function findLocalBunCandidates() {
  const binaryName = target.binary
  const candidates = [
    process.execPath,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, binaryName) : null,
    path.join(os.homedir(), '.bun', 'bin', binaryName),
  ].filter(Boolean)
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(command, ['bun'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    candidates.push(...output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))
  } catch { /* PATH 中没有 bun */ }
  return [...new Set(candidates)]
}

function findVerifiedLocalBun() {
  for (const candidate of findLocalBunCandidates()) {
    if (!fs.existsSync(candidate) || getVersion(candidate) !== expectedVersion) continue
    if (getSha256(candidate).toLowerCase() !== target.binarySha256) continue
    return candidate
  }
  return null
}

function download(urlString, filePath, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error(`下载重定向过多: ${urlString}`))
  return new Promise((resolve, reject) => {
    const request = https.get(urlString, {
      headers: { 'User-Agent': 'Profer-build/1.0' },
      timeout: 120_000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume()
        resolve(download(new URL(response.headers.location, urlString).toString(), filePath, redirects + 1))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`下载 Bun 失败: HTTP ${response.statusCode}`))
        return
      }
      const output = fs.createWriteStream(filePath)
      response.pipe(output)
      output.on('finish', () => output.close(resolve))
      output.on('error', reject)
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('下载 Bun 超时')))
    request.on('error', reject)
  })
}

async function downloadWithRetries(filePath) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.rmSync(filePath, { force: true })
      await download(url, filePath)
      return
    } catch (error) {
      lastError = error
      fs.rmSync(filePath, { force: true })
      if (attempt < 3) {
        const delayMs = attempt * 1_000
        console.warn(`[prepare:bundled-bun] 第 ${attempt} 次下载失败，${delayMs}ms 后重试: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

function extractArchive(archive, extracted) {
  fs.mkdirSync(extracted, { recursive: true })
  if (process.platform === 'win32') {
    const archiveArg = archive.replace(/'/g, "''")
    const extractedArg = extracted.replace(/'/g, "''")
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -LiteralPath '${archiveArg}' -DestinationPath '${extractedArg}' -Force`,
    ], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-o', '-j', archive, '-d', extracted], { stdio: 'inherit' })
  }
}

function findExtractedBinary(extracted) {
  const matches = []
  const stack = [extracted]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.name === target.binary) matches.push(fullPath)
    }
  }
  if (matches.length !== 1) throw new Error(`Bun ZIP 中预期找到 1 个 ${target.binary}，实际找到 ${matches.length} 个`)
  return matches[0]
}

async function main() {
  // 先检查目标文件，避免清理 vendorDir 时把唯一可复用的 Bun 删除。
  if (fs.existsSync(destination) && getVersion(destination) === expectedVersion && getSha256(destination).toLowerCase() === target.binarySha256) {
    if (target.binary !== 'bun.exe') fs.chmodSync(destination, 0o755)
    console.log(`[prepare:bundled-bun] ${target.platformArch} Bun ${expectedVersion} 已就绪: ${destination}`)
    return
  }

  // 在清理旧平台产物前解析本机 Bun；当构建机只通过当前 PATH 提供 Bun 时，
  // 不能先删除 vendorDir 再尝试从那里查找。
  const localBun = findVerifiedLocalBun()
  fs.rmSync(vendorDir, { recursive: true, force: true })
  fs.mkdirSync(vendorDir, { recursive: true })

  if (localBun) {
    fs.copyFileSync(localBun, destination)
    if (target.binary !== 'bun.exe') fs.chmodSync(destination, 0o755)
    console.log(`[prepare:bundled-bun] 使用已校验的 ${target.platformArch} Bun ${expectedVersion}: ${destination}`)
    return
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profer-bun-'))
  const archive = path.join(tempDir, target.archive)
  const extracted = path.join(tempDir, 'extracted')
  try {
    console.log(`[prepare:bundled-bun] 下载 ${target.platformArch} Bun ${version}...`)
    await downloadWithRetries(archive)
    const actualSha256 = getSha256(archive).toLowerCase()
    if (actualSha256 !== target.sha256) {
      throw new Error(`Bun ZIP SHA-256 不匹配: expected ${target.sha256}, received ${actualSha256}`)
    }

    extractArchive(archive, extracted)
    const source = findExtractedBinary(extracted)
    fs.copyFileSync(source, destination)
    if (target.binary !== 'bun.exe') fs.chmodSync(destination, 0o755)

    const installedVersion = getVersion(destination)
    const installedSha256 = getSha256(destination).toLowerCase()
    if (installedVersion !== expectedVersion || installedSha256 !== target.binarySha256) {
      throw new Error(`Bun 安装后校验失败: version expected ${expectedVersion}, received ${installedVersion ?? '无法执行'}; binary SHA-256 expected ${target.binarySha256}, received ${installedSha256}`)
    }
    console.log(`[prepare:bundled-bun] ${target.platformArch} Bun ${installedVersion} 已验证并写入: ${destination}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[prepare:bundled-bun] ${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = { getPlatformTarget, PLATFORM_TARGETS }
