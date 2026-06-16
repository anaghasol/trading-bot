/**
 * Supercycle Screener Cron — runs every Sunday 8 PM ET (Monday 00:00 UTC)
 *
 * Two outputs per run:
 *   SUPERCYCLE — full criteria met (RSI ≥ 80, +100% 200MA, 4+ green months)
 *   WATCHLIST  — early watch (RSI ≥ 60, +20% 200MA, 2+ green months) — not yet full
 *
 * Promotion detection: if a ticker was WATCHLIST last week and is now SUPERCYCLE,
 * it gets an SMS alert and is auto-queued for the next paper trade scan.
 *
 * Results stored in tb_alerts — the daily scan cron reads SUPERCYCLE_QUEUE
 * and gives matching candidates a +10 confidence bonus.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { scanAll, getExpandedUniverse } from '@/lib/supercycle'

export const runtime = 'nodejs'
export const maxDuration = 290

export async function GET(req: NextRequest) {
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
    console.log('[supercycle] Building expanded universe (static + news discovery)…')
    const { symbols: universe, discovered } = await getExpandedUniverse()
    const discoveredSet = new Set(discovered)

    // Snapshot previous watchlist BEFORE wiping — used for promotion detection
    const { data: prevWatchRows } = await db
      .from('tb_alerts')
      .select('symbol')
      .eq('type', 'WATCHLIST')
    const prevWatchSymbols = new Set((prevWatchRows ?? []).map(r => r.symbol as string))

    console.log(`[supercycle] Scanning ${universe.length} symbols (${discovered.length} newly discovered)…`)
    const { candidates, watchlist } = await scanAll(universe, discoveredSet)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

    // ── Promotion detection ──────────────────────────────────────────────────
    // Tickers that were in last week's WATCHLIST and now pass FULL criteria
    const promoted = candidates.filter(c => prevWatchSymbols.has(c.ticker))
    if (promoted.length > 0) {
      const lines = promoted.map(
        c => `${c.ticker}: RSI ${c.monthly_rsi.toFixed(0)} / +${c.pct_above_200dma.toFixed(0)}% 200MA / score ${c.score}`
      )
      await sendTG(
        `🎯 *WATCHLIST PROMOTED — full criteria met:*\n${lines.join('\n')}\n\nAuto-queued for next scan.`
      )
      await db.from('tb_alerts').insert(
        promoted.map(c => ({
          type: 'SUPERCYCLE_QUEUE',
          symbol: c.ticker,
          broker: 'alpaca_paper',
          message: `[PROMOTED FROM WATCH] score=${c.score} rsi=${c.monthly_rsi} +${c.pct_above_200dma.toFixed(0)}% 200MA`,
        }))
      )
    }

    // ── Wipe previous results, store fresh ──────────────────────────────────
    await db.from('tb_alerts').delete().in('type', ['SUPERCYCLE', 'WATCHLIST'])

    if (candidates.length > 0) {
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
            rs_vs_spy_6m:             c.rs_vs_spy_6m,
            avg_dollar_vol_m:         c.avg_dollar_vol_m,
            score:                    c.score,
            discovered:               c.discovered ?? false,
          }),
        }))
      )
    }

    if (watchlist.length > 0) {
      await db.from('tb_alerts').insert(
        watchlist.map(w => ({
          type: 'WATCHLIST',
          symbol: w.ticker,
          broker: 'alpaca_paper',
          message: JSON.stringify({
            monthly_rsi:              w.monthly_rsi,
            pct_above_200dma:         w.pct_above_200dma,
            consecutive_green_months: w.consecutive_green_months,
            listing_age_years:        w.listing_age_years,
            volume_expanding:         w.volume_expanding,
            rs_vs_spy_6m:             w.rs_vs_spy_6m,
            avg_dollar_vol_m:         w.avg_dollar_vol_m,
            score:                    w.score,
            criteria_met:             w.criteria_met,
            discovered:               w.discovered ?? false,
          }),
        }))
      )
    }

    // ── SMS for top-3 full candidates (score ≥ 70) ──────────────────────────
    const top3 = candidates.filter(c => c.score >= 70).slice(0, 3)
    if (top3.length > 0) {
      const lines = top3.map(
        c => `${c.discovered ? '🆕 ' : ''}${c.ticker}: RSI ${c.monthly_rsi.toFixed(0)} / +${c.pct_above_200dma.toFixed(0)}% 200MA / ${c.consecutive_green_months}mo green / RS ${c.rs_vs_spy_6m?.toFixed(1)}x SPY / score ${c.score}`
      )
      await sendTG(
        `🚀 *SUPERCYCLE RADAR* (${universe.length} scanned)\n${lines.join('\n')}\n\nQueued for paper trading next scan.`
      )
      await db.from('tb_alerts').insert(
        top3.map(c => ({
          type: 'SUPERCYCLE_QUEUE',
          symbol: c.ticker,
          broker: 'alpaca_paper',
          message: `[AUTO-QUEUE] score=${c.score} rsi=${c.monthly_rsi} +${c.pct_above_200dma.toFixed(0)}% 200MA`,
        }))
      )
    }

    const newlyDiscovered = candidates.filter(c => c.discovered).map(c => c.ticker)
    const top3Watch = watchlist.slice(0, 3).map(w => `${w.ticker}(${w.criteria_met}/4)`)

    await db.from('tb_cron_log').insert({
      job: 'supercycle',
      status: 'ok',
      message: `Scanned ${universe.length} (${discovered.length} discovered). Found ${candidates.length} supercycle, ${watchlist.length} watchlist. Promoted: [${promoted.map(c => c.ticker).join(', ') || 'none'}]. Top watch: [${top3Watch.join(', ')}] (${elapsed}s)`,
    })

    return NextResponse.json({
      universe_size:    universe.length,
      discovered_news:  discovered.length,
      candidates:       candidates.length,
      watchlist:        watchlist.length,
      promoted:         promoted.map(c => c.ticker),
      new_discoveries:  newlyDiscovered,
      top_candidates:   candidates.slice(0, 5).map(c => ({ ticker: c.ticker, score: c.score })),
      top_watch:        watchlist.slice(0, 5).map(w => ({ ticker: w.ticker, criteria_met: w.criteria_met, monthly_rsi: w.monthly_rsi })),
      elapsed_s:        elapsed,
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

async function sendTG(body: string) {
  const bot  = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (!bot || !chat) return
  try {
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: body, parse_mode: 'Markdown' }),
    })
  } catch { /* non-fatal */ }
}
