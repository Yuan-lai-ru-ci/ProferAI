/**
 * 远程发送时的附件拼装。
 *
 * 移动端上传附件只有两条命令：`upload_attachment`（临时目录）与
 * `save_agent_attachment`（写进会话 cwd，可被 Agent 的 Read 读到）。后者才是给 Agent 用的。
 *
 * 关键约束：**客户端只回传文件名，绝不让它回传绝对路径**。
 * 否则任何客户端（或中间人）都能把 `~/.ssh/id_rsa` 塞进 `<attached_files>`，
 * 让 Agent 主动去读一个本不该读的文件。这里是最后一道闸：
 * 文件名 basename 化 → join 会话 cwd → 必须真实存在，才写进提示块。
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildAttachedFilesBlock } from './bridge-attachment-utils'

/** 单条消息最多带几个附件：再多就不是「补充材料」而是灌数据了。 */
export const REMOTE_ATTACHMENT_LIMIT = 10

export interface RemoteAttachmentInput {
  filename: string
  label?: string
}

export interface ResolvedAttachment {
  label: string
  path: string
}

/**
 * 归一化客户端传来的附件描述。
 *
 * 只留 basename：`../x`、`a/b`、盘符路径全部退化成文件名，再由会话 cwd 兜住。
 */
export function normalizeRemoteAttachments(
  value: unknown,
  limit: number = REMOTE_ATTACHMENT_LIMIT,
): RemoteAttachmentInput[] {
  if (!Array.isArray(value)) return []
  const result: RemoteAttachmentInput[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const raw = typeof record.filename === 'string' ? record.filename : ''
    const filename = basename(raw.trim()).replace(/[\\/]/g, '_')
    if (!filename || filename === '.' || filename === '..') continue
    if (seen.has(filename)) continue
    seen.add(filename)
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim().slice(0, 80)
      : undefined
    result.push({ filename, ...(label ? { label } : {}) })
    if (result.length >= limit) break
  }
  return result
}

/** 把文件名解析成会话 cwd 里的真实路径；不存在的直接丢弃，不让 Agent 去读空气。 */
export function resolveSessionAttachments(
  sessionDir: string,
  attachments: readonly RemoteAttachmentInput[],
  exists: (path: string) => boolean = existsSync,
): ResolvedAttachment[] {
  const resolved: ResolvedAttachment[] = []
  for (const attachment of attachments) {
    const path = join(sessionDir, attachment.filename)
    if (!exists(path)) {
      console.warn(`[Remote] 附件不存在，已跳过: ${path}`)
      continue
    }
    resolved.push({ label: attachment.label ?? attachment.filename, path })
  }
  return resolved
}

/**
 * 把附件块拼到用户消息前。
 *
 * `rawUserMessage` 是剥掉附件块后的纯用户原文。**当前远程入口不再使用它**：
 * `send_message` 现在把带 `<attached_files>` 的整段消息一起落盘（见 remote-service 的
 * headlessInput 注释），否则刷新后桌面端与 WebUI 都看不出这一轮带了哪些文件。
 * 保留该字段是给「只想显示原文、不在乎持久化」的调用方用的（例如未来的临时预览），
 * 不要在 UI 层把它写回消息体，那会把附件记录抹掉。
 */
export function applyAttachmentsToMessage(input: {
  userMessage: string
  sessionDir: string
  attachments: unknown
  exists?: (path: string) => boolean
}): { userMessage: string; rawUserMessage?: string; attached: ResolvedAttachment[] } {
  const attachments = normalizeRemoteAttachments(input.attachments)
  if (attachments.length === 0) return { userMessage: input.userMessage, attached: [] }
  const resolved = resolveSessionAttachments(input.sessionDir, attachments, input.exists)
  if (resolved.length === 0) return { userMessage: input.userMessage, attached: [] }
  return {
    userMessage: `${buildAttachedFilesBlock(resolved)}${input.userMessage}`,
    rawUserMessage: input.userMessage,
    attached: resolved,
  }
}
