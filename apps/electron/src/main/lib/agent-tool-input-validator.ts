/**
 * 工具参数校验模块
 *
 * 在 canUseTool 回调中拦截参数缺失的工具调用，
 * 返回描述性 deny message 引导模型重试。
 */

/** 已知工具的必需参数映射（使用权限层 canonical 字段名） */
export const TOOL_REQUIRED_PARAMS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['Write', ['file_path', 'content']],
  ['Edit', ['file_path', 'old_string', 'new_string']],
  ['MultiEdit', ['file_path', 'old_string', 'new_string']],
  ['Bash', ['command']],
  ['Read', ['file_path']],
  ['Glob', ['pattern']],
  ['Grep', ['pattern']],
  ['Agent', ['prompt', 'description']],
])

function canonicalToolName(toolName: string): string {
  return toolName === 'MultiEdit' ? 'Edit' : toolName
}

function firstPiEdit(input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(input.edits)) return undefined
  return input.edits.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

/**
 * 将 Claude/Profer canonical 输入和 Pi 原生输入统一到权限校验形状。
 *
 * Pi 的内置 Edit 使用 path + edits[].oldText/newText；权限服务则统一使用
 * file_path + old_string/new_string。这里必须在必需参数校验前完成归一化，
 * 不能把 Pi 的合法参数误判为缺少 Claude 字段。
 */
export function normalizeToolInputForValidation(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown>; missingNested?: string[] } {
  const canonicalName = canonicalToolName(toolName)
  if (canonicalName === 'Read' || canonicalName === 'Write') {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
    }
  }

  if (canonicalName !== 'Edit') {
    return { toolName: canonicalName, input }
  }

  // 只有出现 `edits` 字段时才按 Pi 原生 Edit 处理；没有该字段的输入是
  // Claude/Profer canonical 的单编辑格式，不应被误判为缺少 Pi edits。
  if (!Object.prototype.hasOwnProperty.call(input, 'edits')) {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
    }
  }

  const editItems = Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  if (editItems.length === 0) {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
      missingNested: ['edits'],
    }
  }

  const first = firstPiEdit(input) ?? editItems[0]
  const missingNested = editItems.flatMap((edit, index) => [
    (edit.old_string ?? edit.oldText) === undefined || (edit.old_string ?? edit.oldText) === ''
      ? `edits[${index}].oldText`
      : '',
    // 空 newText 是合法操作，表示删除匹配到的文本；这里只检查字段是否存在。
    (edit.new_string ?? edit.newText) === undefined
      ? `edits[${index}].newText`
      : '',
  ].filter(Boolean))

  return {
    toolName: canonicalName,
    input: {
      ...input,
      file_path: input.file_path ?? input.path,
      old_string: input.old_string ?? first?.old_string ?? first?.oldText,
      new_string: input.new_string ?? first?.new_string ?? first?.newText,
    },
    ...(missingNested.length > 0 && { missingNested }),
  }
}

/** 校验失败结果，与 PermissionResult deny 形状一致 */
export interface ToolValidationFailure {
  behavior: 'deny'
  message: string
}

/**
 * 校验工具调用的必需参数是否存在且非空。
 *
 * 未知工具或参数完整时返回 null；
 * 参数缺失时返回 deny 结果，message 中列出缺失的参数名。
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>,
): ToolValidationFailure | null {
  const normalized = normalizeToolInputForValidation(toolName, input)
  const requiredParams = TOOL_REQUIRED_PARAMS.get(normalized.toolName)
  if (!requiredParams) return null

  const missing: string[] = [...(normalized.missingNested ?? [])]
  for (const param of requiredParams) {
    const value = normalized.input[param]
    // Edit/Write 允许空字符串作为有效内容（分别表示删除替换内容和创建空文件）；
    // 真正缺失只包括 undefined/null。Bash 等字符串参数仍拒绝空白命令。
    if (value === undefined || value === null || (param === 'command' && typeof value === 'string' && value.trim() === '')) {
      missing.push(param)
    }
  }

  if (missing.length === 0) return null

  const uniqueMissing = [...new Set(missing)]
  const paramList = uniqueMissing.map((p) => `"${p}"`).join(', ')
  const message = uniqueMissing.some((param) => param.startsWith('edits['))
    ? `Tool "${toolName}" has invalid Pi Edit input: ${paramList}. Please retry after re-reading the current file and provide path + edits[].oldText/newText; do not reuse oldText from a failed call.`
    : uniqueMissing.length === 1
      ? `Tool "${toolName}" is missing required parameter ${paramList}. Please retry with all required parameters filled in.`
      : `Tool "${toolName}" is missing required parameters: ${paramList}. Please retry with all required parameters filled in.`

  return { behavior: 'deny' as const, message }
}
