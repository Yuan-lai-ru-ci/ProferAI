/**
 * 个人资料库（Personal Knowledge Base）相关类型
 *
 * 通用个人资料库：导入本地文档（PDF/Word/Excel/PPT/Markdown 等）→ 本地解析 →
 * 语义分块 → 本地存储 → 支持资料引用与 Chat/Agent 上下文检索。
 */

// ===== 通用个人资料库 =====

/** 首期允许长期管理的资料类型。 */
export type KnowledgeItemKind = 'pdf' | 'word' | 'wps' | 'presentation' | 'spreadsheet' | 'markdown' | 'text'

/** 资料来源：本机文件或 arXiv 研究资料。 */
export type KnowledgeItemOrigin = 'local' | 'arxiv'

/** 仅研究资料使用的可选元数据，避免污染普通文档。 */
export interface ResearchMetadata {
  arxivId?: string
  doi?: string
  authors?: string[]
  abstract?: string
  year?: number
  categories?: string[]
}

/** 通用个人资料的稳定本地实体。正文和原始文件均由主进程受控保存。 */
export interface KnowledgeItem {
  id: string
  title: string
  kind: KnowledgeItemKind
  origin: KnowledgeItemOrigin
  originalFileName?: string
  mediaType?: string
  fileSize: number
  importedAt: number
  updatedAt: number
  tags: string[]
  research?: ResearchMetadata
  remoteId?: string
  syncState: 'synced' | 'failed' | 'local-only'
  syncError?: string
  lastSyncAttemptAt?: number
}

/** 会话中持久化的轻量资料引用；绝不能当作普通会话附件处理。 */
export interface KnowledgeReference {
  itemId: string
  title: string
  kind: KnowledgeItemKind
  origin: KnowledgeItemOrigin
  importedAt: number
}

export interface KnowledgeLibraryIndex {
  version: 1
  items: KnowledgeItem[]
}

export interface KnowledgeSearchResult {
  item: KnowledgeItem
  content: string
  startIndex: number
  endIndex: number
  score: number
}

export interface KnowledgeImportItemResult {
  filePath: string
  item?: KnowledgeItem
  error?: string
}

export interface KnowledgeImportBatchResult {
  results: KnowledgeImportItemResult[]
}

export interface KnowledgeLibrarySnapshot {
  items: KnowledgeItem[]
  totalItems: number
}

export const KNOWLEDGE_IPC_CHANNELS = {
  IMPORT_ITEMS: 'knowledge:import-items',
  LIST_ITEMS: 'knowledge:list-items',
  GET_ITEM: 'knowledge:get-item',
  DELETE_ITEM: 'knowledge:delete-item',
  SEARCH_ITEMS: 'knowledge:search-items',
  GET_LIBRARY_SNAPSHOT: 'knowledge:get-library-snapshot',
  /** 在文件管理器中显示本地资料的受控原始副本。 */
  SHOW_ITEM_IN_FOLDER: 'knowledge:show-item-in-folder',
} as const
