import type { NavigationAction } from './navigation-actions'

export interface GamepadLike {
  connected: boolean
  buttons: ArrayLike<{ pressed: boolean }>
  axes: ArrayLike<number>
}

export interface GamepadNavigationState {
  pressedButtons: Set<number>
  heldDirections: Set<NavigationAction>
  nextRepeatAt: Map<NavigationAction, number>
}

export interface GamepadNavigationResult {
  actions: NavigationAction[]
  state: GamepadNavigationState
}

const DEADZONE = 0.5
const INITIAL_REPEAT_DELAY_MS = 280
const REPEAT_INTERVAL_MS = 90

const BUTTON_ACTIONS: ReadonlyArray<readonly [number, NavigationAction]> = [
  [0, 'confirm'],
  [1, 'back'],
  [2, 'stopGeneration'],
  [3, 'voiceDictation'],
  [4, 'previousTab'],
  [5, 'nextTab'],
]

const DPAD_UP = 12
const DPAD_DOWN = 13
const DPAD_LEFT = 14
const DPAD_RIGHT = 15

export function createGamepadNavigationState(): GamepadNavigationState {
  return {
    pressedButtons: new Set(),
    heldDirections: new Set(),
    nextRepeatAt: new Map(),
  }
}

function isPressed(gamepad: GamepadLike, index: number): boolean {
  return gamepad.buttons[index]?.pressed === true
}

/**
 * Resolves stick input into at most one direction, favoring the dominant axis on
 * diagonal pushes. A stick always reports an (x, y) pair even when the user only
 * means to push straight, so emitting both axes would fire two navigation actions
 * in the same frame and skip past the intended target.
 */
function stickDirection(axisX: number, axisY: number): NavigationAction | undefined {
  const xMagnitude = Math.abs(axisX)
  const yMagnitude = Math.abs(axisY)
  const beyondX = xMagnitude >= DEADZONE
  const beyondY = yMagnitude >= DEADZONE
  if (!beyondX && !beyondY) return undefined
  // Pick whichever axis is pushed harder; ties favor vertical (most navigation is up/down).
  if (beyondY && (!beyondX || yMagnitude >= xMagnitude)) {
    return axisY <= -DEADZONE ? 'previous' : 'next'
  }
  return axisX < 0 ? 'left' : 'right'
}

/**
 * D-pad buttons each act independently (a user can intentionally hold two at
 * once), while the stick is reduced to one dominant-axis direction. If any d-pad
 * button is pressed it takes precedence over a stick push in the same axis.
 */
function getDirections(gamepad: GamepadLike): NavigationAction[] {
  const axisX = gamepad.axes[0] ?? 0
  const axisY = gamepad.axes[1] ?? 0
  const dpadUp = isPressed(gamepad, DPAD_UP)
  const dpadDown = isPressed(gamepad, DPAD_DOWN)
  const dpadLeft = isPressed(gamepad, DPAD_LEFT)
  const dpadRight = isPressed(gamepad, DPAD_RIGHT)

  const actions: NavigationAction[] = []
  // Vertical: d-pad first, then stick.
  if (dpadUp) actions.push('previous')
  else if (dpadDown) actions.push('next')
  else {
    const stick = stickDirection(axisX, axisY)
    if (stick === 'previous' || stick === 'next') actions.push(stick)
  }
  // Horizontal: stick only if the stick was resolved as horizontal (diagonals
  // already collapse to the dominant axis, so a horizontal read here never
  // overlaps with a vertical read).
  if (dpadLeft) actions.push('left')
  else if (dpadRight) actions.push('right')
  else {
    const stick = stickDirection(axisX, axisY)
    if (stick === 'left' || stick === 'right') actions.push(stick)
  }
  return actions
}

/**
 * Converts a standard gamepad snapshot into semantic actions without touching DOM APIs.
 * Button actions fire on their press edge. Directions emit once, then repeat while held.
 */
export function readGamepadActions(
  gamepads: readonly (GamepadLike | null | undefined)[],
  previousState: GamepadNavigationState,
  now: number,
): GamepadNavigationResult {
  const gamepad = gamepads.find((candidate) => candidate?.connected)
  const state = createGamepadNavigationState()
  const actions: NavigationAction[] = []

  if (!gamepad) return { actions, state }

  for (const [index, action] of BUTTON_ACTIONS) {
    if (!isPressed(gamepad, index)) continue
    state.pressedButtons.add(index)
    if (!previousState.pressedButtons.has(index)) actions.push(action)
  }

  for (const action of getDirections(gamepad)) {
    state.heldDirections.add(action)
    const wasHeld = previousState.heldDirections.has(action)
    const repeatAt = previousState.nextRepeatAt.get(action)
    if (!wasHeld) {
      actions.push(action)
      state.nextRepeatAt.set(action, now + INITIAL_REPEAT_DELAY_MS)
    } else if (repeatAt !== undefined && now >= repeatAt) {
      actions.push(action)
      state.nextRepeatAt.set(action, now + REPEAT_INTERVAL_MS)
    } else if (repeatAt !== undefined) {
      state.nextRepeatAt.set(action, repeatAt)
    }
  }

  return { actions, state }
}
