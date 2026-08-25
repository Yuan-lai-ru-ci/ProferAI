import { describe, expect, test } from 'bun:test'
import { createToolFact } from './tool-facts'

const context = { goalId: 'goal', turnId: 'turn', taskId: 'task' }

describe('Pi Harness tool facts', () => {
  test('records a bounded file mutation fact without persisting file contents', () => {
    const fact = createToolFact(context, {
      toolUseId: 'write-1', toolName: 'Write', input: { file_path: 'src\\secret.ts', content: 'api_key=sk_should_not_appear' }, result: 'Wrote 100 bytes',
    })!
    expect(fact).toMatchObject({ kind: 'file_mutation', outcome: 'success', subject: { path: 'src/secret.ts' }, fingerprint: 'write-1' })
    expect(JSON.stringify(fact)).not.toContain('sk_should_not_appear')
    expect(JSON.stringify(fact)).not.toContain('api_key=')
  })

  test('classifies test command success and failure by actual exit evidence', () => {
    const success = createToolFact(context, {
      toolName: 'Bash', input: { command: 'bun test src/a.test.ts' }, result: '12 pass\nexit code 0',
    })!
    const failure = createToolFact(context, {
      toolName: 'Bash', input: { command: 'bun test src/a.test.ts' }, result: '1 fail\n退出码 1',
    })!
    expect(success).toMatchObject({ kind: 'verification_command', outcome: 'success', subject: { category: 'test', exitCode: 0 } })
    expect(failure).toMatchObject({ kind: 'verification_command', outcome: 'failure', subject: { category: 'test', exitCode: 1 } })
  })

  test('accepts a successful finite Pi tool result without a textual exit marker', () => {
    const fact = createToolFact(context, {
      toolName: 'Bash', input: { command: 'bun test src/a.test.ts' }, result: [{ type: 'text', text: '1 pass' }], isError: false,
    })!
    expect(fact).toMatchObject({
      kind: 'verification_command',
      outcome: 'success',
      subject: { category: 'test', executionEvidence: 'tool_result_success' },
    })
    expect(fact.subject).not.toHaveProperty('exitCode')
  })

  test('keeps external calls non-verifying even when their tool result is not an error', () => {
    const fact = createToolFact(context, { toolName: 'BrowserClick', input: {}, result: 'ok' })!
    expect(fact).toMatchObject({ kind: 'external_or_unknown', outcome: 'unknown' })
  })
})
