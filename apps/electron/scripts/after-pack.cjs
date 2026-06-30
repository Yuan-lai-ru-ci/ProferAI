/**
 * electron-builder afterPack hook — patch Windows exe icon + version info
 * electron-builder v25 + Electron 39+ requires rcedit >= 3.x (bundled with npm rcedit)
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

function findRcedit() {
  // Prefer npm rcedit v5.x (works with Electron 39+)
  const projDir = join(__dirname, '..')
  const npmRcedit = join(projDir, '..', '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  if (existsSync(npmRcedit)) return npmRcedit
  // Fallback: winCodeSign cache (may be too old)
  const { readdirSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const cacheDir = join(tmpdir(), '..', '..', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  for (const dir of readdirSync(cacheDir)) {
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
    // rcedit <filename> [options] — filename MUST come first
    execFileSync(rcedit, [
      exePath,
      '--set-icon', icoPath,
      '--set-version-string', 'ProductName', 'Profer',
      '--set-version-string', 'FileDescription', 'Profer',
      '--set-version-string', 'CompanyName', 'Profer Team',
    ], { stdio: 'ignore' })
    console.log('  [afterPack] fixed exe icon + metadata')
  } catch (err) {
    console.warn('  [afterPack] rcedit failed:', err.message || err)
  }
}
