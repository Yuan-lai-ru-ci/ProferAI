import { app, Menu, shell, BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import { DEFAULT_MAIN_WINDOW_ZOOM_FACTOR, resetWindowZoom } from './lib/mac-traffic-light'

export type TextContextMenuParams = Pick<
  Electron.ContextMenuParams,
  'isEditable' | 'selectionText' | 'editFlags'
>

/**
 * 根据右键位置的编辑能力生成原生文本菜单。
 *
 * 非编辑区域只有存在文本选区时才返回菜单，避免盖住 Renderer 中已有的业务右键菜单。
 */
export interface TextContextMenuOptions {
  /**
   * 当前选区是否落在「可引用」区域（Agent 对话正文）。
   * 由渲染进程上报，避免在设置页/无关面板里也冒出「引用到输入框」这种死菜单项。
   */
  quoteSelectionEnabled?: boolean
}

export const QUOTE_SELECTION_MENU_ID = 'agent-quote-selection'

export function createTextContextMenuTemplate(
  params: TextContextMenuParams,
  platform: NodeJS.Platform = process.platform,
  options: TextContextMenuOptions = {},
): Electron.MenuItemConstructorOptions[] {
  const { editFlags } = params

  if (!params.isEditable) {
    if (params.selectionText.length === 0) return []
    return [
      ...(options.quoteSelectionEnabled
        ? [
            { id: QUOTE_SELECTION_MENU_ID, label: '引用到输入框', enabled: true },
            { type: 'separator' as const },
          ]
        : []),
      { role: 'copy', label: '复制', enabled: editFlags.canCopy },
    ]
  }

  return [
    { role: 'undo', label: '撤销', enabled: editFlags.canUndo },
    { role: 'redo', label: '重做', enabled: editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', label: '剪切', enabled: editFlags.canCut },
    { role: 'copy', label: '复制', enabled: editFlags.canCopy },
    { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
    ...(platform === 'darwin'
      ? [{ role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式', enabled: editFlags.canPaste }]
      : []),
    { role: 'delete', label: '删除', enabled: editFlags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', label: '全选', enabled: editFlags.canSelectAll },
  ]
}

/** 哪些 webContents 当前选区可引用（渲染进程上报，右键菜单据此加项）。 */
const quoteableSelections = new Set<number>()

export function setQuoteableSelection(webContentsId: number, enabled: boolean): void {
  if (enabled) quoteableSelections.add(webContentsId)
  else quoteableSelections.delete(webContentsId)
}

let textContextMenusInstalled = false

/** 为 Profer 创建的所有 WebContents 安装通用复制/粘贴右键菜单。 */
export function installTextContextMenus(): void {
  if (textContextMenusInstalled) return
  textContextMenusInstalled = true

  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('context-menu', (_contextMenuEvent, params) => {
      const template = createTextContextMenuTemplate(params, process.platform, {
        quoteSelectionEnabled: quoteableSelections.has(webContents.id),
      })
      if (template.length === 0) return
      // 「引用到输入框」由渲染进程完成（它才知道选区落在哪条消息上），
      // 主进程只负责把点击转成事件；原生菜单不会清掉 DOM 选区。
      for (const item of template) {
        if (item.id !== QUOTE_SELECTION_MENU_ID) continue
        item.click = () => {
          if (!webContents.isDestroyed()) {
            webContents.send(AGENT_IPC_CHANNELS.QUOTE_SELECTION_REQUEST)
          }
        }
      }

      const ownerWindow = BrowserWindow.fromWebContents(webContents) ?? BrowserWindow.getFocusedWindow()
      const popupOptions: Electron.PopupOptions = {
        sourceType: params.menuSourceType,
      }
      if (ownerWindow) popupOptions.window = ownerWindow
      if (params.frame) popupOptions.frame = params.frame

      Menu.buildFromTemplate(template).popup(popupOptions)
    })
  })
}

export function createApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin'

  /**
   * 菜单快捷键说明：
   *
   * 大部分快捷键由渲染进程的 shortcut-registry 统一管理。
   * 但 Cmd+W 需要在菜单中拦截（否则 macOS 默认关闭窗口），
   * 改为通知渲染进程关闭当前标签页。
   */

  const template: Electron.MenuItemConstructorOptions[] = [
    // 应用菜单 (仅 macOS)
    ...(isMac
      ? [
          {
            label: 'Profer',
            submenu: [
              { role: 'about' as const, label: '关于 Profer' },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 Profer' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '显示全部' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 Profer' },
            ],
          },
        ]
      : []),

    // 文件菜单
    {
      label: '文件',
      submenu: [
        // Cmd+W / Ctrl+W：关闭当前标签页（而非关闭窗口）
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) {
              win.webContents.send('menu:close-tab')
            }
          },
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: '退出' }]),
      ],
    },

    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' },
              { role: 'delete' as const, label: '删除' },
              { role: 'selectAll' as const, label: '全选' },
            ]
          : [{ role: 'delete' as const, label: '删除' }, { type: 'separator' as const }, { role: 'selectAll' as const, label: '全选' }]),
      ],
    },

    // 视图菜单
    {
      label: '视图',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '切换开发者工具' },
        { type: 'separator' as const },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return
            // Profer 的默认缩放是 110%，不沿用 Chromium resetZoom 的 100%。
            if (process.platform === 'darwin') resetWindowZoom(win)
            else win.webContents.setZoomFactor(DEFAULT_MAIN_WINDOW_ZOOM_FACTOR)
          },
        },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '切换全屏' },
      ],
    },

    // 窗口菜单
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'zoom' as const, label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '前置全部窗口' },
              { type: 'separator' as const },
              { role: 'window' as const, label: '窗口' },
            ]
          : [{ role: 'close' as const, label: '关闭' }]),
      ],
    },

    // 帮助菜单
    {
      label: '帮助',
      role: 'help' as const,
      submenu: [
        {
          label: '了解更多',
          click: async () => {
            await shell.openExternal('https://github.com/yourusername/proma')
          },
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
