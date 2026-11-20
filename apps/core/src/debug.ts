import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreAgentRuntime } from './runtime'

/** 仅 PROFER_CORE_DEBUG=1 时挂载，用于本地调试，不属于产品协议。 */
export interface CoreDebugOptions {
  configDir: string
  workspaceRoot: string
  mockAgent: boolean
  startedAt: number
}

export function describeCoreDebugState(runtime: CoreAgentRuntime, options: CoreDebugOptions): Record<string, unknown> {
  return {
    service: 'profer-core',
    mockAgent: options.mockAgent,
    uptimeMs: Date.now() - options.startedAt,
    paths: {
      configDir: options.configDir,
      workspaceRoot: options.workspaceRoot,
    },
    channels: runtime.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      enabled: channel.enabled !== false,
      models: channel.models?.length ?? 0,
    })),
    workspaces: runtime.workspaces.list(),
    sessions: runtime.sessions.list().map(session => ({
      id: session.id,
      title: session.title,
      agentRuntime: session.agentRuntime,
      workspaceId: session.workspaceId,
      channelId: session.channelId,
      modelId: session.modelId,
      updatedAt: session.updatedAt,
      running: runtime.coordinator.isRunning(session.id),
      messageCount: runtime.sessions.readMessages(session.id).length,
    })),
  }
}

/**
 * 清空本地调试 Core 的会话数据，保留渠道与工作区。
 * 只接受显式 confirm，避免误触；仅用于临时调试。
 */
export function resetCoreSessionData(configDir: string): { removed: string[] } {
  const targets = [
    'agent-sessions.json',
    'agent-sessions.json.bak',
    'agent-sessions-pi-state.json',
    'agent-sessions',
    'agent-checkpoints',
    'core-agent-runs.json',
    'pi-sessions',
  ]
  const removed: string[] = []
  for (const name of targets) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(name)
  }
  return { removed }
}
