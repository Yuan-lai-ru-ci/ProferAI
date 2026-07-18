/**
 * 论文知识库核心服务（仅保留 fallback 功能）
 *
 * kb-paperpipe.ts 是主后端。本文件仅在 paperpipe 不可用时作为 getKBStats 的 fallback。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  getKnowledgeBaseIndexPath,
  getKnowledgeBaseDir,
} from './config-paths'
import type { PaperMeta, KBStats } from '@profer/shared'

// ===== 本地索引（与 kb-paperpipe.ts 共享存储格式） =====

function readIndex(): PaperMeta[] {
  const indexPath = getKnowledgeBaseIndexPath()
  if (!existsSync(indexPath)) return []
  try {
    const raw = readFileSync(indexPath, 'utf-8')
    return JSON.parse(raw) as PaperMeta[]
  } catch {
    return []
  }
}

/**
 * 获取论文知识库统计（纯本地，不依赖外部服务）
 */
export function getKBStats(): KBStats {
  const papers = readIndex()
  let totalChunks = 0
  let storageBytes = 0

  const kbDir = getKnowledgeBaseDir()
  try {
    const entries = readdirSync(kbDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const stat = statSync(join(kbDir, entry.name))
          storageBytes += stat.size
        } catch { /* skip */ }
      }
    }

    const papersDir = join(kbDir, 'papers')
    if (existsSync(papersDir)) {
      const paperDirs = readdirSync(papersDir, { withFileTypes: true })
      for (const dir of paperDirs) {
        if (!dir.isDirectory()) continue
        try {
          const files = readdirSync(join(papersDir, dir.name))
          for (const f of files) {
            try {
              const stat = statSync(join(papersDir, dir.name, f))
              storageBytes += stat.size
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  for (const p of papers) {
    totalChunks += p.chunkCount
  }

  return { totalPapers: papers.length, totalChunks, storageBytes }
}
