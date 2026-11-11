/**
 * 设置导航的可见性规则（按发行版 + 登录态过滤）。
 *
 * 抽成纯函数是为了能直接测：商业版的账号/额度/订阅入口必须被开源版挡掉，
 * 而这些入口一旦漏出来，用户点到只会看到「当前为开源版」的错误提示。
 *
 * 规则按「先发行版、再登录态」叠加：
 * - 开源版没有账号体系 → 账户/额度/订阅/团队一律不出现；
 * - 商业版未登录时也不展示需要登录的额度/订阅/团队（账户页保留，作为登录入口）。
 */
import type { SettingsTab } from '@/atoms/settings-tab'

/** 只在商业版存在的设置页。 */
export const COMMERCIAL_ONLY_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'account',
  'credits',
  'subscription',
  'team',
])

/** 依赖账号登录的页面（商业版未登录时隐藏）。 */
export const AUTH_REQUIRED_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'credits',
  'subscription',
  'team',
])

export interface SettingsNavItemLike {
  id: SettingsTab
}

export interface SettingsNavGroupLike<T extends SettingsNavItemLike> {
  title?: string
  items: T[]
}

export interface SettingsVisibilityOptions {
  isLoggedIn: boolean
  commercial: boolean
}

/** 过滤设置导航分组；空分组会被移除，避免留下只有标题的空壳。 */
export function filterSettingsGroups<T extends SettingsNavItemLike>(
  groups: SettingsNavGroupLike<T>[],
  options: SettingsVisibilityOptions,
): SettingsNavGroupLike<T>[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (options.commercial || !COMMERCIAL_ONLY_TABS.has(item.id)) &&
          (options.isLoggedIn || !AUTH_REQUIRED_TABS.has(item.id)),
      ),
    }))
    .filter((group) => group.items.length > 0)
}
