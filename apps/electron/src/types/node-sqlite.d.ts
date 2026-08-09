/**
 * node:sqlite 内置模块类型声明（Bun 不识别，Node 22.13+/Electron 43 内置）。
 *
 * 项目 @types/node 为 ^20，不含 node:sqlite 类型。运行时代码（memory-archive-search.ts）
 * 运行在 Electron 43（Node 24.18）下，node:sqlite 可用，此处仅补最小类型以满足 typecheck。
 * 只声明本项目实际用到的 `write`、`all`、`run`、`exec` 子集。
 */
declare module 'node:sqlite' {
  export interface StatementSync<Result = unknown> {
    /** 执行 INSERT/UPDATE/DELETE，返回 lastInsertRowid / changes。 */
    run(...anonymousParameters: unknown[]): {
      lastInsertRowid: number | bigint
      changes: number | bigint
    }
    /** 执行 SELECT 并返回全部行。 */
    all(...anonymousParameters: unknown[]): Result[]
    get(...anonymousParameters: unknown[]): Result | undefined
  }

  export class DatabaseSync {
    constructor(filename: string): DatabaseSync
    exec(sql: string): void
    prepare<Result = unknown>(sql: string): StatementSync<Result>
    close(): void
  }

  export const constants: Record<string, number | bigint>
}
