import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

let paginateSDKMessages: typeof import('./agent-session-manager').paginateSDKMessages

beforeAll(async () => {
  paginateSDKMessages = (await import(`./agent-session-manager?pagination-test=${Date.now()}`)).paginateSDKMessages
})

function userInput(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

function toolResult(): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    parent_tool_use_id: 'tool-1',
  } as SDKMessage
}

function assistant(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

describe('paginateSDKMessages', () => {
  test('expands backward to the user-input boundary so upward paging never starts with an assistant fragment', () => {
    const messages = [
      userInput('first request'),
      assistant('first progress'),
      toolResult(),
      assistant('first completion'),
      userInput('second request'),
      assistant('second progress'),
      toolResult(),
      assistant('second completion'),
    ]

    const newestPage = paginateSDKMessages(messages, { targetMessages: 3 })
    expect(newestPage.startIndex).toBe(4)
    expect(newestPage.hasMore).toBe(true)
    expect(newestPage.messages).toEqual(messages.slice(4))

    const earlierPage = paginateSDKMessages(messages, {
      before: newestPage.startIndex,
      targetMessages: 3,
    })
    expect(earlierPage.startIndex).toBe(0)
    expect(earlierPage.hasMore).toBe(false)
    expect([...earlierPage.messages, ...newestPage.messages]).toEqual(messages)
  })
})
