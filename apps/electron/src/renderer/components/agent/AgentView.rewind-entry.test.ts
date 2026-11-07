import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, 'AgentView.tsx'), 'utf8')

describe('AgentView rewind entry contract', () => {
  test('legacy rewindSession is not called by AgentView', () => {
    expect(source).not.toMatch(/window\.electronAPI\.rewindSession/)
  })

  test('rewind actions use the typed client and shared preview dialog', () => {
    expect(source).toContain('window.electronAPI.prepareRewind(input)')
    expect(source).toContain('window.electronAPI.executeRewind(input)')
    expect(source).toContain('<RewindDialog')
    expect(source).toContain("intent: 'edit-resend'")
    expect(source).toContain("intent: 'regenerate'")
  })
})
