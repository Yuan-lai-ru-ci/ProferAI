/**
 * 只读预览的路径策略
 *
 * 背景：会话里 Agent 输出的文件链接经常指向会话工作区之外（`~/.profer[-dev]/skins/...`、
 * `/tmp/*.log`、`~/Library/...` 等）。这些路径已经在对话里对用户可见，点开预览不应再被
 * 「授权根」拦住，否则用户看到的是「文件不存在或无法定位」这种误导提示。
 *
 * 因此只读预览放宽为「路径真实存在 + 不在系统敏感位置 + 不在凭据/隐私位置」即放行。
 * 仍然保留两条硬边界，避免渲染层（不可信）拿到无差别读取能力：
 *   1. 系统敏感目录（/etc、/usr/bin、C:\Windows 等）不预览；
 *   2. 凭据与浏览器隐私目录（~/.ssh、~/.aws、~/Library/Keychains、Profer 自身 token 文件等）不预览。
 *
 * 写操作（`file:write-text`、重命名、移动、删除、移入回收站）与「用默认应用打开文件」
 * （`shell:system-open-file`，本质是启动进程）不受本策略影响，继续走 ipc.ts 的授权根校验。
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { getConfigDir } from './config-paths'

/** 系统敏感目录——这些位置下的文件不参与只读预览 */
export const SYSTEM_SENSITIVE_ROOTS: string[] = (() => {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const programData = process.env.ProgramData || 'C:\\ProgramData'
    return [systemRoot, programFiles, programFilesX86, programData]
  }
  return ['/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/usr/lib', '/usr/lib64', '/usr/sbin', '/sbin', '/bin', '/usr/bin']
})()

/**
 * 凭据与浏览器隐私位置——只读预览同样拒绝。
 *
 * 这些目录下的内容一旦能被渲染层读取，XSS/注入类问题就能直接拿到私钥、云凭据或登录态，
 * 收益远小于「点开看一眼」的用户价值，因此保留为硬边界。
 */
export function getCredentialSensitiveRoots(configDir: string = getConfigDir(), home: string = homedir()): string[] {
  return [
    // 私钥、云凭据、密码库、包管理器 token
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.kube'),
    join(home, '.docker'),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'gcloud'),
    join(home, 'Library', 'Keychains'),
    // 浏览器 Cookie / 登录态
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'Library', 'Application Support', 'Firefox'),
    join(home, 'Library', 'Application Support', 'BraveSoftware'),
    join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    join(home, 'Library', 'Cookies'),
    // Profer 自身的凭据与渠道密钥
    join(configDir, 'auth-tokens.enc'),
    join(configDir, 'remote-token.json'),
    join(configDir, 'channels.json'),
    join(configDir, 'sdk-config'),
  ]
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    // 根目录不存在时退回到 resolve，仍能按前缀拦截
    return resolve(path)
  }
}

/**
 * 比较用的路径大小写归一。
 *
 * 必须显式做，不能指望 realpath：Windows 上 `realpathSync` 只解析符号链接/junction，
 * **不会**把大小写归一为磁盘上的真实形态（实测 `c:/users/x` 仍返回 `c:\users\x`），
 * 而 Windows 文件系统本身大小写不敏感。若不归一会造成两类错误：
 *   1. 误拒——Agent 输出常带小写盘符（`c:/users/...`），会被判成不在授权根内，
 *      表现为「预览正常、但用默认应用打开/保存静默失败」；
 *   2. 漏拦——凭据目录用不同大小写就能绕过前缀拦截（安全边界）。
 * macOS/Linux 保持区分大小写，不能放松。
 */
function normalizePathCase(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function matchesRoot(normalizedTarget: string, normalizedRoot: string): boolean {
  if (normalizedTarget === normalizedRoot) return true
  // 根目录可能是文件系统根（`C:\`、`/`），本身已带分隔符，避免拼出 `C:\\`
  const base = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep
  return normalizedTarget.startsWith(base)
}

/**
 * 目标路径是否落在根目录内。两侧都会 realpath（消解符号链接）并做平台大小写归一。
 *
 * 供主进程各处「授权根 / 敏感目录」前缀判定复用，避免各写一份 `startsWith` 时漏掉大小写。
 */
export function isPathInsideRoot(targetPath: string, root: string): boolean {
  return matchesRoot(
    normalizePathCase(realpathOrResolve(targetPath)),
    normalizePathCase(realpathOrResolve(root)),
  )
}

/** 目标路径是否落在任一根目录内（目标只 realpath 一次，根逐个比对）。 */
export function isPathInsideAnyRoot(targetPath: string, roots: string[]): boolean {
  const normalizedTarget = normalizePathCase(realpathOrResolve(targetPath))
  return roots.some((root) => matchesRoot(normalizedTarget, normalizePathCase(realpathOrResolve(root))))
}

/**
 * 系统敏感位置判定。传入未 realpath 的路径也能正确判定（内部会归一化）。
 */
export function isSystemSensitivePath(path: string): boolean {
  return isPathInsideAnyRoot(path, SYSTEM_SENSITIVE_ROOTS)
}

/** 凭据与隐私位置判定（同样不要求调用方先 realpath）。 */
export function isCredentialSensitivePath(path: string, roots: string[] = getCredentialSensitiveRoots()): boolean {
  return isPathInsideAnyRoot(path, roots)
}

export interface PreviewPathPolicy {
  /** 覆盖系统敏感根（测试用） */
  systemSensitiveRoots?: string[]
  /** 覆盖凭据敏感根（测试用） */
  credentialSensitiveRoots?: string[]
}

/**
 * 只读预览判定：路径真实存在，且不在系统敏感与凭据敏感位置。
 *
 * 注意：这里刻意不要求路径落在会话授权根内，见文件头说明。
 */
export function isReadOnlyPreviewPathAllowed(filePath: string, policy?: PreviewPathPolicy): boolean {
  if (!filePath) return false
  // 路径必须真实存在（预览本来也读不到内容）；realpath 同时消解符号链接，
  // 指向 ~/.ssh 的软链会被下面的边界拦下。
  if (!existsSync(filePath)) return false
  const resolved = realpathOrResolve(filePath)
  if (!existsSync(resolved)) return false
  if (isPathInsideAnyRoot(resolved, policy?.systemSensitiveRoots ?? SYSTEM_SENSITIVE_ROOTS)) return false
  if (isPathInsideAnyRoot(resolved, policy?.credentialSensitiveRoots ?? getCredentialSensitiveRoots())) return false
  return true
}
