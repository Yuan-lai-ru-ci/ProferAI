/**
 * 可视化容器高度的持久化（渲染进程 localStorage，不进主进程/不进记录存储）。
 *
 * 为什么要持久化：高度是「上一次渲染量出来的」，只存在内存里的话，重启后每个可视化
 * 首次挂载都会用 240px 占位、过一会儿才跳成真实高度（实测 130ms 后），下方内容整段位移 ——
 * 滚动时看到的就是「卡手」。持久化之后盒子一开始就是对的，也顺手满足
 * 「内容加载不出来时容器也保持那个高度」。
 *
 * 设计约束：
 * - 只存数字，按会话分桶、条数封顶，避免无限增长；
 * - 写入合并 500ms 一次：高度上报是高频事件，不要每次都序列化；
 * - localStorage 不可用（隐私模式/配额）时静默降级成纯内存缓存。
 */

const STORAGE_KEY = 'profer:visualization-heights'
const MAX_ENTRIES = 200

let storageOverride: Pick<Storage, 'getItem' | 'setItem'> | null | undefined

/** 测试用：注入假 storage；传 null 表示不可用。 */
export function configureVisualizationHeightStorage(storage: Pick<Storage, 'getItem' | 'setItem'> | null): void {
  storageOverride = storage
  cache = null
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
}

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (storageOverride !== undefined) return storageOverride
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * stateKey → 高度。key 里已经含 sessionId（`[sessionId,id,revision]`），
 * 所以不需要再按会话分桶，也就避免了 `atomFamily` 只能有一个参数的限制。
 */
let cache: Map<string, number> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function entries(): Map<string, number> {
  if (cache) return cache
  const entries = new Map<string, number>()
  const raw = storage()?.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) entries.set(key, value)
        }
      }
    } catch {
      // 坏数据就当没存过，不阻塞渲染。
    }
  }
  cache = entries
  return entries
}

export function readPersistedVisualizationHeight(key: string): number | null {
  return entries().get(key) ?? null
}

export function rememberVisualizationHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return
  const table = entries()
  if (table.get(key) === height) return
  table.delete(key)
  table.set(key, height)
  while (table.size > MAX_ENTRIES) table.delete(table.keys().next().value!)
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; flushVisualizationHeights() }, 500)
}

/** 立即落盘（测试与卸载前调用）。 */
export function flushVisualizationHeights(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  const target = storage()
  if (!cache || !target) return
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)))
  } catch {
    // 配额/隐私模式：静默降级，内存缓存仍然有效。
  }
}
