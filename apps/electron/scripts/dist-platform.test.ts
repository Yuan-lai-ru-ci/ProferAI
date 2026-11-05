import { describe, expect, test } from 'bun:test'
import { assertBuilderPackagingHost, assertPackagingHost, assertSupportedPackagingTarget } from './packaging-host.cjs'
import { defaultPlatformForHost, parseArgs } from './dist'

/**
 * `dist.ts` 平台解析的跨平台 fixture。
 *
 * 回归背景：未指定平台时曾固定 `win`，而 `dist:fast` 的文档语义是「当前宿主快速打包」，
 * 于是 macOS 上 `bun run dist:fast` 会被 Windows 宿主门禁直接拒绝（exit 2）。
 */

describe('dist.ts 默认平台推导', () => {
  test('Given macOS 宿主且未指定平台 Then 默认 mac（不再被 Windows 门禁拒绝）', () => {
    expect(defaultPlatformForHost('darwin')).toBe('mac')
    expect(parseArgs(['--current-arch'], 'darwin').platform).toBe('mac')
    expect(() => assertPackagingHost('mac', 'darwin')).not.toThrow()
  })

  test('Given Windows 宿主且未指定平台 Then 默认 win', () => {
    expect(defaultPlatformForHost('win32')).toBe('win')
    expect(parseArgs(['--current-arch'], 'win32').platform).toBe('win')
    expect(() => assertPackagingHost('win', 'win32')).not.toThrow()
  })

  test('Given Linux 宿主且未指定平台 Then 解析为 linux，但打包入口显式拒绝（当前不是发布目标）', () => {
    expect(defaultPlatformForHost('linux')).toBe('linux')
    expect(parseArgs([], 'linux').platform).toBe('linux')
    // 不因为「electron-builder.yml 有 linux 段」就当支持：缺 Claude 原生二进制与 Linux 验证。
    expect(() => assertSupportedPackagingTarget('linux')).toThrow('Linux 不是受支持的发布目标')
    expect(() => assertBuilderPackagingHost(['--linux'], 'linux')).toThrow('Linux 不是受支持的发布目标')
    // 不给平台参数时 electron-builder 仍按宿主默认打 linux，门禁必须同样拒绝。
    expect(() => assertBuilderPackagingHost([], 'linux')).toThrow('Linux 不是受支持的发布目标')
    expect(() => assertBuilderPackagingHost(['--dir'], 'linux')).toThrow('Linux 不是受支持的发布目标')
    expect(() => assertSupportedPackagingTarget('mac')).not.toThrow()
    expect(() => assertSupportedPackagingTarget('win')).not.toThrow()
  })

  test('Given 未指定平台参数 When 宿主为 macOS 或 Windows Then 按宿主默认目标校验并通过', () => {
    expect(() => assertBuilderPackagingHost([], 'darwin')).not.toThrow()
    expect(() => assertBuilderPackagingHost(['--dir'], 'darwin')).not.toThrow()
    expect(() => assertBuilderPackagingHost([], 'win32')).not.toThrow()
    expect(() => assertBuilderPackagingHost(['--publish', 'never'], 'win32')).not.toThrow()
  })

  test('Given 未知宿主 Then 报错退出而不是伪造某个平台', () => {
    expect(defaultPlatformForHost('freebsd' as NodeJS.Platform)).toBeUndefined()
    expect(() => parseArgs([], 'freebsd' as NodeJS.Platform)).toThrow('不支持在 freebsd 宿主上打包')
  })

  test('Given 显式平台参数 Then 覆盖宿主默认值', () => {
    expect(parseArgs(['--win'], 'darwin').platform).toBe('win')
    expect(parseArgs(['--mac'], 'win32').platform).toBe('mac')
    expect(parseArgs(['--linux'], 'darwin').platform).toBe('linux')
  })

  test('Given Windows 目标但宿主不是 Windows Then 宿主门禁仍然拒绝（不允许跨平台伪造）', () => {
    expect(parseArgs(['--win'], 'darwin').platform).toBe('win')
    expect(() => assertPackagingHost('win', 'darwin')).toThrow('Windows 打包必须在 Windows 宿主上运行')
    expect(() => assertPackagingHost('win', 'linux')).toThrow()
    // 目标与宿主一致时放行。
    expect(() => assertPackagingHost('win', 'win32')).not.toThrow()
  })

  test('Given 其它开关 Then 解析结果与既有行为一致', () => {
    const options = parseArgs(['--current-arch', '--verbose', '--no-sign', '--dmg', '--mac'], 'darwin')
    expect(options).toEqual({ currentArch: true, verbose: true, noSign: true, targetFormat: 'dmg', platform: 'mac' })
    expect(parseArgs(['--zip'], 'darwin').targetFormat).toBe('zip')
    expect(parseArgs(['--dir'], 'darwin').targetFormat).toBe('dir')
    expect(parseArgs([], 'darwin').targetFormat).toBe('all')
  })
})
