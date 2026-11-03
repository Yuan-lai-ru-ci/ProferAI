/**
 * 飞书访问凭证失败的诊断文案。
 *
 * `21001` 是飞书开放平台未收录进官方文档的访问控制策略错误码：拿到 app_id/app_secret
 * 后请求 `tenant_access_token/internal` 仍被拒。常见触发条件：
 * - 飞书账号是「豆包账号」登录，名下自建应用只要配了任意 OpenAPI 权限就被策略拦截；
 * - 应用/租户安全设置（IP 白名单、API 访问控制、区域限制）；
 * - 应用被停用 / 未发布 / 企业管理员限制。
 *
 * 这类错误不是凭证填错（凭证错误返回 10014/10015/20002），Profer 侧无法修复，
 * 但必须让用户看见原因，而不是只留一行 console。
 */
export function describeFeishuTokenFailure(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (!/21001|access control policy|platform policy/i.test(message)) return undefined

  return '飞书拒绝签发访问凭证（21001，平台访问控制策略）。'
    + '请检查：飞书账号是否为「豆包账号」登录、开发者后台「安全设置」的 IP 白名单/API 访问控制、应用是否已启用并发布。'
    + '可用飞书 API 调试台直接验证同一对 app_id/app_secret。'
}
