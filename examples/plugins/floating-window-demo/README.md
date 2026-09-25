# 悬浮窗口验收台

验收插件平台「全局悬浮插件页面」能力的内置样例。一个页面同时声明 `settings / sidebar / tab / floating` 四种形态，按 `context.surface` 切换布局：在主窗口内是验收控制台，在悬浮窗口里是透明气泡画布。

## 验收前置

1. 启动 Profer 开发版。
2. 「设置 → 插件 → 安装目录」，选中本目录 `examples/plugins/floating-window-demo`。
3. 授权 `pluginStorage` 与 `window.floating`（显示全局悬浮窗口）。

## 自动验收（一键）

在控制台页点「运行完整验收」，依次核对日志：

- 形态识别为控制台（settings/tab/sidebar）
- 打开悬浮窗口，气泡出现在屏幕右下角附近
- 重复 open 复用同一窗口（不创建第二个）
- 隐藏 → `isVisible=false`；显示 → `isVisible=true`
- `getBounds` 与 open 返回值一致
- `setBounds({x:40,y:40})` 只改位置
- `setBounds({x:99999,y:99999})` 被宿主钳制回可见区域
- 鼠标穿透可开可关
- 插件私有存储读写正常（悬浮能力与既有权限共存）
- `close` 后 `isVisible=false` 且 `getBounds=null`

## 手动验收清单

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 运行形态 | 分别在设置页/侧边栏/Tab 打开页面，与悬浮气泡对比 | `context.surface` 各自正确；同一页面两种形态可同时存在 |
| 未授权 | 重新安装后不授权 `window.floating`，点「打开」 | 返回 `PLUGIN_PERMISSION_DENIED`，不创建窗口 |
| 撤权 | 窗口打开时撤销授权 | 窗口自动销毁；再调 API 返回 `PLUGIN_REVOKED` |
| 停用 | 停用插件 | 窗口自动销毁 |
| 替换安装 | 窗口打开时重新安装并替换 | 旧窗口关闭 |
| 页面崩溃 | 在悬浮气泡中触发 render 进程退出（开发版 DevTools kill） | 窗口关闭，无孤立窗口 |
| 多显示器 | 把窗口拖到副屏，拔掉副屏（或改分辨率） | 窗口自动回到可见区域 |
| 位置记忆 | 拖动气泡后 `close`，再 `open` | 恢复到上次位置（关闭窗口不清记忆；撤权/停用级销毁才清） |
| 主窗口最小化 | 气泡打开时最小化 Profer 主窗口 / 切到其他应用 | 气泡保持可见可动（`alwaysOnTop + skipTaskbar`） |
| 全 Space（macOS） | 切换到其他 Space 或其他应用全屏 | 气泡仍在（manifest 声明 `visibleOnAllWorkspaces`） |
| 穿透 | 控制台开启穿透 | 点击穿透到下方窗口；气泡双击可重新开启穿透，控制台可关闭 |
| 跨插件隔离 | 另装一个 floating 插件同时开窗口 | 互不影响；`close` 只关自己的 |
| 退出清理 | 窗口打开时退出 Profer | 无孤立窗口残留 |

## 设计约束

- 插件只调用 `window.profer.window.floating.*`，不访问 Electron/Node/文件系统。
- 窗口参数以 manifest 声明为上限，宿主钳制后生效；本样例的越界测试（99999、-50000）验证这一点。
- 拖动：气泡蓝色区域带 `-webkit-app-region: drag`，按钮与日志区为 `no-drag`。
