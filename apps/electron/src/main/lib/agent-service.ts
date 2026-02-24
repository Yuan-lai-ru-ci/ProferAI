/**
 * Agent 服务层（编排层）
 *
 * 负责 Agent 调用的流程编排：
 * - 获取渠道信息（API Key + Base URL）
 * - 注入环境变量（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）
 * - 构建查询选项（ClaudeAgentQueryOptions）
 * - 通过 AgentProviderAdapter 获取 AgentEvent 流
 * - 每个事件 → webContents.send() 推送给渲染进程
 * - 同时 appendAgentMessage() 持久化
 *
 * SDK 消息翻译逻辑已内聚到 ClaudeAgentAdapter 中，
 * 本层只关心流程编排，不关心底层 SDK 细节。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { cp, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { app } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type { AgentSendInput, AgentEvent, AgentMessage, AgentStreamEvent, AgentGenerateTitleInput, AgentSaveFilesInput, AgentSavedFile, AgentCopyFolderInput } from '@proma/shared'
import { ClaudeAgentAdapter, type ClaudeAgentQueryOptions } from './adapters/claude-agent-adapter'
import { decryptApiKey, getChannelById, listChannels } from './channel-manager'
import {
  getAdapter,
  fetchTitle,
} from '@proma/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendAgentMessage, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import { getWorkspaceMcpConfig, ensurePluginManifest } from './agent-workspace-manager'
import { buildSystemPromptAppend, buildDynamicContext } from './agent-prompt-builder'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { getWorkspacePermissionMode } from './agent-workspace-manager'
import { getMemoryConfig } from './memory-service'
import { searchMemory, addMemory, formatSearchResult } from './memos-client'
import type { PermissionRequest, PromaPermissionMode, AskUserRequest } from '@proma/shared'
import { SAFE_TOOLS } from '@proma/shared'

/** Adapter 单例 */
const adapter = new ClaudeAgentAdapter()

/** 活跃会话集合（并发守卫） */
const activeSessions = new Set<string>()


/**
 * 从 stderr 中提取 API 错误信息
 *
 * 解析类似这样的错误：
 * "401 {\"error\":{\"message\":\"...\"}}"
 * "API error: 400 Bad Request ..."
 */
function extractApiError(stderr: string): { statusCode: number; message: string } | null {
  if (!stderr) return null

  // 模式 1：JSON 错误格式 - "401 {...}"
  const jsonMatch = stderr.match(/(\d{3})\s+(\{[^}]*"error"[^}]*\})/s)
  if (jsonMatch) {
    try {
      const statusCode = parseInt(jsonMatch[1]!)
      const errorObj = JSON.parse(jsonMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败，继续尝试其他模式
    }
  }

  // 模式 2：API error 格式 - "API error (attempt X/Y): 401 401 {...}"
  const apiErrorMatch = stderr.match(/API error[^:]*:\s+(\d{3})\s+\d{3}\s+(\{.*?\})/s)
  if (apiErrorMatch) {
    try {
      const statusCode = parseInt(apiErrorMatch[1]!)
      const errorObj = JSON.parse(apiErrorMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败
    }
  }

  // 模式 3：直接的状态码 + 消息
  const simpleMatch = stderr.match(/(\d{3})[:\s]+(.+?)(?:\n|$)/i)
  if (simpleMatch) {
    const statusCode = parseInt(simpleMatch[1]!)
    const message = simpleMatch[2]!.trim()
    // 只有在状态码是有效的 HTTP 错误码时才返回
    if (statusCode >= 400 && statusCode < 600) {
      return { statusCode, message }
    }
  }

  return null
}

/**
 * 解析 SDK cli.js 路径
 *
 * SDK 作为 esbuild external 依赖，require.resolve 可在运行时解析实际路径。
 * 多种策略降级：createRequire → 全局 require → node_modules 手动查找
 *
 * 打包环境下：asar 内的路径需要转换为 asar.unpacked 路径，
 * 因为子进程 (bun) 无法读取 asar 归档内的文件。
 */
function resolveSDKCliPath(): string {
  let cliPath: string | null = null

  // 策略 1：createRequire（标准 ESM/CJS 互操作）
  try {
    const cjsRequire = createRequire(__filename)
    const sdkEntryPath = cjsRequire.resolve('@anthropic-ai/claude-agent-sdk')
    cliPath = join(dirname(sdkEntryPath), 'cli.js')
    console.log(`[Agent 服务] SDK CLI 路径 (createRequire): ${cliPath}`)
  } catch (e) {
    console.warn('[Agent 服务] createRequire 解析 SDK 路径失败:', e)
  }

  // 策略 2：全局 require（esbuild CJS bundle 可能保留）
  if (!cliPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk')
      cliPath = join(dirname(sdkEntryPath), 'cli.js')
      console.log(`[Agent 服务] SDK CLI 路径 (require.resolve): ${cliPath}`)
    } catch (e) {
      console.warn('[Agent 服务] require.resolve 解析 SDK 路径失败:', e)
    }
  }

  // 策略 3：从项目根目录手动查找
  if (!cliPath) {
    cliPath = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
    console.log(`[Agent 服务] SDK CLI 路径 (手动): ${cliPath}`)
  }

  // 打包环境：将 .asar/ 路径转换为 .asar.unpacked/
  // 子进程 (bun) 无法读取 asar 归档，asarUnpack 后文件在 .asar.unpacked/ 目录
  if (app.isPackaged && cliPath.includes('.asar')) {
    cliPath = cliPath.replace(/\.asar([/\\])/, '.asar.unpacked$1')
    console.log(`[Agent 服务] 转换为 asar.unpacked 路径: ${cliPath}`)
  }

  return cliPath
}

