/**
 * ToolSettings - 工具设置页
 *
 * Chat 模式工具统一管理 tab。
 * 管理联网搜索、生图与自定义工具配置。
 */

import * as React from 'react'
import { useSetAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  XCircle,
  Trash2,
} from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Switch } from '@profer/ui/primitives/switch'
import { Input } from '@profer/ui/primitives/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@profer/ui/primitives/select'
import { SettingsSection, SettingsCard } from './primitives'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'

/** 刷新全局工具列表 atom */
async function refreshChatTools(
  setter: (
    tools: Awaited<ReturnType<typeof window.electronAPI.getChatTools>>,
  ) => void,
): Promise<void> {
  try {
    const tools = await window.electronAPI.getChatTools()
    setter(tools)
  } catch (err) {
    console.error('[ToolSettings] 刷新工具列表失败:', err)
    toast.error('工具列表刷新失败，请重新打开设置重试')
  }
}

/** 联网搜索工具设置区域 */
function WebSearchSettings(): React.ReactElement {
  const [apiKey, setApiKey] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [loadVersion, setLoadVersion] = React.useState(0)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{
    success: boolean
    message: string
  } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)
  const apiKeyId = React.useId()
  const saveFlightRef = React.useRef<Promise<boolean> | null>(null)
  const [saving, setSaving] = React.useState(false)

  // 已保存的 API Key（用于判断是否有变更）
  const savedApiKeyRef = React.useRef('')

  // 从主进程加载当前配置 + 凭据
  React.useEffect(() => {
    setLoading(true)
    setLoadError('')
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('web-search'),
    ])
      .then(([tools, credentials]) => {
        const searchTool = tools.find((t) => t.meta.id === 'web-search')
        if (searchTool) {
          setEnabled(searchTool.enabled)
        }
        if (credentials.apiKey) {
          setApiKey(credentials.apiKey)
          savedApiKeyRef.current = credentials.apiKey
        }
      })
      .catch((err: unknown) => {
        console.error('[联网搜索设置] 加载失败:', err)
        setLoadError('联网搜索设置加载失败')
        toast.error('联网搜索设置加载失败，请重试')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [loadVersion])

  /** 失焦保存 API Key；测试前也复用此结果，失败不测试旧凭据。 */
  const handleBlurSave = React.useCallback(async (): Promise<boolean> => {
    if (saveFlightRef.current) return saveFlightRef.current
    const trimmed = apiKey.trim()
    if (trimmed === savedApiKeyRef.current) return true
    setSaving(true)
    // blur 与点击测试共享在途保存，避免重复提交和测试旧凭据。
    const flight = (async () => {
      try {
        await window.electronAPI.updateChatToolCredentials('web-search', { apiKey: trimmed })
        savedApiKeyRef.current = trimmed
        await refreshChatTools(setChatTools)
        toast.success('联网搜索设置已保存')
        return true
      } catch (error) {
        console.error('[联网搜索设置] 保存失败:', error)
        toast.error('联网搜索设置保存失败，输入已保留，请重新失焦或测试重试')
        return false
      } finally {
        saveFlightRef.current = null
        setSaving(false)
      }
    })()
    saveFlightRef.current = flight
    return flight
  }, [apiKey, setChatTools])

  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState('web-search', {
        enabled: checked,
      })
      setEnabled(checked)
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[联网搜索设置] 切换失败:', error)
      toast.error('联网搜索开关保存失败，请重试')
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      if (!(await handleBlurSave())) return
      const result = await window.electronAPI.testChatTool('web-search')
      setTestResult(result)
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        加载中...
      </div>
    )
  }

  if (loadError) return <div role="alert" className="space-y-3 py-6 text-sm text-destructive"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => setLoadVersion((version) => version + 1)}>重试加载</Button></div>

  return (
    <SettingsSection
      title="联网搜索"
      description="启用后 AI 可以实时搜索互联网获取最新信息"
      action={<Switch aria-label="启用联网搜索" checked={enabled} onCheckedChange={handleToggle} />}
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          {/* 引导说明 */}
          <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm text-muted-foreground">
            <p>
              联网搜索由{' '}
              <span className="font-medium text-foreground">Tavily</span>{' '}
              提供，启用后 AI 可以搜索互联网获取实时信息。
            </p>
            <p className="text-xs">配置步骤：</p>
            <ol className="text-xs list-decimal list-inside space-y-1">
              <li>
                访问{' '}
                <a
                  href="https://tavily.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  Tavily 官网
                  <ExternalLink size={10} />
                </a>{' '}
                注册账号
              </li>
              <li>在控制台获取 API Key（免费额度每月 1000 次搜索）</li>
              <li>将 API Key 填入下方，然后开启开关</li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor={apiKeyId} className="text-sm font-medium">API Key</label>
              <Button
                size="sm"
                variant="outline"
                disabled={testing || !apiKey.trim()}
                onClick={handleTest}
              >
                {testing ? (
                  <>
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                    测试中...
                  </>
                ) : (
                  '测试连接'
                )}
              </Button>
            </div>
            <div className="relative">
              <Input
                id={apiKeyId}
                disabled={testing}
                readOnly={saving}
                type={showApiKey ? 'text' : 'password'}
                placeholder="tvly-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => { void handleBlurSave() }}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={showApiKey ? '隐藏联网搜索 API Key' : '显示联网搜索 API Key'}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {testResult && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}
            >
              {testResult.success ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="mt-0.5 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

type GptImageProvider = 'openai' | 'xai'

const IMAGE_PROVIDER_OPTIONS: Array<{ value: GptImageProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI Images' },
  { value: 'xai', label: 'xAI Grok Imagine' },
]

/** AI 图片生成工具设置区域 */
function GptImageSettings(): React.ReactElement {
  const [provider, setProvider] = React.useState<GptImageProvider>('openai')
  const [mode, setMode] = React.useState<'official' | 'byok'>('official')
  const [apiKey, setApiKey] = React.useState('')
  const [hasApiKey, setHasApiKey] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [loadVersion, setLoadVersion] = React.useState(0)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{
    success: boolean
    message: string
  } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)
  const fieldId = React.useId()
  const saveFlightRef = React.useRef<Promise<void> | null>(null)
  const [saving, setSaving] = React.useState(false)
  const modeSavingRef = React.useRef(false)
  const [modeSaving, setModeSaving] = React.useState(false)
  const savedCredentialsRef = React.useRef({
    provider: 'openai' as GptImageProvider,
    mode: 'official' as 'official' | 'byok',
    baseUrl: '',
    model: '',
  })

  React.useEffect(() => {
    setLoading(true)
    setLoadError('')
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('gpt-image'),
    ])
      .then(([tools, credentials]) => {
        const tool = tools.find((t) => t.meta.id === 'gpt-image')
        if (tool) setEnabled(tool.enabled)
        const loadedProvider = credentials.provider === 'xai' ? 'xai' : 'openai'
        const loadedMode = credentials.mode === 'byok' ? 'byok' : 'official'
        setProvider(loadedProvider)
        setMode(loadedMode)
        setHasApiKey(credentials.hasApiKey === 'true')
        setBaseUrl(credentials.baseUrl || '')
        setModel(credentials.model || '')
        savedCredentialsRef.current = {
          provider: loadedProvider,
          mode: loadedMode,
          baseUrl: credentials.baseUrl || '',
          model: credentials.model || '',
        }
      })
      .catch((err: unknown) => {
        console.error('[图片生成设置] 加载失败:', err)
        setLoadError('图片生成设置加载失败')
        toast.error('图片生成设置加载失败，请重试')
      })
      .finally(() => setLoading(false))
  }, [loadVersion])

  const saveCredentials = React.useCallback(
    async (nextMode = mode): Promise<void> => {
      if (saveFlightRef.current) {
        await saveFlightRef.current
        if (nextMode === mode) return
      }
      const current = {
        provider,
        mode: nextMode,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      }
      const saved = savedCredentialsRef.current
      if (
        !current.apiKey &&
        current.provider === saved.provider &&
        current.mode === saved.mode &&
        current.baseUrl === saved.baseUrl &&
        current.model === saved.model
      )
        return
      setSaving(true)
      const flight = (async () => {
        try {
          await window.electronAPI.updateChatToolCredentials('gpt-image', current)
          savedCredentialsRef.current = {
            provider: current.provider,
            mode: current.mode,
            baseUrl: current.baseUrl,
            model: current.model,
          }
          if (current.apiKey) {
            setHasApiKey(true)
            setApiKey('')
          }
          await refreshChatTools(setChatTools)
        } finally {
          saveFlightRef.current = null
          setSaving(false)
        }
      })()
      saveFlightRef.current = flight
      await flight
    },
    [apiKey, baseUrl, mode, model, provider, setChatTools],
  )

  const handleProviderChange = async (nextProvider: GptImageProvider): Promise<void> => {
    if (modeSavingRef.current || testing || nextProvider === provider) return
    modeSavingRef.current = true
    setModeSaving(true)
    try {
      // 先保存当前 provider，保证切换时不会丢失刚输入但尚未 blur 的内容。
      await saveCredentials()
      const credentials = await window.electronAPI.getChatToolCredentials('gpt-image', nextProvider)
      // provider 选择本身也要立即持久化，否则用户重启设置页后会回到旧 provider。
      await window.electronAPI.updateChatToolCredentials('gpt-image', {
        provider: nextProvider,
        mode,
        baseUrl: credentials.baseUrl || '',
        model: credentials.model || '',
      })
      setProvider(nextProvider)
      setApiKey('')
      setHasApiKey(credentials.hasApiKey === 'true')
      setBaseUrl(credentials.baseUrl || '')
      setModel(credentials.model || '')
      setTestResult(null)
      savedCredentialsRef.current = {
        provider: nextProvider,
        mode,
        baseUrl: credentials.baseUrl || '',
        model: credentials.model || '',
      }
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[图片生成设置] provider 切换失败:', error)
      toast.error('图片 provider 切换失败')
    } finally {
      modeSavingRef.current = false
      setModeSaving(false)
    }
  }

  const handleModeChange = async (
    nextMode: 'official' | 'byok',
  ): Promise<void> => {
    if (modeSavingRef.current || nextMode === mode) return
    modeSavingRef.current = true
    setModeSaving(true)
    setTestResult(null)
    try {
      // saveCredentials 使用当前 provider，并显式覆盖本次切换后的 mode。
      await saveCredentials(nextMode)
      setMode(nextMode)
      toast.success(
        nextMode === 'official'
          ? '已切换为 Profer 官方生图'
          : '已切换为自带 API Key',
      )
    } catch (error) {
      console.error('[图片生成设置] 模式切换失败:', error)
      toast.error('图片生成模式切换保存失败')
    } finally {
      modeSavingRef.current = false
      setModeSaving(false)
    }
  }
  const handleBlurSave = async (): Promise<void> => {
    try {
      await saveCredentials()
      toast.success('AI 图片生成设置已保存')
    } catch (error) {
      console.error('[图片生成设置] 保存失败:', error)
      toast.error('AI 图片生成设置保存失败')
    }
  }
  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState('gpt-image', {
        enabled: checked,
      })
      setEnabled(checked)
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[图片生成设置] 切换失败:', error)
      toast.error('图片生成开关保存失败，请重试')
    }
  }
  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      await saveCredentials()
      setTestResult(await window.electronAPI.testChatTool('gpt-image'))
    } catch (error) {
      toast.error('图片生成配置保存或连接测试失败，请重试')
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTesting(false)
    }
  }
  if (loading)
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        加载中...
      </div>
    )

  if (loadError) return <div role="alert" className="space-y-3 py-6 text-sm text-destructive"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => setLoadVersion((version) => version + 1)}>重试加载</Button></div>

  return (
    <SettingsSection
      title="AI 图片生成"
      description="在 Chat 和已启用工具的 Agent 会话中生成图片或编辑参考图"
      action={<Switch aria-label="启用 AI 图片生成" checked={enabled} onCheckedChange={handleToggle} />}
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          {mode === 'byok' && (
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-provider`} className="text-sm font-medium">图片 provider</label>
              <Select disabled={modeSaving || testing || saving} value={provider} onValueChange={(value) => void handleProviderChange(value as GptImageProvider)}>
                <SelectTrigger id={`${fieldId}-provider`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAGE_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                xAI 官方地址为 https://api.x.ai，默认模型为 grok-imagine-image-2.0。
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              aria-pressed={mode === 'official'}
              disabled={modeSaving || testing}
              onClick={() => void handleModeChange('official')}
              className={`rounded-lg border p-3 text-left transition-colors ${mode === 'official' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
            >
              <p className="text-sm font-medium">Profer 官方生图（推荐）</p>
              <p className="mt-1 text-xs text-muted-foreground">
                固定 GPT Image 2；每次成功生成或编辑 1 张扣 5 积分，失败不扣费。
              </p>
            </button>
            <button
              type="button"
              aria-pressed={mode === 'byok'}
              disabled={modeSaving || testing}
              onClick={() => void handleModeChange('byok')}
              className={`rounded-lg border p-3 text-left transition-colors ${mode === 'byok' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
            >
              <p className="text-sm font-medium">自带 API Key</p>
              <p className="mt-1 text-xs text-muted-foreground">
                使用下方选择的图片 provider；不会扣 Profer 积分。
              </p>
            </button>
          </div>
          {mode === 'official' ? (
            <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-sm text-muted-foreground">
              <p>
                官方服务要求登录 Profer 团队账号；文生图和参考图编辑均固定输出 1
                张图片。
              </p>
              <p className="text-xs">
                模型、价格和上游服务由 Profer 管理，客户端不会保存官方上游密钥。
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                自带 Key
                仅保存在主进程加密配置中。保存后不会再次回显；重新填写会替换原
                Key。
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-key`} className="text-sm font-medium">
                  {provider === 'xai' ? 'xAI API Key' : 'OpenAI API Key'}{' '}
                  {hasApiKey && (
                    <span className="text-xs font-normal text-muted-foreground">
                      （已配置）
                    </span>
                  )}
                </label>
                <div className="relative">
                  <Input
                    id={`${fieldId}-key`}
                    disabled={modeSaving || testing}
                    readOnly={saving}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={hasApiKey ? '填写新 Key 以替换' : provider === 'xai' ? 'xai-...' : 'sk-...'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onBlur={() => void handleBlurSave()}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showApiKey ? '隐藏图片生成 API Key' : '显示图片生成 API Key'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-url`} className="text-sm font-medium">API 地址</label>
                <Input
                  id={`${fieldId}-url`}
                  disabled={modeSaving || testing}
                  readOnly={saving}
                  placeholder={provider === 'xai' ? 'https://api.x.ai' : 'https://api.openai.com'}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => void handleBlurSave()}
                />
                <p className="text-xs text-muted-foreground">
                  {provider === 'xai' ? '留空使用 xAI 官方地址；也支持兼容 Images API 的中转服务。' : '留空使用 OpenAI 官方地址；支持 OpenAI-compatible 代理。'}
                </p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${fieldId}-model`} className="text-sm font-medium">模型</label>
                <Input
                  id={`${fieldId}-model`}
                  disabled={modeSaving || testing}
                  readOnly={saving}
                  placeholder={provider === 'xai' ? 'grok-imagine-image-2.0' : 'gpt-image-2'}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => void handleBlurSave()}
                />
              </div>
            </>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={
                modeSaving || testing || (mode === 'byok' && !hasApiKey && !apiKey.trim())
              }
              onClick={() => void handleTest()}
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" />
                  测试中...
                </>
              ) : (
                '测试连接'
              )}
            </Button>
          </div>
          {testResult && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}
            >
              {testResult.success ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="mt-0.5 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 自定义工具列表区域 */
function CustomToolsSection(): React.ReactElement | null {
  const tools = useAtomValue(chatToolsAtom)
  const setChatTools = useSetAtom(chatToolsAtom)
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const deletingRef = React.useRef(false)

  const customTools = tools.filter((t) => t.meta.category === 'custom')
  if (customTools.length === 0) return null

  const handleToggle = async (
    toolId: string,
    checked: boolean,
  ): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState(toolId, {
        enabled: checked,
      })
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[自定义工具] 切换失败:', error)
      toast.error('自定义工具开关保存失败，请重试')
    }
  }

  const handleDelete = async (
    toolId: string,
    toolName: string,
  ): Promise<void> => {
    if (deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    try {
      await window.electronAPI.deleteCustomChatTool(toolId)
      await refreshChatTools(setChatTools)
      toast.success(`已删除工具: ${toolName}`)
      setDeleteTarget(null)
    } catch (error) {
      console.error('[自定义工具] 删除失败:', error)
      toast.error('删除工具失败')
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return (
    <SettingsSection
      title="自定义工具"
      description="通过 Agent 模式创建的 HTTP API 工具"
    >
      <SettingsCard divided>
        {customTools.map((tool) => (
          <div
            key={tool.meta.id}
            className="flex items-center justify-between p-4"
          >
            <div className="flex-1 min-w-0 mr-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{tool.meta.name}</span>
                {tool.meta.httpConfig && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {tool.meta.httpConfig.method}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {tool.meta.description}
              </p>
              {tool.meta.httpConfig && (
                <p className="text-xs text-muted-foreground/60 mt-0.5 truncate font-mono">
                  {tool.meta.httpConfig.urlTemplate}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                aria-label={`启用${tool.meta.name}`}
                checked={tool.enabled}
                onCheckedChange={(checked) =>
                  handleToggle(tool.meta.id, checked)
                }
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label={`删除工具${tool.meta.name}`}
                onClick={() => setDeleteTarget({ id: tool.meta.id, name: tool.meta.name })}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
      </SettingsCard>
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除自定义工具？</AlertDialogTitle>
            <AlertDialogDescription>将删除「{deleteTarget?.name}」及其配置，此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                if (deleteTarget && !deleting) void handleDelete(deleteTarget.id, deleteTarget.name)
              }}
            >{deleting ? '删除中…' : '删除工具'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

export function ToolSettings(): React.ReactElement {
  return (
    <div className="space-y-8">
      {/* 联网搜索工具 */}
      <WebSearchSettings />

      {/* AI 图片生成工具 */}
      <GptImageSettings />

      {/* 自定义工具 */}
      <CustomToolsSection />
    </div>
  )
}
