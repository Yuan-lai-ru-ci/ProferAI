import * as React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentContextUsageSnapshot } from '@profer/shared'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { ContextUsageBadge } from './ContextUsageBadge'
import { readSessionContextUsage } from './use-session-context-usage'

function render(inputTokens: number, isCompacting = false) {
  return renderToStaticMarkup(<TooltipProvider><ContextUsageBadge composerTool inputTokens={inputTokens}
    contextWindow={1000} cacheReadTokens={200} isCompacting={isCompacting} isProcessing={false} onCompact={() => {}} /></TooltipProvider>)
}

test('无可靠用量不挂载按钮；真实用量按含缓存分子显示，压缩时只显示压缩状态', () => {
  expect(render(0)).toBe('')
  expect(render(NaN, true)).toBe('')
  expect(render(250)).toContain('上下文使用量：25%')
  expect(render(250, true)).toContain('正在压缩上下文')
})

test('切换或实时上报撤销读取后，迟到的快照不会发布；有效快照原样保留明细和时间', async () => {
  const updates: AgentContextUsageSnapshot[] = []
  const old = Promise.withResolvers<AgentContextUsageSnapshot | null>()
  const cancel = readSessionContextUsage('old', () => old.promise, value => updates.push(value))
  cancel()
  const snapshot = { inputTokens: 120, cacheReadTokens: 50, usageUpdatedAt: 123 }
  readSessionContextUsage('new', async () => snapshot, value => updates.push(value))
  old.resolve({ inputTokens: 999 })
  await Promise.resolve()
  expect(updates).toEqual([snapshot])
})
