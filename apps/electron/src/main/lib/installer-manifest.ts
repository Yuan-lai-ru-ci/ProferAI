/**
 * Installer Manifest 客户端
 *
 * 从 profer-api 的 /api/v1/installers/manifest 接口拉取第三方安装包清单，
 * 带 5 分钟缓存和内置 fallback——断网或接口不可用时至少能拿到官方上游 URL。
 */

import type { InstallerManifest, InstallerSource } from '@profer/shared'

const PROFER_API_BASE = 'https://api.profer.cn'
const MANIFEST_URL = `${PROFER_API_BASE}/api/v1/installers/manifest`
const CACHE_TTL_MS = 5 * 60 * 1000

interface ManifestCache {
  data: InstallerManifest
  timestamp: number
}

let cache: ManifestCache | null = null

/**
 * 内置 fallback manifest。
 *
 * 断网或 API 不可达时使用：没有 CDN 分发地址，直接让客户端走 fallbackUrl
 * （官方上游）。版本与 sha256 跟随分发源站当前版本（Git 2.54.0 / Node.js 22.22.2），
 * 断网时也能做完整性校验。
 */
export const BUILTIN_INSTALLER_FALLBACK: InstallerManifest = {
  installers: [
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'x64',
      version: '2.54.0',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/Git-2.54.0-64-bit.exe',
      sha256: '2b96e7854f0520f0f6b709c21041d9801b1be44d5e1a0d9fa621b2fbc40f1983',
      sizeBytes: 65175776,
      filename: 'Git-2.54.0-64-bit.exe',
    },
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'arm64',
      version: '2.54.0',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/Git-2.54.0-arm64.exe',
      sha256: '97bf63e5c65152c14b488e191c107aa1ccbeae2435690693241be4b2b5edd0d2',
      sizeBytes: 63430440,
      filename: 'Git-2.54.0-arm64.exe',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'x64',
      version: '22.22.2',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2-x64.msi',
      sha256: '57456aa33fcd6fb6a9418e09227de0b0ca604f7b2123566acc66b555cb2f42e5',
      sizeBytes: 31703040,
      filename: 'node-v22.22.2-x64.msi',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'arm64',
      version: '22.22.2',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2-arm64.msi',
      sha256: '1ec02aeb76d716ce15915bed10c0a4dcf9a6224e9a4f4d1645ddca4985a7bc06',
      sizeBytes: 27906048,
      filename: 'node-v22.22.2-arm64.msi',
    },
    {
      // macOS 的 pkg 是 universal 二进制，x64 与 arm64 指向同一份文件与同一个 sha256。
      id: 'nodejs',
      platform: 'darwin',
      arch: 'arm64',
      version: '22.22.2',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2.pkg',
      sha256: 'ff08ad19678de4ca2af34b58b73b272c555449c6f2d91487ca6fe0a697f9eabe',
      sizeBytes: 88420691,
      filename: 'node-v22.22.2.pkg',
    },
    {
      id: 'nodejs',
      platform: 'darwin',
      arch: 'x64',
      version: '22.22.2',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.22.2/node-v22.22.2.pkg',
      sha256: 'ff08ad19678de4ca2af34b58b73b272c555449c6f2d91487ca6fe0a697f9eabe',
      sizeBytes: 88420691,
      filename: 'node-v22.22.2.pkg',
    },
  ],
}

/**
 * 拉取安装包清单（优先远程，失败回退内置）
 */
export async function fetchInstallerManifest(force = false): Promise<InstallerManifest> {
  if (!force && cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  try {
    const response = await fetch(MANIFEST_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Profer-Desktop-App',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as InstallerManifest
    if (!data || !Array.isArray(data.installers)) {
      throw new Error('Manifest format invalid')
    }

    // 远程清单可能先只覆盖 Windows；补齐本地平台的官方 fallback，
    // 避免“接口请求成功但 macOS 没有可下载条目”把按钮变成不可用状态。
    const remoteKeys = new Set(data.installers.map((source) => `${source.id}:${source.platform}:${source.arch}`))
    const mergedData: InstallerManifest = {
      installers: [
        ...data.installers,
        ...BUILTIN_INSTALLER_FALLBACK.installers.filter((source) => !remoteKeys.has(`${source.id}:${source.platform}:${source.arch}`)),
      ],
    }
    cache = { data: mergedData, timestamp: Date.now() }
    console.log(`[Installer Manifest] 远程清单获取成功，共 ${data.installers.length} 项，补齐 ${mergedData.installers.length - data.installers.length} 项本地 fallback`)
    return mergedData
  } catch (error) {
    console.warn(
      `[Installer Manifest] 远程清单获取失败，降级到内置 fallback:`,
      error,
    )
    // 不缓存 fallback，下一次仍然先试远程
    return BUILTIN_INSTALLER_FALLBACK
  }
}

/**
 * 从清单中挑出匹配指定 (id, arch) 的条目
 */
export function findInstallerSource(
  manifest: InstallerManifest,
  id: string,
  arch: 'x64' | 'arm64',
  platform: InstallerSource['platform'] = process.platform as InstallerSource['platform'],
): InstallerSource | undefined {
  return manifest.installers.find((s) => s.id === id && s.platform === platform && s.arch === arch)
}
