/**
 * PaperBackground — 开屏（splash 重播）用的暖纸背景（纯 CSS，零 WebGL、零 canvas）。
 *
 * 视觉与主进程冷启动 Splash（main/lib/startup-splash.ts）同源：米黄纸底 +
 * 右上暖光 / 左下冷影 + 横向纸纤维 + 颗粒 + 边缘衰光。两边只换颜色，结构一致，
 * 这样「Splash 淡出 → 开屏铭牌」看起来是同一张纸继续铺开。
 *
 * 使用范围（v2）：只服务冷启动与开屏重播这一个品牌时刻。
 * 首次引导 Onboarding 已改用产品自身 token —— 那是一个要用户上手操作的工作界面，
 * 不是品牌片，两者不该共用一套装饰背景。
 *
 * 同时导出 `paperTokens()` 把墨色/描边/表面层级写成 CSS 变量，供仍在使用纸张
 * 视觉的开屏铭牌读取。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { resolvedThemeAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'

export type PaperTone = 'light' | 'dark'

/** 当前主题解析出的纸面色调。跟随应用主题，不单独设置开关。 */
export function usePaperTone(): PaperTone {
  const resolved = useAtomValue(resolvedThemeAtom)
  return resolved === 'dark' ? 'dark' : 'light'
}

/**
 * 浅色暖纸的墨色层级。
 *
 * 数值来自对 #f6f4ee / #fcfbf8 纸底的对比度核算：正文 ink-3 约 7:1，
 * 次级 ink-4 约 5.4:1，最小的 mono 装饰标签 ink-5 约 3.6:1（非正文，仅大写短标签）。
 */
const LIGHT_TOKENS: Record<string, string> = {
  '--ob-ink': '#0f1012',
  '--ob-ink-2': '#2b2f36',
  '--ob-ink-3': '#454b53',
  '--ob-ink-4': '#5c626b',
  '--ob-ink-5': 'rgba(20,22,26,.40)',
  '--ob-line': 'rgba(94,84,70,.14)',
  '--ob-line-2': 'rgba(94,84,70,.22)',
  '--ob-line-3': 'rgba(94,84,70,.32)',
  '--ob-surface': 'rgba(255,255,255,.66)',
  '--ob-surface-2': 'rgba(255,255,255,.46)',
  '--ob-surface-3': 'rgba(120,110,96,.075)',
  '--ob-card-solid': 'rgba(252,251,248,.96)',
  '--ob-strong-bg': '#0f1012',
  '--ob-strong-fg': '#fcfbf8',
  '--ob-halo': 'rgba(255,255,255,.55)',
  '--ob-shadow': '0 34px 80px -34px rgba(74,64,52,.30), 0 2px 6px rgba(74,64,52,.06)',
  '--ob-shadow-soft': '0 18px 44px -24px rgba(74,64,52,.24)',
  '--ob-focus': 'rgba(15,16,18,.42)',
  '--ob-ok': '#1c7a4e',
  '--ob-ok-bg': 'rgba(28,122,78,.12)',
  '--ob-wash':
    'linear-gradient(100deg, rgba(252,251,248,.88) 0%, rgba(252,251,248,.54) 46%, rgba(252,251,248,0) 100%)',
  '--ob-wash-edge':
    'radial-gradient(ellipse at 72% 46%, transparent 8%, rgba(233,230,222,.22) 80%, rgba(200,194,182,.34) 100%)',
  '--ob-mock-glow': 'radial-gradient(circle at 60% 45%, rgba(126,113,94,.13), transparent 70%)',
}

/** 深色变体（系统深色）：沿用同一套层级，只换明暗。 */
const DARK_TOKENS: Record<string, string> = {
  '--ob-ink': '#f4f5f7',
  '--ob-ink-2': 'rgba(255,255,255,.80)',
  '--ob-ink-3': 'rgba(255,255,255,.62)',
  '--ob-ink-4': 'rgba(255,255,255,.45)',
  '--ob-ink-5': 'rgba(255,255,255,.30)',
  '--ob-line': 'rgba(255,255,255,.09)',
  '--ob-line-2': 'rgba(255,255,255,.16)',
  '--ob-line-3': 'rgba(255,255,255,.26)',
  '--ob-surface': 'rgba(255,255,255,.045)',
  '--ob-surface-2': 'rgba(255,255,255,.03)',
  '--ob-surface-3': 'rgba(255,255,255,.07)',
  '--ob-card-solid': 'rgba(16,16,18,.95)',
  '--ob-strong-bg': '#f4f5f7',
  '--ob-strong-fg': '#14161a',
  '--ob-halo': 'rgba(255,255,255,.10)',
  '--ob-shadow': '0 50px 120px -40px rgba(0,0,0,.95)',
  '--ob-shadow-soft': '0 24px 60px -30px rgba(0,0,0,.7)',
  '--ob-focus': 'rgba(255,255,255,.40)',
  '--ob-ok': '#6ee7b7',
  '--ob-ok-bg': 'rgba(110,231,183,.14)',
  '--ob-wash':
    'linear-gradient(100deg, rgba(0,0,0,.90) 0%, rgba(0,0,0,.58) 46%, rgba(0,0,0,.14) 100%)',
  '--ob-wash-edge':
    'radial-gradient(ellipse at 72% 46%, transparent 8%, rgba(0,0,0,.28) 80%, rgba(0,0,0,.55) 100%)',
  '--ob-mock-glow': 'radial-gradient(circle at 60% 45%, rgba(255,255,255,.09), transparent 70%)',
}

