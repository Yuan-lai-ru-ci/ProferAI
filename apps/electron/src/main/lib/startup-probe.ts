/**
 * 打包产物的启动探针。
 *
 * 为什么需要：0.16.27 的四套包「构建成功 + 签名正确 + 更新元数据齐全」，但主进程 bundle
 * 顶层 require 了一个纯 ESM 包，应用在加载阶段就抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 窗口根本没创建。现有门禁里没有任何一步真正启动过产物，于是这个版本被发了出去。
 *
 * 这里只在 `PROFER_STARTUP_PROBE_FILE` 指向一个路径时写入（发布前的启动冒烟脚本设置它），
 * 正常启动不产生任何文件。写入是同步的：崩在加载阶段时异步写盘可能来不及落盘。
 */

import { appendFileSync } from 'node:fs'

export const STARTUP_PROBE_ENV = 'PROFER_STARTUP_PROBE_FILE'

/** 加载阶段已完成（bundle 的模块求值走到 index.ts 顶部）。 */
export const STARTUP_STAGE_MAIN_LOADED = 'main-loaded'
/** 主窗口对象已创建。启动冒烟以此判定“应用真的起来了”。 */
export const STARTUP_STAGE_WINDOW_CREATED = 'window-created'
/** bootstrap 抛错后的降级路径；不算启动成功，用于区分“没加载”和“加载了但起窗口失败”。 */
export const STARTUP_STAGE_BOOTSTRAP_FAILED = 'bootstrap-failed'

export type StartupStage =
  | typeof STARTUP_STAGE_MAIN_LOADED
  | typeof STARTUP_STAGE_WINDOW_CREATED
  | typeof STARTUP_STAGE_BOOTSTRAP_FAILED

/** 追加一条探针记录；任何失败都静默（观测手段不能影响启动）。 */
export function writeStartupProbe(stage: StartupStage, detail: Record<string, unknown> = {}): void {
  const file = process.env[STARTUP_PROBE_ENV]
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), stage, pid: process.pid, ...detail })}\n`, 'utf8')
  } catch {
    /* 写不进去就算了 */
  }
}
