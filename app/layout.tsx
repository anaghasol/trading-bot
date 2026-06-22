import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'MyTrade — AI Trading Desk',
  description: 'Automated AI-driven trading dashboard',
  icons: {
    icon: '/mytrade-icon.png',
    shortcut: '/mytrade-icon.png',
    apple: '/mytrade-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ overflowX: 'hidden' }}>{children}</body>
    </html>
  )
}
