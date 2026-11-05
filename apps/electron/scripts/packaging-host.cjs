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

/**
 * 目标平台是否纳入发布支持范围。
 *
 * Linux 当前**不支持**，原因（已核查，不能仅凭 electron-builder.yml 存在 linux 配置就当支持）：
 * - `apps/electron/package.json` 的 optionalDependencies 只含 darwin-arm64 / darwin-x64 /
 *   win32-x64 / win32-arm64，缺 `@anthropic-ai/claude-agent-sdk-linux-*`：
 *   `resolveSDKCliPath()` 会解析出 `claude-agent-sdk-linux-<arch>/claude`，文件不存在，
 *   Claude 内核运行必然失败（失败点在 run 时，App 仍能启动，因此容易漏验）；
 * - CI（`.github/workflows`）只有 Windows Release Verification 与 macOS Package Verification，
 *   没有任何 Linux 宿主验证；
 * - `electron-builder.yml` 的 linux 段只有 extraResources，没有声明 target / arch。
 *
 * 因此构建入口显式拒绝，而不是产出一个「能装上但 Claude 必然失败」的包。
 * 若要开始支持 Linux，需先补齐：linux x64/arm64 的 SDK 运行时资源与 optionalDependencies、
 * linux target/arch 声明、以及一个最小 smoke 验证（在此之前不要声称支持）。
 */
const UNSUPPORTED_TARGETS = new Map([
  ['linux', 'Linux 不是受支持的发布目标：缺少 Claude 原生二进制（optionalDependencies 无 claude-agent-sdk-linux-*），且没有 Linux 构建验证。如需支持，请先补齐 linux x64/arm64 runtime 资源与最小 smoke。'],
])

function assertSupportedPackagingTarget(targetPlatform) {
  const reason = UNSUPPORTED_TARGETS.get(targetPlatform)
  if (reason) throw new Error(reason)
}

/** 未显式传平台参数时，electron-builder 按宿主打包；门禁必须用同一个默认目标校验。 */
const HOST_DEFAULT_TARGET = new Map([
  ['darwin', 'mac'],
  ['win32', 'win'],
  ['linux', 'linux'],
])

function assertBuilderPackagingHost(args, hostPlatform = process.platform) {
  const requested = getRequestedPlatforms(args)
  // 没有 --win/--mac/--linux 时不能直接放行：`pack` / `dist` 会落到 electron-builder 的
  // 宿主默认目标，于是 Linux 宿主能绕过「Linux 不受支持」的拒绝，产出 Claude 必然失败的包。
  const defaultTarget = HOST_DEFAULT_TARGET.get(hostPlatform)
  const targets = requested.length > 0 ? requested : (defaultTarget ? [defaultTarget] : [])
  for (const targetPlatform of targets) {
    assertSupportedPackagingTarget(targetPlatform)
    assertPackagingHost(targetPlatform, hostPlatform)
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
    assertSupportedPackagingTarget(targetPlatform)
    assertPackagingHost(targetPlatform)
    console.log(`[packaging-host] ${targetPlatform} 打包宿主检查通过（${process.platform}）。`)
  } catch (error) {
    console.error(`[packaging-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
