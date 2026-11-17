/**
 * WebUI 连接的**命令权限边界**（纯判定，无副作用）。
 *
 * 为什么需要这一层：`/s/<id>` 的会话白名单只作用于 HTML 路由。网页拿到 token 后连的是
 * 一个通用 WS 命令通道 —— 不加约束的话，「分享一个会话的网页」等于「分享这台机器上
 * 全部会话的读写权」（`list_sessions` / `get_sdk_messages` / `read_file_as_data_url`
 * 都能指定任意 sessionId）。端口与凭据分离之后，这里再把命令面收成「页面真正用到的那些」。
 *
 * 判据刻意做成白名单而不是黑名单：新增远程命令时默认对网页关闭，
 * 需要网页支持时再显式加进来 —— 反过来的黑名单会随主仓加命令而静默放宽。
 */

/** 网页端允许调用的命令。
 *
 * 逐条对应 `webui/main.tsx` 与 `pocket/ws-client.ts` 里实际使用的方法，
 * 不是「猜它可能需要」。新增页面功能时一起补这里。
 */
export const WEBUI_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // 会话读取
  'get_sdk_messages',
  'session_detail',
  'get_pending_interactions',
  'list_visualizations',
  // 会话内全量搜索（只读，不跨会话）
  'search_session_messages',
  // 委派/子任务快照：只返回本会话运行中的子任务与待回答阻塞
  'get_session_delegations',
  // 页面必需的元数据（全局只读，不含会话内容）
  'list_channels',
  'get_pi_reasoning_capability',
  'list_presets',
  'get_default_preset',
  // 对话
  'send_message',
  'queue_message',
  'stop_agent',
  // 编辑重发：把会话回退到某条消息之前
  // rewind_session = 仅对话；rewind_prepare/rewind_execute = 带 Shadow Git 文件还原的两段式
  'rewind_session',
  'rewind_prepare',
  'rewind_execute',
  // 工具行里的文件路径点开预览（文本走 read_text_file，图片仍走 data URL）
  'read_text_file',
  'save_agent_attachment',
  'read_file_as_data_url',
  // @ 提及候选 / 上下文占用水合：之前只加进了 SESSION_SCOPED，ALLOWED 少了 →
  // 页面收到「网页端不支持该操作」，而不是会话作用域错误。
  'list_skills',
  'get_agent_runtime_contexts',
  // @ 引用文件候选：只列会话授权根内的相对路径
  'list_workspace_files',
  // 会话设置
  'update_permission_mode',
  'update_session_model',
  'update_session_thinking_level',
  'update_session_agent_effort',
  'update_session_preset',
  // 预设（岗位）管理：作用域由会话所属工作区决定
  'create_preset',
  'update_preset',
  'copy_preset',
  'delete_preset',
  'set_default_preset',
  // 交互审批
  'respond_permission',
  'respond_ask_user',
  'respond_exit_plan_mode',
  // Goal
  'get_goal',
  'get_goal_history',
  'start_goal',
  'pause_goal',
  'resume_goal',
  'stop_goal',
  'clear_goal',
  'update_goal',
  'respond_goal_proposal',
])

/** 必须带上已发布会话 id 才能执行的命令（其余为全局只读或按 requestId 定位）。 */
export const WEBUI_SESSION_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  'get_sdk_messages',
  'session_detail',
  'get_pending_interactions',
  'list_visualizations',
  'search_session_messages',
  'get_session_delegations',
  'send_message',
  'queue_message',
  'stop_agent',
  'rewind_session',
  'rewind_prepare',
  'rewind_execute',
  'save_agent_attachment',
  'read_text_file',
  'read_file_as_data_url',
  // 提及：按会话工作区取技能与文件（工作区 slug 由服务端推导，不接受客户端指定）
  'list_skills',
  'list_workspace_files',
  // get_agent_runtime_contexts 用 sessionIds 数组且 handler 按发布白名单收口，
  // 不能列进 SESSION_SCOPED —— 那会因为「缺少 sessionId」被拒。
  'update_permission_mode',
  'update_session_model',
  'update_session_thinking_level',
  'update_session_agent_effort',
  'update_session_preset',
  'get_goal',
  'get_goal_history',
  'start_goal',
  'pause_goal',
  'resume_goal',
  'stop_goal',
  'clear_goal',
  'update_goal',
])

/**
 * 只带 requestId / proposalId 的审批命令：请求本身没有 sessionId，
 * 必须由调用方从待处理队列里反查出来，再判断那个会话是否已发布。
 */
export const WEBUI_REQUEST_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  'respond_permission',
  'respond_ask_user',
  'respond_exit_plan_mode',
  'respond_goal_proposal',
])

/**
 * 命令自带的会话标识。
 *
 * 两种传输形状都要认：新的顶层 `sessionId`，以及 Pocket 旧版的 `access.sessionId`
 * （`read_file_as_data_url` 至今仍是这个形状 —— 只读顶层会把网页端的图片请求全部拒掉）。
 */
export function readCommandSessionId(parsed: Record<string, unknown>): string | null {
  const direct = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
  if (direct) return direct
  const access = parsed.access
  if (access && typeof access === 'object' && !Array.isArray(access)) {
    const nested = (access as { sessionId?: unknown }).sessionId
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return null
}

export type WebuiCommandCheck = { ok: true } | { ok: false; error: string }

export interface WebuiCommandCheckInput {
  type: string
  /** 命令自带的 sessionId（已 trim）；没有则为 null */
  sessionId: string | null
  /** 审批命令：由待处理队列反查到的会话 id；查不到为 undefined */
  requestSessionId?: string
  publishedIds: readonly string[]
}

/**
 * 判定一条命令是否允许从网页端执行。
 *
 * 顺序有意义：先判命令是否在白名单，再判作用域。这样「未公开的命令」不会因为
 * 恰好缺 sessionId 而回一句「缺少 sessionId」—— 错误文案不该暗示命令的存在。
 */
export function checkWebuiCommandAccess(input: WebuiCommandCheckInput): WebuiCommandCheck {
  if (!WEBUI_ALLOWED_COMMANDS.has(input.type)) {
    return { ok: false, error: `网页端不支持该操作：${input.type}` }
  }
  if (WEBUI_SESSION_SCOPED_COMMANDS.has(input.type)) {
    if (!input.sessionId) return { ok: false, error: '缺少 sessionId' }
    if (!input.publishedIds.includes(input.sessionId)) {
      return { ok: false, error: '该会话未发布到网页，不能从此页面访问' }
    }
  }
  if (WEBUI_REQUEST_SCOPED_COMMANDS.has(input.type)) {
    if (!input.requestSessionId) return { ok: false, error: '该请求不存在或已处理' }
    if (!input.publishedIds.includes(input.requestSessionId)) {
      return { ok: false, error: '该会话未发布到网页，不能从此页面操作' }
    }
  }
  return { ok: true }
}

/** 网页端只应看到已发布的会话：过滤事件回放与「正在跑」清单。 */
export function filterWebuiSessionIds(
  sessionIds: readonly string[],
  publishedIds: readonly string[],
): string[] {
  const allowed = new Set(publishedIds)
  return sessionIds.filter((sessionId) => allowed.has(sessionId))
}
