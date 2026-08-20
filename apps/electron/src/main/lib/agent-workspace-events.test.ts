import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import { broadcastAgentWorkspaceChange, type AgentWorkspaceEventWindow } from './agent-workspace-events'

function makeWindow(destroyed: boolean): AgentWorkspaceEventWindow & { sentChannels: string[] } {
  const sentChannels: string[] = []
  return {
    sentChannels,
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string) => sentChannels.push(channel),
    },
  }
}

describe('工作区列表变更广播', () => {
  test('只向仍存活的渲染窗口发送共享 IPC 通道', () => {
    const alive = makeWindow(false)
    const destroyed = makeWindow(true)

    broadcastAgentWorkspaceChange([alive, destroyed])

    expect(alive.sentChannels).toEqual([AGENT_IPC_CHANNELS.WORKSPACES_CHANGED])
    expect(destroyed.sentChannels).toEqual([])
  })

  test('没有窗口时安全返回', () => {
    expect(() => broadcastAgentWorkspaceChange([])).not.toThrow()
  })
})
