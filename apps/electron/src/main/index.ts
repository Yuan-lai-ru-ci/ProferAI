import { app, BrowserWindow, dialog, Menu, nativeTheme, powerMonitor, protocol, screen, shell } from 'electron'
import { join } from 'path'
import { existsSync, cpSync, mkdirSync, readdirSync } from 'fs'
import { getDevInstanceId, resolveDevAppName, resolveDevUserDataPath } from './lib/dev-instance'

// userData 和单实例锁必须在任何会读取 userData 的模块加载前隔离。
// PROFER_DEV_INSTANCE / PROFER_USER_DATA_DIR 仅对开发版生效，正式版忽略这些参数。
const devInstanceId = getDevInstanceId()
if (!app.isPackaged) app.setName(resolveDevAppName())
app.setPath('userData', resolveDevUserDataPath(app.getPath('appData'), app.isPackaged, process.env))
if (devInstanceId) {
  console.log(`[启动] 开发隔离实例: ${devInstanceId}，userData=${app.getPath('userData')}`)
}

// 一次性迁移：把存量 Profer 用户遗留在 @proma/electron 的浏览器层数据搬到新目录。
// 登录态/会话/自动任务/device_id 都在 ~/.profer（不涉及），这里只搬 Chromium 层，避免用户升级后
// 首屏缓存/cookie 凭空清空。copy 而非 move（保住原版 Proma 的目录）；跳过可再生大缓存；静默降级。
migrateUserDataFromProferIfNeeded()

function migrateUserDataFromProferIfNeeded(): void {
  // 仅正式版需要：dev 版一直用独立的 @profer/electron-dev，无 @proma 遗留。
  if (!app.isPackaged) return
  try {
    const newDir = app.getPath('userData') // setPath 后 = %APPDATA%\@profer\electron
    const oldDir = join(app.getPath('appData'), '@proma', 'electron')
    // 幂等：新目录已存在（迁过或已在用）或旧目录不存在（全新用户）时跳过。
    if (existsSync(newDir) || !existsSync(oldDir)) return

    // 可再生的大缓存不迁（省时且避免占用冲突）——Electron 会自动重建。
    const SKIP = new Set([
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'blob_storage',
      'Dictionaries',
      'Shared Dictionary',
    ])

    mkdirSync(newDir, { recursive: true })
    for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      try {
        cpSync(join(oldDir, entry.name), join(newDir, entry.name), { recursive: true })
      } catch {
        // 单项失败不阻断其余项（如原版 Proma 正在运行占用某文件）。
      }
    }
    console.log('[userData迁移] 已从 @proma/electron 复制浏览器层数据到 @profer/electron')
  } catch (err) {
    console.warn('[userData迁移] 失败（不影响使用，核心数据在 ~/.profer）:', err)
  }
}

// 仅正式 Windows 安装版声明 AUMID，使任务栏与 Profer.exe / 开始菜单快捷方式绑定。
// 开发版由裸 electron.exe 承载，刻意不声明 AUMID：任务栏使用 Electron 默认图标，
// 避免开发环境向 Windows Shell 注册或污染生产 com.profer.app 身份。
if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId('com.profer.app')
}


// 单实例锁：防止重复启动同一个版本
if (!app.requestSingleInstanceLock()) {
  console.warn(
    '[启动] 已有 Profer 进程持有单实例锁，本次启动将退出。\n' +
      '  如果窗口未出现，可能旧进程已卡死。请运行 `killall Profer` 后重试。',
  )
  app.quit()
} else {
  // 主流程：正常启动（单实例锁已获取）
  registerProtocolsAndHandlers()
}

function registerProtocolsAndHandlers(): void {
  // 注册自定义协议方案为“特权”（必须在 app ready 之前）
  // 用于内联预览本地文件（renderer 用 iframe 加载 profer-file:// 资源）
  protocol.registerSchemesAsPrivileged([
    { scheme: 'profer-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    // 皮肤 assets 稳定协议：skin.css 中 url(assets/...) 被替换为 profer-skin://<skinId>/assets/...，
    // 由主进程按需读取（P2：替代 base64 内联，移除大图 IPC 传输与编码开销）
    { scheme: 'profer-skin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ])

  // Windows: 禁用 LCD 次像素抗锯齿（ClearType），改用灰度 AA。
  // ClearType 是为浅色背景+深色文字设计的，在深色代码块背景下会产生彩色边缘，导致文字模糊。
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-lcd-text')
  }

  // macOS 文件关联：在 app ready 之前注册 open-file 事件
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    handleMigrationFileOpen(filePath)
  })

  // Windows 文件关联：当用户双击文件时，新实例的参数会通过 second-instance 传给已有实例
  app.on('second-instance', (_event, argv) => {
    showAndFocusMainWindow()
    const fileArg = argv.find((arg) => arg.endsWith('.profer-backup') || arg.endsWith('.profer-share'))
    if (fileArg) {
      handleMigrationFileOpen(fileArg)
    }
  })
}



import { getSettings, updateSettings } from './lib/settings-service'
import { INTRO_FLUID_FRAGMENT_SHADER, INTRO_FLUID_VERTEX_SHADER } from '../shared/intro-fluid-shader'
import { handleProferFileRequest } from './lib/local-file-protocol'
import { handleProferSkinRequest } from './lib/skin-service'

// 处理 EPIPE 错误：当 stdout/stderr 管道被关闭时（如 electronmon 重启），忽略写入错误
// 这在开发环境热重载时经常发生，不影响应用功能
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})

// 清理本地环境中的 ANTHROPIC_* 变量，防止干扰应用的认证流程
// Electron 桌面应用通过渠道系统管理 API Key，不应受终端环境变量影响
// 注意：此操作必须在 initializeRuntime()（loadShellEnv）之前执行
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_')) {
    delete process.env[key]
  }
}

