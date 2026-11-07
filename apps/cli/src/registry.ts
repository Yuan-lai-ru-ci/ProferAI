/**
 * 命令注册表。新增命令 = 在 commands/ 下加一个文件并 register() —— 扩面只加文件，不动主入口。
 *
 * 命名空间：命令可以声明 `namespace`（如 'session' / 'profile'），
 * 调用形式为 `profer <namespace> <name>`。为兼容历史用法，
 * 顶层查找会回落到 `session` 命名空间，所以 `profer list` 仍然可用。
 */
import type { ParsedArgs } from './args'
import type { PathOptions } from './paths'
import { type CommandExit, UsageError } from './output'

export interface CommandContext {
  args: ParsedArgs
  /** 从全局 flag 解析出的路径选项（--config-dir / --dev / PROFER_DEV）。 */
  pathOpts: PathOptions
  /** 是否输出机器可读 JSON（--json）。 */
  json: boolean
}

export interface Command {
  name: string
  /** 命名空间；不填表示顶层命令。 */
  namespace?: string
  summary: string
  /** 一行用法示例（不含 "profer " 前缀）。 */
  usage: string
  run: (ctx: CommandContext) => Promise<CommandExit> | CommandExit
}

const registry = new Map<string, Command>()

function keyOf(cmd: Command): string {
  return cmd.namespace ? `${cmd.namespace}:${cmd.name}` : cmd.name
}

export function register(cmd: Command): void {
  registry.set(keyOf(cmd), cmd)
}

/**
 * 查找命令。
 *
 * - 指定 namespace：先查 `namespace:name`，再回落顶层同名命令
 * - 未指定 namespace：先查顶层，再回落 `session:name`（兼容 `profer list`）
 */
export function getCommand(name: string, namespace?: string): Command | undefined {
  if (namespace) return registry.get(`${namespace}:${name}`) ?? registry.get(name)
  return registry.get(name) ?? registry.get(`session:${name}`)
}

/** 某个命名空间下的命令（undefined = 顶层命令）。 */
export function commandsInNamespace(namespace?: string): Command[] {
  return [...registry.values()].filter((cmd) => cmd.namespace === namespace)
}

export function allCommands(): Command[] {
  return [...registry.values()]
}

export { UsageError }
