import type { VisualizationContent, VisualizationViewState } from '@profer/shared'
import { VISUALIZATION_INLINE_CSS } from '../../shared/visualization-style'
import { renderFragmentMath } from '../../shared/visualization-math'
import { init, buildChartOption, chartThemeFromTokens, nativeChartHeight } from '../../shared/visualization-chart'
import { normalizeVisualizationTheme, serializeVisualizationThemeCss } from '../../shared/visualization-theme'
import { validateViewState } from './visualization-validation'

/**
 * 导出静态页的浅色基线声明：没有传宿主主题时（程序化导出/旧调用方）用它；
 * 传了主题就在后面覆盖——CSS 同属性后写的生效，不需要先删基线。
 */
const EXPORT_BASE_DECLARATIONS = '--background:0 0% 100%;--foreground:0 0% 3.9%;--muted:0 0% 96.1%;--muted-foreground:0 0% 45.1%;--border:0 0% 89.8%;--input:0 0% 89.8%;--ring:0 0% 3.9%;--primary:0 0% 9%;--primary-foreground:0 0% 98%;--secondary:0 0% 96.1%;--secondary-foreground:0 0% 9%;--accent:0 0% 96.1%;--accent-foreground:0 0% 9%;--card:0 0% 100%;--card-foreground:0 0% 3.9%;--destructive:0 84.2% 60.2%;--destructive-foreground:0 0% 98%;--success:142 71% 45%;--warning:38 92% 50%;--info:217 91% 60%;--code-bg:210 13% 12%;--code-fg:0 0% 94%;--radius:0.625rem'

/** 离线页面沿用有限状态 API，不带宿主身份、IPC 或文件授权。 */
export function buildVisualizationExport(content: VisualizationContent, state: VisualizationViewState, theme?: unknown): string {
  const snapshot = JSON.stringify(validateViewState(state)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const script = `<script>(function(){
    var initial=${snapshot};
    var state=initial;
    var dispatching=false;
    function copy(value){var json=JSON.stringify(value);if(!value||typeof value!=='object'||Array.isArray(value)||new TextEncoder().encode(json).byteLength>16384)throw new Error('Invalid visualization state');return JSON.parse(json);}
    function notify(){if(dispatching)return;dispatching=true;try{window.dispatchEvent(new CustomEvent('stateUpdated',{detail:copy(state)}));}finally{dispatching=false;}}
    window.proferVisualization=Object.freeze({getState:function(){return copy(state);},setState:function(value){if(dispatching)return;state=copy(value);notify();},selectObject:function(){}});
    document.addEventListener('DOMContentLoaded',function(){state=initial;notify();},{once:true});
  })();</script>`
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">`
  // 导出页是静态单文件：先把当前主题（含皮肤）烘进去，缺省走浅色基线。
  // 不烘的主题会变成“深色皮肤导出一张白底图”，这也是基座不完善的一部分。
  const tokens = normalizeVisualizationTheme(theme)
  const themeDeclarations = serializeVisualizationThemeCss(tokens)
  const appearance = `<style>:root{${EXPORT_BASE_DECLARATIONS}${themeDeclarations ? `${themeDeclarations};` : ''}}${VISUALIZATION_INLINE_CSS}html,body{overflow:visible!important}</style>`
  const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let html = renderFragmentMath(content.html)
  if (content.record.chart) {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 736, height: nativeChartHeight(content.record.chart) })
    try {
      chart.setOption(buildChartOption(content.record.chart, chartThemeFromTokens(tokens), state))
      const keys = Object.keys(content.record.chart.data[0] ?? {})
      html = `<h2>${escape(content.record.title)}</h2><p>${escape(content.record.summary)}</p>${chart.renderToSVGString()}<table><thead><tr>${keys.map((key) => `<th>${escape(key)}</th>`).join('')}</tr></thead><tbody>${content.record.chart.data.map((row) => `<tr>${keys.map((key) => `<td>${escape(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    } finally { chart.dispose() }
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${script}</head><body>${html}${appearance}</body></html>`
}
