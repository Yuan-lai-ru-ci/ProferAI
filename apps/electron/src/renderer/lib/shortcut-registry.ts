/**
 * 快捷键中央注册表
 *
 * 单一全局 keydown listener + Map 分发模式。
 * 所有快捷键监听集中在一处，避免多个 addEventListener 分散注册。
 */

import { DEFAULT_SHORTCUTS, SHORTCUT_MAP } from './shortcut-defaults'
import type { ShortcutOverrides } from './shortcut-defaults'
import { isEditableTarget } from './navigation-controller'

// ===== 平台检测 =====

const isMac =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

// ===== 注册表状态 =====

export interface ShortcutRegistrationOptions {
  /**
   * 独占模式。若同一快捷键的任一注册项设置了 exclusive=true，
   * 则仅执行**最后注册的** exclusive handler，其余 handler（无论是否 exclusive）均被跳过。
   * 用于在嵌套场景中让"最内层"组件捕获快捷键，避免触发外层全局逻辑。
   */
  exclusive?: boolean
}

interface ShortcutHandlerEntry {
  callback: () => void
  options: ShortcutRegistrationOptions
}

/** shortcutId → handler 集合 */
const handlers = new Map<string, Set<ShortcutHandlerEntry>>()

/** 当前用户自定义配置 */
let currentOverrides: ShortcutOverrides = {}

/** 是否已初始化 */
let initialized = false

// ===== 快捷键匹配 =====

interface ParsedAccelerator {
  cmd: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

function normalizeKeyName(key: string): string {
  if (key === ' ') return 'space'

  const keyMap: Record<string, string> = {
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    escape: 'esc',
    return: 'enter',
    '+': 'plus',
  }
  const mapped = keyMap[key.toLowerCase()]
  return (mapped ?? key).toLowerCase()
}

function isModifierName(part: string): boolean {
  const key = part.toLowerCase()
  return [
    'cmd',
    'command',
    'meta',
    'super',
    'ctrl',
    'control',
    'cmdorctrl',
    'commandorcontrol',
    'shift',
    'alt',
    'option',
  ].includes(key)
}

/**
 * 解析快捷键字符串为结构化对象
 *
 * 支持格式：'Cmd+Shift+M'、'Ctrl+K'、'CmdOrCtrl+,'
 */
function parseAccelerator(accelerator: string): ParsedAccelerator {
  const parts = accelerator.split('+').map((p) => p.trim())
  const isModifierOnly = parts.length > 0 && parts.every(isModifierName)
  const key = isModifierOnly ? '' : normalizeKeyName(parts[parts.length - 1] ?? '')
  const modifiers = (isModifierOnly ? parts : parts.slice(0, -1)).map((m) => m.toLowerCase())
  const hasCmdOrCtrl =
    modifiers.includes('cmdorctrl') || modifiers.includes('commandorcontrol')

  return {
    cmd:
      modifiers.includes('cmd') ||
      modifiers.includes('command') ||
      modifiers.includes('meta') ||
      modifiers.includes('super') ||
      (isMac && hasCmdOrCtrl),
    ctrl:
      modifiers.includes('ctrl') ||
      modifiers.includes('control') ||
      (!isMac && hasCmdOrCtrl),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt') || modifiers.includes('option'),
    key,
  }
}

/**
 * 检查键盘事件是否匹配解析后的快捷键
 *
 * 严格匹配：确保修饰键精确对应，防止 Cmd+K 被 Cmd+Shift+K 误触
 */
function matchesParsed(e: KeyboardEvent, parsed: ParsedAccelerator): boolean {
  // 修饰键匹配
  if (parsed.cmd !== e.metaKey) return false
  if (parsed.ctrl !== e.ctrlKey) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false

  // 按键匹配
  if (!parsed.key) {
    return ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)
  }

  const eventKey = normalizeKeyName(e.key)
  return eventKey === parsed.key
}

// ===== 预计算加速器缓存 =====

/** 缓存：shortcutId → ParsedAccelerator */
let parsedCache = new Map<string, ParsedAccelerator>()

