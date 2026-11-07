#!/usr/bin/env bun
/**
 * profer — Profer 命令行工具入口。
 *
 * 用法：
 *   profer <command> [subcommand] [args] [--flags]
 *   profer session list|info|outline|search|export ...
 *   profer profile show|get|set|context|search ...
 *
 * 全局 flag：
 *   --json            输出机器可读 JSON
 *   --config-dir DIR  指定 Profer 配置目录（默认 ~/.profer，PROFER_DEV=1 → ~/.profer-dev）
 *   --dev             使用 ~/.profer-dev
 *
 * 设计：命令注册表驱动（registry.ts）。`session` 与 `profile` 是命名空间，
 * 其下的命令各自在 commands/ 注册。扩面只加文件。
 */
import { parseArgs, boolFlag, strFlag } from './args'
import { getCommand, commandsInNamespace } from './registry'
import { EXIT_OK, EXIT_USAGE, EXIT_ERROR, UsageError, errorLine, info, emitText } from './output'
import type { PathOptions } from './paths'

// 注册命令（import 即注册）
import './commands/list'
import './commands/info'
import './commands/outline'
import './commands/search'
import './commands/export'
import './commands/profile'

/** 已知命名空间。`session` 的命令历史上注册为顶层名，查找时会回落到顶层。 */
const NAMESPACES = ['session', 'profile'] as const

function printSection(title: string, commands: ReturnType<typeof commandsInNamespace>): void {
  if (commands.length === 0) return
  info(`${title}:`)
  for (const c of commands) {
    info(`  ${c.usage.padEnd(72)} ${c.summary}`)
  }
  info('')
}

function printHelp(): void {
  info('profer — Profer 命令行工具\n')
  info('用法: profer <namespace> <command> [args] [--flags]\n')
  printSection('会话（渐进式读取）', commandsInNamespace('session'))
  printSection('用户画像（跨工作区，无需 UI）', commandsInNamespace('profile'))
  const topLevel = commandsInNamespace(undefined)
  if (topLevel.length > 0) printSection('其它', topLevel)
  info('全局 flag: --json  --config-dir DIR  --dev')
  info('\n渐进式读取建议: 先 info/outline 看结构 → search 定位 → export --turns 取片段；探索分支用 export --after-message UUID 读取新增内容')
  info('画像用法建议: `profer profile context` 输出可直接拼进 system prompt 的画像块，任何 CLI Agent 都能消费')
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return EXIT_OK
  }

  // 命名空间：`profer session <cmd>` / `profer profile <cmd>`；
  // 顶层命令（`profer list`）保持兼容，因此查找时先按命名空间、再回落顶层。
  let rest = argv
  let namespace: string | undefined
  if ((NAMESPACES as readonly string[]).includes(argv[0] ?? '')) {
    namespace = argv[0]
    rest = argv.slice(1)
  }

  const cmdName = rest[0]
  if (!cmdName) {
    printHelp()
    return EXIT_USAGE
  }

  const command = (namespace ? getCommand(cmdName, namespace) : undefined) ?? getCommand(cmdName)
  if (!command) {
    errorLine(namespace ? `未知命令: ${namespace} ${cmdName}` : `未知命令: ${cmdName}`)
    printHelp()
    return EXIT_USAGE
  }

  const parsed = parseArgs(rest.slice(1))
  const pathOpts: PathOptions = {
    configDir: strFlag(parsed.flags, 'config-dir'),
    dev: boolFlag(parsed.flags, 'dev'),
  }
  const json = boolFlag(parsed.flags, 'json')

  try {
    return await command.run({ args: parsed, pathOpts, json })
  } catch (err) {
    if (err instanceof UsageError) {
      errorLine(err.message)
      info(`用法: profer ${command.usage}`)
      return EXIT_USAGE
    }
    errorLine(err instanceof Error ? err.message : String(err))
    return EXIT_ERROR
  }
}

main().then((code) => process.exit(code))
