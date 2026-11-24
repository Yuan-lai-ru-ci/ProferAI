/** 权限选择菜单只表达用户可选模式；实际权限由 Core/主进程权威返回，不在 UI 重施预设上限。 */
import type { ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_ORDER } from '@profer/shared'
import { resolveSessionPermissionMode } from '@/lib/agent-session-permission'

/** 无会话选择时跟随预设默认，否则原样显示后端已确认的模式。 */
export function resolveSelectorMode(
  presetDefault: ProferPermissionMode,
  selectedMode: ProferPermissionMode | undefined,
): ProferPermissionMode {
  return resolveSessionPermissionMode(presetDefault, selectedMode)
}

export interface PermissionModeMenuEntry {
  mode: ProferPermissionMode
  selectable: boolean
}

/** 顺序与双端同源；显式可信用户设置允许选择全部模式。 */
export function buildPermissionModeMenu(_presetDefault: ProferPermissionMode): PermissionModeMenuEntry[] {
  return PROFER_PERMISSION_MODE_ORDER.map(mode => ({ mode, selectable: true }))
}
