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

function assertPackagingHost(targetPlatform, hostPlatform = process.platform, hostArch = process.arch) {
  if (targetPlatform === 'linux') {
    if (hostPlatform !== 'linux') throw new Error(`Linux 打包必须在 Linux 宿主上运行；当前宿主为 ${hostPlatform}。`)
    assertSupportedPackagingTarget(targetPlatform, hostArch)
  }
  if (targetPlatform === 'win' && hostPlatform !== 'win32') {
    throw new Error(
      `Windows 打包必须在 Windows 宿主上运行；当前宿主为 ${hostPlatform}。请改用 Windows runner 或 Windows 机器。`,
    )
  }
}

/** Linux 当前只开放原生 x64 构建；其他平台保留既有门禁。 */
function assertSupportedPackagingTarget(targetPlatform, targetArch = process.arch) {
  if (targetPlatform === 'linux' && targetArch !== 'x64') {
    throw new Error(`Linux 打包仅支持 x64，收到 ${targetArch}。`)
  }
}

/** 未显式传平台参数时，electron-builder 按宿主打包；门禁必须用同一个默认目标校验。 */
const HOST_DEFAULT_TARGET = new Map([
  ['darwin', 'mac'],
  ['win32', 'win'],
  ['linux', 'linux'],
])

function assertBuilderPackagingHost(args, hostPlatform = process.platform, hostArch = process.arch) {
  const requested = getRequestedPlatforms(args)
  const defaultTarget = HOST_DEFAULT_TARGET.get(hostPlatform)
  const targets = requested.length > 0 ? requested : (defaultTarget ? [defaultTarget] : [])
  for (const targetPlatform of targets) {
    assertPackagingHost(targetPlatform, hostPlatform, hostArch)
    const archFlags = args.filter((arg) => /^--(x64|arm64|armv7l|ia32|universal)(=|$)/.test(arg))
    for (const flag of archFlags) assertSupportedPackagingTarget(targetPlatform, flag.slice(2).split('=')[0])
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--arch' || args[index].startsWith('--arch=')) {
        const arch = args[index].includes('=') ? args[index].slice(7) : args[index + 1]
        assertSupportedPackagingTarget(targetPlatform, arch || 'unknown')
      }
    }
    assertSupportedPackagingTarget(targetPlatform, hostArch)
  }
}

module.exports = {
  assertBuilderPackagingHost,
  assertPackagingHost,
  assertSupportedPackagingTarget,
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
    assertBuilderPackagingHost(process.argv.slice(2))
    console.log(`[packaging-host] ${targetPlatform} 打包宿主检查通过（${process.platform}）。`)
  } catch (error) {
    console.error(`[packaging-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
