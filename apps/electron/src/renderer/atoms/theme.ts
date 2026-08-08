/**
 * 主题状态原子
 *
 * 管理应用主题模式（浅色/深色/跟随系统/特殊风格）和特殊风格。
 * - themeModeAtom: 用户选择的主题模式，持久化到 ~/.proma/settings.json
 * - themeStyleAtom: 特殊风格主题
 * - systemIsDarkAtom: 系统当前是否为深色模式
 * - resolvedThemeAtom: 派生的最终主题（light | dark）
 *
 * 使用 localStorage 作为缓存，避免页面加载时闪烁。
 */

import { atom, getDefaultStore } from 'jotai'
import { DEFAULT_INTERFACE_VARIANT, type InterfaceVariant, type SkinInfo, type ThemeMode, type ThemeStyle } from '../../types'

/** localStorage 缓存键 */
const THEME_CACHE_KEY = 'profer-theme-mode'
const THEME_STYLE_CACHE_KEY = 'profer-theme-style'
const INTERFACE_VARIANT_CACHE_KEY = 'profer-interface-variant'
/** 当前皮肤 tone 缓存：供 index.html 首帧防闪烁脚本推断 dark 类（皮肤注册表需 IPC 才能读取） */
const SKIN_TONE_CACHE_KEY = 'profer-skin-tone'

/** 读取缓存的皮肤 tone（'dark' | 'light' | null） */
function getCachedSkinTone(): 'dark' | 'light' | null {
  try {
    const cached = localStorage.getItem(SKIN_TONE_CACHE_KEY)
    if (cached === 'dark' || cached === 'light') return cached
  } catch {
    // localStorage 不可用时忽略
  }
  return null
}

