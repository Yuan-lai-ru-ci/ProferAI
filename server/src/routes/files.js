import { Hono } from 'hono'
import { writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join as pathJoin, dirname as pathDirname, basename as pathBasename } from 'node:path'
import crypto from 'crypto'
import { db } from '../db.js'
import { logAudit } from '../audit.js'
import { MAX_FILE_SIZE, FILES_DIR } from '../config.js'
import { ensureDir, safePath } from '../utils.js'
import { authMiddleware } from '../middleware.js'
import { canModifyRows, normalizeFilePath, safeDecodeURI } from './file-route-utils.js'

export const fileRoutes = new Hono()

function getWorkspaceMember(wsId, userId) {
  return db.prepare(`
    SELECT wm.role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.workspace_id = ? AND wm.user_id = ? AND w.is_deleted = 0
  `).get(wsId, userId)
}

function requireWorkspaceMember(c, wsId) {
  const userId = c.get('userId')
  const member = getWorkspaceMember(wsId, userId)
  if (!member) return { error: c.json({ error: '无权访问工作区' }, 403) }
  c.set('memberRole', member.role)
  return { userId, role: member.role }
}

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin'
}

function emitFileChange(workspaceId, operation, payload) {
  db.prepare(
    'INSERT INTO sync_envelopes (id, workspace_id, entity_type, entity_id, operation, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    crypto.randomUUID(),
    workspaceId,
    'file',
    payload.path || payload.fromPath || workspaceId,
    operation,
    JSON.stringify(payload),
    Date.now(),
  )
}

/** 文件清单 */
fileRoutes.get('/:id/files/manifest', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const rows = db.prepare(
    'SELECT * FROM file_manifests WHERE workspace_id = ?'
  ).all(wsId)

  return c.json(rows.map((r) => ({
    name: r.file_name,
    path: r.file_path,
    isDirectory: r.is_directory !== 0,
    size: r.size,
    modifiedAt: r.modified_at,
    sha256: r.sha256,
    uploadedBy: r.uploaded_by || '',
    uploadedByName: r.uploaded_by_name || '',
  })))
})