import { createApplicationMenu } from './menu'
import { registerIpcHandlers, setRendererReadyHandler } from './ipc'
import { setRemoteServiceEnabled, startRemoteService, stopRemoteService } from './lib/remote-service'
import { createTray, destroyTray, getTray } from './tray'
import { initializeRuntime } from './lib/runtime-init'
import { seedDefaultSkills, VITE_DEV_SERVER_URL } from './lib/config-paths'
import { configureGlobalSkillSystem, ensureGlobalSkillSystemReady } from './lib/global-skill-manager'
import { ensurePresetSystemReady } from './lib/agent-preset-manager'
import { getMainWindow, setMainWindow } from './lib/main-window-state'
import { stopAllAgents, killOrphanedClaudeSubprocesses } from './lib/agent-service'
import { disposePiMcpConnections } from './lib/adapters/pi-mcp-tools'
import { disposeLarkCliService } from './lib/lark-cli-service'
import { disposeLarkMcpService } from './lib/lark-mcp-service'
import { browserController } from './lib/browser-controller'
import { stopAllGenerations } from './lib/chat-service'
import { initAutoUpdater, cleanupUpdater } from './lib/updater/auto-updater'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './lib/workspace-watcher'
import { startChatToolsWatcher, stopChatToolsWatcher } from './lib/chat-tools-watcher'
import { getIsQuitting, setQuitting } from './lib/app-lifecycle'
import {
  registerBridge,
  startAllBridges,
  startBridgeSelfHealing,
  stopAllBridges,
  stopBridgeSelfHealing,
} from './lib/bridge-registry'
import { startScheduler, stopScheduler } from './lib/automation-scheduler'
import { startPlanningReminderScheduler, stopPlanningReminderScheduler } from './lib/planning-reminder-scheduler'
import { destroyPlanningWindow } from './lib/planning-window'
import { getWindowFrameColor, updateWindowFrameAppearance } from './lib/titlebar-overlay'
import { feishuBridgeManager } from './lib/feishu-bridge-manager'
import { getFeishuMultiBotConfig } from './lib/feishu-config'
import { stopFeishuSyncSleepBlocker, syncFeishuSyncSleepBlocker } from './lib/feishu-sleep-blocker'
import { dingtalkBridgeManager } from './lib/dingtalk-bridge-manager'
import { getDingTalkMultiBotConfig } from './lib/dingtalk-config'
import { wechatBridge } from './lib/wechat-bridge'
import { getWeChatConfig } from './lib/wechat-config'
import { createQuickTaskWindow, toggleQuickTaskWindow, destroyQuickTaskWindow } from './lib/quick-task-window'
import {
  createVoiceDictationWindow,
  toggleVoiceDictationWindow,
  destroyVoiceDictationWindow,
  shouldSuppressVoiceDictationActivate,
} from './lib/voice-dictation-window'
import { registerGlobalShortcut, unregisterAllGlobalShortcuts } from './lib/global-shortcut-service'
import { maintainDevShellShortcut } from './lib/dev-shell-shortcut'
import { setProferVersion } from '@profer/core'
import { TRAY_IPC_CHANNELS } from '../types'

const MIGRATION_IPC_OPEN = 'migration:open-import-file'

/** 检查文件路径是否为迁移文件，如果是则通知渲染进程打开导入流程 */
function handleMigrationFileOpen(filePath: string): void {
  if (filePath.endsWith('.profer-backup') || filePath.endsWith('.profer-share')) {
    sendToMainWindow(MIGRATION_IPC_OPEN, { filePath })
  }
}

// ===== Bridge 注册（新增 Bridge 只需在此添加一个 registerBridge 调用） =====

registerBridge({
  name: '飞书 BridgeManager',
  shouldAutoStart: () => {
    const config = getFeishuMultiBotConfig()
    return config.bots.some((b) => b.enabled && b.appId && b.appSecret)
  },
  needsRecovery: () => {
    const config = getFeishuMultiBotConfig()
    const states = feishuBridgeManager.getStates()
    return config.bots.some((bot) => (
      bot.enabled &&
      !!bot.appId &&
      !!bot.appSecret &&
      states.bots[bot.id]?.status === 'error'
    ))
  },
  start: () => feishuBridgeManager.startAll(),
  stop: () => feishuBridgeManager.stopAll(),
  recover: () => recoverEnabledFeishuBots(),
})

registerBridge({
  name: '钉钉 BridgeManager',
  shouldAutoStart: () => {
    const config = getDingTalkMultiBotConfig()
    return config.bots.some((b) => b.enabled && b.clientId && b.clientSecret)
  },
  needsRecovery: () => {
    const config = getDingTalkMultiBotConfig()
    const states = dingtalkBridgeManager.getStates()
    return config.bots.some((bot) => (
      bot.enabled &&
      !!bot.clientId &&
      !!bot.clientSecret &&
      states.bots[bot.id]?.status === 'error'
    ))
  },
  start: () => dingtalkBridgeManager.startAll(),
  stop: () => dingtalkBridgeManager.stopAll(),
  recover: () => recoverEnabledDingTalkBots(),
})

registerBridge({
  name: '微信 Bridge',
  shouldAutoStart: () => {
    const config = getWeChatConfig()
    return !!(config.enabled && config.credentials)
  },
  needsRecovery: () => wechatBridge.getStatus().status === 'error',
  start: () => wechatBridge.start(),
  stop: () => wechatBridge.stop(),
})

async function recoverEnabledFeishuBots(): Promise<void> {
  const config = getFeishuMultiBotConfig()
  let failedCount = 0
  for (const bot of config.bots) {
    if (!bot.enabled || !bot.appId || !bot.appSecret) continue
    try {
      await feishuBridgeManager.restartBot(bot.id)
    } catch (error) {
      failedCount++
      console.error(`[飞书 BridgeManager] Bot "${bot.name}" 自愈恢复失败:`, error)
    }
  }
  if (failedCount > 0) {
    throw new Error(`${failedCount} 个飞书 Bot 自愈恢复失败`)
  }
}

