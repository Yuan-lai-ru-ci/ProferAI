/**
 * WebUI 命令权限边界的行为测试。
 *
 * 这些用例对应一条真实的安全边界：网页凭据（可分享的链接）能拿到的能力，
 * 必须小于移动端配对凭据。任何一条放宽都会让「分享一个会话」变成「分享整台机器」。
 */
import { describe, expect, test } from 'bun:test'
import {
  checkWebuiCommandAccess,
  filterWebuiSessionIds,
  readCommandSessionId,
  WEBUI_ALLOWED_COMMANDS,
  WEBUI_SESSION_SCOPED_COMMANDS,
} from './webui-command-scope'

const published = ['session-a', 'session-b']

describe('WebUI 命令白名单', () => {
  test('Given 页面用到的命令 When 目标是已发布会话 Then 放行', () => {
    for (const type of ['get_sdk_messages', 'send_message', 'session_detail', 'get_goal', 'respond_permission']) {
      const result = checkWebuiCommandAccess({ type, sessionId: 'session-a', requestSessionId: 'session-a', publishedIds: published })
      expect(result.ok).toBe(true)
    }
  })

  test('Given 列表/删除类命令 When 从网页调用 Then 拒绝（不能枚举或删除别的会话）', () => {
    // rewind_session 已作为「编辑重发」开放，但只对已发布会话生效（见下面的新增能力用例）
    for (const type of ['list_sessions', 'delete_session', 'list_workspaces', 'fork_session', 'create_workspace']) {
      const result = checkWebuiCommandAccess({ type, sessionId: 'session-a', publishedIds: published })
      expect(result.ok).toBe(false)
    }
  })

  test('Given 已发布会话之外的 sessionId When 调用会话命令 Then 拒绝', () => {
    const result = checkWebuiCommandAccess({ type: 'get_sdk_messages', sessionId: 'session-c', publishedIds: published })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('未发布')
  })

  test('Given 会话命令缺 sessionId When 调用 Then 拒绝而不是当作全局命令', () => {
    const result = checkWebuiCommandAccess({ type: 'get_sdk_messages', sessionId: null, publishedIds: published })
    expect(result.ok).toBe(false)
  })

  test('Given 审批命令的请求属于未发布会话 When 处理 Then 拒绝', () => {
    const result = checkWebuiCommandAccess({
      type: 'respond_permission',
      sessionId: null,
      requestSessionId: 'session-c',
      publishedIds: published,
    })
    expect(result.ok).toBe(false)
  })

  test('Given 审批命令查不到归属 When 处理 Then 拒绝（不放行无主审批）', () => {
    const result = checkWebuiCommandAccess({ type: 'respond_ask_user', sessionId: null, publishedIds: published })
    expect(result.ok).toBe(false)
  })

  test('Given 未知命令 When 从网页调用 Then 拒绝，且不暗示命令存在', () => {
    const result = checkWebuiCommandAccess({ type: 'some_future_command', sessionId: 'session-a', publishedIds: published })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).not.toContain('sessionId')
  })

  test('Given 白名单内容 When 检查 Then 不包含任何会话枚举/删除/工作区管理命令', () => {
    for (const forbidden of ['list_sessions', 'delete_session', 'create_workspace', 'delete_workspace', 'upload_attachment']) {
      expect(WEBUI_ALLOWED_COMMANDS.has(forbidden)).toBe(false)
    }
  })
})

describe('WebUI 事件回放的作用域过滤', () => {
  test('Given 请求附带多个会话 When 过滤 Then 只留已发布的', () => {
    expect(filterWebuiSessionIds(['session-a', 'session-c'], published)).toEqual(['session-a'])
  })

  test('Given 全部未发布 When 过滤 Then 返回空数组（不会退化成「全量」）', () => {
    expect(filterWebuiSessionIds(['session-x'], published)).toEqual([])
  })
})


