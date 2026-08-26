#!/usr/bin/env node
/**
 * 准备 Windows 安装包随附的 Bun runtime。
 *
 * 优先复用构建机上版本和 SHA-256 均匹配的 Bun；构建机本来就必须能运行 Bun，
 * 因此不会为每次打包增加网络依赖。若本机缺少匹配二进制，则从 oven-sh/bun 固定
 * release 下载 ZIP，校验 package.json 中锁定的 SHA-256 后解压 bun.exe 到
 * resources/vendor/bun/。该目录由 electron-builder.yml 原样写入安装包。
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
const expectedSha256 = config?.sha256?.toLowerCase()
const expectedBinarySha256 = config?.binarySha256?.toLowerCase()
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256) || !expectedBinarySha256 || !/^[a-f0-9]{64}$/.test(expectedBinarySha256)) {
  throw new Error('apps/electron/package.json 中 proma.bun.version / sha256 / binarySha256 配置无效')
}

const destination = path.join(appRoot, 'resources', 'vendor', 'bun', 'bun.exe')
const expectedVersion = version
const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-windows-x64.zip`

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
  const candidates = [
    process.execPath,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bun.exe') : null,
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
  ].filter(Boolean)
  try {
    const whereOutput = execFileSync('where.exe', ['bun'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    candidates.push(...whereOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))
  } catch { /* PATH 中没有 bun */ }
  return [...new Set(candidates)]
}

function findVerifiedLocalBun() {
  for (const candidate of findLocalBunCandidates()) {
    if (!fs.existsSync(candidate) || getVersion(candidate) !== expectedVersion) continue
    if (getSha256(candidate).toLowerCase() !== expectedBinarySha256) continue
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

async function main() {
  const existingVersion = fs.existsSync(destination) ? getVersion(destination) : null
  if (existingVersion === expectedVersion && getSha256(destination).toLowerCase() === expectedBinarySha256) {
    console.log(`[prepare:bundled-bun] Bun ${expectedVersion} 已就绪: ${destination}`)
    return
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })

  // 构建本身通常由 Bun 启动。只接受版本和 SHA-256 都匹配的本地 Bun，
  // 而非仅按版本信任 PATH 中的任意可执行文件。
  const localBun = findVerifiedLocalBun()
  if (localBun) {
    fs.copyFileSync(localBun, destination)
    console.log(`[prepare:bundled-bun] 使用已校验的本地 Bun ${expectedVersion}: ${localBun}`)
    return
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profer-bun-'))
  const archive = path.join(tempDir, 'bun-windows-x64.zip')
  const extracted = path.join(tempDir, 'extracted')
  try {
    console.log(`[prepare:bundled-bun] 下载 Bun ${version}...`)
    await downloadWithRetries(archive)
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Bun ZIP SHA-256 不匹配: expected ${expectedSha256}, received ${actualSha256}`)
    }

    fs.mkdirSync(extracted)
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extracted.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' })
    const source = path.join(extracted, 'bun-windows-x64', 'bun.exe')
    if (!fs.existsSync(source)) throw new Error(`Bun ZIP 中缺少预期文件: ${source}`)
    fs.copyFileSync(source, destination)

    const installedVersion = getVersion(destination)
    const installedSha256 = getSha256(destination).toLowerCase()
    if (installedVersion !== expectedVersion || installedSha256 !== expectedBinarySha256) {
      throw new Error(`Bun 安装后校验失败: version expected ${expectedVersion}, received ${installedVersion ?? '无法执行'}; binary SHA-256 expected ${expectedBinarySha256}, received ${installedSha256}`)
    }
    console.log(`[prepare:bundled-bun] Bun ${installedVersion} 已验证并写入: ${destination}`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[prepare:bundled-bun] ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
})
