/** 将 CORS Origin 配置规范化为安全默认值。 */
export function resolveAllowedOrigin(value) {
  return value?.trim() || 'none'
}
