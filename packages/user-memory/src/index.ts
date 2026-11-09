/**
 * @profer/user-memory — 无 UI 依赖的用户画像与全局记忆层。
 *
 * 定位：Electron 主进程、profer CLI 以及未来任何 headless 宿主的**唯一**读写入口。
 * 本包只依赖 node:fs / node:path / node:os，不 import electron，也不碰 DOM。
 *
 * 分层：
 *   paths.ts           配置目录与文件布局（不含 Electron 的 isPackaged 探测）
 *   global-memory.ts   全局记忆目录树：初始化 / 读写 / 搜索 / 删除（写入带跨进程锁）
 *   user-profile.ts    用户名 + 头像（user-profile.json）
 *   profile-fields.ts  画像字段 ⇄ Markdown 小节的双向映射（纯函数）
 *   profile.ts         字段读写门面
 *   projection.ts      画像 → 提示词文本
 */

export {
  resolveConfigDir,
  getGlobalMemoryDir,
  getUserProfilePath,
  type ConfigDirOptions,
} from './paths'

export {
  DEFAULT_USER_AVATAR,
  DEFAULT_USER_NAME,
  readUserProfile,
  writeUserProfile,
  type UserProfile,
} from './user-profile'

export {
  GLOBAL_MEMORY_INDEX_FILE,
  INITIAL_GLOBAL_MEMORY_FILES,
  ensureGlobalMemoryInitialized,
  getGlobalMemoryRoot,
  getGlobalMemorySummary,
  listGlobalMemoryFiles,
  readGlobalMemoryFile,
  writeGlobalMemoryFile,
  deleteGlobalMemoryFile,
  searchGlobalMemory,
} from './global-memory'

export {
  QUICK_FIELDS,
  QUICK_FIELD_FILES,
  normalizeFieldValue,
  readField,
  writeField,
  freeTextPreview,
  plainText,
  isFieldTitle,
  customSectionTitles,
  readProfileList,
  writeProfileList,
  type QuickField,
  type QuickFieldKey,
  type ProfileListItem,
  type ProfileListKind,
  type ProfileDeviceType,
} from './profile-fields'

export {
  resolveQuickField,
  readProfileField,
  writeProfileField,
  readProfileFields,
  type ProfileFieldValue,
} from './profile'

export {
  escapeContextText,
  buildGlobalMemoryIndexBlock,
  buildUserIdentitySection,
  buildUserContext,
  type UserContextInput,
} from './projection'

export { withFileLock, type FileLockOptions } from './lock'