async function recoverEnabledDingTalkBots(): Promise<void> {
  const config = getDingTalkMultiBotConfig()
  let failedCount = 0
  for (const bot of config.bots) {
    if (!bot.enabled || !bot.clientId || !bot.clientSecret) continue
    try {
      await dingtalkBridgeManager.restartBot(bot.id)
    } catch (error) {
      failedCount++
      console.error(`[钉钉 BridgeManager] Bot "${bot.name}" 自愈恢复失败:`, error)
    }
  }
  if (failedCount > 0) {
    throw new Error(`${failedCount} 个钉钉 Bot 自愈恢复失败`)
  }
}

let mainWindow: BrowserWindow | null = null
let startupSplashWindow: BrowserWindow | null = null

const STARTUP_SPLASH_MIN_MS = 1200

function resolveStartupSplashDark(): boolean {
  const settings = getSettings()
  if (settings.themeMode === 'light') return false
  if (settings.themeMode === 'system') return nativeTheme.shouldUseDarkColors
  if (settings.themeMode === 'special') return !settings.themeStyle?.endsWith('-light')
  return true
}

function createStartupSplashHtml(isDark: boolean): string {
  const background = isDark ? '#0b0b0c' : '#f7f7f5'
  const foreground = isDark ? '#f3f3f3' : '#101114'
  const highlight = isDark ? '#aeb4bd' : '#3c414a'
  const muted = isDark ? 'rgba(243,243,243,.28)' : 'rgba(16,17,20,.46)'
  const vertex = JSON.stringify(INTRO_FLUID_VERTEX_SHADER)
  const fragment = JSON.stringify(INTRO_FLUID_FRAGMENT_SHADER)
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${background};color:${foreground};font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
    body{display:grid;place-items:center}.stage{position:relative;width:100vw;height:100vh;display:grid;place-items:center;background:${background}}
    #fluid{position:absolute;inset:0;width:100%;height:100%}.glow{position:absolute;width:min(58vw,720px);height:min(58vw,720px);border-radius:50%;background:radial-gradient(circle,${highlight}18 0%,transparent 66%);filter:blur(28px);animation:breathe 2.8s ease-in-out infinite;pointer-events:none}
    .logo{position:relative;z-index:2;font-size:clamp(52px,10vw,112px);font-weight:600;font-style:italic;letter-spacing:-.045em;transform:skewX(-7deg);text-shadow:0 0 28px ${highlight}28;animation:rise 1.1s cubic-bezier(.22,1,.36,1) both}.status{position:absolute;z-index:2;bottom:8%;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.32em;text-transform:uppercase;color:${muted};animation:pulse 1.8s ease-in-out infinite}
    @keyframes rise{from{opacity:0;transform:translateY(18px) skewX(-7deg) scale(.96)}to{opacity:1;transform:translateY(0) skewX(-7deg) scale(1)}}@keyframes breathe{0%,100%{opacity:.35;transform:scale(.86)}50%{opacity:.8;transform:scale(1.08)}}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.8}}
  </style></head><body><main class="stage"><canvas id="fluid"></canvas><div class="glow"></div><div class="logo">Profer</div><div class="status">Loading</div></main><script>
  (function(){var c=document.getElementById('fluid'),gl=c.getContext('webgl',{alpha:false,antialias:false}),dark=${isDark ? 'true' : 'false'};if(!gl)return;function shader(type,src){var x=gl.createShader(type);gl.shaderSource(x,src);gl.compileShader(x);return gl.getShaderParameter(x,gl.COMPILE_STATUS)?x:null}var v=shader(gl.VERTEX_SHADER,${vertex}),f=shader(gl.FRAGMENT_SHADER,${fragment});if(!v||!f)return;var p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))return;var b=gl.createBuffer(),a=gl.getAttribLocation(p,'aPosition'),time=gl.getUniformLocation(p,'uTime'),res=gl.getUniformLocation(p,'uResolution'),op=gl.getUniformLocation(p,'uOpacity'),seed=gl.getUniformLocation(p,'uSeed'),theme=gl.getUniformLocation(p,'uThemeLight');gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);var w=1,h=1,started=performance.now(),seedValue=Math.random()*1000;function resize(){var d=Math.min(devicePixelRatio||1,1.5);w=Math.max(1,Math.round(innerWidth*d));h=Math.max(1,Math.round(innerHeight*d));c.width=w;c.height=h}function draw(now){var elapsed=now-started;gl.viewport(0,0,w,h);gl.clearColor(dark?.043:.969,dark?.043:.969,dark?.047:.961,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(p);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);gl.uniform1f(time,elapsed/625);gl.uniform2f(res,w,h);gl.uniform1f(op,1);gl.uniform1f(seed,seedValue);gl.uniform1f(theme,dark?0:1);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);requestAnimationFrame(draw)}addEventListener('resize',resize);resize();requestAnimationFrame(draw)})();
  </script></body></html>`
}

/** 获取主窗口实例（供其他模块使用）。 */
export { getMainWindow }

function installWindowsZoomInFallback(win: BrowserWindow): void {
  if (process.platform !== 'win32') return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return

    // Windows 下主键盘的 Ctrl++ 常会以 Ctrl+= 上报；小键盘加号也需要兜底。
    const key = input.key.toLowerCase()
    if (!['=', '+', 'numadd', 'add'].includes(key)) return

    event.preventDefault()
    const currentZoomLevel = win.webContents.getZoomLevel()
    win.webContents.setZoomLevel(Math.min(currentZoomLevel + 0.5, 9))
  })
}

/**
 * 检查窗口是否在可用显示器范围内
 * 处理外接显示器断开后窗口位于不可见区域的情况
 */
function ensureWindowOnScreen(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const displays = screen.getAllDisplays()
  // 检查窗口中心点是否在任一显示器范围内
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const isOnScreen = displays.some((display) => {
    const { x, y, width, height } = display.workArea
    return centerX >= x && centerX <= x + width && centerY >= y && centerY <= y + height
  })
  if (!isOnScreen) {
    // 窗口不在任何屏幕内，移动到主显示器居中位置
    const primary = screen.getPrimaryDisplay()
    const { x, y, width, height } = primary.workArea
    win.setBounds({
      x: x + Math.round((width - bounds.width) / 2),
      y: y + Math.round((height - bounds.height) / 2),
      width: bounds.width,
      height: bounds.height,
    })
    console.log('[窗口] 窗口已重新定位到主显示器')
  }
}

/** 显示并聚焦主窗口，确保窗口在可见区域；若窗口已销毁则重新创建 */
function showAndFocusMainWindow(): void {
  if (process.platform === 'darwin') {
    if (app.dock) app.dock.show()
    app.show()
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  ensureWindowOnScreen(mainWindow)
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Get the appropriate app icon path for the current platform
 */
function getIconPath(): string {
  // 开发模式：resources/ 在 dist/ 下，通过 build:resources 复制
  // 打包模式：resources/ 在 process.resourcesPath（app.asar 同级）
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, 'resources')

  if (process.platform === 'darwin') {
    return join(resourcesDir, 'icon.icns')
  } else if (process.platform === 'win32') {
    return join(resourcesDir, 'icon.ico')
  } else {
    return join(resourcesDir, 'icon.png')
  }
}

function saveMainWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const isMaximized = mainWindow.isMaximized()
  const isFullScreen = mainWindow.isFullScreen()
  // 最大化/全屏时用 getNormalBounds() 保存恢复后的尺寸，
  // 避免 macOS 全屏关闭后下次启动用全屏坐标恢复导致黑屏（Proma PR #1119）
  const bounds = (isMaximized || isFullScreen) ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  updateSettings({
    mainWindowState: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    },
  })
}

function createWindow(): void {
  const iconPath = getIconPath()
  const iconExists = existsSync(iconPath)

  if (!iconExists) {
    console.warn('App icon not found at:', iconPath)
  }

  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'

  const titleBarOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
      }
    : isWindows
      ? { titleBarStyle: 'hidden' as const }
      : {}

  const savedState = getSettings().mainWindowState
  const initialBounds = savedState
    ? { width: savedState.width, height: savedState.height, x: savedState.x, y: savedState.y }
    : { width: 1400, height: 900 }

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 800,
    minHeight: 600,
    icon: iconExists ? iconPath : undefined,
    // Windows 非客户区/DWM 在静止窗口时也可能露出 BrowserWindow 底色。
    // 显式使用当前主题框架色，避免 Electron 默认白色形成一圈白边。
    backgroundColor: getWindowFrameColor(),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...titleBarOptions,
  })
  // Windows 开发运行时的 Electron 壳不会稳定继承 BrowserWindow 构造参数中的图标；
  // 显式设置一次，确保任务栏窗口图标使用当前资源文件。
  if (process.platform === 'win32' && iconExists) {
    mainWindow.setIcon(iconPath)
    // 任务栏按钮图标 = 进程身份（AUMID）决定，不随 WM_SETICON。显式提供 appIconPath
    // （微软 RelaunchIconResource 允许 .ico 路径），与 setAppUserModelId 的 AUMID 配合。
    if (app.isPackaged) {
      mainWindow.setAppDetails({
        appId: 'com.profer.app',
        appIconPath: iconPath,
      })
    }
  }
  installWindowsZoomInFallback(mainWindow)
  updateWindowFrameAppearance(mainWindow)
  browserController.setOwnerWindow(mainWindow)

  // 主窗口隐藏加载 renderer；独立 splash 窗口覆盖整个初始化阶段，避免导航替换掉启动画面。
  const isDev = !app.isPackaged
  const rendererUrl = isDev ? VITE_DEV_SERVER_URL : null
  const rendererFile = join(__dirname, 'renderer', 'index.html')
  let splashStartedAt = Date.now()
  let splashShown = false
  let rendererReady = false
  let showTimer: ReturnType<typeof setTimeout> | null = null
  // Ctrl/Cmd+R 热刷新时置 true：刷新只重载 renderer，不应改变窗口几何状态（修复刷新后被强制最大化）
  let isRefreshReload = false
  // 刷新前是否处于全屏：Windows 上全屏窗口 hide/show 会退出全屏导致位置/尺寸偏移，show 前需恢复
  let refreshWasFullScreen = false
  // 刷新前是否处于最大化（无边框最大化视觉上等同全屏，splash 也应按整个显示器处理）
  let refreshWasMaximized = false

  const showWhenReady = (): void => {
    if (!rendererReady || !splashShown || mainWindow?.isDestroyed()) return
    if (showTimer) clearTimeout(showTimer)
    const remaining = Math.max(0, STARTUP_SPLASH_MIN_MS - (Date.now() - splashStartedAt))
    showTimer = setTimeout(() => {
      // 冷启动时按上次保存的状态恢复最大化；热刷新（Ctrl/Cmd+R）保持窗口原状，不重新 maximize。
      // ?? false：从未保存过窗口状态时不默认最大化（原 ?? true 导致首次运行即铺满全屏）。
      if (!isRefreshReload && (savedState?.isMaximized ?? false)) mainWindow?.maximize()
      if (process.platform === 'darwin' && app.dock) app.dock.show()
      // 全屏刷新：窗口可见前先恢复全屏。若先以普通尺寸 show 再 setFullScreen，窗口从左上角
      // 扩展到全屏，页面内组件（初始化动画等）容器会随之在底边/右侧偏移（顶边/左侧不动）。
      // 隐藏窗口上 setFullScreen 在 Windows 有效，主窗口 show 时直接就是全屏，无扩展过程。
      if (isRefreshReload && refreshWasFullScreen) mainWindow?.setFullScreen(true)
      if (!startupSplashWindow?.isDestroyed()) startupSplashWindow?.close()
      startupSplashWindow = null
      mainWindow?.show()
      // 兜底：隐藏窗口阶段 setFullScreen 未生效时（个别平台），show 后立即再恢复一次全屏
      if (isRefreshReload && refreshWasFullScreen && mainWindow && !mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(true)
      }
    }, remaining)
  }

  setRendererReadyHandler(() => {
    rendererReady = true
    showWhenReady()
  })

  const createSplashWindow = (splashBounds?: { width: number; height: number; x: number; y: number }): void => {
    if (startupSplashWindow && !startupSplashWindow.isDestroyed()) startupSplashWindow.close()
    // 刷新（Ctrl/Cmd+R）场景会传入主窗口当前真实 bounds，让启动画面保持
    // 与主窗口一致的尺寸/位置（原本多大就多大），而不是退化成固定小方块。
    const bounds = splashBounds ?? initialBounds
    startupSplashWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: 800,
      minHeight: 600,
      frame: false,
      resizable: true,
      movable: true,
      show: false,
      backgroundColor: resolveStartupSplashDark() ? '#101010' : '#f4f4f2',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    startupSplashWindow.setMenuBarVisibility(false)
    startupSplashWindow.webContents.once('did-finish-load', () => {
      splashShown = true
      startupSplashWindow?.show()
      showWhenReady()
    })
    void startupSplashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createStartupSplashHtml(resolveStartupSplashDark()))}`)
  }

  const loadRenderer = (): void => {
    if (rendererUrl) void mainWindow?.loadURL(rendererUrl)
    else void mainWindow?.loadFile(rendererFile)
  }

  const replayStartupSplash = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (showTimer) clearTimeout(showTimer)
    // 标记为热刷新，showWhenReady 据此跳过恢复最大化，保持刷新前窗口状态
    isRefreshReload = true
    // 在 hide 之前记录窗口状态，show 前恢复（全屏 hide/show 会丢失全屏状态）
    refreshWasFullScreen = mainWindow.isFullScreen()
    refreshWasMaximized = mainWindow.isMaximized()
    splashStartedAt = Date.now()
    splashShown = false
    rendererReady = false
    // Ctrl/Cmd+R 刷新 renderer：内存态 browserOpenMap/browserState（非持久化）将随重建清空，
    // 不再有 BrowserViewport 去 setLayout 定位/隐藏原生 view。必须在此隐藏所有浏览器原生视图，
    // 否则主窗口重新显示后旧会话网页会裸奔脱出容器、不受控制（刷新场景需回到未打开浏览器态）。
    browserController.hideAll()
    // 刷新时重建启动画面，避免退化成固定尺寸的小方块。
    // 仅当刷新前处于全屏时用显示器完整边界（getBounds() 在全屏下可能返回 workArea 或
    // 带 DWM 隐形边界的尺寸，导致 logo 动画底边/右侧出现边距级偏移）；
    // 非全屏（普通/最大化）时 splash 必须跟随主窗口当前 bounds，否则会扩展成整个显示器。
    const currentBounds = mainWindow.getBounds()
    let splashBounds: { x: number; y: number; width: number; height: number } | undefined
    if (currentBounds) {
      // 全屏/最大化时用显示器完整边界：getBounds() 在这两种状态下返回 workArea（不含任务栏）
      // 或带 DWM 隐形边界的尺寸，导致 logo 动画底边/右侧出现边距级偏移；
      // 普通窗口 splash 跟随主窗口 bounds，否则会扩展成整个显示器。
      if (refreshWasFullScreen || refreshWasMaximized) {
        const display = screen.getDisplayMatching(currentBounds)
        splashBounds = display
          ? {
              x: display.bounds.x,
              y: display.bounds.y,
              width: display.bounds.width,
              height: display.bounds.height,
            }
          : {
              x: currentBounds.x,
              y: currentBounds.y,
              width: currentBounds.width,
              height: currentBounds.height,
            }
      } else {
        splashBounds = {
          x: currentBounds.x,
          y: currentBounds.y,
          width: currentBounds.width,
          height: currentBounds.height,
        }
      }
    }
    mainWindow?.hide()
    createSplashWindow(splashBounds)
    loadRenderer()
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isRefresh = input.type === 'keyDown' && input.key.toLowerCase() === 'r' && (input.control || input.meta) && !input.alt
    if (!isRefresh) return
    event.preventDefault()
    replayStartupSplash()
  })

  createSplashWindow()
  loadRenderer()

  // 持久化窗口大小和位置（防抖 500ms，避免频繁写入）
  let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleWindowStateSave = (): void => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
    windowStateSaveTimer = setTimeout(() => {
      windowStateSaveTimer = null
      saveMainWindowState()
    }, 500)
  }
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)

  // 将 file:// 或 Windows 绝对路径转为系统路径
  const toSystemPath = (u: string): string | null => {
    if (u.startsWith('file:///')) {
      // Windows: file:///C:/... → C:/... ; Unix: file:///home/... → /home/...
      return process.platform === 'win32'
        ? decodeURIComponent(u.slice(8).replace(/\//g, '\\'))
        : decodeURIComponent(u.slice(7))
    }
    if (/^[A-Za-z]:[\\/]/.test(u)) return u.replace(/\//g, '\\')
    if (u.startsWith('/')) return u
    return null
  }

  // 拦截页面内导航，外部链接用系统浏览器打开，防止 Electron 窗口被覆盖
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 允许开发模式下的 Vite HMR 热重载
    if (isDev && url.startsWith('http://localhost:')) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    } else {
      const sysPath = toSystemPath(url)
      if (sysPath) shell.openPath(sysPath)
    }
  })

  // 拦截 window.open / target="_blank" 链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    } else {
      const sysPath = toSystemPath(url)
      if (sysPath) shell.openPath(sysPath)
    }
    return { action: 'deny' }
  })

  // macOS: 点击关闭按钮时隐藏窗口+应用，而不是退出
  // 同时隐藏应用（类似 Cmd+H），确保点击 Dock 图标时 macOS 能正确触发 activate 事件
  if (process.platform === 'darwin') {
    mainWindow.on('close', async (event) => {
      if (!getIsQuitting()) {
        event.preventDefault()
        // 若当前处于全屏状态，先退出全屏再保存状态，
        // 避免全屏坐标被持久化导致下次启动黑屏（Proma PR #1119）
        if (mainWindow?.isFullScreen()) {
          mainWindow.setFullScreen(false)
          // 等待 leave-full-screen 事件，超时后无论如何继续
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 1000)
            const onLeave = (): void => { clearTimeout(timeout); resolve() }
            mainWindow?.once('leave-full-screen', onLeave)
          })
        }
        // 隐藏前先刷新挂起的窗口状态保存
        if (windowStateSaveTimer) {
          clearTimeout(windowStateSaveTimer)
          windowStateSaveTimer = null
        }
        saveMainWindowState()
        mainWindow?.hide()
        app.hide()
      }
    })
  }

  // Windows: 点击关闭按钮时隐藏窗口到托盘，而不是退出
  if (process.platform === 'win32') {
    mainWindow.on('close', (event) => {
      if (!getIsQuitting() && getTray()) {
        // 隐藏前先刷新挂起的窗口状态保存
        if (windowStateSaveTimer) {
          clearTimeout(windowStateSaveTimer)
          windowStateSaveTimer = null
        }
        saveMainWindowState()
        event.preventDefault()
        mainWindow?.hide()
      }
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
    browserController.dispose()
  })

  setMainWindow(mainWindow)
}

