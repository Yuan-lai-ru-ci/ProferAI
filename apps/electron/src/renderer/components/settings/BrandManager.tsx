/**
 * BrandManager - 品牌定制设置
 *
 * 支持自定义应用名称、品牌色、Logo 上传。
 * Phase 1: 运行时品牌注入，存储在 localStorage。
 * Phase 2: 扩展到工作区级品牌同步。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Paintbrush, Type, Upload, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './primitives'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { activeBrandAtom } from '@/atoms/team-atoms'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import type { WorkspaceBrand } from '@proma/shared'

const STORAGE_KEY = 'proma-brand-overrides'

/** 从 localStorage 读取持久化的品牌配置 */
function loadBrand(): WorkspaceBrand | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as WorkspaceBrand) : null
  } catch {
    return null
  }
}

/** 持久化品牌配置到 localStorage */
function saveBrand(brand: WorkspaceBrand | null): void {
  if (brand) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(brand))
  } else {
    localStorage.removeItem(STORAGE_KEY)
  }
}

/** 将品牌配置应用到 DOM（CSS 变量和文档标题） */
function applyBrandToDOM(brand: WorkspaceBrand | null): void {
  const root = document.documentElement

  if (brand?.primaryColor) {
    // primaryColor 格式: "220 15% 30%" (HSL 三个值空格分隔)
    root.style.setProperty('--brand-primary', brand.primaryColor)
    root.style.setProperty('--primary', brand.primaryColor)
  } else {
    root.style.removeProperty('--brand-primary')
    root.style.removeProperty('--primary')
  }

  if (brand?.appName) {
    document.title = brand.appName
  } else {
    document.title = 'Profer'
  }

  if (brand?.customCss) {
    let styleEl = document.getElementById('brand-custom-css')
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'brand-custom-css'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = brand.customCss
  } else {
    const styleEl = document.getElementById('brand-custom-css')
    if (styleEl) styleEl.remove()
  }

  if (brand?.logoUrl) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = brand.logoUrl
  }
}

export function BrandManager(): React.ReactElement {
  const [, setActiveBrand] = useAtom(activeBrandAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [brand, setBrand] = React.useState<WorkspaceBrand>(() => loadBrand() ?? {})
  const [previewColor, setPreviewColor] = React.useState(brand.primaryColor ?? '')

  React.useEffect(() => {
    const saved = loadBrand()
    if (saved) {
      setBrand(saved)
      setActiveBrand(saved)
      applyBrandToDOM(saved)
    }
  }, [setActiveBrand])

  const handleSave = React.useCallback(() => {
    saveBrand(brand)
    setActiveBrand(brand)
    applyBrandToDOM(brand)
    // 通知主进程：持久化品牌到工作区索引 + 更新窗口图标
    if (currentWorkspaceId) {
      window.electronAPI.team.setWorkspaceBrand(currentWorkspaceId, brand).catch(() => {})
    }
    toast.success('品牌配置已保存')
  }, [brand, setActiveBrand, currentWorkspaceId])

  const handleReset = React.useCallback(() => {
    saveBrand(null)
    setBrand({})
    setActiveBrand(null)
    setPreviewColor('')
    applyBrandToDOM(null)
    // 通知主进程：重置品牌
    if (currentWorkspaceId) {
      window.electronAPI.team.setWorkspaceBrand(currentWorkspaceId, {}).catch(() => {})
    }
    toast.success('品牌配置已重置')
  }, [setActiveBrand, currentWorkspaceId])

  const handleLogoUpload = React.useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/svg+xml,image/jpeg'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        setBrand((prev) => ({ ...prev, logoUrl: reader.result as string }))
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }, [])

  return (
    <div className="space-y-6">
      <SettingsSection title="品牌定制" description="自定义应用名称、品牌色和 Logo。更改即时预览，保存后生效。">
        <SettingsCard>
          <SettingsRow
            label="应用名称"
            description="替换窗口标题和关于页面中的 'Proma' 字样"
            icon={<Type size={16} />}
          >
            <div className="flex items-center gap-2">
              <Input
                value={brand.appName ?? ''}
                placeholder="Proma"
                onChange={(e) => setBrand((prev) => ({ ...prev, appName: e.target.value || undefined }))}
                className="w-48"
              />
            </div>
          </SettingsRow>

          <SettingsRow
            label="品牌色"
            description="主色调，影响侧边栏、按钮等 UI 元素（HSL 格式，如 220 15% 30%）"
            icon={<Paintbrush size={16} />}
          >
            <div className="flex items-center gap-2">
              <Input
                value={brand.primaryColor ?? ''}
                placeholder="默认"
                onChange={(e) => {
                  const val = e.target.value
                  setBrand((prev) => ({ ...prev, primaryColor: val || undefined }))
                  setPreviewColor(val)
                  // 即时预览
                  if (val) {
                    document.documentElement.style.setProperty('--primary', val)
                  } else {
                    document.documentElement.style.removeProperty('--primary')
                  }
                }}
                className="w-48 font-mono text-sm"
              />
              {previewColor && (
                <div
                  className="w-6 h-6 rounded border"
                  style={{ backgroundColor: `hsl(${previewColor})` }}
                />
              )}
            </div>
          </SettingsRow>

          <SettingsRow
            label="Logo 上传"
            description="替换应用图标和侧边栏 Logo（支持 PNG / SVG / JPEG）"
            icon={<Upload size={16} />}
          >
            <div className="flex items-center gap-3">
              {brand.logoUrl && (
                <img
                  src={brand.logoUrl}
                  alt="Logo 预览"
                  className="w-8 h-8 rounded object-contain"
                />
              )}
              <Button variant="outline" size="sm" onClick={handleLogoUpload}>
                <Upload size={14} className="mr-1" />
                选择图片
              </Button>
              {brand.logoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBrand((prev) => ({ ...prev, logoUrl: undefined }))}
                >
                  移除
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave}>保存品牌配置</Button>
        <Button variant="outline" onClick={handleReset}>
          <RotateCcw size={14} className="mr-1" />
          重置为默认
        </Button>
      </div>
    </div>
  )
}
