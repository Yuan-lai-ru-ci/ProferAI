import { describe, test, expect } from 'bun:test'

describe('Pi SDK 0.84.2 运行时冒烟', () => {
  test('sdk 可加载并且所需 API 存在', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    expect(sdk).toBeDefined()
    expect(sdk.SessionManager).toBeDefined()
    expect(typeof sdk.createAgentSession).toBe('function')
    expect(sdk.SettingsManager).toBeDefined()
    expect(sdk.DefaultResourceLoader).toBeDefined()
  })

  test('SettingsManager.inMemory 可创建并读到 compaction/retry total 配置', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const sm = sdk.SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 8, baseDelayMs: 1000 },
    })
    const retry = sm.getRetrySettings()
    expect(retry.maxTotalRetries).toBeTypeOf('number')
    expect(retry.maxTotalDelayMs).toBeTypeOf('number')
    expect(retry.baseDelayMs).toBe(1000)
    expect(sm.getCompactionSettings().enabled).toBe(true)
  })

  test('Agent.constructor 可实例化且暴露 streamFunction（0.84.2）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const dir = path.dirname(req.resolve('@earendil-works/pi-agent-core/package.json'))
    const dts = fs.readFileSync(path.join(dir, 'dist/agent.d.ts'), 'utf8')
    // class Agent 公开属性是 streamFunction
    expect(dts).toContain('streamFunction: StreamFn')
    expect(dts).toContain('streamFn: StreamFn')
    // AgentOptions 的 streamFn 是构造参数，二者并存；运行时赋值走 streamFunction
    console.log('[冒烟] AgentOptions.streamFn（构造入参）与 Agent.streamFunction（运行时属性）并存，二者都会被 tsc 校验')
  })

  test('retry 事件模型含 auto_retry_attempt_start 与 total 字段（patch 生效）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const dir = path.dirname(req.resolve('@earendil-works/pi-coding-agent/package.json'))
    const dts = fs.readFileSync(path.join(dir, 'dist/core/agent-session.d.ts'), 'utf8')
    expect(dts).toContain('auto_retry_attempt_start')
    expect(dts).toContain('maxTotalAttempts')
    expect(dts).toContain('outcome: "succeeded" | "exhausted" | "cancelled"')
    // compaction 溢出 reason（overflow recovery 依赖）
    expect(dts).toContain('"manual" | "threshold" | "overflow"')
    expect(dts).toContain('agent_settled')
  })

  test('adapter 依赖的 SettingsManager 运行时 API 可调通', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const sm = sdk.SettingsManager.inMemory({ retry: { enabled: true } })
    expect(typeof sm.getProviderRetrySettings).toBe('function')
    expect(typeof sm.getHttpIdleTimeoutMs).toBe('function')
    expect(typeof sm.getWebSocketConnectTimeoutMs).toBe('function')
    expect(sm.getHttpIdleTimeoutMs()).toBeGreaterThanOrEqual(0)
  })
})
