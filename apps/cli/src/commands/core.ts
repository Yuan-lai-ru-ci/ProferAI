import { shutdownIndependentCore } from '@profer/session-store/execution-lock'
import { connectLocalCore, localCoreOwnerOptions } from '../local-core'
import { resolveConfigDir } from '../paths'
import { emitJson, emitText, EXIT_OK, UsageError } from '../output'
import { register } from '../registry'

const summaries = {
  status: '核对已运行的独立 Core（不会启动）',
  start: '启动或复用同一数据根的独立 Core',
  stop: '停止本机独立 Core，等待会话收尾和写锁释放',
} as const

for (const name of ['status', 'start', 'stop'] as const) {
  register({
    namespace: 'core',
    name,
    summary: summaries[name],
    usage: `core ${name} [--config-dir DIR] [--json]`,
    async run({ args, pathOpts, json }) {
      if (args.flags.help === true || args.positionals.length === 1 && args.positionals[0] === '-h') {
        emitText(`用法: profer core ${name} [--config-dir DIR] [--json]`)
        return EXIT_OK
      }
      if (args.positionals.length || args.flags['config-dir'] === true || args.flags['config-dir'] === '') throw new UsageError('请输入有效的 Core 配置目录参数')
      if (name === 'stop') {
        const stopped = await shutdownIndependentCore(resolveConfigDir(pathOpts), localCoreOwnerOptions())
        if (!stopped) throw new Error('未发现本机独立 Core')
        if (json) emitJson({ status: 'stopped', coreId: stopped.coreId })
        else emitText(`本机 Core 已停止：${stopped.coreId}`)
        return EXIT_OK
      }
      const { identity } = await connectLocalCore(pathOpts, { autoStart: name === 'start' }).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (name === 'status' && (code === 'ENOENT' || code === 'ESRCH')) {
          throw new Error('未发现独立 Core；可用 profer core start 启动同一数据根的服务')
        }
        throw error
      })
      if (json) emitJson({ status: 'running', ...identity })
      else emitText(`Core 正在运行：${identity.coreId}${identity.version ? `（${identity.version}）` : ''}`)
      return EXIT_OK
    },
  })
}