/**
 * 获取 Agent SDK 运行时可执行文件
 *
 * 优先级策略：
 * 1. Node.js（用户已安装，无需额外依赖）
 * 2. Bun（开发环境或打包版本可能包含）
 * 3. 降级到字符串 'node'（依赖系统 PATH）
 *
 * @returns { type: 'node' | 'bun', path: string }
 */
function getAgentExecutable(): { type: 'node' | 'bun'; path: string } {
  const status = getRuntimeStatus()

  // 优先使用 Node.js（用户已安装）
  if (status?.node?.available && status.node.path) {
    return { type: 'node', path: status.node.path }
  }

  // 降级到 Bun
  if (status?.bun?.available && status.bun.path) {
    return { type: 'bun', path: status.bun.path }
  }

  // 最后降级到字符串 'node'（依赖 PATH）
  return { type: 'node', path: 'node' }
}

/**
 * 确保打包环境下 ripgrep 可被 SDK CLI 找到
 *
 * 打包时 ripgrep 从 SDK vendor/ 排除（减少体积），仅当前平台的放在 extraResources。
 * SDK CLI 期望在 vendor/ripgrep/{arch}-{platform}/ 下找到 rg。
 * 通过 symlink 桥接 extraResources → SDK 的 vendor 目录。
 */
function ensureRipgrepAvailable(cliPath: string): void {
  if (!app.isPackaged) return

  try {
    const sdkDir = dirname(cliPath)
    const arch = process.arch   // 'arm64' | 'x64'
    const platform = process.platform // 'darwin' | 'linux' | 'win32'
    const expectedDir = join(sdkDir, 'vendor', 'ripgrep', `${arch}-${platform}`)
    const resourcesRipgrep = join(process.resourcesPath, 'vendor', 'ripgrep')

    // 已存在（symlink 或实际文件）则跳过
    if (existsSync(expectedDir)) return

    // extraResources 不存在则跳过（ripgrep 可能未打包）
    if (!existsSync(resourcesRipgrep)) {
      console.warn(`[Agent 服务] ripgrep 资源不存在: ${resourcesRipgrep}`)
      return
    }

    mkdirSync(join(sdkDir, 'vendor', 'ripgrep'), { recursive: true })
    symlinkSync(resourcesRipgrep, expectedDir, 'junction')
    console.log(`[Agent 服务] ripgrep symlink 创建成功: ${expectedDir} → ${resourcesRipgrep}`)
  } catch (error) {
    console.warn('[Agent 服务] ripgrep symlink 创建失败:', error)
  }
}

// convertSDKMessage 已迁移到 ClaudeAgentAdapter.translateMessage()

/** 最大回填消息条数 */
const MAX_CONTEXT_MESSAGES = 20

/**
 * 构建带历史上下文的 prompt
 *
 * 当 resume 不可用时（cwd 迁移等），将最近消息拼接为上下文注入 prompt，
 * 让新 SDK 会话保留对话记忆。仅取 user/assistant 角色的文本内容。
 */
