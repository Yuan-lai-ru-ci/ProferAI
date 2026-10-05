/**
 * 宿主提供阅读与控件基线；生成内容只负责信息布局和图形，不另建页面外壳。
 *
 * 与 app 的关系：这里的按钮、面板、表格、代码块不另建一套设计语言——圆角走 `--radius`，
 * 描边走 `--input`/`--border`/`--panel-border`，底色走 `--background`/`--panel-surface`/`--code-bg`。
 * 这些 token 的值由 `shared/visualization-theme.ts` 从 app 文档的计算值搬运过来
 * （含皮肤）。写死颜色/圆角会让片段在换肤后与 app 脱节，新增规则一律用 token + fallback。
 *
 * Agent-facing contract; keep in sync with SKILL.md（见 `VISUALIZATION_HOST_PRIMITIVES`
 * 与 `visualization-host-contract.test.ts`：清单里的每一项都必须同时出现在本文档和内置
 * `present-visualization` Skill 正文里）。
 */
export const VISUALIZATION_INLINE_CSS = `
#widget{display:flex;flex-direction:column;gap:12px;width:100%;background:transparent}
#widget>.page-shell{padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important}
.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}
.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.text-muted{color:hsl(var(--muted-foreground))}
.text-destructive{color:hsl(var(--destructive))}
.sr-only{position:absolute;width:1px;height:1px;padding:0!important;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0!important}
.viz-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:var(--radius-pill,999px);font-size:12px;line-height:1.7;background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
.btn{display:inline-flex;align-items:center;gap:6px}
.btn-block{width:100%;justify-content:center}
.btn-primary{background:hsl(var(--primary))!important;color:hsl(var(--primary-foreground))!important;border-color:hsl(var(--primary))!important}
.btn-ghost{background:transparent!important;border-color:transparent!important}
.form-label{display:block;font-size:12px;color:hsl(var(--muted-foreground));margin-bottom:4px}
.form-control,.form-select{width:100%;min-height:28px}
.form-range{width:100%;accent-color:hsl(var(--primary))}
.form-check{display:flex;align-items:center;gap:6px;font-size:13px}
.form-check-label{font-size:13px}
.form-check-input{width:14px!important;height:14px!important;padding:0!important;border:0!important;background:transparent!important;accent-color:hsl(var(--primary))}
.form-switch .form-check-input{appearance:none;position:relative;width:28px!important;height:16px!important;border-radius:var(--radius-pill,999px)!important;background:hsl(var(--muted))!important;border:1px solid hsl(var(--border))!important;transition:background .15s ease}
.form-switch .form-check-input:checked{background:hsl(var(--primary))!important;border-color:hsl(var(--primary))!important}
.form-switch .form-check-input::before{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:var(--radius-pill,999px);background:hsl(var(--background));transition:transform .15s ease}
.form-switch .form-check-input:checked::before{transform:translateX(12px)}
.table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.table caption{caption-side:top;text-align:left;font-size:12px;color:hsl(var(--muted-foreground));padding-bottom:6px}
.table th,.table td{padding:6px 10px;border-bottom:1px solid hsl(var(--border));text-align:left;vertical-align:top}
.table thead th{font-weight:600;font-size:12px;color:hsl(var(--muted-foreground))}
.table tbody tr:last-child th,.table tbody tr:last-child td{border-bottom:0}
.table .text-end,.table [align="right"]{text-align:right}
.table .text-center,.table [align="center"]{text-align:center}
.table-sm th,.table-sm td{padding:3px 8px}
.table-responsive{overflow-x:auto}
.text-end{text-align:right}.text-center{text-align:center}.text-nowrap{white-space:nowrap}
html,body{margin:0!important;padding:0!important;width:100%!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:hidden!important;background:transparent!important}
/* 正文 14px 只压在 body 上：html 保留默认 16px 根字号，否则 --radius（0.625rem）这类 rem 长度
 * 会被缩到 8.75px，片段里的 calc(var(--radius) - 2px) 也与 app 对不上。 */
body{display:flow-root!important;color:hsl(var(--foreground))!important;font-family:var(--profer-font-family,system-ui,sans-serif)!important;font-size:14px!important;line-height:1.6!important}
*,*::before,*::after{box-sizing:border-box}
h1,h2,h3,h4{font-family:inherit!important;font-weight:600!important;line-height:1.4!important;letter-spacing:-.015em!important;margin:0 0 12px!important;color:inherit!important}
h1,h2{font-size:18px!important}h3,h4{font-size:15px!important}
p{margin:0 0 12px}p:last-child{margin-bottom:0}
button,input,select,textarea{font:inherit!important;color:inherit!important;border:1px solid hsl(var(--input,var(--border)))!important;border-radius:max(0px,calc(var(--radius,0.625rem) - 2px))!important;background:hsl(var(--background))!important;box-shadow:none!important}
button{padding:6px 12px!important;cursor:pointer;line-height:1.5!important;font-size:13px!important;font-weight:500!important}
button:hover{background:hsl(var(--muted))!important}button:disabled{opacity:.5;cursor:default}
button[aria-pressed=true],button[aria-selected=true]{background:hsl(var(--accent))!important;color:hsl(var(--accent-foreground))!important}
:focus-visible{outline:2px solid hsl(var(--ring,var(--primary)));outline-offset:2px}
input,select,textarea{padding:6px 10px!important}
img,svg,canvas{max-width:100%}
pre{margin:0 0 12px;padding:10px 12px;border-radius:var(--radius,0.625rem);background:hsl(var(--code-bg,var(--muted)));color:hsl(var(--code-fg,var(--foreground)));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.55;overflow-x:auto}
pre:last-child{margin-bottom:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:not(pre)>code{padding:1px 5px;border-radius:max(0px,calc(var(--radius,0.625rem) - 6px));background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
[data-profer-columns]{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))!important;gap:12px!important}
[data-profer-panel]{padding:12px 16px!important;border:1px solid hsl(var(--panel-border,var(--border)))!important;border-radius:var(--radius,0.625rem)!important;background:hsl(var(--panel-surface,var(--muted))/.35)!important;color:inherit!important;box-shadow:none!important}
[data-profer-caption]{font-size:12px!important;color:hsl(var(--muted-foreground))!important}
math[display="block"]{margin:6px 0!important;font-size:1.05em!important}
`

/**
 * 生成侧唯一可依赖的宿主契约清单（标点写成实际书写的形式）。
 *
 * 每一项都必须同时出现在 `VISUALIZATION_INLINE_CSS` 与内置 `present-visualization`
 * Skill 正文里——Codex 的 `visualize.css` 用注释要求“与 SKILL.md 保持同步”，这里把
 * 那条注释变成会失败的测试，避免契约和文档各说各话。
 */
export const VISUALIZATION_HOST_PRIMITIVES = [
  '#widget',
  '.viz-grid',
  '.viz-controls',
  '.viz-badge',
  '[data-profer-columns]',
  '[data-profer-panel]',
  '[data-profer-caption]',
  '.btn',
  '.btn-primary',
  '.btn-ghost',
  '.btn-block',
  '.form-label',
  '.form-control',
  '.form-select',
  '.form-range',
  '.form-check',
  '.form-check-input',
  '.form-check-label',
  '.form-switch',
  '.table',
  '.table-sm',
  '.table-responsive',
  '.text-end',
  '.text-center',
  '.text-nowrap',
  '.text-muted',
  '.text-destructive',
  '.sr-only',
  'pre',
  'code',
] as const
