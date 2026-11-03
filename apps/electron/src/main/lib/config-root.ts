/**
 * 配置根目录解析
 *
 * 只回答一个问题：Profer 的配置根在哪里（`~/.profer/` 或 `~/.profer-dev/`，
 * 可被 `PROFER_CONFIG_DIR` 覆盖）。
 *
 * 为什么单独成文件：`workspace-locator` 需要 `getConfigDir()` 才能算出工作区索引位置，
 * 而 `config-paths` 又需要 locator 来解析工作区目录。如果把 `getConfigDir()` 留在
 * `config-paths` 里，就会形成 `config-paths → workspace-locator → config-paths` 的
 * 真环（不是靠 ESM 惰性求值能兜住的）。下沉到这里后依赖图是：
 *
 *   config-paths → workspace-locator → config-root
 *   config-paths → config-root
 *
 * 本文件不 import 任何业务模块，也不 import `./config-paths`。
 *
 * 兼容性：`config-paths` 继续 re-export 这里的所有导出，调用方 import 路径不变。
 */

import { join, resolve } from 'node:path'
import { mkdirSync, existsSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * 获取默认配置目录名称
 *
 * 开发模式下返回 '.profer-dev'，正式版本返回 '.profer'。
 * 受控运行可通过 PROFER_CONFIG_DIR 覆盖实际配置根；该覆盖不改变默认名称。
 *
 * 检测优先级：
 * 1. PROFER_DEV=1 环境变量（显式覆盖）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 '.profer'
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    if (process.env.PROFER_DEV === '1') {
      _configDirName = '.profer-dev'
    } else {
      try {
        const { app } = require('electron')
        _configDirName = app.isPackaged ? '.profer' : '.profer-dev'
      } catch {
        _configDirName = '.profer'
      }
    }
    const mode = _configDirName === '.profer-dev' ? '开发模式' : '正式版本'
    console.log(`[配置] 默认配置目录名: ~/${_configDirName}/（${mode}）；实际路径可由 PROFER_CONFIG_DIR 覆盖`)
  }
  return _configDirName
}

/**
 * 从旧目录（proma）迁移到新目录（一次性）
 * 如果 ~/.profer/ 或 ~/.profer-dev/ 不存在但对应的旧目录存在，则重命名迁移。
 */
export function migrateFromProferIfNeeded(): void {
  try {
    const name = getConfigDirName()
    const newDir = join(homedir(), name)
    // 旧目录名是迁移契约的一部分，不能随品牌改名一起替换。
    const oldName = name.replace('profer', 'proma')
    const oldDir = join(homedir(), oldName)

    if (!existsSync(newDir) && existsSync(oldDir)) {
      console.log(`[迁移] 从 ~/${oldName}/ 迁移到 ~/${name}/`)
      renameSync(oldDir, newDir)
      console.log('[迁移] 数据迁移完成')
    }
  } catch (err) {
    console.error('[迁移] 数据迁移失败（不影响使用）:', err)
  }
}

/** 配置目录 0700 只需在进程内确认一次（避免每次路径解析都 chmod）。 */
let securedConfigDir: string | null = null

/**
 * 获取配置目录路径
 *
 * 开发模式返回 ~/.profer-dev/，正式版本返回 ~/.profer/。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  // 自动化测试和受控诊断可显式隔离配置根目录；常规运行仍使用用户目录。
  const override = process.env.PROFER_CONFIG_DIR?.trim()
  const configDir = override ? resolve(override) : join(homedir(), getConfigDirName())

  if (!existsSync(configDir)) {
    // 配置目录里有令牌密文与 deviceId（AES 密钥派生源），仅当前用户可读写。
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }
  // 旧版本可能以 0755 创建过：每个目录首次访问时只收紧不放开（Windows 忽略权限位）。
  if (securedConfigDir !== configDir && process.platform !== 'win32') {
    securedConfigDir = configDir
    try { chmodSync(configDir, 0o700) } catch { /* 只读介质/网络盘等忽略 */ }
  }

  return configDir
}
