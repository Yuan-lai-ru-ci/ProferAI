import { describe, expect, test } from 'bun:test'
import { extractRequestedPort } from './process-monitor'

describe('extractRequestedPort 端口提取（锚定 + 范围校验）', () => {
  test('参数形态 --port / -p（空格或等号）', () => {
    expect(extractRequestedPort('npm run dev --port 5177')).toBe(5177)
    expect(extractRequestedPort('astro dev -p 4321')).toBe(4321)
    expect(extractRequestedPort('vite --port=8080')).toBe(8080)
    expect(extractRequestedPort('node server.js -p=3000')).toBe(3000)
  })

  test('URL / 主机名:端口 形态', () => {
    expect(extractRequestedPort('curl http://localhost:8080/api')).toBe(8080)
    expect(extractRequestedPort('bun run --host 0.0.0.0:5177')).toBe(5177)
  })

  test('命令中无关数字不误判为端口', () => {
    // 裸 pid、重试次数、路径数字、日志计数都不该被当端口
    expect(extractRequestedPort('git status')).toBeUndefined()
    expect(extractRequestedPort('sleep 5')).toBeUndefined()
    expect(extractRequestedPort('ls 12345')).toBeUndefined()
    expect(extractRequestedPort('echo retry 3 times')).toBeUndefined()
    expect(extractRequestedPort('cat /var/log/2026')).toBeUndefined()
  })

  test('参数形态右侧跟其他参数时仍只取端口', () => {
    // 边界：--port 后是合法端口再跟别的 word，应取到 5177
    expect(extractRequestedPort('astro dev --port 5177 --strictPort')).toBe(5177)
  })

  test('超范围 / 非法端口返回 undefined', () => {
    expect(extractRequestedPort('--port 0')).toBeUndefined()
    expect(extractRequestedPort('--port 70000')).toBeUndefined()
    expect(extractRequestedPort('--port -1')).toBeUndefined()
    expect(extractRequestedPort('--port abc')).toBeUndefined()
  })

  test('空命令返回 undefined', () => {
    expect(extractRequestedPort('')).toBeUndefined()
    expect(extractRequestedPort(undefined as unknown as string)).toBeUndefined()
  })
})
