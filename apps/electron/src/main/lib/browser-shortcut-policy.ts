import type { Input } from 'electron'
import type { BrowserShortcutBinding } from '@profer/shared'

/** Electron 与 DOM key 的最小共同规范；不把普通网页编辑键转为应用快捷键。 */
export function normalizeBrowserShortcutKey(key: string): string {
  const normalized = key.toLowerCase()
  return ({ arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', escape: 'esc', return: 'enter', ' ': 'space', '+': 'plus' } as Record<string, string>)[normalized] ?? normalized
}

export function matchBrowserShortcut(input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt' | 'isComposing'>, bindings: readonly BrowserShortcutBinding[]): BrowserShortcutBinding | undefined {
  if (input.type !== 'keyDown' || input.isComposing) return undefined
  const key = normalizeBrowserShortcutKey(input.key)
  return bindings.find(binding => {
    const keyMatches = binding.key === key || (binding.key === '=' && ['plus', 'add', 'numadd'].includes(key)) || (binding.key === '-' && ['subtract', 'numsub'].includes(key))
    const shiftMatches = binding.shift === input.shift || (binding.key === '=' && !binding.shift && ['=', 'plus'].includes(key))
    return keyMatches && shiftMatches && binding.meta === input.meta && binding.control === input.control && binding.alt === input.alt
  })
}
