/**
 * WS：附件上传 → 发送时拼装 <attached_files> 的端到端契约。
 *
 * 锁三件事：
 * 1. `save_agent_attachment` 落盘位置就是会话 cwd（Agent 的 Read 才能读到）；
 * 2. 客户端只回传文件名也能解析出绝对路径（路径由主进程决定，不从客户端收）；
 * 3. 越界/超大/空名在边界上被拒，且错误文案可读（WS 调用方没有 .catch）。
 *
 * 这里不真的发起一轮 run（那会拉起模型），只验证「上传 → 拼装」这一段契约。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-attach-ws-'))
process.env.PROFER_CONFIG_DIR = sandbox

const { handleRemoteCommand } = await import('./remote-service')
const { createAgentSession, getAgentSessionMeta, updateAgentSessionMeta } = await import('./agent-session-manager')
const { createAgentWorkspace, getAgentWorkspace } = await import('./agent-workspace-manager')
const { getAgentSessionWorkspacePath } = await import('./config-paths')
const { applyAttachmentsToMessage } = await import('./remote-send-attachments')

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

const call = (payload: Record<string, unknown>) => handleRemoteCommand(JSON.stringify(payload))

/** createAgentSession 不建工作区：附件只能落在会话 cwd，所以每条用例先铺一个。 */
function makeSession(title: string): string {
  const workspace = createAgentWorkspace(`${title} 工作区`)
  const meta = createAgentSession(title, 'ch-attach')
  updateAgentSessionMeta(meta.id, { workspaceId: workspace.id })
  return meta.id
}

function sessionDirOf(sessionId: string): string {
  const meta = getAgentSessionMeta(sessionId)!
  const workspace = getAgentWorkspace(meta.workspaceId!)!
  return getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

describe('附件上传', () => {
  test('Given 正常文件 When 上传 Then 落在会话 cwd，并回传服务端文件名', async () => {
    const sessionId = makeSession('附件上传')
    const result = await call({
      type: 'save_agent_attachment',
      sessionId,
      filename: '报表.txt',
      base64: Buffer.from('三月数据').toString('base64'),
    }) as { ok: boolean; data?: { filename: string; path: string; size: number } }

    expect(result.ok).toBe(true)
    expect(result.data?.filename).toBe('报表.txt')
    expect(result.data?.path).toBe(join(sessionDirOf(sessionId), '报表.txt'))
    expect(existsSync(result.data!.path)).toBe(true)
    expect(result.data?.size).toBe(Buffer.byteLength('三月数据'))
  })

  test('Given 同名文件二次上传 When 上传 Then 自动改名，旧文件不被覆盖', async () => {
    const sessionId = makeSession('附件重名')
    const payload = {
      type: 'save_agent_attachment',
      sessionId,
      filename: 'a.txt',
      base64: Buffer.from('v1').toString('base64'),
    }
    await call(payload)
    const second = await call(payload) as { ok: boolean; data?: { filename: string } }

    expect(second.data?.filename).toBe('a-1.txt')
    expect(existsSync(join(sessionDirOf(sessionId), 'a.txt'))).toBe(true)
    expect(existsSync(join(sessionDirOf(sessionId), 'a-1.txt'))).toBe(true)
  })

  test('Given 文件名带路径 When 上传 Then 被 basename 化，不会写到 cwd 之外', async () => {
    const sessionId = makeSession('附件穿越')
    const result = await call({
      type: 'save_agent_attachment',
      sessionId,
      filename: '../../../evil.txt',
      base64: Buffer.from('x').toString('base64'),
    }) as { ok: boolean; data?: { filename: string; path: string } }

    expect(result.data?.filename).toBe('evil.txt')
    expect(result.data?.path).toBe(join(sessionDirOf(sessionId), 'evil.txt'))
  })

  test('Given 超过 10 MB When 上传 Then 拒绝并给可读原因', async () => {
    const sessionId = makeSession('附件超大')
    const result = await call({
      type: 'save_agent_attachment',
      sessionId,
      filename: 'big.bin',
      base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
    })
    expect(result).toEqual({ ok: false, error: '附件不能超过 10 MB' })
  })

  test('Given 缺附件数据 When 上传 Then 立刻拒绝', async () => {
    const result = await call({ type: 'save_agent_attachment', sessionId: 'whatever' })
    expect(result).toEqual({ ok: false, error: '缺少有效附件数据' })
  })
})

describe('上传后拼装发送消息', () => {
  test('Given 已上传附件 When 拼装 Then 提示块里的路径与磁盘一致，正文保持原样', async () => {
    const sessionId = makeSession('附件拼装')
    const upload = await call({
      type: 'save_agent_attachment',
      sessionId,
      filename: 'notes.md',
      base64: Buffer.from('# 笔记').toString('base64'),
    }) as { data: { filename: string; path: string } }

    const result = applyAttachmentsToMessage({
      userMessage: '帮我总结一下',
      sessionDir: sessionDirOf(sessionId),
      attachments: [{ filename: upload.data.filename }],
    })

    expect(result.userMessage).toContain(`- notes.md: ${upload.data.path}`)
    expect(result.userMessage.endsWith('帮我总结一下')).toBe(true)
    expect(result.rawUserMessage).toBe('帮我总结一下')
    expect(existsSync(upload.data.path)).toBe(true)
  })

  test('Given 客户端伪造不存在的文件名 When 拼装 Then 退化成纯文本，不产生悬空路径', async () => {
    const sessionId = makeSession('附件缺失')
    const result = applyAttachmentsToMessage({
      userMessage: '看看这个',
      sessionDir: sessionDirOf(sessionId),
      attachments: [{ filename: 'never-uploaded.pdf' }],
    })
    expect(result.userMessage).toBe('看看这个')
    expect(result.userMessage).not.toContain('attached_files')
  })
})
