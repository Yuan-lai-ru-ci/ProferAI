/**
 * 「手动确认已读」开关的渲染层状态。
 *
 * 与 `atoms/notifications.ts`、`atoms/ui-preferences.ts` 的既有写法保持一致：
 * 一个朴素 boolean atom + 一个初始化函数 + 一个「先写本地再持久化、失败回滚」的更新函数。
 *
 * 这个 atom 是渲染层判据的**唯一来源**：
 * - `atoms/agent-atoms.ts` 的未读集合按它切换读写模式（关闭态＝内存集合，开启态＝持久化字段派生）；
 * - `components/agent/ConfirmReadButton.tsx` 按它决定是否可能出现。
 *
 * 不新增 IPC：复用既有的 `settings:get` / `settings:update`。
 */

import { atom } from 'jotai'

/**
 * 是否启用「手动确认已读」。
 *
 * 默认 `false`：关闭态行为与既有版本逐点一致（未读自动产生、自动清除）。
 */
export const manualReadConfirmEnabledAtom = atom<boolean>(false)

/**
 * 从主进程加载开关值。
 *
 * 返回值即归一后的开关状态，便于调用方在初始化后按模式做一次安全回填（见 `main.tsx`
 * 的 `AgentUnreadSettingsInitializer`）。读失败时保持默认 `false`（fail-safe：不改变既有行为）。
 */
export async function initializeAgentUnreadSettings(
  setEnabled: (enabled: boolean) => void,
): Promise<boolean> {
  try {
    const settings = await window.electronAPI.getSettings()
    const enabled = settings.manualReadConfirmEnabled === true
    setEnabled(enabled)
    return enabled
  } catch (error) {
    console.error('[未读设置] 初始化失败:', error)
    return false
  }
}

/**
 * 更新开关并持久化。
 *
 * 先写本地 atom（开关立即生效、下一帧按新模式渲染），再落盘；落盘失败回滚本地值。
 * 主进程读的是同步更新的设置缓存，因此**无需重启**。
 */
export async function updateManualReadConfirmEnabled(
  enabled: boolean,
  setEnabled: (enabled: boolean) => void,
): Promise<void> {
  setEnabled(enabled)
  try {
    await window.electronAPI.updateSettings({ manualReadConfirmEnabled: enabled })
  } catch (error) {
    console.error('[未读设置] 更新失败:', error)
    setEnabled(!enabled)
    throw error
  }
}
