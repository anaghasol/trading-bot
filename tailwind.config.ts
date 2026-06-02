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
        // Exact fonts from MyTrade Live.html design file
        sans: ['IBM Plex Sans', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['IBM Plex Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // Exact palette from MyTrade Live.html
        bg: { 0: '#0b0f17', 1: '#0f1419', 2: '#161b27', 3: '#1e2435', inset: '#0d1320' },
        border: { DEFAULT: '#2a3346', soft: '#39435a' },
        fg: { 1: '#e8edf5', 2: '#9aa6b8', 3: '#646f82' },
        green:  { DEFAULT: '#13c98e' },
        red:    { DEFAULT: '#f0556a' },
        blue:   { DEFAULT: '#4d8dff' },
        amber:  { DEFAULT: '#f5a623' },
        violet: { DEFAULT: '#a78bfa' },
      },
      borderRadius: {
        sm: '4px', md: '7px', lg: '11px', xl: '14px', pill: '999px',
      },
      fontSize: {
        '2xs': '10px',
        xs:    '11px',
        sm:    '12px',
        base:  '13px',
        md:    '13.5px',
      },
    },
  },
  plugins: [],
}

export default config
