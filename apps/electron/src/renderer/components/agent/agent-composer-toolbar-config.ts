import type { ReactNode } from 'react'
import type { ComposerToolbarItem } from '@/components/ai-elements/composer/ComposerToolbar'
import type { ComposerToolbarPreferences } from '../../../types'
import { applyComposerToolbarPreferences } from '@/lib/composer-toolbar-preferences'

export interface AgentComposerToolbarNodes {
  model: ReactNode
  runtime: ReactNode
  permissionMode: ReactNode
  preset: ReactNode
  speech?: ReactNode
  attach: ReactNode
  contextUsage?: ReactNode
  graph?: ReactNode
}

/** Agent 工具栏的声明式装配点；页面只提供状态绑定后的节点。 */
export function createAgentComposerToolbarItems(nodes: AgentComposerToolbarNodes, preferences?: ComposerToolbarPreferences): ComposerToolbarItem[]
export function createAgentComposerToolbarItems(items: ComposerToolbarItem[], preferences?: ComposerToolbarPreferences): ComposerToolbarItem[]
export function createAgentComposerToolbarItems(input: AgentComposerToolbarNodes | ComposerToolbarItem[], preferences?: ComposerToolbarPreferences): ComposerToolbarItem[] {
  if (Array.isArray(input)) {
    return applyComposerToolbarPreferences('agent', input.map((item) => item.key === 'model' && item.canOverflow === undefined
      ? { ...item, canOverflow: false }
      : item), preferences)
  }
  return applyComposerToolbarPreferences('agent', [
    { key: 'model', canOverflow: false, node: input.model },
    { key: 'runtime', node: input.runtime },
    { key: 'permission-mode', node: input.permissionMode },
    { key: 'preset', node: input.preset },
    ...(input.speech ? [{ key: 'speech', node: input.speech }] : []),
    { key: 'attach', node: input.attach },
    ...(input.contextUsage ? [{ key: 'context-usage', node: input.contextUsage }] : []),
    ...(input.graph ? [{ key: 'graph', node: input.graph }] : []),
  ], preferences)
}
