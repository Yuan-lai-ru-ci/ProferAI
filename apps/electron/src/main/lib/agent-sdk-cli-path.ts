/**
 * SDK native CLI binary 路径解析
 *
 * 从 agent-orchestrator.ts 提取的独立函数。
 */
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { app } from 'electron'

/**
 * 解析 SDK native CLI binary 路径
 *
 * 0.2.113+ 起 SDK 改为按平台分发 native binary，通过 optionalDependencies 安装到
 * `@anthropic-ai/claude-agent-sdk-{platform}-{arch}` 子包，与主包同级。
 *
 * 多种策略降级：createRequire → 全局 require → cwd/node_modules 手动查找
 */
export function resolveSDKCliPath(): string {
  const subpkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const scopedSubpkg = `@anthropic-ai/${subpkg}`
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  let binaryPath: string | null = null

  // 策略 1：createRequire（标准 ESM/CJS 互操作）
  try {
    const cjsRequire = createRequire(__filename)
    const sdkEntryPath = cjsRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const anthropicDir = dirname(dirname(sdkEntryPath))
    binaryPath = join(anthropicDir, subpkg, binaryName)
    console.log(`[Agent 编排] SDK binary 路径 (createRequire): ${binaryPath}`)
    if (!existsSync(binaryPath)) {
      const subpkgPackagePath = cjsRequire.resolve(`${scopedSubpkg}/package.json`)
      binaryPath = join(dirname(subpkgPackagePath), binaryName)
      console.log(`[Agent 编排] SDK binary 路径 (platform package): ${binaryPath}`)
    }
  } catch (e) {
    console.warn('[Agent 编排] createRequire 解析 SDK 路径失败:', e)
  }

  // 策略 2：全局 require
  if (!binaryPath || !existsSync(binaryPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk')
      const anthropicDir = dirname(dirname(sdkEntryPath))
      binaryPath = join(anthropicDir, subpkg, binaryName)
      console.log(`[Agent 编排] SDK binary 路径 (require.resolve): ${binaryPath}`)
      if (!existsSync(binaryPath)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const subpkgPackagePath = require.resolve(`${scopedSubpkg}/package.json`)
        binaryPath = join(dirname(subpkgPackagePath), binaryName)
        console.log(`[Agent 编排] SDK binary 路径 (require platform package): ${binaryPath}`)
      }
    } catch (e) {
      console.warn('[Agent 编排] require.resolve 解析 SDK 路径失败:', e)
    }
  }

  // 策略 3：从当前模块目录手动查找
  if (!binaryPath || !existsSync(binaryPath)) {
    binaryPath = join(__dirname, '..', 'node_modules', '@anthropic-ai', subpkg, binaryName)
    console.log(`[Agent 编排] SDK binary 路径 (手动): ${binaryPath}`)
  }

  // 打包环境：将 .asar/ 路径转换为 .asar.unpacked/
  if (app.isPackaged && binaryPath.includes('.asar')) {
    binaryPath = binaryPath.replace(/\.asar([/\\])/, '.asar.unpacked$1')
    console.log(`[Agent 编排] 转换为 asar.unpacked 路径: ${binaryPath}`)
  }

  return binaryPath
}
