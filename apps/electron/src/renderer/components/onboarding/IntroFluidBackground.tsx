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

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * .5 + .5;
  gl_Position = vec4(aPosition, 0., 1.);
}`

// 仅用于排障：确认 WebGL Canvas 是否真的可绘制。验证后必须恢复为 false。
const DEBUG_SOLID_OUTPUT = false

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uOpacity;
uniform float uSeed;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.;
  float amp = .5;
  for (int i = 0; i < 4; i++) {
    value += noise(p) * amp;
    p = p * 2.02 + vec2(17.2, 9.3);
    amp *= .5;
  }
  return value;
}

float random(float index) {
  return fract(sin(index * 91.73 + uSeed * 17.41) * 43758.5453);
}

float splash(vec2 p, vec2 center, float start, float size, float phase) {
  float age = max(0., uTime - start);
  float aspect = uResolution.x / uResolution.y;
  center = vec2((center.x - .5) * aspect, center.y - .5);
  // 各 splat 不同的非线性漂移；不像完整同心环。
  center += vec2(sin(age * .33 + phase), cos(age * .27 + phase)) * .018;
  vec2 q = p - center;
  q.x *= .72 + sin(phase) * .08;
  q = mat2(cos(phase), -sin(phase), sin(phase), cos(phase)) * q;
  float radius = .035 + age * (.062 + size * .018);
  float d = length(q);
  float ring = exp(-pow((d - radius) * (34. - age * 2.), 2.));
  float wake = exp(-d * 5.5) * (.5 + .5 * sin(d * 32. - age * 5. + phase));
  return (ring * .75 + wake * .18) * exp(-age * .19) * step(start, uTime);
}

void main() {
  if (${DEBUG_SOLID_OUTPUT ? 'true' : 'false'}) {
    // 明确可见的诊断色：出现即代表 context、program、draw、Canvas 尺寸与图层均正常。
    gl_FragColor = vec4(.04, .32, .82, 1.);
    return;
  }

  vec2 p = vec2((vUv.x - .5) * (uResolution.x / uResolution.y), vUv.y - .5);
  float t = uTime;

  // 可控随机：seed 在一次播放中固定，所以运动连续；每次重新挂载会换一组构图。
  // 位置限制在中心区域，避免随机源落到 Logo 之外或只剩边缘暗部。
  float h = 0.;
  h += splash(p, vec2(.50 + (random(1.) - .5) * .24, .54 + (random(2.) - .5) * .18), .10, .90, random(3.) * 6.28) * .24;
  h += splash(p, vec2(.34 + (random(4.) - .5) * .18, .58 + (random(5.) - .5) * .16), .42, .76, random(6.) * 6.28) * .20;
  h += splash(p, vec2(.66 + (random(7.) - .5) * .22, .48 + (random(8.) - .5) * .20), .78, .82, random(9.) * 6.28) * .18;
  h += splash(p, vec2(.46 + (random(10.) - .5) * .26, .66 + (random(11.) - .5) * .14), 1.12, .70, random(12.) * 6.28) * .16;
  h += splash(p, vec2(.72 + (random(13.) - .5) * .16, .60 + (random(14.) - .5) * .18), 1.52, .64, random(15.) * 6.28) * .14;
  h += splash(p, vec2(.28 + (random(16.) - .5) * .16, .46 + (random(17.) - .5) * .18), 1.92, .58, random(18.) * 6.28) * .12;
  h += splash(p, vec2(.56 + (random(19.) - .5) * .22, .40 + (random(20.) - .5) * .16), 2.32, .52, random(21.) * 6.28) * .10;
  h += splash(p, vec2(.42 + (random(22.) - .5) * .20, .72 + (random(23.) - .5) * .12), 2.72, .48, random(24.) * 6.28) * .08;
  // 多个 splat 相遇不能把整个画面推入白色：总扰动先压缩再取焦散。
  h = h / (1. + h * 1.2);

  // 基于扰动的局部折射：将连续波环拆为液态玻璃中的不规则高光片段。
  vec2 warp = vec2(
    fbm(p * 3.2 + vec2(t * .08, -t * .05)),
    fbm(p * 3.2 + vec2(-t * .06, t * .07))
  ) - .5;
  float fragment = smoothstep(.54, .82, fbm(p * 7. + warp * 2. + t * .12));
  // h 的峰值在 0.1 左右；不能再用高次 pow 把它压到 3/255 以下。
  // 使用阈值映射让真实扰动进入可见范围，仍由末端硬上限防止画面过曝。
  float caustic = smoothstep(.006, .22, h) * (.38 + fragment * .62);

  // 黑玻璃底色固定为近黑；细节仅在中下部的窄区域出现。
  float mask = exp(-pow((p.x - .08) * .88, 4.) - pow((p.y - .11) * 2.15, 4.));
  float sheen = exp(-pow((p.y - .57) * 5.4, 2.)) * .004;
  float light = min((caustic * .40 + sheen) * mask * uOpacity, .20);
  light += min(pow(caustic, 2.) * .10 * fragment * mask * uOpacity, .06);

  vec3 color = vec3(light * .72, light * .76, light * .84);
  gl_FragColor = vec4(color, 1.);
}`

export function IntroFluidBackground({ durationMs }: { durationMs: number }): React.ReactElement {
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
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
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
    const buffer = gl.createBuffer()
    if (!buffer || position < 0 || !time || !resolution || !opacity || !seed) {
      console.error('[IntroFluidBackground] program locations unavailable', {
        buffer: Boolean(buffer), position, time, resolution, opacity, seed, contextLost: gl.isContextLost(), error: gl.getError(),
      })
      return
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    let width = 1
    let height = 1
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = Math.max(1, Math.round(rect.width * dpr))
      height = Math.max(1, Math.round(rect.height * dpr))
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
    const render = (now: number): void => {
      const elapsed = now - started
      if (!loggedFirstFrame) {
        loggedFirstFrame = true
        console.info('[IntroFluidBackground] first frame', { contextLost: gl.isContextLost(), error: gl.getError(), width, height })
      }
      const progress = Math.min(1, elapsed / durationMs)
      const envelope = Math.min(1, progress * 3.2) * Math.max(0, 1 - Math.max(0, progress - .84) / .16)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      gl.uniform1f(time, elapsed / 1000)
      gl.uniform2f(resolution, width, height)
      gl.uniform1f(opacity, envelope)
      gl.uniform1f(seed, seedValue)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (progress < 1) raf = requestAnimationFrame(render)
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
  }, [durationMs])

  return <canvas ref={canvasRef} className="absolute inset-0 z-0 h-full w-full bg-black" aria-hidden="true" />
}
