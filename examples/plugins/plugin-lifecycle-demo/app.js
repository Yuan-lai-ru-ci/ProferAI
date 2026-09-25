const api = window.profer
const $ = (id) => document.getElementById(id)
let models = []
let activeRequest = null
const id = () => crypto.randomUUID()
const pretty = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const errorText = (error) => `${error?.code ? `[${error.code}] ` : ''}${error?.message || error}`
const write = (target, value, ok = true) => { $(target).textContent = pretty(value); $(target).className = ok ? 'ok' : 'error' }
const log = (label, value, ok = true) => {
  const line = `[${new Date().toLocaleTimeString()}] ${label}: ${pretty(value)}`
  $('log').textContent = `${line}\n${$('log').textContent}`.slice(0, 12000)
  $('status').textContent = ok ? `${label}完成` : `${label}失败`
}
const run = (label, handler, target = null) => async () => {
  try { const value = await handler(); if (target) write(target, value, true); log(label, value, true) }
  catch (error) { const value = errorText(error); if (target) write(target, value, false); log(label, value, false) }
}
const bind = (id, label, handler, target) => $(id).addEventListener('click', run(label, handler, target))

async function refreshContext() {
  const context = await api.getContext()
  write('context-output', context)
  $('instance-badge').textContent = `pageId=${context.pageId} · ${context.theme} · ${context.locale}`
  try {
    const task = await api.context.read()
    if (task) {
      $('instance-badge').textContent += ` · ${task.kind}:${task.sessionId}`
      write('task-output', task)
    } else write('task-output', '当前实例没有任务上下文（预期：设置/侧栏/工具页）')
  } catch (error) { write('task-output', errorText(error), false) }
  return context
}

async function refreshModels() {
  models = (await api.models.list()).filter((model) => model.available && model.supportsChat)
  $('model').replaceChildren(...models.map((model, index) => new Option(`${model.channelName} · ${model.name}`, String(index))))
  const saved = await api.storage.get('model-selection')
  const index = models.findIndex((model) => model.channelId === saved?.channelId && model.modelId === saved?.modelId)
  if (index >= 0) $('model').value = String(index)
  $('permission-badge').textContent = `可用模型 ${models.length} 个`
  return models
}
const selectedModel = () => {
  const model = models[Number($('model').value)]
  if (!model) throw new Error('没有可用模型；请先配置模型或授权 models.read')
  return model
}

bind('refresh-context', '刷新页面上下文', refreshContext, 'context-output')
bind('refresh-models', '刷新模型列表', refreshModels, 'request-output')
bind('read-context', '读取任务上下文', async () => api.context.read(), 'task-output')
bind('read-message', '读取消息上下文', async () => {
  const task = await api.context.read()
  if (!task) throw new Error('当前实例没有任务上下文')
  return { kind: task.kind, sessionId: task.sessionId, selection: task.selection, messages: task.messages }
}, 'task-output')
bind('select-attachments', '选择附件', async () => api.attachments.select(), 'task-output')

bind('generate', '模型调用', async () => {
  if (activeRequest) throw new Error('已有模型请求')
  const model = selectedModel(); const requestId = id(); activeRequest = requestId
  try {
    return await api.models.generate({ requestId, channelId: model.channelId, modelId: model.modelId, prompt: $('prompt').value, maxTokens: 256 })
  } finally { activeRequest = null }
}, 'request-output')
$('cancel').addEventListener('click', run('取消模型调用', async () => {
  if (!activeRequest) return '当前没有进行中的模型调用'
  await api.requests.cancel(activeRequest); return `已请求取消 ${activeRequest}`
}, 'request-output'))