/** 搜索文件（按文件名/路径，支持 * 和 ? 通配符） */
fileRoutes.get('/:id/files/search', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json({ files: [], total: 0 })

  // 转换通配符: * → %, ? → _。无通配符则子串匹配
  let likePattern
  if (q.includes('*') || q.includes('?')) {
    likePattern = q.replace(/\*/g, '%').replace(/\?/g, '_')
  } else {
    likePattern = `%${q}%`
  }

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const offset = (page - 1) * limit

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM file_manifests
    WHERE workspace_id = ? AND (file_name LIKE ? OR file_path LIKE ?) AND is_directory = 0
  `).get(wsId, likePattern, likePattern)
  const total = countRow.total

  const rows = db.prepare(`
    SELECT * FROM file_manifests
    WHERE workspace_id = ? AND (file_name LIKE ? OR file_path LIKE ?) AND is_directory = 0
    ORDER BY modified_at DESC
    LIMIT ? OFFSET ?
  `).all(wsId, likePattern, likePattern, limit, offset)

  return c.json({
    files: rows.map((r) => ({
      name: r.file_name,
      path: r.file_path,
      isDirectory: r.is_directory !== 0,
      size: r.size,
      modifiedAt: r.modified_at,
      sha256: r.sha256,
      uploadedBy: r.uploaded_by || '',
      uploadedByName: r.uploaded_by_name || '',
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  })
})

/** 创建文件夹 */
fileRoutes.post('/:id/files/mkdir', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const { path } = (await c.req.json()) || {}
  const dirPath = normalizeFilePath(path)
  if (!dirPath) return c.json({ error: '文件夹路径必填' }, 400)

  // 路径遍历防护
  const wsDir = pathJoin(FILES_DIR, wsId)
  ensureDir(wsDir)
  const localPath = safePath(wsDir, dirPath)
  if (!localPath) return c.json({ error: '文件夹路径不合法' }, 400)

  // 确保磁盘目录存在
  ensureDir(localPath)

  // 写入 file_manifest
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)
  const displayName = user?.display_name || userEmail
  const now = Date.now()

  db.prepare(
    'INSERT OR REPLACE INTO file_manifests (workspace_id, file_path, file_name, is_directory, size, modified_at, sha256, uploaded_by, uploaded_by_name) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?)'
  ).run(wsId, dirPath, dirPath.split('/').pop(), now, '', userId, displayName)

  // 确保所有父目录也在 manifest 中
  const parts = dirPath.split('/')
  let parentPath = ''
  for (let i = 0; i < parts.length - 1; i++) {
    parentPath = parentPath ? `${parentPath}/${parts[i]}` : parts[i]
    const exists = db.prepare(
      'SELECT 1 FROM file_manifests WHERE workspace_id = ? AND file_path = ?'
    ).get(wsId, parentPath)
    if (!exists && parentPath) {
      db.prepare(
        'INSERT OR IGNORE INTO file_manifests (workspace_id, file_path, file_name, is_directory, size, modified_at, sha256) VALUES (?, ?, ?, 1, 0, ?, ?)'
      ).run(wsId, parentPath, parentPath.split('/').pop(), now, '')
    }
  }

  emitFileChange(wsId, 'create', { path: dirPath, isDirectory: true })
  logAudit({ action: 'file.mkdir', workspaceId: wsId, userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'file', entityId: dirPath })

  return c.json({ success: true, path: dirPath })
})

/** 上传文件 */
fileRoutes.post('/:id/files/upload', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  // Content-Length 预检（可信客户端的快速拒绝，不可信客户端可能伪造）
  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10)
  if (contentLength > MAX_FILE_SIZE) {
    return c.json({ error: `文件过大，上限 ${Math.round(MAX_FILE_SIZE / 1048576)}MB` }, 413)
  }

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const rawPath = c.req.header('X-Filename') || 'unnamed'
  const decoded = safeDecodeURI(rawPath)
  if (!decoded) return c.json({ error: '文件名编码无效' }, 400)
  const filePath = normalizeFilePath(decoded)
  if (!filePath) return c.json({ error: '文件路径不合法' }, 400)

  // 分块流式读取，在超过限制时及早拒绝，防止内存耗尽（Content-Length 可能被伪造）
  const reader = c.req.raw.body?.getReader()
  if (!reader) {
    // 回退：非流式 body（如测试环境），使用 arrayBuffer
    const buffer = Buffer.from(await c.req.arrayBuffer())
    if (buffer.length === 0) return c.json({ error: '文件必填' }, 400)
    if (buffer.length > MAX_FILE_SIZE) {
      return c.json({ error: `文件过大，上限 ${Math.round(MAX_FILE_SIZE / 1048576)}MB` }, 413)
    }
    return writeUploadedFile(c, wsId, filePath, buffer)
  }

  // 流式读取
  const chunks = []
  let totalRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalRead += value.byteLength
        if (totalRead > MAX_FILE_SIZE) {
          reader.cancel().catch(() => {})
          return c.json({ error: `文件过大，上限 ${Math.round(MAX_FILE_SIZE / 1048576)}MB` }, 413)
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  if (totalRead === 0) return c.json({ error: '文件必填' }, 400)
  const buffer = Buffer.concat(chunks, totalRead)
  return writeUploadedFile(c, wsId, filePath, buffer)
})

/** 写入上传文件到磁盘和 manifest */
function writeUploadedFile(c, wsId, filePath, buffer) {
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  const memberRole = c.get('memberRole') || 'member'

  // 检查既有文件归属：非 owner/admin 不能覆盖他人上传的文件
  const existingFile = db.prepare(
    'SELECT uploaded_by FROM file_manifests WHERE workspace_id = ? AND file_path = ? AND is_directory = 0'
  ).get(wsId, filePath)
  if (existingFile && !isAdminOrOwner(memberRole) && existingFile.uploaded_by && existingFile.uploaded_by !== userId) {
    return c.json({ error: '无权覆盖该文件' }, 403)
  }

  const wsDir = pathJoin(FILES_DIR, wsId)
  ensureDir(wsDir)
  const localPath = safePath(wsDir, filePath)
  if (!localPath) return c.json({ error: '文件路径不合法' }, 400)

  ensureDir(pathDirname(localPath))
  writeFileSync(localPath, buffer)

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)
  const displayName = user?.display_name || userEmail
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')

  db.prepare(
    'INSERT OR REPLACE INTO file_manifests (workspace_id, file_path, file_name, size, modified_at, sha256, uploaded_by, uploaded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(wsId, filePath, filePath.split('/').pop(), buffer.length, Date.now(), hash, userId, displayName)

  // 自动创建所有父目录条目（确保 buildFileTree 能正确构建层级）
  const now = Date.now()
  const parts = filePath.split('/')
  let parentPath = ''
  for (let i = 0; i < parts.length - 1; i++) {
    parentPath = parentPath ? `${parentPath}/${parts[i]}` : parts[i]
    const exists = db.prepare(
      'SELECT 1 FROM file_manifests WHERE workspace_id = ? AND file_path = ?'
    ).get(wsId, parentPath)
    if (!exists && parentPath) {
      db.prepare(
        'INSERT OR IGNORE INTO file_manifests (workspace_id, file_path, file_name, is_directory, size, modified_at, sha256, uploaded_by, uploaded_by_name) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?)'
      ).run(wsId, parentPath, parentPath.split('/').pop(), now, '', userId, displayName)
    }
  }

  emitFileChange(wsId, 'update', { path: filePath, size: buffer.length, sha256: hash })
  logAudit({ action: 'file.upload', workspaceId: wsId, userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'file', entityId: filePath, detail: `${buffer.length} bytes` })

  return c.json({ success: true, path: filePath, size: buffer.length })
}

/** 下载文件 */
fileRoutes.get('/:id/files/download/:path{.+}', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const decoded = safeDecodeURI(c.req.param('path'))
  if (!decoded) return c.json({ error: '文件名编码无效' }, 400)
  const filePath = normalizeFilePath(decoded)
  if (!filePath) return c.json({ error: '文件路径不合法' }, 400)
  const localPath = safePath(FILES_DIR, wsId, filePath)

  if (!localPath || !existsSync(localPath)) return c.json({ error: '文件不存在' }, 404)

  const buffer = readFileSync(localPath)
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filePath.split('/').pop().replace(/["\r\n]/g, '_'))}`,
    },
  })
})

