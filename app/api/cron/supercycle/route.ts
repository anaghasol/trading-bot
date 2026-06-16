/**
 * Supercycle Screener Cron — runs every Sunday 8 PM ET (Monday 00:00 UTC)
 *
 * Scans ~250 S&P 500 + Nasdaq-100 + spin-off names for SNDK-style signals:
 *   Monthly RSI ≥ 80 + Price ≥ 100% above 200-day MA + 4+ green monthly candles
 *
 * Results stored in tb_alerts (type=SUPERCYCLE) — scan cron reads these and
 * gives matching candidates a +10 confidence bonus on the next weekday run.
 * Top-3 candidates (score ≥ 70) are SMS-alerted and auto-queued for paper trading.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { scanSupercycles } from '@/lib/supercycle'

export const runtime = 'nodejs'
export const maxDuration = 290

export async function GET(req: NextRequest) {
  // Auth
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()
  const startedAt = Date.now()

  await db.from('tb_cron_log').insert({
    job: 'supercycle',
    status: 'started',
    message: 'Weekly supercycle screener starting',
  })

  try {
    console.log('[supercycle] Fetching Alpaca bars for universe…')
    const candidates = await scanSupercycles()
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (candidates.length === 0) {
      await db.from('tb_cron_log').insert({
        job: 'supercycle',
        status: 'ok',
        message: `No candidates passed filters (${elapsed}s)`,
      })
      return NextResponse.json({ candidates: 0, elapsed_s: elapsed })
    }

    // Wipe stale candidates from previous run (keep only latest weekly scan)
    await db.from('tb_alerts').delete().eq('type', 'SUPERCYCLE')

    // Store all new candidates
    await db.from('tb_alerts').insert(
      candidates.map(c => ({
        type: 'SUPERCYCLE',
        symbol: c.ticker,
        broker: 'alpaca_paper',
        message: JSON.stringify({
          monthly_rsi:              c.monthly_rsi,
          pct_above_200dma:         c.pct_above_200dma,
          consecutive_green_months: c.consecutive_green_months,
          listing_age_years:        c.listing_age_years,
          volume_expanding:         c.volume_expanding,
          score:                    c.score,
        }),
      }))
    )

    // SMS alert for top-3 (score ≥ 70)
    const top3 = candidates.filter(c => c.score >= 70).slice(0, 3)
    if (top3.length > 0) {
      const lines = top3.map(
        c => `${c.ticker}: RSI ${c.monthly_rsi.toFixed(0)} / +${c.pct_above_200dma.toFixed(0)}% 200MA / ${c.consecutive_green_months}mo green / score ${c.score}`
      )
      const body = `🚀 SUPERCYCLE RADAR\n${lines.join('\n')}\n\nQueued for paper trading next scan.`
      await sendSMS(body)

      // Auto-queue top-3 for paper scan: write to tb_learning so the scan cron sees them
      await db.from('tb_alerts').insert(
        top3.map(c => ({
          type: 'SUPERCYCLE_QUEUE',
          symbol: c.ticker,
          broker: 'alpaca_paper',
          message: `[AUTO-QUEUE] score=${c.score} rsi=${c.monthly_rsi} +${c.pct_above_200dma.toFixed(0)}% 200MA`,
        }))
      )
    }

    await db.from('tb_cron_log').insert({
      job: 'supercycle',
      status: 'ok',
      message: `Found ${candidates.length} candidates, top: ${candidates[0]?.ticker} score=${candidates[0]?.score} (${elapsed}s)`,
    })

    return NextResponse.json({
      candidates: candidates.length,
      top: candidates.slice(0, 10).map(c => ({
        ticker: c.ticker,
        monthly_rsi: c.monthly_rsi,
        pct_above_200dma: c.pct_above_200dma,
        consecutive_green_months: c.consecutive_green_months,
        listing_age_years: c.listing_age_years,
        score: c.score,
      })),
      elapsed_s: elapsed,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.from('tb_cron_log').insert({
      job: 'supercycle',
      status: 'error',
      message: msg,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function sendSMS(body: string) {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from  = process.env.TWILIO_FROM
  const to    = process.env.TWILIO_PHONE_NUMBER ?? '+12516800461'
  if (!sid || !token || !from) return
  try {
    const creds = Buffer.from(`${sid}:${token}`).toString('base64')
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    })
  } catch { /* non-fatal */ }
}
