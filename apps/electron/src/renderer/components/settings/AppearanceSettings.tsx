/**
 * AppearanceSettings - 外观设置页
 *
 * 主题模式切换与本地皮肤管理（浅色/深色/跟随系统）。
 * 通过 Jotai atom 管理状态，持久化到 ~/.profer/settings.json。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  themeStyleAtom,
  systemIsDarkAtom,
  applyThemeToDOM,
  skinsAtom,
  refreshSkinRegistry,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  applyMarkdownFontSizeToDOM,
} from '@/atoms/markdown-font-size'
import {
  uiScaleAtom,
  UI_SCALE_OPTIONS,
} from '@/atoms/ui-scale'
import { cn } from '@/lib/utils'
import { SkinManager } from './SkinManager'
import { detectIsWindows } from '@profer/ui'
import type { ThemeMode, ThemeStyle, MarkdownFontSize, UiScale, SkinInfo } from '../../../types'

// ===== Logo 资源导入（用于图标选择器） =====
import proferBlackLogo from '@/assets/bots/profer-logos/profer-black.png'
import proferWhiteLogo from '@/assets/bots/profer-logos/profer-white.png'
import proferBlueLogo from '@/assets/bots/profer-logos/profer-blue.png'
import proferPurpleLogo from '@/assets/bots/profer-logos/profer-purple.png'
import proferGradientLogo from '@/assets/bots/profer-logos/profer-gradient.png'
import proferCoralLogo from '@/assets/bots/profer-logos/profer-coral.png'
import proferVeriPeriLogo from '@/assets/bots/profer-logos/profer-veri-peri.png'
import proferVivaMagentaLogo from '@/assets/bots/profer-logos/profer-viva-magenta.png'
import proferMochaMousseLogo from '@/assets/bots/profer-logos/profer-mocha-mousse.png'
import proferEmeraldLogo from '@/assets/bots/profer-logos/profer-emerald.png'
import profer8bitLogo from '@/assets/bots/profer-logos/profer-8bit.png'
import proferCyberpunkLogo from '@/assets/bots/profer-logos/profer-cyberpunk.png'
import proferFuturisticLogo from '@/assets/bots/profer-logos/profer-futuristic.png'

// ===== 主题预览图片导入 =====
/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]



/** 图标变体定义 */
interface IconVariant {
  id: string
  name: string
  src: string
  previewBg: string
}

const ICON_VARIANTS: readonly IconVariant[] = [
  { id: 'default', name: '默认', src: '', previewBg: 'bg-neutral-900' },
  { id: 'black', name: '经典黑', src: proferBlackLogo, previewBg: 'bg-neutral-900' },
  { id: 'white', name: '纯白版', src: proferWhiteLogo, previewBg: 'bg-white' },
  { id: 'blue', name: '品牌蓝', src: proferBlueLogo, previewBg: 'bg-blue-900' },
  { id: 'purple', name: '紫色版', src: proferPurpleLogo, previewBg: 'bg-purple-900' },
  { id: 'gradient', name: '渐变版', src: proferGradientLogo, previewBg: 'bg-gradient-to-br from-blue-600 to-purple-600' },
  { id: 'coral', name: '珊瑚橘', src: proferCoralLogo, previewBg: 'bg-[#FF6F61]' },
  { id: 'veri-peri', name: '长春花蓝', src: proferVeriPeriLogo, previewBg: 'bg-[#6667AB]' },
  { id: 'viva-magenta', name: '非凡洋红', src: proferVivaMagentaLogo, previewBg: 'bg-[#BB2649]' },
  { id: 'mocha-mousse', name: '摩卡慕斯', src: proferMochaMousseLogo, previewBg: 'bg-[#A47764]' },
  { id: 'emerald', name: '翡翠绿', src: proferEmeraldLogo, previewBg: 'bg-[#009473]' },
  { id: '8bit', name: '8bit 像素', src: profer8bitLogo, previewBg: 'bg-[#1a1a2e]' },
  { id: 'cyberpunk', name: '赛博朋克', src: proferCyberpunkLogo, previewBg: 'bg-[#0d0221]' },
  { id: 'futuristic', name: '未来质感', src: proferFuturisticLogo, previewBg: 'bg-[#4a4a4a]' },
] as const

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘= 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

