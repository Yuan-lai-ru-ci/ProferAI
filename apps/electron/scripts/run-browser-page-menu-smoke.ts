import { build } from 'esbuild'
import { resolve, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '..')
const output = join(root, 'dist/browser-page-menu-smoke')
mkdirSync(output, { recursive: true })
await build({ entryPoints: [join(root, 'scripts/browser-page-menu-smoke.tsx')], outfile: join(output, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: join(root, 'tsconfig.json') })
await build({ entryPoints: [join(root, 'scripts/browser-page-menu-smoke-main.ts')], outfile: join(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const index = readFileSync(join(root, 'dist/renderer/index.html'), 'utf8')
const css = [...index.matchAll(/<link rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match => `<link rel="stylesheet" href="${pathToFileURL(resolve(root, 'dist/renderer', match[1]!)).href}">`).join('\n')
writeFileSync(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; script-src 'self'; style-src 'self' 'unsafe-inline' file:; font-src 'self' data: file:; img-src 'self' data:">${css}<style>html,body,#root{width:100%;height:100%;margin:0}</style><div id="root"></div><script src="./renderer.js"></script>`)
const executable: unknown = require('electron')
if (typeof executable !== 'string') throw new Error('未找到 Electron 可执行文件')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = Bun.spawn([executable, join(output, 'main.cjs')], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000)
try { process.exitCode = await child.exited } finally { clearTimeout(deadline) }
