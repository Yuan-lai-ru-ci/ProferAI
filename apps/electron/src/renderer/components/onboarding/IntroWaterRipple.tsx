/**
 * IntroWaterRipple — Profer 开屏遮罩与品牌铭牌。
 *
 * 背景曾是 GPU 液态玻璃（IntroFluidBackground，WebGL）；冷启动 Splash 已改为
 * 纯 CSS 暖纸后，这里同步换成同一张纸（PaperBackground），保证「Splash 淡出 →
 * 开屏铭牌」是同一张纸，且开屏重播不再启动 WebGL。
 * 组件名保留（App.tsx 的「重播开屏」入口与测试都按这个名字引用）。
 *
 * IntroFluidBackground.tsx / intro-fluid-shader.ts 暂时保留一个版本周期以便回滚，
 * 但不再被本文件引用。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { PaperBackground, usePaperTone, type PaperTone } from './PaperBackground'

const TIMING = {
  nameRiseStart: 0.24,
  nameRiseEnd: 0.66,
  fadeOutStart: 0.86,
} as const

/** 字标墨色渐变：浅色是落墨，深色是压印白。与 startup-splash.ts 保持一致。 */
const NAME_STYLE: Record<PaperTone, { gradient: string; glow: string; shadow: string; hint: string }> = {
  light: {
    gradient: 'linear-gradient(176deg, #0f1012 0%, #15171a 46%, #3c4149 100%)',
    glow: 'rgba(120,108,92,.18)',
    shadow: 'rgba(74,64,52,.22)',
    hint: 'rgba(20,22,26,.30)',
  },
  dark: {
    gradient: 'linear-gradient(180deg, #ffffff 0%, #f2f4f6 42%, #a4aab4 100%)',
    glow: 'rgba(210,216,226,.22)',
    shadow: 'rgba(0,0,0,.72)',
    hint: 'rgba(255,255,255,.30)',
  },
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const easeOutCubic = (value: number): number => 1 - Math.pow(1 - clamp01(value), 3)
const easeInOutCubic = (value: number): number => {
  const t = clamp01(value)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function IntroWaterRipple({ onDone, durationMs = 5000 }: {
  onDone: () => void
  durationMs?: number
}): React.ReactElement {
  const nameRef = React.useRef<HTMLHeadingElement>(null)
  const onDoneRef = React.useRef(onDone)
  const doneFiredRef = React.useRef(false)
  const [done, setDone] = React.useState(false)
  const tone = usePaperTone()
  const ink = NAME_STYLE[tone]
  onDoneRef.current = onDone

  React.useLayoutEffect(() => {
    if (done) return
    const start = performance.now()
    let raf = 0
    const animateName = (now: number): void => {
      const progress = Math.min(1, (now - start) / durationMs)
      const name = nameRef.current
      if (name) {
        const rise = easeInOutCubic((progress - TIMING.nameRiseStart) / (TIMING.nameRiseEnd - TIMING.nameRiseStart))
        const fadeIn = easeOutCubic((progress - TIMING.nameRiseStart + 0.07) / 0.25)
        const fadeOut = 1 - easeInOutCubic((progress - TIMING.fadeOutStart) / (1 - TIMING.fadeOutStart))
        const opacity = clamp01(rise * fadeIn * fadeOut)
        name.style.opacity = String(opacity)
        name.style.transform = `translate(-50%, -62%) translateY(${(1 - rise) * 22}px) skewX(-7deg) scale(${0.96 + rise * 0.04})`
        name.style.filter = `drop-shadow(0 0 ${12 + rise * 20}px ${ink.glow}) drop-shadow(0 12px 34px ${ink.shadow})`
      }
      if (progress >= 1) {
        if (!doneFiredRef.current) {
          doneFiredRef.current = true
          setDone(true)
        }
        return
      }
      raf = requestAnimationFrame(animateName)
    }
    raf = requestAnimationFrame(animateName)
    return () => cancelAnimationFrame(raf)
  }, [done, durationMs, ink.glow, ink.shadow])

  React.useEffect(() => {
    if (!done) return
    const id = window.setTimeout(() => onDoneRef.current(), 180)
    return () => window.clearTimeout(id)
  }, [done])

  const skip = (): void => {
    if (!doneFiredRef.current) {
      doneFiredRef.current = true
      setDone(true)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex cursor-pointer select-none items-center justify-center overflow-hidden"
      onClick={skip}
      role="presentation"
    >
      <PaperBackground tone={tone} drift />
      <h1
        ref={nameRef}
        className="absolute left-1/2 top-1/2 z-10 w-max whitespace-nowrap overflow-visible px-[0.12em] font-sans font-semibold italic"
        style={{
          fontSize: 'clamp(52px, 10vw, 112px)',
          letterSpacing: '-0.045em',
          opacity: 0,
          transform: 'translate(-50%, -62%) skewX(-7deg)',
          backgroundImage: ink.gradient,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          WebkitFontSmoothing: 'antialiased',
          textRendering: 'geometricPrecision',
          pointerEvents: 'none',
        }}
        aria-label="Profer"
      >
        Profer
      </h1>
      <span
        className="absolute bottom-[8%] z-10 font-mono text-[10px] uppercase tracking-[0.32em]"
        style={{ color: ink.hint }}
        aria-hidden="true"
      >
        Click to skip
      </span>
    </div>,
    document.body,
  )
}
