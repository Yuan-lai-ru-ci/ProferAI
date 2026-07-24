import { describe, expect, test } from 'bun:test'
import { getPreviewCandidateBasePaths, isAbsoluteFilePath } from './preview-open-path'

describe('preview path resolution helpers', () => {
  test('adds the session CWD after explicit candidate paths for relative history entries', () => {
    expect(getPreviewCandidateBasePaths(
      ['D:/workspace/attached'],
      'D:/workspace/session-cwd',
    )).toEqual(['D:/workspace/attached', 'D:/workspace/session-cwd'])
  })

  test('removes duplicate and empty candidate paths', () => {
    expect(getPreviewCandidateBasePaths(
      ['D:/workspace/session-cwd', ''],
      'D:/workspace/session-cwd',
      undefined,
    )).toEqual(['D:/workspace/session-cwd'])
  })

  test('distinguishes absolute paths so callers do not apply a relative-path fallback', () => {
    expect(isAbsoluteFilePath('C:/workspace/report.md')).toBe(true)
    expect(isAbsoluteFilePath('/workspace/report.md')).toBe(true)
    expect(isAbsoluteFilePath('.context/report.md')).toBe(false)
  })
})
