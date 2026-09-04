import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TEAM_WORKSPACE_LAYOUT_MODE,
  TEAM_WORKSPACE_LAYOUT_MODE_STORAGE_KEY,
} from './team-layout-mode'

describe('团队工作区布局模式', () => {
  test('默认以文件为主，并使用独立的持久化键', () => {
    expect(DEFAULT_TEAM_WORKSPACE_LAYOUT_MODE).toBe('files')
    expect(TEAM_WORKSPACE_LAYOUT_MODE_STORAGE_KEY).toBe('profer-team-layout-mode')
  })
})
