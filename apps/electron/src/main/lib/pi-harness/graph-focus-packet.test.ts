import { describe, expect, test } from 'bun:test'
import type { TaskGraph, TaskNode } from '@profer/project-core'
import { buildGraphFocusPacket, estimateGraphFocusPacketTokens, GRAPH_FOCUS_MAX_CHARS, GRAPH_FOCUS_MAX_TOKENS } from './graph-focus-packet'
import type { PiHarnessGoal } from './types'

function node(id: string, status: TaskNode['status'], createdAt: number, dependsOn: string[] = [], description = '', artifact: string[] = []): TaskNode {
  return { id, subject: `${id} subject`, description, status, dependsOn, dependedBy: [], artifact, reviewStatus: 'none', createdAt, updatedAt: createdAt }
}

function graph(nodes: TaskNode[]): TaskGraph {
  return { nodes: Object.fromEntries(nodes.map((item) => [item.id, item])), edges: [], forkEdges: [], updatedAt: 1 }
}

const goal: Pick<PiHarnessGoal, 'id' | 'activeTaskId' | 'policy'> = {
  id: 'goal-1', activeTaskId: 'active', policy: { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 },
}

describe('Graph Focus Packet', () => {
  test('contains a single focused task plus bounded ready, blocked and verification facts', () => {
    const packet = buildGraphFocusPacket({
      goal,
      graph: graph([
        node('done', 'completed', 1),
        node('active', 'in_progress', 2, [], '@verify: bun test target', ['dist/output.txt']),
        node('ready-1', 'pending', 3),
        node('ready-2', 'pending', 4),
        node('ready-3', 'pending', 5),
        node('blocked', 'pending', 6, ['done', 'missing']),
      ]),
      verificationByTask: { active: { taskId: 'active', state: 'pending', reason: '需要明确测试', evidenceFactIds: [], updatedAt: 1 } },
      lastFactSummary: 'Edit src/file.ts success',
      resumeSummary: '上一 Turn 已结束',
    })
    expect(packet).toContain('<graph_focus>')
    expect(packet).toContain('active: active')
    expect(packet).toContain('acceptance: bun test target')
    expect(packet).toContain('assurance: pending')
    expect(packet).toContain('ready: ready-1')
    expect(packet).not.toContain('ready-3')
    expect(packet).toContain('blocked: blocked')
    expect(packet).toContain('</graph_focus>')
  })

  test('is deterministic, redacts common secrets, and always stays under both hard limits', () => {
    const huge = '敏感信息 api_key=sk_super_secret_value_1234567890 '.repeat(200)
    const input = {
      goal,
      graph: graph([node('active', 'in_progress', 1, [], huge)]),
      lastFactSummary: huge,
      resumeSummary: huge,
    }
    const first = buildGraphFocusPacket(input)
    const second = buildGraphFocusPacket(input)
    expect(first).toBe(second)
    expect([...first].length).toBeLessThanOrEqual(GRAPH_FOCUS_MAX_CHARS)
    expect(estimateGraphFocusPacketTokens(first)).toBeLessThanOrEqual(GRAPH_FOCUS_MAX_TOKENS)
    expect(first).not.toContain('sk_super_secret')
    expect(first).toContain('[redacted]')
  })

  test('uses a graphless fallback without reading arbitrary graph text', () => {
    const packet = buildGraphFocusPacket({ graph: graph([]), maxChars: 1200, maxTokens: 300 })
    expect(packet).toContain('goal: graphless')
    expect(packet).toContain('focus: graphless')
  })
})
