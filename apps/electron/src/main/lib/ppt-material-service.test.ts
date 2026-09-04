import { afterEach, describe, expect, mock, test } from 'bun:test'
import { downloadPptMaterial, searchPptMaterials } from './ppt-material-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function commonsResponse(license: string): Response {
  return jsonResponse({
    query: {
      pages: {
        '42': {
          pageid: 42,
          title: 'File:Example image.jpg',
          imageinfo: [{
            url: 'https://upload.wikimedia.org/example.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example_image.jpg',
            thumburl: 'https://upload.wikimedia.org/thumb.jpg',
            mime: 'image/jpeg', width: 1600, height: 900,
            extmetadata: {
              LicenseShortName: { value: license },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
              Artist: { value: 'Example author' },
            },
          }],
        },
      },
    },
  })
}

describe('ppt material service', () => {
  test('默认只返回公共领域或 CC0 素材', async () => {
    globalThis.fetch = mock(() => Promise.resolve(commonsResponse('CC BY 4.0'))) as unknown as typeof fetch
    const result = await searchPptMaterials({ query: 'architecture' })
    expect(result.items).toEqual([])
  })

  test('允许署名时返回 CC BY 素材及归属信息', async () => {
    globalThis.fetch = mock(() => Promise.resolve(commonsResponse('CC BY 4.0'))) as unknown as typeof fetch
    const result = await searchPptMaterials({ query: 'architecture', includeAttribution: true })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ licenseCode: 'CC BY 4.0', creator: 'Example author' })
  })

  test('拒绝下载不属于 Wikimedia 的地址', async () => {
    await expect(downloadPptMaterial({ material: {
      id: 'x', source: 'wikimedia', title: 'bad.jpg', thumbnailUrl: 'https://example.com/thumb.jpg',
      originalUrl: 'https://example.com/original.jpg', landingPageUrl: 'https://commons.wikimedia.org/wiki/File:Bad.jpg', licenseCode: 'CC0',
    } })).rejects.toThrow('受信任')
  })
})
