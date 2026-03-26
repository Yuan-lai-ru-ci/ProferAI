/**
 * 工具活动项的可复用工具函数和常量
 * 从 ToolActivityItem.tsx 中提取，供多处复用
 */

import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Bot,
  ClipboardList,
  Download,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  ImagePlus,
  List,
  ListChecks,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Terminal,
  Users,
  Wrench,
  Zap,
} from 'lucide-react'

/** 工具名称到图标组件的映射 */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  Edit: Pencil,
  Write: FilePenLine,
  Read: FileText,
  Bash: Terminal,
  Glob: FolderSearch,
  Grep: Search,
  Task: GitBranch,
  WebFetch: Download,
  WebSearch: Globe,
  NotebookEdit: BookOpen,
  Skill: Zap,
  TodoWrite: ListChecks,
  TodoRead: ClipboardList,
  TaskCreate: FilePlus,
  TaskUpdate: RefreshCw,
  TaskGet: FileSearch,
  TaskList: List,
  TeamCreate: Users,
  Agent: Bot,
  generate_image: ImagePlus,
}

/**
 * 根据工具名称获取对应的图标组件
 * MCP 工具（mcp__serverName__toolName）使用 Plug 图标
 * 未匹配时返回默认的 Wrench 图标
 */
export function getToolIcon(toolName: string): LucideIcon {
  if (TOOL_ICONS[toolName]) return TOOL_ICONS[toolName]
  if (toolName.startsWith('mcp__')) return Plug
  return Wrench
}

/** 内置工具显示名称映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Edit: '编辑文件',
  Write: '写入文件',
  Read: '读取文件',
  Bash: '执行命令',
  Glob: '搜索文件',
  Grep: '搜索内容',
  Task: '任务工具',
  WebFetch: '抓取网页',
  WebSearch: '搜索网页',
  NotebookEdit: '编辑笔记本',
  Skill: '使用技能',
  TodoWrite: '更新待办',
  TodoRead: '阅读待办',
  TaskCreate: '任务创建',
  TaskUpdate: '任务更新',
  TaskGet: '任务加载',
  TaskList: '任务列表',
  TeamCreate: '创建团队',
  Agent: 'Agent 调用',
  generate_image: '生成图片',
}

/**
 * 获取工具的显示名称
 * MCP 工具解析为 "serverName / toolName" 格式
 * 内置工具返回中文名称，其余返回原始名称
 */
export function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName]
  // MCP 工具：mcp__serverName__toolName → "SERVERNAME / TOOLNAME"
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1].toUpperCase()} / ${parts.slice(2).join('_').toUpperCase()}`
  }
  return toolName
}

/**
 * 根据工具名称和输入参数生成简洁的摘要文本
 * 用于在工具活动列表中展示关键信息
 */
export function getInputSummary(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  switch (toolName) {
    case 'Bash': {
      const command = input.command
      if (typeof command === 'string') {
        return command.length > 80 ? command.slice(0, 80) + '…' : command
      }
      return null
    }

    case 'Grep': {
      const pattern = input.pattern
      if (typeof pattern === 'string') {
        return `/${pattern}/`
      }
      return null
    }

    case 'Glob': {
      const pattern = input.pattern
      if (typeof pattern === 'string') {
        return pattern
      }
      return null
    }

    case 'WebFetch': {
      const url = input.url
      if (typeof url === 'string') {
        return url.length > 60 ? url.slice(0, 60) + '…' : url
      }
      return null
    }

    case 'WebSearch': {
      const query = input.query
      if (typeof query === 'string') {
        return query.length > 60 ? query.slice(0, 60) + '…' : query
      }
      return null
    }

    case 'Skill': {
      const skill = input.skill
      if (typeof skill === 'string') {
        return skill
      }
      return null
    }

    case 'Task': {
      const description = input.description ?? input.prompt
      if (typeof description === 'string') {
        return description.length > 80
          ? description.slice(0, 80) + '…'
          : description
      }
      return null
    }

    case 'TaskCreate': {
      const subject = input.subject
      if (typeof subject === 'string') {
        return subject
      }
      return null
    }

    case 'TaskUpdate': {
      const parts: string[] = []
      if (typeof input.taskId === 'string') {
        parts.push(`#${input.taskId}`)
      }
      if (typeof input.status === 'string') {
        parts.push(input.status)
      }
      if (typeof input.subject === 'string') {
        parts.push(input.subject)
      }
      return parts.length > 0 ? parts.join(' · ') : null
    }

    case 'TaskGet': {
      const taskId = input.taskId
      if (typeof taskId === 'string') {
        return `#${taskId}`
      }
      return null
    }

    case 'TaskList': {
      const reason = input.reason
      if (typeof reason === 'string') {
        return reason
      }
      return null
    }

    case 'Read':
    case 'Edit':
    case 'Write': {
      const filePath = input.file_path
      if (typeof filePath === 'string') {
        // 仅展示文件名，不展示完整路径
        return filePath.split('/').pop() ?? filePath
      }
      return null
    }

    case 'NotebookEdit': {
      const notebookPath = input.notebook_path
      if (typeof notebookPath === 'string') {
        return notebookPath.split('/').pop() ?? notebookPath
      }
      return null
    }

    case 'TodoWrite': {
      const todos = input.todos
      if (Array.isArray(todos)) {
        return `${todos.length} 项待办`
      }
      return null
    }

    case 'TeamCreate': {
      const parts: string[] = []
      if (typeof input.team_name === 'string') {
        parts.push(input.team_name)
      }
      if (typeof input.description === 'string') {
        parts.push(input.description)
      }
      return parts.length > 0 ? parts.join(' · ') : null
    }

    case 'Agent': {
      const parts: string[] = []
      if (typeof input.name === 'string') {
        parts.push(input.name)
      }
      const detail = input.description ?? input.prompt
      if (typeof detail === 'string') {
        parts.push(detail)
      }
      return parts.length > 0 ? parts.join(' · ') : null
    }

    case 'generate_image': {
      const prompt = input.prompt
      if (typeof prompt === 'string') {
        return prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt
      }
      return null
    }

    default:
      return null
  }
}

/**
 * 从工具输入参数中提取文件路径
 * 按优先级依次检查常见的路径字段名
 */
export function extractFilePath(
  input: Record<string, unknown>
): string | null {
  const value =
    input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
  if (typeof value === 'string') {
    return value
  }
  return null
}

/**
 * 计算 Edit 工具的差异统计（新增/删除行数）
 * 仅对 Edit 工具有效，其他工具返回 null
 */
export function computeDiffStats(
  toolName: string,
  input: Record<string, unknown>
): { additions: number; deletions: number } | null {
  if (toolName !== 'Edit') {
    return null
  }

  const oldString = input.old_string
  const newString = input.new_string

  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    return null
  }

  const oldLines = oldString ? oldString.split('\n').length : 0
  const newLines = newString ? newString.split('\n').length : 0

  return {
    additions: newLines,
    deletions: oldLines,
  }
}

/**
 * 将秒数格式化为可读的耗时字符串
 * 60 秒以内显示 "X.Xs"，超过 60 秒显示 "Xm Ys"
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}
