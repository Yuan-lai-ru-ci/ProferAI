import { expect, test } from 'bun:test'
import { observeEditorReadiness, isTargetInteractive, reportWindowPhase } from './window-phase'

test('phase API 缺失或拒绝时不抛同步错误', async () => {
 const old=globalThis.window;const calls:string[]=[]
 try {
  globalThis.window={electronAPI:{}} as unknown as Window & typeof globalThis
  expect(()=>reportWindowPhase('app-ready')).not.toThrow()
  globalThis.window={electronAPI:{reportWindowPhase:async(phase:string)=>{calls.push(phase);throw new Error('old main')}}} as unknown as Window & typeof globalThis
  expect(()=>reportWindowPhase('target-meta-ready')).not.toThrow()
  await Promise.resolve();await Promise.resolve()
  expect(calls).toEqual(['target-meta-ready'])
 }finally{globalThis.window=old}
})
test('只对匹配且新鲜会话、消息/editor/channel/model全ready发interactive',()=>{
 const base={sessionId:'a',targetSessionId:'a',loadedSessionId:'a',messagesLoaded:true,editorReady:true,channelReady:true,modelReady:true}
 expect(isTargetInteractive(base)).toBe(true)
 for(const patch of [{sessionId:'b'},{targetSessionId:'b'},{loadedSessionId:'b'},{messagesLoaded:false},{editorReady:false},{channelReady:false},{modelReady:false}])
  expect(isTargetInteractive({...base,...patch})).toBe(false)
})
test('editor就绪仅在effect订阅后通知，覆盖create早于挂载、销毁和清理后的迟到事件',()=>{
 const states:boolean[]=[]
 const listeners=new Map<string,Set<()=>void>>()
 const editor={isInitialized:true,isDestroyed:false,on(event:string,callback:()=>void){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(callback)},off(event:string,callback:()=>void){listeners.get(event)?.delete(callback)}}
 const emit=(event:string)=>{for(const fn of listeners.get(event)??[])fn()}
 emit('create');expect(states).toEqual([])
 const cleanup=observeEditorReadiness(editor,ready=>states.push(ready))
 expect(states).toEqual([true])
 emit('destroy');expect(states).toEqual([true,false])
 cleanup();const count=states.length
 emit('create');emit('destroy');expect(states).toHaveLength(count)
 editor.isInitialized=false
 const next=observeEditorReadiness(editor,ready=>states.push(ready))
 expect(states.at(-1)).toBe(false);emit('create');expect(states.at(-1)).toBe(true);next()
})
