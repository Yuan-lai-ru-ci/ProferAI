/**
 * 外部（安装器 / 卸载器 / 自动化脚本）请求「正在运行的 Profer 退出」的命令行开关。
 *
 * Windows 上点击窗口关闭只会隐藏到托盘，NSIS 安装器发不出真正的退出信号，
 * 于是升级时经常停在「Profer 无法关闭」，只能让用户去任务管理器结束进程。
 * 安装器改为执行 `Profer.exe --quit`：第二个实例把请求转给主实例并走正常退出
 * 清理（会话落盘、远控/持久化清理），随后安装器才做 /F 兜底。
 */
export const QUIT_REQUEST_FLAG = '--quit'

/** argv 中是否包含退出请求开关。 */
export function isQuitRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === QUIT_REQUEST_FLAG)
}
