/**
 * 额度状态管理
 *
 * 计费已收敛到 New API：balance 是「共享额度池」的真实剩余（货币单位，如 3.34），
 * 不再是 Profer credits 点数。所有用户共用此池。
 */
import { atom } from 'jotai'

/** 当前余额（null = 未加载，货币单位） */
export const creditsBalanceAtom = atom<number | null>(null)

/** 累计消耗（货币单位） */
export const creditsLifetimeConsumedAtom = atom<number>(0)

/** 是否正在加载 */
export const creditsLoadingAtom = atom<boolean>(false)

/** 余额偏低阈值（货币单位）：低于此值提示偏低 */
export const CREDITS_LOW_THRESHOLD = 10

/** 余额偏低 */
export const creditsLowAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  if (balance === null) return false
  return balance < CREDITS_LOW_THRESHOLD
})

/** 余额耗尽 */
export const creditsExhaustedAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  return balance !== null && balance <= 0
})