function sendToMainWindow(channel: string, data?: unknown): void {
  showAndFocusMainWindow()

  const win = mainWindow
  if (!win || win.isDestroyed()) return

  const send = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

app.whenReady().then(bootstrap).catch(handleBootstrapFailure)

/**
 * 启动主流程。所有非关键步骤用 safeRun / safeAwait 隔离，
 * 单点失败不应阻止窗口和托盘的创建（用户至少要能看到界面）。
 */
async function bootstrap(): Promise<void> {
  // ─── 第一梯队：必须在窗口显示前完成的关键路径 ───

  // 初始化 Profer 版本号（供 User-Agent 等全局标识使用）
  setProferVersion(app.getVersion())

  // 注册自定义协议 profer-file:// 用于内联预览本地文件。
  // 协议只接受主进程签发的 opaque token，不解析 renderer 提供的绝对路径。
  protocol.handle('profer-file', handleProferFileRequest)

  // 注册皮肤 assets 协议 profer-skin://<skinId>/assets/<file>。
  // 仅允许皮肤目录内 assets/ 图片，skinId 走 kebab-case 白名单，防目录穿越。
  protocol.handle('profer-skin', handleProferSkinRequest)

  // 初始化运行时环境（Shell 环境 + Bun + Git 检测）
  // 热启动时从磁盘缓存恢复，耗时 < 10ms
  await safeAwait('initializeRuntime', () => initializeRuntime())

  // 从旧 Proma 数据目录迁移到 Profer（一次性）
  const { migrateFromProferIfNeeded } = require('./lib/config-paths')
  safeRun('migrateFromProfer', migrateFromProferIfNeeded)

  // Create application menu
  const menu = createApplicationMenu()
  Menu.setApplicationMenu(menu)

  // 仅注入全局 Skill 的 bundle 来源；真正的 seed/迁移必须在窗口创建后执行。
  // Agent 首次运行前仍会通过 prepareRuntimeSkills / AgentOrchestrator 的幂等 ready gate 保证一致性。
  const bundledGlobalSkillsDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')
  configureGlobalSkillSystem(bundledGlobalSkillsDir)

  // Register IPC handlers
  registerIpcHandlers()

  // 平板版远程服务：显式启动参数（--tablet / PROFER_REMOTE=1）兼容保留；
  // 设置页开启「启用移动端连接」后，下次启动自动恢复监听（正式版与开发版一致）。
  // 开发版默认端口 7789、正式版 7788，端口已隔离，dev 与打包版并存不会互相抢占。
  safeRun('startRemoteService', () => {
    if (getSettings().tabletModeEnabled === true) {
      setRemoteServiceEnabled(true)
    } else {
      startRemoteService()
    }
  })

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    await app.dock.show()
    const { resolveAppIconPath } = require('./ipc')
    const settings = getSettings()
    const variantId = settings.appIconVariant
    const dockIconPath = resolveAppIconPath(variantId ?? 'default')
    if (dockIconPath && existsSync(dockIconPath)) {
      app.dock.setIcon(dockIconPath)
    }
  }

  // ─── 窗口 + 托盘：用户看到界面的临界点 ───
  createWindow()

  // Skill / 预设迁移可能涉及目录扫描、复制和原子替换；必须在主窗口实际显示后才开始，
  // 避免与 Renderer 首屏加载竞争。首次 Agent 运行前的幂等 ready gate 仍会兜底一致性。
  mainWindow?.once('show', () => {
    setTimeout(() => {
      // 必须先完成全局能力迁移，再运行旧 default-skills 的 seed：seed 可能在
      // 缺少旧基线时替换 legacy master，导致 B1/B2 无法用旧 master 识别。
      safeRun('ensureGlobalSkillSystemReady', ensureGlobalSkillSystemReady)
      safeRun('ensurePresetSystemReady', ensurePresetSystemReady)
      safeRun('seedDefaultSkills', seedDefaultSkills)
    }, 0)
  })

  // 开发态由裸 electron.exe 承载；维护 .dev AUMID 的专属 Shell 快捷方式，
  // 防止它注册为 Electron 或污染正式 Profer 的任务栏身份。
  safeRun('maintainDevShellShortcut', maintainDevShellShortcut)
  createTray({
    showMainWindow: showAndFocusMainWindow,
    openAgentSession: (sessionId, title) => {
      sendToMainWindow(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, { sessionId, title })
    },
    createChatSession: () => {
      sendToMainWindow(TRAY_IPC_CHANNELS.CREATE_SESSION, { mode: 'chat' })
    },
    createAgentSession: () => {
      sendToMainWindow(TRAY_IPC_CHANNELS.CREATE_SESSION, { mode: 'agent' })
    },
  })

  // ─── 第二梯队：窗口已显示，以下任务延迟到空闲时执行 ───

  // 应用开机自启动设置：确保与实际系统状态同步
  safeRun('applyAutoLaunch', () => {
    const settings = getSettings()
    const enabled = settings.autoLaunch === true
    app.setLoginItemSettings({ openAtLogin: enabled })
    console.log(`[启动] 开机自启动: ${enabled ? '已开启' : '已关闭'}`)
  })

  // 启动工作区文件监听
  if (mainWindow) {
    safeRun('startWorkspaceWatcher', () => startWorkspaceWatcher(mainWindow!))
  }

  // 启动 Chat 工具配置文件监听
  safeRun('startChatToolsWatcher', startChatToolsWatcher)

  // 预创建快速任务窗口（隐藏状态，首次唤起秒开）——默认关闭，仅在设置开启时预创建
  if (getSettings().quickTaskEnabled === true) {
    safeRun('createQuickTaskWindow', createQuickTaskWindow)
  }
  if (getSettings().voiceDictation?.enabled === true) {
    safeRun('createVoiceDictationWindow', createVoiceDictationWindow)
  }

  // 飞书实时同步开启时，默认阻止系统自动休眠
  safeRun('syncFeishuSyncSleepBlocker', () => syncFeishuSyncSleepBlocker(getSettings()))

  // 注册全局快捷键（快速任务仅在设置开启时注册）
  safeRun('registerGlobalShortcut:quick-task', () =>
    registerGlobalShortcut('quick-task', () => {
      if (getSettings().quickTaskEnabled !== true) return
      toggleQuickTaskWindow()
    }),
  )
  safeRun('registerGlobalShortcut:show-main-window', () =>
    registerGlobalShortcut('show-main-window', showAndFocusMainWindow),
  )
  safeRun('registerGlobalShortcut:voice-dictation', () =>
    registerGlobalShortcut('voice-dictation', () => {
      toggleVoiceDictationWindow({ targetIsProfer: mainWindow?.isFocused() === true })
    }),
  )

  // Bridge 启动延后到下一个事件循环，让窗口先完成渲染
  setTimeout(() => {
    safeRun('startAllBridges', () => { startAllBridges().catch(() => {}) })
    safeRun('startBridgeSelfHealing', startBridgeSelfHealing)
    safeRun('startScheduler', startScheduler)
    safeRun('startPlanningReminderScheduler', startPlanningReminderScheduler)
    if (mainWindow) {
      safeRun('initAutoUpdater', () => initAutoUpdater(mainWindow!))
    }
  }, 0)

  // 启动时恢复团队会话：先检查已登录，否则用 refreshToken 尝试恢复
  safeRun('restoreTeamSession', async () => {
    const { getAuthStatus, scheduleAutoRefresh, tryRestoreSession } = require('./lib/auth-service')

    // 如果 accessToken 已过期但 refreshToken 存在，先尝试恢复
    const restored = await tryRestoreSession()

    if (restored) {
      console.log('[启动] 团队会话已恢复，开始同步...')
      scheduleAutoRefresh()
      const { startSyncEngine } = require('./lib/sync-manager')
      startSyncEngine()
      // 延迟 3 秒同步团队工作区，等窗口 IPC 就绪
      setTimeout(() => {
        const { listTeamWorkspaces } = require('./lib/team-manager')
        const { syncTeamWorkspacesToIndex } = require('./lib/agent-workspace-manager')
        listTeamWorkspaces().then((teamWs: unknown[]) => {
          syncTeamWorkspacesToIndex(teamWs)
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('team:workspaces-synced')
          }
          console.log(`[启动] 团队工作区同步完成: ${(teamWs as unknown[]).length} 个`)
        }).catch((err: unknown) => {
          // 同步失败绝不能清空本地团队索引；保留上一次成功结果，下一次启动/登录会再试。
          console.error('[启动] 团队工作区同步失败（已保留本地团队列表）:', err)
        })
      }, 3000)
    } else if (getAuthStatus().isLoggedIn) {
      // 向后兼容：如果 getAuthStatus 返回 true，tryRestoreSession 也会返回 true，已处理
      // 这里仅当 token 有效但 refreshToken 不存在时也有可能
      console.log('[启动] 检测到已登录，恢复团队同步...')
      scheduleAutoRefresh()
      const { startSyncEngine } = require('./lib/sync-manager')
      startSyncEngine()
      setTimeout(() => {
        const { listTeamWorkspaces } = require('./lib/team-manager')
        const { syncTeamWorkspacesToIndex } = require('./lib/agent-workspace-manager')
        listTeamWorkspaces().then((teamWs: unknown[]) => {
          syncTeamWorkspacesToIndex(teamWs)
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('team:workspaces-synced')
          }
          console.log(`[启动] 团队工作区同步完成: ${(teamWs as unknown[]).length} 个`)
        }).catch((err: unknown) => {
          // 同步失败绝不能清空本地团队索引；保留上一次成功结果，下一次启动/登录会再试。
          console.error('[启动] 团队工作区同步失败（已保留本地团队列表）:', err)
        })
      }, 3000)
    }
  })

  app.on('activate', () => {
    if (shouldSuppressVoiceDictationActivate()) {
      return
    }

    // 直接检查 mainWindow 引用，避免 getAllWindows() 包含 DevTools 等其他窗口导致误判
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      // 窗口已存在但可能被隐藏（macOS 关闭按钮 = hide），重新显示
      showAndFocusMainWindow()
    }
  })

  // 休眠恢复：系统唤醒后重建网络连接，必要时用 refreshToken 恢复会话
  powerMonitor.on('resume', () => {
    console.log('[系统] 从休眠恢复，重建连接...')
    safeRun('resume:refreshTeamSession', async () => {
      const { tryRestoreSession } = require('./lib/auth-service')

      // 如果 token 在休眠期间过期，用 refreshToken 尝试恢复
      const restored = await tryRestoreSession()

      if (restored) {
        const { startSyncEngine } = require('./lib/sync-manager')
        startSyncEngine()
        setTimeout(() => {
          const { listTeamWorkspaces } = require('./lib/team-manager')
          const { syncTeamWorkspacesToIndex } = require('./lib/agent-workspace-manager')
          listTeamWorkspaces().then((teamWs: unknown[]) => {
            syncTeamWorkspacesToIndex(teamWs)
            for (const w of BrowserWindow.getAllWindows()) {
              w.webContents.send('team:workspaces-synced')
            }
          }).catch(() => {})
        }, 2000)
      }
    })
    safeRun('resume:channelsSync', () => {
      const { getTeamAuth } = require('./lib/auth-service')
      const auth = getTeamAuth()
      if (auth) {
        const { syncChannelsFromServer } = require('./lib/channel-manager')
        syncChannelsFromServer(auth.baseUrl, auth.token).catch(() => {})
      }
    })
  })

  powerMonitor.on('lock-screen', () => {
    console.log('[系统] 屏幕已锁定')
  })
}