/** 缓存皮肤 tone 到 localStorage */
function cacheSkinTone(tone: 'dark' | 'light'): void {
  try {
    localStorage.setItem(SKIN_TONE_CACHE_KEY, tone)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 从 localStorage 读取缓存的主题模式
 */
function getCachedThemeMode(): ThemeMode {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system' || cached === 'special') {
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return 'dark'
}

/**
 * 从 localStorage 读取缓存的特殊风格
 */
function getCachedThemeStyle(): ThemeStyle {
  try {
    const cached = localStorage.getItem(THEME_STYLE_CACHE_KEY)
    if (cached && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(cached)) return cached as ThemeStyle
  } catch {
    // localStorage 不可用时忽略
  }
  return 'default'
}

/**
 * 缓存主题模式到 localStorage
 */
function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 缓存特殊风格到 localStorage
 */
function cacheThemeStyle(style: ThemeStyle): void {
  try {
    localStorage.setItem(THEME_STYLE_CACHE_KEY, style)
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 用户选择的主题模式 */
export const themeModeAtom = atom<ThemeMode>(getCachedThemeMode())

/** 用户选择的特殊风格 */
export const themeStyleAtom = atom<ThemeStyle>(getCachedThemeStyle())

/**
 * 从 localStorage 读取缓存的界面风格
 */
function getCachedInterfaceVariant(): InterfaceVariant {
  try {
    const cached = localStorage.getItem(INTERFACE_VARIANT_CACHE_KEY)
    if (cached === 'classic' || cached === 'modern') {
      // 现代样式已移除，始终回退到经典样式
      if (cached === 'modern') return 'classic'
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return DEFAULT_INTERFACE_VARIANT
}

/**
 * 缓存界面风格到 localStorage
 */
function cacheInterfaceVariant(variant: InterfaceVariant): void {
  try {
    localStorage.setItem(INTERFACE_VARIANT_CACHE_KEY, variant)
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 用户选择的界面风格 */
export const interfaceVariantAtom = atom<InterfaceVariant>(getCachedInterfaceVariant())

/** 系统当前是否为深色模式（优先从 matchMedia 同步读取，避免默认 dark 导致的启动闪烁） */
export const systemIsDarkAtom = atom<boolean>(
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
)

/** 皮肤注册表（loadSkins 后填充；声明须先于 resolvedThemeAtom 以便其读取） */
export const skinsAtom = atom<SkinInfo[]>([])

/** 派生：最终解析的主题（light | dark） */
export const resolvedThemeAtom = atom<'light' | 'dark'>((get) => {
  const mode = get(themeModeAtom)
  if (mode === 'system') {
    return get(systemIsDarkAtom) ? 'dark' : 'light'
  }
  if (mode === 'special') {
    const style = get(themeStyleAtom)
    // 优先从皮肤注册表取真实 tone（用户皮肤可能不带 -light/-dark 后缀）；
    // 未命中（旧主题/注册表未就绪）再回退后缀推断。
    // 读 skinsAtom 而非模块级 skinsCache，loadSkins 完成后能自动触发重算。
    const skinTone = get(skinsAtom).find((item) => item.id === style)?.tone
    if (skinTone) return skinTone
    return style.endsWith('-light') ? 'light' : 'dark'
  }
  return mode
})

let skinsCache: SkinInfo[] | null = null
export async function loadSkins(force = false): Promise<SkinInfo[]> {
  if (skinsCache && !force) return skinsCache
  try {
    const skins = force ? await window.electronAPI.refreshSkins() : await window.electronAPI.getSkins()
    skinsCache = skins
    getDefaultStore().set(skinsAtom, skins)
    return skins
  } catch {
    skinsCache = []
    getDefaultStore().set(skinsAtom, [])
    return []
  }
}
const SKIN_STYLE_ID = 'skin-css'
/** CSS 注入代数序号：仅接受最新一次请求的结果，防快速切换皮肤时旧请求覆盖新 CSS */
let skinCssGeneration = 0
/**
 * 注入皮肤 CSS 到 <style id="skin-css">。
 * 幂等（默认）：皮肤 class 已就位且 style 元素已有内容时直接短路，
 * 避免重复 IPC + style.textContent 赋值触发的全文档样式重算（P0）。
 * force=true 用于手动刷新皮肤库后强制重注入。
 */
async function applySkinCss(id: string, force = false): Promise<void> {
  if (!force) {
    const html = document.documentElement
    if (html.classList.contains(`skin-${id}`)) {
      const existing = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null
      if (existing && existing.textContent) return
    }
  }
  const generation = ++skinCssGeneration
  const css = await window.electronAPI.getSkinCss(id).catch(() => null)
  // 注入期间又发起了新的切换，丢弃本次结果（class 已切换为更新的皮肤）
  if (generation !== skinCssGeneration) return
  const html = document.documentElement
  if (!css) {
    // 注入失败（文件损坏/IPC 失败）：摘掉 skin-* class 回退默认主题，避免“有 class 无样式”半状态
    if (html.classList.contains(`skin-${id}`)) html.classList.remove(`skin-${id}`)
    return
  }
  let style = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null
  if (!style) { style = document.createElement('style'); style.id = SKIN_STYLE_ID; document.head.appendChild(style) }
  style.textContent = css
}
export async function refreshSkinRegistry(currentStyle?: ThemeStyle): Promise<SkinInfo[]> {
  const skins = await loadSkins(true)
  if (currentStyle && skins.some((skin) => skin.id === currentStyle)) await applySkinCss(currentStyle, true)
  return skins
}

/**
 * 处理主进程皮肤变更广播（安装/删除/刷新）：刷新注册表并同步当前窗口。
 * - 当前激活皮肤被删除 → 回退默认深色主题
 * - 当前激活皮肤仍存在 → 强制重注入 CSS（文件可能已变更）
 */
export async function handleSkinsChanged(payload: { deletedId: string | null }): Promise<void> {
  const store = getDefaultStore()
  const skins = await loadSkins(true)
  const mode = store.get(themeModeAtom)
  const style = store.get(themeStyleAtom)
  if (mode !== 'special' || style === 'default') return
  if (payload.deletedId && payload.deletedId === style) {
    // 当前皮肤被删除：回退默认深色（themeMode/themeStyle 变化会自动触发 applyThemeToDOM）
    await Promise.all([updateThemeMode('dark'), updateThemeStyle('default')])
    applyThemeToDOM('dark', 'default')
  } else if (skins.some((skin) => skin.id === style)) {
    await applySkinCss(style, true)
  }
}

/**
 * 应用主题到 DOM
 *
 * 在 <html> 元素上切换 dark 类名和特殊风格类名。
 *
 * 幂等实现：先计算目标 class 状态，与当前 DOM 对比，一致时直接 return，
 * 不触发任何 classList mutation。避免与 vibrancy + backdrop-blur 合成层叠加
 * 导致 Chromium 重建合成层造成的全屏闪烁。
 */
export function applyThemeToDOM(themeMode: ThemeMode, themeStyle: ThemeStyle = 'default', systemIsDark: boolean = true): void {
  const html = document.documentElement

  // 计算目标状态。注册表就绪后用 skin-* + 动态 CSS；无 IPC 的平板继续走 theme-* 兼容层。
  let targetStyleClass: string | null = null
  let targetSkinClass: string | null = null
  let targetIsDark: boolean

  if (themeMode === 'special' && themeStyle !== 'default') {
    const skin = skinsCache?.find((item) => item.id === themeStyle)
    if (skin) {
      targetSkinClass = `skin-${themeStyle}`
      targetIsDark = skin.tone === 'dark'
      // 持久化 tone，供下次启动时 index.html 首帧防闪烁脚本推断 dark 类
      cacheSkinTone(skin.tone)
      void applySkinCss(themeStyle)
    } else {
      targetStyleClass = `theme-${themeStyle}`
      targetIsDark = themeStyle.endsWith('-dark')
    }
  } else if (themeMode === 'system') {
    targetIsDark = systemIsDark
  } else {
    targetIsDark = themeMode === 'dark'
  }

  // 读取当前状态
  const currentIsDark = html.classList.contains('dark')
  const currentStyleClass = Array.from(html.classList).find((c) => c.startsWith('theme-')) ?? null
  const currentSkinClass = Array.from(html.classList).find((c) => c.startsWith('skin-')) ?? null

  // 与目标一致 → 直接跳过，避免触发 CSS 重新级联
  if (currentIsDark === targetIsDark && currentStyleClass === targetStyleClass && currentSkinClass === targetSkinClass) {
    return
  }

  // 只修改确实需要变的 class
  if (currentStyleClass !== targetStyleClass) {
    if (currentStyleClass) {
      html.classList.remove(currentStyleClass)
    }
    if (targetStyleClass) {
      html.classList.add(targetStyleClass)
    }
  }
  if (currentSkinClass !== targetSkinClass) {
    if (currentSkinClass) html.classList.remove(currentSkinClass)
    if (targetSkinClass) html.classList.add(targetSkinClass)
    else document.getElementById(SKIN_STYLE_ID)?.remove()
  }
  if (currentIsDark !== targetIsDark) html.classList.toggle('dark', targetIsDark)
}

/**
 * 应用界面风格到 DOM
 */
export function applyInterfaceVariantToDOM(variant: InterfaceVariant = DEFAULT_INTERFACE_VARIANT): void {
  const html = document.documentElement
  const targetClass = variant === 'classic' ? 'ui-classic' : 'ui-modern'
  const currentClass = html.classList.contains('ui-classic')
    ? 'ui-classic'
    : html.classList.contains('ui-modern')
      ? 'ui-modern'
      : null

  if (currentClass === targetClass) {
    return
  }

  if (currentClass) {
    html.classList.remove(currentClass)
  }
  html.classList.add(targetClass)
}

/**
 * 初始化主题系统
 *
 * 从主进程加载设置，监听系统主题变化。
 * 返回清理函数。
 */
export async function initializeTheme(
  setThemeMode: (mode: ThemeMode) => void,
  setSystemIsDark: (isDark: boolean) => void,
  setThemeStyle?: (style: ThemeStyle) => void,
  setInterfaceVariant?: (variant: InterfaceVariant) => void,
): Promise<() => void> {
  // 从主进程加载持久化设置与皮肤注册表
  const [settings] = await Promise.all([window.electronAPI.getSettings(), loadSkins()])
  setThemeMode(settings.themeMode)
  cacheThemeMode(settings.themeMode)

  // 加载特殊风格
  if (setThemeStyle && settings.themeStyle) {
    setThemeStyle(settings.themeStyle)
    cacheThemeStyle(settings.themeStyle)
  }

  const interfaceVariant = settings.interfaceVariant || DEFAULT_INTERFACE_VARIANT
  if (setInterfaceVariant) {
    setInterfaceVariant(interfaceVariant)
  }
  cacheInterfaceVariant(interfaceVariant)

  // 获取系统主题并在注册表就绪后应用皮肤
  const isDark = await window.electronAPI.getSystemTheme()
  setSystemIsDark(isDark)
  applyThemeToDOM(settings.themeMode, settings.themeStyle || 'default', isDark)

  // 监听系统主题变化
  const cleanupSystem = window.electronAPI.onSystemThemeChanged((newIsDark) => {
    setSystemIsDark(newIsDark)
  })

  // 监听用户手动切换主题（跨窗口同步，如 Quick Task 面板）
  const cleanupThemeSettings = window.electronAPI.onThemeSettingsChanged((payload) => {
    const mode = payload.themeMode as ThemeMode
    const style = (payload.themeStyle || 'default') as ThemeStyle
    const variant = (payload.interfaceVariant || DEFAULT_INTERFACE_VARIANT) as InterfaceVariant
    setThemeMode(mode)
    cacheThemeMode(mode)
    if (setThemeStyle) {
      setThemeStyle(style)
      cacheThemeStyle(style)
    }
    if (setInterfaceVariant) {
      setInterfaceVariant(variant)
      cacheInterfaceVariant(variant)
    }
  })

  return () => {
    cleanupSystem()
    cleanupThemeSettings()
  }
}

/**
 * 更新主题模式并持久化
 *
 * 同时更新 localStorage 缓存和主进程配置文件。
 */
export async function updateThemeMode(mode: ThemeMode): Promise<void> {
  cacheThemeMode(mode)
  await window.electronAPI.updateSettings({ themeMode: mode })
}

/**
 * 更新特殊风格并持久化
 */
export async function updateThemeStyle(style: ThemeStyle): Promise<void> {
  cacheThemeStyle(style)
  await window.electronAPI.updateSettings({ themeStyle: style })
}

/**
 * 更新界面风格并持久化
 */
export async function updateInterfaceVariant(variant: InterfaceVariant): Promise<void> {
  cacheInterfaceVariant(variant)
  await window.electronAPI.updateSettings({ interfaceVariant: variant })
}
