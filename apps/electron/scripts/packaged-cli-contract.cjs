#!/usr/bin/env node
/** 验证 Windows unpacked 包内随包 CLI 的文件名与内容契约。 */

const fs = require('node:fs')
const path = require('node:path')

const WINDOWS_CLI_NAME = 'profer.exe'
/**
 * Core 实测线随包附带的本机 Core 二进制。
 *
 * 主线安装包可以没有它（桌面走旧调度），所以是可选文件而不是必选项；
 * 但一旦出现，它同样必须是普通文件且非空，不能借这个位置夹带其它东西。
 */
const WINDOWS_CORE_NAME = 'profer-core.exe'
const ALLOWED_BINARIES = new Set([WINDOWS_CLI_NAME, WINDOWS_CORE_NAME])

function verifyPackagedWindowsCli(binDir) {
  if (!fs.existsSync(binDir)) {
    throw new Error(`Windows 随包 CLI 目录不存在: ${binDir}`)
  }

  const entries = fs.readdirSync(binDir, { withFileTypes: true })
  const names = entries.map((entry) => entry.name)
  if (!names.includes(WINDOWS_CLI_NAME)) {
    const actual = names.sort().join(', ') || '<空>'
    throw new Error(
      `Windows 随包 CLI 目录必须包含 ${WINDOWS_CLI_NAME}，实际为: ${actual}`,
    )
  }

  const unexpected = names.filter((name) => !ALLOWED_BINARIES.has(name))
  if (unexpected.length > 0) {
    const actual = names.sort().join(', ')
    throw new Error(
      `Windows 随包 CLI 目录只允许 ${[...ALLOWED_BINARIES].join(' / ')}，实际为: ${actual}`,
    )
  }

  for (const entry of entries) {
    const binaryPath = path.join(binDir, entry.name)
    if (!entry.isFile()) {
      throw new Error(`Windows 随包二进制必须是普通文件: ${binaryPath}`)
    }
    if (fs.statSync(binaryPath).size <= 0) {
      throw new Error(`Windows 随包二进制不能为空: ${binaryPath}`)
    }
  }

  return path.join(binDir, WINDOWS_CLI_NAME)
}

module.exports = { WINDOWS_CLI_NAME, WINDOWS_CORE_NAME, ALLOWED_BINARIES, verifyPackagedWindowsCli }

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
