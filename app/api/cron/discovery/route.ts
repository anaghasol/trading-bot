/**
 * CRON: /api/cron/discovery — Weekly SNDK early-detection screener.
 * Runs Sunday night (midnight UTC) so results are ready Monday open.
 *
 * Screens ~200 stocks across 10 sectors for the SNDK signature BEFORE price runs:
 *   Stage 1 (0-40% above rising 200DMA) + fundamental inflection + early RSI
 *
 * Saves ranked candidates to tb_discoveries for the Discovery dashboard tab.
 * Also sends top-5 Telegram alert so you know what to watch at open.
 */

import { NextResponse } from 'next/server'
import { runSNDKScreener, type SNDKCandidate } from '@/lib/sndk-screener'
import { createServiceClient } from '@/lib/supabase-server'

export const runtime  = 'nodejs'
export const maxDuration = 300

function authorized(req: Request) {
  const s = process.env.CRON_SECRET
  return !s || req.headers.get('authorization') === `Bearer ${s}`
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db    = createServiceClient()
  const start = Date.now()

  console.log('[discovery] Starting SNDK screener run…')
  const candidates = await runSNDKScreener()
  console.log(`[discovery] Found ${candidates.length} candidates in ${Date.now() - start}ms`)

  // Save to Supabase — upsert so re-runs don't duplicate
  if (candidates.length > 0) {
    const rows = candidates.map((c) => ({
      symbol:             c.symbol,
      sector:             c.sector,
      sndk_score:         c.sndkScore,
      stage:              c.stage,
      deviation_pct:      Math.round(c.deviationPct * 10) / 10,
      rsi_current:        Math.round(c.rsiCurrent * 10) / 10,
      rsi_direction:      c.rsiDirection,
      fundamental_score:  c.fundamentalScore,
      stage_score:        c.stageScore,
      rsi_score:          c.rsiScore,
      volume_score:       c.volumeScore,
      gross_margin_pct:   c.grossMarginPct,
      op_margin_pct:      c.operatingMarginPct,
      revenue_growth_pct: c.revenueGrowthPct,
      eps_revision_30d:   c.epsRevision30d,
      highlights:         JSON.stringify(c.highlights),
      rs_score:           c.rsScore,
      rs_spy:             c.rsSpy,
      price_target:       c.priceTarget,
      current_price:      c.currentPrice,
      screened_at:        c.screened_at,
    }))

    // Upsert by symbol (latest run wins)
    const { error } = await db.from('tb_discoveries').upsert(rows, { onConflict: 'symbol' })
    if (error) console.error('[discovery] Supabase upsert error:', error.message)

    // Clear old discoveries not found in this run (stale)
    const foundSymbols = candidates.map((c) => c.symbol)
    await db.from('tb_discoveries')
      .delete()
      .not('symbol', 'in', `(${foundSymbols.map((s) => `'${s}'`).join(',')})`)
      .lt('screened_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
  }

  // Top Stage-1 candidates for Telegram alert
  const stage1 = candidates.filter((c) => c.stage === 1).slice(0, 5)
  const tgBot  = process.env.TELEGRAM_BOT_TOKEN
  const tgChat = process.env.TELEGRAM_ALLOWED_CHAT_ID
  if (tgBot && tgChat && stage1.length > 0) {
    const lines = [
      '🔭 *Weekly SNDK Discovery — Stage 1 Candidates*',
      `_Before the roar, not after. ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}_`,
      '',
    ]
    for (const c of stage1) {
      const upside = c.priceTarget > c.currentPrice
        ? ` → analyst target +${(((c.priceTarget - c.currentPrice) / c.currentPrice) * 100).toFixed(0)}%`
        : ''
      lines.push(
        `*${c.symbol}* (${c.sector.replace('_', ' ')}) — Score: ${c.sndkScore}/100`,
        `${c.highlights.slice(0, 2).join(' · ')}${upside}`,
        ''
      )
    }
    lines.push(`_Full rankings at /discovery — ${candidates.length} stocks screened_`)

    await fetch(`https://api.telegram.org/bot${tgBot}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: tgChat, text: lines.join('\n'), parse_mode: 'Markdown' }),
    }).catch((e) => console.error('[discovery] TG send error:', e))
  }

  // Log to cron log
  try {
    await db.from('tb_cron_log').insert({
      job: 'discovery',
      status: 'success',
      trades_made: 0,
      message: `SNDK screener: ${candidates.length} candidates | Stage1: ${stage1.length} | top: ${candidates.slice(0, 3).map((c) => `${c.symbol}(${c.sndkScore})`).join(', ')}`,
      duration_ms: Date.now() - start,
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({
    ok:         true,
    screened:   candidates.length,
    stage1:     stage1.length,
    top10:      candidates.slice(0, 10).map((c) => ({
      symbol:    c.symbol,
      score:     c.sndkScore,
      stage:     c.stage,
      sector:    c.sector,
      deviation: `${c.deviationPct.toFixed(0)}%`,
      rsi:       c.rsiCurrent.toFixed(0),
      gm:        `${c.grossMarginPct.toFixed(0)}%`,
      eps_rev:   `${c.epsRevision30d.toFixed(0)}%`,
    })),
    duration_ms: Date.now() - start,
  })
}
