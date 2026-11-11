/**
 * 执行链唯一的商业能力装配点。
 *
 * 本文件只做一件事：把 `@profer/edition-impl` 转发给调用方。真正的实现在
 * `./oss.ts` 与 `./commercial.ts`，由 esbuild 的 `--alias` 在构建时二选一：
 *
 *   build:main             → @profer/edition-impl = ./oss.ts
 *   build:main-commercial  → @profer/edition-impl = ./commercial.ts
 *
 * 这样 OSS 产物的模块图里**物理上不含** auth-service / account-ipc，
 * 而不是靠运行时开关把功能藏起来。类型层面 tsconfig `paths` 指到 oss.ts，
 * 两份实现都满足 `EditionProviders`，所以商业版不需要单独的类型检查配置。
 *
 * 新增商业能力时：先扩 `@profer/edition-contract`，再同时补两份实现。
 */
export { editionProviders } from '@profer/edition-impl'
