/**
 * 开放许可 PPT 素材。素材来自公开 API，许可信息只用于辅助筛选，
 * 不构成对版权、商标或肖像权的担保。
 */
export type PptMaterialSource = 'openverse' | 'wikimedia'

export interface PptMaterialSearchInput {
  query: string
  page?: number
  perPage?: number
  /** 默认仅返回公有领域；开启后加入 CC BY 且需要在使用时署名。 */
  includeAttribution?: boolean
}

export interface PptMaterialItem {
  id: string
  source: PptMaterialSource
  title: string
  thumbnailUrl: string
  originalUrl: string
  landingPageUrl: string
  licenseCode: string
  licenseUrl?: string
  creator?: string
  attribution?: string
  width?: number
  height?: number
  mediaType?: string
}

export interface PptMaterialSearchResult {
  items: PptMaterialItem[]
  page: number
  hasMore: boolean
}

export interface PptMaterialDownloadInput {
  material: PptMaterialItem
}

export interface PptMaterialDownloadResult {
  filename: string
  mediaType: string
  data: string
  size: number
  sourceUrl: string
  landingPageUrl: string
  licenseCode: string
  licenseUrl?: string
  creator?: string
  attribution?: string
}

export const PPT_MATERIAL_IPC_CHANNELS = {
  SEARCH: 'ppt-material:search',
  DOWNLOAD: 'ppt-material:download',
} as const
