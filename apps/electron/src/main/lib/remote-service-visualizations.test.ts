/**
 * WS：会话内可视化记录列表（list_visualizations）。
 *
 * 锁三件事：
 * 1. 标识缺失/非法/会话不存在时回可读错误而不是抛异常 —— WS 调用方是
 *    `handleRemoteCommand(...).then(...)` 且没有 `.catch`；
 * 2. 没有记录的会话返回空数组（新会话必须能正常打开，不能因为没图就报错）；
 * 3. 记录带 `toolCallId`，客户端据此把图表挂回对应的工具调用行 ——
 *    这是「对话结束后图表还在」的唯一连接方式。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-viz-ws-'))
process.env.PROFER_CONFIG_DIR = sandbox

const { handleRemoteCommand } = await import('./remote-service')
const { createAgentSession } = await import('./agent-session-manager')
const { presentVisualization } = await import('./visualization-records')
const { agentSessionVisualizationsDir } = await import('./config-paths')

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

const call = (payload: Record<string, unknown>) => handleRemoteCommand(JSON.stringify(payload))

describe('可视化记录：边界与空态', () => {
  test('Given 缺少 sessionId When 查询 Then 立刻拒绝', async () => {
    expect(await call({ type: 'list_visualizations' })).toEqual({ ok: false, error: '缺少 sessionId' })
  })

  test('Given sessionId 含路径字符 When 查询 Then 在边界挡掉，不落到存储层', async () => {
    expect(await call({ type: 'list_visualizations', sessionId: '../etc' }))
      .toEqual({ ok: false, error: 'sessionId 非法' })
  })

  test('Given 会话不存在 When 查询 Then 返回可读错误', async () => {
    expect(await call({ type: 'list_visualizations', sessionId: 'no-such-session' }))
      .toEqual({ ok: false, error: '会话不存在' })
  })

  test('Given 会话存在但没有可视化 When 查询 Then 返回空数组', async () => {
    const meta = createAgentSession('可视化空态', 'ch-viz')
    const result = await call({ type: 'list_visualizations', sessionId: meta.id }) as { ok: boolean; data?: { records: unknown[] } }
    expect(result.ok).toBe(true)
    expect(result.data?.records).toEqual([])
  })
})

describe('可视化记录：图表回传', () => {
  test('Given 会话发布过柱状图 When 查询 Then 带回 chart 规格与 toolCallId', async () => {
    const meta = createAgentSession('可视化图表', 'ch-viz')
    const context = {
      sessionId: meta.id,
      agentCwd: sandbox,
      storageDir: agentSessionVisualizationsDir(meta.id),
      allowedRoots: [],
    }
    await presentVisualization({
      chart: {
        chartType: 'bar',
        xKey: 'group',
        series: [{ dataKey: 'passed', label: '通过检查点' }],
        data: [{ group: '环境与命令', passed: 3 }, { group: '规划中心', passed: 5 }],
      },
      title: 'Profer 工作区自检结果',
      summary: '本次实测覆盖 8 个能力组',
    }, context, 'call-chart-1')

    const result = await call({ type: 'list_visualizations', sessionId: meta.id }) as {
      ok: boolean
      data?: { records: Array<{ toolCallId: string; title: string; format?: string; chart?: { chartType: string; data: unknown[] } }> }
    }
    expect(result.ok).toBe(true)
    const record = result.data?.records[0]
    expect(record?.toolCallId).toBe('call-chart-1')
    expect(record?.title).toBe('Profer 工作区自检结果')
    expect(record?.format).toBe('chart')
    expect(record?.chart?.chartType).toBe('bar')
    expect(record?.chart?.data).toHaveLength(2)
  })
})
