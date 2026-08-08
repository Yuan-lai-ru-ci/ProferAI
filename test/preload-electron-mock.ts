/**
 * bun test 全局 preload：统一 mock electron
 *
 * 背景：部分源码模块（如 config-paths.ts）在函数体内用 CJS `require('electron')`，
 * 而测试文件各自 mock.module('electron') 时存在执行顺序问题——一旦某个测试先真实
 * 加载了 electron 模块（bun 模块缓存），后续所有 mock.module('electron') 都会失效，
 * 导致 "Export named 'BrowserWindow' not found" 类错误。
 *
 * 方案：通过 bunfig.toml 的 [test].preload 在本文件里统一注册 electron mock，
 * 保证 electron 在任何一个测试文件加载源码模块之前就被拦截，永不真实加载。
 *
 * 契约：源码新增 electron API 使用（new BrowserWindow()、dialog.showOpenDialog、
 * app.requestSingleInstanceLock 等）必须同步更新本 mock，否则测试报错（显性）或
 * mock 空实现让测试假通过（隐性，如 dialog: {}）。mock 的 app.getVersion 等值
 * 需与 apps/electron/package.json 的 electronVersion 保持一致。
 *
 * 重要（2026-08-08）：--isolate 下测试文件对 preload 已 mock 的 'electron' 二次
 * mock.module 不生效（bun 行为与文件位置相关，实测 lib 目录下覆盖失效），
 * 因此需要构造 BrowserWindow / 注册 globalShortcut 的测试统一从这里取状态：
 * 通过 globalThis.__proferElectronTestHooks 读取实例/调用记录并 reset，
 * 不要再在测试文件里替换整个 electron mock。
 */
import { mock } from 'bun:test'

/**
 * 测试钩子：供窗口生命周期 / 全局快捷键类测试断言使用。
 */
declare global {
  var __proferElectronTestHooks: {
    createdWindows: Array<{
      destroyed: boolean
      visible: boolean
      opts: Record<string, unknown>
    }>
    registeredAccelerators: string[]
    reset: () => void
  }
}

globalThis.__proferElectronTestHooks = {
  createdWindows: [],
  registeredAccelerators: [],
  reset() {
    this.createdWindows.length = 0
    this.registeredAccelerators.length = 0
  },
}

/** 可构造的 BrowserWindow 替身：记录实例到 hooks.createdWindows */
class MockBrowserWindow {
  destroyed = false
  visible = false
  webContents = { send: () => {}, once: () => {}, on: () => {} }

  constructor(public opts: Record<string, unknown>) {
    globalThis.__proferElectronTestHooks.createdWindows.push(this)
  }

  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true }
  isVisible(): boolean { return this.visible }
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  focus(): void {}
  setBounds(): void {}
  restore(): void {}
  isMinimized(): boolean { return false }
  loadURL(): Promise<void> { return Promise.resolve() }
  loadFile(): Promise<void> { return Promise.resolve() }
  on(): void {}
  once(): void {}
  static getAllWindows(): unknown[] { return [] }
  static fromWebContents(): undefined { return undefined }
}

mock.module('electron', () => ({
  app: {
    getPath: () => '',
    isPackaged: false,
    getVersion: () => '43.0.0',
    getName: () => 'Profer',
    whenReady: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    quit: () => undefined,
    setAppUserModelId: () => undefined,
  },
  BrowserWindow: MockBrowserWindow,
  globalShortcut: {
    register: (accelerator: string) => {
      globalThis.__proferElectronTestHooks.registeredAccelerators.push(accelerator)
      return true
    },
    unregister: (accelerator: string) => {
      const idx = globalThis.__proferElectronTestHooks.registeredAccelerators.indexOf(accelerator)
      if (idx >= 0) globalThis.__proferElectronTestHooks.registeredAccelerators.splice(idx, 1)
    },
    unregisterAll: () => {
      globalThis.__proferElectronTestHooks.registeredAccelerators.length = 0
    },
  },
  clipboard: {
    readText: () => '',
    writeText: () => undefined,
  },
  dialog: {},
  ipcMain: {
    handle: () => undefined,
    on: () => undefined,
    removeHandler: () => undefined,
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => undefined }),
    setApplicationMenu: () => undefined,
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createEmpty: () => ({}),
  },
  nativeTheme: {
    on: () => undefined,
  },
  Notification: class {},
  powerMonitor: {
    on: () => undefined,
  },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => undefined,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 800, y: 450 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => '',
  },
  systemPreferences: {},
  Tray: class {},
}))
