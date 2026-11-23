/** 新核默认优先；仅显式重启到 legacy 模式时使用旧桌面执行链，不做故障自动回落。 */
export function isLocalCoreEnabled(): boolean { return process.env.PROFER_LOCAL_CORE_MODE !== 'legacy' }

export function isIndependentLocalCore(): boolean { return process.env.PROFER_LOCAL_CORE_MODE === 'independent' }
