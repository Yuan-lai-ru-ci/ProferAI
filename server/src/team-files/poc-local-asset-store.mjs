/**
 * 团队资料库生命周期 PoC 的最小本地字节存储。
 *
 * 仅用于验证「同一文件系统内移动到回收站 / 恢复冲突副本 / 幂等清理」语义，
 * 尚未接入 HTTP 路由、真实数据库或生产文件目录。
 */
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, extname, join, parse, posix } from 'node:path'

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 为恢复冲突生成确定性的“已恢复”副本名，绝不覆盖活跃资料。 */
export async function resolveRestoredPath(activeRoot, originalPath) {
  const normalized = originalPath.replace(/\\/g, '/')
  const extension = extname(normalized)
  const { dir, name } = posix.parse(normalized)
  const suffixBase = `${name}（已恢复）`

  for (let index = 0; index < 10_000; index++) {
    const suffix = index === 0 ? '' : ` ${index + 1}`
    const candidateName = `${suffixBase}${suffix}${extension}`
    const candidate = dir ? posix.join(dir, candidateName) : candidateName
    if (!await exists(join(activeRoot, candidate))) return candidate
  }
  throw new Error('无法分配恢复副本路径')
}

export async function moveToTrash({ activeRoot, trashRoot, sourcePath, trashEntryId }) {
  const source = join(activeRoot, sourcePath)
  const trashPath = join(trashRoot, trashEntryId, sourcePath)
  if (!await exists(source)) {
    if (await exists(trashPath)) return { state: 'already_trashed', trashPath }
    throw new Error('源文件不存在，且未找到已有回收站副本')
  }
  await mkdir(dirname(trashPath), { recursive: true })
  await rename(source, trashPath)
  return { state: 'trashed', trashPath }
}

export async function restoreFromTrash({ activeRoot, trashRoot, originalPath, trashEntryId }) {
  const trashPath = join(trashRoot, trashEntryId, originalPath)
  if (!await exists(trashPath)) {
    return { state: 'already_restored_or_purged', restoredPath: null }
  }
  const restoredPath = await resolveRestoredPath(activeRoot, originalPath)
  const target = join(activeRoot, restoredPath)
  await mkdir(dirname(target), { recursive: true })
  await rename(trashPath, target)
  return { state: restoredPath === originalPath ? 'restored' : 'restored_as_copy', restoredPath }
}

/** 物理对象不存在也视为清理成功，便于崩溃后重复执行。 */
export async function purgeTrashEntry({ trashRoot, trashEntryId }) {
  const entryRoot = join(trashRoot, trashEntryId)
  await rm(entryRoot, { recursive: true, force: true })
  return { state: 'purged' }
}
