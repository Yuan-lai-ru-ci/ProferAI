import { describe, expect, test } from 'bun:test'
import {
  CONVERSATION_MIN_WIDTH,
  FILE_PANEL_MIN_WIDTH,
  BROWSER_MIN_WIDTH,
  SIDEBAR_WIDTH,
  GAP_BUFFER,
  HYSTERESIS,
  computeVisibility,
  layoutNeed,
  type PanelLayoutState,
  type PanelVisibility,
} from './panel-layout'

const full: PanelLayoutState = { sidebar: true, filePanel: true, browser: true }
const noBrowser: PanelLayoutState = { sidebar: true, filePanel: true, browser: false }
const fpAndBrowser: PanelLayoutState = { sidebar: false, filePanel: true, browser: true }
const browserOnly: PanelLayoutState = { sidebar: false, filePanel: false, browser: true }
const fpOnly: PanelLayoutState = { sidebar: false, filePanel: true, browser: false }
const none: PanelLayoutState = { sidebar: false, filePanel: false, browser: false }

const hidden: PanelVisibility = { browser: false, filePanel: false }
const shown: PanelVisibility = { browser: true, filePanel: true }

describe('layoutNeed 各组合', () => {
  test('given all three panels open when computing need then returns 1396', () => {
    expect(layoutNeed(full)).toBe(
      CONVERSATION_MIN_WIDTH + SIDEBAR_WIDTH + FILE_PANEL_MIN_WIDTH + BROWSER_MIN_WIDTH + GAP_BUFFER,
    )
    expect(layoutNeed(full)).toBe(1396)
  })

  test('given no browser when computing need then returns 1036', () => {
    expect(layoutNeed(noBrowser)).toBe(1036)
  })

  test('given conversation only when computing need then returns 436', () => {
    expect(layoutNeed(none)).toBe(CONVERSATION_MIN_WIDTH + GAP_BUFFER)
    expect(layoutNeed(none)).toBe(436)
  })

  test('given browser only when computing need then returns 796', () => {
    expect(layoutNeed(browserOnly)).toBe(CONVERSATION_MIN_WIDTH + BROWSER_MIN_WIDTH + GAP_BUFFER)
    expect(layoutNeed(browserOnly)).toBe(796)
  })

  test('given file panel only when computing need then returns 736', () => {
    expect(layoutNeed(fpOnly)).toBe(736)
  })
})

describe('computeVisibility 收起优先级', () => {
  test('given wide window over full layout then both browser and file panel visible', () => {
    // 曾可见（prev=shown）时按普通阈值判定：1396 即可双开
    const vis = computeVisibility(1400, full, shown)
    expect(vis).toEqual({ browser: true, filePanel: true })
  })

  test('given wide window but previously hidden then hysteresis band applies', () => {
    // 从不可见恢复：浏览器需 1396+50=1446 才显示
    expect(computeVisibility(1445, full, hidden).browser).toBe(false)
    expect(computeVisibility(1446, full, hidden).browser).toBe(true)
  })

  test('given medium window then file panel visible but browser yields (browser first to give way)', () => {
    // 文件面板阈值 736+50=786 已过；浏览器阈值 1096+50=1146 未到
    const vis = computeVisibility(900, fpAndBrowser, hidden)
    expect(vis.filePanel).toBe(true)
    expect(vis.browser).toBe(false)
  })

  test('given narrow window then both hidden', () => {
    const vis = computeVisibility(700, fpAndBrowser, hidden)
    expect(vis).toEqual({ browser: false, filePanel: false })
  })

  test('given only browser intent then browser visible when wide enough', () => {
    // 无文件面板时浏览器阈值 = 436+360+50 = 846
    const vis = computeVisibility(900, browserOnly, hidden)
    expect(vis.browser).toBe(true)
  })

  test('given no browser intent then browser stays hidden', () => {
    const vis = computeVisibility(1400, noBrowser, shown)
    expect(vis.browser).toBe(false)
    expect(vis.filePanel).toBe(true)
  })

  test('given sidebar expanded then thresholds are raised accordingly', () => {
    // 左侧栏展开（300）时，文件面板从不可见恢复需 436+300+300+50 = 1086
    const layout: PanelLayoutState = { sidebar: true, filePanel: true, browser: false }
    const vis = computeVisibility(1086, layout, hidden)
    expect(vis.filePanel).toBe(true)
    expect(computeVisibility(1085, layout, hidden).filePanel).toBe(false)
  })
})

describe('computeVisibility 滞后带（防抖动）', () => {
  test('given window oscillating around threshold then each switches only once', () => {
    const layout: PanelLayoutState = { sidebar: false, filePanel: true, browser: false }
    // 从不可见打开，需要 736+50=786
    expect(computeVisibility(785, layout, hidden).filePanel).toBe(false)
    expect(computeVisibility(786, layout, hidden).filePanel).toBe(true)
    // 已可见后缩回，736 以下才收起
    expect(computeVisibility(737, layout, shown).filePanel).toBe(true)
    expect(computeVisibility(735, layout, shown).filePanel).toBe(false)
  })

  test('given hysteresis constant then is 50', () => {
    expect(HYSTERESIS).toBe(50)
  })
})
