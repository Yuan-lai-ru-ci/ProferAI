import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CHAT_IPC_CHANNELS } from '@profer/shared'
import { CORE_TARGET_IPC_CHANNELS } from '../../types'

const ipc = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')
test('Given Chat业务入口 When 扫描IPC注册 Then 全部经Core归属分发而非裸桌面调用', () => {
  const bare = [...ipc.matchAll(/ipcMain\.handle\(\s*CHAT_IPC_CHANNELS\.([A-Z_]+)/g)].map(match => match[1])
  expect(bare).toEqual([])
  for (const key of ['LIST_CONVERSATIONS', 'CREATE_CONVERSATION', 'SEND_MESSAGE', 'GET_BRANCH', 'SAVE_ATTACHMENT', 'DELETE_CONVERSATION'] as const) {
    expect(ipc.includes(`registerCoreChatHandler(\n    CHAT_IPC_CHANNELS.${key},`)).toBe(true)
    expect(CHAT_IPC_CHANNELS[key]).toStartWith('chat:')
  }
})
test('Given 本机Core具有Chat能力 When 获取模型目录 Then 读取本机Core而不是空数组或桌面渠道', async () => {
  const source=readFileSync(new URL('./core-target-ipc.ts',import.meta.url),'utf8')
  const start=source.indexOf('  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.CHANNELS,')
  const end=source.indexOf('\n  ipcMain.handle(',start+5)
  const script=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end))
  for(const stale of [false,true]){
    let generation=2,calls=0,handler:(()=>Promise<unknown>)|undefined
    const client={listChannels:async()=>{calls++;if(stale)generation++;return [{id:'from-local-core'}]}}
    const dependencies={ipcMain:{handle:(_channel:string,callback:()=>Promise<unknown>)=>{handler=callback}},CORE_TARGET_IPC_CHANNELS,
      listCoreTargets:()=>({currentId:'local',generation,targets:[{id:'local',capabilities:['chat']}]}),getLocalCoreClient:()=>client,getActiveCoreClient:()=>null}
    new Function(...Object.keys(dependencies),script)(...Object.values(dependencies))
    if(!handler)throw new Error('未注册本机目录handler')
    if(stale)await expect(handler()).rejects.toThrow('忽略旧')
    else await expect(handler()).resolves.toEqual([{id:'from-local-core'}])
    expect(calls).toBe(1)
  }
})
