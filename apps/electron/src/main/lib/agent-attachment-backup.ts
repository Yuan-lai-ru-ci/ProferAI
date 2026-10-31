/**
 * 用户附件备份
 *
 * 用户上传/粘贴的附件会被写进 Agent 会话 cwd，供模型用 Read / inspect_preview 读取。
 * 代价是模型对这个目录有完整写权限：一次「顺手清理临时截图」的 `rm -f ... image.png`
 * 就把用户附件一起删掉了，历史消息里的缩略图从此永远转圈（现场会话 0ad480b7）。
 *
 * 这里在写入 cwd 的同时，用复制在 ~/.profer/agent-attachment-backups/{sessionId}/ 留一份独立备份。
 * 复制会占用额外磁盘，但能同时防止 Agent 删除或原地覆盖 cwd 文件；readAttachment 在原文件
 * 缺失时回退读取备份，因此「附件被删」不再等于「历史消息里永久裂图」。
 */

import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getAgentAttachmentBackupDir, getAgentAttachmentBackupsRoot, getConfigDir } from './config-paths'

/** Agent 会话 cwd 的形状：~/.profer/agent-workspaces/{slug}/{sessionId}/{filename} */
function sessionIdForSessionPath(absolutePath: string): string | undefined {
  if (!isAbsolute(absolutePath)) return undefined
  // 用不创建目录的纯路径拼接，避免读取路径时产生 mkdir 副作用。
  const workspacesRoot = join(getConfigDir(), 'agent-workspaces')
  const relation = relative(workspacesRoot, dirname(absolutePath))
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) return undefined
  const segments = relation.split(sep)
  // 只认「工作区 slug / 会话 ID」这一层；更深层不是附件落盘位置。
  return segments.length === 2 ? segments[1] : undefined
}

/**
 * 为会话 cwd 里的用户附件留一份备份。
 *
 * 备份失败只告警：不能因为备份问题阻断附件本身写入。
 *
 * @returns 备份文件路径；未备份时返回 undefined
 */
export function backupAgentAttachment(sessionId: string, sourcePath: string): string | undefined {
  try {
    if (!sessionId.trim() || !existsSync(sourcePath) || !statSync(sourcePath).isFile()) return undefined
    const target = join(getAgentAttachmentBackupDir(sessionId), basename(sourcePath))
    // 同名附件重复写入时刷新备份，保证备份与最新内容一致。
    if (existsSync(target)) rmSync(target, { force: true })
    // 复制成独立文件，避免 Agent 原地覆盖 cwd 文件时同步改写备份。
    copyFileSync(sourcePath, target)
    return target
  } catch (error) {
    console.warn('[附件备份] 备份用户附件失败:', sourcePath, error)
    return undefined
  }
}

/**
 * 原文件已被删除时，按会话目录形状找回同名备份。
 *
 * 仅对 `~/.profer/agent-workspaces/{slug}/{sessionId}/` 下的附件生效，
 * 其它路径返回 undefined，避免把普通文件的读取也重定向到备份目录。
 */
export function resolveAgentAttachmentBackup(absolutePath: string): string | undefined {
  const sessionId = sessionIdForSessionPath(absolutePath)
  if (!sessionId) return undefined
  const candidate = join(getAgentAttachmentBackupsRoot(), sessionId, basename(absolutePath))
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 读取成功后补建备份。
 *
 * 修复前落盘的旧附件没有备份，第一次被预览时自愈；已有备份时直接返回，
 * 不在每次读取时重建链接。
 */
export function ensureAgentAttachmentBackup(absolutePath: string): void {
  const sessionId = sessionIdForSessionPath(absolutePath)
  if (!sessionId) return
  if (existsSync(join(getAgentAttachmentBackupsRoot(), sessionId, basename(absolutePath)))) return
  backupAgentAttachment(sessionId, absolutePath)
}
