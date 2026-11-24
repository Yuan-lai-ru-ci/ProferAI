import { expect, test } from 'bun:test'
import { editorReadinessEvents, isTargetInteractive, reportWindowPhase } from './window-phase'

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
test('editor destroy 清除ready，不复用已销毁实例',()=>{
 const states:boolean[]=[];const events=editorReadinessEvents(ready=>states.push(ready))
 events.onCreate();events.onDestroy();expect(states).toEqual([true,false])
})
