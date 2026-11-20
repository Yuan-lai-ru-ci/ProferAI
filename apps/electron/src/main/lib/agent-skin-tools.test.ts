import { describe, expect, mock, test } from 'bun:test'
import type { PreviewImageSource } from './agent-skin-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 派生缩略图用的 nativeImage 替身：1536 宽（超过 1200 上限，会走 resize 分支）。 */
const DERIVED_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', isPackaged: false },
  nativeTheme: { shouldUseDarkColors: true },
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1536, height: 1024 }),
      resize: () => ({ toJPEG: () => DERIVED_JPEG }),
      toJPEG: () => DERIVED_JPEG,
    }),
  },
}))
mock.module('./skin-service', () => ({ getUserSkinDir: () => `${homedir()}/.profer-dev/skins` }))
const PREVIEW_CANDIDATES = ['preview.png', 'preview.jpg', 'preview.jpeg', 'preview.webp', 'preview.svg']
let stagedPackage: { manifest: string; css: string; wallpaper: Buffer; preview?: Buffer; previewName?: string } | undefined
mock.module('./skin-manager-service', () => ({ installSkinFromFolder: (folder: string) => {
  const previewName = PREVIEW_CANDIDATES.find((name) => existsSync(`${folder}/${name}`))
  stagedPackage = {
    manifest: readFileSync(`${folder}/manifest.json`, 'utf8'),
    css: readFileSync(`${folder}/skin.css`, 'utf8'),
    wallpaper: readFileSync(`${folder}/assets/wallpaper.png`),
    previewName,
    preview: previewName ? readFileSync(`${folder}/${previewName}`) : undefined,
  }
  return { ok: true, status: 'installed', skin: { id: 'test-skin', name: 'Test skin', tone: 'dark', contractVersion: 2, builtin: false } }
} }))
mock.module('./settings-service', () => ({ updateSettings: () => ({}) }))
mock.module('./titlebar-overlay', () => ({ updateWindowFrameAppearance: () => undefined }))
// 按路径分支模拟授权边界与超限场景：默认返小 PNG，'outside' 模拟越权，
// 'huge' 模拟超 2 MB 缩略图，'preview-big'/'wallpaper-big' 用于验证包体总预算。
mock.module('./agent-image-output-service', () => ({ readAuthorizedAgentImage: async (p: string) => {
  const requested = String(p)
  if (requested.includes('outside')) throw new Error('图片路径不在当前会话或用户已授权目录内')
  const size = requested.includes('huge') ? 3 * 1024 * 1024
    : requested.includes('preview-big') ? Math.round(1.9 * 1024 * 1024)
      : requested.includes('wallpaper-big') ? Math.round(3.5 * 1024 * 1024)
        : 0
  const data = size > 0 ? Buffer.alloc(size, 0x89) : Buffer.from([0x89, 0x50])
  return { absolutePath: '/safe/image.png', data, filename: 'image.png', mediaType: 'image/png' }
} }))

const { AGENT_SKIN_TOOL_NAME, injectAgentSkinMcpServer, derivePreviewImage } = await import('./agent-skin-tools')

