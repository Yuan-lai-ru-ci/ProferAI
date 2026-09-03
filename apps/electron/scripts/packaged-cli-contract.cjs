#!/usr/bin/env node
/** 验证 Windows unpacked 包内随包 CLI 的文件名与内容契约。 */

const fs = require('node:fs')
const path = require('node:path')

const WINDOWS_CLI_NAME = 'profer.exe'

function verifyPackagedWindowsCli(binDir) {
  if (!fs.existsSync(binDir)) {
    throw new Error(`Windows 随包 CLI 目录不存在: ${binDir}`)
  }

  const entries = fs.readdirSync(binDir, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== WINDOWS_CLI_NAME) {
    const actual = entries.map((entry) => entry.name).sort().join(', ') || '<空>'
    throw new Error(
      `Windows 随包 CLI 目录必须且只能包含 ${WINDOWS_CLI_NAME}，实际为: ${actual}`,
    )
  }

  const entry = entries[0]
  const cliPath = path.join(binDir, entry.name)
  if (!entry.isFile()) {
    throw new Error(`Windows 随包 CLI 必须是普通文件: ${cliPath}`)
  }
  if (fs.statSync(cliPath).size <= 0) {
    throw new Error(`Windows 随包 CLI 不能为空: ${cliPath}`)
  }

  return cliPath
}

module.exports = { WINDOWS_CLI_NAME, verifyPackagedWindowsCli }

if (require.main === module) {
  const appRoot = path.resolve(__dirname, '..')
  const binDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(appRoot, 'out', 'win-unpacked', 'resources', 'bin')
  try {
    const cliPath = verifyPackagedWindowsCli(binDir)
    console.log(`[packaged-cli-contract] ${cliPath} OK`)
  } catch (error) {
    console.error(`[packaged-cli-contract] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
