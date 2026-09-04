# Profer 移动版（Remote Service）使用说明

## 这是什么

Profer 移动版 = 在**不传输图像**的前提下，把 Agent 的**工作过程与用户输入**传到平板/手机等外部设备，
用**触控友好的 Web UI** 呈现。电脑继续跑 Agent（算力在下沉），平板只是客户端 UI。

- 电脑端：Electron 主进程内新增一个 HTTP + WebSocket 服务（remote-service），仅绑定 `127.0.0.1`
- 平板端：浏览器打开，复用桌面版 Tailwind 主题，提供会话列表 / 会话详情 / 实时工作流 / 发消息
- 交互协议：`WsClient` ↔ `remote-service`，通过 `agentEventBus` 广播 Agent 事件，通过指令下发输入

## 目录结构

```
apps/electron/src/main/lib/remote-service.ts   # 主进程网络服务（HTTP+WS+token+静态托管+指令）
apps/electron/src/renderer/tablet/index.html   # 平板 Web UI 入口
apps/electron/src/renderer/tablet/main.tsx     # 平板 Web UI（触控适配）
apps/electron/src/renderer/tablet/ws-client.ts # 平板端 WS 通信层
apps/electron/scripts/verify-tablet.cjs        # 构建校验脚本
```

## 构建

```bash
cd apps/electron
bun run build:renderer   # 一次构建产出版面 + 平板两套 UI（多入口）
bun run build:main       # 主进程（含 remote-service）
bun run build            # 全量（含 verify:tablet 校验平板产物）
```

移动端 UI 产物位于 `dist/renderer/tablet/`。

## 启动（显式开关，默认不启动）

以任意方式启动 Profer，只要满足以下之一即启用移动版：

> **推荐：设置页自动恢复**。在「设置 → 远程连接 → 移动模式」里打开「启用移动端连接」后，
> Profer 每次启动都会自动开启平板连接（正式版与开发版一致），无需每次手动开启；
> 关闭开关后，下次启动不再自动开启。

以下为显式启动方式（`--tablet` / `PROFER_REMOTE=1` 不持久化，仅本次启动生效）：

```bash
# 方式一：环境变量
PROFER_REMOTE=1 <启动Profer命令>

# 方式二：命令行参数
<启动Profer命令> --tablet
```

启动后控制台会打印：

```
[Remote] 本机访问:  http://127.0.0.1:7788
[Remote] 移动端访问:  http://<电脑局域网IP>:7788
[Remote] 访问 Token: xxxx（首次在平板输入一次）
```

> 默认端口 7788，可用 `PROFER_REMOTE_PORT` 修改。
> Token 默认生成并持久化；可用 `PROFER_REMOTE_TOKEN` 指定固定值。
> 移动端 UI 静态目录默认 `dist/renderer/tablet`；可用 `PROFER_REMOTE_STATIC` 覆盖。

## 平板使用

1. 确保平板与电脑在同一局域网（或电脑已能被访问）。
2. 平板浏览器打开 `http://<电脑局域网IP>:7788`
3. 首次输入启动时打印的访问 Token，之后记忆在浏览器 localStorage。
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

> 警告：服务仅绑定 `127.0.0.1`（本机回环），并没有真正对局域网端口开放所有流量；
> 平板能连是因为本机回环服务 + 浏览器直连。若要让局域网其他设备稳定访问，
> 需要确保防火墙放行对应端口，且同一网段。务必保管好 Token 防止同网段误连。

## 与桌面版的关系

- 桌面版 **完全不受影响**：remote-service 是独立文件，默认不启动、不监听端口。
- Agent 事件通过 `agentEventBus` 监听（旁路），不改动原 IPC 分发逻辑。
- 平板发消息走 `runAgentHeadless`，若桌面主窗口存在也会同步到桌面端展示。
