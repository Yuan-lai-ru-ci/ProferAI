/**
 * 平板端 electronAPI 最小 stub
 *
 * 目的：当平板复用桌面版组件（如 AgentMessages 及其依赖树）时，
 * 这些组件会偶发调用 window.electronAPI.saveImageAs / openExternal 等。
 * 在平板 Web 环境没有 Electron，这里提供一个安全的最小 stub，
 * 让被复用的组件在触碰边角功能时降级（no-op / 提示），而不会抛错崩掉核心渲染。
 *
 * 仅 stub 被复用组件实际用到的方法；未覆盖的调用会安全降级返回。
 */

function noop(..._args: unknown[]): unknown {
  return undefined
}

/** 常见但平板不需要真正实现的方法 → 安全空实现 */
const safeNoop = (): Promise<unknown> => Promise.resolve(undefined)

/**
 * 安装平板版 electronAPI stub。
 * 在业务 React 渲染之前调用（main.tsx 顶部）。
 */
export function installElectronApiStub(): void {
  const existing = (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  if (existing) return // 若已存在（Electron 环境）则不覆盖

  const stub: Record<string, unknown> = {
    // ---- 被复用组件实际用到的 ----
    saveImageAs: safeNoop,        // 图片另存为（桌面 IPC）→ 平板降级 no-op
    openExternal: noop,           // 打开外部链接 → 平板降级
    // ---- 常见桌面 IPC 通道：给合理默认，避免被复用组件因缺方法而炸 ----
    getSettings: () => Promise.resolve({}),
    updateSettings: safeNoop,
    getSystemTheme: () => Promise.resolve(true),
    getChannels: () => Promise.resolve([]),
    listChannels: () => Promise.resolve([]),
    getModels: () => Promise.resolve([]),
    listAgentSessions: () => Promise.resolve([]),
    getAgentSessionMeta: () => Promise.resolve(undefined),
  }

  // 用 Proxy 兜底：任何未显式 stub 的方法都返回安全空实现，杜绝 "undefined is not a function"
  const handler = {
    get(_target: Record<string, unknown>, prop: string): unknown {
      if (prop in _target) return _target[prop]
      // 常见 IPC 返回 Promise；纯函数返回 undefined
      if (prop.startsWith('get') || prop.endsWith('Async') || prop === 'invoke') {
        return safeNoop
      }
      return noop
    },
  }

  // 需要嵌套命名空间（electronAPI.team.*, electronAPI.chat.* 等）也 Proxy 化
  const makeDeepStub = (): Record<string, unknown> =>
    new Proxy({}, {
      get: (_t, p) => {
        if (typeof p === 'string') {
          // 返回一个可继续调用的深 stub：本身可被调用，也带嵌套
          const deepFn = (() => Promise.resolve(undefined)) as unknown as Record<string, unknown>
          return deepFn
        }
        return undefined
      },
      apply: () => Promise.resolve(undefined),
    })

  // 顶层也允许任意嵌套访问
  const top = new Proxy(stub, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p]
      if (typeof p === 'string') return makeDeepStub()
      return undefined
    },
  }) as unknown as Record<string, unknown>

  ;(globalThis as unknown as { electronAPI?: Record<string, unknown> }).electronAPI = top
  void handler
}

/** 检查当前是否在 Electron/有真实 electronAPI（供平板逻辑判断） */
export function hasRealElectronApi(): boolean {
  return Boolean((globalThis as unknown as { electronAPI?: unknown }).electronAPI)
}
