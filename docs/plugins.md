# Profer 通用插件平台：第一、二批能力

插件宿主 API 是 provider-neutral 的平台契约，可供工作区工具、外部服务、任务看板等多类插件复用。具体业务适配器不属于公共契约；未配置 provider 的新能力返回稳定的 `PLUGIN_OPERATION_NOT_SUPPORTED`。

插件使用静态 HTML/CSS/JS 和 `profer-plugin.json` 分发，通过独立沙箱中的 `window.profer` 调用宿主。
公开 TypeScript 契约位于 `packages/plugin-api/src/index.ts`。示例位于 `examples/plugins/capability-demo/`，可直接安装该目录。

## 安装与授权

1. 在设置「关于」中连续点击版本号五次，打开插件入口。
2. 在插件设置中安装 ZIP 或目录。安装会复制文件；修改源目录后需要重新安装替换。
3. 点击「查看并授权能力」。权限声明本身不代表获准使用；新增权限和新增网络 origin 不继承已有授权。
4. 若插件声明外部服务凭据，在宿主插件设置中输入并保存。插件没有读取凭据的 API。
5. 停用或撤权会关闭插件页面并取消调用。卸载保留私有 storage，清除授权和服务凭据。

## 清单贡献

- `contributes.pages`：HTML 页面入口；`placements` 中 `sidebar` 增加侧边栏入口，`panel` 可在当前任务右侧展开工具面板，页面也可以在 Tab 打开。插件设置页本身使用 Profer 原生控件管理插件、权限和凭据；插件 HTML 页面不会嵌入设置弹窗。
- `contributes.messageActions`：`{id,title,pageId}`，加入 Chat 和 Agent 助手消息的处理入口。
- `contributes.modelRoutingPolicies`：`{id,kind:"model-routing.rules.v1"}`，提供时段路由规则。
- `contributes.tools`：`{id,title,description,pageId,parameters}`，工具由指定页面注册。工具 ID 最长 34 字符，参数支持 string/number/boolean，可指定 description 和 required。

工具不是 Node 插件：宿主在单独的隐藏沙箱页面中运行工具代码，不会复用用户正在操作的页面。多个页面共享插件私有 storage。

## 宿主 API 与权限

除下表既有 API 外，Slice 3 在 Slice 1/2 基础上冻结了通用工作区、session/preset metadata、runtime capability reference、opaque secret reference 和统一 RPC 生命周期契约。它们均要求细粒度 permission、workspace/resource scope、owner/page 绑定、requestId、取消/超时、整数 revision/CAS 与稳定错误码；当前只建立安全边界，provider 尚未接入时不会伪造成功。

| API | 权限 | 行为 |
| --- | --- | --- |
| `getContext()`、`onContextChanged(callback)` | 无 | 插件信息、语言、主题；主题变化时自动更新 `data-profer-theme` 并通知监听器 |
| `storage.get/set/delete` | `pluginStorage` | 插件私有 JSON，总计 512 KB |
| `models.list()` | `models.read` | 模型和渠道显示信息、启用状态、Chat/Agent 支持情况，不含地址和凭据 |
| `models.generate(input)` | `models.invoke` | 使用宿主已配置的 Chat 模型，返回完整文本，支持取消；订阅专用渠道通过 Agent 使用 |
| `routing.getRules/setRules` | `modelRouting.rules.write` | 读取或保存本插件的规则，需要声明路由贡献 |
| `context.read()` | `context.read` | 读取用户从任务/消息入口交给当前页面的内容；工具运行页面不隐式获得会话上下文 |
| `attachments.select()` | `attachments.read` | 用户在系统文件选择器中指定文档，返回文件名和提取的文本，不返回本地路径 |
| `network.fetch(input)` | `network.fetch` | 通过宿主请求已声明、已授权的精确 HTTPS origin |
| `tools.register(id, handler)` | `agent.tools` | 注册已声明的 Agent 工具；Claude 和 Pi 使用一致的参数与宿主执行逻辑 |
| `requests.cancel(requestId)` | 无额外权限 | 取消本插件的模型或网络请求 |
| `workspace.list()` | `workspace.read` | 仅列出宿主注入且已授权的 workspace 摘要；不返回绝对根路径 |
| `workspace.files.list/read/write(input)` | `workspace.files.read` / `workspace.files.write` | 仅限授权 workspace + prefix 的相对 POSIX 路径；list/read 有深度、条目、字节上限，write 只允许单文件 create/replace、每次宿主确认、整数 CAS 与临时文件 rename |
| `sessions.list/get/create/configure/cancel()` | `sessions.read` / `sessions.create` / `sessions.configure` / `sessions.control` | 只返回 opaque 会话元数据；mutation 绑定 workspace/session ownership、宿主 confirmation、非负整数 `expectedRevision`、取消/撤权和 unknown 终态，不暴露消息、JSONL、SDK/Pi session 对象或内部文件 |
| `sessions.listPresets/getPreset/requestPreset()` | `presets.read` / `presets.switch` | 只返回 opaque preset metadata；切换必须 CAS/confirmation，明确 `effectiveFrom: "next_turn"`，当前 turn 不热替换 |
| `runtime.resolve()/inject()` | `runtime.capabilities.read` / `runtime.capabilities.inject` | 只接受 capability references/declarations，返回安全 snapshot/fingerprint；禁止任意 prompt、JS、command、path、env/header 或 SDK/Pi 对象。注入失败保留旧 view，按 `next_turn`/`new_session` 生效 |
| `secrets.listMetadata()/requestConfigure()` | `secrets.readMetadata` / `secrets.configure`（兼容 `mcp.secrets.readMetadata` / `mcp.secrets.write`） | 只返回 opaque metadata/reference；插件永远不能读取明文。宿主原生/受控输入和 runtime prepare 才能短暂解析；safe storage 不可用、未配置、撤权和卸载均返回稳定错误 |

