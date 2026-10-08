/**
 * VoiceInputSettings — 语音输入设置
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, ExternalLink, Loader2, TestTube2, Mic, MicOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@profer/ui/primitives/collapsible'
import {
  SettingsCard,
  SettingsInput,
  SettingsSecretInput,
  SettingsSection,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
  SECTION_DESCRIPTION_CLASS,
  SECTION_TITLE_CLASS,
} from './primitives'
import type { VoiceDictationSettings, MicPermissionResult } from '../../../types'
import { voiceDictationSettingsAtom } from '@/atoms/voice-dictation-atoms'
import { shortcutOverridesAtom } from '@/atoms/shortcut-atoms'
import { getAcceleratorDisplay, getActiveAccelerator } from '@/lib/shortcut-registry'
import { IntegrationSettingsFeedback, useIntegrationAction } from './IntegrationSettingsFeedback'

const ENDPOINT_OPTIONS = [
  { value: 'async', label: '双向流式优化版' },
  { value: 'duplex', label: '双向流式标准版' },
]

const OUTPUT_OPTIONS = [
  { value: 'auto', label: '自动：Profer 激活时写入对话框，否则写入当前光标' },
  { value: 'clipboard', label: '仅复制到剪贴板' },
  { value: 'profer-input', label: '仅写入 Profer 输入框' },
]

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh-CN', label: '中文普通话' },
  { value: 'en-US', label: '英语' },
  { value: 'yue-CN', label: '粤语' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
]

const VOLCENGINE_SPEECH_SERVICE_URL = 'https://console.volcengine.com/speech/service/'

export function VoiceInputSettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<VoiceDictationSettings | null>(null)
  const draftRef = React.useRef<VoiceDictationSettings | null>(null)
  const savedRef = React.useRef<VoiceDictationSettings | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [saveError, setSaveError] = React.useState('')
  const [dirty, setDirty] = React.useState(false)
  const [micError, setMicError] = React.useState('')
  const { busy: saving, run: runSave } = useIntegrationAction()
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const voiceShortcut = React.useMemo(
    () => getActiveAccelerator('voice-dictation'),
    [shortcutOverrides],
  )
  const voiceShortcutDisplay = getAcceleratorDisplay(voiceShortcut) || '快捷键已禁用'
  const setVoiceDictationSettings = useSetAtom(voiceDictationSettingsAtom)
  const [testing, setTesting] = React.useState(false)
  const [micPermission, setMicPermission] = React.useState<MicPermissionResult | null>(null)
  const [requestingPermission, setRequestingPermission] = React.useState(false)

  const refreshMicPermission = React.useCallback(async () => {
    setMicError('')
    try {
      const result = await window.electronAPI.checkMicrophonePermission()
      setMicPermission(result)
    } catch (error) {
      console.error('[语音输入] 检查麦克风权限失败:', error)
      setMicError('无法检查麦克风权限，请重试。')
    }
  }, [])

  const loadSettings = React.useCallback(async () => {
    setLoadError('')
    try {
      const loaded = await window.electronAPI.getVoiceDictationSettings()
      draftRef.current = loaded
      savedRef.current = loaded
      setSettings(loaded)
      setVoiceDictationSettings(loaded)
      setDirty(false)
    } catch { setLoadError('加载语音输入设置失败，未读取到配置。请重试。') }
  }, [setVoiceDictationSettings])

  React.useEffect(() => {
    void loadSettings()
    void refreshMicPermission()
  }, [loadSettings, refreshMicPermission])

  const handleRequestMicPermission = React.useCallback(async () => {
    setRequestingPermission(true)
    try {
      const result = await window.electronAPI.requestMicrophonePermission()
      setMicPermission(result)
      if (result.status === 'granted') {
        toast.success('麦克风权限已授权')
      } else if (result.status === 'denied') {
        toast.error('麦克风权限已被拒绝，请在系统设置中允许')
      }
    } catch (error) {
      console.error('[语音输入] 请求麦克风权限失败:', error)
      toast.error('请求麦克风权限失败')
    } finally {
      setRequestingPermission(false)
    }
  }, [])

  const update = React.useCallback((updates: Partial<VoiceDictationSettings>) => {
    if (!draftRef.current) return
    const next = { ...draftRef.current, ...updates, provider: 'doubao' as const }
    draftRef.current = next
    setSettings(next)
    setDirty(true)
  }, [])

  const save = React.useCallback(() => runSave(async () => {
    const snapshot = draftRef.current
    if (!snapshot) return
    setSaveError('')
    try {
      const saved = await window.electronAPI.updateVoiceDictationSettings(snapshot)
      savedRef.current = saved
      setVoiceDictationSettings(saved)
      // 保存期间继续输入时，响应只更新已保存快照，不覆盖更新的草稿。
      if (draftRef.current === snapshot) {
        draftRef.current = saved
        setSettings(saved)
        setDirty(false)
      }
      toast.success('语音输入设置已保存')
      window.electronAPI.reregisterGlobalShortcuts().catch(() => setSaveError('设置已保存，但快捷键注册失败。请重试。'))
    } catch { setSaveError('保存失败，输入已保留。请重试保存。') }
  }), [runSave, setVoiceDictationSettings])

  const discard = () => {
    if (!savedRef.current) return
    draftRef.current = savedRef.current
    setSettings(savedRef.current)
    setDirty(false)
    setSaveError('')
  }

  const handleTest = React.useCallback(async () => {
    if (!settings) return
    setTesting(true)
    try {
      const result = await window.electronAPI.testVoiceDictationConnection(settings)
      if (result.success) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      toast.error(`测试连接失败: ${message}`)
    } finally {
      setTesting(false)
    }
  }, [settings])

  if (!settings) {
    return <IntegrationSettingsFeedback loading={!loadError} message={loadError || '正在加载语音输入设置…'} onRetry={loadError ? () => void loadSettings() : undefined} />
  }

  return (
    <div className="space-y-6 min-w-0">
      <Collapsible defaultOpen={false}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <CollapsibleTrigger
            className="group flex min-w-0 flex-1 items-start gap-2 text-left"
            aria-label="展开或收起语音输入设置"
          >
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            <span className="min-w-0">
              <span role="heading" aria-level={3} className={SECTION_TITLE_CLASS}>语音输入（豆包流式）</span>
              <span className={SECTION_DESCRIPTION_CLASS}>启用后会显示在 Chat、Agent 与便签输入工具栏中，也可通过全局快捷键唤起浮窗。</span>
            </span>
          </CollapsibleTrigger>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing || saving || !settings.appId.trim() || !settings.accessToken.trim() || !settings.resourceId.trim()}
          >
            {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <TestTube2 className="mr-1.5 size-3.5" />}
            测试连接
          </Button>
        </div>
        <CollapsibleContent className="mt-5 space-y-6">
          <SettingsSection title="连接配置" description="填写火山引擎豆包流式语音识别凭据，并确认麦克风权限。">
            <div className="rounded-lg bg-muted/55 px-4 py-3 text-sm text-muted-foreground shadow-sm">
              <div className="mb-1.5 font-medium text-foreground">配置方式</div>
              <div className="space-y-1 leading-relaxed">
                <p>
                  打开
                  <a
                    href={VOLCENGINE_SPEECH_SERVICE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mx-1 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    火山引擎语音服务控制台
                    <ExternalLink className="size-3" />
                  </a>
                  ，选择旧版服务界面。
                </p>
                <p>找到“豆包流式语音识别模型2.0”类目，选择已申请对应权限的应用。</p>
                <p>在页面下方对照填写 APP ID、Access Token 和 Resource ID，然后点击“测试连接”。</p>
              </div>
            </div>

            {/* 麦克风权限状态 */}
            {micPermission && (
              <div className="rounded-lg border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3" role="status">
                  <div className="flex items-center gap-3">
                    {micPermission.status === 'granted' ? (
                      <Mic className="size-4 text-green-500" />
                    ) : micPermission.status === 'denied' ? (
                      <MicOff className="size-4 text-destructive" />
                    ) : micPermission.status === 'not-determined' ? (
                      <Mic className="size-4 text-amber-500" />
                    ) : (
                      <Mic className="size-4 text-muted-foreground" />
                    )}
                    <div>
                      <span className="font-medium text-foreground">麦克风权限</span>
                      <span className="ml-2 text-muted-foreground">
                        {micPermission.status === 'granted'
                          ? '已授权，语音输入可正常使用'
                          : micPermission.status === 'denied'
                          ? '已被系统阻止，请在系统设置中允许 Profer 访问麦克风'
                          : micPermission.status === 'not-determined'
                          ? '未授权，使用语音输入前需要先授权'
                          : '当前系统不支持预检，录音时将自动弹出权限请求'}
                      </span>
                    </div>
                  </div>
                  {(micPermission.status === 'not-determined' || micPermission.status === 'denied') && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRequestMicPermission}
                      disabled={requestingPermission}
                    >
                      {requestingPermission ? (
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      ) : micPermission.status === 'not-determined' ? (
                        <Mic className="mr-1.5 size-3.5" />
                      ) : (
                        <MicOff className="mr-1.5 size-3.5" />
                      )}
                      {micPermission.status === 'not-determined' ? '允许麦克风权限' : '重新请求权限'}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {micError && <IntegrationSettingsFeedback message={micError} onRetry={() => void refreshMicPermission()} />}
            <SettingsCard>
              <SettingsToggle
                label="启用语音输入"
                description={`启用后显示输入工具栏的麦克风按钮，也可使用 ${voiceShortcutDisplay} 打开语音输入浮窗，再按一次停止；可在快捷键管理中修改。`}
                checked={settings.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
              <SettingsInput
                label="豆包 APP ID"
                description="对应 X-Api-App-Key，请填写火山引擎控制台中的 APP ID。"
                value={settings.appId}
                onChange={(appId) => update({ appId })}
                placeholder="请输入 APP ID"
              />
              <SettingsSecretInput
                label="豆包 Access Token"
                description="对应 X-Api-Access-Key，保存时会加密。"
                value={settings.accessToken}
                onChange={(accessToken) => update({ accessToken })}
                placeholder="请输入 Access Token"
              />
              <SettingsInput
                label="Resource ID"
                description="默认使用豆包语音识别模型 2.0 小时版。"
                value={settings.resourceId}
                onChange={(resourceId) => update({ resourceId })}
                placeholder="volc.seedasr.sauc.duration"
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="识别与输出" description="选择连接模式、识别语言和热词，再指定转写文字的输出位置。修改后点击保存设置。">
            <SettingsCard>
              <SettingsSelect
                label="连接模式"
                description="优化版只在结果变化时返回新包，实时体验更好。"
                value={settings.endpointMode}
                onValueChange={(endpointMode) => update({ endpointMode: endpointMode as VoiceDictationSettings['endpointMode'] })}
                options={ENDPOINT_OPTIONS}
              />
              <SettingsSelect
                label="识别语言"
                description="自动识别适合中英文和方言混合输入。"
                value={settings.language || 'auto'}
                onValueChange={(language) => update({ language: language === 'auto' ? '' : language })}
                options={LANGUAGE_OPTIONS}
              />
              <SettingsTextarea
                label="自定义热词"
                description="每行或逗号分隔一个词，会在本次识别请求中直传给豆包，用于改善产品名、技术词和人名识别。"
                value={settings.customHotwords}
                onChange={(customHotwords) => update({ customHotwords })}
                placeholder={"Profer\nJotai\nShadcnUI\nClaude Code"}
                minHeight={112}
              />
              <SettingsSelect
                label="输出方式"
                description="默认写入当前光标位置；如果唤起时 Profer 是当前激活窗口，会写入当前 Chat 或 Agent 输入框。自动粘贴失败时会保留到剪贴板。"
                value={settings.outputMode}
                onValueChange={(outputMode) => update({ outputMode: outputMode as VoiceDictationSettings['outputMode'] })}
                options={OUTPUT_OPTIONS}
              />
            </SettingsCard>
          </SettingsSection>

          {saveError && <IntegrationSettingsFeedback loading={saving} message={saveError} onRetry={() => void save()} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving && <Loader2 className="size-4 animate-spin" />}{saving ? '正在保存…' : '保存设置'}
            </Button>
            <Button size="sm" variant="ghost" onClick={discard} disabled={saving || !dirty}>撤销修改</Button>
            <p role="status" className="text-xs text-muted-foreground">{dirty ? '有未保存的修改；测试连接使用当前草稿。' : '设置已保存'}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
