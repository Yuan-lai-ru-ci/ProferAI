import { describe, expect, test } from 'bun:test'
import {
  AGENT_COMPOSER_TOOL_BASE_CLASS,
  getAgentComposerToolSize,
  getAgentComposerToolTriggerClass,
} from './ComposerTool'

describe('Agent composer tool visual contract', () => {
  test('uses one canonical desktop and tablet target size', () => {
    expect(getAgentComposerToolSize()).toBe('size-[36px]')
    expect(getAgentComposerToolSize(true)).toBe('size-11')
  })

  test('keeps one hover material and focus behavior across semantic states', () => {
    for (const state of ['default', 'active', 'warning', 'muted', 'destructive'] as const) {
      const className = getAgentComposerToolTriggerClass(state)
      expect(className).toContain(AGENT_COMPOSER_TOOL_BASE_CLASS)
      expect(className).toContain('hover:bg-accent')
      expect(className).toContain('focus-visible:ring-2')
      expect(className).toContain('disabled:opacity-40')
    }
  })

  test('does not let semantic states replace the common hover material', () => {
    expect(getAgentComposerToolTriggerClass('active')).not.toContain('hover:bg-primary/10')
    expect(getAgentComposerToolTriggerClass('warning')).not.toContain('hover:bg-amber-500/10')
    expect(getAgentComposerToolTriggerClass('destructive')).not.toContain('hover:bg-destructive/10')
  })

  test('maps semantic states to distinct visual signals', () => {
    expect(getAgentComposerToolTriggerClass('active')).toContain('text-primary')
    expect(getAgentComposerToolTriggerClass('warning')).toContain('text-amber-600')
    expect(getAgentComposerToolTriggerClass('muted')).toContain('text-muted-foreground')
    expect(getAgentComposerToolTriggerClass('destructive')).toContain('text-destructive')
  })
})
