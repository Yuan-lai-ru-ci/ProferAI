/**
 * 额度状态管理
 */
import { atom } from 'jotai'

/** 当前余额（null = 未加载） */
export const creditsBalanceAtom = atom<number | null>(null)

/** 累计消耗 */
export const creditsLifetimeConsumedAtom = atom<number>(0)

/** 是否正在加载 */
export const creditsLoadingAtom = atom<boolean>(false)

/** 余额偏低（低于 10000 credits 时警告） */
export const creditsLowAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  if (balance === null) return false
  return balance < 10000
})

/** 余额耗尽 */
export const creditsExhaustedAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  return balance !== null && balance <= 0
})
