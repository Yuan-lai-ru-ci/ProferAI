import { describe, expect, test } from 'bun:test'
import { assertBuilderPackagingHost, assertPackagingHost, assertSupportedPackagingTarget } from './packaging-host.cjs'
import { defaultPlatformForHost, parseArgs, resolveBuildSteps, resolveOutputDir, runBuildSteps } from './dist'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `dist.ts` 平台解析的跨平台 fixture。
 *
 * 回归背景：未指定平台时曾固定 `win`，而 `dist:fast` 的文档语义是「当前宿主快速打包」，
 * 于是 macOS 上 `bun run dist:fast` 会被 Windows 宿主门禁直接拒绝（exit 2）。
 */

describe('dist.ts 发行版构建链', () => {
  const scripts = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).scripts

  test.each(['oss', 'commercial'] as const)('Given %s 发行版 When 生成构建链 Then 主进程、界面与校验使用同一版别', (target) => {
    const commands = resolveBuildSteps(target).map((step) => step.script)
    expect(commands).toEqual([
      target === 'commercial' ? 'build:main-commercial' : 'build:main',
      `verify:build-target:${target}`,
      target === 'commercial' ? 'verify:commercial-includes-commercial' : 'verify:oss-excludes-commercial:strict',
      'build:preload',
      target === 'commercial' ? 'build:renderer:commercial' : 'build:renderer',
      `verify:renderer-edition:${target}`,
      'build:cli',
      'build:pen-ocr',
      'build:resources',
      'sync:runtime-deps',
    ])
    // 真实执行的命令必须在 package.json 中存在，避免测试与入口一起拼错名字。
    for (const command of commands) expect(typeof scripts[command]).toBe('string')
    expect(new Set(commands).size).toBe(commands.length)
  })

  test('Given OSS 发行版 Then 不执行商业构建或商业校验', () => {
    const commands = resolveBuildSteps('oss').map((step) => step.script)
    expect(commands).not.toContain('build:main-commercial')
    expect(commands).not.toContain('build:renderer:commercial')
    expect(commands).not.toContain('verify:build-target:commercial')
    expect(commands).not.toContain('verify:renderer-edition:commercial')
    expect(commands).not.toContain('verify:commercial-includes-commercial')
    expect(commands).toContain('verify:oss-excludes-commercial:strict')
  })
})

describe('dist.ts 构建执行（注入替身，不启动外部命令）', () => {
  test.each(['oss', 'commercial'] as const)('Given %s When 执行构建链 Then 完整执行同版步骤', (target) => {
    const called: string[] = []
    const results = runBuildSteps(target, (step) => {
      called.push(step.script)
      return { name: step.name, duration: 0, success: true, skipped: false }
    })
    expect(called).toEqual(resolveBuildSteps(target).map((step) => step.script))
    expect(results).toHaveLength(10)
    expect(results.every((result) => result.success)).toBe(true)
  })

  test.each(['verify:build-target:commercial', 'verify:renderer-edition:commercial', 'build:pen-ocr'])('Given %s 失败 Then 记录失败且停止后续构建', (script) => {
    const called: string[] = []
    const results = runBuildSteps('commercial', (step) => {
      called.push(step.script)
      return { name: step.name, duration: 0, success: step.script !== script, skipped: false }
    })
    const commands = resolveBuildSteps('commercial').map((step) => step.script)
    expect(called).toEqual(commands.slice(0, commands.indexOf(script) + 1))
    expect(results).toHaveLength(called.length)
    expect(results.at(-1)?.success).toBe(false)
  })
})

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
    expect(options).toEqual({ currentArch: true, verbose: true, noSign: true, targetFormat: 'dmg', platform: 'mac', target: 'oss' })
    expect(parseArgs(['--zip'], 'darwin').targetFormat).toBe('zip')
    expect(parseArgs(['--dir'], 'darwin').targetFormat).toBe('dir')
    expect(parseArgs([], 'darwin').targetFormat).toBe('all')
  })

  test('Given --target Then 发行版决定主进程构建与打包配置', () => {
    expect(parseArgs(['--mac', '--target', 'commercial'], 'darwin').target).toBe('commercial')
    // 缺省为开源版，与既有 dist:mac / dist:win 行为一致
    expect(parseArgs(['--mac'], 'darwin').target).toBe('oss')
    // 写错不能静默回退成开源版产物
    expect(() => parseArgs(['--mac', '--target', 'bussiness'], 'darwin')).toThrow('--target 只能是 oss 或 commercial')
    expect(() => parseArgs(['--mac', '--target'], 'darwin')).toThrow('--target 只能是 oss 或 commercial')
  })

  test('Given 发行版 Then 产物目录与构建后校验目录一致', () => {
    // 两个发行版同名 metadata（latest.yml / latest-mac.yml）不能落在同一目录。
    expect(resolveOutputDir('oss')).toBe('out')
    expect(resolveOutputDir('commercial')).toBe('out-commercial')
    // 校验步骤靠这个目录名定位产物，不能与 electron-builder.commercial.yml 的 output 漂移。
    const commercialConfig = require('node:fs').readFileSync(
      require('node:path').resolve(import.meta.dir, '..', 'electron-builder.commercial.yml'),
      'utf8',
    )
    expect(commercialConfig).toContain('output: out-commercial')
  })
})
