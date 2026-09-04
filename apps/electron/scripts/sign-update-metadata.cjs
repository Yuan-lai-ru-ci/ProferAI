#!/usr/bin/env node
/**
 * 使用发布环境提供的 RSA 私钥为 latest.yml 生成 detached signature。
 * 私钥只能通过受控发布环境注入，绝不写入仓库或安装包。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const metadataPath = path.join(appRoot, 'out', 'latest.yml')
const signaturePath = `${metadataPath}.sig`

function readSecret(envName, fileEnvName) {
  const filePath = process.env[fileEnvName]
  if (filePath) return fs.readFileSync(path.resolve(filePath), 'utf8')
  const value = process.env[envName]
  if (value) return value
  throw new Error(`缺少 ${envName} 或 ${fileEnvName}，拒绝生成未签名更新元数据`)
}

if (!fs.existsSync(metadataPath)) throw new Error(`缺少更新元数据: ${metadataPath}`)
const privateKey = readSecret('PROFER_UPDATE_METADATA_PRIVATE_KEY', 'PROFER_UPDATE_METADATA_PRIVATE_KEY_FILE')
const signer = crypto.createSign('RSA-SHA256')
signer.update(fs.readFileSync(metadataPath))
signer.end()
const signature = signer.sign(privateKey, 'base64')
fs.writeFileSync(signaturePath, `${signature}\n`, { encoding: 'utf8', mode: 0o600 })
console.log(`[sign:update-metadata] 已生成 ${path.basename(signaturePath)}`)
