import { getAdapter, resolveTitleBaseUrl, fetchTitleWithRetry } from '@profer/core'
import type { AgentGenerateTitleInput, AgentSessionMeta, SDKMessage } from '@profer/shared'
import { strip1MContextSuffix } from '@profer/shared'
import { runSessionTitleNaming, collectSessionTitleSources } from '@profer/agent-runtime/session-title-naming'
import { buildTitlePrompt, buildWindowTitlePrompt, sanitizeGeneratedTitle } from '@profer/agent-runtime/session-title-policy'
import type { CoreChannelConfig } from './config'
import type { CodexOAuthCredentials } from '@profer/shared'
import { generateCodexTitle } from './session-title-codex'

export interface CoreSessionTitlePorts {
  getChannel(id: string): CoreChannelConfig | undefined
  getMeta(id: string): AgentSessionMeta | undefined
  updateMeta(id: string, patch: Partial<AgentSessionMeta>): void
  readMessages(id: string): SDKMessage[]
  onTitleUpdated(sessionId: string, title: string): void
  /** OAuth 必须使用所属 Core 的凭据与 provider 传输，禁止回落桌面账号。 */
  generateOAuthTitle?(channel: CoreChannelConfig, modelId: string, prompt: string): Promise<string | null>
  onCodexCredentialsRefreshed?(channelId: string, credentials: CodexOAuthCredentials): void | Promise<void>
  fetch?: typeof fetch
}

/** Core 标题旁路不创建 Agent run、不写 provider 会话，也不执行工具。 */
export class CoreSessionTitleService {
  private readonly naming = new Set<string>()
  constructor(private readonly ports: CoreSessionTitlePorts) {}

  async generate(input: AgentGenerateTitleInput): Promise<string | null> {
    const channel = this.ports.getChannel(input.channelId)
    if (!channel || channel.enabled === false) return null
    const modelId = strip1MContextSuffix(input.modelId)
    const prompt = input.contextMessages?.length ? buildWindowTitlePrompt(input.contextMessages) : buildTitlePrompt(input.userMessage)
    try {
      if (channel.provider === 'openai-codex' || channel.credentialMode === 'oauth') {
        if (this.ports.generateOAuthTitle) return sanitizeGeneratedTitle(await this.ports.generateOAuthTitle(channel, modelId, prompt))
        const raw = channel.codexOAuthCredentials
        if (channel.provider !== 'openai-codex' || !raw || !this.ports.onCodexCredentialsRefreshed
          || typeof raw.access !== 'string' || typeof raw.refresh !== 'string'
          || typeof raw.expires !== 'number') throw new Error('所属 Core 的 OAuth 标题凭据或刷新持久化端口未装配')
        return sanitizeGeneratedTitle(await generateCodexTitle({ modelId, prompt,
          credentials: raw as unknown as CodexOAuthCredentials,
          onCredentialsRefreshed: credentials => this.ports.onCodexCredentialsRefreshed!(channel.id, credentials) }))
      }
      const adapter = getAdapter(channel.provider, channel.apiProtocol, channel.baseUrl)
      const request = adapter.buildTitleRequest({ apiKey: channel.apiKey, modelId, prompt,
        baseUrl: resolveTitleBaseUrl(channel.provider, channel.baseUrl, channel.apiProtocol) ?? channel.baseUrl ?? '' })
      const result = await fetchTitleWithRetry(request, adapter, this.ports.fetch ?? fetch)
      if (!result.title) throw new Error(result.diagnostics?.reason ?? '标题模型没有返回可用结果')
      return sanitizeGeneratedTitle(result.title)
    } catch (error) {
      console.warn('[Core 标题] 生成失败：', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /** 只在成功用户轮次的终态发布后调用；同会话并发去重。 */
  async afterCompletedTurn(sessionId: string, userMessage: string): Promise<boolean> {
    if (this.naming.has(sessionId)) return false
    const meta = this.ports.getMeta(sessionId)
    if (!meta?.channelId || !meta.modelId) return false
    this.naming.add(sessionId)
    try {
      return await runSessionTitleNaming({ sessionId, userMessage, channelId: meta.channelId, modelId: meta.modelId,
        defaultTitle: meta.title === 'New session' ? 'New session' : '新 Agent 会话',
        getMeta: id => this.ports.getMeta(id), updateMeta: (id, patch) => this.ports.updateMeta(id, patch),
        readMessages: id => this.ports.readMessages(id), generate: input => this.generate(input),
        onTitleUpdated: title => this.ports.onTitleUpdated(sessionId, title), logTag: '[Core 标题]' })
    } finally { this.naming.delete(sessionId) }
  }

  async regenerate(sessionId: string): Promise<string> {
    if (this.naming.has(sessionId)) throw new Error('会话标题正在生成')
    const meta = this.ports.getMeta(sessionId)
    if (!meta?.channelId || !meta.modelId) throw new Error('会话标题渠道或模型未配置')
    this.naming.add(sessionId)
    try {
      const sources = collectSessionTitleSources({ sessionId, meta, fallbackMessage: '',
        readMessages: id => this.ports.readMessages(id), logTag: '[Core 标题]' })
      if (!sources.length) throw new Error('会话没有可用于标题的有效用户消息')
      const title = await this.generate({ userMessage: sources[0]!, contextMessages: sources, channelId: meta.channelId, modelId: meta.modelId })
      if (!title) throw new Error('标题模型没有返回可用结果')
      const latest = this.ports.getMeta(sessionId)
      if (!latest || (latest.revision ?? 0) !== (meta.revision ?? 0)) throw new Error('生成期间会话状态已变化，请重试')
      this.ports.updateMeta(sessionId, { title, titleAutoGeneratedAt: Date.now(), titleLockedAt: Date.now() })
      this.ports.onTitleUpdated(sessionId, title)
      return title
    } finally { this.naming.delete(sessionId) }
  }
}
