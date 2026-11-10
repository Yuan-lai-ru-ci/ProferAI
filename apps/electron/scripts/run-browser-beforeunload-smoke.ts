import { build } from 'esbuild'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = resolve(import.meta.dir, '..')
const output = resolve(root, 'dist/browser-beforeunload-smoke')
mkdirSync(output, { recursive: true })
await build({ entryPoints: [resolve(root, 'scripts/browser-beforeunload-smoke.ts')], outfile: resolve(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable: unknown = require('electron')
if (typeof executable !== 'string') throw new Error('Electron executable not found')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = Bun.spawn([executable, resolve(output, 'main.cjs')], { cwd: root, env, stdout: 'inherit', stderr: 'inherit', detached: true })
const deadline = setTimeout(() => {
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}, 22_000)
try { process.exitCode = await child.exited } finally { clearTimeout(deadline) }
