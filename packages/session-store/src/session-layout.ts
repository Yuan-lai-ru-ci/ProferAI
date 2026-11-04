/**
 * 会话存储布局注册表
 *
 * 会话消息/任务图/Harness 账本的落盘位置取决于会话所属工作区的模式：
 * - managed：`<configDir>/agent-sessions/<sessionId>.jsonl`（历史布局，保持不变）
 * - project：`<rootPath>/.profer/sessions/<sessionId>/messages.jsonl`（随项目文件夹走）
 *
 * 路径函数（`sessionMessagesPath` 等）保持原有签名，只在这里查表；宿主在加载/写入
 * 会话索引时注册布局。注册表缺失时一律回退 managed，保证旧调用方与测试行为不变。
 *
 * 该模块刻意不依赖 Electron / fs / 工作区管理器，避免路径层反向依赖上层。
 */

export interface SessionStorageLayout {
  kind: 'project' | 'managed'
  /** project 模式必填：`<root>/.profer/sessions/<sessionId>` 的绝对路径。 */
  dataDir?: string
}

const layouts = new Map<string, SessionStorageLayout>()

export function registerSessionStorageLayout(sessionId: string, layout: SessionStorageLayout): void {
  if (!sessionId) return
  if (layout.kind === 'project' && !layout.dataDir) {
    throw new Error('project 会话布局缺少 dataDir')
  }
  layouts.set(sessionId, layout)
}

export function unregisterSessionStorageLayout(sessionId: string): void {
  layouts.delete(sessionId)
}

export function getSessionStorageLayout(sessionId: string): SessionStorageLayout | undefined {
  return layouts.get(sessionId)
}

/** 仅测试/进程重置使用：清空注册表，回到全 managed 的历史行为。 */
export function clearSessionStorageLayouts(): void {
  layouts.clear()
}

export function listRegisteredSessionLayouts(): Array<[string, SessionStorageLayout]> {
  return [...layouts.entries()]
}
