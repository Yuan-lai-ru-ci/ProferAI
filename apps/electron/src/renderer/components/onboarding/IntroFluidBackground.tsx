/**
 * IntroFluidBackground — Profer 开屏用的轻量 WebGL 液态玻璃背景。
 *
 * 实现参考 Pavel Dobryakov 的 WebGL-Fluid-Simulation（MIT）：使用 GPU Canvas、
 * 时间驱动的 splat（扰动）和显式 RAF/ResizeObserver 清理。但本模块重新实现为
 * 面向 5 秒开屏的单个着色器，不复制上游 demo、GUI、统计或交互代码。
 *
 * Upstream inspiration: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 * Upstream license: MIT, Copyright (c) 2017 Pavel Dobryakov
 */

import * as React from 'react'

import { INTRO_FLUID_FRAGMENT_SHADER, INTRO_FLUID_VERTEX_SHADER } from '../../../shared/intro-fluid-shader'

// 仅用于排障；正常启动必须保持关闭。
const DEBUG_SOLID_OUTPUT = false

export function IntroFluidBackground({ durationMs, repeat = false }: { durationMs: number; repeat?: boolean }): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' })
    if (!gl) return
    // 无论 shader 是否可用，默认 framebuffer 都必须先是黑色，绝不暴露未初始化白屏。
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
      console.error('[IntroFluidBackground] shader compilation failed', {
        stage: type === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
        infoLog: gl.getShaderInfoLog(shader),
        contextLost: gl.isContextLost(),
        error: gl.getError(),
      })
      gl.deleteShader(shader)
      return null
    }
    const vertex = compile(gl.VERTEX_SHADER, INTRO_FLUID_VERTEX_SHADER)
    const fragment = compile(gl.FRAGMENT_SHADER, INTRO_FLUID_FRAGMENT_SHADER)
    if (!vertex || !fragment) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[IntroFluidBackground] program link failed:', gl.getProgramInfoLog(program))
      return
    }

    const position = gl.getAttribLocation(program, 'aPosition')
    const time = gl.getUniformLocation(program, 'uTime')
    const resolution = gl.getUniformLocation(program, 'uResolution')
    const opacity = gl.getUniformLocation(program, 'uOpacity')
    const seed = gl.getUniformLocation(program, 'uSeed')
    const themeLight = gl.getUniformLocation(program, 'uThemeLight')
    const buffer = gl.createBuffer()
    if (!buffer || position < 0 || !time || !resolution || !opacity || !seed || !themeLight) {
      console.error('[IntroFluidBackground] program locations unavailable', {
        buffer: Boolean(buffer), position, time, resolution, opacity, seed, themeLight, contextLost: gl.isContextLost(), error: gl.getError(),
      })
      return
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    let width = 1
    let height = 1
    // 像素化：把内部分辨率进一步压低（总像素约降到 1/16），CSS 拉伸成全屏像素块。
    // 既降低每帧 GPU 负载，又形成"像素块"观感；配合 CSS image-rendering: pixelated。
    const PIXEL_SCALE = 0.25
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = Math.max(1, Math.round(rect.width * dpr * PIXEL_SCALE))
      height = Math.max(1, Math.round(rect.height * dpr * PIXEL_SCALE))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }
    resize()
    console.info('[IntroFluidBackground] initialized', {
      contextLost: gl.isContextLost(),
      canvas: { rect: canvas.getBoundingClientRect().toJSON(), width: canvas.width, height: canvas.height },
      debugSolidOutput: DEBUG_SOLID_OUTPUT,
    })
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const started = performance.now()
    const seedValue = Math.random() * 1000
    let raf = 0
    let loggedFirstFrame = false
    // 30fps 节流：动画进度由 now-started 驱动，跳过绘制不影响真实时长，只降低每帧渲染开销。
    const FRAME_INTERVAL_MS = 1000 / 30
    let lastRenderedAt = 0
    const render = (now: number): void => {
      const elapsed = now - started
      if (!loggedFirstFrame) {
        loggedFirstFrame = true
        console.info('[IntroFluidBackground] first frame', { contextLost: gl.isContextLost(), error: gl.getError(), width, height })
      }
      const animationElapsed = repeat ? elapsed % durationMs : elapsed
      const progress = Math.min(1, animationElapsed / durationMs)
      const canRender = now - lastRenderedAt >= FRAME_INTERVAL_MS
      if (canRender) {
        lastRenderedAt = now
        const envelope = repeat
          ? Math.min(1, progress * 3.2)
          : Math.min(1, progress * 3.2) * Math.max(0, 1 - Math.max(0, progress - .84) / .16)
        gl.viewport(0, 0, width, height)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(program)
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.enableVertexAttribArray(position)
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
        gl.uniform1f(time, animationElapsed / 1000)
        gl.uniform2f(resolution, width, height)
        gl.uniform1f(opacity, envelope)
        gl.uniform1f(seed, seedValue)
        gl.uniform1f(themeLight, 0)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      if (repeat || progress < 1) raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      // 不要在此主动 loseContext：React Strict Mode 会立即执行一次 cleanup 后重挂载，
      // 同一 canvas 的 context 被主动丢失会导致第二次 shader 编译失败。
    }
  }, [durationMs, repeat])

  return <canvas ref={canvasRef} className="absolute inset-0 z-0 h-full w-full bg-black" style={{ imageRendering: 'pixelated' }} aria-hidden="true" />
}
