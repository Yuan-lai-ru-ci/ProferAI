import { describe, expect, test } from 'bun:test'
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { createControlledLocalBashOperations, wrapToolWithPermission } from './adapters/pi-agent-adapter'
import { createToolFact } from './pi-harness/tool-facts'
import { createCommandExecutionLedger } from './pi-execution-ledger'

const executionTemplate = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  shell: '/bin/bash',
  cwd: process.cwd(),
  truncated: false,
} as const

describe('Pi execution correlation integration', () => {
  test('keeps two wrapped Bash toolCallIds separate through execution ledger and Harness facts', async () => {
    const ledger = createCommandExecutionLedger()
    const operations = createControlledLocalBashOperations(
      'pi-execution-correlation-test',
      '/bin/bash',
      (toolCallId, result) => ledger.set(toolCallId, result),
    )
    const rawTool = createBashToolDefinition(process.cwd(), { operations })
    const tool = wrapToolWithPermission(rawTool, {})

    await expect(
      tool.execute('tool-first', { command: "printf 'first'; exit 3" }, undefined, undefined, undefined as never),
    ).rejects.toThrow('Command exited with code 3')
    const secondCall = await tool.execute(
      'tool-second',
      { command: "printf 'second'" },
      undefined,
      undefined,
      undefined as never,
    )

    expect(secondCall.content[0]).toMatchObject({ type: 'text' })

    const firstExecution = ledger.get('tool-first')
    const secondExecution = ledger.get('tool-second')
    expect(firstExecution).toMatchObject({ stdout: 'first', exitCode: 3, shell: '/bin/bash' })
    expect(secondExecution).toMatchObject({ stdout: 'second', exitCode: 0, shell: '/bin/bash' })
    expect(ledger.get('tool-missing')).toBeUndefined()

    const firstFact = createToolFact(
      { goalId: 'goal', turnId: 'turn', taskId: 'task' },
      {
        toolUseId: 'tool-first',
        toolName: 'Bash',
        input: { command: "printf 'first'; exit 3" },
        result: 'Command exited with code 3',
        executionResult: firstExecution,
        isError: true,
      },
    )!
    const secondFact = createToolFact(
      { goalId: 'goal', turnId: 'turn', taskId: 'task' },
      {
        toolUseId: 'tool-second',
        toolName: 'Bash',
        input: { command: "printf 'second'" },
        result: secondCall.content,
        executionResult: secondExecution,
      },
    )!

    expect(firstFact).toMatchObject({ fingerprint: 'tool-first', outcome: 'failure', subject: { exitCode: 3 } })
    expect(secondFact).toMatchObject({ fingerprint: 'tool-second', outcome: 'success', subject: { exitCode: 0 } })
    expect(firstFact.subject.outputHash).not.toBe(secondFact.subject.outputHash)
  })

  test('ledger retains the structured shape required by the orchestrator callback', () => {
    const ledger = createCommandExecutionLedger()
    ledger.set('tool-1', { ...executionTemplate, stdout: 'one' })
    ledger.set('tool-2', { ...executionTemplate, stdout: 'two', exitCode: 2 })

    expect(ledger.get('tool-1')).toMatchObject({ stdout: 'one', exitCode: 0 })
    expect(ledger.get('tool-2')).toMatchObject({ stdout: 'two', exitCode: 2 })
    ledger.delete('tool-1')
    expect(ledger.get('tool-1')).toBeUndefined()
    expect(ledger.get('tool-2')).toBeDefined()
  })
})
