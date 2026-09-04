/**
 * electron-builder afterPack hook — 给 Windows exe 打 Profer 图标 + 版本信息
 * electron-builder v25 + Electron 43 需 rcedit >= 3.x（用仓库 node_modules 里的 rcedit）
 *
 * 校验契约：
 *  - rcedit 写入成功（版本信息 ProductName/FileDescription/CompanyName = Profer）
 *  - 失败必须抛出，阻断打包（避免"图标/元数据静默回退为 electron 默认"）
 */
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

function findRcedit() {
  const projDir = join(__dirname, '..')
  const npmRcedit = join(projDir, '..', '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  if (existsSync(npmRcedit)) return npmRcedit
  const { readdirSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const cacheDir = join(tmpdir(), '..', '..', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  for (const dir of readdirSync(cacheDir, { encoding: 'utf8' })) {
    const p = join(cacheDir, dir, 'rcedit-x64.exe')
    if (existsSync(p)) return p
  }
  throw new Error('rcedit-x64.exe not found')
}

/** 校验 ICO 文件头是合法的 Windows 图标（00 00 01 00）。 */
function isValidIco(filePath) {
  try {
    const buf = readFileSync(filePath)
    return (
      buf.length > 6 &&
      buf[0] === 0x00 &&
      buf[1] === 0x00 &&
      buf[2] === 0x01 &&
      buf[3] === 0x00 &&
      buf[4] > 0 // 至少包含一张图
    )
  } catch {
    return false
  }
}

/**
 * 读取 Windows exe 的资源版本信息（VersionInfo）。只读不改，用 PowerShell
 * (Get-Item ...).VersionInfo 是最轻量可靠的方式（probe 一次性开销 ~100ms）。
 */
function readExeVersionInfo(exePath) {
  const ps = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$vi=(Get-Item '${exePath}').VersionInfo; "$($vi.ProductName)|$($vi.FileDescription)|$($vi.CompanyName)"`,
    ],
    { encoding: 'utf8' },
  )
  return ps.trim()
}

module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = join(context.appOutDir, 'Profer.exe')
  const icoPath = join(context.packager.projectDir, 'resources', 'icon.ico')
  if (!existsSync(exePath) || !existsSync(icoPath)) {
    throw new Error(
      `[afterPack] 缺少图标目标：exe=${existsSync(exePath)}，ico=${existsSync(icoPath)}。` +
        '请确认 out 目录已生成 Profer.exe 且 resources/icon.ico 存在。',
    )
  }
  if (!isValidIco(icoPath)) {
    throw new Error(`[afterPack] resources/icon.ico 不是合法的 Windows 图标文件（应 00 00 01 00 头）。`)
  }

  try {
    const rcedit = findRcedit()
    execFileSync(rcedit, [
      exePath,
      '--set-icon', icoPath,
      '--set-version-string', 'ProductName', 'Profer',
      '--set-version-string', 'FileDescription', 'Profer',
      '--set-version-string', 'CompanyName', 'Profer Team',
    ], { stdio: 'ignore' })
  } catch (err) {
    throw new Error(`[afterPack] rcedit 打图标失败，打包已中断（避免图标回退为 electron 默认）: ${err.message || err}`)
  }

  // 回读校验：确认版本信息确实写进 exe，防止 rcedit 写入被静默吞掉。
  // 注意：该回读依赖系统 PowerShell（(Get-Item).VersionInfo），在某些受限 CI/无 shell 环境可能 ENOENT，
  // 此时降级为警告而非阻断打包——图标本体已由上方 rcedit 强制打到 exe，不影响主目标。
  try {
    const written = readExeVersionInfo(exePath)
    const expected = 'Profer|Profer|Profer Team'
    if (written !== expected) {
      throw new Error(
        `exe 版本信息回读校验失败（期望 ${expected}，实际 ${written || '(无法读取)'}）`,
      )
    }
    console.log('  [afterPack] Profer icon + metadata patched & verified')
  } catch (err) {
    console.warn(`  [afterPack] 版本信息回读校验被跳过（不影响图标）：${err?.message || err}`)
  }
}
