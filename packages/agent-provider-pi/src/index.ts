/**
 * @profer/agent-provider-pi
 *
 * Pi Agent SDK provider（宿主无关）：
 * - 完整 Pi adapter、消息/SDK 转换、模型注册、工具定义与重试/流控控制；
 * - 只依赖 runtime 契约、@profer/shared 与 Pi SDK；
 * - 宿主事实（账号策略、凭据落盘、权限 UI、持久化、产品工具）由注入端口提供；
 * - 不直接或间接导入 apps/electron。
 */

export * from './pi-agent-adapter'
export type {
  PiAgentAdapterPorts,
  PiImageTranscodeInput,
  PiImageTranscodeOptions,
  PiImageTranscodeResult,
  PiImageTranscoderPort,
  PiProviderHostDependencies,
  PiToolResultPersistPort,
} from './ports'
export type {
  PiCanUseTool,
  PiCanUseToolOptions,
  PiPermissionDecisionClassification,
  PiPermissionResult,
  PiPermissionResultMetadata,
  PiPermissionRuleValue,
  PiPermissionUpdate,
  PiPermissionUpdateDestination,
} from './permission'
export type {
  PiFileMutationEvidence,
  PiFileVersion,
  PiStoredFileVersion,
} from './pi/rewind-evidence'
export { findPiSessionFile, rewindPiTranscript } from './pi-transcript-rewind'
export type { PiTranscriptRewindResult } from './pi-transcript-rewind'
