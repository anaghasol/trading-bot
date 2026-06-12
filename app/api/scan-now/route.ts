/**
 * /api/scan-now — server-side proxy that manually triggers /api/cron/scan.
 *
 * The cron scan requires a CRON_SECRET bearer token — that secret must never
 * reach the client. This route runs server-side, injects the header itself,
 * and returns the scan result. Used by the dashboard "Force Scan" button.
 */
import { NextResponse } from 'next/server'

export const runtime  = 'nodejs'
export const maxDuration = 65   // slightly above scan's 60s so we wait for it

export async function POST() {
  const secret = process.env.CRON_SECRET
  const host   = process.env.VERCEL_URL ?? `localhost:${process.env.PORT ?? 54321}`
  const base   = process.env.VERCEL_URL ? `https://${host}` : `http://${host}`

  try {
    const res = await fetch(`${base}/api/cron/scan`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    })
    const data = await res.json()
    return NextResponse.json({ triggered: true, result: data })
  } catch (e) {
    return NextResponse.json({ triggered: false, error: (e as Error).message }, { status: 500 })
  }
}
