#!/usr/bin/env node
/**
 * 验证 Windows 发布资产完整性。
 *
 * 仅检查本地 out/，不访问网络、不写入文件，可由本地发布与 CI 共用。
 * Windows 发布必须满足：latest.yml 的 SHA-512、版本、大小与 EXE 一致，
 * 并且随包 CLI 及运行时闭包完整。当前发布策略不使用代码签名。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { verifyPackagedWindowsCli } = require('./packaged-cli-contract.cjs')

const appRoot = path.resolve(__dirname, '..')
const out = path.join(appRoot, 'out')
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
const installerName = `Profer-Setup-${version}.exe`
const blockmapName = `${installerName}.blockmap`
const unsignedRelease = process.env.PROFER_UNSIGNED_RELEASE === '1'
const signatureName = 'latest.yml.sig'
const expected = unsignedRelease
  ? ['latest.yml', installerName, blockmapName]
  : ['latest.yml', signatureName, installerName, blockmapName]

for (const name of expected) {
  const filePath = path.join(out, name)
  if (!fs.existsSync(filePath)) throw new Error(`缺少 Windows 发布资产: ${filePath}`)
  if (fs.statSync(filePath).size <= 0) throw new Error(`Windows 发布资产为空: ${filePath}`)
  console.log(`[verify:release-assets] ${name} OK`)
}

const packagedCliPath = verifyPackagedWindowsCli(
  path.join(out, 'win-unpacked', 'resources', 'bin'),
)
console.log(`[verify:release-assets] ${path.relative(out, packagedCliPath)} OK`)

function parseLatestYml(text) {
  const versionMatch = text.match(/^version:\s*([^\r\n]+)$/m)
  const urlMatch = text.match(/^\s+- url:\s*(\S+)$/m)
  const hashMatch = text.match(/^\s+sha512:\s*(\S+)$/m)
  const sizeMatch = text.match(/^\s+size:\s*(\d+)$/m)
  if (!versionMatch || !urlMatch || !hashMatch || !sizeMatch) {
    throw new Error('latest.yml 缺少可验证的 version/url/sha512/size 元数据')
  }
  const versionValue = versionMatch[1].trim().replace(/^['"]|['"]$/g, '')
  const url = urlMatch[1]
  if (versionValue !== version || url !== installerName) {
    throw new Error(`latest.yml 版本或安装包名称不匹配: ${versionValue}, ${url}`)
  }
  return { sha512: hashMatch[1], size: Number(sizeMatch[1]) }
}

const metadata = parseLatestYml(fs.readFileSync(path.join(out, 'latest.yml'), 'utf8'))
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(metadata.sha512)) {
  throw new Error('latest.yml sha512 不是合法的 base64')
}
const installerPath = path.join(out, installerName)
const actualSize = fs.statSync(installerPath).size
if (metadata.size !== actualSize) {
  throw new Error(`latest.yml size 不匹配: metadata=${metadata.size}, actual=${actualSize}`)
}
const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(installerPath)).digest('base64')
if (metadata.sha512 !== actualSha512) {
  throw new Error('latest.yml sha512 与安装包内容不匹配')
}
console.log('[verify:release-assets] latest.yml SHA-512 元数据与安装包一致')

if (!unsignedRelease) {
  execFileSync(process.execPath, [path.join(__dirname, 'verify-update-metadata.cjs')], {
    cwd: appRoot,
    stdio: 'inherit',
    env: process.env,
  })

  function verifyAuthenticode(filePath) {
    if (process.platform !== 'win32') {
      throw new Error('Windows 发布资产必须在 Windows 上执行 Authenticode 验签')
    }
    const escapedPath = filePath.replace(/'/g, "''")
    const script = `\n      $sig = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'\n      if ($sig.Status -ne 'Valid') { throw \"Authenticode 状态不是 Valid: $($sig.Status)\" }\n      if (-not $sig.SignerCertificate) { throw '文件缺少签名证书' }\n      Write-Output $sig.SignerCertificate.Subject\n    `
    try {
      const signer = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' }).trim()
      console.log(`[verify:release-assets] Authenticode 签名有效: ${path.basename(filePath)} (${signer})`)
    } catch (error) {
      const detail = ((error.stdout || '') + (error.stderr || '')).trim()
      throw new Error(`Windows Authenticode 验签失败 (${path.basename(filePath)})${detail ? `: ${detail}` : ''}`)
    }
  }

  verifyAuthenticode(installerPath)
  const unpackedExe = path.join(out, 'win-unpacked', 'Profer.exe')
  if (!fs.existsSync(unpackedExe)) throw new Error(`缺少已签名的 unpacked 主程序: ${unpackedExe}`)
  verifyAuthenticode(unpackedExe)
} else {
  const unpackedExe = path.join(out, 'win-unpacked', 'Profer.exe')
  if (!fs.existsSync(unpackedExe)) throw new Error(`缺少 unpacked 主程序: ${unpackedExe}`)
  console.log('[verify:release-assets] 未签名 Windows 资产校验完成')
}
