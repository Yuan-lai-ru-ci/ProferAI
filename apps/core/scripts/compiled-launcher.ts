// Bun 编译程序通过 BUN_BE_BUN 作为原生解释器运行磁盘 bundle。
// 这使 external SDK 使用真实磁盘解析，保留 import.meta.url 和 native/WASM 资源。
import { dirname, join } from 'node:path'
const child = Bun.spawn([process.execPath, join(dirname(process.execPath), 'core.js'), ...process.argv.slice(2)], {
  env: { ...process.env, BUN_BE_BUN: '1' }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
process.exitCode = await child.exited
