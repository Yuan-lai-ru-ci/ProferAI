/**
 * 网页端预设命令的作用域必须锚定到「已发布会话所属工作区」。
 *
 * 会话链接可以分享，但预设是工作区级配置（含 system prompt 片段）：
 * 客户端传来的 workspaceSlug 在网页通道不可信，否则拿到一个会话链接的人
 * 可以增删改任意工作区的预设，甚至读取其它工作区的提示词。
 *
 * 这些用例走真实的会话/工作区/预设存储（临时配置根），只把 electron 运行时替换掉。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const configRoot = mkdtempSync(join(tmpdir(), 'profer-webui-preset-scope-'))
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { handleRemoteCommand } = await import('./remote-service')
const { createAgentSession } = await import('./agent-session-manager')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createAgentPreset, listAgentPresets } = await import('./agent-preset-manager')
const { clearSettingsCache, updateSettings } = await import('./settings-service')

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

beforeEach(() => {
  clearSettingsCache()
  updateSettings({ webuiPublishedSessionIds: [] })
})

type RemoteContext = Parameters<typeof handleRemoteCommand>[2]

function webuiContext(): NonNullable<RemoteContext> {
  return { clientId: 'webui-test', role: 'webui' }
}

function pocketContext(): NonNullable<RemoteContext> {
  return { clientId: 'pocket-test', role: 'pocket' }
}

function send(context: RemoteContext, payload: Record<string, unknown>) {
  return handleRemoteCommand(JSON.stringify(payload), null, context)
}

/** 发布一个绑定到指定工作区的会话，并返回会话 id。 */
function publishSessionIn(workspaceId: string, title: string): string {
  const session = createAgentSession(title, 'ch-test', workspaceId)
  updateSettings({ webuiPublishedSessionIds: [session.id] })
  return session.id
}

const presetNames = (workspaceSlug: string): string[] =>
  listAgentPresets(workspaceSlug).map((preset) => preset.name)

describe('网页端预设命令的工作区作用域', () => {
  test('Given 网页已绑定已发布会话 When 创建预设携带别的工作区 Then 落在会话所属工作区', async () => {
    const workspaceA = createAgentWorkspace('预设作用域 A')
    const workspaceB = createAgentWorkspace('预设作用域 B')
    const sessionId = publishSessionIn(workspaceA.id, 'A 会话')
    const context = webuiContext()

    // 页面启动必定先声明会话；这一步同时建立命令层的 activeSessionId
    const detail = await send(context, { type: 'session_detail', sessionId })
    expect(detail.ok).toBe(true)

    const created = await send(context, {
      type: 'create_preset',
      workspaceSlug: workspaceB.slug,
      input: { name: '网页创建的岗位', description: '' },
    })
    expect(created.ok).toBe(true)

    expect(presetNames(workspaceA.slug)).toContain('网页创建的岗位')
    expect(presetNames(workspaceB.slug)).not.toContain('网页创建的岗位')
  })

  test('Given 网页没有会话上下文 When 创建预设 Then 拒绝，不回退到全局或客户端工作区', async () => {
    const workspace = createAgentWorkspace('无上下文工作区')
    const result = await send(webuiContext(), {
      type: 'create_preset',
      workspaceSlug: workspace.slug,
      input: { name: '不应创建', description: '' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('会话上下文')
    expect(presetNames(workspace.slug)).not.toContain('不应创建')
  })

  test('Given 会话未发布 When 网页尝试绑定它 Then session_detail 被拒，后续预设命令也无作用域', async () => {
    const workspace = createAgentWorkspace('未发布预设工作区')
    const session = createAgentSession('未发布会话', 'ch-test', workspace.id)
    const context = webuiContext()

    const detail = await send(context, { type: 'session_detail', sessionId: session.id })
    expect(detail.ok).toBe(false)

    const created = await send(context, {
      type: 'create_preset',
      workspaceSlug: workspace.slug,
      input: { name: '越权创建', description: '' },
    })
    expect(created.ok).toBe(false)
    expect(presetNames(workspace.slug)).not.toContain('越权创建')
  })

  test('Given 非会话级命令夹带未发布 sessionId When 再创建预设 Then 作用域不会被改到那个会话', async () => {
    const workspaceA = createAgentWorkspace('防投毒 A')
    const workspaceB = createAgentWorkspace('防投毒 B')
    const sessionA = publishSessionIn(workspaceA.id, '防投毒发布会话')
    const sessionB = createAgentSession('防投毒未发布会话', 'ch-test', workspaceB.id)
    const context = webuiContext()

    const detail = await send(context, { type: 'session_detail', sessionId: sessionA })
    expect(detail.ok).toBe(true)

    // list_presets 不是会话级命令：多带一个未发布 sessionId 不能把 activeSessionId 改成 B
    const listed = await send(context, {
      type: 'list_presets',
      sessionId: sessionB.id,
      workspaceSlug: workspaceB.slug,
    })
    expect(listed.ok).toBe(true)

    const created = await send(context, {
      type: 'create_preset',
      workspaceSlug: workspaceB.slug,
      input: { name: '投毒后创建', description: '' },
    })
    expect(created.ok).toBe(true)
    expect(presetNames(workspaceA.slug)).toContain('投毒后创建')
    expect(presetNames(workspaceB.slug)).not.toContain('投毒后创建')
  })

  test('Given 两个工作区各有自定义预设 When 网页列预设携带另一个工作区 Then 只返回会话所属工作区', async () => {
    const workspaceA = createAgentWorkspace('列表隔离 A')
    const workspaceB = createAgentWorkspace('列表隔离 B')
    createAgentPreset(workspaceA.slug, { name: 'A 专属岗位', description: 'A' })
    createAgentPreset(workspaceB.slug, { name: 'B 专属岗位', description: 'B' })
    const sessionId = publishSessionIn(workspaceA.id, '列表隔离会话')
    const context = webuiContext()

    expect((await send(context, { type: 'session_detail', sessionId })).ok).toBe(true)

    const result = await send(context, { type: 'list_presets', workspaceSlug: workspaceB.slug })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const names = (result.data as { name: string }[]).map((preset) => preset.name)
    expect(names).toContain('A 专属岗位')
    expect(names).not.toContain('B 专属岗位')
  })

  test('Given Pocket 连接 When 创建预设携带工作区 Then 仍按客户端指定工作区（不受网页收口影响）', async () => {
    const workspace = createAgentWorkspace('Pocket 预设工作区')
    const result = await send(pocketContext(), {
      type: 'create_preset',
      workspaceSlug: workspace.slug,
      input: { name: 'Pocket 岗位', description: '' },
    })

    expect(result.ok).toBe(true)
    expect(presetNames(workspace.slug)).toContain('Pocket 岗位')
  })
})
