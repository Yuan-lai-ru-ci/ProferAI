/**
 * 应用当前明暗的主进程侧解析。
 *
 * 为什么需要：viewer 页（浏览器列里的文件预览）的主题只能在**打开时烘进 URL**
 * —— 那一页跑在无 preload 的沙箱 webContents 里，读不到 app 的设置。
 * 大多数入口由渲染进程带上主题（那里能读到真实生效的 CSS 变量），但 Agent 的
 * `BrowserPreviewOpen` 工具这一类入口只有主进程上下文，必须在这里兜底，
 * 否则深色应用里被 Agent 打开的预览会一直是浅色。
 *
 * 口径与渲染进程 `atoms/theme.ts` 的 `resolvedThemeAtom` 一致：
 * - light / dark / system 直接判定（system 用 `nativeTheme`）；
 * - special（皮肤）优先取皮肤注册表里的真实 `tone`（用户皮肤可能不带 -light/-dark 后缀），
 *   注册表里没有（被删除 / 目录被移除）或扫描失败时，回落到 id 后缀启发式；
 *   special 但没有真实皮肤（themeStyle 为空或 'default'）按「默认主题」解析为浅色，
 *   与渲染进程 `applyThemeToDOM` 的 `themeMode === 'dark'` 判定同向。
 *
 * 注意：这里只能解析**明暗**。皮肤的具体配色只有渲染进程算得出来（要读实际生效的 CSS 变量），
 * 所以走本兜底的入口拿到的是"该明暗的默认配色"，而不是皮肤配色。
 */
import { nativeTheme } from 'electron'

import { getSettings } from './settings-service'
import { scanSkins } from './skin-service'

/** 皮肤 id 后缀启发式（与渲染进程 `inferSkinToneFromStyle`、index.html 首帧脚本同向） */
function inferSkinToneIsDark(style: string): boolean {
  return !style.endsWith('-light')
}

export function resolveAppThemeIsDark(): boolean {
  const settings = getSettings()
  if (settings.themeMode === 'light') return false
  if (settings.themeMode === 'dark') return true
  if (settings.themeMode === 'system') return nativeTheme.shouldUseDarkColors

  const style = settings.themeStyle
  if (!style || style === 'default') {
    // special + 无皮肤 / default 皮肤 = 「没有真实皮肤」，等同于默认主题的明暗，
    // 而不是硬编码深色。口径与渲染进程 `atoms/theme.ts` 的 `applyThemeToDOM` 一致：
    // 那里 `themeMode !== 'dark'` 落 else 分支得到 `false`（浅色）——若这里返回 true，
    // splash 底色与 Agent 打开的预览页会是深色、主体却是浅色，同一状态两边解析相反。
    return false
  }
  try {
    const tone = scanSkins().find((skin) => skin.id === style)?.tone
    if (tone) return tone === 'dark'
  } catch (error) {
    console.warn('[主题] 读取皮肤注册表失败，按 id 后缀推断明暗:', error)
  }
  return inferSkinToneIsDark(style)
}
