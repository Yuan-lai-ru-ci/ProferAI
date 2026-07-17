/**
 * 轻量内存事件总线
 *
 * 用于 SSE 实时推送：维护 workspaceId → Set<stream> 映射，
 * 当服务端操作（文件变更、成员变动等）发生时，向所有已连接的 SSE 客户端广播事件。
 *
 * 注意：这是纯内存实现，重启后所有连接断开，客户端会自动重连。
 * 单进程部署场景下无需跨进程通信。
 */

/** @type {Map<string, Set<import('hono').Stream>>} */
const clients = new Map()

/**
 * 向指定工作区的所有 SSE 客户端广播事件
 * @param {string} workspaceId
 * @param {string} type - 事件类型，如 'file_updated', 'member_changed'
 * @param {object} data - 事件数据
 */
export function broadcastEvent(workspaceId, type, data) {
  const set = clients.get(workspaceId)
  if (!set || set.size === 0) return

  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

  for (const stream of set) {
    try {
      stream.write(payload)
    } catch {
      // 客户端已断开（stream 写入失败），从集合中移除
      set.delete(stream)
    }
  }

  // 清理空集合
  if (set.size === 0) {
    clients.delete(workspaceId)
  }
}

/**
 * 注册 SSE 客户端连接到指定工作区
 * @param {string} workspaceId
 * @param {import('hono').Stream} stream
 */
export function registerClient(workspaceId, stream) {
  if (!clients.has(workspaceId)) {
    clients.set(workspaceId, new Set())
  }
  clients.get(workspaceId).add(stream)
}

/**
 * 注销 SSE 客户端连接
 * @param {string} workspaceId
 * @param {import('hono').Stream} stream
 */
export function unregisterClient(workspaceId, stream) {
  const set = clients.get(workspaceId)
  if (!set) return
  set.delete(stream)
  if (set.size === 0) {
    clients.delete(workspaceId)
  }
}

/**
 * 获取活跃连接数（用于监控/调试）
 * @returns {{ workspaceId: string, connections: number }[]}
 */
export function getConnectionStats() {
  const stats = []
  for (const [workspaceId, set] of clients) {
    stats.push({ workspaceId, connections: set.size })
  }
  return stats
}