/** 重建缓存（配置变更时调用） */
function rebuildCache(): void {
  parsedCache = new Map()
  for (const def of DEFAULT_SHORTCUTS) {
    // 全局快捷键由主进程 globalShortcut 处理，不在渲染进程注册
    if (def.global) continue
    const accel = getActiveAccelerator(def.id)
    // 用户已禁用的快捷键不进入分发缓存
    if (accel === null) continue
    parsedCache.set(def.id, parseAccelerator(accel))
  }
}

// ===== 核心事件分发 =====

/** 判断 macOS 上的 F1–F12，兼容浏览器 key/code 两种上报方式。 */
export function isMacFunctionKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  mac = isMac,
): boolean {
  if (!mac) return false
  return /^F(?:[1-9]|1[0-2])$/i.test(event.key)
    || /^F(?:[1-9]|1[0-2])$/i.test(event.code)
}

// ===== 分发决策 =====

/** 按键事件与已启用快捷键定义之间的匹配结果 */
export type ShortcutMatchResult =
  /** 没有任何已启用定义匹配该按键 */
  | 'none'
  /** 命中了已启用定义，但当前没有注册任何 handler（如未选中会话时的重命名） */
  | 'no-handler'
  /** 命中了定义且有 handler 可执行 */
  | 'handled'

/** 一次按键事件的处理决策 */
export interface ShortcutDispatchPlan {
  /** 是否执行已注册的 handler */
  runHandlers: boolean
  /** 是否阻止默认行为并停止继续传播 */
  swallow: boolean
}

/**
 * 决定一次按键事件如何处理。
 *
 * 功能键的拦截全部在渲染层完成，主进程不参与 —— 主进程若按具体快捷键维护
 * F1–F12 白名单，平台输入层就会依赖渲染层的快捷键配置，且用户把快捷键改绑到
 * 其它 F 键时无法生效。
 *
 * 两条规则：
 * 1. 输入法组合期间不执行快捷键（该按键属于输入法），但 macOS 的 F1–F12 仍要吞掉，
 *    否则组合态按功能键会漏给 Chromium。
 * 2. 未被任何 handler 消费的 macOS F1–F12 一律吞掉，避免 Chromium 的原生焦点导航
 *    在窗口内绘制整块黄色焦点框。
 */
export function resolveShortcutDispatch(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'isComposing'>,
  match: ShortcutMatchResult,
  mac = isMac,
): ShortcutDispatchPlan {
  const isFunctionKey = isMacFunctionKeyEvent(event, mac)
  const runHandlers = match === 'handled' && !event.isComposing

  return { runHandlers, swallow: runHandlers || isFunctionKey }
}

/**
 * 全局 keydown 事件处理器
 *
 * capture 阶段先把事件与已启用定义比对，再按 resolveShortcutDispatch 的决策
 * 执行 handler 与阻止默认行为。
 *
 * 另有一条前置放行规则（必须在吞键之前判定）：定义带 skipInEditable 的按键
 * 在可编辑元素内一律不参与分发 —— 裸 Delete 这类键在输入框里属于原生输入语义，
 * 若命中后照常 preventDefault，输入框将收不到 keydown、删字符彻底失效。
 */
function dispatchShortcut(e: KeyboardEvent): void {
  let match: ShortcutMatchResult = 'none'
  let handlerEntries: ShortcutHandlerEntry[] = []

  for (const [id, parsed] of parsedCache) {
    if (!matchesParsed(e, parsed)) continue
    if (SHORTCUT_MAP.get(id)?.skipInEditable && isEditableTarget(e.target)) {
      match = 'none'
      break
    }
    // 匹配一个即停止。但仍要区分「命中定义但无 handler」（如未选中会话时的重命名）：
    // 它同样需要走功能键兜底，否则 F 键会漏出原生焦点导航。
    handlerEntries = Array.from(handlers.get(id) ?? [])
    match = handlerEntries.length > 0 ? 'handled' : 'no-handler'
    break
  }

  const plan = resolveShortcutDispatch(e, match)
  if (plan.swallow) {
    e.preventDefault()
    e.stopPropagation()
  }
  if (!plan.runHandlers) return

  // 独占模式：只执行最后注册的 exclusive handler，其余（含非 exclusive）均跳过
  for (let i = handlerEntries.length - 1; i >= 0; i--) {
    if (handlerEntries[i]!.options.exclusive) {
      handlerEntries[i]!.callback()
      return
    }
  }
  for (const entry of handlerEntries) {
    entry.callback()
  }
}

