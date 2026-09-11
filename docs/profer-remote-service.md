# Profer 远程服务（Remote Service）使用说明

> 2026-09-11 修订：原桌面仓库内的平板 Web UI（`renderer/tablet/`）与 `tablet-app/`（Capacitor 壳）
> 已随 tablet 线退役移除，客户端改由独立仓库 **Profer-pocket** 承担。
> 本文档只描述仍然保留在桌面端的远程服务本身。历史设计见 `docs/plans/2026-08-07-tablet-settings-design.md`。

## 这是什么

在不传输图像的前提下，把 Agent 的**工作过程与用户输入**投递到手机/平板等外部设备。
电脑继续跑 Agent（算力在下沉），移动端只是客户端 UI。

- 电脑端：Electron 主进程内的 HTTP + WebSocket 服务（`remote-service`），默认绑定 `0.0.0.0`，由访问 Token 鉴权
- 客户端：独立仓库 Profer-pocket（Capacitor 移动端），复用桌面端能力与主题
- 交互协议：客户端 `WsClient` ↔ `remote-service`，通过 `agentEventBus` 广播 Agent 事件，通过指令下发输入

## 目录结构

```text
apps/electron/src/main/lib/remote-service.ts   # 主进程网络服务（HTTP+WS+token+指令）
```

## 构建与启动

```bash
cd apps/electron
bun run build:main     # 主进程（含 remote-service）
bun run build          # 全量构建
```

服务不再托管任何静态 UI 产物（原 `dist/renderer/tablet/` 已随 tablet 退役移除）；
除 `/health` 之外的 HTTP 请求一律返回 404，能力全部经 WebSocket 提供。

启动（默认不监听，需要显式开启）：

> **推荐：设置页自动恢复**。在「设置 → 远程连接 → 移动模式」里打开「启用移动端连接」后，
> Profer 每次启动都会自动开启连接（正式版与开发版一致），无需每次手动开启；
> 关闭开关后，下次启动不再自动开启。

也可以用环境变量临时开启（不持久化，仅本次启动生效）：

```bash
PROFER_REMOTE=1 <启动Profer命令>
```

启动后控制台会打印：

```text
[Remote] 本机访问:  http://127.0.0.1:7788
[Remote] 移动端访问:  http://<电脑局域网IP>:7788
[Remote] 访问 Token: xxxx（首次在客户端输入一次）
```

> 默认端口 7788，可用 `PROFER_REMOTE_PORT` 修改（设置页保存的端口优先于环境变量）。
> Token 默认生成并持久化；可用 `PROFER_REMOTE_TOKEN` 指定固定值。
> 监听地址可用 `PROFER_REMOTE_HOST` 覆盖（设为 `127.0.0.1` 即仅本机可访问）。

## 客户端接入

1. 确保客户端设备与电脑在同一局域网。
2. 在客户端填入 `http://<电脑局域网IP>:7788`。
3. 首次输入启动时打印的访问 Token，之后由客户端自行记忆。
4. 进入会话列表 → 选择/新建会话 → 发消息并实时查看 Agent 工作过程。

## 每日 Token 热力图查询

Pocket 欢迎页通过以下 WS 命令读取普通工作区的每日 Token 聚合：

```json
{"type":"get_workspace_heatmap_daily","workspaceId":"<workspace-id>"}
```

成功响应的 `data` 为按日期升序排列的数组：

```json
[{"date":"2026-08-21","tokens":3400}]
```

不存在的工作区或 team 工作区返回空数组；缺少、空字符串或非字符串 `workspaceId` 返回命令错误。Pocket 只在 remote client 尚未注入时使用空数组首屏降级；client 已就绪后的连接失败、旧桌面端不支持该命令或非法响应会保持 Promise reject。欢迎页沿用既有错误处理：刷新失败时保留已经显示的热力图，首屏失败保持空态。

> 警告：服务默认监听 `0.0.0.0`，请务必保管好 Token，防止同网段设备误连；
> 如需限制访问范围，可用 `PROFER_REMOTE_HOST=127.0.0.1` 并配合本机端口转发。

## 与桌面版的关系

- 桌面版 **完全不受影响**：remote-service 是独立文件，默认不启动、不监听端口。
- Agent 事件通过 `agentEventBus` 监听（旁路），不改动原 IPC 分发逻辑。
- 客户端发消息走 `runAgentHeadless`，若桌面主窗口存在也会同步到桌面端展示。