/** 移动文件或文件夹 */
fileRoutes.post('/:id/files/move', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const body = (await c.req.json()) || {}
  const fromPath = normalizeFilePath(body.fromPath)
  if (!fromPath) return c.json({ error: 'fromPath 必填' }, 400)

  // toDir 为空或 '/' 表示移动到根目录
  const targetDir = !body.toDir || body.toDir === '/' ? '' : normalizeFilePath(body.toDir)
  if (body.toDir && body.toDir !== '/' && targetDir === null) return c.json({ error: '目标目录路径不合法' }, 400)

  // 基础校验
  if (fromPath === targetDir) return c.json({ error: '不能移动到自身' }, 400)

  const baseName = pathBasename(fromPath)
  const newPath = targetDir ? `${targetDir}/${baseName}` : baseName

  if (fromPath === newPath) return c.json({ error: '目标位置与当前位置相同' }, 400)

  // 防止把目录移动到自己的子目录里
  if (newPath.startsWith(fromPath + '/')) return c.json({ error: '不能将文件夹移动到其自身内部' }, 400)

  // 路径遍历防护
  const wsDir = pathJoin(FILES_DIR, wsId)
  const oldLocal = safePath(wsDir, fromPath)
  const newLocal = safePath(wsDir, newPath)
  if (!oldLocal || !newLocal) return c.json({ error: '路径不合法' }, 400)

  // 源必须存在
  if (!existsSync(oldLocal)) return c.json({ error: '源文件不存在' }, 404)

  // 目标不能已存在同名文件
  if (existsSync(newLocal)) return c.json({ error: '目标位置已存在同名文件或文件夹' }, 409)

  // 更新 manifest：查找源文件及所有子孙（如果是目录）
  const affected = db.prepare(
    'SELECT file_path, is_directory, uploaded_by FROM file_manifests WHERE workspace_id = ? AND (file_path = ? OR file_path LIKE ?)'
  ).all(wsId, fromPath, fromPath + '/%')
  if (affected.length === 0) return c.json({ error: '文件不存在' }, 404)

  if (!isAdminOrOwner(access.role) && !canModifyRows(affected, access.userId)) {
    return c.json({ error: '无权移动' }, 403)
  }

  // 磁盘移动
  ensureDir(pathDirname(newLocal))
  renameSync(oldLocal, newLocal)

  const now = Date.now()

  const updateStmt = db.prepare(
    'UPDATE file_manifests SET file_path = ?, file_name = ?, modified_at = ? WHERE workspace_id = ? AND file_path = ?'
  )

  for (const row of affected) {
    const updatedPath = row.file_path === fromPath
      ? newPath
      : newPath + row.file_path.slice(fromPath.length)
    const updatedName = pathBasename(updatedPath)
    updateStmt.run(updatedPath, updatedName, now, wsId, row.file_path)
  }

  // 确保目标路径的父目录都在 manifest 中
  const parts = newPath.split('/')
  let parentPath = ''
  for (let i = 0; i < parts.length - 1; i++) {
    parentPath = parentPath ? `${parentPath}/${parts[i]}` : parts[i]
    const exists = db.prepare(
      'SELECT 1 FROM file_manifests WHERE workspace_id = ? AND file_path = ?'
    ).get(wsId, parentPath)
    if (!exists && parentPath) {
      db.prepare(
        'INSERT OR IGNORE INTO file_manifests (workspace_id, file_path, file_name, is_directory, size, modified_at, sha256) VALUES (?, ?, ?, 1, 0, ?, ?)'
      ).run(wsId, parentPath, parentPath.split('/').pop(), now, '')
    }
  }

  emitFileChange(wsId, 'update', { fromPath, path: newPath, affectedCount: affected.length })
  logAudit({ action: 'file.move', workspaceId: wsId, userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'file', entityId: fromPath, detail: `moved to ${newPath}, ${affected.length} entries` })

  return c.json({ success: true, fromPath, toPath: newPath, affectedCount: affected.length })
})

