#!/usr/bin/env node
/**
 * 每日 Drip 累加脚本（兼容运维入口）
 *
 * 正式服务已由 scheduler 启动补跑并每小时执行。此脚本不再维护独立 SQL
 * 状态机，避免遗漏 drip_week_start 或跨周清理逻辑。
 *
 * 用法：
 *   node server/scripts/accrue-daily-drip.js            # 仅提示，不写库
 *   node server/scripts/accrue-daily-drip.js --apply    # 执行正式的跨周清理 + 每日累加
 */
import { accrueDailyDrip, clearWeeklyDrip } from '../src/db.js'

const APPLY = process.argv.includes('--apply')

if (!APPLY) {
  console.log('DRY-RUN：此脚本已改为复用正式 Drip 状态机。添加 --apply 才会执行跨周清理和每日累加。')
  process.exit(0)
}

const now = Date.now()
const cleared = clearWeeklyDrip(now)
const accrued = accrueDailyDrip(now)
console.log(`Drip 状态机已执行：清理 ${cleared.clearedCount} 个跨周待领池（${cleared.forfeitedQuota} quota），累计 ${accrued} 个当日 drip。`)
