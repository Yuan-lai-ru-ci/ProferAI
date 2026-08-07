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
 */
import { mock } from 'bun:test'

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
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => undefined,
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
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => '',
  },
  systemPreferences: {},
  Tray: class {},
}))