/** 删除文件或文件夹（递归） */
fileRoutes.delete('/:id/files/:path{.+}', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const access = requireWorkspaceMember(c, wsId)
  if (access.error) return access.error

  const decoded3 = safeDecodeURI(c.req.param('path'))
  if (!decoded3) return c.json({ error: '文件名编码无效' }, 400)
  const filePath = normalizeFilePath(decoded3)
  if (!filePath) return c.json({ error: '文件路径不合法' }, 400)

  // 查找所有子文件（通过路径前缀，兼容递归删除目录）
  const children = db.prepare(
    'SELECT file_path, is_directory, uploaded_by FROM file_manifests WHERE workspace_id = ? AND (file_path = ? OR file_path LIKE ?)'
  ).all(wsId, filePath, filePath + '/%')

  if (children.length === 0) return c.json({ error: '文件不存在' }, 404)

  if (!isAdminOrOwner(access.role) && !canModifyRows(children, access.userId)) {
    return c.json({ error: '无权删除' }, 403)
  }

  // 删除磁盘文件/目录
  const localPath = safePath(FILES_DIR, wsId, filePath)
  if (!localPath) return c.json({ error: '文件路径不合法' }, 400)
  if (existsSync(localPath)) rmSync(localPath, { recursive: true })

  // 删除所有 manifest 记录
  db.prepare(
    'DELETE FROM file_manifests WHERE workspace_id = ? AND (file_path = ? OR file_path LIKE ?)'
  ).run(wsId, filePath, filePath + '/%')

  emitFileChange(wsId, 'delete', { path: filePath, deletedCount: children.length })
  logAudit({ action: 'file.delete', workspaceId: wsId, userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'file', entityId: filePath, detail: `${children.length} entries deleted` })

  return c.json({ success: true, deletedCount: children.length })
})
