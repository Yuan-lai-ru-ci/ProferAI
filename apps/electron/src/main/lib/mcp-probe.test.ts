/**
 * mcp-probe 单元测试
 *
 * 覆盖：错误分类、配置指纹稳定性、工具分页、finally 关闭 transport。
 * 分页与关闭用注入的假 Client/Transport 验证，不启动真实子进程。
 */

import { describe, expect, test } from 'bun:test'
import type { McpServerEntry } from '@profer/shared'
import {
  classifyMcpProbeError,
  mcpConfigFingerprint,
  probeMcpServer,
  probeMcpServerWithDeps,
  type McpProbeClient,
  type McpProbeDeps,
  type McpProbeListToolsResult,
  type McpProbeTransport,
} from './mcp-probe'

function httpEntry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return { type: 'http', url: 'http://127.0.0.1:3999/mcp', enabled: true, ...overrides }
}

/** 假 client：按 cursor 返回预设分页 */
function createFakeClient(pages: McpProbeListToolsResult[]): {
  client: McpProbeClient
  calls: { connect: number; listTools: Array<string | undefined> }
} {
  const calls = { connect: 0, listTools: [] as Array<string | undefined> }
  const client: McpProbeClient = {
    async connect() {
      calls.connect += 1
    },
    async listTools(params) {
      calls.listTools.push(params?.cursor)
      const index = params?.cursor ? Number(params.cursor) : 0
      const page = pages[index]
      if (!page) throw new Error(`未预设第 ${index} 页`)
      return page
    },
    getServerVersion() {
      return { name: 'fake-server', version: '9.9.9' }
    },
  }
  return { client, calls }
}

function createFakeTransport(): { transport: McpProbeTransport; closeCount: () => number } {
  let closes = 0
  return {
    transport: {
      async close() {
        closes += 1
      },
    },
    closeCount: () => closes,
  }
}

describe('classifyMcpProbeError', () => {
  test('命令不存在归为 command-missing', () => {
    const error = new Error('spawn npx ENOENT')
    ;(error as NodeJS.ErrnoException).code = 'ENOENT'
    expect(classifyMcpProbeError(error)).toBe('command-missing')
  })

  test('超时归为 handshake-timeout', () => {
    expect(classifyMcpProbeError(new Error('MCP error -32001: Request timed out'))).toBe('handshake-timeout')
  })

  test('401 归为 unauthorized', () => {
    expect(classifyMcpProbeError({ status: 401, message: 'Unauthorized' })).toBe('unauthorized')
  })

  test('403 归为 forbidden', () => {
    expect(classifyMcpProbeError({ status: 403, message: 'Forbidden: insufficient scope' })).toBe('forbidden')
  })

  test('协议版本不匹配归为 protocol-incompatible', () => {
    expect(classifyMcpProbeError(new Error('Server protocol version 2024-11-05 is not supported')))
      .toBe('protocol-incompatible')
  })

  test('ECONNREFUSED 归为 network', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3999')
    ;(error as NodeJS.ErrnoException).code = 'ECONNREFUSED'
    expect(classifyMcpProbeError(error)).toBe('network')
  })

  test('无法识别归为 unknown', () => {
    expect(classifyMcpProbeError(new Error('something odd happened'))).toBe('unknown')
    expect(classifyMcpProbeError(undefined)).toBe('unknown')
  })
})

describe('mcpConfigFingerprint', () => {
  test('对键顺序不敏感', () => {
    const a: McpServerEntry = { type: 'stdio', command: 'npx', args: ['-y', 'foo'], env: { A: '1', B: '2' }, enabled: true }
    const b: McpServerEntry = { enabled: true, env: { B: '2', A: '1' }, args: ['-y', 'foo'], command: 'npx', type: 'stdio' }
    expect(mcpConfigFingerprint(a)).toBe(mcpConfigFingerprint(b))
    expect(mcpConfigFingerprint(a)).toHaveLength(16)
  })

  test('对 lastTestResult 不敏感', () => {
    const base = httpEntry()
    const withResult: McpServerEntry = {
      ...base,
      lastTestResult: {
        success: true,
        message: '连接成功',
        timestamp: 1_700_000_000_000,
        fingerprint: 'deadbeefdeadbeef',
        tools: [{ name: 'ping', readOnly: true }],
      },
    }
    expect(mcpConfigFingerprint(withResult)).toBe(mcpConfigFingerprint(base))
  })

  test('对 command 变化敏感', () => {
    const a: McpServerEntry = { type: 'stdio', command: 'npx', enabled: true }
    const b: McpServerEntry = { type: 'stdio', command: 'uvx', enabled: true }
    expect(mcpConfigFingerprint(a)).not.toBe(mcpConfigFingerprint(b))
  })
})

