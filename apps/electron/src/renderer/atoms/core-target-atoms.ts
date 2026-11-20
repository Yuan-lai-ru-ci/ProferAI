import { atom } from 'jotai'
import type { Channel } from '@profer/shared'
import type { CoreTargetsSnapshot, CoreTargetSummary } from '@/types/settings'

export interface CoreTargetsState {
  currentId: string
  generation: number
  targets: CoreTargetSummary[]
}

export const coreTargetsAtom = atom<CoreTargetsSnapshot>({ currentId: 'local', generation: 0, targets: [{ id: 'local', name: '本机内核', kind: 'local', status: 'disconnected' }] })

export interface CoreChannelSnapshot {
  id: string
  name: string
  provider: import('@profer/shared').ProviderType
  baseUrl?: string
  agentBaseUrl?: string
  credentialMode?: 'api-key' | 'oauth'
  apiProtocol?: 'responses' | 'chat-completions'
  models?: Array<{ id: string; name: string; enabled: boolean; context1m?: boolean }>
  enabled?: boolean
  agentRuntimes?: Array<'claude' | 'pi'>
}

export const coreChannelsAtom = atom<Channel[]>([])
/** 目录是否已为当前目标加载；空目录与加载中不是同一状态。 */
export const coreChannelsLoadedAtom = atom<{ targetId: string; generation: number } | null>(null)
/** 全局会话恢复器的阶段；空态不得触发WelcomeView自动创建/复用其他会话。 */
export const coreSessionNavigationPhaseAtom = atom<'loading' | 'ready' | 'error' | null>('loading')

export async function loadCoreTargets(): Promise<CoreTargetsSnapshot> {
  return window.electronAPI.listCoreTargets()
}

/** 本机 Core 同样拥有 Chat 目录；旧桌面 local 不声明 chat 能力。 */
export function ownsCoreChat(target: CoreTargetsSnapshot): boolean {
  return target.currentId !== 'local' || Boolean(target.targets.find(item => item.id === target.currentId)?.capabilities?.includes('chat'))
}
