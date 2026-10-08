#!/usr/bin/env node
/** 本地证书签名实验入口：只签新的副本，不改安装版或发布签名契约。 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { resolveOsxSign, readBundleIdentifier } = require('./macos-signature.cjs')

function certificateRequirement(bundleId, fingerprint) {
  if (!/^[\w.-]+$/.test(bundleId)) throw new Error('无效 bundle identifier')
  if (!/^[a-f\d]{40}$/i.test(fingerprint)) throw new Error('需要 40 位证书 SHA-1 指纹')
  return `identifier "${bundleId}" and certificate leaf = H"${fingerprint.toLowerCase()}"`
}

function verifyLocalSignature(app, fingerprint) {
  const bundleId = readBundleIdentifier(app)
  const requirement = certificateRequirement(bundleId, fingerprint)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
  execFileSync('/usr/bin/codesign', ['--verify', `-R=${requirement}`, app], { stdio: 'pipe' })
  const display = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' })
  if (display.status !== 0) throw new Error('读取证书签名失败')
  const summary = `${display.stdout}${display.stderr}`
  const authority = summary.match(/^Authority=(.+)$/m)?.[1]
  if (!authority || /^Signature=adhoc$/m.test(summary)) throw new Error('产物仍是 ad-hoc 签名')
  return { app, bundleId, requirement, authority, cdhash: summary.match(/^CDHash=(.+)$/m)?.[1] }
}

async function signCopy({ source, output, keychain, fingerprint }) {
  if (process.platform !== 'darwin') throw new Error('本地证书签名只能在 macOS 上执行')
  const original = fs.realpathSync(source)
  const requestedTarget = path.resolve(output)
  let ancestor = path.dirname(requestedTarget)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const target = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, requestedTarget))
  if (!original.endsWith('.app') || !target.endsWith('.app')) throw new Error('输入和输出必须是 .app')
  if (fs.existsSync(target)) throw new Error('输出已存在，请使用新的输出路径')
  // 输出不能嵌入原始包，避免复制递归；安装目录一律不作为输出。
  if (target.startsWith(`${original}${path.sep}`) || target.startsWith('/Applications/')) {
    throw new Error('输出必须是安装目录以外的独立副本')
  }
  const bundleId = readBundleIdentifier(original)
  certificateRequirement(bundleId, fingerprint)
  if (!fs.existsSync(keychain)) throw new Error('指定的钥匙串不存在')
  const { signAsync } = resolveOsxSign()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execFileSync('/usr/bin/ditto', [original, target], { stdio: 'pipe' })
  await signAsync({
    app: target,
    platform: 'darwin',
    identity: fingerprint,
    // 传给 codesign 的是证书指纹；自签名不要求 Apple 信任链。
    identityValidation: false,
    keychain,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (file) => ({
      hardenedRuntime: true,
      timestamp: 'none',
      // helper 使用 osx-sign 按角色提供的默认 entitlement。
      ...(path.resolve(file) === target ? {
        entitlements: path.resolve(__dirname, '..', 'resources', 'entitlements.mac.plist'),
        requirements: `=designated => ${certificateRequirement(bundleId, fingerprint)}`,
      } : file.endsWith('.app') ? {
        requirements: `=designated => ${certificateRequirement(readBundleIdentifier(file), fingerprint)}`,
      } : {}),
    }),
  })
  return verifyLocalSignature(target, fingerprint)
}

module.exports = { certificateRequirement, verifyLocalSignature, signCopy }

if (require.main === module) {
  const [source, output, keychain, fingerprint] = process.argv.slice(2)
  if (!source || !output || !keychain || !fingerprint) {
    console.error('用法：node scripts/local-mac-signing.cjs <源.app> <新副本.app> <keychain-db> <证书SHA1>')
    process.exitCode = 2
  } else {
    signCopy({ source, output, keychain, fingerprint })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}
