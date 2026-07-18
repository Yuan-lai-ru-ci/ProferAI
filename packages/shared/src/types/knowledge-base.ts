/**
 * 论文知识库（Paper Knowledge Base）相关类型
 *
 * 论文知识库：上传/导入论文 → MinerU 解析 → 语义分块 → Embedding → 本地存储
 * 支持语义搜索 + Agent 工具调用。
 */

// ===== 论文元数据 =====

export interface PaperMeta {
  /** 论文唯一标识 */
  id: string
  /** 论文标题 */
  title: string
  /** 作者列表 */
  authors: string[]
  /** 摘要 */
  abstract: string
  /** DOI（如有） */
  doi?: string
  /** arXiv ID（如有，如 "2401.12345"） */
  arxivId?: string
  /** 发表年份 */
  year?: number
  /** 来源：local（本地 PDF 上传）或 arxiv（arXiv 导入） */
  source: 'local' | 'arxiv'
  /** PDF 页数 */
  pageCount: number
  /** 导入时间戳 */
  importedAt: number
  /** 用户标签 */
  tags: string[]
  /** 分块数量 */
  chunkCount: number
  /** 原始文件名 */
  originalFileName?: string
  /** Paperpipe 远端稳定 ID；仅用于远端 show/remove 与对账。 */
  remoteId?: string
  /** 本地与远端的同步状态。 */
  syncState?: 'pending' | 'synced' | 'failed' | 'local-only'
  /** 可安全展示的最近同步失败说明。 */
  syncError?: string
}

/** 删除论文后的本地/远端一致性结果。 */
export interface DeletePaperResult {
  paperId: string
  localDeleted: boolean
  remoteDeleted: boolean
  /** 论文未绑定远端 ID 时仅删除本地。 */
  remoteStatus: 'deleted' | 'not-found' | 'not-linked' | 'failed'
  message?: string
}

// ===== 内容分块 =====

export interface PaperChunk {
  /** 分块唯一标识 */
  id: string
  /** 所属论文 ID */
  paperId: string
  /** 分块文本内容 */
  content: string
  /** 所属节标题（如 "Introduction"、"Method"） */
  sectionTitle: string
  /** 在原文中的起始字符位置 */
  startIndex: number
  /** 在原文中的结束字符位置 */
  endIndex: number
  /** Embedding 向量（仅在内存中使用，不持久化到 JSON） */
  embedding?: number[]
}

// ===== 搜索结果 =====

export interface KBSearchResult {
  /** 匹配的分块 */
  chunk: PaperChunk
  /** 所属论文元数据 */
  paper: PaperMeta
  /** 相似度分数 (0-1) */
  score: number
}

// ===== 导入相关 =====

export type KBImportSource =
  | { type: 'file'; filePath: string }
  | { type: 'arxiv'; arxivId: string }

export interface KBImportResult {
  /** 导入后的论文元数据 */
  paper: PaperMeta
  /** 消耗的 MinerU 积分 */
  creditsUsed: number
  /** 生成的 chunk 数量 */
  chunkCount: number
}

// ===== arXiv 搜索 =====

export interface ArxivPaper {
  /** arXiv ID（如 "2401.12345"） */
  arxivId: string
  /** 论文标题 */
  title: string
  /** 作者列表 */
  authors: string[]
  /** 摘要 */
  abstract: string
  /** 发表年份 */
  year: number
  /** PDF 下载链接 */
  pdfUrl: string
  /** arXiv 页面链接 */
  arxivUrl: string
  /** 主要分类（如 "cs.AI"） */
  primaryCategory: string
  /** 提交时间 */
  publishedAt: string
}

// ===== 论文知识库状态 =====

export interface KBStats {
  /** 论文总数 */
  totalPapers: number
  /** 分块总数 */
  totalChunks: number
  /** 存储占用（字节） */
  storageBytes: number
}

// ===== 本地个人工作台状态 =====

/** 单篇论文的设备本地个人标注，不会同步到 paperpipe。 */
export interface PaperWorkbenchRecord {
  favorite: boolean
  tags: string[]
  note: string
  /** 阅读位置，范围为 0 到 1。 */
  readingProgress: number
  updatedAt: number
}

/** 论文知识库工作台的本地持久化状态。 */
export interface KnowledgeBaseWorkbenchState {
  version: 1
  records: Record<string, PaperWorkbenchRecord>
}

/** 更新单篇论文个人标注时允许提交的字段。 */
export interface KnowledgeBaseWorkbenchPatch {
  favorite?: boolean
  tags?: string[]
  note?: string
  readingProgress?: number
}

// ===== IPC 输入 =====

export interface KBImportInput {
  source: KBImportSource
}

export interface KBSearchInput {
  query: string
  topK?: number
}

// ===== IPC 通道常量 =====

export const KB_IPC_CHANNELS = {
  IMPORT: 'kb:import',
  SEARCH: 'kb:search',
  LIST_PAPERS: 'kb:list-papers',
  GET_PAPER: 'kb:get-paper',
  DELETE_PAPER: 'kb:delete-paper',
  GET_STATS: 'kb:stats',
  SEARCH_ARXIV: 'kb:search-arxiv',
  GET_WORKBENCH_STATE: 'kb:get-workbench-state',
  UPDATE_WORKBENCH_RECORD: 'kb:update-workbench-record',
  DELETE_WORKBENCH_RECORDS: 'kb:delete-workbench-records',
} as const
