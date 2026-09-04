import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Remote WS file preview is deliberately stricter than the desktop IPC policy.
 * A remote client may choose a file path but never expands its own authorization roots.
 */
export interface RemoteFileAccessContext {
  directoryRoots: string[]
  exactFiles: string[]
}

function realpathIfFile(path: string): string | null {
  try {
    const resolved = realpathSync(resolve(path))
    return statSync(resolved).isFile() ? resolved : null
  } catch {
    return null
  }
}

function realpathIfExisting(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(resolve(path)) : null
  } catch {
    return null
  }
}

function isInsideDirectory(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/**
 * Resolve an existing file only when it belongs to a server-derived workspace
 * root or equals a server-derived explicitly attached file. Symlink targets are
 * checked after realpath resolution, so an in-root symlink cannot escape.
 */
export function resolveAuthorizedRemoteFilePath(
  filePath: string,
  context: RemoteFileAccessContext,
): string | null {
  if (!filePath || typeof filePath !== 'string') return null

  const directoryRoots = context.directoryRoots
    .map(realpathIfExisting)
    .filter((root): root is string => root !== null)
  const exactFiles = new Set(
    context.exactFiles
      .map(realpathIfFile)
      .filter((path): path is string => path !== null),
  )

  const candidates = isAbsolute(filePath)
    ? [filePath]
    : directoryRoots.map((root) => resolve(root, filePath))

  for (const candidate of candidates) {
    const resolved = realpathIfFile(candidate)
    if (!resolved) continue
    if (exactFiles.has(resolved) || directoryRoots.some((root) => isInsideDirectory(resolved, root))) {
      return resolved
    }
  }

  return null
}
