/**
 * 「我的画像」字段映射 —— renderer 侧入口。
 *
 * 实现在 `@profer/user-memory/profile-fields`，与 profer CLI 的
 * `profile get/set` 共用同一套行级读写规则，避免 GUI 和命令行写出
 * 两种不同的 Markdown 结构。
 *
 * 这里保留同名 re-export，是为了让 renderer 内部的相对 import 不用改，
 * 同时明确「这个文件不再承载逻辑」。改规则请改包里的实现。
 */

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
  type QuickField,
  type QuickFieldKey,
} from '@profer/user-memory/profile-fields'
