import { INTRO_FLUID_FRAGMENT_SHADER, INTRO_FLUID_VERTEX_SHADER } from '../../shared/intro-fluid-shader'

/**
 * 生成冷启动独立窗口的原始 WebGL Splash HTML。
 *
 * Windows 下可通过显式 PROFER_ANGLE_BACKEND=d3d11on12 选择兼容性后端；该开关
 * 作用于整个 Electron 进程，默认不启用。Splash 的原始 WebGL 视觉结构保持不变。
 */
export function createStartupSplashHtml(isDark: boolean): string {
  const background = isDark ? '#0b0b0c' : '#f7f7f5'
  const foreground = isDark ? '#f3f3f3' : '#101114'
  const highlight = isDark ? '#aeb4bd' : '#3c414a'
  const muted = isDark ? 'rgba(243,243,243,.28)' : 'rgba(16,17,20,.46)'
  const vertex = JSON.stringify(INTRO_FLUID_VERTEX_SHADER)
  const fragment = JSON.stringify(INTRO_FLUID_FRAGMENT_SHADER)

  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${background};color:${foreground};font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;-webkit-user-select:none}
    body{display:grid;place-items:center;-webkit-app-region:drag}.stage{position:relative;width:100vw;height:100vh;display:grid;place-items:center;background:${background};-webkit-app-region:drag}
    #fluid{position:absolute;inset:0;width:100%;height:100%}.glow{position:absolute;width:min(58vw,720px);height:min(58vw,720px);border-radius:50%;background:radial-gradient(circle,${highlight}18 0%,transparent 66%);filter:blur(28px);animation:breathe 2.8s ease-in-out infinite;pointer-events:none}
    .logo{position:relative;z-index:2;font-size:clamp(52px,10vw,112px);font-weight:600;font-style:italic;letter-spacing:-.045em;transform:skewX(-7deg);text-shadow:0 0 28px ${highlight}28;animation:rise 1.1s cubic-bezier(.22,1,.36,1) both}.status{position:absolute;z-index:2;bottom:8%;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.32em;text-transform:uppercase;color:${muted};animation:pulse 1.8s ease-in-out infinite}
    @keyframes rise{from{opacity:0;transform:translateY(18px) skewX(-7deg) scale(.96)}to{opacity:1;transform:translateY(0) skewX(-7deg) scale(1)}}@keyframes breathe{0%,100%{opacity:.35;transform:scale(.86)}50%{opacity:.8;transform:scale(1.08)}}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.8}}
  </style></head><body><main class="stage"><canvas id="fluid"></canvas><div class="glow"></div><div class="logo">Profer</div><div class="status">Loading</div></main><script>
  (function(){var c=document.getElementById('fluid'),gl=c.getContext('webgl',{alpha:false,antialias:false}),dark=${isDark ? 'true' : 'false'};if(!gl)return;function shader(type,src){var x=gl.createShader(type);if(!x)return null;gl.shaderSource(x,src);gl.compileShader(x);return gl.getShaderParameter(x,gl.COMPILE_STATUS)?x:null}var v=shader(gl.VERTEX_SHADER,${vertex}),f=shader(gl.FRAGMENT_SHADER,${fragment});if(!v||!f)return;var p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))return;var b=gl.createBuffer(),a=gl.getAttribLocation(p,'aPosition'),time=gl.getUniformLocation(p,'uTime'),res=gl.getUniformLocation(p,'uResolution'),op=gl.getUniformLocation(p,'uOpacity'),seed=gl.getUniformLocation(p,'uSeed'),theme=gl.getUniformLocation(p,'uThemeLight'),continuous=gl.getUniformLocation(p,'uContinuous');if(!b||a<0||!time||!res||!op||!seed||!theme||!continuous)return;gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);var w=1,h=1,started=performance.now(),seedValue=Math.random()*1000;function resize(){var r=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,1.5),nw=Math.max(1,Math.round(r.width*d)),nh=Math.max(1,Math.round(r.height*d));if(nw===w&&nh===h)return;w=nw;h=nh;c.width=w;c.height=h}resize();if(typeof ResizeObserver!=='undefined')new ResizeObserver(resize).observe(c);addEventListener('resize',resize);function draw(now){var elapsed=now-started;gl.viewport(0,0,w,h);gl.clearColor(dark?.043:.969,dark?.043:.969,dark?.047:.961,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);gl.uniform1f(time,elapsed/625);gl.uniform2f(res,w,h);gl.uniform1f(op,1);gl.uniform1f(seed,seedValue);gl.uniform1f(theme,dark?0:1);gl.uniform1f(continuous,0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);requestAnimationFrame(draw)}requestAnimationFrame(draw)})();
  </script></body></html>`
}
