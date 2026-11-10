import { build } from 'esbuild'
import { resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '..')
const output = resolve(root, 'dist/browser-controller-smoke')
mkdirSync(output, { recursive: true })
await build({ entryPoints: [resolve(root, 'scripts/browser-controller-smoke-preload.ts')], outfile: resolve(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: [resolve(root, 'scripts/browser-controller-smoke-renderer.tsx')], outfile: resolve(output, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: resolve(root, 'tsconfig.json') })
const index = readFileSync(resolve(root, 'dist/renderer/index.html'), 'utf8')
const css = [...index.matchAll(/<link rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match => `<link rel="stylesheet" href="${pathToFileURL(resolve(root, 'dist/renderer', match[1]!)).href}">`).join('\n')
writeFileSync(resolve(output, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; script-src 'self'; style-src 'self' 'unsafe-inline' file:; font-src 'self' data: file:; img-src 'self' data:; frame-src 'self' about:">${css}<style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script src="./renderer.js"></script>`)
await build({
  entryPoints: [resolve(root, 'scripts/browser-controller-smoke.ts')],
  outfile: resolve(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
  external: ['electron', '@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'],
  define: { __PROFER_BUILD_TARGET__: '"oss"' },
})
const executable: unknown = require('electron')
if (typeof executable !== 'string') throw new Error('未找到 Electron 可执行文件')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = Bun.spawn([executable, resolve(output, 'main.cjs')], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
console.log(`[smoke-runner] electron pid=${child.pid}`)
const deadline = setTimeout(() => child.kill('SIGKILL'), 100_000)
try { process.exitCode = await child.exited } finally { clearTimeout(deadline) }
