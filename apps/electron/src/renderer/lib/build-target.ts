/**
 * renderer 侧的发行版判定。
 *
 * 主进程有同名模块 `src/main/lib/build-target.ts`（由 esbuild `--define` 注入），
 * renderer 由 Vite 打包，注入的是 `vite.config.ts` 里的同一个常量名，因此两份实现
 * 都读 `__PROFER_BUILD_TARGET__`，语义保持一致。
 *
 * 默认按**开源版**处理：忘记传 `--mode commercial` 时宁可少显示商业入口，
 * 也不能把登录/额度/订阅漏进开源包。
 *
 * 用 `typeof` 安全读取，源码测试环境（bun）没有注入该常量时不会抛 ReferenceError。
 */
export type BuildTarget = 'oss' | 'commercial'

declare const __PROFER_BUILD_TARGET__: BuildTarget | undefined

export function getBuildTarget(): BuildTarget {
  return typeof __PROFER_BUILD_TARGET__ === 'undefined'
    ? 'oss'
    : __PROFER_BUILD_TARGET__ === 'commercial'
      ? 'commercial'
      : 'oss'
}

export function isCommercialBuild(): boolean {
  return getBuildTarget() === 'commercial'
}
