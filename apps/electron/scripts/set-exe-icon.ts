/**
 * Set Windows exe icon + version info using npm rcedit (v5.x, ESM)
 * electron-builder's bundled rcedit (2.6.0) doesn't work with Electron 39+.
 */
import { rcedit } from 'rcedit'
import { existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const exePath = join(import.meta.dirname, '..', 'out', 'win-unpacked', 'Proma.exe')
const icoPath = join(import.meta.dirname, '..', 'resources', 'icon.ico')

if (!existsSync(exePath)) {
  console.error('ERROR: Proma.exe not found at', exePath)
  process.exit(1)
}
if (!existsSync(icoPath)) {
  console.error('ERROR: icon.ico not found at', icoPath)
  process.exit(1)
}

console.log('Patching:', exePath)
console.log('Icon:', icoPath)

await rcedit(exePath, {
  'version-string': {
    ProductName: 'Proma',
    FileDescription: 'Proma',
    CompanyName: 'Proma Team',
    LegalCopyright: 'Copyright © 2024-2026 Erlich Liu',
  },
  icon: icoPath,
})

console.log('Done — icon + metadata applied')
