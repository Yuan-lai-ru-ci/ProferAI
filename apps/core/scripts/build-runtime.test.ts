import { expect, test } from 'bun:test'
import { coreBuildPlan } from './build-runtime'

test('宿主目录保留 external Pi 与目标 Claude native', () => {
  const plan = coreBuildPlan('/tmp/core-output', 'darwin', 'arm64')
  expect(plan.executable).toBe('/tmp/core-output/profer-core')
  expect(plan.nativeClaudePackage).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64')
  expect(plan.external).toContain('@earendil-works/pi-coding-agent')
  expect(plan.external).toContain('@earendil-works/pi-ai')
})
test('平台校验和 Windows 可执行文件名', () => {
  expect(coreBuildPlan('/tmp/core-output', 'win32', 'x64').executable).toEndWith('.exe')
  expect(() => coreBuildPlan('/tmp/core-output', 'linux', 'arm')).toThrow('不支持')
})
test('拒绝覆盖仓库源目录', () => {
  expect(() => coreBuildPlan(process.cwd(), 'darwin', 'arm64')).toThrow()
})
