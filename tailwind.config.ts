import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'Monaco', 'Courier New', 'monospace'],
      },
      colors: {
        bg: {
          0: '#0b0f17',
          1: '#0f1419',
          2: '#1a1f2e',
          3: '#1e293b',
          inset: '#0f172a',
        },
        border: { DEFAULT: '#374151', soft: '#334155' },
        fg: { 1: '#e5e7eb', 2: '#9ca3af', 3: '#6b7280' },
        green: { DEFAULT: '#10b981' },
        red:   { DEFAULT: '#ef4444' },
        blue:  { DEFAULT: '#3b82f6' },
        amber: { DEFAULT: '#f59e0b' },
      },
      borderRadius: {
        sm: '4px', md: '6px', lg: '8px', xl: '12px', pill: '20px',
      },
    },
  },
  plugins: [],
}

export default config
