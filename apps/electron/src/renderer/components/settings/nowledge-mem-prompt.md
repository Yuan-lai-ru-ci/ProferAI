# Nowledge Mem 集成配置

请帮我完成 Nowledge Mem 与 Proma 的完整集成配置。请严格按照以下步骤执行，每步完成后再进行下一步。

## 前置条件确认
- 我已下载并启动 Nowledge Mem 桌面客户端（https://mem.nowledge.co/zh）
- Nowledge Mem 正在后台运行（托盘/Dock 可见图标）
- 当前处于 Proma Agent 模式

## 配置步骤

### 第 1 步：安装 nmem CLI
请检测系统中是否已安装 `nmem` 命令行工具。如果未安装，请按照 Nowledge Mem 官方文档指引安装对应平台的 nmem CLI。

### 第 2 步：下载并配置 MCP 插件
请帮我：
1. 从 Nowledge Mem 获取 Proma MCP 插件配置
2. 将 `nowledge-mem` MCP server 写入当前工作区的 `mcp.json` 配置文件中
3. 确认 MCP server 名称必须为 `nowledge-mem`

### 第 3 步：配置 Hooks
请帮我配置以下 Hooks，以实现跨会话自动记忆注入与回写：
1. **会话启动 Hook**：在每次新会话开始时，自动调用 `nowledge-mem` 的 `recall_memory` 工具，将相关记忆注入到 Agent 上下文中
2. **会话结束 Hook**：在每次会话结束时，自动调用 `nowledge-mem` 的 `add_memory` 工具，将本次对话中的重要信息持久化

### 第 4 步：验证配置
配置完成后，请帮我验证：
1. `mcp.json` 中已正确写入 `nowledge-mem` 条目
2. Hooks 配置已生效
3. 提示我**完全退出并重启 Proma**，使 MCP 与 Hooks 生效

## 验证记忆闭环（重启后）
重启 Proma 后，请引导我执行：
1. 在当前会话中使用记忆功能，让 Agent 记住一段测试内容
2. 开启一个新会话，搜索刚才记住的内容
3. 确认能搜到即代表记忆系统已完整生效
