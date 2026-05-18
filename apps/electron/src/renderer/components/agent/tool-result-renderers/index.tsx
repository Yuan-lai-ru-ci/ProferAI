/**
 * ToolResultRenderer — 工具结果分发渲染器
 *
 * 根据工具名称分发到对应的专属渲染器，
 * 未匹配时使用 DefaultResultRenderer。
 */

import * as React from 'react'
import { BashResultRenderer } from './bash-result'
import { ReadResultRenderer } from './read-result'
import { EditResultRenderer } from './edit-result'
import { WriteResultRenderer } from './write-result'
import { GrepResultRenderer } from './grep-result'
import { GlobResultRenderer } from './glob-result'
import { WebSearchResultRenderer } from './web-search-result'
import { WebFetchResultRenderer } from './web-fetch-result'
import { TaskGetResultRenderer } from './task-get-result'
import { TaskListResultRenderer } from './task-list-result'
import { DefaultResultRenderer } from './default-result'
import type { TaskItem } from '../task-progress'

export interface ToolResultRendererProps {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  basePath?: string
  latestTaskItems?: TaskItem[]
}

export function ToolResultRenderer({ toolName, input, result, isError, basePath, latestTaskItems }: ToolResultRendererProps): React.ReactElement {
  switch (toolName) {
    case 'Bash':
      return <BashResultRenderer result={result} isError={isError} input={input} />
    case 'Read':
      return <ReadResultRenderer result={result} isError={isError} input={input} />
    case 'Edit':
      return <EditResultRenderer result={result} isError={isError} input={input} basePath={basePath} />
    case 'Write':
      return <WriteResultRenderer result={result} isError={isError} input={input} />
    case 'Grep':
      return <GrepResultRenderer result={result} isError={isError} input={input} />
    case 'Glob':
      return <GlobResultRenderer result={result} isError={isError} />
    case 'WebSearch':
      return <WebSearchResultRenderer result={result} isError={isError} />
    case 'WebFetch':
      return <WebFetchResultRenderer result={result} isError={isError} />
    case 'TaskGet':
      return <TaskGetResultRenderer result={result} isError={isError} />
    case 'TaskList':
      return <TaskListResultRenderer result={result} isError={isError} latestTaskItems={latestTaskItems} />
    default:
      return <DefaultResultRenderer result={result} isError={isError} />
  }
}

export { CollapsibleResult } from './collapsible-result'
