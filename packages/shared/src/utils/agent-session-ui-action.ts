import type { AgentSessionMeta, UpdateAgentInterruptStateInput } from '../types/agent'
import { buildArchiveToggleUpdates, type AgentUnreadPolicyMode } from './agent-unread-policy'

/** 业务动作而非任意 metadata patch；Core 对当前权威值做读改写。 */
export type AgentSessionUiAction =
  | { type: 'toggle_pin' }
  | { type: 'toggle_archive' }
  | { type: 'set_unread'; unread: boolean; explicit?: boolean }
  | { type: 'set_interruption'; state: UpdateAgentInterruptStateInput['state'] }

export function parseAgentSessionUiAction(value: unknown): AgentSessionUiAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的会话显示操作')
  const input = value as Record<string, unknown>
  if (input.type === 'toggle_pin' || input.type === 'toggle_archive') return { type: input.type }
  if (input.type === 'set_unread' && typeof input.unread === 'boolean') {
    if (input.explicit !== undefined && typeof input.explicit !== 'boolean') throw new Error('无效的已读操作来源')
    return { type: input.type, unread: input.unread, ...(input.explicit !== undefined ? { explicit: input.explicit } : {}) }
  }
  if (input.type === 'set_interruption') {
    if (input.state === null) return { type: input.type, state: null }
    if (input.state && typeof input.state === 'object' && !Array.isArray(input.state)) {
      const state = input.state as Record<string, unknown>
      if (['completed', 'stopped_by_user', 'max_turns', 'max_budget', 'max_tokens', 'error', 'unknown'].includes(String(state.reason))
        && typeof state.label === 'string' && state.label.length <= 500
        && typeof state.at === 'number' && Number.isFinite(state.at) && state.at >= 0) {
        return { type: input.type, state: { reason: state.reason as NonNullable<UpdateAgentInterruptStateInput['state']>['reason'], label: state.label, at: state.at } }
      }
    }
  }
  throw new Error('无效的会话显示操作')
}

export function buildAgentSessionUiUpdates(current: AgentSessionMeta, action: AgentSessionUiAction, mode: AgentUnreadPolicyMode): {
  patch: Partial<AgentSessionMeta>; touchUpdatedAt: boolean
} | null {
  switch (action.type) {
    case 'toggle_pin': {
      if (current.parentSessionId || current.explorationParentSessionId) return null
      const pinned = !current.pinned
      return { patch: { pinned, ...(pinned && current.archived ? { archived: false } : {}) }, touchUpdatedAt: false }
    }
    case 'toggle_archive':
      return { patch: buildArchiveToggleUpdates({ archived: !!current.archived, pinned: !!current.pinned, completedButUnconfirmed: !!current.completedButUnconfirmed }, mode), touchUpdatedAt: false }
    case 'set_unread': {
      // Pocket导航触发的自动已读不能消费manual模式的未读；省略字段保持既有桌面显式语义。
      if (!action.unread && action.explicit === false && mode === 'manual') return null
      if (!action.unread && !current.completedButUnconfirmed && !current.manualWorking) return null
      return { patch: { completedButUnconfirmed: action.unread, ...(!action.unread && current.manualWorking ? { manualWorking: false } : {}),
        ...(current.archived ? { archived: mode === 'manual' } : {}) }, touchUpdatedAt: true }
    }
    case 'set_interruption':
      return { patch: action.state
        ? { lastInterruptReason: action.state.reason, lastInterruptLabel: action.state.label, lastInterruptAt: action.state.at }
        : { lastInterruptReason: undefined, lastInterruptLabel: undefined, lastInterruptAt: undefined }, touchUpdatedAt: true }
  }
}
