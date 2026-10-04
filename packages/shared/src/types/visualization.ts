/** 会话内可视化：结果、不可变修订与有界视图状态的共享契约。 */
export type VisualizationKind = 'structure' | 'comparison' | 'data' | 'explanation'
export interface VisualizationChartSeries {
  dataKey: string
  label?: string
  valuePrefix?: string
  valueSuffix?: string
}
/** 标准图表只接收数据映射，不接收 ECharts option、代码、任意样式或函数。 */
export interface VisualizationChartSpec {
  chartType: 'bar' | 'line' | 'pie' | 'scatter'
  xKey?: string
  xAxisLabel?: string
  nameKey?: string
  valueKey?: string
  layout?: 'horizontal' | 'vertical'
  series: VisualizationChartSeries[]
  data: Array<Record<string, string | number>>
}
export interface VisualizationObject {
  id: string
  label: string
  text?: string
}
export interface VisualizationRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  toolCallId: string
  sourceMessageId?: string
  sourceText?: string
  title: string
  kind: VisualizationKind
  format?: 'html' | 'fragment' | 'chart'
  chart?: VisualizationChartSpec
  revision: string
  recordVersion: number
  summary: string
  objects: VisualizationObject[]
  createdAt: number
  updatedAt: number
}
export interface VisualizationContent {
  record: VisualizationRecord
  html: string
}
export interface PresentVisualizationInput {
  filePath?: string
  chart?: VisualizationChartSpec
  format?: 'html' | 'fragment'
  title: string
  kind?: VisualizationKind
  summary: string
  objects?: VisualizationObject[]
  visualizationId?: string
  baseRevision?: string
  sourceMessageId?: string
  sourceText?: string
}
export interface VisualizationContext {
  sessionId: string
  /** 会话工作目录：只作为生成内容的相对源文件基准与授权根。 */
  agentCwd: string
  /**
   * 可视化记录存储根。
   *
   * 必须位于会话工作区之外：记录是会话产物，一旦落在工作区里，
   * 文件检查点/快照回退、工作区清理和 Agent 自己的文件工具都会把它当普通文件处理，
   * 回退到早期基线时会直接删掉记录，而历史消息仍在引用它。
   */
  storageDir: string
  allowedRoots: string[]
}
export interface VisualizationQuote {
  visualizationId: string
  revision: string
  objectId: string
  label: string
  text: string
}
export type VisualizationViewState = Record<string, unknown>
export const VISUALIZATION_LIMITS = {
  maxHtmlBytes: 512 * 1024,
  maxObjects: 200,
  maxStateBytes: 16 * 1024,
  maxActiveInstances: 2,
  maxResultsPerSession: 128,
  maxSessionStorageBytes: 64 * 1024 * 1024,
  maxCachedSessions: 24,
  maxTitleChars: 120,
  maxSummaryChars: 2000,
} as const
export const VISUALIZATION_IPC = {
  LIST: 'visualization:list',
  READ: 'visualization:read',
  VIEW_STATE: 'visualization:view-state',
  SAVE_VIEW_STATE: 'visualization:save-view-state',
  EXPORT: 'visualization:export',
} as const
