import { expect, test } from 'bun:test'
import { DEFAULT_TRAFFIC_LIGHT_POSITION, resolveTrafficLightPosition } from './mac-traffic-light'

test('macOS 红绿灯在标准缩放下保持默认位置，并与 45px 顶栏中线对齐', () => {
  expect(DEFAULT_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 16 })
  expect(resolveTrafficLightPosition(1)).toEqual(DEFAULT_TRAFFIC_LIGHT_POSITION)
})

test('macOS 红绿灯位置随页面缩放倍率同步放大并取整', () => {
  expect(resolveTrafficLightPosition(1.5)).toEqual({ x: 24, y: 24 })
  expect(resolveTrafficLightPosition(2)).toEqual({ x: 32, y: 32 })
})

test('异常缩放倍率回退到标准倍率', () => {
  expect(resolveTrafficLightPosition(0)).toEqual(DEFAULT_TRAFFIC_LIGHT_POSITION)
  expect(resolveTrafficLightPosition(Number.NaN)).toEqual(DEFAULT_TRAFFIC_LIGHT_POSITION)
})