// macOS 专属的 Dock 图标切换暂不对外展示；保留实现，后续可直接恢复。
const SHOW_MACOS_SETTINGS = false

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [themeStyle, setThemeStyle] = useAtom(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [skins, setSkins] = useAtom(skinsAtom)
  const [deleteTarget, setDeleteTarget] = React.useState<SkinInfo | null>(null)
  const [conflict, setConflict] = React.useState<{ path: string; kind: 'zip' | 'folder' } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [skinLoading, setSkinLoading] = React.useState(true)
  const [skinError, setSkinError] = React.useState<string | null>(null)
  const skinRequestRef = React.useRef(0)
  const [error, setError] = React.useState<string | null>(null)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)
  // 界面大小控件仅面向移动端/浏览器端（UiScaleContainer 等比缩放）；
  // Electron 桌面保持原版行为（Ctrl+± 浏览器级缩放），不渲染控件避免“调了无效果”。
  const isElectron = React.useMemo(() => navigator.userAgent.includes('Electron'), [])
  const [uiScale, setUiScale] = useAtom(uiScaleAtom)
  const scaleOptions = UI_SCALE_OPTIONS

  // 页面写入统一串行；先确认持久化成功，再改 atom、缓存和 DOM。
  const run = React.useCallback(async (action: () => Promise<void>, failure: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try { await action() }
    catch (cause) {
      const message = `${failure}：${cause instanceof Error ? cause.message : String(cause)}`
      setError(message)
      toast.error(failure)
    } finally { busyRef.current = false; setBusy(false) }
  }, [])
  const saveTheme = React.useCallback(async (mode: ThemeMode, style: ThemeStyle) => {
    await run(async () => {
      await window.electronAPI.updateSettings({ themeMode: mode, themeStyle: style })
      setThemeMode(mode)
      setThemeStyle(style)
      try { localStorage.setItem('profer-theme-mode', mode); localStorage.setItem('profer-theme-style', style) } catch { /* 缓存不可用不影响已保存设置 */ }
      applyThemeToDOM(mode, style, systemIsDark)
    }, '外观保存失败，原设置已保留')
  }, [run, setThemeMode, setThemeStyle, systemIsDark])
  const handleThemeChange = (value: string) => { void saveTheme(value as ThemeMode, 'default') }
  const handleStyleSelect = (style: ThemeStyle) => { void saveTheme('special', style) }

  const readSkins = React.useCallback(async () => {
    const request = ++skinRequestRef.current
    setSkinLoading(true)
    setSkinError(null)
    try {
      // 原有 helper 负责更新主题模块缓存及当前皮肤 CSS；显式 IPC 读取提供真实失败状态。
      const next = await window.electronAPI.refreshSkins()
      if (request !== skinRequestRef.current) return
      await refreshSkinRegistry(themeMode === 'special' ? themeStyle : undefined)
      if (request === skinRequestRef.current) setSkins(next)
    } catch (cause) {
      if (request === skinRequestRef.current) setSkinError(`读取皮肤库失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally { if (request === skinRequestRef.current) setSkinLoading(false) }
  }, [setSkins, themeMode, themeStyle])
  const refreshSkins = React.useCallback(async () => {
    await run(readSkins, '读取皮肤库失败，请重试')
  }, [readSkins, run])
  React.useEffect(() => {
    const request = ++skinRequestRef.current
    window.electronAPI.getSkins().then((next) => { if (request === skinRequestRef.current) setSkins(next) })
      .catch((cause: unknown) => { if (request === skinRequestRef.current) setSkinError(`读取皮肤库失败：${cause instanceof Error ? cause.message : String(cause)}`) })
      .finally(() => { if (request === skinRequestRef.current) setSkinLoading(false) })
    return () => { skinRequestRef.current += 1 }
  }, [setSkins])
  const importSkin = React.useCallback(async (kind: 'zip' | 'folder', replace = false, existingPath?: string) => {
    await run(async () => {
      const path = existingPath ?? (kind === 'zip' ? await window.electronAPI.selectSkinZip() : await window.electronAPI.selectSkinFolder())
      if (!path) return
      const result = kind === 'zip' ? await window.electronAPI.installSkinZip(path, replace) : await window.electronAPI.installSkinFolder(path, replace)
      if (result.status === 'conflict') { setConflict({ path, kind }); return }
      if (!result.ok) throw new Error(result.message ?? '导入失败')
      setConflict(null)
      await readSkins()
      toast.success(result.message ?? '皮肤已导入')
    }, '导入皮肤失败')
  }, [readSkins, run])
  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    if (themeMode === 'special' && themeStyle === deleteTarget.id) { toast.error('请先恢复默认主题，再删除当前皮肤'); setDeleteTarget(null); return }
    await run(async () => {
      const result = await window.electronAPI.deleteUserSkin(deleteTarget.id)
      if (!result.ok) throw new Error(result.message ?? '删除失败')
      setDeleteTarget(null)
      await readSkins()
      toast.success('皮肤已删除')
    }, '删除皮肤失败')
  }, [deleteTarget, themeMode, themeStyle, readSkins, run])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = (value: string) => {
    const size = value as MarkdownFontSize
    void run(async () => {
      await window.electronAPI.updateSettings({ markdownFontSize: size })
      setMarkdownFontSize(size)
      applyMarkdownFontSizeToDOM(size)
    }, '字号保存失败，原设置已保留')
  }

  /** 切换界面大小 */
  const handleUiScaleChange = (value: string) => {
    const scale = value as UiScale
    void run(async () => {
      await window.electronAPI.updateSettings({ uiScale: scale })
      setUiScale(scale)
      try { localStorage.setItem('profer-ui-scale', scale) } catch { /* 缓存不可用不影响设置 */ }
    }, '界面大小保存失败，原设置已保留')
  }

  return (
    <div className="space-y-6" aria-busy={busy}>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={handleThemeChange}
            options={THEME_OPTIONS}
            disabled={busy}
          />

          {isElectron ? (
            <SettingsRow
              label="界面缩放"
              description={ZOOM_HINT}
            />
          ) : (
            <SettingsSegmentedControl
              label="界面大小"
              description="整体等比缩放界面（触屏设备推荐 110% 或更大）"
              value={uiScale}
              onValueChange={handleUiScaleChange}
              options={scaleOptions}
              disabled={busy}
            />
          )}

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
            disabled={busy}
          />

        </SettingsCard>
      </SettingsSection>

      <SkinManager skins={skins} themeMode={themeMode} themeStyle={themeStyle} busy={busy} loading={skinLoading} error={skinError} onSelect={handleStyleSelect} onImport={importSkin} onRefresh={refreshSkins} onOpenFolder={() => { void run(() => window.electronAPI.openUserSkinsFolder(), '打开皮肤目录失败') }} onDelete={setDeleteTarget} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setDeleteTarget(null) }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除皮肤？</AlertDialogTitle><AlertDialogDescription>将永久删除「{deleteTarget?.name}」，此操作不可恢复。</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void confirmDelete() }}>{busy ? '删除中…' : '删除皮肤'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={conflict !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setConflict(null) }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>皮肤已存在</AlertDialogTitle><AlertDialogDescription>是否以新导入的皮肤替换同名用户皮肤？原皮肤文件会被覆盖。</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); if (conflict) void importSkin(conflict.kind, true, conflict.path) }}>{busy ? '替换中…' : '替换皮肤'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      {SHOW_MACOS_SETTINGS && <AppIconPicker />}
    </div>
  )
}

/** 应用图标选择器 */
function AppIconPicker(): React.ReactElement {
  const [activeIcon, setActiveIcon] = React.useState<string>('default')
  const [isLoading, setIsLoading] = React.useState(false)

  // 初始化时读取当前设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setActiveIcon(settings.appIconVariant ?? 'default')
    })
  }, [])

  const isWindows = React.useMemo(() => detectIsWindows(), [])

  const handleIconSelect = React.useCallback(async (variantId: string) => {
    if (isWindows) {
      toast.error('Windows 系统暂不支持更换应用图标')
      return
    }
    if (variantId === activeIcon || isLoading) return
    setIsLoading(true)
    try {
      const success = await window.electronAPI.setAppIcon(variantId)
      if (success) {
        setActiveIcon(variantId)
        toast.success('应用图标已更换')
      } else {
        toast.error('图标切换失败')
      }
    } catch {
      toast.error('图标切换失败')
    } finally {
      setIsLoading(false)
    }
  }, [activeIcon, isLoading, isWindows])

  return (
    <SettingsSection
      title="应用图标"
      description="自定义 Dock 栏中的应用图标样式"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-3">
          <div className="grid grid-cols-7 gap-3">
            {ICON_VARIANTS.map((variant) => (
              <IconCard
                key={variant.id}
                variant={variant}
                isSelected={activeIcon === variant.id}
                onSelect={() => handleIconSelect(variant.id)}
              />
            ))}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 图标选项卡片 */
function IconCard({
  variant,
  isSelected,
  onSelect,
}: {
  variant: IconVariant
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all',
        isSelected
          ? 'ring-2 ring-primary bg-primary/5'
          : 'hover:bg-muted/50'
      )}
    >
      <div
        className={cn(
          'w-12 h-12 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          variant.previewBg,
        )}
      >
        {variant.id === 'default' ? (
          // 默认图标用 CSS 模拟 Profer logo 形状
          <div className="flex items-end gap-[2px] -rotate-12">
            {[1, 0.85, 0.7, 0.55, 0.4, 0.25].map((opacity, i) => (
              <div
                key={i}
                className="rounded-[1px]"
                style={{
                  width: i === 0 ? 4 : 3,
                  height: i === 0 ? 14 : 14 - i * 1.5,
                  backgroundColor: `rgba(255,255,255,${opacity})`,
                }}
              />
            ))}
          </div>
        ) : (
          <img
            src={variant.src}
            alt={variant.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        )}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground leading-tight text-center">
        {variant.name}
      </span>
      {isSelected && (
        <div className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="size-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}