describe('probeMcpServerWithDeps', () => {
  test('翻页取完全部工具，只保留 name 与 readOnly', async () => {
    const { client, calls } = createFakeClient([
      {
        tools: [
          { name: 'read_file', annotations: { readOnlyHint: true } },
          { name: 'write_file', annotations: { readOnlyHint: false } },
        ],
        nextCursor: '1',
      },
      {
        tools: [{ name: 'list_dir' }],
      },
    ])
    const { transport, closeCount } = createFakeTransport()
    const deps: McpProbeDeps = {
      createClient: () => client,
      createTransport: () => transport,
    }

    const result = await probeMcpServerWithDeps('demo', httpEntry(), { timeoutMs: 2_000 }, deps)

    expect(result.success).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.tools).toEqual([
      { name: 'read_file', readOnly: true },
      { name: 'write_file' },
      { name: 'list_dir' },
    ])
    expect(result.serverInfo).toEqual({ name: 'fake-server', version: '9.9.9' })
    // 两页：第一页无 cursor，第二页带 cursor '1'
    expect(calls.listTools).toEqual([undefined, '1'])
    expect(calls.connect).toBe(1)
    expect(closeCount()).toBe(1)
  })

  test('连接失败也要关闭 transport 并给出分类', async () => {
    const { transport, closeCount } = createFakeTransport()
    const failing: McpProbeClient = {
      async connect() {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3999'), { code: 'ECONNREFUSED' })
      },
      async listTools() {
        throw new Error('不应被调用')
      },
    }

    const result = await probeMcpServerWithDeps('demo', httpEntry(), { timeoutMs: 2_000 }, {
      createClient: () => failing,
      createTransport: () => transport,
    })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('network')
    expect(result.tools).toBeUndefined()
    expect(closeCount()).toBe(1)
  })

  test('握手超时归类为 handshake-timeout 且不泄漏 transport', async () => {
    const { transport, closeCount } = createFakeTransport()
    const hanging: McpProbeClient = {
      connect() {
        return new Promise<void>(() => {})
      },
      async listTools() {
        throw new Error('不应被调用')
      },
    }

    const result = await probeMcpServerWithDeps('demo', httpEntry(), { timeoutMs: 20 }, {
      createClient: () => hanging,
      createTransport: () => transport,
    })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('handshake-timeout')
    expect(closeCount()).toBe(1)
  })

  test('stdio 缺少 command 时直接返回 command-missing，不创建连接', async () => {
    const result = await probeMcpServer('demo', { type: 'stdio', enabled: true })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('command-missing')
    expect(result.message).toBe('未配置启动命令')
  })

  test('http 地址非法时返回配置错误，不发起连接', async () => {
    const result = await probeMcpServer('demo', { type: 'http', url: 'not a url', enabled: true })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('unknown')
    expect(result.message).toBe('服务地址格式不合法')
  })

  test('失败文案不包含 header 中的凭据', async () => {
    const { transport } = createFakeTransport()
    const failing: McpProbeClient = {
      async connect() {
        throw new Error('HTTP 401 Unauthorized (Authorization: Bearer sk-secret-token)')
      },
      async listTools() {
        throw new Error('不应被调用')
      },
    }

    const result = await probeMcpServerWithDeps('demo', httpEntry({
      headers: { Authorization: 'Bearer sk-secret-token' },
    }), { timeoutMs: 2_000 }, {
      createClient: () => failing,
      createTransport: () => transport,
    })

    expect(result.reason).toBe('unauthorized')
    expect(result.message).not.toContain('sk-secret-token')
    expect(result.message).not.toContain('Bearer')
  })
})