/** 同步启动钩子隔离：单点失败仅记录日志，不阻断启动链。 */
function safeRun(name: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`[启动] ${name} 失败（已隔离）:`, err)
  }
}

/** 异步启动钩子隔离：同 safeRun，但适用于返回 Promise 的钩子。 */
async function safeAwait(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`[启动] ${name} 失败（已隔离）:`, err)
  }
}

/**
 * whenReady 顶层兜底：理论上 bootstrap 内的 safeRun/safeAwait 已经把所有可预期
 * 异常隔离掉了，能走到这里说明出了 bootstrap 本身控制流的意外（极端情况），
 * 此时仍尝试创建一个降级窗口，让用户至少能看到界面、复制日志、提交反馈。
 */
function handleBootstrapFailure(err: unknown): void {
  console.error('[启动] bootstrap 致命错误，进入降级模式:', err)

  try {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    dialog.showErrorBox(
      'Profer 启动遇到错误',
      `部分功能可能不可用：\n\n${message}\n\n` +
        `日志位置：${app.getPath('logs')}\n\n` +
        `常见原因与排查：\n` +
        `1. 旧版 Profer 进程未退出（终端运行 killall Profer 后重试）\n` +
        `2. ~/.profer/ 配置损坏（重命名 ~/.profer 后重启）\n` +
        `3. 系统 Keychain 无法解密保存的凭证（删除 ~/.profer/feishu.json 等后重新登录）\n\n` +
        `如需协助请到 GitHub Issues 反馈。`,
    )
  } catch {
    /* dialog 也失败，无能为力 */
  }

  try {
    registerIpcHandlers()
    createWindow()
  } catch (fallbackErr) {
    console.error('[启动] 降级窗口创建也失败:', fallbackErr)
  }
}