describe('Agent Profer skin tool', () => {
  test('Given a workspace-backed Claude session When injecting skin tools Then create_skin is available with CSS and wallpaper inputs', async () => {
    const captured: Array<{ name: string; parameters: unknown }> = []
    const sdk = {
      tool: (name: string, _description: string, parameters: unknown, _handler: unknown) => {
        captured.push({ name, parameters })
        return { name, parameters }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}

    await injectAgentSkinMcpServer(sdk, servers, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })

    expect(Object.keys(servers)).toEqual(['agent-skin'])
    expect(captured).toHaveLength(1)
    expect(captured[0]!.name).toBe(AGENT_SKIN_TOOL_NAME)
    expect(JSON.stringify(captured[0]!.parameters)).toContain('skinCss')
    expect(JSON.stringify(captured[0]!.parameters)).toContain('wallpaperPath')
  })

  test('Given a generated wallpaper and complete CSS When create_skin runs Then it stages a valid package and installs it', async () => {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = nextHandler
        return { name: AGENT_SKIN_TOOL_NAME }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}

    await injectAgentSkinMcpServer(sdk, servers, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })
    const result = await handler!({
      id: 'test-skin',
      name: 'Test skin',
      tone: 'dark',
      skinCss: ':root { --background: #111; }\n.shell-bg { background-image: url("assets/wallpaper.png"); }',
      wallpaperPath: '.context/agent-output-images/generated.png',
      wallpaperFilename: 'wallpaper.png',
    }) as { details?: { applied?: boolean; wallpaper?: string; installedPath?: string; validated?: boolean } }

    // installedPath 必须确定性可见：此前模型拿不到安装位置，会在安装后用 find 一路扫到家目录。
    expect(result.details).toMatchObject({
      applied: true,
      wallpaper: 'assets/wallpaper.png',
      validated: true,
      installedPath: join('~', '.profer-dev', 'skins', 'test-skin'),
    })
    expect(stagedPackage?.css).toContain('assets/wallpaper.png')
    expect(JSON.parse(stagedPackage!.manifest)).toMatchObject({ id: 'test-skin', contractVersion: 2 })
    expect(stagedPackage!.wallpaper).toEqual(Buffer.from([0x89, 0x50]))
  })
})

