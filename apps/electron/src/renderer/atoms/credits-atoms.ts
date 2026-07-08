/**
 * 额度状态管理
 *
 * 计费单一真源 = New API 实扣 quota，镜像进每用户本地账本。balance 是**当前用户
 * 自己**的真实剩余（货币单位，如 1.00），不再是共享池。
 */
import { atom } from 'jotai'

/** 当前余额（null = 未加载，货币单位） */
export const creditsBalanceAtom = atom<number | null>(null)

/** 累计消耗（货币单位） */
export const creditsLifetimeConsumedAtom = atom<number>(0)

/** 是否正在加载 */
export const creditsLoadingAtom = atom<boolean>(false)

/**
 * 余额偏低阈值：剩余额度 ≤ 总量的 20% 时提示告急。
 * 余额为 null（未加载）或总量为 0（新用户未消费）不触发。
 */
export const CREDITS_LOW_RATIO = 0.2

/** 余额偏低（剩余 ≤ 总量 20%） */
export const creditsLowAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  const consumed = get(creditsLifetimeConsumedAtom)
  if (balance === null) return false
  const total = balance + consumed
  if (total <= 0) return false
  return balance / total <= CREDITS_LOW_RATIO
})

/** 余额耗尽 */
export const creditsExhaustedAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  return balance !== null && balance <= 0
})
