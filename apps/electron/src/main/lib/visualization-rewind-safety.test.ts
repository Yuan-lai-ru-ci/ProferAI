/**
 * 回归测试：会话工作区的文件检查点回退绝不能影响会话内可视化记录。
 *
 * 背景（2026-10-04 真实事故）：可视化记录曾存储于 `<会话工作区>/.context/visualizations/`，
 * 而 Pi 文件检查点对整个会话工作区做快照。第 1 轮的基线是空树，一次「快照回退」就把
 * 基线之后新增的记录文件当成本轮新增文件删掉了，历史消息仍在引用它，卡片因此变坏。
 * 修复方式是把记录存储搬到配置目录（`agent-visualizations/<sessionId>/`），
 * 让回退、工作区清理、fork 与 Agent 自己的文件工具都够不到它。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createPiFileCheckpoint, loadPiFileCheckpoint, restorePiFileCheckpoint } from './pi-file-checkpoint'
import { listVisualizations, presentVisualization, readVisualization } from './visualization-records'
import { agentSessionVisualizationsDir, getAgentWorkspacesDir } from './config-paths'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'profer-viz-rewind-'))
  roots.push(base)
  const sessionCwd = join(base, 'session-workspace')
  const store = join(base, 'agent-visualizations', 'session-a')
  mkdirSync(join(sessionCwd, '.context'), { recursive: true })
  const context = { sessionId: 'session-a', agentCwd: sessionCwd, storageDir: store, allowedRoots: [sessionCwd] }
  return { base, sessionCwd, store, context }
}

describe('快照回退与可视化记录隔离', () => {
  test('回退会话工作区不会删除可视化记录，历史仍能读回', async () => {
    const f = fixture()
    // 第 1 轮开始时的基线：工作区里还没有可视化记录
    const checkpoint = createPiFileCheckpoint('session-a', f.sessionCwd, join(f.base, 'checkpoints'))
    expect(checkpoint.engine).toBe('git')
    expect(checkpoint.files).toEqual([])

    // 第 1 轮：工作区里写了源文件，同时发布了图表与片段两个记录
    const source = join(f.sessionCwd, '.context', 'tabs.html')
    writeFileSync(source, '<div id="widget">A</div>')
    const chart = await presentVisualization({ chart: { chartType: 'bar', xKey: 'name', series: [{ dataKey: 'value' }], data: [{ name: 'A', value: 1 }] }, title: '分组柱状图', summary: '数据' }, f.context, 'call-chart')
    const fragment = await presentVisualization({ filePath: source, format: 'fragment', title: '片段', summary: '说明' }, f.context, 'call-fragment')
    expect(await listVisualizations(f.context)).toHaveLength(2)

    // 用户「快照回退」回到第 1 轮基线
    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), f.sessionCwd)

    // 回退确实干活了：基线之后新增的工作区文件被删掉
    expect(restored.changed).toContain('.context/tabs.html')
    expect(existsSync(source)).toBe(false)

    // 但可视化记录完全不受影响
    expect(await listVisualizations(f.context)).toHaveLength(2)
    expect((await readVisualization(f.context, chart.id)).record.chart?.chartType).toBe('bar')
    expect((await readVisualization(f.context, fragment.id)).html).toContain('A')
    expect(existsSync(join(f.store, chart.id, 'record.json'))).toBe(true)
  })

  test('可视化存储根必须位于 Agent 工作区之外', () => {
    const storeRoot = agentSessionVisualizationsDir('session-a')
    expect(storeRoot.startsWith(getAgentWorkspacesDir() + sep)).toBe(false)
    expect(storeRoot).toContain(join('agent-visualizations', 'session-a'))
  })
})