describe('命令自带会话标识的解析', () => {
  test('Given 顶层 sessionId When 解析 Then 直接采用', () => {
    expect(readCommandSessionId({ sessionId: ' s1 ' })).toBe('s1')
  })

  test('Given Pocket 旧版 access.sessionId When 解析 Then 同样认（否则网页端读图会被误拒）', () => {
    expect(readCommandSessionId({ filePath: '/x.png', access: { sessionId: 's1' } })).toBe('s1')
  })

  test('Given 两种都缺或为脏值 When 解析 Then 返回 null 而不是空串', () => {
    expect(readCommandSessionId({})).toBeNull()
    expect(readCommandSessionId({ sessionId: '   ' })).toBeNull()
    expect(readCommandSessionId({ access: { sessionId: 42 } })).toBeNull()
    expect(readCommandSessionId({ access: [] })).toBeNull()
  })
})


describe('WebUI 新增能力的边界', () => {
  test('Given 运行中追加消息 / 编辑回退 / 文本预览 When 检查 Then 均在白名单内且绑定会话', () => {
    for (const type of ['queue_message', 'rewind_session', 'read_text_file']) {
      expect(WEBUI_ALLOWED_COMMANDS.has(type)).toBe(true)
      // 这三个都必须带 sessionId：否则等于允许对任意会话排消息 / 回退 / 读文件
      expect(checkWebuiCommandAccess({ type, sessionId: null, publishedIds: published }).ok).toBe(false)
      expect(checkWebuiCommandAccess({ type, sessionId: 'session-a', publishedIds: published }).ok).toBe(true)
    }
  })

  test('Given 未发布会话 When 回退或排队 Then 拒绝', () => {
    for (const type of ['queue_message', 'rewind_session']) {
      expect(checkWebuiCommandAccess({ type, sessionId: 'session-c', publishedIds: published }).ok).toBe(false)
    }
  })
})


describe('补充命令的权限边界（回归：曾只进 SCOPED 没进 ALLOWED）', () => {
  test('list_skills 与 get_agent_runtime_contexts 必须同时进 ALLOWED', () => {
    expect(WEBUI_ALLOWED_COMMANDS.has('list_skills')).toBe(true)
    expect(WEBUI_ALLOWED_COMMANDS.has('get_agent_runtime_contexts')).toBe(true)
  })

  test('list_skills 绑定会话；get_agent_runtime_contexts 用 sessionIds 数组不能进 SESSION_SCOPED', () => {
    expect(WEBUI_SESSION_SCOPED_COMMANDS.has('list_skills')).toBe(true)
    expect(WEBUI_SESSION_SCOPED_COMMANDS.has('get_agent_runtime_contexts')).toBe(false)
  })

  test('网页调用 list_skills 缺 sessionId 时被会话作用域拒绝，而不是「不支持该操作」', () => {
    const result = checkWebuiCommandAccess({ type: 'list_skills', sessionId: null, publishedIds: published })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当被拒绝')
    expect(result.error).not.toContain('网页端不支持')
  })

  test('get_agent_runtime_contexts 不带 sessionId 也能通过（handler 内按发布白名单收口）', () => {
    expect(checkWebuiCommandAccess({ type: 'get_agent_runtime_contexts', sessionId: null, publishedIds: published }).ok).toBe(true)
  })
})


describe('@ 文件引用的权限边界', () => {
  test('list_workspace_files 同时进 ALLOWED 与 SESSION_SCOPED（双集合坑回归）', () => {
    expect(WEBUI_ALLOWED_COMMANDS.has('list_workspace_files')).toBe(true)
    expect(WEBUI_SESSION_SCOPED_COMMANDS.has('list_workspace_files')).toBe(true)
  })

  test('未发布会话不能借文件引用命令枚举工作区', () => {
    expect(checkWebuiCommandAccess({ type: 'list_workspace_files', sessionId: 'session-c', publishedIds: published }).ok).toBe(false)
    expect(checkWebuiCommandAccess({ type: 'list_workspace_files', sessionId: null, publishedIds: published }).ok).toBe(false)
  })
})
