import type {
  ComposerToolbarItemPreference,
  ComposerToolbarPreferences,
} from '../../types'
import type { ComposerToolbarItem } from '@/components/ai-elements/composer/ComposerToolbar'

export type ComposerToolbarSurface = 'chat' | 'agent'

export interface ComposerToolbarToolDefinition {
  key: string
  label: string
  description: string
  /** 核心工具始终显示，但可调整位置。发送/停止按钮不属于此目录，因此不可配置。 */
  core?: boolean
}

export const COMPOSER_TOOLBAR_DEFINITIONS: Record<ComposerToolbarSurface, readonly ComposerToolbarToolDefinition[]> = {
  chat: [
    { key: 'model', label: '模型', description: '选择当前对话使用的模型。', core: true },
    { key: 'attach', label: '附件', description: '添加文件到当前对话。', core: true },
    { key: 'thinking', label: '思考模式', description: '切换当前对话的思考模式。' },
    { key: 'speech', label: '语音输入', description: '从语音输入浮窗插入文字。' },
    { key: 'tools', label: '工具', description: '启用或停用当前对话工具。' },
    { key: 'context', label: '上下文', description: '调整当前对话的上下文设置。' },
    { key: 'clear', label: '清除上下文', description: '清除当前对话的上下文。' },
  ],
  agent: [
    { key: 'model', label: '模型', description: '选择 Agent 使用的模型。', core: true },
    { key: 'attach', label: '附件', description: '添加文件或目录到当前任务。', core: true },
    { key: 'runtime', label: '运行时', description: '切换 Agent 运行时。' },
    { key: 'permission-mode', label: '权限模式', description: '调整当前会话的权限策略。' },
    { key: 'preset', label: '预设', description: '切换当前会话使用的 Agent 预设。' },
    { key: 'speech', label: '语音输入', description: '从语音输入浮窗插入文字。' },
    { key: 'context-usage', label: '上下文用量', description: '查看并管理当前会话的上下文用量。' },
    { key: 'graph', label: '任务图', description: '查看当前任务的图结构。' },
    // 追加在末尾：老用户已保存的 order 值不会被重排，新入口默认排最后。
    { key: 'handoff', label: '会话交接', description: '随时整理交接文档并新建会话继续，不受建议轮数阈值限制。' },
  ],
}

function definitionMap(surface: ComposerToolbarSurface): Map<string, ComposerToolbarToolDefinition> {
  return new Map(COMPOSER_TOOLBAR_DEFINITIONS[surface].map((definition) => [definition.key, definition]))
}

export function normalizeComposerToolbarPreferences(
  preferences: ComposerToolbarPreferences | undefined,
): ComposerToolbarPreferences {
  const normalized: ComposerToolbarPreferences = {}
  for (const surface of ['chat', 'agent'] as const) {
    const definitions = COMPOSER_TOOLBAR_DEFINITIONS[surface]
    const saved = preferences?.[surface] ?? {}
    const next: Record<string, ComposerToolbarItemPreference> = {}
    definitions.forEach((definition, index) => {
      const entry = saved[definition.key]
      next[definition.key] = {
        visible: definition.core ? true : entry?.visible !== false,
        order: Number.isFinite(entry?.order) ? entry!.order : index,
      }
    })
    normalized[surface] = next
  }
  return normalized
}

export function applyComposerToolbarPreferences(
  surface: ComposerToolbarSurface,
  items: ComposerToolbarItem[],
  preferences: ComposerToolbarPreferences | undefined,
): ComposerToolbarItem[] {
  const definitions = definitionMap(surface)
  const saved = preferences?.[surface] ?? {}
  const fallbackOrder = new Map(COMPOSER_TOOLBAR_DEFINITIONS[surface].map((definition, index) => [definition.key, index]))

  return items
    .map((item, index) => {
      const definition = definitions.get(item.key)
      const entry = saved[item.key]
      const core = definition?.core === true
      return {
        ...item,
        visible: item.visible === false ? false : (core || entry?.visible !== false),
        order: Number.isFinite(entry?.order) ? entry!.order : (fallbackOrder.get(item.key) ?? index),
        canOverflow: core ? false : item.canOverflow,
      }
    })
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
}

export function updateComposerToolbarSurfacePreferences(
  current: ComposerToolbarPreferences,
  surface: ComposerToolbarSurface,
  orderedKeys: readonly string[],
  visibleKeys: ReadonlySet<string>,
): ComposerToolbarPreferences {
  const definitions = COMPOSER_TOOLBAR_DEFINITIONS[surface]
  const order = new Map(orderedKeys.map((key, index) => [key, index]))
  const nextSurface: Record<string, ComposerToolbarItemPreference> = {}

  definitions.forEach((definition, index) => {
    nextSurface[definition.key] = {
      visible: definition.core ? true : visibleKeys.has(definition.key),
      order: order.get(definition.key) ?? index,
    }
  })

  return { ...current, [surface]: nextSurface }
}
