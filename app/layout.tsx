import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'TradeBot — Schwab AI Trading',
  description: 'Automated AI-driven trading dashboard powered by Claude + Schwab API',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
