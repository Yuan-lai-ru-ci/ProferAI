/**
 * ChannelForm - 模型配置编辑表单
 *
 * 支持创建和编辑模型配置，包含：
 * - 基本信息（名称、供应商、Base URL、API Key）
 * - 模型列表：已启用模型置顶 + 可用模型搜索
 * - 连接测试
 *
 * 编辑模式下修改即时保存（auto-save），创建模式仍需手动提交。
 */

import * as React from 'react'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Download,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { channelFormControllerAtom, channelFormDirtyAtom } from '@/atoms/settings-tab'
import { channelsAtom } from '@/atoms/chat-atoms'
import { buildChannelDraftPatch, createSerialDraftQueue, isCurrentAsyncRequest, usesOAuthCredentials, validateChannelCreation } from '@/lib/channel-form-async'
import { cn } from '@/lib/utils'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import {
  PROVIDER_DEFAULT_AGENT_URLS,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  inferAgentRuntimeModes,
  isAgentEnabledForChannel,
  isChannelEnabledForRuntime,
} from '@profer/shared'
import type {
  AgentRuntimeMode,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelModel,
  ChannelTestResult,
  FetchModelsResult,
  ProviderType,
} from '@profer/shared'
import { isAnthropicShapedEndpoint, resolveAnthropicMessagesUrl, resolveOpenAIChatCompletionsUrl, resolveOpenAIResponsesUrl } from '@profer/core'
import { getProviderLogo } from '@/lib/model-logo'
import { applyModelDiscoveryResult, buildModelDiscoveryAttemptKey, shouldAutoDiscoverModels } from '@/lib/channel-model-discovery'
import { addManualModel } from '@/lib/channel-manual-model'
import { resolveModel1MToggleState } from '@/lib/model-1m-toggle'
import { ScrollArea } from '@profer/ui/primitives/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsToggle,
} from './primitives'

interface ChannelFormProps {
  /** 编辑模式下传入已有渠道，创建模式传 null */
  channel: Channel | null
  onSaved: (channel?: Channel) => void
  onAgentEligibilityChange?: (channel: Channel, eligible: boolean) => void | Promise<void>
  onCancel: () => void
  /** 仅允许填 API Key（官方渠道只设 Key，不修改名称/供应商/模型） */
  apiKeyOnly?: boolean
}

/** 国内供应商（优先推荐） */
const CN_PROVIDERS: ProviderType[] = ['deepseek', 'qwen', 'qwen-anthropic', 'zhipu', 'zhipu-coding', 'zhipu-coding-team', 'doubao', 'ark-coding-plan', 'kimi-api', 'kimi-coding', 'minimax', 'xiaomi', 'xiaomi-token-plan']

/** 境外供应商 */
const GLOBAL_PROVIDERS: ProviderType[] = ['anthropic', 'openai', 'openai-responses', 'opencode-go-openai', 'google', 'xai', 'anthropic-compatible', 'openai-codex', 'ollama', 'custom']

/** 所有可选供应商 */
const PROVIDER_OPTIONS: ProviderType[] = [...CN_PROVIDERS, ...GLOBAL_PROVIDERS]

/** 供应商选项（用于 SettingsSelect） */
const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((p) => {
  const label = PROVIDER_LABELS[p]
  const icon = getProviderLogo(p)
  if (CN_PROVIDERS.includes(p)) {
    return { value: p, label: `${label}（国内 · 推荐）`, icon }
  }
  return { value: p, label, icon }
})

/** 各供应商的 Chat 端点路径，用于 Base URL 预览 */
const PROVIDER_CHAT_PATHS: Record<ProviderType, string> = {
  anthropic: '/v1/messages',
  'anthropic-compatible': '/v1/messages',
  openai: '/chat/completions',
  'openai-responses': '/responses',
  deepseek: '/chat/completions',
  google: '/v1beta/models/{model}:generateContent',
  'kimi-api': '/messages',
  'kimi-coding': '/messages',
  'opencode-go-openai': '/chat/completions',
  zhipu: '/chat/completions',
  'zhipu-coding': '/messages',
  'zhipu-coding-team': '/messages',
  'ark-coding-plan': '/messages',
  minimax: '/v1/messages',
  doubao: '/chat/completions',
  qwen: '/chat/completions',
  'qwen-anthropic': '/messages',
  xiaomi: '/v1/messages',
  'xiaomi-token-plan': '/v1/messages',
  'openai-codex': '',
  xai: '/responses',
  ollama: '/v1/chat/completions',
  custom: '/chat/completions',
}

/** 走 Anthropic 协议的供应商集合（共用 /v1/messages 端点）；Ollama 仅用于 Agent。
 * 注意：DeepSeek 的 Chat 走 OpenAI 兼容协议（/chat/completions），只有 Agent 走
 * Anthropic 兼容入口，因此不在此集合内。 */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'qwen-anthropic',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
])

/** 根据 Ollama 地址提示请求是否会离开本机。 */
function getOllamaNetworkScope(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return '仅本机访问'
    if (hostname.endsWith('.local') || hostname.startsWith('10.') || hostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      return '请求将发送到局域网设备'
    }
    return '请求将发送到远程服务，请确认网络与隐私设置'
  } catch {
    return '无法识别地址范围，请填写有效 URL'
  }
}

/**
 * 生成 API 端点预览 URL
 *
 * 复用真实 adapter 的端点解析函数，完整端点与 query 不重复拼接，
 * 与运行时 channel-manager / AnthropicAdapter 的规范化逻辑保持一致。
 */
function buildPreviewUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'ollama') {
    return `${trimmed.replace(/\/v1$/, '')}/v1/chat/completions（Agent: /v1/messages）`
  }
  // 通用兼容渠道填写完整请求端点，与真实 adapter 共用 URL 解析。
  if (provider === 'custom') {
    // 只填站点根地址时，拼接后的端点会落到站点页面而不是 API，这里给出显式提示。
    return `${resolveOpenAIChatCompletionsUrl(baseUrl, provider)}；请填写完整 /chat/completions 请求端点`
  }
  if (provider === 'deepseek') {
    // DeepSeek 的协议跟随端点形态：官方/`/anthropic` 走 Anthropic，
    // 第三方 OpenAI 兼容网关走 OpenAI。预览必须如实展示，
    // 否则用户无从得知 Agent 会向哪个端点、用哪种协议发请求。
    const usesAnthropicPath = isAnthropicShapedEndpoint(trimmed)
    const isOfficial = /(^|\/\/)api\.deepseek\.com([:/]|$)/i.test(trimmed)
    const agentEndpoint = usesAnthropicPath || (!isOfficial && trimmed !== '')
      ? trimmed
      : PROVIDER_DEFAULT_AGENT_URLS.deepseek ?? ''
    const agentProtocol = isAnthropicShapedEndpoint(agentEndpoint) ? 'Anthropic' : 'OpenAI 兼容'
    // 提示已知不对称：DeepSeek 渠道的 Chat 固定走 OpenAI 兼容协议（仅 Agent 跟随端点形态）。
    // 用户把 Base URL 填成 Anthropic 端点时，Chat 会打错协议，必须显式引导。
    const hint = usesAnthropicPath
      ? '；注意：DeepSeek 渠道的 Chat 固定走 OpenAI 兼容协议，此地址下 Chat 不可用；若需 Chat 也走 Anthropic，请改用「Anthropic 兼容格式」'
      : ''
    return `Chat：${trimmed}${PROVIDER_CHAT_PATHS.deepseek}；Agent：${agentEndpoint}（${agentProtocol}）${hint}`
  }
  if (ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) {
    return resolveAnthropicMessagesUrl(baseUrl, provider)
  }
  if (provider === 'xai' || provider === 'openai-responses') return resolveOpenAIResponsesUrl(baseUrl, provider)
  if (provider === 'google') return `${trimmed}${PROVIDER_CHAT_PATHS[provider]}`
  return resolveOpenAIChatCompletionsUrl(baseUrl, provider)
}

