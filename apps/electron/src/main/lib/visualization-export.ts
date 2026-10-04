import type { VisualizationContent, VisualizationViewState } from '@profer/shared'
import { VISUALIZATION_INLINE_CSS } from '../../shared/visualization-style'
import { renderFragmentMath } from '../../shared/visualization-math'
import { init, buildChartOption, nativeChartHeight } from '../../shared/visualization-chart'
import { validateViewState } from './visualization-validation'

/** 离线页面沿用有限状态 API，不带宿主身份、IPC 或文件授权。 */
export function buildVisualizationExport(content: VisualizationContent, state: VisualizationViewState): string {
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
  const appearance = `<style>:root{--background:0 0% 100%;--foreground:0 0% 3.9%;--muted:0 0% 96.1%;--muted-foreground:0 0% 45.1%;--border:0 0% 89.8%;--primary:0 0% 9%;--accent:0 0% 96.1%;--accent-foreground:0 0% 9%}${VISUALIZATION_INLINE_CSS}html,body{overflow:visible!important}</style>`
  const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let html = renderFragmentMath(content.html)
  if (content.record.chart) {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 736, height: nativeChartHeight(content.record.chart) })
    try {
      chart.setOption(buildChartOption(content.record.chart, { foreground: '#171717', muted: '#737373', border: '#e5e5e5', background: '#ffffff' }, state))
      const keys = Object.keys(content.record.chart.data[0] ?? {})
      html = `<h2>${escape(content.record.title)}</h2><p>${escape(content.record.summary)}</p>${chart.renderToSVGString()}<table><thead><tr>${keys.map((key) => `<th>${escape(key)}</th>`).join('')}</tr></thead><tbody>${content.record.chart.data.map((row) => `<tr>${keys.map((key) => `<td>${escape(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    } finally { chart.dispose() }
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${script}</head><body>${html}${appearance}</body></html>`
}