// ===== 公开 API =====

/**
 * 初始化快捷键注册表
 *
 * 挂载全局 keydown listener，仅执行一次
 */
export function initShortcutRegistry(): void {
  if (initialized) return
  initialized = true
  rebuildCache()
  window.addEventListener('keydown', dispatchShortcut, true) // capture 阶段
}

/**
 * 注册快捷键 handler
 *
 * @returns 注销函数
 */
export function registerShortcut(
  id: string,
  callback: () => void,
  options: ShortcutRegistrationOptions = {},
): () => void {
  if (!handlers.has(id)) {
    handlers.set(id, new Set())
  }
  const entry: ShortcutHandlerEntry = { callback, options }
  handlers.get(id)!.add(entry)

  return () => {
    const set = handlers.get(id)
    if (set) {
      set.delete(entry)
      if (set.size === 0) handlers.delete(id)
    }
  }
}

/**
 * 更新用户自定义快捷键配置
 *
 * 配置变更后自动重建匹配缓存
 */
export function updateShortcutOverrides(overrides: ShortcutOverrides): void {
  currentOverrides = overrides
  rebuildCache()
}

/**
 * 获取某快捷键当前生效的 accelerator 字符串
 *
 * 返回值含义：
 * - 非空字符串：当前生效的 accelerator（用户自定义或默认值）
 * - `null`：用户已禁用此快捷键，不应注册任何监听
 * - 空字符串：定义不存在或该平台无默认值
 */
export function getActiveAccelerator(id: string): string | null {
  const override = currentOverrides[id]
  if (override) {
    const customAccel = isMac ? override.mac : override.win
    if (customAccel === null) return null
    if (customAccel) return customAccel
  }
  const def = SHORTCUT_MAP.get(id)
  if (!def) return ''
  return isMac ? def.defaultMac : def.defaultWin
}

/**
 * 获取快捷键的显示文本（用于 UI 展示）
 *
 * 将内部格式转换为用户友好的显示：Cmd → ⌘，Shift → ⇧ 等
 */
export function getAcceleratorDisplay(accelerator: string | null): string {
  if (!accelerator) return ''
  if (isMac) {
    return accelerator
      .split('+')
      .map((part) => {
        const normalized = part.trim().toLowerCase()
        if (['cmd', 'command', 'meta', 'super'].includes(normalized)) return '⌘'
        if (['ctrl', 'control'].includes(normalized)) return '⌃'
        if (normalized === 'shift') return '⇧'
        if (['alt', 'option'].includes(normalized)) return '⌥'
        if (normalized === 'backspace') return '⌫'
        return part
      })
      .join('')
  }
  return accelerator
}

/**
 * 检查快捷键冲突
 *
 * @returns 冲突的快捷键 ID，无冲突返回 null
 */
export function checkConflict(
  accelerator: string,
  excludeId?: string,
): string | null {
  const parsed = parseAccelerator(accelerator)
  for (const def of DEFAULT_SHORTCUTS) {
    if (excludeId && def.id === excludeId) continue
    const existingAccel = getActiveAccelerator(def.id)
    // 已禁用的快捷键不占用任何按键组合，不参与冲突检测
    if (existingAccel === null || existingAccel === '') continue
    const existingParsed = parseAccelerator(existingAccel)
    if (
      parsed.cmd === existingParsed.cmd &&
      parsed.ctrl === existingParsed.ctrl &&
      parsed.shift === existingParsed.shift &&
      parsed.alt === existingParsed.alt &&
      parsed.key === existingParsed.key
    ) {
      return def.id
    }
  }
  return null
}

/** 导出平台信息供其他模块使用 */
export { isMac }
