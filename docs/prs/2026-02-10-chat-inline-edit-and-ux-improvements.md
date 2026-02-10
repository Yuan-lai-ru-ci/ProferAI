## 概要

本 PR 主要优化了聊天编辑与桌面交互体验，包含以下能力：

1. 新增用户消息「重新发送」。
2. 将「编辑后重发」升级为**原地编辑**（在消息气泡内直接编辑并发送）。
3. 原地编辑支持附件重编：
   - 删除原有附件
   - 通过文件选择新增附件
   - 通过拖拽新增附件
   - 通过粘贴（Cmd/Ctrl + V）新增附件
4. 编辑重发时，会从目标用户消息开始截断后续对话（包含该消息），然后重新生成。
5. 优化聊天顶部区域窗口拖拽：顶部可拖动窗口，按钮区域保持可点击。

---

## 变更动机

- 原流程编辑后要回到底部输入框，操作路径较长。
- 用户在重写消息时常常需要同步调整附件。
- 顶部区域拖拽体验不一致，影响桌面端使用手感。

---

## 主要改动

### 1）用户消息操作
- 新增「重新发送」按钮。
- 将「编辑后重发」改为消息气泡内原地编辑。

### 2）原地编辑能力
- 消息气泡可切换为编辑态，提供「取消 / 发送 / 添加附件」操作。
- 保留原附件，并允许逐个删除。

### 3）附件编辑能力
- 原地编辑中支持三种新增方式：
  - 文件选择
  - 拖拽上传
  - 粘贴上传（Cmd/Ctrl + V）
- 提交时会：
  - 删除已移除的旧附件文件
  - 保存新增附件
  - 使用“编辑后的文本 + 附件集合”重发消息

### 4）截断重发链路
- 新增 IPC 通道：`chat:truncate-messages-from`
- 支持从指定消息起截断（包含该消息）并同步上下文分隔线。

### 5）顶部拖拽体验
- 聊天 Header 区域支持窗口拖拽。
- 置顶、并排、编辑标题按钮保持 no-drag，可正常点击。
- 标题编辑入口改为铅笔按钮，避免与拖拽冲突。

---

## 影响文件（核心）

- `apps/electron/src/renderer/components/chat/ChatMessageItem.tsx`
- `apps/electron/src/renderer/components/chat/ChatMessages.tsx`
- `apps/electron/src/renderer/components/chat/ParallelChatMessages.tsx`
- `apps/electron/src/renderer/components/chat/ChatView.tsx`
- `apps/electron/src/renderer/components/chat/ChatHeader.tsx`
- `apps/electron/src/renderer/components/chat/ChatInput.tsx`
- `apps/electron/src/preload/index.ts`
- `apps/electron/src/main/ipc.ts`
- `apps/electron/src/main/lib/conversation-manager.ts`
- `packages/shared/src/types/chat.ts`

---

## 手动验证清单

- [ ] 用户消息点击「重新发送」后，后续消息被截断并重新生成
- [ ] 用户消息可进入原地编辑并提交
- [ ] 可删除原附件并提交
- [ ] 可通过文件选择新增附件并提交
- [ ] 可通过拖拽新增附件并提交
- [ ] 可通过粘贴（Cmd/Ctrl + V）新增附件并提交
- [ ] 聊天顶部区域可拖动窗口
- [ ] 顶部按钮（置顶/并排/编辑标题）可正常点击


