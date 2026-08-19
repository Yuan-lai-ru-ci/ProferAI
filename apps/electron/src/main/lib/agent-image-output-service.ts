import { randomUUID } from 'node:crypto'
import { mkdir, realpath, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

/** 单张 Agent 本地图片的最大字节数：20 MiB。 */
export const MAX_AGENT_IMAGE_OUTPUT_SIZE = 20 * 1024 * 1024

export interface AgentImageOutputContext {
  /** 当前 Agent 会话的可写工作目录。 */
  agentCwd: string
  /** 会话中用户明确授权的附加目录。 */
  allowedRoots: string[]
}

export interface AgentImageOutputResult {
  image: {
    /** renderer 可通过 readAttachment() 读取的、位于 ~/.profer 内的绝对副本路径。 */
    localPath: string
    absolutePath: string
    filename: string
    mediaType: AgentImageMediaType
  }
  /** 需由 Agent 原样置入最终回复的既有图片附件协议。 */
  marker: string
}

type AgentImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

interface DetectedImage {
  mediaType: AgentImageMediaType
  extension: '.png' | '.jpg' | '.gif' | '.webp'
}

function isWithinRoot(root: string, target: string, allowRootItself = false): boolean {
  const relation = relative(root, target)
  if (relation === '') return allowRootItself
  return !relation.startsWith('..') && !isAbsolute(relation)
}

async function realDirectory(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function detectImage(buffer: Buffer): DetectedImage | undefined {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { mediaType: 'image/png', extension: '.png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: 'image/jpeg', extension: '.jpg' }
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).equals(Buffer.from('GIF87a')) || buffer.subarray(0, 6).equals(Buffer.from('GIF89a')))) {
    return { mediaType: 'image/gif', extension: '.gif' }
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).equals(Buffer.from('RIFF'))
    && buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { mediaType: 'image/webp', extension: '.webp' }
  }
  return undefined
}

function displayFilename(path: string, fallbackExtension: string): string {
  const name = basename(path).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name || `image${fallbackExtension}`
}

/**
 * 将已授权目录内的既有图片复制到当前 Agent 会话目录，并构造可由现有 renderer 显示的 marker。
 *
 * 该服务是唯一的授权边界：工具层的 path 参数不能绕过 realpath、文件头及大小校验。
 */
export async function sendAgentLocalImage(
  input: { path: string; caption?: string },
  context: AgentImageOutputContext,
): Promise<AgentImageOutputResult> {
  const requestedPath = input.path.trim()
  if (!requestedPath) throw new Error('图片路径不能为空')
  if (!context.agentCwd.trim()) throw new Error('当前会话没有可写的 Agent 工作目录')

  const requestedCandidate = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(context.agentCwd, requestedPath)
  let source: string
  try {
    // Agent 通常在 cwd 中以相对路径引用产物；绝不可按 Electron 进程 cwd 解析。
    source = await realpath(resolve(requestedCandidate))
  } catch {
    throw new Error(`图片文件不存在或无法访问: ${requestedPath}`)
  }
  const sourceStats = await stat(source)
  if (!sourceStats.isFile()) throw new Error('图片路径必须指向普通文件')

  const agentCwd = await realDirectory(resolve(context.agentCwd))
  if (!agentCwd) throw new Error('当前会话工作目录不存在或不可访问')
  const roots = await Promise.all([
    agentCwd,
    ...context.allowedRoots.map((root) => realDirectory(resolve(root))),
  ])
  const authorizedRoots = roots.filter((root): root is string => !!root)
  if (!authorizedRoots.some((root) => isWithinRoot(root, source))) {
    throw new Error('图片路径不在当前会话或用户已授权目录内')
  }

  if (sourceStats.size > MAX_AGENT_IMAGE_OUTPUT_SIZE) {
    throw new Error('图片超过 20MB 大小限制，无法发送')
  }
  const data = await readFile(source)
  if (data.length > MAX_AGENT_IMAGE_OUTPUT_SIZE) {
    throw new Error('图片超过 20MB 大小限制，无法发送')
  }
  const detected = detectImage(data)
  if (!detected) throw new Error('不支持的图片格式；仅支持 PNG、JPEG、GIF 和 WebP')

  const outputDir = join(agentCwd, '.context', 'agent-output-images')
  await mkdir(outputDir, { recursive: true })
  const realOutputDir = await realpath(outputDir)
  if (!isWithinRoot(agentCwd, realOutputDir)) {
    throw new Error('图片输出目录不在当前会话工作目录内')
  }

  const absolutePath = join(realOutputDir, `${randomUUID()}${detected.extension}`)
  await writeFile(absolutePath, data, { flag: 'wx' })
  const filename = displayFilename(source, detected.extension)
  const image = {
    localPath: absolutePath,
    absolutePath,
    filename,
    mediaType: detected.mediaType,
  }

  return {
    image,
    marker: `[PROMA_IMAGE_ATTACHMENT:${JSON.stringify({ localPath: image.localPath, filename: image.filename, mediaType: image.mediaType })}]`,
  }
}
