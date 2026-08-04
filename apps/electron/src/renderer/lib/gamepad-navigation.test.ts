import { describe, expect, test } from 'bun:test'
import {
  createGamepadNavigationState,
  readGamepadActions,
  type GamepadLike,
} from './gamepad-navigation'

function gamepad({
  buttons = [],
  axes = [0, 0],
  connected = true,
}: Partial<GamepadLike> = {}): GamepadLike {
  return { connected, buttons, axes }
}

function pressed(...indices: number[]): Array<{ pressed: boolean }> {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }))
  for (const index of indices) buttons[index] = { pressed: true }
  return buttons
}

describe('readGamepadActions', () => {
  test('maps standard face and shoulder buttons on their press edge', () => {
    const state = createGamepadNavigationState()
    const result = readGamepadActions(
      [gamepad({ buttons: pressed(0, 1, 2, 3, 4, 5) })],
      state,
      0,
    )

    expect(result.actions).toEqual([
      'confirm',
      'back',
      'stopGeneration',
      'voiceDictation',
      'previousTab',
      'nextTab',
    ])
    expect(readGamepadActions([gamepad({ buttons: pressed(0, 1) })], result.state, 16).actions).toEqual([])
  })

  test('maps d-pad and left stick directions with d-pad precedence', () => {
    const state = createGamepadNavigationState()
    const fromDpad = readGamepadActions(
      [gamepad({ buttons: pressed(12, 15), axes: [-0.9, 0.9] })],
      state,
      0,
    )
    expect(fromDpad.actions).toEqual(['previous', 'right'])

    // Diagonal stick pushes collapse to one dominant-axis direction, never both.
    const fromStick = readGamepadActions(
      [gamepad({ axes: [-0.6, 0.7] })],
      createGamepadNavigationState(),
      0,
    )
    expect(fromStick.actions).toEqual(['next'])
  })

  test('stick diagonal emits only the dominant axis (never a double directional fire)', () => {
    const downLeft = readGamepadActions(
      [gamepad({ axes: [-0.8, 0.9] })],
      createGamepadNavigationState(),
      0,
    )
    expect(downLeft.actions).toEqual(['next']) // |dy| > |dx| → vertical only

    const upRight = readGamepadActions(
      [gamepad({ axes: [0.85, -0.5] })],
      createGamepadNavigationState(),
      0,
    )
    expect(upRight.actions).toEqual(['right']) // |dx| > |dy| → horizontal only

    // Exact tie favors vertical.
    const tie = readGamepadActions(
      [gamepad({ axes: [0.7, -0.7] })],
      createGamepadNavigationState(),
      0,
    )
    expect(tie.actions).toEqual(['previous'])
  })

  test('repeats held directions only after the initial delay and repeat interval', () => {
    const pad = gamepad({ axes: [0, 0.8] })
    const first = readGamepadActions([pad], createGamepadNavigationState(), 0)
    expect(first.actions).toEqual(['next'])
    expect(readGamepadActions([pad], first.state, 200).actions).toEqual([])

    const delayed = readGamepadActions([pad], first.state, 280)
    expect(delayed.actions).toEqual(['next'])
    expect(readGamepadActions([pad], delayed.state, 350).actions).toEqual([])
    expect(readGamepadActions([pad], delayed.state, 370).actions).toEqual(['next'])
  })

  test('ignores disconnected gamepads and axes inside the deadzone', () => {
    expect(readGamepadActions([gamepad({ connected: false, buttons: pressed(0) })], createGamepadNavigationState(), 0).actions).toEqual([])
    expect(readGamepadActions([gamepad({ axes: [0.49, -0.49] })], createGamepadNavigationState(), 0).actions).toEqual([])
  })
})