/** 把 tone 对应的 CSS 变量展开成 style，挂在纸张根节点上。 */
export function paperTokens(tone: PaperTone): React.CSSProperties {
  return (tone === 'dark' ? DARK_TOKENS : LIGHT_TOKENS) as React.CSSProperties
}

/** 极轻的漂移：64s 一个来回，位移不到 2%，肉眼只感到纸面在呼吸。 */
const KEYFRAMES_ID = 'profer-paper-drift'
const KEYFRAMES_CSS = `@keyframes profer-paper-drift{
  0%,100%{transform:translate3d(0,0,0) scale(1)}
  50%{transform:translate3d(-1.8%,1.4%,0) scale(1.035)}
}`

function ensureKeyframes(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent = KEYFRAMES_CSS
  document.head.appendChild(style)
}

/** 颗粒：SVG feTurbulence 转 data URI，纯 CSS 平铺，不产生 canvas 或额外 DOM 滤镜。 */
const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.86' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const PAPER = {
  light: {
    paper: 'linear-gradient(163deg, #fcfbf8 0%, #f6f4ee 30%, #f6f4ee 54%, #e9e6de 100%)',
    light:
      'radial-gradient(ellipse 44% 38% at 74% 15%, rgba(255,253,244,.95), transparent 62%), radial-gradient(ellipse 38% 44% at 20% 90%, rgba(200,212,230,.40), transparent 68%)',
    fiber: 'rgba(118,108,94,.032)',
    vignette: 'rgba(94,84,70,.11)',
    grainOpacity: 0.34,
    grainBlend: 'multiply' as const,
    edge:
      'linear-gradient(90deg, transparent, rgba(255,255,255,.85) 30%, rgba(255,255,255,.5) 62%, transparent)',
  },
  dark: {
    paper: 'linear-gradient(163deg, #17181c 0%, #101114 30%, #101114 54%, #09090a 100%)',
    light:
      'radial-gradient(ellipse 44% 38% at 74% 15%, rgba(148,162,184,.22), transparent 62%), radial-gradient(ellipse 38% 44% at 20% 90%, rgba(80,62,46,.30), transparent 68%)',
    fiber: 'rgba(255,255,255,.014)',
    vignette: 'rgba(0,0,0,.46)',
    grainOpacity: 0.15,
    grainBlend: 'screen' as const,
    edge:
      'linear-gradient(90deg, transparent, rgba(255,255,255,.09) 30%, rgba(255,255,255,.05) 62%, transparent)',
  },
} as const

export interface PaperBackgroundProps {
  /** 纸面色调。默认跟随当前主题解析结果。 */
  tone?: PaperTone
  /** 暖光层是否极轻漂移（默认关闭；开屏重播可开）。 */
  drift?: boolean
  className?: string
}

/**
 * 铺满父容器的暖纸背景。父容器需要 `relative`（或自身即 fixed/absolute 容器）。
 * 层序：纸基色 → 暖光/冷影 → 纸纤维 → 边缘衰光 → 颗粒 → 顶部高光。
 */
export function PaperBackground({ tone, drift = false, className }: PaperBackgroundProps): React.ReactElement {
  const themeTone = usePaperTone()
  const active = tone ?? themeTone
  const p = PAPER[active]

  React.useEffect(() => {
    if (drift) ensureKeyframes()
  }, [drift])

  return (
    <div
      aria-hidden="true"
      data-paper-tone={active}
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
    >
      <div className="absolute inset-0" style={{ background: p.paper }} />
      <div
        className={cn('absolute -inset-[38%]', drift && 'motion-reduce:animate-none')}
        style={{
          background: p.light,
          animation: drift ? 'profer-paper-drift 64s ease-in-out infinite' : undefined,
        }}
      />
      <div
        className="absolute inset-0 opacity-55"
        style={{
          backgroundImage: `repeating-linear-gradient(91deg, ${p.fiber} 0px, ${p.fiber} 1px, transparent 1px, transparent 3px)`,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 76% 68% at 50% 44%, transparent 42%, ${p.vignette} 100%)`,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: GRAIN_URL,
          backgroundSize: '180px 180px',
          opacity: p.grainOpacity,
          mixBlendMode: p.grainBlend,
        }}
      />
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: p.edge }} />
    </div>
  )
}
