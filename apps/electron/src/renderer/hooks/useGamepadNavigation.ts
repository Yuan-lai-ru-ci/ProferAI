import * as React from 'react'
import { createGamepadNavigationState, readGamepadActions } from '@/lib/gamepad-navigation'
import { navigationController } from '@/lib/navigation-controller'

/** Polls standard gamepads only while the main renderer is visible and focused. */
export function useGamepadNavigation(): void {
  React.useEffect(() => {
    let frameId = 0
    let state = createGamepadNavigationState()

    const tick = (now: number): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        const result = readGamepadActions(navigator.getGamepads(), state, now)
        state = result.state
        for (const action of result.actions) navigationController.dispatch(action)
      } else {
        state = createGamepadNavigationState()
      }
      frameId = requestAnimationFrame(tick)
    }

    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [])
}
