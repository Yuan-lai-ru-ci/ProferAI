#!/usr/bin/env node
/**
 * 打包宿主门禁。
 *
 * Profer CLI 与原生运行时均由当前宿主编译/安装，不能在 macOS 或 Linux 上
 * 伪造 Windows 产物。所有 Windows 打包入口都应在实际构建开始前调用本模块。
 */

const TARGET_FLAGS = new Map([
  ['--win', 'win'],
  ['--windows', 'win'],
  ['-w', 'win'],
  ['--mac', 'mac'],
  ['-m', 'mac'],
  ['--linux', 'linux'],
  ['-l', 'linux'],
])

function getRequestedPlatform(args) {
  return getRequestedPlatforms(args)[0]
}

function getRequestedPlatforms(args) {
  const requested = []
  for (const arg of args) {
    const flag = arg.split('=', 1)[0]
    const direct = TARGET_FLAGS.get(flag)
    if (direct) requested.push(direct)
    if (/^-[mlw]{2,3}$/.test(flag)) {
      for (const shortFlag of flag.slice(1)) requested.push(TARGET_FLAGS.get(`-${shortFlag}`))
    }
  }
  return [...new Set(requested.filter(Boolean))]
}

function assertPackagingHost(targetPlatform, hostPlatform = process.platform) {
  if (targetPlatform === 'win' && hostPlatform !== 'win32') {
    throw new Error(
      `Windows 打包必须在 Windows 宿主上运行；当前宿主为 ${hostPlatform}。请改用 Windows runner 或 Windows 机器。`,
    )
  }
}

function assertBuilderPackagingHost(args, hostPlatform = process.platform) {
  for (const targetPlatform of getRequestedPlatforms(args)) {
    assertPackagingHost(targetPlatform, hostPlatform)
  }
}

module.exports = {
  assertBuilderPackagingHost,
  assertPackagingHost,
  getRequestedPlatform,
  getRequestedPlatforms,
}

if (require.main === module) {
  const targetPlatform = getRequestedPlatform(process.argv.slice(2))
  if (!targetPlatform) {
    console.error('[packaging-host] 缺少目标平台参数（例如 --win）。')
    process.exit(2)
  }

  try {
    assertPackagingHost(targetPlatform)
    console.log(`[packaging-host] ${targetPlatform} 打包宿主检查通过（${process.platform}）。`)
  } catch (error) {
    console.error(`[packaging-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
