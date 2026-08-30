#!/usr/bin/env node
/**
 * 验证 latest.yml 的 detached RSA-SHA256 签名。
 * 公钥是发布客户端需要的公开材料；私钥只存在受控发布环境。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const metadataPath = path.join(appRoot, 'out', 'latest.yml')
const signaturePath = `${metadataPath}.sig`
const publicKeyPath = process.env.PROFER_UPDATE_METADATA_PUBLIC_KEY_FILE
  ? path.resolve(process.env.PROFER_UPDATE_METADATA_PUBLIC_KEY_FILE)
  : path.join(appRoot, 'resources', 'update-metadata-public.pem')
const publicKey = process.env.PROFER_UPDATE_METADATA_PUBLIC_KEY ||
  (fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8') : null) ||
  (process.env.PROFER_UPDATE_METADATA_PRIVATE_KEY
    ? crypto.createPublicKey(process.env.PROFER_UPDATE_METADATA_PRIVATE_KEY).export({ type: 'spki', format: 'pem' })
    : null)

for (const filePath of [metadataPath, signaturePath]) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少更新元数据签名材料: ${filePath}`)
}
if (!publicKey) {
  throw new Error(`缺少更新元数据公钥：请设置 PROFER_UPDATE_METADATA_PUBLIC_KEY(_FILE) 或提交 ${publicKeyPath}`)
}

const verifier = crypto.createVerify('RSA-SHA256')
verifier.update(fs.readFileSync(metadataPath))
verifier.end()
const signature = fs.readFileSync(signaturePath, 'utf8').trim()
if (!verifier.verify(publicKey, signature, 'base64')) {
  throw new Error('latest.yml detached RSA 签名验证失败')
}
console.log('[verify:update-metadata] latest.yml detached RSA 签名有效')
