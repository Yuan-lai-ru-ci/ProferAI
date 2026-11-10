import { app, BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'profer-browser-menu-smoke-'))
app.setPath('userData', userData)

async function run(): Promise<void> {
  await app.whenReady()
  const win = new BrowserWindow({ width: 900, height: 620, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const problems: string[] = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) problems.push(message) })
  await win.loadFile(join(__dirname, 'index.html'))
  win.showInactive()
  const js = <T>(expression: string) => win.webContents.executeJavaScript(expression) as Promise<T>
  async function wait(expression: string): Promise<void> {
    for (let n = 0; n < 100; n++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(`等待条件超时：${expression}`)
  }
  await wait('!!document.querySelector("button")')
  for (const dark of [false, true]) {
    await js(`document.documentElement.classList.toggle('dark',${dark});document.querySelector('button').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await wait('!!document.querySelector("[role=menu]")')
    // 等待真实动画结束再验视觉，不能把 fade-in 第一帧当成最终样式。
    await js("Promise.all([...document.getAnimations()].filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>undefined)))")
    await new Promise(resolve => setTimeout(resolve, 80))
    const styles = await js("({menu:getComputedStyle(document.querySelector('[role=menu]')).opacity,foreground:getComputedStyle(document.querySelector('[role=menu]')).color})")
    console.log(JSON.stringify({ dark, styles }))
    writeFileSync(join(__dirname, dark ? 'menu-dark.png' : 'menu-light.png'), (await win.webContents.capturePage()).toPNG())
    const name = await js<string>('document.querySelector("button").getAttribute("aria-label")')
    if (!name.includes('3 页')) throw new Error('页面列表按钮缺少可访问名称')
    await js("[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.includes('Agent 正在后台研究')).click()")
    await wait("document.querySelector('#selected')?.textContent==='work'")
    await wait('!document.querySelector("[role=menu]")')
  }
  const result = { passed: true, selected: await js("document.querySelector('#selected')?.textContent"), problems }
  writeFileSync(join(__dirname, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  win.destroy()
  app.exit(0)
}
const deadline = setTimeout(() => { console.error('菜单 smoke 超时'); app.exit(1) }, 20_000)
void run().catch(error => { console.error(error); app.exit(1) }).finally(() => clearTimeout(deadline))
