import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const src = join(import.meta.dirname, '..', 'resources')
const dest = join(import.meta.dirname, '..', 'dist', 'resources')

if (!existsSync(src)) {
  console.error('resources/ not found')
  process.exit(1)
}

mkdirSync(join(import.meta.dirname, '..', 'dist'), { recursive: true })

try {
  cpSync(src, dest, { recursive: true, force: true })
  console.log('resources → dist/resources')
} catch (err) {
  console.error('copy failed:', err)
  process.exit(1)
}
