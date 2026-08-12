/**
 * IntroWaterRipple — Profer 开屏遮罩与品牌铭牌。
 * 背景 GPU 液态玻璃渲染见 IntroFluidBackground.tsx。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { IntroFluidBackground } from './IntroFluidBackground'

const TIMING = {
  nameRiseStart: 0.24,
  nameRiseEnd: 0.66,
  fadeOutStart: 0.86,
} as const

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
        name.style.filter = `drop-shadow(0 0 ${12 + rise * 20}px rgba(210,216,226,${0.22 * rise})) drop-shadow(0 12px 34px rgba(0,0,0,.72))`
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
  }, [done, durationMs])

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
      className="fixed inset-0 z-[10000] flex cursor-pointer select-none items-center justify-center overflow-hidden bg-black"
      onClick={skip}
      role="presentation"
    >
      <IntroFluidBackground durationMs={durationMs} />
      {/* 背景之上、铭牌之下；中心完全透明，避免将 WebGL 液态细节压黑。 */}
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_50%_56%,transparent_48%,rgba(0,0,0,.16)_100%)]" />
      <h1
        ref={nameRef}
        className="absolute left-1/2 top-1/2 z-10 w-max whitespace-nowrap overflow-visible px-[0.12em] font-sans font-semibold italic"
        style={{
          fontSize: 'clamp(52px, 10vw, 112px)',
          letterSpacing: '-0.045em',
          opacity: 0,
          transform: 'translate(-50%, -62%) skewX(-7deg)',
          color: '#f4f5f7',
          backgroundImage: 'linear-gradient(180deg, #fff 0%, #f1f2f5 42%, #c5c8ce 100%)',
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
      <span className="absolute bottom-[8%] z-10 font-mono text-[10px] uppercase tracking-[0.32em] text-white/30" aria-hidden="true">
        Click to skip
      </span>
    </div>,
    document.body,
  )
}
