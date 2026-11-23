import { acquireCoreExecutionLock } from '@profer/session-store/execution-lock'
import { getConfigDir } from './config-root'
import { isLocalCoreEnabled } from './core-local-mode'
import { updateLocalCoreStatus } from './core-local-service'
import { app } from 'electron'
import { isQuitRequest } from './app-quit-command'
import { getDevInstanceId, readUserDataDirSwitch, resolveDevAppName, resolveDevUserDataPath } from './dev-instance'

// 单实例检查先于业务模块初始化；执行存储锁由内置 Core 子进程持有。
if (!app.isPackaged) app.setName(resolveDevAppName())
app.setPath('userData', readUserDataDirSwitch(process.argv) ?? resolveDevUserDataPath(app.getPath('appData'), app.isPackaged, process.env))
const instance = getDevInstanceId()
if (instance) console.log(`[启动] 开发隔离实例: ${instance}，userData=${app.getPath('userData')}`)

// 重复启动必须立即结束模块求值，不能只 app.quit 后继续执行业务 import。
if (!app.requestSingleInstanceLock() || isQuitRequest(process.argv)) app.exit(0)

// 旧核必须在加载任何业务 writer 之前取得同根锁；已有 Core 时拒绝启动，不抢占。
if (!isLocalCoreEnabled()) {
  const release = acquireCoreExecutionLock(getConfigDir())
  app.on('will-quit', release)
  updateLocalCoreStatus('stopped')
}
