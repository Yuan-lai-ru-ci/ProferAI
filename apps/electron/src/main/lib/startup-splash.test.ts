import { expect, test } from 'bun:test'

import { createCenteredStartupSplashBounds, createStartupSplashHtml, SPLASH_READY_TITLE, SPLASH_REVEAL_FALLBACK_MS } from './startup-splash'

test('centers the initial Splash at one quarter of the selected display work area', () => {
  expect(createCenteredStartupSplashBounds(
    { x: 0, y: 0, width: 1920, height: 1080 },
  )).toEqual({ x: 720, y: 405, width: 480, height: 270 })

  expect(createCenteredStartupSplashBounds(
    { x: 1920, y: 40, width: 2560, height: 1440 },
  )).toEqual({ x: 2880, y: 580, width: 640, height: 360 })
})

test('emits a themed warm-paper startup splash', () => {
  const darkHtml = createStartupSplashHtml(true)
  const lightHtml = createStartupSplashHtml(false)

  // 浅色是默认：米黄纸底；深色是近黑中性。两套只换颜色，结构一致。
  expect(lightHtml).toContain('#fcfbf8')
  expect(lightHtml).toContain('#f6f4ee')
  expect(lightHtml).toContain('#e9e6de')
  expect(darkHtml).toContain('#17181c')
  expect(darkHtml).toContain('#101114')

  // 窗口整体可拖动，文字不可选中
  expect(lightHtml).toContain('-webkit-app-region:drag')
  expect(lightHtml).toContain('user-select:none')
  expect(lightHtml).toContain('-webkit-user-select:none')
})

test('splash 不再使用 WebGL：移除 canvas、着色器与绘制循环', () => {
  const html = createStartupSplashHtml(true)

  // 这是「开屏卡」的主要来源：GPU 进程刚启动时跑全屏片元着色器
  expect(html).not.toContain("getContext('webgl'")
  expect(html).not.toContain('<canvas')
  expect(html).not.toContain('gl.drawArrays')
  expect(html).not.toContain('requestAnimationFrame(draw)')
  expect(html).not.toContain('float splashValue(')
  expect(html).not.toContain('uniform ')
})

test('暖纸由五层合成：纸基色、光、纸纤维、边缘衰光、颗粒', () => {
  const html = createStartupSplashHtml(false)

  expect(html).toContain('class="paper"')
  expect(html).toContain('class="light"')
  expect(html).toContain('class="fiber"')
  expect(html).toContain('class="vignette"')
  expect(html).toContain('class="grain"')

  // 纸纤维用 1px/3px 重复渐变，不是 canvas 纹理
  expect(html).toContain('repeating-linear-gradient(91deg')
  // 颗粒用 SVG feTurbulence；浅色 multiply，深色 screen
  expect(html).toContain('feTurbulence')
  expect(html).toContain('mix-blend-mode:multiply')
  expect(createStartupSplashHtml(true)).toContain('mix-blend-mode:screen')
})

test('保留斜体 Profer 字标与 Loading 状态行', () => {
  const html = createStartupSplashHtml(false)

  expect(html).toContain('font-style:italic')
  expect(html).toContain('skewX(-7deg)')
  expect(html).toContain('>Profer<')
  expect(html).toContain('>Loading<')
})

test('漂移与入场都尊重 prefers-reduced-motion', () => {
  const html = createStartupSplashHtml(false)

  expect(html).toContain('@media (prefers-reduced-motion:reduce)')
  // 减少动态时，字标入场与光源漂移都要停
  expect(html).toContain('.logo{animation:none}')
  expect(html).toContain('.light{animation:none}')
})

test('首帧提交后才回报就绪信号，避免纯色窗口先闪现', () => {
  const html = createStartupSplashHtml(true)

  expect(html).toContain(`document.title='${SPLASH_READY_TITLE}'`)
  // 连等两帧再回报，确保该帧已交给合成器而不是刚提交
  expect(html).toContain('requestAnimationFrame(function(){requestAnimationFrame(signalReady)})')
})

test('rAF 被节流时仍由定时器兜底发出就绪信号', () => {
  const html = createStartupSplashHtml(false)

  expect(html).toContain(`setTimeout(signalReady,${SPLASH_REVEAL_FALLBACK_MS})`)
  // 信号只发一次，重复调用不重复改标题
  expect(html).toContain('if(sent)return')
})
