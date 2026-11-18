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

export async function loadCoreTargets(): Promise<CoreTargetsSnapshot> {
  return window.electronAPI.listCoreTargets()
}
