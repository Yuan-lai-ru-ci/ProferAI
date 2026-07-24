import { describe, expect, test } from 'bun:test'
import { localFileUrlToPath } from './message'

describe('localFileUrlToPath', () => {
  test('normalizes a Windows file URL to an absolute Windows path', () => {
    expect(localFileUrlToPath('file:///C:/Users/yuan/Documents/report%20final.md'))
      .toBe('C:/Users/yuan/Documents/report final.md')
  })

  test('preserves an absolute Unix file path', () => {
    expect(localFileUrlToPath('file:///tmp/profer/report.md')).toBe('/tmp/profer/report.md')
  })

  test('allows localhost but rejects remote-host file URLs', () => {
    expect(localFileUrlToPath('file://localhost/C:/workspace/readme.md'))
      .toBe('C:/workspace/readme.md')
    expect(localFileUrlToPath('file://server/share/secret.md')).toBeNull()
  })

  test('rejects non-file URLs', () => {
    expect(localFileUrlToPath('https://example.com/report.md')).toBeNull()
  })
})
