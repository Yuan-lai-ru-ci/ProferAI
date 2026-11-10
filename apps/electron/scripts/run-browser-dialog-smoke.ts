import { build } from 'esbuild'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
const root = resolve(import.meta.dir, '..')
const output = resolve(root, 'dist/browser-dialog-smoke')
mkdirSync(output, { recursive: true })
await build({ entryPoints: [resolve(root, 'scripts/browser-dialog-smoke.ts')], outfile: resolve(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable: unknown = require('electron')
if (typeof executable !== 'string') throw new Error('未找到Electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = Bun.spawn([executable, resolve(output, 'main.cjs')], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000)
try { process.exitCode = await child.exited } finally { clearTimeout(deadline) }
