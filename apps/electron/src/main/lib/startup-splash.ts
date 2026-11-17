export interface StartupSplashBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 以目标显示器工作区的四分之一尺寸居中生成 Splash 初始 bounds。 */
export function createCenteredStartupSplashBounds(workArea: StartupSplashBounds): StartupSplashBounds {
  const width = Math.max(1, Math.round(workArea.width * 0.25))
  const height = Math.max(1, Math.round(workArea.height * 0.25))
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  }
}

/**
 * Splash 首帧已提交到合成器的信号（写入 document.title）。
 *
 * 主进程靠它决定何时 show 窗口：did-finish-load 只代表 HTML 加载完，
 * 此时首帧通常还没画出来，窗口会先露出 backgroundColor 纯色再顶内容。
 *
 * 暖纸方案下首帧是纯 CSS 绘制（无 WebGL 编译/链接），通常一帧内就绪；
 * 但信号机制保持不变，避免主进程对不同渲染路径分叉。
 */
export const SPLASH_READY_TITLE = 'profer-splash-ready'

/**
 * 等首帧信号的兜底上限（ms）。
 *
 * 页面脚本异常时必须仍然显示 Splash，否则 splashShown 永远为 false，
 * 主窗口的 showWhenReady 会被一起卡死。所以到点无条件显示。
 */
export const SPLASH_REVEAL_FALLBACK_MS = 600

/**
 * 生成冷启动独立窗口的暖纸 Splash HTML。
 *
 * 视觉与仓库内开屏方案同源（A 暖纸）：米黄纸底 + 右上暖光 / 左下冷影 +
 * 横向纸纤维 + 颗粒 + 边缘衰光，前景是斜体 Profer 字标与 Loading 状态行。
 *
 * 关键设计取舍：
 * - **纯 CSS，零 WebGL**。旧实现在 GPU 进程刚启动、主窗口 3.4MB JS 正在解析的
 *   最拥挤时刻跑全屏片元着色器（每像素约 30 次噪声采样 × 4 层 fbm），且未同步
 *   renderer 侧的 30fps 节流，120Hz 屏上一秒重绘 120 次。这是用户反馈「开屏卡」
 *   的主要来源。CSS 渐变与 1px 重复纹理由合成器直接处理，开销低一个数量级。
 * - **不引入视频**。柔和浅色渐变恰是 H.264 压缩的色带重灾区，且视频无法在
 *   renderer 提前就绪时中途切断交接。
 * - 首帧提交后通过 document.title 回报 SPLASH_READY_TITLE，主进程据此决定 show 时机。
 */
