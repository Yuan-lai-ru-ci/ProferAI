/** 工作区列表变更事件的广播逻辑。 */

import { AGENT_IPC_CHANNELS } from '@profer/shared'

export interface AgentWorkspaceEventWindow {
  isDestroyed(): boolean
  webContents: {
    send(channel: string): void
  }
}

/** 向仍存活的渲染窗口广播工作区列表变更。 */
export function broadcastAgentWorkspaceChange(windows: readonly AgentWorkspaceEventWindow[]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    }
  }
}
