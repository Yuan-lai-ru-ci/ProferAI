import { describe, expect, test } from 'bun:test'
import { normalizeToolInputForValidation, validateToolInput } from './agent-tool-input-validator'

describe('agent tool input validation', () => {
  test('Claude Edit canonical input passes', () => {
    expect(validateToolInput('Edit', {
      file_path: 'src/example.ts',
      old_string: 'const before = 1',
      new_string: 'const after = 1',
    })).toBeNull()
  })

  test('Pi native Edit input is normalized before required-parameter validation', () => {
    const input = {
      path: 'src/example.ts',
      edits: [{ oldText: 'const before = 1', newText: 'const after = 1' }],
    }

    expect(normalizeToolInputForValidation('Edit', input)).toMatchObject({
      toolName: 'Edit',
      input: {
        file_path: 'src/example.ts',
        old_string: 'const before = 1',
        new_string: 'const after = 1',
      },
    })
    expect(validateToolInput('Edit', input)).toBeNull()
  })

  test('Pi MultiEdit input uses the same canonical validation and does not require top-level new_string', () => {
    expect(validateToolInput('MultiEdit', {
      path: 'src/example.ts',
      edits: [
        { oldText: 'const before = 1', newText: 'const after = 1' },
        { oldText: 'const other = 2', newText: 'const changed = 2' },
      ],
    })).toBeNull()
  })

  test('missing Pi nested newText reports the native field and recovery instruction', () => {
    const result = validateToolInput('Edit', {
      path: 'src/example.ts',
      edits: [{ oldText: 'const before = 1' }],
    })

    expect(result?.message).toContain('edits[0].newText')
    expect(result?.message).toContain('re-reading the current file')
    expect(result?.message).toContain('do not reuse oldText')
  })

  test('Pi Read and Write path is normalized to file_path', () => {
    expect(validateToolInput('Read', { path: 'src/example.ts' })).toBeNull()
    expect(validateToolInput('Write', { path: 'src/example.ts', content: 'content' })).toBeNull()
  })

  test('unknown tools remain compatible', () => {
    expect(validateToolInput('CustomTool', {})).toBeNull()
  })
})
