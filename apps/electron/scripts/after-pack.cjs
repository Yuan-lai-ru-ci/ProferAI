/**
 * electron-builder afterPack hook — 给 Windows exe 打 Profer 图标 + 版本信息
 * electron-builder v25 + Electron 43 需 rcedit >= 3.x（用仓库 node_modules 里的 rcedit）
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
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

module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = join(context.appOutDir, 'Profer.exe')
  const icoPath = join(context.packager.projectDir, 'resources', 'icon.ico')
  if (!existsSync(exePath) || !existsSync(icoPath)) return

  try {
    const rcedit = findRcedit()
    execFileSync(rcedit, [
      exePath,
      '--set-icon', icoPath,
      '--set-version-string', 'ProductName', 'Profer',
      '--set-version-string', 'FileDescription', 'Profer',
      '--set-version-string', 'CompanyName', 'Profer Team',
    ], { stdio: 'ignore' })
    console.log('  [afterPack] Profer icon + metadata patched')
  } catch (err) {
    console.warn('  [afterPack] rcedit failed:', err.message || err)
  }
}
