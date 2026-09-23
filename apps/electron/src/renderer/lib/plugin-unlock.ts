/** 版本号连击解锁开发者模式的纯状态机。 */

export const DEVELOPER_MODE_UNLOCK_CLICK_COUNT = 5
export const DEVELOPER_MODE_UNLOCK_MAX_GAP_MS = 1_500

export interface DeveloperModeUnlockClickState {
  count: number
  lastClickedAt: number | null
}

export interface DeveloperModeUnlockClickResult {
  state: DeveloperModeUnlockClickState
  unlocked: boolean
}

export const INITIAL_DEVELOPER_MODE_UNLOCK_CLICK_STATE: DeveloperModeUnlockClickState = {
  count: 0,
  lastClickedAt: null,
}

/**
 * 仅把时间间隔足够短的点击视为同一序列；达到阈值后重置，避免重复触发。
 */
export function advanceDeveloperModeUnlockClick(
  state: DeveloperModeUnlockClickState,
  clickedAt: number,
): DeveloperModeUnlockClickResult {
  const continuesSequence = state.lastClickedAt !== null
    && clickedAt >= state.lastClickedAt
    && clickedAt - state.lastClickedAt <= DEVELOPER_MODE_UNLOCK_MAX_GAP_MS
  const count = continuesSequence ? state.count + 1 : 1

  if (count >= DEVELOPER_MODE_UNLOCK_CLICK_COUNT) {
    return {
      state: { count: 0, lastClickedAt: null },
      unlocked: true,
    }
  }

  return {
    state: { count, lastClickedAt: clickedAt },
    unlocked: false,
  }
}
