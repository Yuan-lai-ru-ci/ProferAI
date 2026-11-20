import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PiToolResultPersistPort } from '@profer/agent-provider-pi'
import { hostKey } from './process-host'

/** 复用 Electron 工具结果的内容寻址语义，存储根由所属 Core 显式注入。 */
export function createCoreToolResultPersist(dataDir: string): PiToolResultPersistPort {
  return {
    persist({ sessionId, toolCallId, text, isJson }) {
      const dir = join(dataDir, 'tool-results', hostKey(sessionId))
      mkdirSync(dir, { recursive: true })
      const hash = createHash('sha256').update(text).digest('hex')
      const path = join(dir, `${hostKey(toolCallId)}-${hash}.${isJson ? 'json' : 'txt'}`)
      if (!existsSync(path)) {
        const temporary = `${path}.${randomUUID()}.tmp`
        writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, path)
      }
      return { path }
    },
  }
}
