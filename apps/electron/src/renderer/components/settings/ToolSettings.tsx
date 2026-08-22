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
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { SettingsSection, SettingsCard } from './primitives'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'

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
  }
}

/** 联网搜索工具设置区域 */
function WebSearchSettings(): React.ReactElement {
  const [apiKey, setApiKey] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{
    success: boolean
    message: string
  } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)

  // 已保存的 API Key（用于判断是否有变更）
  const savedApiKeyRef = React.useRef('')

  // 从主进程加载当前配置 + 凭据
  React.useEffect(() => {
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
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  /** 静默保存 API Key（blur 时触发） */
  const handleBlurSave = React.useCallback(async (): Promise<void> => {
    const trimmed = apiKey.trim()
    if (trimmed === savedApiKeyRef.current) return
    try {
      await window.electronAPI.updateChatToolCredentials('web-search', {
        apiKey: trimmed,
      })
      savedApiKeyRef.current = trimmed
      // 刷新全局工具列表（available 状态可能变化）
      await refreshChatTools(setChatTools)
      toast.success('联网搜索设置已保存')
    } catch (error) {
      console.error('[联网搜索设置] 保存失败:', error)
    }
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
    }
  }

  const handleTest = async (): Promise<void> => {
    // 先保存可能的变更
    const trimmed = apiKey.trim()
    if (trimmed !== savedApiKeyRef.current) {
      try {
        await window.electronAPI.updateChatToolCredentials('web-search', {
          apiKey: trimmed,
        })
        savedApiKeyRef.current = trimmed
        await refreshChatTools(setChatTools)
      } catch (error) {
        console.error('[联网搜索设置] 保存失败:', error)
      }
    }

    setTesting(true)
    setTestResult(null)
    try {
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

  return (
    <SettingsSection
      title="联网搜索"
      description="启用后 AI 可以实时搜索互联网获取最新信息"
      action={<Switch checked={enabled} onCheckedChange={handleToggle} />}
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
              <label className="text-sm font-medium">API Key</label>
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
                type={showApiKey ? 'text' : 'password'}
                placeholder="tvly-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={handleBlurSave}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {testResult && (
            <div
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

/** GPT Image 生图工具设置区域 */
function GptImageSettings(): React.ReactElement {
  const [mode, setMode] = React.useState<'official' | 'byok'>('official')
  const [apiKey, setApiKey] = React.useState('')
  const [hasApiKey, setHasApiKey] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{
    success: boolean
    message: string
  } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)
  const savedCredentialsRef = React.useRef({
    mode: 'official',
    baseUrl: '',
    model: '',
  })

  React.useEffect(() => {
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('gpt-image'),
    ])
      .then(([tools, credentials]) => {
        const tool = tools.find((t) => t.meta.id === 'gpt-image')
        if (tool) setEnabled(tool.enabled)
        const loadedMode = credentials.mode === 'byok' ? 'byok' : 'official'
        setMode(loadedMode)
        setHasApiKey(credentials.hasApiKey === 'true')
        setBaseUrl(credentials.baseUrl || '')
        setModel(credentials.model || '')
        savedCredentialsRef.current = {
          mode: loadedMode,
          baseUrl: credentials.baseUrl || '',
          model: credentials.model || '',
        }
      })
      .catch((err: unknown) => console.error('[GPT Image 设置] 加载失败:', err))
      .finally(() => setLoading(false))
  }, [])

  const saveCredentials = React.useCallback(
    async (nextMode = mode): Promise<void> => {
      const current = {
        mode: nextMode,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      }
      const saved = savedCredentialsRef.current
      if (
        !current.apiKey &&
        current.mode === saved.mode &&
        current.baseUrl === saved.baseUrl &&
        current.model === saved.model
      )
        return
      await window.electronAPI.updateChatToolCredentials('gpt-image', current)
      savedCredentialsRef.current = {
        mode: current.mode,
        baseUrl: current.baseUrl,
        model: current.model,
      }
      if (current.apiKey) {
        setHasApiKey(true)
        setApiKey('')
      }
      await refreshChatTools(setChatTools)
    },
    [apiKey, baseUrl, mode, model, setChatTools],
  )

  const handleModeChange = async (
    nextMode: 'official' | 'byok',
  ): Promise<void> => {
    setMode(nextMode)
    setTestResult(null)
    try {
      await saveCredentials(nextMode)
      toast.success(
        nextMode === 'official'
          ? '已切换为 Profer 官方生图'
          : '已切换为自带 OpenAI Key',
      )
    } catch (error) {
      console.error('[GPT Image 设置] 切换模式失败:', error)
      toast.error('模式切换保存失败')
    }
  }
  const handleBlurSave = async (): Promise<void> => {
    try {
      await saveCredentials()
      toast.success('GPT Image 设置已保存')
    } catch (error) {
      console.error('[GPT Image 设置] 保存失败:', error)
      toast.error('GPT Image 设置保存失败')
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
      console.error('[GPT Image 设置] 切换失败:', error)
    }
  }
  const handleTest = async (): Promise<void> => {
    try {
      await saveCredentials()
    } catch (error) {
      console.error('[GPT Image 设置] 测试前保存失败:', error)
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.electronAPI.testChatTool('gpt-image'))
    } catch (error) {
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

  return (
    <SettingsSection
      title="GPT Image"
      description="在 Chat 和已启用工具的 Agent 会话中生成图片或编辑参考图"
      action={<Switch checked={enabled} onCheckedChange={handleToggle} />}
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
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
              onClick={() => void handleModeChange('byok')}
              className={`rounded-lg border p-3 text-left transition-colors ${mode === 'byok' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
            >
              <p className="text-sm font-medium">自带 OpenAI Key</p>
              <p className="mt-1 text-xs text-muted-foreground">
                使用自己的 OpenAI-compatible 服务；不会扣 Profer 积分。
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
                <label className="text-sm font-medium">
                  API Key{' '}
                  {hasApiKey && (
                    <span className="text-xs font-normal text-muted-foreground">
                      （已配置）
                    </span>
                  )}
                </label>
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={hasApiKey ? '填写新 Key 以替换' : 'sk-...'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onBlur={() => void handleBlurSave()}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">API 地址</label>
                <Input
                  placeholder="https://api.openai.com"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => void handleBlurSave()}
                />
                <p className="text-xs text-muted-foreground">
                  留空使用 OpenAI 官方地址；支持 OpenAI-compatible 代理。
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">模型</label>
                <Input
                  placeholder="gpt-image-2"
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
                testing || (mode === 'byok' && !hasApiKey && !apiKey.trim())
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
    }
  }

  const handleDelete = async (
    toolId: string,
    toolName: string,
  ): Promise<void> => {
    try {
      await window.electronAPI.deleteCustomChatTool(toolId)
      await refreshChatTools(setChatTools)
      toast.success(`已删除工具: ${toolName}`)
    } catch (error) {
      console.error('[自定义工具] 删除失败:', error)
      toast.error('删除工具失败')
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
                checked={tool.enabled}
                onCheckedChange={(checked) =>
                  handleToggle(tool.meta.id, checked)
                }
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(tool.meta.id, tool.meta.name)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

export function ToolSettings(): React.ReactElement {
  return (
    <div className="space-y-8">
      {/* 联网搜索工具 */}
      <WebSearchSettings />

      {/* GPT Image 生图工具 */}
      <GptImageSettings />

      {/* 自定义工具 */}
      <CustomToolsSection />
    </div>
  )
}