bind('fetch-allowed', '允许的网络请求', async () => api.network.fetch({ requestId: id(), url: 'https://example.com/' }), 'boundary-output')
bind('fetch-denied', '未声明的网络请求', async () => api.network.fetch({ requestId: id(), url: 'https://example.org/' }), 'boundary-output')
bind('routing-read', '读取路由规则', () => api.routing.getRules(), 'boundary-output')
bind('routing-write', '写入测试路由', async () => {
  const model = selectedModel()
  const rules = [{ id: 'lifecycle-check', title: '实例验收测试规则', channelId: model.channelId, modelId: model.modelId, start: '00:00', end: '00:01' }]
  await api.routing.setRules(rules); return rules
}, 'boundary-output')

bind('storage-write', '写入插件私有存储', async () => { const value = $('storage-value').value; await api.storage.set('lifecycle-value', value); return { key: 'lifecycle-value', value } }, 'storage-output')
bind('storage-read', '读取插件私有存储', async () => ({ key: 'lifecycle-value', value: await api.storage.get('lifecycle-value') }), 'storage-output')
bind('storage-delete', '删除插件私有存储', async () => { await api.storage.delete('lifecycle-value'); return '已删除 lifecycle-value' }, 'storage-output')

bind('workspace-read', 'workspace.list', () => api.workspace.list(), 'provider-output')
bind('sessions-read', 'sessions.list', async () => {
  const workspaces = await api.workspace.list(); const workspaceId = workspaces.items?.[0]?.workspaceId
  if (!workspaceId) return '没有 workspace；先观察是否为 provider 未接入'
  return api.sessions.list({ workspaceId })
}, 'provider-output')
bind('runtime-read', 'runtime.resolve', () => api.runtime.resolve({ workspaceId: 'demo-workspace', runtime: 'pi', declaration: { references: [] } }), 'provider-output')
bind('secrets-read', 'secrets.listMetadata', () => api.secrets.listMetadata({ providerId: 'demo-provider' }), 'provider-output')

bind('tool-local', '本地模拟工具逻辑', async () => ({ text: $('tool-text').value.toUpperCase(), note: '真实 Agent 工具请从 Agent 发起 instance-echo' }), 'tool-output')

$('run-basic').addEventListener('click', async () => {
  const results = []
  const check = async (name, handler) => { try { const value = await handler(); results.push({ name, ok: true, value }) } catch (error) { results.push({ name, ok: false, error: errorText(error) }) } }
  await check('getContext', () => api.getContext())
  await check('storage round-trip', async () => { await api.storage.set('basic-check', 'ok'); const value = await api.storage.get('basic-check'); await api.storage.delete('basic-check'); return value })
  await check('context.read', () => api.context.read())
  await check('models.list', () => api.models.list())
  await check('network allowlist', () => api.network.fetch({ requestId: id(), url: 'https://example.com/' }))
  await check('network denylist', () => api.network.fetch({ requestId: id(), url: 'https://example.org/' }))
  write('task-output', results)
  log('基础验收', results, results.every((item) => item.ok || item.name === 'context.read'))
})
$('clear-log').addEventListener('click', () => { $('log').textContent = ''; $('status').textContent = '日志已清空' })

void Promise.all([refreshContext(), refreshModels()]).then(() => { $('status').textContent = '已就绪：请按验收步骤操作' }).catch((error) => { $('status').textContent = errorText(error); log('初始化', errorText(error), false) })

void api.tools.register('instance-echo', async (args) => {
  const context = await api.getContext()
  const task = await api.context.read().catch(() => null)
  return { toolPage: context.pageId, taskContext: task, text: String(args.text ?? ''), isolated: true }
}).catch((error) => log('注册 instance-echo', errorText(error), false))
void api.tools.register('instance-delay', async (args, context) => {
  const seconds = Math.max(1, Math.min(30, Number(args.seconds) || 1))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, seconds * 1000)
    const unsubscribe = context.onCancel(() => { clearTimeout(timer); unsubscribe(); reject(new Error('工具调用已取消')) })
    if (context.isCancelled()) { clearTimeout(timer); unsubscribe(); reject(new Error('工具调用已取消')) }
  })
  return { completed: true, seconds, cancelled: context.isCancelled() }
}).catch((error) => log('注册 instance-delay', errorText(error), false))
