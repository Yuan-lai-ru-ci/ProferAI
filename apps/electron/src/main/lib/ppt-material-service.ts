import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type {
  PptMaterialDownloadInput,
  PptMaterialDownloadResult,
  PptMaterialItem,
  PptMaterialSearchInput,
  PptMaterialSearchResult,
} from '@profer/shared'

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
const COMMONS_ORIGIN = 'https://commons.wikimedia.org'
const MAX_RESULTS = 24
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ALLOWED_LICENSES = new Set(['PDM', 'CC0', 'CC BY', 'CC BY 2.0', 'CC BY 3.0', 'CC BY 4.0'])

interface CommonsImageInfo {
  url?: string
  descriptionurl?: string
  thumburl?: string
  thumbwidth?: number
  thumbheight?: number
  width?: number
  height?: number
  mime?: string
  extmetadata?: Record<string, { value?: string }>
}

interface CommonsPage {
  pageid: number
  title: string
  imageinfo?: CommonsImageInfo[]
}

function textValue(metadata: CommonsImageInfo['extmetadata'], name: string): string | undefined {
  const value = metadata?.[name]?.value?.replace(/<[^>]*>/g, '').trim()
  return value || undefined
}

function normalizeLicense(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.toLowerCase().includes('public domain')) return 'PDM'
  if (/^CC0(?:\s|$)/i.test(normalized)) return 'CC0'
  const by = normalized.match(/^CC BY(?:\s+([0-9.]+))?/i)
  return by ? `CC BY${by[1] ? ` ${by[1]}` : ''}` : undefined
}

function isPermitted(license: string | undefined, includeAttribution: boolean): license is string {
  return !!license && (license === 'PDM' || license === 'CC0' || (includeAttribution && ALLOWED_LICENSES.has(license)))
}

function asCommonsItem(page: CommonsPage, info: CommonsImageInfo, includeAttribution: boolean): PptMaterialItem | undefined {
  const license = normalizeLicense(textValue(info.extmetadata, 'LicenseShortName'))
  if (!isPermitted(license, includeAttribution) || !info.url || !info.thumburl || !info.descriptionurl) return undefined
  if (info.mime && !ALLOWED_MIME_TYPES.has(info.mime)) return undefined

  return {
    id: String(page.pageid),
    source: 'wikimedia',
    title: page.title.replace(/^File:/, ''),
    thumbnailUrl: info.thumburl,
    originalUrl: info.url,
    landingPageUrl: info.descriptionurl,
    licenseCode: license,
    licenseUrl: textValue(info.extmetadata, 'LicenseUrl'),
    creator: textValue(info.extmetadata, 'Artist'),
    attribution: textValue(info.extmetadata, 'Credit'),
    width: info.width,
    height: info.height,
    mediaType: info.mime,
  }
}

function assertCommonsUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.hostname !== 'commons.wikimedia.org' && !url.hostname.endsWith('.wikimedia.org')) {
    throw new Error('素材地址不属于受信任的 Wikimedia 来源')
  }
  return url
}

async function fetchCommons(url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', headers: { 'Api-User-Agent': 'Profer/1.0 (https://profer.cn)' } })
      if (response.status !== 429 && response.status < 500) return response
      lastError = new Error(`Wikimedia 暂时不可用 (${response.status})`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
  }
  throw new Error(`Wikimedia 素材服务暂时不可用，请稍后重试：${lastError instanceof Error ? lastError.message : 'network error'}`)
}

export async function searchPptMaterials(input: PptMaterialSearchInput): Promise<PptMaterialSearchResult> {
  const query = input.query.trim()
  if (!query) throw new Error('请输入素材关键词')
  const page = Math.max(1, Math.trunc(input.page ?? 1))
  const perPage = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.perPage ?? 18)))
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: query,
    gsrnamespace: '6', gsrlimit: String(perPage),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '640',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit', origin: '*',
  })
  const response = await fetchCommons(`${COMMONS_API}?${params}`)
  if (!response.ok) throw new Error(`Wikimedia 素材搜索失败 (${response.status})`)
  const body = await response.json() as { query?: { pages?: Record<string, CommonsPage> }; continue?: unknown }
  const items = Object.values(body.query?.pages ?? {})
    .flatMap((page) => page.imageinfo?.map((info) => asCommonsItem(page, info, !!input.includeAttribution)) ?? [])
    .filter((item): item is PptMaterialItem => !!item)
  return { items, page, hasMore: Boolean(body.continue) }
}

function extensionFor(mediaType: string, url: URL): string {
  const byMime: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }
  return byMime[mediaType] ?? (extname(url.pathname) || '.img')
}

export async function downloadPptMaterial(input: PptMaterialDownloadInput): Promise<PptMaterialDownloadResult> {
  const material = input.material
  if (material.source !== 'wikimedia') throw new Error('当前仅支持下载 Wikimedia Commons 素材')
  const license = normalizeLicense(material.licenseCode)
  if (!license || !ALLOWED_LICENSES.has(license)) throw new Error('该素材许可不在允许范围内')
  const url = assertCommonsUrl(material.originalUrl)
  const response = await fetchCommons(url.toString())
  if (!response.ok) throw new Error(`素材下载失败 (${response.status})`)
  const headerMediaType = response.headers.get('content-type')?.split(';')[0]
  const mediaType = (headerMediaType?.toLowerCase() ?? material.mediaType ?? '').toLowerCase()
  if (!ALLOWED_MIME_TYPES.has(mediaType)) throw new Error(`不支持的图片格式: ${mediaType || 'unknown'}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_DOWNLOAD_BYTES) throw new Error('素材超过 20MB，已拒绝下载')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('素材超过 20MB，已拒绝下载')
  const hash = createHash('sha256').update(material.originalUrl).digest('hex').slice(0, 10)
  const filename = `${basename(material.title, extname(material.title)).slice(0, 64).replace(/[^a-zA-Z0-9_-]+/g, '-') || 'ppt-material'}-${hash}${extensionFor(mediaType, url)}`
  return { filename, mediaType, data: buffer.toString('base64'), size: buffer.length, sourceUrl: material.originalUrl, landingPageUrl: material.landingPageUrl, licenseCode: license, licenseUrl: material.licenseUrl, creator: material.creator, attribution: material.attribution }
}

export async function downloadPptMaterialToWorkspace(input: PptMaterialDownloadInput, workspaceDir: string): Promise<Omit<PptMaterialDownloadResult, 'data' | 'size'> & { localPath: string; size: number }> {
  const downloaded = await downloadPptMaterial(input)
  const dir = join(workspaceDir, '.context', 'ppt-materials')
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, downloaded.filename)
  writeFileSync(localPath, Buffer.from(downloaded.data, 'base64'))
  const { data: _data, ...result } = downloaded
  return { ...result, localPath }
}