app.on('window-all-closed', () => {
  // 非 macOS：关闭所有窗口时退出应用
  // macOS：保持应用运行（可通过 tray 或 Dock 重新打开）
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 标记正在退出，让 close 事件不再阻止关闭
  setQuitting()

  // 中止所有活跃的 Agent 和 Chat 子进程
  stopAllAgents()
  void disposePiMcpConnections()
  disposeLarkCliService()
  disposeLarkMcpService()
  browserController.dispose()
  stopAllGenerations()
  // 最后兜底：扫描并强杀所有孤儿 claude-agent-sdk 子进程（Issue #357）
  // 针对 pidMap 未覆盖、dispose 漏杀等极端场景，确保不遗留残留进程
  killOrphanedClaudeSubprocesses()
  // 清理自动更新定时器
  cleanupUpdater()
  // 停止工作区文件监听
  stopWorkspaceWatcher()
  // 停止 Chat 工具配置文件监听
  stopChatToolsWatcher()
  // 停止所有 Bridge
  stopBridgeSelfHealing()
  stopAllBridges()
  // 停止定时任务调度器
  stopScheduler()
  // 停止任务/日程提醒调度器
  stopPlanningReminderScheduler()
  // 销毁规划窗口
  destroyPlanningWindow()
  // 停止平板版远程服务
  stopRemoteService()
  // 停止同步引擎
  const { stopSyncEngine } = require('./lib/sync-manager')
  stopSyncEngine()
  // 释放飞书同步防休眠
  stopFeishuSyncSleepBlocker()
  // 注销全局快捷键
  unregisterAllGlobalShortcuts()
  // 销毁快速任务窗口
  destroyQuickTaskWindow()
  destroyVoiceDictationWindow()
  // Clean up system tray before quitting
  destroyTray()
})
