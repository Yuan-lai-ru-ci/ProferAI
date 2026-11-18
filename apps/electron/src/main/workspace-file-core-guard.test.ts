import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, 'ipc.ts'), 'utf8')

function handlerBody(channel: string): string {
  const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`ipcMain\\.handle\\(\\s*${escaped}\\s*,[\\s\\S]*?=> \\{([\\s\\S]*?)\\n    \\}\\s*\\)`,'m').exec(source)
  if (!match?.[1]) throw new Error(`IPC handler not found: ${channel}`)
  return match[1]
}

describe('remote workspace local-filesystem isolation', () => {
  test('rejects workspace path lookup before local resolver can create directories', () => {
    const body = handlerBody('AGENT_IPC_CHANNELS.GET_WORKSPACE_FILES_PATH')
    expect(body.indexOf('assertLocalWorkspaceFiles()')).toBeLessThan(body.indexOf('resolveWorkspaceFilesUiRootPath('))
  })

  test('rejects file reads, writes, mutation and shell opening before filesystem access', () => {
    const channels = [
      'AGENT_IPC_CHANNELS.GET_SESSION_PATH',
      'AGENT_IPC_CHANNELS.GET_SESSION_STORAGE_PATH',
      'AGENT_IPC_CHANNELS.LIST_DIRECTORY',
      'AGENT_IPC_CHANNELS.READ_DIRECTORY_RECURSIVE',
      'AGENT_IPC_CHANNELS.READ_ATTACHED_FILE',
      'AGENT_IPC_CHANNELS.DELETE_FILE',
      'AGENT_IPC_CHANNELS.MOVE_TO_TRASH',
      'AGENT_IPC_CHANNELS.RENAME_FILE',
      'AGENT_IPC_CHANNELS.MOVE_FILE',
      'AGENT_IPC_CHANNELS.SHOW_IN_FOLDER',
      'AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER',
      'IPC_CHANNELS.SYSTEM_OPEN_FILE',
      'IPC_CHANNELS.SHOW_ITEM_IN_FOLDER',
      'AGENT_IPC_CHANNELS.OPEN_FILE_IN_BROWSER',
      'AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER',
      "'file:resolve-path'",
      "'file:describe-path'",
      "'file:resolve-html-preview-path'",
      "'file:prepare-pdf-preview'",
      "'file:docx-to-html'",
      "'file:office-to-html'",
      "'file:register-preview-path'",
      "'file:read-binary-base64'",
    ]
    for (const channel of channels) {
      const body = handlerBody(channel)
      expect(body.indexOf('assertLocalWorkspaceFiles()'), channel).toBeGreaterThanOrEqual(0)
      const effects = ['resolve(', 'readFile', 'writeFile', 'rmSync(', 'renameSync(', 'shell.openPath(', 'shell.showItemInFolder(']
        .map(term => body.indexOf(term)).filter(index => index >= 0)
      expect(effects.every(index => body.indexOf('assertLocalWorkspaceFiles()') < index), channel).toBe(true)
    }
  })

  test('rejects workspace search and preview protocols before resolving local paths', () => {
    for (const channel of ['AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES', "'file:resolve-and-read'", "'file:write-text'", "'file:read-binary-base64'"]) {
      const body = handlerBody(channel)
      expect(body.indexOf('assertLocalWorkspaceFiles()'), channel).toBeGreaterThanOrEqual(0)
      const resolver = Math.max(body.indexOf('resolve('), body.indexOf('resolveFilePath('), body.indexOf('resolveTargetPath('))
      if (resolver >= 0) expect(body.indexOf('assertLocalWorkspaceFiles()'), channel).toBeLessThan(resolver)
    }
  })
})
