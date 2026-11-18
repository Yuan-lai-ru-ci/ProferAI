export const CORE_HOST_CAPABILITIES = {
  execution: { location: 'core', providers: ['claude', 'pi'] },
  files: { status: 'supported', location: 'core', note: '文件读写及命令在所属Core工作区执行。' },
  skills: { status: 'supported', location: 'core', note: '工作区及全局来源从所属Core配置装配。' },
  mcp: { status: 'supported', location: 'core', note: '所属Core配置、预设白名单及连接生命周期。' },
  browser: { status: 'supported', location: 'core', note: '使用所属Core显式配置的Chromium；未配置时明确失败，不借用桌面浏览器。' },
  preview: { status: 'supported', location: 'desktop', note: '通过当前会话绑定的已鉴权桌面宿主和正式预览器，只读传输Core授权内容；断连不回落。' },
  clipboard: { status: 'supported', location: 'desktop', note: '通过当前会话绑定的桌面宿主执行，遵守所属Core审批和运行身份。' },
  notifications: { status: 'supported', location: 'core', note: '使用所属Core的飞书通知配置和持久outbox；无配置不伪称投递成功，不借桌面账号。' },
} as const
