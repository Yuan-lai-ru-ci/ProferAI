/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}',
  ],
  // LEGACY TABLET / NO-IPC FALLBACK：仅平板无 IPC 场景仍可能由 applyThemeToDOM
  // 拼接 theme-${style}。桌面主窗口走 skin-* + 动态 CSS，不能依赖此 safelist。
  safelist: [
    'theme-ocean-light',
    'theme-ocean-dark',
    'theme-forest-light',
    'theme-forest-dark',
    'theme-slate-light',
    'theme-slate-dark',
    'theme-terminal-dark',
    'theme-mist-paper-dark',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        dialog: {
          DEFAULT: 'hsl(var(--dialog))',
          foreground: 'hsl(var(--dialog-foreground))',
        },
        tooltip: {
          DEFAULT: 'hsl(var(--tooltip) / <alpha-value>)',
          foreground: 'hsl(var(--tooltip-foreground) / <alpha-value>)',
          muted: 'hsl(var(--tooltip-muted) / <alpha-value>)',
        },
        'content-area': 'hsl(var(--content-area) / <alpha-value>)',
        sidebar: 'hsl(var(--sidebar-surface) / <alpha-value>)',
        tabbar: 'hsl(var(--tabbar-surface) / <alpha-value>)',
        tab: 'hsl(var(--tab-surface) / <alpha-value>)',
        input: {
          DEFAULT: 'hsl(var(--input-surface) / <alpha-value>)',
          hover: 'hsl(var(--input-hover) / <alpha-value>)',
        },
        surface: {
          shell: 'hsl(var(--shell-surface) / <alpha-value>)',
          raised: 'hsl(var(--raised-surface) / <alpha-value>)',
          sunken: 'hsl(var(--sunken-surface) / <alpha-value>)',
          selected: 'hsl(var(--selected-surface) / <alpha-value>)',
          border: 'hsl(var(--surface-border) / <alpha-value>)',
          'border-strong': 'hsl(var(--surface-border-strong) / <alpha-value>)',
        },
        control: {
          DEFAULT: 'hsl(var(--control-surface) / <alpha-value>)',
          hover: 'hsl(var(--control-hover) / <alpha-value>)',
        },
        overlay: 'hsl(var(--overlay) / <alpha-value>)',
        focus: 'hsl(var(--focus-ring) / <alpha-value>)',
        message: {
          DEFAULT: 'hsl(var(--message-surface) / <alpha-value>)',
          user: 'hsl(var(--message-user-surface) / <alpha-value>)',
        },
        code: {
          DEFAULT: 'hsl(var(--code-bg) / <alpha-value>)',
          foreground: 'hsl(var(--code-fg) / <alpha-value>)',
        },
        quote: 'hsl(var(--blockquote-surface) / <alpha-value>)',
        'table-header': 'hsl(var(--table-header-surface) / <alpha-value>)',
        'browser-host': 'hsl(var(--browser-host-surface) / <alpha-value>)',
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          foreground: 'hsl(var(--info-foreground) / <alpha-value>)',
        },
      },
      // ===== 字体栈：Inter Variable 优先，回退 SF Pro Text / 系统中文字体 =====
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'PingFang SC',
          'Segoe UI',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
      },
      // ===== 圆角：覆写 shadcn 标准三档，全部由 --radius 派生 =====
      // 改一处 --radius 即可整站统一调圆角节奏，无需 grep 替换 300+ 处 rounded-*
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        DEFAULT: 'calc(var(--radius) - 2px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + var(--radius-xl-extra, 2px))',
        '2xl': 'calc(var(--radius) + var(--radius-2xl-extra, 4px))',
      },
      // ===== 阴影：覆写 Tailwind 内置的 sm/md/lg/xl/DEFAULT =====
      // 现有 78 处 shadow-md / shadow-lg 等代码无需改动，自动吃多层柔阴影 + 主题自适应
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-xl)',
      },
      keyframes: {
        'slide-in-from-top': {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-in-from-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-out-to-right': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(100%)' },
        },
        'preview-slide-out': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(100%)' },
        },
      },
      animation: {
        'in': 'slide-in-from-top 0.3s ease-out',
        'out': 'slide-out-to-right 0.2s ease-in',
        'preview-slide-out': 'preview-slide-out 0.25s ease-out forwards',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('tailwindcss-animate'),
  ],
}
