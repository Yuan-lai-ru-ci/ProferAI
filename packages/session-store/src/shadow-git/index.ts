/**
 * 工作区 Shadow Git 底座（Phase 0）。
 *
 * 对外只暴露这一处入口：调用方（Electron 主进程）不应该知道文件怎么拆分，
 * 也不需要理解 journal 与队列的内部约定。
 *
 * 说明：这里故意用 `export *` 而不是逐个具名导出。模块边界按「文件职责」划分，
 * 新增能力时只改对应文件，不需要同步维护一份导出清单（漏改会让调用方拿到 undefined）。
 */
export * from './types'
export * from './roots'
export * from './exclusions'
export * from './walk'
export * from './git-command'
export * from './tree-builder'
export * from './journal'
export * from './manifest'
export * from './queue'
export * from './repository'
export * from './attribution'
export * from './reverse-patch'
export * from './restore-journal'
