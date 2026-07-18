/**
 * 论文知识库个人工作台状态。
 *
 * 论文主数据由 paperpipe 管理；此处只持久化设备本地的收藏、标签、笔记和阅读位置。
 */

import { getKnowledgeBaseWorkbenchPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import type {
  KnowledgeBaseWorkbenchPatch,
  KnowledgeBaseWorkbenchState,
  PaperWorkbenchRecord,
} from '@profer/shared'

const EMPTY_RECORD: Omit<PaperWorkbenchRecord, 'updatedAt'> = {
  favorite: false,
  tags: [],
  note: '',
  readingProgress: 0,
}

const MAX_TAGS = 30
const MAX_TAG_LENGTH = 48
const MAX_NOTE_LENGTH = 50_000

let stateCache: KnowledgeBaseWorkbenchState | null = null

function defaultState(): KnowledgeBaseWorkbenchState {
  return { version: 1, records: {} }
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const normalized = tags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
    .filter(Boolean)
  return [...new Set(normalized)].slice(0, MAX_TAGS)
}

function normalizeRecord(value: unknown): PaperWorkbenchRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<PaperWorkbenchRecord>
  return {
    favorite: Boolean(record.favorite),
    tags: normalizeTags(record.tags),
    note: typeof record.note === 'string' ? record.note.slice(0, MAX_NOTE_LENGTH) : '',
    readingProgress: typeof record.readingProgress === 'number'
      ? Math.max(0, Math.min(1, record.readingProgress))
      : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
}

function normalizeState(value: unknown): KnowledgeBaseWorkbenchState {
  if (!value || typeof value !== 'object') return defaultState()
  const raw = value as Partial<KnowledgeBaseWorkbenchState>
  if (!raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) return defaultState()

  const records: Record<string, PaperWorkbenchRecord> = {}
  for (const [paperId, record] of Object.entries(raw.records)) {
    const normalized = normalizeRecord(record)
    if (normalized && paperId.trim()) records[paperId] = normalized
  }
  return { version: 1, records }
}

function persistState(): void {
  if (!stateCache) return
  writeJsonFileAtomic(getKnowledgeBaseWorkbenchPath(), stateCache)
}

export function getKnowledgeBaseWorkbenchState(): KnowledgeBaseWorkbenchState {
  if (!stateCache) {
    stateCache = normalizeState(readJsonFileSafe<KnowledgeBaseWorkbenchState>(getKnowledgeBaseWorkbenchPath()))
  }
  return stateCache
}

export function updateKnowledgeBaseWorkbenchRecord(
  paperId: string,
  patch: KnowledgeBaseWorkbenchPatch,
): PaperWorkbenchRecord {
  const normalizedPaperId = paperId.trim()
  if (!normalizedPaperId) throw new Error('论文标识不能为空')

  const state = getKnowledgeBaseWorkbenchState()
  const current = state.records[normalizedPaperId] || { ...EMPTY_RECORD, updatedAt: 0 }
  const next: PaperWorkbenchRecord = {
    favorite: typeof patch.favorite === 'boolean' ? patch.favorite : current.favorite,
    tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
    note: patch.note === undefined ? current.note : patch.note.slice(0, MAX_NOTE_LENGTH),
    readingProgress: patch.readingProgress === undefined
      ? current.readingProgress
      : Math.max(0, Math.min(1, patch.readingProgress)),
    updatedAt: Date.now(),
  }

  state.records[normalizedPaperId] = next
  persistState()
  return next
}

export function deleteKnowledgeBaseWorkbenchRecords(paperIds: string[]): void {
  const state = getKnowledgeBaseWorkbenchState()
  let changed = false
  for (const paperId of paperIds) {
    const normalizedPaperId = paperId.trim()
    if (normalizedPaperId && normalizedPaperId in state.records) {
      delete state.records[normalizedPaperId]
      changed = true
    }
  }
  if (changed) persistState()
}

/** 测试辅助函数。 */
export function clearKnowledgeBaseWorkbenchStateCache(): void {
  stateCache = null
}
