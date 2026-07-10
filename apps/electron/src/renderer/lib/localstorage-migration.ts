/**
 * localStorage key 迁移：proma-* → profer-*（一次性，幂等）
 *
 * B 阶段去 proma 化（2026-07-10）：所有 localStorage key 前缀从 proma- 改为 profer-。
 * 此迁移确保存量用户的旧 key 值在升级后不丢失——读旧写新，一两个版本后移除旧读。
 */

/** 旧 key → 新 key 映射表 */
const KEY_MAP: Record<string, string> = {
  'proma-app-mode': 'profer-app-mode',
  'proma-auth-status': 'profer-auth-status',
  'proma-auto-preview-enabled': 'profer-auto-preview-enabled',
  'proma-selected-model': 'profer-selected-model',
  'proma-context-length': 'profer-context-length',
  'proma-thinking-enabled': 'profer-thinking-enabled',
  'proma-thinking-expanded': 'profer-thinking-expanded',
  'proma-workspace-list-height': 'profer-workspace-list-height',
  'proma-left-sidebar-width': 'profer-left-sidebar-width',
  'proma-selected-system-prompt-id': 'profer-selected-system-prompt-id',
  'proma-sidebar-collapsed': 'profer-sidebar-collapsed',
  'proma-theme-mode': 'profer-theme-mode',
  'proma-theme-style': 'profer-theme-style',
  'proma-interface-variant': 'profer-interface-variant',
  'proma-agent-process-groups-keep-expanded': 'profer-agent-process-groups-keep-expanded',
  'proma-agent-sidepanel-open': 'profer-agent-sidepanel-open',
  'proma-agent-sidepanel-width': 'profer-agent-sidepanel-width',
  'proma-user-profile': 'profer-user-profile',
}

let migrated = false

/** 一次性迁移：若有旧 key 值且新 key 为空，则拷贝。幂等、不删旧 key。 */
export function migrateLocalStorageKeys(): void {
  if (migrated) return
  migrated = true
  try {
    for (const [oldKey, newKey] of Object.entries(KEY_MAP)) {
      if (localStorage.getItem(newKey) !== null) continue // 新 key 已有值，跳过
      const oldValue = localStorage.getItem(oldKey)
      if (oldValue !== null) {
        localStorage.setItem(newKey, oldValue)
      }
    }
  } catch {
    // localStorage 不可用时静默降级（无痕模式等）
  }
}
