/**
 * FeedbackSettings — 意见箱页面
 *
 * 向 Profer 服务端提交意见反馈，无需登录态。
 * 也展示提交历史（如果有团队登录态）。
 */
import * as React from 'react'
import { Send, CheckCircle2, AlertCircle, Loader2, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection, SettingsCard } from './primitives'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'general', label: '💬 通用反馈' },
  { value: 'feature', label: '💡 功能建议' },
  { value: 'bug', label: '🐛 BUG 报告' },
  { value: 'other', label: '📝 其他' },
]

type SubmitState = 'idle' | 'submitting' | 'success' | 'error'

export function FeedbackSettings(): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [contact, setContact] = React.useState('')
  const [category, setCategory] = React.useState('general')
  const [submitState, setSubmitState] = React.useState<SubmitState>('idle')
  const [errorMsg, setErrorMsg] = React.useState('')

  const getBaseUrl = React.useCallback(async (): Promise<string | null> => {
    try {
      const auth = await window.electronAPI.auth.getTeamAuth()
      return auth?.baseUrl ?? null
    } catch {
      return null
    }
  }, [])

  const handleSubmit = React.useCallback(async () => {
    if (!content.trim()) return

    setSubmitState('submitting')
    setErrorMsg('')

    try {
      const baseUrl = await getBaseUrl()
      if (!baseUrl) {
        setErrorMsg('未连接到 Profer 服务端，请先在通用设置中登录团队账号。')
        setSubmitState('error')
        return
      }

      const resp = await fetch(`${baseUrl}/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          contact: contact.trim() || undefined,
          category,
          pageUrl: 'proma://settings/feedback',
        }),
      })

      if (!resp.ok) {
        const d = await resp.json().catch(() => ({ error: '请求失败' }))
        throw new Error(d.error || `请求失败 (${resp.status})`)
      }

      setSubmitState('success')
      setContent('')
      setContact('')
      setCategory('general')
    } catch (err: any) {
      setErrorMsg(err.message || '提交失败，请稍后重试')
      setSubmitState('error')
    }
  }, [content, contact, category, getBaseUrl])

  const handleReset = React.useCallback(() => {
    setSubmitState('idle')
    setErrorMsg('')
  }, [])

  return (
    <div>
      <SettingsSection title="意见箱" description="告诉我们你的想法、建议或遇到的问题。每一条反馈我们都会认真阅读。">
        <SettingsCard>
          {submitState === 'success' ? (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <CheckCircle2 size={40} className="text-green-500" />
              <p className="text-base font-medium text-foreground">感谢你的反馈！</p>
              <p className="text-sm text-muted-foreground">我们已收到你的意见，会尽快处理。</p>
              <Button variant="outline" size="sm" onClick={handleReset} className="mt-2">
                继续提交
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-1">
              {/* 错误提示 */}
              {submitState === 'error' && errorMsg && (
                <Alert variant="destructive">
                  <AlertCircle size={16} />
                  <AlertDescription>{errorMsg}</AlertDescription>
                </Alert>
              )}

              {/* 意见内容 */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feedback-content" className="text-sm font-medium">
                  意见内容 <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="feedback-content"
                  placeholder="请详细描述你的想法、建议或遇到的问题..."
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={5}
                  maxLength={5000}
                  disabled={submitState === 'submitting'}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground self-end">
                  {content.length}/5000
                </p>
              </div>

              {/* 分类 */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feedback-category" className="text-sm font-medium">分类</Label>
                <Select value={category} onValueChange={setCategory} disabled={submitState === 'submitting'}>
                  <SelectTrigger id="feedback-category" className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 联系方式（选填） */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feedback-contact" className="text-sm font-medium">
                  联系方式 <span className="text-muted-foreground font-normal">（选填）</span>
                </Label>
                <Input
                  id="feedback-contact"
                  placeholder="邮箱或微信号，方便我们联系你"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  maxLength={200}
                  disabled={submitState === 'submitting'}
                />
              </div>

              {/* 提交按钮 */}
              <Button
                onClick={handleSubmit}
                disabled={!content.trim() || submitState === 'submitting'}
                className="self-start mt-2"
              >
                {submitState === 'submitting' ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-1.5" />
                    提交中...
                  </>
                ) : (
                  <>
                    <Send size={16} className="mr-1.5" />
                    提交反馈
                  </>
                )}
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 底部说明 */}
      <SettingsSection title="" description="">
        <div className="flex items-start gap-2.5 text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
          <MessageSquareText size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            你的意见将发送到 Profer 服务端。如需查看历史反馈或追踪处理进度，请联系管理员。提交内容请勿包含敏感信息（如密码、密钥等）。
          </span>
        </div>
      </SettingsSection>
    </div>
  )
}
