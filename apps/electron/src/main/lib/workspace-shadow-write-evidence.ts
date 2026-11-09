/**
 * Shadow Git 的写入证据账本（两条链共用一份）。
 *
 * 为什么单独成模块：
 * 旧编排器与新 runtime 链都需要「本轮 runtime 声明自己写过什么」这份顺序账本，
 * 归属判断（树差异 × 证据）只在 `workspace-shadow-turns.ts` 里做。把证据的**采集规则**
 * 复制两份，最容易出现的后果是同一个写入在两条链里被判成不同来源（write / edit / bash），
 * 回退时的合并方向就会反过来。
 *
 * 边界：本模块只记账，不读磁盘、不判断文件是否真的变了——那是树差异的事。
 */

export type ShadowWriteSource = 'write' | 'edit' | 'bash' | 'unknown'

/** 一条写入证据；`seq` 是本轮内的发生顺序。 */
export interface ShadowWriteFact {
  seq: number
  path: string
  source: ShadowWriteSource
  toolUseId?: string
  toolName?: string
  /** 内容引用（不是内容本身）：同一份文件在两个对象库里各存一份没有意义。 */
  beforeRef?: string
  afterRef?: string
}

/**
 * 两次上报是否是同一个路径。
 *
 * tool_use 里模型可能写相对路径（`note.md`），而回调上报绝对路径；
 * 只按字符串相等去重会把同一次写入记成两条，其中一条还会掉进「工作区外」。
 */
export function sameEvidencePath(left: string, right: string): boolean {
  if (left === right) return true
  const a = left.replace(/\\/g, '/').replace(/\/+$/, '')
  const b = right.replace(/\\/g, '/').replace(/\/+$/, '')
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * 写入类工具 → 入参里的路径字段。
 *
 * 只认真正会写文件的工具：Bash 不在表里，因为它改了什么只有树差异知道，
 * 从命令行文本猜路径会把 `echo > a` 之类的写法误判成受控写入。
 */
const WRITE_TOOL_PATH_KEYS: Record<string, { keys: string[]; source: 'write' | 'edit' }> = {
  Write: { keys: ['file_path', 'path'], source: 'write' },
  write: { keys: ['file_path', 'path'], source: 'write' },
  Edit: { keys: ['file_path', 'path'], source: 'edit' },
  edit: { keys: ['file_path', 'path'], source: 'edit' },
  MultiEdit: { keys: ['file_path', 'path'], source: 'edit' },
  multi_edit: { keys: ['file_path', 'path'], source: 'edit' },
  NotebookEdit: { keys: ['notebook_path', 'file_path'], source: 'edit' },
}

/**
 * 从写入类工具的入参取路径。
 *
 * 为什么对两个 runtime 都要跑：OpenAI 兼容渠道下的 Pi 会把写入交给 `Write`
 * 这类工具执行，不走 Profer 自己的受控写入回调（`onFileWrite` / `onFileMutation`
 * 都不会触发）。只靠回调时，真实一轮里明明写了文件，归属却记成 unconfirmed。
 * 回调能触发时再用绝对路径与内容引用把同一条证据补全（见 `ShadowEvidenceLedger.push`）。
 */
export function resolveWriteToolFact(
  toolName: string,
  input: Record<string, unknown>,
): { path: string; source: 'write' | 'edit' } | undefined {
  const spec = WRITE_TOOL_PATH_KEYS[toolName]
  if (!spec) return undefined
  for (const key of spec.keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return { path: value, source: spec.source }
  }
  return undefined
}

export interface ShadowEvidenceLedger {
  /** 记一条证据；同一 toolUseId + 同一路径的重复上报会合并而不是新增。 */
  push(fact: Omit<ShadowWriteFact, 'seq'>): void
  /** 按发生顺序导出。 */
  list(): ShadowWriteFact[]
  /** 某个 tool_use 的全部证据（UI 展示 / 诊断用）。 */
  byToolUse(toolUseId: string): ShadowWriteFact[]
  size(): number
}

/**
 * 顺序账本。
 *
 * 合并规则（与旧链逐条一致）：同一次写入被两个来源报到时，保留绝对路径，
 * 并把回调带来的内容引用补上；顺序仍按首次出现，不重排。
 */
export function createShadowEvidenceLedger(): ShadowEvidenceLedger {
  const evidence: ShadowWriteFact[] = []
  const byTool = new Map<string, ShadowWriteFact[]>()
  return {
    push(fact) {
      const siblings = fact.toolUseId ? byTool.get(fact.toolUseId) : undefined
      const existing = siblings?.find(item => sameEvidencePath(item.path, fact.path))
      if (existing) {
        if (!existing.path.startsWith('/') && fact.path.startsWith('/')) existing.path = fact.path
        if (fact.beforeRef && !existing.beforeRef) existing.beforeRef = fact.beforeRef
        if (fact.afterRef && !existing.afterRef) existing.afterRef = fact.afterRef
        if (fact.toolName && !existing.toolName) existing.toolName = fact.toolName
        return
      }
      const item: ShadowWriteFact = { seq: evidence.length + 1, ...fact }
      evidence.push(item)
      if (fact.toolUseId) byTool.set(fact.toolUseId, [...(siblings ?? []), item])
    },
    list: () => evidence,
    byToolUse: toolUseId => byTool.get(toolUseId) ?? [],
    size: () => evidence.length,
  }
}
