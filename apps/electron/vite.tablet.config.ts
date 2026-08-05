import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

// 平板版独立构建配置：
// 单独构建 tablet UI，产出到 dist/tablet（不并入桌面 renderer 的共享 chunk，
// 避免 Rollup 把 AgentMessages 等桌面组件归并到桌面 chunk 导致平板入口引用不完整）。
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer/tablet'),
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@/types': resolve(__dirname, 'src/types'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/tablet'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    open: false,
  },
})
