/**
 * GPT Image MCP Server（Agent 模式）
 *
 * 基于 OpenAI GPT Image API 的内置 MCP 服务器。
 * 通过 sdk.createSdkMcpServer() 创建，注入到每个 Agent 会话。
 * 支持文生图、参考图编辑。凭据复用 chat-tools.json 配置。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, resolve, isAbsolute, join } from 'node:path'
import { getToolState, getToolCredentials } from '../chat-tool-config'
import { saveAttachment, isImageAttachment } from '../attachment-service'

// ===== OpenAI GPT Image API 类型 =====

interface GptImageResponse {
  created?: number
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
  error?: { message: string; code: string; type: string }
}

/**
 * 从 GPT Image API 响应条目中提取图片 base64 数据
 */
async function resolveImageBase64(
  item: NonNullable<GptImageResponse['data']>[number],
): Promise<{ data: string; mimeType: string } | null> {
  if (item.b64_json) {
    // 去除可能的数据 URL 前缀（如 data:image/png;base64,）
    const raw = item.b64_json.replace(/^data:image\/\w+;base64,/, '')
    return { data: raw, mimeType: 'image/png' }
  }
  if (item.url) {
    try {
      const res = await fetch(item.url)
      if (!res.ok) {
        console.warn(`[GPT Image MCP] 下载图片失败 (${res.status}): ${item.url}`)
        return null
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const mimeType = res.headers.get('content-type') || 'image/png'
      return { data: buffer.toString('base64'), mimeType }
    } catch (err) {
      console.warn(`[GPT Image MCP] 下载图片异常: ${item.url}`, err)
      return null
    }
  }
  console.warn(`[GPT Image MCP] 响应条目无 b64_json 也无 url`)
  return null
}

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL = 'gpt-image-2'

// ===== MCP 内容块类型 =====

interface McpTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

type McpContent = McpTextContent | McpImageContent

interface McpToolResult {
  content: McpContent[]
  [key: string]: unknown
}

// ===== 已知图片扩展名 → MIME 类型映射 =====

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 从文件路径列表读取参考图
 *
 * 支持绝对路径和相对路径（相对于 cwd 解析）。
 * 跳过不存在、非图片、读取失败的文件。
 */
function readReferenceImages(paths: string[], cwd?: string): Array<{ data: string; media_type: string }> {
  const images: Array<{ data: string; media_type: string }> = []
  for (const rawPath of paths) {
    try {
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)

      if (!existsSync(filePath)) {
        console.warn(`[GPT Image MCP] 参考图不存在: ${filePath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[GPT Image MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      const data = readFileSync(filePath).toString('base64')
      images.push({ data, media_type: mimeType })
    } catch (error) {
      console.warn(`[GPT Image MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return images
}

/**
 * 调用 OpenAI GPT Image API 并返回 MCP 工具结果
 */
async function callGptImageAndBuildResult(
  prompt: string,
  sessionId: string,
  options: {
    size?: string
    quality?: string
    referenceImagePaths?: string[]
    cwd?: string
    numberOfImages?: number
  },
): Promise<McpToolResult> {
  const credentials = getToolCredentials('gpt-image')
  const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
  const model = credentials.model?.trim() || DEFAULT_MODEL

  // 读取参考图
  const referenceImages = options.referenceImagePaths?.length
    ? readReferenceImages(options.referenceImagePaths, options.cwd)
    : []
  if (referenceImages.length > 0) {
    console.log(`[GPT Image MCP] 加载了 ${referenceImages.length} 张参考图`)
  }

  // 构建请求体
  const requestBody: Record<string, unknown> = {
    model,
    prompt,
    n: options.numberOfImages ?? 1,
    response_format: 'b64_json',
  }

  if (options.size) {
    requestBody.size = options.size
  }

  if (options.quality) {
    requestBody.quality = options.quality
  }

  // 如果有参考图，使用第一张作为编辑基础
  if (referenceImages.length > 0) {
    requestBody.image = referenceImages[0]
  }

  const url = `${baseUrl}/v1/images/generations`

  console.log(`[GPT Image MCP] 调用 OpenAI API: model=${model}, prompt="${prompt.slice(0, 50)}..."`)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[GPT Image MCP] API 请求失败 (${response.status}):`, errorText)
    return {
      content: [{ type: 'text' as const, text: `GPT Image API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }],
    }
  }

  const data = (await response.json()) as GptImageResponse

  if (data.error) {
    return {
      content: [{ type: 'text' as const, text: `GPT Image API 错误: ${data.error.message}` }],
    }
  }

  if (!data.data || data.data.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '未生成任何图片' }],
    }
  }

  const mcpContent: McpContent[] = []
  const textParts: string[] = []
  const savedWorkspacePaths: string[] = []

  // 解析响应（兼容 b64_json 和 url 两种格式）
  for (const item of data.data) {
    const imageData = await resolveImageBase64(item)
    if (imageData) {
      const ext = imageData.mimeType === 'image/jpeg' ? '.jpg' : '.png'
      const filename = `gpt-image-${randomUUID().slice(0, 8)}${ext}`
      const result = saveAttachment({
        conversationId: sessionId,
        filename,
        mediaType: imageData.mimeType,
        data: imageData.data,
      })
      console.log(`[GPT Image MCP] 已保存图片: ${result.attachment.localPath} (${result.attachment.size} 字节)`)

      // 同时保存到 Agent 工作 session 目录（供 Agent 直接引用）
      if (options.cwd) {
        try {
          const imgDir = join(options.cwd, 'generated-images')
          mkdirSync(imgDir, { recursive: true })
          const workspacePath = join(imgDir, filename)
          writeFileSync(workspacePath, Buffer.from(imageData.data, 'base64'))
          savedWorkspacePaths.push(workspacePath)
        } catch (err) {
          console.warn(`[GPT Image MCP] 保存图片到工作目录失败:`, err)
        }
      }

      // MCP image content block（供 SDK/模型查看）
      mcpContent.push({
        type: 'image' as const,
        data: imageData.data,
        mimeType: imageData.mimeType,
      })

      // 嵌入附件标记（供前端 UI 解析渲染）
      const attachmentMeta = JSON.stringify({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
      textParts.push(`[PROMA_IMAGE_ATTACHMENT:${attachmentMeta}]`)
    }

    if (item.revised_prompt) {
      textParts.push(item.revised_prompt)
    }
  }

  // 在图片内容块之后追加文本摘要
  const imageCount = mcpContent.filter((c) => c.type === 'image').length
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  const summaryText = imageCount > 0
    ? `图片已生成（${imageCount} 张）${pathInfo}\n${textParts.join('\n')}`
    : textParts.join('\n') || '未生成图片内容'

  mcpContent.push({ type: 'text' as const, text: summaryText })

  return { content: mcpContent }
}

// ===== MCP Server 注入 =====

/**
 * 注入 GPT Image MCP Server 到 Agent 会话
 *
 * 参照 injectMemoryTools 模式，检查配置后创建 SDK MCP Server。
 */
export async function injectGptImageMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  sessionId: string,
  agentCwd?: string,
): Promise<void> {
  // 检查工具是否启用且有凭据
  const toolState = getToolState('gpt-image')
  const credentials = getToolCredentials('gpt-image')
  if (!toolState.enabled || !credentials.apiKey) return

  const { z } = await import('zod')

  const server = sdk.createSdkMcpServer({
    name: 'gpt-image',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'generate_image',
        'Generate or edit images using AI (OpenAI GPT Image). Supports text-to-image generation and reference image editing. Use detailed prompts for best results. When the user uploads images (listed in <attached_files>) or mentions image files via @file:{path}, pass their absolute file paths via referenceImagePaths to use them as reference for editing.\n\nIMPORTANT — Displaying images to the user:\nWhen the tool successfully generates an image, the result text will contain [PROMA_IMAGE_ATTACHMENT:{...}] markers. You MUST copy these markers verbatim into your final response so users can see the generated images. Example response:\n"Here is your image:\n[PROMA_IMAGE_ATTACHMENT:{"localPath":"xxx","filename":"image.png","mediaType":"image/png"}]\nI generated a scenic landscape..."',
        {
          prompt: z.string().describe('Detailed description of the image to generate or the edits to make.'),
          referenceImagePaths: z.array(z.string()).optional().describe('File paths of reference images for editing. Can be absolute paths or relative paths (resolved from cwd). Extract from <attached_files> entries or @file:{path} mentions when the user wants to edit uploaded/referenced images.'),
          size: z.enum(['1024x1024', '1536x1024', '1024x1536', '2048x2048', '3072x2048', '2048x3072', '4096x4096']).optional().describe('Image size (default 1024x1024)'),
          quality: z.enum(['auto', 'low', 'medium', 'high']).optional().describe('Image quality (default auto)'),
          numberOfImages: z.number().int().min(1).max(10).optional().describe('Number of images to generate (1-10, default 1)'),
        },
        async (args) => {
          try {
            return await callGptImageAndBuildResult(args.prompt, sessionId, {
              size: args.size,
              quality: args.quality,
              referenceImagePaths: args.referenceImagePaths,
              cwd: agentCwd,
              numberOfImages: args.numberOfImages,
            })
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error(`[GPT Image MCP] 执行失败:`, error)
            return { content: [{ type: 'text' as const, text: `图片生成失败: ${msg}` }] }
          }
        },
      ),
    ],
  })

  mcpServers['gpt-image'] = server as unknown as Record<string, unknown>
  console.log(`[GPT Image MCP] 已注入内置生图工具 (gpt-image)`)
}

/**
 * 清除 Agent 会话的生图历史（会话删除时调用）
 */
export function clearGptImageAgentHistory(sessionId: string): void {
  // GPT Image 不需要多轮对话历史管理，此函数保留用于接口一致性
  void sessionId
}
