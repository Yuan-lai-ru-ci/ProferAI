const api = window.profer
const $ = (id) => document.getElementById(id)
const id = () => crypto.randomUUID()
const pretty = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const errorText = (error) => `${error?.code ? `[${error.code}] ` : ''}${error?.message || error}`

const write = (target, value, ok = true) => { $(target).textContent = pretty(value); $(target).className = ok ? 'ok' : 'error' }
const log = (label, value, ok = true) => {
  const line = `[${new Date().toLocaleTimeString()}] ${label}: ${pretty(value)}`
  $('log').textContent = `${line}\n${$('log').textContent}`.slice(0, 12000)
  $('status').textContent = ok ? `${label} 完成` : `${label} 失败`
}
const run = (label, handler, target = null) => async () => {
  try { const value = await handler(); if (target) write(target, value, true); log(label, value, true); return value }
  catch (error) { const value = errorText(error); if (target) write(target, value, false); log(label, value, false); return null }
}
const bind = (id, label, handler, target) => $(id).addEventListener('click', run(label, handler, target))

const floating = api.window.floating

async function refreshContext() {
  const context = await api.getContext()
  $('instance-badge').textContent = `surface=${context.surface} · pageId=${context.pageId} · ${context.theme} · ${context.locale}`
  write('context-output', context)
  return context
}

/** 一键验收：依赖日志顺序即可人工核对，全绿为通过。 */
async function runAll() {
  const checks = []
  const step = async (name, fn, expect) => {
    try {
      const value = await fn()
      const pass = expect(value)
      checks.push({ name, pass, value })
      log(`${pass ? '✅' : '❌'} ${name}`, value, pass)
      return pass
    } catch (error) {
      checks.push({ name, pass: false, value: errorText(error) })
      log(`❌ ${name}`, errorText(error), false)
      return false
    }
  }

  const context = await refreshContext()
  await step('形态识别为控制台（settings/tab/sidebar）', () => context.surface, (v) => ['settings', 'tab', 'sidebar'].includes(v))
  let openedBounds = null
  await step('打开悬浮窗口', async () => { openedBounds = await floating.open(); return openedBounds }, (v) => v && v.width >= 48 && v.height >= 48)
  await step('重复 open 复用同一窗口（边界不变）', async () => {
    const again = await floating.open()
    return { first: openedBounds, again }
  }, (v) => v && v.first && v.again && v.first.width === v.again.width && v.first.height === v.again.height)
  await step('隐藏后不可见', async () => { await floating.hide(); return floating.isVisible() }, (v) => v === false)
  await step('显示后可见', async () => { await floating.show(); return floating.isVisible() }, (v) => v === true)
  await step('读取边界与 open 一致', () => floating.getBounds(), (v) => v && openedBounds && v.width === openedBounds.width)
  await step('setBounds 只移动位置', () => floating.setBounds({ x: 40, y: 40 }), (v) => v && v.x >= 0 && v.y >= 0 && Number.isFinite(v.width))
  await step('越屏位置被宿主钳制', async () => {
    const result = await floating.setBounds({ x: 99999, y: 99999 })
    return result
  }, (v) => v && v.x < 99999 && v.y < 99999)
  await step('穿透可开关', async () => {
    await floating.setIgnoreMouseEvents(true)
    await floating.setIgnoreMouseEvents(false)
    return 'ok'
  }, (v) => v === 'ok')
  await step('插件私有存储与悬浮能力共存', async () => {
    await api.storage.set('floating-acceptance', { at: Date.now(), run: id() })
    const value = await api.storage.get('floating-acceptance')
    return value
  }, (v) => Boolean(v && v.run))
  await step('关闭后 isVisible=false 且 getBounds=null', async () => {
    await floating.close()
    return { visible: await floating.isVisible(), bounds: await floating.getBounds() }
  }, (v) => v && v.visible === false && v.bounds === null)

  const failed = checks.filter((check) => !check.pass)
  $('status').textContent = failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项未通过：${failed.map((check) => check.name).join('、')}`
}

function initConsole() {
  bind('open', '打开悬浮窗口', () => floating.open(), 'bounds-output')
  bind('show', '显示', () => floating.show())
  bind('hide', '隐藏', () => floating.hide())
  bind('close', '关闭', () => floating.close())
  bind('is-visible', '是否可见', () => floating.isVisible())
  bind('get-bounds', '读取边界', () => floating.getBounds(), 'bounds-output')
  bind('move-corner', '移到右下角', async () => {
    const current = await floating.getBounds()
    if (!current) throw new Error('窗口未打开')
    // 用一个很大的目标点，宿主会钳制到可见区域右下角。
    return floating.setBounds({ x: 99999, y: 99999 })
  }, 'bounds-output')
  bind('move-offscreen', '尝试移出屏幕', () => floating.setBounds({ x: -50000, y: -50000 }), 'bounds-output')
  bind('ct-on', '开启穿透', () => floating.setIgnoreMouseEvents(true))
  bind('ct-off', '关闭穿透', () => floating.setIgnoreMouseEvents(false))
  $('run-all').addEventListener('click', () => { void runAll() })
  $('clear-log').addEventListener('click', () => { $('log').textContent = '' })
  void refreshContext()
}

function initBubble() {
  const bubbleLog = (label, value, ok = true) => {
    const line = `[${new Date().toLocaleTimeString()}] ${label}: ${typeof value === 'string' ? value : pretty(value)}`
    $('bubble-log').textContent = `${line}\n${$('bubble-log').textContent}`.slice(0, 2000)
    void ok
  }
  $('bubble-title').textContent = `悬浮画布（surface=floating）`
  $('bubble-bounds').addEventListener('click', async () => {
    try { bubbleLog('边界', await floating.getBounds()) } catch (error) { bubbleLog('边界失败', errorText(error)) }
  })
  $('bubble-hide').addEventListener('click', async () => {
    try { await floating.hide() } catch (error) { bubbleLog('隐藏失败', errorText(error)) }
  })
  // 双击气泡切换穿透，验证 forward 模式下仍可交互退出。
  $('bubble').addEventListener('dblclick', async () => {
    try {
      await floating.setIgnoreMouseEvents(true)
      bubbleLog('穿透', '已开启；在控制台关闭或移开后双击区域失效属预期')
    } catch (error) { bubbleLog('穿透失败', errorText(error)) }
  })
}

async function main() {
  const context = await api.getContext()
  if (context.surface === 'floating') {
    document.body.classList.add('floating')
    $('console-view').hidden = true
    $('bubble-view').hidden = false
    initBubble()
  } else {
    initConsole()
  }
}

void main()
