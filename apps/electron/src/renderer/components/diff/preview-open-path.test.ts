import { describe, expect, test } from 'bun:test'
import { getDefaultAppTargetPath, getPreviewCandidateBasePaths } from './preview-open-path'

describe('default app preview paths', () => {
  test('repairs a config directory separator swallowed from a Windows file URL', () => {
    const file = {
      filePath: 'C:/Users/yuan.profer-dev/agent-workspaces/default/session/word_test.docx',
      previewOnly: true,
    }

    expect(getDefaultAppTargetPath(file, '')).toBe(
      'C:/Users/yuan/.profer-dev/agent-workspaces/default/session/word_test.docx',
    )
  })

  test('normalizes candidate roots used by the default-app authorization check', () => {
    expect(getPreviewCandidateBasePaths([
      'C:/Users\\yuan.profer-dev\\agent-workspaces\\default\\session',
    ])).toEqual([
      'C:/Users/yuan/.profer-dev/agent-workspaces/default/session',
    ])
  })
})