describe('Agent 皮肤工具：Windows 保留设备名拦截', () => {
  async function loadHandler() {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = nextHandler
        return { name: AGENT_SKIN_TOOL_NAME }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    await injectAgentSkinMcpServer(sdk, {}, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })
    return handler!
  }

  const base = { name: 'Reserved skin', tone: 'dark', skinCss: ':root { --background: #111; }' }

  test.each(['con', 'nul', 'com1', 'lpt1'])('Given id %s When create_skin runs Then it is rejected before install', async (id) => {
    const handler = await loadHandler()
    const result = await handler({ ...base, id }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Windows 保留设备名')
  })

  test('Given a reserved wallpaper filename When create_skin runs Then it is rejected', async () => {
    const handler = await loadHandler()
    const result = await handler({
      ...base,
      id: 'safe-skin',
      wallpaperPath: '.context/agent-output-images/generated.png',
      wallpaperFilename: 'nul.png',
    }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Windows 保留设备名')
  })
})

describe('Agent 皮肤工具：缩略图（preview）支持', () => {
  async function loadHandler() {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = nextHandler
        return { name: AGENT_SKIN_TOOL_NAME }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    await injectAgentSkinMcpServer(sdk, {}, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })
    return handler!
  }

  const base = {
    id: 'preview-skin',
    name: 'Preview skin',
    tone: 'dark',
    skinCss: ':root { --background: #111; }\n.shell-bg { background-image: url("assets/wallpaper.png"); }',
    wallpaperPath: '.context/agent-output-images/generated.png',
    wallpaperFilename: 'wallpaper.png',
  }

  test('Given 未提供 previewPath 且派生不可用 When create_skin runs Then 安装仍成功，缩略图缺失不阻断', async () => {
    const handler = await loadHandler()
    const result = await handler({ ...base }) as { details?: { preview?: string; installedPath?: string } }
    // 单测环境没有真实 Electron，nativeImage 不可用 —— 此时必须静默降级，而不是让整个安装失败
    expect(result.details?.installedPath).toBe(join('~', '.profer-dev', 'skins', 'preview-skin'))
    expect(stagedPackage?.previewName).toBeUndefined()
  })

  test('Given 显式 previewPath When create_skin runs Then 扩展名取自真实媒体类型', async () => {
    const handler = await loadHandler()
    const result = await handler({ ...base, previewPath: '.context/agent-output-images/shot.png' }) as { details?: { preview?: string } }
    expect(result.details?.preview).toBe('preview.png')
    expect(stagedPackage?.previewName).toBe('preview.png')
    expect(stagedPackage!.preview).toEqual(Buffer.from([0x89, 0x50]))
  })

  test('Given previewScale 与 previewPosition When create_skin runs Then 写入 manifest 取景参数', async () => {
    const handler = await loadHandler()
    await handler({ ...base, previewScale: 1.25, previewPosition: '50% 30%' })
    expect(JSON.parse(stagedPackage!.manifest)).toMatchObject({ previewScale: 1.25, previewPosition: '50% 30%' })
  })

  test('Given previewPath 越出授权目录 When create_skin runs Then 返回结构化错误', async () => {
    const handler = await loadHandler()
    const result = await handler({ ...base, previewPath: '.context/outside/shot.png' }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('不在当前会话或用户已授权目录内')
  })

  test('Given 缩略图超过 2 MB When create_skin runs Then 工具侧给出明确提示', async () => {
    const handler = await loadHandler()
    const result = await handler({ ...base, previewPath: '.context/agent-output-images/huge.png' }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('皮肤缩略图不能超过 2 MB')
  })

  test('Given 壁纸与缩略图合计超过 5 MB When create_skin runs Then 工具侧拦截而非安装侧笼统报错', async () => {
    const handler = await loadHandler()
    const result = await handler({
      ...base,
      wallpaperPath: '.context/agent-output-images/wallpaper-big.png',
      previewPath: '.context/agent-output-images/preview-big.png',
    }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('5 MB')
  })
})

describe('缩略图派生（derivePreviewImage）', () => {
  function createSource(width: number, options: { bytes?: number; empty?: boolean; throwOnToJPEG?: boolean } = {}) {
    const resized: number[] = []
    const toJPEG = (): Buffer => {
      if (options.throwOnToJPEG) throw new Error('boom')
      return Buffer.alloc(options.bytes ?? 4, 0xff)
    }
    const source = {
      isEmpty: () => options.empty === true,
      getSize: () => ({ width, height: 800 }),
      resize: (opts: { width: number }) => {
        resized.push(opts.width)
        return {
          isEmpty: () => false,
          getSize: () => ({ width: opts.width, height: 800 }),
          resize: () => { throw new Error('unexpected nested resize') },
          toJPEG,
        }
      },
      toJPEG,
    }
    return { source: source as unknown as PreviewImageSource, resized }
  }

  test('Given 宽度超过 1200 When 派生 Then 先缩到 1200 再输出 preview.jpg', () => {
    const { source, resized } = createSource(1536)
    const derived = derivePreviewImage(source)
    expect(resized).toEqual([1200])
    expect(derived?.filename).toBe('preview.jpg')
    expect(derived!.data.length).toBe(4)
  })

  test('Given 宽度未超上限 When 派生 Then 不做缩放', () => {
    const { source, resized } = createSource(800)
    expect(derivePreviewImage(source)?.filename).toBe('preview.jpg')
    expect(resized).toEqual([])
  })

  test('Given 空图 When 派生 Then 返回 undefined', () => {
    const { source } = createSource(1536, { empty: true })
    expect(derivePreviewImage(source)).toBeUndefined()
  })

  test('Given 输出超过 2 MB When 派生 Then 放弃派生而不是写入超限文件', () => {
    const { source } = createSource(1536, { bytes: 3 * 1024 * 1024 })
    expect(derivePreviewImage(source)).toBeUndefined()
  })

  test('Given 图片源抛错 When 派生 Then 返回 undefined 而不向上抛', () => {
    const { source } = createSource(1536, { throwOnToJPEG: true })
    expect(derivePreviewImage(source)).toBeUndefined()
  })

  test('Given 没有图片源 When 派生 Then 返回 undefined', () => {
    expect(derivePreviewImage(undefined)).toBeUndefined()
  })
})
