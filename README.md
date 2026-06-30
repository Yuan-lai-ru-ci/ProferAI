# Profer

**团队 AI 协作平台** — 像 Notion 一样管理工作区，让 AI Agent 成为团队共享的生产力引擎。

Profer 在强大本地 AI Agent 的基础上，叠加了团队协作层：个人工作区 + 团队工作区双模式、Skills 共享市场、文件云端同步、邀请制成员管理。简单问题用 Chat，复杂任务交给 Agent，团队知识沉淀在工作区。

---

## 为什么选择 Profer

与个人 AI 工具不同，Profer 解决的是**团队怎么一起用好 AI** 的问题：

| | 个人 AI 工具 | Profer |
|---|---|---|
| 工作区 | 单用户本地 | **个人 + 团队双模式**，类似 Notion |
| 知识沉淀 | 随对话流失 | **工作区持久化**：Skills、文件、配置、知识库 |
| 团队协作 | 无 | **邀请制工作区**：成员、角色、权限 |
| Skill 复用 | 手动拷贝 | **团队市场**：发布、安装、版本管理 |
| 文件共享 | 网盘 + AI 割裂 | **工作区内文件云端同步**，拖入 Agent 即用 |
| 品牌 | 固定 | **可定制**：Logo、名称、配色 |

---

## 核心概念

```
┌─ 侧边栏 ────────────────────┐
│  👤 用户名                    │
│                              │
│  📁 个人工作区                 │  ← 纯本地，完全私密
│    └ 我的项目                 │
│                              │
│  🏢 产品团队                  │  ← 团队工作区，云端同步
│    ├ 需求文档                 │
│    ├ 技术方案                 │
│    ├ 团队 Skills              │
│    └ 成员: 12人 (我是 Admin)  │
│                              │
│  🏢 前端架构组                 │  ← 另一个团队
│    └ ...                     │
│                              │
│  [+ 创建 / 加入工作区]         │
└──────────────────────────────┘
```

每个工作区拥有独立的 Skills、MCP 服务器、文件、知识库和对话历史。个人工作区纯本地，团队工作区自动同步。

---

## 现在能做什么

### 团队协作（Profer 独有）

- **团队工作区**：创建团队工作区，邀请成员加入，按角色（Owner / Admin / Member / Viewer）控制权限
- **Skills 共享**：将本地 Skill 发布到团队市场，成员一键安装，版本自动更新
- **文件同步**：团队工作区文件云端镜像，按需下载，SHA256 冲突检测
- **品牌定制**：为每个工作区自定义 Logo、名称、品牌色，侧边栏和标题栏即时生效
- **邀请管理**：生成邀请链接或邀请码，一次性 token，7 天过期

### Chat 模式

多模型对话、附件解析（PDF / Office / 图片）、Markdown / Mermaid / KaTeX / 代码高亮渲染、并排对比、系统提示词、上下文管理。

### Agent 模式

基于 `@anthropic-ai/claude-agent-sdk` 的通用 Agent。工作区隔离、权限模式、文件操作、长任务流式输出、计划确认。SubAgent / Tasks 拆分复杂任务。

### Skills & MCP

每个工作区独立配置 Skills 和 MCP Server。全屏「Agent 技能」视图支持搜索、启用切换、更新、导入、卸载。Skills 可在工作区之间导入，也可发布到团队市场。

### Automation 定时任务

持久化定时调度（interval / daily / weekly / monthly），运行历史，失败保护，飞书通知。适合日报周报、自动检查、周期性研究等无人值守场景。

### 远程机器人

飞书 / Lark / 钉钉 / 微信桥接。用手机或群聊触发本机 Agent 工作流。

### 桌面体验

自动更新、代理设置、文件预览、全局快捷键、快速任务窗口、流式语音输入（豆包，支持全局输入）。亮色 / 暗色 / 多款精修主题。

---

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/Yuan-lai-ru-ci/Profer/releases) 下载最新版本。提供 macOS Apple Silicon / Intel 和 Windows 安装包。

### 配置团队服务器（可选）

团队协作功能需要后端服务。我们提供轻量级同步服务器（Hono + SQLite），可在任意 Linux 服务器上一键部署：

```bash
# 在服务器上
git clone https://github.com/Yuan-lai-ru-ci/Profer.git
cd Profer/server
npm install
nohup node index.js > server.log 2>&1 &

# nginx 反代（示例）
# location /proma/ { proxy_pass http://127.0.0.1:3456/; }
```

然后在 Profer 设置 → **品牌定制** 中配置团队服务器地址即可。

### 首次配置

1. 打开 Profer，完成环境检查（Agent 依赖 Git、Node.js / Bun 及可用 Shell）
2. **设置 → 模型配置**，添加 AI 渠道（Anthropic、DeepSeek、Kimi 等）
3. **设置 → Agent 配置**，选择默认渠道、模型和工作区
4. （可选）侧边栏底部 → **登录团队账户**，连接团队服务器

---

## 支持的模型渠道

| 供应商 | Chat | Agent | 协议 |
| --- | --- | --- | --- |
| Anthropic | ✅ | ✅ | Messages API |
| DeepSeek | ✅ | ✅ | Anthropic 兼容 |
| Kimi API | ✅ | ✅ | Anthropic 兼容 |
| Kimi Coding Plan | ✅ | ✅ | Anthropic 兼容（官方白名单） |
| OpenAI | ✅ | ❌ | Chat Completions |
| Google | ✅ | ❌ | Gemini API |
| 智谱 AI | ✅ | ✅ | Anthropic 兼容 |
| MiniMax | ✅ | ✅ | Anthropic 兼容 |
| 豆包 | ✅ | ✅ | Anthropic 兼容 |
| 通义千问 | ✅ | ✅ | Anthropic 兼容 |
| 自定义端点 | ✅ | ❌ | OpenAI 兼容 |

---

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 39 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| 图表 / 公式 | Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.153` |
| 团队后端 | Hono + better-sqlite3 + JWT |

---

## 开发

Profer 是 Bun workspace monorepo：

```text
proma-v2/
├── packages/
│   ├── shared/     # 共享类型、IPC 常量、配置
│   ├── core/       # Provider Adapter、SSE、代码高亮
│   └── ui/         # 共享 React UI 组件
├── apps/
│   └── electron/   # Electron 桌面应用
└── server/         # 团队同步后端（Hono + SQLite）
```

```bash
bun install           # 安装依赖
bun run dev           # 开发模式（Vite + Electron + 热重载）
bun run typecheck     # 类型检查
bun test              # 测试
```

---

## 贡献

欢迎提交 PR。提交前请确认：

- 使用 Bun，不混用 npm / pnpm lockfile
- 状态管理使用 Jotai
- TypeScript 禁用 `any`，对象结构优先使用 `interface`
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge、renderer 调用
- 影响包行为时递增对应 package 的 patch 版本

---

## 许可证

Profer 基于 [Proma](https://github.com/ErlichLiu/Proma) 开发，社区版采用 [AGPL-3.0](./LICENSE) 协议。

---

## 致谢

基于 [Proma](https://github.com/ErlichLiu/Proma) by Erlich Liu 构建。感谢 Shiki、Beautiful Mermaid、Cherry Studio、Lobe Icons、Craft Agents OSS、MemOS 等项目。