function buildContextPrompt(sessionId: string, currentUserMessage: string): string {
  const allMessages = getAgentSessionMessages(sessionId)
  if (allMessages.length === 0) return currentUserMessage

  // 排除最后一条（刚刚追加的当前用户消息）
  const history = allMessages.slice(0, -1)
  if (history.length === 0) return currentUserMessage

  const recent = history.slice(-MAX_CONTEXT_MESSAGES)
  const lines = recent
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => `[${m.role}]: ${m.content}`)

  if (lines.length === 0) return currentUserMessage

  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n${currentUserMessage}`
}

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 直接透传 API 错误，不做重试。保持架构简单，让上游 API 提供商的错误消息直达用户。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  const { sessionId, userMessage, channelId, modelId, workspaceId } = input
  const stderrChunks: string[] = []

  // 0. 并发保护：检查是否已有正在运行的请求
  if (activeSessions.has(sessionId)) {
    console.warn(`[Agent 服务] 会话 ${sessionId} 正在处理中，拒绝新请求`)
    webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
      sessionId,
      error: '上一条消息仍在处理中，请稍候再试',
    })
    return
  }

  // 1. Windows 平台：检查 Shell 环境可用性
  if (process.platform === 'win32') {
    const runtimeStatus = getRuntimeStatus()
    const shellStatus = runtimeStatus?.shell

    if (shellStatus && !shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
      const errorMsg = `Windows 平台需要 Git Bash 或 WSL 环境才能运行 Agent。

当前状态：
- Git Bash: ${shellStatus.gitBash?.error || '未检测到'}
- WSL: ${shellStatus.wsl?.error || '未检测到'}

解决方案：
1. 安装 Git for Windows（推荐）: https://git-scm.com/download/win
2. 或启用 WSL: https://learn.microsoft.com/zh-cn/windows/wsl/install

