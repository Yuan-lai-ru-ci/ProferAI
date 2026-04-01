/**
 * WeChatSettings - 微信 (WeClaw) 集成设置页（UI Stub）
 *
 * 通过 WeClaw 桥接工具连接微信。后端集成尚未实现，当前仅前端 UI。
 * WeClaw: https://github.com/fastclaw-ai/weclaw
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsRow } from './primitives/SettingsRow'
import { SettingsInput } from './primitives/SettingsInput'

/** 安全地用系统浏览器打开链接 */
function openLink(url: string): void {
  window.electronAPI.openExternal(url)
}

/** 可点击的外部链接组件 */
function Link({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-primary hover:underline cursor-pointer"
      onClick={() => openLink(href)}
    >
      {children}
      <ExternalLink className="size-3 flex-shrink-0" />
    </button>
  )
}

export function WeChatSettings(): React.ReactElement {
  const [serverUrl, setServerUrl] = React.useState('http://localhost:8080')
  const [saving, setSaving] = React.useState(false)

  const handleSave = React.useCallback(async () => {
    setSaving(true)
    // TODO: 后端就绪后替换为 IPC 调用
    await new Promise((r) => setTimeout(r, 300))
    toast.success('微信配置已保存（本地缓存）')
    setSaving(false)
  }, [serverUrl])

  const handleTest = React.useCallback(() => {
    toast.info('测试连接功能开发中')
  }, [])

  return (
    <div className="space-y-8">
      {/* 连接状态 */}
      <SettingsSection
        title="微信集成 (WeClaw)"
        description="通过 WeClaw 桥接微信，在微信中控制 Proma Agent"
      >
        <SettingsCard>
          <SettingsRow label="Bridge 状态">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              <span className="text-sm text-muted-foreground">未连接</span>
            </div>
          </SettingsRow>
        </SettingsCard>
        <div className="mt-2 px-3 py-2.5 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
          微信集成正在开发中。WeClaw 是一个独立的桥接工具，需单独安装。
          <button
            type="button"
            className="ml-1 text-amber-800 dark:text-amber-300 underline hover:no-underline cursor-pointer"
            onClick={() => openLink('https://github.com/fastclaw-ai/weclaw')}
          >
            查看 WeClaw 文档 →
          </button>
        </div>
      </SettingsSection>

      {/* 连接配置 */}
      <SettingsSection
        title="连接配置"
        description="配置 WeClaw 桥接服务的连接参数"
      >
        <SettingsCard>
          <SettingsInput
            label="WeClaw 服务地址"
            value={serverUrl}
            onChange={setServerUrl}
            placeholder="http://localhost:8080"
          />
        </SettingsCard>

        <div className="flex items-center gap-3 mt-3">
          <Button size="sm" variant="outline" onClick={handleTest} disabled>
            测试连接
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving && <Loader2 size={14} className="animate-spin mr-1.5" />}
            保存配置
          </Button>
        </div>
      </SettingsSection>

      {/* 安装与配置引导 */}
      <SettingsSection
        title="安装 WeClaw"
        description="WeClaw 安装与配置说明"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-5 text-sm">
            {/* 步骤 1 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">1</span>
                <span className="font-medium text-foreground">安装 WeClaw</span>
              </div>
              <div className="pl-7 space-y-2 text-muted-foreground">
                <p>
                  前往{' '}
                  <Link href="https://github.com/fastclaw-ai/weclaw">WeClaw GitHub</Link>
                  {' '}下载并安装。支持一键安装脚本：
                </p>
                <div className="bg-muted/50 rounded-md p-3 font-mono text-xs">
                  curl -fsSL https://raw.githubusercontent.com/fastclaw-ai/weclaw/main/install.sh | bash
                </div>
              </div>
            </div>

            {/* 步骤 2 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">2</span>
                <span className="font-medium text-foreground">启动 WeClaw 服务</span>
              </div>
              <div className="pl-7 space-y-2 text-muted-foreground">
                <p>启动 WeClaw 后会在终端显示微信登录二维码，用手机扫码登录。</p>
                <div className="bg-muted/50 rounded-md p-3 font-mono text-xs">
                  weclaw serve
                </div>
              </div>
            </div>

            {/* 步骤 3 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">3</span>
                <span className="font-medium text-foreground">连接 Proma</span>
              </div>
              <p className="pl-7 text-muted-foreground">
                WeClaw 启动后默认监听{' '}
                <code className="bg-muted/50 px-1.5 py-0.5 rounded text-xs text-foreground/80">http://localhost:8080</code>
                。确认上方服务地址与 WeClaw 一致，然后点击「连接」即可。
              </p>
            </div>

            {/* 提示 */}
            <div className="pl-7 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              WeClaw 支持多种 AI Agent 对接模式（ACP/CLI/HTTP），Proma 将通过 HTTP 模式与 WeClaw 通信。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
