/** 构建目标类型：oss=开源版，commercial=商业版。 */
export type BuildTarget = 'oss' | 'commercial'

/** esbuild 构建时注入，源码测试环境可能不存在。 */
declare const __PROFER_BUILD_TARGET__: BuildTarget | undefined

/**
 * 读取 esbuild 注入的构建目标。
 *
 * 直接访问未注入的全局常量会在源码测试环境触发 ReferenceError，
 * 因此统一用 typeof 安全读取。
 */
export function getBuildTarget(): BuildTarget {
  const target = typeof __PROFER_BUILD_TARGET__ === 'undefined' ? 'oss' : __PROFER_BUILD_TARGET__
  return target === 'commercial' ? 'commercial' : 'oss'
}

export function isCommercialBuild(): boolean {
  return getBuildTarget() === 'commercial'
}
