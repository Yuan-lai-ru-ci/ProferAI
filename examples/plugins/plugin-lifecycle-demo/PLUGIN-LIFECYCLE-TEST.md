# 插件实例生命周期验收台

目录：`examples/plugins/plugin-lifecycle-demo/`

这是一个给 Profer 开发者使用的本地验收插件，不是生产业务插件。它覆盖当前插件平台已实现的 Tab 页面实例、任务上下文、工具运行时、权限、RPC 取消、存储、模型、网络和未接 provider 错误边界。

## 安装

1. 启动 Profer 开发版。
2. 打开插件设置入口。
3. 选择“安装目录”，选择本目录：
   `/Users/mac/profer/profer-main/examples/plugins/plugin-lifecycle-demo`
4. 点击“查看并授权能力”，授权本插件声明的能力。
5. 在插件设置的页面入口中打开“插件实例验收台”。页面会作为独立 Tab 打开。

插件修改后需要在 Profer 插件设置中选择替换安装；只修改源目录不会自动刷新已安装副本。

## 第一组：Tab 与任务上下文隔离

### A. 不同任务分别打开 Tab

1. 新建或打开任务 A，记下它的 session ID。
2. 从插件设置或消息动作打开“插件实例验收台”，页面作为 Tab 打开。
3. 观察页面顶部 badge：若从当前任务动作打开，应显示 `chat:<任务 A sessionId>` 或 `agent:<任务 A sessionId>`。
4. 点击“读取当前任务上下文”，应读到任务 A 的上下文。
5. 切换到任务 B，再打开本插件 Tab。
6. 观察 B 的插件 Tab 上下文应显示 B 的 session ID，而不是 A。
7. 在 Tab 栏切回 A 的插件 Tab，确认 A 的上下文没有被 B 覆盖。

### B. 设置入口不继承任务

1. 从插件设置页打开本插件页面。
2. 页面应作为 Tab 打开，且 badge 不应绑定当前 chat/agent session。
3. “读取当前任务上下文”应返回空或“当前实例没有任务上下文”。

## 第二组：tool runtime 隔离与取消

### A. 工具上下文隔离

1. 在插件设置中确认已授权“向 Agent 提供工具”。
2. 等待下一轮 Agent 工具列表刷新；必要时新开一轮 Agent 对话。
3. 让 Agent 调用“实例验收：回显上下文”（tool id：`instance-echo`），参数：`text=hello`。
4. 返回结果中的 `toolPage` 应为 `lifecycle`。
5. `taskContext` 应为 `null`，因为工具运行页不继承交互 Tab 的任务上下文。
6. 返回中的 `isolated` 应为 `true`。

### B. 工具取消

1. 让 Agent 调用“实例验收：可取消延迟”（tool id：`instance-delay`），参数 `seconds=20`。
2. 在调用完成前撤销插件授权、停用插件或关闭插件 Tab。
3. 预期工具调用结束为取消、页面关闭或权限错误，不应在 20 秒后伪造成功。
4. 重新授权后，旧的迟到结果不应污染新的工具调用。

## 第三组：RPC、模型和网络

在页面中依次测试：

- “刷新模型”：返回可用模型列表；没有配置模型时应显示明确错误。
- “发起模型调用”：返回模型结果，并在“请求输出”中显示。
- “取消当前调用”：在模型调用进行中点击，调用应被取消或进入稳定失败状态。
- “请求已声明的 example.com”：允许时返回 HTTP 结果；未授权时返回权限错误。
- “请求未声明的 origin”：固定请求 `example.org`，必须失败，不应绕过 origin allowlist。
- “读取路由规则”：应返回本插件自己的规则，不应看到其他插件规则。
- “写入测试路由”：应只修改本插件规则；没有模型时应明确失败。

点击“一键验收”后，重点检查：

- `getContext` 成功。
- storage round-trip 成功。
- `context.read` 是否有上下文取决于当前 Tab 是否从任务动作打开。
- `network allowlist` 与 `network denylist` 的结果必须不同。
- 失败项必须显示错误，不得显示成功结果。

## 第四组：插件私有存储

1. 在“私有存储”中写入一个值。
2. 关闭当前插件 Tab，再重新打开本插件。
3. 点击“读取插件存储”，应读到同一插件的值。
4. 点击“删除插件存储”后再次读取，应为 `null`。
5. 这验证的是插件级 storage，不是 Tab 实例级 storage；页面和 tool runtime 共享同一插件私有存储。

## 第五组：预留 provider 的诚实失败

点击以下按钮：

- `workspace.list`
- `sessions.list`
- `runtime.resolve`
- `secrets.listMetadata`

当前生产启动路径尚未接入这些 provider，预期是稳定的：

- `PLUGIN_OPERATION_NOT_SUPPORTED`
- 或写入类操作需要确认时的 `PLUGIN_CONFIRMATION_REQUIRED`
- 权限未授予时也可能先返回 `PLUGIN_PERMISSION_DENIED`

绝不能把“没有 provider”显示成空列表、假成功或已提交。

## 第六组：生命周期清理

按以下顺序反复操作：

1. 打开插件 Tab。
2. 从任务 A 打开一个插件 Tab，确认任务上下文为 A。
3. 从任务 B 再打开一个插件 Tab，确认任务上下文为 B。
4. 在 Tab 栏切回 A，确认 A 仍在且上下文没有被 B 覆盖。
5. 关闭 B 的插件 Tab，确认 A 的 Tab 不受影响。
6. 停用插件，再启用插件。
7. 重新打开插件 Tab。
8. 撤销插件授权，确认旧页面和旧工具调用失效。
9. 卸载插件，再确认旧页面和旧工具调用都失效。
10. 重新安装并授权，确认可以建立全新的 Tab 实例。

预期：停用、撤权、卸载都会取消对应页面的在途 RPC；页面关闭后的迟到结果不能更新新页面实例。

## 通过标准

以下全部满足才算本轮实例语义通过：

- 不同任务的插件 Tab 可以并存，且 badge/session ID 始终正确。
- 关闭一个插件 Tab 不影响另一个插件 Tab。
- tool runtime 不读取任务上下文。
- 页面关闭、停用、撤权会结束在途请求。
- 网络只允许清单声明的精确 origin。
- storage 跨页面保持、删除生效。
- 未接 provider 返回稳定错误，而不是伪造成功。
- 撤权后旧页面和旧工具都不能继续调用宿主。
