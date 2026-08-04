import type { NavigationAction } from './navigation-actions'

export type NavigationConsumer = (action: NavigationAction) => boolean

interface ConsumerEntry {
  consumer: NavigationConsumer
  priority: number
  sequence: number
}

export interface NavigationController {
  register: (consumer: NavigationConsumer, priority?: number) => () => void
  dispatch: (action: NavigationAction) => boolean
}

/**
 * Returns true for native and rich text editing contexts. Navigation input must
 * not replace their native arrow-key and confirm semantics.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as {
    tagName?: string
    isContentEditable?: boolean
    closest?: (selector: string) => Element | null | undefined
  }
  const tagName = element.tagName?.toUpperCase()
  return tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || element.isContentEditable === true
    || Boolean(element.closest?.('[contenteditable="true"], .ProseMirror'))
}

export function createNavigationController(): NavigationController {
  const consumers = new Set<ConsumerEntry>()
  let sequence = 0

  return {
    register(consumer, priority = 0) {
      const entry: ConsumerEntry = { consumer, priority, sequence: sequence++ }
      consumers.add(entry)
      return () => consumers.delete(entry)
    },
    dispatch(action) {
      const ordered = [...consumers].sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)
      for (const { consumer } of ordered) {
        if (consumer(action)) return true
      }
      return false
    },
  }
}

export const navigationController = createNavigationController()