安装完成后请重启应用。`

      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId,
        error: errorMsg,
      })
      return
    }
  }

  // 1. 获取渠道信息并解密 API Key
  const channel = getChannelById(channelId)
  if (!channel) {
    webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
      sessionId,
      error: '渠道不存在',
    })
    return
  }

  let apiKey: string
  try {
    apiKey = decryptApiKey(channelId)
  } catch {
    webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
      sessionId,
      error: '解密 API Key 失败',
    })
    return
  }

  // 2. 注入环境变量（参考 craft-agents-oss 的 reinitializeAuth 模式）
  // SDK 通过子进程继承 env，不支持直接传 apiKey option
  const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com'
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
  }
  // 自定义 Base URL 时注入 ANTHROPIC_BASE_URL
  // SDK 内部会自动拼接 /v1/messages，需要去除用户误填的路径后缀
  if (channel.baseUrl && channel.baseUrl !== DEFAULT_ANTHROPIC_URL) {
    sdkEnv.ANTHROPIC_BASE_URL = channel.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v\d+\/messages$/, '')
      .replace(/\/v\d+$/, '')
  } else {
    // 确保不会残留上一次的 Base URL
    delete sdkEnv.ANTHROPIC_BASE_URL
  }
  // 代理配置：SDK 通过子进程运行，注入 HTTPS_PROXY 环境变量
  const proxyUrl = await getEffectiveProxyUrl()
  if (proxyUrl) {
    sdkEnv.HTTPS_PROXY = proxyUrl
    sdkEnv.HTTP_PROXY = proxyUrl
  }

  // Windows 平台：配置 Shell 环境（Git Bash / WSL）
  if (process.platform === 'win32') {
    const runtimeStatus = getRuntimeStatus()
    const shellStatus = runtimeStatus?.shell

    if (shellStatus) {
      // 优先使用 Git Bash
      if (shellStatus.gitBash?.available && shellStatus.gitBash.path) {
        sdkEnv.CLAUDE_CODE_SHELL = shellStatus.gitBash.path
        console.log(`[Agent 服务] 配置 Shell 环境: Git Bash (${shellStatus.gitBash.path})`)
      }
      // 降级到 WSL
      else if (shellStatus.wsl?.available) {
        sdkEnv.CLAUDE_CODE_SHELL = 'wsl'
        console.log(
          `[Agent 服务] 配置 Shell 环境: WSL ${shellStatus.wsl.version} (${shellStatus.wsl.defaultDistro})`,
        )
      }
      // 无可用环境
      else {
        console.warn('[Agent 服务] Windows 平台未检测到可用的 Shell 环境（Git Bash / WSL）')
        console.warn('[Agent 服务] Agent 的 Bash 工具可能无法正常工作')
      }

      // 性能优化：跳过登录 shell，加速 Bash 执行
      sdkEnv.CLAUDE_BASH_NO_LOGIN = '1'
    }
  }

  // 2.5 读取已有的 SDK session ID（用于 resume 衔接上下文）
  const sessionMeta = getAgentSessionMeta(sessionId)
  let existingSdkSessionId = sessionMeta?.sdkSessionId
  console.log(`[Agent 服务] 会话元数据 resume 状态: sdkSessionId=${existingSdkSessionId || '无'}`)

  // 3. 持久化用户消息
  const userMsg: AgentMessage = {
    id: randomUUID(),
    role: 'user',
    content: userMessage,
    createdAt: Date.now(),
  }
  appendAgentMessage(sessionId, userMsg)

  // 4. 注册活跃会话（Adapter 内部管理 AbortController）
  activeSessions.add(sessionId)

  // 5. 状态初始化（工具索引等内部状态已迁移到 Adapter）
  let accumulatedText = ''
  const accumulatedEvents: AgentEvent[] = []
  let resolvedModel = modelId || 'claude-sonnet-4-5-20250929'
  // 运行环境信息（声明在 try 之前，供 catch 块使用）
  let agentExec: { type: 'node' | 'bun'; path: string } | undefined
  let agentCwd: string | undefined
  let workspaceSlug: string | undefined
  let workspace: import('@proma/shared').AgentWorkspace | undefined

  try {
    // 6. 动态导入 SDK（避免在 esbuild 打包时出问题）
    const sdk = await import('@anthropic-ai/claude-agent-sdk')

    // 7. 构建 SDK query（通过 env 注入认证信息）
    const cliPath = resolveSDKCliPath()
    agentExec = getAgentExecutable()

    // 路径验证
    if (!existsSync(cliPath)) {
      const errMsg = `SDK CLI 文件不存在: ${cliPath}`
      console.error(`[Agent 服务] ${errMsg}`)
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId, error: errMsg })
      return
    }

    // 确保 ripgrep 可用（打包环境下创建 symlink）
    ensureRipgrepAvailable(cliPath)

    console.log(
      `[Agent 服务] 启动 SDK — CLI: ${cliPath}, 运行时: ${agentExec.type} (${agentExec.path}), 模型: ${modelId || 'claude-sonnet-4-5-20250929'}, resume: ${existingSdkSessionId ?? '无'}`,
    )

    // 安全：阻止运行时自动加载用户项目中的 .env 文件
    // Bun: --env-file=/dev/null
    // Node.js: 默认不会加载 .env，无需特殊处理
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const executableArgs = agentExec.type === 'bun' ? [`--env-file=${nullDevice}`] : []

    // 确定 Agent 工作目录：优先使用 session 级别路径
    agentCwd = homedir()
    workspaceSlug = undefined
    workspace = undefined
    if (workspaceId) {
      const ws = getAgentWorkspace(workspaceId)
      if (ws) {
        agentCwd = getAgentSessionWorkspacePath(ws.slug, sessionId)
        workspaceSlug = ws.slug
        workspace = ws
        console.log(`[Agent 服务] 使用 session 级别 cwd: ${agentCwd} (${ws.name}/${sessionId})`)

        // 迁移兼容：确保已有工作区包含 SDK plugin manifest（否则 skills 不可发现）
        ensurePluginManifest(ws.slug, ws.name)

        // SDK session 状态保存在 ~/.claude/projects/，不在 cwd 目录中。
        // 如果有 sdkSessionId 则直接信任并 resume，失败时 SDK 会自动降级为新会话。
        if (existingSdkSessionId) {
          console.log(`[Agent 服务] 将尝试 resume: ${existingSdkSessionId}`)
        } else {
          console.log(`[Agent 服务] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
        }
      }
    }

    // 8. 构建工作区 MCP 服务器配置
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (workspaceSlug) {
      const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
      for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
        // 只加载已启用的服务器（用户已通过测试验证）
        if (!entry.enabled) continue

        // 跳过 memos-cloud：已迁移为 SDK 内置工具
        if (name === 'memos-cloud') continue

        if (entry.type === 'stdio' && entry.command) {
          // 合并系统 PATH 到 MCP 服务器环境，确保 npx/node 等工具可被找到
          const mergedEnv: Record<string, string> = {
            ...(process.env.PATH && { PATH: process.env.PATH }),
            ...entry.env,
          }
          mcpServers[name] = {
            type: 'stdio',
            command: entry.command,
            ...(entry.args && entry.args.length > 0 && { args: entry.args }),
            ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
            // 容错配置：单个服务器启动失败不影响整个 SDK
            required: false,
            startup_timeout_sec: 30,
          }
        } else if ((entry.type === 'http' || entry.type === 'sse') && entry.url) {
          mcpServers[name] = {
            type: entry.type,
            url: entry.url,
            ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
            // 容错配置
            required: false,
          }
        }
      }

      if (Object.keys(mcpServers).length > 0) {
        console.log(`[Agent 服务] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
      }
    }

    // 8.1 注入 SDK 内置记忆工具（全局，不依赖工作区）
    const memoryConfig = getMemoryConfig()
    const memUserId = memoryConfig.userId?.trim() || 'proma-user'
    if (memoryConfig.enabled && memoryConfig.apiKey) {
      try {
        const { z } = await import('zod')
        const memosServer = sdk.createSdkMcpServer({
          name: 'mem',
          version: '1.0.0',
          tools: [
            sdk.tool(
              'recall_memory',
              'Search user memories (facts and preferences) from MemOS Cloud. Use this to recall relevant context about the user.',
              { query: z.string().describe('Search query for memory retrieval'), limit: z.number().optional().describe('Max results (default 6)') },
              async (args) => {
                const result = await searchMemory(
                  { apiKey: memoryConfig.apiKey, userId: memUserId, baseUrl: memoryConfig.baseUrl },
                  args.query,
                  args.limit,
                )
                return { content: [{ type: 'text' as const, text: formatSearchResult(result) }] }
              },
              { annotations: { readOnlyHint: true } },
            ),
            sdk.tool(
              'add_memory',
              'Store a conversation message pair into MemOS Cloud for long-term memory. Call this after meaningful exchanges worth remembering.',
              {
                userMessage: z.string().describe('The user message to store'),
                assistantMessage: z.string().optional().describe('The assistant response to store'),
                conversationId: z.string().optional().describe('Conversation ID for grouping'),
                tags: z.array(z.string()).optional().describe('Tags for categorization'),
              },
              async (args) => {
                await addMemory(
                  { apiKey: memoryConfig.apiKey, userId: memUserId, baseUrl: memoryConfig.baseUrl },
                  args,
                )
                return { content: [{ type: 'text' as const, text: 'Memory stored successfully.' }] }
              },
            ),
          ],
        })
        mcpServers['mem'] = memosServer as unknown as Record<string, unknown>
        console.log(`[Agent 服务] 已注入内置记忆工具 (mem)`)
      } catch (err) {
        console.error(`[Agent 服务] 注入记忆工具失败:`, err)
      }
    }

    // 9. 构建动态上下文（日期时间 + 工作区实时状态 + 工作目录）
    const dynamicCtx = buildDynamicContext({
      workspaceName: workspace?.name,
      workspaceSlug,
      agentCwd,
    })
    const contextualMessage = `${dynamicCtx}\n\n${userMessage}`

    // 构建最终 prompt：/compact 命令直通 SDK
    const isCompactCommand = userMessage.trim() === '/compact'
    const finalPrompt = isCompactCommand
      ? '/compact'
      : existingSdkSessionId
        ? contextualMessage
        : buildContextPrompt(sessionId, contextualMessage)

    if (existingSdkSessionId) {
      console.log(`[Agent 服务] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
    } else if (finalPrompt !== contextualMessage) {
      console.log(`[Agent 服务] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
    }

    // 10. 获取权限模式并创建 canUseTool 回调
    const permissionMode: PromaPermissionMode = workspaceSlug
      ? getWorkspacePermissionMode(workspaceSlug)
      : 'smart'
    console.log(`[Agent 服务] 权限模式: ${permissionMode}`)

    const canUseTool = permissionMode !== 'auto'
      ? permissionService.createCanUseTool(
          sessionId,
          permissionMode,
          (request: PermissionRequest) => {
            // 发送权限请求到渲染进程
            webContents.send(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, {
              sessionId,
              request,
            })
            // 同时作为 AgentEvent 推送（用于消息流中显示）
            const event: AgentEvent = { type: 'permission_request', request }
            webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, event } as AgentStreamEvent)
          },
          // AskUserQuestion 交互式问答处理器
          (sid, input, signal, sendAskUser) => askUserService.handleAskUserQuestion(sid, input, signal, sendAskUser),
          // AskUser IPC 发送回调
          (request: AskUserRequest) => {
            webContents.send(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, {
              sessionId,
              request,
            })
            // 同时作为 AgentEvent 推送
            const event: AgentEvent = { type: 'ask_user_request', request }
            webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, event } as AgentStreamEvent)
          },
        )
      : undefined

    // 11. 构建 Adapter 查询选项
    const queryOptions: ClaudeAgentQueryOptions = {
      sessionId,
      prompt: finalPrompt,
      model: modelId || 'claude-sonnet-4-5-20250929',
      cwd: agentCwd,
      sdkCliPath: cliPath,
      executable: agentExec,
      executableArgs,
      env: sdkEnv,
      maxTurns: 30,
      sdkPermissionMode: permissionMode === 'auto' ? 'bypassPermissions' : 'default',
      allowDangerouslySkipPermissions: permissionMode === 'auto',
      ...(canUseTool && { canUseTool }),
      ...(permissionMode !== 'auto' && { allowedTools: [...SAFE_TOOLS] }),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemPromptAppend({
          workspaceName: workspace?.name,
          workspaceSlug,
          sessionId,
        }),
      },
      resumeSessionId: existingSdkSessionId,
      ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
      ...(workspaceSlug && { plugins: [{ type: 'local' as const, path: getAgentWorkspacePath(workspaceSlug) }] }),
      onStderr: (data: string) => {
        stderrChunks.push(data)
        console.error(`[Agent SDK stderr] ${data}`)
      },
      onSessionId: (sdkSessionId: string) => {
        if (sdkSessionId !== existingSdkSessionId) {
          try {
            updateAgentSessionMeta(sessionId, { sdkSessionId })
            console.log(`[Agent 服务] 已保存 SDK session_id: ${sdkSessionId}`)
          } catch {
            // 索引更新失败不影响主流程
          }
        }
      },
      onModelResolved: (model: string) => {
        resolvedModel = model
        console.log(`[Agent 服务] SDK 确认模型: ${resolvedModel}`)
      },
      onContextWindow: (cw: number) => {
        console.log(`[Agent 服务] 缓存 contextWindow: ${cw}`)
      },
    }

    console.log(`[Agent 服务] 开始通过 Adapter 遍历事件流...`)

    // 12. 遍历 Adapter 产出的 AgentEvent 流
    for await (const event of adapter.query(queryOptions)) {
      // 检查 typed_error 事件 - 立即保存错误消息并退出
      if (event.type === 'typed_error') {
        // 先保存已累积的 assistant 内容（如果有）
        if (accumulatedText || accumulatedEvents.length > 0) {
          const assistantMsg: AgentMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: accumulatedText,
            createdAt: Date.now(),
            model: resolvedModel,
            events: accumulatedEvents,
          }
          appendAgentMessage(sessionId, assistantMsg)
        }

        // 保存 TypedError 作为 status 消息
        const errorMsg: AgentMessage = {
          id: randomUUID(),
          role: 'status',
          content: event.error.title
            ? `${event.error.title}: ${event.error.message}`
            : event.error.message,
          createdAt: Date.now(),
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
          errorActions: event.error.actions,
        }
        appendAgentMessage(sessionId, errorMsg)
        console.log(`[Agent 服务] 已保存 TypedError 消息: ${event.error.code} - ${event.error.title}`)

        // 推送 typed_error 事件给渲染进程
        webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, event } as AgentStreamEvent)

        // 更新会话索引
        try {
          updateAgentSessionMeta(sessionId, {})
        } catch {
          // 索引更新失败不影响主流程
        }

        // 清理活跃会话（在发送 STREAM_COMPLETE 前）
        activeSessions.delete(sessionId)

        // 发送 STREAM_COMPLETE（携带已持久化的消息，避免渲染进程异步加载的竞态窗口）
        const finalMessages = getAgentSessionMessages(sessionId)
        webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId, messages: finalMessages })

        // 退出处理（错误后不应继续）
        return
      }

      // 累积文本
      if (event.type === 'text_delta') {
        accumulatedText += event.text
      }
      accumulatedEvents.push(event)

      // 推送给渲染进程
      const streamEvent: AgentStreamEvent = { sessionId, event }
      webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, streamEvent)
    }

    // 9. 持久化 assistant 消息（包含完整文本和工具事件）
    if (accumulatedText || accumulatedEvents.length > 0) {
      const assistantMsg: AgentMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: accumulatedText,
        createdAt: Date.now(),
        model: resolvedModel,
        events: accumulatedEvents,
      }
      appendAgentMessage(sessionId, assistantMsg)
    }

    // 更新会话索引
    try {
      updateAgentSessionMeta(sessionId, {})
    } catch {
      // 索引更新失败不影响主流程
    }

    // 清理活跃会话（在发送 STREAM_COMPLETE 前，确保后端准备好接受新请求）
    activeSessions.delete(sessionId)

    // 发送 STREAM_COMPLETE（携带已持久化的消息，避免渲染进程异步加载的竞态窗口）
    const finalMessages = getAgentSessionMessages(sessionId)
    webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId, messages: finalMessages })

    // 异步生成标题（不阻塞 stream complete 响应）
    // 使用 SDK 实际确认的模型，避免因默认模型与当前渠道不匹配导致标题生成失败。
    autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, webContents)
  } catch (error) {
    // 打印完整的 stderr 用于诊断
    const fullStderr = stderrChunks.join('').trim()
    if (fullStderr) {
      console.error(`[Agent 服务] 完整 stderr 输出 (${fullStderr.length} 字符):`)
      console.error(fullStderr)
    } else {
      console.error(`[Agent 服务] stderr 为空`)
    }

    // 用户主动中止（stopAgent 会先从 activeSessions 移除再调用 adapter.abort）
    if (!activeSessions.has(sessionId)) {
      console.log(`[Agent 服务] 会话 ${sessionId} 已被用户中止`)

      // 保存已累积的部分内容
      if (accumulatedText || accumulatedEvents.length > 0) {
        const partialMsg: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulatedText,
          createdAt: Date.now(),
          model: resolvedModel,
          events: accumulatedEvents,
        }
        appendAgentMessage(sessionId, partialMsg)
      }

      // 发送 STREAM_COMPLETE（携带已持久化的消息，避免渲染进程异步加载的竞态窗口）
      const abortFinalMessages = getAgentSessionMessages(sessionId)
      webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId, messages: abortFinalMessages })
      return
    }

    const errorMessage = error instanceof Error ? error.message : '未知错误'
    console.error(`[Agent 服务] 执行失败:`, error)

    // 保存已累积的部分内容（避免数据丢失）
    if (accumulatedText || accumulatedEvents.length > 0) {
      try {
        const partialMsg: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulatedText,
          createdAt: Date.now(),
          model: resolvedModel,
          events: accumulatedEvents,
        }
        appendAgentMessage(sessionId, partialMsg)
        console.log(`[Agent 服务] ✓ 已保存部分执行结果 (${accumulatedText.length} 字符, ${accumulatedEvents.length} 事件)`)
      } catch (saveError) {
        console.error('[Agent 服务] ✗ 保存部分内容失败:', saveError)
      }
    }

    // 从 stderr 提取 API 原始错误并直接展示
    const stderrOutput = stderrChunks.join('').trim()
    const apiError = extractApiError(stderrOutput)

    let userFacingError: string
    if (apiError) {
      // 直接展示 API 原始错误，不做任何转换
      userFacingError = `API 错误 (${apiError.statusCode}):\n${apiError.message}`
    } else {
      // 无法解析 API 错误，显示基本错误信息
      userFacingError = errorMessage
    }

    // 保存错误消息到 JSONL（重要：确保错误信息持久化）
    try {
      const errorMsg: AgentMessage = {
        id: randomUUID(),
        role: 'status',
        content: userFacingError,
        createdAt: Date.now(),
        errorCode: 'unknown_error',
        errorTitle: '执行错误',
        errorOriginal: error instanceof Error ? error.stack : String(error),
      }
      appendAgentMessage(sessionId, errorMsg)
      console.log(`[Agent 服务] ✓ 已保存错误消息到 JSONL`)
    } catch (saveError) {
      console.error('[Agent 服务] ✗ 保存错误消息失败:', saveError)
    }

    // 发送错误给 UI
    webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
      sessionId,
      error: userFacingError,
    })

    // 清理活跃会话（在发送 STREAM_COMPLETE 前）
    activeSessions.delete(sessionId)

    // 发送 STREAM_COMPLETE（携带已持久化的消息，确保前端知道流式已结束）
    const errorFinalMessages = getAgentSessionMessages(sessionId)
    webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId, messages: errorFinalMessages })

    // 根据错误类型决定是否保留 sdkSessionId
    // API 配置错误（400/401/403/404）保留，服务器错误（500+）清除
    const shouldClearSession = !apiError || apiError.statusCode >= 500

    if (existingSdkSessionId && shouldClearSession) {
      try {
        updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })
        console.log(`[Agent 服务] 已清除失效的 sdkSessionId`)
      } catch {
        // 清理失败不影响错误流
      }
    } else if (existingSdkSessionId && !shouldClearSession) {
      console.log(`[Agent 服务] 保留 sdkSessionId (API 错误 ${apiError?.statusCode})`)
    }

    throw error
  } finally {
    activeSessions.delete(sessionId)
    // 清理权限服务中的待处理请求
    permissionService.clearSessionPending(sessionId)
    // 清理 AskUser 服务中的待处理请求
    askUserService.clearSessionPending(sessionId)
  }
}

/** 标题生成 Prompt */
const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：'

/** 标题最大长度 */
const MAX_TITLE_LENGTH = 20

/** 默认会话标题（用于判断是否需要自动生成） */
const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/**
 * 生成 Agent 会话标题
 *
 * 使用 Provider 适配器系统，支持 Anthropic / OpenAI / Google 等所有渠道。
 * 任何错误返回 null，不影响主流程。
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const { userMessage, channelId, modelId } = input
  console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

  try {
    const channels = listChannels()
    const channel = channels.find((c) => c.id === channelId)
    if (!channel) {
      console.warn('[Agent 标题生成] 渠道不存在:', channelId)
      return null
    }

    const apiKey = decryptApiKey(channelId)
    const adapter = getAdapter(channel.provider)
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      prompt: TITLE_PROMPT + userMessage,
    })

    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)
    const title = await fetchTitle(request, adapter, fetchFn)
    if (!title) {
      console.warn('[Agent 标题生成] API 返回空标题')
      return null
    }

    const cleaned = title.trim().replace(/^["'""''「《]+|["'""''」》]+$/g, '').trim()
    const result = cleaned.slice(0, MAX_TITLE_LENGTH) || null

    console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
    return result
  } catch (error) {
    console.warn('[Agent 标题生成] 生成失败:', error)
    return null
  }
}

/**
 * Agent 流完成后自动生成标题
 *
 * 在主进程侧检测：如果会话标题仍为默认值，说明是首次对话完成，
 * 自动调用标题生成并推送 TITLE_UPDATED 事件给渲染进程。
 * 不受组件生命周期影响，解决用户切换页面后标题不生成的问题。
 */
async function autoGenerateTitle(
  sessionId: string,
  userMessage: string,
  channelId: string,
  modelId: string,
  webContents: WebContents,
): Promise<void> {
  try {
    const meta = getAgentSessionMeta(sessionId)
    if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

    const title = await generateAgentTitle({ userMessage, channelId, modelId })
    if (!title) return

    updateAgentSessionMeta(sessionId, { title })
    webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, { sessionId, title })
    console.log(`[Agent 服务] 自动标题生成完成: "${title}"`)
  } catch (error) {
    console.warn('[Agent 服务] 自动标题生成失败:', error)
  }
}

/**
 * 中止指定会话的 Agent 执行
 *
 * 先从 activeSessions 移除（供 runAgent catch 块检测用户中止），
 * 再调用 adapter.abort() 中止底层 SDK 进程。
 */
export function stopAgent(sessionId: string): void {
  activeSessions.delete(sessionId)
  adapter.abort(sessionId)
  console.log(`[Agent 服务] 已中止会话: ${sessionId}`)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  if (activeSessions.size === 0) return
  console.log(`[Agent 服务] 正在中止所有活跃会话 (${activeSessions.size} 个)...`)
  adapter.dispose()
  activeSessions.clear()
}

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入 session 的 cwd，供 Agent 通过 Read 工具读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    // 防止同名文件覆盖：若路径已存在或本批次已使用，则追加序号
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    // 确保父目录存在（支持 filename 包含子路径，如 "subdir/file.txt"）
    mkdirSync(dirname(targetPath), { recursive: true })
    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 复制文件夹到 Agent session 工作目录（异步版本）
 *
 * 使用异步 fs.cp 递归复制整个文件夹，返回所有复制的文件列表。
 */
export async function copyFolderToSession(input: AgentCopyFolderInput): Promise<AgentSavedFile[]> {
  const { sourcePath, workspaceSlug, sessionId } = input
  const sessionDir = getAgentSessionWorkspacePath(workspaceSlug, sessionId)

  // 获取源文件夹名称作为目标子目录
  const folderName = sourcePath.split('/').filter(Boolean).pop() || 'folder'
  const targetDir = join(sessionDir, folderName)

  // 异步递归复制
  await cp(sourcePath, targetDir, { recursive: true })
  console.log(`[Agent 服务] 文件夹已复制: ${sourcePath} → ${targetDir}`)

  // 异步遍历复制后的目录，收集所有文件路径
  const results: AgentSavedFile[] = []
  const collectFiles = async (dir: string, relativeTo: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        await collectFiles(fullPath, relativeTo)
      } else {
        const relPath = fullPath.slice(relativeTo.length + 1)
        results.push({ filename: relPath, targetPath: fullPath })
      }
    }
  }
  await collectFiles(targetDir, sessionDir)

  console.log(`[Agent 服务] 文件夹复制完成，共 ${results.length} 个文件`)
  return results
}
