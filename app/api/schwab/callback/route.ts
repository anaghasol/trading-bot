import { NextResponse } from 'next/server'
import { exchangeAuthCode } from '@/lib/schwab'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(new URL('/settings?schwab=error', req.url))
  }

  const success = await exchangeAuthCode(code)
  const dest = success ? '/settings?schwab=connected' : '/settings?schwab=error'
  return NextResponse.redirect(new URL(dest, req.url))
}
