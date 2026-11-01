/** 稳定业务引用与真实来源；不包含宿主路径、Provider 会话或权限凭据。 */
export interface ResourceRef {
  type: 'task' | 'run' | 'session' | 'message' | 'automation' | 'request'
  id: string
}

export interface ActorRef {
  type: 'user' | 'agent' | 'automation' | 'external' | 'system' | 'unknown'
  id?: string
}

export interface TaskOrigin {
  actor: ActorRef
  source?: ResourceRef
}

/** 启动依据仅用于解释和追溯，不能替代现有权限校验。 */
export interface TaskAuthorization {
  kind: 'direct' | 'confirmed' | 'inherited' | 'scheduled' | 'external' | 'policy'
  sourceRef?: ResourceRef
}

/** 产品作者独立于 Provider 的 user/assistant 协议角色。 */
export interface MessageProvenance {
  schemaVersion: 1
  messageId: string
  author: ActorRef
  runId: string
  taskId?: string
  triggerId?: string
  source?: ResourceRef
}