生成输入：`{requestId,channelId,modelId,prompt,system?,maxTokens?}`。默认输出上限 2048 token，最多 8192；最长 120 秒。
网络输入：`{requestId,url,method?:"GET"|"POST",headers?,body?,credentialId?}`，返回 `{status,headers,body}`；最长 60 秒，响应最多 2 MB，不跟随重定向，不支持内网地址。
每个插件最多 4 项并发调用，每分钟最多 30 项。关闭单个页面只取消该页面的调用。

上下文最多返回最近 100 条文本消息、合计 10 万字符。消息操作只交付指定消息；有选中文本时只交付选中内容。附件每次最多 5 个、每个不超过 8 MB，总提取文本最多 50 万字符。当前上下文是显式交付的任务引用，不随用户切换其他任务自动扩大范围。

## 自动路由

规则格式：`{id,title,channelId,modelId,start:"09:00",end:"18:00",days?:[1,2,3,4,5]}`。

- 采用电脑本地时区，星期日为 0；开始时间包含、结束时间不包含，相同起止时间表示全天。
- 支持跨午夜；例如星期一 22:00–06:00 包含星期二凌晨。
- 在 Chat/Agent 任务中选择「自动路由 · 插件名」后生效。每个任务最多启用一个提供者，默认手动选择。
- 每轮开始时取第一条匹配且兼容本轮 Chat/Claude/Pi 的规则。执行中的模型不因规则修改而变化。
- 插件停用、撤权、规则不匹配或目标模型不可用时，保留原先手动选择的模型。
- 任务界面显示本轮模型和命中/回退原因。远端临时故障继续使用宿主原有错误处理，不自动切换到其他模型重发用户请求。

## Agent 工具与取消

```js
await window.profer.tools.register('summarize', async ({ text }, call) => {
  const model = await window.profer.storage.get('model')
  const requestId = crypto.randomUUID()
  const unsubscribe = call.onCancel(() => {
    void window.profer.requests.cancel(requestId)
  })
  try {
    if (call.isCancelled()) throw new Error('已取消')
    return await window.profer.models.generate({
      requestId, ...model, prompt: `总结：${text}`, maxTokens: 1024,
    })
  } finally {
    unsubscribe()
  }
})
```

工具 ID 必须在清单里声明。处理器返回可序列化 JSON，最多 1 MB。每次工具调用最多 60 秒，页面须在 10 秒内完成注册。跨沙箱边界使用 `onCancel`/`isCancelled`，不传递 DOM AbortSignal 对象。

工具在下一轮 Agent 开始时加载，受现有预设 MCP 白名单、工具禁用列表和权限流程约束；计划模式不会自动放行插件工具。撤权后已经加载的工具也不能继续执行。插件侧的异步工作应订阅取消并停止；宿主会终止等待并丢弃迟到结果。

## 外部服务凭据

```json
{
  "network": {
    "origins": ["https://api.example.com"],
    "credentials": [{
      "id": "service-key",
      "title": "服务 API Key",
      "origin": "https://api.example.com",
      "header": "Authorization",
      "scheme": "bearer"
    }]
  }
}
```

用户在宿主插件设置中保存密钥。插件请求时传 `credentialId:"service-key"`，由宿主注入请求头。凭据只能用于绑定的精确 origin，修改绑定声明后需要重新配置。支持 Authorization/X-API-Key 请求头和 bearer/raw 格式，使用系统安全存储加密落盘。

## 验证

- `bun test --isolate apps/electron/src/main/lib/plugins/`：清单、安装回滚、授权、路由、网络边界、凭据、并发和取消。
- 在 `apps/electron` 运行 `bun run test:plugins:electron`：真实 Electron 页面、preload、工具、宿主模型调用、主题通知、页面隔离和撤权；只使用临时配置与本地模拟模型。
- 使用现有 `build:plugin-preload` 构建插件专属 preload。修改主进程或 preload 后需要重启开发版 Profer。