/** auto-save 防抖延迟 */
const AUTO_SAVE_DELAY = 600

/** 自动模型发现的防抖延迟：等用户把 API Key / 地址敲完再请求端点 */
const AUTO_DISCOVERY_DELAY = 700

function isAgentEligibleChannel(channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'>): boolean {
  return isChannelEnabledForRuntime(channel, 'pi') || isAgentEnabledForChannel(channel)
}

/**
 * 模型行上的「1M」勾选。
 *
 * 显示的是**生效结果**：自动判定的模型（如已验证的 DeepSeek V4）也会显示为开启。
 * 实线边 = 自动判定，虚线边 = 用户手动强开 / 强关；点击写入显式偏好。
 */
function Model1MToggle({
  model,
  provider,
  onToggle,
}: {
  model: ChannelModel
  provider: ProviderType
  onToggle: (modelId: string) => void
}): React.ReactElement {
  const state = resolveModel1MToggleState(model, provider)

  return (
    <button
      type="button"
      aria-pressed={state.enabled}
      title={state.title}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(model.id)
      }}
      className={cn(
        'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-4 transition-colors',
        state.enabled
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
        state.source !== 'auto' && 'border-dashed',
      )}
    >
      1M
    </button>
  )
}

export function ChannelForm({ channel, onSaved, onAgentEligibilityChange, onCancel }: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null

  // 表单状态
  const [name, setName] = React.useState(channel?.name ?? '')
  const [provider, setProvider] = React.useState<ProviderType>(channel?.provider ?? 'anthropic')
  const [baseUrl, setBaseUrl] = React.useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic)
  const [credentialMode, setCredentialMode] = React.useState<'api-key' | 'oauth'>(channel?.credentialMode ?? 'api-key')
  const [oauthConfigured, setOauthConfigured] = React.useState(channel?.provider === 'xai' && channel.credentialMode === 'oauth')
  const [agentExperimentalEnabled, setAgentExperimentalEnabled] = React.useState(channel?.provider === 'xai' && (channel.agentRuntimes ?? inferAgentRuntimeModes(channel)).includes('pi'))
  const [agentBaseUrl, setAgentBaseUrl] = React.useState(channel?.agentBaseUrl ?? '')
  /** 用户是否手改过 Anthropic 端点；未改过就不回传，交给主进程按 OpenAI 端点推导。 */
  const agentBaseUrlEditedRef = React.useRef(false)
  /**
   * Agent 内核勾选。可用性由用户决定，不再按渠道类型加门禁。
   * 老配置没有该字段时，按 provider 规则推导出初值（与迁移逻辑一致）。
   */
  const [agentRuntimes, setAgentRuntimes] = React.useState<AgentRuntimeMode[]>(() =>
    channel
      ? channel.agentRuntimes ?? inferAgentRuntimeModes(channel)
      : inferAgentRuntimeModes({ provider: 'anthropic' }),
  )
  const toggleAgentRuntime = React.useCallback((mode: AgentRuntimeMode, enabled: boolean): void => {
    if (provider === 'xai' && mode === 'pi') setAgentExperimentalEnabled(enabled)
    setAgentRuntimes((prev) => enabled
      ? (prev.includes(mode) ? prev : [...prev, mode])
      : prev.filter((item) => item !== mode))
  }, [provider])
  /**
   * 地址框跟着内核勾选显隐：勾了 Pi 才显示 OpenAI 端点，勾了 Claude 才显示 Anthropic 端点。
   *
   * 两者都没勾时不隐藏 OpenAI 端点：它兼作 Chat 的请求地址，
   * 全隐会让不做 Agent 的纯 Chat 渠道没法配地址。
   */
  const piEnabled = agentRuntimes.includes('pi')
  const claudeEnabled = provider !== 'xai' && provider !== 'openai-codex' && agentRuntimes.includes('claude')
  const showOpenAIEndpoint = piEnabled || !claudeEnabled
  const showAnthropicEndpoint = claudeEnabled
  const [apiKey, setApiKey] = React.useState('')
  const keyEditedRef = React.useRef(false)
  const keyRevisionRef = React.useRef(0)
  const [keyEdited, setKeyEdited] = React.useState(false)
  const oauthCredentials = usesOAuthCredentials(provider, credentialMode)
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [oauthLoggingIn, setOauthLoggingIn] = React.useState(false)
  const oauthLoginActiveRef = React.useRef(false)
  const [oauthError, setOauthError] = React.useState<string | null>(null)
  const creationRef = React.useRef<Promise<Channel | null> | null>(null)
  const createdChannelRef = React.useRef<Channel | null>(null)
  const handleCredentialModeChange = (value: string): void => {
    if (value === credentialMode || oauthLoginActiveRef.current) return
    discoveryRequestRef.current += 1
    testRequestRef.current += 1
    const nextMode = value as 'api-key' | 'oauth'
    setCredentialMode(nextMode)
    setOauthConfigured(nextMode === 'oauth' && channel?.provider === 'xai' && channel.credentialMode === 'oauth')
    keyRevisionRef.current += 1
    keyEditedRef.current = true
    setKeyEdited(true)
    setApiKey('')
  }
  const [models, setModels] = React.useState<ChannelModel[]>(channel?.models ?? [])
  const [enabled, setEnabled] = React.useState(channel?.enabled ?? true)

  // 新模型输入
  const [newModelId, setNewModelId] = React.useState('')
  const [newModelName, setNewModelName] = React.useState('')

  // 模型搜索过滤
  const [modelFilter, setModelFilter] = React.useState('')

  // UI 状态
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<ChannelTestResult | null>(null)
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [fetchResult, setFetchResult] = React.useState<FetchModelsResult | null>(null)
  /** 已自动尝试过发现的「供应商 + 地址 + 凭证」组合，避免同一组合反复请求 */
  const autoDiscoveryKeyRef = React.useRef<string | null>(null)
  /** 用户手动增删过模型后不再自动发现，避免把用户清空的清单又塞回来 */
  const modelsUserEditedRef = React.useRef(false)
  const [apiKeyLoaded, setApiKeyLoaded] = React.useState(false)
  const [showExitDialog, setShowExitDialog] = React.useState(false)

  const setChannelFormDirty = useSetAtom(channelFormDirtyAtom)
  const setFormController = useSetAtom(channelFormControllerAtom)
  const setChannels = useSetAtom(channelsAtom)
  const lastAgentEligibleRef = React.useRef(channel ? isAgentEligibleChannel(channel) : false)

  React.useEffect(() => {
    lastAgentEligibleRef.current = channel ? isAgentEligibleChannel(channel) : false
  }, [channel])

  const mountedRef = React.useRef(true)
  const discoveryRequestRef = React.useRef(0)
  const testRequestRef = React.useRef(0)
  const formRequestScopeRef = React.useRef<string>()
  formRequestScopeRef.current ??= crypto.randomUUID()
  const activeNetworkRequestsRef = React.useRef(new Map<string, 'discovery' | 'test'>())
  const cancelNetworkRequests = React.useCallback((kind?: 'discovery' | 'test'): void => {
    for (const [id, requestKind] of activeNetworkRequestsRef.current) {
      if (kind && requestKind !== kind) continue
      activeNetworkRequestsRef.current.delete(id)
      void window.electronAPI.cancelChannelRequest(id).catch(() => {})
    }
  }, [])
  const requestKey = JSON.stringify([provider, baseUrl, apiKey, credentialMode])
  const requestKeyRef = React.useRef(requestKey)
  requestKeyRef.current = requestKey
  const testKey = JSON.stringify([requestKey, agentBaseUrl, agentRuntimes, models.find((model) => model.enabled)?.id])
  const testKeyRef = React.useRef(testKey)
  testKeyRef.current = testKey
  const discardedRef = React.useRef(false)
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      discoveryRequestRef.current += 1
      testRequestRef.current += 1
      cancelNetworkRequests()
      if (oauthLoginActiveRef.current) {
        void window.electronAPI.cancelCodexOAuthLogin().catch(() => {})
        void window.electronAPI.cancelXaiOAuthLogin().catch(() => {})
      }
    }
  }, [])

  /** OAuth 只由授权链路管理；慢解密不能覆盖用户输入或切供应商后的草稿。 */
  React.useEffect(() => {
    if (!channel || usesOAuthCredentials(channel.provider, channel.credentialMode)) {
      setApiKeyLoaded(true)
      return
    }
    let cancelled = false
    const revision = keyRevisionRef.current
    void window.electronAPI.decryptApiKey(channel.id).then((key) => {
      if (!cancelled && revision === keyRevisionRef.current && !keyEditedRef.current) setApiKey(key)
    }).catch(() => {
      if (!cancelled) toast.error('凭据读取失败；原凭据不会被覆盖，可输入新 Key 后重试')
    }).finally(() => {
      if (!cancelled) setApiKeyLoaded(true)
    })
    return () => { cancelled = true }
  }, [channel?.id])

  // 返回和导航读取同一份 latest draft，不依赖防抖闭包。
  const draft = React.useMemo<ChannelUpdateInput>(() => ({
    name, provider, baseUrl, agentRuntimes, models, enabled,
    ...(agentBaseUrlEditedRef.current ? { agentBaseUrl: agentBaseUrl.trim() } : {}),
    ...(provider === 'xai' && (credentialMode !== 'oauth' || oauthConfigured)
      ? { credentialMode, agentExperimentalEnabled } : {}),
    ...(!oauthCredentials && keyEdited && apiKey.trim() ? { apiKey } : {}),
  }), [name, provider, baseUrl, agentBaseUrl, agentRuntimes, models, enabled, credentialMode, agentExperimentalEnabled, oauthConfigured, oauthCredentials, keyEdited, apiKey])
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const baselineRef = React.useRef<ChannelUpdateInput>(draft)
  const [saveRevision, setSaveRevision] = React.useState(0)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [leaving, setLeaving] = React.useState(false)
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveDraftRef = React.useRef<(next: ChannelUpdateInput) => Promise<void>>(async () => {})
  const queue = React.useMemo(() => createSerialDraftQueue<ChannelUpdateInput>((next) => saveDraftRef.current(next)), [channel?.id])
  saveDraftRef.current = async (next) => {
    if (!channel) return
    if (next.provider === 'xai' && next.credentialMode === 'api-key' && channel.credentialMode === 'oauth' && !next.apiKey) {
      throw new Error('切换 API Key 认证后请填写新的 API Key')
    }
    const patch = buildChannelDraftPatch(baselineRef.current, next)
    if (Object.keys(patch).length === 0) return
    if (next.provider !== channel.provider && next.provider !== 'ollama' && !next.apiKey && !usesOAuthCredentials(next.provider!, next.credentialMode)) {
      throw new Error('更换供应商后请填写新的 API Key')
    }
    setSaving(true)
    try {
      const savedChannel = await window.electronAPI.updateChannel(channel.id, patch)
      setChannels((current) => current.map((item) => item.id === savedChannel.id ? savedChannel : item))
      const eligible = isAgentEligibleChannel(savedChannel)
      if (eligible !== lastAgentEligibleRef.current) {
        await onAgentEligibilityChange?.(savedChannel, eligible)
        lastAgentEligibleRef.current = eligible
      }
      baselineRef.current = next
      if (mountedRef.current) {
        setSaveError(null)
        setSaveRevision((revision) => revision + 1)
      }
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }
  const pendingOAuth = isEdit && provider === 'xai' && credentialMode === 'oauth' && !oauthConfigured
  const pendingOAuthRef = React.useRef(pendingOAuth)
  pendingOAuthRef.current = pendingOAuth
  const flushEdit = React.useCallback(async (): Promise<boolean> => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    if (pendingOAuthRef.current) {
      setSaveError('请先完成订阅登录，再保存认证方式变更')
      return false
    }
    queue.replace(draftRef.current)
    try {
      await queue.flush()
      return true
    } catch (error) {
      if (mountedRef.current) setSaveError(error instanceof Error ? error.message : '保存失败，请重试')
      return false
    }
  }, [queue])

  React.useEffect(() => {
    if (!isEdit || discardedRef.current || oauthLoggingIn) return
    if (Object.keys(buildChannelDraftPatch(baselineRef.current, draft)).length === 0 && !saving) {
      queue.cancel()
      return
    }
    queue.replace(draft)
    // 失败草稿保持 dirty，由用户重试；不在错误状态循环发请求。
    if (saveError) return
    autoSaveTimerRef.current = setTimeout(() => { void flushEdit() }, AUTO_SAVE_DELAY)
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }
  }, [isEdit, draft, queue, flushEdit, saveRevision, saveError, saving, oauthLoggingIn])

  React.useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    queue.cancel()
  }, [queue])

  // 配置改变后旧测试/发现不再属于当前草稿，允许立即发起新请求。
  React.useEffect(() => {
    discoveryRequestRef.current += 1
    testRequestRef.current += 1
    cancelNetworkRequests()
    setFetchingModels(false)
    setTesting(false)
    setFetchResult(null)
    setTestResult(null)
  }, [requestKey])

  React.useEffect(() => {
    testRequestRef.current += 1
    cancelNetworkRequests('test')
    setTesting(false)
    setTestResult(null)
  }, [testKey, cancelNetworkRequests])

  // 切换供应商时自动更新 Base URL 与名称，Anthropic 兼容渠道自动添加预设模型
  const handleProviderChange = (newProvider: string): void => {
    if (isEdit && newProvider === 'openai-codex' && channel.provider !== 'openai-codex') {
      toast.info('请新建 ChatGPT 订阅渠道并完成授权')
      return
    }
    if (oauthLoginActiveRef.current) return
    discoveryRequestRef.current += 1
    testRequestRef.current += 1
    const p = newProvider as ProviderType
    // 若 name 为空或仍是上一个 provider 的默认名称，则用新 provider 的名称覆盖；用户手动改过的 name 不动
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === PROVIDER_LABELS[provider]) {
      setName(PROVIDER_LABELS[p])
    }
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    keyRevisionRef.current += 1
    keyEditedRef.current = true
    setKeyEdited(true)
    setApiKey('')
    autoDiscoveryKeyRef.current = null
    modelsUserEditedRef.current = false
    setCredentialMode('api-key')
    setOauthConfigured(false)
    setAgentExperimentalEnabled(false)
    // 换供应商通常意味着换协议；按新供应商重推内核勾选，用户可再手改
    setAgentRuntimes(inferAgentRuntimeModes({ provider: p }))
    agentBaseUrlEditedRef.current = false
    setAgentBaseUrl('')
    setTestResult(null)
    setFetchResult(null)
    setModelFilter('')
    // 换供应商意味着协议和模型命名空间都变了：清空旧模型，由端点发现或用户手填重新确定清单。
    // 这里不预置任何「这家供应商大概有哪些模型」的清单——预置清单会冒充真实端点能力，
    // 用户看起来像已配置完成，实际可能拿不到服务，也看不到账号真实的可用模型。
    setModels([])
  }

  /** 添加模型 */
  const handleAddModel = (): void => {
    const result = addManualModel(models, newModelId, newModelName)
    if (result.kind === 'empty') return
    if (result.kind === 'invalid') {
      toast.warning('模型 ID 不能包含空格或换行', { id: 'invalid-model-id-warn' })
      return
    }
    if (result.kind === 'duplicate') {
      toast.warning(`模型 ${result.id} 已在列表中`, { id: 'duplicate-model-warn' })
      return
    }

    modelsUserEditedRef.current = true
    setModels(result.models)
    setNewModelId('')
    setNewModelName('')
  }

  /** 删除模型 */
  const handleRemoveModel = (modelId: string): void => {
    modelsUserEditedRef.current = true
    setModels((prev) => prev.filter((m) => m.id !== modelId))
  }

  /** 切换模型启用状态（点击可用模型 → 启用，点击已启用模型 → 禁用） */
  const handleToggleModel = (modelId: string): void => {
    setModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m))
    )
  }

  /**
   * 切换模型上的 1M 上下文偏好。
   *
   * 写入的是显式强开 / 强关；模型未手动设置过时显示的是自动判定结果。
   */
  const handleToggleModel1M = (modelId: string): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId
        ? { ...model, context1m: resolveModel1MToggleState(model, provider).nextExplicit }
        : model
    )))
  }

  /**
   * 是否具备发起模型发现的条件。
   *
   * Ollama 走本机 /api/tags，不需要 Key；其余供应商必须同时有地址与凭证。
   */
  const canDiscoverModels = Boolean(baseUrl.trim())
    && (provider === 'ollama' || Boolean(apiKey.trim()))
    && !oauthCredentials

  /**
   * 从供应商 API 拉取可用模型列表（自动发现与手动点击共用）。
   *
   * 远端发现失败只反馈结果，不能把失败误当成权威空列表，
   * 否则编辑模式的 auto-save 会错误覆盖用户现有模型配置。
   */
  const runModelDiscovery = React.useCallback(async (options?: { keepPreviousResult?: boolean }): Promise<void> => {
    if (!canDiscoverModels) return
    cancelNetworkRequests('discovery')
    const requestId = ++discoveryRequestRef.current
    const networkId = `${formRequestScopeRef.current}-discovery-${requestId}`
    activeNetworkRequestsRef.current.set(networkId, 'discovery')
    const key = requestKeyRef.current

    setFetchingModels(true)
    if (!options?.keepPreviousResult) setFetchResult(null)

    try {
      const result = await window.electronAPI.fetchModels({
        requestId: networkId,
        provider,
        baseUrl,
        apiKey,
      })

      if (!mountedRef.current || !isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) return
      setFetchResult(result)

      if (!result.success) return

      setModels((prev) => applyModelDiscoveryResult(prev, result))
    } catch (error) {
      // IPC 异常同样只显示失败，保留用户当前全部模型配置。
      if (!mountedRef.current || !isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) return
      setFetchResult({ success: false, message: '拉取模型请求失败', models: [] })
    } finally {
      activeNetworkRequestsRef.current.delete(networkId)
      if (mountedRef.current && isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) setFetchingModels(false)
    }
  }, [canDiscoverModels, provider, baseUrl, apiKey])

  /** 手动「从供应商获取」：覆盖上一次结果提示，并记下尝试键避免与自动发现重复请求 */
  const handleFetchModels = (): void => {
    autoDiscoveryKeyRef.current = buildModelDiscoveryAttemptKey({ provider, baseUrl, apiKey })
    void runModelDiscovery()
  }

  /**
   * 自动从供应商发现模型清单。
   *
   * 渠道不再预置任何模型，清单必须来自端点本身：地址与凭证就绪且当前没有任何模型时自动拉取一次。
   * 同一个「供应商 + 地址 + 凭证」组合只尝试一次，错误凭证不会反复打点；
   * 改地址 / 改 Key / 手动点击「从供应商获取」都会重新发起。
   */
  React.useEffect(() => {
    const attemptKey = buildModelDiscoveryAttemptKey({ provider, baseUrl, apiKey })
    const shouldDiscover = shouldAutoDiscoverModels({
      canDiscover: canDiscoverModels,
      modelCount: models.length,
      fetching: fetchingModels,
      awaitingCredentials: isEdit && !apiKeyLoaded,
      userEditedModels: modelsUserEditedRef.current,
      attemptKey,
      lastAttemptKey: autoDiscoveryKeyRef.current,
    })
    if (!shouldDiscover) return

    const timer = setTimeout(() => {
      autoDiscoveryKeyRef.current = attemptKey
      void runModelDiscovery({ keepPreviousResult: true })
    }, AUTO_DISCOVERY_DELAY)
    return () => clearTimeout(timer)
  }, [isEdit, apiKeyLoaded, models.length, fetchingModels, canDiscoverModels, provider, baseUrl, apiKey, credentialMode, runModelDiscovery])

  /** 测试连接（直接使用表单当前值，无需先保存） */
  const handleTest = async (): Promise<void> => {
    if (oauthCredentials) return
    if ((provider !== 'ollama' && !apiKey.trim()) || !baseUrl.trim()) return

    cancelNetworkRequests('test')
    setTesting(true)
    const requestId = ++testRequestRef.current
    const networkIds: string[] = []
    const key = testKeyRef.current
    setTestResult(null)

    try {
      const selectedModel = models.find((model) => model.enabled)?.id
      const runtimes: Array<AgentRuntimeMode | undefined> = agentRuntimes.length ? agentRuntimes : [undefined]
      const results = await Promise.all(runtimes.map(async (runtime) => {
        const networkId = `${formRequestScopeRef.current}-test-${requestId}-${runtime ?? 'chat'}`
        networkIds.push(networkId)
        activeNetworkRequestsRef.current.set(networkId, 'test')
        const result = await window.electronAPI.testChannelDirect({
          requestId: networkId,
          provider, baseUrl, apiKey, runtime,
          ...(selectedModel ? { modelId: selectedModel } : {}),
          ...(runtime === 'claude' ? { agentBaseUrl } : {}),
        })
        return { ...result, message: `${runtime === 'claude' ? 'Claude' : runtime === 'pi' ? 'Pi / Chat' : 'Chat'}：${result.message}` }
      }))
      const result = {
        success: results.every((item) => item.success),
        cancelled: results.some((item) => item.cancelled),
        message: results.map((item) => item.message).join('；'),
      }
      if (mountedRef.current && isCurrentAsyncRequest(requestId, testRequestRef.current, key, testKeyRef.current)) setTestResult(result)
    } catch (error) {
      // 某一 IPC 异常时也中断同轮尚未结束的其它内核请求，不影响新一轮。
      for (const id of networkIds) {
        if (!activeNetworkRequestsRef.current.has(id)) continue
        activeNetworkRequestsRef.current.delete(id)
        void window.electronAPI.cancelChannelRequest(id).catch(() => {})
      }
      if (mountedRef.current && isCurrentAsyncRequest(requestId, testRequestRef.current, key, testKeyRef.current)) setTestResult({ success: false, message: '测试请求失败' })
    } finally {
      for (const id of networkIds) activeNetworkRequestsRef.current.delete(id)
      if (mountedRef.current && isCurrentAsyncRequest(requestId, testRequestRef.current, key, testKeyRef.current)) setTesting(false)
    }
  }

  const loadCodexModels = React.useCallback(async (): Promise<void> => {
    const requestId = ++discoveryRequestRef.current
    const key = requestKeyRef.current
    setFetchingModels(true)
    try {
      const catalog = await window.electronAPI.listCodexModels()
      if (!mountedRef.current || !isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) return
      setModels((previous) => applyModelDiscoveryResult(previous, { success: true, message: 'Pi Codex 模型目录', models: catalog }))
      setFetchResult({ success: true, message: 'Pi Codex 模型目录（账号可用性以实际订阅为准）', models: catalog })
    } catch {
      if (mountedRef.current && isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) {
        setFetchResult({ success: false, message: 'Codex 模型目录读取失败，请重试', models: [] })
      }
    } finally {
      if (mountedRef.current && isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) setFetchingModels(false)
    }
  }, [])
  const loadXaiModels = React.useCallback(async (): Promise<void> => {
    const requestId = ++discoveryRequestRef.current
    const key = requestKeyRef.current
    setFetchingModels(true)
    try {
      const catalog = await window.electronAPI.listXaiModels()
      if (!mountedRef.current || !isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) return
      setModels((previous) => applyModelDiscoveryResult(previous, { success: true, message: 'Pi xAI 模型目录', models: catalog }))
      setFetchResult({ success: true, message: 'Pi xAI 模型目录（账号可用性以实际订阅为准）', models: catalog })
    } catch {
      if (mountedRef.current && isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) setFetchResult({ success: false, message: 'xAI 模型目录读取失败，请重试', models: [] })
    } finally {
      if (mountedRef.current && isCurrentAsyncRequest(requestId, discoveryRequestRef.current, key, requestKeyRef.current)) setFetchingModels(false)
    }
  }, [])
  React.useEffect(() => {
    if (provider === 'openai-codex') void loadCodexModels()
    if (provider === 'xai' && credentialMode === 'oauth') void loadXaiModels()
  }, [provider, credentialMode, loadCodexModels, loadXaiModels])

  const handleCodexReauthorize = async (): Promise<void> => {
    if (!channel) {
      await handleCreate()
      return
    }
    if (!channel || oauthLoginActiveRef.current) return
    oauthLoginActiveRef.current = true
    setOauthLoggingIn(true)
    setOauthError(null)
    try {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      queue.cancel()
      await queue.settle()
      const updated = await window.electronAPI.loginCodexOAuth(channel.id)
      if (!mountedRef.current) return
      setChannels((current) => current.map((item) => item.id === updated.id ? updated : item))
      toast.success('ChatGPT 订阅授权成功')
    } catch (error) {
      if (mountedRef.current) setOauthError(error instanceof Error ? error.message : 'Codex 授权失败，请重试')
    } finally {
      oauthLoginActiveRef.current = false
      if (mountedRef.current) setOauthLoggingIn(false)
    }
  }
  const handleCancelCodexLogin = async (): Promise<void> => {
    try {
      await window.electronAPI.cancelCodexOAuthLogin()
    } catch {
      setOauthError('取消授权失败，请重试')
    }
  }

  /** 执行创建渠道 */
  const doCreate = React.useCallback(async (): Promise<Channel | null> => {
    if (createdChannelRef.current) return createdChannelRef.current
    if (creationRef.current) return creationRef.current
    if (saving || oauthLoginActiveRef.current) return null
    const input: ChannelCreateInput = {
      name,
      provider,
      baseUrl,
      agentBaseUrl: agentBaseUrl.trim() || undefined,
      agentRuntimes,
      ...(provider === 'xai' && { credentialMode, agentExperimentalEnabled }),
      apiKey,
      models,
      enabled,
    }
    const validation = validateChannelCreation(input)
    if (validation) {
      toast.warning(validation, { id: 'channel-validation' })
      return null
    }
    setSaving(true)
    setOauthError(null)
    if (oauthCredentials) {
      oauthLoginActiveRef.current = true
      setOauthLoggingIn(true)
    }
    const operation = (async (): Promise<Channel | null> => {
    try {
      const { apiKey: _key, provider: _provider, credentialMode: _mode, ...oauthInput } = input
      const savedChannel = provider === 'openai-codex'
        ? await window.electronAPI.loginCodexOAuth(oauthInput)
        : provider === 'xai' && credentialMode === 'oauth'
          ? await window.electronAPI.loginXaiOAuth(oauthInput)
          : await window.electronAPI.createChannel(input)
      createdChannelRef.current = savedChannel
      if (isAgentEligibleChannel(savedChannel)) {
        try {
          await onAgentEligibilityChange?.(savedChannel, true)
        } catch {
          toast.error('渠道已创建，但 Agent 默认配置更新失败')
        }
      }
      toast.success('渠道创建成功')
      return savedChannel
    } catch (error) {
      console.error('[模型配置表单] 创建失败:', error)
      toast.error('渠道创建失败，请检查配置后重试')
      if (oauthCredentials && mountedRef.current) setOauthError(error instanceof Error ? error.message : '订阅授权失败，请重试')
      return null
    } finally {
      oauthLoginActiveRef.current = false
      if (mountedRef.current) { setSaving(false); setOauthLoggingIn(false) }
    }
    })()
    creationRef.current = operation
    try { return await operation }
    finally { if (creationRef.current === operation) creationRef.current = null }
  }, [name, provider, baseUrl, agentBaseUrl, agentRuntimes, credentialMode, agentExperimentalEnabled, apiKey, models, enabled, saving, oauthCredentials, onAgentEligibilityChange])

  /** 创建渠道（仅新建模式） */
  const handleCreate = async (): Promise<void> => {
    const savedChannel = await doCreate()
    if (savedChannel) onSaved(savedChannel)
  }

  /** 检测表单是否有未保存内容 */
  const isDirty = isEdit
    ? saving || pendingOAuth || saveError !== null || Object.keys(buildChannelDraftPatch(baselineRef.current, draft)).length > 0
    : name.trim() !== '' || apiKey.trim() !== '' || models.length > 0 || provider !== 'anthropic' || baseUrl !== PROVIDER_DEFAULT_URLS.anthropic || agentBaseUrl.trim() !== '' || !enabled || JSON.stringify(agentRuntimes) !== JSON.stringify(inferAgentRuntimeModes({ provider: 'anthropic' }))
  const hasNoModels = !isEdit && !models.some((model) => model.enabled)

  /** 返回按钮：创建模式下有未保存内容时拦截 */
  const handleBack = async (): Promise<void> => {
    if (leaving) return
    if (!isEdit && isDirty) {
      setShowExitDialog(true)
      return
    }
    if (isEdit) {
      setLeaving(true)
      const success = await flushEdit()
      setLeaving(false)
      if (success) onSaved()
      else setShowExitDialog(true)
    } else {
      onCancel()
    }
  }

  /** 放弃编辑 */
  const handleDiscard = async (): Promise<void> => {
    discardedRef.current = true
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    queue.cancel()
    discoveryRequestRef.current += 1
    testRequestRef.current += 1
    cancelNetworkRequests()
    await queue.settle()
    setShowExitDialog(false)
    onCancel()
  }

  /** 保存并关闭（从弹窗触发） */
  const handleSaveAndClose = async (): Promise<void> => {
    if (isEdit) {
      if (await flushEdit()) { setShowExitDialog(false); onSaved() }
      return
    }
    const savedChannel = await doCreate()
    if (savedChannel) {
      setShowExitDialog(false)
      onSaved(savedChannel)
    }
  }

  React.useLayoutEffect(() => {
    setFormController({
      busy: saving || leaving || oauthLoggingIn,
      flush: isEdit ? flushEdit : async () => (await doCreate()) !== null,
      discard: async () => {
        discardedRef.current = true
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
        queue.cancel()
        discoveryRequestRef.current += 1
        testRequestRef.current += 1
        cancelNetworkRequests()
        await queue.settle()
      },
    })
    return () => setFormController(null)
  }, [isEdit, flushEdit, doCreate, queue, setFormController, saving, leaving, oauthLoggingIn])

  // 同步表单 dirty 状态到全局 atom（供 SettingsPanel 拦截侧边栏导航）
  React.useLayoutEffect(() => {
    setChannelFormDirty(isDirty)
    return () => { setChannelFormDirty(false) }
  }, [isDirty, setChannelFormDirty])

  // 拦截窗口关闭（Cmd+W / Alt+F4 / 点击窗口 X）
  React.useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // ===== 模型分区 =====
  const enabledModels = models.filter((m) => m.enabled)
  const availableModels = React.useMemo(() => {
    const disabled = models.filter((m) => !m.enabled)
    if (!modelFilter.trim()) return disabled
    const keyword = modelFilter.trim().toLowerCase()
    return disabled.filter(
      (m) => m.id.toLowerCase().includes(keyword) || m.name.toLowerCase().includes(keyword)
    )
  }, [models, modelFilter])

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleBack}
          disabled={leaving || (!isEdit && saving) || oauthLoggingIn}
          aria-label="返回渠道列表"
          title="返回渠道列表"
        >
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground flex-1">
          {isEdit ? '编辑模型配置' : '添加模型配置'}
        </h3>
        {/* 新建模式：创建按钮 */}
        {isEdit && (
          <Button size="sm" onClick={() => { void flushEdit() }} disabled={saving || leaving || oauthLoggingIn || !isDirty}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            <span>{saveError ? '重试保存' : '保存'}</span>
          </Button>
        )}
        {!isEdit && (
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={saving || oauthLoggingIn || !name.trim() || (provider !== 'ollama' && !oauthCredentials && !apiKey.trim())}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            <span>{oauthCredentials ? '登录并创建' : '创建'}</span>
          </Button>
        )}
      </div>

      {/* 基本信息卡片 */}
      {isEdit && (
        <div role={saveError ? 'alert' : 'status'} aria-live="polite" className={cn('text-sm', saveError ? 'text-destructive' : 'text-muted-foreground')}>
          {saveError ? `未保存：${saveError}` : saving ? '保存中…' : isDirty ? '有未保存的更改' : '已保存'}
        </div>
      )}
      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsSelect
            label="供应商类型"
            disabled={oauthLoggingIn || saving}
            value={provider}
            onValueChange={handleProviderChange}
            options={PROVIDER_SELECT_OPTIONS}
            placeholder="选择供应商"
          />
          <SettingsInput
            label="供应商名称"
            value={name}
            onChange={setName}
            placeholder="例如: My Anthropic"
            required
          />
          {provider === 'xai' && (
            <SettingsSelect
              label="xAI 认证方式"
              disabled={oauthLoggingIn || saving}
              value={credentialMode}
              onValueChange={handleCredentialModeChange}
              options={[
                { value: 'api-key', label: 'xAI API Key（Chat + Pi Agent 实验）' },
                { value: 'oauth', label: 'Grok/X 订阅 OAuth（Pi Agent 实验）' },
              ]}
              description="API Key 由 xAI API 计费；订阅 OAuth 使用 SuperGrok 或 X Premium。"
            />
          )}
          {/* Agent 内核勾选：能不能用由用户决定，不按渠道类型加门禁 */}
          <SettingsToggle
            label="Pi 模式"
            description={provider === 'xai' ? '启用实验性 Pi Agent；订阅渠道仅用于 Pi' : 'Pi 内核可用'}
            disabled={oauthLoggingIn || saving}
            checked={agentRuntimes.includes('pi')}
            onCheckedChange={(checked) => toggleAgentRuntime('pi', checked)}
          />
          <SettingsToggle
            label="Claude 模式"
            description={provider === 'xai' || provider === 'openai-codex' ? '此供应商仅支持 Pi 内核' : 'Claude 内核需要 Anthropic 兼容端点'}
            disabled={oauthLoggingIn || saving || provider === 'xai' || provider === 'openai-codex'}
            checked={provider !== 'xai' && provider !== 'openai-codex' && agentRuntimes.includes('claude')}
            onCheckedChange={(checked) => toggleAgentRuntime('claude', checked)}
          />
          {showOpenAIEndpoint && provider !== 'openai-codex' && (
            <SettingsInput
              label="OpenAI 端点"
              value={baseUrl}
              onChange={(value) => { discoveryRequestRef.current += 1; testRequestRef.current += 1; setBaseUrl(value) }}
              placeholder="https://api.example.com/v1"
              description={baseUrl.trim()
                ? provider === 'ollama'
                  ? `预览：${buildPreviewUrl(baseUrl, provider)}；${getOllamaNetworkScope(baseUrl)}`
                  : `预览：${buildPreviewUrl(baseUrl, provider)}`
                : undefined}
            />
          )}
          {/*
            留空时的真实行为（主进程 inferAgentBaseUrl，已实跑核对）：
            - 有官方默认入口的供应商 → 用官方入口（即 placeholder 显示的值）
            - custom / anthropic-compatible / openai 等 → 沿用渠道的 OpenAI 端点
            - deepseek 按地址形态分：官方地址用官方入口，第三方地址沿用 OpenAI 端点
            文案必须与运行时一致，不写一个不会生效的示例地址。
          */}
          {showAnthropicEndpoint && (
            <SettingsInput
              label="Anthropic 端点"
              value={agentBaseUrl}
              onChange={(value) => { agentBaseUrlEditedRef.current = true; setAgentBaseUrl(value) }}
              placeholder={PROVIDER_DEFAULT_AGENT_URLS[provider]}
              description={provider === 'deepseek'
                ? 'Claude 内核使用；留空自动推导：官方地址用官方入口，第三方地址沿用 OpenAI 端点'
                : PROVIDER_DEFAULT_AGENT_URLS[provider]
                  ? 'Claude 内核使用；留空用官方默认入口'
                  : 'Claude 内核使用；留空沿用渠道的 OpenAI 端点'}
            />
          )}
          {/* API Key + 测试连接同行 */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor={oauthCredentials ? undefined : 'channel-api-key'} className="text-sm font-medium text-foreground">{oauthCredentials ? '订阅凭据' : `API Key${provider === 'ollama' ? '（可选）' : ''}`}</label>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={testing ? () => {
                  testRequestRef.current += 1
                  cancelNetworkRequests('test')
                  setTesting(false)
                  setTestResult({ success: false, cancelled: true, message: '测试已取消' })
                } : handleTest}
                disabled={oauthCredentials || (provider !== 'ollama' && !apiKey.trim()) || !baseUrl.trim()}
                className="h-7 text-xs"
              >
                {testing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Zap size={12} />
                )}
                <span>{testing ? '取消测试' : '测试连接'}</span>
              </Button>
            </div>
            {provider === 'xai' && credentialMode === 'oauth' ? (
              <div className="space-y-2" aria-busy={oauthLoggingIn}>
              <Button type="button" variant="outline" className="w-full" disabled={oauthLoggingIn || saving} onClick={async () => {
                if (!channel) { await handleCreate(); return }
                if (oauthLoginActiveRef.current) return
                oauthLoginActiveRef.current = true
                const loginKey = requestKeyRef.current
                setOauthLoggingIn(true)
                setOauthError(null)
                try {
                  if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
                  queue.cancel()
                  await queue.settle()
                  const updated = await window.electronAPI.loginXaiOAuth(channel.id)
                  if (!mountedRef.current || loginKey !== requestKeyRef.current) return
                  setOauthConfigured(true)
                  setApiKey('')
                  setModels(updated.models)
                  setChannels((current) => current.map((item) => item.id === updated.id ? updated : item))
                  setSaveError(null)
                  toast.success('xAI 订阅登录成功')
                } catch (error) {
                  if (mountedRef.current) setOauthError(error instanceof Error ? error.message : 'xAI 订阅登录失败，请重试')
                } finally {
                  oauthLoginActiveRef.current = false
                  if (mountedRef.current) setOauthLoggingIn(false)
                }
              }}>
                {oauthLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                <span>{oauthLoggingIn ? '等待浏览器授权...' : isEdit ? '重新授权 Grok/X 订阅' : '登录并创建 Grok/X 订阅'}</span>
              </Button>
              {oauthLoggingIn && <Button type="button" variant="outline" className="w-full" onClick={async () => {
                try { await window.electronAPI.cancelXaiOAuthLogin() }
                catch { setOauthError('取消授权失败，请重试') }
              }}>取消授权</Button>}
              {oauthLoggingIn && <p role="status" aria-live="polite" className="sr-only">等待 Grok/X 订阅授权</p>}
              {oauthError && <p role="alert" className="text-xs text-destructive">{oauthError}</p>}
              </div>
            ) : provider === 'openai-codex' ? (
              <div className="space-y-2">
                <Button type="button" variant="outline" className="w-full" disabled={oauthLoggingIn || saving}
                  onClick={handleCodexReauthorize}>
                  {oauthLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  <span>{oauthLoggingIn ? '等待 ChatGPT 授权...' : isEdit ? '重新授权 ChatGPT 订阅' : '创建时登录 ChatGPT 订阅'}</span>
                </Button>
                {oauthLoggingIn && <Button type="button" variant="outline" className="w-full" onClick={handleCancelCodexLogin}>取消授权</Button>}
                {oauthLoggingIn && <p role="status" aria-live="polite" className="sr-only">等待 ChatGPT 订阅授权</p>}
                {oauthError && <p role="alert" className="text-xs text-destructive">{oauthError}</p>}
              </div>
            ) : <div className="relative">
              <Input
                id="channel-api-key"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => { discoveryRequestRef.current += 1; testRequestRef.current += 1; keyRevisionRef.current += 1; keyEditedRef.current = true; setKeyEdited(true); setApiKey(e.target.value) }}
                placeholder={provider === 'ollama' ? 'Ollama 默认使用本地认证标识，无需填写' : (isEdit ? '留空则不更新' : '输入 API Key')}
                required={!isEdit && provider !== 'ollama'}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>}
            {provider === 'xai' && credentialMode === 'oauth' && (
              <div className="text-xs text-muted-foreground">OAuth 凭据只保存在本机加密存储中，Chat 需要单独配置 xAI API Key。</div>
            )}
            {testResult && (
              <div role="status" aria-live="polite" className={cn(
                'flex items-center gap-1.5 text-xs',
                testResult.cancelled ? 'text-muted-foreground' : testResult.success ? 'text-emerald-600' : 'text-destructive'
              )}>
                {testResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                <span>{testResult.message}</span>
              </div>
            )}
          </div>
          {provider === 'xai' && (
            <SettingsToggle
              label="启用实验性 Agent"
              description="开启后该 xAI 渠道才会出现在 Agent 模型选择中，默认关闭。"
              checked={agentExperimentalEnabled}
              onCheckedChange={setAgentExperimentalEnabled}
            />
          )}
          <SettingsToggle
            label="启用此配置"
            description="关闭后该配置的模型不会在选择列表中出现"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 已启用模型 */}
      <SettingsSection
        title="已启用模型"
        description={enabledModels.length > 0 ? `${enabledModels.length} 个模型` : undefined}
      >
        <SettingsCard divided={false}>
          {enabledModels.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {models.length === 0
                ? provider === 'openai-codex'
                  ? 'Codex 模型目录尚未加载'
                  : '还没有模型清单：填写 API Key 后会自动从供应商获取，也可以手动添加模型 ID'
                : '还没有启用任何模型，从下方可用模型中选择'}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {enabledModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 px-4 py-2.5 group"
                >
                  <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                  <span className="text-sm text-foreground flex-1">
                    {model.name}
                    {model.name !== model.id && (
                      <span className="text-muted-foreground ml-1">({model.id})</span>
                    )}
                  </span>
                  <Model1MToggle model={model} provider={provider} onToggle={handleToggleModel1M} />
                  <button
                    type="button"
                    onClick={() => handleToggleModel(model.id)}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="取消启用"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 可用模型 */}
      <SettingsSection
        title="可用模型"
        action={
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={fetchingModels ? () => {
              discoveryRequestRef.current += 1
              cancelNetworkRequests('discovery')
              setFetchingModels(false)
              setFetchResult({ success: false, cancelled: true, message: '模型获取已取消', models: [] })
            } : provider === 'openai-codex' ? loadCodexModels : provider === 'xai' && credentialMode === 'oauth' ? loadXaiModels : handleFetchModels}
            disabled={!fetchingModels && !oauthCredentials && !canDiscoverModels}
            className="h-7 text-xs"
          >
            {fetchingModels ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            <span>{fetchingModels ? '取消获取' : provider === 'openai-codex' ? '读取 Codex 目录' : provider === 'xai' && credentialMode === 'oauth' ? '读取 xAI 目录' : provider === 'ollama' ? '读取本机模型' : '从供应商获取'}</span>
          </Button>
        }
      >
        {/* 拉取结果提示 */}
        {fetchResult && (
          <div role="status" aria-live="polite" className={cn(
            'flex items-center gap-1.5 text-xs px-1',
            fetchResult.cancelled ? 'text-muted-foreground' : fetchResult.success ? 'text-emerald-600' : 'text-destructive'
          )}>
            {fetchResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{fetchResult.message}</span>
          </div>
        )}

        <SettingsCard divided={false}>
          {/* 模型搜索过滤 */}
          {models.filter((m) => !m.enabled).length > 5 && (
            <div className="px-4 pt-3 pb-1">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="搜索可用模型..."
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
          )}

          {/* 可用模型计数 */}
          {models.filter((m) => !m.enabled).length > 0 && (
            <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
              {modelFilter.trim()
                ? `${availableModels.length} / ${models.filter((m) => !m.enabled).length} 个可用模型`
                : `${models.filter((m) => !m.enabled).length} 个可用模型`}
            </div>
          )}

          <ScrollArea className={availableModels.length > 8 ? 'h-[280px]' : undefined}>
            <div className="divide-y divide-border/50">
              {availableModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 px-4 py-2.5 group cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => handleToggleModel(model.id)}
                >
                  <Plus size={14} className="text-muted-foreground flex-shrink-0" />
                  <span className="text-sm text-foreground flex-1">
                    {model.name}
                    {model.name !== model.id && (
                      <span className="text-muted-foreground ml-1">({model.id})</span>
                    )}
                  </span>
                  <Model1MToggle model={model} provider={provider} onToggle={handleToggleModel1M} />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveModel(model.id) }}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="删除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {/* 搜索无结果提示 */}
              {modelFilter.trim() && availableModels.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  未找到匹配的模型
                </div>
              )}

              {/* 无可用模型提示 */}
              {!modelFilter.trim() && models.filter((m) => !m.enabled).length === 0 && models.length > 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  所有模型已启用
                </div>
              )}
            </div>
          </ScrollArea>

          {/* 手动添加模型 */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border/50">
            <Input
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="模型 ID（如 claude-opus-4-6）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                // 中文输入法组词期间的 Enter 是确认候选词，不能当成「添加模型」
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Input
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="显示名称（可选）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className="h-8 w-8 flex-shrink-0"
            >
              <Plus size={18} />
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 退出拦截弹窗 */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              {hasNoModels
                ? '当前尚未启用任何模型，该渠道不会出现在模型选择列表中。'
                : '您填写的内容尚未保存，确定要放弃编辑吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(event) => { event.preventDefault(); void handleDiscard() }}>放弃未保存更改</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void handleSaveAndClose() }}
              disabled={saving || oauthLoggingIn || !name.trim() || (!isEdit && provider !== 'ollama' && !oauthCredentials && !apiKey.trim())}
            >
              {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : '保存并关闭'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
