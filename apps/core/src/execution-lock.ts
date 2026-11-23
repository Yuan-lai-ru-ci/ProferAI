// 兼容原入口；Core 与 Electron legacy writer 必须使用同一锁协议。
export { acquireCoreExecutionLock } from '@profer/session-store/execution-lock'
