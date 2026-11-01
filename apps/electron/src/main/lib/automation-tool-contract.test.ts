import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const claude = readFileSync(resolve(import.meta.dir, 'automation-agent-tools.ts'), 'utf8')
const pi = readFileSync(resolve(import.meta.dir, 'adapters/pi-builtin-tools.ts'), 'utf8')

describe('Automation dispatch tool parity', () => {
  test('Claude MCP and Pi builtin schemas both expose create/update boundSessionId', () => {
    for (const source of [claude, pi]) {
      expect(source.match(/boundSessionId:/g)?.length).toBeGreaterThanOrEqual(4)
      expect(source).toContain('promptAuthor: { type: \'agent\', id: ctx.sessionId }')
    }
  })

  test('model-supplied tool parameters never set trusted TaskOrigin or TaskAuthorization', () => {
    for (const source of [claude, pi]) {
      expect(source).not.toContain('taskOrigin: args.')
      expect(source).not.toContain('taskAuthorization: args.')
      expect(source).toContain('promptAuthor: { type: \'agent\', id: ctx.sessionId }')
    }
  })
})
