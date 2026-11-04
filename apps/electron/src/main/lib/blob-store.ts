/**
 * 会话大载荷的 blob 存储 —— 内容寻址，按哈希分层落盘。
 *
 * 背景：会话以 JSONL 落盘，一行 = 一条记录，读任何一条都必须整行读入内存。
 * 真机出现过 24.4 MB 的单行（整页 HTML、PDF base64、内嵌截图）。既有的对策是
 * 把超限内容**截断丢弃**；用户已明确否掉这条路线（不愿为读取速度丢数据），
 * 改为**把载荷搬出 JSONL 行**——原文完整留在这里，行内只放片段与引用。
 *
 * 为什么是内容寻址：同一段载荷在一条消息里常出现两次（`message.content` 与顶层
 * `tool_use_result` 互为副本，实测这是巨型行的主因），按内容哈希存会让它们自动
 * 合并成一份——因此这条路不只是「不丢数据」，还比截断更省磁盘。
 *
 * 同时提供同步与异步两套最小原语：
 * - 写入路径是同步的（沿用既有 `appendFileSync` 风格，改动面最小）
 * - 存量迁移是异步的（全量约 7 秒，不能阻塞主进程事件循环）
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import { listProjectWorkspaceRoots } from './workspace-locator'
import { getSessionStorageLayout } from '@profer/session-store'

const BLOB_DIR_NAME = 'blobs'

/** 哈希前缀，便于将来换算法时区分 */
const HASH_PREFIX = 'sha256:'

export interface BlobRef {
  hash: string
  bytes: number
}

/** 全局 blob 根目录：<configDir>/blobs */
export function blobRootDir(): string {
  return join(getConfigDir(), BLOB_DIR_NAME)
}

/**
 * 会话应使用的 blob 根目录。
 *
 * project 会话写进项目 `.profer/blobs`，项目文件夹才是自包含的；
 * managed 继续写全局目录。布局未知时回退全局（迁移/启动早期）。
 */
export function blobRootDirForSession(sessionId?: string): string {
  if (!sessionId) return blobRootDir()
  const layout = getSessionStorageLayout(sessionId)
  if (layout?.kind === 'project' && layout.dataDir) {
    // <root>/.profer/sessions/<sid> → <root>/.profer/blobs
    return join(dirname(dirname(layout.dataDir)), BLOB_DIR_NAME)
  }
  return blobRootDir()
}

/** 读路径：全局 + 所有已绑定项目的 `.profer/blobs`（项目拷来后无需改写引用）。 */
function readableBlobRoots(): string[] {
  const roots = [blobRootDir()]
  try {
    for (const project of listProjectWorkspaceRoots()) {
      roots.push(join(project.rootPath, '.profer', BLOB_DIR_NAME))
    }
  } catch {
    // 工作区索引不可读时只读全局，不能让历史消息渲染失败。
  }
  return [...new Set(roots)]
}

/**
 * 哈希 → 落盘路径。
 * 用哈希前四位做两级分片（`ab/cd/<hex>`），避免单目录堆积上万文件。
 */
export function blobPathFor(hash: string, rootDir: string = blobRootDir()): string {
  const hex = hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : hash
  return join(rootDir, hex.slice(0, 2), hex.slice(2, 4), hex)
}

/**
 * 哈希算的是**字符串本身的值**，不是它 JSON 转义后的形式。
 * 这样同一段逻辑内容无论出现在哪、无论怎么转义，都命中同一个 blob。
 */
export function hashOfBlobContent(content: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(content, 'utf-8').digest('hex')}`
}

function tempPathFor(target: string): string {
  return `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 同步写入（写入路径用）。内容寻址 ⇒ 幂等：已存在则直接返回。 */
export function writeBlobSync(content: string, sessionId?: string): BlobRef {
  const hash = hashOfBlobContent(content)
  const target = blobPathFor(hash, blobRootDirForSession(sessionId))

  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = tempPathFor(target)
    writeFileSync(tmp, content, 'utf-8')
    // 只有完整写完之后才 rename ⇒ 中断不会留下半个 blob
    renameSync(tmp, target)
  }

  return { hash, bytes: Buffer.byteLength(content, 'utf-8') }
}

/** 异步写入（存量迁移用）。 */
export async function writeBlob(content: string, sessionId?: string): Promise<BlobRef> {
  const hash = hashOfBlobContent(content)
  const target = blobPathFor(hash, blobRootDirForSession(sessionId))

  try {
    await readFile(target)
  } catch {
    await mkdir(dirname(target), { recursive: true })
    const tmp = tempPathFor(target)
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, target)
  }

  return { hash, bytes: Buffer.byteLength(content, 'utf-8') }
}

/**
 * 读取并校验：内容重新哈希必须与请求的哈希一致。
 * 不一致按「读不到」处理——宁可降级显示片段，也不返回可能被损坏的内容。
 */
export function readBlobSync(hash: string): string | null {
  for (const root of readableBlobRoots()) {
    try {
      const content = readFileSync(blobPathFor(hash, root), 'utf-8')
      if (hashOfBlobContent(content) === hash) return content
    } catch {
      // 继续找下一个根
    }
  }
  return null
}

export async function readBlob(hash: string): Promise<string | null> {
  for (const root of readableBlobRoots()) {
    try {
      const content = await readFile(blobPathFor(hash, root), 'utf-8')
      if (hashOfBlobContent(content) === hash) return content
    } catch {
      // 继续找下一个根
    }
  }
  return null
}