export function createStartupSplashHtml(isDark: boolean): string {
  // 浅色：米黄纸；深色：近黑中性。两套只换颜色，结构完全一致。
  const paperLit = isDark ? '#17181c' : '#fcfbf8'
  const paperMid = isDark ? '#101114' : '#f6f4ee'
  const paperDeep = isDark ? '#09090a' : '#e9e6de'
  const warmLight = isDark ? 'rgba(148,162,184,.22)' : 'rgba(255,253,244,.95)'
  const coolShadow = isDark ? 'rgba(80,62,46,.30)' : 'rgba(200,212,230,.40)'
  const fiber = isDark ? 'rgba(255,255,255,.014)' : 'rgba(118,108,94,.032)'
  const vignette = isDark ? 'rgba(0,0,0,.46)' : 'rgba(94,84,70,.11)'
  const inkA = isDark ? '#ffffff' : '#0f1012'
  const inkB = isDark ? '#f2f4f6' : '#15171a'
  const inkC = isDark ? '#a4aab4' : '#3c4149'
  const statusColor = isDark ? 'rgba(255,255,255,.28)' : 'rgba(20,22,26,.30)'
  const grainOpacity = isDark ? '.15' : '.34'
  const grainBlend = isDark ? 'screen' : 'multiply'
  const edgeStrong = isDark ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.85)'
  const edgeSoft = isDark ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.5)'

  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${paperMid};color:${inkA};
      font-family:Inter,-apple-system,"PingFang SC",system-ui,"Segoe UI",sans-serif;
      user-select:none;-webkit-user-select:none;-webkit-app-region:drag}

    /* 窗口整体就是一张纸：冷启动小窗在 macOS 上由系统加圆角与投影 */
    .sheet{position:relative;width:100vw;height:100vh;overflow:hidden;isolation:isolate;
      display:grid;place-items:center;background:${paperMid}}

    /* 层序：纸基色 → 光 → 纸纤维 → 边缘衰光 → 颗粒 → 顶部高光 */
    .paper{position:absolute;inset:0;
      background:linear-gradient(163deg,${paperLit} 0%,${paperMid} 30%,${paperMid} 54%,${paperDeep} 100%)}
    .light{position:absolute;inset:-38%;
      background:radial-gradient(ellipse 44% 38% at 74% 15%,${warmLight},transparent 62%),
                 radial-gradient(ellipse 38% 44% at 20% 90%,${coolShadow},transparent 68%);
      animation:drift 64s ease-in-out infinite}
    .fiber{position:absolute;inset:0;opacity:.55;pointer-events:none;
      background-image:repeating-linear-gradient(91deg,${fiber} 0px,${fiber} 1px,transparent 1px,transparent 3px)}
    .vignette{position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(ellipse 76% 68% at 50% 44%,transparent 42%,${vignette} 100%)}
    .grain{position:absolute;inset:0;width:100%;height:100%;
      opacity:${grainOpacity};mix-blend-mode:${grainBlend};pointer-events:none}
    .edge{position:absolute;left:0;right:0;top:0;height:1px;
      background:linear-gradient(90deg,transparent,${edgeStrong} 30%,${edgeSoft} 62%,transparent)}

    /* 前景：斜体字标 + 状态行。入场「落墨」520ms，与主窗口交接无缝。 */
    .logo{position:relative;z-index:20;font-size:clamp(38px,16vw,64px);font-weight:600;font-style:italic;
      letter-spacing:-.045em;padding:0 .12em;white-space:nowrap;
      background-image:linear-gradient(176deg,${inkA} 0%,${inkB} 46%,${inkC} 100%);
      -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
      -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
      animation:inkIn 520ms cubic-bezier(.16,1,.3,1) both}
    .status{position:absolute;z-index:20;bottom:8.5%;left:50%;transform:translateX(-50%);
      font:8px ui-monospace,SFMono-Regular,Consolas,monospace;
      letter-spacing:.26em;text-transform:uppercase;white-space:nowrap;color:${statusColor}}

    /* 交接淡出：主进程在 renderer ready 后给 .sheet 加 fading，
       160ms 后关窗。与主窗口的背景色相近，过渡看起来是同一张纸铺开。 */
    .sheet{transition:opacity 160ms ease}
    .sheet.fading{opacity:0}

    @keyframes inkIn{
      from{opacity:0;filter:blur(6px);transform:skewX(-7deg) scale(1.03)}
      to{opacity:1;filter:blur(0);transform:skewX(-7deg) scale(1)}}
    @keyframes drift{
      0%,100%{transform:translate3d(0,0,0) scale(1)}
      50%{transform:translate3d(-1.8%,1.4%,0) scale(1.035)}}

    /* 尊重系统的减少动态偏好：静态呈现，不播入场与漂移 */
    @media (prefers-reduced-motion:reduce){
      .logo{animation:none}
      .light{animation:none}
    }
  </style></head><body><main class="sheet">
    <div class="paper"></div><div class="light"></div><div class="fiber"></div>
    <div class="vignette"></div>
    <svg class="grain" aria-hidden="true"><rect width="100%" height="100%" filter="url(#grain)"/></svg>
    <div class="edge"></div>
    <div class="logo">Profer</div>
    <div class="status">Loading</div>
  </main>
  <svg width="0" height="0" aria-hidden="true" style="position:absolute"><filter id="grain">
    <feTurbulence type="fractalNoise" baseFrequency=".86" numOctaves="3" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter></svg>
  <script>
  (function(){
    var sent=false;
    function signalReady(){if(sent)return;sent=true;document.title='${SPLASH_READY_TITLE}'}
    // 暖纸是纯 CSS 绘制，首帧在下一轮合成即可用。
    requestAnimationFrame(function(){requestAnimationFrame(signalReady)});
    // 兜底：窗口隐藏时 rAF 可能被节流，定时器保证信号仍然发出。
    setTimeout(signalReady,${SPLASH_REVEAL_FALLBACK_MS});
  })();
  </script></body></html>`
}
