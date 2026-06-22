/**
 * Admin 仪表盘路由
 */
import { Hono } from 'hono'
import { getDashboardStats } from '../../db.js'

export const adminDashboard = new Hono()

// GET /v1/admin/dashboard/stats
adminDashboard.get('/stats', (c) => {
  const stats = getDashboardStats()
  return c.json(stats)
})
