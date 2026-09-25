# Profer 通用插件平台：第一、二批能力

插件宿主 API 是 provider-neutral 的平台契约，可供工作区工具、外部服务、任务看板等多类插件复用。具体业务适配器不属于公共契约；未配置 provider 的新能力返回稳定的 `PLUGIN_OPERATION_NOT_SUPPORTED`。

插件使用静态 HTML/CSS/JS 和 `profer-plugin.json` 分发，通过独立沙箱中的 `window.profer` 调用宿主。
公开 TypeScript 契约位于 `packages/plugin-api/src/index.ts`。示例位于 `examples/plugins/capability-demo/`，可直接安装该目录。插件实例生命周期验收样例位于 `examples/plugins/plugin-lifecycle-demo/`，详细步骤见其中的 `PLUGIN-LIFECYCLE-TEST.md`。插件页面统一以 Tab 为主；不再提供插件任务侧面板。

## 安装与授权

1. 在设置「关于」中连续点击版本号五次，打开插件入口。
2. 在插件设置中安装 ZIP 或目录。安装会复制文件；修改源目录后需要重新安装替换。
3. 点击「查看并授权能力」。权限声明本身不代表获准使用；新增权限和新增网络 origin 不继承已有授权。
4. 若插件声明外部服务凭据，在宿主插件设置中输入并保存。插件没有读取凭据的 API。
5. 停用或撤权会关闭插件页面并取消调用。卸载保留私有 storage，清除授权和服务凭据。

## 清单贡献

- `contributes.pages`：HTML 页面入口。`placements` 是宿主入口的 allowlist：`settings` 从插件设置页打开（页面显示为 Tab，不嵌入设置弹窗），`sidebar` 从左侧栏打开，`tab` 从当前会话顶栏/浏览器/右侧工作区入口或消息动作打开。页面统一进入 Tab；会话入口打开时绑定当前会话，关闭宿主会话会连带关闭插件页面。桌宠等全局插件页可作为不绑定会话的例外；v1 旧清单省略 `placements` 时保留设置页和 Tab 入口；显式传空数组不暴露上述入口。页面可选 `icon` 字段：插件包内图片文件（png/jpg/webp/gif/svg/ico，不超过 256 KB），用于左侧栏与顶栏入口图标，缺省时使用宿主占位图标。插件设置页本身仍使用 Profer 原生控件管理插件、权限和凭据。
- 用户可在插件设置页为每个页面选择入口位置（左侧栏 / 顶栏 / 隐藏），隐藏后插件静默生效；该偏好只能在插件声明的 `placements` 范围内收窄，不会放大入口，停用/启用与插件更新后保留。
- `contributes.messageActions`：`{id,title,pageId}`，加入 Chat 和 Agent 助手消息的处理入口；目标页面需允许 `tab`（省略 `placements` 的 v1 页面兼容）。已有清单若指向非 Tab 页面仍可加载，但不显示该动作。
- `contributes.modelRoutingPolicies`：`{id,kind:"model-routing.rules.v1"}`，提供时段路由规则。
- `contributes.tools`：`{id,title,description,pageId,parameters}`，工具由指定页面注册。工具 ID 最长 34 字符，参数支持 string/number/boolean，可指定 description 和 required。

工具不是 Node 插件：宿主在单独的隐藏沙箱页面中运行工具代码，不会复用用户正在操作的页面。多个页面共享插件私有 storage。

## 当前能力接线状态（2026-09-24 静态核对）

下表只说明生产代码路径是否接线，不等于完成 macOS/Windows 打包态验收。授权清单可以包含预留权限，但授权本身不会使缺失的 provider 自动生效。

| 能力 | 当前状态 | 依据与失败行为 |
| --- | --- | --- |
| 私有存储、模型列表/调用、模型路由、显式任务上下文、附件选择、受限网络请求 | 已有宿主处理逻辑 | 仍需按插件授权、平台打包态和实际服务状态验证。 |
| Agent 工具 | 已接入 Claude/Pi | 在独立工具页面执行；仍受当前预设、工具权限及双运行时验证约束。 |
| `workspace.list`、`workspace.files.list/read/write` | 仅契约及 provider 端口，生产未接线 | `setPluginWorkspaceProvider()` 在生产启动路径无调用者；授权后调用返回 `PLUGIN_OPERATION_NOT_SUPPORTED`。写入即使接线，还需要一次性宿主确认与 CAS。 |
| sessions/presets、runtime capabilities、secrets | 仅契约及 provider 端口，生产未接线 | `setPluginCapabilityProviders()` 在生产启动路径无调用者；授权后返回 `PLUGIN_OPERATION_NOT_SUPPORTED`。未来的 mutation 仍需宿主确认及 scope 校验。 |
| 桌宠窗口与 OS 系统能力 | 设计预留，未进入 v1 manifest/API | 不可由普通页面 placement 或 Electron API 推导出这些权限。 |

生产 provider 未接线的能力在本文中均按**预留**理解；下面的 API 表描述参数及安全边界，不代表现在能成功调用。若先因停用、撤权、权限不足或参数/确认校验失败，实际返回的对应错误可能优先于 `PLUGIN_OPERATION_NOT_SUPPORTED`。

## 宿主 API 与权限

除下表既有 API 外，Slice 3 在 Slice 1/2 基础上冻结了通用工作区、session/preset metadata、runtime capability reference、opaque secret reference 和统一 RPC 生命周期契约。它们均要求细粒度 permission、workspace/resource scope、owner/page 绑定、requestId、取消/超时、整数 revision/CAS 与稳定错误码；当前只建立安全边界，provider 尚未接入时不会伪造成功。

**当前不可用（等宿主接入 provider）**：`workspace.*`、`sessions.*`、`presets.*`、`runtime.capabilities.*`、`secrets.*` 在生产启动路径没有 provider 注入（`setPluginWorkspaceProvider` / `setPluginCapabilityProviders` 无调用者，`pluginConfirmations.issue()` 只出现在测试中）。它们已进入公开契约，但属于预留能力：有权限时调用通常返回 `PLUGIN_OPERATION_NOT_SUPPORTED`；要求确认的写操作还可能返回 `PLUGIN_CONFIRMATION_REQUIRED`。二者都不表示操作已成功。

**授权与撤权**：`revokePluginPermissions` 保留 grant 内容但写入 `revoked: true`；此后 `getGrantedPermissions` 返回空数组、`listInstalledPlugins()` 返回 `revoked: true`，所有 RPC 与已加载的 Agent 工具调用均返回 `PLUGIN_REVOKED`。插件设置页对本状态显示「已撤销」，与「待授权」区分。

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
每个插件最多 4 项并发调用，每分钟最多 30 项。**该配额对全部 RPC operation 生效**（含 `workspace.list`、`sessions.get`、`context.read` 等轻量 metadata 调用），越限返回 `PLUGIN_RATE_LIMITED`（`retryable: true`，`details.limit` 为 `rate` 或 `concurrency`），插件可据此退避重试；参数非法仍是不可重试的 `PLUGIN_INVALID_ARGUMENT`。关闭单个页面只取消该页面的调用。

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
- 在 `apps/electron` 运行 `bun run test:plugins:rpc-smoke`：真实 preload/IPC envelope、sender owner、跨页拒绝、同 owner cancel、timeout、revoke、page-close abort 与 late-result 抑制。
- 使用现有 `build:plugin-preload` 构建插件专属 preload。修改主进程或 preload 后需要重启开发版 Profer。
